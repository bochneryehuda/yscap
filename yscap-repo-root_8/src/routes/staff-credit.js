'use strict';

/**
 * Staff credit-report API — mounted INTO the staff router (src/routes/staff.js),
 * so it inherits the staff auth wall (requireAuth + staff role). Individual
 * routes add capability gates on top.
 *
 * Phase 1d (this file, credentials):
 *   GET    /credit/providers            — enabled providers + capabilities (dropdown)
 *   GET    /credit/credentials          — the acting user's own logins (status only; NO secret)
 *   PUT    /credit/credentials          — set/replace the acting user's login (write-only secret)
 *   DELETE /credit/credentials/:pid     — remove the acting user's login for a provider
 *
 * Order/reissue + import routes (Phase 1e) are added below the credential block.
 * Every staffer manages ONLY their own credential — there is no path to read or
 * set another user's login here.
 */
const router = require('../lib/safe-router')();
const db = require('../db');
const { can } = require('../lib/permissions');
const providers = require('../lib/credit/providers');
const credentials = require('../lib/credit/credentials');

// Best-effort audit trail (never blocks the request).
async function audit(req, action, detail) {
  try {
    await db.query(
      `INSERT INTO audit_log (actor_kind,actor_id,action,entity_type,entity_id,ip_address,user_agent,detail)
       VALUES ('staff',$1,$2,'credit_credential',NULL,$3,$4,$5::jsonb)`,
      [req.actor.id, action, req.ip, req.get('user-agent') || null, JSON.stringify(detail || {})]);
  } catch (_) { /* audit is best-effort */ }
}

const requirePull = (req, res, next) =>
  can(req.actor, 'pull_credit') ? next() : res.status(403).json({ error: 'You do not have permission to pull credit.' });

// ---- providers -------------------------------------------------------------
router.get('/credit/providers', async (req, res) => {
  try {
    const list = await providers.listEnabled();
    res.json({ providers: list });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- per-user credentials (write-only secret) ------------------------------
router.get('/credit/credentials', async (req, res) => {
  try {
    res.json({ credentials: await credentials.listForUser(req.actor.id) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/credit/credentials', async (req, res) => {
  const { providerKey, providerId, operatorIdentifier, password } = req.body || {};
  try {
    const out = await credentials.setForUser(req.actor.id, {
      providerKey, providerId, operatorIdentifier, secret: password,
    });
    // Audit records only NON-secret facts (which provider, resulting status).
    await audit(req, 'credit_credential_set', { providerId: out.providerId, providerKey: out.providerKey, status: out.status });
    res.json({ ok: true, status: out.status, message: out.message });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

router.delete('/credit/credentials/:pid', async (req, res) => {
  try {
    await credentials.removeForUser(req.actor.id, req.params.pid);
    await audit(req, 'credit_credential_removed', { providerId: Number(req.params.pid) });
    res.json({ ok: true });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

module.exports = router;
module.exports.requirePull = requirePull;
