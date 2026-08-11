/**
 * TPO firm onboarding — INTERNAL admin surface (owner-directed 2026-08-04;
 * db/472/469; design docs/TPO-PORTAL-BLUEPRINT.md). An internal admin creates a
 * brokerage firm and invites its lead broker; the lead broker then invites their
 * own processors from inside the TPO portal (src/routes/tpo.js).
 *
 * Gated `manage_team` (add staff / set roles) — onboarding an external partner
 * is team management. Mounted at /api/admin/tpo.
 */
const express = require('express');
const router = require('../lib/safe-router')();
const db = require('../db');
const C = require('../lib/crypto');
const perms = require('../lib/permissions');
const mail = require('../lib/email/catalog');
const firmCredentials = require('../lib/credit/firm-credentials');   // TPO own-Xactus (Phase 5b)
const creditProvider = require('../lib/credit/provider');
const tpoPricing = require('../lib/tpo-pricing');            // per-firm pricing overrides + resolver
const pricingSettings = require('../lib/pricing-settings');
const F = require('../lib/fields');                          // jsonbText: NUL-safe jsonb binds
const { requireAuth, requireStaff, requirePermission } = require('../auth');

const numOrNull = (v) => (v == null || v === '' || isNaN(Number(v)) ? null : Number(v));

router.use(requireAuth, requireStaff, requirePermission('manage_team'));

// A firm's OWN credit-vendor login is platform-config-level sensitive, so setting
// it needs the stronger platform_setup permission (viewing presence-only status
// stays on the router's manage_team gate). Audited best-effort.
async function auditTpo(req, action, firmId, detail) {
  try {
    await db.query(
      `INSERT INTO audit_log (actor_kind, actor_id, action, entity_type, entity_id, detail)
       VALUES ('staff', $1, $2, 'tpo_firm', $3, $4)`,
      [req.actor.id, action, firmId, detail ? JSON.stringify(detail) : null]);
  } catch (_) { /* never block the action on an audit-write failure */ }
}
async function firmOr404(req, res) {
  const f = await db.query(`SELECT id, name FROM tpo_firms WHERE id=$1`, [req.params.id]);
  if (!f.rows[0]) { res.status(404).json({ error: 'firm not found' }); return null; }
  return f.rows[0];
}

// List every firm + its live user / file counts.
router.get('/firms', async (req, res, next) => {
  try {
    const r = await db.query(
      `SELECT f.id, f.name, f.status, f.nmls, f.created_at,
              (SELECT count(*) FROM staff_users u WHERE u.tpo_firm_id=f.id AND u.is_active=true) AS user_count,
              (SELECT count(*) FROM applications a WHERE a.tpo_firm_id=f.id AND a.deleted_at IS NULL) AS file_count
         FROM tpo_firms f ORDER BY f.created_at DESC`);
    res.json({ firms: r.rows });
  } catch (e) { next(e); }
});

// Create a firm.
router.post('/firms', async (req, res, next) => {
  try {
    const b = req.body || {};
    const name = String(b.name || '').trim();
    if (!name) return res.status(400).json({ error: 'firm name required' });
    const r = await db.query(
      `INSERT INTO tpo_firms (name, nmls, notes, created_by)
       VALUES ($1, NULLIF($2,''), NULLIF($3,''), $4) RETURNING id, name, status, nmls, created_at`,
      [name, String(b.nmls || '').trim(), String(b.notes || '').trim(), req.actor.id]);
    res.status(201).json({ firm: r.rows[0] });
  } catch (e) { next(e); }
});

