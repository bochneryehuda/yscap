/**
 * Xactus — credit reports (business-purpose soft/hard pulls). Framework only
 * until credentials are added. Xactus is a B2B provider: access is granted per
 * client with credentials and an assigned API endpoint, so the exact request
 * shape is finalized against YOUR onboarding packet. This module centralizes
 * auth + the pull call behind a stable interface; wire the account-specific
 * request/response mapping in `pullCredit` once the endpoint spec is in hand.
 *
 * To activate (env): XACTUS_USERNAME, XACTUS_PASSWORD, XACTUS_ENDPOINT
 * (your assigned base URL), and optionally XACTUS_CLIENT_ID.
 */
const cfg = require('../../config').xactus;

function configured() { return !!(cfg.username && cfg.password && cfg.endpoint); }
function ensure() { if (!configured()) throw new Error('Xactus not configured — add XACTUS_USERNAME / XACTUS_PASSWORD / XACTUS_ENDPOINT'); }

// Many Xactus/Xactus360 deployments issue a bearer token from a login call;
// others accept HTTP Basic per request. This helper does a token login and
// falls back to Basic. Adjust the paths to match your onboarding packet.
async function authHeader() {
  ensure();
  try {
    const r = await fetch(cfg.endpoint.replace(/\/+$/, '') + '/auth/token', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: cfg.username, password: cfg.password, clientId: cfg.clientId || undefined }),
    });
    if (r.ok) { const j = await r.json(); if (j.access_token || j.token) return `Bearer ${j.access_token || j.token}`; }
  } catch (_) { /* fall through to Basic */ }
  return 'Basic ' + Buffer.from(`${cfg.username}:${cfg.password}`).toString('base64');
}

/**
 * Order a credit report. `borrower` = { firstName, lastName, ssn, address }.
 * `bureau`/`product` select the report type (e.g. soft pull at lead stage).
 * Returns the raw provider response; map it to your CONDITION/BORROWER records
 * at the call site once the response schema is confirmed.
 */
async function pullCredit({ borrower, product = 'soft', bureaus = ['equifax'] } = {}) {
  ensure();
  const auth = await authHeader();
  const r = await fetch(cfg.endpoint.replace(/\/+$/, '') + '/credit/order', {
    method: 'POST', headers: { Authorization: auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      product, bureaus,
      applicant: {
        firstName: borrower.firstName, lastName: borrower.lastName,
        ssn: borrower.ssn, address: borrower.address,
      },
    }),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`Xactus ${r.status}: ${text.slice(0, 200)}`);
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

module.exports = { name: 'xactus', configured, pullCredit };
