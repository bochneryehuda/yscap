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

// ─────────────────────────────────────────────── C. who actually wires, and the ledger
eq(RP.ledgerParty('investor_direct'), 'investor', 'C1 investor_direct: the investor wires');
eq(RP.ledgerParty('reimbursement'), 'us', 'C2 reimbursement: we wire');
eq(RP.ledgerParty('manual'), null, 'C3 manual: PILOT did not witness it, so it does not claim to know');
eq(RP.ledgerParty('junk'), null, 'C4 an unrecognised mode answers nothing');
eq(RP.autoLedgers('investor_direct'), true, 'C5 PILOT writes the ledger itself only when the investor released');
eq(RP.autoLedgers('reimbursement'), false, 'C6 on a we-release draw the typed-in wire stays the record');
eq(RP.autoLedgers('manual'), false, 'C7 …and a manual delivery writes nothing automatically');

// ─────────────────────────────────────────────── D. the not-sold question
ok(RP.notSoldWarning({ mode: 'investor_direct', sold: 'not_sold' }), 'D1 investor releases + not sold → ask');
ok(RP.notSoldWarning({ mode: 'investor_direct', sold: 'unknown' }), 'D2 investor releases + cannot tell → ask (fails toward asking)');
eq(RP.notSoldWarning({ mode: 'investor_direct', sold: 'sold' }), null, 'D3 investor releases + sold → nothing to ask');
eq(RP.notSoldWarning({ mode: 'reimbursement', sold: 'not_sold' }), null, 'D4 we release → not our question');
eq(RP.notSoldWarning({ mode: 'manual', sold: 'not_sold' }), null, 'D5 manual → not our question either');
eq(RP.notSoldWarning({}), null, 'D6 asked with nothing → nothing');

const w = RP.notSoldWarning({ mode: 'investor_direct', sold: 'not_sold' });
eq(w.suggestMode, 'reimbursement', 'D7 the one-click way out is "we release"');
ok(ID.MODES.includes(w.suggestMode), 'D8 …and it is a real mode the switch can store');
ok(/release it yourself/i.test(w.body), 'D9 the question is asked in the owner\'s own words');
eq(w.certain, true, 'D10 a proven "no PA date" says so plainly');
eq(RP.notSoldWarning({ mode: 'investor_direct', sold: 'unknown' }).certain, false, 'D11 …and an unreadable one is honest that it cannot tell');
ok(!/\bmust\b|cannot proceed|blocked/i.test(w.body), 'D12 it is a QUESTION, never a refusal');

// ─────────────────────────────────────────────── E. the whole answer, assembled
const d = RP.describe({ companyMode: 'reimbursement', ruleMode: 'investor_direct', fileMode: 'TYPO' });
eq(d.mode, 'investor_direct', 'E1 describe() resolves through the same ladder');
eq(d.level, 'capital_provider', 'E2 …and reports which level decided');
eq(d.levelLabel, ID.LEVEL_LABEL.capital_provider, 'E3 …in words a person reads');
eq(d.levels.project, null, 'E4 a level holding a typo reports as unanswered, matching how it was treated');
eq(d.levels.capital_provider, 'investor_direct', 'E5 …and a real answer is reported as it stands');
eq(d.levels.company, 'reimbursement', 'E6 …at every level, so a settings screen never re-derives the fall-through');
ok(d.modeLabel && d.modeHelp, 'E7 the mode carries its own label and explanation');
eq(d.party, 'investor', 'E8 the assembled answer names who wires');
eq(d.autoLedger, true, 'E9 …and whether PILOT records it itself');
ok(d.warning, 'E10 an unsold investor-released draw asks the question');
eq(RP.describe({ companyMode: 'investor_direct', paDate: '2026-05-12' }).warning, null, 'E11 a sold one does not');

// describe() must never throw, whatever it is handed — it feeds a screen, not a decision.
for (const bad of [undefined, {}, { drawMode: {} }, { paDate: 12345 }, { companyMode: [] }]) {
  const r = RP.describe(bad);
  ok(r && ID.MODES.includes(r.mode), `E12 describe(${JSON.stringify(bad)}) still returns a real mode`);
}

console.log(`test-draw-release-party-pure: all ${n} release-party rule checks passed.`);
