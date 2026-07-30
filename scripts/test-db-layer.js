/*
 * Exercises server/db.js against a real Postgres to prove the write-through
 * layer preserves the app's synchronous readStore/writeStore contract AND
 * actually persists (survives a simulated restart).
 *
 * Requires DATABASE_URL pointing at a test database.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const db = require('../server/db');

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  await db.init();

  console.log('sync read surface');
  {
    const s = db.readStore();
    ok('readStore returns an object with users[]', s && Array.isArray(s.users));
    ok('readStore is synchronous (not a promise)', typeof s.then !== 'function');
    ok('board store returns boards[]', Array.isArray(db.readBoardStore().boards));
  }

  const testEmail = `wt_${Date.now()}@example.com`;
  const uid = `u_wt_${Date.now()}`;

  console.log('\nwrite-through: add a user the app way');
  {
    const s = db.readStore();
    const before = s.users.length;
    s.users.push({ id: uid, email: testEmail, plan: 'free', createdAt: new Date().toISOString() });
    db.writeStore(s);                       // sync call, as the app does
    ok('snapshot reflects the new user immediately', db.readStore().users.some((u) => u.id === uid));
    await db.drain();                       // let the background flush finish
    // Verify it hit Postgres by querying directly.
    const { rows } = await db.query(`SELECT data FROM app_users WHERE id = $1`, [uid]);
    ok('new user persisted to Postgres', rows.length === 1 && rows[0].data.email === testEmail);
    ok('collection grew by exactly one', db.readStore().users.length === before + 1);
  }

  console.log('\nwrite-through: mutate then delete');
  {
    const s = db.readStore();
    const u = s.users.find((x) => x.id === uid);
    u.plan = 'team';
    db.writeStore(s);
    await db.drain();
    let { rows } = await db.query(`SELECT data FROM app_users WHERE id = $1`, [uid]);
    ok('mutation persisted (plan=team)', rows[0].data.plan === 'team');

    const s2 = db.readStore();
    s2.users = s2.users.filter((x) => x.id !== uid);
    db.writeStore(s2);
    await db.drain();
    ({ rows } = await db.query(`SELECT data FROM app_users WHERE id = $1`, [uid]));
    ok('deletion removed the row from Postgres', rows.length === 0);
  }

  console.log('\nboards write-through');
  {
    const bid = `brd_wt_${Date.now()}`;
    const bs = db.readBoardStore();
    bs.boards.push({ id: bid, teacherId: 'u_1', title: 'WT board', pages: [] });
    db.writeBoardStore(bs);
    await db.drain();
    const { rows } = await db.query(`SELECT data FROM app_boards WHERE id = $1`, [bid]);
    ok('board persisted', rows.length === 1 && rows[0].data.title === 'WT board');
    // cleanup
    const bs2 = db.readBoardStore();
    bs2.boards = bs2.boards.filter((b) => b.id !== bid);
    db.writeBoardStore(bs2);
    await db.drain();
  }

  console.log('\npersistence across a simulated restart');
  {
    // Add a row, drain, then re-init a fresh module state by clearing require
    // cache and re-loading — mimicking a process restart reading from PG.
    const uid2 = `u_persist_${Date.now()}`;
    const s = db.readStore();
    s.users.push({ id: uid2, email: `persist_${Date.now()}@example.com`, plan: 'free' });
    db.writeStore(s);
    await db.drain();

    delete require.cache[require.resolve('../server/db')];
    const db2 = require('../server/db');
    await db2.init();                       // reloads snapshot from Postgres
    ok('restarted process sees the persisted user', db2.readStore().users.some((u) => u.id === uid2));
    // cleanup
    const s2 = db2.readStore();
    s2.users = s2.users.filter((u) => u.id !== uid2);
    db2.writeStore(s2);
    await db2.drain();
  }

  console.log('\nsessions persist by token (no id field — the regression)');
  {
    const token = `tok_${Date.now()}`;
    const s = db.readStore();
    s.sessions.push({ token, userId: 'u_1', createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 86400000).toISOString() });
    db.writeStore(s);
    await db.drain();
    const { rows } = await db.query(`SELECT data FROM app_sessions WHERE id = $1`, [token]);
    ok('session persisted keyed by token', rows.length === 1 && rows[0].data.token === token);
    // cleanup
    const s2 = db.readStore();
    s2.sessions = s2.sessions.filter((x) => x.token !== token);
    db.writeStore(s2);
    await db.drain();
    const { rows: after } = await db.query(`SELECT data FROM app_sessions WHERE id = $1`, [token]);
    ok('session removed on logout/expiry', after.length === 0);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('threw:', e); process.exit(1); });
