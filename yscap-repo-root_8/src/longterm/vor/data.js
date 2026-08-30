'use strict';
/**
 * LONG-TERM — FILLING THE VERIFICATION OF RENT IN FROM WHAT WE ALREADY KNOW.
 *
 * Owner-directed: *"prefill part one and part two."* This builds our half of the
 * form from the loan — the lender block, the applicant, the address they rent, the
 * rent and the term as THEY stated them, and the landlord we already have on file —
 * so a processor confirms rather than retypes.
 *
 * ── IT NEVER FILLS IN THE LANDLORD'S HALF ───────────────────────────────────
 *
 * The whole point of a verification of rent is that an independent party answers.
 * `fields.cleanOurData` refuses a landlord key at the door and this module never
 * produces one: we know the rent the BORROWER stated, and it goes in Part II
 * labelled as exactly that, so the landlord confirms it or corrects it in Part III.
 * Printing the borrower's figure into the landlord's blank would turn the form into
 * a piece of paper that verifies nothing.
 *
 * ── AN UNREADABLE READ SAYS SO ──────────────────────────────────────────────
 *
 * Each read is its own try/catch and reports which one failed. A form quietly short
 * a field reads as "we do not know that", which is a claim — and here it would send
 * a landlord a form with a blank where the address should be.
 *
 * SEPARATION: reads lt_* on the long-term pool, plus the SHARED staff roster
 * (authorized identity read). It writes nothing.
 */
const db = require('../db');
const F = require('./fields');
const vendorDirectory = require('../../lib/vendor-directory');   // the PURE half only — see the ledger

const LENDER = {
  name: 'YS Capital Group',
  address: '5 New Montrose Avenue, Brooklyn, NY 11211',
  nmls: '2609746',
};

function addressLine(r) {
  if (!r) return null;
  const street = String(r.street || '').trim();
  const city = String(r.city || '').trim();
  const state = String(r.state || '').trim().toUpperCase();
  const zip = String(r.zip || '').trim();
  const tail = [city, [state, zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  const line = [street, tail].filter(Boolean).join(', ');
  return line || null;
}

function partyName(p) {
  if (!p) return null;
  const n = [p.first_name, p.middle_name, p.last_name].map((x) => String(x || '').trim()).filter(Boolean).join(' ');
  const suffix = String(p.name_suffix || '').trim();
  const full = [n, suffix].filter(Boolean).join(' ').trim();
  return full || null;
}

/** 'YYYY-MM-DD' from a date column, without ever passing a date-only value through
    `new Date()` (the repo's date-only rule — that is a UTC day-shift waiting to
    happen). */
function dayOf(v) {
  if (!v) return null;
  if (typeof v === 'string') {
    const m = v.match(/^(\d{4}-\d{2}-\d{2})/);
    return m ? m[1] : null;
  }
  if (v instanceof Date && !Number.isNaN(v.getTime())) return v.toISOString().slice(0, 10);
  return null;
}

/** The month a tenancy began, derived from "they have been there N months" when no
    start date was captured. Derived rather than guessed: it is labelled "as stated"
    on the form, and the landlord corrects it. */
function sinceFromMonths(months) {
  const n = Number(months);
  if (!Number.isFinite(n) || n <= 0 || n > 1200) return null;
  const now = new Date();
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - Math.round(n), 1));
  return d.toISOString().slice(0, 10);
}

/**
 * Build our half of the form for a loan.
 *
 * @returns {Promise<{data:object, unreadable:string[], landlord:{name,email,phone}|null,
 *                    borrowerRents:boolean|null}>}
 */
