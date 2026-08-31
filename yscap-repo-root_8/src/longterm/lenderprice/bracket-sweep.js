#!/usr/bin/env node
'use strict';
/**
 * LONG-TERM — DISCOVER EVERY INVESTOR'S DSCR BRACKETS, FROM THE SYSTEM ITSELF.
 *
 * Owner-directed 2026-08-31: *"You need to test every single bracket. You need to test 0.1 DSCR,
 * 0.2 DSCR, 0.5, 0.6, and so forth to find every investor's different bracket by every single
 * number … We can combine all of them together. Usually, they're running together, but some of
 * them are running it a little differently. We set up all the brackets, and then we know that if
 * it changes, if it moves away from one bracket to another, even if it's only one investor that is
 * changing, we need to reprise the entire thing. Set up your brackets from the system."*
 *
 * ⛔ WHY THIS IS A SWEEP AND NOT A TABLE SOMEBODY TYPES. A DSCR bracket is each INVESTOR'S OWN, it
 * is worth real points, and it changes whenever they re-issue a rate sheet. Measured on one live
 * capture, three investors shared the 1.25 boundary and charged 0.25, 0.375 and 0.5 points for it
 * while a fourth priced no DSCR bracket at all on that product. A hand-kept ladder would be wrong
 * the first time any one of them moved, and wrong SILENTLY. So the ladder is MEASURED from the
 * vendor's own answers, and this script is how it is re-measured.
 *
 * ⛔ IT NEVER TAKES A CREDENTIAL. It uses the Lender Price login the server is already configured
 * with (src/config.js → the LP client), so no secret is ever typed into a command, a chat, or this
 * file. Run it where those credentials already live. It refuses to start if the client is not
 * configured rather than half-running against nothing.
 *
 * ⛔ IT ONLY READS. A pricing search changes nothing on the vendor's side and nothing in PILOT: it
 * calls `client.price()` and parses the answer. It writes ONE local JSON report and no database row.
 *
 * WHAT IT MEASURES, and the second half is the one people forget:
 *   1. THE PRICED BRACKET — the DSCR adjustment the vendor stamps on each option, e.g.
 *      "Additional LLPAs - DSCR 1.25 / CLTV >65.01 % <= 70.0 %" worth 0.375 points. When its
 *      wording or its points change between two ratios, a boundary sits between them.
 *   2. ELIGIBILITY — whether the investor offers the programme AT ALL at that ratio. An investor
 *      that simply DISAPPEARS as the ratio falls has a boundary too, and it is the more expensive
 *      one: the option is not re-priced, it is gone. An option carrying no DSCR adjustment must
 *      therefore never be read as "this ratio does not matter here".
 *
 * TWO PHASES, so the vendor is asked as few times as possible:
 *   COARSE — walk the ladder in `--step` (default 0.05) from `--from` to `--to`.
 *   REFINE — wherever something changed between two neighbouring ratios, bisect that gap down to
 *            `--precision` (default 0.01) to pin the boundary exactly. A boundary reported as
 *            "between 1.20 and 1.25" is not a bracket anybody can build a rule on.
 *
 * ⛔ IT LIVES IN THE LONG-TERM ZONE, NOT IN scripts/. Only `scripts/test-lt-*.js` may reach into
 * `src/longterm/`, and this is an operator tool rather than a test — so putting it in scripts/ was
 * a product-separation crossing, and the gate said so. It belongs beside the client it drives.
 * Run it on the server, where the Lender Price credentials already are.
 *
 * Usage:
 *   node src/longterm/lenderprice/bracket-sweep.js                 # the default ladder, live
 *   node src/longterm/lenderprice/bracket-sweep.js --dry-run       # show the plan, call nothing
 *   node src/longterm/lenderprice/bracket-sweep.js --from 0.5 --to 1.6 --step 0.05 --precision 0.01
 *   node src/longterm/lenderprice/bracket-sweep.js --out docs/longterm/dscr-brackets.json
 */

const fs = require('fs');
const path = require('path');

const client = require('./client');

// ---- the scenario every search shares -------------------------------------
// ONE scenario, one property, one loan — so the ONLY thing moving across the whole sweep is the
// DSCR. Any other difference between two searches would make a change in the answer unattributable,
// which is the whole point of holding them fixed. These are ordinary middle-of-the-road values, not
// edge cases: a boundary found at the edge of a matrix may be the matrix's edge rather than a band.
const BASE_SCENARIO = {
  purpose: 'Purchase',
  propertyType: 'Single family',
  propertyValue: 500000,
  loanAmount: 350000,          // 70% LTV — inside a normal CLTV cell, not on its edge
  ltv: 70,
  fico: 760,
  termYears: 30,
  state: 'NJ',
  city: 'Lakewood',
  zip: '08701',
  units: 1,
  reservesMonths: 24,
  prepayMonths: 60,
  prepayStructure: '5 Year',
};

function arg(name, dflt) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return dflt;
  const v = process.argv[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
}
const has = (name) => process.argv.includes(`--${name}`);

