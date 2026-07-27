'use strict';

/**
 * The "Fix & Flip → Fix & Hold bounces back and doesn't save" class
 * (owner-reported 2026-07-27).
 *
 * A two-way ClickUp dropdown value that PILOT can hold but ClickUp has no option
 * for was pushed as NOTHING (crosswalk → no label → mapper.put() drops it), and
 * the next inbound pull then wrote ClickUp's stale value back over the officer's
 * edit via `program = COALESCE($n, program)`. The edit saved and was reverted
 * seconds later, which reads as "the Save button does nothing".
 *
 * Pure — no DB, no network.
 */

const assert = require('assert');
const X = require('../src/clickup/crosswalk');
const guard = require('../src/lib/inbound-enum-guard');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };
const eq = (a, b, m) => { assert.strictEqual(a, b, m); n++; };

/* ---------------------------------------------------------------- crosswalk */

// THE REPORTED VALUE. 'Fix & Hold' is a real PILOT program (pricing.js prices it,
// the EMCAP tape exports it) with no ClickUp *Program option — the exact shape
// that used to be dropped in silence.
ok(X.unmappableToClickUp('program', 'Fix & Hold'), 'Fix & Hold has no ClickUp twin');
// The canonical spellings DO map — they must never be flagged.
ok(!X.unmappableToClickUp('program', 'Fix & Flip w/ Construction'), 'canonical Fix & Flip maps');
ok(!X.unmappableToClickUp('program', 'Bridge'), 'Bridge maps');
ok(!X.unmappableToClickUp('program', 'Ground-Up Construction'), 'Ground-Up maps');
// A DELIBERATE blank ('Not sure yet' → leave the ClickUp field empty) is not a
// loss and must not be reported as unmappable.
ok(!X.unmappableToClickUp('program', 'Not sure yet'), 'a deliberate blank is not unmappable');
// Empty / unknown-key inputs never flag.
ok(!X.unmappableToClickUp('program', ''), 'blank value never flags');
ok(!X.unmappableToClickUp('program', null), 'null value never flags');
ok(!X.unmappableToClickUp('not_a_field', 'whatever'), 'unknown crosswalk key never flags');
// Tolerant match: casing/spacing differences still map (they resolve to a label).
ok(!X.unmappableToClickUp('program', 'bridge'), 'lowercase bridge still maps');

// The OTHER values the same form used to offer — each was silently reverted too.
ok(X.unmappableToClickUp('property_type', 'SFR'), "'SFR' is not the canonical 'SFR (1 unit)'");
ok(!X.unmappableToClickUp('property_type', 'SFR (1 unit)'), 'canonical SFR maps');
ok(X.unmappableToClickUp('property_type', 'Multi 2-4'), 'hyphen Multi 2-4 is not the en-dash canonical');
ok(!X.unmappableToClickUp('property_type', 'Multi 2–4'), 'en-dash Multi 2–4 maps');
ok(X.unmappableToClickUp('loan_type', 'Refinance'), "bare 'Refinance' has no ClickUp twin");
ok(!X.unmappableToClickUp('loan_type', 'Refinance — Cash-Out'), 'Refinance — Cash-Out maps');
// `term` carries a defaultLabel, so an odd term still writes something.
ok(!X.unmappableToClickUp('term', 'something odd'), 'a field with a defaultLabel is never unmappable');

// With a LIVE option list: a label the crosswalk knows but ClickUp does not
// actually offer is unmappable too (the write vanishes the same way).
const noGroundUp = [{ name: 'Fix & Flip With Construction' }, { name: 'bridge Without Construction' }];
ok(X.unmappableToClickUp('program', 'Ground-Up Construction', noGroundUp),
  'a crosswalk label missing from the live ClickUp dropdown is unmappable');
ok(!X.unmappableToClickUp('program', 'Bridge', noGroundUp), 'a label present in the live list maps');
// An empty/absent option list must never produce a false positive.
ok(!X.unmappableToClickUp('program', 'Ground-Up Construction', []), 'empty option list never flags');
ok(!X.unmappableToClickUp('program', 'Ground-Up Construction', null), 'no option list never flags');

/* -------------------------------------------------------------- the guard */

const PROTECTED = guard.protectedColumns().map((c) => c.col);
ok(PROTECTED.includes('program'), 'program is protected');
ok(PROTECTED.includes('loan_type'), 'loan_type is protected');
ok(PROTECTED.includes('property_type'), 'property_type is protected');
// occupancy is pull-only in FIELD_MAP — it is not a two-way field, so the guard
// (derived from FIELD_MAP, never hand-listed) must not claim it.
ok(!PROTECTED.includes('occupancy'), 'pull-only occupancy is not protected');

// THE REGRESSION. PILOT holds Fix & Hold; ClickUp still says Fix & Flip.
{
  const cols = { program: 'Fix & Flip w/ Construction', purchase_price: 500000 };
  const held = guard.unmappableOverwrites(cols, { program: 'Fix & Hold' });
  eq(held.length, 1, 'the unmappable program overwrite is caught');
  eq(held[0].field, 'program', 'it names the program column');
  eq(held[0].kept, 'Fix & Hold', "it keeps PILOT's value");
  eq(held[0].incoming, 'Fix & Flip w/ Construction', 'it records what ClickUp tried to write');
  ok(guard.summarize(held).includes('Fix & Hold'), 'the summary names the kept value');
}

// A value ClickUp CAN hold syncs exactly as before — this guard must be a no-op
// on every ordinary file.
{
  const cols = { program: 'Bridge' };
  eq(guard.unmappableOverwrites(cols, { program: 'Fix & Flip w/ Construction' }).length, 0,
    'a mappable portal value is left to sync normally');
}
// Same value in a different casing is not a change.
eq(guard.unmappableOverwrites({ program: 'fix & hold' }, { program: 'Fix & Hold' }).length, 0,
  'an echo of the same value is not an overwrite');
// A null incoming value is already a no-op via COALESCE.
eq(guard.unmappableOverwrites({ program: null }, { program: 'Fix & Hold' }).length, 0,
  'a null incoming value is never held');
// FILLING a blank is not a revert — nothing is being lost.
eq(guard.unmappableOverwrites({ program: 'Bridge' }, { program: null }).length, 0,
  'filling a blank program is never held');
// A column the pull is not touching is never considered.
eq(guard.unmappableOverwrites({ purchase_price: 1 }, { program: 'Fix & Hold' }).length, 0,
  'an untouched column is never held');
// Null-safety.
eq(guard.unmappableOverwrites(null, { program: 'Fix & Hold' }).length, 0, 'null cols is safe');
eq(guard.unmappableOverwrites({ program: 'Bridge' }, null).length, 0, 'null current row is safe');

// The guard MUTATES cols so the COALESCE keeps ours — proven on the shape the
// inbound pull actually builds.
{
  const cols = { program: 'Fix & Flip w/ Construction', loan_type: 'Purchase' };
  for (const h of guard.unmappableOverwrites(cols, { program: 'Fix & Hold', loan_type: 'Purchase' })) cols[h.field] = null;
  eq(cols.program, null, 'program is nulled so COALESCE keeps the portal value');
  eq(cols.loan_type, 'Purchase', 'an unrelated mappable column is untouched');
}

console.log(`test-enum-unmappable-guard: ${n} assertions passed`);
