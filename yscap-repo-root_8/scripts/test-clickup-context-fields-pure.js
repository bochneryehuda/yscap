/**
 * THE MAPPER CONTEXT CARRIES EVERY MAPPED FIELD — no hand-listed drift (owner-reported
 * 2026-08-11: "I changed the lender's name and pushed updates, but it didn't update in
 * ClickUp. It says that our system also doesn't have a lender name").
 *
 * ROOT CAUSE the owner hit: `orchestrator.loadPushContext` built `ctx.app` / `ctx.borrower`
 * as HAND-LISTED object literals. Every field added to `mapper.FIELD_MAP` had to ALSO be
 * remembered in those literals, and three times it was NOT:
 *   · lender          (the note buyer — made bidirectional 2026-07-20)
 *   · desired_rate    ("register mirrors the registered rate into Desired Rate")
 *   · actual_closing  (made bidirectional 2026-08-11)
 * A field missing from `ctx.app` reads as `undefined`, so buildTaskFields NEVER pushes it
 * to ClickUp AND the ClickUp compare table shows it as "—" (its "Two-way Neither" row) even
 * when `applications.<col>` holds a real value.
 *
 * The fix builds the context FROM the field map (appContextFromRow / borrowerContextFromRow),
 * so adding a field to FIELD_MAP is now enough. This test pins that invariant:
 *   A. every t:'a' / t:'b' FIELD_MAP column is carried into the context;
 *   B. the three columns that regressed are carried by name;
 *   C. end-to-end, buildTaskFields now PRODUCES the ClickUp custom-field write for
 *      lender / desired_rate / actual_closing when the file holds a value.
 *
 * No DB is touched.
 */
'use strict';

const orch = require('../src/clickup/orchestrator');
const mapper = require('../src/clickup/mapper');
const F = require('../src/clickup/fields');

let failures = 0;
const assert = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };

const BORROWER_COL_ALIAS = { email: 'b_email', fico: 'b_fico' };

// A row shaped like loadPushContext's SELECT: application columns un-aliased, the two
// borrower columns the query aliases (email -> b_email, fico -> b_fico), and a sentinel
// per column so a dropped field is visible.
const row = {};
for (const f of mapper.FIELD_MAP) {
  if (!f.col) continue;
  if (f.t === 'a') row[f.col] = `APP:${f.col}`;
  if (f.t === 'b') row[BORROWER_COL_ALIAS[f.col] || f.col] = `BOR:${f.col}`;
}
row.internal_status = 'processing';

const app = orch.appContextFromRow(row);
const bor = orch.borrowerContextFromRow(row);

// ---- A. every mapped column is carried -------------------------------------
for (const f of mapper.FIELD_MAP) {
  if (!f.col) continue;
  if (f.t === 'a') assert(app[f.col] === `APP:${f.col}`, `A ctx.app carries t:'a' column ${f.col}`);
  if (f.t === 'b') assert(bor[f.col] === `BOR:${f.col}`, `A ctx.borrower carries t:'b' column ${f.col}`);
}
assert(app.internal_status === 'processing', "A ctx.app carries the internal_status special");

// ---- B. the three that regressed, by name ----------------------------------
for (const col of ['lender', 'desired_rate', 'actual_closing']) {
  assert(app[col] === `APP:${col}`, `B ctx.app carries ${col} (was silently dropped — the reported bug)`);
}

// ---- C. buildTaskFields PRODUCES the ClickUp write for each ------------------
// Field ids come off FIELD_MAP so the test can never disagree with the map.
const lenderCu = mapper.FIELD_MAP.find((f) => f.col === 'lender').cu;
const desiredRateCu = mapper.FIELD_MAP.find((f) => f.col === 'desired_rate').cu;
const actualClosingCu = mapper.FIELD_MAP.find((f) => f.col === 'actual_closing').cu;

// A realistic file: lender is a free dropdown resolved against the live ClickUp options;
// desired_rate is push-only text; actual_closing is a date.
const app2 = orch.appContextFromRow({
  lender: 'EMCAP Financial',
  desired_rate: '9.750%',
  actual_closing: '2026-09-01',
  internal_status: 'processing',
});
const options = {
  [lenderCu]: [
    { id: 'opt-emcap', name: 'EMCAP Financial', orderindex: 0 },
    { id: 'opt-fidelis', name: 'Fidelis Investors LLC', orderindex: 1 },
  ],
};
const built = mapper.buildTaskFields({ app: app2, borrower: {} }, options);
const byId = new Map(built.customFields.map((c) => [c.id, c.value]));

assert(byId.get(lenderCu) === 'opt-emcap',
  `C the lender push resolves to the matching ClickUp option (got ${JSON.stringify(byId.get(lenderCu))})`);
assert(byId.get(desiredRateCu) === '9.750%',
  `C the desired_rate push carries the registered rate (got ${JSON.stringify(byId.get(desiredRateCu))})`);
const acVal = byId.get(actualClosingCu);
assert(acVal != null && Number.isFinite(Number(acVal)) && Number(acVal) > 0,
  `C the actual_closing push carries a ClickUp date epoch (got ${JSON.stringify(acVal)})`);

// A lender with NO matching ClickUp option is a safe no-op (never invents an option) —
// the pre-existing guarantee, unchanged.
const built2 = mapper.buildTaskFields(
  { app: orch.appContextFromRow({ lender: 'Zephyr Capital' }), borrower: {} }, options);
assert(!built2.customFields.some((c) => c.id === lenderCu),
  'C a lender ClickUp has no option for is safely skipped (never invented)');

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
process.exit(failures ? 1 : 0);
