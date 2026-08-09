'use strict';
/**
 * THE TRACK RECORD TOOL MAY NOT DESTROY WHAT IT ONLY DISPLAYED.
 *
 * Both copies of `track-record-portal.js` map a stored row into a tool "prop"
 * and back again. The tool shows a property as flip OR hold; the DATA has three
 * real deal types (flip / hold / ground-up) and any of them can carry any of the
 * dates. So `propFromRow` assigns a `kind` the user never chose, and the save
 * used to treat that self-assigned kind as permission to blank every field
 * outside it.
 *
 * Two measured consequences, both of which change what a loan prices at:
 *
 *  1. A ground-up rented in 2022 and sold in 2026 loads as kind 'flip'. Opening
 *     the tool and pressing save — changing NOTHING by hand — sent rentDate:''.
 *     `experience.EXIT_DATE_SQL` then falls through its base rule to the ground
 *     branch and the exit moves from 2022 to 2026: an aged-out deal is carried
 *     back INSIDE the 36-month window and counts toward the tier. experience.js
 *     names that exact drift as the reason its SQL is a COALESCE and not a CASE.
 *     The SQL held. The tool destroyed the data underneath it.
 *
 *  2. 'new construction' matches neither 'hold' nor the old `/ground/i` label
 *     test, so it was rewritten to 'flip' on save — while `experience.bucketOf`
 *     counts it as GROUND (it reads '%ground%' OR '%construction%'). The ground
 *     requirement could never be met and the flip count was inflated.
 *
 * ═══ WHY THIS TEST EVALUATES THE SHIPPED SOURCE ════════════════════════════
 * These files are browser IIFEs with no exports, and they return early without
 * ?portal=1/?staff=1 — so they cannot be required. Re-typing the two functions
 * here would test a copy and prove nothing about what ships. Instead the real
 * slice is cut out of each file and evaluated, so a regression in EITHER copy
 * fails this test. The anchors are asserted before the slice is used: a slice
 * that silently came back empty would make every assertion below vacuous.
 */
const fs = require('fs');
const path = require('path');
/* Required up front so its module-load warning (it pulls in src/db, which logs
   when DATABASE_URL is unset) lands once at the top rather than interleaved with
   the assertions below. Nothing here connects — only `bucketOf`, a pure
   function, is used, and section 5 exists precisely so the label this tool
   writes and the bucket the server counts it in can never drift apart. */
const { bucketOf } = require('../src/lib/experience');

const ROOT = path.join(__dirname, '..');
const COPIES = [
  'web/v2/tools/track-record-portal.js',   // canonical (V2/PILOT)
  'web/tools/track-record-portal.js',      // V1, frozen for STYLING — this is a data bug
];

