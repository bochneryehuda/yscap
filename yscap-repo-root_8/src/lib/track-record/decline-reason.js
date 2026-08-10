'use strict';
/**
 * WHY a found property is NOT this borrower's — DERIVED, never typed
 * (owner-directed 2026-08-10: "reject 'not theirs' — no type-in reason box; the
 * system figures out WHY itself: same-name-different-person / matched by entity
 * only"). This consumes the #11 MATCH BASIS: a company-only match where the
 * borrower's own name is not among the people behind the company is "a different
 * company with the same name"; a personal-name (or confirmed-entity) match that
 * a reviewer rejects is "a different person with the same name".
 *
 * The reviewer confirms the system's reason, or picks one of a small GUIDED set
 * — never a free-text box. The resolved reason is what the NEXT search reads
 * (stageOne's `declined_before`), so it must always be present and human-
 * readable; a decline can therefore never be refused for "no reason given".
 *
 * PURE — no DB, no config. The browser mirror (labels + the suggest rule) is
 * app-v2/src/lib/declineReason.js, and test-track-record-decline-reason-pure.js
 * fails the moment the two disagree.
 */

const str = (v) => String(v == null ? '' : v).trim();

/* The guided reasons, in the order a reviewer weighs them. Each carries the
   plain-language TEXT stored on the candidate (read by the next search) and the
   short LABEL a picker shows. The text lives ONLY here (server-authoritative);
   the browser mirror carries the labels. */
const REASONS = {
  not_our_company: {
    label: 'A different company with the same name',
    text: 'Matched by the company name only — the borrower\'s own name is not among the people behind it, so this is most likely a different company with the same name.',
  },
  same_name_different_person: {
    label: 'A different person with the same name',
    text: 'A different person who happens to share the borrower\'s name — not this borrower.',
  },
  wrong_property: {
    label: 'The property details do not match',
    text: 'The property details on this record do not match this borrower\'s deal.',
  },
  not_theirs: {
    label: 'Not this borrower\'s',
    text: 'A reviewer confirmed this is not this borrower\'s property.',
  },
};
const ORDER = ['not_our_company', 'same_name_different_person', 'wrong_property', 'not_theirs'];

/**
 * THE SYSTEM'S BEST GUESS at WHY, read off the #11 match basis. Never throws.
 * @param {object|null} matchBasis  the candidate's stored match_basis
 * @returns {string} a code from ORDER
 */
function suggestFromBasis(matchBasis) {
  const mb = matchBasis && typeof matchBasis === 'object' ? matchBasis : null;
  if (mb) {
    /* The pending-warning case (#11): matched a company on the profile, the
       borrower is NOT among its people, others are → a same-name company. */
    if (mb.warn === true && mb.basis === 'entity_only') return 'not_our_company';
    /* Matched the borrower's personal name (or a company they ARE behind) — if
       the reviewer says it is not theirs, it is a namesake person. */
    if (mb.personalMatched === true || mb.basis === 'personal' || mb.basis === 'both') return 'same_name_different_person';
    /* Company matched, but we could not check the people (no list) — still most
       likely a same-name company. */
    if (mb.entityMatched === true) return 'not_our_company';
  }
  return 'not_theirs';
}

/** The guided options a screen shows, the suggested one first / flagged. */
function optionsFor(matchBasis) {
  const suggested = suggestFromBasis(matchBasis);
  return {
    suggested,
    options: ORDER.map((code) => ({ code, label: REASONS[code].label, suggested: code === suggested })),
  };
}

/**
 * RESOLVE the stored decline reason. A guided reasonCode wins; else a free-text
 * note is honored for back-compat (never required); else the system derives the
 * reason from the match basis. The same-name-company reason is specialized with
 * the entity name when we have it. Always returns a NON-EMPTY string ≤ 500 chars.
 */
function resolve({ reasonCode, matchBasis, note } = {}) {
  const code = REASONS[str(reasonCode)] ? str(reasonCode) : null;
  if (!code) {
    const typed = str(note);
    if (typed) return typed.slice(0, 500);
  }
  const eff = code || suggestFromBasis(matchBasis);
  let text = REASONS[eff].text;
  const entity = matchBasis && str(matchBasis.entityName);
  if (eff === 'not_our_company' && entity) {
    text = `Matched by the company name "${entity}" only — the borrower's own name is not among the people behind it, so this is most likely a different company with the same name.`;
  }
  return text.slice(0, 500);
}

module.exports = { REASONS, ORDER, suggestFromBasis, optionsFor, resolve };
