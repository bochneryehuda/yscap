/* "WHICH FIELD ARE YOU ACTUALLY LOOKING AT?" — the pure half (owner-reported 2026-08-21).
 *
 * A file with a purchase advice date received the "no purchase advice" chase, and the owner asked
 * two things: work out what the system is doing wrong, and *"give me the field that you have."*
 * The DB suite proves the wiring. This proves the JUDGEMENT — every branch of the plain-language
 * answer and the rule for recognising a field that is about a purchase advice — with no database,
 * so each branch is reachable and none of it can hide behind a swallowing catch.
 *
 * THE ORDER OF THE BRANCHES IS THE POINT and is asserted deliberately: somebody reading this wants
 * to be told the WORST thing first. The field being switched off outranks the id looking wrong,
 * which outranks the reads failing, which outranks a queue that has not drained yet. Reporting the
 * queue while the id is wrong would send an admin away to wait for a sweep that can never help.
 *
 * Run: node scripts/test-purchase-advice-diagnosis-pure.js
 */
let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) pass++; else { fail++; console.log(`FAIL ${name}`); } };
const eq = (name, got, exp) => { if (JSON.stringify(got) === JSON.stringify(exp)) pass++; else { fail++; console.log(`FAIL ${name}: got ${JSON.stringify(got)} expected ${JSON.stringify(exp)}`); } };

const D = require('../src/lib/purchase-advice-diagnosis');
const zero = { funded: 10, value: 0, blank: 0, not_returned: 0, no_field_id: 0, no_loan_link: 0, never_asked: 0 };

// ── A. Recognising a field that is about a purchase advice ──────────────────
{
  ok('A1 a key that says so', D.mentionsPurchaseAdvice({ key: 'CX.PURCHASEADVICE', raw: {} }));
  ok('A2 a label that says so', D.mentionsPurchaseAdvice({ key: '2370', label: 'Purchase Advice Date', raw: {} }));
  ok('A3 case and spacing do not matter', D.mentionsPurchaseAdvice({ key: 'x', label: 'PURCHASE ADVICE date', raw: {} }));
  // The RAW object is searched too: Encompass returns a field's description on several different
  // keys depending on which settings resource it came from, so a label we happened not to map
  // would otherwise hide the very field we are hunting for.
  ok('A4 …and a description only present on the raw object still counts',
    D.mentionsPurchaseAdvice({ key: '2370', label: null, raw: { description: 'Purchase advice date' } }));
  ok('A5 an unrelated field does not', !D.mentionsPurchaseAdvice({ key: 'CX.ARV', label: 'After repair value', raw: {} }));
  ok('A6 …and neither does a near-miss word', !D.mentionsPurchaseAdvice({ key: 'CX.PURCHASEPRICE', label: 'Purchase price', raw: {} }));
  ok('A7 an unreadable row is never claimed', !D.mentionsPurchaseAdvice(null));
  // A raw object that cannot be serialized must not throw — this runs over every catalogue row.
  const circ = {}; circ.self = circ;
  let threw = null;
  try { D.mentionsPurchaseAdvice({ key: 'x', label: 'y', raw: circ }); } catch (e) { threw = e; }
  ok('A8 …and a row that cannot be serialized is skipped, never thrown on', !threw);
}

