'use strict';
/**
 * IMPORT AN APPRAISAL XML STRAIGHT INTO THE RESEARCH DATABASE — no loan file
 * (db/411; the owner's "we should be able to manually add XML appraisal reports to
 * build up our database", single or bulk).
 *
 * The warehouse is fed automatically by every appraisal that lands on a loan file.
 * This is the OTHER door: an old export folder, a report on a deal we never wrote,
 * a hundred XMLs dragged in at once. Those reports carry exactly the same market
 * data — comparable sales, conditions, sizes, dates, the appraiser — and the whole
 * point of the database is that more of them makes every future comp search better.
 *
 * IT IS THE SAME READ, DELIBERATELY. The report is parsed by the SAME `extract()`
 * the loan-file desk uses, shaped by the SAME `appraisalRowFrom`/`comparableRowFrom`
 * mapping, and written by the SAME `ingest.writeReport`. Nothing about a fact
 * depends on which door it came through — if it did, the search could not be
 * trusted, because half the market would be filed differently from the other half.
 *
 * FOUR THINGS IT WILL NOT DO:
 *
 *  1. It never creates a loan file, an application, an `appraisals` row, a
 *     condition, a finding or a notification. It writes ONLY into the research
 *     warehouse. An uploaded report cannot affect a single deal.
 *
 *  2. It never stores the report twice. The upload is keyed on the sha256 of the
 *     XML bytes, so the same file dropped in again REFRESHES its own rows instead
 *     of adding a second copy of every property.
 *
 *  3. It never competes with a loan file's copy of the same report. Before writing
 *     anything it asks whether this exact report — same property, same effective
 *     date, same appraiser — is already here from a file, and stands down if so.
 *     (The reverse case, where the file copy arrives later, is handled on the other
 *     side by `ingest.retireDuplicateImports`.)
 *
 *  4. It never guesses. A file that is not a readable appraisal — UAD 2.6 (MISMO
 *     2.6) or UAD 3.6 (MISMO 3.6), both read by the same `extract()` — is
 *     recorded with the parser's own reason, in words, and nothing is written.
 */
const crypto = require('crypto');
const { extract } = require('../appraisal/extract');
const { appraisalRowFrom, comparableRowFrom } = require('../appraisal/import');
const ingest = require('./ingest');
const K = require('./property-key');
const ID = require('./identity');

// A MISMO appraisal data file carries the whole report PDF inside itself, base64,
// so a real one runs to tens of megabytes. This ceiling is well above anything the
// corpus has shown and exists only so a wrong file (a video, a disk image) is
// refused with a sentence instead of being parsed until the process runs out of
// memory.
const MAX_XML_BYTES = 80 * 1024 * 1024;

/** The jsonb columns `appraisalRowFrom` serialises for the driver. */
const JSONB_COLS = ['utilities', 'updates', 'amenities', 'rent_included_utilities',
  'market_trends', 'present_land_use', 'off_site_improvements', 'comp_research'];

const sha256 = (s) => crypto.createHash('sha256').update(Buffer.isBuffer(s) ? s : Buffer.from(String(s), 'utf8')).digest('hex');

/**
 * Turn the parsed report into the row SHAPES the warehouse writer expects.
 *
 * `appraisalRowFrom` is built for a database INSERT, so its jsonb values arrive as
 * JSON strings. Here the row is consumed in memory instead, and the ingest reads
 * some of those values straight into the observation's `facts` — a JSON string
 * landing there would store the text of an object rather than the object. So they
 * are read back out. PURE: no database.
 */
