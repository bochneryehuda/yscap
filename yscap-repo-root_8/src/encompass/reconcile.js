'use strict';
/**
 * src/encompass/reconcile.js — WO-B. The per-file Encompass reconcile service.
 *
 * READ-ONLY sync. This module compares a PILOT file against its pulled Encompass
 * loan copy and produces a FINDINGS set (ours / theirs / status / gate) — it
 * NEVER writes to Encompass. The comparison is computed LIVE every time it is
 * read (from applications.encompass_extra — the scrubbed full loan the reader
 * already stashed — plus our own columns and the current pricing quote), so a
 * finding is never stale. The only PERSISTED state is a staff RESOLUTION
 * (encompass_sync_resolutions): a mismatch that was pulled-into-our-column
 * ('replaced', WO-C) or reviewed-and-accepted ('accepted'). A resolution carries
 * a snapshot of the two values; if either side later moves, the snapshot no
 * longer matches and the finding re-opens on its own.
 *
 * The field registry, value maps, and compare rules all live in
 * ../lib/integrations/encompass-field-map (pure). This module wires it to the DB.
 * Nothing here can write to Encompass — it only reads encompass_extra + our rows.
 */

// Only the field map is required eagerly — it is pure (no pg). `../db` and
// `./reader` are lazy-required inside the DB-backed functions so the pure cores
// (buildOurValues / compareAll / summarize) import without a Postgres driver
// (repo convention — see the draw-report lazy-require note in CLAUDE.md).
const map = require('../lib/integrations/encompass-field-map');

// Our-side deal type is NOT a column — applications stores it as `program`
// ("Fix & Flip w/ Construction" / "Bridge" / "DSCR") + `loan_type` ("Ground up"
// / "Purchase" / …). Derive a canonical token (which the dealType value map
// self-normalizes) from confident substrings; anything unrecognized returns
// undefined → the compare DEFERS it (never a heuristic-driven false finding).
// The registry keeps deal_type ADVISORY for exactly this reason.
function deriveDealType(program, loanType) {
  const s = `${program || ''} ${loanType || ''}`.toLowerCase();
  if (!s.trim()) return undefined;
  if (s.includes('bridge')) return 'bridge';
  if (s.includes('dscr') || s.includes('rental')) return 'rental';
  if (s.includes('flip')) return 'flip';                         // "fix & flip w/ construction"
  if (s.includes('hold') || s.includes('brrr')) return 'fix-and-hold';
  if (s.includes('ground') || s.includes('new construction')) return 'ground-up';
  return undefined;                                              // defer — never guess
}

// ── Pure: our-side values keyed by registry field key ───────────────────────
// Reads from the application row, the current pricing quote (computed OUTPUTS —
// initial advance, effective purchase, caps, actual leverage), and the vesting
// LLC name. A value we don't have yet (e.g. a quote-only field on an un-priced
// file) is left undefined → the compare treats it as "not comparable" (deferred),
// never a fabricated 0. Pure — takes plain objects, no DB.
function buildOurValues(app, quote, llcName) {
  const a = app || {};
  const q = quote || {};
  const sizing = q.sizing || {};
  const caps = (q.guidelines && q.guidelines.caps) || {};
  const nz = (v) => (v === null || v === undefined || v === '' ? undefined : v);
  const claimedExp = (Number(a.requested_exp_flips) || 0) + (Number(a.requested_exp_holds) || 0) + (Number(a.requested_exp_ground) || 0);

  return {
    // identity / program
    ys_loan_number: nz(a.ys_loan_number),
    property_type: nz(a.property_type),
    deal_type: deriveDealType(a.program, a.loan_type),
    exit_plan: undefined, // no column — reference-only
    loan_to_be_vested: a.llc_id ? 'Entity' : (a.borrower_id ? 'Individual' : undefined),
    vesting_llc: nz(llcName),

    // loan amount / initial advance / rehab (money)
    loan_amount: nz(a.loan_amount),
    max_total_loan: nz(a.loan_amount),
    final_initial_loan: nz(sizing.initialAdvance),
    rehab_budget: nz(a.rehab_budget),
    financed_rehab_budget: nz(sizing.rehabHoldback) !== undefined ? sizing.rehabHoldback : nz(a.rehab_budget),

    // purchase / assignment / cost (money)
    purchase_price: nz(a.purchase_price),
    effective_purchase: nz(q.assignment && q.assignment.recognizedPrice),
    contract_price: nz(a.underlying_contract_price) !== undefined ? a.underlying_contract_price : nz(a.purchase_price),
    assignment_fee: nz(a.assignment_fee),
    financed_interest_reserve: nz(sizing.financedReserve),
    total_cost: nz(sizing.costBasis),

    // valuation
    as_is_value: nz(a.as_is_value),
    arv: nz(a.arv),
    actual_arv_ltv: nz(sizing.arvPct),

    // sizing / leverage (percent)
    actual_ltc: nz(sizing.ltcPct),
    actual_initial_ltv: nz(a.ltv) !== undefined ? a.ltv : nz(sizing.acqLtvPct),
    max_initial_ltv: nz(caps.maxAcqLtv),
    max_arv_ltv: nz(caps.maxArvLtv),
    max_ltc: nz(caps.maxLtc),

    // rate / origination / term
    note_rate: nz(a.rate_pct),
    origination_pct: (q.origPct === null || q.origPct === undefined) ? undefined : Number(q.origPct) * 100,
    term_months: a.term != null && String(a.term).trim() !== '' ? parseInt(String(a.term), 10) : undefined,
    maturity_date: nz(a.maturity_date),
    funded_date: nz(a.funded_date),

    // experience / rehab-type / accrual
    total_experience_deals: claimedExp > 0 ? claimedExp : undefined,
    rehab_type: nz(a.rehab_type),
    accrual_type: nz(a.accrual_type),
  };
}

