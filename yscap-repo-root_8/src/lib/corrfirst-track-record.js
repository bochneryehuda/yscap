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
 * ── CONFIRMED AGAINST THEIR OWN FORM (2026-08-16) ───────────────────────────
 * The owner recorded themselves entering a track-record line in CorrFirst's system
 * and sent the network capture, so these are no longer read off a sample — they are
 * what CorrFirst's own software stores:
 *   · money      `"purchasePrice":"100,000"` — a STRING, thousands separators, no
 *                `$`, no cents. Exactly what `money()` writes.
 *   · ownership  `"ownershipPercent":"50"` — a bare number, no `%`. Exactly `pct()`.
 *   · RETAINED   `"asRental"` is a BOOLEAN, and when it is true their payload OMITS
 *                `salesDate` and `salesPrice` ENTIRELY. So "retained ⇒ both sold
 *                cells empty" is structural on their side, not a habit of the two
 *                sample rows — which is what `corrfirstCells` already enforces, and
 *                what section 4 of the test pins. Do not let a later edit write a
 *                sale date onto a retained line "for completeness": their own form
 *                cannot hold that combination.
 *   · address    they store ONE Google-Places line, `"1107 W Henry St, Linden, NJ
 *                07036"` — street, city, state ZIP. Our four columns rejoin into
 *                exactly that shape, which is also what `address.canonicalOneLine`
 *                produces, so their importer has nothing to reconcile.
 *   · title/notes free text.
 * (Their API takes dates as `YYYY-MM-DD` while their CSV sample writes MM/DD/YYYY —
 * their importer converts. The CSV is what we produce, so the CSV's format wins.)
 *
 * ── ONLY VERIFIED LINES GO OUT ──────────────────────────────────────────────
 * Owner-directed, and already the rule for the TPR/REO investor package
 * (tpr-export.js): `is_verified = true` — the same definition the tier, the
 * experience math and the sign-off gate use. A line pending review, waiting on
 * documents, rejected or not verified for any reason NEVER reaches an investor.
 * The internal track record still shows every line.
 *
 * ── PROPERTY TYPE IS THEIR LIST, NOT OUR GUESS ──────────────────────────────
 * CorrFirst's own Property Type options are checked in verbatim below
 * (`CORRFIRST_PROPERTY_TYPE_OPTIONS`, read off their system), and every value this
 * module can emit is one of them — a build-time check refuses a mapping that is
 * not. Our own property-type vocabulary is NARROWER than theirs, so a stored type
 * that already IS one of their values (Office, Retail, Industrial, Warehouse, Self
 * Storage, Automotive, Manufactured, Modular) passes straight through in their
 * spelling. A shape their list has NO value for — land, a lot, a plain "commercial"
 * — ships a BLANK cell and is reported by name, and so does a line carrying no
 * property type at all. Nothing here guesses a fact about a property, and nothing
 * writes a value their importer would reject.
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
 * CORRFIRST'S OWN Property Type LIST, read straight off their system (the loan
 * they sent us — cf.nexys.com/loan_process/application/32856), in their order and
 * their exact spelling. This is the AUTHORITY: their importer offers these values
 * and nothing else, so a cell holding anything not on this list is a value their
 * form cannot hold. Every mapping below must land on one of these (or on blank),
 * which `verifyPropertyTypes` asserts at build time.
 *
 * The list is COMPLETE — the owner confirmed it ends at `Automotive` (2026-08-16),
 * so it has no land, no lot and no "Other". A shape none of these covers therefore
 * ships blank BY DESIGN and is reported; that is not a gap waiting on more of their
 * list. (`Automotive` is theirs, not ours — the owner confirmed we will never lend
 * on one. It stays here because this array is a transcript of THEIR form, not a
 * list of what we use; the pass-through only ever emits it if a track-record line
 * literally says so.)
 *
 * It also settles four things our own earlier reading got wrong, and each one is
 * the reason a value is never trusted until CorrFirst themselves show it:
 *   · a CONDO is `Condo`, not `SFR-Attached` — they carry it as its own type.
 *   · a PUD is `PUD`, not `SFR-Detached` — likewise.
 *   · mixed use is `Mixed-Use` WITH the hyphen, not `Mixed Use`.
 *   · 5+ units is `Multifamily 5+`, not `5+ Units` — so the "plain unit count"
 *     convention we read off `2-4 Units` stops at 2-4 and does not continue up.
 * And there is NO `Other`: a shape with no equivalent on this list ships BLANK
 * and is reported, rather than inventing a value their form would reject.
 */
