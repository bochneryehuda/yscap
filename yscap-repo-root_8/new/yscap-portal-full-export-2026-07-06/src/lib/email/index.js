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
module.exports = provider;
