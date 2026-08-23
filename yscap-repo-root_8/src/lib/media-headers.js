'use strict';
/**
 * Safe response headers — and safe RANGE STREAMING — for stored inspection /
 * appraisal / dispute media served to a browser.
 *
 * WHY THE ALLOWLIST EXISTS (unchanged). These routes hand their bytes to the
 * portal's viewer, which renders them from a blob: URL in the portal ORIGIN, so a
 * response whose declared Content-Type is `text/html` or `image/svg+xml` would
 * execute script with the viewer's session — a stored-XSS vector (audit H1).
 * `X-Content-Type-Options: nosniff` does NOT help when the *declared* type is
 * itself dangerous. So an arbitrary stored type is NEVER echoed inline: only a
 * strict allowlist of real image/video types is served `inline`; everything else
 * is forced to `application/octet-stream` + `attachment`. A restrictive CSP
 * (`default-src 'none'; sandbox`) is belt-and-braces.
 *
 * WHAT IS NEW (owner-reported 2026-08-23: *"the video format is not readable in
 * our system … Right now, those videos are blacked out"*).
 *
 * TWO SEPARATE CAUSES, BOTH FIXED HERE:
 *
 *  1. THE TYPE WAS LOST ON THE WAY IN. An archived Sitewire video's
 *     `content_type` is whatever the inspector's CDN put on the download — and a
 *     pre-signed object store routinely answers `application/octet-stream` (or
 *     nothing) for a perfectly good .mov/.mp4. That type is not on the allowlist,
 *     so this module correctly refused to serve it inline… and the browser
 *     downloaded a file instead of playing a video. The stored label was wrong;
 *     the BYTES were always right. So the type is now derived from the bytes
 *     when the stored label is not itself a safe type. This does NOT widen the
 *     allowlist by one entry: a sniff can only ever resolve to a type already on
 *     it, and anything that does not sniff to a known-safe container is still
 *     forced to `attachment` exactly as before.
 *
 *  2. NO RANGE SUPPORT. A `<video>` element asks for `Range: bytes=0-` and
 *     expects `206 Partial Content`. Served a flat 200 with no `Accept-Ranges`,
 *     Safari and iOS Safari commonly render a black frame and refuse to play,
 *     and no browser can seek. `serveMedia` answers ranges properly.
 *
 * `sniffMediaMime` is pure and unit-tested (scripts/test-media-serve-pure.js).
 */
const SAFE_IMAGE = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp', 'image/heic', 'image/heif']);
const SAFE_VIDEO = new Set(['video/mp4', 'video/quicktime', 'video/webm', 'video/ogg']);

/**
 * The REAL media type from the bytes' magic number, or null when the bytes are
 * not a container we are willing to serve inline.
 *
 * Only ever returns a member of SAFE_IMAGE / SAFE_VIDEO. Unknown bytes, SVG,
 * HTML, PDF and ZIP all return null and are handled as attachments — a sniffer
 * that could invent a new servable type would be a hole, not a fix.
 */
function sniffMediaMime(buf) {
  if (!buf || buf.length < 12) return null;
  const b = buf;
  const ascii = (from, to) => b.subarray(from, to).toString('latin1');

  // --- images -------------------------------------------------------------
  if (b[0] === 0x89 && ascii(1, 4) === 'PNG') return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (ascii(0, 3) === 'GIF') return 'image/gif';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp';

  // --- ISO base media (MP4 / MOV / HEIC all share the `ftyp` box) ----------
  // The MAJOR BRAND at bytes 8..12 is what separates a still image from a video,
  // so it is read rather than assumed — mislabeling a video as a HEIC image (or
  // the reverse) is exactly the bug that produced a black frame.
  if (ascii(4, 8) === 'ftyp') {
    const brand = ascii(8, 12);
    if (/^(heic|heix|heif|hevc|hevx|mif1|msf1)/.test(brand)) return 'image/heic';
    if (/^(qt {0,2})/.test(brand)) return 'video/quicktime';        // QuickTime .mov
    // Everything else with an ftyp box is an MP4 family brand (isom, iso2, mp41,
    // mp42, avc1, M4V, dash, …). MP4 is the correct type for all of them.
    return 'video/mp4';
  }
  // A .mov may also begin with a bare `moov`/`mdat`/`wide`/`free`/`skip` atom.
  if (/^(moov|mdat|wide|free|skip|pnot)$/.test(ascii(4, 8))) return 'video/quicktime';

  // --- WebM / Matroska (EBML magic) ---------------------------------------
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return 'video/webm';
  // --- Ogg ----------------------------------------------------------------
  if (ascii(0, 4) === 'OggS') return 'video/ogg';
  // --- AVI (RIFF container, not on the allowlist → deliberately null) ------

  return null;
}

