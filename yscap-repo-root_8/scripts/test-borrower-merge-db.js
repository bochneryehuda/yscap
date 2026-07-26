/**
 * "TWO PROFILES, ONE PERSON" — duplicate compare + merge (owner-directed 2026-07-26).
 *
 * The sync deliberately OVER-SPLITS: an email it cannot corroborate mints a
 * distinct profile rather than risk hanging one person's loans and PII on
 * another. That is the right trade, but it means genuine duplicates exist and
 * until now there was no way to put them back together.
 *
 * The owner's rules, each one asserted below:
 *   • the two become ONE profile;
 *   • where the two DISAGREE on a single-valued field a human picks the winner —
 *     nothing is auto-chosen, and the API REFUSES (409) a merge with an
 *     undecided conflict;
 *   • emails and phones are not a conflict, they ADD UP;
 *   • track records ADD UP; entities (LLCs) ADD UP;
 *   • nothing is lost: every file, document and officer link follows the person.
 *
 * The regression this file exists to prevent: an earlier "clever" generic dedupe
 * predicate bound to the wrong row, so every entity looked like a duplicate of
 * itself and a REAL LLC was deleted instead of moved. The non-colliding row being
 * MOVED — not merely "the count went down" — is asserted by name.
 */
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0'.repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecrettestsecrettestsecret12';

let failures = 0, passes = 0;
const assert = (c, m) => { if (c) { passes++; } else { failures++; console.log(`FAIL ${m}`); } };

// ---- pure: the merge contract, without a database ---------------------------
{
  const M = require('../src/lib/borrower-merge');
  assert(typeof M.findDuplicates === 'function' && typeof M.compare === 'function'
    && typeof M.mergeBorrowers === 'function', 'the merge library exposes find / compare / merge');

  const keys = M.MERGE_FIELDS.map((f) => f.key);
  for (const k of ['email', 'cell_phone']) {
    assert(keys.includes(k), `${k} is offered as a choosable field (the PRIMARY one still needs an owner)`);
  }
  // Multi-valued things must never appear as a single-value "pick one" choice.
  for (const k of ['llcs', 'track_records', 'contacts', 'emails', 'phones']) {
    assert(!keys.includes(k), `${k} is never a conflict — it adds up`);
  }
  assert(keys.includes('ssn_last4') && !keys.includes('ssn_hash') && !keys.includes('ssn_encrypted'),
    'the SSN is chosen ONCE, as a unit — never as three separate columns that could disagree');
  assert(keys.includes('housing_status') && keys.includes('housing_payment') && keys.includes('current_address'),
    'the housing details the owner asked for are part of the merge, not dropped');

  const { blank, same, SPECIAL } = M._internals;
  assert(blank(null) && blank('') && blank('   ') && blank({}), 'empty in every shape counts as empty');
  assert(!blank('0') && !blank(0), 'a real zero is a VALUE, not a blank (a FICO of 0 is still an answer)');
  assert(same(' Abe ', 'Abe') && !same('Abe', 'Abraham'), 'values compare on their trimmed content');
  assert(SPECIAL['borrower_auth.borrower_id'] === 'skip', 'the login is handled by hand — one person, one login');
  for (const t of ['borrower_contacts', 'borrower_officers', 'llcs', 'track_records']) {
    assert(SPECIAL[`${t}.borrower_id`] === 'dedupe', `${t} moves dedupe-aware, never as a blind UPDATE`);
  }

  // The dedupe predicate is the thing that ate a real LLC once. Guard its shape.
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'lib', 'borrower-merge.js'), 'utf8');
  assert(/const MATCH = \{/.test(src) && /no dedupe rule for/.test(src),
    'dedupe predicates are written out per table and an unknown table REFUSES to merge');
  assert(!/IS NOT DISTINCT FROM d\./.test(src),
    'no NULL-matches-NULL predicate — two unknown keys are not a duplicate, they are two rows');
}

console.log(`test-borrower-merge: PURE ${passes} passed, ${failures} failed`);
if (failures) process.exit(1);
if (!process.env.DATABASE_URL) { console.log('  (SKIP DB — no DATABASE_URL)'); process.exit(0); }

const http = require('http');
const db = require('../src/db');
const C = require('../src/lib/crypto');
const app = require('../src/server');
const cfg = require('../src/config');
const identity = require('../src/clickup/identity');
const ssnHash = (d) => identity.ssnHash(d, cfg.ssnMatchKey);

