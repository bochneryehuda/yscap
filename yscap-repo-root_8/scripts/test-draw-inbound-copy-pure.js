'use strict';
/**
 * The wording for the internal "a new draw request came in" email.
 *
 * Owner-directed 2026-08-03: the staff draw notice must say whether the inspection is VIRTUAL or
 * PHYSICAL and — for an internal email — whether it NEEDS ACTION or runs automatically. The dollar
 * amount + budget breakdown ride the money block (tested in test-draw-email-pure.js); this covers
 * only the two words a reader sees first. Pure — no database, no network.
 */

const assert = require('assert');
const { inboundDrawCopy } = require('../src/sitewire/draw-inbound-copy');

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  ok  ' + msg); } else { fail++; console.log('  FAIL ' + msg); } };

console.log('\nA · VIRTUAL vs PHYSICAL — read off the resolved inspection method');
{
  const virtual = inboundDrawCopy({ platform: 'sitewire', method: 'virtual' });
  ok(/Virtual/.test(virtual.methodLabel), 'a virtual inspection is labelled virtual: ' + virtual.methodLabel);
  const physical = inboundDrawCopy({ platform: 'sitewire', method: 'traditional' });
  ok(/Physical/.test(physical.methodLabel), 'a traditional inspection is labelled physical: ' + physical.methodLabel);
  // A null/unknown method is not guessed into physical — the safe default is the automatic path.
  const unknown = inboundDrawCopy({ platform: 'sitewire', method: null });
  ok(/Virtual/.test(unknown.methodLabel), 'an unknown method reads as virtual, never physical');
}

console.log('\nB · ACTION NEEDED vs AUTOMATIC — the internal-email distinction the owner named');
{
  // Sitewire virtual → automatic, no task.
  const auto = inboundDrawCopy({ platform: 'sitewire', method: 'virtual' });
  ok(auto.actionNeeded === false, 'a Sitewire virtual draw needs NO action');
  ok(/automatic/i.test(auto.actionLabel) && /automatically/i.test(auto.nextStep), 'and it says so: ' + auto.actionLabel);

  // Physical (Trinity) → a task.
  const physical = inboundDrawCopy({ platform: 'sitewire', method: 'traditional' });
  ok(physical.actionNeeded === true, 'a physical inspection NEEDS action');
  ok(/Action needed/i.test(physical.actionLabel) && /on-site/i.test(physical.nextStep), 'and it points at the on-site inspection');

  // TrustPoint (Blue Lake) → a task, submitted vs not-yet-submitted.
  const tpSub = inboundDrawCopy({ platform: 'trustpoint', method: 'virtual', submitted: true });
  ok(tpSub.actionNeeded === true, 'a TrustPoint draw NEEDS action');
  ok(/task was opened/i.test(tpSub.nextStep), 'a submitted TrustPoint draw says the task WAS opened');
  const tpPending = inboundDrawCopy({ platform: 'trustpoint', method: 'virtual', submitted: false });
  ok(/task will open/i.test(tpPending.nextStep), 'a not-yet-submitted TrustPoint draw says the task WILL open');
}

console.log('\nC · never throws, always shaped');
{
  const empty = inboundDrawCopy();
  assert.ok(empty && typeof empty.methodLabel === 'string' && typeof empty.actionNeeded === 'boolean'
    && typeof empty.actionLabel === 'string' && typeof empty.nextStep === 'string', 'no-arg call returns a full shape');
  ok(empty.actionNeeded === false, 'with nothing known, the default is the automatic (no-action) path');
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
