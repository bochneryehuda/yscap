/* THE DRAW APPROVAL LADDER + INSPECTION EVIDENCE (owner-reported 2026-08-03, file YSCAP258134591 /
 * 195-197 Parrish St draw #1). Every assertion below reproduces something that was WRONG on that
 * draw's real report, packet and desk, and each one fails on the pre-fix code:
 *
 *   A. approval.js       — "approved" before final approval is the INSPECTOR's number, not Sitewire's
 *                          total_approved_cents (which is 0 until we press Final approve → the
 *                          "$0 APPROVED FOR RELEASE" headline over a page of $6,250 approvals).
 *   B. inspection-evidence — a request's photos are proven by the union of the mirror, the delivered
 *                          findings and the archived media; the draw-level payload omits the
 *                          inspections array, so the mirrored counter alone reads 0 forever.
 *   C. risk.js           — a line with photos is not flagged "no inspection photos attached", and a
 *                          verified finished trade is a note, not a red flag.
 *   D. rollup.js         — an inspector-approved draw is COMMITTED against its line, so the budget
 *                          stops showing the whole amount as still available.
 *   E. draw-report.js    — an inspected line finds its budget line by the CROSSWALK key, not by name
 *                          ("Unit 1 - Roof" could never match the "Roof" budget row).
 *
 * PURE — no DB, no network. Run: node scripts/test-draw-approval-ladder.js
 */
const APPROVAL = require('../src/sitewire/approval');
const EV = require('../src/sitewire/inspection-evidence');
const risk = require('../src/sitewire/risk');
const rollupMod = require('../src/sitewire/rollup');
const report = require('../src/sitewire/draw-report');

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) pass++; else { fail++; console.log(`FAIL ${name}`); } };
const eq = (name, got, exp) => { if (JSON.stringify(got) === JSON.stringify(exp)) pass++; else { fail++; console.log(`FAIL ${name}: got ${JSON.stringify(got)} expected ${JSON.stringify(exp)}`); } };

// ---------------------------------------------------------------------------
// The real shape of the reported draw: four "Unit N - Roof" job items exploded from ONE $25,000
// "Roof" Scope-of-Work line, each requested AND inspector-approved at $6,250, on a draw Sitewire
// still reports as `pending` with total_approved_cents = 0.
// ---------------------------------------------------------------------------
const DRAW = { sitewire_draw_id: 9001, number: 1, status: 'pending', total_requested_cents: 2500000, total_approved_cents: 0 };
const REQUESTS = [1, 2, 3, 4].map((u) => ({
  sitewire_draw_id: 9001, sitewire_request_id: 7000 + u, sitewire_job_item_id: 5000 + u,
  requested_cents: 625000, approved_cents: 625000,
  inspection_count: 0,      // <- the draw-level payload never carried the inspections array
}));
const FINDING_LINES = [1, 2, 3, 4].map((u) => ({
  sitewire_draw_id: 9001, sitewire_request_id: 7000 + u, sow_line_key: 'cat:roof', unit_index: u,
  name: `Unit ${u} - Roof`, requested_cents: 625000, approved_cents: 625000, photo_count: 5, video_count: 0,
}));
const LINKS = [1, 2, 3, 4].map((u) => ({
  sitewire_job_item_id: 5000 + u, sow_line_key: 'cat:roof', unit_index: u,
  name: `Unit ${u} - Roof`, budgeted_cents: 625000, is_media_item: false, state: 'live',
})).concat([
  // the rest of the $220,000 construction budget, untouched by this draw — this is what makes the
  // roof line run ahead of the project as a whole (11% overall vs 100% on the roof).
  { sitewire_job_item_id: 5100, sow_line_key: 'cat:plumb', unit_index: null, name: 'Plumbing - rough', budgeted_cents: 3500000, is_media_item: false, state: 'live' },
  { sitewire_job_item_id: 5101, sow_line_key: 'cat:elec', unit_index: null, name: 'Electrical - rough', budgeted_cents: 3000000, is_media_item: false, state: 'live' },
  { sitewire_job_item_id: 5102, sow_line_key: 'cat:dry', unit_index: null, name: 'Drywall Remove and Replace', budgeted_cents: 3000000, is_media_item: false, state: 'live' },
  { sitewire_job_item_id: 5103, sow_line_key: 'cat:rest', unit_index: null, name: 'Everything else', budgeted_cents: 10000000, is_media_item: false, state: 'live' },
]);

