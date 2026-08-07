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

// ---- PDF sniffer ----
ok(sync.looksPdf({ objectName: 'report.pdf' }, null, null), 'pdf by filename');
ok(sync.looksPdf({ objectName: 'x' }, 'application/pdf', null), 'pdf by content type');
ok(sync.looksPdf({ objectName: 'x' }, null, Buffer.from('%PDF-1.4 ...')), 'pdf by magic bytes');
ok(!sync.looksPdf({ objectName: 'report.xml' }, 'application/xml', Buffer.from('<xml/>')), 'xml is not pdf');

console.log(`\n[test-amc-sync-pure] ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
