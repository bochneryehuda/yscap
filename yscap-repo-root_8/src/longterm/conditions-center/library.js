'use strict';
/**
 * LONG-TERM — THE SEEDED CONDITION LIBRARY.
 *
 * Every condition the owner dictated on 2026-08-30, as DATA. This file is the
 * pre-fill; the database row is the truth, and a buyer's edit to a row always
 * survives a redeploy (`seed()` never overwrites).
 *
 * ── WHY THIS IS JAVASCRIPT AND NOT SQL IN THE MIGRATION ─────────────────────
 *
 * Two reasons, and both bite. A rule written in SQL cannot be checked against
 * the field registry, so a typo in a field key would sit in the database until
 * the day the condition silently stopped attaching. And this wording is read by
 * borrowers — it belongs where it can be reviewed as prose rather than as string
 * literals inside an INSERT. `verify()` runs the whole library through
 * `rules.validateRule` and is asserted by the test suite, so a rule naming a
 * field that does not exist fails the build rather than a file.
 *
 * ── WHAT "PRE-FILLED, NOT HARD-WIRED" MEANS HERE ────────────────────────────
 *
 * The owner: *"everything should be setup with not setting it on a hard level
 * everything should be able to be configured differently in settings. The system
 * is only prefilled with the rules of the system."*
 *
 * So every field below — the bucket, the wording, the audience, whether it is
 * required, its slots, and the rule itself — is a COLUMN a buyer can change on
 * the settings screen. Nothing here is consulted at runtime once the row exists.
 *
 * ── THE `internal` / `external` SPLIT IS OUR READING, AND IT IS FLAGGED ──────
 *
 * The owner said they would confirm it afterwards: *"When you finish, you can
 * ask me for the other conditions: which one is external and internal, and which
 * one is only internal."* The reading applied below is stated so it can be
 * checked rather than discovered:
 *
 *   · a condition the BORROWER has to satisfy is `both` — the team works it and
 *     the borrower can see what is being asked of them;
 *   · a condition WE satisfy — an order we place, a document we pull, a check we
 *     run — is `internal`;
 *   · nothing is `external` alone, because every one of these is worked by
 *     somebody here as well.
 *
 * Every one of them is one click to change, and the write-up lists them.
 *
 * ── WHAT IS SHIPPED SWITCHED OFF, AND WHY IT IS SHIPPED AT ALL ──────────────
 *
 * `enabled: false` is a condition that is BUILT but not live. It shows on the
 * file, greyed, WITH ITS REASON — so nobody thinks a feature vanished, and
 * turning it on is a settings change rather than a release. Nothing ships that way
 * today; the shape is kept because it is how a condition is held back safely, and
 * because it is also what an administrator's own switch writes.
 *
 * PURE apart from `seed()`, which is the one function that touches a database.
 */

const rules = require('./rules');
const registry = require('./field-registry');
// The ONE translation between this file's wording and the shared Condition
// Center's vocabulary. `seed()` writes through it and `read.js` reads back
// through it, so a bucket cannot be filed under one heading and shown under
// another (db/653 states the whole decision and why it is a MAP, not a widen).
const vocab = require('./vocabulary');
// The vendor VOCABULARY — what each contact is called, and the word a card is
// filed under in the shared directory. PURE, no requires of its own, so this is
// not a cycle. See FILE_CONTACT_TYPES below.
const orderKinds = require('../orders/kinds');

const B = {
  SUBMISSION: 'prior_to_submission',
  CTC: 'prior_to_ctc',
  DOCS: 'prior_to_docs',
  FUNDING: 'prior_to_funding',
  PURCHASE: 'prior_to_purchase',
};

/** A rule shorthand: one row, `and`-wrapped, so every rule has the same shape. */
const when = (field, operator, value) => ({
  combinator: 'and',
  rules: [value === undefined ? { field, operator } : { field, operator, value }],
});

/** The same, for a condition that applies when ANY one of several rows holds. */
const whenAny = (rows) => ({ combinator: 'or', rules: rows });

// ═══════════════════════════════════════════════════════════════════════════
// WHO CAN BE ON A LONG-TERM FILE — THE ONE LIST
// ═══════════════════════════════════════════════════════════════════════════
/**
 * EVERY CONTACT A LONG-TERM FILE CAN CARRY, what each is called, and the ONE fact
 * that decides whether it belongs on THIS file.
 *
 * ── WHY THIS IS ONE LIST AND NOT THREE ──────────────────────────────────────
 *
 * These names were written out three times: in the pre-submittal condition's
 * `contactTypes`, in `orders/kinds.js VENDOR_KINDS`, and again as a flat array in
 * the File contacts screen. Nothing could see the other two, so a company was
 * "Settlement agent" on one and "Settlement agent (New York)" on another, and the
 * screen offered a landlord row the condition had never heard of. The condition
 * now DERIVES its two rows from here, the screen reads this list from the server,
 * and `test-lt-orders-pure.js` holds the orders registry to it.
 *
 * ── `whenField` IS THE SAME MACHINERY THE CONDITIONS USE ────────────────────
 *
 * The rule engine cannot express a per-ROW condition, so `read.contactTypesFor`
 * answers it from the same field a rule would — and it answers THREE ways, which
 * is the point: yes, no, and *we cannot tell yet*. Owner-directed 2026-08-31,
 * asked what an unread file should show: *"Show it greyed, saying we can't tell
 * yet."* A row that does not apply is KEPT AND MARKED, never dropped — *"The New
 * York Settlement Agent Order should be grayed out. And collapsed. Be visible
 * that doesn't belong for this file."*
 *
 * `preSubmission` marks the two the file genuinely cannot be submitted without.
 * Everything else is a slot on the desk, offered when the deal calls for it.
 *
 * THE LABEL IS NOT WRITTEN HERE — it is taken from `orders/kinds.js VENDOR_KINDS`,
 * which is the word already written onto the shared directory card
 * (`service_contacts.custom_type`) when one is created. So this file decides WHICH
 * contacts a long-term file can carry and WHEN each is asked for, and that file
 * decides what each is CALLED, and neither can drift from the other — which they
 * had: this list first said "HOA / management company" while a card created from
 * it was filed as "HOA management company", so the same company read two ways on
 * two screens. A key with no entry there yields `undefined`, which `verify()`
 * refuses at load, so a typo cannot ship as a blank pill.
 */
