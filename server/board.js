/*
 * Athena Whiteboard (Phase 1+)
 * -----------------------------------------------------------------------
 * A teacher can have several SAVED boards (like documents), but only ever
 * one LIVE board at a time — going live on one automatically takes any
 * other board off live. Viewers (people on the teacher's team roster, see
 * server/team.js) can only join a board that is both `shared: true` and
 * currently live; saved-but-not-live boards are private editing space for
 * the teacher only.
 *
 * Board data lives in its own file, data/board-data.json, kept separate
 * from data/store.json (users/sessions/study sets) so frequent drawing
 * writes never contend with the file everything else depends on.
 *
 * Exposes:
 *   attachBoardRoutes(app, deps)         - REST endpoints
 *   attachBoardWebSocket(server, deps)   - live sync + presence + AI actions
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const DATA_DIR = path.join(__dirname, '..', 'data');
const BOARD_FILE = path.join(DATA_DIR, 'board-data.json');

const MAX_STROKES_PER_PAGE = 4000;
const MAX_BOARDS_PER_TEACHER = 20;
const MAX_PAGES_PER_BOARD = 20;
const MAX_BACKGROUND_CHARS = 2_800_000; // ~2MB once base64-encoded

function ensureBoardStore() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(BOARD_FILE)) {
    fs.writeFileSync(BOARD_FILE, JSON.stringify({ boards: [] }, null, 2));
  }
}

// Boards created by the first whiteboard release predate the title/shared/
// isLive fields. Backfill them on read so old boards don't render blank or
// behave as though those flags were explicitly set to something.
function normalizeBoard(board, index) {
  if (typeof board.title !== 'string' || !board.title.trim()) {
    board.title = `Whiteboard ${index + 1}`;
  }
  board.shared = Boolean(board.shared);
  board.isLive = Boolean(board.isLive);
  board.aiNotes ||= [];
  migrateBoardShape(board);
  return board;
}

function readBoardStore() {
  ensureBoardStore();
  try {
    const parsed = JSON.parse(fs.readFileSync(BOARD_FILE, 'utf8'));
    parsed.boards ||= [];
    parsed.boards.forEach(normalizeBoard);
    return parsed;
  } catch (error) {
    console.error('Failed to read board store:', error);
    return { boards: [] };
  }
}

function writeBoardStore(store) {
  ensureBoardStore();
  const temp = `${BOARD_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(store, null, 2));
  fs.renameSync(temp, BOARD_FILE);
}

function boardId(prefix = 'brd') {
  return `${prefix}_${crypto.randomBytes(12).toString('hex')}`;
}

function nowIso() {
  return new Date().toISOString();
}

function newPage(template) {
  return {
    id: boardId('pg'),
    template: template || 'blank',
    background: null,
    strokes: [],
    objects: []
  };
}

// Boards used to be a single flat surface (`board.strokes`). Multi-page moves
// that content into `pages[0]` so existing boards keep every stroke they had.
function migrateBoardShape(board) {
  if (!Array.isArray(board.pages) || !board.pages.length) {
    const first = newPage('blank');
    if (Array.isArray(board.strokes)) first.strokes = board.strokes;
    board.pages = [first];
  }
  delete board.strokes;
  board.pages.forEach((page) => {
    page.id ||= boardId('pg');
    page.template ||= 'blank';
    page.background ||= null;
    page.strokes ||= [];
    page.objects ||= [];
  });
  return board;
}

function boardSummary(board) {
  return {
    id: board.id,
    teacherId: board.teacherId,
    title: board.title,
    createdAt: board.createdAt,
    updatedAt: board.updatedAt,
    shared: Boolean(board.shared),
    isLive: Boolean(board.isLive),
    pageCount: board.pages.length,
    strokeCount: board.pages.reduce((n, p) => n + p.strokes.length, 0)
  };
}

// Only an allowlisted character set is ever compiled/rendered client-side
// for a plotted expression (see public/board.js compileExpression) — this
// mirrors that allowlist so a bad AI extraction from "read the equation on
// this selection" fails loudly server-side rather than reaching a viewer's
// browser as unvalidated text.
const SAFE_EXPRESSION_RE = /^[a-zA-Z0-9\s.+\-*/^()=]+$/;

