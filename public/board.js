/*
 * Athena Whiteboard client (Phase 1)
 * One board per teacher; viewers are read-only and get the teacher's
 * strokes live over WebSocket. Two "smart" AI actions: explain what's on
 * the board (vision call to the server) and plot a typed math function
 * (pure client-side, no AI call, evaluated with a small safe parser —
 * never eval()/Function() on text that came from another user).
 */
(() => {
  const { $, $$, escapeHtml, setStatus, api, refreshMe } = window.AppCommon;

  const teacherId = window.location.pathname.split('/').pop();
  const canvas = $('#boardCanvas');
  const ctx = canvas.getContext('2d');

  let isOwner = false;
  let strokes = [];
  let ws = null;
  let reconnectTimer = null;

  const tool = { name: 'pen', color: '#eef6ff', size: 3 };
  let drawing = false;
  let currentPoints = [];

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
  }

  // ---- Shape recognition ---------------------------------------------------
  // Rough heuristic classifier for a single freehand stroke: fits the stroke
  // to a bounding box + endpoint-closure test, then picks the simplest shape
  // that reasonably matches. This is intentionally simple for Phase 1 (no ML
  // model) — good enough for "draw a wobbly circle/box/triangle, get a clean
  // one", matching the basic version of the iFlytek-style demo.
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

    // Straight line: low bounding-box "fill" relative to its diagonal.
    const diag = Math.hypot(w, h);
    if (!isClosed && diag > 40) {
      const straightness = pathLength(points) / (diag || 1);
      if (straightness < 1.15) {
        return { type: 'line', points: [start, end] };
      }
    }

    if (!isClosed || w < 20 || h < 20) return null;

    // Circle-ish: compare distances from centroid to a constant radius.
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
    const r = (w + h) / 4;
    const radii = points.map((p) => Math.hypot(p.x - cx, p.y - cy));
    const avgR = radii.reduce((a, b) => a + b, 0) / radii.length;
    const variance = radii.reduce((a, b) => a + Math.abs(b - avgR), 0) / radii.length;
    const roundness = variance / (avgR || 1);
    if (roundness < 0.22 && Math.abs(w - h) / Math.max(w, h) < 0.4) {
      return { type: 'circle', cx, cy, r: avgR };
    }

    // Triangle-ish: approximate with 3 dominant corners via a simple convex
    // hull corner pick (cheap heuristic, not a full polygon-fit algorithm).
    const corners = threeDominantCorners(points);
    if (corners) return { type: 'triangle', points: corners };

    // Default: rectangle from the bounding box.
    return { type: 'rectangle', x: minX, y: minY, w, h };
  }

  function pathLength(points) {
    let total = 0;
    for (let i = 1; i < points.length; i += 1) total += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
    return total;
  }

  function threeDominantCorners(points) {
    // Pick the 3 points farthest from the stroke's centroid and spread
    // roughly 120° apart — a cheap stand-in for real corner detection.
    const cx = points.reduce((a, p) => a + p.x, 0) / points.length;
    const cy = points.reduce((a, p) => a + p.y, 0) / points.length;
    const withAngle = points.map((p) => ({ ...p, angle: Math.atan2(p.y - cy, p.x - cx), dist: Math.hypot(p.x - cx, p.y - cy) }));
    const buckets = [[], [], []];
    withAngle.forEach((p) => {
      const idx = Math.floor(((p.angle + Math.PI) / (2 * Math.PI)) * 3) % 3;
      buckets[idx].push(p);
    });
    if (buckets.some((b) => b.length === 0)) return null;
    return buckets.map((bucket) => bucket.reduce((best, p) => (p.dist > best.dist ? p : best), bucket[0]));
  }

  // ---- Pointer handling (owner only) ---------------------------------------
  function bindDrawing() {
    canvas.addEventListener('pointerdown', (event) => {
      if (!isOwner) return;
      drawing = true;
      currentPoints = [pointerPos(event)];
      canvas.setPointerCapture(event.pointerId);
    });

    canvas.addEventListener('pointermove', (event) => {
      if (!isOwner || !drawing) return;
      const point = pointerPos(event);
      currentPoints.push(point);
      // Live-preview the in-progress stroke locally without persisting yet.
      redrawAll();
      drawStroke({ tool: tool.name, color: tool.color, size: tool.size, points: currentPoints });
    });

    const finish = () => {
      if (!isOwner || !drawing) return;
      drawing = false;
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
    canvas.addEventListener('pointerup', finish);
    canvas.addEventListener('pointerleave', finish);
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
      redrawAll();
      sendWs({ type: 'board:clear' });
    });

    $('#fullscreenBtn').addEventListener('click', () => {
      const shell = $('#boardShell');
      if (!document.fullscreenElement) shell.requestFullscreen?.().catch(() => {});
      else document.exitFullscreen?.();
    });

    $('#aiPanelClose').addEventListener('click', () => { $('#aiPanel').style.display = 'none'; });

    $('#explainBtn').addEventListener('click', explainBoard);
    $('#plotForm').addEventListener('submit', (event) => {
      event.preventDefault();
      const expression = $('#plotInput').value.trim();
      if (!expression) return;
      plotExpression(expression, true);
      $('#plotInput').value = '';
    });
  }

  function applyOwnerUI() {
    $('#boardToolbar').style.display = isOwner ? '' : 'none';
    $('#readonlyBanner').style.display = isOwner ? 'none' : '';
    canvas.style.cursor = isOwner ? 'crosshair' : 'default';
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

  // ---- AI: plot a typed function (client-side math, no AI call) -----------
  // Safe hand-rolled recursive-descent parser/evaluator — deliberately NOT
  // eval()/Function(), because plotted expressions are broadcast to other
  // users' browsers (viewers), and a teacher's typed text must never be
  // treated as executable code in someone else's session.
  function compileExpression(raw) {
    const source = String(raw).split('=').pop().trim(); // allow "y = x^2 - 3" or just "x^2 - 3"
    let pos = 0;
    const CONSTANTS = { pi: Math.PI, e: Math.E };
    const FUNCS = {
      sin: Math.sin, cos: Math.cos, tan: Math.tan,
      sqrt: Math.sqrt, abs: Math.abs, exp: Math.exp,
      log: Math.log10, ln: Math.log
    };

    function peek() { return source[pos]; }
    function skipWs() { while (pos < source.length && /\s/.test(source[pos])) pos += 1; }

    function parseExpr() {
      let value = parseTerm();
      skipWs();
      while (peek() === '+' || peek() === '-') {
        const op = source[pos]; pos += 1;
        const rhs = parseTerm();
        value = op === '+' ? (x) => value(x) + rhs(x) : (x) => value(x) - rhs(x);
        skipWs();
      }
      return value;
    }

    function parseTerm() {
      let value = parseFactor();
      skipWs();
      while (peek() === '*' || peek() === '/') {
        const op = source[pos]; pos += 1;
        const rhs = parseFactor();
        value = op === '*' ? (x) => value(x) * rhs(x) : (x) => value(x) / rhs(x);
        skipWs();
      }
      return value;
    }

    function parseFactor() {
      const base = parseUnary();
      skipWs();
      if (peek() === '^') {
        pos += 1;
        const exponent = parseFactor(); // right-associative
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

    // Axes
    gctx.strokeStyle = 'rgba(255,255,255,0.18)';
    gctx.lineWidth = 1;
    const zeroX = toPx(0, 0).px, zeroY = toPx(0, 0).py;
    gctx.beginPath();
    if (zeroX >= 0 && zeroX <= w) { gctx.moveTo(zeroX, 0); gctx.lineTo(zeroX, h); }
    if (zeroY >= 0 && zeroY <= h) { gctx.moveTo(0, zeroY); gctx.lineTo(w, zeroY); }
    gctx.stroke();

    // Curve
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
    ws = new WebSocket(`${protocol}//${window.location.host}/ws/board?teacherId=${encodeURIComponent(teacherId)}`);

    ws.addEventListener('open', () => setStatusPill('Live', 'live'));

    ws.addEventListener('message', (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }

      if (msg.type === 'sync') {
        strokes = msg.board.strokes || [];
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
      const data = await api(`/api/board/${teacherId}`);
      isOwner = Boolean(data.isOwner);
      strokes = data.board.strokes || [];
      $('#boardTitle').textContent = isOwner ? 'Your whiteboard' : `${data.teacher.name}'s whiteboard`;
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
