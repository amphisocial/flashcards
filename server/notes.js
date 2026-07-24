/*
 * Athena Notes (v2.3)
 * -----------------------------------------------------------------------
 * Scan/upload a page -> OCR -> structured study notes -> organized as
 * Subject -> Notebook -> Chapter -> Passage (plus free-form tags) -> quiz
 * in five formats -> per-question learning tracking that re-weights future
 * quizzes toward what the user keeps missing.
 *
 * Data lives in the main store under `passages`:
 * {
 *   id, ownerId, subject, notebook, chapter, title,
 *   text,                 // the OCR'd / uploaded passage text
 *   tags: [],
 *   notes: { summary, facts[], keyTerms[{term,definition}], mainIdeas[],
 *            entities[{kind,value,note}], simplified[] },
 *   stats: { attempts, correct,
 *            missed: [{question, topic, at}],       // rolling, capped
 *            weakTopics: { topic: missCount } },
 *   createdAt, updatedAt
 * }
 *
 * Quiz questions are generated on demand (not persisted): each carries its
 * type, answer, a why-it's-correct explanation, the supporting sentence
 * quoted from the passage, and a short topic label used for weakness
 * tracking. Generation is steered toward the user's current weakTopics.
 */

const MAX_PASSAGES_PER_USER = 500;
const MAX_MISSED_KEPT = 200;

