'use strict';
/**
 * Safe response headers for streaming stored inspection / dispute-evidence bytes to a browser tab.
 *
 * These media routes hand their blob to the portal's `openBlob` (a top-level navigation to a
 * blob: URL in the portal ORIGIN), so a response whose declared Content-Type is `text/html` or
 * `image/svg+xml` would execute script with the viewer's session — a stored-XSS vector (audit H1).
 * `X-Content-Type-Options: nosniff` does NOT help when the *declared* type is itself dangerous.
 *
 * So we NEVER echo an arbitrary stored/borrower-supplied type inline: only a strict allowlist of
 * real image/video types is served `inline`; everything else is forced to
 * `application/octet-stream` + `attachment` (downloaded, never rendered). A restrictive CSP
 * (`default-src 'none'; sandbox`) is belt-and-suspenders — even a mislabeled document can't run
 * script or fetch anything.
 */
const SAFE_IMAGE = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp', 'image/heic', 'image/heif']);
const SAFE_VIDEO = new Set(['video/mp4', 'video/quicktime', 'video/webm', 'video/ogg']);

function setMediaHeaders(res, contentType) {
  const ct = String(contentType || '').toLowerCase().split(';')[0].trim();
  const safeInline = SAFE_IMAGE.has(ct) || SAFE_VIDEO.has(ct);
  res.setHeader('Content-Type', safeInline ? ct : 'application/octet-stream');
  res.setHeader('Content-Disposition', safeInline ? 'inline' : 'attachment');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  res.setHeader('Cache-Control', 'private, max-age=3600');
}

module.exports = { setMediaHeaders, SAFE_IMAGE, SAFE_VIDEO };