// Firm detail: the firm, its users, and any pending invites.
router.get('/firms/:id', async (req, res, next) => {
  try {
    const f = await db.query(`SELECT id, name, status, nmls, notes, created_at FROM tpo_firms WHERE id=$1`, [req.params.id]);
    if (!f.rows[0]) return res.status(404).json({ error: 'firm not found' });
    const users = await db.query(
      `SELECT id, full_name, email, role, is_firm_admin, is_active, last_login_at,
              (password_hash IS NOT NULL) AS has_login
         FROM staff_users WHERE tpo_firm_id=$1 AND is_external=true
        ORDER BY is_firm_admin DESC, full_name`, [req.params.id]);
    const invites = await db.query(
      `SELECT email, role, is_firm_admin, created_at, expires_at
         FROM invite_tokens WHERE tpo_firm_id=$1 AND accepted_at IS NULL AND expires_at > now()
        ORDER BY created_at DESC`, [req.params.id]);
    res.json({ firm: f.rows[0], users: users.rows, pendingInvites: invites.rows });
  } catch (e) { next(e); }
});

// Invite a user to the firm (the lead broker, or another officer/processor).
router.post('/firms/:id/invite', async (req, res, next) => {
  try {
    const f = await db.query(`SELECT id, name, status FROM tpo_firms WHERE id=$1`, [req.params.id]);
    if (!f.rows[0]) return res.status(404).json({ error: 'firm not found' });
    if (f.rows[0].status !== 'active') return res.status(400).json({ error: 'the firm is not active' });
    const b = req.body || {};
    const email = String(b.email || '').trim();
    if (!email) return res.status(400).json({ error: 'email required' });
    const role = perms.TPO_ROLE_KEYS.includes(b.role) ? b.role : 'tpo_officer';
    const isFirmAdmin = b.isFirmAdmin === true;
    // Never invite an email that already belongs to an INTERNAL staffer (the
    // accept flow would refuse it anyway; refuse earlier so the admin sees why).
    // Also refuse an email that already belongs to a broker at ANOTHER firm — a
    // re-invite would silently move them (the accept branch reassigns tpo_firm_id
    // on conflict). Moving a broker between firms should be a deliberate action,
    // not a side effect of an invite. Re-inviting into the SAME firm is fine
    // (resend / promote), so only a DIFFERENT firm is refused.
    const ex = await db.query(`SELECT is_external, tpo_firm_id FROM staff_users WHERE lower(email)=lower($1)`, [email]);
    if (ex.rows[0] && ex.rows[0].is_external === false)
      return res.status(409).json({ error: 'that email already belongs to an internal staff account' });
    if (ex.rows[0] && ex.rows[0].is_external === true && String(ex.rows[0].tpo_firm_id) !== String(req.params.id))
      return res.status(409).json({ error: 'that email already belongs to a broker at another firm' });
    const token = C.randomToken(24);
    await db.query(
      `INSERT INTO invite_tokens (token_hash, kind, email, role, created_by, tpo_firm_id, is_firm_admin, expires_at)
       VALUES ($1,'tpo',$2,$3,$4,$5,$6, now() + interval '7 days')`,
      [C.sha256(token), email, role, req.actor.id, req.params.id, isFirmAdmin]);
    const acceptUrl = mail.link('/tpo/accept?token=' + token);
    let emailed = false;
    try {
      const r = await mail.send('tpoInvite', email, { fullName: b.fullName || '', firmName: f.rows[0].name, role, acceptUrl, days: 7 });
      emailed = !!(r && r.ok);
    } catch (_) { /* email is best-effort; the token is returned either way */ }
    res.status(201).json({ ok: true, token, acceptUrl, emailed });
  } catch (e) { next(e); }
});

// Suspend / reactivate / close a firm. Suspending or closing REVOKES every one
// of its brokers' live sessions (the token_version hammer) so access stops
// immediately, not only at the next login. The status change and the session
// revocation run in ONE transaction: if the revocation fails, the status change
// rolls back too, so we never report a firm as suspended while its brokers'
// live sessions are still valid (a silent .catch() previously hid exactly that).
router.patch('/firms/:id', async (req, res, next) => {
  const status = (req.body || {}).status;
  if (!['active', 'suspended', 'closed'].includes(status)) return res.status(400).json({ error: 'bad status' });
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    const r = await client.query(
      `UPDATE tpo_firms SET status=$2, updated_at=now() WHERE id=$1 RETURNING id, name, status`, [req.params.id, status]);
    if (!r.rows[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'firm not found' }); }
    if (status !== 'active') {
      await client.query(
        `UPDATE staff_users SET token_version = token_version + 1 WHERE tpo_firm_id=$1 AND is_external=true`,
        [req.params.id]);
    }
    await client.query('COMMIT');
    res.json({ firm: r.rows[0] });
  } catch (e) { try { await client.query('ROLLBACK'); } catch (_) { /* already broken */ } next(e); }
  finally { client.release(); }
});

