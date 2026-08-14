'use strict';
/**
 * THE COMPRESSION ENGINE — make a document small enough to email, without losing it
 * (owner-directed 2026-08-14: "we should always have an option to compress that document and retry,
 * and make sure you have a good compressing engine … documents are too big, we need to compress it
 * to begin with. Make sure that the foundation is correct, and usually it's always going to be
 * attached.").
 *
 * WHY A DOCUMENT WAS TOO BIG IN THE FIRST PLACE, because the fix follows from it. Essentially every
 * oversized PDF in this system is oversized for ONE reason: it carries photographs at camera
 * resolution. An inspector's report is thirty phone pictures at ~3.5 MB each; a scanned closing
 * package is one full-page image per page. The PAGE cannot render those pixels — a photo printed
 * into a 2-inch cell shows about 600 of its 4,032 pixels — so shrinking them is not a quality
 * trade at all, it is declining to carry data the reader was never going to see. That is the same
 * reasoning `lib/image-fit.js` is built on, and this module REUSES it rather than restating it, so
 * "how do we shrink a picture" has ONE answer in this codebase.
 *
 * THE SEVEN RULES. Each exists because breaking it loses or corrupts a document:
 *   1. NEVER THROWS, and every failure path returns the ORIGINAL bytes. A document that reaches the
 *      recipient slightly too large is a nuisance; one that reaches them corrupted, or does not
 *      reach them at all because the compressor threw, is the failure this exists to prevent.
 *   2. NEVER RETURNS A BIGGER BUFFER. Re-encoding an already-crushed source genuinely grows it.
 *   3. THE RESULT IS RE-OPENED AND CHECKED, never assumed. A PDF we rewrote is loaded back and its
 *      page count compared to the original; anything short of an exact match discards our version.
 *      Nothing else in the chain would notice a subtly broken PDF until a capital partner did.
 *   4. ONLY IMAGES WE CAN FAITHFULLY REPRODUCE ARE TOUCHED. A CMYK or 4-component JPEG, an indexed
 *      colour space, or a `/Decode` inversion array is left exactly as it is: `jpeg-js` returns RGB
 *      pixels, so re-embedding one of those would silently change the COLOURS of a document that
 *      goes out for signature. Skipping is always available; guessing is not.
 *   5. IT IS BOUNDED IN TIME AND IN WORK. `jpeg-js` is pure JavaScript (the repo's no-native-deps
 *      rule) and decoding one 12-megapixel photo takes ~3 SECONDS while BLOCKING THE EVENT LOOP.
 *      This runs on a request, so it works to a deadline, caps how many images it will touch, and
 *      YIELDS between each one so a health probe is never starved. Hitting the cap reports
 *      `partial: true` — a bound that is not reported is a silent cap.
 *   6. THE ORIGINAL IS NEVER OVERWRITTEN. This returns bytes; the caller attaches them. The stored
 *      copy on the file keeps every pixel the inspector took.
 *   7. LEVELS ESCALATE, and the caller sees which one was used. "It was compressed" is not an
 *      answer anybody can act on; "shrunk to 1100px at level 3, 24 MB to 4 MB" is.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. A Flate-encoded (raw bitmap) image inside a PDF is left alone:
 * re-encoding one means reproducing its predictor, bit depth and colour space exactly, and getting
 * any of that wrong corrupts the page rather than failing loudly. An .xlsx / .docx is already a ZIP
 * and has nothing to win. Both are reported as `nothing_to_compress`, never as a failure.
 */

const imageFit = require('../image-fit');

/* --------------------------------------------------------------------------
 * LEVELS
 * ------------------------------------------------------------------------ */

/**
 * Level 1 is free — a structural repack with no decoding at all, so it is always worth trying and
 * can never touch a pixel. Levels 2..5 downsample the photographs, and the numbers are the same
 * ladder image-fit already reasons about: 1600px is what a report page can show, 700px is what the
 * delivery email uses today, and 600px is the floor below which an inspection photo stops being
 * evidence.
 */
