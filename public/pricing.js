/*
 * pricing.js — the in-app account/plan page. Reads /api/membership and renders
 * the user's status, feature access, upgrade path, referral tools, and (for
 * founders/admins) the promo and reward-fulfilment views.
 */
(async () => {
  const C = window.AppCommon;
  const { $, escapeHtml, api, initCommon, checkout, setStatus, state } = C;

  await initCommon();
  if (!state.user) { window.location.href = '/?login=1'; return; }

  const PLAN_NAMES = { free: 'Free', starter: 'Pro', team: 'Teams' };

  // Feature matrix: label -> which effective plans include it.
  const FEATURES = [
    { label: 'AI study sets per day', value: (m) => String(m.limits.setsPerDay) },
    { label: 'Flashcards, quizzes & notes', plans: ['free', 'starter', 'team'] },
    { label: 'Scan a page → notes + quiz', plans: ['free', 'starter', 'team'] },
    { label: 'Live AI whiteboard', plans: ['team'] },
    { label: '3D science & physics sims', plans: ['team'] },
    { label: 'Live classroom (students join)', plans: ['team'] },
    { label: 'Share with up to 30 students', plans: ['team'] }
  ];

  let membership = null;
  try {
    membership = await api('/api/membership');
  } catch (e) {
    $('#statusCard').innerHTML = `<div class="status-loading">Couldn't load your plan. Please refresh.</div>`;
    return;
  }

  renderStatus(membership);
  renderFeatures(membership);
  renderUpgrade(membership);
  renderReferrals(membership);
  renderPromo(membership);
  if (membership.isAdmin) renderAdmin();

  function renderStatus(m) {
    const roleLabel = m.isAdmin ? 'Admin' : m.isFounder ? 'Founding Teacher' : PLAN_NAMES[m.effectivePlan] || 'Free';
    const roleClass = m.isAdmin ? 'admin' : m.isFounder ? 'founder' : m.effectivePlan;
    let sub = '';
    if (m.isAdmin) sub = 'Full access to every feature.';
    else if (m.isFounder) sub = 'Full access as a founding teacher — no subscription needed.';
    else if (m.effectivePlan === 'team') sub = 'You have the full Teams plan.';
    else if (m.effectivePlan === 'starter') sub = 'You have Pro. Upgrade to Teams for the whiteboard.';
    else sub = 'You are on the Free plan.';

    let seats = '';
    if (m.seats) {
      seats = `<div class="seat-meter">
        <span>Team seats</span>
        <strong>${m.seats.used} / ${m.seats.cap}</strong>
      </div>`;
    }

    $('#statusCard').innerHTML = `
      <div class="status-head">
        <span class="plan-pill ${roleClass}">${escapeHtml(roleLabel)}</span>
        <p>${escapeHtml(sub)}</p>
      </div>
      ${seats}
    `;
  }

  function renderFeatures(m) {
    const eff = m.effectivePlan;
    const rows = FEATURES.map((f) => {
      let cell;
      if (f.value) cell = `<span class="feat-val">${escapeHtml(f.value(m))}</span>`;
      else {
        const has = f.plans.includes(eff);
        cell = has ? `<span class="feat-yes">✓ Included</span>` : `<span class="feat-no">— Not on your plan</span>`;
      }
      return `<div class="feat-row"><span>${escapeHtml(f.label)}</span>${cell}</div>`;
    }).join('');
    $('#featureMatrix').innerHTML = rows;
  }

  function renderUpgrade(m) {
    // Only paying-but-not-Teams users (Pro) see the upgrade path. Founders/
    // admins already have everything; free users are nudged elsewhere.
    const show = m.effectivePlan === 'starter' && !m.isFounder && !m.isAdmin;
    $('#upgradeSection').style.display = show ? '' : 'none';
    if (show) {
      $('#upgradeTeamsBtn').addEventListener('click', () => checkout('team'));
    }
  }

  function renderReferrals(m) {
    const stats = m.referrals || { invited: 0, qualified: 0, referrals: [] };
    $('#referralStats').innerHTML = `
      <div class="rstat"><strong>${stats.invited}</strong><span>invited</span></div>
      <div class="rstat"><strong>${stats.qualified}</strong><span>qualified</span></div>
      <div class="rstat"><strong>${(m.referrals.rewards || []).filter(r => r.kind==='free_month').length}</strong><span>free months earned</span></div>
    `;
    $('#referralSendBtn').addEventListener('click', sendReferral);
    $('#referralEmail').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendReferral(); });
  }

  async function sendReferral() {
    const email = $('#referralEmail').value.trim();
    const statusEl = $('#referralStatus');
    if (!email || !email.includes('@')) { statusEl.textContent = 'Enter a valid email.'; statusEl.className = 'referral-status err'; return; }
    $('#referralSendBtn').disabled = true;
    try {
      const r = await api('/api/referral/invite', { method: 'POST', body: JSON.stringify({ email }) });
      statusEl.textContent = r.emailed
        ? `Invite sent to ${email}.`
        : `Invite recorded for ${email} (email delivery is off — share your link manually).`;
      statusEl.className = 'referral-status ok';
      $('#referralEmail').value = '';
      // Refresh stats.
      try { const m2 = await api('/api/membership'); renderReferrals(m2); } catch (_) {}
    } catch (e) {
      statusEl.textContent = e.message || 'Could not send the invite.';
      statusEl.className = 'referral-status err';
    } finally {
      $('#referralSendBtn').disabled = false;
    }
  }

  function renderPromo(m) {
    if (m.isFounder) {
      $('#promoSection').style.display = '';
      $('#referralBlurb').textContent =
        'Invite another teacher. When they sign up and create their first board or study set, you get a free month — and as a founding teacher, referring a paid or founding member also earns you a $25 Amazon gift card.';
    }
  }

  async function renderAdmin() {
    $('#adminSection').style.display = '';
    const box = $('#adminRewards');
    try {
      const { pending } = await api('/api/admin/rewards');
      if (!pending.length) { box.innerHTML = `<p class="admin-empty">No pending gift-card rewards.</p>`; return; }
      box.innerHTML = pending.map((r) => {
        const detail = r.detail || {};
        return `<div class="admin-reward" data-id="${r.id}">
          <div>
            <strong>${escapeHtml(r.beneficiary_email)}</strong>
            <span>referred ${escapeHtml(detail.referredEmail || '')}</span>
            <span class="admin-date">${new Date(r.created_at).toLocaleDateString()}</span>
          </div>
          <button class="btn soft small resolve-btn" data-id="${r.id}">Mark sent</button>
        </div>`;
      }).join('');
      box.querySelectorAll('.resolve-btn').forEach((b) => b.addEventListener('click', async () => {
        b.disabled = true;
        try {
          await api(`/api/admin/rewards/${b.dataset.id}/resolve`, { method: 'POST' });
          b.closest('.admin-reward').remove();
          if (!box.querySelector('.admin-reward')) box.innerHTML = `<p class="admin-empty">No pending gift-card rewards.</p>`;
        } catch (_) { b.disabled = false; }
      }));
    } catch (e) {
      box.innerHTML = `<p class="admin-empty">Couldn't load rewards.</p>`;
    }
  }
})();
