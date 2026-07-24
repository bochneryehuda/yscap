'use strict';
/**
 * investor-guideline-review — the note-buyer guideline checks, run AS PART OF the ONE
 * whole-loan document-review run (NOT a separate AI pass). It consumes the data the run has
 * already gathered (canonical file values + appraisal + credit + experience) and emits
 * findings in the SHARED finding-registry shape, tagged `category:'investor_guideline'`, so
 * they land in the ONE deduped registry alongside every other desk's findings — one place,
 * categorized, no second AI cost.
 *
 * DETERMINISTIC: nearly every note-buyer rule is a deterministic check against data already
 * on the file (a NY loan, a loan over $1.5MM, an assignment, a transferred appraisal, a FICO
 * that disagrees with the priced score, claimed experience over verified). Those need no GPT.
 * The grounded GPT verifier (ai-guideline-verify) stays as an OPTIONAL depth layer on top.
 *
 * The rules below are a GENERALIZABLE TABLE — the owner's examples encoded as data. Add a note
 * buyer's rule by adding a row, not by writing new control flow. Every rule:
 *   - names the note buyer(s) it applies to (or ALL),
 *   - reads ONLY fields already on the file (never fabricates; insufficient data → no finding),
 *   - emits a finding with severity + an optional ESCALATION target,
 *   - carries a governing_rule + the expected/actual numbers for the record.
 *
 * ADVISORY under the governing "AI never blocks" rule: a fatal finding is a hard WARNING a
 * super-admin can override — it never hard-blocks and never touches a frozen number. PURE:
 * no DB, no network, never throws.
 */

const SOURCE = 'investor_guideline';
const CATEGORY = 'investor_guideline';

function normKey(v) { return String(v == null ? '' : v).toLowerCase().replace(/[^a-z0-9]/g, ''); }
function num(v) { const n = typeof v === 'number' ? v : (v == null || v === '' ? null : Number(v)); return Number.isFinite(n) ? n : null; }
function bool(v) { return v === true || v === 1 || v === '1' || v === 'true' || v === 't'; }
function money(n) { return n == null ? '(missing)' : `$${Math.round(n).toLocaleString('en-US')}`; }

// A note-buyer key matches a rule's audience.
function buyerMatches(audience, noteBuyerKey) {
  if (audience === 'all') return true;
  const nb = normKey(noteBuyerKey);
  if (!nb) return false;                       // a buyer-specific rule needs a known buyer
  return Array.isArray(audience) ? audience.includes(nb) : audience === nb;
}

