#!/usr/bin/env node
'use strict';
/**
 * LT PPE — THE GUARD THAT LENDER PRICE'S SIGN FRAME AND OUR SHEET'S ARE EXACT NEGATIONS.
 *
 * ⛔ WHY THIS EXISTS, and it is a correction to my own earlier reading. `client.num` is
 * `parseFloat(String(v).replace(/[^0-9.]/g, ''))` — it strips the MINUS SIGN. Measured on a captured
 * live search: the vendor sends 3,627 adjustment values of which 1,988 are NEGATIVE, and after
 * `parseFull` the parsed set holds 884 positive and ZERO negative. Written up in the parity doc §2.103
 * as a probable money defect and recorded as the next item to fix.
 *
 * ⛔ IT IS NOT A MONEY DEFECT, AND "FIXING" IT WOULD HAVE BEEN THE BUG. Measured family by family
 * against the rate sheet's own signed cells, Lender Price states an adjustment CHARGE-POSITIVE (a
 * charge is +, a credit is −) while our sheet states the SAME adjustment PREMIUM-POSITIVE (+ improves
 * the price — its own words, at SHEET_FICO_CLTV). Eight of eight observable families are EXACT
 * negations, so taking the magnitude is the frame conversion, and the itemized-LLPA agreement of §2.15
 * holds for a real reason. Restoring the sign without converting the frame would have flipped every
 * parsed value and broken a comparison that is currently correct.
 *
 * WHAT IS ACTUALLY WRONG is that the relationship was IMPLICIT: nothing stated it, nothing enforced it,
 * and a family that ever broke it would pass the magnitude comparison silently while the money moved by
 * 2x the adjustment. This suite turns the accident into a stated, enforced invariant — and pins the
 * dependency, so a future reader who "fixes" the sign stripping is told what else must move with it.
 *
 * THE EVIDENCE is `scripts/fixtures/lp-raw-adjustment-signs.json`: the VENDOR RAW values, captured live
 * 2026-08-18 across four scoped Deephaven searches, before any parsing touched them.
 *
 * SCOPE, stated rather than implied: the eight families the four scenarios could reach at one CLTV
 * band. `5 Year Prepay Penalty` and `NDC Margin - 0.25%` are deliberately NOT held to the invariant —
 * neither is a rate-sheet LLPA (the prepay block is added separately and the margin is ours, not the
 * sheet's) — and they are listed as recorded exclusions so the set cannot quietly shrink.
 *
 * PURE: no DB, no network. LT-only. No RTL imports.
 */
const fs = require('fs');
const path = require('path');
const { SHEET_TABLES } = require('../src/longterm/ppe/deephaven-dscr-sheet');
const client = require('../src/longterm/lenderprice/client');

let pass = 0; const fails = [];
function ok(cond, msg) { if (cond) pass += 1; else fails.push(msg); }

const FIX = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'lp-raw-adjustment-signs.json'), 'utf8'));
const T = SHEET_TABLES;

// Not a rate-sheet LLPA — recorded so the exclusion is deliberate and visible, never a silent skip.
const NOT_SHEET_LLPA = [
  { re: /^\d+ Year Prepay Penalty$/, why: 'the prepay block is priced separately (--with-prepay), not a cell of this sheet' },
  { re: /^NDC Margin/, why: 'our own margin/holdback, not an adjustment the sheet states' },
];

// "…/ CLTV >65.01 % <= 70.0 %" -> the index of the sheet's CLTV band. The sheet's bands are stated as
// half-open [min,max) on the .5 boundaries; Lender Price states the same edge as X.01/Y.0, so the band
// is matched on its UPPER edge. Returns null when the text names no band (a flat family).
function cltvIndexOf(key) {
  const m = /<=\s*([0-9]+(?:\.[0-9]+)?)\s*%/.exec(String(key));
  if (!m) return null;
  const upper = Number(m[1]);
  const i = T.CLTV_BANDS.findIndex((b) => Math.abs(b.max - (upper + 0.5)) < 1e-9);
  return i >= 0 ? i : null;
}

// LP's key -> the sheet's own signed value for the same cell. null = we cannot resolve it (reported,
// never guessed), which fails the coverage assertion rather than passing quietly.
function sheetValueFor(key) {
  const k = String(key);
  const ci = cltvIndexOf(k);
  const fico = /^DSCR \(All\) - (\d+) - (\d+)/.exec(k);
  if (fico) {
    const lo = Number(fico[1]);
    const row = T.FICO_BANDS.findIndex((b) => b.min === lo);
    if (row < 0 || ci == null) return null;
    return T.FICO_CLTV[row][ci];
  }
  if (/^DSCR Ratio - DSCR >= 1\.25/.test(k)) return T.DSCR_GE125;
  if (/^Other - Cash Out Refinance, FICO >= 720/.test(k)) return ci == null ? null : T.CASHOUT_GE720[ci];
  if (/^Other - Condo/.test(k)) return ci == null ? null : T.CONDO[ci];
  if (/^Other - 2-4 Units/.test(k)) return ci == null ? null : T.UNITS[ci];
  if (/^Other - Interest Only/.test(k)) return ci == null ? null : T.IO[ci];
  if (/^Other - Escrow Waiver/.test(k)) return ci == null ? null : T.ESCROW[ci];
  if (/^Other - State of/.test(k)) return T.STATE;
  return null;
}

