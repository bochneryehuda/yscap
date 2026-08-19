# THE ARENA — the research behind it, and the decisions it drove

Owner-directed 2026-08-19. This is the write-up behind `db/585`, `db/586`,
`src/lib/arena/**`, `src/routes/arena*.js` and `app-v2/src/**/arena*`.

It exists so nobody has to re-derive why the thing is shaped the way it is. Six
research passes were run before a line was written, and a seventh after the
owner corrected the stop-button design mid-build. Where research changed a
decision, that is said. Where it changed nothing, that is said too.

---

## 1. What was asked for

The owner's words, condensed but not paraphrased away:

- A spinner the **super admin controls**. Spin number one, then more through the
  day. Everyone who arrived before a cutoff is in it; **everybody checks in from
  their own login**.
- Everyone approved into the spin can **say what they would like to win** —
  anything personal up to $500, anything for the business up to $1,000. The
  super admin accepts each one.
- **We do the spin on our side, and everybody can see why it spins.** It spins
  for the loan officer, then for the prize — or the other way round.
- A **master switch**: "when it's turned off, nobody should even see that
  setting", and it must come back on later.
- **Sessions** hold many spins. The record of every spin stays visible until the
  session closes and a new one opens.
- Connected to the CRM: spin the **live files**, or the ones that **closed last
  week**; the file that wins, its officer wins.
- Achievement spins: "a call more than 10 minutes, or a tough rejection, or
  closed a deal — it spins between those three, and the person who has it and
  shows it first wins."
