'use strict';
/**
 * scripts/test-elementix-deep-history-db.js — the deep track-record search and
 * the automatic Elementix → borrower-profile import (owner-directed 2026-08-19).
 *
 * REAL POSTGRES, STUBBED VENDOR — the same discipline as the profile suite: the
 * database half is where this can be wrong in ways no pure test sees (a phantom
 * column, a constraint the auto-import trips, the db/485 guard interacting with
 * a blank deal type), and the vendor is stubbed because a test must never spend
 * the office's shared allowance.
 *
 * What is proven, in order:
 *   1. A borrower LINKED to an Elementix person is searched by PERSON ID —
 *      fully paged (a full page of 250 asks for page 2) — and the name-based
 *      person search is NOT run beside it.
 *   2. The person's company roster lands on the profile: a stated role imports
 *      (with the db/400 adoption stamp + formation state), no stated role and
 *      a PERSON row are skipped with reasons.
 *   3. The recorded deals land on the track record UNVERIFIED: a bought-and-
 *      sold pair as the flip the deeds state; a purchase-only with the deal
 *      type LEFT BLANK and a note; a deed granted to their company (vendor
 *      person-flag false) recognised through the profile and LINKED to the
 *      entity; a mortgage refinance filled onto its property.
 *   4. Nothing unsafe moves: a durable DECLINE is not re-raised, an exact match
 *      onto a VERIFIED line is left for a human (never reopened), an exact
 *      match onto an unverified line fills its blanks, and a second search
 *      imports nothing twice.
 *   5. The cache door: a built profile imports from the sections cache with a
 *      provenance search row; a borrower with no cache writes NOTHING; the
 *      backfill sweep stamps both shapes and skips a retired row.
 */

const assert = require('assert');

if (!process.env.DATABASE_URL) {
  console.log('· test-elementix-deep-history-db: no DATABASE_URL — skipped');
  process.exit(0);
}

const db = require('../src/db');
const client = require('../src/elementix/client');
const lookups = require('../src/lib/elementix/lookups');
const importer = require('../src/lib/track-record/importer');
const deep = require('../src/lib/elementix/deep-history');

const PID = '77777777-7777-4777-8777-777777777777';
const PID2 = '88888888-8888-4888-8888-888888888888';

let n = 0;
const ok = (msg) => { n += 1; console.log(`  ✓ ${msg}`); };

// ---------------------------------------------------------------------------
// The vendor, stubbed at the transport. lookups.call runs for real (allowlist,
// contract preflight, dry-run rule); only the wire is replaced.
// ---------------------------------------------------------------------------
const calls = [];
const D = (id, addr, date, amount, extra) => ({
  id, countyDocumentId: id, recordingDate: date, totalConsideration: amount,
  addresses: [{ id: `a-${id}`, addressFull: addr }],
  grantees: ['MOSES WEIL TEST'], grantors: ['SOMEBODY ELSE'], isGrantee: true, isGrantor: false,
  ...extra,
});

