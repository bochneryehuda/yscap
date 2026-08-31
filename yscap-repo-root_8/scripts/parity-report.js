'use strict';
/**
 * THE SIDE-BY-SIDE REPORT — what the short-term side does, and whether the
 * long-term side does it too.
 *
 * Owner-directed 2026-08-31: *"start a full side-to-side comparison … Each and
 * every feature, side-to-side comparison on the FileContacts side, on the
 * [orders], and on the entity, to make sure that every single feature that is
 * available on the short-term side, every single guard, every single way of
 * operating, is also on the long-term side."*
 *
 * This is the half a PERSON reads. `scripts/test-rtl-lt-parity-pure.js` is the
 * half that fails the build when a new one-sided capability appears with nobody
 * having decided about it.
 *
 * Reads only files — no database, no network. Run: node scripts/parity-report.js
 */

const measure = require('../src/lib/parity/measure');
const { SURFACES, entryFor } = require('../src/lib/parity/ledger');

const files = measure.sourceFiles();
const reach = {
  rtl: measure.reachableFrom(measure.productRoots(files, 'rtl')),
  lt: measure.reachableFrom(measure.productRoots(files, 'lt')),
};

const MARK = { shared: 'both', 'n/a': 'n/a ', gap: 'GAP ', worker: 'auto' };
const totals = { both: 0, shared: 0, 'n/a': 0, gap: 0, worker: 0 };
const gaps = [];

for (const surface of SURFACES) {
  console.log(`\n${'═'.repeat(78)}\n  ${surface.name}\n${'═'.repeat(78)}`);
  for (const mod of surface.modules) {
    const rows = measure.measureModule(mod, { files, reach });
    if (!rows.length) continue;
    console.log(`\n  ${mod}`);
    for (const r of rows) {
      if (!r.rtlDirect && !r.ltDirect) continue;          // nothing uses it either side
      if (r.rtlDirect && r.ltDirect) {
        totals.both += 1;
        console.log(`    both  ${r.name}`);
        continue;
      }
      const e = entryFor(mod, r.name);
      const v = e ? e.verdict : 'gap';
      totals[v] += 1;
      const side = r.rtlDirect ? 'short-term only' : 'long-term only';
      console.log(`    ${MARK[v]}  ${r.name}  (${side})`);
      if (e) console.log(`          ${e.why}`);
      else console.log('          NOT IN THE LEDGER — nobody has decided about this one yet.');
      if (v === 'gap') gaps.push({ surface: surface.name, mod, name: r.name, why: e ? e.why : null });
    }
  }
}

console.log(`\n${'═'.repeat(78)}`);
console.log(`  ${totals.both} used by both · ${totals.shared} long-term has through a shared module `
  + `· ${totals.worker} one company-wide worker does for both `
  + `· ${totals['n/a']} belongs to a surface long-term does not have · ${totals.gap} still missing`);
console.log('═'.repeat(78));

if (gaps.length) {
  console.log('\nSTILL MISSING ON THE LONG-TERM SIDE:\n');
  for (const g of gaps) console.log(`  • [${g.surface}] ${g.name}\n      ${g.why || '(no reason recorded)'}\n`);
} else {
  console.log('\nNothing is missing — every short-term capability has a long-term answer.\n');
}
