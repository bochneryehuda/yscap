/* =====================================================================
   YS CAPITAL — TRANSACTIONAL EMAIL CATALOG
   One builder per message type. Each returns { subject, html, text } from the
   branded renderer (template.js). Copy is institutional/business-purpose —
   direct, operational, no consumer-mortgage warmth — and every auth message
   carries a security notice, an expiry, and a single clear action.

   Design principles (grounded in transactional-email best practice):
     · subject lines are specific and front-loaded, no clever phrasing
     · one primary action per email; secondary detail sits below it
     · reset / verify / code emails always state expiry + "if this wasn't you"
     · the renderer supplies NMLS #2609746 + business-purpose disclaimer footer

   Usage:
     const mail = require('./catalog');
     await mail.send('welcome', 'borrower@x.com', { firstName, verifyUrl, code });
   ===================================================================== */
'use strict';

const provider = require('./index');          // active email provider (.sendMail)
const { render } = require('./template');
const cfg = require('../../config');

/* Absolute portal URL for a hash-route path, e.g. link('/verify?token=abc') ->
   https://host/portal/#/verify?token=abc . The SPA lives under cfg.portalPath
   ('/portal') with a HashRouter, so the path MUST be included or the link opens
   the marketing site instead of the portal. Absolute URLs pass through. */
