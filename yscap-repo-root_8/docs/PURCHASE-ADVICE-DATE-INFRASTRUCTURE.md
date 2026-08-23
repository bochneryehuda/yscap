# The purchase advice date — every place it lives, every door it comes through, and where they disagree

**Research only. Nothing in this document has been built.** It is the map the owner asked for on
2026-08-23: *"I think my system has too many places where the purchase advice is being issued
post-purchase, post-closing. Do a lot of research on the entire purchase advice date
infrastructure. We need to line them all up together."*

Every claim below was read out of the code on this branch and is cited to `file:line`. Where a
statement is about something NOT happening, the negative was measured (the grep that returns
nothing is named).

**Product scope: RTL only.** `applications`, `purchasing_advice`, `purchasing_workflow` and
`sitewire_property_links` are RTL tables. The long-term side carries the same field only as a
dictionary entry (`src/longterm/encompass/reconciliation-map.js:614`) and shares no code path.

---

## 1. The short answer

There are **two places a purchase advice date is recorded**, **five places a date-like fact about
the sale is stored**, and **three doors through which the Encompass date can arrive** — and the
three doors do not behave the same way.

The date itself is not really duplicated; it is well factored. What is NOT lined up is
**everything that happens when it lands**: the sold stage, the ClickUp card, the two
notifications, the read-state stamp and the back-book protection each key on a different one of
the doors. The result is that a file can be "sold" on one screen and "not sold" on the next, and
which one you get depends on which door read the field last.

---

## 2. What is stored

| # | Column / table | What it means | Who writes it | Who reads it |
|---|---|---|---|---|
| 1 | `applications.purchase_advice_date` (db/506:121) | Encompass field **2370**, mirrored read-only into our column. The sale as Encompass records it. | **Exactly one writer**: `release-party.syncPurchaseAdviceDate` (`src/sitewire/release-party.js:567`) | draw desk, sold stage, chase, critical dates, purchase-complete gate, poll priority lane |
| 2 | `purchasing_advice.advice_date` (db/351:22) | The advice as **our purchasing desk** recorded it, usually the day it arrives and usually *earlier* than Encompass. | `purchasing.setPurchaseAdvice` (`src/lib/purchasing.js:424`) via `POST /api/staff/applications/:id/purchasing/advice` (`src/routes/staff.js:16684`) | draw desk, chase, critical dates, purchase-complete gate |
| 3 | `applications.sold_at` + `sold_source` (db/611:71) | The **Sold stage** and where it came from (`encompass_pa` / `desk` / `manual`). | `sold-status.syncSoldStage` (`src/lib/sold-status.js:130`) — the only writer (`grep "SET sold_at"` returns one file) | critical dates; one label on one screen (§6) |
| 4 | `sitewire_property_links.treat_as_sold_at` (db/543) | Not a purchase advice — a **coordinator's decision** to process a file as sold anyway, with who and when. | `release-party.setTreatAsSold` (`src/sitewire/release-party.js:712`) | draw desk only; never the sold FACT |
| 5 | `applications.purchase_advice_notified_at` (db/546:46) | The once-only stamp that stops the post-purchase e-mail firing twice. | `post-purchase.announceSold` (`src/lib/post-purchase.js:163`) | itself |
| 6 | `applications.purchase_advice_read_at` / `_read_state` / `_field_id` (db/608:55) | **What the last read of field 2370 actually did** — `value` / `blank` / `not_returned` / `no_field_id` / `no_loan_link`. This is what stops a false chase. | `release-party.stampPaRead` (`src/sitewire/release-party.js:513`) | the chase, the unreadable digest, the Encompass panel, critical dates |
| 7 | `applications.internal_status = 'pa issued-post closing.'` | The ClickUp card's post-closing rung (orderindex 34). | `clickup/post-closing-stage.advanceCard` (`src/clickup/post-closing-stage.js:164`) | ClickUp, the pipeline mirror |
| 8 | `purchasing_advice.document_id` (+ `document_prior_visibility`, db/361) | The **advice document** itself, forced staff-only. | `purchasing.setPurchaseAdvice` | purchasing screen, `sitewire/doc-push.js:141` (never pushed to a borrower) |
| 9 | **`purchasing_workflow.purchase_advice_date` / `_document_id` / `_updated_at` / `_updated_by`** (db/350:20-23) | **DEAD.** db/351 moved the fact off this row because `withdrawFromPurchasing` DELETEs it. The columns were deliberately left in place and *nothing reads them*. | nothing | **nothing** — `grep -rn "purchase_advice_document_id\|pw.purchase_advice" src/ app-v2/src` returns zero rows |

Item 9 is the only literal duplicate storage of the date in the schema, and it is inert. It is
worth a note in the schema map so nobody "finishes the job" by wiring it back up.

