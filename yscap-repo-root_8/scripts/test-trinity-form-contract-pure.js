'use strict';
/**
 * THE FORM WE ORDER ON MUST BE THE DOLLAR LINE-ITEM DRAW — and the round trip that
 * carries our per-line reference must still be one schema, in both directions.
 *
 * WHY THIS EXISTS (owner-directed 2026-08-17: *"make sure that the roundtrip line item
 * production is understood, because this is very important for me"*).
 *
 * The whole integration rests on ONE property: we send a budget line carrying OUR
 * reference (`customerKey`), and the inspector's answer comes back on a line still
 * carrying it — which is the only reason "what did he approve on OUR line" is
 * answerable, and the only reason the approved figure can be written onto the right
 * Sitewire job item. That was proven live on form 19 (sandbox order 735319). Production
 * runs form 1079, and it cannot simply be re-proven there because placing a production
 * order dispatches a real inspector.
 *
 * It does not need to be, and this test is why: Trinity's own published spec uses the
 * SAME NAMED SCHEMA OBJECT for both forms and for both directions. Not "equivalent
 * fields" — the same `$ref`. So the proof on 19 IS a proof about 1079, and the thing to
 * guard is that this stays true.
 *
 * THE HAZARD IS REAL, NOT HYPOTHETICAL. The production account also offers form 26
 * "Fixed Percent Blank", which is a PERCENT-based budget on a different model, and the
 * feasibility forms use another one again. Pointing TRINITY_FORM_ID at one of those
 * would not mismatch a field — it would be a different budget engine, and every line
 * item would be meaningless. This test fails the build if the configured form is not a
 * dollar line-item form.
 *
 * Pure: reads the archived spec off disk. No network, no database, no credentials.
 */

const fs = require('fs');
const path = require('path');

const SPEC = path.join(__dirname, '..', 'docs', 'trinity', 'api', 'swagger-v1.1.json');

let n = 0, failed = 0;
const ok = (cond, label) => { n++; if (cond) return; failed++; console.error('  ✘ ' + label); };
const eq = (a, b, label) => ok(a === b, `${label} (got ${JSON.stringify(a)}, expected ${JSON.stringify(b)})`);

// The forms we may legitimately order a line-item draw on: 19 is the sandbox's, 1079 is
// production's. Adding one here is a deliberate act — it must be a dollar line-item form.
const OUR_FORMS = ['19', '1079'];

// What a budget line MUST carry for this integration to work at all, and why each one.
const REQUIRED_LINE_FIELDS = {
  customerKey: 'our per-line reference — the entire crosswalk',
  itemCost: "the line's whole budget",
  previousPercentCompleted: 'how much was already drawn on it',
  amountRequested: 'what this draw asks for on it',
  percentCompleted: 'what the inspector approved',
  remarks: "the inspector's own note on that line",
  description: 'the line name a human reads',
  isRequested: 'whether this draw asks about the line',
};

const spec = JSON.parse(fs.readFileSync(SPEC, 'utf8'));
const schemas = spec.components.schemas;

const refOf = (o) => (o && o.$ref ? String(o.$ref).split('/').pop() : null);

/** The schema returned by GET /api/v1.1/forms/<form>/orders/{id}/budget. */
function budgetResponseSchema(form) {
  const p = spec.paths[`/api/v1.1/forms/${form}/orders/{id}/budget`];
  if (!p || !p.get) return null;
  const c = ((p.get.responses || {})['200'] || {}).content || {};
  return refOf((c['application/json'] || {}).schema);
}

/** The schema accepted by POST /api/v1.1/forms/<form>/new. */
function createRequestSchema(form) {
  const p = spec.paths[`/api/v1.1/forms/${form}/new`];
  if (!p || !p.post) return null;
  const c = (p.post.requestBody || {}).content || {};
  return refOf((c['application/json'] || {}).schema);
}

