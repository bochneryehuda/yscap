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
| `GET /api/lt/ppe/settings` | The typed settings registry + resolved values. The console reads settings through the screens that need them; there is no settings editor on the Long-Term PPE surface yet. |
| `GET /api/lt/ppe/rules` | The stored rule set. Waiting on the rule-authoring editor (§2.42) — the service exists, the screen does not. |
| `GET /api/lt/ppe/rules/coverage` | Which cells that rule set covers. Same — it is the editor's own dead-cell view. |
| `POST /api/lt/ppe/suggestions/mine` | Mines rule suggestions out of the recorded findings. Same: an editor action with no editor. |
| `GET /api/lt/ppe/programs/:id/lp-scope` | Reads a program's Lender Price scope. The console SETS the scope (`POST` is reached) and re-reads it from the write's own response, so the GET has no caller. |
| `GET /api/lt/ppe/rate-sheets/:id/diff` | What changed between two versions of a sheet (§2.35). Built; the console has no version-history view yet. |
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

**What now exists (§2.46 of LENDER-PRICE-PARITY-STATUS.md):** an in-process driver,
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
owner question in `docs/longterm/LENDER-PRICE-PARITY-STATUS.md` §2.46. **Until somebody answers it and
turns the switch on, the sentence at the top of this section is still true of the running system.**

**The schedule SCREENS are owed no longer:** they are built (`CanaryConsole.jsx`) and they say on the
page that a saved cadence is honoured by nothing until the driver is switched on — which is the only
honest way to ship a schedule editor over a tick that may never fire.

## Not a route, but the same dead end one step nearer the user

The checker also reports `ltApi` entries no screen calls. Today: `ppeSetPriceLimit` (the sheet's
price-limit editor) and `ppeRateSheetAgreement` (the stored agreement read). Both have a route and a
client method and no button — the client is ahead of the console by exactly one control each.
