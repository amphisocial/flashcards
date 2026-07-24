/*
 * SMTP mailer for team invite emails. If SMTP_HOST isn't configured,
 * sendMail resolves with { sent: false, reason: '...' } instead of
 * throwing — team invites still work in-app (the roster entry and join
 * link are created either way), the teacher just won't get automatic
 * email delivery and would need to copy/send the link manually.
 */
const nodemailer = require('nodemailer');

let transporter = null;
let transporterAttempted = false;

function getTransporter() {
  if (transporterAttempted) return transporter;
  transporterAttempted = true;
  if (!process.env.SMTP_HOST) return null;
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: String(process.env.SMTP_SECURE || 'false').toLowerCase() === 'true',
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined
  });
  return transporter;
}

async function sendMail({ to, subject, text, html }) {
  const t = getTransporter();
  if (!t) return { sent: false, reason: 'SMTP is not configured (set SMTP_HOST in .env).' };
  const fromEmail = process.env.SMTP_FROM_EMAIL || process.env.SMTP_USER;
  const fromName = process.env.SMTP_FROM_NAME || 'Athena Flashcards';
  await t.sendMail({ from: `"${fromName}" <${fromEmail}>`, to, subject, text, html });
  return { sent: true };
}

module.exports = { sendMail };
