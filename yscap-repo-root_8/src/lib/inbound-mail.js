'use strict';
/**
 * READING AN INBOUND EMAIL — one definition, both products.
 *
 * Everything about getting a message OUT of the mail provider and deciding what it
 * is: which addresses a delivery names, the Receiving-API retrieval, the attachment
 * download with its two honest drop counters, whether the sender is who they say,
 * and whether the whole thing is an auto-responder. It touches no database and no
 * loan table, so both desks can share it rather than each growing a copy of a
 * security-relevant reading.
 *
 * ── WHY IT IS ITS OWN FILE ──────────────────────────────────────────────────
 *
 * `lib/file-inbox.js` is the SHORT-TERM inbox: it forwards to that product's
 * assignees, files documents onto its conditions and writes its tables, and it
 * requires the short-term database pool at module load. The long-term orders desk
 * needs the same vendor replies and the same returned documents, and the owner's
 * instruction was to SHARE the code rather than copy it — *"You need to make sure
 * you're not copying the information. You're just using the information from the
 * short-term side"* — so the provider-facing half moved here and `file-inbox.js`
 * re-exports every one of these names. The short-term inbox is byte-identical; the
 * only thing that moved is where the definition lives.
 *
 * ── THE TWO COUNTERS ARE THE POINT ──────────────────────────────────────────
 *
 * `retrieveAttachmentsSafe` returns an array carrying `droppedByCap` and
 * `droppedByError`. They look alike from outside — an attachment that is not here —
 * and they are OPPOSITE answers to "should anybody chase the sender?". Keep them
 * apart in every consumer.
 *
 * SEPARATION: requires `src/config` and nothing else. No pool, no table.
 */
const cfg = require('../config');

const RESEND_BASE = 'https://api.resend.com';

// TWO DIFFERENT JOBS, TWO DIFFERENT BUDGETS — do not conflate them again.
//
// The bytes we pull off an inbound email serve two consumers with opposite needs:
//   · FILING — the order-return desk and the closing chain SAVE these documents into
//     the loan file (storage), so retrieval must be sized for a real multi-document
//     send. The closing chain is designed for a full draft package, and a reply-all
//     chain accumulates the attorney's signature-image logo on every reply on top of
//     that. It is bounded only by memory, and — critically — the DOWNLOAD is from the
//     inbound-mail API, so the OUTBOUND provider's ceiling has no business capping it.
//     The filing sinks (closing-inbox.MAX_DOCS_PER_EMAIL, order-inbox.MAX_RETURN_DOCS)
//     are kept at THIS count so retrieval is the single, REPORTED bound — a sink slice
//     below it would truncate silently.
//   · FORWARDING — the courtesy "New reply on a loan file" email attaches these for
//     the team, so it IS bounded by the outbound provider's sendMail limit.
//
// They were ONE set of caps (count 10, and on Graph a 2.5 MB total), which meant a
// 30-document closing package lost everything past the 10th attachment — reported as
// "N could not be filed, ask the attorney to resend" on a resend that returns the
// same first 10 forever. The retrieval cap now covers the closing chain plus its
// signature noise; the forward trims to the provider when it actually sends.

// --- RETRIEVAL / FILING budget (memory-bound, provider-agnostic) ---
const MAX_ATTACH_BYTES = 8 * 1024 * 1024;      // per attachment (a real closing document)
// The single count bound on an inbound package. It is what the filing sinks are kept at
// (closing-inbox.MAX_DOCS_PER_EMAIL, order-inbox.MAX_RETURN_DOCS), so everything
// retrieved is FILED (signature/logo images are filtered separately, via the `skipped`
// path in saveChainDocs — never by this cap), and anything BEYOND it is dropped and
// REPORTED (droppedByCap), never silently truncated by a lower sink.
const MAX_ATTACH_COUNT = 60;
// A ceiling on the DECODED bytes we pull into memory for one delivery. Held as base64
// (~1.33× the decoded size) across the filing + forward consumers, so a maxed single
// delivery is on the order of ~60 MB of string; bounded and fine for this app.
const MAX_ATTACH_TOTAL_RETRIEVE = 45 * 1024 * 1024;