// ===========================================================================
// A. THE APPROVAL LADDER
// ===========================================================================
{
  const m = APPROVAL.drawMoney({ draw: DRAW, requests: REQUESTS, findingLines: FINDING_LINES, feeCents: 29900 });
  eq('A1 inspector-approved is the full $25,000, not Sitewire\'s $0 final field', m.inspector_approved_cents, 2500000);
  eq('A1b the number every surface prints as "approved" is the inspector\'s', m.approved_cents, 2500000);
  eq('A2 final approved stays $0 until we press Final approve', m.final_approved_cents, 0);
  eq('A3 nothing is "not approved" — the inspector approved every dollar requested', m.not_approved_cents, 0);
  eq('A4 the $299 draw fee is netted out of the release', m.net_release_cents, 2500000 - 29900);
  ok('A5 the fee is marked as a projection until the release is recorded', m.fee_projected === true);
  eq('A6 the stage names whose approval this is', m.approval_stage, 'inspector_approved');
  ok('A7 the netting is explained in words', /draw processing fee/.test(APPROVAL.netExplanation(m) || ''));
  ok('A8 the explanation shows the arithmetic', /\$25,000 approved/.test(APPROVAL.netExplanation(m) || ''));
}
{
  // source precedence: the live mirror wins; the delivered findings answer when it is silent.
  const noMirror = REQUESTS.map((r) => ({ ...r, approved_cents: null }));
  const m = APPROVAL.drawMoney({ draw: DRAW, requests: noMirror, findingLines: FINDING_LINES });
  eq('A9 with the mirror silent, the delivered findings answer', m.inspector_approved_cents, 2500000);
  eq('A9b and the source is reported', m.inspector_approved_source, 'findings');
}
{
  // a genuinely un-inspected draw must NOT report a confident $0 approval
  const fresh = REQUESTS.map((r) => ({ ...r, approved_cents: null }));
  const m = APPROVAL.drawMoney({ draw: { ...DRAW, status: 'inspecting' }, requests: fresh, findingLines: [] });
  eq('A10 an un-inspected draw has no inspector amounts', m.has_inspector_amounts, false);
  eq('A10b and reads as "inspecting", never "approved $0"', m.approval_stage, 'inspecting');
}
{
  // partial approval — the borrower asked $25,000, the inspector approved $18,000
  const partial = REQUESTS.map((r, i) => ({ ...r, approved_cents: i < 3 ? 600000 : 0 }));
  const m = APPROVAL.drawMoney({ draw: DRAW, requests: partial, findingLines: [], feeCents: 29900 });
  eq('A11 a partial approval sums the lines', m.inspector_approved_cents, 1800000);
  eq('A11b the shortfall is held back for a future draw', m.not_approved_cents, 700000);
}
{
  // after final approval + a recorded release the stored net wins and nothing is a projection
  const done = { ...DRAW, status: 'approved', total_approved_cents: 2500000 };
  const m = APPROVAL.drawMoney({ draw: done, requests: REQUESTS, findingLines: FINDING_LINES,
    feeCents: 29900, feeRecorded: true, netReleaseCents: 2470100, released: true });
  eq('A12 final approved is the real figure once we approve', m.final_approved_cents, 2500000);
  eq('A12b the recorded net release wins over the projection', m.net_release_cents, 2470100);
  ok('A12c the fee is no longer a projection', m.fee_projected === false);
  eq('A12d the stage is released', m.approval_stage, 'released');
}
{
  const ladder = [
    [{ draw: { status: 'pending_borrower' } }, 'with_borrower'],
    [{ draw: { status: 'inspecting' } }, 'inspecting'],
    [{ draw: { status: 'pending' }, hasInspectorAmounts: true }, 'inspector_approved'],
    [{ draw: { status: 'pending' }, finding: { status: 'delivered' }, hasInspectorAmounts: true }, 'borrower_review'],
    [{ draw: { status: 'pending' }, finding: { status: 'accepted' }, hasInspectorAmounts: true }, 'borrower_accepted'],
    [{ draw: { status: 'pending' }, finding: { status: 'disputed' }, hasInspectorAmounts: true }, 'borrower_disputed'],
    [{ draw: { status: 'pending_capital_partner' }, hasInspectorAmounts: true }, 'with_investor'],
    [{ draw: { status: 'approved' } }, 'final_approved'],
    [{ draw: { status: 'approved' }, released: true }, 'released'],
  ];
  let allOk = true;
  for (const [args, expected] of ladder) if (APPROVAL.approvalState(args).stage !== expected) { allOk = false; console.log(`  ladder ${expected} → ${APPROVAL.approvalState(args).stage}`); }
  ok('A13 every rung of the ladder maps to the right stage', allOk);
  ok('A14 the borrower never hears about the capital partner',
    !/capital|investor|partner/i.test(APPROVAL.approvalState({ draw: { status: 'pending_capital_partner' } }).borrowerLabel));
}