function isSafeExpression(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed || trimmed.length > 200) return false;
  if (!SAFE_EXPRESSION_RE.test(trimmed)) return false;
  return true;
}

// ---------------------------------------------------------------------
// REST routes
// ---------------------------------------------------------------------
function attachBoardRoutes(app, deps) {
  const { requireUser, readStore, emailOnRoster, canViewTeachersContent, userHasWhiteboardAccess, notifyTeamOfShare, APP_BASE_URL, askVisionAI, generateWithProvider, saveGeneratedSet, canCreateSet } = deps;
  // canViewTeachersContent = on the team roster OR invited under the older
  // per-study-set model. Whiteboard access used to be granted purely by the
  // latter, so checking only the roster silently cut off every student who
  // already had access before the roster existed.
  const viewerAllowed = canViewTeachersContent || ((store, teacherId, email) => emailOnRoster(store, teacherId, email));

  function requireWhiteboardPlan(req, res) {
    if (!userHasWhiteboardAccess(req.user)) {
      res.status(403).json({ error: 'The whiteboard is available on the Teams plan. Start a free 7-day Teams trial to try it.' });
      return false;
    }
    return true;
  }

  function findBoard(store, boardIdParam) {
    return store.boards.find((b) => b.id === boardIdParam);
  }

  // ---- Teacher: manage saved boards --------------------------------------
  app.get('/api/board/mine/list', requireUser, (req, res) => {
    if (!requireWhiteboardPlan(req, res)) return;
    const store = readBoardStore();
    const boards = store.boards
      .filter((b) => b.teacherId === req.user.id)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map(boardSummary);
    res.json({ boards });
  });

  app.post('/api/board/mine/new', requireUser, (req, res) => {
    if (!requireWhiteboardPlan(req, res)) return;
    const store = readBoardStore();
    const existing = store.boards.filter((b) => b.teacherId === req.user.id);
    if (existing.length >= MAX_BOARDS_PER_TEACHER) {
      return res.status(400).json({ error: `You've reached the ${MAX_BOARDS_PER_TEACHER}-board limit. Delete an old board to make room.` });
    }
    const title = String(req.body.title || '').trim().slice(0, 80) || `Untitled board ${existing.length + 1}`;
    const board = {
      id: boardId(),
      teacherId: req.user.id,
      title,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      shared: false,
      isLive: false,
      strokes: [],
      aiNotes: []
    };
    store.boards.push(board);
    writeBoardStore(store);
    res.json({ board: boardSummary(board) });
  });

  app.post('/api/board/:boardId/save', requireUser, (req, res) => {
    const store = readBoardStore();
    const board = findBoard(store, req.params.boardId);
    if (!board || board.teacherId !== req.user.id) return res.status(404).json({ error: 'Board not found.' });
    if (req.body.title !== undefined) board.title = String(req.body.title).trim().slice(0, 80) || board.title;
    board.updatedAt = nowIso();
    writeBoardStore(store);
    res.json({ board: boardSummary(board) });
  });

  app.delete('/api/board/:boardId', requireUser, (req, res) => {
    const store = readBoardStore();
    const board = findBoard(store, req.params.boardId);
    if (!board || board.teacherId !== req.user.id) return res.status(404).json({ error: 'Board not found.' });
    store.boards = store.boards.filter((b) => b.id !== req.params.boardId);
    writeBoardStore(store);
    res.json({ ok: true });
  });

  app.post('/api/board/:boardId/share-toggle', requireUser, (req, res) => {
    if (!requireWhiteboardPlan(req, res)) return;
    const store = readBoardStore();
    const board = findBoard(store, req.params.boardId);
    if (!board || board.teacherId !== req.user.id) return res.status(404).json({ error: 'Board not found.' });
    const wasShared = Boolean(board.shared);
    board.shared = Boolean(req.body.shared);
    board.updatedAt = nowIso();
    writeBoardStore(store);
    if (board.shared && !wasShared && notifyTeamOfShare) {
      notifyTeamOfShare({
        store: readStore(),
        owner: req.user,
        title: board.title,
        url: `${APP_BASE_URL}/board/${board.id}`,
        kind: 'whiteboard'
      });
    }
    res.json({ board: boardSummary(board) });
  });

  // Going live on one board automatically takes any other board this
  // teacher owns off live — a teacher can only ever broadcast one board.
  app.post('/api/board/:boardId/go-live', requireUser, (req, res) => {
    if (!requireWhiteboardPlan(req, res)) return;
    const store = readBoardStore();
    const board = findBoard(store, req.params.boardId);
    if (!board || board.teacherId !== req.user.id) return res.status(404).json({ error: 'Board not found.' });
    store.boards.forEach((b) => { if (b.teacherId === req.user.id) b.isLive = false; });
    const wasShared = Boolean(board.shared);
    board.isLive = true;
    // Going live on a board nobody can see is never what's intended, so
    // going live also shares it. Unshare/stop-live remain separate.
    board.shared = true;
    board.updatedAt = nowIso();
    writeBoardStore(store);
    if (!wasShared && notifyTeamOfShare) {
      notifyTeamOfShare({
        store: readStore(),
        owner: req.user,
        title: board.title,
        url: `${APP_BASE_URL}/board/${board.id}`,
        kind: 'live whiteboard'
      });
    }
    res.json({ board: boardSummary(board) });
  });

  app.post('/api/board/:boardId/stop-live', requireUser, (req, res) => {
    const store = readBoardStore();
    const board = findBoard(store, req.params.boardId);
    if (!board || board.teacherId !== req.user.id) return res.status(404).json({ error: 'Board not found.' });
    board.isLive = false;
    board.updatedAt = nowIso();
    writeBoardStore(store);
    res.json({ board: boardSummary(board) });
  });

  // ---- Fetch a specific board (owner, or invited viewer of a live+shared board) ----
  app.get('/api/board/:boardId', requireUser, (req, res) => {
    const boardStore = readBoardStore();
    const board = findBoard(boardStore, req.params.boardId);
    if (!board) return res.status(404).json({ error: 'Board not found.' });

    const isOwner = req.user.id === board.teacherId;
    const mainStore = readStore();
    const teacher = mainStore.users.find((u) => u.id === board.teacherId);
    if (!teacher) return res.status(404).json({ error: 'Board owner no longer exists.' });
    const teacherInfo = { id: teacher.id, name: [teacher.firstName, teacher.lastName].filter(Boolean).join(' ') || teacher.email };

    if (!isOwner) {
      const allowed = board.shared && board.isLive && viewerAllowed(mainStore, board.teacherId, req.user.email);
      if (!allowed) return res.status(403).json({ error: 'This whiteboard is not currently live and shared with you.' });
    }
    res.json({ board, teacher: teacherInfo, isOwner });
  });

  // Every board shared with me, live or not — Library lists these so a
  // student has somewhere to see what a teacher shared even between
  // sessions. Only live ones are joinable (enforced in the fetch route).
  app.get('/api/board/shared/mine', requireUser, (req, res) => {
    const mainStore = readStore();
    const boardStore = readBoardStore();
    const boards = boardStore.boards
      .filter((b) => b.shared && b.teacherId !== req.user.id && viewerAllowed(mainStore, b.teacherId, req.user.email))
      .sort((a, b) => Number(b.isLive) - Number(a.isLive) || b.updatedAt.localeCompare(a.updatedAt))
      .map((b) => {
        const teacher = mainStore.users.find((u) => u.id === b.teacherId);
        return {
          boardId: b.id,
          title: b.title,
          isLive: Boolean(b.isLive),
          updatedAt: b.updatedAt,
          teacherName: teacher ? ([teacher.firstName, teacher.lastName].filter(Boolean).join(' ') || teacher.email) : 'Unknown teacher'
        };
      });
    res.json({ boards });
  });

  // ---- Page management -------------------------------------------------
  function ownedBoard(req, res) {
    const store = readBoardStore();
    const board = store.boards.find((b) => b.id === req.params.boardId);
    if (!board || board.teacherId !== req.user.id) {
      res.status(404).json({ error: 'Board not found.' });
      return {};
    }
    return { store, board };
  }

  app.post('/api/board/:boardId/pages', requireUser, (req, res) => {
    const { store, board } = ownedBoard(req, res);
    if (!board) return;
    if (board.pages.length >= MAX_PAGES_PER_BOARD) {
      return res.status(400).json({ error: `A board can hold up to ${MAX_PAGES_PER_BOARD} pages.` });
    }
    const page = newPage(req.body.template);
    board.pages.push(page);
    board.updatedAt = nowIso();
    writeBoardStore(store);
    res.json({ page, pageCount: board.pages.length });
  });

  app.patch('/api/board/:boardId/pages/:pageId', requireUser, (req, res) => {
    const { store, board } = ownedBoard(req, res);
    if (!board) return;
    const page = board.pages.find((p) => p.id === req.params.pageId);
    if (!page) return res.status(404).json({ error: 'Page not found.' });
    if (req.body.template !== undefined) page.template = String(req.body.template);
    if (req.body.background !== undefined) {
      const bg = req.body.background;
      // Backgrounds are stored inline as data URLs. Cap them so one imported
      // photo can't bloat board-data.json for everyone on the board.
      if (bg && String(bg).length > MAX_BACKGROUND_CHARS) {
        return res.status(413).json({ error: 'That image is too large. Try one under ~2MB.' });
      }
      page.background = bg || null;
    }
    board.updatedAt = nowIso();
    writeBoardStore(store);
    res.json({ page });
  });

  app.delete('/api/board/:boardId/pages/:pageId', requireUser, (req, res) => {
    const { store, board } = ownedBoard(req, res);
    if (!board) return;
    if (board.pages.length <= 1) return res.status(400).json({ error: 'A board needs at least one page.' });
    board.pages = board.pages.filter((p) => p.id !== req.params.pageId);
    board.updatedAt = nowIso();
    writeBoardStore(store);
    res.json({ pageCount: board.pages.length });
  });

  // ---- Analyze: classify what's on the page, then answer in kind --------
  // One vision call returns a typed result so the panel can render the right
  // shape of answer (worked steps, a definition, formulas...) instead of a
  // wall of prose. Everything is optional in the response; the client renders
  // whichever fields come back.
  const ANALYZE_INSTRUCTIONS = [
    'You are looking at a photo of a classroom whiteboard.',
    'Identify what is on it and respond with a SINGLE JSON object, no markdown fences, no prose outside the JSON.',
    'Schema:',
    '{',
    '  "kind": one of "algebra","calculus","system","arithmetic","word","geometry","chemistry","physics","diagram","sketch","empty","unknown",',
    '  "title": short label for what this is,',
    '  "summary": 1-2 sentence plain-language description,',
    '  "method": name of the technique where relevant (e.g. "u-substitution", "elimination"), else null,',
    '  "steps": [ { "step": "what to do", "why": "why this step is valid" } ],',
    '  "answer": final result as a string, or null,',
    '  "facts": [ { "label": "...", "value": "..." } ],',
    '  "formulas": ["relevant formula strings"],',
    '  "plots": ["any function in the form y = ... that would help, else omit"],',
    '  "warnings": ["anything wrong, ambiguous, or dimensionally inconsistent"]',
    '}',
    'Guidance by kind:',
    '- algebra/arithmetic/calculus/system: fill "steps" with a full worked solution, each with a justification. For calculus set "method". For systems state which method and why.',
    '- word: "facts" should carry part of speech, definition, example sentence, and etymology.',
    '- geometry: "facts" for labeled properties, "formulas" for area/perimeter/theorems that apply.',
    '- chemistry: compound name in "title", balanced equation in "answer", structural observations in "facts".',
    '- physics: name the concept in "title", governing formulas in "formulas", and CHECK UNITS - put any dimensional inconsistency in "warnings".',
    '- diagram: summarize structure in "summary" and list what is missing or unclear in "warnings".',
    '- sketch: identify the drawing in "title" and describe how to finish it in "steps".',
    'If the board is blank, use kind "empty".'
  ].join('\n');

  function parseAnalysis(raw) {
    const text = String(raw || '').trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start < 0 || end <= start) throw new Error('The model did not return a readable analysis.');
    return JSON.parse(text.slice(start, end + 1));
  }

  app.post('/api/board/:boardId/analyze', requireUser, async (req, res) => {
    const store = readBoardStore();
    const board = store.boards.find((b) => b.id === req.params.boardId);
    if (!board) return res.status(404).json({ error: 'Board not found.' });
    if (board.teacherId !== req.user.id) return res.status(403).json({ error: 'Only the teacher can analyze this board.' });
    if (!req.body.snapshot) return res.status(400).json({ error: 'No board snapshot provided.' });
    try {
      const raw = await askVisionAI({ instructions: ANALYZE_INSTRUCTIONS, imageDataUrl: req.body.snapshot });
      const analysis = parseAnalysis(raw);
      analysis.id = boardId('an');
      analysis.createdAt = nowIso();
      res.json({ analysis });
    } catch (error) {
      res.status(502).json({ error: error.message || 'Could not analyze the board.' });
    }
  });

  // ---- Board -> study set ----------------------------------------------
  // Reads every page with the vision model, then hands the extracted text to
  // the same generator the rest of the app uses, so a lesson on the board
  // becomes flashcards/quiz/slides sharable with the same roster.
  app.post('/api/board/:boardId/to-study-set', requireUser, async (req, res) => {
    const store = readBoardStore();
    const board = store.boards.find((b) => b.id === req.params.boardId);
    if (!board || board.teacherId !== req.user.id) return res.status(404).json({ error: 'Board not found.' });

    const usage = canCreateSet(req.user);
    if (!usage.ok) return res.status(429).json({ error: `You've used all ${usage.limit} study sets for today.` });

    const snapshots = Array.isArray(req.body.snapshots) ? req.body.snapshots.slice(0, MAX_PAGES_PER_BOARD) : [];
    if (!snapshots.length) return res.status(400).json({ error: 'No board pages were captured.' });

    try {
      const extracted = [];
      for (let i = 0; i < snapshots.length; i += 1) {
        // Sequential on purpose: parallel vision calls across 20 pages is a
        // good way to get rate-limited by every provider at once.
        // eslint-disable-next-line no-await-in-loop
        const text = await askVisionAI({
          instructions: 'Transcribe and describe everything on this whiteboard page as plain study material: equations, definitions, diagrams, labels, worked steps. Write it as clean prose and lists a student could revise from. No preamble.',
          imageDataUrl: snapshots[i]
        });
        if (text && text.trim()) extracted.push(`--- Page ${i + 1} ---\n${text.trim()}`);
      }
      const content = extracted.join('\n\n');
      if (content.trim().length < 20) return res.status(400).json({ error: 'There was not enough on the board to build a study set.' });

      const format = ['flashcard', 'quiz', 'mixed', 'slides'].includes(req.body.format) ? req.body.format : 'mixed';
      const cardCount = Math.max(1, Math.min(60, Number(req.body.cardCount || 10)));
      const generated = await generateWithProvider({ content, cardCount, format, subject: req.body.subject || board.title });
      const studySet = saveGeneratedSet(req.user, {
        title: generated.title || `${board.title} — study set`,
        cards: generated.cards,
        subject: req.body.subject || board.title,
        format,
        sourceType: 'whiteboard'
      });
      res.json({ set: studySet });
    } catch (error) {
      console.error('Board to study set failed:', error);
      res.status(500).json({ error: error.message || 'Could not build a study set from this board.' });
    }
  });

  // ---- Viewer discovery: which of MY teachers are live right now? -------
  app.get('/api/board/live/mine', requireUser, (req, res) => {
    const mainStore = readStore();
    const boardStore = readBoardStore();
    const live = boardStore.boards
      .filter((b) => b.isLive && b.shared && viewerAllowed(mainStore, b.teacherId, req.user.email))
      .map((b) => {
        const teacher = mainStore.users.find((u) => u.id === b.teacherId);
        return {
          boardId: b.id,
          teacherId: b.teacherId,
          teacherName: teacher ? ([teacher.firstName, teacher.lastName].filter(Boolean).join(' ') || teacher.email) : 'Unknown teacher',
          title: b.title,
          updatedAt: b.updatedAt
        };
      });
    res.json({ live });
  });
}

