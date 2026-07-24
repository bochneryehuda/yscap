# Fix & Flip Purchase — Loan Conditions breakdown (owner-directed, 2026-07-24)

Source: the owner's `Loan_Conditions__Fix_and_Flip_Purchase.xlsx` (47 conditions) plus the owner's
per-condition wiring instructions. Every condition below is ALREADY defined in
`src/lib/underwriting/investor-guidelines/corrfirst-fnf-spec.js` (from the earlier ISG-2 / ISG-REFRAME
work) with a `cond_no`, `scope`, `lifecycle`, `trigger`, `clears_by`, `pilot_template_code`, and evidence
text rewritten in our voice. The remaining work is **wiring** (auto-post on the real trigger, auto-clear
from the real PILOT data source) plus the owner's scope/disposition refinements. This doc is the map;
the tasks (#265–#286) are the work.

## Governing rules (owner, restated)
- **Plain language for borrowers/staff** — rewrite every posted condition in OUR voice, never the note
  buyer's wording; never leak a note-buyer/partner name to a borrower.
- **AI never blocks** — every condition/finding is a super-admin-overridable advisory (unchanged).
- **Auto-post on the real trigger; auto-clear from the real data source** — the owner's core theme: each
  condition should light up only when it applies and clear itself from PILOT's own data when it can.

## Disposition groups

### A. ACTIVE NOW — wire auto-post + auto-clear (all note buyers unless noted)
| cond_no | Condition | PILOT code | Owner wiring instruction | Task |
|--------|-----------|------------|--------------------------|------|
| 1009 | Borrower email | (file_data) | Auto-verify from the loan file's borrower email; suggest-post only if missing | #265 |
| 1015 | Credit report | rtl_cond_credit | Credit import for ALL borrowers + the PDF (OCR/AI); clear only when complete | #266 |
| 1017 | Government ID | rtl_p1_id | Link to the borrower gov-ID doc; auto-clear after AI verify | #267 |
| 1050 | SSN verification | rtl_p1_ssn | **CorrFirst only**; auto-verify off the credit report; suggest-post only if AI can't | #268 |
| 1022 / 3086 | Liquid assets / reno asset-diff | rtl_p3_assets | Link to the asset/liquidity desk (3086 = CorrFirst reno) | #269 |
| 1020 | LLC vesting docs | rtl_p1_llc | Link to the vesting-LLC + entity-chain checks | #270 |
| 1089 | Purchase contract | rtl_p1_contract | Link to the contract + assignment analysis | #271 |
| 1026 | Title & tax | rtl_cond_title | **Push to closing — do NOT hold CTC** | #272 |
| 1029 / 2599 | Flood determination / insurance | rtl_cond_flood | Auto-clear via our AI/OCR; **REMOVE from Fidelis** | #273 |
| 2002 / 3811 | Track record / first-time | rtl_p3_reo | Link to track-record data (3811 = CorrFirst) | #274 |
| 2004/2798/3345/3349/1054 | Appraisal reqs / median / rural / transfer / 2nd appraisal | rtl_cond_appraisaldocs | Link all to the appraisal desk findings (2798/3345/3349/1054 = CorrFirst) | #275 |
| 2005 / 3346 | Background check / OFAC | rtl_cond_fraud | Link to the fraud/background desk | #276 |
| 2000 / 10023 | Signed term sheet / occupancy cert | rtl_cond_signedts | Auto-clear from the DocuSign/e-sign package | #277 |
| 4256 | Title/escrow/insurance contacts | rtl_p1_titlec | Capture the required contact fields | #278 |
| 2186 | Hazard insurance | rtl_cond_insurance | All buyers; **exact limits CorrFirst-only**, else industry standard | #279 |

### B. AUTO-POST on a trigger (light up only when the trigger fires) — Task #280
- Condo/Condotel (2120/2121) — when property is a condo
- Cash Out Letter (10022) — when the deal is economically cash-out
- Lease if tenant-occupied (1018) — **CorrFirst**, from the appraisal's tenant-occupancy
- Construction feasibility (2193) — **CorrFirst**, on renovation
- Seller concession (3035) — **CorrFirst**, 6% cap (3% Swifty50 5+ units)

### C. CONDITIONAL / advisory-only
- Non-arms-length (3333) — **do NOT post by default; only when concerns arise** (Task #281)
- Final settlement statement (4257) — **closing-phase**, not post-closing, not pre-CTC (Task #282)

### D. ON HOLD until closings are brought in-house (attorney handles now) — Task #283
CPL (1030), Title E&O (2185), Pledge & Security NY (2454), Closed Loan Package (4249),
Promissory Note (4258), Mortgage/Deed (4259), Note + riders (1147), AKA affidavit (1145),
Spousal Consent (2007), Final Title Policy (2395). Keep specced; do not post/gate now.

### E. DEFERRED post-closing (ignore for now) — Task #284
Executed Loan Agreement (1058), Personal Guaranty (1074), Business-Purpose Certificate (1056),
Non-Owner-Occupancy Affidavit (1071).

## Cross-cutting tasks
- **#285 IG-VOICE** — rewrite every active condition's text in our plain-language voice.
- **#286 IG-W0** — verify the auto-post + auto-clear ENGINE actually runs the spec (triggers fire,
  clears_by wired, scope + Fidelis-flood exclusion enforced, hold/defer never post). Foundation for A–C.

## Sequence
1. #286 IG-W0 (engine gap list + integration test) — everything depends on it.
2. Data-source auto-clear wins: #265 email, #266 credit, #267 ID, #273 flood, #276 fraud/OFAC,
   #275 appraisal bundle, #269 assets, #270 LLC, #271 contract, #274 track record.
3. Scope/disposition fixes: #268 SSN-CorrFirst, #272 title→closing, #279 hazard limits, #281
   non-arms-length, #282 settlement, #280 auto-post triggers.
4. #285 voice pass across all active conditions.
5. #283 / #284 stay parked until closings-in-house / post-closing are built.
