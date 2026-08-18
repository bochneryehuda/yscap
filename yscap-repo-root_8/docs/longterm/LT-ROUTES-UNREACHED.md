# Long-Term HTTP routes no screen can reach

`scripts/check-lt-http-reachability.js` reads every route Long-Term publishes and every call the ONE
front-end client (`app-v2/src/longterm/api.js`) makes, and refuses a route neither a screen nor this
ledger accounts for. This file is the deliberate escape hatch, and a row is only worth having if it
says **who does reach the route** — "nothing calls it" is the finding, not the excuse.

It reads **both mount seams**: the composer `src/longterm/index.js`, and `src/server.js`, where a
Long-Term router with a different audience is mounted beside the staff-only `/api/lt` (the borrower's
own long-term files, the secret-gated diagnostics). It also derives the client's HTTP verbs from
`app-v2/src/longterm/http.js` rather than listing them. **One route file is still invisible to it**:
`lenderprice-diag.js` publishes nothing of its own — it re-mounts the DSCR pricer's router behind a
secret header — so its routes are counted once, under `/dscr`, which is where they are recorded below.

It fails BOTH ways. A row here for a route a screen now calls is STALE and is refused, because a ledger
that overstates what is unreachable is one nobody reads.

**A row is not an endorsement.** Several of these are genuinely finished work waiting on a screen, and
one of them — `POST /ppe/canary/tick` — was a scheduler nothing ticks, which is a real defect recorded
here rather than smoothed over. A driver for it now exists and ships SWITCHED OFF, so the sentence is
still true of the running system until somebody turns it on; see the note under the table.

| route | why it has no screen |
| --- | --- |
| `GET /api/lt/encompass/milestones` | The Encompass milestone map — read-only reference knowledge, queried by hand during build work. No Long-Term screen presents it yet. |
| `GET /api/lt/encompass/milestones/:id` | One milestone from that map. Same. |
| `GET /api/lt/encompass/summary` | The compact overview of the whole Encompass memory. Same. |
| `GET /api/lt/encompass/fields` | The unified Encompass field catalog. Same. |
| `GET /api/lt/encompass/fields/:id` | One field by its Encompass id. Same. |
| `GET /api/lt/encompass/completion-rules` | The Milestone Completion rules. Same. |
| `GET /api/lt/encompass/requests` | The request / authorization catalog. Same. |
| `GET /api/lt/encompass/reconciliation-map` | Which Encompass fields reconcile against RTL. Same. |
| `GET /api/lt/encompass/intelligence` | The mined field intelligence. Same. |
| `GET /api/lt/encompass/intelligence/:id` | One intelligence entry. Same. |
| `GET /api/lt/encompass/anatomy` | The anatomy of an Encompass loan. Same. |
| `GET /api/lt/encompass/terms` | The Encompass term glossary. Same. |
| `GET /api/lt/encompass/programs` | The Encompass program list. Same. |
| `GET /api/lt/encompass/conditions` | The Encompass condition catalog. Same. |
| `GET /api/lt/encompass/api-surface` | What the Encompass API exposes. Same. |
| `GET /api/lt/encompass/investors` | The Encompass investor list. Same. |
| `GET /api/lt/encompass/dropdowns` | The Encompass dropdown values. Same. |
| `GET /api/lt/encompass/settings` | The Encompass settings snapshot. Same. |
| `GET /api/lt/encompass/status` | Whether the Encompass memory loaded. Same. |
| `GET /api/lt/dscr/health` | The Lender Price pricer's own health. Read during build and incident work with a signed-in session; the LT PPE screen shows `GET /ppe/health` instead, which is the one a person needs. |
| `GET /api/lt/dscr/login-check` | Confirms the vendor login works. An operator check, run by hand. |
| `POST /api/lt/dscr/price` | The raw, unwrapped Lender Price pricing call — no shadow comparison, no ledger. Screens go through `POST /ppe/breakdown` (our engine against a stored sheet, no vendor call) and `POST /ppe/quote` (Lender Price with our engine in shadow); this one is used by the offline measurement scripts and by hand. |
| `POST /api/lt/dscr/disqualify` | Kicks off the vendor's asynchronous disqualify computation. Driven by the pricing path and by hand, never by a screen. |
| `POST /api/lt/dscr/disqualifications` | Polls that computation by search key. Same. |
| `GET /api/lt/dscr/disqualifications/:searchKey` | The same poll as a GET. Same. |
| `POST /api/lt/dscr/selftest` | The pricer's end-to-end self-test. An operator command. |
| `POST /api/lt/ppe/canary/tick` | **A driver now exists and is OFF by default.** See below. |
| `GET /api/lt/ppe/canary/driver` | Is anything actually driving that tick, when did it last try, what did it do, and why did it not. Read by hand while the driver is off; it is what a schedule screen would show once somebody turns one on. |

