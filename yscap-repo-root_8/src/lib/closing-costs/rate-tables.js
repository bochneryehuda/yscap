'use strict';
/* =====================================================================
   rate-tables.js — the government charges a BORROWER pays at an RTL
   closing, as DATA: rates, thresholds, who pays, and where each number
   came from.

   WHY THIS EXISTS. Owner-directed 2026-08-23:

     *"In our title, estimated costs that we have right now are helping us to
     calculate closing costs and cash to close … New York City mortgage tax
     needs to be a line item calculated separately. New York State mortgage tax
     is a little cheaper. Pennsylvania, Pittsburgh, and Philadelphia … have a
     transfer tax … Florida has some mortgage tax. There are a lot of other
     states that have this kind of stuff that the buyer needs to pay, either
     transfer tax or mortgage tax, which should all be implemented into our
     automatic calculator … Please do a lot of research on how to enhance that
     automatic calculation and how we can make sure that we're not falling short
     on cash to close."*

   WHAT WAS ACTUALLY MISSING. `web/tools/title-cost.js` estimates the title
   PREMIUM and the settlement/search/recording BUNDLE, and says so in its own
   header: *"What's EXCLUDED (intentionally): real-estate transfer taxes,
   mortgage / recordation taxes, owner's title policy, and any survey."* Those
   exclusions are not small. On a $600,000 NYC loan the mortgage recording tax
   alone is about $11,550 the borrower has to bring and the quote never
   mentioned — an order of magnitude larger than every fee the estimate DID
   carry. "Not falling short on cash to close" is exactly this hole.

   ── WHY A TABLE, AND WHY IT LOOKS LIKE THIS ─────────────────────────────────

   Every entry carries `rate`, `basis`, `payer`, `authority` and `asOf`, because
   a tax rate with no source and no date is a number nobody can ever check, and
   the one thing guaranteed about this data is that it CHANGES (Philadelphia's
   local rate moved on 2025-07-01; Cortland County's moved on 2025-01-01). A
   table with citations can be audited and corrected in one place by somebody who
   is not a programmer. Constants sprinkled through a calculator cannot.

   `confidence` is on every jurisdiction ON PURPOSE, and it is not decoration:
     'verified'  — the rate was read from the taxing authority or a primary
                   source and is stated here with its citation.
     'secondary' — read from a reliable secondary source (a title underwriter's
                   published table, a state bar guide). Good enough to quote from
                   with the estimate disclaimer, not good enough to stop checking.
     'default'   — WE DO NOT KNOW this county and are applying the state's
                   conservative fallback. The estimate SAYS SO, out loud, on the
                   quote. An estimate that silently guesses is worse than one that
                   admits what it does not know, because only the second one gets
                   checked before the borrower is told what to wire.

   ── THE THREE RULES THAT KEEP AN ESTIMATE FROM FALLING SHORT ────────────────

   1. UNKNOWN RESOLVES TO THE MOST EXPENSIVE PLAUSIBLE CASE, never the cheapest
      and never zero. A borrower who is told $4,000 and owes $9,000 cannot close;
      one told $9,000 who owes $4,000 gets money back at the table. The errors are
      not symmetric, so the default must not be either. Every `default` entry here
      is the HIGH end of that state's real range.
   2. ROUND UP TO THE STATUTORY INCREMENT. These taxes are almost never computed
      on the exact dollar: Florida taxes each $100 "or fraction thereof", Maryland
      each $500, New York rounds the tax itself up to the dollar. Rounding down —
      or ignoring the increment — is a guaranteed shortfall, every time, by
      construction.
   3. SAY WHO PAYS, PER JURISDICTION. New York's 0.25% "special additional tax"
      is the LENDER's by statute on a 1-6 family residence (Tax Law § 253(1-a)),
      so putting it in the borrower's cash-to-close overstates by 0.25% of the
      loan; leaving it out of the company's own cost understates what WE pay.
      Both are wrong in different directions, so `payer` is a field, not an
      assumption.

   NOTHING HERE IS A QUOTE. These are planning estimates for cash-to-close. The
   settlement agent issues the binding figures, and the engine says so on every
   result it produces.
   ===================================================================== */

/* The increments these taxes are actually computed on. "or fraction thereof" is
   the statutory language in most of them, which means ROUND UP — the whole
   increment is owed the moment a single dollar falls into it. */
