/*
 * Athena Flashcards
 * Simple Express app for AI-generated flashcards, quizzes, and slide study sets.
 * Stores users, sessions, usage, study sets and share invites in data/store.json.
 * (The store.json key "quizlets" is retained for backward compatibility with existing data.)
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const Stripe = require('stripe');

// Load .env when present. Under systemd this is redundant (EnvironmentFile=
// already injects it), but pm2 and plain `node server/server.js` need this
// to pick up secrets/config from .env.
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const PORT = Number(process.env.PORT || 3004);
const APP_BASE_URL = (process.env.APP_BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const COOKIE_NAME = process.env.SESSION_COOKIE_NAME || 'athena_flashcards_session';
const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-only-session-secret';
const NODE_ENV = process.env.NODE_ENV || 'development';
const DATA_DIR = path.join(__dirname, '..', 'data');
const STORE_FILE = path.join(DATA_DIR, 'store.json');
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const stripe = process.env.STRIPE_SECRET_KEY ? Stripe(process.env.STRIPE_SECRET_KEY) : null;

const PLAN_LIMITS = {
  free: { label: 'Free', setsPerDay: 5, shareSeats: 0 },
  starter: { label: 'Starter', setsPerDay: 10, shareSeats: 0 },
  team: { label: 'Teams', setsPerDay: 20, shareSeats: 30 }
};

const STRIPE_PRICE_TO_PLAN = Object.fromEntries(
  [
    [process.env.STRIPE_PRICE_STARTER, 'starter'],
    [process.env.STRIPE_PRICE_TEAM, 'team']
  ].filter(([priceId]) => Boolean(priceId))
);

function ensureStore() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(STORE_FILE)) {
    const initial = {
      users: [],
      sessions: [],
      quizlets: [],
      events: []
    };
    fs.writeFileSync(STORE_FILE, JSON.stringify(initial, null, 2));
  }
}

function readStore() {
  ensureStore();
  try {
    const parsed = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
    parsed.users ||= [];
    parsed.sessions ||= [];
    parsed.quizlets ||= [];
    parsed.events ||= [];
    return parsed;
  } catch (error) {
    console.error('Failed to read store:', error);
    return { users: [], sessions: [], quizlets: [], events: [] };
  }
}

function writeStore(store) {
  ensureStore();
  const temp = `${STORE_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(store, null, 2));
  fs.renameSync(temp, STORE_FILE);
}

function id(prefix) {
  return `${prefix}_${crypto.randomBytes(12).toString('hex')}`;
}

function nowIso() {
  return new Date().toISOString();
}

function todayKey(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function hashPassword(password) {
  const iterations = 310000;
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, iterations, 32, 'sha256').toString('hex');
  return `pbkdf2_sha256$${iterations}$${salt}$${hash}`;
}

function verifyPassword(password, stored) {
  try {
    const [scheme, iterationText, salt, expected] = String(stored || '').split('$');
    if (scheme !== 'pbkdf2_sha256') return false;
    const actual = crypto.pbkdf2Sync(password, salt, Number(iterationText), 32, 'sha256').toString('hex');
    return crypto.timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex'));
  } catch {
    return false;
  }
}

function parseCookies(req) {
  const header = req.headers.cookie || '';
  return Object.fromEntries(
    header
      .split(';')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const index = part.indexOf('=');
        if (index < 0) return [part, ''];
        return [part.slice(0, index), decodeURIComponent(part.slice(index + 1))];
      })
  );
}

function setCookie(res, name, value, options = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  if (options.maxAge) parts.push(`Max-Age=${Math.floor(options.maxAge / 1000)}`);
  if (options.httpOnly !== false) parts.push('HttpOnly');
  parts.push(`SameSite=${options.sameSite || 'Lax'}`);
  parts.push('Path=/');
  if (options.secure) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

function clearCookie(res, name) {
  res.setHeader('Set-Cookie', `${name}=; Max-Age=0; HttpOnly; SameSite=Lax; Path=/`);
}

function publicUser(user) {
  if (!user) return null;
  const plan = user.plan || 'free';
  return {
    id: user.id,
    email: user.email,
    firstName: user.firstName || '',
    lastName: user.lastName || '',
    name: [user.firstName, user.lastName].filter(Boolean).join(' ') || user.email,
    plan,
    planLabel: PLAN_LIMITS[plan]?.label || 'Free',
    subscriptionStatus: user.subscriptionStatus || 'free',
    limits: PLAN_LIMITS[plan] || PLAN_LIMITS.free
  };
}

function getCurrentUser(req) {
  const token = parseCookies(req)[COOKIE_NAME];
  if (!token) return null;
  const store = readStore();
  const session = store.sessions.find((item) => item.token === token && new Date(item.expiresAt) > new Date());
  if (!session) return null;
  return store.users.find((user) => user.id === session.userId) || null;
}

function requireUser(req, res, next) {
  const user = getCurrentUser(req);
  if (!user) return res.status(401).json({ error: 'Please sign in first.' });
  req.user = user;
  next();
}

function createSession(res, userId) {
  const store = readStore();
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24 * 30).toISOString();
  store.sessions = store.sessions.filter((session) => new Date(session.expiresAt) > new Date());
  store.sessions.push({ token, userId, createdAt: nowIso(), expiresAt });
  writeStore(store);
  setCookie(res, COOKIE_NAME, token, {
    maxAge: 1000 * 60 * 60 * 24 * 30,
    secure: NODE_ENV === 'production'
  });
}

function getDailyUsage(userId) {
  const store = readStore();
  const today = todayKey();
  return store.quizlets.filter((quizlet) => quizlet.ownerId === userId && todayKey(new Date(quizlet.createdAt)) === today).length;
}

function canCreateSet(user) {
  const plan = user.plan || 'free';
  const limit = PLAN_LIMITS[plan]?.setsPerDay || PLAN_LIMITS.free.setsPerDay;
  const used = getDailyUsage(user.id);
  return { ok: used < limit, used, limit, remaining: Math.max(0, limit - used) };
}

function userCanReadQuizlet(user, quizlet) {
  if (!user || !quizlet) return false;
  if (quizlet.ownerId === user.id) return true;
  return (quizlet.invitedEmails || []).map(normalizeEmail).includes(normalizeEmail(user.email));
}

function compactText(text, maxLength = 16000) {
  return String(text || '')
    .replace(/\u0000/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, maxLength);
}

function stripHtml(text) {
  return String(text || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

// ---- Optional stock photography for slide decks -----------------------
// Set PEXELS_API_KEY (preferred, generous free tier) or UNSPLASH_ACCESS_KEY
// in .env to have slides fetch a real, relevant photo per slide. If neither
// is set, slides still render at full quality using a designed gradient +
// icon treatment instead of a photo — no external calls are made.
const imageCache = new Map();

async function fetchStockImage(query) {
  const key = String(query || '').trim().toLowerCase();
  if (!key) return null;
  if (imageCache.has(key)) return imageCache.get(key);

  let result = null;
  try {
    if (process.env.PEXELS_API_KEY) {
      const response = await fetch(`https://api.pexels.com/v1/search?query=${encodeURIComponent(key)}&per_page=1&orientation=landscape`, {
        headers: { Authorization: process.env.PEXELS_API_KEY }
      });
      const data = await response.json();
      const photo = data.photos?.[0];
      if (photo) {
        result = {
          url: photo.src?.large2x || photo.src?.large || photo.src?.original,
          credit: `Photo by ${photo.photographer} on Pexels`,
          creditUrl: photo.url
        };
      }
    } else if (process.env.UNSPLASH_ACCESS_KEY) {
      const response = await fetch(`https://api.unsplash.com/search/photos?query=${encodeURIComponent(key)}&per_page=1&orientation=landscape`, {
        headers: { Authorization: `Client-ID ${process.env.UNSPLASH_ACCESS_KEY}` }
      });
      const data = await response.json();
      const photo = data.results?.[0];
      if (photo) {
        result = {
          url: photo.urls?.regular,
          credit: `Photo by ${photo.user?.name || 'Unsplash'} on Unsplash`,
          creditUrl: photo.links?.html
        };
      }
    }
  } catch (error) {
    console.warn('Stock image fetch failed:', error.message);
  }
  imageCache.set(key, result);
  return result;
}

async function attachSlideImages(cards) {
  if (!process.env.PEXELS_API_KEY && !process.env.UNSPLASH_ACCESS_KEY) return;
  const candidates = cards.filter((card) => card.type === 'slide' && card.imageQuery && card.layout !== 'quote' && card.layout !== 'chart');
  const batchSize = 4;
  for (let i = 0; i < candidates.length; i += batchSize) {
    const batch = candidates.slice(i, i + batchSize);
    // eslint-disable-next-line no-await-in-loop
    await Promise.all(batch.map(async (card) => {
      const image = await fetchStockImage(card.imageQuery);
      if (image) {
        card.imageUrl = image.url;
        card.imageCredit = image.credit;
        card.imageCreditUrl = image.creditUrl;
      }
    }));
  }
}

// ---- Configurable prompts & "skills" -----------------------------------
// The actual generation prompts live as plain text files under
// server/prompts/, not hardcoded in this file, so they can be tuned on the
// server (house style, structural conventions, etc.) without a code change
// or redeploy. Files are read fresh on every generation call.
const PROMPTS_DIR = path.join(__dirname, 'prompts');
const SKILLS_DIR = path.join(PROMPTS_DIR, 'skills');

function readTextFile(filePath) {
  try { return fs.readFileSync(filePath, 'utf8'); } catch { return ''; }
}

function renderTemplate(template, vars) {
  return template.replace(/{{\s*(\w+)\s*}}/g, (_, key) => (vars[key] ?? ''));
}

function stripComments(text) {
  return text
    .split('\n')
    .filter((line) => !line.trim().startsWith('#'))
    .join('\n')
    .trim();
}

function loadSkills(envVar, defaultList) {
  const names = String(process.env[envVar] || defaultList).split(',').map((name) => name.trim()).filter(Boolean);
  return names
    .map((name) => readTextFile(path.join(SKILLS_DIR, `${name}.md`)).trim())
    .filter(Boolean)
    .join('\n\n');
}

function loadSecretSauce() {
  return stripComments(readTextFile(path.join(SKILLS_DIR, 'secret-sauce.md')));
}

function safeJsonFromText(text) {
  const raw = String(text || '').trim();
  try {
    return JSON.parse(raw);
  } catch {
    const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced) {
      try { return JSON.parse(fenced[1]); } catch { /* continue */ }
    }
    const firstBrace = raw.indexOf('{');
    const lastBrace = raw.lastIndexOf('}');
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      try { return JSON.parse(raw.slice(firstBrace, lastBrace + 1)); } catch { /* continue */ }
    }
    throw new Error('The AI response was not valid JSON.');
  }
}

