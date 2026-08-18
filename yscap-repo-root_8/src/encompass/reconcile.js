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
// The ONE name splitter/joiner/comparer. Pure (no pg), so it is safe to require
// eagerly next to the field map.
const PN = require('../lib/person-name');
// The ONE "is this the same place?" address comparer (Street≡St, Avenue≡Ave,
// ordinals, ZIP+4, units, case). Pure (no pg), safe to require eagerly.
const ADDR = require('../lib/address');
// Which note buyers may fund on which channel, and what "table funded" means for the
// sold status. Pure (it requires only the field map above), so eager is safe.
const FC = require('../lib/funding-channel');

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

// Exit plan implied by the deal type (owner-directed 2026-07-26). Fix & flip exits
// by SALE; fix & hold and DSCR/rental exit by RENTAL (refinance into a rental).
// A deal type we can't read confidently (bridge, ground-up, unknown) returns
// undefined → the compare DEFERS it rather than guessing an exit we don't know.
function exitPlanFor(dealType) {
  if (dealType === 'flip') return 'sell';
  if (dealType === 'fix-and-hold' || dealType === 'rental') return 'hold';
  return undefined;
}

// Rehab type in ENCOMPASS's vocabulary (owner-directed 2026-07-26). Encompass has
// Light / Heavy / Expansion only. Our Cosmetic + Moderate both mean LIGHT (handled
// by the rehabType value map), Heavy means HEAVY, and a file adding SQUARE FOOTAGE
// is an EXPANSION regardless of the bucket the file was typed as — the sqft flag is
// the stronger statement about the work.
// The sqft-addition signal mirrors the definition the
// pricing layer already uses (src/lib/pricing.js buildInputs `sqftAddition`): the
// rehab type mentions square footage / an addition, OR the post-rehab square
// footage exceeds the pre-rehab square footage (applications.sqft_pre/sqft_post,
// db/029). Reusing that one definition keeps the comparison in lock-step with how
// the deal was actually priced instead of inventing a second, drifting rule.
function rehabTypeFor(app) {
  const a = app || {};
  const t = String(a.rehab_type == null ? '' : a.rehab_type);
  // Require BOTH values to be genuinely present — Number(null) is 0, so a missing
  // sqft_pre against a real sqft_post would otherwise read as an addition and flip
  // an ordinary cosmetic file to Expansion (a mismatch nobody can clear here).
  const has = (v) => v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v));
  const grew = has(a.sqft_pre) && has(a.sqft_post) && Number(a.sqft_post) > Number(a.sqft_pre);
  if (/square|(^|\W)sf(\W|$)|addition/i.test(t) || grew) return 'expansion';
  return t.trim() === '' ? undefined : a.rehab_type;
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
  // ROOT CAUSE FIX (owner-reported 2026-07-26: "our system says 0.67425 and
  // Encompass says 67.425"). The frozen pricing engines express every leverage
  // ratio as a FRACTION (ltcPct = totalLoan / ltcBasis; caps are multipliers used
  // as `c.maxARLTV * arv`), while Encompass stores the same figure as a PERCENT.
  // We were shipping the raw fraction into a percent-vs-percent compare, so EVERY
  // leverage field (actual ARV-LTV, actual LTC, actual/max initial LTV, max ARV,
  // max LTC) mismatched on every file. The engines are FROZEN — their math is
  // untouched — so the conversion belongs here, at the comparison boundary, where
  // we translate our vocabulary into Encompass's. `pctOf` is deliberately
  // scale-TOLERANT: a value ≤ 1.5 is a fraction (a real leverage ratio is never
  // 1.5% — the smallest meaningful LTC/LTV/ARV is double digits), anything larger
  // is already a percent. That keeps it correct for engine fractions AND for any
  // value that already arrives as a percent (e.g. applications.ltv, which
  // product-registration stores as acqLtvPct*100), so the two can never diverge again.
  const pctOf = (v) => {
    const n = Number(v);
    if (v === null || v === undefined || v === '' || !Number.isFinite(n)) return undefined;
    if (Math.abs(n) > 1.5) return n;                       // already a percent
    // ×100 in binary floating point leaves noise (0.921034*100 = 92.10340000000001).
    // Round to 4 decimals — far finer than the 0.01-point compare tolerance, so it
    // never masks a real difference, but it keeps the value clean for display.
    return Math.round(n * 100 * 1e4) / 1e4;
  };
  const claimedExp = (Number(a.requested_exp_flips) || 0) + (Number(a.requested_exp_holds) || 0) + (Number(a.requested_exp_ground) || 0);

  return {
    // identity / program
    ys_loan_number: nz(a.ys_loan_number),
    property_type: nz(a.property_type),
    units: nz(a.units),
    deal_type: deriveDealType(a.program, a.loan_type),
    // Exit plan is DERIVED and now genuinely matched (owner-directed 2026-07-26):
    // a fix & flip exits by SALE; a fix & hold / DSCR rental exits by RENTAL/refi.
    // Anything we can't read confidently stays undefined → "no data", never a guess.
    exit_plan: exitPlanFor(deriveDealType(a.program, a.loan_type)),
    // Note buyer ↔ Encompass capital provider (STAFF-ONLY — never borrower-facing).
    capital_provider: nz(a.lender),
    loan_to_be_vested: a.llc_id ? 'Entity' : (a.borrower_id ? 'Individual' : undefined),
    // Field 4008 (owner-directed 2026-08-05): Officer when vested on an LLC,
    // Individual when vested in the borrower's own name. Derived from the SAME
    // signal as loan_to_be_vested so the two vesting rows can never disagree; when
    // Individual there is no LLC name, so vesting_llc (1859) goes not-applicable.
    vesting_title_role: a.llc_id ? 'Officer' : (a.borrower_id ? 'Individual' : undefined),
    vesting_llc: nz(llcName),
    // THE FUNDING CHANNEL — our side is the CLOSER'S WAREHOUSE PICK, and it does not
    // exist until funding. `table_funded` on closing_workflow is itself derived from
    // the warehouse (closing.tableFundedFor), so this reads the same single source the
    // purchasing fork does rather than a second opinion about how the loan funded.
    //
    // FALSE IS A REAL ANSWER, undefined is not: once a warehouse is chosen, "not table
    // funding" is a statement (this loan will be sold later), so it compares. Before
    // that there is no closing_workflow row at all, `table_funded` is null/undefined,
    // and the field's `naWhenOursMissing` makes the row read "Doesn't apply" instead of
    // holding the term sheet on every file in the pipeline. Encompass's own vocabulary
    // is what we emit — 'Table Funding' / 'Direct RTL' — so the enum compare maps both
    // sides through ONE table. We cannot tell delegated from TPR from a warehouse pick,
    // and we deliberately do not try: 'Direct RTL' maps to the coarse `direct` token,
    // which is the honest reading of what the closing desk actually recorded.
    funding_channel: a.table_funded === true ? 'Table Funding'
      : (a.table_funded === false ? 'Direct RTL' : undefined),

    // loan amount / initial advance / rehab (money)
    loan_amount: nz(a.loan_amount),
    max_total_loan: nz(a.loan_amount),
    final_initial_loan: nz(sizing.initialAdvance),
    rehab_budget: nz(a.rehab_budget),
    financed_rehab_budget: nz(sizing.rehabHoldback) !== undefined ? sizing.rehabHoldback : nz(a.rehab_budget),
    // Out-of-pocket rehab (owner-authorized 2026-07-31) = full budget − financed
    // holdback. 0 unless an approved OOP-rehab exception lowered the holdback;
    // undefined only when we have no budget to compare (incomparable, never a bad 0).
    oop_rehab: (nz(a.rehab_budget) === undefined) ? undefined
      : Math.max(0, nz(a.rehab_budget) - (nz(sizing.rehabHoldback) !== undefined ? sizing.rehabHoldback : nz(a.rehab_budget))),

    // purchase / assignment / cost (money)
    purchase_price: nz(a.purchase_price),
    // Owner-directed 2026-07-26: the effective (recognized) purchase price EQUALS the
    // purchase price whenever there is no assignment haircut — a straight purchase,
    // or an assignment whose fee is within the financeable cap. Encompass always
    // carries a value in its effective-purchase field, so falling back to the
    // purchase price makes those files a real MATCH instead of "no data to compare".
    // The quote's recognizedPrice still WINS whenever it exists (that is the capped
    // basis all frozen sizing math uses) — this only fills the no-assignment case.
    effective_purchase: nz(q.assignment && q.assignment.recognizedPrice) !== undefined
      ? q.assignment.recognizedPrice
      : nz(a.purchase_price),
    // A file that is NOT an assignment has an assignment fee of ZERO — a real
    // statement, never "missing data" — and its seller/contract price is simply
    // the purchase price. The two columns can hold STALE assignment numbers on a
    // non-assignment file (removing an assignment clears them in PILOT, but the
    // ClickUp card's currency fields can never be cleared by the push — the
    // no-wipe guard skips empty values — so the inbound pull kept re-importing
    // the old fee over the file's deliberate NULL; owner-reported 2026-08-10,
    // YSCAP258134769). is_assignment gates BOTH reads, so a stale column can
    // never make the panel claim a fee on a deal that has none: our 0 meets
    // Encompass's blank/0 through the entry's own zeroMeansNone and MATCHES,
    // while a real fee in Encompass against our 0 is an honest MISMATCH.
    contract_price: (a.is_assignment && nz(a.underlying_contract_price) !== undefined) ? a.underlying_contract_price : nz(a.purchase_price),
    assignment_fee: a.is_assignment ? nz(a.assignment_fee) : 0,
    financed_interest_reserve: nz(sizing.financedReserve),
    total_cost: nz(sizing.costBasis),

    // valuation
    as_is_value: nz(a.as_is_value),
    arv: nz(a.arv),
    actual_arv_ltv: pctOf(sizing.arvPct),

    // sizing / leverage (percent — see pctOf: engine fractions → Encompass percents)
    actual_ltc: pctOf(sizing.ltcPct),
    // applications.ltv is ALREADY stored as a percent (product-registration writes
    // acqLtvPct*100), so it is used VERBATIM — never re-scaled. Re-scaling it would
    // corrupt a genuinely small LTV (a ~1% initial advance would read as 100%) and
    // would break the "use Encompass value" pull-in, which writes the raw Encompass
    // percent straight into this column. Only the quote-sourced FRACTION is converted.
    actual_initial_ltv: nz(a.ltv) !== undefined ? Number(a.ltv) : pctOf(sizing.acqLtvPct),
    max_initial_ltv: pctOf(caps.maxAcqLtv),
    max_arv_ltv: pctOf(caps.maxArvLtv),
    max_ltc: pctOf(caps.maxLtc),

    // rate / origination / term
    note_rate: nz(a.rate_pct),
    origination_pct: (q.origPct === null || q.origPct === undefined) ? undefined : Number(q.origPct) * 100,
    term_months: a.term != null && String(a.term).trim() !== '' ? parseInt(String(a.term), 10) : undefined,
    maturity_date: nz(a.maturity_date),
    funded_date: nz(a.funded_date),

    // experience / rehab-type / accrual
    total_experience_deals: claimedExp > 0 ? claimedExp : undefined,
    rehab_type: rehabTypeFor(a),
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
      // Carried through so summarize() can tell NOT APPLICABLE (an underivable
      // our-side, e.g. exit plan on a bridge deal) from genuinely missing data.
      naWhenOursMissing: cmp.naWhenOursMissing,
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
// Owner-directed 2026-07-26: this section PASSES only when EVERY compared field
// is an EXACT MATCH. So an advisory mismatch, a "no data to compare"
// (incomparable — staff must enter it in Encompass), AND an accepted-but-still-
// differing resolution ALL count as NOT PASSING and hold the term sheet.
// Reference fields are the only ones never compared.
function summarize(fields) {
  let compared = 0, matched = 0, mismatched = 0, incomparable = 0;
  let openBlocking = 0, openAdvisory = 0, resolved = 0, excepted = 0;
  const notPassingKeys = [];
  const exceptedKeys = [];
  for (const f of fields) {
    if (f.compare === 'reference' || f.status === 'reference') continue;
    // NOT APPLICABLE ≠ missing data. A field flagged `naWhenOursMissing` whose OUR
    // side can't be derived at all (exit plan on a bridge / ground-up deal) has
    // nothing for staff to enter anywhere, so it is skipped rather than counted as
    // "no data to compare" — otherwise it would hold the term sheet forever with no
    // way to clear it. A field we CAN derive still has to match. An empty STRING
    // counts as missing too: an entity/name/text compare (vesting_llc, field 1859)
    // normalizes a blank OUR side to '' rather than null, so an individual-vested
    // file — which legitimately has no subject LLC name — must read not-applicable,
    // not hold the term sheet (owner-directed 2026-08-05).
    if (f.naWhenOursMissing && f.status === 'incomparable' && (f.oursNorm === null || f.oursNorm === undefined || f.oursNorm === '')) continue;
    compared += 1;
    if (f.status === 'match') { matched += 1; continue; }
    // A super-admin-GRANTED field exception (owner-directed 2026-08-02) makes a
    // not-matching / "no data to compare" field PASS the gate — it no longer blocks
    // the term sheet or the tape. The exception is stamped with who/why and stays
    // visible on the panel; it AUTO-VOIDS the moment the underlying values change
    // (the snapshot-hold check in computeFindings only sets `excepted` while the
    // stored snapshot still equals the live values), so a granted exception can
    // never paper over a NEW disagreement.
    if (f.excepted) { excepted += 1; exceptedKeys.push(f.key); continue; }
    notPassingKeys.push(f.key);                    // anything that is not an exact match (and not excepted)
    if (f.status === 'incomparable') incomparable += 1;
    else if (f.status === 'mismatch') {
      mismatched += 1;
      if (!f.open) resolved += 1;                  // accepted resolution (values still differ) — still not a match
      else if (f.gate === map.GATE.ADVISORY) openAdvisory += 1;
      else openBlocking += 1;
    }
  }
  return {
    compared, matched, mismatched, incomparable, resolved, excepted,
    openBlocking, openAdvisory,
    notPassing: notPassingKeys.length,
    notPassingKeys,
    exceptedKeys,
    // Back-compat alias: the term-sheet gate + the register override now name
    // EVERY not-passing field (mismatch, advisory, or no-data), not just the
    // block-gate mismatches. An EXCEPTED field is NOT here — it passes the gate.
    openBlockingKeys: notPassingKeys,
    // The term-sheet gate (WO-E) reads this — pass = every compared field is an
    // exact match OR a super-admin-granted exception.
    clear: (matched + excepted) === compared,
  };
}

// Apply super-admin FIELD EXCEPTIONS to a computed comparison (owner-directed
// 2026-08-02). A per-field row in encompass_sync_resolutions with resolution 'excepted'
// (a super admin GRANTED it) or 'exception_requested' (a staffer asked, awaiting the
// super admin) marks the matching field — but ONLY while the stored snapshot still
// equals the field's LIVE normalized values, so the exception auto-voids the instant the
// data moves and can never hide a NEW disagreement. Mutates fields in place: sets
// `excepted` (→ summarize passes it) / `exceptionRequested`, plus who / when / why for
// the panel. A field that now matches on its own needs no exception (skipped). Pure.
function applyFieldExceptions(fields, resolutions) {
  const res = resolutions || {};
  for (const f of fields) {
    const r = res[f.key];
    if (!r || (r.resolution !== 'excepted' && r.resolution !== 'exception_requested')) continue;
    if (f.status === 'match' || f.status === 'reference') continue;
    const holds = snap(f.oursNorm) === snap(r.ours_snapshot) && snap(f.theirsNorm) === snap(r.theirs_snapshot);
    if (!holds) continue; // stale — values moved since the request/grant; the field re-blocks
    if (r.resolution === 'excepted') {
      f.excepted = true;
      f.exceptedBy = r.resolved_by || null;
      f.exceptedAt = r.resolved_at || null;
      f.exceptionNote = r.note || null;
    } else {
      f.exceptionRequested = true;
      f.exceptionRequestedBy = r.requested_by || null;
      f.exceptionRequestedAt = r.requested_at || null;
      f.exceptionNote = r.note || null;
    }
  }
  return fields;
}

// ── Identity + subject-address comparison (owner-directed 2026-07-26) ────────
// Surface borrower identity (name / DOB / email / phone) + the subject PROPERTY
// address in the SAME comparison, matched. Read from the stored Encompass loan
// (encompass_extra) — which keeps name/DOB/email/phone/subject-address but
// SCRUBS the SSN (PII governance), so SSN is a separate PII-safe hash compare
// (added next). These rows are compare-only — we NEVER overwrite borrower PII
// from a read — and BLOCK-gated (must match to pass). Pure — no DB.
function _digits(v) { return String(v == null ? '' : v).replace(/\D/g, ''); }
// A ZIP+4 is the SAME zip as its 5-digit form (owner-reported 2026-07-26: Encompass
// carries 11230-1234 where we carry 11230 — "technically the same address"). Compare
// on the 5-digit base so a formatting difference is never a mismatch; the extra 4
// are a postal routing detail, not a different place.
function _zip5(v) {
  const d = String(v == null ? '' : v).replace(/\D/g, '');
  return d ? d.slice(0, 5) : '';
}
// Strip a trailing ZIP+4 down to the 5-digit zip anywhere in a free-text address,
// so a one-line "…, NY 11230-1234" equals a structured "… NY 11230".
function _stripPlus4(s) { return String(s == null ? '' : s).replace(/\b(\d{5})-\d{4}\b/g, '$1'); }
function _addrStr(a) {
  if (a == null) return '';
  if (typeof a === 'string') return _stripPlus4(a.trim());
  if (typeof a !== 'object') return _stripPlus4(String(a));
  // Prefer a structured build; fall back to a one-line/formatted string when the
  // object only carries that (an Encompass/ClickUp formatted address), so a
  // one-line-only side is compared instead of reading as "no data".
  const street = a.street || a.line1 || a.address1 || a.streetAddress || a.addressStreetLine1 || a.address || '';
  const zip = _zip5(a.zip || a.postalCode || a.zipCode || a.postal_code);
  const parts = [street, a.city, a.state, zip];
  const oneLine = _stripPlus4(String(a.oneLine || a.formatted_address || a.formattedAddress || a.fullAddress || a.display || '').trim());
  // Require a STREET before trusting the structured build: without it we would be
  // comparing a fragment (zip only, or state only), and two thin records would
  // report a false MATCH on a block-gated identity row. With no street, fall back
  // to a one-line address if there is one, else report nothing to compare.
  if (!String(street || '').trim()) return oneLine;
  const built = parts.map((x) => (x == null ? '' : String(x).trim())).filter((x) => x !== '').join(' ');
  return _stripPlus4(built) || oneLine;
}
function _named(p) { return !!(p && ((p.firstName && String(p.firstName).trim()) || (p.lastName && String(p.lastName).trim()))); }

// Build a synthetic Encompass party from the values read BY FIELD NUMBER (owner-directed
// 2026-08-02, YSCAP258134762). Encompass standard field ids address the pair-1 borrower
// (4000/4002/…) and pair-1 co-borrower (4004/4006/…); reading them BY NUMBER is
// location-independent, so this recovers a party the stored applications[] JSON subtree
// left out — a snapshot pulled before the co-borrower was added, or a name at a
// non-standard path. Field numbers are the owner-confirmed standard ids in
// map.IDENTITY_MAP; the phone slots map home→homePhoneNumber, cell→mobilePhone,
// work→workPhoneNumber so `_phones` reads them. The SSN is already the HASHED form
// (reader.scrubFieldValuesSsn replaced raw 65/97 with _ssn_*_hash/_last4 before storage),
// so plaintext SSN never reaches here. Returns null when there is no name AND no SSN —
// never a fabricated empty party. Pure.
function _partyFromFieldValues(fv, slot) {
  if (!fv || typeof fv !== 'object') return null;
  const g = (id) => { const v = fv[id]; return (v == null || String(v).trim() === '') ? null : String(v).trim(); };
  const B = slot === 'coBorrower'
    ? { first: '4004', last: '4006', middle: '4005', dob: '1403', email: '1268', home: '98', cell: '1480', work: '4534', ssnHash: '_ssn_cb_hash', ssnL4: '_ssn_cb_last4' }
    : { first: '4000', last: '4002', middle: '4001', dob: '1402', email: '1240', home: '66', cell: '1490', work: '4533', ssnHash: '_ssn_b_hash', ssnL4: '_ssn_b_last4' };
  const first = g(B.first), last = g(B.last), ssnHash = g(B.ssnHash);
  if (!first && !last && !ssnHash) return null; // nothing to represent
  const p = {};
  if (first) p.firstName = first;
  if (last) p.lastName = last;
  const mid = g(B.middle); if (mid) p.middleName = mid;
  const dob = g(B.dob); if (dob) p.birthDate = dob;
  const email = g(B.email); if (email) p.emailAddressText = email;
  const home = g(B.home); if (home) p.homePhoneNumber = home;
  const cell = g(B.cell); if (cell) p.mobilePhone = cell;
  const work = g(B.work); if (work) p.workPhoneNumber = work;
  if (ssnHash) { p._ssnHash = ssnHash; const l4 = g(B.ssnL4); if (l4) p._ssnLast4 = l4; }
  return p;
}

// ── Borrower-pair party resolution (owner-directed 2026-08-02) ───────────────
// Encompass models up to FOUR borrower pairs — `applications[0..3]`, each with a
// `.borrower` and a `.coBorrower`. Our SECOND borrower is NOT always Encompass's
// "co-borrower": they are sometimes entered as the PRIMARY borrower of a SECOND
// pair (same field numbers, different pair), and a file can carry three people
// (a borrower + a co-borrower on pair 1 and a second-pair borrower on pair 2). So
// we never assume a fixed slot: gather EVERY named party across every pair and
// MATCH each of OUR people to wherever their name (or SSN) actually appears —
// "look where the name exists and go with that."
function _collectParties(loan) {
  const apps = (loan && Array.isArray(loan.applications)) ? loan.applications : [];
  const out = [];
  for (let i = 0; i < apps.length; i++) {
    const app = apps[i];
    if (!app || typeof app !== 'object') continue;
    if (app.borrower && _named(app.borrower)) out.push({ party: app.borrower, pairIndex: i, role: 'borrower' });
    if (app.coBorrower && _named(app.coBorrower)) out.push({ party: app.coBorrower, pairIndex: i, role: 'coBorrower' });
  }
  // AUTHORITATIVE BY-NUMBER RECOVERY (owner-directed 2026-08-02, YSCAP258134762): the
  // co-borrower is sometimes WHOLLY MISSING from the stored applications[] subtree above
  // (added in Encompass after the snapshot, or the party stored at a non-standard JSON
  // path so it reads as empty), so every co-borrower field reads "no data to compare" and
  // BLOCK-holds the term sheet. The identity fields ALSO have standard field ids read BY
  // NUMBER into `_fieldValues` (the same by-number read economics uses for 1859/388, at
  // party granularity — it recovers a MISSING party, it does not per-field re-heal a party
  // already present in the subtree). Append a synthetic pair-1 co-borrower (and, only when
  // the pair-1 borrower slot is itself empty, a synthetic borrower) as ADDITIONAL
  // candidates, tagged `byNumber` so the fallbacks below never mis-slot them. Matching
  // claims each party at most once and prefers SSN then name, so a synthetic DUPLICATE of a
  // party already present is never chosen, while a genuinely missing party is now found.
  //
  // WHY the borrower guard: a synthetic BORROWER duplicating an already-present, NAMED
  // pair-1 borrower would let our primary match the synthetic (e.g. full name vs an
  // abbreviated subtree name) and leave the subtree copy unclaimed for the co-borrower
  // fallback to grab as a phantom. Appending the borrower synthetic ONLY when the subtree
  // has no named pair-1 borrower removes that path while still recovering a genuinely
  // missing primary. Degrades to nothing when the by-number read did not run (Encompass
  // unconfigured / fieldReader unavailable / a pre-wiring snapshot).
  const fv = loan && loan._fieldValues;
  if (fv && typeof fv === 'object') {
    const cb = _partyFromFieldValues(fv, 'coBorrower');
    if (cb) out.push({ party: cb, pairIndex: 0, role: 'coBorrower', byNumber: true });
    const app0Borrower = apps[0] && apps[0].borrower;
    if (!_named(app0Borrower)) {
      const b = _partyFromFieldValues(fv, 'borrower');
      if (b) out.push({ party: b, pairIndex: 0, role: 'borrower', byNumber: true });
    }
  }
  return out;
}

// SSN half — a one-way keyed hash equal on both sides is PROOF of identity. The
// best still-unclaimed party whose stored `_ssnHash` equals ours. Pure.
function _matchBySsn(person, parties, used) {
  if (!person || !person.ssnHash) return null;
  const e = parties.find((x) => !used.has(x.party) && x.party && x.party._ssnHash && x.party._ssnHash === person.ssnHash);
  return e ? { party: e.party, pairIndex: e.pairIndex, role: e.role, method: 'ssn' } : null;
}
// Name half — first + surname must agree (middle-name tolerant); a full match
// beats a middle-only match. Nothing of ours to match on → null (never guessed).
function _matchByName(person, parties, used) {
  if (!person || !(person.first || person.last)) return null;
  const ourParts = { first: person.first, middle: person.middle, last: person.last, suffix: person.suffix };
  let detailOnly = null;
  for (const e of parties) {
    if (used.has(e.party)) continue;
    const p = e.party;
    const cmp = PN.compareNames(ourParts, { first: p.firstName, middle: p.middleName, last: p.lastName, suffix: p.suffixToName });
    if (cmp.status === 'match') return { party: p, pairIndex: e.pairIndex, role: e.role, method: 'name' };
    if (cmp.status === 'match_detail_only' && !detailOnly) detailOnly = e;
  }
  return detailOnly ? { party: detailOnly.party, pairIndex: detailOnly.pairIndex, role: detailOnly.role, method: 'name' } : null;
}
// Per-person convenience (SSN, then name) for callers/tests. NOTE: compareIdentity
// deliberately does NOT use this directly — it assigns SSN matches for BOTH of our
// people FIRST, then names, so a definitive SSN proof for one person is never
// pre-empted by the OTHER person's weaker name match (order-independent). `used`
// is a Set of already-claimed party objects. Returns { party, pairIndex, role,
// method } or null. Pure — no DB, no network.
function _matchParty(person, parties, used) {
  return _matchBySsn(person, parties, used) || _matchByName(person, parties, used);
}

// Every phone number Encompass carries for a party — home / cell / work — read
// per-pair off the applications[] subtree (std field ids 66 / 1490 / 4533 for a
// borrower, 98 / 1480 / 4534 for a co-borrower). Our ONE number matches ANY of
// them (owner: "one is home, one is cell, one is work — any of them is good").
// Real loans and our own enrich.partyContacts disagree on the exact JSON key
// (homePhone vs homePhoneNumber, cellPhone vs cellPhoneNumber vs mobilePhone,
// workPhone vs workPhoneNumber vs businessPhoneNumber), so read EVERY spelling —
// match-any only ever helps: an absent key is ignored, never a false match. Keep
// this list a superset of enrich.js partyContacts so the two never drift.
function _phones(p) {
  if (!p || typeof p !== 'object') return [];
  return [
    p.mobilePhone, p.cellPhone, p.cellPhoneNumber,
    p.homePhoneNumber, p.homePhone,
    p.workPhoneNumber, p.workPhone, p.businessPhone, p.businessPhoneNumber,
  ].filter((v) => v != null && String(v).trim() !== '');
}
// A party's email(s) — the personal email (field 1240 / 1268 = emailAddressText)
// first, then every other spelling enrich.partyContacts reads, so a work / alt
// email still matches. Match-any, same safe failure mode as _phones.
function _emails(p) {
  if (!p || typeof p !== 'object') return [];
  return [p.emailAddressText, p.email, p.emailAddress, p.workEmailAddress, p.workEmail]
    .filter((v) => v != null && String(v).trim() !== '');
}

// A short plain-language note for the panel: WHERE in Encompass this person was
// found and HOW they were matched, so "why did it match / where is it reading
// from" is answerable at a glance.
function _pairLabel(hit) {
  if (!hit) return null;
  const role = hit.role === 'coBorrower' ? 'co-borrower' : 'primary borrower';
  const how = hit.method === 'ssn' ? 'by SSN' : 'by name';
  return `Matched to Encompass borrower pair ${hit.pairIndex + 1} (${role}), ${how}.`;
}

function compareIdentity(row, loan) {
  const N = map._internals;
  const apps = (loan && Array.isArray(loan.applications)) ? loan.applications : [];

  // BORROWER PAIRS (owner-directed 2026-08-02). Encompass carries up to four
  // borrower pairs and our people can sit in ANY slot — a second borrower is
  // sometimes the PRIMARY of a second pair, not a "co-borrower". So we gather
  // every named party across every pair and match OURS to wherever their name or
  // SSN actually is, claiming each Encompass person at most once.
  const parties = _collectParties(loan);
  const used = new Set();

  const ourPrimary = { first: row.b_first_name, middle: row.b_middle_name, last: row.b_last_name, suffix: row.b_name_suffix, ssnHash: row.b_ssn_hash };
  const ourSecond = { first: row.cb_first_name, middle: row.cb_middle_name, last: row.cb_last_name, suffix: row.cb_name_suffix, ssnHash: row.cb_ssn_hash };
  // SSN proof for BOTH people FIRST — a hash match outranks any name match — then
  // name for whoever is still unmatched. Doing SSN globally before names makes the
  // assignment order-independent: a definitive SSN match for one borrower can never
  // be pre-empted by the OTHER borrower's weaker name match on the same party.
  let primaryHit = _matchBySsn(ourPrimary, parties, used); if (primaryHit) used.add(primaryHit.party);
  let secondHit = _matchBySsn(ourSecond, parties, used); if (secondHit) used.add(secondHit.party);
  if (!primaryHit) { primaryHit = _matchByName(ourPrimary, parties, used); if (primaryHit) used.add(primaryHit.party); }
  if (!secondHit) { secondHit = _matchByName(ourSecond, parties, used); if (secondHit) used.add(secondHit.party); }

  let bor;
  if (primaryHit) bor = primaryHit.party;
  else {
    // No primary match. Prefer pair 1's NAMED subtree borrower so a genuine "our borrower
    // isn't in Encompass" still surfaces as a real comparison (a name mismatch), never
    // silently vanishing. If that slot is EMPTY, fall to the authoritative by-number
    // borrower (a primary recovered by number) — this both surfaces the honest mismatch
    // AND claims that synthetic, so it can't sit unclaimed for the co-borrower fallback to
    // grab as a phantom "co-borrower". Never a party already claimed by our second.
    const b0 = (apps[0] && _named(apps[0].borrower) && !used.has(apps[0].borrower)) ? apps[0].borrower : null;
    if (b0) { bor = b0; used.add(b0); }
    else {
      const syn = parties.find((e) => e.byNumber && e.role === 'borrower' && !used.has(e.party));
      if (syn) { bor = syn.party; used.add(syn.party); } else bor = {};
    }
  }

  let coBor;
  if (secondHit) coBor = secondHit.party;
  else {
    // The first still-unclaimed SUBTREE party — naturally pair 1's co-borrower, else a
    // SECOND pair's borrower — so both historical representations, and an "Encompass has
    // an extra person we don't", still surface. A BY-NUMBER synthetic is deliberately
    // EXCLUDED here: it addresses pair 1's own borrower/co-borrower slot and is trusted as
    // OUR second only when our person actually matched it (secondHit above). Assigning an
    // UNMATCHED by-number party to the co-borrower slot would surface the primary (or an
    // unrelated pair-1 co-borrower) as a phantom co-borrower on a single-borrower file.
    const fb = parties.find((e) => !used.has(e.party) && !e.byNumber);
    coBor = fb ? fb.party : {};
  }

  const prop = (loan && loan.property) ? loan.property : {};
  const out = [];
  const push = (key, label, compare, ours, theirs) => {
    const norm = (v) => {
      if (v == null || v === '') return null;
      // Address joins `name` on the punctuation-insensitive normalizer so
      // "12 Main St, Brooklyn NY" ≡ "12 Main St Brooklyn NY" (commas/periods are
      // formatting, not a different address) — same spirit as the ZIP+4 fix.
      if (compare === 'name' || compare === 'address') return N.normName(v);
      if (compare === 'date') return N.normDate(v);
      if (compare === 'phone') { const d = _digits(v); return d === '' ? null : d.slice(-10); }
      return N.normText(v); // email / text
    };
    const oursNorm = norm(ours);
    const theirsNorm = norm(theirs);
    let status = 'incomparable';
    if (oursNorm != null && oursNorm !== '' && theirsNorm != null && theirsNorm !== '') {
      status = oursNorm === theirsNorm ? 'match' : 'mismatch';
      // AN ADDRESS IS COMPARED BY PLACE, NOT BY LETTERS (owner-reported: our
      // "407 Graves Street Syracuse NY 13203" vs Encompass's "407 GRAVES ST
      // SYRACUSE NY 13203" read "Doesn't match" and escalated to super admin —
      // a BLOCK-gated identity row, so it held the term sheet on a file where
      // nothing was actually wrong). normName above is punctuation/case tolerant
      // but NOT USPS-abbreviation aware, so "Street" ≠ "ST". A.sameAddress is the
      // ONE blessed comparer that knows Street≡St / Avenue≡Ave / ordinals / ZIP+4
      // / units — the same one every other address comparison in the app uses. It
      // is applied ONLY to UPGRADE a letters-mismatch to a match (a letters-equal
      // pair is already a match, and it stays conservative — it never turns a real
      // disagreement into a false match), so it can only ever ADD matches here.
      if (status === 'mismatch' && compare === 'address' && ADDR.sameAddress(ours, theirs)) {
        status = 'match';
      }
    }
    out.push({
      key, encompassFieldId: null, label, category: 'identity', compare,
      gate: map.GATE.BLOCK,
      ours: (ours == null || ours === '') ? null : String(ours),
      theirs: (theirs == null || theirs === '') ? null : String(theirs),
      oursNorm, theirsNorm, status,
      writable: false, open: status === 'mismatch', resolution: null,
    });
  };
  // SSN compare — owner-directed 2026-07-26. Compared by the ONE-WAY keyed HMAC
  // hash ONLY (our borrowers.ssn_hash vs the hash the reader stored for the
  // Encompass party); the raw SSN is NEVER read, printed, or stored on either
  // side. Displayed masked (last-4 only). BLOCK-gated + compare-only (a read
  // never overwrites a borrower SSN). "No data to compare" (a hash missing on
  // either side) holds the term sheet, exactly like the other identity fields.
  // A person's NAME, compared as first / middle / last / suffix rather than as
  // one joined string. Shape-identical to `push` so the panel, the finding
  // roll-up and the term-sheet gate all read it exactly as before — only the
  // verdict is smarter. A middle-name-only difference reports MATCH (the same
  // person, one side simply carries less detail); `detail` records that for the
  // panel so staff can still see the two spellings side by side.
  const pushName = (key, label, ourP, theirP, matchNote) => {
    const cmp = PN.compareNames(ourP, theirP);
    const status = cmp.status === 'match' || cmp.status === 'match_detail_only' ? 'match'
      : cmp.status === 'mismatch' ? 'mismatch' : 'incomparable';
    out.push({
      key, encompassFieldId: null, label, category: 'identity', compare: 'name',
      gate: map.GATE.BLOCK,
      ours: cmp.ours || null, theirs: cmp.theirs || null,
      oursNorm: cmp.ours ? N.normName(cmp.ours) : null,
      theirsNorm: cmp.theirs ? N.normName(cmp.theirs) : null,
      status,
      // 'the same person, written with a different amount of detail' — surfaced
      // so a reviewer can still see the two spellings without it being a finding.
      detailOnly: cmp.status === 'match_detail_only',
      // WHERE in Encompass this person was found + HOW (borrower pair, by name /
      // by SSN). Populated for every real match (including a legitimate pair-1
      // name match); null ONLY on the no-hit fallback. The panel can show it so
      // the multi-pair match is transparent.
      matchNote: matchNote || null,
      writable: false, open: status === 'mismatch', resolution: null,
    });
  };

  // Our ONE value vs ANY of several Encompass values — phone (home / cell / work)
  // and email (personal / work). A match on ANY is a match; a value present on
  // both sides that agrees with none is a mismatch; a blank side stays
  // incomparable. Same row shape as `push`. This is the owner's "any of them is
  // good" rule, and it composes with the borrower-pair resolution above because
  // `_phones`/`_emails` read the MATCHED party's own subtree.
  const pushAny = (key, label, compare, ours, theirsArr) => {
    const normOne = (v) => {
      if (v == null || String(v).trim() === '') return null;
      if (compare === 'phone') { const d = _digits(v); return d === '' ? null : d.slice(-10); }
      return N.normText(v); // email / text
    };
    const pairs = (Array.isArray(theirsArr) ? theirsArr : [])
      .map((v) => ({ raw: v, norm: normOne(v) }))
      .filter((x) => x.norm != null && x.norm !== '');
    const o = normOne(ours);
    let status = 'incomparable';
    let theirsShown = pairs.length ? pairs[0].raw : null;
    let theirsNorm = pairs.length ? pairs[0].norm : null;
    if (o != null && o !== '' && pairs.length) {
      const hit = pairs.find((x) => x.norm === o);
      if (hit) { status = 'match'; theirsShown = hit.raw; theirsNorm = o; }
      else { status = 'mismatch'; }
    }
    out.push({
      key, encompassFieldId: null, label, category: 'identity', compare,
      gate: map.GATE.BLOCK,
      ours: (ours == null || ours === '') ? null : String(ours),
      theirs: theirsShown == null ? null : String(theirsShown),
      oursNorm: o, theirsNorm, status,
      writable: false, open: status === 'mismatch', resolution: null,
    });
  };

  const _mask4 = (l4) => { const d = _digits(l4); return d ? `•••-••-${d.slice(-4)}` : null; };
  const pushSsn = (key, label, ourHash, ourLast4, theirHash, theirLast4) => {
    let status = 'incomparable';
    if (ourHash && theirHash) status = ourHash === theirHash ? 'match' : 'mismatch';
    out.push({
      key, encompassFieldId: null, label, category: 'identity', compare: 'ssn',
      gate: map.GATE.BLOCK,
      ours: _mask4(ourLast4), theirs: _mask4(theirLast4),
      // presence flags only — the hashes themselves never leave the server
      oursNorm: ourHash ? 'present' : null, theirsNorm: theirHash ? 'present' : null,
      status, writable: false, open: status === 'mismatch', resolution: null,
    });
  };

  // Primary borrower + subject property address.
  //
  // NAME COMPARE (owner-directed 2026-07-27). Encompass splits a person into
  // firstName / middleName / lastName (+ suffixToName); PILOT now does the same
  // (db/345). Before that, this compared a joined first+last on both sides — so a
  // borrower whose Encompass copy is correctly split read as a MISMATCH against
  // our merged "Issac Michael" first name, and this row is BLOCK-gated, so it
  // held the term sheet on a file where nothing was actually wrong.
  //
  // `pushName` compares the two people by MEANING (lib/person-name): the first
  // name and the surname must agree, a suffix present on both sides must agree
  // (a father and his son are different people), and the MIDDLE NAME is tolerant
  // — a side that omits it, or carries an initial where the other has the full
  // word, is the same person. A genuinely different middle name still mismatches.
  const ourParts = { first: row.b_first_name, middle: row.b_middle_name, last: row.b_last_name, suffix: row.b_name_suffix };
  const theirParts = { first: bor.firstName, middle: bor.middleName, last: bor.lastName, suffix: bor.suffixToName };
  pushName('id_borrower_name', 'Borrower name', ourParts, theirParts, _pairLabel(primaryHit));
  push('id_dob', 'Date of birth', 'date', row.b_dob || null, bor.birthDate || null);
  pushAny('id_email', 'Email', 'email', row.b_email || null, _emails(bor));
  pushAny('id_phone', 'Phone', 'phone', row.b_cell_phone || null, _phones(bor));
  // SSN is surfaced only when at least ONE side actually has one. A file with no
  // SSN anywhere (common on early/legacy files — SSN is often not captured by
  // term-sheet time) does NOT get a blocking "no data" SSN row; but the moment an
  // SSN exists on either side it must MATCH (a one-sided SSN stays incomparable →
  // not-passing → "enter it in the other system"), so the compare keeps its full
  // verification power without over-blocking a genuinely SSN-less file.
  if (row.b_ssn_hash || bor._ssnHash) {
    pushSsn('id_ssn', 'Social Security number', row.b_ssn_hash || null, row.b_ssn_last4 || null, bor._ssnHash || null, bor._ssnLast4 || null);
  }
  push('id_property_address', 'Property address', 'address', _addrStr(row.property_address), _addrStr(prop));

  // Co-borrower — surfaced ONLY when a co-borrower exists on EITHER side (our
  // co_borrower_id, or an Encompass co-borrower / 2nd-pair borrower). A single-
  // borrower file has none → we surface nothing (never a false "no data" block).
  // A co-borrower present on only one side stays incomparable → not-passing, which
  // correctly flags that the two systems disagree on the co-borrower.
  const ourCoParts = { first: row.cb_first_name, middle: row.cb_middle_name, last: row.cb_last_name, suffix: row.cb_name_suffix };
  const theirCoParts = { first: coBor.firstName, middle: coBor.middleName, last: coBor.lastName, suffix: coBor.suffixToName };
  const ourCoName = PN.joinFullName(ourCoParts);
  const theirCoName = PN.joinFullName(theirCoParts);
  const hasCo = !!(row.co_borrower_id || ourCoName || theirCoName || coBor.birthDate || _emails(coBor).length || _phones(coBor).length || coBor._ssnHash || row.cb_ssn_hash);
  if (hasCo) {
    pushName('id_coborrower_name', 'Co-borrower name', ourCoParts, theirCoParts, _pairLabel(secondHit));
    push('id_coborrower_dob', 'Co-borrower date of birth', 'date', row.cb_dob || null, coBor.birthDate || null);
    pushAny('id_coborrower_email', 'Co-borrower email', 'email', row.cb_email || null, _emails(coBor));
    pushAny('id_coborrower_phone', 'Co-borrower phone', 'phone', row.cb_cell_phone || null, _phones(coBor));
    if (row.cb_ssn_hash || coBor._ssnHash) {
      pushSsn('id_coborrower_ssn', 'Co-borrower Social Security number', row.cb_ssn_hash || null, row.cb_ssn_last4 || null, coBor._ssnHash || null, coBor._ssnLast4 || null);
    }
  }
  return out;
}

// Our-side SSN → the keyed HMAC hash used for the PII-safe compare. Prefers the
// stored borrowers.ssn_hash; falls back to deriving it from the encrypted SSN so
// a borrower with an SSN on file but a null hash column is still comparable. The
// decrypted digits live only inside this call (never stored/returned/logged);
// only the one-way hash escapes. Returns null when there is no usable SSN.
function _effectiveSsnHash(storedHash, encrypted) {
  if (storedHash) return storedHash;
  if (!encrypted) return null;
  try {
    const digits = require('../lib/crypto').decryptSSN(encrypted);
    if (!digits) return null;
    return require('../clickup/identity').ssnHash(digits, require('../config').ssnMatchKey);
  } catch (_) { return null; }
}

// True when the stored loan copy already carries authoritative field-reader values
// (read BY NUMBER). When it does NOT, the two fields that live only there — 1859
// (vesting LLC) and 388 (origination %) — fall back to JSON paths that are missing /
// wrong, which is the owner-reported "no data" LLC + "2% not 1%" origination.
function _hasFieldValues(loan) {
  return !!(loan && loan._fieldValues && typeof loan._fieldValues === 'object' && Object.keys(loan._fieldValues).length);
}

// True when the stored `_fieldValues` already carries the BY-NUMBER identity read
// (owner-directed 2026-08-02). A snapshot from before this wiring may have the economics
// `_fieldValues` (1859/388) but NO identity fields, so the co-borrower still can't be
// recovered by number — that file must re-heal once to pull identity too. The definitive
// marker is `_idRead`, stamped whenever the identity ids were REQUESTED by number (even if
// the tenant returned some empty / the persona lacks scope for the SSN fields), so a file
// heals AT MOST ONCE and never re-fires a live read on every panel view. The borrower-name
// and hashed-SSN keys are a fallback marker for a snapshot written before the sentinel
// existed. Absent all of them → heal.
function _hasIdentityFieldValues(loan) {
  const fv = loan && loan._fieldValues;
  if (!fv || typeof fv !== 'object') return false;
  return ('_idRead' in fv)
    || ('4002' in fv) || ('4000' in fv) || ('4006' in fv) || ('4004' in fv)
    || ('_ssn_b_hash' in fv) || ('_ssn_cb_hash' in fv);
}

// Best-effort SELF-HEAL of a stale stored loan copy (owner-reported 2026-07-26). The
// panel reads applications.encompass_extra — a snapshot pulled BEFORE the read-by-number
// wiring (or before this code deployed) has no `_fieldValues`, so 1859/388 read wrong.
// Rather than make a human re-pull every previous file one by one, fill `_fieldValues`
// on the spot: ONE read-by-number, verified to belong to THIS loan (mirrors the reader's
// SAME-LOAN guard on field 364), merged into the in-memory loan and PERSISTED so the very
// next view is correct and later views are instant. NEVER throws — a failure leaves the
// path-based read exactly as it was. Returns the (possibly healed) loan object.
// READ-ONLY w.r.t. Encompass (fieldReader is allowlisted); it only writes OUR own cache.
async function _ensureFieldValues(c, appId, loan, guid, ourLoanNumber) {
  // Heal when the by-number values are missing OR present without the identity read
  // (a pre-2026-08-02 snapshot may hold economics `_fieldValues` but no identity, so the
  // co-borrower still can't be recovered by number). Once both are stored the file skips
  // this on every later view.
  if (!loan || typeof loan !== 'object' || !guid) return loan;
  if (_hasFieldValues(loan) && _hasIdentityFieldValues(loan)) return loan;
  try {
    const enc = require('../lib/integrations/encompass');
    if (!enc.configured()) return loan;
    // Economics AND identity (name/DOB/email/phone/SSN) BY NUMBER — so the identity
    // compare is location-independent + self-healing exactly like 1859/388.
    const vals = await require('./client').readFields(guid, map.allFieldIds().concat(map.identityFieldIds()));
    if (!vals || !Object.keys(vals).length) return loan;
    // Hash + strip the plaintext SSN (65/97) BEFORE it is used or persisted.
    require('./reader').scrubFieldValuesSsn(vals);
    vals._idRead = 1; // identity was read by number — heal at most once (see _hasIdentityFieldValues)
    const norm = (v) => String(v == null ? '' : v).trim().toUpperCase().replace(/\s+/g, '');
    const theirLoanNo = vals['364'];
    // If field 364 came back and disagrees with our loan number, these values are for a
    // DIFFERENT loan — do not trust or store them (belt-and-suspenders; the GUID was
    // already validated at pull time). A missing 364 is fine (nothing to contradict).
    if (theirLoanNo && ourLoanNumber && norm(theirLoanNo) !== norm(ourLoanNumber)) return loan;
    const healed = Object.assign({}, loan, { _fieldValues: vals });
    // Persist ONLY the _fieldValues key via a jsonb merge — so a concurrent reader pull
    // that wrote a FRESHER encompass_extra is not clobbered by this (older) in-memory
    // copy. The `||` shallow-merges, replacing just _fieldValues and keeping every other
    // key from whatever the row currently holds.
    await c.query(
      `UPDATE applications
          SET encompass_extra = COALESCE(encompass_extra, '{}'::jsonb) || jsonb_build_object('_fieldValues', $1::jsonb)
        WHERE id = $2 AND deleted_at IS NULL`,
      [JSON.stringify(vals), appId],
    ).catch(() => {});
    return healed;
  } catch (_) {
    return loan; // best-effort — degrade to the stored path-based read
  }
}

// ── DB-backed: compute the live findings for one application ────────────────
// Loads the pulled loan + our row + current quote + resolutions and returns the
// full comparison. Never throws on missing data — an un-numbered / un-pulled /
// un-priced file simply yields no loan (or "not comparable" fields).
/**
 * THE NOTE BUYER'S OWN RULE ABOUT HOW A LOAN MAY FUND (owner-directed 2026-08-09): "any file that
 * is Blue Lake or emcap or corrfirst it should never be table funding — it should always be direct
 * RTL / delegate or direct RTL / w tpr; it needs to follow this rule in order to pass Encompass
 * Sync." Returns [] or ONE synthetic panel row.
 *
 * WHY THIS IS NOT A REGISTRY ENTRY. Every registry row asks "do our two copies of this value
 * agree?", and both sides have to exist for the question to mean anything. This asks something
 * else entirely: is the value Encompass holds LEGAL for this file's note buyer? It is about one
 * side alone, it must fire long before our closing desk has an opinion (that is the point — the
 * channel is set in Encompass at origination, and the whole reason to check it is to catch it
 * being wrong EARLY), and it is keyed on a second field. So it is its own row, in the shape
 * compareIdentity already established for non-registry findings, and it joins the same summary.
 *
 * BLOCK-gated, because the owner said it must be followed to pass the sync — and safe to gate
 * because src/lib/funding-channel.js only ever reports a violation on a POSITIVE reading (a
 * recognised buyer with a rule, and Encompass positively saying table funding). A blank channel,
 * an unknown buyer, a buyer with no rule and an unrecognised channel value all produce nothing or
 * an informational row that matches. The recorded way past a genuine violation is the same
 * super-admin field exception every other row on this panel already has — `applyFieldExceptions`
 * keys on `field_key`, so this row gets that for free.
 *
 * PURE — takes the already-extracted values. No DB, no network, never throws.
 */
function compareFundingChannel(ourBuyer, theirBuyer, theirChannel, ourTableFunded) {
  const out = [];

  // (b) DO THE CLOSING DESK AND ENCOMPASS AGREE ABOUT HOW THIS LOAN FUNDED? Advisory, and emitted
  // ONLY when BOTH sides are positively readable and they actually disagree. Silence otherwise —
  // an unpicked warehouse (every file before funding) and an Encompass value the shared table does
  // not carry both produce nothing at all, which is what keeps an unverified tenant value from
  // ever holding a term sheet or a tape.
  try {
    const ch = FC.channelKey(theirChannel);
    if (ch && (ourTableFunded === true || ourTableFunded === false)) {
      const oursTable = ourTableFunded === true;
      const theirsTable = FC.isTableFunding(ch);
      if (oursTable !== theirsTable) {
        out.push({
          key: 'funding_channel_agreement',
          encompassFieldId: 'CX.TABLEFUNDER',
          label: 'How the loan funded — closing desk vs Encompass',
          category: 'program',
          compare: 'rule',
          gate: map.GATE.ADVISORY,
          ours: oursTable ? 'Table Funding (the warehouse line the closer funded on)' : 'Direct RTL (a warehouse line, not table funding)',
          theirs: String(theirChannel),
          oursNorm: oursTable ? 'table_funding' : 'direct',
          theirsNorm: ch,
          status: 'mismatch',
          detail: oursTable
            ? 'Our closing desk funded this on the Table Funding line — sold at the closing table — but Encompass does not say table funding. One of the two is wrong; the loan is either already sold or still to be sold.'
            : 'Encompass says this loan was table funded — sold at the closing table — but our closer funded it on a warehouse line, which means it still has to be sold. One of the two is wrong.',
          writable: false,
          open: true,
          resolution: null,
        });
      }
    }
  } catch (_) { /* advisory only — never let this throw into the panel */ }

  // (a) IS THE ENCOMPASS CHANNEL EVEN ALLOWED FOR THIS NOTE BUYER? The owner's hard rule.
  let p = null;
  try {
    // OUR note buyer decides whose rule applies, falling back to Encompass's copy when our column
    // is blank. Ours first deliberately: `applications.lender` is the value every other note-buyer
    // behaviour in this codebase keys on (the 5% SOW contingency, the bank-statement months, the
    // data-tape gate), so the sync must not apply a DIFFERENT buyer's rule than the rest of PILOT
    // is applying to the same file. Falling back to theirs only helps a file we have not filled in.
    p = FC.channelProblem({ buyer: ourBuyer || theirBuyer || null, channelRaw: theirChannel });
  } catch (_) { return out; }
  if (!p) return out;
  out.push({
    key: 'funding_channel_rule',
    encompassFieldId: 'CX.TABLEFUNDER',
    label: `Funding channel allowed for ${FC.label(p.buyer)}`,
    category: 'program',
    compare: 'rule',
    gate: map.GATE.BLOCK,
    // `ours` is the RULE, not a value we hold — this row has no second copy of anything. Saying so
    // in words is what stops the panel reading as "PILOT and Encompass disagree about a field".
    ours: `Must be ${FC.DIRECT_ONLY_WORDING}`,
    theirs: p.channelRaw || null,
    oursNorm: 'direct',
    theirsNorm: p.channel || null,
    // An unrecognised channel value is NOT reported as a failure — a dropdown option nobody has
    // enumerated yet must never hold a term sheet. It rides as a matching row carrying its own
    // explanation, so a human sees the wording and can have it added.
    status: p.violation ? 'mismatch' : 'match',
    detail: p.message,
    writable: false,
    open: !!p.violation,
    resolution: null,
  });
  return out;
}

/**
 * A/B-PIECE SPLIT ↔ ENCOMPASS (owner-directed 2026-08-18: "No, you can't
 * write. Just follow the Encompass workflow that we currently have already,
 * and it should be added to this section in the Encompass syncing. Encompass
 * and PILOT need to match. PILOT can read Encompass, but it cannot write.").
 *
 * Three COMPUTED rows in the compared section — the compareFundingChannel
 * shape, because the generic registry compare cannot express this field
 * family: a blank checkbox MEANS "not ticked" (never "no data"), and the
 * B-piece on our side is DERIVED (total loan − A), never a stored column.
 * The registry keeps the three ids as REFERENCE rows purely so the
 * fieldReader pulls them; THESE rows are the matching.
 *
 * ONE definition with the A/B-piece card: both call ab-piece.js
 * shapeEncompass, so the card and this panel can never disagree about
 * whether the two systems match. A fact is emitted ONLY when it is
 * genuinely comparable (something recorded on at least one side) — a file
 * with no split anywhere emits NOTHING, so the 99% of files with no A/B
 * structure gain no rows.
 *
 * WHAT A MISMATCH DOES — the truth, corrected 2026-08-18 (the first cut of
 * this comment claimed ADVISORY rows can never hold a term sheet; that is
 * FALSE): summarize()'s match-all gate counts EVERY non-match non-excepted
 * compared row against `clear`, whatever its gate — the gate value only
 * picks the openAdvisory vs openBlocking counter. So a mismatch on one of
 * these rows HOLDS the DocuSign term-sheet send (issuanceGate) and the tape
 * export (tapeGate) until the two systems agree. That is the owner-directed
 * behaviour, twice over: "Encompass and PILOT need to match" (2026-08-18)
 * and the section's standing match-all rule (test-encompass-reconcile-pure
 * pins "an advisory disagreement now blocks the term sheet"). The ways
 * through are the section's own: fix whichever system is wrong by hand
 * (never a PILOT write — Encompass is read-only), an admin override with a
 * recorded reason on the send, or a super-admin field exception (which
 * works on these computed keys). The protection for ordinary files is the
 * SILENCE rule above, not the gate label.
 *
 * PURE decision — takes the already-loaded row/loan/quote; never throws.
 */
function compareAbPiece(row, loan, quote) {
  try {
    const AB = require('../lib/ab-piece');
    const fv = loan && loan._fieldValues;
    if (!fv || typeof fv !== 'object') return [];
    const q = quote || {};
    const ours = AB.shape({
      ab_piece_enabled: row.ab_piece_enabled,
      a_piece_amount: row.a_piece_amount,
      loan_amount: row.loan_amount,
      reg_total: q.sizing ? q.sizing.totalLoan : null,
      registered_program: null,
    });
    const enc = AB._internals.shapeEncompass(fv, ours);
    if (!enc || !enc.relevant) return [];
    const money = (v) => (v == null ? null : `$${Math.round(Number(v)).toLocaleString('en-US')}`);
    const rows = [];
    const push = (key, encompassFieldId, label, category, oursDisp, theirsDisp, agree, detail) => {
      if (agree === null) return; // nothing comparable on this fact — silence, never a guess
      rows.push({
        key, encompassFieldId, label, category,
        compare: 'rule', gate: map.GATE.ADVISORY,
        ours: oursDisp, theirs: theirsDisp,
        oursNorm: oursDisp, theirsNorm: theirsDisp,
        status: agree ? 'match' : 'mismatch',
        detail: agree ? null : detail,
        writable: false, open: !agree, resolution: null,
      });
    };
    push('ab_piece_structure', 'CX.BPIECESTRUCTURE', 'A/B-piece structure (split ticked?)', 'program',
      ours && ours.enabled ? 'Split recorded (A/B structure)' : 'No split recorded',
      enc.structureChecked === true ? `Ticked (${enc.structureRaw})` : enc.structureChecked === false ? 'Not ticked' : String(enc.structureRaw),
      enc.agrees.structure,
      'PILOT and Encompass disagree about whether this loan is sold as an A-piece/B-piece structure. PILOT only reads Encompass — correct whichever system is wrong by hand.');
    push('ab_piece_a_amount', 'CX.APIECE', 'A-piece amount', 'cost',
      money(ours && ours.aPiece), money(enc.aPiece), enc.agrees.aPiece,
      'The A-piece dollar amount differs between PILOT and Encompass (a blank side means that system has no amount recorded). PILOT only reads Encompass — correct whichever system is wrong by hand.');
    push('ab_piece_b_amount', 'CX.BPIECE', 'B-piece amount (PILOT derives: total loan − A)', 'cost',
      money(ours && ours.bPiece), money(enc.bPiece), enc.agrees.bPiece,
      'The B-piece differs. PILOT derives its B-piece as the current registration\'s total loan minus the A-piece, so this can also mean the loan re-registered since Encompass was filled in. PILOT only reads Encompass — correct whichever system is wrong by hand.');
    return rows;
  } catch (_) { return []; } // advisory only — never let this throw into the panel
}

async function computeFindings(appId, dbc, opts) {
  const c = dbc || require('../db');
  const row = (await c.query(
    `SELECT a.id, a.ys_loan_number, a.encompass_loan_guid, a.encompass_extra,
            a.encompass_last_pulled_at, a.encompass_last_error, a.borrower_id, a.llc_id,
            a.loan_amount, a.purchase_price, a.is_assignment, a.underlying_contract_price, a.assignment_fee,
            a.rehab_budget, a.as_is_value, a.arv, a.ltv, a.rate_pct, a.term, a.maturity_date, a.funded_date,
            a.program, a.loan_type, a.rehab_type, a.accrual_type, a.property_type,
            a.units, a.property_address, a.co_borrower_id, a.sqft_pre, a.sqft_post, a.lender,
            a.requested_exp_flips, a.requested_exp_holds, a.requested_exp_ground,
            a.ab_piece_enabled, a.a_piece_amount,
            l.llc_name AS llc_name,
            b.first_name AS b_first_name, b.last_name AS b_last_name,
            b.middle_name AS b_middle_name, b.name_suffix AS b_name_suffix,
            b.date_of_birth AS b_dob, b.email AS b_email, b.cell_phone AS b_cell_phone,
            b.ssn_hash AS b_ssn_hash, b.ssn_last4 AS b_ssn_last4, b.ssn_encrypted AS b_ssn_encrypted,
            cb.first_name AS cb_first_name, cb.last_name AS cb_last_name,
            cb.middle_name AS cb_middle_name, cb.name_suffix AS cb_name_suffix,
            cb.date_of_birth AS cb_dob, cb.email AS cb_email, cb.cell_phone AS cb_cell_phone,
            cb.ssn_hash AS cb_ssn_hash, cb.ssn_last4 AS cb_ssn_last4, cb.ssn_encrypted AS cb_ssn_encrypted,
            -- The closer's warehouse pick, as the derived table-funded flag (closing.tableFundedFor).
            -- LEFT JOINed, so a file that has not reached the closing desk simply has no answer and
            -- the funding_channel row reads "Doesn't apply" rather than "no data to compare".
            cw.table_funded AS table_funded
       FROM applications a
       LEFT JOIN llcs l ON l.id = a.llc_id
       LEFT JOIN borrowers b ON b.id = a.borrower_id
       LEFT JOIN borrowers cb ON cb.id = a.co_borrower_id
       LEFT JOIN closing_workflow cw ON cw.application_id = a.id
      WHERE a.id = $1 AND a.deleted_at IS NULL
      LIMIT 1`, [appId])).rows[0];
  if (!row) return { found: false, hasLoan: false, fields: [], summary: summarize([]) };

  const quote = (await c.query(
    `SELECT quote FROM product_registrations WHERE application_id = $1 AND is_current LIMIT 1`,
    [appId])).rows[0];

  const resRows = (await c.query(
    `SELECT field_key, resolution, ours_snapshot, theirs_snapshot, resolved_by, resolved_at, note,
            requested_by, requested_at
       FROM encompass_sync_resolutions WHERE application_id = $1`, [appId])).rows;
  const resolutions = {};
  for (const r of resRows) resolutions[r.field_key] = r;

  // Self-heal a stale stored copy that predates the read-by-number wiring, so 1859
  // (vesting LLC) and 388 (origination %) show their authoritative values on this very
  // view instead of the wrong JSON-path fallback. Best-effort + read-only to Encompass.
  // GATED to the PANEL read paths (opts.heal) ONLY — never the tape/issuance gates,
  // which loop over up to 1000 files: one live Encompass call per gated file would let a
  // bulk export storm the API during an outage. The panel views one file at a time, and
  // the heal persists, so a file self-heals on its next panel view and stays healed.
  let loan = row.encompass_extra || null;
  if (opts && opts.heal) {
    loan = await _ensureFieldValues(c, appId, loan, row.encompass_loan_guid, row.ys_loan_number);
  }
  const theirs = loan ? map.extractFields(loan) : {};
  const ours = buildOurValues(row, quote ? quote.quote : null, row.llc_name);
  const { fields: econFields } = compareAll(ours, theirs, resolutions);
  // Effective SSN hash for each of our parties — prefer the stored
  // borrowers.ssn_hash; if it is missing (a write path that filled ssn_encrypted
  // but not the hash column) derive it from the encrypted SSN so an on-file SSN
  // never spuriously reads as "no data to compare". PII-safe: the plaintext is
  // decrypted in memory only, never stored/returned/logged — we keep just the
  // one-way keyed HMAC (the SAME hash the Encompass side is stored with).
  row.b_ssn_hash = _effectiveSsnHash(row.b_ssn_hash, row.b_ssn_encrypted);
  row.cb_ssn_hash = _effectiveSsnHash(row.cb_ssn_hash, row.cb_ssn_encrypted);
  // Identity + subject-address rows (owner-directed 2026-07-26) — only when a
  // loan is pulled. They are compare-only + BLOCK-gated and fold into the same
  // summary so "everything matches" includes them.
  const idFields = loan ? compareIdentity(row, loan) : [];
  // The note buyer's own funding-channel rule. Only when a loan is pulled — with no Encompass copy
  // there is no channel to judge, and an absent value is never a violation.
  const ruleFields = loan ? compareFundingChannel(row.lender, theirs.capital_provider, theirs.funding_channel, row.table_funded) : [];
  // The A/B-piece split's three owner-supplied fields (2026-08-18) — computed,
  // Read-only; silent unless a split is recorded somewhere. A mismatch
  // follows the section's match-all gate (holds the term sheet + tape until
  // reconciled or excepted) — see compareAbPiece above.
  const abPieceFields = loan ? compareAbPiece(row, loan, quote ? quote.quote : null) : [];
  const fields = econFields.concat(idFields, ruleFields, abPieceFields);
  // Super-admin FIELD EXCEPTIONS (owner-directed 2026-08-02): a not-matching / "no
  // data to compare" field can be escalated to a super admin, who GRANTS an exception
  // (resolution 'excepted') so it no longer blocks the term sheet — or a staffer has
  // REQUESTED one ('exception_requested') and it is awaiting the super admin. Applied
  // uniformly to BOTH economics and identity fields here (compareAll only sees
  // economics). Both states apply ONLY while the stored snapshot still equals the live
  // normalized values, so an exception AUTO-VOIDS the moment the data changes — it can
  // never hide a NEW disagreement. summarize() reads `f.excepted`; the panel reads both.
  applyFieldExceptions(fields, resolutions);
  const summary = summarize(fields);

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


// ── SUPER-ADMIN raw diagnostic (owner-directed 2026-07-26) ──────────────────
// "Show me the RAW and exactly what's going on / why it's not matching."
// Returns, for one file: every RAW key/value Encompass actually gave us (flattened
// to the field ids the registry uses), which registry field each one feeds, our
// side, their side, BOTH normalized values, and a plain-language reason the row is
// not a match. This is what makes a wrong/missing field id diagnosable in seconds
// instead of guessing at JSON paths.
//
// READ-ONLY and PII-SAFE: it reads the already-scrubbed encompass_extra (the raw
// SSN was never stored — only a one-way hash), and it REDACTS anything that looks
// like an SSN hash/number before returning. Super-admin only at the route.
function _redactRaw(key, val) {
  if (/ssn|taxidentification/i.test(String(key))) return '[redacted]';
  const s = typeof val === 'string' ? val : JSON.stringify(val);
  if (typeof s === 'string' && /^[0-9a-f]{64}$/i.test(s)) return '[hash redacted]';
  return val;
}

async function rawDiagnostic(appId, dbc, opts) {
  const c = await computeFindings(appId, dbc, opts);
  if (!c.found) return { found: false };

  // What Encompass actually handed us, keyed exactly as the registry looks it up.
  // Read the stored (already PII-scrubbed) loan copy straight from the file.
  const conn = dbc || require('../db');
  const lr = await conn.query('SELECT encompass_extra FROM applications WHERE id = $1', [appId]);
  const loan = (lr.rows[0] && lr.rows[0].encompass_extra) || null;
  let flat = {};
  try {
    if (loan) {
      const env = map.flattenLoan(loan);
      flat = (env && env.fields) || {};
    }
  } catch (_) { flat = {}; }

  const byFieldId = {};
  for (const f of c.fields) if (f.encompassFieldId) byFieldId[f.encompassFieldId] = f;

  const rawRows = Object.keys(flat).sort().map((id) => {
    const cell = flat[id];
    const value = cell && typeof cell === 'object' && 'value' in cell ? cell.value : cell;
    const f = byFieldId[id] || null;
    return {
      encompassFieldId: id,
      rawValue: _redactRaw(id, value),
      mapsToField: f ? f.key : null,
      mapsToLabel: f ? f.label : null,
      status: f ? f.status : null,
    };
  });

  // Registry fields Encompass returned NOTHING for — the "no data to compare"
  // rows, which is exactly where a wrong field id or JSON path shows up.
  const missing = c.fields
    .filter((f) => f.status === 'incomparable' && (f.theirsNorm === null || f.theirsNorm === undefined || f.theirsNorm === ''))
    .map((f) => ({ key: f.key, label: f.label, encompassFieldId: f.encompassFieldId, ours: f.ours, theirs: f.theirs }));

  const rows = c.fields.map((f) => ({
    key: f.key, label: f.label, encompassFieldId: f.encompassFieldId,
    compare: f.compare, gate: f.gate, status: f.status,
    ours: f.ours, theirs: f.theirs, oursNorm: f.oursNorm, theirsNorm: f.theirsNorm,
    why: _whyNotMatching(f),
  }));

  return {
    found: true, hasLoan: c.hasLoan, guid: c.guid, loanNumber: c.loanNumber,
    pulledAt: c.pulledAt, lastError: c.lastError, summary: c.summary,
    rawFieldCount: rawRows.length, raw: rawRows, missingFromEncompass: missing, rows,
  };
}

// One plain sentence per row explaining the verdict — the whole point of the view.
function _whyNotMatching(f) {
  if (f.status === 'match') return 'Both sides agree.';
  if (f.status === 'reference') return 'Shown for reference only — never compared.';
  if (f.status === 'incomparable') {
    const oursBlank = f.oursNorm === null || f.oursNorm === undefined || f.oursNorm === '';
    const theirsBlank = f.theirsNorm === null || f.theirsNorm === undefined || f.theirsNorm === '';
    if (f.naWhenOursMissing && oursBlank) return "Doesn't apply to this kind of loan — nothing to compare.";
    if (oursBlank && theirsBlank) return 'Neither system has a value for this yet.';
    if (theirsBlank) return `Encompass returned nothing for field ${f.encompassFieldId || '(n/a)'} — either it is blank in Encompass or we are reading the wrong field id / location.`;
    return 'Our file has no value for this yet — enter it on the file.';
  }
  if (f.compare === 'enum') return `The two values do not map to the same meaning (ours "${f.oursNorm}" vs Encompass "${f.theirsNorm}").`;
  return `The values differ after normalizing (ours "${f.oursNorm}" vs Encompass "${f.theirsNorm}").`;
}

// non-Encompass deployment).
//   reason: 'not_configured' | 'not_in_encompass' | 'unreconciled' | null | 'error'
// The DECISION core is pure (no DB/network) so every branch is unit-testable —
// `tapeGate` just supplies whether Encompass is configured and the isClear() result.
function tapeGateDecision(isConfigured, clearResult) {
  if (!isConfigured) return { block: false, reason: 'not_configured', hasLoan: false, openBlocking: 0, openBlockingKeys: [] };
  const g = clearResult || {};
  if (!g.hasLoan) return { block: true, reason: 'not_in_encompass', hasLoan: false, openBlocking: 0, openBlockingKeys: [] };
  const keys = g.openBlockingKeys || [];
  const block = !g.clear;
  return { block, reason: block ? 'unreconciled' : null, hasLoan: true, openBlocking: keys.length, openBlockingKeys: keys };
}
// The couldn't-compute outcome, pure + testable: OFF → dormant (never lock a
// non-Encompass deployment out); ON → fail CLOSED (block, admin-overridable).
function tapeGateError(isConfigured) {
  if (!isConfigured) return { block: false, reason: 'not_configured', hasLoan: false, openBlocking: 0, openBlockingKeys: [] };
  return { block: true, reason: 'error', hasLoan: false, openBlocking: 0, openBlockingKeys: [] };
}
async function tapeGate(appId, dbc) {
  let isConfigured = false;
  try {
    isConfigured = require('../lib/integrations/encompass').configured();
  } catch (_) {
    // Can't even tell if Encompass is on → treat as OFF (dormant); an integration-
    // module error must never lock every export in a non-Encompass deployment.
    return tapeGateError(false);
  }
  if (!isConfigured) return tapeGateDecision(false, null);
  try {
    return tapeGateDecision(true, await isClear(appId, dbc));
  } catch (_) {
    // Configured but we couldn't VERIFY the reconciliation → fail CLOSED.
    return tapeGateError(true);
  }
}

// Plain-language message for a tape blocked by the Encompass gate — non-technical
// staff read this on the export screen (owner-directed: plain language). Keyed off
// the gate's `reason`. Null when the gate isn't blocking (nothing to say).
function tapeGateMessage(gate) {
  if (!gate || !gate.block) return null;
  if (gate.reason === 'not_in_encompass') {
    return 'This loan isn’t in Encompass yet. Finish syncing it to Encompass and reconcile the file (every field matching) before exporting its tape.';
  }
  if (gate.reason === 'error') {
    return 'We couldn’t confirm this loan matches Encompass right now. Try again in a moment.';
  }
  const n = gate.openBlocking || 0;
  const fields = n === 1 ? '1 field' : `${n} fields`;
  return `This loan doesn’t fully match Encompass yet (${fields} still ${n === 1 ? 'differs' : 'differ'}). Open the Encompass section and reconcile every field before exporting its tape.`;
}

// Convenience for the term-sheet gate (WO-E): is the Encompass findings tab clear?
async function isClear(appId, dbc) {
  const c = await computeFindings(appId, dbc);
  // A file with no Encompass loan pulled is NOT "blocked" by Encompass — the gate
  // only blocks on an OPEN blocking mismatch against a loan we actually have.
  // At the GATE BOUNDARY `openBlocking` is the count of EVERY not-passing field
  // (mismatch, advisory, OR "no data to compare"), i.e. exactly the length of
  // `openBlockingKeys`. It deliberately does NOT use `summary.openBlocking`, which
  // counts only the open block-gate MISMATCHES and would print "0 fields don't
  // match" in precisely the advisory / no-data / accepted-but-differing cases the
  // owner-directed match-all gate blocks on (2026-07-26).
  const keys = c.summary.openBlockingKeys || [];
  return { clear: c.summary.clear, hasLoan: c.hasLoan, openBlocking: keys.length, openBlockingKeys: keys };
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
    const keys = g.openBlockingKeys || [];
    // `openBlocking` == keys.length so every display/log site prints the true
    // number of fields that don't agree (never an under-count).
    return { block: !!(g.hasLoan && !g.clear), hasLoan: g.hasLoan, openBlocking: keys.length, openBlockingKeys: keys };
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

// ── Super-admin FIELD EXCEPTIONS (owner-directed 2026-08-02) ────────────────
// A not-matching / "no data to compare" Encompass field can be escalated: any assigned
// staffer REQUESTS an exception, a SUPER ADMIN grants it, and the field then passes the
// gate ("it doesn't need to match"). All state lives in encompass_sync_resolutions
// (resolution 'exception_requested' → 'excepted'), snapshotting the LIVE normalized
// values so the exception auto-voids the moment the data changes. NEVER writes to
// Encompass. The notification + policy-exception-register record happen at the route.

// Run a write in the caller's transaction, or a fresh one that commits on {ok:true}.
async function _withTxn(dbc, fn) {
  if (dbc) return fn(dbc);
  const db = require('../db');
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    const r = await fn(client);
    await client.query(r && r.ok ? 'COMMIT' : 'ROLLBACK');
    return r;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

// Any assigned staffer asks for an exception on a currently-not-passing field.
async function requestException(appId, fieldKey, staffId, reason, dbc) {
  return _withTxn(dbc, (c) => _doRequestException(c, appId, fieldKey, staffId, reason));
}
async function _doRequestException(c, appId, fieldKey, staffId, reason) {
  const cur = await computeFindings(appId, c);
  if (!cur.found) return { ok: false, reason: 'not_found' };
  if (!cur.hasLoan) return { ok: false, reason: 'no_loan' };
  const f = (cur.fields || []).find((x) => x.key === fieldKey);
  if (!f) return { ok: false, reason: 'unknown_field' };
  if (f.status === 'match' || f.status === 'reference') return { ok: false, reason: 'already_passing' };
  if (f.excepted) return { ok: false, reason: 'already_excepted' };
  await c.query(
    `INSERT INTO encompass_sync_resolutions
        (application_id, field_key, resolution, ours_snapshot, theirs_snapshot, requested_by, requested_at, note)
       VALUES ($1,$2,'exception_requested',$3,$4,$5,now(),$6)
     ON CONFLICT (application_id, field_key) DO UPDATE
       SET resolution='exception_requested', ours_snapshot=EXCLUDED.ours_snapshot, theirs_snapshot=EXCLUDED.theirs_snapshot,
           requested_by=EXCLUDED.requested_by, requested_at=now(), note=EXCLUDED.note,
           resolved_by=NULL, resolved_at=NULL`,
    [appId, fieldKey, snap(f.oursNorm), snap(f.theirsNorm), staffId || null, reason || null]);
  const after = await computeFindings(appId, c);
  const nf = (after.fields || []).find((x) => x.key === fieldKey) || f;
  return { ok: true, field: nf, label: f.label, ours: f.ours, theirs: f.theirs, status: f.status };
}

// A super admin GRANTS ('grant'), DENIES ('deny') or REVOKES ('revoke') an exception.
// grant → the field passes the gate; deny/revoke → the row is removed and it re-blocks.
async function decideException(appId, fieldKey, staffId, decision, reason, dbc) {
  return _withTxn(dbc, (c) => _doDecideException(c, appId, fieldKey, staffId, decision, reason));
}
async function _doDecideException(c, appId, fieldKey, staffId, decision, reason) {
  const cur = await computeFindings(appId, c);
  if (!cur.found) return { ok: false, reason: 'not_found' };
  const f = (cur.fields || []).find((x) => x.key === fieldKey);
  if (!f) return { ok: false, reason: 'unknown_field' };
  if (decision === 'deny' || decision === 'revoke') {
    // Remove ONLY an exception row (never a 'replaced'/'accepted' provenance row) so the
    // field re-blocks. Idempotent — a no-op if there was no exception.
    await c.query(
      `DELETE FROM encompass_sync_resolutions
        WHERE application_id=$1 AND field_key=$2 AND resolution IN ('exception_requested','excepted')`,
      [appId, fieldKey]);
    const after = await computeFindings(appId, c);
    const nf = (after.fields || []).find((x) => x.key === fieldKey) || f;
    return { ok: true, decision, field: nf, label: f.label };
  }
  // grant — mirror requestException's guards so a direct re-grant (or a double-click
  // before the button disables) can't INSERT a second born-approved register row for
  // the one logical exception, and a grant on a file with no pulled loan is refused
  // (there is nothing to reconcile against). deny/revoke stay unguarded on hasLoan so
  // a stale exception can still be cleaned up after a loan is un-pulled.
  if (!cur.hasLoan) return { ok: false, reason: 'no_loan' };
  if (f.status === 'match' || f.status === 'reference') return { ok: false, reason: 'already_passing' };
  if (f.excepted) return { ok: false, reason: 'already_excepted' };
  await c.query(
    `INSERT INTO encompass_sync_resolutions
        (application_id, field_key, resolution, ours_snapshot, theirs_snapshot, resolved_by, resolved_at, note)
       VALUES ($1,$2,'excepted',$3,$4,$5,now(),$6)
     ON CONFLICT (application_id, field_key) DO UPDATE
       SET resolution='excepted', ours_snapshot=EXCLUDED.ours_snapshot, theirs_snapshot=EXCLUDED.theirs_snapshot,
           resolved_by=EXCLUDED.resolved_by, resolved_at=now(),
           note=COALESCE(EXCLUDED.note, encompass_sync_resolutions.note)`,
    [appId, fieldKey, snap(f.oursNorm), snap(f.theirsNorm), staffId || null, reason || null]);
  const after = await computeFindings(appId, c);
  const nf = (after.fields || []).find((x) => x.key === fieldKey) || f;
  return { ok: true, decision: 'grant', field: nf, label: f.label, ours: f.ours, theirs: f.theirs, note: reason || null };
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
  rawDiagnostic,
  isClear,
  tapeGate,
  tapeGateMessage,
  issuanceGate,
  replaceField,
  requestException,
  decideException,
  refresh,
  onLoanNumberSet,
  WRITABLE,
  // compareIdentity is exported for the name-split regression test: a borrower
  // whose Encompass copy is correctly split must MATCH our three columns, and a
  // legacy merged first name must match too rather than hold the term sheet.
  _internals: { snap, deriveDealType, tapeGateDecision, tapeGateError, compareIdentity, compareFundingChannel, _collectParties, _matchParty, _matchBySsn, _matchByName, _phones, _emails, _pairLabel, _partyFromFieldValues, applyFieldExceptions },
};
