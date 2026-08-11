'use strict';
/**
 * PHASE 2 — A TYPED ENTITY NAME BECOMES A REAL ENTITY.
 *
 * Owner-directed 2026-08-09: "any LLC that he enters should be a real LLC on his
 * profile with the operating agreement saved to it", and the reason it matters —
 * "if we verify ownership of these two LLCs, then all the ownership of all the
 * properties is verified."
 *
 * THE ASSERTION THAT CARRIES THE MOST WEIGHT is section 2: the strict matcher.
 * The blueprint said to reuse `underwriting/compare.entityMatch`, and measured
 * against real name shapes its substring arm calls "Hudson Properties LLC" and
 * "Hudson Properties LLC II" the same company. For its own advisory uses that is
 * fine. Here it would attach a property to the wrong company and then carry that
 * company's ownership verification onto it. Every pair below was measured.
 */

let fail = 0;
const ok = (c, m) => { if (c) console.log(`  ok  ${m}`); else { fail++; console.error(`  FAIL ${m}`); } };

const T = require('../src/lib/track-record-entity');
const { entityMatch } = require('../src/lib/underwriting/compare');

// ══════════════════════════════════════════════ 1. Junk never mints a company
console.log('\n1. A name that is not a company never becomes one');
{
  for (const n of ['N/A', 'na', 'none', 'NONE', 'unknown', 'TBD', 'x', 'Personal', 'self',
    'LLC', 'l.l.c.', ', LLC', '  ', '???', '---', 'A LLC']) {
    const why = T.junkEntityName(n);
    if (!why) { ok(false, `${JSON.stringify(n)} was ACCEPTED as a company name`); break; }
  }
  ok(['N/A', 'none', 'LLC', ', LLC', '  ', '???', 'x', 'Personal', 'A LLC']
    .every((n) => T.junkEntityName(n)), 'every placeholder, bare suffix and empty value is refused');

  ok(!T.junkEntityName('Smith Holdings LLC'), 'a real name is accepted');
  ok(!T.junkEntityName('JMB 2 LLC'), 'and so is a short real one with a digit');
  ok(!T.junkEntityName('Coretex'), 'an entity with no suffix at all is still a real name');
}

// ══════════════════════ 2. THE STRICT MATCHER — the one that must not over-match
console.log('\n2. Promotion is STRICTER than the advisory matcher, on purpose');
{
  // Real re-spellings of ONE company — these MUST match, or every save mints a twin.
  const same = [
    ['Smith Holdings LLC', 'Smith Holdings, L.L.C.'],
    ['Smith Holdings LLC', 'smith holdings llc'],
    ['Smith Holdings LLC', 'Smith  Holdings   LLC'],
    ['Core Tex Solutions LLC', 'Coretex Solutions LLC'],
    ['Coretex', 'Core Tex'],
    ['Maple Grove Properties Inc', 'Maple Grove Properties, Incorporated'],
  ];
  for (const [a, b] of same) {
    if (!T.promotionMatch(a, b)) { ok(false, `should MATCH but did not: ${a} <> ${b}`); }
  }
  ok(same.every(([a, b]) => T.promotionMatch(a, b)),
    'a suffix re-spelling, a case change, extra spaces and a pure re-spacing all match ONE company');

  // DIFFERENT companies the advisory matcher calls the same. Each measured.
  const different = [
    ['Hudson Properties LLC', 'Hudson Properties LLC II'],
    ['Ridge LLC', 'Blue Ridge LLC'],
    ['Oak Capital LLC', 'Oak Capital LLC Series B'],
    ['JMB LLC', 'JMB LLC 2'],
    ['Maple LLC', 'Maple LLC Properties'],
    ['Main St Holdings LLC', 'North Main St Holdings LLC'],
  ];
  const loose = different.filter(([a, b]) => entityMatch(a, b));
  ok(loose.length === different.length,
    `the advisory matcher calls all ${different.length} of these pairs the same company — which is why this test exists`);
  const leaked = different.filter(([a, b]) => T.promotionMatch(a, b));
  ok(leaked.length === 0,
    `promotionMatch refuses every one of them${leaked.length ? ` — leaked: ${leaked.map((p) => p.join(' <> ')).join('; ')}` : ''}`);

  ok(T.promotionMatch('Smith Holdings LLC', 'Jones Holdings LLC') === false,
    'and two plainly different names are still different');
}

// ═══════════════════════════════════ 3. Ambiguity writes nothing
console.log('\n3. Two possible companies means a person decides, not us');
{
  const existing = [
    { id: 'a', llc_name: 'Smith Holdings LLC' },
    { id: 'b', llc_name: 'Smith Holdings, L.L.C.' },     // a real duplicate on the profile
    { id: 'c', llc_name: 'Jones Capital LLC' },
  ];
  const two = T.pickEntity('Smith Holdings LLC', existing);
  ok(two.ambiguous === true && !two.llcId,
    'a name matching TWO of their entities picks NEITHER — a guess would attach the property to the wrong company');
  ok(Array.isArray(two.names) && two.names.length === 2, '…and reports both, so the screen can ask');

  const one = T.pickEntity('Jones Capital, LLC', existing);
  ok(one.llcId === 'c', 'exactly one match is used');

  const none = T.pickEntity('Brand New Holdings LLC', existing);
  ok(none.none === true, 'no match reports none, so the caller may create');
}

// ────────────────────────────────────────────────────────────── DB
if (!process.env.DATABASE_URL) {
  console.log('\nSKIP the database section (no DATABASE_URL)');
  console.log(fail ? `\n${fail} FAILURE(S)` : '\nOK  track-record entity promotion (pure assertions only)');
  process.exit(fail ? 1 : 0);
}
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0'.repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecrettestsecrettestsecret12';

