'use strict';

/**
 * THE SIDE-BY-SIDE LEDGER — every shared capability the SHORT-TERM side uses
 * that the LONG-TERM side does not, and what each one is.
 *
 * Owner-directed 2026-08-31: *"make sure that every single feature that is
 * available on the short-term side, every single guard, every single way of
 * operating, is also on the long-term side."*
 *
 * ── THE THREE VERDICTS, AND WHY THERE ARE THREE ─────────────────────────────
 *
 * A two-valued report (has it / does not) is useless here, because most of the
 * one-sided rows are neither: Long-Term does not call `takeUpload` by name and
 * has the streaming upload anyway, because it goes through the shared
 * condition-document door. Reporting that as missing would bury the two rows
 * that really are missing, and a report nobody trusts is a report nobody reads.
 *
 *   'shared'  — Long-Term HAS it, through a shared module named in `via`. The
 *               claim is checkable: `via` must be a module Long-Term calls.
 *   'n/a'     — it belongs to a short-term feature Long-Term does not have at
 *               all (its closing desk, its flood ordering, its ClickUp field
 *               map). Not a gap; a different product surface.
 *   'gap'     — the short-term side does this and the long-term side does not,
 *               and somebody has to decide whether to build it. THESE ARE THE
 *               ROWS THE OWNER IS ASKING FOR.
 *   'worker'  — NEITHER product calls it. One company-wide worker does the job
 *               for both, finding each product's rows itself. The SharePoint
 *               mirror is the whole reason this verdict exists: no long-term
 *               screen "calls the mirror" — the mirror SELECTS long-term
 *               documents. A 'via' claim would be false there, so the claim
 *               made instead is `proof`: a module the WORKER ITSELF reaches.
 *               The gate checks it, so "one worker serves both" can never be
 *               asserted about a worker that has never heard of long-term.
 *
 * ── WHAT THIS ENGINE STRUCTURALLY CANNOT SEE, SAID OUT LOUD ─────────────────
 *
 * It measures what a PRODUCT'S OWN CODE reaches. The off-site vault (the
 * nightly Cloudflare copy, `src/lib/backup/**`) is reached by NEITHER product:
 * it is a scheduled job that enumerates the document store BY KEY and dumps the
 * whole database with no table list. Listing those modules here would add ZERO
 * measured rows while reading as coverage, so they are deliberately absent —
 * the vault's side-by-side is proven where it can be, against real rows and
 * real keys, in `scripts/test-lt-sharepoint-cloudflare-db.js`.
 *
 * ── THE LEDGER CANNOT GO STALE, BY CONSTRUCTION ─────────────────────────────
 *
 * The gate checks it BOTH ways. A one-sided capability with no entry fails the
 * build (that is the whole point). And an ENTRY naming a capability that no
 * longer exists, or one that both products now use, ALSO fails — so a row that
 * was closed by a later change cannot sit here forever claiming to be a gap, and
 * a renamed function cannot leave a silent hole where its entry used to be.
 */

/**
 * @typedef {Object} Entry
 * @property {'shared'|'n/a'|'gap'} verdict
 * @property {string} [via]    for 'shared': the module Long-Term reaches it through
 * @property {string} why      one plain sentence, readable by somebody who is not a developer
 */

/* Every SharePoint-mirror row is the same shape, so it is written once here
   rather than twenty times below: the mirror is ONE loop over the documents
   table, and what makes that checkable is that the loop's own code reaches the
   long-term scope. */
const MIRROR_PROOF = 'src/longterm/sharepoint-scope.js';
const mirrorWorker = (why) => ({ verdict: 'worker', proof: MIRROR_PROOF, why });

