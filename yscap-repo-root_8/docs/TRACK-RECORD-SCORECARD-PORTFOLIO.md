# DRAFT — Research proposal (owner review before build)

# Borrower track-record scorecard + portfolio watch

*Stream C research pass, 2026-08-09. Research + design only — no code was changed. This document is
for owner review before anything is built.*

---

## 0. In plain words (read this first)

Today PILOT already **counts** a borrower's completed deals and works out their experience tier, but
those numbers are scattered across a file and a profile tab. The biggest gap versus the market leader
(Forecasa) is that we do not put them together into **one scorecard** — "here is this borrower's
verified track record at a glance" — and we do not **watch a borrower over time** to notice when they
did a new deal, took on too many projects at once, or piled up in one town.

This proposes two linked, **staff-only, advisory** things:

1. **A scorecard** — one consolidated card per borrower: their verified flips / holds / ground-up in
   the last 3 years, their tier, how fast they do deals, average hold time, where they buy, biggest
   deal, and verified-vs-claimed. Every number is **already computed somewhere** — this just
   consolidates it into one place.
2. **Portfolio watch** — PILOT quietly keeps an eye on each borrower and tells the officer when
   something changes: a **new deal** (with us, or seen in public records), **overextension** (too many
   unfinished projects at once), or **concentration** (too many in one market).

**Nothing here changes a price, and nothing here is ever shown to a borrower.** It is intelligence for
the desk, exactly like the existing draw-portfolio monitor and the vendor scorecard.

---

## 1. Non-negotiables (these are the guardrails, stated up front)

These are hard rules for the build. They are drawn from constraints already enforced elsewhere in the
codebase, so the build extends existing discipline rather than inventing new latitude.

| Rule | Why / how it holds |
|---|---|
| **Advisory only.** It flags things for a human; it never moves money, changes a status, clears a condition, or blocks anything. | Same posture as `src/sitewire/monitor.js` (the draw monitor) and the AI-findings advisory rule in `CLAUDE.md`. |
| **Never re-prices. Pricing is frozen.** The scorecard reads the **frozen** verified count and the **frozen** tier ladder; it never produces a *new* tier or count that could feed a sizing formula. | The loan sizes on the **claimed** experience of record (frozen 2026-07-14 rule); the tier ladder thresholds are frozen in `web/tools/track-record.js:129-133`. A pricing effect requires **explicit written owner authorization** per the HARD RULE in `CLAUDE.md`. |
| **No skip trace, ever.** No contact phone/email is looked up or shown. | Enforced structurally today: `submit_contact_enrichment` is **absent** from `src/lib/elementix/lookups.js:65-89`; `contactFor()` only ever returns an *already-unlocked* person (`lookups.js:399-431`). The scorecard and watch call **only free record tools** (deeds/mortgages) and never touch contact tools. |
| **No contact data in an underwriting decision (the FCRA plane).** | The "two planes" rule from `docs/ELEMENTIX-CRM-PLAN.md:12-34`: deed/record history used to corroborate a claim is a permissible §1681b pull; skip-traced contact data may **never** reach a credit decision. This feature lives entirely on the underwriting/record plane and reads no contact data. |
| **Staff-only.** Never a borrower-facing surface. | Note-buyer/partner names, tiers, watch signals — all staff-only, same as the whole ISG / research warehouse (`docs/PROPERTY-COMP-DATABASE-RESEARCH.md:294-305`). |
| **Cache-first, to protect the paid ceiling.** Any periodic sweep must respect the shared Elementix ceiling — cache-first and hard-bounded. | The 1,000/hour platform bucket is **shared by the whole organization** (`src/elementix/client.js:73,100,500`); the paid contact cap is **1,000/month** (`client.js:301`). A sweep that ignores this "starves the person on the phone." |

---

## 2. Product scope: this is **RTL**

Everything below sits on `track_records`, `applications`, `borrowers`, `experience.js`, the research
warehouse, Elementix, and `notification-digests.js` — **all RTL**. Per the two-products rule in
`CLAUDE.md`, this is an RTL build and touches nothing on the Long-Term side. (Confirm in the open
questions — but the data model leaves little doubt.)

---

## 3. What the industry leaders actually do (grounded research)

**Forecasa** is the reference point, and its feature set maps one-to-one onto the two halves of this
proposal:

- It "surfaces a borrower's full lending history, including **properties financed, lenders worked
  with, geographic footprint, and deal velocity**, so underwriting teams can assess track record with
  data, not just a loan application." → **that is the scorecard.**
