/*
 * Notes (v2.3): scan/upload -> OCR -> organized notes -> quiz -> tracking.
 * Grading: mc/tf/fib are graded automatically (normalized string compare);
 * short answers and flashcards are self-graded ("I got it" / "I missed it"),
 * since free text can be right in many phrasings. Every result is reported
 * to the server, which tracks weak topics and steers the next quiz at them.
 */
(() => {
  const { $, $$, escapeHtml, setStatus, api, initCommon } = window.AppCommon;

  let passages = [];
  let current = null;
  let quiz = { questions: [], index: 0, results: [] };

  // ---- Tree -----------------------------------------------------------
  function buildTree(list) {
    const tree = {};
    list.forEach((p) => {
      tree[p.subject] ||= {};
      tree[p.subject][p.notebook] ||= {};
      tree[p.subject][p.notebook][p.chapter] ||= [];
      tree[p.subject][p.notebook][p.chapter].push(p);
    });
    return tree;
  }

  function renderTree() {
    const filter = $('#tagFilter').value.trim().toLowerCase();
    const list = filter
      ? passages.filter((p) => (p.tags || []).some((t) => t.toLowerCase().includes(filter)))
      : passages;
    const node = $('#notesTree');
    if (!list.length) {
      node.innerHTML = `<p class="set-meta">${filter ? 'No passages match that tag.' : 'Nothing here yet — scan or upload your first page.'}</p>`;
      return;
    }
    const tree = buildTree(list);
    node.innerHTML = Object.entries(tree).map(([subject, notebooks]) => `
      <div class="tree-node tree-subject">
        <button class="tree-head"><span class="chev">▾</span>${escapeHtml(subject)}</button>
        <div class="tree-children">
          ${Object.entries(notebooks).map(([notebook, chapters]) => `
            <div class="tree-node">
              <button class="tree-head notebook"><span class="chev">▾</span>${escapeHtml(notebook)}</button>
              <div class="tree-children">
                ${Object.entries(chapters).map(([chapter, items]) => `
                  <div class="tree-node">
                    <button class="tree-head chapter"><span class="chev">▾</span>${escapeHtml(chapter)}</button>
                    <div class="tree-children">
                      ${items.map((p) => `
                        <button class="tree-passage ${current && current.id === p.id ? 'active' : ''}" data-id="${p.id}">
                          ${escapeHtml(p.title)}
                          ${(p.tags || []).length ? `<span class="mini-tags">${p.tags.map(escapeHtml).join(' • ')}</span>` : ''}
                        </button>`).join('')}
                    </div>
                  </div>`).join('')}
              </div>
            </div>`).join('')}
        </div>
      </div>`).join('');

    node.querySelectorAll('.tree-head').forEach((h) => h.addEventListener('click', () => h.parentElement.classList.toggle('collapsed')));
    node.querySelectorAll('.tree-passage').forEach((b) => b.addEventListener('click', () => openPassage(b.dataset.id)));
  }

  async function loadPassages() {
    try {
      const data = await api('/api/passages');
      passages = data.passages || [];
      renderTree();
      // Offer past values in the organize datalists.
      fillDatalist('#subjectList', passages.map((p) => p.subject));
      fillDatalist('#notebookList', passages.map((p) => p.notebook));
      fillDatalist('#chapterList', passages.map((p) => p.chapter));
    } catch (e) { setStatus(e.message, 'error'); }
  }
  function fillDatalist(sel, values) {
    $(sel).innerHTML = Array.from(new Set(values)).map((v) => `<option value="${escapeHtml(v)}"></option>`).join('');
  }

  // ---- Steps ----------------------------------------------------------
  function showStep(id) {
    ['stepCapture', 'stepReview', 'stepPassage', 'stepQuiz'].forEach((s) => { $(`#${s}`).style.display = s === id ? 'block' : 'none'; });
  }

  // ---- Step 1: capture ------------------------------------------------
  async function handleFile(file) {
    if (!file) return;
    const status = $('#ocrStatus');
    status.style.display = 'block';
    status.textContent = file.type.startsWith('image/') ? 'Reading the photo…' : 'Extracting text…';
    try {
      const form = new FormData();
      form.append('document', file);
      const res = await fetch('/api/notes/ocr', { method: 'POST', body: form });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not read that file.');
      $('#passageText').value = data.text;
      showStep('stepReview');
    } catch (e) {
      setStatus(e.message, 'error');
    } finally {
      status.style.display = 'none';
    }
  }

  // ---- Step 2 -> create passage --------------------------------------
  async function makeNotes() {
    const btn = $('#makeNotesBtn');
    btn.disabled = true; const label = btn.textContent; btn.textContent = 'Making notes…';
    try {
      const data = await api('/api/passages', {
        method: 'POST',
        body: JSON.stringify({
          text: $('#passageText').value,
          subject: $('#orgSubject').value,
          notebook: $('#orgNotebook').value,
          chapter: $('#orgChapter').value,
          title: $('#orgTitle').value,
          tags: $('#orgTags').value
        })
      });
      await loadPassages();
      renderPassage(data.passage);
      setStatus('Notes created.', 'success');
    } catch (e) { setStatus(e.message, 'error'); }
    finally { btn.disabled = false; btn.textContent = label; }
  }

  // ---- Step 3: passage view ------------------------------------------
  async function openPassage(idValue) {
    try {
      const data = await api(`/api/passages/${idValue}`);
      renderPassage(data.passage);
      renderTree();
    } catch (e) { setStatus(e.message, 'error'); }
  }

  function renderPassage(p) {
    current = p;
    $('#passageCrumbs').textContent = `${p.subject} → ${p.notebook} → ${p.chapter}`;
    $('#passageTitle').textContent = p.title;
    $('#passageTags').innerHTML = (p.tags || []).map((t) => `<span class="tag-chip">${escapeHtml(t)}</span>`).join('');
    $('#passageOriginal').textContent = p.text;

    const st = p.stats || { attempts: 0, correct: 0, weakTopics: {} };
    const weak = Object.entries(st.weakTopics || {}).sort((a, b) => b[1] - a[1]).map(([t]) => t);
    $('#passageStats').innerHTML = st.attempts
      ? `Answered ${st.attempts} questions, ${st.correct} correct (${Math.round((st.correct / st.attempts) * 100)}%).` +
        (weak.length ? ` <span class="weak">Needs work: ${weak.slice(0, 3).map(escapeHtml).join(', ')}</span>` : '')
      : 'Not quizzed yet.';

    const n = p.notes || {};
    const sec = [];
    if (n.summary) sec.push(`<div class="note-sec"><h3>Summary</h3><p>${escapeHtml(n.summary)}</p></div>`);
    if ((n.mainIdeas || []).length) sec.push(`<div class="note-sec"><h3>Main ideas</h3><ul>${n.mainIdeas.map((i) => `<li>${escapeHtml(i)}</li>`).join('')}</ul></div>`);
    if ((n.facts || []).length) sec.push(`<div class="note-sec"><h3>Important facts</h3><ul>${n.facts.map((f) => `<li>${escapeHtml(f)}</li>`).join('')}</ul></div>`);
    if ((n.keyTerms || []).length) sec.push(`<div class="note-sec"><h3>Key terms</h3>${n.keyTerms.map((t) => `<div class="kv-row"><span class="k">${escapeHtml(t.term)}</span><span>${escapeHtml(t.definition)}</span></div>`).join('')}</div>`);
    if ((n.entities || []).length) sec.push(`<div class="note-sec"><h3>Dates, people &amp; events</h3>${n.entities.map((e) => `<div class="kv-row"><span class="k"><span class="entity-kind">${escapeHtml(e.kind)}</span>${escapeHtml(e.value)}</span><span>${escapeHtml(e.note)}</span></div>`).join('')}</div>`);
    if ((n.simplified || []).length) sec.push(`<div class="note-sec"><h3>Tricky ideas, explained simply</h3>${n.simplified.map((s2) => `<div class="kv-row"><span class="k">${escapeHtml(s2.concept)}</span><span>${escapeHtml(s2.explanation)}</span></div>`).join('')}</div>`);
    $('#notesSections').innerHTML = sec.join('') || '<p class="set-meta">No notes were generated.</p>';
    showStep('stepPassage');
  }

  async function deletePassage() {
    if (!current || !confirm('Delete this passage and its notes?')) return;
    try {
      await api(`/api/passages/${current.id}`, { method: 'DELETE' });
      current = null;
      await loadPassages();
      showStep('stepCapture');
      setStatus('Deleted.', 'success');
    } catch (e) { setStatus(e.message, 'error'); }
  }

  function editOrganization() {
    if (!current) return;
    const subject = prompt('Subject:', current.subject); if (subject === null) return;
    const notebook = prompt('Notebook:', current.notebook); if (notebook === null) return;
    const chapter = prompt('Chapter:', current.chapter); if (chapter === null) return;
    const title = prompt('Passage title:', current.title); if (title === null) return;
    const tags = prompt('Tags (comma separated):', (current.tags || []).join(', ')); if (tags === null) return;
    api(`/api/passages/${current.id}`, { method: 'PATCH', body: JSON.stringify({ subject, notebook, chapter, title, tags }) })
      .then((d) => { renderPassage(d.passage); return loadPassages(); })
      .catch((e) => setStatus(e.message, 'error'));
  }

  // ---- Quiz -----------------------------------------------------------
  function openQuizSetup() {
    if (!current) return;
    const weak = Object.entries((current.stats || {}).weakTopics || {}).sort((a, b) => b[1] - a[1]).map(([t]) => t);
    const note = $('#weakTopicsNote');
    if (weak.length) {
      note.style.display = 'block';
      note.textContent = `Athena will focus extra questions on what you've been missing: ${weak.slice(0, 3).join(', ')}.`;
    } else note.style.display = 'none';
    $('#quizSetup').style.display = 'block';
    $('#quizRun').style.display = 'none';
    $('#quizDone').style.display = 'none';
    showStep('stepQuiz');
  }

  async function startQuiz() {
    const types = $$('.quiz-types input:checked').map((i) => i.value);
    if (!types.length) return setStatus('Pick at least one question type.', 'error');
    const btn = $('#startQuizBtn');
    btn.disabled = true; btn.textContent = 'Writing questions…';
    try {
      const data = await api(`/api/passages/${current.id}/quiz`, {
        method: 'POST',
        body: JSON.stringify({ types, count: Number($('#quizCount').value) })
      });
      quiz = { questions: data.questions, index: 0, results: [] };
      $('#quizSetup').style.display = 'none';
      $('#quizRun').style.display = 'block';
      renderQuestion();
    } catch (e) { setStatus(e.message, 'error'); }
    finally { btn.disabled = false; btn.textContent = 'Start quiz'; }
  }

  const TYPE_LABELS = { mc: 'Multiple choice', tf: 'True or false', short: 'Short answer', fib: 'Fill in the blank', flash: 'Flashcard' };

  function renderQuestion() {
    const q = quiz.questions[quiz.index];
    $('#quizProgress').textContent = `${quiz.index + 1} / ${quiz.questions.length}`;
    $('#quizFeedback').style.display = 'none';
    $('#quizNextBtn').style.display = 'none';
    const card = $('#quizCard');

    if (q.type === 'mc') {
      card.innerHTML = `<span class="q-type">${TYPE_LABELS.mc}</span><h3>${escapeHtml(q.question)}</h3>
        <div class="quiz-options">${(q.options || []).map((o) => `<button class="quiz-opt" data-val="${escapeHtml(o)}">${escapeHtml(o)}</button>`).join('')}</div>`;
      card.querySelectorAll('.quiz-opt').forEach((b) => b.addEventListener('click', () => gradeAuto(q, b.dataset.val, b)));
    } else if (q.type === 'tf') {
      card.innerHTML = `<span class="q-type">${TYPE_LABELS.tf}</span><h3>${escapeHtml(q.question)}</h3>
        <div class="quiz-options"><button class="quiz-opt" data-val="True">True</button><button class="quiz-opt" data-val="False">False</button></div>`;
      card.querySelectorAll('.quiz-opt').forEach((b) => b.addEventListener('click', () => gradeAuto(q, b.dataset.val, b)));
    } else if (q.type === 'fib') {
      card.innerHTML = `<span class="q-type">${TYPE_LABELS.fib}</span><h3>${escapeHtml(q.question)}</h3>
        <input class="quiz-input" id="quizAnswerInput" placeholder="Type the missing word(s)…" />
        <button class="btn primary" id="quizSubmitBtn">Check</button>`;
      $('#quizSubmitBtn').addEventListener('click', () => gradeAuto(q, $('#quizAnswerInput').value, null));
      $('#quizAnswerInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') gradeAuto(q, $('#quizAnswerInput').value, null); });
      $('#quizAnswerInput').focus();
    } else if (q.type === 'short') {
      card.innerHTML = `<span class="q-type">${TYPE_LABELS.short}</span><h3>${escapeHtml(q.question)}</h3>
        <input class="quiz-input" id="quizAnswerInput" placeholder="Answer in your own words…" />
        <button class="btn primary" id="quizSubmitBtn">Show answer</button>`;
      $('#quizSubmitBtn').addEventListener('click', () => revealSelfGrade(q, $('#quizAnswerInput').value));
      $('#quizAnswerInput').focus();
    } else { // flash
      card.innerHTML = `<span class="q-type">${TYPE_LABELS.flash}</span><h3>${escapeHtml(q.question)}</h3>
        <button class="btn primary" id="quizSubmitBtn">Flip</button>
        <div class="flash-back" id="flashBack"><p>${escapeHtml(q.answer)}</p></div>`;
      $('#quizSubmitBtn').addEventListener('click', () => { $('#flashBack').style.display = 'block'; revealSelfGrade(q, null, true); });
    }
  }

  const norm = (v) => String(v || '').trim().toLowerCase().replace(/[.,!?;:'"]/g, '').replace(/\s+/g, ' ');

  function gradeAuto(q, userValue, clickedBtn) {
    const correct = norm(userValue) === norm(q.answer);
    if (clickedBtn) {
      clickedBtn.classList.add(correct ? 'chosen-right' : 'chosen-wrong');
      if (!correct) {
        $$('#quizCard .quiz-opt').forEach((b) => { if (norm(b.dataset.val) === norm(q.answer)) b.classList.add('reveal-right'); });
      }
      $$('#quizCard .quiz-opt').forEach((b) => { b.disabled = true; });
    }
    recordResult(q, correct);
    showFeedback(q, correct);
  }

  // Short answers and flashcards: show the model answer, let the student
  // honestly say whether they had it. Auto-grading free text against one
  // reference phrasing would mark too many right answers wrong.
  function revealSelfGrade(q, userValue, isFlash) {
    const fb = $('#quizFeedback');
    fb.className = 'quiz-feedback';
    fb.style.display = 'block';
    fb.innerHTML = `
      ${isFlash ? '' : `<strong>Answer:</strong> ${escapeHtml(q.answer)}<br/>`}
      ${q.explanation ? `${escapeHtml(q.explanation)}<br/>` : ''}
      ${q.evidence ? `<span class="evidence">“${escapeHtml(q.evidence)}”</span>` : ''}
      <div class="self-grade">
        <button class="btn soft small" id="selfRight">✓ I got it</button>
        <button class="btn ghost small" id="selfWrong">✗ I missed it</button>
      </div>`;
    $('#selfRight').addEventListener('click', () => { recordResult(q, true); afterSelfGrade(true); });
    $('#selfWrong').addEventListener('click', () => { recordResult(q, false); afterSelfGrade(false); });
  }
  function afterSelfGrade(correct) {
    const fb = $('#quizFeedback');
    fb.classList.add(correct ? 'right' : 'wrong');
    fb.querySelector('.self-grade').remove();
    $('#quizNextBtn').style.display = '';
  }

  function showFeedback(q, correct) {
    const fb = $('#quizFeedback');
    fb.className = `quiz-feedback ${correct ? 'right' : 'wrong'}`;
    fb.style.display = 'block';
    fb.innerHTML = `
      <strong>${correct ? 'Correct!' : `Not quite — the answer is: ${escapeHtml(q.answer)}`}</strong><br/>
      ${q.explanation ? `${escapeHtml(q.explanation)}<br/>` : ''}
      ${q.evidence ? `<span class="evidence">“${escapeHtml(q.evidence)}”</span>` : ''}`;
    $('#quizNextBtn').style.display = '';
  }

  function recordResult(q, correct) {
    quiz.results.push({ questionId: q.id, question: q.question, topic: q.topic, correct });
  }

  async function nextQuestion() {
    quiz.index += 1;
    if (quiz.index < quiz.questions.length) return renderQuestion();

    // Quiz over: report results, show score.
    const right = quiz.results.filter((r) => r.correct).length;
    try {
      const data = await api(`/api/passages/${current.id}/attempt`, { method: 'POST', body: JSON.stringify({ results: quiz.results }) });
      current.stats = { ...current.stats, ...data.stats };
    } catch (e) { /* stats are best-effort; don't block the score screen */ }
    const weak = Object.entries((current.stats || {}).weakTopics || {}).sort((a, b) => b[1] - a[1]).map(([t]) => t);
    $('#quizRun').style.display = 'none';
    $('#quizDone').style.display = 'block';
    $('#quizDone').innerHTML = `
      <h2>Done!</h2>
      <p class="quiz-score">${right} / ${quiz.results.length}</p>
      ${weak.length ? `<p class="notes-hint">Topics to revisit: <strong>${weak.slice(0, 4).map(escapeHtml).join(', ')}</strong>. Your next quiz will focus on these.</p>` : '<p class="notes-hint">No weak spots on record — nice work.</p>'}
      <div class="step-actions" style="justify-content:flex-start">
        <button class="btn primary" id="quizAgainBtn">Quiz again</button>
        <button class="btn soft" id="backToNotesBtn">Back to notes</button>
      </div>`;
    $('#quizAgainBtn').addEventListener('click', openQuizSetup);
    $('#backToNotesBtn').addEventListener('click', () => renderPassage(current));
  }

  // ---- Boot -----------------------------------------------------------
  async function init() {
    $('#cameraInput').addEventListener('change', (e) => handleFile(e.target.files[0]));
    $('#fileInput').addEventListener('change', (e) => handleFile(e.target.files[0]));
    $('#backToCapture').addEventListener('click', () => showStep('stepCapture'));
    $('#makeNotesBtn').addEventListener('click', makeNotes);
    $('#newPassageBtn').addEventListener('click', () => { current = null; renderTree(); showStep('stepCapture'); });
    $('#deletePassageBtn').addEventListener('click', deletePassage);
    $('#editOrgBtn').addEventListener('click', editOrganization);
    $('#quizMeBtn').addEventListener('click', openQuizSetup);
    $('#startQuizBtn').addEventListener('click', startQuiz);
    $('#quizNextBtn').addEventListener('click', nextQuestion);
    $('#quizExitBtn').addEventListener('click', () => (current ? renderPassage(current) : showStep('stepCapture')));
    $('#tagFilter').addEventListener('input', renderTree);
    await initCommon();
    await loadPassages();
  }

  init().catch((e) => setStatus(e.message, 'error'));
})();