const SLIDE_LAYOUTS = new Set(['title', 'agenda', 'content', 'stat', 'chart', 'quote', 'section', 'closing']);

function cleanCard(card, index, format) {
  const front = String(card.front || card.term || card.question || card.title || `Card ${index + 1}`).trim();
  const back = String(card.back || card.answer || card.definition || card.body || '').trim();
  const choices = Array.isArray(card.choices) ? card.choices.map((choice) => String(choice).trim()).filter(Boolean).slice(0, 5) : [];
  let type;
  if (card.type === 'slide' || format === 'slides') {
    type = 'slide';
  } else if (choices.length >= 2 || format === 'quiz') {
    type = 'quiz';
  } else {
    type = 'flashcard';
  }
  const normalized = (value) => String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
  const answerIndex = type === 'quiz'
    ? choices.findIndex((choice) => normalized(choice) === normalized(back))
    : -1;

  const base = {
    id: id('card'),
    front: front.slice(0, 500),
    back: back.slice(0, type === 'slide' ? 2400 : 1200) || 'Review the source material and add your answer here.',
    type,
    choices: type === 'slide' ? [] : choices,
    answerIndex,
    explanation: String(card.explanation || '').trim().slice(0, 1200)
  };

  if (type !== 'slide') return base;

  const layout = SLIDE_LAYOUTS.has(card.layout) ? card.layout : (index === 0 ? 'title' : 'content');
  const stat = card.stat && (card.stat.value || card.stat.label)
    ? { value: String(card.stat.value || '').trim().slice(0, 24), label: String(card.stat.label || '').trim().slice(0, 140) }
    : null;
  const quote = card.quote && (typeof card.quote === 'string' ? card.quote : card.quote.text)
    ? {
        text: String(typeof card.quote === 'string' ? card.quote : card.quote.text || '').trim().slice(0, 320),
        attribution: String((card.quote && card.quote.attribution) || '').trim().slice(0, 120)
      }
    : null;
  const chart = card.chart && Array.isArray(card.chart.series) && card.chart.series.length
    ? {
        type: card.chart.type === 'line' ? 'line' : 'bar',
        unit: String(card.chart.unit || '').trim().slice(0, 12),
        series: card.chart.series
          .slice(0, 6)
          .map((point) => ({ label: String(point.label || '').trim().slice(0, 24), value: Number(point.value) }))
          .filter((point) => point.label && Number.isFinite(point.value))
      }
    : null;
  const resolvedLayout = layout === 'chart' && (!chart || chart.series.length < 2) ? 'content' : layout;

  return {
    ...base,
    layout: resolvedLayout,
    kicker: String(card.kicker || '').trim().slice(0, 60),
    stat,
    quote,
    chart: resolvedLayout === 'chart' ? chart : null,
    imageQuery: String(card.imageQuery || '').trim().slice(0, 80),
    imageUrl: null,
    imageCredit: null,
    imageCreditUrl: null
  };
}

