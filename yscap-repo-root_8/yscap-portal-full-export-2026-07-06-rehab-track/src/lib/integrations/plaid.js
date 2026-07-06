/**
 * Plaid — bank / asset verification. Framework only until keys are added.
 * Flow: backend createLinkToken() -> Plaid Link (frontend) returns a
 * public_token -> backend exchangePublicToken() -> access_token, then
 * getAuth()/createAssetReport(). Manual bank-statement upload remains available
 * regardless (see the documents flow), so borrowers are never blocked.
 *
 * To activate (env): PLAID_CLIENT_ID, PLAID_SECRET, PLAID_ENV
 * (sandbox | development | production).
 */
const cfg = require('../../config').plaid;
const HOST = { sandbox: 'https://sandbox.plaid.com', development: 'https://development.plaid.com', production: 'https://production.plaid.com' };

function configured() { return !!(cfg.clientId && cfg.secret); }
function ensure() { if (!configured()) throw new Error('Plaid not configured — add PLAID_CLIENT_ID / PLAID_SECRET'); }
function base() { return HOST[cfg.env] || HOST.sandbox; }

async function call(path, body) {
  ensure();
  const r = await fetch(base() + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: cfg.clientId, secret: cfg.secret, ...body }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`Plaid ${path}: ${j.error_message || j.error_code || r.status}`);
  return j;
}

// A short-lived token the frontend hands to Plaid Link.
function createLinkToken({ userId, products = ['auth', 'assets'] } = {}) {
  return call('/link/token/create', {
    user: { client_user_id: String(userId || 'borrower') },
    client_name: 'YS Capital Group',
    products, country_codes: ['US'], language: 'en',
  }).then(j => ({ linkToken: j.link_token, expiration: j.expiration }));
}
// Exchange the public_token Link returns for a durable access_token.
function exchangePublicToken(publicToken) {
  return call('/item/public_token/exchange', { public_token: publicToken })
    .then(j => ({ accessToken: j.access_token, itemId: j.item_id }));
}
// Account + routing numbers for ACH.
function getAuth(accessToken) { return call('/auth/get', { access_token: accessToken }); }
// A verifiable asset report (balances + transactions) for underwriting.
function createAssetReport(accessTokens, daysRequested = 90) {
  return call('/asset_report/create', { access_tokens: [].concat(accessTokens), days_requested: daysRequested })
    .then(j => ({ assetReportToken: j.asset_report_token, assetReportId: j.asset_report_id }));
}

module.exports = { name: 'plaid', configured, createLinkToken, exchangePublicToken, getAuth, createAssetReport };
