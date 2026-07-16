/* Ad-hoc unit tests for the SharePoint mirror integrity work (2026-07-15):
 *   src/lib/upload-bytes.js   — the strict base64 upload-decoding chokepoint
 *   src/lib/sharepoint.js     — quickXorHash (vs an independent spec impl)
 *   src/lib/sharepoint-backup — regen-kind classification
 * Run: node scripts/test-sharepoint-integrity.js   (no DB / network needed) */
const crypto = require('crypto');
const U = require('../src/lib/upload-bytes');
const sp = require('../src/lib/sharepoint');
const backup = require('../src/lib/sharepoint-backup');

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) pass++; else { fail++; console.log(`FAIL ${name}`); } };
const eq = (name, got, exp) => {
  const g = JSON.stringify(got), e = JSON.stringify(exp);
  if (g === e) pass++; else { fail++; console.log(`FAIL ${name}: got ${g} expected ${e}`); }
};
const throws = (name, fn, status) => {
  try { fn(); fail++; console.log(`FAIL ${name}: did not throw`); }
  catch (e) { if (!status || e.status === status) pass++; else { fail++; console.log(`FAIL ${name}: status ${e.status}`); } }
};

// ---------------------------------------------------------------- upload-bytes
const pdf = Buffer.from('%PDF-1.4\nfake pdf body for tests\n%%EOF');
const b64 = pdf.toString('base64');

