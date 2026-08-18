'use strict';
/**
 * Pure test for the AMC sync worker's decision helpers (src/amc/sync.js). No DB,
 * no network: the status-event dedupe key and the XML/PDF sniffers.
 */
const sync = require('../src/amc/sync');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.error('  FAIL:', m); } };

// ---- dedupe key: stable + distinct ----
const a = { statusCode: '1102', statusName: 'InProcess', statusCondition: 'Ack', statusDescription: 'working' };
const b = { statusCode: '1102', statusName: 'InProcess', statusCondition: 'Ack', statusDescription: 'working' };
const c = { statusCode: '1200', statusName: 'AssignedToAppraiser', statusCondition: 'Ack' };
ok(sync.statusDedupeKey(a) === sync.statusDedupeKey(b), 'same status → same dedupe key');
ok(sync.statusDedupeKey(a) !== sync.statusDedupeKey(c), 'different status → different dedupe key');
ok(sync.statusDedupeKey({}) === sync.statusDedupeKey({}), 'empty status is stable');

// ---- XML sniffer ----
ok(sync.looksXml({ objectName: 'report.xml' }, null, null), 'xml by filename');
ok(sync.looksXml({ objectName: 'x' }, 'text/xml', null), 'xml by content type');
ok(sync.looksXml({ objectName: 'x' }, null, Buffer.from('  <?xml version="1.0"?>')), 'xml by leading angle bracket');
ok(!sync.looksXml({ objectName: 'report.pdf' }, 'application/pdf', Buffer.from('%PDF-1.7')), 'a pdf is not xml');

// ---- the bytes decide ----
// An expired link, a login wall or a vendor error page comes back with a 200 and
// whatever name we asked under, so the FILENAME can never be the test — otherwise
// the appraisal importer is handed an HTML page and told it is the data file.
const HTML = Buffer.from('<!doctype html><html><body>Session expired</body></html>');
ok(!sync.xmlBytes('text/html', HTML), 'an HTML error page is not XML');
ok(!sync.xmlBytes('application/xml', HTML), 'HTML bytes are refused even when the vendor CALLS them xml');
ok(!sync.looksXml({ objectName: 'appraisal.xml' }, 'application/xml', HTML),
  'a file NAMED .xml and TYPED xml is still refused when the bytes are an error page');
ok(sync.xmlBytes(null, Buffer.from('<?xml version="1.0"?><VALUATION_RESPONSE/>')), 'a real MISMO file is XML');
ok(sync.xmlBytes(null, Buffer.from('﻿  <?xml version="1.0"?><X/>')), 'a leading BOM and whitespace do not hide it');
ok(sync.xmlBytes(null, Buffer.from('<VALUATION_RESPONSE/>')), 'an XML file with no declaration is still XML');
ok(sync.xmlBytes('text/xml', Buffer.from('<VALUATION_RESPONSE/>')), 'the content type agrees');
ok(!sync.xmlBytes(null, Buffer.from('%PDF-1.7')), 'a PDF is not XML');
ok(!sync.xmlBytes(null, Buffer.from('Order not found')), 'a plain-text refusal is not XML');
ok(!sync.xmlBytes(null, Buffer.from('')), 'empty bytes are not XML');
ok(!sync.xmlBytes(null, null), 'nothing at all is not XML');
// With nothing downloaded there is no byte evidence to weigh, so the declared name
// is the only evidence there is — this is the listing's shape, never the fetch's.
ok(sync.looksXml({ objectName: 'report.xml' }, null, null), 'with no bytes in hand the declared name is all there is');

// ---- PDF sniffer ----
ok(sync.looksPdf({ objectName: 'report.pdf' }, null, null), 'pdf by filename');
ok(sync.looksPdf({ objectName: 'x' }, 'application/pdf', null), 'pdf by content type');
ok(sync.looksPdf({ objectName: 'x' }, null, Buffer.from('%PDF-1.4 ...')), 'pdf by magic bytes');
ok(!sync.looksPdf({ objectName: 'report.xml' }, 'application/xml', Buffer.from('<xml/>')), 'xml is not pdf');

console.log(`\n[test-amc-sync-pure] ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
