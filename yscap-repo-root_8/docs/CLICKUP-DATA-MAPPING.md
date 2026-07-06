# ClickUp ⇄ Portal — Field, Status & Data Mapping (for line-by-line verification)

Companion to `CLICKUP-BIDIRECTIONAL-SYNC-BLUEPRINT.md`. That doc is the architecture + decisions; **this doc is the exhaustive crosswalk** — every status, every field, and the **exact value transform** in each direction. Please verify each row. Nothing is coded until you sign this off.

**How to read direction:** `⇄` two-way · `←CU` ClickUp is source of truth (pull) · `→CU` portal is source (push).
**Field IDs** are live-verified against the workspace. **New fields to create** (no ID yet) are marked `NEW`.

---

## PART 1 — Value transform reference (how each ClickUp field type is read & written)

This is the heart of the "data mapping." ClickUp reads and writes are **asymmetric** for several types.

| ClickUp type | GET / webhook returns | SET expects (write body) | Portal-side transform |
|---|---|---|---|
| **drop_down** | the selected option's **`orderindex` integer** (e.g. `0`) | the option **UUID** (e.g. `"31e3b89d-…"`) | keep a per-field option table `[{uuid, orderindex, name}]`; **read:** index→name; **write:** name→uuid; case/space-insensitive name fallback |
| **labels** (multi-select) | array of option **UUIDs** | `{"add":[uuid…],"rem":[uuid…]}` | map each label ↔ uuid |
| **users** (Loan Officer/Processor/Underwriter) | array `[{id, username, email}]` | `{"add":[userId…],"rem":[userId…]}` | portal `staff_users.clickup_user_id` ↔ ClickUp numeric id (matched by email) |
| **date** | epoch **milliseconds** as a string (e.g. `"901872000000"`) | epoch ms (number/string) | portal `date`/`timestamptz` ↔ ms; treat date-only as midnight UTC |
| **currency / number** | numeric **string** (e.g. `"468750"`, `"763"`) | number or numeric string | strip `$` `,` spaces → `Number`; portal `numeric` ↔ string |
| **short_text / text / email** | string (text also returns `value_richtext`) | string | passthrough; for `text` we write plain, ignore richtext |
| **phone** | string in intl format (e.g. `"+1 929 722 3362"`) | must be valid intl `+1 …` | normalize portal phone → E.164-ish on write |
| **location** | `{location:{lat,lng}, place_id, formatted_address}` | `{location:{lat,lng}, formatted_address}` | portal address `jsonb {line1,city,state,zip}` ↔ `formatted_address` (+ lat/lng from geocode; keep place_id on read) |
| **checkbox** | `true` / `false` | `"true"` / `"false"` | boolean ↔ string |
| **emoji (rating)** | integer count | integer | not synced (informational) |
| **task status** (native, not a custom field) | status **string** (e.g. `"self procesing"`) | status **string** (must be a valid status on that list) | ↔ `applications.internal_status` verbatim (Part 2) |

> **Why this matters:** the #1 latent bug is treating a dropdown's read value (an index) as if it were its write value (a UUID). Every dropdown in Part 3 goes through the option table both ways, and we unit-test each with the live option list.

---

## PART 2 — Status mapping (both directions, fully)

### 2A. ClickUp task status → portal `internal_status` (1:1 verbatim mirror)
We store the **exact ClickUp status string** as the internal status. The 38 statuses on the Pipeline list (`sc901108444248_*`):

`starting` · `prospect / pricing` · `active / fill clickup(1-em` · `self procesing` · `assigned to processor` · `delegated initial` · `delegated conditional` · `delegated ctc submission` · `non del imported ba(2-em)` · `in underwriting` · `workflow` · `secondary workflow` · `approval processing (3-em)` · `file being worked` · `file on desk` · `waiting for docs` · `resubmitted (4-em)` · `final submission (4-em)` · `ctc (4-email)` · `scheduling closing` · `active closing` · `declined` · `rolled back` · `structuring loan` · `inactive / on hold` · `closed (6-email funded)` · `cancelled` · `refinanced` · `recalled` · `pre-recall` · `trash` · `cancelled & reconciled` · `in purchase review` · `purchase conditions` · `pa issued-post closing.` · `waiting for final docs` · `non del closed reconciled` · `closed reconciled`

