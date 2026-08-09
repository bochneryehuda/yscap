'use strict';
/**
 * WHAT KIND OF COMPANY IS THIS — in ONE place (owner-directed 2026-08-09).
 *
 * PILOT's table for a borrowing company is literally called `llcs` and, until
 * this module existed, the whole system simply assumed every one of them was a
 * limited liability company. That was never true, and three separate things were
 * wrong because of it:
 *
 *   · WE ASKED FOR A DOCUMENT THAT DOES NOT EXIST. A corporation has no operating
 *     agreement — it has bylaws and stock certificates — and the entity condition
 *     asked every borrower for one anyway.
 *   · THE LOAN DOCUMENTS COULD NOT BE DRAFTED. DocLab needs to know whether the
 *     entity has MEMBERS holding a PERCENTAGE or SHAREHOLDERS holding SHARES —
 *     six of its fields hang off that single answer (`type_of_organization`,
 *     `acknowledgement_corporate_status`, `bylaws_operating_agreement`,
 *     `operating_agreement_or_bylaws`, `membership_interest_percentage`,
 *     `number_of_shares`).
 *   · NOBODY'S TITLE WAS RECORDED. A title prints under the signature line on
 *     every loan document, for an LLC as much as for a corporation.
 *
 * PURE — no database, no config, no requires. Every surface that needs to say
 * what an entity is, what document to ask it for, or what titles its owners can
 * hold, reads it from here. Never re-inline one of these lists.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE BACK BOOK IS LLC, AND THAT IS A DELIBERATE FICTION WE RECORD AS SUCH.
 * Owner-directed: *"everything created till now should automatically be default
 * LLC, only going forward this change to go in effect."* So db/509 stamps every
 * existing entity `llc` — but it also stamps `entity_type_confirmed = false`,
 * because "we assumed" and "somebody chose" are different facts and only one of
 * them is safe to print on a mortgage. Anything drafting real documents should
 * ask `needsConfirmation()` before trusting the type on an old entity.
 * ────────────────────────────────────────────────────────────────────────────
 */

/**
 * The four types. `key` is what the column holds; everything else is derived
 * from it so a screen never hard-codes a word.
 *
 * `owns` is the noun for what an owner holds — the difference that drives
 * everything downstream: an LLC member holds a PERCENTAGE, a shareholder holds
 * SHARES evidenced by a numbered CERTIFICATE.
 */
const TYPES = Object.freeze([
  {
    key: 'llc',
    label: 'LLC',
    longLabel: 'Limited liability company',
    // DocLab `type_of_organization` — their own example sends this exact wording.
    docLabOrgType: 'limited liability company',
    // DocLab `bylaws_operating_agreement` — must be one of their permitted strings.
    governingDocWord: 'operating agreement',
    // DocLab `acknowledgement_corporate_status`.
    acknowledgement: 'operating agreement and its members',
    ownerNoun: 'member',
    ownerNounPlural: 'members',
    usesShares: false,
  },
  {
    key: 'corporation',
    label: 'Corporation',
    longLabel: 'Corporation (Inc / S-Corp)',
    docLabOrgType: 'corporation',
    governingDocWord: 'bylaws',
    acknowledgement: 'bylaws and its shareholders',
    ownerNoun: 'shareholder',
    ownerNounPlural: 'shareholders',
    usesShares: true,
  },
  {
    key: 'partnership',
    label: 'Partnership',
    longLabel: 'Partnership (LP / LLP / general)',
    docLabOrgType: 'partnership',
    governingDocWord: 'partnership agreement',
    acknowledgement: 'partnership agreement and its partners',
    ownerNoun: 'partner',
    ownerNounPlural: 'partners',
    usesShares: false,
  },
  {
    key: 'trust',
    label: 'Trust',
    longLabel: 'Trust',
    docLabOrgType: 'trust',
    governingDocWord: 'trust agreement',
    acknowledgement: 'trust agreement and its trustees',
    ownerNoun: 'trustee',
    ownerNounPlural: 'trustees',
    usesShares: false,
  },
]);

