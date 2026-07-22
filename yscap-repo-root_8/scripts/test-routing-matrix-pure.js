'use strict';
/**
 * P1 — pure tests for the document-aware OCR routing matrix. Proves each signal
 * the owner named changes the plan: a numeric-critical document gets a MANDATORY
 * second reader; an appraisal with an XML sidecar reads the XML not OCR; a clean
 * digital PDF reads its native text layer; a table-dense document routes to the
 * table specialist; engine availability/health reorders the choice; weak pages
 * are surfaced for re-read; two reads that disagree on numbers are flagged. All
 * advisory — a plan, never an action.
 */
const assert = require('assert');
const rm = require('../src/lib/ai/routing-matrix');

let passed = 0;
const ok = (n) => { console.log(`  ok  ${n}`); passed++; };

const ALL = { availability: { azure: true, google: true, mistral: true } };

// --- a bank statement (numeric-critical, table-dense) gets Azure + a mandatory challenger ---
let p = rm.planRoute({ docType: 'bank_statement', mimeType: 'application/pdf', pageCount: 4, ...ALL });
assert.strictEqual(p.primary, 'azure', 'table-dense → Azure layout primary');
assert.ok(p.challenger && p.challenger !== 'azure', 'a different-engine challenger is chosen');
assert.ok(p.specialHandling.includes('mandatory_challenger'), 'numeric-critical forces a mandatory challenger');
assert.ok(p.specialHandling.includes('preserve_tables'));
assert.strictEqual(p.materiality, 'high');
assert.strictEqual(p.reread.confidenceFloor, rm.CONFIDENCE_FLOOR.high, 'high-materiality uses the strict floor');
ok('bank statement → Azure primary + mandatory challenger + table preservation + strict floor');

// --- an appraisal WITH an XML sidecar reads the XML, not OCR ---
p = rm.planRoute({ docType: 'appraisal', mimeType: 'application/pdf', pageCount: 30, appraisalXmlPresent: true, ...ALL });
assert.strictEqual(p.primary, 'appraisal_xml', 'appraisal XML present → parse the XML');
assert.ok(p.specialHandling.includes('prefer_appraisal_xml'));
assert.ok(p.challenger, 'still OCRs the PDF as a numeric cross-check');
ok('appraisal with XML sidecar → read the XML (exact), OCR the PDF as a cross-check');

// --- an appraisal WITHOUT XML falls back to OCR (table-dense) ---
p = rm.planRoute({ docType: 'appraisal', mimeType: 'application/pdf', pageCount: 30, appraisalXmlPresent: false, ...ALL });
assert.strictEqual(p.primary, 'azure', 'no XML → OCR, Azure for the comp grid tables');
assert.ok(p.specialHandling.includes('mandatory_challenger'));
ok('appraisal without XML → OCR path with a mandatory challenger');

// --- a clean digital-born PDF reads its native text layer ---
p = rm.planRoute({ docType: 'signed_application', mimeType: 'application/pdf', pageCount: 5, hasNativeText: true, nativeTextChars: 5 * 800, ...ALL });
assert.strictEqual(p.primary, 'native_pdf', 'dense clean native text → read it directly');
assert.ok(p.specialHandling.includes('prefer_native_text'));
assert.strictEqual(p.reread.enabled, false, 'native text needs no page re-read');
ok('clean digital PDF → read the native text layer directly (skip OCR)');

// --- a numeric-critical native PDF still gets one OCR challenger (a doctored layer) ---
p = rm.planRoute({ docType: 'settlement', mimeType: 'application/pdf', pageCount: 3, hasNativeText: true, nativeTextChars: 3 * 900, ...ALL });
assert.strictEqual(p.primary, 'native_pdf');
assert.ok(p.challenger, 'numeric-critical → one OCR pass challenges the native layer');
ok('numeric-critical native PDF → native text primary + one OCR challenger');