### 2B. portal `internal_status` → borrower-facing `status` (derived; the translation you'll verify)
Borrower-facing set = existing 9 **+ new `on_hold`**.

| ClickUp / internal status | Borrower-facing | Reasoning |
|---|---|---|
| starting · prospect / pricing | **new** | file just created / pricing |
| active / fill clickup(1-em · structuring loan · rolled back | **in_review** | being set up / re-examined |
| self procesing · assigned to processor · workflow · secondary workflow · file being worked · file on desk · waiting for docs | **processing** | in the processing back-and-forth |
| delegated initial · delegated conditional · non del imported ba(2-em) · in underwriting · approval processing (3-em) · resubmitted (4-em) | **underwriting** | with lender / underwriting |
| delegated ctc submission · final submission (4-em) | **approved** | conditions cleared, heading to CTC |
| ctc (4-email) · scheduling closing · active closing | **clear_to_close** | cleared to close / closing |
| closed (6-email funded) · refinanced | **funded** | funded |
| in purchase review · purchase conditions · pa issued-post closing. · waiting for final docs · non del closed reconciled · closed reconciled | **funded** | **post-closing / reconciliation → borrower sees funded** |
| declined | **declined** | declined |
| cancelled · cancelled & reconciled · trash · recalled · pre-recall | **withdrawn** | dead file |
| inactive / on hold | **on_hold** | new borrower-facing status |

### 2C. Reverse — portal → ClickUp status
- Staff change **`internal_status`** (they pick from the full 38-status list) → push the **identical** ClickUp status string. 1:1, no ambiguity.
- Borrower-facing `status` is **never** pushed up (it's a derived projection; one external maps to many internal). This is exactly why the internal mirror exists.

---

## PART 3 — Field mapping with transforms

### 3.1 Borrower identity / PII (shared IDs — one write hits both CRM contact & Pipeline file)
| Portal | ClickUp (name · id) | Type | Dir | Transform |
|---|---|---|---|---|
| borrowers.first_name + last_name | *Borrower Name · `474a54a3` | short_text | ⇄ | join "First Last" / split on last space |
| borrowers.email | *Borrower Email · `743c16d3` | email | ⇄ | passthrough |
| borrowers.cell_phone | 📞 *Borrower Cell Number · `d60cf254` | short_text | ⇄ | digits passthrough |
| borrowers.date_of_birth | Borrower DOB · `d4e72161` | date | ⇄ | date ↔ epoch ms |
| **borrowers.ssn** (encrypted at rest) | Borrower SSN · `51e0826e` | short_text | ⇄ | decrypt→push / pull→encrypt; **masked in all logs** |
| borrowers.fico | Borrower FICO · `a67357ca` | number | ⇄ | int ↔ string |
| borrowers.current_address | *Borrower Address · `0b469d1b` | location | ⇄ | address jsonb ↔ formatted_address (+geocode) |
| borrowers.citizenship | Citizenship · `045f993c` | short_text | ⇄ | passthrough |
| borrowers.marital_status | Marital Status (YES/NO) · `b91e06a6` | drop_down | ⇄ | *(confirm: is this "married?" Y/N)* index↔uuid |
| borrowers.employment_type | Borrowers employment type · `33bf62d8` | drop_down | ⇄ | index↔uuid (W-2/1099/K1/C-CORP/Self) |
| borrowers.employer | Borrowers employment · `04f7b699` | short_text | ⇄ | passthrough |
| borrowers.dependents_count | Number of Dependents · `19ce13e0` | short_text | ⇄ | int↔string |
| borrowers.years_at_residence | How many Years at Primary Residence? · `fabf5994` | short_text | ⇄ | number↔string |
| borrowers.prior_address | If <2 yrs… Prior Address · `616f218e` | location | ⇄ | address ↔ formatted_address |
| borrowers.housing_status `NEW col` | Primary Housing (Rent/Mortgage/…) · `6ae80836` | drop_down | ⇄ | index↔uuid |
| borrowers.housing_payment `NEW col` | Primary Housing ($) · `51a91012` | currency | ⇄ | number↔string |

### 3.2 Officer / processor / underwriter (users fields)
| Portal | ClickUp (name · id) | Type | Dir | Transform |
|---|---|---|---|---|
| applications.loan_officer_id | Loan Officer · `14839ebf` | users | ⇄ | staff.clickup_user_id ↔ CU id; **portal assign → also MOVE task to officer folder** |
| (officer email) | *Loan Officer Email · `9f6cc87f` | email | ⇄ | from staff record |
| (officer phone) | Loan Officer Phone Number · `94026464` | phone | →CU | from staff record |
| applications.processor_id | Processor · `926bad3b` | users | ⇄ | id map; **portal assign → ADD task to processor folder (multi-list, keep home)** |
| (processor email) | Processor Email · `4f7b2c03` | email | ⇄ | from staff record |
| applications.underwriter_id `NEW col` | Underwriter · `ce85aa3a` | users | ←CU | id map (Amanda=UW mgr, Shana) |
| (underwriter email) | Underwriter email · `951c3a1d` | email | ←CU | from staff record |

### 3.3 Product / structure
| Portal | ClickUp (name · id) | Type | Dir | Transform |
|---|---|---|---|---|
| applications.program | *Program · `50eb857a` | drop_down | ⇄ | index↔uuid; **also the RTL scope gate** |
| applications.loan_type | *Loan type · `ee1b564f` | drop_down | ⇄ | index↔uuid |
| applications.lender | *Lender · `a914ec5a` | drop_down (41) | ←CU | index↔uuid (staff pick lender) |
| applications.channel | *Wholesale / correspondent · `6eb27010` | drop_down | ←CU | index↔uuid |
| applications.occupancy | * Occupancy · `df9d81b5` | drop_down | ⇄ | index↔uuid |
| applications.property_type | *Property Type · `541524d9` | drop_down | ⇄ | index↔uuid |
| applications.units | *Number of Units · `81fc839f` | number | ⇄ | int↔string |
| applications.term | Term · `b67dd5fd` | drop_down | ⇄ | index↔uuid |
| applications.ppp | *PPP Type & term · `82269a33` | short_text | ⇄ | passthrough — **N/A for RTL** (DSCR-era), expect empty |
| applications.ppp (structured) | Is there a Prepayment Penalty? · `a7a92ef5` | drop_down | ⇄ | index↔uuid — DSCR-era |
| llc vesting | *Vesting · `173dc79a` | drop_down | ⇄ | index↔uuid |

### 3.4 Property / economics
| Portal | ClickUp (name · id) | Type | Dir | Transform |
|---|---|---|---|---|
| applications.property_address | *Subject Property Address · `ef691991` | location | ⇄ | address ↔ formatted_address (**also a duplicate-guard key**) |
| applications.purchase_price | *Purchase price / Estimate Value? · `0fc6370c` | currency | ⇄ | number↔string |
| applications.as_is_value | **RTL As-Is Value · `NEW`** | currency | ⇄ | number↔string |
| ← read-only `NEW col` | Approximate Appraised Value · `834d0ffb` | currency | ←CU | number↔string |
| ← read-only `NEW col` | Actual Appraised Value · `9356ceea` | currency | ←CU | number↔string |
| applications.arv | ARV - For RTL · `5644fe6e` | currency | ⇄ | number↔string |
| applications.rehab_budget | Construction budget · `2d27cb55` | currency | ⇄ | number↔string |
| applications.loan_amount | *Loan Amount · `e393e64a` | currency | ⇄ | number↔string |
| applications.ltv | *LTV · `3f5cd2e2` | short_text | ⇄ | number↔string (stored as text in CU) |
| applications.dscr_ratio | DSCR Ratio · `7157db7c` | number | ⇄ | number↔string (rare on RTL) |
| applications.rate_pct | Desired Rate % · `ca47de7f` | number | ⇄ | number↔string |
| applications.rehab_type | **Rehab Type · `NEW`** | drop_down | ⇄ | index↔uuid (Cosmetic/Moderate/Heavy/Adding SF/Ground-up) |
| (SOW text) | Scope Of Work (SOW) · `5991f10c` | text | ⇄ | passthrough |
| applications.original_purchase_price | Original Purchase Price? (Refi) · `253e80ff` | currency | ⇄ | number↔string |
| applications.acquisition_date | Date Subject Property was Purchased? · `dd703e85` | date | ⇄ | date↔ms |
| applications.assignment_fee | Assignment fee · `6d62e510` | currency | ⇄ | number↔string |
| applications.underlying_contract_price | Underlying purchase price · `1a83ab87` | currency | ⇄ | number↔string |

### 3.5 Entity / co-borrower
| Portal | ClickUp (name · id) | Type | Dir | Transform |
|---|---|---|---|---|
| llcs.llc_name | *LLC Name · `8bb530c0` | text | ⇄ | passthrough |
| llcs.ein | EIN · `0ed80e37` | short_text | ⇄ | passthrough |
| applications.co_borrower present | *Is there a Co-borrower? (YES/NO) · `a62d4e6a` | drop_down | ⇄ | bool→YES/NO index↔uuid |
| co_borrower.name | Co-Borrower Name · `5e4d2128` | short_text | ⇄ | join name |
| co_borrower.email | 2nd Borrower Email · `a5e70ced` | email | ⇄ | passthrough |
| co_borrower.phone | 2nd Borrower Cell Number · `37837aab` | phone | ⇄ | intl format |

### 3.6 Loan numbers & dates
| Portal | ClickUp (name · id) | Type | Dir | Transform |
|---|---|---|---|---|
| applications.ys_loan_number (**editable slot**) | YS Cap Loan Number · `a6da91bc` | short_text | ⇄ | passthrough; **CU-origin**, portal can set/push |
| applications.investor_loan_number | investor Loan Number · `8ff507cc` | short_text | ⇄ | passthrough (CU-origin) |
| applications.submitted_at | Date File Submitted · `51ef2193` | date | →CU | date↔ms |
| applications.expected_closing | Expected Closing Date · `de57d9fb` | date | ⇄ | date↔ms |
| **applications.actual_closing** | **Actual Closing Date · `0846edc7`** | date | **←CU** | date↔ms |

### 3.7 Card data (single line → structured, per your instruction)
| Portal | ClickUp (name · id) | Type | Dir | Transform |
|---|---|---|---|---|
| card_number / card_exp / card_cvv `NEW cols` (encrypted) | Credit card info for appraisal · `684c900f` | short_text | ⇄ | **parse** `4266…5489  05/31  789` → 3 slots on pull; **join** on push; masked everywhere; ⚠️ CVV-retention PCI flag |

### 3.8 CRM-only (contact card)
| Portal | ClickUp (name · id) | Type | Dir | Transform |
|---|---|---|---|---|
| borrowers.contact_type | Contact Type · `44120431` | drop_down | ⇄ | index↔uuid (INVESTOR/PRIMARY/FIRST TIME) |
| (lead source) | Lead Source · `fce6283c` | drop_down | ←CU | index↔uuid |
| relation (system) | Pipeline Link `4952e019` / CRM Link `612eed39` | tasks relation | system | link CRM contact ↔ Pipeline file |

---

## PART 4 — Conditions / checklist status mapping (5-state ↔ ClickUp dropdown option UUIDs)

Portal `checklist_items.status` ∈ `outstanding|requested|received|satisfied|issue`. Each maps to a ClickUp dropdown; on write we resolve to the exact **option UUID**, on read we normalize the label (case-insensitive). `⇄`, both-way.

| Portal checklist template | ClickUp dropdown · id | outstanding | requested | received | satisfied | issue |
|---|---|---|---|---|---|---|
| Title | Title · `96799e30` | `6b863c52` | `1f60b8a1` | `3cb81261` | `13d88676` | `a3000a90` |
| Insurance | Insurance · `2cfc1e61` | `acad4672` | `ab91f4ab` | `91e491a9` | `7ca445ff` | `06081f78` |
| Purchase contract | Contract · `85866d28` | `0533f41a` | `90bda796` | `ff08a602` | `32ae6d40` | `6d41cd20` |
| Assignment | Assignment · `a22694cb` | `0da17775` | `a597c34f` | `7d2931f3` | `40ae01b7` | `33edc1ed` |
| REO | REO · `fa211bd9` | `071eb5c0` | `d6de8cf5` | `591b2658` | `69d57cb2` | `79a1025d` |
| Assets documentation | Assets documentation · `1b813089` | `15a01a02` | `6f5bd705` | `62969431` | `a2b1a7fd` | `abed50e6` |
| Rehab budget / SOW | Rehab budget (SOW) · `b1cdb8b1` | — | `1d98cb27` | `3cfbd029` | *(use Received&Uploaded `31211215`)* | `a06b9e85` |
| Signed term sheet | Signed term sheet · `d60eef93` | — | `3d0970ce` | `d8c18154` | — | `6953e927` |
| ISKA | ISKA · `d6c23813` | — | `972c4082` | `d1afcb06` | — | `03316140` |

*Where a state has no ClickUp option (—), the portal collapses to the nearest available option (documented per field). Confirm these fallbacks.*

### 4.1 Internal underwriting/appraisal condition fields (mostly ←CU, surfaced in portal)
Appraisal ready to order `fe1ce98c` (checkbox) · appraisal ordered? `b7d1e6f6` (checkbox) · Appraisal Receved? `1ee31bfc` (checkbox) · Appraisal review `e98fa078` (drop_down) · CDA `300b9523` (drop_down) · CDA Value `c80b6083` (currency) · TPR approval `5a88002d` (drop_down) · Rehab Feasibility `8ecdd092` (drop_down) · Deposit Receved `b0e894cc` (drop_down, ⇄) · Submission Complete `74081468` (drop_down) · Credit Report `bfcc21cb` (checkbox) · Background Report `9ef4bd56` (checkbox) · Encompass `6961b76e` (drop_down) · All Files In SharePoint? `3d35b577` (checkbox) · Title Company Contact `252cd875` (email, ⇄) · Insurance Company Name `dc0b20e7` (short_text, ⇄).

---

## PART 5 — New ClickUp fields (UI-only; API/connector can't create field definitions)

Field *definitions* can only be made in the ClickUp UI (Space → ⚙ → Custom Fields). **But most of these don't have to live in ClickUp** — the binding and status live in our DB regardless. Tiered so you do the minimum:

### 5A. Create in ClickUp (UI) — only the ones you want the ClickUp-side behavior for
| Field name | Type | Options / config | Why it must be in ClickUp |
|---|---|---|---|
| **Send to Portal** | Checkbox | — | Staff tick it *in ClickUp* to force create/resync. Skip only if you're fine triggering resync from the portal admin panel instead. |
| **RTL As-Is Value** | Currency (USD) | precision 2 | You asked for a dedicated RTL as-is field to sync `as_is_value`. |
| **Rehab Type** | Dropdown | Cosmetic · Moderate · Heavy · Adding SF · Ground-up | Only if you want `rehab_type` visible/editable in ClickUp. |

### 5B. Optional convenience (create if you want staff to SEE it in ClickUp; otherwise skip — it lives in the portal)
| Field name | Type | Lives fine in portal-only? |
|---|---|---|
| Portal File ID | Short text | ✅ — binding is stored on our side (`clickup_pipeline_task_id` ↔ app UUID). The ClickUp field is just a visible cross-ref. |
| Portal File Link | URL | ✅ — convenience deep-link only. |
| Borrower Portal Status | Dropdown (10 statuses) | ✅ — derived on our side; the ClickUp mirror is staff-visibility only. |
| Sync Status / Last Error | Short text | ✅ — shown in the portal Control Center regardless. |

After you create whichever you want, I re-pull the IDs into the mapping. **Minimum to unblock the core build: just `Send to Portal` + `RTL As-Is Value`** (and `Rehab Type` if you want that field). Everything else I keep on our side.

**CRM folders (Chaim Lebowitz, Mendel Bochner):** cleanest = **duplicate an existing officer's CRM folder** (e.g. "Yehuda Bochner CRM") in the UI and rename — copies the List, views, and automations. (API can make a bare folder+list but not the views/automations.)

**Also enable:** the **"Tasks in Multiple Lists"** ClickApp (so processor assignment can add-to-list without moving).

---

*Verify each row. Flag any wrong direction, wrong source-of-record, wrong transform, or any field that's informational-only and should be dropped. Once locked, this file + the blueprint are the build contract.*
