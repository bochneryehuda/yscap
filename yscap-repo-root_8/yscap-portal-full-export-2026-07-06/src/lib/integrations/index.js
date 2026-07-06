/** Aggregate integration status — which third-party services are wired up. */
const cfg = require('../../config');
const docusign = require('./docusign');
const plaid = require('./plaid');
const xactus = require('./xactus');

function status() {
  return {
    email:    { provider: cfg.emailProvider, configured: cfg.emailProvider !== 'none' && (cfg.emailProvider !== 'resend' || !!cfg.resendApiKey) },
    address:  { provider: cfg.addressProvider, configured: true },  // OSM keyless default is always available
    storage:  { provider: cfg.storageProvider, configured: true },
    docusign: { provider: 'docusign', configured: docusign.configured() },
    plaid:    { provider: 'plaid', env: cfg.plaid.env, configured: plaid.configured() },
    xactus:   { provider: 'xactus', configured: xactus.configured() },
  };
}

module.exports = { docusign, plaid, xactus, status };
