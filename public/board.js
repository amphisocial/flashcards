/*
 * Athena Whiteboard client (Phase 1+)
 * One teacher, several saved boards, only one live at a time. Viewers are
 * read-only and only ever see a board that is both shared and live. Smart
 * AI features: explain what's on the board (vision call), plot a typed
 * function (pure client-side math, safe parser, never eval/Function on
 * text from another user), and "select an equation, hit Plot" (crops the
 * selection, a vision call extracts just the equation text, which is then
 * re-validated by the same safe parser before it's ever rendered).
 */
(() => {
  const { $, $$, escapeHtml, setStatus, api, refreshMe } = window.AppCommon;

  const boardIdValue = window.location.pathname.split('/').pop();
  const canvas = $('#boardCanvas');
  const ctx = canvas.getContext('2d');

  let isOwner = false;
  let boardMeta = { title: '', shared: false, isLive: false };
  let strokes = [];
  let ws = null;
  let reconnectTimer = null;

  const tool = { name: 'pen', color: '#eef6ff', size: 3 };
  let drawing = false;
  let currentPoints = [];
  let selectionRect = null; // {x1,y1,x2,y2} in canvas CSS pixels, for the 'select' tool

  // ---- Canvas sizing (HiDPI-aware, fills remaining viewport) -------------
  function resizeCanvas() {
    const wrap = canvas.parentElement;
    const rect = wrap.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);
    canvas.style.width = `${rect.width}px`;
    canvas.style.height = `${rect.height}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    redrawAll();
  }
  window.addEventListener('resize', resizeCanvas);

  function pointerPos(event) {
    const rect = canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  // ---- Rendering -----------------------------------------------------------
  function drawStroke(stroke) {
    if (!stroke.points || stroke.points.length < 1) return;
    ctx.save();
    if (stroke.tool === 'eraser') {
      ctx.globalCompositeOperation = 'destination-out';
      ctx.strokeStyle = 'rgba(0,0,0,1)';
    } else {
      ctx.globalCompositeOperation = 'source-over';
      ctx.strokeStyle = stroke.color || '#eef6ff';
    }
    ctx.lineWidth = stroke.size || 3;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    if (stroke.shape) {
      drawRecognizedShape(stroke);
    } else {
      ctx.beginPath();
      stroke.points.forEach((point, index) => {
        if (index === 0) ctx.moveTo(point.x, point.y);
        else ctx.lineTo(point.x, point.y);
      });
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawRecognizedShape(stroke) {
    const { shape } = stroke;
    ctx.beginPath();
    if (shape.type === 'circle') {
      ctx.arc(shape.cx, shape.cy, shape.r, 0, Math.PI * 2);
    } else if (shape.type === 'rectangle') {
      ctx.rect(shape.x, shape.y, shape.w, shape.h);
    } else if (shape.type === 'triangle') {
      ctx.moveTo(shape.points[0].x, shape.points[0].y);
      ctx.lineTo(shape.points[1].x, shape.points[1].y);
      ctx.lineTo(shape.points[2].x, shape.points[2].y);
      ctx.closePath();
    } else if (shape.type === 'line') {
      ctx.moveTo(shape.points[0].x, shape.points[0].y);
      ctx.lineTo(shape.points[1].x, shape.points[1].y);
    }
    ctx.stroke();
  }

  function redrawAll() {
    const wrap = canvas.parentElement;
    const rect = wrap.getBoundingClientRect();
    ctx.clearRect(0, 0, rect.width, rect.height);
    strokes.forEach(drawStroke);
    if (selectionRect) drawSelectionOverlay();
  }

  function drawSelectionOverlay() {
    const { x1, y1, x2, y2 } = selectionRect;
    ctx.save();
    ctx.strokeStyle = '#14d9c4';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([6, 4]);
    ctx.strokeRect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1));
    ctx.restore();
  }

  // ---- Shape recognition ---------------------------------------------------
  // Classifies a single freehand stroke as line / circle / triangle /
  // rectangle. No ML model for Phase 1 — instead: build the stroke's convex
  // hull (throws out inward jitter/noise entirely), simplify that hull with
  // Ramer-Douglas-Peucker to collapse near-straight runs into single edges,
  // then classify by how many corners survive simplification.
  function recognizeShape(points) {
    if (points.length < 3) return null;
    const xs = points.map((p) => p.x);
    const ys = points.map((p) => p.y);
    const minX = Math.min(...xs), maxX = Math.max(...xs);
    const minY = Math.min(...ys), maxY = Math.max(...ys);
    const w = maxX - minX, h = maxY - minY;
    const start = points[0];
    const end = points[points.length - 1];
    const closeGap = Math.hypot(end.x - start.x, end.y - start.y);
    const isClosed = closeGap < Math.max(w, h) * 0.25 + 12;
    const diag = Math.hypot(w, h);

    if (!isClosed) {
      if (diag > 40) {
        const straightness = pathLength(points) / (diag || 1);
        if (straightness < 1.15) return { type: 'line', points: [start, end] };
      }
      return null;
    }
    if (w < 20 || h < 20) return null;

    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
    const radii = points.map((p) => Math.hypot(p.x - cx, p.y - cy));
    const avgR = radii.reduce((a, b) => a + b, 0) / radii.length;
    const variance = radii.reduce((a, b) => a + Math.abs(b - avgR), 0) / radii.length;
    const roundness = variance / (avgR || 1);
    if (roundness < 0.05 && Math.abs(w - h) / Math.max(w, h) < 0.35) {
      return { type: 'circle', cx, cy, r: avgR };
    }

    const hull = convexHull(points);
    if (hull.length < 3) return { type: 'rectangle', x: minX, y: minY, w, h };
    const simplified = simplifyClosedPolygon(hull, diag * 0.06);

    if (simplified.length === 3) return { type: 'triangle', points: simplified };
    return { type: 'rectangle', x: minX, y: minY, w, h };
  }

  function pathLength(points) {
    let total = 0;
    for (let i = 1; i < points.length; i += 1) total += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
    return total;
  }

  function convexHull(points) {
    const pts = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
    const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
    const lower = [];
    for (const p of pts) {
      while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
      lower.push(p);
    }
    const upper = [];
    for (let i = pts.length - 1; i >= 0; i -= 1) {
      const p = pts[i];
      while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
      upper.push(p);
    }
    upper.pop();
    lower.pop();
    return lower.concat(upper);
  }

  function perpendicularDistance(p, a, b) {
    const dx = b.x - a.x, dy = b.y - a.y;
    const magSq = dx * dx + dy * dy;
    if (magSq === 0) return Math.hypot(p.x - a.x, p.y - a.y);
    const u = ((p.x - a.x) * dx + (p.y - a.y) * dy) / magSq;
    const closestX = a.x + u * dx, closestY = a.y + u * dy;
    return Math.hypot(p.x - closestX, p.y - closestY);
  }

  function rdp(pts, eps) {
    if (pts.length < 3) return pts;
    let maxD = 0, idx = 0;
    const first = pts[0], last = pts[pts.length - 1];
    for (let i = 1; i < pts.length - 1; i += 1) {
      const d = perpendicularDistance(pts[i], first, last);
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > eps) {
      const left = rdp(pts.slice(0, idx + 1), eps);
      const right = rdp(pts.slice(idx), eps);
      return left.slice(0, -1).concat(right);
    }
    return [first, last];
  }

  function simplifyClosedPolygon(hull, eps) {
    if (hull.length < 3) return hull;
    const closed = [...hull, hull[0]];
    const simplified = rdp(closed, eps);
    simplified.pop();
    return simplified;
  }

  // ---- Pointer handling (owner only) ---------------------------------------
  function bindDrawing() {
    canvas.addEventListener('pointerdown', (event) => {
      if (!isOwner) return;
      const point = pointerPos(event);
      if (tool.name === 'select') {
        selectionRect = { x1: point.x, y1: point.y, x2: point.x, y2: point.y };
        drawing = true;
        canvas.setPointerCapture(event.pointerId);
        return;
      }
      drawing = true;
      currentPoints = [point];
      canvas.setPointerCapture(event.pointerId);
    });

    canvas.addEventListener('pointermove', (event) => {
      if (!isOwner || !drawing) return;
      const point = pointerPos(event);
      if (tool.name === 'select') {
        selectionRect.x2 = point.x;
        selectionRect.y2 = point.y;
        redrawAll();
        return;
      }
      currentPoints.push(point);
      redrawAll();
      drawStroke({ tool: tool.name, color: tool.color, size: tool.size, points: currentPoints });
    });

    const finish = () => {
      if (!isOwner || !drawing) return;
      drawing = false;

      if (tool.name === 'select') {
        const hasArea = selectionRect && Math.abs(selectionRect.x2 - selectionRect.x1) > 15 && Math.abs(selectionRect.y2 - selectionRect.y1) > 15;
        $('#plotSelectionBtn').style.display = hasArea ? '' : 'none';
        if (!hasArea) selectionRect = null;
        redrawAll();
        return;
      }

      if (currentPoints.length < 2) { currentPoints = []; return; }
      if (tool.name === 'shape') {
        const shape = recognizeShape(currentPoints);
        const stroke = { tool: 'pen', color: tool.color, size: tool.size, points: currentPoints, shape: shape || undefined };
        commitStroke(stroke, Boolean(shape));
      } else {
        const stroke = { tool: tool.name, color: tool.color, size: tool.size, points: currentPoints };
        commitStroke(stroke, false);
      }
      currentPoints = [];
    };
    // Deliberately NOT bound to 'pointerleave': setPointerCapture (above)
    // already keeps pointermove events routed to the canvas even once the
    // cursor moves past its edge, so a stroke can freely leave and re-enter
    // the canvas mid-draw.
    canvas.addEventListener('pointerup', finish);
    canvas.addEventListener('pointercancel', finish);
  }

  function commitStroke(stroke, isShape) {
    strokes.push(stroke);
    redrawAll();
    sendWs({ type: isShape ? 'stroke:shape' : 'stroke:add', stroke });
  }

  // ---- Toolbar ---------------------------------------------------------
  function bindToolbar() {
    $$('.tool-btn').forEach((button) => {
      button.addEventListener('click', () => {
        tool.name = button.dataset.tool;
        $$('.tool-btn').forEach((b) => b.classList.toggle('active', b === button));
        if (tool.name !== 'select') { selectionRect = null; $('#plotSelectionBtn').style.display = 'none'; redrawAll(); }
      });
    });
    $$('.swatch').forEach((button) => {
      button.addEventListener('click', () => {
        tool.color = button.dataset.color;
        $$('.swatch').forEach((b) => b.classList.toggle('active', b === button));
      });
    });
    $('#sizeRange').addEventListener('input', (event) => { tool.size = Number(event.target.value); });

    $('#clearBoardBtn').addEventListener('click', () => {
      if (!isOwner) return;
      if (!confirm('Clear the whole board for everyone viewing it?')) return;
      strokes = [];
      selectionRect = null;
      redrawAll();
      sendWs({ type: 'board:clear' });
      $('#aiPanelBody').innerHTML = '';
      $('#aiPanel').style.display = 'none';
    });

    $('#fullscreenBtn').addEventListener('click', () => {
      const shell = $('#boardShell');
      if (!document.fullscreenElement) shell.requestFullscreen?.().catch(() => {});
      else document.exitFullscreen?.();
    });

    $('#aiPanelClose').addEventListener('click', () => { $('#aiPanel').style.display = 'none'; });
    $('#viewersPanelClose')?.addEventListener('click', () => { $('#viewersPanel').style.display = 'none'; });
    $('#viewersBtn')?.addEventListener('click', () => {
      const panel = $('#viewersPanel');
      panel.style.display = panel.style.display === 'none' ? 'flex' : 'none';
    });

    $('#explainBtn').addEventListener('click', explainBoard);
    $('#plotSelectionBtn').addEventListener('click', plotSelection);
    $('#plotForm').addEventListener('submit', (event) => {
      event.preventDefault();
      const expression = $('#plotInput').value.trim();
      if (!expression) return;
      plotExpression(expression, true);
      $('#plotInput').value = '';
    });

    $('#saveBtn')?.addEventListener('click', saveBoard);
    $('#shareToggleBtn')?.addEventListener('click', toggleShare);
    $('#liveToggleBtn')?.addEventListener('click', toggleLive);
  }

  function applyOwnerUI() {
    $('#boardToolbar').style.display = isOwner ? '' : 'none';
    $('#readonlyBanner').style.display = isOwner ? 'none' : '';
    $('#ownerActions').style.display = isOwner ? 'flex' : 'none';
    canvas.style.cursor = isOwner ? 'crosshair' : 'default';
    updateBadge();
  }

  function updateBadge() {
    const badge = $('#boardBadge');
    if (!isOwner) { badge.style.display = 'none'; return; }
    badge.style.display = '';
    if (boardMeta.isLive) { badge.textContent = 'Live'; badge.className = 'board-badge is-live'; }
    else if (boardMeta.shared) { badge.textContent = 'Shared'; badge.className = 'board-badge is-shared'; }
    else { badge.textContent = 'Private'; badge.className = 'board-badge'; }
    $('#shareToggleBtn').textContent = boardMeta.shared ? 'Unshare' : 'Share';
    $('#liveToggleBtn').textContent = boardMeta.isLive ? 'Stop live' : 'Go live';
  }

  async function saveBoard() {
    try {
      await api(`/api/board/${boardIdValue}/save`, { method: 'POST', body: JSON.stringify({}) });
      setStatus('Board saved.', 'success');
    } catch (error) {
      setStatus(error.message, 'error');
    }
  }

  async function toggleShare() {
    try {
      const data = await api(`/api/board/${boardIdValue}/share-toggle`, { method: 'POST', body: JSON.stringify({ shared: !boardMeta.shared }) });
      boardMeta.shared = data.board.shared;
      updateBadge();
      setStatus(boardMeta.shared ? 'Shared with your team.' : 'No longer shared.', 'success');
    } catch (error) {
      setStatus(error.message, 'error');
    }
  }

  async function toggleLive() {
    try {
      const endpoint = boardMeta.isLive ? 'stop-live' : 'go-live';
      const data = await api(`/api/board/${boardIdValue}/${endpoint}`, { method: 'POST', body: JSON.stringify({}) });
      boardMeta.isLive = data.board.isLive;
      updateBadge();
      setStatus(boardMeta.isLive ? 'You are live. Only one of your boards can be live at a time.' : 'Stopped broadcasting.', 'success');
    } catch (error) {
      setStatus(error.message, 'error');
    }
  }

  function updateViewers(viewers) {
    $('#viewerCount').textContent = viewers.length;
    const body = $('#viewersPanelBody');
    if (!viewers.length) { body.innerHTML = '<p class="ai-note">No one is watching right now.</p>'; return; }
    body.innerHTML = viewers.map((v) => `
      <div class="viewer-row"><span class="viewer-dot"></span>${escapeHtml(v.name)}</div>
    `).join('');
  }

  // ---- AI: explain what's on the board (vision call via server) -----------
  async function explainBoard() {
    if (!isOwner) return;
    const button = $('#explainBtn');
    button.disabled = true;
    const originalText = button.textContent;
    button.textContent = 'Thinking…';
    try {
      const snapshot = canvas.toDataURL('image/png');
      sendWs({ type: 'ai:explain', snapshot });
    } catch (error) {
      setStatus('Could not capture the board for AI explain.', 'error');
    } finally {
      setTimeout(() => { button.disabled = false; button.textContent = originalText; }, 1200);
    }
  }

  // ---- AI: circle an equation, hit Plot ------------------------------------
  function plotSelection() {
    if (!isOwner || !selectionRect) return;
    const x = Math.min(selectionRect.x1, selectionRect.x2);
    const y = Math.min(selectionRect.y1, selectionRect.y2);
    const w = Math.abs(selectionRect.x2 - selectionRect.x1);
    const h = Math.abs(selectionRect.y2 - selectionRect.y1);

    const crop = document.createElement('canvas');
    const dpr = window.devicePixelRatio || 1;
    crop.width = Math.round(w * dpr);
    crop.height = Math.round(h * dpr);
    const cctx = crop.getContext('2d');
    // White background so handwriting in a dark-on-transparent stroke color
    // is still legible to the vision model (canvas strokes have no fill).
    cctx.fillStyle = '#0a1526';
    cctx.fillRect(0, 0, crop.width, crop.height);
    cctx.drawImage(canvas, x * dpr, y * dpr, w * dpr, h * dpr, 0, 0, crop.width, crop.height);

    const snapshot = crop.toDataURL('image/png');
    sendWs({ type: 'ai:read-equation', snapshot });
    setStatus('Reading the selected equation…', '');
    selectionRect = null;
    $('#plotSelectionBtn').style.display = 'none';
    redrawAll();
  }

  // ---- AI: plot a typed function (client-side math, no AI call) -----------
  // Safe hand-rolled recursive-descent parser/evaluator — deliberately NOT
  // eval()/Function(), because plotted expressions are broadcast to other
  // users' browsers (viewers), and text from another user must never be
  // treated as executable code in someone else's session.
  function compileExpression(raw) {
    const source = String(raw).split('=').pop().trim();
    let pos = 0;
    const CONSTANTS = { pi: Math.PI, e: Math.E };
    const FUNCS = {
      sin: Math.sin, cos: Math.cos, tan: Math.tan,
      sqrt: Math.sqrt, abs: Math.abs, exp: Math.exp,
      log: Math.log10, ln: Math.log
    };

    function peek() { return source[pos]; }
    function skipWs() { while (pos < source.length && /\s/.test(source[pos])) pos += 1; }

    function canStartFactor() {
      skipWs();
      const c = peek();
      return c === '(' || (c !== undefined && /[a-zA-Z0-9]/.test(c));
    }

    function parseExpr() {
      let value = parseTerm();
      skipWs();
      while (peek() === '+' || peek() === '-') {
        const op = source[pos]; pos += 1;
        const rhs = parseTerm();
        const prev = value;
        value = op === '+' ? (x) => prev(x) + rhs(x) : (x) => prev(x) - rhs(x);
        skipWs();
      }
      return value;
    }

    function parseTerm() {
      let value = parseFactor();
      skipWs();
      while (peek() === '*' || peek() === '/' || canStartFactor()) {
        if (peek() === '*' || peek() === '/') {
          const op = source[pos]; pos += 1;
          const rhs = parseFactor();
          const prev = value;
          value = op === '*' ? (x) => prev(x) * rhs(x) : (x) => prev(x) / rhs(x);
        } else {
          const rhs = parseFactor();
          const prev = value;
          value = (x) => prev(x) * rhs(x);
        }
        skipWs();
      }
      return value;
    }

    function parseFactor() {
      const base = parseUnary();
      skipWs();
      if (peek() === '^') {
        pos += 1;
        const exponent = parseFactor();
        return (x) => Math.pow(base(x), exponent(x));
      }
      return base;
    }

    function parseUnary() {
      skipWs();
      if (peek() === '-') { pos += 1; const inner = parseUnary(); return (x) => -inner(x); }
      if (peek() === '+') { pos += 1; return parseUnary(); }
      return parsePrimary();
    }

    function parsePrimary() {
      skipWs();
      if (peek() === '(') {
        pos += 1;
        const inner = parseExpr();
        skipWs();
        if (peek() !== ')') throw new Error('Missing closing parenthesis.');
        pos += 1;
        return inner;
      }
      const numMatch = /^\d+(\.\d+)?/.exec(source.slice(pos));
      if (numMatch) {
        pos += numMatch[0].length;
        const n = Number(numMatch[0]);
        return () => n;
      }
      const identMatch = /^[a-zA-Z]+/.exec(source.slice(pos));
      if (identMatch) {
        const name = identMatch[0].toLowerCase();
        pos += identMatch[0].length;
        if (name === 'x') return (x) => x;
        if (CONSTANTS[name] !== undefined) return () => CONSTANTS[name];
        if (FUNCS[name]) {
          skipWs();
          if (peek() !== '(') throw new Error(`Expected "(" after ${name}`);
          pos += 1;
          const arg = parseExpr();
          skipWs();
          if (peek() !== ')') throw new Error('Missing closing parenthesis.');
          pos += 1;
          return (x) => FUNCS[name](arg(x));
        }
        throw new Error(`Unknown name "${name}"`);
      }
      throw new Error(`Unexpected character "${peek() || ''}"`);
    }

    const fn = parseExpr();
    skipWs();
    if (pos < source.length) throw new Error(`Unexpected trailing input near "${source.slice(pos)}"`);
    return fn;
  }

  function renderGraph(canvasEl, expression) {
    const gctx = canvasEl.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const rect = canvasEl.getBoundingClientRect();
    canvasEl.width = Math.round((rect.width || 300) * dpr);
    canvasEl.height = Math.round((rect.height || 140) * dpr);
    gctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const w = rect.width || 300, h = rect.height || 140;
    gctx.clearRect(0, 0, w, h);

    let fn;
    try { fn = compileExpression(expression); } catch (error) {
      gctx.fillStyle = '#ff6b7a';
      gctx.font = '12px Inter, sans-serif';
      gctx.fillText(`Could not plot: ${error.message}`, 8, 20);
      return;
    }

    const xMin = -10, xMax = 10;
    const samples = [];
    for (let i = 0; i <= 200; i += 1) {
      const x = xMin + ((xMax - xMin) * i) / 200;
      let y;
      try { y = fn(x); } catch { y = NaN; }
      samples.push({ x, y });
    }
    const finiteYs = samples.map((s) => s.y).filter((y) => Number.isFinite(y));
    if (!finiteYs.length) {
      gctx.fillStyle = '#ff6b7a';
      gctx.fillText('No plottable values in range.', 8, 20);
      return;
    }
    let yMin = Math.min(...finiteYs), yMax = Math.max(...finiteYs);
    if (yMin === yMax) { yMin -= 1; yMax += 1; }
    const pad = (yMax - yMin) * 0.1;
    yMin -= pad; yMax += pad;

    const toPx = (x, y) => ({
      px: ((x - xMin) / (xMax - xMin)) * w,
      py: h - ((y - yMin) / (yMax - yMin)) * h
    });

    gctx.strokeStyle = 'rgba(255,255,255,0.18)';
    gctx.lineWidth = 1;
    const zeroX = toPx(0, 0).px, zeroY = toPx(0, 0).py;
    gctx.beginPath();
    if (zeroX >= 0 && zeroX <= w) { gctx.moveTo(zeroX, 0); gctx.lineTo(zeroX, h); }
    if (zeroY >= 0 && zeroY <= h) { gctx.moveTo(0, zeroY); gctx.lineTo(w, zeroY); }
    gctx.stroke();

    gctx.strokeStyle = '#14d9c4';
    gctx.lineWidth = 2;
    gctx.beginPath();
    let started = false;
    samples.forEach((s) => {
      if (!Number.isFinite(s.y)) { started = false; return; }
      const { px, py } = toPx(s.x, s.y);
      if (!started) { gctx.moveTo(px, py); started = true; } else { gctx.lineTo(px, py); }
    });
    gctx.stroke();
  }

  function plotExpression(expression, broadcast) {
    addAiNote({ kind: 'graph', expression, createdAt: new Date().toISOString() });
    if (broadcast) sendWs({ type: 'ai:plot', expression });
  }

  function addAiNote(note) {
    const panel = $('#aiPanel');
    const body = $('#aiPanelBody');
    panel.style.display = 'flex';
    const item = document.createElement('div');
    item.className = 'ai-note';
    if (note.kind === 'graph') {
      item.innerHTML = `<span class="ai-note-kind">Graph</span>${escapeHtml(note.expression)}<canvas class="graph-mini"></canvas>`;
      body.prepend(item);
      renderGraph(item.querySelector('canvas'), note.expression);
    } else {
      item.innerHTML = `<span class="ai-note-kind">Explained</span>${escapeHtml(note.result || '')}`;
      body.prepend(item);
    }
  }

  // ---- WebSocket ------------------------------------------------------
  function sendWs(payload) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
  }

  function setStatusPill(text, kind) {
    const pill = $('#boardStatus');
    pill.textContent = text;
    pill.className = `board-status${kind ? ` ${kind}` : ''}`;
  }

  function connectWs() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${protocol}//${window.location.host}/ws/board?boardId=${encodeURIComponent(boardIdValue)}`);

    ws.addEventListener('open', () => setStatusPill('Live', 'live'));

    ws.addEventListener('message', (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }

      if (msg.type === 'sync') {
        strokes = msg.board.strokes || [];
        boardMeta = { title: msg.board.title, shared: msg.board.shared, isLive: msg.board.isLive };
        updateBadge();
        redrawAll();
        (msg.board.aiNotes || []).slice(-10).forEach(addAiNote);
        return;
      }
      if (msg.type === 'stroke:add' || msg.type === 'stroke:shape') {
        strokes.push(msg.stroke);
        redrawAll();
        return;
      }
      if (msg.type === 'board:clear') {
        strokes = [];
        redrawAll();
        return;
      }
      if (msg.type === 'ai:result') {
        addAiNote(msg.note);
        return;
      }
      if (msg.type === 'presence') {
        updateViewers(msg.viewers || []);
        return;
      }
      if (msg.type === 'error') {
        setStatus(msg.message, 'error');
      }
    });

    ws.addEventListener('close', () => {
      setStatusPill('Reconnecting…', 'error');
      clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(connectWs, 1500);
    });

    ws.addEventListener('error', () => setStatusPill('Connection error', 'error'));
  }

  // ---- Boot -------------------------------------------------------------
  async function init() {
    await refreshMe();
    try {
      const data = await api(`/api/board/${boardIdValue}`);
      isOwner = Boolean(data.isOwner);
      strokes = data.board.strokes || [];
      boardMeta = { title: data.board.title, shared: data.board.shared, isLive: data.board.isLive };
      $('#boardTitle').textContent = isOwner ? data.board.title : `${data.teacher.name}'s whiteboard`;
    } catch (error) {
      setStatus(error.message, 'error');
      $('#boardTitle').textContent = 'Whiteboard unavailable';
      setStatusPill('Unavailable', 'error');
      return;
    }

    applyOwnerUI();
    bindToolbar();
    bindDrawing();
    resizeCanvas();
    connectWs();
  }

  init();
})();
