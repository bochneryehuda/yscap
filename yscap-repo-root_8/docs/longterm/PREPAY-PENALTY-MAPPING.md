# Prepayment penalties — the mapping problem, and how to settle it

**STATUS: RESEARCH. NOT BUILT.** This is the blocker the owner named on the borrower-facing pricing
engine going live:

> *"Before we're putting it live I want to work on the prepayment penalty structures that we have,
> because we cannot offer for the borrower so many prepayment penalty structures. We need to map
> them out according to our own structures."*
> — the owner, 2026-08-30

Companion to `BORROWER-PRICING-MASTER-PLAN.md` (Phase 5, the gate on Phase 4).

---

## 1. The problem in one paragraph

Lender Price will accept **19 different prepayment structures**, independent of the term, and each
investor supports a different subset of them at a different price. Our own closed book uses **7
terms and 8 types** — and describes them in a *different vocabulary* from the one Lender Price
takes. Putting the vendor's 19 in front of a borrower would offer structures we do not actually
sell, in words nobody outside the industry reads, with no guarantee any given investor honours the
choice. So the borrower needs a small menu of **our** structures, and each of ours needs a proven
translation into what each investor is actually being asked for.

**None of that translation exists today, and it cannot be guessed.**

---

## 2. What Lender Price takes

From `src/longterm/lenderprice/field-registry.js`, confirmed live 2026-08-16 and guarded by
`scripts/test-lt-lp-menu-enums-pure.js` (115 checks):

**Two independent fields.** `PrepayTerm` (the length) and `PrePayment_Plan_Type` (the structure).
They are independent — a structure may be supplied alone, and the two do not validate against each
other.

| Term (`PrepayTerm`) | Structure (`PrePayment_Plan_Type`) — 19 values |
|---|---|
| `"None"` (0 → the *No PPP* special mortgage option) | `Standard`, **No Prepay** *(token is `null` — distinct from term "None")* |
| `"12 Months"`, `"24 Months"`, `"36 Months"`, `"48 Months"`, `"60 Months"` … | `Fixed5`, `Fixed4`, `Fixed3`, `Fixed2`, `Fixed1` |
| | `54333`, `54321`, `5433`, `5432`, `4321`, `543`, `321`, `54`, `21` |
| | `6MosInt`, `StepDown`, `Other` |

**Our default when a caller says nothing:** `PrepayTerm "60 Months"` + `PrePayment_Plan_Type
"Standard"` + the `5 Yr PPP` special mortgage option. That default was itself a measured fix — an
omitted prepay used to inherit the live foundation's `"36 Months"` with no PPP option, *"a
three-year prepay on a book quoted at five, silently, because a quote that omits prepay is the
ordinary case"* (`LENDER-PRICE-PARITY-STATUS.md`, §35.3/§36.6).

**An unrecognised structure is 422'd, never defaulted** (`invalid_prepay_structure`). That
fail-closed behaviour is the thing that makes the mapping below safe to build on.

---

## 3. What our own book actually uses — measured

From the 2026-08-14 census of the live Encompass tenant (`research-exports/03-dropdown-options.csv`,
inferred from live data — these are not declared dropdowns, they are what the loans hold).

### `CX.PPPTERM` — 296 long-term loans carry a term

| Value | Loans | Share |
|---|---:|---:|
| **5 Year** | 120 | 40.5% |
| **3 Year** | 105 | 35.5% |
| **No PPP** | 40 | 13.5% |
| 1 Year | 16 | 5.4% |
| 2 Year | 11 | 3.7% |
| 4 Year | 2 | 0.7% |
| 6 Months | 2 | 0.7% |

**Three values — 5 Year, 3 Year, No PPP — are 89.5% of the book.**

### `CX.PPPTYPE` — 291 long-term loans carry a type

