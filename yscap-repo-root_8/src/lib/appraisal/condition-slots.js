'use strict';
/**
 * THE APPRAISAL-DOCUMENTS CONDITION AND ITS TWO SLOTS — one definition, shared by
 * every vendor that returns an appraisal (owner-directed 2026-08-16).
 *
 * THE BUG THIS CLOSES
 * -------------------
 * `rtl_cond_appraisaldocs` declares TWO named slots (db/144): the appraisal DATA
 * file (XML) and the appraisal REPORT (PDF). `signOffGate` matches them by
 * lower-case SUBSTRING on `documents.slot_label` — a document with no slot label
 * fills neither slot, however plainly it is the appraisal.
 *
 * Two of the three appraisal vendors filed their returned documents with
 * `slot_label` NULL and `doc_kind` NULL:
 *
 *   • AppraisalScope / NAN  — `src/amc/sync.js` `ingestDocuments`
 *   • Class Valuation       — `src/class/documents.js` `ingestForOrder`
 *
 * …and the ORDER row's `checklist_item_id` (which is what put them on the
 * condition at all) was only ever set from a request field neither front-end
 * panel sends, so in practice it was NULL too. The end state on a live file: the
 * report came back, the data imported, the findings were built — and the
 * appraisal-documents condition still read "Upload BOTH the appraisal data file
 * (XML) and the appraisal report (PDF)" with both documents sitting on the file,
 * unreachable, so the condition could not be signed off and the file could not
 * clear to close without a human hunting the documents down and re-filing them
 * by hand.
 *
 * Richer Values — the third and most recent vendor — already does this correctly
 * (`src/richervalues/documents.js` files its PDF with the label the gate looks
 * for, and resolves the condition itself). This module is that behaviour lifted
 * into ONE place so all three vendors, and anything added later, file a returned
 * appraisal identically.
 *
 * THE LABELS ARE DERIVED, NEVER RESTATED. `slotLabels()` reads the condition
 * template's OWN `slots` jsonb, exactly as `lib/order-slots.js` does for the
 * title/insurance conditions — a hand-kept copy would drift the moment an admin
 * edits the template, and a label that no longer contains "xml"/"pdf" would
 * silently stop satisfying the gate. The db/144 literals below are the fallback
 * for a database that cannot be read, and are kept byte-identical to that
 * migration's seed so the fallback can never invent a slot the condition has not
 * got.
 */

const CONDITION_CODE = 'rtl_cond_appraisaldocs';

/**
 * db/144's own labels. Used only when the template row cannot be read. Each MUST
 * contain the substring `signOffGate` tests for ('xml' / 'pdf') — that substring
 * is the contract between this module and the gate.
 */
const FALLBACK_LABELS = Object.freeze({
  xml: 'Appraisal data file (XML)',
  pdf: 'Appraisal report (PDF)',
});

/** The `documents.doc_kind` the MISMO importer's source documents carry. */
const DOC_KIND = Object.freeze({ xml: 'appraisal_xml', pdf: 'appraisal_pdf' });

/**
 * The appraisal-documents condition item on a file, or null when the file has
 * not got one. NEVER throws — a document filed with no condition is the exact
 * behaviour that shipped before this module, so a read failure degrades to it
 * rather than losing the document.
 */
async function conditionItemId(dbh, appId) {
  if (!dbh || !appId) return null;
  try {
    const r = await dbh.query(
      `SELECT ci.id FROM checklist_items ci
         JOIN checklist_templates t ON t.id = ci.template_id
        WHERE ci.application_id=$1 AND t.code=$2
        ORDER BY ci.created_at ASC
        LIMIT 1`,
      [appId, CONDITION_CODE]);
    return r.rows[0] ? r.rows[0].id : null;
  } catch (_) { return null; }
}

/**
 * The two slot labels the condition declares TODAY, keyed 'xml' / 'pdf'.
 *
 * A template slot is matched to a kind the same way the GATE matches a document
 * to a slot — a lower-case substring test over the slot's key and label — so the
 * label this returns is guaranteed to satisfy the gate. A template that has
 * dropped one of the two slots falls back to db/144's label for that kind alone:
 * the gate still requires it, so filing under the historical label is the only
 * answer that keeps the condition signable.
 */
async function slotLabels(dbh) {
  const out = { xml: FALLBACK_LABELS.xml, pdf: FALLBACK_LABELS.pdf };
  if (!dbh) return out;
  let slots = null;
  try {
    const r = await dbh.query(`SELECT slots FROM checklist_templates WHERE code=$1 LIMIT 1`, [CONDITION_CODE]);
    slots = r.rows[0] ? r.rows[0].slots : null;
  } catch (_) { return out; }
  if (!Array.isArray(slots)) return out;
  for (const kind of ['xml', 'pdf']) {
    const hit = slots.find((s) => {
      const key = String((s && s.key) || '').toLowerCase();
      const label = String((s && s.label) || '').toLowerCase();
      return key.includes(kind) || label.includes(kind);
    });
    // Only adopt the template's label when it still CARRIES the substring the
    // gate tests for. A renamed slot that lost it would file a document nothing
    // can see as filling that slot — the historical label is the safer answer.
    if (hit && String(hit.label || '').toLowerCase().includes(kind)) {
      out[kind] = String(hit.label).slice(0, 80);
    }
  }
  return out;
}

/**
 * The label to file a returned document under, made unique among the documents
 * already on the condition so two deliveries never display under one identical
 * label ("Appraisal report (PDF)" → "Appraisal report (PDF) (2)"). The suffix
 * keeps the substring, so a superseding delivery still satisfies the gate.
 *
 * Returns null when there is no condition to file against — the caller then
 * files the document on the loan file with no slot, exactly as before.
 */
async function labelFor(dbh, itemId, kind, labels) {
  if (!itemId) return null;
  const l = labels || (await slotLabels(dbh));
  const wanted = l[kind] || FALLBACK_LABELS[kind];
  try {
    return await require('../slot-label').uniqueSlotLabel(itemId, wanted, dbh);
  } catch (_) { return wanted; }
}

/**
 * A SUCCESSFUL MISMO IMPORT IS WHAT VOUCHES FOR THESE TWO DOCUMENTS.
 *
 * db/424's rule is that nothing un-accepted leaves the building, and that a
 * document PILOT itself generates or ORDERS is born accepted rather than waiting
 * for a human to vouch for a report we commissioned. These are ordered documents
 * — but rather than assert that at INSERT time, this accepts them only once the
 * XML has actually imported as a valid appraisal. That is positive proof the data
 * file is what it claims to be (and that the PDF that rode in with it is the
 * report), so nothing is ever taken on trust: an unreadable or unexpected
 * delivery stays `pending` and a human looks at it, which is the honest state.
 *
 * Only ever touches the two documents named. NEVER throws — an unaccepted
 * document is a one-click fix, a broken poll is not.
 */
async function acceptImportedSources(dbh, ids) {
  const list = (Array.isArray(ids) ? ids : []).filter(Boolean);
  if (!dbh || !list.length) return 0;
  try {
    const r = await dbh.query(
      `UPDATE documents
          SET review_status='accepted', reviewed_at=now()
        WHERE id = ANY($1::uuid[])
          AND COALESCE(review_status,'pending') = 'pending'`,
      [list]);
    return r.rowCount || 0;
  } catch (_) { return 0; }
}

module.exports = {
  CONDITION_CODE, FALLBACK_LABELS, DOC_KIND,
  conditionItemId, slotLabels, labelFor, acceptImportedSources,
};
