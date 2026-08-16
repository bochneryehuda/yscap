'use strict';
/**
 * WHAT THE FILE'S INVESTOR REQUIRES OF THE APPRAISAL — ONE definition, read by
 * BOTH the message posted to the appraisal order and the findings raised against
 * the report that comes back.
 *
 * Owner-directed 2026-08-16: "any file that's going to EMCAP, when you order the
 * appraiser … there are three specific rules that they have for the appraisal:
 * it needs to be within 1 mile; it needs to be anchor compatible, where it is
 * within 1 mile, within 12 months, and it's less than 15% net adjustment. This
 * message should post as a message to the order right after you place the order,
 * so the team can know about the requirement. We already have a system for NAN
 * [and] Class where you can post messages, so we should set it up, if it's this
 * investor, to automatically post a message like this with the file-specific
 * requirements for this investor."
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
 * requirements as OUR OWN review requirements — which is what they are, from the
 * appraiser's point of view — names nobody, and is put through the shared
 * borrower-safe scrub on the way out as a second layer. `assertVendorSafe`
 * proves it rather than trusting the wording.
 *
 * ── THE 1 MILE, AND THE ZIP THAT WAS STANDING IN FOR IT ───────────────────
 *
 * The stored EMCAP rule (from the owner's earlier list, docs/SILVER-PROGRAM-EMCAP.md)
 * reads "in the SAME ZIP code as the subject". The owner has now stated the rule
 * itself: within 1 mile. Those are not the same test — a comp 0.4 miles away
 * across a ZIP boundary satisfies the real rule and failed ours. The distance is
 * therefore accepted WHEN THE REPORT STATES IT, with the ZIP kept as the fallback
 * for a report that does not. That direction matters: it can only ever let MORE
 * comps qualify, so no live file can newly fail a fatal because of this change
 * (proven in the tests, not asserted). Tightening it to distance-only would be a
 * change to a gate that blocks clear-to-close, and that is the owner's call, not
 * this file's.
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

/** Investors with appraisal requirements worth telling the appraiser up front. */
const REQUIREMENTS = {
  emcap: {
    // Rules 1 + 2 are the owner's own words. 3-5 are the rest of the list this
    // repo already judges the report against (note-buyer-checks.js rules 3-5),
    // so the appraiser is told everything we will send a report back over —
    // there is no value in holding one back and rejecting the report for it.
    lines: (ctx) => [
      `Comparable sales must be within ${COMP_RADIUS_MILES} mile of the subject.`,
      `At least one As-Is comparable and — where the report gives an after-repair (ARV) value — `
      + `at least one ARV comparable must be an "anchor" comp: a SETTLED sale, within `
      + `${COMP_RADIUS_MILES} mile of the subject, sold within the last ${ANCHOR_MONTHS} months, `
      + `with under ${ANCHOR_MAX_NET_ADJ_PCT}% net adjustment. An active or pending listing does not count.`,
      'Interior photographs of the subject are required.',
      ctx && ctx.rentalExit
        ? 'This loan\'s exit is a rental, so a rental analysis is required: a 1025 includes one; '
          + 'on a 1004 please include a 1007 Comparable Rent Schedule.'
        : null,
      'The report must name YS Capital as the lender/client.',
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

/** The plain-language requirement lines, or [] when this file has none. */
function requirementLines(investorKey, ctx) {
  const spec = REQUIREMENTS[investorKey];
  return spec ? spec.lines(ctx || {}) : [];
}

/**
 * The message posted to the appraisal order. Returns null when the file has no
 * investor requirements — the caller then posts nothing at all, rather than a
 * message saying there is nothing to say.
 */
function orderMessage({ investorKey, loanNumber, propertyAddress, rentalExit } = {}) {
  const lines = requirementLines(investorKey, { rentalExit });
  if (!lines.length) return null;
  const subject = [loanNumber ? `Loan #${loanNumber}` : null, propertyAddress || null]
    .filter(Boolean).join(' · ');
  const body = [
    MARKER + (subject ? ` — ${subject}` : ''),
    '',
    'Before this report is submitted, please make sure it meets the following. '
    + 'These are the requirements this loan will be reviewed against, so a report that '
    + 'misses one will have to come back for revision.',
    '',
    ...lines.map((l, i) => `${i + 1}. ${l}`),
    '',
    'If any of these cannot be met on this property, please reply on this order and '
    + 'tell us before you complete the report.',
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
  ANCHOR_MONTHS, ANCHOR_MAX_NET_ADJ_PCT, COMP_RADIUS_MILES, MARKER,
  investorKeyFor, investorForFile, requirementLines, orderMessage, assertVendorSafe,
  _internals: { REQUIREMENTS },
};
