/**
 * TWO PROFILES, ONE PERSON — MERGED AUTOMATICALLY WHEN IT IS PROVABLE
 * (owner-directed 2026-08-27: "Fix the root cause so that the duplicate profile
 * shouldn't happen again by other profiles. Profiles should automatically be
 * merged if it matches … find the root cause of what happened with this
 * duplicate profile, fix the root cause … and make sure in the future it's not
 * happening again").
 *
 * THE ROOT CAUSE this file pins, and it is one column carrying two facts:
 * `borrowers.shares_email` is set BY A HUMAN to say "these are two different
 * people on one mailbox" AND BY A MACHINE to get past
 * `borrowers_email_owner_uk` (db/318). Once set, the duplicate sits outside the
 * only constraint that would have stopped it, nothing ever revisits it, and
 * nothing can tell the two facts apart afterwards.
 *
 * So the fix is in two halves and BOTH are asserted here:
 *   1. the doors that let a human keep two profiles on one mailbox now RECORD
 *      that decision in `borrower_profile_links` — the durable "do not merge";
 *   2. the sweep IGNORES `shares_email` entirely, merges only what it can
 *      PROVE, and NAMES its refusal for everything else.
 *
 * The owner's reported pair is reproduced field for field (§E): two "Leib
 * Lichtman" profiles on one real address, same date of birth, the same phone
 * written two ways, the same home address differing only in case — one flagged
 * `shares_email`, the other owning the address and holding the Social and both
 * loan files. Nobody ever decided they were two people.
 */
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0'.repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecrettestsecrettestsecret12';

let failures = 0, passes = 0;
const assert = (c, m) => { if (c) { passes++; console.log(`  ok  ${m}`); } else { failures++; console.log(`  FAIL ${m}`); } };

// ─────────────────────────────────────────────────────────────────────────────
// PURE — every rule that decides whether two profiles are one person, with no
// database in reach, so each one is provable on its own.
// ─────────────────────────────────────────────────────────────────────────────
const D = require('../src/lib/borrower-dedupe');

