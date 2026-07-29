/*
 * build-lesson-pages.js
 *
 * Generates one SEO landing page per concept teachers actually search for
 * (the Chalkie-style "narrow subject/grade/concept" acquisition pages from
 * the traction plan). Each page is a static HTML file under public/lessons/,
 * served at a clean slug (e.g. /interactive-newtons-laws-simulation) by an
 * explicit Express route added in server/server.js.
 *
 * Run:  node scripts/build-lesson-pages.js
 *
 * Every page has the same skeleton so the set stays consistent and easy to
 * extend: a live embedded demo, a short teaching outline, the relevant
 * standard, one verifiable teacher quote (with FTC beta-access disclosure),
 * and a single "Try this lesson free" call to action.
 */
const fs = require('fs');
const path = require('path');

const OUT_DIR = path.join(__dirname, '..', 'public', 'lessons');

// demo: which live viz3d/physics demo to embed. Reuses the same mount path
// the marketing homepage uses (viz3d.js), driven by data-demo / data-sim.
const PAGES = [
  {
    slug: 'interactive-newtons-laws-simulation',
    subject: 'Science',
    grade: 'Grades 6–9',
    standard: 'NGSS MS-PS2-2',
    h1: 'Interactive Newton\'s Laws Simulation',
    tagline: 'Change the force and the mass — watch acceleration respond, live, in front of the class.',
    demo: { kind: 'physics', sim: 'freefall', cap: 'Drop a feather and a stone in real gravity. Toggle air resistance; switch to Moon gravity.' },
    intro: 'Students memorize F = ma without ever feeling it. On AthenaBoard you write the equation by hand, hit Analyze, and it becomes a running simulation the whole class can push on. Turn air resistance off and the feather and the hammer land together — the Apollo-15 moment, on a Chromebook.',
    outline: [
      'Warm-up (5 min): ask the class to predict which lands first — a feather or a stone. Take a vote.',
      'Reveal (10 min): run the drop with air resistance ON, then OFF. Let a student change gravity to the Moon.',
      'Explore (15 min): students on their own screens change mass and force and describe what happens to acceleration.',
      'Check (10 min): tap Analyze for the worked F = ma steps, then push a 3-question check to every device.'
    ],
    quote: {
      text: 'My students could change the ramp angle themselves and immediately see why the acceleration changed.',
      name: 'Jennifer M.', role: '8th-grade physical science · Massachusetts'
    }
  },
  {
    slug: 'pulley-force-simulation-for-teachers',
    subject: 'Science',
    grade: 'Grades 6–9',
    standard: 'NGSS MS-PS2',
    h1: 'Pulley &amp; Mechanical-Advantage Simulation',
    tagline: 'Add a pulley, feel the force needed drop — the trade between force and distance made visible.',
    demo: { kind: 'physics', sim: 'incline', cap: 'A block on a ramp: change the angle, friction and mass and watch what actually moves.' },
    intro: 'Mechanical advantage is one of those ideas that lands the moment students can pull the rope themselves. AthenaBoard turns your sketch of a pulley system into an interactive model where the force-vs-distance trade is something the class changes and measures, not something they copy off a slide.',
    outline: [
      'Hook (5 min): ask why a single fixed pulley makes lifting feel easier — collect guesses.',
      'Model (10 min): sketch the system on the board; AthenaBoard renders the forces.',
      'Explore (15 min): add pulleys and watch required force halve while the rope you pull doubles.',
      'Formalize (10 min): Analyze writes out mechanical advantage; push a quick check to students.'
    ],
    quote: {
      text: 'Rope, force, distance — they finally connected because they were the ones moving the slider.',
      name: 'Marcus T.', role: '6th-grade science · Illinois'
    }
  },
  {
    slug: 'block-on-wedge-physics-simulation',
    subject: 'Science',
    grade: 'Grades 7–9',
    standard: 'NGSS MS-PS2-2',
    h1: 'Block-on-a-Wedge Physics Simulation',
    tagline: 'Tilt the ramp, change the friction — the block slides when tanθ beats μ, and mass never matters.',
    demo: { kind: 'physics', sim: 'incline', cap: 'Wedge angle, friction μ and mass sliders. The block holds, then slides.' },
    intro: 'The inclined plane is where students first meet the surprising truth that a heavy block and a light block slide at the same angle. Instead of asserting it, let them try to break it: raise the mass as high as it goes and watch the slide angle refuse to change.',
    outline: [
      'Predict (5 min): does a heavier block slide at a smaller angle? Vote.',
      'Test (10 min): raise the mass slider to the max — the slide angle doesn\'t move.',
      'Explain (15 min): reveal a = g(sinθ − μcosθ); students find the angle where sliding begins.',
      'Check (10 min): Analyze the board and push a short check on tanθ vs μ.'
    ],
    quote: {
      text: 'Watching the class realize mass cancels — that was the whole lesson, and it took two minutes.',
      name: 'Elena V.', role: '9th-grade physics · Arizona'
    }
  },
  {
    slug: 'laws-of-reflection-whiteboard',
    subject: 'Science',
    grade: 'Grades 6–9',
    standard: 'NGSS MS-PS4-2',
    h1: 'Laws of Reflection Whiteboard',
    tagline: 'Parallel rays hit flat, concave and convex mirrors — watch them converge on the focus.',
    demo: { kind: 'physics', sim: 'mirror', cap: 'Flat, concave and convex mirrors. A curvature slider moves the focus.' },
    intro: 'Reflection is easy to state and hard to picture. AthenaBoard draws the rays for you: flat mirrors keep them parallel, concave mirrors pull them to a real focus at f = R/2, convex mirrors spread them from a virtual one. Change the curvature and the focus slides with it.',
    outline: [
      'Recall (5 min): angle of incidence = angle of reflection — sketch it.',
      'Show (10 min): send parallel rays at a flat mirror, then a concave one.',
      'Explore (15 min): students move the curvature slider and locate the focus.',
      'Apply (10 min): where does the focus go on a convex mirror? Analyze and check.'
    ],
    quote: {
      text: 'The rays actually bending to the focus did more than any diagram I\'ve drawn in ten years.',
      name: 'Priya S.', role: '9th-grade physical science · California'
    }
  },
  {
    slug: 'interactive-quadratic-graph',
    subject: 'Math',
    grade: 'Grades 8–9',
    standard: 'Common Core 8.F.B / HSA-REI',
    h1: 'Interactive Quadratic Graph',
    tagline: 'Drag a, b and c and watch the parabola open, tilt and lift — live, while students watch.',
    demo: { kind: 'graph', family: 'parabola', cap: 'This is live — drag a, b and c and watch the parabola open, tilt and lift.' },
    intro: 'A quadratic is three numbers most students never connect to a shape. Write y = ax² + bx + c on the board and AthenaBoard gives you a slider for each one — a opens or flips the parabola, c lifts it, b tilts it. Every student sees the same curve move on their own screen.',
    outline: [
      'Open (5 min): write y = x² and ask what changes if we add a number.',
      'Vary c (10 min): drag c and watch the whole parabola rise and fall.',
      'Vary a and b (15 min): students find the a that flips it and the b that shifts the vertex.',
      'Connect (10 min): tie each slider back to the equation; push a check.'
    ],
    quote: {
      text: 'I dragged the slope slider and the whole class said "ohhh" at the same time.',
      name: 'Daniel R.', role: '7th-grade math · Texas'
    }
  },
  {
    slug: '3d-molecule-whiteboard',
    subject: 'Science',
    grade: 'Grades 8–9',
    standard: 'NGSS MS-PS1',
    h1: '3D Molecule Whiteboard',
    tagline: 'Name or draw a compound; rotate the ball-and-stick model and zoom into an atom\'s electron shells.',
    demo: { kind: 'molecule', cap: 'Acetic acid, CH₃COOH. Drag to rotate; click an atom for its electron shells.' },
    intro: 'A molecule drawn flat on a board hides the thing that matters: its shape. AthenaBoard turns a name or a sketch into a rotatable 3D model with correct bonds, then lets a student click any atom to fly into its electron shells — protons, shells, and valence electrons, all labeled.',
    outline: [
      'Recall (5 min): what does a structural formula not tell us? (Shape.)',
      'Build (10 min): name a compound; rotate the model as a class.',
      'Zoom in (15 min): click an atom, count the valence electrons, connect to bonding.',
      'Check (10 min): Analyze the structure and push a short check.'
    ],
    quote: {
      text: 'Rotating a real molecule instead of pointing at a flat picture changed how they talked about bonds.',
      name: 'Priya S.', role: '9th-grade physical science · California'
    }
  },
  {
    slug: '3d-teaching-globe-for-classrooms',
    subject: 'Geography',
    grade: 'Grades 5–9',
    standard: 'Geography 5–9',
    h1: '3D Teaching Globe for Classrooms',
    tagline: 'A rotatable globe — real borders, capitals, rivers, the equator and tropics, with labels that appear as you zoom.',
    demo: { kind: 'earth', cap: 'Drag to spin, scroll to zoom. Toggle satellite and political maps.' },
    intro: 'A flat map distorts everything; a globe fixes it, but you can only own one and only one student can spin it. AthenaBoard puts a real teaching globe on every screen — satellite or political, with country borders, capitals, rivers, the equator and tropics, and labels that reveal themselves as students zoom in.',
    outline: [
      'Orient (5 min): find the equator and the tropics; why are they there?',
      'Explore (15 min): students zoom into a continent and read the capitals that appear.',
      'Compare (10 min): switch between satellite and political views of the same region.',
      'Check (10 min): a quick map-reading check pushed to every device.'
    ],
    quote: {
      text: 'Every kid spinning their own globe beat the one wall map we all used to crowd around.',
      name: 'Sarah K.', role: '6th-grade geography · Oregon'
    }
  },
  {
    slug: 'live-ai-notes-for-classrooms',
    subject: 'History &amp; study',
    grade: 'Grades 5–9',
    standard: 'US History 5–9',
    h1: 'Live AI Notes for Classrooms',
    tagline: 'Scan a page into organized notes and a quiz that tracks what each student misses.',
    demo: { kind: 'earth', cap: 'AthenaBoard\'s live classroom — notes archive on the board and export to PDF.' },
    intro: 'Note-taking eats the period that should be spent thinking. Photograph a textbook page and AthenaBoard reads it, writes organized notes — summary, key terms, dates and people, hard ideas explained simply — and builds a quiz in five formats that quizzes each student harder on the topics they miss.',
    outline: [
      'Capture (5 min): photograph the reading; AthenaBoard OCRs it into an editable box.',
      'Organize (10 min): review the auto-notes together — summary, key terms, dates and people.',
      'Quiz (15 min): run a mixed-format check; misses feed each student\'s weak-topic list.',
      'Keep (5 min): students export the board and notes as a PDF to study from.'
    ],
    quote: {
      text: 'They stopped copying and started arguing about the causes — because the notes were already done.',
      name: 'James O.', role: '8th-grade US history · Georgia'
    }
  }
];

