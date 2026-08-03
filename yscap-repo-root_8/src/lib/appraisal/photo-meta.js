'use strict';
/**
 * WHAT THE APPRAISAL XML ITSELF SAYS ABOUT THE PHOTOS (owner-directed 2026-08-02: "I'm sure that
 * the XML does carry some photos because even when we don't upload the PDF you still get some
 * photos … you need to do further digging on the XML structure").
 *
 * THE OWNER'S OBSERVATION IS CORRECT, and here is the mechanism. A MISMO 2.6 appraisal XML carries
 * the ENTIRE report PDF inside itself, base64, as `<EMBEDDED_FILE _Type="PDF"><DOCUMENT>…`. So an
 * XML-only import already yields photographs: `xml.embeddedPdfBase64()` lifts that PDF out and the
 * photos are mined from it. Nothing was ever read off an uploaded PDF that could not also be read
 * from the XML alone.
 *
 * What the XML additionally carries — and what PILOT had been throwing away — is the appraiser's
 * OWN LABELS for those photos:
 *   • `<FORM AppraisalReportContentType="SubjectPhotos|SalePhotos|RentalPhotos|LocationMap|Sketch|
 *      Exhibit|CoverPage|…">` — the authoritative photo GROUP, present on every vendor that emits
 *     photo metadata at all;
 *   • `<IMAGE _Identifier="SubjectFront|SubjectRear|SubjectStreet|ComparablePhoto1|Photo3|Sketch|…"
 *      _CaptionComment="…" _Name="HasImage|NoImage|AppraisalForm">` — the per-photo SLOT.
 * Measured across the 21-file corpus (docs/appraisal-xml/photos-comps-variation.md): ~40% of files
 * carry this metadata (ClickFORMS richest, ACI partial, a la mode none), it is METADATA-ONLY there
 * — `<IMAGE>` has no `<DOCUMENT>` child — and `_Name="NoImage"` marks an EMPTY slot.
 *
 * Two things this module makes possible, both strictly additive:
 *   1. `embeddedImages(xml)` — a vendor that DOES ship per-photo pixels (an `<EMBEDDED_FILE>` whose
 *      type is an image rather than the PDF) is now read directly, with its label attached. The
 *      corpus we measured has none, but the corpus is 4 vendors and the field has more; reading
 *      them costs nothing and a vendor we have not seen stops being a blank gallery.
 *   2. `photoSlots(xml)` — the ordered, labelled slot list, used to NAME the photos mined from the
 *      PDF (and so to identify the subject FRONT shot with certainty rather than by position).
 *      Alignment is strict — see `labelPhotos()`; a mismatch labels nothing rather than guessing.
 *
 * Pure and dependency-free. Payload extraction is REGEX, never the DOM: a `<DOCUMENT>` blob is
 * multi-megabyte and `xml.parse()` deliberately drops text so those blobs stream past cheaply.
 * Nothing here throws — a malformed XML yields an empty list.
 */

// ---- slot classification ---------------------------------------------------
// The photo GROUPS a report contains. `photo:true` means "a picture of the world" (the property,
// a comp, a room) — the things that may be the main picture. Everything else is a drawing, a map
// or a certificate: kept, labelled honestly, never the hero.
const GROUPS = Object.freeze({
  subject: { photo: true }, comparable: { photo: true }, rental: { photo: true },
  interior: { photo: true }, map: { photo: false }, sketch: { photo: false },
  exhibit: { photo: false }, cover: { photo: false }, other: { photo: true },
});

// `FORM/@AppraisalReportContentType` → group. The authoritative signal (rule 1 in the research).
const FORM_GROUP = Object.freeze({
  subjectphotos: 'subject', salephotos: 'comparable', comparablephotos: 'comparable',
  rentalphotos: 'rental', locationmap: 'map', map: 'map', sketch: 'sketch', floorplan: 'sketch',
  exhibit: 'exhibit', coverpage: 'cover',
});

function norm(s) { return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]/g, ''); }

/**
 * `IMAGE/@_Identifier` → group (rule 2 — the fallback when the FORM carries no content type).
 * Order matters: `subjectfront` must be tested before the generic `subject` prefix.
 */
