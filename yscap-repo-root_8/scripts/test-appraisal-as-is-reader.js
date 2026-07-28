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
    const deps = {
      ocrRouter: { configured: () => true, read: async () => ({ ok: false, reason: 'service unavailable' }) },
      legacyOcr: { ocrSpaceText: async () => ({ ok: true, text: 'as is value is $250,000' }) },
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
    const ai = { available: () => true, extract: async () => { throw new Error('gpt down'); } };
    const r = await R.readAsIs({ pdfBase64: 'x' }, pdfDeps('as is value $250,000\nand as is $260,000', ai));
    assert(!r.confident && r.found, 'the AI throwing degrades to the deterministic (not-confident) candidate');
  }

  // =========================================================================
  // 3. The write rule
  // =========================================================================
  const confident = (v) => ({ found: true, value: v, confident: true, confidence: 'high', source: 'pdf_text' });

  {
    const d = R.decideAsIsApply({ read: confident(430000), fileAsIs: 500000, purchasePrice: 450000 });
    assert(d.apply && d.value === 430000 && d.kind === 'reduced', 'confident + below the purchase price + a reduction → APPLY');
  }
  {
    const d = R.decideAsIsApply({ read: confident(430000), fileAsIs: null, purchasePrice: 450000 });
    assert(d.apply && d.kind === 'filled', 'a blank As-Is is filled');
  }
  {
    const d = R.decideAsIsApply({ read: confident(460000), fileAsIs: 400000, purchasePrice: 450000 });
    assert(!d.apply && d.why === 'not_below_price', 'at or above the purchase price → never written');
  }
  {
    const d = R.decideAsIsApply({ read: confident(440000), fileAsIs: 400000, purchasePrice: 450000 });
    assert(!d.apply && d.why === 'not_a_reduction', 'a HIGHER value than the file already shows is never written (leverage can only go down)');
  }
  {
    const d = R.decideAsIsApply({ read: confident(430000), fileAsIs: 430000, purchasePrice: 450000 });
    assert(!d.apply && d.why === 'not_a_reduction', 'the same value is not rewritten');
  }
  {
    const d = R.decideAsIsApply({ read: { found: true, value: 430000, confident: false, confidence: 'low' }, fileAsIs: 500000, purchasePrice: 450000 });
    assert(!d.apply && d.why === 'not_confident', 'a NOT-confident reading is never written');
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
    const d = R.decideAsIsApply({ read: confident(430000), fileAsIs: 500000, purchasePrice: null });
    assert(!d.apply && d.why === 'no_purchase_price', 'with no purchase price the rule cannot be evaluated, so nothing is written');
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
    assert(/not below the purchase price/i.test(note) && /nothing on the file was changed/i.test(note),
      'a read that does not meet the rule says plainly that nothing was changed, and why');
  }

  console.log(failures ? `\n${failures} assertion(s) FAILED` : '\nALL As-Is reader assertions passed');
  process.exit(failures ? 1 : 0);
})();
