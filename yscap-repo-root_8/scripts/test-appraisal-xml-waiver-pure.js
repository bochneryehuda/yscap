'use strict';

/*
 * Pure test for the appraisal "no XML available" waiver's exception-type wiring.
 * The waiver route + sign-off gate need a DB (covered by the app's DB tests); this
 * pins the pieces that are pure: the new loan_exceptions type is registered with
 * the right reason codes and a request helper, so the register / admin decide box
 * render and validate it like every other type.
 */
const assert = require('assert');
const LE = require('../src/lib/loan-exceptions');

// The type exists and carries the right shape.
assert.ok(LE.isExceptionType('appraisal_xml_waiver'), 'appraisal_xml_waiver is a registered exception type');
const cfg = LE.typeConfig('appraisal_xml_waiver');
assert.strictEqual(cfg.label, 'Appraisal — no XML available', 'label');
assert.strictEqual(cfg.subject, 'file', 'file-level (not a co-borrower subject)');
assert.strictEqual(cfg.recordOnly, false, 'it is REQUESTED (needs admin approval), not record-only');

// Reason codes: the transfer reason is deliberately NOT here (it auto-waives with
// no exception); only the reasons that route to an approval are.
assert.ok(LE.isReasonCodeFor('appraisal_xml_waiver', 'appraiser_no_xml'), 'appraiser_no_xml is valid');
assert.ok(LE.isReasonCodeFor('appraisal_xml_waiver', 'desk_or_manual'), 'desk_or_manual is valid');
assert.ok(LE.isReasonCodeFor('appraisal_xml_waiver', 'other'), 'other is valid');
assert.ok(!LE.isReasonCodeFor('appraisal_xml_waiver', 'transferred_appraisal'),
  'transferred_appraisal is NOT an exception reason — it auto-waives without one');
assert.ok(!LE.isReasonCodeFor('appraisal_xml_waiver', 'nonsense'), 'a junk reason is rejected');

// A friendly label resolves for the review box.
assert.ok(LE.reasonLabelFor('appraisal_xml_waiver', 'desk_or_manual'), 'reason label resolves');

// The request helper is exported.
assert.strictEqual(typeof LE.requestAppraisalXmlWaiver, 'function', 'requestAppraisalXmlWaiver is exported');

console.log('appraisal-xml-waiver pure OK — exception type registered with correct reasons');
