'use strict';

/**
 * THE RTL SIDE EFFECTS OF A CONDITION DOCUMENT, named and separated.
 *
 * The upload / review / delete doors do two different kinds of work. One kind is
 * the DOCUMENT RULE — what the bytes are, which slot they land in, what a
 * duplicate is, which prior version they supersede, what a verdict does to the
 * condition. That is the same in both products and lives in the sibling modules
 * here; it is the thing the owner ordered shared (2026-08-30,
 * docs/longterm/SHARE-THE-CODE-DIRECTIVE.md).
 *
 * The other kind is what the SHORT-TERM PRODUCT does about it: push the mapped
 * condition to a ClickUp dropdown, email the borrower on their portal, remember
 * a Sitewire pull so the next poll does not re-file a document a person deleted.
 * None of that is a fact about documents; all of it is a fact about RTL. A
 * Long-Term loan has no ClickUp condition field, no `/app/:id` portal page and
 * no Sitewire.
 *
 * So they are HOOKS, gathered here, and `defaultHooks(owner)` hands them over
 * for `scope='application'` and hands over NOTHING for any other owner. Two
 * consequences, both deliberate:
 *
 *   • no RTL call site changes behaviour — the RTL doors pass no hooks at all
 *     and get exactly the side effects they have always had, in the same places;
 *   • a Long-Term document can never fire RTL machinery by omission. A hook set
 *     that defaulted ON would send an RTL portal link to a Long-Term borrower
 *     the first time somebody forgot an argument, and nothing would go red.
 *
 * Every hook is BEST-EFFORT, exactly as the inline code it was lifted from was:
 * a ClickUp outage or a bounced email may not turn a stored document into a
 * failed upload.
 */

const { enqueueChecklistStatusPush } = require('../../clickup/enqueue');
const notify = require('../notify');

/**
 * A condition whose state may have moved → the mapped ClickUp dropdown.
 * RETURNS the (already-swallowed) promise, so a caller that used to `await` this
 * enqueue still does and one that fired it and walked away still can — the two
 * doors differ on that today and neither may quietly change.
 */
function conditionTouched(itemId) {
  if (!itemId) return Promise.resolve();
  // A document on the title / insurance condition means the order's documents
  // are in — whichever email chain, or hand, they arrived by (owner-directed
  // 2026-09-03). Self-gating for any other condition; never fails the upload.
  require('../order-tracking').documentsInFromCondition(itemId).catch(() => {});
  return enqueueChecklistStatusPush(itemId).catch(() => {});
}

/**
 * "Your loan team added a document" — the shared list works both ways.
 * Staff-only (internal) conditions never reach the borrower; the caller has
 * already applied that rule and simply does not call this.
 *
 * `ownerId` is the RTL application the upload came in on. It is used for the
 * FILE CONTEXT even on an entity-slot upload — the notification then says which
 * file the entity document was added from while being FILED against no
 * application, because an entity document belongs to the person, not the file.
 * That asymmetry is deliberate and is exactly what the inline code did.
 */
async function notifyUpload({ borrowerId, ownerId, llcId, itemLabel, filename, slot }) {
  try {
    const ctx = await notify.fileContext(ownerId);
    await notify.notifyBorrower(borrowerId, {
      type: 'doc_uploaded', title: `Your loan team added a document to "${itemLabel}"`,
      body: `"${filename}" was uploaded to ${llcId ? 'your entity documents' : `condition "${itemLabel}"`}${slot ? ` (${slot})` : ''}${ctx ? ` on ${ctx.label}` : ''} on your behalf.`,
      meta: (ctx && ctx.borrowerMeta) || undefined,
      applicationId: llcId ? null : ownerId, link: llcId ? '/entities' : `/app/${ownerId}` });
  } catch (_) { /* best-effort */ }
}

/**
 * A document PULLED from Sitewire onto a draw (`draw_attachments.source_key`)
 * must have its removal REMEMBERED — the delete CASCADES the `draw_attachments`
 * row away (db/507), and without the ledger entry the next Sitewire poll
 * re-downloads and re-files the document forever. Read BEFORE the delete, and
 * recorded AFTER it, which is why this is two halves of one hook.
 */
async function rememberSitewireBeforeDelete(q, doc) {
  try {
    const da = (await q.query(
      `SELECT application_id, source_key FROM draw_attachments WHERE document_id=$1 AND source_key IS NOT NULL LIMIT 1`,
      [doc.id])).rows[0];
    if (da) return { sourceKey: da.source_key, applicationId: da.application_id };
  } catch (_) { /* best-effort — never blocks the delete */ }
  return null;
}

async function rememberSitewireAfterDelete(_q, _doc, carried) {
  if (!carried || !carried.sourceKey) return;
  try { await require('../../sitewire/property-doc-ingest').rememberRemoved(carried.applicationId, carried.sourceKey); }
  catch (_) { /* best-effort */ }
}

/** The whole RTL set, as one nameable thing. */
const RTL = Object.freeze({
  conditionTouched,
  notifyUpload,
  beforeDelete: rememberSitewireBeforeDelete,
  afterDelete: rememberSitewireAfterDelete,
});

/**
 * The set an owner gets when the caller names none: RTL's for an RTL
 * application, and NOTHING for anybody else.
 *
 * The RTL doors that have no owner to hand (`/documents/:id/review`,
 * `DELETE /documents/:id` — a document id alone, authorized through
 * `canSeeDocument`) pass `RTL` explicitly instead. That is deliberate: the
 * alternative was guessing a scope from whichever owner column happened to be
 * set, and a hook set that can be reached by guessing is a hook set that will
 * one day fire on the wrong product.
 */
function defaultHooks(owner) {
  return (owner && owner.scope === 'application') ? RTL : {};
}

module.exports = {
  RTL, defaultHooks, conditionTouched, notifyUpload,
  rememberSitewireBeforeDelete, rememberSitewireAfterDelete,
};
