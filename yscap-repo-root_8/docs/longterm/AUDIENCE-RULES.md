# Who is allowed to see what — and the one thing nobody outside may see

**Long-Term (LT). HARD RULE, owner-directed 2026-08-14.**
Behind `src/longterm/audience.js`; guarded by `scripts/test-lt-investor-block.js`.

---

## The rule

> **"You also need to make sure that you put a hard rule to block the investor name.
> The client should not be able to see the investor name. Never ever! Not borrowers,
> not TPOs, only internal staff."**
> — the owner, 2026-08-14

The investor / capital provider who buys a long-term loan is **internal knowledge**. It
never reaches a borrower and it never reaches a broker, in any form:

- not a field, not a label, not a column, not a filter option
- not a document name, not a document's contents
- not an email subject or body, not a PDF, not an export
- not an error message, not a tooltip, not a log line a client can see
- **not the name, not the contact details, not their loan number, not the funding
  channel** — the channel names *how* the loan is funded, which implies *who*

There are three audiences and exactly one of them may see it:

| Audience | Who | May see the investor |
|---|---|---|
| `internal` | our own staff | **yes** |
| `borrower` | the person on the loan | **no** |
| `tpo` | a broker's staff | **no** |

**It fails closed.** Any audience that is not exactly `internal` — including one nobody
has thought of yet, an empty string, or a missing value — is treated as a client. The
expensive mistake is handing internal data to an unrecognised caller.

---

## Why this is code and not just a paragraph

The investor name is typed by hand, in more than one place, and it is spelled **151
different ways** across the live book: `Deephaven`, `Deepahven`, `deep heaven`,
`OAK TREE`, `Oaktree`, `AHL`, `BPL`, `emcep`.

A rule that says *"don't show the investor"* is unenforceable against that. A check
like `name !== 'Deephaven'` passes a document titled `Deepahven approval.pdf` straight
through to a borrower.

So the block is built on **the same registry that resolves those spellings**
(`encompass/investors.js`) — the only thing that can actually catch them all. Add a new
investor there and it is blocked everywhere, automatically. The test proves that by
sweeping **every one of the 150 recorded spellings** through five sentence shapes and
failing if a single one survives.

---

## The two defences, in order

**1. Don't send it.** The primary defence is always that a client payload is *built for
the client* — the column is never selected, the value never enters the object. Ask
`maySeeField(audience, fieldId)` before a mapping puts a value on a payload, and
`stripInternalOnly(obj, audience)` as a belt on the way out.

The six Encompass fields that carry it:

| Field | What |
|---|---|
| `CX.WHICHINVESTOR` | the shorthand name, typed early |
| `VEND.X263` | the accurate name, added later |
| `VEND.X276` | **the investor's own loan number** |
| `VEND.X273` | the investor's email — its *domain* names them |
| `VEND.X267` | the investor's ZIP |
| `CX.TABLEFUNDER` | the funding channel |

…and the columns on our side, all on `lt_loan_investors`.

**2. Scrub free text.** For anything a *human typed* that a client will read — a
condition body, a comment, a document filename, an email — call
`scrubInvestorNames(text, audience)`. It replaces any known spelling with
**"our capital partner"**, wording chosen to say nothing about who they are, not even
their role, so it invites no follow-up question.

```js
const audience = require('src/longterm/audience');

audience.maySeeField('borrower', 'VEND.X276')            // → false
audience.scrubInvestorNames('Sent to OAK TREE', 'tpo')   // → 'Sent to our capital partner'
audience.scrubInvestorNames('Sent to OAK TREE', 'internal') // → unchanged
audience.stripInternalOnly(payload, 'borrower')          // → payload minus every internal key
```

---

## The judgement calls, written down so they stay decisions

**Matching is boundary-based, not word-based.** `Deephaven_approval.pdf` and
`OAKTREE-letter.pdf` must both be caught, so boundaries are alphanumeric rather than
`\b`. Whitespace inside a name matches any run of it, so `Oak  Tree` and a name broken
across a line are caught too.

**Longest spelling first.** `Deephaven Mortgage LLC` must be replaced before
`Deephaven`, or the shorter match leaves `Mortgage LLC` stranded and the reader can
still infer the company.

**Only two letter codes are upper-case-only: `AD` and `CF`.** `ad` is an English word
and `cf.` is the ordinary abbreviation for *compare*, so those two match only as a
standalone capital word — otherwise "we added the road" would be redacted. Every other
code (`bpl`, `ahl`, `phh`, `npb`, `roc`, `nqm`) is not English in any case and matches
case-insensitively. **Narrow that list; never widen it** — a code moved into it becomes
invisible in lower case, which is exactly the leak the test caught during development.

**Only one English word is treated as ambiguous: `foundation`.** A loan condition says
"photos of the foundation" and "foundation repair" constantly, so it matches only when
capitalised (`Foundation`, `FOUNDATION`) — how a company name is written — and its
multi-word form `Foundation Mortgage` always matches.

**And the tradeoff we deliberately took:** `champions`, `dominion` and `arc` are
English words *and* recorded investor spellings — recorded in **lower case**, meaning a
staffer really typed them that way on a real file. A recorded spelling the scrubber
cannot see is a leak, so those are caught in every case and the occasional mangled
sentence is accepted. **A leak is unacceptable; an odd sentence is not.**

**Accepted residual:** a sentence *starting* with `Foundation` in its ordinary sense
("Foundation repair is required") is redacted. That is the cheap direction to be wrong
in.

---

## What this does NOT restrict