/** module path → { capability name → Entry } */
const LEDGER = {
  'src/lib/condition-docs/upload.js': {},

  'src/lib/condition-docs/review.js': {},

  'src/lib/condition-docs/remove.js': {
  },

  'src/lib/condition-docs/serve.js': {
    entityDocumentForServe: {
      verdict: 'n/a',
      why: 'Opening a COMPANY’s document (which belongs to no loan file at all) needed its own '
        + 'lookup on the long-term side. The short-term side already reaches those documents '
        + 'through its own general staff download, which understands a document with no file '
        + 'on it — so it has the capability by another road that predates this one.',
    },
  },

  'src/lib/upload-stream.js': {
    jsonUploadBytes: {
      verdict: 'shared', via: 'src/lib/condition-docs/upload.js',
      why: 'The ceiling on a file sent inside the request body is applied by the shared '
        + 'upload door, which both products post through.',
    },
    tooLargeMessage: {
      verdict: 'shared', via: 'src/lib/condition-docs/upload.js',
      why: 'The plain-English "that file is too big" sentence comes from the same shared door, '
        + 'so both products refuse an oversized upload in the same words.',
    },
    takeUpload: {
      verdict: 'shared', via: 'src/lib/condition-docs/upload.js',
      why: 'Taking the bytes — whether they arrived inside the request or were streamed — is '
        + 'the shared door’s own first step.',
    },
    readUploadBytes: {
      verdict: 'n/a',
      why: 'Reading a stored upload back into memory is for the short-term extras that inspect '
        + 'a file after it lands (the appraisal data-file import, the document classifier). '
        + 'Long-Term has none of those yet, so there is nothing to read back for.',
    },
  },

  'src/lib/condition-owner.js': {
    ownerOfRow: {
      verdict: 'n/a',
      why: 'A helper for working out which product a document row belongs to when you are '
        + 'handed the row. Long-Term always knows — it starts from the loan.',
    },
  },

  'src/lib/llc.js': {
    parseMembers: {
      verdict: 'shared', via: 'src/lib/llc-edit.js',
      why: 'Reading and checking the owners list — the percentages, the titles, the shares — '
        + 'happens inside the shared save both products call.',
    },
    replaceMembers: {
      verdict: 'shared', via: 'src/lib/llc-edit.js',
      why: 'Writing the owners list is the same shared save.',
    },
    normalizeEin: {
      verdict: 'shared', via: 'src/lib/llc-edit.js',
      why: 'The EIN is put into one shape by the shared details save, so it is stored '
        + 'identically whichever product typed it.',
    },
    applyEntitySlotWording: {
      verdict: 'shared', via: 'src/lib/llc-edit.js',
      why: 'Re-wording a company’s document slots when its kind changes (a corporation is '
        + 'asked for bylaws, not an operating agreement) happens inside the shared save.',
    },
    confirmEntityType: {
      verdict: 'shared', via: 'src/lib/llc-edit.js',
      why: 'Recording that a PERSON chose a company’s kind — rather than the system assuming '
        + 'it — reaches the long-term side through the shared details save, which is where a '
        + 'long-term officer picks the kind. This separate function exists for the short-term '
        + 'paths that learn a kind somewhere else (the application form, the ClickUp card) and '
        + 'need to record it without overwriting a choice somebody already made; a long-term '
        + 'loan has no such other source, so there is nothing for it to call.',
    },
    ownersMissingTitles: {
      verdict: 'n/a',
      why: 'The closing desk’s nudge that an owner still has no signature title. Long-Term '
        + 'has no closing desk yet.',
    },
    getSlots: {
      verdict: 'shared', via: 'src/lib/llc.js',
      why: 'Long-Term reads a company’s document slots directly; the short-term side gets the '
        + 'same list inside the bundle.',
    },
    findLlcByName: {
      verdict: 'shared', via: 'src/lib/llc.js',
      why: 'Finding a company the borrower already has by its name is how a long-term file '
        + 'pre-fills it; the short-term side reaches the same function through its create path.',
    },
  },

  'src/lib/llc-edit.js': {
    documentLockFor: {
      verdict: 'shared', via: 'src/lib/llc-edit.js',
      why: 'Two halves of ONE rule: the short-term doors already hold the company row (they '
        + 'read it for their own permission check first) and ask the half that takes a row, '
        + 'while the long-term door asks the half that fetches one. Same sentence, same refusal.',
    },
    documentLock: {
      verdict: 'shared', via: 'src/lib/llc-edit.js',
      why: 'The other half of the same rule — see above.',
    },
  },

  'src/lib/vendor-directory.js': {
    allPhones: {
      verdict: 'shared', via: 'src/lib/vendor-directory.js',
      why: 'Reading every phone number on a vendor card — the pair db/224 split into a single '
        + 'number and a list, where reading either alone drops numbers. Long-Term calls it '
        + 'directly; the short-term desk reaches the same reader through its own contacts code.',
    },
    suggest: {
      verdict: 'n/a',
      why: 'Suggesting a vendor as you type reaches the short-term database pool directly, so '
        + 'it is deliberately off limits to Long-Term (recorded in the crossing ledger). '
        + 'Long-Term searches the same directory through its own door.',
    },
  },

  'src/lib/order-email.js': {
    buildOrderEmail: {
      verdict: 'shared', via: 'src/lib/order-email.js',
      why: 'Writing the order letter itself — the subject, the wording, the attachments. '
        + 'Long-Term calls it directly; the short-term desk reaches the same builder through '
        + 'its own order screen, which is why one change to a letter changes both.',
    },
    money: {
      verdict: 'shared', via: 'src/lib/order-email.js',
      why: 'Writing an amount the way an order letter says it — same builder, reached the '
        + 'other way round.',
    },
    transactionType: {
      verdict: 'shared', via: 'src/lib/order-email.js',
      why: 'Saying whether the deal is a purchase or a refinance in the letter — same.',
    },
    propertyLine: {
      verdict: 'shared', via: 'src/lib/order-email.js',
      why: 'The property line the vendor reads at the top of the order — same.',
    },
    vendorEmails: {
      verdict: 'shared', via: 'src/lib/order-email.js',
      why: 'Which addresses at the vendor the order goes to — same.',
    },
    recipientsFor: {
      verdict: 'shared', via: 'src/lib/order-email.js',
      why: 'The whole recipient list for an order, vendor and our own people together — same.',
    },
    dayText: {
      verdict: 'shared', via: 'src/lib/order-email.js',
      why: 'Writing a date the way an order letter says it. Long-Term calls it directly; the '
        + 'short-term side reaches it through its own letter builder.',
    },
    vendorGreetName: {
      verdict: 'shared', via: 'src/lib/order-email.js',
      why: 'How a vendor is greeted by name — same, reached the other way round.',
    },
    isAmbiguousSendFailure: {
      verdict: 'shared', via: 'src/lib/order-email.js',
      why: 'Telling a send that may have gone out anyway from one that certainly did not — so a '
        + 'retry cannot send a vendor the same order twice. Long-Term calls it directly; the '
        + 'short-term desk reaches the same rule through its own send path.',
    },
    sendVerdict: {
      verdict: 'shared', via: 'src/lib/order-email.js',
      why: 'Reading the mail provider’s answer to a send. Long-Term calls it directly; the '
        + 'short-term desk reaches it through its own send path.',
    },
    replyOrderSubject: {
      verdict: 'shared', via: 'src/lib/order-email.js',
      why: 'Keeping a reply on the vendor’s own thread — same.',
    },
  },

  'src/lib/order-cc.js': {
    ccBorrowerWith: {
      verdict: 'shared', via: 'src/lib/order-cc.js',
      why: 'The same decision as the one the send makes, for a screen that already holds the '
        + 'officer’s settings because it is painting every checkbox at once. Only the short-term '
        + 'orders panel needs it — the long-term screen asks the fetching half — but it is the '
        + 'SAME rule underneath, which is what stops a tick on a screen disagreeing with what '
        + 'the send would actually do.',
    },
    ccHelperWith: {
      verdict: 'shared', via: 'src/lib/order-cc.js',
      why: 'The helper’s own footing, same screen, same rule — see above.',
    },
  },

  'src/lib/file-address.js': {
    fileReplyTo: {
      verdict: 'n/a',
      why: 'The per-FILE email address that fans an inbound message out to the whole team. '
        + 'That is the short-term file inbox, which Long-Term does not have; Long-Term’s '
        + 'orders have their own reply address and it works the same way.',
    },
    ltOrderReplyTo: {
      verdict: 'shared', via: 'src/lib/file-address.js',
      why: 'Long-Term’s own per-order reply address, built by the same shared module.',
    },
  },

  'src/lib/send-as.js': {
    senderFor: {
      verdict: 'shared', via: 'src/lib/send-as.js',
      why: 'Who an order comes from. Long-Term calls it directly; the short-term desk reaches '
        + 'the same rule through its own send path.',
    },
    sendingDomains: {
      verdict: 'shared', via: 'src/lib/send-as.js',
      why: 'Which addresses may appear in a From line — same.',
    },
  },

  'src/lib/inbound-mail.js': {
    extractAddress: { verdict: 'shared', via: 'src/lib/inbound-mail.js', why: 'Reading an address out of a mail header. Long-Term calls it directly; the short-term file inbox reaches the same reader through its own inbound handler.' },
    recipientsFromEvent: { verdict: 'shared', via: 'src/lib/inbound-mail.js', why: 'Working out every address a message was sent to — same.' },
    retrieveInboundEmail: { verdict: 'shared', via: 'src/lib/inbound-mail.js', why: 'Fetching the message itself from the mail provider — the same reader, reached the other way round.' },
    retrieveAttachmentsSafe: { verdict: 'shared', via: 'src/lib/inbound-mail.js', why: 'Fetching its attachments, bounded — same.' },
    senderAuth: { verdict: 'shared', via: 'src/lib/inbound-mail.js', why: 'Whether an inbound message really came from who it says — the SPF/DKIM/DMARC verdict. Long-Term calls it directly; the short-term file inbox reaches the same reader through its own inbound handler.' },
    isAutoGenerated: { verdict: 'shared', via: 'src/lib/inbound-mail.js', why: 'Spotting an out-of-office or a bounce — same.' },
  },

  'src/lib/order-return-filter.js': {},

  /* ── THE SHAREPOINT MIRROR ──────────────────────────────────────────────
     Every row here is the same shape, and it is the shape of the whole surface:
     ONE mirror runs for the company and walks the documents table, so a
     long-term document is picked up exactly the way a short-term one is and
     nobody hands it either. 'shared' would be the wrong word (neither product
     calls these) and 'gap' would be a false alarm. */
  'src/lib/sharepoint-backup.js': {
    start: mirrorWorker(
      'Starting the copier when the site boots. It starts once, for everything.'),
    enabled: mirrorWorker(
      'Whether copying to SharePoint is switched on at all. It is one switch for the company, '
      + 'not one per product.'),
    kick: mirrorWorker(
      'A nudge to copy sooner rather than waiting for the next round. Without a nudge the '
      + 'document is still copied on the next pass, so this changes how SOON, never whether.'),
    drain: mirrorWorker(
      'The copier\'s work loop. It walks the documents table, so it picks up a long-term '
      + 'document exactly as it picks up a short-term one.'),
    health: mirrorWorker(
      'Whether the copier is keeping up. It counts every document still waiting across both '
      + 'products at once, so one number answers for the whole company.'),
    drainVerify: mirrorWorker(
      'The work loop of the check that re-reads copies already in SharePoint and makes sure '
      + 'they are intact. Same loop, same table, both products.'),
    reconciliation: mirrorWorker(
      'The scoreboard — how many documents are in SharePoint, how many are waiting, and what '
      + 'was deliberately not copied. It counts the whole table, so long-term documents are '
      + 'in the totals and get their own line when they are held back.'),
    stuckDocuments: mirrorWorker(
      'The list of documents that have been waiting too long to be copied. It is read off the '
      + 'same table, so a long-term document that gets stuck appears on it.'),
    escalateStuckDocs: mirrorWorker(
      'Forcing a fresh attempt at those stuck documents. Same list, so the same rescue reaches '
      + 'a long-term document.'),
    backfillAppraisalPhotoMirrorOnce: {
      verdict: 'n/a',
      why: 'A one-off tidy-up of appraisal photographs on short-term files. A long-term file has '
        + 'no appraisal photo gallery, so there is nothing for it to tidy.',
    },
  },
};

