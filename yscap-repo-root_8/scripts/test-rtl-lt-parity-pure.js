'use strict';
/**
 * THE SIDE-BY-SIDE GATE — a short-term capability may not quietly become
 * one-sided.
 *
 * Owner-directed 2026-08-31: *"start a full side-to-side comparison of a few
 * engines that compare the condition center and the features on the condition
 * center. Each and every feature, side-to-side comparison on the FileContacts
 * side, on the [orders], and on the entity, to make sure that every single
 * feature that is available on the short-term side, every single guard, every
 * single way of operating, is also on the long-term side."*
 *
 * ── WHAT THIS FAILS ON ──────────────────────────────────────────────────────
 *
 * A capability one product uses and the other does not, with NO ENTRY in
 * `src/lib/parity/ledger.js`. Not because one-sided is wrong — plenty of it is
 * correct — but because it must be a DECISION somebody wrote down, in words a
 * non-developer can read, rather than something nobody noticed.
 *
 * And it fails the other way too: an entry that no longer describes anything
 * real. A ledger that can only grow is a ledger that stops being true, so a row
 * whose capability was deleted, renamed, or since taken up by both products
 * fails the build rather than sitting here claiming a gap that was closed.
 *
 * ── WHY THE FEATURE LIST IS NOT WRITTEN DOWN ANYWHERE ───────────────────────
 *
 * It is derived from the shared modules themselves — see `measure.js`. A list of
 * features somebody has to remember to update is exactly the thing this engine
 * exists to catch, so it must not be the engine's own shape.
 *
 * PURE: reads files, needs no database. Run: node scripts/test-rtl-lt-parity-pure.js
 */

const path = require('path');
const fs = require('fs');
const measure = require('../src/lib/parity/measure');
const { LEDGER, SURFACES, VERDICTS, entryFor } = require('../src/lib/parity/ledger');

let failures = 0;
const assert = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };

const files = measure.sourceFiles();
const reach = {
  rtl: measure.reachableFrom(measure.productRoots(files, 'rtl')),
  lt: measure.reachableFrom(measure.productRoots(files, 'lt')),
};

/* ═════════════ A. THE MEASURE ITSELF ANSWERS ABOUT SOMETHING ════════════════
   Every assertion below is worthless if the reader silently returns nothing —
   which is exactly what its first cut did for a module whose exports are
   written on one line. So the reader is checked before it is trusted. */

const allModules = SURFACES.flatMap((s) => s.modules);
assert(allModules.length >= 12, `A1 the engine compares a real set of shared modules (${allModules.length})`);
for (const m of allModules) {
  assert(fs.existsSync(path.join(measure.ROOT, m)), `A2 ${m} exists`);
}
const empties = allModules.filter((m) => measure.exportsOf(m).length === 0);
assert(empties.length === 0,
  `A3 every compared module reports its exports — a silent empty read would hide its whole surface (${empties.join(', ') || 'none empty'})`);

// The two shapes this repo writes `module.exports` in, both read.
assert(measure.exportsOf('src/lib/condition-docs/review.js').includes('claimVerdictEmail'),
  'A4 a SINGLE-LINE module.exports is read (review.js)');
assert(measure.exportsOf('src/lib/llc-edit.js').includes('setVerified'),
  'A5 a MULTI-LINE module.exports is read (llc-edit.js)');
assert(measure.exportsOf('src/lib/llc-edit.js').includes('_internals')
  && !measure.isCapability('_internals') && !measure.isCapability('VERIFIED_DOC_LOCK'),
  'A6 …and the reader sees a test seam and a constant but does not COUNT either as a capability');

/* ═════════════ B. EVERY ONE-SIDED CAPABILITY IS A RECORDED DECISION ═════════ */

const rows = [];
for (const surface of SURFACES) {
  for (const mod of surface.modules) {
    for (const r of measure.measureModule(mod, { files, reach })) {
      rows.push({ surface: surface.name, mod, ...r });
    }
  }
}
const used = rows.filter((r) => r.rtlDirect || r.ltDirect);
assert(used.length >= 50, `B0 the comparison covers a real number of capabilities (${used.length})`);

const oneSided = used.filter((r) => r.rtlDirect !== r.ltDirect);
const unrecorded = oneSided.filter((r) => !entryFor(r.mod, r.name));
assert(unrecorded.length === 0,
  `B1 every one-sided capability is recorded in the ledger${unrecorded.length
    ? `\n     UNRECORDED: ${unrecorded.map((r) => `${r.mod}:${r.name}`).join(', ')}` : ''}`);

for (const r of oneSided) {
  const e = entryFor(r.mod, r.name);
  if (!e) continue;
  assert(VERDICTS.includes(e.verdict), `B2 ${r.name}: the verdict is one of the three (${e.verdict})`);
  assert(typeof e.why === 'string' && e.why.trim().length >= 40,
    `B3 ${r.name}: it says WHY, in a sentence a non-developer can read`);
  if (e.verdict === 'shared') {
    assert(typeof e.via === 'string' && e.via,
      `B4 ${r.name}: a "long-term has it anyway" claim NAMES the shared module it comes through`);
    /* AND THE CLAIM IS CHECKED. "It reaches it through X" is only worth
       something if the product really does reach X — otherwise this verdict
       becomes the place gaps go to be forgotten. */
    if (e.via) {
      const side = r.rtlDirect ? 'lt' : 'rtl';
      assert(reach[side].has(e.via),
        `B5 ${r.name}: the ${side === 'lt' ? 'long' : 'short'}-term side really does reach ${e.via}`);
    }
  }
}

/* ═════════════ C. THE LEDGER CANNOT GO STALE ════════════════════════════════ */

const realNames = new Set(rows.map((r) => `${r.mod}:${r.name}`));
const oneSidedNames = new Set(oneSided.map((r) => `${r.mod}:${r.name}`));
const stale = [];
const closed = [];
for (const [mod, entries] of Object.entries(LEDGER)) {
  for (const name of Object.keys(entries)) {
    const key = `${mod}:${name}`;
    if (!realNames.has(key)) stale.push(key);
    else if (!oneSidedNames.has(key)) closed.push(key);
  }
}
assert(stale.length === 0,
  `C1 no ledger row names a capability that no longer exists${stale.length ? `\n     STALE: ${stale.join(', ')}` : ''}`);
assert(closed.length === 0,
  `C2 no ledger row describes a capability BOTH products now use — a closed gap must leave the ledger${closed.length ? `\n     CLOSED: ${closed.join(', ')}` : ''}`);

/* ═════════════ D. THE GAPS ARE VISIBLE, NOT HIDDEN ══════════════════════════
   A gap is not a failure — nobody has decided to build it yet, and that is the
   owner's call. What would be a failure is a gap nobody can see, so the count is
   PRINTED on every run and the report names each one. */

const gaps = oneSided.filter((r) => (entryFor(r.mod, r.name) || {}).verdict === 'gap');
console.log(`\n  ${used.length} shared capabilities compared · ${oneSided.length} one-sided · ${gaps.length} still missing on the long-term side`);
for (const g of gaps) console.log(`     · [${g.surface}] ${g.name}`);
assert(true, 'D1 the still-missing list is printed on every run, so a gap can never be silent');

console.log(failures ? `\nFAILED ${failures} assertion(s)` : '\nOK test-rtl-lt-parity-pure (all assertions passed)');
process.exit(failures ? 1 : 0);
