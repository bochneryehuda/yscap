/**
 * Enum crosswalks — portal value <-> ClickUp option LABEL, per
 * docs/CLICKUP-DATA-MAPPING.md Part 6. Labels only (stable); the option UUID is
 * resolved at runtime against the live option list via transforms, so option-id
 * churn never breaks the map and newly-added ClickUp options are picked up.
 *
 * Composite cases (Ground-Up program+loan-type, vesting-from-LLC, marital) are
 * handled by the orchestrator; this module is pure per-field label mapping.
 */
const T = require('./transforms');
/* THE ONE alias table for the four crosswalked DEAL enums. PURE (no pg), so
   requiring it eagerly here keeps this module's own no-database contract.
   Consulted on the WRITE side only — `inverseFor` (the read side) is untouched,
   so the inbound pull keeps landing on our canonical spelling and the two
   directions cannot drift. See enum-vocab.js for the full reasoning. */
const VOCAB = require('../lib/enum-vocab');

// fieldId = ClickUp custom_field id; to = { portalValue: clickupLabel }.
// `NEW:` labels are options the owner is adding (Ground-Up, Condo, Townhouse).
const FIELDS = {
  program: {
    id: '50eb857a-d8b1-4c48-9ffe-20b15cdf1338',
    to: {
      'Fix & Flip w/ Construction': 'Fix & Flip With Construction',
      'Bridge': 'bridge Without Construction',
      'Ground-Up Construction': 'Ground-Up',        // NEW option (owner adding)
      // Fix & Hold (BRRRR) — a real RTL product we originate (loan-primer: "fix
      // & flip, fix & hold"): pricing.js `engineStrategy` prices it, the EMCAP
      // tape exports it, the Encompass map compares it. It had NO ClickUp option,
      // which is what made an officer's "Fix & Flip → Fix & Hold" edit bounce
      // back (#822).
      //
      // The owner added the option as "Fix & Hold WITH CONSTRUCTION" and directed
      // (2026-07-27) that it map to our plain 'Fix & Hold' anyway — "it's the
      // same", exactly like the flip pair one line above, where our
      // 'Fix & Flip w/ Construction' maps to ClickUp's "Fix & Flip With
      // Construction". Our stored value stays 'Fix & Hold' on purpose: that is
      // the spelling pricing.js, field-registry, the EMCAP tape and the Encompass
      // map already key on — renaming it would break all four. Only the ClickUp
      // LABEL differs, which is precisely what this map exists to absorb.
      // Verified against the live dropdown via the ClickUp connector.
      'Fix & Hold': 'Fix & Hold With Construction',
      'Not sure yet': null,                          // leave blank; officer sets
    },
    // inbound labels with no exact portal twin. The Fix & Hold spellings are
    // here so the INBOUND read still lands on our canonical 'Fix & Hold' if the
    // option ends up named slightly differently in ClickUp (BRRRR is the same
    // strategy — pricing.js already treats "hold" and "brrrr" identically).
    fromExtra: {
      'Private hard money': 'Bridge',
      // Spelling tolerance on the READ side only, so a card set by hand (or an
      // option later renamed) still lands on our canonical 'Fix & Hold'. The
      // authoritative label is the `to` entry above — this is a safety net.
      'Fix & Hold': 'Fix & Hold',
      'Fix and Hold': 'Fix & Hold',
      'Fix and Hold With Construction': 'Fix & Hold',
      'Fix & Hold w/ Construction': 'Fix & Hold',
      'Fix & Hold (BRRRR)': 'Fix & Hold',
      'BRRRR': 'Fix & Hold',
    },
  },
  loan_type: {
    id: 'ee1b564f-13cb-4841-af4c-e0f762cbcf52',
    to: {
      'Purchase': 'Purchase',
      'Refinance — Rate & Term': 'Refi Rate & Term',
      'Refinance — Cash-Out': 'Refi Cash-Out',
      // Delayed purchase financing is its OWN loan type in PILOT, spelled
      // EXACTLY as ClickUp spells it (owner-directed 2026-07-27) so it
      // round-trips with no translation and no information lost. It used to be
      // a live ClickUp option that read back as NOTHING, so a card set to it
      // left the portal on its stale loan type.
      'Delayed Purchase Financing': 'Delayed Purchase Financing',
    },
    // HELOC and "Second Closed end Mortgage" are deliberately left unmapped:
    // they are not RTL products, so a card carrying one is data-only and must
    // never overwrite an RTL file's loan type.
  },
  property_type: {
    id: '541524d9-255f-4484-ac6d-1011ac60e87b',
    to: {
      'SFR (1 unit)': 'SFR',
      'Multi 2–4': 'Multi 2-4',
      'Multi 5+': 'Multi 5+',
      'Mixed use': 'Mixed Use',
      'Condo': 'Condo',                              // NEW option (owner adding)
      'Townhouse': 'Townhouse',                      // NEW option (owner adding)
    },
    fromExtra: {
      'Warrantable condo': 'Condo', 'Non-warrantable condo': 'Condo',
      'Co-Op': 'Condo', 'New Construction': 'SFR (1 unit)',
    },
  },
  occupancy: {
    id: 'df9d81b5-0b5d-4e09-a44a-4bbfb3b0291c',
    to: { 'Primary': 'Primary', 'Investment': 'Investment', 'Secondary': 'Secondary' },
  },
  vesting: {
    id: '173dc79a-a12d-4233-a6a6-9f4101770ca9',
    to: { 'Individual': 'Individual', 'LLC / Corp': 'LLC / Corp', 'Trust': 'Trust' },
  },
  rehab_type: {
    id: 'fb8814d4-c457-4b8f-af42-671e1e1ad752',      // ClickUp "Rehab Type" field
    to: {
      'Cosmetic': 'Cosmetic', 'Moderate': 'Moderate', 'Heavy / gut rehab': 'Heavy',
      'Adding square footage': 'Adding SF', 'Ground-up construction': 'Ground-up',
    },
  },
  employment_type: {
    id: '33bf62d8-fa4f-45e5-9c91-a51ce78e5e32',
    to: {
      'W-2': 'W-2', '1099': '1099', 'K1': 'K1 - S CORP', 'K1 - S CORP': 'K1 - S CORP',
      'C CORP': 'C CORP', 'Self employed': 'Self employed',
    },
  },
  contact_type: {
    id: '44120431-132f-4509-a086-e2dea10c3a72',
    to: { 'INVESTOR': 'INVESTOR', 'PRIMARY': 'PRIMARY', 'FIRST TIME INVESTOR': 'FIRST TIME INVESTOR' },
  },
  term: {
    id: 'b67dd5fd-c753-47e9-b3dd-aa576d742abd',
    to: {
      '12 Months': '12 Months', '30 year': '30 year', '15 year': '15 year',
      'Interest only': 'Interest only', 'Other': 'Other',
    },
    defaultLabel: '12 Months',                       // RTL default when blank
  },
  housing_status: {
    id: '6ae80836-6835-4c91-a3ef-209923f89e30',
    to: {
      'Rent': 'Rent', 'Own with mortgage': 'Mortgage', 'Own free and clear': 'own free and clear',
      'Live with family': 'Rent Free', 'Other': null,
    },
    // The dropdown carries BOTH 'Free' and 'Rent Free'. 'Free' means RENT-free
    // (owner-directed 2026-07-27) — NOT 'own free and clear', which is its own
    // option. Our only rent-free bucket is 'Live with family', so both land
    // there; we keep WRITING 'Rent Free' (the `to` map is untouched), so this
    // is read-side only and can never re-label a card.
    fromExtra: { 'Free': 'Live with family' },
  },
  // Borrower-facing status mirror ON the ClickUp task (option labels == our values).
  // file_intake (#151): resolves only once a 'file_intake' option is added to the
  // ClickUp dropdown — until then the mirror write is silently skipped (the
  // label→id lookup returns null and the mapper's put() drops nulls), never a
  // guard trip or a wrong option. The other ten options are our exact snake_case
  // values, so the new one should be named 'file_intake' to match.
  //
  // The owner confirmed (2026-07-27) that ClickUp's word for this stage is
  // "starting" — the same equivalence clickup/status.js already encodes for the
  // TASK status ('starting' -> file_intake). So we ALSO read a 'starting' /
  // 'started' option back as file_intake, in case the dropdown option gets named
  // that way instead. Read-side only: we still write 'file_intake'.
  borrower_portal_status: {
    id: 'a47ce5e3-eea7-4f70-93ca-8062dee4d1b7',
    to: {
      file_intake: 'file_intake',
      new: 'new', in_review: 'in_review', processing: 'processing', underwriting: 'underwriting',
      approved: 'approved', clear_to_close: 'clear_to_close', funded: 'funded',
      on_hold: 'on_hold', declined: 'declined', withdrawn: 'withdrawn',
    },
    fromExtra: { 'starting': 'file_intake', 'started': 'file_intake' },
  },
  // Registered product -> ClickUp "RTL Loan Program" field (Standard / Gold /
  // Silver / Speed / Manual). Portal-authoritative, one-way (§7.1/7.5).
  registered_program: {
    id: 'aae034e4-633c-40db-85b4-7d8cfe33501b',
    to: { standard: 'The Standard program', gold: 'The Gold program', silver: 'The Silver program', speed: 'The Speed program', manual: 'The Manual program', none: null },
    // ALTERNATE spellings tried when the primary label isn't in the live dropdown.
    // The Silver + Manual options are created BY HAND in ClickUp (owner-directed
    // 2026-07-29: "I'm adding the click up label for the silver program … I added
    // in click up the manual program"), so the exact wording may differ from ours
    // ("Silver Program" vs "The Silver program"). CLOSED per-value lists consumed
    // by resolveWriteId — never a fuzzy match; an unmatched label still no-ops
    // safely (we never invent ClickUp dropdown options). The Speed option
    // (2026-09-03) is likewise added BY HAND in ClickUp — until it exists there the
    // write no-ops, exactly as Silver's did before the owner added its label.
    toAlt: {
      silver: ['Silver program', 'Silver'],
      speed: ['Speed program', 'Speed'],
      manual: ['Manual program', 'Manual'],
      standard: ['Standard program'],
      gold: ['Gold program', 'Gold Standard program'],
    },
  },
};

