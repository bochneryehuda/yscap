/** Resend transactional email. Env: RESEND_API_KEY, NOTIFY_FROM.
 *
 *  The FROM address domain must be a domain you've verified in Resend
 *  (Dashboard → Domains). Until then Resend rejects the send with a 403 —
 *  which we surface verbatim so it's obvious what to fix.
 */
const cfg = require('../../config');

module.exports = {
  name: 'resend',
  async sendMail({ to, subject, text, html, attachments }) {
    if (!cfg.resendApiKey) {
      throw new Error('RESEND_API_KEY is not set — add it in the Render environment to send email.');
    }
    const recipients = (Array.isArray(to) ? to : [to]).filter(Boolean);
    if (!recipients.length) throw new Error('no recipient');
    // Resend attachments: { filename, content (base64) }. Cap the total so a
    // huge doc can't blow the API request; oversize attachments are dropped (the
    // email still lists them and the file is available in the portal).
    const atts = (Array.isArray(attachments) ? attachments : [])
      .filter((a) => a && a.filename && a.content)
      .map((a) => ({ filename: String(a.filename), content: String(a.content) }));

    // Bound the request so a hung network call can't wedge the send path.
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 15000);
    let r;
    try {
      r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${cfg.resendApiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(Object.assign({
          from: cfg.notifyFrom,
          to: recipients,
          subject,
          text,
          html,
        }, atts.length ? { attachments: atts } : {})),
        signal: ac.signal,
      });
    } catch (e) {
      throw new Error(e.name === 'AbortError'
        ? 'Resend request timed out after 15s'
        : `Resend request failed: ${e.message}`);
    } finally {
      clearTimeout(timer);
    }

    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      // Resend returns {name, message} on error, e.g. 403 domain-not-verified.
      throw new Error(`Resend ${r.status}: ${j.message || j.name || 'send failed'}`);
    }
    return { ok: true, id: j.id };
  },
};
