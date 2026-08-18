'use strict';
/**
 * LONG-TERM — WHAT THE 1003 MIRROR DELIBERATELY DOES NOT FILL, AND WHY.
 *
 * WHY THIS FILE EXISTS. A column with no writer is invisible: the screen shows a
 * dash, the dash reads as an ANSWER ("not in a flood zone", "no rent"), and
 * nothing anywhere fails. This side has now found that same shape five times — the
 * Condition Center sweep nothing called, the comment thread nothing filled, the
 * whole 1003 spine three surfaces read and nothing wrote, twenty-seven loan
 * columns with no writer, and the owner's census reading a dead column. Each was
 * found by somebody going looking. That is not a method.
 *
 * So the rule is now: EVERY COLUMN OF THE 1003 MIRROR IS EITHER FILLED OR LISTED
 * HERE WITH A REASON, and `scripts/test-lt-unsourced-pure.js` fails the build on a
 * column that is neither. A blank on a screen then always means one of two things
 * somebody decided on purpose, never a thing nobody noticed.
 *
 * THE REASONS ARE MEASURED, NOT ARGUED. Each one names what was looked for in the
 * 3,783-field census of 772 live loans (`encompass/dictionary/field-dictionary.json`,
 * read-only, 2026-08-14) and what was found. "Encompass does not have it" and "we
 * have not built it yet" are different sentences and the difference matters to
 * whoever reads this next.
 *
 * `unblock` IS THE POINT OF THE ENTRY. It says what would have to be true for the
 * column to fill — a live read, an owner's decision, a build — so this is a work
 * list rather than an excuse list.
 *
 * SEPARATION: a static description of Long-Term's own mirror. No database, no
 * network, no RTL.
 */

/** A fact Encompass does not record anywhere we can see. */
const NOT_IN_ENCOMPASS = 'not-in-encompass';
/** A fact that exists in the payload but whose meaning is the OWNER's to settle. */
const OWNER_DECISION = 'owner-decision';
/** Ours to judge, not Encompass's to tell us. */
const PILOT_JUDGEMENT = 'pilot-judgement';

/**
 * Keyed `table.column`. `show` is what a SCREEN says when it draws the field —
 * short, in the reader's language, and never a number.
 */
const UNSOURCED = {
  // ── The subject property ──────────────────────────────────────────────────
  'lt_properties.in_flood_zone': {
    kind: NOT_IN_ENCOMPASS,
    show: 'Encompass has not given us a flood determination we can read.',
    why: 'The census holds no field that answers "is the subject in a special flood hazard area" in a form we can trust. The closest is field 541 (closingDocument.specialFloodHazardAreaIndictor), filled on 40.2% of long-term loans and only from Loan Setup onward, and its six recorded values were withheld from the census by its own PII policy — so reading it as a yes/no would be guessing a vocabulary rather than reading one. A wrong answer here is worse than none: "No" beside a flood question is a claim somebody prices a loan on.',
    unblock: 'One read of field 541 (and TQL.X110) on a live loan in each state, recorded in ENCOMPASS-FIELD-INTELLIGENCE.md. Then this is one entry in the mapper.',
  },
  'lt_properties.flood_zone': {
    kind: NOT_IN_ENCOMPASS,
    show: 'The zone letter is on the flood certificate, which Encompass does not give us as a field.',
    why: 'Nothing in 3,783 measured fields carries a zone designation (A, AE, X…). Field 2977 is the flood certificate IDENTIFIER — the certificate\'s number, not its answer — and the certificate itself is a document in the eFolder.',
    unblock: 'Either a tenant field somebody fills, or reading the determination off the eFolder document, which is a document-parsing build and not a mirror one.',
  },
  'lt_properties.actual_monthly_rent': {
    kind: OWNER_DECISION,
    show: 'PILOT holds the gross rent Encompass gives us; "actual" is a separate figure nobody has told us where to read.',
    why: 'No field in the census means "actual rent" as distinct from the gross rent already stored (field 1005, 65.9%). The tenant HAS a switch — CX.USEACTUALRENTORMARKET — but it is filled on 6 long-term loans (1.2%) and it is a CHOICE between two figures, not a figure. URLA.X81 is an ESTIMATED NET monthly rent, which is a third thing again. Picking one would be inventing an underwriting rule.',
    unblock: 'The owner says which figure "actual rent" means on a DSCR file, and where it is typed.',
  },

  // ── The borrowing entity ──────────────────────────────────────────────────
  // A DSCR loan very often closes in an LLC, and this tenant does not keep that
  // as a structured record. What it has is three overlapping, mostly-empty
  // places, and choosing between them is a business decision.
  'lt_parties.entity_type': ENTITY('what kind of entity it is'),
  'lt_parties.entity_legal_name': ENTITY('the entity\'s legal name'),
  'lt_parties.entity_state_of_formation': ENTITY('where it was formed'),
  'lt_parties.entity_formation_date': ENTITY('when it was formed'),
  'lt_parties.entity_ein_encrypted': {
    kind: OWNER_DECISION,
    show: 'PILOT does not hold the entity\'s EIN.',
    why: 'Nothing in the census carries an EIN, and this column is an ENCRYPTED one: the only encryption in this codebase is an RTL module, so filling it would need a written crossing in docs/LONG-TERM-AUTHORIZED-COPIES.md as well as a source — the same reason lt_parties.ssn_encrypted stays NULL while ssn_last4 is stored.',
    unblock: 'A source field, then the crossing, then a writer. Not before.',
  },
  'lt_parties.entity_title': ENTITY('the signer\'s title in it'),
  'lt_parties.entity_ownership_pct': ENTITY('their share of it'),

  // ── The schedule of real estate, and what is on it ────────────────────────
  'lt_reo_properties.acquired_date': {
    kind: NOT_IN_ENCOMPASS,
    show: 'Encompass does not date the rows on the schedule of real estate.',
    why: 'The census carries no acquisition date per REO row. Two loan-level fields come close and are NOT this: field 24 is the year the SUBJECT was acquired (42.0%), and CX.DATEACQUIRED (26.5%) is one date for the file. Writing either onto every rental would put one property\'s history on all of them.',
    unblock: 'A per-row date in the payload, or the subject\'s own year mirrored onto lt_properties where it actually belongs.',
  },
  'lt_reo_properties.is_verified': VERIFIED('a rental on the schedule'),
  'lt_assets.is_verified': VERIFIED('an account'),

  // ── The adjustable-rate terms ─────────────────────────────────────────────
  // `lt_loans` is deliberately outside this file's every-column rule (it is filled
  // by three syncs and carries PILOT's own bookkeeping beside Encompass's facts) —
  // but these eight are listed anyway, because the file screen DRAWS them the
  // moment a loan is adjustable, and eight dashes under "Adjustable-rate terms"
  // is precisely the reads-as-an-answer failure this file exists to stop.
  'lt_loans.arm_index_name': ARM('which index the rate follows'),
  'lt_loans.arm_margin_pct': ARM('the margin added to the index'),
  'lt_loans.arm_first_adjustment_months': ARM('when the rate first moves'),
  'lt_loans.arm_adjustment_frequency_months': ARM('how often it moves after that'),
  'lt_loans.arm_initial_cap_pct': ARM('how far it may move the first time'),
  'lt_loans.arm_periodic_cap_pct': ARM('how far it may move each time after'),
  'lt_loans.arm_lifetime_cap_pct': ARM('how high it may ever go'),
  'lt_loans.arm_floor_pct': ARM('how low it may ever go'),
};