const DEFAULT_TYPE = 'llc';
const KEYS = Object.freeze(TYPES.map((t) => t.key));
const BY_KEY = Object.freeze(TYPES.reduce((m, t) => { m[t.key] = t; return m; }, {}));

/* ─────────────────────────── the sub-kinds ───────────────────────────
 *
 * A PARTNERSHIP AND A TRUST ARE NOT ONE THING EACH (owner-directed 2026-08-09,
 * after research into what DocLab actually needs for them). Two facts hang off
 * the sub-kind and nothing else can supply them:
 *
 *   · WHAT WE CAN LEGITIMATELY ASK THE BORROWER FOR. A GENERAL partnership is
 *     created by a signed agreement and is generally not filed with any state —
 *     there is no certificate to upload. A REVOCABLE living trust uses the
 *     grantor's own Social Security number and has no EIN of its own while the
 *     grantor is alive. Demanding either is demanding a document that does not
 *     exist, and because the entity-verification gate is a hard requirement that
 *     would leave a real trust PERMANENTLY unverifiable — which blocks the
 *     entity condition, which blocks clear to close. That is the single most
 *     valuable thing this table fixes.
 *   · WHAT THE LOAN DOCUMENTS CALL IT. "limited partnership" and "general
 *     partnership" are different legal entities and DocLab prints
 *     `type_of_organization` verbatim onto a recorded instrument.
 *
 * DELIBERATELY NOT REFINED FOR A TRUST'S ORG TYPE. "revocable trust" is standard
 * vesting language, but a wrong word on a recorded instrument is expensive and
 * "trust" is never wrong — the trust's own NAME carries the rest ("The Smith
 * Family Trust, dated March 3, 2019"). A closer can still override it per file.
 *
 * `requires` is what the verification gate reads. `optional` never means "we do
 * not want it": a value that IS present is still stored, still verified and still
 * sent. It means we may not REFUSE to finish the entity for the want of it.
 */
const SUBTYPES = Object.freeze({
  partnership: Object.freeze([
    { key: 'general', label: 'General partnership', docLabOrgType: 'general partnership',
      // Files a partnership return (Form 1065), so it has an EIN; it is created
      // by agreement, so there is usually nothing filed with a state.
      requires: { ein: true, formationState: false } },
    { key: 'limited', label: 'Limited partnership (LP)', docLabOrgType: 'limited partnership',
      requires: { ein: true, formationState: true } },
    { key: 'llp', label: 'Limited liability partnership (LLP)', docLabOrgType: 'limited liability partnership',
      requires: { ein: true, formationState: true } },
  ]),
  trust: Object.freeze([
    { key: 'revocable', label: 'Revocable (living) trust', docLabOrgType: 'trust',
      // Uses the grantor's SSN, and trusts are generally not state-filed.
      requires: { ein: false, formationState: false } },
    { key: 'irrevocable', label: 'Irrevocable trust', docLabOrgType: 'trust',
      requires: { ein: true, formationState: false } },
  ]),
});

/** The sub-kinds this type offers, or [] for a type that has none. */
function subtypesFor(type) { return SUBTYPES[normalizeKey(type) || DEFAULT_TYPE] || []; }

/** Does this type ask a sub-kind question at all? Only partnership and trust do. */
function hasSubtypes(type) { return subtypesFor(type).length > 0; }

/**
 * The stored sub-kind for anything a door might hand us, or '' when this type
 * has none / the value is not one of them. Never guesses — an unreadable answer
 * is an unanswered question, exactly as the type itself is.
 */
function normalizeSubtype(type, v) {
  const list = subtypesFor(type);
  if (!list.length) return '';
  const raw = String(v == null ? '' : v).trim().toLowerCase();
  if (!raw) return '';
  const hit = list.find((x) => x.key === raw)
    || list.find((x) => x.label.toLowerCase() === raw)
    // The obvious spellings a form or a person might send.
    || list.find((x) => raw.startsWith(x.key))
    || (raw === 'lp' ? list.find((x) => x.key === 'limited') : null)
    || (raw === 'gp' ? list.find((x) => x.key === 'general') : null);
  return hit ? hit.key : '';
}

