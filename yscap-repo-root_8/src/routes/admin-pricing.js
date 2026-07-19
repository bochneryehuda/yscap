'use strict';

// Pricing Admin Center API (owner-directed 2026-07-14) — company-wide pricing
// defaults. Gated by the manage_pricing capability (mounted in server.js).
// Append-only history: each save flips the prior current row and inserts a new
// one, so there is a full audit trail + rollback. bust()s the settings cache so
// the change is live immediately for every not-yet-registered file, the studio,
// and the marketing generator.
const router = require('express').Router();
const db = require('../db');
const pricingSettings = require('../lib/pricing-settings');

const numOrNull = (v) => (v == null || v === '' || isNaN(Number(v)) ? null : Number(v));

router.get('/', async (req, res) => {
  try {
    const cur = await pricingSettings.load();
    const hist = await db.query(
      `SELECT cps.id, cps.markup_std_pct, cps.markup_gold_pct, cps.orig_std_pct, cps.orig_gold_pct,
              cps.lender_fee, cps.credit_fee, cps.appraisal_fee, cps.title_fee, cps.extra_fees, cps.note,
              cps.is_current, cps.created_at, s.full_name AS updated_by_name
         FROM company_pricing_settings cps
         LEFT JOIN staff_users s ON s.id = cps.updated_by
        ORDER BY cps.created_at DESC LIMIT 30`);
    res.json({ current: cur, systemDefaults: pricingSettings.SYSTEM_DEFAULTS, history: hist.rows });
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});

router.put('/', async (req, res) => {
  const b = req.body || {};
  // Extra fees: clean + validate the admin-managed list ({name, amount, state}).
  // A caller that does NOT send extraFees (e.g. the legacy V1 pricing screen)
  // must PRESERVE the current list, never wipe it — only an explicit array
  // replaces it. The V2 Pricing Admin Center always sends the full list.
  let extraFees;
  if (b.extraFees !== undefined) {
    extraFees = pricingSettings.cleanExtraFees(b.extraFees);
    for (const f of extraFees) {
      if (f.amount < 0 || f.amount > 1000000) return res.status(400).json({ error: `fee "${f.name}" amount looks out of range` });
      if (f.state && !/^[A-Z]{2}$/.test(f.state)) return res.status(400).json({ error: `fee "${f.name}" has an invalid state code` });
    }
  } else {
    extraFees = pricingSettings.cleanExtraFees((await pricingSettings.load()).extraFees);
  }
  const cols = {
    markup_std_pct: numOrNull(b.markupStdPct), markup_gold_pct: numOrNull(b.markupGoldPct),
    orig_std_pct: numOrNull(b.origStdPct), orig_gold_pct: numOrNull(b.origGoldPct),
    lender_fee: numOrNull(b.lenderFee), credit_fee: numOrNull(b.creditFee),
    appraisal_fee: numOrNull(b.appraisalFee), title_fee: numOrNull(b.titleFee),
    note: b.note ? String(b.note).slice(0, 300) : null,
  };
  // Guardrails: markup/orig are percents 0-100; fees are non-negative dollars.
  for (const [k, v] of Object.entries(cols)) {
    if (k === 'note' || v == null) continue;
    if (/pct/.test(k) && (v < 0 || v > 100)) return res.status(400).json({ error: `${k} must be between 0 and 100` });
    if (/fee/.test(k) && (v < 0 || v > 1000000)) return res.status(400).json({ error: `${k} looks out of range` });
  }
  // extra_fees is a jsonb column, appended after the scalar columns below.
  cols.extra_fees = JSON.stringify(extraFees);
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    await client.query(`UPDATE company_pricing_settings SET is_current=false WHERE is_current`);
    const names = Object.keys(cols);
    const vals = Object.values(cols);
    const ins = await client.query(
      `INSERT INTO company_pricing_settings (${names.join(',')}, is_current, updated_by)
       VALUES (${names.map((_, i) => '$' + (i + 1)).join(',')}, true, $${names.length + 1}) RETURNING id`,
      [...vals, req.actor.id]);
    await client.query('COMMIT');
    pricingSettings.bust();
    // Verify-after-write (the repo's #1 bug-class guard): re-read the current row.
    const saved = await pricingSettings.load();
    try {
      await db.query(
        `INSERT INTO audit_log (actor_kind, actor_id, action, entity_type, entity_id, detail)
         VALUES ('staff',$1,'update_company_pricing','company_pricing_settings',$2,$3::jsonb)`,
        [req.actor.id, ins.rows[0].id, JSON.stringify(cols)]);
    } catch (_) { /* audit best-effort */ }
    res.json({ ok: true, current: saved });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ error: 'could not save pricing settings' });
  } finally { client.release(); }
});

module.exports = router;
