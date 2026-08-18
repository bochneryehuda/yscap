# The Deephaven DSCR eligibility matrix — our SECOND LAYER source of truth

**Owner directive (2026-08-17):** *"We don't need to trust Lender Price blindly on eligibility and
ineligibility — they can make mistakes. Usually they're right, but … look on the matrix. Please open up
a full research engine to research how to read this qualifying and disqualifying matrix, look for the
DSCR page, and connect this together with the dots for the eligibility and ineligibility. Look
specifically at Lender Price disqualifying scenarios to see the disqualifiers … understand what is the
first layer and what is the second layer and how to connect the dots."*

This is the analogue of the HARD RULE for **pricing** ("do an independent analysis; get backing from
Lender Price"), applied to **ELIGIBILITY**: we encode the published matrix as our OWN rules, cross-check
Lender Price live, and when they disagree we flag it — either Lender Price is wrong (open a ticket) or
our encoding is wrong (fix Layer 2). We never silently trust Lender Price on who qualifies.

## The two layers

- **Layer 1 — Lender Price (live).** For a scenario, LP either PRICES a product or DISQUALIFIES it with
  reason strings. This is what the pricer quotes from today, and what `deephaven-dscr-sheet.js`'s
  `eligibility:` block was reverse-engineered from (LP's own disqualify reasons).
- **Layer 2 — the published matrix (this document).** Our independent reading of the official Deephaven
  Correspondent Flow DSCR product matrix. Richer than Layer 1's flat bounds, and authored by the
  investor rather than inferred from LP's engine — so it is the reference we hold LP to.

## Source

`CORR_Flow_Product_Matrices.xlsx` (Deephaven Correspondent Flow, **Effective 08/04/26**), the **DSCR**
sheet. The workbook carries five product matrices — Expanded Prime, Non Prime, **DSCR**, Super Jumbo,
ITIN. The full raw extraction of all five is in `matrices/corr-flow-all-sheets-raw.txt`; the decoded,
machine-readable DSCR matrix is `matrices/deephaven-dscr-matrix.json`.

## The Max-LTV grid (the big one)

Max LTV depends on **four** axes — loan-amount tier × FICO × purpose (Purchase/R&T vs Cash-Out) × DSCR
band (≥1.00 vs <1.00). `N/A` = an ineligible cell (no priced LTV at all).

**Loan ≤ $1,500,000**

| FICO | Purch/R&T (DSCR≥1) | Cash-Out (DSCR≥1) | Purch/R&T (DSCR<1) | Cash-Out (DSCR<1) |
|------|:---:|:---:|:---:|:---:|
| 720  | 80% | 80% | 75% | 70% |
| 700  | 80% | 75% | 75% | 65% |
| 680  | 75% | 75% | 70% | 65% |
| 640  | 70% | 70% | N/A | N/A |
| Foreign National | 70% | 60% | N/A | N/A |

**Loan ≤ $2,000,000**

| FICO | Purch/R&T (DSCR≥1) | Cash-Out (DSCR≥1) | Purch/R&T (DSCR<1) | Cash-Out (DSCR<1) |
|------|:---:|:---:|:---:|:---:|
| 700  | 80% | 75% | 70% | 65% |
| 680  | 75% | 75% | 65% | 65% |
| 660  | 65% | 65% | N/A | N/A |

**Loan ≤ $2,500,000**

| FICO | Purch/R&T (DSCR≥1) | Cash-Out (DSCR≥1) | Purch/R&T (DSCR<1) | Cash-Out (DSCR<1) |
|------|:---:|:---:|:---:|:---:|
| 700  | 70% | 70% | 60% | 60% |
| 660  | 65% | 65% | N/A | N/A |

## Program parameters (limits)

| Parameter | Value |
|-----------|------:|
| Minimum loan amount (DSCR ≥ 1.00×) | **$75,000** |
| Minimum loan amount (DSCR < 1.00×) | **$200,000** |
| Maximum loan amount | $2,500,000 |
| Maximum cash-out — LTV ≤ 65% | $1,000,000 |
| Maximum cash-out — LTV > 65% | $500,000 |
| Foreign National maximum loan | $1,500,000 |

Products: 5/6 ARM, 5/6 ARM-IO, 15Y/30Y Fixed, 30Y Fixed-IO.

## Overlays (from the DSCR sheet)

- **Occupancy:** business-purpose investment properties only.
- **Property types:** SFR, PUD, Townhome (**Row Homes ineligible**), 2–4 Units, Condos &
  Non-Warrantable Condos (**Max 80% LTV**).
- **Short-Term Rentals:** Property Guard report required; **Min DSCR 1.15×**; **5% LTV reduction** vs
  matrix (75% max); **Min FICO 720**; no First-Time-Investor / 2+ Unit / Rural / Unique properties.
- **Reserves:** 3 mo PITIA (loan ≤ $1mm); 6 mo PITIA (loan > $1mm).
- **Interest Only:** Max LTV 80%; Min DSCR 1.00×.
- **Subordinate financing:** not allowed.
- **DSCR floor:** DSCR < 1.00 → minimum DSCR **0.75×**.
- **Small loan:** loan < $125,000 → Max LTV reduced to **75%**; loan < $100k → delegated delivery only.
- **First-Time Investor:** Min DSCR 1.00, Min FICO 700, long-term rental only.
- **First-Time Homebuyer:** not eligible (unless 2+ borrowers and one is not a FTHB).
- **Eligible borrowers:** 12-month history of investment-property ownership in the most recent 12 months.
- **Declining markets:** Max LTV reduced by 5%.
- **Geographic:** Philadelphia, PA → Max LTV −10% (all occupancies). Ineligible geos: HI lava zones
  1 & 2; Baltimore City, MD.
- **Citizenship:** US Citizens; Permanent Resident Aliens; Non-Permanent Resident Aliens (w/ US Credit);
  Foreign Nationals (Min DSCR 1.00×).

## What this CONFIRMS and what it CHANGES vs our current envelope

Our current `deephaven-dscr-sheet.js` `eligibility:` block (reverse-engineered from Lender Price's live
disqualifiers) has flat bounds: min FICO 640, DSCR<1.00 min FICO 680, max LTV 80%, DSCR<1.00 max LTV
75%, DSCR<1.00 + FICO<700 max LTV 70%, min DSCR 0.75, min loan $75k, max loan $2.5MM.

**Confirmed by the matrix:** min loan **$75,000** for DSCR ≥ 1.00 (the owner's $75k question — it IS
allowed, so a $75k loan qualifying is NOT a Lender Price bug); max loan $2.5MM; min DSCR 0.75; min FICO
640 (DSCR≥1) / 680 (DSCR<1).

**Not yet modelled by our envelope (Layer-2 gaps to encode):**
1. **Min loan $200,000 when DSCR < 1.00** — our sheet uses a flat $75k. A $150k DSCR-0.90 loan should be
   ineligible and our envelope currently prices it.
2. **The Max-LTV GRID** — our flat "80% / 75% / 70%" is a coarse envelope of a 4-axis grid. The real
   caps drop to 65% (≤$2M, FICO 660) and 60–70% (≤$2.5M), and vary by purpose (cash-out is tighter than
   purchase at several cells). Many LTVs our envelope allows are matrix-ineligible.
3. **Max cash-out $1M (LTV≤65%) / $500k (LTV>65%).**
4. **Small-loan LTV reduction** (<$125k → 75%; <$100k delegated only).
5. **Overlays** depending on facts we don't carry yet (STR, First-Time-Investor, declining market,
   Philadelphia/geo, Foreign National) — to be flagged/deferred, never guessed.

The design for encoding these as Layer 2, the Lender-Price disqualifier catalog + mapping, and the
two-layer reconciliation/ticket architecture are the output of the three research engines opened for
this directive; this document is the grounded source they build on.