ok('clean base64 round-trips', U.decodeUploadBase64(b64).buf.equals(pdf));
ok('sha256 travels with bytes', U.decodeUploadBase64(b64).sha256 === crypto.createHash('sha256').update(pdf).digest('hex'));
ok('data: URL prefix stripped (THE corruption class)', U.decodeUploadBase64('data:application/pdf;base64,' + b64).buf.equals(pdf));
ok('url-safe base64 accepted', U.decodeUploadBase64(b64.replace(/\+/g, '-').replace(/\//g, '_')).buf.equals(pdf));
ok('line-wrapped base64 accepted', U.decodeUploadBase64(b64.replace(/(.{20})/g, '$1\r\n')).buf.equals(pdf));
throws('junk is REJECTED, never silently garbled', () => U.decodeUploadBase64('data' + b64 + '!!@@'), 400);
throws('raw HTML pasted as dataBase64 rejected', () => U.decodeUploadBase64('<!doctype html><html>x</html>'), 400);
throws('empty rejected', () => U.decodeUploadBase64(''), 400);
throws('data: URL without comma rejected', () => U.decodeUploadBase64('data:application/pdf'), 400);
throws('truncated base64 rejected', () => U.decodeUploadBase64(b64 + 'A'), 400);
throws('maxBytes enforced', () => U.decodeUploadBase64(b64, { maxBytes: 4 }), 413);

// Node's lenient decoder really does garble a data:-prefixed payload — the
// reason the strict chokepoint exists. Keep this canary so nobody "simplifies"
// back to Buffer.from(x, 'base64').
ok('canary: bare Buffer.from garbles a data:-prefixed payload',
  !Buffer.from('data:application/pdf;base64,' + b64, 'base64').includes('%PDF'));

// sniff / expected kinds
eq('sniff pdf', U.sniffKind(pdf), 'pdf');
eq('sniff html-as-pdf (e-sign accident)', U.sniffKind(Buffer.from('<!DOCTYPE html><p>Sign in</p>')), 'html');
eq('sniff zip/docx', U.sniffKind(Buffer.from('PK\x03\x04rest')), 'zip');
eq('sniff png', U.sniffKind(Buffer.concat([Buffer.from([0x89]), Buffer.from('PNG\r\n'), Buffer.alloc(4)])), 'png');
eq('sniff jpg', U.sniffKind(Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0, 0, 0, 0])), 'jpg');
eq('expected from filename', U.expectedKind('scan.PDF', ''), 'pdf');
eq('expected from content type', U.expectedKind('x.bin', 'application/pdf'), 'pdf');
eq('expected docx→zip', U.expectedKind('a.docx', ''), 'zip');
eq('expected unknown', U.expectedKind('notes.txt', 'text/plain'), null);

// --------------------------------------------------------------- quickXorHash
// Independent implementation straight from the Microsoft spec (BigInt, 160-bit
// circular shift-xor, 11 bits/byte, 64-bit LE length into the last 8 bytes).
function refQuickXor(buf) {
  const MASK = (1n << 160n) - 1n; let st = 0n;
  for (let i = 0; i < buf.length; i++) {
    const v = BigInt(buf[i]) << BigInt((i * 11) % 160);
    st ^= (v & MASK) | (v >> 160n);
  }
  st ^= BigInt(buf.length) << 96n;
  const out = Buffer.alloc(20); let x = st;
  for (let i = 0; i < 20; i++) { out[i] = Number(x & 0xFFn); x >>= 8n; }
  return out.toString('base64');
}
eq('quickXor empty', sp.quickXorHash(Buffer.alloc(0)), 'AAAAAAAAAAAAAAAAAAAAAAAAAAA=');
for (const len of [1, 7, 20, 31, 160, 4096, 65537]) {
  const data = crypto.createHash('sha512').update(String(len)).digest().subarray(0, Math.min(len, 64));
  const buf = Buffer.concat(Array.from({ length: Math.ceil(len / data.length) }, () => data)).subarray(0, len);
  eq(`quickXor ≡ spec (len ${len})`, sp.quickXorHash(buf), refQuickXor(buf));
}

// -------------------------------------------------- typo-tolerant matchers
const map = require('../src/lib/sharepoint-map');
eq('DL: transposition is one edit', map.dlDistance('jonh', 'john'), 1);
eq('DL: insertion is one edit', map.dlDistance('hamiltion', 'hamilton'), 1);
ok('DL: extension of 3 letters never <=1', map.dlDistance('katz', 'katzman') > 1);
ok('tokenClose: short tokens must be exact', !map.tokenClose('st', 's'));
ok('typo borrower: Jonh Smith ↔ John Smith', map.borrowerMatchesTypo('Jonh Smith', 'John', 'Smith'));
ok('typo borrower: Katz never matches Katzman', !map.borrowerMatchesTypo('Moshe Katzman', 'Moshe', 'Katz'));
ok('typo borrower: different first name never matches', !map.borrowerMatchesTypo('Gene Smith', 'Jean', 'Smyth'));
ok('typo address: Hamiltion St ↔ Hamilton Street', map.addressMatchesTypo('654 Hamiltion St', '654 Hamilton Street, Newark NJ'));
ok('typo address: house number still EXACT', !map.addressMatchesTypo('653 Hamilton St', '654 Hamilton Street'));
ok('typo address: different street never matches', !map.addressMatchesTypo('45 Oak Street Extension', '45 Oak Street'));
ok('typo address: stage folder never matches', !map.addressMatchesTypo('Open loan', '654 Hamilton Street'));
ok('exact matcher unchanged: Hamiltion St does NOT exact-match', !map.addressMatches('654 Hamiltion St', '654 Hamilton Street'));
ok('units still exact under typo pass', !map.addressMatchesTypo('123 Main St Apt 1', '123 Main Street Apt 2'));

// --------------------------------------------------------- regen-kind streams
ok('track_record_html is regen', backup.isRegenKind('track_record_html'));
ok('tpr_export is regen', backup.isRegenKind('tpr_export'));
ok('rehab_budget_export is regen', backup.isRegenKind('rehab_budget_export'));
ok('track_record_export is regen', backup.isRegenKind('track_record_export'));
ok('photo_id is NOT regen (human doc, keeps history)', !backup.isRegenKind('photo_id'));
ok('term_sheet is NOT regen (point-in-time offer, keeps versions)', !backup.isRegenKind('term_sheet'));
ok('track_record_doc is NOT regen (human verification doc)', !backup.isRegenKind('track_record_doc'));
ok('chat attachment kind (null) is NOT regen', !backup.isRegenKind(null));

// -------------------------------------- the ONE sanctioned delete: guardrails
// (Graph-free checks: refusals must fire BEFORE any network call.)
(async () => {
  const spClient = require('../src/lib/sharepoint');
  const rejects = (name, p) => p.then(
    () => { fail++; console.log(`FAIL ${name}: did not throw`); },
    () => { pass++; });
  process.env.SHAREPOINT_DELETE_REPLACED_CORRUPT = '0';
  await rejects('sanctioned delete: kill switch blocks outright',
    spClient.deleteReplacedCorruptMirror('d', 'i', { expectedParentId: 'p', replacementItemId: 'r', localSize: 1 }));
  process.env.SHAREPOINT_DELETE_REPLACED_CORRUPT = '1';
  await rejects('sanctioned delete: refuses without replacement id',
    spClient.deleteReplacedCorruptMirror('d', 'i', { expectedParentId: 'p', localSize: 1 }));
  await rejects('sanctioned delete: refuses without expected parent',
    spClient.deleteReplacedCorruptMirror('d', 'i', { replacementItemId: 'r', localSize: 1 }));
  await rejects('sanctioned delete: refuses without item id',
    spClient.deleteReplacedCorruptMirror('d', null, { expectedParentId: 'p', replacementItemId: 'r', localSize: 1 }));
  ok('general remove() still throws', await spClient.remove().then(() => false, () => true));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
