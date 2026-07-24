/**
 * PUBLIC application submit — the marketing site's loan application POSTs here
 * DIRECTLY (no more .eml drafts / mail-client hand-offs). It reuses the exact
 * same intake core as the key-gated /api/intake (routes/intake.js siteIntake):
 * real borrower + real application file, checklist auto-generated, officer
 * routed, ClickUp task created, notifications sent — all server-side.
 *
 *   POST /api/apply          { ...intake fields..., formToken }  → 201 + account offer
 *   POST /api/apply/account  { token, password }                 → 202 verifyRequired
 *
 * Because this endpoint creates REAL files (not just lead rows), it is
 * bot-defended harder than /api/leads: the shared HMAC form token is REQUIRED
 * (proof the sender loaded the page + human dwell), plus the honeypot field,
 * an in-route hourly per-IP cap, and the server.js per-minute rate bucket.
 *
 * The account step: the submitter is offered a login right after submitting.
 * A borrower row CREATED BY THIS VERY SUBMISSION returns a short-lived signed
 * account token; POST /account with it + a password creates the credentials
 * and sends the standard verify-email (same one-click activation as
 * /auth/borrower/register — no session until the email is proven, so a bot
 * submitting someone else's email can never take the account over). A
 * PRE-EXISTING record never gets a token here — the response says whether to
 * log in (mode 'login') or go through the email-claim register flow ('claim'),
 * exactly the anti-takeover paths /auth already enforces.
 */
const express = require('express');
const router = require('../lib/safe-router')();
const crypto = require('crypto');
const db = require('../db');
const cfg = require('../config');
const C = require('../lib/crypto');
const mail = require('../lib/email/catalog');
const formToken = require('../lib/form-token');
const { siteIntake } = require('./intake');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// In-route hourly cap on top of the per-minute bucket in server.js — this
// endpoint creates real borrower/application rows + a ClickUp task per hit.
const HITS = new Map();
const WINDOW_MS = 60 * 60 * 1000, MAX_PER_WINDOW = 10;
function rateLimited(ip) {
  const now = Date.now();
  const arr = (HITS.get(ip) || []).filter(t => now - t < WINDOW_MS);
  arr.push(now);
  HITS.set(ip, arr);
  if (HITS.size > 5000) for (const [k, v] of HITS) if (!v.some(t => now - t < WINDOW_MS)) HITS.delete(k);
  return arr.length > MAX_PER_WINDOW;
}

// Short-lived signed proof that THIS submission just created THIS borrower row —
// the only thing that unlocks the immediate create-a-password step.
const ACCT_TTL_MS = 30 * 60 * 1000;
function signAccountToken(borrowerId, email, ts) {
  const t = ts || Date.now();
  const sig = crypto.createHmac('sha256', String(cfg.jwtSecret || 'dev'))
    .update(`applyacct|${borrowerId}|${String(email).toLowerCase().trim()}|${t}`)
    .digest('hex').slice(0, 40);
  return `${borrowerId}.${t}.${sig}`;
}
function parseAccountToken(token) {
  const m = /^([0-9a-f-]{36})\.(\d{10,16})\.([0-9a-f]{40})$/.exec(String(token || ''));
  if (!m) return null;
  return { borrowerId: m[1], ts: Number(m[2]) };
}