const FILLERS = [];
for (let i = 0; i < 244; i += 1) {
  FILLERS.push(D(`fill-${i}`, `${1000 + i} Filler Way, Trenton, NJ 08601`, '2024-02-01', 100000 + i));
}
const DEEDS_PAGE_1 = [
  // 1. bought AND sold — the records state a flip.
  D('da1', '12 Alpha St, Newark, NJ 07102', '2024-03-01', 300000),
  D('da2', '12 Alpha St, Newark, NJ 07102', '2025-05-01', 450000,
    { grantees: ['A BUYER'], grantors: ['MOSES WEIL TEST'], isGrantee: false, isGrantor: true }),
  // 2. purchase only — the records do NOT say the plan; type stays blank.
  D('db1', '34 Beta Ave, Newark, NJ 07103', '2024-06-01', 250000),
  // 3. exact match to a VERIFIED line already on the record.
  D('dc1', '77 Kent Ave, Brooklyn, NY 11249', '2023-01-01', 500000),
  // 4. matches a durable DECLINE — must not come back.
  D('dd1', '9 Delta Rd, Newark, NJ 07104', '2024-01-01', 200000),
  // 5. granted to THEIR COMPANY; the vendor's person-flag says the PERSON is
  //    not the grantee. Recognised through the profile's entities.
  D('de1', '55 Echo St, Newark, NJ 07105', '2024-04-01', 350000,
    { grantees: ['MW TRADING LLC'], isGrantee: false }),
  // 6. exact match to an UNVERIFIED line with a blank purchase price — fills.
  D('df1', '21 Zeta St, Newark, NJ 07106', '2022-02-02', 175000),
  // 7. NEAR match — a hyphenated (Queens-style) house number, one of the
  //    forced-review shapes. Must be left for a human, never auto-decided.
  D('dh1', '150-25 78th Rd, Flushing, NY 11367', '2021-03-03', 160000),
  // 8. A SELF-TRANSFER — a $10 quit-claim from the person into their own LLC,
  //    ONE deed, both sides theirs, NO vendor flags (real person rows carry
  //    none — pre-merge audit 2026-08-19). Must never read as a bought-and-
  //    sold flip: no figures, blank type, and the note says why.
  D('di1', '3 Quitclaim Ct, Newark, NJ 07109', '2025-01-15', 10,
    { grantors: ['MOSES WEIL TEST'], grantees: ['MW TRADING LLC'], isGrantee: undefined, isGrantor: undefined }),
  // 9. A grantee that is an unspaced RESPACING of the borrower's own name —
  //    the entity matcher calls it theirs, and the own-name guard must refuse
  //    to mint a person-named "company" from it (audit, matcher asymmetry).
  D('dj1', '4 Respace Rd, Newark, NJ 07110', '2024-05-05', 90000,
    { grantees: ['MOSESWEIL TEST'], isGrantee: undefined, isGrantor: undefined }),
  ...FILLERS,
];
const DEEDS_PAGE_2 = [D('dg1', '88 Gamma Blvd, Newark, NJ 07107', '2024-09-09', 400000)];

const MORTGAGES = [{
  id: 'm1', countyDocumentId: 'm1', recordingDate: '2025-07-01', mortgageAmount: 200000,
  borrowerNames: ['MOSES WEIL TEST'], isRefinance: true, loanPurpose: 'refinance',
  addresses: [{ id: 'a-m1', addressFull: '34 Beta Ave, Newark, NJ 07103' }],
}];

const ENTITIES = [
  { id: 'e0000000-0000-4000-8000-000000000001', name: 'MW TRADING LLC', state: 'NJ', isPrincipal: true },
  { id: 'e0000000-0000-4000-8000-000000000002', name: 'SIGNER ONLY LLC', state: 'PA', elementixSigner: true },
  { id: 'e0000000-0000-4000-8000-000000000003', name: 'NO ROLE LLC', state: 'NJ' },
  { id: 'e0000000-0000-4000-8000-000000000004', name: 'A RECORDED PERSON', state: 'NJ', entityType: 'PERSON', isPrincipal: true },
];

client.callTool = async (tool, args, opts) => {
  calls.push({ tool, args, opts });
  assert.notStrictEqual(tool, 'submit_contact_enrichment', 'the deep search must never reach the paid tool');
  switch (tool) {
    case 'get_person_deeds':
      return { ok: true, data: args.page === 2 ? { data: DEEDS_PAGE_2 } : { data: DEEDS_PAGE_1, nextPage: 2 } };
    case 'get_person_mortgages':
      return { ok: true, data: { data: MORTGAGES } };
    case 'get_person_entities':
      return { ok: true, data: { data: ENTITIES } };
    // The pre-existing, human-entered company still gets its one-by-one search.
    case 'search':
      return { ok: true, data: { results: [] } };
    case 'match_entity':
      return { ok: true, data: { status: 'none' } };
    default:
      return { ok: false, reason: 'unknown_tool', detail: `unexpected tool ${tool}` };
  }
};

// ---------------------------------------------------------------------------

