'use strict';
/**
 * WHICH TRINITY FORM WE ORDER — the rule, the fact behind it, and the wiring that carries it.
 *
 * Owner-directed 2026-08-24: *"Form 19 is only for the test environment. We need to change it for
 * the production environment … We should also have the option to change forms and order different
 * forms, but this should be the default and should give you a warning if you are trying to change.
 * By default, the system, by physical inspection, should order the real form, not the 19 form."*
 *
 * PURE — no database, no network. Two things are proven here that a behaviour test cannot:
 *
 *   1. THE FACT THE DEFAULT MOVE RESTS ON, read out of Trinity's OWN captured swagger rather than
 *      remembered: 19 and 1079 take the IDENTICAL request model, so moving the default changes the
 *      id in a URL and nothing else. If that ever stopped being true, every payload we build would
 *      be wrong on the production account and this is the only thing that would say so.
 *   2. THE WIRING, by SOURCE. The read-back trap is a query inside a best-effort catch: a
 *      `getBudget` that quietly went back to the global default would show up as results that stop
 *      arriving, weeks later, on files nobody is watching. A behaviour test proves the functions
 *      agree today; these assertions prove the production code still ASKS for the order's own form.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const FORM = require('../src/trinity/form');

let n = 0, failed = 0;
const ok = (cond, label) => { n++; if (cond) return; failed++; console.error('  ✘ ' + label); };
const eq = (a, b, label) => ok(a === b, `${label} (got ${JSON.stringify(a)}, expected ${JSON.stringify(b)})`);
const src = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
/* A CRASHING ASSERTION LOOKS EXACTLY LIKE A FAILING ONE and stops the battery where it
   stands, so every read of a value a mutation could make null goes through these. Two
   mutations below (allowing the budget review, dropping the not-on-account refusal) threw a
   TypeError on `problem.message` until they did — reporting a pass rate that meant nothing. */
const msg = (r) => String((r && r.problem && r.problem.message) || '');
const code = (r) => (r && r.problem && r.problem.code) || null;
/* Comments are stripped before every "must not appear" assertion: the code that moved the default
   necessarily NAMES the old form in its own explanation, and a guard that read comments would fail
   on the very change it protects and then get "fixed" by deleting the explanation. */
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

// ── A. THE FACT: same product, same schema, different id ────────────────────────────────────
{
  const swaggerPath = path.join(__dirname, '..', 'docs/trinity/api/swagger-v1.1.json');
  const sw = JSON.parse(fs.readFileSync(swaggerPath, 'utf8'));
  const modelOf = (formId) => {
    const p = sw.paths[`/api/v1.1/forms/${formId}/new`];
    const c = p && p.post && p.post.requestBody && p.post.requestBody.content;
    const ref = c && c['application/json'] && c['application/json'].schema && c['application/json'].schema.$ref;
    return ref ? ref.split('/').pop() : null;
  };
  const sandbox = modelOf(FORM.SANDBOX_DRAW_FORM_ID);
  const prod = modelOf(FORM.PRODUCTION_DRAW_FORM_ID);
  ok(sandbox != null, `A1 Trinity's swagger describes form ${FORM.SANDBOX_DRAW_FORM_ID}`);
  ok(prod != null, `A2 Trinity's swagger describes form ${FORM.PRODUCTION_DRAW_FORM_ID}`);
  eq(prod, sandbox, 'A3 the production form takes the SAME request model as the sandbox one');
  eq(prod, 'DollarLineItemDollarLineItemTotalBudgetedOrderModelProjectModel',
    'A4 …and it is the DOLLAR line-item draw (the only shape carrying itemCost + previousPercentCompleted)');

  // The family list is a claim about the swagger, so it is checked against the swagger.
  const family = Object.keys(sw.paths)
    .map((p) => (p.match(/^\/api\/v1\.1\/forms\/(\d+)\/new$/) || [])[1])
    .filter(Boolean)
    .filter((id) => modelOf(id) === prod)
    .map(Number).sort((a, b) => a - b);
  assert.deepStrictEqual(FORM.DOLLAR_LINE_ITEM_FORMS.slice().sort((a, b) => a - b), family);
  ok(true, `A5 DOLLAR_LINE_ITEM_FORMS is exactly what the swagger says (${family.join(', ')})`);
  ok(family.includes(FORM.BUDGET_REVIEW_FORM_ID),
    'A6 the budget review shares that schema — which is WHY it must be refused by name, not by shape');
}

