/* Your Library page: lists sets you created and sets shared with you. */
(() => {
  const { state, $, escapeHtml, setStatus, api, initCommon } = window.AppCommon;

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
          ${owned ? `<button class="btn soft share-toggle-mini" data-id="${set.id}" data-shared="${Boolean(set.shared)}">${set.shared ? 'Shared ✓' : 'Share'}</button><button class="btn ghost delete-mini" data-id="${set.id}">Delete</button>` : ''}
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
    node.querySelectorAll('.share-toggle-mini').forEach((button) => button.addEventListener('click', () => toggleShare(button.dataset.id, button.dataset.shared === 'true')));
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

  // Sharing is a single on/off toggle now — once on, it's visible to
  // everyone on your team roster (see /team), no per-item email list to
  // manage. If the account isn't on the Teams plan, the server rejects
  // this with a clear message pointing at the Teams trial.
  async function toggleShare(setId, currentlyShared) {
    try {
      await api(`/api/sets/${setId}/share-toggle`, { method: 'POST', body: JSON.stringify({ shared: !currentlyShared }) });
      await loadLibrary();
      setStatus(currentlyShared ? 'No longer shared.' : 'Shared with your team.', 'success');
    } catch (error) {
      setStatus(error.message, 'error');
    }
  }

  async function init() {
    $('#refreshLibrary').addEventListener('click', loadLibrary);
    await initCommon();
    await loadLibrary();
    const params = new URLSearchParams(window.location.search);
    if (params.get('whiteboard') === 'upgrade') {
      setStatus('The whiteboard is a Teams plan feature — start a free 7-day trial from Pricing to try it.', '');
    }
  }

  init().catch((error) => setStatus(error.message, 'error'));
})();
