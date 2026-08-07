'use strict';
/**
 * Class Valuation callbacks — the mapping and the version rule. PURE (no DB, no net).
 *
 * The one thing this file exists to prove: **their callback never says which UAD
 * version the order was placed on**, so the version must come from OUR record and,
 * when we do not have it, nothing version-specific may be guessed.
 */
const cb = require('../src/class/callbacks');

let pass = 0, fail = 0;
const ok = (c, l) => { if (c) { pass++; console.log('PASS ' + l); } else { fail++; console.error('FAIL ' + l); } };

// A real StatusChanged envelope, shaped exactly as their guide prints it (p.60).
const ENV = (eventName, data) => ({
  orderId: 8675309,
  referenceNumber: 'YSCAP258134591',
  eventName,
  sent: '2026-08-07T12:00:00Z',
  created: '2026-08-07T11:59:00Z',
  data,
});

// ---------------------------------------------------------------------------
console.log('\n--- THE VERSION IS OURS TO REMEMBER, NEVER THEIRS TO TELL US ---');
// Their documented payload for every event is orderId / referenceNumber / eventName /
// sent / created / data. If any of those ever carried a version this test should be
// revisited — but nothing may READ one out of the payload today.
const statusEvent = ENV('StatusChanged', { StatusName: 'Completed', Reason: 'Report delivered' });
ok(!('apiVersion' in statusEvent) && !('version' in statusEvent) && !('uad' in statusEvent),
   'their event envelope carries no version of any kind');

ok(cb.versionOf({ api_version: 'v1', uad: '2.6' }).known === true, 'a stored 2.6 order knows its version');
ok(cb.versionOf({ api_version: 'v2', uad: '3.6' }).uad === '3.6', 'a stored 3.6 order knows its version');
for (const row of [null, {}, { api_version: null }, { api_version: '' }, { api_version: 'v3' }, { api_version: 'nonsense' }]) {
  const v = cb.versionOf(row);
  ok(v.known === false && v.version === null,
     `an order with ${JSON.stringify(row && row.api_version)} recorded is UNKNOWN, never assumed`);
}
// This is the important negative: the CONFIGURED DEFAULT must not leak in. An order
// placed last month on 2.6 does not become a 3.6 order because the default moved.
process.env.CLASS_API_VERSION = 'v2';
delete require.cache[require.resolve('../src/config')];
ok(cb.versionOf({}).known === false,
   'the configured default never fills in a missing version — right most of the time is what makes the wrong answer invisible');
delete process.env.CLASS_API_VERSION;

