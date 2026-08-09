'use strict';
/**
 * THE FUNDING CHANNEL — how a loan funded, which note buyers are allowed to fund that way, and
 * therefore whether the loan was sold at the closing table (owner-directed 2026-08-09).
 *
 * The owner's rule, in their own words:
 *
 *   "Most of the properties that have Fidelis as a note buyer should be defaulted to table
 *    funding, which we have on the closing side. Table funding means that it's being sold at the
 *    table, but there are a few Fidelis deals that are not being table funded … Look on the
 *    channel in Encompass cx.tablefunder — if that says table funding, then it is not going to
 *    have a PA date … for Fidelis, you can allow that to be table funding, and for RCN or ROC or
 *    TempleView, you can also allow them to be table funding. Any file that is Blue Lake or emcap
 *    or corrfirst it should never be table funding. It should always be direct RTL / delegate or
 *    direct RTL / w tpr — it needs to follow this rule in order to pass Encompass Sync … for the
 *    other note buyers, other than RCN, ROC and TempleView, you don't need to care about this
 *    field."
 *
 * THE NAMES ARE NOT TAKEN FROM THE OWNER'S MESSAGE, AND THAT WAS AN EXPLICIT INSTRUCTION ("when I
 * say name, look for the correct research for the correct spelling of the nodes you're looking
 * for"). They are the tokens the Encompass CAPITAL PROVIDER dropdown already normalizes to —
 * `VALUE_MAPS.capitalProvider` in ./integrations/encompass-field-map.js, whose key list was read
 * LIVE off the tenant on 2026-07-26: Fidelis Investors / RCN / Roc Capital / Temple View Capital /
 * CorrFirst / BlueLake / EMCAP / Other. So "Core First" is CorrFirst, "ROC" is Roc Capital, and
 * "TempleView" is Temple View Capital. Keying on that table rather than on a private list here is
 * the whole point: a buyer's spelling has exactly ONE home in this codebase, the Encompass panel's
 * capital-provider row and this rule can never disagree about who a file belongs to, and adding a
 * real new spelling is one line THERE rather than two lists to keep in step.
 *
 * PURE — no DB, no network, never throws. The one require is the value-map module, which is itself
 * a pure data map with no requires of its own.
 */

const map = require('./integrations/encompass-field-map');

// ── The channel tokens ──────────────────────────────────────────────────────
// TWO tokens, not four. Delegated and TPR both normalize to `direct` — see the long note on
// VALUE_MAPS.fundingChannel: our side of the comparison is a warehouse pick that cannot express
// the difference, so giving them separate tokens would make every correct direct file read as a
// mismatch. The question here is binary: sold at the table, or still to be sold.
const CHANNEL = Object.freeze({
  TABLE_FUNDING: 'table_funding',
  DIRECT: 'direct',
});

const CHANNEL_LABEL = Object.freeze({
  table_funding: 'Table funding (sold at the closing table)',
  direct: 'Direct RTL (sold later)',
});

const DIRECT_CHANNELS = Object.freeze([CHANNEL.DIRECT]);

/** The two values a direct-only buyer's file is allowed to carry, named the owner's way. */
const DIRECT_ONLY_WORDING = 'direct RTL / delegate or direct RTL / with TPR';

// ── Who may fund which way ──────────────────────────────────────────────────
// MAY be table funded. Fidelis is additionally the one that DEFAULTS to it (defaultChannelFor).
const CAN_TABLE_FUND = Object.freeze(['fidelis', 'rcn', 'roccapital', 'templeview']);
// May NEVER be table funded — always one of the two direct RTL channels.
const DIRECT_ONLY = Object.freeze(['bluelake', 'emcap', 'corrfirst']);

/**
 * Buyers whose business is table funded AS A MATTER OF COURSE, so a file of theirs with no
 * purchase advice is not a loan waiting to be sold — it is a gap in someone's data entry, and
 * chasing it would be noise (owner-directed 2026-08-09, answering the open question left by the
 * first cut: "blue lake emcap corrfirst — only stuff that needs to be sold to get this reminder.
 * Fidelis is on a case-by-case basis, most of Fidelis is table funding. All the other RCN, [Roc],
 * and Temple View are also table funded, so we don't need a reminder. Only these few are real
 * sold, so we should get a reminder after 30 days.").
 *
 * NOTE ON THE SPELLING: the owner said "Rack", which is Roc Capital — the same speech-to-text
 * slip as "Core First" for CorrFirst. Read through the shared capital-provider table like every
 * other name here, never off the message.
 *
 * FIDELIS IS DELIBERATELY NOT ON THIS LIST, and that is the owner's "case-by-case": most Fidelis
 * deals are table funded and are ALREADY skipped by the table-funded check, which is a fact about
 * THE FILE rather than about the buyer. The few that are not table funded genuinely have to be
 * sold, so they should still be chased.
 */