const FILE_CONTACT_TYPES = Object.freeze([
  { key: 'title', required: true, preSubmission: true },
  { key: 'hazard_insurance', required: true, preSubmission: true },
  // Read from Encompass field 541 or ticked by hand — see src/longterm/flood-zone.js.
  { key: 'flood_insurance', required: false, whenField: 'in_flood_zone' },
  /* ── THE THREE THAT FOLLOW THE DEAL, ON THE CONDITION TOO ────────────────
     Owner-directed 2026-09-02, on the pre-submittal file-contacts CONDITION
     (not the desk): *"prior to submittal, we only have hazard insurance and
     title insurance. This file is actually his primary, and we don't have the
     slot over there for landlord contact information … if he's a renter, it
     should also populate landlord contact … If it's a condo, populate the
     condo. If it's a New York file, populate the settlement agent."*

     So these three are `preSubmission` like the two above — but each carries a
     `whenField`, and `contactTypesFor` answers `applies: true / false / null`
     from the file's own live facts: a row for a deal that does not need it is
     kept and greyed with the reason, never dropped; a fact PILOT cannot read
     yet is "we cannot tell yet", never a confident no. `required: true` means
     required WHEN IT APPLIES — the sign-off gate and the screen's "still
     needed" line both read `applies !== false && required`. On a purchase in
     New Jersey by a homeowner, none of the three is asked for. */
  // New York closes through a settlement agent rather than the title company.
  { key: 'ny_settlement_agent', required: true, preSubmission: true, whenField: 'is_new_york' },
  // Owner-directed 2026-08-31: *"We should also have the HOA contact. That should
  // be grayed out, and it should only be available on a condo."*
  { key: 'hoa', required: true, preSubmission: true, whenField: 'is_condo' },
  // …*"We should have the landlord contact information if the person is renting
  // his primary residence, and if not, it should also be grayed out."* It is the
  // contact the verification of rent is sent to, so it is a real slot rather than
  // a note somebody types.
  { key: 'landlord', required: true, preSubmission: true, whenField: 'borrower_rents' },
  // Whoever holds the loan being paid off. Only a refinance has one.
  { key: 'payoff', required: false, whenField: 'is_refinance' },
  // The four that can be on any deal and are nobody's requirement.
  { key: 'buyers_attorney', required: false },
  { key: 'our_attorney', required: false },
  { key: 'realtor', required: false },
  { key: 'appraisal', required: false },
].map((t) => Object.freeze({ ...t, label: orderKinds.VENDOR_KINDS[t.key] })));

// ═══════════════════════════════════════════════════════════════════════════
// PRIOR TO SUBMISSION — everything the file needs before it goes to underwriting.
// ═══════════════════════════════════════════════════════════════════════════

