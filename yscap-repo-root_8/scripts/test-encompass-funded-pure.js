/* THE FUNDED DATE READS ITSELF OFF ENCOMPASS — the decision half, with no database.
 *
 * Owner-reported 2026-08-21: *"right now you need to enter a funded date in PILOT, and PILOT
 * does not automatically recognize from Encompass the funded date … we check any file that
 * gets the funded date in Encompass filled, which I believe is cx.fundeddate — it should
 * automatically fill in the funded date for that file in PILOT and should automatically change
 * the status for that file, but it should still not be reconciled, because reconciled will also
 * require making sure ClickUp matches as well."*
 *
 * What this pins:
 *   A. the decision table — every branch of what a file should get;
 *   B. FILL-ONLY — a date somebody typed is never replaced, in any combination;
 *   C. the read is the CLOSING DESK'S OWN reader, so the date written on the file can never
 *      disagree with the date the reconciliation gate is measuring — and it reads BOTH shapes
 *      the tenant produces (the CX.FUNDEDDATE custom field and the closingDocument JSON path);
 *   D. SOURCE GUARDS — nothing here writes to Encompass, and nothing here reconciles.
 *
 * Pure — no database, no network.
 * Run: node scripts/test-encompass-funded-pure.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) pass++; else { fail++; console.log(`FAIL ${name}`); } };
const eq = (name, got, exp) => {
  if (JSON.stringify(got) === JSON.stringify(exp)) pass++;
  else { fail++; console.log(`FAIL ${name}: got ${JSON.stringify(got)} expected ${JSON.stringify(exp)}`); }
};

const F = require('../src/lib/encompass-funded');
const closing = require('../src/lib/closing');

// ---------------------------------------------------------------- A. the decision table
const live = (over) => ({ status: 'processing', funded_date: null, deleted_at: null, ...over });

eq('A1 no Encompass date → nothing happens',
  F.decideFundedSync(live(), null).skipped, 'no_funded_date');
eq('A2 …and an empty string is not a date either',
  F.decideFundedSync(live(), '').skipped, 'no_funded_date');
eq('A3 no file → nothing happens', F.decideFundedSync(null, '2026-07-31').skipped, 'no_file');
eq('A4 a soft-deleted file is left alone',
  F.decideFundedSync(live({ deleted_at: new Date() }), '2026-07-31').skipped, 'deleted');

// A funded date on a DECLINED loan is two systems contradicting each other. That belongs to a
// human — so nothing is written at all, not even the date.
eq('A5 a declined file is left completely alone',
  F.decideFundedSync(live({ status: 'declined' }), '2026-07-31').skipped, 'terminal_negative');
eq('A6 …and a withdrawn one',
  F.decideFundedSync(live({ status: 'withdrawn' }), '2026-07-31').skipped, 'terminal_negative');
ok('A7 …and that refusal writes NOTHING — not the date, not the status', (() => {
  const d = F.decideFundedSync(live({ status: 'declined' }), '2026-07-31');
  return d.fillDate === null && d.moveStatus === false;
})());

eq('A8 the ordinary case — fill the date AND move the file to Funded',
  F.decideFundedSync(live(), '2026-07-31'),
  { fillDate: '2026-07-31', moveStatus: true });

eq('A9 a file already Funded with the date on it needs nothing',
  F.decideFundedSync(live({ status: 'funded', funded_date: '2026-07-31' }), '2026-07-31').skipped,
  'already_current');

// ---------------------------------------------------------------- B. FILL-ONLY
// The Encompass panel already SHOWS both sides (the funded_date row is compare:'reference'),
// so a disagreement is visible to a human. Silently replacing the closer's figure with the
// vendor's is how the number money moved on changes without anybody deciding.
{
  const d = F.decideFundedSync(live({ funded_date: '2026-01-05' }), '2026-07-31');
  eq('B1 a date already on the file is NEVER replaced', d.fillDate, null);
  eq('B2 …but the status still moves — the loan did fund', d.moveStatus, true);
}
{
  const d = F.decideFundedSync(live({ status: 'funded', funded_date: null }), '2026-07-31');
  eq('B3 already Funded but no date → just fill the date', d.fillDate, '2026-07-31');
  eq('B4 …and the status is not re-written', d.moveStatus, false);
}
ok('B5 the fill is never a CLEAR — a blank Encompass date can never wipe ours',
  F.decideFundedSync(live({ funded_date: '2026-01-05' }), null).fillDate === null);

// ---------------------------------------------------------------- C. one reader, both shapes
// This is what makes the written date and the closing desk's reconciliation gate impossible to
// disagree: they are literally the same function.
eq('C1 the CX.FUNDEDDATE custom field',
  closing.readEncompassFundedDate({ encompass_extra: { customFields: [{ fieldName: 'CX.FUNDEDDATE', value: '08/04/2026' }] } }),
  '2026-08-04');
eq('C2 the closingDocument JSON fallback',
  closing.readEncompassFundedDate({ encompass_extra: { closingDocument: { fundingDate: '07/31/2026' } } }),
  '2026-07-31');
eq('C3 …and an ISO timestamp reads as its calendar day',
  closing.readEncompassFundedDate({ encompass_extra: { closingDocument: { fundingDate: '2026-07-31T00:00:00Z' } } }),
  '2026-07-31');
eq('C4 an empty loan says nothing rather than guessing',
  closing.readEncompassFundedDate({ encompass_extra: { closingDocument: {} } }), null);
// The custom field is the tenant's REAL funded date, so it wins over the JSON path.
eq('C5 the custom field wins over the JSON fallback',
  closing.readEncompassFundedDate({ encompass_extra: {
    customFields: [{ fieldName: 'CX.FUNDEDDATE', value: '08/04/2026' }],
    closingDocument: { fundingDate: '07/31/2026' } } }),
  '2026-08-04');

// ---------------------------------------------------------------- D. source guards
const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'encompass-funded.js'), 'utf8');
// Strip comments before every "must not appear" test — the code that documents WHY it never
// writes to Encompass necessarily names the thing it does not do.
const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

ok('D1 ENCOMPASS IS READ-ONLY — this module makes no Encompass call at all',
  !/integrations\/encompass|encompass-client|flood-order|apiGet|pipelineSearch/.test(code));
ok('D2 …and it opens no HTTP of its own', !/\bfetch\s*\(|require\('https?'\)/.test(code));

// The owner's own carve-out: "it should still not be reconciled because reconciled will also
// require making sure ClickUp matches as well."
ok('D3 RECONCILIATION IS NEVER TOUCHED — closing_workflow is not written here',
  !/closing_workflow/.test(code));
ok('D4 …not fully_reconciled, not reconciled_ok, not the closing stage',
  !/fully_reconciled|reconciled_ok/.test(code));

// The watermark decides whether the borrower is ever told. Moving it here would make the
// "your loan is funded" email silent forever after — see rule 4 in the module header.
ok('D5 the borrower-notification watermark is deliberately left alone',
  !/status_notified_external/.test(code));

/* D6 REVERSED, ON THE OWNER'S OWN INSTRUCTION (2026-08-21). This used to assert that
   NOTHING here drove the ClickUp card, because landing it on `closed (6-email funded)` sends
   an email from ClickUp and that was an outward-facing action nobody had asked an automatic
   reader to take. It was put to the owner as an open question and answered: *"Connect the
   statuses of our system to ClickUp: when we update our loan as funded, ClickUp updates as
   closed."* So the card IS moved now, and this guard follows the code rather than being
   deleted — the three things that must stay true are pinned instead.

   (This is the same shape as the drag-and-drop guard that had to follow its rule out of
   rehab-budget.js: a test pinning a deliberate limit is doing its job when it fails on the
   day that limit is lifted, and the answer is to re-point it, never to drop it.) */
