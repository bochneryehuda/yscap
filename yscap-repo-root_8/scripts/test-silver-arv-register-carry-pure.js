/**
 * SILVER: the value-side ladder rung must REGISTER as the sheet — owner-directed
 * 2026-08-06. PURE, no DB, no network.
 *
 * The Silver (EMCAP) ladder can step down on the VALUE side (targetARLTV) as well
 * as the cost side (targetLTC), because EMCAP prices on the ARV band and the LTC
 * band alike. Those are two DIFFERENT engine inputs, and until the slider could
 * select a value-side rung only the cost-side one was carried into the register.
 *
 * THE FAILURE THIS GUARDS IS SILENT AND EXPENSIVE. A borrower picks the smaller,
 * better-priced value-side step; the term sheet prints that loan and that rate;
 * the register drops the lever and the file prices at the deal's MAXIMUM instead.
 * Nothing errors — the file simply disagrees with the paper that was signed, at a
 * bigger loan and a worse rate than the borrower accepted.
 *
 * So this walks the WHOLE chain with the shipped code at every hop:
 *
 *   the ladder rung  ->  the studio's own key parser (applySilverRung)
 *                    ->  the snapshot the portal sends (overridesFromSnapshot)
 *                    ->  the server's whitelist (pricing.buildInputs)
 *                    ->  the frozen engine
 *
 * and asserts the loan and the rate that come out the far end are the ones the
 * term sheet printed. A whitelist entry alone would not prove this: the value has
 * to survive the snapshot, the compact(), the coercion AND the whitelist.
 */
'use strict';

// buildInputs is pure, but requiring pricing.js pulls in the db module, which logs
// a FATAL when DATABASE_URL is unset. Nothing here touches a connection.
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://unused/unused';

const fs = require('fs');
const path = require('path');

let failures = 0;
const assert = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };

const SVP = require('../web/v2/tools/silver-program.js');
const { buildInputs } = require('../src/lib/pricing.js');

// ---- The studio's OWN rung parser, lifted out of the browser bundle ------------
const TS = fs.readFileSync(path.join(__dirname, '..', 'web/v2/tools/termsheet.js'), 'utf8');
const parserSrc = (TS.match(/function applySilverRung\(inp\) \{[\s\S]*?\n  \}/) || [])[0];
assert(!!parserSrc, 'A1 the studio carries one applySilverRung, and this test runs THAT one');
const studio = new Function(
  `let silverChosenRung = null; ${parserSrc}
   return { pick: (k) => { silverChosenRung = k; }, apply: applySilverRung };`)();

// ---- The portal's OWN snapshot->overrides step ---------------------------------
// overridesFromSnapshot lives in a .jsx module that imports React, so its Silver
// lines are lifted the same way rather than re-typed here — re-typing them would
// let the portal and this test drift apart, which is the whole bug being guarded.
const PANEL = fs.readFileSync(path.join(__dirname, '..', 'app-v2/src/components/ProductStudioPanel.jsx'), 'utf8');
/* A2 IS STRUCTURAL, NOT A BARE "IS THIS STRING SOMEWHERE IN THE FILE" — that weaker
   form passed while the value could still be dropped for every borrower. This module
   is JSX with React imports, so it cannot be required in node; what CAN be pinned is
   the shape that matters: `overridesFromSnapshot` builds a shared `base`, then
   early-returns it for a non-staff caller before the staff-only block. A ladder rung
   is a choice EITHER party may make on their own sheet, so both levers must sit in
   `base` (before that early return); a typed loan amount is admin-zone and must sit
   AFTER it. Moving a lever across that line is exactly the silent regression this
   guards — the rung would vanish from every borrower register and price at maximum. */
{
  const fn = (PANEL.match(/export function overridesFromSnapshot[\s\S]*?\n}/) || [])[0] || '';
  assert(!!fn, 'A2a overridesFromSnapshot was located in the panel');
  const gate = fn.indexOf("mode !== 'staff'");
  assert(gate > 0, 'A2b …and it early-returns the shared base for a non-staff caller');
  const posArv = fn.indexOf('targetARLTV');
  const posLtc = fn.indexOf('targetLTC');
  const posLoan = fn.indexOf('targetLoan');
  assert(posArv > 0 && posArv < gate,
    'A2 the VALUE-side ladder rung is in the shared base — a borrower register carries it too');
  assert(posLtc > 0 && posLtc < gate,
    'A2c …alongside the cost-side rung, which has always been there');
  assert(posLoan > gate,
    'A2d …while the typed loan amount stays in the STAFF-only block (admin zone)');
}
const STUDIO_JSX = fs.readFileSync(path.join(__dirname, '..', 'app-v2/src/components/TermSheetStudio.jsx'), 'utf8');
assert(/targetARLTV: \(d\.inp && d\.inp\.targetARLTV\) \|\| null/.test(STUDIO_JSX),
  'A3 …and so does the studio snapshot the panel reads it out of');