// A resolution's snapshot is the compare's NORMALIZED values, stringified — so a
// trivial format change ($450,000 → 450000) doesn't spuriously re-open, but a
// real value move does.
function snap(v) { return v === null || v === undefined ? '' : String(v); }

// The registry fields a user may "pull the Encompass value into our file" for
// (WO-C). Each maps a field key → the SINGLE applications column it writes and a
// coercion of the (already-extracted) Encompass value into that column's shape.
// ONLY fields with an unambiguous single-column home + a safe value translation
// are here — compute-only (quote-derived), reference, and heuristically-derived
// (deal_type) fields are intentionally NOT writable. The column names are fixed
// constants (never from the request), so interpolating `w.col` into the UPDATE
// is injection-safe. `map._internals.num`/`normDate` + `map.mapValue` do the
// coercion so our column stays in OUR vocabulary (e.g. Encompass 'Drawn' →
// 'non_dutch'). This is the ONLY write the sync makes — into our own column.
const WRITABLE = {
  loan_amount:        { col: 'loan_amount',                to: (t) => map._internals.num(t) },
  purchase_price:     { col: 'purchase_price',             to: (t) => map._internals.num(t) },
  contract_price:     { col: 'underlying_contract_price',  to: (t) => map._internals.num(t) },
  assignment_fee:     { col: 'assignment_fee',             to: (t) => map._internals.num(t) },
  rehab_budget:       { col: 'rehab_budget',               to: (t) => map._internals.num(t) },
  as_is_value:        { col: 'as_is_value',                to: (t) => map._internals.num(t) },
  arv:                { col: 'arv',                        to: (t) => map._internals.num(t) },
  actual_initial_ltv: { col: 'ltv',                        to: (t) => map._internals.num(t) },
  note_rate:          { col: 'rate_pct',                   to: (t) => map._internals.num(t) },
  term_months:        { col: 'term',                       to: (t) => { const n = map._internals.num(t); return n == null ? null : String(Math.round(n)); } },
  maturity_date:      { col: 'maturity_date',              to: (t) => map._internals.normDate(t) },
  accrual_type:       { col: 'accrual_type',               to: (t) => map.mapValue('accrual', t) },
};

// ── Pure: compare all registry fields, fold in persisted resolutions ────────
// `theirs` = extractFields(encompass_extra); `ours` = buildOurValues(...);
// `resolutions` = { field_key: { resolution, ours_snapshot, theirs_snapshot } }.
// Returns { fields:[…], summary:{…} }. Pure — no DB, no side effects.
function compareAll(ours, theirs, resolutions) {
  const res = resolutions || {};
  const fields = [];
  for (const e of map.REGISTRY) {
    const cmp = map.compareField(e, ours[e.key], theirs[e.key]);
    let open = false;
    let resolution = null;
    if (cmp.status === 'mismatch') {
      const r = res[e.key];
      const held = r && snap(cmp.oursNorm) === snap(r.ours_snapshot) && snap(cmp.theirsNorm) === snap(r.theirs_snapshot);
      if (held) { resolution = r.resolution; open = false; }
      else { open = true; }
    }
    fields.push({
      key: cmp.key,
      encompassFieldId: cmp.encompassFieldId,
      label: e.note || cmp.key,
      category: e.category || null,
      compare: cmp.compare,
      gate: cmp.gate,
      ours: cmp.ours,
      theirs: cmp.theirs,
      oursNorm: cmp.oursNorm,
      theirsNorm: cmp.theirsNorm,
      status: cmp.status,          // match | mismatch | incomparable | reference
      writable: Object.prototype.hasOwnProperty.call(WRITABLE, e.key), // can "use Encompass value"?
      open,                        // an unresolved mismatch
      resolution,                  // 'replaced' | 'accepted' | null
    });
  }
  return { fields, summary: summarize(fields) };
}

