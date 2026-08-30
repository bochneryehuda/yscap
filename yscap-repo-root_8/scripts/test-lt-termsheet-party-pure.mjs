// LONG-TERM TERM SHEETS — WHO THE DOCUMENT IS ADDRESSED TO.
//
// OWNER-DIRECTED 2026-08-30: *"You can put in property addresses … and a name of the person
// and/or a name of the entity."*
//
// A DSCR loan is routinely vested in an LLC with the individual behind it as guarantor, and it is
// just as routinely quoted to a person before an entity exists. The sheet had ONE name field and
// REQUIRED it, so the first of those two deals could not issue a term sheet at all and the second
// had nowhere to record the entity that will actually hold title.
//
// THREE RULES, AND EACH ONE IS A DIFFERENT KIND OF MISTAKE IF IT MOVES:
//
//   1. AT LEAST ONE NAME, EITHER ONE. Demanding both refuses two ordinary deals; demanding
//      neither prints a signature line over a blank "prepared for", which is a defective
//      document. The gate reports the shortfall under ONE key, `partyName`, because the screen
//      shows both boxes and either one fills it.
//
//   2. THE ENTITY IS THE BORROWER, THE PERSON IS THE GUARANTOR. That is what the two words mean
//      on this product, not a house style. A role label is not decoration on a page somebody
//      signs: "Borrower / guarantor" over a company reads as the company guaranteeing itself,
//      and "Borrower" over a person on an entity deal names the wrong borrower.
//
//   3. ONE READING, TWO SURFACES. The "prepared for" line and the signature lines are built from
//      the SAME function, so the top of the page and the bottom can never name different parties.
//
// AND THE PERSON-ONLY CASE IS PROVEN BYTE-IDENTICAL to what shipped before the entity existed —
// this widened a gate on a live document, so the old behaviour is pinned, not assumed.

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const snapshot = require('../src/longterm/termsheet/snapshot.js');
const layout = require('../src/longterm/termsheet/layout.js');

let bad = 0;
const ok = (cond, label) => {
  if (cond) console.log(`  ok   ${label}`);
  else { bad += 1; console.error(`  FAIL ${label}`); }
};

const PLAN = { borrowerPaid: 2, ysp: 2, lenderPaid: 2, applicationFee: 500, commitmentFee: 1595 };
const SCEN = {
  purpose: 'Purchase', propertyType: 'Single family', value: 500000, loan: 375000,
  ltv: 75, termYears: 30, dscr: 1.24, fico: 740, state: 'NJ', city: 'Lakewood', zip: '08701',
  rentMonthly: 3900, taxMonthly: 620, insuranceMonthly: 145, hoaMonthly: 0,
};
const QUOTE = {
  label: null, consumerLabel: 'Platinum', product: '30-Year Fixed DSCR', mode: 'borrowerPaid',
  ratePct: 7.375, rawPrice: 102, scenario: SCEN, pricedAt: '2026-08-30T13:30:00.000Z',
};

/** A built sheet, or a throw naming the refusal — a suite that silently tested `undefined`
 *  would report every assertion as a pass. */
function build(prepared, selections) {
  const b = snapshot.buildSnapshot({
    selections: selections || [QUOTE],
    plan: PLAN,
    prepared: { propertyAddress: '12 Oak St, Lakewood, NJ 08701', companyName: 'YS Capital Group', ...prepared },
  });
  if (!b.ok) throw new Error(`snapshot refused: ${b.error} — ${b.message}`);
  return b.snapshot;
}
const gateOf = (prepared, selections) => snapshot.exportGate(build(prepared, selections));
function blocksOf(prepared, selections) {
  const lay = layout.buildLayout(build(prepared, selections), { expiryHours: 24 });
  return {
    recipient: lay.blocks.find((x) => x.t === 'recipient') || {},
    signature: lay.blocks.find((x) => x.t === 'signature') || { lines: [] },
  };
}
const roles = (sig) => sig.lines.map((l) => l.role);
const named = (sig) => sig.lines.filter((l) => l.name).map((l) => `${l.role}=${l.name}`);

const PERSON = 'Jane Doe';
const ENTITY = 'Maple Holdings LLC';

console.log('\nA. one name is enough, and either one will do');
ok(gateOf({}).missing.includes('partyName'),
  'A1 a term sheet addressed to NOBODY is refused');
