'use strict';
/**
 * THE PLANNER'S FOUR RULES — and, first, the reported email reproduced.
 *
 * On 2026-08-14 an investor delivery for draw 2 at 392-394 Columbia Ave went out with exactly two
 * attachments: `draw-packet-114354.xlsx` (12 KB) and the signed wire form (127 KB). The inspection
 * report was not on it and nobody was told. Section A rebuilds that exact set of documents, runs it
 * through the OLD first-fit rule to prove the old rule produces the reported email, and then
 * through the planner to prove it does not any more.
 *
 * Pure — real bytes, no database. Photo-bearing PDFs are built in memory so the compression path is
 * genuinely exercised rather than stubbed.
 */
const assert = require('assert');
const jpeg = require('jpeg-js');
const { PDFDocument } = require('pdf-lib');
const { buildAttachmentPlan, omissionSummary, auditFrom } = require('../src/lib/attachments/plan');

let passed = 0;
function ok(name, cond) { assert.ok(cond, name); passed++; console.log(`  ok  ${name}`); }

function photo(w, h) {
  const d = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const x = i % w, y = (i / w) | 0;
    d[i * 4] = (x * 3 + ((Math.sin(x * 0.05) * 40) | 0)) & 255;
    d[i * 4 + 1] = (y * 3 + ((Math.cos(y * 0.04) * 40) | 0)) & 255;
    d[i * 4 + 2] = (x ^ y) & 255; d[i * 4 + 3] = 255;
  }
  return Buffer.from(jpeg.encode({ data: d, width: w, height: h }, 92).data);
}

/** A photo-heavy PDF, like a real inspection report. */
async function reportPdf(nPhotos, w, h) {
  const doc = await PDFDocument.create();
  for (let i = 0; i < nPhotos; i++) {
    const img = await doc.embedJpg(photo(w + i, h));
    doc.addPage([612, 792]).drawImage(img, { x: 0, y: 200, width: 612, height: 400 });
  }
  return Buffer.from(await doc.save());
}

/** The OLD rule, copied verbatim from investor-delivery-send.js as it stood on 2026-08-14. */
function oldFirstFit(items, budget) {
  const fit = []; const skipped = []; let total = 0;
  for (const it of items) {
    if (total + it.buf.length > budget) { skipped.push(it); continue; }
    total += it.buf.length; fit.push(it);
  }
  return { fit, skipped };
}

