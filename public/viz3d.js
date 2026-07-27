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
  // ---- Physics simulations ----------------------------------------------
  // A shared scaffold gives every sim a scene, renderer, HUD, control bar,
  // render loop, and the standard viewer handle (snapshot/fullscreen/resize).
  // Each individual sim just declares its bodies, a step(dt) function, its
  // control widgets, and a readout. This keeps the physics per sim isolated
  // and testable while sharing all the boilerplate.
  function physicsScaffold(container, w, h, opts) {
    const scene = baseScene();
    const camera = new THREE.PerspectiveCamera(opts.fov || 50, w / h, 0.1, 200);
    if (opts.camera) camera.position.set(opts.camera[0], opts.camera[1], opts.camera[2]);
    else camera.position.set(0, 3, 12);
    camera.lookAt(opts.lookAt ? opts.lookAt[0] : 0, opts.lookAt ? opts.lookAt[1] : 3, opts.lookAt ? opts.lookAt[2] : 0);
    const renderer = makeRenderer(container, w, h);

    const hud = document.createElement('div');
    hud.className = 'phys-hud';
    container.appendChild(hud);
    const controls = document.createElement('div');
    controls.className = 'phys-controls';
    container.appendChild(controls);

    const api = {
      scene, camera, renderer, hud, controls,
      ready() { ready = true; },
      setHud(html) { hud.innerHTML = html; },
      // Build a labelled slider; onInput gets the numeric value.
      slider(label, min, max, step, value, onInput, presets) {
        const wrap = document.createElement('label'); wrap.className = 'phys-slider';
        wrap.innerHTML = `${label} <span class="pg-out">${(+value).toFixed(step < 1 ? (step < 0.1 ? 2 : 1) : 0)}</span>
          <input type="range" min="${min}" max="${max}" step="${step}" value="${value}"/>` +
          (presets ? `<span class="phys-presets">${presets.map((p) => `<button data-v="${p.v}">${p.label}</button>`).join('')}</span>` : '');
        const inp = wrap.querySelector('input'); const out = wrap.querySelector('.pg-out');
        inp.addEventListener('input', () => { const v = Number(inp.value); out.textContent = v.toFixed(step < 1 ? (step < 0.1 ? 2 : 1) : 0); onInput(v); });
        if (presets) wrap.querySelectorAll('.phys-presets button').forEach((b) => b.addEventListener('click', () => { inp.value = b.dataset.v; out.textContent = Number(b.dataset.v).toFixed(step < 1 ? 1 : 0); onInput(Number(b.dataset.v)); }));
        controls.appendChild(wrap); return wrap;
      },
      button(label, onClick) {
        const b = document.createElement('button'); b.className = 'phys-btn'; b.textContent = label;
        b.addEventListener('click', onClick); controls.appendChild(b); return b;
      },
      toggle(label, checked, onChange) {
        const l = document.createElement('label'); l.className = 'phys-toggle';
        l.innerHTML = `<input type="checkbox" ${checked ? 'checked' : ''}/> ${label}`;
        l.querySelector('input').addEventListener('change', (e) => onChange(e.target.checked));
        controls.appendChild(l); return l;
      }
    };

    let raf = 0, disposed = false, ready = false, last = performance.now();
    function tick() {
      if (disposed) return;
      const now = performance.now();
      const dt = Math.min(0.05, (now - last) / 1000); last = now;
      // Don't step the physics until the sim has finished building its meshes
      // (the scaffold is created first, so the first frames would otherwise
      // touch meshes that don't exist yet).
      if (ready && opts.step) { try { opts.step(dt); } catch (_) {} }
      renderer.render(scene, camera);
      raf = requestAnimationFrame(tick);
    }
    tick();

    const handle = {
      onResize(width, height) { camera.aspect = width / height; camera.updateProjectionMatrix(); renderer.setSize(width, height); },
      snapshot() { try { renderer.render(scene, camera); return renderer.domElement.toDataURL('image/png'); } catch (_) { return null; } },
      dispose() { disposed = true; cancelAnimationFrame(raf); renderer.dispose && renderer.dispose(); if (renderer.domElement.parentNode) renderer.domElement.parentNode.removeChild(renderer.domElement); hud.remove(); controls.remove(); }
    };
    addFullscreenButton(container, handle);
    return { api, handle, isDisposed: () => disposed };
  }

  function ballMesh(r, color) {
    return new THREE.Mesh(new THREE.SphereGeometry(r, 24, 18), new THREE.MeshPhongMaterial({ color, shininess: 60 }));
  }
  function groundMesh(width, color) {
    const g = new THREE.Mesh(new THREE.BoxGeometry(width || 20, 0.4, 6), new THREE.MeshPhongMaterial({ color: color || 0x243247 }));
    g.position.y = -0.2; return g;
  }

  function mountPhysics(container, spec, w, h) {
    const type = spec.type || 'freefall';
    if (type === 'projectile') return simProjectile(container, spec, w, h);
    if (type === 'pendulum') return simPendulum(container, spec, w, h);
    if (type === 'incline') return simIncline(container, spec, w, h);
    if (type === 'collision') return simCollision(container, spec, w, h);
    if (type === 'orbit') return simOrbit(container, spec, w, h);
    if (type === 'welldeath' || type === 'wall-of-death') return simWellOfDeath(container, spec, w, h);
    if (type === 'reflection' || type === 'mirror') return simReflection(container, spec, w, h);
    if (type === 'circuit') return simCircuit(container, spec, w, h);
    if (type === 'fourforces') return simFourForces(container, spec, w, h);
    if (type === 'lift') return simLift(container, spec, w, h);
    if (type === 'dragcurve') return simDragCurve(container, spec, w, h);
    if (type === 'stall') return simStall(container, spec, w, h);
    if (type === 'weightbalance' || type === 'cg') return simWeightBalance(container, spec, w, h);
    if (type === 'glide') return simGlide(container, spec, w, h);
    if (type === 'cdi' || type === 'coursedeviation') return simCDI(container, spec, w, h);
    return simFreefall(container, spec, w, h);
  }

  // ---- Free-fall (stone vs feather) --------------------------------------
  function simFreefall(container, spec, w, h) {
    const H0 = 7;
    const bodies = [
      { name: 'Stone', mass: 5, area: 0.02, color: 0xbfc6d0, x: -2.2, r: 0.5 },
      { name: 'Feather', mass: 0.05, area: 1.2, color: 0xffd27a, x: 2.2, r: 0.42 }
    ];
    const sim = { g: (spec.dims && spec.dims.g) || 9.8, air: spec.air !== false, rho: 1.2, running: false, t: 0 };
    let S;
    function reset() {
      sim.t = 0; sim.running = false;
      bodies.forEach((b) => { b.y = H0; b.v = 0; b.landed = false; b.tLand = null; b.mesh.position.y = H0; b.label.position.y = H0 + 0.9; });
      readout();
    }
    function step(dt) {
      if (!sim.running) return;
      sim.t += dt;
      bodies.forEach((b) => {
        if (b.landed) return;
        const weight = b.mass * sim.g;
        const drag = sim.air ? 0.5 * sim.rho * 1.0 * b.area * b.v * b.v : 0;
        const a = (weight - drag) / b.mass;
        b.v += a * dt; b.y -= b.v * dt;
        if (b.y <= b.r) { b.y = b.r; b.landed = true; b.tLand = sim.t; }
        b.mesh.position.y = b.y; b.label.position.y = b.y + 0.9;
      });
      if (bodies.every((b) => b.landed)) sim.running = false;
      readout();
    }
    function readout() {
      S.api.setHud(`<div class="phys-eq">${sim.air ? 'F = mg − ½ρC<sub>d</sub>Av²' : 'F = mg  (vacuum)'} · g=${sim.g.toFixed(1)} m/s²</div>` +
        bodies.map((b) => `<div>${b.name}: v=${b.v.toFixed(1)} m/s${b.tLand ? ` · landed ${b.tLand.toFixed(2)}s` : ''}</div>`).join('') +
        `<div class="phys-hint">${sim.air ? 'Air ON: the feather lags — drag dominates its tiny mass.' : 'Vacuum: both land together regardless of mass (Galileo / Apollo 15).'}</div>`);
    }
    S = physicsScaffold(container, w, h, { step, camera: [0, 3, 12], lookAt: [0, 3, 0] });
    S.api.scene.add(groundMesh());
    bodies.forEach((b) => {
      b.mesh = ballMesh(b.r, b.color); b.mesh.position.set(b.x, H0, 0); S.api.scene.add(b.mesh);
      b.label = makeLabelSprite(b.name, { color: '#fff', weight: 800, fontSize: 34, scale: 0.5, depthTest: false });
      b.label.position.set(b.x, H0 + 0.9, 0); S.api.scene.add(b.label);
      b.y = H0; b.v = 0; b.landed = false; b.tLand = null;
    });
    S.api.button('▶ Drop', () => { reset(); sim.running = true; });
    S.api.button('⟲ Reset', reset);
    S.api.toggle('Air resistance', sim.air, (v) => { sim.air = v; reset(); });
    S.api.slider('Gravity', 1.6, 25, 0.1, sim.g, (v) => { sim.g = v; readout(); },
      [{ label: 'Earth', v: 9.8 }, { label: 'Moon', v: 1.6 }, { label: 'Jupiter', v: 24.8 }]);
    readout();
    S.api.ready();
    return S.handle;
  }

  // ---- Projectile motion --------------------------------------------------
  function simProjectile(container, spec, w, h) {
    const sim = { g: 9.8, speed: 14, angle: 45, running: false, t: 0, x: 0, y: 0, vx: 0, vy: 0, landed: false, range: 0, apex: 0 };
    let S, ball, arc, arcPts = [];
    function launch() {
      const a = sim.angle * Math.PI / 180;
      sim.vx = sim.speed * Math.cos(a); sim.vy = sim.speed * Math.sin(a);
      sim.x = 0; sim.y = 0; sim.t = 0; sim.landed = false; sim.running = true; sim.apex = 0;
      arcPts = []; predictArc();
    }
    // Predict the whole trajectory for the faint guide arc + range/apex readout.
    function predictArc() {
      const a = sim.angle * Math.PI / 180;
      const vx = sim.speed * Math.cos(a), vy = sim.speed * Math.sin(a);
      const tEnd = 2 * vy / sim.g;
      sim.range = vx * tEnd;
      sim.apex = (vy * vy) / (2 * sim.g);
      const pts = [];
      for (let i = 0; i <= 40; i += 1) {
        const t = (tEnd * i) / 40;
        pts.push(new THREE.Vector3(vx * t - 6, Math.max(0, vy * t - 0.5 * sim.g * t * t) + 0.2, 0));
      }
      if (arc) S.api.scene.remove(arc);
      arc = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: 0x7c5cff, transparent: true, opacity: 0.5 }));
      S.api.scene.add(arc);
      readout();
    }
    function step(dt) {
      if (!sim.running) { return; }
      sim.t += dt;
      sim.x += sim.vx * dt;
      sim.vy -= sim.g * dt;
      sim.y += sim.vy * dt;
      if (sim.y <= 0) { sim.y = 0; sim.landed = true; sim.running = false; }
      ball.position.set(sim.x - 6, sim.y + 0.2, 0);
      readout();
    }
    function readout() {
      S.api.setHud(`<div class="phys-eq">x = v·cosθ·t · y = v·sinθ·t − ½gt²</div>` +
        `<div>speed=${sim.speed.toFixed(0)} m/s · angle=${sim.angle.toFixed(0)}° · g=${sim.g.toFixed(1)}</div>` +
        `<div>range ≈ ${sim.range.toFixed(1)} m · max height ≈ ${sim.apex.toFixed(1)} m</div>` +
        `<div class="phys-hint">45° gives the greatest range; complementary angles (30° & 60°) share the same range.</div>`);
    }
    S = physicsScaffold(container, w, h, { step, camera: [0, 4, 16], lookAt: [0, 3, 0] });
    S.api.scene.add(groundMesh(28));
    ball = ballMesh(0.4, 0xffd27a); ball.position.set(-6, 0.2, 0); S.api.scene.add(ball);
    S.api.button('▶ Launch', launch);
    S.api.slider('Speed (m/s)', 4, 24, 1, sim.speed, (v) => { sim.speed = v; predictArc(); });
    S.api.slider('Angle (°)', 5, 85, 1, sim.angle, (v) => { sim.angle = v; predictArc(); });
    predictArc();
    S.api.ready();
    return S.handle;
  }

  // ---- Pendulum (length vs period) ---------------------------------------
  function simPendulum(container, spec, w, h) {
    const sim = { g: 9.8, L: 3, theta: Math.PI / 6, omega: 0, pivotY: 7 };
    let S, bob, rod, pivot;
    function period() { return 2 * Math.PI * Math.sqrt(sim.L / sim.g); }
    function step(dt) {
      // Exact pendulum ODE: theta'' = -(g/L) sin(theta). Small damping for realism.
      const alpha = -(sim.g / sim.L) * Math.sin(sim.theta) - 0.02 * sim.omega;
      sim.omega += alpha * dt; sim.theta += sim.omega * dt;
      const bx = sim.L * Math.sin(sim.theta);
      const by = sim.pivotY - sim.L * Math.cos(sim.theta);
      bob.position.set(bx, by, 0);
      // Rebuild rod line.
      rod.geometry.setFromPoints([new THREE.Vector3(0, sim.pivotY, 0), new THREE.Vector3(bx, by, 0)]);
      readout();
    }
    function readout() {
      S.api.setHud(`<div class="phys-eq">T = 2π·√(L / g)</div>` +
        `<div>length L=${sim.L.toFixed(1)} m · g=${sim.g.toFixed(1)} m/s²</div>` +
        `<div>period T ≈ ${period().toFixed(2)} s</div>` +
        `<div class="phys-hint">Period depends on length and gravity — NOT on the bob's mass or (for small swings) the angle.</div>`);
    }
    S = physicsScaffold(container, w, h, { step, camera: [0, 4, 13], lookAt: [0, 4, 0] });
    pivot = new THREE.Mesh(new THREE.BoxGeometry(3, 0.3, 0.6), new THREE.MeshPhongMaterial({ color: 0x243247 }));
    pivot.position.set(0, sim.pivotY + 0.15, 0); S.api.scene.add(pivot);
    rod = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, sim.pivotY, 0), new THREE.Vector3(0, sim.pivotY - sim.L, 0)]), new THREE.LineBasicMaterial({ color: 0x9fb2cd }));
    S.api.scene.add(rod);
    bob = ballMesh(0.5, 0x14d9c4); S.api.scene.add(bob);
    S.api.slider('Length (m)', 1, 6, 0.1, sim.L, (v) => { sim.L = v; readout(); });
    S.api.slider('Gravity', 1.6, 25, 0.1, sim.g, (v) => { sim.g = v; readout(); },
      [{ label: 'Earth', v: 9.8 }, { label: 'Moon', v: 1.6 }]);
    S.api.button('⟲ Reset swing', () => { sim.theta = Math.PI / 6; sim.omega = 0; });
    readout();
    S.api.ready();
    return S.handle;
  }

  // ---- Inclined plane (friction) -----------------------------------------
  function simIncline(container, spec, w, h) {
    const sim = { g: 9.8, angle: 25, mu: 0.3, mass: 2, running: false, s: 0, v: 0 };
    let S, block, wedge;
    const BASE = 9;         // wedge base length (along ground)
    const BLOCK = 0.9;
    function accel() {
      const a = sim.angle * Math.PI / 180;
      const net = Math.sin(a) - sim.mu * Math.cos(a);
      return net > 0 ? sim.g * net : 0;   // static friction holds -> 0
    }
    function willSlide() { const a = sim.angle * Math.PI / 180; return Math.tan(a) > sim.mu; }
    function reset() { sim.s = 0; sim.v = 0; sim.running = false; place(); readout(); }

    // The wedge is a right triangle sitting on the ground: left corner at the
    // top, hypotenuse (the incline surface) running down to the right. The
    // block sits ON that hypotenuse, offset along the surface NORMAL so it
    // rests on top of the ramp, not embedded in it.
    function geomOf(a) {
      const H = BASE * Math.tan(a);          // wedge height at the left
      const x0 = -BASE / 2, x1 = BASE / 2;   // ground span
      const depth = 3;
      // Triangle profile in XY: A(top-left), B(bottom-left), C(bottom-right).
      const A = [x0, H], B = [x0, 0], C = [x1, 0];
      const shape = new THREE.Shape();
      shape.moveTo(A[0], A[1]); shape.lineTo(B[0], B[1]); shape.lineTo(C[0], C[1]); shape.closePath();
      const g = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false });
      g.translate(0, 0, -depth / 2);
      return { geo: g, A, C, H };
    }
    let ramp = geomOf(sim.angle * Math.PI / 180);
    function place() {
      const a = sim.angle * Math.PI / 180;
      // Incline surface goes from top-left A to bottom-right C. Unit vector
      // DOWN the slope and the outward normal.
      const A = ramp.A, C = ramp.C;
      const dx = C[0] - A[0], dy = C[1] - A[1];
      const len = Math.hypot(dx, dy);
      const ux = dx / len, uy = dy / len;          // down-slope unit
      const nx = -uy, ny = ux;                      // outward normal (up-left)
      const half = BLOCK / 2;
      const px = A[0] + ux * sim.s + nx * half;
      const py = A[1] + uy * sim.s + ny * half;
      block.position.set(px, py, 0);
      block.rotation.z = -a;
    }
    function step(dt) {
      if (!sim.running) return;
      sim.v += accel() * dt; sim.s += sim.v * dt;
      const maxS = Math.hypot(ramp.C[0] - ramp.A[0], ramp.C[1] - ramp.A[1]) - BLOCK;
      if (sim.s >= maxS) { sim.s = maxS; sim.running = false; }
      place(); readout();
    }
    function readout() {
      S.api.setHud(`<div class="phys-eq">a = g(sinθ − μcosθ)</div>` +
        `<div>angle θ=${sim.angle.toFixed(0)}° · μ=${sim.mu.toFixed(2)} · mass=${sim.mass.toFixed(1)} kg</div>` +
        `<div>acceleration = ${accel().toFixed(2)} m/s² · ${willSlide() ? 'sliding' : 'held by friction'}</div>` +
        `<div class="phys-hint">Whether it slides depends on tanθ vs μ — NOT on mass. Mass cancels out. It slips once tanθ &gt; μ.</div>`);
    }
    function rebuildWedge() {
      const a = sim.angle * Math.PI / 180;
      if (wedge) S.api.scene.remove(wedge);
      ramp = geomOf(a);
      wedge = new THREE.Mesh(ramp.geo, new THREE.MeshPhongMaterial({ color: 0x2c3b52, flatShading: true }));
      // Sit the whole wedge on the ground (its base is at y=0 already).
      wedge.position.set(0, 0.2, 0);
      S.api.scene.add(wedge);
    }
    S = physicsScaffold(container, w, h, { step, camera: [0, 4, 15], lookAt: [0, 2, 0] });
    S.api.scene.add(groundMesh(24));
    rebuildWedge();
    block = new THREE.Mesh(new THREE.BoxGeometry(BLOCK, BLOCK, BLOCK), new THREE.MeshPhongMaterial({ color: 0xff9f6b }));
    block.position.y = 100;   // parked off-view until placed, avoids a flash
    S.api.scene.add(block);
    S.api.button('▶ Release', () => { reset(); sim.running = true; });
    S.api.button('⟲ Reset', reset);
    S.api.slider('Wedge angle (°)', 5, 60, 1, sim.angle, (v) => { sim.angle = v; rebuildWedge(); reset(); });
    S.api.slider('Friction μ', 0, 1, 0.01, sim.mu, (v) => { sim.mu = v; reset(); });
    S.api.slider('Mass (kg)', 0.5, 10, 0.5, sim.mass, (v) => { sim.mass = v; readout(); });
    reset();
    S.api.ready();
    return S.handle;
  }

  // ---- Collision (1D, momentum + restitution) ----------------------------
  function simCollision(container, spec, w, h) {
    const sim = {
      running: false,
      A: { m: 2, v: 4, x: -6, r: 0.6, color: 0x14d9c4 },
      B: { m: 2, v: 0, x: 3, r: 0.6, color: 0xff6b7a },
      e: 1, wall: false
    };
    let S;
    function reset() { sim.running = false; sim.A.x = -6; sim.A.v = 4; sim.B.x = 3; sim.B.v = 0; place(); readout(); }
    function place() { sim.A.mesh.position.x = sim.A.x; sim.B.mesh.position.x = sim.B.x; }
    function step(dt) {
      if (!sim.running) return;
      sim.A.x += sim.A.v * dt; sim.B.x += sim.B.v * dt;
      // Collision when spheres touch.
      if (sim.A.x + sim.A.r >= sim.B.x - sim.B.r && sim.A.v > sim.B.v) {
        const { m: m1, v: u1 } = sim.A, { m: m2, v: u2 } = sim.B, e = sim.e;
        // 1D collision with restitution e.
        sim.A.v = (m1 * u1 + m2 * u2 - m2 * e * (u1 - u2)) / (m1 + m2);
        sim.B.v = (m1 * u1 + m2 * u2 + m1 * e * (u1 - u2)) / (m1 + m2);
      }
      // Bounce off the side walls to keep them on screen.
      [sim.A, sim.B].forEach((o) => { if (o.x < -9) { o.x = -9; o.v = Math.abs(o.v); } if (o.x > 9) { o.x = 9; o.v = -Math.abs(o.v); } });
      place(); readout();
    }
    function readout() {
      const p = sim.A.m * sim.A.v + sim.B.m * sim.B.v;
      const ke = 0.5 * sim.A.m * sim.A.v * sim.A.v + 0.5 * sim.B.m * sim.B.v * sim.B.v;
      S.api.setHud(`<div class="phys-eq">m₁u₁ + m₂u₂ = m₁v₁ + m₂v₂</div>` +
        `<div>A: m=${sim.A.m.toFixed(1)} v=${sim.A.v.toFixed(2)} · B: m=${sim.B.m.toFixed(1)} v=${sim.B.v.toFixed(2)}</div>` +
        `<div>total momentum ${p.toFixed(2)} · KE ${ke.toFixed(2)} · e=${sim.e.toFixed(2)} (${sim.e >= 0.99 ? 'elastic' : sim.e <= 0.01 ? 'perfectly inelastic' : 'inelastic'})</div>` +
        `<div class="phys-hint">Momentum is always conserved. Kinetic energy is conserved only when e = 1 (elastic).</div>`);
    }
    S = physicsScaffold(container, w, h, { step, camera: [0, 4, 15], lookAt: [0, 1, 0] });
    S.api.scene.add(groundMesh(22));
    sim.A.mesh = ballMesh(sim.A.r, sim.A.color); sim.A.mesh.position.set(sim.A.x, 0.6, 0); S.api.scene.add(sim.A.mesh);
    sim.B.mesh = ballMesh(sim.B.r, sim.B.color); sim.B.mesh.position.set(sim.B.x, 0.6, 0); S.api.scene.add(sim.B.mesh);
    S.api.button('▶ Go', () => { sim.running = true; });
    S.api.button('⟲ Reset', reset);
    S.api.slider('Mass A', 0.5, 8, 0.5, sim.A.m, (v) => { sim.A.m = v; readout(); });
    S.api.slider('Speed A', 0, 8, 0.5, sim.A.v, (v) => { sim.A.v = v; reset(); });
    S.api.slider('Mass B', 0.5, 8, 0.5, sim.B.m, (v) => { sim.B.m = v; readout(); });
    S.api.slider('Bounciness e', 0, 1, 0.05, sim.e, (v) => { sim.e = v; readout(); });
    reset();
    S.api.ready();
    return S.handle;
  }

  // ---- Orbit (circular / elliptical / escape) ----------------------------
  // A satellite orbits a central planet under inverse-square gravity. The
  // velocity slider (as a fraction of circular speed) shows the transition:
  // < circular -> ellipse dipping in; = circular; between circular and escape
  // -> ellipse; >= escape (√2 × circular) -> hyperbolic escape.
  function simOrbit(container, spec, w, h) {
    const GM = 60;                 // gravitational parameter (tuned for view)
    const r0 = 5;                  // launch radius
    const vCirc = Math.sqrt(GM / r0);
    const vEsc = Math.SQRT2 * vCirc;
    const sim = { vfrac: 1.0, running: false };
    let S, planet, sat, trail, trailPts = [], p = { x: 0, y: 0 }, vel = { x: 0, y: 0 };
    function launch() {
      p = { x: r0, y: 0 };
      const v = sim.vfrac * vCirc;
      vel = { x: 0, y: v };        // perpendicular to radius -> clean conic
      trailPts = []; sim.running = true;
    }
    function classify() {
      if (sim.vfrac >= Math.SQRT2 - 0.001) return 'escape (hyperbolic)';
      if (Math.abs(sim.vfrac - 1) < 0.02) return 'circular';
      return sim.vfrac < 1 ? 'ellipse (falls inward)' : 'ellipse (swings out)';
    }
    function step(dt) {
      if (!sim.running) return;
      // Sub-step for stability near the planet.
      const N = 4; const h2 = dt / N;
      for (let i = 0; i < N; i += 1) {
        const r = Math.hypot(p.x, p.y);
        if (r < 0.6) { sim.running = false; break; }     // crashed into planet
        const acc = -GM / (r * r * r);
        vel.x += acc * p.x * h2; vel.y += acc * p.y * h2;
        p.x += vel.x * h2; p.y += vel.y * h2;
      }
      sat.position.set(p.x, p.y, 0);
      trailPts.push(new THREE.Vector3(p.x, p.y, 0));
      if (trailPts.length > 400) trailPts.shift();
      trail.geometry.setFromPoints(trailPts);
      if (Math.hypot(p.x, p.y) > 40) sim.running = false;  // escaped view
      readout();
    }
    function readout() {
      S.api.setHud(`<div class="phys-eq">v_circular = √(GM/r) · v_escape = √2 · v_circular</div>` +
        `<div>launch speed = ${sim.vfrac.toFixed(2)} × circular</div>` +
        `<div>trajectory: ${classify()}</div>` +
        `<div class="phys-hint">At exactly circular speed the orbit is a circle; faster stretches it to an ellipse; at √2× it escapes.</div>`);
    }
    S = physicsScaffold(container, w, h, { step, camera: [0, 0, 26], lookAt: [0, 0, 0] });
    planet = new THREE.Mesh(new THREE.SphereGeometry(0.9, 32, 24), new THREE.MeshPhongMaterial({ color: 0x3a7bd5, emissive: 0x14294a }));
    S.api.scene.add(planet);
    sat = ballMesh(0.28, 0xffd27a); S.api.scene.add(sat);
    trail = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0x14d9c4 }));
    S.api.scene.add(trail);
    S.api.button('▶ Launch', launch);
    S.api.slider('Speed (× circular)', 0.5, 1.6, 0.01, sim.vfrac, (v) => { sim.vfrac = v; readout(); },
      [{ label: 'Circular', v: 1.0 }, { label: 'Escape', v: (Math.SQRT2).toFixed(2) }]);
    readout();
    S.api.ready();
    return S.handle;
  }

  // ---- Wall of death / bike in a well ------------------------------------
  // A bike rides the inside wall of a cylindrical well. The normal force
  // provides the centripetal force (mv²/r); friction (μN) must hold up the
  // weight (mg). Minimum speed to not slip down: v_min = √(gr/μ). The speed
  // slider shows the bike ride steadily above v_min and slip below it.
  function simWellOfDeath(container, spec, w, h) {
    // An inclined bowl (truncated cone): narrow at the bottom, wide at the rim.
    // A bike rides the banked inner wall. On a banked wall the equilibrium
    // radius grows with speed: r = v²/(g·tanβ). So faster -> the bike needs a
    // wider radius -> it climbs the widening bowl. When its equilibrium radius
    // exceeds the rim, it can't be held and flies out over the top.
    const sim = { g: 9.8, wallDeg: 65, speed: 6, angle: 0, y: 0, ejected: false, ejV: null, t: 0 };
    const rBottom = 1.2, rTop = 6, wallH = 6;   // bowl geometry
    let S, bowl, bike, rimRing;

    function wallAngleRad() { return sim.wallDeg * Math.PI / 180; } // from horizontal
    // Local bowl radius at a given height y (0..wallH): linear from rBottom to rTop.
    function radiusAtHeight(y) { return rBottom + (rTop - rBottom) * (y / wallH); }
    // Equilibrium radius the bike "wants" for its current speed.
    function eqRadius() { return (sim.speed * sim.speed) / (sim.g * Math.tan(wallAngleRad())); }
    // Height on the bowl whose local radius equals the equilibrium radius.
    function eqHeight() {
      const rEq = eqRadius();
      const y = ((rEq - rBottom) / (rTop - rBottom)) * wallH;
      return y;
    }

    function reset() { sim.ejected = false; sim.ejV = null; sim.t = 0; sim.y = 0; sim.angle = 0; readout(); }

    function step(dt) {
      sim.t += dt;
      if (sim.ejected) {
        // Free flight after launching over the rim: simple projectile.
        sim.ejV.y -= sim.g * dt;
        sim.ejPos.x += sim.ejV.x * dt;
        sim.ejPos.y += sim.ejV.y * dt;
        sim.ejPos.z += sim.ejV.z * dt;
        bike.position.set(sim.ejPos.x, sim.ejPos.y, sim.ejPos.z);
        bike.rotation.x += dt * 4;   // tumble as it flies out
        if (sim.ejPos.y < -2) reset();
        return;
      }
      // Ride around the wall.
      const rNow = radiusAtHeight(sim.y);
      const omega = sim.speed / Math.max(0.3, rNow);
      sim.angle += omega * dt;
      // Climb / descend toward the equilibrium height for this speed.
      const yTarget = Math.max(0, eqHeight());
      sim.y += (yTarget - sim.y) * Math.min(1, dt * 1.5);
      // Launch out if the equilibrium height exceeds the rim.
      if (eqHeight() > wallH + 0.4) {
        sim.ejected = true;
        const r = radiusAtHeight(wallH);
        const x = r * Math.cos(sim.angle), z = r * Math.sin(sim.angle);
        sim.ejPos = { x, y: wallH + 0.2, z };
        // Tangential + slightly outward/upward launch velocity.
        const tx = -Math.sin(sim.angle), tz = Math.cos(sim.angle);
        sim.ejV = { x: tx * sim.speed + Math.cos(sim.angle) * 2, y: 2.5, z: tz * sim.speed + Math.sin(sim.angle) * 2 };
        readout(); return;
      }
      const r = radiusAtHeight(sim.y);
      const x = r * Math.cos(sim.angle), z = r * Math.sin(sim.angle);
      bike.position.set(x, sim.y + 0.35, z);
      // Lean the bike into the wall: tilt by the wall angle, face travel.
      bike.rotation.set(0, -sim.angle, Math.PI / 2 - wallAngleRad());
      readout();
    }
    function readout() {
      const rEq = eqRadius();
      const willEject = eqHeight() > wallH + 0.4;
      S.api.setHud(`<div class="phys-eq">banked wall: r = v² / (g·tanβ) · N sinβ = mv²/r</div>` +
        `<div>speed=${sim.speed.toFixed(1)} m/s · wall angle β=${sim.wallDeg}° · rim r=${rTop}</div>` +
        `<div>equilibrium radius = ${rEq.toFixed(2)} m · ${sim.ejected ? 'THROWN OUT of the well!' : willEject ? 'about to fly out the top' : 'climbing the wall'}</div>` +
        `<div class="phys-hint">Faster → the bike needs a bigger radius, so it climbs the widening bowl. Past the rim it launches out — raise the speed to see it fly.</div>`);
    }

    S = physicsScaffold(container, w, h, { step, camera: [0, 7, 15], lookAt: [0, 2.5, 0] });

    // Bowl: an open truncated cone (narrow bottom, wide top), inner side shown.
    bowl = new THREE.Mesh(
      new THREE.CylinderGeometry(rTop, rBottom, wallH, 48, 1, true),
      new THREE.MeshPhongMaterial({ color: 0x2c3b52, side: THREE.DoubleSide, transparent: true, opacity: 0.4, flatShading: false })
    );
    bowl.position.y = wallH / 2; S.api.scene.add(bowl);
    // A subtle floor disc at the very bottom of the bowl (small, doesn't cut through).
    const floor = new THREE.Mesh(new THREE.CircleGeometry(rBottom, 32), new THREE.MeshPhongMaterial({ color: 0x1b2740, side: THREE.DoubleSide }));
    floor.rotation.x = -Math.PI / 2; floor.position.y = 0.02; S.api.scene.add(floor);
    // Rim highlight ring at the top.
    const rimPts = [];
    for (let i = 0; i <= 64; i += 1) { const th = (i / 64) * Math.PI * 2; rimPts.push(new THREE.Vector3(rTop * Math.cos(th), wallH, rTop * Math.sin(th))); }
    rimRing = new THREE.Line(new THREE.BufferGeometry().setFromPoints(rimPts), new THREE.LineBasicMaterial({ color: 0x5bd0ff }));
    S.api.scene.add(rimRing);

    bike = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.55, 0.95), new THREE.MeshPhongMaterial({ color: 0xff6b7a }));
    S.api.scene.add(bike);

    S.api.button('⟲ Reset', reset);
    S.api.slider('Speed (m/s)', 2, 16, 0.1, sim.speed, (v) => { sim.speed = v; if (sim.ejected) reset(); readout(); });
    S.api.slider('Wall angle (°)', 45, 85, 1, sim.wallDeg, (v) => { sim.wallDeg = v; if (sim.ejected) reset(); readout(); });
    reset();
    S.api.ready();
    return S.handle;
  }

  // ---- Mirror reflection (flat / concave / convex) -----------------------
  // Parallel rays come in from the left and reflect off a mirror. For a
  // curved mirror they converge to (concave) or appear to diverge from
  // (convex) the focal point at f = R/2. A flat mirror reflects them
  // parallel. Rays reflect about the local surface normal (law of reflection:
  // angle in = angle out).
  function simReflection(container, spec, w, h) {
    const sim = { type: 'concave', R: 8 };   // radius of curvature
    let S, rayGroup, mirror, focalDot, focalLabel;
    const mirrorX = 4;      // mirror sits near the right
    const nRays = 7, span = 5;

    // Mirror surface: returns { y -> point on mirror, normal } sampled.
    function mirrorPointAndNormal(y) {
      if (sim.type === 'flat') return { x: mirrorX, nx: -1, ny: 0 };
      // Spherical mirror centered on the axis. Concave curves toward incoming
      // rays (center of curvature to the LEFT), convex away.
      const R = sim.R;
      const sign = sim.type === 'concave' ? 1 : -1;
      // Circle center at (mirrorX + sign*R, 0). Surface x for given y:
      const cx = mirrorX + sign * R;
      const dx = Math.sqrt(Math.max(0, R * R - y * y));
      const x = cx - sign * dx;
      // Outward normal points from surface toward the incoming side (left).
      let nx = (x - cx), ny = (y - 0);
      const len = Math.hypot(nx, ny) || 1; nx /= len; ny /= len;
      // Make normal face left (toward incoming rays).
      if (nx > 0) { nx = -nx; ny = -ny; }
      return { x, nx, ny };
    }

    function reflect(dx, dy, nx, ny) {
      // r = d - 2(d·n)n
      const dot = dx * nx + dy * ny;
      return { rx: dx - 2 * dot * nx, ry: dy - 2 * dot * ny };
    }

    function build() {
      if (rayGroup) S.api.scene.remove(rayGroup);
      rayGroup = new THREE.Group();
      // Incoming parallel rays travel in +x.
      for (let i = 0; i < nRays; i += 1) {
        const y = -span / 2 + (span * i) / (nRays - 1);
        const hit = mirrorPointAndNormal(y);
        const startX = -8;
        // Incident segment.
        addLine(rayGroup, [new THREE.Vector3(startX, y, 0), new THREE.Vector3(hit.x, y, 0)], 0x5bd0ff);
        // Reflected segment.
        const { rx, ry } = reflect(1, 0, hit.nx, hit.ny);
        const L = 12;
        addLine(rayGroup, [new THREE.Vector3(hit.x, y, 0), new THREE.Vector3(hit.x + rx * L, y + ry * L, 0)], 0x14d9c4);
      }
      S.api.scene.add(rayGroup);
      // Focal point at f = R/2 from the mirror vertex, toward the centre of
      // curvature (concave: in front / real; convex: behind / virtual).
      const f = sim.R / 2;
      const sign = sim.type === 'concave' ? 1 : -1;
      const fx = mirrorX + sign * f;
      focalDot.visible = sim.type !== 'flat';
      focalLabel.visible = sim.type !== 'flat';
      focalDot.position.set(fx, 0, 0);
      focalLabel.position.set(fx, 0.7, 0);
      rebuildMirror();
      readout();
    }
    function rebuildMirror() {
      if (mirror) S.api.scene.remove(mirror);
      const pts = [];
      for (let i = 0; i <= 40; i += 1) {
        const y = -span / 2 + (span * i) / 40;
        const hit = mirrorPointAndNormal(y);
        pts.push(new THREE.Vector3(hit.x, y, 0));
      }
      mirror = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: 0xdfe8f5, linewidth: 2 }));
      S.api.scene.add(mirror);
    }
    function readout() {
      const f = (sim.R / 2).toFixed(1);
      const desc = sim.type === 'flat' ? 'Flat: reflected rays stay parallel (image is virtual, same size).'
        : sim.type === 'concave' ? 'Concave: parallel rays converge to the focal point f = R/2 (real focus).'
        : 'Convex: reflected rays diverge; they appear to come from a virtual focus behind the mirror.';
      S.api.setHud(`<div class="phys-eq">angle of incidence = angle of reflection · f = R / 2</div>` +
        `<div>mirror: ${sim.type}${sim.type !== 'flat' ? ` · R=${sim.R.toFixed(1)} · f=${f}` : ''}</div>` +
        `<div class="phys-hint">${desc}</div>`);
    }
    S = physicsScaffold(container, w, h, { camera: [0, 0, 20], lookAt: [0, 0, 0] });
    focalDot = ballMesh(0.18, 0xffcc66); S.api.scene.add(focalDot);
    focalLabel = makeLabelSprite('F', { color: '#ffcc66', weight: 800, fontSize: 34, scale: 0.5, depthTest: false });
    S.api.scene.add(focalLabel);
    // Mirror-type buttons.
    S.api.button('Flat', () => { sim.type = 'flat'; build(); });
    S.api.button('Concave', () => { sim.type = 'concave'; build(); });
    S.api.button('Convex', () => { sim.type = 'convex'; build(); });
    S.api.slider('Curvature R', 4, 16, 0.5, sim.R, (v) => { sim.R = v; build(); });
    build();
    S.api.ready();
    return S.handle;
  }

  function addLine(group, pts, color) {
    group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color })));
  }

  // ---- DC circuit (Ohm's law + RC charging) ------------------------------
  // A battery drives current around a loop through a resistor. Sliders set
  // voltage and resistance; current I = V/R is shown by the speed/density of
  // moving charge dots. A capacitor toggle switches to an RC circuit where the
  // capacitor charges up (current decays as e^(−t/RC)) and the flow slows to
  // a stop.
  function simCircuit(container, spec, w, h) {
    const sim = { V: 6, R: 3, C: 1, useCap: false, t: 0, vCap: 0 };
    let S, dots = [], loop, capGroup, resGroup;
    // Rectangular loop path (perimeter), current dots travel along it.
    const path = [
      [-5, -3], [5, -3], [5, 3], [-5, 3]
    ];
    const segLen = [];
    let perim = 0;
    for (let i = 0; i < path.length; i += 1) {
      const a = path[i], b = path[(i + 1) % path.length];
      const l = Math.hypot(b[0] - a[0], b[1] - a[1]); segLen.push(l); perim += l;
    }
    function pointAt(d) {
      d = ((d % perim) + perim) % perim;
      for (let i = 0; i < path.length; i += 1) {
        if (d <= segLen[i]) {
          const a = path[i], b = path[(i + 1) % path.length];
          const t = d / segLen[i];
          return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
        }
        d -= segLen[i];
      }
      return path[0];
    }
    function current() {
      if (!sim.useCap) return sim.V / sim.R;                 // Ohm's law
      // RC charging current: I = (V/R) e^(−t/RC).
      return (sim.V / sim.R) * Math.exp(-sim.t / (sim.R * sim.C));
    }
    function step(dt) {
      sim.t += dt;
      const I = current();
      // Dot speed proportional to current (scaled for visibility).
      const speed = I * 1.3;
      dots.forEach((dot) => {
        dot.d += speed * dt;
        const p = pointAt(dot.d);
        dot.mesh.position.set(p[0], p[1], 0);
        dot.mesh.visible = I > 0.02;
      });
      if (sim.useCap) sim.vCap = sim.V * (1 - Math.exp(-sim.t / (sim.R * sim.C)));
      readout();
    }
    function readout() {
      const I = current();
      S.api.setHud(`<div class="phys-eq">${sim.useCap ? 'I(t) = (V/R)·e^(−t/RC) · V_C = V(1−e^(−t/RC))' : 'Ohm: I = V / R'}</div>` +
        `<div>V=${sim.V.toFixed(1)} V · R=${sim.R.toFixed(1)} Ω${sim.useCap ? ` · C=${sim.C.toFixed(1)} F` : ''}</div>` +
        `<div>current I = ${I.toFixed(2)} A${sim.useCap ? ` · capacitor ${sim.vCap.toFixed(2)} V` : ''}</div>` +
        `<div class="phys-hint">${sim.useCap ? 'The capacitor charges up and the current dies away — flow stops when it is full.' : 'More voltage → more current; more resistance → less. Double R and the current halves.'}</div>`);
    }
    S = physicsScaffold(container, w, h, { step, camera: [0, 0, 15], lookAt: [0, 0, 0] });
    // Draw the loop wire.
    const loopPts = path.concat([path[0]]).map((p) => new THREE.Vector3(p[0], p[1], 0));
    loop = new THREE.Line(new THREE.BufferGeometry().setFromPoints(loopPts), new THREE.LineBasicMaterial({ color: 0x9fb2cd }));
    S.api.scene.add(loop);
    // Battery marker (left side) + resistor marker (right side).
    const batt = makeLabelSprite('🔋 battery', { color: '#ffcc66', weight: 700, fontSize: 26, scale: 0.4, depthTest: false });
    batt.position.set(-5, 0, 0); S.api.scene.add(batt);
    const res = makeLabelSprite('▧ resistor', { color: '#ff9f6b', weight: 700, fontSize: 26, scale: 0.4, depthTest: false });
    res.position.set(5, 0, 0); S.api.scene.add(res);
    // Current dots.
    for (let i = 0; i < 16; i += 1) {
      const m = ballMesh(0.16, 0x14d9c4);
      S.api.scene.add(m);
      dots.push({ mesh: m, d: (perim * i) / 16 });
    }
    S.api.button('⟲ Reset', () => { sim.t = 0; sim.vCap = 0; });
    S.api.toggle('Add capacitor (RC)', sim.useCap, (v) => { sim.useCap = v; sim.t = 0; sim.vCap = 0; readout(); });
    S.api.slider('Voltage (V)', 1, 12, 0.5, sim.V, (v) => { sim.V = v; readout(); });
    S.api.slider('Resistance (Ω)', 1, 12, 0.5, sim.R, (v) => { sim.R = v; readout(); });
    S.api.slider('Capacitance (F)', 0.2, 4, 0.1, sim.C, (v) => { sim.C = v; readout(); });
    readout();
    S.api.ready();
    return S.handle;
  }

  // ========================================================================
  //  FLIGHT / GROUND-SCHOOL SIMS
  //  These are concept demonstrations for the four forces and basic
  //  aerodynamics - intuition builders, not a flight simulator.
  // ========================================================================

  // A simple side-view plane silhouette built from primitives, returned as a
  // Group so sims can move/rotate it.
  function planeMesh(color) {
    const g = new THREE.Group();
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.22, 3.4, 16), new THREE.MeshPhongMaterial({ color: color || 0xdfe8f5 }));
    body.rotation.z = Math.PI / 2; g.add(body);
    const nose = new THREE.Mesh(new THREE.ConeGeometry(0.35, 0.7, 16), new THREE.MeshPhongMaterial({ color: color || 0xdfe8f5 }));
    nose.rotation.z = -Math.PI / 2; nose.position.x = 2.0; g.add(nose);
    const wing = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.12, 3.6), new THREE.MeshPhongMaterial({ color: 0xa9b7c9 }));
    g.add(wing);
    const tail = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.9, 0.12), new THREE.MeshPhongMaterial({ color: 0xa9b7c9 }));
    tail.position.set(-1.5, 0.4, 0); g.add(tail);
    const htail = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.1, 1.4), new THREE.MeshPhongMaterial({ color: 0xa9b7c9 }));
    htail.position.set(-1.5, 0, 0); g.add(htail);
    return g;
  }

  // Draw / update a labelled force arrow from an origin in a direction, length
  // proportional to magnitude. Returns an object with an update() method.
  function forceArrow(scene, color, label) {
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 1, 8), new THREE.MeshBasicMaterial({ color }));
    const head = new THREE.Mesh(new THREE.ConeGeometry(0.18, 0.4, 12), new THREE.MeshBasicMaterial({ color }));
    scene.add(shaft); scene.add(head);
    const lab = makeLabelSprite(label, { color: '#eef6ff', weight: 700, fontSize: 26, scale: 0.4, depthTest: false });
    scene.add(lab);
    return {
      shaft, head, lab,
      // origin [x,y], direction angle (rad, 0 = +x), magnitude -> length
      update(ox, oy, ang, mag) {
        const len = Math.max(0.001, mag);
        shaft.visible = head.visible = lab.visible = mag > 0.05;
        shaft.scale.y = len;
        shaft.position.set(ox + Math.cos(ang) * len / 2, oy + Math.sin(ang) * len / 2, 0);
        shaft.rotation.z = ang - Math.PI / 2;
        head.position.set(ox + Math.cos(ang) * len, oy + Math.sin(ang) * len, 0);
        head.rotation.z = ang - Math.PI / 2;
        lab.position.set(ox + Math.cos(ang) * (len + 0.5), oy + Math.sin(ang) * (len + 0.5), 0);
      }
    };
  }

  // ---- 1. Four forces balance --------------------------------------------
  function simFourForces(container, spec, w, h) {
    const sim = { thrust: 5, drag: 5, lift: 5, weight: 5, vx: 0, vy: 0, x: 0, y: 0 };
    let S, plane, aL, aW, aT, aD;
    function step(dt) {
      // Net force -> acceleration (unit mass for the demo) -> drift the plane.
      const ax = (sim.thrust - sim.drag) * 0.15;
      const ay = (sim.lift - sim.weight) * 0.15;
      sim.vx = sim.vx * 0.9 + ax * dt; sim.vy = sim.vy * 0.9 + ay * dt;
      sim.x += sim.vx; sim.y += sim.vy;
      // Keep it gently on screen.
      sim.x = Math.max(-4, Math.min(4, sim.x)); sim.y = Math.max(-2.5, Math.min(2.5, sim.y));
      plane.position.set(sim.x, sim.y, 0);
      const ox = sim.x, oy = sim.y;
      aL.update(ox, oy + 0.3, Math.PI / 2, sim.lift * 0.35);
      aW.update(ox, oy - 0.3, -Math.PI / 2, sim.weight * 0.35);
      aT.update(ox + 0.3, oy, 0, sim.thrust * 0.35);
      aD.update(ox - 0.3, oy, Math.PI, sim.drag * 0.35);
      readout();
    }
    function readout() {
      const vert = sim.lift > sim.weight ? 'climbing' : sim.lift < sim.weight ? 'descending' : 'level';
      const horiz = sim.thrust > sim.drag ? 'accelerating' : sim.thrust < sim.drag ? 'slowing' : 'steady speed';
      S.api.setHud(`<div class="phys-eq">Lift vs Weight → up/down · Thrust vs Drag → speed</div>` +
        `<div>L=${sim.lift.toFixed(1)} W=${sim.weight.toFixed(1)} T=${sim.thrust.toFixed(1)} D=${sim.drag.toFixed(1)}</div>` +
        `<div>${vert} · ${horiz}</div>` +
        `<div class="phys-hint">In steady level flight all four balance: lift = weight, thrust = drag. Tip a pair out of balance and the plane responds.</div>`);
    }
    S = physicsScaffold(container, w, h, { step, camera: [0, 0, 16], lookAt: [0, 0, 0] });
    plane = planeMesh(); S.api.scene.add(plane);
    aL = forceArrow(S.api.scene, 0x14d9c4, 'Lift');
    aW = forceArrow(S.api.scene, 0xff6b7a, 'Weight');
    aT = forceArrow(S.api.scene, 0x5bd0ff, 'Thrust');
    aD = forceArrow(S.api.scene, 0xffcc66, 'Drag');
    S.api.slider('Thrust', 0, 10, 0.1, sim.thrust, (v) => { sim.thrust = v; readout(); });
    S.api.slider('Weight', 0, 10, 0.1, sim.weight, (v) => { sim.weight = v; readout(); });
    S.api.slider('Lift', 0, 10, 0.1, sim.lift, (v) => { sim.lift = v; readout(); });
    S.api.slider('Drag', 0, 10, 0.1, sim.drag, (v) => { sim.drag = v; readout(); });
    S.api.button('⟲ Trim level', () => { sim.thrust = sim.drag = sim.lift = sim.weight = 5; sim.vx = sim.vy = 0; sim.x = sim.y = 0; readout(); });
    readout();
    S.api.ready();
    return S.handle;
  }

  // ---- 2. Lift equation  L = ½·ρ·v²·S·C_L  (with the stall) ---------------
  function simLift(container, spec, w, h) {
    const sim = { v: 50, aoa: 4, rho: 1.0, area: 16 };  // v m/s, aoa deg, rho kg/m3, S m2
    let S, plane, liftArrow, weightArrow;
    const WEIGHT = 11000; // N, ~1100 kg trainer, for a reference line
    // Lift coefficient vs angle of attack: rises ~linearly to the critical
    // angle (~15°), then STALLS - C_L collapses. This is the key teaching point.
    function clOf(aoaDeg) {
      const crit = 15;
      if (aoaDeg <= crit) return 0.1 + 0.1 * aoaDeg;            // ~0.1 per degree
      // Past the stall, lift drops off sharply.
      const over = aoaDeg - crit;
      return Math.max(0.4, (0.1 + 0.1 * crit) - over * 0.12);
    }
    function lift() { return 0.5 * sim.rho * sim.v * sim.v * sim.area * clOf(sim.aoa); }
    function stalled() { return sim.aoa > 15; }
    function step() {
      // Pitch the plane to its angle of attack and scale the lift arrow.
      plane.rotation.z = sim.aoa * Math.PI / 180;
      const L = lift();
      liftArrow.update(0, 0.5, Math.PI / 2, Math.min(6, L / 2500));
      weightArrow.update(0, -0.5, -Math.PI / 2, WEIGHT / 2500);
      readout();
    }
    function readout() {
      const L = lift();
      S.api.setHud(`<div class="phys-eq">L = ½ · ρ · v² · S · C<sub>L</sub></div>` +
        `<div>v=${sim.v.toFixed(0)} m/s · AoA=${sim.aoa.toFixed(0)}° · ρ=${sim.rho.toFixed(2)} · S=${sim.area} m²</div>` +
        `<div>lift ≈ ${(L / 1000).toFixed(1)} kN ${stalled() ? '· ⚠ STALLED — lift collapsing' : L > WEIGHT ? '· climbs' : '· not enough to hold ' + (WEIGHT / 1000).toFixed(0) + ' kN'}</div>` +
        `<div class="phys-hint">Lift grows with the SQUARE of speed. Raising angle of attack adds lift — until ~15°, where the wing stalls and lift drops off a cliff.</div>`);
    }
    S = physicsScaffold(container, w, h, { step, camera: [0, 0, 12], lookAt: [0, 0, 0] });
    plane = planeMesh(); S.api.scene.add(plane);
    liftArrow = forceArrow(S.api.scene, 0x14d9c4, 'Lift');
    weightArrow = forceArrow(S.api.scene, 0xff6b7a, 'Weight');
    S.api.slider('Airspeed (m/s)', 15, 90, 1, sim.v, (v) => { sim.v = v; readout(); });
    S.api.slider('Angle of attack (°)', 0, 22, 0.5, sim.aoa, (v) => { sim.aoa = v; readout(); });
    S.api.slider('Air density (altitude)', 0.4, 1.23, 0.01, sim.rho, (v) => { sim.rho = v; readout(); },
      [{ label: 'Sea level', v: 1.23 }, { label: '10,000 ft', v: 0.9 }, { label: '20,000 ft', v: 0.65 }]);
    S.api.slider('Wing area (m²)', 8, 30, 1, sim.area, (v) => { sim.area = v; readout(); });
    readout();
    S.api.ready();
    return S.handle;
  }

  // ---- 3. Drag curve: parasite + induced vs airspeed ----------------------
  // The famous U-shaped total-drag curve. Parasite drag rises with v²;
  // induced drag (the cost of making lift) falls as v rises. Their sum has a
  // minimum - the best-glide / max-endurance speed. Drawn as a live graph.
  function simDragCurve(container, spec, w, h) {
    const sim = { v: 50, weight: 11000 };
    let S, parasiteLine, inducedLine, totalLine, marker, axes;
    const vMin = 20, vMax = 100;
    // Coefficients tuned so the curves sit nicely on screen.
    const kP = 0.9;         // parasite: D_p = kP * v²
    function dragParasite(v) { return kP * v * v; }
    function dragInduced(v) { return (sim.weight * sim.weight) / (v * v) * 0.02; } // ∝ W²/v²
    function dragTotal(v) { return dragParasite(v) + dragInduced(v); }
    // graph mapping: v in [vMin,vMax] -> x in [-6,6]; drag -> y in [-3,3.5]
    const X0 = -6, X1 = 6, Y0 = -3, dMax = 12000;
    function gx(v) { return X0 + (X1 - X0) * (v - vMin) / (vMax - vMin); }
    function gy(d) { return Y0 + 6 * Math.min(1, d / dMax); }
    function curve(fn, color) {
      const pts = [];
      for (let v = vMin; v <= vMax; v += 2) pts.push(new THREE.Vector3(gx(v), gy(fn(v)), 0));
      return new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color }));
    }
    function rebuild() {
      [parasiteLine, inducedLine, totalLine].forEach((l) => { if (l) S.api.scene.remove(l); });
      parasiteLine = curve(dragParasite, 0xffcc66); S.api.scene.add(parasiteLine);
      inducedLine = curve(dragInduced, 0x5bd0ff); S.api.scene.add(inducedLine);
      totalLine = curve(dragTotal, 0x14d9c4); S.api.scene.add(totalLine);
      readout();
    }
    // Best-glide speed = minimum of total drag (numerically).
    function bestSpeed() {
      let best = vMin, bd = Infinity;
      for (let v = vMin; v <= vMax; v += 0.5) { const d = dragTotal(v); if (d < bd) { bd = d; best = v; } }
      return best;
    }
    function step() {
      marker.position.set(gx(sim.v), gy(dragTotal(sim.v)), 0);
    }
    function readout() {
      const vb = bestSpeed();
      S.api.setHud(`<div class="phys-eq">total drag = parasite (∝v²) + induced (∝W²/v²)</div>` +
        `<div>speed=${sim.v.toFixed(0)} m/s · best-glide ≈ ${vb.toFixed(0)} m/s</div>` +
        `<div>${sim.v < vb ? '⚠ back side of the curve — slower needs MORE power' : 'front side — normal'}</div>` +
        `<div class="phys-hint">Yellow = parasite drag, blue = induced drag, teal = their sum. The bottom of the U is your most efficient speed.</div>`);
    }
    S = physicsScaffold(container, w, h, { step, camera: [0, 0, 13], lookAt: [0, 0, 0] });
    // Axes.
    const axPts = [new THREE.Vector3(X0, Y0, 0), new THREE.Vector3(X1, Y0, 0)];
    const ayPts = [new THREE.Vector3(X0, Y0, 0), new THREE.Vector3(X0, Y0 + 6, 0)];
    S.api.scene.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(axPts), new THREE.LineBasicMaterial({ color: 0x9fb2cd })));
    S.api.scene.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(ayPts), new THREE.LineBasicMaterial({ color: 0x9fb2cd })));
    const xl = makeLabelSprite('airspeed →', { color: '#9fb2cd', weight: 600, fontSize: 22, scale: 0.32, depthTest: false });
    xl.position.set(3, Y0 - 0.5, 0); S.api.scene.add(xl);
    const yl = makeLabelSprite('drag ↑', { color: '#9fb2cd', weight: 600, fontSize: 22, scale: 0.32, depthTest: false });
    yl.position.set(X0 - 0.6, 1, 0); S.api.scene.add(yl);
    marker = ballMesh(0.2, 0xff6b7a); S.api.scene.add(marker);
    S.api.slider('Airspeed (m/s)', vMin, vMax, 1, sim.v, (v) => { sim.v = v; readout(); });
    S.api.slider('Weight (N)', 6000, 16000, 100, sim.weight, (v) => { sim.weight = v; rebuild(); });
    rebuild();
    S.api.ready();
    return S.handle;
  }

  // ---- 4. Stall / angle of attack close-up (airfoil + streamlines) --------
  function simStall(container, spec, w, h) {
    const sim = { aoa: 4 };
    let S, foil, streams = [], liftArrow;
    function clOf(a) { const c = 15; return a <= c ? 0.1 + 0.1 * a : Math.max(0.4, (0.1 + 0.1 * c) - (a - c) * 0.12); }
    function stalled() { return sim.aoa > 15; }
    function buildStreams() {
      streams.forEach((s2) => S.api.scene.remove(s2)); streams = [];
      const a = sim.aoa * Math.PI / 180;
      for (let i = 0; i < 7; i += 1) {
        const y0 = -2.5 + i * 0.85;
        const pts = [];
        for (let x = -6; x <= 6; x += 0.4) {
          // Air deflects over the airfoil; past the stall the flow separates
          // above the wing (turbulent, wavy) instead of following it.
          let y = y0;
          const near = Math.exp(-(x * x) / 6);
          if (y0 > -0.5 && y0 < 1.5) {
            if (!stalled()) y = y0 + near * 0.8 * Math.sin(a);         // attached, smooth bend
            else y = y0 + near * (0.5 + 0.4 * Math.sin(x * 3));        // separated, turbulent
          }
          pts.push(new THREE.Vector3(x, y - x * Math.sin(a) * 0.15, 0));
        }
        const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts),
          new THREE.LineBasicMaterial({ color: stalled() ? 0xff6b7a : 0x5bd0ff, transparent: true, opacity: 0.7 }));
        streams.push(line); S.api.scene.add(line);
      }
      // Rotate the airfoil to the angle of attack.
      if (foil) foil.rotation.z = a;
      liftArrow.update(0, 0.6, Math.PI / 2, Math.min(5, clOf(sim.aoa) * 2.6));
      readout();
    }
    function readout() {
      S.api.setHud(`<div class="phys-eq">C<sub>L</sub> rises with AoA — until the wing stalls (~15°)</div>` +
        `<div>angle of attack = ${sim.aoa.toFixed(0)}° · C<sub>L</sub> ≈ ${clOf(sim.aoa).toFixed(2)}</div>` +
        `<div>${stalled() ? '⚠ STALLED — airflow separated, lift lost' : 'airflow attached — lift rising'}</div>` +
        `<div class="phys-hint">Below the critical angle the air hugs the wing and lift climbs. Past it the flow breaks away and lift collapses — a stall, at ANY speed.</div>`);
    }
    S = physicsScaffold(container, w, h, { step: () => {}, camera: [0, 0, 13], lookAt: [0, 0, 0] });
    // Airfoil: a stretched teardrop.
    const shape = new THREE.Shape();
    shape.moveTo(-2, 0); shape.quadraticCurveTo(-0.5, 0.5, 1.5, 0.12);
    shape.quadraticCurveTo(2, 0, 1.5, -0.05); shape.quadraticCurveTo(-0.5, -0.25, -2, 0);
    foil = new THREE.Mesh(new THREE.ShapeGeometry(shape), new THREE.MeshBasicMaterial({ color: 0xdfe8f5 }));
    S.api.scene.add(foil);
    liftArrow = forceArrow(S.api.scene, 0x14d9c4, 'Lift');
    S.api.slider('Angle of attack (°)', 0, 22, 0.5, sim.aoa, (v) => { sim.aoa = v; buildStreams(); });
    buildStreams();
    S.api.ready();
    return S.handle;
  }

  // ---- 5. Weight & balance / center of gravity ----------------------------
  // Load stations (crew, fuel, baggage); the CG is the weighted average of
  // their positions. Show whether the CG stays inside the safe envelope. This
  // is a required pre-flight check and a real accident cause when done wrong.
  function simWeightBalance(container, spec, w, h) {
    // Stations: arm (fore/aft position in "units"), adjustable weight (kg).
    const sim = {
      stations: [
        { name: 'Crew', arm: 0.8, wt: 160, min: 60, max: 220, color: 0x5bd0ff },
        { name: 'Fuel', arm: 1.1, wt: 120, min: 0, max: 200, color: 0xffcc66 },
        { name: 'Rear pax', arm: 2.2, wt: 80, min: 0, max: 200, color: 0xa78bfa },
        { name: 'Baggage', arm: 2.9, wt: 20, min: 0, max: 120, color: 0xff6b7a }
      ],
      empty: { arm: 1.4, wt: 700 },   // empty aircraft
      // Safe CG envelope (arm units).
      cgFwd: 1.2, cgAft: 1.9
    };
    let S, plane, cgMarker, envelope, weightsGroup;
    function cg() {
      let m = sim.empty.wt, mom = sim.empty.wt * sim.empty.arm;
      sim.stations.forEach((st) => { m += st.wt; mom += st.wt * st.arm; });
      return { cg: mom / m, total: m };
    }
    function inEnvelope(c) { return c >= sim.cgFwd && c <= sim.cgAft; }
    // Map arm [0.5,3.2] -> x [-6,6]
    function ax(arm) { return -6 + (arm - 0.5) * (12 / 2.7); }
    function step() {
      const c = cg();
      cgMarker.position.x = ax(c.cg);
      cgMarker.material.color.setHex(inEnvelope(c.cg) ? 0x14d9c4 : 0xff3b5c);
      readout();
    }
    function readout() {
      const c = cg();
      S.api.setHud(`<div class="phys-eq">CG = Σ(weight × arm) / Σ(weight)</div>` +
        `<div>total weight = ${c.total.toFixed(0)} kg · CG arm = ${c.cg.toFixed(2)}</div>` +
        `<div>${inEnvelope(c.cg) ? '✓ CG inside the safe envelope' : '⚠ CG OUT of limits — unsafe to fly'}</div>` +
        `<div class="phys-hint">Loading changes where the aircraft balances. Too far forward or aft and it becomes hard or impossible to control — always check before flight.</div>`);
    }
    S = physicsScaffold(container, w, h, { step, camera: [0, 0, 13], lookAt: [0, 0, 0] });
    plane = planeMesh(); plane.scale.set(1.4, 1.4, 1.4); plane.position.y = 1.6; S.api.scene.add(plane);
    // Safe envelope band.
    const eGeo = new THREE.PlaneGeometry(ax(sim.cgAft) - ax(sim.cgFwd), 0.7);
    envelope = new THREE.Mesh(eGeo, new THREE.MeshBasicMaterial({ color: 0x14d9c4, transparent: true, opacity: 0.18 }));
    envelope.position.set((ax(sim.cgFwd) + ax(sim.cgAft)) / 2, -0.5, 0); S.api.scene.add(envelope);
    const envLabel = makeLabelSprite('safe CG range', { color: '#14d9c4', weight: 600, fontSize: 20, scale: 0.3, depthTest: false });
    envLabel.position.set((ax(sim.cgFwd) + ax(sim.cgAft)) / 2, -1.1, 0); S.api.scene.add(envLabel);
    // A datum line.
    S.api.scene.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(-6, -0.5, 0), new THREE.Vector3(6, -0.5, 0)]), new THREE.LineBasicMaterial({ color: 0x3a4a60 })));
    cgMarker = new THREE.Mesh(new THREE.ConeGeometry(0.25, 0.5, 4), new THREE.MeshBasicMaterial({ color: 0x14d9c4 }));
    cgMarker.rotation.z = Math.PI; cgMarker.position.y = -0.1; S.api.scene.add(cgMarker);
    sim.stations.forEach((st) => {
      S.api.slider(`${st.name} (kg)`, st.min, st.max, 5, st.wt, (v) => { st.wt = v; readout(); });
    });
    readout();
    S.api.ready();
    return S.handle;
  }

  // ---- 6. Glide ratio / engine-out ---------------------------------------
  // Engine fails at altitude. The glide ratio (L/D) sets how far the aircraft
  // travels forward per unit of height lost. Slider for glide ratio; watch the
  // reachable distance and the glide path.
  function simGlide(container, spec, w, h) {
    const sim = { ratio: 9, altitude: 5, x: -7, y: 5, gliding: false, vx: 0 };
    let S, plane, path, groundLine, reachLabel;
    const startX = -7, startY = 5;
    function reach() { return sim.altitude * sim.ratio; }   // horizontal distance (km-ish units)
    // Map: altitude 0..6 -> y -3..5 ; distance scaled to x.
    function drawPath() {
      if (path) S.api.scene.remove(path);
      const pts = [];
      const dist = reach();
      const scale = 12 / Math.max(dist, 1);   // fit reachable distance across the view
      for (let i = 0; i <= 30; i += 1) {
        const t = i / 30;
        const x = startX + t * dist * scale;
        const y = startY - t * startY - t * 3;   // descend to below ground line
        pts.push(new THREE.Vector3(x, Math.max(-3, startY * (1 - t)) - 0.0, 0));
      }
      path = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: 0x14d9c4, transparent: true, opacity: 0.6 }));
      S.api.scene.add(path);
      readout();
    }
    function reset() { sim.x = startX; sim.y = startY; sim.gliding = false; plane.position.set(startX, startY, 0); plane.rotation.z = 0; }
    function step(dt) {
      if (!sim.gliding) return;
      const dist = reach();
      const scale = 12 / Math.max(dist, 1);
      sim.x += dt * 3;
      const t = Math.min(1, (sim.x - startX) / (dist * scale));
      sim.y = startY * (1 - t);
      plane.position.set(sim.x, sim.y, 0);
      plane.rotation.z = -Math.atan2(startY, dist * scale) * 0.6;
      if (t >= 1) sim.gliding = false;
      readout();
    }
    function readout() {
      S.api.setHud(`<div class="phys-eq">glide distance = height × glide ratio (L/D)</div>` +
        `<div>glide ratio = ${sim.ratio.toFixed(0)}:1 · height = ${sim.altitude.toFixed(1)} (units)</div>` +
        `<div>reaches ≈ ${reach().toFixed(1)} forward per this height</div>` +
        `<div class="phys-hint">With the engine out, a ${sim.ratio.toFixed(0)}:1 glide ratio means the aircraft travels ${sim.ratio.toFixed(0)} units forward for every 1 unit of height lost. Best-glide speed maximizes this reach.</div>`);
    }
    S = physicsScaffold(container, w, h, { step, camera: [0, 1, 15], lookAt: [0, 1, 0] });
    // Ground.
    groundLine = new THREE.Mesh(new THREE.BoxGeometry(20, 0.3, 3), new THREE.MeshPhongMaterial({ color: 0x243247 }));
    groundLine.position.y = -0.2; S.api.scene.add(groundLine);
    plane = planeMesh(); plane.scale.set(0.7, 0.7, 0.7); S.api.scene.add(plane);
    reset();
    S.api.button('▶ Engine out', () => { reset(); sim.gliding = true; });
    S.api.button('⟲ Reset', reset);
    S.api.slider('Glide ratio (L/D)', 4, 20, 1, sim.ratio, (v) => { sim.ratio = v; drawPath(); },
      [{ label: 'Trainer 9:1', v: 9 }, { label: 'Glider 40:1', v: 20 }]);
    S.api.slider('Height (units)', 1, 6, 0.5, sim.altitude, (v) => { sim.altitude = v; drawPath(); });
    drawPath();
    S.api.ready();
    return S.handle;
  }

  // ---- Course Deviation Indicator (CDI / VOR navigation) -----------------
  // A VOR station sits at the origin; the pilot selects a course (OBS) and the
  // instrument shows how far the aircraft is off that course. Standard VOR:
  // full-scale deflection = 10 degrees off course, 5 dots per side (2 deg/dot).
  // Rule taught to students: the needle shows which way to fly to get back on
  // course - "fly toward the needle." A TO/FROM flag shows whether the selected
  // course leads toward or away from the station.
  function simCDI(container, spec, w, h) {
    const sim = { obs: 0, acX: 2.5, acY: 4 }; // obs = selected course (deg), aircraft position (scene units)
    let S, station, courseLine, aircraft, needle, toFromLab;
    const R = 6;               // scene radius for the map view
    const instX = 5, instY = 0; // CDI instrument face centre (declared up front)

    // Bearing FROM the station to the aircraft (deg, 0 = north/up, clockwise).
    function bearingToAircraft() {
      const ang = Math.atan2(sim.acX, sim.acY) * 180 / Math.PI; // x=east, y=north
      return (ang + 360) % 360;
    }
    // Angular deviation of the aircraft from the selected radial, signed.
    function deviationDeg() {
      let d = bearingToAircraft() - sim.obs;
      // normalize to [-180,180]
      while (d > 180) d -= 360; while (d < -180) d += 360;
      return d;
    }
    // TO/FROM: FROM if the aircraft is on the selected-radial side of the
    // station, TO if it's on the reciprocal side.
    function toFrom() {
      const dev = deviationDeg();
      return Math.abs(dev) <= 90 ? 'FROM' : 'TO';
    }
    // Needle deflection clamped to full-scale 10 deg. The needle deflects
    // OPPOSITE to the aircraft's offset (fly toward the needle).
    function needleDeg() {
      let dev = deviationDeg();
      // On the TO side the sensing flips; fold onto the +/-90 window.
      if (dev > 90) dev = 180 - dev; if (dev < -90) dev = -180 - dev;
      return Math.max(-10, Math.min(10, dev));
    }

    function step() {
      // Map view: station center, course line along OBS, aircraft dot.
      aircraft.position.set(sim.acX, sim.acY, 0);
      const a = sim.obs * Math.PI / 180;
      // Course line points along the selected radial (from station outward).
      const ex = Math.sin(a), ey = Math.cos(a);
      courseLine.geometry.setFromPoints([
        new THREE.Vector3(-ex * R, -ey * R, 0), new THREE.Vector3(ex * R, ey * R, 0)
      ]);
      // Instrument: needle deflects horizontally. Full scale (10 deg) -> +/-1.8 units.
      const nd = needleDeg();
      // Aircraft RIGHT of course -> needle deflects LEFT (fly left). So needle
      // x is opposite the sign of deviation.
      const nx = -(nd / 10) * 1.8;
      needle.geometry.setFromPoints([
        new THREE.Vector3(instX + nx, instY + 1.6, 0), new THREE.Vector3(instX + nx, instY - 1.6, 0)
      ]);
      if (toFromLab) toFromLab.text = toFrom();   // (label text is static sprite; TO/FROM shown in HUD)
      readout();
    }
    function readout() {
      const dev = deviationDeg();
      const nd = needleDeg();
      const dots = Math.abs(nd) / 2;
      const side = nd > 0.1 ? 'aircraft LEFT of course → fly right' : nd < -0.1 ? 'aircraft RIGHT of course → fly left' : 'on course';
      S.api.setHud(`<div class="phys-eq">full scale = 10° off course · each dot = 2° · fly toward the needle</div>` +
        `<div>selected course (OBS) = ${sim.obs.toFixed(0)}° · deviation = ${dev.toFixed(1)}° · ${toFrom()}</div>` +
        `<div>needle: ${Math.abs(nd).toFixed(1)}° (${dots.toFixed(1)} dots) · ${side}</div>` +
        `<div class="phys-hint">The needle points to the course. If it sits right, the course is to your right — turn toward it. Full deflection means 10°+ off. Move the aircraft or turn the OBS and watch it respond.</div>`);
    }

    S = physicsScaffold(container, w, h, { step, camera: [0, 0, 16], lookAt: [0, 0, 0] });

    // ----- Left: map view -----
    const mapGroup = new THREE.Group(); mapGroup.position.set(-4.5, 0, 0); S.api.scene.add(mapGroup);
    // VOR station (compass rose circle).
    const rosePts = [];
    for (let i = 0; i <= 64; i += 1) { const th = (i / 64) * Math.PI * 2; rosePts.push(new THREE.Vector3(Math.cos(th) * R, Math.sin(th) * R, 0)); }
    mapGroup.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(rosePts), new THREE.LineBasicMaterial({ color: 0x3a4a60 })));
    station = new THREE.Mesh(new THREE.SphereGeometry(0.3, 16, 12), new THREE.MeshBasicMaterial({ color: 0xffcc66 }));
    mapGroup.add(station);
    mapGroup.add(makeLabelSprite('VOR', { color: '#ffcc66', weight: 700, fontSize: 22, scale: 0.34, depthTest: false }));
    courseLine = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, -R, 0), new THREE.Vector3(0, R, 0)]), new THREE.LineBasicMaterial({ color: 0x14d9c4 }));
    mapGroup.add(courseLine);
    aircraft = planeMesh(0x5bd0ff); aircraft.scale.set(0.35, 0.35, 0.35); mapGroup.add(aircraft);

    // ----- Right: the CDI instrument face -----
    // instrument circle
    const facePts = [];
    for (let i = 0; i <= 64; i += 1) { const th = (i / 64) * Math.PI * 2; facePts.push(new THREE.Vector3(instX + Math.cos(th) * 2.4, instY + Math.sin(th) * 2.4, 0)); }
    S.api.scene.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(facePts), new THREE.LineBasicMaterial({ color: 0x9fb2cd })));
    // dots (5 per side, at +/-2,4,6,8,10 deg -> +/-0.36..1.8)
    for (let k = -5; k <= 5; k += 1) {
      if (k === 0) continue;
      const dot = new THREE.Mesh(new THREE.CircleGeometry(0.08, 12), new THREE.MeshBasicMaterial({ color: 0x6b7d95 }));
      dot.position.set(instX + (k / 5) * 1.8, instY, 0);
      S.api.scene.add(dot);
    }
    // center reference
    const ctr = new THREE.Mesh(new THREE.CircleGeometry(0.12, 16), new THREE.MeshBasicMaterial({ color: 0xffffff }));
    ctr.position.set(instX, instY, 0); S.api.scene.add(ctr);
    // the deviation needle (vertical bar that slides left/right)
    needle = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(instX, instY + 1.6, 0), new THREE.Vector3(instX, instY - 1.6, 0)]), new THREE.LineBasicMaterial({ color: 0x14d9c4 }));
    S.api.scene.add(needle);
    const cdiLab = makeLabelSprite('CDI', { color: '#eef6ff', weight: 800, fontSize: 24, scale: 0.4, depthTest: false });
    cdiLab.position.set(instX, instY + 3, 0); S.api.scene.add(cdiLab);
    toFromLab = makeLabelSprite('FROM', { color: '#14d9c4', weight: 800, fontSize: 22, scale: 0.34, depthTest: false });
    toFromLab.position.set(instX, instY - 3, 0); S.api.scene.add(toFromLab);

    S.api.slider('Aircraft east/west', -5, 5, 0.1, sim.acX, (v) => { sim.acX = v; readout(); });
    S.api.slider('Aircraft north/south', -5, 5, 0.1, sim.acY, (v) => { sim.acY = v; readout(); });
    S.api.slider('Selected course OBS (°)', 0, 359, 1, sim.obs, (v) => { sim.obs = v; readout(); });
    readout();
    S.api.ready();
    return S.handle;
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