- It lets you "trace borrower activity across lenders and transactions to **verify experience, detect
  overextension, and assess concentration risk**." → **that is portfolio watch** (overextension +
  concentration), in Forecasa's own words.
- It maps "borrower-lender relationships, **repeat engagement, and cross-lender activity** to detect
  concentration patterns and exposure risk," and publishes proprietary **"lender loyalty"** metrics.

**Built** frames the same idea as **risk dashboards** covering "borrower health," "**concentration
risk**," and "**early warning signals like stale data**" so teams "act before problems escalate" — the
exact advisory-monitor pattern PILOT already runs for draws in `src/sitewire/monitor.js`.

**Baseline** emphasizes portfolio performance "at a glance" (delinquencies, balances) and is explicitly
built for **repeat fix-and-flip borrowers**. **LendingWise** markets its CRM as increasing "repeat
borrowers" with pipeline analytics.

**The takeaway:** the market treats a borrower's cross-deal history as a first-class, at-a-glance
object and proactively monitors it. PILOT has the raw data (arguably *better* data — we hold the real
verified track record, the research warehouse, and Elementix) but has never consolidated or watched it.
The gap is presentation and monitoring, not data.

*(Sources are listed at the end.)*

---

## 4. Part A — the borrower track-record scorecard

### 4.1 The one insight: every number already exists

The scorecard is a **consolidation**, not new math. Mirror the exact shape of the existing
`src/lib/vendor-scorecard.js`: a **pure** scoring function (deterministic, `now` injected,
unit-testable, **never throws**) plus a thin `scorecardsFor(borrowerIds)` that is the only part that
touches the database and returns `{}` on failure (`vendor-scorecard.js:39-40,142-188`). A scorecard is
"decoration on a decision and must never be what stops somebody" — same rule here.

### 4.2 The metrics, and exactly how each is computed

Every row below reuses `src/lib/experience.js` and `track_records`. **The tier is never recomputed** —
see §4.3.

| Metric | Computed from | Notes |
|---|---|---|
| **Experience tier** (New investor / Emerging / Experienced / Seasoned / Expert) | The **verified, in-window** qualifying count → the **frozen** ladder thresholds (1 / 3 / 5 / 10). | Read the count from `experience.countBorrowersExperience(ids, db, {verifiedOnly:true})` (`experience.js:192-210`, which uses the frozen `RECENT_EXIT_SQL`, `experience.js:77-80`). The ladder is **display-only** and already exists twice — see §4.3. |
| **Verified flips / holds / ground-up (36-mo window)** | `countBorrowersExperience(ids, {verifiedOnly:true})` → `{flips, holds, ground, total}`. | The bucket split is `bucketOf(deal_type)` (`experience.js:158-163`). This is the headline trio the `ExperienceHeader` already renders. |
| **Verified-vs-claimed** | Claimed = `requestedFromApp(app)` (`experience.js:165-171`, the `requested_exp_*` columns); Verified = the verified count above. | Forecasa's whole pitch — "track record with data, not just a loan application." The gap already drives the experience condition; the scorecard just shows it side by side. |
| **Deal velocity** | Count of **qualifying in-window exits** ÷ years in window (e.g. "3 exits in the last 12 months"). | Reuse the exit rule — `experience.exitDateOf(row)` / `exitCounts(row)` (`experience.js:135-151`), the frozen JS twins of `EXIT_DATE_SQL`. Never invent a new date rule. |
| **Average hold time** | For each line: `purchase_date` → its exit (`sale_date` for a flip, `rent_date`/`refi_date` for a hold), averaged. | The frozen client tool already computes this as `avgHold` (`web/tools/track-record.js:127`). A line missing a date is **skipped, never guessed**. |
| **Geographic footprint** | Distinct `(city, state)` (or county) over the borrower's lines, from `track_records.property_address` jsonb. | Pure aggregation. Show a count + a short list ("4 markets: Paterson, Newark, …"). |
| **Largest deal** | `max(sale_price, purchase_price)` across the lines. | Pure. |
| **Total volume / rehab deployed** | Sum of exit prices (flips) + purchase (holds) and rehab amounts. | The frozen tool already computes `vol` / `rehab` (`web/tools/track-record.js:134-135`). |
| **Data-confidence flags** | "thin sample" when very few verified deals; "N still to verify." | Mirror `vendor-scorecard.js` `THIN_SAMPLE` (`vendor-scorecard.js:46,115`). |

