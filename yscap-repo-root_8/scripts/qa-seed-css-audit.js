'use strict';
/* =====================================================================
   SEED FOR THE CSS / LAYOUT AUDIT — deliberately AWKWARD data
   ---------------------------------------------------------------------
   A layout only breaks on the values nobody demoed with. "Jordan Bloom /
   18 Maple Ave" fits every slot in the product; the real pipeline holds
   "Featherstonehaugh-Wintersbottom" and a four-line New York address with
   a unit number, and those are the ones that push a value out of its box,
   under the next one, or silently cut it in half.

   So this seeds the SAME shapes the product really has — one file, one
   borrower, one entity, conditions, staff — with values at the long end of
   what the fields actually accept: a 58-character surname, a 118-character
   entity name, an address with a unit and a ZIP+4, an unbroken 44-character
   "word" (a document reference with no spaces, which is what defeats
   `word-wrap`), and money in the eight figures.

   It also seeds a NORMAL-length twin of each, because half the audit is
   whether two rows that hold different-length values still line up.

   Prints the ids and the two tokens the browser driver needs, as JSON on
   the last line. Run:
     DATABASE_URL=... node scripts/qa-seed-css-audit.js
   ===================================================================== */
const crypto = require('crypto');
const db = require('../src/db');
const C = require('../src/lib/crypto.js');
const uuid = () => crypto.randomUUID();

// The long end of each field. Every one of these is a shape the product
// really accepts — not a stress string of Xs, which proves nothing about
// whether a real value fits.
const LONG = {
  first: 'Maximiliano Bartholomew',
  last: 'Featherstonehaugh-Wintersbottom',
  email: 'maximiliano.featherstonehaugh-wintersbottom@northwestern-capital-partners.example.com',
  entity: 'Featherstonehaugh Wintersbottom Capital Holdings & Property Acquisitions of Greater Northwestern Pennsylvania, LLC',
  address: {
    line1: '12345 Northwest Kensington-Montgomery Boulevard Southeast, Building C',
    line2: 'Apartment 4512-B',
    city: 'Saint Petersburg Beach',
    state: 'FL',
    zip: '33706-1234',
  },
  // No spaces. This is the one that defeats normal wrapping.
  unbroken: 'ClosingDisclosure_FINAL_v7_2026-08-09_SIGNED.pdf',
};

const SHORT = {
  first: 'Ana',
  last: 'Ng',
  email: 'ana@ex.com',
  entity: 'NG LLC',
  address: { line1: '8 Oak St', city: 'Newark', state: 'NJ', zip: '07104' },
};

async function upsertStaff(email, name, role, title) {
  await db.query(
    `INSERT INTO staff_users (email, full_name, role, is_active, password_hash, token_version, title)
     VALUES ($1,$2,$3,true,'x',0,$4)
     ON CONFLICT (email) DO UPDATE SET full_name=EXCLUDED.full_name, role=EXCLUDED.role,
       is_active=true, title=EXCLUDED.title`,
    [email, name, role, title]);
  return (await db.query(`SELECT id, token_version FROM staff_users WHERE email=$1`, [email])).rows[0];
}

// The unique index on borrowers.email is PARTIAL (`WHERE shares_email = false`),
// so `ON CONFLICT (email)` cannot infer it. Look first, then insert.
async function upsertBorrower(p) {
  const found = await db.query(`SELECT id FROM borrowers WHERE email=$1`, [p.email]);
  const id = found.rows[0]
    ? found.rows[0].id
    : (await db.query(
        `INSERT INTO borrowers (first_name, last_name, email, cell_phone, current_address, fico, employer)
         VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7) RETURNING id`,
        [p.first, p.last, p.email, p.phone, JSON.stringify(p.address), p.fico, p.employer])).rows[0].id;
  // The borrower's token_version lives here, not on `borrowers` — without this
  // row every authenticated borrower request is rejected.
  await db.query(
    `INSERT INTO borrower_auth (borrower_id, password_hash, email_verified, email_verified_at)
     VALUES ($1,'x',true,now()) ON CONFLICT (borrower_id) DO UPDATE SET email_verified=true`, [id]);
  return id;
}