// ── B. THE DEFAULT ──────────────────────────────────────────────────────────────────────────
{
  eq(FORM.PRODUCTION_DRAW_FORM_ID, 1079, 'B1 the production draw form is 1079');
  eq(FORM.SANDBOX_DRAW_FORM_ID, 19, 'B2 the sandbox draw form is 19');

  const cfgSrc = stripComments(src('src/config.js'));
  ok(/TRINITY_FORM_ID[^\n]*PRODUCTION_DRAW_FORM_ID/.test(cfgSrc),
    'B3 config defaults TRINITY_FORM_ID to the module’s production constant, not a retyped number');
  ok(!/TRINITY_FORM_ID\s*\|\|\s*'19'/.test(cfgSrc), 'B4 …and no longer defaults to the sandbox form');

  const clientSrc = stripComments(src('src/trinity/client.js'));
  ok(!/formId\(\)\s*\{[^}]*\|\|\s*19\s*;/.test(clientSrc),
    'B5 the client’s own fallback is no longer a hard-coded 19 either');
}

// ── C. chooseForm — the ordinary path is untouched ──────────────────────────────────────────
{
  const d = FORM.chooseForm(null, 1079);
  ok(d.ok && d.isDefault && d.formId === 1079 && d.warning == null && d.problem == null,
    'C1 nothing picked = the default, no warning, no confirmation');
  const same = FORM.chooseForm(1079, 1079, { products: [] });
  ok(same.ok && same.isDefault && same.warning == null,
    'C2 the default picked back is still the default — never a warning about no change');
  const blank = FORM.chooseForm('', 1079);
  ok(blank.ok && blank.isDefault, 'C3 a blank pick is the default');
  // The catalogue is never even consulted on the ordinary path — proven by passing a list that
  // would REFUSE the default if it were.
  const noCat = FORM.chooseForm(null, 1079, { products: [{ id: 3, name: 'Something else' }] });
  ok(noCat.ok && noCat.formId === 1079,
    'C4 the default is never checked against the catalogue — a plain order can never be blocked by an account list');
}

// ── D. chooseForm — a different form warns, and a wrong one refuses ─────────────────────────
{
  const products = [
    { id: 1079, name: 'General Purpose Line Item Draw PCR' },
    { id: 1081, name: 'Another Dollar Line Item Draw' },
    { id: 159, name: 'Budget Review' },
  ];
  const diff = FORM.chooseForm(1081, 1079, { products });
  ok(diff.ok, 'D1 a different form that IS on the account is allowed');
  ok(!diff.isDefault, 'D2 …and is reported as not the default');
  ok(diff.warning && /1081/.test(diff.warning) && /1079/.test(diff.warning),
    'D3 …with a warning naming BOTH the chosen form and the usual one');
  ok(/Another Dollar Line Item Draw/.test(diff.warning) && /General Purpose Line Item Draw PCR/.test(diff.warning),
    'D4 …and Trinity’s own product names, so nobody has to look a number up');
  ok(/PRODUCT/i.test(diff.warning) && /billed/i.test(diff.warning),
    'D5 …and says what a form actually IS, rather than just that it differs');

  const absent = FORM.chooseForm(2222, 1079, { products });
  ok(!absent.ok && code(absent) === 'not_on_account',
    'D6 a form NOT on the account is refused — the order would be refused by Trinity anyway');
  ok(/1079/.test(msg(absent)) && /1081/.test(msg(absent)),
    'D7 …and the refusal lists what the account DOES carry');

  const review = FORM.chooseForm(159, 1079, { products });
  ok(!review.ok && code(review) === 'budget_review',
    'D8 the budget review is refused from the draw door even though it IS on the account');
  ok(/Budget review section/i.test(msg(review)) && /scope of work/i.test(msg(review)),
    'D9 …naming its own door and the checks ordering it here would skip');

  for (const junk of ['abc', 0, -5, 1.5, {}, [], NaN, Infinity]) {
    const r = FORM.chooseForm(junk, 1079, { products });
    ok(r.ok ? r.isDefault : code(r) === 'not_a_form',
      `D10 junk (${JSON.stringify(junk)}) is either the default or a plain refusal — never an order on nonsense`);
  }
}

// ── E. an UNREADABLE catalogue never refuses ────────────────────────────────────────────────
{
  // "We could not read their list" is a different statement from "they do not sell it", and the
  // expensive direction here is refusing a form the account really does have.
  const r = FORM.chooseForm(1081, 1079, { products: [], catalogRead: false });
  ok(r.ok && r.warning, 'E1 an unreadable catalogue warns rather than refuses');
  const r2 = FORM.chooseForm(1081, 1079, { products: null });
  ok(r2.ok, 'E2 …and a null product list reads the same way');
  // …but the budget review is refused on its NAME, so an unreadable catalogue cannot smuggle it in.
  const r3 = FORM.chooseForm(159, 1079, { products: null });
  ok(!r3.ok && code(r3) === 'budget_review',
    'E3 the budget review is still refused when the catalogue cannot be read — it is refused by id, not by absence');
}

