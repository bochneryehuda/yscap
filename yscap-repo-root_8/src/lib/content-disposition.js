'use strict';

/**
 * THE Content-Disposition HEADER FOR A DOWNLOAD — one definition.
 *
 * WHY THIS EXISTS. A download's filename is built from DATA — a borrower's name, a property
 * address, a report title — and an HTTP header value may only carry characters up to U+00FF.
 * Node does not truncate or escape: `res.setHeader` THROWS `ERR_INVALID_CHAR`, the route's catch
 * turns it into a 500, and the download is permanently impossible for that person. Every
 * character above that ceiling is one somebody genuinely types:
 *
 *   · the curly apostrophe in O’Brien (U+2019 — what Word, iOS and Outlook produce automatically)
 *   · an em dash in a report title (U+2014)
 *   · any name written in Hebrew, Arabic, Chinese, Cyrillic…
 *
 * Found live: the track-record export named its file `<Borrower> — Track Record (Verified).xlsx`
 * and answered 500 on EVERY press, for every borrower (2026-08-21).
 *
 * THE SHAPE IS RFC 6266's, and it needs BOTH halves:
 *   `filename="…"`            — plain ASCII, the fallback every client understands;
 *   `filename*=UTF-8''…`      — percent-encoded UTF-8, which every current browser PREFERS,
 *                               so the reader still gets the real name with its real characters.
 *
 * So the ASCII fold costs nothing a person can see, and it is what keeps the header legal.
 */

/** Characters that would end the header, escape the quoted string, or confuse a client.
 *
 *  HONEST NOTE: the CR/LF and control-character strips here are REDUNDANT TODAY — `asciiFilename`
 *  below folds everything outside printable ASCII, which already covers them, and the RFC 5987
 *  half is percent-encoded. Proven: removing both strips fails nothing; removing the FOLD fails
 *  ten assertions. They are kept because they say what they are for at the point where somebody
 *  editing the fold would otherwise remove the only thing stopping header injection. */
function stripUnsafe(s) {
  return String(s == null ? '' : s)
    .replace(/[\r\n]+/g, ' ')          // a newline would inject a second header
    .replace(/["\\]/g, '')             // would close / escape the quoted parameter
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .trim();
}

/**
 * The ASCII form of a filename — safe in the quoted `filename=` parameter of any header.
 * Every character outside printable ASCII folds to `-`; the extension is preserved because it
 * decides which application opens the file.
 */
function asciiFilename(name) {
  const s = stripUnsafe(name).replace(/[^\x20-\x7E]+/g, '-').replace(/-{2,}/g, '-').trim();
  return s.slice(0, 200) || 'download';
}

/**
 * Build the whole header value.
 *
 * @param {string} filename  the name as a person should see it, in any script
 * @param {object} opts { inline, ascii }  `ascii` overrides the computed fallback for a caller
 *                                         that already has its own (serve-document's `safeName`)
 * @returns {string} e.g. `attachment; filename="Ann O-Brien - Track Record.xlsx"; filename*=UTF-8''…`
 */
function contentDisposition(filename, opts = {}) {
  const real = stripUnsafe(filename).slice(0, 200) || 'download';
  const fallback = asciiFilename(opts.ascii != null ? opts.ascii : real);
  const kind = opts.inline ? 'inline' : 'attachment';
  return `${kind}; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(real)}`;
}

/** Set it, in one call — the shape every download route in this codebase uses. */
function setContentDisposition(res, filename, opts = {}) {
  res.setHeader('Content-Disposition', contentDisposition(filename, opts));
}

module.exports = { contentDisposition, setContentDisposition, asciiFilename, _stripUnsafe: stripUnsafe };
