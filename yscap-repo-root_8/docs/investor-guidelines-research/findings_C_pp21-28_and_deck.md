# Blue Lake — Findings C: Guidelines pp21–28 (Appendices C–F) + 9-slide Presentation
# (persisted by main from agent C inline result — Write was blocked inside the subagent)

note_buyer: `bluelake`. cond_no range 700–726. Appendices C–F plain text (verified visually). Deck = program-summary/loan-sizer that ADDS leverage/eligibility grids absent from pp21–28.

## CONDITIONS (pre_close)
- **700 TITLE POLICY FORM & COVERAGE** | title | all_note_buyers | p21. ISAOA/ATIMA assignable; ALTA extended lender's policy w/ mechanic's lien coverage; coverage = max loan amount. rtl_cond_title.
- **701 TITLE SCHEDULE A** | title | p21. Committed Loan Amount, Loan Number, Property Address, Complete Borrowers vesting, Complete Lenders vesting; effective date within 90 days of funding; purchase = current vested owner executes contract/deed; refi = vested owner is borrowing entity; legal description matches.
- **702 TITLE SCHEDULE B-I CLEARED** | title | p21. B-I free of non-standard requirements risking priority; ALL B-I removed from final report.
- **703 TITLE SCHEDULE B-II EXCEPTIONS** | title | p21. Free of liens/fees/fines & disputes (bankruptcy/foreclosure/probate/3rd-party); taxes due within 60 days paid at closing per HUD; customary recordings ok.
- **704 TITLE INDEMNITY ENDORSEMENT (broken priority)** | title | closing_phase | p22. Indemnity endorsement for pre-closing work; commonly endorsement 32 / ALTA 14; state-varying.
- **705 CLOSING PROTECTION LETTER** | closing_docs | p28. CPL in closing set. rtl_cond_settlement.
- **706 HAZARD — BRIDGE/RENOVATION** | insurance_hazard | p23. trigger program_strategy in [bridge,renovation]. Dwelling = appraiser replacement cost; hybrid/DVI: Bridge 80% As-Is, Reno 80% ARV; ISAOA/ATIMA; proof premium paid if not on HUD. rtl_cond_insurance.
- **707 HAZARD/BUILDERS RISK/LIABILITY — HEAVY REHAB** | insurance_hazard | p23. trigger rehab_type=heavy (NOT a registry field). Within envelope: hazard as above. Expanding envelope: hazard on existing + Builders Risk = budgeted hard costs + Liability $1M/occ & $2M/agg ($1M agg exception if agent can't exceed).
- **708 BUILDERS RISK & LIABILITY — CONSTRUCTION** | insurance_hazard | p24. Builders Risk = budgeted hard costs; GL $1M/$2M ($1M agg exception); demolition → hazard not required on existing dwelling.
- **709 BUDGET — HEAVY REHAB & CONSTRUCTION** | construction_feasibility | p25. Line-item budget in Excel (.xls), narrative scope, hard/soft by line item, contingency min 7%, ADU broken out. rtl_p1_budget.
- **710 TIMELINE/SCHEDULE — HEAVY REHAB & CONSTRUCTION** | construction_feasibility | p25. Budget >$500K → milestone timeline (permits, demo, foundation, framing, mechanicals, drywall, C of O); <$500K → completion date/duration. new.
- **711 PLANS & PERMITS — CONSTRUCTION** | construction_feasibility | p25. Plans (arch/structural/MEP) + permits if applicable; purchases may permit after closing but NO draws until permits received. rtl_p1_plans.
- **712 BUDGET & TIMELINE — RENOVATION (non-heavy)** | construction_feasibility | p25. Budget Excel + narrative + line items, contingency min 5%, + duration/end date.
- **713 REQUIRED BORROWER DOCS** | identity | p27. App attesting beneficial owners/controlling parties; gov ID; background+OFAC each guarantor/owner ≥25%; credit each guarantor; liquidity statements; track record/SREO. rtl_p1_id.
- **714 REQUIRED ENTITY DOCS** | entity_vesting | p27. trigger has_llc=true. OA/bylaws, articles, COG, EIN/W9, formation/beneficial-ownership, entity background report, entity OFAC report. rtl_llc_formation.
- **715 REQUIRED ASSET DOCS** | closing_docs | p27. Appraisal; purchase agreement + assignments; proof prior price/date (HUD/deed); insurance; flood cert; budget (Excel); plans/permits; feasibility — all if applicable. rtl_cond_appraisaldocs.
- **716 CLOSING/COLLATERAL SET** | closing_docs | closing_phase | p28. Final HUD, note, mortgage/DoT, guaranty, loan agreement, environmental indemnity, title commitment, CPL, deed, business purpose affidavit, ACH form. attorney_closing.
- **717 MINIMUM CREDIT STANDARDS** | credit | note_buyer | slide2. FICO floor 660 all guarantors; tiering uses highest mid score; hard pulls; credit dated within 180 days of closing; foreign guarantors ineligible. rtl_cond_credit.
- **718 GUARANTY REQUIREMENT** | entity_vesting | note_buyer | slide2. Any member ≥25% must guaranty; if none, combo ≥51%; must guaranty to have qualifying factors counted; must be equity owner. rtl_cond_investorstruct.
- **719 EXPERIENCE REQUIREMENTS** | track_record | note_buyer | slide3. Comparable scope/complexity, similar market, completed last 36 months; completed = sold OR stabilized rental; guarantor held ≥20% equity OR managing member. rtl_p3_reo.
- **720 LIQUIDITY REQUIREMENT** | assets_liquidity | note_buyer | slide4. Min = cash to close + 5% of total loan amount; credited cash 100% / brokerage 80% / vested retirement 60%; cash-out from subject loan ineligible. rtl_p3_liq.
- **721 ELIGIBLE PROPERTY TYPES** | property | note_buyer | slide5. Residential, 1-4 units, non-owner-occ, not rural. Rural test (any hit): rural on appraisal; agricultural zoning; solely gravel/dirt road; 2 of 3 comps >5mi; subject/comps lot >10 acres; outbuildings/large sheds. new.
- **722 ESCALATION / CREDIT-COMMITTEE** | program_eligibility | note_buyer | slide6. Loan >$1.5M; reno budget >AIV OR >$250K; construction budget >$1M; adverse markets; cash-out >$250K; change of density/use; exceptions; NY/AK/HI. Route to loans@bluelakecapital.com w/ track record, SOW, appraisal/lender comps, plans/specs. new.
- **723 STATE OVERLAY: NY/AK/HI ESCALATION** | state_overlay | note_buyer | slide6. trigger property_state in [NY,AK,HI] → escalated review.
- **724 BORROWER TIERING (FICO+EXP)** | program_eligibility | note_buyer | slide7. Tier1 FICO 680 / reno&bridge 10+ / construction 8+; Tier2 680 / 5-9 / 4-7; Tier3 700 / 2-4 / 2-3. FICO = highest median of guarantors; exp last 36 months like-kind; <2 exp ineligible. new.
- **725 HEAVY RENOVATION CLASSIFICATION** | construction_feasibility | note_buyer | slide7. Budget >50% of purchase price = heavy reno (exceptions where price low & scope = light rehab). new.

## POST-CLOSE
- **726 DISBURSEMENT/DATE-DOWN ENDORSEMENTS (draws)** | title | defer_post_closing | p22. 33s/title updates over life of loan as draws requested; charged at closing. Construction&HeavyRehab at 25/50/75/100% of holdback; Renovation at 50% & 100% or completion.

## OVERLAYS (key)
title coverage=max loan amt; commitment effective ≤90d; taxes ≤60d paid at closing; hazard hybrid bridge 80% As-Is / reno 80% ARV; builders risk=hard costs; GL $1M occ/$2M agg; contingency ≥7% heavy&construction / ≥5% renovation; milestone timeline if budget >$500K; background/OFAC ownership ≥25%; FICO floor 660; credit age ≤180d; guaranty ≥25% or combo ≥51%; experience lookback 36mo; experience ownership ≥20% or managing member; min exp <2 ineligible; liquidity = cash-to-close + 5% loan; liquidity credits cash100/brokerage80/retirement60; property 1-4 res non-OO not-rural; escalation >$1.5M / reno >AIV or >$250K / construction >$1M / cash-out >$250K / NY-AK-HI; tier FICO 680/680/700; tier exp reno&bridge 10+/5-9/2-4; tier exp construction 8+/4-7/2-3; heavy-reno classification budget >50% purchase.

**Case-study illustrative leverage (slide 8, NOT hard caps):** Tier3/696 Reno LTC84/LTAIV80/LTARV70 ($525K); Tier2/3exits LTC89.58/LTAIV87.50/LTARV66.49 ($322.5K); Tier1/8exits LTC91.84/LTAIV89.74/LTARV75 ($450K). Directional only.

## PRESENTATION-vs-GUIDELINE CONFLICTS
1. FICO 660 (slide2 floor) vs 680 (slide7 tier min) — reconcile: 660 absolute floor, 680 to hit a tier, 660–679 by documented exception.
2. Ownership thresholds diverge: guaranty 25%, OFAC/background 25%, experience 20% or managing-member, plus 51% combo. Three cutoffs.
3. Deck ADDS all escalation/tiering/leverage/property/credit/experience/liquidity — pp21–28 have none of it.
4. Slide-6 flag card drops the ">AIV" clause (shows only ">$250K"); use the fuller bullet ("AIV OR $250K").

## OPEN QUESTIONS (for owner)
1. Hard leverage matrix (max LTC/LTV-As-Is/LTARV by tier & product) NOT in pp21–28 or deck — only illustrative. Lives in earlier guideline body (pp1–20).
2. "AIV" and "adverse markets/Market Considerations" referenced but undefined in this range.
3. 660-vs-680 FICO logic needs confirmation.
4. rehab_type=heavy / heavy-vs-reno classification depends on budget÷purchase ratio — no registry field; pipeline must compute.
5. Bridge loans have no stated budget/timeline requirement in Appendix E — assumed, not confirmed.