// ---------------------------------------------------------------------------
// THE RULE TABLE — the owner's examples, generalized. Each `when(x)` returns:
//   true  → the rule fires (emit the finding),
//   false → the rule is satisfied (no finding),
//   null  → insufficient data to judge (NEVER fabricate — emit nothing).
// `x` is the normalized review input (see reviewInput()).
// ---------------------------------------------------------------------------
const RULES = [
  // ----- Blue Lake ESCALATION triggers (each a fatal "escalate to Blue Lake") -----
  { code: 'isg_bl_ny_loan', audience: 'bluelake', escalateTo: 'Blue Lake', severity: 'fatal',
    title: 'New York loan — escalate to Blue Lake', governing_rule: 'Blue Lake requires escalation on any New York loan',
    when: (x) => x.property_state == null ? null : x.property_state === 'NY',
    detail: (x) => `Property state is ${x.property_state}; Blue Lake requires escalation for New York.` },

  { code: 'isg_bl_assignment', audience: 'bluelake', escalateTo: 'Blue Lake', severity: 'fatal',
    title: 'Assignment of contract — escalate to Blue Lake', governing_rule: 'Blue Lake reviews every assignment of contract',
    when: (x) => x.is_assignment == null ? null : x.is_assignment === true,
    detail: () => 'This is an assignment of contract; Blue Lake must review it.' },

  { code: 'isg_bl_loan_over_1_5m', audience: 'bluelake', escalateTo: 'Blue Lake', severity: 'fatal',
    title: 'Loan over $1.5MM — escalate to Blue Lake', governing_rule: 'Blue Lake requires escalation for any loan above $1,500,000',
    when: (x) => x.loan_amount == null ? null : x.loan_amount > 1_500_000,
    expected: () => '$1,500,000', actual: (x) => money(x.loan_amount),
    detail: (x) => `Loan amount ${money(x.loan_amount)} exceeds the $1,500,000 escalation threshold.` },

  { code: 'isg_bl_rehab_over_as_is', audience: 'bluelake', escalateTo: 'Blue Lake', severity: 'fatal',
    title: 'Rehab budget over the as-is value — escalate to Blue Lake', governing_rule: 'Blue Lake requires escalation when the rehab budget exceeds the as-is value',
    when: (x) => (x.rehab_budget == null || x.as_is_value == null) ? null : x.rehab_budget > x.as_is_value,
    expected: (x) => money(x.as_is_value), actual: (x) => money(x.rehab_budget),
    detail: (x) => `Rehab budget ${money(x.rehab_budget)} exceeds the as-is value ${money(x.as_is_value)}.` },

  { code: 'isg_bl_rehab_over_250k', audience: 'bluelake', escalateTo: 'Blue Lake', severity: 'fatal',
    title: 'Rehab budget over $250k — escalate to Blue Lake', governing_rule: 'Blue Lake requires escalation for a rehab budget above $250,000',
    when: (x) => x.rehab_budget == null ? null : x.rehab_budget > 250_000,
    expected: () => '$250,000', actual: (x) => money(x.rehab_budget),
    detail: (x) => `Rehab budget ${money(x.rehab_budget)} exceeds $250,000.` },

  { code: 'isg_bl_groundup_deposit_over_1m', audience: 'bluelake', escalateTo: 'Blue Lake', severity: 'fatal',
    title: 'Ground-up deposit over $1MM — escalate to Blue Lake', governing_rule: 'Blue Lake requires escalation for a ground-up deposit above $1,000,000',
    when: (x) => (!x.is_ground_up || x.ground_up_deposit == null) ? null : x.ground_up_deposit > 1_000_000,
    expected: () => '$1,000,000', actual: (x) => money(x.ground_up_deposit),
    detail: (x) => `Ground-up construction deposit ${money(x.ground_up_deposit)} exceeds $1,000,000.` },

  { code: 'isg_bl_cashout_over_250k', audience: 'bluelake', escalateTo: 'Blue Lake', severity: 'fatal',
    title: 'Cash-out proceeds over $250k — escalate to Blue Lake', governing_rule: 'Blue Lake requires escalation when cash-out proceeds exceed $250,000',
    when: (x) => (!x.is_cash_out || x.cash_out_proceeds == null) ? null : x.cash_out_proceeds > 250_000,
    expected: () => '$250,000', actual: (x) => money(x.cash_out_proceeds),
    detail: (x) => `Cash-out proceeds ${money(x.cash_out_proceeds)} exceed $250,000.` },

  { code: 'isg_bl_property_conversion', audience: 'bluelake', escalateTo: 'Blue Lake', severity: 'fatal',
    title: 'Property conversion — escalate to Blue Lake', governing_rule: 'Blue Lake requires escalation on a property conversion',
    when: (x) => x.is_conversion == null ? null : x.is_conversion === true,
    detail: () => 'This loan involves a property conversion; Blue Lake must review it.' },

  { code: 'isg_bl_mid_construction', audience: 'bluelake', escalateTo: 'Blue Lake', severity: 'fatal',
    title: 'Mid-construction property — escalate to Blue Lake (usually ineligible)', governing_rule: 'Blue Lake requires escalation for a mid-construction property; usually ineligible',
    when: (x) => x.appraisal_mid_construction == null ? null : x.appraisal_mid_construction === true,
    detail: () => 'The appraisal indicates a mid-construction property; Blue Lake must review — usually not eligible.' },

  // ----- Transferred appraisal (buyer-specific handling) -----
  { code: 'isg_bl_transferred_appraisal', audience: 'bluelake', severity: 'fatal',
    title: 'Transferred appraisal — not eligible for Blue Lake', governing_rule: 'Blue Lake does not allow transferred appraisals',
    when: (x) => x.appraisal_transferred == null ? null : x.appraisal_transferred === true,
    detail: () => 'This appraisal was transferred (not originally addressed to us). Blue Lake does not accept transferred appraisals — this file does not qualify as-is.' },

  { code: 'isg_cf_transferred_appraisal_letter', audience: 'corrfirst', escalateTo: 'CorrFirst', severity: 'fatal',
    title: 'Transferred appraisal — transfer letter required (CorrFirst)', governing_rule: 'CorrFirst accepts a transferred appraisal only with a valid transfer letter',
    when: (x) => x.appraisal_transferred !== true ? null : x.appraisal_transfer_letter === false,
    detail: () => 'This appraisal was transferred. CorrFirst accepts it only with a transfer letter — none was found. Obtain and review the transfer letter per the CorrFirst guidelines.' },

  { code: 'isg_cf_comps_not_close', audience: 'corrfirst', escalateTo: 'CorrFirst', severity: 'fatal',
    title: 'Comparables not close enough — escalate to CorrFirst for appraisal review', governing_rule: 'CorrFirst requires comparables within their tolerance; otherwise an appraisal review is required',
    when: (x) => x.appraisal_comps_close == null ? null : x.appraisal_comps_close === false,
    detail: () => 'The appraisal comparables are not close enough under CorrFirst guidelines. Escalate to CorrFirst and order an appraisal review for clearance.' },

  // ----- Rural (all buyers escalate; read from the appraisal, not left as an open review) -----
  { code: 'isg_rural_property', audience: 'all', escalateTo: 'the note buyer', severity: 'fatal',
    title: 'Rural property — escalate', governing_rule: 'A rural property must be escalated to the note buyer',
    when: (x) => x.appraisal_rural == null ? null : x.appraisal_rural === true,
    detail: () => 'The appraisal indicates a rural property. Escalate to the note buyer for review (do not leave as an open condition).' },

  // ----- FICO integrity (all buyers) — the priced score must match the credit report -----
  { code: 'isg_fico_mismatch', audience: 'all', severity: 'fatal',
    title: 'FICO on file does not match the credit report — restructure at the correct score', governing_rule: 'The priced FICO must equal the imported credit-report FICO',
    when: (x) => (x.fico_file == null || x.fico_credit == null) ? null : x.fico_file !== x.fico_credit,
    expected: (x) => String(x.fico_credit), actual: (x) => String(x.fico_file),
    detail: (x) => `The file was priced at FICO ${x.fico_file}, but the imported credit report shows ${x.fico_credit}. Restructure at ${x.fico_credit} so the pricing is correct.` },

  // ----- Experience (all buyers) -----
  { code: 'isg_experience_claimed_over_verified', audience: 'all', severity: 'fatal',
    title: 'Claimed experience exceeds verified experience — verify before clearing', governing_rule: 'Claimed experience must be verified against the track record',
    when: (x) => (x.claimed_exp == null || x.verified_exp == null) ? null : x.claimed_exp > x.verified_exp,
    expected: (x) => `${x.verified_exp} verified`, actual: (x) => `${x.claimed_exp} claimed`,
    detail: (x) => `The file claims ${x.claimed_exp} deals of experience but only ${x.verified_exp} are verified. Verify the claimed experience before clearing.` },

  { code: 'isg_experience_stale_exit', audience: 'all', severity: 'warning',
    title: 'An experience exit is older than 3 years — does not count', governing_rule: 'Only exits within the last 3 years count toward experience (flip = sale date; hold = lease date)',
    when: (x) => x.has_stale_exit == null ? null : x.has_stale_exit === true,
    detail: () => 'One or more claimed exits are older than 3 years (flip = sale date; fix-and-hold = lease date) and do not count toward experience.' },

  // ----- Flood (all buyers) -----
  { code: 'isg_flood_zone_needs_insurance', audience: 'all', severity: 'fatal',
    title: 'Property in a flood zone — flood insurance condition required', governing_rule: 'A property in a flood zone requires flood insurance (all note buyers)',
    when: (x) => x.in_flood_zone == null ? null : x.in_flood_zone === true,
    detail: () => 'The property is in a flood zone. A flood-insurance condition is required for all note buyers.' },

  // ----- Price vs value (post-appraisal only — never before the appraisal is in) -----
  { code: 'isg_price_value_over_requirement', audience: 'all', severity: 'fatal',
    title: 'Purchase price above the value requirement', governing_rule: 'Purchase price must satisfy the as-is / ARV requirement once the appraisal is in',
    when: (x) => (!x.appraisal_present || x.purchase_price == null || x.as_is_value == null) ? null : x.purchase_price > x.as_is_value,
    expected: (x) => money(x.as_is_value), actual: (x) => money(x.purchase_price),
    detail: (x) => `Purchase price ${money(x.purchase_price)} exceeds the appraised as-is value ${money(x.as_is_value)}.` },
];