function shapeReport(A) {
  const a = appraisalRowFrom(A, {});
  for (const k of JSONB_COLS) {
    if (typeof a[k] === 'string') {
      try { a[k] = JSON.parse(a[k]); } catch (_) { /* leave the text as-is rather than lose it */ }
    }
  }
  // The rent schedule normally lives in `appraisal_units`, which only exists for a
  // loan-file import. Carry it on the row so a 1025's unit mix and market rent are
  // not silently lost on an upload.
  a._units = A.units || [];
  a.id = null;
  a.application_id = null;
  const comps = (A.comparables || []).map((c) => {
    const row = comparableRowFrom(c, A.formType);
    // In the database `adjustments` is jsonb and reads back as an array; the ingest
    // mines a comp's year built / lot / style out of those lines, so it must be one.
    if (typeof row.adjustments === 'string') {
      try { row.adjustments = JSON.parse(row.adjustments); } catch (_) { row.adjustments = []; }
    }
    row.id = null;
    return row;
  });
  // THE RENT SCHEDULE (db/435), shaped for the same writer. The upload door has
  // no `appraisals` row for the ingest to read these back from, so it hands them
  // over the way it hands over the sales comparables. Column names, not the
  // parser's camelCase — `writeReport` reads a database row.
  const rentals = (A.rentalComps || []).filter((r) => !r.isSubject).map((r) => ({
    seq: r.seq, is_subject: false,
    address: r.address, city: r.city, state: r.state, zip: r.zip, proximity: r.proximity,
    monthly_rent: r.monthlyRent, rent_per_gba: r.rentPerGba, gba_sqft: r.gba,
    rent_controlled: r.rentControlled, data_source: r.dataSource,
    lease_terms: r.leaseTerms, utilities_included: r.utilitiesIncluded, location_code: r.locationCode,
    condition_uad: r.conditionUad, condition_text: r.conditionText,
    age_years: r.ageYears,
    year_built: Number.isFinite(Number(r.yearBuilt)) && r.yearBuilt != null && r.yearBuilt !== ''
      ? Math.trunc(Number(r.yearBuilt)) : null,
    units: r.units,
    // Already an array here (the parser's own shape) — `bindable()` in the
    // ingest handles both that and the string a database read returns.
    unit_mix: r.unitMix,
  }));
  return { a, comps, rentals };
}

/**
 * IS THIS REPORT ALREADY HERE FROM A LOAN FILE?
 *
 * A report's fingerprint is the subject property, the effective date and the
 * appraiser — the same three facts `ingest.retireDuplicateImports` uses from the
 * other direction, so the two can never disagree about what "the same report"
 * means. Returns the `appraisals` id when the file already carries it, else null.
 *
 * DELIBERATELY STRICT. With no effective date AND no named appraiser there is no
 * fingerprint, and matching on the address alone would stand down over a DIFFERENT
 * report on the same house — so in that case nothing matches and the upload writes.
 * A duplicate is a cost we can measure; a report silently refused is not.
 */
async function existingFileCopy(db, { a, observedOn }) {
  const key = K.propertyKey({
    street: a.subject_address, unit: a.subject_unit || a.condo_unit_identifier,
    city: a.subject_city, state: a.subject_state, zip: a.subject_zip,
  });
  if (!key) return null;
  const identity = ID.appraiserIdentity({
    name: a.appraiser_name, company: a.appraiser_company,
    licenseId: a.license_id, licenseState: a.license_state,
  });
  if (!observedOn && !identity) return null;
  const r = await db.query(
    `SELECT o.appraisal_id
       FROM property_observations o
       JOIN properties p ON p.id = o.property_id
       LEFT JOIN appraisers ap ON ap.id = o.appraiser_id
      WHERE o.role = 'subject' AND o.appraisal_id IS NOT NULL
        AND p.address_key = $1
        AND o.observed_on IS NOT DISTINCT FROM $2
        AND COALESCE(ap.identity_key,'') = $3
      LIMIT 1`,
    [key, observedOn, identity ? identity.key : '']);
  return r.rows.length ? r.rows[0].appraisal_id : null;
}

const dateOnly = (v) => {
  if (!v) return null;
  if (typeof v === 'string') return /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return null;
};

/**
 * Import ONE XML. Never throws — every outcome comes back as a shaped result the
 * screen can read out loud, because this runs in a loop over a bulk upload and one
 * unreadable file must never take the other ninety-nine down with it.
 *
 * @param {{query:Function, getClient?:Function}} db
 * @returns {{ok, status, importId, reason, ...counts}}
 */
/**
 * @param {object} o
 * @param {boolean} [o.untrusted]  the bytes came from somewhere we do not vouch for —
 *   today, a BORROWER upload (db/462). The report's PROPERTY facts are taken exactly as
 *   they always were: a comparable sale that happened, happened, and that is what this
 *   warehouse is for. What it may not do is REWRITE the shared appraiser roster, which
 *   every staff user reads and which was previously staff-write-only. See
 *   `ingest.upsertAppraiser`'s `fillOnly`.
 */