const LEVELS = [
  { level: 1, label: 'repack',   maxSide: null, quality: null, note: 'restructured the file — no pictures changed' },
  { level: 2, label: 'light',    maxSide: 1600, quality: 80,   note: 'photos fitted to 1600px' },
  { level: 3, label: 'standard', maxSide: 1100, quality: 72,   note: 'photos fitted to 1100px' },
  { level: 4, label: 'strong',   maxSide: 800,  quality: 64,   note: 'photos fitted to 800px' },
  { level: 5, label: 'maximum',  maxSide: 600,  quality: 55,   note: 'photos fitted to 600px' },
];
const MAX_LEVEL = LEVELS.length;

// How long a single compression attempt may spend, and how many images it may touch. Both are
// deliberately generous enough for a real inspection report and hard enough that a pathological
// document cannot hold a request open.
const DEFAULT_DEADLINE_MS = Math.max(2000, Number(process.env.ATTACH_COMPRESS_DEADLINE_MS) || 25000);
const DEFAULT_MAX_IMAGES = Math.max(1, Number(process.env.ATTACH_COMPRESS_MAX_IMAGES) || 80);
// Below this, an embedded image is not worth a 3-second decode.
const MIN_IMAGE_BYTES = Math.max(20 * 1024, Number(process.env.ATTACH_COMPRESS_MIN_IMAGE_BYTES) || 60 * 1024);

const levelSpec = (n) => LEVELS[Math.min(MAX_LEVEL, Math.max(1, Number(n) || 1)) - 1];

/** Hand the event loop back so a long compression can never starve a health probe. */
const tick = () => new Promise((r) => setImmediate(r));

/* --------------------------------------------------------------------------
 * FORMAT SNIFFING — from the BYTES, never the declared content type
 * ------------------------------------------------------------------------ */

function isPdf(buf) {
  return !!buf && buf.length > 4 && buf.subarray(0, 4).toString('latin1') === '%PDF';
}

/**
 * How many colour components a JPEG carries, read from its SOFn marker. Returns null when it cannot
 * be read — which, per rule 4, means the image is left alone.
 *
 * This is the guard that keeps a CMYK scan from coming back with wrong colours: `jpeg-js` hands us
 * RGB pixels whatever went in, so a 4-component source must never be re-embedded as if it were the
 * same thing.
 */
function jpegComponents(buf) {
  if (!imageFit.isJpeg(buf)) return null;
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xFF) { i++; continue; }
    const marker = buf[i + 1];
    if (marker === 0xD8 || marker === 0xD9 || (marker >= 0xD0 && marker <= 0xD7) || marker === 0x01) { i += 2; continue; }
    const len = buf.readUInt16BE(i + 2);
    if (len < 2) return null;
    if (marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC) {
      // SOF payload: precision(1) height(2) width(2) numComponents(1)
      return buf[i + 9];
    }
    i += 2 + len;
  }
  return null;
}

/* --------------------------------------------------------------------------
 * PDF
 * ------------------------------------------------------------------------ */

/** A pdf-lib name node's plain text ("/Image"), whatever concrete class it is. Never throws. */
function nameOf(node) {
  try {
    if (!node) return '';
    if (typeof node.asString === 'function') return node.asString();
    if (typeof node.encodedName === 'string') return node.encodedName;
    return String(node);
  } catch (_) { return ''; }
}

/** Every filter on a stream, flattened — `/Filter` is a single name OR an array of them. */
function filtersOf(dict, PDFName) {
  try {
    const f = dict.get(PDFName.of('Filter'));
    if (!f) return [];
    if (typeof f.asArray === 'function') return f.asArray().map(nameOf);
    return [nameOf(f)];
  } catch (_) { return []; }
}

/**
 * Is this embedded image one we can faithfully reproduce? Rule 4 in one place, so every reason to
 * decline is visible together rather than scattered through the walk.
 */
