'use strict';
/**
 * LT test — THE GENERAL CONDITION CENTER.
 *
 * WHY THIS EXISTS. The owner asked for a second condition centre (2026-08-30) —
 * OUR OWN conditions, distinct from db/612's read-only mirror of Encompass's —
 * with the buckets *"following industry standard"*, and one governing rule:
 *
 *   "everything should be setup with not setting it on a hard level everything
 *    should be able to be configured differently in settings. The system is only
 *    prefilled with the rules of the system."
 *
 * THREE CLASSES OF PROMISE ARE MADE BY THAT BUILD, and none of them has a
 * runtime error to catch it going wrong:
 *
 *   1. A RULE IS DATA, NEVER CODE. A template's rule is authored by a person and
 *      stored as jsonb. If a rule could reach an evaluator that runs it, or a
 *      rule naming a field that does not exist could quietly evaluate to true,
 *      an admin-authored CONDITION becomes an admin-authored program. Nothing
 *      errors when those guards loosen — the rule simply starts firing on files
 *      it should not have.
 *
 *   2. A BLANK IS NOT A NO. `in_flood_zone` on an unread file is UNKNOWN, not
 *      false. Reading it as false takes the flood conditions OFF every unread
 *      file, silently, which is the expensive direction — nobody notices a
 *      condition that is not there.
 *
 *   3. A BORROWER IS NEVER SHOWN AN INTERNAL LABEL. A condition that says it is
 *      borrower-facing and carries no borrower wording is applied staff-only.
 *      The failure looks exactly like working.
 *
 * WHAT IS DELIBERATELY *NOT* HERE. Anything needing a real Postgres — that the
 * unique index refuses a duplicate, that the advisory lock is taken, that the
 * seed is idempotent. Those are facts about a database and belong in a DB suite.
 *
 * PURE. No database, no network, no browser.
 */

const path = require('path');
const fs = require('fs');

let failures = 0;
const check = (cond, msg) => {
  if (cond) console.log(`  ok   ${msg}`);
  else { failures += 1; console.error(`  FAIL ${msg}`); }
};

const R = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
/** These files EXPLAIN the rules and necessarily quote the shapes being
 *  forbidden, so a guard that read the comments would fail on its own
 *  explanation and then get "fixed" by deleting it. */
const code = (p) => R(p)
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/.*$/gm, '$1');

/**
 * The ONE section object out of `workspace.js`'s SECTIONS list, by key.
 *
 * WHY NOT A WINDOW REGEX. The first cut of this guard asked
 * `/key: 'file_conditions',[\s\S]{0,200}applies:/` — and a window that size
 * spills straight into the NEXT entry, so it reported the section as greyed
 * because the section AFTER it has an `applies`. A guard that scans a window can
 * always be satisfied by its neighbour; this cuts at the entry's own closing
 * brace instead.
 */
function sectionEntry(sectionsSrc, key) {
  const i = sectionsSrc.indexOf(`key: '${key}'`);
  if (i < 0) return null;
  // Walk back to this entry's opening brace, then forward to the matching close.
  const open = sectionsSrc.lastIndexOf('{', i);
  let depth = 0;
  for (let j = open; j < sectionsSrc.length; j += 1) {
    if (sectionsSrc[j] === '{') depth += 1;
    else if (sectionsSrc[j] === '}') { depth -= 1; if (depth === 0) return sectionsSrc.slice(open, j + 1); }
  }
  return null;
}

const rules = require('../src/longterm/conditions-center/rules');
const registry = require('../src/longterm/conditions-center/field-registry');
const library = require('../src/longterm/conditions-center/library');
const engine = require('../src/longterm/conditions-center/engine');
const write = require('../src/longterm/conditions-center/write');
const read = require('../src/longterm/conditions-center/read');

const FIELDS = registry.fieldMap();

// ═══════════════════════════════════════════════════════════════════════════
// A. A RULE IS DATA — the whole security boundary
// ═══════════════════════════════════════════════════════════════════════════
console.log('\nA. a rule is data, never code');