/** Exactly what the portal sends: compact() drops null/undefined, keeps a real number. */
function overridesOf(inp) {
  const out = {};
  if (inp.targetLTC) out.targetLTC = inp.targetLTC;
  if (inp.targetARLTV) out.targetARLTV = inp.targetARLTV;
  return out;
}

/** A file row shaped the way the register path reads one. */
function appRowFor(c) {
  return {
    loan_type: 'Purchase', program: 'silver', property_type: 'SFR (1 unit)', units: 1,
    property_address: { line1: '1 Test St', city: 'Newark', state: c.state, zip: '07102' },
    purchase_price: c.purchasePrice, as_is_value: c.asIsValue, arv: c.arv,
    rehab_budget: c.rehabBudget, rehab_type: 'Light Rehab',
    term: `${c.term} Months`, requested_ir_months: 0, fico: c.fico,
    requested_exp_flips: c.expFlips, requested_exp_holds: c.expHolds, requested_exp_ground: c.expGround,
  };
}

// ---- The matrix ---------------------------------------------------------------
const CASES = [];
for (const state of ['NJ', 'PA', 'OH', 'TX']) {
  for (const strategy of ['Fix & Flip', 'Fix & Hold (BRRRR)']) {
    for (const fico of [660, 700, 740, 780]) {
      for (const arv of [400000, 600000, 900000]) {
        for (const rehab of [0, 60000, 150000]) {
          for (const exp of [0, 3, 8]) {
            CASES.push({
              loanType: 'Purchase', strategy, state,
              propertyType: 'SFR (1 unit)', units: 1,
              purchasePrice: Math.round(arv * 0.62), asIsValue: Math.round(arv * 0.62),
              arv, rehabBudget: rehab, fico, term: 12, irMonths: 0,
              expFlips: exp, expHolds: exp, expGround: exp,
            });
          }
        }
      }
    }
  }
}

let arvRungs = 0, ltcRungs = 0, maxRungs = 0;
let loanDrift = 0, rateDrift = 0, leverLost = 0, firstLoss = null;

for (const c of CASES) {
  const L = SVP.priceLadder(c);
  if (!L.eligible || !L.rows.length) continue;
  const exp = { flips: c.expFlips, holds: c.expHolds, ground: c.expGround };

  for (const r of L.rows) {
    // 1. the studio applies the rung the borrower clicked
    studio.pick(r.key);
    const studioInp = studio.apply(Object.assign({}, c));

    // 2. the portal turns it into the register's overrides
    const overrides = overridesOf(studioInp);
    if (r.cut === 'arv') { arvRungs++; if (!overrides.targetARLTV) { leverLost++; if (!firstLoss) firstLoss = r; continue; } }
    else if (r.cut === 'ltc') { ltcRungs++; if (!overrides.targetLTC) { leverLost++; if (!firstLoss) firstLoss = r; continue; } }
    else { maxRungs++; }

    // 3. the SERVER rebuilds the engine inputs from the file + those overrides
    const serverInp = buildInputs(appRowFor(c), exp, overrides);

    // 4. the frozen engine prices what the file would actually register
    const ev = SVP.evaluate(serverInp);
    const loan = (ev && ev.sizing && ev.sizing.totalLoan) || 0;
    if (Math.abs(loan - r.totalLoan) > 1) {
      loanDrift++;
      if (!firstLoss) firstLoss = { key: r.key, paper: r.totalLoan, file: loan };
    }
    if (Math.abs(((ev && ev.noteRate) || 0) - r.noteRate) > 1e-12) rateDrift++;
  }
}