function imageIsSafeToRewrite(dict, raw, PDFName) {
  // Only a plain baseline JPEG stream. DCTDecode means the stream bytes ARE a JPEG file.
  const filters = filtersOf(dict, PDFName);
  if (filters.length !== 1 || filters[0] !== '/DCTDecode') return 'not_a_plain_jpeg';
  if (!imageFit.isJpeg(raw)) return 'not_a_plain_jpeg';
  // 1 = greyscale, 3 = YCbCr/RGB. Anything else (4 = CMYK/YCCK) would come back recoloured.
  const comps = jpegComponents(raw);
  if (comps !== 1 && comps !== 3) return 'colour_space_not_reproducible';
  // A `/Decode` array remaps sample values against the ORIGINAL colour space; carrying it onto our
  // RGB re-encode would invert or shift the image.
  if (dict.get(PDFName.of('Decode'))) return 'has_decode_array';
  // An indexed / separation / DeviceN palette cannot survive a re-encode to RGB.
  const cs = dict.get(PDFName.of('ColorSpace'));
  const csName = nameOf(cs);
  if (csName === '/DeviceCMYK') return 'colour_space_not_reproducible';
  if (cs && typeof cs.asArray === 'function') {
    const first = nameOf(cs.asArray()[0]);
    if (first === '/Indexed' || first === '/Separation' || first === '/DeviceN') return 'colour_space_not_reproducible';
    // An ICCBased profile with four components is CMYK by another name.
    if (first === '/ICCBased') return 'colour_space_not_reproducible';
  }
  // A JPXDecode/CCITT mask alongside is fine (an SMask is scaled to the image), but a stencil mask
  // keyed to exact pixel dimensions is not.
  if (dict.get(PDFName.of('ImageMask'))) return 'is_a_stencil_mask';
  return null;
}

/**
 * Shrink a PDF. Returns the ORIGINAL bytes on any doubt whatsoever.
 *
 * @returns {{buf:Buffer, changed:boolean, before:number, after:number, level:number,
 *            method:string, reason:string, images:{seen:number,resized:number,skipped:number},
 *            partial:boolean, note:string}}
 */