// ===========================================================================
// B. INSPECTION EVIDENCE
// ===========================================================================
{
  const evidence = EV.buildEvidence({ requests: REQUESTS, findingLines: FINDING_LINES, media: [] });
  ok('B1 photos filed on the findings prove the line was inspected, even with the mirror at 0',
    EV.hasEvidence(evidence, 7001) && EV.hasEvidence(evidence, 7004));
  eq('B2 the count shown is the strongest source, never the stale 0', EV.evidenceCount(evidence, 7001, 0), 5);
}
{
  // findings not yet persisted, but the photos were archived into PILOT — still verified
  const media = [1, 2, 3].map((i) => ({ sitewire_request_id: 7001, kind: 'image', id: i }));
  const evidence = EV.buildEvidence({ requests: REQUESTS, findingLines: [], media });
  ok('B3 archived photos alone prove the inspection', EV.hasEvidence(evidence, 7001));
  ok('B4 a request with nothing anywhere is NOT claimed as verified', !EV.hasEvidence(evidence, 7002));
  eq('B5 a draw PDF is not per-line photo evidence',
    EV.buildEvidence({ requests: REQUESTS, findingLines: [], media: [{ sitewire_request_id: 7002, kind: 'draw_pdf' }] }).get(7002).count, 0);
}
{
  const evidence = EV.buildEvidence({ requests: [{ sitewire_request_id: 7001, inspection_count: 9 }], findingLines: [], media: [] });
  eq('B6 a live mirrored count is honoured on its own', EV.evidenceCount(evidence, 7001, 0), 9);
  ok('B7 an unknown request id is never guessed as verified', !EV.hasEvidence(evidence, 999999));
  ok('B8 a null/garbage evidence map degrades to the caller\'s own count', EV.evidenceCount(null, 7001, 3) === 3);
}
{
  ok('B9 the heal SQL only ever RAISES a count', /GREATEST/.test(EV.HEAL_SQL) && !/LEAST/.test(EV.HEAL_SQL));
  ok('B10 the heal SQL is scoped to the file', /application_id = \$1/.test(EV.HEAL_SQL));
}

