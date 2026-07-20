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
     await mail.send('welcome', 'borrower@x.com', { firstName, verifyUrl });
   ===================================================================== */
'use strict';

const provider = require('./index');          // active email provider (.sendMail)
const { render } = require('./template');
const cfg = require('../../config');

// Short file identifier for the SUBJECT of a file-scoped catalog email
// ("YS-1042 · 123 Main St"), so an invite / draw / sign email names its file in
// the inbox the same way notify-routed emails do. Concise: loan# + a short
// property, whichever are present.
function fileTag(loanNumber, propertyLabel) {
  const street = propertyLabel ? String(propertyLabel).split(',')[0].trim() : '';
  return [loanNumber, street].filter(Boolean).join(' · ') || loanNumber || street || '';
}
// NOTE: these catalog builders take only TRUSTED structured data — a property
// address, a staff/borrower name, a loan number, or a controlled label — none of
// which ever carries a note-buyer / capital-partner name, so no scrub is applied
// here. (Running the plain scrub over an address/name would WRONGLY mangle a legit
// collision like "12 Churchill Lane" → "…Gold Standard program Lane"; that's why
// the notify chokepoint uses scrubTextExcept with an address protect-list, not a
// blanket scrub.) If a builder ever gains a STAFF-TYPED free-text field, scrub
// THAT field with a protect-list like notifyBorrower does — never blanket-scrub.

/* Absolute portal URL for a hash-route path, e.g. link('/verify?token=abc') ->
   https://host/portal/#/verify?token=abc . The SPA lives under cfg.portalPath
   ('/portal') with a HashRouter, so the path MUST be included or the link opens
   the marketing site instead of the portal. Absolute URLs pass through.

   EXCEPTION — one-time auth links (/reset, /verify, /accept): the token they
   carry cannot ride in the #fragment, because email click-tracking (Resend etc.)
   rewrites the link and drops the fragment, so the token never arrives and the
   page shows "link missing/expired". For those we emit a PLAIN path+query URL
   (https://host/link/<kind>?token=abc) that trackers preserve; the server
   bounces it into the hash route (see the /link/:kind route in server.js). */