async function normalizeGeneratedSet(payload, requestedCount, format) {
  const title = String(payload.title || payload.name || 'AI Study Set').trim().slice(0, 90) || 'AI Study Set';
  const rawCards = Array.isArray(payload.cards) ? payload.cards : [];
  const cards = rawCards
    .slice(0, Math.max(1, Math.min(60, requestedCount)))
    .map((card, index) => cleanCard(card, index, format))
    .filter((card) => card.front && card.back);
  if (!cards.length) throw new Error('No usable cards were generated.');
  if (format === 'slides') await attachSlideImages(cards);
  return { title, cards };
}

function fallbackGenerateCards({ content, cardCount, format, subject, category, grade }) {
  const clean = compactText(content, 12000);
  const sentences = clean
    .split(/(?<=[.!?])\s+|\n+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 40)
    .slice(0, Math.max(cardCount * 2, 8));

  const titleParts = [subject, category, grade].filter(Boolean);
  const title = titleParts.length ? `${titleParts.join(' • ')} Study Set` : 'AI Study Set';
  const cards = [];

  if (format === 'slides') {
    const perSlide = 3;
    const topic = [subject, category].filter(Boolean).join(' ') || 'business strategy';
    const numberSentence = sentences.find((sentence) => /\b\d[\d,.]*%?/.test(sentence));
    const numberMatch = numberSentence ? numberSentence.match(/\b\d[\d,.]*%?/) : null;

    for (let index = 0; index < cardCount; index += 1) {
      const isFirst = index === 0;
      const isLast = index === cardCount - 1 && cardCount > 1;
      const isStat = !isFirst && !isLast && numberMatch && index === 1;
      let layout = 'content';
      if (isFirst) layout = 'title';
      else if (isLast) layout = 'closing';
      else if (isStat) layout = 'stat';

      const bullets = [];
      if (layout === 'content') {
        for (let b = 0; b < perSlide; b += 1) {
          const sentence = sentences[(index * perSlide + b) % Math.max(1, sentences.length)];
          if (sentence) bullets.push(sentence.length > 160 ? `${sentence.slice(0, 157)}...` : sentence);
        }
      }

      const card = {
        id: id('card'),
        front: isFirst ? title : isLast ? 'Key takeaways' : isStat ? 'By the numbers' : `Key points ${index + 1}`,
        back: layout === 'content'
          ? (bullets.join('\n') || 'Add source material to generate stronger slides.')
          : layout === 'title' ? (category || subject || 'A concise, professional overview.') : '',
        type: 'slide',
        layout,
        kicker: isFirst ? (category || 'Overview') : isLast ? 'Summary' : '',
        choices: [],
        answerIndex: -1,
        stat: isStat && numberMatch ? { value: numberMatch[0], label: numberSentence.slice(0, 140) } : null,
        quote: null,
        imageQuery: layout === 'content' || layout === 'title' ? topic : '',
        imageUrl: null,
        imageCredit: null,
        imageCreditUrl: null,
        explanation: 'Generated locally because no AI provider key was configured or the provider call failed.'
      };
      cards.push(card);
    }
    return { title, cards };
  }

  for (let index = 0; index < cardCount; index += 1) {
    const sentence = sentences[index % Math.max(1, sentences.length)] || clean || 'Add source material to generate stronger flashcards.';
    const short = sentence.length > 140 ? `${sentence.slice(0, 137)}...` : sentence;
    const front = format === 'quiz'
      ? `What is the key idea behind: “${short}”?`
      : `Explain this key idea: ${short}`;
    const back = sentence;
    const quizChoices = format === 'quiz'
      ? [
          'The statement captures the main point from the source.',
          'The statement is unrelated to the source.',
          'The statement is a minor formatting note.',
          'The statement is only a date or citation.'
        ]
      : [];
    cards.push({
      id: id('card'),
      front,
      back,
      type: format === 'quiz' ? 'quiz' : 'flashcard',
      choices: quizChoices,
      answerIndex: format === 'quiz' ? 0 : -1,
      explanation: 'Generated locally because no AI provider key was configured or the provider call failed.'
    });
  }
  return { title, cards };
}