const PRIOR_TO_SUBMISSION = [
  {
    code: 'lt_reo_liabilities',
    bucket: B.SUBMISSION,
    label: 'Mortgages on the credit report — a statement for each',
    hint: 'Read the liabilities off the credit report, mark which are mortgages and which are not, '
      + 'and collect a current statement for every mortgage. A mortgage that is the borrower’s own '
      + 'primary residence can be linked to it instead of uploaded again; anything else needs its '
      + 'own statement against the property it is secured by.',
    borrowerLabel: 'Statements for your other mortgages',
    borrowerHint: 'For every mortgage on your credit report, we need a current statement. If one of '
      + 'them is the home you live in, say so and we will use what we already have.',
    audience: 'both',
    // A DOCUMENT, DELIBERATELY, THOUGH IT IS REALLY A CHOICE. Each mortgage can
    // be answered three ways and `answers.js` intercepts the sign-off gate
    // before the document rules ever run, so this value is inert while that
    // module governs the condition. It is 'document' rather than 'form' because
    // of what happens if that ever stops being true: the gate falls back to
    // asking for the statement, which is the SAFE way to be wrong — chasing a
    // document that was not needed, rather than signing the condition off on
    // nothing at all.
    kind: 'document',
    autoApply: 'always',
    slots: [],
    config: {
      // Read from the mirrored liabilities (`lt_liabilities`). The
      // classification is a HUMAN's: PILOT proposes mortgage-vs-other from the
      // liability type and never decides it, because a mis-classified line
      // either chases a borrower for a statement they do not owe or lets a real
      // mortgage through unasked.
      classify: 'propose_only',
      // THE WAYS ARE NOT LISTED HERE. They live in `answers.js`, which is what
      // the sign-off gate and the door that records an answer both read — a copy
      // here would be a second list free to drift from the one that decides.
      answeredBy: 'answers',
      // A typed address goes through the address lookup so it is stored as a
      // real place rather than free text.
      addressLookup: true,
      // The answer is saved to the SHARED borrower profile so the next loan for
      // the same person starts from it rather than asking again.
      savesToBorrowerProfile: true,
    },
  },
  {
    code: 'lt_vesting_entity',
    bucket: B.SUBMISSION,
    label: 'Vesting entity — formation documents and ownership',
    hint: 'The entity taking title: its articles, its operating agreement or bylaws, its EIN letter '
      + 'and who its members are. Verified once and then verified forever — the entity lives on the '
      + 'borrower’s profile, so a second loan for the same entity starts already done.',
    borrowerLabel: 'Your company’s documents',
    borrowerHint: 'The formation documents for the company taking title, its EIN letter, and who '
      + 'its owners are. If you have given us these before for the same company, they are already on file.',
    audience: 'both',
    kind: 'document',
    autoApply: 'rules',
    // ── "IN AN ENTITY, **OR** WE HAVE NOT BEEN TOLD" ────────────────────────
    //
    // Field 4008 decides and nothing else (owner-directed 2026-08-23, restated
    // 2026-08-31: "if 4008 is individual instead of officer, then no entity
    // condition"). `vests_in_entity` now reads 4008 rather than the parties, so
    // an Individual-vested loan carrying a STALE company name on a borrower row
    // is no longer asked for formation documents it does not need.
    //
    // WHY THE SECOND ARM, AND WHY IT IS NOT A FIELD THAT DEFAULTS. That field
    // answers `null` when Encompass has not said — honestly, because nothing
    // stated is not "Individual" — and `rules.js` turns a blank into FALSE, so a
    // single `is_true` arm would take this condition OFF every unanswered loan
    // (19 of the measured 486, plus every loan not yet read). The owner chose the
    // other direction: keep asking until 4008 positively says Individual. The
    // first shape tried was a new field that returned `true` on a blank, and it
    // was WRONG — it would have had to claim a fact about the title that nobody
    // has told us, which is the one thing this registry's own header forbids.
    // `is_empty` says the same thing without inventing anything, and the settings
    // screen renders it in plain words: "Title is taken in an entity is yes OR
    // Title is taken in an entity is blank".
    rule: whenAny([
      { field: 'vests_in_entity', operator: 'is_true' },
      { field: 'vests_in_entity', operator: 'is_empty' },
    ]),
    slots: [
      { key: 'formation', label: 'Articles of formation', required: true },
      { key: 'agreement', label: 'Operating agreement or bylaws', required: true },
      { key: 'ein', label: 'EIN letter', required: true },
      // OPTIONAL, and that is the point (owner-directed 2026-08-30). A
      // certificate of good standing expires, so requiring one would make every
      // entity go stale on a date nobody is watching; it is asked for where an
      // investor wants it and never holds a file on its own.
      { key: 'good_standing', label: 'Certificate of good standing (optional)', required: false },
    ],
    config: {
      verifiedForever: true,
      savesToBorrowerProfile: true,
      // THE ENTITY IS THE BORROWER'S, NOT THIS LOAN'S. Whatever is already on
      // their profile for this company — the documents and the verified state —
      // is what this condition opens with, so a second loan for the same entity
      // starts finished instead of asking again. `entity-prefill.js` is the one
      // definition; this key is what turns it on.
      readsFromBorrowerProfile: true,
      prefillFromEntity: true,
    },
  },
  {
    code: 'lt_subject_mortgage_statement',
    bucket: B.SUBMISSION,
    label: 'Mortgage statement on the subject property',
    /* THE FCI WAY IS NOT A WAIVER — owner-directed 2026-08-31. It answers the
       SERVICER by itself and still asks for the two numbers, because being the
       servicer is what makes them OBTAINABLE, not unnecessary: the loan-setup
       person still keys a loan number and a balance into Encompass and neither
       of them is on this file. Wording that promised a waiver told somebody the
       opposite of what the screen asks them for.
       PREVIOUS AND FUTURE: this string is COPIED onto each condition when it is
       created, so changing it here reaches a NEW tenant and db/664 reaches every
       file that already exists. Editing one without the other leaves the two
       drifting; section F of the test compares them. */
    hint: 'A current statement on the loan being paid off. Three ways to satisfy it: upload the '
      + 'statement — PILOT reads the servicer, the loan number and the outstanding principal balance '
      + 'off it and fills them in for somebody to check; type those three in yourself — all three, '
      + 'none of them optional; or say it refinances one of our own short-term loans serviced by FCI, '
      + 'which answers the servicer itself and still needs the FCI loan number and the outstanding '
      + 'balance looked up in FCI.',
    borrowerLabel: 'Your current mortgage statement',
    borrowerHint: 'A recent statement for the mortgage on this property.',
    audience: 'both',
    kind: 'document',
    autoApply: 'rules',
    rule: when('is_refinance', 'is_true'),
    slots: [{ key: 'statement', label: 'Mortgage statement', required: false }],
    config: {
      // THE THREE WAYS LIVE IN `answers.js` — the statement, the figures typed
      // in (all three of balance, servicer and loan number, or none: a partial
      // answer reads as a complete one to the person who then has nothing to key
      // in), or the FCI waiver, where we originated the loan and service it so
      // we already hold everything a statement would say. Listing them again
      // here would be a second copy free to drift from the one the gate reads.
      answeredBy: 'answers',
      servicerLookup: true,
    },
  },
  {
    code: 'lt_file_contacts',
    bucket: B.SUBMISSION,
    label: 'File contacts',
    hint: 'The title company and the hazard insurance agent on every file — and, when the deal calls '
      + 'for them, the landlord (the borrower rents where they live), the HOA management company (a '
      + 'condominium) and the settlement agent (a New York file); each of those three is greyed with '
      + 'the reason on a file that does not need it. The attorneys and the realtor live in the File '
      + 'contacts section rather than being asked for here. Picked from the shared vendor directory '
      + 'rather than typed, so the same company is the same record on every file.',
    borrowerLabel: 'Who is handling your closing',
    borrowerHint: 'Your title company and your insurance agent — and your landlord, your condo’s '
      + 'management company or your settlement agent where they apply.',
    audience: 'both',
    kind: 'form',
    autoApply: 'always',
    slots: [],
    config: {
      // THE TWO, AND THE THREE THAT FOLLOW THE DEAL. Owner-directed 2026-08-31:
      // *"The only stuff that should be a condition before submittal is the
      // title company and the hazard insurance agent."* — and 2026-09-02, on
      // this very condition: *"if he's a renter, it should also populate
      // landlord contact … If it's a condo, populate the condo. If it's a New
      // York file, populate the settlement agent."* The three are rule-driven
      // rows on the SAME condition (each carries a `whenField`), so on a deal
      // that needs none of them the condition still asks for exactly the two.
      //
      // The attorneys and the realtor did not go anywhere: they are the FILE
      // CONTACTS desk (`FILE_CONTACT_TYPES` above), which is where an open slot
      // belongs. The difference is what a CONDITION means — a row on the list
      // somebody has to clear before the file moves — and an attorney who may
      // never be appointed is not that.
      //
      // DERIVED, NEVER RETYPED: these are the entries of `FILE_CONTACT_TYPES`
      // marked `preSubmission`, so the desk and the condition can never disagree
      // about what the title company is called or which fact greys a row.
      contactTypes: FILE_CONTACT_TYPES.filter((t) => t.preSubmission)
        .map(({ preSubmission, ...t }) => t),
      // USES the short-term side's vendor directory rather than copying it, so a
      // company corrected once is corrected everywhere. The crossing is recorded
      // in docs/LONG-TERM-AUTHORIZED-COPIES.md before a line of it is written.
      vendorDirectory: 'shared',
    },
  },
  {
    code: 'lt_order_title',
    bucket: B.SUBMISSION,
    label: 'Title ordered',
    hint: 'The title order goes out to the title company on the file, from the officer’s own address, '
      + 'so their reply lands on the file.',
    audience: 'internal',
    kind: 'order',
    autoApply: 'always',
    config: { orderType: 'title', contactType: 'title' },
  },
  {
    code: 'lt_order_insurance',
    bucket: B.SUBMISSION,
    label: 'Insurance ordered',
    hint: 'A quote on a purchase, or verification of the policy in force on a refinance — two '
      + 'different letters for two different questions.',
    audience: 'internal',
    kind: 'order',
    autoApply: 'always',
    config: { orderType: 'insurance', contactType: 'hazard_insurance', variants: ['purchase', 'refinance'] },
  },
  {
    code: 'lt_order_flood_insurance',
    bucket: B.SUBMISSION,
    label: 'Flood insurance ordered',
    hint: 'Only where the property is in a flood zone. Until the determination has been read, this '
      + 'condition does not attach — an unread file has not been determined to be outside a flood '
      + 'zone, it has not been determined at all.',
    audience: 'internal',
    kind: 'order',
    autoApply: 'rules',
    rule: when('in_flood_zone', 'is_true'),
    config: { orderType: 'flood_insurance', contactType: 'flood_insurance' },
  },
  {
    code: 'lt_order_ny_settlement_agent',
    bucket: B.SUBMISSION,
    label: 'New York settlement agent ordered',
    hint: 'New York closes through a settlement agent rather than the title company, so the order '
      + 'goes to them.',
    audience: 'internal',
    kind: 'order',
    autoApply: 'rules',
    rule: when('is_new_york', 'is_true'),
    config: { orderType: 'ny_settlement_agent', contactType: 'ny_settlement_agent' },
  },
  {
    code: 'lt_appraisal_card',
    bucket: B.SUBMISSION,
    label: 'Card on file for the appraisal',
    hint: 'The card the appraisal is charged to. It is held on the borrower’s shared profile, so a '
      + 'card given on one loan is already here on the next — and a card added here goes back to the '
      + 'profile the same way.',
    borrowerLabel: 'A card for the appraisal',
    borrowerHint: 'The appraisal is paid for up front. If you have given us a card before, it is already on file.',
    audience: 'both',
    kind: 'form',
    autoApply: 'always',
    config: { savesToBorrowerProfile: true, readsFromBorrowerProfile: true },
  },
  {
    code: 'lt_vor_sent',
    bucket: B.SUBMISSION,
    label: 'Verification of rent sent',
    hint: 'The form is filled in from what we already know — the property, the borrower, the rent, '
      + 'our own details — and every part the landlord has to answer is left blank and required. It '
      + 'can go by DocuSign, as an email attachment, or both; a form that comes back filled in by '
      + 'hand voids the envelope so there is never a second, half-signed copy in flight.',
    audience: 'internal',
    kind: 'esign',
    autoApply: 'rules',
    rule: when('borrower_rents', 'is_true'),
    // `orderType` names the order the ORDERS DESK places for this condition, and
    // `kind` stays 'esign' because the thing that goes out is an envelope: the two
    // are different facts about one step. Without the orderType the desk and the
    // condition would each know about the other in one direction only, which is how
    // a button ends up on a screen with nothing behind it.
    config: {
      form: 'vor', orderType: 'vor', contactType: 'landlord',
      // THE TWO TENANCY FACTS MOVED HERE (db/660). They were collected on a
      // separate "Landlord's contact details" condition, which the owner asked to
      // retire — *"You can technically remove that condition … You should also be
      // able to fill it directly on the verification of rent condition and the
      // entire verification of rent sent as well."* They are facts about the
      // TENANCY rather than about the landlord, the form cannot be built without
      // them, and this is the step that builds it — so they belong on the step
      // that uses them rather than on a row somebody clears first. The LANDLORD
      // themself is a contact and lives where every other contact does: the File
      // contacts desk, which `contactType` above already addresses.
      fields: ['monthly_rent', 'rented_since'],
      send: ['docusign', 'email', 'both'], manualReturnVoidsEnvelope: true,
    },
  },
  {
    code: 'lt_photo_id',
    bucket: B.SUBMISSION,
    label: 'Government photo ID',
    hint: 'Held on the borrower’s shared profile, so an ID given on any previous loan is already here.',
    borrowerLabel: 'Your photo ID',
    borrowerHint: 'A driver’s licence or passport. If you have given us one before, it is already on file.',
    audience: 'both',
    kind: 'document',
    autoApply: 'always',
    slots: [{ key: 'id', label: 'Photo ID', required: true }],
    config: { readsFromBorrowerProfile: true, savesToBorrowerProfile: true },
  },
  {
    code: 'lt_payoff_ordered',
    bucket: B.SUBMISSION,
    label: 'Payoff ordered',
    hint: 'Requested from the servicer of the loan being paid off.',
    audience: 'internal',
    kind: 'order',
    autoApply: 'rules',
    rule: when('is_refinance', 'is_true'),
    config: { orderType: 'payoff' },
  },
  /* `lt_hoa_contact` — the stand-alone "HOA management company" condition —
     was RETIRED by db/674 (owner-directed 2026-09-02: the HOA is asked for on
     the file-contacts condition itself, greyed unless the property is a condo).
     It was the same `hoa` vendor row asked for twice; the row lives on, on the
     File contacts desk and on `lt_file_contacts`. Retired the way db/660
     retired the landlord and payoff-servicer conditions: out of this library,
     inactive on disk, and the engine takes an untouched instance off each file
     while a worked one stays. */
  {
    code: 'lt_condo_questionnaire_ordered',
    bucket: B.SUBMISSION,
    label: 'Condo questionnaire ordered',
    hint: 'Sent to the management company on the file.',
    audience: 'internal',
    kind: 'order',
    autoApply: 'rules',
    rule: when('is_condo', 'is_true'),
    config: { orderType: 'condo_questionnaire', contactType: 'hoa' },
  },
  {
    code: 'lt_purchase_contract',
    bucket: B.SUBMISSION,
    label: 'Purchase contract',
    hint: 'The fully executed contract, with every rider and amendment.',
    borrowerLabel: 'Your signed purchase contract',
    borrowerHint: 'The fully signed contract, including anything attached to it.',
    audience: 'both',
    kind: 'document',
    autoApply: 'rules',
    rule: when('is_purchase', 'is_true'),
    slots: [{ key: 'contract', label: 'Executed contract', required: true }],
  },
];

