/*
 * Athena Flashcards
 * Simple Express app for AI-generated flashcards / quizlet-style study sets.
 * Stores users, sessions, usage, quizlets and share invites in data/store.json.
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const Stripe = require('stripe');

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
  pro: { label: 'Pro', setsPerDay: 20, shareSeats: 0 },
  team: { label: 'Team', setsPerDay: 20, shareSeats: 30 }
};

const STRIPE_PRICE_TO_PLAN = Object.fromEntries(
  [
    [process.env.STRIPE_PRICE_STARTER, 'starter'],
    [process.env.STRIPE_PRICE_PRO, 'pro'],
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

function cleanCard(card, index, format) {
  const front = String(card.front || card.term || card.question || `Card ${index + 1}`).trim();
  const back = String(card.back || card.answer || card.definition || '').trim();
  const choices = Array.isArray(card.choices) ? card.choices.map((choice) => String(choice).trim()).filter(Boolean).slice(0, 5) : [];
  const type = choices.length >= 2 || format === 'quiz' ? 'quiz' : 'flashcard';
  return {
    id: id('card'),
    front: front.slice(0, 500),
    back: back.slice(0, 1200) || 'Review the source material and add your answer here.',
    type,
    choices,
    explanation: String(card.explanation || '').trim().slice(0, 1200)
  };
}

function normalizeGeneratedSet(payload, requestedCount, format) {
  const title = String(payload.title || payload.name || 'AI Study Set').trim().slice(0, 90) || 'AI Study Set';
  const rawCards = Array.isArray(payload.cards) ? payload.cards : [];
  const cards = rawCards
    .slice(0, Math.max(1, Math.min(60, requestedCount)))
    .map((card, index) => cleanCard(card, index, format))
    .filter((card) => card.front && card.back);
  if (!cards.length) throw new Error('No usable cards were generated.');
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
      explanation: 'Generated locally because no AI provider key was configured or the provider call failed.'
    });
  }
  return { title, cards };
}

function buildGenerationPrompt({ content, cardCount, format, category, grade, subject, notes }) {
  return `You are an expert study coach. Create exactly ${cardCount} high-quality study cards from the provided material.

Study goal/category: ${category || 'General learning'}
Grade/level: ${grade || 'Not specified'}
Subject/topic: ${subject || 'Not specified'}
Format preference: ${format || 'mixed'}
Extra instructions: ${notes || 'Make it clear, useful, and exam/interview ready.'}

Rules:
- Return JSON only.
- Use this exact shape: {"title":"...", "cards":[{"front":"...", "back":"...", "type":"flashcard"}, {"front":"...", "back":"...", "type":"quiz", "choices":["...","...","...","..."], "explanation":"..."}]}
- For quiz cards, include 4 concise choices and make the correct answer exactly match the back field.
- Prefer application-oriented questions over trivia.
- Avoid hallucinating facts not supported by the material. If the material is thin, create concept-check cards from what is provided.

Material:
${compactText(content, 15000)}`;
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

async function generateWithProvider(options) {
  const prompt = buildGenerationPrompt(options);
  const provider = options.provider === 'gemini' ? 'gemini' : 'openai';
  try {
    const text = provider === 'gemini' ? await callGemini(prompt) : await callOpenAI(prompt);
    return normalizeGeneratedSet(safeJsonFromText(text), options.cardCount, options.format);
  } catch (error) {
    console.warn(`${provider} generation failed; using local fallback:`, error.message);
    return fallbackGenerateCards(options);
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
    res.redirect('/?signedIn=google');
  } catch (error) {
    res.status(400).send(`Google sign-in failed: ${error.message}`);
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
  const format = ['flashcard', 'quiz', 'mixed'].includes(req.body.format) ? req.body.format : 'mixed';
  const content = compactText(req.body.content || '', 50000);
  if (content.length < 20) return res.status(400).json({ error: 'Add more source content before generating cards.' });

  try {
    const generated = await generateWithProvider({
      content,
      cardCount,
      format,
      provider: req.body.provider,
      category: req.body.category,
      grade: req.body.grade,
      subject: req.body.subject,
      notes: req.body.notes
    });

    const store = readStore();
    const quizlet = {
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
    store.quizlets.push(quizlet);
    writeStore(store);
    res.json({ quizlet, usage: canCreateSet(req.user) });
  } catch (error) {
    console.error('Generation error:', error);
    res.status(500).json({ error: error.message || 'Could not generate flashcards.' });
  }
});

app.get('/api/quizlets', requireUser, (req, res) => {
  const store = readStore();
  const my = store.quizlets
    .filter((quizlet) => quizlet.ownerId === req.user.id)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const shared = store.quizlets
    .filter((quizlet) => quizlet.ownerId !== req.user.id && userCanReadQuizlet(req.user, quizlet))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  res.json({ my, shared });
});

app.get('/api/quizlets/:id', requireUser, (req, res) => {
  const store = readStore();
  const quizlet = store.quizlets.find((candidate) => candidate.id === req.params.id);
  if (!userCanReadQuizlet(req.user, quizlet)) return res.status(404).json({ error: 'Study set not found.' });
  res.json({ quizlet });
});

app.delete('/api/quizlets/:id', requireUser, (req, res) => {
  const store = readStore();
  const quizlet = store.quizlets.find((candidate) => candidate.id === req.params.id);
  if (!quizlet || quizlet.ownerId !== req.user.id) return res.status(404).json({ error: 'Study set not found.' });
  store.quizlets = store.quizlets.filter((candidate) => candidate.id !== req.params.id);
  writeStore(store);
  res.json({ ok: true });
});

app.post('/api/quizlets/:id/share', requireUser, (req, res) => {
  const store = readStore();
  const quizlet = store.quizlets.find((candidate) => candidate.id === req.params.id);
  if (!quizlet || quizlet.ownerId !== req.user.id) return res.status(404).json({ error: 'Study set not found.' });
  const plan = req.user.plan || 'free';
  const seatLimit = PLAN_LIMITS[plan]?.shareSeats || 0;
  if (seatLimit < 1) return res.status(403).json({ error: 'Sharing requires the Team plan.' });

  const incoming = Array.isArray(req.body.emails) ? req.body.emails : String(req.body.emails || '').split(/[\s,;]+/);
  const emails = incoming.map(normalizeEmail).filter((email) => email && email.includes('@'));
  const unique = Array.from(new Set([...(quizlet.invitedEmails || []).map(normalizeEmail), ...emails]));
  if (unique.length > seatLimit) return res.status(400).json({ error: `Team sharing is limited to ${seatLimit} invited users.` });
  quizlet.invitedEmails = unique;
  quizlet.updatedAt = nowIso();
  writeStore(store);
  res.json({ quizlet });
});

app.post('/api/billing/checkout', requireUser, async (req, res) => {
  if (!stripe) return res.status(400).json({ error: 'Stripe is not configured yet.' });
  const plan = String(req.body.plan || '').toLowerCase();
  const priceByPlan = {
    starter: process.env.STRIPE_PRICE_STARTER,
    pro: process.env.STRIPE_PRICE_PRO,
    team: process.env.STRIPE_PRICE_TEAM
  };
  const price = priceByPlan[plan];
  if (!price || !PLAN_LIMITS[plan]) return res.status(400).json({ error: 'Invalid or unconfigured plan.' });

  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    customer_email: req.user.email,
    line_items: [{ price, quantity: 1 }],
    success_url: `${APP_BASE_URL}/?billing=success`,
    cancel_url: `${APP_BASE_URL}/?billing=cancelled`,
    metadata: { userId: req.user.id, plan },
    subscription_data: { metadata: { userId: req.user.id, plan } },
    allow_promotion_codes: true
  });
  res.json({ url: session.url });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

app.listen(PORT, () => {
  ensureStore();
  console.log(`Athena Flashcards running on ${PORT}`);
});
