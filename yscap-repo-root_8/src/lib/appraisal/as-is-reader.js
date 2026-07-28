'use strict';
/**
 * THE As-Is READER — the ONE place that answers "what does this appraisal say the As-Is value is?"
 * (owner-directed 2026-07-28).
 *
 * The owner's flow, in their words: *"a lot of times you can find as is value as well on top of the
 * ARV value in the XML so that should be perfect — but if you can't find it in XML … use the
 * strongest OCR and AI to find the as is value; a lot of times it's a note on the appraisal report,
 * it's not even part of the data."*  So the read is a SOURCE LADDER, cheapest-and-most-certain first:
 *
 *   1. XML  — the MISMO data file. When the extractor already resolved a DEFINITE As-Is
 *             (`_CONDITION_OF_APPRAISAL=AsIs` with no hypothetical-completion language → the
 *             structured `PropertyAppraisedValueAmount` IS the As-Is; or an As-Is figure mined out of
 *             the narrative attributes) we are done. Nothing beats the data file, and it costs $0.
 *             Which XMLs carry it and which never do is documented in
 *             docs/appraisal-xml/as-is-value-sources.md.
 *   2. PDF, read by the STRONGEST OCR available (ai/ocr-router: Azure Document Intelligence →
 *      Google Document AI → Mistral, with the legacy OCR.space reader as the last resort) and then
 *      searched deterministically — literally the owner's "click Control F on the PDF and look for
 *      the As is value".
 *   3. AI, as a LOCATOR over that same OCR text — it must hand back a VERBATIM quote, which the
 *      deterministic scanner then re-reads. The AI can point at a line our line-by-line scan missed
 *      (an OCR page break between the label and the amount); it can never invent a number, because
 *      a value is only accepted when the scanner independently reads the same amount out of the
 *      quote the AI returned, and the quote must actually exist in the OCR text.
 *
 * NEVER GUESSES. Every candidate is sanity-bounded, ARV-checked (an "As-Is" above the ARV means we
 * grabbed the wrong number), and only a value we can call CONFIDENT is ever eligible to touch the
 * loan file. Anything less is reported as a candidate for a human, exactly as before.
 *
 * PURE ORCHESTRATION: no database, no config reads at module scope, every IO dependency injected
 * (defaults wired to the real modules) so the whole ladder unit-tests with stubs and no network.
 * Never throws — every failure mode returns a structured, explainable result.
 */

// ---------------------------------------------------------------------------
// Money / plausibility primitives
// ---------------------------------------------------------------------------

// A real US residential appraisal value. Below this a "value" is a fee, a rent, or a page number;
// above it we are reading a portfolio total, not a house.
const MIN_VALUE = 10000;
const MAX_VALUE = 100000000;

// A dollar amount MUST carry a currency signal — a `$` OR thousands grouping (how appraisal dollars
// are virtually always written). A bare run of digits is NOT money, so a zip (90210), an APN, a
// phone or a reference number sitting on an "as is" line can never be misread as a value.
const MONEY_SRC = '\\$\\s?\\d{1,3}(?:,\\d{3})+(?:\\.\\d{2})?|\\$\\s?\\d{4,8}(?:\\.\\d{2})?|\\d{1,3}(?:,\\d{3})+(?:\\.\\d{2})?';
const MONEY_G = new RegExp(MONEY_SRC, 'g');
// A separate NON-global twin for `.test()`. A global regex carries `lastIndex` across calls, so
// testing with MONEY_G would leave it mid-string and make the NEXT scan silently skip text.
const MONEY_TEST = new RegExp(MONEY_SRC);

// Whole-line language that means the sentence is about the AFTER-REPAIR value, not the As-Is.
const ARV_LINE = /as[\s-]*repaired|as[\s-]*complete|subject[\s-]*to|after[\s-]*repair|upon\s+completion|hypothetical|prospective/i;
// After-repair synonyms that LABEL the amount that follows them, inside a line that also says "as is".
const ARV_LABEL = /renovated|stabiliz|as[\s-]*complet|as[\s-]*improv|after\s+renovation|\barv\b/i;

