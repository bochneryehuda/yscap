# Daily rate-movement reports for loan officers

**STATUS: RESEARCH. NOT BUILT.** Companion to `BORROWER-PRICING-MASTER-PLAN.md`.
Staff-facing only. It touches no borrower surface, which is why it can go live ahead of everything
else in that plan (master plan §9, Phase 2).

---

## 0. What was asked for

> *"Loan officers, they can set up for themselves reports that are being sent to themselves … on a
> certain program they can get an update every day, and it should be set up which time they want.
> The system should run for themselves the same exact scenario. It should give them an overall
> 'this and this program went up this and this amount of price' — **it should calculate by price,
> not by rate**, so let's say it went up by half a point, it went up by 0.125. And they can also run
> it by all programs … they can get an update on every single program, how much more expensive every
> single program is … include an average of the program, and automatic reporting for themselves —
> average how many rates went up total between all of our programs, averaged up, average down …
> All the reports should be off by default … let's set up a company default that every loan officer
> should get, by 1:30 PM Eastern Standard, every single day, an email — all of our investors and all
> of our programs, compared today to yesterday … not Saturday and not Sunday."*
> — the owner, 2026-08-30

---

## 1. "By price, not by rate" — and the sign trap in it

The owner is right, and the reason is worth stating because it is what makes the whole feature
worth building: **a program can move a full point without its rates changing at all.** Rate sheets
re-price the ladder far more often than they add or remove rungs. An officer watching rates sees
nothing; the borrower's cash to close moved $3,750 on a $375,000 loan.

### The sign convention, and why the email never prints the sign

This codebase's convention (`ppe/README.md`, and the whole pricing engine) is:

```
points = 100 − price          positive points = the borrower pays
```

So **a program getting more expensive means its PRICE went DOWN.** "It went up by half a point" —
the owner's phrasing — means the *cost* went up, i.e. price −0.500.

That is a genuine ambiguity and it will be got wrong by somebody reading a table at 1:30 PM. So:

- **Internally**, every stored and computed figure is a **price delta in milli-points**, signed the
  engine's way. One convention, and the same one the rest of the engine uses.
- **In the email**, no signed price is ever printed on its own. Every movement is written as
  **"0.500 more expensive"** or **"0.250 cheaper"**, with the dollar impact on a reference loan
  beside it. The word carries the direction; the number carries the size.

`scripts/test-lt-price-movement-pure.mjs` must fail if a raw signed price delta reaches the rendered
email.

---

## 2. The two metrics, because one is not enough

| Metric | What it is | What it answers |
|---|---|---|
| **Anchor-rate move** | Δ price at one fixed rate | *"What does this do to the deal I quoted yesterday?"* |
| **Sheet move** | The mean Δ price across every rung present on both days | *"Did this program's whole sheet move, or just one corner of it?"* |

The **anchor rate** is chosen from the EARLIER day and held: the rate whose price sits closest to
par (100.000) yesterday. It is chosen from yesterday and not today so that it cannot drift with the
thing it is measuring, and it is par-adjacent because that is where a real quote sits.

**The headline number in the email is the anchor-rate move.** The sheet move sits beside it, and
when they disagree by more than a configurable threshold the row says so — *"the whole sheet moved
0.125; at 7.375% it moved 0.500"* — because that shape (one part of the ladder re-priced) is
exactly what an officer wants to know and is invisible in an average.

A third figure, offered because half the desk thinks in it: **par-rate move**, the interpolated rate
at which the program prices at exactly 100.000, yesterday versus today, in basis points.
`ppe/pricing.js` already has `interpolatePrice`; the inverse over a monotonic ladder is the same
arithmetic and belongs in the same module.

---

## 3. The benchmark scenario — the thing that makes any of this comparable

**Nothing here is measurable unless the scenario is held constant.** A price is a price *for a
scenario*; comparing today's 75% LTV / 760 FICO quote to yesterday's 80% / 720 quote measures our
own inconsistency.

> *"The system runs a report based on the details that we have already in our system, which is
> always the default that populates."*

