#!/usr/bin/env node
/* =====================================================================
   test-silver-band-lift-pure.js
   ---------------------------------------------------------------------
   GUARDS THE OWNER-AUTHORIZED ".99 BAND LABEL MEANS THE ROUND NUMBER
   ABOVE IT" RULE (2026-07-30) — and, above all, the one property that
   makes it SAFE, which no other test in the suite pins.

   OWNER'S WORDS (2026-07-30): "Fix this entire deal to allow every 75 to
   price as 74.99. And qualify the same … it should be on every tier, on
   every scenario, on everything … It should not be this point 99. It
   should be the above."

   WHY THIS FILE EXISTS. The lift moves a ratio DOWN a band. That is only
   ever harmless because, in THIS workbook, there is no place where the
   band ABOVE a lifted boundary carries a price while the band BELOW it
   does not. If a future regeneration of the workbook ever introduced one,
   a deal sitting exactly on 65.00% / 75.00% / 90.00% would stop pricing
   altogether and silently fall to a smaller structure or to individual
   review — and NOTHING else in the suite would notice (the matrix would
   simply report more MANUAL verdicts, which it tolerates). So this test
   scans every one of the grid's FICO rows on BOTH axes and fails loudly
   on the first such hole.

   It also re-derives the band edges straight from the FIXTURE's own label
   strings — independently of the engine — and pins:
     • exactly THREE labels in the workbook end in ".99", and they lift to
       0.65 / 0.75 / 0.90;
     • the engine's band arrays ARE the fixture's labels, in band order;
     • every other edge parses to itself and classifies exactly as before;
     • the round number, and the whole seam beneath it, band DOWN;
     • a ROUNDING SPECK above an edge still bands DOWN (owner-authorized
       2026-07-30: "so it shouldn't get overpriced"), while a ratio genuinely
       above the edge still bands UP.

   PURE: no DB, no network, no server. Run: node scripts/test-silver-band-lift-pure.js
   ===================================================================== */
'use strict';
const path = require('path');
const SVP = require(path.join(__dirname, '..', 'web', 'v2', 'tools', 'silver-program.js'));
const FIX = require(path.join(__dirname, 'fixtures', 'emcap-pricing-tool-v1.json'));

let pass = 0; const fails = [];
function ok(c, msg) { if (c) pass++; else { fails.push(msg); console.error('FAIL: ' + msg); } }

/* ---------- the workbook's own labels, parsed here from scratch ---------- */
const arSet = new Set(), ltcSet = new Set();
for (const k of Object.keys(FIX.rates)) {
  const p = k.split('|');
  if (p.length !== 9) throw new Error(`fixture rate key is not 9-part: ${k}`);
  arSet.add(p[6]); ltcSet.add(p[8]);
}
// edges are kept in HUNDREDTHS OF A PERCENT (integers) so nothing depends on float parsing
function parseLabel(lbl) {
  let m = /^<\s*(\d+(?:\.\d+)?)\s*%$/.exec(lbl);
  if (m) return { lo: 0, hi: Math.round(parseFloat(m[1]) * 100) };
  m = /^(\d+(?:\.\d+)?)\s*%\s*-\s*(\d+(?:\.\d+)?)\s*%$/.exec(lbl);
  if (m) return { lo: Math.round(parseFloat(m[1]) * 100), hi: Math.round(parseFloat(m[2]) * 100) };
  return null;
}
const AR = [...arSet].map((l) => ({ l, ...(parseLabel(l) || {}) })).sort((a, b) => a.hi - b.hi);
const LTC = [...ltcSet].map((l) => ({ l, ...(parseLabel(l) || {}) })).sort((a, b) => a.hi - b.hi);
ok(AR.every((b) => b.hi != null) && LTC.every((b) => b.hi != null), 'every AR/LTC label in the fixture parses as a percent band');
ok(JSON.stringify(SVP.constants.AR_BANDS) === JSON.stringify(AR.map((b) => b.l)), 'engine AR_BANDS == the fixture labels, in band order');
ok(JSON.stringify(SVP.constants.LTC_BANDS) === JSON.stringify(LTC.map((b) => b.l)), 'engine LTC_BANDS == the fixture labels, in band order');

