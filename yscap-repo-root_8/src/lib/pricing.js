/* =====================================================================
   pricing.js — server-side wrapper over the FROZEN pricing engines.

   Loads the same byte-identical engine modules the browser loads
   (standard-program.js -> YSP, gold-standard.js -> GSP, title-cost.js ->
   YSTitle) and turns a loan-file row into an authoritative term-sheet
   quote. This module NEVER reimplements or alters engine math — it only
   maps application data to engine inputs and normalizes engine output.

   Registering a product recomputes here on the server so a tampered
   client can never inject fabricated terms; the browser copy of the
   engines is used only for instant what-if display.
   ===================================================================== */
'use strict';

let YSP = null, GSP = null, SVP = null, YSTitle = null, loadErr = null;
try {
  YSP = require('../../web/tools/standard-program.js');
  GSP = require('../../web/tools/gold-standard.js');
  SVP = require('../../web/tools/silver-program.js');
  YSTitle = require('../../web/tools/title-cost.js');
} catch (e) {
  loadErr = e && e.message ? e.message : String(e);
}

function enginesReady() { return !!(YSP && GSP && SVP && YSTitle); }

const PROGRAM_LABEL = { standard: 'Standard Program', gold: 'Gold Standard Program', silver: 'Silver Program', manual: 'Manual Program' };
// Hardcoded fee fallback (used only if the company-settings cache is stone
// cold). Company defaults (Pricing Admin Center) override these for every
// not-yet-registered file; a per-file adminPricing override still wins over
// both. The engine MATH is untouched — this is the input/fee-default layer.
const FEES = { lender: 2195, credit: 150, appraisal: 800 };
const pricingSettings = require('./pricing-settings');
const { parseAddress } = require('./address');   // city recovery from composed/string addresses
// THE shared "does this deal size on the as-is value (a refinance)?" predicate —
// the engine's own `!== 'Purchase'` meaning, so a raw label ("Cash-Out Refinance")
// can never make normalize() treat as a purchase a deal the engine sized as a refi.
const { sizesOnAsIsValue } = require('./deal-basis');

/* ---- small coercers ---- */
// Strips thousands-separator commas before parsing (#143): the studio's dollar
// inputs now DISPLAY comma-grouped, so an override can arrive as "400,000". For a
// comma-free value (the only form pre-#143) the replace is a no-op, so every
// existing input parses BYTE-IDENTICALLY — this only rescues a comma'd string that
// Number() would otherwise turn into NaN→0 and silently zero the loan. Frozen-safe.
function num(v) { const n = Number(String(v == null ? '' : v).replace(/,/g, '')); return isFinite(n) ? n : 0; }
function clean(s) { return String(s == null ? '' : s).trim(); }
function round2(n) { return Math.round(num(n) * 100) / 100; }
function reserveMonths(totalLoan) { return num(totalLoan) > 1000000 ? 4 : 2; }

// Parse a free-text term ("12 months", "12", "18-month") into a month count.
function parseTermMonths(t) {
  const m = /(\d{1,2})/.exec(String(t == null ? '' : t));
  const n = m ? parseInt(m[1], 10) : 0;
  return n >= 1 && n <= 36 ? n : 12;
}

// The portal's program label "Fix & Flip w/ Construction" contains the word
// "construction", which the frozen engine's normStrategy() classifies as
// GROUND-UP — silently pricing every standard fix & flip on the wrong matrix
// (wrong tiers, wrong FICO minimums, wrong leverage). Normalize portal labels
// to the Term Sheet Studio's own strategy labels before they reach the
// engines; unknown labels pass through untouched.
function engineStrategy(s) {
  const x = clean(s).toLowerCase();
  if (!x || x.indexOf('not sure') > -1) return 'Fix & Flip';
  if (x.indexOf('bridge') > -1 || x.indexOf('stabil') > -1) return 'Bridge / Stabilized';
  if (x.indexOf('ground') > -1) return 'Ground-up Construction';
  if (x.indexOf('hold') > -1 || x.indexOf('brrrr') > -1) return 'Fix & Hold (BRRRR)';
  if (x.indexOf('flip') > -1) return 'Fix & Flip';
  return clean(s);
}

// Normalize a stored property-type label to the exact tokens the frozen engines'
// ineligible-property list matches on. The engines match by EXACT string equality,
// so portal labels like "Multi 5+" / "Mixed Use" would otherwise never match their
// ineligible entries ("multifamily 5+" / "mixed-use") and a 5+/mixed-use building
// would price as an eligible 1-4 unit deal (audit findings #5/#6, 2026-07-17).
// Eligible types (SFR / 2-4 / condo / townhouse / PUD) pass through unchanged.
function normPropertyType(v) {
  const x = clean(v).toLowerCase();
  if (!x) return clean(v);
  if (/(^|[^0-9])5\s*\+|5\+\s*unit|multifamily\s*5|multi\s*5|5\s*or\s*more/.test(x)) return 'multifamily 5+';
  if (/mixed[\s-]*use/.test(x)) return 'mixed-use';
  if (/\bco[\s-]*op\b|cooperative/.test(x)) return 'co-op';
  if (/mobile\s*home/.test(x)) return 'mobile home';
  if (/manufactured/.test(x)) return 'manufactured';
  if (/commercial/.test(x)) return 'commercial';
  return clean(v);
}
// Is a normalized property type one the engines will (correctly) declare ineligible?
const ENGINE_INELIGIBLE_PROPERTY = ['co-op', 'cooperative', 'mobile home', 'manufactured',
  'mixed-use', 'mixed use', 'commercial', 'rural', 'agricultural', 'bed and breakfast',
  'boarding house', 'half-way house', 'care facility', 'condemned', 'multifamily 5+', '5+ units'];
function isIneligiblePropertyType(v) {
  return ENGINE_INELIGIBLE_PROPERTY.indexOf(normPropertyType(v)) > -1;
}

// Refinance if the loan type mentions refi; cash-out if it says so.
function loanTypeOf(app) {
  const lt = clean(app.loan_type).toLowerCase();
  return lt.indexOf('refi') > -1 || lt.indexOf('refinance') > -1 ? 'Refinance' : 'Purchase';
}
function isCashOut(app) {
  const lt = clean(app.loan_type).toLowerCase();
  return lt.indexOf('cash') > -1;
}