So the benchmark is the pricer's own default scenario, declared as a setting, pre-filled with the
profile the DSCR pricer already defaults to:

`pricing.benchmarkScenario` (map) — purchase, single family, $500,000 value, $375,000 loan (75%
LTV), FICO 760, DSCR 1.25, 30-year fixed, 5-year Standard prepay, escrows waived, a named
representative ZIP. Every one of those is already a default the pricer applies
(`search-model.js` §35.3/§36.6); this setting simply writes them down in one place so a report can
say what it measured.

**Three properties this needs:**

1. **The benchmark is stamped on every report.** The email footer names it in one line. A movement
   figure with no scenario attached is a number nobody can check.
2. **Changing the benchmark starts a new series.** The snapshot row is keyed on a hash of the
   canonical scenario, so an edited benchmark does not silently compare apples to oranges — the
   first report after a change says *"benchmark changed; no prior day to compare."* This is the same
   version-stamped-rebaseline discipline `ppe/ratesheet-diff.js` already uses.
3. **An officer may define their own** benchmark on a subscription (a different state, a different
   LTV band). Each distinct scenario is one more daily vendor call, so they are deduplicated by hash
   across every subscriber — see §4.

---

## 4. The snapshot — one vendor call buys the whole book

**The measured fact that makes this cheap:** one Lender Price search returns every investor and every
program at once. The live capture of 2026-08-23 recorded **17 lenders / 32 programs / 1,055 priced
rungs from a single call**, in 12.1 seconds. So a daily snapshot of "all our investors and all our
programs" is **one call per benchmark scenario per day** — not one per program, and not one per
officer.

### `lt_price_snapshot`

```
id             uuid PK
scenario_hash  text NOT NULL       -- canonical hash of the benchmark; the series key
scenario       jsonb NOT NULL      -- the benchmark itself, stored so the row is self-describing
taken_at       timestamptz NOT NULL
taken_for_day  date NOT NULL       -- the New York calendar day this snapshot represents
investor_key   text NOT NULL       -- canonical key (encompass/investors.js)
program        text NOT NULL       -- the vendor's own program name
rate_sheet     text NULL           -- §38: one program can quote from two sheets
ladder         jsonb NOT NULL      -- [{ rateMilli, bestPriceMilli }] — sorted, integers
par_rate_milli integer NULL        -- interpolated rate at price 100.000, or null
UNIQUE (scenario_hash, taken_for_day, investor_key, program, rate_sheet)
```

**Milli-integers, never floats** — the engine's units convention, non-negotiable
(`ppe/README.md`: *"Never introduce a float price/rate on a stored or compared value"*). A
half-cent of float drift across a 365-day series is a movement report that reports movement that
did not happen.

**One row per investor × program × sheet**, because two channels of one lender can share a program
name with different ladders — measured on ResiCentral, and already why `rateSheetName` rides the
staff board.

### When it is taken, and why the time matters more than the day

> *"By one o'clock PM you suggest them to go more in the middle of the day, when more programs came
> out already."*

Rate sheets arrive through the morning and re-price intraday. **A snapshot at 1:00 PM compared to
yesterday's 9:00 AM snapshot measures the time of day, not the market.** So:

- The snapshot job runs at **1:00 PM America/New_York**, weekdays (`pricing.snapshotHour`).
- The report runs at **1:30 PM**, comparing today's 1:00 PM snapshot to the previous business day's
  1:00 PM snapshot.
- The 30-minute gap is deliberate slack: a 12-second call has plenty of room, and a vendor slowdown
  must not make the report late or, worse, compare against a snapshot that was never taken.

**The snapshot ships before the reports and starts collecting immediately** — a report has nothing
to say on its first day by construction, and building it the other way round produces a first email
that says nothing and looks broken.

---

## 5. Subscriptions — off by default, per person

### `lt_pricing_report_subscription`

Following `lt_pricer_investor_groups` (db/634): a named per-user arrangement is a row, never a code
change.

