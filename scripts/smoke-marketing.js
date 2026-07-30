/*
 * Boots the real server on a scratch port, hits every marketing/acquisition
 * route, asserts on the response, and exits. Self-contained so it works in
 * environments that don't keep background processes alive between commands.
 *
 * Run: node scripts/smoke-marketing.js
 */
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');

const PORT = 3123;
const BASE = `http://127.0.0.1:${PORT}`;
const SLUGS = require(path.join(__dirname, '..', 'public', 'lessons', 'slugs.json'));

function get(p) {
  return new Promise((resolve, reject) => {
    const req = http.get(`${BASE}${p}`, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body, type: res.headers['content-type'] || '' }));
    });
    req.on('error', reject);
    req.setTimeout(8000, () => { req.destroy(new Error('timeout')); });
  });
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
}

(async () => {
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), SESSION_SECRET: 'smoke-test', APP_BASE_URL: '' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  srv.stdout.on('data', () => {});
  srv.stderr.on('data', () => {});

  // Poll until the health endpoint answers.
  let up = false;
  for (let i = 0; i < 40; i++) {
    try { const r = await get('/api/health'); if (r.status === 200) { up = true; break; } } catch (_) {}
    await wait(250);
  }
  if (!up) { console.log('  FAIL server never came up'); srv.kill(); process.exit(1); }
  console.log('server up\n');

  try {
    console.log('homepage');
    {
      const r = await get('/');
      ok('200', r.status === 200, `status ${r.status}`);
      ok('leads with the single positioning statement',
        /turns a teacher's explanation into a live simulation/i.test(r.body));
      ok('states the grade band 5–9', /Grades?\s*5[–-]9/i.test(r.body));
      ok('names all four subjects',
        /Math/.test(r.body) && /Science/.test(r.body) && /Geography/.test(r.body) && /History/.test(r.body));
      ok('references Common Core & NGSS', /Common Core/i.test(r.body) && /NGSS/i.test(r.body));
      ok('has the Founding 30 recruitment block', /Founding 30/i.test(r.body));
      ok('thin Founding-30 attention strip up top', /founding-strip/.test(r.body));
      ok('hero showcases the interactive quadratic graph (not the globe)',
        /id="heroGraph"[^>]*data-family="parabola"/.test(r.body) && !/id="heroEarth"/.test(r.body));
      ok('hero graph widget script + shared css loaded',
        /graphdemo\.js/.test(r.body) && /viz3d\.css/.test(r.body));
      ok('testimonials carry the FTC beta-access disclosure',
        (r.body.match(/Received free beta access/g) || []).length >= 3);
      ok('testimonials name role + state, not anonymous',
        /8th-grade physical science · Massachusetts/.test(r.body));
      ok('3D science grid still present for viz3d to mount',
        (r.body.match(/class="demo3d-holder"/g) || []).length >= 3);
    }

    console.log('\nconcept pages');
    for (const slug of SLUGS) {
      const r = await get(`/${slug}`);
      const good =
        r.status === 200 &&
        /<h1>/.test(r.body) &&
        /Try this lesson free/.test(r.body) &&
        /Received free beta access/.test(r.body) &&
        /teach-steps/.test(r.body);
      ok(`/${slug}`, good, `status ${r.status}`);
    }

    console.log('\nquadratic page uses the real interactive widget');
    {
      const r = await get('/interactive-quadratic-graph');
      ok('mounts a graph demo, not a placeholder globe', /data-demo="graph"/.test(r.body));
      ok('declares the parabola family', /data-family="parabola"/.test(r.body));
      ok('loads graphdemo.js', /graphdemo\.js/.test(r.body));
      ok('caption promises live sliders', /drag a, b and c/i.test(r.body));
    }

    console.log('\nstatic assets');
    for (const a of ['/lesson.css', '/lesson.js', '/graphdemo.js', '/viz3d.css', '/viz3d.js', '/styles.css', '/landing3d.css', '/board-templates.js', '/pricing.css', '/pricing.js']) {
      const r = await get(a);
      ok(a, r.status === 200, `status ${r.status}`);
    }

    console.log('\nAI Workbench + boards + founder-apply wiring');
    {
      // Founder button on the homepage must carry the founding flag + wire.
      const home = await get('/');
      ok('homepage has an "Apply as a founding teacher" button', /ctaFounding/.test(home.body) || /founding teacher/i.test(home.body));
      const landingJs = await get('/landing.js');
      ok('founder button sets the founding30 flag before signup', /founding30/.test(landingJs.body));
      const commonJs = await get('/common.js');
      ok('signup submits the founder application when flagged',
        /\/api\/founder\/apply/.test(commonJs.body) && /founding30/.test(commonJs.body));

      const libJs = await get('/library.js');
      ok('workbench has a Yours/Shared scope switch',
        /workbenchToggle/.test(libJs.body) && /switchScope/.test(libJs.body));
      const boardJs = await get('/board-list.js');
      ok('boards default scope keys off create ability',
        /canCreate \? 'mine' : 'shared'/.test(boardJs.body));
    }

    console.log('\n3D/physics viewer chrome is styled off the whiteboard');
    {
      // The physics HUD, control bar, and fullscreen button are built by
      // viz3d.js and positioned absolutely; without viz3d.css on these pages
      // they render as unstyled text that overlaps the caption (the reported
      // bug). Assert the stylesheet is linked and actually defines the
      // classes the JS emits.
      const page = await get('/interactive-newtons-laws-simulation');
      ok('lesson page links viz3d.css', /viz3d\.css/.test(page.body));
      const home = await get('/');
      ok('homepage links viz3d.css', /viz3d\.css/.test(home.body));

      const css = await get('/viz3d.css');
      const needed = ['.phys-hud', '.phys-controls', '.phys-btn', '.phys-slider',
        '.phys-toggle', '.phys-presets', '.viz3d-fs-btn', '.viz3d-mode-btn', '.viz3d-back-btn'];
      needed.forEach((sel) => ok(`viz3d.css defines ${sel}`, css.body.includes(sel)));
      ok('phys-controls is absolutely positioned (won\'t spill onto caption)',
        /\.phys-controls\s*\{[^}]*position:\s*absolute/.test(css.body));
      ok('phys-hud height-capped so it can\'t overlap the control bar',
        /\.phys-hud\s*\{[^}]*max-height/.test(css.body));
      ok('the run button is visually primary',
        /\.phys-controls \.phys-btn:first-of-type/.test(css.body));
      ok('fullscreen button is large/visible (>=42px)',
        /\.viz3d-fs-btn\s*\{[^}]*width:\s*42px/.test(css.body));
    }

    console.log('\nSEO plumbing');
    {
      const rb = await get('/robots.txt');
      ok('robots.txt served', rb.status === 200);
      ok('robots keeps app pages out of the index', /Disallow: \/board/.test(rb.body));
      ok('robots points at the sitemap', /Sitemap: .*\/sitemap\.xml/.test(rb.body));

      const sm = await get('/sitemap.xml');
      ok('sitemap served as xml', sm.status === 200 && /xml/.test(sm.type));
      ok('sitemap uses the valid sitemaps.org namespace',
        /www\.sitemaps\.org\/schemas\/sitemap\/0\.9/.test(sm.body));
      ok('sitemap lists every concept page',
        SLUGS.every((s) => sm.body.includes(`/${s}<`)));
      ok('sitemap includes the homepage', /<loc>[^<]+\/<\/loc>/.test(sm.body));
    }

    console.log('\nregression: existing app routes still resolve');
    {
      const h = await get('/api/health');
      ok('/api/health', h.status === 200);
      // Unknown paths should still fall through to the SPA homepage.
      const nf = await get('/some-unknown-path');
      ok('unknown path falls back to homepage', nf.status === 200 && /AthenaBoard/.test(nf.body));
    }
  } catch (e) {
    fail++;
    console.log(`  FAIL threw: ${e.message}`);
  }

  srv.kill();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