// ===========================================================================
// C. THE RISK ENGINE
// ===========================================================================
const ROLLUP = rollupMod.computeRollup({
  links: LINKS,
  draws: [DRAW],
  requests: REQUESTS,
  findingLines: FINDING_LINES,
  nameByKey: { 'cat:roof': 'Roof' },
});
// the rollup the risk engine sees must EXCLUDE the pending draw from `drawn` (it measures the draw
// against the line as it stood before) — that is what computeRollup already does.
{
  const evidence = EV.buildEvidence({ requests: REQUESTS, findingLines: FINDING_LINES, media: [] });
  const withEv = risk.assessDraw({ draw: DRAW, requests: REQUESTS, links: LINKS, rollup: ROLLUP, opts: { evidence } });
  const noEv = risk.assessDraw({ draw: DRAW, requests: REQUESTS, links: LINKS, rollup: ROLLUP, opts: {} });
  eq('C1 with photos on file, NOT ONE roof line is flagged unverified',
    withEv.flags.filter((f) => f.code === 'no_inspection').length, 0);
  eq('C2 the same draw with no evidence anywhere still flags all four (the check still bites)',
    noEv.flags.filter((f) => f.code === 'no_inspection').length, 4);
  const fl = withEv.flags.find((f) => f.code === 'front_loading');
  ok('C3 the finished-trade note is still raised', !!fl);
  eq('C4 …but as a note, not a red flag, once the photos verify it', fl && fl.severity, 'low');
  ok('C5 …and it says the photos verify it', fl && /inspection photos on file verify it/.test(fl.message));
  const flNo = noEv.flags.find((f) => f.code === 'front_loading');
  eq('C6 unverified, the same pattern stays a real warning', flNo && flNo.severity, 'medium');
  ok('C7 a fully-photographed, in-budget draw raises no HIGH flag at all',
    !withEv.flags.some((f) => f.severity === 'high'));
}
{
  // a PHYSICAL-inspection file still suppresses the flag (the 2026-07-24 rule is untouched)
  const a = risk.assessDraw({ draw: DRAW, requests: REQUESTS, links: LINKS, rollup: ROLLUP, opts: { inspectionMethod: 'traditional' } });
  eq('C8 a physical-inspection file never flags missing Sitewire photos',
    a.flags.filter((f) => f.code === 'no_inspection').length, 0);
}