---

## 3. The three doors the Encompass date comes through

All three land in the same function — `syncPurchaseAdviceDate`
(`src/sitewire/release-party.js:542`) — which is the right shape. **They do not call it the same
way, and that is where the misalignment starts.**

| Door | Caller | What it reads | `silentDiscovery` | `fieldId` (catalogue fallback) |
|---|---|---|---|---|
| **A — per-file pull** | `src/encompass/reader.js:387`, from the 15-min round-robin (`src/sync/encompass-sync.js:80`) **and** every "Refresh from Encompass" button, **and** `POST /api/sitewire/files/:id/refresh-pa-date` (`src/routes/sitewire.js:3582`) | the whole loan, PA id inside the registry batch | **not passed → false** | **not passed → configured id only** |
| **B — draw-desk auto-refresh** | `release-party.refreshSoldSignal` (`:662`), fired on every draw-desk read of a not-sold file (`src/routes/sitewire.js:2767`) | field 2370 alone, by number | **not passed → false** | **not passed → configured id only** |
| **C — the book sweep** | `release-party.sweepPurchaseAdviceOnce` (`:768`), every 10 min / 25 files (`src/sync/encompass-sync.js:175`), plus `POST /api/admin/encompass/purchase-advice/sweep` | field 2370 alone, by number, **plus the tenant's own purchase-advice-named fields** (`src/sitewire/pa-field.js`) | **`!!r.first_read`** | **the id that actually answered** |

### 3.1 The back-book blast guard is on ONE door of three

The sweep's whole `silentDiscovery` design (`:608-618`) exists so the first read of a back-book
file lands the date **without** e-mailing anybody or dragging a ClickUp card. Doors A and B pass
nothing, so `silentDiscovery` defaults to `false` — and door A has a **priority lane that
deliberately puts exactly those files first**:

```sql
-- src/sync/encompass-sync.js:92-98
ORDER BY (a.status = 'funded'
          AND a.purchase_advice_date IS NULL
          AND EXISTS (… active draw project …)) DESC,
         a.encompass_last_pulled_at NULLS FIRST
```

A funded, never-read, draw-active file is therefore *raced* between door A (announces) and door C
(silent). Whichever wins decides whether the purchasing desk gets an e-mail about a sale from
March. **The guard should live inside `syncPurchaseAdviceDate` — keyed on
`purchase_advice_read_at IS NULL` — not in one caller's argument list.**

### 3.2 The read-state and the field id ping-pong

`stampPaRead` writes `purchase_advice_field_id` on every read. Doors A and B always write the
**configured** id; door C writes **the id that answered**, which may be a catalogue fallback
(`src/sitewire/pa-field.js:139`).

So on a tenant whose purchase advice really lives under a non-configured id:

* door C reads it, stamps `value` + the fallback id, lands the date;
* door B (any draw-desk view of that same file) then reads the configured id, gets nothing back,
  and stamps `not_returned` **over** the good verdict — while leaving the date itself in place,
  because a missing key writes nothing (`:558`).

The file then reads "PILOT asked, and Encompass answered without that field … this file cannot be
judged either way" on the Encompass panel (`src/routes/staff.js:14062`) about a loan whose date is
sitting in the column two lines above. The candidate list is resolved once per sweep pass
(`:794`); doors A and B should take the same list.

---

## 4. What fires when a date lands — and why it fires twice

Inside `syncPurchaseAdviceDate`, on a changed non-null date with `silentDiscovery` false
(`:588-621`):

```
1. post-purchase.announceSold(appId, paDate)        → e-mail #1, to post_purchase_notify
2. post-closing-stage.advanceCard(appId,'sold')     → ClickUp push #1
3. sold-status.syncSoldStage(db, appId, {announce}) →
      3a. UPDATE applications SET sold_at, sold_source
      3b. post-closing-stage.advanceCard(appId,'sold')   ← ClickUp push #2
      3c. notify.notifyAppStaff('This loan is now marked Sold')  ← e-mail #2
```

* **Two ClickUp pushes for one event.** The second is a no-op (`decideStage` answers
  `already_there`, `src/clickup/post-closing-stage.js:138`), but there are now **two definitions
  of when the card moves** — `changed && paDate && !silentDiscovery` in one place and
  `plan.mark && announce` in the other. They already differ: on a **cleared** date step 2 does
  nothing while step 3 clears `sold_at` and, on a re-mark, would push. Line these up: the card
  should follow the **stage**, once, and `syncPurchaseAdviceDate` should not push it at all.
* **Two notifications for one event**, to overlapping audiences, with different wording — "This
  loan has been sold — finish the purchase in PILOT" (post-purchase list) and "This loan is now
  marked Sold" (everybody assigned to the file). Whether that is one message too many is the
  owner's call, but today nothing decides it: it is an accident of two features landing a week
  apart.

