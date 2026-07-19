/**
 * MISMO 3.4 import/export — the database-facing layer that ties the pure engine
 * (build.js / parse.js) to the portal's tables.
 *
 *   loadFile(appId)            -> gather one loan file into the engine's shape
 *   exportApplicationXml(appId)-> MISMO 3.4 XML string for that file
 *   previewImport(xml)         -> parse a MISMO file to a preview (NO writes)
 *   createFromParsed(parsed)   -> create borrower + application from a parse
 *
 * Import deliberately splits PREVIEW from CREATE: parsing never writes, so staff
 * always see exactly what a file contains before a single row is created — in
 * keeping with this repo's "never silently apply an inbound change" posture.
 */
// crypto lives at src/lib/crypto.js; this file is src/lib/mismo/index.js, so the
// sibling libs are one directory up.
const db = require('../../db');
const crypto = require('../crypto');
const fields = require('../fields');
const { buildMismoXml } = require('./build');
const { parseMismoXml } = require('./parse');

const num = (v) => {
  if (v == null || v === '') return null;
  const n = Number(String(v).replace(/[^0-9.\-]/g, ''));
  return isFinite(n) ? n : null;
};
const int = (v) => { const n = num(v); return n == null ? null : Math.round(n); };

function mapBorrowerRow(b) {
  if (!b) return null;
  return {
    firstName: b.first_name || null,
    lastName: b.last_name || null,
    email: b.email || null,
    phone: b.cell_phone || null,
    ssn: crypto.decryptSSN(b.ssn_encrypted),
    dob: b.date_of_birth || null,
    citizenship: b.citizenship || null,
    maritalStatus: b.marital_status || null,
    dependents: b.dependents_count,
    currentAddress: b.current_address || null,
    priorAddress: b.prior_address || null,
    yearsAtResidence: b.years_at_residence,
    employer: b.employer || null,
    employmentType: b.employment_type || null,
    fico: b.fico,
  };
}

/**
 * Load a single application (plus borrower, co-borrower and vesting entity) into
 * the plain object shape the exporter consumes. SSNs are decrypted here — this
 * runs behind the same staff authorization the export endpoint enforces.
 */
async function loadFile(appId) {
  const a = (await db.query(
    `SELECT a.*, b.first_name AS b_first, b.last_name AS b_last
       FROM applications a JOIN borrowers b ON b.id = a.borrower_id
      WHERE a.id = $1`, [appId])).rows[0];
  if (!a) return null;

  const borrower = (await db.query('SELECT * FROM borrowers WHERE id=$1', [a.borrower_id])).rows[0];
  const coBorrower = a.co_borrower_id
    ? (await db.query('SELECT * FROM borrowers WHERE id=$1', [a.co_borrower_id])).rows[0]
    : null;
  const llc = a.llc_id
    ? (await db.query('SELECT llc_name, ein, formation_state FROM llcs WHERE id=$1', [a.llc_id])).rows[0]
    : null;

  return {
    loanNumber: a.ys_loan_number,
    investorLoanNumber: a.investor_loan_number,
    program: a.program,
    loanType: a.loan_type,
    occupancy: a.occupancy,
    loanAmount: a.loan_amount,
    rate: a.rate_pct,
    term: a.term,
    purchasePrice: a.purchase_price,
    asIsValue: a.as_is_value,
    arv: a.arv,
    rehabBudget: a.rehab_budget,
    rehabType: a.rehab_type,
    dscr: a.dscr_ratio,
    ltv: a.ltv,
    ppp: a.ppp,
    propertyType: a.property_type,
    units: a.units,
    lender: a.lender,
    channel: a.channel,
    property: a.property_address,
    borrower: mapBorrowerRow(borrower),
    coBorrower: mapBorrowerRow(coBorrower),
    llc: llc ? { name: llc.llc_name, ein: llc.ein, formationState: llc.formation_state } : null,
    extras: {
      sqftPre: a.sqft_pre, sqftPost: a.sqft_post,
      expFlips: a.requested_exp_flips, expHolds: a.requested_exp_holds, expGround: a.requested_exp_ground,
    },
    generatedAt: new Date().toISOString(),
  };
}

/** Build the MISMO 3.4 XML for an application, or null if it doesn't exist. */
async function exportApplicationXml(appId) {
  const file = await loadFile(appId);
  if (!file) return null;
  return buildMismoXml(file);
}

