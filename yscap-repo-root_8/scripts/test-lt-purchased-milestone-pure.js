'use strict';
/**
 * LT test — THE PURCHASED STEP, with no database and no Encompass.
 *
 * The owner's workflow carries a step Encompass's nineteen milestones do not
 * (owner-directed 2026-08-23: *"the purchase is a new milestone, and yes, you can
 * build this up"*), and building it created exactly one way to get it badly wrong.
 *
 * THE ONE THAT MATTERS. Every other step in the ladder is marked reached because the
 * loan is standing PAST it — a loan at Final Docs has necessarily passed Purchasing
 * Conditions. Applied to the purchase that inference is FALSE: a loan can sit at
 * Final Docs for weeks before its investor buys it, and marking it sold because of
 * where it stands would state the single fact this step exists to state, wrongly, on
 * exactly the late-stage files where somebody is asking. Section C is that
 * assertion, from both directions, and it is the one to break first when checking
 * whether this suite still bites.
 *
 * THE SECOND ONE. "Encompass has not told us" is not "no". Section A pins all three
 * answers separately, and section C pins that the third survives all the way to the
 * screen as its own state rather than being flattened into a not-yet.
 *
 * Everything here is a pure function. No Postgres, no Encompass, no HTTP.
 */

const purchased = require('../src/longterm/milestone-purchased');
const workspace = require('../src/longterm/workspace');
const registry = require('../src/longterm/settings/encompass-settings');

let failures = 0;
const check = (cond, msg) => {
  if (cond) console.log(`  ok   ${msg}`);
  else { failures += 1; console.error(`  FAIL ${msg}`); }
};

const { settings } = registry.resolve({});
const CFG = purchased.configFrom(settings);

// ── A. Reading the sale off a loan payload ──────────────────────────────────
console.log('what Encompass said about the sale');

check(CFG.statusFieldId === '2031' && CFG.dateFieldId === '2370',
  'the two fields are the measured ones: 2031 (sell-side investor status) and 2370 (purchase advice date)');
check(CFG.name === 'Purchased' && CFG.after === 'Purchasing Conditions',
  'the step is called Purchased and follows Purchasing Conditions');

const sold = purchased.readPurchase(
  { rateLock: { sellSideInvestorStatus: 'Purchased', date: '2026-07-31T00:00:00.000Z' } }, CFG);
check(sold.purchased === true, 'a status of "Purchased" means the investor bought it');
check(sold.at === '2026-07-31', 'and the DATE is Encompass\'s own purchase advice date, not the day we looked');
check(sold.status === 'Purchased', 'Encompass\'s own word rides along verbatim');

for (const word of ['Shipped', 'Assigned - Bulk', 'Assigned - Flow', 'Rejected']) {
  const r = purchased.readPurchase({ rateLock: { sellSideInvestorStatus: word, date: '2026-07-31' } }, CFG);
  check(r.purchased === false, `"${word}" is NOT purchased — it is the loan on its way there, or back`);
  // A date with no sale behind it is a purchase we cannot show the evidence for.
  check(r.at === null, `and "${word}" carries no purchase date, whatever the date field holds`);
}

const unread = purchased.readPurchase({ rateLock: {} }, CFG);
check(unread.purchased === null,
  'a field Encompass did not give is NULL — we do not know, and that is a third answer, not a no');
check(purchased.readPurchase({}, CFG).purchased === null, 'so is a payload with no rate lock at all');
check(purchased.readPurchase(null, CFG).purchased === null, 'so is no payload at all');

// A value read BY NUMBER beats the path — the same field number sits at a different
// JSON path from loan to loan, which the RTL side paid for twice.
const byNum = purchased.readPurchase({
  rateLock: { sellSideInvestorStatus: 'Shipped', date: '2020-01-01' },
  _fieldValues: { 2031: 'Purchased', 2370: '2026-08-01' },
}, CFG);
check(byNum.purchased === true && byNum.at === '2026-08-01',
  'a value read by NUMBER wins over the JSON path, for both the status and the date');

