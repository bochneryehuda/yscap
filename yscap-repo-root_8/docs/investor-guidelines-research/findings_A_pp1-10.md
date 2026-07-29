# Blue Lake — Findings A: Guidelines pp1–10 (persisted by main from agent A inline result)
# 46 conditions (cond_no 1–46) + 35 overlays. pp1-2 cover/TOC. pp3-10 all rules.
# OWNER CLARIFICATION (2026-07-23): "Construction" = GROUND-UP. GL + Feasibility Report on
# ground-up AND heavy rehab.

## KEY DEFINITIONS (p3-4)
- **Construction Loan** = ground-up: >1 structural wall demolished; OR new home on vacant land; OR refi of construction loan not through drywall.
- **Heavy Rehab Loan** (not construction): rehab budget ≥50% of purchase price or AIV; OR ADU add/convert; OR GLA expansion >250 sqft; OR use/type change; OR load-bearing wall modify/remove.
- **Total Cost Basis (LTC denom)** = purchase price + verified costs to date + approved rehab budget (+ IR for CONSTRUCTION only; reno/heavy rehab IR NOT in TCB).
- **Cash-out Refi** = cash to borrower > lesser of $20,000 or 2% of total loan commitment.

## CONDITIONS (all pre_close) — key facts (cond_no : name : source_page)
- 1 ELIGIBLE BORROWING ENTITY (LLC/S/C-Corp) p4 → rtl_llc_formation
- 2 FIRST LIEN ONLY p4 → rtl_cond_title
- 3 MAX TERM NON-CONSTRUCTION 18mo p4 (trigger program_strategy in bridge/fix_flip/renovation/heavy_rehab)
- 4 MAX TERM CONSTRUCTION 24mo p4 (program_strategy=construction/ground-up)
- 5 FULL RECOURSE GUARANTY p4
- 6 INTEREST-ONLY p4
- 7 MIN/MAX LOAN $100,000–$3,000,000 p4
- 8 MIN FICO 660 p4 → rtl_cond_credit
- 9 SPONSOR EXPERIENCE ≥2 completed txns / prior 36mo p4 → rtl_p3_reo
- 10 SPONSOR LIQUIDITY = cash-to-close + 5% loan p4 → rtl_p3_liq
- 11 MAX LTC 93% p4 (max across all products/tiers)
- 12 MAX LTAIV (LTV) 90% p4 (max across all products/tiers)
- 13 MAX LTARV 75% p5 (max across all products/tiers)
- 14 MAX SPONSOR LOAN EXPOSURE $9,999,999 p5
- 15 FULL-TERM IR — TIER 2&3 CONSTRUCTION p5
- 16 ELIGIBLE STATES (27 juris: AL,CO,CT,DE,DC,GA,IL,IN,KS,KY,MD,MA,MI,MO,NV,NJ,NC,OH,OK,PA,RI,SC,TN,TX,UT,VA,WA) p5 → state_overlay
- 17 VALUATION REQUIRED & DATING (90d / 120 recert) p5 → rtl_cond_appraisaldocs | scope all_note_buyers
- 18 RECENTLY-LISTED HAIRCUT (listed within 6mo → lower of appraised or lowest list price) p5
- 19 CONSTRUCTION FEASIBILITY REPORT REQUIRED (Heavy Rehab OR Construction/ground-up; Appendix A vendor; line items within 10% variance) p5 → rtl_p3_sow1
- 20 LOAN AGING — originated within 30 days of submission p5
- 21 PROJECT AGGREGATION & 4-LOAN CAP (Project = same guarantor/≥50% control + contiguous lots + same approach+exit + closings within 60d; >1 escalates; >4 ineligible) p6
- 22 RURAL PROPERTY INELIGIBLE (rural on appraisal / agricultural zoning / gravel-dirt road / 2of3 comps >5mi / lot >10 acres / outbuildings) p6
- 23 HIGH-VOLATILITY MSA — 5% LEVERAGE REDUCTION (Detroit; Chicago; Philadelphia; Baltimore; Memphis) p7 → state_overlay
- 24 BRIDGE PROPERTY CONDITION C4+ (bridge, no construction) p7
- 25 EXIT STRATEGY REQUIRED p7
- 26 INTERESTED PARTY CONTRIBUTIONS CAP 3% of total loan amount (excess deducted from purchase price) p7 → seller_concession
- 27 PURCHASE CONTRACTS & ASSIGNMENTS PROVIDED p8 → rtl_p1_contract
- 28 ASSIGNMENT FEE CAP & CONDITIONS: **lesser of $75,000 or 15% of purchase price** (p8); as-is value ≥ purchase + fee; original 2-party agreement; escalate; non-arm's-length → ineligible | valuation | NOTE: SOFT overlay — must NOT alter frozen assignment engine. **CONFLICT: p13 (cond 1108) says 10% — flag to owner.**
- 29 DELAYED PURCHASE — CASH-OUT CAP 85% (refi of cash purchase within 180d) p8
- 30 NON-ARM'S LENGTH INELIGIBLE p8 → rtl_cond_fraud
- 31 INITIAL BASIS — AIV VS COST BY SEASONING (>12mo owned → as-is; 6-12mo w/work → discretionary) p8
- 32 IR RULES — CONSTRUCTION (full-term IR; Tier 1 may elect none if loan <$1.5M; no-IR construction ≤$5M/sponsor; IR = Loan*Rate*(Term/12)*75%) p9
- 33 IR — RENO/HEAVY REHAB NOT IN COST BASIS (from initial proceeds, capped by LTC/LTARV) p9
- 34 DUTCH / INTEREST-ON-HOLDBACK INELIGIBLE (accrue on outstanding only) p9
- 35 SHORT-TERM VACATION RENTAL INELIGIBLE p9 → occupancy
- 36 LOAN PROFITABILITY — total costs ≤ ARV (reno/construction) p9
- 37 MID-CONSTRUCTION LOAN INELIGIBLE (borrower-owned + work in progress; unless no current lender / purchaser-owned refi) p9
- 38 STAGNANT INTERNAL REFINANCE INELIGIBLE (no-progress balance-sheet refi; land-for-GUC allowed) p10
- 39 PROPERTY USE CONVERSION RULES (escalate + appraiser zoning; condo conversions jurisdiction-approved; residential-to-residential only) p10
- 40 DEFAULT INTEREST ON PAYOFF INELIGIBLE (refi payoff demand) p10
- 41 ACH SETUP FORM REQUIRED p10 → closing_docs
- 42 INELIGIBLE PROPERTY USES (SRO / rehab-care / hospitality — list continues p11) p10
- 43 CASH-OUT REFI DEFINITION & LIMIT (cash > lesser $20k or 2%; only where work completed; ≤ lesser of applicable LTV or 100% verified hard costs) p3
- 44 CONSTRUCTION LOAN DEFINITION p3
- 45 HEAVY REHAB LOAN DEFINITION p3
- 46 TOTAL COST BASIS / LTC DEFINITION p4