function attachNotesRoutes(app, deps) {
  const {
    requireUser, readStore, writeStore, id, nowIso, upload,
    askVisionAI, callProviderRaw, extractUploadText, canCreateSet, compactText
  } = deps;

  // ---------------------------------------------------------------------
  // 1) OCR / text extraction
  // ---------------------------------------------------------------------
  // Photos go through the vision model; PDFs/docx/txt reuse the same
  // extractor the Create page already uses. Either way the user gets
  // editable text back before anything is saved, so bad OCR can be fixed.
  app.post('/api/notes/ocr', requireUser, upload.single('document'), async (req, res) => {
    try {
      const file = req.file;
      if (!file) return res.status(400).json({ error: 'No file received.' });
      const mime = file.mimetype || '';

      if (mime.startsWith('image/')) {
        if (file.size > 8 * 1024 * 1024) return res.status(413).json({ error: 'Image too large — keep it under 8MB.' });
        const dataUrl = `data:${mime};base64,${file.buffer.toString('base64')}`;
        const text = await askVisionAI({
          instructions: 'Transcribe ALL text visible in this image exactly as written, preserving paragraphs and line breaks where meaningful. This may be a photographed book page, worksheet, or handwritten notes. Output only the transcribed text — no commentary, no markdown.',
          imageDataUrl: dataUrl
        });
        const cleaned = String(text || '').trim();
        if (cleaned.length < 10) return res.status(422).json({ error: "Couldn't read enough text from that image. Try better lighting or a closer shot." });
        return res.json({ text: compactText(cleaned, 50000), source: 'image-ocr' });
      }

      const text = await extractUploadText(file);
      if (!text || text.trim().length < 10) return res.status(422).json({ error: "Couldn't extract readable text from that file." });
      return res.json({ text, source: 'file' });
    } catch (error) {
      console.error('OCR failed:', error);
      res.status(502).json({ error: error.message || 'Could not read that file.' });
    }
  });

  // ---------------------------------------------------------------------
  // 2) Create a passage + structured notes
  // ---------------------------------------------------------------------
  function parseModelJson(raw) {
    const text = String(raw || '').trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start < 0 || end <= start) throw new Error('The model did not return readable notes.');
    return JSON.parse(text.slice(start, end + 1));
  }

  const NOTES_PROMPT = (text) => [
    'Turn the following passage into organized study notes.',
    'Respond with a SINGLE JSON object, no markdown fences, no prose outside it:',
    '{',
    '  "summary": "2-4 sentence plain-language summary",',
    '  "facts": ["important fact", ...],',
    '  "keyTerms": [{ "term": "...", "definition": "..." }],',
    '  "mainIdeas": ["main idea", ...],',
    '  "entities": [{ "kind": "date|person|formula|event|place", "value": "...", "note": "why it matters" }],',
    '  "simplified": [{ "concept": "difficult idea from the passage", "explanation": "explained simply, as if to a 12-year-old" }]',
    '}',
    'Only include entities and simplified concepts that actually appear in the passage. Keep every item grounded in the text.',
    '',
    'PASSAGE:',
    text
  ].join('\n');

  app.post('/api/passages', requireUser, async (req, res) => {
    const text = compactText(String(req.body.text || ''), 50000);
    if (text.trim().length < 30) return res.status(400).json({ error: 'The passage is too short to make notes from.' });

    const usage = canCreateSet(req.user);
    if (!usage.ok) return res.status(429).json({ error: `You've used all ${usage.limit} AI generations for today.` });

    const store = readStore();
    store.passages ||= [];
    const mine = store.passages.filter((p) => p.ownerId === req.user.id);
    if (mine.length >= MAX_PASSAGES_PER_USER) return res.status(400).json({ error: 'Passage limit reached — delete some old ones first.' });

    let notes;
    try {
      notes = parseModelJson(await callProviderRaw(NOTES_PROMPT(text)));
    } catch (error) {
      console.error('Notes generation failed:', error);
      return res.status(502).json({ error: error.message || 'Could not generate notes for this passage.' });
    }

    const passage = {
      id: id('psg'),
      ownerId: req.user.id,
      subject: String(req.body.subject || 'General').trim().slice(0, 60) || 'General',
      notebook: String(req.body.notebook || 'Notebook 1').trim().slice(0, 60) || 'Notebook 1',
      chapter: String(req.body.chapter || 'Chapter 1').trim().slice(0, 60) || 'Chapter 1',
      title: String(req.body.title || 'Untitled passage').trim().slice(0, 80) || 'Untitled passage',
      text,
      tags: normalizeTags(req.body.tags),
      notes: {
        summary: String(notes.summary || ''),
        facts: asStringArray(notes.facts),
        keyTerms: asObjArray(notes.keyTerms, ['term', 'definition']),
        mainIdeas: asStringArray(notes.mainIdeas),
        entities: asObjArray(notes.entities, ['kind', 'value', 'note']),
        simplified: asObjArray(notes.simplified, ['concept', 'explanation'])
      },
      stats: { attempts: 0, correct: 0, missed: [], weakTopics: {} },
      createdAt: nowIso(),
      updatedAt: nowIso()
    };
    store.passages.push(passage);
    writeStore(store);
    res.json({ passage });
  });

  function normalizeTags(raw) {
    const list = Array.isArray(raw) ? raw : String(raw || '').split(',');
    return Array.from(new Set(list.map((t) => String(t).trim()).filter(Boolean))).slice(0, 12);
  }
  function asStringArray(v) { return Array.isArray(v) ? v.map((x) => String(x)).filter(Boolean).slice(0, 30) : []; }
  function asObjArray(v, keys) {
    if (!Array.isArray(v)) return [];
    return v.slice(0, 30).map((o) => {
      const out = {};
      keys.forEach((k) => { out[k] = String((o || {})[k] || ''); });
      return out;
    }).filter((o) => Object.values(o).some(Boolean));
  }

  // ---------------------------------------------------------------------
  // 3) Organize / browse
  // ---------------------------------------------------------------------
  app.get('/api/passages', requireUser, (req, res) => {
    const store = readStore();
    const mine = (store.passages || [])
      .filter((p) => p.ownerId === req.user.id)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map((p) => ({
        id: p.id, subject: p.subject, notebook: p.notebook, chapter: p.chapter,
        title: p.title, tags: p.tags, createdAt: p.createdAt, updatedAt: p.updatedAt,
        stats: { attempts: p.stats.attempts, correct: p.stats.correct, weakCount: Object.keys(p.stats.weakTopics || {}).length }
      }));
    res.json({ passages: mine });
  });

  app.get('/api/passages/:id', requireUser, (req, res) => {
    const store = readStore();
    const p = (store.passages || []).find((x) => x.id === req.params.id && x.ownerId === req.user.id);
    if (!p) return res.status(404).json({ error: 'Passage not found.' });
    res.json({ passage: p });
  });

  app.patch('/api/passages/:id', requireUser, (req, res) => {
    const store = readStore();
    const p = (store.passages || []).find((x) => x.id === req.params.id && x.ownerId === req.user.id);
    if (!p) return res.status(404).json({ error: 'Passage not found.' });
    ['subject', 'notebook', 'chapter', 'title'].forEach((k) => {
      if (req.body[k] !== undefined) p[k] = String(req.body[k]).trim().slice(0, 80) || p[k];
    });
    if (req.body.tags !== undefined) p.tags = normalizeTags(req.body.tags);
    p.updatedAt = nowIso();
    writeStore(store);
    res.json({ passage: p });
  });

  app.delete('/api/passages/:id', requireUser, (req, res) => {
    const store = readStore();
    store.passages = (store.passages || []).filter((x) => !(x.id === req.params.id && x.ownerId === req.user.id));
    writeStore(store);
    res.json({ ok: true });
  });

  // ---------------------------------------------------------------------
  // 4) Quiz generation (five formats), weak-topic aware
  // ---------------------------------------------------------------------
  const QUIZ_TYPES = ['mc', 'tf', 'short', 'fib', 'flash'];

  const QUIZ_PROMPT = (text, types, count, weakTopics) => [
    `Write ${count} quiz questions from the passage below.`,
    `Use ONLY these question types, mixing them: ${types.join(', ')}.`,
    'Type meanings: mc = multiple choice (4 options), tf = true/false, short = short answer, fib = fill in the blank (use ____ in the question), flash = flashcard (front/back).',
    weakTopics.length
      ? `The student keeps missing these topics — weight roughly half the questions toward them: ${weakTopics.join('; ')}.`
      : '',
    'Respond with a SINGLE JSON object, no markdown fences:',
    '{ "questions": [ {',
    '  "type": "mc|tf|short|fib|flash",',
    '  "topic": "2-5 word topic label",',
    '  "question": "the question (for flash, the front)",',
    '  "options": ["only for mc: exactly 4"],',
    '  "answer": "correct answer (for tf: True or False; for flash: the back)",',
    '  "explanation": "why this answer is correct",',
    '  "evidence": "the exact sentence from the passage that supports it"',
    '} ] }',
    'Every evidence value MUST be a verbatim sentence (or near-verbatim clause) from the passage.',
    '',
    'PASSAGE:',
    text
  ].filter(Boolean).join('\n');

  app.post('/api/passages/:id/quiz', requireUser, async (req, res) => {
    const store = readStore();
    const p = (store.passages || []).find((x) => x.id === req.params.id && x.ownerId === req.user.id);
    if (!p) return res.status(404).json({ error: 'Passage not found.' });

    const usage = canCreateSet(req.user);
    if (!usage.ok) return res.status(429).json({ error: `You've used all ${usage.limit} AI generations for today.` });

    const types = (Array.isArray(req.body.types) ? req.body.types : QUIZ_TYPES).filter((t) => QUIZ_TYPES.includes(t));
    if (!types.length) return res.status(400).json({ error: 'Pick at least one question type.' });
    const count = Math.max(3, Math.min(20, Number(req.body.count || 8)));

    // Most-missed topics first; generation weights toward them so the user
    // gets quizzed more often on what they're weakest at.
    const weakTopics = Object.entries(p.stats.weakTopics || {})
      .sort((a, b) => b[1] - a[1]).slice(0, 5).map(([t]) => t);

    try {
      const parsed = parseModelJson(await callProviderRaw(QUIZ_PROMPT(p.text, types, count, weakTopics)));
      const questions = (Array.isArray(parsed.questions) ? parsed.questions : [])
        .filter((q) => q && QUIZ_TYPES.includes(q.type) && q.question && q.answer)
        .slice(0, count)
        .map((q) => ({
          id: id('q'),
          type: q.type,
          topic: String(q.topic || 'general').slice(0, 60),
          question: String(q.question).slice(0, 500),
          options: q.type === 'mc' ? asStringArray(q.options).slice(0, 4) : undefined,
          answer: String(q.answer).slice(0, 300),
          explanation: String(q.explanation || '').slice(0, 600),
          evidence: String(q.evidence || '').slice(0, 400)
        }));
      if (!questions.length) return res.status(502).json({ error: 'Question generation came back empty — try again.' });
      res.json({ questions, weakTopics });
    } catch (error) {
      console.error('Quiz generation failed:', error);
      res.status(502).json({ error: error.message || 'Could not generate a quiz.' });
    }
  });

  // ---------------------------------------------------------------------
  // 5) Track learning
  // ---------------------------------------------------------------------
  // The client grades each answer (it has the answer + the user's response)
  // and reports the outcome; the server keeps durable per-passage stats and
  // the weak-topic weights that steer the next quiz.
  app.post('/api/passages/:id/attempt', requireUser, (req, res) => {
    const store = readStore();
    const p = (store.passages || []).find((x) => x.id === req.params.id && x.ownerId === req.user.id);
    if (!p) return res.status(404).json({ error: 'Passage not found.' });

    const results = Array.isArray(req.body.results) ? req.body.results.slice(0, 50) : [];
    if (!results.length) return res.status(400).json({ error: 'No results to record.' });

    p.stats ||= { attempts: 0, correct: 0, missed: [], weakTopics: {} };
    results.forEach((r) => {
      p.stats.attempts += 1;
      const topic = String(r.topic || 'general').slice(0, 60);
      if (r.correct) {
        p.stats.correct += 1;
        // A correct answer softens (but doesn't instantly erase) a weakness.
        if (p.stats.weakTopics[topic]) {
          p.stats.weakTopics[topic] -= 1;
          if (p.stats.weakTopics[topic] <= 0) delete p.stats.weakTopics[topic];
        }
      } else {
        p.stats.weakTopics[topic] = (p.stats.weakTopics[topic] || 0) + 1;
        p.stats.missed.push({ question: String(r.question || '').slice(0, 300), topic, at: nowIso() });
        if (p.stats.missed.length > MAX_MISSED_KEPT) p.stats.missed = p.stats.missed.slice(-MAX_MISSED_KEPT);
      }
    });
    p.updatedAt = nowIso();
    writeStore(store);
    res.json({ stats: { attempts: p.stats.attempts, correct: p.stats.correct, weakTopics: p.stats.weakTopics } });
  });
}

module.exports = { attachNotesRoutes };