let pass = 0; let fail = 0;
const ok = (cond, what) => { if (cond) { pass++; } else { fail++; console.error(`  FAIL ${what}`); } };
const eq = (a, b, what) => ok(a === b, `${what} — got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);

/** Cut the two mapping functions out of the real file and make them callable. */
function loadMappers(rel) {
  const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const from = src.indexOf('  function dstr(');
  const endAnchor = '    out.llcId = llc ? llc.id : null;';
  const to = src.indexOf(endAnchor);
  if (from < 0) throw new Error(`${rel}: start anchor missing — the guard cannot run`);
  if (to < 0) throw new Error(`${rel}: end anchor missing — the guard cannot run`);
  if (to <= from) throw new Error(`${rel}: anchors reordered — the guard would be vacuous`);
  const slice = src.slice(from, to + endAnchor.length) + '\n    return out;\n  }\n';
  /* `llcByName` lives elsewhere in the file and only decides the entity link,
     which this test says nothing about. Everything else the slice touches is
     inside it. */
  // eslint-disable-next-line no-new-func
  const make = new Function(`
    "use strict";
    function llcByName() { return null; }
    ${slice}
    return { propFromRow: propFromRow, payloadFromProp: payloadFromProp };
  `);
  return make();
}

/** A stored row, as the server hands it back. */
const row = (over) => Object.assign({
  id: 7,
  property_address: { street: '62 Highland St', city: 'Lakewood', state: 'NJ', zip: '08701' },
  deal_type: 'flip',
  purchase_price: 285000, purchase_date: '2023-04-11',
  sale_price: 415000, sale_date: '2024-02-20',
  rent_amount: null, rent_date: null, refi_amount: null, refi_date: null,
  current_value: null, rehab_amount: null, entity_name: 'MW Trading LLC',
  owned_personally: false, property_type: null, notes: '', lo_notes: '',
  is_verified: false, verification_status: 'pending',
}, over || {});

for (const rel of COPIES) {
  console.log(`\n── ${rel}`);
  const M = loadMappers(rel);
  const roundTrip = (r) => M.payloadFromProp(M.propFromRow(r));

  /* ── 1. THE NO-OP SAVE. Load it, save it, change nothing. ─────────────── */
  {
    /* The measured case: a ground-up that was rented AND later sold. */
    const p = roundTrip(row({
      deal_type: 'ground-up',
      rent_amount: 3200, rent_date: '2022-10-09',
      sale_price: 690000, sale_date: '2026-06-10',
    }));
    eq(p.rentDate, '2022-10-09', 'ground-up + sale: a no-op save keeps rent_date');
    eq(p.rentAmount, '3200', 'ground-up + sale: a no-op save keeps rent_amount');
    eq(p.saleDate, '2026-06-10', 'ground-up + sale: a no-op save keeps sale_date');
    eq(p.dealType, 'ground-up', 'ground-up + sale: a no-op save keeps the deal type');

    /* The same property BEFORE it sold — this one loads as kind 'hold', so the
       sale side is the one at risk. Both directions must be safe. */
    const q = roundTrip(row({
      deal_type: 'ground-up', sale_price: null, sale_date: null,
      rent_amount: 3200, rent_date: '2022-10-09',
    }));
    eq(q.rentDate, '2022-10-09', 'ground-up, unsold: keeps rent_date');
    eq(q.dealType, 'ground-up', 'ground-up, unsold: keeps the deal type');

    /* A hold carrying a stale sale date keeps it — the tool is not the place a
       value the user cannot see gets deleted. */
    const h = roundTrip(row({ deal_type: 'fix-and-hold', rent_date: '2024-01-05', rent_amount: 2400 }));
    eq(h.saleDate, '2024-02-20', 'hold: a no-op save keeps a sale date the view does not show');
    eq(h.dealType, 'fix-and-hold', 'hold: a no-op save keeps the deal type');
  }

  /* ── 2. EVERY SPELLING SURVIVES, not just the two we thought of. ───────── */
  {
    for (const dt of ['new construction', 'ground up construction', 'ground-up',
      'fix-and-hold', 'fix and hold', 'flip', 'BRRRR', 'rental']) {
      const p = roundTrip(row({ deal_type: dt }));
      eq(p.dealType, dt, `a no-op save keeps the label "${dt}" verbatim`);
    }
  }

  /* ── 3. A DELIBERATE SWITCH STILL CLEARS THE OTHER SIDE. ───────────────── */
  {
    const prop = M.propFromRow(row({ deal_type: 'flip' }));
    eq(prop.kind, 'flip', 'a flip loads as kind flip');
    prop.kind = 'hold';                       // the user moves the toggle
    prop.rent = '2400'; prop.rentDate = '2024-06-01';
    const p = M.payloadFromProp(prop);
    eq(p.dealType, 'fix-and-hold', 'switching to hold re-labels the deal');
    eq(p.saleDate, '', 'switching to hold clears the sale date the user abandoned');
    eq(p.salePrice, '', 'switching to hold clears the sale price');
    eq(p.rentDate, '2024-06-01', 'switching to hold keeps what the user just typed');

    const prop2 = M.propFromRow(row({ deal_type: 'fix-and-hold', rent_date: '2024-01-05', rent_amount: 2400 }));
    eq(prop2.kind, 'hold', 'a hold loads as kind hold');
    prop2.kind = 'flip';
    prop2.salePrice = '415000'; prop2.saleDate = '2025-02-02';
    const q = M.payloadFromProp(prop2);
    eq(q.dealType, 'flip', 'switching to flip re-labels the deal');
    eq(q.rentDate, '', 'switching to flip clears the rent date the user abandoned');
  }

  /* ── 4. A BRAND-NEW PROPERTY has nothing to preserve. ──────────────────── */
  {
    const p = M.payloadFromProp({ kind: 'flip', address: '1 New St', salePrice: '100', saleDate: '2025-01-01' });
    eq(p.rentDate, '', 'a new flip sends no rent date');
    eq(p.dealType, 'flip', 'a new flip is labelled flip');
    const q = M.payloadFromProp({ kind: 'hold', address: '2 New St', rent: '900', rentDate: '2025-01-01' });
    eq(q.saleDate, '', 'a new hold sends no sale date');
    eq(q.dealType, 'fix-and-hold', 'a new hold is labelled fix-and-hold');
  }

  /* ── 5. THE LABEL THIS TOOL WRITES MUST LAND IN THE BUCKET IT MEANS. ────
     The tool and `experience.bucketOf` are two separate readings of one string;
     if they disagree the screen says one thing and the count does another. */
  {
    const prop = M.propFromRow(row({ deal_type: 'flip' }));
    prop.kind = 'hold';
    eq(bucketOf(M.payloadFromProp(prop).dealType), 'holds',
      'the label the tool writes for a hold counts as a hold');
    const prop2 = M.propFromRow(row({ deal_type: 'fix-and-hold' }));
    prop2.kind = 'flip';
    eq(bucketOf(M.payloadFromProp(prop2).dealType), 'flips',
      'the label the tool writes for a flip counts as a flip');
    /* And the preserved spellings keep counting where the server put them. */
    eq(bucketOf(roundTrip(row({ deal_type: 'new construction' })).dealType), 'ground',
      '"new construction" still counts as ground after a no-op save');
    eq(bucketOf(roundTrip(row({ deal_type: 'ground-up' })).dealType), 'ground',
      '"ground-up" still counts as ground after a no-op save');
  }
}

console.log(`\n${fail ? 'FAILED' : 'PASSED'} — ${pass} assertions, ${fail} failures`);
process.exit(fail ? 1 : 0);
