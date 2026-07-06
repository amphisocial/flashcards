const state = {
  user: null,
  usage: null,
  activeTab: 'paste',
  currentSet: null,
  currentIndex: 0,
  flipped: false,
  authMode: 'signup',
  chatAnswers: [],
  shareSetId: null
};

const coachPrompts = [
  'What are you preparing for? Example: CIO interview, SAT history, Grade 8 science, GMAT quant.',
  'What grade, level, or audience should I tune this for?',
  'What subject or topic should the cards focus on?',
  'Tell me the source material, notes, concepts, or syllabus you want covered.',
  'Any special style? Example: multiple choice, executive language, simple explanations, hard exam questions.'
];

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));

function setStatus(message, type = '') {
  const node = $('#statusText');
  node.textContent = message || '';
  node.className = `status ${type}`.trim();
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: options.body instanceof FormData ? undefined : { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    ...options
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed: ${response.status}`);
  return data;
}

function requireSignedIn() {
  if (state.user) return true;
  openAuth('signup');
  setStatus('Please sign in to create and store Quizlets.', 'error');
  return false;
}

function updateAuthUI() {
  const area = $('#authArea');
  if (!state.user) {
    area.innerHTML = `
      <button class="btn ghost" id="openLogin">Log in</button>
      <button class="btn primary" id="openSignup">Sign up free</button>
    `;
    $('#openLogin').addEventListener('click', () => openAuth('login'));
    $('#openSignup').addEventListener('click', () => openAuth('signup'));
    $('#usagePill').textContent = 'Sign in to track usage';
    return;
  }
  area.innerHTML = `
    <span class="user-chip">${escapeHtml(state.user.firstName || state.user.email)} • ${state.user.planLabel}</span>
    <button class="btn ghost" id="logoutBtn">Log out</button>
  `;
  $('#logoutBtn').addEventListener('click', logout);
  updateUsagePill();
}

function updateUsagePill() {
  if (!state.user || !state.usage) return;
  $('#usagePill').textContent = `${state.usage.remaining} of ${state.usage.limit} sets left today`;
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function openAuth(mode) {
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
  $('#authDialog').showModal();
}

async function submitAuth(event) {
  event.preventDefault();
  const payload = {
    email: $('#authEmail').value,
    password: $('#authPassword').value,
    firstName: $('#firstName').value,
    lastName: $('#lastName').value
  };
  try {
    const data = await api(state.authMode === 'signup' ? '/api/auth/register' : '/api/auth/login', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
    state.user = data.user;
    $('#authDialog').close();
    await refreshMe();
    await loadLibrary();
    setStatus(`Welcome${state.user.firstName ? `, ${state.user.firstName}` : ''}.`, 'success');
  } catch (error) {
    setStatus(error.message, 'error');
  }
}

async function logout() {
  await api('/api/auth/logout', { method: 'POST', body: JSON.stringify({}) });
  state.user = null;
  state.usage = null;
  updateAuthUI();
  $('#mySets').innerHTML = emptyText('Sign in to see your stored sets.');
  $('#sharedSets').innerHTML = emptyText('Shared sets will appear here.');
}

async function refreshMe() {
  const data = await api('/api/me');
  state.user = data.user;
  state.usage = data.usage;
  updateAuthUI();
}

function switchTab(tab) {
  state.activeTab = tab;
  $$('.tab').forEach((button) => button.classList.toggle('active', button.dataset.tab === tab));
  $$('.tab-panel').forEach((panel) => panel.classList.remove('active'));
  $(`#tab-${tab}`).classList.add('active');
}

async function extractDocument() {
  if (!requireSignedIn()) return;
  const file = $('#docUpload').files[0];
  if (!file) return setStatus('Choose a file first.', 'error');
  const form = new FormData();
  form.append('document', file);
  setStatus('Extracting document text...');
  try {
    const data = await api('/api/extract', { method: 'POST', body: form });
    $('#uploadContent').value = data.text;
    $('#uploadContent').readOnly = false;
    setStatus(`Extracted ${data.characters.toLocaleString()} characters from ${data.filename}.`, 'success');
  } catch (error) {
    setStatus(error.message, 'error');
  }
}

function getSourceContent() {
  if (state.activeTab === 'paste') return $('#pasteContent').value;
  if (state.activeTab === 'upload') return $('#uploadContent').value;
  return buildChatContent();
}

function buildChatContent() {
  return state.chatAnswers
    .map((answer, index) => `${coachPrompts[index]}\n${answer}`)
    .join('\n\n');
}

async function generateSet() {
  if (!requireSignedIn()) return;
  const content = getSourceContent();
  if (!content || content.trim().length < 20) return setStatus('Add more content before generating cards.', 'error');
  const payload = {
    content,
    provider: $('#provider').value,
    cardCount: Number($('#cardCount').value || 10),
    format: $('#format').value,
    category: $('#category').value,
    grade: $('#grade').value,
    subject: $('#subject').value,
    notes: $('#notes').value,
    sourceType: state.activeTab
  };
  setStatus('Generating your AI Quizlet...');
  $('#generateBtn').disabled = true;
  try {
    const data = await api('/api/generate', { method: 'POST', body: JSON.stringify(payload) });
    state.currentSet = data.quizlet;
    state.currentIndex = 0;
    state.flipped = false;
    state.usage = data.usage;
    renderCurrentSet();
    updateUsagePill();
    await loadLibrary();
    setStatus('Study set created and stored in your library.', 'success');
  } catch (error) {
    setStatus(error.message, 'error');
  } finally {
    $('#generateBtn').disabled = false;
  }
}

function renderCurrentSet() {
  const set = state.currentSet;
  const card = set?.cards?.[state.currentIndex];
  $('#flashcard').classList.toggle('flipped', state.flipped);
  if (!set || !card) {
    $('#setTitle').textContent = 'No set selected';
    $('#cardCounter').textContent = '0 / 0';
    $('#cardFront').textContent = 'Create or select a study set to begin.';
    $('#cardBack').textContent = 'The answer will appear here.';
    $('#cardExplanation').textContent = '';
    $('#choices').innerHTML = '';
    $('#cardList').innerHTML = '';
    return;
  }
  $('#setTitle').textContent = set.title;
  $('#cardCounter').textContent = `${state.currentIndex + 1} / ${set.cards.length}`;
  $('#cardFront').textContent = card.front;
  $('#cardBack').textContent = card.back;
  $('#cardExplanation').textContent = card.explanation || '';
  $('#choices').innerHTML = (card.choices || []).map((choice, index) => `<div class="choice">${String.fromCharCode(65 + index)}. ${escapeHtml(choice)}</div>`).join('');
  $('#cardList').innerHTML = set.cards.map((item, index) => `
    <button class="card-row ${index === state.currentIndex ? 'active' : ''}" data-index="${index}">
      ${index + 1}. ${escapeHtml(item.front)}
    </button>
  `).join('');
  $$('.card-row').forEach((row) => row.addEventListener('click', () => {
    state.currentIndex = Number(row.dataset.index);
    state.flipped = false;
    renderCurrentSet();
  }));
}

function moveCard(delta) {
  const cards = state.currentSet?.cards || [];
  if (!cards.length) return;
  state.currentIndex = (state.currentIndex + delta + cards.length) % cards.length;
  state.flipped = false;
  renderCurrentSet();
}

function shuffleCards() {
  if (!state.currentSet?.cards?.length) return;
  state.currentSet.cards = state.currentSet.cards
    .map((card) => ({ card, sort: Math.random() }))
    .sort((a, b) => a.sort - b.sort)
    .map(({ card }) => card);
  state.currentIndex = 0;
  state.flipped = false;
  renderCurrentSet();
}

function emptyText(text) {
  return `<p class="set-meta">${escapeHtml(text)}</p>`;
}

async function loadLibrary() {
  if (!state.user) return;
  try {
    const data = await api('/api/quizlets');
    renderSetList('#mySets', data.my || [], true);
    renderSetList('#sharedSets', data.shared || [], false);
  } catch (error) {
    setStatus(error.message, 'error');
  }
}

function renderSetList(target, sets, owned) {
  const node = $(target);
  if (!sets.length) {
    node.innerHTML = emptyText(owned ? 'No sets created yet.' : 'No shared sets yet.');
    return;
  }
  node.innerHTML = sets.map((set) => `
    <div class="set-item" data-id="${set.id}">
      <span class="set-title">${escapeHtml(set.title)}</span>
      <span class="set-meta">${set.cards.length} cards • ${escapeHtml(set.subject || set.category || 'General')} • ${new Date(set.createdAt).toLocaleDateString()}</span>
      ${owned ? `<div class="set-actions"><button class="btn soft share-mini" data-id="${set.id}">Share</button><button class="btn ghost delete-mini" data-id="${set.id}">Delete</button></div>` : ''}
    </div>
  `).join('');
  node.querySelectorAll('.set-item').forEach((item) => {
    item.addEventListener('click', async (event) => {
      if (event.target.closest('button')) return;
      await openSet(item.dataset.id);
    });
  });
  node.querySelectorAll('.share-mini').forEach((button) => button.addEventListener('click', () => openShare(button.dataset.id)));
  node.querySelectorAll('.delete-mini').forEach((button) => button.addEventListener('click', () => deleteSet(button.dataset.id)));
}

async function openSet(setId) {
  const data = await api(`/api/quizlets/${setId}`);
  state.currentSet = data.quizlet;
  state.currentIndex = 0;
  state.flipped = false;
  renderCurrentSet();
  document.querySelector('#create').scrollIntoView({ behavior: 'smooth' });
}

async function deleteSet(setId) {
  if (!confirm('Delete this study set?')) return;
  await api(`/api/quizlets/${setId}`, { method: 'DELETE' });
  if (state.currentSet?.id === setId) {
    state.currentSet = null;
    renderCurrentSet();
  }
  await loadLibrary();
}

function openShare(setId) {
  state.shareSetId = setId;
  $('#shareEmails').value = '';
  $('#shareDialog').showModal();
}

async function shareSet(event) {
  event.preventDefault();
  if (!state.shareSetId) return;
  try {
    await api(`/api/quizlets/${state.shareSetId}/share`, {
      method: 'POST',
      body: JSON.stringify({ emails: $('#shareEmails').value })
    });
    $('#shareDialog').close();
    await loadLibrary();
    setStatus('Study set shared.', 'success');
  } catch (error) {
    setStatus(error.message, 'error');
  }
}

function resetChat() {
  state.chatAnswers = [];
  $('#chatBox').innerHTML = '';
  addBotMessage(coachPrompts[0]);
}

function addBotMessage(text) {
  const div = document.createElement('div');
  div.className = 'message bot';
  div.textContent = text;
  $('#chatBox').appendChild(div);
  $('#chatBox').scrollTop = $('#chatBox').scrollHeight;
}

function addUserMessage(text) {
  const div = document.createElement('div');
  div.className = 'message user';
  div.textContent = text;
  $('#chatBox').appendChild(div);
  $('#chatBox').scrollTop = $('#chatBox').scrollHeight;
}

function sendChat() {
  const input = $('#chatInput');
  const answer = input.value.trim();
  if (!answer) return;
  addUserMessage(answer);
  state.chatAnswers.push(answer);
  input.value = '';
  if (state.chatAnswers.length < coachPrompts.length) {
    addBotMessage(coachPrompts[state.chatAnswers.length]);
  } else {
    addBotMessage('Great. I have enough context. Choose card count and click “Generate AI Quizlet.”');
    $('#category').value = inferCategory(state.chatAnswers[0]);
    $('#grade').value ||= state.chatAnswers[1];
    $('#subject').value ||= state.chatAnswers[2];
  }
}

function inferCategory(text) {
  const lower = String(text || '').toLowerCase();
  if (lower.includes('sat')) return 'SAT prep';
  if (lower.includes('gmat')) return 'GMAT prep';
  if (lower.includes('interview')) return 'Interview preparation';
  if (lower.includes('grade')) return 'Grade-level study';
  return 'General learning';
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

function bindEvents() {
  $('#openLogin')?.addEventListener('click', () => openAuth('login'));
  $('#openSignup')?.addEventListener('click', () => openAuth('signup'));
  $('#authSubmit').addEventListener('click', submitAuth);
  $('#shareSubmit').addEventListener('click', shareSet);
  $$('.tab').forEach((button) => button.addEventListener('click', () => switchTab(button.dataset.tab)));
  $('#extractBtn').addEventListener('click', extractDocument);
  $('#generateBtn').addEventListener('click', generateSet);
  $('#flashcard').addEventListener('click', () => { state.flipped = !state.flipped; renderCurrentSet(); });
  $('#flipCard').addEventListener('click', () => { state.flipped = !state.flipped; renderCurrentSet(); });
  $('#prevCard').addEventListener('click', () => moveCard(-1));
  $('#nextCard').addEventListener('click', () => moveCard(1));
  $('#shuffleCards').addEventListener('click', shuffleCards);
  $('#refreshLibrary').addEventListener('click', loadLibrary);
  $('#chatSend').addEventListener('click', sendChat);
  $('#chatInput').addEventListener('keydown', (event) => { if (event.key === 'Enter') sendChat(); });
  $('#resetChat').addEventListener('click', resetChat);
  $$('.checkout').forEach((button) => button.addEventListener('click', () => checkout(button.dataset.plan)));
  document.addEventListener('keydown', (event) => {
    if (!state.currentSet?.cards?.length) return;
    if (event.key === 'ArrowLeft') moveCard(-1);
    if (event.key === 'ArrowRight') moveCard(1);
    if (event.key === ' ') { state.flipped = !state.flipped; renderCurrentSet(); }
  });
}

async function init() {
  bindEvents();
  resetChat();
  renderCurrentSet();
  await refreshMe();
  if (state.user) await loadLibrary();
  if (new URLSearchParams(window.location.search).get('billing') === 'success') {
    setStatus('Billing updated. Your plan will refresh after Stripe confirms the subscription.', 'success');
  }
}

init().catch((error) => setStatus(error.message, 'error'));
