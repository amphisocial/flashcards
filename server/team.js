/*
 * Athena Team Roster (Teams plan)
 * -----------------------------------------------------------------------
 * A team roster is a persistent, per-teacher list of up to 30 invited
 * emails — the same 30-seat cap the Teams plan has always advertised, just
 * reused as a roster cap instead of a per-item invite cap. Being on a
 * teacher's roster is what grants access to anything that teacher marks
 * "Shared" (flashcard sets, slide decks, quizzes, whiteboards all check
 * this one roster now, rather than each keeping its own separate invite
 * list — see emailOnRoster(), used by server.js and board.js alike).
 *
 * Invite delivery: an email is sent via SMTP (server/mailer.js) with a
 * one-time join link. Clicking it either logs the person straight in (if
 * they already have an account under that exact email — this is a
 * standard "magic link" pattern, equivalent in trust level to a password
 * reset link, since receiving+clicking proves control of the mailbox) or
 * walks them through a one-field "set a password" mini-signup with the
 * email fixed to the invited address. The link is single-use and expires
 * after 14 days; membership itself doesn't expire, only the onboarding
 * link does — after that, the person just logs in normally.
 */

const crypto = require('crypto');

const JOIN_TOKEN_VALID_DAYS = 14;

function normalizeEmailLocal(email) {
  return String(email || '').trim().toLowerCase();
}

// Shared by server.js/board.js for access checks.
function emailOnRoster(store, teacherId, email) {
  const teacher = store.users.find((u) => u.id === teacherId);
  if (!teacher) return false;
  const target = normalizeEmailLocal(email);
  return (teacher.teamRoster || []).some((entry) => normalizeEmailLocal(entry.email) === target);
}