/* ---- build the engine input from a loan file (+ experience + staff overrides) ----
   `app` is a row from GET /applications/:id (joined borrower fico + address).
   `experience` = { flips, holds, ground } counted from the borrower track record.
   `overrides`  = staff edits from the pricing panel (same field names as the
                  returned inputs), applied last so they win. */
function buildInputs(app, experience, overrides) {
  app = app || {};
  const addr = app.property_address || {};
  // property_address arrives in several historical shapes (object with line1 or
  // street, object carrying only a composed oneLine/formatted string, or a bare
  // JSON string). Recover the street text AND the CITY from whatever shape the
  // file has: the frozen engines scan city+address text for the ineligible-city
  // and adverse-market checks, so a recoverable city must never be dropped just
  // because the file stored a composed string instead of components (audit
  // 2026-07-24 on the file-owned-address fix).
  const addrIsString = typeof app.property_address === 'string';
  const fileLine1 = clean(addrIsString ? app.property_address : (addr.line1 || addr.address || addr.street || ''));
  let fileCity = clean(addrIsString ? '' : addr.city);
  if (!fileCity) {
    const composed = clean(addrIsString ? app.property_address : (addr.oneLine || addr.formatted_address || addr.formatted || ''));
    if (composed) { try { fileCity = clean(parseAddress(composed).city); } catch (_) { /* best-effort recovery */ } }
  }
  const loanType = loanTypeOf(app);
  // Does this deal size on the property's CURRENT value rather than on a price?
  // Deliberately `loanTypeOf`'s OWN answer — the very branch the frozen engines
  // use to pick `acqDenom` — so "which number do we feed it" and "which number
  // does it read" can never disagree. lib/deal-basis.js mirrors this test for
  // every screen, and a test pins the two together.
  const sizedOnAsIs = loanType === 'Refinance';

  // Assignment purchases: leverage/pricing size off seller price + financeable fee.
  const isAssignment = loanType === 'Purchase' && !!app.is_assignment && num(app.underlying_contract_price) > 0;
  const sellerPrice = isAssignment ? num(app.underlying_contract_price) : 0;
  const totalPrice = isAssignment
    ? num(app.underlying_contract_price) + num(app.assignment_fee)
    : num(app.purchase_price);

  const base = {
    loanType,
    cashOut: loanType === 'Refinance' && isCashOut(app),
    strategy: engineStrategy(clean(app.program) || clean(app.loan_type)),
    state: clean(addr.state).toUpperCase(),
    city: fileCity,
    address: fileLine1,
    // ZIP feeds the Silver engine's geography exclusions + NYC-market detection
    // (Standard/Gold ignore it). Falls back to a ZIP inside the address text.
    zip: clean(addrIsString ? '' : (addr.zip || addr.postal_code || addr.postalCode || '')),
    propertyType: normPropertyType(app.property_type),
    units: num(app.units) || 0,
    /* A REFINANCE IS SIZED ON THE AS-IS VALUE, AND ON NOTHING ELSE
       (owner-directed 2026-08-02, in the owner's own words: "once a file is
       refinance then instead of asking for the purchase price just ask him right
       away for the as is value because that's what it counts for, it doesn't
       count for the purchase price … as is value is the one that sets how much
       initial he can get instead of looking on the purchase price").

       The FROZEN ENGINES ALREADY DID THIS — `acqDenom = purchase ? min(pp, aiv)
       : aiv` and (owner-directed 2026-08-05) `costBasis0 = acqDenom + rehab`,
       so on a refinance both read the as-is value — not one formula, cap, rate or
       matrix value moves here. What moved is which numbers this input builder hands
       them on a refinance:

         · `asIsValue` no longer falls back to the purchase price. That fallback
           is right on a PURCHASE ("worth what I'm paying for it") and meaningless
           on a refinance, where a stored purchase price is either a leftover from
           a file that started life as a purchase or the price the borrower paid
           years ago — which is `original_purchase_price`, a different field. It
           was silently sizing refinances off it.
         · `purchasePrice` becomes the as-is value on a refinance, which is
           exactly what the Term Sheet Studio (`termsheet.js`:
           `purchasePrice: isRefi() ? num("asIs") : effPurchase()`) and the public
           loan application have always sent. The server was the odd one out, so a
           quote could differ from the sheet the borrower was shown. With an as-is
           value present the engines read `purchasePrice` on a refinance NOWHERE
           (it is excluded from acqDenom, the cost basis, the heavy-rehab basis
           and the exit test), so this is a parity fix, not a math one.

       PURCHASES ARE BYTE-IDENTICAL — same total price, same as-is default, same
       `asIsDefaulted` flag. */
    purchasePrice: sizedOnAsIs ? num(app.as_is_value) : totalPrice,
    sellerPrice,
    isAssignment,
    // An empty as-is value defaults to the FINAL purchase price — leaving it
    // blank on the application means "worth what I'm paying for it". PURCHASE
    // ONLY: on a refinance there is no price to stand in for the value.
    asIsValue: sizedOnAsIs ? num(app.as_is_value) : (num(app.as_is_value) || totalPrice),
    // Display metadata only (engines ignore it): marks the value above as the
    // auto-default rather than an entered figure, so the studio prefill and the
    // registered-product panel never present it as if the borrower typed it. A
    // refinance never auto-defaults, so it is never "defaulted" there.
    asIsDefaulted: !sizedOnAsIs && !(num(app.as_is_value) > 0),
    /* Display metadata only. A refinance with no as-is value on file cannot be
       sized AT ALL — there is no denominator — so say so plainly rather than let
       a caller register a loan built on nothing. The register routes refuse on
       this; the studio already refuses client-side (`missingFields`). */
    asIsMissing: sizedOnAsIs && !(num(app.as_is_value) > 0),
    arv: num(app.arv),
    rehabBudget: num(app.rehab_budget),
    fico: num(app.fico),
    expFlips: experience ? num(experience.flips) : 0,
    expHolds: experience ? num(experience.holds) : 0,
    expGround: experience ? num(experience.ground) : 0,
    term: parseTermMonths(app.term),
    irMonths: num(app.requested_ir_months),
    // Interest reserve as an exact dollar amount — an alternative to months
    // (owner-directed 2026-07-12). When > 0 the engines use it directly as the
    // desired reserve; 0/absent falls back to the months path (no change).
    irAmount: num(app.requested_ir_amount),
    heavyRehab: /heavy|gut|ground/i.test(clean(app.rehab_type)),
    sqftAddition: /square|sf|addition|ground/i.test(clean(app.rehab_type)) || num(app.sqft_post) > num(app.sqft_pre),
    targetLTC: 0,
    // Sticky per-file markup (#101): once a file is registered with a per-file
    // markup override it is persisted on the application (db/109) and re-applied to
    // EVERY subsequent quote — staff live, borrower live, AND borrower register — so
    // a borrower can never reprice below the markup the file was structured at. A
    // live STAFF override (in `overrides`) still supersedes it below (staff has
    // authority); the borrower path never sends a markup, so the sticky value fully
    // governs their pricing. NULL/absent → falls through to the company default →
    // engine, exactly as before (unregistered / no-override files are unchanged).
    ...(app.file_markup_std_pct  != null ? { markupStdPct:  num(app.file_markup_std_pct) }  : {}),
    ...(app.file_markup_gold_pct != null ? { markupGoldPct: num(app.file_markup_gold_pct) } : {}),
    ...(app.file_markup_silver_pct != null ? { markupSilverPct: num(app.file_markup_silver_pct) } : {}),
    // Sticky per-file GOLD top-tier markup (item 15) — the studio's manual
    // top-tier section, persisted like the sticky whole-program markups above so
    // a re-quote never drops it. NULL/absent → the company per-tier default (or
    // the historic Gold Tier 1 = 0) governs, so existing files are unchanged.
    ...(app.file_markup_gold_t1_pct != null ? { markupGoldT1Pct: num(app.file_markup_gold_t1_pct) } : {}),
    // 1% closing-cost buffer waiver (db/390, owner-authorized 2026-07-31) —
    // file-owned; an admin waives it through its own audited endpoint.
    waiveLiqBuffer: !!app.liquidity_buffer_waived,
    // The existing loan being retired on a refinance. Read here (never in the
    // frozen engines) so cash-to-close can add the shortfall the borrower brings to
    // cover a payoff the funds-at-closing do not fully cover (owner-directed
    // 2026-08-04). Purchases carry no payoff; num('') is 0, so this is inert there.
    payoff: num(app.payoff_amount),
  };

  // Staff overrides win. Only copy known keys; coerce numeric fields.
  const NUMK = ['units', 'purchasePrice', 'sellerPrice', 'asIsValue', 'arv', 'rehabBudget',
    'fico', 'expFlips', 'expHolds', 'expGround', 'term', 'irMonths', 'irAmount', 'targetLTC',
    'ovrAcqLTV', 'ovrARLTV', 'ovrLTC', 'ovrRate',
    'markupStdPct', 'markupGoldPct', 'markupSilverPct',
    // Per-file GOLD TOP-TIER markup (owner item 15 — the studio's "manual section
    // for the top tier"). A percent; overlays the company per-tier default for the
    // Gold engine's Tier 1 only. Blank/absent leaves the historic Gold Tier 1 = 0
    // (or the company per-tier default if one is set) — so it never changes a file
    // that doesn't use it. See markupTiersFor().
    'markupGoldT1Pct',
    'origStdPct', 'origGoldPct', 'origSilverPct', 'origManualPct',
    'lenderFee', 'creditFee', 'appraisalFee', 'titleFee',
    'ovrAcqLTVPct', 'ovrARLTVPct', 'ovrLTCPct', 'ovrRatePct', 'ovrIrMonths', 'ovrEffPrice',
    // Out-of-pocket rehab exception (owner-authorized 2026-07-31): a dollar amount
    // of the rehab budget brought OUT OF POCKET so the initial advance can rise
    // toward the acquisition cap. Display/structure only — it re-slices an already-
    // sized loan (normalize()), never a leverage/rate/cap number. 0/absent → no change.
    'oopRehab'];
  const STRK = ['loanType', 'strategy', 'state', 'city', 'address', 'propertyType'];
  const BOOLK = ['cashOut', 'isAssignment', 'heavyRehab', 'sqftAddition', 'forcePrice', 'manualPricing',
    // "Raise the initial to max" toggle — use the full max out-of-pocket rehab
    // (exact, independent of any stale client-computed dollar). Pairs with oopRehab.
    'oopRehabMax'];
  const out = Object.assign({}, base);
  if (overrides && typeof overrides === 'object') {
    for (const k of NUMK) if (overrides[k] != null && overrides[k] !== '') out[k] = num(overrides[k]);
    for (const k of STRK) if (overrides[k] != null) out[k] = clean(overrides[k]);
    for (const k of BOOLK) if (overrides[k] != null) out[k] = !!overrides[k];
    // The property ADDRESS and CITY are FILE-OWNED. A studio override may FILL
    // them while the file has no address yet (address-TBD drafts), but may never
    // OVERWRITE the file's current address: a stale studio snapshot kept
    // re-registering — and the term sheet kept printing — an old address after
    // the file was corrected (owner-reported 2026-07-24: file said "392-394
    // Columbia Ave", the sheet still printed "392 Columbia Ave"). The file's
    // address always wins here. NOTE (audit): these are NOT display-only — the
    // frozen engines scan city+address text for the ineligible-city and
    // adverse-market checks (the caps themselves key off state) — which is
    // exactly why the property's REAL recorded location must govern that
    // detection, never a stale studio snapshot; the city-recovery ladder above
    // keeps the detection fed on every historical property_address shape.
    if (base.address) out.address = base.address;
    if (base.city) out.city = base.city;
    if (overrides.asIsValue != null && overrides.asIsValue !== '') out.asIsDefaulted = false;
    // The 1% closing-cost buffer WAIVER is FILE-OWNED (admin-set through its own
    // audited endpoint, owner-directed 2026-07-31) — a studio override can never
    // set or clear it; the file's recorded flag always governs.
    out.waiveLiqBuffer = !!app.liquidity_buffer_waived;
    // Present-but-EMPTY means "clear it" (owner-reported 2026-07-16: a field the
    // user blanked in the studio must never silently revert to the previously-
    // saved value on re-register): markup '' → drop the sticky file markup so
    // the company default governs; irMonths '' → 0 (no reserve requested) —
    // mirroring irAmount's existing blank-sends-0 contract.
    if (overrides.markupStdPct === '') delete out.markupStdPct;
    if (overrides.markupGoldPct === '') delete out.markupGoldPct;
    if (overrides.markupSilverPct === '') delete out.markupSilverPct;
    if (overrides.markupGoldT1Pct === '') delete out.markupGoldT1Pct;
    if (overrides.irMonths === '') out.irMonths = 0;
  }
  out.strategy = engineStrategy(out.strategy);   // override labels get the same normalization
  out.propertyType = normPropertyType(out.propertyType);   // override labels get normalized too
  /* RE-ASSERT THE REFINANCE INVARIANT AFTER OVERRIDES. `loanType` is itself an
     overridable key (the studio sends its own purpose), and `purchasePrice` is in
     NUMK — so without this a scenario that flipped the purpose to Refinance, or a
     stale studio payload carrying both a price and an as-is value, could hand the
     engine a refinance whose "purchase price" was a leftover purchase figure. On a
     refinance the two ARE one number by definition, so bind them rather than trust
     the caller to. A purchase is untouched. */
  if (sizesOnAsIsValue(out.loanType)) {
    out.purchasePrice = num(out.asIsValue);
    out.asIsDefaulted = false;
    out.asIsMissing = !(num(out.asIsValue) > 0);
  } else {
    // Nothing else changes on a purchase — deliberately not "helping" here, so
    // every existing purchase quote stays byte-identical (an explicit `0` as-is
    // override, for instance, still means 0 exactly as it always did).
    out.asIsMissing = false;
  }
  // The studio's property-type control only expresses "SFR (1 unit)" / "2-4 units",
  // so it can never represent a 5+/mixed-use/commercial building. If the FILE's real
  // recorded type is engine-ineligible, never let a studio-collapsed override launder
  // it into an eligible 1-4 type — the real ineligible type wins (findings #5/#6).
  if (isIneligiblePropertyType(app.property_type) && !isIneligiblePropertyType(out.propertyType)) {
    out.propertyType = normPropertyType(app.property_type);
  }
  // An admin's explicit percent override is converted to the engine's fraction
  // form whenever it is PRESENT — NOT only under manualPricing. A manually entered
  // note rate / leverage must ALWAYS be honored, never silently dropped so the deal
  // re-prices at the AUTO rate. Root cause of "I typed a 10.25 note rate and the
  // file shows 10.3 everywhere": 10.3 was the engine's auto-computed rate, and the
  // typed override was reaching buildInputs without the manualPricing flag (a
  // re-registered file whose stored inputs carried the override but not the flag),
  // so this gate discarded it. Only an admin can reach here with these keys
  // (sanitizeOverrides strips them for everyone else), so honoring a present value
  // is safe. manualPricing still governs force-pricing an otherwise-INELIGIBLE deal.
  if (Object.prototype.hasOwnProperty.call(out, 'ovrAcqLTVPct')) out.ovrAcqLTV = num(out.ovrAcqLTVPct) / 100;
  if (Object.prototype.hasOwnProperty.call(out, 'ovrARLTVPct')) out.ovrARLTV = num(out.ovrARLTVPct) / 100;
  if (Object.prototype.hasOwnProperty.call(out, 'ovrLTCPct')) out.ovrLTC = num(out.ovrLTCPct) / 100;
  if (Object.prototype.hasOwnProperty.call(out, 'ovrRatePct')) out.ovrRate = num(out.ovrRatePct) / 100;
  if (Object.prototype.hasOwnProperty.call(out, 'ovrIrMonths')) out.irMonths = num(out.ovrIrMonths);
  if (out.manualPricing) out.forcePrice = true;
  return out;
}

