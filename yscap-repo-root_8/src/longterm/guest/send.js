'use strict';
/**
 * LONG-TERM — SEND A BORROWER THE LOGIN-FREE LINK TO THEIR CONDITIONS.
 *
 * The owner asked for this surface on 2026-08-28 and named it while doing so:
 * *"another way for borrowers to manage their conditions if they're not so
 * technical. A more simple condition center for them, with an email directly
 * with links to upload and enter the information over there … without him being
 * able to set up an account or portal."* The 2026-08-30 share-the-code directive
 * then made the Condition Center ONE implementation for both products, so this
 * file is deliberately thin: the link, the jail, the expiry, the revocation and
 * the EMAIL ITSELF are all the shared module's, and what lives here is the two
 * things that are genuinely Long-Term's own — which loan, and which conditions.
 *
 * ── WHY THE EMAIL IS NOT REWRITTEN HERE ─────────────────────────────────────
 *
 * `buildOutstandingEmail` reads as short-term at a glance, and it is not: every
 * product-specific line in it is already keyed on the ITEM rather than on the
 * product. The Scope-of-Work line appears only for `toolKey === 'rehab_budget'`,
 * which no long-term condition carries, so it simply does not appear. Copying
 * the builder to change nothing but the sender would be the second copy the
 * owner rejected — and the copy is the one that stops getting the fix when the
 * shared one is improved.
 *
 * The WORDING that IS Long-Term's own — every condition's label and hint — is
 * already Long-Term's own, because it comes out of `read.forLoan` from the
 * long-term condition library. The email is a frame around the borrower's own
 * items; the items are what carry the voice.
 *
 * ── WHAT IT WILL NOT DO ─────────────────────────────────────────────────────
 *
 * · It never sends to an address the caller supplies for a borrower it did not
 *   check — the recipient is resolved from the loan's own confirmed borrower.
 * · It never mints a link for a loan with nothing outstanding. A link is an
 *   instruction to do something; sending one that opens an empty list trains
 *   people to ignore the next one.
 * · It never throws for a reason a person can act on — every refusal comes back
 *   as `{ ok: false, reason }` in plain words.
 */

const db = require('../db');
const conditionLink = require('../../lib/condition-link');
const read = require('../conditions-center/read');

/** Register the long-term doors the moment anything here is used. */
require('./jail').register();

/** The bucket keys a client never sees are already filtered by `read.forLoan`
    (audience 'external'); what is left is "not finished yet". */
function outstandingFrom(list) {
  return (list || [])
    .filter((c) => !read.DONE.has(String(c.status || '')))
    .map((c) => ({
      // The shared email builder's own item shape. `kind: 'checklist'` is what
      // earns a condition its OWN direct link in the email — the owner's
      // *"every condition should have an upload button that takes them
      // directly to upload to that condition directly."*
      kind: 'checklist',
      id: c.id,
      label: c.label,
      detail: c.hint || null,
      /* NO `toolKey`, DELIBERATELY. The shared builder uses it for exactly one
         line — the Scope-of-Work / Investor Suite pointer, keyed on
         `rehab_budget`, which is a short-term construction concept no long-term
         condition carries. The long-term reader does not expose a tool key at
         all (it is selected and never mapped), so passing one would be a field
         that is always null pretending to mean something. Omitted, and said so
         here rather than left to look like an oversight. */
    }));
}

/**
 * What is still outstanding on this loan, in the BORROWER's own wording.
 * Never throws; an unreadable loan answers an empty list and says so.
 */
async function outstandingFor(loanId, client = db) {
  let view = null;
  try {
    view = await read.forLoan(loanId, { db: client, audience: 'client' });
  } catch (_) {
    return { ok: false, items: [], reason: 'PILOT could not read this loan’s conditions just now.' };
  }
  /* THE CONDITIONS LIVE INSIDE THE BUCKETS. `forLoan` returns
     `{ buckets, summary, degraded, audience }` and each bucket carries its own
     `conditions` — there is no top-level list. The first cut of this file read
     `view.conditions`, which is `undefined`, so every loan would have answered
     "nothing outstanding" and the email would have gone out empty while
     reporting success. Nothing would have errored. Flattened here, once. */
  const all = [];
  for (const b of (view && view.buckets) || []) {
    for (const c of (b && b.conditions) || []) all.push(c);
  }

  /* A DEGRADED READ IS NOT AN EMPTY ONE. `read.forLoan` answers `degraded` when
     it could not read everything, and treating that as "nothing outstanding"
     would send a borrower a link to an empty list — or, worse, tell the team
     the file is clear. Say we could not tell. */
  if (view && view.degraded) {
    return { ok: false, items: outstandingFrom(all), degraded: true,
      reason: 'PILOT could only partly read this loan’s conditions, so it will not send a list that may be short.' };
  }
  return { ok: true, items: outstandingFrom(all) };
}

module.exports = { outstandingFor, _internals: { outstandingFrom } };
