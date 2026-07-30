# The Silver Program (note buyer: EMCAP)

**Status: LIVE (built 2026-07-29/30, owner-directed).** The third registerable
program — Standard ↔ Fidelis, Gold ↔ Blue Lake, **Silver ↔ EMCAP** — plus the
Manual program. Guidelines and rates are transcribed from the **EMCAP RTL
Seller Pricing & Eligibility Tool v1** (June 2026 guideline version): the Tier
Grid tab, the EMCAP_Pricing Matrix tab (12/18/24-month grids), the
Underwriting Commentary tab, and the hidden Engine tab (1,555 priced cells).
The engine is `web/tools/silver-program.js` (**6 copies**, same layout as the
other frozen engines; `window.SVP`); the full rate fixture lives at
`scripts/fixtures/emcap-pricing-tool-v1.json`; the verification battery is
`scripts/test-silver-program.js` (~90k checks, in `npm test`).

The Silver engine is **frozen** at the same level as Standard/Gold: no number
or formula changes without the owner's explicit written authorization.

---

## 1. Silver program guidelines (what the engine enforces)

### Products, purposes, markets, terms
- Products: **Fix & Flip / Fix & Hold (FF)**, **Ground-Up Construction (GUC)**,
  **Bridge (BR)** — purchase and refinance.
- Markets: **Standard (non-NYC)** and **NYC five boroughs** (own rate grid).
  NYC has **no F&F refinance pricing** and **no loans over $2.5M** — both are
  refused with a plain reason.
- Terms: **12 / 18 / 24 months** (grid buckets; ≤12 → 12, 13–18 → 18,
  19–24 → 24; >24 months → manual review). On the F&F/F&H product an
  **18-month term needs a project budget over $100k** and a **24-month term
  over $200k** (GUC/Bridge: any term).

### Loan-size bands and experience tiers
- Loan sizes **$100k–$2.5M (small band)** and **$2.5M–$4.5M (large band)**.
- Tier by comparable projects completed in the last 3 years
  (ground-up deals count ground-up projects only, same split as Standard):
  - Small band: **Tier 1 = 3+, Tier 2 = 1–2, Tier 3 = 0**
  - Large band: **Tier 1 = 5+, Tier 2 = 2–4, Tier 3 = under 2**
- **GC-only experience** caps the tier: max Tier 2 on small loans, Tier 3 on
  large — and can never qualify for sub-division projects.

### Tier grid (max loan / min FICO / max acq-LTV / max AR-LTV / max LTC)

| Product / purpose | Tier 1 | Tier 2 | Tier 3 |
|---|---|---|---|
| F&F Purchase  | $4.5M / 640 / 90% / 75% / 92.5% | $2.5M / 660 / 90% / 75% / 92.5% | $950K / 680 / 75% / 65% / 85% |
| F&F Refinance | $2.5M / 700 / 75% / 70% / 85%   | $2.5M / 700 / 65% / 70% / 75%   | **not eligible** |
| GUC Purchase  | $4.5M / 640 / 80% / 75% / 92.5% | $2.5M / 660 / 70% / 75% / 92.5% | $950K / 680 / 65% / 65% / 80% |
| GUC Refinance | $4.5M / 640 / 80% / 75% / 92.5% | $2.5M / 660 / 70% / 75% / 92.5% | $950K / 680 / 65% / 65% / 80% |
| Bridge Purchase | $4.5M / 670 / 75% / 75% / 75% | $2.5M / 670 / 75% / 75% / 75%   | $950K / 680 / 70% / 70% / 70% |
| Bridge Refinance | $2.5M / 700 / 75% / 75% / 75% | $2.5M / 700 / 70% / 70% / 70%  | $950K / 700 / 65% / 65% / 65% |

### Rates
- A fixed **grid**, keyed on
  `market | size band | product | purpose | term | tier | AR-LTV band | FICO band | LTC band`
  — 1,555 priced cells, ~**7.88% to 12.37%** note-buyer grid rate. No additive
  build-up, no judicial/heavy adders (unlike Standard).
- Bands: AR-LTV `<64.99% / 65–70 / 70.01–75` (over 75% never priced);
  LTC `<74.99 / 75–80 / 80.01–85 / 85.01–87.5 / 87.51–89.99 / 90–92.5`
  (over 92.5% never priced); FICO `700+ / 660–699 / 640–659`
  (Tier 3 uses `700+ / 680–699 / 640–679`). Under 640 is ineligible.