/**
 * reviewInput(raw) → normalized bag (PURE). Defensive: every field null-safe; the caller
 * (run.js) fills what the run has, missing fields stay null so their rules simply don't fire.
 */
function reviewInput(raw) {
  const r = raw || {};
  const appr = r.appraisal || {};
  return {
    note_buyer: r.note_buyer != null ? r.note_buyer : r.lender,
    property_state: r.property_state ? String(r.property_state).toUpperCase().slice(0, 2) : null,
    is_assignment: r.is_assignment == null ? null : bool(r.is_assignment),
    loan_amount: num(r.loan_amount),
    rehab_budget: num(r.rehab_budget),
    as_is_value: num(r.as_is_value),
    arv: num(r.arv),
    purchase_price: num(r.purchase_price),
    is_ground_up: bool(r.is_ground_up),
    ground_up_deposit: num(r.ground_up_deposit),
    is_cash_out: bool(r.is_cash_out),
    cash_out_proceeds: num(r.cash_out_proceeds),
    is_conversion: r.is_conversion == null ? null : bool(r.is_conversion),
    fico_file: num(r.fico_file),
    fico_credit: num(r.fico_credit),
    claimed_exp: num(r.claimed_exp),
    verified_exp: num(r.verified_exp),
    has_stale_exit: r.has_stale_exit == null ? null : bool(r.has_stale_exit),
    in_flood_zone: r.in_flood_zone == null ? null : bool(r.in_flood_zone),
    appraisal_present: bool(r.appraisal_present) || !!(appr && appr.present),
    appraisal_transferred: appr.transferred == null ? (r.appraisal_transferred == null ? null : bool(r.appraisal_transferred)) : bool(appr.transferred),
    appraisal_transfer_letter: appr.transfer_letter == null ? (r.appraisal_transfer_letter == null ? null : bool(r.appraisal_transfer_letter)) : bool(appr.transfer_letter),
    appraisal_rural: appr.rural == null ? (r.appraisal_rural == null ? null : bool(r.appraisal_rural)) : bool(appr.rural),
    appraisal_mid_construction: appr.mid_construction == null ? (r.appraisal_mid_construction == null ? null : bool(r.appraisal_mid_construction)) : bool(appr.mid_construction),
    appraisal_comps_close: appr.comps_close == null ? (r.appraisal_comps_close == null ? null : bool(r.appraisal_comps_close)) : bool(appr.comps_close),
  };
}