/** The four entity columns say the same thing; the sentence is written once. */
function ENTITY(what) {
  return {
    kind: OWNER_DECISION,
    show: 'PILOT does not hold a record of the borrowing entity yet.',
    why: `This tenant keeps no structured entity record, so ${what} has no single place to be read from. What the census found: CX.LLCNAME / CX.LLCSTATE / CX.LLCCORP exist but are filled on 0.8% of long-term loans (4 files); field 1867 (finalVestingDescription) is free text on 38.0%; URLA.X138 is a vesting TYPE on 43.9%; and field 33 "Manner Held" is a dropdown that staff type the vesting entity's name into about half the time (ENCOMPASS-INVESTORS-AND-DROPDOWNS.md). Deciding which of those IS the entity is a business rule, and guessing one would put a company name on a loan file that nobody put there.`,
    unblock: 'The owner says where the entity is recorded on a DSCR file. One answer, then one entry in the mapper.',
  };
}

/**
 * The eight ARM terms say the same thing, and the measurement behind it is the
 * most instructive one in this file: the two fields that LOOK like ARM terms are
 * the note rate wearing a different name.
 */
function ARM(what) {
  return {
    kind: NOT_IN_ENCOMPASS,
    show: 'PILOT does not hold this loan\'s adjustable-rate terms — Encompass gives us no figure for them we can trust.',
    why: `Nothing in the 3,783-field census carries ${what} in a readable form. The two that look like they do are the NOTE RATE under another name: field 2625 (maxLifeInterestCapPercent) and field 3557 (firstAdjustmentMinimum) are each filled on 86.9% of long-term loans and each carry EXACTLY field 3's own distribution — min 6, p25 6.875, median 7.25, p75 8, max 10.75 over the same 490 loans — because on a fixed loan Encompass echoes the rate into them. Writing 2625 into a lifetime cap would print a ceiling equal to the start rate, which is a confident wrong answer about how high a borrower's payment can go. The two genuinely ARM-shaped fields are not terms at all: ARM.IdxLkbckPrd is the index LOOKBACK period (one distinct value across the book) and field 4912 is the index's decimal PRECISION. And the book is one loan — field 608's observed values are Fixed on 765 and AdjustableRate on 1.`,
    unblock: 'One read of a real adjustable loan\'s loanProductData in Encompass, recorded in ENCOMPASS-FIELD-INTELLIGENCE.md. Then each of these is one entry in the mapper.',
  };
}

/** Verification is a judgement somebody makes, not a fact Encompass hands over. */
function VERIFIED(what) {
  return {
    kind: PILOT_JUDGEMENT,
    show: 'Nobody has marked this as verified.',
    why: `The census carries no per-row verification flag — nothing says "${what} has been checked". Verifying is something a person does here, so this column is waiting on a PILOT control rather than on a read, and it stays false until one exists. A read that set it TRUE would be asserting that somebody checked, which nobody did.`,
    unblock: 'The verification control on the file screen — a PILOT-side build, not a mirror one.',
  };
}

/** Is this column knowingly empty, and what should a screen say about it? */
function unsourced(table, column) {
  return UNSOURCED[`${table}.${column}`] || null;
}

/** What a screen shows for a whole table's worth, keyed by COLUMN. */
function notSourcedFor(table) {
  const out = {};
  for (const [key, entry] of Object.entries(UNSOURCED)) {
    const [t, c] = key.split('.');
    if (t === table) out[c] = entry.show;
  }
  return out;
}

module.exports = {
  UNSOURCED,
  unsourced,
  notSourcedFor,
  KINDS: { NOT_IN_ENCOMPASS, OWNER_DECISION, PILOT_JUDGEMENT },
};