```
id             uuid PK
staff_id       uuid NOT NULL REFERENCES staff_users(id)   -- authorized sql-ref
name           text NOT NULL                 -- 'My Diamond watch'
enabled        boolean NOT NULL DEFAULT true -- the SUBSCRIPTION exists only because they made it
scope          text NOT NULL                 -- 'all' | 'investor' | 'program'
investor_keys  text[] NOT NULL DEFAULT '{}'  -- when scope='investor'
programs       jsonb NOT NULL DEFAULT '[]'   -- [{investorKey, program}] when scope='program'
scenario_hash  text NOT NULL                 -- which benchmark series
send_hour      integer NOT NULL              -- 0–23, America/New_York
days           text[] NOT NULL DEFAULT '{mon,tue,wed,thu,fri}'
include_average boolean NOT NULL DEFAULT true
last_sent_at   timestamptz NULL              -- the send-once-per-period CLAIM (§7)
created_at, updated_at
```

**"All reports should be off by default"** is satisfied structurally: there is no row until an
officer creates one. There is no `borrowerPricing`-style global switch to forget, and no seeded rows
to un-seed. The one exception is the company default, which is not a subscription at all (§6).

The four scopes the owner named map exactly onto `scope`:
*"for this program, for all programs, for all programs on this investor, or for a specific
program."*

---

## 6. The company default report

> *"Let's set up a company default that every loan officer should get by 1:30 PM Eastern Standard on
> every single day … all of our investors and all of our programs, compared today to yesterday …
> not Saturday and not Sunday."*

This is **not** a seeded subscription row per officer. Rows would drift: a new officer would not get
one, a deleted row would silently opt somebody out, and "the company default" would become 40 rows
nobody could reason about.

It is **a setting**, evaluated at send time against the live staff roster:

| Setting | Default |
|---|---|
| `pricing.dailyReportEnabled` | **true** |
| `pricing.dailyReportHour` | `13` (1:00 PM… see below) |
| `pricing.dailyReportMinute` | `30` |
| `pricing.dailyReportTimezone` | `America/New_York` |
| `pricing.dailyReportDays` | `['mon','tue','wed','thu','fri']` |
| `pricing.dailyReportRoles` | `['loan_officer']` |
| `pricing.dailyReportOptOutAllowed` | `true` |

Two notes on that table:

- **"Eastern Standard" is read as America/New_York**, which is EDT for two-thirds of the year. An
  officer asked for 1:30 in the afternoon, not for a UTC offset. Computing in the zone means the
  email lands at 1:30 local in June and in December alike. Storing `-05:00` would put it at 12:30 in
  summer, every year, and somebody would file it as a bug in April.
- **An officer may opt out**, and opting out writes a personal setting rather than deleting
  anything. The owner asked that everyone *get* it; nobody is served by an officer who has muted it
  in their mail client instead, because then we cannot tell reach from silence.

**Holidays are an open question (OQ-14).** Weekends are excluded as asked. But on a bond-market
holiday the sheets do not move, and a report saying "nothing changed" on Thanksgiving is noise that
teaches people to ignore the email. Recommend: skip the report when today's snapshot is byte-
identical to the prior day's across every program — which handles holidays, vendor outages and quiet
days with one rule and no calendar to maintain.

---

## 7. Delivery, and the one real crossing question

**Long-Term has no mailer.** `src/lib/email/**` is RTL's — a Microsoft Graph sender, a Resend
fallback, a template layer, a rate limiter, a no-reply guard, an email log. LT imports none of it,
and `check-product-separation.js` will fail the build the moment it does.

This is the first LT feature that sends email, and there are three ways forward. **The owner must
pick one** (OQ-15); nothing here assumes an answer.