async function main() {
  // ── fixtures ──────────────────────────────────────────────────────────────
  const officer = (await db.query(
    `INSERT INTO staff_users (email, full_name, role, password_hash)
     VALUES ('deep-history-test@yscap.test', 'Deep History Tester', 'loan_officer', 'x')
     ON CONFLICT (email) DO UPDATE SET full_name = EXCLUDED.full_name
     RETURNING id`)).rows[0].id;

  await db.query(`DELETE FROM borrowers WHERE email IN ('deep1@test.local','deep2@test.local','deep3@test.local')`);
  const bor = (await db.query(
    `INSERT INTO borrowers (first_name, last_name, email, elementix_person_id)
     VALUES ('Moses', 'Weil Test', 'deep1@test.local', $1) RETURNING id`, [PID])).rows[0].id;

  // A pre-existing, human-entered company (no adoption stamp).
  await db.query(`DELETE FROM llcs WHERE borrower_id = $1`, [bor]);
  await db.query(`INSERT INTO llcs (borrower_id, llc_name) VALUES ($1, 'OLD HAND LLC')`, [bor]);

  // A VERIFIED line at 77 Kent Ave and an UNVERIFIED one at 21 Zeta St.
  await db.query(`DELETE FROM track_records WHERE borrower_id = $1`, [bor]);
  const t1 = (await db.query(
    `INSERT INTO track_records (borrower_id, property_address, address_key, deal_type, purchase_price, purchase_date, sale_price, sale_date)
     VALUES ($1, $2::jsonb, '', 'flip', 480000, '2023-01-01', 700000, '2024-06-01') RETURNING id`,
    [bor, JSON.stringify({ line1: '77 Kent Ave', city: 'Brooklyn', state: 'NY', zip: '11249', oneLine: '77 Kent Ave, Brooklyn, NY 11249' })])).rows[0].id;
  await db.query(`UPDATE track_records SET is_verified=true, verification_status='verified', verified_at=now() WHERE id=$1`, [t1]);
  const t2 = (await db.query(
    `INSERT INTO track_records (borrower_id, property_address, address_key, deal_type, purchase_date)
     VALUES ($1, $2::jsonb, '', 'flip', '2022-02-02') RETURNING id`,
    [bor, JSON.stringify({ line1: '21 Zeta St', city: 'Newark', state: 'NJ', zip: '07106', oneLine: '21 Zeta St, Newark, NJ 07106' })])).rows[0].id;
  // The near-match target: a hyphenated house number is one house in Queens, so
  // an identical-looking deed is a question for a human, never an auto-bind.
  await db.query(
    `INSERT INTO track_records (borrower_id, property_address, address_key, deal_type, purchase_price, purchase_date)
     VALUES ($1, $2::jsonb, '', 'fix-and-hold', 155000, '2021-03-03')`,
    [bor, JSON.stringify({ line1: '150-25 78th Rd', city: 'Flushing', state: 'NY', zip: '11367', oneLine: '150-25 78th Rd, Flushing, NY 11367' })]);

  // A durable decline at 9 Delta Rd.
  await db.query(`DELETE FROM track_record_candidates WHERE borrower_id = $1`, [bor]);
  await db.query(
    `INSERT INTO track_record_candidates (borrower_id, source, raw, property_address, dedupe_key, status, match_confidence)
     VALUES ($1, 'elementix', '{}'::jsonb, $2::jsonb, 'addr:legacy-delta', 'declined', 'none')`,
    [bor, JSON.stringify('9 Delta Rd, Newark, NJ 07104')]);

  await db.query(`DELETE FROM elementix_person_sections WHERE person_id IN ($1,$2)`, [PID, PID2]);
  await db.query(`DELETE FROM elementix_person_aliases WHERE person_id IN ($1,$2) OR alias_person_id IN ($1,$2)`, [PID, PID2]);
  await db.query(`DELETE FROM elementix_persons WHERE person_id IN ($1,$2)`, [PID, PID2]);
  await db.query(`INSERT INTO elementix_persons (person_id, display_name, primary_state) VALUES ($1,'MOSES WEIL TEST','NJ')`, [PID]);

  // -------------------------------------------------------------------------
  console.log('\n1. The linked borrower is searched by PERSON ID, fully paged');
  // -------------------------------------------------------------------------
  const out = await importer.runSearch({ borrowerId: bor, staffId: officer, states: [] });

  assert.strictEqual(out.ok, true);
  const deedCalls = calls.filter((c) => c.tool === 'get_person_deeds');
  assert.strictEqual(deedCalls.length, 2, 'a FULL first page asked for page 2');
  assert.strictEqual(deedCalls[0].args.perPage, 250, 'the deep pull asks for the profile builder\'s own page size');
  assert.ok(!calls.some((c) => c.tool === 'match_person'
      || (c.tool === 'search' && c.args && c.args.entityFilter === 'person')),
  'the NAME-based person search did not run — the linked id is a strictly better identity');
  ok('person-id pull, 250 a page, page 2 fetched, no name search beside it');

  assert.ok(out.elementix, 'the result reports the deep pull');
  assert.ok(out.summary.includes('From their Elementix profile'), `the summary says what was imported: ${out.summary}`);
  assert.ok(out.searchedUnder.includes('their linked Elementix profile'), 'searchedUnder names the profile');
  ok('the search summary carries the import, in plain words');

  // -------------------------------------------------------------------------
  console.log('\n2. The company roster lands on the profile — with the guards');
  // -------------------------------------------------------------------------
  const llcs = (await db.query(
    `SELECT llc_name, adopted_source, adopted_at, formation_state FROM llcs WHERE borrower_id=$1 ORDER BY llc_name`, [bor])).rows;
  const mw = llcs.find((l) => l.llc_name === 'MW TRADING LLC');
  const signer = llcs.find((l) => l.llc_name === 'SIGNER ONLY LLC');
  assert.ok(mw, 'the principal\'s company was added');
  assert.ok(signer, 'the signer\'s company was added');
  assert.strictEqual(mw.adopted_source, 'elementix', 'held out of provable funds until documented (db/400 stamp)');
  assert.ok(mw.adopted_at, 'the adoption stamp is dated');
  assert.strictEqual(mw.formation_state, 'NJ', 'the formation state came from the vendor record');
  assert.ok(!llcs.find((l) => l.llc_name === 'NO ROLE LLC'), 'no stated role → not added');
  assert.ok(!llcs.find((l) => l.llc_name === 'A RECORDED PERSON'), 'a PERSON row is never a company');
  const oldHand = llcs.find((l) => l.llc_name === 'OLD HAND LLC');
  assert.ok(oldHand && !oldHand.adopted_at, 'the human\'s own company is never stamped');
  assert.strictEqual(out.elementix.entitiesAdded, 2);
  assert.ok(!llcs.find((l) => /weil test/i.test(l.llc_name)),
    'a deed in the borrower\'s OWN name never mints a person-named "company"');
  assert.strictEqual(llcs.length, 3, `exactly OLD HAND + the two imported (got ${llcs.map((l) => l.llc_name).join(', ')})`);
  ok('2 companies added with the adoption stamp + state; no-role, person-row, the human\'s own and the borrower\'s own name left alone');

  // -------------------------------------------------------------------------
  console.log('\n3. The recorded deals land UNVERIFIED, and nothing is guessed');
  // -------------------------------------------------------------------------
  const lines = (await db.query(
    `SELECT deal_type, is_verified, verification_status, entered_by_kind, llc_id, notes,
            property_address->>'oneLine' AS one_line, purchase_price, sale_price, refi_date, refi_amount
       FROM track_records WHERE borrower_id=$1`, [bor])).rows;

  const alpha = lines.find((l) => (l.one_line || '').startsWith('12 Alpha St'));
  assert.ok(alpha, 'the bought-and-sold property is on the record');
  assert.strictEqual(alpha.deal_type, 'flip', 'a deed pair imports as the flip the records state');
  assert.strictEqual(alpha.is_verified, false, 'imported lines are NEVER verified');
  assert.strictEqual(alpha.verification_status, 'pending');
  assert.strictEqual(alpha.entered_by_kind, 'staff');
  ok('bought-and-sold → a flip, pending verification');

  const beta = lines.find((l) => (l.one_line || '').startsWith('34 Beta Ave'));
  assert.ok(beta, 'the purchase-only property is on the record');
  assert.strictEqual(beta.deal_type, null, 'the deal type is LEFT BLANK — never guessed');
  assert.ok(/set the deal type/i.test(beta.notes || ''), 'and the note asks for it');
  assert.strictEqual(beta.refi_date, '2025-07-01', 'the refinance off the mortgage record filled in');
  ok('purchase-only → blank type with a note; the refinance rode in from the mortgage list');

  const echo = lines.find((l) => (l.one_line || '').startsWith('55 Echo St'));
  assert.ok(echo, 'the deed granted to THEIR company was recognised despite the vendor person-flag');
  assert.strictEqual(String(echo.llc_id), String((await db.query(
    `SELECT id FROM llcs WHERE borrower_id=$1 AND llc_name='MW TRADING LLC'`, [bor])).rows[0].id),
  'and the line is LINKED to that company');
  ok('a company-held deed stages through the profile and links to its entity');

  assert.ok(!lines.find((l) => (l.one_line || '').startsWith('9 Delta Rd')),
    'the durable decline stayed declined');
  const declineSkip = out.skips.find((s) => s.reason === 'declined_before');
  assert.ok(declineSkip, 'and the skip says why');
  ok('a property somebody said is not theirs is never re-raised');

  const zeta = lines.find((l) => (l.one_line || '').startsWith('21 Zeta St'));
  assert.strictEqual(Number(zeta.purchase_price), 175000, 'the exact match FILLED the unverified line\'s blank');
  const zetaCount = lines.filter((l) => (l.one_line || '').startsWith('21 Zeta St')).length;
  assert.strictEqual(zetaCount, 1, 'filled, never duplicated');
  ok('an exact match onto an unverified line fills its blanks — one line, not two');

  const kent = (await db.query(
    `SELECT is_verified, verification_status FROM track_records WHERE id=$1`, [t1])).rows[0];
  assert.strictEqual(kent.is_verified, true, 'the VERIFIED line was not reopened');
  const kentStaged = (await db.query(
    `SELECT status FROM track_record_candidates WHERE borrower_id=$1 AND property_address::text LIKE '%Kent Ave%'`, [bor])).rows;
  assert.ok(kentStaged.some((r) => r.status === 'staged'), 'its candidate is LEFT for a human');
  assert.ok(out.elementix.leftForReview >= 1);
  ok('an exact match onto a VERIFIED line waits for a person — the sign-off stands');

  const nearRow = (await db.query(
    `SELECT status, match_confidence FROM track_record_candidates
      WHERE borrower_id=$1 AND property_address::text LIKE '%78th Rd%'`, [bor])).rows[0];
  assert.ok(nearRow, 'the hyphenated-house-number deed was staged');
  assert.strictEqual(nearRow.match_confidence, 'near', 'and banded NEAR — a forced-review shape');
  assert.strictEqual(nearRow.status, 'staged', 'a NEAR match is never auto-decided');
  const near78 = lines.filter((l) => (l.one_line || '').includes('78th Rd'));
  assert.strictEqual(near78.length, 1, 'no second line was minted for it');
  ok('a near match waits for a human — auto-merging one is how a duplicate line is born');

  // THE AUDIT'S REPRODUCTION — the $10 quit-claim into their own LLC.
  const qc = lines.find((l) => (l.one_line || '').startsWith('3 Quitclaim Ct'));
  assert.ok(qc, 'the transferred property is on the record (it IS theirs)');
  assert.strictEqual(qc.deal_type, null, 'but a one-deed transfer is NEVER read as a flip');
  assert.strictEqual(qc.purchase_price, null, 'the $10 consideration never became a purchase price');
  assert.strictEqual(qc.sale_price, null, 'nor a sale price');
  assert.ok(/set the deal type/i.test(qc.notes || ''), 'the line asks for the type');
  assert.ok(/only recorded deed is a transfer/i.test(qc.notes || ''),
    'and the WHY on the line names the transfer — never "a purchase but no sale" the records don\'t show');
  const qcCand = (await db.query(
    `SELECT internal_notes FROM track_record_candidates WHERE borrower_id=$1 AND property_address::text LIKE '%Quitclaim%'`, [bor])).rows[0];
  assert.ok(/transfer between the borrower and their own company/i.test(qcCand.internal_notes || ''),
    'and the candidate says why there are no figures');
  ok('a self-transfer deed contributes identity, never economics — no phantom flip');

  const respace = lines.find((l) => (l.one_line || '').startsWith('4 Respace Rd'));
  assert.ok(respace, 'the respaced-own-name deed still imported (the deal is theirs)');
  assert.strictEqual(respace.llc_id, null, 'with NO entity link');
  assert.ok(!(await db.query(
    `SELECT 1 FROM llcs WHERE borrower_id=$1 AND llc_name ILIKE '%MOSESWEIL%'`, [bor])).rows.length,
  'and no person-named "company" was minted from the respaced spelling');
  ok('the own-name guard refuses both matchers\' spellings of the borrower');

  // The whole book: 255 deed rows → 254 candidates (the buy+sell pair is one
  // property) − the declined one − the verified-line exact match − the near
  // match − the unverified exact match (a fill, not a new line)
  // = 250 new lines, plus the three pre-existing ones.
  const total = (await db.query(`SELECT count(*)::int AS n FROM track_records WHERE borrower_id=$1`, [bor])).rows[0].n;
  assert.strictEqual(total, 3 + 250, `every pageful landed (got ${total})`);
  assert.strictEqual(out.elementix.imported, 250);
  assert.strictEqual(out.elementix.merged, 1);
  assert.strictEqual(out.elementix.leftForReview, 2, 'the verified-line match AND the near match both wait');
  ok(`249 new lines + 1 fill + 2 left for review — the full two-page pull (${total} lines on the record)`);

  // THE HELD-BACK COMPANY IS COUNTED, NEVER SILENT — one aggregate row.
  const noRoleSkip = out.skips.find((s) => s.reason === 'no_stated_role');
  assert.ok(noRoleSkip && /1 company/.test(noRoleSkip.why), 'the no-role company is reported as a counted aggregate');
  assert.strictEqual(out.elementix.entitiesNoRole, 1, 'and counted on the result');
  ok('a company held back for no stated role is one counted line, not silence');

  // -------------------------------------------------------------------------
  console.log('\n4. Running it AGAIN imports nothing twice');
  // -------------------------------------------------------------------------
  const before = calls.length;
  const out2 = await importer.runSearch({ borrowerId: bor, staffId: officer, states: [] });
  const totalAfter = (await db.query(`SELECT count(*)::int AS n FROM track_records WHERE borrower_id=$1`, [bor])).rows[0].n;
  assert.strictEqual(totalAfter, total, 'not one duplicate line');
  assert.strictEqual(out2.elementix.imported, 0);
  assert.ok(calls.length > before, 'it did re-read the vendor (a fresh search is a fresh read)');
  const covered = out2.skips.find((s) => s.reason === 'covered_by_linked_profile');
  assert.ok(covered, 'the imported companies are not re-searched one by one');
  ok('idempotent end to end, and the imported companies ride the profile pull instead of per-company searches');

  // ── 4b. A FAILED deep pull is never recorded as a search that happened ────
  // (second audit 2026-08-19: `searchedUnder` listed the profile whenever the
  //  id EXISTED, even when the pull failed — and keying it on the run must not
  //  turn "the pull failed" into "you gave us nothing to search".)
  const liveStub = client.callTool;
  client.callTool = async (tool, args, opts) => {
    calls.push({ tool, args, opts });
    if (/^get_person_(deeds|mortgages|entities)$/.test(tool)) return { ok: false, reason: 'error', detail: 'vendor 500' };
    return liveStub(tool, args, opts);
  };
  const outFail = await importer.runSearch({ borrowerId: bor, staffId: officer, states: [] });
  client.callTool = liveStub;
  assert.ok(!outFail.searchedUnder.includes('their linked Elementix profile'),
    'a failed pull is not listed as searched-under');
  assert.strictEqual(outFail.nothingToSearch, false,
    'and the file still plainly HAD identities to search under');
  assert.ok(outFail.skips.some((s) => /Elementix profile/i.test(s.entity || '') || /Elementix profile/i.test(s.why || '')),
    'the failure itself is reported in the skips');
  const totalAfterFail = (await db.query(`SELECT count(*)::int AS n FROM track_records WHERE borrower_id=$1`, [bor])).rows[0].n;
  assert.strictEqual(totalAfterFail, total, 'and a failed pull imported nothing');
  ok('a failed deep pull is reported as a failure — never recorded as a search that ran');

  // -------------------------------------------------------------------------
  console.log('\n5. The cache door + the backfill sweep');
  // -------------------------------------------------------------------------
  const bor2 = (await db.query(
    `INSERT INTO borrowers (first_name, last_name, email, elementix_person_id)
     VALUES ('Cache', 'Import Test', 'deep2@test.local', $1) RETURNING id`, [PID2])).rows[0].id;
  const bor3 = (await db.query(
    `INSERT INTO borrowers (first_name, last_name, email, elementix_person_id)
     VALUES ('No', 'Cache Test', 'deep3@test.local', '99999999-9999-4999-8999-999999999999') RETURNING id`)).rows[0].id;

  await db.query(`INSERT INTO elementix_persons (person_id, display_name, primary_state) VALUES ($1,'CACHE IMPORT TEST','NJ')`, [PID2]);
  await db.query(
    `INSERT INTO elementix_person_sections (person_id, section, state, payload, row_count)
     VALUES ($1,'deeds','',$2::jsonb,2), ($1,'entities','',$3::jsonb,1)`,
    [PID2,
      JSON.stringify({ rows: [
        D('cx1', '5 Cache Ct, Newark, NJ 07108', '2024-01-05', 111000, { grantees: ['CACHE IMPORT TEST'] }),
        D('cx2', '5 Cache Ct, Newark, NJ 07108', '2025-01-05', 222000,
          { grantees: ['A BUYER'], grantors: ['CACHE IMPORT TEST'], isGrantee: false, isGrantor: true }),
      ] }),
      JSON.stringify({ rows: [{ id: 'e0000000-0000-4000-8000-000000000009', name: 'CACHE HOLDINGS LLC', state: 'NJ', isPrincipal: true }] })]);

  const noCache = await deep.importFromCache({ borrowerId: bor3, personId: '99999999-9999-4999-8999-999999999999', staffId: officer });
  assert.strictEqual(noCache.nothing, true, 'no cached profile → nothing imported');
  const phantom = (await db.query(`SELECT count(*)::int AS n FROM track_record_searches WHERE borrower_id=$1`, [bor3])).rows[0].n;
  assert.strictEqual(phantom, 0, 'and NO phantom "we searched" row is written');
  ok('a borrower with no cached profile gains nothing — not even a search row');

  const fromCache = await deep.importFromCache({ borrowerId: bor2, personId: PID2, staffId: officer });
  assert.strictEqual(fromCache.imported, 1, 'the cached deed pair became a line');
  assert.strictEqual(fromCache.entitiesAdded, 1);
  const cacheLine = (await db.query(
    `SELECT deal_type, is_verified FROM track_records WHERE borrower_id=$1`, [bor2])).rows[0];
  assert.strictEqual(cacheLine.deal_type, 'flip');
  assert.strictEqual(cacheLine.is_verified, false);
  const provenance = (await db.query(
    `SELECT query->>'source' AS src, found_count FROM track_record_searches WHERE borrower_id=$1`, [bor2])).rows[0];
  assert.strictEqual(provenance.src, 'elementix_profile_import', 'the provenance row names where these came from');
  const stamped = (await db.query(`SELECT elementix_history_imported_at FROM borrowers WHERE id=$1`, [bor2])).rows[0];
  assert.ok(stamped.elementix_history_imported_at, 'the borrower is stamped imported');
  ok('a cached profile imports at zero vendor cost, with a provenance row and the db/597 stamp');

  // The sweep: bor3 (no cache) gets stamped quietly; a retired row is ignored.
  await db.query(`UPDATE borrowers SET elementix_history_import_attempts = 3 WHERE email='deep1@test.local'`);
  const sweep = await deep.backfillOnce({ limit: 50 });
  const b3 = (await db.query(`SELECT elementix_history_imported_at FROM borrowers WHERE id=$1`, [bor3])).rows[0];
  assert.ok(b3.elementix_history_imported_at, 'the sweep stamped the nothing-cached borrower done');
  assert.ok(sweep.checked >= 1);
  const b1row = (await db.query(`SELECT elementix_history_imported_at FROM borrowers WHERE email='deep1@test.local'`)).rows[0];
  assert.strictEqual(b1row.elementix_history_imported_at, null, 'a retired row (3 attempts) is left alone');
  ok('the sweep drains itself and never head-blocks on a retired row');

  // importAfterBuild fans out to the linked borrower(s).
  await db.query(`UPDATE borrowers SET elementix_history_imported_at = NULL WHERE id=$1`, [bor2]);
  const after = await deep.importAfterBuild({ personId: PID2, staffId: officer });
  assert.strictEqual(after.length, 1);
  assert.strictEqual(String(after[0].borrowerId), String(bor2));
  ok('a profile build lands on every linked borrower');

  // -------------------------------------------------------------------------
  console.log('\n6. The entity cap spends on CREATION — "run again" is really true');
  // -------------------------------------------------------------------------
  process.env.ELEMENTIX_IMPORT_MAX_ENTITIES = '1';
  const three = [
    { id: 'e0000000-0000-4000-8000-000000000021', name: 'CAP ONE LLC', state: 'NJ', isPrincipal: true },
    { id: 'e0000000-0000-4000-8000-000000000022', name: 'CAP TWO LLC', state: 'NJ', isPrincipal: true },
    { id: 'e0000000-0000-4000-8000-000000000023', name: 'CAP THREE LLC', state: 'NJ', isPrincipal: true },
  ];
  const cap1 = await deep.importEntities({ borrowerId: bor2, entityRows: three });
  assert.strictEqual(cap1.added, 1, 'the first pass creates up to the cap');
  assert.strictEqual(cap1.overCap, 2, 'and counts what is waiting');
  assert.ok(cap1.skipped.some((s) => s.reason === 'over_cap' && /2 compan/.test(s.name) && /2 more are waiting/.test(s.why)),
    'as ONE aggregate line, not one row per company');
  assert.ok(cap1.skipped.some((s) => s.reason === 'over_cap' && /Only 1 new company is added/.test(s.why)),
    'and the wording reads correctly at a cap of one');
  const cap2 = await deep.importEntities({ borrowerId: bor2, entityRows: three });
  assert.strictEqual(cap2.matched, 1, 'a company already on the profile matches for FREE');
  assert.strictEqual(cap2.added, 1, 'so the second pass creates the NEXT one — the promise is true');
  const cap3 = await deep.importEntities({ borrowerId: bor2, entityRows: three });
  assert.strictEqual(cap3.added, 1, 'and the third finishes the roster');
  assert.strictEqual(cap3.overCap, 0);
  delete process.env.ELEMENTIX_IMPORT_MAX_ENTITIES;
  ok('the cap counts creations, matches are free, and re-running genuinely adds the rest');

  // -------------------------------------------------------------------------
  console.log('\n7. A sweep import (no actor) records honest authorship');
  // -------------------------------------------------------------------------
  const PID3 = 'aaaaaaaa-1111-4111-8111-111111111111';
  await db.query(`DELETE FROM borrowers WHERE email='deep4@test.local'`);
  const bor4 = (await db.query(
    `INSERT INTO borrowers (first_name, last_name, email, elementix_person_id)
     VALUES ('System', 'Sweep Test', 'deep4@test.local', $1) RETURNING id`, [PID3])).rows[0].id;
  await db.query(`INSERT INTO elementix_persons (person_id, display_name) VALUES ($1,'SYSTEM SWEEP TEST') ON CONFLICT DO NOTHING`, [PID3]);
  await db.query(
    `INSERT INTO elementix_person_sections (person_id, section, state, payload, row_count)
     VALUES ($1,'deeds','',$2::jsonb,2)`,
    [PID3, JSON.stringify({ rows: [
      D('sw1', '6 Sweep St, Newark, NJ 07111', '2024-02-02', 120000, { grantees: ['SYSTEM SWEEP TEST'] }),
      D('sw2', '6 Sweep St, Newark, NJ 07111', '2025-02-02', 180000,
        { grantees: ['A BUYER'], grantors: ['SYSTEM SWEEP TEST'], isGrantee: false, isGrantor: true }),
    ] })]);
  const sys = await deep.importFromCache({ borrowerId: bor4, personId: PID3, staffId: null });
  assert.strictEqual(sys.imported, 1);
  const sysLine = (await db.query(
    `SELECT entered_by_kind FROM track_records WHERE borrower_id=$1`, [bor4])).rows[0];
  assert.strictEqual(sysLine.entered_by_kind, 'system', 'the line says a machine entered it');
  const sysCand = (await db.query(
    `SELECT decided_by, decided_by_kind FROM track_record_candidates WHERE borrower_id=$1`, [bor4])).rows[0];
  assert.strictEqual(sysCand.decided_by, null);
  assert.strictEqual(sysCand.decided_by_kind, null, 'no phantom "staff" decider on an unattended import');
  ok('an unattended import never claims a person answered');

  // ── cleanup ───────────────────────────────────────────────────────────────
  for (const id of [bor, bor2, bor3, bor4]) {
    await db.query(`DELETE FROM track_record_candidates WHERE borrower_id=$1`, [id]);
    await db.query(`DELETE FROM track_record_searches WHERE borrower_id=$1`, [id]);
    await db.query(`DELETE FROM track_records WHERE borrower_id=$1`, [id]);
    await db.query(`DELETE FROM llc_borrowers WHERE borrower_id=$1`, [id]);
    await db.query(`DELETE FROM llcs WHERE borrower_id=$1`, [id]);
  }
  await db.query(`DELETE FROM borrowers WHERE email IN ('deep1@test.local','deep2@test.local','deep3@test.local','deep4@test.local')`);
  await db.query(`DELETE FROM elementix_person_sections WHERE person_id IN ($1,$2,$3)`, [PID, PID2, PID3]);
  await db.query(`DELETE FROM elementix_persons WHERE person_id IN ($1,$2,$3)`, [PID, PID2, PID3]);

  console.log(`\ntest-elementix-deep-history-db: all ${n} checks passed`);
  process.exit(0);
}

main().catch((e) => { console.error('FAIL:', e); process.exit(1); });
