#!/usr/bin/env node
'use strict';
/**
 * LT PPE — WHAT AN AGREEMENT RUN ACTUALLY MEASURED (§2.121).
 *
 * `--out report.json` persists the run's verdict. Measured before the fix, on a real report file: the
 * summary carried `total` and `agreementRate` and NOT ONE of `provenance`, `narrowed`, `battery`,
 * `source`, `replay`, `scope`, `probe` — while four separate things can narrow the population behind
 * those two numbers (`--scenarios`, `--priced-probe`, `--replay-partial`, `--filter-*`), each announced
 * on the CONSOLE and nowhere else. So the durable artifact read `total: 2, agreementRate: 0` with
 * nothing recording that scenarios were deliberately excluded, or that the run never called Lender
 * Price at all. Same class as §2.110 and §2.135, one layer out.
 *
 * ⛔ THE SCOPE IS THE DANGEROUS FIELD, not the counts. §2.100 measured what an unscoped run does — our
 * one-investor sheet against the whole market, "a confident 0.00% that means nothing". Two reports
 * taken under DIFFERENT scopes are not comparable either, and neither file said which produced it.
 *
 *   node scripts/test-lt-ppe-agreement-provenance.js
 */
const fs = require('fs');
const path = require('path');
const prov = require('../src/longterm/ppe/agreement-provenance');

let failures = 0;
function ok(cond, label) { console.log(`${cond ? '  ok  ' : ' FAIL '} ${label}`); if (!cond) failures++; }

console.log('LT PPE — what an agreement run measured (§2.121) — offline\n');

// ---- A. AN UNNARROWED RUN SAYS SO, AND WARNS ABOUT NOTHING ---------------------------------------
{
  const p = prov.finish(prov.begin({ name: 'canonical agreement battery', offered: 305 }), {
    runAt: '2026-08-19T00:00:00.000Z',
    scope: { investor: 'Deephaven Mortgage', programLike: /^dscr/i },
  });
  ok(p.ran === 305 && p.battery.offered === 305, 'A1 a run over the whole battery records 305 of 305');
  ok(p.coversWholeBattery === true, 'A2 …and says it covered the whole battery');
  ok(p.reconciles === true, 'A3 …and the counts reconcile');
  ok(prov.provenanceWarnings(p).length === 0,
    `A4 …so there is nothing to warn about — got ${JSON.stringify(prov.provenanceWarnings(p))}`);
  ok(prov.describeProvenance(p).join(' ').includes('305 of 305'),
    'A5 …and the description leads with the population, not the percentage');
}

// ---- B. EVERY NARROWING IS RECORDED WHERE IT HAPPENS ---------------------------------------------
{
  let p = prov.begin({ name: 'canonical agreement battery', offered: 305 });
  p = prov.narrowed(p, 'priced_probe', 305, 12, 'our own sheet prices these');
  p = prov.finish(p, { runAt: 'x', scope: { investor: 'Deephaven Mortgage' } });
  ok(p.ran === 12, 'B1 the probe narrowing moves what ran to 12');
  ok(p.narrowing[0].dropped === 293, `B2 …and records the 293 it dropped — got ${p.narrowing[0].dropped}`);
  ok(p.coversWholeBattery === false, 'B3 …so the run no longer claims to cover the battery');
  const w = prov.provenanceWarnings(p).join(' ');
  ok(/about 12 scenario/.test(w) && /293 were deliberately excluded/.test(w),
    'B4 …and the warning states BOTH what was measured and how much was not');
  ok(/Do not read the agreement rate as battery-wide/.test(w),
    'B5 …in the words that stop the number being misread, which is the whole point');
}

// ---- C. TWO NARROWINGS CHAIN, AND A GAP IS DETECTED ----------------------------------------------
// A narrowing that forgot to record itself must show up as a gap rather than as a smaller number
// nobody questions — that silent shrink is the defect this file exists to make impossible.
{
  let p = prov.begin({ name: 'battery', offered: 305 });
  p = prov.narrowed(p, 'priced_probe', 305, 12);
  p = prov.narrowed(p, 'replay_partial', 12, 5);
  p = prov.finish(p, { runAt: 'x' });
  ok(p.ran === 5 && p.reconciles === true, 'C1 two narrowings chain and still reconcile (305 → 12 → 5)');

  const gap = prov.finish({ ...p, ran: 3 }, { runAt: 'x' });
  ok(gap.reconciles === false, 'C2 a run that ended smaller than its last recorded step does NOT reconcile');
  ok(prov.provenanceWarnings(gap).some((x) => /do NOT reconcile/.test(x)),
    'C3 …and says so, naming it as something that narrowed the run without recording itself');
  ok(prov.provenanceWarnings(gap).some((x) => /unexplained/.test(x)),
    'C4 …and refuses to let the other numbers be read until it is found');

  // A step starting somewhere other than where the previous one ended is the same hole.
  let broken = prov.begin({ name: 'battery', offered: 305 });
  broken = prov.narrowed(broken, 'priced_probe', 305, 12);
  broken.narrowing.push({ by: 'replay_partial', label: 'x', from: 40, to: 5, dropped: 35 });
  broken.ran = 5;
  ok(prov.reconciles(prov.finish(broken, {})) === false,
    'C5 a step that does not start where the previous one ended is caught too');
}