| | Option | Cost | Verdict |
|---|---|---|---|
| **A** | Ask for `import src/lib/email/index.js` in the ledger | One authorization; LT then shares the company's sending identity, its rate limiter and its suppression list | **Recommended.** Deliverability, DMARC alignment and suppression are properties of the *company's domain*, not of a product. Two senders on one domain is how a domain gets its reputation damaged, and the existing stack already carries the no-reply and reply-cut rules |
| **B** | A brand-new LT mailer under `src/longterm/email/**` | A second provider integration, a second template layer, a second suppression list, a second set of credentials | Purest separation, and genuinely the wrong trade here |
| **C** | No email — an in-app digest only | No crossing, no authorization | Fails the ask outright. The owner asked for an email |

The precedent for A is the ClickUp connector (2026-08-23), where the owner authorized crossing
exactly because the *workspace* was the company's and not RTL's. **The company's sending domain is
the same kind of fact.** If A is granted, it is one `import` line, LT builds its own templates, and
`src/lib/email/index.js` is used only as the transport.

---

## 8. The scheduler

Two jobs, one tick, both inside LT's existing self-scheduling seam (`src/longterm/index.js` already
schedules its own background pass and documents why — *"having it schedule its own background work
keeps the whole of Long-Term behind that one door"*).

```
every minute
  ├─ snapshotTick()   – is a benchmark due (1:00 PM NY, weekday, not yet taken today)?
  └─ reportTick()     – is any subscription or the company default due this minute?
```

Four properties, each of which is a way this fails if it is skipped:

1. **A Postgres advisory lock per job per day.** Render runs more than one web instance. Without
   it, N instances take N snapshots and send N copies of every email. The PPE canary worker's
   pending note names exactly this — *"so N Render instances fire one battery, not N"* — and this
   job must not repeat that mistake by omission.
2. **A claim, not a check.** `last_sent_at` is claimed with a guarded UPDATE
   (`last_sent_at IS NULL OR last_sent_at < <period start>`) before the send, and **restored on
   failure** so the next sweep retries. This is the pattern db/641 already established on the RTL
   side, and it is the only shape that is safe against two instances *and* against a provider error.
3. **Due-ness is computed in the zone, from a real clock, injected.** So DST is right and the
   decision is testable without waiting until Tuesday.
4. **It is OFF unless switched on** (`LT_PRICING_REPORTS_ENABLED`), and says so in the log either
   way — the same OFF grammar every other LT background switch uses.

---

## 9. What the email looks like

Professional, dense, scannable in ten seconds on a phone. No chart images (they break in Outlook and
they do not survive forwarding), no colour as the only signal, and the headline in the subject line
so it is readable without opening.

**Subject:** `DSCR pricing · 30 Aug · 9 programs more expensive, 14 cheaper, 9 unchanged`

```
─────────────────────────────────────────────────────────────
DSCR PRICING — Friday 30 August, 1:30 PM ET
Compared with Thursday 29 August, 1:00 PM ET
─────────────────────────────────────────────────────────────

THE DAY, ACROSS 32 PROGRAMS

  Average move            0.070 more expensive
  More expensive          9 programs   (worst: Amber, 0.500)
  Cheaper                14 programs   (best:  Pearl, 0.375)
  Unchanged               9 programs
  No quote today          0 programs

  On a $375,000 loan, the average move is $263.

─────────────────────────────────────────────────────────────
BY PROGRAM                      at 7.375%        whole sheet
─────────────────────────────────────────────────────────────
  Amber — 30yr Fixed          0.500 dearer      0.500 dearer
  Granite — 30yr Fixed        0.250 dearer      0.125 dearer   ⚑
  Diamond — 30yr Fixed        0.125 dearer      0.125 dearer
  Diamond — 30yr I/O          unchanged         unchanged
  …
  Pearl — DSCR Plus           0.375 cheaper     0.375 cheaper
  Sequoia — 40yr I/O          — no quote today (quoted yesterday)

  ⚑ the sheet moved differently at the anchor rate than overall

─────────────────────────────────────────────────────────────
Benchmark: purchase · single family · $500,000 value ·
$375,000 loan (75% LTV) · FICO 760 · DSCR 1.25 · 30yr fixed ·
5-year prepayment · escrows waived · NJ 07036
Anchor rate 7.375% (closest to par on 29 August).

Prices are indicative and for internal comparison only.
Manage these reports: <link>
─────────────────────────────────────────────────────────────
```