function link(path) {
  const base = (cfg.appUrl || '').replace(/\/+$/, '');
  const portal = (cfg.portalPath || '/portal').replace(/\/+$/, '');
  let p = String(path || '');
  if (/^https?:/i.test(p)) return p;
  p = p.replace(/^\/#/, '');                 // tolerate a pre-hashed input
  if (!p.startsWith('/')) p = '/' + p;
  return base + portal + '/#' + p;
}

const ROLE_LABEL = {
  admin: 'Administrator',
  loan_officer: 'Loan Officer',
  processor: 'Processor',
  underwriter: 'Underwriter',
};
const greet = (n) => (n && String(n).trim() ? String(n).trim() + ',' : '');

/* =====================================================================
   BORROWER — ONBOARDING & IDENTITY
   ===================================================================== */

/** Sent immediately on registration. Establishes the relationship and asks
 *  the borrower to confirm their email in the same message. */
function welcome({ firstName, verifyUrl, code } = {}) {
  return render({
    audience: 'borrower',
    title: 'Your borrower portal is active',
    preheader: 'Confirm your email to activate secure access to your loan files.',
    greeting: greet(firstName),
    intro: 'Your YS Capital Group borrower portal has been set up. This is your secure workspace for every loan request you place with us.',
    lines: [
      'From the portal you can submit new loan requests, track each file through underwriting to funding, upload conditions, and manage the entities and documents tied to your deals.',
      'To activate access, confirm your email address below. This code expires in 24 hours.',
    ],
    code: code || '',
    cta: verifyUrl ? { label: 'Confirm email address', url: verifyUrl } : null,
    note: 'If you did not create this account, disregard this message and no action will be taken.',
  });
}

/** Standalone email-confirmation message (resend path). */
function verifyEmail({ firstName, verifyUrl, code } = {}) {
  return render({
    audience: 'borrower',
    title: 'Confirm your email address',
    preheader: 'Enter this code, or use the button, to verify your portal email.',
    greeting: greet(firstName),
    intro: 'Please confirm the email address on file for your YS Capital Group portal account.',
    lines: ['Enter this verification code in the portal. It expires in 24 hours.'],
    code: code || '',
    cta: verifyUrl ? { label: 'Confirm email address', url: verifyUrl } : null,
    note: 'If you did not request this, you can safely ignore it.',
  });
}

/** Email one-time passcode — infrastructure for a future email-based 2FA
 *  path (TOTP authenticator remains the live second factor today). */
function loginCode({ firstName, code, minutes = 10 } = {}) {
  return render({
    audience: 'borrower',
    title: 'Your sign-in verification code',
    preheader: 'Use this one-time code to complete your portal sign-in.',
    greeting: greet(firstName),
    intro: 'Use the following one-time code to complete your sign-in.',
    lines: ['This code expires in ' + minutes + ' minutes and can be used once.'],
    code: code || '',
    note: 'If you did not attempt to sign in, do not share this code — contact us immediately at ' + require('./template').COMPANY.phone + '.',
  });
}

/* =====================================================================
   BORROWER — CREDENTIALS & SECURITY
   ===================================================================== */

function passwordReset({ firstName, resetUrl, minutes = 60 } = {}) {
  return render({
    audience: 'borrower',
    title: 'Reset your portal password',
    preheader: 'A password reset was requested for your account.',
    greeting: greet(firstName),
    intro: 'We received a request to reset the password on your YS Capital Group portal account.',
    lines: ['Use the button below to set a new password. This link expires in ' + minutes + ' minutes and can be used once.'],
    cta: resetUrl ? { label: 'Reset password', url: resetUrl } : null,
    note: 'If you did not request this, no action is required — your password remains unchanged.',
  });
}

function passwordChanged({ firstName } = {}) {
  return render({
    audience: 'borrower',
    title: 'Your portal password was changed',
    preheader: 'Confirmation that your account password was updated.',
    greeting: greet(firstName),
    intro: 'The password on your YS Capital Group portal account was just changed, and all other active sessions were signed out.',
    note: 'If you did not make this change, contact us immediately at ' + require('./template').COMPANY.phone + ' so we can secure your account.',
  });
}

function mfaEnabled({ firstName } = {}) {
  return render({
    audience: 'borrower',
    title: 'Two-factor authentication enabled',
    preheader: 'Your account now requires an authenticator code at sign-in.',
    greeting: greet(firstName),
    intro: 'Two-factor authentication is now active on your YS Capital Group portal account.',
    lines: ['Going forward, each sign-in will require the current six-digit code from your authenticator app in addition to your password.'],
    note: 'If you did not enable this, contact us immediately at ' + require('./template').COMPANY.phone + '.',
  });
}

function newSignIn({ firstName, when, ip } = {}) {
  const meta = [];
  if (when) meta.push({ label: 'When', value: when });
  if (ip) meta.push({ label: 'IP address', value: ip });
  return render({
    audience: 'borrower',
    title: 'New sign-in to your portal',
    preheader: 'A new sign-in was recorded on your account.',
    greeting: greet(firstName),
    intro: 'A new sign-in to your YS Capital Group portal account was just recorded.',
    meta,
    note: 'If this was you, no action is needed. If not, reset your password immediately and contact us at ' + require('./template').COMPANY.phone + '.',
  });
}

/* =====================================================================
   STAFF — TEAM ONBOARDING
   ===================================================================== */

function staffInvite({ fullName, role, acceptUrl, inviter, days = 7 } = {}) {
  const roleLabel = ROLE_LABEL[role] || 'team member';
  const meta = [{ label: 'Role', value: roleLabel }];
  if (inviter) meta.push({ label: 'Invited by', value: inviter });
  return render({
    audience: 'staff',
    title: 'Your YS Capital team invitation',
    preheader: 'Set up your account to access the origination console.',
    greeting: greet(fullName),
    intro: 'You have been invited to join the YS Capital Group origination console as a ' + roleLabel + '.',
    lines: ['Set up your account below to begin receiving and working loan files. This invitation expires in ' + days + ' days.'],
    meta,
    cta: acceptUrl ? { label: 'Set up your account', url: acceptUrl } : null,
    note: 'If you were not expecting this invitation, you can disregard it.',
  });
}

/* =====================================================================
   DELIVERY (never throws — a failed send must not break the request)
   ===================================================================== */

const builders = {
  welcome, verifyEmail, loginCode,
  passwordReset, passwordChanged, mfaEnabled, newSignIn,
  staffInvite,
};

/** Deliver an already-rendered { subject, html, text } to one/many recipients. */
async function deliver(built, to) {
  if (!built) return { ok: false, error: 'no email built' };
  try {
    const r = await provider.sendMail({ to, subject: built.subject, html: built.html, text: built.text });
    if (r && r.skipped) console.log('[email] provider=none, skipped:', built.subject, '->', to);
    return { ok: !!(r && r.ok), id: r && r.id, skipped: r && r.skipped };
  } catch (e) {
    console.error('[email] send failed:', built.subject, '->', to, '::', e.message);
    return { ok: false, error: e.message };
  }
}

/** Build by name + deliver in one call. Returns {ok,...}; never rejects. */
async function send(kind, to, args) {
  const b = builders[kind];
  if (!b) { console.error('[email] unknown template:', kind); return { ok: false, error: 'unknown template ' + kind }; }
  return deliver(b(args || {}), to);
}

module.exports = Object.assign({}, builders, { deliver, send, link, ROLE_LABEL });
