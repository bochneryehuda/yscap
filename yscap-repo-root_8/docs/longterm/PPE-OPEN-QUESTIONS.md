# LT PPE — business rules nobody has stated, recorded rather than invented

A question in this file is one where the code could easily have picked an answer and where picking one
would have been a **guess about how the business runs**. The standing rule is that a wrong guess about
money is worse than a delayed question, so each of these is answered in code by a NAMED REFUSAL that
hands the question to a person, and is written down here so it is not rediscovered from a quiet screen.

Nothing in this file is a defect. Each one is a decision that is the owner's to make.

---

## 1. Which version prices when TWO are published and in effect for one program?

**Where it bites.** `store.currentRateSheetVersion` answers "which published version is in effect"
with `ORDER BY effective_from DESC LIMIT 1`. `publishRateSheetVersionUnchecked` supersedes the other
published rows for the same `(scope, program, channel)`, so exactly one in effect is the norm — but it
is not guaranteed:

- **Two channels.** The supersede is scoped to a channel, so a program can legitimately hold a
  published `correspondent` sheet AND a published `wholesale` sheet at the same time. A quote that
  does not name a channel is then asking a question with two right answers.
- **Two rows in one channel.** Reachable if a row is ever published by a path other than that
  function, or by a hand-written UPDATE. `LIMIT 1` would take one of them silently, and two rows
  sharing an `effective_from` do not even order deterministically.

**What the code does today.** `resolveRateSheetVersion` (src/longterm/routes/ppe.js) counts the
versions in effect first. Zero is `no_published_rate_sheet`; more than one is
`ambiguous_published_rate_sheet` — it REFUSES, names the state, and lists the candidates. Naming a
channel, or naming an exact version, resolves it, so the refusal is a question rather than a wall.

**The questions actually open:**

1. When a quote does not name a channel, does the business have a DEFAULT channel an unqualified
   quote means (the setting `program.default_channel` exists and is `correspondent`) — or is an
   unqualified quote on a multi-channel program genuinely ambiguous and correctly refused?
2. If two sheets are ever in effect in ONE channel, is the later `effective_from` the winner, or is
   that state itself a defect that should be repaired rather than tie-broken?
3. Should a version be publishable with a FUTURE `effective_from` (a scheduled reprice)? The predicate
   already filters `effective_from <= now()`, so a future-dated publish would read as "nothing
   published" until it takes effect. Nobody has said whether that is the intent.

**Do not answer these in code without the owner's own words.** Picking (1) would price a wholesale
loan off a correspondent sheet; picking (2) would price a loan off whichever of two sheets sorted
first.

---

## 2. Does a price limit belong to the SHEET or to the PROGRAM?

**Where it bites.** `lt_ppe_price_limit` is keyed on `(scope, version_id)`, and the console's control
is draft-only — so opening a new version of a sheet starts with NO price limits and somebody must set
them again. That is defensible (a reprice can genuinely move a floor) and it is also how a floor gets
forgotten on a version nobody thought to check.

**The question:** should a new version INHERIT the previous version's limits as a starting point
(still requiring a reason to change them), or is starting empty the deliberate behaviour so that every
version's floor is stated afresh?

Today it starts empty, which is the existing behaviour and was not changed. The console now shows
"No price limits are set on this version — it prices with the engine's coded defaults", so the state is
at least visible rather than silent.

---

## 3. Who may move a price limit, and does it need a second person?

The route is `requirePpeAdmin` and requires a typed reason, recorded with the actor's name in
`lt_ppe_price_limit_audit`. The publish gate, by comparison, requires either a measured agreement run
or an explicit override.

**The question:** is a single admin plus a recorded reason the right bar for moving a price floor, or
should it follow the publish gate's shape (a second person, or an override that is recorded as an
override)? Nobody has stated a rule, so the code applies the lighter one and records everything.