// ── TPO own-Xactus: a firm's OWN credit account (Phase 5b) ──────────────────
// When a firm has an ACTIVE credentials row, credit pulls on that firm's files
// run on the firm's Xactus login; otherwise every pull uses our shared company
// account, unchanged. Flood is always on our account. The password is stored
// encrypted and is NEVER returned — status reports presence only.

// View a firm's credit-account status (no secrets). manage_team (router default).
router.get('/firms/:id/credit-credentials', async (req, res, next) => {
  try {
    if (!(await firmOr404(req, res))) return;
    res.json({ credit: await firmCredentials.statusForFirm(req.params.id) });
  } catch (e) { next(e); }
});

// Set (create/replace) a firm's Xactus credit login. platform_setup (sensitive).
router.put('/firms/:id/credit-credentials', requirePermission('platform_setup'), async (req, res, next) => {
  try {
    if (!(await firmOr404(req, res))) return;
    const b = req.body || {};
    await firmCredentials.setForFirm(req.params.id, {
      endpoint: b.endpoint, username: b.username, password: b.password,
      account: b.account, clientId: b.clientId, version: b.version,
      requestingParty: b.requestingParty, authMode: b.authMode,
    }, req.actor.id);
    await auditTpo(req, 'tpo_firm_credit_credentials_set', req.params.id, { authMode: b.authMode || 'basic' });
    res.json({ ok: true, credit: await firmCredentials.statusForFirm(req.params.id) });
  } catch (e) {
    if (e && e.status === 400) return res.status(400).json({ error: e.userMessage || e.message });
    next(e);
  }
});

// Turn a firm's own-account on/off without re-entering the password. platform_setup.
router.post('/firms/:id/credit-credentials/active', requirePermission('platform_setup'), async (req, res, next) => {
  try {
    if (!(await firmOr404(req, res))) return;
    const active = (req.body || {}).active !== false;
    const ok = await firmCredentials.setActiveForFirm(req.params.id, active);
    if (!ok) return res.status(404).json({ error: 'no credit account is configured for this firm' });
    await auditTpo(req, 'tpo_firm_credit_credentials_active', req.params.id, { active });
    res.json({ ok: true, credit: await firmCredentials.statusForFirm(req.params.id) });
  } catch (e) { next(e); }
});

// Remove a firm's own-account entirely (they revert to our shared account). platform_setup.
router.delete('/firms/:id/credit-credentials', requirePermission('platform_setup'), async (req, res, next) => {
  try {
    if (!(await firmOr404(req, res))) return;
    const ok = await firmCredentials.clearForFirm(req.params.id);
    await auditTpo(req, 'tpo_firm_credit_credentials_cleared', req.params.id, {});
    res.json({ ok, credit: await firmCredentials.statusForFirm(req.params.id) });
  } catch (e) { next(e); }
});

// A SAFE reachability check against the firm's own login (no credit request, not a
// billable pull) — the same "Test now" the API Health page runs for our account.
router.post('/firms/:id/credit-credentials/test', requirePermission('platform_setup'), async (req, res, next) => {
  try {
    if (!(await firmOr404(req, res))) return;
    const creds = await firmCredentials.resolveForFirm(req.params.id);
    if (!creds) return res.json({ configured: false, live: false, detail: 'No active credit account is configured for this firm yet.' });
    res.json(await creditProvider.testConnection(creds));
  } catch (e) { next(e); }
});

