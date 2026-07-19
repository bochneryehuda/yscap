/**
 * Public e-signature bounce endpoint — where a signer's browser lands after an
 * embedded signing session (or an email signer via the DocuSign Brand
 * Destination URL). Per docs/DOCUSIGN-REDIRECT-AND-ACCOUNT-SETUP.md.
 *
 * This is a NON-HASH real path (`/api/esign/return`) precisely because the portal
 * is a HashRouter: anything DocuSign appends after our `#…` fragment never
 * reaches the server. So DocuSign returns HERE (query reaches the server), we
 * resolve the true destination from OUR database (never trusting the query as
 * proof of anything), and 302 into the portal's hash route.
 *
 * The redirect is a UI HINT ONLY. Conditions clear solely from the HMAC-verified
 * Connect webhook re-fetching the truth — never from this landing. `event` /
 * `signed` in the target URL just picks the friendly message the page shows.
 */
const router = require('../lib/safe-router')();
const db = require('../db');
const cfg = require('../config');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const portalBase = () => `${cfg.appUrl}${cfg.portalPath}`;   // e.g. https://www.yscapgroup.com/portal

// DocuSign's embedded-signing `event` values → our sanitized landing state.
function landingState(event) {
  switch (String(event || '').toLowerCase()) {
    case 'signing_complete': return 'signed';
    case 'viewing_complete': return 'viewed';
    case 'decline':          return 'declined';
    case 'cancel':           return 'cancelled';
    case 'session_timeout':  return 'timeout';
    case 'ttl_expired':      return 'expired';
    default:                 return event ? 'done' : '';
  }
}

router.get('/return', async (req, res) => {
  const base = portalBase();
  const rawApp = String(req.query.app || '').trim();
  const env = String(req.query.env || req.query.envelopeId || '').trim();
  const dest = String(req.query.dest || '').trim().toLowerCase();   // 'staff' | 'borrower' (UX routing only, never a trust boundary)
  const state = landingState(req.query.event);

  // Resolve the application id from OUR data, not the query. Prefer a valid `app`
  // param, but ALWAYS reconcile it against the envelope row when we have `env` —
  // a mismatched/forged `app` is dropped in favour of the envelope's real owner.
  let appId = UUID_RE.test(rawApp) ? rawApp : null;
  let isStaffDest = dest === 'staff' || dest === 'admin';
  try {
    if (env) {
      const r = await db.query(
        `SELECT application_id, purpose, status FROM esign_envelopes WHERE envelope_id = $1 LIMIT 1`, [env]);
      if (r.rows.length) {
        appId = r.rows[0].application_id;   // the source of truth wins over the query param
      }
    }
  } catch (e) {
    console.warn('[esign-return] lookup failed:', db.describeError ? db.describeError(e) : e.message);
    // fall through — we still redirect somewhere sensible below
  }

  // Build the portal hash target. Staff counter-signers land on the internal file;
  // borrowers land on their own file view. With no resolvable file, go to the
  // dashboard rather than a broken deep link.
  let target;
  if (!appId) {
    target = isStaffDest ? `${base}/#/internal` : `${base}/#/dashboard`;
  } else {
    const path = isStaffDest ? `/#/internal/app/${appId}` : `/#/app/${appId}`;
    const qs = state ? `?esign=${encodeURIComponent(state)}` : '';
    target = `${base}${path}${qs}`;
  }
  return res.redirect(302, target);
});

module.exports = router;
