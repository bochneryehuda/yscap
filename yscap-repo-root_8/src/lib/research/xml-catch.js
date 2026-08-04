'use strict';
/**
 * EVERY APPRAISAL XML THAT ENTERS PILOT, FROM ANY DOOR, ALSO FEEDS THE RESEARCH
 * WAREHOUSE — with all of its comparables (owner-directed 2026-08-04; db/462).
 *
 * The owner: "anybody that is importing a XML into any file in the system or saving
 * an XML into the appraisal condition, that XML should be imported also into the
 * property resource at the same time and bringing in all the comparables into the
 * system."
 *
 * WHAT WAS ACTUALLY BROKEN. The warehouse had exactly two feeds — an appraisal that
 * imported CLEANLY onto a loan file (`appraisal/desk.fireResearchIngest`), and the
 * hand-upload screen (`research/xml-import`). Everything else stored the bytes and
 * threw the market data away, and none of it was rare:
 *
 *   1. A BORROWER attaching the appraisal data file to their own condition. That
 *      door (`POST /api/borrower/documents`) has no appraisal detection at all.
 *   2. A STAFFER filing an XML anywhere except the appraisal condition's XML slot.
 *      The auto-import is gated on the slot LABEL matching /xml/i AND the condition
 *      being `rtl_cond_appraisaldocs`, so a free-form add, a differently-named slot,
 *      or the same file on any other condition filed bytes only.
 *   3. A DOCUMENT SLOTTED AFTERWARDS. Uploading first and naming the slot second is
 *      the ordinary way people work, and the slot route only ever ran an UPDATE.
 *   4. AN APPRAISAL IMPORT THAT FAILED. The desk import does a great deal more than
 *      read a grid — conditions, findings, photos, a reprice — and any of it failing
 *      took the comparables down with it, even though the grid itself read fine.
 *
 * THE FIX IS ONE CHOKEPOINT, NOT FOUR PATCHES. Every door that can put bytes in the
 * building calls `fireCatch` with them; this module decides whether they are an
 * appraisal and, if so, files them through the SAME `xml-import.importXml` a hand
 * upload uses. A report is therefore filed identically no matter which door it came
 * through — which is the whole point, because a search cannot be trusted if half the
 * market was filed one way and half another.
 *
 * FIVE THINGS IT WILL NOT DO:
 *
 *  1. IT NEVER TOUCHES THE LOAN FILE. No `appraisals` row, no condition, no finding,
 *     no notification, no reprice, no value written anywhere near a deal. It writes
 *     ONLY into the research warehouse. This is deliberate and is the reason it can
 *     safely run on every upload: the appraisal DESK — which does all of those things
 *     — stays exactly as gated as it was, because deciding a file's official
 *     appraisal is a judgement, and filing a comparable sale is not.
 *  2. IT NEVER THROWS, and it never runs on the request path. Every door fires it and
 *     forgets it; an upload can never be slowed down or failed by the warehouse.
 *  3. IT NEVER STORES A REPORT TWICE. Keyed on the sha256 of the bytes, and it stands
 *     down against a copy already filed. The loan-file copy always wins — it carries
 *     the photographs (`ingest.retireDuplicateImports` settles it from the other side
 *     when the file's copy lands second).
 *  4. IT NEVER GUESSES WHAT A FILE IS. The "is this an appraisal?" test reuses the
 *     appraisal parser's OWN `detectMismo`, so this module and the import screen can
 *     never disagree about what an appraisal report is. Anything else is left alone
 *     in silence — no ledger row, no error, nothing.
 *  5. IT NEVER LOSES A REPORT TO A FOREIGN KEY. `research_imports.uploaded_by` points
 *     at `staff_users`, and half these doors are borrower doors. See `staffUploader`.
 */
const crypto = require('crypto');
const XI = require('./xml-import');
const { _internals: EX } = require('../appraisal/extract');

/** Matches `xml-import`'s own ceiling — above this the parser will not read it either. */
const MAX_XML_BYTES = 80 * 1024 * 1024;

/**
 * How much of a file the cheap sniff reads before deciding.
 *
 * A MISMO 2.6 appraisal carries the whole report PDF inside itself, base64, so a real
 * one runs to tens of megabytes — but the two markers that identify it (the
 * VALUATION_RESPONSE root and the REPORT element's AppraisalFormType) are in the first
 * few hundred bytes, because they ARE the root and its first child. Two megabytes is
 * therefore enormous headroom for the format we actually read, and it keeps the common
 * case off the "decode thirty megabytes into a JavaScript string" path.
 *
 * When the head is INCONCLUSIVE the whole file is scanned rather than the report being
 * dropped — a missed appraisal is the expensive direction, and a wasted scan is not.
 */
