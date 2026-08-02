'use strict';
/**
 * Pure tests for the BORROWER-PAIR identity resolution + phone/email match-any
 * in the Encompass reconcile (owner-directed 2026-08-02).
 *
 * Encompass models up to FOUR borrower pairs (applications[0..3]); our people can
 * sit in ANY slot — a second borrower is sometimes the PRIMARY of a second pair,
 * not a "co-borrower". compareIdentity must find each of OUR people wherever their
 * NAME (or SSN) actually is, and our one phone must match ANY of the party's home
 * / cell / work numbers.
 *
 * Pure: no DB, no network, no Encompass calls. compareIdentity(row, loan) is a
 * pure function of its two plain-object args.
 */
const assert = require('assert');
const R = require('../src/encompass/reconcile');
const { compareIdentity, _collectParties, _matchParty, _matchBySsn, _matchByName, _phones, _emails, _pairLabel } = R._internals;

let passed = 0;
const ok = (n) => { console.log(`  ok  ${n}`); passed++; };
const byKey = (rows) => rows.reduce((m, r) => { m[r.key] = r; return m; }, {});
// One of our people. Only the columns compareIdentity reads.
const bor = (first, last, extra = {}) => Object.assign({ b_first_name: first, b_last_name: last }, extra);
// Encompass party (firstName/lastName/... shape).
const P = (first, last, extra = {}) => Object.assign({ firstName: first, lastName: last }, extra);
const app = (borrower, coBorrower) => ({ borrower: borrower || null, coBorrower: coBorrower || null });

// ── _collectParties: every named party across all pairs, tagged ─────────────
{
  const loan = { applications: [
    app(P('John', 'Smith'), P('Jane', 'Smith')),
    app(P('Bob', 'Jones'), null),
    app(null, P('Sue', 'Vee')),
    app(P('', ''), P('Al', 'Bee')),          // an empty borrower is skipped
  ] };
  const parties = _collectParties(loan);
  assert.strictEqual(parties.length, 5, 'five NAMED parties across four pairs (the empty borrower dropped)');
  assert.deepStrictEqual(parties.map((e) => `${e.pairIndex}:${e.role}`),
    ['0:borrower', '0:coBorrower', '1:borrower', '2:coBorrower', '3:coBorrower'],
    'parties are tagged with their pair index + role, in order');
  assert.deepStrictEqual(_collectParties({}), [], 'no applications → no parties');
  assert.deepStrictEqual(_collectParties(null), [], 'null loan → no parties (never throws)');
}
ok('_collectParties gathers every named party across all borrower pairs, tagged by pair + role');

// ── _matchParty: name, SSN, exclusion ───────────────────────────────────────
{
  const parties = _collectParties({ applications: [
    app(P('John', 'Smith'), P('Jane', 'Smith')),
    app(P('Bob', 'Jones'), null),
  ] });
  const used = new Set();
  const h1 = _matchParty({ first: 'Bob', last: 'Jones' }, parties, used);
  assert.ok(h1 && h1.pairIndex === 1 && h1.role === 'borrower' && h1.method === 'name', 'name match finds Bob on pair 2 (second pair primary)');
  used.add(h1.party);
  // The same party is never handed out twice.
  const h2 = _matchParty({ first: 'Bob', last: 'Jones' }, parties, used);
  assert.strictEqual(h2, null, 'a claimed party is excluded from the next match');
  // No name of ours → no match (never fabricated).
  assert.strictEqual(_matchParty({ first: '', last: '' }, parties, new Set()), null, 'nothing of ours to match on → null');
  // SSN beats a name coincidence: two "John Smith"s, pick the one with OUR ssn.
  const twins = _collectParties({ applications: [
    app(P('John', 'Smith', { _ssnHash: 'OTHER' }), null),
    app(P('John', 'Smith', { _ssnHash: 'MINE' }), null),
  ] });
  const hs = _matchParty({ first: 'John', last: 'Smith', ssnHash: 'MINE' }, twins, new Set());
  assert.ok(hs && hs.pairIndex === 1 && hs.method === 'ssn', 'SSN hash wins over a name coincidence (picks the pair with our SSN)');
}
ok('_matchParty: name-matches across pairs, SSN beats a name coincidence, claimed parties are excluded');

