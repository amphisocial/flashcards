/* App page: build a study set + study it (flashcards, graded quiz, slides). */
(() => {
  const { state, $, $$, escapeHtml, setStatus, api, updateUsagePill, initCommon } = window.AppCommon;

  const study = { set: null, index: 0, flipped: false, answers: {} };
  const creator = { activeTab: 'paste', chatAnswers: [] };

  const coachPrompts = [
    'What are you preparing for? Example: CIO interview, SAT history, Grade 8 science, GMAT quant.',
    'What grade, level, or audience should I tune this for?',
    'What subject or topic should the cards focus on?',
    'Tell me the source material, notes, concepts, or syllabus you want covered.',
    'Any special style? Example: multiple choice, executive language, simple explanations, hard exam questions.'
  ];

  const normalize = (value) => String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');

  /* ---------- Creator ---------- */

  function switchTab(tab) {
    creator.activeTab = tab;
    $$('.tab').forEach((button) => button.classList.toggle('active', button.dataset.tab === tab));
    $$('.tab-panel').forEach((panel) => panel.classList.remove('active'));
    $(`#tab-${tab}`).classList.add('active');
  }

  async function extractDocument() {
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

  function buildChatContent() {
    return creator.chatAnswers
      .map((answer, index) => `${coachPrompts[index]}\n${answer}`)
      .join('\n\n');
  }

  function getSourceContent() {
    if (creator.activeTab === 'paste') return $('#pasteContent').value;
    if (creator.activeTab === 'upload') return $('#uploadContent').value;
    return buildChatContent();
  }

  async function generateSet() {
    const content = getSourceContent();
    if (!content || content.trim().length < 20) return setStatus('Add more content before generating.', 'error');
    const payload = {
      content,
      cardCount: Number($('#cardCount').value || 10),
      format: $('#format').value,
      category: $('#category').value,
      grade: $('#grade').value,
      subject: $('#subject').value,
      notes: $('#notes').value,
      sourceType: creator.activeTab
    };
    setStatus('Generating your study set...');
    $('#generateBtn').disabled = true;
    try {
      const data = await api('/api/generate', { method: 'POST', body: JSON.stringify(payload) });
      state.usage = data.usage;
      updateUsagePill();
      loadSetIntoStudy(data.set || data.quizlet);
      setStatus('Study set created and saved to Your Library.', 'success');
      const creatorPanel = $('#creatorPanel');
      if (creatorPanel.classList.contains('maximized')) toggleMaximize(creatorPanel, false);
      $('#studyPanel').scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (error) {
      setStatus(error.message, 'error');
    } finally {
      $('#generateBtn').disabled = false;
    }
  }

  /* ---------- Study ---------- */

  function loadSetIntoStudy(set) {
    study.set = set;
    study.index = 0;
    study.flipped = false;
    study.answers = {};
    renderStudy();
  }

  const currentCard = () => study.set?.cards?.[study.index];
  const isQuiz = (card) => card?.type === 'quiz' && (card.choices || []).length >= 2;
  const isSlide = (card) => card?.type === 'slide';

  function answerIndexOf(card) {
    if (Number.isInteger(card.answerIndex) && card.answerIndex >= 0) return card.answerIndex;
    return (card.choices || []).findIndex((choice) => normalize(choice) === normalize(card.back));
  }

  function renderEmptyStudy() {
    $('#setTitle').textContent = 'No set selected';
    $('#cardCounter').textContent = '0 / 0';
    $('#flashcard').style.display = '';
    $('#slideView').style.display = 'none';
    $('#flipCard').style.display = '';
    $('#shuffleCards').style.display = '';
    $('#flashcard').classList.remove('flipped');
    $('#frontLabel').textContent = 'Question';
    $('#cardFront').textContent = 'Create or select a study set to begin. Pick a set from Your Library, or generate a new one.';
    $('#cardBack').textContent = 'The answer will appear here.';
    $('#cardExplanation').textContent = '';
    $('#verdict').innerHTML = '';
    $('#choices').innerHTML = '';
    $('#cardList').innerHTML = '';
  }

  function renderStudy() {
    const set = study.set;
    const card = currentCard();
    if (!set || !card) return renderEmptyStudy();

    $('#setTitle').textContent = set.title;
    $('#cardCounter').textContent = `${study.index + 1} / ${set.cards.length}`;

    if (isSlide(card)) {
      renderSlide(card);
    } else {
      renderCard(card);
    }
    renderCardList(set);
  }

  const SLIDE_ICONS = {
    title: '✦', agenda: '🗂', content: '💡', stat: '📊', quote: '❝', section: '▤', closing: '🎯'
  };

  function renderSlide(card) {
    $('#flashcard').style.display = 'none';
    $('#slideView').style.display = 'flex';
    $('#flipCard').style.display = 'none';
    $('#shuffleCards').style.display = 'none';

    const layout = card.layout || 'content';
    const stage = $('#slideStage');
    stage.className = `slide-stage layout-${layout} accent-${study.index % 5}`;

    const kicker = $('#slideKicker');
    kicker.textContent = card.kicker || '';
    kicker.style.display = card.kicker ? '' : 'none';

    $('#slideTitle').textContent = card.front;

    const bullets = String(card.back || '')
      .split(/\n+/)
      .map((line) => line.replace(/^[-•*]\s*/, '').trim())
      .filter(Boolean);
    const bulletsEl = $('#slideBullets');
    const showBullets = bullets.length && layout !== 'stat' && layout !== 'quote';
    bulletsEl.style.display = showBullets ? '' : 'none';
    bulletsEl.innerHTML = showBullets ? bullets.map((bullet) => `<li>${escapeHtml(bullet)}</li>`).join('') : '';

    const statBox = $('#slideStat');
    if (layout === 'stat' && card.stat?.value) {
      statBox.style.display = '';
      $('#statValue').textContent = card.stat.value;
      $('#statLabel').textContent = card.stat.label || '';
    } else {
      statBox.style.display = 'none';
    }

    const quoteBox = $('#slideQuote');
    if (layout === 'quote' && card.quote?.text) {
      quoteBox.style.display = '';
      $('#quoteText').textContent = card.quote.text;
      $('#quoteAttribution').textContent = card.quote.attribution || '';
    } else {
      quoteBox.style.display = 'none';
    }

    const media = $('#slideMedia');
    const usesMedia = layout !== 'quote';
    if (usesMedia && card.imageUrl) {
      media.style.display = '';
      media.style.backgroundImage = `url("${card.imageUrl}")`;
      $('#mediaIcon').style.display = 'none';
    } else if (usesMedia) {
      media.style.display = '';
      media.style.backgroundImage = '';
      $('#mediaIcon').style.display = '';
      $('#mediaIcon').textContent = SLIDE_ICONS[layout] || '💡';
    } else {
      media.style.display = 'none';
    }

    $('#slideNotes').textContent = card.explanation || '';
    const credit = $('#slideCredit');
    credit.textContent = card.imageCredit || '';
    credit.style.display = card.imageCredit ? '' : 'none';

    const total = study.set.cards.length;
    $('#slideProgressFill').style.width = `${((study.index + 1) / total) * 100}%`;
  }

  function renderCard(card) {
    $('#flashcard').style.display = '';
    $('#slideView').style.display = 'none';
    $('#flipCard').style.display = '';
    $('#shuffleCards').style.display = '';
    $('#flashcard').classList.toggle('flipped', study.flipped);
    $('#cardBack').textContent = card.back;
    $('#cardExplanation').textContent = card.explanation || '';
    $('#cardFront').textContent = card.front;

    if (!isQuiz(card)) {
      $('#frontLabel').textContent = 'Question';
      $('#choices').innerHTML = '';
      $('#verdict').innerHTML = '';
      return;
    }

    const selected = study.answers[card.id];
    const answerIndex = answerIndexOf(card);
    $('#frontLabel').textContent = selected == null ? 'Quiz — pick an answer, then flip' : 'Quiz — flip to check your answer';

    $('#choices').innerHTML = card.choices.map((choice, index) => {
      const classes = ['choice', 'selectable'];
      if (selected === index) classes.push('selected');
      if (study.flipped) {
        if (index === answerIndex) classes.push('correct');
        else if (selected === index) classes.push('incorrect');
      }
      return `<button type="button" class="${classes.join(' ')}" data-index="${index}">${String.fromCharCode(65 + index)}. ${escapeHtml(choice)}</button>`;
    }).join('');

    $$('#choices .choice').forEach((button) => {
      button.addEventListener('click', (event) => {
        event.stopPropagation();
        if (study.flipped) return;
        study.answers[card.id] = Number(button.dataset.index);
        renderStudy();
      });
    });

    if (study.flipped && selected != null) {
      const isCorrect = answerIndex >= 0
        ? selected === answerIndex
        : normalize(card.choices[selected]) === normalize(card.back);
      $('#verdict').innerHTML = isCorrect
        ? '<span class="verdict-pill correct">✓ Correct answer</span>'
        : '<span class="verdict-pill incorrect">✗ Incorrect answer</span>';
    } else if (study.flipped) {
      $('#verdict').innerHTML = '<span class="verdict-pill neutral">No answer selected</span>';
    } else {
      $('#verdict').innerHTML = '';
    }
  }

  function renderCardList(set) {
    $('#cardList').innerHTML = set.cards.map((item, index) => `
      <button class="card-row ${index === study.index ? 'active' : ''}" data-index="${index}">
        ${index + 1}. ${item.type === 'slide' ? '🖥 ' : item.type === 'quiz' ? '❓ ' : ''}${escapeHtml(item.front)}
      </button>
    `).join('');
    $$('.card-row').forEach((row) => row.addEventListener('click', () => {
      study.index = Number(row.dataset.index);
      study.flipped = false;
      renderStudy();
    }));
  }

  function flipCard() {
    const card = currentCard();
    if (!card || isSlide(card)) return;
    study.flipped = !study.flipped;
    renderStudy();
  }

  function moveCard(delta) {
    const cards = study.set?.cards || [];
    if (!cards.length) return;
    study.index = (study.index + delta + cards.length) % cards.length;
    study.flipped = false;
    renderStudy();
  }

  function shuffleCards() {
    if (!study.set?.cards?.length) return;
    study.set.cards = study.set.cards
      .map((card) => ({ card, sort: Math.random() }))
      .sort((a, b) => a.sort - b.sort)
      .map(({ card }) => card);
    study.index = 0;
    study.flipped = false;
    renderStudy();
  }

  async function openSet(setId) {
    try {
      const data = await api(`/api/sets/${setId}`);
      loadSetIntoStudy(data.set || data.quizlet);
    } catch (error) {
      setStatus(error.message, 'error');
    }
  }

  /* ---------- Maximize ---------- */

  function toggleMaximize(panel, force) {
    const willMax = force !== undefined ? force : !panel.classList.contains('maximized');
    $$('.panel.maximized').forEach((other) => {
      other.classList.remove('maximized');
      other.querySelector('.max-btn').textContent = '⤢';
      other.querySelector('.max-btn').title = 'Maximize this panel';
    });
    panel.classList.toggle('maximized', willMax);
    document.body.classList.toggle('no-scroll', willMax);
    const button = panel.querySelector('.max-btn');
    button.textContent = willMax ? '⤡' : '⤢';
    button.title = willMax ? 'Exit full screen (Esc)' : 'Maximize this panel';
  }

  /* ---------- Guided chat ---------- */

  function resetChat() {
    creator.chatAnswers = [];
    $('#chatBox').innerHTML = '';
    addMessage('bot', coachPrompts[0]);
  }

  function addMessage(kind, text) {
    const div = document.createElement('div');
    div.className = `message ${kind}`;
    div.textContent = text;
    $('#chatBox').appendChild(div);
    $('#chatBox').scrollTop = $('#chatBox').scrollHeight;
  }

  function sendChat() {
    const input = $('#chatInput');
    const answer = input.value.trim();
    if (!answer) return;
    addMessage('user', answer);
    creator.chatAnswers.push(answer);
    input.value = '';
    if (creator.chatAnswers.length < coachPrompts.length) {
      addMessage('bot', coachPrompts[creator.chatAnswers.length]);
    } else {
      addMessage('bot', 'Great. I have enough context. Choose your format and item count, then click "Generate."');
      $('#category').value = inferCategory(creator.chatAnswers[0]);
      $('#grade').value ||= creator.chatAnswers[1];
      $('#subject').value ||= creator.chatAnswers[2];
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

  /* ---------- Wiring ---------- */

  function bindEvents() {
    $$('.tab').forEach((button) => button.addEventListener('click', () => switchTab(button.dataset.tab)));
    $('#extractBtn').addEventListener('click', extractDocument);
    $('#generateBtn').addEventListener('click', generateSet);
    $('#flashcard').addEventListener('click', flipCard);
    $('#flipCard').addEventListener('click', flipCard);
    $('#prevCard').addEventListener('click', () => moveCard(-1));
    $('#nextCard').addEventListener('click', () => moveCard(1));
    $('#shuffleCards').addEventListener('click', shuffleCards);
    $('#chatSend').addEventListener('click', sendChat);
    $('#chatInput').addEventListener('keydown', (event) => { if (event.key === 'Enter') sendChat(); });
    $('#resetChat').addEventListener('click', resetChat);
    $$('.max-btn').forEach((button) => button.addEventListener('click', () => toggleMaximize(document.getElementById(button.dataset.target))));
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        const maximized = $('.panel.maximized');
        if (maximized) toggleMaximize(maximized, false);
        return;
      }
      const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName);
      if (typing || !study.set?.cards?.length) return;
      if (event.key === 'ArrowLeft') moveCard(-1);
      if (event.key === 'ArrowRight') moveCard(1);
      if (event.key === ' ') { event.preventDefault(); flipCard(); }
    });
  }

  async function init() {
    bindEvents();
    resetChat();
    renderEmptyStudy();
    await initCommon();
    const setId = new URLSearchParams(window.location.search).get('set');
    if (setId) await openSet(setId);
  }

  init().catch((error) => setStatus(error.message, 'error'));
})();