const SNIFF_BYTES = 2 * 1024 * 1024;

const sha256 = (b) => crypto.createHash('sha256')
  .update(Buffer.isBuffer(b) ? b : Buffer.from(String(b), 'utf8')).digest('hex');

// The MISMO 2.6 root PILOT reads, and the attribute its parser reads first. Both are
// namespace-tolerant in the same way `detectMismo` is, because a vendor prefixing the
// document is a formatting choice and never a different format.
const RE_VALUATION_RESPONSE = /<(?:[A-Za-z_][\w.-]*:)?VALUATION_RESPONSE[\s>]/i;
const RE_APPRAISAL_FORM_TYPE = /\bAppraisalFormType\s*=/i;

/**
 * IS THIS EVEN AN XML FILE? Deliberately generous: a file named `.xml`, a content type
 * that says xml (`text/xml`, `application/xml`, `application/mismo+xml`), or bytes that
 * simply open with a tag. Generosity is free here because nothing is claimed on the
 * strength of it — an appraisal MARKER still has to be found before anything happens.
 * PURE.
 */
function looksLikeXmlContainer({ filename, contentType, head }) {
  if (/\.xml$/i.test(String(filename || '').trim())) return true;
  if (/(^|[/+])xml\b/i.test(String(contentType || ''))) return true;
  return /^﻿?\s*<(?:\?xml[\s?]|[A-Za-z_])/.test(String(head || ''));
}

/**
 * IS THERE AN APPRAISAL IN HERE? Three independent pieces of evidence, each with its
 * own reason for being trusted:
 *
 *   `VALUATION_RESPONSE` — the root element of the MISMO 2.6 format PILOT reads. Its
 *      presence at the top of a file is as close to proof as a sniff gets.
 *   `AppraisalFormType`  — the REPORT attribute `extract()` reads first (FNM1004 /
 *      1025 / 1073). Nothing else in a lending system carries it.
 *   `detectMismo(...).hasGrid` — a comparable-sales grid. This is the appraisal
 *      parser's OWN definition of "there is an appraisal in here at all", reused
 *      rather than restated, and it is what catches the formats we do not yet read
 *      (UAD 3.6 / MISMO 3.x) so they are RECORDED as held rather than silently lost.
 *
 * AND IT IS WHAT KEEPS THE LOAN-APPLICATION EXPORTS OUT. An Encompass iLAD file is
 * MISMO, is XML, and is not an appraisal — it carries no grid and neither marker — so
 * it is ignored in silence rather than filling the ledger with refusals. That is the
 * same distinction `detectMismo` was written to draw, which is exactly why it is
 * reused here instead of a second opinion being invented.
 *
 * PURE. Returns `{ maybe, why }` — `why` names the evidence, or its absence, in words
 * a person can read back.
 */
function looksLikeAppraisalXml(bytes, { filename = null, contentType = null } = {}) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(String(bytes == null ? '' : bytes), 'utf8');
  if (!buf.length) return { maybe: false, why: 'the file was empty' };

  // latin1 for the sniff: marker matching is pure ASCII, and it will not mangle a
  // multi-byte sequence that happens to straddle the window edge the way a truncated
  // utf8 decode can.
  const head = buf.slice(0, SNIFF_BYTES).toString('latin1');
  if (!looksLikeXmlContainer({ filename, contentType, head })) {
    return { maybe: false, why: 'not an XML file' };
  }

  const evidence = (s) => {
    if (RE_VALUATION_RESPONSE.test(s)) return 'a MISMO VALUATION_RESPONSE';
    if (RE_APPRAISAL_FORM_TYPE.test(s)) return 'an appraisal form type';
    let d = null;
    try { d = EX.detectMismo(s); } catch (_) { /* the sniff never throws */ }
    if (d && d.hasGrid) return 'a comparable sales grid';
    return null;
  };

  let found = evidence(head);
  // Inconclusive head on a file bigger than the window: read the rest before giving
  // up. Only reachable for a large XML carrying none of the three markers in its
  // first two megabytes, which no MISMO 2.6 report can be.
  if (!found && buf.length > SNIFF_BYTES) found = evidence(buf.toString('latin1'));

  return found
    ? { maybe: true, why: `it carries ${found}` }
    : { maybe: false, why: 'an XML file with no appraisal in it' };
}