---

## 5. The purchasing-desk date is a second-class citizen

This is the largest single gap, and it is the one that produces "sold here, not sold there".

`POST /api/staff/applications/:id/purchasing/advice` (`src/routes/staff.js:16684`) writes
`purchasing_advice.advice_date` and **stops**. It does not call `syncSoldStage`, `advanceCard`, or
any notifier. Measured: `grep -rn "syncSoldStage" src/` returns exactly two callers —
`release-party.syncPurchaseAdviceDate:619-620` and `sold-status.backfillSoldOnce:187`.

For a file whose only advice is the desk's own record:

| Surface | Answer | Correct? |
|---|---|---|
| Draw desk "who releases the money" | **Sold** — `soldVia = our_purchase_advice` (`release-party.js:156`) | ✅ |
| 30-day chase | quiet — the SQL joins `purchasing_advice` and requires `pa.advice_date IS NULL` (`notification-digests.js:1450`) | ✅ |
| Critical dates → *Purchase advice* row | the date, sourced "the purchasing desk's own record" (`critical-dates.js:129`) | ✅ |
| Critical dates → *Sold* row | **"This loan has not been marked sold."** | ❌ |
| `applications.sold_at` / the Sold stage | never stamped | ❌ |
| ClickUp card | never reaches `pa issued-post closing.` | ❌ |
| `sold_source = 'desk'` | **unreachable in practice** (below) | ❌ |

### 5.1 `sold_source = 'desk'` is effectively dead code

`decideSold` maps `via === 'our_purchase_advice'` to `SOURCE.DESK`
(`src/lib/sold-status.js:88`). Trace every way that branch can be reached:

* from `backfillSoldOnce` — its query filters `purchase_advice_date IS NOT NULL`
  (`:181`), so `releaseStateFor` always answers `via='purchase_advice'` → `encompass_pa`;
* from `syncPurchaseAdviceDate` — only runs when the **Encompass** column changed. If it changed
  to a value, `via='purchase_advice'`. The only way to get `our_purchase_advice` is for Encompass
  to **clear** a date it previously held while the desk holds one.

So the `desk` source is reachable only in the "Encompass un-sold it and our desk did not" corner.
`scripts/test-sold-and-payoff-db.js:73-74` asserts the branch works **as a pure function** and never
drives it through the desk route — which is exactly the shape this codebase warns about (a test
reading its own mirror of the rule).

### 5.2 The back-book backfill has the same blind spot

`backfillSoldOnce` (`src/lib/sold-status.js:174`, run once at boot from `src/server.js:894`)
selects on `purchase_advice_date IS NOT NULL`. Every historic file sold on the desk record alone
is invisible to it, permanently — the pass is self-draining, so it will never come back for them.

---

## 6. The "Sold" status is stamped but almost never shown

The owner's ask was *"the files that are being sold should have a status of 'Sold'."* The stage is
recorded correctly. It is rendered in **exactly one place in the entire front end**:

```jsx
// app-v2/src/screens/StaffApplication.jsx:998-999, rendered at :4519
const soldStage = (a) => !!(a && a.sold_at && a.status === 'funded');
const appStatusLabel = (a) => (soldStage(a) ? 'Sold' : APP_STATUS_LABEL[a && a.status] …);
…
<span className="muted small">Borrower sees: <b>{appStatusLabel(app)}</b></span>
```

Measured: `grep -rn "appStatusLabel\|soldStage" app-v2/src` returns those three lines and nothing
else. So:

* **The pipeline, the queue, the dashboards and the borrower-facing status never say "Sold."**
* Worse, the one place it does appear is labelled **"Borrower sees:"** — and that is wrong.
  `clickup/post-closing-stage.js:52-55` and `clickup/status.js:67` both hold the frozen rule that
  every post-closing stage derives to the borrower-facing word `funded`, precisely so an automatic
  push cannot move what a borrower sees. The label on this screen contradicts the rule the server
  enforces. The stage is internal; the strip should say so.

---

## 7. Where the two dates are deliberately allowed to differ (this part is right)

`post-purchase.adviceGate` (`src/lib/post-purchase.js:66`) is the one place that demands both
dates and demands they match, and it is correctly scoped: it gates **only** "mark purchase
complete" (`src/routes/staff.js:16555`), never the draw side, with a super-admin override that is
audited (`:16562`). Both dates are parsed through the single parser `RP.paDateOf`, so an ISO
timestamp, an ISO date and `m/d/yyyy` all compare as calendar days. Nothing to line up here —
this is the model the rest should follow.

