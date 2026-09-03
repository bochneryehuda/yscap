'use strict';
/**
 * THE DSCR ON THE SCREEN IS CUT THE SAME WAY THE SEARCH IS.
 *
 * ── THE OWNER'S RULE ───────────────────────────────────────────────────────
 * 2026-08-30: *"The DSCR should always be rounded down, and the LTV should always
 * be rounded up, so we should never see better."*
 *
 * ── THE DEFECT THIS PINS ───────────────────────────────────────────────────
 * `src/longterm/pricing/tier-rounding.js` has cut a DSCR DOWN on the way to every
 * rate sheet since 2026-08-30. The browser's own calculator went on rounding to
 * NEAREST — so a loan computing 1.2451 was SHOWN as 1.25 and PRICED at 1.24, and
 * the officer read a DSCR band the loan had not earned off the very screen that
 * decides whether to send it.
 *
 * ── WHY THIS SUITE HAS TWO HALVES, AND THE SECOND IS THE IMPORTANT ONE ─────
 * A browser module cannot require server code, so `tierRounding.js` is a MIRROR,
 * and section A fails the moment the two copies disagree. But a mirror-agreement
 * check proves CONSISTENCY, never CORRECTNESS: two copies of one MISTAKE agree
 * perfectly, which is exactly how the feasibility-fee bridge defect passed for two
 * years (CLAUDE.md). So section B asserts THE RULE — a DSCR is never rounded up,
 * whatever the two copies happen to agree on — and section C runs the real
 * calculator, because neither of the first two can see whether it CALLS any of it.
 *
 * PURE: no database, no network, no bundler.
 */

const path = require('path');
const ROOT = path.join(__dirname, '..');
const server = require(path.join(ROOT, 'src/longterm/pricing/tier-rounding.js'));

