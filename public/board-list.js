(() => {
  const { state, $, escapeHtml, setStatus, api, initCommon, setButtonLoading } = window.AppCommon;

  function fmtTime(iso) { return new Date(iso).toLocaleString(); }

  async function loadTeacherBoards() {
    try {
      const data = await api('/api/board/mine/list');
      if (!data.boards.length) {
        $('#teacherBoardList').innerHTML = '<p class="set-meta">No boards yet — create one to get started.</p>';
        return;
      }
      $('#teacherBoardList').innerHTML = data.boards.map((b) => `
        <div class="set-item" data-id="${b.id}">
          <span class="set-title">${escapeHtml(b.title)} ${b.isLive ? '<span style="color:#14d9c4; font-size:0.75rem; font-weight:700;">● LIVE</span>' : ''}</span>
          <span class="set-meta">${b.pageCount || 1} page(s) • ${b.strokeCount} strokes • ${b.shared ? 'Shared with team' : 'Private'} • updated ${fmtTime(b.updatedAt)}</span>
          <div class="set-actions">
            <a class="btn primary" href="/board/${b.id}">Open</a>
            <button class="btn soft live-toggle" data-id="${b.id}" data-live="${b.isLive}">${b.isLive ? 'Stop live' : 'Go live'}</button>
            <button class="btn soft share-toggle" data-id="${b.id}" data-shared="${b.shared}">${b.shared ? 'Unshare' : 'Share with team'}</button>
            <button class="btn ghost delete-board" data-id="${b.id}">Delete</button>
          </div>
        </div>
      `).join('');

      $('#teacherBoardList').querySelectorAll('.live-toggle').forEach((btn) => btn.addEventListener('click', () => toggleLive(btn.dataset.id, btn.dataset.live === 'true')));
      $('#teacherBoardList').querySelectorAll('.share-toggle').forEach((btn) => btn.addEventListener('click', () => toggleShare(btn.dataset.id, btn.dataset.shared === 'true')));
      $('#teacherBoardList').querySelectorAll('.delete-board').forEach((btn) => btn.addEventListener('click', () => deleteBoard(btn.dataset.id)));
    } catch (error) {
      setStatus(error.message, 'error');
    }
  }

  async function toggleLive(boardId, currentlyLive) {
    try {
      await api(`/api/board/${boardId}/${currentlyLive ? 'stop-live' : 'go-live'}`, { method: 'POST', body: JSON.stringify({}) });
      await loadTeacherBoards();
      setStatus(currentlyLive ? 'Board taken off live.' : 'Board is now live. Only one board can be live at a time, so any other live board was stopped.', 'success');
    } catch (error) {
      setStatus(error.message, 'error');
    }
  }

  async function toggleShare(boardId, currentlyShared) {
    try {
      await api(`/api/board/${boardId}/share-toggle`, { method: 'POST', body: JSON.stringify({ shared: !currentlyShared }) });
      await loadTeacherBoards();
      setStatus(currentlyShared ? 'No longer shared with your team.' : 'Shared with your team — visible to anyone on your roster while live.', 'success');
    } catch (error) {
      setStatus(error.message, 'error');
    }
  }

  async function deleteBoard(boardId) {
    if (!confirm('Delete this board? This cannot be undone.')) return;
    try {
      await api(`/api/board/${boardId}`, { method: 'DELETE' });
      await loadTeacherBoards();
      setStatus('Board deleted.', 'success');
    } catch (error) {
      setStatus(error.message, 'error');
    }
  }

  // ---- Template picker + New board ------------------------------------
  function buildTemplatePicker() {
    const groups = {};
    (window.BOARD_TEMPLATES || []).forEach((t) => { (groups[t.subject] ||= []).push(t); });
    const order = ['Math', 'Science', 'Geography', 'History', 'Freeform'];
    const html = order.filter((s) => groups[s]).map((subject) => `
      <div class="template-group">
        <h4>${escapeHtml(subject)}</h4>
        <div class="template-grid">
          ${groups[subject].map((t) => `
            <button class="template-tile${t.id === 'blank' ? ' blank' : ''}" data-id="${t.id}">
              <strong>${escapeHtml(t.name)}</strong>
              <span>${escapeHtml(t.blurb)}</span>
              ${t.standard ? `<em>${escapeHtml(t.standard)}</em>` : ''}
            </button>`).join('')}
        </div>
      </div>`).join('');
    $('#templateGroups').innerHTML = html;

    let selected = 'blank';
    const tiles = $('#templateGroups').querySelectorAll('.template-tile');
    const markSelected = (id) => {
      selected = id;
      tiles.forEach((el) => el.classList.toggle('selected', el.dataset.id === id));
    };
    markSelected('blank');
    tiles.forEach((el) => el.addEventListener('click', () => markSelected(el.dataset.id)));

    return () => selected;
  }

  let getSelectedTemplate = null;

  function openNewBoard() {
    if (!getSelectedTemplate) getSelectedTemplate = buildTemplatePicker();
    $('#newBoardName').value = '';
    const dlg = $('#templateDialog');
    dlg.showModal();
    setTimeout(() => $('#newBoardName').focus(), 50);
  }

  async function createBoard() {
    const title = $('#newBoardName').value.trim();
    const template = getSelectedTemplate ? getSelectedTemplate() : 'blank';
    $('#createBoardBtn').disabled = true;
    try {
      const data = await api('/api/board/mine/new', {
        method: 'POST',
        body: JSON.stringify({ title, template })
      });
      window.location.href = `/board/${data.board.id}`;
    } catch (error) {
      setStatus(error.message, 'error');
      $('#createBoardBtn').disabled = false;
    }
  }

  // ---- Shared-with-you boards -----------------------------------------
  async function loadSharedBoards() {
    try {
      const data = await api('/api/board/shared/mine');
      if (!data.boards.length) {
        $('#sharedBoardList').innerHTML = '<p class="set-meta">No boards shared with you yet.</p>';
        return;
      }
      $('#sharedBoardList').innerHTML = data.boards.map((b) => `
        <div class="set-item" data-id="${b.boardId}">
          <span class="set-title">${escapeHtml(b.title)} ${b.isLive ? '<span style="color:#14d9c4; font-size:0.75rem; font-weight:700;">● LIVE</span>' : ''}</span>
          <span class="set-meta">${escapeHtml(b.teacherName)}'s whiteboard • ${b.isLive ? 'live now' : 'snapshot'}</span>
          <div class="set-actions">
            <a class="btn primary" href="/board/${b.boardId}">${b.isLive ? 'Join' : 'View snapshot'}</a>
          </div>
        </div>
      `).join('');
    } catch (error) {
      setStatus(error.message, 'error');
    }
  }

  function switchScope(scope) {
    $('#boardsToggle').querySelectorAll('.seg-btn').forEach((b) =>
      b.classList.toggle('active', b.dataset.scope === scope));
    const mine = scope === 'mine';
    $('#teacherBoardList').style.display = mine ? '' : 'none';
    $('#sharedBoardList').style.display = mine ? 'none' : '';
    $('#boardsHint').style.display = mine ? '' : 'none';
    if (mine) loadTeacherBoards(); else loadSharedBoards();
  }

  async function loadLiveBoards() {
    try {
      const data = await api('/api/board/live/mine');
      if (!data.live.length) {
        $('#liveBoardList').innerHTML = '<p class="set-meta">No live boards right now. If you\'re expecting one, check that a teacher has invited you and started a live session.</p>';
        return;
      }
      $('#liveBoardList').innerHTML = data.live.map((entry) => `
        <div class="set-item" data-id="${entry.boardId}">
          <span class="set-title">${escapeHtml(entry.title)} <span style="color:#14d9c4; font-size:0.75rem; font-weight:700;">● LIVE</span></span>
          <span class="set-meta">${escapeHtml(entry.teacherName)}'s whiteboard</span>
          <div class="set-actions">
            <a class="btn primary" href="/board/${entry.boardId}">Join</a>
          </div>
        </div>
      `).join('');
    } catch (error) {
      setStatus(error.message, 'error');
    }
  }

  async function init() {
    await initCommon();
    if (!state.user) { window.location.href = '/?login=1'; return; }

    const canCreate = Boolean(state.user.limits && state.user.limits.whiteboard);

    // Everyone now uses the unified boards view with a Yours / Shared toggle.
    // The old viewer-only and upgrade-only views are retired.
    $('#teacherView').style.display = 'block';
    $('#viewerView').style.display = 'none';
    $('#upgradeView').style.display = 'none';

    // New Board (and its modal) only for users who can create boards.
    const newBtn = $('#newBoardBtn');
    if (canCreate) {
      newBtn.style.display = '';
      newBtn.addEventListener('click', openNewBoard);
      $('#createBoardBtn').addEventListener('click', createBoard);
      $('#templateClose').addEventListener('click', () => $('#templateDialog').close());
      $('#newBoardName').addEventListener('keydown', (e) => { if (e.key === 'Enter') createBoard(); });
    } else {
      newBtn.style.display = 'none';
      // A free/Pro student can't create boards, so their "Yours" is always
      // empty. Hide the Yours tab and show only what's shared with them.
      const yoursTab = $('#boardsToggle').querySelector('[data-scope="mine"]');
      if (yoursTab) yoursTab.style.display = 'none';
    }

    $('#boardsToggle').querySelectorAll('.seg-btn').forEach((b) =>
      b.addEventListener('click', () => switchScope(b.dataset.scope)));

    // Default scope: Yours if they can create boards (paid Teams/founder/admin),
    // otherwise Shared-with-you (students land on what their teacher shared).
    switchScope(canCreate ? 'mine' : 'shared');
  }

  init().catch((error) => setStatus(error.message, 'error'));
})();