function buildGenerationPrompt({ content, cardCount, format, category, grade, subject, notes }) {
  const isSlides = format === 'slides';
  const vars = {
    cardCount,
    category: category || 'General learning',
    grade: grade || 'Not specified',
    subject: subject || 'Not specified',
    format: format || 'mixed',
    notes: notes || (isSlides ? 'Make it clear, credible, and visually compelling.' : 'Make it clear, useful, and exam/interview ready.'),
    material: compactText(content, 15000)
  };

  const baseTemplate = readTextFile(path.join(PROMPTS_DIR, isSlides ? 'slides.md' : 'study-cards.md'));
  let prompt = renderTemplate(baseTemplate, vars);

  const skills = loadSkills(isSlides ? 'SLIDE_SKILLS' : 'CARD_SKILLS', isSlides ? 'action-titles,mece-structure,data-viz' : 'mece-structure');
  if (skills) prompt += `\n\n---\nAdditional house style rules to follow:\n${skills}`;

  const secretSauce = loadSecretSauce();
  if (secretSauce) prompt += `\n\n---\nHouse-specific instructions (always follow these, highest priority):\n${secretSauce}`;

  return prompt;
}

async function callOpenAI(prompt) {
  if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is not configured.');
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'Return strict JSON only. Do not include markdown.' },
        { role: 'user', content: prompt }
      ],
      temperature: 0.3,
      response_format: { type: 'json_object' }
    })
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error?.message || 'OpenAI request failed.');
  return payload.choices?.[0]?.message?.content || '';
}

