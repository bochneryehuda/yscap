'use strict';
/**
 * LT PPE — data-store bridge (Phase 1). Ties the coded setting DEFINITIONS
 * (settings.js — the single source of truth for types/options/defaults) to the
 * per-tenant OVERRIDE table `lt_ppe_setting_value` (db/558), and provides the
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
const { resolveMarginHoldback } = require('./margin-holdback');
const lpScope = require('./lp-scope');

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

// ---- margin & holdback (Layer 1) --------------------------------------------

// The setting scope key for a per-investor override layer. An investor's own margin/
// holdback/rules live under scope `investor:<code>` in lt_ppe_setting_value (the same
// override table, a distinct scope), layered OVER the company scope, layered over the
// coded product defaults. Never throws — an unusable code degrades to the company scope.
function investorScope(code) {
  const c = String(code == null ? '' : code).trim();
  return c ? `investor:${c}` : null;
}

// Resolve the DEFAULT margin + holdback + per-scenario rules for an investor, layering
// per-investor override → company default → product default (250), then apply the
// per-scenario rules against `facts` (margin-holdback.resolveMarginHoldback). `companyScope`
// is the org/company layer (default 'company'). Returns the resolveMarginHoldback record
// PLUS `defaults` (what each of the three settings resolved to and from which layer), so a
// caller/admin can see whether a number came from the investor, the company, or the product.
//
// DEGRADES SAFELY: an unreadable override table falls back to the company scope, which falls
// back to the coded 250 defaults — pricing never resolves to nothing, only to the pre-fill.
async function resolveMarginHoldbackForInvestor(db, investorCode, facts = {}, companyScope = 'company') {
  const org = await loadSettingOverrides(db, companyScope);
  const invScope = investorScope(investorCode);
  const tenant = invScope ? await loadSettingOverrides(db, invScope) : {};

  const margin = settings.resolve('pricing.margin_milli', { tenant, org });
  const holdback = settings.resolve('pricing.holdback_milli', { tenant, org });
  const rulesRes = settings.resolve('pricing.margin_holdback_rules', { tenant, org });
  const rules = Array.isArray(rulesRes.value) ? rulesRes.value : [];

  const resolved = resolveMarginHoldback({
    marginMilli: margin.value,
    holdbackMilli: holdback.value,
    rules,
    facts: facts || {},
  });

  return {
    ...resolved,
    // where each of the three settings' DEFAULT layer resolved from (tenant=investor, org=company, product_default)
    defaults: {
      margin: { value: margin.value, source: margin.source },
      holdback: { value: holdback.value, source: holdback.source },
      rules: { count: rules.length, source: rulesRes.source },
    },
    investorScope: invScope,
  };
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

/**
 * Set (or CLEAR) a program's Lender Price scope — which of Lender Price's programs a comparison
 * against this program is about (db/574; see lp-scope.js for why it must be stated rather than
 * inferred, and why the family PATTERN is what the Deephaven DSCR split actually needs).
 *
 * EVERY scope column is written on every call, so a partial body CLEARS the keys it omits rather than
 * leaving them at their previous value. A half-updated scope is the dangerous outcome: it points the
 * comparison at some blend of the old statement and the new one, which nobody chose and nobody can
 * see. Passing null clears the scope entirely, which is a legitimate, explicit outcome — with no scope
 * the comparison abstains and says so.
 *
 * The scope must already be VALIDATED (`lpScope.validateScope`); this writes what it is given.
 * Returns the updated row, or null when there is no such program in this tenant scope.
 */
async function setProgramLpScope(db, scope, programId, validatedScope, setBy = null) {
  const c = lpScope.scopeToColumns(validatedScope);
  const any = validatedScope && Object.keys(validatedScope).length;
  const r = await db.query(
    `UPDATE lt_ppe_program
        SET lp_investor = $3, lp_lender = $4, lp_program = $5, lp_product = $6, lp_program_like = $7,
            lp_scope_set_by = $8, lp_scope_set_at = CASE WHEN $9::boolean THEN now() ELSE NULL END,
            updated_at = now()
      WHERE scope = $1 AND id = $2
      RETURNING *`,
    [scope, programId, c.lp_investor, c.lp_lender, c.lp_program, c.lp_product, c.lp_program_like,
      any ? setBy : null, !!any]);
  return r.rows[0] || null;
}

