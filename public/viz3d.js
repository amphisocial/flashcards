/*
 * Athena 3D viewer (v2.6)
 * -----------------------------------------------------------------------
 * Self-contained Three.js helpers that turn an Analyze result into an
 * interactive 3D object in a small canvas: geometric solids (cube, sphere,
 * cylinder, cone, pyramid, prism, tetrahedron), a rotatable textured Earth,
 * and ball-and-stick molecules. Drag to rotate; it auto-spins gently until
 * touched. No external controls lib (OrbitControls isn't in r128 core), so
 * rotation is handled with a tiny pointer handler.
 *
 * Exposes window.AthenaViz3D.mount(container, spec) -> { dispose() }.
 * spec is either { kind:'solid', shape, dims, label } or
 * { kind:'molecule', name, formula, atoms, bonds }.
 */
(function () {
  const CPK = { // standard element colours
    H: 0xffffff, C: 0x303030, N: 0x3050f8, O: 0xff2020, F: 0x90e050,
    Cl: 0x1ff01f, Br: 0xa62929, I: 0x940094, S: 0xffff30, P: 0xff8000,
    Na: 0xab5cf2, K: 0x8f40d4, Ca: 0x3dff00, Fe: 0xe06633, default: 0xdd77ff
  };
  const RADIUS = { H: 0.30, C: 0.42, N: 0.40, O: 0.40, S: 0.52, default: 0.44 };

  function makeRenderer(container, w, h) {
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(w, h);
    container.appendChild(renderer.domElement);
    return renderer;
  }

  function baseScene() {
    const scene = new THREE.Scene();
    scene.add(new THREE.AmbientLight(0xffffff, 0.75));
    const key = new THREE.DirectionalLight(0xffffff, 0.9);
    key.position.set(4, 6, 8);
    scene.add(key);
    const rim = new THREE.DirectionalLight(0x88aaff, 0.4);
    rim.position.set(-6, -3, -5);
    scene.add(rim);
    return scene;
  }

  // ---- Geometry builders --------------------------------------------------
  function solidGeometry(shape, dims = {}) {
    const a = num(dims.a, 2), b = num(dims.b, dims.a || 2), c = num(dims.c, dims.a || 2);
    const r = num(dims.r, 1.4), h = num(dims.h, 2.4);
    switch (shape) {
      case 'cube': return new THREE.BoxGeometry(a, a, a);
      case 'cuboid': case 'prism': return new THREE.BoxGeometry(a, b, c);
      case 'sphere': return new THREE.SphereGeometry(r, 48, 32);
      case 'cylinder': return new THREE.CylinderGeometry(r, r, h, 48);
      case 'cone': return new THREE.ConeGeometry(r, h, 48);
      case 'tetrahedron': return new THREE.TetrahedronGeometry(r * 1.3);
      case 'pyramid': return new THREE.ConeGeometry(r * 1.3, h, 4); // square-base pyramid
      default: return new THREE.BoxGeometry(a, a, a);
    }
  }
  function num(v, d) { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : d; }

  function mountSolid(container, spec, w, h) {
    const scene = baseScene();
    const camera = new THREE.PerspectiveCamera(45, w / h, 0.1, 100);
    camera.position.set(3.4, 2.6, 4.6);
    camera.lookAt(0, 0, 0);
    const renderer = makeRenderer(container, w, h);

    const geo = solidGeometry(spec.shape, spec.dims || {});
    geo.center();
    const mat = new THREE.MeshPhongMaterial({ color: 0x7c5cff, transparent: true, opacity: 0.75, shininess: 60, flatShading: spec.shape === 'tetrahedron' || spec.shape === 'pyramid' });
    const mesh = new THREE.Mesh(geo, mat);
    scene.add(mesh);

    // Edge overlay so points/lines/faces are clearly visible - matches the
    // "inspect points, lines and faces" idea from classroom geometry.
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo, 20), new THREE.LineBasicMaterial({ color: 0x14d9c4 }));
    scene.add(edges);
    const group = new THREE.Group();
    scene.remove(mesh); scene.remove(edges);
    group.add(mesh); group.add(edges);
    scene.add(group);

    return spinLoop(renderer, scene, camera, group, container);
  }

  function mountEarth(container, w, h) {
    const scene = baseScene();
    const camera = new THREE.PerspectiveCamera(45, w / h, 0.1, 100);
    camera.position.set(0, 0, 5.2);
    const renderer = makeRenderer(container, w, h);

    const group = new THREE.Group();
    const geo = new THREE.SphereGeometry(1.7, 64, 48);
    // Procedural earth-like texture drawn to a canvas (no external asset, so
    // it works offline and needs no CORS-enabled image host).
    const tex = new THREE.CanvasTexture(earthTextureCanvas());
    const mat = new THREE.MeshPhongMaterial({ map: tex, shininess: 12 });
    group.add(new THREE.Mesh(geo, mat));

    // Faint atmosphere halo.
    const halo = new THREE.Mesh(
      new THREE.SphereGeometry(1.78, 48, 32),
      new THREE.MeshBasicMaterial({ color: 0x3a7bd5, transparent: true, opacity: 0.16, side: THREE.BackSide })
    );
    group.add(halo);
    group.rotation.z = -0.41; // axial tilt ~23.5 deg
    scene.add(group);
    return spinLoop(renderer, scene, camera, group, container, 0.0035);
  }

  function earthTextureCanvas() {
    const c = document.createElement('canvas');
    c.width = 1024; c.height = 512;
    const g = c.getContext('2d');
    g.fillStyle = '#0d2a5c'; g.fillRect(0, 0, c.width, c.height); // ocean
    // Rough continent blobs - impressionistic, not cartographic.
    g.fillStyle = '#2e7d4f';
    const blobs = [
      [180, 150, 90, 60], [230, 210, 70, 90], [520, 140, 120, 70],
      [560, 240, 80, 110], [760, 170, 110, 80], [830, 300, 60, 70],
      [400, 380, 90, 40], [120, 330, 60, 50]
    ];
    blobs.forEach(([x, y, rx, ry]) => { g.beginPath(); g.ellipse(x, y, rx, ry, Math.random(), 0, Math.PI * 2); g.fill(); });
    // Ice caps.
    g.fillStyle = '#eef6ff';
    g.fillRect(0, 0, c.width, 26); g.fillRect(0, c.height - 26, c.width, 26);
    return c;
  }

  function mountMolecule(container, spec, w, h) {
    const scene = baseScene();
    const camera = new THREE.PerspectiveCamera(45, w / h, 0.1, 100);
    const renderer = makeRenderer(container, w, h);
    const group = new THREE.Group();

    let atoms = Array.isArray(spec.atoms) ? spec.atoms : [];
    let bonds = Array.isArray(spec.bonds) ? spec.bonds : [];
    // If the model gave a formula/SMILES but no coordinates, fall back to a
    // couple of hard-coded common molecules so the feature still shows
    // something useful rather than an empty box.
    if (!atoms.length) { const fb = fallbackMolecule(spec.formula || spec.name); atoms = fb.atoms; bonds = fb.bonds; }

    const center = atoms.reduce((acc, a) => ({ x: acc.x + (a.x || 0), y: acc.y + (a.y || 0), z: acc.z + (a.z || 0) }), { x: 0, y: 0, z: 0 });
    center.x /= (atoms.length || 1); center.y /= (atoms.length || 1); center.z /= (atoms.length || 1);

    atoms.forEach((at) => {
      const el = normalizeEl(at.el);
      const sph = new THREE.Mesh(
        new THREE.SphereGeometry((RADIUS[el] || RADIUS.default), 28, 20),
        new THREE.MeshPhongMaterial({ color: CPK[el] || CPK.default, shininess: 80 })
      );
      sph.position.set((at.x || 0) - center.x, (at.y || 0) - center.y, (at.z || 0) - center.z);
      group.add(sph);
    });

    bonds.forEach((bd) => {
      const i = bd[0], j = bd[1];
      if (!atoms[i] || !atoms[j]) return;
      const p1 = new THREE.Vector3((atoms[i].x || 0) - center.x, (atoms[i].y || 0) - center.y, (atoms[i].z || 0) - center.z);
      const p2 = new THREE.Vector3((atoms[j].x || 0) - center.x, (atoms[j].y || 0) - center.y, (atoms[j].z || 0) - center.z);
      group.add(bondCylinder(p1, p2));
    });

    scene.add(group);
    // Frame the molecule.
    const box = new THREE.Box3().setFromObject(group);
    const size = box.getSize(new THREE.Vector3()).length() || 4;
    camera.position.set(0, 0, size * 1.4 + 2);
    camera.lookAt(0, 0, 0);
    return spinLoop(renderer, scene, camera, group, container, 0.004);
  }

  function bondCylinder(p1, p2) {
    const dir = new THREE.Vector3().subVectors(p2, p1);
    const len = dir.length();
    const geo = new THREE.CylinderGeometry(0.09, 0.09, len, 12);
    const mat = new THREE.MeshPhongMaterial({ color: 0xcccccc });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.copy(p1).add(dir.clone().multiplyScalar(0.5));
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize());
    return mesh;
  }

  function normalizeEl(el) {
    const s = String(el || 'C').trim();
    return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
  }

  // A tiny library so common molecules render even without model coords.
  function fallbackMolecule(key) {
    const k = String(key || '').toLowerCase();
    if (k.includes('h2o') || k.includes('water')) return {
      atoms: [{ el: 'O', x: 0, y: 0, z: 0 }, { el: 'H', x: 0.76, y: 0.59, z: 0 }, { el: 'H', x: -0.76, y: 0.59, z: 0 }],
      bonds: [[0, 1, 1], [0, 2, 1]]
    };
    if (k.includes('co2')) return {
      atoms: [{ el: 'C', x: 0, y: 0, z: 0 }, { el: 'O', x: 1.16, y: 0, z: 0 }, { el: 'O', x: -1.16, y: 0, z: 0 }],
      bonds: [[0, 1, 2], [0, 2, 2]]
    };
    if (k.includes('ch4') || k.includes('methane')) return {
      atoms: [{ el: 'C', x: 0, y: 0, z: 0 }, { el: 'H', x: 0.63, y: 0.63, z: 0.63 }, { el: 'H', x: -0.63, y: -0.63, z: 0.63 }, { el: 'H', x: -0.63, y: 0.63, z: -0.63 }, { el: 'H', x: 0.63, y: -0.63, z: -0.63 }],
      bonds: [[0, 1, 1], [0, 2, 1], [0, 3, 1], [0, 4, 1]]
    };
    if (k.includes('nacl') || k.includes('salt')) return {
      atoms: [{ el: 'Na', x: -0.9, y: 0, z: 0 }, { el: 'Cl', x: 0.9, y: 0, z: 0 }], bonds: [[0, 1, 1]]
    };
    // Default: a lone carbon so the panel isn't empty.
    return { atoms: [{ el: 'C', x: 0, y: 0, z: 0 }], bonds: [] };
  }

  // ---- Shared spin + drag loop -------------------------------------------
  function spinLoop(renderer, scene, camera, group, container, autoSpeed = 0.006) {
    let raf = 0, dragging = false, lastX = 0, lastY = 0, auto = true, disposed = false;
    const el = renderer.domElement;
    el.style.cursor = 'grab';
    el.style.touchAction = 'none';

    const down = (e) => { dragging = true; auto = false; lastX = e.clientX; lastY = e.clientY; el.style.cursor = 'grabbing'; el.setPointerCapture?.(e.pointerId); };
    const move = (e) => {
      if (!dragging) return;
      group.rotation.y += (e.clientX - lastX) * 0.01;
      group.rotation.x += (e.clientY - lastY) * 0.01;
      lastX = e.clientX; lastY = e.clientY;
    };
    const up = (e) => { dragging = false; el.style.cursor = 'grab'; try { el.releasePointerCapture?.(e.pointerId); } catch (_) {} };
    el.addEventListener('pointerdown', down);
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);

    function tick() {
      if (disposed) return;
      if (auto) group.rotation.y += autoSpeed;
      renderer.render(scene, camera);
      raf = requestAnimationFrame(tick);
    }
    tick();

    return {
      dispose() {
        disposed = true;
        cancelAnimationFrame(raf);
        el.removeEventListener('pointerdown', down);
        el.removeEventListener('pointermove', move);
        el.removeEventListener('pointerup', up);
        el.removeEventListener('pointercancel', up);
        renderer.dispose?.();
        if (el.parentNode) el.parentNode.removeChild(el);
      }
    };
  }

  // ---- Public entry -------------------------------------------------------
  function mount(container, spec) {
    if (typeof THREE === 'undefined') {
      container.innerHTML = '<p style="color:#ff6b7a;font-size:0.8rem;padding:10px">3D viewer failed to load (Three.js unavailable).</p>';
      return { dispose() {} };
    }
    const w = container.clientWidth || 300;
    const h = container.clientHeight || 220;
    try {
      if (spec.kind === 'molecule') return mountMolecule(container, spec, w, h);
      if (spec.kind === 'solid' && spec.shape === 'earth') return mountEarth(container, w, h);
      if (spec.kind === 'solid') return mountSolid(container, spec, w, h);
      if (spec.kind === 'earth') return mountEarth(container, w, h);
      return { dispose() {} };
    } catch (err) {
      container.innerHTML = `<p style="color:#ff6b7a;font-size:0.8rem;padding:10px">3D render error: ${err.message}</p>`;
      return { dispose() {} };
    }
  }

  window.AthenaViz3D = { mount };
})();
