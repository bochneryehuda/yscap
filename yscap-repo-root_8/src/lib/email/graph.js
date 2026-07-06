/**
 * Microsoft Graph (Outlook / Microsoft 365) email via client-credentials.
 * Needs an Azure AD app registration with the APPLICATION permission
 * Mail.Send (admin-consented). Env: MS_TENANT_ID, MS_CLIENT_ID,
 * MS_CLIENT_SECRET, NOTIFY_FROM (a real mailbox UPN in your tenant).
 */
const cfg = require('../../config');
let _tok = { value: null, exp: 0 };

// Bound every Graph HTTP call (like the Resend provider does) so a hung upstream
// can never leave an email send — and the request that triggered it — waiting
// indefinitely.
async function fetchWithTimeout(url, opts = {}, ms = 15000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ac.signal }); }
  finally { clearTimeout(t); }
}

async function getToken() {
  if (_tok.value && Date.now() < _tok.exp - 60000) return _tok.value;
  const url = `https://login.microsoftonline.com/${cfg.msTenantId}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    client_id: cfg.msClientId,
    client_secret: cfg.msClientSecret,
    scope: 'https://graph.microsoft.com/.default',
    grant_type: 'client_credentials',
  });
  const r = await fetchWithTimeout(url, { method: 'POST', body });
  const j = await r.json();
  if (!r.ok) throw new Error(`Graph token: ${j.error_description || r.status}`);
  _tok = { value: j.access_token, exp: Date.now() + (j.expires_in * 1000) };
  return _tok.value;
}

module.exports = {
  name: 'graph',
  async sendMail({ to, subject, text, html }) {
    const token = await getToken();
    const from = cfg.notifyFrom;
    const url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(from)}/sendMail`;
    const message = {
      subject,
      body: { contentType: html ? 'HTML' : 'Text', content: html || text || '' },
      toRecipients: (Array.isArray(to) ? to : [to]).map(a => ({ emailAddress: { address: a } })),
    };
    const r = await fetchWithTimeout(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, saveToSentItems: false }),
    });
    if (!r.ok) throw new Error(`Graph sendMail ${r.status}: ${await r.text()}`);
    return { ok: true };
  },
};
