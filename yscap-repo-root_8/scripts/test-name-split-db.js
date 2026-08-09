/* Real-database tests for the borrower name split (db/345 + lib/name-heal).
 * Run: DATABASE_URL=... node scripts/test-name-split-db.js
 * Skips cleanly with no DATABASE_URL (mirrors every other DB-gated test here).
 *
 * A pure test cannot catch a wrong column name — every raw column this touches is
 * exercised against a real Postgres, which is the lesson from the #248
 * `b.full_name` phantom-column class.
 */
const N = require('../src/lib/person-name');

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) pass++; else { fail++; console.log(`FAIL ${name}`); } };
const eq = (name, got, exp) => {
  const g = JSON.stringify(got), e = JSON.stringify(exp);
  if (g === e) { pass++; } else { fail++; console.log(`FAIL ${name}\n  got      ${g}\n  expected ${e}`); }
};

if (!process.env.DATABASE_URL) {
  console.log('test-name-split-db: SKIP (no DATABASE_URL)');
  process.exit(0);
}

const db = require('../src/db');
const heal = require('../src/lib/name-heal');

const TAG = 'nsplit-test';
const email = (n) => `${TAG}-${n}-${Date.now()}-${Math.floor(process.hrtime()[1] / 1000)}@example.invalid`;

