/**
 * Email provider selector. Set EMAIL_PROVIDER=graph|resend|none.
 * All providers expose async sendMail({to, subject, text, html}) -> {ok, id?}.
 * 'none' just logs — the portal still records in-app notifications, so nothing
 * breaks before you wire a provider.
 */
const cfg = require('../../config');
let provider;
switch ((cfg.emailProvider || 'none').toLowerCase()) {
  case 'graph':  provider = require('./graph');  break;
  case 'resend': provider = require('./resend'); break;
  default:       provider = require('./noop');   break;
}

/** #150 — LO-branded From: "<Officer Name> — YS Capital <no-reply@…>".
    The ADDRESS is always our verified sender (taken from NOTIFY_FROM); only
    the display name changes, so deliverability/DMARC is untouched. Providers
    that can't rebrand the sender (Graph mailboxes) simply ignore `from`.
    Returns null when no name is given → callers fall back to the default. */
function fromWithName(name) {
  const n = String(name || '').trim().replace(/["<>]/g, '');
  if (!n) return null;
  const m = /<([^>]+)>/.exec(cfg.notifyFrom || '');
  const addr = m ? m[1] : String(cfg.notifyFrom || '').trim();
  if (!addr) return null;
  return `"${n} — YS Capital" <${addr}>`;
}

/**
 * The SINGLE outbound chokepoint. Every send site in the app flows through this
 * (notify._emailRow, catalog.deliver's `provider` alias, chat, reminders, the
 * inbound-reply forward, the admin test email…). We delegate to the active
 * provider and then best-effort CAPTURE the full email into the Email Center
 * store (src/lib/email-log.js) so every file has a Gmail/Outlook-style history.
 *
 * A caller that knows the file/notification context attaches it as `_ctx`
 * ({applicationId, notificationId, type, audience}); the field is stripped before
 * the real provider is called (providers ignore unknown fields anyway, but we
 * keep the wire payload clean). Callers without a `_ctx` still get captured — the
 * file is derived from a `file+<appId>@` Reply-To when present. Capture NEVER
 * affects the send result: a logging failure is swallowed.
 */
async function sendMail(opts = {}) {
  // `_skipCapture` lets a caller deliver a copy WITHOUT recording it in the Email
  // Center (e.g. notify's pixel-free loan-officer BCC copy — the borrower send
  // already captured that notification's history; a second capture on the same
  // notification_id would clobber the recorded recipient).
  const { _ctx, _skipCapture, ...send } = opts || {};
  const ctx = _ctx || {};
  let res, err;
  try {
    res = await provider.sendMail(send);
  } catch (e) { err = e; }
  const status = err ? 'error' : (res && res.ok ? 'sent' : 'skipped');
  // THE ATTACHMENT LINE (owner-directed 2026-08-14: "every single thing here should
  // leave logs in the future"). An investor delivery went out carrying two of its four
  // documents and the running log said NOTHING — not the send, not the omission, not a
  // reason — so the only way to find out what had happened was to read the code and
  // guess. This prints ONE line per email that involved documents at all, naming what
  // rode along and what did not, so a Render log search answers the question directly.
  //
  // Silent for the ordinary email that carries nothing, so it can never become noise.
  // Never throws: a logging failure may not touch a send.
  try {
    const att = Array.isArray(send.attachments) ? send.attachments : [];
    const omitted = Array.isArray(ctx.omitted) ? ctx.omitted : [];
    if (att.length || omitted.length) {
      const bytes = att.reduce((n, a) => n + (typeof a.content === 'string' ? Math.round(a.content.length * 0.75) : 0), 0);
      const missed = omitted.map((o) => `${o.what || o.filename || 'document'}[${o.code || 'unspecified'}]`).join(', ');
      console.log(
        `[email-attach] ${ctx.type || 'email'} ${status}`
        + (ctx.applicationId ? ` app=${ctx.applicationId}` : '')
        + ` attached=${att.length} (${Math.round(bytes / 1024)}KB)`
        + ` omitted=${omitted.length}${missed ? ` — ${missed}` : ''}`);
    }
  } catch (_) { /* the line is a courtesy; the durable record is the DB row below */ }
  if (!_skipCapture) {
    try {
      const emailLog = require('../email-log');
      await emailLog.captureOutbound(send, { ...ctx, status, providerId: res && res.id, error: err && err.message });
    } catch (_) { /* capture is best-effort */ }
  }
  if (err) throw err;
  return res;
}

module.exports = Object.assign({}, provider, { fromWithName, sendMail });
