'use strict';
/**
 * DOCLAB — the module surface.
 *
 * DocLab (Private Lender Law) drafts the loan documents. It is the API form of a
 * step this repo already automates by email: `lib/closing-prep.js` sends the closing
 * package to TeamAG@privatelenderlaw.com and a human at that firm drafts from it.
 * Same firm, same step, structured payload instead of an attachment.
 *
 * The pieces, in the order they matter:
 *   catalog.js    what DocLab publishes about itself — statuses, categories,
 *                 fee templates, the variable dictionary, the per-template matrix.
 *   scope.js      what this build is allowed to ask for. RTL only: no DSCR
 *                 category, no DSCR prepayment code. Refuses structurally.
 *   field-map.js  where every DocLab variable comes from in PILOT, and — where
 *                 nothing feeds it yet — exactly what is missing.
 *   payload.js    builds the request. Pure. Never fabricates a value.
 *   client.js     the guarded transport. Switches, dry-run, write gate, token.
 *
 * Full research, the workflow placement and the open questions: docs/doclab/.
 */

module.exports = {
  catalog: require('./catalog'),
  scope: require('./scope'),
  fieldMap: require('./field-map'),
  payload: require('./payload'),
  client: require('./client'),
};