// Roll the fields up into the numbers the panel + the term-sheet gate need.
function summarize(fields) {
  let compared = 0, matched = 0, mismatched = 0, incomparable = 0;
  let openBlocking = 0, openAdvisory = 0, resolved = 0;
  const openBlockingKeys = [];
  for (const f of fields) {
    if (f.compare === 'reference' || f.status === 'reference') continue;
    compared += 1;
    if (f.status === 'match') matched += 1;
    else if (f.status === 'incomparable') incomparable += 1;
    else if (f.status === 'mismatch') {
      mismatched += 1;
      if (!f.open) resolved += 1;
      else if (f.gate === map.GATE.BLOCK) { openBlocking += 1; openBlockingKeys.push(f.key); }
      else if (f.gate === map.GATE.ADVISORY) openAdvisory += 1;
    }
  }
  return {
    compared, matched, mismatched, incomparable, resolved,
    openBlocking, openAdvisory, openBlockingKeys,
    clear: openBlocking === 0, // the term-sheet gate (WO-E) reads this
  };
}

// ── DB-backed: compute the live findings for one application ────────────────
// Loads the pulled loan + our row + current quote + resolutions and returns the
// full comparison. Never throws on missing data — an un-numbered / un-pulled /
// un-priced file simply yields no loan (or "not comparable" fields).
async function computeFindings(appId, dbc) {
  const c = dbc || require('../db');
  const row = (await c.query(
    `SELECT a.id, a.ys_loan_number, a.encompass_loan_guid, a.encompass_extra,
            a.encompass_last_pulled_at, a.encompass_last_error, a.borrower_id, a.llc_id,
            a.loan_amount, a.purchase_price, a.underlying_contract_price, a.assignment_fee,
            a.rehab_budget, a.as_is_value, a.arv, a.ltv, a.rate_pct, a.term, a.maturity_date, a.funded_date,
            a.program, a.loan_type, a.rehab_type, a.accrual_type, a.property_type,
            a.requested_exp_flips, a.requested_exp_holds, a.requested_exp_ground,
            l.llc_name AS llc_name
       FROM applications a
       LEFT JOIN llcs l ON l.id = a.llc_id
      WHERE a.id = $1 AND a.deleted_at IS NULL
      LIMIT 1`, [appId])).rows[0];
  if (!row) return { found: false, hasLoan: false, fields: [], summary: summarize([]) };

  const quote = (await c.query(
    `SELECT quote FROM product_registrations WHERE application_id = $1 AND is_current LIMIT 1`,
    [appId])).rows[0];

  const resRows = (await c.query(
    `SELECT field_key, resolution, ours_snapshot, theirs_snapshot, resolved_by, resolved_at, note
       FROM encompass_sync_resolutions WHERE application_id = $1`, [appId])).rows;
  const resolutions = {};
  for (const r of resRows) resolutions[r.field_key] = r;

  const loan = row.encompass_extra || null;
  const theirs = loan ? map.extractFields(loan) : {};
  const ours = buildOurValues(row, quote ? quote.quote : null, row.llc_name);
  const { fields, summary } = compareAll(ours, theirs, resolutions);

  // Attach the resolver metadata onto resolved fields for the panel.
  for (const f of fields) {
    if (f.resolution && resolutions[f.key]) {
      f.resolvedBy = resolutions[f.key].resolved_by || null;
      f.resolvedAt = resolutions[f.key].resolved_at || null;
      f.resolutionNote = resolutions[f.key].note || null;
    }
  }

  return {
    found: true,
    hasLoan: !!loan,
    guid: row.encompass_loan_guid || null,
    loanNumber: row.ys_loan_number || null,
    pulledAt: row.encompass_last_pulled_at || null,
    lastError: row.encompass_last_error || null,
    priced: !!quote,
    fields,
    summary,
  };
}

// Convenience for the term-sheet gate (WO-E): is the Encompass findings tab clear?
async function isClear(appId, dbc) {
  const c = await computeFindings(appId, dbc);
  // A file with no Encompass loan pulled is NOT "blocked" by Encompass — the gate
  // only blocks on an OPEN blocking mismatch against a loan we actually have.
  return { clear: c.summary.clear, hasLoan: c.hasLoan, openBlocking: c.summary.openBlocking, openBlockingKeys: c.summary.openBlockingKeys };
}

// WO-E — the term-sheet issuance gate decision. `block` is true ONLY when there
// is a pulled Encompass loan AND it has open blocking mismatches — so it is
// dormant when Encompass is absent/unconfigured (hasLoan false → never blocks).
// FAILS OPEN (block:false) on any error: an Encompass reconcile problem must
// never prevent a term sheet from being issued (Encompass is a cross-check, not
// the authority). A caller applies its own admin-override policy on `block`.
async function issuanceGate(appId, dbc) {
  try {
    const g = await isClear(appId, dbc);
    return { block: !!(g.hasLoan && !g.clear), hasLoan: g.hasLoan, openBlocking: g.openBlocking || 0, openBlockingKeys: g.openBlockingKeys || [] };
  } catch (_) {
    return { block: false, hasLoan: false, openBlocking: 0, openBlockingKeys: [] };
  }
}

