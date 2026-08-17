<!--
  The owner-supplied Deephaven (DHM) "Corr Flow Rate Sheet (T0)" — DSCR tab — read cell by cell and
  compared against what we measured LIVE from Lender Price. LT-only. The machine-readable extraction is
  matrices/deephaven-dscr-ratesheet-corr-t0.json; this file is the ANALYSIS: what ties out, what we are
  missing, and the one sign question that must be settled live before anything is encoded.
  Only the DSCR tab was read (owner-directed 2026-08-17: "look only on the DSCR tab").
-->

# Deephaven DSCR rate sheet (Corr T0) vs Lender Price — 2026-08-17

The owner supplied the real Deephaven rate sheet. It is the **source of truth** the whole Layer-1
sheet should be built from, and it contains **four tables we had never encoded**. It also settles the
prepay question the owner raised, exactly.

## 1. The prepay penalty table — FOUND, and it ties out to LP to the penny

Sheet block `O42` **"Max Price/Prepay Buydown"**. Baseline is stated on the sheet itself (`B10`):
**base pricing is a 30-day lock at a 3-YEAR prepay** — which is why the 3-Year row is 0.000.

| Term | LLPA Other | LLPA **5% Fixed** | Max Price |
| --- | --- | --- | --- |
| 5 Year | **+0.625** | **+1.125** | 105 |
| 4 Year | +0.25 | +0.5 | 105 |
| 3 Year | **0** (baseline) | +0.25 | 104 |
| 2 Year | −0.5 | −0.5 | 102.75 |
| 1 Year | −1 | −1 | 102 |
| No Prepay | **−2** | −2 | 101.5 |

Footnote `O51`: *"Prepay Penalties allowed on Investor only. See matrix for details."*

**Cross-check against the LIVE Lender Price measurement** (same loan, only the prepay selection
changed — `DEEPHAVEN-LP-LIVE-FINDINGS-2026-08-17.md` §2, coupon 7.500, base 105.175):

| prepay selection | LP itemized line | LP price | sheet says | agrees? |
| --- | --- | --- | --- | --- |
| Fixed 3% / 36 mo | *(no line — baseline)* | 105.175 | 3 Year = 0 | ✅ |
| Standard step-down 5 yr | `5 Year Prepay Penalty` 0.625 | 105.800 | 5 Year Other = +0.625 | ✅ exact |
| **Fixed 5%, 5 yr** | `5 Year Prepay Penalty - 5%` 1.125 | **106.300** | 5 Year 5% Fixed = **+1.125** | ✅ exact |
| No Prepay | `No Prepay Penalty` 2.000 | 103.175 | No Prepay = **−2** | ✅ exact |

Every measured point matches the sheet **to the penny**, and the arithmetic closes:
`105.175 + 0.625 = 105.800`, `105.175 + 1.125 = 106.300`, `105.175 − 2.000 = 103.175`. So for this
family the sheet is **premium-positive** (a positive value IMPROVES the price) and LP's displayed
numbers move the price the same way. The **5% Fixed promotion is worth +0.500 over the standard
5-year declining penalty** (1.125 − 0.625), confirmed from two independent sources.

### 1a. The three PPP pricing tiers, mapped onto this sheet

The owner's rule (2026-08-17): *the standard prepay is priced as standard (three acceptable
structures); the 5% Fixed earns better pricing via an LLPA credit; and a more lenient structure
carries an additional holdback on top of standard.* That is **exactly** the shape of this sheet —
two LLPA columns, and a third tier that is deliberately not on the sheet at all:

| tier | where it is priced | structures | extra holdback |
| --- | --- | --- | --- |
| **Standard** | column P — *"LLPA Other"* | 5/4/3/2/1, 5/4/3/2, 5/4/3, 3/3, 3 (R8 `dh_published`) | — |
| **5% Fixed (promo)** | column Q — *"LLPA 5% Fixed"* — a **credit** over standard | `fixed5` | — |
| **Custom softer** | **not on the sheet** — priced off column P, then our own holdback | 3/3/3/2/1 (5yr), 3/3/2/1 (4yr) | **+0.375** |

The architectural line already recorded in R8 holds and is confirmed by the sheet: **an LLPA is on
the sheet and must match LP; a margin holdback is ours and must NOT.**

**Sheet identity / versioning** (header rows, missed on the first read and now captured): title
*"DSCR | Correspondent"*, **effective 2026-08-14 14:15 UTC** (Excel serial `46248.59375`) — this
effective date is what versions the sheet and is what the daily change-detector (D19) must key on —
lock desk `correspondentlock@deephavenmortgage.com`, (844) 346-2677 option 3.

## 2. Three more tables we had never encoded

