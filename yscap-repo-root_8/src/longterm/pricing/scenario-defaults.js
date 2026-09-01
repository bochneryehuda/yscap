'use strict';
/**
 * LONG-TERM — ONE definition of the DSCR scenario's defaults and of what each
 * yes/no button is CALLED.
 *
 * ── WHY THIS FILE EXISTS ───────────────────────────────────────────────────
 * Owner-directed 2026-08-30: *"We need to look in what was the default that we
 * set in Lender Price and set the defaults over here as well… Our first time
 * home buyer button needs to match. Our first time investor button needs to
 * match. The waive escrow button needs to match."*
 *
 * The bug behind that ask was real and measured. Each vendor adapter read the
 * scenario with its OWN field names, so a caller who set a button got it on one
 * vendor and not the other — and nothing failed. Concretely, before this file:
 *
 *   • `selfEmployed` reached Lender Price and was DROPPED by LoanNEX, which was
 *     reading `isSelfEmployed`.
 *   • `firstTimeInvestor` likewise (LoanNEX read `isFirstTimeInvestor`).
 *   • `fthb` reached Lender Price and LoanNEX had NO first-time-home-buyer
 *     field at all, though the vendor plainly takes one.
 *   • `rural` reached Lender Price and LoanNEX had no field for it either.
 *   • An omitted prepay took Lender Price's five-year default and went to
 *     LoanNEX as NOTHING; an omitted DSCR took 1.5 on one and null on the other.
 *
 * Every one of those makes the two programs price DIFFERENT LOANS and then
 * presents the difference as a pricing advantage. That is the worst failure a
 * two-source board can have, and it is silent. So the names and the numbers live
 * here, once, and both adapters read them.
 *
 * ── THE DEFAULTS ARE LENDER PRICE'S, UNCHANGED ─────────────────────────────
 * These numbers are not new. Every one is the value `lenderprice/search-model.js`
 * has been sending since the DSCR profile was established, moved here verbatim so
 * the second vendor can read the same figure instead of a copy of it.
 * `test-lt-lp-dscr-profile-pure.js` is what proves they did not move.
 *
 * ── WHAT IS NOT HERE ───────────────────────────────────────────────────────
 * No vendor enum, no wire spelling, no mapping table. Two vendors' enums that
 * agree today are not one fact; each adapter keeps its own alias table and its
 * own registry check. What is shared is the CANONICAL vocabulary and the
 * PROFILE — the things that must be identical or the comparison is a lie.
 *
 * PURE: no network, no database, no RTL import.
 */

/**
 * The DSCR product profile. Applied when the caller omits the field.
 *
 * NULLISH, NEVER TRUTHY. An explicitly supplied 0 is a real answer — a 0 DSCR is
 * "no DSCR", a 0 prepay is "no prepayment penalty" — and must survive. Only
 * null/undefined/'' takes the default.
 */
const DSCR_PROFILE = {
  // Five-year Standard. Lender Price measured this the hard way: an omitted
  // prepay inherited whatever the tenant's saved search carried and produced a
  // THREE-year penalty on a deal the owner quotes at five, silently.
  prepayMonths: 60,
  // 1.5. Also measured: a null ratio collapsed a 439-row board to 28 rows from
  // one lender, because the engine reads null as an unqualified deal.
  dscr: 1.5,
  termYears: 30,
  lockDays: 30,
  reservesMonths: 24,
  // The words below are CANONICAL scenario words, not wire values; each adapter
  // maps them through its own alias table and checks them against its own vendor
  // registry.
  propertyType: 'SingleFamily',
  occupancy: 'Investment',
  incomeDoc: 'DSCR',
  // US CITIZEN, stated here rather than left implicit in two places (owner-directed
  // 2026-09-01: *"just put it somewhere in the backend to pre-fill as U.S. citizens…
  // the same way the other defaults work"* — and, on a control for it, *"we don't need
  // to add the option for this in the frontend"*).
  //
  // THIS MOVES NOTHING. It is what BOTH programs already send for a scenario that does
  // not state one: Lender Price's recorded base carries `Citizenship: "US Citizen"` and
  // only overwrites it when a scenario states one, and the LoanNEX connector carried the
  // same answer as an inline literal. Both now read it from HERE, so the two can no
  // longer drift — which is the whole reason this file exists. Before it, the answer
  // lived in a captured JSON blob on one side and a hard-coded string on the other, and
  // moving one would silently have left the other behind.
  //
  // ⛔ IT MUST BE A LENDER PRICE WIRE TOKEN, not merely a canonical word. LoanNEX maps it
  // through its own alias table (`US Citizen` → `UsCitizen`), but the Lender Price adapter
  // compares it EXACTLY against its own enum with no alias step — so a value spelled the
  // LoanNEX way here is not a synonym, it is unknown to that side. That connector now
  // ignores a default it cannot read rather than refusing the quote, and DEF-6 fails the
  // build if this value stops being valid for BOTH vendors. Do not "canonicalise" it.
  citizenship: 'US Citizen',
};

