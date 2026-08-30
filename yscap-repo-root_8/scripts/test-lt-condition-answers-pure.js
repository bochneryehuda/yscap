'use strict';
/**
 * LT test — THE THREE CONDITIONS THAT ARE NOT AN UPLOAD.
 *
 * The owner, correcting the shipped list on 2026-08-30:
 *
 *   · *"This is not only a form. It's either a form or a mortgage statement
 *     upload. You don't need to fill in the form, or you can just select a
 *     certain one that is primary … It's one out of three."*
 *   · *"This one, according to my original instructions, also has the option,
 *     instead of an upload, to be a form to type in a few pieces of information,
 *     and also you can just select that it's FCI, whatever, and then you don't
 *     need anything, not an attachment and not a form."*
 *   · *"Cash-out letter … This one is not prior to submittal. This one is prior
 *     to clear to close."*
 *   · *"You're missing the optional certificate of good standing."*
 *
 * WHAT WAS ACTUALLY WRONG, and it is the reason this suite exists: the library
 * DESCRIBED all of this — `answers: ['upload_statement','linked_to_primary',
 * 'typed_address']`, `typedFields`, `waiver` — and NOTHING READ ANY OF IT. Those
 * keys appeared in `library.js` and in no other file in the repository. A config
 * key nothing reads is a description of a feature, not the feature, and it reads
 * as done on every screen that renders the library.
 *
 * PURE. No database, no network.
 */

const path = require('path');
const fs = require('fs');
const answers = require('../src/longterm/conditions-center/answers.js');
const workspace = require('../src/longterm/conditions-center/workspace.js');
const library = require('../src/longterm/conditions-center/library.js');
const { stripComments } = require('./lib/strip-comments.js');

let failures = 0;
const check = (cond, msg) => {
  if (cond) console.log(`  ok   ${msg}`);
  else { failures += 1; console.error(`  FAIL ${msg}`); }
};
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const lib = library.library();
const byCode = (c) => lib.find((x) => x.code === c);

// ── A. The library says what the owner said ─────────────────────────────────
console.log('the list matches the corrections');

check(byCode('lt_cash_out_letter').bucketKey === 'prior_to_ctc',
  'the cash-out letter is prior to CLEAR TO CLOSE, not prior to submittal');
check(byCode('lt_cash_out_letter').ruleLogic
  && JSON.stringify(byCode('lt_cash_out_letter').ruleLogic).includes('is_cash_out'),
'and it still applies only to a cash-out refinance, not to every refinance');

const entity = byCode('lt_vesting_entity');
const gs = entity.slots.find((s) => s.key === 'good_standing');
check(!!gs, 'the vesting entity asks for a certificate of good standing');
check(gs && gs.required === false,
  'and it is OPTIONAL — one expires, so requiring it would make every entity go stale on a date nobody watches');
check(entity.slots.filter((s) => s.required !== false).length === 3,
  'while the three that are required — articles, agreement or bylaws, EIN — still are');
check(entity.config.prefillFromEntity === true,
  'and the condition opens from what the borrower already holds on their profile');

// ── B. A config key nothing reads is not a feature ──────────────────────────
console.log('every way is DECIDED somewhere, not just described');

for (const code of answers.GOVERNED_CODES) {
  const c = byCode(code);
  check(!!c, `${code} is a real condition in the library`);
  check(c && c.config.answeredBy === 'answers',
    `${code} points at the one definition instead of restating the ways`);
  check(c && !c.config.answers && !c.config.typedFields && !c.config.waiver,
    `${code} carries no second copy of the ways in its config`);
}
// The defect in one line: the old keys existed ONLY in the library.
const libSrc = stripComments(read('src/longterm/conditions-center/library.js'));
check(!/typedRequiresAll|linked_to_primary|typed_address|upload_statement/.test(libSrc),
  'the keys that nothing read are gone from the library');

// ── C. The subject property's mortgage: three ways ──────────────────────────
console.log('the mortgage on the property being refinanced');

const subject = byCode('lt_subject_mortgage_statement');
const subjectWays = answers.plan(subject).ways.map((w) => w.key);
check(JSON.stringify(subjectWays) === JSON.stringify(['statement', 'typed', 'fci_serviced']),
  'a statement, the figures typed in, or the FCI selection — three ways');

check(answers.satisfies(subject, {}, {}).ok === false,
  'answering nothing does not finish it');
check(answers.satisfies(subject, { way: 'fci_serviced' }, {}).ok === true,
  'the FCI selection alone finishes it — "you don’t need anything, not an attachment and not a form"');
check(answers.satisfies(subject, { way: 'statement' }, { hasDocument: true }).ok === true,
  'an accepted statement finishes it');
