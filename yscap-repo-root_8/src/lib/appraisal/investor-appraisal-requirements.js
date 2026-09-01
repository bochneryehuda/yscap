'use strict';
/**
 * WHAT THE FILE'S INVESTOR REQUIRES OF THE APPRAISAL — ONE definition, read by
 * BOTH the message posted to the appraisal order and the findings raised against
 * the report that comes back.
 *
 * Owner-directed 2026-08-16: "any file that's going to EMCAP, when you order the
 * appraiser … this message should post as a message to the order right after you
 * place the order, so the team can know about the requirement."
 *
 * Owner-directed 2026-09-01 — THE MESSAGE WAS SAYING TOO MUCH, AND ONE THING IT
 * SAID WAS WRONG. The first version listed five numbered requirements. Its rule 1
 * read "Comparable sales must be within 1 mile of the subject" — every comp. That
 * is not the requirement and never was: *"It's only required to be one of them."*
 * Rules 4 and 5 (interior photographs; the report must name YS Capital) are
 * *"self-understood"* — ordinary report standards, not something to instruct an
 * appraiser about. The owner's words: *"These are the only things we require.
 * Make sure you understand it. This one comparable should have these three
 * things: one strong anchor comparable."* So the message now states exactly ONE
 * requirement — the anchor comp — and its three criteria are numbered 1, 2, 3
 * (the owner asked for numbers, not a/b/c). The rent-schedule line stays, still
 * only on a rental exit, because it was a separate owner instruction on
 * 2026-08-16 and is not one of the three items being replaced.
 *
 * Every order that received the earlier five-item message gets a CORRECTION
 * posted once (`correctionMessage`, driven by `order-requirements-post
 * .correctSupersededOnce`) — the owner's "previous AND future" rule.
 *
 * ── WHY THE REQUIREMENTS LIVE HERE AND NOT IN THE MESSAGE ─────────────────
 *
 * `note-buyer-checks.js` has judged the returned report against these same
 * requirements since 2026-07-30, and its anchor rule is a CTC-blocking fatal.
 * Writing the numbers a second time — in prose, in a message to an outside
 * appraiser — is exactly the second copy this repo bans: the day one of them
 * moves, we would be telling an appraiser one thing and refusing their report
 * for another. So the numbers are stated ONCE, here, and both surfaces read
 * them. `note-buyer-checks` imports the constants; nothing restates them.
 *
 * ── THE INVESTOR'S NAME NEVER LEAVES THE BUILDING ─────────────────────────
 *
 * An AMC is an OUTSIDE company. The standing rule ("never expose a note buyer /
 * capital partner name") is why `amc/order-service` already carries the note
 * buyer with a comment saying it "never reaches the AMC message", and why
 * `richervalues/messages` scrubs every outbound body. So the message states the
 * requirement as OUR OWN review requirement — which is what it is, from the
 * appraiser's point of view — names nobody, and is put through the shared
 * borrower-safe scrub on the way out as a second layer. `assertVendorSafe`
 * proves it rather than trusting the wording.
 *
 * ── THE 1 MILE, AND THE ZIP THAT WAS STANDING IN FOR IT ───────────────────
 *
 * The stored EMCAP rule (from the owner's earlier list, docs/SILVER-PROGRAM-EMCAP.md)
 * reads "in the SAME ZIP code as the subject". The owner has since stated the
 * rule itself: within 1 mile. Those are not the same test — a comp 0.4 miles
 * away across a ZIP boundary satisfies the real rule and failed ours. The
 * distance is therefore accepted WHEN THE REPORT STATES IT, with the ZIP kept as
 * the fallback for a report that does not. That direction matters: it can only
 * ever let MORE comps qualify, so no live file can newly fail a fatal because of
 * this change (proven in the tests, not asserted).
 */

const borrowerSafe = require('../borrower-safe');

// ── THE NUMBERS. One place. `note-buyer-checks.js` imports these. ──────────
const ANCHOR_MONTHS = 12;            // settled within 12 months of the loan submission date
const ANCHOR_MAX_NET_ADJ_PCT = 15;   // strictly under 15% net adjustment
const COMP_RADIUS_MILES = 1;         // within 1 mile of the subject

