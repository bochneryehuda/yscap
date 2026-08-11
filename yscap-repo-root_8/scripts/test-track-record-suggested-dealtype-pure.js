'use strict';
/**
 * THE SUGGESTED DEAL TYPE — the dropdown's smart default, and the line it must
 * never cross (owner-directed 2026-08-10, pure, no database).
 *
 * The owner: *"If you see that it was flipped, then it should populate as a fixed
 * and flip … If you see that it was not sold, then the default should select as
 * a fixed hold."* That is `suggestedDealType` — a SUGGESTION the reviewer sees
 * pre-selected and confirms.
 *
 * The single most important assertion here is section 3: `dealTypeFromRecords`,
 * the reading `importNew` uses when NOBODY picks a type, stays STRICT — it reads
 * only a bought-and-sold pair as a flip and otherwise says nothing, so an import
 * can never silently write a guessed type. The soft "no sale → hold" reading
 * lives ONLY in the dropdown default, where a human confirms it. If those two
 * ever collapse into one function, an unattended import starts guessing holds —
 * the exact frozen rule ("A DEAL TYPE IS NEVER GUESSED" on import) this splits.
 */

const IMP = require('../src/lib/track-record/importer');

let fail = 0;
const ok = (c, m) => { if (c) console.log(`  ok  ${m}`); else { fail++; console.error(`  FAIL ${m}`); } };

console.log('\n1. A SALE on record suggests a flip');
{
  const both = IMP.suggestedDealType({ purchase_date: '2024-01-01', sale_date: '2025-03-02' });
  ok(both.type === 'flip', 'bought and sold → flip');
  ok(/bought and then sold/i.test(both.why), '…and the reason names both deeds');

  const saleOnly = IMP.suggestedDealType({ sale_date: '2025-03-02' });
  ok(saleOnly.type === 'flip', 'a sale with no recorded purchase still suggests a flip (owner: "sold → fix & flip")');
}

console.log('\n2. NO sale suggests a hold — refinanced or leased when the records say so');
{
  ok(IMP.suggestedDealType({ purchase_date: '2024-01-01' }).type === 'hold',
    'bought, never sold → hold');
  const noExit = IMP.suggestedDealType({ purchase_date: '2024-01-01' });
  ok(/confirm below how it exited/i.test(noExit.why),
    '…and with no exit on record, the reason asks the reviewer to confirm how it exited (the "was this refinanced?" prompt)');

  const refi = IMP.suggestedDealType({ refi_date: '2024-06-01' });
  ok(refi.type === 'hold' && /refinance/i.test(refi.why), 'a refinance on record → hold, and the reason says so');
  const refiAmtOnly = IMP.suggestedDealType({ refi_amount: 240000 });
  ok(refiAmtOnly.type === 'hold' && /refinance/i.test(refiAmtOnly.why),
    'a refinance AMOUNT with no date still reads as a refinanced hold');

  const rent = IMP.suggestedDealType({ rent_date: '2024-08-01' });
  ok(rent.type === 'hold' && /lease/i.test(rent.why), 'a lease on record → hold, and the reason says so');
  const rentAmtOnly = IMP.suggestedDealType({ rent_amount: 2200 });
  ok(rentAmtOnly.type === 'hold' && /lease/i.test(rentAmtOnly.why),
    'a monthly rent with no date still reads as a leased hold');
}

console.log('\n3. THE WRITTEN reading stays strict — a suggestion is NEVER what importNew writes on its own');
{
  /* The whole point: the dropdown may default to "hold" on a not-sold property,
     but the value IMPORTED when nobody picks is `dealTypeFromRecords`, which
     refuses to guess. */
  ok(IMP.dealTypeFromRecords({ purchase_date: '2024-01-01' }).dealType === null,
    'dealTypeFromRecords does NOT guess hold on a not-sold property — it stays null so importNew asks');
  ok(IMP.suggestedDealType({ purchase_date: '2024-01-01' }).type === 'hold',
    '…while suggestedDealType, for the SAME property, offers hold as the confirmable default');
  ok(IMP.dealTypeFromRecords({ purchase_date: '2024-01-01', sale_date: '2025-03-02' }).dealType === 'flip',
    'the one thing the strict reading DOES write is a bought-and-sold flip — and the suggestion agrees');
}

console.log('\n4. GROUND-UP is never suggested — nothing in the records distinguishes new construction');
{
  const inputs = [
    { purchase_date: '2024-01-01', sale_date: '2025-03-02' },
    { purchase_date: '2024-01-01' },
    { refi_date: '2024-06-01' },
    { rent_amount: 2200 },
    {},
  ];
  ok(inputs.every((c) => IMP.suggestedDealType(c).type !== 'ground-up'),
    'no records shape ever suggests ground-up — the reviewer picks it, it is never guessed');
  ok(['flip', 'hold'].includes(IMP.suggestedDealType({}).type),
    'an empty record still defaults to a real dropdown value (hold), never a blank');
}

if (fail) { console.error(`\ntest-track-record-suggested-dealtype-pure: ${fail} FAILED`); process.exit(1); }
console.log('\ntest-track-record-suggested-dealtype-pure: all passed');
