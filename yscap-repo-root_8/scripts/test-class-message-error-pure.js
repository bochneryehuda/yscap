'use strict';
/**
 * Class Valuation post-order messaging — a SEND FAILURE surfaces the vendor's own
 * reason, exactly like a failed order. PURE: `../db` and `./client` are stubbed in
 * the require cache, so no database and no network are touched; revision-reasons and
 * order-build (which composes the reason) are the REAL modules.
 *
 * THE THING THIS FILE EXISTS TO PROVE (owner-directed, Task B): when a staffer types
 * a message / asks for a fix / disputes the value / cancels and it fails, the desk
 * must see the EXACT reason Class gave — not a bare "request_failed". So each of the
 * three write paths (note / requestRevision / requestCancel) must, on failure:
 *   (1) return the vendor's raw body on `vendor` and our reason on `detail`, the SAME
 *       shape the order-PLACE path returns (routes/class.js), so the screen renders
 *       both through the very same OrderFailure component; and
 *   (2) STORE the combined reason (orderBuild.describeOrderError — our message + the
 *       meaningful vendor text) on the row, so the file screen's own "why it didn't go
 *       through" line carries it too.
 */

const path = require('path');
const orderBuild = require('../src/class/order-build');

let pass = 0, fail = 0;
const ok = (c, l) => { if (c) { pass++; console.log('PASS ' + l); } else { fail++; console.error('FAIL ' + l); } };

// ---------------------------------------------------------------------------
// Stub the two modules that talk to the world, BEFORE messages.js is required.
// ---------------------------------------------------------------------------
const captured = [];           // every reason we STORE on a row (send_error / last_error)
const clientErr = { current: null };

const fakeDb = {
  query: async (sql, params) => {
    const s = String(sql);
    if (/INSERT INTO class_notes/i.test(s)) return { rows: [{ id: 101 }] };
    if (/INSERT INTO class_revisions/i.test(s)) return { rows: [{ id: 201 }] };
    // loadOrder — a real, accepted order (class_order_id present), so we reach the send.
    if (/SELECT \* FROM class_orders/i.test(s)) {
      return { rows: [{ id: 10, application_id: 'app-1', class_order_id: 'CLS-1' }] };
    }
    if (/UPDATE class_notes SET send_error/i.test(s)) { captured.push({ table: 'note', val: params[1] }); return {}; }
    if (/UPDATE class_revisions SET/i.test(s) && /last_error/i.test(s)) { captured.push({ table: 'rev', val: params[1] }); return {}; }
    return { rows: [] };
  },
};
const fakeClient = {
  configured: () => ({ enabled: true }),
  addNote: async () => { throw clientErr.current; },
  requestRevision: async () => { throw clientErr.current; },
  requestCancel: async () => { throw clientErr.current; },
};

const put = (rel, exports) => {
  const id = require.resolve(rel);
  require.cache[id] = { id, filename: id, loaded: true, exports };
};
put('../src/db', fakeDb);
put('../src/class/client', fakeClient);

const messages = require('../src/class/messages');

// A Class rejection the way the transport surfaces it: a thrown Error carrying the
// HTTP status and the vendor's raw body. This is the ASP.NET validation shape (the
// County rejection that started this work), read out by order-build.vendorErrorText.
function classError({ code } = {}) {
  const e = new Error('Class updateOrder failed: HTTP 400');
  if (code) e.code = code;
  e.status = 400;
  e.body = { errors: { '$.county': ['The County field is required.'] } };
  return e;
}
const VENDOR_TEXT = '$.county: The County field is required.';

async function run() {
  // ------------------------------------------------------------------
  console.log('\n--- note(): a failed message hands back the vendor body, not just a code ---');
  captured.length = 0;
  clientErr.current = classError();
  {
    const out = await messages.note(10, 'Square footage / bed / bath looks wrong', { staffId: 'u1' });
    ok(out.ok === false, 'the send is reported as failed');
    ok(out.error === 'send_failed', 'with the send_failed code (no vendor code to override it)');
    ok(out.id === 101, 'and the note row id, so the stored draft can be pointed at');
    ok(out.vendor && out.vendor.errors && out.vendor.errors['$.county'],
       "the vendor's RAW body rides back on `vendor` — the raw-details expander needs it");
    ok(out.detail === 'Class updateOrder failed: HTTP 400', 'our own reason is on `detail`, the order-place shape');
    const rec = captured.find((c) => c.table === 'note');
    ok(rec && rec.val === orderBuild.describeOrderError(clientErr.current),
       'and what we STORE on the note is the combined reason, not a bare message');
    ok(rec && rec.val.includes(VENDOR_TEXT),
       "so the file screen's 'why it didn't go through' line carries Class's own words");
  }

  // ------------------------------------------------------------------
  console.log('\n--- requestRevision(): a failed fix request does the same ---');
  captured.length = 0;
  clientErr.current = classError();
  {
    const out = await messages.requestRevision(10, {
      kind: 'revision',
      reasons: [{ reasonType: 'OrderDetailsPropertyAddress', reason: 'Square footage / bed / bath looks wrong' }],
      staffId: 'u1',
    });
    ok(out.ok === false && out.error === 'request_failed', 'failed, with request_failed (not a bare fallback)');
    ok(out.vendor && out.vendor.errors, 'the vendor body rides back');
    ok(out.detail === 'Class updateOrder failed: HTTP 400', 'our reason on detail');
    const rec = captured.find((c) => c.table === 'rev');
    ok(rec && rec.val.includes(VENDOR_TEXT), 'and the stored last_error carries the vendor text');
  }

  // ------------------------------------------------------------------
  console.log('\n--- requestCancel(): a failed cancellation does the same ---');
  captured.length = 0;
  clientErr.current = classError();
  {
    const out = await messages.requestCancel(10, {
      reasons: [{ reasonType: 'ClientRequestedCancellation', reason: 'wrong property' }],
      staffId: 'u1',
    });
    ok(out.ok === false && out.error === 'request_failed', 'failed, with request_failed');
    ok(out.vendor && out.vendor.errors, 'the vendor body rides back');
    const rec = captured.find((c) => c.table === 'rev');
    ok(rec && rec.val.includes(VENDOR_TEXT), 'and the stored last_error carries the vendor text');
  }

  // ------------------------------------------------------------------
  console.log('\n--- a transport code (e.g. the outbound switch) still wins the error code ---');
  captured.length = 0;
  clientErr.current = classError({ code: 'CLASS_OUTBOUND_DISABLED' });
  {
    const out = await messages.note(10, 'hello', { staffId: 'u1' });
    ok(out.error === 'CLASS_OUTBOUND_DISABLED', 'the vendor/transport code is preserved, not replaced by send_failed');
  }

  // ------------------------------------------------------------------
  console.log('\n--- a body-less failure degrades cleanly (vendor:null, reason still shown) ---');
  captured.length = 0;
  const bare = new Error('network is down');           // no .body, no .status
  clientErr.current = bare;
  {
    const out = await messages.note(10, 'hello', { staffId: 'u1' });
    ok(out.ok === false && out.vendor === null, 'no vendor body → vendor is null, never undefined');
    ok(out.detail === 'network is down', 'the plain reason still travels');
    const rec = captured.find((c) => c.table === 'note');
    ok(rec && rec.val === 'network is down', 'and the stored reason is our message when there is no body');
  }

  console.log(`\ntest-class-message-error-pure: ${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
}

run().catch((e) => { console.error(e); process.exit(1); });
