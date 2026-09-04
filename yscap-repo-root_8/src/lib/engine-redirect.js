'use strict';

/**
 * PILOT ENGINE — where `/engine` sends a browser.
 *
 * Owner-directed 2026-09-04: *"just to have a straight URL that will take them
 * directly to our pricing engine… a direct URL that I can place on my
 * bookmark."*
 *
 * PURE — no requires, no config, no request object — so every rule below is
 * unit-testable by CALLING it. A regex over `server.js` could only ever pin the
 * spelling of the redirect; this can be handed hostile input and asked what it
 * answers, which is the only thing that proves an open redirect is impossible.
 *
 * ⛔ THE TAIL IS REBUILT, NEVER ECHOED. An open redirect is a phishing
 * primitive: a link on our own domain that lands the visitor on somebody
 * else's login page. The sub-path is stripped to the characters a route can
 * legitimately contain, so a scheme (`:`), a protocol-relative host (`//`), a
 * query (`?`), a second fragment (`#`), a backslash (which several browsers
 * read as a slash) and a parent-directory hop (`..`) can none of them survive.
 */

/** The characters a `/engine/...` sub-path may contain. Everything else goes. */
const SAFE_SEGMENT = /[^A-Za-z0-9_-]/g;

/**
 * Build the portal address for an engine sub-path.
 *
 * @param {string} portalPath  where the SPA is served from (`cfg.portalPath`)
 * @param {string} sub         the matched tail, e.g. `/scenarios` — may be
 *                             anything at all; it is never trusted.
 * @returns {string} a path on THIS origin, always beginning with the portal
 *                   path, always naming an `/engine` route.
 */
/** A portal path we are willing to emit: one leading slash, then path characters. */
const SAFE_BASE = /^\/(?!.*\.\.)[A-Za-z0-9_.\-/]*$/;

function engineRedirectTarget(portalPath, sub) {
  /* ⛔ THE PORTAL PATH IS SANITISED HERE TOO, not only the tail. It comes from
     config rather than from the request, and `src/config.js` does strip it — but
     the promise this module makes ("a path on THIS origin") then depended on a
     DIFFERENT file, which is the two-definitions shape that goes wrong the day
     somebody edits the other one. A pre-merge audit demonstrated the gap:
     `engineRedirectTarget('//evil.example.com', '/x')` answered
     `//evil.example.com/#/engine/x` — a protocol-relative URL, i.e. a redirect
     off this origin. Refused now, with the real portal path as the fallback. */
  const raw = String(portalPath == null ? '' : portalPath).replace(/\/+$/, '');
  const withSlash = raw && !raw.startsWith('/') ? `/${raw}` : raw;
  const safe = SAFE_BASE.test(withSlash) && !withSlash.startsWith('//');
  /* A DOT IS ALLOWED (`/portal.v2` is a legal PORTAL_PATH and config permits
     one), `..` never is. And a refusal SAYS SO: falling back silently would
     send every engine bookmark to a path that does not exist on a deployment
     whose portal path this rejects, with nothing anywhere explaining why. */
  if (!safe && withSlash) {
    try { console.warn('[engine-redirect] refusing portal path %j — using /portal', portalPath); } catch { /* never throw for a log */ }
  }
  const base = safe ? withSlash : '/portal';

  /* Split on the separator and rebuild segment by segment, so a segment can
     never carry a separator of its own back into the result.

     THE DOT TEST RUNS BEFORE THE STRIP, and that ordering is the whole of it. A
     pre-merge audit found it running AFTER, where it was DEAD CODE saying the
     opposite of what happened: `.` and `..` are not in the allowlist, so the
     strip had already turned them into empty segments and the truthiness check
     was quietly doing the work. Harmless then, wrong the moment somebody widens
     the allowlist to include a dot — at which point `..` would survive. Asked
     first, it is a real refusal. */
  const tail = String(sub == null ? '' : sub)
    .split(/[/\\]+/)
    .filter((seg) => seg && seg !== '.' && seg !== '..')
    .map((seg) => seg.replace(SAFE_SEGMENT, ''))
    .filter(Boolean)
    .join('/');

  return tail ? `${base}/#/engine/${tail}` : `${base}/#/engine`;
}

module.exports = { engineRedirectTarget, _internals: { SAFE_SEGMENT, SAFE_BASE } };
