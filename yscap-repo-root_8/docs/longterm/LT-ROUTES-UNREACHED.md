# Long-Term HTTP routes no screen can reach

`scripts/check-lt-http-reachability.js` reads every route Long-Term publishes and every call the ONE
front-end client (`app-v2/src/longterm/api.js`) makes, and refuses a route neither a screen nor this
ledger accounts for. This file is the deliberate escape hatch, and a row is only worth having if it
says **who does reach the route** — "nothing calls it" is the finding, not the excuse.

It fails BOTH ways. A row here for a route a screen now calls is STALE and is refused, because a ledger
that overstates what is unreachable is one nobody reads.

**A row is not an endorsement.** Several of these are genuinely finished work waiting on a screen, and
one of them — `POST /ppe/canary/tick` — is a scheduler nothing ticks, which is a real defect recorded
here rather than smoothed over (see the note under the table).

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
| `POST /api/lt/dscr/price` | The raw Lender Price pricing call. Screens go through `POST /ppe/quote`'s successor `POST /ppe/breakdown` and the PPE surface; this is the unwrapped vendor call, used by the offline measurement scripts and by hand. |
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
| `POST /api/lt/ppe/quote` | Prices one scenario, LP authoritative with our engine in shadow. The scenario screen uses `POST /ppe/breakdown`, which answers the richer question. Kept because it is the shadow-mode entry the cutover plan turns on. |
| `POST /api/lt/ppe/canary` | Runs a canary battery. **It is the only producer of the findings ledger and the parity-cell series**, so with no caller those two screens can only ever show what a hand-run `curl` put there. Its screen is the next thing owed to the PPE console. |
| `GET /api/lt/ppe/canary/schedules` | Reads the daily canary schedule (D19). No schedule screen yet. |
| `POST /api/lt/ppe/canary/schedules` | Writes one. Same. |
| `DELETE /api/lt/ppe/canary/schedules/:investor` | Removes one. Same. |
| `POST /api/lt/ppe/canary/tick` | **Nothing calls this, and nothing else does its job.** See below. |

## The one row that is a defect, not a gap

`POST /api/lt/ppe/canary/tick` is the tick that fires the daily change-detection schedules (D19, task
#52). Searched: no cron, no worker, no `setInterval`, no Render job, no other route. **A schedule can be
stored and will never fire**, so "the daily battery detects a Lender Price change" is true of the code
and false of the running system. That is this workstream's recurring shape — built, tested, and asked by
nothing — and it is written here rather than left for someone to discover from a quiet screen.

Fixing it is not a one-liner and must not be guessed at: whether the tick is driven by a Render CRON
service (the shape the off-site backup uses), by the existing sync worker, or by a scheduler inside the
process changes what happens when two instances run, and it is a live vendor call with a cost. Recorded
as a task; the schedule screens above are owed the same pass.

## Not a route, but the same dead end one step nearer the user

The checker also reports `ltApi` entries no screen calls. Today: `ppeSetPriceLimit` (the sheet's
price-limit editor) and `ppeRateSheetAgreement` (the stored agreement read). Both have a route and a
client method and no button — the client is ahead of the console by exactly one control each.