| Value | Loans | Share |
|---|---:|---:|
| **Soft Declining** | 150 | 51.5% |
| **No PPP** | 39 | 13.4% |
| **6 Mo. Intrest** *(the tenant's own spelling)* | 35 | 12.0% |
| **Hard Declining** | 33 | 11.3% |
| **5% Fixed** | 27 | 9.3% |
| 2% Fixed | 3 | 1.0% |
| 3% Fixed | 2 | 0.7% |
| 1% Fixed PHH Teir 2 | 2 | 0.7% |

**Five values are 97.5% of the book.** The last three are 7 loans between them, and one of them —
`1% Fixed PHH Teir 2` — is an investor-specific tier with a typo in its name, which is a small
demonstration of why a hand-kept structure list rots and why the mapping below has to be generated
against measurement rather than typed from memory.

---

## 4. The finding: the two systems describe prepayment along different axes

This is the actual obstacle, and it is not the count of options.

| | Lender Price | Our book (Encompass) |
|---|---|---|
| **Length** | `PrepayTerm` in months | `CX.PPPTERM` in years |
| **What it charges** | A schedule or a flat rate — `54321`, `Fixed5`, `6MosInt` | Partly: `5% Fixed`, `6 Mo. Interest` |
| **Soft vs hard** | **Not expressible at all** | `Soft Declining` vs `Hard Declining` — **63% of our typed book** |

Three consequences, each of which has to be settled before a borrower is shown a menu:

### 4.1 "Soft vs hard" is the borrower's real question, and we are not asking it

A **soft** prepay is waived on a sale and charged only on a refinance. A **hard** prepay is charged
on any payoff. To a real-estate investor deciding whether they can flip this property in eighteen
months, that distinction is worth more than the schedule — and it is the majority of our own book
(150 soft against 33 hard).

**Lender Price's captured registry has no field for it.** So today, every search we run leaves it
unspecified and takes whatever each investor's program means by default. That is tolerable on a
staff board where a human knows to ask. **It is not tolerable on a term sheet a borrower keeps**,
because the sheet would imply a term we never actually specified.

This is **OQ-8a, and it is the question that must be answered first**: is soft/hard a Lender Price
field we have not captured, an attribute of the *program* (so that "Diamond — 30yr Fixed" is
inherently soft and a different program is hard), or something set after pricing at lock? The probe
in §7 is designed to answer it, and no borrower-facing prepay menu should ship until it has.

### 4.2 "Standard" means a different thing per investor

`Standard` is the token our default sends, and it is by definition whatever that investor's standard
declining schedule is. For one investor that may be 5/4/3/2/1; for another, 5% flat for three years.

**So today's default sends one word that means twenty different things**, and the borrower's screen
would be printing one sentence for all of them. On the staff board this is survivable — the officer
reads the program's own terms. On a term sheet it is a misstatement.

The mapping in §5 exists precisely to replace `Standard` with a structure we have *named*, per
investor.

### 4.3 Which investor supports which structure is unknown to us

Nothing in this repository records it. `PREPAY_STRUCTURES` is a list of what the *vendor's field*
accepts, not of what any *investor* honours. Sending `54333` to an investor who does not offer it
produces either no quote (fine — a silent narrowing of the borrower's board) or a quote at that
investor's own substituted structure (not fine — a price for terms the borrower will not get).

Which of those two happens is **measurable and has not been measured.** §7.

---

## 5. The proposed YS menu

**The design rule:** the staff board keeps all 19 — an officer structuring an unusual deal needs
them, and nothing about this reduces what staff may ask for. **The reduction is borrower-facing
only**, which is exactly what the owner asked for.

Five options, chosen to cover the measured book, plus one modifier:

| # | The borrower sees | Term | Structure | Covers |
|---|---|---|---|---|
| 1 | **No prepayment penalty** | `None` | `No Prepay` (`null`) | 13.5% of the book |
| 2 | **1 year** | `12 Months` | per-investor (§6) | 5.4% |
| 3 | **3-year step-down** — 3%, 2%, 1% | `36 Months` | `321` | part of the 35.5% at 3 years |
| 4 | **5-year step-down** — 5%, 4%, 3%, 2%, 1% | `60 Months` | `54321` | part of the 40.5% at 5 years |
| 5 | **5-year fixed** — 5% of the balance for five years | `60 Months` | `Fixed5` | 9.3% |
| — | **Soft** *(default)* / **Hard** — a modifier on 2–5, offered only where §7 proves it is selectable | | | 63% of the typed book |

Options 1, 3, 4 and 5 alone reach roughly **90%** of the terms and **86%** of the types in the live
book. The tail — 2 Year, 4 Year, 6 Months, `2% Fixed`, `3% Fixed`, `1% Fixed PHH Tier 2` — is 20-odd
loans and stays an **officer-structured** deal: the borrower does not see it, and an officer who
needs it prices it on the staff board and issues the term sheet themselves. That is the right place
for the long tail, because each of those loans had a conversation behind it.

**`6 Mo. Interest` is the judgement call** (OQ-8b). It is 12% of our typed book — bigger than
`5% Fixed` — but it is the structure hardest to state in one borrower-readable line, and it
interacts with the term differently from every other option. Recommend: **include it as option 6**
if §7 shows it is broadly supported, worded as *"six months' interest if you pay off during the
penalty period"*. Otherwise leave it to the officer.

---

## 6. How the mapping is stored and enforced

### `src/longterm/prepay-map.js` — LT's own, pure, no database

```js
// One YS option → what each investor is actually asked for.
{
  key: 'ys.5yr.stepdown',
  label: '5-year step-down',
  borrowerSentence: '5% in year 1, then 4%, 3%, 2%, 1%',
  term: '60 Months',
  byInvestor: {
    deephaven: { structure: '54321', soft: true,  verifiedAt: '2026-…', evidence: 'probe run …' },
    verus:     { structure: 'Standard', soft: true, verifiedAt: '2026-…', evidence: '…' },
    // an investor with no entry is NOT offered this option
  },
}
```

Five properties, each load-bearing:

1. **An investor with no entry does not quote this option to a borrower.** Fail closed. The board
   silently carries fewer programs for that choice; nothing is guessed and nothing is substituted.
   This is the same posture `investorPrograms` already takes on the white-label sheet — *"an
   investor with no white-label name has NO consumer label — `null`, never a guess."*
2. **Every entry carries its evidence and the date it was verified.** A mapping without provenance
   is a memory, and this file decides what a borrower is promised.
3. **It is generated from the probe (§7), not typed.** `AGENTS.md` §1a: *"generate rather than
   hand-maintain."* The probe writes the file; a human reviews the diff.
4. **`Standard` may appear as a target, but only with evidence** that this investor's Standard *is*
   the schedule we are naming. Sending `Standard` because we do not know is exactly the failure
   §4.2 describes.
5. **A stale entry expires.** An entry older than `prepay.mappingMaxAgeDays` (setting, default 90)
   stops being offered to borrowers and is reported to staff. Rate sheets change; a mapping verified
   fourteen months ago is a claim nobody has checked.

### The guard

`scripts/test-lt-prepay-map-pure.js`:
- every `structure` is a token `mapPrepayStructure` accepts (so the map can never 422 the search);
- every `key` has a `borrowerSentence` and every sentence is scrub-safe;
- an investor absent from an option's `byInvestor` is provably not offered it;
- an expired entry is provably withheld.

---

## 7. What must be measured before any of this is decided

**The probe: `scripts/lt-probe-prepay-support.js`.** It exists to answer three questions nobody in
this repository can answer today, and it answers them by pricing, not by asking.

For the benchmark scenario (`PRICING-RATE-MOVEMENT-REPORTS.md` §3), for each of the 19 structures ×
{12, 24, 36, 60 months, None}:

1. Run one `searchRaw`.
2. Record, per investor × program: did it quote, and at what price at the anchor rate.
3. Write a matrix.

What the matrix tells us, and it is exactly the three unknowns:

| Question | How the matrix answers it |
|---|---|
| **Which investors honour which structure** | A structure the investor does not support either drops the program from the answer, or returns it at a price **identical to another structure** — which is the fingerprint of a silent substitution and the single most important thing to find |
| **What each investor's `Standard` actually is** | Price `Standard` against all 18 named structures. The one it matches to the milli-point is what its Standard is |
| **Whether soft/hard is expressible** | If the price never moves across every combination we can send, soft/hard is not a search input — it is a program attribute or a lock-time field, and §4.1 is settled the other way |

**Cost:** ~95 searches at ~12 seconds each — well under an hour, run once, off-peak. This is a cheap
measurement standing in front of an expensive guess, and it is the piece of work that unblocks
Phase 4.

**It must be re-run on a cadence** (`prepay.probeCadenceDays`, default 90) because the answer is a
fact about live rate sheets, not a constant.

---

## 8. How a prepayment term is worded to a borrower

Per `BORROWER-PRICING-LANGUAGE.md` §8. Never the vendor token; always a sentence:

| YS option | On screen and on the term sheet |
|---|---|
| No prepayment penalty | **No prepayment penalty** |
| 1 year | **1-year prepayment penalty** — 1% of the balance in year 1 *(subject to §7)* |
| 3-year step-down | **3-year step-down** — 3% in year 1, then 2%, then 1% |
| 5-year step-down | **5-year step-down** — 5% in year 1, then 4%, 3%, 2%, 1% |
| 5-year fixed | **5-year fixed** — 5% of the balance if you pay off within five years |
| Soft *(modifier)* | **Waived if you sell.** Applies only if you refinance |
| Hard *(modifier)* | **Applies to any payoff**, including a sale |

And one clause on the field, once, never per option: *"applies if you sell or refinance during the
term."*

The soft/hard sentence is the one worth getting exactly right, because it is the sentence an
investor will act on — and it is why §4.1 has to be settled before this menu ships.

---

## 9. Open questions

| # | Question | Recommendation |
|---|---|---|
| **OQ-8a** | Is soft vs hard a Lender Price input we have not captured, a program attribute, or a lock-time field? | **Run the probe (§7) before deciding anything else here.** It is the gate |
| **OQ-8b** | Is `6 Mo. Interest` on the borrower's menu? It is 12% of our typed book | **Yes, if §7 shows broad support** — it is bigger than `5% Fixed`, which is already on |
| OQ-8c | Does the borrower choose a prepay at all, or does the board show the standard 5-year and let them ask? | **They choose.** It changes price materially and an experienced investor knows what they want |
| OQ-8d | Do we show the *price difference between prepay choices* — "no prepay costs you 1.250 points"? | **Yes.** It is the most useful comparison on the board and workflow A (`TERM-SHEETS-AND-COMPARISON.md` §7) already renders it. It is also, in the owner's own words, one of the comparisons he asked for |
| OQ-8e | What happens on the borrower's board when their prepay choice leaves only two investors quoting? | Show the two. Say nothing about the rest (master plan §3.3) |