/** A safe filename for a downloaded MISMO file. */
function exportFilename(loanNumber, lastName) {
  const base = String(loanNumber || lastName || 'loan').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 60);
  return `MISMO_3.4_${base}_${new Date().toISOString().slice(0, 10)}.xml`;
}

/** Parse a MISMO file into a preview object. Never writes to the database. */
function previewImport(xml) {
  return parseMismoXml(xml);
}

// A DETERMINISTIC placeholder email for a borrower a MISMO file did not carry
// an email for — derived from the SSN (preferred) or name+DOB — so re-importing
// the SAME file reuses the SAME borrower row instead of minting a duplicate.
// It stores a one-way hash slice, never the SSN itself.
function syntheticEmail(p) {
  const nodeCrypto = require('crypto');
  const seed = (p.ssn && String(p.ssn).length === 9)
    ? 'ssn:' + p.ssn
    : 'nm:' + [p.firstName, p.lastName, p.dob].map((x) => String(x || '').toLowerCase().trim()).join('|');
  const h = nodeCrypto.createHash('sha256').update(seed).digest('hex').slice(0, 12);
  return `noemail+mismo-${h}@import.local`;
}

// Create/adopt a borrower row from a parsed party, filling only blanks on an
// existing same-email row (never overwriting a real value — the same posture as
// intake.js). Returns the borrower id. `opts.fico` sets the credit score (it
// lives on the borrower, not the parsed party object).
async function upsertBorrower(client, p, opts = {}) {
  if (!p) return null;
  const email = p.email || syntheticEmail(p);
  const b = await client.query(
    `INSERT INTO borrowers (first_name, last_name, email, cell_phone, citizenship, marital_status,
                            dependents_count, current_address, prior_address, years_at_residence, employer)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (email) DO UPDATE SET
       first_name = CASE WHEN lower(btrim(coalesce(borrowers.first_name,''))) IN ('','unknown','co-borrower')
                          AND coalesce(btrim(EXCLUDED.first_name),'') <> '' THEN EXCLUDED.first_name ELSE borrowers.first_name END,
       last_name  = CASE WHEN lower(btrim(coalesce(borrowers.last_name,''))) IN ('','unknown','co-borrower')
                          AND coalesce(btrim(EXCLUDED.last_name),'') <> '' THEN EXCLUDED.last_name ELSE borrowers.last_name END,
       cell_phone = COALESCE(borrowers.cell_phone, EXCLUDED.cell_phone),
       citizenship = COALESCE(borrowers.citizenship, EXCLUDED.citizenship),
       marital_status = COALESCE(borrowers.marital_status, EXCLUDED.marital_status),
       dependents_count = COALESCE(borrowers.dependents_count, EXCLUDED.dependents_count),
       current_address = COALESCE(borrowers.current_address, EXCLUDED.current_address),
       prior_address = COALESCE(borrowers.prior_address, EXCLUDED.prior_address),
       years_at_residence = COALESCE(borrowers.years_at_residence, EXCLUDED.years_at_residence),
       employer = COALESCE(borrowers.employer, EXCLUDED.employer),
       updated_at = now()
     RETURNING id`,
    [p.firstName || 'Unknown', p.lastName || 'Unknown', email, p.phone || null,
     p.citizenship || null, p.maritalStatus || null,
     p.dependents != null ? int(p.dependents) : null,
     p.currentAddress ? JSON.stringify(p.currentAddress) : null,
     p.priorAddress ? JSON.stringify(p.priorAddress) : null,
     p.yearsAtResidence != null ? num(p.yearsAtResidence) : null,
     p.employer || null]);
  const id = b.rows[0].id;
  // Persist a full 9-digit SSN through the canonical chokepoint only.
  if (p.ssn) {
    const s = crypto.ssnForStorage(p.ssn);
    if (s) await client.query('UPDATE borrowers SET ssn_encrypted=$2, ssn_last4=$3 WHERE id=$1 AND ssn_encrypted IS NULL',
      [id, s.encrypted, s.last4]);
  }
  // DOB through the strict validator (adult calendar date only).
  if (p.dob) {
    const dob = fields.sanitizeDob(p.dob);
    if (dob) await client.query('UPDATE borrowers SET date_of_birth=$2 WHERE id=$1 AND date_of_birth IS NULL', [id, dob]);
  }
  // FICO (fill blank only) — validated to the 300–850 band via sanitizeFico.
  if (opts.fico != null) {
    const fico = fields.sanitizeFico(opts.fico);
    if (fico != null) await client.query('UPDATE borrowers SET fico=$2 WHERE id=$1 AND fico IS NULL', [id, fico]);
  }
  return id;
}