// List an investor's programs.
async function listPrograms(db, scope, investorId) {
  const r = await db.query(
    'SELECT * FROM lt_ppe_program WHERE scope = $1 AND investor_id IS NOT DISTINCT FROM $2 ORDER BY created_at DESC',
    [scope, investorId]);
  return r.rows;
}

/**
 * Every program in the scope, with the investor it belongs to.
 *
 * `listPrograms` answers "this investor's programs" and needs an investor id to do it — which is the
 * wrong shape for the one question a scope screen has to answer: WHICH programs have no Lender Price
 * scope yet? An unscoped program's shadow comparison abstains, silently and forever, and a per-investor
 * read cannot see the ones hanging off no investor at all (`investor_id IS NULL`), so the very rows most
 * likely to be unscoped are the ones a per-investor loop would never show.
 *
 * The join is LEFT: a program whose investor row has gone is still a program, and dropping it here
 * would take it off the list that exists to find unscoped programs.
 */
async function listAllPrograms(db, scope = 'company') {
  const r = await db.query(
    `SELECT p.*, i.code AS investor_code, i.name AS investor_name
       FROM lt_ppe_program p
       LEFT JOIN lt_ppe_investor i ON i.id = p.investor_id AND i.scope = p.scope
      WHERE p.scope = $1
      ORDER BY COALESCE(i.name, i.code, ''), p.created_at DESC`,
    [scope]);
  return r.rows;
}

// ---- rate-sheet store (db/560) — versions, grids, LLPAs, limits ------------

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
/**
 * ATOMIC, and that is the whole point of the transaction.
 *
 * This is DELETE-then-INSERT-in-a-loop over the grid every quote prices from. On a pool each
 * statement is its own transaction, so a failure part way through used to leave the OLD grid already
 * deleted and the new one half written — reproduced against a real Postgres with an ordinary
 * copy/paste mistake: one duplicated cell trips `lt_ppe_base_price_cell_uk`, and a live two-row sheet
 * became a one-row sheet with an error returned to the caller. Any INSERT failure does it (a value too
 * big for INTEGER, a NOT NULL), not only a duplicate. A rate sheet is the one thing here that must
 * never be half-written, so the whole replacement commits or none of it does.
 *
 * `opts.client` lets a caller that is ALREADY inside a transaction pass its client in and keep the
 * grid write in the same unit of work rather than opening a nested one.
 */
/**
 * AND IT REFUSES A VERSION THAT IS NOT THE CALLER'S.
 *
 * Scoping the DELETE stopped one tenant DESTROYING another's grid, and that is only half of it: the
 * INSERTs still stamped the caller's own scope, so an intruder could ADD rows onto somebody else's
 * version. That is not harmless, because `loadRateSheet` selects the grid by `version_id` ALONE — so
 * those foreign rows would join the grid the owner's quotes price from. Refusing here makes the store
 * safe for ANY caller rather than only for callers that remember to check first; the routes check
 * ownership too, and defence in depth is the point.
 */
async function assertVersionInScope(c, scope, versionId) {
  const r = await c.query('SELECT 1 FROM lt_ppe_rate_sheet_version WHERE id = $1 AND scope = $2', [versionId, scope]);
  if (!r.rows.length) {
    const e = new Error('That rate-sheet version does not belong to this scope.');
    e.code = 'LT_PPE_VERSION_OUT_OF_SCOPE';
    throw e;
  }
}

async function replaceGridRows(db, scope, versionId, opts, run) {
  if (opts && opts.client) {
    await assertVersionInScope(opts.client, scope, versionId);
    return run(opts.client);
  }
  const client = await (typeof db.getClient === 'function' ? db.getClient() : db.connect());
  try {
    await client.query('BEGIN');
    await assertVersionInScope(client, scope, versionId);
    const out = await run(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) { /* the original error is the one that matters */ }
    throw e;
  } finally {
    client.release();
  }
}

