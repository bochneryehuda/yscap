/** Resend transactional email. Env: RESEND_API_KEY, NOTIFY_FROM.
 *
 *  The FROM address domain must be a domain you've verified in Resend
 *  (Dashboard → Domains). Until then Resend rejects the send with a 403 —
 *  which we surface verbatim so it's obvious what to fix.
 */
const cfg = require('../../config');

module.exports = {
  name: 'resend',
  async sendMail({ to, subject, text, html, attachments, replyTo, from, bcc, cc }) {
    if (!cfg.resendApiKey) {
      throw new Error('RESEND_API_KEY is not set — add it in the Render environment to send email.');
    }
    const recipients = (Array.isArray(to) ? to : [to]).filter(Boolean);
    if (!recipients.length) throw new Error('no recipient');
    const toLower = new Set(recipients.map((a) => String(a).toLowerCase()));
    // CC (visible carbon copy — the whole order chain sees each other, #orders).
    // Never CC a To recipient (no self-duplicate).
    const ccList = (Array.isArray(cc) ? cc : (cc ? [cc] : []))
      .filter((a) => a && !toLower.has(String(a).toLowerCase()));
    const ccLower = new Set(ccList.map((a) => String(a).toLowerCase()));
    // BCC (e.g. the assigned loan officer's monitoring copy). Never BCC someone
    // who is already a To or Cc recipient (no self-duplicate).
    const bccList = (Array.isArray(bcc) ? bcc : (bcc ? [bcc] : []))
      .filter((a) => a && !toLower.has(String(a).toLowerCase()) && !ccLower.has(String(a).toLowerCase()));
    // Resend attachments: { filename, content (base64) }. Size-gating is the
    // caller's job (the doc-upload site only attaches ≤3 MB and always lists the
    // filename); here we just map whatever survived that gate.
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
          // #150 — LO branding: an optional per-message From display name
          // ("Chaim Klein — YS Capital <no-reply@…>"). The ADDRESS is always
          // ours (the verified sending domain); only the display name varies.
          // Absent → the corporate default, unchanged.
          from: from || cfg.notifyFrom,
          to: recipients,
          subject,
          text,
          html,
        }, atts.length ? { attachments: atts } : {},
           ccList.length ? { cc: ccList } : {},
           bccList.length ? { bcc: bccList } : {},
           // #75: a unique reply-to lets an external chat guest reply by email and
           // have it land back in the conversation (routed via the inbound webhook).
           replyTo ? { reply_to: replyTo } : {})),
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