ok(gateOf({ borrowerName: PERSON }).missing.length === 0,
  'A2 the person alone is enough — the deal quoted before an entity exists');
ok(gateOf({ entityName: ENTITY }).missing.length === 0,
  'A3 the entity alone is enough — the loan vested in an LLC');
ok(gateOf({ borrowerName: PERSON, entityName: ENTITY }).missing.length === 0,
  'A4 …and both together, which is the ordinary DSCR shape');
ok(!gateOf({}).missing.includes('borrowerName'),
  'A5 the shortfall is reported under ONE key, so the screen points at both boxes');
ok(/borrower's name or the vesting entity/.test(gateOf({}).message || ''),
  'A6 …and the sentence names both, so the officer knows either will do');

console.log('\nB. a name is required on a TERM SHEET and on nothing else');
{
  // A comparison is a working document with no acceptance block and no addressee.
  const two = [QUOTE, { ...QUOTE, ratePct: 7.75, rawPrice: 100.5 }];
  const g = gateOf({}, two);
  ok(g.ok === true && g.kind !== 'term_sheet',
    'B1 a comparison with no party at all still exports — it is not addressed to anyone');
}

console.log('\nC. the entity is the borrower and the person is the guarantor');
{
  const { signature } = blocksOf({ borrowerName: PERSON, entityName: ENTITY });
  ok(named(signature).some((x) => x === `Borrower — authorized signatory=${ENTITY}`),
    'C1 the ENTITY signs as the borrower');
  ok(named(signature).some((x) => x === `Guarantor=${PERSON}`),
    'C2 …and the PERSON signs as the guarantor');
  ok(!roles(signature).includes('Borrower / guarantor'),
    'C3 …never the combined role, which over a company reads as it guaranteeing itself');
  ok(roles(signature).filter((r) => r === 'Date').length === 3,
    'C4 every signing party gets its own date line — three parties, three dates');
}
{
  const { signature } = blocksOf({ entityName: ENTITY });
  ok(named(signature).join('|') === `Borrower — authorized signatory=${ENTITY}`,
    'C5 the entity alone signs as the borrower, and no phantom guarantor line is drawn');
}

console.log('\nD. the person-only sheet is what it always was');
{
  const { signature, recipient } = blocksOf({ borrowerName: PERSON });
  ok(JSON.stringify(signature.lines) === JSON.stringify([
    { role: 'Borrower / guarantor', name: PERSON },
    { role: 'Date' },
    { role: 'YS Capital Group — authorized signatory' },
    { role: 'Date' },
  ]), 'D1 the signature block is BYTE-IDENTICAL to the one that shipped before the entity existed');
  ok(recipient.preparedFor === PERSON,
    'D2 …and the "prepared for" line still reads exactly the person\'s name');
  ok(recipient.entityName === null,
    'D3 …with no entity invented for a deal that has none');
}

console.log('\nE. the top of the page and the bottom name the same parties');
{
  const both = blocksOf({ borrowerName: PERSON, entityName: ENTITY });
  ok(both.recipient.preparedFor === `${ENTITY} · ${PERSON}`,
    'E1 both parties are on the "prepared for" line, entity first');
  const onSig = named(both.signature).join(' ');
  ok(onSig.includes(ENTITY) && onSig.includes(PERSON),
    'E2 …and both appear on the signature lines, so the two halves cannot disagree');
  ok(blocksOf({ entityName: ENTITY }).recipient.preparedFor === ENTITY
    && blocksOf({ borrowerName: PERSON }).recipient.preparedFor === PERSON,
  'E3 …and with one party the line is simply that party');
}

console.log('\nF. the entity survives the snapshot whitelist');
{
  // The `prepared` projection is a WHITELIST: a key nobody lists is silently dropped, which is
  // exactly how a field can be collected on a screen and never reach the page.
  const s = build({ entityName: ENTITY, nonsenseKey: 'should not survive' });
  ok(s.prepared.entityName === ENTITY, 'F1 the entity is carried through');
  ok(s.prepared.nonsenseKey === undefined, 'F2 …and the whitelist is still a whitelist');
  const long = build({ entityName: 'E'.repeat(400) });
  ok((long.prepared.entityName || '').length <= 120,
    'F3 …and it is capped, like every other string this document prints');
}

console.log(bad === 0 ? '\nOFFLINE: all passed' : `\nOFFLINE: ${bad} FAILED`);
process.exit(bad === 0 ? 0 : 1);