function hasInput(input, key) {
  return input && Object.prototype.hasOwnProperty.call(input, key) && input[key] != null && input[key] !== '';
}
function numberOverride(input, key, fallback) {
  return hasInput(input, key) ? num(input[key]) : fallback;
}
function percentOverride(input, key, fallbackFraction) {
  return hasInput(input, key) ? num(input[key]) / 100 : fallbackFraction;
}
function markupKeyFor(program) { return program === 'gold' ? 'markupGoldPct' : program === 'silver' ? 'markupSilverPct' : 'markupStdPct'; }
function markupOverride(input, program) {
  const key = markupKeyFor(program);
  return hasInput(input, key) ? num(input[key]) / 100 : null;
}
function setEngineMarkup(program, value) {
  const engine = program === 'gold' ? GSP : (program === 'silver' ? SVP : YSP);
  if (engine && typeof engine.setMarkup === 'function') engine.setMarkup(value);
}

/* PER-EXPERIENCE-TIER MARKUP (owner-directed item 15) — an OVERLAY on top of the
   frozen per-program markup, never a change to it. Two sources, per-tier:
     1) COMPANY defaults from the Pricing Admin Center — cd.markupTiers, shaped
        { standard:{1,2,3}, gold:{1,2,3}, silver:{1,2,3} } as PERCENTS (mirrors
        markupStdPct etc.). A manual product prices on the Standard engine, so it
        reads the 'standard' map — same normalization as markupKeyFor().
     2) A PER-FILE studio override for the Gold TOP tier (markupGoldT1Pct, the
        studio's "manual section for the top tier"), which wins for Gold Tier 1.
   Returns { tier: fraction } for ONLY the tiers actually configured, or null when
   nothing is set. null → setMarkupTiers is never called → the engine keeps its
   historic behavior byte-for-byte (Gold Tier 1 = 0, every other tier the base/
   override markup). A configured value is what makes Gold Tier 1 controllable —
   exactly the owner's "we don't even have an option to control the best tier". */
