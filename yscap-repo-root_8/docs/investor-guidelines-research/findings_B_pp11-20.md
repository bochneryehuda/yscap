# Blue Lake — Findings B: Guidelines pp11–20 (persisted by main from agent B inline result)
# 30 conditions (cond_no 1101–1130), all pre_close. 47 overlays. Range = property eligibility/
# ineligible types, occupancy, loan-terms FAQs, Sponsor Underwriting (tiering/credit/background/
# experience/liquidity/entity/guarantors/foreign nationals), Escalation, Appendix A (feasibility
# vendors), Appendix B (valuation). NO insurance/builders-risk/draws/reserves in this range.

## CONDITIONS (all pre_close) — key facts
- 1101 OWNER-OCCUPIED PROHIBITED | occupancy | all_note_buyers | p11. Borrowers, equitable owners (direct+indirect), immediate families; previously-occupied also ineligible. new.
- 1102 ELIGIBLE PROPERTY TYPE | property | p11. ≤4 units, non-OO, residential. Eligible: SFR, 2-4 unit, warrantable condo, PUD, townhome. rtl_cond_appraisaldocs.
- 1103 INELIGIBLE PROPERTY TYPES | property | p11-12. 5+ units, OO, mobile/manufactured, agricultural/farm/industrial, co-ops, timeshares, vacant land (unless ground-up), log cabins, geodesic domes, condotels/resort, ground-lease, adverse environmental, earthen homes, in-litigation, zoning violations, purchase-option (lease-to-own), fractional ownership; +p12: unique, assisted-living/non-profit, native American land, condos >6 stories, rural, short-term rentals. (property_type enum gaps: mobile home, co-op, timeshare, condotel, etc.)
- 1104 NO STR / VACATION-RENTAL EXIT | program_eligibility | p12. Stated exit as STR/vacation rental (B&Bs, hostels) ineligible. new.
- 1105 RURAL PROPERTY INELIGIBLE | property | p12. Rural per Section II.C (rural on appraisal, agricultural zoning, comps >5mi, dirt road, lot >10 acres). new.
- 1106 LAND ONLY = GROUND-UP ONLY | program_eligibility | p12. trigger property_type=land. Vacant land only if ground-up construction during term. new.
- 1107 ENTITY BORROWER REQUIRED | entity_vesting | p12. LLC/S-Corp/C-Corp in good standing, registered in property state. No individual-name loans. rtl_llc_formation.
- 1108 ASSIGNMENT FEE CAP | valuation | note_buyer | p13. trigger is_assignment. Fee ≤ lesser of $75,000 or 10% of purchase price; as-is value must support purchase price + fee. **NOTE: differs from PILOT frozen assignment math (15% of seller price / $75k gold). This is Blue Lake's SOFT overlay — advisory only, must NOT alter frozen engine.** new.
- 1109 DELAYED PURCHASE / CASH-OUT CAP | program_eligibility | note_buyer | p13. trigger loan_purpose=refinance. Cash acquisition refi'd within 180 days underwritten as purchase; cash-out capped 70% of purchase price. new.
- 1110 SINGLE PARCEL / NO CROSS-COLLATERAL | program_eligibility | note_buyer | p13. Single parcel; no cross-collateral; no partial releases; subdivision → single full payoff. rtl_cond_title.
- 1111 SPONSOR TIERING (FICO+EXP) | track_record | note_buyer | p13. BOTH FICO+experience. EXAMPLE: T1 680/10, T2 680/5, T3 700/2 (live matrix on Product&Pricing sheet). Experience = completed txns in prior 36mo. rtl_p3_reo.
- 1112 TRI-MERGE CREDIT REPORT | credit | p13. Per guarantor, within 180 days, min 2 scores; FICO = mid of 3 or lower of 2. rtl_cond_credit. exact.
- 1113 FICO FLOOR & DEROG SEASONING | credit | note_buyer | p14. All guarantors ≥660; no FC/BK/DIL/short-sale within 48 months; tiering uses highest mid-score across guarantors. rtl_cond_credit.
- 1114 BACKGROUND REPORT + LIEN/JUDGMENT | background_ofac | note_buyer | p14. Per guarantor within 180 days; tax liens or any lien/judgment >$5,000 paid at closing or released; litigation → LOE+approval; INELIGIBLE: felonies within 15 years, financial crimes, liens/judgments that could supersede a mortgage. rtl_cond_fraud.
- 1115 OFAC SEARCH (guarantors + 25% members + entity) | background_ofac | p14. rtl_cond_fraud.
- 1116 EXPERIENCE — COMPLETED PROJECT DEF | track_record | note_buyer | p14. Completed = sold OR stabilized rental; sale date within prior 36mo; active rentals held ≥36mo count (w/ rehab/const exp); ground-up needs min completed ground-up projects. rtl_p3_reo.
- 1117 EXPERIENCE — OWNERSHIP VERIFICATION | track_record | note_buyer | p14. ≥20% equity or managing member; public property records; non-borrower entities need OA. rtl_p3_reo.
- 1118 COMPARABLE-PROJECT EXPERIENCE | construction_feasibility | note_buyer | p15. trigger rehab_budget>0. Prior projects comparable in size+budget, reasonably proximate geography. new.
- 1119 LIQUIDITY MINIMUM | assets_liquidity | note_buyer | p15. Min = cash to close + 5% of total loan amount; same-sponsor aggregation adds 5% of total loan sold in past 12mo. rtl_p3_liq.
- 1120 LIQUIDITY DOC & HAIRCUTS | assets_liquidity | note_buyer | p15. Statements within 60 days; entity/guarantor/controlled-entity accounts; cash 100% / brokerage 80% / vested retirement 60%; cash-out ineligible. rtl_p3_liq.
- 1121 ENTITY REVIEW — LLC DOCS | entity_vesting | p15-16. trigger has_llc. OA (w/ amendments) naming signers; entity agreements for members ≥25%; good standing; certificate/articles from formation state (+property state if diff); consents/resolutions; entity background + OFAC. rtl_llc_opagmt.
- 1122 ENTITY REVIEW — CORP DOCS | entity_vesting | p16. Bylaws + officer/director elections + minutes/stock certs + articles of incorporation; entity agreements ≥25%; good standing; background+OFAC. rtl_llc_formation.
- 1123 GUARANTOR REQUIREMENT (25%/51%) | entity_vesting | note_buyer | p16-17. Any member ≥25% must guaranty; if none ≥25%, combo ≥51%; only guarantors qualify sponsor; liquidity/track/credit must tie to a guarantor; only equity owners guaranty. rtl_cond_investorstruct.
- 1124 FOREIGN NATIONAL GUARANTOR INELIGIBLE | identity | p17. trigger citizenship=foreign_national. Non-permanent-resident guarantor = foreign national → loan ineligible. rtl_p1_id.
- 1125 ESCALATION TRIGGERS | program_eligibility | note_buyer | p18. Loan >$1.5M; reno budget >AIV OR >$250k; construction budget >$1M; adverse markets; exceptions; cash-out proceeds >$250k; change of density/use. clears_by system. new.
- 1126 EXCEPTIONS REQUIRE APPROVAL | program_eligibility | note_buyer | p18. Documented, escalated, explicit purchaser approval, compensating factors. clears_by system. new.
- 1127 CONSTRUCTION FEASIBILITY VENDOR | construction_feasibility | note_buyer | p19. trigger rehab_budget>0. Approved vendors: Trinity, Granite, Buildzig, CFSI Loan Management, NVMS. new.
- 1128 VALUATION REPORT TYPE BY LOAN AMOUNT | appraisal | note_buyer | p20. ≤$400k full or hybrid/DVI (full if reno/construction >20% of as-is purchase price); >$400k full. rtl_cond_appraisaldocs.
- 1129 APPRAISAL DATING & RECERT | appraisal | note_buyer | p20. Within 90 days (or 120 w/ recert by original appraiser); USPAP & FIRREA; not transferred/assigned. rtl_cond_appraisaldocs.
- 1130 APPRAISAL COMP & ADJUSTMENT STANDARDS | appraisal | note_buyer | p20. As-is ≥3 sold comps; ARV ≥3 sold comps; 2 of 3 within 5mi; 3 primary sold within 12mo; net <15% / gross <25% for ≥2 of 3; declining market ≥1 comp within 90 days; income/age-restricted/GLA/cost-approach comments. rtl_cond_appraisaldocs.

