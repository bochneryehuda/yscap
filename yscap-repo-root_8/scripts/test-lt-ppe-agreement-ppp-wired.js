#!/usr/bin/env node
'use strict';
/**
 * LT PPE — the agreement RUN asks the investor's prepayment layer. The capability existed; the caller
 * did not.
 *
 * THE DEFECT, MEASURED ON THE REAL BATTERY. `buildOursLeg` gained an optional `pppDescriptor` so the
 * gate could see a state prepayment-penalty prohibition (§2.40) — and `grep pppDescriptor` over `src/`
 * found the module and nothing else. The production run route built its leg without one, so the layer
 * was dark in the ONE place it is consumed. Through the route's wiring, **2 of the canonical 299
 * scenarios come back with the wrong eligibility, and one of them is the battery's OWN scenario flagged
 * `_ineligible` for "NJ Individual PPP prohibited"** — priced, on the gate that decides whether a sheet
 * may publish. That is the dangerous direction: we quote a loan the investor will not buy.
 *
 * It is the same shape as every other finding in this workstream — built, tested, and asked by nothing
 * — one layer above the module, which is precisely where a module's own unit test cannot see it.
 *
 * WHAT IS PROVEN HERE:
 *   1. the two wirings genuinely differ on the real battery, and the difference is exactly the PPP
 *      scenarios — measured, not asserted;
 *   2. the flipped scenarios decline with the REAL code, so the layer is doing the work rather than
 *      merely being present;
 *   3. a CONTROL: no OTHER scenario moves. A descriptor that declined everything would satisfy (1)
 *      while being far more wrong;
 *   4. the route passes the descriptor, and resolves it from the sheet's own investor;
 *   5. an investor with no registered program is a NO-OP, so this can never change a sheet nobody has
 *      encoded;
 *   6. and when the layer is NOT asked, the run SAYS SO — a green gate must never be able to hide
 *      "we did not look".
 *
 *   node scripts/test-lt-ppe-agreement-ppp-wired.js
 *   DATABASE_URL=… node scripts/test-lt-ppe-agreement-ppp-wired.js   (adds the investor round trip)
 *
 * LT-only. The pure half needs no database; the DB half skips politely without one.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const legs = require('../src/longterm/ppe/lp-agreement-legs');
const reg = require('../src/longterm/ppe/program-registry');
const { buildDeephavenGrid } = require('../src/longterm/ppe/deephaven-dscr-sheet');
const { gridToRateSheet } = require('../src/longterm/ppe/deephaven-grid');
const { rateSheetToProgram } = require('../src/longterm/ppe/ratesheet');
const settingsMod = require('../src/longterm/ppe/settings');
const { buildAgreementScenarios } = require('../src/longterm/ppe/agreement-scenarios');

let n = 0; let failures = 0;
const ok = (c, m) => { console.log(`${c ? '  ok  ' : ' FAIL '} ${m}`); n += 1; if (!c) failures += 1; };

const SHEET = rateSheetToProgram(gridToRateSheet(buildDeephavenGrid()), { code: 'DHVN_DSCR30' });
const VALUES = settingsMod.resolveAll().values;

// ---- 1) the measurement: the two wirings, over the whole canonical battery -----------------------
{
  const DESC = reg.programFor('Deephaven');
  ok(!!DESC, 'W0 the Deephaven investor resolves to a registered program');

  // EXACTLY the two constructions — the one the route used to build, and the one it builds now.
  const asItWas = legs.buildOursLeg(SHEET, VALUES, { factsFromLp: true });
  const asItIs = legs.buildOursLeg(SHEET, VALUES, { factsFromLp: true, pppDescriptor: DESC, onUnresolvedPpp: 'flag' });

  const battery = buildAgreementScenarios();
  const all = (battery && battery.scenarios) || [];
  ok(all.length > 200, `W1 the canonical battery is the real one (${all.length} scenarios)`);

  const flipped = [];
  let moved = 0;
  for (const sc of all) {
    const before = asItWas(sc);
    const after = asItIs(sc);
    if (before.eligible !== after.eligible) flipped.push({ sc, after });
    // A quote the sheet already declined, or one with no prohibition, must be untouched — including
    // its LADDER. A layer that quietly re-priced an agreeing scenario would be a far worse defect
    // than the one being fixed.
    if (before.eligible === after.eligible
        && JSON.stringify(before.ladder || []) !== JSON.stringify(after.ladder || [])) moved += 1;
  }

  ok(flipped.length > 0,
    `W2 REPRODUCED: the route's old wiring disagreed with the investor's own rules on ${flipped.length} scenario(s)`);
  ok(flipped.every((f) => f.after.eligible === false),
    'W3 …and every one of them moves in the SAFE direction — priced becomes declined, never the reverse');
  ok(flipped.every((f) => (f.after.declines || []).some((d) => /ppp_prohibited/.test(d.code || ''))),
    'W4 …declining with the REAL prepayment code, so the layer is working rather than merely present');
  ok(flipped.every((f) => (f.after.declines || []).some((d) => d.source === 'ppp_matrix')),
    'W5 …stamped as the PPP layer, so a report can tell it from a sheet rule');

  // THE CONTROL. Without it, a descriptor that declined every loan would satisfy every assertion above.
  ok(flipped.length < 5,
    `W6 CONTROL — only the prepayment scenarios move (${flipped.length} of ${all.length}), not the battery`);
  ok(moved === 0,
    'W7 CONTROL — no scenario that keeps its verdict has its LADDER re-priced by the layer being asked');

  // The battery's OWN marker: the scenario it declares ineligible must be the one that was wrong.
  const marker = flipped.find((f) => f.sc._ineligible === true);
  ok(!!marker,
    `W8 THE ONE THAT MATTERS: the battery's own INELIGIBLE-flagged scenario was being PRICED (${marker && marker.sc._label})`);
}

// ---- 2) it is OPT-IN, so it can never change an investor nobody has encoded ----------------------
{
  ok(reg.programFor('An Investor Nobody Registered') === null,
    'W9 an unregistered investor resolves to NO descriptor');
  const plain = legs.buildOursLeg(SHEET, VALUES, { factsFromLp: true, pppDescriptor: null });
  const bare = legs.buildOursLeg(SHEET, VALUES, { factsFromLp: true });
  const sc = { purpose: 'Purchase', value: 500000, loan: 350000, fico: 760, dscr: 1.25, state: 'NJ', prepayMonths: 60, borrowerType: 'Individual' };
  ok(JSON.stringify(plain(sc)) === JSON.stringify(bare(sc)),
    'W10 …and with no descriptor the leg is byte-for-byte what it always was');
}

// ---- 3) the ROUTE — it resolves the descriptor and it says when it could not ----------------------
{
  // A source guard, and it is the honest tool for this one: the route builds its leg after refusing an
  // unconfigured vendor, so no offline call can reach that line. The BEHAVIOUR it guards is measured
  // in section 1; this pins that the production caller uses it.
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/longterm/routes/ppe.js'), 'utf8');
  const noComments = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  ok(/buildOursLeg\([^)]*pppDescriptor/.test(noComments),
    'W11 the agreement run builds our leg WITH the prepayment descriptor');
  ok(/programRegistry\.programFor\(/.test(noComments),
    'W12 …resolved through the shared registry, never a second lookup');
  ok(/investorName/.test(noComments) && /sheet\.investor/.test(noComments),
    'W13 …from the sheet\'s OWN investor, so a run cannot reconcile against another investor\'s rules');

  // THE HONEST HALF. A run that did not ask must say so on its own answer.
  ok(/pppLayer/.test(noComments) && /asked: false/.test(noComments),
    'W14 the answer reports WHETHER the layer was asked — a green gate must not hide "we did not look"');
  ok(/no_registered_program/.test(noComments) && /investor_unknown/.test(noComments),
    'W15 …and distinguishes "this investor has no program" from "we could not read the investor"');

  // The two are different questions and a caller acts on them differently, which is why they are not
  // one flag.
  ok(noComments.indexOf('pppLayer,') > 0,
    'W16 …carried on the measurement itself, so a failed record still reports it');
}

// ---- 4) the investor really reaches the route — a real round trip --------------------------------
(async () => {
  if (!process.env.DATABASE_URL) {
    console.log('  --  skipped the investor round trip (no DATABASE_URL)');
  } else {
    const db = require('../src/db');
    const store = require('../src/longterm/ppe/store');
    const suffix = `pppwire${process.pid}`;
    try {
      const inv = await store.createInvestor(db, 'company', { code: `T${String(process.pid).slice(-4)}`, name: `Deephaven ${suffix}` });
      const prog = await store.createProgram(db, 'company', { investorId: inv.id, code: `P${suffix}`, name: 'DSCR 30yr' });
      const ver = await store.createRateSheetVersion(db, 'company', { programId: prog.id, versionNo: 1 });
      // A REAL grid, because `loadProgram` refuses a sheet with no base prices — and refusing it is
      // right (there is nothing to price), so the fixture has to be the state a run actually needs.
      await store.replaceBasePrices(db, 'company', ver.id, [
        { noteRateMilliPct: 7500, lockDays: 30, priceMilli: 100000 },
        { noteRateMilliPct: 7625, lockDays: 30, priceMilli: 100250 },
      ]);
      const sheet = await store.loadRateSheet(db, ver.id);
      ok(sheet && sheet.investor && sheet.investor.name === `Deephaven ${suffix}`,
        'W17 the sheet loader carries the INVESTOR — the only key into the program registry');
      // And the route's own reader surfaces it under the name the run reads.
      const routes = require('../src/longterm/routes/ppe');
      const loaded = await routes._internals.loadProgram('company', ver.id);
      ok(loaded && loaded.investorName === `Deephaven ${suffix}`,
        'W18 …and the route\'s loader hands it to the run as `investorName`');
      await db.query('DELETE FROM lt_ppe_investor WHERE id = $1', [inv.id]);
    } catch (e) {
      ok(false, `W17 the investor round trip: ${String((e && e.message) || e).slice(0, 200)}`);
    }
    try { await db.pool.end(); } catch (_) { /* the pool may already be closed */ }
  }

  console.log(`\n${failures ? `${failures} FAILED of ${n}` : `ok - lt ppe agreement ppp wired (${n} assertions)`}`);
  assert.strictEqual(failures, 0);
})();
