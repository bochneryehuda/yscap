# Parity + the recorded pricing baseline (measured 2026-08-16)

Produced by `parity-matrix.js` against the live tenant. Re-run it after any change to the request
builder and diff against this page; a row that moves without a reason in the commit message is a
regression, and a row that moves the wrong way is a borrower being quoted fewer lenders than they
are entitled to.

```
node docs/longterm/ppe-research/parity-matrix.js            # anchor + matrix
LP_CAPTURE_REQUEST=<captured frontend body> node …          # include the exact-parity anchor
```

---

## 1. Parity — proven twice, against two independent real captures

The owner's HAR captures contain **14 real `searchRaw` calls from the vendor's own website, every
one HTTP 200**, of which 7 carry a full request body and 2 are distinct scenarios (the other 5 are
poll repeats of the first, with `cachedDisqualified: true`). Those 2 are our anchors. For each, the
scenario is read back **out of** the capture — so the deal is identical rather than merely similar —
our builder is asked for the same deal, and both bodies are posted in the same run.

| anchor | scenario | their capture | our builder | verdict |
| --- | --- | --- | --- | --- |
| req-01 | Refinance · NY 11211 Kings · 500k/400k · 80% LTV · FICO 760 · DSCR 1.5 · interest-only · 36mo prepay | 11 programs, 309 options, 8 lenders | 11 programs, 309 options, 8 lenders | **EXACT** |
| req-07 | Refinance · NJ 07036 Union · 400k/280k · 70% LTV · FICO 760 · DSCR 1.5 · 2–4 unit ×3 · 36mo prepay | 13 programs, 470 options, 8 lenders, best 5.875% | 13 programs, 470 options, 8 lenders, best 5.875% | **EXACT** |

A third, independent confirmation: the owner's analyst measured the vendor's website returning
**17 programs / 439 priced rows** for the purchase baseline below. Our builder returns exactly
**17 programs / 439 options** for that scenario — arrived at from the other direction, by a different
person, on a different day.

**What parity does and does not mean here.** It means: for a deal we can state identically on both
sides, the vendor returns the same lenders, the same programs and the same number of priced rows to
our API as to its own website. It does **not** mean every scenario below has been compared — we hold
captures for two. That distinction is kept deliberately visible in §2.

---

## 2. The recorded baseline — what we return today

**These rows are a BASELINE, not a comparison.** There is no captured frontend body for a 700-FICO
purchase, so there is nothing for it to be "equal to". What they establish is what we return today,
so that a future change which silently drops a lender shows up as a diff instead of being discovered
by a borrower. Calling them parity would be the same category error that produced three separate
wrong conclusions earlier in this integration's history.

Common baseline: **Purchase · NY 11211 Kings · $500,000 value / $400,000 loan (80% LTV) · FICO 760 ·
DSCR 1.5 · single family, 1 unit, detached · LLC · DSCR income doc · 30-year term · 30-day lock ·
60-month prepay.** Each row moves ONE axis off it, so a row that misbehaves names its own cause.

| scenario | programs | options | lenders | best rate |
| --- | ---: | ---: | ---: | ---: |
| baseline — purchase, 80% LTV, FICO 760 | 17 | 439 | 10 | 5.75% |
| FICO 700 | 13 | 330 | 8 | 5.75% |
| FICO 680 | 7 | 180 | 6 | 5.75% |
| 75% LTV (loan 375k) | 19 | 479 | 10 | 5.75% |
| 65% LTV (loan 325k) | 19 | 480 | 10 | 5.75% |
| rate-and-term refinance | 16 | 413 | 10 | 5.75% |
| cash-out refinance (50k cash) | 3 | 89 | 2 | 6.125% |
| 15-day lock | 10 | 256 | 5 | 5.75% |
| 45-day lock | 13 | 336 | 9 | 5.75% |
| 15-year term | 2 | 56 | 1 | 6.125% |
| no prepay | 19 | 459 | 11 | 5.5% |
| 36-month prepay | 19 | 495 | 11 | 5.5% |
| DSCR 1.10 | 16 | 411 | 10 | 5.75% |
| DSCR 0.90 | 1 | 28 | 1 | 6.125% |
| 2–4 unit ×3 | 13 | 336 | 9 | 5.75% |
| larger deal — 1.2M / 840k | 20 | 512 | 10 | 5.75% |

**16 of 16 priced. No HTTP 500, no empty result set, on any axis.**

### Reading the numbers as a sanity check

The shape of the table is itself evidence the request is being understood, because the movements are
the ones a lender would make and none of them is flat:

- **Credit tiers bite in the right direction and by a believable amount** — 760 → 17 programs,
  700 → 13, 680 → 7. A request the vendor did not understand would not produce a monotonic ladder.
- **Lower leverage widens the field** (80% → 17, 75% → 19, 65% → 19) and the best rate holds, which
  is what a rate sheet does.
- **A short prepay is priced as risk**: no prepay and 36-month both return MORE programs than the
  60-month baseline and a better best rate (5.5% vs 5.75%) — worth flagging to the business, since
  the profile currently defaults to 60 months.
- **The thin rows are thin for real reasons** — a 15-year DSCR term (2 programs), a sub-1.0 DSCR
  (1 program) and a cash-out (3) are genuinely niche products, not failures.

### What this table cannot tell you

A count matching is not the same as a PRICE matching. These rows compare how many products come
back, and the anchors compare that against the vendor's own site — but no row here has been checked
rate-for-rate and point-for-point against a human's screen. That comparison needs a fresh capture
taken at the same moment as an API call, because rates move during the day. It is the next thing to
measure, and until it is measured this page should not be read as proving our rates are right.
