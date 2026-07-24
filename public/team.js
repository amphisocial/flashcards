(() => {
  const { state, $, escapeHtml, setStatus, api, initCommon, setButtonLoading } = window.AppCommon;

  function statusBadge(status) {
    return status === 'active'
      ? '<span style="color:#14d9c4; font-weight:700; font-size:0.8rem;">Active</span>'
      : '<span style="color:var(--muted); font-size:0.8rem;">Invited — link not opened yet</span>';
  }

  async function loadRoster() {
    try {
      const data = await api('/api/team/roster');
      $('#rosterPill').textContent = `${data.used} of ${data.seatLimit} seats used`;
      if (!data.roster.length) {
        $('#rosterList').innerHTML = '<p class="set-meta">No one on your roster yet — invite someone above.</p>';
        return;
      }
      $('#rosterList').innerHTML = data.roster.map((entry) => `
        <div class="set-item" data-email="${escapeHtml(entry.email)}">
          <span class="set-title">${escapeHtml(entry.email)}</span>
          <span class="set-meta">Invited ${new Date(entry.invitedAt).toLocaleDateString()} • ${statusBadge(entry.status)}</span>
          <div class="set-actions">
            <button class="btn ghost remove-roster" data-email="${escapeHtml(entry.email)}">Remove</button>
          </div>
        </div>
      `).join('');
      $('#rosterList').querySelectorAll('.remove-roster').forEach((button) => {
        button.addEventListener('click', () => removeFromRoster(button.dataset.email));
      });
    } catch (error) {
      setStatus(error.message, 'error');
    }
  }

  async function removeFromRoster(email) {
    if (!confirm(`Remove ${email} from your team? They'll lose access to anything you've shared.`)) return;
    try {
      await api(`/api/team/roster/${encodeURIComponent(email)}`, { method: 'DELETE' });
      await loadRoster();
      setStatus('Removed from your roster.', 'success');
    } catch (error) {
      setStatus(error.message, 'error');
    }
  }

  async function sendInvites(event) {
    event.preventDefault();
    const raw = $('#inviteEmails').value.trim();
    if (!raw) return setStatus('Enter at least one email address.', 'error');
    const button = $('#inviteSubmit');
    setButtonLoading(button, true, 'Sending…');
    try {
      const data = await api('/api/team/invite', { method: 'POST', body: JSON.stringify({ emails: raw }) });
      const failed = data.results.filter((r) => !r.added);
      const noEmail = data.results.filter((r) => r.added && !r.emailSent);
      $('#inviteEmails').value = '';
      await loadRoster();
      if (failed.length) setStatus(`${failed.length} email(s) couldn't be added: ${failed.map((f) => f.reason).join(', ')}`, 'error');
      else if (noEmail.length) setStatus(`Added to roster, but email delivery isn't configured — copy the join link from your .env setup or ask an admin to configure SMTP.`, '');
      else setStatus('Invites sent.', 'success');
    } catch (error) {
      setStatus(error.message, 'error');
    } finally {
      setButtonLoading(button, false, 'Send invites');
    }
  }

  async function init() {
    $('#inviteForm').addEventListener('submit', sendInvites);
    await initCommon();
    const hasTeam = Boolean(state.user && state.user.limits && state.user.limits.whiteboard);
    $('#teamGate').style.display = hasTeam ? 'none' : 'block';
    $('#teamBody').style.display = hasTeam ? 'block' : 'none';
    if (hasTeam) await loadRoster();
    else $('#rosterPill').textContent = 'Teams plan required';
  }

  init().catch((error) => setStatus(error.message, 'error'));
})();