let pass = 0; let fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  ok   ${m}`); } else { fail++; console.log(`  FAIL ${m}`); } };

/* A battery that deliberately includes the values floating point gets wrong:
   `1.15 * 100` is 114.99999999999999 and `0.7 * 100` is 70.00000000000001, so a
   plain floor/ceil moves a figure somebody typed exactly, by a whole cent, in the
   direction the rule exists to prevent going unnoticed. */
const BATTERY = [
  0, 1, 1.15, 0.7, 1.2449, 1.245, 1.2451, 1.25, 1.2499, 1.9999, 2, 0.001, 0.005,
  1.005, 1.0049, 99.995, 100, 0.33333333, 1.66666666, 3.14159265, 1.0000000001,
  -1.245, -0.7, 12345.678, 0.1 + 0.2,
];

(async () => {
  const browser = await import(new URL('../app-v2/src/longterm/tierRounding.js', require('url').pathToFileURL(__filename)));

  console.log('\nA · the two copies of the rule agree, value for value');
  {
    let drift = 0;
    for (const n of BATTERY) {
      for (const dp of [0, 1, 2, 3, 6]) {
        if (server.cutDown(n, dp) !== browser.cutDown(n, dp)) { drift++; console.log(`     cutDown(${n},${dp}) server=${server.cutDown(n, dp)} browser=${browser.cutDown(n, dp)}`); }
        if (server.liftUp(n, dp) !== browser.liftUp(n, dp)) { drift++; console.log(`     liftUp(${n},${dp}) server=${server.liftUp(n, dp)} browser=${browser.liftUp(n, dp)}`); }
      }
    }
    ok(drift === 0, `A1 the browser mirror matches the server on ${BATTERY.length * 5 * 2} evaluations`);
    ok(JSON.stringify(server.DIRECTION) === JSON.stringify(browser.DIRECTION),
      'A2 …and both carry the SAME direction table — DSCR down, LTV up');
    ok(server.sendAs('dscr', 1.2451, 2) === browser.sendAs('dscr', 1.2451, 2)
      && server.sendAs('ltv', 74.991, 2) === browser.sendAs('ltv', 74.991, 2),
      'A3 …applied BY NAME, which is what stops a call site getting the direction backwards');
    let sThrew = false; let bThrew = false;
    try { server.sendAs('fico', 700, 0); } catch { sThrew = true; }
    try { browser.sendAs('fico', 700, 0); } catch { bThrew = true; }
    ok(sThrew && bThrew, 'A4 …and both REFUSE a field with no rule rather than guessing a direction');
  }

  console.log('\nB · the rule itself — not merely that the copies agree');
  {
    /* ⛔ THIS IS THE HALF A MIRROR CHECK CANNOT DO. Section A would pass just as
       happily with BOTH copies rounding to nearest, which is the defect. */
    let up = 0; let down = 0;
    for (const n of BATTERY.filter((x) => x > 0)) {
      const cut = browser.cutDown(n, 2);
      if (cut > n + 1e-12) up++;
      if (browser.liftUp(n, 2) < n - 1e-12) down++;
    }
    ok(up === 0, `B1 a DSCR is NEVER cut upward — not once in the battery (${up} violations)`);
    ok(down === 0, `B2 …and an LTV is never lifted downward (${down} violations)`);
    // The three cases that tell "down" apart from "to nearest".
    ok(browser.cutDown(1.2451, 2) === 1.24, 'B3 1.2451 cuts to 1.24 — rounding to NEAREST would have said 1.25');
    ok(browser.cutDown(1.2499, 2) === 1.24, 'B4 1.2499 cuts to 1.24, however close it is to the better band');
    ok(browser.cutDown(1.2449, 2) === 1.24, 'B5 …and 1.2449 also cuts to 1.24 — the two agree here, which is why B3 is the case that matters');
    // The float guard, in the direction that would silently cost a borrower a band.
    ok(browser.cutDown(1.15, 2) === 1.15, 'B6 a typed 1.15 is 1.15 — the float guard, or a plain floor would say 1.14');
    ok(browser.liftUp(0.7, 2) === 0.7, 'B7 …and a typed 0.7 is 0.7, not 0.71');
    ok(browser.cutDown(NaN, 2) === null && browser.cutDown(Infinity, 2) === null,
      'B8 a figure that is not a number answers null rather than a number nobody computed');
  }

  console.log('\nC · the CALCULATOR uses it — a rule the screen does not call is a rule nobody follows');
  {
    const calc = await import(new URL('../app-v2/src/longterm/dscrCalc.js', require('url').pathToFileURL(__filename)));
    /* Chosen so the ratio lands just ABOVE a cent boundary: rounding to nearest
       reports the better band, cutting down reports the earned one. */
    /* Interest-only makes the payment exactly loanAmount * rate / 12, so the PITIA is a
       figure this test controls to the cent rather than one it has to reverse-engineer out
       of an amortisation. $400,000 at 6% IO = $2,000/mo, tax and insurance zero. */
    const mk = (rentMonthly) => calc.dscrFrom({
      rentMonthly, taxMonthly: 0, insuranceMonthly: 0, hoaMonthly: 0,
      loanAmount: 400000, ratePct: 6, termYears: 30, interestOnly: true,
    });
    const probe = mk(2000);
    ok(probe.pitia === 2000, `C0 CONTROL: the fixture's payment is the $2,000 this test assumes (got ${probe.pitia})`);
    const r = mk(2490.2);              // 2490.2 / 2000 = 1.2451
    if (r && r.dscr != null) {
      ok(r.dscr === 1.24, `C1 a ratio of 1.2451 reports 1.24 — the band the loan earned, not the one it nearly did (got ${r.dscr})`);
    } else {
      // The calculator's inputs are its own; if this shape cannot drive it, say so
      // rather than reporting a pass on an assertion that never ran.
      ok(false, `C1 COULD NOT DRIVE THE CALCULATOR — inputs need re-reading (missing: ${(r && r.missing) || 'unknown'})`);
    }
    const src = require('fs').readFileSync(path.join(ROOT, 'app-v2/src/longterm/dscrCalc.js'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    ok(/sendAs\('dscr'/.test(src), 'C2 …through the shared rule, BY NAME');
    ok(!/dscr:\s*Math\.round\(/.test(src),
      'C3 and the calculator no longer rounds a DSCR to nearest anywhere — the defect cannot come back');
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  if (fail) process.exit(1);
})().catch((e) => { console.error(e); process.exit(1); });
