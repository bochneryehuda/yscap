/**
 * Public e-signature endpoints — no portal session required, because a borrower
 * reaches these straight from an EMAIL. Three routes, all under /api/esign:
 *
 *   GET  /sign            PILOT's own branded "documents ready to sign" email links
 *                         here. We verify the signed magic token, mint a fresh
 *                         embedded DocuSign signing view, and 302 the borrower
 *                         STRAIGHT to the DocuSign envelope — no portal stop, no
 *                         "Sign now" click (owner-directed 2026-07-20).
 *   GET  /return          Where a signer's browser lands after signing (embedded
 *                         return, or DocuSign's Brand Destination URL). Resolves the
 *                         true destination from OUR data and 302s into the portal.
 *                         When the borrower came via PILOT's magic link (a valid
 *                         return-auth token), it hands the SPA a SINGLE-USE login
 *                         code so they land back INSIDE their file already logged in.
 *   POST /claim-session   The SPA exchanges that one-time login code for a real
 *                         borrower session (the only thing that ever mints a session
 *                         out of this flow — short-lived + single-use + DB-backed).
 *
 * The portal is a HashRouter, so anything after our `#…` fragment never reaches the
 * server — every real query (event/env/ra/li) rides on a NON-hash path here, and we
 * 302 into the portal's hash route. A redirect is a UI HINT ONLY: conditions clear
 * solely from the HMAC-verified Connect webhook, never from a landing.
 */
const router = require('../lib/safe-router')();
const db = require('../db');
const cfg = require('../config');
const C = require('../lib/crypto');
const magic = require('../lib/esign/magic-link');
const esignDocusign = require('../lib/integrations/docusign');
const auth = require('../auth');
const { issueEmailToken } = auth;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const portalBase = () => `${cfg.appUrl}${cfg.portalPath}`;   // e.g. https://www.yscapgroup.com/portal

/** Best-effort system audit (never blocks/throws — a failed audit must not break a redirect). */
function sysAudit(action, entityType, entityId, detail, req) {
  const ipRaw = (req && (req.headers['x-forwarded-for'] || (req.socket && req.socket.remoteAddress))) || '';
  const ip = String(ipRaw).split(',')[0].trim() || null;
  db.query(
    `INSERT INTO audit_log (actor_kind, actor_id, action, entity_type, entity_id, ip_address, user_agent, detail)
     VALUES ('system', NULL, $1, $2, $3, $4, $5, $6)`,
    [action, entityType || null, (entityId && UUID_RE.test(String(entityId))) ? entityId : null,
     ip, (req && req.headers['user-agent']) || null, detail ? JSON.stringify(detail) : null]).catch(() => {});
}

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

/* THE COLUMNS THE SIGNING LINK JUDGES ON — one list, both identity branches, so a borrower and
   one of our own can never be judged by different facts.

   `r.status` and `e.status` are BOTH selected, under DISTINCT names, and that is the whole point
   of this constant. They were not: only `e.status` was selected, aliased plainly as `status`, and
   the "can this person still sign?" guard tested it — so the ENVELOPE was being asked a question
   about the RECIPIENT, while the two checks beside it (`signed_at`, `declined_at`) were reading
   recipient columns. `notify-signers.js` gets this right (`r.status AS recipient_status`); this
   route did not. A shared alias is exactly how that happens, so neither is called `status` here. */
const SIGN_REC_COLS = `r.recipient_id_ds, r.name, r.email, r.client_user_id, r.signed_at, r.declined_at,
                r.borrower_id, r.role, r.status AS recipient_status,
                e.envelope_id, e.status AS envelope_status, e.application_id, e.purpose`;

// DocuSign will only open a signing session while BOTH the envelope and this recipient are open.
const OPEN_STATES = ['sent', 'delivered'];
// A recipient row from before recipient statuses were tracked carries none; treat it as open,
// the same historic reading `notify-signers.js` applies.
const recipientOpen = (r) => !r.recipient_status || OPEN_STATES.includes(String(r.recipient_status));
const envelopeOpen = (r) => OPEN_STATES.includes(String(r.envelope_status));