const BOUNCE_ROUTES = { '/reset': 'reset', '/verify': 'verify', '/accept': 'accept' };
function link(path) {
  const base = (cfg.appUrl || '').replace(/\/+$/, '');
  let p = String(path || '');
  if (/^https?:/i.test(p)) return p;
  p = p.replace(/^\/#/, '');                 // tolerate a pre-hashed input
  if (!p.startsWith('/')) p = '/' + p;
  const qIdx = p.indexOf('?');
  const routePath = qIdx >= 0 ? p.slice(0, qIdx) : p;
  const kind = BOUNCE_ROUTES[routePath];
  // Token links -> the dedicated tracking-proof bounce kinds (back-compat).
  if (kind) return base + '/link/' + kind + (qIdx >= 0 ? p.slice(qIdx) : '');
  // ROOT FIX (owner-reported broken notification links, 2026-07-14): the
  // fragment-drop problem was never only about token links — click-tracking
  // rewrites EVERY link in EVERY email and drops the #fragment, so every
  // "See the message" / "Open the loan file" CTA landed on the bare portal
  // instead of its deep route. ALL portal links in email are now plain
  // path+query bounce URLs (/link/r?to=<route>) that trackers preserve; the
  // server 302s them into /portal/#<route> (never an open redirect — the
  // destination is always our own portal hash route).
  return base + '/link/r?to=' + encodeURIComponent(p);
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
function welcome({ firstName, verifyUrl } = {}) {
  return render({
    audience: 'borrower',
    title: 'Your borrower portal is active',
    preheader: 'Tap once to activate secure access to your loan files.',
    greeting: greet(firstName),
    intro: 'Your YS Capital Group borrower portal has been set up. This is your secure workspace for every loan request you place with us.',
    lines: [
      'From the portal you can submit new loan requests, track each file through underwriting to funding, upload conditions, and manage the entities and documents tied to your deals.',
      // #94: one-click activation — no code to type. The button verifies your
      // email and signs you in. The link is valid for 7 days.
      'Tap the button below to activate your account — that’s it. The link is valid for 7 days.',
    ],
    cta: verifyUrl ? { label: 'Activate my account', url: verifyUrl } : null,
    badge: { text: 'Portal ready', tone: 'positive' },
    replyable: true,
    note: 'If you did not create this account, disregard this message and no action will be taken.',
  });
}

/** Standalone email-confirmation message (resend path). */
function verifyEmail({ firstName, verifyUrl } = {}) {
  return render({
    audience: 'borrower',
    title: 'Confirm your email address',
    preheader: 'Tap once to verify your portal email.',
    greeting: greet(firstName),
    intro: 'Please confirm the email address on file for your YS Capital Group portal account.',
    lines: ['Tap the button below to confirm your email — no code to enter. The link is valid for 7 days.'],
    cta: verifyUrl ? { label: 'Confirm email address', url: verifyUrl } : null,
    badge: { text: 'Confirm email', tone: 'gold' },
    replyable: true,
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
    badge: { text: 'Received', tone: 'positive' },
    replyable: true,
    note: 'You are receiving this because you submitted a request on yscapgroup.com.',
  });
}

/** Invitation sent to a co-borrower named on an application: set up portal
 *  access (or just sign in, if they already have an account) to follow the
 *  loan file alongside the primary borrower. */
// #150 — the assigned officer's contact block, appended to an email's meta rows
// so the client always sees WHO their loan officer is and how to reach them.
// officer = { name, title?, email?, phone?, nmls? } (a staff_users row shape).
function officerMeta(meta, officer) {
  if (!officer || !officer.name) return meta;
  const bits = [officer.name, officer.title || 'Loan Officer'].filter(Boolean).join(' · ');
  meta.push({ label: 'Your loan officer', value: bits + (officer.nmls ? ` · NMLS #${officer.nmls}` : '') });
  const reach = [officer.phone, officer.email].filter(Boolean).join(' · ');
  if (reach) meta.push({ label: 'Reach them at', value: reach });
  return meta;
}

function coBorrowerInvite({ firstName, primaryName, acceptUrl, hasAccount, officer } = {}) {
  return render({
    audience: 'borrower',
    title: 'You have been added to a loan application',
    badge: { text: 'Portal invite', tone: 'teal' },
    replyable: true,
    preheader: 'Set up portal access to follow the file with ' + (primaryName || 'your co-borrower') + '.',
    greeting: greet(firstName),
    intro: (primaryName || 'Your co-borrower') + ' has named you as a co-borrower on a YS Capital Group loan application.',
    lines: [
      hasAccount
        ? 'Your existing portal account now has access to this loan file — sign in to review the application, upload documents, and follow every milestone.'
        : 'Set up your portal access below to review the application, upload your documents, and follow every milestone through closing. This invitation expires in 14 days.',
    ],
    meta: officerMeta([], officer),
    cta: acceptUrl ? { label: hasAccount ? 'Sign in to the portal' : 'Set up your access', url: acceptUrl } : null,
    note: 'If you were not expecting this, you can disregard it and no access will be created.',
  });
}

/** Invitation to the borrower on a staff-originated loan file: their loan team
 *  has already opened the file — set up portal access (or sign in) to follow it,
 *  upload documents, and message the team. */
function borrowerInvite({ firstName, propertyLabel, loanNumber, inviter, acceptUrl, hasAccount, officer } = {}) {
  const meta = [];
  if (propertyLabel) meta.push({ label: 'Property', value: propertyLabel });
  if (loanNumber) meta.push({ label: 'Loan #', value: loanNumber });
  officerMeta(meta, officer);   // #150 — the inviting officer's contact block
  return render({
    audience: 'borrower',
    title: 'Your loan file is ready in the portal',
    subjectTag: fileTag(loanNumber, propertyLabel),
    badge: { text: 'Portal invite', tone: 'teal' },
    replyable: true,
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

/** PILOT's OWN "your documents are ready to sign" invitation (owner-directed
 *  2026-07-20). The button (`signUrl`) takes the borrower STRAIGHT into their
 *  secure signing session — no portal stop, no "Sign now" click — and returns them
 *  to their loan file afterward. Borrower-safe by construction: only the loan #,
 *  property, and package name (never a capital-partner / note-buyer name). This
 *  rides ALONGSIDE DocuSign's own email (belt-and-suspenders — "both"). */
function esignReadyToSign({ firstName, propertyLabel, loanNumber, packageLabel, signUrl, officer } = {}) {
  const meta = [];
  if (propertyLabel) meta.push({ label: 'Property', value: propertyLabel });
  if (loanNumber) meta.push({ label: 'Loan #', value: loanNumber });
  if (packageLabel) meta.push({ label: 'To sign', value: packageLabel });
  officerMeta(meta, officer);
  return render({
    audience: 'borrower',
    title: 'Your documents are ready to sign',
    subjectTag: fileTag(loanNumber, propertyLabel),
    badge: { text: 'Signature needed', tone: 'gold' },
    replyable: true,
    preheader: 'A secure electronic signature is needed on your loan documents.',
    greeting: greet(firstName),
    intro: 'Your ' + (packageLabel ? packageLabel.toLowerCase() : 'loan documents')
      + ' ' + (packageLabel && !/s$/i.test(packageLabel) ? 'is' : 'are') + ' ready for your electronic signature with YS Capital Group.',
    lines: [
      'Tap the button below to review and sign securely — it opens your signing session right away, and brings you back to your loan file when you\'re done.',
      'Your signature is handled through our e-signature partner (DocuSign). You may also receive a separate email directly from DocuSign for the same documents — either one takes you to the same place.',
    ],
    meta,
    cta: signUrl ? { label: 'Review & sign', url: signUrl } : null,
    note: 'If you were not expecting this, you can disregard it — nothing is signed until you review and approve it yourself.',
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
    badge: { text: 'Team invite', tone: 'teal' },
    replyable: true,
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
    badge: { text: 'Console ready', tone: 'positive' },
    replyable: true,
    note: 'If you were not expecting this, contact your administrator.',
  });
}

/** A borrower on a FUNDED file requested draw setup. This ONE message goes to
 *  everyone on the file at once — the borrower, the draws desk, and the assigned
 *  loan team — on a single shared thread (owner-directed 2026-07-20: keep everybody
 *  in one chain, and word it as the kickoff of the draw process rather than an
 *  internal "setup needed" task). Borrower-safe: property/borrower/loan# only. */
function drawRequest({ borrowerName, propertyLabel, loanNumber } = {}) {
  const meta = [];
  if (propertyLabel) meta.push({ label: 'Property', value: propertyLabel });
  if (borrowerName) meta.push({ label: 'Borrower', value: borrowerName });
  if (loanNumber) meta.push({ label: 'Loan #', value: loanNumber });
  return render({
    audience: 'staff',
    title: 'Let’s get the draw process started — ' + (propertyLabel || 'your funded file'),
    subjectTag: fileTag(loanNumber, propertyLabel),
    badge: { text: 'Draw process', tone: 'gold' },
    replyable: true,
    preheader: 'Kicking off the construction draw process for this file.',
    intro: 'We’re kicking off the construction draw process for this property. '
      + 'Everyone who works on this file is on this same email — the draws desk and the loan team'
      + (borrowerName ? ', along with ' + borrowerName : '')
      + ' — so every draw can be coordinated together in one place.',
    lines: [
      'The draws desk will follow up right here with the next steps to get the first draw set up.',
      'Please keep everything on this thread — just reply to this email and it reaches the whole team at once.',
    ],
    meta,
    note: 'Reply to this email to reach the draws desk and the loan team together.',
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
  esignReadyToSign,
};

/** Deliver an already-rendered { subject, html, text } to one/many recipients.
    opts.replyTo (optional) sets a Reply-To — used by #68 to attach the per-file
    shared reply-to (file+<applicationId>@<domain>) on file-scoped catalog emails.
    Only pass it when a valid applicationId is available; omitted → no reply-to
    (unchanged behavior for auth/transactional emails). */
async function deliver(built, to, opts = {}) {
  if (!built) return { ok: false, error: 'no email built' };
  try {
    // #150: opts.from carries an LO-branded From display name when the email
    // is sent on a specific officer's behalf (invites, registrations).
    // Owner-directed 2026-07-20: default a monitored Reply-To so even auth /
    // invite emails are repliable (never a dead-end no-reply).
    const r = await provider.sendMail({ to, subject: built.subject, html: built.html, text: built.text,
      replyTo: opts.replyTo || cfg.replyToDefault || null, from: opts.from || null,
      // Email Center capture context (stripped by the provider wrapper). The file
      // is derived from a file+<id>@ Reply-To when opts.applicationId is absent.
      _ctx: { applicationId: opts.applicationId || null, type: opts.type || 'transactional', audience: opts.audience || 'borrower' } });
    if (r && r.skipped) console.log('[email] provider=none, skipped:', built.subject, '->', to);
    return { ok: !!(r && r.ok), id: r && r.id, skipped: r && r.skipped };
  } catch (e) {
    console.error('[email] send failed:', built.subject, '->', to, '::', e.message);
    return { ok: false, error: e.message };
  }
}

/** Build by name + deliver in one call. Returns {ok,...}; never rejects.
    opts.replyTo is forwarded to deliver (see #68 above). */
async function send(kind, to, args, opts = {}) {
  const b = builders[kind];
  if (!b) { console.error('[email] unknown template:', kind); return { ok: false, error: 'unknown template ' + kind }; }
  return deliver(b(args || {}), to, opts);
}

module.exports = Object.assign({}, builders, { deliver, send, link, ROLE_LABEL });