function subtypeOf(entity) {
  const t = typeOf(entity && entity.entity_type).key;
  const k = normalizeSubtype(t, entity && (entity.entity_subtype || entity.entitySubtype));
  return k ? subtypesFor(t).find((x) => x.key === k) : null;
}

/**
 * WHAT THIS PARTICULAR ENTITY MUST HAVE BEFORE IT CAN BE VERIFIED.
 *
 * Read by `llc.missingForVerification`, which is a HARD gate — so the cost of
 * the two possible mistakes is not symmetric, and that decides the default. Ask
 * a revocable trust for an EIN it does not have and the entity can NEVER be
 * verified, the entity condition never clears and the file cannot reach clear to
 * close: a dead end no human can resolve. Fail to ask a limited partnership for
 * its state certificate and a reviewer simply asks for it — the requirement is
 * togglable on the condition itself. So an UNSTATED sub-kind relaxes rather than
 * blocks, and the screens ask the sub-kind question instead.
 *
 * The formation DATE is always required: a trust is legally identified by its
 * name AND its date, and a partnership agreement is dated.
 */
function requirements(entity) {
  const t = typeOf(entity && entity.entity_type);
  if (!hasSubtypes(t.key)) return { ein: true, formationState: true, formationDate: true, subtypeKnown: true };
  const sub = subtypeOf(entity);
  if (!sub) {
    // We do not know which kind it is, so we do not know what it can produce.
    return { ein: false, formationState: false, formationDate: true, subtypeKnown: false };
  }
  return { ...sub.requires, formationDate: true, subtypeKnown: true };
}

/**
 * Read a type from anything a door might hand us — a stored key, a dropdown
 * label, the marketing form's own wording ("Corporation (Inc / S-Corp)").
 *
 * FALLS BACK TO LLC RATHER THAN NULL, on purpose: every entity on file is an LLC
 * until somebody says otherwise, and a null here would make every consumer write
 * its own `|| 'llc'`. Use `isRecognized()` when you need to know whether the
 * input was actually understood — the create doors do, so a typo cannot be
 * silently filed as an LLC.
 */
function typeOf(v) {
  return BY_KEY[normalizeKey(v)] || BY_KEY[DEFAULT_TYPE];
}

/** The stored key for anything a human or a form might have typed. */
function normalizeKey(v) {
  const s = String(v == null ? '' : v).trim().toLowerCase();
  if (!s) return DEFAULT_TYPE;
  if (BY_KEY[s]) return s;
  // The spellings our own surfaces already use, and the obvious ones.
  if (/^l\.?l\.?c\.?$/.test(s) || s.includes('limited liability')) return 'llc';
  if (s.startsWith('corp') || s.includes('inc') || s.includes('s-corp') || s.includes('corporation')) return 'corporation';
  if (s.includes('partnership') || s === 'lp' || s === 'llp') return 'partnership';
  if (s.includes('trust')) return 'trust';
  return '';
}

/**
 * Did somebody actually STATE a type? Blank and junk both answer false.
 *
 * THE BLANK CASE IS THE ONE THAT MATTERS, and it has to be tested before
 * `normalizeKey` rather than after: that function deliberately falls back to LLC
 * on a blank (so every consumer does not write its own `|| 'llc'`), so asking it
 * about an empty box gives a perfectly valid 'llc' back. Reading that as an
 * answer is exactly how a form nobody filled in gets filed as an LLC that
 * somebody vouched for — which is the difference db/509 exists to keep.
 */
function isRecognized(v) {
  const raw = String(v == null ? '' : v).trim();
  if (!raw) return false;
  const k = normalizeKey(raw);
  return !!k && !!BY_KEY[k];
}

/* ─────────────────────────── the document slots ─────────────────────────── */