const src = [
  'src/longterm/conditions-center/rules.js',
  'src/longterm/conditions-center/engine.js',
  'src/longterm/conditions-center/library.js',
].map(code).join('\n');
check(!/\beval\s*\(/.test(src) && !/new\s+Function\s*\(/.test(src),
  'nothing in the rule path evaluates a string — no eval, no Function constructor');

// A rule naming a field the registry does not carry must answer CANNOT SAY.
// True would put a condition on every file for a reason nobody can explain;
// false would silently take one off.
check(rules.evaluateRule({ field: 'no_such_field', operator: 'eq', value: 1 }, {}, FIELDS) === null,
  'a rule naming a field that does not exist answers null — not true, not false');
check(rules.evaluateRule({ field: 'loan_amount', operator: 'contains', value: 'x' }, { loan_amount: 5 }, FIELDS) === null,
  'a text operator on a money field answers null rather than guessing');

const bad = rules.validateRule({ combinator: 'and', rules: [{ field: 'nope', operator: 'eq', value: 1 }] }, FIELDS);
check(!bad.ok && bad.problems[0].reason === 'unknown_field',
  `the validator NAMES the problem so a person can fix it ("${bad.problems[0].why}")`);

// DEPTH IS CAPPED. An uncapped tree out of a jsonb column is unbounded recursion
// on somebody else's input, and a rule nobody can read on a screen is a rule
// nobody can maintain.
const deep = { combinator: 'and', rules: [{ combinator: 'or', rules: [{ combinator: 'and', rules: [{ field: 'is_condo', operator: 'is_true' }] }] }] };
check(!rules.validateRule(deep, FIELDS).ok, 'a rule nested past one level is refused');
check(rules.evaluateRule(deep, { is_condo: true }, FIELDS) === null, '...and is not evaluated either');

console.log('\nA2. every refusal reason is its own sentence');
const reasons = Object.values(rules.REFUSAL);
check(new Set(reasons).size === reasons.length,
  `all ${reasons.length} refusals read differently — none silently reads as another`);

// ═══════════════════════════════════════════════════════════════════════════
// B. A BLANK IS NOT A NO
// ═══════════════════════════════════════════════════════════════════════════
console.log('\nB. an unknown is an unknown');

// A NUMBER COMPARISON ON A BLANK. Without the short-circuit, "loan amount is
// less than 500,000" is TRUE on a file whose amount has not been read yet, and
// the condition lands on the whole unread book.
check(rules.evaluateRule({ field: 'loan_amount', operator: 'lt', value: 500000 }, {}, FIELDS) === false,
  'a "less than" on a blank amount is FALSE, not true — the condition stays off the unread book');
check(rules.evaluateRule({ field: 'loan_amount', operator: 'is_empty' }, {}, FIELDS) === true,
  '...but the operators that are ABOUT blankness still answer');

// A BOOLEAN THAT HAS NOT BEEN DETERMINED. Neither direction fires.
for (const op of ['is_true', 'is_false']) {
  check(rules.evaluateRule({ field: 'in_flood_zone', operator: op }, { in_flood_zone: null }, FIELDS) === false,
    `an unread flood determination does not fire "${op}" — it has not been determined to be either`);
}

console.log('\nB2. the registry never invents a value');
const empty = registry.read({});
const nulls = Object.entries(empty).filter(([, v]) => v === null).length;
check(nulls === Object.keys(empty).length,
  `an empty file reads as null for all ${nulls} fields — nothing defaults to false or 0`);

const ctx = {
  loan: { loan_purpose: 'cash_out_refinance', loan_amount: 500000, product_kind: 'dscr' },
  property: { state: 'NY', gse_property_type: 'Condominium', in_flood_zone: null, unit_count: 1 },
  residences: [{ residency_type: 'Current', residency_basis: 'rent' }],
  parties: [{ party_type: 'entity', entity_legal_name: 'MW Trading LLC' }],
};
const v = registry.read(ctx);
check(v.is_refinance === true && v.is_cash_out === true && v.is_purchase === false,
  'a cash-out refinance reads as a refinance AND a cash-out, and NOT as a purchase');
check(v.is_condo === true, 'a condominium reads as a condo');
check(v.is_new_york === true, 'New York is derived from the state, so the two can never disagree');
check(v.borrower_rents === true, 'FR0115 (the residency basis) is what says the borrower rents — the owner named this field themselves');
// RE-POINTED 2026-08-31, not loosened. This fixture's loan carries NO
// vesting_type, and field 4008 is now the only thing that decides how a loan
// vests — so the honest answer here is "we have not been told", not "yes". The
// old assertion pinned the PARTIES reading, which is the defect fixed below.
check(v.vests_in_entity === null,
  'a company name on a borrower row does NOT decide the vesting — only field 4008 does, and this fixture has not been told');
check(v.in_flood_zone === null, 'and the flood determination stays UNKNOWN rather than becoming false');

console.log('\nB3. a reader that throws costs its own field, never the evaluation');
const hostile = registry.read({ residences: 'not an array', parties: null, property: 7 });
check(Object.keys(hostile).length === Object.keys(empty).length,
  'malformed context still yields every field — one bad part cannot take down the rest');

console.log('\nB3b. field 4008 decides how a loan vests, and nothing else');
// Owner-directed 2026-08-23 and restated 2026-08-31: "if 4008 is individual
// instead of officer, then no entity condition". 4008 is the vesting field
// (Officer / Individual / Trustee); across the measured book of 486 loans it
// reads 445 Officer, 22 Individual, 19 blank.
//
// EVERY CASE BELOW CARRIES A STALE COMPANY NAME ON A BORROWER ROW, and that is
// the whole point: before this, that row is what switched the condition on, so
// an Individual-vested loan was asked for formation documents it does not need.
const stale = [{ party_type: 'entity', entity_legal_name: 'Stale Holdings LLC' }];
const vestRead = (vesting_type) => registry.read({ loan: { vesting_type }, parties: stale });

check(vestRead('Individual').vests_in_entity === false,
  'Individual means individual — the company name on the borrower row is not even consulted');
check(vestRead('Officer').vests_in_entity === true, 'Officer means the title is in a company');
check(vestRead('Trustee').vests_in_entity === true, 'Trustee is an entity vesting too — the tenant\'s own completion rule says so');
check(vestRead(null).vests_in_entity === null,
  'and nothing stated is NOT "Individual" — an unanswered loan says so rather than claiming a fact');
check(vestRead('a word the book has never shown').vests_in_entity === null,
  'a word nobody has seen draws no conclusion either');

// THE WORDS HAVE ONE DEFINITION. A second copy of "individual"/"officer"/
// "trustee" here is how one screen calls a loan individual while another asks it
// for company papers, so the registry must delegate rather than re-type them.
const regSrc = R('src/longterm/conditions-center/field-registry.js');
check(/require\('\.\.\/vesting'\)/.test(regSrc),
  'the registry asks vesting.js what 4008\'s words mean rather than keeping its own list');
check(!/['\"](officer|trustee|individual)['\"]/i.test(regSrc.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '')),
  '...and does not spell those words itself, so the two can never drift');

console.log('\nB3c. the company-documents condition follows 4008 — including when it is blank');
const entityCond = library.library().find((c) => c.code === 'lt_vesting_entity');
check(!!entityCond && !!entityCond.ruleLogic,
  'CONTROL: the condition really carries a rule — an absent rule applies to EVERY file, so an assertion against `undefined` would pass for the wrong reason');
const asks = (vesting_type) => rules.evaluateRule(
  entityCond.ruleLogic, registry.read({ loan: { vesting_type }, parties: stale }), FIELDS);
check(asks('Individual') === false,
  'THE ONE THAT MATTERS: an Individual-vested loan is NOT asked for company documents, even with a stale company name on it');
check(asks('Officer') === true && asks('Trustee') === true,
  'an entity-vested loan still is');
check(asks(null) === true,
  'and a loan Encompass has not answered for KEEPS being asked (owner-directed 2026-08-31: "keep asking for them") — a blank must never quietly drop the condition');

// ── THE ENTITY NAME (field 1859) NEVER DECIDES — 4008 does ──────────────────
// Owner, 2026-08-31: "entity name is 1859, but if 4008 Individual then 1859
// will be empty. But if 4008 is officer, then even if 1859 is empty, it means
// that it was just not entered yet, but it's going to be an entity."
//
// So the name is a CONSEQUENCE of the vesting, never an input to it. Both
// halves are pinned because both are one careless change away: requiring a name
// before asking for the documents would silently drop the condition off every
// Officer loan whose name has not been typed in yet, and consulting a stale
// name on an Individual loan is the defect this whole change fixed.
const asksNamed = (vesting_type, vesting_entity_name) => rules.evaluateRule(
  entityCond.ruleLogic,
  registry.read({ loan: { vesting_type, vesting_entity_name }, parties: [] }),
  FIELDS);

check(asksNamed('Officer', '') === true && asksNamed('Officer', null) === true,
  'THE OWNER\'S OWN CASE: an Officer loan whose entity name has NOT been entered yet is still asked for the company documents — the name is coming, the vesting is already decided');
check(asksNamed('Officer', 'MW Trading LLC') === true,
  '...and one that HAS a name is asked for exactly the same thing, so the name changes nothing either way');
check(asksNamed('Individual', 'Stale Holdings LLC') === false,
  'while an Individual loan is not asked, even when field 1859 still carries a name from a previous vesting');

console.log('\nB4. the investor is not a rule field, on purpose');
check(!registry.catalog().some((f) => /investor/i.test(f.key) || /investor/i.test(f.label)),
  'no rule can be keyed on the investor — a rule\'s DESCRIPTION is rendered on screens, and CLAUDE.md rule 10 makes that name internal everywhere');

// ═══════════════════════════════════════════════════════════════════════════
// C. THE LIBRARY — the owner's own list, and it verifies
// ═══════════════════════════════════════════════════════════════════════════
console.log('\nC. the seeded library');

const verified = library.verify();
if (!verified.ok) for (const p of verified.problems) console.error(`       ${p.code}: ${p.problem}`);
check(verified.ok, 'every seeded condition verifies: real bucket, real rule fields, wording matching its audience');

const L = library.library();
check(L.length >= 25, `the owner's list is seeded (${L.length} conditions)`);
check(new Set(L.map((c) => c.code)).size === L.length, 'no two conditions share a code');

const byBucket = L.reduce((a, c) => { a[c.bucketKey] = (a[c.bucketKey] || 0) + 1; return a; }, {});
// 14 since db/674 retired the stand-alone HOA contact condition (2026-09-02).
check((byBucket.prior_to_submission || 0) >= 14,
  `the prior-to-submission set is here (${byBucket.prior_to_submission})`);
check((byBucket.prior_to_ctc || 0) >= 10,
  `the prior-to-clear-to-close set is here (${byBucket.prior_to_ctc})`);

// THE OWNER NAMED THESE BY NAME. Each is checked by what it IS, not by its code
// alone, so renaming one cannot quietly drop the requirement behind it.
const byCode = new Map(L.map((c) => [c.code, c]));
for (const [codeKey, what] of [
  ['lt_reo_liabilities', 'the mortgages-on-the-credit-report condition'],
  ['lt_vesting_entity', 'the entity condition'],
  ['lt_subject_mortgage_statement', 'the subject-property mortgage statement'],
  ['lt_file_contacts', 'the file contacts'],
  ['lt_order_title', 'the title order'],
  ['lt_order_insurance', 'the insurance order'],
  ['lt_order_flood_insurance', 'the flood insurance order'],
  ['lt_order_ny_settlement_agent', 'the New York settlement agent order'],
  ['lt_appraisal_card', 'the card for the appraisal'],
  ['lt_vor_sent', 'the verification of rent'],
  ['lt_photo_id', 'the government photo ID'],
  ['lt_payoff_ordered', 'the payoff order'],
  ['lt_condo_questionnaire_ordered', 'the condo questionnaire'],
  ['lt_purchase_contract', 'the purchase contract'],
  ['lt_cash_out_letter', 'the cash-out letter'],
  ['lt_title_docs', 'the title documents'],
  ['lt_ny_settlement_docs', 'the settlement agent documents'],
  ['lt_insurance_docs', 'the insurance documents'],
  ['lt_flood_insurance_docs', 'the flood documents'],
  ['lt_housing_history', 'the rent / mortgage / rent-free verification'],
  ['lt_vom_subject', 'the subject-property mortgage verification'],
  ['lt_lease_agreement', 'the lease'],
  ['lt_cash_to_close', 'the cash to close'],
  ['lt_emd', 'the earnest money deposit'],
  ['lt_payoff_received', 'the payoff received'],
  ['lt_condo_docs', 'the condo documents'],
]) {
  check(byCode.has(codeKey), `${what} is in the library`);
}

/* THE LANDLORD LEFT THIS LIST ON 2026-08-31, AND DID NOT LEAVE THE PRODUCT.
   Owner-directed: *"You can technically remove that condition. Landlord contact
   details: you can just add landlord contact information directly to the file
   contact condition and the FileContacts section."* So the roster above no longer
   names it — and the fact it stood for is asserted where it now lives, or
   retiring a condition would read as quietly dropping a requirement. */
check(!byCode.has('lt_landlord_contact'),
  'the landlord is NOT a condition any more (db/660)');
{
  const landlord = library.FILE_CONTACT_TYPES.find((t) => t.key === 'landlord');
  check(!!landlord, '…it is a slot on the File contacts desk instead');
  check(landlord && landlord.whenField === 'borrower_rents',
    "…offered only when the borrower RENTS — the owner's \"the field that is telling you if he rents … is FR0115\"");
}

console.log('\nC2. the rules the owner stated by name');
const c = (k) => byCode.get(k);
// The RENTS rule is unchanged; the condition it hangs off is now the verification
// of rent itself, which is where the rent and the tenancy date are typed (db/660).
check(rules.evaluateRule(c('lt_vor_sent').ruleLogic, { borrower_rents: true }, FIELDS) === true
   && rules.evaluateRule(c('lt_vor_sent').ruleLogic, { borrower_rents: false }, FIELDS) === false,
  'the verification of rent asks only when the borrower RENTS — the owner\'s "the field that is telling you if he rents … is FR0115"');
check((c('lt_vor_sent').config.fields || []).join(',') === 'monthly_rent,rented_since',
  '…and it collects the two tenancy facts the retired landlord condition used to');
// The stand-alone HOA contact condition was retired by db/674 (2026-09-02): the
// HOA row now lives on the file-contacts condition, greyed unless the property
// is a condominium, and the questionnaire order keeps its own rule.
check(rules.evaluateRule(c('lt_condo_questionnaire_ordered').ruleLogic, { is_condo: true }, FIELDS) === true
   && rules.evaluateRule(c('lt_condo_questionnaire_ordered').ruleLogic, { is_condo: false }, FIELDS) === false,
  'the condo questionnaire only on a condo');
check(!L.some((t) => t.code === 'lt_hoa_contact')
   && (c('lt_file_contacts').config.contactTypes || []).some((t) => t.key === 'hoa' && t.whenField === 'is_condo'),
  'the HOA contact is a row on the file-contacts condition that turns on only on a condo — the stand-alone condition is retired (db/674)');
check(rules.evaluateRule(c('lt_ny_settlement_docs').ruleLogic, { is_new_york: true }, FIELDS) === true
   && rules.evaluateRule(c('lt_ny_settlement_docs').ruleLogic, { is_new_york: false }, FIELDS) === false,
  'the settlement agent is New York only');
check(rules.evaluateRule(c('lt_emd').ruleLogic, { is_purchase: true }, FIELDS) === true
   && rules.evaluateRule(c('lt_emd').ruleLogic, { is_purchase: false }, FIELDS) === false,
  'the deposit and the cash to close are asked on a purchase');
check(rules.evaluateRule(c('lt_payoff_received').ruleLogic, { is_refinance: true }, FIELDS) === true,
  'the payoff is asked on a refinance');
check(rules.evaluateRule(c('lt_cash_out_letter').ruleLogic, { is_cash_out: true }, FIELDS) === true
   && rules.evaluateRule(c('lt_cash_out_letter').ruleLogic, { is_cash_out: false, is_refinance: true }, FIELDS) === false,
  'the cash-out letter is asked on a CASH-OUT refinance and not on a rate-and-term one');

console.log('\nC3. New York genuinely asks for less title paperwork');
const titleSlots = c('lt_title_docs').slots;
const nyDropped = titleSlots.filter((s) => s.notWhenField === 'is_new_york').map((s) => s.key);
/* THREE, since 2026-09-02 (audit S4): the wiring instructions leave the New York
   title ask with the CPL and the preliminary statement — the shared title letter
   (`lib/order-email.js` NY_TITLE_CUT) never asked New York title for them, and
   the slot stayed required here. The settlement agent is asked for all of it. */
check(nyDropped.includes('cpl') && nyDropped.includes('prelim_settlement') && nyDropped.includes('wire_instructions'),
  `New York drops the closing protection letter, the preliminary settlement statement and the wiring instructions (${nyDropped.join(', ')}) — the settlement agent handles all three, and leaving slots nobody can fill makes a file look permanently incomplete`);
const nySlots = read._internals.slotsFor(
  { slots: titleSlots, answer: { fields: { is_new_york: true } } }, true,
);
check(nySlots.length === titleSlots.length - 3 && !nySlots.some((s) => s.key === 'cpl' || s.key === 'wire_instructions'),
  `...and a New York file really is shown fewer slots (${nySlots.length} of ${titleSlots.length})`);
const otherSlots = read._internals.slotsFor(
  { slots: titleSlots, answer: { fields: { is_new_york: false } } }, true,
);
check(otherSlots.length === titleSlots.length, 'everywhere else still asks for the whole package');

console.log('\nC4. the housing history is one-of, not a list');
const hh = c('lt_housing_history');
check(hh.config.oneOf === true && hh.slots.length === 3,
  'rent verification / mortgage verification / rent-free letter are ALTERNATIVES — asking for all three would be asking for two things that cannot both exist');
check(hh.slots.every((s) => s.whenField && FIELDS[s.whenField]),
  'and each is gated on a real field, so the right one shows for the right borrower');

console.log('\nC5. anything shipped switched off says WHY, and appraisal ordering is gone');
/* A condition may be built and held back — it then shows greyed WITH ITS REASON, so
   nobody thinks a feature vanished. Nothing ships that way today; what is asserted is
   the RULE, so a future one cannot ship silent. */
const off = L.filter((x) => !x.isEnabled);
for (const c of off) {
  check(!!c.disabledReason, `${c.code} is switched off and says why, so it greys rather than vanishing`);
}
check(true, `${off.length} condition(s) ship switched off, and each carries its reason`);
/* APPRAISAL ORDERING WAS REMOVED (owner-directed 2026-08-30: "Skip the appraisal
   ordering. We're not going to do the appraisal ordering."). Asserted ABSENT rather
   than simply unmentioned: this template is `auto_apply: 'always'`, so a block
   restored by a merge would put it back on every long-term file in the book. */
check(!L.some((x) => x.code === 'lt_order_appraisal'),
  'appraisal ordering is out of the library, and cannot come back unnoticed');

// ═══════════════════════════════════════════════════════════════════════════
// D. THE ENGINE — attach, retract, and never on a guess
// ═══════════════════════════════════════════════════════════════════════════
console.log('\nD. the engine decides, and says why');

const T = (over) => ({ code: 'x', auto_apply: 'rules', rule_logic: when('is_condo', 'is_true'), audience: 'internal', borrower_label: null, ...over });
function when(field, operator, value) {
  return { combinator: 'and', rules: [value === undefined ? { field, operator } : { field, operator, value }] };
}

check(engine.decide(T({ auto_apply: 'always', rule_logic: null }), {}, FIELDS).apply === true,
  'an "always" condition applies with no rule to read');
check(engine.decide(T(), { is_condo: true }, FIELDS).apply === true, 'a matching rule attaches');
check(engine.decide(T(), { is_condo: false }, FIELDS).apply === false, 'a non-matching rule does not');
const cannot = engine.decide(T({ rule_logic: when('gone', 'is_true') }), {}, FIELDS);
check(cannot.apply === null, 'a rule PILOT cannot read decides NOTHING — it attaches nothing and retracts nothing');
check(/could not read/i.test(cannot.why), `...and says so in words ("${cannot.why.slice(0, 70)}…")`);
check(/matches/i.test(engine.decide(T(), { is_condo: true }, FIELDS).why),
  'and a decision explains itself with the rule in plain words');

console.log('\nD2. a borrower is never shown an internal label');
check(engine.effectiveAudience({ audience: 'both', borrower_label: 'Your photo ID' }).audience === 'both',
  'a borrower-facing condition WITH borrower wording is applied as written');
const down = engine.effectiveAudience({ audience: 'both', borrower_label: '   ' });
check(down.audience === 'internal' && down.downgraded === true,
  'one WITHOUT is applied staff-only and SAYS it was downgraded — showing a client an internal label is worse than not showing them the condition');
check(engine.effectiveAudience({ audience: 'internal', borrower_label: 'x' }).audience === 'internal',
  'and an internal condition stays internal whatever wording it carries');

console.log('\nD3. only the engine\'s own untouched work is ever retracted');
const eng = code('src/longterm/conditions-center/engine.js');
check(/origin_kind = 'auto'/.test(eng) && /status = \$2/.test(eng) && /COALESCE\(notes,''\) = ''/.test(eng),
  'the DELETE is guarded on origin, on status AND on there being no note — in the STATEMENT, not by a check somebody has to remember');
// The conditions are `checklist_items` since db/653, so their documents are the
// shared `documents` rows. The guard is the same guard; only the table it names
// moved, and it must stay INSIDE the DELETE — a read-then-write here is the
// shape db/401 records as having cost real duplicate conditions on the RTL side.
check(/NOT EXISTS \(SELECT 1 FROM documents d WHERE d\.checklist_item_id/.test(eng),
  'and on there being no documents on it — a condition somebody has provided for is theirs');
check(/pg_advisory_lock/.test(eng) && /pg_advisory_unlock/.test(eng),
  'the pass takes a per-file advisory lock and releases it');
check(/out\.locked = true/.test(eng) && /lockClient = null/.test(eng),
  '...and FAILS OPEN when it cannot: a missed lock costs one row the unique index refuses anyway, while refusing to evaluate would silently stop conditions attaching');

// ═══════════════════════════════════════════════════════════════════════════
// E. THE SIGN-OFF GATE — nothing un-reviewed is fulfilment
// ═══════════════════════════════════════════════════════════════════════════
console.log('\nE. what may be marked done');

// A DOCUMENT IS A SHARED `documents` ROW NOW (db/653), so the per-slot key
// travels in `slot_label` — the ordinary document plumbing carries it, with no
// second table. The RULE the fixtures exercise is unchanged.
const doc = (over) => ({ id: 'f', is_current: true, review_status: 'accepted', slot_label: null, ...over });
const CONDITION = { kind: 'document', is_required: true, slots: [{ key: 'a', label: 'Thing A', required: true }] };

check(!write.signOffProblem(CONDITION, [doc({ review_status: 'pending' })]).ok,
  'a document nobody has looked at blocks the sign-off — "nobody threw this away" is not "somebody checked this"');
check(/not been looked at/i.test(write.signOffProblem(CONDITION, [doc({ review_status: 'pending' })]).why),
  '...and the refusal says what to do about it');
check(!write.signOffProblem(CONDITION, []).ok,
  'a required document condition with nothing on it cannot be signed off');
check(!write.signOffProblem(CONDITION, [doc({ slot_label: 'other' })]).ok,
  'a required SLOT that is still empty blocks it');
check(/Thing A/.test(write.signOffProblem(CONDITION, [doc({ slot_label: 'other' })]).why),
  '...and names the slot, so the refusal is actionable');
check(write.signOffProblem(CONDITION, [doc({ slot_label: 'Thing A' })]).ok,
  'and the accepted document in the right slot clears it');
check(write.signOffProblem({ ...CONDITION, is_required: false, slots: [] }, []).ok,
  'an OPTIONAL condition may be signed off with nothing — otherwise there is no way to close one');
check(write.signOffProblem({ kind: 'order', is_required: true, slots: [] }, []).ok,
  'an ORDER is not blocked for want of a document — it is not a document condition');

const failed = write.signOffProblem(CONDITION, [], { readFailed: true });
check(failed.ok && !!failed.checkSkipped,
  'an unreadable read FAILS OPEN and says the check did not run — a database hiccup must never make a condition permanently unsignable');
check(/skipped|did not check/i.test(failed.checkSkipped),
  `...and that is recorded on the row rather than being silent ("${failed.checkSkipped.slice(0, 60)}…")`);

console.log('\nE2. a waiver is a decision and is recorded as one');
const wsrc = code('src/longterm/conditions-center/write.js');
check(/clean\.length < 4/.test(wsrc), 'a waiver with no reason is refused');
check(/waived_reason = NULL/.test(wsrc) && /signed_off_at = NULL/.test(wsrc),
  'and every finish CLEARS the other one\'s stamps — a row that reads "satisfied" and "waived by" at once contradicts itself');
// `manual_library` is the shared table's own word for "a person added this out
// of the library" — the same distinction, under the name this table has always
// used for it, which is what the retraction rule depends on.
check(/origin_kind = \$3/.test(wsrc) && /originToShared\('manual'\)/.test(wsrc),
  'only a condition somebody ADDED by hand can be removed; a rule-driven one is waived with a reason instead');

// ═══════════════════════════════════════════════════════════════════════════
// F. THE CLIENT'S VIEW IS BUILT, NOT STRIPPED
// ═══════════════════════════════════════════════════════════════════════════
console.log('\nF. what a borrower sees');

const row = {
  id: '1', code: 'x', bucket_key: 'prior_to_submission', kind: 'document', status: 'outstanding',
  is_required: true, slots: [], label: 'Internal label', hint: 'Internal instruction',
  borrower_label: 'Your photo ID', borrower_hint: 'A driver’s licence.',
  audience: 'both', origin: 'auto', notes: 'internal note nobody outside should read',
  config: { vendor: 'nan' }, answer: {}, waived_reason: 'because',
  satisfied_by_name: 'Chaya', file_count: 0, accepted_count: 0, is_enabled: true,
};
const client = read._internals.shape(row, false);
check(client.label === 'Your photo ID' && client.hint === 'A driver’s licence.',
  'the client gets the BORROWER wording');
for (const k of ['notes', 'config', 'answer', 'waivedReason', 'satisfiedBy', 'origin', 'audience', 'disabledReason', 'borrowerLabel']) {
  check(!(k in client), `and never "${k}" — the client payload is BUILT for the client, not the internal one with fields deleted`);
}
const staff = read._internals.shape(row, true);
check(staff.label === 'Internal label' && staff.notes === row.notes,
  'while our team gets the internal label and the note');

check(read.CLIENT_VISIBLE.has('both') && read.CLIENT_VISIBLE.has('external') && !read.CLIENT_VISIBLE.has('internal'),
  'an internal condition never reaches a client list at all');

console.log('\nF2. done is three facts, never one');
const s = read._internals.emptySummary();
for (const st of ['satisfied', 'waived', 'not_applicable']) read._internals.count(s, { status: st });
check(s.satisfied === 1 && s.waived === 1 && s.notApplicable === 1 && s.done === 3,
  'satisfied, waived and did-not-apply are counted separately AND roll up — the last two are what somebody asks about a year later');

// ═══════════════════════════════════════════════════════════════════════════
// G. THE SCREENS — reachable, and honest about what they cannot do
// ═══════════════════════════════════════════════════════════════════════════
console.log('\nG. it is on somebody\'s screen');

const app = code('app-v2/src/App.jsx');
const layout = code('app-v2/src/components/StaffLayout.jsx');
const section = code('app-v2/src/longterm/LtFileConditions.jsx');
const libScreen = code('app-v2/src/longterm/LtConditionLibrary.jsx');
const workspace = code('src/longterm/workspace.js');
const routes = code('src/longterm/routes/condition-center.js');
const loanScreen = code('app-v2/src/longterm/LtLoan.jsx');

const fileCondSection = sectionEntry(workspace, 'file_conditions');
check(!!fileCondSection, 'the file screen has a Conditions section for OUR conditions');
check(fileCondSection && !/applies:/.test(fileCondSection),
  '...and it is always available — the file with no conditions worked out yet is exactly the one somebody opens it to fix');
// The control: the guard must be able to SEE an `applies` when there is one, or
// the assertion above proves nothing.
check(/applies:/.test(sectionEntry(workspace, 'employment') || ''),
  '(control) the same reader DOES find the `applies` on a section that has one');
check(/<LtFileConditions loanId=\{loanId\}/.test(loanScreen), 'and it is actually rendered');
check(/label: 'Investor conditions \(Encompass\)'/.test(workspace),
  'the Encompass mirror is renamed so the two centres cannot be mistaken for each other');

check(/<Route path="\/internal\/lt\/condition-library"/.test(app), 'the library has a route');
check(/to="\/internal\/lt\/condition-library"/.test(layout),
  'and a nav entry — a settings screen nobody can reach is not a setting');

check(/ltApi\.fileConditions\(/.test(section) && !/ltApi\.conditionCenter\(/.test(section),
  'the section calls fileConditions, NOT conditionCenter — that name belongs to the Encompass mirror and an object literal lets the later key silently win');
check(/rowErr/.test(section) && /problem/.test(section),
  'a refusal is rendered on the ROW that caused it, not in a banner at the top of a long screen');
/* RE-POINTED 2026-08-30, and it is a change of FACT rather than a loosening.
   This asserted that the section imported NOTHING from the short-term side,
   which was true and correct while the crossing was unauthorized. The owner then
   authorized exactly this one — *"the same look of the Condition Center … the way
   you preview stuff, the way you preview the PDFs, the way you drag and drop,
   accept, reject, preview, download, and delete … it should update them both
   places. You need to share the code."* — and the whole point of the shipment is
   that the section now mounts those components rather than a lookalike. So the
   guard asserts the SHARE, and then keeps the two properties the original was
   really protecting. */
for (const shared of ['ConditionLine', 'ConditionActions', 'DocPreview', 'DropZone', 'UploadRows', 'LoudHint']) {
  check(new RegExp(`from '\\.\\./components/${shared}\\.jsx'`).test(section),
    `the section mounts the REAL shared ${shared} — the owner's "share the code", not a Long-Term lookalike`);
}
/* THE DIALOG HOST IS STILL NOT IMPORTED, and that is the property the original
   guard existed for: a SECOND overlay host inside one app is worse than either,
   so a refusal, a waiver's reason and a rejection's reason are all typed ON THE
   ROW. (`ConditionActions` reaches the short-term host for its own send-back
   prompt — which is why this screen passes `canSendBack={false}`, so that path is
   never taken here.) */
check(!/from '\.\.\/lib\/dialog/.test(section),
  'and the section still never imports the shared dialog host — a refusal and a reason are typed on the row');
/* AND IT STILL HAS ITS OWN CLIENT. `lib/api.js` is the short-term request layer;
   Long-Term speaks to /api/lt through `ltApi`, which is what keeps the two
   products' request layers apart. */
check(!/from '\.\.\/lib\/api/.test(section) && /from '\.\/api\.js'/.test(section),
  'and it still calls the Long-Term client, never the short-term one');

check(/ruleInWords/.test(libScreen) && /ruleInWords/.test(routes),
  'the library screen shows each rule IN WORDS, from the server — a rule an administrator cannot read is one they cannot safely change');
check(/data\.fields|data\.audiences|data\.kinds/.test(libScreen),
  'and its pickers come from the server\'s own catalog rather than a second copy here');
check(/out\.note/.test(libScreen) && /keep the wording they were given/.test(R('src/longterm/routes/condition-center.js')),
  'saving a template SAYS it does not rewrite the files that already carry a copy — otherwise somebody believes they just changed every file in the book');

for (const [needle, why] of [
  [/var\(--ink/, 'no --ink token as a text colour (every one of them is a LIGHT paper colour in this palette)'],
]) {
  check(!needle.test(section) && !needle.test(libScreen), why);
}

console.log('\nG2. the API client cannot collide with itself');
const api = R('app-v2/src/longterm/api.js');
const keys = [...api.matchAll(/^ {2}([a-zA-Z][a-zA-Z0-9_]*)\s*[:(]/gm)].map((m) => m[1]);
const dupes = [...new Set(keys.filter((k, i) => keys.indexOf(k) !== i))];
check(dupes.length === 0,
  `no two client methods share a name (${keys.length} methods)${dupes.length ? ` — found ${dupes.join(', ')}` : ''}. In an object literal the later key wins SILENTLY, which is how one screen starts calling another screen's endpoint`);

// ═══════════════════════════════════════════════════════════════════════════
// H. SEPARATION — this is Long-Term's own build
// ═══════════════════════════════════════════════════════════════════════════
console.log('\nH. nothing here crosses without the owner\'s written authorization');
// THIS USED TO ASSERT THAT NOTHING CROSSED AT ALL, and that was the right rule
// until 2026-08-30, when the owner ordered the Long-Term conditions INTO the one
// Condition Center — *"take that exact Condition Center and make your conditions
// in that Condition Center follow those rules … you need to share the code."*
// The rule did not disappear, it became PER ITEM: a crossing is legal only when
// the ledger names it.
//
// SO THE ALLOW-LIST IS READ OUT OF THE LEDGER RATHER THAN TYPED HERE. A list
// retyped in a test is a second copy of the authorization, and the copy that
// drifts is the one that quietly permits something nobody agreed to; deriving it
// means adding a require without a ledger line still fails the build, which is
// exactly what the blanket rule was protecting.
const ledgerBlock = (R('docs/LONG-TERM-AUTHORIZED-COPIES.md').match(/```authorized\n([\s\S]*?)```/) || [])[1] || '';
const AUTHORIZED = new Set(
  ledgerBlock.split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => (l.match(/^import\s+(\S+)\s*$/) || [])[1])
    .filter(Boolean));
check(AUTHORIZED.size > 0, `the crossing ledger was read (${AUTHORIZED.size} authorized imports)`);

for (const f of [
  'src/longterm/conditions-center/rules.js',
  'src/longterm/conditions-center/field-registry.js',
  'src/longterm/conditions-center/library.js',
  'src/longterm/conditions-center/vocabulary.js',
  'src/longterm/conditions-center/engine.js',
  'src/longterm/conditions-center/read.js',
  'src/longterm/conditions-center/write.js',
  'src/longterm/conditions-center/workspace.js',
  'src/longterm/routes/condition-center.js',
]) {
  const requires = [...code(f).matchAll(/require\(['"]([^'"]+)['"]\)/g)].map((m) => m[1]);
  const crossing = requires.filter((r) => /^\.\.\/\.\.\//.test(r));
  // A relative require out of src/longterm/<dir>/x.js resolves under src/.
  const unauthorized = crossing.filter((r) => !AUTHORIZED.has(`src/${r.replace(/^\.\.\/\.\.\//, '')}${/\.[a-z]+$/.test(r) ? '' : '.js'}`));
  check(unauthorized.length === 0,
    `${f} crosses only where the ledger says it may${unauthorized.length ? ` (unauthorized: ${unauthorized.join(', ')})` : ''}`);
}
// The migration must not have quietly become part of the Encompass mirror.
const mig = R('db/643_lt_general_condition_center_buckets_templates_and_file_condi.sql');
check(/lt_condition_buckets|lt_condition_templates|lt_file_conditions|lt_condition_files/.test(mig)
   && !/CREATE TABLE[\s\S]{0,80}\blt_conditions\b/.test(mig),
  'db/643 creates its OWN four tables and does not touch db/612\'s Encompass mirror');
check(/ON CONFLICT \(key\) DO NOTHING/.test(mig),
  'and its bucket seed never overwrites — a buyer who renames a gate keeps their name through every redeploy');

console.log(failures ? `\n${failures} FAILED` : '\nAll good.');
process.exit(failures ? 1 : 0);