/** The full-access key used for the Receiving API. A Sending-only key can't read
    inbound email, so RESEND_INBOUND_API_KEY is preferred; RESEND_API_KEY is the
    fallback (fine if that key already has full access). */
function inboundKey() {
  return cfg.resendInboundApiKey || cfg.resendApiKey || null;
}

/** Bare lowercase address out of any "Display Name <addr@x>" form. Anchored to
    the LAST angle-bracket group so a display name that itself contains angle
    brackets can't spoof the extraction (sender self-echo exclusion depends on it). */
function extractAddress(from) {
  const s = String(from || '');
  const m = s.match(/<([^<>\s]+@[^<>\s]+)>\s*$/);
  return (m ? m[1] : s).trim().toLowerCase();
}

/** Every recipient the event names. Resend's email.received carries data.to,
    data.cc, data.bcc, AND data.received_for (the envelope recipient — the ONLY
    field guaranteed to hold a Bcc'd file address). Values may be strings, arrays,
    {address}/{email} objects, or "Name <addr>" display forms. */
function recipientsFromEvent(data) {
  const out = [];
  const push = (v) => {
    if (!v || out.length >= 100) return;
    if (Array.isArray(v)) return v.forEach(push);
    if (typeof v === 'object') return push(v.address || v.email || v.value);
    const s = String(v);
    // A display-name form hides the address from the file+ matcher — extract it.
    out.push(s.includes('<') ? extractAddress(s) : s);
  };
  const d = data || {};
  push(d.to); push(d.To);
  push(d.cc); push(d.Cc);
  push(d.bcc); push(d.Bcc);
  push(d.received_for); push(d.receivedFor);
  push(d.recipient);
  push(d.envelope && d.envelope.to);
  return out;
}

async function fetchJson(url, ms = 15000) {
  const key = inboundKey();
  if (!key) throw new Error('no inbound api key');
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try {
    const r = await fetch(url, { headers: { Authorization: `Bearer ${key}` }, signal: ac.signal });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`resend ${r.status}`);
    return j;
  } finally { clearTimeout(t); }
}

/** Retrieve a received inbound email's full content by id (Receiving API). */
async function retrieveInboundEmail(emailId) {
  return fetchJson(`${RESEND_BASE}/emails/receiving/${encodeURIComponent(emailId)}`);
}


/** RFC 3834-style auto-generated mail detection: auto-replies, out-of-office,
    delivery status notifications, ticket-system auto-acks. Forwarding these
    through the shared reply address would ping-pong between two auto-responders
    with every bounce fanned out to the whole team — they are recorded, never
    forwarded. Checks the retrieved message's headers when present, then falls
    back to From/Subject heuristics (the Receiving API doesn't always expose
    headers). */
/** One header off a retrieved message, however the provider shaped `headers`
    (an array of {name,value}, a plain object, or absent entirely). */
function headerVal(full, name) {
  const h = full && full.headers;
  if (!h) return '';
  const want = String(name).toLowerCase();
  if (Array.isArray(h)) {
    const row = h.find((x) => x && String(x.name || x.key || '').toLowerCase() === want);
    return row ? String(row.value || '') : '';
  }
  if (typeof h === 'object') {
    for (const k of Object.keys(h)) if (k.toLowerCase() === want) return String(h[k] || '');
  }
  return '';
}

/**
 * DID THIS MESSAGE REALLY COME FROM WHO IT SAYS? (2026-07-28, closing-chain audit.)
 *
 * The webhook verifies RESEND's signature — that the delivery is genuinely from our
 * provider — and nothing whatsoever verified the SENDER. On the ordinary `file+` and
 * `chat+` addresses that is a modest risk; on `closing+<token>@` it is not, because
 * that address exists to be BROADCAST to title, the settlement agent, the realtor and
 * outside counsel, so its value circulates far outside our control. Anyone holding it
 * could spoof the attorney's From and drop a wiring-instructions PDF straight into the
 * loan file, where it reads exactly like the real thing.
 *
 * We record the verdict the receiving MTA already computed. NOT a gate: a perfectly
 * legitimate message forwarded through a mailing list or an assistant's rule fails SPF
 * every day, so refusing on `fail` would lose real closing documents — the expensive
 * direction. It is surfaced instead, so the person about to open the attachment sees it.
 *
 * `unknown` is the honest answer when the provider exposes no headers, and it must
 * never be displayed as if it were a pass.
 */
