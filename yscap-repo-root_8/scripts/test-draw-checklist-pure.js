'use strict';
/**
 * WHAT'S LEFT ON THIS DRAW — the truth table (owner-directed 2026-08-09). No DB, no network.
 *
 * Everything the checklist shows already existed somewhere; the gap was that it only ever appeared
 * as a REFUSAL when somebody pressed Deliver. These assertions pin the three properties that make
 * the forward-facing version trustworthy:
 *
 *   1. A STEP THAT DOES NOT APPLY IS OMITTED, never shown as outstanding. A checklist that lists
 *      work nobody has to do teaches people to ignore it.
 *   2. UNKNOWN IS ITS OWN STATE — a fact PILOT cannot read is never quietly "done", and an
 *      unrecognised platform status stops masquerading as progress.
 *   3. IT DECIDES NOTHING. It is a description of the file; the real refusals stay where they are.
 */
const assert = require('assert');
const CL = require('../src/sitewire/draw-checklist');
const APPROVAL = require('../src/sitewire/approval');

let n = 0;
const ok = (cond, what) => { assert.ok(cond, what); n++; };
const eq = (a, b, what) => { assert.strictEqual(JSON.stringify(a), JSON.stringify(b), `${what} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); n++; };

const keys = (c) => c.steps.map((s) => s.key);
const stateOf = (c, key) => (c.steps.find((s) => s.key === key) || {}).state;

// ─────────────────────────────────────────────── A. a step that does not apply is omitted
{
  const c = CL.buildChecklist({});
  ok(!keys(c).includes('visit_scheduled'), 'A1 no on-site inspection → no "visit scheduled" step');
  ok(!keys(c).includes('lien_waivers'), 'A2 lien waivers off → no waiver step');
  ok(!keys(c).includes('operating_agreement'), 'A3 not a new-entity wire → no operating-agreement step');
  ok(!keys(c).includes('findings_reviewed'), 'A4 no inspection yet → nothing to review');
  ok(!keys(c).includes('investor_answered'), 'A5 nothing sent → no "investor answered" step');
}
{
  const c = CL.buildChecklist({ physicalInspection: true, lienWaiversRequired: true, newEntityWire: true, hasFindings: true, investorSentAt: new Date() });
  for (const k of ['visit_scheduled', 'lien_waivers', 'operating_agreement', 'findings_reviewed', 'investor_answered']) {
    ok(keys(c).includes(k), `A6 "${k}" appears once it applies`);
  }
}
{
  // A MANUAL delivery is handled outside PILOT — there is nothing for us to send or chase.
  const c = CL.buildChecklist({ fundingMode: 'manual', investorSentAt: new Date() });
  ok(!keys(c).includes('sent_to_investor'), 'A7 a manual delivery has no "send to the investor" step');
  ok(!keys(c).includes('investor_answered'), 'A8 …and nothing to chase either');
}

// ─────────────────────────────────────────────── B. unknown is its own state
{
  const c = CL.buildChecklist({ inspectionOrdered: null, reportReceived: null, wireFormPresent: null });
  eq(stateOf(c, 'inspection_ordered'), 'unknown', 'B1 a fact we cannot read is UNKNOWN, never "done"');
  eq(stateOf(c, 'report_received'), 'unknown', 'B2 …the same for the report');
  eq(stateOf(c, 'wire_form_signed'), 'unknown', 'B3 …and the wire form');
  ok(!c.complete, 'B4 a checklist with unknowns is never "complete"');
}
{
  const c = CL.buildChecklist({ inspectionOrdered: false });
  eq(stateOf(c, 'inspection_ordered'), 'waiting', 'B5 a known "no" is WAITING — a different thing from unknown');
}
// A step whose fact is shaped unexpectedly must not break the card.
{
  const c = CL.buildChecklist({ lienWaiversRequired: true, lienWaiversMissing: 'not an array' });
  ok(c.steps.length > 0, 'B6 a malformed fact still produces a card');
  ok(['waiting', 'unknown', 'done'].includes(stateOf(c, 'lien_waivers')), 'B7 …with a real state on the affected step');
}

// ─────────────────────────────────────────────── C. an unrecognised platform status says so
{
  const s = CL.statusInWords('some_state_we_do_not_model', null);
  eq(s.known, false, 'C1 a status outside the ladder is reported as unknown');
  ok(/some_state_we_do_not_model/.test(s.label), 'C2 …and the platform\'s OWN word is shown rather than guessed at');
  ok(/does not recognise/i.test(s.note || ''), 'C3 …with a note saying exactly that');
  ok(!/inspect/i.test(s.label), 'C4 it never reads as ordinary progress');
}
{
  const s = CL.statusInWords('approved', 'final_approved');
  eq(s.known, true, 'C5 a status we DO model reads normally');
  eq(s.label, APPROVAL.STAGE_TEXT.final_approved.staff, 'C6 …in the staff voice from the one vocabulary');
}
{
  const s = CL.statusInWords('', null);
  eq(s.known, false, 'C7 no status at all is unknown');
  ok(!/“”/.test(s.label), 'C8 …and does not print empty quotes at somebody');
}

// ─────────────────────────────────────────────── D. the ONE thing to do next
{
  const c = CL.buildChecklist({
    inspectionOrdered: true, reportReceived: true, hasFindings: true,
    findingsReviewedAt: null, findingsDeliveredAt: new Date(),
  });
  eq(c.nextUp.key, 'findings_reviewed', 'D1 the next step is the FIRST one not done, in order');
  eq(c.waitingOn, 'us', 'D2 …and it names who we are waiting on');
  ok(c.nextUp.action, 'D3 …and the one action that clears it');
  ok(c.outstanding.every((s) => s.state !== 'done'), 'D4 the outstanding list holds only what is outstanding');
  ok(c.steps.filter((s) => s.state === 'done').every((s) => !s.action && !s.who), 'D5 a finished step asks for nothing');
}
{
  const done = {
    inspectionOrdered: true, reportReceived: true, hasFindings: true,
    findingsReviewedAt: new Date(), findingsDeliveredAt: new Date(), borrowerAgreed: true,
    wireFormPresent: true, wireFormAccepted: true,
    fundingMode: 'investor_direct', investorSentAt: new Date(), investorAnswer: 'approved',
    finalApproved: true, releaseRecorded: true,
  };
  const c = CL.buildChecklist(done);
  eq(c.complete, true, 'D6 a finished draw reads as complete');
  eq(c.nextUp, null, 'D7 …with nothing next');
  eq(c.done, c.total, 'D8 …and every step done');
}

// ─────────────────────────────────────────────── E. the details a person actually needs
{
  const c = CL.buildChecklist({ hasFindings: true, findingStatus: 'disputed', findingsDeliveredAt: new Date() });
  ok(/pushed back/i.test((c.steps.find((s) => s.key === 'borrower_agreed') || {}).detail || ''),
    'E1 a dispute says so, rather than reading as "still waiting on the borrower"');
}
{
  const c = CL.buildChecklist({ wireFormPresent: true, wireFormAccepted: false, wireFormRejectedOnly: true });
  ok(/re-?sign/i.test((c.steps.find((s) => s.key === 'wire_form_accepted') || {}).detail || ''),
    'E2 a rejected wire form says the borrower must re-sign it');
}
{
  const c = CL.buildChecklist({ lienWaiversRequired: true, lienWaiversMissing: ['gc Acme Build (conditional)'] });
  ok(/Acme Build/.test((c.steps.find((s) => s.key === 'lien_waivers') || {}).detail || ''),
    'E3 an outstanding waiver is NAMED, so somebody can go and get it');
}
{
  const c = CL.buildChecklist({ fundingMode: 'investor_direct', investorSentAt: new Date(), investorAnswer: 'questioned', investorAnswerNote: 'one more roof photo' });
  ok(/roof photo/.test((c.steps.find((s) => s.key === 'investor_answered') || {}).detail || ''),
    'E4 the investor\'s own words are carried, not just "answered"');
}
{
  const c = CL.buildChecklist({ fundingMode: 'investor_direct', releaseRecorded: false });
  ok(/final approve/i.test((c.steps.find((s) => s.key === 'money_recorded') || {}).detail || ''),
    'E5 on an investor-released draw the money step says final approve records it');
}
{
  const c = CL.buildChecklist({ releaseRecorded: true, releaseHeld: true });
  ok(/held/i.test((c.steps.find((s) => s.key === 'money_recorded') || {}).detail || ''),
    'E6 a release held for lien waivers never reads as simply done');
}

// ─────────────────────────────────────────────── F. it decides nothing
ok(typeof CL.buildChecklist === 'function' && !/throw/.test(String(CL.buildChecklist).replace(/\/\/[^\n]*/g, '')),
  'F1 the builder never throws its own error — it describes, it does not refuse');
for (const bad of [undefined, null, {}, { hasFindings: 'yes' }]) {
  const c = CL.buildChecklist(bad);
  ok(Array.isArray(c.steps) && c.steps.length > 0, `F2 buildChecklist(${JSON.stringify(bad)}) still answers`);
}

// ─────────────────────────────────────────────── G. expected dates — and never a guess
{
  const now = Date.now(), D = (d) => new Date(now + d * 86400000);
  eq(CL.expectedDates({}, { inspection_sla_days: 5 }), { inspection: null, decision: null, release: null },
    'G1 no start date means no expected date — "expected" with nothing to count from is a guess');

  const pending = CL.expectedDates({ inspectionStartedAt: D(-2) }, { inspection_sla_days: 5 });
  eq(pending.inspection.actual, false, 'G2 a date still ahead is an ESTIMATE');
  eq(pending.inspection.late, false, 'G3 …and is not late yet');

  const late = CL.expectedDates({ inspectionStartedAt: D(-20) }, { inspection_sla_days: 5 });
  eq(late.inspection.late, true, 'G4 an estimate in the past is late');

  const settled = CL.expectedDates({ reportReceived: true, findingsCreatedAt: D(-3), inspectionStartedAt: D(-20) }, { inspection_sla_days: 5 });
  eq(settled.inspection.actual, true, 'G5 something that HAPPENED reports the real date, not the estimate');
  ok(!('late' in settled.inspection), 'G6 …and something that already happened can never be "late"');

  const released = CL.expectedDates({ releaseRecordedAt: D(-1), wireDueAt: D(-5) }, {});
  eq(released.release.actual, true, 'G7 a recorded release beats its own due date');

  // `wire_due_at` is what the overdue alert measures, so the expected date must agree with it.
  const due = CL.expectedDates({ wireDueAt: D(3), investorSentAt: D(-1) }, { investor_funding_sla_days: 3 });
  eq(due.release.date, new Date(now + 3 * 86400000).toISOString().slice(0, 10),
    'G8 the wire due date wins over the SLA estimate, so the date and the alert never disagree');

  // An SLA of 0 turns the estimate off entirely rather than predicting "today".
  eq(CL.expectedDates({ inspectionStartedAt: D(-2) }, { inspection_sla_days: 0 }).inspection, null,
    'G9 an SLA of 0 produces no estimate at all');
}

console.log(`test-draw-checklist-pure: all ${n} draw-checklist checks passed.`);