function groupFromIdentifier(idRaw) {
  const id = norm(idRaw);
  if (!id) return null;
  if (id.startsWith('subject')) return 'subject';
  if (id.startsWith('comparable') || id.startsWith('salescomp') || id.startsWith('salecomp')) return 'comparable';
  if (id.startsWith('rental')) return 'rental';
  if (id.startsWith('locationmap') || id === 'map') return 'map';
  if (id.startsWith('sketch') || id.startsWith('floorplan')) return 'sketch';
  if (id.startsWith('exhibit')) return 'exhibit';
  if (id.startsWith('cover')) return 'cover';
  // `Photo1..6` / `ExtraPhoto1..6` are the interior / misc subject shots.
  if (id.startsWith('photo') || id.startsWith('extraphoto')) return 'interior';
  return null;
}

/** Is this the FRONT shot of the subject — the one picture that IS the property? */
function isSubjectFront(idRaw) {
  const id = norm(idRaw);
  return id === 'subjectfront' || id === 'frontofsubject' || id === 'subjectfrontview' || id === 'front';
}

/** A stable, human-readable category for storage/display. */
function categoryFor(slot) {
  if (!slot) return null;
  if (slot.subjectFront) return 'subject_front';
  return slot.group || null;
}

// ---- attribute reading (regex, on an open tag's text) ----------------------
function attrOf(tagText, name) {
  const re = new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*=\\s*("([^"]*)"|\'([^\']*)\')', 'i');
  const m = re.exec(tagText || '');
  if (!m) return null;
  const v = m[2] !== undefined ? m[2] : m[3];
  return v == null || String(v).trim() === '' ? null : v;
}

// Every tag we care about, in document order. `[^>]*` can never run into a base64 payload because
// base64 contains no '<' or '>', so this stays a linear scan even on a 30 MB file.
const TAG_RE = /<(FORM|IMAGE|EMBEDDED_FILE)\b([^>]*)>/gi;

/**
 * Walk the XML once, yielding each FORM / IMAGE / EMBEDDED_FILE with the FORM and IMAGE currently
 * in scope. Shared by both readers so their idea of "which slot is this" cannot drift.
 */
function walk(xml, onTag) {
  const s = String(xml || '');
  let form = null, image = null, m;
  TAG_RE.lastIndex = 0;
  while ((m = TAG_RE.exec(s)) !== null) {
    const tag = m[1].toUpperCase(), text = m[2] || '';
    if (tag === 'FORM') { form = text; image = null; continue; }
    if (tag === 'IMAGE') { image = text; onTag('IMAGE', text, { form, image: text, at: m.index, end: TAG_RE.lastIndex }); continue; }
    onTag('EMBEDDED_FILE', text, { form, image, at: m.index, end: TAG_RE.lastIndex });
  }
}

function slotFrom(formText, imageText) {
  const identifier = attrOf(imageText, '_Identifier');
  const caption = attrOf(imageText, '_CaptionComment');
  const contentType = attrOf(formText, 'AppraisalReportContentType');
  const otherDesc = attrOf(formText, 'TypeOtherDescription');
  // The FORM's own name ("Photo Comparables 4-5-6") is what disambiguates a
  // per-block photo ordinal — see compSeqFromSlot below.
  const formName = attrOf(formText, 'AppraisalReportContentName');
  // FORM content type first (present on every vendor that emits metadata), then the identifier.
  let group = FORM_GROUP[norm(contentType)] || null;
  if (group === null && norm(contentType) === 'other') group = groupFromIdentifier(identifier) || (norm(otherDesc) === 'map' ? 'map' : 'other');
  if (group === null) group = groupFromIdentifier(identifier);
  if (group === null) group = 'other';
  const subjectFront = group === 'subject' && isSubjectFront(identifier);
  return { identifier, caption, contentType, formName, group, subjectFront, photo: !!(GROUPS[group] || GROUPS.other).photo };
}

/**
 * WHICH COMPARABLE IS THIS A PHOTO OF? — from the appraiser's own slot label.
 *
 * Two numbering schemes exist in the wild and they disagree:
 *   • `Sales Comp 7 - Photo` (Appraise-It) — numbered GLOBALLY, never reset. The
 *     number in the identifier IS the comp number.
 *   • `ComparablePhoto1..3` (ClickFORMS/ACI) — RESET to 1 inside every SalePhotos
 *     block, and the block is named by the FORM ("Photo Comparables 4-5-6"). The
 *     real comp number is the block's first number plus the ordinal minus one.
 *
 * When the identifier is block-relative and the FORM name carries no number, the
 * ordinal is AMBIGUOUS — comp 2 of which block? — and this returns null rather
 * than guess. The same discipline as labelPhotos: a photo pinned to the wrong
 * house is worse than a photo with no house.
 *
 * @returns {number|null} the 1-based comparable number
 */
