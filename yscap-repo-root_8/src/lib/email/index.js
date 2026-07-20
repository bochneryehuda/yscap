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
  const { _ctx, ...send } = opts || {};
  const ctx = _ctx || {};
  let res, err;
  try {
    res = await provider.sendMail(send);
  } catch (e) { err = e; }
  try {
    const emailLog = require('../email-log');
    const status = err ? 'error' : (res && res.ok ? 'sent' : 'skipped');
    await emailLog.captureOutbound(send, { ...ctx, status, providerId: res && res.id, error: err && err.message });
  } catch (_) { /* capture is best-effort */ }
  if (err) throw err;
  return res;
}

module.exports = Object.assign({}, provider, { fromWithName, sendMail });
