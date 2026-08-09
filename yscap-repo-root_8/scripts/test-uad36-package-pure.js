/**
 * The UAD 3.6 DELIVERY PACKAGE reader — pure assertions, no database, no network.
 *
 * UAD 3.6 retires the ENV file: the appraiser's work product is a ZIP carrying the
 * MISMO 3.6 XML, a PDF rendering and an `Images/` folder, and that is what UCDP
 * accepts (60 MB ceiling). A system that only swallows a bare XML rejects the very
 * file appraisers start delivering — so the ZIP reader is part of reading 3.6, not a
 * nicety. These assertions build real archives (both compression methods, plus the
 * malformed and hostile cases) and read them back.
 */
'use strict';

const zlib = require('zlib');
const P = require('../src/lib/appraisal/package36');

let failures = 0;
const assert = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };
const eq = (a, b, m) => assert(a === b, `${m}${a === b ? '' : ` (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`}`);

// ── a minimal but REAL zip writer, so the reader is tested against real bytes ──
const crc32 = (() => {
  const T = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    T[i] = c;
  }
  return (buf) => {
    let c = -1;
    for (let i = 0; i < buf.length; i++) c = T[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  };
})();

/** Build a ZIP from `[{name, data, store}]`. `store` uses method 0, else deflate. */
function makeZip(entries) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const raw = Buffer.isBuffer(e.data) ? e.data : Buffer.from(String(e.data), 'utf8');
    const method = e.store ? 0 : 8;
    const body = method === 0 ? raw : zlib.deflateRawSync(raw);
    const name = Buffer.from(e.name, 'utf8');
    const crc = crc32(raw);

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0, 6);
    lh.writeUInt16LE(method, 8);
    lh.writeUInt16LE(0, 10); lh.writeUInt16LE(0, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(body.length, 18);
    lh.writeUInt32LE(raw.length, 22);
    lh.writeUInt16LE(name.length, 26); lh.writeUInt16LE(0, 28);
    locals.push(lh, name, body);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0, 8); ch.writeUInt16LE(method, 10);
    ch.writeUInt16LE(0, 12); ch.writeUInt16LE(0, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(body.length, 20);
    ch.writeUInt32LE(raw.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt16LE(0, 30); ch.writeUInt16LE(0, 32); ch.writeUInt16LE(0, 34);
    ch.writeUInt16LE(0, 36); ch.writeUInt32LE(0, 38);
    ch.writeUInt32LE(offset, 42);
    central.push(ch, name);

    offset += lh.length + name.length + body.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4); eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, cd, eocd]);
}

const XML = '<?xml version="1.0"?><MESSAGE MISMOReferenceModelIdentifier="3.6.0">'
  + '<SALES_COMPARISON><COMPARABLE_SALE/></SALES_COMPARISON></MESSAGE>';
const PDF = Buffer.from('%PDF-1.7\n% a rendering of the report\n%%EOF\n', 'utf8');
const JPG = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0, 16, 0x4A, 0x46, 0x49, 0x46, 0]);

// ── the ordinary delivery ────────────────────────────────────────────────────
console.log('\n-- the UCDP-shaped delivery package --');
{
  const zip = makeZip([
    { name: 'URAR_123_Main_St.xml', data: XML },
    { name: 'URAR_123_Main_St.pdf', data: PDF },
    { name: 'Images/', data: '' },
    { name: 'Images/subject_front.jpg', data: JPG },
    { name: 'Images/subject_rear.jpg', data: JPG },
    { name: 'Images/comp1.png', data: Buffer.from([0x89, 0x50, 0x4E, 0x47]) },
  ]);
  assert(P.looksLikeZip(zip), 'the package is recognised as a ZIP by its magic bytes');

  const pkg = P.openPackage(zip);
  assert(pkg.ok === true, 'it opens');
  eq(pkg.xmlName, 'URAR_123_Main_St.xml', 'the MISMO 3.6 dataset is found');
  eq(pkg.xml.trim(), XML, 'and its bytes round-trip exactly through the deflate');
  eq(pkg.pdfName, 'URAR_123_Main_St.pdf', 'the PDF rendering is found');
  assert(pkg.pdf.equals(PDF), 'and its bytes round-trip exactly');
  eq(pkg.images.length, 3, 'every image in the Images folder is found');
  eq(pkg.images[0].name, 'Images/subject_front.jpg', 'in archive order, which is the order the manifest expects');
  assert(pkg.images[0].data.equals(JPG), 'with the real bytes');
  eq(pkg.warnings.length, 0, 'a complete package warns about nothing');
  assert(/URAR_123_Main_St\.xml/.test(P.describePackage(pkg)), 'and describes itself in one line');

  // The XML it hands back must be readable by the reader it exists to feed.
  const { extract } = require('../src/lib/appraisal/extract');
  const A = extract(pkg.xml);
  assert(A.format && A.format.model === '3.6',
    'the dataset the package yields is recognised as UAD 3.6 by extract()');
}

