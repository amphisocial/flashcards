/*
 * Landing-page 3D demos. Mounts live viz3d viewers into the hero and the
 * "3D Science" grid. Kept lightweight: viewers only mount when scrolled into
 * view, and are capped so a marketing page never runs many WebGL contexts.
 */
(function () {
  if (typeof window.AthenaViz3D === 'undefined') return;

  // Acetic acid CH3COOH with explicit 3D coordinates (angstrom-ish), so the
  // molecule demo shows the real structure rather than a fallback.
  const ACETIC_ACID = {
    kind: 'molecule', name: 'acetic acid', formula: 'CH3COOH',
    atoms: [
      { el: 'C', x: -0.86, y: 0.00, z: 0.00 },   // methyl carbon
      { el: 'H', x: -1.24, y: 1.02, z: 0.00 },
      { el: 'H', x: -1.24, y: -0.51, z: 0.89 },
      { el: 'H', x: -1.24, y: -0.51, z: -0.89 },
      { el: 'C', x: 0.66, y: 0.00, z: 0.00 },    // carbonyl carbon
      { el: 'O', x: 1.29, y: 1.05, z: 0.00 },    // carbonyl O (double bond)
      { el: 'O', x: 1.31, y: -1.16, z: 0.00 },   // hydroxyl O
      { el: 'H', x: 2.27, y: -1.06, z: 0.00 }
    ],
    bonds: [
      [0, 1, 1], [0, 2, 1], [0, 3, 1], [0, 4, 1],
      [4, 5, 2], [4, 6, 1], [6, 7, 1]
    ]
  };

  const specFor = (kind) => {
    if (kind === 'molecule') return ACETIC_ACID;
    if (kind === 'solid') return { kind: 'solid', shape: 'cube', dims: { a: 2 }, label: 'Cube' };
    return { kind: 'earth' };
  };

  const mounted = new WeakSet();
  const handles = [];

  function mountInto(elm) {
    if (mounted.has(elm)) return;
    mounted.add(elm);
    try {
      const h = window.AthenaViz3D.mount(elm, specFor(elm.dataset.demo));
      handles.push(h);
      // Cap live viewers; dispose oldest beyond 4 to stay light.
      while (handles.length > 4) { const old = handles.shift(); try { old.dispose(); } catch (_) {} }
    } catch (_) { /* a demo failing shouldn't break the page */ }
  }

  function init() {
    const holders = Array.from(document.querySelectorAll('.demo3d-holder'));
    if (!holders.length) return;
    // Mount the hero one immediately; lazy-mount the rest on scroll.
    const hero = document.getElementById('heroEarth');
    if (hero) mountInto(hero);

    if ('IntersectionObserver' in window) {
      const io = new IntersectionObserver((entries) => {
        entries.forEach((e) => { if (e.isIntersecting) { mountInto(e.target); io.unobserve(e.target); } });
      }, { rootMargin: '120px' });
      holders.forEach((h) => { if (h !== hero) io.observe(h); });
    } else {
      holders.forEach(mountInto);
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
