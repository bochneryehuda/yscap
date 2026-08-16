/* AUTOPILOT borrower delivery — the PURE decision (owner-directed 2026-08-14).
 *
 * After an inspection comes back and the inspector's approved amounts are on the draw, PILOT delivers
 * the findings to the borrower AUTOMATICALLY — no coordinator click — and auto re-sends if the amount
 * later moves while the borrower has not yet acted. This pins `decideAutoDeliver` (the whole trigger
 * truth table) and `readyForBorrower` (which draw statuses are ready, by inspection method). No DB.
 *
 * Run: node scripts/test-draw-autodeliver-pure.js
 */
const { decideAutoDeliver, _internals } = require('../src/sitewire/deliver-findings');
const { readyForBorrower } = _internals;

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) pass++; else { fail++; console.log(`FAIL ${name}`); } };
const eq = (name, got, want) => ok(`${name} (got ${JSON.stringify(got)})`, got === want);

// A ready virtual draw with the inspector's amounts on file and no finding yet — the base "deliver" case.
const base = {
  autopilotOn: true, sitewireReadsOn: true, platform: 'sitewire', method: 'mobile',
  drawStatus: 'pending', historical: false, hasAmounts: true, currentCents: 625000,
  finding: null, released: false,
};
const d = (over) => decideAutoDeliver({ ...base, ...over });

// ---- switches / platform / lifecycle: never act ----
eq('autopilot off → skip', d({ autopilotOn: false }).action, 'skip');
eq('autopilot off → reason', d({ autopilotOn: false }).reason, 'autopilot_off');
eq('sitewire reads off → skip', d({ sitewireReadsOn: false }).action, 'skip');
eq('sitewire off → reason', d({ sitewireReadsOn: false }).reason, 'sitewire_off');
eq('historical draw → skip', d({ historical: true }).action, 'skip');
eq('historical → reason', d({ historical: true }).reason, 'historical');
// TrustPoint files deliver on their OWN mirror APPROVED transition; 'external' runs no draw flow.
eq('trustpoint platform → skip', d({ platform: 'trustpoint' }).action, 'skip');
eq('trustpoint → reason not_sitewire', d({ platform: 'trustpoint' }).reason, 'not_sitewire');
eq('external platform → skip', d({ platform: 'external' }).action, 'skip');
// Money already moved — never touch it (the coordinator reconciles a release-drift by hand).
eq('released → skip', d({ released: true }).action, 'skip');
eq('released → reason', d({ released: true }).reason, 'released');

// ---- a finding the borrower already acted on is the coordinator's call (manual force-redeliver) ----
for (const s of ['accepted', 'disputed', 'resolved']) {
  eq(`finding ${s} → skip`, d({ finding: { status: s, total_approved_cents: 625000 } }).action, 'skip');
  eq(`finding ${s} → reason`, d({ finding: { status: s, total_approved_cents: 625000 } }).reason, 'finding_' + s);
}

// ---- FIRST delivery: no finding yet ----
eq('no inspector amounts → skip', d({ hasAmounts: false }).action, 'skip');
eq('no amounts → reason', d({ hasAmounts: false }).reason, 'no_inspector_amounts');

// virtual (mobile): ready at pending / pending_capital_partner / approved
for (const s of ['pending', 'pending_capital_partner', 'approved']) {
  eq(`virtual ${s} + amounts + no finding → deliver`, d({ drawStatus: s }).action, 'deliver');
}
eq('deliver → reason first_delivery', d({ drawStatus: 'pending' }).reason, 'first_delivery');
// virtual: NOT ready before the inspection completes
for (const s of ['drafting', 'pending_borrower', 'inspecting']) {
  eq(`virtual ${s} → skip (not ready)`, d({ drawStatus: s }).action, 'skip');
  eq(`virtual ${s} → reason not_ready`, d({ drawStatus: s }).reason, 'not_ready');
}

// physical (traditional): 'pending' means "submitted, arrange the inspection" — NOT ready yet.
// Ready only once the coordinator has entered the amounts AND approved the draw.
eq('physical pending → skip (wait for approval)', d({ method: 'traditional', drawStatus: 'pending' }).action, 'skip');
eq('physical pending → reason not_ready', d({ method: 'traditional', drawStatus: 'pending' }).reason, 'not_ready');
for (const s of ['pending_capital_partner', 'approved']) {
  eq(`physical ${s} + amounts → deliver`, d({ method: 'traditional', drawStatus: s }).action, 'deliver');
}
// an unknown method is treated as virtual (the common Sitewire case), never left un-deliverable
eq('null method behaves like virtual at pending', d({ method: null, drawStatus: 'pending' }).action, 'deliver');

// ---- AUTO RE-SEND: a still-'delivered' finding whose amount moved ----
const delivered = (over) => d({ finding: { status: 'delivered', total_approved_cents: 625000 }, ...over });
eq('delivered + amount changed (up) → resend', delivered({ currentCents: 700000 }).action, 'resend');
eq('delivered + amount changed (down) → resend', delivered({ currentCents: 500000 }).action, 'resend');
eq('resend → reason amount_changed', delivered({ currentCents: 700000 }).reason, 'amount_changed');
eq('delivered + amount unchanged → skip', delivered({ currentCents: 625000 }).action, 'skip');
eq('unchanged → reason', delivered({ currentCents: 625000 }).reason, 'unchanged');
// re-send does NOT depend on the current status (it may have advanced past pending since delivery),
// but it DOES still respect released + the terminal-finding guard + hasAmounts.
eq('delivered + changed + advanced status → resend', delivered({ currentCents: 700000, drawStatus: 'pending_capital_partner' }).action, 'resend');
eq('delivered + changed but released → skip', delivered({ currentCents: 700000, released: true }).action, 'skip');
eq('delivered + amounts vanished → skip (never re-send an empty finding)', delivered({ currentCents: 0, hasAmounts: false }).action, 'skip');
// a finding with a null stored total compares against 0 (never crashes)
eq('delivered null-total + real amount → resend', d({ finding: { status: 'delivered', total_approved_cents: null }, currentCents: 625000 }).action, 'resend');
eq('delivered null-total + zero-but-answered → skip unchanged', d({ finding: { status: 'delivered', total_approved_cents: null }, currentCents: 0, hasAmounts: true }).action, 'skip');

// ---- readyForBorrower unit checks ----
eq('readyForBorrower mobile pending', readyForBorrower('pending', 'mobile'), true);
eq('readyForBorrower mobile inspecting', readyForBorrower('inspecting', 'mobile'), false);
eq('readyForBorrower traditional pending', readyForBorrower('pending', 'traditional'), false);
eq('readyForBorrower traditional approved', readyForBorrower('approved', 'traditional'), true);
eq('readyForBorrower null-method pending (virtual default)', readyForBorrower('pending', null), true);

// ---- robustness: no input never throws ----
ok('empty input → skip, no throw', decideAutoDeliver().action === 'skip' || decideAutoDeliver({}).action === 'skip');
ok('decideAutoDeliver({}) → skip', decideAutoDeliver({}).action === 'skip');

console.log(`\n${fail === 0 ? 'ALL' : fail + ' FAILED,'} ${pass} auto-deliver decision assertions ${fail === 0 ? 'passed' : ''}`);
process.exit(fail === 0 ? 0 : 1);