async function importXml(db, { xml, filename = null, uploadedBy = null, source = null, untrusted = false } = {}) {
  const out = {
    ok: false, status: 'error', importId: null, filename, reason: null,
    subjectAddress: null, appraiserName: null, comparables: 0,
    properties: 0, observations: 0, sales: 0, skipped: [], salvaged: [], appraisalId: null,
  };
  const bytes = xml == null ? '' : String(xml);
  if (!bytes.trim()) { out.reason = 'The file was empty.'; return out; }
  if (bytes.length > MAX_XML_BYTES) {
    out.reason = `That file is larger than ${Math.round(MAX_XML_BYTES / 1e6)} MB, which is bigger than any appraisal data file we have seen — it was not read.`;
    return out;
  }

  const hash = sha256(bytes);

  // The header row exists BEFORE the parse, so an unreadable file is still recorded
  // with the reason rather than vanishing. The sha is what makes a re-upload
  // refresh its own row instead of adding a second copy of every property.
  let importId;
  try {
    // `source` (db/462) records HOW the report arrived — a hand upload, a loan-file
    // door, the back-book sweep, the Encompass catcher. A label for a human reading
    // the import list, never a key anything branches on. It is COALESCEd on conflict
    // for the same reason the filename is: the first door to file a report is the one
    // that actually brought it in, and a later re-file must not rewrite that history.
    importId = (await db.query(
      `INSERT INTO research_imports (sha256, filename, byte_size, uploaded_by, source, status)
       VALUES ($1,$2,$3,$4,$5,'pending')
       ON CONFLICT (sha256) DO UPDATE SET
         filename = COALESCE(research_imports.filename, EXCLUDED.filename),
         source = COALESCE(research_imports.source, EXCLUDED.source),
         status = 'pending', error = NULL
       RETURNING id`,
      [hash, filename, Buffer.byteLength(bytes, 'utf8'), uploadedBy, source ? String(source).slice(0, 120) : null])).rows[0].id;
  } catch (e) {
    out.reason = (e && e.message) || String(e);
    return out;
  }
  out.importId = importId;

  const fail = async (reason, status = 'error') => {
    out.reason = reason;
    out.status = status;
    try {
      await db.query(
        `UPDATE research_imports SET status = $2, error = $3, ran_at = now() WHERE id = $1`,
        [importId, status, String(reason).slice(0, 2000)]);
    } catch (_) { /* the header is a courtesy; the caller still gets the reason */ }
    return out;
  };

  let A;
  try {
    A = extract(bytes);
  } catch (e) {
    return fail(`This file could not be read as an appraisal data file (${(e && e.message) || e}).`);
  }
  if (!A || !A.ok) {
    return fail(A && A.error ? A.error : 'This file is not an appraisal data file we can read.');
  }

  const { a, comps, rentals } = shapeReport(A);
  const observedOn = dateOnly(a.effective_date) || dateOnly(a.report_signed_date) || dateOnly(a.inspection_date);
  out.subjectAddress = a.subject_address || null;
  out.appraiserName = a.appraiser_name || null;
  out.comparables = comps.length;

  // A report with no identifiable subject address still has comparables worth
  // keeping, so this is NOT a refusal — it is recorded and the grid still lands.
  if (!a.subject_address && !comps.length) {
    return fail('This report named no property and carried no comparable sales, so there was nothing to add.', 'skipped');
  }

  // Stand down if a loan file already carries this exact report.
  let alreadyOnFile = null;
  try { alreadyOnFile = await existingFileCopy(db, { a, observedOn }); } catch (_) { /* never block on the check */ }
  if (alreadyOnFile) {
    out.appraisalId = alreadyOnFile;
    out.status = 'skipped';
    out.ok = true;
    out.reason = 'This report is already in the database — it came in on a loan file, and that copy is the one we keep (it has the photographs with it).';
    try {
      await db.query(
        `UPDATE research_imports SET status='skipped', appraisal_id=$2, error=$3,
                form_type=$4, effective_date=$5, subject_address=$6, ran_at=now()
          WHERE id = $1`,
        [importId, alreadyOnFile, out.reason, a.form_type, observedOn, a.subject_address]);
    } catch (_) { /* best-effort */ }
    return out;
  }

  // ---- write it -----------------------------------------------------------
  // ONE REPORT IS ONE TRANSACTION, exactly as a loan-file import is: a failure
  // half-way through would leave some of the grid in the warehouse and some of it
  // missing, with a header row claiming success. When handed the pool we take our
  // own connection; a caller inside its own transaction keeps ownership.
  const runner = async (client) => {
    const w = { ok: false, properties: 0, observations: 0, sales: 0, photos: 0, skipped: [], salvaged: [], appraiserId: null };
    await ingest.writeReport(client, { a, comps, rentals, link: { importId, untrusted }, out: w });
    return w;
  };

  let w;
  try {
    if (db && typeof db.getClient === 'function') {
      const client = await db.getClient();
      try {
        await client.query('BEGIN');
        w = await runner(client);
        await client.query('COMMIT');
      } catch (e) {
        try { await client.query('ROLLBACK'); } catch (_) { /* connection already broken */ }
        throw e;
      } finally {
        client.release();
      }
    } else {
      w = await runner(db);
    }
  } catch (e) {
    return fail((e && e.message) || String(e));
  }

  out.properties = w.properties;
  out.observations = w.observations;
  out.sales = w.sales;
  out.skipped = w.skipped;
  out.salvaged = w.salvaged || [];
  out.status = 'ok';
  out.ok = true;

  const subjectPropertyId = (await db.query(
    `SELECT property_id FROM property_observations WHERE import_id = $1 AND role = 'subject' LIMIT 1`,
    [importId])).rows.map((r) => r.property_id)[0] || null;

  await db.query(
    `UPDATE research_imports SET
       status='ok', error=NULL, ran_at=now(),
       form_type=$2, effective_date=$3,
       subject_address=$4, subject_city=$5, subject_state=$6, subject_zip=$7,
       subject_property_id=$8, appraiser_id=$9,
       comparables_seen=$10, properties_written=$11, observations_written=$12,
       sales_written=$13, rows_skipped=$14, skip_reasons=$15
     WHERE id = $1`,
    [importId, a.form_type, observedOn,
     a.subject_address, a.subject_city, a.subject_state, a.subject_zip,
     subjectPropertyId, w.appraiserId,
     comps.length, w.properties, w.observations, w.sales,
     w.skipped.length, JSON.stringify(w.skipped)]);

  return out;
}

