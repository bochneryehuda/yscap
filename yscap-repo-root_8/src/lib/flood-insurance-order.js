'use strict';
/**
 * THE FLOOD INSURANCE ORDER (owner-directed 2026-08-28): "if a property is
 * defined by the flood certificate or by any other way that the property is in
 * a flood zone … there should be an order section … You basically need to ask
 * for the binder or paid invoice. It needs to have the same mortgage clause and
 * loan number of the regular insurance order, so follow about the same language
 * of the insurance order, but it should basically act for flood insurance since
 * the property is located in the flood zone."
 *
 * WHAT THIS MODULE OWNS: whether the order is available on a file (and the
 * reason when it is not), and the order email itself — the flood twin of the
 * insurance order: the same deal/borrower detail block, the same mortgagee
 * clause with the loan number (RCN's servicer clause included, through the ONE
 * clause rule in orders.js), asking for a FLOOD policy binder or paid invoice.
 *
 * WHO IT GOES TO: the file's `flood_insurance` contact. The DEFAULT is the
 * file's own insurance agent — but never silently: the desk asks "use the same
 * agent?" first (the owner: "The default should be the same insurance agent,
 * but it should verify before"), and saying yes copies the agent into a
 * flood_insurance contact so the two orders keep their own contact rows.
 *
 * THE ZONE IS THE GATE: no flood-insurance order goes out on a file whose flood
 * zone nobody has established — by the appraisal's FEMA fields, a completed
 * flood determination, or the manual "this property is in a flood zone" flip
 * (db/639), which also attaches the flood-insurance condition through the
 * existing engine rule. The reason is always stated.
 */
const db = require('../db');

/* The flood coverage ask — the flood counterpart of orders.js
   INSURANCE_COVERAGE_LINES, in the industry's own words. DISPLAY ONLY. */
const FLOOD_COVERAGE_LINES = Object.freeze([
  'A flood insurance policy (NFIP Standard Flood Insurance Policy, or a private flood policy with equivalent coverage) on the subject property — the property sits in a FEMA Special Flood Hazard Area.',
  'Building coverage at no less than the lesser of the loan amount or the maximum available limit ($250,000 under the NFIP for a 1–4 family dwelling); contents coverage is not required.',
  'YS Capital Group named as mortgagee and loss payee exactly as the clause below reads, with the loan number shown.',
  'At least 30 days’ written notice of cancellation or non-renewal to the mortgagee.',
  'Please return the BINDER or the PAID INVOICE (declarations page with proof of payment) — one of the two is required before closing.',
]);

/** Has anyone established the flood zone on this file? Mirrors the engine's own
    derivation (appraisal FEMA fields → completed determination → the manual
    flip), so the order gate and the condition rule can never disagree. */
async function floodZoneEstablished(appId, client = db) {
  const isA = (z) => /^(A|V)/.test(String(z || '').trim().toUpperCase());
  try {
    const a = (await client.query(`SELECT flood_zone_override FROM applications WHERE id=$1`, [appId])).rows[0];
    if (a && a.flood_zone_override === true) return { inZone: true, source: 'manual' };
  } catch (_) { /* fall through to the derived sources */ }
  try {
    const fz = (await client.query(
      `SELECT fema_flood_sfha, fema_flood_zone, flood_zone FROM appraisals
        WHERE application_id=$1 AND superseded=false
        ORDER BY imported_at DESC NULLS LAST, id DESC LIMIT 1`, [appId])).rows[0];
    if (fz && (fz.fema_flood_sfha === true || isA(fz.fema_flood_zone) || isA(fz.flood_zone))) {
      return { inZone: true, source: 'appraisal' };
    }
  } catch (_) { /* appraisals unavailable — keep looking */ }
  try {
    const fo = (await client.query(
      `SELECT sfha, flood_zone FROM encompass_flood_orders
        WHERE application_id=$1 AND status='completed'
        ORDER BY completed_at DESC NULLS LAST, id DESC LIMIT 1`, [appId])).rows[0];
    if (fo && (fo.sfha === true || isA(fo.flood_zone))) return { inZone: true, source: 'determination' };
  } catch (_) { /* table unavailable */ }
  return { inZone: false, source: null };
}

/**
 * The flood-insurance order email — the insurance order's flood twin. `data` is
 * orders.getOrderData's shape; `vendor` the flood_insurance service contact.
 */
