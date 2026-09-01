#!/usr/bin/env node
'use strict';
// LONG-TERM — the DSCR bracket sweep reads a real vendor answer correctly.
//
// The sweep itself calls the live vendor, so CI can never run it. What CI CAN run — and what
// actually decides whether the sweep is worth anything — is its READING: given a real priced
// option, does it find the DSCR bracket, and does it tell two ratios apart?
//
// So this is proven against `scripts/fixtures/lt-pricer-live-capture.json`, a REAL reduced answer
// from the live system, rather than against a hand-typed option that would only prove the regex
// matches itself.
//
// THE TWO MISREADINGS IT PINS, both of which would produce a confident wrong bracket table:
//   • "DSCR FICO/CLTV - 760 - 779 / …" is the FICO grid FOR a DSCR product, not a DSCR bracket.
//     Counting it would make every option look banded and invent boundaries at every FICO step.
//   • An option carrying NO DSCR adjustment is not "unaffected by the ratio" — it may simply stop
//     being offered lower down, which is an eligibility boundary and the more expensive kind.

const path = require('path');
const { _internals: S } = require('../src/longterm/lenderprice/bracket-sweep.js');

let bad = 0;
const ok = (c, label) => { if (c) console.log(`  ok   ${label}`); else { bad += 1; console.error(`  FAIL ${label}`); } };

const capture = require(path.join(__dirname, 'fixtures', 'lt-pricer-live-capture.json'));
const SRC = require('fs').readFileSync(path.join(__dirname, '..', 'src', 'longterm', 'lenderprice', 'bracket-sweep.js'), 'utf8');

console.log('\nA. it finds the bracket the vendor actually stamped on a real option');
const opt0 = capture.programs[0].options[0];
const b0 = S.bracketOf(opt0);
ok(b0 !== null, 'A1 the first captured option carries a DSCR bracket');
ok(b0 && b0.floor === 1.25, `A2 …and its floor reads as 1.25 (got ${b0 && b0.floor})`);
/* ⛔ EXACT, NOT NEAR (owner-directed 2026-08-31: *"For the points, you need to follow the
   exact."*). Asserted with === against the vendor's own number, so any rounding anywhere in the
   path fails this — a tolerance would have let the 0.38 bug through. */
ok(b0 && b0.points === 0.375, `A3 …worth EXACTLY 0.375 points (got ${b0 && b0.points})`);
ok(b0 && Array.isArray(b0.values) && b0.values[0] === 0.375,
  'A3b …and each adjustment keeps its own exact value, so nothing rests on the sum');
ok(b0 && /DSCR 1\.25/.test(b0.reasons.join('|')), 'A4 …quoted in the vendor\'s own words, not ours');

console.log('\nB. a FICO grid named "DSCR FICO/CLTV" is NOT a DSCR bracket');
const ficoRow = { adjustments: [{ reason: 'DSCR FICO/CLTV - 760 - 779 / CLTV >65.01 % <= 70.0 %', value: 0.375 }] };
ok(S.bracketOf(ficoRow) === null,
  'B1 a row naming DSCR but stating no DSCR THRESHOLD is ignored — it is the FICO grid');
const realRow = { adjustments: [{ reason: 'Additional LLPAs - DSCR 1.25 / CLTV >65.01 % <= 70.0 %', value: 0.375 }] };
ok(S.bracketOf(realRow) !== null, 'B2 …while a row stating a threshold IS a bracket (the control)');

console.log('\nC. every spelling the investors actually use is read');
for (const [txt, want] of [
  ['Additional LLPAs - DSCR 1.25 / CLTV >65.01 % <= 70.0 %', 1.25],
  ['Other Adjustments - DSCR ≥ 1.25 / CLTV >65.01 % <= 70.0 %', 1.25],
  ['Product Feature, Other - DSCR >=1.25 / CLTV >65.01 % <= 70.0 %', 1.25],
]) {
  const got = S.bracketOf({ adjustments: [{ reason: txt, value: 0.25 }] });
  ok(got && got.floor === want, `C-${want} "${txt.slice(0, 44)}…" → ${got && got.floor}`);
}

console.log('\nD. the whole captured answer, as the sweep would see one ratio');
const shape = S.shapeOf(capture);
ok(shape.size === 4, `D1 four products across four investors (${shape.size})`);
const banded = [...shape.values()].filter((v) => v.bracket).length;
ok(banded === 3, `D2 three carry a DSCR bracket, one does not (${banded}) — the owner's "some run it differently"`);
const pts = [...shape.values()].filter((v) => v.points != null).map((v) => v.points).sort();
ok(new Set(pts).size === 3,
  `D3 …and the three charge DIFFERENT amounts for the same 1.25 boundary (${pts.join(', ')} points)`);
/* The eighths must survive verbatim. 0.38 in this list would mean the report misstates what an
   investor charges — and two different charges could collapse into one and hide a boundary. */
ok(pts.every((p) => String(p).length <= 5 && Math.abs(p * 8 - Math.round(p * 8)) < 1e-12),
  `D3b …every one of them an exact eighth, unrounded (${pts.join(', ')})`);
ok(!/rPts|toFixed\(2\)/.test(SRC) && /never rounded/i.test(SRC),
  'D3c the sweep rounds no point value anywhere — asserted on its source, so it cannot creep back');

console.log('\nE. it tells two ratios apart — which is the whole sweep');
const lower = new Map(shape);
// One investor drops its bracket, one stops being offered: the two boundary kinds.
const ids = [...shape.keys()];
lower.set(ids[0], { present: true, bracket: null, points: null, floor: null });
lower.delete(ids[1]);
const changes = S.diff(lower, shape);
ok(changes.length === 2, `E1 both kinds of change are seen (${changes.length})`);
ok(changes.some((c) => c.kind === 'bracket_changed'), 'E2 a bracket that moved is a boundary');
ok(changes.some((c) => c.kind === 'became_eligible'),
  'E3 an investor that only appears higher up is a boundary too — the eligibility kind');
ok(S.diff(shape, shape).length === 0, 'E4 …and an identical ratio reports NO boundary (the control)');

console.log('\nF. an option is identified by investor and product, never by position');
ok(/—/.test(S.idOf({ investor: 'Onslow Bay', product: '30yr Fixed' })),
  'F1 the identity is investor + product');
ok(S.idOf({ investor: 'A', product: 'P' }) === S.idOf({ investor: 'A', product: 'P', rateGridId: 'other' }),
  'F2 …and is stable across searches — a re-run must compare like with like');

console.log(bad === 0 ? '\nOFFLINE: all passed' : `\nOFFLINE: ${bad} FAILED`);
process.exit(bad === 0 ? 0 : 1);
