/* Sitewire sync-review resolution + property-linking logic (owner-directed 2026-07-20).
 *
 * The owner reported three broken things about the manual-review queue, all of which come down to
 * "a resolution must ACTUALLY resolve, not loop":
 *   1. Clicking Retry on an advisory (units_note) cleared the card, re-pushed, re-parked the same
 *      advisory, and emailed — "again and again and again". → advisories may only ACKNOWLEDGE, never retry.
 *   2. "loan already in Sitewire (property 35228)" for the very same file is NOT an error — it should
 *      LINK the file to that hand-entered property. → the dupe review offers LINK, and adoptDecision
 *      only links when loan# AND address both match (never adopts the wrong property).
 *   3. Retrying a downstream blocker while the dupe collision is still open just re-hits the wall.
 *
 * This proves the PURE decision logic behind those fixes, with NO DB and NO network:
 *   • sitewireAllowedActions / sitewireReasonClass — which actions each review class may offer, and
 *     the route's allow/deny check derived from them.
 *   • orchestrator.adoptDecision — the "never adopt the wrong property" guard set.
 *   • backend↔frontend advisory-set parity — if the two lists drift, the UI would offer the wrong
 *     buttons and the loop could come back.
 *
 * Run: node scripts/test-sitewire-review-actions.js */
const fs = require('fs');
const path = require('path');
const { SITEWIRE_ADVISORY, SITEWIRE_DUPE, sitewireReasonClass, sitewireAllowedActions } = require('../src/sitewire/review-actions');
const orch = require('../src/sitewire/orchestrator');

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
// ---------------------------------------------------------------------------
for (const r of ['sitewire_units_note', 'sitewire_type_unmapped', 'sitewire_borrower_assign_failed', 'sitewire_reconcile_draw_error', 'sitewire_unknown_op']) {
  eq(`advisory ${r} → [acknowledge, dismiss]`, sitewireAllowedActions(r), ['acknowledge', 'dismiss']);
  ok(`advisory ${r} allows acknowledge`, routeAllows(r + ': detail', 'acknowledge'));
  ok(`advisory ${r} allows dismiss`, routeAllows(r + ': detail', 'dismiss'));
  ok(`advisory ${r} BLOCKS retry (anti-loop)`, !routeAllows(r + ': detail', 'retry'));
  ok(`advisory ${r} BLOCKS link`, !routeAllows(r + ': detail', 'link'));
}

// ---------------------------------------------------------------------------
// 3. Dupe collision: LINK or dismiss — never a blind retry
// ---------------------------------------------------------------------------
eq('dupe → [link, dismiss]', sitewireAllowedActions(SITEWIRE_DUPE), ['link', 'dismiss']);
ok('dupe allows link', routeAllows('sitewire_loan_already_in_sitewire: found 35228', 'link'));
ok('dupe allows dismiss', routeAllows('sitewire_loan_already_in_sitewire: found 35228', 'dismiss'));
ok('dupe BLOCKS retry', !routeAllows('sitewire_loan_already_in_sitewire: found 35228', 'retry'));
ok('dupe BLOCKS acknowledge', !routeAllows('sitewire_loan_already_in_sitewire: found 35228', 'acknowledge'));

// ---------------------------------------------------------------------------
// 4. A genuine blocker (unknown reason class): RETRY or dismiss — never acknowledge/link
// ---------------------------------------------------------------------------
for (const r of ['sitewire_geocode_failed', 'sitewire_capital_partner_unmatched', 'sitewire_budget_mismatch', 'sitewire_push_failed']) {
  eq(`blocker ${r} → [retry, dismiss]`, sitewireAllowedActions(r), ['retry', 'dismiss']);
  ok(`blocker ${r} allows retry`, routeAllows(r + ': detail', 'retry'));
  ok(`blocker ${r} BLOCKS acknowledge`, !routeAllows(r + ': detail', 'acknowledge'));
  ok(`blocker ${r} BLOCKS link`, !routeAllows(r + ': detail', 'link'));
}

// ---------------------------------------------------------------------------
// 5. adoptDecision — the "never adopt the wrong property" guard set (PURE)
//    Real case: Mutty Kaufman file, loan YSCAP258134761, 1053 Ella T Grasso Blvd, Sitewire prop 35228.
// ---------------------------------------------------------------------------
const LOAN = 'YSCAP258134761';
const ADDR = '1053 Ella T Grasso Blvd, New Haven CT 06511';
const base = { propId: 35228, fileLoan: LOAN, existingLinkPropId: null, swPresent: true, swLoan: LOAN, fileAddrStr: ADDR, swAddrStr: ADDR };