ok('D6a the card is moved through the ONE module that knows the post-closing ladder',
  /require\('\.\.\/clickup\/post-closing-stage'\)[\s\S]{0,140}advanceCard\(appId, 'funded'/.test(code));
ok('D6b …only when the status ACTUALLY moved, so a re-read never re-fires its ClickUp email',
  /if \(statusMoved\) \{[\s\S]{0,800}advanceCard\(appId, 'funded'/.test(code));
// A stage spelled here would be a second definition of a name ClickUp validates — and a
// drifted one is a push ClickUp refuses in silence, from inside a best-effort caller.
ok('D6c …and this file still names no ClickUp status of its own',
  !/['"]closed \(6-email funded\)['"]/.test(code));

// The two writes are the two the owner asked for, and no more. `ON CONFLICT DO UPDATE SET`
// is matched deliberately narrowly (`UPDATE <table>`) so the bookmark upsert is not counted.
{
  const updates = code.match(/UPDATE\s+(?!SET\b)(\w+)/g) || [];
  eq('D7 every UPDATE statement is on applications',
    [...new Set(updates.map((u) => u.split(/\s+/)[1]))], ['applications']);
  eq('D8 …and there are exactly two of them', updates.length, 2);
  // The bookmark is the ONLY other table this module writes, and it holds no file data.
  const inserts = [...new Set((code.match(/INSERT INTO\s+(\w+)/g) || []).map((u) => u.split(/\s+/)[2]))].sort();
  eq('D8b …and the only other writes are the audit row and its own bookmark',
    inserts, ['audit_log', 'sync_runtime_state']);
}
ok('D9 the date write is fill-only IN THE STATEMENT, not by a check somebody can forget',
  /funded_date=\$2::date[\s\S]{0,120}funded_date IS NULL/.test(code));
ok('D10 the status write can never move a declined/withdrawn file',
  /SET status=\$2[\s\S]{0,240}status <> ALL\(\$3::text\[\]\)/.test(code));

// ---------------------------------------------------------------- E. the door is WIRED
// A correct rule with no caller is a dead door — this repo has shipped exactly that twice
// (the Trinity eligibility rule fed the wrong context; the ISG desk mapped a retired
// template). No unit test of the rule itself can see its caller, so the wiring is read from
// the source.
const readerSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'encompass', 'reader.js'), 'utf8');
ok('E1 the per-file Encompass pull calls the funded-date sync',
  /require\('\.\.\/lib\/encompass-funded'\)\.syncFundedDate\(/.test(readerSrc));
// It must be handed the SCRUBBED loan — what `encompass_extra` now holds — so what it reads
// is exactly what every later reader of that column will read.
ok('E2 …and is handed the scrubbed loan the pull just stored',
  /\.syncFundedDate\(db, appId, scrubbed\)/.test(readerSrc));
ok('E3 …AFTER that loan was stored, so a failed store never lands a funded date',
  readerSrc.indexOf('encompass_extra=$1::jsonb') < readerSrc.indexOf('.syncFundedDate('));
ok('E4 …and it can never break a pull (it is wrapped)',
  /try \{[\s\S]{0,200}\.syncFundedDate\([\s\S]{0,80}catch \(_\)/.test(readerSrc));

const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
ok('E5 the back-book walk runs at boot',
  /require\('\.\/lib\/encompass-funded'\)\.backfillStoredFundedDatesOnce\(/.test(serverSrc));
ok('E6 …and keeps walking until it is finished, rather than one batch per restart',
  /!r\.done && !r\.skipped[\s\S]{0,80}setTimeout\(drainEncompassFunded/.test(serverSrc));

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