// ═══════════════════════════════════════════════════════════════════════════
// PRIOR TO CLEAR TO CLOSE — what underwriting needs back.
// ═══════════════════════════════════════════════════════════════════════════

const PRIOR_TO_CTC = [
  {
    code: 'lt_cash_out_letter',
    bucket: B.CTC,
    // PRIOR TO CLEAR TO CLOSE, not prior to submittal (owner-directed
    // 2026-08-30). The letter says what the borrower will DO with the money,
    // which is a question for the investor reading the file before it closes —
    // holding a file out of underwriting for it would delay every cash-out
    // refinance for a document that changes nothing about whether it can be
    // underwritten.
    label: 'Cash-out letter',
    hint: 'What the money is for, in the borrower’s own words and signed by them.',
    borrowerLabel: 'A letter about what the cash is for',
    borrowerHint: 'A short signed note saying what you plan to do with the money you are taking out.',
    audience: 'both',
    kind: 'document',
    autoApply: 'rules',
    rule: when('is_cash_out', 'is_true'),
    slots: [{ key: 'letter', label: 'Cash-out letter', required: true }],
  },
  {
    code: 'lt_title_docs',
    bucket: B.CTC,
    label: 'Title documents',
    hint: 'The title package. New York asks for less of it — there is no closing protection letter, '
      + 'no preliminary settlement statement and no wiring instructions there, because the settlement '
      + 'agent handles all three — so a New York file is not left holding slots nobody can ever fill.',
    audience: 'internal',
    kind: 'document',
    autoApply: 'always',
    /* THE NEW YORK CUT IS THE SHARED TITLE LETTER'S (`lib/order-email.js`
       NY_TITLE_CUT): the CPL, the wiring instructions, the preliminary statement
       and the settlement agent's E&O all leave a New York title ask. The wiring
       instructions stayed REQUIRED here on New York until 2026-09-02 (audit S4),
       so a New York file held a required slot the title company was never asked
       to fill. The settlement agent is asked instead (`lt_ny_settlement_docs`). */
    slots: [
      { key: 'commitment', label: 'Title commitment', required: true },
      { key: 'cpl', label: 'Closing protection letter', required: true, notWhenField: 'is_new_york' },
      { key: 'prelim_settlement', label: 'Preliminary settlement statement', required: true, notWhenField: 'is_new_york' },
      { key: 'wire_instructions', label: 'Wire instructions', required: true, notWhenField: 'is_new_york' },
      { key: 'invoice', label: 'Title invoice', required: false },
    ],
  },
  {
    code: 'lt_ny_settlement_docs',
    bucket: B.CTC,
    label: 'Settlement agent documents',
    hint: 'New York only — what the settlement agent provides in place of the title company’s own '
      + 'closing package.',
    audience: 'internal',
    kind: 'document',
    autoApply: 'rules',
    rule: when('is_new_york', 'is_true'),
    /* THERE IS NO CLOSING PROTECTION LETTER IN NEW YORK — OWNER-CORRECTED
       2026-09-02: *"In NY, there is no CPL. We only ask them for their Errors
       and Omissions Assurance."* db/677 had added a `cpl` slot here, taken from
       the New York rule in docs/longterm/OWNER-ORDER-DRAFTS.md, which said the
       CPL moved from title onto this order. It does not move — it does not
       exist there — so that draft was WRONG and is corrected at the source, or
       the next reader restores the slot from it. What DOES come from the
       settlement agent rather than from title is the E&O.
       A CPL slot on a New York file is a slot nobody can ever fill, which is
       the exact failure `lt_title_docs`'s own `notWhenField` guards against.
       db/680 removes it from the templates and items db/677 already seeded.
       `orders/kinds.js` asks for the same list.

       NO ENGAGEMENT LETTER EITHER — owner, 2026-09-02, asked directly and
       answering item by item: *"Errors & Omissions insurance and also the
       preliminary settlement statement, not for engagement letter, but yes for
       wire instructions."* So the New York settlement agent is asked for
       exactly three things, and db/681 takes the engagement letter off the rows
       db/677 seeded. It was never the owner's ask — it predates the New York
       work and was carried forward unexamined. */
    slots: [
      { key: 'wire_instructions', label: 'Wire instructions', required: true },
      { key: 'eo', label: 'Settlement agent E&O insurance', required: true },
      { key: 'settlement_statement', label: 'Preliminary settlement statement', required: true },
    ],
  },
  {
    code: 'lt_insurance_docs',
    bucket: B.CTC,
    label: 'Insurance documents',
    hint: 'The binder or the declarations page, and the invoice or evidence that it is paid. Two '
      + 'slots because they are two different things: one says the cover exists, the other says it '
      + 'is paid for.',
    audience: 'internal',
    kind: 'document',
    autoApply: 'always',
    slots: [
      { key: 'binder', label: 'Binder or declarations page', required: true },
      { key: 'invoice', label: 'Invoice or evidence of payment', required: true },
    ],
  },
  {
    code: 'lt_flood_insurance_docs',
    bucket: B.CTC,
    label: 'Flood insurance documents',
    hint: 'Only where the property is in a flood zone.',
    audience: 'internal',
    kind: 'document',
    autoApply: 'rules',
    rule: when('in_flood_zone', 'is_true'),
    slots: [
      { key: 'binder', label: 'Flood binder or declarations page', required: true },
      { key: 'invoice', label: 'Invoice or evidence of payment', required: true },
    ],
  },
  {
    code: 'lt_housing_history',
    bucket: B.CTC,
    label: 'Housing history verified',
    /* THREE WAYS TO ANSWER ONE QUESTION, AND THE FILE PICKS — owner-directed
       2026-08-31: *"If he is renting, then the housing history verified condition
       is tied directly to the verification of rent order and gets the documents
       from there. You can either upload it manually as well, but it's tied
       directly and populated by himself. If he is owning, then that housing
       history verified should have a note that it is a verification of mortgage
       of primary residence. If he is living rent-free, then the housing history
       verified should be the rent-free letter."*

       The RENT branch is fed by the verification-of-rent order (orders/kinds.js
       `vor.docCondition` names this condition and its `slotMap` names the slot),
       so a completed form that comes back by reply files itself. The other two
       are uploaded, and so is a rent verification that arrives some other way —
       "tied directly" adds a route, it never closes the manual one. */
    hint: 'One of three, decided by what the borrower said about where they live (FR0115): the rent '
      + 'verification back from the landlord if they rent, a verification of mortgage on the home they '
      + 'live in if they own it, or a letter if they live somewhere rent free. They are alternatives, not '
      + 'a list — asking for all three would be asking for two things that cannot exist. The rent one '
      + 'fills itself in from the verification of rent order; any of the three can also be uploaded here.',
    audience: 'internal',
    kind: 'document',
    autoApply: 'always',
    slots: [
      { key: 'vor', label: 'Verification of rent (completed)', required: false, whenField: 'borrower_rents',
        hint: 'Comes back on the verification of rent order and files itself here. It can also be uploaded.' },
      // THE OWNER ASKED FOR THIS TO SAY PRIMARY RESIDENCE, in those words. The
      // file already carries a `lt_vom_subject` for the SUBJECT property on a
      // refinance, and two conditions both called "verification of mortgage" with
      // nothing saying which house is how the wrong one gets uploaded.
      { key: 'vom_primary', label: 'Verification of mortgage — primary residence', required: false, whenField: 'borrower_owns_home',
        hint: 'The home the borrower LIVES in, not the subject property — the subject property has its own verification of mortgage on this file.' },
      // Worded "Written by" rather than "From" on purpose: the separation gate
      // reads `FROM <word>` in a Long-Term file as a Long-Term module querying
      // an RTL table, so ordinary prose in that shape fails the build.
      { key: 'rent_free_letter', label: 'Living rent free letter', required: false, whenField: 'borrower_lives_rent_free',
        hint: 'Written by whoever they live with, confirming the borrower pays no rent.' },
    ],
    config: { oneOf: true },
  },
  {
    code: 'lt_vom_subject',
    bucket: B.CTC,
    label: 'Verification of mortgage — the subject property',
    hint: 'On a refinance: the payment history on the loan being paid off.',
    audience: 'internal',
    kind: 'document',
    autoApply: 'rules',
    rule: when('is_refinance', 'is_true'),
    slots: [{ key: 'vom', label: 'Verification of mortgage', required: true }],
  },
  {
    code: 'lt_lease_agreement',
    bucket: B.CTC,
    label: 'Lease agreement',
    hint: 'On a refinance of a property that is already rented: the lease the rent is coming from.',
    borrowerLabel: 'The lease on the property',
    borrowerHint: 'The signed lease for the property you are refinancing.',
    audience: 'both',
    kind: 'document',
    autoApply: 'rules',
    rule: when('is_refinance', 'is_true'),
    slots: [{ key: 'lease', label: 'Lease agreement', required: true }],
  },
  {
    code: 'lt_cash_to_close',
    bucket: B.CTC,
    label: 'Cash to close',
    hint: 'On a purchase: proof the borrower holds what they have to bring to the table.',
    borrowerLabel: 'Proof of the money for closing',
    borrowerHint: 'Statements showing the funds you are bringing to closing.',
    audience: 'both',
    kind: 'document',
    autoApply: 'rules',
    rule: when('is_purchase', 'is_true'),
    slots: [{ key: 'statements', label: 'Bank statements', required: true }],
  },
  {
    code: 'lt_emd',
    bucket: B.CTC,
    label: 'Earnest money deposit',
    hint: 'On a purchase: evidence the deposit was actually paid — the cleared cheque or the wire, '
      + 'not the contract that says it was due.',
    borrowerLabel: 'Proof your deposit was paid',
    borrowerHint: 'The cleared cheque or the wire confirmation for your deposit.',
    audience: 'both',
    kind: 'document',
    autoApply: 'rules',
    rule: when('is_purchase', 'is_true'),
    slots: [{ key: 'emd', label: 'Evidence of the deposit', required: true }],
  },
  {
    code: 'lt_payoff_received',
    bucket: B.CTC,
    label: 'Payoff received',
    /* FED BY THE PAYOFF ORDER — owner-directed 2026-08-31: *"The payoff received
       should be tied directly to the payoff order, and you should also be able to
       upload manually."* `orders/kinds.js payoff.docCondition` names this
       condition and its `slotMap` names the slot below, so a statement that comes
       back by reply files itself; the slot stays an ordinary upload for a payoff
       that arrives any other way. */
    hint: 'The statement back from the servicer, still good on the closing date. It files itself in from '
      + 'the payoff order, and can also be uploaded here.',
    audience: 'internal',
    kind: 'document',
    autoApply: 'rules',
    rule: when('is_refinance', 'is_true'),
    slots: [{ key: 'payoff', label: 'Payoff statement', required: true,
      hint: 'Comes back on the payoff order and files itself here. It can also be uploaded.' }],
  },
  {
    code: 'lt_condo_docs',
    bucket: B.CTC,
    label: 'Condo documents',
    hint: 'The completed questionnaire, the association’s current budget, the bylaws, and its master insurance.',
    audience: 'internal',
    kind: 'document',
    autoApply: 'rules',
    rule: when('is_condo', 'is_true'),
    /* ONE LIST WITH THE ORDER'S `wants` (orders/kinds.js condo_questionnaire).
       What we ASK the association for and what we have a place to PUT are the
       same four things, or a document arrives with nowhere to file it and the
       condition can never read as complete. The bylaws were asked for in the
       owner's original brief and were dropped on the first build. */
    slots: [
      { key: 'questionnaire', label: 'Condo questionnaire (completed)', required: true },
      { key: 'budget', label: 'Association budget', required: true },
      { key: 'bylaws', label: 'Bylaws', required: true },
      { key: 'master_insurance', label: 'Master insurance policy', required: true },
    ],
  },
];

