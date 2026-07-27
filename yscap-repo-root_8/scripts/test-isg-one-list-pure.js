'use strict';
/**
 * ONE list for the note-buyer guidelines — the 4th surface (owner-reported 2026-07-27).
 *
 * THE BUG THIS LOCKS DOWN. Three producers assert one fact and each names it differently:
 *   - the desk, off Blue Lake's spec row      → code isg_appraisal_review_123   (warning)
 *   - the desk, off CorrFirst's all-buyer row → code isg_appraisal_review_3345  (warning)
 *   - the whole-loan run's rule table         → code isg_rural_property         (FATAL)
 * All three read the SAME signal (`appraisal_rural`). Keyed on their codes they can never collide,
 * so one rural file said "rural" three times, at two different severities, in two different places
 * — twice as a mild note in Open findings and once as a dealbreaker in the run cockpit.
 *
 * The fix is NOT a list of codes (the desk's are derived from cond_no, so a spec edit would silently
 * re-split the claim). Each producer DECLARES the fact it asserts — the signal name — and that is
 * the merge key. These checks prove the collapse happens, that the DEALBREAKER is what survives,
 * and that nothing unrelated got merged along the way.
 *
 * Pure — no DB, no network.
 */

const assert = require('assert');
const { deskToFindings } = require('../src/lib/underwriting/investor-guidelines/desk-findings');
const review = require('../src/lib/underwriting/investor-guideline-review');
const { dedupeByClaim, claimOf } = require('../src/lib/underwriting/finding-claims');
const fdec = require('../src/lib/underwriting/finding-decisions');

let n = 0;
const t = (name, fn) => { fn(); n += 1; console.log(`  ok ${name}`); };

console.log('ISG one list (pure)');

// The desk's two rural rows — one per note-buyer spec, both keyed on the same concern_field.
const ruralDesk = {
  noteBuyer: { name: 'Blue Lake' },
  verdicts: [{ cond_no: 1 }],
  unhappy: [
    { cond_no: 123, flag: 'appraisal_review', severity: 'warning', name: 'RURAL PROPERTY INELIGIBLE',
      domain: 'property', concern_field: 'appraisal_rural', pilot_template_code: null },
    { cond_no: 3345, flag: 'appraisal_review', severity: 'warning', name: 'RURAL PROPERTY VERIFICATION',
      domain: 'rural', concern_field: 'appraisal_rural', pilot_template_code: null },
  ],
};

t('a desk finding declares the FACT it asserts, not just its own code', () => {
  const f = deskToFindings(ruralDesk);
  assert.strictEqual(f.length, 2);
  for (const x of f) assert.strictEqual(x.factKey, 'isg_signal:appraisal_rural');
});

t('the run rule table declares the same fact under its own code', () => {
  const out = review.review({ note_buyer: 'Blue Lake', appraisal_rural: true });
  const rural = out.find((x) => x.code === 'isg_rural_property');
  assert.ok(rural, 'the rural rule must fire when the appraisal says rural');
  assert.strictEqual(rural.factKey, 'isg_signal:appraisal_rural');
  assert.strictEqual(rural.severity, 'fatal');
});

t('THREE producers, ONE row — and the DEALBREAKER is the one that survives', () => {
  const deskF = deskToFindings(ruralDesk);
  const runF = review.review({ note_buyer: 'Blue Lake', appraisal_rural: true })
    .filter((x) => x.code === 'isg_rural_property');
  assert.strictEqual(deskF.length + runF.length, 3, 'fixture must really produce three');

  const merged = dedupeByClaim([...deskF, ...runF]);
  const rural = merged.filter((x) => String(x.factKey || '') === 'isg_signal:appraisal_rural');
  assert.strictEqual(rural.length, 1,
    `rural must collapse to ONE row, got ${rural.length}: ${rural.map((x) => x.code).join(', ')}`);
  assert.strictEqual(rural[0].severity, 'fatal',
    'the run calls this a dealbreaker — a merge must never quietly downgrade it to a note');
  assert.strictEqual(rural[0].code, 'isg_rural_property');
  // Nothing an auditor needs is thrown away: the codes that also raised it are recorded.
  assert.ok(Array.isArray(rural[0].mergedFrom) && rural[0].mergedFrom.length === 2,
    'the survivor must record the other two codes that raised the same fact');
});

