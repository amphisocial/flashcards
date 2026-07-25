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

  // Earth radius in scene units; all geography helpers use this.
  const EARTH_R = 1.7;

  // lat/long (degrees) -> point on the sphere. Longitude 0 faces +Z so the
  // texture's prime meridian lines up with the labels we place.
  function latLonToVec(lat, lon, r) {
    const phi = (90 - lat) * Math.PI / 180;
    const theta = (lon + 180) * Math.PI / 180;
    return new THREE.Vector3(
      -r * Math.sin(phi) * Math.cos(theta),
      r * Math.cos(phi),
      r * Math.sin(phi) * Math.sin(theta)
    );
  }

  // A text label that always faces the camera, drawn to a small canvas.
  function makeLabelSprite(text, opts = {}) {
    const fontSize = opts.fontSize || 44;
    const pad = 10;
    const c = document.createElement('canvas');
    const g = c.getContext('2d');
    g.font = `${opts.weight || 700} ${fontSize}px Inter, Arial, sans-serif`;
    const w = g.measureText(text).width;
    c.width = w + pad * 2;
    c.height = fontSize + pad * 2;
    g.font = `${opts.weight || 700} ${fontSize}px Inter, Arial, sans-serif`;
    g.textBaseline = 'middle';
    if (opts.bg) { g.fillStyle = opts.bg; g.fillRect(0, 0, c.width, c.height); }
    g.fillStyle = opts.color || '#ffffff';
    g.shadowColor = 'rgba(0,0,0,0.9)';
    g.shadowBlur = 6;
    g.fillText(text, pad, c.height / 2);
    const tex = new THREE.CanvasTexture(c);
    tex.minFilter = THREE.LinearFilter;
    const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: opts.depthTest !== false });
    const sprite = new THREE.Sprite(mat);
    const scale = (opts.scale || 0.5);
    sprite.scale.set((c.width / c.height) * scale, scale, 1);
    return sprite;
  }

  // Build a lat/long graticule (grid) as line loops every `step` degrees.
  function buildGraticule(r, step, color, opacity) {
    const group = new THREE.Group();
    const mat = new THREE.LineBasicMaterial({ color, transparent: true, opacity });
    // Parallels (constant latitude)
    for (let lat = -90 + step; lat < 90; lat += step) {
      const pts = [];
      for (let lon = -180; lon <= 180; lon += 5) pts.push(latLonToVec(lat, lon, r));
      group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), mat));
    }
    // Meridians (constant longitude)
    for (let lon = -180; lon < 180; lon += step) {
      const pts = [];
      for (let lat = -90; lat <= 90; lat += 5) pts.push(latLonToVec(lat, lon, r));
      group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), mat));
    }
    return group;
  }

  // A single highlighted latitude circle (equator / tropics), thicker + colored.
  function latitudeRing(lat, r, color) {
    const pts = [];
    for (let lon = -180; lon <= 180; lon += 3) pts.push(latLonToVec(lat, lon, r * 1.001));
    return new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(pts),
      new THREE.LineBasicMaterial({ color })
    );
  }

  // Build a set of border/river lines from GeoJSON-style [[lon,lat],...] rings
  // draped onto the sphere. Returned as one merged Group.
  function buildLines(features, r, color, opacity, closed) {
    const group = new THREE.Group();
    const mat = new THREE.LineBasicMaterial({ color, transparent: true, opacity });
    features.forEach((ring) => {
      const pts = ring.map(([lon, lat]) => latLonToVec(lat, lon, r));
      if (pts.length < 2) return;
      const geom = new THREE.BufferGeometry().setFromPoints(pts);
      group.add(closed ? new THREE.LineLoop(geom, mat) : new THREE.Line(geom, mat));
    });
    return group;
  }

  function mountEarth(container, w, h) {
    const scene = baseScene();
    const camera = new THREE.PerspectiveCamera(45, w / h, 0.1, 100);
    camera.position.set(0, 0, 5.2);
    const renderer = makeRenderer(container, w, h);

    const group = new THREE.Group();

    // Base sphere. Two materials: satellite (Blue Marble photo) and a plain
    // dark "political" fill that makes borders and labels pop. We swap the
    // material's map/color rather than rebuild the mesh.
    const geo = new THREE.SphereGeometry(EARTH_R, 96, 64);
    const mat = new THREE.MeshPhongMaterial({ color: 0x2a4a7c, shininess: 8 });
    const earth = new THREE.Mesh(geo, mat);
    group.add(earth);
    let satelliteTex = null;
    new THREE.TextureLoader().load('/textures/earth.jpg', (tex) => {
      tex.anisotropy = 4; satelliteTex = tex;
      if (mode === 'satellite') { mat.map = tex; mat.color.setHex(0xffffff); mat.needsUpdate = true; }
    });

    // Atmosphere halo.
    group.add(new THREE.Mesh(
      new THREE.SphereGeometry(EARTH_R * 1.05, 48, 32),
      new THREE.MeshBasicMaterial({ color: 0x3a7bd5, transparent: true, opacity: 0.14, side: THREE.BackSide })
    ));

    // Graticule + special latitudes (always on).
    group.add(buildGraticule(EARTH_R * 1.002, 15, 0xffffff, 0.14));
    [[0, 0x14d9c4, 'Equator'], [23.5, 0xffcc66, 'Tropic of Cancer'], [-23.5, 0xffcc66, 'Tropic of Capricorn'],
     [66.5, 0x5bd0ff, 'Arctic Circle'], [-66.5, 0x5bd0ff, 'Antarctic Circle']].forEach(([lat, color, text]) => {
      group.add(latitudeRing(lat, EARTH_R, color));
      const sp = makeLabelSprite(text, { color: '#' + color.toString(16).padStart(6, '0'), fontSize: 30, scale: 0.3 });
      sp.position.copy(latLonToVec(lat, -160, EARTH_R * 1.04));
      sp.userData.tier = 'lat';
      group.add(sp);
    });

    // Ocean + continent labels (shown when zoomed out).
    const macroLabels = new THREE.Group();
    [['Pacific Ocean', 0, -150], ['Atlantic Ocean', 5, -30], ['Indian Ocean', -25, 78],
     ['Arctic Ocean', 80, 0], ['Southern Ocean', -75, 120]].forEach(([name, lat, lon]) => {
      const sp = makeLabelSprite(name, { color: '#bcd4ff', weight: 500, fontSize: 28, scale: 0.26 });
      sp.position.copy(latLonToVec(lat, lon, EARTH_R * 1.02));
      macroLabels.add(sp);
    });
    [['N. America', 40, -100], ['S. America', -15, -60], ['Africa', 3, 22], ['Europe', 50, 12],
     ['Asia', 45, 90], ['Australia', -25, 134]].forEach(([name, lat, lon]) => {
      const sp = makeLabelSprite(name, { color: '#ffffff', weight: 800, fontSize: 30, scale: 0.28 });
      sp.position.copy(latLonToVec(lat, lon, EARTH_R * 1.02));
      macroLabels.add(sp);
    });
    group.add(macroLabels);

    group.rotation.z = -0.41;   // axial tilt
    group.rotation.y = -1.2;    // start facing Africa/Europe
    scene.add(group);

    // Political layers, loaded async and added when ready.
    let mode = 'satellite';
    const borders = new THREE.Group(); borders.visible = false; group.add(borders);
    const riversG = new THREE.Group(); riversG.visible = false; group.add(riversG);
    const countryLabels = new THREE.Group(); group.add(countryLabels);
    const cityLabels = new THREE.Group(); group.add(cityLabels);
    const capitalDots = new THREE.Group(); capitalDots.visible = false; group.add(capitalDots);

    // Fetch the bundled cartographic data. All optional - the globe still
    // works (just without political overlays) if a file is missing.
    Promise.all([
      fetch('/geo/countries.json').then((r) => r.json()).catch(() => []),
      fetch('/geo/cities.json').then((r) => r.json()).catch(() => []),
      fetch('/geo/rivers.json').then((r) => r.json()).catch(() => [])
    ]).then(([countries, cities, rivers]) => {
      // Country borders (all outer rings).
      const rings = [];
      countries.forEach((c) => c.p.forEach((ring) => rings.push(ring)));
      borders.add(buildLines(rings, EARTH_R * 1.003, 0x9fd0ff, 0.55, true));

      // Rivers.
      riversG.add(buildLines(rivers, EARTH_R * 1.004, 0x4aa3ff, 0.5, false));

      // Country name labels at centroids, tiered by Natural Earth LABELRANK
      // (lower rank = more prominent -> shown sooner as you zoom).
      countries.forEach((c) => {
        if (!c.n) return;
        const sp = makeLabelSprite(c.n, { color: '#eaf2ff', weight: 700, fontSize: 26, scale: 0.2 });
        sp.position.copy(latLonToVec(c.c[1], c.c[0], EARTH_R * 1.015));
        sp.userData.tier = 'country';
        sp.userData.rank = c.lr || 6;
        sp.visible = false;
        countryLabels.add(sp);
      });

      // City labels + capital dots.
      cities.forEach((ct) => {
        const pos = latLonToVec(ct.c[1], ct.c[0], EARTH_R * 1.012);
        const sp = makeLabelSprite(ct.n, { color: ct.cap ? '#ffe08a' : '#dfe8f5', weight: ct.cap ? 700 : 500, fontSize: 22, scale: 0.16 });
        sp.position.copy(pos);
        sp.userData.tier = 'city';
        sp.userData.cap = ct.cap;
        sp.userData.rank = ct.sr || 10;
        sp.visible = false;
        cityLabels.add(sp);

        if (ct.cap) {
          const dot = new THREE.Mesh(new THREE.SphereGeometry(0.012, 8, 8), new THREE.MeshBasicMaterial({ color: 0xffcc33 }));
          dot.position.copy(latLonToVec(ct.c[1], ct.c[0], EARTH_R * 1.006));
          capitalDots.add(dot);
        }
      });
      updateLOD(camera.position.length());
    });

    // Level-of-detail: which labels are visible depends on how far the camera
    // is. Far -> continents/oceans only. Closer -> countries. Closest ->
    // cities and capitals. Thresholds are camera distances (EARTH_R = 1.7).
    function updateLOD(dist) {
      const showMacro = dist > 4.0;
      const showCountries = dist <= 4.6;
      const showCities = dist < 3.1;
      const showCapitals = dist < 3.6;
      macroLabels.visible = showMacro || mode === 'satellite' && dist > 3.6;
      // Progressive reveal by rank: the closer you are, the higher the rank
      // number we allow (rank 1-2 shows first, up to 6+ when very close).
      const countryRankCut = dist > 4.2 ? 2 : dist > 3.6 ? 3 : dist > 3.0 ? 5 : 8;
      countryLabels.children.forEach((sp) => {
        sp.visible = mode === 'political' && showCountries && (sp.userData.rank <= countryRankCut);
      });
      const cityRankCut = dist > 2.9 ? 1 : dist > 2.6 ? 3 : dist > 2.3 ? 6 : 12;
      cityLabels.children.forEach((sp) => {
        const allow = sp.userData.cap ? showCapitals : showCities;
        sp.visible = mode === 'political' && allow && (sp.userData.rank <= (sp.userData.cap ? cityRankCut + 3 : cityRankCut));
      });
      capitalDots.visible = mode === 'political' && showCapitals;
    }

    function setMode(next) {
      mode = next;
      if (mode === 'political') {
        mat.map = null; mat.color.setHex(0x0c1a30); mat.needsUpdate = true;
        borders.visible = true; riversG.visible = true;
      } else {
        if (satelliteTex) { mat.map = satelliteTex; mat.color.setHex(0xffffff); }
        else mat.color.setHex(0x2a4a7c);
        mat.needsUpdate = true;
        borders.visible = false; riversG.visible = false;
      }
      updateLOD(camera.position.length());
    }

    // Interaction hint + mode toggle.
    const hint = document.createElement('div');
    hint.className = 'viz3d-hint';
    hint.textContent = 'Drag to rotate · scroll to zoom in';
    container.appendChild(hint);

    const toggle = document.createElement('button');
    toggle.className = 'viz3d-mode-btn';
    toggle.type = 'button';
    toggle.textContent = '🗺 Political';
    toggle.addEventListener('click', (e) => {
      e.stopPropagation();
      setMode(mode === 'satellite' ? 'political' : 'satellite');
      toggle.textContent = mode === 'political' ? '🛰 Satellite' : '🗺 Political';
      toggle.classList.toggle('active', mode === 'political');
    });
    container.appendChild(toggle);

    return spinLoop(renderer, scene, camera, group, container, 0.0022, {
      zoom: true, minZoom: 2.15, maxZoom: 9,
      onZoom: (dist) => updateLOD(dist)
    });
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
  function spinLoop(renderer, scene, camera, group, container, autoSpeed = 0.006, opts = {}) {
    let raf = 0, dragging = false, lastX = 0, lastY = 0, auto = true, disposed = false;
    const el = renderer.domElement;
    el.style.cursor = 'grab';
    el.style.touchAction = 'none';
    const pointers = new Map();
    let pinchDist = 0;

    const down = (e) => {
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      dragging = true; auto = false; lastX = e.clientX; lastY = e.clientY;
      el.style.cursor = 'grabbing'; el.setPointerCapture?.(e.pointerId);
      if (pointers.size === 2) { const [a, b] = [...pointers.values()]; pinchDist = Math.hypot(a.x - b.x, a.y - b.y); }
    };
    const move = (e) => {
      if (pointers.has(e.pointerId)) { const p = pointers.get(e.pointerId); p.x = e.clientX; p.y = e.clientY; }
      // Two-finger pinch zoom (when zoom enabled).
      if (opts.zoom && pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (pinchDist) applyZoom((pinchDist - d) * 0.01);
        pinchDist = d;
        return;
      }
      if (!dragging) return;
      group.rotation.y += (e.clientX - lastX) * 0.01;
      group.rotation.x += (e.clientY - lastY) * 0.01;
      group.rotation.x = Math.max(-1.3, Math.min(1.3, group.rotation.x));
      lastX = e.clientX; lastY = e.clientY;
    };
    const up = (e) => {
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinchDist = 0;
      if (pointers.size === 0) { dragging = false; el.style.cursor = 'grab'; }
      try { el.releasePointerCapture?.(e.pointerId); } catch (_) {}
    };
    el.addEventListener('pointerdown', down);
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);

    // Wheel zoom by dollying the camera along its view direction.
    function applyZoom(delta) {
      if (!opts.zoom) return;
      const min = opts.minZoom || 2.4, max = opts.maxZoom || 12;
      const dir = camera.position.clone().normalize();
      let dist = camera.position.length() + delta;
      dist = Math.max(min, Math.min(max, dist));
      camera.position.copy(dir.multiplyScalar(dist));
      camera.lookAt(0, 0, 0);
      if (opts.onZoom) opts.onZoom(dist);
    }
    const wheel = (e) => { e.preventDefault(); auto = false; applyZoom(e.deltaY * 0.002); };
    if (opts.zoom) el.addEventListener('wheel', wheel, { passive: false });

    function onResize(width, height) {
      renderer.setSize(width, height);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    }

    function tick() {
      if (disposed) return;
      if (auto) group.rotation.y += autoSpeed;
      renderer.render(scene, camera);
      raf = requestAnimationFrame(tick);
    }
    tick();

    return {
      onResize,
      resumeAuto() { auto = true; },
      dispose() {
        disposed = true;
        cancelAnimationFrame(raf);
        el.removeEventListener('pointerdown', down);
        el.removeEventListener('pointermove', move);
        el.removeEventListener('pointerup', up);
        el.removeEventListener('pointercancel', up);
        if (opts.zoom) el.removeEventListener('wheel', wheel);
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
    let handle;
    try {
      if (spec.kind === 'molecule') handle = mountMolecule(container, spec, w, h);
      else if ((spec.kind === 'solid' && spec.shape === 'earth') || spec.kind === 'earth') handle = mountEarth(container, w, h);
      else if (spec.kind === 'solid') handle = mountSolid(container, spec, w, h);
      else return { dispose() {} };
    } catch (err) {
      container.innerHTML = `<p style="color:#ff6b7a;font-size:0.8rem;padding:10px">3D render error: ${err.message}</p>`;
      return { dispose() {} };
    }

    addFullscreenButton(container, handle);
    return handle;
  }

  // A maximize button on every viewer. Fullscreen the holder, then resize the
  // renderer to fill it; restore on exit. Works for solids, molecules, Earth.
  function addFullscreenButton(container, handle) {
    const btn = document.createElement('button');
    btn.className = 'viz3d-fs-btn';
    btn.type = 'button';
    btn.title = 'Maximize';
    btn.innerHTML = '⛶';
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
      if (fsEl === container) {
        (document.exitFullscreen || document.webkitExitFullscreen || (() => {})).call(document);
      } else if (container.requestFullscreen || container.webkitRequestFullscreen) {
        (container.requestFullscreen || container.webkitRequestFullscreen).call(container);
      }
    });
    container.appendChild(btn);

    const onFsChange = () => {
      const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
      const active = fsEl === container;
      container.classList.toggle('viz3d-fullscreen', active);
      btn.innerHTML = active ? '✕' : '⛶';
      // Resize the renderer to whatever the holder is now.
      requestAnimationFrame(() => {
        const rw = container.clientWidth || 300;
        const rh = container.clientHeight || 220;
        if (handle.onResize) handle.onResize(rw, rh);
      });
    };
    document.addEventListener('fullscreenchange', onFsChange);
    document.addEventListener('webkitfullscreenchange', onFsChange);

    // Chain dispose so listeners are cleaned up too.
    const origDispose = handle.dispose;
    handle.dispose = () => {
      document.removeEventListener('fullscreenchange', onFsChange);
      document.removeEventListener('webkitfullscreenchange', onFsChange);
      if (origDispose) origDispose();
    };
  }

  window.AthenaViz3D = { mount };
})();
