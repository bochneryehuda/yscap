# Long-Term PPE doors no suite invokes

`scripts/check-lt-ppe-route-tests.js` reads every route `src/longterm/routes/ppe.js` publishes — from
the ROUTER's own stack, not from a list — then RUNS the `test-lt-ppe-*` suites with a probe attached
and records which of those doors were actually invoked, through the router or by a direct call to the
exported handler. It refuses a door neither a suite nor this ledger accounts for.

This file is the deliberate escape hatch, and a row is only worth having if it says **why the door
cannot have a test** — "nothing tests it" is the finding, not the excuse. It fails BOTH ways: a row
here for a door a suite now invokes is STALE and is refused, because a ledger that overstates what is
unguarded is one nobody reads.

**A row is not an endorsement.** It is a debt with a reason attached.

| route | why no suite invokes it |
| --- | --- |

_(empty — every door published by `src/longterm/routes/ppe.js` is invoked by at least one suite.)_

## What this gate does NOT claim

Invoking a door is not the same as proving what it does. This gate answers "is anything at all asking
this question?", which is the one thing the LT PPE surface has repeatedly got wrong — 35 routes, and
before `test-lt-ppe-http-db.js` not one of them had ever been driven through the router. Depth is the
suites' job; this is the floor under them.

## Open questions raised by the doors these suites now drive

Recorded rather than guessed at, because the code does not answer them and a test must not invent a
rule (`scripts/test-lt-ppe-operator-doors-db.js` asserts what these doors DO, never a guess at what
they should do).

1. **The canary battery compares against an unparsed Lender Price envelope.** `runBattery` wires
   `theirs: (sc) => lp.price(sc)`, and `lp.price` returns the RAW envelope
   (`{ ok, raw, request, searchKey }`) — not the `parse()` shape. `shadow.runOne` hands whatever
   `theirs` returned straight to `parity.compareScenario`, which cannot read an envelope, so every
   scenario in a battery comes back INCOMPARABLE and the run's agreement rate is `null`. Measured
   through the real route: a 4-scenario matrix returned `agreed 0, disagreed 0, incomparable 4`.
   `POST /quote` had the same defect and fixed it for itself by wiring `deps.lpDetail` (§2.8 — the
   comment there records that an envelope read as a parsed result made "Lender Price read as
   INELIGIBLE" on every quote). Whether the canary is meant to parse the envelope the same way, or to
   be handed an already-parsed leg by its caller, is not derivable from the code: both legs are wired
   deliberately and neither says. **This is a question for the owner, not a fix to guess at** — it
   decides what the agreement rate the go-live gate reads is measured over.

   What the suite asserts instead is the invariant that holds either way: every scenario is accounted
   for (`agreed + disagreed + incomparable === scenarios`), the agreement rate is computed over the
   COMPARABLE ones only or is `null` when there were none, and the scoreboard's `measured` means
   exactly "an agreement rate was recorded".