function toAmount(tok) {
  const n = Number(String(tok).replace(/[$,\s]/g, ''));
  return Number.isFinite(n) ? n : null;
}

function plausible(n) { return n != null && n >= MIN_VALUE && n <= MAX_VALUE; }

/**
 * Scan ONE line of text for an As-Is amount.
 * Returns { amount, strength, snippet } or null.
 *
 *   strength 'labeled' — the amount FOLLOWS the "as is" token ("As-Is Value: $312,500",
 *                        "the as is value is $430,000"). This is the near-universal phrasing and the
 *                        only strength strong enough to stand on its own.
 *   strength 'near'    — the amount sits BEFORE the token on the same line. Real, but weaker: an ARV
 *                        printed to the left of the words "as is" reads the same way, so a 'near'
 *                        hit alone is never treated as confident.
 */
function scanLine(raw) {
  const ln = String(raw || '').replace(/ /g, ' ').trim();
  if (!ln) return null;
  const tok = /as[\s-]*is/i.exec(ln);
  if (!tok) return null;
  // "as is" must be a real word start — otherwise it false-matches inside "basis" / "gas is" and
  // could mine a fabricated value (the same guard extract.js applies to the XML narrative sweep).
  if (tok.index > 0 && /[a-z]/i.test(ln[tok.index - 1])) return null;
  if (ARV_LINE.test(ln)) return null;              // the whole line speaks to the after-repair value
  const asIdx = tok.index, tokEnd = asIdx + tok[0].length;

  let best = null, bestDist = Infinity;
  let prevEnd = 0;                                  // end of the previous money token on this line
  for (const m of ln.matchAll(MONEY_G)) {
    const mi = m.index, mEnd = mi + m[0].length;
    // The ARV-synonym window is the segment SINCE THE PREVIOUS AMOUNT — bounded to this amount's own
    // segment so a synonym labelling an EARLIER amount can't bleed onto this one.
    const pre = ln.slice(prevEnd, mi);
    prevEnd = mEnd;
    const n = toAmount(m[0]);
    if (!plausible(n)) continue;
    if (ARV_LABEL.test(pre)) continue;              // this amount is labelled as the after-repair value
    // Prefer the amount that FOLLOWS the token, and heavily penalise one that precedes it.
    const follows = mi >= tokEnd;
    const dist = follows ? (mi - tokEnd) : (asIdx - mEnd) + 1000;
    if (dist < bestDist) {
      bestDist = dist;
      // A FOLLOWING amount counts as 'labeled' only while it is still in the SAME CLAUSE as the "as
      // is" wording: no sentence break between them, and not the far end of a paragraph. Both halves
      // matter. Too tight and the ordinary phrasing "the 'as is' market value of the subject property
      // is $430,000" (41 characters of filler) is demoted to a weak hit and a perfectly readable
      // appraisal needs a human; too loose and a number in the NEXT sentence gets labelled as the
      // as-is. A sentence boundary is the honest line, because that is where the subject changes.
      const gap = follows ? ln.slice(tokEnd, mi) : '';
      const sameClause = follows && gap.length <= 80 && !/[.;!?]\s/.test(gap);
      best = { amount: n, strength: sameClause ? 'labeled' : 'near', snippet: ln.slice(0, 220) };
    }
  }
  return best;
}

/**
 * Ctrl-F the whole document. Two passes:
 *   A. line by line (what a person pressing Ctrl-F sees);
 *   B. every ADJACENT LINE PAIR joined — an OCR page/column break routinely lands between the label
 *      and the amount ("As-Is Value:" / "$312,500"), which a line-only scan can never see. Only a
 *      'labeled' hit whose amount comes from the SECOND line is taken from pass B (anything else is
 *      already covered by pass A, and a joined pair would otherwise double-count).
 *
 * @returns {{hits:Array<{amount:number,strength:string,snippet:string,line:number}>, labeled:number[], near:number[]}}
 */