async function mkBorrower(first, last, extra = {}) {
  const r = await db.query(
    `INSERT INTO borrowers (first_name, last_name, email, middle_name, name_suffix, name_split_checked_at)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [first, last, email(Math.random().toString(36).slice(2)), extra.middle || null, extra.suffix || null,
      extra.checked || null]);
  return r.rows[0].id;
}
const read = async (id) => (await db.query(
  `SELECT first_name, middle_name, last_name, name_suffix, name_review_needed, name_review_reason, name_split_checked_at
     FROM borrowers WHERE id=$1`, [id])).rows[0];

/* DRAIN THE QUEUE, DON'T TAKE ONE CAPPED PASS.
   `healBorrowerNamesOnce` is a GLOBAL sweep over `borrowers` with a row LIMIT,
   ORDER BY created_at ASC — it does not know about this fixture. EVERY borrower
   any other suite creates joins the same queue, because a fresh row starts
   unchecked (the very first assertion in this file relies on that), and this
   fixture's rows are the NEWEST, so they sort LAST. On a database carrying more
   unchecked borrowers than the cap they sit past it entirely and are never looked
   at — so one pass proves nothing about them, and the suite would report the
   SPLITTER as broken when nothing is wrong with it. Measured: 5,200 seeded
   borrowers made FIVE assertions here fail, "merged first name is split" among
   them. Draining first makes every assertion about THIS fixture again instead of
   about how busy the database happens to be.
   Bounded, and it says so rather than spinning: every row a pass reads is stamped
   (split, flagged or skipped), so the queue strictly shrinks and this terminates. */
const drain = async () => {
  for (let i = 0; i < 60; i++) {
    const p = await heal.healBorrowerNamesOnce({ limit: 5000 });
    if (!p || !p.looked) return;
  }
  ok('the name back-fill drained rather than spinning', false);
};

(async () => {
  try {
    // ── The columns really exist and hold what we think ────────────────────
    {
      const id = await mkBorrower('Issac Michael', 'Grunzweig');
      const before = await read(id);
      ok('a fresh row starts unchecked', before.name_split_checked_at === null);
      ok('and unflagged', before.name_review_needed === false);
    }

    // ── The backfill splits a merged first name ────────────────────────────
    {
      const id = await mkBorrower('Issac Michael', 'Grunzweig');
      await drain();
      const r = await read(id);
      eq('merged first name is split',
        { f: r.first_name, m: r.middle_name, l: r.last_name },
        { f: 'Issac', m: 'Michael', l: 'Grunzweig' });
      ok('a three-word split asks a human to confirm', r.name_review_needed === true);
      ok('and records why', r.name_review_reason === 'three_words');
      ok('and the row is stamped as looked-at', !!r.name_split_checked_at);
      // The plain-language prompt the staff screen shows must be a sentence.
      ok('the prompt reads like a sentence', /^[A-Z].*[.]$/.test(N.reviewText(r.name_review_reason)));

      // IDEMPOTENT: a second pass must not touch it again.
      const stamp = r.name_split_checked_at;
      await drain();
      const again = await read(id);
      eq('a second pass changes nothing',
        { f: again.first_name, m: again.middle_name, l: again.last_name, s: String(again.name_split_checked_at) },
        { f: 'Issac', m: 'Michael', l: 'Grunzweig', s: String(stamp) });
    }

    // ── A suffix wrongly stored as the surname is recovered ────────────────
    {
      const id = await mkBorrower('John Michael Smith', 'Jr');
      await drain();
      const r = await read(id);
      eq('suffix recovered out of the last name',
        { f: r.first_name, m: r.middle_name, l: r.last_name, s: r.name_suffix },
        { f: 'John', m: 'Michael', l: 'Smith', s: 'Jr.' });
    }

    // ── A clean two-word name is left completely alone ─────────────────────
    {
      const id = await mkBorrower('Dov', 'Steiner');
      await drain();
      const r = await read(id);
      eq('a clean name is untouched',
        { f: r.first_name, m: r.middle_name, l: r.last_name, rev: r.name_review_needed },
        { f: 'Dov', m: null, l: 'Steiner', rev: false });
      ok('but it is stamped so it is never re-walked', !!r.name_split_checked_at);
    }

    // ── Placeholder / shadow rows are never split and never nag ────────────
    {
      const id = await mkBorrower('Unknown', 'Unknown');
      await drain();
      const r = await read(id);
      eq('a placeholder profile is left alone and never flagged',
        { f: r.first_name, l: r.last_name, rev: r.name_review_needed },
        { f: 'Unknown', l: 'Unknown', rev: false });
    }

    // ── A row that already carries a middle name is never re-split ─────────
    {
      const id = await mkBorrower('Issac', 'Grunzweig', { middle: 'Michael' });
      await drain();
      const r = await read(id);
      eq('an already-split row is untouched',
        { f: r.first_name, m: r.middle_name, l: r.last_name },
        { f: 'Issac', m: 'Michael', l: 'Grunzweig' });
    }

    // ── THE INVARIANT: a repair only ever rearranges, never restates ───────
    {
      const ids = [];
      for (const [f, l] of [['Maria Elena Sofia', 'Rodriguez'], ['Ludwig van', 'Beethoven'],
        ['Rabbi Moshe', 'Klein'], ['Sean', "O'Brien"], ['Anna Maria', 'Lopez-Garcia']]) {
        ids.push({ id: await mkBorrower(f, l), was: `${f} ${l}` });
      }
      await drain();
      for (const { id, was } of ids) {
        const r = await read(id);
        const now = N.joinFullName({ first: r.first_name, middle: r.middle_name, last: r.last_name, suffix: r.name_suffix });
        const key = (s) => String(s).toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
        // A courtesy title is the ONE thing deliberately dropped.
        const expected = key(was).replace(/^(rabbi|dr|mr|mrs|ms|rev|prof)\s+/, '');
        ok(`"${was}" keeps every word it had`, key(now) === expected);
      }
    }

    // ── The ClickUp round trip: one line in, three fields out, one line back ──
    {
      const mapper = require('../src/clickup/mapper');
      const F = require('../src/clickup/fields');
      const task = { id: 't1', name: 'ignored - 1 Main St', status: 'starting',
        custom_fields: [{ id: F.SHARED.borrowerName, value: 'Issac Michael Grunzweig' }] };
      const read1 = mapper.readTaskFields(task, {});
      eq('ClickUp one-liner reads into three fields',
        { f: read1.borrower.first_name, m: read1.borrower.middle_name, l: read1.borrower.last_name },
        { f: 'Issac', m: 'Michael', l: 'Grunzweig' });
      ok('and the uncertain split is marked for a human',
        read1.borrower._nameSplit && read1.borrower._nameSplit.needsReview === true);

      const built = mapper.buildTaskFields({ app: {}, borrower: {
        first_name: 'Issac', middle_name: 'Michael', last_name: 'Grunzweig' } }, {});
      const nameOut = built.customFields.find((c) => c.id === F.SHARED.borrowerName);
      eq('and the three fields join back into the one ClickUp line', nameOut && nameOut.value, 'Issac Michael Grunzweig');

      // NO CHURN: ClickUp still holding the short form is the SAME person, so an
      // ordinary repush suppresses the write instead of rewriting the card (or
      // being blocked by the PII shield and queuing a pointless review).
      ok('a repush over ClickUp\'s shorter name is a no-op',
        mapper.fieldValueEquivalent(F.SHARED.borrowerName, 'Issac Grunzweig', 'Issac Michael Grunzweig', {}) === true);
      // ...but a DELIBERATE human name edit still writes through.
      ok('a deliberate name edit still writes through',
        mapper.fieldValueEquivalent(F.SHARED.borrowerName, 'Issac Grunzweig', 'Issac Michael Grunzweig', {},
          { humanEditKeys: ['middle_name'] }) === false);
      ok('and an approved sync review writes through too',
        mapper.fieldValueEquivalent(F.SHARED.borrowerName, 'Issac Grunzweig', 'Issac Michael Grunzweig', {},
          { approvedReview: true }) === false);
      // A genuinely different person is never suppressed.
      ok('a different person is never a no-op',
        mapper.fieldValueEquivalent(F.SHARED.borrowerName, 'Peter Grunzweig', 'Issac Michael Grunzweig', {}) === false);
    }

    // ── The Encompass comparison stops false-blocking the term sheet ───────
    {
      const rec = require('../src/encompass/reconcile');
      const loan = { applications: [{ borrower: { firstName: 'Issac', middleName: 'Michael', lastName: 'Grunzweig' } }] };
      const row = { b_first_name: 'Issac', b_middle_name: 'Michael', b_last_name: 'Grunzweig', property_address: null };
      const found = rec._internals && rec._internals.compareIdentity
        ? rec._internals.compareIdentity(row, loan) : null;
      if (found) {
        const nameRow = found.find((f) => f.key === 'id_borrower_name');
        eq('a split name matches Encompass exactly', nameRow && nameRow.status, 'match');
        const merged = rec._internals.compareIdentity(
          { b_first_name: 'Issac Michael', b_last_name: 'Grunzweig', property_address: null }, loan);
        const mrow = merged.find((f) => f.key === 'id_borrower_name');
        ok('and a legacy merged name still matches rather than holding the term sheet',
          mrow && mrow.status === 'match');
        const other = rec._internals.compareIdentity(
          { b_first_name: 'Peter', b_last_name: 'Grunzweig', property_address: null }, loan);
        const orow = other.find((f) => f.key === 'id_borrower_name');
        ok('a genuinely different borrower still mismatches', orow && orow.status === 'mismatch');
      } else {
        console.log('  (compareIdentity not exported — Encompass name compare covered by test-encompass-reader)');
      }
    }
    // ── REAL HTTP: the whole round trip through the staff doors ───────────
    // "Returned 200 but didn't save" is the #1 recurring bug class in this repo,
    // so every write is re-read and asserted, not trusted.
    {
      const http = require('http');
      const C = require('../src/lib/crypto');
      const app = require('../src/server');
      const server = app.listen(0);
      await new Promise((r) => server.once('listening', r));
      const call = (method, path, token, body) => new Promise((resolve, reject) => {
        const data = body ? JSON.stringify(body) : null;
        const r = http.request({ method, path, port: server.address().port, host: '127.0.0.1',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`,
            ...(data ? { 'content-length': Buffer.byteLength(data) } : {}) } },
        (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, body: b ? JSON.parse(b) : null })); });
        r.on('error', reject); if (data) r.write(data); r.end();
      });
      try {
        const sfx = `${process.pid}-${Math.floor(Math.random() * 1e6)}`;
        const staffId = (await db.query(
          `INSERT INTO staff_users (email,full_name,role,is_active,mfa_enabled,password_hash,token_version)
           VALUES ($1,'Name Split Admin','super_admin',true,false,'x',0) RETURNING id`,
          [`${TAG}-admin-${sfx}@test.local`])).rows[0].id;
        const tok = C.signJwt({ sub: staffId, kind: 'staff', role: 'super_admin', tv: 0 });
        const bId = await mkBorrower('Placeholderfirst', 'Placeholderlast');

        // 1) THE ONE BIG NAME FIELD: type the whole name into one box.
        const r1 = await call('PATCH', `/api/staff/borrowers/${bId}`, tok, { fullName: 'Issac Michael Grunzweig' });
        ok('typing one full name is accepted', r1.status === 200);
        const a1 = await read(bId);
        eq('and it is stored as three separate fields',
          { f: a1.first_name, m: a1.middle_name, l: a1.last_name },
          { f: 'Issac', m: 'Michael', l: 'Grunzweig' });
        const g1 = (await db.query(`SELECT full_name FROM borrowers WHERE id=$1`, [bId])).rows[0];
        eq('and the big field reads back as the whole name', g1.full_name, 'Issac Michael Grunzweig');
        ok('a name PILOT had to judge still asks for a look', a1.name_review_needed === true);

        // 2) The staff screen sees the big field AND the parts.
        const got = await call('GET', `/api/staff/borrowers/${bId}`, tok, null);
        ok('the profile returns the whole name', got.status === 200 && got.body.full_name === 'Issac Michael Grunzweig');
        ok('and the middle name', got.body.middle_name === 'Michael');
        ok('and the please-check flag', got.body.name_review_needed === true);

        // 3) Confirming the split clears the prompt and changes nothing else.
        const r2 = await call('PATCH', `/api/staff/borrowers/${bId}`, tok, { confirmNameSplit: true });
        ok('confirming the split is accepted', r2.status === 200);
        const a2 = await read(bId);
        ok('the prompt is gone', a2.name_review_needed === false);
        eq('and the name is untouched',
          { f: a2.first_name, m: a2.middle_name, l: a2.last_name },
          { f: 'Issac', m: 'Michael', l: 'Grunzweig' });

        // 4) Typing the PARTS updates the big field, and clears its own prompt.
        const r3 = await call('PATCH', `/api/staff/borrowers/${bId}`, tok,
          { firstName: 'Issac', middleName: 'Menachem', lastName: 'Grunzweig', nameSuffix: 'Jr.' });
        ok('editing the parts is accepted', r3.status === 200);
        const g3 = (await db.query(`SELECT full_name, name_review_needed FROM borrowers WHERE id=$1`, [bId])).rows[0];
        eq('the big field follows the parts', g3.full_name, 'Issac Menachem Grunzweig Jr.');
        ok('and typing the parts IS the confirmation', g3.name_review_needed === false);

        // 5) A middle name may be CLEARED — it is optional, so empty is an answer.
        const r4 = await call('PATCH', `/api/staff/borrowers/${bId}`, tok, { middleName: '' });
        ok('clearing the middle name is accepted', r4.status === 200);
        const a4 = await read(bId);
        ok('and it really is cleared', a4.middle_name === null);
        const g4 = (await db.query(`SELECT full_name FROM borrowers WHERE id=$1`, [bId])).rows[0];
        eq('the big field drops it too', g4.full_name, 'Issac Grunzweig Jr.');

        // 6) A blank / placeholder name is still refused.
        const r5 = await call('PATCH', `/api/staff/borrowers/${bId}`, tok, { fullName: '   ' });
        ok('a blank full name is refused', r5.status === 400);
        const r6 = await call('PATCH', `/api/staff/borrowers/${bId}`, tok, { fullName: 'Unknown' });
        ok('a placeholder full name is refused', r6.status === 400);
        const a6 = await read(bId);
        eq('and the real name survived both refusals',
          { f: a6.first_name, l: a6.last_name }, { f: 'Issac', l: 'Grunzweig' });

        await db.query(`DELETE FROM staff_users WHERE id=$1`, [staffId]).catch(() => {});
      } finally {
        await new Promise((r) => server.close(r));
      }
    }
  } catch (e) {
    fail++; console.log('FAIL unexpected error: ' + (e && e.stack || e));
  } finally {
    try { await db.query(`DELETE FROM borrowers WHERE email LIKE $1`, [`${TAG}-%`]); } catch (_) {}
    console.log(`\ntest-name-split-db: ${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