/**
 * The whole library, in order, with the sort positions filled in.
 *
 * The order is the order the owner dictated them in, which is the order the work
 * actually happens in — so a condition's position on the screen is a decision
 * that was made once, here, rather than by whatever the database returns.
 */
function library() {
  const out = [];
  let n = 0;
  for (const c of [...PRIOR_TO_SUBMISSION, ...PRIOR_TO_CTC]) {
    n += 10;
    out.push({
      code: c.code,
      bucketKey: c.bucket,
      label: c.label,
      hint: c.hint || null,
      borrowerLabel: c.borrowerLabel || null,
      borrowerHint: c.borrowerHint || null,
      audience: c.audience || 'internal',
      kind: c.kind || 'document',
      autoApply: c.autoApply || 'manual',
      ruleLogic: c.rule || null,
      isRequired: c.isRequired !== false,
      slots: c.slots || [],
      config: c.config || {},
      isEnabled: c.enabled !== false,
      disabledReason: c.disabledReason || null,
      sortOrder: n,
    });
  }
  return out;
}

/**
 * Prove the library is internally sound, WITHOUT a database.
 *
 * This is what makes it safe for the rules to live in JavaScript: every rule is
 * run through the real validator against the real field registry, so a rule
 * naming a field that does not exist fails the test suite rather than silently
 * never attaching to a file. It also catches the two mistakes that are invisible
 * at a glance — a duplicate code (the unique index would refuse the second, and
 * the seed would report success) and a borrower-facing condition with no
 * borrower wording (which the engine downgrades to staff-only, correctly and
 * silently).
 *
 * @returns {{ok, problems:[{code, problem}]}}
 */
