/**
 * THE UAD 3.6 DELIVERY PACKAGE — a ZIP, not an XML.
 *
 * This is the change most likely to be missed, because it is not in the data model at
 * all. Under UAD 2.6 an appraisal arrives as ONE XML file with the report PDF carried
 * inside it, base64, in an `<EMBEDDED_FILE _Type="PDF"><DOCUMENT>` blob — which is why
 * `xml.js#embeddedPdfBase64` exists and why the whole photos pipeline reads pixels out of
 * that PDF. UAD 3.6 retires that arrangement (and the ENV file with it). The work product
 * is a **ZIP** containing:
 *
 *     report.xml          the MISMO 3.6 UAD dataset
 *     report.pdf          the human-readable rendering
 *     Images/…            every photo as its own file (folder name is case-sensitive)
 *
 * UCDP accepts exactly that package, capped at 60 MB, with images in the standard raster
 * formats. So a system that only knows how to swallow an XML will reject the very file
 * appraisers start delivering — not because it cannot read 3.6, but because it never got
 * to the 3.6.
 *
 * WHY A HAND-ROLLED ZIP READER. The repo installs `express` + `pg` and nothing else, on
 * purpose (no native deps, clean Render builds — the same reason both XML readers are
 * hand-rolled). Everything needed is in Node's own `zlib`: a ZIP entry is either STORED
 * (method 0, raw bytes) or DEFLATED (method 8, `zlib.inflateRawSync`). Those two cover
 * every archive any real producer writes. Anything else is reported by name rather than
 * guessed at.
 *
 * The reader works from the CENTRAL DIRECTORY at the end of the archive — the
 * authoritative index — rather than scanning local headers forward, because local headers
 * may carry zeroed sizes with the real values in a trailing data descriptor. It never
 * throws: a damaged archive comes back as `{ ok:false, error }` with the reason in words.
 *
 * PATH SAFETY. Entry names are used ONLY as labels — nothing here writes to disk — and
 * are still normalized and refused when they try to traverse (`..`, absolute paths,
 * backslashes). An archive is attacker-controlled input; a name that tries to escape is
 * evidence about the file, and it is reported rather than silently cleaned.
 */

'use strict';

const zlib = require('zlib');

// UCDP's own ceiling for a UAD 3.6 submission. A larger file is not a package we should
// spend memory inflating — it is a wrong file, and saying so is the useful answer.
const MAX_PACKAGE_BYTES = 60 * 1024 * 1024;
// One member, inflated. The XML is the only thing we parse; a single entry far above this
// is either not an appraisal dataset or is a decompression bomb.
const MAX_MEMBER_BYTES = 80 * 1024 * 1024;

const EOCD_SIG = 0x06054b50;         // end of central directory
const EOCD64_LOCATOR_SIG = 0x07064b50;
const EOCD64_SIG = 0x06064b50;
const CEN_SIG = 0x02014b50;          // central directory file header
const LOC_SIG = 0x04034b50;          // local file header

const IMAGE_EXT = /\.(jpe?g|png|tiff?|gif|bmp|webp|heic|heif|avif)$/i;

/** True when the buffer starts with the ZIP local-header magic (`PK\003\004`). */
function looksLikeZip(buf) {
  return Buffer.isBuffer(buf) && buf.length >= 4 && buf.readUInt32LE(0) === LOC_SIG;
}