/* WHY A LINK CAN FAIL, IN THE READER'S TERMS. A staff signer who cannot open a session is owed a
   sentence, not a silent bounce — and `who=staff` keeps the landing page correct even before a
   session resolves (UX routing only, never a trust boundary — the same discipline as `dest`). */
function doneUrl(base, { app, state, staff }) {
  const q = new URLSearchParams();
  if (app) q.set('app', String(app));
  if (state) q.set('state', String(state));
  if (staff) q.set('who', 'staff');
  const qs = q.toString();
  return `${base}/#/esign/done${qs ? `?${qs}` : ''}`;
}

/**
 * GET /sign — PILOT's branded "ready to sign" email link. Verify the magic token,
 * confirm the package is still open for THIS recipient, mint a fresh embedded signing
 * view, and 302 straight to DocuSign. Re-mintable: each click makes a new single-use
 * DocuSign view, so an email security-scanner "clicking" the link consumes nothing.
 */
router.get('/sign', async (req, res) => {
  const base = portalBase();
  const claims = magic.verifySigningToken(String(req.query.t || '').trim());
  if (!claims) return res.redirect(302, doneUrl(base, { state: 'expired' }));
  try {
    /* THE RECIPIENT THIS TOKEN NAMES — a borrower, or one of OUR OWN signers (2026-08-21).
       A staff signer's row carries no `borrower_id`, so the borrower match could never find
       one and staff had no PILOT link at all; they received DocuSign's email, which is the
       one the owner asked to stop. The two branches are mutually exclusive by construction
       (`verifySigningToken` refuses a token naming both or neither) and each pins the
       recipient to the identity in the token — a borrower's token can never open a staff
       signer's session on the envelope, or the reverse. */
    const rec = claims.borrowerId
      ? (await db.query(
        `SELECT ${SIGN_REC_COLS}
           FROM esign_recipients r JOIN esign_envelopes e ON e.id = r.envelope_row_id
          WHERE e.id = $1 AND r.recipient_id_ds = $2 AND r.borrower_id = $3
          LIMIT 1`, [claims.envelopeRowId, claims.recipientIdDs, claims.borrowerId])).rows[0]
      : (await db.query(
        `SELECT ${SIGN_REC_COLS}
           FROM esign_recipients r
           JOIN esign_envelopes e ON e.id = r.envelope_row_id
           JOIN staff_users su ON lower(su.email) = lower(r.email)
          WHERE e.id = $1 AND r.recipient_id_ds = $2
            AND r.borrower_id IS NULL
            AND su.id = $3::uuid AND su.is_active = true
          LIMIT 1`, [claims.envelopeRowId, claims.recipientIdDs, claims.staffId])).rows[0];
    const isStaffSigner0 = !!claims.staffId;
    if (!rec || !rec.envelope_id) return res.redirect(302, doneUrl(base, { state: 'notready', staff: isStaffSigner0 }));
    let signer = rec;
    const appId = rec.application_id;

    // THIS PERSON HAS ALREADY ANSWERED. Nothing to reopen, on this envelope or a later one.
    if (rec.signed_at || rec.declined_at) {
      return res.redirect(302, doneUrl(base, { app: appId, state: 'already', staff: isStaffSigner0 }));
    }

    /* THE LINK OUTLIVED ITS ENVELOPE — FOLLOW IT TO THE ONE THAT IS LIVE (owner-directed
       2026-08-24: "You need to fix this signature button to map him directly to sign the term
       sheet ... on previous files, if I go and I click the Resend button, it will actually
       resend them an email that should actually take him to DocuSign because he can't sign it").
       Clicking Resend was the workaround for exactly this: a package that is VOIDED, CLEARED or
       RE-ISSUED leaves the emailed link pointing at a dead envelope, and every click landed on a
       page that said nothing useful. The signer has not changed and the file has not changed —
       only the envelope generation has — so the honest answer is to open the CURRENT package
       rather than send them back to ask for another email.

       IT WIDENS NOTHING. The token already proves this exact identity is a signer on this file's
       package; the follow-up requires the SAME application, the SAME purpose, the SAME identity
       (a borrower by id, one of ours by an ACTIVE roster row), that they have neither signed nor
       declined, and that both the envelope and their own recipient row are open. It can only ever
       move them from a dead envelope to the live one for the same signature. */
    if (!envelopeOpen(rec) || !recipientOpen(rec)) {
      const live = appId ? (await db.query(
        `SELECT ${SIGN_REC_COLS}
           FROM esign_recipients r
           JOIN esign_envelopes e ON e.id = r.envelope_row_id
      LEFT JOIN staff_users su ON lower(su.email) = lower(r.email) AND su.is_active = true
          WHERE e.application_id = $1
            AND e.purpose        = $2
            AND e.id            <> $3
            AND e.envelope_id IS NOT NULL
            AND e.cleared_at  IS NULL
            AND e.status = ANY($4)
            AND r.signed_at   IS NULL
            AND r.declined_at IS NULL
            AND (r.status IS NULL OR r.status = ANY($4))
            AND ((                 $5::uuid IS NOT NULL AND r.borrower_id = $5::uuid)
              OR ($6::uuid IS NOT NULL AND r.borrower_id IS NULL AND su.id = $6::uuid))
       ORDER BY e.sent_at DESC NULLS LAST, e.created_at DESC
          LIMIT 1`,
        [appId, rec.purpose, claims.envelopeRowId, OPEN_STATES,
         claims.borrowerId || null, claims.staffId || null])).rows[0] : null;

      if (!live || !live.envelope_id) {
        // Nothing live to open. SAY WHICH — "this package was replaced" and "you have already
        // signed" send the reader to two different places, and a single word for both is what
        // made this a dead end.
        return res.redirect(302, doneUrl(base, { app: appId, state: 'superseded', staff: isStaffSigner0 }));
      }
      signer = live;
      sysAudit('esign_magic_sign_followed', 'application', appId,
        { from: claims.envelopeRowId, toEnvelope: live.envelope_id, purpose: rec.purpose }, req);
    }
    // Thread a short-lived return-authorization so the /return bounce can log them
    // back in AFTER they sign, then mint the embedded signing view.
    /* AFTER SIGNING, WHERE DO THEY LAND? A BORROWER is bounced back into their own file
       already logged in — that hand-off is what the return-auth token exists for. A STAFF
       signer is NOT: an email link may never mint an internal console session, so they land on
       the file's page and sign in the way they always do. Deliberately narrower than the
       borrower path, and it must stay that way. */
    // EVERY FIELD BELOW COMES FROM `signer`, never `rec` — on a followed link they are different
    // envelopes, and DocuSign refuses a view built from one envelope's recipient ids against
    // another's. `rec` is only ever the token's own row from here on.
    const isStaffSigner = !signer.borrower_id;
    const ra = isStaffSigner ? null : magic.mintReturnAuth({ borrowerId: signer.borrower_id, applicationId: appId });
    const returnUrl = `${cfg.appUrl}/api/esign/return?app=${encodeURIComponent(appId || '')}`
      + `&env=${encodeURIComponent(signer.envelope_id)}`
      + (isStaffSigner ? '&dest=staff' : `&dest=borrower&ra=${encodeURIComponent(ra)}`);
    const url = await esignDocusign.createRecipientView(signer.envelope_id, {
      returnUrl, email: signer.email, userName: signer.name,
      clientUserId: signer.client_user_id, recipientId: signer.recipient_id_ds,
    });
    sysAudit('esign_magic_sign_open', 'application', appId, { envelopeRowId: claims.envelopeRowId }, req);
    return res.redirect(302, url);
  } catch (e) {
    console.warn('[esign-sign] failed:', db.describeError ? db.describeError(e) : e.message);
    return res.redirect(302, doneUrl(base, { state: 'error', staff: !!(claims && claims.staffId) }));
  }
});

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

  // A borrower returning from PILOT's magic-link signing carries a return-auth token.
  // If it's valid AND the resolved envelope really belongs to that borrower, hand the
  // SPA a SINGLE-USE login code so they land back INSIDE their loan file already
  // logged in (owner-directed 2026-07-20). Anything less than a clean match falls
  // through to the normal (already-logged-in embedded / staff) landing below.
  const ra = magic.verifyReturnAuth(String(req.query.ra || ''));
  if (ra && ra.jti && appId && env) {
    try {
      const owns = await db.query(
        `SELECT 1 FROM esign_recipients r JOIN esign_envelopes e ON e.id = r.envelope_row_id
          WHERE e.envelope_id = $1 AND r.borrower_id = $2 LIMIT 1`, [env, ra.borrowerId]);
      // ONE-SHOT the handoff: a return-auth token rides in the returnUrl (browser
      // history / any proxy log), so it MUST mint a login code at most once — otherwise
      // a captured returnUrl could be replayed for the token's whole life to keep
      // minting borrower sessions. ATOMICALLY claim the token's jti as an already-used
      // email_tokens('login') marker (never itself claimable) — uq_email_tokens_login_hash
      // makes it race-free — and mint the login code ONLY if WE won the insert.
      let won = false;
      if (owns.rows.length) {
        const jtiHash = C.sha256('esign_ra:' + ra.jti);
        const claim = await db.query(
          `INSERT INTO email_tokens (borrower_id, kind, token_hash, expires_at, used_at)
           VALUES ($1, 'login', $2, now() + interval '20 minutes', now())
           ON CONFLICT (token_hash) WHERE kind = 'login' AND token_hash IS NOT NULL DO NOTHING
           RETURNING id`, [ra.borrowerId, jtiHash]);
        won = claim.rowCount === 1;
      }
      if (won) {
        const { token: code } = await issueEmailToken({ borrowerId: ra.borrowerId, kind: 'login', ttlMin: 15, withToken: true });
        sysAudit('esign_login_handoff', 'borrower', ra.borrowerId, { app: appId }, req);
        const q = `?app=${encodeURIComponent(appId)}&state=${encodeURIComponent(state || 'signed')}&li=${encodeURIComponent(code)}`;
        return res.redirect(302, `${base}/#/esign/done${q}`);
      }
      // Not a recipient, or the jti was already consumed (a replay) → fall through to
      // the plain file landing (no new login code); they sign in normally.
    } catch (e) {
      console.warn('[esign-return] login handoff failed:', db.describeError ? db.describeError(e) : e.message);
      // fall through — still land them somewhere sensible (they may already be logged in)
    }
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

/**
 * POST /claim-session — the SPA exchanges the one-time login code (from /return's
 * magic-link handoff) for a real borrower session. Single-use + short-lived + DB-
 * backed: even if the code leaked from the URL, it's already consumed and expired.
 */
router.post('/claim-session', async (req, res) => {
  try {
    const raw = String((req.body && (req.body.li || req.body.code)) || '').trim();
    if (!raw) return res.status(400).json({ error: 'missing code' });
    const row = (await db.query(
      `SELECT id, borrower_id FROM email_tokens
        WHERE kind = 'login' AND token_hash = $1 AND used_at IS NULL AND expires_at > now()
        LIMIT 1`, [C.sha256(raw)])).rows[0];
    if (!row || !row.borrower_id)
      return res.status(400).json({ error: 'This sign-in link has expired — please sign in to view your file.' });
    // Consume atomically (single-use) — the UPDATE's rowCount is the race guard.
    const consumed = await db.query(`UPDATE email_tokens SET used_at = now() WHERE id = $1 AND used_at IS NULL`, [row.id]);
    if (!consumed.rowCount) return res.status(400).json({ error: 'This sign-in link was already used.' });
    const token = await auth.mintBorrowerSession(row.borrower_id);
    if (!token) return res.status(400).json({ error: 'Could not sign you in — please sign in manually.' });
    sysAudit('esign_session_claim', 'borrower', row.borrower_id, {}, req);
    return res.json({ token });
  } catch (e) {
    console.warn('[esign-claim] failed:', db.describeError ? db.describeError(e) : e.message);
    return res.status(500).json({ error: 'server error' });
  }
});

module.exports = router;
