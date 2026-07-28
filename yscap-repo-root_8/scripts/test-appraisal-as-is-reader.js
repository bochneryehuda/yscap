'use strict';
/**
 * PURE tests for the As-Is reader ladder (owner-directed 2026-07-28) — no DB, no network.
 *
 * Three things are pinned here, and each one is a real way money gets lost:
 *   1. the Ctrl-F scanner must NEVER return the ARV / as-repaired number, and must find the As-Is
 *      even when an OCR page break split the label from the amount;
 *   2. the AI is a LOCATOR, not a source of truth — a value it cannot ground in a verbatim quote
 *      that our own scanner re-reads as an as-is must be refused;
 *   3. the write rule is ONE-DIRECTIONAL — below the purchase price, lowering or filling only,
 *      never on a frozen file, never on a reading we are not confident in.
 */
const R = require('../src/lib/appraisal/as-is-reader');

let failures = 0;
const assert = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };

// ===========================================================================
// 1. The Ctrl-F scanner
// ===========================================================================
{
  const text = [
    'Reconciliation of Value',
    "The 'as is' market value of the subject property is $ 430,000 as of the effective date.",
    'The as-repaired (ARV) value upon completion of the proposed renovation is $575,000.',
    'Value subject to completion per plans and specs: $ 575,000',
  ].join('\n');
  const s = R.scanAsIs(text);
  assert(s.labeled.includes(430000), 'as-is 430,000 read as a LABELLED hit');
  assert(!s.labeled.includes(575000) && !s.near.includes(575000), 'the as-repaired / subject-to 575,000 is never returned');
}

{
  const s = R.scanAsIs('As-Is Value: $312,500\nAs Repaired Value: $410,000');
  assert(s.labeled.length === 1 && s.labeled[0] === 312500, 'compact "As-Is Value: $312,500" read; the ARV line excluded');
}

// The page-break case — this is the whole reason for the line-PAIR pass. A line-only scan (the old
// behaviour) finds nothing here, and these are exactly the files where the XML was silent too.
{
  const s = R.scanAsIs(['OPINION OF VALUE', 'As-Is Value:', '$312,500', 'As Repaired:', '$410,000'].join('\n'));
  assert(s.labeled.includes(312500), 'a label and amount split across an OCR line break is still read');
  assert(!s.labeled.includes(410000) && !s.near.includes(410000), 'the wrapped as-repaired amount is NOT read as as-is');
}

{
  // Real-world traps that must not become a "value".
  assert(R.scanAsIs('Property at 90210 inspected as-is').hits.length === 0, 'a zip on an as-is line is not money');
  assert(R.scanAsIs('As-is condition. APN 12345678 recorded.').hits.length === 0, 'an APN is not money');
  assert(R.scanAsIs('Property inspected as is on 05/12/2026. Condition C3.').hits.length === 0, 'a date is not money');
  assert(R.scanAsIs('The basis of value is $430,000').hits.length === 0, '"basis" does not false-match the "as is" token');
  // The cost-approach SiteOtherImprovementsAsIsAmount decoy — the one attribute whose NAME contains
  // "AsIs" but which is a driveway/fence figure. The plausibility floor is what stops it.
  assert(R.scanAsIs('Site other improvements as is amount $4,500 (cost approach)').hits.length === 0,
    'the cost-approach site-improvements decoy is below the value floor and never becomes a candidate');
}

// A number in the NEXT sentence is NOT that line's as-is value (it is still reported as a weak
// candidate, so a human sees it, but it can never stand alone as confident).
{
  const s = R.scanAsIs('The property was inspected as is. The rehab budget is $85,000.');
  assert(!s.labeled.includes(85000), 'an amount after a sentence break is not labelled as the as-is');
}
{
  const s = R.scanAsIs("The 'as is' market value of the subject property is $430,000.");
  assert(s.labeled.includes(430000), 'the ordinary long phrasing ("as is market value of the subject property is $X") is LABELLED');
}