check(answers.satisfies(subject, { way: 'statement' }, { hasDocument: false }).ok === false,
  'and choosing "statement" without one does not');

const full = { outstanding_balance: 412000, servicer: 'FCI Lender Services', loan_number: 'YS-9931' };
check(answers.satisfies(subject, { way: 'typed', values: full }, {}).ok === true,
  'all three figures typed in finish it');
for (const drop of ['outstanding_balance', 'servicer', 'loan_number']) {
  const partial = { ...full };
  delete partial[drop];
  const v = answers.satisfies(subject, { way: 'typed', values: partial }, {});
  check(v.ok === false && /is needed/.test(v.why),
    `dropping ${drop} refuses it, and names what is missing — a partial answer reads as a complete one`);
}
check(answers.satisfies(subject, { way: 'typed', values: { ...full, outstanding_balance: 0 } }, {}).ok === true,
  'a balance of exactly ZERO is a real answer, not a missing one');
check(answers.satisfies(subject, { way: 'typed', values: { ...full, outstanding_balance: 'lots' } }, {}).ok === false,
  'while text where a number belongs is refused');
check(answers.satisfies(subject, { way: 'typed', values: { ...full, outstanding_balance: -5 } }, {}).ok === false,
  'and so is a negative balance');
check(answers.satisfies(subject, { way: 'made_up' }, {}).ok === false,
  'a way nobody offers is refused rather than invented');

// ── D. Every mortgage on the credit report, one line at a time ──────────────
console.log('the mortgages on the credit report');

const reo = byCode('lt_reo_liabilities');
const reoWays = answers.plan(reo).ways.map((w) => w.key);
check(JSON.stringify(reoWays) === JSON.stringify(['statement', 'primary', 'address']),
  'a statement, "this is the home they live in", or the property it is secured by');

const lines = [{ key: 'liab:1', label: 'Chase ····4417' }, { key: 'liab:2', label: 'Wells ····9002' }];
check(answers.satisfies(reo, { mortgages: [] }, { lines: [] }).ok === true,
  'a borrower with no mortgages has nothing to send, so the condition is answered');
const none = answers.satisfies(reo, {}, { lines });
check(none.ok === false && /2 mortgages/.test(none.why),
  'two unanswered mortgages refuse it, and the refusal says how many');
check(/Chase/.test(none.why) && /Wells/.test(none.why),
  'and NAMES them — "monthly rent is needed" over eight mortgages tells nobody which to fix');

const primaryOnly = { lines: { 'liab:1': { way: 'primary' } } };
check(answers.satisfies(reo, primaryOnly, { lines }).ok === false,
  'answering one of two does not finish it');
check(answers.satisfies(reo, { lines: { 'liab:1': { way: 'primary' }, 'liab:2': { way: 'primary' } } }, { lines }).ok === true,
  'marking both as the home they live in finishes it — "then you don’t need more information"');

const withDoc = { lines: { 'liab:1': { way: 'statement' }, 'liab:2': { way: 'primary' } } };
check(answers.satisfies(reo, withDoc, { lines, documentsByLine: { 'liab:1': true } }).ok === true,
  'a statement filed against its own line counts for that line');
check(answers.satisfies(reo, withDoc, { lines, documentsByLine: {} }).ok === false,
  'and the same answer without the document does not');

const addr = (extra) => ({ lines: { 'liab:1': { way: 'address', values: { address: '9 Oak St, Lakewood, NJ 08701', ...extra } }, 'liab:2': { way: 'primary' } } });
check(answers.satisfies(reo, addr({}), { lines }).ok === false,
  'a typed address with no occupancy does not finish the line');
check(answers.satisfies(reo, addr({ occupancy: 'second_home' }), { lines }).ok === true,
  'a second home needs nothing further — it earns no rent');
check(answers.satisfies(reo, addr({ occupancy: 'investment' }), { lines }).ok === false,
  'an investment DOES need the rent — "if it’s an investment you need to put in the rental income"');
check(answers.satisfies(reo, addr({ occupancy: 'investment', monthly_rent: 2400 }), { lines }).ok === true,
  '…and with the rent it is answered');
check(answers.satisfies(reo, addr({ occupancy: 'holiday_let' }), { lines }).ok === false,
  'an occupancy nobody offers is refused');

// ── E. What may be RECORDED is what the gate will HONOUR ────────────────────
console.log('the door and the gate cannot disagree');

