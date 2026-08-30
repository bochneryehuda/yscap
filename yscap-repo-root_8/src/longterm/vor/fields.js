'use strict';
/**
 * LONG-TERM — THE VERIFICATION OF RENT: WHAT THE FORM ASKS, AND WHO ANSWERS IT.
 *
 * Owner-directed 2026-08-30: *"prefill part one and part two … leave the landlord's
 * sections blank and required on DocuSign … be able to preview and edit the PDF
 * before sending … send by DocuSign, by email attachment, or both … and if it comes
 * back filled in by hand, void the envelope."*
 *
 * This module is the ONE definition of the form: every field, which PART it sits in,
 * WHO answers it, and — for the landlord's half — the invisible anchor its DocuSign
 * tab lands on. It is PURE: no database, no config, no PDF engine, no network, so
 * every rule here is unit-testable and the three consumers (the prefill, the PDF and
 * the envelope's tab list) cannot drift from one another.
 *
 * ── THE ANCHOR IS THE CONTRACT, AND IT IS DECLARED ONCE ─────────────────────
 *
 * A DocuSign anchor tab lands on a string PRINTED IN THE DOCUMENT. So the PDF and
 * the tab list are two halves of one mechanism, and the moment they are written in
 * two places they drift — the tab lands on the wrong line, or on nothing, and the
 * landlord is asked to sign a blank corner. Both read `anchor` from here, and the
 * test asserts every landlord field's anchor is actually drawn.
 *
 * ── WHY THERE IS ONE SIGNER, NOT TWO ────────────────────────────────────────
 *
 * A rent verification is a request WE make of a landlord, and the borrower's
 * permission to make it was given when they signed the application — which is what
 * the authorization paragraph on the form cites. So the envelope has ONE recipient:
 * the landlord. Routing it through the borrower first would double the turnaround on
 * a submission-gating condition to collect a signature we already hold.
 * The owner named only the landlord's tabs; this states the reading out loud so it
 * can be reversed deliberately rather than discovered.
 *
 * ── "REQUIRED" MEANS DOCUSIGN REFUSES TO FINISH WITHOUT IT ──────────────────
 *
 * A required tab is enforced by DocuSign in the signing session — the landlord
 * cannot press Finish while one is empty. That is the whole reason the blanks are
 * tabs rather than lines on a page: a form emailed as an attachment comes back with
 * whatever somebody felt like filling in, and chasing the rest is the work this is
 * meant to remove.
 *
 * SEPARATION: pure. Nothing here reads a table, a config value or another module.
 */

/** The three parts, in the order they print. */
const PARTS = [
  {
    key: 'request',
    number: 'I',
    title: 'The request',
    blurb: 'Completed by the lender. Nothing here is for the landlord to answer.',
    who: 'us',
  },
  {
    key: 'onfile',
    number: 'II',
    title: 'What the borrower has told us',
    blurb: 'Completed by the lender from the loan application. The landlord confirms or corrects it in Part III.',
    who: 'us',
  },
  {
    key: 'landlord',
    number: 'III',
    title: 'To be completed by the landlord or managing agent',
    blurb: 'Every answer below is required.',
    who: 'landlord',
  },
];

/**
 * The fields.
 *
 * `who: 'us'`       — we fill it in, it prints as text, the landlord cannot change it.
 * `who: 'landlord'` — it prints as a blank rule with an invisible anchor under it,
 *                     and DocuSign puts a REQUIRED tab there.
 *
 * `type` is what the PDF draws and what the editor offers:
 *   text | money | date | months | phone | email | multiline | yesno | signature
 */
const FIELDS = [
  // ── Part I — the request ─────────────────────────────────────────────────
  { key: 'lender_name',      part: 'request', who: 'us', type: 'text',      label: 'Lender' },
  { key: 'lender_address',   part: 'request', who: 'us', type: 'text',      label: 'Lender address' },
  { key: 'lender_nmls',      part: 'request', who: 'us', type: 'text',      label: 'NMLS' },
  { key: 'loan_number',      part: 'request', who: 'us', type: 'text',      label: 'Loan number' },
  { key: 'requested_on',     part: 'request', who: 'us', type: 'date',      label: 'Date of this request' },
  { key: 'officer_name',     part: 'request', who: 'us', type: 'text',      label: 'Who to reply to' },
  { key: 'officer_email',    part: 'request', who: 'us', type: 'email',     label: 'Reply-to email' },
  { key: 'officer_phone',    part: 'request', who: 'us', type: 'phone',     label: 'Reply-to phone' },
  { key: 'borrower_name',    part: 'request', who: 'us', type: 'text',      label: 'Applicant' },
  { key: 'coborrower_name',  part: 'request', who: 'us', type: 'text',      label: 'Co-applicant', optional: true },

  // ── Part II — what we hold on file ───────────────────────────────────────
  { key: 'rental_address',   part: 'onfile',  who: 'us', type: 'text',      label: 'Address the applicant rents' },
  { key: 'stated_rent',      part: 'onfile',  who: 'us', type: 'money',     label: 'Monthly rent, as stated' },
  { key: 'stated_since',     part: 'onfile',  who: 'us', type: 'date',      label: 'Renting since, as stated' },
  { key: 'stated_months',    part: 'onfile',  who: 'us', type: 'months',    label: 'Months at this address, as stated' },
  { key: 'landlord_name',    part: 'onfile',  who: 'us', type: 'text',      label: 'Landlord or managing agent' },

  // ── Part III — the landlord answers ──────────────────────────────────────
  { key: 'll_rent',          part: 'landlord', who: 'landlord', type: 'money',
    label: 'Current monthly rent', anchor: 'vor_ll_rent' },
  { key: 'll_from',          part: 'landlord', who: 'landlord', type: 'date',
    label: 'Tenancy began', anchor: 'vor_ll_from' },
  { key: 'll_to',            part: 'landlord', who: 'landlord', type: 'text',
    label: 'Tenancy ended (or “current”)', anchor: 'vor_ll_to' },
  { key: 'll_paid_current',  part: 'landlord', who: 'landlord', type: 'yesno',
    label: 'Is the rent paid to date?', anchor: 'vor_ll_current' },
  { key: 'll_late_12',       part: 'landlord', who: 'landlord', type: 'text',
    label: 'Payments 30+ days late in the last 12 months', anchor: 'vor_ll_late12' },
  { key: 'll_notice',        part: 'landlord', who: 'landlord', type: 'yesno',
    label: 'Has notice to vacate been given by either party?', anchor: 'vor_ll_notice' },
  { key: 'll_comments',      part: 'landlord', who: 'landlord', type: 'multiline',
    label: 'Anything else we should know', anchor: 'vor_ll_comments', optional: true },
  { key: 'll_signer_name',   part: 'landlord', who: 'landlord', type: 'text',
    label: 'Name of the person signing', anchor: 'vor_ll_who' },
  { key: 'll_signer_title',  part: 'landlord', who: 'landlord', type: 'text',
    label: 'Title', anchor: 'vor_ll_title' },
  { key: 'll_signer_phone',  part: 'landlord', who: 'landlord', type: 'phone',
    label: 'Telephone', anchor: 'vor_ll_phone' },
  { key: 'll_signature',     part: 'landlord', who: 'landlord', type: 'signature',
    label: 'Signature', anchor: 'vor_ll_sig' },
  { key: 'll_signed_on',     part: 'landlord', who: 'landlord', type: 'date',
    label: 'Date signed', anchor: 'vor_ll_dt' },
];

