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
