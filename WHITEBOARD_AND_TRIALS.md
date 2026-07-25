# What's new: AI Whiteboard + 7-day free trials

This adds two things on top of the existing app, both scoped to fit the
current codebase rather than rearchitecting it:

## 1. Free trials (Starter & Team, 7 days, no card required)

- New endpoint: `POST /api/billing/trial` with `{ plan: 'starter' | 'team' }`.
- Grants that plan's limits immediately, no Stripe checkout involved.
- One trial per plan per account — tracked via `user.trialsUsed`, so a user
  can't restart the same trial by re-selecting it.
- Trial status is derived on every read (`downgradeExpiredTrial`), not by a
  cron job — so expiry is correct even if the server was offline when a
  trial should have lapsed.
- `GET /api/me` now returns a `trial` object:
  `{ active, plan, daysRemaining, endsAt, trialsUsed, availableTrials }`.
- Converting to a real paid plan via Stripe clears trial state cleanly (the
  webhook handler now nulls out `trialPlan`/`trialStartedAt`/`trialEndsAt`
  on `checkout.session.completed`).
- Front end: "Try free for 7 days" buttons on the Starter/Teams pricing
  cards (`index.html`), wired via `AppCommon.startTrial(plan)` in
  `common.js`. A trial countdown chip shows in the topbar while active.

## 2. AI Whiteboard (Teams plan feature, one board per teacher)

**Access model** — intentionally reuses what already exists rather than
adding a second invite system: whiteboard viewer access is granted to
*anyone the teacher has already invited to any of their study sets*
(the existing Teams-plan, 30-seat invite list). Share a set, and that
student can now also see the teacher's live whiteboard. No separate
"invite to whiteboard" flow to build or maintain.

**Storage** — board strokes/AI notes live in their own file,
`data/board-data.json`, separate from `data/store.json` (users, sessions,
study sets). This was a deliberate call: whiteboard drawing generates far
more frequent writes than everything else in the app, and keeping it out
of the main store avoids write contention/locking on the file everything
else depends on.

**New files:**
- `server/board.js` — REST routes + WebSocket server, self-contained module
  mounted into `server/server.js`.
- `public/board.html` / `public/board.css` / `public/board.js` — full-screen
  whiteboard page (uses the whole viewport, no `.shell` width cap like the
  rest of the app).

**REST endpoints** (all under `requireUser`):
- `GET /api/board/mine` — the signed-in teacher's own board (403 if not on
  Teams plan/trial).
- `GET /api/board/:teacherId` — fetch a specific board; 403 if the caller
  isn't the owner or an invited viewer.