const TAXABLE_UNIT = { FL: 100, MD: 500, AL: 100, TN: 100, GA: 500, VA: 100, OK: 100, MN: 1, NY: 1, PA: 1, DEFAULT: 1 };

/* =====================================================================
   MORTGAGE / RECORDATION / INTANGIBLE TAX — a tax on the LOAN, owed on a
   PURCHASE AND ON A REFINANCE ALIKE. That is what separates it from a transfer
   tax and why it cannot be folded into one number: a refinance in New York owes
   the mortgage tax and no transfer tax at all.

   `rate` is a fraction of the recorded mortgage amount unless `perUnit` says
   otherwise. Only states that actually levy one appear; everywhere else the
   engine reports $0 with a note, which is a real answer rather than a silence.
   ===================================================================== */
const MORTGAGE_TAX = {
  /* NEW YORK — the big one, and the one the owner called out first.
     Structure (Tax Law §§ 253, 253-a, 255): a 0.50% BASIC tax, a 0.25% SPECIAL
     ADDITIONAL tax, a 0.30% ADDITIONAL tax inside the Metropolitan Commuter
     Transportation District, plus county local-option taxes — which is why the
     total is a per-county number and not a state number.

     THE SPECIAL ADDITIONAL 0.25% IS THE LENDER'S on a 1-6 family residence
     (§ 253(1-a)(a)); above six units it falls on the borrower with everything
     else. Modelled as `lenderPaysSpecialAdditional`, so the borrower's line and
     the company's own cost are each right instead of one of them being wrong.

     THE $30: a 1-2 family dwelling deducts the first $10,000 of principal from
     the MCTD additional tax — $10,000 x 0.30% = $30. Small, and it is a real
     line on a real closing statement, so it is here rather than rounded away. */
  NY: {
    kind: 'mortgage_recording_tax',
    authority: 'NY Tax Law §§ 253, 253-a, 255; NY State Dept. of Taxation & Finance county rate schedule',
    asOf: '2026-01-01',
    lenderPaysSpecialAdditional: true,
    specialAdditionalRate: 0.0025,
    lenderPaysUpToUnits: 6,
    oneTwoFamilyCredit: 30,          // the $10,000 MCTD exemption, in dollars
    // Total combined rate (borrower + lender) by county. NYC is handled by
    // `nycTiers` below because its rate depends on the loan size AND the class.
    byCounty: {
      // NYC — five boroughs, tiered. `nycTiers` is the real schedule.
      'NEW YORK': { nyc: true }, KINGS: { nyc: true }, QUEENS: { nyc: true },
      BRONX: { nyc: true }, RICHMOND: { nyc: true },
      // MCTD suburbs (basic 0.50 + special 0.25 + MCTD 0.30) with local options.
      NASSAU: { total: 0.0105, confidence: 'secondary' },
      SUFFOLK: { total: 0.0105, confidence: 'secondary' },
      WESTCHESTER: { total: 0.0105, confidence: 'secondary' },
      ROCKLAND: { total: 0.0105, confidence: 'secondary' },
      PUTNAM: { total: 0.0105, confidence: 'secondary' },
      ORANGE: { total: 0.0105, confidence: 'secondary' },
      DUTCHESS: { total: 0.0105, confidence: 'secondary' },
      // Verified from the state's own county bulletins.
      CORTLAND: { total: 0.0125, confidence: 'verified', authority: 'NYS Tax Dept. mortgage tax bulletin, Cortland County, eff. 2025-01-01' },
      CHENANGO: { total: 0.0100, confidence: 'verified', authority: 'NYS Tax Dept. mortgage tax bulletin, Chenango County, eff. 2025-01-01' },
      // Common upstate counties at the ordinary 1.00% combined rate.
      ERIE: { total: 0.0100, confidence: 'secondary' },
      MONROE: { total: 0.0100, confidence: 'secondary' },
      ONONDAGA: { total: 0.0100, confidence: 'secondary' },
      ALBANY: { total: 0.0100, confidence: 'secondary' },
      BROOME: { total: 0.0100, confidence: 'secondary' },
      NIAGARA: { total: 0.0100, confidence: 'secondary' },
      ONEIDA: { total: 0.0100, confidence: 'secondary' },
      SCHENECTADY: { total: 0.0100, confidence: 'secondary' },
      RENSSELAER: { total: 0.0100, confidence: 'secondary' },
      SARATOGA: { total: 0.0100, confidence: 'secondary' },
      ULSTER: { total: 0.0100, confidence: 'secondary' },
      SULLIVAN: { total: 0.0100, confidence: 'secondary' },
    },
    /* Unknown NY county → 1.25%, the top of the non-NYC range we have measured
       (Cortland). Deliberately NOT the 0.75% floor: see rule 1. */
    defaultTotal: 0.0125,
    /* NEW YORK CITY, by loan size and property class. Published combined rates;
       the borrower's share is the total less the lender's 0.25% on a residence
       of six units or fewer. */
    nycTiers: [
      { maxUnits: 3, under: 500000, total: 0.0205, label: 'NYC — 1-3 family / condo, loan under $500k' },
      { maxUnits: 3, atLeast: 500000, total: 0.02175, label: 'NYC — 1-3 family / condo, loan $500k+' },
      { maxUnits: Infinity, under: 500000, total: 0.0205, label: 'NYC — all other property, loan under $500k' },
      { maxUnits: Infinity, atLeast: 500000, total: 0.0280, label: 'NYC — all other property, loan $500k+' },
    ],
  },

  /* FLORIDA — two separate taxes on the same loan, and quoting only one of them
     understates by more than a third. Documentary stamp tax on the NOTE at
     $0.35 per $100 or fraction (§ 201.08), AND the non-recurring intangible tax
     on the MORTGAGE at 2 mills (§ 199.133). By Florida custom the buyer pays
     both; the seller pays the deed stamps. */
  FL: {
    kind: 'doc_stamps_and_intangible',
    authority: 'Fla. Stat. §§ 201.08 (documentary stamp tax on notes), 199.133 (non-recurring intangible tax)',
    asOf: '2026-01-01',
    confidence: 'verified',
    docStampPer100: 0.35,
    intangibleRate: 0.002,
    /* The doc stamp on a note is CAPPED at $2,450 — but ONLY for a note not
       secured by Florida real property. A mortgage note is secured, so the cap
       does NOT apply here. Recorded because getting this backwards is the classic
       Florida error, in both directions. */
    docStampCapApplies: false,
  },

  /* Flat-rate mortgage/recordation states. Each is a rate on the recorded debt,
     paid by the borrower, on a purchase and a refinance alike. */
  AL: { kind: 'recordation_tax', rate: 0.0015, authority: 'Ala. Code § 40-22-2 — $0.15 per $100 of indebtedness', asOf: '2026-01-01', confidence: 'verified' },
  TN: { kind: 'recordation_tax', rate: 0.00115, exemptFirst: 2000, authority: 'Tenn. Code § 67-4-409 — $0.115 per $100, first $2,000 exempt', asOf: '2026-01-01', confidence: 'verified' },
  VA: { kind: 'recordation_tax', rate: 0.0025, authority: 'Va. Code § 58.1-803 — $0.25 per $100 (state); localities may add', asOf: '2026-01-01', confidence: 'secondary' },
  OK: { kind: 'mortgage_tax', rate: 0.0010, flatAdd: 5, authority: 'Okla. Stat. tit. 68 § 1904 — $0.10 per $100 for a term of 5 years or more, plus a $5 certification fee', asOf: '2026-01-01', confidence: 'secondary' },
  MN: { kind: 'mortgage_registry_tax', rate: 0.0023, authority: 'Minn. Stat. § 287.035 — 0.0023 of the debt secured', asOf: '2026-01-01', confidence: 'verified' },
  GA: { kind: 'intangible_recording_tax', rate: 0.003, cap: 25000, authority: 'Ga. Code § 48-6-61 — $1.50 per $500 of the note, capped at $25,000', asOf: '2026-01-01', confidence: 'verified' },
  /* MARYLAND — a state transfer tax AND a county recordation tax, both on the
     same closing, and the county rate is the larger of the two. The recordation
     tax is levied on the CONSIDERATION on a purchase and on the DEBT on a
     refinance, so it belongs to both tables; here it is carried as a mortgage-side
     tax and the transfer table carries the state's 0.5%. */
  MD: {
    kind: 'recordation_tax', asOf: '2026-01-01', confidence: 'secondary',
    authority: 'Md. Tax-Prop. § 12-103 — county recordation tax, per $500 of consideration or debt',
    byCounty: {
      BALTIMORE_CITY: { per500: 5.00 },
      MONTGOMERY: { per500: 5.05 },
      TALBOT: { per500: 6.00 },
      "PRINCE GEORGE'S": { per500: 2.75 },
      'PRINCE GEORGES': { per500: 2.75 },
      BALTIMORE: { per500: 2.50 },
      ANNE_ARUNDEL: { per500: 3.50 },
      HOWARD: { per500: 2.50 },
    },
    // Unknown Maryland county → the top of the observed range. See rule 1.
    defaultPer500: 6.00,
  },
  /* DISTRICT OF COLUMBIA — a recordation tax on the deed AND, for a commercial
     borrower, on the security instrument. Modelled on the transfer side. */
};

