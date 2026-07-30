/*
 * migrate-to-postgres.js — one-time (idempotent) migration.
 *
 *   node scripts/migrate-to-postgres.js
 *
 * 1. Connects using DATABASE_URL and creates all tables (safe to re-run —
 *    everything is CREATE TABLE IF NOT EXISTS).
 * 2. If data/store.json and/or data/board-data.json exist, imports their
 *    contents into the document tables (upsert by id, so re-running won't
 *    duplicate).
 * 3. Backs up the JSON files to *.migrated-<timestamp>.bak first, so nothing
 *    is ever destroyed.
 * 4. Seeds memberships from ADMIN_EMAIL and FOUNDER_EMAILS in .env.
 *
 * Since this app has no real users yet, in practice this mostly just creates
 * the schema — but it's written to be safe even if there is test data.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');
const db = require('../server/db');

const DATA_DIR = path.join(__dirname, '..', 'data');
const STORE_FILE = path.join(DATA_DIR, 'store.json');
const BOARD_FILE = path.join(DATA_DIR, 'board-data.json');

function backup(file) {
  if (!fs.existsSync(file)) return;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = `${file}.migrated-${stamp}.bak`;
  fs.copyFileSync(file, dest);
  console.log(`  backed up ${path.basename(file)} -> ${path.basename(dest)}`);
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return fallback; }
}

async function importCollection(table, arr) {
  if (!Array.isArray(arr) || !arr.length) { console.log(`  ${table}: 0`); return; }
  let n = 0;
  for (const item of arr) {
    if (!item || !item.id) continue;
    await db.query(
      `INSERT INTO ${table} (id, data, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
      [item.id, item]
    );
    n++;
  }
  console.log(`  ${table}: ${n}`);
}

async function seedMemberships() {
  const admin = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  const founders = (process.env.FOUNDER_EMAILS || '')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

  // Match env emails to any existing user rows to attach user_id; otherwise
  // store the membership keyed by email with a synthetic id so the grant
  // applies the moment that email signs up (server reconciles on login).
  const { rows } = await db.query(`SELECT data FROM app_users`);
  const byEmail = new Map(rows.map((r) => [String(r.data.email || '').toLowerCase(), r.data]));

  async function grant(email, role, isFounder) {
    const user = byEmail.get(email);
    const userId = user ? user.id : `pending_${email}`;
    await db.query(
      `INSERT INTO memberships (user_id, email, role, plan, is_founder, granted_by_env, updated_at)
       VALUES ($1, $2, $3, $4, $5, true, now())
       ON CONFLICT (user_id) DO UPDATE SET
         role = EXCLUDED.role, is_founder = memberships.is_founder OR EXCLUDED.is_founder,
         granted_by_env = true, updated_at = now()`,
      [userId, email, role, 'team', isFounder]
    );
    console.log(`  membership: ${email} -> ${role}${isFounder ? ' (founder)' : ''}`);
  }

  if (admin) await grant(admin, 'admin', false);
  for (const f of founders) await grant(f, 'founder', true);
  if (!admin && !founders.length) console.log('  (no ADMIN_EMAIL / FOUNDER_EMAILS set — skipping seed)');
}

(async () => {
  console.log('Connecting and creating schema...');
  await db.init(); // creates schema + warms snapshot

  console.log('Backing up JSON files...');
  backup(STORE_FILE);
  backup(BOARD_FILE);

  console.log('Importing store.json...');
  const store = readJson(STORE_FILE, {});
  await importCollection('app_users', store.users || []);
  await importCollection('app_sessions', store.sessions || []);
  await importCollection('app_quizlets', store.quizlets || []);
  await importCollection('app_passages', store.passages || []);
  await importCollection('app_events', store.events || []);
  await importCollection('app_sat_sessions', store.satSessions || []);

  console.log('Importing board-data.json...');
  const boards = readJson(BOARD_FILE, { boards: [] });
  await importCollection('app_boards', boards.boards || []);

  console.log('Seeding memberships from .env...');
  await seedMemberships();

  await db.drain();
  console.log('\nMigration complete.');
  process.exit(0);
})().catch((e) => {
  console.error('Migration failed:', e);
  process.exit(1);
});
