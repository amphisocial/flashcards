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

  // Per-element data for the zoom-in Bohr view: atomic number Z, full name,
  // and electron counts per shell (K, L, M, N...). Covers the elements that
  // actually turn up in classroom molecules; anything else is derived roughly
  // from Z so the feature still shows something reasonable.
  const ELEMENTS = {
    H:  { z: 1,  name: 'Hydrogen',  shells: [1] },
    He: { z: 2,  name: 'Helium',    shells: [2] },
    Li: { z: 3,  name: 'Lithium',   shells: [2, 1] },
    Be: { z: 4,  name: 'Beryllium', shells: [2, 2] },
    B:  { z: 5,  name: 'Boron',     shells: [2, 3] },
    C:  { z: 6,  name: 'Carbon',    shells: [2, 4] },
    N:  { z: 7,  name: 'Nitrogen',  shells: [2, 5] },
    O:  { z: 8,  name: 'Oxygen',    shells: [2, 6] },
    F:  { z: 9,  name: 'Fluorine',  shells: [2, 7] },
    Ne: { z: 10, name: 'Neon',      shells: [2, 8] },
    Na: { z: 11, name: 'Sodium',    shells: [2, 8, 1] },
    Mg: { z: 12, name: 'Magnesium', shells: [2, 8, 2] },
    Al: { z: 13, name: 'Aluminium', shells: [2, 8, 3] },
    Si: { z: 14, name: 'Silicon',   shells: [2, 8, 4] },
    P:  { z: 15, name: 'Phosphorus',shells: [2, 8, 5] },
    S:  { z: 16, name: 'Sulfur',    shells: [2, 8, 6] },
    Cl: { z: 17, name: 'Chlorine',  shells: [2, 8, 7] },
    Ar: { z: 18, name: 'Argon',     shells: [2, 8, 8] },
    K:  { z: 19, name: 'Potassium', shells: [2, 8, 8, 1] },
    Ca: { z: 20, name: 'Calcium',   shells: [2, 8, 8, 2] },
    Fe: { z: 26, name: 'Iron',      shells: [2, 8, 14, 2] },
    Br: { z: 35, name: 'Bromine',   shells: [2, 8, 18, 7] },
    I:  { z: 53, name: 'Iodine',    shells: [2, 8, 18, 18, 7] }
  };

  // Rough shell fill for elements not in the table (2, 8, 18, 32 capacities).
  function shellsFor(el) {
    if (ELEMENTS[el]) return ELEMENTS[el];
    return { z: 0, name: el, shells: [] };
  }

  function makeRenderer(container, w, h) {
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
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

    return spinLoop(renderer, scene, camera, group, container, 0.006, { zoom: true, minZoom: 1.6, maxZoom: 18 });
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

    // Level-of-detail is BOTH distance-based and FOCUS-based. Distance sets
    // how much detail is available; focus restricts detailed labels (cities)
    // to a cone around the point the camera is looking at - the centre of the
    // screen - so a zoomed-in view doesn't stack every label in the
    // hemisphere on top of each other. Everything off-centre falls back to
    // country/ocean level. The cone tightens as you zoom in.
    const _v = new THREE.Vector3();
    function labelWorldDir(sp) {
      // The label's local position rotated by the group's current rotation.
      // (Labels sit on the sphere, so their normalized position is also their
      // direction from the centre.)
      return _v.copy(sp.position).applyEuler(group.rotation).normalize();
    }
    function updateLOD(dist) {
      // Direction from globe centre toward the camera = the point currently
      // facing the viewer (screen centre).
      const viewDir = camera.position.clone().normalize();

      const showMacro = dist > 4.0;
      macroLabels.visible = showMacro || (mode === 'satellite' && dist > 3.6);

      // Country labels: shown across the front hemisphere (they're sparse
      // enough not to stack badly), gated by rank + distance.
      const countryRankCut = dist > 4.2 ? 2 : dist > 3.6 ? 3 : dist > 3.0 ? 5 : 9;
      const showCountries = mode === 'political' && dist <= 4.6;
      countryLabels.children.forEach((sp) => {
        if (!showCountries || sp.userData.rank > countryRankCut) { sp.visible = false; return; }
        // Hide anything on the far side of the globe (facing away).
        sp.visible = labelWorldDir(sp).dot(viewDir) > 0.12;
      });

      // Cities: only inside the focus cone, and only once zoomed in enough to
      // want them. cosThreshold rises (cone narrows) as you zoom in.
      // dist 3.1 -> ~50deg cone; dist 2.15 -> ~24deg cone.
      const wantCities = mode === 'political' && dist < 3.2;
      const t = Math.max(0, Math.min(1, (3.2 - dist) / (3.2 - 2.15)));
      const coneCos = 0.64 + t * 0.27;               // 0.64 (~50deg) -> 0.91 (~24deg)
      const cityRankCut = 4 + Math.round(t * 8);     // more cities allowed the closer you are
      const candidates = [];
      cityLabels.children.forEach((sp) => {
        if (!wantCities) { sp.visible = false; return; }
        const cos = sp.userData.cap ? coneCos - 0.06 : coneCos;
        const rankOk = sp.userData.rank <= (sp.userData.cap ? cityRankCut + 4 : cityRankCut);
        const inCone = rankOk && labelWorldDir(sp).dot(viewDir) > cos;
        sp.visible = inCone;
        if (inCone) candidates.push(sp);
      });
      declutter(candidates);
      capitalDots.visible = mode === 'political' && dist < 3.6;
    }

    // Screen-space declutter: project each visible city label to 2D and hide
    // any that would overlap one already placed. Capitals and higher-priority
    // (lower-rank) labels win, so the important names survive and the pile-up
    // in dense regions like India is thinned to what's readable.
    const _p = new THREE.Vector3();
    function declutter(labels) {
      const W = renderer.domElement.clientWidth || 300;
      const H = renderer.domElement.clientHeight || 220;
      // Sort by priority: capitals first, then by rank (lower = more important).
      labels.sort((a, b) => (b.userData.cap - a.userData.cap) || (a.userData.rank - b.userData.rank));
      const placed = [];
      const padX = W * 0.06, padY = H * 0.035;
      labels.forEach((sp) => {
        _p.copy(sp.position).applyEuler(group.rotation).project(camera);
        // Behind camera or off-screen -> hide.
        if (_p.z > 1) { sp.visible = false; return; }
        const x = (_p.x * 0.5 + 0.5) * W;
        const y = (-_p.y * 0.5 + 0.5) * H;
        let clash = false;
        for (let i = 0; i < placed.length; i += 1) {
          if (Math.abs(x - placed[i].x) < padX && Math.abs(y - placed[i].y) < padY) { clash = true; break; }
        }
        if (clash) sp.visible = false;
        else placed.push({ x, y });
      });
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
      onZoom: (dist) => updateLOD(dist),
      onFrame: () => updateLOD(camera.position.length())
    });
  }

  function mountMolecule(container, spec, w, h) {
    const scene = baseScene();
    const camera = new THREE.PerspectiveCamera(45, w / h, 0.1, 100);
    const renderer = makeRenderer(container, w, h);
    const group = new THREE.Group();       // the whole molecule
    const bohrGroup = new THREE.Group();   // the zoomed-in single-atom view
    bohrGroup.visible = false;
    scene.add(group);
    scene.add(bohrGroup);

    let atoms = Array.isArray(spec.atoms) ? spec.atoms : [];
    let bonds = Array.isArray(spec.bonds) ? spec.bonds : [];
    if (!atoms.length) { const fb = fallbackMolecule(spec.formula || spec.name); atoms = fb.atoms; bonds = fb.bonds; }

    const center = atoms.reduce((acc, a) => ({ x: acc.x + (a.x || 0), y: acc.y + (a.y || 0), z: acc.z + (a.z || 0) }), { x: 0, y: 0, z: 0 });
    center.x /= (atoms.length || 1); center.y /= (atoms.length || 1); center.z /= (atoms.length || 1);

    // Atom spheres, each tagged with its element and clickable for focus.
    const atomMeshes = [];
    atoms.forEach((at, idx) => {
      const el = normalizeEl(at.el);
      const sph = new THREE.Mesh(
        new THREE.SphereGeometry((RADIUS[el] || RADIUS.default), 32, 24),
        new THREE.MeshPhongMaterial({ color: CPK[el] || CPK.default, shininess: 80 })
      );
      sph.position.set((at.x || 0) - center.x, (at.y || 0) - center.y, (at.z || 0) - center.z);
      sph.userData = { el, idx };
      group.add(sph);
      atomMeshes.push(sph);

      // Element-symbol label floating just above each atom.
      const lab = makeLabelSprite(el, { color: '#ffffff', weight: 800, fontSize: 40, scale: 0.34, depthTest: false });
      lab.position.copy(sph.position).add(new THREE.Vector3(0, (RADIUS[el] || RADIUS.default) + 0.18, 0));
      group.add(lab);
    });

    bonds.forEach((bd) => {
      const i = bd[0], j = bd[1];
      if (!atoms[i] || !atoms[j]) return;
      const p1 = new THREE.Vector3((atoms[i].x || 0) - center.x, (atoms[i].y || 0) - center.y, (atoms[i].z || 0) - center.z);
      const p2 = new THREE.Vector3((atoms[j].x || 0) - center.x, (atoms[j].y || 0) - center.y, (atoms[j].z || 0) - center.z);
      const order = bd[2] || 1;
      // Draw double/triple bonds as parallel offset cylinders.
      if (order >= 2) {
        const dir = new THREE.Vector3().subVectors(p2, p1).normalize();
        const off = new THREE.Vector3(dir.y, -dir.x, dir.z).normalize().multiplyScalar(0.08);
        group.add(bondCylinder(p1.clone().add(off), p2.clone().add(off)));
        group.add(bondCylinder(p1.clone().sub(off), p2.clone().sub(off)));
        if (order >= 3) group.add(bondCylinder(p1, p2));
      } else {
        group.add(bondCylinder(p1, p2));
      }
    });

    // Frame the molecule.
    const box = new THREE.Box3().setFromObject(group);
    const size = box.getSize(new THREE.Vector3()).length() || 4;
    const homeDist = size * 1.4 + 2;
    camera.position.set(0, 0, homeDist);
    camera.lookAt(0, 0, 0);

    // ---- Focus / Bohr mode ------------------------------------------------
    let focused = null;   // element currently zoomed into, or null
    const raycaster = new THREE.Raycaster();
    const ndc = new THREE.Vector2();

    function buildBohr(el) {
      // Clear any previous atom.
      while (bohrGroup.children.length) bohrGroup.remove(bohrGroup.children[0]);
      const info = shellsFor(el);
      const color = CPK[el] || CPK.default;

      // Nucleus.
      const nucleus = new THREE.Mesh(new THREE.SphereGeometry(0.5, 32, 24), new THREE.MeshPhongMaterial({ color, emissive: color, emissiveIntensity: 0.3, shininess: 90 }));
      bohrGroup.add(nucleus);

      // Nucleus label: symbol + atomic number (= protons).
      const nlab = makeLabelSprite(`${el}  Z=${info.z}`, { color: '#ffffff', weight: 800, fontSize: 44, scale: 0.5, depthTest: false });
      nlab.position.set(0, 0.85, 0);
      bohrGroup.add(nlab);

      // Electron shells: a faint ring per shell + electrons spaced around it.
      // Electrons are stored with their orbit params so tick() can animate them.
      bohrGroup.userData.electrons = [];
      const shells = info.shells.length ? info.shells : [Math.min(info.z, 2)];
      shells.forEach((count, s) => {
        const r = 1.1 + s * 0.7;
        // Ring.
        const ringPts = [];
        for (let a = 0; a <= 64; a += 1) { const th = (a / 64) * Math.PI * 2; ringPts.push(new THREE.Vector3(Math.cos(th) * r, Math.sin(th) * r, 0)); }
        bohrGroup.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(ringPts), new THREE.LineBasicMaterial({ color: 0x8fbfff, transparent: true, opacity: 0.4 })));
        // Shell electron-count label.
        const slab = makeLabelSprite(`${count}e⁻`, { color: '#8fbfff', weight: 700, fontSize: 30, scale: 0.34, depthTest: false });
        slab.position.set(r + 0.15, 0.2, 0);
        bohrGroup.add(slab);
        // Electrons.
        for (let k = 0; k < count; k += 1) {
          const e = new THREE.Mesh(new THREE.SphereGeometry(0.11, 16, 12), new THREE.MeshPhongMaterial({ color: 0x39c0ff, emissive: 0x1a6dbf, emissiveIntensity: 0.5 }));
          bohrGroup.add(e);
          bohrGroup.userData.electrons.push({ mesh: e, r, phase: (k / count) * Math.PI * 2, speed: 0.6 - s * 0.12, tilt: s * 0.5 });
        }
      });

      // A little valence caption (outermost shell count).
      const valence = shells[shells.length - 1];
      const cap = makeLabelSprite(`${info.name} — ${valence} valence e⁻`, { color: '#eaf2ff', weight: 600, fontSize: 30, scale: 0.34, depthTest: false });
      cap.position.set(0, -(1.1 + (shells.length - 1) * 0.7) - 0.5, 0);
      bohrGroup.add(cap);
    }

    function focusAtom(el) {
      focused = el;
      buildBohr(el);
      group.visible = false;
      bohrGroup.visible = true;
      backBtn.style.display = '';
      hint.textContent = 'Scroll to zoom · drag to rotate · Back to molecule';
    }
    function unfocus() {
      focused = null;
      bohrGroup.visible = false;
      group.visible = true;
      backBtn.style.display = 'none';
      hint.textContent = atoms.length > 1 ? 'Click an atom to zoom into its shells' : 'Scroll to zoom · drag to rotate';
    }

    // Click an atom -> focus it. (Pointerup without much drag = a click.)
    let downXY = null;
    renderer.domElement.addEventListener('pointerdown', (e) => { downXY = { x: e.clientX, y: e.clientY }; });
    renderer.domElement.addEventListener('pointerup', (e) => {
      if (!downXY || focused) return;
      const moved = Math.hypot(e.clientX - downXY.x, e.clientY - downXY.y);
      downXY = null;
      if (moved > 6) return; // was a drag, not a click
      const rect = renderer.domElement.getBoundingClientRect();
      ndc.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      ndc.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(ndc, camera);
      const hit = raycaster.intersectObjects(atomMeshes)[0];
      if (hit) focusAtom(hit.object.userData.el);
    });

    // Interaction hint + a Back button (hidden until focused).
    const hint = document.createElement('div');
    hint.className = 'viz3d-hint';
    hint.textContent = atoms.length > 1 ? 'Click an atom to zoom into its shells' : 'Scroll to zoom · drag to rotate';
    container.appendChild(hint);

    const backBtn = document.createElement('button');
    backBtn.className = 'viz3d-back-btn';
    backBtn.type = 'button';
    backBtn.textContent = '← Molecule';
    backBtn.style.display = 'none';
    backBtn.addEventListener('click', (e) => { e.stopPropagation(); unfocus(); });
    container.appendChild(backBtn);

    // Animate orbiting electrons each frame when in Bohr mode.
    function onFrame() {
      if (!bohrGroup.visible || !bohrGroup.userData.electrons) return;
      const t = performance.now() * 0.001;
      bohrGroup.userData.electrons.forEach((el) => {
        const a = el.phase + t * el.speed;
        el.mesh.position.set(Math.cos(a) * el.r, Math.sin(a) * el.r * Math.cos(el.tilt), Math.sin(a) * el.r * Math.sin(el.tilt));
      });
    }

    return spinLoop(renderer, scene, camera, group, container, 0.004, {
      zoom: true, minZoom: 1.5, maxZoom: homeDist * 2.5,
      spinTarget: () => (bohrGroup.visible ? bohrGroup : group),
      onFrame
    });
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
    const target = () => (opts.spinTarget ? opts.spinTarget() : group);
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
      const tg = target();
      tg.rotation.y += (e.clientX - lastX) * 0.01;
      tg.rotation.x += (e.clientY - lastY) * 0.01;
      tg.rotation.x = Math.max(-1.3, Math.min(1.3, tg.rotation.x));
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

    let frameN = 0;
    function tick() {
      if (disposed) return;
      if (auto) target().rotation.y += autoSpeed;
      // Refresh focus-based labels a few times a second (every 6th frame),
      // not every frame - the label loop is the expensive part and it doesn't
      // need 60fps to look smooth.
      if (opts.onFrame && (frameN++ % 6 === 0)) opts.onFrame();
      renderer.render(scene, camera);
      raf = requestAnimationFrame(tick);
    }
    tick();

    return {
      onResize,
      snapshot() {
        try { renderer.render(scene, camera); return renderer.domElement.toDataURL('image/png'); }
        catch (_) { return null; }
      },
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
  // ---- Physics: falling-objects drop test --------------------------------
  // The Apollo-15 / Galileo demonstration made interactive. Two objects (a
  // heavy stone and a light feather) drop from the same height. Sliders set
  // gravity; a toggle turns air resistance on/off. With air on, the feather
  // (big area, small mass) lags badly; with air off (vacuum / Moon) they land
  // together - the "aha" moment. A live readout shows time, velocity and the
  // controlling equations.
  function mountPhysics(container, spec, w, h) {
    const scene = baseScene();
    const camera = new THREE.PerspectiveCamera(50, w / h, 0.1, 100);
    camera.position.set(0, 3, 12);
    camera.lookAt(0, 3, 0);
    const renderer = makeRenderer(container, w, h);

    // Ground.
    const ground = new THREE.Mesh(new THREE.BoxGeometry(20, 0.4, 6), new THREE.MeshPhongMaterial({ color: 0x243247 }));
    ground.position.y = -0.2; scene.add(ground);

    const H0 = 7;           // drop height (world units)
    // Two falling bodies. Physical params drive the sim; radius is visual.
    const bodies = [
      { name: 'Stone', mass: 5, area: 0.02, color: 0xbfc6d0, x: -2.2, r: 0.5 },
      { name: 'Feather', mass: 0.05, area: 1.2, color: 0xffd27a, x: 2.2, r: 0.42 }
    ];
    bodies.forEach((b) => {
      b.mesh = new THREE.Mesh(new THREE.SphereGeometry(b.r, 24, 18), new THREE.MeshPhongMaterial({ color: b.color, shininess: 60 }));
      b.mesh.position.set(b.x, H0, 0);
      scene.add(b.mesh);
      const lab = makeLabelSprite(b.name, { color: '#ffffff', weight: 800, fontSize: 34, scale: 0.5, depthTest: false });
      lab.position.set(b.x, H0 + 0.9, 0);
      b.label = lab; scene.add(lab);
      b.y = H0; b.v = 0; b.landed = false; b.tLand = null;
    });

    // Simulation state (adjustable live).
    const sim = { g: (spec.dims && spec.dims.g) || 9.8, air: spec.air !== false, rho: 1.2, running: false, t: 0 };

    function reset() {
      sim.t = 0; sim.running = false;
      bodies.forEach((b) => { b.y = H0; b.v = 0; b.landed = false; b.tLand = null; b.mesh.position.y = H0; b.label.position.y = H0 + 0.9; });
      updateReadout();
    }
    function step(dt) {
      if (!sim.running) return;
      sim.t += dt;
      bodies.forEach((b) => {
        if (b.landed) return;
        // F = mg - drag. drag = 0.5*rho*Cd*A*v^2 (opposing motion). Cd~1.
        const weight = b.mass * sim.g;
        const drag = sim.air ? 0.5 * sim.rho * 1.0 * b.area * b.v * b.v : 0;
        const a = (weight - drag) / b.mass;   // downward positive
        b.v += a * dt;
        b.y -= b.v * dt;
        if (b.y <= b.r) { b.y = b.r; b.landed = true; b.tLand = sim.t; }
        b.mesh.position.y = b.y; b.label.position.y = b.y + 0.9;
      });
      if (bodies.every((b) => b.landed)) sim.running = false;
      updateReadout();
    }

    // Readout + controls DOM.
    const hud = document.createElement('div');
    hud.className = 'phys-hud';
    container.appendChild(hud);
    function updateReadout() {
      const rows = bodies.map((b) => `${b.name}: v=${b.v.toFixed(1)} m/s${b.tLand ? ` · landed ${b.tLand.toFixed(2)}s` : ''}`);
      hud.innerHTML = `<div class="phys-eq">${sim.air ? 'F = mg − ½ρC<sub>d</sub>Av²' : 'F = mg  (vacuum)'} · g=${sim.g.toFixed(1)} m/s²</div>` +
        rows.map((r) => `<div>${r}</div>`).join('') +
        `<div class="phys-hint">${sim.air ? 'Air ON: the feather lags — air resistance dominates its tiny mass.' : 'Vacuum: both land together, regardless of mass (Galileo / Apollo 15).'}</div>`;
    }

    const controls = document.createElement('div');
    controls.className = 'phys-controls';
    controls.innerHTML = `
      <button class="phys-btn" data-act="drop">▶ Drop</button>
      <button class="phys-btn" data-act="reset">⟲ Reset</button>
      <label class="phys-toggle"><input type="checkbox" data-act="air" ${sim.air ? 'checked' : ''}/> Air resistance</label>
      <label class="phys-slider">Gravity <span class="pg-out">${sim.g.toFixed(1)}</span>
        <input type="range" min="1.6" max="25" step="0.1" value="${sim.g}" data-act="g"/>
        <span class="phys-presets"><button data-g="9.8">Earth</button><button data-g="1.6">Moon</button><button data-g="24.8">Jupiter</button></span>
      </label>`;
    container.appendChild(controls);
    controls.querySelector('[data-act=drop]').addEventListener('click', () => { reset(); sim.running = true; });
    controls.querySelector('[data-act=reset]').addEventListener('click', reset);
    controls.querySelector('[data-act=air]').addEventListener('change', (e) => { sim.air = e.target.checked; reset(); });
    const gIn = controls.querySelector('[data-act=g]');
    gIn.addEventListener('input', () => { sim.g = Number(gIn.value); controls.querySelector('.pg-out').textContent = sim.g.toFixed(1); updateReadout(); });
    controls.querySelectorAll('.phys-presets button').forEach((btn) => btn.addEventListener('click', () => {
      sim.g = Number(btn.dataset.g); gIn.value = sim.g; controls.querySelector('.pg-out').textContent = sim.g.toFixed(1); reset();
    }));

    updateReadout();

    // Animation loop.
    let raf = 0, disposed = false, last = performance.now();
    function tick() {
      if (disposed) return;
      const now = performance.now();
      const dt = Math.min(0.05, (now - last) / 1000); last = now;
      step(dt);
      renderer.render(scene, camera);
      raf = requestAnimationFrame(tick);
    }
    tick();

    const handle = {
      onResize(width, height) { camera.aspect = width / height; camera.updateProjectionMatrix(); renderer.setSize(width, height); },
      snapshot() { try { renderer.render(scene, camera); return renderer.domElement.toDataURL('image/png'); } catch (_) { return null; } },
      dispose() { disposed = true; cancelAnimationFrame(raf); renderer.dispose?.(); if (renderer.domElement.parentNode) renderer.domElement.parentNode.removeChild(renderer.domElement); hud.remove(); controls.remove(); }
    };
    addFullscreenButton(container, handle);
    return handle;
  }

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
      else if (spec.kind === 'physics') handle = mountPhysics(container, spec, w, h);
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
    container.appendChild(btn);

    // The Fullscreen API is unsupported for arbitrary elements on iPhone
    // Safari (it only allows fullscreen <video>), so requestFullscreen either
    // is missing or silently no-ops. Detect that and fall back to a CSS
    // "pseudo-fullscreen" that fixes the container over the whole viewport -
    // which is what actually makes the button work for students on iOS.
    const canNativeFS = !!(container.requestFullscreen || container.webkitRequestFullscreen)
      && !isIOS();
    let pseudo = false;

    function resize() {
      requestAnimationFrame(() => {
        const rw = container.clientWidth || 300;
        const rh = container.clientHeight || 220;
        if (handle.onResize) handle.onResize(rw, rh);
      });
    }

    function enterPseudo() {
      pseudo = true;
      container.classList.add('viz3d-fullscreen', 'viz3d-pseudo-fullscreen');
      document.body.classList.add('viz3d-pseudo-lock');
      btn.innerHTML = '✕';
      resize();
    }
    function exitPseudo() {
      pseudo = false;
      container.classList.remove('viz3d-fullscreen', 'viz3d-pseudo-fullscreen');
      document.body.classList.remove('viz3d-pseudo-lock');
      btn.innerHTML = '⛶';
      resize();
    }

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (canNativeFS) {
        const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
        if (fsEl === container) {
          (document.exitFullscreen || document.webkitExitFullscreen).call(document);
        } else {
          (container.requestFullscreen || container.webkitRequestFullscreen).call(container);
        }
      } else {
        // iOS / unsupported: toggle the CSS fallback.
        if (pseudo) exitPseudo(); else enterPseudo();
      }
    });

    const onFsChange = () => {
      const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
      const active = fsEl === container;
      container.classList.toggle('viz3d-fullscreen', active);
      btn.innerHTML = active ? '✕' : '⛶';
      resize();
    };
    document.addEventListener('fullscreenchange', onFsChange);
    document.addEventListener('webkitfullscreenchange', onFsChange);

    // Esc / back also exits the pseudo mode.
    const onKey = (e) => { if (e.key === 'Escape' && pseudo) exitPseudo(); };
    document.addEventListener('keydown', onKey);

    const origDispose = handle.dispose;
    handle.dispose = () => {
      document.removeEventListener('fullscreenchange', onFsChange);
      document.removeEventListener('webkitfullscreenchange', onFsChange);
      document.removeEventListener('keydown', onKey);
      if (pseudo) exitPseudo();
      if (origDispose) origDispose();
    };
  }

  function isIOS() {
    return /iP(hone|ad|od)/.test(navigator.platform || '')
      || (/Mac/.test(navigator.platform || '') && navigator.maxTouchPoints > 1)  // iPadOS 13+
      || /iPhone|iPad|iPod/.test(navigator.userAgent || '');
  }

  window.AthenaViz3D = { mount };
})();
