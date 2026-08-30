'use strict';

/**
 * DOWNLOAD AND PREVIEW — the authorized row lookup, one definition, both products.
 *
 * The BYTES have had one definition since day one: `lib/serve-document.js`
 * streams a row, scrubs the attacker-controlled content type, refuses to render
 * anything outside a narrow inline allowlist, and sets one Content-Disposition.
 * Nothing here duplicates a line of that — this module answers the question that
 * comes BEFORE it, and that every door was answering for itself:
 *
 *     WHICH ROW may this request have?
 *
 * `owner` is OPTIONAL, and the two shapes are different on purpose:
 *
 *   • WITHOUT an owner the lookup is by id, exactly as RTL's staff door has
 *     always done — because that door then delegates to `canSeeDocument`, the
 *     one gate that also understands a borrower-owned or entity-owned document
 *     with no file at all. Narrowing it to a file owner would 403 the very
 *     documents that gate exists to reach (its own comments record two past
 *     incidents of precisely that).
 *
 *   • WITH an owner the ownership is welded into the STATEMENT. A document id
 *     from the other product does not reach a row that some later check is
 *     trusted to refuse — it reaches nothing. That is what a product-scoped door
 *     needs, and it is the difference between "we check" and "it cannot happen".
 *
 * `lt_loan_id` is in the column list so a caller can see which product a row
 * belongs to without a second read; nothing in the serving path reads it.
 */

const { ownerWhere } = require('../condition-owner');
const { serveDocument } = require('../serve-document');

/** Everything the serving path and the authorization gates need, and nothing more. */
const SERVE_COLUMNS = 'id,filename,content_type,storage_ref,application_id,lt_loan_id,borrower_id,llc_id';

async function documentForServe(q, id, owner = null) {
  if (!owner) return (await q.query(`SELECT ${SERVE_COLUMNS} FROM documents WHERE id=$1`, [id])).rows[0] || null;
  const w = ownerWhere(owner, null, 2);
  const r = await q.query(`SELECT ${SERVE_COLUMNS} FROM documents WHERE id=$1 AND ${w.sql}`, [id, ...w.params]);
  return r.rows[0] || null;
}

/**
 * Hand an ALREADY-AUTHORIZED row to the one streaming implementation. It exists
 * so a second door cannot quietly grow a second set of headers; the caller must
 * have decided the request may have this document.
 */
function serveConditionDocument(res, doc, { inline = false } = {}) {
  return serveDocument(res, doc, { inline });
}

module.exports = { SERVE_COLUMNS, documentForServe, serveConditionDocument };
