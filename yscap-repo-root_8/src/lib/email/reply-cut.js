'use strict';
/**
 * THE ONE PLACE THAT KNOWS WHERE A REPLY ENDS AND THE QUOTED HISTORY BEGINS.
 *
 * Every email we send that somebody can reply to has the same problem: a reply arrives as
 * [what they just typed] followed by [our entire original message, quoted]. Whoever reads it next
 * — a person in the portal, or a parser — has to be able to tell the two apart.
 *
 * This was solved once, privately, inside `routes/inbound-chat.js`. Owner-directed 2026-08-07, on
 * the closing-prep chain: *"this email needs to be much nicer designed so that you can realize
 * exactly what is part of the current email with these three dots on every single reply back and
 * forth. The reply needs to be above the three dots, and only those three dots should be part of
 * the reply. If not, it is messing everything up terribly."* — the closing chain had neither half
 * of the mechanism, so every reply on it carried the whole history inline.
 *
 * THE MARKER IS THE CONTRACT, AND IT IS TWO-SIDED. `REPLY_MARKER` is printed at the TOP of the
 * message body on the way out, so that when a mail client quotes our email BELOW the recipient's
 * fresh reply, the marker sits immediately under what they typed — which is what makes Gmail,
 * Outlook and Apple Mail collapse everything past it behind the "…" the owner is describing. On
 * the way back in, `topReply` cuts at that same phrase. Both halves read the phrase from HERE, so
 * they can never drift.
 *
 * PURE — no DB, no network, no I/O.
 */

/** The stable token both sides key on. Never reword it without changing both halves at once. */
const REPLY_MARKER_PHRASE = 'Reply above this line';
/** The full delimiter line as it is printed in the message body. */
const REPLY_MARKER = `— — — ${REPLY_MARKER_PHRASE} — — —`;

const MARKER_RE = new RegExp(REPLY_MARKER_PHRASE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');

/**
 * The quote boundaries, in the order they are searched. The EARLIEST match wins — Gmail and
 * Outlook insert their own attribution line ABOVE our marker, so taking the minimum index keeps
 * the reply clean even then.
 *
 * Each of these was added because a real reply leaked without it; none is speculative.
 */
const QUOTE_PATTERNS = [
  MARKER_RE,                               // our own delimiter
  // Gmail / Apple Mail attribution — "On <date>, <name> <email> wrote:". Gmail WRAPS this across
  // lines when it is long (the "…<email>" ends one line and "wrote:" starts the next), so a
  // single-line `.` missed it and leaked the date + address through. `[\s\S]{0,400}?` spans the
  // wrap, bounded and non-greedy.
  /\n\s*On\s[\s\S]{0,400}?\bwrote:/i,
  /\n\s*-{2,}\s*\n/,                        // "--" signature separator
  /\n>{1,}/,                                 // quoted block
  /\n\s*From:\s.+/i,                         // Outlook "From:" header block
  /\n\s*_{5,}\s*\n?/,                        // Outlook horizontal rule
  /\n\s*Sent from my /i,                     // iOS / Android mobile signature
  /\n\s*Get Outlook for /i,                  // Outlook mobile signature
];

/**
 * Where the quoted history starts, or -1 when the message is all fresh text.
 *
 * NOTE the `idx > 0` test, which is load-bearing: a message that OPENS with a quote boundary has
 * no fresh text at all, and cutting at 0 would yield an empty string — so those are reported as
 * "no cut" and the caller keeps the whole body. Losing a real message is far worse than keeping
 * some quoted text.
 */
function quoteStart(text) {
  const s = String(text || '').replace(/\r\n/g, '\n');
  let cut = -1;
  for (const p of QUOTE_PATTERNS) {
    const idx = s.search(p);
    if (idx > 0 && (cut === -1 || idx < cut)) cut = idx;
  }
  return cut;
}

/** Just what the person typed. Returns the whole body when no quote boundary is found. */
function topReply(text) {
  const s = String(text || '').replace(/\r\n/g, '\n');
  const cut = quoteStart(s);
  const out = cut > 0 ? s.slice(0, cut) : s;
  // Trim trailing decorative dashes / quote glyphs the cut may leave behind.
  return out.replace(/[—\-\s>]+$/, '').trim();
}

/**
 * Split a reply into `{ reply, quoted, trimmed }`.
 *
 * `trimmed` is false when nothing was cut, which lets a caller store a message unchanged rather
 * than recording a "trimmed" flag on a message that never had a quote in it.
 */
function splitReply(text) {
  const s = String(text || '').replace(/\r\n/g, '\n');
  const cut = quoteStart(s);
  if (cut <= 0) return { reply: s.trim(), quoted: '', trimmed: false };
  const reply = s.slice(0, cut).replace(/[—\-\s>]+$/, '').trim();
  // A cut that leaves NOTHING — or nothing but quote glyphs — is not a cut worth making. Two ways
  // that happens, and both mean the same thing: the message is quoted material all the way up.
  //   · our patterns matched inside the person's own first line;
  //   · the message OPENS with a quoted block ("> …"), because every quote pattern requires a
  //     preceding newline, so the FIRST quoted line always reads as fresh text and the cut lands
  //     at the second one. That is what the leading-">" test catches: a "fresh" part that is
  //     itself a quoted line means there was no fresh part, and answering with that one line
  //     would be worse than useless. A genuine reply never opens with ">".
  // Keeping the whole message is the safe answer: some quoted text on a record is a nuisance,
  // losing what somebody actually wrote is not recoverable.
  if (!reply || /^[>\s—-]*$/.test(reply) || /^\s*>/.test(reply)) return { reply: s.trim(), quoted: '', trimmed: false };
  return { reply, quoted: s.slice(cut).trim(), trimmed: true };
}

/* ═══════════════════════════════════════════════════════════════════════════
   THE HTML SIDE — the same cut, on the body a reader actually looks at.
   ═══════════════════════════════════════════════════════════════════════════
   The plaintext split above is what a PARSER reads. A person in the Email Center
   reads the HTML body, and until now that meant every reply on the closing chain
   rendered the entire history inline — the exact thing the owner described as
   *"messing everything up terribly"*.

   Every mail client wraps the quoted history in its own container, so the cut is a
   container search rather than a line scan. Each pattern below matches a TAG OPEN,
   which is what makes the cut safe: the index already sits on a `<`, so slicing
   there can never land mid-tag or mid-attribute.
*/
const HTML_QUOTE_PATTERNS = [
  /<div[^>]*class="[^"]*gmail_quote/i,          // Gmail (also gmail_quote_container)
  /<div[^>]*id="divRplyFwdMsg"/i,                // Outlook.com / OWA
  /<div[^>]*id="appendonly"/i,                   // Outlook desktop
  /<div[^>]*class="[^"]*yahoo_quoted/i,          // Yahoo
  /<div[^>]*class="[^"]*moz-cite-prefix/i,       // Thunderbird
  /<blockquote[^>]*type="cite"/i,                // Apple Mail
  /<hr[^>]*id="stopSpelling"/i,                  // Outlook's separator rule
];