function scanAsIs(text) {
  const lines = String(text || '').replace(/ /g, ' ').split(/[\n\r]+/);
  const hits = [];
  for (let i = 0; i < lines.length; i++) {
    const h = scanLine(lines[i]);
    if (h) hits.push({ ...h, line: i });
  }
  for (let i = 0; i + 1 < lines.length; i++) {
    const a = String(lines[i] || '').trim(), b = String(lines[i + 1] || '').trim();
    if (!a || !b) continue;
    // Only worth joining when the label is on the first line and the amount is not.
    if (!/as[\s-]*is/i.test(a)) continue;
    if (MONEY_TEST.test(a)) continue;
    const joined = `${a} ${b}`;
    const h = scanLine(joined);
    if (h && h.strength === 'labeled') hits.push({ ...h, strength: 'labeled', snippet: joined.slice(0, 220), line: i, wrapped: true });
  }
  const uniq = (s) => [...new Set(hits.filter((h) => h.strength === s).map((h) => h.amount))];
  return { hits, labeled: uniq('labeled'), near: uniq('near') };
}

// ---------------------------------------------------------------------------
// The AI locator (step 3)
// ---------------------------------------------------------------------------

const AI_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    found: { type: 'boolean' },
    value: { type: ['number', 'null'] },
    quote: { type: ['string', 'null'] },
    reason: { type: 'string' },
  },
  required: ['found', 'value', 'quote', 'reason'],
};

const AI_SYSTEM = 'You locate ONE number in an appraisal report: the appraiser\'s opinion of the '
  + 'AS-IS market value of the subject property in its CURRENT condition. Never guess. If the report '
  + 'only states an after-repair / as-completed / subject-to value, answer found=false.';

const AI_INSTRUCTION = `Below is the OCR text of a residential appraisal report.

Find the AS-IS value — the appraiser's opinion of value of the property in its CURRENT, present
condition. It is often written as "as is", "as-is value", "'as is' market value", and on renovation
reports it frequently appears only as a sentence or a note in the addendum/reconciliation rather
than in a labelled box.

Do NOT return the after-repair value (also written as: as repaired, ARV, as completed, subject to
completion, subject to repairs, upon completion, hypothetical condition) — that is a different
number and returning it would be a serious error.

Return the amount as a plain number (no $ or commas) and, in "quote", the EXACT text you read it
from, copied VERBATIM from the text below (one or two lines, including both the wording and the
amount). If you cannot find an as-is value, return found=false with value=null and quote=null.`;

// Normalize for a substring check that survives OCR whitespace/line-break noise.
const squash = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * Ask the analyzer to LOCATE the As-Is, then VERIFY its answer against the OCR text.
 * A value survives only when (a) the quote really appears in the OCR text, and (b) our own
 * deterministic scanner reads the SAME amount out of that quote. So the AI can point us at a line we
 * missed, but it can never introduce a number the text does not label as the As-Is.
 * Never throws.
 */
async function aiLocate(text, deps = {}) {
  const analyzer = deps.analyzer;
  if (!analyzer || typeof analyzer.available !== 'function' || !analyzer.available()) {
    return { ok: false, reason: 'the AI reader is not configured' };
  }
  let r;
  try {
    r = await analyzer.extract({
      system: AI_SYSTEM,
      instructions: AI_INSTRUCTION,
      schema: AI_SCHEMA,
      ocrText: text,
      ocrCharLimit: 120000,
      maxTokens: 900,
      traceMeta: { opName: 'appraisal-as-is-locate' },
    });
  } catch (e) { return { ok: false, reason: `the AI reader failed (${e && e.message})` }; }
  if (!r || !r.ok || !r.data) return { ok: false, reason: (r && r.reason) || 'the AI reader returned nothing' };
  const d = r.data;
  if (!d.found || d.value == null) return { ok: true, found: false, reason: d.reason || 'the AI reader found no as-is value' };

  const value = Number(d.value);
  if (!plausible(value)) return { ok: true, found: false, reason: 'the AI reader returned an implausible amount' };

  const quote = String(d.quote || '');
  const hay = squash(text), needle = squash(quote);
  // GROUNDING GATE 1 — the quote must genuinely be in the document we read.
  if (!needle || needle.length < 8 || !hay.includes(needle)) {
    return { ok: true, found: false, grounded: false, value, quote, reason: 'the AI reader\'s quote could not be found in the report text' };
  }
  // GROUNDING GATE 2 — our own scanner must read the same As-Is amount out of that quote.
  const scan = scanAsIs(quote);
  const confirmed = scan.labeled.includes(value) || scan.near.includes(value);
  if (!confirmed) {
    return { ok: true, found: false, grounded: false, value, quote, reason: 'the AI reader\'s quote does not read as an as-is value' };
  }
  return { ok: true, found: true, grounded: true, value, quote, labeled: scan.labeled.includes(value), reason: d.reason || null };
}