// ---- D. A SCENARIO FILE REPLACES THE POPULATION, IT DOES NOT SUBTRACT FROM IT ---------------------
{
  let p = prov.begin({ name: 'canonical agreement battery', offered: 305 });
  p.battery = { name: '/tmp/eight.json', offered: 8 };
  p = prov.narrowed(p, 'scenarios_file', 8, 8, '/tmp/eight.json');
  p = prov.finish(p, { runAt: 'x' });
  ok(p.reconciles === true, 'D1 a scenario file re-bases the population and still reconciles');
  ok(p.coversWholeBattery === true,
    'D2 …and a full run over THAT file covers its own battery — the file is the battery, honestly named');
  ok(prov.describeProvenance(p).join(' ').includes('/tmp/eight.json'),
    'D3 …with the file NAMED, so a reader knows which 8 scenarios these were');
}

// ---- E. THE SCOPE SURVIVES BEING WRITTEN TO A FILE (the bug inside the fix) -----------------------
// CAUGHT BY WRITING THE FILE AND READING IT BACK, not by inspection: `--filter-program-like` is a
// RegExp and `JSON.stringify(/^dscr/i)` is `{}`, so the console printed the scope correctly (String
// coerces a RegExp) while the persisted report — the thing anybody actually reads later — recorded an
// EMPTY scope. A report claiming an agreement rate with no scope beside it is exactly §2.121.
{
  const p = prov.finish(prov.begin({ name: 'b', offered: 2 }), {
    runAt: 'x',
    scope: { investor: 'Deephaven Mortgage', programLike: /^dscr/i, product: undefined, lender: null },
  });
  ok(p.scope.programLike === '/^dscr/i',
    `E1 a RegExp scope is recorded as text, not as {} — got ${JSON.stringify(p.scope.programLike)}`);
  const roundTripped = JSON.parse(JSON.stringify(p));
  ok(roundTripped.scope.programLike === '/^dscr/i',
    'E2 …and it SURVIVES the round trip through JSON, which is where it was being lost');
  ok(JSON.stringify(roundTripped) === JSON.stringify(p),
    'E3 …and the whole record is JSON-safe, so what is read back is what was recorded');
  ok(!('product' in p.scope) && !('lender' in p.scope),
    'E4 an unset filter is absent rather than recorded as null — a scope lists what was APPLIED');
  ok(prov.describeProvenance(p).join(' ').includes('programLike=/^dscr/i'),
    'E5 …and the console says the same thing the file does, from the one description');
}

// ---- F. AN UNSCOPED RUN IS NAMED AS THE THING §2.100 MEASURED ------------------------------------
{
  const p = prov.finish(prov.begin({ name: 'b', offered: 305 }), { runAt: 'x', scope: {} });
  const w = prov.provenanceWarnings(p).join(' ');
  ok(/UNSCOPED/.test(w), 'F1 an unscoped run is named as unscoped');
  ok(/every lender in the market/.test(w) && /§2.100/.test(w),
    'F2 …with the reason it matters and where it was measured, not a bare label');
  ok(prov.describeProvenance(p).join(' ').includes('UNSCOPED'),
    'F3 …and it is on the console line too, beside the numbers it invalidates');
}

// ---- G. A REPLAY IS NOT A FRESH MEASUREMENT, AND SAYS SO -----------------------------------------
{
  const p = prov.finish(prov.begin({ name: 'b', offered: 2 }), {
    runAt: 'x', lpSource: 'replay', replayDir: '/caps/run-114', scope: { investor: 'D' },
  });
  ok(p.lpSource === 'replay' && p.replayDir === '/caps/run-114', 'G1 a replay records that it was one, and from where');
  const w = prov.provenanceWarnings(p).join(' ');
  ok(/REPLAY of stored vendor answers/.test(w), 'G2 …and warns it is not a fresh measurement');
  ok(/may no longer be what it would answer today/.test(w),
    'G3 …in the words that matter — a stored answer can go stale, which a percentage cannot show');
  ok(prov.describeProvenance(p).join(' ').includes('no paid call'),
    'G4 …and the description says plainly that nothing was paid for');

  const live = prov.finish(prov.begin({ name: 'b', offered: 2 }), { runAt: 'x', scope: { investor: 'D' } });
  ok(!prov.provenanceWarnings(live).some((x) => /REPLAY/.test(x)),
    'G5 a live run carries no replay warning — the warning means something because it is not always there');
}

