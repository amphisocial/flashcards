/*
 * lesson.js — powers the Chalkie-style concept landing pages under
 * public/lessons/. Three jobs:
 *   1. Mount the live embedded demo (reusing viz3d.js — the same engine the
 *      board and homepage use).
 *   2. Wire "Try this lesson free": signed-in teachers go straight to a board;
 *      everyone else gets the signup dialog.
 *   3. Keep the shared auth/header state working via AppCommon.
 */
(async () => {
  const C = window.AppCommon || {};
  const { state, openAuth, initCommon } = C;

  // --- Demo mount -------------------------------------------------------
  function mountDemo() {
    const el = document.getElementById('lessonDemo');
    if (!el || typeof window.AthenaViz3D === 'undefined') return;
    const kind = el.dataset.demo;

    // Graphs use the dedicated 2D widget, not viz3d — a visitor can drag the
    // real sliders on the page before ever signing up.
    if (kind === 'graph') {
      if (typeof window.AthenaGraphDemo === 'undefined') return;
      try {
        window.AthenaGraphDemo.mount(el, { family: el.dataset.family || 'parabola' });
      } catch (_) { /* never break the page */ }
      return;
    }

    let spec;
    if (kind === 'physics') {
      // The concept pages pass the sim name in data-sim; viz3d expects `type`.
      spec = { kind: 'physics', type: el.dataset.sim || 'freefall' };
    } else if (kind === 'molecule') {
      spec = {
        kind: 'molecule', name: 'acetic acid', formula: 'CH3COOH',
        atoms: [
          { el: 'C', x: -0.86, y: 0, z: 0 }, { el: 'H', x: -1.24, y: 1.02, z: 0 },
          { el: 'H', x: -1.24, y: -0.51, z: 0.89 }, { el: 'H', x: -1.24, y: -0.51, z: -0.89 },
          { el: 'C', x: 0.66, y: 0, z: 0 }, { el: 'O', x: 1.29, y: 1.05, z: 0 },
          { el: 'O', x: 1.31, y: -1.16, z: 0 }, { el: 'H', x: 2.27, y: -1.06, z: 0 }
        ],
        bonds: [[0,1,1],[0,2,1],[0,3,1],[0,4,1],[4,5,2],[4,6,1],[6,7,1]]
      };
    } else if (kind === 'solid') {
      spec = { kind: 'solid', shape: 'cube', dims: { a: 2 }, label: 'Cube' };
    } else {
      spec = { kind: 'earth' };
    }
    try { window.AthenaViz3D.mount(el, spec); } catch (_) { /* never break the page */ }
  }

  // --- CTA --------------------------------------------------------------
  function tryLesson() {
    if (state && state.user) {
      // Teachers with whiteboard access land on a board; others hit /board,
      // which redirects appropriately server-side.
      window.location.href = '/board';
    } else if (typeof openAuth === 'function') {
      try { sessionStorage.setItem('intent', 'lesson'); } catch (_) {}
      openAuth('signup');
    } else {
      window.location.href = '/?login=0';
    }
  }
  document.getElementById('tryLesson')?.addEventListener('click', tryLesson);
  document.getElementById('tryLesson2')?.addEventListener('click', tryLesson);

  document.getElementById('downloadOutline')?.addEventListener('click', (e) => {
    e.preventDefault();
    // The outline is on the page; print-to-PDF is the no-dependency path.
    window.print();
  });

  mountDemo();
  if (typeof initCommon === 'function') {
    try { await initCommon(); } catch (_) {}
  }
})();
