'use strict';
/**
 * TABLE FUNDING — who may fund that way, and what it means about the loan being sold
 * (owner-directed 2026-08-09).
 *
 * The owner's rule, and every one of these assertions traces to a sentence of it:
 *
 *   "Most of the properties that have Fidelis as a note buyer should be defaulted to table
 *    funding … Look on the channel in Encompass cx.tablefunder — if that says table funding, then
 *    it is not going to have a PA date … for Fidelis, you can allow that to be table funding, and
 *    for RCN or ROC or TempleView, you can also allow them to be table funding. Any file that is
 *    Blue Lake or emcap or corrfirst it should never be table funding. It should always be direct
 *    RTL / delegate or direct RTL / w tpr — it needs to follow this rule in order to pass
 *    Encompass Sync … for the other note buyers … you don't need to care about this field …
 *    anything that is set in Encompass for table funding means that it's right away sold."
 *
 * WHAT THIS IS REALLY GUARDING. The violation row is BLOCK-gated: it holds a term sheet. So the
 * expensive failure is not a missed violation, it is a FALSE one — a file stopped because PILOT
 * misread a buyer name or a dropdown value nobody enumerated. Section C is therefore the longest
 * one here, and it is entirely about the rule DECLINING to judge.
 *
 * No DB, no network — pure functions only.
 */
const assert = require('assert');
const FC = require('../src/lib/funding-channel');
const RP = require('../src/sitewire/release-party');
const map = require('../src/lib/integrations/encompass-field-map');
const RECON = require('../src/encompass/reconcile');

let n = 0;
const ok = (c, what) => { assert.ok(c, what); n++; };
const eq = (a, b, what) => { assert.strictEqual(a, b, `${what} — got ${JSON.stringify(a)}`); n++; };

// ─────────────────────────────────────────── A. the names are the tenant's, not the owner's message
//
// The owner said plainly: "when I say name, look for the correct research for the correct spelling
// of the nodes you're looking for — don't [go] by a name that I'm mentioning." These tokens come
// from VALUE_MAPS.capitalProvider, whose key list was read LIVE off the Encompass dropdown on
// 2026-07-26. Pinning them HERE means the rule and the Encompass panel's capital-provider row can
// never drift apart about who a file belongs to.
eq(FC.toBuyerKey('Fidelis Investors LLC'), 'fidelis', 'A1 the owner\'s "Fidelis" is Fidelis Investors');
eq(FC.toBuyerKey('CorrFirst'), 'corrfirst', 'A2 the owner\'s "Core First" is spelled CorrFirst');
eq(FC.toBuyerKey('Roc Capital'), 'roccapital', 'A3 the owner\'s "ROC" is Roc Capital');
eq(FC.toBuyerKey('Temple View Capital'), 'templeview', 'A4 the owner\'s "TempleView" is Temple View Capital');
eq(FC.toBuyerKey('BlueLake'), 'bluelake', 'A5 Blue Lake');
eq(FC.toBuyerKey('EMCAP Financial'), 'emcap', 'A6 EMCAP');
eq(FC.toBuyerKey('RCN Capital'), 'rcn', 'A7 RCN');
eq(FC.toBuyerKey('roccapital'), 'roccapital', 'A8 a token we produced is accepted back — roccapital is not a key of the shared table');
eq(FC.toBuyerKey('templeview'), 'templeview', 'A9 …nor is templeview');
eq(FC.toBuyerKey('Wells Fargo'), null, 'A10 a stranger is not a buyer, so no rule applies to it');
eq(FC.toBuyerKey(''), null, 'A11 blank is not a buyer');
eq(FC.toBuyerKey(null), null, 'A12 …nor is nothing');
// The two sets, stated as the owner stated them.
for (const b of ['fidelis', 'rcn', 'roccapital', 'templeview']) {
  eq(FC.mayTableFund(b), true, `A13 ${b} MAY be table funded`);
}
for (const b of ['bluelake', 'emcap', 'corrfirst']) {
  eq(FC.mayTableFund(b), false, `A14 ${b} may NEVER be table funded`);
}
eq(FC.mayTableFund('other'), null, 'A15 every other buyer: "you don\'t need to care about this field"');
eq(FC.mayTableFund(null), null, 'A16 …and an unknown buyer has no rule either');
eq(FC.defaultChannelFor('fidelis'), 'table_funding', 'A17 Fidelis DEFAULTS to table funding');
// WHO GETS THE 30-DAY MISSING-PURCHASE-ADVICE REMINDER (owner-directed 2026-08-09, answering the
// question the first cut left open): "blue lake emcap corrfirst — only stuff that needs to be sold
// to get this reminder. Fidelis is on a case-by-case basis, most of Fidelis is table funding. All
// the other RCN, [Roc], and Temple View are also table funded, so we don't need a reminder."
// This is a question about the BUYER; whether a given FILE was table funded is a separate check,
// and BOTH have to pass before anyone is told.
for (const b of ['Blue Lake Capital', 'EMCAP Financial', 'CorrFirst']) {
  eq(FC.chaseMissingPurchaseAdvice(b), true, `A17a ${b} is chased — its loans really do have to be sold`);
}
eq(FC.chaseMissingPurchaseAdvice('Fidelis Investors LLC'), true,
  'A17b Fidelis is NOT excluded by buyer — that is the owner\'s "case-by-case"; its table-funded FILES are skipped by the file check instead');