- `GET /api/board/mine/viewers` — who currently has access (mirrors the
  teacher's study-set invite list).
- `GET /board` — convenience redirect: teachers land on their own board,
  everyone else is sent to Library with an upgrade prompt.
- `GET /board/:teacherId` — the whiteboard page itself.

**WebSocket** at `/ws/board?teacherId=...`:
- Auth via the existing session cookie — the browser sends it automatically
  on the same-origin WS upgrade request, so no token is ever exposed in a
  URL or to client-side JS.
- Read-only enforcement happens server-side, not just in the UI: a
  non-owner's draw/clear/AI-action message is rejected with an explicit
  error, not just hidden by CSS.
- Messages: `stroke:add`, `stroke:shape` (recognized/snapped shape),
  `board:clear`, `ai:explain` (vision call), `ai:plot` (client-side math,
  broadcast so all viewers render the same graph).

**Phase 1 "smart" features** (deliberately basic, matching the brief):
- Freehand pen + eraser, adjustable color/size.
- Shape tool: draw a rough circle/rectangle/triangle/line, it snaps to a
  clean shape via a lightweight heuristic classifier (bounding-box +
  closure + corner detection — no ML model, good enough for a first pass).
- "Explain what's on the board" — sends a PNG snapshot of the canvas to
  whichever AI provider is already configured (`AI_PROVIDER`/API keys in
  `.env`, same as flashcard generation), using new vision-capable variants
  of the existing `callOpenAI`/`callGemini`/`callClaude` functions.
- "Plot a function" (e.g. `y = x^2 - 3`) — rendered with a small hand-rolled
  expression parser, **not** `eval()`/`Function()`. This matters because a
  plotted expression is broadcast to other users' browsers (viewers); a
  teacher's typed text must never be treated as executable code in someone
  else's session.

## Deploying

No new environment variables are required — the whiteboard reuses whatever
`AI_PROVIDER`/`OPENAI_API_KEY`/`GEMINI_API_KEY`/`ANTHROPIC_API_KEY` is
already configured for flashcard generation.

One new dependency: `ws` (WebSocket server), already added to
`package.json`. Run `npm install` before deploying.

If you're behind nginx, make sure the reverse-proxy config forwards
WebSocket upgrade headers for the `/ws/board` path, e.g.:

```nginx
location /ws/board {
    proxy_pass http://127.0.0.1:3004;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
}
```

(`deploy/nginx-flashcards.conf` in this repo will need that block added —
it isn't there yet since the original config predates this feature.)

## What's intentionally out of scope for Phase 1

- No slide-recognition/3D-model generation like the iFlytek demo — that's
  a much larger lift (computer-vision geometry pipeline) and was flagged
  as a "later" phase in the original request.
- No per-viewer live cursors on the canvas (presence shows who's watching,
  not where their mouse is).
- No mobile-specific touch gesture tuning beyond basic pointer-events
  support (should work, wasn't specially optimized).

---

# Phase 1.5: bug fixes + Team roster + multi-board

A follow-up pass fixed three real bugs found in testing and added the
larger feature set requested afterward.

## Bug fixes

- **Plot parser**: `y = 4x + 3` failed to parse (`4x` wasn't understood as
  `4*x` — implicit multiplication wasn't supported), *and* a second, more
  serious closure self-reference bug caused infinite recursion on any
  multi-term expression once parsing succeeded. Fixed both; verified
  against a battery of expressions including the exact failing case.
- **"Had to keep the cursor on screen"**: a stroke was ending the instant
  the cursor's position left the canvas element's geometric bounds
  (`pointerleave`), even though `setPointerCapture` was already correctly
  tracking movement outside those bounds. Removed the `pointerleave`
  binding; strokes now only end on release.
- **Square → circle misclassification**: the shape recognizer's roundness
  threshold was miscalibrated (real circles measure ~0.02, real squares
  ~0.09-0.10 on the same metric; the old 0.13 threshold caught both), and
  the corner-picking logic always forced exactly 3 points regardless of
  actual shape count. Replaced with convex-hull + Ramer-Douglas-Peucker
  polygon simplification and a threshold recalibrated against measured
  data. Verified 37/37 on synthetic hand-drawn shapes across sizes/noise.

## Team roster (Teams plan)

- One persistent roster per teacher, up to 30 emails (same seat cap the
  Teams plan always advertised — reused, not duplicated).
- `/team` page: invite by email, see status (invited/active), remove
  someone (immediately revokes their access to everything shared).
- Invite emails sent via SMTP (`server/mailer.js`, configured through the
  `SMTP_*` vars in `.env`). If SMTP isn't configured, the roster entry and
  join link are still created — the teacher would just need to copy/send
  the link manually.
- **Join flow** (`/join?token=...`): a magic-link-style, single-use,
  14-day-expiring link. If the invited email already has an account, it
  logs them in directly (equivalent trust level to a password-reset link
  — receiving+clicking proves mailbox control). If not, a one-field
  "set a password" mini-signup creates the account with the email fixed
  to the invited address.

## Unified sharing model

Replaced the old per-item email-invite list with: one team roster (above)
+ a simple on/off `shared` toggle per item. A flashcard set or whiteboard
marked shared becomes visible to *everyone on the owner's roster*, not a
hand-picked subset per item. This applies to flashcard sets, slide decks,
and quizzes (all the same `quizlets` collection) and to whiteboards.

- New endpoint: `POST /api/sets/:id/share-toggle` — replaces the old
  `/share` email-list endpoint in the UI (that endpoint still exists,
  unused, so any pre-existing per-set invites keep working without a
  migration).
- `userCanReadQuizlet()` now checks: owner, OR (`shared` + on the owner's
  roster), OR the legacy `invitedEmails` list (backward compat only).

## Multi-board whiteboard

Boards moved from "one singleton per teacher" to "several saved boards
per teacher, at most one live at a time":

- `/boards` — picker page. Teachers see their saved boards with
  New/Open/Save/Share/Go-Live/Delete. Everyone else sees which of their
  teachers currently have a live, shared board, with a Join link.
- **Save**: persists a title/checkpoint (strokes already autosave
  continuously on every stroke; Save is the explicit "yes this is
  captured" action the person asked for).
- **Go Live / Stop Live**: going live on one board automatically takes
  any other board this teacher owns off live — enforced server-side, not
  just in the UI (`POST /api/board/:boardId/go-live` un-lives every other
  board owned by the same teacher in the same request).
- Viewer access now requires **both** `shared: true` and `isLive: true`
  on the specific board, checked against the team roster — a saved,
  non-live board is private editing space even if marked shared.
- **Live viewer presence**: the WebSocket room broadcasts a `presence`
  message (name + email of everyone currently connected, non-owner) to
  everyone in the room whenever someone joins or leaves. The board page
  shows a "Viewers (N)" panel for the owner.
- **Board access is now keyed by boardId**, not teacherId — both the REST
  routes (`/api/board/:boardId`) and the WebSocket
  (`/ws/board?boardId=...`) changed accordingly.

## "Circle an equation, hit Plot"

Implemented as a **rectangle-select** tool (not freehand lasso — simpler
and more precise for cropping a tight region around handwriting):

1. Teacher picks the select tool, drags a box around an equation, hits
   "Plot selection."
2. The selection is cropped to its own canvas and sent as a PNG snapshot
   over the WebSocket (`ai:read-equation`).
3. Server asks the configured vision AI to extract *only* the equation
   text, nothing else.
4. The extracted text is validated against a strict character allowlist
   server-side (`isSafeExpression()` in `server/board.js`) before it's
   ever broadcast to other users' browsers — matching the same allowlist
   the client's safe expression parser enforces. A bad extraction fails
   loudly with an in-panel message rather than reaching a viewer as
   unvalidated text.
5. If validation passes, it's broadcast as a normal `graph` AI note and
   rendered through the existing safe parser — same code path as typing
   a function directly, so there's no separate less-trusted path for
   AI-extracted expressions.

## Testing notes

Everything above was verified via direct HTTP/WebSocket calls against a
running instance in this environment (registration → trial → roster
invite → join-link completion → set share-toggle → board create/share/
go-live → cross-user access checks → roster removal instantly revoking
access → WS presence broadcast on join/leave → read-only draw enforcement
post-rewrite). SMTP delivery itself couldn't be tested end-to-end here
(no outbound network to arbitrary SMTP hosts in this sandboxed
environment) — the mailer's config-parsing and env-var handling were
verified directly instead. Actual UI click-through in a real browser
was **not** possible here (this environment can't launch a full browser)
and should be checked before shipping to production.

---

# Regression fixes (post-multi-board)

The multi-board/roster rewrite broke three things that worked in the first
whiteboard release. All three are fixed:

1. **Clicking "Whiteboard" landed on an empty list instead of a canvas.**
   The nav link now goes to `/board`, which redirects to your most recently
   updated board and creates a first one ("My Whiteboard") if you have
   none — restoring the original click-once-and-draw behaviour. `/boards`
   is still there for managing multiple boards.

2. **Boards created before multi-board support rendered with no name.**
   They predate the `title`/`shared`/`isLive` fields; `normalizeBoard()`
   now backfills sensible defaults on read.

3. **Students who could already see a whiteboard lost access (403).**
   Viewer access had been switched to require the new team roster, which
   is empty for every account created before rosters existed. Access now
   checks the roster **or** the older per-study-set `invitedEmails` model
   (`canViewTeachersContent` in `server/server.js`), so nobody who had
   access before loses it. New invites should still use the roster.

Also: **going live now also marks the board shared.** Going live on a board
nobody can see was never the intent, and it made "why can't my students see
this?" a two-step trap. Unshare and stop-live remain separate actions.

---

# Student/invitee experience fixes

Invitees could join a team but had no way to reach anything shared with
them. The data was correct the whole time; the UI hid it.

1. **Shared whiteboards were invisible to students.** The Whiteboard nav
   link only rendered for accounts with `limits.whiteboard` (Teams plan),
   and students are on the free plan — so a student had no link to the
   page listing their teacher's live boards. `/api/me` now returns an
   `access` object (`isStudent`, `canSeeWhiteboard`) computed from roster
   membership, and the nav keys off that instead of plan. Team management
   stays owner-only.

2. **Library now lists "Whiteboards shared with you."** New endpoint
   `GET /api/board/shared/mine` returns every shared board from teachers
   whose roster you're on, live or not. Live ones get a Join button;
   offline ones show as Offline rather than silently disappearing, so a
   student can tell the difference between "nothing shared" and "not
   started yet."

3. **Library is now the student's landing page.** Students mostly consume
   what's shared rather than create, so login/landing routes them to
   `/library` (`homePathFor()` in `common.js`); teachers still land on
   `/app`. The landing page header also shows Create / Your Library links
   once signed in — previously it only had Features/Pricing, leaving a
   signed-in free user with no way back into the app from the homepage.

4. **Sharing something now emails the team a direct link.** Toggling share
   on a study set, slide deck, or whiteboard (and going live, which
   implies sharing) emails everyone on the roster a link straight to that
   item — `/app?set=<id>` or `/board/<id>`. Sends are fire-and-forget: a
   share never fails because SMTP is slow or down, and per-recipient
   failures are logged. Emails only go out on the off→on transition, so
   re-toggling doesn't spam the roster.

---

# Whiteboard v2

## Data model change (migrates automatically)

A board went from one flat surface to `pages[]`. Any existing board's
`board.strokes` is moved into `pages[0].strokes` on first read — no manual
migration, nothing lost. Each page carries `{ id, template, background,
strokes[], objects[] }`.

Strokes and objects are stored in **world coordinates**, with pan/zoom applied
only at render time, so zooming never rewrites stored data and exports are
independent of what's currently on screen.

## Features

1. **Board → study set.** `POST /api/board/:id/to-study-set` reads every page
   with the vision model, then feeds the transcript into the same generator
   the rest of the app uses. Pages are read sequentially on purpose —
   20 parallel vision calls is a fast way to get rate-limited everywhere.
   Counts against the normal daily set limit.
2. **Multi-page boards** (up to 20). Add/delete/switch pages; the teacher
   paging through pulls live viewers along via `page:goto`.
3. **Undo/redo** (Ctrl+Z / Ctrl+Shift+Z, or toolbar). Expressed over the wire
   as remove/re-add of a specific stroke id so every client converges on the
   same page contents rather than diverging.
4. **Import image as background**, capped at ~2MB (returns 413 above that, so
   one imported photo can't bloat board-data.json). **Export to PDF** — one
   landscape page per board page, rendered offscreen at fixed size.
5. **Live classroom:** push an insight to students, anonymous "I'm lost"
   signal (teacher sees only a count), and flying emoji reactions
   (👍 😮 🎉 🙏 ❤️). Reactions and the lost flag are the only messages
   viewers may send — everything else stays owner-only, enforced server-side.
6. **Laser pointer** — broadcast during live sessions, never persisted.
7. **Replay scrubber** — play back how a page was built, stroke by stroke.
8. **Plot on the canvas**, not just in the panel. Type `y = 4x + 3`, or select
   a handwritten equation and hit Plot; the graph is placed as an object next
   to the selection. Expressions still go through the hand-rolled safe parser
   (never `eval`/`Function`), since they're broadcast to other browsers.
9. **Pan/zoom** (wheel, space-drag, or the pan tool), **sticky notes**,
   **text boxes**, and **graph paper / lined / coordinate-grid** templates.
10. **Manual Analyze button** — analysis only runs when asked, so there's no
    per-stroke vision billing.
11. **Collapsible right Info panel**, remembered per browser.

## The Info panel

One vision call classifies the page and returns typed JSON, so the panel can
render the right *shape* of answer instead of prose. Handled kinds: algebra,
arithmetic, calculus, systems of equations, word, geometry, chemistry,
physics, diagram, sketch. The schema carries `steps[] (step + why)`, `method`,
`answer`, `facts[]`, `formulas[]`, `plots[]`, and `warnings[]`; physics
answers are asked to put dimensional inconsistencies into `warnings`.
Anything the model omits simply isn't rendered.

Model output is parsed defensively — fenced blocks and prose around the JSON
are tolerated, and unparseable output returns a clean error rather than a
crash.

## Known limits

- Sticky-note and text content is entered via a browser prompt; inline
  editing on the canvas is a refinement worth doing next.
- Backgrounds are stored inline as data URLs. Fine at current scale; if
  boards get image-heavy, move these to file storage.
- The Analyze result is only as good as the vision model. Worked steps are
  **not** independently verified — check anything before presenting it to a
  class.

---

# v2.1 — touch, circles, and flowcharts

## Circle recognition fixed (real bug)

Squares worked, circles didn't. The classifier keyed off a "roundness"
ratio, and I'd tightened its threshold to 0.05 while fixing an earlier
square-detected-as-circle bug. That threshold was calibrated against
synthetic strokes with **per-point jitter**, which averages out. Real
hand-drawn circles wobble at **low frequency**, which pushes roundness to
0.05–0.12 — just past the cutoff — so every realistic circle fell through
to the rectangle branch. The test data was wrong, not the idea.

Replaced with two scale- and rotation-invariant signals that don't care how
steady the hand was:
- **corner count** from a convex hull simplified across a sweep of
  tolerances (a wobbly circle only collapses to few corners at coarse
  epsilon; a square holds 4 across the range)
- **circularity** `4πA/P²` (1.0 circle, ~0.79 square, ~0.6 triangle)

Verified on simulated hand-drawn strokes across wobble 0.03–0.16.

## Touch / iPad / iPhone

- **Two fingers pinch-zoom and pan**, anchored on the pinch midpoint, and
  cancel any stroke in flight so a second finger never leaves a stray mark.
- **Apple Pencil**: once a stylus is used on a board, fingers pan and only
  the pencil draws — the standard tablet convention, which also gives
  palm rejection almost for free. Without a stylus, one finger draws.
- iOS `gesturestart/change/end` and double-tap are suppressed so Safari
  can't zoom the UI out from under the canvas.
- `user-scalable=no`, `viewport-fit=cover`, safe-area insets, `100dvh`,
  and `overscroll-behavior: none` to stop rubber-banding.
- Bigger hit targets under `@media (pointer: coarse)`.
- Phone layout: toolbar becomes a horizontal scrolling strip, and the Info
  panel docks as a bottom sheet instead of eating canvas width.

## Flowcharts

New **Flowchart** page template (dot grid for alignment) with a shape
palette in the left pane: Start/End, Process, Decision, Input/Output,
Document, and Connector.

- **✥ Move** tool drags shapes; connectors re-route automatically because
  they store shape *ids*, not coordinates.
- **⇢ Connect** tool: tap one shape, then another. Arrows clip to the box
  edge rather than burying themselves in the shape.
- **Y/N gates**: the first branch leaving a Decision auto-labels **Y**, the
  second **N**, drawn as a coloured pill on the line. No prompt per branch.

Connectors render beneath shapes so arrowheads aren't covered, and are
included in PNG snapshots and PDF export.

---

# v2.2 — interactive graphs, questions, and fixes from the screenshot

## Bugs fixed
1. **Export was missing the AI Notes / Info panel.** PDF export now appends
   a final "AI Notes" page rendering every analysis (kind, title, summary,
   method, steps, answer, warnings).
2. **Export included empty pages.** Blank pages (no strokes, objects, or
   background) are skipped — a 3-page board with only page 1 drawn exports
   one sheet, not three. Verified: pages 1,4,5 filled -> only those export.
3. **Only circle/rectangle were recognized; pentagon/hexagon/rhombus became
   circle or rectangle.** The classifier had no branch above 3 sides.
   Rebuilt around corner-counting by interior turn angle: triangle=3,
   pentagon=5, hexagon=6, etc., with circularity only deciding the genuinely
   ambiguous circle-vs-many-sided case. Rhombus is detected as a rotated
   quad whose vertices sit at the bounding-box edge midpoints. Verified on
   simulated hand-drawn strokes. (Regular 7-8 sided polygons are near-
   circular and may read as circle — inherent ambiguity, rare in practice.)
4. **Attendees couldn't see Analyze results.** The server was broadcasting
   `insight` correctly; the client rendered it into a panel that students
   never open. `renderInsight` now force-opens the Info panel (and un-hides
   the bottom sheet on phones) for both roles.

## New: interactive graphs
- Graphs are now objects holding **multiple curves** and a shared **params**
  map. Type `y = A*x + B` and sliders for A and B appear.
- **Drag a slider and the curve moves live** — and every student watching
  sees it move, via a `graph:live` broadcast (sent without a disk write per
  tick; the final value commits through the normal object update).
- Moving the constant B shifts a line up/down; A changes its slope — so a
  class can watch the impact of each term.
- **Overlay multiple curves** on one graph to compare them.
- Tap a graph with the **move (✥)** tool to reopen its sliders.

## New: questions / raise hand
- Students get an **✋ Ask** button (type a question, or leave it blank to
  just raise a hand). The teacher sees a **Questions (n)** queue and clears
  each as it's addressed. Ephemeral — not saved with the board.

## New: Live Analyze
- A **⚡ Live analyze** toggle in the Smart AI section. When on, a ~2s
  debounce after the teacher stops drawing runs Analyze automatically and
  auto-plots any functions it detects, next to the work. Off by default to
  avoid per-stroke vision cost.

## New: collapsible toolbar
- The left toolbar is now four collapsible sections — Tools, Page,
  Flowchart shapes, Smart AI — so it stops growing unbounded.

---

# v2.3 — Notes: scan a page, get notes, get quizzed

A new `/notes` area (linked in the nav everywhere) for turning a photographed
or uploaded page into organized study material.

## 1. Scan or upload
- **Take a photo** (`capture="environment"` opens the phone's rear camera) or
  upload an image, PDF, docx, or txt.
- Images are OCR'd by the vision model; PDFs/docx reuse the same extractor
  the Create page already uses. Either way the text lands in an **editable
  review box** before anything is saved, so OCR mistakes can be fixed by hand.

## 2. Organized notes
One structured generation per passage produces: a short summary, important
facts, key terms with definitions, main ideas, dates/people/formulas/events
(each with why it matters), and difficult ideas explained simply. Everything
is prompted to stay grounded in the passage.

## 3. Organization
`Subject → Notebook → Chapter → Passage`, rendered as a collapsible tree,
with free-form tags (`Important`, `Test Friday`, …) and a tag filter box.
Previously used subjects/notebooks/chapters autocomplete when filing a new
passage. Passages can be re-filed and re-tagged after the fact.

## 4. Quizzes — five formats
Multiple choice, true/false, short answer, fill-in-the-blank, and flashcards,
selectable per quiz. Every generated question carries its correct answer, a
why-it's-correct explanation, **the supporting sentence quoted from the
passage**, and a short topic label.

Grading is honest about what can be auto-graded: mc/tf/fib are checked
automatically (normalized compare); short answers and flashcards show the
answer and ask "I got it / I missed it", because free text has many correct
phrasings and auto-grading against one reference marks too many right
answers wrong.

## 5. Learning tracking
After each answer the student sees why the answer is correct plus the
supporting sentence. Results are recorded per passage:
- misses increment a per-topic weakness counter (and are kept in a rolling
  missed-questions log);
- a later correct answer on that topic *softens* the weakness rather than
  erasing it;
- the next quiz generation is explicitly weighted (~half the questions)
  toward the current weakest topics, and the quiz setup screen tells the
  student which topics it will focus on.

Verified end-to-end in this environment: OCR file path, passage CRUD, the
tree data, tag rewriting, the weakness math (2 misses -> weight 2; 1 correct
-> weight 1), and that weak topics reach the generation prompt. Vision OCR
and question generation themselves need a configured AI key and were
verified only for clean error handling here.

Costs: creating a passage's notes and generating a quiz each count one
against the existing daily AI-generation limit; answering questions is free.

---

# v2.6 — 3D geometry, molecules, and a rotatable Earth

Answers iFlytek's signature demo (turning a flat drawing into a rotatable 3D
model) without their hardware, plus chemistry structure visualization.

## How it works
The Analyze result gained two optional fields the vision model fills:
- **viz3d**: `{ shape, dims, label }` for a geometric solid — cube, cuboid,
  sphere, cylinder, cone, pyramid, prism, tetrahedron — or `shape:"earth"`
  when the board shows a circle labeled "Earth" or "globe".
- **molecule**: `{ name, formula, smiles, atoms, bonds }` for chemistry.

When either is present, the Info panel renders an interactive **Three.js**
viewer (`public/viz3d.js`): drag to rotate, gentle auto-spin until touched.
Solids show a cyan edge overlay so points/lines/faces read clearly. The
whole analysis (including these fields) is what gets pushed to students, so
attendees see the same rotatable 3D object the teacher does — verified over
the live socket.

## 1. 3D geometry
Draw or label a solid, hit Analyze. The panel shows the rotatable shape plus
(from the same call) its surface-area/volume formulas and computed values
when dimensions are written on the board. Built on primitives available in
three.js r128 (no OrbitControls dependency — rotation is a small custom
pointer handler; no CapsuleGeometry, which is r142+).

## 2. Earth
Draw a circle, write "Earth" inside, Analyze -> a rotatable globe with a
procedural land/ocean/ice texture (drawn to a canvas, so it needs no
external image host or CORS) and a faint atmosphere halo at ~23.5° tilt.
This is the foundation for future physics/astronomy simulations.

## 3. Chemistry (molecules)
A named or drawn compound renders as a ball-and-stick model with standard
CPK atom colours and multi-order bonds. If the model returns a formula but
no coordinates, a small built-in library (H2O, CO2, CH4, NaCl) supplies a
sensible structure so the panel still shows something real rather than an
empty box.

## Notes / limits
- Up to 4 live 3D viewers are kept at once; older ones are disposed to avoid
  accumulating WebGL contexts over a long session.
- Molecule geometry from the model is only as good as the coordinates it
  returns; the fallback library covers the most common classroom molecules.
- Rendering quality (lighting, the Earth texture, rotation feel) needs a
  real browser to judge — the geometry selection, molecule fallbacks, the
  dispose lifecycle, and the full push-to-student pipeline are verified
  here, but the visual result is not something this environment can see.

---

# v2.7 — a real Earth, not a cartoon

Rebuilt the Earth viewer from the ground up in response to the "cartoonish
green blobs" feedback.

## Real map
- Bundled a genuine 2048×1024 Blue Marble satellite texture at
  `public/textures/earth.jpg` (served by express.static, no runtime/CORS
  dependency, works offline). Continents and oceans render as they actually
  look. Falls back to a plain blue sphere only if the texture fails to load.

## Geography overlays (all verified mathematically)
- **Graticule**: latitude/longitude grid every 15°.
- **Equator** (bright teal), **Tropic of Cancer** and **Tropic of
  Capricorn** (amber, ±23.5°), **Arctic** and **Antarctic Circles** (cyan,
  ±66.5°) drawn as highlighted rings with floating labels. The lat/long→3D
  math is unit-tested: equator lands at y=0 full radius, tropics at ±0.678,
  poles collapse onto the axis — so the rings sit at the correct latitudes.
- **Ocean labels**: Pacific, Atlantic, Indian, Arctic, Southern.
- **Continent labels**: all seven, bold white, placed at real coordinates.

## Interaction
- **Zoom**: mouse wheel and two-finger pinch dolly the camera (clamped so
  you can zoom in toward country level without flying through the globe).
- **Maximize / fullscreen**: a ⛶ button on every 3D viewer (solids and
  molecules too, not just Earth) expands it to fullscreen via the
  Fullscreen API and resizes the renderer to fill the screen; ✕ or Esc
  restores it.
- Drag to rotate; gentle auto-spin until touched; an on-viewer hint says so.

## Still needs your eyes
The geometry, texture serving (byte-identical over HTTP), label placement
math, zoom clamping, and fullscreen lifecycle are all verified here. What I
can't see without a browser: how the map actually looks with lighting, label
legibility against the texture, and whether zoom feels right. Write "Earth"
in a circle and Analyze to check. If labels are hard to read over bright
terrain, that's a quick tweak (stronger shadow or a semi-opaque pill behind
each). A night-lights texture is also available on the same host if you want
a day/night option later.

---

# v2.8 — political globe (countries, cities, rivers, zoom labels)

The v2.7 Earth showed physical terrain (Blue Marble satellite). This adds a
**political map mode** with real cartographic data, toggleable against the
satellite view.

## What's bundled (real Natural Earth data, ~185KB total)
- `public/geo/countries.json` — 177 countries, real border polygons
  (simplified) plus a centroid and label rank each.
- `public/geo/cities.json` — 700 places including all 200 national capitals,
  with a prominence rank for level-of-detail.
- `public/geo/rivers.json` — 12 major river systems.

## Political mode
A 🗺 Political / 🛰 Satellite toggle on the globe:
- **Country borders** drawn as glowing vector lines on the sphere surface.
- **Rivers** as blue centerlines.
- **Capital city dots** (gold) at their real coordinates.
- The base sphere switches to a dark fill so borders and labels pop.

## Zoom-based labels (the "Google Earth" behaviour)
Labels reveal progressively as you zoom in, by prominence:
- **Far out**: continents + oceans only.
- **Mid**: country names, most prominent first (label rank 2 -> 3 -> 5 -> 8).
- **Close**: national capitals, then progressively more cities (rank 1 -> 12).
Driven by camera distance via an onZoom hook into the shared render loop.
Verified: at max distance no country/city labels show; zooming in reveals
countries then capitals then cities in the right order.

## Honest limits of the technology
This is a labelled political *globe*, not live tile streaming. What it does
NOT do (and can't, without map-tile servers + API keys):
- No street-level / building-level imagery or continuous zoom to a street.
- No search-to-fly-to-a-place, no real-time data, no road networks.
- Borders/rivers are simplified for size; not survey-accurate at high zoom.
It's a classroom teaching globe: recognisable countries, capitals, oceans,
rivers, the graticule and tropics — enough for geography lessons, not a
Google Earth replacement.

## Verified vs. needs-your-eyes
Verified here: all data parses and serves, every border/label point lands
exactly on the sphere (2519/2519 sampled), Paris/Tokyo/New York present and
at correct latitudes, the LOD reveal order, and the political build path
resolving with real counts (288 rings, 177 country + 700 city labels, 200
capital dots, 12 rivers). Needs a real browser: how readable the labels are
over the map, whether border lines are the right brightness, and zoom feel.

---

# v2.9 — globe labels: focus on the centre, declutter the rest

Fixes the zoomed-in label pile-up (every city in the hemisphere rendering at
once, stacking into an unreadable wall).

## Focus cone
Detailed labels (cities) now only appear inside a cone around the point the
camera is looking at — the centre of the screen. Everything off-centre or on
the far side of the globe falls back to country/ocean level. The cone
tightens as you zoom in:
- ~50° half-angle when you first start seeing cities (dist 3.2)
- ~24° half-angle at closest zoom (dist 2.15)
So zooming into India shows India's cities; the surrounding countries stay at
country-name level instead of dumping every label on screen.

Because the globe also rotates (auto-spin and drag), the cone is recomputed
a few times a second inside the render loop, not just on zoom — so whatever
is centred is what's detailed.

## Screen-space declutter
Even inside the cone, dense regions could still overlap. A second pass
projects each candidate label to 2D and hides any that collide with one
already placed. Priority order: national capitals first, then by prominence
rank — so the important names survive and the rest drop. Verified on a
simulated India/Sri Lanka cluster: New Delhi and Colombo (capitals) and an
isolated Chennai survive; overlapping lower-priority names are dropped.

Country labels also now hide on the back hemisphere (facing away from the
camera) instead of bleeding through the globe.

## Verified vs. needs-your-eyes
Verified: the cone half-angles by zoom distance, that screen-centre always
shows and the backside/edges always hide, and that declutter keeps
capitals + high-priority and drops overlaps. Needs a real browser: the exact
label density that feels right — the cone width and the declutter padding are
the two knobs to tune if it's still too busy or now too sparse.

---

# v3.0 — richer molecules + zoom/fullscreen on every 3D model

## Zoom + fullscreen everywhere
Previously only the globe zoomed. Now **all three 3D viewers** — geometric
solids, molecules, and the Bohr atom view — support mouse-wheel and
two-finger pinch zoom, and every viewer has the ⛶ maximize/fullscreen
button (it was already on the globe; solids and molecules now get it too via
the shared mount path).

## Molecules: labels
Each atom now carries its element symbol as a floating label, and double /
triple bonds render as parallel cylinders (previously all bonds looked
single).

## Molecules: zoom into an atom (Bohr shells)
Click any atom in a molecule to fly into a Bohr-model view of that element:
- a coloured nucleus labelled with the symbol and atomic number Z (= protons),
- one faint ring per electron shell, each labelled with its electron count
  (e.g. an oxygen atom shows 2e⁻ inner, 6e⁻ outer),
- animated electrons orbiting on each shell,
- a caption naming the element and its valence (outer-shell) electron count.
A "← Molecule" button returns to the full structure.

Electron shell data is a real per-element table (H through Ca, plus Fe, Br,
I). Verified: every shell configuration sums to the atomic number and the
valence counts are correct (O = 2,6; Na = 2,8,1; Cl = 2,8,7; etc.).

Drag now rotates whichever is in focus — the molecule, or the single atom
when zoomed in — because auto-spin and drag route through a spinTarget hook
rather than always rotating the molecule group.

## Verified vs. needs-your-eyes
Verified: the electron-shell chemistry, that all three viewers pass zoom
options, the mount/dispose lifecycle, and asset serving. Needs a real
browser: how the Bohr animation looks, label legibility, click-to-focus
feel, and whether the zoom ranges (min/max) feel right per model type.

---

# v3.1 — AI Notes survive the lesson; students can save; iPhone fullscreen works

Four fixes, all about students not losing access when the teacher leaves.

## AI Notes are now archived on the board
Previously AI Notes (Analyze results pushed to the room) were ephemeral —
broadcast over the socket and gone the moment the teacher went offline. Now
each pushed note is **persisted to the board's `insights` archive** on the
server before broadcasting. When anyone opens the board — including students,
including while the teacher is offline — the archive loads and shows under
"AI Notes". Verified: teacher pushes a note, closes their connection, and a
student's board load still returns it.

## Teacher can Erase all AI Notes
An "Erase all" button in the AI Notes panel header (teacher-only). It wipes
the archive from storage and broadcasts `insight:cleared`, so the notes
vanish for students in real time too. Owner-only on the server — a student
message can't add or clear notes. Verified both the clear + broadcast and
the owner guard.

## Students can export to PDF during the lesson
Added a ⬇ PDF button to the student bar. Since the archived AI Notes load
into the same `analyses` list the PDF builder uses, a student's export
includes the board pages AND every AI Note — so they keep everything even
after the teacher ends the session. (Export was never owner-gated; the button
just wasn't shown to students before.)

## iPhone fullscreen now works
The Fullscreen API doesn't work for arbitrary elements on iPhone Safari
(video only), so the ⛶ button did nothing for students on iOS. Now we detect
iOS (and iPadOS 13+, which reports as Mac) and fall back to a CSS
"pseudo-fullscreen" that fixes the viewer over the whole viewport (100dvh,
safe-area aware) — works on iPhone/iPad, while desktop still uses the native
API. Verified the detection routes iPhone/iPad to the CSS path and desktop to
native.

## Verified vs. needs-your-eyes
Verified: note persistence, offline student access, erase + broadcast, the
owner guard, and the iOS-vs-desktop fullscreen routing. Needs a real device:
that the iOS pseudo-fullscreen actually fills an iPhone screen cleanly, and
that a student's PDF looks right.

---

# v3.2 — shared boards stay viewable after the teacher stops live

## The bug
Student access required `shared && isLive`. So the moment a teacher came out
of a live session, `isLive` went false and every student got a 403 — they
lost the board entirely, even though it was still shared with them.

## The fix
Visibility is now gated on **shared**, not live. A shared board is viewable
by its students whether or not it's currently live; when it isn't live they
see the last saved snapshot, read-only (drawing was always owner-only). Live
now controls only real-time updates, not whether the board can be opened.
- GET `/api/board/:id`: shared is sufficient.
- WebSocket: a student may connect to a shared board even when not live, so
  they get the snapshot sync and will receive live updates if the teacher
  goes live again.
- Unsharing still blocks access (verified 403).

## Real-time live/snapshot indicator
When the teacher toggles live, a `live:changed` message is broadcast so
students' status flips between "Live" and "Snapshot" and the read-only banner
updates ("Viewing live…" vs "This is a shared snapshot — the teacher isn't
live right now. You can view and export it.") without a reload.

## Verified
Student can GET the board while live (200), after the teacher stops live
(200, snapshot, isLive=false), and it stays in their shared library; student
WS connects to a non-live shared board and gets the sync; live:changed
reaches students; unsharing returns 403.

---

# v3.3 — student flow fixes + new marketing homepage

## Student flow
- **Export on snapshots.** The student bar now keeps the ⬇ PDF button visible
  at all times (live or snapshot); the live-only controls — reactions, raise
  hand, "I'm lost" — hide when the board isn't live, so Export is unmissable.
- **Library "Offline" is now a link.** A non-live shared board shows a
  "View snapshot" link to /board/:id (was a dead disabled "Offline" button),
  since snapshots are viewable now.
- **Exit goes to the right home.** Students exit the board to /library (where
  their shared boards live); teachers still go to /boards. The brand logo does
  the same. Previously both went to /boards, which for a student is the wrong
  page and bounced them toward the marketing site.

## New marketing homepage
Rebuilt index.html around the new capabilities, with **live 3D demos** on the
page (real viz3d viewers, not images):
- Hero: a rotatable Earth.
- 3D Science grid: acetic acid (CH3COOH, chemically correct C2H4O2 with a C=O
  double bond — click an atom for its electron shells), a geometric solid, and
  a teaching globe.
- Feature blocks for the AI whiteboard (handwriting->graph, shape snap,
  flowcharts, Analyze), the live classroom (reactions, questions, I'm lost,
  archived AI Notes, snapshots), and Notes/Study (scan->OCR->notes->5 quiz
  types->weak-topic tracking).
- A "without the hardware" comparison against fixed classroom AI boards.
- Pricing and auth logic preserved (same landing.js hooks, plus a second CTA).

Demos lazy-mount on scroll and are capped at 4 live WebGL viewers.

## Verified vs. needs-your-eyes
Verified: homepage + all 3D assets serve, the four demo holders are present,
acetic acid's formula/bonds are correct, and all three student-flow fixes
(snapshot GET, View snapshot link, export visible, exit target). Needs a real
browser: how the live 3D demos look and perform on the marketing page, and the
overall visual polish of the redesign.

---

# v3.4 — PDF notes no longer jumbled + graphs get real move sliders

## PDF AI Notes were overlapping
Root cause: wrapText returned the y of its LAST line, not the position below
the block — so every note block was drawn on top of the previous one (exactly
the jumble in the screenshot). Also there was no pagination, so long content
overwrote itself on one fixed canvas.

Fixes:
- wrapText now returns the y BELOW the block (last baseline + lineHeight), so
  blocks stack cleanly. Verified: consecutive blocks advance and never
  overlap; long wrapped text returns the correct bottom.
- renderNotesPages() paginates across as many pages as needed instead of one
  1600x1000 canvas, with a running "ensure(space)" that starts a fresh page
  before content would run off the bottom.
- Each analysis's 3D model is now embedded as a still image (PNG) in the
  notes. viz3d viewers render with preserveDrawingBuffer and expose a
  snapshot() method; exportPdf captures + decodes those stills (awaiting image
  load) before drawing, so the picture actually appears.

## Graph sliders did nothing; +constant didn't work
Root cause: sliders only existed for single letters already in the expression
(A, B, k). 4x^2 has none, so the slider controlled nothing, and adding "+2"
didn't create an adjustable constant.

Fix: every graph now carries a transform {shiftX, shiftY} and ALWAYS gets two
sliders — "Move up / down" (adds a constant; +2 raises the curve) and "Move
left / right" (slides it sideways) — applied to all curves regardless of the
expression. Any real letter-params still get their own sliders too. Applied as
f(x - shiftX) + shiftY.
- Verified the math: 4x^2 with shiftY=+2 gives 2 at the vertex (4x^2+2);
  shiftX=+2 moves the vertex to x=2.
- Live broadcast now carries transform end-to-end (client -> server relay ->
  student), so students watch the curve move. Verified over a real socket.
- Fixed the colliding/garbled graph labels: expression(s) at the top, a
  compact "+2.0 up  +1.0 right" readout just under them, no more bottom-line
  overlap.

## Verified vs. needs-your-eyes
Verified: wrapText spacing, transform math, the live transform broadcast to
students, and all syntax. Needs a real browser: the actual look of the
paginated PDF and the embedded 3D stills, and the feel of dragging the new
sliders.

---

# v3.5 — semantic function sliders + interactive physics simulator

Built on top of v3.4 (the pushed PDF-notes + graph-move work).

## Two slider bugs from the screenshot
- `y` was being treated as an adjustable constant (the stray "y: 0.4" slider),
  because detectParams picked up any single letter. `y` (and its role as the
  output variable) is now excluded.
- Graph label overlap addressed as part of the semantic-label rework below.

## Semantic function sliders
Sliders now match the FUNCTION the teacher wrote, instead of a generic
up/down/left/right shift:
- Straight line y = mx + b -> "Slope (m)" and "Y-intercept (b)".
- Parabola y = ax² + bx + c -> a (steepness/direction), b (tilt), c (height).
- Sine/cosine -> amplitude, frequency, phase, vertical shift.
- Exponential y = A·b^x -> start value, growth base.
A recognizer (analyzeFunction) detects the family; the curve is rebuilt live
from the named params (graphFn), and the control panel shows the meaningful
sliders with a live "y = 2x + 3" readout. Unrecognized forms fall back to the
generic move up/down + left/right sliders from v3.4. Changes broadcast to
students (fnFamily + fnParams) so they watch slope/shape change in real time.
Verified: recognition + math for line/parabola/sine/exponential, and the live
broadcast to a student socket.

## Interactive physics simulator (new 3D viewer kind)
A "physics" viewer for the falling-objects / Galileo / Apollo-15 demo:
- A stone and a feather drop from the same height in real time.
- Sliders/toggles: gravity g (with Earth 9.8 / Moon 1.6 / Jupiter 24.8
  presets) and an air-resistance ON/OFF switch.
- With air ON, the feather lags badly (drag dominates its tiny mass); with air
  OFF (vacuum/Moon) both land together — the teaching "aha".
- Live readout of each object's velocity, landing time, and the governing
  equation (F = mg − ½ρC_dAv² with air, F = mg in vacuum).
Physics verified against theory: vacuum fall time matches t=√(2h/g) exactly;
feather reaches terminal velocity with air; Moon gravity slows everything.
Wired end to end: analyze schema has a physicsSim field, the vision model is
told to fill it for gravity/free-fall/feather-hammer questions, and
renderInsight mounts the simulator (with zoom + fullscreen like the other 3D
viewers).

## Verified vs. needs-your-eyes
Verified: y-exclusion, function recognition + math, semantic slider broadcast,
physics accuracy, headless mount/dispose, assets serve. Needs a real browser:
the feel of the semantic sliders, the physics animation, and slider/label
layout polish.

---

# v3.6 — plot the general formula (y = mx + b) instead of erroring

Built on the pushed v3.5 (commit 6ee1bd8).

## The bug
Writing the literal formula y = mx + b failed with 'Cannot plot: Unknown
name "mx"'. Two causes:
- The expression tokenizer read "mx" as one 2-letter identifier, which wasn't
  a known name -> error.
- detectParams matched whole letter-runs, so "mx" (length 2) was skipped and
  never became a parameter; only "b" registered.

## The fix
- Tokenizer: a multi-letter run is consumed whole ONLY if it's a known
  function/constant (sin, cos, sqrt, pi, ...). Otherwise it's read one letter
  at a time, so "mx" becomes m * x via the implicit-multiplication the parser
  already supports. Any single letter that isn't x is a live parameter.
- detectParams splits runs the same way, so m and b both become sliders.
- analyzeFunction now recognizes the canonical SYMBOLIC forms too: y = mx + b
  and y = ax + b -> Straight line with "Slope"/"Y-intercept" sliders (start
  m=1, b=0); y = ax^2 + bx + c -> Parabola with a/b/c; y = asin(bx+c)+d ->
  Sine. So the general textbook formula gives the right named sliders, not
  just generic ones.

## Verified
Full parser regression: y = mx + b, mx, 2x+3, 4x^2, sin/cos/sqrt, x^2+2x+1,
pi/2pi/e all evaluate correctly; symbolic and numeric forms both recognized
with correct slider labels; assets serve; syntax clean.

Needs a real browser: that the sliders feel right when dragging the symbolic
form live.

---

# v3.7 — physics simulation library (4 new sims + shared scaffold)

Refactored mountPhysics into a shared physicsScaffold (scene, renderer, HUD,
control bar, render loop, standard handle) that each sim plugs into. Then
added four sims alongside the existing free-fall:

- **Projectile**: speed + angle sliders, a live trajectory arc, and a
  range/apex readout. Teaches that 45° maximizes range and complementary
  angles share a range. (Verified: range = v²sin2θ/g, 45° is max, 30°=60°.)
- **Pendulum**: length + gravity sliders, exact ODE swing, live period.
  Teaches T = 2π√(L/g) — independent of mass and (small-angle) amplitude.
  (Verified: T(1m)=2.006s, 4×L doubles T.)
- **Inclined plane**: wedge-angle, friction μ, and mass sliders; block slides
  or is held. Teaches a = g(sinθ − μcosθ) and that sliding depends on tanθ vs
  μ, NOT mass. (Verified: holds when tanθ<μ, mass cancels.)
- **Collision (1D)**: mass A/B, speed, and restitution e sliders. Teaches
  momentum is always conserved; KE only when elastic (e=1). (Verified: equal-
  mass elastic swaps velocities, momentum conserved, e=0 sticks & loses KE.)

Analyze schema updated so the vision model picks the matching type
(projectile/pendulum/incline/collision/freefall). Each mounts with the same
zoom + fullscreen as the other 3D viewers, and all pass headless mount/dispose.

## Still to come (see notes to user)
Orbit, wall-of-death, reflection (mirrors), and circuits are further physics
sims of the same shape. Biology 3D (skeleton, heart, brain, lungs) needs real
anatomical model files, not primitives — planned as a separate track.

---

# v3.8 — physics sims: 2 bug fixes + 4 new sims (9 total)

## Fixes
- **Pendulum crashed** ("Cannot read properties of undefined reading
  'position'"): the shared scaffold started its render loop and called step()
  before the sim had created its meshes. Added a ready-gate — step() runs only
  after the sim calls S.api.ready() at the end of setup. Applied to all sims.
- **Incline block sat under a floating plank**: replaced the thin tilted box
  with a solid triangular wedge (ExtrudeGeometry) resting on the ground, and
  placed the block ON the hypotenuse offset along the surface NORMAL. Verified
  the block sits above the ramp surface at every angle.

## New sims (now 9 total)
- **Orbit**: velocity slider as ×circular-speed. Verified circular speed →
  constant-radius circle; 1.2× → ellipse; √2× → hyperbolic escape; slow →
  dips inward. Central inverse-square gravity with sub-stepping.
- **Wall of death / bike in a well**: bike rides the inside of a cylinder;
  normal force = centripetal, friction holds weight. v_min = √(g·r/μ); below
  it the bike slips down. Speed / μ / radius sliders.
- **Mirror reflection**: parallel rays reflect off flat/concave/convex mirrors
  via r = d − 2(d·n)n. Concave converges to the real focus at f = R/2 (marker
  verified at the convergence point); convex diverges from a virtual focus;
  flat stays parallel. Curvature slider.
- **DC circuit**: battery + resistor loop with moving charge dots; I = V/R
  (verified double-R halves I). Capacitor toggle switches to RC charging with
  I(t) = (V/R)e^(−t/RC) and V_C = V(1−e^(−t/RC)) (verified time constant τ=RC).

All 9 mount + dispose without crashing (headless), share zoom + fullscreen,
and the analyze schema/vision prompt now route to the right sim type.

## Verified vs. needs-your-eyes
Verified: every sim's physics against theory, the crash fix ordering, the
incline geometry, and headless mount/dispose. Needs a real browser: the visual
look and animation feel of all nine.