/** Text with every tag and entity stripped — used only to ask "is there anything here?". */
function htmlHasWords(html) {
  return /[a-z0-9]/i.test(String(html || '').replace(/<[^>]*>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' '));
}

/**
 * Where the quoted history starts in an HTML body, or -1.
 *
 * The EARLIEST container wins, same rule as the plaintext side. Our OWN marker is
 * also honoured — it is printed in every message we send, so a reply quoting us
 * carries it even when the client used a container we do not recognise; the index
 * is walked BACK to the enclosing tag open so the slice stays on a tag boundary,
 * and the walk is ABANDONED rather than guessed at when no clean boundary is in
 * reach (a cut inside a tag would render as visible garbage).
 */
function htmlQuoteStart(html) {
  const s = String(html || '');
  let cut = -1;
  for (const p of HTML_QUOTE_PATTERNS) {
    const idx = s.search(p);
    if (idx > 0 && (cut === -1 || idx < cut)) cut = idx;
  }
  const m = s.search(MARKER_RE);
  if (m > 0) {
    // Walk back to the nearest tag open. 2,000 characters is generous for one
    // wrapper's markup and short enough that we never reach into a different block.
    let i = s.lastIndexOf('<', m);
    const floor = m - 2000;
    while (i > 0 && i >= floor && !/^<\/?[a-zA-Z]/.test(s.slice(i, i + 2))) i = s.lastIndexOf('<', i - 1);
    if (i > 0 && i >= floor && (cut === -1 || i < cut)) cut = i;
  }
  return cut;
}

/**
 * Split an HTML body into `{ reply, quoted, trimmed }` — the same contract, and the
 * same refusal to lose anything: an unrecognised body, or one whose "reply" half
 * turns out to carry no words, comes back whole with `trimmed:false`.
 *
 * The two halves are BOTH returned. Collapsing the history is a reading decision the
 * screen makes; nothing here throws content away, and the record keeps every byte.
 */
function splitReplyHtml(html) {
  const s = String(html || '');
  const cut = htmlQuoteStart(s);
  if (cut <= 0) return { reply: s, quoted: '', trimmed: false };
  const reply = s.slice(0, cut);
  if (!htmlHasWords(reply)) return { reply: s, quoted: '', trimmed: false };
  return { reply, quoted: s.slice(cut), trimmed: true };
}

module.exports = {
  REPLY_MARKER, REPLY_MARKER_PHRASE, topReply, splitReply, quoteStart, MARKER_RE,
  splitReplyHtml, htmlQuoteStart, HTML_QUOTE_PATTERNS,
};