// ── Per-firm PRICING overrides (owner-directed 2026-08-06) ──────────────────────
// Special pricing for ONE brokerage firm: markup + origination that override the
// TPO CHANNEL defaults for that firm's files. NULL on any field = fall back to the
// channel (which falls back to retail). Viewing is manage_team (router default);
// SETTING needs platform_setup (like the credit account). The firm's OWN broker fee
// (broker_orig_pct) is NOT written here — the broker sets it from inside their
// portal; it is shown here read-only for context. Changes NO retail number.
function shapeFirmPricing(row) {
  row = row || {};
  const n = (v) => (v == null || v === '' ? null : Number(v));
  return {
    markupStdPct: n(row.markup_std_pct), markupGoldPct: n(row.markup_gold_pct), markupSilverPct: n(row.markup_silver_pct),
    origStdPct: n(row.orig_std_pct), origGoldPct: n(row.orig_gold_pct), origSilverPct: n(row.orig_silver_pct),
    markupTiers: pricingSettings.cleanMarkupTiers(row.markup_tiers),
    brokerFeePct: n(row.broker_orig_pct),   // read-only here (the broker owns it)
  };
}
// Pull the resolver-shaped fields out of a merged cd (retail<-channel<-firm).
function pickPct(cd) {
  return {
    markupStdPct: cd.markupStdPct, markupGoldPct: cd.markupGoldPct, markupSilverPct: cd.markupSilverPct,
    origStdPct: cd.origStdPct, origGoldPct: cd.origGoldPct, origSilverPct: cd.origSilverPct,
    markupTiers: cd.markupTiers || null, brokerFeePct: cd.brokerFeePct != null ? cd.brokerFeePct : null,
  };
}
const FIRM_PRICING_COLS = 'markup_std_pct, markup_gold_pct, markup_silver_pct, orig_std_pct, orig_gold_pct, orig_silver_pct, markup_tiers';

// View a firm's pricing overrides + the value each blank field falls back to +
// what the firm actually prices at right now.
router.get('/firms/:id/pricing', async (req, res, next) => {
  try {
    if (!(await firmOr404(req, res))) return;
    const retail = await pricingSettings.load();
    const chan = (await db.query(`SELECT ${FIRM_PRICING_COLS} FROM tpo_pricing_settings WHERE id = 1`)).rows[0] || {};
    const firm = (await db.query(`SELECT ${FIRM_PRICING_COLS}, broker_orig_pct FROM tpo_firm_pricing WHERE tpo_firm_id = $1`, [req.params.id])).rows[0];
    res.json({
      firm: shapeFirmPricing(firm),                                      // the firm's own override values (editable)
      fallback: pickPct(tpoPricing.mergeSettings(retail, chan, null)),   // what a blank firm box uses (retail<-channel)
      effective: pickPct(tpoPricing.mergeSettings(retail, chan, firm || null)),  // what this firm prices at now
    });
  } catch (e) { next(e); }
});

