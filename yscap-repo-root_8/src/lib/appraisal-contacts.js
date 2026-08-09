'use strict';
/**
 * WHO THE APPRAISER CALLS — the one reader of a file's appraisal contacts.
 *
 * Both appraisal vendors ask the same question in the same four roles: who is the
 * BORROWER, who is the CO-BORROWER, who lets the appraiser into the property
 * (PROPERTY ACCESS), and who at the lender owns the file (LOAN OFFICER). Class
 * Valuation takes them as a `contacts[]` list (`src/class/order-build.js`); the AMC
 * takes them split across its own message (`src/amc/cdg.js`). What DIFFERS is the
 * wire shape; what must NOT differ is who we say those four people are — so the
 * READ lives here once and each vendor's builder only translates it.
 *
 * That is also the defect this closes. Both order services carried the same line —
 * `propertyContact: null, // filled from file contacts once wired` — so a realtor or
 * contractor sitting on the file, recorded precisely so somebody could open the door,
 * was never sent to either vendor and the appraiser rang the borrower every time.
 * Wiring it in one place is what stops the two desks drifting apart again.
 *
 * NEVER INVENT A PERSON. A role with no name and no way to reach them comes back
 * null rather than as an empty shell — a contact block carrying a role and nothing
 * else tells the appraiser there is somebody to call when there isn't. Every field
 * is read straight off the file; nothing here guesses, and nothing here writes.
 *
 * The DB read is one query per role source and never throws: an appraisal order must
 * not fail because the optional property-access lookup had a bad moment. `personFrom`
 * and `splitName` are pure and unit-tested (scripts/test-appraisal-contacts-pure.js).
 */

const { splitFullName } = require('./person-name');

const text = (v) => { const s = String(v == null ? '' : v).trim(); return s || null; };

// The file contact types that can genuinely let an appraiser IN, best first. A
// realtor holds the lockbox; a contractor is on site. Nothing else on the file
// (attorney, title, insurance) has anything to do with property access, and
// sending one would put a stranger's number on the appraiser's work order.
const ACCESS_TYPES = ['realtor', 'contractor'];

/**
 * Split a stored one-line name into first + last for a vendor that wants both.
 * Delegates to the repo's ONE splitter so a middle name or a suffix is handled the
 * same way it is everywhere else — never a `lastIndexOf(' ')` of its own.
 */
function splitName(full) {
  const s = text(full);
  if (!s) return { firstName: null, lastName: null };
  const p = splitFullName(s) || {};
  return { firstName: text(p.first), lastName: text(p.last) };
}

/**
 * One person, in the shape both vendor builders read. PURE.
 *
 * Returns null when there is nothing worth sending — no name AND no way to reach
 * them. A role we cannot fill is reported as absent, which is the truth; a blank
 * contact block is a claim that somebody is reachable.
 *
 * @param role  'Borrower' | 'Coborrower' | 'PropertyAccess' | 'LoanOfficer'
 */
function personFrom(role, src) {
  if (!src) return null;
  const first = text(src.firstName) || null;
  const last = text(src.lastName) || null;
  const full = text(src.fullName);
  const split = (!first && !last) ? splitName(full) : { firstName: first, lastName: last };
  const out = {
    role,
    firstName: split.firstName,
    lastName: split.lastName,
    fullName: full || text([split.firstName, split.lastName].filter(Boolean).join(' ')),
    company: text(src.company),
    email: text(src.email),
    mobile: text(src.mobile || src.cell),
    workPhone: text(src.workPhone || src.phone),
  };
  const reachable = out.email || out.mobile || out.workPhone;
  if (!out.fullName && !reachable) return null;
  return out;
}

// The best property-access contact on a file, or null. `service_contacts` holds
// many kinds; only the two that can open a door are considered, in that order.
async function loadPropertyAccess(db, appId) {
  try {
    const r = await db.query(
      `SELECT sc.contact_type, sc.company_name, sc.contact_name, sc.email, sc.phone
         FROM application_service_contacts l
         JOIN service_contacts sc ON sc.id = l.service_contact_id
        WHERE l.application_id = $1
          AND COALESCE(l.contact_type, sc.contact_type) = ANY($2::text[])
          AND sc.merged_into_id IS NULL`,
      [appId, ACCESS_TYPES]);
    const rows = r.rows || [];
    for (const type of ACCESS_TYPES) {
      const hit = rows.find((x) => x.contact_type === type);
      if (!hit) continue;
      const p = personFrom('PropertyAccess', {
        fullName: hit.contact_name || hit.company_name,
        company: hit.company_name,
        email: hit.email,
        workPhone: hit.phone,
      });
      if (p) { p.kind = type; return p; }
    }
    return null;
  } catch (_) {
    // An optional contact is never worth failing an order over.
    return null;
  }
}

/**
 * The four roles for a file: { borrower, coBorrower, propertyContact, loanOfficer }.
 * Any of them may be null. Returns null only when the file itself is missing, so a
 * caller can tell "no such file" from "nobody on file".
 */
async function loadAppraisalContacts(db, appId) {
  const r = await db.query(
    `SELECT a.id, a.co_borrower_id, a.loan_officer_id,
            b.first_name  AS b_first,  b.last_name AS b_last,  b.full_name AS b_full,
            b.email       AS b_email,  b.cell_phone AS b_cell,
            cb.first_name AS c_first,  cb.last_name AS c_last, cb.full_name AS c_full,
            cb.email      AS c_email,  cb.cell_phone AS c_cell,
            lo.full_name  AS lo_name,  lo.email AS lo_email,   lo.phone AS lo_phone
       FROM applications a
       JOIN borrowers b ON b.id = a.borrower_id
       LEFT JOIN borrowers cb ON cb.id = a.co_borrower_id
       LEFT JOIN staff_users lo ON lo.id = a.loan_officer_id
      WHERE a.id = $1 AND a.deleted_at IS NULL`, [appId]);
  const a = r.rows[0];
  if (!a) return null;

  return {
    borrower: personFrom('Borrower', {
      firstName: a.b_first, lastName: a.b_last, fullName: a.b_full, email: a.b_email, mobile: a.b_cell,
    }),
    coBorrower: a.co_borrower_id ? personFrom('Coborrower', {
      firstName: a.c_first, lastName: a.c_last, fullName: a.c_full, email: a.c_email, mobile: a.c_cell,
    }) : null,
    propertyContact: await loadPropertyAccess(db, appId),
    loanOfficer: a.loan_officer_id ? personFrom('LoanOfficer', {
      fullName: a.lo_name, email: a.lo_email, workPhone: a.lo_phone,
    }) : null,
  };
}

module.exports = { loadAppraisalContacts, personFrom, splitName, ACCESS_TYPES };