// ── _pairLabel wording ──────────────────────────────────────────────────────
assert.strictEqual(_pairLabel({ pairIndex: 1, role: 'borrower', method: 'name' }), 'Matched to Encompass borrower pair 2 (primary borrower), by name.');
assert.strictEqual(_pairLabel({ pairIndex: 0, role: 'coBorrower', method: 'ssn' }), 'Matched to Encompass borrower pair 1 (co-borrower), by SSN.');
assert.strictEqual(_pairLabel(null), null, 'no hit → no note');
ok('_pairLabel names the pair, role, and how it matched (or null)');

// ── _phones / _emails read all lines ────────────────────────────────────────
{
  assert.deepStrictEqual(_phones(P('J', 'S', { mobilePhone: '5551112222', homePhoneNumber: '5553334444', workPhoneNumber: '5555556666' })),
    ['5551112222', '5553334444', '5555556666'], 'reads cell + home + work');
  // Alternate spellings real Encompass loans + enrich.partyContacts use must ALL
  // be read (cellPhoneNumber / homePhone / workPhone / businessPhoneNumber), or the
  // "any phone matches" rule silently misses those numbers.
  assert.deepStrictEqual(_phones(P('J', 'S', { cellPhoneNumber: '5551110000', homePhone: '5552220000', workPhone: '5553330000', businessPhoneNumber: '5554440000' })),
    ['5551110000', '5552220000', '5553330000', '5554440000'], 'reads the alternate phone spellings too');
  assert.deepStrictEqual(_phones({}), [], 'no phones → empty');
  assert.deepStrictEqual(_emails(P('J', 'S', { emailAddressText: 'a@b.com', workEmailAddress: 'a@work.com' })), ['a@b.com', 'a@work.com']);
  assert.deepStrictEqual(_emails(P('J', 'S', { emailAddress: 'alt@b.com', workEmail: 'w@b.com' })), ['alt@b.com', 'w@b.com'], 'reads the alternate email spellings too');
  assert.deepStrictEqual(_emails({}), []);
}
ok('_phones/_emails read every home/cell/work spelling (superset of enrich.partyContacts) — match-any is fully effective');

// ── SCENARIO A — classic: borrower + co-borrower on ONE pair ────────────────
{
  const loan = { applications: [ app(P('John', 'Smith'), P('Jane', 'Smith')) ] };
  const row = bor('John', 'Smith', { co_borrower_id: 'x', cb_first_name: 'Jane', cb_last_name: 'Smith' });
  const f = byKey(compareIdentity(row, loan));
  assert.strictEqual(f.id_borrower_name.status, 'match', 'primary matches pair-1 borrower');
  assert.strictEqual(f.id_coborrower_name.status, 'match', 'co matches pair-1 co-borrower');
}
ok('A: classic borrower + co-borrower on one pair both match');

// ── SCENARIO B — second borrower entered as the PRIMARY of a SECOND pair ────
{
  const loan = { applications: [
    app(P('John', 'Smith'), null),
    app(P('Bob', 'Jones', { workPhoneNumber: '5557778888', emailAddressText: 'bob@x.com' }), null),
  ] };
  const row = bor('John', 'Smith', {
    co_borrower_id: 'x', cb_first_name: 'Bob', cb_last_name: 'Jones',
    cb_cell_phone: '(555) 777-8888', cb_email: 'BOB@X.COM',
  });
  const f = byKey(compareIdentity(row, loan));
  assert.strictEqual(f.id_borrower_name.status, 'match', 'primary → pair-1 borrower');
  assert.strictEqual(f.id_coborrower_name.status, 'match', 'our second borrower matched to the SECOND pair primary');
  assert.strictEqual(f.id_coborrower_name.matchNote, 'Matched to Encompass borrower pair 2 (primary borrower), by name.', 'the note says where it matched');
  // The matched party is pair 2's borrower, so its phone/email are what we compare.
  assert.strictEqual(f.id_coborrower_phone.status, 'match', 'our cell equals the second-pair borrower WORK phone → match');
  assert.strictEqual(f.id_coborrower_email.status, 'match', 'email matches (case-insensitive)');
}
ok('B: a second borrower entered as a SECOND borrower pair is matched to that pair (name + phone + email)');