for (const b of ['RCN Capital', 'Roc Capital', 'Temple View Capital']) {
  eq(FC.chaseMissingPurchaseAdvice(b), false, `A17c ${b} is never chased — table funded as a matter of course`);
}
eq(FC.chaseMissingPurchaseAdvice(null), true,
  'A17d a file with NO note buyer is still chased — going quiet on an unclassified funded loan is the expensive direction');
eq(FC.chaseMissingPurchaseAdvice('Some New Buyer LLC'), true,
  'A17e …and so is a buyer nobody has classified yet, or the reminder goes dark the day one is added');
for (const b of ['rcn', 'roccapital', 'templeview', 'bluelake', 'emcap', 'corrfirst', 'other']) {
  eq(FC.defaultChannelFor(b), null, `A18 ${b} has no default — only Fidelis does`);
}

// ─────────────────────────────────────────── B. reading the channel
//
// The field is read in BOTH shapes it could plausibly hold. The registry has described it as a
// "table funder FLAG" since it was written; the owner describes it as a CHANNEL whose value reads
// "table funding". Both mean the same thing about the loan and neither can be confirmed from here,
// so both are recognised.
eq(FC.channelKey('Table Funding'), 'table_funding', 'B1 the owner\'s wording');
eq(FC.channelKey('TABLE FUNDED'), 'table_funding', 'B2 …in any casing');
eq(FC.channelKey('Y'), 'table_funding', 'B3 a Y/N flag reads as table funded too');
eq(FC.channelKey('Yes'), 'table_funding', 'B4 …however it is spelled');
eq(FC.channelKey('No'), 'direct', 'B5 …and a "no" is a positive NOT-table-funded');
eq(FC.channelKey('Direct RTL / Delegate'), 'direct', 'B6 delegated');
eq(FC.channelKey('direct rtl / w tpr'), 'direct', 'B7 with TPR');
eq(FC.channelKey('Direct RTL'), 'direct', 'B8 our own wording, which is what buildOurValues emits');
eq(FC.channelKey('Retail'), null, 'B9 a value nobody enumerated is NOT guessed at');
eq(FC.channelKey(''), null, 'B10 blank reads as nothing');
eq(FC.channelKey(null), null, 'B11 …as does absent');

// THE TWO DIRECT VALUES SHARE ONE TOKEN, AND THAT IS LOAD-BEARING. Our side of the comparison is a
// warehouse pick, which cannot tell delegated from TPR. Giving them separate tokens would make
// every correctly-configured direct file read as a MISMATCH on a distinction PILOT is structurally
// incapable of holding — a permanent false disagreement on the panel.
for (const theirs of ['Direct RTL / Delegate', 'direct rtl / w tpr', 'Direct RTL / with TPR', 'Delegate', 'W TPR']) {
  eq(map.mapValue('fundingChannel', 'Direct RTL'), map.mapValue('fundingChannel', theirs),
    `B12 our "Direct RTL" MATCHES Encompass's "${theirs}" — one token, or every direct file false-mismatches`);
}
ok(map.mapValue('fundingChannel', 'Table Funding') !== map.mapValue('fundingChannel', 'Direct RTL / Delegate'),
  'B13 …but a REAL disagreement (we say table funded, they say direct) is still a mismatch');

