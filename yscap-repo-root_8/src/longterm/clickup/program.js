'use strict';
/**
 * IS THIS CLICKUP TASK A LONG-TERM FILE? — and the rule is stated the safe way round.
 *
 * THE OWNER'S RULE, 2026-08-23, verbatim: *"helo and heloan is on the long-term side,
 * yes. Anything that is not short term is long term. Anything that is not part of RTL
 * is long term. Any file that doesn't have a program set in ClickUp, you need to let
 * me know, and we need to fix it."*
 *
 * SO THE LIST WE KEEP IS THE SHORT-TERM ONE, and that inversion is the whole design.
 * An allowlist of long-term programs would have to be updated the day somebody adds
 * a product to the ClickUp dropdown, and until it was, real long-term files would
 * fall silently out of the reconciliation — invisible, because a file that is never
 * considered is not a file that is reported. Listing the FIVE RTL products instead
 * means a new program is long-term from the moment it exists, which is both the
 * owner's rule and the direction that fails loudly: at worst an RTL file turns up in
 * a long-term list where somebody can see it and say so.
 *
 * A BLANK PROGRAM IS NEITHER, AND IT IS NEVER GUESSED. The owner asked to be told.
 * It answers `unset`, which the reconciliation reports as its own bucket — the file
 * is not classified, not quietly counted as long-term, and not dropped.
 *
 * READ LIVE FROM THE TENANT ON 2026-08-23. The `*Program` dropdown carries 22
 * options; the five below are RTL's. Everything else — Non-QM in all its forms,
 * Conventional, Jumbo, FHA, HELOC, HELOAN — is long-term.
 *
 * PURE: no requires, no database, no network. Settings are passed in.
 */

/**
 * The RTL products, as the tenant's ClickUp spells them. Compared normalised, so
 * casing and spacing drift ("bridge Without Construction" really is lower-case in
 * the dropdown) cannot turn an RTL file into a long-term one.
 */
const SHORT_TERM_PROGRAMS = [
  'Fix & Flip With Construction',
  'Fix & Hold With Construction',
  'Ground-Up',
  'bridge Without Construction',
  'Private hard money',
];

/** The verdicts. `unset` is a real answer and the owner asked to see it. */
const PRODUCT = Object.freeze({ LONG: 'long_term', SHORT: 'short_term', UNSET: 'unset' });

/**
 * Fold a program label to something two spellings of one product agree on.
 *
 * `&` and `and` are folded together because a dropdown edited by a person will
 * eventually carry both, and punctuation goes for the same reason the borrower-name
 * comparison strips it: a comma or a hyphen is not a different product.
 */
function normProgram(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/gi, ' ')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

const SHORT_KEYS = new Set(SHORT_TERM_PROGRAMS.map(normProgram));

/**
 * Classify one task's program.
 *
 * `settings['clickup.shortTermPrograms']` replaces the list wholesale when a tenant
 * sets it — the owner asked that this not need a deploy to change. An empty or
 * unusable setting falls back to the built-in list rather than to "nothing is short
 * term", which would sweep every RTL file into the long-term book.
 */
function classifyProgram(programLabel, settings = {}) {
  const raw = String(programLabel == null ? '' : programLabel).trim();
  if (!raw) return { product: PRODUCT.UNSET, program: null, reason: 'no program is set on the ClickUp task' };

  const configured = Array.isArray(settings['clickup.shortTermPrograms'])
    ? settings['clickup.shortTermPrograms'].filter((x) => String(x || '').trim())
    : null;
  const keys = configured && configured.length
    ? new Set(configured.map(normProgram))
    : SHORT_KEYS;

  if (keys.has(normProgram(raw))) {
    return { product: PRODUCT.SHORT, program: raw, reason: 'an RTL product' };
  }
  // THE OWNER'S RULE: anything that is not short-term is long-term. A program nobody
  // has seen before lands here on purpose.
  return { product: PRODUCT.LONG, program: raw, reason: 'not one of the RTL products' };
}

/** Convenience for the reconciliation's filters. */
const isLongTerm = (label, settings) => classifyProgram(label, settings).product === PRODUCT.LONG;

module.exports = {
  PRODUCT,
  SHORT_TERM_PROGRAMS,
  classifyProgram,
  isLongTerm,
  normProgram,
};
