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

/** module path → { capability name → Entry } */
const LEDGER = {
  'src/lib/condition-docs/upload.js': {},

  'src/lib/condition-docs/review.js': {},

  'src/lib/condition-docs/remove.js': {
    supersede: {
      verdict: 'shared',
      via: 'src/lib/condition-docs/remove.js',
      why: 'Retiring the copy a deleted document replaced happens inside the shared delete '
        + 'itself, so both products get it from the one call they already make.',
    },
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
    completeness: {
      verdict: 'shared', via: 'src/lib/llc.js',
      why: 'How complete a company is comes back inside the bundle both products read.',
    },
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
    isNyState: {
      verdict: 'n/a',
      why: 'Used by the short-term closing desk, which Long-Term does not have.',
    },
    helperEmails: {
      verdict: 'n/a',
      why: 'Who the borrower’s helper is. Same reason: a long-term file carries no helper.',
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
    cleanName: {
      verdict: 'shared', via: 'src/lib/send-as.js',
      why: 'Tidying the name that appears in a From line happens inside the shared sender '
        + 'resolver Long-Term already calls.',
    },
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
];

const VERDICTS = ['shared', 'n/a', 'gap'];

function entryFor(moduleRel, name) {
  return (LEDGER[moduleRel] || {})[name] || null;
}

module.exports = { LEDGER, SURFACES, VERDICTS, entryFor };