const gateSrc = stripComments(read('src/longterm/conditions-center/write.js'));
check(/require\('\.\/answers'\)/.test(gateSrc), 'the sign-off gate reads the one definition');
check(/answers\.satisfies\(/.test(gateSrc), 'and asks it whether the condition is finished');
check(/answers\.answerProblem\(/.test(gateSrc), 'and the door that records an answer asks the same module');
check(/entityPrefill\.forEntity\(/.test(gateSrc), 'and the gate asks the borrower’s profile about the company');

// A SOURCE GREP PROVES THE CALL IS WRITTEN, NEVER THAT IT RUNS — so the real
// gate is CALLED here, with the conditions it governs. `signOffProblem` is pure,
// so this needs no database: it is the same function the sign-off route runs.
const { signOffProblem } = require('../src/longterm/conditions-center/write.js');
const row = (code, extra) => ({ code, kind: 'document', is_required: true, slots: [], answer: {}, ...extra });

const unanswered = signOffProblem(row('lt_reo_liabilities', {
  answer: { mortgages: [{ key: 'liab:1', label: 'Chase ····4417' }] },
}), []);
check(unanswered.ok === false && /Chase/.test(unanswered.why),
  'THE GATE ITSELF refuses a mortgage nobody has answered, and names it');

const answeredThrough = signOffProblem(row('lt_reo_liabilities', {
  answer: { mortgages: [{ key: 'liab:1', label: 'Chase ····4417' }], lines: { 'liab:1': { way: 'primary' } } },
}), []);
check(answeredThrough.ok === true,
  'and passes it once answered — with no document anywhere, which an upload-only gate could never do');

const fci = signOffProblem(row('lt_subject_mortgage_statement', {
  answer: { way: 'fci_serviced' },
  slots: [{ key: 'statement', label: 'Mortgage statement', required: false }],
}), []);
check(fci.ok === true, 'THE GATE ITSELF passes the FCI selection with nothing attached');

const noWay = signOffProblem(row('lt_subject_mortgage_statement', {}), []);
check(noWay.ok === false && /Choose how to answer/.test(noWay.why),
  'and refuses the same condition when no way has been chosen');

const verified = signOffProblem(row('lt_vesting_entity', {
  slots: [{ key: 'formation', label: 'Articles', required: true }],
}), [], { entity: { verified: true } });
check(verified.ok === true,
  'THE GATE ITSELF passes a company already verified on the borrower’s profile, with nothing uploaded here');

const docsButUnverified = signOffProblem(row('lt_vesting_entity', {
  slots: [{ key: 'formation', label: 'Articles', required: true }],
}), [], { entity: { verified: false, found: true, filled: ['formation'] } });
check(docsButUnverified.ok === false,
  'while documents on the profile that nobody has verified pre-fill it and leave it open — the review has not happened');

// Anything the door accepts, the gate must finish — proven over a battery
// rather than asserted, because that agreement is the whole reason for the
// shared module.
let disagreements = 0;
const battery = [
  [subject, { way: 'fci_serviced' }, {}],
  [subject, { way: 'typed', values: full }, {}],
  [subject, { way: 'statement' }, { hasDocument: true }],
  [reo, { lines: { 'liab:1': { way: 'primary' }, 'liab:2': { way: 'primary' } } }, { lines }],
  [reo, addr({ occupancy: 'investment', monthly_rent: 2400 }), { lines }],
];
for (const [cond, ans, ctx] of battery) {
  const accepted = answers.answerProblem(cond, ans, ctx) === null;
  const finished = answers.satisfies(cond, ans, ctx).ok;
  if (accepted !== finished) disagreements += 1;
}
check(disagreements === 0, 'every answer the door accepts is one the gate finishes');

// ── F. PILOT proposes what is a mortgage; a person decides ──────────────────
console.log('PILOT proposes, a person decides');

const propose = workspace._internals.proposeMortgage;
check(propose({ liability_type: 'MortgageLoan' }) === true, 'a mortgage reads as one');
check(propose({ liability_type: 'HELOC' }) === true, 'so does a home-equity line');
check(propose({ liability_type: 'Revolving' }) === false, 'a revolving account does not');
check(propose({ liability_type: 'Installment' }) === false, 'nor does an installment loan');
check(propose({ liability_type: 'Other' }) === null,
  'and an "Other" line proposes NOTHING — never a quiet no, because a missed mortgage is a payment nobody counted');
check(propose({}) === null, 'a blank type proposes nothing');
check(byCode('lt_reo_liabilities').config.classify === 'propose_only',
  'and the condition says so on its face');

// ── G. The entity is shared, never re-implemented ───────────────────────────
console.log('the entity logic is shared, not copied');

const prefillSrc = stripComments(read('src/longterm/conditions-center/entity-prefill.js'));
check(/require\('\.\.\/\.\.\/lib\/llc'\)/.test(prefillSrc),
  'the long-term side calls the ONE entity module — "share the logic, don’t copy it"');
check(!/CREATE|INSERT INTO llcs|UPDATE llcs/i.test(prefillSrc),
  'and reaches the entity through it rather than with raw SQL of its own');
check(/missingForVerification/.test(prefillSrc),
  'what is still needed is the shared module’s answer, so an entity TYPE is honoured');
// `satisfiedByProfile` is what the SCREEN asks — a different caller from the
// gate, and one whose wrong answer would tell a borrower their company was
// already done when nobody had read a single document.
const entityPrefillMod = require('../src/longterm/conditions-center/entity-prefill.js');
const sat = (p) => entityPrefillMod.satisfiedByProfile(p);
check(sat({ found: true, verified: true, filled: ['formation'], missing: [] }).ok === true,
  'a VERIFIED company on the profile finishes the condition');
check(sat({ found: true, verified: false, filled: ['formation', 'ein', 'agreement'], missing: [] }).ok === false,
  'a company with every document but NO verification does not — verification is a person having read the agreement');
check(/not been verified yet/.test(sat({ found: true, verified: false, filled: ['formation'], missing: [] }).why || ''),
  'and it says why, so nobody re-sends what is already there');
check(sat({ found: false, verified: false, filled: [], missing: [] }).ok === false,
  'a company not on the profile finishes nothing');
check(sat({ unreadable: true, why: 'could not read' }).ok === false,
  'and an unreadable profile is never read as "already done"');
check(sat(null).ok === false, 'nor is nothing at all');

const ledger = read('docs/LONG-TERM-AUTHORIZED-COPIES.md');
const authBlock = ledger.slice(ledger.indexOf('```authorized'), ledger.indexOf('```', ledger.indexOf('```authorized') + 3));
check(/^import\s+src\/lib\/llc\.js\s*$/m.test(authBlock), 'the crossing is recorded in the ledger');
check(/^sql-write llcs\s*$/m.test(authBlock), 'including the write the owner asked for by name');

// ── H. A BACK END IS NOT A FEATURE ──────────────────────────────────────────
// The whole reason this shipment needed correcting is that the ways were
// DESCRIBED in the library and nothing read them. A screen that cannot draw them
// is the same defect one layer up, so the mount is pinned here — no unit test of
// the rules can see whether anybody can reach them.
console.log('and somebody can actually answer them');

const screen = stripComments(read('app-v2/src/longterm/LtConditionAnswer.jsx'));
const list = stripComments(read('app-v2/src/longterm/LtFileConditions.jsx'));
const api = stripComments(read('app-v2/src/longterm/api.js'));

// The component name is matched with a BOUNDARY on both sides. Without it
// `<LtConditionAnswerXX` satisfies `/<LtConditionAnswer/` and the guard passes
// on a mount that renders nothing — which is exactly what a mutation proved.
check(/import LtConditionAnswer from/.test(list) && /<LtConditionAnswer[\s/>]/.test(list),
  'the conditions list mounts the answer panel');
check(/loanId=\{loanId\}/.test(list) && /function ConditionRow\([^)]*loanId/.test(list),
  'and the row is PASSED the loan — an identifier it does not declare compiles fine and throws at render');
check(/conditionWorkspace:/.test(api) && /conditionAnswer:/.test(api),
  'the client has both doors');
check(/\/workspace/.test(api) && /\/answer/.test(api), 'pointed at the routes that exist');
const routes = stripComments(read('src/longterm/routes/condition-center.js'));
check(/conditions\/:conditionId\/workspace/.test(routes) && /conditions\/:conditionId\/answer/.test(routes),
  '…and the server really serves them');

check(/ws\.shape === 'per_line'/.test(screen) && /ws\.shape === 'choice'/.test(screen) && /ws\.shape === 'entity'/.test(screen),
  'the panel draws all three shapes');
check(/ws\.ways\.map/.test(screen) || /ways=\{ws\.ways\}/.test(screen),
  'and takes the ways from the SERVER rather than keeping its own list');
check(!/outstanding_balance|fci_serviced|second_home'\s*:/.test(screen.replace(/'second_home' \? 'Second home'/, '')),
  'the screen hard-codes no rule of its own, so it can never disagree with the gate');
check(/proposedMortgage === null/.test(screen),
  'and "PILOT cannot tell" is shown as itself, never folded into a quiet no');
check(!/color:\s*(['"]#AE8746['"]|GOLD\b(?!_))/.test(screen),
  'and the brand gold carries no words on it (2.98:1 is under AA)');

console.log(failures ? `\n${failures} FAILED` : '\nlt condition answers (pure): all checks passed');
process.exit(failures ? 1 : 0);