/**
 * Every yes/no the officer can toggle: its CANONICAL name, and every spelling
 * accepted for it.
 *
 * The aliases are not politeness — they are what makes the old callers on both
 * sides keep working while the two adapters converge on one vocabulary. The
 * canonical name is always the first entry.
 */
const FLAGS = {
  fthb: ['fthb', 'firstTimeHomeBuyer', 'firstTimeHomebuyer', 'isFirstTimeHomeBuyer', 'isFirstTimeHomebuyer', 'firstTimeBuyer'],
  firstTimeInvestor: ['firstTimeInvestor', 'isFirstTimeInvestor', 'firstTimeInv'],
  escrowWaive: ['escrowWaive', 'escrowWaiver', 'waiveEscrow', 'escrowWaived', 'isEscrowWaived'],
  io: ['io', 'interestOnly', 'isInterestOnly'],
  selfEmployed: ['selfEmployed', 'isSelfEmployed'],
  rural: ['rural', 'isRural', 'ruralProperty', 'isRuralProperty'],
  shortTermRental: ['shortTermRental', 'isShortTermRental', 'str'],
  mixedUse: ['mixedUse', 'isMixedUse'],
  nonWarrantable: ['nonWarrantable', 'isNonWarrantable', 'nonWarrantableProject'],
  crossCollateral: ['crossCollateral', 'isCrossCollateral'],
  noMortgageHistory: ['noMortgageHistory', 'isNoMortgageHistory'],
  livingRentFree: ['livingRentFree', 'isLivingRentFree'],
  waiveLenderFee: ['waiveLenderFee', 'isWaiveLenderFee'],
  dscrAssetDepletion: ['dscrAssetDepletion', 'isDscrAssetDepletion'],
  lateInLast12Months: ['lateInLast12Months', 'isLateInLast12Months'],
};

/**
 * PROPERTY TYPE — one word, understood by both programs.
 *
 * Each vendor keeps its own enum table (Lender Price's records the exact upstream
 * tokens; LoanNEX's the registry keys), and the two use DIFFERENT WORDS for the
 * same building: Lender Price says `Unit2_4`, LoanNEX says `TwoToFourUnits`, and
 * neither accepts the other's. So a caller had to know which vendor would read
 * their scenario. This table rewrites the way a PERSON writes it into a spelling
 * BOTH accept — proven pair by pair in the parity test, not asserted here.
 *
 * "MultiFamily" IS DELIBERATELY ABSENT, and that absence is the point. Lender
 * Price reads it as FIVE-PLUS units; LoanNEX's own alias table read it as 2–4.
 * One word, two different buildings, no way to tell which the officer meant — so
 * it is refused rather than resolved, and `duplex` / `5+ units` say which.
 */
const PROPERTY_TYPE_ALIASES = {
  singlefamily: 'SingleFamily', sfr: 'SingleFamily', sfd: 'SingleFamily', singlefamilyresidence: 'SingleFamily', detached: 'SingleFamily',
  '24unit': 'Unit2_4', '24units': 'Unit2_4', '2to4unit': 'Unit2_4', '2to4units': 'Unit2_4',
  twotofourunit: 'Unit2_4', twotofourunits: 'Unit2_4', unit24: 'Unit2_4', unitdwelling24: 'Unit2_4',
  duplex: 'Unit2_4', triplex: 'Unit2_4', fourplex: 'Unit2_4',
  condo: 'Condo', condominium: 'Condo', condos: 'Condo',
  townhouse: 'Townhouse', townhome: 'Townhouse',
  pud: 'PUD', plannedunitdevelopment: 'PUD',
  cooperative: 'Cooperative', coop: 'Cooperative',
  modular: 'Modular',
  manufactured: 'ManufacturedHousing', manufacturedhousing: 'ManufacturedHousing',
  // FIVE-PLUS. Lender Price's own table records MultiFamily as a FIVE-unit
  // property, so that is what both sides mean by it; `duplex` and `2-4 units`
  // say the smaller building.
  multifamily: 'MultiFamily', fiveplusunits: 'MultiFamily', fiveplusunit: 'MultiFamily', fiveplus: 'MultiFamily',
  '5units': 'MultiFamily', '5unit': 'MultiFamily', '5plusunits': 'MultiFamily', '5plusunit': 'MultiFamily',
};
function canonicalPropertyType(v) {
  if (v == null || v === '') return undefined;
  return PROPERTY_TYPE_ALIASES[String(v).toLowerCase().replace(/[^a-z0-9]/g, '')] || null;
}

/** canonical name for any accepted spelling, or null. Case-insensitive. */
const CANON_BY_ALIAS = (() => {
  const m = new Map();
  for (const [canon, list] of Object.entries(FLAGS)) for (const a of list) m.set(String(a).toLowerCase(), canon);
  return m;
})();
function canonicalFlagName(name) { return CANON_BY_ALIAS.get(String(name == null ? '' : name).toLowerCase()) || null; }