// happy path — loan# and address both match live
ok('adopt OK when loan# + address both match', orch.adoptDecision({ ...base }).ok === true);

// invalid property id
ok('adopt refused: propId 0', orch.adoptDecision({ ...base, propId: 0 }).ok === false);
ok('adopt refused: propId negative', orch.adoptDecision({ ...base, propId: -5 }).ok === false);
ok('adopt refused: propId NaN', orch.adoptDecision({ ...base, propId: NaN }).ok === false);

// file has no loan number to match on
ok('adopt refused: file has no loan number', orch.adoptDecision({ ...base, fileLoan: '' }).ok === false);

// already linked to a DIFFERENT property → refuse (never re-adopt over a conflicting link)
{
  const d = orch.adoptDecision({ ...base, existingLinkPropId: 99999 });
  ok('adopt refused: already linked to a different property', d.ok === false);
  ok('  …and the message names the existing link', /99999/.test(d.error));
}
// already linked to the SAME property → allowed (idempotent re-link)
ok('adopt OK: already linked to the same property', orch.adoptDecision({ ...base, existingLinkPropId: 35228 }).ok === true);

// Sitewire property not found
ok('adopt refused: sitewire property absent', orch.adoptDecision({ ...base, swPresent: false }).ok === false);

// loan number mismatch (found a DIFFERENT loan on that property) → the core safety guard
{
  const d = orch.adoptDecision({ ...base, swLoan: 'YSCAP999999999' });
  ok('adopt refused: loan number mismatch', d.ok === false);
  ok('  …message shows both loan numbers', /YSCAP999999999/.test(d.error) && /YSCAP258134761/.test(d.error));
}
ok('adopt refused: sitewire property has no loan number', orch.adoptDecision({ ...base, swLoan: '' }).ok === false);

// address mismatch — same loan number keyed onto the WRONG property must NOT link
{
  const d = orch.adoptDecision({ ...base, swAddrStr: '999 Somewhere Else Ave, Hartford CT 06101' });
  ok('adopt refused: address mismatch (never adopt the wrong property)', d.ok === false);
  ok('  …message says it never adopts the wrong property', /wrong property/i.test(d.error));
}
ok('adopt refused: file address missing', orch.adoptDecision({ ...base, fileAddrStr: '' }).ok === false);
ok('adopt refused: sitewire address missing', orch.adoptDecision({ ...base, swAddrStr: '' }).ok === false);

// house-number-only difference must fail (the anchor guard): "1053" vs "1055"
ok('adopt refused: house number differs by two',
  orch.adoptDecision({ ...base, swAddrStr: '1055 Ella T Grasso Blvd, New Haven CT 06511' }).ok === false);

// ---------------------------------------------------------------------------
// 6. Backend ↔ frontend advisory-set parity (drift guard)
//    If SyncReviews.jsx SW_ADVISORY and the backend set ever diverge, the UI would show the wrong
//    buttons and the loop could return. Keep them identical.
// ---------------------------------------------------------------------------
{
  const jsx = fs.readFileSync(path.join(__dirname, '..', 'app-v2', 'src', 'screens', 'SyncReviews.jsx'), 'utf8');
  const m = jsx.match(/const SW_ADVISORY = new Set\(\[([^\]]*)\]\)/);
  ok('frontend SW_ADVISORY literal found', !!m);
  if (m) {
    const feSet = new Set(m[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean));
    const beSet = SITEWIRE_ADVISORY;
    eq('advisory set sizes match', feSet.size, beSet.size);
    let same = feSet.size === beSet.size;
    for (const r of beSet) if (!feSet.has(r)) same = false;
    ok('frontend SW_ADVISORY === backend SITEWIRE_ADVISORY', same);
  }
  const dm = jsx.match(/const SW_DUPE = '([^']+)'/);
  ok('frontend SW_DUPE === backend SITEWIRE_DUPE', !!dm && dm[1] === SITEWIRE_DUPE);
}

// ---------------------------------------------------------------------------
console.log(`\n${fail === 0 ? 'ALL' : fail + ' FAILED,'} ${pass} sitewire review-action assertions ${fail === 0 ? 'passed' : ''}`);
process.exit(fail === 0 ? 0 : 1);