function verify(accepted) {
  const fields = registry.fieldMap();
  const problems = [];
  const seen = new Set();

  // EVERY VALUE THIS LIBRARY WILL EMIT, CHECKED AGAINST THE COLUMN THAT HAS TO
  // TAKE IT. This is the half that makes a mapped value fail the BUILD rather
  // than a loan file: `seed()` calls this with the sets read live out of
  // pg_constraint, the pure test calls it with none and gets the declared sets,
  // and either way a bucket or an audience the database would refuse stops the
  // seed before a single INSERT is attempted.
  for (const p of vocab.constraintProblems(accepted || {})) {
    problems.push({ code: '(vocabulary)', problem: `${p.what} maps to "${p.value}", which ${p.problem}` });
  }

  for (const c of library()) {
    if (seen.has(c.code)) problems.push({ code: c.code, problem: 'two conditions share this code' });
    seen.add(c.code);

    if (!Object.values(B).includes(c.bucketKey)) {
      problems.push({ code: c.code, problem: `unknown bucket "${c.bucketKey}"` });
    }
    // A WORD THE TRANSLATION DOES NOT KNOW IS NOT A TYPO IT CAN ABSORB. Every
    // mapper in vocabulary.js fails CLOSED — an unknown audience becomes
    // staff-only, an unknown kind becomes a document — which is the right
    // posture at RUNTIME and exactly the wrong one HERE: a misspelling would
    // seed quietly under the safe fallback and nobody would ever be told.
    if (!Object.prototype.hasOwnProperty.call(vocab.AUDIENCE_TO_SHARED, c.audience)) {
      problems.push({ code: c.code, problem: `unknown audience "${c.audience}"` });
    }
    if (!Object.prototype.hasOwnProperty.call(vocab.KIND_TO_ITEM_KIND, c.kind)) {
      problems.push({ code: c.code, problem: `unknown kind "${c.kind}"` });
    }
    if (c.autoApply === 'rules' && !c.ruleLogic) {
      problems.push({ code: c.code, problem: 'says it applies by rule and carries no rule' });
    }
    if (c.autoApply === 'always' && c.ruleLogic) {
      problems.push({ code: c.code, problem: 'applies to every file and also carries a rule, which would never be read' });
    }
    if (c.ruleLogic) {
      const v = rules.validateRule(c.ruleLogic, fields);
      for (const p of v.problems) problems.push({ code: c.code, problem: `${p.reason}: ${p.detail || ''}`.trim() });
    }
    if (c.audience !== 'internal' && !c.borrowerLabel) {
      problems.push({ code: c.code, problem: 'is borrower-facing but has no borrower wording, so it would be applied staff-only' });
    }
    if (c.audience === 'internal' && c.borrowerLabel) {
      problems.push({ code: c.code, problem: 'is internal but carries borrower wording nobody will ever read' });
    }
    // A slot that points at a rule field must point at one that exists, or the
    // form silently shows or hides the wrong thing.
    for (const s of c.slots || []) {
      for (const k of ['whenField', 'notWhenField']) {
        if (s[k] && !fields[s[k]]) problems.push({ code: c.code, problem: `slot "${s.key}" ${k} names an unknown field "${s[k]}"` });
      }
    }
    for (const ct of (c.config && c.config.contactTypes) || []) {
      if (ct.whenField && !fields[ct.whenField]) {
        problems.push({ code: c.code, problem: `contact "${ct.key}" whenField names an unknown field "${ct.whenField}"` });
      }
    }
  }
  return { ok: problems.length === 0, problems };
}