**(a) Max Price tiers by loan amount** (`B42`), with the sheet's own combining rule verbatim (`B48`):
> *"Max Price includes Lender Paid Comp, if applicable. **Max Price is the lower of Max Price Tiers
> and Prepay Buydown, when applicable.**"*

| Loan amount | Max price |
| --- | --- |
| ≤ $1,500,000 | 105 |
| ≤ $2,000,000 | 104.5 |
| ≤ $2,500,000 | 103.5 |

**Min price: 98.000.** So a quote is clamped by **the LOWER of** (loan-amount tier, prepay-term cap),
then floored at 98 — two independent ceilings, lowest wins, exactly as the owner described.

**(b) Term / extension adjustments** (`T42`). Base is a 30-day lock, so 30 days carries no row:

| | Days | Adj. |
| --- | --- | --- |
| Lock term | 45 | −0.15 |
| Lock term | 60 | −0.30 |
| Extension *(max 3, max 30 days)* | 5 | −0.125 |
| | 10 | −0.25 |
| | 15 | −0.375 |
| | 30 | −0.75 |

**(c) Other program requirements** (`X42`): min loan **$100,000**, max loan **$2,500,000**, mortgage
history **0x30x12**, bankruptcy seasoning **36 months**, FC/SS/DIL seasoning **36 months**.

## 3. What this changes for our encoded sheet

`deephaven-dscr-sheet.js` was reconstructed from live LP probing and its own header already admits the
prepay LLPA is *"measured but not yet wired into Layer-1."* Against the real sheet, our gaps are:

