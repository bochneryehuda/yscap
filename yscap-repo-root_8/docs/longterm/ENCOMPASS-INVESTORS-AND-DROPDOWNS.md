# Investors and dropdowns — the mapping layer

**Long-Term (LT). Measured against all 772 loans in the live tenant, 2026-08-14.
Read-only.** Behind `src/longterm/encompass/investors.js` and `dropdowns.js`.

Nothing can be matched, rolled up or pushed to ClickUp on a value that is spelled
several ways. This is the layer that turns what staff typed into something a machine
can join on.

---

## 1. The investor name problem, measured

The investor is typed by hand, in more than one place. Across 772 loans the two
free-text investor fields hold **151 distinct spellings** for roughly **30 companies**:

| Field | Label | Loans | Distinct spellings |
|---|---|---:|---:|
| `VEND.X263` | File Contacts Investor Name | 408 | 68 |
| `CX.WHICHINVESTOR` | WHICH INVESTOR | 451 | 83 |

The variation is every kind at once:

- **Case** — `Deephaven` / `deephaven` / `DEEPHAVEN` / `DeepHaven`
- **Spacing** — `Oaktree` / `Oak Tree` / `OakTree` / `OAKTREE`
- **Long vs short** — `Deephaven Mortgage LLC` vs `Deephaven`; `American Heritage Lending` vs `AHL`
- **Short codes** — `AD`, `AHL`, `BPL`, `CF`, `PMTPO`
- **Typos** — `Deepahven`, `Deephven`, `Deepheaven`, `Deephavan`, `deep heaven`, `Fidellis`, `fedelis`, `emcep`, `Blulake`
- **Paste accidents** — `814267\tConstructive Capital BPL (Constructive Capital BPL)`, and one value that is its own label pasted twice
- **Not-a-company** — `---`, `--`, `t`, `The Lender`

### The registry

`investors.js` holds **33 canonical investors** with **117 recorded spellings**, and a
resolver that does not depend on the list being complete:

```js
resolve('Deepahven')  // → { key: 'deephaven', label: 'Deephaven Mortgage LLC', match: 'exact' }
resolve('OAK TREE')   // → { key: 'oaktree',   label: 'Oaktree Funding Corp',   match: 'normal' }
sameInvestor('EmCap', 'EMCAP Financial')  // → true
sameInvestor('---', '--')                 // → false  (junk never equals junk)
resolve('Wells Fargo')                    // → { key: null, match: 'none' }
```

Normalization strips a pasted reference number, a trailing `(CODE)`, legal suffixes
(`LLC`, `Corp`, `Mortgage`, `Funding`, `Capital`, `Lending`…), punctuation and case.
Anything still unrecognized comes back **unresolved** — the resolver never guesses.

**Result: 852 of 859 typed values resolve (99.2%).** The other 7 are the placeholders,
correctly identified as non-values rather than forced into a company.

### Never compare investor names as strings

Compare `resolve(x).key`, or call `sameInvestor(a, b)`.

### The five that overlap with the short-term side

`Fidelis`, `RCN Capital`, `CorrFirst`, `Blue Lake Capital` and `EMCAP Financial` are
also note buyers on the RTL side, where the canonical labels are `Fidelis`,
`RCN Capital`, `CorrFirst`, `Blue Lake`, `EMCAP`. The other ~28 are long-term only —
RTL has never heard of Deephaven, Oaktree, Champions, A&D, Acra, NQM, Onslow Bay and
the rest.

Each such entry carries `alsoOnRtl` as an **observation for a human mapping both
products onto one ClickUp option**. It is a note, not a shared list: no code, table or
mapping crosses between the products. **If you want ONE canonical investor list shared
by both sides, that is a product crossing and needs written authorization first.**

---

## 2. Two investor fields, and they disagree

Of the 490 long-term loans:

| | Loans |
|---|---:|
| Both fields filled | 220 |
| Only `VEND.X263` | 128 |
| Only `CX.WHICHINVESTOR` | 60 |
| **Neither** | **82** |

Where both are filled, **208 of 220 agree** once canonicalized (94.5%). The 12 that
disagree split into two groups:

**Three are junk on both sides** — `---` vs `--`, `The Lender` vs `The lender`.

**Nine name two different companies**, and they are not all errors:

| Loan | `VEND.X263` | `CX.WHICHINVESTOR` |
|---|---|---|
| YSCAP258134603 | Deephaven Mortgage LLC | Oak Tree |
| YSCAP258134601 | Deephaven Mortgage LLC | Oak Tree |
| YSCAP258134400 | Oaktree | Deephaven |
| YSCAP258134427 | Champions Funding | NQM Funding |
| YSCAP202526124 | Champions Funding | A&D Mortgage |
| YSCAP258134553 | Deepahven | NQM |
| YSCAP258134412 | Amerihome | PHH |
| YSCAP258134742 | Cornerstone Servicing | Oak Tree |
| YSCAP258134543 | NPB – Operations Center | Foundation |