## OVERLAYS (47) — key numeric
property_max_units 4; condo_max_stories 6; rural comp dist >5mi; rural lot >10 acres; assignment_fee_cap lesser($75k,10% purchase); delayed_purchase_window 180d; delayed_purchase_cashout_cap 70% purchase; tier FICO 680/680/700 (EXAMPLE); tier exp 10/5/2 (EXAMPLE); experience_lookback 36mo; credit_report_age ≤180d; credit_min_scores 2; fico_floor 660; derog_seasoning 48mo; background_report_age ≤180d; lien_judgment_payoff >$5,000; felony_lookback 15yr; ofac_ownership 25%; experience_completed_lookback 36mo; rental_experience_hold 36mo; experience_min_equity 20%; liquidity_minimum cash-to-close + 5% loan; liquidity_sponsor_aggregation +5% of loans sold past 12mo; liquidity_statement_age ≤60d; liquidity credits cash100/brokerage80/retirement60; entity_member_agreement 25%; guarantor_ownership 25%; guarantor_combined 51%; escalation loan >$1.5M; escalation reno budget >AIV or >$250k; escalation construction budget >$1M; escalation cashout >$250k; valuation_type ≤$400k full-or-hybrid / >$400k full; valuation_full_reno >20% as-is purchase; appraisal_age ≤90d (120 recert); appraisal_min_comps 3 as-is / 3 ARV; appraisal_comp_proximity 2of3 ≤5mi; appraisal_comp_recency 3 primary ≤12mo; appraisal_net_adj <15%; appraisal_gross_adj <25%; appraisal_declining_market ≥1 comp ≤90d.

## OPEN QUESTIONS
1. Tiering matrix is EXAMPLE only — live matrix on separately-distributed Product & Pricing sheet.
2. Renovation vs construction budget escalation split (>AIV or >$250k vs >$1M) — rehab_type not a registry field.
3. FICO floor 660 (hard gate) vs tiering 680+ — both captured (1113).
4. "AIV" (as_is_value) referenced in escalation; no AIVM discussion in this range.
5. Cross-refs to Section II.A (states), II.C (rural), Market Considerations (adverse markets) live on other pages.
6. Compound rules (assignment cap, liquidity min) captured as multi-part checks.