- **the whole prepay LLPA family** (6 terms × 2 pricing models) — absent;
- **max-price caps per prepay term** and **max-price tiers by loan amount + the 98.000 floor** — absent
  (this is D37's "max/min price rule", now fully specified);
- **lock-term (45/60) and extension pricing** — absent; we price only the 30-day base;
- **Short-Term Rental** (−0.5 across CLTV) and the **< 250,000** loan-amount row — absent;
- **DSCR band labels differ**: the sheet's middle band is **1.15 – 1.24**, ours is 1.00 – 1.24. The
  sheet lists **no row for 1.00 – 1.14** at all, and LP's own containers are "1.00-1.24" / "< 1.00".
  Do not guess this band — it needs one live measurement at DSCR 1.10.

## 4. ⛔ RESOLVED LIVE — and it is SYSTEMIC: our sheet captured LP's MAGNITUDES and lost the SIGN

The probe below was run live (2026-08-17, same loan, only the DSCR moved; FICO 760, CLTV 50%, NY,
coupon 7.500). It settles the question and exposes a much larger defect than the one row.

| DSCR | LP price @ 7.500 | LP itemized line | vs baseline |
| --- | --- | --- | --- |
| 1.30 | **105.925** | `SimpleRateAdjustment 0.25` | **+0.25 BETTER** |
| 1.20 | 105.675 | *(no DSCR line)* | baseline |
| 1.10 | 105.675 | *(no DSCR line)* | baseline |
| 0.95 | **104.925** | `SimpleRateAdjustment 0.75` | **−0.75 WORSE** |

**The rate sheet is right and we are wrong.** A strong DSCR (≥1.25) is a **CREDIT** of 0.25, exactly
as the sheet states; we encode it as a 0.25 **charge**. Two further things fall out, and the third is
the real one:

1. **The 1.00–1.14 gap is answered**: DSCR 1.10 prices identically to 1.20, so the sheet's
   "1.15 – 1.24" row and LP's "1.00-1.24" container agree — anything 1.00–1.24 is the 0 baseline.
2. **The arithmetic closes exactly**, which is what proves the reading: at DSCR 1.20 LP reports
   `adjustmentPoints = −0.5`, and the sheet gives FICO 760-779 @ 50 CLTV = **+0.875** (credit) with
   NY = **−0.375** (charge): `−(0.875) + 0.375 = −0.5`. ✅
3. **⛔ THE SYSTEMIC DEFECT — LP displays ABSOLUTE VALUES; the DIRECTION lives on the rate sheet.**
   Our `LP_TABLES.FICO_CLTV_LP` row for 760-779 is `[0.875, 0.75, 0.625, 0.5, 0.125, 0.25, 1.125]`
   — all positive. The **sheet's** row is `[0.875, 0.75, 0.625, 0.5, 0.125, −0.25, −1.125]`. The last
   two cells are CHARGES on the sheet and we recorded them with the same sign as the credits, then
   `cost(v) = −v` negated everything uniformly. So:
   - a genuine **credit** cell (low CLTV) is encoded as a **charge** — wrong by twice its value;
   - a genuine **charge** cell (high CLTV) comes out right, by accident.

   This is why the harness could report that our sheet "reproduces Lender Price's itemized values"
   while the resulting PRICE was still wrong: **the magnitudes matched and the signs did not.**

**Consequence + the fix (not applied here).** Layer 1 must be rebuilt from the **Excel** — which
carries the true signs — not from LP's displayed magnitudes, using
`matrices/deephaven-dscr-ratesheet-corr-t0.json` as the source of truth, with the agreement harness
re-run afterwards to confirm the FINAL PRICE (not the itemized magnitudes) matches LP. Nothing has
been re-encoded in this pass: this is a pricing change across the whole grid and it gets its own
careful commit with the price, not the magnitude, as the assertion.

## 4b. The original flag (now superseded by the measurement above)

The sheet is premium-positive throughout (FICO 780+ = +1 at 50 CLTV improves the price; FICO 640-659
= −2.5 worsens it), and our sheet negates LP's cost-positive values (`cost(v) = -v`), so the two
normally agree. **They do not agree on the DSCR ≥ 1.25 row:**

- the sheet states **+0.25 = a CREDIT** (better price for a stronger DSCR — the economically sensible
  direction);
- we encode `cost(0.25)` = **−0.25 = a CHARGE**, reproducing LP's itemized `DSCR Ratio - DSCR >= 1.25`
  as a cost.

Same magnitude, opposite direction. One of the two is mispricing every strong-DSCR loan by half a
point of spread. **This is NOT resolved here and nothing has been re-encoded on the strength of it** —
it is settled by one live probe (price a loan at DSCR 1.30 vs 1.20 and read which way the price
moves), which is queued for the moment the 299-scenario battery releases the LP connection. The same
probe should read the 1.00 – 1.14 band above.

## 4c. ⭐ OWNER-ANSWERED (2026-08-17) — the 0.25 gap IS the margin holdback, across the board

Owner's words: *"The reason the max price doesn't match is because Lender Price max price is already
after our 0.25 holdback. Think of it like this: if the investor is giving me a max price of 104 and
I'm telling you, for Lender Price, give me a 0.25 max holdback, then Lender Price is only showing a
max price of 103.75. Understand the depth of how the margin holdback works, and this is across the
board."*

So the relationship — and it closes the base-ladder question §4b left open:

> **Lender Price's number = the RATE SHEET's number − our margin holdback (0.25)**

- The **rate sheet carries the INVESTOR's raw, PRE-holdback numbers**; **Lender Price shows the
  POST-holdback view**, because that holdback is configured with them.
- This is exactly why the sheet's base ladder sits 0.25 above LP at **all 28 coupons** — that gap is
  not an error and not unexplained.
- **It applies to MAX PRICE too, and to everything else**: a sheet cap of 104 is 103.75 in LP; the
  loan-amount tiers 105 / 104.5 / 103.5 are 104.75 / 104.25 / 103.25 in LP.

**Implementation rule (do not "simplify" this into a constant):** store the sheet's values faithfully
as the sheet states them (pre-holdback), and apply the holdback as an **explicit, named step** through
the existing `margin-holdback.js` — never a second 0.25 literal in another module.

## 4d. ⭐ OWNER-ANSWERED (2026-08-17) — the min-loan difference is an EXCEPTION BAND, not a conflict

The rate sheet says $100,000; our Layer-2 matrix says $75,000. **Both are right.** Owner's words:
*"anything below $100,000 is an internal exception, but you can do … $75,000 on this program. It is
eligible, but under $100,000, it's a manual product and it needs an exception. You can price it
regularly out of their rate sheet and out of the Lender Price pricer, but you just need to mark that
it's a manual exceptional product."*

| loan amount | outcome |
| --- | --- |
| **< $75,000** | INELIGIBLE — below the program floor |
| **$75,000 – $99,999** | **ELIGIBLE and priced normally** off the rate sheet / LP — but **stamped a MANUAL EXCEPTION product** |
| **≥ $100,000** | ordinary |

This is the existing **D34 exception-product** mechanism (eligible, visibly requires an exception), not
a new concept. Guarded by `scripts/test-lt-ppe-ratesheet-matrix-reconcile.js`, which asserts the band
lines up with BOTH source documents — so a future rate sheet that moves either number goes red rather
than letting the band quietly go stale.

## 5. Sources

- Extraction: `matrices/deephaven-dscr-ratesheet-corr-t0.json` (verbatim; nothing derived or rounded).
- Live LP measurements: `DEEPHAVEN-LP-LIVE-FINDINGS-2026-08-17.md`, `LP-SMO-REGISTRY-2026-08-17.md`
  (the `5% Flat Prepay` SMO token, id `6373fe9dce8ad00001a1b87e`, and the `1–5 Yr PPP` series).
- Our encoded sheet under test: `src/longterm/ppe/deephaven-dscr-sheet.js`.