// ── F. formForRow — which form a READ-BACK must use ─────────────────────────────────────────
{
  eq(FORM.formForRow({ trinity_form_id: 19 }, 1079), 19,
    'F1 a record placed on 19 is read back at 19, whatever the default is now');
  eq(FORM.formForRow({ trinity_form_id: '19' }, 1079), 19, 'F2 …including when the driver hands it back as text');
  eq(FORM.formForRow({ trinity_form_id: null }, 1079), 1079, 'F3 an unplaced record uses the default');
  eq(FORM.formForRow({}, 1079), 1079, 'F4 …and so does a row that carries no such column at all');
  eq(FORM.formForRow(null, 1079), 1079, 'F5 …and a missing row never throws');
  eq(FORM.formForRow({ trinity_form_id: 'oops' }, 1079), 1079, 'F6 an unreadable stamp falls back rather than guessing');
  eq(FORM.formForRow({ trinity_form_id: 0 }, 1079), 1079, 'F7 a zero is not a form id');
  eq(FORM.formForRow({ trinity_form_id: null }, null), FORM.PRODUCTION_DRAW_FORM_ID,
    'F8 with no default readable at all it still answers the production form, never undefined');
}

// ── G. THE WIRING, by source ────────────────────────────────────────────────────────────────
{
  const clientSrc = src('src/trinity/client.js');
  ok(/async function getBudget\(id, form = null\)/.test(clientSrc),
    'G1 client.getBudget takes the order’s own form');
  ok(/async function getGroupedBudget\(id, form = null\)/.test(clientSrc),
    'G2 client.getGroupedBudget takes it too');
  ok(/\$\{P\}\/forms\/\$\{encodeURIComponent\(f\)\}\/orders\/\$\{encodeURIComponent\(id\)\}\/budget/.test(clientSrc),
    'G3 …and the budget URL is built from that form, not from formId()');

  const ingestSrc = src('src/trinity/ingest.js');
  ok(/client\.getBudget\(orderRow\.trinity_order_id,\s*FORM\.formForRow\(orderRow, client\.formId\(\)\)\)/.test(ingestSrc),
    'G4 readResults reads back on the ORDER’S recorded form (the results-stop-arriving trap)');

  const orderSrc = src('src/trinity/order.js');
  ok(/const formUsed = FORM\.formForRow\(o, client\.formId\(\)\)/.test(orderSrc),
    'G5 placeOrder resolves the form from the record, so a retry resumes on the same one');
  ok(/client\.createOrder\(payload, \{ form: formUsed \}\)/.test(orderSrc),
    'G6 …places on it');
  ok(/trinity_form_id=\$6/.test(orderSrc),
    'G7 …and records it in the SAME statement that records the order id — they can never disagree');
  ok(/verifyBudget\(appId, orderRowId, trinityOrderId, sentItems, formUsed\)/.test(orderSrc),
    'G8 the post-placement budget check reads back on it as well');
  ok(/client\.getBudget\(trinityOrderId, form\)/.test(orderSrc), 'G9 …by passing it through');

  const intakeSrc = src('src/trinity/intake.js');
  ok(/needsFormConfirm: true/.test(intakeSrc),
    'G10 the order door refuses an unconfirmed change of form rather than placing it');
  ok(/WHERE id = \$1 AND trinity_order_id IS NULL/.test(intakeSrc),
    'G11 …and a form is only ever stamped on a record nothing has been placed against');

  // The migration is the other half of the read-back trap. A column DEFAULT of 19 would stamp
  // every brand-new production record with the sandbox form at INSERT.
  const mig = src('db/628_trinity_order_records_its_form_id.sql');
  ok(/ALTER COLUMN trinity_form_id DROP DEFAULT/.test(mig), 'G12 the column carries NO default');
  ok(/SET DEFAULT 19/.test(mig) === false, 'G13 …and never sets one');
  ok(/AND trinity_order_id IS NOT NULL/.test(mig),
    'G14 the 19 backfill is scoped to orders actually PLACED — an unplaced record has no form');
}

console.log(`${failed ? '✗' : '✓'} test-trinity-production-form-pure: ${n - failed}/${n} checks passed`);
process.exit(failed ? 1 : 0);
