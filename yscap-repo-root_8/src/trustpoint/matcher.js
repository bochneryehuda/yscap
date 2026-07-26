'use strict';
/**
 * TrustPoint project → PILOT file matcher (phase 2 — blueprint §4, owner D1).
 * PURE — no I/O; fully unit-testable.
 *
 * The investor (Blue Lake) creates projects in TrustPoint; PILOT links them:
 *   Tier 1 — our LOAN NUMBER appears in loan.external_id or the project name → auto-link
 *            (requires the number to be unique across candidate files).
 *   Tier 2 — normalized ADDRESS equality (house number + street tokens + zip when both
 *            sides have one), UNIQUE on both sides → auto-link. Owner-confirmed 2026-07-24:
 *            "there's not gonna be more than one per address" — so a unique address match
 *            may bind on its own; corroborators (budget ≈, borrower email, entity name)
 *            are recorded in the reason for the desk display.
 *   Anything else → NO match; at most a SUGGESTION (candidate) for the human desk.
 *   Ambiguity (two files, one address) NEVER auto-binds — never-guess.
 */

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');

/** Normalize a loan number for containment matching; too-short keys never match. */
function normLoanNumber(s) {
  const k = norm(s);
  return k.length >= 4 ? k : null;
}

// Street-suffix folding so "12 Oak Street" and "12 Oak St" agree (mirrors the
// sharepoint-map discipline: house number equality + suffix-normalized street tokens).
const SUFFIX = {
  street: 'st', avenue: 'ave', av: 'ave', boulevard: 'blvd', drive: 'dr', lane: 'ln',
  road: 'rd', court: 'ct', place: 'pl', terrace: 'ter', parkway: 'pkwy', highway: 'hwy',
  circle: 'cir', square: 'sq', trail: 'trl',
};
/**
 * @param {string} oneLine e.g. "12 Oak Street, Testville, NY 10001" (or just the street part)
 * @returns {{houseNo:string|null, key:string|null, zip:string|null}}
 */
function normAddr(oneLine) {
  const s = String(oneLine || '').trim();
  if (!s) return { houseNo: null, key: null, zip: null };
  const zipM = s.match(/\b(\d{5})(?:-\d{4})?\b(?!.*\b\d{5}\b)/);
  const zip = zipM ? zipM[1] : null;
  const street = s.split(',')[0].trim().replace(/#\s*\d+[a-z]?\b/gi, ' ');
  const tokens = street.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean)
    .map((t) => SUFFIX[t] || t)
    // unit designators never affect identity ("12 Oak St Unit 2" == "12 Oak St")
    .filter((t, i, arr) => !(['unit', 'apt', 'ste', 'suite', '#'].includes(t) || (i > 0 && ['unit', 'apt', 'ste', 'suite'].includes(arr[i - 1]))));
  const houseNo = tokens.length && /^\d+[a-z]?$/.test(tokens[0]) ? tokens[0] : null;
  if (!houseNo) return { houseNo: null, key: null, zip };
  return { houseNo, key: tokens.join(''), zip };
}

/**
 * Match ONE TrustPoint project against the candidate PILOT files.
 * @param project    { tp_project_id, name, external_id, address_text, zip, budget_cents, borrower_emails:[], entity_name }
 * @param candidates [{ id, ys_loan_number, addr_one_line, zip, rehab_budget_cents, borrower_email, llc_name }]
 * @returns { tier:1|2, applicationId, matchedBy, reason } | { tier:null, candidateId?, reason? }
 */
