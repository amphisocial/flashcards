/*
 * Tests the membership/referral/reward engine against real Postgres.
 * Runs the module directly (no HTTP server) to keep it deterministic.
 *
 * Requires DATABASE_URL. ADMIN_EMAIL / FOUNDER_EMAILS are set in-process.
 */
process.env.ADMIN_EMAIL = 'admin@athenaboard.test';
process.env.FOUNDER_EMAILS = 'founder@athenaboard.test, founder2@athenaboard.test';
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
// Re-assert after dotenv so the test values win even if .env has its own.
process.env.ADMIN_EMAIL = 'admin@athenaboard.test';
process.env.FOUNDER_EMAILS = 'founder@athenaboard.test, founder2@athenaboard.test';

const db = require('../server/db');
const { attachMembership, envRole, isPrivileged } = require('../server/membership');

const PLAN_LIMITS = {
  free: { label: 'Free', setsPerDay: 5, shareSeats: 0, whiteboard: false },
  starter: { label: 'Starter', setsPerDay: 10, shareSeats: 0, whiteboard: false },
  team: { label: 'Teams', setsPerDay: 20, shareSeats: 30, whiteboard: true }
};

let pass = 0, fail = 0;
let rewardNotified = [];
function ok(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
}

(async () => {
  await db.init();
  const membership = attachMembership(db, {
    PLAN_LIMITS,
    notifyAdminOfReward: async (info) => { rewardNotified.push(info); return { sent: true }; }
  });

  const stamp = Date.now();
  const admin = { id: `u_admin_${stamp}`, email: 'admin@athenaboard.test', plan: 'free' };
  const founder = { id: `u_founder_${stamp}`, email: 'founder@athenaboard.test', plan: 'free' };
  const proUser = { id: `u_pro_${stamp}`, email: `pro_${stamp}@x.test`, plan: 'starter' };
  const freeUser = { id: `u_free_${stamp}`, email: `free_${stamp}@x.test`, plan: 'free' };

  console.log('env roles and privileged access');
  {
    ok('admin email resolves to admin role', envRole(admin.email) === 'admin');
    ok('founder email resolves to founder role', envRole(founder.email) === 'founder');
    ok('random email is not privileged', !isPrivileged(freeUser.email));
    ok('admin gets team plan effectively', membership.effectivePlan(admin) === 'team');
    ok('founder gets whiteboard access', membership.hasWhiteboard(founder) === true);
    ok('free user has no whiteboard', membership.hasWhiteboard(freeUser) === false);
    ok('pro (starter) user has no whiteboard', membership.hasWhiteboard(proUser) === false);
  }

  console.log('\nmembership reconcile persists roles');
  {
    await membership.reconcile(admin);
    await membership.reconcile(founder);
    await membership.reconcile(freeUser);
    const { rows } = await db.query(`SELECT role, is_founder FROM memberships WHERE user_id = $1`, [founder.id]);
    ok('founder row persisted as founder', rows[0] && rows[0].role === 'founder' && rows[0].is_founder === true);
    const { rows: fr } = await db.query(`SELECT role FROM memberships WHERE user_id = $1`, [freeUser.id]);
    ok('free user persisted as member', fr[0] && fr[0].role === 'member');
  }

  console.log('\nreferral: self-referral blocked');
  {
    let threw = false;
    try { await membership.recordReferral(proUser, proUser.email); } catch { threw = true; }
    ok('cannot refer yourself', threw);
  }

  console.log('\nreferral: free-month on qualifying content (non-founder referrer)');
  {
    const referred = { id: `u_ref1_${stamp}`, email: `ref1_${stamp}@x.test`, plan: 'free' };
    await membership.recordReferral(proUser, referred.email);
    // Before content: no reward.
    let { rows } = await db.query(`SELECT * FROM reward_events WHERE beneficiary_id = $1`, [proUser.id]);
    ok('no reward before referred creates content', rows.length === 0);
    // Referred creates content -> qualifies.
    await membership.onReferredContentCreated(referred);
    ({ rows } = await db.query(`SELECT * FROM reward_events WHERE beneficiary_id = $1 AND kind='free_month'`, [proUser.id]));
    ok('free_month reward granted to referrer', rows.length === 1);
    // Idempotent: creating more content doesn't double-grant.
    await membership.onReferredContentCreated(referred);
    ({ rows } = await db.query(`SELECT * FROM reward_events WHERE beneficiary_id = $1 AND kind='free_month'`, [proUser.id]));
    ok('reward not double-granted on second content-create', rows.length === 1);
    const { rows: refRow } = await db.query(`SELECT status FROM referrals WHERE lower(referred_email)=$1`, [referred.email]);
    ok('referral marked qualified', refRow[0].status === 'qualified');
  }

  console.log('\nreferral: founder referring a PAID user -> $25 gift card + admin notify');
  {
    rewardNotified = [];
    const referredPaid = { id: `u_ref2_${stamp}`, email: `ref2_${stamp}@x.test`, plan: 'team' };
    await membership.recordReferral(founder, referredPaid.email);
    await membership.onReferredContentCreated(referredPaid);
    const { rows } = await db.query(`SELECT * FROM reward_events WHERE beneficiary_id = $1 AND kind='giftcard_25'`, [founder.id]);
    ok('founder gets a $25 gift-card reward event', rows.length === 1);
    ok('admin was notified of the gift card', rewardNotified.length === 1 && rewardNotified[0].founderEmail === founder.email);
  }

  console.log('\nreferral: founder referring a FREE user -> free month, but NO gift card');
  {
    rewardNotified = [];
    const referredFree = { id: `u_ref3_${stamp}`, email: `ref3_${stamp}@x.test`, plan: 'free' };
    await membership.recordReferral(founder, referredFree.email);
    await membership.onReferredContentCreated(referredFree);
    const { rows: gc } = await db.query(
      `SELECT * FROM reward_events WHERE referral_id = (SELECT id FROM referrals WHERE lower(referred_email)=$1) AND kind='giftcard_25'`,
      [referredFree.email]);
    ok('no gift card for founder referring a free user', gc.length === 0);
    ok('admin NOT notified for free referral', rewardNotified.length === 0);
  }

  console.log('\nadmin pending rewards feed');
  {
    const pending = await membership.pendingRewards();
    ok('pending gift-card list is non-empty', pending.length >= 1);
    ok('every pending reward is an unresolved giftcard_25',
      pending.every((r) => r.kind === 'giftcard_25' && r.resolved === false));
  }

  await db.drain();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('threw:', e); process.exit(1); });
