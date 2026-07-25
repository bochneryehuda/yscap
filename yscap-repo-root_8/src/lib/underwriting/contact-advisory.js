'use strict';
/**
 * Title / insurance CONTACT-INFO condition ADVISORY (IG-W14, owner-directed 2026-07-24).
 *
 * Two Condition Center conditions collect the file's service contacts:
 *   - "Title contact email received"     (rtl_p1_titlec, tool_key 'title_contact')
 *   - "Insurance contact email received" (rtl_p1_insc,   tool_key 'insurance_contact')
 * The contact is entered as STRUCTURED DATA (not a document) via the file-contacts form and
 * stored in application_service_contacts. PILOT NEVER signs these off itself — a human always
 * clears a Condition Center condition (the owner-directed reversal). Instead PILOT lays an
 * ADVISORY on top of the human layer (pilot-advice-engine), telling the loan officer whether
 * the contact is on file. Advisory only — this clears nothing and blocks nothing.
 *
 * "PILOT has the contact" is the SAME strict, provable state the sign-off gate uses (staff.js
 * signOffGate, the isTitleContact/isInsContact branch), reused here 1:1 so the advisory can
 * never disagree with the gate: a row in application_service_contacts for THIS application
 * whose contact_type is one of the accepted types —
 *   - Title:     ['title_company']
 *   - Insurance: ['insurance_agent', 'flood_insurance']  (the gate accepts EITHER)
 *
 * There is no document_findings source for a contact (it is data, not an AI-read document),
 * so no "positive contradiction" signal exists — contradicted is always false (ready /
 * not_ready / agree only, never a false dispute), exactly like the experience / signed-term-
 * sheet advisories. The evaluator also mirrors the gate's is_required===false early-out (an
 * optional contact condition is signable empty → PILOT lays no advisory). Never throws.
 */

// The accepted contact_type values per condition — mirroring the sign-off gate exactly.
const TITLE_TYPES = ['title_company'];
const INSURANCE_TYPES = ['insurance_agent', 'flood_insurance'];

/**
 * Is a matching service contact on file for THIS application?
 * @param {*} client
 * @param {string} appId
 * @param {string[]} contactTypes  the accepted contact_type values (TITLE_TYPES / INSURANCE_TYPES)
 * @returns {Promise<{hasContact:boolean, complete:boolean}>}
 */
async function contactCompleteness(client, appId, contactTypes) {
  const out = { hasContact: false, complete: false };
  if (!appId || !contactTypes || !contactTypes.length) return out;
  try {
    const r = await client.query(
      `SELECT 1 FROM application_service_contacts
        WHERE application_id = $1 AND contact_type = ANY($2::text[])
        LIMIT 1`, [appId, contactTypes]);
    out.hasContact = !!r.rows[0];
    out.complete = out.hasContact;
  } catch (e) {
    console.error('[contact-advisory] contactCompleteness', appId, e && e.message);
  }
  return out;
}

module.exports = { contactCompleteness, TITLE_TYPES, INSURANCE_TYPES };