// --- a SCANNED PDF (low native text) does NOT use the native layer ---
p = rm.planRoute({ docType: 'bank_statement', mimeType: 'application/pdf', pageCount: 4, hasNativeText: true, nativeTextChars: 30, ...ALL });
assert.strictEqual(p.primary, 'azure', 'thin native text = a scan → OCR');
ok('scanned PDF with a near-empty text layer → OCR, not native text');

// --- a scan-quality flag also blocks the native-text shortcut ---
p = rm.planRoute({ docType: 'signed_application', mimeType: 'application/pdf', pageCount: 5, hasNativeText: true, nativeTextChars: 5 * 800, scanQuality: { lowQualityPages: 2 }, ...ALL });
assert.notStrictEqual(p.primary, 'native_pdf', 'low-quality pages → do not trust the native layer');
ok('a low-quality-pages flag blocks the native-text shortcut');

// --- an image (no native text) always OCRs ---
p = rm.planRoute({ docType: 'government_id', mimeType: 'image/jpeg', hasNativeText: true, nativeTextChars: 99999, ...ALL });
assert.notStrictEqual(p.primary, 'native_pdf', 'an image has no native text layer');
ok('an image → OCR (native-text flag ignored for non-PDF)');

// --- availability: Azure down → the table primary falls to the next engine ---
p = rm.planRoute({ docType: 'bank_statement', pageCount: 4, availability: { azure: false, google: true, mistral: true } });
assert.notStrictEqual(p.primary, 'azure', 'Azure unavailable → not chosen');
assert.strictEqual(p.primary, 'google');
ok('Azure unavailable → primary falls through to the next configured engine');

// --- provider health: a failing engine is deprioritized ---
p = rm.planRoute({ docType: 'good_standing', pageCount: 1, availability: { azure: true, google: true, mistral: true }, providerHealth: { azure: false } });
assert.notStrictEqual(p.primary, 'azure', 'an unhealthy engine is deprioritized');
ok('a recently-failing engine is deprioritized in favor of a healthy one');

// --- weak pages: only pages below the floor are surfaced for re-read ---
const weak = rm.weakPages([
  { pageNumber: 1, confidence: 0.95 },
  { pageNumber: 2, confidence: 0.40 },
  { pageNumber: 3, words: [{ confidence: 0.5 }, { confidence: 0.5 }] }, // mean 0.5 < floor
  { pageNumber: 4 }, // no signal → not weak
], 0.8);
assert.deepStrictEqual(weak, [2, 3], 'pages 2 and 3 are below the floor; 1 is fine; 4 has no signal');
ok('weakPages surfaces only low-confidence pages for a targeted re-read');

// --- numeric reconciliation: two reads that disagree on a number are flagged ---
let rec = rm.reconcileNumbers('Loan amount $187,500 rate 10.99', 'Loan amount $187,500 rate 10.99');
assert.strictEqual(rec.disagreement, false, 'identical numbers agree');
rec = rm.reconcileNumbers('ending balance $42,318.55', 'ending balance $42,313.55');
assert.strictEqual(rec.disagreement, true, 'a one-digit misread is a disagreement');
assert.ok(rec.onlyInPrimary.includes(42318.55));
assert.ok(rec.onlyInChallenger.includes(42313.55));
ok('reconcileNumbers flags a numeric disagreement between two independent reads');

// --- an unknown document family gets the safe default profile ---
p = rm.planRoute({ docType: 'something_new', pageCount: 2, ...ALL });
assert.strictEqual(p.materiality, 'medium');
assert.strictEqual(p.numericCritical, false);
assert.strictEqual(p.reread.enabled, true);
ok('an unknown family falls back to the safe default profile (medium, OCR, reread on)');

// --- no docType at all: still a valid OCR plan (backward-compatible) ---
p = rm.planRoute({ pageCount: 1, ...ALL });
assert.ok(p.primary, 'always returns a usable primary');
assert.ok(Array.isArray(p.fallbacks));
ok('no document family → a valid default OCR plan (never throws, never empty)');

console.log(`\nP1 routing-matrix pure — ${passed} checks passed`);
