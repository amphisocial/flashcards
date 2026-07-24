/*
 * Athena Whiteboard v2
 * Multi-page, pan/zoom canvas with undo/redo, objects (notes/text/graphs),
 * page templates and imported backgrounds, live laser + reactions + presence,
 * a replay scrubber, PDF export, board->study-set, and a right-hand Info
 * panel driven by a single classifying vision call.
 *
 * Coordinates: strokes and objects are stored in WORLD space. The canvas is
 * drawn with a pan/zoom transform applied, so zooming never rewrites data.
 */
(() => {
  const { $, $$, escapeHtml, setStatus, api, refreshMe } = window.AppCommon;

  const boardIdValue = window.location.pathname.split('/').pop();
  const canvas = $('#boardCanvas');
  const ctx = canvas.getContext('2d');
  const laserCanvas = $('#laserCanvas');
  const lctx = laserCanvas.getContext('2d');

  let board = null;
  let isOwner = false;
  let pageIndex = 0;
  let ws = null;
  let reconnectTimer = null;

  const view = { x: 0, y: 0, scale: 1 };
  const tool = { name: 'pen', color: '#eef6ff', size: 3 };

  let drawing = false;
  let panning = false;
  let panStart = null;
  let currentPoints = [];
  let selectionRect = null;
  let spaceHeld = false;

  const undoStack = [];
  const redoStack = [];

  let replay = { active: false, index: 0, timer: null };
  let lastAnalysis = null;

  const page = () => board.pages[pageIndex];
  const pageId = () => (page() ? page().id : null);

  // ---- Coordinate helpers -------------------------------------------------
  function screenToWorld(sx, sy) {
    return { x: (sx - view.x) / view.scale, y: (sy - view.y) / view.scale };
  }
  function worldToScreen(wx, wy) {
    return { x: wx * view.scale + view.x, y: wy * view.scale + view.y };
  }
  function pointerWorld(event) {
    const r = canvas.getBoundingClientRect();
    return screenToWorld(event.clientX - r.left, event.clientY - r.top);
  }

  function resizeCanvas() {
    const rect = $('#canvasWrap').getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    [canvas, laserCanvas].forEach((c) => {
      c.width = Math.round(rect.width * dpr);
      c.height = Math.round(rect.height * dpr);
      c.style.width = `${rect.width}px`;
      c.style.height = `${rect.height}px`;
    });
    redraw();
  }
  window.addEventListener('resize', resizeCanvas);

  // ---- Rendering ----------------------------------------------------------
  function applyTransform(c, dpr) {
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.translate(view.x, view.y);
    c.scale(view.scale, view.scale);
  }

  function visibleWorldBounds() {
    const rect = canvas.getBoundingClientRect();
    const tl = screenToWorld(0, 0);
    const br = screenToWorld(rect.width, rect.height);
    return { x1: tl.x, y1: tl.y, x2: br.x, y2: br.y };
  }

  function drawTemplate(p) {
    if (!p.template || p.template === 'blank') return;
    const b = visibleWorldBounds();
    const step = 40;
    ctx.save();
    ctx.lineWidth = 1 / view.scale;
    ctx.strokeStyle = 'rgba(255,255,255,0.09)';
    const startX = Math.floor(b.x1 / step) * step;
    const startY = Math.floor(b.y1 / step) * step;

    if (p.template === 'lined') {
      ctx.beginPath();
      for (let y = startY; y < b.y2; y += step) { ctx.moveTo(b.x1, y); ctx.lineTo(b.x2, y); }
      ctx.stroke();
    } else {
      ctx.beginPath();
      for (let x = startX; x < b.x2; x += step) { ctx.moveTo(x, b.y1); ctx.lineTo(x, b.y2); }
      for (let y = startY; y < b.y2; y += step) { ctx.moveTo(b.x1, y); ctx.lineTo(b.x2, y); }
      ctx.stroke();
      if (p.template === 'coordinate') {
        ctx.strokeStyle = 'rgba(255,255,255,0.4)';
        ctx.lineWidth = 1.6 / view.scale;
        ctx.beginPath();
        ctx.moveTo(b.x1, 0); ctx.lineTo(b.x2, 0);
        ctx.moveTo(0, b.y1); ctx.lineTo(0, b.y2);
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  const bgCache = new Map();
  function drawBackground(p) {
    if (!p.background) return;
    let img = bgCache.get(p.id);
    if (!img) {
      img = new Image();
      img.onload = () => redraw();
      img.src = p.background;
      bgCache.set(p.id, img);
      return;
    }
    if (!img.complete || !img.naturalWidth) return;
    ctx.save();
    ctx.globalAlpha = 0.9;
    ctx.drawImage(img, 0, 0, img.naturalWidth, img.naturalHeight);
    ctx.restore();
  }

  function drawStroke(stroke) {
    if (!stroke.points || !stroke.points.length) return;
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
    if (stroke.shape) drawShape(stroke.shape);
    else {
      ctx.beginPath();
      stroke.points.forEach((pt, i) => (i ? ctx.lineTo(pt.x, pt.y) : ctx.moveTo(pt.x, pt.y)));
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawShape(shape) {
    ctx.beginPath();
    if (shape.type === 'circle') ctx.arc(shape.cx, shape.cy, shape.r, 0, Math.PI * 2);
    else if (shape.type === 'rectangle') ctx.rect(shape.x, shape.y, shape.w, shape.h);
    else if (shape.type === 'triangle') {
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

  function wrapText(c, text, x, y, maxWidth, lineHeight) {
    const words = String(text || '').split(/\s+/);
    let line = '';
    let cy = y;
    words.forEach((w) => {
      const test = line ? `${line} ${w}` : w;
      if (c.measureText(test).width > maxWidth && line) { c.fillText(line, x, cy); line = w; cy += lineHeight; }
      else line = test;
    });
    if (line) c.fillText(line, x, cy);
    return cy;
  }

  function drawObject(obj) {
    ctx.save();
    if (obj.type === 'note') {
      ctx.fillStyle = obj.color || '#ffcc66';
      ctx.beginPath();
      ctx.roundRect(obj.x, obj.y, obj.w, obj.h, 10);
      ctx.fill();
      ctx.fillStyle = '#1b1403';
      ctx.font = '600 15px Inter, sans-serif';
      wrapText(ctx, obj.text, obj.x + 12, obj.y + 26, obj.w - 24, 19);
    } else if (obj.type === 'text') {
      ctx.fillStyle = obj.color || '#eef6ff';
      ctx.font = '700 20px Inter, sans-serif';
      wrapText(ctx, obj.text, obj.x, obj.y + 20, obj.w || 360, 25);
    } else if (obj.type === 'graph') {
      drawGraphObject(obj);
    }
    ctx.restore();
  }

  function render(strokeLimit) {
    const p = page();
    if (!p) return;
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, rect.width, rect.height);
    applyTransform(ctx, dpr);

    drawBackground(p);
    drawTemplate(p);
    const strokes = typeof strokeLimit === 'number' ? p.strokes.slice(0, strokeLimit) : p.strokes;
    strokes.forEach(drawStroke);
    if (typeof strokeLimit !== 'number') p.objects.forEach(drawObject);

    if (selectionRect) {
      ctx.save();
      ctx.strokeStyle = '#14d9c4';
      ctx.lineWidth = 1.5 / view.scale;
      ctx.setLineDash([6 / view.scale, 4 / view.scale]);
      const { x1, y1, x2, y2 } = selectionRect;
      ctx.strokeRect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1));
      ctx.restore();
    }
  }
  function redraw() { render(replay.active ? replay.index : undefined); }

  // ---- Graph objects (plotted on the board itself) ------------------------
  function drawGraphObject(obj) {
    const { x, y, w, h, expression } = obj;
    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.beginPath(); ctx.roundRect(x, y, w, h, 10); ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.18)';
    ctx.lineWidth = 1 / view.scale;
    ctx.stroke();

    let fn;
    try { fn = compileExpression(expression); }
    catch (err) {
      ctx.fillStyle = '#ff6b7a';
      ctx.font = '13px Inter, sans-serif';
      ctx.fillText(`Cannot plot: ${err.message}`, x + 10, y + 24);
      ctx.restore();
      return;
    }

    const xMin = -10, xMax = 10;
    const samples = [];
    for (let i = 0; i <= 220; i += 1) {
      const wx = xMin + ((xMax - xMin) * i) / 220;
      let wy; try { wy = fn(wx); } catch { wy = NaN; }
      samples.push({ x: wx, y: wy });
    }
    const ys = samples.map((s) => s.y).filter(Number.isFinite);
    if (!ys.length) { ctx.restore(); return; }
    let yMin = Math.min(...ys), yMax = Math.max(...ys);
    if (yMin === yMax) { yMin -= 1; yMax += 1; }
    const padY = (yMax - yMin) * 0.12; yMin -= padY; yMax += padY;

    const px = (vx) => x + ((vx - xMin) / (xMax - xMin)) * w;
    const py = (vy) => y + h - ((vy - yMin) / (yMax - yMin)) * h;

    ctx.strokeStyle = 'rgba(255,255,255,0.2)';
    ctx.beginPath();
    if (0 >= xMin && 0 <= xMax) { ctx.moveTo(px(0), y); ctx.lineTo(px(0), y + h); }
    if (0 >= yMin && 0 <= yMax) { ctx.moveTo(x, py(0)); ctx.lineTo(x + w, py(0)); }
    ctx.stroke();

    ctx.strokeStyle = '#14d9c4';
    ctx.lineWidth = 2 / view.scale;
    ctx.beginPath();
    let started = false;
    samples.forEach((s) => {
      if (!Number.isFinite(s.y)) { started = false; return; }
      const sx = px(s.x), sy = py(s.y);
      if (sy < y - h || sy > y + 2 * h) { started = false; return; }
      if (!started) { ctx.moveTo(sx, sy); started = true; } else ctx.lineTo(sx, sy);
    });
    ctx.stroke();

    ctx.fillStyle = 'rgba(238,246,255,0.85)';
    ctx.font = '600 13px Inter, sans-serif';
    ctx.fillText(expression, x + 10, y + 18);
    ctx.restore();
  }

  // ---- Safe expression parser --------------------------------------------
  // Hand-rolled on purpose: plotted expressions are broadcast to other
  // people's browsers, so they must never reach eval()/Function().
  function compileExpression(raw) {
    const source = String(raw).split('=').pop().trim();
    let pos = 0;
    const CONSTANTS = { pi: Math.PI, e: Math.E };
    const FUNCS = { sin: Math.sin, cos: Math.cos, tan: Math.tan, sqrt: Math.sqrt, abs: Math.abs, exp: Math.exp, log: Math.log10, ln: Math.log };
    const peek = () => source[pos];
    const skipWs = () => { while (pos < source.length && /\s/.test(source[pos])) pos += 1; };
    const canStartFactor = () => { skipWs(); const c = peek(); return c === '(' || (c !== undefined && /[a-zA-Z0-9]/.test(c)); };

    function parseExpr() {
      let v = parseTerm(); skipWs();
      while (peek() === '+' || peek() === '-') {
        const op = source[pos]; pos += 1;
        const rhs = parseTerm(); const prev = v;
        v = op === '+' ? (x) => prev(x) + rhs(x) : (x) => prev(x) - rhs(x);
        skipWs();
      }
      return v;
    }
    function parseTerm() {
      let v = parseFactor(); skipWs();
      while (peek() === '*' || peek() === '/' || canStartFactor()) {
        if (peek() === '*' || peek() === '/') {
          const op = source[pos]; pos += 1;
          const rhs = parseFactor(); const prev = v;
          v = op === '*' ? (x) => prev(x) * rhs(x) : (x) => prev(x) / rhs(x);
        } else { const rhs = parseFactor(); const prev = v; v = (x) => prev(x) * rhs(x); }
        skipWs();
      }
      return v;
    }
    function parseFactor() {
      const base = parseUnary(); skipWs();
      if (peek() === '^') { pos += 1; const exp = parseFactor(); return (x) => Math.pow(base(x), exp(x)); }
      return base;
    }
    function parseUnary() {
      skipWs();
      if (peek() === '-') { pos += 1; const i = parseUnary(); return (x) => -i(x); }
      if (peek() === '+') { pos += 1; return parseUnary(); }
      return parsePrimary();
    }
    function parsePrimary() {
      skipWs();
      if (peek() === '(') { pos += 1; const i = parseExpr(); skipWs(); if (peek() !== ')') throw new Error('Missing ")"'); pos += 1; return i; }
      const num = /^\d+(\.\d+)?/.exec(source.slice(pos));
      if (num) { pos += num[0].length; const n = Number(num[0]); return () => n; }
      const ident = /^[a-zA-Z]+/.exec(source.slice(pos));
      if (ident) {
        const name = ident[0].toLowerCase(); pos += ident[0].length;
        if (name === 'x') return (x) => x;
        if (CONSTANTS[name] !== undefined) return () => CONSTANTS[name];
        if (FUNCS[name]) {
          skipWs(); if (peek() !== '(') throw new Error(`Expected "(" after ${name}`);
          pos += 1; const arg = parseExpr(); skipWs();
          if (peek() !== ')') throw new Error('Missing ")"'); pos += 1;
          return (x) => FUNCS[name](arg(x));
        }
        throw new Error(`Unknown name "${name}"`);
      }
      throw new Error(`Unexpected "${peek() || ''}"`);
    }
    const fn = parseExpr(); skipWs();
    if (pos < source.length) throw new Error(`Unexpected "${source.slice(pos)}"`);
    return fn;
  }

  // ---- Shape recognition --------------------------------------------------
  function recognizeShape(points) {
    if (points.length < 3) return null;
    const xs = points.map((p) => p.x), ys = points.map((p) => p.y);
    const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
    const w = maxX - minX, h = maxY - minY;
    const a = points[0], b = points[points.length - 1];
    const gap = Math.hypot(b.x - a.x, b.y - a.y);
    const closed = gap < Math.max(w, h) * 0.25 + 12;
    const diag = Math.hypot(w, h);
    if (!closed) {
      if (diag > 40 && pathLength(points) / (diag || 1) < 1.15) return { type: 'line', points: [a, b] };
      return null;
    }
    if (w < 20 || h < 20) return null;
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
    const radii = points.map((p) => Math.hypot(p.x - cx, p.y - cy));
    const avgR = radii.reduce((s, r) => s + r, 0) / radii.length;
    const variance = radii.reduce((s, r) => s + Math.abs(r - avgR), 0) / radii.length;
    if (variance / (avgR || 1) < 0.05 && Math.abs(w - h) / Math.max(w, h) < 0.35) return { type: 'circle', cx, cy, r: avgR };
    const hull = convexHull(points);
    if (hull.length < 3) return { type: 'rectangle', x: minX, y: minY, w, h };
    const simple = simplifyClosed(hull, diag * 0.06);
    if (simple.length === 3) return { type: 'triangle', points: simple };
    return { type: 'rectangle', x: minX, y: minY, w, h };
  }
  function pathLength(pts) { let t = 0; for (let i = 1; i < pts.length; i += 1) t += Math.hypot(pts[i].x - pts[i-1].x, pts[i].y - pts[i-1].y); return t; }
  function convexHull(points) {
    const pts = [...points].sort((p, q) => p.x - q.x || p.y - q.y);
    const cross = (o, p, q) => (p.x - o.x) * (q.y - o.y) - (p.y - o.y) * (q.x - o.x);
    const lo = [];
    for (const p of pts) { while (lo.length >= 2 && cross(lo[lo.length-2], lo[lo.length-1], p) <= 0) lo.pop(); lo.push(p); }
    const up = [];
    for (let i = pts.length - 1; i >= 0; i -= 1) { const p = pts[i]; while (up.length >= 2 && cross(up[up.length-2], up[up.length-1], p) <= 0) up.pop(); up.push(p); }
    up.pop(); lo.pop(); return lo.concat(up);
  }
  function perpDist(p, a, b) {
    const dx = b.x - a.x, dy = b.y - a.y, m = dx*dx + dy*dy;
    if (!m) return Math.hypot(p.x - a.x, p.y - a.y);
    const u = ((p.x - a.x) * dx + (p.y - a.y) * dy) / m;
    return Math.hypot(p.x - (a.x + u*dx), p.y - (a.y + u*dy));
  }
  function rdp(pts, eps) {
    if (pts.length < 3) return pts;
    let max = 0, idx = 0;
    for (let i = 1; i < pts.length - 1; i += 1) { const d = perpDist(pts[i], pts[0], pts[pts.length-1]); if (d > max) { max = d; idx = i; } }
    if (max > eps) return rdp(pts.slice(0, idx+1), eps).slice(0, -1).concat(rdp(pts.slice(idx), eps));
    return [pts[0], pts[pts.length-1]];
  }
  function simplifyClosed(hull, eps) { const c = [...hull, hull[0]]; const s = rdp(c, eps); s.pop(); return s; }

  // ---- Pointer input ------------------------------------------------------
  function bindPointer() {
    canvas.addEventListener('pointerdown', (e) => {
      const w = pointerWorld(e);
      if (tool.name === 'pan' || spaceHeld || e.button === 1) {
        panning = true; panStart = { sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y };
        canvas.setPointerCapture(e.pointerId); return;
      }
      if (!isOwner) return;
      if (tool.name === 'laser') { drawing = true; sendLaser(w, true); canvas.setPointerCapture(e.pointerId); return; }
      if (tool.name === 'note' || tool.name === 'text') { createTextObject(tool.name, w); return; }
      if (tool.name === 'select') { selectionRect = { x1: w.x, y1: w.y, x2: w.x, y2: w.y }; drawing = true; canvas.setPointerCapture(e.pointerId); return; }
      drawing = true; currentPoints = [w]; canvas.setPointerCapture(e.pointerId);
    });

    canvas.addEventListener('pointermove', (e) => {
      if (panning && panStart) {
        view.x = panStart.vx + (e.clientX - panStart.sx);
        view.y = panStart.vy + (e.clientY - panStart.sy);
        redraw(); positionObjects(); return;
      }
      if (!drawing || !isOwner) return;
      const w = pointerWorld(e);
      if (tool.name === 'laser') { sendLaser(w, true); drawLaser(w); return; }
      if (tool.name === 'select') { selectionRect.x2 = w.x; selectionRect.y2 = w.y; redraw(); return; }
      currentPoints.push(w);
      redraw();
      drawStroke({ tool: tool.name, color: tool.color, size: tool.size, points: currentPoints });
    });

    const finish = () => {
      if (panning) { panning = false; panStart = null; return; }
      if (!drawing) return;
      drawing = false;
      if (tool.name === 'laser') { sendLaser(null, false); clearLaser(); return; }
      if (tool.name === 'select') {
        const ok = selectionRect && Math.abs(selectionRect.x2 - selectionRect.x1) > 12 && Math.abs(selectionRect.y2 - selectionRect.y1) > 12;
        $('#plotSelectionBtn').style.display = ok ? '' : 'none';
        if (!ok) selectionRect = null;
        redraw(); return;
      }
      if (currentPoints.length < 2) { currentPoints = []; return; }
      const shape = tool.name === 'shape' ? recognizeShape(currentPoints) : null;
      const stroke = {
        id: `str_${Math.random().toString(16).slice(2)}${Date.now().toString(16)}`,
        tool: tool.name === 'shape' ? 'pen' : tool.name,
        color: tool.color, size: tool.size, points: currentPoints,
        shape: shape || undefined, createdAt: new Date().toISOString()
      };
      page().strokes.push(stroke);
      undoStack.push({ kind: 'stroke', pageId: pageId(), stroke });
      redoStack.length = 0;
      updateUndoButtons();
      currentPoints = [];
      redraw();
      send({ type: shape ? 'stroke:shape' : 'stroke:add', pageId: pageId(), stroke });
    };
    canvas.addEventListener('pointerup', finish);
    canvas.addEventListener('pointercancel', finish);

    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const r = canvas.getBoundingClientRect();
      const sx = e.clientX - r.left, sy = e.clientY - r.top;
      const before = screenToWorld(sx, sy);
      const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
      view.scale = Math.min(5, Math.max(0.2, view.scale * factor));
      const after = screenToWorld(sx, sy);
      view.x += (after.x - before.x) * view.scale;
      view.y += (after.y - before.y) * view.scale;
      updateZoomLabel(); redraw(); positionObjects();
    }, { passive: false });

    window.addEventListener('keydown', (e) => {
      if (e.code === 'Space' && !e.repeat) { spaceHeld = true; canvas.style.cursor = 'grab'; }
      const meta = e.ctrlKey || e.metaKey;
      if (meta && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) doRedo(); else doUndo(); }
    });
    window.addEventListener('keyup', (e) => {
      if (e.code === 'Space') { spaceHeld = false; canvas.style.cursor = isOwner ? 'crosshair' : 'default'; }
    });
  }

  // ---- Undo / redo --------------------------------------------------------
  function doUndo() {
    if (!isOwner) return;
    const op = undoStack.pop();
    if (!op) return;
    const p = board.pages.find((x) => x.id === op.pageId);
    if (!p) return;
    if (op.kind === 'stroke') {
      p.strokes = p.strokes.filter((s) => s.id !== op.stroke.id);
      send({ type: 'stroke:remove', pageId: op.pageId, strokeId: op.stroke.id });
    } else if (op.kind === 'object') {
      p.objects = p.objects.filter((o) => o.id !== op.object.id);
      send({ type: 'object:remove', pageId: op.pageId, objectId: op.object.id });
    }
    redoStack.push(op);
    updateUndoButtons(); redraw();
  }
  function doRedo() {
    if (!isOwner) return;
    const op = redoStack.pop();
    if (!op) return;
    const p = board.pages.find((x) => x.id === op.pageId);
    if (!p) return;
    if (op.kind === 'stroke') { p.strokes.push(op.stroke); send({ type: 'stroke:add', pageId: op.pageId, stroke: op.stroke }); }
    else if (op.kind === 'object') { p.objects.push(op.object); send({ type: 'object:add', pageId: op.pageId, object: op.object }); }
    undoStack.push(op);
    updateUndoButtons(); redraw();
  }
  function updateUndoButtons() {
    const u = $('#undoBtn'), r = $('#redoBtn');
    if (u) u.disabled = !undoStack.length;
    if (r) r.disabled = !redoStack.length;
  }

  // ---- Objects ------------------------------------------------------------
  function createTextObject(kind, w) {
    const text = window.prompt(kind === 'note' ? 'Sticky note text:' : 'Text:');
    if (!text) return;
    const obj = {
      id: `obj_${Math.random().toString(16).slice(2)}`,
      type: kind, x: w.x, y: w.y,
      w: kind === 'note' ? 190 : 360,
      h: kind === 'note' ? 130 : 40,
      text, color: kind === 'note' ? '#ffcc66' : tool.color
    };
    addObject(obj);
  }
  function addObject(obj) {
    page().objects.push(obj);
    undoStack.push({ kind: 'object', pageId: pageId(), object: obj });
    redoStack.length = 0;
    updateUndoButtons(); redraw();
    send({ type: 'object:add', pageId: pageId(), object: obj });
  }
  // Objects render on the canvas so they survive zoom and export cleanly;
  // this hook stays for future DOM-based editing affordances.
  function positionObjects() {}

  // ---- Laser --------------------------------------------------------------
  function drawLaser(w) {
    const dpr = window.devicePixelRatio || 1;
    const rect = laserCanvas.getBoundingClientRect();
    lctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    lctx.clearRect(0, 0, rect.width, rect.height);
    if (!w) return;
    const s = worldToScreen(w.x, w.y);
    const g = lctx.createRadialGradient(s.x, s.y, 0, s.x, s.y, 18);
    g.addColorStop(0, 'rgba(255,80,90,0.95)');
    g.addColorStop(1, 'rgba(255,80,90,0)');
    lctx.fillStyle = g;
    lctx.beginPath(); lctx.arc(s.x, s.y, 18, 0, Math.PI * 2); lctx.fill();
  }
  function clearLaser() {
    const dpr = window.devicePixelRatio || 1;
    const rect = laserCanvas.getBoundingClientRect();
    lctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    lctx.clearRect(0, 0, rect.width, rect.height);
  }
  function sendLaser(w, active) {
    send({ type: 'laser', x: w ? w.x : 0, y: w ? w.y : 0, pageIndex, active });
  }

  // ---- Reactions ----------------------------------------------------------
  function flyEmoji(emoji) {
    const layer = $('#reactionsLayer');
    const el = document.createElement('div');
    el.className = 'flying-emoji';
    el.textContent = emoji;
    el.style.left = `${10 + Math.random() * 80}%`;
    el.style.bottom = '0px';
    layer.appendChild(el);
    setTimeout(() => el.remove(), 3000);
  }

  // ---- Info panel ---------------------------------------------------------
  const PANEL_KEY = 'athena.board.panelCollapsed';
  function applyPanelState() {
    const collapsed = localStorage.getItem(PANEL_KEY) === '1';
    $('#infoPanel').classList.toggle('collapsed', collapsed);
  }
  function togglePanel() {
    const el = $('#infoPanel');
    const collapsed = !el.classList.contains('collapsed');
    el.classList.toggle('collapsed', collapsed);
    localStorage.setItem(PANEL_KEY, collapsed ? '1' : '0');
    setTimeout(resizeCanvas, 200);
  }

  function renderInsight(a, opts = {}) {
    const body = $('#infoBody');
    const card = document.createElement('div');
    card.className = 'insight-card';
    const steps = Array.isArray(a.steps) ? a.steps : [];
    const facts = Array.isArray(a.facts) ? a.facts : [];
    const formulas = Array.isArray(a.formulas) ? a.formulas : [];
    const warnings = Array.isArray(a.warnings) ? a.warnings : [];
    const plots = Array.isArray(a.plots) ? a.plots : [];

    card.innerHTML = `
      <span class="insight-kind">${escapeHtml(a.kind || 'info')}</span>
      ${a.title ? `<h4>${escapeHtml(a.title)}</h4>` : ''}
      ${a.summary ? `<p>${escapeHtml(a.summary)}</p>` : ''}
      ${a.method ? `<div class="insight-method">Method: ${escapeHtml(a.method)}</div>` : ''}
      ${a.answer ? `<div class="insight-answer">${escapeHtml(a.answer)}</div>` : ''}
      ${steps.length ? `<ol class="insight-steps">${steps.map((s) => `<li>${escapeHtml(s.step || '')}${s.why ? `<span class="why">${escapeHtml(s.why)}</span>` : ''}</li>`).join('')}</ol>` : ''}
      ${facts.length ? `<div class="insight-facts">${facts.map((f) => `<div class="insight-fact"><span>${escapeHtml(f.label || '')}</span><span>${escapeHtml(f.value || '')}</span></div>`).join('')}</div>` : ''}
      ${formulas.length ? formulas.map((f) => `<div class="insight-formula">${escapeHtml(f)}</div>`).join('') : ''}
      ${warnings.length ? warnings.map((w) => `<div class="insight-warn">⚠ ${escapeHtml(w)}</div>`).join('') : ''}
      <div class="insight-actions"></div>
    `;
    const actions = card.querySelector('.insight-actions');
    if (isOwner && !opts.fromTeacher) {
      const push = document.createElement('button');
      push.className = 'btn soft small';
      push.textContent = 'Push to students';
      push.addEventListener('click', () => { send({ type: 'insight:push', analysis: a }); setStatus('Shared with the room.', 'success'); });
      actions.appendChild(push);
      plots.forEach((expr) => {
        const b = document.createElement('button');
        b.className = 'btn soft small';
        b.textContent = `Plot ${expr}`;
        b.addEventListener('click', () => plotOnBoard(expr));
        actions.appendChild(b);
      });
    }
    const empty = body.querySelector('.info-empty');
    if (empty) empty.remove();
    body.prepend(card);
    $('#infoPanel').classList.remove('collapsed');
    localStorage.setItem(PANEL_KEY, '0');
    setTimeout(resizeCanvas, 200);
  }

  async function analyzeBoard() {
    if (!isOwner) return;
    const btn = $('#analyzeBtn');
    btn.disabled = true; const label = btn.textContent; btn.textContent = 'Analyzing…';
    try {
      const snapshot = snapshotPage(pageIndex);
      const data = await api(`/api/board/${boardIdValue}/analyze`, { method: 'POST', body: JSON.stringify({ snapshot }) });
      lastAnalysis = data.analysis;
      renderInsight(data.analysis);
    } catch (error) {
      setStatus(error.message, 'error');
    } finally {
      btn.disabled = false; btn.textContent = label;
    }
  }

  // ---- Plot on the board --------------------------------------------------
  function plotOnBoard(expression, atRect) {
    try { compileExpression(expression); }
    catch (error) { setStatus(`Cannot plot: ${error.message}`, 'error'); return; }
    const b = visibleWorldBounds();
    const w = 320, h = 200;
    const pos = atRect
      ? { x: Math.max(atRect.x1, atRect.x2) + 20, y: Math.min(atRect.y1, atRect.y2) }
      : { x: b.x1 + (b.x2 - b.x1) / 2 - w / 2, y: b.y1 + (b.y2 - b.y1) / 2 - h / 2 };
    addObject({ id: `obj_${Math.random().toString(16).slice(2)}`, type: 'graph', x: pos.x, y: pos.y, w, h, expression });
  }

  // ---- Snapshots / export -------------------------------------------------
  // Renders a page to an offscreen canvas at fixed size, independent of the
  // current pan/zoom, so exports and AI snapshots always capture the whole
  // page rather than whatever happens to be on screen.
  function snapshotPage(index, width = 1600, height = 1000) {
    const p = board.pages[index];
    const off = document.createElement('canvas');
    off.width = width; off.height = height;
    const c = off.getContext('2d');
    c.fillStyle = '#0a1526';
    c.fillRect(0, 0, width, height);

    const all = [...p.strokes.flatMap((s) => s.points || []), ...p.objects.map((o) => ({ x: o.x, y: o.y })), ...p.objects.map((o) => ({ x: o.x + (o.w || 0), y: o.y + (o.h || 0) }))];
    let minX = 0, minY = 0, maxX = width, maxY = height;
    if (all.length) {
      minX = Math.min(...all.map((q) => q.x)); maxX = Math.max(...all.map((q) => q.x));
      minY = Math.min(...all.map((q) => q.y)); maxY = Math.max(...all.map((q) => q.y));
      const pad = 60;
      minX -= pad; minY -= pad; maxX += pad; maxY += pad;
    }
    const sw = Math.max(1, maxX - minX), sh = Math.max(1, maxY - minY);
    const scale = Math.min(width / sw, height / sh);
    c.translate((width - sw * scale) / 2, (height - sh * scale) / 2);
    c.scale(scale, scale);
    c.translate(-minX, -minY);

    p.strokes.forEach((s) => drawStrokeOn(c, s));
    p.objects.forEach((o) => drawObjectOn(c, o));
    void scale;
    return off.toDataURL('image/png');
  }

  function drawStrokeOn(c, stroke) {
    if (!stroke.points || !stroke.points.length) return;
    c.save();
    c.globalCompositeOperation = stroke.tool === 'eraser' ? 'destination-out' : 'source-over';
    c.strokeStyle = stroke.tool === 'eraser' ? 'rgba(0,0,0,1)' : (stroke.color || '#eef6ff');
    c.lineWidth = stroke.size || 3; c.lineCap = 'round'; c.lineJoin = 'round';
    if (stroke.shape) {
      const sh = stroke.shape;
      c.beginPath();
      if (sh.type === 'circle') c.arc(sh.cx, sh.cy, sh.r, 0, Math.PI * 2);
      else if (sh.type === 'rectangle') c.rect(sh.x, sh.y, sh.w, sh.h);
      else if (sh.type === 'triangle') { c.moveTo(sh.points[0].x, sh.points[0].y); c.lineTo(sh.points[1].x, sh.points[1].y); c.lineTo(sh.points[2].x, sh.points[2].y); c.closePath(); }
      else if (sh.type === 'line') { c.moveTo(sh.points[0].x, sh.points[0].y); c.lineTo(sh.points[1].x, sh.points[1].y); }
      c.stroke();
    } else {
      c.beginPath();
      stroke.points.forEach((pt, i) => (i ? c.lineTo(pt.x, pt.y) : c.moveTo(pt.x, pt.y)));
      c.stroke();
    }
    c.restore();
  }

  function drawObjectOn(c, obj) {
    c.save();
    if (obj.type === 'note') {
      c.fillStyle = obj.color || '#ffcc66';
      c.beginPath(); c.roundRect(obj.x, obj.y, obj.w, obj.h, 10); c.fill();
      c.fillStyle = '#1b1403'; c.font = '600 15px Inter, sans-serif';
      wrapText(c, obj.text, obj.x + 12, obj.y + 26, obj.w - 24, 19);
    } else if (obj.type === 'text') {
      c.fillStyle = obj.color || '#eef6ff'; c.font = '700 20px Inter, sans-serif';
      wrapText(c, obj.text, obj.x, obj.y + 20, obj.w || 360, 25);
    } else if (obj.type === 'graph') {
      c.fillStyle = 'rgba(255,255,255,0.06)';
      c.beginPath(); c.roundRect(obj.x, obj.y, obj.w, obj.h, 10); c.fill();
      c.fillStyle = '#14d9c4'; c.font = '600 14px Inter, sans-serif';
      c.fillText(obj.expression || '', obj.x + 10, obj.y + 20);
    }
    c.restore();
  }

  async function exportPdf() {
    const jsPDFCtor = window.jspdf && window.jspdf.jsPDF;
    if (!jsPDFCtor) { setStatus('PDF library did not load — check your connection.', 'error'); return; }
    setStatus('Building PDF…', '');
    const pdf = new jsPDFCtor({ orientation: 'landscape', unit: 'pt', format: [1600, 1000] });
    board.pages.forEach((p, i) => {
      const img = snapshotPage(i);
      if (i) pdf.addPage([1600, 1000], 'landscape');
      pdf.addImage(img, 'PNG', 0, 0, 1600, 1000);
    });
    pdf.save(`${(board.title || 'whiteboard').replace(/[^\w\-]+/g, '-')}.pdf`);
    setStatus('PDF downloaded.', 'success');
  }

  async function toStudySet() {
    if (!confirm(`Turn all ${board.pages.length} page(s) into a study set?`)) return;
    const btn = $('#studySetBtn');
    btn.disabled = true; const label = btn.textContent; btn.textContent = 'Reading…';
    try {
      const snapshots = board.pages.map((_, i) => snapshotPage(i));
      const data = await api(`/api/board/${boardIdValue}/to-study-set`, {
        method: 'POST', body: JSON.stringify({ snapshots, format: 'mixed', cardCount: 10 })
      });
      setStatus('Study set created.', 'success');
      setTimeout(() => { window.location.href = `/app?set=${data.set.id}`; }, 900);
    } catch (error) {
      setStatus(error.message, 'error');
    } finally { btn.disabled = false; btn.textContent = label; }
  }

  // ---- Replay -------------------------------------------------------------
  function openReplay() {
    replay.active = true;
    replay.index = page().strokes.length;
    $('#replayBar').style.display = 'flex';
    $('#replayOpenBtn').style.display = 'none';
    const range = $('#replayRange');
    range.max = String(page().strokes.length);
    range.value = String(replay.index);
    updateReplayLabel(); redraw();
  }
  function closeReplay() {
    replay.active = false;
    clearInterval(replay.timer); replay.timer = null;
    $('#replayBar').style.display = 'none';
    $('#replayOpenBtn').style.display = '';
    redraw();
  }
  function updateReplayLabel() { $('#replayLabel').textContent = `${replay.index} / ${page().strokes.length}`; }
  function replayPlay() {
    if (replay.timer) { clearInterval(replay.timer); replay.timer = null; $('#replayPlayBtn').textContent = '▶'; return; }
    if (replay.index >= page().strokes.length) replay.index = 0;
    $('#replayPlayBtn').textContent = '⏸';
    replay.timer = setInterval(() => {
      replay.index += 1;
      if (replay.index >= page().strokes.length) { replay.index = page().strokes.length; clearInterval(replay.timer); replay.timer = null; $('#replayPlayBtn').textContent = '▶'; }
      $('#replayRange').value = String(replay.index);
      updateReplayLabel(); redraw();
    }, 90);
  }

  // ---- Pages --------------------------------------------------------------
  function updatePageBar() {
    $('#pageLabel').textContent = `Page ${pageIndex + 1} / ${board.pages.length}`;
    $('#templateSelect').value = page().template || 'blank';
    $$('.owner-only').forEach((el) => { el.style.display = isOwner ? '' : 'none'; });
  }
  function gotoPage(i, broadcastMove = true) {
    pageIndex = Math.max(0, Math.min(board.pages.length - 1, i));
    selectionRect = null;
    $('#plotSelectionBtn').style.display = 'none';
    if (replay.active) closeReplay();
    updatePageBar(); redraw();
    if (isOwner && broadcastMove) send({ type: 'page:goto', pageIndex });
  }
  function updateZoomLabel() { $('#zoomLabel').textContent = `${Math.round(view.scale * 100)}%`; }

  // ---- WebSocket ----------------------------------------------------------
  function send(payload) { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload)); }
  function setPill(text, kind) { const p = $('#boardStatus'); p.textContent = text; p.className = `board-status${kind ? ` ${kind}` : ''}`; }

  function connect() {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${proto}//${window.location.host}/ws/board?boardId=${encodeURIComponent(boardIdValue)}`);
    ws.addEventListener('open', () => setPill('Live', 'live'));
    ws.addEventListener('close', () => { setPill('Reconnecting…', 'error'); clearTimeout(reconnectTimer); reconnectTimer = setTimeout(connect, 1500); });
    ws.addEventListener('error', () => setPill('Connection error', 'error'));

    ws.addEventListener('message', (event) => {
      let m; try { m = JSON.parse(event.data); } catch { return; }
      const pageFor = (id) => board.pages.find((p) => p.id === id) || board.pages[pageIndex];

      if (m.type === 'sync') {
        board = m.board; isOwner = m.isOwner;
        if (pageIndex >= board.pages.length) pageIndex = 0;
        applyRole(); updatePageBar(); redraw();
        return;
      }
      if (m.type === 'stroke:add' || m.type === 'stroke:shape') { pageFor(m.pageId).strokes.push(m.stroke); redraw(); return; }
      if (m.type === 'stroke:remove') { const p = pageFor(m.pageId); p.strokes = p.strokes.filter((s) => s.id !== m.strokeId); redraw(); return; }
      if (m.type === 'object:add') {
        const p = pageFor(m.pageId);
        const i = p.objects.findIndex((o) => o.id === m.object.id);
        if (i >= 0) p.objects[i] = m.object; else p.objects.push(m.object);
        redraw(); return;
      }
      if (m.type === 'object:remove') { const p = pageFor(m.pageId); p.objects = p.objects.filter((o) => o.id !== m.objectId); redraw(); return; }
      if (m.type === 'page:clear') { const p = pageFor(m.pageId); p.strokes = []; p.objects = []; redraw(); return; }
      if (m.type === 'page:goto') { if (!isOwner) gotoPage(m.pageIndex, false); return; }
      if (m.type === 'laser') { if (m.active) drawLaser({ x: m.x, y: m.y }); else clearLaser(); return; }
      if (m.type === 'reaction') { flyEmoji(m.emoji); return; }
      if (m.type === 'lost:count') {
        const pill = $('#lostPill');
        if (isOwner) { pill.style.display = m.count > 0 ? '' : 'none'; $('#lostCount').textContent = m.count; }
        return;
      }
      if (m.type === 'lost:self') { $('#lostBtn').classList.toggle('active', m.lost); return; }
      if (m.type === 'insight') { renderInsight(m.analysis, { fromTeacher: true }); return; }
      if (m.type === 'presence') { updateViewers(m.viewers || []); return; }
      if (m.type === 'equation:read') { if (isOwner) plotOnBoard(m.expression, m.rect); return; }
      if (m.type === 'ai:result') { if (m.note && m.note.result) renderInsight({ kind: 'explain', summary: m.note.result }); return; }
      if (m.type === 'error') setStatus(m.message, 'error');
    });
  }

  function updateViewers(viewers) {
    $('#viewerCount').textContent = viewers.length;
    const body = $('#viewersPanelBody');
    body.innerHTML = viewers.length
      ? viewers.map((v) => `<div class="viewer-row"><span class="viewer-dot"></span>${escapeHtml(v.name)}</div>`).join('')
      : '<p class="info-empty">No one watching yet.</p>';
  }

  // ---- Role / chrome ------------------------------------------------------
  function applyRole() {
    $('#boardToolbar').style.display = isOwner ? '' : 'none';
    $('#ownerActions').style.display = isOwner ? 'flex' : 'none';
    $('#readonlyBanner').style.display = isOwner ? 'none' : '';
    $('#studentBar').style.display = isOwner ? 'none' : 'flex';
    $('#replayOpenBtn').style.display = isOwner ? '' : 'none';
    canvas.style.cursor = isOwner ? 'crosshair' : 'default';
    updateBadge();
  }
  function updateBadge() {
    const b = $('#boardBadge');
    if (!isOwner || !board) { b.style.display = 'none'; return; }
    b.style.display = '';
    if (board.isLive) { b.textContent = 'Live'; b.className = 'board-badge is-live'; }
    else if (board.shared) { b.textContent = 'Shared'; b.className = 'board-badge is-shared'; }
    else { b.textContent = 'Private'; b.className = 'board-badge'; }
    $('#shareToggleBtn').textContent = board.shared ? 'Unshare' : 'Share';
    $('#liveToggleBtn').textContent = board.isLive ? 'Stop live' : 'Go live';
  }

  // ---- Bindings -----------------------------------------------------------
  function bindUI() {
    $$('.tool-btn').forEach((b) => b.addEventListener('click', () => {
      tool.name = b.dataset.tool;
      $$('.tool-btn').forEach((x) => x.classList.toggle('active', x === b));
      if (tool.name !== 'select') { selectionRect = null; $('#plotSelectionBtn').style.display = 'none'; redraw(); }
    }));
    $$('.swatch').forEach((b) => b.addEventListener('click', () => {
      tool.color = b.dataset.color;
      $$('.swatch').forEach((x) => x.classList.toggle('active', x === b));
    }));
    $('#sizeRange').addEventListener('input', (e) => { tool.size = Number(e.target.value); });

    $('#undoBtn').addEventListener('click', doUndo);
    $('#redoBtn').addEventListener('click', doRedo);
    $('#panelToggle').addEventListener('click', togglePanel);
    $('#infoClose').addEventListener('click', togglePanel);
    $('#analyzeBtn').addEventListener('click', analyzeBoard);
    $('#exportBtn').addEventListener('click', exportPdf);
    $('#studySetBtn').addEventListener('click', toStudySet);
    $('#zoomResetBtn').addEventListener('click', () => { view.x = 0; view.y = 0; view.scale = 1; updateZoomLabel(); redraw(); });

    $('#clearBoardBtn').addEventListener('click', () => {
      if (!confirm('Clear this page for everyone?')) return;
      page().strokes = []; page().objects = [];
      redraw(); send({ type: 'page:clear', pageId: pageId() });
    });

    $('#fullscreenBtn').addEventListener('click', () => {
      if (!document.fullscreenElement) $('#boardShell').requestFullscreen?.().catch(() => {});
      else document.exitFullscreen?.();
    });

    $('#prevPageBtn').addEventListener('click', () => gotoPage(pageIndex - 1));
    $('#nextPageBtn').addEventListener('click', () => gotoPage(pageIndex + 1));
    $('#addPageBtn').addEventListener('click', async () => {
      try {
        const data = await api(`/api/board/${boardIdValue}/pages`, { method: 'POST', body: JSON.stringify({ template: page().template }) });
        board.pages.push({ ...data.page });
        gotoPage(board.pages.length - 1);
      } catch (e) { setStatus(e.message, 'error'); }
    });
    $('#delPageBtn').addEventListener('click', async () => {
      if (board.pages.length <= 1) return setStatus('A board needs at least one page.', 'error');
      if (!confirm('Delete this page?')) return;
      try {
        await api(`/api/board/${boardIdValue}/pages/${pageId()}`, { method: 'DELETE' });
        board.pages.splice(pageIndex, 1);
        gotoPage(Math.max(0, pageIndex - 1));
      } catch (e) { setStatus(e.message, 'error'); }
    });

    $('#templateSelect').addEventListener('change', async (e) => {
      page().template = e.target.value;
      redraw();
      try { await api(`/api/board/${boardIdValue}/pages/${pageId()}`, { method: 'PATCH', body: JSON.stringify({ template: e.target.value }) }); }
      catch (err) { setStatus(err.message, 'error'); }
    });

    $('#bgImportBtn').addEventListener('click', () => $('#bgFile').click());
    $('#bgFile').addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = async () => {
        try {
          await api(`/api/board/${boardIdValue}/pages/${pageId()}`, { method: 'PATCH', body: JSON.stringify({ background: reader.result }) });
          page().background = reader.result;
          bgCache.delete(pageId());
          redraw();
          setStatus('Background added.', 'success');
        } catch (err) { setStatus(err.message, 'error'); }
      };
      reader.readAsDataURL(file);
      e.target.value = '';
    });
    $('#bgClearBtn').addEventListener('click', async () => {
      try {
        await api(`/api/board/${boardIdValue}/pages/${pageId()}`, { method: 'PATCH', body: JSON.stringify({ background: null }) });
        page().background = null; bgCache.delete(pageId()); redraw();
      } catch (err) { setStatus(err.message, 'error'); }
    });

    $('#plotForm').addEventListener('submit', (e) => {
      e.preventDefault();
      const expr = $('#plotInput').value.trim();
      if (!expr) return;
      plotOnBoard(expr);
      $('#plotInput').value = '';
    });
    $('#plotSelectionBtn').addEventListener('click', () => {
      if (!selectionRect) return;
      const snapshot = cropSelection();
      send({ type: 'ai:read-equation', snapshot, rect: { ...selectionRect }, pageId: pageId() });
      setStatus('Reading the selected equation…', '');
      selectionRect = null;
      $('#plotSelectionBtn').style.display = 'none';
      redraw();
    });

    $('#replayOpenBtn').addEventListener('click', openReplay);
    $('#replayCloseBtn').addEventListener('click', closeReplay);
    $('#replayPlayBtn').addEventListener('click', replayPlay);
    $('#replayRange').addEventListener('input', (e) => { replay.index = Number(e.target.value); updateReplayLabel(); redraw(); });

    $('#viewersBtn').addEventListener('click', () => {
      const p = $('#viewersPanel');
      p.style.display = p.style.display === 'none' ? 'flex' : 'none';
    });
    $('#viewersPanelClose').addEventListener('click', () => { $('#viewersPanel').style.display = 'none'; });

    $$('.react-btn').forEach((b) => b.addEventListener('click', () => {
      send({ type: 'reaction', emoji: b.dataset.emoji });
      flyEmoji(b.dataset.emoji);
    }));
    $('#lostBtn').addEventListener('click', () => send({ type: 'lost:toggle' }));

    $('#shareToggleBtn').addEventListener('click', async () => {
      try {
        const d = await api(`/api/board/${boardIdValue}/share-toggle`, { method: 'POST', body: JSON.stringify({ shared: !board.shared }) });
        board.shared = d.board.shared; updateBadge();
      } catch (e) { setStatus(e.message, 'error'); }
    });
    $('#liveToggleBtn').addEventListener('click', async () => {
      try {
        const d = await api(`/api/board/${boardIdValue}/${board.isLive ? 'stop-live' : 'go-live'}`, { method: 'POST', body: JSON.stringify({}) });
        board.isLive = d.board.isLive; board.shared = d.board.shared; updateBadge();
        setStatus(board.isLive ? 'You are live.' : 'Stopped broadcasting.', 'success');
      } catch (e) { setStatus(e.message, 'error'); }
    });
  }

  function cropSelection() {
    const { x1, y1, x2, y2 } = selectionRect;
    const w = Math.abs(x2 - x1), h = Math.abs(y2 - y1);
    const off = document.createElement('canvas');
    off.width = Math.max(40, Math.round(w)); off.height = Math.max(40, Math.round(h));
    const c = off.getContext('2d');
    c.fillStyle = '#0a1526'; c.fillRect(0, 0, off.width, off.height);
    c.translate(-Math.min(x1, x2), -Math.min(y1, y2));
    page().strokes.forEach((s) => drawStrokeOn(c, s));
    return off.toDataURL('image/png');
  }

  // ---- Boot ---------------------------------------------------------------
  async function init() {
    await refreshMe();
    try {
      const data = await api(`/api/board/${boardIdValue}`);
      board = data.board; isOwner = Boolean(data.isOwner);
      $('#boardTitle').textContent = isOwner ? board.title : `${data.teacher.name}'s whiteboard`;
    } catch (error) {
      setStatus(error.message, 'error');
      $('#boardTitle').textContent = 'Whiteboard unavailable';
      setPill('Unavailable', 'error');
      return;
    }
    applyPanelState();
    applyRole();
    bindUI();
    bindPointer();
    updatePageBar();
    updateZoomLabel();
    updateUndoButtons();
    resizeCanvas();
    connect();
  }

  init();
})();