const db = require('../src/db');
const { ensureSchema } = require('../src/migrate-boot');
const tag = `trkent_${process.pid}`;

(async () => {
  await ensureSchema();
  const borrowerId = (await db.query(
    `INSERT INTO borrowers (first_name,last_name,email) VALUES ('Ent','Tester',$1) RETURNING id`,
    [`${tag}@example.com`])).rows[0].id;

  console.log('\n4. promoteEntityName against a real database');
  {
    const r1 = await T.promoteEntityName(borrowerId, 'Willow Creek Holdings LLC');
    ok(!!r1.llcId && r1.created === true, 'a new name CREATES a real entity on the profile');

    const row = (await db.query('SELECT llc_name, first_seen_on FROM llcs WHERE id=$1', [r1.llcId])).rows[0];
    ok(row.llc_name === 'Willow Creek Holdings LLC', '…with the name as typed');
    ok(row.first_seen_on === 'track_record', '…stamped with where it came from');

    const link = (await db.query(
      'SELECT ownership_verified FROM llc_borrowers WHERE llc_id=$1 AND borrower_id=$2', [r1.llcId, borrowerId])).rows[0];
    ok(!!link, 'the borrower is linked to their own entity');
    ok(link.ownership_verified === false,
      'and CHECK A IS NOT DONE — promotion sets a link, it never decides ownership');

    // The whole point: a re-spelling REUSES it rather than minting a twin.
    const r2 = await T.promoteEntityName(borrowerId, 'Willow Creek Holdings, L.L.C.');
    ok(r2.llcId === r1.llcId && r2.created === false,
      'a re-spelling of the same company REUSES it — this is what stops the entity list filling with twins');

    const r3 = await T.promoteEntityName(borrowerId, 'Willow Creek Holdings LLC II');
    ok(!!r3.llcId && r3.llcId !== r1.llcId,
      'while "… LLC II" is a DIFFERENT company and gets its own entity — the advisory matcher would have merged them');

    const junk = await T.promoteEntityName(borrowerId, 'N/A');
    ok(junk.llcId === null && junk.reason === 'placeholder', 'junk creates nothing');

    const n = (await db.query('SELECT count(*)::int AS n FROM llcs WHERE borrower_id=$1', [borrowerId])).rows[0].n;
    ok(n === 2, `exactly two entities exist after all of that (got ${n})`);

    // Ambiguity against REAL rows: force a genuine duplicate onto the profile.
    await db.query(`INSERT INTO llcs (borrower_id, llc_name) VALUES ($1,'Willow Creek Holdings, LLC')`, [borrowerId]);
    const amb = await T.promoteEntityName(borrowerId, 'Willow Creek Holdings LLC');
    ok(amb.ambiguous === true && amb.llcId === null,
      'with two matching entities on the profile it writes NOTHING and says which two');

    // It must never throw, whatever it is handed.
    for (const bad of [null, undefined, 12345, {}, 'x'.repeat(500)]) {
      const r = await T.promoteEntityName(borrowerId, bad);
      if (r === undefined || r === null) { ok(false, `promoteEntityName returned nothing for ${JSON.stringify(bad)}`); break; }
    }
    ok(true, 'and it never throws — a track record being saved is never lost to an entity failure');
    const rNoBorrower = await T.promoteEntityName(null, 'Anything LLC');
    ok(rNoBorrower.llcId === null && rNoBorrower.reason === 'no_borrower', 'no borrower, no entity');
  }

  console.log('\n5. The ClickUp writer now carries the entity it already resolved');
  {
    const src = require('fs').readFileSync(require('path').join(__dirname, '../src/clickup/ingest.js'), 'utf8');
    ok(/async function upsertTrackRecord\(borrowerId, read, taskId, llcId\)/.test(src),
      'upsertTrackRecord takes the entity');
    ok(/upsertTrackRecord\(borrowerId, read, task\.id, llcId\)/.test(src),
      'and the call site passes the llcId it resolved one line above — it used to drop it');
    /* SLICE FROM THE FUNCTION BODY, not from the first match in the file. The
       first cut used src.indexOf('RETURNING id`,') as the END of the INSERT
       slice, and that marker occurs EARLIER in the file than the INSERT does —
       so slice(start, end) with end < start returned '' and both assertions
       failed while the code was correct. An empty slice is the same hazard in
       the other direction: it can just as easily make an assertion PASS. */
    const fnStart = src.indexOf('async function upsertTrackRecord');
    const fnBody = src.slice(fnStart, src.indexOf('\nasync function', fnStart + 10));
    ok(fnStart >= 0 && fnBody.length > 500, 'upsertTrackRecord is where this test expects it');
    const ins = fnBody.slice(fnBody.indexOf('INSERT INTO track_records'));
    ok(/llc_id/.test(ins), 'the INSERT carries llc_id, so a ClickUp-created line is attached to its entity');
    const upd = fnBody.slice(fnBody.indexOf('UPDATE track_records'), fnBody.indexOf('INSERT INTO track_records'));
    ok(/llc_id IS NULL AND NOT is_verified/.test(upd),
      'and the UPDATE fills it ONLY on an unverified row — llc_id is material, so filling it on a verified line would un-verify the book on every webhook');
  }

  await db.query('DELETE FROM llc_borrowers WHERE borrower_id=$1', [borrowerId]).catch(() => {});
  await db.query('DELETE FROM llcs WHERE borrower_id=$1', [borrowerId]).catch(() => {});
  await db.query('DELETE FROM borrowers WHERE id=$1', [borrowerId]).catch(() => {});

  console.log(fail ? `\n${fail} FAILURE(S)` : '\nOK  entity promotion: one chokepoint, stricter than advisory, and it never guesses');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ERROR', e); process.exit(1); });