The four canary rows that stood here — `POST /ppe/canary` and the three `/ppe/canary/schedules`
routes — are gone because they are reached now: `CanaryConsole.jsx`, mounted on the PPE console, runs
a battery behind a two-step arming step that states the number of live vendor calls before it fires,
and lists, saves and removes the daily schedules. The tick above stays, and the console says ON THE
SCREEN that nothing fires a saved schedule unless the driver is switched on — a schedule editor that
drew a stored cadence as armed would be the surface that finally HID this defect instead of the one
that shows it.

## The one row that was a defect, not a gap — and what has changed

`POST /api/lt/ppe/canary/tick` is the tick that fires the daily change-detection schedules (D19, task
#52). Searched: no cron, no worker, no `setInterval`, no Render job, no other route. **A schedule could be
stored and would never fire**, so "the daily battery detects a Lender Price change" was true of the code
and false of the running system. That is this workstream's recurring shape — built, tested, and asked by
nothing — and it was written here rather than left for someone to discover from a quiet screen.

**What now exists (§2.49 of LENDER-PRICE-PARITY-STATUS.md):** an in-process driver,
`src/longterm/ppe/canary-driver.js`, armed from `src/longterm/index.js` and **OFF BY DEFAULT** behind
`LT_PPE_CANARY_DRIVER_ENABLED`. That switch is set NOWHERE in this repository — not in `render.yaml`,
not in any script — so merging it changed nothing about the running system: with the switch unset the
driver arms no timer, opens no connection and calls no vendor. Cross-instance safety is built in
regardless of the switch: the tick is claimed by a durable database lease
(`lt_ppe_canary_driver_state`, db/578 — the `sync_locks` pattern, named `lt_*` because Long-Term may
not touch an RTL table), so two instances can never both fire one schedule and pay for two vendor runs.
It fails closed and records why: a lease it cannot take, a tick that throws, a schedule that cannot run
at all — each is written to that row and readable at `GET /ppe/canary/driver`.

**What is still open, and it is the owner's call, not an engineer's:** WHICH driver production should
use — a Render CRON service (the shape the off-site backup uses), the existing sync worker, or this
in-process scheduler. Each behaves differently when two servers are running and each costs a live
vendor call, so the in-process one is built behind the off switch and the choice is recorded as an
owner question in `docs/longterm/LENDER-PRICE-PARITY-STATUS.md` §2.49. **Until somebody answers it and
turns the switch on, the sentence at the top of this section is still true of the running system.**

**The schedule SCREENS are owed no longer:** they are built (`CanaryConsole.jsx`) and they say on the
page that a saved cadence is honoured by nothing until the driver is switched on — which is the only
honest way to ship a schedule editor over a tick that may never fire.

## Not a route, but the same dead end one step nearer the user

The checker also reports `ltApi` entries no screen calls. **Today: none.** The last two were
`ppeRateSheetAgreement` (the stored agreement read — given the `AgreementRecord` panel) and
`ppeSetPriceLimit` (the sheet's price-limit editor — given the `PriceLimitCard` on the rate-sheet
console). Both had a route and a client method and no button; the client had been ahead of the console
by exactly one control each.

**A NOTE ON WHAT THAT LINE CAN AND CANNOT SEE, learned by mutating this code.** The scan reads
`ltApi.<name>(` out of the screen files — it does not read the render tree. So a control that is
IMPORTED, WRITTEN, and then disabled (`{false && <PriceLimitCard …>}`) keeps this checker green while
being unreachable to every person. That was reproduced deliberately: the gate stayed green and only a
render-level guard caught it. Treat a green line here as "a screen names the call", not as "a person
can press it"; the screen's own suite is what proves the second
(`scripts/test-lt-ppe-price-limit-render.mjs`, section F).

## What came off this list, and what did NOT

The rule surfaces came off in one pass: `GET /ppe/rules`, `GET /ppe/rules/coverage`,
`POST /ppe/suggestions/mine`, `GET /ppe/rate-sheets/:id/diff` and `GET /ppe/programs/:id/lp-scope` are
now reached by the rule board (`app-v2/src/longterm/RuleBoard.jsx`), which also opens the READ and
DRAFT doors of the rule-authoring service — a service that until then had no HTTP door at all.

**The publish door exists now, and it is not recorded here because a screen reaches it.**
`rule-authoring-store.publishDraft` writes a rule that changes a priced number, so the route waited for
an owner decision rather than being gated by whatever was nearest — building it behind the ordinary
admin gate would have answered the question by convenience. The owner answered it on 2026-08-18
(*"all in the super admin"*), so `POST /ppe/rule-drafts/:id/publish` is registered behind
`requirePpeSuperAdmin` — the ONE route on that router that does not take the ordinary admin gate — and
the rule board's own **Publish it** button (two-step, `ltApi.ppePublishRuleDraft`) is its caller. §2.51
in `LENDER-PRICE-PARITY-STATUS.md` carries the whole record.

**The button is deliberately NOT hidden from a non-super-admin.** The screen cannot know the role, and
a control that silently vanishes teaches nobody why; the server's 403 names who may publish, which is
the only version of that answer a person can act on.
