/*
 * graphdemo.js — a small, dependency-free interactive graph widget for the
 * marketing and concept-landing pages.
 *
 * Why this exists: the interactive graph (with semantic sliders) is the
 * clearest math hook AthenaBoard has, but it previously only existed inside
 * the board. An acquisition page that says "drag a, b and c and watch the
 * parabola move" needs to actually let a visitor do that before signing up.
 *
 * Deliberately NOT a general expression parser. The board has one (hardened,
 * because board expressions get broadcast to other users' browsers). Here the
 * families are defined in code, so there is no user-supplied text to evaluate
 * and no eval/Function anywhere in this file.
 *
 * Exposes: window.AthenaGraphDemo.mount(container, spec) -> { dispose() }
 *   spec = { family: 'parabola' | 'line' | 'sine', title?: string }
 */
(function () {
  'use strict';

  // --- Function families -------------------------------------------------
  // Each declares its params (with semantic labels matching the board's
  // sliders), the curve function, and how to render the live equation.
  const FAMILIES = {
    parabola: {
      title: 'y = ax² + bx + c',
      params: [
        { key: 'a', label: 'a — opens up / flips down', min: -3, max: 3, step: 0.1, value: 1 },
        { key: 'b', label: 'b — shifts the vertex sideways', min: -6, max: 6, step: 0.1, value: 0 },
        { key: 'c', label: 'c — lifts the whole curve', min: -6, max: 6, step: 0.1, value: -3 }
      ],
      fn: (x, p) => p.a * x * x + p.b * x + p.c,
      eq: (p) => `y = ${num(p.a)}x² ${sign(p.b)} ${num(Math.abs(p.b))}x ${sign(p.c)} ${num(Math.abs(p.c))}`
    },
    line: {
      title: 'y = mx + b',
      params: [
        { key: 'm', label: 'm — slope', min: -5, max: 5, step: 0.1, value: 1 },
        { key: 'b', label: 'b — y-intercept', min: -6, max: 6, step: 0.1, value: 0 }
      ],
      fn: (x, p) => p.m * x + p.b,
      eq: (p) => `y = ${num(p.m)}x ${sign(p.b)} ${num(Math.abs(p.b))}`
    },
    sine: {
      title: 'y = A·sin(Bx) + D',
      params: [
        { key: 'A', label: 'A — amplitude', min: -4, max: 4, step: 0.1, value: 2 },
        { key: 'B', label: 'B — frequency', min: 0.1, max: 3, step: 0.1, value: 1 },
        { key: 'D', label: 'D — vertical shift', min: -4, max: 4, step: 0.1, value: 0 }
      ],
      fn: (x, p) => p.A * Math.sin(p.B * x) + p.D,
      eq: (p) => `y = ${num(p.A)}·sin(${num(p.B)}x) ${sign(p.D)} ${num(Math.abs(p.D))}`
    }
  };

  function num(v) { return (Math.round(v * 10) / 10).toFixed(1).replace(/\.0$/, ''); }
  function sign(v) { return v < 0 ? '−' : '+'; }

  // --- Mount -------------------------------------------------------------
  function mount(container, spec) {
    spec = spec || {};
    const fam = FAMILIES[spec.family] || FAMILIES.parabola;

    // Current parameter values, seeded from the family defaults.
    const p = {};
    fam.params.forEach((d) => { p[d.key] = d.value; });

    container.innerHTML = '';
    container.classList.add('graphdemo');

    const canvas = document.createElement('canvas');
    canvas.className = 'graphdemo-canvas';
    container.appendChild(canvas);

    const eqBadge = document.createElement('div');
    eqBadge.className = 'graphdemo-eq';
    container.appendChild(eqBadge);

    const controls = document.createElement('div');
    controls.className = 'graphdemo-controls';
    container.appendChild(controls);

    const inputs = [];
    fam.params.forEach((d) => {
      const row = document.createElement('label');
      row.className = 'graphdemo-slider';
      const cap = document.createElement('span');
      cap.className = 'gd-label';
      cap.textContent = d.label;
      const val = document.createElement('span');
      val.className = 'gd-val';
      val.textContent = num(p[d.key]);
      const input = document.createElement('input');
      input.type = 'range';
      input.min = d.min; input.max = d.max; input.step = d.step; input.value = d.value;
      input.setAttribute('aria-label', d.label);
      input.addEventListener('input', () => {
        p[d.key] = parseFloat(input.value);
        val.textContent = num(p[d.key]);
        draw();
      });
      const head = document.createElement('span');
      head.className = 'gd-head';
      head.appendChild(cap); head.appendChild(val);
      row.appendChild(head); row.appendChild(input);
      controls.appendChild(row);
      inputs.push(input);
    });

    const ctx = canvas.getContext('2d');
    // World window: x and y ranges shown on the plot.
    const VIEW = { xMin: -8, xMax: 8, yMin: -8, yMax: 8 };

    let W = 0, H = 0;

    function resize() {
      const rect = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      W = Math.max(1, Math.round(rect.width));
      H = Math.max(1, Math.round(rect.height));
      canvas.width = W * dpr;
      canvas.height = H * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      draw();
    }

    const sx = (x) => ((x - VIEW.xMin) / (VIEW.xMax - VIEW.xMin)) * W;
    const sy = (y) => H - ((y - VIEW.yMin) / (VIEW.yMax - VIEW.yMin)) * H;

    function draw() {
      if (!W || !H) return;
      ctx.clearRect(0, 0, W, H);

      // Grid
      ctx.lineWidth = 1;
      ctx.strokeStyle = 'rgba(255,255,255,0.07)';
      ctx.beginPath();
      for (let x = Math.ceil(VIEW.xMin); x <= VIEW.xMax; x++) {
        const px = Math.round(sx(x)) + 0.5;
        ctx.moveTo(px, 0); ctx.lineTo(px, H);
      }
      for (let y = Math.ceil(VIEW.yMin); y <= VIEW.yMax; y++) {
        const py = Math.round(sy(y)) + 0.5;
        ctx.moveTo(0, py); ctx.lineTo(W, py);
      }
      ctx.stroke();

      // Axes
      ctx.strokeStyle = 'rgba(255,255,255,0.28)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(0, Math.round(sy(0)) + 0.5); ctx.lineTo(W, Math.round(sy(0)) + 0.5);
      ctx.moveTo(Math.round(sx(0)) + 0.5, 0); ctx.lineTo(Math.round(sx(0)) + 0.5, H);
      ctx.stroke();

      // Curve — sampled per pixel, with a break when the value leaves the
      // view so steep sections don't draw a vertical streak across the plot.
      ctx.strokeStyle = '#14d9c4';
      ctx.lineWidth = 3;
      ctx.lineJoin = 'round';
      ctx.beginPath();
      let drawing = false;
      for (let px = 0; px <= W; px++) {
        const x = VIEW.xMin + (px / W) * (VIEW.xMax - VIEW.xMin);
        const y = fam.fn(x, p);
        if (!isFinite(y) || y < VIEW.yMin - 50 || y > VIEW.yMax + 50) { drawing = false; continue; }
        const py = sy(y);
        if (!drawing) { ctx.moveTo(px, py); drawing = true; }
        else ctx.lineTo(px, py);
      }
      ctx.stroke();

      eqBadge.textContent = fam.eq(p);
    }

    let ro = null;
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(resize);
      ro.observe(canvas);
    } else {
      window.addEventListener('resize', resize);
    }
    // Initial layout may not have measured yet; do it on the next frame too.
    resize();
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(resize);

    return {
      // Exposed for tests + potential reuse.
      _fn: (x) => fam.fn(x, p),
      _params: p,
      dispose() {
        try { if (ro) ro.disconnect(); else window.removeEventListener('resize', resize); } catch (_) {}
        container.innerHTML = '';
        container.classList.remove('graphdemo');
      }
    };
  }

  const api = { mount, FAMILIES };
  if (typeof window !== 'undefined') window.AthenaGraphDemo = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