const dot99 = [...AR, ...LTC].filter((b) => b.hi % 100 === 99);
ok(dot99.length === 3, `exactly THREE band labels end in .99 (found ${dot99.length}: ${dot99.map((b) => b.l).join(', ')})`);
ok(dot99.map((b) => (b.hi + 1) / 10000).sort().join(',') === '0.65,0.75,0.9', 'the three .99 labels lift to 0.65 / 0.75 / 0.90');
// a band's lower edge is always one hundredth above the previous upper — so a ".99"
// label is the ONLY place the lift can apply, and it closes that seam exactly.
for (const fam of [{ n: 'AR', a: AR }, { n: 'LTC', a: LTC }]) {
  for (let i = 1; i < fam.a.length; i++) {
    ok(fam.a[i].lo === fam.a[i - 1].hi + 1,
      `${fam.n} band "${fam.a[i].l}" starts exactly one hundredth above "${fam.a[i - 1].l}"`);
  }
}

/* ---------- the classifier, checked against an independent derivation ---------- */
const lift = (hi) => (hi % 100 === 99 ? hi + 1 : hi) / 10000;
const AR_EDGE = AR.map((b) => lift(b.hi)), LTC_EDGE = LTC.map((b) => lift(b.hi));
/* Mirrors the engine's BAND_EPS. A ratio is a division, and binary floating point
   cannot hold most decimal fractions exactly, so a loan sitting mathematically ON an
   edge comes back a hair above it and used to be charged the DEARER band (measured:
   10.25% instead of 10.00%, ~$1,635 on a 12-month term). 1e-9 is ~7 orders above the
   observed noise (~1.1e-16) and ~7 below the narrowest band (0.0249), so it absorbs a
   rounding artifact and can never reclassify a genuinely different structure. */
const BAND_EPS = 1e-9;
const myBand = (bands, edges, r) => {
  if (!(r > 0)) return null;
  for (let i = 0; i < edges.length; i++) if (r <= edges[i] + BAND_EPS) return bands[i].l;
  return null;
};
const ulpUp = (x) => { const b = new Float64Array(1); b[0] = x; const u = new BigUint64Array(b.buffer); u[0] += 1n; return b[0]; };
for (const [nm, bands, edges, fn, top] of [['arBand', AR, AR_EDGE, SVP.arBand, 0.85], ['ltcBand', LTC, LTC_EDGE, SVP.ltcBand, 1.0]]) {
  const probes = [];
  for (let r = 0; r <= top + 1e-12; r = Math.round((r + 1e-4) * 1e7) / 1e7) probes.push(r);
  for (const b of bands) for (const raw of [b.hi / 10000, (b.hi + 1) / 10000, b.lo / 10000]) {
    for (const d of [0, 1e-12, -1e-12, 1e-9, -1e-9, 1e-7, -1e-7, 1e-6, -1e-6]) probes.push(raw + d);
    probes.push(ulpUp(raw));
  }
  let mism = 0;
  for (const r of probes) if (myBand(bands, edges, r) !== fn(r)) { if (mism++ < 3) console.error(`  ${nm} r=${r} independent=${myBand(bands, edges, r)} engine=${fn(r)}`); }
  ok(mism === 0, `${nm}: the engine agrees with the fixture-derived classifier on all ${probes.length} probes`);
}
// the headline promise, and its exact complement
for (const b of dot99) {
  const round = (b.hi + 1) / 10000;
  const isAr = AR.indexOf(b) > -1, fn = isAr ? SVP.arBand : SVP.ltcBand;
  const arr = isAr ? AR : LTC, above = arr[arr.indexOf(b) + 1];
  ok(fn(round) === b.l, `${(round * 100).toFixed(2)}% classifies on the band BELOW ("${b.l}")`);
  for (const s of [1e-9, 1e-7, 1e-6, 1e-5, 5e-5, 9.99e-5]) ok(fn(round - s) === b.l, `the seam point ${(round - s).toFixed(9)} classifies on "${b.l}"`);
  /* A SPECK above the edge is a rounding artifact, not a bigger loan — it bands DOWN. */
  ok(fn(ulpUp(round)) === b.l,
    `one ulp above ${(round * 100).toFixed(2)}% is a rounding speck and still classifies on "${b.l}"`);
  ok(fn(round + BAND_EPS) === b.l,
    `${(round * 100).toFixed(2)}% + one epsilon still classifies on "${b.l}"`);
  /* But a ratio GENUINELY above the edge must still band up, or the epsilon would be
     swallowing real differences instead of rounding noise. */
  if (above) {
    ok(fn(round + 1e-7) === above.l,
      `a real step above ${(round * 100).toFixed(2)}% still classifies UP on "${above.l}" — the epsilon absorbs noise, not deals`);
    ok(fn(round + 1e-4) === above.l,
      `a full hundredth of a percent above ${(round * 100).toFixed(2)}% classifies UP on "${above.l}"`);
  }
}
// nothing else moved
for (const [fn, arr, nm] of [[SVP.arBand, AR, 'AR'], [SVP.ltcBand, LTC, 'LTC']]) {
  for (const b of arr) if (b.hi % 100 !== 99) ok(fn(b.hi / 10000) === b.l, `${nm} round edge "${b.l}" still classifies on ITSELF`);
}