// ---------------------------------------------------------------------------
// Reading the PDF text with the strongest reader available
// ---------------------------------------------------------------------------

/**
 * @returns {Promise<{ok:boolean, text?:string, engine?:string, pageCount?:number, reason?:string}>}
 */
async function readPdfText({ pdfBuffer, pdfBase64 }, deps = {}) {
  const router = deps.ocrRouter;
  const legacy = deps.legacyOcr;
  const attempts = [];

  if (router && typeof router.configured === 'function' && router.configured()) {
    try {
      const r = await router.read({ buffer: pdfBuffer || undefined, base64: pdfBuffer ? undefined : pdfBase64, mimeType: 'application/pdf' });
      if (r && r.ok && String(r.text || '').trim()) {
        return { ok: true, text: String(r.text), engine: r.engine || 'ocr-router', pageCount: r.pageCount || null, attempts };
      }
      attempts.push({ engine: (r && r.engine) || 'ocr-router', ok: false, reason: (r && r.reason) || 'the reader returned no text' });
    } catch (e) { attempts.push({ engine: 'ocr-router', ok: false, reason: e && e.message }); }
  } else {
    attempts.push({ engine: 'ocr-router', ok: false, reason: 'not configured' });
  }

  // Last resort: the small-PDF hosted reader that predates the router. Real appraisal PDFs are
  // usually far over its ~1 MB ceiling, so this rarely fires — but on a small report it still works
  // and costs nothing extra.
  if (legacy && typeof legacy.ocrSpaceText === 'function' && pdfBase64) {
    try {
      const r = await legacy.ocrSpaceText(pdfBase64);
      if (r && r.ok && String(r.text || '').trim()) return { ok: true, text: String(r.text), engine: 'ocr-space', pageCount: null, attempts };
      attempts.push({ engine: 'ocr-space', ok: false, reason: (r && r.reason) || 'no text' });
    } catch (e) { attempts.push({ engine: 'ocr-space', ok: false, reason: e && e.message }); }
  }

  const why = attempts.map((a) => `${a.engine}: ${a.reason}`).join('; ');
  return { ok: false, reason: why || 'no document reader is available', attempts };
}

// ---------------------------------------------------------------------------
// The ladder
// ---------------------------------------------------------------------------

/**
 * Resolve the As-Is value for one appraisal.
 *
 * @param {object} args
 *   xmlAsIs, xmlAsIsConfidence  what extract() already resolved from the MISMO data file
 *   pdfBuffer | pdfBase64       the appraisal report PDF (optional — no PDF just means no step 2/3)
 *   arv                         the appraisal's ARV, when known (sanity ceiling)
 * @param {{ocrRouter?, legacyOcr?, analyzer?}} deps  injectable; defaults are the real modules
 * @returns {Promise<{found:boolean, value:number|null, source:string|null, confidence:string|null,
 *                    confident:boolean, quote:string|null, engine:string|null, candidates:number[],
 *                    reason:string|null, steps:Array}>}
 */
