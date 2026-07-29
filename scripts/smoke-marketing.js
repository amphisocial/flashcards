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
      ok('testimonials carry the FTC beta-access disclosure',
        (r.body.match(/Received free beta access/g) || []).length >= 3);
      ok('testimonials name role + state, not anonymous',
        /8th-grade physical science · Massachusetts/.test(r.body));
      ok('3D demo holders still present for viz3d to mount',
        (r.body.match(/class="demo3d-holder"/g) || []).length >= 4);
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
    for (const a of ['/lesson.css', '/lesson.js', '/graphdemo.js', '/styles.css', '/landing3d.css']) {
      const r = await get(a);
      ok(a, r.status === 200, `status ${r.status}`);
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