async function compressPdf(buf, opts) {
  const o = opts || {};
  const spec = levelSpec(o.level);
  const deadline = Date.now() + (Math.max(1000, Number(o.deadlineMs) || DEFAULT_DEADLINE_MS));
  const maxImages = Math.max(1, Number(o.maxImages) || DEFAULT_MAX_IMAGES);
  const base = {
    buf, changed: false, before: buf ? buf.length : 0, after: buf ? buf.length : 0,
    level: spec.level, method: 'pdf', reason: '', note: spec.note,
    images: { seen: 0, resized: 0, skipped: 0 }, partial: false,
  };
  try {
    if (!buf || !buf.length) return { ...base, reason: 'empty' };
    if (!isPdf(buf)) return { ...base, reason: 'not_a_pdf' };

    const { PDFDocument, PDFName, PDFRawStream, PDFNumber } = require('pdf-lib');
    // `ignoreEncryption` lets us at least REPACK a permissions-flagged PDF (the overwhelmingly
    // common kind — "no printing" rather than a password). `updateMetadata:false` keeps us from
    // stamping our own producer/dates onto somebody else's document.
    const doc = await PDFDocument.load(buf, { ignoreEncryption: true, updateMetadata: false });
    const pagesBefore = doc.getPageCount();
    if (!pagesBefore) return { ...base, reason: 'no_pages' };

    let resized = 0, seen = 0, skipped = 0, partial = false;

    if (spec.maxSide) {
      const objects = doc.context.enumerateIndirectObjects();
      for (const [ref, obj] of objects) {
        if (Date.now() > deadline) { partial = true; break; }
        if (resized >= maxImages) { partial = true; break; }
        if (!(obj instanceof PDFRawStream)) continue;
        const dict = obj.dict;
        if (!dict || nameOf(dict.get(PDFName.of('Subtype'))) !== '/Image') continue;
        seen++;
        const raw = Buffer.from(obj.contents || []);
        // Rule 5 — a small image is not worth a multi-second decode.
        if (raw.length < MIN_IMAGE_BYTES) { skipped++; continue; }
        if (imageIsSafeToRewrite(dict, raw, PDFName)) { skipped++; continue; }

        // ONE definition of how a picture is shrunk (image-fit), with all six of its own rules:
        // never upscales, never grows, re-reads its own output, bounded before the decode.
        const fit = imageFit.fitJpeg(raw, { maxSide: spec.maxSide, quality: spec.quality });
        if (!fit || !fit.changed || !fit.to) { skipped++; await tick(); continue; }

        try {
          // Carry the ORIGINAL dictionary forward and change only what the new bytes make untrue.
          // Rebuilding it from scratch would drop `/SMask`, `/Intent`, `/Metadata` and anything else
          // the producer put there — a page can render very differently without them.
          dict.set(PDFName.of('Width'), PDFNumber.of(fit.to.w));
          dict.set(PDFName.of('Height'), PDFNumber.of(fit.to.h));
          dict.set(PDFName.of('BitsPerComponent'), PDFNumber.of(8));
          dict.set(PDFName.of('ColorSpace'), PDFName.of('DeviceRGB'));
          dict.set(PDFName.of('Filter'), PDFName.of('DCTDecode'));
          dict.set(PDFName.of('Length'), PDFNumber.of(fit.buf.length));
          dict.delete(PDFName.of('DecodeParms'));
          doc.context.assign(ref, PDFRawStream.of(dict, new Uint8Array(fit.buf)));
          resized++;
        } catch (_) { skipped++; }
        // Rule 5 — yield between images so this never blocks the loop for minutes on end.
        await tick();
      }
    }

    // Object streams are the free win: they pack the document's own bookkeeping objects together
    // and cost nothing but a re-save. This is the whole of level 1 and rides along on every level.
    const out = Buffer.from(await doc.save({ useObjectStreams: true, addDefaultPage: false }));

    // RULE 2 — a "compressed" copy that is bigger is not one.
    if (!out.length || out.length >= buf.length) {
      return { ...base, reason: resized ? 'no_saving' : 'nothing_to_compress', images: { seen, resized: 0, skipped }, partial };
    }
    // RULE 3 — re-open what we produced and prove it is still the same document. Nothing downstream
    // would notice a subtly broken PDF until the recipient did.
    try {
      const check = await PDFDocument.load(out, { ignoreEncryption: true, updateMetadata: false });
      if (check.getPageCount() !== pagesBefore) {
        return { ...base, reason: 'verify_failed_page_count', images: { seen, resized, skipped }, partial };
      }
    } catch (_) {
      return { ...base, reason: 'verify_failed_unreadable', images: { seen, resized, skipped }, partial };
    }

    return {
      buf: out, changed: true, before: buf.length, after: out.length,
      level: spec.level, method: 'pdf', reason: resized ? 'images_resized' : 'repacked',
      note: resized ? spec.note : LEVELS[0].note,
      images: { seen, resized, skipped }, partial,
    };
  } catch (_) {
    // RULE 1 — every failure ends here with the document intact.
    return { ...base, reason: 'error' };
  }
}

/* --------------------------------------------------------------------------
 * IMAGES + DISPATCH
 * ------------------------------------------------------------------------ */

/** A standalone photo attachment. Delegates entirely to image-fit. */
async function compressImage(buf, opts) {
  const spec = levelSpec((opts || {}).level);
  const base = {
    buf, changed: false, before: buf ? buf.length : 0, after: buf ? buf.length : 0,
    level: spec.level, method: 'image', reason: '', note: spec.note,
    images: { seen: 1, resized: 0, skipped: 1 }, partial: false,
  };
  try {
    if (!buf || !buf.length) return { ...base, reason: 'empty' };
    if (!spec.maxSide) return { ...base, reason: 'nothing_to_compress' };
    const fit = imageFit.fitJpeg(buf, { maxSide: spec.maxSide, quality: spec.quality });
    if (!fit || !fit.changed) return { ...base, reason: fit ? fit.reason || 'no_saving' : 'error' };
    return {
      buf: fit.buf, changed: true, before: fit.bytesBefore, after: fit.bytesAfter,
      level: spec.level, method: 'image', reason: 'resized', note: spec.note,
      images: { seen: 1, resized: 1, skipped: 0 }, partial: false,
    };
  } catch (_) { return { ...base, reason: 'error' }; }
}

/**
 * Compress whatever this is, at one level. The FORMAT comes from the bytes, never from the
 * declared content type — a mislabelled attachment is ordinary and must not send a PDF down the
 * image path.
 */
