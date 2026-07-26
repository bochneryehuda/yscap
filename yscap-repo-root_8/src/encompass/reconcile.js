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
// the stronger statement about the work. Any of the repo's sqft-addition column
// spellings counts; a file with none falls back to its own rehab_type.
function rehabTypeFor(app) {
  const a = app || {};
  const sqft = a.sqft_addition === true || a.adding_sqft === true || a.is_sqft_addition === true
    || a.square_footage_addition === true || a.sqft_expansion === true;
  if (sqft) return 'expansion';
  const v = a.rehab_type;
  return (v === null || v === undefined || v === '') ? undefined : v;
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
    contract_price: nz(a.underlying_contract_price) !== undefined ? a.underlying_contract_price : nz(a.purchase_price),
    assignment_fee: nz(a.assignment_fee),
    financed_interest_reserve: nz(sizing.financedReserve),
    total_cost: nz(sizing.costBasis),

    // valuation
    as_is_value: nz(a.as_is_value),
    arv: nz(a.arv),
    actual_arv_ltv: pctOf(sizing.arvPct),

    // sizing / leverage (percent — see pctOf: engine fractions → Encompass percents)
    actual_ltc: pctOf(sizing.ltcPct),
    actual_initial_ltv: nz(a.ltv) !== undefined ? pctOf(a.ltv) : pctOf(sizing.acqLtvPct),
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
  let openBlocking = 0, openAdvisory = 0, resolved = 0;
  const notPassingKeys = [];
  for (const f of fields) {
    if (f.compare === 'reference' || f.status === 'reference') continue;
    compared += 1;
    if (f.status === 'match') { matched += 1; continue; }
    notPassingKeys.push(f.key);                    // anything that is not an exact match
    if (f.status === 'incomparable') incomparable += 1;
    else if (f.status === 'mismatch') {
      mismatched += 1;
      if (!f.open) resolved += 1;                  // accepted resolution (values still differ) — still not a match
      else if (f.gate === map.GATE.ADVISORY) openAdvisory += 1;
      else openBlocking += 1;
    }
  }
  return {
    compared, matched, mismatched, incomparable, resolved,
    openBlocking, openAdvisory,
    notPassing: notPassingKeys.length,
    notPassingKeys,
    // Back-compat alias: the term-sheet gate + the register override now name
    // EVERY not-passing field (mismatch, advisory, or no-data), not just the
    // block-gate mismatches.
    openBlockingKeys: notPassingKeys,
    clear: matched === compared, // the term-sheet gate (WO-E) reads this — pass = everything matches
  };
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
function _addrStr(a) {
  if (a == null) return '';
  if (typeof a === 'string') return a.trim();
  if (typeof a !== 'object') return String(a);
  // Prefer a structured build; fall back to a one-line/formatted string when the
  // object only carries that (an Encompass/ClickUp formatted address), so a
  // one-line-only side is compared instead of reading as "no data".
  const street = a.street || a.line1 || a.address1 || a.streetAddress || a.addressStreetLine1 || a.address || '';
  const zip = _zip5(a.zip || a.postalCode || a.zipCode || a.postal_code);
  const parts = [street, a.city, a.state, zip];
  const built = parts.map((x) => (x == null ? '' : String(x).trim())).filter((x) => x !== '').join(' ');
  if (built) return built;
  const oneLine = a.oneLine || a.formatted_address || a.formattedAddress || a.fullAddress || a.display || '';
  return String(oneLine || '').trim();
}
function _named(p) { return !!(p && ((p.firstName && String(p.firstName).trim()) || (p.lastName && String(p.lastName).trim()))); }
function compareIdentity(row, loan) {
  const N = map._internals;
  const apps = (loan && Array.isArray(loan.applications)) ? loan.applications : [];
  const app0 = apps[0] || null;
  const bor = (app0 && app0.borrower) ? app0.borrower : {};
  // Encompass models a second person TWO ways (owner-directed 2026-07-26): as the
  // CO-BORROWER in the same borrower pair (applications[0].coBorrower), OR as a
  // SECOND borrower pair (applications[1].borrower). Read whichever actually
  // carries the co-borrower — same-pair coBorrower first, else the 2nd pair's
  // borrower — so our single co_borrower_id matches either representation.
  const coInPair = (app0 && app0.coBorrower) ? app0.coBorrower : {};
  const coInSecondPair = (apps[1] && apps[1].borrower) ? apps[1].borrower : {};
  const coBor = _named(coInPair) ? coInPair : (_named(coInSecondPair) ? coInSecondPair : coInPair);
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
  const ourName = [row.b_first_name, row.b_last_name].filter((x) => x && String(x).trim()).join(' ').trim();
  const theirName = [bor.firstName, bor.lastName].filter((x) => x && String(x).trim()).join(' ').trim();
  push('id_borrower_name', 'Borrower name', 'name', ourName || null, theirName || null);
  push('id_dob', 'Date of birth', 'date', row.b_dob || null, bor.birthDate || null);
  push('id_email', 'Email', 'email', row.b_email || null, bor.emailAddressText || null);
  push('id_phone', 'Phone', 'phone', row.b_cell_phone || null, (bor.mobilePhone || bor.homePhoneNumber) || null);
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
  const ourCoName = [row.cb_first_name, row.cb_last_name].filter((x) => x && String(x).trim()).join(' ').trim();
  const theirCoName = [coBor.firstName, coBor.lastName].filter((x) => x && String(x).trim()).join(' ').trim();
  const hasCo = !!(row.co_borrower_id || ourCoName || theirCoName || coBor.birthDate || coBor.emailAddressText || coBor.mobilePhone || coBor.homePhoneNumber || coBor._ssnHash || row.cb_ssn_hash);
  if (hasCo) {
    push('id_coborrower_name', 'Co-borrower name', 'name', ourCoName || null, theirCoName || null);
    push('id_coborrower_dob', 'Co-borrower date of birth', 'date', row.cb_dob || null, coBor.birthDate || null);
    push('id_coborrower_email', 'Co-borrower email', 'email', row.cb_email || null, coBor.emailAddressText || null);
    push('id_coborrower_phone', 'Co-borrower phone', 'phone', row.cb_cell_phone || null, (coBor.mobilePhone || coBor.homePhoneNumber) || null);
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
            a.units, a.property_address, a.co_borrower_id,
            a.requested_exp_flips, a.requested_exp_holds, a.requested_exp_ground,
            l.llc_name AS llc_name,
            b.first_name AS b_first_name, b.last_name AS b_last_name,
            b.date_of_birth AS b_dob, b.email AS b_email, b.cell_phone AS b_cell_phone,
            b.ssn_hash AS b_ssn_hash, b.ssn_last4 AS b_ssn_last4, b.ssn_encrypted AS b_ssn_encrypted,
            cb.first_name AS cb_first_name, cb.last_name AS cb_last_name,
            cb.date_of_birth AS cb_dob, cb.email AS cb_email, cb.cell_phone AS cb_cell_phone,
            cb.ssn_hash AS cb_ssn_hash, cb.ssn_last4 AS cb_ssn_last4, cb.ssn_encrypted AS cb_ssn_encrypted
       FROM applications a
       LEFT JOIN llcs l ON l.id = a.llc_id
       LEFT JOIN borrowers b ON b.id = a.borrower_id
       LEFT JOIN borrowers cb ON cb.id = a.co_borrower_id
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
  const fields = econFields.concat(idFields);
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
