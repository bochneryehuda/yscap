'use strict';
/**
 * The Elementix approval RETURN LEG — mounted PUBLICLY at
 * /api/admin/elementix/callback, deliberately outside the staff gate.
 *
 * WHY THIS IS ITS OWN FILE, AND WHY IT IS PUBLIC (owner-reported 2026-08-09).
 * The first cut put this route inside `admin-elementix.js`, which is mounted
 * behind `requireAuth, requireStaff` in server.js AND applies its own
 * `router.use(requireAuth, requirePermission('platform_setup'))`. That is right
 * for every other route in that file and WRONG for this one, because ELEMENTIX
 * sends the person here — a plain top-level browser navigation, from another
 * origin, carrying no Authorization header. The portal keeps its token in
 * localStorage and attaches it to fetch calls; a browser redirect cannot carry
 * it. So the approval could never complete: the owner signed in at Elementix,
 * was sent back, and the screen answered
 *   {"error":"unauthenticated","code":"bad_token","session":"invalid"}
 * while the pending approval sat in the database untouched. An OAuth callback
 * is a redirect target, not an API call — gating it on a session it structurally
 * cannot have makes the whole connection unreachable.
 *
 * THE CREDENTIAL HERE IS `state`, NOT A LOGIN, and that is the standard design:
 *   · 24 random bytes (192 bits) minted by `beginConnect` — unguessable.
 *   · SINGLE USE — `completeConnect` claims it with DELETE … RETURNING, so a
 *     replayed link finds nothing and is refused.
 *   · EXPIRING — 15 minutes (`PENDING_TTL_SEC`).
 *   · It names its own row, which carries who started the approval, the seat it
 *     was for, the endpoints and the PKCE verifier.
 * PKCE is what closes the remaining attack: the token exchange sends a verifier
 * that never leaves our database, so a code minted for somebody else's session
 * cannot be swapped for a token against our pending row. Without that, a public
 * callback would be a way to plant an attacker's authorization on the company
 * connection; with it, holding the code is not enough.
 *
 * A rate limit is applied at the mount (server.js) — not because the state is
 * guessable, but so this door can never be used to hammer the token endpoint.
 *
 * Everything else about the connection (start, status, discover, disconnect,
 * tools) stays in `admin-elementix.js` behind `platform_setup`. Do NOT move any
 * of those here, and do NOT re-add a `/callback` there.
 */

const router = require('../lib/safe-router')();
const db = require('../db');
const oauth = require('../elementix/oauth');

/**
 * The audit row is attributed to the staff member who STARTED the approval —
 * which `completeConnect` reads off the pending row — because there is no
 * session here to attribute it to. That is better provenance than a session
 * would have given us anyway: it records who chose to connect, not who happened
 * to have the browser open. With nothing to attribute (a denial, or a state that
 * had already expired) it is recorded as the system's own action.
 */
async function audit(req, action, detail, startedBy) {
  try {
    await db.query(
      `INSERT INTO audit_log (actor_kind, actor_id, action, entity_type, entity_id, ip_address, user_agent, detail)
       VALUES ($1, $2, $3, 'integration', NULL, $4, $5, $6::jsonb)`,
      [startedBy ? 'staff' : 'system', startedBy || null, action,
        req.ip, req.get('user-agent') || null, JSON.stringify(detail || {})]
    );
  } catch (_) { /* best effort — an audit failure must never break the approval */ }
}

/** Where the browser lands afterwards; the API Health page reads these and says what happened. */
function portalReturn(ok, message) {
  const q = new URLSearchParams({ elementix: ok ? 'connected' : 'error', message: String(message || '') });
  return `/portal/#/internal/api-health?${q.toString()}`;
}

router.get('/', async (req, res) => {
  const { code, state, error, error_description: errDesc } = req.query || {};

  // Elementix can send the person back having REFUSED. That is not our error and
  // there is no code to exchange — say so plainly and stop.
  if (error) {
    await audit(req, 'elementix_connect_denied', { error: String(error) }, null);
    return res.redirect(portalReturn(false, errDesc || error));
  }

  try {
    const out = await oauth.completeConnect({ code, state });
    if (!out.ok) {
      await audit(req, 'elementix_connect_failed', { reason: out.reason }, out.startedBy);
      return res.redirect(portalReturn(false, out.detail || out.reason));
    }
    await audit(req, 'elementix_connected', { selfRenewing: out.selfRenewing }, out.startedBy);
    res.redirect(portalReturn(true, out.detail));
  } catch (e) {
    // NEVER leave the person on a raw error page: they are mid-way through a
    // connection and the only thing they can act on is the API Health screen.
    res.redirect(portalReturn(false, (e && e.message) || 'The connection could not be completed.'));
  }
});

module.exports = router;
