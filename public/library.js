/* Your Library page: lists sets you created and sets shared with you. */
(() => {
  const { state, $, escapeHtml, setStatus, api, initCommon, setButtonLoading, clearDialogError } = window.AppCommon;

  let shareSetId = null;

  const emptyText = (text) => `<p class="set-meta">${escapeHtml(text)}</p>`;

  const formatLabel = (set) => {
    if (set.format === 'slides') return 'slides';
    if (set.format === 'quiz') return 'quiz';
    if (set.format === 'flashcard') return 'flashcards';
    return 'mixed';
  };

  async function loadLibrary() {
    try {
      const data = await api('/api/sets');
      renderSetList('#mySets', data.my || [], true);
      renderSetList('#sharedSets', data.shared || [], false);
    } catch (error) {
      setStatus(error.message, 'error');
    }
  }

  function renderSetList(target, sets, owned) {
    const node = $(target);
    if (!sets.length) {
      node.innerHTML = emptyText(owned ? 'No sets created yet. Head to Create to build your first one.' : 'No shared sets yet.');
      return;
    }
    node.innerHTML = sets.map((set) => `
      <div class="set-item" data-id="${set.id}">
        <span class="set-title">${escapeHtml(set.title)}</span>
        <span class="set-meta">${set.cards.length} ${set.format === 'slides' ? 'slides' : 'cards'} • ${formatLabel(set)} • ${escapeHtml(set.subject || set.category || 'General')} • ${new Date(set.createdAt).toLocaleDateString()}</span>
        <div class="set-actions">
          <button class="btn primary study-mini" data-id="${set.id}">Study</button>
          ${owned ? `<button class="btn soft share-mini" data-id="${set.id}">Share</button><button class="btn ghost delete-mini" data-id="${set.id}">Delete</button>` : ''}
        </div>
      </div>
    `).join('');
    node.querySelectorAll('.set-item').forEach((item) => {
      item.addEventListener('click', (event) => {
        if (event.target.closest('button')) return;
        window.location.href = `/app?set=${item.dataset.id}`;
      });
    });
    node.querySelectorAll('.study-mini').forEach((button) => button.addEventListener('click', () => {
      window.location.href = `/app?set=${button.dataset.id}`;
    }));
    node.querySelectorAll('.share-mini').forEach((button) => button.addEventListener('click', () => openShare(button.dataset.id)));
    node.querySelectorAll('.delete-mini').forEach((button) => button.addEventListener('click', () => deleteSet(button.dataset.id)));
  }

  async function deleteSet(setId) {
    if (!confirm('Delete this study set?')) return;
    try {
      await api(`/api/sets/${setId}`, { method: 'DELETE' });
      await loadLibrary();
      setStatus('Study set deleted.', 'success');
    } catch (error) {
      setStatus(error.message, 'error');
    }
  }

  function openShare(setId) {
    shareSetId = setId;
    const isTeam = state.user && state.user.plan === 'team';
    $('#shareEmails').value = '';
    $('#shareTeamGate').style.display = isTeam ? 'none' : 'block';
    $('#shareFormArea').style.display = isTeam ? 'block' : 'none';
    clearDialogError($('#shareDialog'));
    $('#shareDialog').showModal();
  }

  async function shareSet(event) {
    event.preventDefault();
    if (!shareSetId) return;
    clearDialogError($('#shareDialog'));
    if (!state.user || state.user.plan !== 'team') {
      $('#shareTeamGate').style.display = 'block';
      $('#shareFormArea').style.display = 'none';
      return;
    }
    const emails = $('#shareEmails').value.trim();
    if (!emails) return setStatus('Enter at least one email address.', 'error');
    const button = $('#shareSubmit');
    setButtonLoading(button, true, 'Sharing…');
    try {
      await api(`/api/sets/${shareSetId}/share`, {
        method: 'POST',
        body: JSON.stringify({ emails })
      });
      $('#shareDialog').close();
      await loadLibrary();
      setStatus('Study set shared.', 'success');
    } catch (error) {
      if (String(error.message || '').toLowerCase().includes('team')) {
        $('#shareTeamGate').style.display = 'block';
        $('#shareFormArea').style.display = 'none';
      }
      setStatus(error.message, 'error');
    } finally {
      setButtonLoading(button, false, 'Share');
    }
  }

  async function init() {
    $('#refreshLibrary').addEventListener('click', loadLibrary);
    $('#shareSubmit').addEventListener('click', shareSet);
    await initCommon();
    await loadLibrary();
  }

  init().catch((error) => setStatus(error.message, 'error'));
})();
