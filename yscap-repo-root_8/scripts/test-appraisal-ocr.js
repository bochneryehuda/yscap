/**
 * Unit test for the appraisal OCR advisory text parser + note builder (no network).
 * Confirms findAsIs picks the As-Is amount and NEVER the ARV / as-repaired / subject-to
 * number, and that buildOcrNote always states OCR was tried and never claims the value
 * was applied to the file.
 */
const { findAsIs, buildOcrNote } = require('../src/lib/appraisal/ocr');
let failures = 0;
const assert = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };

// 1) An "as is" line yields the amount; the "as repaired"/ARV line is excluded.
{
  const text = [
    'Reconciliation of Value',
    "The 'as is' market value of the subject property is $ 430,000 as of the effective date.",
    'The as-repaired (ARV) value upon completion of the proposed renovation is $575,000.',
    'Value subject to completion per plans and specs: $ 575,000',
  ].join('\n');
  const hits = findAsIs(text);
  const amounts = hits.map((h) => h.amount);
  assert(amounts.includes(430000), 'as-is 430,000 found');
  assert(!amounts.includes(575000), 'as-repaired/subject-to 575,000 NOT picked up');
}

// 2) "As-Is Value: $312,500" compact phrasing.
{
  const hits = findAsIs('As-Is Value: $312,500\nAs Repaired Value: $410,000');
  assert(hits.length === 1 && hits[0].amount === 312500, 'compact As-Is 312,500 found, ARV excluded');
}

// 3) No as-is text at all → no hits.
{
  const hits = findAsIs('Estimated market value as completed: $600,000\nGross living area 1,850 sq ft');
  assert(hits.length === 0, 'no false positive when there is no as-is line');
}

// 4) Tiny/again-year-like numbers are not amounts.
{
  const hits = findAsIs('Property inspected as is on 05/12/2026. Condition C3.');
  assert(hits.length === 0, 'a date on an as-is line is not read as a dollar amount');
}

// 4b) A bare run of digits (zip / APN / phone / reference) on an as-is line is NOT money.
{
  assert(findAsIs('Property at 90210 inspected as-is').length === 0, 'a zip (90210) on an as-is line is not read as money');
  assert(findAsIs('As-is condition. APN 12345678 recorded.').length === 0, 'an APN (12345678) is not read as money');
  assert(findAsIs('Call 8005551234 re: the as is opinion').length === 0, 'a phone number is not read as money');
  assert(findAsIs('inspected as-is; see report #45012').length === 0, 'a reference number is not read as money');
}

// 4c) When the ARV and As-Is share ONE line and the ARV word is not in the drop-list, pick
// the amount nearest the "as is" token (never the ARV).
{
  const hits = findAsIs('The renovated figure is $575,000; the as is value is $430,000.');
  assert(hits.length === 1 && hits[0].amount === 430000, 'nearest-to-"as is" wins over the ARV on a shared line');
}

// 4d) An ARV labelled by a synonym OUTSIDE the drop-list, right after "as is", is NOT returned
// (safe miss, never the ARV) — the residual the re-audit flagged.
{
  assert(findAsIs('Opinion of value as is; stabilized value $575,000.').length === 0, 'a stabilized (ARV) value after "as is" is not read as As-Is');
  assert(findAsIs('as is, after renovation $575,000, presently $430,000').some((h) => h.amount === 430000)
      && !findAsIs('as is, after renovation $575,000, presently $430,000').some((h) => h.amount === 575000),
    'with "after renovation $X, presently $Y" the presently (As-Is) value wins, never the reno value');
}

// 4e) A legitimate As-Is line mentioning "improvements" is NOT wrongly skipped (precise synonyms).
{
  const hits = findAsIs('The as is value of the improvements is $430,000.');
  assert(hits.length === 1 && hits[0].amount === 430000, '"value of the improvements is $X" still reads the As-Is');
}

// 4f) "before/prior to renovation" is an AS-IS phrasing — the value must NOT be skipped (the
// synonym is `renovated`, the adjective, not bare "renovation").
{
  assert(findAsIs('as is value before renovation is $430,000').some((h) => h.amount === 430000), '"as is value before renovation $X" still reads the As-Is');
  assert(findAsIs('as is value prior to renovation $430,000').some((h) => h.amount === 430000), '"prior to renovation $X" still reads the As-Is');
  // but the ARV adjective forms are still skipped
  assert(findAsIs('as is; renovated value $575,000').length === 0, '"renovated value $X" (ARV) is still skipped');
}

// 5) Note builder: candidate present → says tried + suggestion + not applied.
{
  const note = buildOcrNote({ attempted: true, candidate: 430000, confidence: 'single-match', snippet: "'as is' market value is $430,000" });
  assert(/OCR/.test(note) && /\$430,000/.test(note), 'note names OCR and the candidate amount');
  assert(/NOT been applied|never filled/i.test(note), 'note states it was NOT applied to the file');
}

// 6) Note builder: no candidate → still says tried + asks officer to enter.
{
  const note = buildOcrNote({ attempted: true, reason: 'no confident As-Is value could be read from the PDF' });
  assert(/OCR/.test(note) && /enter the As-Is/i.test(note), 'no-candidate note still asks the officer to enter it');
}

// 7) Note builder: not attempted (too large) → honest about not scanning.
{
  const note = buildOcrNote({ attempted: false, reason: 'the appraisal PDF is too large for the OCR service — please read the As-Is off the report' });
  assert(/too large/i.test(note), 'oversized-PDF note is honest that it did not scan');
}

console.log(`\n${failures ? failures + ' FAILURE(S)' : 'ALL OCR-parser assertions passed'}`);
process.exit(failures ? 1 : 0);
