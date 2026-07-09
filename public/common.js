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
      area.innerHTML = `
        ${openApp}
        <span class="user-chip">${escapeHtml(state.user.firstName || state.user.email)} • ${escapeHtml(state.user.planLabel)}</span>
        <button class="btn ghost" id="logoutBtn">Log out</button>
      `;
      $('#logoutBtn').addEventListener('click', logout);
    }
    updateUsagePill();
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
    $('#switchAuth').innerHTML = isSignup
      ? 'Already have an account? <button type="button" id="switchAuthBtn">Log in</button>'
      : 'New here? <button type="button" id="switchAuthBtn">Create an account</button>';
    $('#switchAuthBtn').addEventListener('click', () => openAuth(isSignup ? 'login' : 'signup'));
    dialog.showModal();
  }

  async function submitAuth(event) {
    event.preventDefault();
    const payload = {
      email: $('#authEmail').value,
      password: $('#authPassword').value,
      firstName: $('#firstName')?.value || '',
      lastName: $('#lastName')?.value || ''
    };
    try {
      const data = await api(state.authMode === 'signup' ? '/api/auth/register' : '/api/auth/login', {
        method: 'POST',
        body: JSON.stringify(payload)
      });
      state.user = data.user;
      $('#authDialog').close();
      if (document.body.dataset.page === 'landing') {
        window.location.href = '/app';
        return;
      }
      updateAuthUI();
    } catch (error) {
      setStatus(error.message, 'error');
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

  function bindCommon() {
    $('#authSubmit')?.addEventListener('click', submitAuth);
    $$('.checkout').forEach((button) => button.addEventListener('click', () => checkout(button.dataset.plan)));
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

  return { state, $, $$, escapeHtml, setStatus, api, openAuth, refreshMe, requireSignedIn, checkout, updateAuthUI, updateUsagePill, initCommon };
})();