/* ---------- THE SAFETY PROPERTY: the lift can never un-price a deal ----------
   For every family block and every FICO row, on BOTH axes: wherever the band
   ABOVE a lifted boundary carries a price, the band BELOW it must carry one too.
   Otherwise a ratio landing exactly on 65.00% / 75.00% / 90.00% would move from a
   priced cell into a hole.                                                       */
const B = SVP.constants.RATE_BLOCKS, F12 = SVP.constants.FICO_BANDS_12, F3 = SVP.constants.FICO_BANDS_3;
const arIdx = AR.map((b) => b.l), ltcIdx = LTC.map((b) => b.l);
const liftedPairs = { AR: [], LTC: [] };
for (let i = 1; i < AR.length; i++) if (AR[i - 1].hi % 100 === 99) liftedPairs.AR.push([i - 1, i]);
for (let i = 1; i < LTC.length; i++) if (LTC[i - 1].hi % 100 === 99) liftedPairs.LTC.push([i - 1, i]);
ok(liftedPairs.AR.length + liftedPairs.LTC.length === 3, 'three lifted boundaries to guard');

let holes = 0, rows = 0;
for (const key of Object.keys(B)) {
  const block = B[key], tier = +key.slice(-1), fl = tier === 3 ? F3 : F12;
  for (let j = 0; j < 3; j++) {
    rows++;
    for (const [lo, hi] of liftedPairs.LTC) for (let i = 0; i < arIdx.length; i++) {
      if (block[(i * 3 + j) * 6 + hi] > 0 && !(block[(i * 3 + j) * 6 + lo] > 0)) {
        holes++;
        console.error(`  HOLE ${key} fico=${fl[j]} ar="${arIdx[i]}": LTC "${ltcIdx[hi]}" prices but "${ltcIdx[lo]}" does not`);
      }
    }
    for (const [lo, hi] of liftedPairs.AR) for (let k = 0; k < ltcIdx.length; k++) {
      if (block[(hi * 3 + j) * 6 + k] > 0 && !(block[(lo * 3 + j) * 6 + k] > 0)) {
        holes++;
        console.error(`  HOLE ${key} fico=${fl[j]} ltc="${ltcIdx[k]}": AR "${arIdx[hi]}" prices but "${arIdx[lo]}" does not`);
      }
    }
  }
}
ok(holes === 0, `no lifted boundary has a priced band ABOVE it and an unpriced band BELOW it ` +
  `(${rows} FICO rows across ${Object.keys(B).length} family blocks; ${holes} hole(s)) — this is what makes the lift ` +
  `incapable of turning a priced deal into an unpriced one`);

console.log(`\nSilver .99 band-lift guard: ${pass} passed, ${fails.length} failed.`);
if (fails.length) { console.error('\nFAILURES:\n  ' + fails.join('\n  ')); process.exit(1); }