const FROM = Number(arg('from', 0.1));
const TO = Number(arg('to', 2.0));
const STEP = Number(arg('step', 0.05));
const PRECISION = Number(arg('precision', 0.01));
const PACE_MS = Number(arg('pace', 1200));
const OUT = String(arg('out', 'docs/longterm/dscr-brackets.json'));
const DRY = has('dry-run');

const r2 = (n) => Math.round(n * 100) / 100;   // RATIOS only — never points, see below.
/* ⛔ POINTS ARE NEVER ROUNDED (owner-directed 2026-08-31: *"Don't allow this rounding. For the
   points, you need to follow the exact."*). An adjustment is quoted in eighths — 0.125, 0.375,
   0.625 — and an eighth is a dyadic fraction, so it is EXACTLY representable in binary and adding
   several of them is exact arithmetic. Rounding therefore bought nothing and cost real precision:
   an earlier cut rounded like money and turned 0.375 into 0.38, which not only misstates what an
   investor charges but can make two genuinely DIFFERENT adjustments compare equal and hide a
   boundary the sweep exists to find. The vendor's number is carried through verbatim, and each
   adjustment's own value is kept beside the total so nothing rests on the sum alone. */
const exactSum = (xs) => xs.reduce((a, b) => a + b, 0);

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

/** The DSCR bracket a single option was priced in, as the vendor stated it. */
function bracketOf(option) {
  const adj = []
    .concat(Array.isArray(option.adjustments) ? option.adjustments : [])
    .concat(Array.isArray(option.rateAdjustments) ? option.rateAdjustments : []);
  const hits = adj
    .filter((a) => a && typeof a.reason === 'string' && /dscr/i.test(a.reason))
    // A FICO/CLTV row merely NAMED "DSCR FICO/CLTV" is not a DSCR bracket — it is the FICO grid for
    // a DSCR product. Only a row stating a DSCR THRESHOLD counts, or every option would look banded.
    .filter((a) => /dscr\s*(?:>=|≥|>|<=|≤|<)?\s*\d/i.test(a.reason))
    .map((a) => ({ reason: String(a.reason), points: Number(a.value) }));
  if (!hits.length) return null;
  // Stated in the vendor's own words AND as a number, because the wording varies by investor
  // ("DSCR 1.25", "DSCR >=1.25", "DSCR ≥ 1.25") while the threshold is the thing that moves.
  const floors = hits
    .map((h) => { const m = h.reason.match(/dscr\s*(?:>=|≥|>|<=|≤|<)?\s*(\d+(?:\.\d+)?)/i); return m ? Number(m[1]) : null; })
    .filter((n) => n != null);
  return {
    reasons: hits.map((h) => h.reason).sort(),
    points: exactSum(hits.map((h) => (Number.isFinite(h.points) ? h.points : 0))),
    // Every adjustment's own exact value, so a comparison never depends on the total.
    values: hits.map((h) => h.points),
    floor: floors.length ? Math.max(...floors) : null,
  };
}

/** One option's identity, stable across searches. Investor + product, never the position. */
const idOf = (o) => `${o.investor || o.lender || '?'} — ${o.product || o.program || '?'}`;

/** What one ratio looks like: every option's bracket, keyed by identity. */
function shapeOf(parsed) {
  const out = new Map();
  for (const p of (parsed.programs || [])) {
    for (const o of (p.options || [])) {
      const id = idOf(o);
      if (out.has(id)) continue;            // the front rung is enough: the bracket is per product
      const b = bracketOf(o);
      out.set(id, {
        present: true,
        bracket: b ? b.reasons.join(' | ') : null,
        points: b ? b.points : null,
        values: b ? b.values : null,
        floor: b ? b.floor : null,
      });
    }
  }
  return out;
}

/** Everything that DIFFERS between two ratios, per investor+product. */
function diff(a, b) {
  const ids = new Set([...a.keys(), ...b.keys()]);
  const changes = [];
  for (const id of ids) {
    const x = a.get(id) || { present: false };
    const y = b.get(id) || { present: false };
    if (x.present !== y.present) {
      changes.push({ id, kind: y.present ? 'became_eligible' : 'no_longer_offered', from: x, to: y });
    } else if (x.present && y.present && (x.bracket !== y.bracket
      || JSON.stringify(x.values) !== JSON.stringify(y.values))) {
      changes.push({ id, kind: 'bracket_changed', from: x, to: y });
    }
  }
  return changes;
}

async function priceAt(dscr) {
  const res = await client.price({ ...BASE_SCENARIO, dscr });
  if (!res || !res.ok) {
    const why = (res && (res.error || res.message)) || 'unknown';
    throw new Error(`the vendor did not price DSCR ${dscr}: ${why}`);
  }
  return client.parseFull(res.raw);
}

