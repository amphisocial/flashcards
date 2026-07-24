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
- No per-viewer cursors/presence indicators.
- No persistent board "sessions" or replay/history scrubber — just the
  live board + capped recent stroke history (last 4,000 strokes).
- No mobile-specific touch gesture tuning beyond basic pointer-events
  support (should work, wasn't specially optimized).
