/*
 * db.js — Postgres data layer.
 *
 * The whole app was written against a synchronous flat-file store:
 *   const store = readStore();      // { users, sessions, quizlets, ... }
 *   store.users.push(...);          // mutate in memory
 *   writeStore(store);              // persist
 *
 * There are ~40 call sites doing exactly that, plus board.js keeping its own
 * { boards: [] } file. Rewriting every one of them to async SQL would be a
 * large, risky change against live-ish code. Instead this module keeps that
 * exact synchronous contract but backs it with Postgres:
 *
 *   - At boot, loadAll() pulls every row into an in-memory snapshot.
 *   - readStore() / readBoardStore() return that snapshot synchronously.
 *   - writeStore(store) / writeBoardStore() update the snapshot synchronously
 *     AND flush to Postgres in the background (a diff of what changed).
 *
 * So callers never change and never await, but the source of truth is now a
 * real transactional database. The JSON "documents" (a user object, a board
 * object with its pages/strokes) are stored as JSONB in a single data column
 * keyed by id — this is a lift-and-shift, not a full relational normalization
 * of the existing app data. NEW money-touching data (memberships, referrals,
 * founder rewards) gets proper typed columns in its own tables below, because
 * that data needs constraints and queryability the JSON blobs don't.
 *
 * Boot ordering: server.js must call `await db.init()` before it starts
 * serving, so the snapshot is warm before the first request.
 */
const { Pool } = require('pg');

let pool = null;

// In-memory snapshots (the synchronous read surface the app expects).
const snapshot = {
  users: [],
  sessions: [],
  quizlets: [],
  passages: [],
  events: [],
  satSessions: []
};
let boardSnapshot = { boards: [] };

// The document collections that live as {id, data jsonb} rows. Map of
// snapshot key -> { table, key }. Most entities key on their `id` field, but
// sessions have no id — they key on `token`. The `key` here is the JSON field
// used as the row's primary key so the row identity matches the app's.
const DOC_TABLES = {
  users:       { table: 'app_users',        key: 'id' },
  sessions:    { table: 'app_sessions',     key: 'token' },
  quizlets:    { table: 'app_quizlets',     key: 'id' },
  passages:    { table: 'app_passages',     key: 'id' },
  events:      { table: 'app_events',       key: 'id' },
  satSessions: { table: 'app_sat_sessions', key: 'id' }
};

async function init() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is not set — cannot start without Postgres.');
  }
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000
  });
  pool.on('error', (err) => console.error('[db] idle client error:', err.message));
  await createSchema();
  await loadAll();
}