Rules that make it trustworthy rather than merely pretty:

- **Every movement is a word plus a number.** Never a bare `−0.500`.
- **A dollar figure on the summary**, on the benchmark loan. Points are the unit; dollars are what an
  officer repeats to a borrower.
- **"No quote today" is a row, not an omission.** A program that stopped quoting is the single most
  actionable line in the email, and averaging over it silently would hide it. It is excluded from
  the average and counted separately.
- **A program that appeared today** is listed as new, with no movement figure — never as
  "unchanged", and never compared against a zero.
- **The benchmark and the anchor are printed.** A number nobody can reproduce is a number nobody
  should act on.
- **White-label names throughout.** This is a staff email and staff may see real investor names —
  but the white-label name is what appears on every borrower artifact, so using it here is what
  makes the two boards speak one language. The real name is one click away in the app.

---

## 10. The failure modes, and what each one does

| What happens | What the report does |
|---|---|
| The vendor is down at 1:00 PM | The snapshot is not taken. The 1:30 report says *"today's snapshot could not be taken"* and sends nothing else. It never compares against a two-day-old snapshot without saying so |
| Yesterday has no snapshot | *"No prior business day to compare."* Never a movement of zero |
| The benchmark scenario changed | The series rebaselines and the first report says so (§3) |
| A program appears | Listed as new, no movement figure |
| A program disappears | Listed as "no quote today", excluded from the average, counted |
| A program's ladder has no rung at the anchor rate | The anchor-rate cell reads *"not quoted at 7.375%"*; the sheet-move cell still computes over common rungs |
| Zero programs moved | Recommend: send nothing (§6, the holiday rule) — OQ-14 |
| An officer's subscription names a program that no longer exists | The row says so and the subscription is not silently emptied |

Every one of these is the same principle the PPE parity work already settled: *"a side that produced
no result is `incomparable` — never scored as agreement, and kept out of the denominator."* The
average in this email must be computed over programs that were quoted on **both** days, and the
count of those excluded must be visible.

---

## 11. What must be proven

| Suite | Proves | Must go red when |
|---|---|---|
| `test-lt-price-movement-pure.mjs` | Δ arithmetic in milli; anchor selection from the EARLIER day; the "more expensive / cheaper" wording | A raw signed delta reaches the rendered text |
| `test-lt-price-average-pure.mjs` | Programs quoted on only one day are excluded from the average and counted | An absent program is averaged as zero |
| `test-lt-report-schedule-pure.mjs` | Due-ness in America/New_York across a DST boundary, weekends excluded, injected clock | A fixed UTC offset is used |
| `test-lt-report-claim-db.js` | Two concurrent ticks send once; a failed send restores the claim | The claim is a check-then-set |
| `test-lt-price-snapshot-db.js` | One row per investor×program×sheet; the unique key; milli integers | A float price is stored |
| `test-lt-report-render-pure.mjs` | The §9 layout, verbatim, including "no quote today" | A missing program is omitted from the email |

---

## 12. Open questions

| # | Question | Recommendation |
|---|---|---|
| OQ-14 | Holidays and no-movement days — send, or stay quiet? | **Stay quiet when nothing moved.** One rule covers holidays, outages and quiet days, with no calendar to maintain |
| OQ-15 | The email crossing (§7) — A, B or C? | **A** — one ledger line for `src/lib/email/index.js` as transport only. The sending domain is the company's, not RTL's |
| OQ-16 | May an officer set a benchmark of their own, or only the company's? | **Their own**, deduplicated by scenario hash. It is the difference between a report they read and a report they filter |
| OQ-17 | Should the report cover LTV bands (say 65 / 75 / 80) rather than one benchmark? | **Not in v1.** One benchmark, understood, beats three nobody checks. Revisit once officers say which band they actually quote |
| OQ-18 | How long are snapshots kept? | **Forever, at first** — a ladder is a few kB and a year of history is what makes "how did this program trend" answerable later |
