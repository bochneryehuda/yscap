'use strict';
/**
 * Pure unit tests for the Class attachment ingest's DEFENSIVE readers
 * (src/class/documents.js) — no DB, no network.
 *
 * These are the parts that keep the ingest correct despite the vendor guide not
 * pinning down the list shape or the download shape (see the module header): the
 * list parser and the bytes resolver must read the real response, whatever spelling
 * it arrives in, and NEVER decode a non-file into garbage bytes.
 */
const path = require('path');
const ROOT = path.join(__dirname, '..');
const doc = require(path.join(ROOT, 'src/class/documents'));

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.error('  FAIL:', m); } };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), `${m} (got ${JSON.stringify(a)})`);

(async () => {
  // ---- parseAttachmentList: pull the array from wherever it lives ----
  {
    const rootArr = doc.parseAttachmentList([
      { id: 'a1', name: 'report.xml', contentType: 'application/xml' },
      { attachmentId: 'a2', fileName: 'report.pdf', mimeType: 'application/pdf' },
    ]);
    eq(rootArr.length, 2, 'root array: two entries');
    eq(rootArr[0], { id: 'a1', name: 'report.xml', contentType: 'application/xml', url: null }, 'root array: first entry read');
    eq(rootArr[1].id, 'a2', 'attachmentId alias read');
    eq(rootArr[1].name, 'report.pdf', 'fileName alias read');
    eq(rootArr[1].contentType, 'application/pdf', 'mimeType alias read');

    eq(doc.parseAttachmentList({ data: [{ Id: 'x', Name: 'y.pdf' }] }).length, 1, '.data array');
    eq(doc.parseAttachmentList({ attachments: [{ id: 'z' }] }).length, 1, '.attachments array');
    eq(doc.parseAttachmentList({ items: [{ id: 'z' }, { id: 'q' }] }).length, 2, '.items array');
    eq(doc.parseAttachmentList({ name: 'solo.pdf', id: 's1' }).length, 1, 'single object treated as a list of one');

    // download url on the list entry itself
    const withUrl = doc.parseAttachmentList([{ name: 'r.pdf', downloadUrl: 'https://x/y' }]);
    eq(withUrl[0].url, 'https://x/y', 'downloadUrl on a list entry read');

    // nothing to hold on to → dropped; junk shapes → empty
    eq(doc.parseAttachmentList([{ foo: 'bar' }, null, 42, {}]).length, 0, 'entries with no id/name/url dropped');
    eq(doc.parseAttachmentList(null).length, 0, 'null → empty');
    eq(doc.parseAttachmentList('nope').length, 0, 'string → empty');
    eq(doc.parseAttachmentList({}).length, 0, 'empty object → empty');
  }

  // ---- resolveAttachmentBytes: every plausible download shape ----
  // Realistic sizes: a real appraisal PDF/XML is many KB, so a base64 envelope of one
  // clears the "long enough to be a document" guard by a wide margin.
  const PDF = Buffer.concat([Buffer.from('%PDF-1.7\n%âÃÏÓ\n', 'latin1'), Buffer.alloc(4096, 0x41)]);
  const XML = Buffer.from(
    '<?xml version="1.0"?><VALUATION_RESPONSE>' + '<PROPERTY addr="12 Oak St"/>'.repeat(64) + '</VALUATION_RESPONSE>',
    'utf8');

  {
    // (a) raw PDF bytes, binary content-type → used as-is
    const r = await doc.resolveAttachmentBytes({ bytes: PDF, contentType: 'application/pdf' });
    ok(r.bytes.equals(PDF), 'raw pdf: bytes preserved');
    eq(r.contentType, 'application/pdf', 'raw pdf: content-type preserved');
  }
  {
    // (b) raw XML bytes, content-type text/xml → used as-is
    const r = await doc.resolveAttachmentBytes({ bytes: XML, contentType: 'text/xml' });
    ok(r.bytes.equals(XML), 'raw xml: bytes preserved');
  }
  {
    // (c) raw bytes, NO content-type, body starts with '%' → still recognised as the file
    const r = await doc.resolveAttachmentBytes({ bytes: PDF, contentType: '' });
    ok(r.bytes.equals(PDF), 'raw pdf, no content-type: bytes preserved');
  }
  {
    // (d) JSON envelope with inline base64 under `content`
    const b64 = PDF.toString('base64');
    const body = Buffer.from(JSON.stringify({ name: 'appraisal.pdf', contentType: 'application/pdf', content: b64 }), 'utf8');
    const r = await doc.resolveAttachmentBytes({ bytes: body, contentType: 'application/json' });
    ok(r.bytes.equals(PDF), 'json+base64: decoded to the file bytes');
    eq(r.contentType, 'application/pdf', 'json+base64: content-type from the envelope');
    eq(r.filename, 'appraisal.pdf', 'json+base64: filename from the envelope');
  }
  {
    // (e) JSON envelope, base64 NESTED under `data`
    const b64 = XML.toString('base64');
    const body = Buffer.from(JSON.stringify({ data: { fileName: 'a.xml', mimeType: 'application/xml', base64: b64 } }), 'utf8');
    const r = await doc.resolveAttachmentBytes({ bytes: body, contentType: 'application/json' });
    ok(r.bytes.equals(XML), 'json+nested base64: decoded');
    eq(r.filename, 'a.xml', 'json+nested: filename read from nested object');
  }
  {
    // (f) JSON envelope with a download URL → getUrl is followed
    const body = Buffer.from(JSON.stringify({ downloadUrl: 'https://store/x?sig=1', contentType: 'application/pdf' }), 'utf8');
    let asked = null;
    const r = await doc.resolveAttachmentBytes({ bytes: body, contentType: 'application/json' },
      { getUrl: async (u) => { asked = u; return { bytes: PDF, contentType: 'application/pdf' }; } });
    eq(asked, 'https://store/x?sig=1', 'json+url: the url was followed');
    ok(r.bytes.equals(PDF), 'json+url: followed bytes returned');
  }
  {
    // (g) JSON envelope with NEITHER content nor url → a recorded error, never a corrupt doc
    const body = Buffer.from(JSON.stringify({ status: 'ok', message: 'nothing here' }), 'utf8');
    let threw = false;
    try { await doc.resolveAttachmentBytes({ bytes: body, contentType: 'application/json' }); }
    catch { threw = true; }
    ok(threw, 'json with neither content nor url throws');
  }
  {
    // (h) content-type says json but the body does not parse → treat the bytes as the file
    const r = await doc.resolveAttachmentBytes({ bytes: PDF, contentType: 'application/json' });
    ok(r.bytes.equals(PDF), 'json content-type but unparseable body → bytes used');
  }
  {
    // (i) empty response → throws
    let threw = false;
    try { await doc.resolveAttachmentBytes({ bytes: Buffer.alloc(0), contentType: 'application/pdf' }); }
    catch { threw = true; }
    ok(threw, 'empty bytes throws');
  }
  {
    // (j) a short base64-ish string is NOT decoded (it is metadata, not a document)
    const body = Buffer.from(JSON.stringify({ content: 'application/pdf', url: 'https://s/x' }), 'utf8');
    let asked = null;
    const r = await doc.resolveAttachmentBytes({ bytes: body, contentType: 'application/json' },
      { getUrl: async (u) => { asked = u; return { bytes: PDF, contentType: 'application/pdf' }; } });
    eq(asked, 'https://s/x', 'short base64-ish value not decoded; the url is used instead');
    ok(r.bytes.equals(PDF), 'short value case still resolves via url');
  }

  // ---- looksXml / looksPdf ----
  ok(doc.looksXml('report.xml', '', null), 'looksXml by extension');
  ok(doc.looksXml('x', 'application/xml', null), 'looksXml by content-type');
  ok(doc.looksXml('x', '', XML), 'looksXml by leading <');
  ok(!doc.looksXml('x', 'application/pdf', PDF), 'pdf is not xml');
  ok(doc.looksPdf('report.pdf', '', null), 'looksPdf by extension');
  ok(doc.looksPdf('x', 'application/pdf', null), 'looksPdf by content-type');
  ok(doc.looksPdf('x', '', PDF), 'looksPdf by %PDF magic');
  ok(!doc.looksPdf('x', 'text/xml', XML), 'xml is not pdf');

  // ---- looksBase64 guard ----
  ok(!doc._internals.looksBase64('application/pdf'), 'a mime string is not treated as base64');
  ok(!doc._internals.looksBase64('a1'), 'a short id is not treated as base64');
  ok(doc._internals.looksBase64(PDF.toString('base64')), 'a real base64 blob is recognised');

  console.log(`\n[test-class-documents-pure] ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('THREW:', e); process.exit(1); });