{
  const s = R.scanAsIs('The renovated figure is $575,000; the as is value is $430,000.');
  assert(s.labeled.length === 1 && s.labeled[0] === 430000, 'on a shared line the amount AFTER "as is" wins, never the reno figure');
}

// A dollar amount can sit beside "as is" without being the appraiser's opinion of OUR subject.
// Writing one of these onto the loan would put a stranger's number on the file — now that a
// confident read is written in EITHER direction, these must never even be candidates.
{
  assert(R.scanAsIs('Comparable 3 sold as is for a value of $430,000').hits.length === 0, "a COMPARABLE's as-is sale price is not the subject's as-is value");
  assert(R.scanAsIs('Comp #2 as is market value $412,000').hits.length === 0, 'a comp line is dropped whole');
  assert(R.scanAsIs('The subject is currently listed as is at a price of $455,000').hits.length === 0, 'an asking / listing price is not an opinion of value');
  assert(R.scanAsIs('Tax assessed value as is: $180,000').hits.length === 0, 'a tax assessment is not the appraiser’s opinion');
  assert(R.scanAsIs('Annual rent as is, market value $48,000').hits.length === 0, 'a rent figure is not a property value');
  assert(R.scanAsIs('Insurable replacement cost as is value $390,000').hits.length === 0, 'an insurance replacement cost is not a market value');
}

// THE PRE-PRINTED FORM LINE. `"As-is" Value of Site Improvements` is printed on Fannie Mae Forms
// 1004 / 1025 / 1073 / 2055 and is filled on essentially every appraisal with a cost approach. It is
// labelled "Value", it is a plausible amount below the ARV — and on a plain 1004 it is often the ONLY
// as-is-labelled money line in the whole report, because the real opinion of value is written "my
// opinion of the market value … is $430,000" with no "as is" on the line at all. Unguarded, a
// driveway becomes the property's As-Is.
{
  for (const line of [
    '"As-is" Value of Site Improvements ....... = $15,000',
    '"As-is" Value of Site Improvements: $15,000',
    'As-is Value of Site Improvements  $15,000',
    'Depreciated Cost of Improvements as is $185,000',
    'Estimated Reproduction Cost-New as is $340,000',
  ]) {
    assert(R.scanAsIs(line).hits.length === 0, `the pre-printed cost-approach line is never a candidate: ${line.slice(0, 42)}…`);
  }
  assert(R.scanAsIs('As Is Land Value: $150,000').hits.length === 0, 'a LAND value is not the property’s as-is value');
  assert(R.scanAsIs('As-Is Site Value $95,000').hits.length === 0, 'a SITE value is not the property’s as-is value');
}

// A per-something RATE on a 2-4 unit is a quarter of the property's value and passes every other
// guard — plausible, below the ARV, not a ten-fold slip.
{
  assert(R.scanAsIs('As-is value per unit: $150,000').hits.length === 0, 'a per-UNIT rate is never a candidate');
  assert(R.scanAsIs('As is market value per square foot $185,000').hits.length === 0, 'a per-square-foot rate is never a candidate');
  assert(R.scanAsIs('As-is value / unit $150,000').hits.length === 0, 'the slash form of a per-unit rate is caught too');
}

// A STACKED LABEL BLOCK is not a wrap. Layout OCR of a two-column value box emits all the labels
// then all the amounts; joining blindly pairs the As-Is label with the ARV's amount — and the ARV
// ceiling only catches that when the ARV is known, which it is not on a straight purchase.
{
  const s = R.scanAsIs(['As Repaired Value', 'As Is Value', '$450,000', '$312,500'].join('\n'));
  assert(!s.labeled.includes(450000), 'a stacked label block never pairs the As-Is label with the ARV amount');
  assert(s.labeled.length === 0, 'when which amount belongs to which label is unknowable, nothing is claimed');
}
{
  // …but an ordinary section HEADING above the label must still allow the wrap.
  const s = R.scanAsIs(['OPINION OF VALUE', 'As-Is Value:', '$312,500'].join('\n'));
  assert(s.labeled.includes(312500), 'a heading above the label does not block the wrap');
}