/**
 * review(raw) → findings[] in the finding-registry shape (PURE, never throws).
 * Each finding: { code, subject, severity, category:'investor_guideline', title, explanation,
 *   source:'investor_guideline', governing_rule, expected_value, actual_value, blocks_*,
 *   evidence:[{ note_buyer, escalate, escalate_to }] }.
 */
function review(raw) {
  try {
    const x = reviewInput(raw);
    const out = [];
    for (const rule of RULES) {
      if (!buyerMatches(rule.audience, x.note_buyer)) continue;
      let fired;
      try { fired = rule.when(x); } catch (_e) { fired = null; }
      if (fired !== true) continue;                       // false OR null (insufficient) → no finding
      const fatal = rule.severity === 'fatal';
      out.push({
        code: rule.code,
        subject: rule.code,
        severity: rule.severity,
        category: CATEGORY,
        title: rule.title,
        explanation: (rule.detail ? rule.detail(x) : rule.title) + (rule.escalateTo ? ` (escalate to ${rule.escalateTo})` : ''),
        source: SOURCE,
        governing_rule: rule.governing_rule || null,
        expected_value: rule.expected ? rule.expected(x) : null,
        actual_value: rule.actual ? rule.actual(x) : null,
        // Advisory hard-warning: a fatal ISG finding flags CTC/funding as a super-admin-overridable
        // warning (never a hard block). We set blocks_term_sheet:false here because these are
        // file-quality / escalation items, not a pricing-engine ineligibility — BUT note the ONE
        // registry's summarize() flips the AGGREGATE blocksTermSheet on ANY fatal severity (same as
        // every other desk's fatal), so a fatal ISG finding does surface on the term-sheet gate too;
        // it stays super-admin-overridable via the R6.18 issuance backstop, never a true block.
        blocks_term_sheet: false,
        blocks_ctc: fatal,
        blocks_funding: fatal,
        evidence: [{ note_buyer: x.note_buyer || null, escalate: !!rule.escalateTo, escalate_to: rule.escalateTo || null }],
      });
    }
    return out;
  } catch (_e) { return []; }
}

module.exports = { review, reviewInput, buyerMatches, RULES, SOURCE, CATEGORY, _internals: { normKey, num, bool } };
