/**
 * REPLY QUOTING — the ONE definition of "where does this person's own reply end,
 * and where does the quoted history begin?"
 *
 * Owner-reported 2026-08-07, about the "New reply on a loan file" email: "It's a
 * very old timer email. It's using the old, old, old way of emails, where it has
 * every reply in the bottom in lines… it shouldn't sound so outdated with all this
 * text from all the previous emails… when we get this notification that somebody
 * replied, also in the chat within the system, we should only see their reply. We
 * shouldn't see all the old messages, because it should realize that this is
 * anything above the three dots."
 *
 * WHAT THE OWNER IS DESCRIBING, in mail-client terms. A modern client sends a reply
 * as [the freshly typed text] followed by the whole previous conversation wrapped in
 * a quote container — `<div class="gmail_quote">` + `<blockquote>` in Gmail/Apple
 * Mail, `<div id="appendonsend">` after a horizontal rule in Outlook, `>`-prefixed
 * lines in plain text. Gmail then renders that container as the little **three-dots**
 * button ("Show trimmed content"), which is exactly the "three dots" in the report:
 * the reply reads as one short message and the history is one click away. PILOT was
 * doing neither half — it printed the WHOLE raw body as flat lines, so every email
 * grew by one copy of the thread, and the chat inside the system showed the same
 * wall.
 *
 * ROOT CAUSE, and it is a placement problem rather than a missing feature: the
 * stripper AND the reply delimiter already existed — `topReply()` and
 * `CHAT_REPLY_MARKER_PHRASE` — but `topReply` lived inside `routes/inbound-chat.js`,
 * a ROUTE module, so it could only ever apply to the `chat+` family. The three other
 * inbound families all arrive through `lib/file-inbox.js`, which never stripped
 * anything: the file thread (`file+`), the vendor order returns (`title+` /
 * `insurance+`) and the closing chain (`closing+`). So this module is that logic
 * lifted OUT of the route into the library, where every family reaches it, and
 * `inbound-chat.js` now delegates here — one definition, so a pattern added for one
 * family fixes all four at once.
 *
 * THREE HARD RULES, each of which is a way this can do real damage:
 *
 *  1. **NOTHING IS DISCARDED.** `splitQuoted` returns BOTH halves and every caller
 *     keeps the quoted part — collapsed, behind a summary, or in the stored body.
 *     A vendor pastes wire instructions under an attribution line more often than
 *     anyone would like; a stripper that deletes is a stripper that loses a document.
 *  2. **AN EMPTY REPLY IS NEVER THE ANSWER.** If the cut leaves nothing but
 *     whitespace, the FULL text is returned unchanged. A message shown with its
 *     history attached is untidy; a message shown as blank is gone. Every ambiguity
 *     here resolves toward keeping text.
 *  3. **THE MARKER PHRASE IS A CONTRACT.** `REPLY_MARKER_PHRASE` is the exact token
 *     our outbound emails print and this parser cuts on. It is deliberately the SAME
 *     string chat.js has always used, so the change cannot orphan a chat thread
 *     already in flight, and `lib/chat.js` re-exports it rather than declaring a
 *     second copy. Never reword it without changing both sides in one commit.
 *
 * PURE — no DB, no network, no config. Unit-tested by
 * scripts/test-email-quote-pure.js.
 */

/** The stable token our outbound emails print and this parser cuts on. Verbatim in
    HTML and in plain text; see the contract rule above. */
const REPLY_MARKER_PHRASE = 'Reply above this line';

/** The phrase as a matcher, escaped from the token above so the two can never drift. Used by
    the HTML splitter's last-resort boundary; the text side builds its own from the same token. */
