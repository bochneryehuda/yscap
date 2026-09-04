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
function engineRedirectTarget(portalPath, sub) {
  const portal = String(portalPath || '/portal').replace(/\/+$/, '');
  const base = portal.startsWith('/') ? portal : `/${portal}`;

  /* Split on the separator and rebuild segment by segment, so a segment can
     never carry a separator of its own back into the result. `..` is dropped
     outright rather than sanitised — it is a real path, not a bad character,
     and stripping its dots would silently turn it into an empty segment. */
  const tail = String(sub == null ? '' : sub)
    .split(/[/\\]+/)
    .map((seg) => seg.replace(SAFE_SEGMENT, ''))
    .filter((seg) => seg && seg !== '.' && seg !== '..')
    .join('/');

  return tail ? `${base}/#/engine/${tail}` : `${base}/#/engine`;
}

module.exports = { engineRedirectTarget, _internals: { SAFE_SEGMENT } };