// ── STORED (uncompressed) members ────────────────────────────────────────────
console.log('\n-- both compression methods --');
{
  const zip = makeZip([
    { name: 'report.xml', data: XML, store: true },
    { name: 'report.pdf', data: PDF, store: true },
  ]);
  const pkg = P.openPackage(zip);
  assert(pkg.ok === true, 'a STORED (method 0) package opens');
  eq(pkg.xml.trim(), XML, 'and its stored member reads byte for byte');
}

// ── what is missing is SAID, never silently dropped ──────────────────────────
console.log('\n-- nothing is silently missing --');
{
  const noPdf = P.openPackage(makeZip([{ name: 'r.xml', data: XML }]));
  assert(noPdf.ok === true, 'a package with only the dataset still opens (the data is what we read)');
  assert(noPdf.warnings.some((w) => /no PDF/i.test(w)), 'and says the PDF rendering is absent');
  assert(noPdf.warnings.some((w) => /no images/i.test(w)), 'and says there are no images');

  const noXml = P.openPackage(makeZip([{ name: 'r.pdf', data: PDF }]));
  assert(noXml.ok === false, 'a package with no dataset is refused');
  assert(/no XML dataset/i.test(noXml.error), 'and the reason names what is missing');

  const twoXml = P.openPackage(makeZip([
    { name: 'small.xml', data: '<a/>' },
    { name: 'report.xml', data: XML },
  ]));
  eq(twoXml.xmlName, 'report.xml', 'with two XMLs the larger is taken as the report');
  assert(twoXml.warnings.some((w) => /more than one XML/i.test(w)), 'and the choice is stated, never silent');
}

// ── hostile and malformed input ──────────────────────────────────────────────
console.log('\n-- hostile and malformed input --');
{
  assert(P.openPackage(Buffer.from('not a zip at all')).ok === false, 'a non-ZIP is refused');
  assert(P.openPackage(null).ok === false, 'an empty buffer is refused rather than throwing');

  const truncated = makeZip([{ name: 'r.xml', data: XML }]).slice(0, 40);
  const t = P.openPackage(truncated);
  assert(t.ok === false, 'a truncated archive is refused');
  assert(typeof t.error === 'string' && t.error.length > 0, 'with a reason in words');

  // Entry names are labels here (nothing is written to disk) and a traversing name is
  // still refused — it is evidence about the file, so it is reported rather than cleaned.
  const evil = P.openPackage(makeZip([
    { name: 'r.xml', data: XML },
    { name: '../../etc/passwd.pdf', data: PDF },
    { name: '/abs/path.jpg', data: JPG },
  ]));
  assert(evil.ok === true, 'the good members of a package with a hostile name still read');
  eq(evil.pdfName, null, 'a traversing member is NOT adopted');
  eq(evil.images.length, 0, 'nor is an absolute-path member');
  eq(evil.warnings.filter((w) => /unsafe path/i.test(w)).length, 2, 'and each one is reported by name');

  assert(P._internals.isSafeName('Images/front.jpg') === true, 'an ordinary member name is safe');
  assert(P._internals.isSafeName('a/../b.jpg') === false, 'a traversal is unsafe');
  assert(P._internals.isSafeName('C:\\x.jpg') === false, 'a Windows absolute path is unsafe');

  // The UCDP ceiling: a package above it is refused with the reason, not parsed.
  const huge = Buffer.alloc(P._internals.MAX_PACKAGE_BYTES + 1);
  huge.writeUInt32LE(0x04034b50, 0);
  const big = P.openPackage(huge);
  assert(big.ok === false && /60 MB/.test(big.error), 'a package above the 60 MB UCDP ceiling is refused by size');
}

console.log(`\n${failures ? `${failures} FAILURE(S)` : 'ALL UAD 3.6 package assertions passed'}`);
process.exit(failures ? 1 : 0);
