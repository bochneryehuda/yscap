'use strict';

/**
 * loan-primer — the CANONICAL grounding for every AI/GPT call about a loan file.
 *
 * WHY THIS EXISTS
 * Every AI surface in PILOT (the underwriting explainer, the investor-guideline
 * satisfaction check, condition-clearing verification, document understanding)
 * must reason about the SAME loan with the SAME meaning for every field. Left to
 * itself an LLM confuses purchase_price vs as_is_value vs ARV, or loan_amount vs
 * cost basis vs purchase_price, or the real vs the effective (recognized) price on
 * an assignment. This module is the single place that teaches the model our loan
 * structure and hands it the exact per-file picture, so it never guesses a number
 * and never crosses two different dollars.
 *
 * TWO PIECES
 *  - PRIMER_TEXT — a STATIC grounding block (the field meanings + the confusables +
 *    the never-expose-a-note-buyer rule). Inject this verbatim into every prompt.
 *  - assembleLoanPrimer(appId, db) — the per-file READ. It unions the three canonical
 *    read-only loaders (the flat field values, the provenance-resolved structure with
 *    discrepancies, and the document-verified twin facts). NO AI, NO writes, and it
 *    NEVER throws — a loader that fails degrades to null, never breaks the caller.
 *
 * groundingBlock(appId, db, opts) returns PRIMER_TEXT + a compact per-file summary,
 * ready to drop into a system prompt. Pass { borrowerFacing:true } to scrub the note
 * buyer / capital-partner name off any borrower-facing surface (per the hard rule).
 *
 * This is grounding, not authority: the frozen pricing engines remain the sole
 * source of every number. The primer only makes the numbers legible to the model.
 */