const NO_ADVICE_CHASE = Object.freeze(['rcn', 'roccapital', 'templeview']);

/**
 * Normalize a note buyer — ours (`applications.lender`, free text) or Encompass's
 * (CX.CAPITALPROVIDER) — to the shared capital-provider token, or null when it is blank or a
 * spelling the shared table does not carry. Null means "we do not know which buyer this is", and
 * every rule below then declines to judge rather than guessing.
 */
function buyerKey(raw) {
  try { return map.mapValue('capitalProvider', raw) || null; } catch (_) { return null; }
}

/**
 * `buyerKey`, but it also accepts a value that is ALREADY one of our tokens.
 *
 * Two of the tokens are not keys of the shared table — `roccapital` and `templeview` are what
 * "Roc Capital" and "Temple View Capital" map TO, not spellings anyone types — so a caller passing
 * a token it read off an earlier call would otherwise resolve to null and silently lose its rule.
 * The accepted set is exactly the tokens named in this file, so an arbitrary string still cannot
 * become a buyer.
 */
const KNOWN_BUYERS = Object.freeze(CAN_TABLE_FUND.concat(DIRECT_ONLY, ['other']));
function toBuyerKey(v) {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s) return null;
  const mapped = buyerKey(s);
  if (mapped) return mapped;
  const t = s.toLowerCase();
  return KNOWN_BUYERS.indexOf(t) !== -1 ? t : null;
}

/**
 * Normalize an Encompass CX.TABLEFUNDER value to a channel token, or null when it is blank or a
 * spelling the shared table does not carry. Reads through the SAME value map the registry's
 * `funding_channel` row compares with, so the panel and this rule can never read one value two
 * ways.
 */
function channelKey(raw) {
  try { return map.mapValue('fundingChannel', raw) || null; } catch (_) { return null; }
}

/** Is this channel token a positive "sold at the closing table"? */
function isTableFunding(channel) { return channel === CHANNEL.TABLE_FUNDING; }

/** Is this channel token a positive "not table funded"? (Any of the direct readings.) */
function isDirect(channel) { return DIRECT_CHANNELS.indexOf(channel) !== -1; }

/** May a file belonging to this buyer be table funded at all? Unknown buyer → null (no opinion). */
function mayTableFund(buyer) {
  if (!buyer) return null;
  if (CAN_TABLE_FUND.indexOf(buyer) !== -1) return true;
  if (DIRECT_ONLY.indexOf(buyer) !== -1) return false;
  return null;                                   // "you don't need to care about this field"
}

/**
 * The channel a NEW file on this buyer should default to — the owner's "the default for Fidelis
 * should be table funded". A DEFAULT, never a decision: only Fidelis has one, and even there the
 * owner said plainly that some Fidelis deals are not table funded, so nothing in this codebase may
 * WRITE this value on its own. It exists so a screen can pre-select the usual answer for the
 * human who is about to choose.
 */
function defaultChannelFor(buyer) {
  return buyer === 'fidelis' ? CHANNEL.TABLE_FUNDING : null;
}

// ── The rule ────────────────────────────────────────────────────────────────

/**
 * Does this file's Encompass channel break the buyer's rule?
 *
 * Returns null when there is nothing to say, or { code, message, buyer, channel } when there is.
 *
 * IT ONLY EVER FIRES ON A POSITIVE READING, and that is the whole safety argument. Every one of
 * these declines to judge:
 *   · no buyer, or a buyer spelling the shared table does not carry — we do not know whose rule
 *     to apply;
 *   · a buyer with no rule ("you don't need to care about this field");
 *   · a blank channel — Encompass has not been filled in, which is a different problem;
 *   · a channel value the shared table does not recognize — a dropdown option nobody has
 *     enumerated yet must not be reported as a violation. It comes back as `unrecognized`, which
 *     the caller renders as information rather than a failure.
 * So the only thing that can be reported as a REAL violation is Encompass positively saying this
 * loan was table funded on a buyer the owner says may never be table funded.
 */