console.log('\nA. proof — what is enough to say two profiles are one person');
{
  const p = (o) => ({ id: o.id || Math.random().toString(36).slice(2), ...o });

  // PROOF 1 — one Social Security number is one person.
  assert(D.provableMatch(
    p({ id: '1', ssn_hash: 'h1', first_name: 'Leib', last_name: 'Lichtman' }),
    p({ id: '2', ssn_hash: 'h1', first_name: 'L', last_name: 'Lichtman' })).basis === 'ssn',
    'A1 the same Social proves it, even when the names are written differently');

  // PROOF 2 — the same real mailbox AND the same full name.
  assert(D.provableMatch(
    p({ id: '1', email: 'leon@gmail.com', first_name: 'Leib', last_name: 'Lichtman' }),
    p({ id: '2', email: 'LEON@gmail.com', first_name: ' leib ', last_name: 'LICHTMAN' })).basis === 'email_name',
    'A2 the same email and the same full name proves it (case and spacing are spelling)');

  // A HOUSEHOLD shares a mailbox. It does not share a name — this is the
  // owner's own 2026-07-26 rule and the reason the flag exists at all.
  assert(D.provableMatch(
    p({ id: '1', email: 'home@gmail.com', first_name: 'Sarah', last_name: 'Klein' }),
    p({ id: '2', email: 'home@gmail.com', first_name: 'Yaakov', last_name: 'Klein' })).same === false,
    'A3 a husband and wife on one mailbox are NEVER merged');

  // A CONTRADICTION BEATS EVERY AGREEMENT, and is asked FIRST.
  assert(D.provableMatch(
    p({ id: '1', ssn_hash: 'h1', email: 'x@y.com', first_name: 'Leib', last_name: 'Lichtman' }),
    p({ id: '2', ssn_hash: 'h2', email: 'x@y.com', first_name: 'Leib', last_name: 'Lichtman' })).same === false,
    'A4 two DIFFERENT Socials are two people however identical the rest looks');
  assert(D.provableMatch(
    p({ id: '1', email: 'x@y.com', first_name: 'Leib', last_name: 'Lichtman', date_of_birth: '2002-05-21' }),
    p({ id: '2', email: 'x@y.com', first_name: 'Leib', last_name: 'Lichtman', date_of_birth: '1975-01-02' })).same === false,
    'A5 two different dates of birth are two people (a father and his son)');

  // A PLACEHOLDER PROVES NOTHING. The sync mints these in volume.
  assert(D.provableMatch(
    p({ id: '1', email: 'noemail+t1@clickup.local', first_name: 'Unknown', last_name: 'Unknown' }),
    p({ id: '2', email: 'noemail+t1@clickup.local', first_name: 'Unknown', last_name: 'Unknown' })).same === false,
    'A6 two ClickUp shadow addresses are not evidence of anything');
  assert(D.provableMatch(
    p({ id: '1', email: 'real@gmail.com', first_name: 'Unknown', last_name: 'Unknown' }),
    p({ id: '2', email: 'real@gmail.com', first_name: 'Unknown', last_name: 'Unknown' })).same === false,
    'A7 "Unknown Unknown" is not a name, so it can never be half of a proof');

  // A DATE OF BIRTH IS NOT PROOF ON ITS OWN — plenty of people share one.
  assert(D.provableMatch(
    p({ id: '1', date_of_birth: '2002-05-21', first_name: 'Leib', last_name: 'Lichtman' }),
    p({ id: '2', date_of_birth: '2002-05-21', first_name: 'Leib', last_name: 'Lichtman' })).same === false,
    'A8 a name and a birthday with no shared mailbox or Social is NOT proof');

  assert(D.provableMatch(p({ id: '1' }), p({ id: '1' })).same === false, 'A9 a row is never a duplicate of itself');
  assert(D.provableMatch(null, p({ id: '1' })).same === false, 'A10 a missing row proves nothing');
}

console.log('\nB. a spelling is not a disagreement — and everything else is');
{
  assert(D.formatOnlyConflict('cell_phone', '6465650705', '(646) 565-0705') === true,
    'B1 one phone number written two ways is one phone number');
  assert(D.formatOnlyConflict('cell_phone', '6465650705', '7185550100') === false,
    'B2 two different phone numbers are a real conflict');
  assert(D.formatOnlyConflict('email', 'A@B.com', 'a@b.com') === true, 'B3 an email differs only in case');
  assert(D.formatOnlyConflict('date_of_birth', new Date(2002, 4, 21), '2002-05-21') === true,
    'B4 a stored date and a typed one are the same day');
  assert(D.formatOnlyConflict('current_address',
    { oneLine: '38 Cross St, Monsey, NY 10952' },
    { oneLine: '38 CROSS ST, MONSEY, NY 10952' }) === true,
    'B5 the address is judged by the repo’s own sameAddress, not by string equality');
  assert(D.formatOnlyConflict('current_address',
    { oneLine: '38 Cross St, Monsey, NY 10952' },
    { oneLine: '52 Maple Ave, Lakewood, NJ 08701' }) === false,
    'B6 two different homes are a real conflict');
  // A NEW single-valued column is a real conflict by DEFAULT — safe by omission.
  assert(D.formatOnlyConflict('fico', '712', '640') === false,
    'B7 a field with no stated definition is always a real conflict');
  assert(D.formatOnlyConflict('housing_payment', '2400', '2400.00') === false,
    'B8 …including one whose two values happen to look alike');
  // BELT AND SUSPENDERS. Proof is the first layer; `needs_a_choice` is the
  // second. A household shares a mailbox and disagrees on the first name, so
  // even if the proof rule were ever loosened the pair is refused AGAIN here.
  assert(D.formatOnlyConflict('first_name', 'Sarah', 'Yitzchok') === false,
    'B9 two people’s names are a DECISION — a household is refused twice over');
}