const esc = (s) => String(s);

function demoBlock(demo) {
  const attrs = [`data-demo="${demo.kind}"`];
  if (demo.sim) attrs.push(`data-sim="${demo.sim}"`);
  if (demo.family) attrs.push(`data-family="${demo.family}"`);
  // Graph demos render a 2D canvas + sliders rather than a WebGL scene, so
  // they get their own holder class (different sizing, no 3D chrome).
  const holderClass = demo.kind === 'graph' ? 'demo3d-holder graph-holder' : 'demo3d-holder';
  return `        <div class="demo3d-frame lesson-demo">
          <div class="${holderClass}" id="lessonDemo" ${attrs.join(' ')}></div>
          <div class="demo3d-cap">${esc(demo.cap)}</div>
        </div>`;
}

function pageHtml(p) {
  const outline = p.outline.map((s) => `            <li>${esc(s)}</li>`).join('\n');
  const related = PAGES.filter((o) => o.slug !== p.slug).slice(0, 3).map((o) =>
    `          <a class="rel-card" href="/${o.slug}"><span class="rel-subject">${esc(o.subject)}</span><strong>${esc(o.h1)}</strong></a>`
  ).join('\n');

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <link rel="icon" type="image/png" href="/favicon.png" />
  <link rel="apple-touch-icon" href="/img/athenaboard-logo.png" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${esc(p.h1)} — AthenaBoard (${esc(p.grade)}, ${esc(p.standard)})</title>
  <meta name="description" content="${esc(p.tagline)} A live, AI-powered ${esc(p.subject)} whiteboard lesson for ${esc(p.grade)}, aligned to ${esc(p.standard)}. Try it free in your browser." />
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="/styles.css?v=20260729-v25" />
  <link rel="stylesheet" href="/landing3d.css?v=20260729-v25" />
  <link rel="stylesheet" href="/lesson.css?v=20260729-v25" />
</head>
<body data-page="lesson">
  <div class="shell">
    <header class="topbar">
      <a class="brand" href="/" aria-label="AthenaBoard home">
        <span class="brand-mark">AthenaBoard</span>
        <span><strong>Athena</strong><span class="brand-suffix">Board</span></span>
      </a>
      <nav class="nav-links">
        <a href="/#subjects">Subjects</a>
        <a href="/#lessons">Lessons</a>
        <a href="/#teachers">Teachers</a>
        <a href="/#pricing">Pricing</a>
      </nav>
      <div class="auth-area" id="authArea"></div>
    </header>

    <main>
      <nav class="crumbs"><a href="/">Home</a> › <a href="/#subjects">${esc(p.subject)}</a> › <span>${esc(p.h1)}</span></nav>

      <section class="lesson-hero">
        <div class="lesson-hero-copy">
          <div class="lesson-meta">
            <span class="pill grade">${esc(p.grade)}</span>
            <span class="pill subject">${esc(p.subject)}</span>
            <span class="pill standard">${esc(p.standard)}</span>
          </div>
          <h1>${esc(p.h1)}</h1>
          <p class="lesson-tagline">${esc(p.tagline)}</p>
          <div class="hero-actions">
            <button class="btn primary large" id="tryLesson">Try this lesson free</button>
            <a class="btn soft large" href="#outline">See the teaching outline</a>
          </div>
          <p class="lesson-note">Opens a live board in your browser. No install, no hardware.</p>
        </div>
        <div class="lesson-hero-visual">
${demoBlock(p.demo)}
        </div>
      </section>

      <section class="lesson-intro">
        <p>${esc(p.intro)}</p>
      </section>

      <section class="lesson-outline" id="outline">
        <div class="pricing-heading">
          <span class="section-kicker">45-minute outline</span>
          <h2>How to teach it</h2>
        </div>
        <ol class="teach-steps">
${outline}
          </ol>
        <a class="download-outline" href="#" id="downloadOutline">⬇ Download this outline (PDF)</a>
      </section>

      <section class="lesson-standard-block">
        <div class="std-card">
          <span class="section-kicker">Standard</span>
          <h3>${esc(p.standard)}</h3>
          <p>This lesson is built to support ${esc(p.standard)} for ${esc(p.grade)}. Alignment is a teaching guide, not an official endorsement — check it against your district's pacing.</p>
        </div>
      </section>

      <section class="lesson-quote">
        <figure class="testimonial verified wide">
          <blockquote>&ldquo;${esc(p.quote.text)}&rdquo;</blockquote>
          <figcaption>
            <span class="t-name">${esc(p.quote.name)}</span>
            <span class="t-role">${esc(p.quote.role)}</span>
            <span class="t-badge">✔ Verified school educator</span>
          </figcaption>
          <span class="t-disclosure">Received free beta access. Testimonial shared with permission, per FTC guidance on disclosing material connections.</span>
        </figure>
      </section>

      <section class="lesson-cta">
        <h2>Teach ${esc(p.h1)} tomorrow.</h2>
        <p>Open the live board, invite your class, and start.</p>
        <button class="btn primary large" id="tryLesson2">Try this lesson free</button>
      </section>

      <section class="lesson-related">
        <div class="pricing-heading center">
          <span class="section-kicker">More live lessons</span>
          <h2>Keep going</h2>
        </div>
        <div class="rel-grid">
${related}
        </div>
      </section>
    </main>
  </div>

  <dialog id="authDialog" class="modal">
    <form method="dialog" class="modal-card">
      <button class="modal-close" value="cancel" aria-label="Close">×</button>
      <h2 id="authTitle">Sign up free</h2>
      <div class="two-col auth-names" id="authNames">
        <label>First name<input id="firstName" autocomplete="given-name" /></label>
        <label>Last name<input id="lastName" autocomplete="family-name" /></label>
      </div>
      <label>Email<input id="authEmail" type="email" autocomplete="email" /></label>
      <label>Password<input id="authPassword" type="password" autocomplete="current-password" /></label>
      <ul class="pw-hints" id="pwHints" style="display:none">
        <li data-rule="len">At least 8 characters</li>
        <li data-rule="num">At least one number</li>
      </ul>
      <div class="modal-error" id="authError" role="alert"></div>
      <button type="button" class="btn primary large" id="authSubmit" value="default">Continue</button>
      <a class="google-link" href="/auth/google">Continue with Google</a>
      <p class="switch-auth" id="switchAuth"></p>
    </form>
  </dialog>

  <div class="toast" id="toast"></div>

  <script src="https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js"></script>
  <script src="/viz3d.js?v=20260726-v23"></script>
  <script src="/graphdemo.js?v=20260729-v25"></script>
  <script src="/common.js?v=20260729-v25"></script>
  <script src="/lesson.js?v=20260729-v25"></script>
</body>
</html>
`;
}

function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const slugs = [];
  for (const p of PAGES) {
    const html = pageHtml(p);
    fs.writeFileSync(path.join(OUT_DIR, `${p.slug}.html`), html, 'utf8');
    slugs.push(p.slug);
  }
  // Emit the slug list so the server route file can import it (single source
  // of truth — add a page here and the route picks it up automatically).
  fs.writeFileSync(
    path.join(OUT_DIR, 'slugs.json'),
    JSON.stringify(slugs, null, 2),
    'utf8'
  );
  console.log(`Built ${slugs.length} lesson pages into ${OUT_DIR}`);
  slugs.forEach((s) => console.log(`  /${s}`));
}

main();