async function callGemini(prompt) {
  if (!process.env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY is not configured.');
  const model = encodeURIComponent(process.env.GEMINI_MODEL || 'gemini-1.5-flash');
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.3,
        responseMimeType: 'application/json'
      }
    })
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error?.message || 'Gemini request failed.');
  return payload.candidates?.[0]?.content?.parts?.map((part) => part.text || '').join('\n') || '';
}

async function callClaude(prompt) {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is not configured.');
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6',
      max_tokens: 8000,
      system: 'Return strict JSON only. Do not include markdown fences or commentary.',
      messages: [{ role: 'user', content: prompt }]
    })
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error?.message || 'Anthropic request failed.');
  return (payload.content || []).map((part) => part.text || '').join('\n');
}

// The AI provider is controlled by the server operator via .env, never by the
// browser. Set AI_PROVIDER=claude | openai | gemini (aliases: anthropic, google).
// If AI_PROVIDER is unset, the first provider with an API key configured wins.
function resolveProvider() {
  const raw = String(process.env.AI_PROVIDER || '').trim().toLowerCase();
  const aliases = { anthropic: 'claude', claude: 'claude', openai: 'openai', gpt: 'openai', google: 'gemini', gemini: 'gemini' };
  if (aliases[raw]) return aliases[raw];
  if (raw) console.warn(`[ai] Unknown AI_PROVIDER "${raw}" — falling back to auto-detection.`);
  if (process.env.ANTHROPIC_API_KEY) return 'claude';
  if (process.env.OPENAI_API_KEY) return 'openai';
  if (process.env.GEMINI_API_KEY) return 'gemini';
  return 'claude';
}

async function generateWithProvider(options) {
  const prompt = buildGenerationPrompt(options);
  const provider = resolveProvider();
  try {
    let text;
    if (provider === 'gemini') text = await callGemini(prompt);
    else if (provider === 'openai') text = await callOpenAI(prompt);
    else text = await callClaude(prompt);
    return await normalizeGeneratedSet(safeJsonFromText(text), options.cardCount, options.format);
  } catch (error) {
    console.warn(`${provider} generation failed; using local fallback:`, error.message);
    const fallback = fallbackGenerateCards(options);
    if (options.format === 'slides') await attachSlideImages(fallback.cards);
    return fallback;
  }
}

