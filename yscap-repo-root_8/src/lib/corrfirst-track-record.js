'use strict';
/**
 * CORRFIRST EXPORT — the borrower's Track Record on CorrFirst's own CSV
 * (owner-directed 2026-08-16: *"By the investor delivery, we should have a separate
 * option for Track Record Investor Export, and it should be named Corrfirst Export…
 * it should be a filled-up CSV, filling up this exact empty one, so we can then take
 * this exactly how it is and import to the investor"*).
 *
 * CorrFirst sent TWO files and both are the specification:
 *   · the EMPTY one — a header row and nothing else. It is checked in verbatim at
 *     `templates/corrfirst-track-record.csv` and this module APPENDS to it. The
 *     header is never re-typed here, so a column can never be renamed, reordered or
 *     dropped by an edit to this file — the same reason the data tapes fill the
 *     provider's own workbook instead of writing their own.
 *   · the SAMPLE — two filled rows, which is the only statement we have of how
 *     CorrFirst wants the VALUES written. Every formatting decision below is read
 *     off those two rows and nothing else:
 *
 *       "112 N Main St","Windsor","NJ","08561","SFR-Attached","03/10/2021","100,000","100,000","N","02/05/2024","200,000","John Doe","50","Additional Note"
 *       "112 N Main St","Windsor","NJ","08561","SFR-Detached","03/10/2021","100,000","100,000","Y","","","John Doe","50","Additional Note"
 *
 *     — header row UNQUOTED, every data field QUOTED (empty ones too, as `""`),
 *     dates MM/DD/YYYY, money with thousands separators and NO `$` and NO cents,
 *     ZIP kept as five characters (`08561` — the leading zero is why the whole file
 *     is quoted), Y/N flags, the ownership share as a bare number with no `%`, LF
 *     line endings, no BOM, and NO trailing newline. `assertMatchesCorrfirstSample`
 *     pins all of that against the sample's exact bytes.
 *
 * ── ONLY VERIFIED LINES GO OUT ──────────────────────────────────────────────
 * Owner-directed, and already the rule for the TPR/REO investor package
 * (tpr-export.js): `is_verified = true` — the same definition the tier, the
 * experience math and the sign-off gate use. A line pending review, waiting on
 * documents, rejected or not verified for any reason NEVER reaches an investor.
 * The internal track record still shows every line.
 *
 * ── WHAT WE DO NOT KNOW, AND DO NOT PRETEND TO ──────────────────────────────
 * The sample proves exactly two Property Type values — `SFR-Attached` and
 * `SFR-Detached` — and CorrFirst has not given us the rest of their list. So the
 * map below marks each mapping `proven` or not: a one-unit home maps onto a value
 * the sample itself demonstrates and is import-safe; a 2-4 unit, a 5+, mixed-use,
 * commercial or land row maps onto our best reading of the same naming convention
 * and is REPORTED to the exporting staffer (`unprovenTypes`) so it can be checked
 * against CorrFirst's list before the file is sent. A line with no property type on
 * it at all is not invented — it ships blank and is reported (`missing`). Nothing
 * here guesses a fact about a property.
 *
 * PURE except for `loadCorrfirstTrackRecords` / `buildCorrfirstExport`, which read.
 * Writes nothing, anywhere.
 */
const fs = require('fs');
const path = require('path');
const { displayName } = require('./person-name');
const ADDR = require('./address');
const reg = require('./conditions/field-registry');

// ---------------------------------------------------------------- the template
// CorrFirst's own empty file, byte-for-byte. Read once; it never changes at
// runtime. Any trailing newline is trimmed so the rows we append reproduce the
// sample's shape exactly (the sample has no trailing newline either).
const TEMPLATE_FILE = path.join(__dirname, 'templates', 'corrfirst-track-record.csv');
let _headerCache = null;
function corrfirstHeader() {
  if (_headerCache == null) _headerCache = fs.readFileSync(TEMPLATE_FILE, 'utf8').replace(/[\r\n]+$/, '');
  return _headerCache;
}
// The 14 column names, in CorrFirst's order, parsed FROM the template — never
// typed twice. Used to check the row builder still lines up with the file.
function corrfirstColumns() { return corrfirstHeader().split(','); }

// ------------------------------------------------------------ value formatting
// Every rule below is read off the sample's two rows. Each is its own tiny
// function so the test can pin it to the sample independently.

/** One CSV field, ALWAYS quoted — the sample quotes every data field, empty ones
 *  included (`""`). Embedded quotes are doubled per RFC 4180. */
