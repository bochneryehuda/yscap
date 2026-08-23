'use strict';
/**
 * THE PURCHASE ADVICE DATE IS TYPED IN ENCOMPASS AND NOWHERE ELSE — the rule, with no database.
 *
 * Owner-directed 2026-08-23: *"It should need to be filled into Encompass, and from there our line
 * and our field should automatically fill. You should not allow somebody to type in that field.
 * You should say, 'Hey, go to Encompass and type it over there,' and then everything should fire
 * the ClickUp and the pipeline and the status and the milestones."*
 *
 * TWO rules changed, and this covers the pure half of both:
 *
 *   1. `purchasing.setPurchaseAdvice` REFUSES any patch carrying a date. The refusal lives in the
 *      LIBRARY, not only in the route, so a caller reaching it another way is refused too — the
 *      same discipline as the advice document's staff-only forcing right beside it.
 *   2. `post-purchase.adviceGate` no longer compares two dates. Nobody types one, so the two can
 *      no longer disagree and a rule that cannot fail is a step, not a safeguard. What the owner
 *      put in its place: Encompass's date AND the advice document on file.
 *
 * PURE — the refusal throws before any query is issued, and the gate never had IO. Nothing here
 * opens a connection, so this runs on every push regardless of DATABASE_URL.
 */

const path = require('path');

const REPO = path.join(__dirname, '..');
// A pool is constructed at require-time; it connects lazily, so nothing here reaches a database.
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://unused:unused@127.0.0.1:1/unused';
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0'.repeat(64);

const purchasing = require(path.join(REPO, 'src/lib/purchasing.js'));
const postPurchase = require(path.join(REPO, 'src/lib/post-purchase.js'));

let pass = 0; let fail = 0;
const ok = (cond, what) => { if (cond) { pass += 1; console.log(`  ok  ${what}`); } else { fail += 1; console.error(`  FAIL ${what}`); } };

/* A client that FAILS LOUDLY if it is ever used. The whole point of rule 1 is that the refusal
   happens before any work — a stub that quietly returned rows would let a refusal that fires too
   late still pass. */
const noQuery = { query: () => { throw new Error('the refusal must happen BEFORE any query'); } };

(async () => {
  console.log('1. nobody types the purchase advice date');

  for (const patch of [{ date: '2026-07-31' }, { date: null }, { date: '' }, { date: '2026-07-31', documentId: 'x' }]) {
    let thrown = null;
    try { await purchasing.setPurchaseAdvice(noQuery, 'app-1', patch, 'staff-1'); }
    catch (e) { thrown = e; }
    ok(!!thrown, `a patch carrying ${JSON.stringify(patch)} is refused`);
    ok(thrown && thrown.status === 422, '…as a 422, so the screen shows the sentence rather than "server error"');
    ok(thrown && thrown.code === 'advice_date_is_encompass', '…with a code the screen can recognise');
    ok(thrown && /Encompass/.test(thrown.message), '…and the message names Encompass');
  }

  /* CLEARING IS THE SAME CLAIM, MADE BACKWARDS. A blank date says "this loan has no purchase
     advice", which is a statement about the sale, and Encompass is the only place that statement
     is made. Covered by the `{ date: null }` / `{ date: '' }` rows above; called out because it is
     the arm somebody would most plausibly "helpfully" re-open. */

  ok(/Encompass/.test(purchasing.ADVICE_DATE_IS_ENCOMPASS_MSG)
    && /upload/i.test(purchasing.ADVICE_DATE_IS_ENCOMPASS_MSG),
    'the refusal tells the reader where to go AND that the document still belongs here');

  console.log('2. a patch with no date is not refused by this rule');
  let docErr = null;
  try { await purchasing.setPurchaseAdvice(noQuery, 'app-1', { documentId: 'doc-1' }, 'staff-1'); }
  catch (e) { docErr = e; }
  ok(docErr && docErr.status !== 422,
    'a documentId-only patch gets past the date rule (it fails later, on the stub, which is the proof it got past)');
  let emptyErr = null;
  try { await purchasing.setPurchaseAdvice(noQuery, 'app-1', {}, 'staff-1'); }
  catch (e) { emptyErr = e; }
  ok(!emptyErr || emptyErr.status !== 422, 'an empty patch is not refused as a date write');

  console.log('3. "mark purchase complete" — Encompass has the date, and the advice is on file');

  const noEnc = postPurchase.adviceGate({ encompassDate: null, adviceDocumentId: 'doc-1' });
  ok(noEnc.ok === false && noEnc.code === 'no_encompass_advice',
    'no Encompass date → refused, and the code says which half');
  ok(/Encompass/.test(noEnc.message) && !/type|enter the same/i.test(noEnc.message),
    '…and it does NOT send the reader to a PILOT field that would refuse them');

  const noDoc = postPurchase.adviceGate({ encompassDate: '2026-07-31', adviceDocumentId: null });
  ok(noDoc.ok === false && noDoc.code === 'no_advice_document',
    'Encompass date but no advice document → refused on the document');
  ok(noDoc.encompass_date === '2026-07-31', '…and it reports the date it DID find, so the reader knows it landed');

  const both = postPurchase.adviceGate({ encompassDate: '2026-07-31', adviceDocumentId: 'doc-1' });
  ok(both.ok === true && both.date === '2026-07-31', 'both present → allowed');

  /* THE DATE IS STILL READ THROUGH THE ONE PARSER, so Encompass's own spellings all mean the same
     calendar day. This is what stops the gate refusing a loan whose date came back as a timestamp. */
  for (const spelling of ['2026-07-31', '2026-07-31T00:00:00.000Z', '7/31/2026', new Date('2026-07-31T12:00:00Z')]) {
    const g = postPurchase.adviceGate({ encompassDate: spelling, adviceDocumentId: 'doc-1' });
    ok(g.ok === true && g.date === '2026-07-31', `Encompass spelling ${String(spelling).slice(0, 24)} reads as the calendar day it is`);
  }

  const neither = postPurchase.adviceGate({});
  ok(neither.ok === false && neither.code === 'no_encompass_advice',
    'nothing at all → refused on Encompass first, because that is the one somebody has to go and do');

  console.log('4. the hand-off no longer asks for a date nobody can type');
  ok(!/date/i.test(postPurchase.TASK_LABEL),
    'the outstanding purchasing task does not ask anybody to enter the purchase advice date');

  console.log(`\n${fail ? 'FAILED' : 'PASSED'} — ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('THREW:', e && e.stack); process.exit(1); });