/** Find the End Of Central Directory record, scanning back over the comment field. */
function findEocd(buf) {
  const max = Math.min(buf.length, 0xffff + 22);
  for (let i = buf.length - 22; i >= buf.length - max; i--) {
    if (i < 0) break;
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  return -1;
}

/**
 * Read the central directory into entry descriptors.
 * Returns `{ entries, error }` — a malformed directory yields whatever was read before
 * the damage plus the reason, never an exception.
 */
function readCentralDirectory(buf) {
  const eocd = findEocd(buf);
  if (eocd === -1) return { entries: [], error: 'not a ZIP archive (no end-of-central-directory record)' };

  let count = buf.readUInt16LE(eocd + 10);
  let cdSize = buf.readUInt32LE(eocd + 12);
  let cdOffset = buf.readUInt32LE(eocd + 16);

  // ZIP64: the 32-bit fields are saturated and the real values live in the ZIP64 EOCD.
  if (cdOffset === 0xffffffff || count === 0xffff || cdSize === 0xffffffff) {
    const locAt = eocd - 20;
    if (locAt >= 0 && buf.readUInt32LE(locAt) === EOCD64_LOCATOR_SIG) {
      const z64at = Number(buf.readBigUInt64LE(locAt + 8));
      if (z64at >= 0 && z64at + 56 <= buf.length && buf.readUInt32LE(z64at) === EOCD64_SIG) {
        count = Number(buf.readBigUInt64LE(z64at + 32));
        cdSize = Number(buf.readBigUInt64LE(z64at + 40));
        cdOffset = Number(buf.readBigUInt64LE(z64at + 48));
      }
    }
  }
  if (cdOffset < 0 || cdOffset >= buf.length) return { entries: [], error: 'ZIP central directory offset is outside the file' };

  const entries = [];
  let p = cdOffset;
  const end = Math.min(buf.length, cdOffset + (cdSize || (buf.length - cdOffset)));
  while (p + 46 <= end && entries.length <= 10000) {
    if (buf.readUInt32LE(p) !== CEN_SIG) break;
    const method = buf.readUInt16LE(p + 10);
    const compressedSize = buf.readUInt32LE(p + 20);
    const uncompressedSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nameLen).toString('utf8');
    entries.push({ name, method, compressedSize, uncompressedSize, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  if (!entries.length) return { entries: [], error: 'ZIP central directory is empty or unreadable' };
  return { entries, error: null };
}

/** Inflate (or copy) one entry's bytes. Returns a Buffer, or null with the reason. */
function readEntry(buf, entry) {
  const off = entry.localOffset;
  if (off < 0 || off + 30 > buf.length || buf.readUInt32LE(off) !== LOC_SIG) {
    return { data: null, error: `entry "${entry.name}" has no local header` };
  }
  const nameLen = buf.readUInt16LE(off + 26);
  const extraLen = buf.readUInt16LE(off + 28);
  const start = off + 30 + nameLen + extraLen;
  // The central directory's compressed size is authoritative; a zero there on a
  // data-descriptor entry means "read to the next signature", which we decline to guess at.
  const size = entry.compressedSize;
  if (!size || start + size > buf.length) {
    return { data: null, error: `entry "${entry.name}" has an unreadable compressed size` };
  }
  if (entry.uncompressedSize > MAX_MEMBER_BYTES) {
    return { data: null, error: `entry "${entry.name}" expands to ${entry.uncompressedSize} bytes — above the ${MAX_MEMBER_BYTES}-byte ceiling` };
  }
  const raw = buf.slice(start, start + size);
  if (entry.method === 0) return { data: raw, error: null };
  if (entry.method === 8) {
    try {
      return { data: zlib.inflateRawSync(raw, { maxOutputLength: MAX_MEMBER_BYTES }), error: null };
    } catch (e) {
      return { data: null, error: `entry "${entry.name}" could not be inflated (${e.message})` };
    }
  }
  return { data: null, error: `entry "${entry.name}" uses unsupported compression method ${entry.method}` };
}

/** `Images/front.jpg` → safe; `../x`, `/x`, `a\\..\\b` → unsafe. Names are labels only. */
function isSafeName(name) {
  const n = String(name || '');
  if (!n) return false;
  if (n.startsWith('/') || /^[A-Za-z]:/.test(n)) return false;
  if (n.includes('\\')) return false;
  return !n.split('/').some((seg) => seg === '..');
}

/**
 * Open a UAD 3.6 delivery package.
 *
 * Returns:
 *   { ok:true, xml, xmlName, pdf, pdfName, images:[{name,size,data}], entries, warnings }
 *   { ok:false, error }
 *
 * `xml` is a string (the dataset, ready for `extract`); `pdf` and each image's `data` are
 * Buffers. `images` preserves archive order, which is the order the report's own image
 * manifest expects to match.
 */
function openPackage(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
  if (!looksLikeZip(buf)) return { ok: false, error: 'this file is not a ZIP package' };
  if (buf.length > MAX_PACKAGE_BYTES) {
    return { ok: false, error: `this package is ${Math.round(buf.length / 1048576)} MB — above the 60 MB ceiling UCDP accepts for a UAD 3.6 submission` };
  }

  const { entries, error } = readCentralDirectory(buf);
  if (error) return { ok: false, error };

  const warnings = [];
  const out = { ok: true, xml: null, xmlName: null, pdf: null, pdfName: null, images: [], entries: [], warnings };

  for (const e of entries) {
    if (e.name.endsWith('/')) continue;                    // directory marker
    if (!isSafeName(e.name)) { warnings.push(`ignored an entry with an unsafe path: ${e.name}`); continue; }
    out.entries.push({ name: e.name, size: e.uncompressedSize });

    const lower = e.name.toLowerCase();
    const isXml = lower.endsWith('.xml');
    const isPdf = lower.endsWith('.pdf');
    const isImg = IMAGE_EXT.test(lower);
    if (!isXml && !isPdf && !isImg) continue;

    const got = readEntry(buf, e);
    if (got.error) { warnings.push(got.error); continue; }

    if (isXml) {
      // A package carries ONE dataset. If a producer includes more than one XML, the
      // largest is the report and the rest are manifests/metadata — but say so, because
      // picking the wrong one would silently import the wrong document.
      if (out.xml == null || got.data.length > Buffer.byteLength(out.xml, 'utf8')) {
        if (out.xmlName) warnings.push(`package carries more than one XML; using the larger (${e.name} over ${out.xmlName})`);
        out.xml = got.data.toString('utf8');
        out.xmlName = e.name;
      } else {
        warnings.push(`package carries more than one XML; ignoring ${e.name}`);
      }
    } else if (isPdf) {
      if (out.pdf == null) { out.pdf = got.data; out.pdfName = e.name; }
      else warnings.push(`package carries more than one PDF; ignoring ${e.name}`);
    } else {
      out.images.push({ name: e.name, size: got.data.length, data: got.data });
    }
  }

  if (!out.xml) return { ok: false, error: 'this ZIP contains no XML dataset — a UAD 3.6 delivery must include the MISMO 3.6 XML alongside the PDF and the Images folder' };
  if (!out.pdf) warnings.push('the package carries no PDF rendering of the report');
  if (!out.images.length) warnings.push('the package carries no images');
  return out;
}

/**
 * A one-line description of what arrived, for the officer-facing message and the audit
 * trail. Never throws; a null package reads as "nothing".
 */
function describePackage(pkg) {
  if (!pkg || !pkg.ok) return pkg && pkg.error ? pkg.error : 'no package';
  const bits = [`XML ${pkg.xmlName}`];
  if (pkg.pdfName) bits.push(`PDF ${pkg.pdfName}`);
  bits.push(`${pkg.images.length} image${pkg.images.length === 1 ? '' : 's'}`);
  return bits.join(', ');
}

module.exports = {
  openPackage, describePackage, looksLikeZip,
  _internals: { readCentralDirectory, readEntry, isSafeName, findEocd, MAX_PACKAGE_BYTES, MAX_MEMBER_BYTES },
};
