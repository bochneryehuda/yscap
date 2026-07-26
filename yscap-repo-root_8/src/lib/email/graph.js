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
  async sendMail({ to, subject, text, html, attachments, replyTo, bcc, cc }) {
    const token = await getToken();
    // NOTIFY_FROM may be a display-name form ("YS Capital <noreply@ys.com>"); the
    // Graph /users/{id} path needs a BARE address/UPN or every send fails with 400.
    const rawFrom = cfg.notifyFrom || '';
    const fromMatch = String(rawFrom).match(/<([^>]+)>/);
    const from = (fromMatch ? fromMatch[1] : rawFrom).trim();
    const url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(from)}/sendMail`;
    const message = {
      subject,
      body: { contentType: html ? 'HTML' : 'Text', content: html || text || '' },
      toRecipients: (Array.isArray(to) ? to : [to]).map(a => ({ emailAddress: { address: a } })),
    };
    // Reply-To (file+<appId> / chat+<key>, #68/#75) — the resend provider maps
    // this to reply_to; without it Graph deployments silently lose every
    // reply-by-email thread.
    const replies = (Array.isArray(replyTo) ? replyTo : [replyTo]).filter(Boolean);
    if (replies.length) message.replyTo = replies.map(a => ({ emailAddress: { address: String(a) } }));
    // CC (visible carbon copy — e.g. an order emailed to the vendor with the
    // borrower, loan officer and processor CC'd so the whole chain sees each other,
    // #orders). Never CC a To recipient. Deduped case-insensitively against To.
    const toSet = new Set((Array.isArray(to) ? to : [to]).filter(Boolean).map((a) => String(a).toLowerCase()));
    const ccList = (Array.isArray(cc) ? cc : (cc ? [cc] : [])).filter((a) => a && !toSet.has(String(a).toLowerCase()));
    if (ccList.length) message.ccRecipients = ccList.map(a => ({ emailAddress: { address: String(a) } }));
    // BCC (e.g. the assigned loan officer's monitoring copy). Never BCC a To/Cc recipient.
    const ccSet = new Set(ccList.map((a) => String(a).toLowerCase()));
    const bccList = (Array.isArray(bcc) ? bcc : (bcc ? [bcc] : [])).filter((a) => a && !toSet.has(String(a).toLowerCase()) && !ccSet.has(String(a).toLowerCase()));
    if (bccList.length) message.bccRecipients = bccList.map(a => ({ emailAddress: { address: String(a) } }));
    // Graph fileAttachment: { name, contentBytes (base64) }. (Under ~3 MB total;
    // larger sends need an upload session — out of scope here, so the email still
    // lists the file and the doc is available in the portal.)
    const atts = (Array.isArray(attachments) ? attachments : [])
      .filter((a) => a && a.filename && a.content)
      .map((a) => ({ '@odata.type': '#microsoft.graph.fileAttachment', name: String(a.filename), contentType: a.contentType || 'application/octet-stream', contentBytes: String(a.content) }));
    if (atts.length) message.attachments = atts;
    const r = await fetchWithTimeout(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, saveToSentItems: false }),
    });
    if (!r.ok) throw new Error(`Graph sendMail ${r.status}: ${await r.text()}`);
    return { ok: true };
  },
};