/**
 * The wording each entity-document slot carries, BY TYPE.
 *
 * Owner-directed 2026-08-09: *"I want to re-label the operating agreement slot
 * … for bylaws and stock certificate, and this change needs to be everywhere
 * else — SharePoint syncing, TPR export and everywhere else."* So this is the
 * one definition, and the label is written onto the checklist ITEM when the slot
 * is created (and rewritten when the type changes). SharePoint names its folders
 * from the item's label and the TPR export categorises from it, so both follow
 * for free rather than needing their own copy of this table.
 *
 * `rtl_llc_goodstanding` is deliberately absent: a certificate of good standing
 * is called the same thing for every entity type, and inventing four wordings
 * for one document would be noise.
 */
const SLOT_WORDING = Object.freeze({
  rtl_llc_formation: Object.freeze({
    llc: { label: 'Certificate of Formation (formation state)', borrowerLabel: 'State formation documents',
      hint: 'Articles of Organization / Certificate of Formation from the state' },
    corporation: { label: 'Articles of Incorporation (formation state)', borrowerLabel: 'State formation documents',
      hint: 'Articles / Certificate of Incorporation from the state' },
    partnership: { label: 'Certificate of Partnership (formation state)', borrowerLabel: 'State formation documents',
      hint: 'Certificate of Limited Partnership / partnership registration from the state' },
    trust: { label: 'Trust formation documents', borrowerLabel: 'Trust formation documents',
      hint: 'The document that created the trust. Many trusts are not filed with a state — send what exists' },
    /* BY SUB-KIND, where the document genuinely differs. A GENERAL partnership
       files nothing with a state, so naming a "Certificate of Partnership" asks
       for a document that does not exist — the slot says so instead, and
       `requirements()` stops it gating verification. */
    'partnership:general': { label: 'State registration (if the partnership has one)',
      borrowerLabel: 'State registration (if you have one)',
      hint: 'A general partnership is created by its agreement and is usually not filed with any state. If it was registered anywhere, send that; otherwise leave this empty' },
    'partnership:limited': { label: 'Certificate of Limited Partnership (formation state)',
      borrowerLabel: 'State formation documents',
      hint: 'Certificate of Limited Partnership filed with the state' },
    'partnership:llp': { label: 'LLP registration (formation state)',
      borrowerLabel: 'State formation documents',
      hint: 'The statement of qualification / LLP registration filed with the state' },
  }),
  rtl_llc_opagmt: Object.freeze({
    llc: { label: 'Operating Agreement', borrowerLabel: 'Operating agreement',
      hint: 'Signed operating agreement showing the ownership structure' },
    // The owner's own words for this one.
    corporation: { label: 'Bylaws and stock certificate', borrowerLabel: 'Bylaws and stock certificate',
      hint: 'Signed bylaws AND the stock certificate(s) showing who owns the shares — both in this one upload' },
    partnership: { label: 'Partnership agreement', borrowerLabel: 'Partnership agreement',
      hint: 'Signed partnership agreement showing the ownership structure' },
    trust: { label: 'Trust agreement', borrowerLabel: 'Trust agreement',
      hint: 'The signed trust agreement, showing the trustees and the beneficiaries' },
    /* A living trust's document is as often called a DECLARATION of trust, and
       lenders normally accept a certification/abstract of trust in place of the
       full instrument — saying so stops a borrower hunting for a document by a
       name theirs does not use. */
    'trust:revocable': { label: 'Trust agreement', borrowerLabel: 'Trust agreement',
      hint: 'The signed trust agreement or declaration of trust — a certification (abstract) of trust naming the trustees and their powers is usually enough' },
    'trust:irrevocable': { label: 'Trust agreement', borrowerLabel: 'Trust agreement',
      hint: 'The signed trust agreement — a certification (abstract) of trust naming the trustees and their powers is usually enough' },
  }),
  rtl_llc_ein: Object.freeze({
    llc: { label: 'EIN letter (IRS)', borrowerLabel: 'EIN letter (IRS)', hint: 'IRS SS-4 / CP-575 EIN confirmation letter' },
    corporation: { label: 'EIN letter (IRS)', borrowerLabel: 'EIN letter (IRS)', hint: 'IRS SS-4 / CP-575 EIN confirmation letter' },
    partnership: { label: 'EIN letter (IRS)', borrowerLabel: 'EIN letter (IRS)', hint: 'IRS SS-4 / CP-575 EIN confirmation letter' },
    trust: { label: 'EIN letter (IRS)', borrowerLabel: 'EIN letter (IRS)', hint: 'IRS SS-4 / CP-575 EIN confirmation letter' },
  }),
});