## OVERLAYS (35) — key
min_loan $100k; max_loan $3M; min_fico 660; sponsor_experience ≥2/36mo; liquidity cash-to-close+5%; max_ltc 93%; max_ltaiv 90%; max_ltarv 75%; max_sponsor_exposure $9,999,999; term non-construction 18mo; term construction 24mo; IR full-term Tier2&3 construction; appraisal 90d/120 recert; recently-listed 6mo lower-of; feasibility variance 10%; loan_aging 30d; project common-control ≥50%; project closing window 60d; project loan cap >4 ineligible/>1 escalate; rural comps 2of3>5mi; rural lot >10 acres; MSA haircut 5% (Detroit/Chicago/Philadelphia/Baltimore/Memphis); bridge condition C4+; IPC cap 3%; **assignment fee lesser $75k or 15% (p8) [CONFLICT vs 10% p13]**; delayed purchase 180d; delayed purchase cashout 85%; initial basis >12mo→as-is / 6-12mo discretionary; IR Tier1 no-reserve loan <$1.5M; IR no-reserve sponsor ≤$5M; IR formula Loan*Rate*(Term/12)*75%; cashout trigger >lesser $20k or 2%; cashout cap lesser(applicable LTV, 100% verified hard costs); heavy-rehab budget ≥50% purchase/AIV; heavy-rehab GLA >250sqft; eligible states 27 juris.

## OPEN QUESTIONS (for owner)
1. **Granular per-product/tier/FICO leverage MATRIX is NOT in any PDF** — deferred to external "Express Product & Pricing Sheet." Only max caps present (LTC 93/LTAIV 90/LTARV 75). Need the sheet for cell-level leverage vetting.
2. Sponsor Tier definitions (drive IR rules) — deck example only; live values on pricing sheet. tier assumed 1/2/3.
3. "Completed transactions" experience is strategy-agnostic (2/36mo) — registry splits flips/holds/ground; confirm combined count.
4. **ASSIGNMENT FEE CONFLICT: p8 = 15% of purchase price; p13 = 10%.** Which governs for Blue Lake? (Soft overlay only — does not touch frozen engine.)
5. loan_purpose lacks sub-types (cash-out / rate-term / delayed-purchase) — registry enum expansion needed.
6. Many rules key off appraisal fields not in registry (C4, zoning, lot acreage, comp distance, ADU, GLA sqft, load-bearing, SRO/care/hospitality use).
7. FICO 660 (hard floor all guarantors) vs 680 (tier minimum) vs 660-679 (exception) — confirm.
