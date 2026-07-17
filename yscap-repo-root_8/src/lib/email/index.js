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

module.exports = Object.assign({}, provider, { fromWithName });
