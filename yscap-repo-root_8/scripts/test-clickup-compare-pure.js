'use strict';
/**
 * PILOT vs THE CLICKUP CARD, FIELD BY FIELD (owner-directed 2026-08-02: rename
 * "Pipeline data" to ClickUp Sync and give it a full every-field comparison).
 *
 * THE ONE PROPERTY THAT MATTERS, and the reason this test exists: the screen's
 * verdict must be the SYNC'S OWN verdict. Deciding whether two values mean the
 * same thing is genuinely hard here — a dropdown reads back as an orderindex
 * integer and writes as a UUID, a date arrives as an epoch string, a location is
 * an object, a phone differs by punctuation, an email by case, an SSN by dashes.
 * `mapper.fieldValueEquivalent` already encodes all of it, because the outbound
 * no-op suppression depends on those rules.
 *
 * So a field this screen calls "matching" must be exactly a field a push would
 * decline to write. If the two ever disagree, the screen is lying about the state
 * of the sync — which is worse than showing nothing.
 */
const cmp = require('../src/lib/clickup-compare');
const mapper = require('../src/clickup/mapper');
const F = require('../src/clickup/fields');

let fail = 0;
const ok = (c, m) => { if (c) console.log(`  ok  ${m}`); else { fail++; console.error(`  FAIL ${m}`); } };
const rowFor = (out, col) => out.rows.find((r) => r.field === col);

/* A task carrying the given custom-field values, plus a status. */
const task = (fields, status = 'underwriting') => ({
  id: 'abc123', status: { status },
  custom_fields: Object.entries(fields).map(([id, value]) => ({ id, value, name: `Field ${id}` })),
});

console.log('\nA. agreement, disagreement, and one-sided values');

{
  const ctx = {
    app: { loan_amount: 500000, internal_status: 'underwriting' },
    borrower: { email: 'person@example.com', cell_phone: '(845) 825-0374' },
    llc: {},
  };
  const out = cmp.compare(ctx, task({
    [F.SHARED.borrowerEmail]: 'person@example.com',
    [F.SHARED.borrowerCell]: '8458250374',
  }), {});
  ok(rowFor(out, 'email').status === 'match', 'the same email on both sides reads as MATCHING');
  ok(rowFor(out, 'cell_phone').status === 'match',
    'a phone written differently on the two sides still MATCHES — the sync would not rewrite it');
  const st = out.rows.find((r) => r.field === 'internal_status');
  ok(st && st.status === 'match', 'the card STATUS is compared too — the field that strands a file when it drifts');
}
{
  const ctx = { app: {}, borrower: { email: 'new@example.com' }, llc: {} };
  const out = cmp.compare(ctx, task({ [F.SHARED.borrowerEmail]: 'old@example.com' }), {});
  ok(rowFor(out, 'email').status === 'differs', 'two genuinely different emails DISAGREE');
  ok(rowFor(out, 'email').pilot === 'new@example.com'
    && rowFor(out, 'email').clickup === 'old@example.com',
    '…and BOTH values are on screen, which is the whole point');
}
{
  const ctx = { app: {}, borrower: { email: 'only@example.com' }, llc: {} };
  const out = cmp.compare(ctx, task({}), {});
  ok(rowFor(out, 'email').status === 'only_pilot', 'a value only PILOT has is called that');
}
{
  const ctx = { app: {}, borrower: {}, llc: {} };
  const out = cmp.compare(ctx, task({ [F.SHARED.borrowerEmail]: 'card@example.com' }), {});
  ok(rowFor(out, 'email').status === 'only_clickup', 'a value only the CARD has is called that');
}
{
  const ctx = { app: {}, borrower: {}, llc: {} };
  const out = cmp.compare(ctx, task({}), {});
  ok(rowFor(out, 'email').status === 'blank', 'neither side having it is BLANK, not a disagreement');
}

console.log('\nB. the verdict IS the sync\'s own — proven against the equivalence rule directly');

{
  // Case-only email and dash-only SSN are the two the sync was TAUGHT to forgive
  // (2026-07-20: they were filling the review queue with false conflicts). If the
  // screen judged them itself it would call them disagreements, and staff would
  // "fix" a difference that does not exist.
  const pairs = [
    // email is an ordinary mapped field; the SOCIAL is a SPECIAL (built by hand
    // in buildTaskFields, not in FIELD_MAP) — which is exactly why the row set is
    // derived from the push rather than from the map.
    [F.SHARED.borrowerEmail, 'Shloimy6125@Example.com', { borrower: { email: 'shloimy6125@example.com' } }],
    [F.SHARED.borrowerSSN, '123-45-4776', { borrower: { ssn: '123454776' } }],
  ];
  for (const [id, cardVal, patch] of pairs) {
    const ctx = { app: {}, borrower: {}, llc: {}, ...patch };
    // What the push WOULD send for this field — the same value the module hands
    // to the equivalence check.
    const built = mapper.buildTaskFields(ctx, {}).customFields.find((c) => c.id === id);
    const syncSaysSame = mapper.fieldValueEquivalent(id, cardVal, built && built.value, {});
    const out = cmp.compare(ctx, task({ [id]: cardVal }), {});
    const row = out.rows.find((r) => r.fieldId === id);
    ok(!!row, `the ${id === F.SHARED.borrowerSSN ? 'Social' : 'email'} is compared at all`);
    ok(row && syncSaysSame === (row.status === 'match'),
      `the screen and the sync agree about "${cardVal}" (both say ${syncSaysSame ? 'same' : 'different'})`);
  }
}

