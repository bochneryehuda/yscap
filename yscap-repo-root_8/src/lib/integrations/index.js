/** Aggregate integration status — which third-party services are wired up. */
const cfg = require('../../config');
const docusign = require('./docusign');
const plaid = require('./plaid');
const xactus = require('./xactus');
const azureDocint = require('./azure-docint');
const azureOpenai = require('./azure-openai');

function status() {
  return {
    email:    { provider: cfg.emailProvider, configured: cfg.emailProvider !== 'none' && (cfg.emailProvider !== 'resend' || !!cfg.resendApiKey) },
    address:  { provider: cfg.addressProvider, configured: true },  // OSM keyless default is always available
    storage:  { provider: cfg.storageProvider, configured: true },
    docusign: { provider: 'docusign', configured: docusign.configured() },
    plaid:    { provider: 'plaid', env: cfg.plaid.env, configured: plaid.configured() },
    xactus:   { provider: 'xactus', configured: xactus.configured() },
    // Document-intelligence + AI-reasoning pipeline (Azure).
    azureDocint: { provider: 'azure-docint', apiVersion: cfg.azureDocInt.apiVersion, configured: azureDocint.configured() },
    azureOpenai: { provider: 'azure-openai', deployment: cfg.azureOpenai.deployment, apiVersion: cfg.azureOpenai.apiVersion, configured: azureOpenai.configured() },
  };
}

module.exports = { docusign, plaid, xactus, azureDocint, azureOpenai, status };
