/*
 * membership.js — roles, access, referrals, and founder rewards.
 *
 * Access model, in priority order:
 *   1. ADMIN_EMAIL (from .env)      -> role 'admin',   full access, no billing
 *   2. FOUNDER_EMAILS (from .env)   -> role 'founder', full access, no billing
 *   3. memberships table row         -> whatever it says (kept in sync on login)
 *   4. otherwise                     -> the user's Stripe plan / trial
 *
 * Admins and founders get the effective 'team' plan (all features, including
 * the whiteboard) without paying. This is resolved live from .env on every
 * request, so adding an email to FOUNDER_EMAILS and restarting immediately
 * grants access — no DB edit required. The memberships table is the persisted
 * mirror (so we can query "who is a founder") and is reconciled at login.
 *
 * Referrals (everyone) and gift-card rewards (founders only) live in the
 * referrals / reward_events tables created in db.js.
 */

function splitEmails(raw) {
  return String(raw || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function adminEmail() {
  return (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
}
function founderEmails() {
  return new Set(splitEmails(process.env.FOUNDER_EMAILS));
}

// Role from .env alone (the source of truth for privileged access). Returns
// 'admin' | 'founder' | null.
function envRole(email) {
  const e = String(email || '').trim().toLowerCase();
  if (!e) return null;
  if (e === adminEmail()) return 'admin';
  if (founderEmails().has(e)) return 'founder';
  return null;
}

function isPrivileged(email) {
  return envRole(email) !== null;
}

function attachMembership(db, deps) {
  const { PLAN_LIMITS } = deps;

  // Effective plan for a user: privileged accounts always resolve to 'team'
  // (full access) regardless of what they've paid.
  function effectivePlan(user) {
    if (!user) return 'free';
    if (isPrivileged(user.email)) return 'team';
    return user.plan || 'free';
  }

  function role(user) {
    return envRole(user && user.email) || 'member';
  }

  function isFounder(user) {
    return role(user) === 'founder';
  }
  function isAdmin(user) {
    return role(user) === 'admin';
  }

  // Full effective limits, honouring privilege.
  function effectiveLimits(user) {
    const plan = effectivePlan(user);
    return PLAN_LIMITS[plan] || PLAN_LIMITS.free;
  }

  function hasWhiteboard(user) {
    return Boolean(effectiveLimits(user).whiteboard);
  }

  // Reconcile the memberships table with .env + the user's current plan.
  // Called on login/registration so the persisted mirror stays accurate and
  // any 'pending_<email>' seed row (created by the migration before the user
  // existed) is re-keyed to the real user id.
  async function reconcile(user) {
    if (!user || !user.email) return;
    const email = user.email.toLowerCase();
    const r = envRole(email);
    const role = r || 'member';
    const founder = r === 'founder';
    const plan = effectivePlan(user);
    try {
      // Remove any pending seed row for this email so we don't keep two.
      await db.query(`DELETE FROM memberships WHERE user_id = $1 AND user_id <> $2`,
        [`pending_${email}`, user.id]);
      await db.query(
        `INSERT INTO memberships (user_id, email, role, plan, is_founder, granted_by_env, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, now())
         ON CONFLICT (user_id) DO UPDATE SET
           email = EXCLUDED.email, role = EXCLUDED.role, plan = EXCLUDED.plan,
           is_founder = EXCLUDED.is_founder, granted_by_env = EXCLUDED.granted_by_env,
           updated_at = now()`,
        [user.id, email, role, plan, founder, Boolean(r)]
      );
    } catch (e) {
      console.error('[membership] reconcile failed:', e.message);
    }
  }

  // ---- Referrals -------------------------------------------------------

  // Record an invite. Idempotent per referred email (unique constraint).
  async function recordReferral(referrer, referredEmail) {
    const email = String(referredEmail || '').trim().toLowerCase();
    if (!email) throw new Error('referred email required');
    if (email === String(referrer.email).toLowerCase()) throw new Error('You cannot refer yourself.');
    try {
      await db.query(
        `INSERT INTO referrals (referrer_id, referrer_email, referred_email, status)
         VALUES ($1, $2, $3, 'invited')
         ON CONFLICT (referred_email) DO NOTHING`,
        [referrer.id, referrer.email.toLowerCase(), email]
      );
    } catch (e) {
      console.error('[membership] recordReferral failed:', e.message);
      throw e;
    }
    const { rows } = await db.query(`SELECT * FROM referrals WHERE lower(referred_email) = $1`, [email]);
    return rows[0] || null;
  }

  // When a referred user first creates content (board or study set), the
  // referral qualifies and the reward is granted exactly once. Free month for
  // everyone; founders who refer a paid/founder member ALSO trigger a $25
  // gift-card reward event for the admin to fulfil manually.
  async function onReferredContentCreated(user) {
    if (!user || !user.email) return;
    const email = user.email.toLowerCase();
    const client = await db.getClient();
    try {
      await client.query('BEGIN');
      // Lock the referral row so two concurrent content-creates can't both
      // grant the reward.
      const { rows } = await client.query(
        `SELECT * FROM referrals WHERE lower(referred_email) = $1 FOR UPDATE`, [email]);
      const ref = rows[0];
      if (!ref || ref.status === 'qualified' || ref.status === 'rewarded') {
        await client.query('COMMIT'); return;
      }
      // Mark joined + qualified.
      await client.query(
        `UPDATE referrals SET status = 'qualified', referred_user_id = $2,
           joined_at = COALESCE(joined_at, now()), qualified_at = now()
         WHERE id = $1`, [ref.id, user.id]);

      // Grant the free month to the referrer (recorded as a reward_event; the
      // actual Stripe coupon/credit is applied by the billing layer or by the
      // admin — kept out of the hot path so a Stripe hiccup can't block signup).
      await client.query(
        `INSERT INTO reward_events (kind, beneficiary_id, beneficiary_email, referral_id, detail)
         VALUES ('free_month', $1, $2, $3, $4)`,
        [ref.referrer_id, ref.referrer_email, ref.id,
         JSON.stringify({ reason: 'referred user created content', referredEmail: email })]);

      await client.query('COMMIT');

      // Founder $25 gift-card promo: if the REFERRER is a founder and the
      // referred user is (or becomes) a paying/founder member, raise a
      // gift-card event for the admin. Checked outside the txn since it reads
      // env + the referred user's plan.
      const referrerIsFounder = envRole(ref.referrer_email) === 'founder';
      const referredIsPaidOrFounder =
        isPrivileged(email) || ['starter', 'team'].includes(user.plan) || isTrialPaid(user);
      if (referrerIsFounder && referredIsPaidOrFounder) {
        await db.query(
          `INSERT INTO reward_events (kind, beneficiary_id, beneficiary_email, referral_id, detail)
           VALUES ('giftcard_25', $1, $2, $3, $4)`,
          [ref.referrer_id, ref.referrer_email, ref.id,
           JSON.stringify({ promo: 'Founding member referral', referredEmail: email })]);
        await db.query(`UPDATE referrals SET reward_kind = 'giftcard_25' WHERE id = $1`, [ref.id]);
        if (deps.notifyAdminOfReward) {
          deps.notifyAdminOfReward({ founderEmail: ref.referrer_email, referredEmail: email }).catch(() => {});
        }
      }
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      console.error('[membership] onReferredContentCreated failed:', e.message);
    } finally {
      client.release();
    }
  }

  function isTrialPaid(user) {
    // A 7-day trial of a paid plan counts as "paid" for the founder promo,
    // per the product decision (we want users; take the promo out later).
    return Boolean(user && user.trialPlan && ['starter', 'team'].includes(user.trialPlan));
  }

  // Referral + reward summary for a user's pricing page.
  async function referralSummary(user) {
    const { rows: refs } = await db.query(
      `SELECT referred_email, status, created_at, qualified_at
         FROM referrals WHERE referrer_id = $1 ORDER BY created_at DESC`, [user.id]);
    const { rows: rewards } = await db.query(
      `SELECT kind, created_at, resolved FROM reward_events
         WHERE beneficiary_id = $1 ORDER BY created_at DESC`, [user.id]);
    return {
      invited: refs.length,
      qualified: refs.filter((r) => r.status === 'qualified' || r.status === 'rewarded').length,
      referrals: refs,
      rewards
    };
  }

  // Admin dashboard feed: unresolved gift-card events to fulfil.
  async function pendingRewards() {
    const { rows } = await db.query(
      `SELECT * FROM reward_events WHERE kind = 'giftcard_25' AND resolved = false
         ORDER BY created_at ASC`);
    return rows;
  }

  return {
    envRole, isPrivileged, effectivePlan, role, isFounder, isAdmin,
    effectiveLimits, hasWhiteboard, reconcile,
    recordReferral, onReferredContentCreated, referralSummary, pendingRewards
  };
}

module.exports = { attachMembership, envRole, isPrivileged, splitEmails };