/**
 * The wording for one slot on one entity type, or null when this slot does not
 * vary. Returning null rather than a guess is what lets a caller leave a
 * template's own label alone instead of overwriting it with an invention.
 */
function slotWording(code, type, subtype) {
  const byType = SLOT_WORDING[code];
  if (!byType) return null;
  const t = normalizeKey(type) || DEFAULT_TYPE;
  // The sub-kind wins where one is published for this slot; otherwise the type's
  // own wording stands, so adding a sub-kind never has to restate every slot.
  const sub = normalizeSubtype(t, subtype);
  return (sub && byType[`${t}:${sub}`]) || byType[t] || byType[DEFAULT_TYPE] || null;
}

/**
 * Every wording a slot could legitimately be carrying — every type's, and every
 * sub-kind's. `llc.applyEntitySlotWording` guards on this so a label a human
 * edited by hand is never overwritten, and it must include the sub-kind variants
 * or switching a partnership from general to limited would refuse to re-word the
 * slot it just made wrong.
 */
function slotWordings(code) {
  const byType = SLOT_WORDING[code];
  return byType ? Object.values(byType) : [];
}

/** Every slot code whose wording depends on the entity type. */
const TYPED_SLOT_CODES = Object.freeze(Object.keys(SLOT_WORDING));

/* ───────────────────────────── the owner titles ───────────────────────────── */

/**
 * The titles an owner can hold, PER TYPE — a fixed list, not free text
 * (owner-directed: *"it should be a drop-down where you can select managing
 * member, manager, with a few other typical titles"*).
 *
 * WHY A LIST AND NOT A BOX. This value is printed under the signature line on a
 * recorded instrument, and DocLab merges it verbatim. Free text means "managing
 * member", "Managing Member", "MGR" and "mgr." all reach a mortgage, and a
 * closing attorney has to guess which of them means the person may sign.
 *
 * `AUTHORIZED_SIGNATORY` is on every list on purpose — it is the catch-all a
 * closer can always reach for when the real title is unusual, so the list never
 * becomes a dead end that forces somebody to pick a wrong answer.
 */
const AUTHORIZED_SIGNATORY = 'Authorized Signatory';
const TITLES = Object.freeze({
  llc: Object.freeze(['Managing Member', 'Member', 'Manager', 'Managing Partner', 'President', AUTHORIZED_SIGNATORY]),
  corporation: Object.freeze(['President', 'Vice President', 'Secretary', 'Treasurer',
    'Chief Executive Officer', 'Chief Financial Officer', 'Director', 'Shareholder', AUTHORIZED_SIGNATORY]),
  partnership: Object.freeze(['General Partner', 'Managing Partner', 'Limited Partner', 'Partner', AUTHORIZED_SIGNATORY]),
  trust: Object.freeze(['Trustee', 'Co-Trustee', 'Successor Trustee', 'Grantor', 'Beneficiary', AUTHORIZED_SIGNATORY]),
});

function titlesFor(type) { return TITLES[normalizeKey(type) || DEFAULT_TYPE] || TITLES[DEFAULT_TYPE]; }

/**
 * Is this a title this entity type actually offers?
 *
 * ACCEPTS ANY TYPE'S TITLE, not just this one's — deliberately. An entity's type
 * can be corrected after its owners are recorded, and refusing the stored title
 * at that moment would either wipe it or block the correction. What it refuses
 * is a title that is on NO list, which is the thing that must never reach a
 * signature block. Blank is allowed: not-yet-answered is a real state.
 */
function titleProblem(title, type) {
  const s = String(title == null ? '' : title).trim();
  if (!s) return null;
  const all = new Set(KEYS.flatMap((k) => TITLES[k]));
  if (all.has(s)) return null;
  return `"${s}" is not one of the titles we record. Pick one of: ${titlesFor(type).join(', ')}.`;
}

