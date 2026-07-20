/**
 * Deep-audit regression guard: numeric appraisal fields that feed fixed-precision DB columns must
 * be magnitude-bounded so a corrupt/hostile XML attribute becomes null instead of overflowing its
 * column and rolling back the entire atomic import (importAppraisalTx BEGIN/COMMIT/ROLLBACK).
 *
 * Strategy: take a REAL corpus 1004, confirm the fields extract to sane values, then string-replace
 * the flagged attribute values with an absurd 21-digit run (overflows integer AND every numeric()
 * column here) and assert each one now reads back as null (rejected), not a giant number. A separate
 * negative/zero mutation proves the signed reader PRESERVES legitimate < 0 and 0. Corpus-based,
 * DB-optional. Run: node scripts/test-appraisal-overflow-guards.js
 */
const fs = require('fs');
const path = require('path');
const { extract } = require('../src/lib/appraisal/extract');

const DIR = process.env.APPRAISAL_DIR
  || '/tmp/claude-0/-home-user-yscap/05b5356c-9672-5e08-9492-67ecffd77817/scratchpad/appraisals/stripped';
if (!fs.existsSync(DIR)) { console.log(`SKIP test-appraisal-overflow-guards (no corpus at ${DIR})`); process.exit(0); }
const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.xml')).sort();

let failures = 0;
const assert = (cond, msg) => { console.log(`${cond ? 'PASS' : 'FAIL'} ${msg}`); if (!cond) failures++; };
const BIG = '999999999999999999999';   // 21 digits — overflows integer AND every numeric() column here

// Pick a real 1004 that populates the flagged fields so the mutation actually exercises the guards.
let base = null;
for (const f of files) {
  const A = extract(fs.readFileSync(path.join(DIR, f), 'utf8'));
  const c = (A.comparables || [])[0] || {};
  if (A.subject && A.subject.units != null && A.subject.beds != null && A.subject.rooms != null
      && A.subject.bathsFull != null && A.subject.gla != null
      && c.netAdjustment != null && c.netAdjPct != null && c.grossAdjPct != null) { base = { f, A, c }; break; }
}
if (!base) { console.log('SKIP test-appraisal-overflow-guards (no fully-populated 1004 in corpus)'); process.exit(0); }
console.log(`base file: ${base.f}`);

const raw = fs.readFileSync(path.join(DIR, base.f), 'utf8');
// Overflow every flagged attribute in place. Bathroom "N.5" → "BIG.5" so bathsFull overflows.
let over = raw
  .replace(/LivingUnitCount="[^"]*"/g, `LivingUnitCount="${BIG}"`)
  .replace(/TotalBedroomCount="[^"]*"/g, `TotalBedroomCount="${BIG}"`)
  .replace(/TotalRoomCount="[^"]*"/g, `TotalRoomCount="${BIG}"`)
  .replace(/TotalBathroomCount="\d+/g, `TotalBathroomCount="${BIG}`)
  .replace(/GrossLivingAreaSquareFeetCount="[^"]*"/g, `GrossLivingAreaSquareFeetCount="${BIG}"`)
  .replace(/SalePriceTotalAdjustmentAmount="[^"]*"/g, `SalePriceTotalAdjustmentAmount="${BIG}"`)
  .replace(/SalePriceTotalAdjustmentNetPercent="[^"]*"/g, `SalePriceTotalAdjustmentNetPercent="${BIG}"`)
  .replace(/SalesPriceTotalAdjustmentGrossPercent="[^"]*"/g, `SalesPriceTotalAdjustmentGrossPercent="${BIG}"`)
  .replace(/_PER_UNIT_FEE([^>]*?)_Amount="[^"]*"/g, `_PER_UNIT_FEE$1_Amount="${BIG}"`);

const O = extract(over);
const s = O.subject || {};
assert(s.units === null, `overflowing LivingUnitCount rejected (got ${s.units})`);
assert(s.beds === null, `overflowing TotalBedroomCount rejected (got ${s.beds})`);
assert(s.rooms === null, `overflowing TotalRoomCount rejected (got ${s.rooms})`);
assert(s.bathsFull === null, `overflowing bath count rejected (got ${s.bathsFull})`);
assert(s.gla === null, `overflowing GLA rejected (got ${s.gla})`);
const oc = (O.comparables || [])[0] || {};
assert(oc.netAdjustment === null, `overflowing net adjustment rejected (got ${oc.netAdjustment})`);
assert(oc.netAdjPct === null, `overflowing net-adj pct rejected (got ${oc.netAdjPct})`);
assert(oc.grossAdjPct === null, `overflowing gross-adj pct rejected (got ${oc.grossAdjPct})`);
if (O.condo) assert(O.condo.hoaFeeAmount === null, `overflowing HOA fee rejected (got ${O.condo.hoaFeeAmount})`);

// Sanity: the untouched base file still extracts these to real (non-null) values — proves the guards
// don't reject legitimate data, and that the mutation above is what flipped them to null.
assert(base.A.subject.units > 0 && base.c.netAdjustment != null,
  `unmutated base still extracts real values (units=${base.A.subject.units}, netAdj=${base.c.netAdjustment})`);

// signed reader must PRESERVE a legitimate negative adjustment and a valid 0.
let neg = raw
  .replace(/SalePriceTotalAdjustmentAmount="[^"]*"/, 'SalePriceTotalAdjustmentAmount="-15000"')
  .replace(/SalePriceTotalAdjustmentNetPercent="[^"]*"/, 'SalePriceTotalAdjustmentNetPercent="-3.5"')
  .replace(/SalesPriceTotalAdjustmentGrossPercent="[^"]*"/, 'SalesPriceTotalAdjustmentGrossPercent="0"');
const nc = (extract(neg).comparables || [])[0] || {};
assert(nc.netAdjustment === -15000, `legitimate negative net adjustment preserved (got ${nc.netAdjustment})`);
assert(nc.netAdjPct === -3.5, `legitimate negative net-adj pct preserved (got ${nc.netAdjPct})`);
assert(nc.grossAdjPct === 0, `legitimate zero gross-adj pct preserved (got ${nc.grossAdjPct})`);

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL overflow-guard assertions passed');
process.exit(failures ? 1 : 0);