// ─────────────────────────────────────────── C. the rule DECLINES to judge, five different ways
//
// Everything in this section is a case where a violation would be a FALSE one. The row is
// BLOCK-gated — it holds a term sheet — so each of these is a file that must not be stopped.
eq(FC.channelProblem({ buyer: 'Blue Lake', channelRaw: '' }), null,
  'C1 a BLANK channel is not a violation — Encompass simply has not been filled in');
eq(FC.channelProblem({ buyer: 'Blue Lake', channelRaw: null }), null, 'C2 …nor is an absent one');
eq(FC.channelProblem({ buyer: null, channelRaw: 'Table Funding' }), null,
  'C3 with NO note buyer there is no rule to apply — we do not know whose it would be');
eq(FC.channelProblem({ buyer: 'Wells Fargo', channelRaw: 'Table Funding' }), null,
  'C4 a buyer the shared table does not carry has no rule');
eq(FC.channelProblem({ buyer: 'Fidelis Investors LLC', channelRaw: 'Table Funding' }), null,
  'C5 a buyer that MAY table fund, table funded, is simply correct');
for (const b of ['RCN', 'Roc Capital', 'Temple View Capital']) {
  eq(FC.channelProblem({ buyer: b, channelRaw: 'Table Funding' }), null, `C6 …and so is ${b}`);
}
eq(FC.channelProblem({ buyer: 'Blue Lake', channelRaw: 'Direct RTL / Delegate' }), null,
  'C7 a direct-only buyer on a direct channel is correct');
eq(FC.channelProblem({ buyer: 'EMCAP', channelRaw: 'direct rtl / w tpr' }), null, 'C8 …either direct flavour');
{
  // AN UNRECOGNISED VALUE IS INFORMATION, NEVER A FAILURE. A new dropdown option nobody has
  // enumerated must not hold a term sheet — it surfaces so a human can have it added.
  const p = FC.channelProblem({ buyer: 'EMCAP', channelRaw: 'Retail' });
  ok(p, 'C9 an unrecognised channel on a direct-only buyer IS reported');
  eq(p.violation, false, 'C10 …but NOT as a violation — an unenumerated dropdown option never blocks');
  eq(p.code, 'funding_channel_unrecognized', 'C11 …and it says so in its own code');
  ok(/Retail/.test(p.message), 'C12 …quoting the value verbatim, so somebody can add it');
}

// ─────────────────────────────────────────── D. …and it DOES fire on the one thing the owner named
for (const b of ['Blue Lake', 'BlueLake', 'Blue Lake Capital', 'EMCAP', 'EMCAP Financial', 'CorrFirst', 'corr first']) {
  const p = FC.channelProblem({ buyer: b, channelRaw: 'Table Funding' });
  ok(p && p.violation === true, `D1 ${b} + table funding = a real violation`);
}
{
  const p = FC.channelProblem({ buyer: 'Blue Lake', channelRaw: 'Y' });
  ok(p && p.violation === true, 'D2 …including when the field turns out to be a Y/N flag');
  const m = p.message;
  ok(/never table funded/i.test(m), 'D3 the message says what is wrong');
  ok(/direct RTL \/ delegate/i.test(m) && /TPR/i.test(m), 'D4 …and what it has to be instead, the owner\'s two values');
  ok(/Fix it in Encompass/i.test(m), 'D5 …and where to fix it — Encompass is read-only, PILOT cannot');
  ok(!/PILOT will|automatically/i.test(m), 'D6 …and never claims PILOT will change anything itself');
}

