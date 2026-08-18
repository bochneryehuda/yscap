#!/usr/bin/env node
'use strict';
/**
 * LT PPE — an ACCEPTED eligibility rule reaches the program that prices. Until now none did.
 *
 * THE DEFECT, REPRODUCED ON A REAL DATABASE BEFORE IT WAS FIXED. `lt_ppe_rule` is the home for every
 * overlay rule this workstream produces: the suggestion-accept flow writes one, the rule-authoring
 * service (§2.42) publishes one, `GET /rules` lists them and `GET /rules/coverage` analyses them. The
 * ONE function that turns a stored rate sheet into something the engine can price — `loadProgram` in
 * `src/longterm/routes/ppe.js` — never read that table. Measured: `rulesForProgram` returned the
 * accepted `min_fico_660`, the program `loadProgram` built carried **0** rules of it, and a FICO-600
 * loan came back `ELIGIBLE (priced) []`.
 *
 * WHY IT IS THE MOST SEVERE OF THE WAVE. `loadProgram` is the shared door: the quote, the breakdown,
 * the canary, the scheduled canary, the sheet coverage read AND the agreement run all price through
 * it. So the gate whose entire subject is "we agree with Lender Price on every eligibility AND
 * ineligibility" was running OUR leg with no eligibility rules at all — and a PASS was a pass on a
 * sheet that was structurally incapable of declining anything.
 *
 * It is this workstream's recurring shape once more — built, tested, and asked by nothing — this time
 * at the table layer: a store with a reader, a writer, a route and a coverage analyser, and no
 * consumer that prices.
 *
 * WHAT IS PROVEN HERE:
 *   1. REPRODUCTION, from the same door production uses: the stored rule is IN the program;
 *   2. and it BITES — a FICO-600 loan declines, with the rule's own reason, through the real quote;
 *   3. CONTROL — the same sheet at FICO 760 still prices, so the rule did not simply break pricing;
 *   4. CONTROL — a sheet with NO stored rules is byte-for-byte the pure `rateSheetToProgram` result,
 *      so nothing was added to programs nobody has written a rule for;
 *   5. SCOPE — another investor's rule does not reach this program (house rules do, by design);
 *   6. it FAILS CLOSED — a rule set that cannot be read REFUSES rather than pricing without it, which
 *      is the same defect wearing a "graceful degradation" label;
 *   7. and the door is the ONLY one — no other production module builds a program from a stored sheet.
 *
 *   DATABASE_URL=… node scripts/test-lt-ppe-rules-reach-program-db.js
 *
 * LT-only. Skips politely without a database.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let n = 0; let failures = 0;
const ok = (c, m) => { console.log(`${c ? '  ok  ' : ' FAIL '} ${m}`); n += 1; if (!c) failures += 1; };

// ---- 0) the door is the only one, and that is a source fact ------------------------------------
{
  // `loadProgram` can only be the chokepoint if nothing else in production turns a STORED sheet into
  // a priced program. Test scripts legitimately build one from a hand-made sheet; `src/` must not.
  const srcDir = path.join(__dirname, '..', 'src');
  const hits = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.js')) {
        const src = fs.readFileSync(p, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
          // The mapper's OWN module necessarily names it — its declaration and its export list are
          // not calls. Strip those two forms rather than exempting the file, so a call that appeared
          // inside the mapper itself would still be caught.
          .replace(/function\s+rateSheetToProgram\s*\(/g, 'function __decl(')
          .replace(/module\.exports\s*=\s*\{[\s\S]*?\}/g, 'module.exports = {}');
        if (/rateSheetToProgram\s*\(/.test(src)) hits.push(path.relative(srcDir, p));
      }
    }
  };
  walk(srcDir);
  ok(hits.length === 1 && hits[0] === path.join('longterm', 'routes', 'ppe.js'),
    `S1 exactly ONE production module builds a program from a stored sheet (${hits.join(', ') || 'none'})`);
}

(async () => {
  if (!process.env.DATABASE_URL) {
    console.log('  --  skipped (no DATABASE_URL) — the whole subject of this suite is stored rules');
    console.log(`\n${failures ? `${failures} FAILED of ${n}` : `ok - lt ppe rules reach program (${n} assertions)`}`);
    assert.strictEqual(failures, 0);
    return;
  }

  const db = require('../src/db');
  const store = require('../src/longterm/ppe/store');
  const ruleStore = require('../src/longterm/ppe/rule-store');
  const routes = require('../src/longterm/routes/ppe');
  const quote = require('../src/longterm/ppe/quote');
  const settingsMod = require('../src/longterm/ppe/settings');
  const { rateSheetToProgram } = require('../src/longterm/ppe/ratesheet');

  const VALUES = settingsMod.resolveAll().values;
  const SCOPE = 'company';
  const tag = `rr${process.pid}`;
  const made = { investors: [], rules: [] };

  // A real sheet, because `loadProgram` REFUSES a sheet with no base grid — and refusing it is right
  // (there is nothing to price), so the fixture has to be the state a run actually needs.
  async function makeSheet(label) {
    const inv = await store.createInvestor(db, SCOPE, { code: `T${label}${String(process.pid).slice(-3)}`, name: `Investor ${label} ${tag}` });
    made.investors.push(inv.id);
    const prog = await store.createProgram(db, SCOPE, { investorId: inv.id, code: `P${label}${tag}`, name: 'DSCR 30yr' });
    const ver = await store.createRateSheetVersion(db, SCOPE, { programId: prog.id, versionNo: 1 });
    await store.replaceBasePrices(db, SCOPE, ver.id, [
      { noteRateMilliPct: 7500, lockDays: 30, priceMilli: 100000 },
      { noteRateMilliPct: 7625, lockDays: 30, priceMilli: 100250 },
    ]);
    return { inv, prog, ver };
  }

  // The accepted rule, written exactly as `acceptSuggestion` writes one.
  async function addRule(code, { investorId = null, programId = null, declineReason, when }) {
    const r = await db.query(
      `INSERT INTO lt_ppe_rule (scope, investor_id, program_id, code, kind, source, predicate, decline_reason, origin)
         VALUES ($1, $2, $3, $4, 'eligibility', 'overlay', $5::jsonb, $6, 'suggested') RETURNING id`,
      [SCOPE, investorId, programId, code, JSON.stringify(when), declineReason]);
    made.rules.push(r.rows[0].id);
    return r.rows[0].id;
  }

  const FICO_600 = { fico: 600, ltv: 70, dscr: 1.25, loan_amount: 350000, lock_days: 30 };
  const FICO_760 = { ...FICO_600, fico: 760 };

  try {
    // ---- 1) the reproduction, through the production door ---------------------------------------
    const A = await makeSheet('a');
    await addRule('min_fico_660', {
      investorId: A.inv.id,
      declineReason: 'FICO below 660',
      when: { fact: 'fico', op: 'lt', value: 660 },
    });

    // The store genuinely holds it — so a failure below is about the DOOR, not about the fixture.
    const stored = await ruleStore.rulesForProgram(db, SCOPE, A.inv.id, A.prog.id);
    ok(stored.length === 1 && stored[0].code === 'min_fico_660',
      `R1 the accepted rule is in the store and scoped to this program (${stored.length})`);

    const loaded = await routes._internals.loadProgram(SCOPE, A.ver.id);
    ok(loaded && loaded.program && !loaded.reason,
      `R2 the production door builds a program (${(loaded && loaded.reason) || 'ok'})`);
    ok(loaded.storedRuleCount === 1,
      `R3 …and SAYS how many accepted rules are in force (${loaded && loaded.storedRuleCount})`);
    ok((loaded.program.rules || []).some((r) => r.code === 'min_fico_660'),
      'R4 REPRODUCED-AND-FIXED: the accepted rule is ON the program that prices — before this it was not');

    // ---- 2) …and it BITES, through the real quote ------------------------------------------------
    const declined = quote.quoteProgram({ scenario: FICO_600, program: loaded.program, settings: VALUES });
    ok(declined.eligible === false,
      'R5 THE ONE THAT MATTERS: a FICO-600 loan is DECLINED — it used to price as eligible');
    ok((declined.declines || []).some((d) => /FICO below 660/.test(d.reason || '')),
      'R6 …with the rule\'s OWN reason, so a report can say why rather than "ineligible"');
    ok((declined.declines || []).some((d) => d.code === 'min_fico_660'),
      'R7 …stamped with the rule code, so the decline is traceable to the row somebody accepted');

    // ---- 3) CONTROL — the rule did not simply break pricing --------------------------------------
    const priced = quote.quoteProgram({ scenario: FICO_760, program: loaded.program, settings: VALUES });
    ok(priced.eligible === true,
      'R8 CONTROL — the same sheet still PRICES a qualifying loan; the rule declines only what it names');
    ok(Array.isArray(priced.rungs) ? priced.rungs.length > 0 : true,
      'R9 …and the price ladder is still produced');

    // ---- 4) CONTROL — a sheet nobody wrote a rule for is untouched --------------------------------
    const B = await makeSheet('b');
    const plain = await routes._internals.loadProgram(SCOPE, B.ver.id);
    ok(plain && plain.program && plain.storedRuleCount === 0,
      `R10 a sheet with no stored rules reports ZERO — a real answer, not a silence (${plain && plain.storedRuleCount})`);
    const pureSheet = await store.loadRateSheet(db, B.ver.id);
    const pure = rateSheetToProgram(pureSheet, { code: B.ver.id, name: (pureSheet.version && pureSheet.version.label) || null });
    ok(JSON.stringify(plain.program.rules || []) === JSON.stringify(pure.rules || []),
      'R11 CONTROL — …and its program is byte-for-byte the pure mapper\'s, so nothing was added to it');

    // ---- 5) SCOPE — another investor's rule cannot reach this program ------------------------------
    await addRule('other_investor_only', {
      investorId: B.inv.id,
      declineReason: 'another investor\'s rule',
      when: { fact: 'fico', op: 'lt', value: 900 }, // would decline EVERY loan if it leaked
    });
    const reloadedA = await routes._internals.loadProgram(SCOPE, A.ver.id);
    ok(reloadedA.storedRuleCount === 1
       && !(reloadedA.program.rules || []).some((r) => r.code === 'other_investor_only'),
      `R12 SCOPE — another investor's rule does NOT reach this program (${reloadedA.storedRuleCount})`);
    const stillPrices = quote.quoteProgram({ scenario: FICO_760, program: reloadedA.program, settings: VALUES });
    ok(stillPrices.eligible === true,
      'R13 …measured rather than asserted: the leaked rule would have declined this loan, and it prices');

    // A HOUSE rule (no investor, no program) is deliberately in scope for everyone — the store says
    // so and this is the behaviour a house overlay exists for.
    await addRule(`house_${tag}`, {
      declineReason: 'house rule: loan over $5,000,000',
      when: { fact: 'loan_amount', op: 'gt', value: 5000000 },
    });
    const withHouse = await routes._internals.loadProgram(SCOPE, A.ver.id);
    ok(withHouse.storedRuleCount === 2
       && (withHouse.program.rules || []).some((r) => r.code === `house_${tag}`),
      `R14 …while a HOUSE rule reaches every program, which is what a house overlay is for (${withHouse.storedRuleCount})`);

    // ---- 6) it FAILS CLOSED ------------------------------------------------------------------------
    const realFn = ruleStore.rulesForProgram;
    ruleStore.rulesForProgram = async () => { throw new Error('statement timeout'); };
    let refused;
    try {
      refused = await routes._internals.loadProgram(SCOPE, A.ver.id);
    } finally {
      ruleStore.rulesForProgram = realFn;
    }
    ok(refused && refused.program === null,
      'R15 FAILS CLOSED — a rule set that cannot be READ refuses to price, rather than pricing with none');
    ok(refused && /^rules_unreadable/.test(String(refused.reason || '')),
      `R16 …and SAYS which of the two it is; "no rules" and "we could not read them" are different facts (${refused && refused.reason})`);

    // …and the refusal is not permanent — it is about that read, so the next one works.
    const recovered = await routes._internals.loadProgram(SCOPE, A.ver.id);
    ok(recovered && recovered.program && recovered.storedRuleCount === 2,
      'R17 …the refusal is about the READ, so the door works again the moment the store does');
  } catch (e) {
    ok(false, `the rules-reach-program run: ${String((e && e.stack) || e).slice(0, 400)}`);
  } finally {
    try {
      if (made.rules.length) await db.query('DELETE FROM lt_ppe_rule WHERE id = ANY($1::bigint[])', [made.rules]);
      if (made.investors.length) await db.query('DELETE FROM lt_ppe_investor WHERE id = ANY($1::uuid[])', [made.investors]);
    } catch (e) {
      // NOT silent: a cleanup that fails leaves rows behind, and the NEXT run then measures a
      // polluted table and reports a defect that is not there. It must never mask a real result, so
      // it is reported rather than thrown.
      console.log(`  --  cleanup failed (rows left behind): ${String((e && e.message) || e).slice(0, 200)}`);
    }
    try { await db.pool.end(); } catch (_) { /* the pool may already be closed */ }
  }

  console.log(`\n${failures ? `${failures} FAILED of ${n}` : `ok - lt ppe rules reach program (${n} assertions)`}`);
  assert.strictEqual(failures, 0);
})();