- Everyone can **join, chat while the wheel turns, and suggest the next spin**.
- **Notifications**: when a spin opens, when a deadline nears ("by eleven you
  still have 38 minutes"), and when somebody wins.
- Later, in a second pass: **auto-select everyone** in the session onto a new
  spin (removable); an **AI helper** at every step; two ready-made spins for the
  day (**Early Bird** and **Mega Spin**); **challenges every twenty minutes**;
  the **stop button** in a named person's hand.
- And a correction that changed the engine: *"he should have the actual stop
  button on the spinner. I click Start Spin, and he has the stop button. It
  spins till he clicks Stop … he shouldn't be able to literally control it. He
  should be able to try."*

---

## 2. Research pass one — spinner tools and provable fairness

**What was looked at.** Wheel of Names, PickerWheel, spinthewheel.app,
Random.org's list randomiser and draw service, RandomPicker, Provable.io,
SweepWidget/Gleam/Woobox, and the wheel libraries (`winwheel.js`,
CrazyTim's `spin-wheel`, `react-custom-roulette`).

**What every serious one has**: per-entry weighting, remove-after-win, sound and
confetti toggles, images on slices, a shareable result. The *enterprise* tier
adds the thing that mattered here: a published, checksummed fairness record.
RandomPicker calls it a "certificate of fairness"; Provable.io publishes a
commit-reveal permalink.

**Decisions it drove:**

| Finding | What we did |
|---|---|
| `Math.random()` is a non-cryptographic generator whose state is recoverable from its output; Wheel of Names says in its own FAQ that it uses `crypto.getRandomValues` | Every random byte comes from `crypto.randomBytes`. `src/lib/arena/fair-draw.js` |
| Commit-reveal: publish `sha256(serverSeed)` **before** the entrant list is knowable, disclose the seed after | `arena_draws.commit_hash` is written when the SPIN is created — before check-in opens. The roster is frozen later and hashed separately. A seed cannot be shopped against a list that does not exist yet |
| The house alone should not control the input | `client_seed` — a value typed in the room, or generated and recorded before the result is known |
| Freeze and publish the entrant list | `arena_draws.roster` + `roster_hash`. Editing it afterwards fails verification, which the DB test proves |
| Let participants verify | `GET /api/arena/draws/:id/verify` is open to **every** staffer, not just admins |
| Undisclosed weighting is the number-one "was that rigged?" complaint | `showOddsToEveryone` defaults ON; the roster panel shows each person's percentage |
| Compute the winner server-side, then derive the rotation — never read the winner off where the wheel lands | `targetRotationDeg()` takes the winner as input. The browser never picks anything |
| Slice size must equal win probability | `sliceAngles()` and `pickWeighted()` consume the **same** weight array. The pure test asserts the two agree to 1e-12 |

**One thing we did NOT copy.** The naive `int(hash) % n` mapping used by most
tutorials is very slightly biased. `uniformBelow` uses rejection sampling
instead. Honestly: the bias would be about one part in 10^19 and **our own test
cannot detect it** — the mutation that replaces the rejection loop with a plain
modulo leaves the suite green. It is in the code because a knowingly-biased
selector inside a fairness feature is the wrong shape, not because a test bites.
`scripts/test-arena-fair-draw-pure.js` section E says exactly this in the file.

---

## 3. Research pass two — sales gamification for loan officers

**What was looked at.** Spinify, SalesScreen, Ambition, Hoopla, LevelEleven,
Centrical; published mortgage call-blitz playbooks; academic and practitioner
work on sales-contest design.

**The finding that shaped the defaults**, and it is worth stating plainly:
tournament-shaped contests **discourage the middle of the team**. Gartner-cited
work says comp plans built around top performers largely fail to move the
middle; controlled experiments find proportional-prize contests produce higher
entry and higher total achievement than winner-take-all; practitioners are blunt
that once the top reps pull ahead, everybody else tunes out.

**Decisions it drove:**

- `BASE_DEFAULTS.weightMode = 'equal'`. Ticket-weighting exists and is one click
  away, but an admin has to choose it. `scripts/test-arena-rules-pure.js` pins
  that most games default to equal, on purpose.
- The challenge library is mostly `award: 'everyone'`. First-past-the-post is
  the spice, not the meal.
- The board shows the **top five and your own standing** — never a full ranking.
  Published bottom-of-the-leaderboard positions are linked to attrition without
  performance gain. `challenges.boardFor()` has no rank field, and the DB test
  asserts the payload contains none.
- Non-cash perks are seeded alongside cash prizes: research on incentive
  programmes finds tangible non-cash rewards are talked about and remembered far
  longer than cash of equal value.

**Where the game catalog came from.** 47 game types in
`src/lib/arena/game-types.js`, each carrying an `origin` field naming its source
— Spinify's Poker Stars / Flash Friday / Musical Chairs / Sales Playoffs;
SalesScreen's Lottery, multi-round and relay; Hoopla's finance point ladder and
Application Blitz; RepCard's You-vs-You, Best-vs-Rest and tiered brackets; the
instant-win family. Nothing was invented and then dressed up as a best practice.

---

## 4. Research pass three — the live room

**What was looked at.** SSE vs WebSockets on a PaaS; Postgres LISTEN/NOTIFY as a
fan-out bus; clock-sync for synchronised animation; live-chat design at small
scale; notification-fatigue research.

**Decisions it drove:**

- **SSE, on the bus this app already has.** `src/lib/events.js` was already an
  in-process SSE registry. One function was added (`publishToStaff`) rather than
  a second transport. Render does not offer sticky sessions for WebSockets, so
  a WS build would have needed cross-instance state anyway — for a broadcast-
  heavy, low-write feature that is cost with no benefit.
- **Cross-instance is a documented upgrade path, not a pretence.** This app runs
  one web process; `events.js` says so, and says the swap is Postgres
  LISTEN/NOTIFY if that changes. The chat slow-mode and the AI pace limit are
  in-memory and **the comments say they become per-process** if it ever runs
  multi-process. Stated rather than implied.
- **Clock skew is real.** An office laptop can be a minute out. `lib/arena.js`
  measures an NTP-style offset from the board response's `serverNow` and takes
  the **median of the last seven samples** — one slow response must not throw
  the room's animation out.
- **Late joiners need no special case.** The wheel's angle is a pure function of
  `(serverNow − startedAt) / duration`. A screen opening halfway through gets
  0.5 and joins mid-flight; there is no catch-up path to get wrong.
- **A card, not a modal, for challenges.** Interruption research is the reason:
  people are interrupted roughly every two minutes in an office already, past
  about ten notifications an hour they stop reading any of them, and
  attention-residue work (Leroy) finds the cost is worst when the interrupted
  task was time-pressured and unfinished — which describes a live sales call
  exactly. So a challenge arrives as a corner card that waits, and the big
  full-screen count-in is a few seconds, once, and leaves by itself.

---

## 5. Research pass four — timed challenges (Phase 2)

**What was looked at.** Duolingo daily quests and timed challenges, Strava
segments and challenges, Twitch predictions, Kahoot, HQ Trivia, Zwift, Peloton,
Nike Run Club; first-to-complete vs everyone-completes; verification without a
data integration; points-economy inflation.

**Decisions it drove:**

- **Not a metronome.** A fixed twenty-minute gap is predictable, and
  predictability is exactly what kills the effect — variable-ratio schedules are
  the most resistant to extinction, and a fixed clock also guarantees you
  interrupt the same people mid-call every time. `planDay` jitters each gap ±5
  minutes around the target, deterministically from a seed the admin can change.
  The DB test asserts the gaps are not all identical.
- **Two at a time, maximum.** Somebody chasing three things finishes none.
  `MAX_CONCURRENT = 2`, enforced by shortening an older window rather than
  refusing to schedule. The DB test measures the worst overlap.
- **Walk the funnel.** "First lock of the day" at 12:31 is a challenge nobody
  can win yet, so dials/partner-calls/database weight to the morning and
  applications/pre-approvals/locks to the afternoon.
- **A fixed tier table, set before the day and not changed during it.** Changing
  what a tier is worth halfway through is the classic points-economy failure —
  everybody who earned the old rate feels cheated. `TIERS` in
  `challenge-library.js` is read once.
- **Verification is a person.** Fitness-challenge operators are blunt that heavy
  anti-cheat mostly infuriates honest people, and that the real fix is making
  cheating low-value. There is deliberately **no `automatic` proof type**,
  because PILOT records no call log, no dial count and no talk time — a fact
  said out loud on every game card and every challenge card rather than papered
  over.

---

## 6. Research pass five — the AI helper

**What was looked at.** OpenAI structured outputs and Anthropic's equivalent;
what models actually exist; inline-writing UX (Grammarly, Google Docs "Help me
write", Copilot ghost text); AI suggestion-chip UIs; guardrails.

**Two factual corrections worth recording:**

1. **"ChatGPT 5.5" is a real thing.** ChatGPT is the app; **GPT-5.5 is the
   model**, `gpt-5.5` as an API id, and the GPT-5.6 family supersedes it.
2. **Which of them is reachable is an Azure question, not a code question.**
   Foundry rolls models out by region. So `src/lib/arena/copilot.js` names no
   model at all: it uses the configured `AZURE_OPENAI_DEPLOYMENT` and reports
   that name back so the screen can say what actually answered.

**Decisions it drove:**

- **It never publishes.** Every call returns a draft into a form a human edits
  and submits through the ordinary path. That single property is what makes
  prompt injection — ranked first among LLM risks — a non-event here: the worst
  a poisoned instruction achieves is silly text in a box somebody is looking at.
- **It never sees a borrower.** Not a name, a loan number or a file. The module
  imports nothing that could reach one. This is structural rather than
  instructional, because the regulator's position is that existing consumer-
  protection law applies to AI in full with no carve-out.
- **One door.** Everything goes through `ask()` — one pace limit, one daily cap,
  one timeout, one classification of failures. Four different failure sentences,
  because "something went wrong" teaches people to distrust the feature.
- **It degrades to manual, always.** No key, a timeout, a refusal — the answer
  is a plain sentence and the person types it themselves. On a live sales day an
  AI call that hangs must never be able to stop a spin going out.
- **Never silently replaces what somebody typed.** The rewrite appears beside
  their words with Use it / No thanks, and "Put mine back" survives acceptance.
- **Stable prompt first, user text last**, so the provider can cache the
  unchanging prefix — the single biggest lever on what this costs.

---

## 7. The stop button — and the correction that changed the engine

The first build made the stop button ceremonial: the winner was settled before
the wheel moved, and pressing stop only decided *when* it stopped. That is the
honest version of a predetermined draw, and the illusion-of-control literature
(Langer 1975) says the physical act alone produces most of the excitement.

**The owner rejected it**, and was specific: *"he should have the actual stop
button on the spinner … it spins till he clicks Stop … he shouldn't be able to
literally control it. He should be able to try."*

So the engine now has **two genuinely different modes**, and both are checkable:

| | AUTO | HELD |
|---|---|---|
| When is the winner decided | before the wheel moves | when the button is pressed |
| What the wheel does | turns to a computed angle over a fixed time | turns, and keeps turning |
| What decides the landing | seed + client seed + nonce | **seed + how long it had been turning** |
| Elapsed time measured by | — | the **database**, `now() - spin_started_at` in one statement |
| Verified by | `verifyDraw` | `verifyHeldDraw` |

**Can it be aimed?** No, and this is measured rather than asserted: at the
default 900°/s the wheel crosses a slice in a few tens of milliseconds. The DB
test walks the press moment across a 200ms window in 25ms steps and asserts it
lands on at least four different slices of eight. A person can lean on roughly
a quarter of the wheel; nothing finer.

**Why the seed is still mixed in.** Without it the landing would be arithmetic
on elapsed time, and somebody with a stopwatch and the published speed could
work out where to press. The seed adds a fixed offset that is unknowable until
it is revealed.

**What the person holding it is told**, verbatim on their screen: *"This really
does stop it, and where it lands is down to when you press. It is going too fast
to aim properly — you can lean on roughly a quarter of the wheel, no finer.
Nobody can check it in advance either: the number that shifts it is sealed until
afterwards."* Both halves, because either half alone is a lie.

**The press is unrepeatable.** `db/586` adds a fourth draw state, `stopping`.
The press is the statement that moves the row out of `spinning`; a second press
and the safety-net timer both find it gone. This was a real defect the DB test
caught — the first version put the row back to `spinning` for the coast, which
reopened the door.

---

## 8. Two things the owner asked to leave out

Research pass six produced a sourced prize catalogue and, alongside it, notes on
US payroll-tax treatment of employee prizes and on RESPA exposure for
realtor-co-branded marketing prizes.

**The owner asked for neither, and told us to drop them.** They are removed from
the code, the seed data and the prompts. They are recorded here in one line so
that the omission is a decision on the record rather than an oversight: if
anyone later wants that material, it was researched and deliberately not built.

---

## 9. What is real, what is a claim, and what is missing

Being exact about this, because the feature's whole premise is that people can
trust what it says.

**Reads real data:**
- the staff roster (`staff_users`)
- the RTL loan pipeline — live files, files closed in a window, officers with
  live files. `applications` only. No Long-Term table is read or written.

**Runs on what a person claims, checked by a super admin:**
- everything about calls. **There is no call log, no dialer integration, no
  talk-time field and no dial count anywhere in this codebase.** Every game and
  every challenge that touches a call is proved by a screenshot or by what
  somebody writes. Said on the card each time, never implied otherwise.

**Not built:**
- a dialer integration. If one ever lands, it becomes one more entry in
  `candidate-sources.js` and the affected games stop needing the human step.
  Nothing else changes.

---

## 10. How it was proven

Nothing below is a claim about intent; each was run.

- **Migrations** applied and replayed **three times** against a real Postgres.
  The first replay of `db/585` **failed** — `ON CONFLICT` against a partial
  unique index needs the predicate restated — and `migrate-boot` logs a failure
  and continues, so it would have broken every future deploy quietly. Fixed and
  re-proven.
- **`scripts/test-arena-fair-draw-pure.js`** — 4,541 assertions. Weights are
  measured over 60,000 draws (ten sigma tolerance). The rotation is checked to
  land inside the winner's slice for every position in rosters of 2–24, with and
  without jitter.
- **`scripts/test-arena-rules-pure.js`** — 551 assertions across the two doors,
  the switch matrix and the whole catalog.
- **`scripts/test-arena-flow-db.js`** — 89 assertions, real Postgres and real
  HTTP, the whole Elementix Day.
- **`scripts/test-arena-play-db.js`** — 91 assertions covering Phase 2 and the
  live monitor.
- **`scripts/test-arena-announce-db.js`** — 40 assertions covering who is told
  what, and by which channel.
- **Browser** — Chromium drives the real SPA: the stage renders, the wheel
  turns, the free spin runs, the button appears for exactly one person, pressing
  it lands the wheel, the proof panel says every check passed, a loan officer
  cannot see the control room, and turning the switch off clears the nav and the
  board.

**Every suite was proven to fail**, one mutation at a time with a clean green run
either side. The full list is in each test file's header. Two are worth naming
here because they made the tests better:

- Replacing the rejection loop with a plain modulo left the fairness suite
  **green**. That is the honest result, and section E of that file now says so
  instead of claiming a bias check it does not have.
- Removing the `ON CONFLICT` from the ticket insert also left the suite green —
  the unique index catches it underneath. The assertion was re-pointed at what
  is actually ours: that a repeated approve is a quiet no-op rather than an
  error an admin has to puzzle over.

**Defects the tests found, before anyone else could:**
1. `ON CONFLICT` against a partial index (above).
2. A missing recorded weight resolved to 0 — silently unable to win — instead
   of 1.
3. The coast after a press put the wheel back to `spinning`, reopening it to a
   second press.
4. Held draws were verified with the automatic maths and always failed.
5. **The result was broadcast and nothing else.** Everything about a decided
   spin reached the live stream and stopped there — which is complete for the
   thirty people watching the wheel and completely silent for the person who won
   while they were on a call. That is the thing the owner asked for by name
   ("who won on each and every draw … the final nice notifications for everybody
   by email"), and it was found by grepping for a notify call in the settle path
   rather than by anyone hitting it.
6. **The Arena's notifications were not in the Notification Center at all**, so
   there was no way to turn any of them off. Seven entries and their own section
   were added; none is forced, because a game must never be something you cannot
   switch off.
7. **"In-app only" was a comment, not a rule.** The challenge bell said in its
   own file header that it must never become email, and nothing enforced it — the
   claim held only because the machine the tests ran on had no mailer. It is now
   `arena_challenge` in notify.js's `STAFF_INAPP_TYPES`, the one definition of
   that rule, and the test stubs the provider and asserts on what it was handed.

---

## 10a. Phase 3 — the parts the audit found missing

After the merge, every message the owner sent was re-read against the code. Five
things had been described and not built; four of them are the defects above. The
fifth is the screen:

**The live monitor.** "To be set up with good notifications on the winner live
screen to monitor how it's being filled out, how the spins run, and who wins."
`GET /sessions/:id/monitor` answers the whole screen in ONE call — a person
leaves this open on a second monitor all day, and six round trips a refresh is a
cost with no benefit. It leads with a single number, *things waiting on you*,
loud only when it is not zero, because that is the only thing on the page that
ever needs somebody to act.

It is also **the one place a full ranking is shown**, and that is a deliberate
departure from the players' own board, which shows the top few and your own
standing and never "you are 14th of 16" — the research on sales leaderboards is
consistent that publishing the bottom makes the people on it stop trying. The
person running the day genuinely needs to see who has not got going yet, so they
can nudge them. Different audience, different rule, said out loud on the screen
itself.

**The count-in is a setting, not a constant.** The owner asked for "a pop-up on
every screen with a countdown — ten seconds, twenty seconds". It reads
`challengeCountdownSeconds` end to end (default 10), so the room can be given
longer on the day without a deploy.


## 10b. Phase 4 — the five the owner picked

Six ideas were put to the owner. They took five and turned one down ("don't do
a live wall of the day for a TV in the office"), so there is no TV screen and
there will not be one until they ask.

**A full-screen takeover when a spin lands, with sound.** A card in the corner
of the page is the wrong shape for the one moment of the day the whole room is
supposed to look up. The chime is SYNTHESISED (`app-v2/src/lib/arenaSound.js`) —
no audio file to ship, to download, or to 404 — and the browser's own rule that
nothing may make a noise before the person has touched the page is HONOURED
rather than worked around: somebody who has not clicked hears nothing on the
first spin and every one after. The takeover always lets go (it dismisses
itself, answers Escape, answers a click) because a full-screen panel that can
trap somebody in front of the room is worse than no takeover at all, and it
respects `prefers-reduced-motion`. The landing is celebrated ONCE per spin — a
reconnecting stream replays frames, and a room that gets the same fanfare three
times stops believing the fourth.

**Streaks — three challenges in a row earns a bonus chance.** The rule is
`src/lib/arena/streaks.js`, and the thing that makes it right is that it
RECOMPUTES rather than increments. A bonus is not added when the third lands; it
is derived from the whole run, every time a decision changes, so a challenge
DECLINED an hour later takes back the bonus it paid for *and* every later bonus
whose run depended on it. An increment could never manage the second half of
that. A `pending` fulfilment does not break a run — a slow admin must never cost
somebody their streak — and anything else resets it.

**Fixing that exposed a real defect in the chances ledger, which is now fixed
too.** Declining a fulfilment took the chances back by writing a negative row
that carried no `entry_id`, so the question "what has this fulfilment already
been paid?" could not see it. Two consequences, both reproduced against a real
database before they were fixed: declining the SAME one twice took the chances
back TWICE, and approving it again afterwards gave nothing back (the award
insert is guarded by a unique index on `entry_id` and refused to re-add a row
that was still there). Somebody declined by mistake finished the day a chance
short with nothing on any screen to say why. `decide()` now reconciles the
entry the way the streak does — what it should be worth now, against what it has
been paid, with the difference written as one `adjustment` row (db/587) that
carries the entry so the next read can see it. Approve, approve twice, decline,
decline twice, decline then approve: five paths, one answer.

**A "who's in the room" bar.** `GET /sessions/:id/room` keeps CHECKED IN and
HERE NOW as two separate facts and never rolls them together. "Here now" is
derived from the live event connections (`events.isOnline`) with a 45-second
grace, which is honest by construction — there is no presence table to go stale
— and a check-in still waiting on an admin reads as WAITING, not as in the draw.
Telling the room four people are in when two are waiting on somebody is exactly
the lie this had to avoid.

**A rematch spin — the last two, head to head.** It reuses the existing `duel`
game rather than inventing one, so there is no new fairness code: the same
commit-reveal, the same sealed number. The suggestion always says HOW it got to
its pair (who was eliminated last, who won what, who has the most chances) —
a pair with no reason is a pair somebody will argue about — and the CHALLENGER
holds the stop button, never the one who is ahead.

**An end-of-day recap card each person can screenshot.** Private, per person,
built from the day's own record. It leads with what they DID, never with a
position, and the position is shown further down because the owner asked for it
and this card is private (the live board's "never publish the bottom" rule is
unchanged). Somebody who never played has NO position — they were not playing,
and calling them last would be the one wrong number on the card. The id comes
off the token, never the address bar; only a super admin, who reads the day out
at the end of it, may open somebody else's.

---

## 10c. The A-to-Z audit — what a fresh read found

The whole Arena was re-read end to end after it merged: every route and its
gate, the fairness engine, the ledger, the sweep, the AI helper, the front end,
and the migrations replayed twice against a real database. Four things were
wrong, one of them badly. Each was REPRODUCED before it was touched.

**THE STOP BUTTON WOULD HAVE BROKEN ON THE DAY, and the audit is the only reason
it did not.** A held wheel passes through the state `stopping` for the second and
a half it coasts after somebody presses. db/585 declared the wheel's state list
WITHOUT that value and db/586 widened it — and every migration replays on every
boot, each file as one transaction. From the moment a single `adjustment` ticket
row exists — which db/587 introduced, so the first time anybody declines a
challenge and it is reconciled — db/586's own narrower re-add of the ticket
source list fails, THE WHOLE FILE ROLLS BACK, and the widening goes with it.
db/585 has already run and left the narrow list standing, and nothing put it
back. Pressing the button then answered a 500 and the wheel never came to rest.

It was found by running the suite rather than by reading: the play suite went
from 91 green to 7 red on a database that had simply been booted a few more
times. **The earlier check that said this was safe measured the wrong thing** —
it confirmed the TICKET constraint stayed wide, which db/587 re-asserts, and
never asked what else that rollback took with it. db/588 re-asserts the wheel's
state list, numbered last and carrying no data-dependent statement so it cannot
roll back and take its own repair with it.

**The shape to watch for anywhere in this repo: a CHECK that TWO files declare,
where the later one can roll back.** Seven of db/586's other constraints are
fine for one reason only — no earlier file declares them, so a rollback leaves
db/586's own committed version standing. The regression guard replays db/585,
586 and 588 in order against a row that makes 586 fail, then puts a real wheel
into `stopping`.

**The off switch did not silence the announcements.** The switch promises the
Arena is "indistinguishable from a feature that was never built", and a wheel
already turning when somebody flips it off is still SETTLED a minute later by
the sweep — which is right, since leaving a draw stuck mid-spin is worse. But it
was also ANNOUNCED: reproduced against a real database, a decided spin with the
Arena off still wrote every person a "you won" / "the result is in"
notification. The moment somebody reaches for that switch is exactly when they
least want a company-wide message going out. `announce.js` now asks one shared
question first, and fails towards silence if the switch cannot be read.
Settling and announcing are two different acts and only the second is stopped.

**The round-up was the loudest thing in the building.** Counted rather than
guessed, on a six-spin day with the default three deadline offsets, one person
on the roster stood to receive: one "the day has started", six "a spin has
opened", up to eighteen deadline alarms, six "spin N landed on X", and one
end-of-day round-up. The result is the one Arena message nobody can act on — the
room watched the wheel land, the screen threw a full-page takeover, and the
winner already had their own message — so `arena_result` joined the challenge
bell in `notify.js`'s `STAFF_INAPP_TYPES`, which is the repo's one definition of
"in-app only". The bell still rings and the row is still written; only the email
is dropped. Everything actionable still emails.

**The busiest minute of the day was the expensive one.** Every arena frame asked
each open screen to refresh, and the board is nine queries. At half past ten
forty people check in inside two minutes, each check-in is a frame to every open
screen, and an immediate refetch on each turns one person's click into forty
board loads — sixteen hundred loads in a burst, on the same instance serving the
loan portal. Refreshes are now coalesced to one a second per screen with a
trailing call (the frame worth reacting to is usually the last in a burst). The
wheel is untouched: spinning, stopping and the landing come straight off the
stream and paint immediately.

**What the audit checked and found sound**, so the next person does not re-tread
it: the two routers sit behind `requireAuth` + `requireStaff` and the master
switch, and answer 404 rather than 403 when the game is off; a TPO broker's live
connection registers as `kind:'tpo'` and `publishToStaff` skips it, so nothing
from the game reaches an outside brokerage; the pipeline-sourced wheels select
the loan number, the amount and the borrower's name and NEVER the note buyer;
the random pick uses rejection sampling with no modulo bias and throws rather
than quietly returning zero; the stop button is checked against its holder and
claimed once by the database; a held draw stays checkable because a spin's
config is frozen from its first draw; the ticket ledger serialises on the entry
row and the streak on a per-person advisory lock; and the migrations converge
over two consecutive boots with an `adjustment` row present — db/586's narrower
re-add is recognised as superseded and skipped, and every index and column it
declares after that line survives. The AI helper's pace and daily cap are held
IN MEMORY, so with more than one web process they are per-process and a restart
resets them; that is named in the code as a deliberate trade for a helper's
throttle, and it is worth knowing rather than discovering.

---

## 10d. The booby prizes — a slice on the wheel, not a second roll

The owner asked for a joke on the PRIZE wheel — never on the people wheel —
that says, in effect, *"you have won the right to go and make another Elementix
call"*. Sometimes one on a wheel, sometimes two. Not every spin, and not exactly
every fourth: *"at least one out of four or one out of five should be something
like this."*

### The decision that mattered: a slice, not a second roll

The obvious build is a second coin toss — draw the prize, then roll again to see
whether the room is told a joke instead. It was rejected, and the reason is the
whole point of this engine. **The commitment is published before the wheel
turns**: the roster is frozen, hashed, and shown to the room, and anybody can
recompute the winner afterwards from the revealed seed. A second roll happens
after that fingerprint is taken, so the joke would be the one part of the
evening nobody could check — on a wheel whose entire promise is that everything
is checkable. It would also be a lie on screen: the wheel would visibly land on
the marketing budget and the room would be told something else.

So a joke is a REAL SLICE. `src/lib/arena/joke-prizes.js` injects it in
`freezeRoster`, **before** the hash, so the fingerprint covers it, the wheel
visibly lands on it, and `GET /api/arena/draws/:id/verify` proves it exactly as
it proves a real prize. Prize wheels only — `built.scope === 'prizes'` — so a
person can never be replaced by a punchline.

### The library

24 jokes across six families, so the same one is not heard twice in an hour:
`work` (go make the call), `already` ("you already had it"), `specific` (a named
Elementix action), `deadpan`, `meta` (about the wheel), and `job` (the day
itself, fondly). Each carries a label for the wheel and a one-line follow-through
for the takeover card. `pick()` prefers ones not yet used in the session.

### The ladder — how often, and why it is not a fixed number

A fixed 1-in-4 becomes predictable by the third spin, and the room stops
watching. So the share of the wheel the jokes hold RESPONDS to what the last few
prize wheels actually did:

| what just happened            | share of the wheel |
|-------------------------------|--------------------|
| ordinary                      | 22%                |
| a joke landed on the last spin| 8% — back right off |
| three clean spins in a row    | 32% — lean in       |
| four or more clean spins      | 45% — lean in hard  |
| ceiling, whatever the maths   | 45%                 |

`recentJokeOutcomes` reads only rosters that actually CARRIED a joke
(`EXISTS ... (c -> 'meta' ->> 'joke') = 'true'`). That filter is load-bearing and
was found by the control run of the new suite: without it the people wheel of a
two-wheel spin counted as a clean prize spin, so "back off after one lands" never
once fired on the real shape of an Elementix Day.

**Measured, not hoped** — 50,000 simulated spins per wheel size, feeding each
outcome back into the ladder:

| wheel      | a joke lands  | back-to-back (as % of hits) | longest clean run |
|------------|---------------|-----------------------------|-------------------|
| 3 prizes   | 1 in 4.0      | 8.6%                        | 22                |
| 6 prizes   | 1 in 4.0      | 8.7%                        | 21                |
| 12 prizes  | 1 in 4.0      | 7.7%                        | 21                |

That sits at the frequent edge of the owner's own band — they asked for *at
least* one in four or one in five, and this delivers one in four. The longest
clean run is a 50,000-spin tail event; a real day is ten to twenty spins.

A wheel needs two real prizes before it carries a joke at all and four before it
can carry two, so a booby prize can never turn a small wheel into a coin toss.

### The whole-number lesson — and how it was caught

The first working version put a fractional weight on the joke slice, and the
AUTO draw refused the wheel outright:

    pickWeighted: weight must be a non-negative whole number (got 0.5641…)

`fair.pickWeighted` takes only non-negative whole numbers. The HELD draw path
(`sliceAngles`/`sliceAt`) happens to tolerate fractions, so every test written
FOR the jokes passed while every automatic prize spin in the product was broken.
**It was caught by the pre-existing `test-arena-flow-db.js`, not by the new
suite** — which is the argument for running the whole set rather than the one you
just wrote.

The fix is structural rather than a rounding call: the WHOLE wheel is scaled up
onto an integer grid of at least 40 units before the share is worked out
(`k = ceil(40 / W)`), then the joke's total is split across its slices with the
remainder on the first. Multiplying every weight by the same whole number leaves
the relative odds untouched to the last digit, and nothing anywhere shows a raw
weight — the room is shown percentages — so the scale is invisible. Without it a
small wheel lands badly: two prizes and one joke is 33%, half again more than the
owner asked for. Measured after the fix, every wheel size from 2 to 33 prizes
lands between 21.6% and 22.6%.

### What a joke is worth, and what it can never become

`settleSpin` records a joke as its own `prize_kind = 'joke'` with
`value_cents = 0`, and the zero is FORCED rather than read from the library — no
wording anybody adds later can become money owed. That matters because the awards
export is a payroll document: prizes at these values are taxable wages, and a
booby prize is not one. `spinDecided` says *"The wheel says: …"* rather than
*"You won: …"*, and the full-screen takeover carries the follow-through line
instead of announcing a prize that is not one.

### Switches

`jokePrizes` is on by default and can be turned off for a whole session in Arena
settings, or per spin in the spin's own config (`config.jokePrizes`). `jokeShare`
overrides the ladder with a fixed share, capped by the same 45% ceiling.

### How it was proven

`scripts/test-arena-joke-prizes-pure.js` (60) — the library, the ladder, the
count rule, the whole-number guarantee at every wheel size, the share landing in
band, and the never-on-people rule. `scripts/test-arena-joke-prizes-db.js` (17) —
injection before the hash, verification still passing on a joke wheel, the
settle recording kind and zero, and the two switches. The whole-number fix was
mutation-proven: reverting the integer grid reproduces the exact
`pickWeighted` refusal above and turns `test-arena-flow-db.js` red (61 passed,
8 failed) with the unmutated control green on either side (90 passed, 0 failed).

---

## 10e. The owner's first live click-through — what broke, and what it taught

The owner opened the Arena and clicked through a real day. What follows is what
actually broke, each item reproduced before it was touched, in rough order of
how much it would have cost on the morning.

**THE GO-LIVE CRASH.** ArenaChallenges.jsx computed
`Number(board && board.countdownSeconds) >= 0 ? Number(board.countdownSeconds) : 10`.
`Number(null)` is `0`, and `0 >= 0` is true — so the "safe" branch was
unreachable, and `board.countdownSeconds` was read off `null` on the FIRST
render of every live session. The page ErrorBoundary replaced the whole Arena
with "Something went wrong", permanently, on every open. The fix is one line:
guard on `board &&` OUTSIDE the `Number()`. Mutation-proven in a real Chromium
harness. The lesson generalises: a truthiness guard INSIDE a Number() coercion
guards nothing.

**THE WRONG WINNER.** `settleSpin` took the FIRST revealed wheel carrying a
staff id — and on the four-wheel Early Bird, wheel 1 is the button lottery.
Measured, 5 runs out of 5: the award ledger, the payroll CSV, the winner email
and the recap all named the button-holder while the room watched wheel 3
announce someone else. Fixed by excluding stopHolders' `fromWheel` sources from
award candidacy; mutation-proven — reverting turns test-arena-fixes-db red at
23 passed, 2 failed.

**TICKETS NEVER CHANGED THE WHEEL.** The `'tickets'` weight branch read
`config.weights`, an admin-typed map that nothing populated. Measured: a person
with 9 chances and a person with 1 froze as identical slices. Fixed:
`freezeRoster` sums the `arena_tickets` ledger at freeze time into the ctx copy
of that map — 1 + chances, so everyone in the room keeps a base slice — and an
admin-typed entry still wins over the computed one. Mutation-proven.

**THE ROOM BAR READ "0 IN THE SPIN" ALL MORNING.** `/room` picked the check-in
spin by `seq DESC`, so the all-day Mega Spin always beat the Early Bird. It now
picks the live spin whose door shuts soonest.

**THE TEMPLATE BUTTON** left an orphan spin behind on every press and showed the
admin a raw Postgres constraint string. It is now routed through the idempotent
day-setup builder.

**THE ECONOMY WAS COSMETIC.** The every-5-chances nomination was displayed but
never consumed or enforced. Tier prize ceilings were displayed but never
applied. The 11:00 "38 minutes left" alarm was missing because the deadline
offsets were counted from the wrong end — [60,45,30,15,8] where the day needs
[53,38,23,8]. The check-in attestation was defined but never shown or recorded.
Reject-with-comment was supported by the server with no UI to reach it. All
fixed.

**THE TIMEZONE SIGN.** The Load-it button passed `+getTimezoneOffset()` where
the server wants minutes AHEAD of UTC — in New York every template time would
have shifted by twice the offset, putting the 10:30 Early Bird at 2:30 AM.

**THE DIALOG THAT CALLED SUCCESS A FAILURE.** The app-wide message box titled
every plain message "PILOT can't do that yet" unless the caller remembered to
pass `tone:'info'` — so "Saved." rendered under a failure headline. The default
is now neutral; the failure headline is opt-in.

**THE CSV LINK LOGGED THE ADMIN OUT.** A bare `<a href>` cannot carry the login
token, so the awards export dropped the admin onto raw JSON, signed out. It is
now an authenticated fetch-based download.

**ONE-PRESS DAY SETUP** (db/591 + day-setup.js + /setup-day): the whole
Elementix Day is built as a DRAFT with both plans inside, and it is safe to
press twice — unique indexes decide idempotency, not a read. Start stays a
human act. To answer the owner's direct question in print: nothing auto-starts
a session; the admin presses Start; everything after that — the 10:30 launch,
the reminders, the 11:38 lock, the challenges — is automatic.

**THE MEASURED CSS.** From a rendered Chromium audit with screenshots, not from
reading stylesheets: the challenge panel sat on top of the chat box and the
Send button on desktop, and buried the whole tab bar on a phone; the phone
stage resolved to 654px inside a 390px viewport (the bare `1fr` /
`min-content` trap) with `overflow-x: clip` hiding the evidence; and white text
on the bright gradients failed 4.5:1 contrast on every arena button. All fixed.

### The standing lessons

- Run the WHOLE suite, not just the tests you wrote for the change.
- A truthiness guard inside a coercion is no guard at all.
- A fixed floating panel must have its footprint reserved in the layout.
- A success dialog must never default to a failure title.
- Every authenticated file leaves the app via a fetch, never a bare href.

---

## 11. Sources

**Wheels and fairness** — wheelofnames.com + FAQ · pickerwheel.com ·
spinthewheel.app · random.org (list randomiser, HTTP API) · randompicker.com ·
provable.io/use-cases/sweepstakes-api · stake.com/provably-fair/implementation ·
github.com/CrazyTim/spin-wheel · npmjs.com/package/react-custom-roulette ·
robertpenner.com/easing · en.wikipedia.org/wiki/Alias_method ·
sweepwidget.com/docs/randomly-pick-a-winner · woobox.com/articles/how-to-pick-a-giveaway-winner ·
chain.link/education-hub/verifiable-random-function-vrf

**Sales gamification** — spinify.com (competition types; 6 call-blitz contest ideas) ·
salesscreen.com/blog/announcing-the-lottery-competition · hoopla.net/industries/finance ·
repcard.com/blog/sales-contest-ideas · fitsmallbusiness.com/sales-contest-ideas ·
biworldwide.com (move the middle) · sciencedirect.com (winner-take-all vs proportional-prize) ·
researchgate.net (Designing Sales Contests: Does the Prize Structure Matter) ·
ijungo.com (power hours) · loanofficerfreedom.com (call-blitz results) ·
yukaichou.com (leaderboard design) · incenteev.com (gamification mistakes)

**Live UX and realtime** — MDN Server-sent events · render.com/docs/websocket ·
postgresql.org/docs/current/sql-notify · oneuptime.com (SSE through nginx) ·
mux.com (HQ Trivia) · joshwcomeau.com (FLIP) · github.com/catdad/canvas-confetti ·
m3.material.io/styles/motion · developer.apple.com/design/human-interface-guidelines/foundations/motion ·
getstream.io (livestream chat UX)

**Challenges and attention** — duolingo.fandom.com (quests, XP boosts) ·
support.strava.com (segment leaderboards) · dev.twitch.tv/docs/api/predictions ·
uwb.edu/business/faculty/sophie-leroy/attention-residue · frontiersin.org (opportune
moments for task interruptions) · challengerunner.com (stopping challenge cheaters) ·
machinations.io (game economy inflation) · gamedeveloper.com (reward schedules) ·
nuovoeutile.it (Langer 1975, Illusion of Control)

**AI** — developers.openai.com/api/docs/guides/structured-outputs ·
developers.openai.com/api/docs/models · platform.claude.com/docs (structured outputs) ·
azure.microsoft.com/pricing/details/azure-openai · learn.microsoft.com (Foundry what's new) ·
docs.github.com (Copilot code suggestions) · grammarly.com/gmail ·
nvlpubs.nist.gov/nistpubs/ai/nist.ai.100-1.pdf · aembit.io (OWASP Top 10 for LLM) ·
consumerfinance.gov (AI chatbots issue spotlight) · sarasoueidan.com (ARIA live regions)
