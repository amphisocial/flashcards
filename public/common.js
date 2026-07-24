/* Shared helpers for all pages: API client, auth, topbar rendering, toasts. */
window.AppCommon = (() => {
  const state = { user: null, usage: null, authMode: 'signup' };

  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => Array.from(document.querySelectorAll(selector));
  const isGatedPage = () => document.body.dataset.page !== 'landing';

  function escapeHtml(value) {
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  let toastTimer = null;
  function setStatus(message, type = '') {
    // Native <dialog> elements render in the browser's top layer, above the
    // entire rest of the page — including a page-level toast, even one with
    // a high z-index. While a dialog is open, show messages inside it.
    const openDialog = document.querySelector('dialog[open]');
    const dialogError = openDialog?.querySelector('.modal-error');
    if (dialogError) {
      dialogError.textContent = message || '';
      dialogError.classList.toggle('visible', Boolean(message));
      dialogError.classList.toggle('error', type === 'error');
      dialogError.classList.toggle('success', type === 'success');
      return;
    }
    const inline = $('#statusText');
    if (inline) {
      inline.textContent = message || '';
      inline.className = `status ${type}`.trim();
    }
    const toast = $('#toast');
    if (toast && message && (!inline || type === 'error' || type === 'success')) {
      toast.textContent = message;
      toast.className = `toast show ${type}`.trim();
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => toast.classList.remove('show'), 4200);
    }
  }

  function clearDialogError(dialog) {
    const box = dialog?.querySelector('.modal-error');
    if (box) { box.textContent = ''; box.classList.remove('visible', 'error', 'success'); }
  }

  function setButtonLoading(button, loading, loadingText) {
    if (!button) return;
    if (loading) {
      button.dataset.originalText ||= button.textContent;
      button.textContent = loadingText || 'Please wait…';
      button.disabled = true;
      button.classList.add('is-loading');
    } else {
      button.textContent = loadingText || button.dataset.originalText || button.textContent;
      button.disabled = false;
      button.classList.remove('is-loading');
    }
  }

  async function api(path, options = {}) {
    const response = await fetch(path, {
      headers: options.body instanceof FormData ? undefined : { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      ...options
    });
    if (response.status === 401 && isGatedPage()) {
      window.location.href = '/?login=1';
      throw new Error('Please sign in first.');
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Request failed: ${response.status}`);
    return data;
  }

  function updateUsagePill() {
    const pill = $('#usagePill');
    if (!pill) return;
    if (!state.user) {
      pill.textContent = 'Sign in to track usage';
      return;
    }
    if (state.usage) pill.textContent = `${state.usage.remaining} of ${state.usage.limit} sets left today`;
  }

  function updateAuthUI() {
    const area = $('#authArea');
    updateWhiteboardNav();
    if (!area) return;
    if (!state.user) {
      area.innerHTML = `
        <button class="btn ghost" id="openLogin">Log in</button>
        <button class="btn primary" id="openSignup">Sign up free</button>
      `;
      $('#openLogin').addEventListener('click', () => openAuth('login'));
      $('#openSignup').addEventListener('click', () => openAuth('signup'));
    } else {
      const openApp = document.body.dataset.page === 'landing'
        ? '<a class="btn primary" href="/app">Open app</a>'
        : '';
      const trial = state.user.trial;
      const trialBadge = trial && trial.active
        ? `<span class="trial-chip" title="Trial ends ${new Date(trial.endsAt).toLocaleDateString()}">${trial.daysRemaining}-day trial left</span>`
        : '';
      area.innerHTML = `
        ${openApp}
        ${trialBadge}
        <span class="user-chip">${escapeHtml(state.user.firstName || state.user.email)} • ${escapeHtml(state.user.planLabel)}</span>
        <button class="btn ghost" id="logoutBtn">Log out</button>
      `;
      $('#logoutBtn').addEventListener('click', logout);
    }
    updateUsagePill();
  }

  // Shows/hides the "Whiteboard" nav link based on whether the signed-in
  // user currently has Teams-level access (paid or trialing). Runs on every
  // auth refresh so it reacts immediately to a trial starting or expiring.
  function updateWhiteboardNav() {
    const link = $('#whiteboardNavLink');
    if (!link) return;
    const hasAccess = Boolean(state.user && state.user.limits && state.user.limits.whiteboard);
    link.style.display = hasAccess ? '' : 'none';
  }

  function openAuth(mode) {
    const dialog = $('#authDialog');
    if (!dialog) {
      window.location.href = `/?login=${mode === 'login' ? 1 : 0}`;
      return;
    }
    state.authMode = mode;
    const isSignup = mode === 'signup';
    $('#authTitle').textContent = isSignup ? 'Sign up free' : 'Log in';
    $('#authNames').style.display = isSignup ? 'grid' : 'none';
    $('#authPassword').autocomplete = isSignup ? 'new-password' : 'current-password';
    $('#authSubmit').textContent = isSignup ? 'Create free account' : 'Log in';
    $('#pwHints').style.display = isSignup ? 'flex' : 'none';
    $('#switchAuth').innerHTML = isSignup
      ? 'Already have an account? <button type="button" id="switchAuthBtn">Log in</button>'
      : 'New here? <button type="button" id="switchAuthBtn">Create an account</button>';
    $('#switchAuthBtn').addEventListener('click', () => openAuth(isSignup ? 'login' : 'signup'));
    clearDialogError(dialog);
    $('#authEmail').value = '';
    $('#authPassword').value = '';
    updatePasswordHints();
    dialog.showModal();
    $('#authEmail').focus();
  }

  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  function passwordChecks(password) {
    return {
      len: password.length >= 8,
      num: /\d/.test(password)
    };
  }

  function updatePasswordHints() {
    const hints = $('#pwHints');
    if (!hints || hints.style.display === 'none') return;
    const checks = passwordChecks($('#authPassword')?.value || '');
    hints.querySelectorAll('li').forEach((li) => {
      const ok = checks[li.dataset.rule];
      li.classList.toggle('met', Boolean(ok));
    });
  }

  async function submitAuth(event) {
    event.preventDefault();
    const dialog = $('#authDialog');
    clearDialogError(dialog);

    const email = $('#authEmail').value.trim();
    const password = $('#authPassword').value;
    const isSignup = state.authMode === 'signup';

    if (!email || !EMAIL_RE.test(email)) {
      return setStatus('Enter a valid email address.', 'error');
    }
    if (isSignup) {
      const checks = passwordChecks(password);
      if (!checks.len) return setStatus('Password must be at least 8 characters.', 'error');
      if (!checks.num) return setStatus('Password must include at least one number.', 'error');
    } else if (!password) {
      return setStatus('Enter your password.', 'error');
    }

    const payload = {
      email,
      password,
      firstName: $('#firstName')?.value || '',
      lastName: $('#lastName')?.value || ''
    };
    const button = $('#authSubmit');
    setButtonLoading(button, true, isSignup ? 'Creating account…' : 'Logging in…');
    try {
      const data = await api(isSignup ? '/api/auth/register' : '/api/auth/login', {
        method: 'POST',
        body: JSON.stringify(payload)
      });
      state.user = data.user;
      dialog.close();
      if (document.body.dataset.page === 'landing') {
        window.location.href = '/app';
        return;
      }
      updateAuthUI();
    } catch (error) {
      setStatus(error.message, 'error');
    } finally {
      setButtonLoading(button, false, isSignup ? 'Create free account' : 'Log in');
    }
  }

  async function logout() {
    await api('/api/auth/logout', { method: 'POST', body: JSON.stringify({}) });
    state.user = null;
    state.usage = null;
    if (isGatedPage()) {
      window.location.href = '/';
      return;
    }
    updateAuthUI();
  }

  async function refreshMe() {
    try {
      const data = await api('/api/me');
      state.user = data.user;
      state.usage = data.usage;
    } catch {
      state.user = null;
      state.usage = null;
    }
    updateAuthUI();
  }

  function requireSignedIn() {
    if (state.user) return true;
    openAuth('signup');
    setStatus('Please sign in to continue.', 'error');
    return false;
  }

  async function checkout(plan) {
    if (!requireSignedIn()) return;
    try {
      const data = await api('/api/billing/checkout', { method: 'POST', body: JSON.stringify({ plan }) });
      window.location.href = data.url;
    } catch (error) {
      setStatus(error.message, 'error');
    }
  }

  async function startTrial(plan) {
    if (!requireSignedIn()) return;
    try {
      const data = await api('/api/billing/trial', { method: 'POST', body: JSON.stringify({ plan }) });
      state.user = data.user;
      updateAuthUI();
      setStatus(`Your 7-day free trial of ${data.user.planLabel} has started. Enjoy!`, 'success');
      return data.user;
    } catch (error) {
      setStatus(error.message, 'error');
    }
  }

  function bindCommon() {
    $('#authSubmit')?.addEventListener('click', submitAuth);
    $('#authPassword')?.addEventListener('input', updatePasswordHints);
    $$('.checkout').forEach((button) => button.addEventListener('click', () => checkout(button.dataset.plan)));
    $$('.start-trial').forEach((button) => button.addEventListener('click', () => startTrial(button.dataset.plan)));
  }

  async function initCommon() {
    bindCommon();
    await refreshMe();
    const params = new URLSearchParams(window.location.search);
    if (params.get('billing') === 'success') {
      setStatus('Billing updated. Your plan will refresh after Stripe confirms the subscription.', 'success');
    }
    if (params.get('billing') === 'cancelled') {
      setStatus('Checkout cancelled. Your plan was not changed.', '');
    }
  }

  return { state, $, $$, escapeHtml, setStatus, api, openAuth, refreshMe, requireSignedIn, checkout, startTrial, updateAuthUI, updateUsagePill, initCommon, setButtonLoading, clearDialogError };
})();