Our own people see everything. The investor loan number in particular **must survive**
— it is the only shared key between our file and the investor's system, it is issued
once, and nothing can regenerate it. Surviving internally and being hidden from a
client are not in tension, and the test asserts both at once.

---

## When you add a surface

1. Decide its audience explicitly. Do not infer it from a route name.
2. Build the payload *for* that audience. Never take an internal object and delete keys.
3. Run any human-typed text through `scrubInvestorNames`.
4. If you add a new secret, add it to `INTERNAL_ONLY` in `audience.js` — one entry, and
   every consumer inherits it.

**Never re-implement this check.** A second copy is how the two drift, and the one that
drifts is the one that leaks.

---

## The list is no longer only the registry (2026-09-02)

`audience.js` used to build its blocked spellings from `encompass/investors.js` alone — a
list in **code**. Since the combined engine let somebody **add an investor by hand**
(`pricing.customInvestors`, see `src/longterm/loannex/README.md` item 12), the block is
built from the **effective roster**: the code registry with that stored map laid over it,
combined in exactly one place, `pricing/investor-roster.js`.

That change moves part of a hard rule from code into a **setting**, which is a different
kind of thing, and three properties are what make it safe.

**1. The block is fed by the COMPANY scope alone, and a read can only ever widen it.**
`lt_settings` is keyed on `(scope, key)`. A per-user read answers the *declared default* —
an empty map — for every key that person has never set. When the settings store ran its
`applyOnLoad` hooks for every scope, a read of somebody's personal settings handed that
empty map to the block and **switched the investor-name rule off for the whole process**;
the company-scope cache hit afterwards did not re-assert it, so it stayed off until the
cache entry expired. `routes/me.js`, `routes/settings.js` and `routes/term-sheet.js` each
read both scopes in one `Promise.all`, and the term-sheet request goes straight on to build
a borrower's document. A term sheet naming a real investor was accepted and printed. The
store now runs those hooks for the company scope **only**, and re-asserts on a cache hit.
*Nothing but a company-scope read may narrow this list.*

**2. Something must TELL the block before the first request, because the surfaces that need
it never read settings.** A borrower's own conditions (`routes/my-conditions.js`,
`conditions/read.js`), the term-sheet snapshot and the PDF all scrub without ever asking for
a setting. Nothing warmed the map, so the first borrower to open their conditions after a
deploy was read to by a block that had never heard of the hand-added investors. The
Long-Term router now calls `settingsStore.warm()` when it is built — once per process,
before any request.

**3. An outage may never SHRINK the list.** The store's standing posture is "fail to our
behaviour": on an unreadable database it answers the declared defaults. That is right for a
value with a sensible default and exactly wrong for this one, where the empty state means
*block fewer names* — a database blip would remove a protection. A degraded read now keeps
the last known map and records that it may be stale (`applyOnUnreadable`), and
`audience.summary().customInvestors` tells apart **none stored**, **not loaded yet** and
**degraded**. All three used to report `0` and look identical.

### What a client-safe name has to survive, on the way in AND the way out

A hand-added investor's *white label* is typed by a person, and it is the one name a client
may read. Two checks, in **one** routine (`investor-roster.whiteLabelProblem`), run by both
the write door and the read:

- it may not be a name that already means somebody — a recorded registry spelling, a name on
  the white-label sheet, or another hand-added investor's;
- it must **survive this scrub**, proven by running it, not by consulting a list.

The door refuses the whole map (a person is at a form and can fix it); the read **drops** the
name and says so (nobody is there to ask), leaving the investor priceable but with no name a
client may see. Running the rule on only one side of a store is not a rule: a white label of
"⟨a registry investor⟩ Group" was once refused at the door, kept on read, and reached a
borrower as "our capital partner Group".

### The staleness window — a real exposure, bounded, not eliminated

A save applies immediately **in the process that made it**. Every other process learns on
its next company read.

An earlier version of this section said that window "is not a leak in either direction".
**That was wrong, and only half-checked.** It reasoned about the *board* — rule 10's second
defence, the payload — and never about the *first* defence, the free-text scrub. A re-audit
reproduced the miss across two processes:

- the **board** half does hold: a process that has not heard of an investor has no white
  label for it either, so its rows resolve to nobody and stay off the board rather than
  being quoted under a name; and an investor *removed* lingers in the block, which blocks
  more, not less;
- the **free-text** half does not. A process whose cache predates the save answers
  `mentionsInvestor(...) = false` for the new investor's real name, `resolveProgramName`
  accepts that name as a manual program name, and **a staff-typed condition body is served
  to a borrower unredacted** — for the whole window.

So it is a genuine rule-10 exposure, for one class of text, for a bounded time after an
admin adds an investor. What has been done about it:

- `settingsStore.keepWarm()` re-reads the company settings on its own interval —
  `LT_SETTINGS_REFRESH_MS`, **default 15s** — independently of request traffic and
  deliberately shorter than the read cache's `LT_SETTINGS_TTL_MS` (60s). That interval,
  not the TTL, is the bound.
- `settingsStore.ensureWarm()` is mounted on the Long-Term router *and* on the borrower
  mount (which `server.js` mounts directly and which therefore runs nothing else here), so
  the *first-request* case — a process that has never read the settings at all — is closed
  outright rather than merely shortened.

Closing the remaining window properly needs processes to be told when a write happens.
There is no such channel in this deployment: a shorter interval trades database reads for
exposure, and the honest statement is the one above rather than a number chosen to sound
small. **If you add a notification channel, this is the first thing to hang off it.**