// ===========================================================================
// D. THE ROLLUP — an inspector-approved draw is committed, not still available
// ===========================================================================
{
  const roof = ROLLUP.lines.find((l) => l.sow_line_key === 'cat:roof');
  eq('D1 the roof line is budgeted $25,000', roof.budgeted, 2500000);
  eq('D2 nothing is RELEASED yet', roof.drawn, 0);
  eq('D3 the whole $25,000 is committed by the inspector\'s approval', roof.committed, 2500000);
  eq('D4 so nothing is still available on that line (it used to show the full $25,000)', roof.available, 0);
  eq('D5 the line reads 100% used', roof.pct_committed, 100);
  eq('D6 `remaining` KEEPS its released-only meaning for the risk engine', roof.remaining, 2500000);
  eq('D7 the project total is committed too', ROLLUP.project.committed, 2500000);
  eq('D7b the project budget is the whole $220,000', ROLLUP.project.budget, 22000000);
  eq('D8 and the project shows what is genuinely free — $195,000, not the whole budget', ROLLUP.project.available, 19500000);
  const d = ROLLUP.draws[0];
  eq('D9 the draw summary prints the inspector-approved amount', d.approved_cents, 2500000);
  eq('D10 …and keeps final approval separate', d.final_approved_cents, 0);
  eq('D11 per-unit cells commit too', roof.units.map((u) => u.available), [0, 0, 0, 0]);
}
{
  /* AMEND / DECLINE puts it all back.
     UPDATED 2026-08-07: this used to model a decline as "zero the APPROVED amounts and leave the
     request standing", which worked only while `committed` counted approvals alone. Under the
     owner's widened rule a draw is committed from the moment it is REQUESTED, so that fixture now
     describes a draw that is still open and still asking for the full $25,000 — and it is right
     that the money stays committed. A real decline removes the draw; a real amendment lowers what
     it asks for. Both are checked, which is what the assertion always meant. */
  const declined = rollupMod.computeRollup({
    links: LINKS, draws: [], findingLines: [], requests: [],
    nameByKey: { 'cat:roof': 'Roof' },
  });
  const roof = declined.lines.find((l) => l.sow_line_key === 'cat:roof');
  eq('D12 declining the draw returns the money to available', roof.available, 2500000);
  eq('D13 …and the line is back to 0% used', roof.pct_committed, 0);
  // Amended DOWN to $10,000: only the new ask is committed, the rest is free again. The inspector
  // has not re-inspected the amended line, so `approved_cents` is NULL (the production semantic for
  // "not answered" — the reconcile binds null, never 0; approval.inspectorApproved treats 0 as an
  // answered-$0). With no inspector figure the exposure falls back to the lowered request.
  const amended = rollupMod.computeRollup({
    links: LINKS, draws: [DRAW], findingLines: [],
    requests: REQUESTS.map((r, i) => ({ ...r, approved_cents: null, requested_cents: i === 0 ? 1000000 : 0 })),
    nameByKey: { 'cat:roof': 'Roof' },
  });
  const roofA = amended.lines.find((l) => l.sow_line_key === 'cat:roof');
  eq('D12b amending the draw down commits only the new amount', roofA.committed, 1000000);
  eq('D12c …and frees the difference', roofA.available, 1500000);
}
{
  /* THE INSPECTOR FIGURE COMES OFF THE DELIVERED FINDINGS WHEN THE REQUEST MIRROR HAS NOT CAUGHT UP
     (owner-reported 2026-08-10, 109 Chapel St draw #1). Budget $25,100; the borrower requested
     $8,250 and the inspector approved $7,700 — but the inspector's number is in the delivered
     findings, not yet in the request mirror (approved_cents NULL). committed/available must read the
     $7,700 the report headline reads, NOT the $8,250 requested — the whole amount was not approved. */
  const B = 2510000, REQ = 825000, INSP = 770000;
  const LINKS2 = [{ sow_line_key: 'cat:roof', sitewire_job_item_id: 900, name: 'Roof', budgeted_cents: B, state: 'active' }];
  const DRAW2 = { sitewire_draw_id: 9001, number: 1, status: 'pending_capital_partner', total_requested_cents: REQ, total_approved_cents: 0 };
  const REQ2 = [{ sitewire_draw_id: 9001, sitewire_job_item_id: 900, sitewire_request_id: 7001, requested_cents: REQ, approved_cents: null }];
  const FL2 = [{ sitewire_draw_id: 9001, sitewire_request_id: 7001, sow_line_key: 'cat:roof', requested_cents: REQ, approved_cents: INSP }];
  const roll = rollupMod.computeRollup({ links: LINKS2, draws: [DRAW2], requests: REQ2, findingLines: FL2, nameByKey: { 'cat:roof': 'Roof' } });
  const line = roll.lines.find((l) => l.sow_line_key === 'cat:roof');
  eq('D14 committed reads the inspector-approved $7,700, not the requested $8,250', line.committed, INSP);
  eq('D14b available = budget − inspector-approved', line.available, B - INSP);
  eq('D14c project committed too', roll.project.committed, INSP);
  eq('D14d project available too', roll.project.available, B - INSP);
  eq('D14e pct is measured against the approved amount', roll.project.pct_committed, Math.round((INSP / B) * 1000) / 10);
  // And a not-yet-inspected line (no request-mirror figure, no finding line) still falls back to the
  // request, so a live pre-inspection draw is never invisible.
  const REQ3 = [{ sitewire_draw_id: 9001, sitewire_job_item_id: 900, sitewire_request_id: 7002, requested_cents: REQ, approved_cents: null }];
  const roll2 = rollupMod.computeRollup({ links: LINKS2, draws: [DRAW2], requests: REQ3, findingLines: [], nameByKey: { 'cat:roof': 'Roof' } });
  eq('D14f a not-yet-inspected line still commits the request', roll2.lines.find((l) => l.sow_line_key === 'cat:roof').committed, REQ);
  /* D14g — the POSITIVE-ONLY findings fallback (adversarial-audit Finding 1). Before db/518,
     `draw_finding_lines.approved_cents` was NOT NULL DEFAULT 0 with NO backfill, so a legacy 0 there is
     ambiguous between "inspector denied it" and "the line was never answered". A findings-0 must NOT
     collapse an in-flight draw to $0 (that over-states available) — it falls back to the request mirror,
     exactly like a not-yet-inspected line. A recorded mirror-0, by contrast, is an honest denial and is
     honoured as $0 (the mirror is authoritative for 0). */
  const legacyFinding0 = [{ sitewire_draw_id: 9001, sitewire_request_id: 7001, sow_line_key: 'cat:roof', requested_cents: REQ, approved_cents: 0 }];
  const rollLegacy = rollupMod.computeRollup({ links: LINKS2, draws: [DRAW2], requests: REQ2, findingLines: legacyFinding0, nameByKey: { 'cat:roof': 'Roof' } });
  eq('D14g an ambiguous legacy findings-0 falls back to the request, never $0 exposure', rollLegacy.lines.find((l) => l.sow_line_key === 'cat:roof').committed, REQ);
  const mirrorDenied = [{ sitewire_draw_id: 9001, sitewire_job_item_id: 900, sitewire_request_id: 7001, requested_cents: REQ, approved_cents: 0 }];
  const rollDenied = rollupMod.computeRollup({ links: LINKS2, draws: [DRAW2], requests: mirrorDenied, findingLines: [], nameByKey: { 'cat:roof': 'Roof' } });
  eq('D14h a RECORDED mirror-0 is an honest denial — committed reads $0, not the request', rollDenied.lines.find((l) => l.sow_line_key === 'cat:roof').committed, 0);
  eq('D14i …and the denied money returns to available', rollDenied.lines.find((l) => l.sow_line_key === 'cat:roof').available, B);
}
{
  // a RELEASED draw is drawn, not merely committed
  const done = rollupMod.computeRollup({
    links: LINKS, draws: [{ ...DRAW, status: 'approved', total_approved_cents: 2500000 }],
    requests: REQUESTS, findingLines: FINDING_LINES, nameByKey: { 'cat:roof': 'Roof' },
  });
  const roof = done.lines.find((l) => l.sow_line_key === 'cat:roof');
  eq('D14 an approved draw counts as released', roof.drawn, 2500000);
  eq('D15 committed and released agree once the draw is approved', roof.committed, 2500000);
  eq('D16 available is still 0 (never double-counted)', roof.available, 0);
  eq('D16b the project frees only the untouched lines', done.project.available, 19500000);
}