async function main() {
  // ---- staff: one with a long name and a long title, one short ----------
  const admin = await upsertStaff('css-audit-admin@yscapgroup.com',
    'Alexandra Konstantinopoulos-Vandermeulen', 'super_admin',
    'Senior Vice President of Credit Policy & Portfolio Risk Administration');
  const admin2 = await upsertStaff('css-audit-lo@yscapgroup.com', 'Bo Li', 'loan_officer', 'LO');
  const staffToken = C.signJwt({ sub: admin.id, kind: 'staff', role: 'super_admin', tv: admin.token_version });

  // ---- borrowers --------------------------------------------------------
  const longBorrower = await upsertBorrower({
    ...LONG, phone: '+1 (727) 555-0148 ext. 44012', fico: 742,
    employer: 'Featherstonehaugh Wintersbottom Property Management & Construction Services International',
  });
  const shortBorrower = await upsertBorrower({ ...SHORT, phone: '2015550101', fico: 690, employer: 'Self' });

  const tv = (await db.query(
    `SELECT token_version FROM borrower_auth WHERE borrower_id=$1`, [longBorrower])).rows[0].token_version;
  const borrowerToken = C.signJwt({
    sub: longBorrower, kind: 'borrower', role: 'borrower', tv, sid: crypto.randomUUID(),
  });

  // ---- entities ---------------------------------------------------------
  for (const [bid, name, state] of [
    [longBorrower, LONG.entity, 'DE'],
    [longBorrower, 'FW Holdings II LLC', 'NJ'],
    [shortBorrower, SHORT.entity, 'NJ'],
  ]) {
    await db.query(
      `INSERT INTO llcs (borrower_id, llc_name, ein, formation_state, ownership_pct, is_verified)
       VALUES ($1,$2,'88-7654321',$3,100,true)
       ON CONFLICT (borrower_id, lower(btrim(llc_name))) DO NOTHING`, [bid, name, state]);
  }
  const llcId = (await db.query(
    `SELECT id FROM llcs WHERE borrower_id=$1 ORDER BY length(llc_name) DESC LIMIT 1`,
    [longBorrower])).rows[0].id;

  // ---- files ------------------------------------------------------------
  // The long one carries the awkward value in every slot at once, which is
  // how a real file arrives — not one long field at a time.
  const files = [];
  const mk = async (key, borrower, llc, addr, opts) => {
    const existing = await db.query(`SELECT id FROM applications WHERE ys_loan_number=$1`, [key]);
    if (existing.rows[0]) { files.push([key, existing.rows[0].id]); return existing.rows[0].id; }
    const id = uuid();
    await db.query(
      `INSERT INTO applications (id, borrower_id, llc_id, status, ys_loan_number, lender,
         property_address, property_type, loan_type, rehab_type, units, purchase_price,
         as_is_value, arv, rehab_budget, loan_amount, ltv, rate_pct, term, program,
         loan_officer_name, occupancy, submitted_at, expected_closing)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,'RTL',$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,'Non-owner occupied',now(),now()::date + 21)`,
      [id, borrower, llc, opts.status, key, opts.lender, JSON.stringify(addr), opts.propType,
       opts.rehabType, opts.units, opts.purchase, opts.asIs, opts.arv, opts.rehab,
       opts.loan, opts.ltv, opts.rate, opts.term, opts.program, opts.officer]);
    files.push([key, id]);
    return id;
  };

  const longFile = await mk('YSCAP-CSSAUDIT-LONG', longBorrower, llcId, LONG.address, {
    status: 'underwriting',
    lender: 'Northwestern Mutual Structured Credit Opportunities Fund IV, L.P.',
    propType: 'Multi-family 2-4', rehabType: 'Heavy Renovation / Full Gut', units: 4,
    purchase: 12750000, asIs: 13100000, arv: 18950000, rehab: 4875000,
    loan: 14212500, ltv: 78.5, rate: 11.875,
    term: '18 months interest-only with two 3-month extensions',
    program: 'Ground-Up Construction — Tier 3 Experienced Builder',
    officer: 'Alexandra Konstantinopoulos-Vandermeulen',
  });
  const shortFile = await mk('YS-1', shortBorrower, null, SHORT.address, {
    status: 'new', lender: 'Fidelis', propType: 'SFR', rehabType: 'Light', units: 1,
    purchase: 210000, asIs: 215000, arv: 305000, rehab: 45000,
    loan: 220000, ltv: 71.2, rate: 10.5, term: '12 mo', program: 'Fix & Flip', officer: 'Bo Li',
  });

  // ---- conditions: long labels, long notes, an unbroken filename --------
  const conds = [
    ['outstanding', 'Executed Assignment of Contract together with the fully-ratified original purchase and sale agreement, all addenda, and proof of earnest money deposit', LONG.unbroken],
    ['received', 'Insurance', null],
    ['outstanding', 'Borrower to provide a written letter of explanation addressing the two 30-day mortgage lates reported on the subject credit report in September and November', 'See ' + LONG.unbroken],
    ['issue', 'HOA questionnaire', null],
    ['satisfied', 'Certificate of good standing for ' + LONG.entity, null],
  ];
  for (const [status, label, notes] of conds) {
    const dupe = await db.query(
      `SELECT id FROM checklist_items WHERE application_id=$1 AND label=$2`, [longFile, label]);
    if (dupe.rows[0]) continue;
    // `chk_one_owner`: exactly one of application_id / borrower_id / llc_id.
    await db.query(
      `INSERT INTO checklist_items (scope, application_id, label, status, notes, audience, item_kind)
       VALUES ('application',$1,$2,$3,$4,'borrower','document')`,
      [longFile, label, status, notes]);
  }

  console.log(JSON.stringify({
    staffToken, borrowerToken,
    staffId: admin.id, staffId2: admin2.id,
    borrowerId: longBorrower, shortBorrowerId: shortBorrower,
    llcId, longFile, shortFile,
    files: Object.fromEntries(files),
  }));
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
