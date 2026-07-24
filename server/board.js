/*
 * Athena Whiteboard (Phase 1)
 * -----------------------------------------------------------------------
 * One board per teacher. Reuses the Teams-plan invite list already
 * maintained for study-set sharing — there is no separate whiteboard
 * invite flow. Board strokes/state live in their own file
 * (data/board-data.json) so frequent drawing writes never contend with
 * the main store.json (users/sessions/study sets).
 *
 * Exposes:
 *   attachBoardRoutes(app, deps)         - REST endpoints
 *   attachBoardWebSocket(server, deps)   - live sync + AI actions over WS
 *
 * `deps` is a small set of things board.js needs from server.js rather
 * than reimplementing: readStore/writeStore-equivalents are local to this
 * file (separate JSON file), but auth/plan/user helpers are shared.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const DATA_DIR = path.join(__dirname, '..', 'data');
const BOARD_FILE = path.join(DATA_DIR, 'board-data.json');

// Cap how much stroke history we keep per board so the JSON file and the
// initial sync payload for new viewers stay bounded. A "clear" resets this.
const MAX_STROKES_PER_BOARD = 4000;

function ensureBoardStore() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(BOARD_FILE)) {
    fs.writeFileSync(BOARD_FILE, JSON.stringify({ boards: [] }, null, 2));
  }
}

function readBoardStore() {
  ensureBoardStore();
  try {
    const parsed = JSON.parse(fs.readFileSync(BOARD_FILE, 'utf8'));
    parsed.boards ||= [];
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

// One board per teacherId, created lazily on first access.
function getOrCreateBoard(teacherId) {
  const store = readBoardStore();
  let board = store.boards.find((b) => b.teacherId === teacherId);
  if (!board) {
    board = {
      id: boardId(),
      teacherId,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      strokes: [],       // { id, tool, color, size, points:[{x,y}], shape? }
      aiNotes: []        // { id, kind: 'explain'|'graph', prompt, result, createdAt }
    };
    store.boards.push(board);
    writeBoardStore(store);
  }
  return board;
}

function saveBoard(board) {
  const store = readBoardStore();
  const idx = store.boards.findIndex((b) => b.id === board.id);
  board.updatedAt = nowIso();
  if (idx >= 0) store.boards[idx] = board;
  else store.boards.push(board);
  writeBoardStore(store);
}

// ---------------------------------------------------------------------
// REST routes
// ---------------------------------------------------------------------
function attachBoardRoutes(app, deps) {
  const { requireUser, publicUser, readStore, userCanViewBoard, userHasWhiteboardAccess } = deps;

  // Metadata for "my board" (teacher) — creates it if it doesn't exist yet.
  // Requires Teams plan (or an active Teams trial, already reflected in
  // req.user.plan by the time requireUser attaches it).
  app.get('/api/board/mine', requireUser, (req, res) => {
    if (!userHasWhiteboardAccess(req.user)) {
      return res.status(403).json({ error: 'The whiteboard is available on the Teams plan. Start a free 7-day Teams trial to try it.' });
    }
    const board = getOrCreateBoard(req.user.id);
    res.json({ board: { id: board.id, teacherId: board.teacherId, strokeCount: board.strokes.length, updatedAt: board.updatedAt } });
  });

  // Fetch a specific teacher's board (owner or invited viewer only).
  app.get('/api/board/:teacherId', requireUser, (req, res) => {
    const store = readStore();
    const teacher = store.users.find((u) => u.id === req.params.teacherId);
    if (!teacher) return res.status(404).json({ error: 'Board not found.' });
    if (!userCanViewBoard(req.user, req.params.teacherId, store)) {
      return res.status(403).json({ error: 'You have not been invited to this teacher\'s whiteboard.' });
    }
    const board = getOrCreateBoard(req.params.teacherId);
    res.json({
      board,
      teacher: { id: teacher.id, name: [teacher.firstName, teacher.lastName].filter(Boolean).join(' ') || teacher.email },
      isOwner: req.user.id === req.params.teacherId
    });
  });

  // List which of a teacher's students/viewers currently have board access
  // (mirrors whatever emails have been invited to any of the teacher's
  // study sets, deduplicated) — lets the teacher see who can see their board.
  app.get('/api/board/mine/viewers', requireUser, (req, res) => {
    if (!userHasWhiteboardAccess(req.user)) return res.status(403).json({ error: 'Teams plan required.' });
    const store = readStore();
    const emails = new Set();
    store.quizlets.filter((s) => s.ownerId === req.user.id).forEach((s) => (s.invitedEmails || []).forEach((e) => emails.add(e)));
    res.json({ viewers: Array.from(emails) });
  });
}

// ---------------------------------------------------------------------
// WebSocket: live drawing sync + "Ask AI" actions
// ---------------------------------------------------------------------
// Protocol (JSON messages both directions):
//   client -> server:
//     { type: 'stroke:add', stroke }
//     { type: 'stroke:shape', stroke }        // recognized/snapped shape
//     { type: 'board:clear' }
//     { type: 'ai:explain', snapshot }        // snapshot = base64 PNG data URL
//     { type: 'ai:plot', expression }         // e.g. "y = x^2 - 3"
//   server -> client:
//     { type: 'sync', board }                 // sent once on connect
//     { type: 'stroke:add', stroke }          // rebroadcast
//     { type: 'stroke:shape', stroke }
//     { type: 'board:clear' }
//     { type: 'ai:result', note }
//     { type: 'error', message }
//
// Only the teacher (owner) may draw, clear, or trigger AI actions. Viewers
// receive a read-only connection; any mutating message from a non-owner is
// rejected. This is enforced per-connection at auth time, not just in the UI.
function attachBoardWebSocket(httpServer, deps) {
  const { getUserFromCookieHeader, readStore, userCanViewBoard, userHasWhiteboardAccess, askVisionAI } = deps;

  const wss = new WebSocketServer({ server: httpServer, path: '/ws/board' });

  // teacherId -> Set of { ws, user, isOwner }
  const rooms = new Map();

  function roomFor(teacherId) {
    if (!rooms.has(teacherId)) rooms.set(teacherId, new Set());
    return rooms.get(teacherId);
  }

  function broadcast(teacherId, payload, exceptWs) {
    const room = rooms.get(teacherId);
    if (!room) return;
    const data = JSON.stringify(payload);
    for (const client of room) {
      if (client.ws !== exceptWs && client.ws.readyState === 1) client.ws.send(data);
    }
  }

  wss.on('connection', (ws, req) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const teacherId = url.searchParams.get('teacherId');
      if (!teacherId) return ws.close(4001, 'Missing teacherId');

      // The browser sends the session cookie automatically on this upgrade
      // request since it's same-origin — no token in the URL needed.
      const user = getUserFromCookieHeader(req.headers.cookie);
      if (!user) return ws.close(4001, 'Not signed in');

      const store = readStore();
      const teacher = store.users.find((u) => u.id === teacherId);
      if (!teacher) return ws.close(4004, 'Board not found');
      if (!userCanViewBoard(user, teacherId, store)) return ws.close(4003, 'Not invited to this board');

      const isOwner = user.id === teacherId;
      if (isOwner && !userHasWhiteboardAccess(user)) return ws.close(4003, 'Teams plan required');

      const client = { ws, user, isOwner };
      roomFor(teacherId).add(client);

      const board = getOrCreateBoard(teacherId);
      ws.send(JSON.stringify({ type: 'sync', board }));

      ws.on('message', async (raw) => {
        let msg;
        try { msg = JSON.parse(raw.toString()); } catch { return; }

        // Read-only guard: only the owning teacher may mutate the board.
        const mutating = ['stroke:add', 'stroke:shape', 'board:clear', 'ai:explain', 'ai:plot'];
        if (mutating.includes(msg.type) && !isOwner) {
          return ws.send(JSON.stringify({ type: 'error', message: 'Only the teacher can draw on this board.' }));
        }

        if (msg.type === 'stroke:add' || msg.type === 'stroke:shape') {
          const stroke = { ...msg.stroke, id: msg.stroke?.id || boardId('str'), createdAt: nowIso() };
          const b = getOrCreateBoard(teacherId);
          b.strokes.push(stroke);
          if (b.strokes.length > MAX_STROKES_PER_BOARD) b.strokes = b.strokes.slice(-MAX_STROKES_PER_BOARD);
          saveBoard(b);
          broadcast(teacherId, { type: msg.type, stroke }, ws);
          return;
        }

        if (msg.type === 'board:clear') {
          const b = getOrCreateBoard(teacherId);
          b.strokes = [];
          saveBoard(b);
          broadcast(teacherId, { type: 'board:clear' }, null);
          return;
        }

        if (msg.type === 'ai:explain') {
          try {
            const result = await askVisionAI({
              kind: 'explain',
              instructions: 'You are looking at a classroom whiteboard. Briefly explain, in plain language a student could follow, what is written or drawn (equation, diagram, concept). If it is a math expression, also state the result or key property. Keep it under 120 words.',
              imageDataUrl: msg.snapshot
            });
            const note = { id: boardId('note'), kind: 'explain', result, createdAt: nowIso() };
            const b = getOrCreateBoard(teacherId);
            b.aiNotes.push(note);
            saveBoard(b);
            broadcast(teacherId, { type: 'ai:result', note }, null);
          } catch (error) {
            ws.send(JSON.stringify({ type: 'error', message: error.message || 'AI explain failed.' }));
          }
          return;
        }

        if (msg.type === 'ai:plot') {
          // Pure client-side math plotting (no AI call needed) — the server
          // just records the request in aiNotes so it shows in board history
          // and broadcasts it so viewers' clients render the same graph.
          const note = { id: boardId('note'), kind: 'graph', expression: String(msg.expression || '').slice(0, 200), createdAt: nowIso() };
          const b = getOrCreateBoard(teacherId);
          b.aiNotes.push(note);
          saveBoard(b);
          broadcast(teacherId, { type: 'ai:result', note }, null);
          return;
        }
      });

      ws.on('close', () => {
        const room = rooms.get(teacherId);
        if (room) {
          room.delete(client);
          if (room.size === 0) rooms.delete(teacherId);
        }
      });
    } catch (error) {
      console.error('Board WS connection error:', error);
      try { ws.close(1011, 'Internal error'); } catch {}
    }
  });

  return wss;
}

module.exports = { attachBoardRoutes, attachBoardWebSocket, getOrCreateBoard };