function attachTeamRoutes(app, deps) {
  const {
    requireUser, readStore, writeStore, id, nowIso, normalizeEmail,
    hashPassword, createSession, publicUser, PLAN_LIMITS, sendMail, APP_BASE_URL
  } = deps;

  function requireTeamPlan(req, res) {
    const plan = req.user.plan || 'free';
    const seatLimit = PLAN_LIMITS[plan]?.shareSeats || 0;
    if (seatLimit < 1) {
      res.status(403).json({ error: 'The Team roster is available on the Teams plan. Start a free 7-day Teams trial to try it.' });
      return null;
    }
    return seatLimit;
  }

  app.get('/api/team/roster', requireUser, (req, res) => {
    const seatLimit = requireTeamPlan(req, res);
    if (!seatLimit) return;
    const store = readStore();
    const user = store.users.find((u) => u.id === req.user.id);
    const roster = (user.teamRoster || []).map((entry) => ({
      email: entry.email, invitedAt: entry.invitedAt, status: entry.status
    }));
    res.json({ roster, seatLimit, used: roster.length });
  });

  app.post('/api/team/invite', requireUser, async (req, res) => {
    const seatLimit = requireTeamPlan(req, res);
    if (!seatLimit) return;

    const raw = Array.isArray(req.body.emails) ? req.body.emails : String(req.body.emails || '').split(/[\s,;]+/);
    const incoming = Array.from(new Set(raw.map(normalizeEmail).filter((e) => e && e.includes('@'))));
    if (!incoming.length) return res.status(400).json({ error: 'Enter at least one email address.' });

    const store = readStore();
    const teacher = store.users.find((u) => u.id === req.user.id);
    teacher.teamRoster ||= [];
    const existing = new Set(teacher.teamRoster.map((e) => normalizeEmail(e.email)));
    const room = seatLimit - teacher.teamRoster.length;

    const results = [];
    let added = 0;
    for (const email of incoming) {
      if (existing.has(email)) { results.push({ email, added: false, reason: 'Already on your roster.' }); continue; }
      if (added >= room) { results.push({ email, added: false, reason: `Roster is full (${seatLimit} seats).` }); continue; }

      const token = crypto.randomBytes(24).toString('hex');
      const entry = {
        email,
        invitedAt: nowIso(),
        status: 'invited',
        token,
        tokenExpiresAt: new Date(Date.now() + JOIN_TOKEN_VALID_DAYS * 24 * 60 * 60 * 1000).toISOString(),
        tokenUsedAt: null
      };
      teacher.teamRoster.push(entry);
      existing.add(email);
      added += 1;

      const joinUrl = `${APP_BASE_URL}/join?token=${token}`;
      const teacherName = [teacher.firstName, teacher.lastName].filter(Boolean).join(' ') || teacher.email;
      // eslint-disable-next-line no-await-in-loop
      let emailResult;
      try {
        // eslint-disable-next-line no-await-in-loop
        emailResult = await sendMail({
          to: email,
          subject: `${teacherName} invited you to their Athena Flashcards team`,
          text: `${teacherName} invited you to join their team on Athena Flashcards.\n\nJoin here: ${joinUrl}\n\nThis link works once and expires in ${JOIN_TOKEN_VALID_DAYS} days.`,
          html: `<p><strong>${teacherName}</strong> invited you to join their team on Athena Flashcards.</p><p><a href="${joinUrl}">Click here to join</a></p><p style="color:#888;font-size:0.85em">This link works once and expires in ${JOIN_TOKEN_VALID_DAYS} days.</p>`
        });
      } catch (error) {
        emailResult = { sent: false, reason: error.message };
      }
      results.push({ email, added: true, emailSent: Boolean(emailResult.sent), emailReason: emailResult.reason, joinUrl });
    }

    writeStore(store);
    res.json({ results, seatLimit, used: teacher.teamRoster.length });
  });

  app.delete('/api/team/roster/:email', requireUser, (req, res) => {
    if (!requireTeamPlan(req, res)) return;
    const store = readStore();
    const teacher = store.users.find((u) => u.id === req.user.id);
    const target = normalizeEmail(req.params.email);
    teacher.teamRoster = (teacher.teamRoster || []).filter((entry) => normalizeEmail(entry.email) !== target);
    writeStore(store);
    res.json({ ok: true });
  });

  // ---- Join flow (public, no session required) --------------------------
  function findRosterEntryByToken(store, token) {
    for (const teacher of store.users) {
      const entry = (teacher.teamRoster || []).find((candidate) => candidate.token === token);
      if (entry) return { teacher, entry };
    }
    return null;
  }

  app.post('/api/team/join', (req, res) => {
    const token = String(req.body.token || '');
    const store = readStore();
    const found = findRosterEntryByToken(store, token);
    if (!found) return res.status(404).json({ error: 'This invite link is not valid.' });
    const { teacher, entry } = found;
    if (entry.tokenUsedAt) return res.status(410).json({ error: 'This invite link has already been used. Please log in normally instead.', usedAlready: true });
    if (new Date(entry.tokenExpiresAt) < new Date()) return res.status(410).json({ error: 'This invite link has expired. Ask your teacher to resend the invite.' });

    const teacherName = [teacher.firstName, teacher.lastName].filter(Boolean).join(' ') || teacher.email;
    const account = store.users.find((u) => u.email === entry.email);
    if (!account) {
      return res.json({ needsAccount: true, email: entry.email, teacherName });
    }

    entry.status = 'active';
    entry.tokenUsedAt = nowIso();
    writeStore(store);
    createSession(res, account.id);
    res.json({ needsAccount: false, user: publicUser(account), teacherName });
  });

  app.post('/api/team/join/complete', (req, res) => {
    const token = String(req.body.token || '');
    const password = String(req.body.password || '');
    const firstName = String(req.body.firstName || '').trim();
    const lastName = String(req.body.lastName || '').trim();
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    if (!/\d/.test(password)) return res.status(400).json({ error: 'Password must include at least one number.' });

    const store = readStore();
    const found = findRosterEntryByToken(store, token);
    if (!found) return res.status(404).json({ error: 'This invite link is not valid.' });
    const { teacher, entry } = found;
    if (entry.tokenUsedAt) return res.status(410).json({ error: 'This invite link has already been used. Please log in normally instead.' });
    if (new Date(entry.tokenExpiresAt) < new Date()) return res.status(410).json({ error: 'This invite link has expired. Ask your teacher to resend the invite.' });
    if (store.users.some((u) => u.email === entry.email)) return res.status(409).json({ error: 'An account already exists for this email — please log in instead.' });

    const user = {
      id: id('usr'),
      email: entry.email,
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
    entry.status = 'active';
    entry.tokenUsedAt = nowIso();
    writeStore(store);
    createSession(res, user.id);
    res.json({ user: publicUser(user) });
  });
}

module.exports = { attachTeamRoutes, emailOnRoster };