function tierMapKey(program) { return program === 'gold' ? 'gold' : program === 'silver' ? 'silver' : 'standard'; }
function markupTiersFor(program, input, cd) {
  const out = {};
  const comp = cd && cd.markupTiers && typeof cd.markupTiers === 'object' ? cd.markupTiers[tierMapKey(program)] : null;
  if (comp && typeof comp === 'object') {
    for (const t of [1, 2, 3]) {
      const v = comp[t];
      if (v != null && v !== '' && isFinite(num(v)) && num(v) >= 0) out[t] = num(v) / 100;
    }
  }
  // Per-file studio override for the Gold top tier wins over the company default —
  // but ONLY a valid, finite, non-negative value (same guard as the company path
  // above): a nonsensical negative must never clobber a configured company Gold
  // Tier-1 default. An invalid value falls through, so the company/historic value
  // governs.
  if (program === 'gold' && hasInput(input, 'markupGoldT1Pct')) {
    const t1 = num(input.markupGoldT1Pct);
    if (isFinite(t1) && t1 >= 0) out[1] = t1 / 100;
  }
  return Object.keys(out).length ? out : null;
}
function setEngineMarkupTiers(program, tiers) {
  const engine = program === 'gold' ? GSP : (program === 'silver' ? SVP : YSP);
  if (engine && typeof engine.setMarkupTiers === 'function') engine.setMarkupTiers(tiers);
}