const MARKER_RE = new RegExp(REPLY_MARKER_PHRASE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');

/**
 * The decorated delimiter line, for a given audience wording. Printed at the TOP of
 * the message content, which is what puts it just BELOW the recipient's fresh reply
 * once their client quotes our email underneath it.
 * @param {string} [tail] what replying achieves, e.g. "and it reaches the whole loan team"
 */
function replyMarker(tail) {
  const t = tail ? ` ${String(tail).trim()}` : '';
  return `— — — — —  ${REPLY_MARKER_PHRASE}${t}  — — — — —`;
}

/**
 * WHERE THE QUOTED HISTORY STARTS, in PLAIN TEXT — every boundary a mail client in
 * real use produces. The EARLIEST match wins, because clients stack them: Gmail puts
 * its own "On … wrote:" attribution ABOVE our marker, so taking the minimum index
 * keeps the reply clean either way.
 *
 * Each entry requires a preceding newline, so a boundary phrase that happens to open
 * the message cannot swallow the whole thing.
 */
const QUOTE_BOUNDARIES = [
  // Our own delimiter. Escaped because it is otherwise a plain phrase.
  new RegExp(`\\n[\\s\\S]{0,80}?${REPLY_MARKER_PHRASE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i'),
  // Gmail / Apple Mail attribution — "On <date>, <name> <email> wrote:". Gmail WRAPS
  // this across lines when it is long (the "…<email>" ends one line and "wrote:"
  // starts the next), so a single-line `.` missed it and leaked the date + address
  // through. `[\s\S]{0,400}?` spans the wrap, bounded and non-greedy.
  /\n\s*On\s[\s\S]{0,400}?\bwrote:/i,
  // Outlook's own separators. "-----Original Message-----" is the classic; the
  // underscore rule is what Outlook for Windows draws above the quoted headers.
  /\n\s*-{2,}\s*Original Message\s*-{0,}/i,
  /\n\s*_{5,}\s*\n?/,
  // The Outlook header block. Anchored on "From:" at the start of a line — a
  // sentence containing the word "from" is not a header.
  /\n\s*From:\s.+/i,
  // A "--" signature separator, and a `>`-quoted block.
  /\n\s*-{2,}\s*\n/,
  /\n>{1,}/,
  // Mobile signatures — noise, and always terminal.
  /\n\s*Sent from my /i,
  /\n\s*Get Outlook for /i,
];

/**
 * Split a plain-text reply into what this person typed and the history under it.
 *
 * @param {string} text
 * @returns {{reply:string, quoted:string, trimmed:boolean}}
 *   `trimmed` is false when nothing was cut — which is also what a caller must show
 *   when the cut would have left an empty reply (rule 2).
 */
function splitQuoted(text) {
  const s = String(text == null ? '' : text).replace(/\r\n/g, '\n');
  let cut = -1;
  for (const p of QUOTE_BOUNDARIES) {
    const idx = s.search(p);
    if (idx > 0 && (cut === -1 || idx < cut)) cut = idx;
  }
  if (cut <= 0) return { reply: s.trim(), quoted: '', trimmed: false };
  // Trim the decorative dashes / quote glyphs the cut can leave dangling.
  const reply = s.slice(0, cut).replace(/[—\-\s>]+$/, '').trim();
  const quoted = s.slice(cut).trim();
  // RULE 2 — never hand back an empty reply. A message whose every line looked like
  // a boundary is far more likely to be a message we mis-read than a message with
  // nothing in it.
  if (!reply) return { reply: s.trim(), quoted: '', trimmed: false };
  return { reply, quoted, trimmed: !!quoted };
}

/** Just this person's own words. Falls back to the whole text (rule 2). */
function stripQuoted(text) { return splitQuoted(text).reply; }

/**
 * WHERE THE QUOTED HISTORY STARTS, in HTML. Cutting the markup is strictly better
 * than converting to text and guessing, because a modern client TELLS us where the
 * quote begins — these container hooks are how the client's own "three dots" is
 * driven. Used before an html→text conversion so the text stripper is a backstop
 * rather than the first line of defence.
 */
const HTML_QUOTE_BOUNDARIES = [
  /<div[^>]*class=["'][^"']*gmail_quote/i,       // Gmail / Apple Mail / most webmail
  /<div[^>]*id=["']appendonsend["']/i,           // Outlook (modern)
  /<div[^>]*id=["']divRplyFwdMsg["']/i,          // Outlook (reply/forward header)
  /<hr[^>]*id=["']stopSpelling["']/i,            // Outlook (the rule above the quote)
  /<blockquote[^>]*type=["']cite["']/i,          // Apple Mail / Thunderbird
  /<div[^>]*class=["'][^"']*moz-cite-prefix/i,   // Thunderbird
  /<blockquote[^>]*class=["'][^"']*gmail_quote/i,
  /<div[^>]*class=["'][^"']*yahoo_quoted/i,      // Yahoo Mail
];

/** Is there anything a reader would call content here? Tags AND entities are removed first,
    then we ask for a real letter or digit — `&nbsp;` is whitespace to a person, not a word. */
function htmlHasWords(html) {
  return /[a-z0-9]/i.test(String(html || '').replace(/<[^>]*>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' '));
}

/**
 * Split an HTML reply on its own quote container.
 * @returns {{reply:string, quoted:string, trimmed:boolean}}
 */
function splitQuotedHtml(html) {
  const s = String(html == null ? '' : html);
  let cut = -1;
  for (const p of HTML_QUOTE_BOUNDARIES) {
    const idx = s.search(p);
    if (idx > 0 && (cut === -1 || idx < cut)) cut = idx;
  }
  /* OUR OWN DELIMITER IS THE LAST RESORT, and it is the one that works when the client's
     wrapper is one we have never seen. The text side already cuts on this phrase; the HTML
     side must too, or a reply from an unknown client comes through whole.

     It cannot be sliced AT the phrase — that lands mid-tag and yields broken markup — so we
     WALK BACK to the nearest tag open. 2,000 characters is generous for one wrapper's markup
     and short enough that we never reach into a different block. If no clean boundary is in
     reach the marker is ABANDONED rather than guessed at: showing the whole message is a
     cosmetic problem, emitting malformed HTML into the reader is not. */
  const m = s.search(MARKER_RE);
  if (m > 0) {
    let i = s.lastIndexOf('<', m);
    const floor = m - 2000;
    while (i > 0 && i >= floor && !/^<\/?[a-zA-Z]/.test(s.slice(i, i + 2))) i = s.lastIndexOf('<', i - 1);
    if (i > 0 && i >= floor && (cut === -1 || i < cut)) cut = i;
  }
  if (cut <= 0) return { reply: s, quoted: '', trimmed: false };
  const reply = s.slice(0, cut);
  /* RULE 2, again: a quote container that opens the body (a forward with no comment)
     means the quote IS the message.

     ENTITIES ARE STRIPPED BEFORE ASKING. A reply of `<div><br></div><div>&nbsp;</div>`
     is empty to a reader, but tag-stripping alone leaves the literal text "&nbsp;", whose
     letters read as content — so the message was trimmed down to nothing visible and the
     real text was pushed behind the three dots. Ask for an actual letter or digit AFTER
     both tags and entities are gone. */
  if (!htmlHasWords(reply)) return { reply: s, quoted: '', trimmed: false };
  return { reply, quoted: s.slice(cut), trimmed: true };
}

/**
 * OUR OWN QUOTED HISTORY, in the shape every mail client collapses.
 *
 * When PILOT quotes a previous message it must use the SAME container the clients
 * use, for two reasons: the recipient's client renders it as the three-dots
 * "show trimmed content" control rather than as pages of visible text, and — the
 * half the owner asked for — their client puts their own reply ABOVE it, because
 * that is what a recognised quote container means. Hand-rolling `> ` lines is
 * precisely the "old, old, old way" that was reported.
 *
 * `attribution` is the conventional one-liner ("On <date> <who> wrote:"). Both
 * arguments are HTML-escaped: this renders text a stranger sent us.
 */
function quoteBlockHtml(attribution, bodyText) {
  const body = String(bodyText == null ? '' : bodyText);
  if (!body.trim()) return '';
  const attr = attribution
    ? `<div dir="ltr" class="gmail_attr" style="font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#4B585C;margin:0 0 6px;">${esc(attribution)}</div>`
    : '';
  return '<div class="gmail_quote">' + attr +
    '<blockquote class="gmail_quote" type="cite" ' +
      'style="margin:0 0 0 .8ex;border-left:2px solid #EAE4D7;padding-left:1ex;' +
      'font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:1.5;color:#4B585C;' +
      'white-space:pre-wrap;">' + esc(body) + '</blockquote></div>';
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * The conventional attribution line for a message we are quoting back.
 * Calendar-safe: the date is formatted from whatever we were handed and a bad value
 * simply drops out rather than printing "Invalid Date" to an outside party.
 */
function attributionLine(who, when) {
  const parts = [];
  if (when) {
    const d = when instanceof Date ? when : new Date(when);
    if (!Number.isNaN(d.getTime())) {
      parts.push(d.toLocaleString('en-US', {
        weekday: 'short', year: 'numeric', month: 'short', day: 'numeric',
        hour: 'numeric', minute: '2-digit',
      }));
    }
  }
  const w = String(who || '').trim();
  if (!parts.length) return w ? `${w} wrote:` : '';
  return w ? `On ${parts[0]}, ${w} wrote:` : `On ${parts[0]}, they wrote:`;
}

module.exports = {
  REPLY_MARKER_PHRASE, replyMarker,
  splitQuoted, stripQuoted, splitQuotedHtml,
  quoteBlockHtml, attributionLine,
  _internals: { QUOTE_BOUNDARIES, HTML_QUOTE_BOUNDARIES, esc },
};