function channelProblem({ buyer = null, channelRaw = null, channel = undefined } = {}) {
  const b = toBuyerKey(buyer);
  const allowed = mayTableFund(b);
  if (allowed !== false) return null;             // no buyer, or a buyer with no rule

  const ch = channel === undefined ? channelKey(channelRaw) : channel;
  const raw = channelRaw == null ? '' : String(channelRaw).trim();

  if (!ch) {
    if (!raw) return null;                        // blank — nothing to judge
    return {
      code: 'funding_channel_unrecognized',
      buyer: b, channel: null, channelRaw: raw, violation: false,
      message: `Encompass has this ${label(b)} file's funding channel as “${raw}”, which PILOT does not recognise. It should be ${DIRECT_ONLY_WORDING}.`,
    };
  }
  if (isTableFunding(ch)) {
    return {
      code: 'funding_channel_not_allowed',
      buyer: b, channel: ch, channelRaw: raw, violation: true,
      message: `${label(b)} loans are never table funded — Encompass has this file's funding channel as table funding. It has to be ${DIRECT_ONLY_WORDING}. Fix it in Encompass, or ask a super admin for an exception.`,
    };
  }
  return null;                                    // one of the direct channels — correct
}

/** A buyer token as a person would write it. Falls back to the token so it is never blank. */
const BUYER_LABEL = Object.freeze({
  fidelis: 'Fidelis', bluelake: 'Blue Lake', corrfirst: 'CorrFirst', emcap: 'EMCAP',
  rcn: 'RCN', roccapital: 'Roc Capital', templeview: 'Temple View', other: 'This buyer',
});
function label(buyer) { return BUYER_LABEL[buyer] || 'This buyer'; }

// ── Sold at the table, and therefore whether a purchase advice is coming ─────

/**
 * Was this loan sold at the closing table? Two independent signals, and EITHER is enough:
 *
 *   tableFunded   PILOT's OWN answer — the closer funded on the "Table Funding" warehouse line
 *                 (closing.tableFundedFor). This is the reliable one: a human on our closing desk
 *                 chose it, and it does not depend on Encompass having been pulled.
 *   channel       Encompass's answer (CX.TABLEFUNDER).
 *
 * Either alone is taken as a yes, deliberately. The owner's rule is that table funding means the
 * loan is already sold, and both fields are humans recording the same fact; requiring them to
 * agree would make a data-entry gap on either side read as "not sold", which is the answer that
 * generates chase emails and warnings. The two DISAGREEING is a real thing to look at, and it is
 * already surfaced — as the `funding_channel` row on the Encompass panel.
 */
function soldAtTable({ tableFunded = null, channel = null } = {}) {
  return tableFunded === true || isTableFunding(channel);
}

/**
 * Should this file ever receive a purchase advice date?
 *
 * A table-funded loan was sold at the table, so no purchase advice is coming and its absence is
 * not a problem — the owner: "if that says table funding, then it is not going to have a PA date".
 * Everything else is sold later and should get one, INCLUDING a file whose channel we cannot read:
 * "anything other than that is not sold yet", and the honest reading of an unknown channel is that
 * the loan still has to be sold. That is also the safe direction for the chase this feeds — it
 * asks a human to look at a file that may have been sold with nothing recorded, which is a far
 * cheaper mistake than staying quiet about one that never sold at all.
 */
function expectsPurchaseAdvice({ tableFunded = null, channel = null } = {}) {
  return !soldAtTable({ tableFunded, channel });
}

/**
 * Should a file for this note buyer ever be CHASED for a missing purchase advice?
 *
 * This is a question about the BUYER, and it sits alongside — never instead of — the question
 * about the FILE (`expectsPurchaseAdvice`, which is what skips anything table funded). Both have
 * to say yes before anyone is told.
 *
 * false for the three buyers whose business is table funded as a matter of course. true for
 * everything else, INCLUDING a buyer this table does not recognise — and that default is
 * deliberate. The owner named the buyers who need no reminder; a buyer nobody has classified yet
 * is not one of them, and a funded loan sitting a month with no purchase advice and no
 * recognisable buyer is exactly the thing a super admin should be told about. Silence there would
 * be a gap that appears the day a new note buyer is added and that nobody would ever notice.
 */
function chaseMissingPurchaseAdvice(buyer) {
  const b = toBuyerKey(buyer);
  return !(b && NO_ADVICE_CHASE.indexOf(b) !== -1);
}

module.exports = {
  CHANNEL, CHANNEL_LABEL, DIRECT_CHANNELS, DIRECT_ONLY_WORDING,
  CAN_TABLE_FUND, DIRECT_ONLY, NO_ADVICE_CHASE, BUYER_LABEL,
  buyerKey, toBuyerKey, channelKey, isTableFunding, isDirect, mayTableFund, defaultChannelFor,
  channelProblem, label,
  soldAtTable, expectsPurchaseAdvice, chaseMissingPurchaseAdvice,
};