// ── SCENARIO C — THREE people (borrower + co on pair 1, second pair borrower) ─
{
  const loan = { applications: [
    app(P('John', 'Smith'), P('Mary', 'Adams')),   // Mary is a DIFFERENT person (not on our file)
    app(P('Bob', 'Jones'), null),
  ] };
  // Our file has John (primary) + Bob (second). Bob is on pair 2, NOT the pair-1 co-borrower.
  const row = bor('John', 'Smith', { co_borrower_id: 'x', cb_first_name: 'Bob', cb_last_name: 'Jones' });
  const f = byKey(compareIdentity(row, loan));
  assert.strictEqual(f.id_borrower_name.status, 'match', 'primary → John on pair 1');
  assert.strictEqual(f.id_coborrower_name.status, 'match', 'our second borrower Bob is found on pair 2, skipping the unrelated pair-1 co-borrower');
  assert.strictEqual(f.id_coborrower_name.matchNote, 'Matched to Encompass borrower pair 2 (primary borrower), by name.');
}
ok('C: three parties — our second borrower is matched by NAME to the right party, not the fixed co-borrower slot');

// ── SCENARIO D — our people in the REVERSE Encompass order ──────────────────
{
  const loan = { applications: [
    app(P('Bob', 'Jones'), null),                  // pair 1 borrower = our SECOND person
    app(P('John', 'Smith'), null),                 // pair 2 borrower = our PRIMARY
  ] };
  const row = bor('John', 'Smith', { co_borrower_id: 'x', cb_first_name: 'Bob', cb_last_name: 'Jones' });
  const f = byKey(compareIdentity(row, loan));
  assert.strictEqual(f.id_borrower_name.status, 'match', 'primary matched to pair 2 (not blindly pair-1 borrower)');
  assert.strictEqual(f.id_borrower_name.matchNote, 'Matched to Encompass borrower pair 2 (primary borrower), by name.');
  assert.strictEqual(f.id_coborrower_name.status, 'match', 'second matched to pair 1');
}
ok('D: matching is name-driven, not slot-driven — reversed Encompass order still resolves each person correctly');

// ── SCENARIO E — SSN picks the right twin even with identical names ─────────
{
  const loan = { applications: [
    app(P('John', 'Smith', { _ssnHash: 'HASH_OTHER', _ssnLast4: '0000' }), null),
    app(P('John', 'Smith', { _ssnHash: 'HASH_MINE', _ssnLast4: '4321' }), null),
  ] };
  const row = bor('John', 'Smith', { b_ssn_hash: 'HASH_MINE', b_ssn_last4: '4321' });
  const f = byKey(compareIdentity(row, loan));
  assert.strictEqual(f.id_ssn.status, 'match', 'the borrower is matched to the twin whose SSN hash equals ours (so the SSN row matches)');
}
ok('E: with two identical names, the SSN hash resolves the borrower to the correct pair');

