'use strict';
/**
 * LONG-TERM — EVERYTHING AN ORDER NEEDS ABOUT A LOAN, IN ONE READ.
 *
 * The shared letter builder (`src/lib/order-email.js`) takes a plain object and
 * knows nothing about either product's tables. This is the long-term side's half of
 * that contract: it turns `lt_loans` + `lt_properties` + `lt_parties` + the file's
 * vendor cards into exactly that object.
 *
 * ── THE VENDOR DIRECTORY IS SHARED, THE LINK IS OURS ────────────────────────
 *
 * A vendor card is a `service_contacts` row — the SAME directory the short-term
 * desk uses, because the owner was explicit: *"You need to make sure you're not
 * copying the information. You're just using the information from the short-term
 * side."* One title company, one card, corrected in one place. What is ours is the
 * LINK (`lt_loan_vendors`): which card this loan uses for which job.
 *
 * The join is a LEFT JOIN and carries no foreign key (db/644's header says why), so
 * a card somebody deleted from the directory reads as GONE — `blockers` then refuses
 * the order and says so — rather than cascading into our table or blocking their
 * screen.
 *
 * ── A DEGRADED READ IS NOT AN EMPTY FILE ────────────────────────────────────
 *
 * Every read is its own try/catch and reports what it could not read. A blank
 * borrower name because the parties table was briefly unreachable must never be
 * printed to a title company as the borrower's name; the desk refuses instead.
 *
 * SEPARATION: reads `lt_*` and the authorized shared `service_contacts` /
 * `staff_users`. Writes nothing.
 */

const db = require('../db');
const orderEmail = require('../../lib/order-email');
const kinds = require('./kinds');
// The ONE answer to "does this order belong on this file" — asked here so a card
// the desk greys is also one the send door refuses.
const appliesRule = require('./applies');
const switches = require('./switches');

