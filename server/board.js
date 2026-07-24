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

const MAX_STROKES_PER_BOARD = 4000;
const MAX_BOARDS_PER_TEACHER = 20;

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
  board.strokes ||= [];
  board.aiNotes ||= [];
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

function boardSummary(board) {
  return {
    id: board.id,
    teacherId: board.teacherId,
    title: board.title,
    createdAt: board.createdAt,
    updatedAt: board.updatedAt,
    shared: Boolean(board.shared),
    isLive: Boolean(board.isLive),
    strokeCount: board.strokes.length
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
  const { requireUser, readStore, emailOnRoster, canViewTeachersContent, userHasWhiteboardAccess, notifyTeamOfShare, APP_BASE_URL } = deps;
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

      const client = { ws, user, isOwner };
      roomFor(targetBoardId).add(client);

      ws.send(JSON.stringify({ type: 'sync', board, isOwner }));
      if (!isOwner) broadcastPresence(targetBoardId);

      ws.on('message', async (raw) => {
        let msg;
        try { msg = JSON.parse(raw.toString()); } catch { return; }

        const mutating = ['stroke:add', 'stroke:shape', 'board:clear', 'ai:explain', 'ai:plot', 'ai:read-equation'];
        if (mutating.includes(msg.type) && !isOwner) {
          return ws.send(JSON.stringify({ type: 'error', message: 'Only the teacher can draw on this board.' }));
        }

        if (msg.type === 'stroke:add' || msg.type === 'stroke:shape') {
          const stroke = { ...msg.stroke, id: msg.stroke?.id || boardId('str'), createdAt: nowIso() };
          const b = getBoard(targetBoardId);
          if (!b) return;
          b.strokes.push(stroke);
          if (b.strokes.length > MAX_STROKES_PER_BOARD) b.strokes = b.strokes.slice(-MAX_STROKES_PER_BOARD);
          saveBoard(b);
          broadcast(targetBoardId, { type: msg.type, stroke }, ws);
          return;
        }

        if (msg.type === 'board:clear') {
          const b = getBoard(targetBoardId);
          if (!b) return;
          b.strokes = [];
          saveBoard(b);
          broadcast(targetBoardId, { type: 'board:clear' }, null);
          return;
        }

        if (msg.type === 'ai:explain') {
          try {
            const result = await askVisionAI({
              instructions: 'You are looking at a classroom whiteboard. Briefly explain, in plain language a student could follow, what is written or drawn (equation, diagram, concept). If it is a math expression, also state the result or key property. Keep it under 120 words.',
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

        // "Circle an equation, hit Plot": crop is sent up as a snapshot, a
        // vision call extracts ONLY the equation text, and it's validated
        // against a strict character allowlist before ever being broadcast
        // to other users' browsers — the same allowlist the client's safe
        // expression parser enforces, so a bad extraction fails loudly here
        // rather than reaching a viewer as unvalidated text.
        if (msg.type === 'ai:read-equation') {
          try {
            const raw = await askVisionAI({
              instructions: 'Extract ONLY the mathematical equation or expression shown in this image selection. Respond with just the equation (e.g. "y = 2x + 3" or "x^2 - 4"), no words, no markdown, no explanation. If no clear equation is visible, respond with exactly: NONE',
              imageDataUrl: msg.snapshot
            });
            const cleaned = String(raw || '').trim();
            if (!cleaned || cleaned.toUpperCase() === 'NONE' || !isSafeExpression(cleaned)) {
              const note = { id: boardId('note'), kind: 'explain', result: "Couldn't find a clear equation in that selection — try selecting a tighter box around just the equation.", createdAt: nowIso() };
              const b = getBoard(targetBoardId);
              if (b) { b.aiNotes.push(note); saveBoard(b); }
              broadcast(targetBoardId, { type: 'ai:result', note }, null);
              return;
            }
            const note = { id: boardId('note'), kind: 'graph', expression: cleaned, createdAt: nowIso() };
            const b = getBoard(targetBoardId);
            if (b) { b.aiNotes.push(note); saveBoard(b); }
            broadcast(targetBoardId, { type: 'ai:result', note }, null);
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
          else if (!isOwner) broadcastPresence(targetBoardId);
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
    strokes: [],
    aiNotes: []
  };
  store.boards.push(board);
  writeBoardStore(store);
  return board.id;
}

module.exports = { attachBoardRoutes, attachBoardWebSocket, getOrCreateCurrentBoardId };
