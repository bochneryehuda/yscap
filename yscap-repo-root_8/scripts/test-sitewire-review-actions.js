/* Sitewire sync-review resolution logic (owner-directed 2026-07-20).
 *
 * The owner reported the manual-review queue looped instead of resolving, and later locked in a
 * GO-FORWARD-ONLY policy: PILOT manages the draw process ONLY for properties it pushed itself, and never
 * adopts/follows a pre-existing Sitewire property. This proves the PURE (no DB / no network) decision
 * logic behind both:
 *   • advisories may only ACKNOWLEDGE (never retry — retrying re-pushed and re-parked = the loop);
 *   • a genuine blocker (incl. a failed borrower assignment) may RETRY once the human fixes the cause;
 *   • the "loan already in Sitewire" collision offers NO adopt/link — only a (warned) RETRY = "delete it
 *     in Sitewire, then push a fresh copy" or DISMISS;
 *   • backend↔frontend advisory-set parity (if the two lists drift, the UI shows the wrong buttons).
 *
 * Run: node scripts/test-sitewire-review-actions.js */
const fs = require('fs');
const path = require('path');
const { SITEWIRE_ADVISORY, SITEWIRE_DUPE, sitewireReasonClass, sitewireAllowedActions } = require('../src/sitewire/review-actions');

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) pass++; else { fail++; console.log(`FAIL ${name}`); } };
const eq = (name, got, exp) => {
  const g = JSON.stringify(got), e = JSON.stringify(exp);
  if (g === e) pass++; else { fail++; console.log(`FAIL ${name}: got ${g} expected ${e}`); }
};

// The route's actual gate: dismiss is always allowed; anything else must be in the reason's action set.
const routeAllows = (reason, action) =>
  action === 'dismiss' || sitewireAllowedActions(sitewireReasonClass(reason)).includes(action);

// ---------------------------------------------------------------------------
// 1. reasonClass strips the ": human detail" suffix that reasons are stored with
// ---------------------------------------------------------------------------
eq('reasonClass strips detail suffix',
  sitewireReasonClass('sitewire_units_note: the file lists 2 unit(s) but the SOW is built for 4'),
  'sitewire_units_note');
eq('reasonClass of a bare code', sitewireReasonClass('sitewire_loan_already_in_sitewire'), 'sitewire_loan_already_in_sitewire');
eq('reasonClass of null is empty', sitewireReasonClass(null), '');

// ---------------------------------------------------------------------------
// 2. Advisory reviews: ACKNOWLEDGE or dismiss ONLY — never retry (that was the loop)
//    Note: borrower_assign_failed is NOT advisory (it's a real failure a re-push fixes — see §4).
// ---------------------------------------------------------------------------
for (const r of ['sitewire_units_note', 'sitewire_type_unmapped', 'sitewire_reconcile_draw_error', 'sitewire_unknown_op']) {
  eq(`advisory ${r} → [acknowledge, dismiss]`, sitewireAllowedActions(r), ['acknowledge', 'dismiss']);
  ok(`advisory ${r} allows acknowledge`, routeAllows(r + ': detail', 'acknowledge'));
  ok(`advisory ${r} allows dismiss`, routeAllows(r + ': detail', 'dismiss'));
  ok(`advisory ${r} BLOCKS retry (anti-loop)`, !routeAllows(r + ': detail', 'retry'));
  ok(`advisory ${r} BLOCKS link (no adopt path exists)`, !routeAllows(r + ': detail', 'link'));
}

// ---------------------------------------------------------------------------
// 3. Dupe collision (go-forward only): NO adopt/link. RETRY (warned delete+repush) or dismiss.
// ---------------------------------------------------------------------------
eq('dupe → [retry, dismiss]', sitewireAllowedActions(SITEWIRE_DUPE), ['retry', 'dismiss']);
ok('dupe allows retry (delete-in-Sitewire + push fresh)', routeAllows('sitewire_loan_already_in_sitewire: found 35228', 'retry'));
ok('dupe allows dismiss (keep separate)', routeAllows('sitewire_loan_already_in_sitewire: found 35228', 'dismiss'));
ok('dupe BLOCKS acknowledge', !routeAllows('sitewire_loan_already_in_sitewire: found 35228', 'acknowledge'));
ok('dupe offers NO link/adopt', !routeAllows('sitewire_loan_already_in_sitewire: found 35228', 'link'));

// ---------------------------------------------------------------------------
// 4. Genuine blockers (incl. a failed borrower assignment): RETRY or dismiss — never acknowledge/link
// ---------------------------------------------------------------------------
for (const r of ['sitewire_geocode_failed', 'sitewire_capital_partner_unmatched', 'sitewire_budget_mismatch', 'sitewire_push_failed', 'sitewire_borrower_assign_failed']) {
  eq(`blocker ${r} → [retry, dismiss]`, sitewireAllowedActions(r), ['retry', 'dismiss']);
  ok(`blocker ${r} allows retry`, routeAllows(r + ': detail', 'retry'));
  ok(`blocker ${r} BLOCKS acknowledge`, !routeAllows(r + ': detail', 'acknowledge'));
  ok(`blocker ${r} BLOCKS link`, !routeAllows(r + ': detail', 'link'));
}
// The SHOULD-FIX both audits flagged: a failed borrower assignment must remain retry-able.
ok('borrower_assign_failed is NOT advisory', !SITEWIRE_ADVISORY.has('sitewire_borrower_assign_failed'));
ok('borrower_assign_failed allows retry', routeAllows('sitewire_borrower_assign_failed: bad email', 'retry'));

// ---------------------------------------------------------------------------
// 5. Backend ↔ frontend advisory-set parity (drift guard)
//    If SyncReviews.jsx SW_ADVISORY and the backend set ever diverge, the UI would show the wrong
//    buttons and the loop could return. Keep them identical.
// ---------------------------------------------------------------------------
{
  const jsx = fs.readFileSync(path.join(__dirname, '..', 'app-v2', 'src', 'screens', 'SyncReviews.jsx'), 'utf8');
  const m = jsx.match(/const SW_ADVISORY = new Set\(\[([^\]]*)\]\)/);
  ok('frontend SW_ADVISORY literal found', !!m);
  if (m) {
    const feSet = new Set(m[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean));
    eq('advisory set sizes match', feSet.size, SITEWIRE_ADVISORY.size);
    let same = feSet.size === SITEWIRE_ADVISORY.size;
    for (const r of SITEWIRE_ADVISORY) if (!feSet.has(r)) same = false;
    ok('frontend SW_ADVISORY === backend SITEWIRE_ADVISORY', same);
    ok('borrower_assign_failed absent from frontend advisory set too', !feSet.has('sitewire_borrower_assign_failed'));
  }
  const dm = jsx.match(/const SW_DUPE = '([^']+)'/);
  ok('frontend SW_DUPE === backend SITEWIRE_DUPE', !!dm && dm[1] === SITEWIRE_DUPE);
}

// ---------------------------------------------------------------------------
console.log(`\n${fail === 0 ? 'ALL' : fail + ' FAILED,'} ${pass} sitewire review-action assertions ${fail === 0 ? 'passed' : ''}`);
process.exit(fail === 0 ? 0 : 1);
