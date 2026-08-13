'use strict';
/**
 * THE INVESTOR'S CUT OF OUR DRAW FEE — the pure rules (owner-directed 2026-08-13).
 * No database, no network.
 *
 * Every assertion reproduces something the owner asked for by name: the two hard rates, the worked
 * CorrFirst example ($299 → $95 to them, $204 to us), Blue Lake keeping the whole $250 so we bank
 * nothing, "if it's not sold yet, then we get all of the entire fee", and the invariant that makes
 * this safe to ship — the split moves OUR fee only and can never touch the borrower's money.
 */
const assert = require('assert');
const IF = require('../src/sitewire/investor-fee');
const money = require('../src/sitewire/money');

let n = 0;
const ok = (cond, what) => { assert.ok(cond, what); n++; };
const eq = (a, b, what) => { assert.deepStrictEqual(a, b, `${what} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); n++; };

// ---------------------------------------------------------------- A. the hard rules
// OWNER-SET NUMBERS. Changing one changes what we book as income on every future release for that
// buyer, so they are pinned here as well as in the module.
eq(IF.INVESTOR_DRAW_FEE_CENTS.corrfirst, 9500, 'A1 CorrFirst keeps $95 per draw');
eq(IF.INVESTOR_DRAW_FEE_CENTS.bluelake, 25000, 'A2 Blue Lake keeps $250 per draw');
eq(Object.keys(IF.INVESTOR_DRAW_FEE_CENTS).sort(), ['bluelake', 'corrfirst'], 'A3 …and nobody else has a rule');

// The buyer is recognised through the SHARED capital-provider table, so a spelling has one home.
eq(IF.ruleFor('CorrFirst').per_draw_cents, 9500, 'A4 "CorrFirst" is CorrFirst');
eq(IF.ruleFor('Corr First').per_draw_cents, 9500, 'A5 …and so is the two-word spelling');
eq(IF.ruleFor('corrfirst').key, 'corrfirst', 'A6 …and the lower-case token a caller read off an earlier answer');
eq(IF.ruleFor('Blue Lake Capital').per_draw_cents, 25000, 'A7 "Blue Lake Capital" is Blue Lake');
eq(IF.ruleFor('Fidelis Investors'), null, 'A8 a buyer with no such deal keeps nothing');
eq(IF.ruleFor(''), null, 'A9 a blank note buyer keeps nothing — we never guess whose rule to apply');
eq(IF.ruleFor('Some New Buyer LLC'), null, 'A10 …and neither does a buyer nobody has classified yet');

// ---------------------------------------------------------------- B. the owner's worked example
// "if our total fee was $299, our net fee should automatically deduct the $95 … our final fee is
// only $204" — on a file already SOLD to CorrFirst.
{
  const d = IF.describe({ noteBuyer: 'CorrFirst', sold: 'sold', feeCents: 29900 });
  eq(d.applies, true, 'B1 a loan sold to CorrFirst carries their cut');
  eq(d.suggested_cents, 9500, 'B2 …of exactly $95');
  eq(d.net_fee_cents, 20400, 'B3 …so $204 is deposited to us');
  ok(/\$95\.00/.test(d.headline) && /\$204\.00/.test(d.headline), 'B4 …and the screen says so in dollars');
}

// Blue Lake charges the entire thing, so our net fee is 0 — never negative, never a receivable.
{
  const d = IF.describe({ noteBuyer: 'BlueLake', sold: 'sold', feeCents: 25000 });
  eq([d.applies, d.suggested_cents, d.net_fee_cents], [true, 25000, 0], 'B5 Blue Lake keeps the whole $250 draw fee — we bank nothing');
}

// ---------------------------------------------------------------- C. not sold = we keep it all
// "any file that is funding with CorrFirst that is already sold to CorrFirst … if it's not sold
// yet, then we get all of the entire fee."
{
  const notSold = IF.describe({ noteBuyer: 'CorrFirst', sold: 'not_sold', feeCents: 29900 });
  eq([notSold.applies, notSold.suggested_cents, notSold.net_fee_cents], [false, 0, 29900],
    'C1 not sold to them yet → we keep the entire $299');
  ok(/\$95\.00/.test(notSold.hint), 'C2 …and the note still names their rate, so it is one press if the desk knows better');

  const unknown = IF.describe({ noteBuyer: 'CorrFirst', sold: 'unknown', feeCents: 29900 });
  eq([unknown.applies, unknown.suggested_cents], [false, 0],
    'C3 a loan we cannot confirm is sold fills in NOTHING — it never guesses money off our own books');
  eq(unknown.reason, 'sold_unknown', 'C4 …and it says which of the two it is');
  ok(/purchase advice/i.test(unknown.hint), 'C5 …naming the missing fact a coordinator can go and check');

  eq(IF.describe({ noteBuyer: 'Fidelis', sold: 'sold', feeCents: 29900 }).suggested_cents, 0,
    'C6 a sold loan whose buyer has no such deal still keeps the whole fee for us');
  eq(IF.describe({ noteBuyer: null, sold: 'sold', feeCents: 29900 }).suggested_cents, 0,
    'C7 …and so does a file with no note buyer on it at all');
}

// ---------------------------------------------------------------- D. the split can never lie
{
  eq(IF.splitFee({ feeCents: 29900, investorFeeCents: 9500 }).net_fee_cents, 20400, 'D1 fee − cut = the deposit');
  const over = IF.splitFee({ feeCents: 25000, investorFeeCents: 29900 });
  eq(over.ok, false, 'D2 a cut bigger than our fee is REFUSED, never trimmed in silence');
  ok(/never keep more than we charge/.test(over.violation), 'D3 …and says why, in money');
  eq(IF.splitFee({ feeCents: 25000, investorFeeCents: -1 }).ok, false, 'D4 a negative cut is refused too');
  eq(IF.splitFee({ feeCents: 0, investorFeeCents: 0 }).net_fee_cents, 0, 'D5 a $0 fee splits into nothing');
  // The rule is capped by our own fee: a $250 buyer on a file whose fee is somehow smaller can
  // still only keep what we charged.
  eq(IF.describe({ noteBuyer: 'Blue Lake', sold: 'sold', feeCents: 10000 }).suggested_cents, 10000,
    'D6 the rule is capped by our own fee — they can never keep more than we charged');
  eq(IF.describe({ noteBuyer: 'CorrFirst', sold: 'sold', feeCents: 0 }).suggested_cents, 0,
    'D7 a draw with no fee has nothing to keep');
  // Never throws, whatever it is handed.
  eq(IF.describe({}).suggested_cents, 0, 'D8 an empty call answers 0 rather than throwing');
  eq(IF.describe({ noteBuyer: 'CorrFirst', sold: 'sold', feeCents: 'abc' }).suggested_cents, 0,
    'D9 …and a garbage fee is read as no fee, never as a cut of NaN');
}

// ---------------------------------------------------------------- E. the borrower's money NEVER moves
// THE INVARIANT THIS WHOLE FEATURE RESTS ON (owner-directed: "don't change anything from the front
// end that a borrower sees or that a staff member sees"). The release split — what the borrower is
// wired — is computed by money.computeRelease from the FEE, and the investor's cut is not one of
// its inputs. Proven rather than asserted: the same draw, split with and without a cut recorded.
{
  const release = money.computeRelease({ approvedCents: 770000, feeCents: 29900, retainagePct: 0 });
  const withCut = IF.describe({ noteBuyer: 'CorrFirst', sold: 'sold', feeCents: 29900 });
  eq(release.net_release_cents, 740100, 'E1 the borrower nets approved − our fee, exactly as before');
  eq(release.fee_cents, 29900, 'E2 …and the fee charged out of the draw is still the whole $299');
  eq(withCut.fee_cents, 29900, 'E3 the cut does not change the fee — it only says where it ends up');
  eq(withCut.investor_fee_cents === undefined, true, 'E4 describe() answers about OUR fee only — it carries no release figure at all');
  eq(withCut.suggested_cents + withCut.net_fee_cents, release.fee_cents,
    'E5 their cut plus our deposit is exactly the fee the borrower was charged — nothing appears, nothing vanishes');
}

// ---------------------------------------------------------------- F. one default for both writers
// The hand-recorded release and the automatic (investor-released) writer both call this, so a
// release PILOT books itself and one a coordinator types can never book different income.
{
  eq(IF.defaultInvestorFeeCents({ noteBuyer: 'CorrFirst', sold: 'sold', feeCents: 29900 }), 9500, 'F1 the shared default is the rule');
  eq(IF.defaultInvestorFeeCents({ noteBuyer: 'CorrFirst', sold: 'not_sold', feeCents: 29900 }), 0, 'F2 …and nothing until it is sold');
  eq(IF.rules().map((r) => r.key).sort(), ['bluelake', 'corrfirst'], 'F3 the rules are listable for a settings screen');
  ok(IF.rules().every((r) => r.label && r.per_draw_cents > 0), 'F4 …each with a name a person would write and a real rate');
}

console.log(`investor draw fee (pure): ${n} assertions passed`);
