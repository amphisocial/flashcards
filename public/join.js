(() => {
  const { $, escapeHtml, setStatus, api, setButtonLoading } = window.AppCommon;
  const params = new URLSearchParams(window.location.search);
  const token = params.get('token') || '';

  function renderError(message) {
    $('#joinBody').innerHTML = `
      <p style="text-align:center; color:var(--danger); font-weight:600;">${escapeHtml(message)}</p>
      <p style="text-align:center;"><a class="btn soft" href="/">Go to homepage</a></p>
    `;
  }

  function renderWelcome(teacherName, redirecting) {
    $('#joinBody').innerHTML = `
      <p style="text-align:center; font-weight:700; font-size:1.1rem;">Welcome to ${escapeHtml(teacherName)}'s team!</p>
      <p style="text-align:center; color:var(--muted);">${redirecting ? 'Taking you to your library…' : ''}</p>
    `;
  }

  function renderSignupForm(email, teacherName) {
    $('#joinBody').innerHTML = `
      <p style="text-align:center; margin-bottom:18px;"><strong>${escapeHtml(teacherName)}</strong> invited you to their team.<br/>Set a password to finish joining as <strong>${escapeHtml(email)}</strong>.</p>
      <form id="joinForm" style="display:grid; gap:12px;">
        <div style="display:grid; grid-template-columns:1fr 1fr; gap:10px;">
          <input id="joinFirstName" placeholder="First name" autocomplete="given-name" />
          <input id="joinLastName" placeholder="Last name" autocomplete="family-name" />
        </div>
        <input id="joinPassword" type="password" placeholder="Create a password" autocomplete="new-password" />
        <ul class="pw-hints" id="joinPwHints">
          <li data-rule="len">At least 8 characters</li>
          <li data-rule="num">At least one number</li>
        </ul>
        <div class="modal-error" id="joinError" role="alert"></div>
        <button type="submit" class="btn primary large" id="joinSubmit">Join team</button>
      </form>
    `;

    const checks = (pw) => ({ len: pw.length >= 8, num: /\d/.test(pw) });
    const updateHints = () => {
      const c = checks($('#joinPassword').value);
      $('#joinPwHints').querySelectorAll('li').forEach((li) => li.classList.toggle('met', Boolean(c[li.dataset.rule])));
    };
    $('#joinPassword').addEventListener('input', updateHints);

    $('#joinForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      const password = $('#joinPassword').value;
      const c = checks(password);
      if (!c.len) return setStatus('Password must be at least 8 characters.', 'error');
      if (!c.num) return setStatus('Password must include at least one number.', 'error');

      const button = $('#joinSubmit');
      setButtonLoading(button, true, 'Joining…');
      try {
        await api('/api/team/join/complete', {
          method: 'POST',
          body: JSON.stringify({
            token,
            password,
            firstName: $('#joinFirstName').value.trim(),
            lastName: $('#joinLastName').value.trim()
          })
        });
        renderWelcome(teacherName, true);
        setTimeout(() => { window.location.href = '/library'; }, 1200);
      } catch (error) {
        setStatus(error.message, 'error');
        setButtonLoading(button, false, 'Join team');
      }
    });
  }

  async function init() {
    if (!token) return renderError('This invite link is missing its token.');
    try {
      const data = await api('/api/team/join', { method: 'POST', body: JSON.stringify({ token }) });
      if (data.needsAccount) {
        renderSignupForm(data.email, data.teacherName);
      } else {
        renderWelcome(data.teacherName, true);
        setTimeout(() => { window.location.href = '/library'; }, 1200);
      }
    } catch (error) {
      renderError(error.message || 'This invite link is not valid.');
    }
  }

  init();
})();