/** A one-line property address from the long-term property row. */
function propertyLine(p) {
  if (!p) return '';
  const tail = [p.city, [p.state, p.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  return [p.street, tail].filter(Boolean).join(', ');
}

/** Purchase / Refinance, in the words a vendor uses, from the loan's own purpose. */
function transactionType(purpose) {
  const s = String(purpose || '').toLowerCase();
  if (!s) return '';
  if (/cash[_\s-]*out/.test(s)) return 'Cash-out refinance';
  if (/refi/.test(s)) return 'Refinance';
  if (/purchase/.test(s)) return 'Purchase';
  return String(purpose);
}

/** A person's name from a party row, however much of it we hold. */
function partyName(p) {
  if (!p) return '';
  if (p.entity_legal_name && String(p.party_type || '').toLowerCase() === 'entity') return String(p.entity_legal_name);
  return [p.first_name, p.middle_name, p.last_name, p.name_suffix]
    .map((x) => String(x || '').trim()).filter(Boolean).join(' ');
}

/** One line for a residence row, for the borrower's MAILING address. */
function residenceLine(r) {
  if (!r) return null;
  const tail = [r.city, [r.state, r.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  const s = [r.street, tail].filter(Boolean).join(', ');
  return s || null;
}

/**
 * Everything an order email or the desk needs about one loan.
 *
 * @returns {Promise<object|null>} null only when the loan does not exist. A loan
 *          that exists but could not be fully read comes back with `unreadable`
 *          populated — the caller decides, and `blockers` refuses on it.
 */
async function getOrderData(loanId, client = db) {
  const id = String(loanId);
  const out = { loanId: id, appId: id, unreadable: [] };

  const one = async (what, sql, params, assign) => {
    try {
      const { rows } = await client.query(sql, params);
      assign(rows);
    } catch (e) {
      out.unreadable.push({ what, why: String((e && e.message) || e).slice(0, 200) });
      assign(null);
    }
  };

  let loan = null;
  await one('loan',
    `SELECT l.id, l.loan_number, l.borrower_name, l.borrower_email, l.borrower_id,
            l.loan_amount, l.loan_purpose, l.program_name, l.product_kind,
            l.vesting_entity_name, l.milestone_name, l.stage_key, l.loan_officer_id,
            l.product_kind,
            p.street, p.city, p.state, p.zip, p.unit_count, p.gse_property_type,
            p.in_flood_zone, p.purchase_price, p.appraised_value, p.estimated_value,
            p.gross_monthly_rent
       FROM lt_loans l
       LEFT JOIN lt_properties p ON p.loan_id = l.id
      WHERE l.id = $1::uuid`,
    [id], (rows) => { loan = (rows && rows[0]) || null; });

  if (!loan && !out.unreadable.length) return null;
  if (!loan) loan = {};

  out.loanNumber = loan.loan_number || null;
  out.hasLoanNumber = !!String(loan.loan_number || '').trim();
  out.propertyLine = propertyLine(loan);
  // The PARTS as well as the joined line. The owner's own drafts address the
  // property one field at a time («Subject_Property_Address_11», «..._City_12»,
  // «..._State_14», «..._Zip_15»), so a draft pasted in verbatim needs each part
  // to resolve on its own — a single joined line cannot answer four tokens.
  out.propertyStreet = loan.street || null;
  out.propertyCity = loan.city || null;
  out.propertyZip = loan.zip || null;
  out.propertyState = loan.state || null;
  out.propertyType = loan.gse_property_type || null;
  out.unitCount = loan.unit_count == null ? null : Number(loan.unit_count);
  out.inFloodZone = loan.in_flood_zone === true ? true : (loan.in_flood_zone === false ? false : null);
  out.loanAmountRaw = loan.loan_amount == null ? null : Number(loan.loan_amount);
  out.loanAmount = orderEmail.money(out.loanAmountRaw);
  out.purchasePrice = loan.purchase_price == null ? null : Number(loan.purchase_price);
  out.appraisedValue = loan.appraised_value == null ? null : Number(loan.appraised_value);
  out.grossMonthlyRent = loan.gross_monthly_rent == null ? null : Number(loan.gross_monthly_rent);
  out.transactionType = transactionType(loan.loan_purpose);
  out.loanPurpose = loan.loan_purpose || null;
  out.programName = loan.program_name || null;
  out.productKind = loan.product_kind || null;
  out.entityName = loan.vesting_entity_name || null;
  out.borrowerName = loan.borrower_name || null;
  out.borrowerEmail = loan.borrower_email || null;
  // A long-term loan has no expected closing date of its own, so the letters say
  // "we will confirm it as soon as it is set" rather than printing a guess.
  out.expectedClosing = null;
  out.rehabBudget = null;

  // ── The people on the loan ────────────────────────────────────────────────
  let parties = [];
  await one('parties',
    `SELECT pa.id, pa.role, pa.party_type, pa.first_name, pa.middle_name, pa.last_name,
            pa.name_suffix, pa.date_of_birth, pa.email, pa.mobile_phone, pa.home_phone,
            pa.entity_legal_name, bp.pair_number
       FROM lt_parties pa
       JOIN lt_borrower_pairs bp ON bp.id = pa.pair_id
      WHERE bp.loan_id = $1::uuid
      ORDER BY bp.pair_number, pa.role`,
    [id], (rows) => { parties = rows || []; });

  const people = parties.filter((p) => String(p.party_type || '').toLowerCase() !== 'entity');
  const primary = people.find((p) => String(p.role || '').toLowerCase() === 'borrower') || people[0] || null;
  const co = people.find((p) => p !== primary) || null;
  if (!out.borrowerName && primary) out.borrowerName = partyName(primary);
  if (!out.borrowerEmail && primary) out.borrowerEmail = primary.email || null;
  out.coBorrowerName = co ? partyName(co) : null;
  out.coBorrowerEmail = co ? (co.email || null) : null;
  // NAME PARTS, for the same reason as the address parts above: the owner's drafts
  // print «Borrower_First_And_Middle_Name_36» «Borrower_Last_Name_4002» as two
  // fields. Built from the SAME columns partyName() joins, so a name can never
  // read one way in the letter body and another in the parts.
  out.borrowerFirstMiddle = primary
    ? [primary.first_name, primary.middle_name].map((x) => String(x || '').trim()).filter(Boolean).join(' ') || null
    : null;
  // The suffix rides with the last name (a "Jr." belongs to the surname, and the
  // owner's draft has no token of its own for it — dropping it would rename a person).
  out.borrowerLastName = primary
    ? [primary.last_name, primary.name_suffix].map((x) => String(x || '').trim()).filter(Boolean).join(' ') || null
    : null;
  out.coBorrowerFirstName = co ? (String(co.first_name || '').trim() || null) : null;
  out.coBorrowerLastName = co
    ? [co.last_name, co.name_suffix].map((x) => String(x || '').trim()).filter(Boolean).join(' ') || null
    : null;
  out.borrowerPhone = primary ? (primary.mobile_phone || primary.home_phone || null) : null;
  out.dob = primary && primary.date_of_birth ? orderEmail.dayText(primary.date_of_birth) : null;
  if (!out.entityName) {
    const entity = parties.find((p) => String(p.party_type || '').toLowerCase() === 'entity' || p.entity_legal_name);
    out.entityName = entity ? (entity.entity_legal_name || null) : null;
  }

  // The borrower's own HOME address, which is where an insurance policy is mailed —
  // never the subject property, which on a long-term file is a rental somebody else
  // lives in.
  await one('residences',
    `SELECT r.street, r.city, r.state, r.zip, r.residency_type
       FROM lt_residences r
       JOIN lt_parties pa ON pa.id = r.party_id
       JOIN lt_borrower_pairs bp ON bp.id = pa.pair_id
      WHERE bp.loan_id = $1::uuid`,
    [id], (rows) => {
      const list = rows || [];
      const current = list.find((r) => String(r.residency_type || '').toLowerCase() === 'current') || list[0] || null;
      out.borrowerMailingAddress = residenceLine(current);
      // The parts, for «Borrower_Present_Address_FR0104» and its city/state/zip
      // siblings — same row, so the line and the parts can never disagree.
      out.borrowerMailingStreet = current ? (current.street || null) : null;
      out.borrowerMailingCity = current ? (current.city || null) : null;
      out.borrowerMailingState = current ? (current.state || null) : null;
      out.borrowerMailingZip = current ? (current.zip || null) : null;
    });

  // ── Who signs the order ───────────────────────────────────────────────────
  // The loan officer, from the SHARED staff roster (authorized read). This is the
  // person the vendor can telephone, and — once send-as-user is on — the address
  // the order comes FROM.
  await one('officer',
    /* `staff_users.nmls` — NOT `nmls_id`, which is what this asked for and which
       does not exist. Every read here is its own try/catch, so the wrong name did
       not throw: the officer read simply FAILED, `unreadable` was never empty,
       and `blockers` then refused EVERY long-term order with the generic "could
       not read the whole loan". The desk could not place an order at all, and
       the reason a person saw named nothing they could fix. The short-term side
       reads `lo.nmls` (notify.js), which is the column that exists. */
    `SELECT su.id, NULLIF(btrim(su.full_name), '') AS name, su.email, su.phone, su.title, su.nmls
       FROM staff_users su
      WHERE su.id = $1::uuid AND su.is_active = true`,
    [loan.loan_officer_id || null], (rows) => {
      const r = rows && rows[0];
      out.officer = r ? { id: r.id, name: r.name || null, title: r.title || 'Loan Officer', email: r.email || null, phone: r.phone || null, nmls: r.nmls || null } : null;
    });

  // The processor, off the loan's own Encompass-mirrored contact roles. Their card
  // rides the Cc so a vendor's reply reaches the person actually working the file.
  await one('contacts',
    `SELECT role, encompass_name, encompass_email, COALESCE(override_staff_id, staff_id) AS staff_id
       FROM lt_loan_contacts WHERE loan_id = $1::uuid`,
    [id], (rows) => {
      const list = rows || [];
      const proc = list.find((c) => /process/i.test(String(c.role || '')));
      out.processor = proc && proc.encompass_email ? { name: proc.encompass_name || null, email: proc.encompass_email } : null;
      out.contacts = list.map((c) => ({ role: c.role, name: c.encompass_name || null, email: c.encompass_email || null }));
    });

  // A long-term file has no helper login of its own yet, so nobody is ever CC'd as
  // one. Stated rather than omitted: the shared recipient rule reads `data.helpers`,
  // and an absent key would read the same as an empty one only by luck.
  out.helpers = [];

  /* ── WHICH OF THIS FILE'S CONDITIONS EXIST ────────────────────────────────
     THE ONE ANSWER TO "DOES THIS ORDER BELONG ON THIS FILE". The engine already
     decides that, per condition, from the owner's own rules — a payoff condition
     on a refinance, a condo questionnaire on a condominium, a settlement agent
     in New York — and `orders/applies.js` used to answer it a SECOND time from a
     small table of its own. Two statements of one rule drift, and the A-to-Z
     audit found exactly where: the table had no entry for the payoff order or the
     verification of rent, so both showed as belonging on every file including the
     purchases and the owner-occupied ones their conditions are never attached to.

     `routes/orders.js` re-runs `evaluateLoan` immediately before reading the desk,
     so this list is the engine's own current answer rather than a stale one.

     NULL, NEVER AN EMPTY LIST, when it cannot be read — "this file has no
     conditions" and "PILOT could not read them" are different facts, and only the
     first would justify greying an order out. */
  out.conditionCodes = null;
  await one('conditions',
    `SELECT t.code
       FROM checklist_items ci
       JOIN checklist_templates t ON t.id = ci.template_id
      WHERE ci.lt_loan_id = $1::uuid AND t.code IS NOT NULL`,
    [id], (rows) => { out.conditionCodes = rows ? rows.map((r) => String(r.code)) : null; });

  // ── The vendor cards ──────────────────────────────────────────────────────
  await one('vendors',
    `SELECT v.id AS link_id, v.kind, v.is_primary, v.service_contact_id,
            sc.id AS contact_id, sc.company_name, sc.contact_name, sc.email, sc.emails,
            sc.phone, sc.phones, sc.address, sc.contact_type
       FROM lt_loan_vendors v
       LEFT JOIN service_contacts sc ON sc.id = v.service_contact_id
      WHERE v.loan_id = $1::uuid
      ORDER BY v.is_primary DESC, sc.company_name NULLS LAST`,
    [id], (rows) => {
      const byKind = {};
      const extras = {};
      for (const r of (rows || [])) {
        const card = r.contact_id
          ? {
            id: r.contact_id, company_name: r.company_name, contact_name: r.contact_name,
            email: r.email, emails: r.emails, phone: r.phone, phones: r.phones,
            address: r.address, contact_type: r.contact_type,
          }
          // The card was removed from the shared directory. Recorded as MISSING
          // rather than dropped, so the desk can say "the company on this file is
          // no longer in the directory" instead of "no vendor" — two different
          // instructions for the person reading it.
          : { id: null, missing: true, serviceContactId: r.service_contact_id };
        if (r.is_primary && !byKind[r.kind]) byKind[r.kind] = card;
        else (extras[r.kind] = extras[r.kind] || []).push(card);
      }
      out.vendorCards = byKind;
      out.vendorCardsExtra = extras;
    });

  // The shared builder and the shared recipient rule read `data.vendors[<orderKind>]`,
  // so the cards are re-keyed by ORDER kind through the registry — one mapping, in
  // one place, rather than each call site remembering that an insurance order is
  // addressed to the hazard-insurance card.
  out.vendors = {};
  out.vendorsExtra = {};
  for (const k of kinds.ORDER_KIND_KEYS) {
    const vk = kinds.vendorKindFor(k);
    out.vendors[k] = (out.vendorCards || {})[vk] || null;
    out.vendorsExtra[k] = ((out.vendorCardsExtra || {})[vk] || []);
  }

  /* WHICH ORDERS ARE SWITCHED ON, read LIVE from the condition library rather than
     from the code constant — the owner's rule: "everything should be able to be
     configured differently in settings; the system is only prefilled with the rules
     of the system". `switches.resolve` falls back to the shipped default on an
     unreadable read, so an outage can never switch an order on that shipped off.
     Read here, once, so the desk and the send re-check the SAME answer. */
  out.enabled = await switches.resolve(client);

  return out;
}

/** Every address an order of this kind would go TO. The ONE reading — the shared
    `vendorEmails` folds the legacy scalar `email` and the `emails` array, which is
    the trap db/224 left behind on the short-term side. */
function vendorEmails(kind, data) {
  return orderEmail.vendorEmails(kind, data);
}

/**
 * WHAT STILL STOPS THIS ORDER — an empty list means it is ready to send.
 *
 * Each code is a distinct instruction for the person reading it, and they are NOT
 * interchangeable: "no vendor on the file" sends you to the contacts form, "the
 * company on this file is no longer in the directory" sends you to the vendors
 * screen, and "this kind is switched off" is not something anybody can clear at all.
 *
 * FAILS CLOSED on an unreadable file: a loan we could not read is not a loan we know
 * is ready, and an order transmits a borrower's details to an outside company.
 */
function blockers(kind, data) {
  const out = [];
  const def = kinds.orderKind(kind);
  if (!def) return ['unknown_kind'];
  if (!data) return ['file'];
  if (Array.isArray(data.unreadable) && data.unreadable.length) out.push('unreadable');
  /* THE SWITCH IS THE SETTING, and the code constant is only what we ship with.
     `stateFor` falls back to that default when the map is absent, so a caller that
     never read it behaves exactly as before. */
  if (!switches.stateFor(data.enabled, def.key).enabled) out.push('disabled');
  if (!data.hasLoanNumber) out.push('loan_number');
  if (!String(data.propertyLine || '').trim()) out.push('property');
  const card = (data.vendors || {})[def.key];
  if (!card) out.push('contact');
  else if (card.missing) out.push('contact_removed');
  else if (!vendorEmails(def.key, data).length) out.push('contact_email');
  if (!String(data.borrowerName || '').trim()) out.push('borrower');

  /* IS IT EVEN FOR THIS FILE? Found by the A-to-Z audit (2026-08-31): the desk
     greyed a card that does not apply and `canOrder` was still TRUE, so `place`
     cheerfully sent a verification of rent on a file with no landlord and a
     condo questionnaire on a house. The greying was cosmetic — the screen hid
     the button and the door accepted it anyway, which is the same class as a way
     hidden from a condition form that its write door still records.

     ONLY A PROVEN NO BLOCKS. `appliesTo` is three-valued and its own header is
     explicit about the third: showing an order somebody cannot use costs a click,
     hiding one they need costs a closing. So `null` — the file has not said yet —
     goes through exactly as it did before. */
  if (appliesRule.appliesTo(def.key, data).applies === false) out.push('not_for_file');
  return out;
}

/** Why an order cannot go, in words a person can act on. One sentence per code. */
const BLOCKER_TEXT = Object.freeze({
  unknown_kind: 'There is no such order.',
  file: 'That loan is not here.',
  unreadable: 'PILOT could not read the whole loan just now, so it will not send an order off a partial file. Try again in a moment.',
  disabled: 'This order is switched off in settings.',
  loan_number: 'The loan number is not on the file yet, and every order carries it in the mortgagee clause.',
  property: 'The property address is not on the file yet.',
  contact: 'Nobody is on the file for this yet — add them on the file contacts.',
  contact_removed: 'The company on this file is no longer in the vendor directory. Pick another card.',
  contact_email: 'The company on this file has no email address on its card.',
  borrower: 'The borrower’s name is not on the file yet.',
  not_for_file: 'This order is not for this kind of file.',
});

/**
 * Why an order cannot go, in words.
 *
 * `not_for_file` has no fixed sentence: the reason a card does not belong is the
 * file's own ("this is a purchase, so there is no existing loan to pay off"), and
 * it is the SAME sentence the greyed card shows — one wording, from
 * `applies.js`, so a refusal can never say something different from the card the
 * person is looking at. Without the kind and the file to ask, it falls back to
 * the general form rather than pretending to know which.
 */
function blockerText(code, kind, data) {
  if (code === 'not_for_file') {
    const why = (kind && data) ? appliesRule.appliesTo(kind, data).why : null;
    return why || 'This order is not for this kind of file.';
  }
  return BLOCKER_TEXT[code] || String(code);
}

module.exports = {
  getOrderData, blockers, blockerText, vendorEmails, BLOCKER_TEXT,
  _internals: { propertyLine, transactionType, partyName, residenceLine },
};