// ── SCENARIO E2 — an SSN proof for the SECOND borrower is never pre-empted ──
// The tricky one: an Encompass party NAME-matches our PRIMARY but SSN-matches our
// SECOND. Assigning SSN for BOTH people BEFORE names must hand that party to the
// second (by SSN), and the primary must fall to the OTHER same-named party (by
// name) — order-independent. (A naive primary-first greedy would let the primary
// grab it by name and LOSE the second's definitive SSN match.)
{
  const loan = { applications: [
    app(P('Alice', 'Adams', { _ssnHash: 'S2', _ssnLast4: '2222' }), null), // name→our primary, SSN→our second
    app(P('Alice', 'Adams'), null),                                          // the primary's real party (by name)
  ] };
  const row = bor('Alice', 'Adams', {                                        // primary: no SSN on file
    co_borrower_id: 'x', cb_first_name: 'Bob', cb_last_name: 'Brown', cb_ssn_hash: 'S2', cb_ssn_last4: '2222',
  });
  const f = byKey(compareIdentity(row, loan));
  assert.strictEqual(f.id_borrower_name.matchNote, 'Matched to Encompass borrower pair 2 (primary borrower), by name.', 'primary lands on the pair-2 same-named party (pair 1 was claimed by the second borrower via SSN)');
  assert.strictEqual(f.id_borrower_name.status, 'match', 'primary name still matches');
  assert.strictEqual(f.id_coborrower_name.matchNote, 'Matched to Encompass borrower pair 1 (primary borrower), by SSN.', 'the second borrower claimed pair 1 by SSN — never pre-empted by the primary name match');
  assert.strictEqual(f.id_coborrower_ssn.status, 'match', 'the SECOND borrower SSN proof is honored (this FAILS under a naive primary-first greedy)');
  // The split helpers are exported and behave.
  assert.ok(_matchBySsn({ ssnHash: 'S2' }, _collectParties(loan), new Set()), '_matchBySsn finds an SSN party');
  assert.strictEqual(_matchBySsn({ ssnHash: 'NOPE' }, _collectParties(loan), new Set()), null, '_matchBySsn with no hash match → null');
  assert.ok(_matchByName({ first: 'Alice', last: 'Adams' }, _collectParties(loan), new Set()), '_matchByName finds a name party');
}
ok('E2: SSN is assigned for BOTH people before names — a second borrower SSN proof is order-independent, never pre-empted');

// ── SCENARIO F — phone match-any (home / cell / work) ───────────────────────
{
  const mk = (partyExtra) => {
    const loan = { applications: [ app(P('John', 'Smith', partyExtra), null) ] };
    const row = bor('John', 'Smith', { b_cell_phone: '555-123-4567' });
    return byKey(compareIdentity(row, loan));
  };
  assert.strictEqual(mk({ homePhoneNumber: '5551234567' }).id_phone.status, 'match', 'our cell equals their HOME phone → match');
  assert.strictEqual(mk({ workPhoneNumber: '5551234567', mobilePhone: '5559990000' }).id_phone.status, 'match', 'our cell equals their WORK phone → match (even with a different cell on file)');
  assert.strictEqual(mk({ mobilePhone: '5559990000', homePhoneNumber: '5558887777' }).id_phone.status, 'mismatch', 'our number matches none of theirs → mismatch');
  assert.strictEqual(mk({}).id_phone.status, 'incomparable', 'no phone on their side → incomparable (never a false mismatch)');
}
ok('F: our one phone matches ANY of home/cell/work; matches none → mismatch; none on file → incomparable');

// ── SCENARIO G — no Encompass match falls back and surfaces the discrepancy ─
{
  const loan = { applications: [ app(P('Totally', 'Different'), null) ] };
  const row = bor('John', 'Smith');
  const f = byKey(compareIdentity(row, loan));
  assert.strictEqual(f.id_borrower_name.status, 'mismatch', 'our borrower not found anywhere → the pair-1 fallback still surfaces the name mismatch (never silently vanishes)');
  assert.strictEqual(f.id_borrower_name.matchNote, null, 'a fallback (no hit) carries no match note');
}
ok('G: when our borrower is nowhere in Encompass, the comparison still surfaces the discrepancy');

// ── SCENARIO H — single-borrower file, Encompass has an extra person ────────
{
  const loan = { applications: [ app(P('John', 'Smith'), P('Ghost', 'Person')) ] };
  const row = bor('John', 'Smith'); // no co_borrower on our side
  const f = byKey(compareIdentity(row, loan));
  assert.strictEqual(f.id_borrower_name.status, 'match', 'primary matches');
  assert.ok(f.id_coborrower_name, 'the extra Encompass person surfaces a co-borrower row');
  assert.strictEqual(f.id_coborrower_name.status, 'incomparable', 'ours blank vs their extra person → incomparable (flags the disagreement, never a false match)');
}
ok('H: an Encompass co-borrower we do not have still surfaces (incomparable), never silently dropped');

console.log(`\nEncompass borrower-pairs pure — ${passed} groups passed`);