async function createSchema() {
  // Document tables: one row per entity, JSONB payload, primary key drawn
  // from each collection's key field (id for most, token for sessions).
  for (const { table } of Object.values(DOC_TABLES)) {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ${table} (
        id   TEXT PRIMARY KEY,
        data JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
  }
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_users_email ON app_users ((data->>'email'));`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_quizlets_owner ON app_quizlets ((data->>'ownerId'));`);

  // Boards: same document approach, separate table (high write volume).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_boards (
      id   TEXT PRIMARY KEY,
      data JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  // ---- NEW relational tables (properly typed; the money-touching data) ----

  // Membership / roles. One row per user, mirrors and extends what plan info
  // the user blob carries, but this is the authoritative record for access
  // decisions and is queryable. role: 'admin' | 'founder' | 'member'.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS memberships (
      user_id        TEXT PRIMARY KEY,
      email          TEXT NOT NULL,
      role           TEXT NOT NULL DEFAULT 'member',
      plan           TEXT NOT NULL DEFAULT 'free',
      is_founder     BOOLEAN NOT NULL DEFAULT false,
      granted_by_env BOOLEAN NOT NULL DEFAULT false,
      updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_memberships_email ON memberships (lower(email));`);

  // Referrals. A referrer invites an email; when the referred account signs up
  // AND creates content, the referral is marked 'qualified' and the reward is
  // granted exactly once (unique on referred_email prevents double-payout).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS referrals (
      id             BIGSERIAL PRIMARY KEY,
      referrer_id    TEXT NOT NULL,
      referrer_email TEXT NOT NULL,
      referred_email TEXT NOT NULL,
      status         TEXT NOT NULL DEFAULT 'invited',  -- invited | joined | qualified | rewarded
      referred_user_id TEXT,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
      joined_at      TIMESTAMPTZ,
      qualified_at   TIMESTAMPTZ,
      rewarded_at    TIMESTAMPTZ,
      reward_kind    TEXT,                              -- free_month | giftcard_25
      UNIQUE (referred_email)
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_referrals_referrer ON referrals (referrer_id);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_referrals_referred ON referrals (lower(referred_email));`);

  // Founder applications (from "Apply as a founding teacher").
  await pool.query(`
    CREATE TABLE IF NOT EXISTS founder_applications (
      id         BIGSERIAL PRIMARY KEY,
      name       TEXT,
      email      TEXT NOT NULL,
      user_id    TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      notified   BOOLEAN NOT NULL DEFAULT false
    );
  `);

  // Admin-facing reward events (e.g. a founder qualified for the $25 card).
  // Admin reads these to know when to coordinate a gift card.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS reward_events (
      id           BIGSERIAL PRIMARY KEY,
      kind         TEXT NOT NULL,          -- giftcard_25 | free_month
      beneficiary_id    TEXT NOT NULL,
      beneficiary_email TEXT NOT NULL,
      referral_id  BIGINT,
      detail       JSONB,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      resolved     BOOLEAN NOT NULL DEFAULT false
    );
  `);
}

async function loadAll() {
  for (const [key, { table }] of Object.entries(DOC_TABLES)) {
    const { rows } = await pool.query(`SELECT data FROM ${table}`);
    snapshot[key] = rows.map((r) => r.data);
  }
  const { rows } = await pool.query(`SELECT data FROM app_boards`);
  boardSnapshot = { boards: rows.map((r) => r.data) };
}

// ---- Synchronous read surface (unchanged app contract) ------------------

function readStore() {
  // Hand back the live snapshot. Callers mutate it and then call writeStore,
  // exactly as they did with the JSON file.
  return snapshot;
}

function readBoardStore() {
  return boardSnapshot;
}

// ---- Write-through: update memory now, flush to Postgres async ----------

// Flush a document collection by upserting present rows and deleting any row
// whose id is no longer in the array. Runs in a transaction so a collection
// never lands half-written.
async function flushCollection(table, keyField, arr) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const ids = [];
    for (const item of arr) {
      const rowId = item && item[keyField];
      if (!rowId) continue;
      ids.push(rowId);
      await client.query(
        `INSERT INTO ${table} (id, data, updated_at) VALUES ($1, $2, now())
         ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
        [rowId, item]
      );
    }
    // Delete rows not present anymore (e.g. expired sessions, deleted sets).
    if (ids.length) {
      await client.query(`DELETE FROM ${table} WHERE NOT (id = ANY($1::text[]))`, [ids]);
    } else {
      await client.query(`DELETE FROM ${table}`);
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(`[db] flush ${table} failed:`, e.message);
  } finally {
    client.release();
  }
}

// Serialize flushes per table so two rapid writeStore calls can't interleave
// and clobber each other. A tiny per-table promise chain.
const flushChains = {};
function queueFlush(table, keyField, arr) {
  const snap = arr.map((x) => x); // shallow copy of the array of refs
  const prev = flushChains[table] || Promise.resolve();
  const next = prev.then(() => flushCollection(table, keyField, snap)).catch(() => {});
  flushChains[table] = next;
  return next;
}

function writeStore(store) {
  // Point the snapshot at whatever the caller handed back (usually the same
  // object they got from readStore, mutated). Keep all known collections.
  for (const key of Object.keys(DOC_TABLES)) {
    if (Array.isArray(store[key])) snapshot[key] = store[key];
  }
  // Flush each collection through its serialized chain.
  for (const [key, { table, key: keyField }] of Object.entries(DOC_TABLES)) {
    queueFlush(table, keyField, snapshot[key]);
  }
}

function writeBoardStore(store) {
  if (Array.isArray(store.boards)) boardSnapshot = { boards: store.boards };
  queueFlush('app_boards', 'id', boardSnapshot.boards);
}

// Await all pending flushes — used by scripts and graceful shutdown so we
// don't exit with writes still in flight.
async function drain() {
  await Promise.all(Object.values(flushChains));
}

module.exports = {
  init,
  readStore,
  writeStore,
  readBoardStore,
  writeBoardStore,
  drain,
  // Expose the pool for the new relational features (memberships, referrals).
  query: (text, params) => pool.query(text, params),
  getClient: () => pool.connect(),
  DOC_TABLES
};