/* ---- normalize an engine result into one UI-agnostic quote shape ---- */
function normalize(program, input, ev, ladder) {
  const s = ev.sizing || {};
  const cd = pricingSettings.current();   // company-wide defaults (or literals)
  // Origination default: per-file override → COMPANY default → engine constant.
  const engineOrigPct = (program === 'gold' ? (GSP.constants && GSP.constants.ORIG_PCT)
    : program === 'silver' ? (SVP && SVP.constants && SVP.constants.ORIG_PCT)
    : (YSP.constants && YSP.constants.ORIG_PCT)) || 0.0125;
  const companyOrigPct = program === 'gold' ? cd.origGoldPct : program === 'silver' ? cd.origSilverPct : cd.origStdPct;
  const defaultOrigPct = (companyOrigPct != null ? companyOrigPct / 100 : engineOrigPct);
  /* THE MANUAL PRODUCT HAS ITS OWN ORIGINATION KNOB (owner-directed 2026-07-30:
     "we don't have a word to enter origination fee for the manual program. We only
     can enter for all other programs, not for the manual program"). It prices on
     the Standard engine, so it has no company default and no engine constant of
     its own — a BLANK manual field means "use Standard", which is why the fallback
     below is `origStdPct` and not the bare default. That ordering is what keeps a
     file that only ever set a Standard override behaving exactly as it did before
     this key existed (including the accept-counter path, which writes the countered
     origination onto origStdPct/origGoldPct only). */
  const origKey = program === 'gold' ? 'origGoldPct'
    : program === 'silver' ? 'origSilverPct'
    : (program === 'manual' && hasInput(input, 'origManualPct')) ? 'origManualPct'
    : 'origStdPct';
  const origPct = percentOverride(input, origKey, defaultOrigPct);
  // Rounding policy (owner-directed 2026-07-09): the financed loan is reported in
  // WHOLE DOLLARS, floored DOWN — never lend more than the engine sized. The
  // reported breakdown must reconcile EXACTLY (initial advance + holdback +
  // financed reserve === total loan), so the initial and holdback are floored too
  // and the financed reserve absorbs the reconciling residual (when a reserve is
  // present; otherwise the initial advance absorbs it, so no phantom reserve
  // appears on a no-reserve deal). This mirrors the LOS, which floors both the
  // loan amount AND the initial. The engine's sizing math itself is unchanged —
  // this only floors/reconciles the reported figures.
  const totalLoan = Math.floor(num(s.totalLoan));
  let rehabHoldback = Math.floor(num(s.rehabLoan));
  let initialAdvance = Math.floor(num(s.acquisition));
  let financedReserve = 0;
  if (num(s.financedIR) > 0.5) financedReserve = Math.max(0, totalLoan - initialAdvance - rehabHoldback);
  else initialAdvance = Math.max(0, totalLoan - rehabHoldback);
  /* OUT-OF-POCKET REHAB EXCEPTION (owner-authorized 2026-07-31; the specific change:
     "re-slice an already-sized loan so the initial advance rises toward the
     acquisition-LTV cap and the displaced rehab is brought out of pocket — total
     loan, rate and every cap unchanged; byte-identical when the exception amount is
     zero"). This is DISPLAY/STRUCTURE ONLY: the frozen engine already sized the total
     and the default split (initial cut to keep rehab 100% financed); here we move X
     dollars from the rehab holdback into the initial advance, capped so the initial
     never exceeds its own acquisition-LTV ceiling A = maxAcqLTV × acqDenom and the
     holdback never goes negative. The total loan, note rate, LTC/ARV/acq caps and the
     financed reserve are untouched. `maxInitial`/`initialCut`/`maxOopRehab` are the
     two figures the Manual section shows BEFORE anything is entered. When no exception
     amount is supplied (requestedOop <= 0) every number below is identical to before. */
  // Use the EFFECTIVE acquisition cap the deal was sized at — pricedCeiling when the
  // engine splits it out (Silver), else caps (Standard/Gold) — matching the `caps`
  // mapping below and the engine's own A = maxAcqLTV × acqDenom.
  const maxInitial = Math.floor(Math.max(0, num(((ev.pricedCeiling || ev.caps) || {}).maxAcqLTV) * num(s.acqDenom)));
  const initialCut = Math.max(0, maxInitial - initialAdvance);         // how much the initial was cut below its cap
  const maxOopRehab = Math.max(0, Math.min(initialCut, rehabHoldback)); // biggest rehab we could push out of pocket
  const requestedOop = input.oopRehabMax ? maxOopRehab : Math.max(0, Math.floor(num(input.oopRehab)));
  const oopRehab = Math.max(0, Math.min(requestedOop, maxOopRehab));   // the applied exception amount
  if (oopRehab > 0) { initialAdvance += oopRehab; rehabHoldback -= oopRehab; }
  // The raised initial reduces the equity due at the table $-for-$; the out-of-pocket
  // rehab is funded during construction (a draw shortfall), NOT at closing — so it is
  // NOT in cash-to-close, but IS in the liquidity the borrower must show.
  const downPayment = Math.max(0, num(s.downPayment) - oopRehab);
  // Interest-only payment on the initial advance rises with the raised initial
  // (as-drawn accrual). Recomputed only under the exception; byte-identical otherwise.
  const initialPayment = oopRehab > 0 ? round2(initialAdvance * (num(ev.noteRate) / 12)) : num(s.initialPayment);
  const state = clean(input.state).toUpperCase();
  const title = YSTitle.estimate(state, totalLoan, input.loanType);
  const titleAutoTotal = num(title.total);
  // Title: per-file override → COMPANY flat title (if set) → per-state estimate.
  const titleOverridden = hasInput(input, 'titleFee');
  const titleTotal = titleOverridden ? num(input.titleFee)
    : (cd.titleFee != null ? num(cd.titleFee) : titleAutoTotal);
  // Flat fees: per-file override → COMPANY default → hardcoded literal.
  const lenderFee = numberOverride(input, 'lenderFee', cd.lenderFee != null ? cd.lenderFee : FEES.lender);
  const creditFee = numberOverride(input, 'creditFee', cd.creditFee != null ? cd.creditFee : FEES.credit);
  const appraisalFee = numberOverride(input, 'appraisalFee', cd.appraisalFee != null ? cd.appraisalFee : FEES.appraisal);
  const origination = totalLoan > 0 ? round2(totalLoan * origPct) : 0;
  const assignmentExcess = num(s.assignmentExcessOOP) || num(ev.assignment && ev.assignment.excessOOP);
  // Admin-managed extra closing fees (e.g. the NY settlement-agent fee) that apply
  // to this file's state — a real closing cost, so it's part of what's due at
  // close AND the liquidity to show (owner-directed 2026-07-17).
  const extraFeeList = pricingSettings.extraFeesForState(cd.extraFees, state);
  const extraFeesTotal = extraFeeList.reduce((a, f) => a + (num(f.amount) || 0), 0);
  const closingDueAtClose = round2(origination + lenderFee + creditFee + titleTotal + extraFeesTotal);
  /* REFINANCE CASH TO CLOSE (owner-directed 2026-08-04). On a purchase this is the
     down payment (equity) plus the closing costs. On a REFINANCE there is no down
     payment (the frozen engine returns downPayment=0 for a refi), and instead the
     borrower must bring whatever the funds-at-closing do not cover of the existing
     loan PAYOFF plus the closing costs. Funds-at-closing = the INITIAL ADVANCE only
     — a renovation refi's rehab holdback is released later in draws, so it never
     helps clear the payoff at the table. This is the exact mirror of the cash-OUT
     figure (payoff.js structuralCashOut = funded − payoff − closing): exactly one of
     {cash to the borrower, cash the borrower brings} is greater than zero. On the
     owner's example (initial 173,550, payoff 220,000, closing 10,254.38) it is
     max(0, 220,000 + 10,254.38 − 173,550) = 56,704.38. No frozen number moves —
     this is the reported cash-to-close only, and a purchase is byte-identical. */
  // Refinance by MEANING, not by an exact string — same test the engine uses to
  // pick its as-is denominator, so normalize can never disagree with what the
  // engine actually sized (owner-directed refinance hardening 2026-08-04).
  const isRefinanceDeal = sizesOnAsIsValue(input.loanType);
  const payoffAmount = isRefinanceDeal ? Math.max(0, num(input.payoff)) : 0;
  const fundedAtClose = initialAdvance;   // rehab holdback funds later, in draws
  const cashToClose = isRefinanceDeal
    ? Math.max(0, round2(payoffAmount + closingDueAtClose - fundedAtClose))
    : round2(downPayment + assignmentExcess + closingDueAtClose);
  let reserveRequirement = 0;
  let reserveBasis = '';
  let reserveMo = 0;
  let liquidityPct = null;
  if (totalLoan > 0) {
    if (program === 'gold') {
      liquidityPct = num(ev.liquidityPct) || 0.05;
      reserveRequirement = round2(totalLoan * liquidityPct);
      reserveBasis = `${(liquidityPct * 100).toFixed(1)}% of loan amount`;
    } else {
      reserveMo = reserveMonths(totalLoan);
      reserveRequirement = round2(num(s.fullPayment) * reserveMo);
      reserveBasis = `${reserveMo} months of full-payment interest reserves`;
    }
  }
  // Out-of-pocket rehab is funded over the construction period, not at the table, so
  // it is added to the liquidity the borrower must SHOW (not to cash-to-close). +0 by
  // default.
  //
  // CLOSING-COST BUFFER (owner-authorized liquidity change, 2026-07-31, in the
  // owner's own words: "add a buffer for extra closing costs … about 1% of the
  // loan amount — $500,000 loan → $5,000 buffer — extra cash to close that we
  // verify, because attorney charges and other charges should never leave us
  // running short"). 1% of the total loan, added to the liquidity the borrower
  // must SHOW — never to cash-to-close itself (it is a cushion we verify, not a
  // cost we charge). Waivable per file by an admin (applications.
  // liquidity_buffer_waived, db/390) — the waiver is file-owned, never a studio
  // override. Mirrored in web/v2/tools/termsheet.js (calc/calcGold/calcSilver).
  const closingBufferWaived = !!input.waiveLiqBuffer;
  const closingBuffer = closingBufferWaived || totalLoan <= 0 ? 0 : round2(totalLoan * 0.01);
  const liquidityRequired = round2(cashToClose + reserveRequirement + oopRehab + closingBuffer);
  /* THREE MEANINGS OF "MAX LEVERAGE", mapped to the reader that needs each one
     (engine contract split 2026-07-30, owner-reported).

     `quote.guidelines.caps` KEEPS ITS EXISTING MEANING — the EFFECTIVE ceiling this
     deal was sized and priced at. Every enforcement path already built on it
     (underwriting metrics, the structure underwriter, the Encompass reconcile, the
     file view) must keep measuring the registered loan against the ceiling it was
     actually approved at, so this mapping is deliberately behaviour-identical: the
     Silver engine now publishes that value as `pricedCeiling`, and every other engine
     still publishes it as `caps`.

     `quote.guidelines.programCaps` is NEW and is for DISPLAY only — the PROGRAM
     MAXIMUM this borrower profile can actually reach, already lowered to the highest
     leverage band the rate grid genuinely prices, and invariant to deal inputs. The
     owner: "the tier two cannot anytime get 92.5 even if it says that it's available
     because it doesn't price — so keep that tier at 85%", and "the Max LTC should
     never change … it shouldn't change based on what you're changing the interest
     reserve".

     `quote.guidelines.tierCaps` is the workbook Tier Grid row verbatim — the guideline
     document's own numbers, kept for audit/parity readers.
     Read-only: no number is computed here. */
  const shape = (c) => (c ? {
    maxLoan: num(c.maxLoan),
    minFico: num(c.minFico),
    maxAcqLtv: num(c.maxAcqLTV),
    maxArvLtv: num(c.maxARLTV),
    maxLtc: num(c.maxLTC),
  } : null);
  const caps = shape(ev.pricedCeiling || ev.caps);
  const programCaps = shape(ev.caps);
  const tierCaps = shape(ev.tierCaps);

  const quote = {
    program,
    programLabel: PROGRAM_LABEL[program],
    productLabel: ev.productLabel || null,
    kind: ev.kind || null,
    reserveEligible: ev.reserveEligible !== false,
    status: ev.status,
    eligible: ev.status !== 'INELIGIBLE',
    reasons: (ev.reasons || []).map((r) => ({ level: r.level, msg: r.msg })),
    tier: ev.tier || null,
    tierLabel: ev.tierLabel || null,
    noteRate: ev.noteRate != null ? ev.noteRate : null,
    origPct,
    origination,
    sizing: {
      totalLoan,
      initialAdvance,
      rehabHoldback,
      financedReserve,
      downPayment,
      assignmentExcessOOP: assignmentExcess,
      // Out-of-pocket rehab exception (owner-authorized 2026-07-31). `oopRehab` = the
      // applied EXCEPTION amount (0 = no exception). On the normal trigger (a total cap
      // cut the initial while rehab was 100% financed) this equals the tapes'/Encompass'
      // derived `rehab_budget − rehabHoldback`; on a pre-existing rehab-over-cap deal the
      // derived value can be larger (it also carries the capped-rehab excess), and this
      // field stays gated to the exception so cash-to-close is byte-identical without one.
      // `maxOopRehab`/`initialCut`/`maxInitial` are the figures the Manual section shows
      // before anything is entered.
      oopRehab,
      maxOopRehab,
      initialCut,
      maxInitial,
      initialPayment,
      monthlyPayment: num(s.fullPayment),
      ltcPct: num(s.ltcPct),
      acqLtvPct: num(s.acqLtvPct),
      arvPct: num(s.arvPct),
      maxReserve: num(s.maxReserve),
      costBasis: num(s.costBasis),
      binding: s.binding || '',
    },
    title: { total: titleTotal, premium: num(title.premium), fees: num(title.fees), known: !!title.known,
      autoTotal: titleAutoTotal, overridden: titleOverridden },
    closingCosts: {
      origination,
      lenderFee,
      creditFee,
      titleAndSettlement: titleTotal,
      extraFees: extraFeeList.map((f) => ({ name: f.name, amount: round2(num(f.amount)) })),
      dueAtClosing: closingDueAtClose,
      appraisalPoc: appraisalFee,
      totalIncludingPoc: round2(closingDueAtClose + appraisalFee),
    },
    cashToClose,
    // Refinance breakdown so every surface can explain the cash-to-close correctly
    // (payoff + closing − funds at closing) instead of the purchase "down payment +
    // closing" wording. null on a purchase. Owner-directed 2026-08-04.
    refi: isRefinanceDeal ? {
      payoff: payoffAmount,
      fundedAtClose,
      closing: closingDueAtClose,
      shortfall: cashToClose,   // == max(0, payoff + closing − fundedAtClose) — what the borrower BRINGS
      // The MIRROR: what the borrower RECEIVES when the funds advanced exceed the
      // payoff + closing (a cash-out). Exactly one of {shortfall, cashOut} is > 0,
      // so a cash-out refi carries a real "cash to you" figure instead of the $0
      // cash-to-close that a purchase-shaped reading produced. This is the STRUCTURAL
      // figure (the sized loan implies it); a per-file typed override lives on
      // applications.estimated_cash_out and is applied by payoff.js above this.
      cashOut: round2(Math.max(0, fundedAtClose - payoffAmount - closingDueAtClose)),
    } : null,
    reserveRequirement,
    reserveMonths: reserveMo,
    reserveBasis,
    liquidityPct,
    closingBuffer,
    closingBufferWaived,
    liquidityRequired,
    assignment: ev.assignment || null,
    ladder: ladder || null,
    liquidity: liquidityRequired,
    guidelines: {
      caps,             // EFFECTIVE — what this deal was sized/priced at (enforcement)
      programCaps,      // PROGRAM MAXIMUM this profile can reach (display; fixed)
      tierCaps,         // the workbook Tier Grid row, verbatim (audit / parity)
      // the engine's own sentence explaining why this deal's ceiling sits under the
      // program maximum (Silver's grid step-down tags it `leverage_capped`)
      leverageCappedWhy: (ev.reasons || []).filter((r) => r && r.code === 'leverage_capped').map((r) => r.msg).join(' ') || null,
      tierLabel: ev.tierLabel || null,
      binding: (s && s.binding) || '',
      reserveRequirement,
      reserveMonths: reserveMo,
      reserveBasis,
      liquidityPct,
      drawFee: num(ev.drawFee),
      irRequired: !!ev.irRequired,
      irLocked: !!ev.irLocked,
      reserveCapped: !!s.reserveCapped,
      reserveCapBy: s.reserveCapBy || '',
      maxReserveMonths: num(s.maxReserveMonths),
      heavyRehab: !!ev.heavy,
      sqftAddition: !!ev.sqft,
    },
    adminPricing: {
      markupPct: hasInput(input, markupKeyFor(program))
        ? num(input[markupKeyFor(program)]) : null,
      origPct: origPct * 100,
      lenderFee,
      creditFee,
      appraisalFee,
      titleFee: titleOverridden ? titleTotal : null,
      manualPricing: !!input.forcePrice,
    },
  };
  return quote;
}