async function extractUploadText(file) {
  if (!file) throw new Error('No file uploaded.');
  const ext = path.extname(file.originalname || '').toLowerCase();
  const mime = file.mimetype || '';
  if (ext === '.pdf' || mime.includes('pdf')) {
    const parsed = await pdfParse(file.buffer);
    return compactText(parsed.text, 50000);
  }
  if (ext === '.docx' || mime.includes('wordprocessingml')) {
    const parsed = await mammoth.extractRawText({ buffer: file.buffer });
    return compactText(parsed.value, 50000);
  }
  return compactText(file.buffer.toString('utf8'), 50000);
}

function upsertGoogleUser(profile) {
  const store = readStore();
  const email = normalizeEmail(profile.email);
  let user = store.users.find((candidate) => candidate.email === email);
  if (!user) {
    user = {
      id: id('usr'),
      email,
      firstName: profile.given_name || profile.name?.split(' ')[0] || '',
      lastName: profile.family_name || '',
      passwordHash: null,
      provider: 'google',
      plan: 'free',
      subscriptionStatus: 'free',
      createdAt: nowIso(),
      updatedAt: nowIso()
    };
    store.users.push(user);
  } else {
    user.firstName ||= profile.given_name || '';
    user.lastName ||= profile.family_name || '';
    user.provider = user.provider || 'google';
    user.updatedAt = nowIso();
  }
  writeStore(store);
  return user;
}

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

app.post('/api/billing/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!stripe || !process.env.STRIPE_WEBHOOK_SECRET) {
    return res.status(400).send('Stripe is not configured.');
  }
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET);
  } catch (error) {
    return res.status(400).send(`Webhook signature failed: ${error.message}`);
  }

  const store = readStore();
  const updateUserPlan = (userId, patch) => {
    const user = store.users.find((candidate) => candidate.id === userId);
    if (user) Object.assign(user, patch, { updatedAt: nowIso() });
  };

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const userId = session.metadata?.userId;
    const plan = session.metadata?.plan;
    if (userId && PLAN_LIMITS[plan]) {
      updateUserPlan(userId, {
        plan,
        subscriptionStatus: 'active',
        stripeCustomerId: session.customer,
        stripeSubscriptionId: session.subscription
      });
    }
  }

  if (event.type === 'customer.subscription.updated' || event.type === 'customer.subscription.created') {
    const subscription = event.data.object;
    const userId = subscription.metadata?.userId || store.users.find((user) => user.stripeCustomerId === subscription.customer)?.id;
    const priceId = subscription.items?.data?.[0]?.price?.id;
    const plan = STRIPE_PRICE_TO_PLAN[priceId] || subscription.metadata?.plan;
    if (userId && PLAN_LIMITS[plan]) {
      updateUserPlan(userId, {
        plan,
        subscriptionStatus: subscription.status,
        stripeCustomerId: subscription.customer,
        stripeSubscriptionId: subscription.id
      });
    }
  }

  if (event.type === 'customer.subscription.deleted') {
    const subscription = event.data.object;
    const userId = subscription.metadata?.userId || store.users.find((user) => user.stripeSubscriptionId === subscription.id)?.id;
    if (userId) {
      updateUserPlan(userId, { plan: 'free', subscriptionStatus: 'canceled', stripeSubscriptionId: null });
    }
  }

  store.events.push({ id: id('evt'), type: event.type, receivedAt: nowIso() });
  writeStore(store);
  return res.json({ received: true });
});

app.use(express.json({ limit: '2mb' }));
app.use(express.static(PUBLIC_DIR));

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', app: 'athena-flashcards', time: nowIso() });
});

app.get('/api/me', (req, res) => {
  const user = getCurrentUser(req);
  if (!user) return res.json({ user: null });
  const usage = canCreateSet(user);
  return res.json({ user: publicUser(user), usage });
});