Look at the last three. `Amerihome`, `PHH`, `Cornerstone Servicing` — and `Selene
Finance LP` in the address field — are **servicers, not investors**. So `VEND.X263`
sometimes holds **who services the loan after purchase** while `CX.WHICHINVESTOR`
holds **who bought it**. That is a modelling gap, not a typo: we need separate places
for *investor* and *servicer*, and today there is only one contact record doing both
jobs.

The genuine conflicts are the first six, which are worth an owner's eyes.

### A better signal than the typed name

`VEND.X273` (Investor Email) is filled on 183 long-term files, and the **domain**
identifies the investor unambiguously — `deephavenmortgage.com`, `oaktreefunding.com`.
It confirms the typed name on **131 of 183**. Worth using as a cross-check whenever
the typed name is ambiguous or missing.

### Funding channel is a different question

`CX.TABLEFUNDER` answers *how* the loan is funded, not *who* buys it. It is a real
dropdown with 10 values: Correspondent (270), Table Funding (147), Non Delegated
Correspondent (53), Direct RTL / W TPR (15), Direct RTL / Delegate (10), Brokering out
(5), Wholesale (4), Wholesale Out (4), Delegate correspondent / Evolve (3), Delegate
correspondent / In House (1). Keep the two concepts apart.

---

## 3. Every dropdown, and what is really in it

**1,006 constrained fields** carry data in this tenant. `dropdowns.js` gives, per
field, the values Encompass **declares** and the values actually **used** on long-term
files.

### Two things to know before mapping anything to ClickUp

**Custom dropdowns do not publish their options.** The API returns option lists for
**standard** fields only. A custom field declared `DROPDOWNLIST` comes back with its
format and nothing else. For those **44** fields the option set here is **inferred
from observed data** and every entry is flagged `inferred: true`. It is a floor, not a
ceiling — an option nobody has picked yet is invisible to us. The complete list has to
come from Encompass Settings, or from the admin settings endpoints once the client
scope is widened (see `ENCOMPASS-ACCESS-AND-PERSONA.md`).

**The same field answers differently depending on how you ask.** A Y/N field declares
its options as `Y` and `N` — and the loan JSON returns `true` / `false`. This affects
**614** fields. Not a defect, but a mapping that assumes one representation silently
drops the other. Use `normalizeValue()`.

### Where the declared set genuinely does not match reality

Of 630 fields whose observed values fall outside their declared set, 616 are the two
harmless shapes above. **Fourteen are real**, and five of those matter:

| Field | Declared | Actually stored | Why it matters |
|---|---|---|---|
| **`2867` / `MORNET.X67`** Loan Doc Type | `NoDocumentation`, `FullDocumentation`, … | `NoDocumentation` **and `DSCR`** | `DSCR` is not a valid doc-type code. The tenant's **base Milestone Completion rule** (the one carrying the 117-field long-term set) is conditioned on Doc Type = "No Documentation" — so a file saying `DSCR` never switches those requirements on. **486 loans.** |
| **`33`** Manner Held | `Joint tenants`, `Single man`, … | `KJ BH LLC`, `BASS REALTY TRENTON LLC`, `Bricks & Stones LLC`, `Sole Ownership` | Asks *how* title is held; staff type *who* holds it. Natural on DSCR where title is vested in an LLC — but the field is now a vesting-entity name half the time. |
| **`2356` / `2358` / `TSUM.PropertyFormType`** Appraisal type | `URAR`, `2055 Drive-by`, … | `FNMA-1004-v2005`, `FNMA-1025-v2005` | The tenant stores the MISMO **form code**, which is *more* precise than the declared list. 1004 = single family; **1025 = 2–4 unit income property** — the one a multi-unit DSCR file needs. |
| **`MS.STATUS`** Current milestone | Encompass's stock 7 | The tenant's own 19 | Drive milestone logic from `GET /v3/settings/milestones`, never from this field's declared options. |
| **`299`** Refinance purpose | 6 values | also `NoCashOutOther` | A real newer-URLA value the schema copy has not caught up with. Treat as rate-and-term. |

---

## 4. How this maps to ClickUp

The direction the owner set: **Encompass is the source, our system is the bridge and
the workflow, ClickUp receives.** Nothing is typed into ClickUp by hand.

For each field we intend to push:

1. **Resolve the value** to a canonical identity — `investors.resolve()` for investor
   names, `dropdowns.normalizeValue()` for Y/N vs true/false.
2. **Check it against the option set** — `dropdowns.options(fieldId)`. If the option
   set is `inferred`, a value outside it is *not* necessarily invalid; it may just be
   one nobody has used yet. Do not reject on an inferred set.
3. **Map to the ClickUp option** by canonical key, never by display string, so a
   spelling difference on either side never reads as a change.
4. **Leave unresolved values alone.** An unresolved investor name must not be pushed
   as a guess; surface it for a human instead.

Point 4 is the rule that keeps this honest: the resolver returns `match: 'none'` and
`key: null` rather than picking the closest company, so a name we have never seen
becomes a question rather than a wrong answer.