// ---------------------------------------------------------------------
// WebSocket: live drawing sync, presence, and AI actions
// ---------------------------------------------------------------------
// Protocol (JSON messages both directions):
//   client -> server:
//     { type: 'stroke:add' | 'stroke:shape', stroke }
//     { type: 'board:clear' }
//     { type: 'ai:explain', snapshot }             // full-board PNG data URL
//     { type: 'ai:plot', expression }               // pure client-side math
//     { type: 'ai:read-equation', snapshot }        // cropped selection PNG
//   server -> client:
//     { type: 'sync', board, isOwner }
//     { type: 'stroke:add' | 'stroke:shape', stroke }
//     { type: 'board:clear' }
//     { type: 'ai:result', note }
//     { type: 'presence', viewers: [{ name, email }] }
//     { type: 'error', message }
//
// Only the owning teacher may draw/clear/trigger AI actions. A non-owner
// may only connect at all if the board is currently shared AND live.
function attachBoardWebSocket(httpServer, deps) {
  const { getUserFromCookieHeader, readStore, emailOnRoster, canViewTeachersContent, userHasWhiteboardAccess, askVisionAI } = deps;
  const viewerAllowed = canViewTeachersContent || ((store, teacherId, email) => emailOnRoster(store, teacherId, email));

  const wss = new WebSocketServer({ server: httpServer, path: '/ws/board' });

  // boardId -> Set of { ws, user, isOwner }
  const rooms = new Map();

  function roomFor(id) {
    if (!rooms.has(id)) rooms.set(id, new Set());
    return rooms.get(id);
  }

  function broadcast(id, payload, exceptWs) {
    const room = rooms.get(id);
    if (!room) return;
    const data = JSON.stringify(payload);
    for (const client of room) {
      if (client.ws !== exceptWs && client.ws.readyState === 1) client.ws.send(data);
    }
  }

  function broadcastLostCount(id) {
    const room = rooms.get(id);
    if (!room) return;
    const count = Array.from(room).filter((c) => !c.isOwner && c.lost).length;
    broadcast(id, { type: 'lost:count', count }, null);
  }

  function broadcastPresence(id) {
    const room = rooms.get(id);
    if (!room) return;
    const viewers = Array.from(room)
      .filter((c) => !c.isOwner)
      .map((c) => ({ name: [c.user.firstName, c.user.lastName].filter(Boolean).join(' ') || c.user.email, email: c.user.email }));
    broadcast(id, { type: 'presence', viewers }, null);
  }

  function getBoard(boardIdValue) {
    const store = readBoardStore();
    return store.boards.find((b) => b.id === boardIdValue);
  }

  function saveBoard(board) {
    const store = readBoardStore();
    const idx = store.boards.findIndex((b) => b.id === board.id);
    board.updatedAt = nowIso();
    if (idx >= 0) store.boards[idx] = board;
    writeBoardStore(store);
  }

  wss.on('connection', (ws, req) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const targetBoardId = url.searchParams.get('boardId');
      if (!targetBoardId) return ws.close(4001, 'Missing boardId');

      const user = getUserFromCookieHeader(req.headers.cookie);
      if (!user) return ws.close(4001, 'Not signed in');

      const board = getBoard(targetBoardId);
      if (!board) return ws.close(4004, 'Board not found');

      const isOwner = user.id === board.teacherId;
      if (isOwner && !userHasWhiteboardAccess(user)) return ws.close(4003, 'Teams plan required');
      if (!isOwner) {
        const mainStore = readStore();
        const allowed = board.shared && board.isLive && viewerAllowed(mainStore, board.teacherId, user.email);
        if (!allowed) return ws.close(4003, 'This whiteboard is not currently live and shared with you');
      }

      const client = { ws, user, isOwner, lost: false };
      roomFor(targetBoardId).add(client);

      ws.send(JSON.stringify({ type: 'sync', board, isOwner }));
      if (!isOwner) broadcastPresence(targetBoardId);

      ws.on('message', async (raw) => {
        let msg;
        try { msg = JSON.parse(raw.toString()); } catch { return; }

        // Ephemeral signals never touch disk. Reactions and the "I'm lost"
        // flag come FROM viewers by design, so they're excluded from the
        // owner-only guard below.
        if (msg.type === 'reaction') {
          const emoji = String(msg.emoji || '').slice(0, 8);
          if (!emoji) return;
          broadcast(targetBoardId, { type: 'reaction', emoji, from: isOwner ? 'teacher' : 'student' }, null);
          return;
        }

        if (msg.type === 'lost:toggle') {
          if (isOwner) return;
          client.lost = !client.lost;
          ws.send(JSON.stringify({ type: 'lost:self', lost: client.lost }));
          broadcastLostCount(targetBoardId);
          return;
        }

        const mutating = ['stroke:add', 'stroke:shape', 'stroke:remove', 'page:clear', 'page:goto',
          'object:add', 'object:update', 'object:remove', 'laser', 'insight:push',
          'ai:explain', 'ai:plot', 'ai:read-equation'];
        if (mutating.includes(msg.type) && !isOwner) {
          return ws.send(JSON.stringify({ type: 'error', message: 'Only the teacher can change this board.' }));
        }

        // Laser is pointer position during a live session: broadcast, never
        // stored, so it leaves no trace on the saved board.
        if (msg.type === 'laser') {
          broadcast(targetBoardId, { type: 'laser', x: msg.x, y: msg.y, pageIndex: msg.pageIndex, active: msg.active !== false }, ws);
          return;
        }

        // Teacher paging through the board pulls viewers along with them.
        if (msg.type === 'page:goto') {
          broadcast(targetBoardId, { type: 'page:goto', pageIndex: Number(msg.pageIndex) || 0 }, ws);
          return;
        }

        // Teacher chooses to reveal an analysis to the room.
        if (msg.type === 'insight:push') {
          broadcast(targetBoardId, { type: 'insight', analysis: msg.analysis }, ws);
          return;
        }

        const withPage = (fn) => {
          const b = getBoard(targetBoardId);
          if (!b) return null;
          const page = b.pages.find((p) => p.id === msg.pageId) || b.pages[0];
          if (!page) return null;
          const result = fn(b, page);
          saveBoard(b);
          return result;
        };

        if (msg.type === 'stroke:add' || msg.type === 'stroke:shape') {
          const stroke = { ...msg.stroke, id: msg.stroke?.id || boardId('str'), createdAt: nowIso() };
          withPage((b, page) => {
            page.strokes.push(stroke);
            if (page.strokes.length > MAX_STROKES_PER_PAGE) page.strokes = page.strokes.slice(-MAX_STROKES_PER_PAGE);
          });
          broadcast(targetBoardId, { type: msg.type, pageId: msg.pageId, stroke }, ws);
          return;
        }

        // Undo/redo is expressed as remove/re-add of a specific stroke id so
        // every connected client converges on the same page contents.
        if (msg.type === 'stroke:remove') {
          withPage((b, page) => { page.strokes = page.strokes.filter((st) => st.id !== msg.strokeId); });
          broadcast(targetBoardId, { type: 'stroke:remove', pageId: msg.pageId, strokeId: msg.strokeId }, ws);
          return;
        }

        if (msg.type === 'object:add' || msg.type === 'object:update') {
          const object = { ...msg.object, id: msg.object?.id || boardId('obj') };
          withPage((b, page) => {
            const idx = page.objects.findIndex((o) => o.id === object.id);
            if (idx >= 0) page.objects[idx] = object;
            else page.objects.push(object);
          });
          broadcast(targetBoardId, { type: 'object:add', pageId: msg.pageId, object }, ws);
          return;
        }

        if (msg.type === 'object:remove') {
          withPage((b, page) => { page.objects = page.objects.filter((o) => o.id !== msg.objectId); });
          broadcast(targetBoardId, { type: 'object:remove', pageId: msg.pageId, objectId: msg.objectId }, ws);
          return;
        }

        if (msg.type === 'page:clear') {
          withPage((b, page) => { page.strokes = []; page.objects = []; });
          broadcast(targetBoardId, { type: 'page:clear', pageId: msg.pageId }, null);
          return;
        }

        if (msg.type === 'ai:explain') {
          try {
            const result = await askVisionAI({
              instructions: 'You are looking at a classroom whiteboard. Briefly explain, in plain language a student could follow, what is written or drawn. If it is a math expression, state the result. Under 120 words.',
              imageDataUrl: msg.snapshot
            });
            const note = { id: boardId('note'), kind: 'explain', result, createdAt: nowIso() };
            const b = getBoard(targetBoardId);
            if (b) { b.aiNotes.push(note); saveBoard(b); }
            broadcast(targetBoardId, { type: 'ai:result', note }, null);
          } catch (error) {
            ws.send(JSON.stringify({ type: 'error', message: error.message || 'AI explain failed.' }));
          }
          return;
        }

        if (msg.type === 'ai:plot') {
          const note = { id: boardId('note'), kind: 'graph', expression: String(msg.expression || '').slice(0, 200), createdAt: nowIso() };
          const b = getBoard(targetBoardId);
          if (b) { b.aiNotes.push(note); saveBoard(b); }
          broadcast(targetBoardId, { type: 'ai:result', note }, null);
          return;
        }

        // "Select an equation, hit Plot": a vision call extracts the equation
        // text, which is then validated against the same character allowlist
        // the client's safe parser enforces, so a bad extraction fails here
        // rather than reaching a viewer's browser as unvalidated text.
        if (msg.type === 'ai:read-equation') {
          try {
            const raw2 = await askVisionAI({
              instructions: 'Extract ONLY the mathematical equation or expression shown in this image selection. Respond with just the equation (e.g. "y = 2x + 3"), no words, no markdown. If none is visible, respond exactly: NONE',
              imageDataUrl: msg.snapshot
            });
            const cleaned = String(raw2 || '').trim();
            if (!cleaned || cleaned.toUpperCase() === 'NONE' || !isSafeExpression(cleaned)) {
              ws.send(JSON.stringify({ type: 'error', message: "Couldn't read an equation there — try a tighter box around just the equation." }));
              return;
            }
            broadcast(targetBoardId, { type: 'equation:read', expression: cleaned, rect: msg.rect, pageId: msg.pageId }, null);
          } catch (error) {
            ws.send(JSON.stringify({ type: 'error', message: error.message || 'Could not read the selection.' }));
          }
          return;
        }
      });

      ws.on('close', () => {
        const room = rooms.get(targetBoardId);
        if (room) {
          room.delete(client);
          if (room.size === 0) rooms.delete(targetBoardId);
          else if (!isOwner) { broadcastPresence(targetBoardId); broadcastLostCount(targetBoardId); }
        }
      });
    } catch (error) {
      console.error('Board WS connection error:', error);
      try { ws.close(1011, 'Internal error'); } catch {}
    }
  });

  return wss;
}

// Returns the id of the board a teacher should land on when they just click
// "Whiteboard": their most recently updated one, creating a first board if
// they have none. Before multi-board support, clicking Whiteboard always
// dropped you straight onto a canvas; without this you land on an empty list
// and have to create a board before you can draw anything.
function getOrCreateCurrentBoardId(teacherId) {
  const store = readBoardStore();
  const mine = store.boards
    .filter((b) => b.teacherId === teacherId)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  if (mine.length) return mine[0].id;

  const board = {
    id: boardId(),
    teacherId,
    title: 'My Whiteboard',
    createdAt: nowIso(),
    updatedAt: nowIso(),
    shared: false,
    isLive: false,
    pages: [newPage('blank')],
    aiNotes: []
  };
  store.boards.push(board);
  writeBoardStore(store);
  return board.id;
}

module.exports = { attachBoardRoutes, attachBoardWebSocket, getOrCreateCurrentBoardId };
