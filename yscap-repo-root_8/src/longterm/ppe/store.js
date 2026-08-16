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

module.exports = {
  normAlias,
  loadSettingOverrides, resolveSettings, resolveSetting, setSetting, clearSetting,
  findInvestorByName, createInvestor, listInvestors, createProgram, listPrograms,
};