- **The grid IS the leverage policy**: where the workbook prices no cell (e.g.
  NYC F&F above 80% LTC, NYC below FICO 700), the engine steps leverage down
  band-by-band to the maximum structure the grid actually prices; if no
  leverage level prices, the deal goes to individual review.
- Borrower note rate = grid rate + YS markup (default **0.5%**, admin knob,
  **hard-capped at 1.00%** — see the markup-cap entry under "Mechanics").
  **EMCAP floors its buy rate at (note rate − 1.00pt)** — markup above 1 point
  is eaten by the note buyer, not earned (stated in the studio admin zone).
- Origination default **1.25%** (its own admin knob).
- **Note-buyer label spellings:** the live ClickUp/Sitewire label is **"EMCAP
  Financial"** (normalizes to `emcapfinancial`, not `emcap`). Handled by
  `field-registry.isEmcapNoteBuyer` (prefix helper, the Fidelis db/337 shape)
  for the advisory/months direction, and by the ENUMERATED
  `tapes/emcap.js buyerAliases: ['emcapfinancial']` for the data-tape export
  gate (closed list — never fuzzy in the export direction).

### Geography (hard exclusions — EMCAP's list, not Standard's)
- ZIP-based: **Greater Philadelphia 191xx, Greater Chicago 606/607/608xx,
  Greater Baltimore** (21201, 21202, 21205, 21215, 21216, 21217, 21223,
  21229), **Greater Detroit 481/482/483xx**.
- State-based: **NV, MN, ND, SD**.
- A city name with **no ZIP** routes to manual review to confirm the location
  (a good ZIP is decisive). MSAs with >10 months housing supply are a
  case-by-case underwriting call (not machine-checkable).
- **Indiana and Louisiana are ALLOWED** (Standard bans them; EMCAP does not —
  owner-confirmed default 2026-07-29).

### Deal gates
- **Value-add required:** the ARV must **exceed** total cost basis
  (LTC must be greater than AR-LTV). Equal or below → ineligible (individual
  review possible). Bridge is exempt (stabilized, sized on as-is).
- **DSCR ≥ 1.00** on a fix & hold / rental exit, when the projected rent is
  known (rent ÷ full monthly payment; silent when unknown).
- **Refi cash-out ≤ 50% of projected project profit**; interest reserves are
  netted from cash-out proceeds (underwriting overlay).
- Mid-construction refinances ineligible. Seller financing ineligible.
  Owner-occupied ineligible. Dutch accrual ineligible.
- Assignment fee: **15% of the SELLER's contract price** financeable (the
  company-wide frozen rule — deliberately stricter than EMCAP's own
  15%-of-gross cap), sizing on the effective price.
- Property types: same 1–4-unit residential footprint as Standard (EMCAP's
  sheet is silent on property types; owner-confirmed copy).

### Mechanics copied from Standard (owner-directed)
- **Interest reserve:** financed into the loan, part of the cost basis,
  capped at the full loan term (months or exact dollar amount).
- Liquidity to show: cash to close + **2 months of interest (4 over $1M)**;
  **2 months of bank statements** (owner-directed 2026-07-29 — EMCAP requires
  two months, same as Blue Lake; `liquidity.js` programMonths silver=2 +
  NOTE_BUYER_MONTHS emcap=2).
- Draw fees $299 hybrid / $499 physical; 3-month minimum earned interest
  **off by default**; min loan $100k; markup 0.5% default / origination 1.25%.
- **Markup hard-capped at 1.00%** (owner-directed 2026-07-29): EMCAP's buy
  rate is floored at the note rate minus 1.00 point, so any spread above 1
  point goes to EMCAP, not YS ("EMCAP eats any markup over 1 point"). The
  engine clamps `setMarkup`/`effMarkup` at `MARKUP_MAX = 0.01` (all 6 copies)
  and the Pricing Admin Center refuses a Silver markup above 1.00%.
- Loan sizing runs through the same frozen `YSP.sizeLoan` waterfall with
  Silver's caps; whole-dollar floor + breakdown reconciliation unchanged.