const _norm = (s) => String(s == null ? '' : s).trim().toLowerCase();

/** Build (and cache) the inverse label map for a field: normalized CU label -> portal value. */
function inverseFor(key) {
  const f = FIELDS[key];
  if (!f) return {};
  if (f._inv) return f._inv;
  const inv = {};
  for (const [portal, cu] of Object.entries(f.to)) if (cu) inv[_norm(cu)] = portal;
  for (const [cu, portal] of Object.entries(f.fromExtra || {})) inv[_norm(cu)] = portal;
  f._inv = inv;
  return inv;
}

/** Portal value -> ClickUp option label (write side). null = leave field blank. */
function toClickUpLabel(key, rawValue) {
  const f = FIELDS[key];
  if (!f) return null;
  if (rawValue == null || rawValue === '') return f.defaultLabel || null;
  /* A value stored in another producer's dialect ('Fix & Hold (BRRRR)' from the
     public form) means the SAME program as our canonical spelling, so it must
     push to the same option instead of being dropped in silence — which is what
     left the owner's card with an empty *Program field. Unrecognised values pass
     through unchanged, so nothing is ever guessed into a neighbouring option. */
  const portalValue = VOCAB.canonicalEnum(key, rawValue);
  if (Object.prototype.hasOwnProperty.call(f.to, portalValue)) return f.to[portalValue];
  // tolerant match (case/space)
  const want = _norm(portalValue);
  const hit = Object.keys(f.to).find((k) => _norm(k) === want);
  return hit ? f.to[hit] : (f.defaultLabel || null);
}