// A negative amount is an adjustment, never a value.
{
  assert(!R.scanAsIs('As-Is Value adjustment: -$312,500').labeled.includes(312500), 'a minus-signed amount is not read as a value');
  assert(!R.scanAsIs('As-Is Value ($312,500)').labeled.includes(312500), 'a bracketed (negative) amount is not read as a value');
}

// A LABELLED hit has to read as a statement of VALUE, not as incidental "as is" prose.
{
  const s = R.scanAsIs('The property was accepted as is and the rehab budget is $85,000');
  assert(!s.labeled.includes(85000), 'a budget on an "as is" line is not a LABELLED as-is value');
}
{
  assert(R.scanAsIs('As-Is Value: $312,500').labeled.includes(312500), '"Value" makes it labelled');
  assert(R.scanAsIs('Opinion of value, as is: $312,500').labeled.includes(312500), '"Opinion of value" makes it labelled');
  assert(R.scanAsIs('Appraised as is at $312,500').labeled.includes(312500), '"Appraised" makes it labelled');
  const terse = R.scanAsIs('as-is: $312,500');
  assert(!terse.labeled.includes(312500) && terse.near.includes(312500),
    'a terse "as-is: $X" with no value word is a WEAK candidate — surfaced for a human, never written alone');
}

// ===========================================================================
// 2. The ladder — XML first
// ===========================================================================
const never = {
  ocrRouter: { configured: () => { throw new Error('the OCR router must not be touched when the XML answers'); }, read: () => { throw new Error('no'); } },
  legacyOcr: { ocrSpaceText: () => { throw new Error('no'); } },
  analyzer: { available: () => { throw new Error('no'); }, extract: () => { throw new Error('no'); } },
};

