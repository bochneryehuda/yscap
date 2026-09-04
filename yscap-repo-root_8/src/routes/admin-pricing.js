'use strict';

// Pricing Admin Center API (owner-directed 2026-07-14) — company-wide pricing
// defaults. Gated by the manage_pricing capability (mounted in server.js).
// Append-only history: each save flips the prior current row and inserts a new
// one, so there is a full audit trail + rollback. bust()s the settings cache so
// the change is live immediately for every not-yet-registered file, the studio,
// and the marketing generator.
const router = require('express').Router();
const db = require('../db');
const F = require('../lib/fields');           // jsonbText: NUL-safe jsonb binds
const pricingSettings = require('../lib/pricing-settings');
const tpoPricing = require('../lib/tpo-pricing');   // the wholesale/broker channel pricing layer (bust on save)

const numOrNull = (v) => (v == null || v === '' || isNaN(Number(v)) ? null : Number(v));

router.get('/', async (req, res) => {
  try {
    const cur = await pricingSettings.load();
    const hist = await db.query(
      `SELECT cps.id, cps.markup_std_pct, cps.markup_gold_pct, cps.markup_silver_pct, cps.orig_std_pct, cps.orig_gold_pct, cps.orig_silver_pct,
              cps.lender_fee, cps.credit_fee, cps.appraisal_fee, cps.title_fee, cps.extra_fees, cps.markup_tiers, cps.program_availability, cps.lender_fees, cps.note,
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
    markup_silver_pct: numOrNull(b.markupSilverPct),
    orig_std_pct: numOrNull(b.origStdPct), orig_gold_pct: numOrNull(b.origGoldPct),
    orig_silver_pct: numOrNull(b.origSilverPct),
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
  // Silver markup is HARD-CAPPED at 1.00% (owner-directed 2026-07-29: the note buyer's
  // buy rate floor is the note rate minus 1 point, so spread above 1 point is never
  // earned). The engine clamps at pricing time too; refusing here keeps the stored
  // default honest — the Admin Center must never display a markup the engine won't use.
  if (cols.markup_silver_pct != null && cols.markup_silver_pct > 1) {
    return res.status(400).json({ error: 'Silver program markup is capped at 1.00% — anything above 1 point is not earned on this program.' });
  }
  /* OUR FEE'S TWO PARTS, THE NEW YORK LEGAL LADDER AND THE OPTIONAL NEW YORK SETTLEMENT AGENT FEE
     (owner-directed 2026-08-26: "everything of this should not be hardwired. It should just be
     pre-filled in the manual section. Everything can be changeable"). PRESERVE-IF-ABSENT, exactly
     like extraFees above: the legacy V1 pricing screen never sends this key, and a caller that
     does not mention it must never silently reset the whole fee ladder to the system numbers.
     Cleaned by `lender-fees`' own normalizer so there is no second copy of the shape here. */
  let lenderFees;
  if (b.lenderFees !== undefined) {
    lenderFees = require('../lib/lender-fees').cleanLenderFees(b.lenderFees);
    for (const [k, v] of Object.entries(lenderFees)) {
      if (!(Number(v) >= 0) || Number(v) > 1000000) return res.status(400).json({ error: `${k} looks out of range` });
    }
  } else {
    lenderFees = (await pricingSettings.load()).lenderFees;
  }
  // Per-experience-tier markup map (item 15). Like extraFees, a caller that does
  // NOT send markupTiers PRESERVES the current map (the legacy V1 pricing screen
  // never sends it). Same guardrails as the whole-program markups: percents 0-100,
  // and Silver's per-tier values are capped at the same 1.00% ceiling.
  let markupTiers;
  if (b.markupTiers !== undefined) {
    markupTiers = pricingSettings.cleanMarkupTiers(b.markupTiers);
    if (markupTiers) {
      for (const prog of Object.keys(markupTiers)) {
        for (const [t, v] of Object.entries(markupTiers[prog])) {
          if (v < 0 || v > 100) return res.status(400).json({ error: `${prog} tier ${t} markup must be between 0 and 100` });
          if (prog === 'silver' && v > 1) return res.status(400).json({ error: 'Silver program markup is capped at 1.00% — anything above 1 point is not earned on this program.' });
        }
      }
    }
  } else {
    markupTiers = pricingSettings.current().markupTiers;
  }
  // Program ON/OFF switches (owner-directed 2026-08-18). Same preserve-if-absent
  // contract as extraFees/markupTiers: a caller that does NOT send
  // programAvailability keeps the current switches (the legacy V1 pricing screen
  // never sends it); an explicit value replaces them. Cleaning lives in the ONE
  // rule module (src/lib/program-availability.js): only the marketed programs
  // (its PROGRAM_KEYS — Standard / Gold / Silver / Speed; never Manual), only
  // explicit OFF rows, note capped — so junk can never switch a program off.
  // The Speed Program has NO markup / origination knob of its own (owner decision
  // 2026-09-03: it prices on its two parents' settings) — availability is the
  // only Speed setting this endpoint carries, and it arrives through that list.
  let programAvailability;
  if (b.programAvailability !== undefined) {
    programAvailability = require('../lib/program-availability').cleanProgramAvailability(b.programAvailability);
  } else {
    programAvailability = (await pricingSettings.load()).programAvailability;
  }
  // extra_fees + markup_tiers are jsonb columns, appended after the scalar columns.
  cols.extra_fees = F.jsonbText(extraFees);
  cols.markup_tiers = markupTiers ? F.jsonbText(markupTiers) : null;
  cols.program_availability = programAvailability ? F.jsonbText(programAvailability) : null;
  cols.lender_fees = lenderFees ? F.jsonbText(lenderFees) : null;
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

// ── TPO (wholesale/broker) CHANNEL pricing (owner-directed 2026-08-06) ──────────
// A separate markup + origination control set for the TPO channel, in the SAME
// Pricing Center, behind the SAME manage_pricing gate (a kind='tpo' actor holds no
// capability, so it can never reach this). Every value is OPTIONAL: NULL means
// "same as the retail default above" — so with nothing set, a TPO file prices
// exactly like retail. A TPO file resolves retail → these channel defaults → its
// firm's overrides → the firm's broker fee (src/lib/tpo-pricing.js). This changes
// NO retail number and NO frozen engine formula — it is a new layer on top.
function shapeTpoChannel(row) {
  row = row || {};
  const n = (v) => (v == null || v === '' ? null : Number(v));
  return {
    markupStdPct: n(row.markup_std_pct), markupGoldPct: n(row.markup_gold_pct), markupSilverPct: n(row.markup_silver_pct),
    origStdPct: n(row.orig_std_pct), origGoldPct: n(row.orig_gold_pct), origSilverPct: n(row.orig_silver_pct),
    markupTiers: pricingSettings.cleanMarkupTiers(row.markup_tiers),
  };
}

// The current TPO-channel settings + the retail defaults each field falls back to,
// so the UI can show "TPO value, defaults to retail X".
/* WHICH FILES STILL PRICE AT A MARKUP THE COMPANY NO LONGER SETS — and why.
   Owner-reported 2026-08-26: *"I still see sometimes … automatic exception
   requests that people want to move down the price from 0.5 to 0.4 markup … I
   think there's still a bug in the system … maybe it's only on old files."*

   READ-ONLY. The studio no longer freezes a default onto a file and db/600
   already released it from every file whose economics are still open, so what
   is left is the files db/600 SPARED on purpose — settled, or with a term sheet
   out for signature — where raising the markup would move terms a borrower has
   been shown or signed. This answers the question and changes nothing; whether
   to touch those files is the owner's call, and this is what makes it a
   decidable one instead of a hunch. */
router.get('/markup-drift', async (req, res) => {
  try { res.json(await require('../lib/markup-drift').report({})); }
  catch (e) { res.status(500).json({ error: 'server error' }); }
});

router.get('/tpo', async (req, res) => {
  try {
    const retail = await pricingSettings.load();
    const row = (await db.query(
      `SELECT markup_std_pct, markup_gold_pct, markup_silver_pct, orig_std_pct, orig_gold_pct, orig_silver_pct, markup_tiers
         FROM tpo_pricing_settings WHERE id = 1 LIMIT 1`)).rows[0];
    res.json({ tpo: shapeTpoChannel(row), retail });
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});

router.put('/tpo', async (req, res) => {
  const b = req.body || {};
  // Every markup/orig value is optional — NULL (a blank field) means "same as
  // retail". Same guardrails as the retail defaults: percents 0-100, Silver markup
  // hard-capped at 1.00% (the engine clamps too; keep the stored default honest).
  const cols = {
    markup_std_pct: numOrNull(b.markupStdPct), markup_gold_pct: numOrNull(b.markupGoldPct), markup_silver_pct: numOrNull(b.markupSilverPct),
    orig_std_pct: numOrNull(b.origStdPct), orig_gold_pct: numOrNull(b.origGoldPct), orig_silver_pct: numOrNull(b.origSilverPct),
  };
  for (const [k, v] of Object.entries(cols)) {
    if (v == null) continue;
    if (v < 0 || v > 100) return res.status(400).json({ error: `${k} must be between 0 and 100` });
  }
  if (cols.markup_silver_pct != null && cols.markup_silver_pct > 1) {
    return res.status(400).json({ error: 'Silver program markup is capped at 1.00% — anything above 1 point is not earned on this program.' });
  }
  // markup_tiers: a caller that omits it PRESERVES the current map (mirrors the
  // retail PUT); an explicit value replaces it. Read the current value from the DB,
  // not the cache, so a concurrent save is never overwritten with stale tiers.
  let markupTiers;
  if (b.markupTiers !== undefined) {
    markupTiers = pricingSettings.cleanMarkupTiers(b.markupTiers);
    if (markupTiers) {
      for (const prog of Object.keys(markupTiers)) {
        for (const [t, v] of Object.entries(markupTiers[prog])) {
          if (v < 0 || v > 100) return res.status(400).json({ error: `${prog} tier ${t} markup must be between 0 and 100` });
          if (prog === 'silver' && v > 1) return res.status(400).json({ error: 'Silver program markup is capped at 1.00% — anything above 1 point is not earned on this program.' });
        }
      }
    }
  } else {
    const cur = (await db.query(`SELECT markup_tiers FROM tpo_pricing_settings WHERE id = 1`)).rows[0];
    markupTiers = pricingSettings.cleanMarkupTiers(cur && cur.markup_tiers);
  }
  const auditDetail = JSON.stringify({ ...cols, markup_tiers: markupTiers });
  cols.markup_tiers = markupTiers ? F.jsonbText(markupTiers) : null;
  try {
    const names = Object.keys(cols);
    const setClause = names.map((k, i) => `${k}=$${i + 1}`).join(', ');
    await db.query(
      `UPDATE tpo_pricing_settings SET ${setClause}, updated_by=$${names.length + 1} WHERE id = 1`,
      [...Object.values(cols), req.actor.id]);
    // AWAIT the reload (not just bust): the resolver cache serves synchronously, so
    // a bare bust would leave the very next quote reading the stale value until the
    // async reload lands. Warming it here makes the save reflect immediately.
    await tpoPricing.loadChannel();
    // Verify-after-write (the repo's #1 bug-class guard): re-read + return.
    const saved = shapeTpoChannel((await db.query(
      `SELECT markup_std_pct, markup_gold_pct, markup_silver_pct, orig_std_pct, orig_gold_pct, orig_silver_pct, markup_tiers
         FROM tpo_pricing_settings WHERE id = 1`)).rows[0]);
    try {
      await db.query(
        `INSERT INTO audit_log (actor_kind, actor_id, action, entity_type, entity_id, detail)
         VALUES ('staff',$1,'update_tpo_pricing','tpo_pricing_settings',NULL,$2::jsonb)`,
        [req.actor.id, auditDetail]);
    } catch (_) { /* audit best-effort */ }
    res.json({ ok: true, tpo: saved });
  } catch (e) { res.status(500).json({ error: 'could not save TPO pricing settings' }); }
});

module.exports = router;
