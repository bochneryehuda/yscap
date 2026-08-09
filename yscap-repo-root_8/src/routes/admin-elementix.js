'use strict';
/**
 * Admin API for the Elementix connection — mounted at /api/admin/elementix.
 *
 *   GET  /status      — is it connected, does it renew itself, what went wrong
 *   GET  /discover    — ask the endpoint what it supports (read-only, no side effects).
 *                       THIS is what answers "will somebody have to keep clicking
 *                       Approve?" without another email to the vendor.
 *   GET  /connect     — start the one-time approval (redirects the browser to Elementix)
 *   GET  /callback    — Elementix returns here; swaps the code for tokens
 *   POST /disconnect  — forget the stored authorization
 *   GET  /tools       — the tool catalogue, for a "what can this do?" view
 *
 * Everything is gated on `platform_setup`, the capability that already guards the
 * ClickUp / SharePoint control centres — connecting a data vendor on the company's
 * seat is the same class of action.
 *
 * NO SECRET EVER LEAVES THIS ROUTE. `status` reports presence and plain-language
 * state; it never returns a token, and neither does anything else here.
 */

const router = require('../lib/safe-router')();
const db = require('../db');
const { requireAuth, requirePermission } = require('../auth');
const oauth = require('../elementix/oauth');
const client = require('../elementix/client');

router.use(requireAuth, requirePermission('platform_setup'));

async function audit(req, action, detail) {
  try {
    await db.query(
      `INSERT INTO audit_log (actor_kind, actor_id, action, entity_type, entity_id, ip_address, user_agent, detail)
       VALUES ('staff', $1, $2, 'integration', NULL, $3, $4, $5::jsonb)`,
      [req.actor.id, action, req.ip, req.get('user-agent') || null, JSON.stringify(detail || {})]
    );
  } catch (_) { /* best effort — an audit failure must never block the action */ }
}

/** Where the browser lands after an approval. */
function portalReturn(ok, message) {
  const q = new URLSearchParams({ elementix: ok ? 'connected' : 'error', message: String(message || '') });
  return `/portal/#/internal/api-health?${q.toString()}`;
}

router.get('/status', async (req, res) => {
  try {
    const s = await oauth.status();
    res.json({ ...s, budget: client.budget(), redirectUri: oauth.redirectUri(), enabled: client.enabled(), dryRun: client.dryrun() });
  } catch (e) {
    res.status(500).json({ error: 'status_failed', detail: e.message });
  }
});

/**
 * Read-only capability probe. Safe to press as often as anybody likes — it makes
 * no change, spends no credits, and needs no existing connection.
 */
router.get('/discover', async (req, res) => {
  try {
    const d = await oauth.discover();
    const verdict = oauth.unattendedVerdict(d);
    if (!d.ok) return res.json({ ok: false, reason: d.reason, detail: d.detail, unattended: verdict });
    res.json({
      ok: true,
      // Deliberately a summary rather than `raw` — a metadata dump on an admin
      // screen invites somebody to read a client secret out of it one day.
      issuer: d.issuer,
      authorizationEndpoint: d.authorizationEndpoint,
      tokenEndpoint: d.tokenEndpoint,
      supportsSelfRegistration: d.supportsDynamicRegistration,
      supportsPkceS256: d.supportsPkceS256,
      grantTypesSupported: d.grantTypesSupported,
      scopesSupported: d.scopesSupported,
      unattended: verdict,
      redirectUri: oauth.redirectUri(),
    });
  } catch (e) {
    res.status(500).json({ ok: false, reason: 'discover_failed', detail: e.message });
  }
});

router.get('/connect', async (req, res) => {
  try {
    // The company holds ONE Elementix login (owner-directed 2026-08-07), so the
    // default — and currently the only accepted — scope is company-wide.
    // `scope=me` is still mapped rather than ignored, so somebody who asks for a
    // per-officer connection gets `oauth.beginConnect`'s plain refusal saying why,
    // instead of silently getting the company one and believing otherwise.
    const staffId = String(req.query.scope || '') === 'me' ? req.actor.id : null;
    const out = await oauth.beginConnect({ staffId, actorId: req.actor.id });
    if (!out.ok) {
      await audit(req, 'elementix_connect_failed', { reason: out.reason });
      return res.status(400).json({ ok: false, reason: out.reason, detail: out.detail });
    }
    await audit(req, 'elementix_connect_started', { scope: staffId ? 'officer' : 'company', unattended: out.unattended.verdict });
    // Answering with the URL rather than a 302 so the caller can be an admin page
    // doing fetch() — a redirect inside XHR would be followed invisibly.
    res.json({ ok: true, authorizeUrl: out.authorizeUrl, unattended: out.unattended });
  } catch (e) {
    res.status(500).json({ ok: false, reason: 'connect_failed', detail: e.message });
  }
});

/*
 * The RETURN leg (`GET /callback`) is deliberately NOT here — it lives in
 * `admin-elementix-callback.js`, mounted PUBLICLY ahead of this router.
 * Elementix sends the person back by redirecting their browser, which cannot
 * carry the portal's token, so a route behind this file's staff gate could never
 * run: the owner completed the sign-in and got "unauthenticated" instead of a
 * connection (2026-08-09). Its credential is the single-use `state` plus PKCE.
 * Do NOT re-add a `/callback` route to this file.
 */

router.post('/disconnect', async (req, res) => {
  try {
    const staffId = String(req.body && req.body.scope) === 'me' ? req.actor.id : null;
    const out = await oauth.disconnect(staffId);
    await audit(req, 'elementix_disconnected', { scope: staffId ? 'officer' : 'company', removed: out.removed });
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: 'disconnect_failed', detail: e.message });
  }
});

router.get('/tools', async (req, res) => {
  try {
    res.json(await client.listTools());
  } catch (e) {
    res.status(500).json({ ok: false, reason: 'tools_failed', detail: e.message });
  }
});

module.exports = router;