async function readAsIs(args = {}, deps = {}) {
  const d = {
    ocrRouter: deps.ocrRouter !== undefined ? deps.ocrRouter : require('../ai/ocr-router'),
    legacyOcr: deps.legacyOcr !== undefined ? deps.legacyOcr : require('./ocr'),
    analyzer: deps.analyzer !== undefined ? deps.analyzer : require('../ai/azure-openai'),
  };
  const out = {
    found: false, value: null, source: null, confidence: null, confident: false,
    quote: null, engine: null, candidates: [], reason: null, steps: [],
  };
  const arv = Number.isFinite(Number(args.arv)) && Number(args.arv) > 0 ? Number(args.arv) : null;

  // ---- 1. the XML data file ------------------------------------------------
  const xmlVal = Number(args.xmlAsIs);
  if (args.xmlAsIs != null && Number.isFinite(xmlVal) && args.xmlAsIsConfidence === 'definite' && plausible(xmlVal)) {
    out.steps.push({ step: 'xml', ok: true, value: xmlVal });
    return { ...out, found: true, value: xmlVal, source: 'xml', confidence: 'definite', confident: true, candidates: [xmlVal] };
  }
  out.steps.push({ step: 'xml', ok: false, reason: 'the appraisal data file does not state a definite as-is value' });

  // ---- 2. the PDF, read by the strongest OCR we have ------------------------
  if (!args.pdfBuffer && !args.pdfBase64) {
    out.reason = 'the appraisal data file does not state an as-is value and no appraisal PDF was available to read';
    out.steps.push({ step: 'pdf', ok: false, reason: 'no PDF' });
    return out;
  }
  const read = await readPdfText(args, d);
  if (!read.ok) {
    out.reason = `the appraisal PDF could not be read (${read.reason})`;
    out.steps.push({ step: 'pdf', ok: false, reason: read.reason });
    return out;
  }
  out.engine = read.engine;
  out.steps.push({ step: 'pdf', ok: true, engine: read.engine, pageCount: read.pageCount || null, chars: read.text.length });

  const scan = scanAsIs(read.text);
  // Sanity-filter EVERY candidate before it can influence the verdict: an "As-Is" at or above the
  // ARV is the ARV misread, not an as-is opinion.
  const ok = (n) => plausible(n) && (arv == null || n < arv);
  const labeled = scan.labeled.filter(ok);
  const near = scan.near.filter(ok);
  out.candidates = [...new Set([...labeled, ...near])].sort((a, b) => a - b);
  out.steps.push({ step: 'ctrl_f', ok: true, labeled, near, dropped: [...scan.labeled, ...scan.near].filter((n) => !ok(n)) });

  const snippetFor = (amount) => {
    const h = scan.hits.find((x) => x.amount === amount);
    return h ? h.snippet : null;
  };

  // ---- 3. the AI locator, over the SAME text -------------------------------
  // Worth asking whenever the deterministic pass did not land a single unambiguous labelled hit —
  // that is exactly the "it's only a note in the addendum" / "the label and the amount got split
  // across a page break" case the owner described. It is also cheap insurance when the scan is
  // clean, so we skip it there to keep the spend down.
  let ai = null;
  const deterministicClean = labeled.length === 1 && near.every((n) => n === labeled[0]);
  if (!deterministicClean && args.useAi !== false) {
    ai = await aiLocate(read.text, d);
    out.steps.push({ step: 'ai', ok: !!(ai && ai.ok), found: !!(ai && ai.found), value: (ai && ai.value) || null, reason: (ai && ai.reason) || null });
    if (ai && ai.found && !ok(ai.value)) {
      out.steps.push({ step: 'ai_sanity', ok: false, reason: 'the AI reader\'s amount is above the ARV or out of range' });
      ai = { ...ai, found: false, reason: 'the amount is above the ARV or out of range' };
    }
  }

  // ---- verdict -------------------------------------------------------------
  if (deterministicClean) {
    return { ...out, found: true, value: labeled[0], source: 'pdf_text', confidence: 'high', confident: true, quote: snippetFor(labeled[0]) };
  }
  if (ai && ai.found) {
    const corroborated = labeled.includes(ai.value) || near.includes(ai.value);
    // The AI's own quote re-read as a LABELLED as-is by our scanner is itself corroboration — that is
    // the page-break case, where the whole-document line scan could never have seen it.
    const selfLabeled = !!ai.labeled;
    if (corroborated || selfLabeled) {
      return {
        ...out, found: true, value: ai.value, source: corroborated ? 'pdf_text' : 'pdf_ai',
        confidence: 'high', confident: true, quote: ai.quote || snippetFor(ai.value),
      };
    }
    return {
      ...out, found: true, value: ai.value, source: 'pdf_ai', confidence: 'low', confident: false,
      quote: ai.quote, candidates: [...new Set([...out.candidates, ai.value])].sort((a, b) => a - b),
      reason: 'the AI reader suggested an as-is value but nothing else in the report confirmed it',
    };
  }
  if (labeled.length === 1) {
    // One labelled hit, with a DIFFERENT loose amount also sitting near "as is" wording somewhere in
    // the report. Report it — but a human decides, because two numbers are in play.
    return {
      ...out, found: true, value: labeled[0], source: 'pdf_text', confidence: 'low', confident: false,
      quote: snippetFor(labeled[0]),
      reason: 'more than one amount appears near "as is" wording in the report, so the reading is not certain',
    };
  }
  if (labeled.length > 1) {
    return {
      ...out, found: true, value: labeled[0], source: 'pdf_text', confidence: 'low', confident: false,
      quote: snippetFor(labeled[0]),
      reason: 'the report states more than one "as is" amount, so the reading is not certain',
    };
  }
  if (near.length === 1) {
    return {
      ...out, found: true, value: near[0], source: 'pdf_text', confidence: 'low', confident: false,
      quote: snippetFor(near[0]),
      reason: 'an amount appears beside "as is" wording but the report does not label it as the as-is value',
    };
  }
  if (near.length > 1) {
    return {
      ...out, found: true, value: near[0], source: 'pdf_text', confidence: 'low', confident: false,
      quote: snippetFor(near[0]),
      reason: 'several amounts appear beside "as is" wording, so the reading is not certain',
    };
  }
  out.reason = 'no as-is value could be read from the appraisal report';
  return out;
}

