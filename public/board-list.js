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
          <span class="set-meta">${b.strokeCount} strokes • ${b.shared ? 'Shared with team' : 'Private'} • updated ${fmtTime(b.updatedAt)}</span>
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

  async function createBoard() {
    const title = prompt('Name this board (e.g. "Algebra II — Period 3"):', '');
    if (title === null) return;
    try {
      const data = await api('/api/board/mine/new', { method: 'POST', body: JSON.stringify({ title }) });
      window.location.href = `/board/${data.board.id}`;
    } catch (error) {
      setStatus(error.message, 'error');
    }
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
    const hasTeam = Boolean(state.user && state.user.limits && state.user.limits.whiteboard);
    $('#teacherView').style.display = hasTeam ? 'block' : 'none';
    $('#viewerView').style.display = hasTeam ? 'none' : 'block';

    if (hasTeam) {
      $('#newBoardBtn').addEventListener('click', createBoard);
      await loadTeacherBoards();
    } else {
      $('#refreshLive').addEventListener('click', loadLiveBoards);
      await loadLiveBoards();
    }
  }

  init().catch((error) => setStatus(error.message, 'error'));
})();