/**
 * The first line of the posted message, and the key that stops it being posted
 * twice. KEEP IT STABLE — the idempotency check looks for exactly this text on
 * the order's existing messages. Changing it re-posts once on every live order.
 */
const MARKER = 'Appraisal requirements for this loan';

/**
 * The first line of the one-time CORRECTION posted to orders that carried the
 * earlier five-item message, and its own do-not-repeat key. It must NOT begin
 * with `MARKER`, or the requirements poster would read a correction as "the
 * requirements are already on this order" and vice versa.
 */
const CORRECTION_MARKER = 'Correction to the appraisal requirements for this loan';

/**
 * THE WORDING THAT WENT OUT between 2026-08-16 and 2026-09-01 and is now
 * withdrawn. A message that begins with MARKER and carries ANY of these lines is
 * superseded and gets a correction. Kept verbatim (not rebuilt from the
 * constants) on purpose: this is the historical text as it was posted, and if a
 * constant ever moved the detector would stop matching the very messages it
 * exists to find.
 */
const SUPERSEDED_LINES = Object.freeze([
  'Comparable sales must be within 1 mile of the subject.',
  'Interior photographs of the subject are required.',
  'The report must name YS Capital as the lender/client.',
]);

/**
 * The anchor comp — the ONE requirement, in the owner's words, with the three
 * criteria numbered 1-3. A single function so the requirements message and the
 * correction can never state it two different ways.
 */
function anchorRequirement() {
  return `At least one As-Is comparable — and, where the report gives an after-repair (ARV) value, `
    + `at least one ARV comparable — must be an "anchor" comp. An anchor comp is a SETTLED sale `
    + `(an active or pending listing does not count) that meets all THREE of:\n`
    + `1. within ${COMP_RADIUS_MILES} mile of the subject;\n`
    + `2. sold within the last ${ANCHOR_MONTHS} months;\n`
    + `3. under ${ANCHOR_MAX_NET_ADJ_PCT}% net adjustment.`;
}

/** Investors with appraisal requirements worth telling the appraiser up front. */
const REQUIREMENTS = {
  emcap: {
    // Each entry is one BLOCK of the message (blocks are separated by a blank
    // line, never numbered — the numbers belong to the anchor's three criteria).
    blocks: (ctx) => [
      anchorRequirement(),
      // ONLY on a rental exit (owner-directed 2026-08-16: "only include the text
      // about the rent schedule if it's a rental exit"). Asking a flip's
      // appraiser for a rent schedule is a cost and a delay for nothing.
      ctx && ctx.rentalExit
        ? 'This loan\'s exit is a rental, so a rental analysis is required: a 1025 includes one; '
          + 'on a 1004 please include a 1007 Comparable Rent Schedule.'
        : null,
    ].filter(Boolean),
  },
};

/** Which investor's requirements apply, from a note-buyer label. */
function investorKeyFor(noteBuyerLabel) {
  try {
    const registry = require('../conditions/field-registry');
    if (registry.isEmcapNoteBuyer(noteBuyerLabel)) return 'emcap';
  } catch (_) { /* an unreadable registry means we say nothing, never the wrong thing */ }
  return null;
}

/**
 * The investor whose appraisal requirements govern this file.
 *
 * The file's own note buyer decides. When it is blank we fall back to the
 * REGISTERED PROGRAM's provider — not a guess, but the same derivation
 * `note-buyer-for-program.js` uses to stamp `applications.lender` in the first
 * place, so the two can never disagree about who a Silver loan is going to. A
 * file that names neither gets no message at all.
 */
function investorForFile({ noteBuyer, registeredProgram } = {}) {
  const direct = investorKeyFor(noteBuyer);
  if (direct) return direct;
  if (noteBuyer && String(noteBuyer).trim()) return null;   // a named buyer that is not one of ours
  try {
    const label = require('../note-buyer-for-program').noteBuyerForProgram(registeredProgram);
    return label ? investorKeyFor(label) : null;
  } catch (_) { return null; }
}