function call(server, method, path, token, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const r = http.request({ method, path, port: server.address().port, host: '127.0.0.1',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`,
        ...(payload ? { 'content-length': Buffer.byteLength(payload) } : {}) } },
      (res) => { let b = ''; res.on('data', (c) => b += c); res.on('end', () => resolve({ status: res.statusCode, body: b ? JSON.parse(b) : null })); });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

(async () => {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const sfx = `${process.pid}-${Math.floor(Math.random() * 1e6)}`;
  const ssn = String(Math.floor(100000000 + Math.random() * 899999999));
  let dbPass = 0, dbFail = 0;
  const ok = (c, m) => { if (c) { dbPass++; } else { dbFail++; console.log(`FAIL ${m}`); } };
  const q = (sql, p) => db.query(sql, p);

  try {
    const loId = (await q(
      `INSERT INTO staff_users (email,full_name,role,is_active,mfa_enabled,password_hash,token_version)
       VALUES ($1,'Merge Officer','loan_officer',true,false,'x',0) RETURNING id`,
      [`mrg-lo-${sfx}@test.local`])).rows[0].id;
    const strangerId = (await q(
      `INSERT INTO staff_users (email,full_name,role,is_active,mfa_enabled,password_hash,token_version)
       VALUES ($1,'Unrelated Officer','loan_officer',true,false,'x',0) RETURNING id`,
      [`mrg-lo2-${sfx}@test.local`])).rows[0].id;
    const loToken = C.signJwt({ sub: loId, kind: 'staff', role: 'loan_officer', tv: 0 });
    const strangerToken = C.signJwt({ sub: strangerId, kind: 'staff', role: 'loan_officer', tv: 0 });

    // ── The duplicate pair. Same human, entered twice, disagreeing on three
    //    fields and each holding history the other does not have.
    const emailA = `mrg-a-${sfx}@test.local`;
    const emailB = `mrg-b-${sfx}@test.local`;
    const mkBorrower = async (first, last, email, phone, extra = {}) => (await q(
      `INSERT INTO borrowers (first_name,last_name,email,cell_phone,primary_officer_id,
                              date_of_birth, housing_status, housing_payment, fico, current_address)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb) RETURNING id`,
      [first, last, email, phone, loId, extra.dob || null, extra.housing || null,
        extra.payment || null, extra.fico || null, extra.address ? JSON.stringify(extra.address) : null])).rows[0].id;

    const A = await mkBorrower('Abe', 'Klein', emailA, '+17185550100',
      { dob: '1980-04-01', fico: 712 });                       // survivor: no housing on file
    const B = await mkBorrower('Abraham', 'Klein', emailB, '+18455550200',
      { dob: '1980-04-01', housing: 'Rent', payment: 2400, address: { oneLine: '10 Main St, Monsey, NY' } });

    // Only the LOSER carries the social — it must come across, all three columns.
    await q(`UPDATE borrowers SET ssn_encrypted=$2, ssn_last4=$3, ssn_hash=$4 WHERE id=$1`,
      [B, C.encryptSSN(ssn), ssn.slice(-4), ssnHash(ssn)]);

    // History on both sides, with ONE genuine overlap per table.
    await q(`INSERT INTO llcs (borrower_id, llc_name, ein) VALUES ($1,$2,$3)`, [A, `Alpha Holdings LLC ${sfx}`, '11-1111111']);
    await q(`INSERT INTO llcs (borrower_id, llc_name, ein) VALUES ($1,$2,$3)`, [B, ` alpha holdings llc ${sfx} `, '11-1111111']);
    await q(`INSERT INTO llcs (borrower_id, llc_name, ein) VALUES ($1,$2,$3)`, [B, `Beta Ventures LLC ${sfx}`, '22-2222222']);

    const tr = (id, line, key) => q(
      `INSERT INTO track_records (borrower_id, property_address, address_key, deal_type)
       VALUES ($1,$2::jsonb,$3,'purchase')`, [id, JSON.stringify({ oneLine: line }), key]);
    await tr(A, '1 Alpha St, Brooklyn, NY', `k-alpha-${sfx}`);
    await tr(B, '1 Alpha St, Brooklyn NY', `k-alpha-${sfx}`);       // same property, one key
    await tr(B, '2 Beta Ave, Lakewood, NJ', `k-beta-${sfx}`);
    await tr(B, '3 Unknown Rd, Nowhere', null);                     // NO key — must MOVE, never collapse
    await tr(A, '4 Other Unknown Rd', null);                        // survivor also un-keyed

    // Contacts already accumulated on each side, with one overlapping number.
    const ct = (id, kind, value) => q(
      `INSERT INTO borrower_contacts (borrower_id, kind, value, source) VALUES ($1,$2,$3,'test')
       ON CONFLICT (borrower_id, kind, value) DO NOTHING`, [id, kind, value]);
    await ct(A, 'phone', '+17185559999');
    await ct(B, 'phone', '+17185559999');                            // duplicate
    await ct(B, 'email', `mrg-old-${sfx}@test.local`);

    // Officer links: one shared, one only the loser has.
    await q(`INSERT INTO borrower_officers (borrower_id, staff_id, source) VALUES ($1,$2,'test')
             ON CONFLICT DO NOTHING`, [A, loId]);
    await q(`INSERT INTO borrower_officers (borrower_id, staff_id, source) VALUES ($1,$2,'test')
             ON CONFLICT DO NOTHING`, [B, loId]);
    await q(`INSERT INTO borrower_officers (borrower_id, staff_id, source) VALUES ($1,$2,'test')
             ON CONFLICT DO NOTHING`, [B, strangerId]);

    // Loan files on both sides — these are what a merge must never orphan.
    const mkApp = async (borrowerId, n) => (await q(
      `INSERT INTO applications (borrower_id, loan_officer_id, status, loan_amount)
       VALUES ($1,$2,'file_intake',$3) RETURNING id`, [borrowerId, loId, 100000 + n])).rows[0].id;
    const appA = await mkApp(A, 1);
    const appB1 = await mkApp(B, 2);
    const appB2 = await mkApp(B, 3);

    // Only the LOSER has a portal login — the person must not lose their sign-in.
    await q(`INSERT INTO borrower_auth (borrower_id, password_hash, token_version)
             VALUES ($1,'x',0) ON CONFLICT DO NOTHING`, [B]);

    // ── 1) FINDING the duplicate ───────────────────────────────────────────
    const dupes = await call(server, 'GET', `/api/staff/borrowers/${A}/duplicates`, loToken);
    ok(dupes.status === 200, 'the duplicates endpoint answers');
    const hit = (dupes.body || []).find((d) => String(d.id) === String(B));
    ok(!!hit, 'the other profile is offered as a duplicate (same last name + date of birth)');
    ok(hit && hit.why.length > 0, 'and it says WHY, so nobody is asked to trust a bare score');
    ok(hit && hit.files === 2, 'with the history at stake shown up front (2 files)');

    // An unrelated officer must not be able to browse duplicates of someone
    // else's borrower — a merge screen is not a back door into the book.
    ok((await call(server, 'GET', `/api/staff/borrowers/${A}/duplicates`, strangerToken)).status === 403,
      'an unrelated officer cannot open the duplicate list');

    // ── 2) COMPARING ───────────────────────────────────────────────────────
    const cmp = await call(server, 'GET', `/api/staff/borrowers/${A}/compare/${B}`, loToken);
    ok(cmp.status === 200, 'the two profiles compare side by side');
    const f = (k) => (cmp.body.fields || []).find((x) => x.key === k);
    ok(f('first_name').conflict === true, 'a real disagreement (Abe vs Abraham) is flagged as a conflict');
    ok(f('email').conflict === true && f('cell_phone').conflict === true,
      'the two PRIMARY email/phone values are a conflict — one has to be the primary');
    ok(f('date_of_birth').conflict === false, 'a field the two AGREE on is not a conflict');
    ok(f('housing_status').conflict === false && f('housing_status').onlyMerged === true,
      'a field only the loser has is pure gain, not a decision to make');
    ok(f('ssn_last4').merged === `•••-••-${ssn.slice(-4)}`, 'the social is shown MASKED in the comparison');
    ok(cmp.body.merged.files === 2 && cmp.body.survivor.files === 1, 'both sides show their file counts');
    ok(cmp.body.merged.hasLogin === true && cmp.body.survivor.hasLogin === false,
      'and it says which side owns the portal login');

    // ── 3) A MERGE WITH AN UNDECIDED CONFLICT IS REFUSED ───────────────────
    const refused = await call(server, 'POST', `/api/staff/borrowers/${A}/merge`, loToken,
      { mergeId: B, choices: { first_name: 'merged' } });
    ok(refused.status === 409, 'merging with conflicts still open is REFUSED, not guessed');
    ok((refused.body.undecided || []).map((u) => u.key).sort().join(',') === 'cell_phone,email',
      'and it names exactly which fields still need a human answer');
    ok((await q(`SELECT count(*)::int n FROM borrowers WHERE id=$1`, [B])).rows[0].n === 1,
      'nothing was touched — the refused merge left both profiles alone');

    // ── 4) THE MERGE ───────────────────────────────────────────────────────
    const res = await call(server, 'POST', `/api/staff/borrowers/${A}/merge`, loToken, {
      mergeId: B,
      choices: { first_name: 'merged', email: 'survivor', cell_phone: 'merged' },
    });
    ok(res.status === 200 && res.body.ok === true, 'the merge succeeds once every conflict is decided');

    const S = (await q(`SELECT * FROM borrowers WHERE id=$1`, [A])).rows[0];
    ok(!!S, 'the survivor is still there');
    ok((await q(`SELECT count(*)::int n FROM borrowers WHERE id=$1`, [B])).rows[0].n === 0,
      'and the absorbed profile is gone — one person, one profile');

    // Chosen values, field by field.
    ok(S.first_name === 'Abraham', 'the chosen first name (the real one) survived');
    ok(String(S.email).toLowerCase() === emailA.toLowerCase(), 'the chosen primary email survived');
    ok(S.cell_phone === '+18455550200', 'the chosen primary phone survived');
    ok(S.housing_status === 'Rent' && Number(S.housing_payment) === 2400,
      'housing details the survivor never had are picked up automatically');
    ok(S.current_address && /Main St/.test(JSON.stringify(S.current_address)),
      'as is the home address');
    ok(Number(S.fico) === 712, 'and a value only the SURVIVOR had is never lost');

    // The social moves as a unit, or the profile shows one number and matches another.
    ok(S.ssn_last4 === ssn.slice(-4), 'the social came across');
    ok(!!S.ssn_encrypted && C.decryptSSN(S.ssn_encrypted) === ssn, 'still encrypted, and decrypts to the real number');
    ok(S.ssn_hash === ssnHash(ssn), 'and the MATCH hash moved with it, so a re-entry still finds this person');

    // ── Emails and phones ADD UP ───────────────────────────────────────────
    const contacts = (await q(`SELECT kind, value FROM borrower_contacts WHERE borrower_id=$1 ORDER BY kind, value`, [A])).rows;
    const has = (k, v) => contacts.some((c) => c.kind === k && String(c.value).toLowerCase() === v.toLowerCase());
    ok(has('email', emailA) && has('email', emailB), 'BOTH primary emails are kept — nothing is lost by losing a vote');
    ok(has('email', `mrg-old-${sfx}@test.local`), 'along with every email already on the loser');
    ok(has('phone', '+17185550100') && has('phone', '+18455550200'), 'both primary phones are kept');
    ok(has('phone', '+17185559999'), 'and the accumulated numbers');
    ok(contacts.filter((c) => c.kind === 'phone' && c.value === '+17185559999').length === 1,
      'the number BOTH sides already had appears once, not twice');

    // ── Entities ADD UP — and the regression that ate one ──────────────────
    const llcs = (await q(`SELECT llc_name FROM llcs WHERE borrower_id=$1 ORDER BY llc_name`, [A])).rows;
    ok(llcs.length === 2, 'the entities add up (two distinct LLCs), with the duplicate collapsed');
    ok(llcs.some((l) => /Alpha Holdings/i.test(l.llc_name)), 'the shared entity is still there');
    ok(llcs.some((l) => /Beta Ventures/i.test(l.llc_name)),
      'THE REGRESSION: the entity only the loser had is MOVED, never deleted as a false duplicate');
    ok((await q(`SELECT count(*)::int n FROM llcs WHERE borrower_id=$1`, [B])).rows[0].n === 0,
      'no entity is left pointing at a profile that no longer exists');

    // ── Track records ADD UP ───────────────────────────────────────────────
    const trs = (await q(`SELECT property_address, address_key FROM track_records WHERE borrower_id=$1`, [A])).rows;
    const line = (t) => JSON.stringify(t.property_address);
    ok(trs.length === 4, 'the track record adds up: 1 shared property + 1 only the loser had + both un-keyed rows');
    ok(trs.filter((t) => t.address_key === `k-alpha-${sfx}`).length === 1,
      'the property BOTH sides listed appears once');
    ok(trs.some((t) => /Beta Ave/.test(line(t))), 'the property only the loser had came across');
    ok(trs.some((t) => /3 Unknown Rd/.test(line(t))) && trs.some((t) => /4 Other Unknown/.test(line(t))),
      'two addresses with NO normalized key are two properties — never collapsed into one');

    // ── Files, officers, login ─────────────────────────────────────────────
    const apps = (await q(`SELECT id FROM applications WHERE borrower_id=$1`, [A])).rows.map((r) => String(r.id));
    ok(apps.length === 3 && [appA, appB1, appB2].every((id) => apps.includes(String(id))),
      'every loan file from BOTH profiles now hangs on the one person');
    const offs = (await q(`SELECT staff_id FROM borrower_officers WHERE borrower_id=$1`, [A])).rows;
    ok(offs.length === 2, 'the officer links add up, with the shared one collapsed');
    ok(offs.some((o) => String(o.staff_id) === String(strangerId)),
      'an officer only the loser was linked to keeps their borrower');
    const auth = (await q(`SELECT borrower_id FROM borrower_auth WHERE borrower_id=$1`, [A])).rows;
    ok(auth.length === 1, 'the portal login follows the person — a merge never signs someone out for good');

    // ── The audit trail ────────────────────────────────────────────────────
    const rec = (await q(`SELECT * FROM borrower_merges WHERE merged_id=$1`, [B])).rows[0];
    ok(!!rec, 'the merge is recorded');
    ok(String(rec.survivor_id) === String(A) && rec.merged_email === emailB, 'with both sides identified');
    ok(rec.merged_snapshot && rec.merged_snapshot.borrower && rec.merged_snapshot.borrower.first_name === 'Abraham',
      'the WHOLE losing profile is snapshotted, so a mistaken merge is reconstructable');
    ok((rec.merged_snapshot.llcs || []).length === 2 && (rec.merged_snapshot.trackRecords || []).length === 3,
      'including the history that was dropped as duplicate');
    ok(rec.merged_snapshot.borrower.ssn_encrypted === '(encrypted, moved or discarded by the merge)',
      'but the snapshot never becomes a second plaintext copy of the social');
    ok(rec.field_choices && rec.field_choices.first_name === 'merged' && rec.field_choices.email === 'survivor',
      'and which side won each contested field');
    ok(rec.moved && Number(rec.moved.applications) === 2, 'with a count of what moved per table');
    ok(String(rec.merged_by) === String(loId), 'and WHO did it');
    ok((await q(`SELECT count(*)::int n FROM audit_log WHERE action='merge_borrowers' AND entity_id=$1`, [A])).rows[0].n === 1,
      'the action is in the audit log as well');

    const hist = await call(server, 'GET', `/api/staff/borrowers/${A}/merges`, loToken);
    ok(hist.status === 200 && (hist.body || []).length === 1,
      'the profile can explain where its extra records came from');

    // ── Guards ─────────────────────────────────────────────────────────────
    ok((await call(server, 'POST', `/api/staff/borrowers/${A}/merge`, loToken, { mergeId: A })).status === 400,
      'a profile cannot absorb itself');
    ok((await call(server, 'POST', `/api/staff/borrowers/${A}/merge`, loToken, {})).status === 400,
      'and a merge with nothing to merge is rejected');

    // ── The whole point: the SSN that was "already linked elsewhere" is free ──
    // Before the merge two profiles claimed this person; now exactly one does,
    // which is what unblocks the staffer who could not save the social.
    ok((await q(`SELECT count(*)::int n FROM borrowers WHERE ssn_hash=$1`, [ssnHash(ssn)])).rows[0].n === 1,
      'exactly ONE profile now owns that social — the duplicate no longer blocks it');
  } catch (e) {
    dbFail++; console.log('FAIL threw:', e && e.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : e);
  } finally {
    const like = `mrg-%${sfx}%`;
    await db.query(`DELETE FROM track_records WHERE borrower_id IN (SELECT id FROM borrowers WHERE email LIKE $1)`, [like]).catch(() => {});
    await db.query(`DELETE FROM applications WHERE borrower_id IN (SELECT id FROM borrowers WHERE email LIKE $1)`, [like]).catch(() => {});
    await db.query(`DELETE FROM borrowers WHERE email LIKE $1`, [like]).catch(() => {});
    await db.query(`DELETE FROM staff_users WHERE email LIKE $1`, [`mrg-lo%-${sfx}@test.local`]).catch(() => {});
    server.close();
    console.log(`test-borrower-merge: DB ${dbPass} passed, ${dbFail} failed`);
    process.exit(dbFail ? 1 : 0);
  }
})();