// ---- A. THE FIXTURE IS REAL VENDOR DATA ----------------------------------------------------------
ok(Array.isArray(FIX.rows) && FIX.rows.length >= 10, `A1 the capture carries its rows (got ${(FIX.rows || []).length})`);
ok(FIX.rows.some((r) => r.raw < 0) && FIX.rows.some((r) => r.raw > 0),
  'A2 …and carries BOTH signs, so the invariant below is not vacuous');
ok(FIX.rows.every((r) => typeof r.raw === 'number' && Number.isFinite(r.raw)),
  'A3 …as real numbers, exactly as the vendor sent them');

// ---- B. THE INVARIANT: LP raw === −(sheet value), family by family -------------------------------
const excluded = []; const unresolved = []; const checked = []; const broken = [];
for (const r of FIX.rows) {
  const ex = NOT_SHEET_LLPA.find((n) => n.re.test(r.key));
  if (ex) { excluded.push(r.key); continue; }
  const sheet = sheetValueFor(r.key);
  if (sheet == null) { unresolved.push(r.key); continue; }
  checked.push(r.key);
  // EXACT, to the cent — not a tolerance. A frame relationship that holds "approximately" is not one.
  if (Math.abs(r.raw + sheet) > 1e-9) broken.push(`${r.key}: LP ${r.raw} vs sheet ${sheet} (sum ${r.raw + sheet})`);
}
ok(unresolved.length === 0, `B1 every captured family resolves to a sheet cell — unresolved: ${unresolved.join(' | ')}`);
ok(checked.length >= 8, `B2 the invariant is checked against a real number of families (got ${checked.length})`);
ok(broken.length === 0, `B3 Lender Price's value is the EXACT negation of the sheet's, family by family — broken: ${broken.join(' | ')}`);

// The exclusions must stay REAL: a pattern matching nothing is a stale record.
for (const n of NOT_SHEET_LLPA) {
  ok(FIX.rows.some((r) => n.re.test(r.key)), `B4 the recorded exclusion ${n.re} still matches a captured row (${n.why})`);
}
ok(excluded.length + checked.length === FIX.rows.length,
  `B5 every captured row is either checked or recorded as excluded — ${FIX.rows.length} rows, ${checked.length} checked, ${excluded.length} excluded`);

// Both directions are actually exercised, or the invariant would pass on a one-sided sample.
ok(checked.some((k) => (FIX.rows.find((r) => r.key === k) || {}).raw > 0),
  'B6 a family where LP is POSITIVE and the sheet is negative is covered (a charge)');
ok(checked.some((k) => (FIX.rows.find((r) => r.key === k) || {}).raw < 0),
  'B7 a family where LP is NEGATIVE and the sheet is positive is covered (a credit)');

// ---- C. THE DEPENDENCY THIS PINS -----------------------------------------------------------------
// `num` strips the sign, which is what performs the conversion. Assert the behaviour so anyone who
// changes it is sent here — the parity doc explains what else must move with it.
const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'longterm', 'lenderprice', 'client.js'), 'utf8');
ok(/function num\(v\)[^\n]*replace\(\/\[\^0-9\.\]\/g/.test(src),
  'C1 client.num still strips every non-digit — the step that converts Lender Price\'s frame to the sheet\'s');
ok(/CHARGE-POSITIVE|charge-positive/.test(src),
  'C2 …and the source says so where a reader will meet it, rather than leaving it to be rediscovered');

// ---- D. WHAT IT WOULD COST TO GET THIS WRONG -----------------------------------------------------
// Stated as a number rather than a warning: a family whose frames were NOT opposite would be read
// 2x its own size away from the truth, and the magnitude comparison could not see it.
const sample = FIX.rows.find((r) => /^Other - 2-4 Units/.test(r.key));
ok(sample && Math.abs(sample.raw) > 0, 'D1 a real family is available to state the cost against');
if (sample) {
  const sheet = sheetValueFor(sample.key);
  ok(Math.abs(sample.raw - sheet) === Math.abs(2 * sample.raw),
    `D2 getting the frame wrong on "${sample.key}" would move the price by ${Math.abs(2 * sample.raw)} points — twice the adjustment`);
}

console.log(`${fails.length ? 'FAIL' : 'PASS'} — LLPA sign frames guard: ${pass} passed, ${fails.length} failed`);
for (const f of fails) console.log('  ✗', f);
process.exit(fails.length ? 1 : 0);