/**
 * Import MANY XMLs — the bulk door. Runs them one at a time on purpose: each is
 * its own transaction, a bad one is recorded and stepped over, and the warehouse's
 * roll-ups are read-modify-write per property (two reports on one street landing at
 * once would fight over the same rows).
 */
async function importMany(db, files = [], { uploadedBy = null, onProgress = null, source = 'hand upload', untrusted = false } = {}) {
  const results = [];
  const summary = { total: files.length, ok: 0, skipped: 0, failed: 0, properties: 0, observations: 0, sales: 0, comparables: 0, salvaged: 0 };
  for (let i = 0; i < files.length; i++) {
    const f = files[i] || {};
    let r;
    try {
      r = await importXml(db, { xml: f.xml, filename: f.filename || null, uploadedBy, source, untrusted });
    } catch (e) {
      // importXml is written never to throw; this is the belt to its braces, so one
      // pathological file can never end a hundred-file upload.
      r = { ok: false, status: 'error', filename: f.filename || null, reason: (e && e.message) || String(e), skipped: [] };
    }
    if (r.status === 'ok') summary.ok++;
    else if (r.status === 'skipped') summary.skipped++;
    else summary.failed++;
    summary.properties += r.properties || 0;
    summary.observations += r.observations || 0;
    summary.sales += r.sales || 0;
    summary.comparables += r.comparables || 0;
    summary.salvaged += (r.salvaged && r.salvaged.length) || 0;
    results.push(r);
    if (onProgress) { try { onProgress(i + 1, files.length, r); } catch (_) { /* a progress hook never breaks the run */ } }
  }
  return { summary, results };
}

module.exports = {
  importXml, importMany,
  _internals: { shapeReport, existingFileCopy, sha256, MAX_XML_BYTES },
};