function csvField(v) {
  return '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
}

/** `03/10/2021` — MM/DD/YYYY. Takes a Date, a `YYYY-MM-DD` string, or a
 *  timestamp string; anything unreadable becomes '' rather than a wrong date.
 *  Reads the calendar parts off the ISO text, so a `date` column can never slip a
 *  day through a timezone conversion. */
function mmddyyyy(v) {
  if (v == null || v === '') return '';
  let iso;
  if (v instanceof Date) {
    if (isNaN(v.getTime())) return '';
    // A DATE column comes back as local midnight; use the local parts.
    iso = `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`;
  } else {
    iso = String(v).trim();
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return '';
  const [, y, mo, d] = m;
  if (Number(mo) < 1 || Number(mo) > 12 || Number(d) < 1 || Number(d) > 31) return '';
  return `${mo}/${d}/${y}`;
}

/** `100,000` — whole dollars, thousands separators, no `$`, no cents (the sample
 *  carries none of the three). Blank/zero-less input stays blank rather than 0,
 *  so an unfilled figure never reads as "this deal cost nothing". */
function money(v) {
  if (v == null || v === '') return '';
  const n = Number(v);
  if (!isFinite(n)) return '';
  return Math.round(n).toLocaleString('en-US');
}

/** `08561` — five characters, leading zero intact, ZIP+4 collapsed to the 5. The
 *  whole file being quoted is what keeps that leading zero alive in Excel. */
function zip5(v) {
  const digits = String(v == null ? '' : v).replace(/[^0-9]/g, '');
  if (!digits) return '';
  return digits.length >= 5 ? digits.slice(0, 5) : digits.padStart(5, '0');
}

/** `50` — the ownership share as a bare number: no `%`, no trailing `.00`. */
function pct(v) {
  if (v == null || v === '') return '';
  const n = Number(v);
  if (!isFinite(n)) return '';
  return String(Math.round(n * 100) / 100);
}

const yn = (b) => (b ? 'Y' : 'N');

// ------------------------------------------------------------- Property Type
/**
 * Our property-type vocabulary → CorrFirst's.
 *
 * `proven: true` means one of CorrFirst's OWN FILES carries that value verbatim,
 * so the import cannot reject it. `proven: false` is our best reading of the same
 * naming convention for a shape they have not shown us — it is emitted (a blank
 * would lose the fact) and REPORTED, so staff can check it against CorrFirst's
 * own list before sending. This table is the one place that changes when they
 * give us the rest of their list.
 *
 * PROVEN SO FAR, and where each came from:
 *   SFR-Attached / SFR-Detached  — the two-row sample they sent.
 *   2-4 Units                    — a REAL filled file of theirs (Track_Record_32170),
 *                                  three Newark/Bronx/Brooklyn multis. Note the
 *                                  PLURAL: it is "2-4 Units", not "2-4 Unit" —
 *                                  which is exactly why a value is never called
 *                                  proven until one of their files shows it.
 *
 * THE CONVENTION THOSE THREE REVEAL, which is what the unproven guesses follow:
 * a one-dwelling home is "SFR-" plus how it sits on its lot, and anything bigger
 * is a plain unit COUNT with a plural "Units". So 5+ is written "5+ Units" rather
 * than "Multifamily" — same shape as the value they proved, one step further up.
 */
const CORRFIRST_PROPERTY_TYPES = {
  sfr:          { value: 'SFR-Detached',   proven: true },
  pud:          { value: 'SFR-Detached',   proven: true },
  condo:        { value: 'SFR-Attached',   proven: true },
  townhouse:    { value: 'SFR-Attached',   proven: true },
  multi_2_4:    { value: '2-4 Units',      proven: true },
  multi_5_plus: { value: '5+ Units',       proven: false },
  mixed_use:    { value: 'Mixed Use',      proven: false },
  other:        { value: 'Other',          proven: false },
};

/**
 * The CorrFirst Property Type for one line, plus how much we trust the value.
 *   { value, proven, missing }
 * `missing: true` — the line carries no property type at all. NOTHING is invented:
 * the cell ships blank and the caller reports the line.
 */
function corrfirstPropertyType(row) {
  const raw = (row && row.property_type) || '';
  if (!String(raw).trim()) return { value: '', proven: false, missing: true };
  // `normPropertyType` is the ONE reading of a property-type string in this
  // system (conditions/field-registry) — never a second regex here.
  const key = reg.normPropertyType(raw) || 'other';
  const hit = CORRFIRST_PROPERTY_TYPES[key] || CORRFIRST_PROPERTY_TYPES.other;
  return { value: hit.value, proven: hit.proven, missing: false };
}

// ------------------------------------------------------------------- the row
/**
 * The four address cells for one line: Street (unit included), City, State, ZIP.
 *
 * A track-record address is normally the canonical object `{ line1, unit, city,
 * state, zip, oneLine }`, but the public-records importer wrote some rows as a
 * bare one-line STRING (db/track-record-address-shape) and a hand-typed line can
 * be missing a part. So the stored parts are used FIRST and only the GAPS are
 * filled by parsing the one-line text — a stored city is never overwritten by a
 * parse. Both readings come from `address.js`, the one address parser in this
 * system; there is no second regex here.
 */
function addressCellsOf(addr) {
  const obj = ADDR.parseToAddressObject(addr) || {};
  let line1 = String(obj.line1 || obj.street || '').trim();
  const unit = String(obj.unit || '').trim();
  let city = String(obj.city || '').trim();
  let state = String(obj.state || '').trim();
  let zip = String(obj.zip || '').trim();
  if (!line1 || !city || !state || !zip) {
    const text = String(obj.oneLine || (typeof addr === 'string' ? addr : '') || '').trim();
    if (text) {
      const p = ADDR.parseAddress(text);
      if (!line1) line1 = p.line1 || '';
      if (!city) city = p.city || '';
      if (!state) state = p.state || '';
      if (!zip) zip = p.zip || '';
    }
  }
  return {
    street: line1 && unit ? `${line1} ${unit}` : line1,
    city,
    state: ADDR.stateAbbr(state) || '',
    zip: zip5(zip),
  };
}

/** The property's street line, unit included ("112 N Main St", "44 Oak St Apt 2"). */
function streetOf(addr) { return addressCellsOf(addr).street; }

/** Was this property SOLD? The sample's own invariant: a sold line carries the
 *  Sold Date + Sold Price and `Rental Retained = N`; a retained one carries `Y`
 *  and leaves both sold cells empty. Read off the data, not off the deal type, so
 *  a rental that was later sold reports the sale (which is what happened) and a
 *  flip that has not closed yet is never called sold. */
function wasSold(rec) {
  return !!(rec && (rec.sale_date || (rec.sale_price != null && rec.sale_price !== '' && Number(rec.sale_price) > 0)));
}

/** Who held title: the entity when there is one, the borrower's own name when the
 *  line says they held it personally. Never both — `owned_personally` is the
 *  statement about the entity (db/093) and it wins. */
function titleHeldInName(rec) {
  if (rec && rec.owned_personally) return String(rec.borrower_name || '').trim();
  const entity = String((rec && rec.entity_name) || '').trim();
  if (entity) return entity;
  // No entity named and not flagged personal — the borrower is who we know held
  // it, and leaving the investor's title column blank helps nobody.
  return String((rec && rec.borrower_name) || '').trim();
}

/** The borrower's share. Held personally = the whole thing. Held in an entity =
 *  their recorded stake in that entity; blank (and reported) when nobody has
 *  recorded one — an ownership share is a fact, not something to assume. */
function ownershipPctOf(rec) {
  if (rec && rec.owned_personally) return 100;
  const v = rec && rec.entity_ownership_pct;
  if (v == null || v === '') return null;
  const n = Number(v);
  return isFinite(n) ? n : null;
}

/**
 * ONE track-record line → the 14 CorrFirst cells, as an array of already-formatted
 * strings (not yet quoted). Pure — every input is on the row.
 */
function corrfirstCells(rec) {
  const addr = (rec && rec.property_address) || null;
  const a = addressCellsOf(addr);
  const sold = wasSold(rec);
  const type = corrfirstPropertyType(rec);
  const share = ownershipPctOf(rec);
  return [
    a.street,
    a.city,
    a.state,
    a.zip,
    type.value,
    mmddyyyy(rec.purchase_date),
    money(rec.purchase_price),
    money(rec.rehab_amount),
    yn(!sold),                                  // Rental Retained
    sold ? mmddyyyy(rec.sale_date) : '',
    sold ? money(rec.sale_price) : '',
    titleHeldInName(rec),
    share == null ? '' : pct(share),
    String(rec.notes == null ? '' : rec.notes).replace(/[\r\n]+/g, ' ').trim(),
  ];
}

/** One fully-serialized CorrFirst data line. */
function corrfirstRow(rec) { return corrfirstCells(rec).map(csvField).join(','); }

/**
 * The finished file: CorrFirst's own header, verbatim, then one line per verified
 * track record. LF endings and no trailing newline — the sample's exact shape.
 * A zero-row export is still a valid file (the header alone, i.e. the empty file
 * they sent); the caller decides whether to offer it.
 */
function buildCorrfirstCsv(records) {
  const rows = (records || []).map(corrfirstRow);
  return rows.length ? corrfirstHeader() + '\n' + rows.join('\n') : corrfirstHeader();
}

/**
 * Everything the exporting staffer must be told BEFORE the file goes to CorrFirst
 * — never a silent gap. Pure, so the preview endpoint and the download report the
 * same thing from the same code.
 */
function corrfirstWarnings(records) {
  const out = { missingPropertyType: [], unprovenPropertyType: [], missingOwnership: [], missingPurchase: [], noTitleName: [] };
  for (const rec of records || []) {
    const label = streetOf(rec.property_address) || `Project ${String(rec.id || '').slice(0, 8)}`;
    const type = corrfirstPropertyType(rec);
    if (type.missing) out.missingPropertyType.push(label);
    else if (!type.proven) out.unprovenPropertyType.push({ property: label, value: type.value });
    if (ownershipPctOf(rec) == null) out.missingOwnership.push(label);
    if (!rec.purchase_date || money(rec.purchase_price) === '') out.missingPurchase.push(label);
    if (!titleHeldInName(rec)) out.noTitleName.push(label);
  }
  return out;
}

// ------------------------------------------------------------------- loading
/**
 * The verified track records behind ONE loan file — the borrower's and the
 * co-borrower's, exactly like the TPR/REO package.
 *
 * `is_verified = true` is the whole gate (owner-directed). The ownership share is
 * resolved in SQL over the three places it can live: the borrower's stake in that
 * entity (`llc_borrowers`), the entity's own recorded stake (`llcs`), and — for a
 * line that carries a typed entity NAME but was never linked to the entity record
 * — the borrower's LLC of that name.
 */
async function loadCorrfirstTrackRecords(appId, db) {
  const app = (await db.query(
    `SELECT a.id, a.ys_loan_number, a.investor_loan_number, a.borrower_id, a.co_borrower_id,
            b.full_name, b.first_name, b.middle_name, b.last_name, b.name_suffix
       FROM applications a JOIN borrowers b ON b.id = a.borrower_id
      WHERE a.id = $1 AND a.deleted_at IS NULL`, [appId])).rows[0];
  if (!app) return null;
  const borrowerIds = [app.borrower_id, app.co_borrower_id].filter(Boolean);
  const records = (await db.query(
    `SELECT t.id, t.borrower_id, t.property_address, t.property_type, t.deal_type,
            t.purchase_price, t.sale_price, t.rehab_amount,
            t.purchase_date, t.sale_date, t.rent_date, t.refi_date,
            t.owned_personally, t.notes, t.llc_id,
            COALESCE(t.entity_name, l.llc_name) AS entity_name,
            COALESCE(lb.ownership_pct, l.ownership_pct, named.ownership_pct) AS entity_ownership_pct,
            b.full_name AS borrower_name
       FROM track_records t
       JOIN borrowers b ON b.id = t.borrower_id
       LEFT JOIN llcs l  ON l.id = t.llc_id
       LEFT JOIN llc_borrowers lb ON lb.llc_id = t.llc_id AND lb.borrower_id = t.borrower_id
       LEFT JOIN LATERAL (
              SELECT l2.ownership_pct FROM llcs l2
               WHERE t.llc_id IS NULL AND t.entity_name IS NOT NULL
                 AND l2.borrower_id = t.borrower_id
                 AND lower(btrim(l2.llc_name)) = lower(btrim(t.entity_name))
               LIMIT 1) named ON true
      WHERE t.borrower_id = ANY($1::uuid[])
        AND t.is_verified = true
      ORDER BY COALESCE(t.sale_date, t.refi_date, t.rent_date, t.purchase_date) DESC NULLS LAST,
               t.created_at DESC`, [borrowerIds])).rows;
  return { app, records };
}

/** `Track Record_<loan number>.csv` — CorrFirst's own file naming ("Track
 *  Record_ 32856.csv"), falling back to the borrower's last name. */
function corrfirstFilename(app) {
  const ln = String((app && (app.investor_loan_number || app.ys_loan_number)) || '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-|-$/g, '');
  const last = String((app && app.last_name) || '').replace(/[^A-Za-z0-9]+/g, '');
  const tag = ln || last || 'Export';
  return `Track Record_${tag}.csv`;
}

/** Build the whole thing for one loan file. Returns null when the file is gone. */
async function buildCorrfirstExport(appId, db) {
  const loaded = await loadCorrfirstTrackRecords(appId, db);
  if (!loaded) return null;
  const { app, records } = loaded;
  return {
    csv: buildCorrfirstCsv(records),
    filename: corrfirstFilename(app),
    rowCount: records.length,
    borrowerName: displayName(app),
    warnings: corrfirstWarnings(records),
  };
}

/** The readiness preview — the same counts and the same warnings the download
 *  would produce, without building the file. */
async function previewCorrfirstExport(appId, db) {
  const loaded = await loadCorrfirstTrackRecords(appId, db);
  if (!loaded) return null;
  const { app, records } = loaded;
  const sold = records.filter(wasSold).length;
  return {
    rowCount: records.length,
    soldCount: sold,
    retainedCount: records.length - sold,
    filename: corrfirstFilename(app),
    borrowerName: displayName(app),
    warnings: corrfirstWarnings(records),
  };
}

// ------------------------------------------------------ the sample, as a check
/**
 * CorrFirst's SAMPLE file, verbatim — the only statement we have of how they want
 * the values written. Kept here so the test can prove the builder reproduces it
 * byte-for-byte from equivalent data, which is what stops a well-meaning edit
 * (a `$`, a trailing newline, an unquoted empty cell) from breaking the import.
 */
const CORRFIRST_SAMPLE_CSV =
  'Street,City,State,ZIP,Property Type,Purchase Date,Purchase Price,Renovation Budget,Rental Retained,Sold Date,Sold Price,Title Held in Name,% of Ownership,Additional Notes\n'
  + '"112 N Main St","Windsor","NJ","08561","SFR-Attached","03/10/2021","100,000","100,000","N","02/05/2024","200,000","John Doe","50","Additional Note"\n'
  + '"112 N Main St","Windsor","NJ","08561","SFR-Detached","03/10/2021","100,000","100,000","Y","","","John Doe","50","Additional Note"';

/**
 * A REAL filled CorrFirst file (Track_Record_32170) — three multi-unit rentals
 * held in the borrowers' own entities. It is the second half of the spec and
 * carries what the two-row sample could not:
 *   · the PLURAL "2-4 Units";
 *   · an entity in Title Held in Name (the sample's "John Doe" left it ambiguous
 *     whether they wanted a person or the vesting entity);
 *   · a wholly-owned entity written as "100";
 *   · a blank Additional Notes shipping as "" rather than being omitted;
 *   · a seven-figure price grouped as "1,035,000";
 *   · retained rentals with BOTH sold cells empty, three times over.
 * Kept verbatim so the test can prove the builder reproduces it byte-for-byte —
 * which is what stops a well-meaning edit from breaking the import.
 *
 * (Their own file lists each of the three properties TWICE. That is duplication
 * in whatever produced it, not something to reproduce: this export writes one
 * line per verified track record.)
 */
const CORRFIRST_REAL_FILE_CSV =
  'Street,City,State,ZIP,Property Type,Purchase Date,Purchase Price,Renovation Budget,Rental Retained,Sold Date,Sold Price,Title Held in Name,% of Ownership,Additional Notes\n'
  + '"195 Lehigh Ave","Newark","NJ","07112","2-4 Units","03/01/2026","426,000","65,000","Y","","","CBH Reno Home Tech LLC","100",""\n'
  + '"1048 Clay Ave","Bronx","NY","10456","2-4 Units","03/01/2025","865,000","95,000","Y","","","CLAYAVE LLC","100",""\n'
  + '"248 E 93rd St","Brooklyn","NY","11212","2-4 Units","12/01/2024","1,035,000","120,000","Y","","","248 e 93th LLC","100",""';

module.exports = {
  TEMPLATE_FILE, CORRFIRST_SAMPLE_CSV, CORRFIRST_REAL_FILE_CSV, CORRFIRST_PROPERTY_TYPES,
  corrfirstHeader, corrfirstColumns,
  csvField, mmddyyyy, money, zip5, pct, yn,
  corrfirstPropertyType, addressCellsOf, streetOf, wasSold, titleHeldInName, ownershipPctOf,
  corrfirstCells, corrfirstRow, buildCorrfirstCsv, corrfirstWarnings,
  loadCorrfirstTrackRecords, corrfirstFilename, buildCorrfirstExport, previewCorrfirstExport,
};