function compSeqFromSlot(slot) {
  if (!slot || slot.group !== 'comparable') return null;
  const id = String(slot.identifier || '');
  const n = /(\d+)/.exec(norm(id));
  if (!n) return null;
  const ordinal = parseInt(n[1], 10);
  if (!(ordinal > 0 && ordinal < 100)) return null;
  const key = norm(id);
  // A GLOBAL scheme names the comp directly ("salescomp7photo", "salecomp4").
  if (/^(salescomp|salecomp|comparablesale)\d+/.test(key)) return ordinal;
  // A BLOCK-RELATIVE scheme ("comparablephoto2") needs the block's offset.
  const first = /(\d+)/.exec(String(slot.formName || ''));
  if (!first) return null;
  const offset = parseInt(first[1], 10);
  if (!(offset > 0 && offset < 100)) return null;
  return offset + ordinal - 1;
}

/**
 * The comparable a photo's CAPTION names, matched by address.
 *
 * The corpus research calls this the only RELIABLE cross-check, and it is: a comp
 * photo's caption is the comp's own address ("322 Howard Ave/New Haven, CT 06519"),
 * so it identifies the property directly instead of relying on an ordinal that two
 * vendors number two different ways. Tried FIRST; the ordinal is the fallback.
 *
 * Address comparison goes through the research warehouse's own key, so "the same
 * address" means exactly one thing across this whole system.
 *
 * @param {string} caption
 * @param {Array<{seq,address,city,state,zip}>} comps
 * @returns {string|null} the matching comp's `seq`
 */
function compSeqFromCaption(caption, comps) {
  const cap = String(caption == null ? '' : caption).trim();
  if (!cap || !Array.isArray(comps) || !comps.length) return null;
  let K;
  try { K = require('../research/property-key'); } catch (_) { return null; }
  // Captions separate the street from the locality with '/' as often as with ','.
  const key = K.propertyKey(cap.replace(/\s*\/\s*/g, ', '));
  if (!key) return null;
  let hit = null;
  for (const c of comps) {
    const ck = K.propertyKey({ street: c.address, city: c.city, state: c.state, zip: c.zip });
    if (!ck || ck !== key) continue;
    if (hit) return null;                 // two comps with one address — refuse to pick
    hit = c;
  }
  return hit ? String(hit.seq) : null;
}

/**
 * The ordered list of real photo SLOTS the report declares — metadata only, no pixels.
 * Skips `_Name="NoImage"` (an empty slot) and `_Name="AppraisalForm"` (the PDF wrapper, not a
 * photo). Returns [] on a file with no photo metadata, which is ~60% of them.
 */
function photoSlots(xml) {
  const out = [];
  try {
    walk(xml, (tag, text, ctx) => {
      if (tag !== 'IMAGE') return;
      const name = norm(attrOf(text, '_Name'));
      if (name === 'noimage' || name === 'appraisalform') return;
      out.push(slotFrom(ctx.form, text));
    });
  } catch (_) { return []; }
  return out;
}