// ─────────────────────────────────────────── E. the panel row the reconcile builds
const cfc = RECON._internals.compareFundingChannel;
{
  const rows = cfc('Blue Lake Capital', null, 'Table Funding');
  eq(rows.length, 1, 'E1 a violation produces exactly one row');
  const r = rows[0];
  eq(r.status, 'mismatch', 'E2 …which reads as not-matching, so summarize() counts it as not passing');
  eq(r.open, true, 'E3 …and open');
  eq(r.gate, map.GATE.BLOCK, 'E4 …BLOCK-gated: the owner said it must be followed to pass the sync');
  eq(r.encompassFieldId, 'CX.TABLEFUNDER', 'E5 …naming the field a human has to go and fix');
  ok(/Must be/.test(r.ours), 'E6 our side states the RULE, not a value we hold — there is no second copy here');
  eq(r.theirs, 'Table Funding', 'E7 …and their side is what Encompass actually says, verbatim');
  ok(r.detail && r.detail.length > 40, 'E8 …with the plain-language explanation attached');
}
eq(cfc('Fidelis Investors LLC', null, 'Table Funding').length, 0, 'E9 a correct file produces NO row at all');
eq(cfc('Blue Lake Capital', null, null).length, 0, 'E10 …and neither does a blank channel');
{
  // OUR note buyer decides whose rule applies; Encompass's copy is only a fallback for a file we
  // have not filled in. Otherwise the sync could apply a DIFFERENT buyer's rule than the 5% SOW
  // contingency, the bank-statement months and the data-tape gate are all applying to the same file.
  eq(cfc('Fidelis Investors LLC', 'BlueLake', 'Table Funding').length, 0,
    'E11 OUR buyer wins — a file we call Fidelis is judged as Fidelis');
  eq(cfc(null, 'BlueLake', 'Table Funding').length, 1,
    'E12 …and Encompass\'s copy is used only when ours is blank');
}
{
  const r = cfc('EMCAP', null, 'Retail')[0];
  eq(r.status, 'match', 'E13 an unrecognised value rides as a MATCHING row — it must never hold a term sheet');
  eq(r.open, false, 'E14 …and is not open');
}

// ─────────────────────────────────────────── F. table funded means SOLD, with no PA date coming
eq(FC.soldAtTable({ tableFunded: true }), true, 'F1 our own warehouse pick alone is enough');
eq(FC.soldAtTable({ channel: 'table_funding' }), true, 'F2 …and so is Encompass alone');
eq(FC.soldAtTable({ tableFunded: false, channel: 'direct' }), false, 'F3 both saying direct is a no');
eq(FC.soldAtTable({}), false, 'F4 …and knowing nothing is not a yes');
eq(FC.expectsPurchaseAdvice({ tableFunded: true }), false,
  'F5 a table-funded loan is NOT expecting a purchase advice — "it is not going to have a PA date"');
eq(FC.expectsPurchaseAdvice({ tableFunded: false }), true, 'F6 a direct loan is');
eq(FC.expectsPurchaseAdvice({}), true,
  'F7 …and so is one whose channel we cannot read — "anything other than that is not sold yet"');

// The sold status, which is what actually silences the warning and the chase.
eq(RP.soldStatus({ tableFunded: true }), 'sold',
  'F8 table funded reads SOLD even with no PA date and nothing configured');
eq(RP.soldStatus({ channel: 'table_funding' }), 'sold', 'F9 …from either signal');
eq(RP.soldStatus({ paDate: '2026-05-12', fieldConfigured: true }), 'sold', 'F10 a real PA date still means sold');
eq(RP.soldStatus({ tableFunded: false, fieldConfigured: true, pulled: true }), 'not_sold',
  'F11 …and a direct file with no date is still "not sold yet"');
eq(RP.soldVia({ tableFunded: true }), 'table_funding', 'F12 the reason is reported, not just the answer');
eq(RP.soldVia({ paDate: '2026-05-12' }), 'purchase_advice', 'F13 …distinguishing the two ways of being sold');
eq(RP.soldVia({}), null, 'F14 …and claiming nothing when it is not sold');
{
  const d = RP.describe({ companyMode: 'investor_direct', tableFunded: true });
  eq(d.sold, 'sold', 'F15 a table-funded file assembles as sold');
  eq(d.tableFunded, true, 'F16 …says so on its face');
  eq(d.warning, null, 'F17 …and raises NO warning — this is the case that would otherwise nag forever');
  ok(/table funded/i.test(d.soldLabel), 'F18 …and the label explains WHY there is no purchase advice date');
}
{
  const d = RP.describe({ companyMode: 'investor_direct', tableFunded: false, fieldConfigured: true, pulled: true });
  eq(d.sold, 'not_sold', 'F19 a direct file with no PA date is not sold');
  ok(d.warning, 'F20 …and it does warn');
  ok(/go ahead/i.test(d.warning.body), 'F21 …while defaulting to carrying on, which is the owner\'s revised rule');
}