const CORRFIRST_PROPERTY_TYPE_OPTIONS = [
  'SFR-Detached',
  'SFR-Attached',
  'Condo',
  '2-4 Units',
  'PUD',
  'Mixed-Use',
  'Modular',
  'Multifamily 5+',
  'Industrial',
  'Manufactured',
  'Self Storage',
  'Office',
  'Retail',
  'Warehouse',
  'Automotive',
];

/** The comparison key for a property-type spelling: letters and digits only, so
 *  "Self Storage" / "self-storage" / "SELF STORAGE" are one value and nothing
 *  else is. EXACT equality on that key — never a substring test, which would let
 *  "Retail" match "Retail Strip Center" and put the wrong type on a property. */
const typeKey = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
const OPTION_BY_KEY = new Map(CORRFIRST_PROPERTY_TYPE_OPTIONS.map((v) => [typeKey(v), v]));

/** A stored property type that IS one of CorrFirst's own values → their exact
 *  spelling of it; otherwise null. This is how the eight commercial shapes our own
 *  vocabulary cannot express (Office, Retail, Industrial, Warehouse, Self Storage,
 *  Automotive, Manufactured, Modular) reach the file: `normPropertyType` collapses
 *  every one of them to `other`, so without this they would all ship blank. */
function corrfirstOptionOf(raw) {
  return OPTION_BY_KEY.get(typeKey(raw)) || null;
}

/**
 * Our property-type vocabulary → CorrFirst's.
 *
 * `exact: true` — our category and theirs mean the same thing, one for one.
 * `exact: false` — their list has no value for our category, so the closest one on
 * THEIR list is used and the line is REPORTED so staff can eyeball it before the
 * file is sent. Today that is exactly one case: a TOWNHOUSE, which they have no
 * value for; a townhouse is a one-dwelling home attached to its neighbour, which is
 * what `SFR-Attached` says, so it goes there rather than blank.
 *
 * `other` maps to NOTHING on purpose — our `other` bucket is where a commercial
 * building, land or a lot ends up, and CorrFirst's list has no value that covers
 * land at all. That cell ships blank and is reported by name. (A commercial shape
 * their list DOES carry — Office, Retail, Industrial, Warehouse, Self Storage,
 * Automotive, Manufactured, Modular — never reaches this table: `corrfirstOptionOf`
 * recognises it first and passes their own spelling straight through.)
 */
const CORRFIRST_PROPERTY_TYPES = {
  sfr:          { value: 'SFR-Detached',   exact: true },
  pud:          { value: 'PUD',            exact: true },
  condo:        { value: 'Condo',          exact: true },
  townhouse:    { value: 'SFR-Attached',   exact: false },
  multi_2_4:    { value: '2-4 Units',      exact: true },
  multi_5_plus: { value: 'Multifamily 5+', exact: true },
  mixed_use:    { value: 'Mixed-Use',      exact: true },
  other:        { value: '',               exact: false },
};

/**
 * Every value this module can emit is on CorrFirst's own list. Asserted empty by
 * `scripts/test-corrfirst-track-record-pure.js`, so a mapping edited to a value
 * their form cannot hold fails the build rather than the investor's import.
 */