// ---------------------------------------------------------------------------
console.log('\n--- a version-specific call is REFUSED when the version is unknown ---');
(async () => {
  const refused = await cb.refreshOrder({ id: 1, class_order_id: '123', api_version: null });
  ok(refused.ok === false && refused.reason === 'version_unknown',
     're-reading an order of unknown version refuses rather than picking a path');
  ok(/field names/.test(refused.message || ''),
     'and the refusal explains WHY, so nobody "fixes" it by defaulting');
  const noId = await cb.refreshOrder({ id: 1, class_order_id: null, api_version: 'v1' });
  ok(noId.ok === false && noId.reason === 'no_class_order_id', 'and an order with no vendor id refuses too');

  // ---------------------------------------------------------------------------
  console.log('\n--- the event mapping (identical on both versions — see the header) ---');
  const done = cb.changesFor('StatusChanged', ENV('StatusChanged', { StatusName: 'Completed', Reason: 'Report delivered', InvisionUrl: 'https://x/y' }));
  ok(done.status === 'completed', 'Completed becomes completed');
  ok(done.status_reason === 'Report delivered', 'their reason is kept — it is what a human reads');
  ok(done.invision_url === 'https://x/y', 'the link to their portal is kept');
  ok(cb.changesFor('StatusChanged', ENV('StatusChanged', { StatusName: 'OnHold' })).status === 'on_hold', 'OnHold');
  ok(cb.changesFor('StatusChanged', ENV('StatusChanged', { StatusName: 'Cancelled' })).status === 'cancelled', 'Cancelled');
  ok(cb.changesFor('StatusChanged', ENV('StatusChanged', { StatusName: 'Resume' })).status === 'in_process',
     'Resume is an EVENT, not a resting state — a resumed order is active again');
  ok(cb.changesFor('StatusChanged', ENV('StatusChanged', { statusName: 'Completed' })).status === 'completed',
     'a lower-cased StatusName is accepted too — a case difference must not strand the order on its old status');
  ok(cb.changesFor('StatusChanged', ENV('StatusChanged', { StatusName: 'Something New' })).status === undefined,
     'a status we do not recognise changes nothing rather than being forced into a bucket');

  const appt = cb.changesFor('SetAppointment', ENV('SetAppointment', { appointmentDate: '2026-08-20T15:00:00Z', dueDate: '2026-08-25T00:00:00Z' }));
  ok(appt.appointment_date === '2026-08-20T15:00:00.000Z' && appt.due_date === '2026-08-25T00:00:00.000Z',
     'an appointment carries both dates');
  ok(cb.changesFor('ClientDueDateChanged', ENV('ClientDueDateChanged', { DueDate: '2026-09-01T00:00:00Z' })).due_date
       === '2026-09-01T00:00:00.000Z', 'a due-date change lands');
  ok(cb.changesFor('SetAppointment', ENV('SetAppointment', { appointmentDate: 'not a date' })).appointment_date === null,
     'an unreadable date is dropped, never stored as 1970');

  const insp = cb.changesFor('InspectionCompleted', ENV('InspectionCompleted', { InspectedDate: '2026-08-21T14:00:00Z' }));
  ok(insp.inspected_at === '2026-08-21T14:00:00.000Z' && insp.status === 'inspected', 'an inspection sets the date and the state');

  const vend = cb.changesFor('AssignedToVendor', ENV('AssignedToVendor', { userEmail: 'a@b.c', firstName: 'Ann', lastName: 'Appraiser' }));
  ok(vend.status === 'assigned' && vend.assigned_vendor.email === 'a@b.c', 'the appraiser is recorded');

  ok(cb.changesFor('ClientFeeChanged', ENV('ClientFeeChanged', { NewAmountValue: 612.5 })).client_fee_cents === 61250,
     'their fee is stored in cents, so it can never drift on a float');
  ok(!!cb.changesFor('OrderPaid', ENV('OrderPaid', {})).paid_at, 'paid is stamped');
  ok(Object.keys(cb.changesFor('ScannerEvents', ENV('ScannerEvents', { scannerEvent: 'ScanStarted' }))).join() === 'last_event_at',
     'an event with nothing to apply still stamps that we heard from them, and changes nothing else');

  // ---------------------------------------------------------------------------
  console.log('\n--- attachments: both payload shapes their guide implies ---');
  const one = cb.attachmentsFrom(ENV('NewAttachments', { orderId: 1, name: 'PDR.pdf', contentType: 'application/pdf' }));
  ok(one.length === 1 && one[0].name === 'PDR.pdf', 'the single-object shape their NewAttachments table documents');
  const many = cb.attachmentsFrom(ENV('NewAttachments', [{ name: 'a.pdf' }, { name: 'b.xml' }]));
  ok(many.length === 2, 'and an ARRAY, which their NewNotes table documents for the same `data` key');
  ok(cb.attachmentsFrom(ENV('NewAttachments', {})).length === 0, 'a payload naming nothing yields nothing — never a blank row');

  // ---------------------------------------------------------------------------
  console.log('\n--- their documented event list is carried in full ---');
  for (const e of ['NewAttachments', 'StatusChanged', 'NewNotes', 'SetAppointment', 'ScannerEvents',
                   'DesktopEvents', 'AssignedToVendor', 'OrderPaid', 'CustomFieldsSet', 'ClientFeeChanged',
                   'PaymentLinkSentToBorrower', 'ClientDueDateChanged', 'AvmReport', 'AvmData', 'InspectionCompleted']) {
    ok(cb.EVENTS.includes(e), `their event "${e}" is known to us`);
  }

  console.log(`\ntest-class-callbacks-pure: ${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})();
