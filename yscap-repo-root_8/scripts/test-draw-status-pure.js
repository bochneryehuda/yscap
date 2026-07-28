'use strict';
/**
 * Draw + inspection status vocabulary (owner-directed 2026-07-27). PURE — no DB, no network.
 *
 * The fixtures are the REAL service orders and draws read from TrustPoint's live API while
 * diagnosing the reported files, so this pins the wording against records that actually exist.
 */
const path = require('path');
const assert = require('assert');
const ds = require(path.join(__dirname, '..', 'src', 'lib', 'draw-status'));

// Every status TrustPoint's own OpenAPI spec enumerates — if they add one, the fallback must hold.
const SPEC_SERVICE = ['CREATED', 'PENDING', 'QUOTE_REQUESTED', 'QUOTE_PROVIDED', 'ORDERED',
  'READY_FOR_REVIEW', 'COMPLETED', 'CANCELLED', 'CANCEL_REQUESTED', 'ERROR'];
const SPEC_DRAW = ['DRAFT', 'IN_REVIEW', 'APPROVED', 'COMPLETED'];

function coversTheSpec() {
  for (const code of SPEC_SERVICE) {
    const s = ds.serviceStatus({ status: code });
    assert.ok(s.known, `${code} must be a known inspection status`);
    assert.ok(s.label && s.label !== code, `${code} must have a human label, got "${s.label}"`);
    assert.ok(s.meaning, `${code} must explain itself`);
    assert.ok(['neutral', 'gold', 'teal', 'positive', 'bad'].includes(s.tone), `${code} tone`);
    // A raw database value must never reach a screen.
    assert.ok(!/_/.test(s.label), `${code} label must not be a raw value: ${s.label}`);
  }
  for (const code of SPEC_DRAW) {
    const d = ds.drawStatus({ status: code });
    assert.ok(d.known && d.label && d.meaning, `${code} must be a known draw status`);
  }
  // Cancelled / failed are NOT stages of progress — drawing them on the track would imply the
  // work is advancing.
  for (const off of ['CANCELLED', 'CANCEL_REQUESTED', 'ERROR']) {
    assert.strictEqual(ds.serviceStatus({ status: off }).step, null, `${off} must sit off the track`);
  }
  // …and the real track is ordered.
  assert.ok(ds.serviceStatus({ status: 'ORDERED' }).step < ds.serviceStatus({ status: 'COMPLETED' }).step,
    'ordered must come before completed on the track');
  console.log('  ✓ all 10 inspection + 4 draw statuses have a human label, meaning and tone');
}

function realRecords() {
  // 825 Bishop St draw #2 — ordered, a visit booked, never completed. This is the inspection that
  // was only SCHEDULED when the borrower was wrongly told their money had been released.
  const booked = ds.serviceStatus({
    tp_service_order_id: '0368fbf7', service_type: 'INSPECTION', status: 'ORDERED',
    service_number: 'TR-INS-20260727-421J', inspector_allowance_rate: 20.19,
    ordered_at: '2026-07-27T14:05:54Z', scheduled_at: '2026-07-27T14:05:54Z', completed_at: null,
  });
  assert.strictEqual(booked.label, 'Visit scheduled', 'a booked visit says so');
  assert.ok(/2026-07-27/.test(booked.meaning), 'the meaning names the booked date');
  assert.strictEqual(booked.scheduledOn, '2026-07-27');
  assert.strictEqual(booked.progressPct, 20.19);
  assert.strictEqual(booked.number, 'TR-INS-20260727-421J');

  // ORDERED with NO date is a genuinely different state for whoever is chasing it.
  const unbooked = ds.serviceStatus({ status: 'ORDERED', scheduled_at: null });
  assert.ok(/awaiting a visit date/i.test(unbooked.label), `got "${unbooked.label}"`);
  assert.notStrictEqual(unbooked.label, booked.label, 'booked and unbooked must not read the same');

  // 105-107 N 10th St draw #2 — the inspection that completed, was revised, and completed again.
  const done = ds.serviceStatus({
    service_type: 'INSPECTION', status: 'COMPLETED', service_number: 'TR-INS-20260722-G1MP',
    inspector_allowance_rate: 23.66, completed_at: '2026-07-27T15:43:58Z',
  });
  assert.strictEqual(done.tone, 'positive');
  assert.strictEqual(done.completedOn, '2026-07-27');
  assert.strictEqual(done.progressPct, 23.66);
  console.log('  ✓ real records: a booked visit, an unbooked order and a completed inspection each read differently');
}

function moneyDiscipline() {
  // The wire DATE is the only proof money moved — `disbursed_amount` is a projection TrustPoint
  // fills in at submission, which is exactly what mis-fired the "$49,750 is on its way" email.
  const submitted = ds.drawStatus({ status: 'IN_REVIEW', disbursed_cents: 4975000, disbursed_at: null });
  assert.strictEqual(submitted.wiredOn, null, 'a projected amount must never read as wired');
  const wired = ds.drawStatus({ status: 'COMPLETED', disbursed_cents: 2075000, disbursed_at: '2026-07-21' });
  assert.strictEqual(wired.wiredOn, '2026-07-21');
  console.log('  ✓ money: only a real wire date reads as wired');
}

function headlineAndFallback() {
  const draw = { status: 'IN_REVIEW' };
  // A live inspection outranks a settled draw status — it is what anyone looking at the file wants.
  const h = ds.headline(draw, [{ status: 'COMPLETED' }, { status: 'ORDERED', scheduled_at: '2026-08-01' }]);
  assert.strictEqual(h.from, 'inspection');
  assert.ok(/Visit scheduled/.test(h.label), `got "${h.label}"`);
  // With nothing live, the draw speaks.
  assert.strictEqual(ds.headline(draw, [{ status: 'COMPLETED' }]).from, 'draw');
  assert.strictEqual(ds.headline(draw, []).from, 'draw');

  // An unknown status must degrade to something readable, never a blank chip.
  const nu = ds.serviceStatus({ status: 'SOME_NEW_STATE' });
  assert.strictEqual(nu.known, false);
  assert.strictEqual(nu.label, 'Some new state', `got "${nu.label}"`);
  assert.strictEqual(nu.step, null, 'an unknown status has no place on the track');
  // Absent / junk input must never throw — this renders inside a live panel.
  for (const junk of [null, undefined, {}, { status: '' }, { status: 123 }]) {
    assert.doesNotThrow(() => ds.serviceStatus(junk));
    assert.doesNotThrow(() => ds.drawStatus(junk));
  }
  assert.strictEqual(ds.serviceStatus({}).label, 'Not started');
  console.log('  ✓ headline picks the live inspection; unknown and junk statuses stay readable');
}

(function () {
  console.log('draw + inspection status vocabulary (pure)');
  coversTheSpec();
  realRecords();
  moneyDiscipline();
  headlineAndFallback();
  console.log('All draw-status tests passed.');
})();
