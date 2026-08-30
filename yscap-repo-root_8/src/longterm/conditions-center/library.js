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
 * turning it on is a settings change rather than a release. Today that is
 * appraisal ordering, which the owner asked for explicitly: *"grayed out"*.
 *
 * PURE apart from `seed()`, which is the one function that touches a database.
 */

const rules = require('./rules');
const registry = require('./field-registry');

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
    kind: 'form',
    autoApply: 'always',
    slots: [],
    config: {
      // Read from the mirrored liabilities. The classification is a HUMAN's:
      // PILOT proposes mortgage-vs-other from the liability type and never
      // decides it, because a mis-classified line either chases a borrower for a
      // statement they do not owe or lets a real mortgage through unasked.
      classify: 'propose_only',
      // The three ways one line can be answered, exactly as the owner described.
      answers: ['upload_statement', 'linked_to_primary', 'typed_address'],
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
    rule: when('vests_in_entity', 'is_true'),
    slots: [
      { key: 'formation', label: 'Articles of formation', required: true },
      { key: 'agreement', label: 'Operating agreement or bylaws', required: true },
      { key: 'ein', label: 'EIN letter', required: true },
    ],
    config: { verifiedForever: true, savesToBorrowerProfile: true },
  },
  {
    code: 'lt_subject_mortgage_statement',
    bucket: B.SUBMISSION,
    label: 'Mortgage statement on the subject property',
    hint: 'A current statement on the loan being paid off. Three ways to satisfy it: the statement '
      + 'itself; the payoff figures typed in — outstanding balance, servicer AND loan number, all '
      + 'three, none of them optional; or a waiver where the loan being refinanced is one of our own '
      + 'short-term loans serviced by FCI, where we already hold everything a statement would say.',
    borrowerLabel: 'Your current mortgage statement',
    borrowerHint: 'A recent statement for the mortgage on this property.',
    audience: 'both',
    kind: 'document',
    autoApply: 'rules',
    rule: when('is_refinance', 'is_true'),
    slots: [{ key: 'statement', label: 'Mortgage statement', required: false }],
    config: {
      // ALL THREE OR NONE. A payoff figure with no servicer, or a servicer with
      // no loan number, is not a substitute for a statement — it is a partial
      // answer that reads as a complete one.
      typedFields: ['outstanding_balance', 'servicer', 'loan_number'],
      typedRequiresAll: true,
      waiver: { key: 'rtl_fci_serviced', label: 'This refinances one of our own short-term loans, serviced by FCI' },
    },
  },
  {
    code: 'lt_file_contacts',
    bucket: B.SUBMISSION,
    label: 'File contacts',
    hint: 'Who is on this closing: title, hazard insurance, flood insurance, the buyer’s attorney, '
      + 'the realtor, our attorney, and — in New York — the settlement agent. Picked from the shared '
      + 'vendor directory rather than typed, so the same company is the same record on every file.',
    borrowerLabel: 'Who is handling your closing',
    borrowerHint: 'Your title company, your insurance agent, your attorney and your realtor.',
    audience: 'both',
    kind: 'form',
    autoApply: 'always',
    slots: [],
    config: {
      // The contact TYPES. The New York one only asks when the property is
      // there, which the rule engine cannot express per-slot, so the form does
      // it from the same `is_new_york` field a rule would use.
      contactTypes: [
        { key: 'title', label: 'Title company', required: true },
        { key: 'hazard_insurance', label: 'Hazard insurance agent', required: true },
        { key: 'flood_insurance', label: 'Flood insurance agent', required: false, whenField: 'in_flood_zone' },
        { key: 'buyers_attorney', label: 'Buyer’s attorney', required: false },
        { key: 'realtor', label: 'Realtor', required: false },
        { key: 'our_attorney', label: 'Our attorney', required: false },
        { key: 'ny_settlement_agent', label: 'Settlement agent', required: false, whenField: 'is_new_york' },
      ],
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
    code: 'lt_order_appraisal',
    bucket: B.SUBMISSION,
    label: 'Appraisal ordered',
    hint: 'Ordered from NAN. Which form is ordered follows the property: one form for a single '
      + 'family, another for two-to-four units, another for five and above, another for a condo — '
      + 'each set in this condition’s own settings rather than in code.',
    audience: 'internal',
    kind: 'order',
    autoApply: 'always',
    // SHIPPED SWITCHED OFF, at the owner's own instruction ("grayed out"). It
    // shows on the file with this reason rather than being hidden, so nobody
    // thinks it is missing.
    enabled: false,
    disabledReason: 'Appraisal ordering is built and switched off. Turning it on is a settings change, not a new release.',
    config: {
      orderType: 'appraisal',
      vendor: 'nan',
      // The owner's four cases. A property type that matches none of them falls
      // to `default` rather than guessing a form.
      forms: {
        sfr: '1004',
        multi_2_4: '1025',
        multi_5_plus: 'narrative',
        condo: '1073',
        default: '1004',
      },
      // Every rental-exit long-term loan wants the rent schedule beside the
      // appraisal; it is a setting so a buyer who does not can turn it off.
      rentSchedule: { sfr: '1007', multi_2_4: '216' },
    },
  },
  {
    code: 'lt_landlord_contact',
    bucket: B.SUBMISSION,
    label: 'Landlord’s contact details',
    hint: 'Only where the borrower rents where they live (Encompass field FR0115). This is what the '
      + 'verification of rent is sent to, so it is collected before the form is built.',
    borrowerLabel: 'Your landlord’s contact details',
    borrowerHint: 'Their name, email and phone number. We send them a short form to confirm your rent.',
    audience: 'both',
    kind: 'form',
    autoApply: 'rules',
    rule: when('borrower_rents', 'is_true'),
    config: { fields: ['landlord_name', 'landlord_email', 'landlord_phone', 'monthly_rent', 'rented_since'] },
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
  {
    code: 'lt_hoa_contact',
    bucket: B.SUBMISSION,
    label: 'HOA management company',
    hint: 'Only on a condo. The questionnaire goes to whoever manages the association, so their '
      + 'details are collected first.',
    borrowerLabel: 'Who manages the condo association',
    borrowerHint: 'The management company’s name, email and phone number.',
    audience: 'both',
    kind: 'form',
    autoApply: 'rules',
    rule: when('is_condo', 'is_true'),
    config: { fields: ['management_company', 'contact_name', 'contact_email', 'contact_phone'] },
  },
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
  {
    code: 'lt_cash_out_letter',
    bucket: B.SUBMISSION,
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
];

// ═══════════════════════════════════════════════════════════════════════════
// PRIOR TO CLEAR TO CLOSE — what underwriting needs back.
// ═══════════════════════════════════════════════════════════════════════════

const PRIOR_TO_CTC = [
  {
    code: 'lt_title_docs',
    bucket: B.CTC,
    label: 'Title documents',
    hint: 'The title package. New York asks for less of it — there is no closing protection letter '
      + 'and no preliminary settlement statement there, because the settlement agent handles both — '
      + 'so a New York file is not left holding two slots nobody can ever fill.',
    audience: 'internal',
    kind: 'document',
    autoApply: 'always',
    slots: [
      { key: 'commitment', label: 'Title commitment', required: true },
      { key: 'cpl', label: 'Closing protection letter', required: true, notWhenField: 'is_new_york' },
      { key: 'prelim_settlement', label: 'Preliminary settlement statement', required: true, notWhenField: 'is_new_york' },
      { key: 'wire_instructions', label: 'Wire instructions', required: true },
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
    slots: [
      { key: 'engagement', label: 'Engagement letter', required: true },
      { key: 'wire_instructions', label: 'Wire instructions', required: true },
      { key: 'settlement_statement', label: 'Settlement statement', required: true },
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
    hint: 'One of three, decided by what the borrower said about where they live (FR0115): the rent '
      + 'verification back from the landlord if they rent, a mortgage verification on their own home '
      + 'if they own it, or a letter if they live somewhere rent free. They are alternatives, not a '
      + 'list — asking for all three would be asking for two things that cannot exist.',
    audience: 'internal',
    kind: 'document',
    autoApply: 'always',
    slots: [
      { key: 'vor', label: 'Verification of rent (completed)', required: false, whenField: 'borrower_rents' },
      { key: 'vom_primary', label: 'Verification of mortgage — their own home', required: false, whenField: 'borrower_owns_home' },
      { key: 'rent_free_letter', label: 'Living rent free letter', required: false, whenField: 'borrower_lives_rent_free' },
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
    hint: 'The statement back from the servicer, still good on the closing date.',
    audience: 'internal',
    kind: 'document',
    autoApply: 'rules',
    rule: when('is_refinance', 'is_true'),
    slots: [{ key: 'payoff', label: 'Payoff statement', required: true }],
  },
  {
    code: 'lt_condo_docs',
    bucket: B.CTC,
    label: 'Condo documents',
    hint: 'The completed questionnaire, the association’s master insurance, and its budget.',
    audience: 'internal',
    kind: 'document',
    autoApply: 'rules',
    rule: when('is_condo', 'is_true'),
    slots: [
      { key: 'questionnaire', label: 'Condo questionnaire (completed)', required: true },
      { key: 'master_insurance', label: 'Master insurance policy', required: true },
      { key: 'budget', label: 'Association budget', required: false },
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
function verify() {
  const fields = registry.fieldMap();
  const problems = [];
  const seen = new Set();

  for (const c of library()) {
    if (seen.has(c.code)) problems.push({ code: c.code, problem: 'two conditions share this code' });
    seen.add(c.code);

    if (!Object.values(B).includes(c.bucketKey)) {
      problems.push({ code: c.code, problem: `unknown bucket "${c.bucketKey}"` });
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
 * Put the library into the database, ONCE.
 *
 * `ON CONFLICT (code) DO NOTHING`, so a buyer's own edit to a row — its wording,
 * its rule, whether it applies at all — survives every redeploy. This function
 * fills the library; it never rewrites it.
 *
 * NEVER THROWS. It runs at boot, and a boot task may not stop the server coming
 * up. What it could not do is reported.
 */
async function seed(client) {
  const out = { inserted: 0, skipped: 0, failed: [], verified: verify() };
  // REFUSE TO SEED A LIBRARY THAT DOES NOT VERIFY. A rule naming a field that
  // does not exist would sit in the database attaching to nothing, which reads
  // exactly like a condition nobody needs.
  if (!out.verified.ok) return out;

  for (const c of library()) {
    try {
      const { rows } = await client.query(
        `INSERT INTO lt_condition_templates
           (code, bucket_key, label, hint, borrower_label, borrower_hint,
            audience, kind, auto_apply, rule_logic, is_required, slots, config,
            is_enabled, disabled_reason, sort_order, is_seeded)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12::jsonb,$13::jsonb,$14,$15,$16,true)
         ON CONFLICT (code) DO NOTHING
         RETURNING code`,
        [c.code, c.bucketKey, c.label, c.hint, c.borrowerLabel, c.borrowerHint,
          c.audience, c.kind, c.autoApply, c.ruleLogic ? JSON.stringify(c.ruleLogic) : null,
          c.isRequired, JSON.stringify(c.slots), JSON.stringify(c.config),
          c.isEnabled, c.disabledReason, c.sortOrder],
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

module.exports = { BUCKETS: B, PRIOR_TO_SUBMISSION, PRIOR_TO_CTC, library, verify, seed, ensureSeeded, _resetSeed };