function buildFloodOrderEmail(data, vendor, { note } = {}) {
  const tpl = require('./email/template');
  const quote = require('./email/quote');
  const orders = require('./orders');
  const clause = [...orders.mortgageeClauseFor(data.lender), `Loan #: ${data.loanNumber}`].join('\n');
  const greetName = (vendor && (vendor.contact_name || vendor.company_name)) || 'there';
  return tpl.render({
    title: 'Flood Insurance Quote Request',
    subjectTag: data.loanNumber || undefined,
    kicker: 'Flood insurance order',
    preheader: `Flood insurance quote request for ${data.propertyLine}`,
    greeting: '',
    intro: (note && String(note).trim())
      || `Hi ${greetName}, could you please provide a flood insurance quote for the following transaction? The property is located in a FEMA flood zone, so flood coverage is required. Everything we have on the deal is below — please let us know if anything else is needed to bind.`,
    lines: ['', 'Thank you,'],
    meta: [
      { label: 'Property', value: data.propertyLine || '—' },
      { label: 'Borrower', value: data.borrowerName || '—' },
      data.loanNumber ? { label: 'Loan Number', value: data.loanNumber } : null,
      data.transactionType ? { label: 'Transaction Type', value: data.transactionType } : null,
      data.entityName ? { label: 'Named Insured (vesting entity)', value: data.entityName } : null,
      data.loanAmount ? { label: 'Loan Amount', value: data.loanAmount } : null,
      // The same detail block the regular insurance order carries (the round-trip
      // killer): the agent's usual follow-up questions, answered up front.
      ...require('./orders').insuranceDetailMeta(data),
    ].filter(Boolean),
    sections: [{ title: 'Coverage requested', body: [...FLOOD_COVERAGE_LINES] }],
    callout: { title: 'Mortgagee Clause', body: clause },
    officer: data.officer ? {
      name: data.officer.name, title: data.officer.title, email: data.officer.email,
      phone: data.officer.phone, nmls: data.officer.nmls,
    } : undefined,
    note: 'Reply to this email and it reaches the whole loan team.',
    replyable: true,
    replyMarker: quote.replyMarker('and it reaches the whole loan team'),
    audience: 'staff',
  });
}

/** Copy the file's insurance agent into a flood_insurance contact and link it —
    the "use the same agent" default, made explicit (a COPY, so the two orders
    keep their own contact rows and a later flood-specialist swap never rewrites
    the homeowner's-policy contact). Returns the new contact row or null. */
async function adoptInsuranceAgent(appId, client = db) {
  const agent = (await client.query(
    `SELECT sc.* FROM application_service_contacts l
       JOIN service_contacts sc ON sc.id = l.service_contact_id
      WHERE l.application_id=$1 AND sc.contact_type='insurance_agent'
      ORDER BY sc.last_used_at DESC NULLS LAST, sc.updated_at DESC NULLS LAST LIMIT 1`, [appId])).rows[0];
  if (!agent) return null;
  const created = (await client.query(
    `INSERT INTO service_contacts (borrower_id, contact_type, company_name, contact_name, email, emails, phone, phones)
     VALUES ($1,'flood_insurance',$2,$3,$4,$5,$6,$7) RETURNING *`,
    [agent.borrower_id, agent.company_name, agent.contact_name, agent.email, agent.emails, agent.phone, agent.phones])).rows[0];
  await client.query(
    `INSERT INTO application_service_contacts (application_id, service_contact_id, contact_type)
     VALUES ($1,$2,'flood_insurance') ON CONFLICT DO NOTHING`, [appId, created.id]);
  return created;
}

/** The file's flood_insurance contact (most recently used first), or null. */
async function floodVendor(appId, client = db) {
  const r = await client.query(
    `SELECT sc.* FROM application_service_contacts l
       JOIN service_contacts sc ON sc.id = l.service_contact_id
      WHERE l.application_id=$1 AND sc.contact_type='flood_insurance'
      ORDER BY sc.last_used_at DESC NULLS LAST, sc.updated_at DESC NULLS LAST LIMIT 1`, [appId]);
  return r.rows[0] || null;
}

module.exports = {
  FLOOD_COVERAGE_LINES,
  floodZoneEstablished, buildFloodOrderEmail, adoptInsuranceAgent, floodVendor,
};