t('order does not decide the winner — the fatal survives either way', () => {
  const deskF = deskToFindings(ruralDesk);
  const runF = review.review({ note_buyer: 'Blue Lake', appraisal_rural: true })
    .filter((x) => x.code === 'isg_rural_property');
  for (const list of [[...deskF, ...runF], [...runF, ...deskF]]) {
    const m = dedupeByClaim(list).filter((x) => String(x.factKey || '') === 'isg_signal:appraisal_rural');
    assert.strictEqual(m.length, 1);
    assert.strictEqual(m[0].severity, 'fatal', 'a warning listed first must not win the merge');
  }
});

t('a transferred appraisal collapses the same way', () => {
  const d = {
    noteBuyer: { name: 'Blue Lake' }, verdicts: [{ cond_no: 1 }],
    unhappy: [{ cond_no: 3349, flag: 'appraisal_review', severity: 'warning', name: 'TRANSFERRED APPRAISAL',
      domain: 'appraisal', concern_field: 'appraisal_transferred', pilot_template_code: null }],
  };
  const runF = review.review({ note_buyer: 'Blue Lake', appraisal_transferred: true })
    .filter((x) => x.code === 'isg_bl_transferred_appraisal');
  assert.strictEqual(runF.length, 1);
  const merged = dedupeByClaim([...deskToFindings(d), ...runF])
    .filter((x) => String(x.factKey || '') === 'isg_signal:appraisal_transferred');
  assert.strictEqual(merged.length, 1);
  assert.strictEqual(merged[0].severity, 'fatal');
});

// ── the merge must not be greedy ─────────────────────────────────────────────
t('a COVERAGE GAP carries no claim key — two missing conditions never merge', () => {
  const d = {
    noteBuyer: { name: 'Blue Lake' }, verdicts: [{ cond_no: 1 }],
    unhappy: [
      { cond_no: 2193, flag: 'coverage_gap', severity: 'fatal', name: 'Construction feasibility report',
        pilot_template_code: 'rtl_cond_feasibility', domain: 'construction_feasibility' },
      { cond_no: 1026, flag: 'coverage_gap', severity: 'warning', name: 'Title commitment',
        pilot_template_code: 'rtl_cond_title', domain: 'title' },
    ],
  };
  const f = deskToFindings(d);
  assert.strictEqual(f.length, 2);
  for (const x of f) assert.strictEqual(x.factKey, undefined,
    'a gap is about a MISSING CONDITION, not a fact — keying it would merge unrelated gaps');
  assert.strictEqual(dedupeByClaim(f).length, 2, 'two different missing conditions are two items of work');
});

t('a rule with no shared signal is untouched — it still keys on its own code', () => {
  assert.strictEqual(review.claimKeyForCode('isg_bl_ny_loan'), null);
  const out = review.review({ note_buyer: 'Blue Lake', property_state: 'NY' });
  const ny = out.find((x) => x.code === 'isg_bl_ny_loan');
  assert.ok(ny);
  assert.strictEqual(ny.factKey, undefined);
  assert.ok(claimOf(ny).startsWith('code:isg_bl_ny_loan'), 'must fall through to the code key');
});

t('claimKeyForCode never throws and never guesses', () => {
  for (const bad of [null, undefined, '', 'nope', 42, {}, []]) {
    assert.strictEqual(review.claimKeyForCode(bad), null, `expected null for ${JSON.stringify(bad)}`);
  }
});

t('a finding with no factKey keys EXACTLY as it did before', () => {
  // The whole rest of the registry must be unaffected by the new branch.
  const plain = { code: 'bank_account_not_borrower', field: 'account_holder', document_id: 'doc-1' };
  assert.strictEqual(claimOf(plain), 'code:bank_account_not_borrower::account_holder::doc-1::');
  const family = { code: 'cot_final_buyer_not_vesting' };
  assert.strictEqual(claimOf(family), 'claim:vesting_entity_vs_contract_buyer');
});

t('two DIFFERENT facts never merge into each other', () => {
  const runF = review.review({
    note_buyer: 'Blue Lake', appraisal_rural: true, appraisal_transferred: true, property_state: 'NY',
  });
  const merged = dedupeByClaim(runF);
  const codes = merged.map((x) => x.code);
  assert.ok(codes.includes('isg_rural_property'), 'rural must survive');
  assert.ok(codes.includes('isg_bl_transferred_appraisal'), 'transferred must survive');
  assert.ok(codes.includes('isg_bl_ny_loan'), 'the New York escalation must survive');
});

// ── the advisory boundary is not weakened by folding these into the list ─────
t('ADVISORY — a merged guideline row still cannot gate clear-to-close', () => {
  const deskF = deskToFindings(ruralDesk);
  for (const x of deskF) {
    assert.strictEqual(x.blocksCtc, false);
    assert.strictEqual(x.id, undefined, 'no stored id ⇒ renders read-only, and fileFatalCount cannot see it');
  }
});