function matchProject(project = {}, candidates = []) {
  const extKey = normLoanNumber(project.external_id);
  const nameKey = norm(project.name);

  // ---- Tier 1: loan number in external_id or project name ----
  const t1 = [];
  for (const c of candidates) {
    const ln = normLoanNumber(c.ys_loan_number);
    if (!ln) continue;
    // An ALL-DIGIT loan number inside a normalized name is indistinguishable from an
    // address/zip digit run — those only match on external_id equality (audit #16).
    const allDigits = /^\d+$/.test(ln);
    if ((extKey && extKey === ln) || (!allDigits && nameKey && nameKey.includes(ln))) t1.push(c);
  }
  if (t1.length === 1) {
    return { tier: 1, applicationId: t1[0].id, matchedBy: 'loan_number',
      reason: extKey && normLoanNumber(t1[0].ys_loan_number) === extKey ? `loan number ${t1[0].ys_loan_number} = external id` : `loan number ${t1[0].ys_loan_number} in project name` };
  }
  if (t1.length > 1) return { tier: null, reason: `loan-number ambiguity across ${t1.length} files — link by hand` };

  // ---- Tier 2: unique normalized address (+ zip when both known) ----
  const pAddr = normAddr(project.address_text);
  if (!pAddr.key) return { tier: null, reason: 'no usable address on the TrustPoint project' };
  const t2 = [];
  for (const c of candidates) {
    const a = normAddr(c.addr_one_line);
    if (!a.key || a.key !== pAddr.key) continue;
    const pz = project.zip || pAddr.zip, cz = c.zip || a.zip;
    if (pz && cz && pz !== cz) continue;   // both sides know the zip and disagree → not the same property
    t2.push(c);
  }
  if (t2.length === 1) {
    const c = t2[0];
    const corr = [];
    if (project.budget_cents != null && c.rehab_budget_cents != null && Math.abs(Number(project.budget_cents) - Number(c.rehab_budget_cents)) <= 100) corr.push('budget matches');
    if (Array.isArray(project.borrower_emails) && c.borrower_email && project.borrower_emails.some((e) => norm(e) === norm(c.borrower_email))) corr.push('borrower email matches');
    if (project.entity_name && c.llc_name && norm(project.entity_name) === norm(c.llc_name)) corr.push('entity matches');
    return { tier: 2, applicationId: c.id, matchedBy: 'address',
      reason: `address match${corr.length ? ' + ' + corr.join(' + ') : ''}` };
  }
  if (t2.length > 1) return { tier: null, reason: `address ambiguity across ${t2.length} files — link by hand` };
  return { tier: null, reason: 'no matching file found' };
}

/**
 * Milestone ↔ SOW-line crosswalk matcher (D4). TrustPoint milestones were hand-copied
 * from PILOT's budget, so normalized NAME equality is the primary key; a same-amount
 * unique fallback catches renamed lines. Ambiguity → unmatched (human confirms later).
 * @param milestones [{ tp_milestone_id, name, amount_cents }]
 * @param sowLines   [{ sitewire_job_item_id, sow_line_key, name, budgeted_cents }]
 * @returns { matched:[{tp_milestone_id, sitewire_job_item_id, sow_line_key, matched_by}], unmatched:[tp_milestone_id] }
 */
function matchMilestones(milestones = [], sowLines = []) {
  const byName = new Map();
  for (const l of sowLines) {
    const k = norm(l.name);
    if (!k) continue;
    byName.set(k, byName.has(k) ? null : l);   // null = ambiguous name — never bound
  }
  const matched = [], unmatched = [];
  const taken = new Set();
  for (const m of milestones) {
    const k = norm(m.name);
    let hit = k ? byName.get(k) : null;
    if (hit === null) hit = undefined;         // ambiguous name → skip to amount fallback
    if (hit && !taken.has(hit.sitewire_job_item_id)) {
      taken.add(hit.sitewire_job_item_id);
      matched.push({ tp_milestone_id: m.tp_milestone_id, sitewire_job_item_id: hit.sitewire_job_item_id, sow_line_key: hit.sow_line_key, matched_by: 'name' });
      continue;
    }
    // amount-unique fallback (only when exactly one un-taken line carries this amount)
    const amt = m.amount_cents == null ? null : Number(m.amount_cents);
    const byAmt = amt == null ? [] : sowLines.filter((l) => !taken.has(l.sitewire_job_item_id) && Number(l.budgeted_cents) === amt && amt > 0);
    if (byAmt.length === 1) {
      taken.add(byAmt[0].sitewire_job_item_id);
      matched.push({ tp_milestone_id: m.tp_milestone_id, sitewire_job_item_id: byAmt[0].sitewire_job_item_id, sow_line_key: byAmt[0].sow_line_key, matched_by: 'amount' });
      continue;
    }
    unmatched.push(m.tp_milestone_id);
  }
  return { matched, unmatched };
}

module.exports = { matchProject, matchMilestones, normAddr, normLoanNumber, _norm: norm };