// ---- H. A SKIPPED REFUSAL FEED IS AN UNMEASURED HALF ---------------------------------------------
{
  const p = prov.finish(prov.begin({ name: 'b', offered: 305 }), {
    runAt: 'x', scope: { investor: 'D' }, disqualify: 'skipped',
  });
  ok(prov.provenanceWarnings(p).some((x) => /eligibility side of every scenario is unmeasured/.test(x)),
    'H1 --no-disqualify is recorded as an unmeasured half, not just a faster run');
  ok(prov.describeProvenance(p).join(' ').includes('cannot say anything about eligibility'),
    'H2 …and the description says which half');
}

// ---- I. A NARROWING NOBODY NAMED IS STILL RECORDED ------------------------------------------------
// The one thing worse than an unrecorded cut is a cut recorded under a name that means nothing.
{
  let p = prov.begin({ name: 'b', offered: 100 });
  p = prov.narrowed(p, 'some_new_flag', 100, 40);
  p = prov.finish(p, { runAt: 'x' });
  ok(p.narrowing[0].dropped === 60, 'I1 an unrecognised narrowing still records its arithmetic');
  ok(/unrecognised narrowing/.test(p.narrowing[0].label),
    'I2 …and is NAMED as unrecognised rather than quietly given a friendly label');
  ok(p.reconciles === true, 'I3 …and still reconciles, so it cannot hide inside the totals');
}

// ---- J. THE RUNNER ACTUALLY WIRES IT — every narrowing site is stamped ----------------------------
// A pure test of the recorder proves nothing about whether the CLI calls it, and the defect was
// precisely that the CLI announced these on the console and recorded them nowhere.
{
  const src = fs.readFileSync(path.join(__dirname, 'test-lt-lp-agreement-run.js'), 'utf8');
  ok(/require\('\.\.\/src\/longterm\/ppe\/agreement-provenance'\)/.test(src),
    'J1 the runner requires the recorder');
  for (const by of ['scenarios_file', 'priced_probe', 'replay_partial']) {
    ok(new RegExp(`prov\\.narrowed\\(provenance, '${by}'`).test(src),
      `J2 …and stamps the "${by}" narrowing where it makes it`);
  }
  ok(/summary\.provenance = provenance;/.test(src),
    'J3 …and attaches it to the SUMMARY, so a consumer reading summary alone cannot get the rate without the population');
  ok(/prov\.provenanceWarnings\(provenance\)/.test(src),
    'J4 …and prints the warnings beside the verdict');
  // Every place `scenarios` is narrowed must be accounted for. If a fifth narrowing is added later
  // without a `prov.narrowed` beside it, the arithmetic guard (C) is what catches it at runtime —
  // this counts the sites so the omission is visible at build time too.
  const assignments = (src.match(/\n\s*scenarios = /g) || []).length;
  const stamps = (src.match(/prov\.narrowed\(provenance,/g) || []).length;
  ok(assignments <= stamps + 1,
    `J5 every site that narrows the scenario list has a recorded stamp — ${assignments} assignment(s), ${stamps} stamp(s)`
    + ' (the +1 is the initial assignment, which is not a narrowing)');
}

console.log(`\n${failures ? failures + ' FAILED' : 'all passed'}`);
process.exit(failures ? 1 : 0);

/* ---------------------------------------------------------------------------------------------
 * MUTATION LOG — control green either side, each checksum-verified to have APPLIED.
 *   M1  scopeValue: return the RegExp unchanged (the pre-fix state) → E1/E2/E3/E5 fail — the scope is
 *                                                                     {} in the persisted file
 *   M2  coversWholeBattery: always true                             → A4-adjacent + B3/B4/B5 fail
 *   M3  reconciles: always true                                     → C2/C3/C4/C5 fail (a silent shrink)
 *   M4  provenanceWarnings: drop the unscoped branch                → F1/F2 fail (§2.100 unlabelled)
 *   M5  provenanceWarnings: drop the replay branch                  → G2/G3 fail (a stale answer reads
 *                                                                     as a fresh measurement)
 *   M6  narrowed: fall back to a friendly label for an unknown `by` → I2 fails
 *   M7  runner: stop attaching provenance to `summary`              → J3 fails (a scoreboard gets the
 *                                                                     rate with no population)
 * ------------------------------------------------------------------------------------------- */