/* ─────────────────────────── what a screen should say ─────────────────────────── */

/**
 * Everything a screen needs to describe ONE entity, without knowing the rules.
 *
 * `ownershipLabel` is the difference that matters: asking a corporation for its
 * "membership interest" is asking the wrong question, and asking an LLC for its
 * "share count" is asking for a number that does not exist.
 */
function describe(entity) {
  const t = typeOf(entity && entity.entity_type);
  const sub = subtypeOf(entity);
  const req = requirements(entity);
  return {
    key: t.key,
    label: t.label,
    longLabel: t.longLabel,
    ownerNoun: t.ownerNoun,
    ownerNounPlural: t.ownerNounPlural,
    usesShares: t.usesShares,
    ownershipLabel: t.usesShares ? 'Shares' : 'Ownership %',
    governingDocWord: t.governingDocWord,
    titles: titlesFor(t.key),
    confirmed: !!(entity && entity.entity_type_confirmed),
    // The sub-kind, and whether this type even has one to ask about.
    hasSubtypes: hasSubtypes(t.key),
    subtypes: subtypesFor(t.key),
    subtype: sub ? sub.key : '',
    subtypeLabel: sub ? sub.label : '',
    requirements: req,
    /* WHAT THE DATE IS CALLED. A trust is legally identified by its name AND its
       date — "The Smith Family Trust, dated March 3, 2019" — so calling that box
       "formation date" on a trust asks the wrong question about the one fact
       that completes its legal name. A partnership's is its agreement's date. */
    dateLabel: t.key === 'trust' ? 'Trust date'
      : t.key === 'partnership' ? 'Partnership agreement date'
        : 'Formation date',
    /* Whether the state box is asking for something this entity has at all. A
       general partnership and a trust are usually not filed anywhere. */
    stateLabel: t.key === 'trust' ? 'State the trust was signed in'
      : 'Formation state',
  };
}

/**
 * True when this entity's type was ASSUMED by the back-fill rather than chosen
 * by a person — so a surface that is about to act on it (drafting documents,
 * asking for the governing document) can say so instead of stating a guess as a
 * fact. An entity nobody has confirmed is still treated as an LLC everywhere;
 * this only decides whether we admit that we are assuming.
 */
function needsConfirmation(entity) {
  return !(entity && entity.entity_type_confirmed);
}

/* ───────────────────────────── DocLab handoff ───────────────────────────── */

/**
 * The four DocLab variables that are pure functions of the entity type. Read by
 * `src/doclab/payload.js`; kept here so "what kind of company is this" has ONE
 * answer in this codebase rather than one in the entity code and another in the
 * document code.
 */
function docLabVariables(entity) {
  const t = typeOf(entity && entity.entity_type);
  /* THE SUB-KIND REFINES THE ORG TYPE, and this is not cosmetic: DocLab prints
     `type_of_organization` verbatim onto a recorded instrument, and a "general
     partnership" and a "limited partnership" are different legal entities with
     different liability. A trust's sub-kind deliberately does NOT refine it —
     see the SUBTYPES comment. */
  const sub = subtypeOf(entity);
  return {
    type_of_organization: (sub && sub.docLabOrgType) || t.docLabOrgType,
    acknowledgement_corporate_status: t.acknowledgement,
    bylaws_operating_agreement: t.governingDocWord,
    operating_agreement_or_bylaws: t.governingDocWord,
  };
}

module.exports = {
  TYPES, KEYS, BY_KEY, DEFAULT_TYPE,
  typeOf, normalizeKey, isRecognized,
  SUBTYPES, subtypesFor, hasSubtypes, normalizeSubtype, subtypeOf, requirements,
  SLOT_WORDING, TYPED_SLOT_CODES, slotWording, slotWordings,
  TITLES, AUTHORIZED_SIGNATORY, titlesFor, titleProblem,
  describe, needsConfirmation, docLabVariables,
};
