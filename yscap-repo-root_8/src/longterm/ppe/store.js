'use strict';
/**
 * LT PPE — data-store bridge (Phase 1). Ties the coded setting DEFINITIONS
 * (settings.js — the single source of truth for types/options/defaults) to the
 * per-tenant OVERRIDE table `lt_ppe_setting_value` (db/554), and provides the
 * thin investor/program reads/writes the admin surface needs.
 *
 * `db` is a pg pool/client exposing `.query(text, params)`. Everything is scoped
 * by `scope` (default 'company') — selling to a second lender is a new scope.
 *
 * DEGRADES SAFELY: an unreadable override table, a missing row, or an override
 * that no longer validates against its definition all fall back to the coded
 * default (settings.resolve already skips an invalid override), so pricing never
 * degrades to nothing — only to the industry-standard default.
 *
 * LT-only. No RTL imports.
 */
const settings = require('./settings');

// Load a tenant's setting OVERRIDES as a { key: value } map. Only keys that are
// real definitions are returned; an unknown/legacy key is ignored. Never throws —
// an unreadable table returns {} so resolution falls back to the coded defaults.
async function loadSettingOverrides(db, scope = 'company') {
  try {
    const r = await db.query('SELECT key, value FROM lt_ppe_setting_value WHERE scope = $1', [scope]);
    const out = {};
    for (const row of r.rows || []) {
      if (settings.getDefinition(row.key)) out[row.key] = row.value;
    }
    return out;
  } catch (_e) {
    return {};
  }
}

// Resolve EVERY setting for a tenant (coded default overlaid by the tenant's
// stored overrides). Returns { values, sources } exactly like settings.resolveAll.
async function resolveSettings(db, scope = 'company') {
  const tenant = await loadSettingOverrides(db, scope);
  return settings.resolveAll({ tenant });
}

// Resolve ONE setting for a tenant.
async function resolveSetting(db, key, scope = 'company') {
  if (!settings.getDefinition(key)) throw new Error(`unknown_setting:${key}`);
  const tenant = await loadSettingOverrides(db, scope);
  return settings.resolve(key, { tenant });
}

