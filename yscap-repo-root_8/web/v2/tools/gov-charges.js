/* =====================================================================
   YS CAPITAL — GOVERNMENT CHARGES ENGINE  (window.YSGov / module.exports)

   The mortgage tax, transfer tax, mansion tax and recording fees a borrower
   owes at an RTL closing — as line items, computed from the state, the county,
   the city, the unit count, the loan type and the loan amount.

   ── WHY THIS FILE LIVES IN web/v2/tools AND NOT IN src/lib ────────────────
   Because the SAME rule has to run in TWO places: the Term Sheet Studio draws
   the term sheet in the BROWSER (that is where the form fields and the frozen
   engines both live), and the server prices and registers the loan in NODE.
   A browser twin of a server rule is the drift class this repo has been bitten
   by — the studio would PRINT one cash-to-close while the register BOOKED
   another, and the one that drifts is the one that goes out for signature.
   So there is ONE file: the browser loads it with a <script> tag and the
   server does `require('../lib/closing-costs')`, which is a two-line
   re-export of this exact file. Never copy a rule out of here.

   Pure functions, no DOM, no requires. Same shape as the frozen program
   engines beside it (standard-program.js / gold-standard.js / title-cost.js),
   which the server likewise requires straight out of the tools folder.

   THIS IS NOT A FROZEN PRICING ENGINE. A government charge is a closing COST,
   computed AFTER the loan is sized; no engine reads it and it moves no rate,
   no cap and no loan amount. It is the LAST line of the closing statement,
   not an input to the leverage matrix.
   ===================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.YSGov = factory();
})(typeof self !== 'undefined' ? self : this, function () {
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

     WHAT `confidence` ACTUALLY MEANS HERE, and it is deliberately conservative.
     `verified` is for a rate written into a statute that has stood for years and is
     cited to it — Alabama's $0.15 per $100, Florida's 35c per $100 of note, "this
     state levies no transfer tax". `secondary` is everything a COUNTY or a CITY sets
     for itself, however confident the citation looks, because those move on their own
     schedule and nobody tells us: Philadelphia's local rate, the per-county New York
     mortgage tax, the New York City tiers. A `secondary` line shows a "check this"
     chip on the quote, which is the honest thing to put in front of somebody about to
     tell a borrower what to bring to a closing table. Do NOT promote a local rate to
     `verified` because it has a date on it — promote it when a person has read it off
     the county or city's own published schedule, and put their date on it.

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

       THE SPECIAL ADDITIONAL 0.25% IS THE BORROWER'S ON THIS BOOK (owner-directed
       2026-08-23: *"we don't pay our portion since it's private money. Everything
       pays the borrower, so take off our 0.25 that he put on us. We never pay the
       portion."*).

       The statute puts § 253(1-a)(a)'s special additional tax on the MORTGAGEE for
       a 1-6 family residence, and it exempts a mortgagee that is not a "natural
       person or … institutional lender" — a private lender's borrower pays it. So
       the whole combined county rate is quoted to the borrower, with no split and
       no company-cost line. Reopening this needs the owner's own words; it moves
       real money on every New York loan we write.

       THE $30: a 1-2 family dwelling deducts the first $10,000 of principal from
       the MCTD additional tax — $10,000 x 0.30% = $30. Small, and it is a real
       line on a real closing statement, so it is here rather than rounded away. */
    NY: {
      kind: 'mortgage_recording_tax',
      authority: 'NY Tax Law §§ 253, 253-a, 255; NY State Dept. of Taxation & Finance county rate schedule',
      asOf: '2026-01-01',
      // The special additional tax is INSIDE the combined county rate below and is
      // charged to the borrower with the rest of it — see the note above. Kept as a
      // named figure because the term sheet's basis line explains what makes up the
      // rate, not because anything splits it out any more.
      specialAdditionalRate: 0.0025,
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
        CORTLAND: { total: 0.0125, confidence: 'secondary', authority: 'NYS Tax Dept. mortgage tax bulletin, Cortland County, eff. 2025-01-01' },
        CHENANGO: { total: 0.0100, confidence: 'secondary', authority: 'NYS Tax Dept. mortgage tax bulletin, Chenango County, eff. 2025-01-01' },
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
        PHILADELPHIA: { localRate: 0.03578, confidence: 'secondary', asOf: '2025-07-01',
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
    LA: { none: true, asOf: '2026-01-01', confidence: 'secondary', authority: 'Louisiana levies no state real-estate transfer tax (New Orleans charges a flat documentary fee)' },
    ID: { none: true, asOf: '2026-01-01', confidence: 'secondary', authority: 'Idaho levies no real-estate transfer tax' },
    UT: { none: true, asOf: '2026-01-01', confidence: 'secondary', authority: 'Utah levies no real-estate transfer tax' },
    KS: { none: true, asOf: '2026-01-01', confidence: 'secondary', authority: 'Kansas levies no real-estate transfer tax (and repealed its mortgage registration tax in 2019)' },
    AK: { none: true, asOf: '2026-01-01', confidence: 'secondary', authority: 'Alaska levies no real-estate transfer tax' },
    AZ: { none: true, asOf: '2026-01-01', confidence: 'verified', authority: 'Arizona levies no real-estate transfer tax (a $2 affidavit fee only)' },
    MO: { none: true, asOf: '2026-01-01', confidence: 'verified', authority: 'Missouri levies no real-estate transfer tax' },
    IN: { none: true, asOf: '2026-01-01', confidence: 'verified', authority: 'Indiana levies no real-estate transfer tax' },
    MS: { none: true, asOf: '2026-01-01', confidence: 'verified', authority: 'Mississippi levies no real-estate transfer tax' },
    NM: { none: true, asOf: '2026-01-01', confidence: 'verified', authority: 'New Mexico levies no real-estate transfer tax' },
    ND: { none: true, asOf: '2026-01-01', confidence: 'verified', authority: 'North Dakota levies no real-estate transfer tax' },
    MT: { none: true, asOf: '2026-01-01', confidence: 'verified', authority: 'Montana levies no real-estate transfer tax' },
    WY: { none: true, asOf: '2026-01-01', confidence: 'verified', authority: 'Wyoming levies no real-estate transfer tax' },
    /* VERMONT — genuinely the BUYER's, and not a small number on an investment
       property. A principal residence is taxed 0.5% on the first $100,000 and
       1.25% above it; anything that is NOT a principal residence — which is every
       loan on this book — is 1.25% of the whole price, plus the clean-water
       surcharge. Quoted at the investment rate because that is what an RTL deal is. */
    VT: { stateRate: 0.0125, buyerShare: 1, surcharge: 0.002, asOf: '2026-01-01', confidence: 'secondary',
      authority: '32 V.S.A. § 9602 — property transfer tax, buyer-paid; 1.25% on property that is not the buyer’s principal residence, plus the clean water surcharge',
      note: 'Vermont taxes the BUYER. A principal residence would be cheaper on the first $100,000 — this quotes the investment-property rate.' },
    /* NEW HAMPSHIRE — 0.75% on EACH side, so the buyer's half is its own real
       number, with a $20 minimum per side. */
    NH: { stateRate: 0.015, buyerShare: 0.5, minTax: 20, asOf: '2026-01-01', confidence: 'secondary',
      authority: 'RSA 78-B:1 — $0.75 per $100 from the buyer and $0.75 per $100 from the seller ($20 minimum each)' },
    /* MAINE — $2.20 per $500 of value, split down the middle by statute. */
    ME: { stateRate: 0.0044, buyerShare: 0.5, asOf: '2026-01-01', confidence: 'secondary',
      authority: '36 M.R.S. § 4641-A — $2.20 per $500, half from the buyer and half from the seller' },
    AL: { stateRate: 0.001, buyerShare: 0, asOf: '2026-01-01', confidence: 'secondary',
      authority: 'Ala. Code § 40-22-1 — $0.50 per $500 on the deed; seller-paid' },
    /* The rest of the states that levy a transfer tax the SELLER customarily pays.
       Recorded rather than left out, because "we have no entry for Iowa" and "Iowa
       charges the buyer nothing" look identical from a quote and are completely
       different facts. A $0 with a reason is an answer; a silence is a gap. */
    HI: { stateRate: 0.001, buyerShare: 0, asOf: '2026-01-01', confidence: 'secondary',
      authority: 'HRS § 247-2 — conveyance tax, graduated from 0.10%; customarily the seller’s' },
    AR: { stateRate: 0.0033, buyerShare: 0, asOf: '2026-01-01', confidence: 'secondary',
      authority: 'Ark. Code § 26-60-105 — $3.30 per $1,000; customarily the seller’s' },
    IA: { stateRate: 0.0016, buyerShare: 0, asOf: '2026-01-01', confidence: 'secondary',
      authority: 'Iowa Code § 428A.1 — $1.60 per $1,000 over the first $500; customarily the seller’s' },
    KY: { stateRate: 0.001, buyerShare: 0, asOf: '2026-01-01', confidence: 'secondary',
      authority: 'KRS 142.050 — $0.50 per $500; customarily the seller’s' },
    NE: { stateRate: 0.00225, buyerShare: 0, asOf: '2026-01-01', confidence: 'secondary',
      authority: 'Neb. Rev. Stat. § 76-901 — $2.25 per $1,000; customarily the seller’s' },
    OK: { stateRate: 0.0015, buyerShare: 0, asOf: '2026-01-01', confidence: 'secondary',
      authority: '68 O.S. § 3201 — documentary stamp tax $0.75 per $500; customarily the seller’s' },
    OR: { stateRate: 0, buyerShare: 0, asOf: '2026-01-01', confidence: 'secondary',
      authority: 'Oregon bars local transfer taxes; only Washington County levies one (0.10%), customarily the seller’s' },
    RI: { stateRate: 0.0046, buyerShare: 0, asOf: '2026-01-01', confidence: 'secondary',
      authority: 'R.I. Gen. Laws § 44-25-1 — $2.30 per $500; customarily the seller’s' },
    SD: { stateRate: 0.001, buyerShare: 0, asOf: '2026-01-01', confidence: 'secondary',
      authority: 'SDCL § 43-4-21 — $0.50 per $500; customarily the seller’s' },
    WV: { stateRate: 0.0044, buyerShare: 0, asOf: '2026-01-01', confidence: 'secondary',
      authority: 'W. Va. Code § 11-22-2 — $1.10 per $500 state plus county; customarily the seller’s' },
    WI: { stateRate: 0.003, buyerShare: 0, asOf: '2026-01-01', confidence: 'secondary',
      authority: 'Wis. Stat. § 77.22 — $3 per $1,000; customarily the seller’s' },
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

  /* WHY THERE ARE NO RECORDING-FEE LINES HERE.

     There were, and they were a DOUBLE COUNT. `title-cost.js` — the frozen title
     estimator whose figure is already in every quote's closing costs — states in
     its own header that its flat per-state `fee` bundles "title search /
     examination, settlement / escrow / closing fee, lender endorsements, and deed
     + mortgage recording fees". So adding recording again here charged the
     borrower for it twice: $650 on a New York deal, on top of a title estimate
     that already contained it.

     Unbundling the title estimator instead is not available — it is one of the
     frozen pricing engines and its numbers may not be touched without the owner's
     written authorisation. So this engine's scope is exactly, and only, what that
     header says it EXCLUDES: real-estate transfer taxes, mortgage / recordation
     taxes, and the taxes that ride with them (the mansion tax, Florida's
     intangible tax). The two compose with no overlap and no gap.

     If recording fees are ever wanted as their own named line, the honest way is
     to unbundle them OUT of the title estimate in the same change — never to add
     a second source for them here. */

  /* =====================================================================
     closing-costs — the government charges on an RTL closing, as line items.

     Owner-directed 2026-08-23: *"New York City mortgage tax needs to be a line
     item calculated separately. New York State mortgage tax is a little cheaper.
     Pennsylvania, Pittsburgh, and Philadelphia … have a transfer tax … Florida has
     some mortgage tax. There are a lot of other states that have this kind of stuff
     that the buyer needs to pay, either transfer tax or mortgage tax, which should
     all be implemented into our automatic calculator that is calculating the title
     fees. All those line items should also be able to be added to the manual
     section to be overwritten and should automatically fill based on: the unit
     count, the loan type, the county, the state."*

     ── WHY LINE ITEMS AND NOT ONE NUMBER ──────────────────────────────────────

     Because the owner asked for them by name, and because a single blended figure
     cannot be checked, cannot be overridden, and cannot be reconciled against a
     settlement statement — which is the only document that ever proves an estimate
     right or wrong. Every charge comes back as
     `{ key, label, amount, payer, basis, rate, authority, confidence }`, so the
     quote, the term sheet, the cash-to-close and the manual override screen all
     read the same objects and cannot drift from each other.

     ── THE THREE FACTS THAT DECIDE EVERYTHING ─────────────────────────────────

     1. A MORTGAGE TAX IS ON THE LOAN. A TRANSFER TAX IS ON THE SALE. So a
        refinance owes the first and none of the second — and a purchase owes both.
        Collapsing them into "closing taxes" gets every refinance wrong.
     2. WHO PAYS IS PART OF THE RATE. New York's 0.25% special additional tax is
        the LENDER's on a 1-6 family residence; Pennsylvania's is customarily split
        50/50; Florida's deed stamps are the seller's while the note stamps and the
        intangible tax are the buyer's. Attributing all of it to the borrower
        overstates cash to close; attributing none of it to us understates our cost.
     3. THE UNIT COUNT AND THE COUNTY MOVE THE RATE, not just the state. NYC taxes
        a 4-family at 2.80% and a 3-family at 2.175% on the same loan; Cortland
        County charges 1.25% where Chenango charges 1.00%. A per-state number
        cannot express either, which is why the inputs are what the owner listed.

     ── NOT FALLING SHORT ──────────────────────────────────────────────────────

     The owner's actual worry. Three deliberate choices, in the tables and here:
       · An unknown county resolves to the state's HIGH rate, never its low one and
         never zero, and the result says so in `warnings`.
       · Every tax rounds UP to its statutory increment ("or fraction thereof").
       · Anything we are unsure of is reported with `confidence`, so the quote can
         show "verify with the settlement agent" against the specific line rather
         than as boilerplate nobody reads.

     NOTHING HERE IS A QUOTE. `disclaimer` rides on every result.
     ===================================================================== */


  /* THE DISCLAIMER IS THE POINT, not a hedge (owner-directed 2026-08-23: *"You can
     make a disclaimer that it's just estimated … It's not actually going to be
     charged. It's just for an estimate."*).

     Nothing here is billed. It exists so a borrower is told, early and roughly
     right, what these taxes will cost them — because the alternative was telling
     them nothing at all and letting them find out at the table. So the rates are
     researched rather than certified, the estimate always errs high, and the
     wording says both out loud on every surface that prints a figure. */
  const DISCLAIMER = 'Estimated government charges, from published state and county rates, for planning cash to close. '
    + 'They are deliberately rounded up so the estimate does not run short. '
    + 'Your settlement agent issues the binding figures at closing.';

  const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
  const up2 = (v) => Math.ceil(num(v) * 100) / 100;         // round UP to the cent
  /* ROUND UP TO THE DOLLAR — but settle the float FIRST.
     `0.028 - 0.0025` is `0.025500000000000002` in IEEE-754, and 600,000 of those is
     `15300.000000000002`. A bare `Math.ceil` turns that into $15,301: a phantom
     dollar that appears only for certain rate combinations, which is exactly the kind
     of unexplainable cent that makes a person stop trusting a number they cannot
     reconcile against a settlement statement. Rounding to the cent removes the noise
     BELOW a cent, and only then does the deliberate round-UP apply. */
  const ceilDollar = (v) => Math.ceil(Math.round(num(v) * 100) / 100);
  /** Round an amount UP to the next whole taxable increment ("or fraction thereof"). */
  function taxableAmount(amount, unit) {
    const u = num(unit) > 0 ? num(unit) : 1;
    return Math.ceil(num(amount) / u) * u;
  }
  function normState(s) { return String(s || '').trim().toUpperCase().slice(0, 2); }
  /** County labels arrive as "Kings", "KINGS COUNTY", "kings co." — normalize once. */
  function normCounty(c) {
    return String(c || '').trim().toUpperCase()
      .replace(/\bCOUNTY\b/g, '').replace(/\bCO\.?\b/g, '').replace(/[^A-Z' -]/g, '').replace(/\s+/g, ' ').trim();
  }
  function normCity(c) { return String(c || '').trim().toUpperCase().replace(/\s+/g, ' '); }

  /* The five boroughs, however they are written on a file. A property in Brooklyn
     is in Kings County and is taxed as New York City — a lookup that only knew
     "NEW YORK" would tax a Brooklyn loan at the upstate rate and understate the
     borrower's cash by more than 1% of the loan. */
  const NYC_COUNTIES = new Set(['NEW YORK', 'KINGS', 'QUEENS', 'BRONX', 'RICHMOND',
    'MANHATTAN', 'BROOKLYN', 'STATEN ISLAND']);
  const NYC_COUNTY_ALIAS = { MANHATTAN: 'NEW YORK', BROOKLYN: 'KINGS', 'STATEN ISLAND': 'RICHMOND' };
  function isNycCity(city) {
    const c = normCity(city);
    return c === 'NEW YORK' || c === 'NEW YORK CITY' || c === 'NYC' || c === 'BROOKLYN'
      || c === 'BRONX' || c === 'QUEENS' || c === 'STATEN ISLAND' || c === 'MANHATTAN';
  }

  function line(o) {
    return {
      key: o.key, label: o.label, amount: up2(o.amount),
      payer: o.payer || 'borrower',
      basis: o.basis || null, rate: o.rate == null ? null : o.rate,
      authority: o.authority || null, confidence: o.confidence || 'secondary',
      note: o.note || null, auto: true,
    };
  }

  /* ── MORTGAGE / RECORDATION / INTANGIBLE TAX ─────────────────────────────── */
  function mortgageTaxLines(inp, out) {
    const st = inp.state;
    const cfg = MORTGAGE_TAX[st];
    const loan = num(inp.loanAmount);
    if (!cfg || loan <= 0) {
      if (!cfg && loan > 0) {
        out.notes.push(`${st || 'This state'} levies no mortgage recording or intangible tax on the loan.`);
      }
      return;
    }
    const unit = TAXABLE_UNIT[st] || TAXABLE_UNIT.DEFAULT;

    if (st === 'NY') return nyMortgageTax(inp, out, cfg, loan);

    if (st === 'FL') {
      // TWO taxes, and quoting only one understates by more than a third.
      const stampBase = taxableAmount(loan, 100);
      out.lines.push(line({
        key: 'mortgage_tax', label: 'Florida documentary stamp tax on the note',
        amount: (stampBase / 100) * cfg.docStampPer100,
        payer: 'borrower', basis: `$${stampBase.toLocaleString('en-US')} (note, rounded up to the next $100)`,
        rate: cfg.docStampPer100 / 100, authority: cfg.authority, confidence: cfg.confidence,
      }));
      out.lines.push(line({
        key: 'intangible_tax', label: 'Florida non-recurring intangible tax on the mortgage',
        amount: loan * cfg.intangibleRate,
        payer: 'borrower', basis: `$${Math.round(loan).toLocaleString('en-US')} (mortgage amount)`,
        rate: cfg.intangibleRate, authority: cfg.authority, confidence: cfg.confidence,
      }));
      return;
    }

    if (st === 'MD') {
      const county = normCounty(inp.county);
      const entry = cfg.byCounty[county] || cfg.byCounty[county.replace(/ /g, '_')];
      const per500 = entry ? entry.per500 : cfg.defaultPer500;
      if (!entry) out.warnings.push(`Maryland county "${inp.county || 'not set'}" is not in our table — using the highest county recordation rate we know of ($${cfg.defaultPer500.toFixed(2)} per $500) so the estimate does not fall short. Confirm the county rate.`);
      // On a purchase the recordation tax is on the CONSIDERATION; on a refinance
      // it is on the debt. Using the loan on a purchase would understate whenever
      // the price exceeds the loan, which on an RTL purchase it always does.
      const base = inp.isPurchase && num(inp.purchasePrice) > 0 ? num(inp.purchasePrice) : loan;
      const taxable = taxableAmount(base, 500);
      out.lines.push(line({
        key: 'mortgage_tax', label: 'Maryland county recordation tax',
        amount: (taxable / 500) * per500,
        payer: 'borrower', basis: `$${taxable.toLocaleString('en-US')} (${inp.isPurchase ? 'purchase price' : 'loan amount'}, rounded up to the next $500)`,
        rate: per500 / 500, authority: (entry && entry.authority) || cfg.authority,
        confidence: entry ? cfg.confidence : 'default',
      }));
      return;
    }

    // The flat-rate states.
    let taxable = taxableAmount(loan, unit);
    if (cfg.exemptFirst) taxable = Math.max(0, taxable - cfg.exemptFirst);
    let amount = taxable * cfg.rate;
    if (cfg.cap != null && amount > cfg.cap) {
      amount = cfg.cap;
      out.notes.push(`${st} caps this tax at $${cfg.cap.toLocaleString('en-US')}.`);
    }
    if (cfg.flatAdd) amount += cfg.flatAdd;
    out.lines.push(line({
      key: 'mortgage_tax',
      label: `${st} ${cfg.kind === 'intangible_recording_tax' ? 'intangible recording tax' : cfg.kind === 'mortgage_registry_tax' ? 'mortgage registry tax' : 'recordation / mortgage tax'}`,
      amount, payer: 'borrower',
      basis: `$${taxable.toLocaleString('en-US')} (loan amount${cfg.exemptFirst ? `, first $${cfg.exemptFirst.toLocaleString('en-US')} exempt` : ''})`,
      rate: cfg.rate, authority: cfg.authority, confidence: cfg.confidence,
    }));
  }

  /* NEW YORK, on its own, because it is the only one where the rate depends on the
     county AND the loan size AND the unit count AND who pays which slice. */
  function nyMortgageTax(inp, out, cfg, loan) {
    const county = normCounty(inp.county);
    const canonical = NYC_COUNTY_ALIAS[county] || county;
    const inNyc = NYC_COUNTIES.has(county) || isNycCity(inp.city);
    const units = Math.max(1, Math.round(num(inp.units) || 1));

    let total; let label; let confidence; let authority = cfg.authority; let nycClass = null;

    if (inNyc) {
      const tier = cfg.nycTiers.find((t) => units <= t.maxUnits
        && (t.atLeast != null ? loan >= t.atLeast : loan < t.under));
      total = tier.total; confidence = 'secondary';
      /* THE LINE IS NAMED FOR THE CHARGE, NOT FOR THE RATE CLASS. The tier's own
         text ("NYC — 1-3 family / condo, loan $500k+") explains WHICH rate applied
         and is exactly right in a rate table; printed as a line item on a term
         sheet next to a dollar figure it reads as gibberish, and this is the
         largest single number on a New York City closing. So the charge is named
         and the class rides in `basis`, where the derivation page prints it. */
      label = 'New York City mortgage recording tax';
      nycClass = tier.label;
    } else {
      const entry = cfg.byCounty[canonical];
      if (entry && entry.total != null) {
        total = entry.total; confidence = entry.confidence || 'secondary';
        if (entry.authority) authority = entry.authority;
        label = `New York State mortgage recording tax — ${canonical.charAt(0) + canonical.slice(1).toLowerCase()} County`;
      } else {
        total = cfg.defaultTotal; confidence = 'default';
        label = 'New York State mortgage recording tax';
        out.warnings.push(`New York county "${inp.county || 'not set'}" is not in our rate table — using ${(cfg.defaultTotal * 100).toFixed(2)}%, the highest non-NYC county rate we know of, so the estimate does not fall short. Confirm the county rate with the title company.`);
      }
    }

    /* THE SPECIAL ADDITIONAL 0.25% IS THE LENDER'S on a residence of six units or
       fewer (Tax Law § 253(1-a)(a)). Splitting it out is not bookkeeping: leaving
       it in overstates the borrower's cash to close by 0.25% of the loan — $1,500
       on a $600,000 loan — and leaving it out of OUR costs understates what the
       company pays on every New York residential closing it funds. */
    // The borrower pays the whole combined rate — nothing is carved out for us.
    const borrowerRate = total;

    let borrowerAmount = loan * borrowerRate;
    // The 1-2 family MCTD credit: the first $10,000 of principal is exempt from
    // the 0.30% additional tax. A real $30 line on a real closing statement.
    let creditNote = null;
    if (units <= 2 && (inNyc || cfg.byCounty[canonical]) && cfg.oneTwoFamilyCredit) {
      borrowerAmount = Math.max(0, borrowerAmount - cfg.oneTwoFamilyCredit);
      creditNote = `Includes the $${cfg.oneTwoFamilyCredit} one-or-two-family exemption (the first $10,000 of principal is exempt from the additional tax).`;
    }

    out.lines.push(line({
      key: 'mortgage_tax', label, amount: ceilDollar(borrowerAmount),
      payer: 'borrower',
      basis: `$${Math.round(loan).toLocaleString('en-US')} (mortgage amount), ${units} unit${units === 1 ? '' : 's'}`
        + (nycClass ? ` — ${nycClass}` : ''),
      rate: borrowerRate, authority, confidence, note: creditNote,
    }));

  }

  /* ── TRANSFER / DEED TAX — purchases only ────────────────────────────────── */
  function transferTaxLines(inp, out) {
    const st = inp.state;
    const cfg = TRANSFER_TAX[st];
    const price = num(inp.purchasePrice);

    if (!inp.isPurchase) {
      out.notes.push('No transfer tax on a refinance — there is no deed being recorded.');
      return;
    }
    if (!cfg || price <= 0) {
      if (!cfg && price > 0) out.notes.push(`${st || 'This state'} is not in our transfer-tax table — confirm with the title company.`);
      return;
    }
    if (cfg.none) { out.notes.push(cfg.authority); return; }

    // The contract governs, not custom; `buyerTransferShare` overrides the default.
    const share = inp.buyerTransferShare != null ? Math.min(1, Math.max(0, num(inp.buyerTransferShare)))
      : num(cfg.buyerShare);

    // --- the state's own rate -------------------------------------------------
    let stateRate = num(cfg.stateRate);
    const countyEntry = cfg.byCounty && cfg.byCounty[normCounty(inp.county)];
    if (countyEntry && countyEntry.stateRate != null) stateRate = countyEntry.stateRate;
    if (cfg.stateHighOver && price >= cfg.stateHighOver && cfg.stateHighRate) stateRate = cfg.stateHighRate;

    if (stateRate > 0 && share > 0) {
      /* A FLOOR AND A SURCHARGE, because a state that levies one and is quoted
         without it is quoted light — which is the direction that leaves a borrower
         short at the table. New Hampshire charges each side a $20 minimum however
         small the deal; Vermont adds its clean-water surcharge on top of the rate.
         Both are absent from every other state, so both are no-ops elsewhere. */
      let amount = price * stateRate * share;
      const surcharge = num(cfg.surcharge);
      if (surcharge > 0) amount += price * surcharge * share;
      const floor = num(cfg.minTax);
      const flooredTo = floor > 0 && amount < floor ? floor : null;
      if (flooredTo != null) amount = flooredTo;
      out.lines.push(line({
        key: 'transfer_tax_state', label: `${st} state transfer tax — buyer’s share`,
        amount, payer: 'borrower',
        basis: flooredTo != null
          ? `$${Math.round(price).toLocaleString('en-US')} × ${(stateRate * 100).toFixed(3)}% × ${(share * 100).toFixed(0)}% buyer share, raised to the $${floor} minimum`
          : `$${Math.round(price).toLocaleString('en-US')} × ${((stateRate + surcharge) * 100).toFixed(3)}% × ${(share * 100).toFixed(0)}% buyer share`
            + (surcharge > 0 ? ` (includes the ${(surcharge * 100).toFixed(2)}% surcharge)` : ''),
        rate: (stateRate + surcharge) * share, authority: cfg.authority, confidence: cfg.confidence,
        note: cfg.note || (share < 1 ? 'Split per local custom — the purchase contract governs. Override this if the contract says otherwise.' : null),
      }));
    } else if (stateRate > 0) {
      out.notes.push(`${st} transfer tax is customarily the seller’s — nothing in the buyer’s cash to close. Confirm against the contract.`);
    }

    // --- the local (city / school district) rate ------------------------------
    const cityEntry = (cfg.byCity && (cfg.byCity[normCity(inp.city)]
      || (st === 'NY' && isNycCity(inp.city) ? cfg.byCity['NEW YORK CITY'] : null))) || null;
    if (st === 'PA') {
      const localRate = cityEntry ? cityEntry.localRate : cfg.defaultLocalRate;
      if (!cityEntry) out.warnings.push(`Pennsylvania municipality "${inp.city || 'not set'}" is not in our table — using the typical 1% local rate. Philadelphia (3.578%) and Pittsburgh (4%) are far higher; confirm the municipality.`);
      if (localRate > 0 && share > 0) {
        out.lines.push(line({
          key: 'transfer_tax_local',
          // `normCity` upper-cases for LOOKUP. Printing that on a term sheet gives a
          // borrower "PHILADELPHIA realty transfer tax", which shouts at them; the
          // city is a proper noun, so print it as one.
          label: `${cityEntry ? titleCase(normCity(inp.city)) : 'Local'} realty transfer tax — buyer’s share`,
          amount: price * localRate * share, payer: 'borrower',
          basis: `$${Math.round(price).toLocaleString('en-US')} × ${(localRate * 100).toFixed(3)}% × ${(share * 100).toFixed(0)}% buyer share`,
          rate: localRate * share,
          authority: (cityEntry && cityEntry.authority) || cfg.authority,
          confidence: cityEntry ? (cityEntry.confidence || cfg.confidence) : 'default',
        }));
      }
    } else if (cityEntry && Array.isArray(cityEntry.tiers)) {
      // NYC RPTT — residential vs commercial, by price.
      const residential = Math.max(1, Math.round(num(inp.units) || 1)) <= 3;
      const tier = cityEntry.tiers.find((t) => t.residential === residential
        && (t.atLeast != null ? price >= t.atLeast : price < t.under));
      if (tier && share > 0) {
        out.lines.push(line({
          key: 'transfer_tax_local', label: 'NYC Real Property Transfer Tax — buyer’s share',
          amount: price * tier.rate * share, payer: 'borrower',
          basis: `$${Math.round(price).toLocaleString('en-US')} × ${(tier.rate * 100).toFixed(3)}% × ${(share * 100).toFixed(0)}% buyer share`,
          rate: tier.rate * share, authority: cityEntry.authority, confidence: cityEntry.confidence,
        }));
      } else if (tier) {
        out.notes.push('The NYC Real Property Transfer Tax is customarily the seller’s — nothing in the buyer’s cash to close. Confirm against the contract.');
      }
    }

    // --- taxes that are the BUYER's by statute, whatever the custom ----------
    if (cfg.mansion && price >= (cfg.mansion.bands[0] || {}).atLeast) {
      // The band is chosen by the PRICE, and the rate applies to the whole price —
      // not marginally. Treating it as marginal understates it badly at every tier.
      const band = cfg.mansion.bands.filter((b) => price >= b.atLeast).pop();
      out.lines.push(line({
        key: 'mansion_tax', label: 'Mansion tax (buyer)',
        amount: price * band.rate, payer: 'borrower',
        basis: `$${Math.round(price).toLocaleString('en-US')} × ${(band.rate * 100).toFixed(2)}%`,
        rate: band.rate, authority: cfg.mansion.authority, confidence: cfg.mansion.confidence,
        note: 'The mansion tax is the buyer’s by statute, whatever the contract says about the transfer tax.',
      }));
    }
    if (cfg.buyerMansion && price > cfg.buyerMansion.over) {
      out.lines.push(line({
        key: 'mansion_tax', label: 'Mansion fee (buyer)',
        amount: price * cfg.buyerMansion.rate, payer: 'borrower',
        basis: `$${Math.round(price).toLocaleString('en-US')} × ${(cfg.buyerMansion.rate * 100).toFixed(2)}%`,
        rate: cfg.buyerMansion.rate, authority: cfg.authority, confidence: cfg.confidence,
      }));
    }
  }

  /**
   * Every government charge on this closing, as line items.
   *
   * Inputs — exactly what the owner listed, plus the two amounts they are levied on:
   *   state, county, city      the jurisdiction (county and city genuinely move the rate)
   *   units                    dwelling units (NYC taxes a 4-family differently from a 3)
   *   loanAmount               the recorded mortgage amount
   *   purchasePrice            the deed consideration (a purchase only)
   *   transactionType          'purchase' | 'refinance' — decides whether transfer tax applies at all
   *   buyerTransferShare       0..1 override for the split the contract actually sets
   */
  function governmentCharges(input = {}) {
    const inp = {
      state: normState(input.state),
      county: input.county || null,
      city: input.city || null,
      units: input.units,
      loanAmount: num(input.loanAmount),
      purchasePrice: num(input.purchasePrice),
      isPurchase: !/refi/i.test(String(input.transactionType || 'purchase')),
      buyerTransferShare: input.buyerTransferShare,
    };
    const out = { lines: [], warnings: [], notes: [] };

    if (!inp.state) {
      out.warnings.push('No property state on this file — government charges cannot be estimated. Set the property address first.');
      return finish(inp, out);
    }
    mortgageTaxLines(inp, out);
    transferTaxLines(inp, out);
    return finish(inp, out);
  }

  function finish(inp, out) {
    const borrower = out.lines.filter((l) => l.payer === 'borrower');
    const lender = out.lines.filter((l) => l.payer === 'lender');
    const sum = (a) => up2(a.reduce((n, l) => n + l.amount, 0));
    // The weakest link decides how confident the whole estimate is: a total built
    // from one defaulted county rate is a defaulted total, and saying otherwise is
    // how an estimate gets trusted further than it has earned.
    const rank = { default: 0, secondary: 1, verified: 2 };
    const worst = out.lines.length
      ? out.lines.reduce((w, l) => (rank[l.confidence] < rank[w] ? l.confidence : w), 'verified')
      : 'default';
    return {
      lines: out.lines,
      borrowerLines: borrower,
      borrowerTotal: sum(borrower),
      lenderTotal: sum(lender),
      warnings: out.warnings,
      notes: out.notes,
      confidence: worst,
      jurisdiction: { state: inp.state, county: inp.county, city: inp.city, units: inp.units },
      disclaimer: DISCLAIMER,
    };
  }

  /* -------------------------------------------------------------------
     WHICH UNIT COUNT TO TAX ON — the one ambiguity this estimate carries,
     resolved in ONE place because BOTH callers face it.

     New York City taxes a 1-3 family at 2.175% and a 4-family at 2.80% of the
     same loan — on a $600,000 loan that is $11,550 against $15,300 — and New
     York State gives a one-or-two-family a $30 credit. So the unit count is not
     a detail; it is the second-largest lever in this whole engine after the
     loan amount.

     The trouble is that the term sheet's property question offers only
     "1 unit" or "2-4 units", which cannot tell a 3-family from a 4-family. The
     ladder, in order of how much the answer is actually WORTH:

       1. a number a person typed          — they looked at the property
       2. the unit count recorded on the file — a fact somebody entered on the
                                            application and that underwriting reads
       3. the range alone → FOUR, the top of it, because the standing rule on this
          estimate is that an unknown resolves UP: over-stating cash to close
          costs a conversation, under-stating it leaves a borrower short at the
          closing table with a wire that cannot be funded.

     `assumed` is returned so the screen can SAY it picked the top of the range
     rather than hiding it — an estimate nobody can question gets trusted further
     than it earned. A single-family is NOT an assumption: "1 unit" is a stated
     answer, so it comes back assumed:false and the panel stays quiet.
     ------------------------------------------------------------------- */
  /* "PHILADELPHIA" -> "Philadelphia", "MOUNT VERNON" -> "Mount Vernon". Used only
     for LABELS — every lookup still goes through the upper-cased `normCity`. */
  function titleCase(v) {
    return String(v == null ? '' : v).toLowerCase()
      .replace(/(^|[\s\-'])([a-z])/g, (m, a, b) => a + b.toUpperCase());
  }

  function resolveUnits(o) {
    o = o || {};
    const typed = Number(o.typed);
    if (Number.isFinite(typed) && typed >= 1) return { units: Math.round(typed), assumed: false, source: 'typed' };
    const known = Number(o.knownUnits);
    if (Number.isFinite(known) && known >= 1) return { units: Math.round(known), assumed: false, source: 'file' };
    // Both spellings of the same answer: the studio's own select value ("2-4")
    // and the label the loan file stores ("2-4 units"). A rule that recognised
    // only one of them would silently tax a real 4-family as a single family
    // from whichever surface used the other spelling.
    if (/2\s*-?\s*4/.test(String(o.propType == null ? '' : o.propType))) {
      return { units: 4, assumed: true, source: 'range' };
    }
    return { units: 1, assumed: false, source: 'single' };
  }

  /* The amount a TRANSFER tax is levied on: the price of the SALE. A refinance
     is not a sale, so it is zero — and on an assignment it is the REAL total the
     buyer pays (seller contract + the whole fee), never the capped "effective"
     price the loan is sized against, because the deed is recorded for what
     actually changed hands. One definition so the studio and the server cannot
     read the same assignment two different ways. */
  function taxableSalePrice(o) {
    o = o || {};
    if (o.isRefinance) return 0;
    const n = Number(o.totalPrice);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }

  /** The keys this engine can produce — the closed list the override screen renders. */
  const CHARGE_KEYS = Object.freeze([
    'mortgage_tax', 'intangible_tax', 'transfer_tax_state', 'transfer_tax_local',
    'mansion_tax',
  ]);

  /** Plain-language labels for the override screen, so a blank line still reads. */
  const CHARGE_LABELS = Object.freeze({
    mortgage_tax: 'Mortgage / recordation tax',
    intangible_tax: 'Intangible tax (FL)',
    transfer_tax_state: 'State transfer tax — buyer’s share',
    transfer_tax_local: 'City / local transfer tax — buyer’s share',
    mansion_tax: 'Mansion tax (buyer)',
  });

  /**
   * Apply per-file manual overrides to a computed set.
   *
   * Owner-directed: *"All those line items should also be able to be added to the
   * manual section to be overwritten and should automatically fill based on the
   * unit count, the loan type, the county, the state."*  So: the engine fills
   * automatically, a human may type over any single line, and the result records
   * WHICH lines were typed — an override that cannot be seen is indistinguishable
   * from a bad rate table, and the two need completely different fixes.
   *
   * A typed 0 is a real decision (this closing does not owe it) and is honoured;
   * a blank or absent key leaves the automatic figure alone.
   */
  function applyOverrides(result, overrides) {
    const o = (overrides && typeof overrides === 'object') ? overrides : {};
    const byKey = new Map(result.lines.map((l) => [l.key, l]));
    const applied = [];
    for (const key of CHARGE_KEYS) {
      if (!Object.prototype.hasOwnProperty.call(o, key)) continue;
      const raw = o[key];
      if (raw == null || raw === '') continue;                  // blank = use the automatic figure
      const v = Number(raw);
      if (!Number.isFinite(v) || v < 0) continue;
      const existing = byKey.get(key);
      if (existing) {
        applied.push({ key, from: existing.amount, to: up2(v) });
        existing.amount = up2(v); existing.auto = false;
        existing.note = 'Typed by hand on this file — overrides the automatic figure.';
        existing.confidence = 'verified';                       // a human read the actual invoice
      } else {
        // A charge the table does not produce for this state but the settlement
        // agent says is owed. It has to be addable, or the manual section cannot
        // fix a table that is merely INCOMPLETE — only one that is wrong.
        const added = line({
          key, label: CHARGE_LABELS[key] || key, amount: v, payer: 'borrower',
          basis: 'entered by hand on this file', authority: null, confidence: 'verified',
          note: 'Added by hand on this file — our table does not compute this charge for this jurisdiction.',
        });
        added.auto = false;
        result.lines.push(added); byKey.set(key, added);
        applied.push({ key, from: 0, to: up2(v) });
      }
    }
    if (!applied.length) return result;
    const borrower = result.lines.filter((l) => l.payer === 'borrower');
    const lender = result.lines.filter((l) => l.payer === 'lender');
    const sum = (a) => up2(a.reduce((n, l) => n + l.amount, 0));
    return {
      ...result,
      borrowerLines: borrower,
      borrowerTotal: sum(borrower),
      lenderTotal: sum(lender),
      overridden: applied,
    };
  }

  /* -------------------------------------------------------------------
     PUBLIC API
     ------------------------------------------------------------------- */
  return {
    governmentCharges: governmentCharges,
    applyOverrides: applyOverrides,
    CHARGE_KEYS: CHARGE_KEYS,
    CHARGE_LABELS: CHARGE_LABELS,
    DISCLAIMER: DISCLAIMER,
    // exposed for tooling / tests / anything needing the same normalization
    resolveUnits: resolveUnits, taxableSalePrice: taxableSalePrice,
    normState: normState, normCounty: normCounty, normCity: normCity,
    taxableAmount: taxableAmount, isNycCity: isNycCity, NYC_COUNTIES: NYC_COUNTIES,
    tables: { MORTGAGE_TAX: MORTGAGE_TAX, TRANSFER_TAX: TRANSFER_TAX, TAXABLE_UNIT: TAXABLE_UNIT },
  };
});