function verifyPropertyTypes() {
  const bad = [];
  for (const [key, hit] of Object.entries(CORRFIRST_PROPERTY_TYPES)) {
    if (hit.value === '') continue;
    if (!CORRFIRST_PROPERTY_TYPE_OPTIONS.includes(hit.value)) bad.push(`${key} -> ${hit.value}`);
  }
  return bad;
}

/**
 * The CorrFirst Property Type for one line.
 *   { value, exact, missing, noEquivalent }
 * `missing: true` — the line carries no property type at all.
 * `noEquivalent: true` — it carries one, and CorrFirst's list has nothing for it.
 * Both ship a BLANK cell and are reported: NOTHING here invents a fact about a
 * property, and nothing writes a value their importer would reject.
 */
function corrfirstPropertyType(row) {
  const raw = String((row && row.property_type) || '').trim();
  if (!raw) return { value: '', exact: false, missing: true, noEquivalent: false };
  // The stored text may already BE one of their values (their list is wider than
  // our own vocabulary) — pass it through in their exact spelling.
  const verbatim = corrfirstOptionOf(raw);
  if (verbatim) return { value: verbatim, exact: true, missing: false, noEquivalent: false };
  // Otherwise read it with `normPropertyType`, the ONE reading of a property-type
  // string in this system (conditions/field-registry) — never a second regex here.
  const key = reg.normPropertyType(raw) || 'other';
  const hit = CORRFIRST_PROPERTY_TYPES[key] || CORRFIRST_PROPERTY_TYPES.other;
  if (!hit.value) return { value: '', exact: false, missing: false, noEquivalent: true };
  return { value: hit.value, exact: hit.exact, missing: false, noEquivalent: false };
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
  const out = {
    missingPropertyType: [], unmappedPropertyType: [], judgedPropertyType: [],
    missingOwnership: [], missingPurchase: [], noTitleName: [],
  };
  for (const rec of records || []) {
    const label = streetOf(rec.property_address) || `Project ${String(rec.id || '').slice(0, 8)}`;
    const type = corrfirstPropertyType(rec);
    if (type.missing) out.missingPropertyType.push(label);
    else if (type.noEquivalent) out.unmappedPropertyType.push({ property: label, ours: String(rec.property_type || '').trim() });
    else if (!type.exact) out.judgedPropertyType.push({ property: label, ours: String(rec.property_type || '').trim(), value: type.value });
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

/** `Track Record_<loan number>.csv` — CorrFirst's own file-naming shape ("Track
 *  Record_ 32856.csv"), named by OUR loan number, falling back to the investor's
 *  and then to the borrower's last name.
 *
 *  IT LED WITH THE INVESTOR'S NUMBER and was changed on owner direction
 *  (2026-08-24): "we always prefer our loan number, not the investor's loan
 *  number — across the board for all the tape exports, for all the term sheets,
 *  for all the emails." The SHAPE of the name still matches what CorrFirst sent
 *  us; only which number fills it moved, so their filing convention is intact
 *  while the file is identified by the number every PILOT surface uses. */
function corrfirstFilename(app) {
  const ln = String((app && (app.ys_loan_number || app.investor_loan_number)) || '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-|-$/g, '');
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
  TEMPLATE_FILE, CORRFIRST_SAMPLE_CSV, CORRFIRST_REAL_FILE_CSV,
  CORRFIRST_PROPERTY_TYPES, CORRFIRST_PROPERTY_TYPE_OPTIONS, verifyPropertyTypes,
  corrfirstHeader, corrfirstColumns,
  csvField, mmddyyyy, money, zip5, pct, yn,
  corrfirstPropertyType, corrfirstOptionOf, addressCellsOf, streetOf, wasSold, titleHeldInName, ownershipPctOf,
  corrfirstCells, corrfirstRow, buildCorrfirstCsv, corrfirstWarnings,
  loadCorrfirstTrackRecords, corrfirstFilename, buildCorrfirstExport, previewCorrfirstExport,
};