/**
 * HAS THIS EXACT FILE ALREADY BEEN FILED? Keyed on the bytes, so the same report
 * arriving by two doors — or the same document re-slotted three times — does the work
 * once.
 *
 * An `error` row is deliberately NOT treated as settled: a report that failed for a
 * transient reason deserves another chance, and a format we cannot read yet (UAD 3.6)
 * should fold itself in the day a reader ships. The BACK-BOOK SWEEP does not re-read
 * it every boot regardless, because its own drain stamp is on the DOCUMENT.
 */
async function alreadyFiled(db, hash) {
  try {
    const r = await db.query(
      `SELECT id, status FROM research_imports WHERE sha256 = $1 LIMIT 1`, [hash]);
    const row = r.rows[0];
    return row && (row.status === 'ok' || row.status === 'skipped') ? row : null;
  } catch (_) {
    // Never let the shortcut's failure stop the real work — at worst the report is
    // re-filed, which `importXml` handles by refreshing its own rows.
    return null;
  }
}

/**
 * `research_imports.uploaded_by` REFERENCES `staff_users(id)`, and half the doors
 * calling this module are BORROWER doors whose actor id is a borrower. Passing one
 * through would raise a foreign-key violation inside the import and lose the whole
 * report over a bookkeeping column — so an id is confirmed to be a staff user before
 * it is used, and anything else is recorded as nobody.
 *
 * A cheap primary-key lookup, and it fails toward null.
 */
async function staffUploader(db, id) {
  if (!id) return null;
  try {
    const r = await db.query(`SELECT 1 FROM staff_users WHERE id = $1`, [id]);
    return r.rows.length ? id : null;
  } catch (_) { return null; }
}

/**
 * Catch one document's bytes.
 *
 * NEVER THROWS — every outcome comes back shaped, because this runs behind a
 * fire-and-forget in the middle of an upload and in a loop inside the back-book sweep.
 *
 * @param {{query:Function, getClient?:Function}} db
 * @param {object} o
 * @param {Buffer|string} o.bytes            the file itself
 * @param {string}  [o.filename]
 * @param {string}  [o.contentType]
 * @param {string}  [o.documentId]           for the log line only — nothing is written to it
 * @param {string}  [o.uploadedByStaffId]    a STAFF id, or null. Named so a borrower id
 *                                           cannot be passed by habit; verified anyway.
 * @param {string}  [o.why]                  how it arrived, recorded on the ledger row
 * @returns {Promise<{considered, attempted, filed, status, reason, importId, comparables, properties, observations}>}
 */
async function catchDocumentXml(db, {
  bytes, filename = null, contentType = null, documentId = null,
  uploadedByStaffId = null, why = 'upload',
} = {}) {
  const out = {
    considered: false, attempted: false, filed: false,
    status: null, reason: null, importId: null,
    comparables: 0, properties: 0, observations: 0,
  };
  try {
    const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(String(bytes == null ? '' : bytes), 'utf8');
    if (!buf.length) { out.reason = 'the file was empty'; return out; }
    if (buf.length > MAX_XML_BYTES) {
      // The parser refuses it too, so this is the same answer said sooner.
      out.reason = 'larger than any appraisal data file we have seen';
      return out;
    }

    const look = looksLikeAppraisalXml(buf, { filename, contentType });
    if (!look.maybe) { out.reason = look.why; return out; }
    out.considered = true;

    const hash = sha256(buf);
    const seen = await alreadyFiled(db, hash);
    if (seen) {
      out.importId = seen.id;
      out.status = seen.status;
      out.filed = seen.status === 'ok';
      out.reason = 'this exact report is already in the database';
      return out;
    }

    out.attempted = true;
    const r = await XI.importXml(db, {
      xml: buf.toString('utf8'),
      filename,
      uploadedBy: await staffUploader(db, uploadedByStaffId),
      source: why,
    });
    out.importId = (r && r.importId) || null;
    out.status = (r && r.status) || 'error';
    out.filed = !!(r && r.ok);
    out.reason = (r && r.reason) || null;
    out.comparables = (r && r.comparables) || 0;
    out.properties = (r && r.properties) || 0;
    out.observations = (r && r.observations) || 0;
    return out;
  } catch (e) {
    out.status = 'error';
    out.reason = (e && e.message) || String(e);
    return out;
  }
}