/**
 * Put the library into the database, ONCE — as `checklist_templates` rows in the
 * ONE Condition Center, `scope='lt_loan'`.
 *
 * ── THE WORDING IS THIS FILE'S. THE VOCABULARY IS THE SHARED TABLE'S ────────
 *
 * Every LABEL, HINT, borrower sentence and RULE below is the owner's own and is
 * written verbatim. What is TRANSLATED on the way in is only the handful of
 * enumerated words the shared columns constrain — the audience, the bucket, the
 * kind — through `vocabulary.js`, which is also what the read inverts. db/653
 * says why that is a MAP rather than a widening of the CHECKs; the short version
 * is that two dialects in one column is not one Condition Center.
 *
 * `ON CONFLICT (code) DO NOTHING`, so a buyer's own edit to a row — its wording,
 * its rule, whether it applies at all — survives every redeploy. This function
 * fills the library; it never rewrites it. The codes are all `lt_*`, and
 * `checklist_templates.code` is UNIQUE ACROSS BOTH PRODUCTS, so a collision with
 * an `rtl_*` template is impossible by naming.
 *
 * NEVER THROWS. It runs on first use, and a failed seed must leave the library
 * exactly as it found it. What it could not do is reported.
 */
async function seed(client) {
  // THE LIVE CONSTRAINTS ARE READ FIRST, AND `verify()` IS RUN AGAINST THEM.
  // The declared sets in vocabulary.js are a copy, and a copy nothing checks is
  // the copy that drifts: if a migration lands tomorrow that narrows one of
  // these columns, this is where it is caught — before any INSERT — rather than
  // as a check-violation on somebody's loan file. An unreadable catalogue falls
  // back to the declared sets, so a permissions quirk degrades to the pure check
  // instead of refusing to seed for the wrong reason.
  const accepted = await vocab.liveAccepted(client);
  const out = { inserted: 0, skipped: 0, failed: [], verified: verify(accepted) };
  // REFUSE TO SEED A LIBRARY THAT DOES NOT VERIFY. A rule naming a field that
  // does not exist would sit in the database attaching to nothing, which reads
  // exactly like a condition nobody needs — and a value the column will refuse
  // would fail one INSERT at a time, leaving a HALF-SEEDED library.
  if (!out.verified.ok) return out;

  for (const c of library()) {
    try {
      const { item_kind, tool_key } = vocab.kindToShared(c.kind);
      const { rows } = await client.query(
        `INSERT INTO checklist_templates
           (code, scope, label, hint, borrower_label, borrower_hint,
            audience, item_kind, tool_key, category, auto_apply, rule_logic,
            is_required, slots, config, sort_order, is_active, origin)
         VALUES ($1, 'lt_loan', $2, $3, $4, $5,
                 $6, $7, $8, $9, $10, $11::jsonb,
                 $12, $13::jsonb, $14::jsonb, $15, true, 'system')
         ON CONFLICT (code) DO NOTHING
         RETURNING code`,
        [c.code, c.label, c.hint, c.borrowerLabel, c.borrowerHint,
          vocab.audienceToShared(c.audience), item_kind, tool_key,
          vocab.categoryOf(c.bucketKey), c.autoApply,
          c.ruleLogic ? JSON.stringify(c.ruleLogic) : null,
          c.isRequired, JSON.stringify(c.slots),
          // `enabled` + `disabledReason` ride INSIDE config rather than taking
          // `is_active`. They are two different facts: `is_active=false` retires
          // a template from the library, while `enabled:false` means BUILT BUT
          // SWITCHED OFF — it still shows on the file, greyed, WITH ITS REASON,
          // so nobody thinks a feature vanished. Collapsing them would lose the
          // reason and hide the condition.
          JSON.stringify({ ...(c.config || {}), enabled: c.isEnabled, disabledReason: c.disabledReason || null }),
          c.sortOrder],
      );
      if (rows.length) out.inserted += 1; else out.skipped += 1;
    } catch (e) {
      out.failed.push({ code: c.code, why: String((e && e.message) || e).slice(0, 200) });
    }
  }
  return out;
}