console.log('\nC. which profile survives');
{
  const now = new Date('2026-01-01').toISOString(), older = new Date('2020-01-01').toISOString();
  const pick = (a, b) => D.pickSurvivor(a, b).survivor.id;
  assert(pick({ id: 'login', has_login: true, created_at: now }, { id: 'no', has_login: false, created_at: older }) === 'login',
    'C1 the portal login never moves');
  assert(pick({ id: 'owner', shares_email: false, created_at: now }, { id: 'flagged', shares_email: true, created_at: older }) === 'owner',
    'C2 the profile that OWNS the address wins — it is the row every upsert resolves to');
  assert(pick({ id: 'ssn', ssn_hash: 'h', shares_email: true }, { id: 'none', shares_email: true }) === 'ssn',
    'C3 the profile carrying the Social wins over one that has none');
  assert(pick({ id: 'files', files: 2, shares_email: true }, { id: 'empty', files: 0, shares_email: true }) === 'files',
    'C4 the profile carrying the loan files wins');
  assert(pick({ id: 'old', created_at: older }, { id: 'new', created_at: now }) === 'old', 'C5 …then the older record');
  assert(D.pickSurvivor({ id: 'aaa' }, { id: 'bbb' }).survivor.id === 'aaa'
      && D.pickSurvivor({ id: 'bbb' }, { id: 'aaa' }).survivor.id === 'aaa',
    'C6 a full tie is broken deterministically, so two runs can never disagree');
}