function senderAuth(full) {
  const ar = headerVal(full, 'authentication-results');
  const pick = (mech) => {
    const m = ar && new RegExp(`(?:^|[;\\s])${mech}\\s*=\\s*([a-z]+)`, 'i').exec(ar);
    return m ? m[1].toLowerCase() : null;
  };
  let spf = pick('spf');
  const dkim = pick('dkim');
  const dmarc = pick('dmarc');
  // Older MTAs emit a standalone Received-SPF instead of folding it into
  // Authentication-Results.
  if (!spf) {
    const rs = headerVal(full, 'received-spf');
    const m = rs && /^\s*([a-z]+)/i.exec(rs);
    if (m) spf = m[1].toLowerCase();
  }
  if (!spf && !dkim && !dmarc) return { spf: null, dkim: null, dmarc: null, verdict: 'unknown' };
  // Only a DEFINITIVE DMARC result is decisive; a non-definitive one falls through to
  // SPF/DKIM rather than being read as forgery. RFC 8601 makes the DMARC method one of
  // pass | fail | none | temperror | permerror, and only `fail` is evidence of a
  // problem: `none` means the sender publishes no DMARC policy — the NORM for the
  // small title companies, settlement agents and realtors a closing chain reaches —
  // and temperror/permerror mean the receiver could not evaluate DMARC (a DNS timeout,
  // a malformed record), not that the sender is a forger. Treating those three as
  // `fail` overrode a passing SPF AND DKIM and cried wolf on ordinary legitimate mail,
  // which trains staff to dismiss the banner — so the ONE real spoofed wiring email it
  // exists to catch gets dismissed with the rest.
  //
  // A definitive `dmarc=fail` still wins even when SPF/DKIM pass: that is precisely the
  // alignment forgery DMARC catches and raw SPF/DKIM miss (the message authenticates as
  // some other domain, not the From). Otherwise EITHER of SPF or DKIM passing is the
  // ordinary bar for "this really is them" — requiring both would mark most legitimate
  // mail suspicious for the same reason.
  let verdict;
  if (dmarc === 'pass') verdict = 'pass';
  else if (dmarc === 'fail') verdict = 'fail';
  else if (spf === 'pass' || dkim === 'pass') verdict = 'pass';
  else if (spf === 'fail' || dkim === 'fail' || spf === 'softfail') verdict = 'fail';
  else verdict = 'unknown';
  return { spf: spf || null, dkim: dkim || null, dmarc: dmarc || null, verdict };
}

function isAutoGenerated(full) {
  const hv = (name) => headerVal(full, name);
  const auto = hv('auto-submitted').toLowerCase();
  if (auto && auto !== 'no') return true;
  const prec = hv('precedence').toLowerCase();
  if (['bulk', 'junk', 'auto_reply', 'list'].includes(prec)) return true;
  if (hv('x-auto-response-suppress')) return true;
  if (hv('x-autoreply') || hv('x-autorespond')) return true;
  const from = extractAddress(full && full.from);
  if (/^(mailer-daemon|postmaster)@/i.test(from)) return true;
  const subj = String((full && full.subject) || '');
  if (/^\s*(auto(matic|mated)?[ -]?(reply|response)|out of (the )?office|delivery status notification|undeliverable|undelivered mail|mail delivery (failed|subsystem)|failure notice)\b/i.test(subj)) return true;
  return false;
}

/**
 * Best-effort attachment retrieval. For each attachment we ask the Receiving API
 * for a signed download_url, then fetch the bytes and base64 them for the forward.
 * ANY failure (or size over the caps) → that attachment is skipped; the reply
 * text still forwards. Returns [{ filename, contentType, content(base64) }].
 */