// Set (or clear) a tenant override for one setting. VALIDATES against the coded
// definition first — an unknown key or an out-of-spec value is refused, never
// stored, so the table can never become a junk drawer. Passing value === null
// (for a nullable setting) stores the null; to REMOVE an override entirely use
// clearSetting. Returns { ok } or { ok:false, error }.
async function setSetting(db, scope, key, value, updatedBy = null) {
  const v = settings.validateValue(key, value);
  if (!v.ok) return { ok: false, error: v.error };
  await db.query(
    `INSERT INTO lt_ppe_setting_value (scope, key, value, updated_by, updated_at)
       VALUES ($1, $2, $3::jsonb, $4, now())
     ON CONFLICT (scope, key)
       DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [scope, key, JSON.stringify(value), updatedBy]);
  return { ok: true };
}

// Remove a tenant override so the setting reverts to the coded default.
async function clearSetting(db, scope, key) {
  await db.query('DELETE FROM lt_ppe_setting_value WHERE scope = $1 AND key = $2', [scope, key]);
  return { ok: true };
}

// ---- investors / programs (thin reads + creates for the admin surface) ------

// Normalize an investor name to its alias match key (lowercase, strip non-alphanumerics).
function normAlias(name) { return String(name == null ? '' : name).toLowerCase().replace(/[^a-z0-9]/g, ''); }

// Resolve a (possibly hand-typed) investor name to its canonical investor row via
// the alias table, else null. The "spelled 151 ways" defense.
async function findInvestorByName(db, scope, name) {
  const norm = normAlias(name);
  if (!norm) return null;
  const r = await db.query(
    `SELECT i.* FROM lt_ppe_investor i
       JOIN lt_ppe_investor_alias a ON a.investor_id = i.id
      WHERE a.scope = $1 AND a.alias_norm = $2 LIMIT 1`, [scope, norm]);
  return r.rows[0] || null;
}

// Create an investor (idempotent on (scope, code)) and register its name + code as
// aliases. Returns the investor row.
async function createInvestor(db, scope, { code, name, createdBy = null }) {
  const r = await db.query(
    `INSERT INTO lt_ppe_investor (scope, code, name, created_by)
       VALUES ($1, $2, $3, $4)
     ON CONFLICT (scope, code) DO UPDATE SET name = EXCLUDED.name, updated_at = now()
     RETURNING *`, [scope, code, name, createdBy]);
  const inv = r.rows[0];
  for (const alias of [name, code]) {
    const norm = normAlias(alias);
    if (!norm) continue;
    await db.query(
      `INSERT INTO lt_ppe_investor_alias (scope, investor_id, alias_norm, alias)
         VALUES ($1, $2, $3, $4) ON CONFLICT (scope, alias_norm) DO NOTHING`,
      [scope, inv.id, norm, alias]);
  }
  return inv;
}

// List a tenant's investors (newest first).
async function listInvestors(db, scope = 'company') {
  const r = await db.query('SELECT * FROM lt_ppe_investor WHERE scope = $1 ORDER BY created_at DESC', [scope]);
  return r.rows;
}

// Create a program under an investor (idempotent on (scope, investor_id, code)).
async function createProgram(db, scope, { investorId = null, code, name, channel, status, createdBy = null }) {
  const ch = channel || settings.resolve('program.default_channel').value;
  const r = await db.query(
    `INSERT INTO lt_ppe_program (scope, investor_id, code, name, channel, status, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (scope, investor_id, code)
       DO UPDATE SET name = EXCLUDED.name, channel = EXCLUDED.channel, updated_at = now()
     RETURNING *`, [scope, investorId, code, name, ch, status || 'draft', createdBy]);
  return r.rows[0];
}

// List an investor's programs.
async function listPrograms(db, scope, investorId) {
  const r = await db.query(
    'SELECT * FROM lt_ppe_program WHERE scope = $1 AND investor_id IS NOT DISTINCT FROM $2 ORDER BY created_at DESC',
    [scope, investorId]);
  return r.rows;
}

// ---- rate-sheet store (db/556) — versions, grids, LLPAs, limits ------------

// Create (or idempotently update) a rate-sheet version under a program. A version is the effective-
// dated container the grid/adjustments/limit hang off; (scope, program, version_no, reprice_seq) is
// unique. Channel defaults to the coded product default.
async function createRateSheetVersion(db, scope, opts = {}) {
  const { programId, versionNo, repriceSeq = 0, channel, status = 'draft', sourceFormat = null,
    effectiveFrom = null, contentHash = null, createdBy = null } = opts;
  const ch = channel || settings.resolve('program.default_channel').value;
  const r = await db.query(
    `INSERT INTO lt_ppe_rate_sheet_version
       (scope, program_id, version_no, reprice_seq, channel, status, source_format, effective_from, content_hash, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (scope, program_id, version_no, reprice_seq)
       DO UPDATE SET channel = EXCLUDED.channel, status = EXCLUDED.status,
                     source_format = EXCLUDED.source_format, content_hash = EXCLUDED.content_hash,
                     updated_at = now()
     RETURNING *`,
    [scope, programId, versionNo, repriceSeq, ch, status, sourceFormat, effectiveFrom, contentHash, createdBy]);
  return r.rows[0];
}

// Replace a version's base-price grid (append-only versioning means a version's grid is set once; this
// is a full-set write used at ingestion). Each row: { noteRateMilliPct, lockDays, product?, priceMilli }.
async function replaceBasePrices(db, scope, versionId, rows = []) {
  await db.query('DELETE FROM lt_ppe_base_price WHERE version_id = $1', [versionId]);
  for (const bp of rows) {
    await db.query(
      `INSERT INTO lt_ppe_base_price (scope, version_id, note_rate_milli_pct, lock_days, product, price_milli)
         VALUES ($1, $2, $3, $4, $5, $6)`,
      [scope, versionId, bp.noteRateMilliPct, bp.lockDays, bp.product || '', bp.priceMilli]);
  }
  return rows.length;
}

// Replace a version's LLPA adjustment rows. Each row: { dimension, ficoMin?, ficoMax?, ltvMin?,
// ltvMax?, dscrMin?, dscrMax?, predicate?, adjMilli, adjustmentTarget?, unit?, signConvention?,
// cumulative?, priority?, reason?, code?, meta? }. Bands are half-open [min,max).
async function replaceAdjustments(db, scope, versionId, rows = []) {
  await db.query('DELETE FROM lt_ppe_adjustment WHERE version_id = $1', [versionId]);
  for (const a of rows) {
    await db.query(
      `INSERT INTO lt_ppe_adjustment
         (scope, version_id, dimension, fico_min, fico_max, ltv_min, ltv_max, dscr_min, dscr_max,
          predicate, adj_milli, adjustment_target, unit, sign_convention, cumulative, priority, reason, code, meta)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13,$14,$15,$16,$17,$18,$19::jsonb)`,
      [scope, versionId, a.dimension, a.ficoMin ?? null, a.ficoMax ?? null, a.ltvMin ?? null, a.ltvMax ?? null,
        a.dscrMin ?? null, a.dscrMax ?? null, a.predicate ? JSON.stringify(a.predicate) : null,
        a.adjMilli, a.adjustmentTarget || 'price', a.unit || 'points', a.signConvention || 'cost_positive',
        a.cumulative !== false, a.priority || 0, a.reason || null, a.code || null, JSON.stringify(a.meta || {})]);
  }
  return rows.length;
}

// Set (upsert) a version's price limits. { minPriceMilli?, roundingIncrementMilli?, roundingMode?,
// capTiers?, onExceed? }.
async function setPriceLimit(db, scope, versionId, opts = {}) {
  const { minPriceMilli = null, roundingIncrementMilli = 125, roundingMode = 'nearest_eighth',
    capTiers = [], onExceed = 'cap_and_keep_eligible' } = opts;
  const r = await db.query(
    `INSERT INTO lt_ppe_price_limit
       (scope, version_id, min_price_milli, rounding_increment_milli, rounding_mode, cap_tiers, on_exceed)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
     ON CONFLICT (scope, version_id)
       DO UPDATE SET min_price_milli = EXCLUDED.min_price_milli,
                     rounding_increment_milli = EXCLUDED.rounding_increment_milli,
                     rounding_mode = EXCLUDED.rounding_mode, cap_tiers = EXCLUDED.cap_tiers,
                     on_exceed = EXCLUDED.on_exceed, updated_at = now()
     RETURNING *`,
    [scope, versionId, minPriceMilli, roundingIncrementMilli, roundingMode, JSON.stringify(capTiers), onExceed]);
  return r.rows[0];
}

// Load a complete rate sheet for pricing: { version, basePrices[], adjustments[], priceLimit }.
async function loadRateSheet(db, versionId) {
  const v = await db.query('SELECT * FROM lt_ppe_rate_sheet_version WHERE id = $1', [versionId]);
  if (!v.rows.length) return null;
  const bp = await db.query('SELECT * FROM lt_ppe_base_price WHERE version_id = $1 ORDER BY note_rate_milli_pct, lock_days', [versionId]);
  const adj = await db.query('SELECT * FROM lt_ppe_adjustment WHERE version_id = $1 ORDER BY priority, id', [versionId]);
  const pl = await db.query('SELECT * FROM lt_ppe_price_limit WHERE version_id = $1', [versionId]);
  return { version: v.rows[0], basePrices: bp.rows, adjustments: adj.rows, priceLimit: pl.rows[0] || null };
}

// Publish a version: mark it published + effective from now, and CLOSE the prior published version's
// effective_to (the effective-dating discipline — nothing is deleted, "current" is a thin predicate).
// One transaction. Returns the published version row.
async function publishRateSheetVersion(db, scope, versionId) {
  // Works with LT's db wrapper (getClient) or a raw pg Pool (connect).
  const client = await (typeof db.getClient === 'function' ? db.getClient() : db.connect());
  try {
    await client.query('BEGIN');
    const cur = await client.query('SELECT program_id, channel FROM lt_ppe_rate_sheet_version WHERE id = $1', [versionId]);
    if (!cur.rows.length) { await client.query('ROLLBACK'); return null; }
    const { program_id: programId, channel } = cur.rows[0];
    await client.query(
      `UPDATE lt_ppe_rate_sheet_version
          SET status = 'superseded', effective_to = now(), updated_at = now()
        WHERE scope = $1 AND program_id = $2 AND channel = $3 AND status = 'published' AND id <> $4`,
      [scope, programId, channel, versionId]);
    const r = await client.query(
      `UPDATE lt_ppe_rate_sheet_version
          SET status = 'published', effective_from = now(), effective_to = NULL, updated_at = now()
        WHERE id = $1 RETURNING *`, [versionId]);
    await client.query('COMMIT');
    return r.rows[0];
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) { /* the original error is the one that matters */ }
    throw e;
  } finally {
    client.release();
  }
}

// The published version currently in effect for a program+channel (the thin "current" predicate).
async function currentRateSheetVersion(db, scope, programId, channel = 'correspondent') {
  const r = await db.query(
    `SELECT * FROM lt_ppe_rate_sheet_version
      WHERE scope = $1 AND program_id = $2 AND channel = $3 AND status = 'published'
        AND effective_from <= now() AND (effective_to IS NULL OR effective_to > now())
      ORDER BY effective_from DESC LIMIT 1`, [scope, programId, channel]);
  return r.rows[0] || null;
}

module.exports = {
  normAlias,
  loadSettingOverrides, resolveSettings, resolveSetting, setSetting, clearSetting,
  findInvestorByName, createInvestor, listInvestors, createProgram, listPrograms,
  createRateSheetVersion, replaceBasePrices, replaceAdjustments, setPriceLimit,
  loadRateSheet, publishRateSheetVersion, currentRateSheetVersion,
};