/**
 * Catch a document that is already stored, by id — the door for a slot renamed after
 * the fact, and the one the back-book sweep uses.
 *
 * The read is allowed to FAIL LOUDLY into the result (`readFailed`) rather than being
 * flattened into "not an appraisal", because the sweep must be able to tell the two
 * apart: a file it could not read has to be tried again, and a file it read and
 * decided about must not be.
 */
async function catchDocumentById(db, documentId, { why = 'stored document' } = {}) {
  const out = {
    considered: false, attempted: false, filed: false, readFailed: false,
    status: null, reason: null, importId: null, comparables: 0, properties: 0, observations: 0,
  };
  let row;
  try {
    row = (await db.query(
      `SELECT id, filename, content_type, size_bytes, storage_provider, storage_ref
         FROM documents WHERE id = $1`, [documentId])).rows[0];
  } catch (e) {
    out.readFailed = true;
    out.reason = `the document could not be looked up (${(e && e.message) || e})`;
    return out;
  }
  if (!row) { out.reason = 'no such document'; return out; }
  if (!row.storage_ref) { out.reason = 'the document has no stored copy'; return out; }

  // The cheapest possible refusal: the name and the type say it is not XML, so the
  // bytes never have to be read at all. `looksLikeAppraisalXml` would answer the same
  // way — this only spares the download.
  if (!looksLikeXmlContainer({ filename: row.filename, contentType: row.content_type, head: '' })) {
    out.reason = 'not an XML file';
    return out;
  }
  if (Number(row.size_bytes) > MAX_XML_BYTES) {
    out.reason = 'larger than any appraisal data file we have seen';
    return out;
  }

  let buf;
  try {
    // The document's OWN provider, not whatever the process defaults to — see
    // `storage.forRow`. A 'local' row mid-S3-migration is on disk, and reading it
    // through S3 would 404 and be recorded as a failure that is not one.
    buf = await require('../storage').forRow(row).read(row.storage_ref);
  } catch (e) {
    out.readFailed = true;
    out.reason = `the stored copy could not be read (${(e && e.message) || e})`;
    return out;
  }

  const r = await catchDocumentXml(db, {
    bytes: buf, filename: row.filename, contentType: row.content_type,
    documentId: row.id, why,
  });
  return { ...out, ...r, readFailed: false };
}

/**
 * FIRE AND FORGET — what every upload door actually calls.
 *
 * Runs on `setImmediate` so the response is never waiting on it, takes its own
 * connection off the pool (the caller's may be inside a transaction that is about to
 * commit, or already released), and swallows everything. A warehouse hiccup must never
 * be visible to somebody uploading a document.
 */
function fireCatch(opts = {}) {
  setImmediate(() => {
    (async () => {
      const db = require('../../db');
      const r = await catchDocumentXml(db, opts);
      if (r.attempted) {
        console.log(`[research-xml] ${opts.why || 'upload'}: ${r.filed ? 'filed' : `not filed (${r.reason || 'no reason given'})`}`
          + (r.filed ? ` — ${r.comparables} comparable${r.comparables === 1 ? '' : 's'}, ${r.properties} propert${r.properties === 1 ? 'y' : 'ies'}` : ''));
      }
    })().catch((e) => console.error('[research-xml] catch failed (non-fatal):', (e && e.message) || e));
  });
}

/** The same, for a document already in storage. */
function fireCatchById(documentId, why = 'stored document') {
  if (!documentId) return;
  setImmediate(() => {
    (async () => {
      const db = require('../../db');
      const r = await catchDocumentById(db, documentId, { why });
      if (r.attempted) {
        console.log(`[research-xml] ${why}: ${r.filed ? `filed — ${r.comparables} comparables` : `not filed (${r.reason || 'no reason given'})`}`);
      }
    })().catch((e) => console.error('[research-xml] catch-by-id failed (non-fatal):', (e && e.message) || e));
  });
}

module.exports = {
  looksLikeAppraisalXml, catchDocumentXml, catchDocumentById, fireCatch, fireCatchById,
  MAX_XML_BYTES,
  _internals: { looksLikeXmlContainer, alreadyFiled, staffUploader, SNIFF_BYTES },
};