const badDate = purchased.readPurchase(
  { rateLock: { sellSideInvestorStatus: 'Purchased', date: 'not a date' } }, CFG);
check(badDate.purchased === true && badDate.at === null,
  'an unreadable date leaves the sale standing with NO date — never a made-up one');

// A tenant that spells it differently changes a setting, not the code.
const other = purchased.configFrom({ ...settings, 'milestones.purchasedStatusValues': ['Bought', 'Sold'] });
check(purchased.readPurchase({ rateLock: { sellSideInvestorStatus: 'bought' } }, other).purchased === true,
  'a buyer whose Encompass says "Bought" says so in settings, and the match ignores casing');
check(purchased.readPurchase({ rateLock: { sellSideInvestorStatus: 'Purchased' } }, other).purchased === false,
  '…and then OUR word stops counting, because it is their book');

// ── B. Where the step sits in the ladder ────────────────────────────────────
console.log('\nwhere the step sits');

const ENCOMPASS = ['Funding', 'Investor Delivery', 'Purchasing Conditions', 'Final Docs', 'Closed']
  .map((name, i) => ({ name, sort_order: i + 1, expected_days: 1 }));

const ladder = purchased.insertInto(ENCOMPASS, CFG);
const names = ladder.map((r) => r.name);
check(names.join(' > ') === 'Funding > Investor Delivery > Purchasing Conditions > Purchased > Final Docs > Closed',
  'it lands immediately after Purchasing Conditions');
check(ladder.every((r, i) => r.sort_order === i + 1),
  'and the whole list is re-seated, so sort_order still describes the list a reader sees');
check(ladder.filter((r) => r.pilot).length === 1 && ladder.find((r) => r.pilot).milestoneId === purchased.PILOT_MILESTONE_ID,
  'exactly one step is marked as ours, carrying our own id');
check(ladder.find((r) => r.pilot).expected_days === null,
  'it has no expected duration — a loan waits on its buyer, not on us, so there is no bar to be over');

check(purchased.insertInto(purchased.insertInto(ENCOMPASS, CFG), CFG).length === ladder.length,
  'splicing twice adds it once — a caller that merged twice never gets two');

const noAnchor = purchased.insertInto([{ name: 'Started', sort_order: 1 }], CFG);
check(noAnchor.length === 2 && noAnchor[1].name === 'Purchased',
  'a tenant with no Purchasing Conditions still gets the step, at the END — a whole fact must never '
  + 'vanish off a screen because one word did not match');

check(purchased.insertInto([], CFG).length === 1,
  'an EMPTY catalog still returns the step (the route decides not to draw a one-step ladder — see the DB side)');

// ── C. THE STEPPER: a fact, never a position ────────────────────────────────
console.log('\nreached from a FACT, never from a position');

const atFinalDocs = { milestone_name: 'Final Docs' };
const step = (s, name) => s.steps.find((x) => x.name === name);

const notBought = workspace.milestoneStepper(atFinalDocs, ladder, {
  pilotReached: { [purchased.PILOT_MILESTONE_ID]: false },
});
check(step(notBought, 'Purchasing Conditions').reached === true,
  'a loan at Final Docs HAS passed Purchasing Conditions — ordinary steps stay positional');
check(step(notBought, 'Purchased').reached === false,
  'and has NOT been bought — the step is not marked, though the loan stands past where it sits');
check(step(notBought, 'Final Docs').current === true,
  'Final Docs is still the current milestone with our step sitting before it');
check(step(notBought, 'Purchased').current === false,
  'ours is NEVER the current milestone — Encompass names that, and it has never heard of our step');