Every one of these is a **pure function of `track_records` rows + the experience counts** — no new
frozen rule, no pricing input.

### 4.3 The tier is read, not recomputed (important)

The named ladder already exists **verbatim in two places**, and the scorecard must not add a third:

- The **frozen** client tool: `web/tools/track-record.js:129-133`.
- The staff header component: `app-v2/src/components/track-record/ExperienceHeader.jsx:25-31`
  (`tierOf(qn)`), whose own comment states it "repeats the tool's own thresholds VERBATIM … over the
  VERIFIED in-window count — display math only, it writes nothing and gates nothing."

**Recommended approach:** the scorecard **feeds `ExperienceHeader` the verified counts** and lets it
render the tier (reuse, zero new tier math). If a tier string is ever needed **server-side** (for the
TPR summary in Part C, or a digest line), lift the ladder into **one** pure helper `tierFor(count)`
with a test that pins it byte-equal to the frozen tool — the same SQL-twin / JS-twin discipline the
repo uses everywhere (e.g. `experience.js` exit rules). Do **not** hand-write a fourth copy.

> Open item: the `borrowers.tier` column is displayed as a pill in the profile header
> (`StaffBorrowerDetail.jsx:147`). We should confirm what writes it and ensure the scorecard tier is the
> **verified-count ladder** (recommended) rather than that stored column, so the two can never disagree.
> See open questions.

### 4.4 One consolidated view, and where it mounts

There is **already one arrangement** of a borrower's record — `ExperienceHeader` + `RecordLedger`,
mounted on both the loan file's Track Record Center (`sec-track`) and the profile's Track record tab
(`StaffBorrowerDetail.jsx:461-603`, header at line 581). The scorecard is a **superset of what
`ExperienceHeader` already shows** (it adds velocity, hold time, footprint, largest deal, volume).

**Recommendation:** extend `ExperienceHeader` (or add a sibling `ScorecardCard` rendered right beside
it) so the consolidated scorecard renders **in the Track record tab header** and on the file's Track
Record Center header — the natural home, and it keeps the "one arrangement, two lenses" rule the repo
already follows (`track-record-todo.js:222-245`, the file lens vs the borrower lens). A **compact**
version (tier + verified trio + a velocity line) can also ride the file **Overview** (`sec-overview`),
next to `DealSnapshot`, since that is where an officer opens a file.

**New surface / endpoint:** `GET /api/staff/borrowers/:id/scorecard` (staff-scoped via
`VISIBLE_BORROWER_SQL`), returning the pure scorecard for that person; the loan file reuses it for its
file-borrower ids (`experience.fileBorrowerIds(app)`, `experience.js:215-217`, so a co-borrower file
sums both).

### 4.5 Reuse vs new (Part A)

- **Reuse:** `experience.js` (all counting + the frozen window), `track-record-todo.borrowerTrackRecordView` (`track-record-todo.js:231-245`, already returns per-line ledger + verified counts), the `ExperienceHeader`/`RecordLedger` components, and the `vendor-scorecard.js` shape.
- **New:** one small `src/lib/borrower-scorecard.js` (pure `scoreTrackRecord()` + `scorecardsFor()`, mirroring `vendor-scorecard.js`), one endpoint, and the UI extension.
- **New table:** **none.** Everything derives from `track_records` + the experience module.

---

## 5. Part B — portfolio watch

### 5.1 The signals and exactly how each is computed

Mirror the shape of `src/sitewire/monitor.js` `assessPortfolioAlerts` (`monitor.js:42-98`): a **pure**
core that takes the data + `nowMs` and returns `{code, severity, message}` alerts, computed only from
real data we hold, skipping any signal whose input is missing (never estimated).