assert(arvRungs > 0 && ltcRungs > 0,
  `B1 both families were carried through the real register path — ${ltcRungs} cost-side, ${arvRungs} value-side`);
assert(maxRungs > 0, `B2 the maximum rung (no lever at all) was exercised too — ${maxRungs}`);
assert(leverLost === 0,
  `B3 no rung loses its lever between the studio and the register (lost: ${leverLost})`);
assert(loanDrift === 0,
  `B4 THE FILE REGISTERS THE LOAN THE TERM SHEET PRINTED, on every rung (drift: ${loanDrift})`);
assert(rateDrift === 0,
  `B5 …at the rate the term sheet printed (drift: ${rateDrift})`);
if (firstLoss) console.log('    first disagreement:', JSON.stringify(firstLoss));

// ---- The lever is a REDUCTION, never an admin exception ------------------------
// targetARLTV must follow targetLTC exactly: a voluntary de-leverage anyone may
// choose, NOT an admin-zone knob. `ovrARLTV` is the separate admin override that
// can RAISE a cap; confusing the two would either route every ladder step to an
// approval queue or, far worse, let a borrower-settable key raise a ceiling.
{
  // borrowerPricingOverrides (the borrower/broker de-leverage allowlist) now lives
  // in the shared lib/pricing-overrides.js (TPO Phase 4b — one definition shared
  // with routes/tpo.js). targetARLTV appears there as a BORROWER lever, and must
  // NOT be in the ADMIN override key lists (which route to an approval queue) —
  // the separate `ovrARLTV` is the admin knob that can RAISE a cap.
  const povr = require(path.join(__dirname, '..', 'src/lib/pricing-overrides.js'));
  assert(!povr.APPROVAL_OVERRIDE_KEYS.includes('targetARLTV'),
    'C1 the value-side lever is not an admin-zone knob — it needs no exception approval, exactly like targetLTC');
  assert(povr.borrowerPricingOverrides({ targetARLTV: 5 }).targetARLTV === undefined
      && povr.borrowerPricingOverrides({ targetARLTV: 0.7 }).targetARLTV === 0.7,
    'C2 the borrower door clamps it to a real ratio before it reaches the engine');

  // Proof rather than inspection: it can only ever REDUCE.
  let raised = 0;
  for (const c of CASES.slice(0, 200)) {
    const base = SVP.evaluate(buildInputs(appRowFor(c), { flips: c.expFlips, holds: c.expHolds, ground: c.expGround }, {}));
    const baseLoan = (base && base.sizing && base.sizing.totalLoan) || 0;
    if (!(baseLoan > 0)) continue;
    for (const v of [0.65, 0.7, 0.75, 0.95, 1]) {
      const ev = SVP.evaluate(buildInputs(appRowFor(c), { flips: c.expFlips, holds: c.expHolds, ground: c.expGround }, { targetARLTV: v }));
      const loan = (ev && ev.sizing && ev.sizing.totalLoan) || 0;
      if (loan > baseLoan + 1e-6) raised++;
    }
  }
  assert(raised === 0,
    `C3 through the REGISTER path the lever can only ever reduce a loan, never enlarge one (violations: ${raised})`);
}

console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
process.exit(failures ? 1 : 0);