// The static grounding block — mirrors the money-field distinctions and confusables
// that the field registry (src/lib/conditions/field-registry.js) and the frozen
// engines enforce. Keep in sync with the field registry when a field's meaning
// changes; this is the human-readable contract handed to the model.
const PRIMER_TEXT = `YS CAPITAL / PILOT — LOAN FILE GROUNDING (authoritative; read before reasoning about any value)

WHAT A LOAN FILE IS
- We originate business-purpose RESIDENTIAL TRANSITION LOANS (RTL): fix & flip, fix & hold
  (BRRRR), bridge, ground-up construction, and rental/DSCR. Never owner-occupied consumer loans.
- ONE loan file = ONE property = one applications row (a borrower can have many). The
  application id (a uuid) is the file's identity. Everything else hangs off it.
- Money is US dollars. A blank/absent number is MISSING (null) — never treat it as 0. "0" and
  "missing" are different and a decision must not assume a value that is not present.

THE MONEY FIELDS — MEMORIZE THESE DISTINCTIONS (this is where misreads happen)
- purchase_price = the CONTRACT price the borrower pays the seller on a PURCHASE. On a
  refinance this is usually blank; use original_purchase_price instead.
- original_purchase_price = what the borrower ORIGINALLY paid for a property they already own
  (refinance context only). Not the current value, not the loan.
- underlying_contract_price = on an ASSIGNMENT/wholesale deal, the SELLER'S original contract
  price (what the seller signed), BEFORE the assignment fee. This is the basis the financeable
  assignment fee is capped against (15% of THIS number).
- assignment_fee = the wholesaler's fee paid ON TOP OF underlying_contract_price. Real total
  price the borrower pays = underlying_contract_price + assignment_fee.
- effective_purchase_price (a.k.a. recognized price) = the price the loan is SIZED on when a
  fee is over cap = seller contract + the FINANCEABLE portion of the fee (fee capped at 15% of
  the seller contract price; Gold also caps the financeable fee at $75,000). Any fee above that
  cap is excess cash the borrower brings at closing. ALWAYS: show the REAL total under "Purchase
  price"; the capped basis only under "Effective purchase price".
- as_is_value = the property's CURRENT market value today, before any renovation (from the
  appraisal / borrower estimate). This is NOT the price and NOT the ARV.
- arv = AFTER-REPAIR VALUE = the appraiser's projected value once the renovation is complete.
  Always >= as_is_value on a rehab deal. Leverage-to-ARV (LTARV) uses THIS.
- rehab_budget = total renovation/construction budget. It is FROZEN once set on the file /
  registered product; the Scope-of-Work tool never changes it.
- payoff_amount = the balance to pay off the borrower's EXISTING loan (refinances only).
- loan_amount = the TOTAL financed loan we are giving (initial advance + rehab holdback +
  financed interest reserve). This is NOT the cost basis and NOT the purchase price.

THE COST-BASIS / SIZING RELATIONSHIPS (how a loan is built)
- Total Cost Basis  = (purchase_price OR as_is_value, whichever the program uses) + rehab_budget
  [+ financed interest reserve, for programs where the reserve sits IN the cost basis].
  On an assignment the price term is the EFFECTIVE (recognized) price, not the real total.
- loan_amount = initial advance (a.k.a. acquisition advance) + rehab holdback + financed
  interest reserve. These three ALWAYS sum to loan_amount to the dollar.
    * initial advance  = the day-one wire toward acquisition (capped by as-is / purchase LTV).
    * rehab holdback   = the renovation money, released in draws as work completes.
    * financed interest reserve = pre-funded interest, financed into the loan (may be 0).
- LEVERAGE, all as loan-to-X percentages (0-100):
    * ltv  = loan-to-value as registered on the file.
    * loan_to_cost (LTC)  = loan_amount / (purchase_price + rehab_budget).
    * loan_to_arv (LTARV) = loan_amount / arv.
  Each program caps the initial advance vs as-is/purchase, the LTC, and the ARV LTV. The loan is
  sized to the TIGHTEST binding cap. NEVER recompute or override an engine number.
- Interest reserve can be requested as MONTHS (requested_ir_months, 0-24) OR an exact dollar
  amount (requested_ir_amount); the dollar amount, if > 0, wins. It is always capped at the
  full-term interest.

PROGRAM / STRUCTURE
- registered_program: 'standard' (Standard Program), 'gold' (Gold Standard Program),
  'manual' (a manual override of the structure), or 'none' (not registered yet). This is the
  product REGISTERED in the Term Sheet Studio — the authoritative structure.
- The frozen pricing engines (Standard = window.YSP, Gold = window.GSP) are the SOLE authority
  for every number (rates, caps, sizing, fees, reserves). AI NEVER recomputes, re-prices,
  invents, or overrides an engine number. A missing engine number stays missing.
- program_strategy: fix_flip | fix_hold | bridge | ground_up | rental_dscr | other.
- loan_purpose: purchase | refinance_rate_term | refinance_cash_out | other.
- Gold Standard finances NO interest reserve on renovation (reserve resolves to 0); Gold
  ground-up keeps a 75%-of-term reserve; Standard is full-term. Never assume a reserve exists.

BORROWER / ENTITY / EXPERIENCE
- fico = borrower mid credit score (300-850), on the BORROWER profile, not the file.
- tier = count of VERIFIED track-record deals on the borrower (drives leverage bracket).
- verified_flips / verified_holds / verified_ground = counts PROVEN by the track record.
- requested_exp_flips / _holds / _ground = the borrower's CLAIMED (attested) experience. The
  loan SIZES on the claimed numbers (fallback to verified); funding is gated by an experience
  condition that must VERIFY the claim. Claimed >= verified is normal, not a discrepancy.
- has_llc / llc_verified / llc_state = the vesting entity (LLC) linked to the file and whether
  it is verified; loans typically vest in the borrower's LLC.
- has_co_borrower = a second borrower is on the file; both are guarantors by default.

LOCATION & IDENTIFIERS
- property_state / property_city / property_zip = the SUBJECT property location.
- borrower_state = where the borrower LIVES (may differ from the property state).
- ys_loan_number = our loan number, starts with "YSCAP". Blank = not yet assigned.
- status: file_intake < new(Submitted) < in_review < processing < underwriting < approved <
  clear_to_close < funded; terminal declined / withdrawn.

NOTE BUYER — STAFF ONLY, NEVER SHOWN TO A BORROWER
- note_buyer (stored as applications.lender) = the capital partner the loan is sold to
  (bluelake = Blue Lake, corrfirst = CorrFirst, fidelis = Fidelis, ...). This name is STAFF-ONLY.
  NEVER expose a note buyer / capital partner name in any borrower-facing text, email, or PDF —
  borrower-facing copy calls it "the Gold Standard program". It drives internal rules only.

THE CONFUSABLES — never substitute one for another
- purchase_price vs as_is_value vs arv — three different dollars (paid / current value / future
  post-rehab value). ARV is highest on a rehab deal.
- loan_amount vs cost basis vs purchase_price — loan_amount is what WE lend (a subset of cost).
  Cost basis = price + rehab (+reserve). loan/cost = LTC; loan/price is NOT a headline metric.
- real purchase price vs effective (recognized) purchase price — on an assignment, "Purchase
  price" shows seller + FULL fee; the loan SIZES on the effective price (seller + financeable
  fee). Do not size on the real total; do not label the effective price as the purchase price.
- requested_exp_* (claimed) vs verified_* / tier (proven) — claimed >= verified is EXPECTED, not
  a data conflict; the loan sizes on claimed and a condition verifies it.
- program (free strategy text) vs registered_program ('standard'/'gold'/'manual') — comparing
  them as if equal creates a FALSE program discrepancy. Use registered_program.
- borrower_state vs property_state; original_purchase_price (refi) vs purchase_price (purchase).

SOURCES & CONFLICTS
- Every value can come from multiple sources (the application row, the frozen engine's stored
  inputs, the registered product snapshot, the appraisal, or an extracted document). When two
  present sources disagree, that is a DISCREPANCY to surface for a human — never silently pick
  one, never average. Cite your source and, for a document-derived fact, its status (observed,
  corroborated, verified, disputed, human_confirmed). A human_confirmed value outranks everything.
- Treat missing required facts (program, loan_amount) as NOT_READY, never fabricated.`;