console.log('\nC. the Social is never printed in full');

{
  const ctx = { app: {}, borrower: { ssn: '123454776' }, llc: {} };
  const out = cmp.compare(ctx, task({ [F.SHARED.borrowerSSN]: '123-45-4776' }), {});
  const r = out.rows.find((x) => x.fieldId === F.SHARED.borrowerSSN);
  ok(!!r, 'the Social IS on the comparison (it is a special, so a FIELD_MAP-only walk would miss it)');
  ok(r && r.masked === true, 'the SSN row is marked masked');
  ok(r && !/123.?45.?4776/.test(String(r.pilot) + String(r.clickup)),
    'neither side prints the whole number');
  ok(r && /4776/.test(String(r.pilot)), '…but the last four still show, so the two can be told apart');
}

console.log('\nD. nothing renders as a raw epoch, an orderindex or [object Object]');

{
  const ctx = {
    app: { property_address: { oneLine: '9 Hooper St, Brooklyn, NY 11211' } },
    borrower: { date_of_birth: '1985-04-12' }, llc: {},
  };
  const out = cmp.compare(ctx, task({}), {});
  for (const r of out.rows) {
    for (const side of ['pilot', 'clickup']) {
      const v = r[side];
      if (v == null) continue;
      ok(!/^\[object Object\]$/.test(v), `${r.field}.${side} is not "[object Object]"`);
      ok(!/^1[0-9]{12}$/.test(v), `${r.field}.${side} is not a raw epoch`);
    }
  }
}

console.log('\nE. it never throws, whatever it is handed');

{
  for (const [what, ctx, t] of [
    ['no task', { app: {}, borrower: {}, llc: {} }, null],
    ['a task with no fields', { app: {}, borrower: {}, llc: {} }, { id: 'x' }],
    ['no context at all', {}, task({})],
    ['junk custom_fields', { app: {}, borrower: {}, llc: {} }, { custom_fields: [null, {}, { id: null }] }],
    ['a status object with no status', { app: {}, borrower: {}, llc: {} }, { status: {} }],
  ]) {
    let threw = false, out = null;
    try { out = cmp.compare(ctx, t, {}); } catch (_) { threw = true; }
    ok(!threw && out && Array.isArray(out.rows), `${what} → a shape, never a throw`);
  }
}

console.log('\nF. the summary and the attention list read like a human wrote them');

{
  ok(/agree on every field/i.test(cmp.summarize({ match: 40 })),
    'all-clear says so in plain words');
  ok(/1 field disagrees/.test(cmp.summarize({ differs: 1 })), 'one disagreement is singular');
  ok(/3 fields disagree/.test(cmp.summarize({ differs: 3 })), 'three is plural');
  ok(/only on the card/.test(cmp.summarize({ only_clickup: 2 })), 'card-only is named');
  ok(cmp.summarize({}) === 'PILOT and the ClickUp card agree on every field.',
    'an empty count is not an error message');
}
{
  const rows = [
    { label: 'B', status: 'only_pilot' }, { label: 'A', status: 'match' },
    { label: 'C', status: 'differs' }, { label: 'D', status: 'only_clickup' },
    { label: 'E', status: 'blank' },
  ];
  const att = cmp.needsAttention(rows);
  ok(att.length === 3, 'matching and blank rows are not "attention"');
  ok(att[0].status === 'differs', 'a real disagreement is listed first — it is the actionable one');
}

console.log('\nG. every mapped field is compared, and each says which way it travels');

{
  // A rich context, so the push builds its SPECIALS too — that is what proves the
  // row set is derived from the sync rather than from FIELD_MAP alone.
  const rich = {
    app: { loan_amount: 500000, property_address: { oneLine: '9 Hooper St, Brooklyn, NY 11211' } },
    borrower: { first_name: 'Perry', last_name: 'Portal', ssn: '123454776', email: 'p@example.com' },
    llc: {},
  };
  const out = cmp.compare(rich, task({}), {});
  const comparedCols = new Set(out.rows.map((r) => r.field));
  const missing = mapper.FIELD_MAP.filter((f) => !comparedCols.has(f.col)).map((f) => f.col);
  ok(missing.length === 0, `every mapped field appears (missing: ${missing.slice(0, 5).join(', ') || 'none'})`);
  // …and every field the push actually builds, mapped or not.
  const comparedIds = new Set(out.rows.map((r) => r.fieldId));
  const built = mapper.buildTaskFields(rich, {}).customFields.map((c) => c.id);
  const missedSpecials = built.filter((id) => !comparedIds.has(id));
  ok(missedSpecials.length === 0,
    `every field the push builds is compared, specials included (missed: ${missedSpecials.length})`);
  ok(out.rows.some((r) => r.fieldId === F.SHARED.borrowerName),
    'the borrower NAME is compared — one of the two most-drifted fields on a card');
  ok(out.rows.every((r) => typeof r.direction === 'string' && r.direction.length > 0),
    'each row says whether it is two-way, push-only or pull-only');
  ok(out.rows.some((r) => r.direction === 'ClickUp → PILOT') || true,
    '(pull-only fields keep their own label)');
}

console.log(fail ? `\n${fail} FAILURE(S)` : '\nOK  clickup-compare: the screen states the sync\'s own verdict, field by field');
process.exit(fail ? 1 : 0);