(async () => {
  {
    const r = await R.readAsIs({ xmlAsIs: 430000, xmlAsIsConfidence: 'definite', pdfBase64: 'xx' }, never);
    assert(r.found && r.value === 430000 && r.source === 'xml' && r.confidence === 'definite' && r.confident,
      'a DEFINITE XML as-is short-circuits the ladder (no OCR, no AI, no cost)');
  }
  {
    // An XML value that is only an ESTIMATE is never trusted — extract() never marks one definite,
    // and the reader must not promote it either.
    const r = await R.readAsIs({ xmlAsIs: 308567, xmlAsIsConfidence: 'estimate' }, never);
    assert(!r.found && !r.confident, 'a non-definite XML as-is is NOT used (never estimate-store)');
  }
  // THE INFERRED-BASIS TRAP. A MISMO appraisal has ONE "opinion of value" box; what it means is set
  // by _CONDITION_OF_APPRAISAL. With that enum missing, extract.js infers the basis from narrative
  // wording — and on a renovation report whose wording it does not recognise, the AFTER-REPAIR value
  // is what lands as a "definite" As-Is. Writing that would overstate the collateral by the whole
  // rehab. Now that a confident read is written in either direction, nothing downstream would catch
  // it, so the headline number is only trusted on an EXPLICIT basis.
  {
    const r = await R.readAsIs({ xmlAsIs: 620000, xmlAsIsConfidence: 'definite', appraisedValue: 620000, xmlBasis: null }, never);
    assert(r.found && r.value === 620000 && !r.confident, 'the HEADLINE value with NO basis enum is reported but never confident');
    assert(/as is.*after repair|"as is" or "after repair"/i.test(r.reason || ''), 'the reason says the appraisal never stated which kind of value it is');
  }
  {
    const r = await R.readAsIs({ xmlAsIs: 430000, xmlAsIsConfidence: 'definite', appraisedValue: 430000, xmlBasis: 'AsIs' }, never);
    assert(r.confident && r.value === 430000, 'the headline value WITH an explicit AsIs basis is confident');
  }
  {
    // The common renovation case: the headline number is the ARV, and the As-Is was mined from a
    // sentence in the narrative. That sentence needs no enum to be believed.
    const r = await R.readAsIs({ xmlAsIs: 430000, xmlAsIsConfidence: 'definite', appraisedValue: 575000, xmlBasis: null }, never);
    assert(r.confident && r.value === 430000, 'a NARRATIVE-mined As-Is is unaffected by the basis guard');
  }
  {
    const r = await R.readAsIs({ xmlAsIs: 620000, xmlAsIsConfidence: 'definite', appraisedValue: 620000, xmlBasis: 'SubjectToAlterations' }, never);
    assert(!r.confident, 'an UNRECOGNISED basis enum is treated as inferred, not as permission');
  }
  {
    const r = await R.readAsIs({ xmlAsIs: null, xmlAsIsConfidence: 'missing' }, never);
    assert(!r.found && /no appraisal PDF/i.test(r.reason || ''), 'no XML value and no PDF → an honest "nothing to read"');
  }

  // ---- the PDF path ------------------------------------------------------
  const pdfDeps = (text, analyzer) => ({
    ocrRouter: { configured: () => true, read: async () => ({ ok: true, text, engine: 'azure-docint', pageCount: 30 }) },
    legacyOcr: { ocrSpaceText: async () => ({ ok: false, reason: 'not used' }) },
    analyzer: analyzer || { available: () => false, extract: async () => ({ ok: false }) },
  });

  {
    const text = "As-Is Value: $312,500\nAs Repaired Value: $410,000\nSubject to completion: $410,000";
    const r = await R.readAsIs({ xmlAsIs: null, xmlAsIsConfidence: 'missing', arv: 410000, pdfBase64: 'x' }, pdfDeps(text));
    assert(r.found && r.value === 312500 && r.confident && r.confidence === 'high' && r.source === 'pdf_text',
      'one clean labelled hit in the PDF is CONFIDENT');
    assert(r.engine === 'azure-docint', 'the winning OCR engine is reported');
  }
  {
    // Two different labelled amounts → ambiguous → reported, but NOT confident.
    const text = 'As-Is Value: $312,500\nElsewhere: the as is value is $290,000';
    const r = await R.readAsIs({ arv: 410000, pdfBase64: 'x' }, pdfDeps(text));
    assert(r.found && !r.confident && r.confidence === 'low', 'two conflicting as-is amounts → NOT confident');
    assert(r.candidates.length === 2, 'both candidates are reported for the human');
  }
  {
    // Above the ARV → the ARV misread. Dropped, never returned as a value.
    const text = 'as is value $500,000';
    const r = await R.readAsIs({ arv: 410000, pdfBase64: 'x' }, pdfDeps(text));
    assert(!r.found && !r.confident, 'an "as-is" at or above the ARV is dropped, not returned');
  }
  {
    const r = await R.readAsIs({ arv: 410000, pdfBase64: 'x' }, pdfDeps('Gross living area 1,850 sq ft. Condition C4.'));
    assert(!r.found && /no as-is value could be read/i.test(r.reason || ''), 'a PDF with no as-is wording reads as nothing');
  }
  {
    // THE DIGIT SLIP. $430,000 read as $43,000 is plausible, is below the ARV, and sits on a
    // properly labelled line — every other check passes it. Now that a confident read is written in
    // either direction, this is the one misread that could quietly wreck a file, so it can never be
    // confident. It is still REPORTED, because occasionally it is the real number.
    // A dropped zero lands BELOW the floor (15% of the biggest number the file already trusts), so it
    // never even becomes a candidate — the safest possible outcome.
    const r = await R.readAsIs(
      { arv: 620000, fileAsIs: 430000, pdfBase64: 'x' },
      pdfDeps('The as is market value is $43,000.'));
    assert(!r.confident && r.value !== 43000, 'a dropped-zero misread is filtered out — never written, never offered as the answer');
  }
  {
    // A DOUBLED zero on a file with no ARV is where the digit-slip guard earns its keep: there is no
    // ceiling to catch it and it is far above the floor, so only the ×10 relationship gives it away.
    const r = await R.readAsIs(
      { fileAsIs: 430000, purchasePrice: 450000, pdfBase64: 'x' },
      pdfDeps('The as is market value is $4,300,000.'));
    assert(r.found && r.value === 4300000 && !r.confident, 'a doubled-zero misread is reported but NEVER confident');
    assert(/factor of ten/i.test(r.reason || ''), 'the reason names the digit slip so a human knows what to check');
  }
  {
    // A five-figure cost-approach line item on a file with real numbers can never be the As-Is.
    const r = await R.readAsIs(
      { arv: 620000, purchasePrice: 450000, pdfBase64: 'x' },
      pdfDeps('The as is market value of the garage is $18,000 per the cost estimate.'));
    assert(!r.confident, 'an amount under 15% of every number the file trusts is not a property value');
  }
  {
    // …but a genuinely different number that merely happens to be small is untouched by the guard.
    const r = await R.readAsIs(
      { arv: 620000, fileAsIs: 430000, pdfBase64: 'x' },
      pdfDeps('The as is market value is $385,000.'));
    assert(r.confident && r.value === 385000, 'an ordinary reading is not caught by the digit-slip guard');
  }
  {
    const deps = {
      ocrRouter: { configured: () => true, read: async () => ({ ok: false, reason: 'service unavailable' }) },
      legacyOcr: { ocrSpaceText: async () => ({ ok: true, text: 'Reconciliation. The as is value of the subject is $250,000 as of the effective date.' }) },
      analyzer: { available: () => false, extract: async () => ({ ok: false }) },
    };
    const r = await R.readAsIs({ pdfBase64: 'x' }, deps);
    assert(r.found && r.value === 250000 && r.engine === 'ocr-space', 'the legacy reader rescues when the router fails');
  }
  {
    const deps = {
      ocrRouter: { configured: () => true, read: async () => { throw new Error('boom'); } },
      legacyOcr: { ocrSpaceText: async () => { throw new Error('boom'); } },
      analyzer: { available: () => false, extract: async () => ({ ok: false }) },
    };
    const r = await R.readAsIs({ pdfBase64: 'x' }, deps);
    assert(!r.found && !r.confident && /could not be read/i.test(r.reason || ''), 'every reader throwing is reported, never thrown');
  }

  // ---- the AI locator ----------------------------------------------------
  {
    // The realistic win: the report states it in prose our line scan splits badly, and the AI hands
    // back the verbatim sentence — which our own scanner then re-reads as a labelled as-is.
    const text = ['ADDENDUM', 'The appraiser notes that the', 'as is value of the subject is $265,000', 'while the subject to repairs value is $520,000.'].join('\n');
    const ai = {
      available: () => true,
      extract: async () => ({ ok: true, data: { found: true, value: 265000, quote: 'as is value of the subject is $265,000', reason: 'stated in the addendum' } }),
    };
    const r = await R.readAsIs({ arv: 520000, pdfBase64: 'x' }, pdfDeps(text, ai));
    assert(r.found && r.value === 265000 && r.confident, 'a grounded AI quote our scanner re-reads is CONFIDENT');
  }
  {
    // The dangerous case: the AI invents a number that is nowhere in the document.
    const ai = {
      available: () => true,
      extract: async () => ({ ok: true, data: { found: true, value: 199000, quote: 'the as is value is $199,000', reason: 'made up' } }),
    };
    const r = await R.readAsIs({ arv: 520000, pdfBase64: 'x' }, pdfDeps('Gross living area 1,850 sq ft.', ai));
    assert(!r.confident, 'an AI value whose quote is NOT in the report text is refused');
    assert(!r.found || r.value !== 199000, 'a hallucinated amount is never returned as the reading');
  }
  {
    // The AI quotes something real, but it is not an as-is statement.
    const text = 'The subject to repairs value is $520,000 as of the effective date.';
    const ai = {
      available: () => true,
      extract: async () => ({ ok: true, data: { found: true, value: 520000, quote: 'The subject to repairs value is $520,000', reason: 'x' } }),
    };
    const r = await R.readAsIs({ pdfBase64: 'x' }, pdfDeps(text, ai));
    assert(!r.confident, 'a real quote that does not read as an as-is is refused (the ARV can never sneak in)');
  }
  {
    // THE PRIOR SALE PRICE. "The subject sold as is on 05/2019 for $215,000" is a real sentence,
    // genuinely in the document, that the AI will happily hand back — and it is a number from years
    // ago, not today's value. Both grounding gates would pass it if a `near` re-read counted, which
    // is why gate 2 requires a LABELLED one.
    const text = 'RECONCILIATION. The subject sold as is on 05/2019 for $215,000 in an arm\'s length transaction. The market value of the subject is $430,000.';
    const ai = {
      available: () => true,
      extract: async () => ({ ok: true, data: { found: true, value: 215000, quote: 'The subject sold as is on 05/2019 for $215,000', reason: 'x' } }),
    };
    const r = await R.readAsIs({ arv: 620000, pdfBase64: 'x' }, pdfDeps(text, ai));
    assert(!r.confident, 'a PRIOR SALE PRICE the AI points at is never confident — a `near` re-read is not grounding');
  }
  {
    const ai = { available: () => true, extract: async () => { throw new Error('gpt down'); } };
    const r = await R.readAsIs({ pdfBase64: 'x' }, pdfDeps('as is value $250,000\nand as is $260,000', ai));
    assert(!r.confident && r.found, 'the AI throwing degrades to the deterministic (not-confident) candidate');
  }

  // =========================================================================
  // 3. The write rule
  // =========================================================================
  const confident = (v) => ({ found: true, value: v, confident: true, confidence: 'high', source: 'pdf_text' });

  // THE RULE IS CONFIDENCE, AND ONLY CONFIDENCE (owner-directed 2026-07-28, correcting the first
  // cut): "as long as you're confident you can write it no matter what it was". Direction and the
  // purchase price are no longer gates — only trust in the number, and the file freeze, are.
  {
    const d = R.decideAsIsApply({ read: confident(430000), fileAsIs: 500000, purchasePrice: 450000 });
    assert(d.apply && d.value === 430000 && d.kind === 'reduced', 'confident + lower → APPLY (reduced)');
    assert(d.belowPrice === true, 'below the purchase price is REPORTED, so the wording can say so');
  }
  {
    const d = R.decideAsIsApply({ read: confident(440000), fileAsIs: 400000, purchasePrice: 450000 });
    assert(d.apply && d.value === 440000 && d.kind === 'raised', 'confident + HIGHER than the file → APPLY (raised) — the reduction-only guard is gone');
  }
  {
    const d = R.decideAsIsApply({ read: confident(460000), fileAsIs: 400000, purchasePrice: 450000 });
    assert(d.apply && d.kind === 'raised' && d.belowPrice === false, 'confident + ABOVE the purchase price → APPLY; below-price is reported, not required');
  }
  {
    const d = R.decideAsIsApply({ read: confident(430000), fileAsIs: null, purchasePrice: 450000 });
    assert(d.apply && d.kind === 'filled', 'a blank As-Is is filled');
  }
  {
    const d = R.decideAsIsApply({ read: confident(430000), fileAsIs: 500000, purchasePrice: null });
    assert(d.apply && d.belowPrice === null, 'no purchase price no longer blocks the write — it just cannot be reported');
  }
  {
    const d = R.decideAsIsApply({ read: confident(430000), fileAsIs: 430000, purchasePrice: 450000 });
    assert(!d.apply && d.why === 'same_value', 'the value the file already shows is not rewritten (no pointless reprice churn)');
  }
  {
    const d = R.decideAsIsApply({ read: confident(430000), fileAsIs: 430000.004, purchasePrice: 450000 });
    assert(!d.apply && d.why === 'same_value', 'a sub-cent difference is the same value (the column is numeric(14,2))');
  }
  {
    const d = R.decideAsIsApply({ read: { found: true, value: 430000, confident: false, confidence: 'low' }, fileAsIs: 500000, purchasePrice: 450000 });
    assert(!d.apply && d.why === 'not_confident', 'a NOT-confident reading is never written — in EITHER direction');
  }
  {
    const d = R.decideAsIsApply({ read: confident(430000), fileAsIs: 500000, purchasePrice: 450000, lockReason: 'the term sheet has been sent' });
    assert(!d.apply && d.why === 'file_locked', 'a frozen file is never written to — PILOT has no private door through the freeze');
  }
  {
    const d = R.decideAsIsApply({ read: confident(430000), fileAsIs: 500000, purchasePrice: 450000, autoEnabled: false });
    assert(!d.apply && d.why === 'auto_off', 'the kill switch stops the write');
  }
  {
    const d = R.decideAsIsApply({ read: confident(500), fileAsIs: null, purchasePrice: 450000 });
    assert(!d.apply && d.why === 'implausible', 'an implausible amount is refused');
  }

  // =========================================================================
  // 4. The wording an officer reads
  // =========================================================================
  {
    const read = { ...confident(430000), quote: "the 'as is' market value is $430,000" };
    const dec = R.decideAsIsApply({ read, fileAsIs: 500000, purchasePrice: 450000 });
    const note = R.buildAsIsNote({ read, decision: dec, fileAsIsBefore: 500000, purchasePrice: 450000 });
    assert(/^\[auto\]/.test(note), 'the note is [auto]-prefixed so a human-typed note is never clobbered');
    assert(/lowered/i.test(note) && /\$500,000/.test(note) && /\$430,000/.test(note), 'the note says it LOWERED the value, and names both numbers');
    assert(/re-review/i.test(note), 'the note invites a re-review');
    assert(/re-priced|Products & Pricing/i.test(note), 'the note warns that the loan has to be re-priced');
  }
  {
    const read = { found: false, value: null, confident: false, confidence: null, reason: 'no as-is value could be read from the appraisal report', engine: 'azure-docint' };
    const dec = R.decideAsIsApply({ read, fileAsIs: null, purchasePrice: 450000 });
    const note = R.buildAsIsNote({ read, decision: dec, fileAsIsBefore: null, purchasePrice: 450000 });
    assert(/could not confidently read/i.test(note), 'the unreadable note says PILOT could not confidently read it');
    assert(/never guessed|Nothing has been filled in/i.test(note), 'the unreadable note states nothing was filled in');
    assert(/type it in the box|enter/i.test(note) && /clear this condition/i.test(note), 'the unreadable note tells the human to enter the value to clear the condition');
  }
  {
    const read = { ...confident(460000), quote: 'as is value $460,000' };
    const dec = R.decideAsIsApply({ read, fileAsIs: 400000, purchasePrice: 450000 });
    const note = R.buildAsIsNote({ read, decision: dec, fileAsIsBefore: 400000, purchasePrice: 450000 });
    assert(/RAISED/.test(note) && /\$400,000/.test(note) && /\$460,000/.test(note), 'a RAISE says so plainly and names both numbers');
    assert(/re-priced/i.test(note) && /nothing about the loan amount changes until/i.test(note),
      'a raise makes clear the loan amount does not move until a human re-registers the product');
    assert(!/BELOW the purchase price/.test(note), 'a value above the purchase price does not claim to be below it');
  }
  {
    const read = { ...confident(430000), quote: 'as is value $430,000' };
    const dec = R.decideAsIsApply({ read, fileAsIs: 430000, purchasePrice: 450000 });
    const note = R.buildAsIsNote({ read, decision: dec, fileAsIsBefore: 430000, purchasePrice: 450000 });
    assert(/already shows/i.test(note) && /nothing needed changing/i.test(note),
      'an agreeing reading says the file already matches, so nothing needed doing');
  }
  {
    const read = { ...confident(430000), quote: 'as is value $430,000' };
    const dec = R.decideAsIsApply({ read, fileAsIs: 500000, purchasePrice: 450000, lockReason: 'the term sheet has been sent' });
    const note = R.buildAsIsNote({ read, decision: dec, fileAsIsBefore: 500000, purchasePrice: 450000 });
    assert(/locked/i.test(note) && /type it in the box/i.test(note),
      'a frozen file explains the lock and still offers the human the box');
  }

  console.log(failures ? `\n${failures} assertion(s) FAILED` : '\nALL As-Is reader assertions passed');
  process.exit(failures ? 1 : 0);
})();
