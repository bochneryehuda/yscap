/**
 * DocuSign eSignature — server-to-server via JWT Grant (OAuth 2.0).
 * Framework only until keys are added; every method throws a clear
 * "not configured" until then, so callers degrade gracefully.
 *
 * To activate (env): DOCUSIGN_INTEGRATION_KEY, DOCUSIGN_USER_ID,
 * DOCUSIGN_ACCOUNT_ID, DOCUSIGN_PRIVATE_KEY (RSA PEM), DOCUSIGN_BASE_URI,
 * DOCUSIGN_OAUTH_BASE. Also grant the integration key JWT "impersonation"
 * consent once. Status is delivered back via DocuSign Connect webhooks
 * (envelope-completed etc.) — see src/routes/webhooks.js.
 */
const crypto = require('crypto');
const cfg = require('../../config').docusign;

function configured() {
  return !!(cfg.integrationKey && cfg.userId && cfg.accountId && cfg.privateKey);
}
function ensure() { if (!configured()) throw new Error('DocuSign not configured — add DOCUSIGN_* env vars'); }

// JWT assertion signed with the app's RSA private key, exchanged for an
// access token that impersonates the configured user.
async function accessToken() {
  ensure();
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const claims = {
    iss: cfg.integrationKey, sub: cfg.userId, aud: cfg.oauthBase,
    iat: now, exp: now + 3600, scope: 'signature impersonation',
  };
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const signingInput = `${b64(header)}.${b64(claims)}`;
  const sig = crypto.createSign('RSA-SHA256').update(signingInput).sign(cfg.privateKey).toString('base64url');
  const assertion = `${signingInput}.${sig}`;
  const r = await fetch(`https://${cfg.oauthBase}/oauth/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`DocuSign auth: ${j.error_description || j.error || r.status}`);
  return j.access_token;
}

/**
 * Send a document out for signature. `document` = { base64, name }, `signer` =
 * { name, email }. Returns { envelopeId }. Uses a single "sign here" tab; extend
 * with anchor strings / additional recipients as needed.
 */
async function sendForSignature({ document, signer, subject } = {}) {
  ensure();
  const token = await accessToken();
  const envelope = {
    emailSubject: subject || 'Please sign your YS Capital documents',
    status: 'sent',
    documents: [{ documentBase64: document.base64, name: document.name || 'Document', fileExtension: 'pdf', documentId: '1' }],
    recipients: {
      signers: [{
        email: signer.email, name: signer.name, recipientId: '1', routingOrder: '1',
        tabs: { signHereTabs: [{ anchorString: '/sig1/', anchorUnits: 'pixels', anchorXOffset: '0', anchorYOffset: '0' }] },
      }],
    },
  };
  const r = await fetch(`${cfg.baseUri}/v2.1/accounts/${cfg.accountId}/envelopes`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(envelope),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`DocuSign envelope: ${j.message || r.status}`);
  return { envelopeId: j.envelopeId, status: j.status };
}

module.exports = { name: 'docusign', configured, accessToken, sendForSignature };