const bought = workspace.milestoneStepper(atFinalDocs, ladder, {
  pilotReached: { [purchased.PILOT_MILESTONE_ID]: true },
  pilotReachedAt: { [purchased.PILOT_MILESTONE_ID]: '2026-07-31' },
});
check(step(bought, 'Purchased').reached === true, 'the same loan, once Encompass says purchased, is marked');
check(step(bought, 'Purchased').reachedAt === '2026-07-31', 'with Encompass\'s own date beside it');
check(step(bought, 'Purchased').unknown === false, 'and nothing is unknown about it');

const silent = workspace.milestoneStepper(atFinalDocs, ladder, {});
check(step(silent, 'Purchased').reached === false && step(silent, 'Purchased').unknown === true,
  'with nothing said, the step is unmarked AND flagged unknown — the screen draws "we have not been told", not "no"');
check(step(silent, 'Final Docs').unknown === false,
  'an ordinary step is never unknown: its position is the answer');

// An early loan: nothing after it is reached, ours included.
const early = workspace.milestoneStepper({ milestone_name: 'Funding' }, ladder, {
  pilotReached: { [purchased.PILOT_MILESTONE_ID]: true },
});
check(step(early, 'Final Docs').reached === false, 'a loan at Funding has not reached Final Docs');
check(step(early, 'Purchased').reached === true,
  'but it CAN be bought while sitting earlier — the fact does not wait for the position either');

// A tenant that happens to name a milestone "Purchased" must not resolve to ours.
const collide = purchased.insertInto(
  [{ name: 'Purchasing Conditions', sort_order: 1 }, { name: 'Purchased', sort_order: 2 }], CFG);
check(collide.filter((r) => r.name === 'Purchased').length === 1,
  'a tenant whose OWN catalog carries a step called Purchased does not get a second one');

// ── D. What a person reads ──────────────────────────────────────────────────
console.log('\nwhat it says in words');

const d1 = purchased.describePurchase({ purchased_status: 'Purchased', purchased_at: '2026-07-31' }, CFG);
check(d1.purchased === true && /bought this loan on 2026-07-31/.test(d1.note),
  'sold, with a date: it says which day');
const d2 = purchased.describePurchase({ purchased_status: 'Purchased', purchased_at: null }, CFG);
check(d2.purchased === true && /day is not known/.test(d2.note),
  'sold with no advice date: it says the day is not known rather than leaving a blank');
const d3 = purchased.describePurchase({ purchased_status: 'Shipped' }, CFG);
check(d3.purchased === false && /"Shipped"/.test(d3.note),
  'not sold: it QUOTES Encompass\'s own word, because "not purchased" covers four different states');
const d4 = purchased.describePurchase({}, CFG);
check(d4.purchased === null && /has not said/.test(d4.note),
  'not read: it says Encompass has not said, which is a different sentence again');

// The stored status is the only record; whether it counts is decided here, from the
// same settings the reader used. A boolean on the row could drift from the word.
const d5 = purchased.describePurchase({ purchased_status: 'Bought' }, other);
check(d5.purchased === true, 'the verdict follows the SETTING, so re-reading an old row under a new rule is right');

// ── E. Nothing is hard-coded ────────────────────────────────────────────────
console.log('\nevery choice is a setting');

const keys = registry.SETTINGS.map((s) => s.key);
for (const k of ['milestones.purchasedName', 'milestones.purchasedAfter',
  'milestones.purchasedStatusFieldId', 'milestones.purchasedStatusValues',
  'milestones.purchaseAdviceDateFieldId', 'milestones.purchasedConsumerStatus']) {
  check(keys.includes(k), `${k} is declared, so a buyer changes it without a release`);
}
check(settings['milestones.purchasedConsumerStatus'] === 'Funded',
  'the borrower\'s wording is "Funded" — the same as every other post-closing step, so who bought '
  + 'the loan can never leak to a client through this step');

console.log(failures ? `\n${failures} failure(s)` : '\nall good');
process.exit(failures ? 1 : 0);
