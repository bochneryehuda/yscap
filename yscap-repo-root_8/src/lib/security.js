/**
 * Baseline security headers for a PII-handling portal — zero dependencies
 * (no helmet). Applied to every response in server.js.
 *
 * Deliberately conservative so it can't break the frozen marketing site or the
 * same-origin tool iframes:
 *   - X-Frame-Options: SAMEORIGIN (NOT DENY) — the portal embeds its own
 *     /tools/*.html in iframes (ToolModal); DENY would break them.
 *   - No global Content-Security-Policy here — the static marketing site uses
 *     inline scripts/styles a strict CSP would break. Document downloads carry
 *     their own strict CSP (src/lib/serve-document.js). A site-wide CSP is a
 *     separate, carefully-tested follow-up.
 */
function securityHeaders(req, res, next) {
  // Stop MIME sniffing (a .txt upload can't be coerced into executing as JS).
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // Clickjacking: only same-origin may frame us (keeps the tool iframes working).
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  // Don't leak full URLs (which can carry ?lo=, tokens in links) to other origins.
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  // Drop powerful features the portal never uses.
  res.setHeader('Permissions-Policy', 'geolocation=(), camera=(), microphone=(self), payment=()');
  // Force HTTPS for a year (prod only — never send HSTS on plain-HTTP local dev,
  // and only when the edge terminated TLS, which Render signals via x-forwarded-proto).
  if (process.env.NODE_ENV === 'production' &&
      (req.secure || req.get('x-forwarded-proto') === 'https')) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
}

module.exports = { securityHeaders };