// ---------------------------------------------------------------------------
// The owner's rule — may this reading be written onto the loan file?
// ---------------------------------------------------------------------------

/**
 * PURE. Decides whether a reading may be applied to `applications.as_is_value`.
 *
 * The owner's rule (2026-07-28): *"if he's confident that he found that as is value AND the as is
 * value is less than the final purchase price he should overwrite the as is value in the file and
 * post the condition that he REDUCED the asset's value."*
 *
 * Two guards are ours, and both exist so an automatic write can only ever be the CAUTIOUS direction:
 *   • REDUCTION ONLY — a reading is never written over a HIGHER human value. Writing a bigger As-Is
 *     off a machine read would raise leverage (As-Is drives the As-Is LTV and LTC caps) on the
 *     strength of an OCR pass, which is the opposite of what "he reduced the asset's value" means.
 *     A blank As-Is is still filled — there is nothing to raise.
 *   • THE FILE MUST NOT BE FROZEN — a term-sheet-sent / clear-to-close / funded file has its
 *     economics locked for everyone (src/lib/file-lock.js). PILOT does not get a private door
 *     through that; on a frozen file the reading is recorded and the condition explains it so a
 *     human decides.
 *
 * @returns {{apply:boolean, value:number|null, kind:'reduced'|'filled'|'none', why:string}}
 */
function decideAsIsApply({ read, fileAsIs, purchasePrice, lockReason = null, autoEnabled = true } = {}) {
  const none = (why) => ({ apply: false, value: null, kind: 'none', why });
  if (!read || !read.found || read.value == null) return none('no_value');
  if (!autoEnabled) return none('auto_off');
  if (!read.confident) return none('not_confident');

  const v = Number(read.value);
  if (!plausible(v)) return none('implausible');

  const pp = Number(purchasePrice);
  if (!Number.isFinite(pp) || pp <= 0) return none('no_purchase_price');
  if (!(v < pp)) return none('not_below_price');

  const cur = fileAsIs == null || fileAsIs === '' ? null : Number(fileAsIs);
  if (cur != null && Number.isFinite(cur) && !(v < cur)) return none('not_a_reduction');

  if (lockReason) return none('file_locked');

  return { apply: true, value: v, kind: cur == null ? 'filled' : 'reduced', why: 'ok' };
}

// ---------------------------------------------------------------------------
// The wording an officer reads on the condition
// ---------------------------------------------------------------------------

const money = (n) => (n == null || !Number.isFinite(Number(n)) ? '—' : '$' + Number(n).toLocaleString('en-US'));

