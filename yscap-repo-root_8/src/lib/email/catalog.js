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

/** Confirmation to a website visitor who submitted a tool (application, rehab
 *  budget, term-sheet request, …). Sent from the server, not the browser. */
function leadReceived({ firstName, toolLabel, officerName } = {}) {
  const tool = toolLabel || 'request';
  return render({
    audience: 'borrower',
    title: 'We received your ' + tool.toLowerCase(),
    preheader: 'Your submission reached the YS Capital Group team.',
    greeting: greet(firstName),
    intro: 'Thank you — your ' + tool.toLowerCase() + ' has been received by YS Capital Group.',
    lines: [
      officerName
        ? officerName + ' will review it and follow up with you shortly to walk through next steps.'
        : 'A member of our loan team will review it and follow up with you shortly to walk through next steps.',
      'If you need anything in the meantime, just reply to this email or call us.',
    ],
    note: 'You are receiving this because you submitted a request on yscapgroup.com.',
  });
}

/** Invitation sent to a co-borrower named on an application: set up portal
 *  access (or just sign in, if they already have an account) to follow the
 *  loan file alongside the primary borrower. */
function coBorrowerInvite({ firstName, primaryName, acceptUrl, hasAccount } = {}) {
  return render({
    audience: 'borrower',
    title: 'You have been added to a loan application',
    preheader: 'Set up portal access to follow the file with ' + (primaryName || 'your co-borrower') + '.',
    greeting: greet(firstName),
    intro: (primaryName || 'Your co-borrower') + ' has named you as a co-borrower on a YS Capital Group loan application.',
    lines: [
      hasAccount
        ? 'Your existing portal account now has access to this loan file — sign in to review the application, upload documents, and follow every milestone.'
        : 'Set up your portal access below to review the application, upload your documents, and follow every milestone through closing. This invitation expires in 14 days.',
    ],
    cta: acceptUrl ? { label: hasAccount ? 'Sign in to the portal' : 'Set up your access', url: acceptUrl } : null,
    note: 'If you were not expecting this, you can disregard it and no access will be created.',
  });
}

/** Invitation to the borrower on a staff-originated loan file: their loan team
 *  has already opened the file — set up portal access (or sign in) to follow it,
 *  upload documents, and message the team. */
function borrowerInvite({ firstName, propertyLabel, loanNumber, inviter, acceptUrl, hasAccount } = {}) {
  const meta = [];
  if (propertyLabel) meta.push({ label: 'Property', value: propertyLabel });
  if (loanNumber) meta.push({ label: 'Loan #', value: loanNumber });
  return render({
    audience: 'borrower',
    title: 'Your loan file is ready in the portal',
    preheader: 'Set up secure access to follow your loan with YS Capital Group.',
    greeting: greet(firstName),
    intro: (inviter ? inviter + ' at YS Capital Group' : 'Your loan team at YS Capital Group')
      + ' has opened a loan file for you and invited you to the secure borrower portal.',
    lines: [
      hasAccount
        ? 'Your existing portal account already has access to this file — sign in to review it, upload your documents, and message your loan team.'
        : 'Set up your access below to review the file, upload your documents, track every milestone through closing, and message your loan team directly. This invitation expires in 14 days.',
    ],
    meta,
    cta: acceptUrl ? { label: hasAccount ? 'Sign in to the portal' : 'Set up your access', url: acceptUrl } : null,
    note: 'If you were not expecting this, you can disregard it and no access will be created.',
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
    title: 'Your YS Capital Group team invitation',
    preheader: 'Set up your account to access the origination console.',
    greeting: greet(fullName),
    intro: 'You have been invited to join the YS Capital Group origination console as a ' + roleLabel + '.',
    lines: ['Set up your account below to begin receiving and working loan files. This invitation expires in ' + days + ' days.'],
    meta,
    cta: acceptUrl ? { label: 'Set up your account', url: acceptUrl } : null,
    note: 'If you were not expecting this invitation, you can disregard it.',
  });
}

/** Welcome to an already-provisioned staff member: their console is ready.
 *  With a login -> sign-in CTA; without -> a set-up-your-access invite CTA. */
function staffWelcome({ fullName, role, url, hasLogin } = {}) {
  const roleLabel = ROLE_LABEL[role] || 'team member';
  return render({
    audience: 'staff',
    title: 'Your YS Capital Group console is ready',
    preheader: 'Your account on the origination console is set up.',
    greeting: greet(fullName),
    intro: 'Your account on the YS Capital Group origination console is set up as a ' + roleLabel + '.',
    lines: [
      hasLogin
        ? 'Sign in below to see your pipeline, your leads, your files, and your team chat.'
        : 'Set up your password below to activate access to your pipeline, files, and team chat. This link expires in 14 days.',
    ],
    meta: [{ label: 'Role', value: roleLabel }],
    cta: url ? { label: hasLogin ? 'Sign in to the console' : 'Set up your access', url } : null,
    note: 'If you were not expecting this, contact your administrator.',
  });
}

/** A borrower on a FUNDED file requested draw setup. Goes to the draws desk and
 *  the assigned loan team so they can coordinate the construction draw process. */
function drawRequest({ borrowerName, propertyLabel, loanNumber } = {}) {
  const meta = [];
  if (propertyLabel) meta.push({ label: 'Property', value: propertyLabel });
  if (borrowerName) meta.push({ label: 'Borrower', value: borrowerName });
  if (loanNumber) meta.push({ label: 'Loan #', value: loanNumber });
  return render({
    audience: 'staff',
    title: 'Draw setup needed — ' + (propertyLabel || 'funded file'),
    preheader: 'A borrower requested draw setup on a funded file.',
    intro: (borrowerName || 'The borrower') + ' is requesting to set up draws for this funded file. Please coordinate the draw process.',
    meta,
    note: 'Sent to the draws desk and the assigned loan team.',
  });
}

/** Admin-triggered password reset for a staff member: a single set-a-new-password
 *  link to the console (works whether or not they already had a login). */
function staffPasswordReset({ fullName, url, days = 7 } = {}) {
  return render({
    audience: 'staff',
    title: 'Reset your console password',
    preheader: 'Set a new password for the YS Capital Group origination console.',
    greeting: greet(fullName),
    intro: 'A password reset was requested for your YS Capital Group origination console account.',
    lines: ['Use the button below to set a new password. This link expires in ' + days + ' days and can be used once.'],
    cta: url ? { label: 'Set a new password', url } : null,
    note: 'If you did not expect this, contact your administrator — your current password remains unchanged until you set a new one.',
  });
}

/* =====================================================================
   DELIVERY (never throws — a failed send must not break the request)
   ===================================================================== */

const builders = {
  welcome, verifyEmail, loginCode,
  passwordReset, passwordChanged, mfaEnabled, newSignIn,
  staffInvite, staffWelcome, staffPasswordReset, leadReceived, coBorrowerInvite, borrowerInvite, drawRequest,
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