| Signal | Computed from | Cost |
|---|---|---|
| **Overextension** — too many concurrent unexited projects | Count of `track_records` lines with **no completed in-window exit** (the `no_exit` / `future_exit` verdicts already computed by `track-record-todo.js` `LINE_SQL`, lines 165-191) **+** open loan files (`applications` where the borrower/co-borrower is on the file and status is not funded/declined/withdrawn). A borrower with many in-flight projects and few exits is "overextended." | **Zero paid calls** — pure over our own tables. |
| **Concentration** — too many in one market | Group the unexited set by `(city/county, state)` from `property_address`; flag when one market exceeds a threshold count/share. | **Zero paid calls.** |
| **New deal** — a deed they did that is not on our record | For the borrower's entities (`llcs`) + their own name, read public deeds via `elementix.lookups.researchPerson` / `researchProperty` (`lookups.js:304-333,488-579`), normalize with `SHAPES.deeds` (`shapes.js`), then **diff** each deed's property against (i) `track_records` addresses, (ii) our `applications` property addresses, and (iii) the research warehouse `properties` — all compared **by meaning** with `address.sameAddress` (the repo's canonical comparator). A deed matching **none** of those, recorded after the borrower's last sweep watermark, is a **new deal**. | **The only signal that spends the shared Elementix budget** — see §5.3. |

Overextension and concentration are essentially **free** and can run on every sweep. The **new-deal**
signal is the one that needs discipline.

### 5.2 How alerts are delivered (reuse the digest self-gate + business-hours pattern)

Reuse `src/lib/notification-digests.js` end to end — do **not** invent a second scheduler:

- Add a `portfolioWatchSweepOnce()` function (its own module wired into the same 30-minute dispatcher),
  self-gating per borrower through the shared `_gate` / `claimOncePerPeriod` **`audit_log` stamp**
  (`notification-digests.js:142-171`) under a **new `DIGEST_ACTION`** (mirror the catalogue at
  `notification-digests.js:59-95`). This is atomic across instances and **fails closed**, exactly like
  every existing digest.
- Fire **only inside the `nyParts` business-hours / morning window** (`notification-digests.js:122-131`)
  so it is never a 3am email — same as `staleFileAlertsOnce` (`notification-digests.js:488-528`), which
  is the closest existing template (per-file, self-gated, oldest-first, capped).
- Deliver to the borrower's **primary officer + assigned team** via `notify.notifyStaff` /
  `notifyAppStaff`. Per the standing rule that **routine staff events are in-app only** (`CLAUDE.md`),
  lean **in-app** for individual signals, with a **weekly per-officer email digest** ("what changed on
  your borrowers this week") modeled on the existing daily/weekly pipeline digests. **Never**
  borrower-facing.

### 5.3 The paid-call discipline (this is the crux)

A periodic sweep must respect the ceilings. The rules:

1. **Cheap signals need no budget.** Overextension + concentration are pure over our own tables — run
   them every sweep for every watched borrower at no vendor cost.
2. **New-deal uses only FREE record tools.** `get_person_deeds` / `get_entity_deeds` (via
   `lookups.js`) are free; the **paid** `submit_contact_enrichment` is **structurally unreachable**
   from that module (`lookups.js:65-89`). So the monthly **paid** cap of 1,000 is untouched — but
   these calls still consume the **shared 1,000/hour** platform bucket, so:
3. **Cache-first.** Before calling Elementix for a borrower, check the **research warehouse**
   (`properties`, `property_observations` — `docs/PROPERTY-COMP-DATABASE-RESEARCH.md`) and the
   track-record importer's staged records. Only sweep a borrower whose deed records were **last
   refreshed longer than a TTL ago** (e.g. 30–90 days). The TTL watermark **is** the cache key.
4. **Bounded + oldest-first.** Cap the number of borrowers swept per run (small — e.g. 10–25/day),
   oldest-watermark-first (the same fairness ordering as `weeklyBorrowerOutstandingOnce`,
   `notification-digests.js:239-253`). Every call already routes through `elementix.client`, which
   enforces `overBudgetShared()` (cross-instance hourly guard that **fails open**, `client.js:90-105`)
   and records a ledger row (`client.js:114-122`). The budget meter (`client.usage()`, `client.js:473-490`)
   already surfaces "calls this hour / paid this month" for the staff workbench.
5. **Bounded page reads.** Deed reads must pass `perPage` (the vendor silently serves 5 rows otherwise
   — `lookups.js:461-473`), and a truncated list is reported, never treated as complete.

**Net:** the cheap signals are unlimited; the new-deal signal is a small, cache-first, watermarked,
oldest-first daily trickle that can never exhaust either ceiling and never spends a paid credit.

### 5.4 New table: prefer none; one tiny alert-ledger if we want dismissible new-deal alerts

- **Overextension + concentration:** **derive, no table.** They are pure functions of live data; a
  stored copy would just go stale. Compute at read/sweep time.
- **New-deal alerts:** these need **durability** for two reasons — a *dismissed* alert must **stay
  dismissed** (the exact "decided stays decided" rule of `track-record-findings.js:28-40` and
  `finding_decisions` / db/333), and we need the **per-borrower sweep watermark**. Two honest options:
  - **(a) Zero new tables:** watermark on an `audit_log` stamp (like `_gate`), and raise the alert as
    an `ai_suggestions` row. *But* `ai_suggestions` is application-scoped, and a new-deal alert is
    **borrower-scoped** with no application, so this is an awkward fit.
  - **(b) One small ledger table** — recommended for the new-deal signal only:
    `borrower_watch_alerts (borrower_id, signal, subject_key, status open|dismissed|acted,
    first_seen_at, last_seen_at, decided_by, decided_reason)`, keyed on `(borrower_id, signal,
    subject_key)` so re-detecting the same deed never re-raises a dismissed one — mirroring
    `finding_decisions` + the digest self-gate exactly. It carries the watermark too
    (`last_swept_at` per borrower). No FK to `applications` needed; `ON DELETE CASCADE` on
    `borrower_id`. Tiny, idempotent, one numbered migration.

**Recommendation:** derive the two cheap signals; add the **one** small `borrower_watch_alerts` table
**only** for the new-deal alert's dismissal + watermark. This is the minimal honest footprint.

### 5.5 Reuse vs new (Part B)

- **Reuse:** `sitewire/monitor.js` (the advisory-monitor shape), `notification-digests.js` (self-gate + business hours + fairness ordering), `elementix/client.js` + `elementix/lookups.js` (free record tools, caps, no skip trace), `shapes.js` (deed normalization), `address.sameAddress` (by-meaning matching), the research warehouse (`properties` / trilateration — cache + geo), and `track-record-findings.js` (decided-stays-decided).
- **New:** one pure `src/lib/portfolio-watch.js` (overextension/concentration, mirroring the monitor) + the new-deal sweep, a `portfolioWatchSweepOnce()` digest hook, one small ledger table, and staff surfaces (a "Portfolio watch" strip on the scorecard + an officer weekly digest).

---

## 6. Part C — a borrower track-record summary on the TPR / tape (staff-decided)

**The idea:** a **borrower-safe** track-record summary (verified counts, tier, volume, geographic
footprint, largest deal — the scorecard, scrubbed) can ride the **TPR package / tape export** to
strengthen the loan sale: a note buyer wants evidence the borrower is experienced, and we already hold
that evidence verified.

**How, safely:**

- **Staff decides, never automatic.** A per-file opt-in ("include the borrower track-record summary in
  this TPR package"), the same way staff already choose what a package contains.
- **Reuse the existing package machinery.** Generate the summary as a document (the same server-built,
  borrower-safe pattern as the track-record HTML copy) and file it into the TPR package via
  `tpr-export` `selectTprDocuments` / `categoryFor` under a new category (e.g. "Borrower track
  record"). The SharePoint mirror inherits the category for free (shared categorizer).
- **Borrower-safe by construction.** Deal facts only — no note-buyer names, no internal notes, no
  contact data. Note-buyer names are **never** borrower-facing (`CLAUDE.md`), and this document is
  borrower-visible if it ships in a package, so it is scrubbed exactly like the existing borrower-safe
  exports.
- **Start with the TPR *document*, not a tape *field*.** Putting verified counts into a note buyer's
  **data tape** touches a buyer-scoped, gated schema (`src/lib/tapes`) and is a per-buyer change; that
  needs the buyer's schema and is a separate, owner-signed step.
- **Pricing stays frozen.** The summary is **evidence**, never a repricing input. It must never change
  a number. **Owner sign-off is required before it can affect pricing** (and the recommendation is that
  it never does — it is documentation that supports the sale, not a driver of it).

---

## 7. Effort / risk at a glance

| Piece | Effort | Risk | Why |
|---|---|---|---|
| **Scorecard** (Part A) | **Small** | **Low** | Almost entirely consolidation of existing counts; one pure module + one endpoint + a UI extension. Advisory, no pricing path. |
| **Overextension + concentration** (Part B cheap signals) | **Small** | **Low** | Pure over `track_records` + `applications`; mirrors the existing draw monitor. Zero vendor cost. |
| **New-deal sweep** (Part B) | **Medium** | **Medium** | Elementix wiring already exists; the work is the diff + cache-first watermarking + the small ledger. Risk is (a) the paid ceiling — mitigated by cache-first/bounded/free-tools-only, and (b) a false "new deal" from loose address matching — mitigated by `address.sameAddress` + the warehouse. |
| **TPR summary** (Part C) | **Small–Medium** | **Low–Medium** | Reuses the package builder + borrower-safe scrub. Risk is a pricing/borrower-safety leak — mitigated by keeping it evidence-only + staff-opt-in + owner sign-off. |

**The single biggest risk across the whole feature is a pricing leak.** It is fully mitigated by the
non-negotiable in §1: the scorecard reads the frozen tier and never emits a *new* tier/count into any
sizing formula, and everything is advisory.

---

## 8. Reusable vs new — the whole picture

**Reusable (most of the build):**
`experience.js` · `track-record-todo.js` (`borrowerTrackRecordView`) · `vendor-scorecard.js` (the
pure-math + `scorecardsFor` shape) · `sitewire/monitor.js` (advisory monitor) ·
`notification-digests.js` (self-gate + business hours + fairness) · `elementix/client.js` +
`elementix/lookups.js` (free tools, caps, no skip trace) · `elementix/shapes.js` (deed normalization) ·
`address.sameAddress` · the research warehouse (`properties`, place-subjects) ·
`ExperienceHeader.jsx` + `RecordLedger.jsx` (the one arrangement) · `track-record-findings.js`
(decided-stays-decided) · `tpr-export` (package categories).

**New (small footprint):**
`src/lib/borrower-scorecard.js` (pure) · `src/lib/portfolio-watch.js` (pure) · a `tierFor()` shared
helper *iff* a server-side tier string is needed · one `portfolioWatchSweepOnce()` digest hook · **one**
small `borrower_watch_alerts` table (new-deal dismissal + watermark) · two staff endpoints
(`/scorecard`, `/watch`) · the UI (scorecard on the Track record header + a watch strip + an officer
weekly digest).

---

## 9. Open questions for the owner

1. **Tier source.** Confirm the scorecard tier should be the **verified-count ladder** (recommended,
   read from `experience.js` via the frozen 1/3/5/10 thresholds), not a separately stored
   `borrowers.tier`. What writes `borrowers.tier` today, and should it be reconciled to this?
2. **Thresholds.** What counts as **overextension** (how many concurrent unexited projects?) and
   **concentration** (how many in one market, or what share?)? Sensible starting defaults, adjustable
   like the draw monitor's `staleDays` / `pacingGapPct`.
3. **Who is watched?** Only borrowers with an **active file**, or the **whole book** (which the profile
   sweep already imports)? This drives the paid-call budget.
4. **New-deal budget.** Confirm the sweep uses **free deed tools only** (no skip trace, no paid
   enrichment — recommended), and set the daily borrower cap + the refresh TTL (e.g. 30/60/90 days).
5. **Delivery.** In-app only for individual signals, plus a **weekly officer email digest** — or should
   any signal email immediately? (Recommendation: weekly digest + in-app, to avoid bombardment.)
6. **Dismissal ledger.** OK to add the one small `borrower_watch_alerts` table for dismissible new-deal
   alerts (recommended), or keep everything derived and let alerts re-appear until acted on?
7. **TPR summary (Part C).** Should a borrower-safe track-record summary be an **opt-in TPR document**?
   Confirm it is **evidence-only, never a pricing input**, and that any pricing effect or any **tape
   field** requires separate written owner sign-off.
8. **Product scope.** Confirm **RTL only** (everything sits on RTL tables; nothing Long-Term).

---

## Sources

- [Forecasa — Solutions for Lenders](https://www.forecasa.com/solutions/lenders)
- [Forecasa — Capabilities](https://www.forecasa.com/capabilities)
- [Forecasa — Company](https://www.forecasa.com/company)
- [Forecasa™: A Closer Look at the Platform Reshaping Market Intelligence in Private Lending (The Elite Officer)](https://theeliteofficer.com/forecasa-a-closer-look-at-the-platform-thats-reshaping-market-intelligence-in-private-lending/)
- [RBI ranked 10th in Lender Loyalty by Forecasa (PR Newswire)](http://www.prnewswire.com/news-releases/rbi-ranked-3rd-top-construction-lender-for-2025-by-scotsman-guide-magazine-and-10th-in-lender-loyalty-by-forecasa-302533585.html)
- [Built — A Deep Dive into Built's Four Core Risk Dashboards](https://getbuilt.com/blog/construction-loan-risk-dashboards/)
- [Built — Real-Time Risk Management for Construction Loan Portfolios](https://getbuilt.com/blog/real-time-risk-management-construction-loans/)
- [Baseline — Purpose-Built Software for Real Estate Private Lenders](https://www.baselinesoftware.com/)
- [Baseline — What Is Private Lending?](https://www.baselinesoftware.com/resources/articles/what_is_private_lending)
- [LendingWise — CRM, LOS & Servicing for Private Lenders](https://www.lendingwise.com/)