console.log('\nD. the source itself');
{
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'lib', 'borrower-dedupe.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');   // decisions live in comments; assert on CODE
  assert(/merge\.mergeBorrowers\(/.test(src),
    'D1 the merge itself is the shared one — never a second copy of the most destructive action here');
  assert(!/DELETE\s+FROM\s+borrowers/i.test(src),
    'D2 this module never deletes a profile itself');
  assert(!/shares_email\s*(===|==|\?)/.test(src.replace(/r\.shares_email \? 0 : 1/, '')),
    'D3 `shares_email` is never read as a decision — that conflation IS the root cause');
  assert(/borrower_profile_links/.test(src),
    'D4 the durable "two different people" record is what IS read instead');

  /* The boot pass is the "previous files" half, and no behaviour test can see
     whether it is WIRED — a correct rule nothing calls is a dead fix. */
  const boot = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'server.js'), 'utf8');
  assert(/require\('\.\/lib\/borrower-dedupe'\)[\s\S]{0,80}\.autoMergeOnce\(/.test(boot),
    'D5 the sweep actually runs at boot');
  assert(/BORROWER_AUTO_MERGE_DISABLED/.test(boot) && /BORROWER_AUTO_MERGE_DRYRUN/.test(boot),
    'D6 …and can be switched off, or watched in dry run, without a deploy');
  assert(/\.catch\(\(e\) => console\.error\('\[boot\] borrower auto-merge failed/.test(boot),
    'D7 …and can never stop the server coming up');

  /* Both doors that let a human keep two profiles on one mailbox must RECORD
     the decision. The third (staff file-create) has always written the link
     itself — a source guard so a future edit cannot quietly drop one. */
  const staff = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'routes', 'staff.js'), 'utf8');
  assert((staff.match(/recordSharedEmailDecision\(/g) || []).length >= 2,
    'D8 both "keep both" doors record the decision, not just the flag');
  assert(/INSERT INTO borrower_profile_links/.test(staff),
    'D9 …and the file-create door still writes its own link');
}

console.log(`\ntest-borrower-dedupe: PURE ${passes} passed, ${failures} failed`);
if (failures) process.exit(1);
if (!process.env.DATABASE_URL) { console.log('  (SKIP DB — no DATABASE_URL)'); process.exit(0); }

// ─────────────────────────────────────────────────────────────────────────────
// REAL POSTGRES — the sweep, the four refusals, and the reported pair.
// ─────────────────────────────────────────────────────────────────────────────
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
  let dbPass = 0, dbFail = 0;
  const ok = (c, m) => { if (c) { dbPass++; console.log(`  ok  ${m}`); } else { dbFail++; console.log(`  FAIL ${m}`); } };
  const q = (sql, p) => db.query(sql, p);
  const alive = async (id) => !!(await q(`SELECT 1 FROM borrowers WHERE id=$1`, [id])).rows[0];

  /* Every fixture pair carries its OWN email so the sweep's candidate query can
     never pull one section's rows into another's. */
  const mk = async (o) => (await q(
    `INSERT INTO borrowers (first_name,last_name,email,shares_email,cell_phone,date_of_birth,
                            current_address,ssn_hash,created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8, now() - ($9 || ' days')::interval) RETURNING id`,
    [o.first, o.last, o.email, !!o.shares, o.phone || null, o.dob || null,
      o.address ? JSON.stringify(o.address) : null, o.ssnHash || null, o.ageDays || 0])).rows[0].id;

  try {
    const loId = (await q(
      `INSERT INTO staff_users (email,full_name,role,is_active,mfa_enabled,password_hash,token_version)
       VALUES ($1,'Dedupe Admin','admin',true,false,'x',0) RETURNING id`,
      [`dedupe-lo-${sfx}@test.local`])).rows[0].id;
    const loToken = C.signJwt({ sub: loId, kind: 'staff', role: 'admin', tv: 0 });

    // ── E. THE OWNER'S REPORTED PAIR, reproduced field for field ─────────────
    console.log('\nE. the reported duplicate — two Leib Lichtman profiles on one mailbox');
    const leibEmail = `leon-${sfx}@test.local`;
    const leibSsn = String(Math.floor(100000000 + Math.random() * 899999999));
    // The OWNER of the address: holds the Social and both loan files.
    const owner = await mk({ first: 'Leib', last: 'Lichtman', email: leibEmail, shares: false,
      phone: '(646) 565-0705', dob: '2002-05-21', ageDays: 400,
      address: { oneLine: '38 Cross St, Monsey, NY 10952' }, ssnHash: ssnHash(leibSsn) });
    await q(`UPDATE borrowers SET ssn_encrypted=$2, ssn_last4=$3 WHERE id=$1`,
      [owner, C.encryptSSN(leibSsn), leibSsn.slice(-4)]);
    // The DUPLICATE a machine minted: the same person, flagged to get past the index.
    const dupe = await mk({ first: 'Leib', last: 'Lichtman', email: leibEmail, shares: true,
      phone: '6465650705', dob: '2002-05-21', ageDays: 100,
      address: { oneLine: '38 CROSS ST, MONSEY, NY 10952' } });
    // Each side carries history the other does not.
    await q(`INSERT INTO llcs (borrower_id, llc_name) VALUES ($1,$2)`, [dupe, `Lichtman Holdings ${sfx}`]);
    await q(`INSERT INTO track_records (borrower_id, property_address, address_key, deal_type)
             VALUES ($1,$2::jsonb,$3,'flip')`,
    [dupe, JSON.stringify({ oneLine: `9 Elm St, Monsey NY ${sfx}` }), `k-elm-${sfx}`]);

    ok(await alive(owner) && await alive(dupe), 'E1 (staged) both profiles exist, nobody ever decided they were two people');

    const decided = await D.decidePair(owner, dupe);
    ok(decided.merge === true && decided.basis === 'email_name',
      'E2 the pair is PROVABLE — the same mailbox and the same full name');
    ok(String(decided.survivorId) === String(owner),
      'E3 the profile that owns the address, the Social and the files is the survivor');

    const swept = await D.autoMergeOnce({ limit: 500 });
    ok(swept.merged >= 1, 'E4 the sweep merges it');
    ok(await alive(owner) && !(await alive(dupe)),
      'E5 THE REPORTED DEFECT: there is now ONE Leib Lichtman, and it is the one holding the files');
    ok(Number((await q(`SELECT count(*)::int n FROM llcs WHERE borrower_id=$1`, [owner])).rows[0].n) === 1
      && Number((await q(`SELECT count(*)::int n FROM track_records WHERE borrower_id=$1`, [owner])).rows[0].n) === 1,
    'E6 …carrying the entity and the property the duplicate held — nothing was lost');
    ok(!!(await q(`SELECT 1 FROM borrower_merges WHERE merged_id=$1`, [dupe])).rows[0],
      'E7 the losing profile is snapshotted, so a wrong merge can be typed back');
    ok(!!(await q(`SELECT 1 FROM audit_log WHERE action='borrower_auto_merged' AND entity_id=$1`, [owner])).rows[0],
      'E8 …and the file says PILOT did it, and why');
    /* Read through a null-safe local: under a mutation that picks the WRONG
       survivor this row is gone, and a crash would stop the battery and look
       like proof. A missing row must FAIL this assertion, not throw. */
    const ownerRow = (await q(`SELECT shares_email FROM borrowers WHERE id=$1`, [owner])).rows[0] || null;
    ok(!!ownerRow && ownerRow.shares_email === false,
      'E9 the surviving profile still OWNS its address');

    // ── F. THE FOUR REFUSALS ────────────────────────────────────────────────
    console.log('\nF. what it refuses, and every refusal is named');

    // 1. A HUMAN ALREADY DECIDED.
    const hEmail = `household-${sfx}@test.local`;
    const hA = await mk({ first: 'Yaakov', last: 'Klein', email: hEmail, shares: false, dob: '1980-01-01' });
    const hB = await mk({ first: 'Yaakov', last: 'Klein', email: hEmail, shares: true, dob: '1980-01-01' });
    ok((await D.decidePair(hA, hB)).merge === true,
      'F1 (control) with nothing recorded, an identical pair IS provable');
    for (const [x, y] of [[hA, hB], [hB, hA]]) {
      await q(`INSERT INTO borrower_profile_links (borrower_id, linked_borrower_id, reason, created_by)
               VALUES ($1,$2,'shared_email_allowed',$3) ON CONFLICT DO NOTHING`, [x, y, loId]);
    }
    ok((await D.decidePair(hA, hB)).reason === 'human_decided',
      'F2 a recorded "two different people" is final — the sweep never touches it again');
    await D.autoMergeOnce({ limit: 500 });
    ok(await alive(hA) && await alive(hB), 'F3 …and both profiles are still there after a full sweep');

    // 2. TWO LOGINS. A login is pinned to ONE profile per address (db/318's
    //    trg_borrower_auth_one_login_per_email), so this pair is necessarily
    //    proven by the SOCIAL rather than by a shared mailbox — which is exactly
    //    the shape that reaches this refusal in production.
    const lSsn = String(Math.floor(100000000 + Math.random() * 899999999));
    const lA = await mk({ first: 'Miriam', last: 'Stern', email: `l1-${sfx}@test.local`, ssnHash: ssnHash(lSsn) });
    const lB = await mk({ first: 'Miriam', last: 'Stern', email: `l2-${sfx}@test.local`, ssnHash: ssnHash(lSsn) });
    ok(D.provableMatch({ id: lA, ssn_hash: 'h' }, { id: lB, ssn_hash: 'h' }).basis === 'ssn'
      && (await D.decidePair(lA, lB)).reason !== 'two_logins',
    'F4a (control) with only one login this pair is refused for a different reason entirely');
    for (const id of [lA, lB]) {
      await q(`INSERT INTO borrower_auth (borrower_id, password_hash, token_version) VALUES ($1,'x',0)`, [id]);
    }
    ok((await D.decidePair(lA, lB)).reason === 'two_logins',
      'F4 two portal logins is a sign-in change, not a clean-up — a human does that one');

    // 3. SOMETHING NEEDS A CHOICE.
    const cEmail = `choice-${sfx}@test.local`;
    const cA = await mk({ first: 'Dovid', last: 'Weiss', email: cEmail, shares: false,
      address: { oneLine: '10 Main St, Lakewood, NJ 08701' } });
    const cB = await mk({ first: 'Dovid', last: 'Weiss', email: cEmail, shares: true,
      address: { oneLine: '52 Maple Ave, Monsey, NY 10952' } });
    const choiceCall = await D.decidePair(cA, cB);
    ok(choiceCall.reason === 'needs_a_choice' && (choiceCall.fields || []).includes('current_address'),
      'F5 a real disagreement is a DECISION, and decisions are not ours — the field is named');
    // …and the same pair, disagreeing only in SPELLING, merges.
    await q(`UPDATE borrowers SET current_address=$2::jsonb WHERE id=$1`,
      [cB, JSON.stringify({ oneLine: '10 MAIN ST, LAKEWOOD, NJ 08701' })]);
    ok((await D.decidePair(cA, cB)).merge === true,
      'F6 …while the SAME home written two ways is not a disagreement at all');

    // 4. CONTRADICTING SOCIALS — the pair shares a mailbox and a name and is STILL refused.
    const sEmail = `socials-${sfx}@test.local`;
    const s1 = String(Math.floor(100000000 + Math.random() * 899999999));
    const s2 = String(Math.floor(100000000 + Math.random() * 899999999));
    const sA = await mk({ first: 'Chaim', last: 'Green', email: sEmail, shares: false, ssnHash: ssnHash(s1) });
    const sB = await mk({ first: 'Chaim', last: 'Green', email: sEmail, shares: true, ssnHash: ssnHash(s2) });
    ok((await D.decidePair(sA, sB)).reason === 'not_provable',
      'F7 two different Socials are two people, whatever else agrees');
    await D.autoMergeOnce({ limit: 500 });
    ok(await alive(sA) && await alive(sB) && await alive(cA) && await alive(lA) && await alive(lB),
      'F8 a full sweep leaves every refused pair exactly where it was');

    // ── G. NOTHING IS MERGED ON A GUESS ─────────────────────────────────────
    console.log('\nG. two strangers who merely share a mailbox');
    const wEmail = `spouses-${sfx}@test.local`;
    const wA = await mk({ first: 'Sarah', last: 'Bloom', email: wEmail, shares: false });
    const wB = await mk({ first: 'Yitzchok', last: 'Bloom', email: wEmail, shares: true });
    ok((await D.decidePair(wA, wB)).reason === 'not_provable',
      'G1 one mailbox and one surname is NOT one person');
    await D.autoMergeOnce({ limit: 500 });
    ok(await alive(wA) && await alive(wB), 'G2 …and a sweep leaves the household alone');

    // ── H. THE OTHER HALF OF THE ROOT CAUSE: the doors record the decision ──
    console.log('\nH. a human keeping two profiles on one mailbox is RECORDED, not just flagged');
    const dEmail = `door-${sfx}@test.local`;
    const dOwner = await mk({ first: 'Rivka', last: 'Adler', email: dEmail, shares: false });
    const dOther = await mk({ first: 'Nechama', last: 'Adler', email: `door2-${sfx}@test.local`, shares: false });

    const refused = await call(server, 'PATCH', `/api/staff/borrowers/${dOther}`, loToken, { email: dEmail });
    ok(refused.status === 409 && refused.body && refused.body.sharedEmail
      && refused.body.sharedEmail.canShare === true,
    'H1 the profile editor asks rather than silently refusing');
    const linksBefore = Number((await q(
      `SELECT count(*)::int n FROM borrower_profile_links WHERE borrower_id=$1 AND linked_borrower_id=$2`,
      [dOther, dOwner])).rows[0].n);
    ok(linksBefore === 0, 'H2 (control) nothing is recorded until a person answers');

    const allowed = await call(server, 'PATCH', `/api/staff/borrowers/${dOther}`, loToken,
      { email: dEmail, allowSharedEmail: true });
    ok(allowed.status === 200, 'H3 answering "yes, two different people" saves');
    const bothWays = Number((await q(
      `SELECT count(*)::int n FROM borrower_profile_links
        WHERE (borrower_id=$1 AND linked_borrower_id=$2) OR (borrower_id=$2 AND linked_borrower_id=$1)`,
      [dOther, dOwner])).rows[0].n);
    ok(bothWays === 2, 'H4 …and the DECISION is written down, in both directions');
    ok((await D.decidePair(dOwner, dOther)).reason !== 'merge',
      'H5 (they are two different names anyway — the record is what makes it durable)');

    // THE POINT OF H, stated as its own assertion: the recorded decision — not
    // the flag a machine also sets — is what protects a same-name pair.
    const kEmail = `keepboth-${sfx}@test.local`;
    const kA = await mk({ first: 'Shimon', last: 'Roth', email: kEmail, shares: false });
    const kB = await mk({ first: 'Shimon', last: 'Roth', email: `keepboth2-${sfx}@test.local`, shares: false });
    ok((await D.decidePair(kA, kB)).reason === 'not_provable', 'H6 (control) different mailboxes prove nothing');
    // The promote door only ever promotes a contact ALREADY on the profile.
    await q(`INSERT INTO borrower_contacts (borrower_id, kind, value, source)
             VALUES ($1,'email',$2,'test') ON CONFLICT DO NOTHING`, [kB, kEmail]);
    const promoted = await call(server, 'POST', `/api/staff/borrowers/${kB}/contacts/primary`, loToken,
      { kind: 'email', value: kEmail, allowSharedEmail: true });
    ok(promoted.status === 200 || promoted.status === 201, 'H7 the contact-promote door keeps both too');
    ok((await D.decidePair(kA, kB)).reason === 'human_decided',
      'H8 …and because IT records the decision, the sweep leaves the pair alone — even though '
      + 'the pair is now provable by mailbox and name');
    await D.autoMergeOnce({ limit: 500 });
    ok(await alive(kA) && await alive(kB), 'H9 …proven by running the sweep over it');

    // ── I. THE SWEEP ITSELF ─────────────────────────────────────────────────
    console.log('\nI. the sweep is bounded, honest and safe to run unattended');
    const dryEmail = `dry-${sfx}@test.local`;
    const dA = await mk({ first: 'Tzvi', last: 'Farber', email: dryEmail, shares: false });
    const dB = await mk({ first: 'Tzvi', last: 'Farber', email: dryEmail, shares: true });
    const dry = await D.autoMergeOnce({ limit: 500, dryRun: true });
    ok(dry.merged >= 1 && await alive(dA) && await alive(dB),
      'I1 a dry run reports exactly what it WOULD do and writes nothing');
    const real = await D.autoMergeOnce({ limit: 500 });
    ok(!(await alive(dA)) || !(await alive(dB)), 'I2 …and the real pass does it');
    ok(real.skipped && Object.keys(real.skipped).length > 0,
      'I3 every pair it will not touch is COUNTED under its own reason');
    const second = await D.autoMergeOnce({ limit: 500 });
    ok(second.merged === 0, 'I4 a second pass merges nothing — it is self-draining');
    ok(typeof (await D.autoMergeOnce({ limit: 0 })).pairs === 'number',
      'I5 it is bounded, so a large back book drains over successive boots');
  } catch (e) {
    dbFail++;
    console.log('FAIL (threw)', e && e.stack || e);
  } finally {
    server.close();
    await db.pool.end().catch(() => {});
  }
  console.log(`\ntest-borrower-dedupe: DB ${dbPass} passed, ${dbFail} failed`);
  process.exit(dbFail ? 1 : 0);
})();