async function replaceBasePrices(db, scope, versionId, rows = [], opts = {}) {
  return replaceGridRows(db, scope, versionId, opts, async (c) => {
    // SCOPED DELETE. Every row is INSERTed with the caller's scope, so deleting by version_id alone was
    // asymmetric: a caller holding a version id from ANOTHER tenant would wipe that tenant's grid and
    // re-stamp the rows as its own. Unreachable while nothing called this, and armed the moment a door
    // opened — so the scope the function already takes is now actually used. Multi-tenancy is a
    // governing principle here (§2.1), not a later feature.
    await c.query('DELETE FROM lt_ppe_base_price WHERE version_id = $1 AND scope = $2', [versionId, scope]);
    for (const bp of rows) {
      await c.query(
        `INSERT INTO lt_ppe_base_price (scope, version_id, note_rate_milli_pct, lock_days, product, price_milli)
           VALUES ($1, $2, $3, $4, $5, $6)`,
        [scope, versionId, bp.noteRateMilliPct, bp.lockDays, bp.product || '', bp.priceMilli]);
    }
    return rows.length;
  });
}

// Replace a version's LLPA adjustment rows. Each row: { dimension, ficoMin?, ficoMax?, ltvMin?,
// ltvMax?, dscrMin?, dscrMax?, predicate?, adjMilli, adjustmentTarget?, unit?, signConvention?,
// cumulative?, priority?, reason?, code?, meta? }. Bands are half-open [min,max).
async function replaceAdjustments(db, scope, versionId, rows = [], opts = {}) {
  return replaceGridRows(db, scope, versionId, opts, async (c) => {
  await c.query('DELETE FROM lt_ppe_adjustment WHERE version_id = $1 AND scope = $2', [versionId, scope]); // scoped — see replaceBasePrices
  for (const a of rows) {
    await c.query(
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
  });
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

/**
 * Does this rate-sheet version belong to this scope? Returns the version row, or null.
 *
 * THE ONE OWNERSHIP CHECK, and every door that takes a version id from a request must run it FIRST.
 * `loadRateSheet` deliberately keeps its unscoped signature — the pricing path already knows which
 * version it resolved and re-filtering there would be noise — but that makes a version id straight
 * off an HTTP request a cross-tenant read waiting to happen, and the write helpers are worse: they
 * would rewrite another tenant's grid. So the check lives here, once, rather than as a WHERE clause
 * copied into each route, where the copy that gets forgotten is the hole.
 */
async function rateSheetVersionInScope(db, scope, versionId) {
  if (!versionId) return null;
  const r = await db.query('SELECT * FROM lt_ppe_rate_sheet_version WHERE id = $1 AND scope = $2', [versionId, scope]);
  return r.rows[0] || null;
}

// Load a complete rate sheet for pricing: { version, basePrices[], adjustments[], priceLimit }.
// UNSCOPED BY DESIGN — see rateSheetVersionInScope above; a caller holding an id from a request
// checks ownership there first.
async function loadRateSheet(db, versionId) {
  const v = await db.query('SELECT * FROM lt_ppe_rate_sheet_version WHERE id = $1', [versionId]);
  if (!v.rows.length) return null;
  const bp = await db.query('SELECT * FROM lt_ppe_base_price WHERE version_id = $1 ORDER BY note_rate_milli_pct, lock_days', [versionId]);
  const adj = await db.query('SELECT * FROM lt_ppe_adjustment WHERE version_id = $1 ORDER BY priority, id', [versionId]);
  const pl = await db.query('SELECT * FROM lt_ppe_price_limit WHERE version_id = $1', [versionId]);
  // The owning PROGRAM row rides along, because that is where the Lender Price SCOPE lives (db/574)
  // and the pricing route needs it in the same breath it loads the sheet. Best-effort: a sheet whose
  // program cannot be read still prices — it just compares against nothing and says so, which is the
  // same honest outcome as a program nobody has scoped yet.
  let program = null;
  try {
    const p = await db.query('SELECT * FROM lt_ppe_program WHERE id = $1', [v.rows[0].program_id]);
    program = p.rows[0] || null;
  } catch (_) { program = null; }
  // The INVESTOR rides along for the same reason the program does: the agreement harness has to ask
  // that investor's own prepayment-penalty layer about every scenario, and the only key into
  // `program-registry` is the investor's NAME. Without it the harness prices a sheet that carries no
  // borrower-type rule at all and reports agreement on a loan the investor will not buy. Best-effort
  // and additive — a sheet whose investor cannot be read still prices exactly as before.
  let investor = null;
  try {
    if (program && program.investor_id) {
      const iq = await db.query('SELECT * FROM lt_ppe_investor WHERE id = $1', [program.investor_id]);
      investor = iq.rows[0] || null;
    }
  } catch (_) { investor = null; }
  return { version: v.rows[0], program, investor, basePrices: bp.rows, adjustments: adj.rows, priceLimit: pl.rows[0] || null };
}

// Publish a version: mark it published + effective from now, and CLOSE the prior published version's
// effective_to (the effective-dating discipline — nothing is deleted, "current" is a thin predicate).
// One transaction. Returns the published version row.
//
// IT NOW REFUSES AN UNPROVEN SHEET, and this is the enforcement point for the owner's HARD RULE:
// agree with Lender Price on every LLPA, every eligibility and ineligibility, and the max/min price,
// to the penny, over ~200 scenarios, BEFORE a sheet is trusted. Publishing is precisely the moment it
// becomes trusted — it is what every later quote prices from — and until now this function promoted a
// sheet with no reference to the agreement harness at all. The rule was written in three places and
// enforced in none.
//
// THE OVERRIDE IS NOT A HOLE IN THE GATE, IT IS WHAT KEEPS THE GATE FROM BEING A DEAD END. On the day
// this lands no sheet has a recorded run, and producing one needs live Lender Price credentials — a
// refusal whose only remedy is a state nothing can currently reach would simply mean nobody can
// publish. So `opts.override` publishes anyway, and RECORDS who decided and why (db/576). Refusal is
// meant to be gettable past; it is not meant to be gettable past silently.
//
// Returns the version row on success, or `{ refused: { reason, message } }` — a shape the caller must
// look at. Throwing would have been the other option and is worse here: this runs inside a transaction
// the caller owns, and the two existing callers already read the returned row.
async function publishRateSheetVersion(db, scope, versionId, opts = {}) {
  const agreementStore = require('./agreement-store');

  // ASKED BEFORE THE TRANSACTION IS OPENED, deliberately: a refusal must not leave a BEGIN hanging,
  // and the gate read is a plain SELECT that has nothing to do with the publish's own atomicity.
  const gate = await agreementStore.gateStatus(scope, versionId, { db });
  if (!gate.proven) {
    if (!opts.override) {
      return { refused: {
        reason: gate.reason,
        // The gate's OWN wording, never a paraphrase — it names which of the four states this is
        // ("never measured", "disagrees", "too few scenarios", "could not be read"), and those send a
        // reader to four different places.
        message: `${gate.message} Run the Lender Price agreement battery against this sheet, or publish it deliberately with a reason.`,
        gate,
      } };
    }
    const rec = await agreementStore.recordOverride(scope, {
      db, versionId, recordedBy: opts.overrideBy, reason: opts.overrideReason, nowMs: opts.nowMs || Date.now(),
    });
    // AN OVERRIDE THAT COULD NOT BE RECORDED DOES NOT PUBLISH. The recording IS the authorization — a
    // publish that proceeded here would be exactly the silent unmeasured promotion the gate exists to
    // prevent, with the added property that nothing anywhere would say it happened.
    if (!rec.ok) return { refused: { reason: rec.reason, message: rec.message, gate } };
  }
  return publishRateSheetVersionUnchecked(db, scope, versionId);
}

// The publish itself, unchanged, with the gate lifted off it. Kept separate so the transaction has one
// job and so the gate above can be read in isolation.
async function publishRateSheetVersionUnchecked(db, scope, versionId) {
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
  investorScope, resolveMarginHoldbackForInvestor,
  findInvestorByName, createInvestor, listInvestors, createProgram, listPrograms, listAllPrograms,
  setProgramLpScope,
  createRateSheetVersion, replaceBasePrices, replaceAdjustments, setPriceLimit,
  loadRateSheet, rateSheetVersionInScope, publishRateSheetVersion, publishRateSheetVersionUnchecked, currentRateSheetVersion,
};