async function main() {
  if (!Number.isFinite(FROM) || !Number.isFinite(TO) || !Number.isFinite(STEP) || STEP <= 0 || TO <= FROM) {
    console.error('bad ladder: --from must be below --to and --step must be positive.');
    process.exit(2);
  }

  const ladder = [];
  for (let d = FROM; d <= TO + 1e-9; d += STEP) ladder.push(r2(d));

  console.log(`DSCR bracket sweep — ${ladder.length} ratios from ${FROM} to ${TO} step ${STEP}`);
  console.log(`  refine to ${PRECISION}, pacing ${PACE_MS}ms between searches`);
  console.log(`  scenario: $${BASE_SCENARIO.loanAmount} on $${BASE_SCENARIO.propertyValue} `
    + `(${BASE_SCENARIO.ltv}% LTV), FICO ${BASE_SCENARIO.fico}, ${BASE_SCENARIO.termYears}yr, `
    + `${BASE_SCENARIO.zip} — held FIXED so the ratio is the only thing moving\n`);

  if (DRY) {
    console.log('--dry-run: calling nothing. The ladder would be:');
    console.log('  ' + ladder.join(', '));
    return;
  }

  // ⛔ REFUSE RATHER THAN HALF-RUN. Without a configured login every search fails and the report
  // would read as "no investor has any bracket", which is a confident wrong answer.
  if (!client.configured()) {
    console.error('Lender Price is not configured in this environment — refusing to run.');
    console.error('  Run this where the LP credentials already live. It never takes one as an argument.');
    process.exit(1);
  }

  const shapes = new Map();
  for (const d of ladder) {
    try {
      shapes.set(d, shapeOf(await priceAt(d)));
      const n = shapes.get(d).size;
      const banded = [...shapes.get(d).values()].filter((v) => v.bracket).length;
      console.log(`  DSCR ${String(d).padEnd(5)} → ${String(n).padStart(3)} products, ${banded} carrying a DSCR bracket`);
    } catch (e) {
      console.log(`  DSCR ${String(d).padEnd(5)} → FAILED (${e.message})`);
      shapes.set(d, null);
    }
    await sleep(PACE_MS);
  }

  // ---- coarse boundaries, then bisect each one to `PRECISION` --------------
  const boundaries = [];
  for (let i = 1; i < ladder.length; i++) {
    const lo = ladder[i - 1]; const hi = ladder[i];
    const a = shapes.get(lo); const b = shapes.get(hi);
    if (!a || !b) continue;
    if (!diff(a, b).length) continue;

    let l = lo; let h = hi; let lShape = a; let hShape = b;
    while (r2(h - l) > PRECISION) {
      const mid = r2((l + h) / 2);
      if (mid <= l || mid >= h) break;
      let mShape = null;
      try { mShape = shapeOf(await priceAt(mid)); } catch (e) { break; }
      await sleep(PACE_MS);
      if (diff(lShape, mShape).length) { h = mid; hShape = mShape; }
      else { l = mid; lShape = mShape; }
    }
    const changes = diff(lShape, hShape);
    boundaries.push({ below: l, atOrAbove: h, changes });
    console.log(`\n  ⇒ BOUNDARY between ${l} and ${h}:`);
    for (const c of changes) {
      console.log(`      ${c.kind.padEnd(20)} ${c.id}`);
      if (c.kind === 'bracket_changed') {
        console.log(`         ${c.from.bracket} (${c.from.points}pts)  →  ${c.to.bracket} (${c.to.points}pts)`);
      }
    }
  }

  // ---- the combined ladder — the owner's "combine all of them together" ----
  console.log('\n' + '='.repeat(78));
  console.log('COMBINED BRACKET LADDER — every ratio at which ANY investor changes');
  console.log('='.repeat(78));
  if (!boundaries.length) console.log('  none found in this range.');
  for (const b of boundaries) {
    const who = [...new Set(b.changes.map((c) => c.id.split(' — ')[0]))];
    console.log(`  ${String(b.atOrAbove).padEnd(6)} — ${b.changes.length} change(s) across ${who.length} investor(s): ${who.join(', ')}`);
  }
  console.log('\n  THE RULE THIS FEEDS: a priced sheet may be issued while the real ratio stays at or');
  console.log('  above the boundary its price was bought above. Cross one going down and the sheet');
  console.log('  is re-priced — even if only one investor moved, because the comparison is one document.');

  const report = {
    _what: 'DSCR brackets as MEASURED against the Lender Price system, one entry each investor. Regenerate with src/longterm/lenderprice/bracket-sweep.js.',
    measuredAt: new Date().toISOString(),
    scenario: BASE_SCENARIO,
    ladder: { from: FROM, to: TO, step: STEP, precision: PRECISION },
    boundaries,
    byRatio: Object.fromEntries([...shapes].map(([d, s]) => [d, s ? Object.fromEntries(s) : null])),
  };
  const outPath = path.join(__dirname, '..', OUT);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(`\nwritten: ${OUT}`);
}

/* The detection logic is exported so it can be PROVEN against the committed live capture
   without calling the vendor — `scripts/test-lt-dscr-bracket-sweep-pure.js`. Only the runner is
   guarded, so requiring this file never fires a sweep. */
module.exports = { _internals: { bracketOf, shapeOf, diff, idOf, BASE_SCENARIO } };

if (require.main === module) {
  main().catch((e) => { console.error('sweep failed:', (e && e.stack) || e); process.exit(1); });
}