### Underwriting overlays (shown on every Silver evaluation; conditions/ISG)
Appraisal comps (≥1 as-is + ≥1 ARV comp: sale within 12 months, <15% net
adjustments, same ZIP; interior photos; submitting lender named on the
appraisal); refinance background/exit + purchase-price-as-as-is rule (>18
months → appraisal as-is usable); GUC refi within 18 months may use price +
documented value-add (1:1 invoices); bridge/stabilized refi requires current
payments (VOM), taxes current, profitable incl. new fees & carry; experience
overlays (loans >$1M and GUC budgets >$500k: prior projects within 80% of
budget/re-sale; GUC counts only new-construction comps); entity ownership ≥25%
verified; background: BK/FCL within 5 years, tax liens/judgments >$15k, or
financial-crime history are ineligible (Elementix remarks: LOE, case-by-case);
prior sale within 24 months needs arms-length evidence; assignment fees / A-B
transactions / seller credits each ≤15%.

---

## 2. Silver vs Standard — the full comparison

### Where Silver (EMCAP) gives MORE than Standard (Fidelis)
1. **Bigger loans:** up to **$4.5M** (Tier 1) vs Standard's $2.5M national /
   $3.5M CA-NY.
2. **Much more ground-up leverage** (the owner's headline): GUC purchase
   Tier 1 **92.5% LTC / 80% acq / 75% AR-LTV up to $4.5M** vs Standard's
   85% / 70% / 70% up to $2.5M; GUC min FICO **640 vs 680**; GUC Tier 3
   allowed at 80% LTC vs Standard 80% but min FICO 680 vs 740.
3. **Cheaper rates:** grid from **7.88%** (GUC small, low leverage) /
   8.00% (F&F) vs Standard's 9.25% buy-rate floor — roughly 1–1.5 points
   cheaper across most of the grid.
4. **F&F purchase Tier 2 keeps 75% AR-LTV** (Standard drops Tier 2 to 70%).
5. **F&F refinances allowed in CA and FL** (Standard bans F&F refis outside
   the national footprint; EMCAP's list doesn't ban those states) — still no
   F&F refi in NYC (no priced cells).
6. **Indiana + Louisiana allowed** (Standard: banned).
7. **GC-only experience counts** (capped Tier 2/Tier 3) — Standard has no
   GC-experience concept at all.
8. **GUC refinance at Tier 1 to $4.5M / 92.5% LTC** vs Standard's $2.5M/85%.
9. **No judicial-state or heavy-rehab rate adders** — the band grid already
   prices the risk.

### Where Silver is TIGHTER than Standard
1. **Min FICO 640** program-wide (Standard prices from 600; 600–639 exists
   only as waiver/manual on Standard).
2. **Refinance tiers require FICO 700** on F&F and Bridge (Standard: 640–700).
3. **F&F refi leverage lower:** Tier 1 75% acq / 85% LTC vs Standard's 80% /
   85%; Tier 2 65% acq / 75% LTC vs Standard's 75% / 80%.
4. **Tier 1 needs 3 comps; 5 comps over $2.5M** (Standard: 3+ at any size).
5. **Value-add gate is a hard fail** (ARV must EXCEED basis; Standard only
   routes an ARV shortfall to manual pricing).
6. **DSCR ≥ 1.00 gate** on rental exits (Standard: none).
7. **Cash-out capped at 50% of projected profit** (Standard: a rate adder,
   no profit cap).
8. **Geography:** NV / MN / ND / SD banned (Standard allows); ZIP-precision
   bans for Philly/Chicago/Baltimore/Detroit (Standard bans those cities for
   itself too, by city name).
9. **Background overlays:** BK/FCL 5-year lookback, liens/judgments >$15k,
   financial-crime bans, arms-length evidence on 24-month resales, seller
   financing ban, A-B/seller-credit 15% caps (Standard doesn't encode these).
10. **NYC:** F&F capped at 80% LTC / FICO 700+; nothing over $2.5M; no F&F
    refis (Standard's CA-NY overlay instead caps at $3.5M with F&F-refi ban).
11. **Bridge refi Tier 3 min FICO 700** vs Standard's 740 — but Standard
    allows $1.5M there vs Silver's $950K Tier 3 cap.

### Structural differences (how it's built, not what it allows)
- Standard: additive rate build-up (base + tier + FICO + leverage + term +
  cashout + judicial + heavy, floor/cap). Silver: pure grid lookup on the
  9-part key; missing cells are themselves policy (leverage step-down).
- Standard: state regimes (NAT/FL/CANY). Silver: NYC-vs-everywhere + the
  exclusion lists; the ZIP code is a first-class engine input.
- Both: same sizing waterfall, same reserve-in-cost mechanic, same
  assignment math, same rounding/reconciliation, same min $100k.

---

## 3. Where Silver is wired (system inventory)

- **Engine:** `silver-program.js` × 6 (web/tools, web/v2/tools,
  web/portal/engines, web/v2/portal/engines, app/public/engines,
  app-v2/public/engines) — frozen.
- **Term Sheet Studio (V2):** third program card, drill-in detail, leverage
  slider on the grid's band edges, PDF/Excel/proof-of-funds/deal-profile
  exports, admin zone (`tsYspSilver`, `tsOrigSilver`, `tsMinIntSilver`).
- **Server pricing:** `src/lib/pricing.js` (`quoteProgram('silver')`,
  quoteAll returns standard+gold+silver, ZIP input, sticky
  `file_markup_silver_pct`).
- **Pricing Admin Center:** company defaults `markup_silver_pct` /
  `orig_silver_pct` (db/373) + V2 screen fields; `/api/pricing-defaults`
  serves them; override-approval detector covers the Silver knobs.
- **Register:** staff + borrower routes and the escalation accept path take
  `program:'silver'`; liquidity condition writes the 2-MONTH Silver wording
  with the loud ⚠️ banner (owner-directed 2026-07-29/30 — see
  `liquidity.js` `loudMonthsBanner`); economics-reopen trigger watches the
  Silver sticky markup (db/373).
- **Conditions/rules:** `registered_program` rule enum has `silver`; no
  Silver-specific conditions by default (no SOW-contingency, flood rule
  unchanged — same posture as Standard).
- **Tapes:** Silver ↔ EMCAP un-parked in `program-provider.js`; a non-admin
  exports the EMCAP tape only on an EMCAP loan registered Silver.
- **ClickUp:** `registered_program` → **“The Silver program”** (the dropdown
  option must be added by hand in ClickUp's RTL Loan Program field).
- **Encompass:** capital provider EMCAP already in the CX.CAPITALPROVIDER
  dropdown/value map (read-only compare).
- **Borrower safety:** EMCAP added to the partner-name scrub patterns;
  borrower-facing copy says "Silver Program", never the buyer's name.
- **ISG (advisory):** `isg_emcap_missing_1007` / `isg_emcap_rent_mismatch`
  (pre-existing) + `isg_emcap_excluded_state`, `isg_emcap_mid_construction`,
  `isg_emcap_cashout_over_half_profit` (Silver build).

## 4. Deliberate interpretations (flag to the owner if wrong)
1. **Bridge is exempt from the value-add gate** (the workbook formula would
   technically fail any bridge whose ARV ≤ cost, but a stabilized bridge has
   no value-add component; bridge AR-LTV is measured against as-is when no
   ARV is entered).
2. **Assignment fee basis:** company rule (15% of seller price) enforced over
   EMCAP's looser 15%-of-gross — conservative in EMCAP's favor.
3. **Refi acq-LTV** is measured against the as-is value (Standard's refi
   convention); EMCAP's purchase-price-as-as-is commentary governs WHICH
   as-is value underwriting puts on the file.
4. **Term buckets:** a 15-month request prices as the 18-month grid, 20-month
   as 24-month; over 24 is manual.
5. **Experience counting** uses Standard's split (GUC counts ground-up only);
   the 80%-comparability overlays stay underwriting checks, not engine gates.

---

## 5. Regenerating from a new workbook (the update pipeline)

The owner's ask: *"our system should be built in a way that I can give you a
new Excel sheet and you just update the pricing according to the new Excel
sheet."* Everything derived from the workbook is therefore REPRODUCIBLE from a
committed copy of the workbook itself:

- **Archived source workbook:** `scripts/fixtures/EMCAP_Pricing_Tool_v1.xlsx`
  (sha256 `432ff2d8c34bd28ca159aae44806177afa2607f5669cd229e5b885942535182b`,
  the June 2026 `EMCAP_Pricing_Tool_v1_33.xlsx`) — the byte-identical file the
  committed fixture and engine literals were built from.
- **Pipeline tool:** `scripts/emcap-regenerate-fixture.js` (pure Node — its own
  minimal ZIP/SpreadsheetML reader, no python, no npm deps, no network).
  Modes:
  - *default / `--check`* — CHECK-ONLY (writes nothing): extracts the hidden
    **Engine** sheet (RateKeys/RateVals columns A/B → 1,555 rate cells; TG*
    columns E–J → 18 tier-grid rows), serializes it byte-exactly, and diffs
    against the committed `scripts/fixtures/emcap-pricing-tool-v1.json`
    (per-key diff on mismatch); PLUS the tab-2 cross-source verification
    (below). Exit 0 clean / 1 on any drift.
  - *`--blocks`* — compiles the engine's `RATE_BLOCKS` (rate ÷ 0.000125 into
    the fixed 54-slot 3 AR × 3 FICO × 6 LTC block geometry, 112 blocks) and
    `TG` literals from the workbook and verifies the LIVE
    `web/v2/tools/silver-program.js` (and all 5 sibling copies) carry exactly
    that text, plus a semantic reconstruction check through the loaded engine.
  - *`--write`* — rewrites the fixture JSON (never an engine file). Refused
    while the cross-source check reports an UNEXPECTED divergence.
  - *`--emit-blocks <path>`* — writes the freshly compiled literal text for
    the human engine-update step.
- **Test:** `scripts/test-emcap-regenerate-pure.js` proves the committed
  artifacts regenerate bit-for-bit from the archive AND that a single mutated
  rate cell fails the check naming the exact key.

### Engine-tab-vs-tab-2 precedence (the transcription decision)

The **hidden Engine sheet governs**. It is the workbook's own machine-readable
index of the display grid (its cells are formulas pointing into tab 2, and the
workbook's Pricing Tool quotes exclusively through it), and the fixture + the
frozen engine are deliberately faithful to it. Tab 2 (`EMCAP_Pricing Matrix`)
displays **251 priced cells the Engine sheet deliberately omits** — the
expected-differences contract, pinned in the tool's `EXPECTED_TAB2_ONLY`:

- **84 BRIDGE cells** under the `75.01%-80.00%` AR-LTV display band (the
  Engine sheet never prices AR-LTV above 75%; those tab-2 rows are display
  only, matching the tier grid's 75% AR cap), and
- **167 refi-24 cells** (24-month refinance columns for GUC/Bridge that the
  Engine sheet carries no `R|24` keys for — the workbook's own Pricing Tool
  cannot quote them either; the engine correctly finds "no priced grid cell"
  there and steps leverage down / routes to review).

`--check` re-derives tab 2 from scratch on every run and **fails on any
divergence beyond exactly that list** (including a changed count in either
direction), so a future workbook update surfaces every new difference
explicitly instead of silently inheriting an interpretation.

### The 7-step update procedure (new workbook arrives)

1. **Archive the new workbook**: overwrite
   `scripts/fixtures/EMCAP_Pricing_Tool_v1.xlsx` with the new source file
   (git history keeps the old one) and update `ARCHIVE_SHA256` in
   `scripts/emcap-regenerate-fixture.js` (`sha256sum` the file). Also update
   the sha in this section.
2. **Regenerate the fixture**: `node scripts/emcap-regenerate-fixture.js
   --write`. If the cross-source check reports anything beyond the expected
   251, STOP — every divergence must be resolved or owner-confirmed first
   (then `EXPECTED_TAB2_ONLY` updated to the newly confirmed contract).
3. **Recompile the engine literals** (HUMAN step — the engines are frozen, so
   this requires the owner's explicit written authorization for the rate/tier
   change): `node scripts/emcap-regenerate-fixture.js --emit-blocks
   /tmp/blocks.txt`, then in `web/v2/tools/silver-program.js` replace the
   `    var RATE_BLOCKS = {` … `  };` region and the `  var TG = {` … `  };`
   region with the compiled text. A band-structure (geometry) change fails the
   compile loudly and needs an engine rework, not a paste.
4. **Sync the 6 engine copies + cache-busters**: copy
   `web/v2/tools/silver-program.js` over `web/tools/`,
   `web/portal/engines/`, `web/v2/portal/engines/`, `app/public/engines/`,
   `app-v2/public/engines/`; bump the `silver-program.js?v=silver2`
   cache-busters in `web/v2/tools/term-sheet.html`,
   `web/v2/portal/index.html`, `app-v2/index.html`.
5. **Re-verify the pipeline**: `node scripts/emcap-regenerate-fixture.js`
   (default check + blocks) must print `RESULT: CLEAN` and exit 0.
6. **Run the batteries**: `node scripts/test-silver-program.js`,
   `MATRIX_N=500 node scripts/test-silver-workbook-matrix.js`,
   `node scripts/soak-silver-scenarios.js`,
   `node scripts/test-emcap-regenerate-pure.js` — then the full `npm test`
   before merging.
7. **Owner re-freeze**: record the guideline change + the new workbook
   version/sha in this doc and the CLAUDE.md frozen-baseline notes, with the
   owner's written authorization quoted; the engine is then re-frozen at the
   new numbers.