// Lazy requires so this module never drags the whole underwriting graph (or a DB
// connection) into a caller that only wants PRIMER_TEXT.
function safeRequire(path) {
  try { return require(path); } catch (_e) { return null; }
}

/**
 * assembleLoanPrimer(appId, db) → { applicationId, fields, structure, facts, ready, missing }
 *
 * Best-effort union of the three canonical read-only loaders. Every loader is
 * independently guarded: a failure degrades that slice to null/[], never throws.
 * Pass the same `db` the caller already holds; twin.factsForFile falls back to the
 * module db() when db is absent.
 */
async function assembleLoanPrimer(appId, db) {
  if (!appId) return { applicationId: null, fields: null, structure: null, facts: [], ready: false, missing: ['application_id'] };

  const engine = safeRequire('../conditions/engine');
  const wlc = safeRequire('./whole-loan-context');
  const twin = safeRequire('./twin');

  const [ctxRes, structure, facts] = await Promise.all([
    (async () => {
      try { return engine && engine.loadRuleContext ? await engine.loadRuleContext(appId) : null; }
      catch (_e) { return null; }
    })(),
    (async () => {
      try { return wlc && wlc.buildWholeLoanContext ? await wlc.buildWholeLoanContext(appId, db) : null; }
      catch (_e) { return null; }
    })(),
    (async () => {
      try { return twin && twin.factsForFile ? await twin.factsForFile(appId, db) : []; }
      catch (_e) { return []; }
    })(),
  ]);

  const fields = ctxRes && ctxRes.ctx ? ctxRes.ctx : null;
  const missing = (structure && Array.isArray(structure.missingRequired)) ? structure.missingRequired : [];
  // "ready" mirrors the whole-loan context's own readiness (all required facts present).
  // With no structure loaded we cannot claim ready.
  const ready = !!(structure && structure.ready);

  return {
    applicationId: appId,
    fields,
    structure,
    facts: Array.isArray(facts) ? facts : [],
    ready,
    missing,
  };
}

// Format a dollar value for the compact per-file summary. null/undefined stay
// "(missing)" — NEVER rendered as 0 (the primer's own rule).
function money(v) {
  if (v == null || v === '') return '(missing)';
  const n = Number(v);
  if (!Number.isFinite(n)) return '(missing)';
  return '$' + Math.round(n).toLocaleString('en-US');
}

function pct(v) {
  if (v == null || v === '') return '(missing)';
  const n = Number(v);
  if (!Number.isFinite(n)) return '(missing)';
  return (Math.round(n * 10) / 10) + '%';
}

function txt(v) {
  if (v == null || v === '') return '(missing)';
  return String(v);
}

/**
 * fileSummaryText(primer, opts) → a compact, human/AI-legible per-file block.
 * Pure — takes the assembled primer object, renders the load-bearing values with
 * the primer's own missing-vs-zero discipline. borrowerFacing scrubs the note buyer.
 */