Similarly `funding-channel.soldAtTable` (`src/lib/funding-channel.js:215`) is the one definition
of "no advice is coming", asked first by `soldStatus`, by `decideSold` and by the chase. One rule,
three readers, no copies.

---

## 8. Defects found while mapping (each independently confirmed)

**P1 — the once-only announce stamp is burned when there is nobody to tell.**
`announceSold` claims `purchase_advice_notified_at` at `src/lib/post-purchase.js:163`, *then*
loads `recipients()` at `:181`. On a deployment where `post_purchase_notify` is empty — the
default state of the table (db/546) — the stamp is written, the loop sends nothing, and the
function returns `{announced:true, to:[]}`. The file can never announce again, even after the
admin fills the list in. **Fix shape:** load recipients first; if the list is empty, do not claim.

**P2 — `refreshSoldSignal` silently skips every file without a draw project.**
The throttle column `sold_check_at` lives on `sitewire_property_links`, so the read at `:677`
returns nothing and the function answers `no_draw_project` (`:680`). Funded files with no draw
project are therefore refreshed only by the 10-minute sweep. Documented in the header, but it
means "the file being looked at refreshes itself" is true only on the draw desk.

**P3 — two "refresh the PA date now" implementations.**
`POST /api/sitewire/files/:id/refresh-pa-date` pulls the **whole loan**
(`src/routes/sitewire.js:3587`) while `refreshSoldSignal` reads **one field**. Same button
semantics to a coordinator, an order of magnitude apart in cost, and only one of them is
throttled.

**P4 — `not_returned` overwrites `value` (§3.2).**

**P5 — doors A and B announce the back book (§3.1).**

---

## 9. What "lining them up" would actually mean

Stated as a design, not built. Each item is one seam, and each removes a way two surfaces can
disagree.

1. **One landing function, one set of consequences.** Move the `silentDiscovery` decision *inside*
   `syncPurchaseAdviceDate`, keyed on `purchase_advice_read_at IS NULL` rather than on a caller's
   argument. Every door then gets the back-book protection for free, and the sweep stops being the
   only careful one.
2. **One purchase-advice landing point for BOTH sources.** Give the purchasing-desk route the same
   tail the Encompass path has: after `setPurchaseAdvice` writes a date, call `syncSoldStage`. That
   single line makes `sold_source='desk'` real, puts the Sold stage on desk-sourced sales, and
   moves the ClickUp card — and it is the same rule, not a second copy, because `syncSoldStage`
   already asks `releaseStateFor` which source answered.
3. **The card follows the stage, once.** Delete the `advanceCard` call in
   `syncPurchaseAdviceDate:607`; leave the one in `syncSoldStage:141`. One definition of when a
   card moves to `pa issued-post closing.`
4. **Decide the notification story deliberately.** Either the post-purchase e-mail is the only one
   (and `syncSoldStage`'s `notifyAppStaff` drops for the PA-driven case), or they are merged into
   one message with both audiences. Today it is two by accident.
5. **Backfill on either source.** Widen `backfillSoldOnce`'s query to
   `purchase_advice_date IS NOT NULL OR EXISTS (purchasing_advice … advice_date IS NOT NULL)` so
   the historic desk-sourced sales get their stage. Still silent, still self-draining.
6. **Show the stage where a status is shown**, and stop calling it "Borrower sees". The borrower
   keeps seeing *Funded* — that is the frozen rule; the internal pipeline should read *Sold*.
7. **One candidate-id list for all three doors** (§3.2), and never stamp `not_returned` over a
   `value` for the same file without re-reading the id that answered.
8. **Retire the db/350 columns** in the schema map with a comment, so the dead fourth copy of the
   date cannot be revived by accident.

Items 1-3 and 5 are the ones that produce the owner's symptom directly. Item 6 is the one that
makes the work visible.

---

## 10. Existing test coverage (what would need to keep passing)

| Script | Covers |
|---|---|
| `scripts/test-purchase-advice-read-state-db.js` | the db/608 read-state trio and the stamps |
| `scripts/test-purchase-advice-chase-db.js` | the 30-day chase fires on `blank` only |
| `scripts/test-purchase-advice-diagnosis-pure.js` | the field diagnosis wording |
| `scripts/test-post-purchase-db.js` | `adviceGate` + `announceSold` |
| `scripts/test-sold-and-payoff-db.js` | `decideSold` (pure) + the sold stage end to end — **but the `desk` source only as a pure call** |
| `scripts/test-draw-release-party-{pure,db}.js` | `soldStatus` / `soldVia` / the release ladder |
| `scripts/test-purchasing-db.js` | the desk's own advice record |

The gap the changes above would need to close: **a route-level test that a desk-entered advice
date produces a Sold stage with `sold_source='desk'`.** No such test exists today, which is why
the branch could be dead without anything going red.