// ── B. The plain-language answer, branch by branch ──────────────────────────
{
  const noField = D.summarize({ fieldId: null }, zero);
  ok('B1 no field configured is said plainly and first',
    /not reading a purchase advice field at all/.test(noField));

  // AN ID THE TENANT DOES NOT HAVE outranks everything below it: it is the whole cause, and no
  // amount of sweeping can fix it.
  const wrongId = D.summarize(
    { fieldId: '2370', known: false, candidates: [{ key: 'CX.PURCHASEADVICE' }] },
    { ...zero, not_returned: 5, never_asked: 40 });
  ok('B2 an id the tenant does not carry is reported ahead of the symptoms',
    /does not contain it/.test(wrongId));
  ok('B3 …naming what the tenant DOES have instead', /CX\.PURCHASEADVICE/.test(wrongId));

  const notReturned = D.summarize({ fieldId: '2370', known: true }, { ...zero, not_returned: 3, never_asked: 40 });
  ok('B4 reads coming back without the field are reported ahead of the queue',
    /answered without it/.test(notReturned) && /3 funded files/.test(notReturned));

  const queued = D.summarize({ fieldId: '2370', known: true }, { ...zero, never_asked: 40 });
  ok('B5 a book that has not been asked yet says so — and does NOT say the loans are unsold',
    /not been asked yet/.test(queued) && !/unsold/.test(queued));

  // A CATALOGUE THAT HAS NEVER BEEN PULLED IS `null`, NOT `false`, and must not be reported as a
  // wrong id — that would send somebody hunting for a field that is perfectly fine.
  const unknownCatalog = D.summarize({ fieldId: '2370', known: null }, { ...zero, value: 9, blank: 1 });
  ok('B6 an unpulled field list never reads as "your Encompass does not have this field"',
    !/does not contain it/.test(unknownCatalog));

  const clean = D.summarize({ fieldId: '2370', known: true, knownLabel: 'Purchase Advice Date' },
    { ...zero, value: 9, blank: 1 });
  ok('B7 a healthy book reports the split it actually measured',
    /9 with a date/.test(clean) && /1 empty/.test(clean));
  ok('B8 …under the tenant\'s own label for the field', /Purchase Advice Date/.test(clean));

  const noLoans = D.summarize({ fieldId: '2370', known: true }, { ...zero, no_loan_link: 6 });
  ok('B9 holding no Encompass loans at all is its own answer', /nothing to ask about/.test(noLoans));

  // Singulars, because one file reading "1 funded files" is the sort of thing that makes a reader
  // distrust every other number in the message.
  ok('B10 one file reads as one file',
    /1 funded file has/.test(D.summarize({ fieldId: '2370', known: true }, { ...zero, never_asked: 1 })));
  ok('B11 …on the not-returned line too',
    /1 funded file /.test(D.summarize({ fieldId: '2370', known: true }, { ...zero, not_returned: 1 })));
}

// ── C. It never throws, whatever it is handed ───────────────────────────────
{
  let threw = null;
  try {
    D.summarize(null, null);
    D.summarize({}, {});
    D.summarize({ fieldId: '2370' }, undefined);
  } catch (e) { threw = e; }
  ok('C1 a missing or half-built diagnosis still produces a sentence rather than an exception', !threw);
  ok('C2 …and the sentence is a real one', typeof D.summarize(null, null) === 'string' && D.summarize(null, null).length > 10);
}

// ── D. Reading the tenant's field list — with a STUB, so no database is needed ──
//
// `fieldDiagnosis` takes its pool as an argument for exactly this reason. The distinction it draws
// is load-bearing and invisible to `summarize`: an EMPTY catalogue means "your field list has never
// been pulled", which is a different answer from "your field list does not contain this id" — and
// reporting the second when we mean the first sends an admin hunting for a field that is perfectly
// fine.
(async () => {
  const stub = (rows) => ({ query: async () => ({ rows }) });
  const now = new Date();

  const empty = await D.fieldDiagnosis(stub([]));
  eq('D1 an EMPTY field list answers "we do not know", never "not known"', empty.known, null);
  eq('D2 …and counts itself honestly', empty.catalogRows, 0);

  const id = String(empty.fieldId || '2370');
  const withMine = await D.fieldDiagnosis(stub([
    { kind: 'standardField', key: id, label: 'Purchase Advice Date', raw: {}, pulled_at: now },
    { kind: 'customField', key: 'CX.ARV', label: 'After repair value', raw: {}, pulled_at: now },
  ]));
  eq('D3 a list that carries our id says so', withMine.known, true);
  eq('D4 …under the tenant\'s own label', withMine.knownLabel, 'Purchase Advice Date');
  eq('D5 …and lists only the fields that are about a purchase advice',
    withMine.candidates.map((c) => c.key), [id]);
  ok('D6 …and records when the list was pulled', !!withMine.catalogPulledAt);

  const without = await D.fieldDiagnosis(stub([
    { kind: 'customField', key: 'CX.PURCHASEADVICE', label: 'Purchase advice date', raw: {}, pulled_at: now },
  ]));
  eq('D7 a POPULATED list that does not carry our id is the interesting state', without.known, false);
  ok('D8 …and the alternative is offered', without.candidates.some((c) => c.key === 'CX.PURCHASEADVICE'));

  // A catalogue table that does not exist yet must not take the diagnosis down with it.
  const broken = await D.fieldDiagnosis({ query: async () => { throw new Error('relation does not exist'); } });
  ok('D9 an unreadable field list degrades rather than throwing', broken && broken.known === null);

  console.log(fail ? `test-purchase-advice-diagnosis-pure: ${pass} passed, ${fail} FAILED` : `test-purchase-advice-diagnosis-pure: all ${pass} checks passed.`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('test-purchase-advice-diagnosis-pure threw:', e); process.exit(1); });