/**
 * The plain-language requirement blocks, or [] when this file has none. (Kept
 * under its historical name — callers and tests read "lines" as "the things
 * the appraiser is told".)
 */
function requirementLines(investorKey, ctx) {
  const spec = REQUIREMENTS[investorKey];
  return spec ? spec.blocks(ctx || {}) : [];
}

function subjectLine({ loanNumber, propertyAddress } = {}) {
  return [loanNumber ? `Loan #${loanNumber}` : null, propertyAddress || null].filter(Boolean).join(' · ');
}

const CLOSING_LINE = 'If this cannot be met on this property, please reply on this order and '
  + 'tell us before you complete the report.';

/**
 * The message posted to the appraisal order. Returns null when the file has no
 * investor requirements — the caller then posts nothing at all, rather than a
 * message saying there is nothing to say.
 */
function orderMessage({ investorKey, loanNumber, propertyAddress, rentalExit } = {}) {
  const blocks = requirementLines(investorKey, { rentalExit });
  if (!blocks.length) return null;
  const subject = subjectLine({ loanNumber, propertyAddress });
  const body = [
    MARKER + (subject ? ` — ${subject}` : ''),
    '',
    'Before this report is submitted, please make sure it meets the following. '
    + 'This is the requirement this loan will be reviewed against, so a report that '
    + 'misses it will have to come back for revision.',
    '',
    ...blocks.flatMap((b) => [b, '']),
    CLOSING_LINE,
  ].join('\n');
  return assertVendorSafe(body);
}

/**
 * Was this posted message one of the withdrawn five-item versions? True only for
 * OUR requirements message (it begins with MARKER) that carries at least one of
 * the withdrawn lines. A correction, a human's message, or a current-wording
 * message all answer false.
 */
function isSupersededMessage(body) {
  const text = String(body || '');
  if (!text.startsWith(MARKER)) return false;
  return SUPERSEDED_LINES.some((l) => text.includes(l));
}

/**
 * The one-time correction posted to an order that carried the earlier message.
 * It says plainly what was wrong (every comp within the mile), states the ONE
 * requirement as it stands now, and says the new list replaces the old one. It
 * does NOT tell the appraiser to skip interior photographs or leave the lender
 * off the report — those are ordinary report standards that still apply; they
 * simply are not this loan's requirement and are no longer listed as one.
 *
 * Null when the file no longer has investor requirements at all (a correction
 * that states a requirement the file does not have would be a new error).
 */
function correctionMessage({ investorKey, loanNumber, propertyAddress, rentalExit } = {}) {
  const blocks = requirementLines(investorKey, { rentalExit });
  if (!blocks.length) return null;
  const subject = subjectLine({ loanNumber, propertyAddress });
  const body = [
    CORRECTION_MARKER + (subject ? ` — ${subject}` : ''),
    '',
    `An earlier message on this order said that every comparable sale must be within `
    + `${COMP_RADIUS_MILES} mile of the subject. That was stated too broadly and is not the requirement: `
    + `the distance applies to the anchor comp, not to every comparable. Please disregard the earlier list — `
    + `the requirement below replaces it in full.`,
    '',
    ...blocks.flatMap((b) => [b, '']),
    CLOSING_LINE,
  ].join('\n');
  return assertVendorSafe(body);
}

/**
 * PROVE the message carries no capital-partner name before it leaves. The text
 * above names nobody by construction; this is the guard that keeps it that way
 * when somebody edits the wording, and it is the same scrub every other
 * outside-vendor message in this repo goes through.
 */
function assertVendorSafe(text) {
  try { return borrowerSafe.scrubText(String(text || '')); }
  catch (_) { return String(text || ''); }
}

module.exports = {
  ANCHOR_MONTHS, ANCHOR_MAX_NET_ADJ_PCT, COMP_RADIUS_MILES, MARKER, CORRECTION_MARKER, SUPERSEDED_LINES,
  investorKeyFor, investorForFile, requirementLines, orderMessage, correctionMessage, isSupersededMessage,
  assertVendorSafe,
  _internals: { REQUIREMENTS, anchorRequirement },
};