// ── the blind spot the pre-merge audit found ────────────────────────────────
t('a DECORATED finding still keys the same — the producer field cannot re-feed claimOf', () => {
  // THE BUG THIS EXISTS FOR. The first cut named the producer field `claimKey` — a name the route's
  // `decorate()` ALREADY stamps (`claimKey = claimOf(f)`), and decorated findings go straight into
  // openRaw. So claimOf re-read its own output and emitted `claim:claim:…`, which silently un-grouped
  // every CLAIM_FAMILY and broke the durable decision ledger (whose writes key on a RAW shape), so a
  // granted exception stopped suppressing and the finding came back on the next view.
  //
  // The old test only ever called claimOf on an UNDECORATED object, which is exactly why it passed.
  const stored = { id: 'df-1', code: 'contract_buyer_mismatch', field: 'buyer', document_id: 'doc-9' };
  const raw = claimOf(stored);
  const decorated = { ...stored, claimKey: raw };          // what decorate() hands to openRaw
  assert.strictEqual(claimOf(decorated), raw,
    'a decorated finding must key IDENTICALLY to its raw self — otherwise the ledger and the desk disagree');
  assert.ok(!/claim:claim:/.test(claimOf(decorated)), 'the key must never be double-prefixed');

  // …and the family merge still collapses the decorated stored finding with its derived restatement.
  const derived = { code: 'cot_final_buyer_not_vesting', severity: 'warning' };
  const merged = dedupeByClaim([decorated, derived]);
  assert.strictEqual(merged.length, 1, 'the claim family must still merge after decoration');
  assert.strictEqual(merged[0].id, 'df-1', 'the persisted, actionable row must survive');
});

t('the merged survivor INHERITS the handles that make a card actionable', () => {
  // A run finding wins on severity but carries no id and no suggestionId, so the card rendered with
  // no buttons — and once the desk row was dismissed the fatal stood alone, un-dismissable forever.
  const deskRow = {
    code: 'isg_appraisal_review_3345', severity: 'warning', factKey: 'isg_signal:appraisal_rural',
    suggestionId: 'sug-7', isgKey: 'isg-appraisal_review:3345',
  };
  const runRow = { code: 'isg_rural_property', severity: 'fatal', factKey: 'isg_signal:appraisal_rural' };
  for (const list of [[deskRow, runRow], [runRow, deskRow]]) {
    const m = dedupeByClaim(list);
    assert.strictEqual(m.length, 1);
    assert.strictEqual(m[0].severity, 'fatal', 'the dealbreaker still wins');
    assert.strictEqual(m[0].suggestionId, 'sug-7', 'the survivor must inherit the suggestion handle');
    assert.strictEqual(m[0].isgKey, 'isg-appraisal_review:3345', 'and the AI-panel mirror key');
  }
});

t('inheritance never overwrites a handle the survivor already has', () => {
  // THIS TEST USED TO PROVE NOTHING (pre-merge audit 2026-07-27, second pass). Its two rows
  // were both PERSISTED (`id` set), which dedupeByClaim refuses to merge at all — so the
  // inheritance code never ran, and breaking last-writer-wins left it green. It now uses two
  // genuinely MERGEABLE rows that each carry a handle, so the "survivor keeps its own" rule
  // is what is actually under test.
  const survivor = {
    code: 'isg_rural_property', severity: 'fatal', factKey: 'isg_signal:appraisal_rural',
    suggestionId: 'mine', isgKey: 'isg-run:rural',
  };
  const loser = {
    code: 'isg_appraisal_review_3345', severity: 'warning', factKey: 'isg_signal:appraisal_rural',
    suggestionId: 'theirs', isgKey: 'isg-appraisal_review:3345',
  };
  for (const list of [[survivor, loser], [loser, survivor]]) {
    const m = dedupeByClaim(list);
    assert.strictEqual(m.length, 1);
    assert.strictEqual(m[0].code, 'isg_rural_property', 'the dealbreaker survives');
    assert.strictEqual(m[0].suggestionId, 'mine',
      "the survivor's own handle must win — inheriting over it would point the card at the wrong row");
    assert.strictEqual(m[0].isgKey, 'isg-run:rural');
  }
});

t('two PERSISTED rows are never merged — each stays separately resolvable', () => {
  const a = { code: 'contract_buyer_mismatch', id: 'real-1', severity: 'fatal' };
  const b = { code: 'cot_final_buyer_not_vesting', id: 'other-2', severity: 'warning' };
  const m = dedupeByClaim([a, b]);
  assert.strictEqual(m.length, 2, 'two persisted rows must both stay on the desk');
  assert.strictEqual(m[0].id, 'real-1');
});