/**
 * SEED IT ONCE PER PROCESS, ON FIRST USE.
 *
 * WHY NOT AT BOOT. A boot task runs before the migrations it depends on have
 * necessarily finished, and a seed that raced db/643 would log a table-not-found
 * and leave the library empty until somebody noticed. WHY NOT IN THE MIGRATION:
 * the rules would then live in SQL, where nothing can check that the field keys
 * they name exist (this file's own header).
 *
 * So it runs the first time anything ASKS for the library — the engine before it
 * evaluates a file, or the settings screen before it draws one. By then the
 * migrations have run, because the request they arrived on did.
 *
 * MEMOIZED ON THE PROMISE, not on a boolean set afterwards: two requests landing
 * together must await the SAME seed rather than both running one. NEVER THROWS —
 * a failed seed leaves the library as it found it and the caller carries on with
 * whatever is there, which on a redeploy is everything.
 */
let seedPromise = null;

function ensureSeeded(client) {
  if (!seedPromise) {
    seedPromise = seed(client)
      .then((out) => {
        if (out.inserted) console.log('[lt-conditions] library seeded: %d added, %d already there', out.inserted, out.skipped);
        if (out.failed.length) console.error('[lt-conditions] %d condition(s) could not be seeded:', out.failed.length, out.failed);
        if (!out.verified.ok) console.error('[lt-conditions] the library does not verify, so nothing was seeded:', out.verified.problems);
        return out;
      })
      .catch((e) => {
        // NOT remembered as done. A seed that failed because the table was not
        // there yet must be retried on the next request, not written off for the
        // life of the process.
        seedPromise = null;
        console.error('[lt-conditions] library seed failed:', (e && e.message) || e);
        return { inserted: 0, skipped: 0, failed: [], verified: { ok: false, problems: [] } };
      });
  }
  return seedPromise;
}

/** For tests: forget that the seed ran, so the next call re-runs it. */
function _resetSeed() { seedPromise = null; }

module.exports = { BUCKETS: B, FILE_CONTACT_TYPES, PRIOR_TO_SUBMISSION, PRIOR_TO_CTC, library, verify, seed, ensureSeeded, _resetSeed };