/**
 * WHY A DROP IS COUNTED, not just dropped.
 *
 * The returned array carries two extra properties — `droppedByCap` and
 * `droppedByError`. They look alike from the outside (an attachment that is not
 * here) and they are the OPPOSITE of each other to a caller deciding whether to
 * retry:
 *   · droppedByCap   — the count/size ceilings, and the provider simply not
 *     listing a download url. DETERMINISTIC: the same delivery yields the same
 *     first N every time, so no redelivery can ever retrieve the rest. A human has
 *     to ask the sender to send it again.
 *   · droppedByError — a failed metadata fetch, a non-ok download, our own
 *     15-second abort. All transient. Telling the team to chase the title company
 *     because OUR network blinked is both noise and, once the retry lands, untrue.
 *
 * Attached to the array rather than changing the return shape so every existing
 * caller is byte-identical; a caller that does not read them behaves exactly as
 * before.
 */
async function retrieveAttachmentsSafe(emailId, metaList) {
  const list = Array.isArray(metaList) ? metaList.slice(0, MAX_ATTACH_COUNT) : [];
  // The FILING budget, not the outbound provider's. We download from the inbound-mail
  // API here, and these bytes are SAVED into the loan file — the closing chain files a
  // full draft package, so capping retrieval at the outbound Graph ceiling (2.5 MB) is
  // what silently dropped real closing documents. The forward applies the provider
  // ceiling separately when it actually sends (attachmentsForForward).
  const totalCap = MAX_ATTACH_TOTAL_RETRIEVE;
  const perCap = Math.min(MAX_ATTACH_BYTES, totalCap);
  const out = [];
  let total = 0;
  let droppedByCap = Math.max(0, (Array.isArray(metaList) ? metaList.length : 0) - list.length);
  let droppedByError = 0;
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (!a || !a.id) { droppedByCap += 1; continue; }
    if (a.size && Number(a.size) > perCap) { droppedByCap += 1; continue; }
    try {
      const meta = await fetchJson(`${RESEND_BASE}/emails/receiving/${encodeURIComponent(emailId)}/attachments/${encodeURIComponent(a.id)}`);
      const url = meta && meta.download_url;
      // No download url at all is the provider's answer about THIS attachment, not
      // a hiccup — retrying returns the same nothing.
      if (!url) { droppedByCap += 1; continue; }
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), 15000);
      let buf;
      try {
        const r = await fetch(url, { signal: ac.signal });
        if (!r.ok) { droppedByError += 1; continue; }
        buf = Buffer.from(await r.arrayBuffer());
      } finally { clearTimeout(t); }
      if (!buf) { droppedByError += 1; continue; }
      if (buf.length > perCap) { droppedByCap += 1; continue; }
      // The total budget is spent: THIS one and everything after it are dropped by
      // the cap. Counted from the loop INDEX, not from how many were kept —
      // `list.length - out.length` also swept up every earlier item that a
      // transient error had already counted, so the team was told to ask the
      // vendor to resend documents that were filed, or were about to be retried.
      if (total + buf.length > totalCap) { droppedByCap += (list.length - i); break; }
      total += buf.length;
      out.push({
        filename: String(a.filename || meta.filename || 'attachment'),
        contentType: a.content_type || 'application/octet-stream',
        // Inline/Content-ID metadata rides along when the provider exposes it —
        // the returned-document sinks use it to tell an email-signature image
        // (embedded in the body) from a genuinely attached document. Read
        // defensively: the field names vary across provider payload shapes.
        contentDisposition: a.content_disposition || a.disposition || meta.content_disposition || meta.disposition || undefined,
        contentId: a.content_id || a.contentId || meta.content_id || meta.contentId || undefined,
        content: buf.toString('base64'),
      });
    } catch (_) { droppedByError += 1; /* skip this attachment, keep going */ }
  }
  out.droppedByCap = droppedByCap;
  out.droppedByError = droppedByError;
  return out;
}

module.exports = {
  RESEND_BASE, MAX_ATTACH_BYTES, MAX_ATTACH_COUNT, MAX_ATTACH_TOTAL_RETRIEVE,
  inboundKey, extractAddress, recipientsFromEvent,
  fetchJson, retrieveInboundEmail, retrieveAttachmentsSafe,
  headerVal, senderAuth, isAutoGenerated,
};