// ===========================================================================
// E. THE REPORT — the inspected line finds its BUDGET line by the crosswalk key
// ===========================================================================
{
  const app = { loanNo: 'YSCAP258134591', address: '195-197 Parrish St', csz: 'Wilkes-Barre, PA 18702', borrowerName: 'David Schweitzer' };
  const section = {
    number: 1, status: 'pending', approval_stage: 'inspector_approved', approval_label: 'Inspector approved — awaiting our final approval',
    requested_cents: 2500000, approved_cents: 2500000, final_approved_cents: 0, not_approved_cents: 0,
    fee_cents: 29900, fee_projected: true, retainage_held_cents: 0, net_release_cents: 2470100, released: false,
    lines: FINDING_LINES.map((l) => ({ name: l.name, sow_line_key: l.sow_line_key, inspector_comments: 'Torch down roof installation complete.',
      requested_cents: l.requested_cents, approved_cents: l.approved_cents, not_approved_cents: 0, photos: [] })),
  };
  const buf = report.buildDrawReport({ app, rollup: ROLLUP, sections: [section], scope: 'draw', mode: 'staff' });
  const text = buf.toString('latin1');
  ok('E1 the report builds', Buffer.isBuffer(buf) && buf.slice(0, 5).toString('latin1') === '%PDF-');
  ok('E2 the headline says WHOSE approval this is, not a bare "approved"', text.includes('APPROVED BY THE INSPECTOR'));
  ok('E3 the headline number is $25,000, not $0', text.includes('$25,000'));
  ok('E4 the report names the final-approval step that is still outstanding', text.includes('Final approved'));
  ok('E5 the fee is shown as a deduction', text.includes('draw processing fee'));
  ok('E6 the netting is explained', /netted|deducted/i.test(text));
  ok('E7 the budget table offers "Available", not the pre-draw "Remaining"', text.includes('Available'));
  // THE RELEASE IS ITS OWN HEADLINE NUMBER (owner-directed 2026-08-03) — the one question everybody
  // opens the PDF to answer is what actually moves, so it sits beside the approval, not in a list.
  ok('E7a the hero picks out the release as its own figure', text.includes('TO BE RELEASED AFTER THIS DRAW'));
  ok('E7b …and prints the net amount', text.includes('$24,701'));
  ok('E7c …naming the deduction that produced the gap', /after the \$299 draw fee/.test(text));
  // The crosswalk join is the fix: the four "Unit N - Roof" lines roll into the one "Roof" budget
  // row, so they no longer dangle underneath the table as work drawn against nothing budgeted.
  const unitRows = (text.match(/Unit \d - Roof/g) || []).length;
  ok('E8 the per-unit lines no longer dangle under the budget table as unbudgeted rows', unitRows <= 4);
  ok('E9 the roof budget line is present', text.includes('Roof'));
}
{
  // the borrower copy must stay borrower-safe: no fee, no net, no capital-partner name
  const app = { loanNo: 'YSCAP258134591', address: '195-197 Parrish St', csz: 'Wilkes-Barre, PA 18702', borrowerName: 'David Schweitzer' };
  const section = {
    number: 1, status: 'pending', approval_stage: 'inspector_approved',
    requested_cents: 2500000, approved_cents: 2500000, final_approved_cents: 0, not_approved_cents: 0,
    fee_cents: 29900, net_release_cents: 2470100, retainage_held_cents: 0, released: false,
    lines: [{ name: 'Unit 1 - Roof', sow_line_key: 'cat:roof', inspector_comments: 'Fidelis signed off.', requested_cents: 625000, approved_cents: 625000, not_approved_cents: 0, photos: [] }],
  };
  const text = report.buildDrawReport({ app, rollup: ROLLUP, sections: [section], scope: 'draw', mode: 'borrower' }).toString('latin1');
  // Owner-directed 2026-08-03: the borrower SEES the draw processing fee — it is deducted from their
  // own approved amount and decides what wires. It is our project-wide fee INCOME that stays ours.
  ok('E10 the borrower copy shows the draw processing fee', /draw processing fee/i.test(text));
  ok('E10b …and the arithmetic that produces their wire', /\$25,000/.test(text) && /\$24,701/.test(text));
  ok('E10c …in words they can act on', /wired to you/i.test(text));
  ok('E10d the borrower hero picks out what they will actually receive', /TO BE RELEASED TO YOU/.test(text));
  ok('E10e …as its own number, not buried in a list', text.includes('$24,701'));
  ok('E11 the borrower copy never shows our fee income across the project',
    !/OUR DRAW FEES ON THIS PROJECT/i.test(text) && !/Charged so far/i.test(text) && !/Expected on draws/i.test(text));
  ok('E12 the borrower copy scrubs the capital-partner name', !text.includes('Fidelis'));
  ok('E13 the borrower is told this is the inspector\'s approval to accept', /inspector approved/i.test(text));
}

