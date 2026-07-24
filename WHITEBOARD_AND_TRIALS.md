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