/* =====================================================================
   TRANSFER / DEED TAX — a tax on the CONVEYANCE. It is owed on a PURCHASE and
   NOT on a refinance (there is no deed), which is the single most important
   structural fact about it and the reason it is a separate table.

   `buyerShare` is the LOCAL CUSTOM, not a law: in almost every state the parties
   are jointly liable and the contract decides. It is the default the estimate
   starts from and it is overridable per file, because the purchase contract —
   not a table — is what actually governs any particular deal.
   ===================================================================== */
const TRANSFER_TAX = {
  /* PENNSYLVANIA — the owner named it: *"Pennsylvania, Pittsburgh, and
     Philadelphia, I think, have a transfer tax of 50% on the buyer."* That is
     the custom (a 50/50 split), and the local rates are the part that bites: the
     Commonwealth takes 1%, and the municipality + school district take theirs on
     top, so Philadelphia and Pittsburgh land near 4.6% and 5% of the PRICE. On a
     $400,000 Philadelphia purchase the buyer's half alone is about $9,156. */
  PA: {
    stateRate: 0.01, buyerShare: 0.5, asOf: '2026-01-01', confidence: 'secondary',
    authority: '72 P.S. § 8102-C (Commonwealth 1%); municipal + school district rates set locally',
    byCity: {
      PHILADELPHIA: { localRate: 0.03578, confidence: 'verified', asOf: '2025-07-01',
        authority: 'Philadelphia Code § 19-1400 — local realty transfer tax raised to 3.578% effective 2025-07-01 (total 4.578% with the Commonwealth 1%)' },
      PITTSBURGH: { localRate: 0.04, confidence: 'secondary', asOf: '2020-02-01',
        authority: 'City of Pittsburgh 3.0% + School District 1.0% (total 5.0% with the Commonwealth 1%), eff. 2020-02-01' },
    },
    // Elsewhere in Pennsylvania the local rate is customarily 1% (municipality +
    // school district combined). Conservative and typical.
    defaultLocalRate: 0.01,
  },

  /* NEW YORK — state RETT, the NYC RPTT on top inside the city, and the MANSION
     TAX, which is the BUYER's and is the one people forget. It starts at $1M and
     climbs; on a $1.5M NYC purchase it is $18,750 of the buyer's own money. */
  NY: {
    stateRate: 0.004, buyerShare: 0, asOf: '2026-01-01', confidence: 'secondary',
    authority: 'NY Tax Law § 1402 — $2 per $500 (0.4%); 0.65% on residential over $3M',
    stateHighRate: 0.0065, stateHighOver: 3000000,
    byCity: {
      'NEW YORK CITY': {
        confidence: 'secondary',
        authority: 'NYC Admin. Code § 11-2102 — RPTT: residential 1% under $500k, 1.425% at/over $500k; commercial 1.425% under $500k, 2.625% at/over $500k',
        tiers: [
          { residential: true, under: 500000, rate: 0.01 },
          { residential: true, atLeast: 500000, rate: 0.01425 },
          { residential: false, under: 500000, rate: 0.01425 },
          { residential: false, atLeast: 500000, rate: 0.02625 },
        ],
      },
    },
    /* THE MANSION TAX IS THE BUYER'S, by statute (Tax Law § 1402-a) — the one
       piece of New York transfer tax that lands squarely in cash to close. */
    mansion: {
      payer: 'borrower',
      authority: 'NY Tax Law § 1402-a — 1% at $1M, graduated to 3.9% at $25M (NYC / statewide residential)',
      asOf: '2026-01-01', confidence: 'secondary',
      bands: [
        { atLeast: 1000000, rate: 0.010 },
        { atLeast: 2000000, rate: 0.0125 },
        { atLeast: 3000000, rate: 0.015 },
        { atLeast: 5000000, rate: 0.0225 },
        { atLeast: 10000000, rate: 0.0325 },
        { atLeast: 15000000, rate: 0.035 },
        { atLeast: 20000000, rate: 0.0375 },
        { atLeast: 25000000, rate: 0.039 },
      ],
    },
  },

  // Customarily seller-paid states, carried so the engine can SAY the buyer owes
  // nothing rather than say nothing at all — "0, and here is why" is an answer.
  FL: { stateRate: 0.007, buyerShare: 0, asOf: '2026-01-01', confidence: 'verified',
    authority: 'Fla. Stat. § 201.02 — $0.70 per $100 on the deed ($0.60 in Miami-Dade, plus a $0.45 surtax on non-single-family); customarily seller-paid',
    byCounty: { 'MIAMI-DADE': { stateRate: 0.006, surtaxNonSingleFamily: 0.0045, confidence: 'verified' } } },
  MD: { stateRate: 0.005, buyerShare: 0.5, asOf: '2026-01-01', confidence: 'secondary',
    authority: 'Md. Tax-Prop. § 13-203 — 0.5% state transfer tax; customarily split; county transfer taxes may apply on top' },
  DC: { stateRate: 0.011, buyerShare: 1, asOf: '2026-01-01', confidence: 'secondary',
    authority: 'D.C. Code § 42-1103 — 1.1% recordation tax (buyer) under $400k, 1.45% at/over; a matching transfer tax falls on the seller' },
  DE: { stateRate: 0.04, buyerShare: 0.5, asOf: '2026-01-01', confidence: 'secondary',
    authority: 'Del. Code tit. 30 § 5402 — 4% combined state + local; customarily split' },
  CT: { stateRate: 0.0075, buyerShare: 0, asOf: '2026-01-01', confidence: 'secondary',
    authority: 'Conn. Gen. Stat. § 12-494 — 0.75% state (higher tiers above $800k) plus a municipal share; seller-paid' },
  NJ: { stateRate: 0.01, buyerShare: 0, asOf: '2026-01-01', confidence: 'secondary',
    authority: 'N.J.S.A. 46:15-7 — graduated realty transfer fee, seller-paid; a 1% "mansion fee" on residential over $1M is the BUYER\'s',
    buyerMansion: { over: 1000000, rate: 0.01 } },
  MA: { stateRate: 0.00456, buyerShare: 0, asOf: '2026-01-01', confidence: 'secondary',
    authority: 'Mass. Gen. Laws ch. 64D — $4.56 per $1,000 excise; seller-paid' },
  GA: { stateRate: 0.001, buyerShare: 0, asOf: '2026-01-01', confidence: 'secondary',
    authority: 'Ga. Code § 48-6-1 — $1.00 per $1,000; seller-paid' },
  IL: { stateRate: 0.001, buyerShare: 0, asOf: '2026-01-01', confidence: 'secondary',
    authority: '35 ILCS 200/31-10 — $0.50 per $500 state + $0.25 per $500 county; Chicago adds a large municipal tax split between the parties' },
  SC: { stateRate: 0.0037, buyerShare: 0, asOf: '2026-01-01', confidence: 'secondary',
    authority: 'S.C. Code § 12-24-10 — $1.85 per $500; seller-paid' },
  VA: { stateRate: 0.0025, buyerShare: 1, asOf: '2026-01-01', confidence: 'secondary',
    authority: 'Va. Code § 58.1-801 — $0.25 per $100 grantor tax is the seller\'s; the recordation tax on the deed is the BUYER\'s' },
  WA: { stateRate: 0.0128, buyerShare: 0, asOf: '2026-01-01', confidence: 'secondary',
    authority: 'RCW 82.45 — graduated REET from 1.1% to 3.0%, plus local; seller-paid' },
  MI: { stateRate: 0.0086, buyerShare: 0, asOf: '2026-01-01', confidence: 'secondary',
    authority: 'MCL 207.523 — $3.75/$500 state + $0.55/$500 county; seller-paid' },
  OH: { stateRate: 0.001, buyerShare: 0, asOf: '2026-01-01', confidence: 'secondary',
    authority: 'Ohio Rev. Code § 319.54 — $1 per $1,000 plus a permissive county rate; seller-paid' },
  // Explicit "no state transfer tax" — an answer, not an omission.
  TX: { none: true, asOf: '2026-01-01', confidence: 'verified', authority: 'Texas levies no real-estate transfer tax' },
  AZ: { none: true, asOf: '2026-01-01', confidence: 'verified', authority: 'Arizona levies no real-estate transfer tax (a $2 affidavit fee only)' },
  MO: { none: true, asOf: '2026-01-01', confidence: 'verified', authority: 'Missouri levies no real-estate transfer tax' },
  IN: { none: true, asOf: '2026-01-01', confidence: 'verified', authority: 'Indiana levies no real-estate transfer tax' },
  MS: { none: true, asOf: '2026-01-01', confidence: 'verified', authority: 'Mississippi levies no real-estate transfer tax' },
  NM: { none: true, asOf: '2026-01-01', confidence: 'verified', authority: 'New Mexico levies no real-estate transfer tax' },
  ND: { none: true, asOf: '2026-01-01', confidence: 'verified', authority: 'North Dakota levies no real-estate transfer tax' },
  MT: { none: true, asOf: '2026-01-01', confidence: 'verified', authority: 'Montana levies no real-estate transfer tax' },
  WY: { none: true, asOf: '2026-01-01', confidence: 'verified', authority: 'Wyoming levies no real-estate transfer tax' },
  AL: { stateRate: 0.001, buyerShare: 0, asOf: '2026-01-01', confidence: 'secondary',
    authority: 'Ala. Code § 40-22-1 — $0.50 per $500 on the deed; seller-paid' },
  NC: { stateRate: 0.002, buyerShare: 0, asOf: '2026-01-01', confidence: 'secondary',
    authority: 'N.C. Gen. Stat. § 105-228.30 — $1 per $500; seller-paid' },
  TN: { stateRate: 0.0037, buyerShare: 1, asOf: '2026-01-01', confidence: 'secondary',
    authority: 'Tenn. Code § 67-4-409 — $0.37 per $100 on the deed; customarily the BUYER\'s' },
  MN: { stateRate: 0.0033, buyerShare: 0, asOf: '2026-01-01', confidence: 'secondary',
    authority: 'Minn. Stat. § 287.21 — 0.33% deed tax; seller-paid' },
  CO: { stateRate: 0.0001, buyerShare: 1, asOf: '2026-01-01', confidence: 'verified',
    authority: 'Colo. Rev. Stat. § 39-13-102 — $0.01 per $100 documentary fee; customarily the buyer\'s' },
  NV: { stateRate: 0.0051, buyerShare: 0, asOf: '2026-01-01', confidence: 'secondary',
    authority: 'Nev. Rev. Stat. § 375.020 — $1.95 per $500 base plus county; seller-paid (Clark County is higher)' },
  CA: { stateRate: 0.0011, buyerShare: 0, asOf: '2026-01-01', confidence: 'secondary',
    authority: 'Cal. Rev. & Tax. Code § 11911 — $0.55 per $500 county; many cities add substantially (LA/SF measures); seller-paid' },
};

