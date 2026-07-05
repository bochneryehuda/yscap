/** Resend transactional email. Env: RESEND_API_KEY, NOTIFY_FROM. */
const cfg = require('../../config');
module.exports = {
  name: 'resend',
  async sendMail({ to, subject, text, html }) {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.resendApiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: cfg.notifyFrom,
        to: Array.isArray(to) ? to : [to],
        subject, text, html,
      }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`Resend ${r.status}: ${j.message || ''}`);
    return { ok: true, id: j.id };
  },
};