// ── Pull one Encompass value into our column (WO-C) ─────────────────────────
// One-directional (Encompass → us), writes exactly ONE applications column,
// records the resolution as provenance, and returns the refreshed field. Any
// assigned staff may do this (owner-directed). Never writes to Encompass.
async function replaceField(appId, fieldKey, staffId, dbc) {
  // hasOwnProperty (not `WRITABLE[fieldKey]`) so a prototype key like '__proto__'
  // or 'constructor' can never resolve to a truthy inherited value.
  if (!Object.prototype.hasOwnProperty.call(WRITABLE, fieldKey)) return { ok: false, reason: 'not_writable' };
  // A caller-supplied client (e.g. the DB test) already owns its transaction — run
  // on it directly. Otherwise wrap the column write + the resolution/provenance
  // INSERT in ONE transaction so they commit atomically (never a pulled value
  // without its recorded resolution).
  if (dbc) return _doReplace(dbc, appId, fieldKey, staffId);
  const db = require('../db');
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    const r = await _doReplace(client, appId, fieldKey, staffId);
    await client.query(r.ok ? 'COMMIT' : 'ROLLBACK');
    return r;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

async function _doReplace(c, appId, fieldKey, staffId) {
  const w = WRITABLE[fieldKey];
  const cur = await computeFindings(appId, c);
  if (!cur.found) return { ok: false, reason: 'not_found' };
  if (!cur.hasLoan) return { ok: false, reason: 'no_loan' };
  const f = cur.fields.find((x) => x.key === fieldKey);
  if (!f) return { ok: false, reason: 'unknown_field' };
  if (f.theirs === null || f.theirs === undefined || f.theirs === '') return { ok: false, reason: 'no_encompass_value' };
  const writeVal = w.to(f.theirs);
  if (writeVal === null || writeVal === undefined) return { ok: false, reason: 'uncoercible' };
  const before = f.ours;

  // w.col is a fixed constant from WRITABLE (never request-derived) → injection-safe.
  await c.query(`UPDATE applications SET ${w.col} = $1, updated_at = now() WHERE id = $2 AND deleted_at IS NULL`, [writeVal, appId]);

  // Recompute to snapshot the now-normalized pair and confirm the field settled.
  const after = await computeFindings(appId, c);
  const nf = after.fields.find((x) => x.key === fieldKey) || f;
  await c.query(
    `INSERT INTO encompass_sync_resolutions (application_id, field_key, resolution, ours_snapshot, theirs_snapshot, resolved_by, note)
       VALUES ($1,$2,'replaced',$3,$4,$5,$6)
     ON CONFLICT (application_id, field_key) DO UPDATE
       SET resolution='replaced', ours_snapshot=EXCLUDED.ours_snapshot, theirs_snapshot=EXCLUDED.theirs_snapshot,
           resolved_by=EXCLUDED.resolved_by, resolved_at=now(), note=EXCLUDED.note`,
    [appId, fieldKey, snap(nf.oursNorm), snap(nf.theirsNorm), staffId || null, 'pulled from Encompass']);

  return { ok: true, field: nf, column: w.col, before, wrote: writeVal, status: nf.status };
}

// Manual READ-ONLY re-pull + fresh comparison (WO-C /refresh).
async function refresh(appId, dbc) {
  const pull = await onLoanNumberSet(appId); // read-only, best-effort
  const findings = await computeFindings(appId, dbc);
  return Object.assign({ pull }, findings);
}

// ── The immediate pull at loan-number set (WO-B) ────────────────────────────
// Best-effort: pull the matching Encompass loan so a freshly-numbered file syncs
// at once. NEVER throws — a pull failure is stamped by the reader into
// encompass_last_error and surfaced in the panel; it must not break the
// loan-number write that triggered it.
async function onLoanNumberSet(appId) {
  try {
    const reader = require('./reader');
    if (!reader || typeof reader.pullLoanForApplication !== 'function') return { ok: false, reason: 'reader unavailable' };
    return await reader.pullLoanForApplication(appId);
  } catch (e) {
    return { ok: false, reason: (e && e.message) ? e.message.slice(0, 200) : 'pull failed' };
  }
}

module.exports = {
  buildOurValues,
  compareAll,
  summarize,
  computeFindings,
  isClear,
  issuanceGate,
  replaceField,
  refresh,
  onLoanNumberSet,
  WRITABLE,
  _internals: { snap, deriveDealType },
};