const SOURCE_WORDS = {
  xml: 'the appraisal data file (XML)',
  pdf_text: 'the appraisal report PDF (read with OCR)',
  pdf_ai: 'the appraisal report PDF (read with OCR, located by AI)',
};

/**
 * PURE. The `[auto]` note that goes on the "Verify As-Is value" condition. Plain language — this is
 * read by staff, not developers — and it always says (a) what PILOT did, (b) what the numbers are,
 * and (c) that a human can re-review and overwrite it.
 */
function buildAsIsNote({ read, decision, fileAsIsBefore, purchasePrice } = {}) {
  // `[auto]` marks the note as system-written so a re-read never clobbers a note an officer typed
  // (every write guards on `notes IS NULL OR notes LIKE '[auto]%'`).
  const P = '[auto] ';
  const r = read || {}, dec = decision || {};
  const where = SOURCE_WORDS[r.source] || 'the appraisal';
  const quote = r.quote ? ` It was read from: “${String(r.quote).replace(/\s+/g, ' ').trim().slice(0, 220)}”.` : '';

  if (dec.apply) {
    const lead = dec.kind === 'reduced'
      ? `PILOT lowered the As-Is value on this file from ${money(fileAsIsBefore)} to ${money(dec.value)}.`
      : `PILOT set the As-Is value on this file to ${money(dec.value)}.`;
    return `${P}${lead} It read that value from ${where}, and it is below the purchase price of ${money(purchasePrice)}.${quote}`
      + ' The loan has to be re-priced on the lower value, so the Products & Pricing condition has reopened.'
      + ' Please re-review this against the appraisal report: if PILOT read it wrong, type the correct As-Is value in the box on this condition and it will replace what PILOT entered.'
      + ' Sign this condition off once you have confirmed the As-Is value is right.';
  }

  if (r.found && r.value != null) {
    const why = {
      not_below_price: `it is not below the purchase price of ${money(purchasePrice)}, so nothing on the file was changed`,
      not_a_reduction: `the file already shows a lower As-Is value (${money(fileAsIsBefore)}), so nothing was changed`,
      file_locked: 'this file\'s figures are locked (the term sheet has gone out, or the file is clear-to-close / funded), so nothing was changed automatically',
      not_confident: 'PILOT is NOT confident enough in that reading to use it, so nothing on the file was changed',
      auto_off: 'the automatic As-Is update is switched off, so nothing on the file was changed',
      no_purchase_price: 'there is no purchase price on the file to compare it against, so nothing was changed',
      implausible: 'the amount does not look like a property value, so nothing was changed',
      value_changed_underneath: 'the As-Is value on the file changed while PILOT was reading, so it did not overwrite it',
      no_value: 'nothing on the file was changed',
    }[dec.why] || 'nothing on the file was changed';
    const extra = r.reason ? ` (${r.reason})` : '';
    return `${P}PILOT read a possible As-Is value of ${money(r.value)} from ${where}${extra}, but ${why}.${quote}`
      + ' Please confirm the As-Is value against the appraisal report and, if it needs changing, type it in the box on this condition.';
  }

  return `${P}PILOT could not confidently read the As-Is value — it checked the appraisal data file and then read the appraisal report PDF with OCR${r.engine ? ` (${r.engine})` : ''} and AI.`
    + `${r.reason ? ` ${r.reason.charAt(0).toUpperCase()}${r.reason.slice(1)}.` : ''}`
    + ' Nothing has been filled in automatically — a value is never guessed.'
    + ' Please open the appraisal report, read the As-Is value, and type it in the box on this condition to clear this condition.';
}

/** PURE. The per-instance hint (the one-line "what is this condition about") for each state. */
function buildAsIsHint(decision) {
  if (decision && decision.apply) {
    return 'PILOT lowered this file\'s As-Is value from what it read on the appraisal. Re-review it against the report — you can overwrite it here — then sign off.';
  }
  return 'PILOT could not confidently read the As-Is value from the appraisal. Read it off the report and enter it here to clear this condition.';
}

module.exports = {
  readAsIs, decideAsIsApply, buildAsIsNote, buildAsIsHint,
  scanAsIs, scanLine, aiLocate, readPdfText,
  MIN_VALUE, MAX_VALUE,
};