async function prefill(loanId, client = db) {
  const id = String(loanId);
  const unreadable = [];
  const data = {
    lender_name: LENDER.name,
    lender_address: LENDER.address,
    lender_nmls: LENDER.nmls,
    requested_on: new Date().toISOString().slice(0, 10),
  };
  let landlord = null;
  let borrowerRents = null;

  async function one(what, sql, params, apply) {
    try { apply((await client.query(sql, params)).rows); }
    catch (e) { unreadable.push(what); }
  }

  let loan = null;
  await one('loan',
    `SELECT l.id, l.loan_number, l.loan_officer_id, l.borrower_name
       FROM lt_loans l WHERE l.id = $1::uuid`,
    [id], (rows) => { loan = (rows && rows[0]) || null; });
  if (!loan && !unreadable.length) return null;
  loan = loan || {};
  if (loan.loan_number) data.loan_number = String(loan.loan_number);
  if (loan.borrower_name) data.borrower_name = String(loan.borrower_name);

  // ── who is applying ───────────────────────────────────────────────────────
  let parties = [];
  await one('parties',
    `SELECT pa.id, pa.role, pa.party_type, pa.first_name, pa.middle_name, pa.last_name,
            pa.name_suffix, bp.pair_number
       FROM lt_parties pa
       JOIN lt_borrower_pairs bp ON bp.id = pa.pair_id
      WHERE bp.loan_id = $1::uuid
      ORDER BY bp.pair_number, pa.role`,
    [id], (rows) => { parties = rows || []; });
  const people = parties.filter((p) => String(p.party_type || '').toLowerCase() !== 'entity');
  const primary = people.find((p) => String(p.role || '').toLowerCase() === 'borrower') || people[0] || null;
  const co = people.find((p) => p !== primary) || null;
  if (!data.borrower_name && primary) data.borrower_name = partyName(primary);
  if (co) data.coborrower_name = partyName(co);

  /* ── where they live, and whether they RENT it ──────────────────────────────
     The condition this form answers only exists on a file where the borrower rents
     (Encompass FR0115, mirrored here as `residency_basis`). The CURRENT residence
     is the one being verified; a previous one is somebody else's landlord and a
     different form. */
  await one('residence',
    `SELECT r.street, r.city, r.state, r.zip, r.residency_basis, r.residency_type,
            r.duration_months, r.monthly_rent
       FROM lt_residences r
       JOIN lt_parties pa ON pa.id = r.party_id
       JOIN lt_borrower_pairs bp ON bp.id = pa.pair_id
      WHERE bp.loan_id = $1::uuid
      ORDER BY (CASE WHEN lower(r.residency_type::text) = 'current' THEN 0 ELSE 1 END),
               pa.id`,
    [id], (rows) => {
      const list = rows || [];
      const current = list.find((r) => String(r.residency_type || '').toLowerCase() === 'current') || list[0] || null;
      if (!current) return;
      const basis = String(current.residency_basis || '').toLowerCase();
      borrowerRents = basis ? /rent/.test(basis) : null;
      const line = addressLine(current);
      if (line) data.rental_address = line;
      if (current.monthly_rent != null) data.stated_rent = String(current.monthly_rent);
      if (current.duration_months != null) {
        data.stated_months = String(current.duration_months);
        const since = sinceFromMonths(current.duration_months);
        if (since) data.stated_since = since;
      }
    });

  // ── the landlord we already hold ──────────────────────────────────────────
  // The same vendor card the orders desk would send to, so the form and the order
  // can never name two different landlords.
  await one('landlord',
    `SELECT sc.company_name, sc.contact_name, sc.email, sc.emails, sc.phone, sc.phones
       FROM lt_loan_vendors v
       JOIN service_contacts sc ON sc.id = v.service_contact_id
      WHERE v.loan_id = $1::uuid AND v.kind = 'landlord'
      ORDER BY v.is_primary DESC, v.created_at DESC
      LIMIT 1`,
    [id], (rows) => {
      const r = rows && rows[0];
      if (!r) return;
      /* db/224 put an `emails` ARRAY beside the legacy `email` scalar and backfilled
         only the rows that existed then, so reading either one alone silently drops
         addresses. `allEmails` is the ONE reading of that pair — the reason the
         crossing was authorized in the first place. Same for the phones. */
      const emails = vendorDirectory.allEmails(r);
      const phones = vendorDirectory.allPhones(r);
      const name = String(r.contact_name || '').trim() || String(r.company_name || '').trim() || null;
      landlord = { name, email: emails[0] || null, emails, phone: phones[0] || null };
      if (name) data.landlord_name = name;
    });

  // ── who at YS Capital is asking ───────────────────────────────────────────
  await one('officer',
    `SELECT NULLIF(btrim(su.full_name), '') AS name, su.email, su.phone
       FROM staff_users su
      WHERE su.id = $1::uuid AND su.is_active = true`,
    [loan.loan_officer_id || null], (rows) => {
      const r = rows && rows[0];
      if (!r) return;
      if (r.name) data.officer_name = String(r.name);
      if (r.email) data.officer_email = String(r.email);
      if (r.phone) data.officer_phone = String(r.phone);
    });

  return { data: F.cleanOurData(data), unreadable, landlord, borrowerRents };
}

/**
 * The prefill MERGED under whatever a person has already edited.
 *
 * A person's own value always wins — the whole reason the form is editable is that
 * the file is sometimes wrong — but a field they never touched picks up anything
 * new the file has learned since. So re-opening a half-edited form neither loses
 * their corrections nor freezes a stale address.
 */
function mergeSaved(prefilled, saved) {
  const out = { ...(prefilled || {}) };
  for (const [k, v] of Object.entries(saved || {})) {
    if (v == null || String(v).trim() === '') continue;
    out[k] = v;
  }
  return F.cleanOurData(out);
}

module.exports = { prefill, mergeSaved, LENDER, _internals: { addressLine, partyName, dayOf, sinceFromMonths } };
