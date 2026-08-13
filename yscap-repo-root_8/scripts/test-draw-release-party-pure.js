'use strict';
/**
 * WHO RELEASES THE MONEY — the pure rules (owner-directed 2026-08-09). No database, no network.
 *
 * Every assertion reproduces something the owner asked for by name: the four levels an answer can
 * come from and which one wins, the sold signal coming from the Purchase Advice date, and the
 * "this loan isn't sold yet — do you want to release it yourself?" question, which ASKS and never
 * changes anything.
 *
 * The three that matter most, and why:
 *   - a typo can never redirect a wire (an unrecognised stored value falls through, it is not honoured);
 *   - the warning FAILS TOWARD ASKING (only an affirmative "sold" silences it);
 *   - `manual` never auto-writes the money ledger (PILOT did not witness that money moving).
 */
const assert = require('assert');
const RP = require('../src/sitewire/release-party');
const ID = require('../src/sitewire/investor-delivery');

let n = 0;
const ok = (cond, what) => { assert.ok(cond, what); n++; };
const eq = (a, b, what) => { assert.strictEqual(a, b, `${what} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); n++; };

// ─────────────────────────────────────────────── A. the four levels, most specific first
eq(ID.resolveFundingModeAt({}).level, 'default', 'A1 nothing anywhere → the built-in default');
eq(ID.resolveFundingModeAt({}).mode, 'investor_direct', 'A2 …and that default is the investor releasing');
eq(ID.resolveFundingModeAt({ companyMode: 'reimbursement' }).level, 'company', 'A3 the company default answers when nothing below it does');
eq(ID.resolveFundingModeAt({ companyMode: 'reimbursement', ruleMode: 'manual' }).level, 'capital_provider', 'A4 the capital provider beats the company default');
eq(ID.resolveFundingModeAt({ companyMode: 'reimbursement', ruleMode: 'manual', fileMode: 'investor_direct' }).level, 'project', 'A5 the project beats the capital provider');
eq(ID.resolveFundingModeAt({ companyMode: 'reimbursement', ruleMode: 'manual', fileMode: 'investor_direct', drawMode: 'reimbursement' }).level, 'draw', 'A6 this one draw beats everything');
eq(ID.resolveFundingModeAt({ companyMode: 'reimbursement', ruleMode: 'manual', fileMode: 'investor_direct', drawMode: 'reimbursement' }).mode, 'reimbursement', 'A7 …and it is the draw\'s answer that is used');

// A TYPO MUST NEVER REDIRECT A WIRE. An unrecognised stored value at any level is not honoured —
// it falls through to the next level, exactly as if that level had never been set.
eq(ID.resolveFundingModeAt({ drawMode: 'investor', fileMode: 'reimbursement' }).level, 'project', 'A8 a bad per-draw value falls through');
eq(ID.resolveFundingModeAt({ fileMode: 'us', ruleMode: 'manual' }).level, 'capital_provider', 'A9 a bad project value falls through');
eq(ID.resolveFundingModeAt({ ruleMode: 'TRUE', companyMode: 'reimbursement' }).level, 'company', 'A10 a bad capital-provider value falls through');
eq(ID.resolveFundingModeAt({ companyMode: '{}' }).level, 'default', 'A11 a bad company value falls through to the built-in default');
eq(ID.resolveFundingModeAt({ drawMode: null, fileMode: undefined, ruleMode: '', companyMode: 0 }).level, 'default', 'A12 blanks of every shape are "no answer"');

// Back-compat: the mode-only helper every existing caller uses is unchanged in behaviour.
eq(ID.resolveFundingMode({ drawMode: 'reimbursement', fileMode: 'investor_direct' }), 'reimbursement', 'A13 the mode-only helper still answers exactly as before');
eq(ID.resolveFundingMode({}), ID.DEFAULT_MODE, 'A14 …including its default');

// Every level a screen can show has wording for it — no raw keys ever reach a person.
for (const [level] of ID.MODE_LEVELS) ok(ID.LEVEL_LABEL[level], `A15 the "${level}" level has plain wording`);
ok(ID.LEVEL_LABEL.default, 'A16 …and so does the built-in default');

// ─────────────────────────────────────────────── B. the sold signal (the PA date)
eq(RP.paDateOf('2026-05-12'), '2026-05-12', 'B1 an ISO date reads straight through');
eq(RP.paDateOf('2026-05-12T00:00:00Z'), '2026-05-12', 'B2 an ISO timestamp keeps its calendar day');
eq(RP.paDateOf('5/12/2026'), '2026-05-12', 'B3 a US-style date is understood');
eq(RP.paDateOf(new Date('2026-05-12T12:00:00Z')), '2026-05-12', 'B4 a Date object is accepted');
eq(RP.paDateOf(''), null, 'B5 blank is no date');
eq(RP.paDateOf(null), null, 'B6 null is no date');
eq(RP.paDateOf('not a date'), null, 'B7 junk is no date, never a guess');
eq(RP.paDateOf('0026-01-01'), null, 'B8 a two-digit-year artifact is refused, not pivoted');
eq(RP.paDateOf('2026-13-45'), '2026-13-45', 'B9 an ISO-shaped value is passed through for the column to judge');

eq(RP.soldStatus({ paDate: '2026-05-12', fieldConfigured: true }), 'sold', 'B10 a purchase advice date means SOLD');
eq(RP.soldStatus({ paDate: '2026-05-12', fieldConfigured: false }), 'sold', 'B11 …whatever else is missing — a real date is proof');
eq(RP.soldStatus({ fieldConfigured: true, pulled: true }), 'not_sold', 'B12 readable, pulled, no date → not sold yet');
eq(RP.soldStatus({ fieldConfigured: true, pulled: false }), 'unknown', 'B13 a file never read from Encompass → we cannot tell');
eq(RP.soldStatus({ fieldConfigured: false }), 'unknown', 'B14 no field id configured → we cannot tell (never a confident "not sold")');
eq(RP.soldStatus({}), 'unknown', 'B15 asked with nothing at all → we cannot tell');

// OUR OWN PURCHASING DESK'S RECORD IS ALSO PROOF (owner-reported 2026-08-13: a loan sold two weeks
// earlier still read as "not sold" on the draw desk). The purchasing team records the advice the
// day it arrives; Encompass's column is filled by a poll that reaches each file on a rota. Reading
// only Encompass made PILOT disagree with itself — the 30-day chase has always accepted either.
eq(RP.soldStatus({ ourAdviceDate: '2026-07-31', fieldConfigured: true, pulled: true }), 'sold',
  'B16 an advice recorded on OUR purchasing desk means sold, with no Encompass date at all');
eq(RP.soldVia({ ourAdviceDate: '2026-07-31' }), 'our_purchase_advice',
  'B17 …and the desk can say which record answered');
eq(RP.soldVia({ paDate: '2026-07-01', ourAdviceDate: '2026-07-31' }), 'purchase_advice',
  'B18 …with Encompass named first when both hold one');
eq(RP.adviceDateOf({ ourAdviceDate: '2026-07-31' }), '2026-07-31', 'B19 the date we hold is reported whichever source has it');
eq(RP.adviceDateOf({ paDate: '2026-07-01', ourAdviceDate: '2026-07-31' }), '2026-07-01', 'B20 …Encompass first when both do');
eq(RP.adviceDateOf({}), null, 'B21 …and null when neither does');
eq(RP.soldStatus({ ourAdviceDate: 'not a date', fieldConfigured: true, pulled: true }), 'not_sold',
  'B22 a garbage date proves nothing — it is read through the SAME parser as Encompass\'s');
{
  const d = RP.describe({ ourAdviceDate: '2026-07-31', fieldConfigured: true, pulled: true, companyMode: 'investor_direct' });
  eq(d.sold, 'sold', 'B23 describe() reads it too');
  eq(d.mode, 'investor_direct', 'B24 …so the file releases the way it is set, with nobody having to press anything');
  eq(d.badge, null, 'B25 …and it carries no "not sold" badge');
  eq(d.paDate, '2026-07-31', 'B26 …and reports the date it actually holds');
  eq(d.paDateEncompass, null, 'B27 …naming which source does NOT hold it');
  eq(d.ourAdviceDate, '2026-07-31', 'B28 …and which one does');
}

// ─────────────────────────────────────────────── C. who actually wires, and the ledger
eq(RP.ledgerParty('investor_direct'), 'investor', 'C1 investor_direct: the investor wires');
eq(RP.ledgerParty('reimbursement'), 'us', 'C2 reimbursement: we wire');
eq(RP.ledgerParty('manual'), null, 'C3 manual: PILOT did not witness it, so it does not claim to know');
eq(RP.ledgerParty('junk'), null, 'C4 an unrecognised mode answers nothing');
eq(RP.autoLedgers('investor_direct'), true, 'C5 PILOT writes the ledger itself only when the investor released');
eq(RP.autoLedgers('reimbursement'), false, 'C6 on a we-release draw the typed-in wire stays the record');
eq(RP.autoLedgers('manual'), false, 'C7 …and a manual delivery writes nothing automatically');

// ─────────────────────────────────────────────── D. NOT SOLD → WE RELEASE, and the way past it
// THE OWNER CHANGED THIS RULE ON 2026-08-13, superseding the advisory warning of 2026-08-09:
// "if Encompass has a PA date already, then it should always proceed with the setting of the file
//  … if it's not yet sold, then it should always be set up that we release the net amount."
// So the sold signal now DECIDES the mode instead of commenting on it.
eq(RP.enforcedMode({ mode: 'investor_direct', sold: 'sold' }).mode, 'investor_direct',
  'D1 a SOLD loan keeps the file’s own setting — the investor releases if that is what it says');
eq(RP.enforcedMode({ mode: 'reimbursement', sold: 'sold' }).mode, 'reimbursement',
  'D2 …and the other way round too — a sold loan is never redirected');
eq(RP.enforcedMode({ mode: 'investor_direct', sold: 'not_sold' }).mode, 'reimbursement',
  'D3 an UNSOLD loan is released by US, whatever the file says');
eq(RP.enforcedMode({ mode: 'investor_direct', sold: 'unknown' }).mode, 'reimbursement',
  'D4 …and so is one we cannot confirm — it fails towards our own money, never towards the investor’s');
eq(RP.enforcedMode({ mode: 'investor_direct', sold: 'not_sold' }).forced, true,
  'D5 …and it says the answer was overridden, so a screen can explain why');
eq(RP.enforcedMode({ mode: 'reimbursement', sold: 'not_sold' }).forced, false,
  'D6 a file already on "we release" was not overridden by anything');
eq(RP.enforcedMode({ mode: 'manual', sold: 'not_sold' }).mode, 'manual',
  'D7 a manual delivery is left alone — PILOT never witnessed that money and must not claim to know');
eq(RP.enforcedMode({ mode: 'investor_direct', sold: 'not_sold' }).configured, 'investor_direct',
  'D8 the file’s own setting is still reported, so it can be shown and resumed when the loan sells');

// THE COORDINATOR'S OVERRIDE — "the draw coordinator should be able to switch a file … imagine if
// it was sold already. In case anything goes wrong, she should have this ability."
eq(RP.effectiveSold({ sold: 'not_sold', treatAsSold: true }), 'sold', 'D9 processing a file as sold moves the answer to sold');
eq(RP.effectiveSold({ sold: 'unknown', treatAsSold: true }), 'sold', 'D9b …from either of the two unconfirmed states');
eq(RP.effectiveSold({ sold: 'not_sold', treatAsSold: false }), 'not_sold', 'D9c …and without it nothing moves');
eq(RP.effectiveSold({ sold: 'sold', treatAsSold: false }), 'sold', 'D9d a really-sold loan needs no override');
eq(RP.enforcedMode({ mode: 'investor_direct', sold: RP.effectiveSold({ sold: 'not_sold', treatAsSold: true }) }).mode,
  'investor_direct', 'D10 with the override on, the file’s own setting governs again');
eq(RP.effectiveSold({}), 'unknown', 'D11 asked with nothing → we cannot tell, never a confident answer');

// THE BADGE — on every not-sold file, stating what happens and offering the way past it.
const w = RP.notSoldBadge({ sold: 'not_sold' });
eq(w.code, 'not_sold_yet', 'D12 an unsold file carries the badge');
eq(RP.notSoldBadge({ sold: 'sold' }), null, 'D13 a sold one carries none at all');
ok(/not sold yet/i.test(w.title), 'D14 the badge says so in the owner’s own words');
ok(/WE release/i.test(w.body), 'D15 …and states what happens instead: we release the draw');
ok(/stays out of that wire/i.test(w.body), 'D16 …that our fee is simply not in the wire, rather than collected later');
ok(/charges no draw fee/i.test(w.body), 'D17 …and that the investor charges nothing on it');
eq(w.action, 'treat_as_sold', 'D18 the way past it is offered as an action a screen can wire up');
eq(w.certain, true, 'D19 a proven "no PA date" says so plainly');
eq(RP.notSoldBadge({ sold: 'unknown' }).certain, false, 'D20 …and an unreadable one is honest that it cannot tell');
ok(!/\bmust\b|cannot proceed|blocked/i.test(w.body), 'D21 it still refuses nothing');

const t = RP.notSoldBadge({ sold: 'not_sold', treatAsSold: true, treatedBy: 'Dana Coordinator', treatedAt: '2026-08-13T10:00:00Z' });
eq(t.code, 'treated_as_sold', 'D22 once processed as sold the badge flips to its second state');
eq(t.treated, true, 'D23 …and says which state it is in');
ok(/Dana Coordinator/.test(t.body), 'D24 …naming WHO decided it, so the override is never anonymous');
ok(/2026-08-13/.test(t.body), 'D25 …and when');
eq(t.action, 'clear', 'D26 …and offers the way back rather than the way forward');
// The badge never rewrites the loan: the FACT stays whatever Encompass says.
eq(RP.soldStatus({ fieldConfigured: true, pulled: true }), 'not_sold', 'D27 the sold FACT is untouched by any override');

// ─────────────────────────────────────────────── E. the whole answer, assembled
// A SOLD loan is the case where the settings ladder decides, so the ladder is proven there.
const d = RP.describe({ companyMode: 'reimbursement', ruleMode: 'investor_direct', fileMode: 'TYPO', paDate: '2026-05-12' });
eq(d.mode, 'investor_direct', 'E1 describe() resolves through the same ladder');
eq(d.level, 'capital_provider', 'E2 …and reports which level decided');
eq(d.levelLabel, ID.LEVEL_LABEL.capital_provider, 'E3 …in words a person reads');
eq(d.levels.project, null, 'E4 a level holding a typo reports as unanswered, matching how it was treated');
eq(d.levels.capital_provider, 'investor_direct', 'E5 …and a real answer is reported as it stands');
eq(d.levels.company, 'reimbursement', 'E6 …at every level, so a settings screen never re-derives the fall-through');
ok(d.modeLabel && d.modeHelp, 'E7 the mode carries its own label and explanation');
eq(d.party, 'investor', 'E8 the assembled answer names who wires');
eq(d.autoLedger, true, 'E9 …and whether PILOT records it itself');
eq(d.badge, null, 'E10 a sold file carries no badge');
eq(d.forcedByNotSold, false, 'E10b …and nothing overrode its setting');
eq(d.soldEffective, 'sold', 'E10c …and it is processed as what it is');

// THE SAME FILE, NOT SOLD: the ladder still reports what it holds, but WE release.
const u = RP.describe({ companyMode: 'reimbursement', ruleMode: 'investor_direct', fieldConfigured: true, pulled: true });
eq(u.mode, 'reimbursement', 'E11 an unsold loan is released by us, whatever the ladder says');
eq(u.configuredMode, 'investor_direct', 'E11b …with the file’s own setting still reported, ready to resume');
eq(u.forcedByNotSold, true, 'E11c …and flagged as overridden, so the screen can say why');
eq(u.party, 'us', 'E11d …so the ledger records OUR wire, not the investor’s');
eq(u.autoLedger, false, 'E11e …and PILOT never writes an investor release row for it');
ok(u.badge && u.badge.code === 'not_sold_yet', 'E11f …and it carries the not-sold badge');
eq(u.soldEffective, 'not_sold', 'E11g …and is processed as not sold');

// …until the draw desk processes it as sold, which puts the ladder back in charge.
const o = RP.describe({ companyMode: 'reimbursement', ruleMode: 'investor_direct', fieldConfigured: true, pulled: true,
  treatAsSold: true, treatedBy: 'Dana Coordinator', treatedAt: '2026-08-13T10:00:00Z' });
eq(o.mode, 'investor_direct', 'E12 processed as sold → the file’s own setting governs again');
eq(o.soldEffective, 'sold', 'E12b …the money reads it as sold');
eq(o.sold, 'not_sold', 'E12c …while the FACT about the loan is untouched');
eq(o.treatedAsSold, true, 'E12d …and the screen is told it is an override, not a sale');
eq(o.soldVia, 'coordinator', 'E12e …attributed to the desk rather than to Encompass');
ok(o.badge && o.badge.code === 'treated_as_sold', 'E12f …with the badge in its second state');
eq(o.party, 'investor', 'E12g …so an investor-released draw is recorded as theirs again');

// describe() must never throw, whatever it is handed — it feeds a screen, not a decision.
for (const bad of [undefined, {}, { drawMode: {} }, { paDate: 12345 }, { companyMode: [] }]) {
  const r = RP.describe(bad);
  ok(r && ID.MODES.includes(r.mode), `E13 describe(${JSON.stringify(bad)}) still returns a real mode`);
}

console.log(`test-draw-release-party-pure: all ${n} release-party rule checks passed.`);