// Set this firm's markup/origination overrides. platform_setup (sensitive). The
// UPSERT deliberately NEVER touches broker_orig_pct, so the broker's own fee is
// preserved. Every value optional (NULL = fall back to the channel).
router.put('/firms/:id/pricing', requirePermission('platform_setup'), async (req, res, next) => {
  try {
    if (!(await firmOr404(req, res))) return;
    const b = req.body || {};
    const cols = {
      markup_std_pct: numOrNull(b.markupStdPct), markup_gold_pct: numOrNull(b.markupGoldPct), markup_silver_pct: numOrNull(b.markupSilverPct),
      orig_std_pct: numOrNull(b.origStdPct), orig_gold_pct: numOrNull(b.origGoldPct), orig_silver_pct: numOrNull(b.origSilverPct),
    };
    for (const [k, v] of Object.entries(cols)) {
      if (v == null) continue;
      if (v < 0 || v > tpoPricing.MAX_MARKUP_ORIG_PCT) return res.status(400).json({ error: `${k} must be between 0 and 100` });
    }
    if (cols.markup_silver_pct != null && cols.markup_silver_pct > 1) {
      return res.status(400).json({ error: 'Silver program markup is capped at 1.00% — anything above 1 point is not earned on this program.' });
    }
    // markup_tiers: an explicit value replaces; omitting it preserves the firm's current map.
    let markupTiers;
    if (b.markupTiers !== undefined) {
      markupTiers = pricingSettings.cleanMarkupTiers(b.markupTiers);
      if (markupTiers) {
        for (const prog of Object.keys(markupTiers)) {
          for (const [t, v] of Object.entries(markupTiers[prog])) {
            if (v < 0 || v > tpoPricing.MAX_MARKUP_ORIG_PCT) return res.status(400).json({ error: `${prog} tier ${t} markup must be between 0 and 100` });
            if (prog === 'silver' && v > 1) return res.status(400).json({ error: 'Silver program markup is capped at 1.00% — anything above 1 point is not earned on this program.' });
          }
        }
      }
    } else {
      const cur = (await db.query(`SELECT markup_tiers FROM tpo_firm_pricing WHERE tpo_firm_id = $1`, [req.params.id])).rows[0];
      markupTiers = pricingSettings.cleanMarkupTiers(cur && cur.markup_tiers);
    }
    const tiersJson = markupTiers ? F.jsonbText(markupTiers) : null;
    await db.query(
      `INSERT INTO tpo_firm_pricing (tpo_firm_id, markup_std_pct, markup_gold_pct, markup_silver_pct, orig_std_pct, orig_gold_pct, orig_silver_pct, markup_tiers, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (tpo_firm_id) DO UPDATE SET
         markup_std_pct=EXCLUDED.markup_std_pct, markup_gold_pct=EXCLUDED.markup_gold_pct, markup_silver_pct=EXCLUDED.markup_silver_pct,
         orig_std_pct=EXCLUDED.orig_std_pct, orig_gold_pct=EXCLUDED.orig_gold_pct, orig_silver_pct=EXCLUDED.orig_silver_pct,
         markup_tiers=EXCLUDED.markup_tiers, updated_by=EXCLUDED.updated_by`,
      [req.params.id, cols.markup_std_pct, cols.markup_gold_pct, cols.markup_silver_pct, cols.orig_std_pct, cols.orig_gold_pct, cols.orig_silver_pct, tiersJson, req.actor.id]);
    await tpoPricing.loadFirms();   // warm the cache so the save reflects immediately
    await auditTpo(req, 'tpo_firm_pricing_set', req.params.id, { ...cols, markup_tiers: markupTiers });
    const firm = (await db.query(`SELECT ${FIRM_PRICING_COLS}, broker_orig_pct FROM tpo_firm_pricing WHERE tpo_firm_id = $1`, [req.params.id])).rows[0];
    res.json({ ok: true, firm: shapeFirmPricing(firm) });
  } catch (e) { next(e); }
});

// Clear this firm's markup/origination overrides (revert to the channel defaults).
// Keeps the firm's own broker fee. platform_setup.
router.delete('/firms/:id/pricing', requirePermission('platform_setup'), async (req, res, next) => {
  try {
    if (!(await firmOr404(req, res))) return;
    await db.query(
      `UPDATE tpo_firm_pricing SET markup_std_pct=NULL, markup_gold_pct=NULL, markup_silver_pct=NULL,
         orig_std_pct=NULL, orig_gold_pct=NULL, orig_silver_pct=NULL, markup_tiers=NULL, updated_by=$2
       WHERE tpo_firm_id = $1`, [req.params.id, req.actor.id]);
    await tpoPricing.loadFirms();
    await auditTpo(req, 'tpo_firm_pricing_cleared', req.params.id, {});
    const firm = (await db.query(`SELECT ${FIRM_PRICING_COLS}, broker_orig_pct FROM tpo_firm_pricing WHERE tpo_firm_id = $1`, [req.params.id])).rows[0];
    res.json({ ok: true, firm: shapeFirmPricing(firm) });
  } catch (e) { next(e); }
});

module.exports = router;