function fileSummaryText(primer, opts) {
  const o = opts || {};
  const f = (primer && primer.fields) || {};
  const s = (primer && primer.structure) || null;

  const lines = [];
  lines.push(`THIS FILE — application ${txt(primer && primer.applicationId)}`);
  lines.push(`- Program (registered): ${txt(f.registered_program)}   Strategy: ${txt(f.program_strategy)}   Purpose: ${txt(f.loan_purpose)}   Status: ${txt(f.status)}`);
  lines.push(`- Loan amount (total financed): ${money(f.loan_amount)}   LTV: ${pct(f.ltv)}   LTC: ${pct(f.loan_to_cost)}   LTARV: ${pct(f.loan_to_arv)}`);
  lines.push(`- Purchase price: ${money(f.purchase_price)}   As-is value: ${money(f.as_is_value)}   ARV: ${money(f.arv)}   Rehab budget: ${money(f.rehab_budget)}`);
  if (f.is_assignment) {
    lines.push(`- ASSIGNMENT: seller contract ${money(f.underlying_contract_price)} + fee ${money(f.assignment_fee)} (fee financeable up to 15% of the seller contract price; excess is cash to close)`);
  }
  if (f.loan_purpose && String(f.loan_purpose).startsWith('refinance')) {
    lines.push(`- Refi: original purchase price ${money(f.original_purchase_price)}   payoff ${money(f.payoff_amount)}`);
  }
  lines.push(`- Rehab type: ${txt(f.rehab_type)}   Property: ${txt(f.property_type)}   Units: ${txt(f.units)}   Location: ${txt(f.property_city)}, ${txt(f.property_state)} ${txt(f.property_zip)}`);
  lines.push(`- Borrower FICO: ${txt(f.fico)}   Tier: ${txt(f.tier)}   Claimed exp (flip/hold/ground): ${txt(f.requested_exp_flips)}/${txt(f.requested_exp_holds)}/${txt(f.requested_exp_ground)}   Verified: ${txt(f.verified_flips)}/${txt(f.verified_holds)}/${txt(f.verified_ground)}`);
  lines.push(`- Entity: has_llc ${f.has_llc ? 'yes' : 'no'}${f.has_llc ? ` (verified ${f.llc_verified ? 'yes' : 'no'}, ${txt(f.llc_state)})` : ''}   Co-borrower: ${f.has_co_borrower ? 'yes' : 'no'}`);
  lines.push(`- Interest reserve requested: ${f.requested_ir_amount ? money(f.requested_ir_amount) : txt(f.requested_ir_months) + ' months'}   In flood zone: ${f.in_flood_zone ? 'yes' : 'no'}`);

  if (!o.borrowerFacing) {
    lines.push(`- Note buyer (STAFF-ONLY): ${txt(f.note_buyer)}   YS loan #: ${txt(f.ys_loan_number)}`);
  }

  // Data-quality: what disagrees and what is still missing — the model must know
  // these before it reasons, so it never treats a discrepancy as a settled fact.
  if (s && Array.isArray(s.discrepancies) && s.discrepancies.length) {
    lines.push(`- DISCREPANCIES (present sources disagree — do NOT silently pick one):`);
    for (const d of s.discrepancies.slice(0, 12)) {
      const key = d && (d.key || d.field) ? (d.key || d.field) : '?';
      lines.push(`    · ${key}: ${JSON.stringify(d && (d.values || d.sources || d)).slice(0, 200)}`);
    }
  }
  if (primer && Array.isArray(primer.missing) && primer.missing.length) {
    lines.push(`- MISSING REQUIRED (treat as NOT_READY): ${primer.missing.join(', ')}`);
  }
  if (Array.isArray(primer && primer.facts) && primer.facts.length) {
    const confirmed = primer.facts.filter((x) => x && (x.status === 'human_confirmed' || x.status === 'verified')).length;
    lines.push(`- Document-verified facts on file: ${primer.facts.length} (${confirmed} verified/confirmed). A human_confirmed fact outranks everything.`);
  }

  let out = lines.join('\n');
  if (o.borrowerFacing) {
    const bs = safeRequire('../borrower-safe');
    if (bs && bs.scrubText) out = bs.scrubText(out);
  }
  return out;
}

/**
 * groundingBlock(appId, db, opts) → PRIMER_TEXT + the per-file summary, as ONE string
 * to inject into a system prompt. Never throws. borrowerFacing scrubs the note buyer.
 */
async function groundingBlock(appId, db, opts) {
  const primer = await assembleLoanPrimer(appId, db);
  const summary = fileSummaryText(primer, opts);
  return `${PRIMER_TEXT}\n\n----------------------------------------\n\n${summary}`;
}

module.exports = {
  PRIMER_TEXT,
  assembleLoanPrimer,
  fileSummaryText,
  groundingBlock,
  _internals: { money, pct, txt },
};