/** ClickUp option label -> portal value (read side). */
function fromClickUpLabel(key, clickupLabel) {
  if (clickupLabel == null || clickupLabel === '') return null;
  return inverseFor(key)[_norm(clickupLabel)] || null;
}

/**
 * Is this portal value one ClickUp CANNOT hold? (owner-reported 2026-07-27:
 * "changing Fix & Flip to Fix & Hold bounces back and doesn't save".)
 *
 * ROOT CAUSE of that whole class. `toClickUpLabel` collapses two very different
 * outcomes onto the same `null`:
 *   (a) a DELIBERATE blank — the value is mapped to null on purpose ('Not sure
 *       yet' → leave the ClickUp field empty for the officer to set), and
 *   (b) a value we simply have no ClickUp twin for ('Fix & Hold' — a real PILOT
 *       program that prices, exports to the tape and maps to Encompass, but has
 *       no option in the ClickUp *Program dropdown).
 * `writeValue` returns undefined for both and `put()` drops it, so case (b) left
 * the ClickUp card UNTOUCHED **in silence** — and the very next inbound pull,
 * which writes `program = COALESCE(<ClickUp's value>, program)`, overwrote the
 * officer's edit with the stale ClickUp value. The edit really did save; it was
 * reverted seconds later by the sync, which reads to a human as "it bounces back
 * and the Save button does nothing".
 *
 * This names case (b) so the callers can act on it instead of dropping it:
 * `inbound-enum-guard` refuses to let ClickUp overwrite such a value, and the
 * staff editor tells the officer the value is kept in PILOT but has no ClickUp
 * twin. A deliberate blank (case a) is NOT unmappable — nothing is being lost.
 *
 * @param optionList optional LIVE ClickUp option list for the field. When given,
 *        a value whose label exists in the crosswalk but NOT in ClickUp's actual
 *        dropdown (a renamed / never-added option, e.g. 'Ground-Up' before the
 *        owner added it) is unmappable too — that write silently vanishes the
 *        same way. Omitted/empty ⇒ crosswalk-only check, never a false positive.
 */