/** The modules this engine compares, in the order the report prints them. */
const SURFACES = [
  { name: 'Condition Center — documents', modules: [
    'src/lib/condition-docs/upload.js',
    'src/lib/condition-docs/review.js',
    'src/lib/condition-docs/remove.js',
    'src/lib/condition-docs/serve.js',
    'src/lib/upload-stream.js',
    'src/lib/condition-owner.js',
  ] },
  { name: 'The entity section', modules: [
    'src/lib/llc.js',
    'src/lib/llc-edit.js',
  ] },
  { name: 'File contacts', modules: [
    'src/lib/vendor-directory.js',
  ] },
  { name: 'Orders', modules: [
    'src/lib/order-email.js',
    'src/lib/order-cc.js',
    'src/lib/file-address.js',
    'src/lib/send-as.js',
    'src/lib/inbound-mail.js',
    'src/lib/order-return-filter.js',
  ] },
  /* THE MIRROR'S HELPERS ARE DELIBERATELY NOT LISTED. `sharepoint.js` (the
     Microsoft client), `sharepoint-map.js` (the folder matcher) and
     `sharepoint-shelf.js` (which shelf a copy sits on) are pulled in by the
     MIRROR, never by a product, so this engine measures exactly zero rows on
     them — listing them would read as coverage while proving nothing. They are
     proven where they can be, on real rows, in
     `scripts/test-lt-sharepoint-cloudflare-db.js`. */
  { name: 'The SharePoint mirror', modules: [
    'src/lib/sharepoint-backup.js',
  ] },
];

const VERDICTS = ['shared', 'n/a', 'gap', 'worker'];

function entryFor(moduleRel, name) {
  return (LEDGER[moduleRel] || {})[name] || null;
}

module.exports = { LEDGER, SURFACES, VERDICTS, entryFor };