/**
 * Resolve the type we will actually serve. The stored label wins when it is
 * already a safe type (it is the most specific thing we know); otherwise the
 * bytes decide; otherwise it is an attachment.
 *
 * Returns { type, inline }.
 */
function resolveMediaType(storedType, buf) {
  const ct = String(storedType || '').toLowerCase().split(';')[0].trim();
  if (SAFE_IMAGE.has(ct) || SAFE_VIDEO.has(ct)) return { type: ct, inline: true };
  const sniffed = buf ? sniffMediaMime(buf) : null;
  if (sniffed) return { type: sniffed, inline: true };
  return { type: 'application/octet-stream', inline: false };
}

function setMediaHeaders(res, contentType, buf) {
  const { type, inline } = resolveMediaType(contentType, buf);
  res.setHeader('Content-Type', type);
  res.setHeader('Content-Disposition', inline ? 'inline' : 'attachment');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  res.setHeader('Cache-Control', 'private, max-age=3600');
  return { type, inline };
}

/**
 * Parse one `Range: bytes=a-b` header against a known total size.
 *
 * Returns { start, end } (inclusive, clamped), `null` for "no range asked for",
 * or the string 'unsatisfiable' for a range that cannot be met — which must be
 * answered 416, not silently widened to the whole file. Only a SINGLE range is
 * honoured; a multi-range request falls back to the full body, which is legal
 * and is what every video element in practice needs.
 */
function parseRange(header, size) {
  if (!header || !size) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
  if (!m) return null;
  const hasStart = m[1] !== '';
  const hasEnd = m[2] !== '';
  if (!hasStart && !hasEnd) return null;
  let start;
  let end;
  if (!hasStart) {
    // `bytes=-N` — the last N bytes.
    const n = Number(m[2]);
    if (!Number.isFinite(n) || n <= 0) return 'unsatisfiable';
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = hasEnd ? Number(m[2]) : size - 1;
    if (!Number.isFinite(start) || start < 0 || start >= size) return 'unsatisfiable';
    if (!Number.isFinite(end) || end < start) end = size - 1;
    if (end >= size) end = size - 1;
  }
  return { start, end };
}

/**
 * Serve stored media bytes with the right type and proper range support.
 *
 * The single door every media route uses, so "how do we serve a video" has ONE
 * answer: no route can accidentally serve a video without ranges (a black frame
 * on Safari) or with a lost content type (a download instead of a video).
 */
function serveMedia(req, res, buf, storedType) {
  setMediaHeaders(res, storedType, buf);
  const size = buf.length;
  res.setHeader('Accept-Ranges', 'bytes');

  const range = parseRange(req && req.headers && req.headers.range, size);
  if (range === 'unsatisfiable') {
    res.setHeader('Content-Range', `bytes */${size}`);
    return res.status(416).end();
  }
  if (range) {
    const chunk = buf.subarray(range.start, range.end + 1);
    res.status(206);
    res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${size}`);
    res.setHeader('Content-Length', String(chunk.length));
    return res.end(chunk);
  }
  res.setHeader('Content-Length', String(size));
  return res.end(buf);
}

module.exports = { setMediaHeaders, serveMedia, sniffMediaMime, resolveMediaType, parseRange, SAFE_IMAGE, SAFE_VIDEO };