// An EMBEDDED_FILE that is an IMAGE rather than the report PDF.
const IMAGE_TYPES = /^(jpe?g|png|gif|tiff?|bmp)$/i;
function imageMimeOf(tagText) {
  const mime = attrOf(tagText, 'MIMEType');
  if (mime && /^image\//i.test(mime)) return mime.toLowerCase();
  const t = attrOf(tagText, '_Type');
  if (t && IMAGE_TYPES.test(String(t).trim())) {
    const k = String(t).trim().toLowerCase();
    return 'image/' + (k === 'jpg' ? 'jpeg' : k === 'tif' ? 'tiff' : k);
  }
  return null;
}

/** Magic-byte sniff — the AUTHORITY on what the bytes are, over any attribute the vendor wrote. */
function sniffImageMime(buf) {
  if (!buf || buf.length < 4) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'image/gif';
  if ((buf[0] === 0x49 && buf[1] === 0x49) || (buf[0] === 0x4d && buf[1] === 0x4d)) return 'image/tiff';
  if (buf[0] === 0x42 && buf[1] === 0x4d) return 'image/bmp';
  return null;
}

/**
 * Per-photo PIXELS shipped in the XML, when a vendor ships them: every `<EMBEDDED_FILE>` whose type
 * is an image, with the label of the `<IMAGE>`/`<FORM>` it sits under. Returns [] for the common
 * case (only the PDF is embedded), so the PDF path below is untouched.
 * @returns {Array<{base64,mime,identifier,caption,group,subjectFront,photo}>}
 */
function embeddedImages(xml) {
  const s = String(xml || '');
  const out = [];
  try {
    walk(s, (tag, text, ctx) => {
      if (tag !== 'EMBEDDED_FILE') return;
      const mime = imageMimeOf(text);
      if (!mime) return;                                   // the report PDF, or an unknown type
      const open = s.indexOf('<DOCUMENT>', ctx.end);
      if (open === -1) return;
      const close = s.indexOf('</DOCUMENT>', open);
      if (close === -1) return;
      const b64 = s.slice(open + 10, close).replace(/\s+/g, '');
      // A stripped/placeholder corpus writes "[BASE64 N chars stripped]" — never a payload; that
      // explicit test is the real guard. The length floor only rejects an empty or truncated blob
      // (deliberately low: what makes these bytes an image is the MAGIC-BYTE sniff at the storage
      // step, not their size, and a small-but-valid image is a real image).
      if (!b64 || /\[BASE64/i.test(b64) || b64.length < 64) return;
      out.push(Object.assign({ base64: b64, mime }, slotFrom(ctx.form, ctx.image)));
    });
  } catch (_) { return []; }
  return out;
}

/**
 * Name the photographs mined from the PDF using the XML's own slot list.
 *
 * STRICT BY DESIGN: the labels are applied ONLY when the number of declared photo slots equals the
 * number of photographs extracted, so position means the same thing on both sides. Anything else —
 * no metadata (60% of files), a de-duplicated repeat, an extra image in the PDF — labels NOTHING
 * and leaves the pixel-based classification to stand. A wrong label on the property's main picture
 * is exactly the bug this whole change exists to fix, so a guess is worse than no label.
 *
 * @param {Array} photos   the extracted set, in order, each carrying kind:'photo'|'graphic'
 * @param {Array} slots    photoSlots(xml)
 * @returns {{applied:boolean, reason:string, photos:Array}}  photos are new objects, never mutated
 */
function labelPhotos(photos, slots) {
  const ph = Array.isArray(photos) ? photos : [];
  const sl = Array.isArray(slots) ? slots : [];
  if (!ph.length) return { applied: false, reason: 'no photos', photos: ph };
  if (!sl.length) return { applied: false, reason: 'the XML declares no photo slots', photos: ph };
  const shots = ph.filter((p) => p && p.kind !== 'graphic');
  if (shots.length !== sl.length) {
    return { applied: false, reason: `the XML declares ${sl.length} photo slot(s) but ${shots.length} photograph(s) were extracted — not labelled rather than mislabelled`, photos: ph };
  }
  let i = 0;
  const out = ph.map((p) => {
    if (!p || p.kind === 'graphic') return p;
    const slot = sl[i++];
    return Object.assign({}, p, {
      category: categoryFor(slot),
      caption: slot.caption || null,
      identifier: slot.identifier || null,
      formName: slot.formName || null,
      compSeq: compSeqFromSlot(slot),
      // A slot the XML calls a map/sketch/exhibit is NOT a photograph, whatever the pixels said —
      // the appraiser's own label beats our inference when we have it.
      kind: slot.photo ? 'photo' : 'graphic',
    });
  });
  return { applied: true, reason: 'labelled from the XML', photos: out };
}

/**
 * The index of the photo that should be the MAIN PICTURE, or -1. Prefers the slot the appraiser
 * labelled as the subject's FRONT, then any subject photo, then the first photograph.
 */
function heroIndex(photos) {
  const ph = Array.isArray(photos) ? photos : [];
  let front = -1, subject = -1, first = -1;
  for (let i = 0; i < ph.length; i++) {
    const p = ph[i]; if (!p || p.kind === 'graphic') continue;
    if (first === -1) first = i;
    if (subject === -1 && p.category === 'subject') subject = i;
    if (front === -1 && p.category === 'subject_front') front = i;
  }
  return front !== -1 ? front : subject !== -1 ? subject : first;
}

module.exports = {
  photoSlots, embeddedImages, labelPhotos, heroIndex, sniffImageMime, categoryFor,
  compSeqFromSlot, compSeqFromCaption,
  _internals: { slotFrom, groupFromIdentifier, isSubjectFront, attrOf, imageMimeOf, GROUPS },
};