const BY_KEY = new Map(FIELDS.map((f) => [f.key, f]));

/** The fields WE fill in — the ones the preview lets a person edit. */
function ourFields() { return FIELDS.filter((f) => f.who === 'us'); }
/** The fields the LANDLORD answers — one DocuSign tab each. */
function landlordFields() { return FIELDS.filter((f) => f.who === 'landlord'); }

/**
 * The DocuSign tab list for the landlord, derived from the fields above.
 *
 * A `signature` field becomes a signHere tab, a `date` field signed BY the signer
 * becomes a dateSigned tab (DocuSign stamps it — a person cannot mistype the date
 * they signed on), and everything else is a text tab. Every one of them is REQUIRED
 * unless the field says otherwise, because an optional tab is a blank we then have
 * to chase.
 *
 * The anchor string is what DocuSign searches the document for, so it is returned
 * EXACTLY as the PDF draws it — slashes included. Two different fields can never
 * share an anchor (asserted below and by the test): DocuSign would put both tabs on
 * whichever occurrence it found first.
 */
function anchorString(field) {
  if (!field || !field.anchor) return null;
  return `/${field.anchor}/`;
}

function tabsForLandlord() {
  const out = { sign: [], date: [], text: [] };
  for (const f of landlordFields()) {
    const anchor = anchorString(f);
    if (!anchor) continue;
    if (f.type === 'signature') { out.sign.push(anchor); continue; }
    if (f.key === 'll_signed_on') { out.date.push(anchor); continue; }
    out.text.push({
      anchor,
      tabLabel: f.key,                 // what the answer comes BACK keyed by
      required: !f.optional,
      width: f.type === 'multiline' ? 380 : 180,
      height: f.type === 'multiline' ? 40 : 14,
    });
  }
  return out;
}

/** Every anchor the PDF must draw, so the test can prove none is missing. */
function allAnchors() {
  return landlordFields().map(anchorString).filter(Boolean);
}

/* A duplicate anchor puts two tabs on one line and leaves the other blank — a
   defect nobody sees until a landlord returns a half-filled form. It is a
   programming error, so it is caught at LOAD, not by a test somebody might not
   run. */
(function assertAnchorsUnique() {
  const seen = new Set();
  for (const a of allAnchors()) {
    if (seen.has(a)) throw new Error(`vor/fields: two fields share the anchor ${a}`);
    seen.add(a);
  }
})();

/**
 * What is still missing before this can be sent.
 *
 * Only OUR fields are judged — the landlord's are blank BY DESIGN, which is the
 * whole point of the form. An `optional` field of ours is never demanded (a file
 * with one borrower has no co-applicant, and asking for one would be nonsense).
 *
 * Returns the field KEYS, so the screen can point at the box rather than printing a
 * sentence somebody has to translate back into a field.
 */
function missing(data) {
  const d = data || {};
  const out = [];
  for (const f of ourFields()) {
    if (f.optional) continue;
    const v = d[f.key];
    if (v == null || String(v).trim() === '') out.push(f.key);
  }
  return out;
}

/**
 * Keep only the fields this form actually has, and only OUR half.
 *
 * The editor posts an object; a key nothing recognises is DROPPED rather than
 * stored, and a LANDLORD key sent from our side is dropped too — filling in the
 * landlord's answer for them is the one thing a verification of rent may never do,
 * and the door is where that has to be refused rather than a rule somebody
 * remembers.
 */
function cleanOurData(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [k, v] of Object.entries(raw)) {
    const f = BY_KEY.get(k);
    if (!f || f.who !== 'us') continue;
    if (v == null) { out[k] = null; continue; }
    out[k] = String(v).slice(0, f.type === 'multiline' ? 2000 : 200).trim();
  }
  return out;
}

module.exports = {
  PARTS, FIELDS, BY_KEY,
  ourFields, landlordFields, anchorString, tabsForLandlord, allAnchors,
  missing, cleanOurData,
};