/**
 * Create a new loan file (borrower + application, plus co-borrower and vesting
 * entity when present) from a parsed MISMO file. Wrapped in a transaction; the
 * checklist/conditions are generated after commit, exactly like intake.js.
 * @returns {{ borrowerId, applicationId }}
 */
async function createFromParsed(parsed, opts = {}) {
  if (!parsed || !parsed.borrower) {
    const e = new Error('parsed MISMO file has no borrower to create a file from');
    e.userMessage = 'This file has no borrower details, so a loan file can’t be created from it.';
    throw e;
  }
  const { loan = {}, property = {}, extras = {}, borrower, coBorrower, llc } = parsed;
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    // FICO from the extension belongs to the PRIMARY borrower.
    const borrowerId = await upsertBorrower(client, borrower, { fico: extras.fico });
    const coBorrowerId = coBorrower ? await upsertBorrower(client, coBorrower) : null;

    let llcId = null;
    if (llc && llc.name) {
      // Adopt an existing entity of the same name for this borrower rather than
      // colliding on uq_llcs_borrower_name (db/082) — importing a file for a
      // borrower we already know must reuse, never duplicate, their LLC.
      const l = await client.query(
        `INSERT INTO llcs (borrower_id, llc_name, ein, formation_state) VALUES ($1,$2,$3,$4)
         ON CONFLICT (borrower_id, lower(btrim(llc_name))) DO UPDATE SET
           ein = COALESCE(llcs.ein, EXCLUDED.ein),
           formation_state = COALESCE(llcs.formation_state, EXCLUDED.formation_state),
           updated_at = now()
         RETURNING id`,
        [borrowerId, llc.name, llc.ein || null, llc.formationState || null]);
      llcId = l.rows[0].id;
    }

    const addr = property.address || null;
    const a = await client.query(
      `INSERT INTO applications
         (borrower_id, co_borrower_id, llc_id, loan_officer_id,
          program, loan_type, occupancy, property_address, property_type, units,
          purchase_price, as_is_value, arv, rehab_budget, rehab_type,
          loan_amount, ltv, dscr_ratio, rate_pct, term, ppp,
          requested_exp_flips, requested_exp_holds, requested_exp_ground, sqft_pre, sqft_post,
          investor_loan_number, lender, channel, source, raw_intake, status, submitted_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,
               $22,$23,$24,$25,$26,$27,$28,$29,'mismo_import',$30,'new',now())
       RETURNING id`,
      [borrowerId, coBorrowerId, llcId, opts.officerId || null,
       extras.program || null, fields.sanitizeLoanType(loan.loanType), loan.occupancy || property.occupancy || null,
       addr ? JSON.stringify(addr) : null, property.propertyType || extras.propertyType || null,
       property.units != null ? int(property.units) : null,
       property.purchasePrice != null ? num(property.purchasePrice) : null,
       property.asIsValue != null ? num(property.asIsValue) : null,
       extras.arv != null ? num(extras.arv) : null,
       extras.rehabBudget != null ? num(extras.rehabBudget) : null, extras.rehabType || null,
       loan.loanAmount != null ? num(loan.loanAmount) : null,
       extras.ltv != null ? num(extras.ltv) : null,
       extras.dscr != null ? num(extras.dscr) : null,
       loan.rate != null ? num(loan.rate) : null, loan.term || null, extras.ppp || null,
       // requested experience columns are NOT NULL DEFAULT 0 — coerce to integers.
       int(extras.expFlips) || 0, int(extras.expHolds) || 0, int(extras.expGround) || 0,
       extras.sqftPre != null ? int(extras.sqftPre) : null,
       extras.sqftPost != null ? int(extras.sqftPost) : null,
       loan.investorLoanNumber || null, extras.lender || null, extras.channel || null,
       JSON.stringify({ source: 'mismo_import', imported_at: new Date().toISOString(), warnings: parsed.warnings || [] })]);
    const applicationId = a.rows[0].id;
    await client.query('COMMIT');

    // Post-commit best-effort: generate the file's checklist/conditions, exactly
    // like every other create path. A failure here never undoes the created file.
    try {
      await require('../conditions/ensure').ensureFileConditions(applicationId, { reason: 'mismo_import' });
    } catch (e) { console.error('[mismo] post-create conditions failed:', db.describeError ? db.describeError(e) : e.message); }

    return { borrowerId, applicationId };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

module.exports = {
  loadFile, exportApplicationXml, exportFilename,
  previewImport, createFromParsed,
};