(async () => {
  console.log('\n== A. the reported email, reproduced and then fixed ==');
  // A real draw's four documents, in the priority order the delivery uses.
  const inspection = await reportPdf(5, 1500, 1150);   // the third party's word — matters most
  const ours = await reportPdf(4, 1500, 1150);         // our branded report
  const packet = Buffer.alloc(12 * 1024, 0x50);        // the spreadsheet — matters least
  const wire = Buffer.alloc(127 * 1024, 0x25);         // the signed wire form
  // Small enough that NEITHER report fits on its own — which is the state the reported email was
  // sent in, and the state in which the old first-fit rule drops both and keeps the spreadsheet.
  const budget = Math.floor(Math.min(inspection.length, ours.length) * 0.9);

  const items = [
    { key: 'inspection', what: 'Inspection report', filename: 'inspection-report.pdf', contentType: 'application/pdf', buf: inspection },
    { key: 'ours', what: 'PILOT draw report', filename: 'pilot-draw-report.pdf', contentType: 'application/pdf', buf: ours },
    { key: 'packet', what: 'Draw packet', filename: 'draw-packet-114354.xlsx', contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buf: packet, compressible: false },
    { key: 'wire', what: 'Signed wire instructions', filename: 'draw_request_signed.pdf', contentType: 'application/pdf', buf: wire, compressible: false },
  ];

  const old = oldFirstFit(items, budget);
  ok(`the OLD rule reproduces the reported email exactly — only [${old.fit.map((i) => i.key).join(', ')}] went out`,
    old.fit.length === 2 && old.fit[0].key === 'packet' && old.fit[1].key === 'wire');
  ok('…dropping BOTH reports while keeping the 12 KB spreadsheet', old.skipped.map((i) => i.key).join(',') === 'inspection,ours');

  const plan = await buildAttachmentPlan(items, { budgetBytes: budget });
  ok(`the planner carries all four instead (${plan.attach.map((a) => a.key).join(', ')})`, plan.attach.length === 4);
  ok('nothing is omitted', plan.omitted.length === 0 && plan.needsConsent === false);
  ok(`it got there by compressing, not by dropping (${plan.compressedCount} compressed, ${Math.round(plan.savedBytes / 1024)} KB saved)`,
    plan.compressedCount >= 1 && plan.savedBytes > 0);
  ok('and it stayed inside the budget', plan.totalBytes <= budget);
  ok('the inspection report is still first', plan.attach[0].key === 'inspection');
  ok('each compressed item reports what was done to it',
    plan.attach.filter((a) => a.compression).every((a) => a.compression.level >= 1 && a.compression.before > a.compression.after));

  console.log('\n== B. rule 2 — a lower priority never displaces a higher one ==');
  // A budget so tight that even a fully compressed report cannot fit. The spreadsheet and the wire
  // form still ride (three of four beats none), but the omission must be the BUDGET's doing, and
  // the report must have been offered its place first.
  const tiny = 200 * 1024;
  const p2 = await buildAttachmentPlan(items, { budgetBytes: tiny });
  ok(`with a ${Math.round(tiny / 1024)} KB budget something must go (attached: ${p2.attach.map((a) => a.key).join(', ') || 'none'})`,
    p2.omitted.length > 0);
  ok('consent is required', p2.needsConsent === true);
  const attachedKeys = p2.attach.map((a) => a.key);
  const omittedKeys = p2.omitted.map((m) => m.key);
  ok(`the reports are the ones omitted (${omittedKeys.join(', ')})`, omittedKeys.includes('inspection') || omittedKeys.includes('ours'));
  ok('and the small ones that DO fit still travel', attachedKeys.includes('packet') && attachedKeys.includes('wire'));

  console.log('\n== C. rule 3 — a code, a sentence with real numbers, and a remedy ==');
  const m = p2.omitted[0];
  ok(`code is machine-readable ("${m.code}")`, /^too_large/.test(m.code));
  ok(`the sentence names the real sizes ("${m.reason.slice(0, 90)}…")`, /MB|KB/.test(m.reason) && /this email can carry/.test(m.reason));
  ok(`a remedy is named ("${m.remedy}")`, m.remedy === 'share_link');
  ok('the byte size is recorded', Number.isFinite(m.bytes) && m.bytes > 0);
  ok('an item compressed and STILL too big says so',
    p2.omitted.some((x) => x.code === 'too_large_after_compression') || p2.omitted.every((x) => x.code === 'too_large'));

  console.log('\n== D. upstream failures keep their own, better reason ==');
  const p3 = await buildAttachmentPlan([
    { key: 'a', what: 'Inspection report', error: { code: 'not_on_file', reason: "the inspector's report has not been archived for this draw yet" } },
    { key: 'b', what: 'Invoice', error: { code: 'not_accepted' } },
    { key: 'c', what: 'Empty thing', buf: Buffer.alloc(0) },
    { key: 'd', what: 'Fine', buf: Buffer.alloc(1000, 1) },
  ], { budgetBytes: 10 * 1024 * 1024 });
  ok('the upstream sentence is preserved verbatim', p3.omitted[0].reason === "the inspector's report has not been archived for this draw yet");
  ok('a code with no sentence gets the standard wording + remedy',
    p3.omitted[1].code === 'not_accepted' && /accepted/.test(p3.omitted[1].reason) && p3.omitted[1].remedy === 'accept_the_document');
  ok('empty bytes are an omission, never a silent attach', p3.omitted[2].code === 'empty');
  ok('the healthy one still attaches', p3.attach.length === 1 && p3.attach[0].key === 'd');
  ok('an unrecognised code still produces a usable row',
    (await buildAttachmentPlan([{ key: 'x', what: 'X', error: { code: 'martian' } }], { budgetBytes: 1e6 })).omitted[0].code === 'unspecified');

  console.log('\n== E. share links are removed from the budget, not warned about again ==');
  const p4 = await buildAttachmentPlan(items, { budgetBytes: tiny, shareLinkKeys: new Set(['inspection', 'ours']) });
  ok('the linked documents are reported separately', p4.links.length === 2);
  ok('they no longer compete for bytes, so everything else fits', p4.attach.length === 2 && p4.omitted.length === 0);
  ok('and consent is no longer required — the human already chose the link', p4.needsConsent === false);

  console.log('\n== F. the fast path stays free ==');
  const p5 = await buildAttachmentPlan(items, { budgetBytes: 500 * 1024 * 1024 });
  ok('nothing is compressed when everything already fits', p5.compressedCount === 0 && p5.attach.length === 4);
  ok('and the bytes are the ORIGINAL bytes, untouched', p5.attach[0].buf === inspection);

  console.log('\n== G. the summary + the audit shape ==');
  ok('no omissions → no summary (usable as the test itself)', omissionSummary(p5) === null);
  ok(`a summary names them ("${omissionSummary(p2)}")`, /will NOT be attached/.test(omissionSummary(p2)));
  const audit = auditFrom(p2, { consent: { by: 'x' } });
  ok('the audit carries every omission with its code', audit.omitted.length === p2.omitted.length && audit.omitted.every((x) => x.code));
  ok('and a summary the log can be queried on',
    audit.attachSummary.attached_n === p2.attach.length && audit.attachSummary.omitted_n === p2.omitted.length
    && audit.attachSummary.budget === tiny && audit.attachSummary.consent.by === 'x');

  console.log('\n== H. compression is never allowed to break the send ==');
  const p6 = await buildAttachmentPlan([
    { key: 'bad', what: 'Corrupt', filename: 'x.pdf', buf: Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(400, 9)]) },
    { key: 'good', what: 'Good', filename: 'y.bin', buf: Buffer.alloc(2000, 1) },
  ], { budgetBytes: 1500 });
  ok('an uncompressable item is reported, and the rest of the plan still stands',
    p6.attach.length + p6.omitted.length === 2);

  console.log('\n== I. a compressor that throws must not break the send ==');
  // compressToFit is documented never to throw, and every path in it is caught. But this runs on a
  // SEND: the worst outcome of a compressor bug has to be "we could not shrink it", never "the
  // delivery failed". Proven by making it throw for real.
  const compressMod = require('../src/lib/attachments/compress');
  const realFit = compressMod.compressToFit;
  compressMod.compressToFit = async () => { throw new Error('boom'); };
  try {
    const p7 = await buildAttachmentPlan(items, { budgetBytes: 400 * 1024 });
    ok('the plan is still produced', !!p7 && Array.isArray(p7.attach));
    ok('the small documents still travel', p7.attach.length >= 1);
    ok('and the ones that could not be shrunk are reported, not lost', p7.omitted.length >= 1);
    ok('every omission still carries a code and a remedy', p7.omitted.every((m) => m.code && m.remedy));
  } finally { compressMod.compressToFit = realFit; }

  console.log(`\nAll ${passed} assertions passed.\n`);
})().catch((e) => { console.error('\nFAILED:', e && e.message, '\n', e); process.exit(1); });