/* =====================================================================
   RECORDING FEES — small, real, and previously bundled invisibly inside the
   title estimate's flat per-state `fee`. Broken out so a borrower's statement
   and ours line up item for item. Page-count driven in most counties, so these
   are typical all-in figures for a standard deed + mortgage, not a schedule.
   ===================================================================== */
const RECORDING = {
  DEFAULT: { deed: 150, mortgage: 250, confidence: 'default' },
  NY: { deed: 250, mortgage: 400, confidence: 'secondary' },
  NJ: { deed: 200, mortgage: 300, confidence: 'secondary' },
  PA: { deed: 150, mortgage: 250, confidence: 'secondary' },
  FL: { deed: 100, mortgage: 200, confidence: 'secondary' },
  CT: { deed: 200, mortgage: 250, confidence: 'secondary' },
  MD: { deed: 150, mortgage: 200, confidence: 'secondary' },
  MA: { deed: 155, mortgage: 255, confidence: 'secondary' },
  GA: { deed: 25, mortgage: 25, confidence: 'secondary' },
  TX: { deed: 50, mortgage: 100, confidence: 'secondary' },
  OH: { deed: 40, mortgage: 90, confidence: 'secondary' },
  MI: { deed: 40, mortgage: 90, confidence: 'secondary' },
  IL: { deed: 100, mortgage: 150, confidence: 'secondary' },
  NC: { deed: 30, mortgage: 80, confidence: 'secondary' },
  SC: { deed: 25, mortgage: 35, confidence: 'secondary' },
  AL: { deed: 50, mortgage: 100, confidence: 'secondary' },
  TN: { deed: 40, mortgage: 90, confidence: 'secondary' },
};

module.exports = { MORTGAGE_TAX, TRANSFER_TAX, RECORDING, TAXABLE_UNIT };
