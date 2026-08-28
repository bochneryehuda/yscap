/** Resend transactional email. Env: RESEND_API_KEY, NOTIFY_FROM.
 *
 *  The FROM address domain must be a domain you've verified in Resend
 *  (Dashboard → Domains). Until then Resend rejects the send with a 403 —
 *  which we surface verbatim so it's obvious what to fix.
 */
const cfg = require('../../config');

/** Custom internet headers, sanitized. Used for real email-client THREADING
    (In-Reply-To / References / Message-ID) so a system follow-up lands INSIDE the
    conversation it belongs to instead of starting a new one — see
    src/lib/closing-thread.js. A header name Resend would reject (or that could
    inject a second header via CRLF) is dropped rather than sent. */
function cleanHeaders(headers) {
  const out = {};
  if (!headers || typeof headers !== 'object') return out;
  for (const [k, v] of Object.entries(headers)) {
    if (!k || v == null) continue;
    if (!/^[A-Za-z0-9-]+$/.test(k)) continue;                 // no folding, no injection
    const val = String(v).replace(/[\r\n]+/g, ' ').trim();
    if (!val) continue;
    out[k] = val.slice(0, 998);                               // RFC 5322 line limit
  }
  return out;
}

module.exports = {
  name: 'resend',
  // A real remote service with a real quota — metered by the shared send-rate
  // queue at the ./index.js chokepoint. See ./noop.js for why the flag exists.
  outbound: true,
  cleanHeaders,
  async sendMail({ to, subject, text, html, attachments, replyTo, from, bcc, cc, headers, onRate }) {
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
      // A Buffer must be ENCODED, never stringified — `String(Buffer)` is a lossy UTF-8 decode
      // of binary and produced an unopenable PDF (owner-reported 2026-08-10). The convention is
      // base64 strings at the producer; this is the chokepoint belt for any future Buffer.
      .map((a) => ({ filename: String(a.filename), content: Buffer.isBuffer(a.content) ? a.content.toString('base64') : String(a.content) }));

    const hdrs = cleanHeaders(headers);

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
          // ("Chaim Klein — YS Capital <notifications@…>"). The ADDRESS is
          // always ours (the verified sending domain — never a no-reply; the
          // config guard repairs one); only the display name varies.
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
           replyTo ? { reply_to: replyTo } : {},
           // Threading headers (In-Reply-To / References / Message-ID). Resend may
           // assign its own Message-ID, in which case our reference points at an
           // id the recipient never saw — harmless: every threaded sender here ALSO
           // reuses the original subject, which is what Gmail/Outlook fall back to.
           Object.keys(hdrs).length ? { headers: hdrs } : {})),
        signal: ac.signal,
      });
    } catch (e) {
      throw new Error(e.name === 'AbortError'
        ? 'Resend request timed out after 15s'
        : `Resend request failed: ${e.message}`);
    } finally {
      clearTimeout(timer);
    }

    /* THE PROVIDER'S OWN RATE HEADERS (owner-reported 429, 2026-08-23).
       Resend answers every call — success or refusal — with the IETF headers
       `ratelimit-limit` / `ratelimit-remaining` / `ratelimit-reset`. Handing them
       back lets src/lib/email/rate-limit.js meter against the ceiling the
       provider ACTUALLY states rather than one typed into a constant, and lets a
       429 back off for exactly as long as the provider asked for instead of a
       number we invented. `onRate` is supplied by the limiter; a caller that does
       not pass one is byte-identical to before. */
    if (typeof onRate === 'function') { try { onRate(r.headers); } catch (_) { /* never break a send to read a header */ } }

    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      // Resend returns {name, message} on error, e.g. 403 domain-not-verified.
      // The STATUS rides on the error so the limiter can recognise a rate refusal
      // by its code instead of by matching the message text, and the headers ride
      // with it so the back-off is the provider's stated reset, not a guess.
      const err = new Error(`Resend ${r.status}: ${j.message || j.name || 'send failed'}`);
      err.status = r.status;
      err.provider = 'resend';
      try { err.rateHeaders = require('./rate-limit').readRateHeaders(r.headers); } catch (_) { /* optional */ }
      throw err;
    }
    return { ok: true, id: j.id };
  },
};