// ===========================================================================
// F. WHAT A BORROWER MAY AND MAY NOT SEE OF OUR ECONOMICS
// loadRollup folds our per-draw economics onto every draw, and the borrower rollup route decides
// what rides through. That decision is a hand-written destructure, so it is guarded from BOTH
// sides: a lender-only field must stay named in it, and the figures the borrower is entitled to
// must NOT be (owner-directed 2026-08-03: "yes add the released amount to the borrower screen too"
// — their PDF had shown the fee and the net for days while the screen still showed neither).
// ===========================================================================
{
  const fs = require('fs');
  // The borrower-safe strip is the ONE shared definition (borrower + TPO surfaces both call it), so
  // this guard reads that module — not the borrower ROUTE, which now just delegates to it.
  const src = fs.readFileSync(require('path').join(__dirname, '..', 'src', 'sitewire', 'borrower-safe-draws.js'), 'utf8');
  const stripped = (k) => new RegExp('\\{[^}]*\\b' + k + '\\b[^}]*\\.\\.\\.safe', 's').test(src);

  // (a) still secret. `fee_kind` describes OUR fee schedule (which inspection tier priced the
  // draw), and the rollup's `net_explanation` is the STAFF sentence — the borrower gets the
  // borrower-voiced one instead, built from the same single definition.
  const LENDER_ONLY = ['fee_kind', 'net_explanation'];
  eq('F1 every lender-only draw field is still stripped from the borrower rollup',
    LENDER_ONLY.filter((k) => !stripped(k)), []);
  ok('F2 our project fee income is deleted from the borrower rollup', /delete rollup\.fees/.test(src));

  // (b) deliberately VISIBLE. These are the borrower's own money — what was approved, what we
  // take, and what actually reaches them. Stripping one again would put the screen back at odds
  // with the PDF they can already download.
  const BORROWER_SEES = ['fee_cents', 'fee_projected', 'net_release_cents', 'retainage_held_cents', 'released', 'release_date'];
  eq('F3 the money the borrower is entitled to is NOT stripped',
    BORROWER_SEES.filter((k) => stripped(k)), []);

  // (c) the replacement sentence is the BORROWER wording, from the one definition — never the
  // staff one, which talks about the fee "becoming final when the release is recorded".
  ok('F4 the borrower gets the borrower-voiced explanation',
    /netExplanation\([^)]*\{\s*borrower:\s*true/.test(src));

  // and the money model really does produce these keys (neither list is stale)
  const m = APPROVAL.drawMoney({ draw: DRAW, requests: REQUESTS, findingLines: FINDING_LINES, feeCents: 29900 });
  ok('F5 the money model produces the fields both lists name',
    BORROWER_SEES.filter((k) => k in m).length >= 4);

  // (d) and the borrower wording itself never reads like our internal note
  const borrowerSentence = APPROVAL.netExplanation(m, { borrower: true });
  ok('F6 the borrower sentence says what is wired to them', /wired to you/.test(borrowerSentence));
  ok('F7 and carries none of the staff-only caveat', !/becomes final when the release is recorded/.test(borrowerSentence));
}

{
  // A draw whose money has actually gone out reads in the PAST tense, on both copies.
  const app = { loanNo: 'YSCAP258134591', address: '195-197 Parrish St', csz: 'Wilkes-Barre, PA 18702', borrowerName: 'David Schweitzer' };
  const done = {
    number: 1, status: 'approved', approval_stage: 'released', released: true, release_date: '2026-08-05',
    requested_cents: 2500000, approved_cents: 2500000, final_approved_cents: 2500000, not_approved_cents: 0,
    fee_cents: 29900, fee_projected: false, retainage_held_cents: 0, net_release_cents: 2470100,
    lines: [{ name: 'Unit 1 - Roof', sow_line_key: 'cat:roof', requested_cents: 625000, approved_cents: 625000, not_approved_cents: 0, photos: [] }],
  };
  const staff = report.buildDrawReport({ app, rollup: ROLLUP, sections: [done], scope: 'draw', mode: 'staff' }).toString('latin1');
  const bor = report.buildDrawReport({ app, rollup: ROLLUP, sections: [done], scope: 'draw', mode: 'borrower' }).toString('latin1');
  ok('E14 a released draw says RELEASED, not "to be released"', /RELEASED/.test(staff) && !/TO BE RELEASED/.test(staff));
  ok('E14b the borrower copy too', /RELEASED TO YOU/.test(bor) && !/TO BE RELEASED/.test(bor));
  ok('E14c and the projection caveat is gone once it is real', !/standard draw fee for this file/.test(staff));

  // A whole-project report has no hero, so it answers the same question in its own band.
  const proj = report.buildDrawReport({ app, rollup: ROLLUP, sections: [done], scope: 'project', mode: 'staff' }).toString('latin1');
  ok('E15 the whole-project report reports money released', /Money released/i.test(proj));
  ok('E15b …how much reached the borrower', /Released to the borrower so far/.test(proj) && proj.includes('$24,701'));
  const projB = report.buildDrawReport({ app, rollup: ROLLUP, sections: [done], scope: 'project', mode: 'borrower' }).toString('latin1');
  ok('E15c the borrower project report shows their releases but not our fee total',
    /Released to the borrower so far/.test(projB) && !/Draw fees netted out/.test(projB));
}

console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nAll ${pass} draw approval-ladder / inspection-evidence checks passed.`);
process.exit(fail ? 1 : 0);