/**
 * Read one flag off a scenario under ANY of its accepted spellings.
 *
 * Returns `true`, `false`, or `undefined` — and the third one is load-bearing.
 * "Not supplied" is a different fact from "supplied as no": Lender Price leaves
 * an omitted flag at the tenant's own default and only an explicit value
 * overwrites it, while LoanNEX's app sends some flags as an explicit `false` and
 * omits others entirely. Collapsing the two would make every adapter assert an
 * answer nobody gave.
 *
 * A scenario carrying two spellings of one flag that DISAGREE is refused rather
 * than resolved by whichever the loop met first.
 */
function readFlag(sc, canonical) {
  const list = FLAGS[canonical];
  if (!list) throw new Error(`unknown_flag: ${canonical} is not a scenario flag.`);
  let seen;
  let seenAs = null;
  for (const name of list) {
    if (!sc || !Object.prototype.hasOwnProperty.call(sc, name)) continue;
    const raw = sc[name];
    if (raw === undefined || raw === null || raw === '') continue;
    // ONLY A REAL JSON BOOLEAN, AND THE STRICTNESS IS LOAD-BEARING. Lender Price
    // learned this the expensive way: a string "false" is TRUTHY in JavaScript,
    // so coercing one silently turned a flag ON. Its validator refuses a
    // non-boolean by name (`non_boolean_value`) and this must not quietly convert
    // one before that refusal can happen — an earlier cut of this file accepted
    // 'true'/'yes'/1 and disarmed that guard, which the existing suite caught.
    if (raw !== true && raw !== false) {
      const err = new Error(`invalid_flag_value: ${name} must be a real true/false, not ${JSON.stringify(raw)}.`);
      err.code = 'invalid_flag_value'; err.field = name; throw err;
    }
    const v = raw;
    if (seen !== undefined && seen !== v) {
      const err = new Error(`conflicting_flag: the scenario sets ${seenAs}=${seen} and ${name}=${v}; they are the same button. Send one.`);
      err.code = 'conflicting_flag'; err.field = name; throw err;
    }
    seen = v; seenAs = name;
  }
  return seen;
}

/** Every flag the scenario actually states, canonically named. */
function readFlags(sc) {
  const out = {};
  for (const canon of Object.keys(FLAGS)) {
    const v = readFlag(sc, canon);
    if (v !== undefined) out[canon] = v;
  }
  return out;
}

/** Nullish-only default: an explicit 0 or false survives. */
function withDefault(value, fallback) {
  return (value === undefined || value === null || value === '') ? fallback : value;
}

/**
 * The profile numbers a vendor adapter should use for THIS scenario.
 * One call, so neither adapter can apply three of the five and forget the rest.
 */
function profileFor(sc) {
  const s = sc || {};
  return {
    prepayMonths: withDefault(s.prepayMonths, DSCR_PROFILE.prepayMonths),
    dscr: withDefault(s.dscr, DSCR_PROFILE.dscr),
    termYears: withDefault(s.termYears != null ? s.termYears : s.term, DSCR_PROFILE.termYears),
    lockDays: withDefault(s.lockDays, DSCR_PROFILE.lockDays),
    reservesMonths: withDefault(s.reservesMonths != null ? s.reservesMonths : s.reserves, DSCR_PROFILE.reservesMonths),
    propertyType: withDefault(s.propertyType, DSCR_PROFILE.propertyType),
    citizenship: withDefault(s.citizenship, DSCR_PROFILE.citizenship),
  };
}

/**
 * Add the CANONICAL spelling of every flag the scenario states, so a downstream
 * reader that only knows one name still sees the officer's answer.
 *
 * IT ADDS, IT NEVER REMOVES. Deleting the spelling the caller used would break
 * anything already reading it — and this runs on the shared path both vendors
 * take, which is the last place to be clever. A scenario that already carries
 * the canonical name is returned untouched, so this is a no-op for every caller
 * that was already correct. Conflicting spellings still raise, via `readFlag`.
 */
function canonicalizeFlags(sc) {
  if (!sc || typeof sc !== 'object') return sc;
  let out = sc;
  for (const canon of Object.keys(FLAGS)) {
    let v;
    try { v = readFlag(sc, canon); }
    catch (e) {
      // A CONFLICT still stops everything — no downstream validator can see that
      // two spellings of one button disagree, so this is the only place it can be
      // caught. A JUNK VALUE is deliberately LEFT ALONE: each vendor's own strict
      // validation refuses it with a better message than this module could write,
      // and rewriting it here would rob them of the chance.
      if (e && e.code === 'conflicting_flag') throw e;
      continue;
    }
    if (v === undefined) continue;
    if (sc[canon] === v) continue;           // already canonical
    if (out === sc) out = { ...sc };
    out[canon] = v;
  }
  const pt = canonicalPropertyType(sc.propertyType);
  // A word neither vendor knows is LEFT ALONE so each refuses it by name; a word
  // we can translate is rewritten to the spelling both accept.
  if (pt && pt !== sc.propertyType) { if (out === sc) out = { ...sc }; out.propertyType = pt; }
  return out;
}

module.exports = {
  DSCR_PROFILE, FLAGS, PROPERTY_TYPE_ALIASES, profileFor, readFlag, readFlags,
  canonicalFlagName, canonicalPropertyType, withDefault, canonicalizeFlags,
  _internals: { CANON_BY_ALIAS },
};