async function compressOnce(buf, opts) {
  if (!buf || !buf.length) {
    return { buf, changed: false, before: 0, after: 0, level: levelSpec((opts || {}).level).level, method: 'none', reason: 'empty', images: { seen: 0, resized: 0, skipped: 0 }, partial: false, note: '' };
  }
  if (isPdf(buf)) return compressPdf(buf, opts);
  if (imageFit.isJpeg(buf)) return compressImage(buf, opts);
  return {
    buf, changed: false, before: buf.length, after: buf.length,
    level: levelSpec((opts || {}).level).level, method: 'none',
    // A .xlsx / .docx / .zip is already deflate-compressed and a PNG has no decoder here — saying
    // so plainly is the honest answer, and it is NOT a failure.
    reason: 'nothing_to_compress', images: { seen: 0, resized: 0, skipped: 0 }, partial: false, note: '',
  };
}

/**
 * ESCALATE until it fits, or until the levels run out — the "retry harder" the desk offers.
 *
 * It stops at the FIRST level that fits rather than always driving to maximum: a document that fits
 * comfortably at 1600px must not be crushed to 600px just because the loop could. When nothing
 * fits, the SMALLEST result still wins over the original (getting closer is worth having, and the
 * caller may still be able to place it once something else moves to a link).
 *
 * @returns the winning compressOnce result, plus `fits` and `attempts`.
 */
async function compressToFit(buf, targetBytes, opts) {
  const o = opts || {};
  const target = Number(targetBytes) || 0;
  const maxLevel = Math.min(MAX_LEVEL, Math.max(1, Number(o.maxLevel) || MAX_LEVEL));
  const from = Math.min(maxLevel, Math.max(1, Number(o.fromLevel) || 1));
  const deadline = Date.now() + Math.max(2000, Number(o.totalDeadlineMs) || DEFAULT_DEADLINE_MS * 2);
  const attempts = [];
  let best = null;
  for (let lvl = from; lvl <= maxLevel; lvl++) {
    if (Date.now() > deadline) break;
    const r = await compressOnce(buf, { ...o, level: lvl, deadlineMs: Math.max(1500, deadline - Date.now()) });
    attempts.push({ level: lvl, reason: r.reason, after: r.after, changed: r.changed });
    if (r.changed && (!best || r.after < best.after)) best = r;
    if (r.changed && target && r.after <= target) return { ...r, fits: true, attempts };
    // GIVE UP EARLY ONLY WHEN A HIGHER LEVEL PROVABLY CANNOT HELP — and the test for that is the
    // METHOD, never the reason.
    //
    // This was keyed on `reason === 'nothing_to_compress'` and it silently broke every photo. Level
    // 1 is a structural repack, which for an IMAGE is a no-op BY DESIGN — so a JPEG reported
    // 'nothing_to_compress' at level 1, the loop stopped, and levels 2..5 (the ones that actually
    // shrink a picture) never ran. A 6 MB inspection photo came back 6 MB and was dropped from the
    // email, which is the exact class of failure this whole module exists to end. Caught by the
    // end-to-end test, not by the unit tests, because those compressed PDFs.
    //
    // A format we cannot touch at all will not improve at a higher level either.
    if (r.method === 'none') break;
    // Nor will a PDF that turned out to carry no images to shrink.
    if (r.method === 'pdf' && lvl > 1 && r.images && r.images.seen === 0) break;
  }
  if (best) return { ...best, fits: !target || best.after <= target, attempts };
  return {
    buf, changed: false, before: buf ? buf.length : 0, after: buf ? buf.length : 0,
    level: from, method: 'none', reason: 'could_not_compress', note: '',
    images: { seen: 0, resized: 0, skipped: 0 }, partial: false,
    fits: !target || (buf ? buf.length : 0) <= target, attempts,
  };
}

module.exports = {
  compressPdf, compressImage, compressOnce, compressToFit,
  LEVELS, MAX_LEVEL, levelSpec,
  _internals: { isPdf, jpegComponents, imageIsSafeToRewrite, nameOf, filtersOf, MIN_IMAGE_BYTES },
};
