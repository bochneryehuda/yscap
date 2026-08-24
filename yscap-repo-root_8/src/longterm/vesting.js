'use strict';
/**
 * LONG-TERM — how title vests, decided by field 4008 and nothing else.
 *
 * Owner-directed 2026-08-23: *"If field 4008 is showing 'individual' … vesting
 * is individual. The only time you need to look for the entity name is if that
 * field 4008 shows 'officer'."*
 *
 * Verified live both ways (2026-08-24): an Officer-vested loan answers
 * `{"4008":"Officer","1859":"Sample Holdings LLC"}`; an Individual-vested loan
 * answers `{"4008":"Individual","1859":""}`. Across the whole book (486 loans)
 * field 4008 holds exactly Officer (445) / Individual (22) / blank (19).
 *
 * THE RULE, PRECISELY:
 *   · "Individual" → the person takes title. The entity name is NEVER read,
 *     never stored — even if 1859 happens to carry text, which on a re-vested
 *     loan is exactly the stale value the rule exists to ignore.
 *   · "Officer" → the loan vests in an entity, and 1859 is its legal name. An
 *     Officer vesting whose 1859 is blank is a real state ("entity name still
 *     to be entered") and is reported as such, never guessed.
 *   · "Trustee" → an entity vesting too. The tenant's own completion rule
 *     (encompass/completion-rules.js: `[4008] = "Trustee" OR [4008] = "Officer"`)
 *     defines entity vesting as either word; Trustee has not occurred in the
 *     measured book, so this is readiness, not behaviour anyone sees today.
 *   · blank / anything else → NOTHING is claimed. Both columns stay as they
 *     are; an absent reading is not evidence.
 *
 * PURE — no database, no client. The sync hands it the fieldReader values.
 */

/** The two ids, both VERIFIED LIVE before joining any shared batch (the FR0117
 *  lesson: the LT client does not split a failed batch). */
const FIELD_IDS = ['4008', '1859'];

const text = (v) => {
  const s = String(v == null ? '' : v).trim();
  return s === '' ? null : s;
};

/** 4008 wordings that mean "an entity takes title" — the tenant's own pair. */
const ENTITY_WORDS = new Set(['officer', 'trustee']);
const INDIVIDUAL_WORD = 'individual';

/**
 * The decision. Returns:
 *   { answered, vestingType, vestsInEntity, entityName, entityNameMissing }
 *
 * `answered` false = 4008 was blank or unreadable → claim nothing (the writer
 * leaves both columns alone). `vestsInEntity` null on an unrecognised word —
 * a value we have never seen is reported verbatim, never mapped by guess.
 */
function vestingOf(values) {
  const raw = text(values && values['4008']);
  if (!raw) return { answered: false, vestingType: null, vestsInEntity: null, entityName: null, entityNameMissing: false };

  const word = raw.toLowerCase();
  if (word === INDIVIDUAL_WORD) {
    // The owner's rule, verbatim: individual means individual. The entity name
    // is not consulted at all.
    return { answered: true, vestingType: raw, vestsInEntity: false, entityName: null, entityNameMissing: false };
  }
  if (ENTITY_WORDS.has(word)) {
    const entityName = text(values && values['1859']);
    return {
      answered: true,
      vestingType: raw,
      vestsInEntity: true,
      entityName,
      // A real state on a young file: vested in an entity whose name nobody has
      // typed yet. Said, never guessed.
      entityNameMissing: !entityName,
    };
  }
  // A word the measured book has never shown. Recorded verbatim so a screen can
  // show it; no entity conclusion is drawn from it.
  return { answered: true, vestingType: raw, vestsInEntity: null, entityName: null, entityNameMissing: false };
}

/**
 * Plain words for a screen. Kept here so the file header, the pipeline and the
 * ClickUp mapping can never describe one loan's vesting two ways.
 */
function describeVesting(row) {
  const t = text(row && (row.vesting_type != null ? row.vesting_type : row.vestingType));
  const name = text(row && (row.vesting_entity_name != null ? row.vesting_entity_name : row.vestingEntityName));
  if (!t) return { known: false, label: null, entityName: null };
  const word = t.toLowerCase();
  if (word === INDIVIDUAL_WORD) return { known: true, label: 'Individual', entityName: null };
  if (ENTITY_WORDS.has(word)) {
    return { known: true, label: name || 'Entity — name not entered yet', entityName: name };
  }
  return { known: true, label: t, entityName: name };
}

module.exports = { FIELD_IDS, vestingOf, describeVesting, _internals: { ENTITY_WORDS, INDIVIDUAL_WORD, text } };