// ─────────────────────────────────────────── G. the registry wiring
{
  const e = map.BY_KEY.funding_channel;
  ok(e, 'G1 the channel is in the sync, on the field the owner named');
  eq(e.encompassFieldId, 'CX.TABLEFUNDER', 'G2 …CX.TABLEFUNDER');
  eq(e.valueMap, 'fundingChannel', 'G3 …declaring the SAME map the rule reads, so the two can never disagree');
  eq(e.direction, 'pull', 'G4 Encompass stays READ-ONLY');
  eq(e.blocksCtc, false, 'G5 …and no registry row can ever block CTC');
  eq(map.BY_KEY.ref_table_funder, undefined, 'G6 the old key is gone, not duplicated');
  // THE REGISTRY ROW MUST NOT BE COMPARED, and this is the guard on a hazard that was built and
  // then removed: as a compared enum, an Encompass value the shared table does not carry made the
  // row "no data to compare" on any FUNDED file, which summarize() counts as not-passing — so an
  // UNVERIFIED tenant spelling would have blocked the term sheet and the data-tape export, with
  // the only remedy being a code change nobody at the desk can make. Both real questions are asked
  // by rows reconcile.compareFundingChannel fully controls, each firing only on a readable value.
  eq(e.compare, 'reference', 'G7 …and it is REFERENCE — an unverified tenant value can never gate anything');
  eq(e.gate, map.GATE.REFERENCE, 'G8 …at the reference gate');
  eq(e.verified, false, 'G9 …and it says plainly that the tenant\'s values still need a live read');
}
// The two rows that DO ask a question, and what each may cost.
{
  const cfc = RECON._internals.compareFundingChannel;
  // An Encompass value nobody enumerated produces NOTHING — not a block, not an advisory, not a
  // "no data" row. This is the whole reason the registry row was demoted.
  eq(cfc('Fidelis Investors LLC', null, 'Some Table Funder Name', false).length, 0,
    'G10 an unreadable Encompass channel produces no row at all, so it can never gate a thing');
  eq(cfc('Fidelis Investors LLC', null, 'Table Funding', null).length, 0,
    'G11 …and neither does a file whose warehouse has not been picked yet');
  eq(cfc('Fidelis Investors LLC', null, 'Table Funding', true).length, 0,
    'G12 …nor one where the closing desk and Encompass agree');
  const dis = cfc('Fidelis Investors LLC', null, 'Table Funding', false);
  eq(dis.length, 1, 'G13 a genuine disagreement raises one row');
  eq(dis[0].key, 'funding_channel_agreement', 'G14 …the agreement row');
  eq(dis[0].gate, map.GATE.ADVISORY, 'G15 …ADVISORY — by the time both sides exist the term sheet is long issued');
  const both = cfc('Blue Lake Capital', null, 'Table Funding', false);
  eq(both.length, 2, 'G16 a file that is BOTH disallowed and disagreed-with raises both rows');
  eq(both.filter((r) => r.gate === map.GATE.BLOCK).length, 1, 'G17 …exactly one of which blocks');
}
{
  // The PA date field id the owner supplied. Absent, nothing reads the field at all and the sold
  // status honestly reads "we cannot tell" — which is exactly what it did before this landed.
  eq(map.PA_DATE_FIELD_ID, '2370', 'G9 the PA date is field 2370, as the owner supplied');
  ok(map.allFieldIds().includes('2370'),
    'G10 …and it is in the batch the reader asks Encompass for, so it actually gets read');
  const e = map.BY_KEY.purchase_advice_date;
  ok(e, 'G11 …with a registry entry');
  eq(e.gate, map.GATE.REFERENCE, 'G12 …that gates NOTHING — it only drives a warning');
  eq(e.direction, 'pull', 'G13 …and is read-only, like everything else here');
}

console.log(`test-funding-channel-pure: all ${n} table-funding checks passed.`);