/* ---- quote one program (no persistence) ----
   The MANUAL program prices on the SAME frozen STANDARD (Fidelis) engine — the
   manual leverage (ovrAcqLTV/ovrARLTV/ovrLTC) rides in on `input`, and the
   reserve / markup / origination defaults follow the Standard program (the
   normalize()/markup helpers all treat any non-'gold' program as Standard). Only
   the program TAG and label differ, so the guidelines stay Standard's. */
function quoteProgram(program, input) {
  if (!enginesReady()) throw new Error('pricing engines unavailable' + (loadErr ? ': ' + loadErr : ''));
  // Markup: per-file override → COMPANY default → engine's built-in markup.
  // Applied through the SAME frozen setMarkup hook and reset in finally — the
  // engine math is never changed, only which markup input it runs with.
  const cd = pricingSettings.current();
  let m = markupOverride(input, program);
  if (m == null) {
    const companyMarkup = program === 'gold' ? cd.markupGoldPct : program === 'silver' ? cd.markupSilverPct : cd.markupStdPct;
    if (companyMarkup != null) m = num(companyMarkup) / 100;
  }
  if (m != null) setEngineMarkup(program, m);
  // Per-tier markup overlay (item 15). Inert when nothing is configured, so an
  // unconfigured file prices byte-for-byte as before. Reset in each finally,
  // exactly like setEngineMarkup — the engine is only ever "hot" during a quote.
  const tiers = markupTiersFor(program, input, cd);
  if (tiers) setEngineMarkupTiers(program, tiers);
  if (program === 'silver') {
    // The Silver program prices on its own frozen engine (EMCAP grid). Its
    // ladder varies by LTC band exactly like Standard's, so it ships one too.
    try {
      const ev = SVP.evaluate(input);
      if (input.forcePrice && ev.status === 'INELIGIBLE') { ev.status = 'MANUAL'; ev.exitShortfall = 0; }
      let ladder = null;
      try {
        const pl = SVP.priceLadder(input);
        if (pl && pl.eligible && pl.rows && pl.rows.length) {
          ladder = { maxLtc: pl.maxLtc, binding: pl.binding, rows: pl.rows };
        }
      } catch (_) { /* ladder is best-effort */ }
      return normalize('silver', input, ev, ladder);
    } finally {
      if (m != null) setEngineMarkup(program, null);
      if (tiers) setEngineMarkupTiers(program, null);
    }
  }
  if (program === 'gold') {
    try {
      const ev = GSP.evaluate(input);
      if (input.forcePrice && ev.status === 'INELIGIBLE') { ev.status = 'MANUAL'; ev.exitShortfall = 0; }
      return normalize('gold', input, ev, null);
    } finally {
      if (m != null) setEngineMarkup(program, null);
      if (tiers) setEngineMarkupTiers(program, null);
    }
  }
  try {
    const ev = YSP.evaluate(input);
    if (input.forcePrice && ev.status === 'INELIGIBLE') { ev.status = 'MANUAL'; ev.exitShortfall = 0; }
    let ladder = null;
    try {
      const pl = YSP.priceLadder(input);
      if (pl && pl.eligible && pl.rows && pl.rows.length) {
        ladder = { maxLtc: pl.maxLtc, maxBucket: pl.maxBucket, binding: pl.binding, rows: pl.rows };
      }
    } catch (_) { /* ladder is best-effort */ }
    // Tag with the real program ('standard' or 'manual') — a manual product
    // prices on this Standard engine but is labeled/recorded as Manual.
    return normalize(program === 'manual' ? 'manual' : 'standard', input, ev, ladder);
  } finally {
    if (m != null) setEngineMarkup(program, null);
    if (tiers) setEngineMarkupTiers(program, null);
  }
}