router.post('/', async (req, res) => {
  const p = req.body || {};
  const email = String(p.email || p.b1Email || '').trim();
  // Bot drops answer a FAKE 201 (never teach the bot what tripped) — same #153
  // discipline as /api/leads; a real visitor is never on these paths.
  const drop = (reason) => {
    const masked = email ? email.replace(/^(.).*?(@.*)$/, '$1***$2') : '';
    console.warn(`[apply] dropped from ${req.ip} (${reason})${masked ? ' email=' + masked : ''}`);
    return res.status(201).json({ ok: true, account: { mode: 'review' } });
  };
  if (p.website) return drop('honeypot');
  if (!email || !EMAIL_RE.test(email)) return res.status(400).json({ error: 'a valid borrower email is required' });
  // REQUIRED human token — the application page fetches it on load, so by
  // submit time it is minutes old. A blind bot replay never fetched one.
  if (!formToken.formTokenOk(p.formToken)) return drop('missing/invalid form token');
  if (rateLimited(req.ip)) return res.status(429).json({ error: 'too many submissions — please try again later' });

  try {
    const out = await siteIntake(p, { source: 'website_form' });
    // Decide the account offer BEFORE responding, from what the intake learned:
    //   create → fresh row born from this submission: hand back the signed token
    //   login  → this email already has a PILOT login
    //   claim  → a record exists but has no login: /auth/borrower/register sends
    //            the email-ownership claim link (anti-takeover)
    //   review → shared-email/different-name case: humans review; no self-serve
    let account;
    if (out.dup) account = { mode: 'review' };
    else if (out.borrowerExisted && out.hasAuth) account = { mode: 'login' };
    else if (out.borrowerExisted) account = { mode: 'claim' };
    else account = { mode: 'create', token: signAccountToken(out.borrowerId, email) };
    res.status(201).json({ ok: true, applicationId: out.applicationId, assigned: out.assigned, account });
    out.followUp().catch((e) => console.error('[apply] post-commit follow-up failed:', db.describeError(e)));
  } catch (e) {
    console.error('[apply] failed:', db.describeError(e));
    if (!res.headersSent) res.status(500).json({ error: 'could not save the application — please try again' });
  }
});

/* Create the login right after the application (the "create username +
 * password" prompt). Mirrors /auth/borrower/register's fresh path exactly:
 * credentials now, session only after the one-click email verification. */
router.post('/account', async (req, res) => {
  const { token, password } = req.body || {};
  const parsed = parseAccountToken(token);
  if (!parsed) return res.status(400).json({ error: 'invalid or expired link — log in or register from the portal' });
  const age = Date.now() - parsed.ts;
  if (!(age >= 0 && age <= ACCT_TTL_MS)) return res.status(400).json({ error: 'this sign-up window has expired — register from the portal' });
  const b = (await db.query(`SELECT id, email, first_name, last_name FROM borrowers WHERE id=$1`, [parsed.borrowerId])).rows[0];
  if (!b || /@clickup\.local$/i.test(String(b.email || ''))) {
    return res.status(400).json({ error: 'invalid or expired link — log in or register from the portal' });
  }
  {
    // Constant-time compare (matches the intake-key verifier style).
    const h = (s) => crypto.createHash('sha256').update(String(s), 'utf8').digest();
    if (!crypto.timingSafeEqual(h(signAccountToken(b.id, b.email, parsed.ts)), h(String(token)))) {
      return res.status(400).json({ error: 'invalid or expired link — log in or register from the portal' });
    }
  }
  if (!password) return res.status(400).json({ error: 'password required' });
  { const w = C.passwordProblem(password, [b.email, b.first_name, b.last_name]); if (w) return res.status(400).json({ error: w }); }
  try {
    await db.query(
      `INSERT INTO borrower_auth (borrower_id,password_hash,token_version) VALUES ($1,$2,0)`,
      [b.id, await C.hashPassword(password)]);
  } catch (e) {
    if (e && e.code === '23505') return res.status(409).json({ error: 'account exists — log in' });
    throw e;
  }
  // Welcome + one-click email verification (best-effort; the security guarantee
  // is that no session exists until /verify proves the inbox).
  try {
    const auth = require('../auth');
    const { token: vtok } = await auth.issueEmailToken({
      borrowerId: b.id, email: b.email, kind: 'verify', ttlMin: 10080, withToken: true, withCode: false });
    await mail.send('welcome', b.email, {
      firstName: b.first_name && b.first_name !== 'Unknown' ? b.first_name : '',
      verifyUrl: mail.link('/verify?token=' + vtok) });
  } catch (mailErr) { console.error('[apply] welcome email failed:', mailErr.message); }
  res.status(202).json({ verifyRequired: true,
    message: 'Check your email to activate your account, then you’re in.' });
});

module.exports = router;