// ── the decision ledger keys per PRODUCER, not per fact ─────────────────────
t('a decision recorded BEFORE this finding declared a fact still settles it', () => {
  // The regression this locks down: #816's ledger keys on the finding's identity, and its
  // two writers rebuild a raw shape from stored columns with no factKey. If the ledger key
  // had followed the fact, every decision already on file would have stopped matching the
  // moment a producer started declaring one — a dismissal made yesterday coming silently
  // undone. The ledger deliberately ignores factKey, so the key is unchanged.
  const before = { code: 'isg_appraisal_review_3345', field: 'rural' };
  const now = { ...before, factKey: 'isg_signal:appraisal_rural' };
  assert.strictEqual(fdec.keyOf(now), fdec.keyOf(before),
    'declaring a fact must not change the key a decision was recorded under');
  assert.ok(fdec.isSuppressed(new Set([fdec.keyOf(before)]), now),
    'a pre-existing dismissal must keep suppressing');
});

t('a decision on one producer NEVER settles another producer of the same fact', () => {
  // THE THREE REASONS (fourth audit pass). A fact key carries no severity and no note
  // buyer, so sharing one across producers silences work nobody judged:
  //   SEVERITY — desk-sync promises "a decision on a warning does not silence a later
  //     fatal"; a shared key made that guard vacuous.
  //   MEANING — `isg_bl_transferred_appraisal` (Blue Lake: a decline no letter fixes) and
  //     `isg_transferred_appraisal_letter` (everyone else: just ask for the letter) declare
  //     the SAME signal and mean opposite things.
  //   REVERSIBILITY — one key across producers made a dismissal a one-way door.
  const settled = new Set([fdec.keyOf({ code: 'isg_transferred_appraisal_letter' })]);
  assert.ok(!fdec.isSuppressed(settled, {
    code: 'isg_bl_transferred_appraisal', factKey: 'isg_signal:appraisal_transferred', severity: 'fatal' }),
    "Blue Lake's dealbreaker must never be settled by a decision made about the letter warning");
  assert.ok(!fdec.isSuppressed(settled, {
    code: 'isg_rural_property', factKey: 'isg_signal:appraisal_transferred' }),
    'nor any other producer');
  assert.ok(fdec.isSuppressed(settled, { code: 'isg_transferred_appraisal_letter' }),
    'while the finding actually decided stays settled');
});

t('the DISPLAY merge is unaffected — the fact still collapses the cards', () => {
  // The two concerns are separate on purpose: one card to look at, one decision per
  // finding. Merging what you SEE is the owner's ask; merging what you DECIDED is not.
  const m = dedupeByClaim([
    { code: 'isg_appraisal_review_3345', severity: 'warning', factKey: 'isg_signal:appraisal_rural', suggestionId: 's1' },
    { code: 'isg_rural_property', severity: 'fatal', factKey: 'isg_signal:appraisal_rural' },
  ]);
  assert.strictEqual(m.length, 1, 'still ONE row on screen');
  assert.strictEqual(m[0].severity, 'fatal');
  assert.notStrictEqual(fdec.keyOf(m[0]), fdec.keyOf({ code: 'isg_appraisal_review_3345' }),
    'but the two findings keep their own decision identities');
});

t('a decided row with NO severity does not silence a worse finding', () => {
  // The MIRROR IMAGE of db/336's NULL policy, and deliberately so (re-audit 2026-07-27).
  // `finding_decisions.severity` was ADDED by db/336, so NULL there is a real backlog of
  // decisions taken before we recorded it and must keep suppressing. `ai_suggestions.severity`
  // has existed since db/248 and every producer sets it, so NULL there is not a legacy
  // population — treating it as suppress-always would let one such row silence a later
  // DEALBREAKER on that key forever, with nothing to unstick it.
  //
  // The ledger half (NULL suppresses) is asserted in test-isg-one-list-db.
  assert.strictEqual(fdec.sevRank(null), 0, 'an unreadable severity ranks below everything');
  assert.ok(fdec.sevRank('fatal') > fdec.sevRank(null),
    'so a dealbreaker outranks it and is shown again — fail OPEN, never hide');
  assert.strictEqual(fdec.sevRank(' FATAL '), 3,
    'and the rank trims + lowercases, which the mirror-close SQL must match');
});

console.log(`\n${n} checks passed.`);