/* ---- quote both programs for a file (panel default) ---- */
function quoteAll(app, experience, overrides) {
  const input = buildInputs(app, experience, overrides);
  const standard = safeQuote('standard', input);
  const gold = safeQuote('gold', input);
  const silver = safeQuote('silver', input);
  return { inputs: input, standard, gold, silver };
}

function safeQuote(program, input) {
  try { return quoteProgram(program, input); }
  catch (e) { return { program, programLabel: PROGRAM_LABEL[program], status: 'ERROR', eligible: false, reasons: [{ level: 'INELIGIBLE', msg: e.message || 'pricing error' }], sizing: null }; }
}

// Optimistic-concurrency fingerprint of the FILE-owned pricing basis. GET
// /pricing hands it to the studio; register refuses (409) when the file's
// economics moved in between — so a stale studio session (long-open tab, old
// autosave, an edit that landed from the form/ClickUp while the sheet was open)
// can never silently re-register OLD economics and write them back onto the
// file (root-caused 2026-07-17: LO re-registers were clobbering later file
// edits with the previously-registered scenario). Only file-owned inputs that
// buildInputs reads participate — registration itself rewrites several of them,
// so a fresh GET is required after every register (the panel already reloads).
function econVersionFor(app) {
  const crypto = require('crypto');
  const f = (v) => {
    if (v == null || v === '') return '';
    if (typeof v === 'boolean') return v ? '1' : '0';
    const n = Number(v);
    return isFinite(n) && String(v).trim() !== '' && /^-?[\d.]+$/.test(String(v).trim()) ? String(n) : String(v).trim().toLowerCase();
  };
  const basis = [
    app.purchase_price, app.as_is_value, app.arv, app.rehab_budget,
    app.term, app.requested_ir_months, app.requested_ir_amount,
    app.requested_exp_flips, app.requested_exp_holds, app.requested_exp_ground,
    app.is_assignment, app.underlying_contract_price, app.assignment_fee,
    app.program, app.loan_type, app.property_type, app.units,
    // Also file-owned pricing inputs buildInputs reads (audit 2026-07-17):
    // rehab scope, sqft addition, the property STATE (title cost/eligibility),
    // the file's pricing FICO (computed onto f.app by loadFileForPricing), and
    // the sticky per-file markups.
    app.rehab_type, app.sqft_pre, app.sqft_post,
    (app.property_address && app.property_address.state) || '',
    app.fico, app.file_markup_std_pct, app.file_markup_gold_pct, app.file_markup_silver_pct,
    app.file_markup_gold_t1_pct,   // sticky per-file Gold top-tier markup (item 15) — a fingerprinted sibling

    // The Silver engine keys geography off the ZIP too (exclusions + NYC market).
    (app.property_address && (app.property_address.zip || app.property_address.postal_code)) || '',
  ].map(f).join('|');
  return crypto.createHash('sha1').update(basis).digest('hex').slice(0, 16);
}

module.exports = {
  enginesReady, loadErr: () => loadErr,
  buildInputs, quoteProgram, quoteAll, parseTermMonths, PROGRAM_LABEL,
  econVersionFor,
};