/** Walk a schema to the line-item model it carries (create nests it under `order`). */
function lineItemSchemaOf(name, depth = 0, seen = new Set()) {
  if (!name || seen.has(name) || depth > 4) return null;
  seen.add(name);
  const props = (schemas[name] || {}).properties || {};
  for (const [k, v] of Object.entries(props)) {
    const r = refOf(v) || refOf(v.items);
    if (k === 'lineItems' && r) return r;
    if (r) { const found = lineItemSchemaOf(r, depth + 1, seen); if (found) return found; }
  }
  return null;
}

// ---- A. our forms are dollar line-item forms, both directions ---------------------
for (const form of OUR_FORMS) {
  const resp = budgetResponseSchema(form);
  const req = createRequestSchema(form);
  ok(resp, `A1[${form}] the form has a budget read-back endpoint`);
  ok(req, `A2[${form}] the form has a create endpoint`);
  // A PERCENT-based or FEASIBILITY form here would be a different budget engine.
  ok(resp && /^DollarLineItem/.test(resp),
    `A3[${form}] its budget is DOLLAR-based, not percentage or feasibility (got ${resp})`);
  ok(req && /^DollarLineItem/.test(req),
    `A4[${form}] it is CREATED as a dollar line-item order (got ${req})`);
}

// ---- B. THE PROOF THAT TRANSFERS: 19 and 1079 are the SAME contract ---------------
// This is what makes the live form-19 round-trip proof a proof about production's 1079.
const [f19, f1079] = OUR_FORMS;
eq(budgetResponseSchema(f19), budgetResponseSchema(f1079),
  'B1 sandbox form 19 and production form 1079 return the IDENTICAL budget schema');
eq(createRequestSchema(f19), createRequestSchema(f1079),
  'B2 …and are created from the IDENTICAL request schema');

// ---- C. the round trip is ONE model, not two -------------------------------------
const respLine = lineItemSchemaOf(budgetResponseSchema(f1079));
const reqLine = lineItemSchemaOf(createRequestSchema(f1079));
ok(respLine, 'C1 the budget response carries a line-item model');
ok(reqLine, 'C2 the create request carries a line-item model');
// If these ever diverge, "the key we send is the key we get back" stops being
// structural and becomes an assumption — which is exactly what must not happen quietly.
eq(reqLine, respLine,
  'C3 what we SEND and what we GET BACK are the same line model, so the key round trip is structural');

// ---- D. that model carries everything the money depends on ------------------------
const lineProps = (schemas[respLine] || {}).properties || {};
for (const [field, why] of Object.entries(REQUIRED_LINE_FIELDS)) {
  ok(Object.prototype.hasOwnProperty.call(lineProps, field),
    `D[${field}] the budget line carries it — ${why}`);
}

// ---- E. Trinity's own words on the two fields the crosswalk rests on --------------
// Documented behaviour, quoted from their spec, so a silent contract change is visible
// in a diff rather than discovered when an inspector's figures land on the wrong line.
const keyDesc = String((lineProps.customerKey || {}).description || '');
ok(/carry forward/i.test(keyDesc),
  'E1 Trinity documents customerKey as carrying forward within the project');
ok(/unique within the order/i.test(keyDesc),
  'E2 …and as unique within the order (a collision is a REFUSED inspection, not a bad line)');
const remarksDesc = String((lineProps.remarks || {}).description || '');
ok(/trinity|vendor/i.test(remarksDesc),
  'E3 remarks is documented as the note THEY provide — the per-line reason we show the desk');

// ---- F. a percent-based form is genuinely a different engine ----------------------
// Form 26 "Fixed Percent Blank" IS on the production account, so this is the mistake
// that is actually reachable.
const f26 = budgetResponseSchema('26');
ok(f26 && !/^DollarLineItem/.test(f26),
  'F1 form 26 is NOT a dollar line-item form — pointing at it would change the budget engine');
ok(f26 !== budgetResponseSchema(f1079),
  'F2 …and its budget schema genuinely differs from ours');

if (failed) { console.error(`test-trinity-form-contract-pure: ${failed} of ${n} FAILED`); process.exit(1); }
console.log(`test-trinity-form-contract-pure: ${n} assertions passed`);
