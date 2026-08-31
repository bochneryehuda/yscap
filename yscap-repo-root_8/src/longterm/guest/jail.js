'use strict';
/**
 * LONG-TERM — THE DOORS A GUEST CONDITION LINK MAY REACH.
 *
 * The guest link (`src/lib/condition-link.js`, authorized per item in
 * docs/LONG-TERM-AUTHORIZED-COPIES.md) hands an emailed, forwardable token a
 * REAL borrower session. The only reason that is safe is the path jail, and
 * this file is the Long-Term half of it: the complete list of what such a
 * session may do on a long-term loan, and nothing else.
 *
 * WHY THE LIST LIVES HERE AND NOT IN THE SHARED MODULE. Shared back-end code
 * may not name `/api/lt` — `check-product-separation` refuses it, because the
 * moment one product spells out the other's routes the boundary stops meaning
 * anything. So the shared module owns the MECHANISM (one jail per owner kind,
 * default-deny, the id in the path must be the one the link was minted for) and
 * each product declares its own doors. Registering is how they meet.
 *
 * ── WHAT IS IN, AND WHAT IS DELIBERATELY OUT ────────────────────────────────
 *
 * IN: read the conditions on ONE loan, and upload a document to a condition on
 * it. That is the whole borrower-facing long-term surface — `/api/lt/my`,
 * already mounted behind requireAuth + requireBorrower — and it is exactly what
 * the owner asked the simple condition center to do: *"an email directly with
 * links to upload and enter the information over there."*
 *
 * OUT, and this one matters: **`GET /api/lt/my/loans`**, the loan LIST. A link
 * arrives by email and can be forwarded to a spouse, a bookkeeper, an attorney.
 * Whoever holds it may work the conditions on the ONE loan it names; they may
 * not learn what else this borrower has borrowed. The jail is default-deny, so
 * leaving it off this list is all it takes — but it is written down because the
 * next person to add a door will be tempted to add "just the list too".
 *
 * The two upload doors carry the loan AND the condition in the PATH, so they
 * need no body or header inspection to be pinned to the right file. `noEntity`
 * is the one extra check: the shared upload module files onto a COMPANY when
 * handed an `llcId`, and an emailed link must never put a document on the
 * borrower's company record.
 */

const conditionLink = require('../../lib/condition-link');

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

const LT_GUEST_RULES = [
  { m: 'GET', re: new RegExp(`^/api/lt/my/loans/(${UUID})/conditions$`) },
  { m: 'POST', re: new RegExp(`^/api/lt/my/loans/(${UUID})/conditions/${UUID}/documents$`), noEntity: true },
  { m: 'POST', re: new RegExp(`^/api/lt/my/loans/(${UUID})/conditions/${UUID}/documents/binary$`), noEntity: true },
];

/** Declare them. Idempotent — a second call replaces the same list. */
function register() {
  return conditionLink.registerJail('lt_loan', LT_GUEST_RULES);
}

module.exports = { LT_GUEST_RULES, register };
