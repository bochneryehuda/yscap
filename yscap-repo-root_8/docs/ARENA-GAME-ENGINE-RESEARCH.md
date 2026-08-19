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
- **`scripts/test-arena-play-db.js`** — 81 assertions covering Phase 2.
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