function unmappableToClickUp(key, rawValue, optionList) {
  const f = FIELDS[key];
  if (!f) return false;                                   // not a crosswalked enum
  if (rawValue == null || rawValue === '') return false;  // nothing to push
  // Same canonicalization the write uses, or a dialect that NOW pushes correctly
  // would still be reported as having no ClickUp twin and park a review for
  // nothing (and the enum guard would hold a field that syncs perfectly well).
  const portalValue = VOCAB.canonicalEnum(key, rawValue);
  const want = _norm(portalValue);
  const hit = Object.prototype.hasOwnProperty.call(f.to, portalValue)
    ? portalValue
    : Object.keys(f.to).find((k) => _norm(k) === want);
  // Known value mapped to null ⇒ deliberately blank in ClickUp, not a loss.
  if (hit !== undefined && hit !== null) {
    if (f.to[hit] == null) return false;
    if (!notInOptions(f.to[hit], optionList)) return false;
    // The primary label isn't offered — an enumerated alternate spelling that IS
    // offered still maps (resolveWriteId tries the same list), so it's not a loss.
    const alts = (f.toAlt && f.toAlt[_norm(hit)]) || [];
    return !alts.some((alt) => !notInOptions(alt, optionList));
  }
  // Unknown value: only a defaultLabel can carry it, else the write is dropped.
  if (!f.defaultLabel) return true;
  return notInOptions(f.defaultLabel, optionList);
}

// A label ClickUp's live dropdown doesn't actually offer can't be written either.
// No list supplied ⇒ we can't tell, so never claim unmappable.
function notInOptions(label, optionList) {
  if (!label || !Array.isArray(optionList) || !optionList.length) return false;
  return !optionList.some((o) => _norm(o && (o.name != null ? o.name : o.label)) === _norm(label));
}

/**
 * RTL descope classification (portal-side policy, blueprint §4).
 *
 * The portal only BUILDS three RTL products (Fix & Flip / Bridge / Ground-Up). A
 * LINKED RTL file whose ClickUp *Program was intentionally changed to a long-term
 * / rental / DSCR product is "descoped" (soft-removed from the portal). To keep
 * that from ever MASS-soft-deleting real loan files, descope must fire ONLY on a
 * raw ClickUp label we POSITIVELY recognize as non-RTL — never merely because the
 * RTL crosswalk above failed to map a label (a renamed / newly-added / typo'd
 * option, or a stale option cache that mis-resolves the label would otherwise
 * make every live RTL file "look" non-RTL and vanish). This is an explicit
 * allowlist plus a conservative keyword backstop; none of the keywords can appear
 * in an RTL label (Fix & Flip / Bridge / Ground-Up), so a match is a safe signal.
 */
const NON_RTL_PROGRAM_LABELS = new Set(['non-qm - dscr ratio']);
const NON_RTL_KEYWORDS = /\b(dscr|non.?qm|heloc|rental|30\s*year|long.?term|conventional)\b/i;
function isNonRtlProgramLabel(rawLabel) {
  const s = String(rawLabel == null ? '' : rawLabel).trim();
  if (!s) return false;
  return NON_RTL_PROGRAM_LABELS.has(s.toLowerCase()) || NON_RTL_KEYWORDS.test(s);
}

/**
 * Resolve a portal value to the ClickUp option UUID to WRITE, using the live
 * option list [{id,orderindex,name}] for that field. Tries the primary label,
 * then the field's enumerated `toAlt` spellings (hand-created dropdown options
 * may word a label differently — e.g. "Silver Program" vs "The Silver program").
 */
function resolveWriteId(key, portalValue, optionList) {
  const label = toClickUpLabel(key, portalValue);
  if (!label) return null;
  const hit = T.dropdownLabelToId(optionList, label);
  if (hit) return hit;
  const f = FIELDS[key] || {};
  // The alternate spellings are keyed on the CANONICAL value, so a dialect value
  // must be folded first or its alternates would silently not be tried.
  const alts = (f.toAlt && f.toAlt[_norm(VOCAB.canonicalEnum(key, portalValue))]) || [];
  for (const alt of alts) {
    const h = T.dropdownLabelToId(optionList, alt);
    if (h) return h;
  }
  return null;
}

/**
 * Resolve a ClickUp READ value (orderindex integer) to the portal value, using
 * the live option list for that field.
 */
function resolveReadValue(key, orderindex, optionList) {
  const label = T.dropdownIndexToLabel(optionList, orderindex);
  return label ? fromClickUpLabel(key, label) : null;
}

module.exports = { FIELDS, toClickUpLabel, fromClickUpLabel, resolveWriteId, resolveReadValue, isNonRtlProgramLabel, unmappableToClickUp };