app.post('/api/auth/register', (req, res) => {
  const email = normalizeEmail(req.body.email);
  const password = String(req.body.password || '');
  const firstName = String(req.body.firstName || '').trim();
  const lastName = String(req.body.lastName || '').trim();
  if (!email || !email.includes('@')) return res.status(400).json({ error: 'Enter a valid email address.' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  if (!/\d/.test(password)) return res.status(400).json({ error: 'Password must include at least one number.' });

  const store = readStore();
  if (store.users.some((user) => user.email === email)) return res.status(409).json({ error: 'An account already exists for this email.' });
  const user = {
    id: id('usr'),
    email,
    firstName,
    lastName,
    passwordHash: hashPassword(password),
    provider: 'email',
    plan: 'free',
    subscriptionStatus: 'free',
    createdAt: nowIso(),
    updatedAt: nowIso()
  };
  store.users.push(user);
  writeStore(store);
  createSession(res, user.id);
  res.json({ user: publicUser(user) });
});

app.post('/api/auth/login', (req, res) => {
  const email = normalizeEmail(req.body.email);
  const password = String(req.body.password || '');
  const store = readStore();
  const user = store.users.find((candidate) => candidate.email === email);
  if (!user || !user.passwordHash || !verifyPassword(password, user.passwordHash)) {
    return res.status(401).json({ error: 'Invalid email or password.' });
  }
  createSession(res, user.id);
  res.json({ user: publicUser(user) });
});

app.post('/api/auth/logout', (req, res) => {
  const token = parseCookies(req)[COOKIE_NAME];
  if (token) {
    const store = readStore();
    store.sessions = store.sessions.filter((session) => session.token !== token);
    writeStore(store);
  }
  clearCookie(res, COOKIE_NAME);
  res.json({ ok: true });
});

app.get('/auth/google', (req, res) => {
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
    return res.status(400).send('Google OAuth is not configured yet. Use email/password sign up or set Google OAuth environment variables.');
  }
  const state = crypto.createHmac('sha256', SESSION_SECRET).update(crypto.randomBytes(16)).digest('hex');
  setCookie(res, 'athena_google_state', state, { maxAge: 1000 * 60 * 10, secure: NODE_ENV === 'production' });
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: `${APP_BASE_URL}/auth/google/callback`,
    response_type: 'code',
    scope: 'openid email profile',
    state,
    prompt: 'select_account'
  });
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`);
});

app.get('/auth/google/callback', async (req, res) => {
  try {
    const expectedState = parseCookies(req).athena_google_state;
    if (!expectedState || expectedState !== req.query.state) throw new Error('Invalid OAuth state.');
    const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        code: req.query.code,
        grant_type: 'authorization_code',
        redirect_uri: `${APP_BASE_URL}/auth/google/callback`
      })
    });
    const tokenPayload = await tokenResponse.json();
    if (!tokenResponse.ok) throw new Error(tokenPayload.error_description || 'Google token exchange failed.');
    const profileResponse = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: `Bearer ${tokenPayload.access_token}` }
    });
    const profile = await profileResponse.json();
    if (!profileResponse.ok || !profile.email) throw new Error('Could not read Google profile.');
    const user = upsertGoogleUser(profile);
    createSession(res, user.id);
    res.redirect('/app?signedIn=google');
  } catch (error) {
    res.redirect(`/?googleError=${encodeURIComponent(error.message)}`);
  }
});

app.post('/api/extract', requireUser, upload.single('document'), async (req, res) => {
  try {
    const text = await extractUploadText(req.file);
    res.json({ text, characters: text.length, filename: req.file.originalname });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/generate', requireUser, async (req, res) => {
  const usage = canCreateSet(req.user);
  if (!usage.ok) {
    return res.status(429).json({ error: `Daily limit reached for your ${publicUser(req.user).planLabel} plan. Upgrade or try again tomorrow.`, usage });
  }

  const cardCount = Math.max(1, Math.min(60, Number(req.body.cardCount || 10)));
  const format = ['flashcard', 'quiz', 'mixed', 'slides'].includes(req.body.format) ? req.body.format : 'mixed';
  const content = compactText(req.body.content || '', 50000);
  if (content.length < 20) return res.status(400).json({ error: 'Add more source content before generating cards.' });

  try {
    const generated = await generateWithProvider({
      content,
      cardCount,
      format,
      category: req.body.category,
      grade: req.body.grade,
      subject: req.body.subject,
      notes: req.body.notes
    });

    const store = readStore();
    const studySet = {
      id: id('set'),
      ownerId: req.user.id,
      ownerEmail: req.user.email,
      title: generated.title,
      sourceType: req.body.sourceType || 'content',
      category: String(req.body.category || '').trim(),
      subject: String(req.body.subject || '').trim(),
      grade: String(req.body.grade || '').trim(),
      format,
      invitedEmails: [],
      cards: generated.cards,
      createdAt: nowIso(),
      updatedAt: nowIso()
    };
    store.quizlets.push(studySet); // store key kept as "quizlets" for backward compatibility with existing data
    writeStore(store);
    res.json({ set: studySet, quizlet: studySet, usage: canCreateSet(req.user) });
  } catch (error) {
    console.error('Generation error:', error);
    res.status(500).json({ error: error.message || 'Could not generate the study set.' });
  }
});

// Study set routes. Canonical paths are /api/sets; /api/quizlets is kept as a
// compatibility alias for older cached clients.
const listSets = (req, res) => {
  const store = readStore();
  const my = store.quizlets
    .filter((set) => set.ownerId === req.user.id)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const shared = store.quizlets
    .filter((set) => set.ownerId !== req.user.id && userCanReadQuizlet(req.user, set))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  res.json({ my, shared });
};

const getSet = (req, res) => {
  const store = readStore();
  const set = store.quizlets.find((candidate) => candidate.id === req.params.id);
  if (!userCanReadQuizlet(req.user, set)) return res.status(404).json({ error: 'Study set not found.' });
  res.json({ set, quizlet: set });
};

const deleteSet = (req, res) => {
  const store = readStore();
  const set = store.quizlets.find((candidate) => candidate.id === req.params.id);
  if (!set || set.ownerId !== req.user.id) return res.status(404).json({ error: 'Study set not found.' });
  store.quizlets = store.quizlets.filter((candidate) => candidate.id !== req.params.id);
  writeStore(store);
  res.json({ ok: true });
};

const shareSet = (req, res) => {
  const store = readStore();
  const set = store.quizlets.find((candidate) => candidate.id === req.params.id);
  if (!set || set.ownerId !== req.user.id) return res.status(404).json({ error: 'Study set not found.' });
  const plan = req.user.plan || 'free';
  const seatLimit = PLAN_LIMITS[plan]?.shareSeats || 0;
  if (seatLimit < 1) return res.status(403).json({ error: 'Sharing requires the Teams plan.' });

  const incoming = Array.isArray(req.body.emails) ? req.body.emails : String(req.body.emails || '').split(/[\s,;]+/);
  const emails = incoming.map(normalizeEmail).filter((email) => email && email.includes('@'));
  const unique = Array.from(new Set([...(set.invitedEmails || []).map(normalizeEmail), ...emails]));
  if (unique.length > seatLimit) return res.status(400).json({ error: `Team sharing is limited to ${seatLimit} invited users.` });
  set.invitedEmails = unique;
  set.updatedAt = nowIso();
  writeStore(store);
  res.json({ set, quizlet: set });
};

app.get(['/api/sets', '/api/quizlets'], requireUser, listSets);
app.get(['/api/sets/:id', '/api/quizlets/:id'], requireUser, getSet);
app.delete(['/api/sets/:id', '/api/quizlets/:id'], requireUser, deleteSet);
app.post(['/api/sets/:id/share', '/api/quizlets/:id/share'], requireUser, shareSet);

app.post('/api/billing/checkout', requireUser, async (req, res) => {
  if (!stripe) return res.status(400).json({ error: 'Stripe is not configured yet.' });
  const plan = String(req.body.plan || '').toLowerCase();
  const priceByPlan = {
    starter: process.env.STRIPE_PRICE_STARTER,
    team: process.env.STRIPE_PRICE_TEAM
  };
  const price = priceByPlan[plan];
  if (!price || !PLAN_LIMITS[plan]) return res.status(400).json({ error: 'Invalid or unconfigured plan.' });

  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    customer_email: req.user.email,
    line_items: [{ price, quantity: 1 }],
    success_url: `${APP_BASE_URL}/app?billing=success`,
    cancel_url: `${APP_BASE_URL}/app?billing=cancelled`,
    metadata: { userId: req.user.id, plan },
    subscription_data: { metadata: { userId: req.user.id, plan } },
    allow_promotion_codes: true
  });
  res.json({ url: session.url });
});

function requirePageUser(req, res, next) {
  if (!getCurrentUser(req)) return res.redirect('/?login=1');
  next();
}

app.get('/app', requirePageUser, (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'app.html'));
});

app.get('/library', requirePageUser, (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'library.html'));
});

app.get('*', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

app.listen(PORT, () => {
  ensureStore();
  console.log(`Athena Flashcards running on ${PORT}`);
});
