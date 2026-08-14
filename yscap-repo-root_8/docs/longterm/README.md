# Long-Term (LT) — the research, and where all of it lives

**Start here.** This is the index to everything learned about the long-term (DSCR)
side of Encompass, where each piece is kept, and how to reach it — whether you are a
person opening a spreadsheet, an agent reading code, or a browser hitting an API.

Everything below was **measured against the live Encompass tenant on 2026-08-14**:
all 772 loans, 490 of them long-term. Nothing is remembered, assumed or copied from
documentation — where a number appears, it was recomputed from the loans themselves.

**All of it is READ-ONLY.** Encompass is one-way to us: we read as much as we want and
never write. That is enforced by the CI gate `scripts/check-encompass-readonly.js`
and the authorization pad `docs/ENCOMPASS-WRITE-AUTHORIZATIONS.md`.

---

## 1. If you just want to look at the data

**`research-exports/`** — eleven CSVs, openable in Excel by anyone, no code needed.
Regenerate with `node scripts/lt-export-field-research.js`; never hand-edit one.

| File | Rows | What it answers |
|---|---:|---|
| `01-every-field.csv` | 3,783 | **Every field**: id, label, the type Encompass *declares*, the types the data *actually holds*, JSON path, fill rate on long-term vs short-term, distinct values, min/quartiles/max, and the milestone it first appears at |
| `02-field-fill-by-milestone.csv` | 17,392 | **At which step each field gets filled** — one row per field per milestone |
| `03-dropdown-options.csv` | 3,231 | **Every dropdown and every option**, each marked *declared by Encompass* or *inferred from live data* |
| `04-loan-programs.csv` | 11 | Every loan program with its term, interest-only period and purpose mix |
| `05-term-structures.csv` | 8 | The term structures that exist — **and the two that do not** |
| `06-piti-components.csv` | 8 | The seven parts of the housing expense, and the total |
| `07-investor-spellings.csv` | 33 | Every investor, and every way each has been spelled |
| `08-condition-templates.csv` | 197 | The tenant's condition library, staff and borrower wording |
| `09-condition-sets.csv` | 19 | The condition sets |
| `10-efolder-document-types.csv` | 230 | Every eFolder document type |
| `11-api-surface.csv` | 111 | Which Encompass calls work, which are blocked, which lie |

**Two columns in `01` are the ones people miss.** *"Declared type"* is what the
Encompass schema says a field is; *"Data types actually seen"* is what the live values
turned out to be, with counts. They disagree often — a field declared `String` that
holds 700 floats is an ordinary case here — and a mapping built on the declaration
alone will break.

---

## 2. If you want to read about it

| Document | What it covers |
|---|---|
| **`ENCOMPASS-FIELD-INTELLIGENCE.md`** | The 3,783-field census: how it was taken, what a field record contains, the DSCR-vs-short-term differences, the shared core |
| **`ENCOMPASS-LOAN-ANATOMY.md`** | How a loan file is put together — borrower pairs, the borrower and co-borrower, where they live, the subject property, the milestones |
| **`ENCOMPASS-TERMS-AND-PITI.md`** | The term structures, the PITI and the DSCR arithmetic, verified — **and the two defects** (`CX.PITIA`, the ARM amortization type) |
| **`ENCOMPASS-CONDITIONS-AND-EFOLDER.md`** | Enhanced Conditions, the eFolder, and how a document links to a condition |
| **`ENCOMPASS-INVESTORS-AND-DROPDOWNS.md`** | The investor identity chain, the 117 spellings, and all 1,006 dropdowns |
| **`ENCOMPASS-ACCESS-AND-PERSONA.md`** | What the API can and cannot reach, and **why** — the 403s are a client-registration scope, not the persona |
| **`ENCOMPASS-INTEGRATION.md`** | The integration itself: credentials, the read-only rule, the request surface |
| **`LOS-BUILD-STRUCTURE.md`** | **The plan** — what is built, what comes next, and in what order |
| **`LOS-VISION-AIM-PORTAL.md`** | **The portal the owner wants this to feel like**, in his own words. Direction, not a spec — every section needs his confirmation before it is built |
| **`AUDIENCE-RULES.md`** | **HARD RULE** — who may see what, and why the investor's name never reaches a borrower or a broker |

Outside this folder:
`docs/LONG-TERM-LOANS-SEPARATION-CHARTER.md` (why RTL and LT are two systems),
`docs/LONG-TERM-AUTHORIZED-COPIES.md` (the ledger of every authorized crossing),
`docs/ENCOMPASS-WRITE-AUTHORIZATIONS.md` (the one place a write can ever be allowed).

---

## 3. If you are writing code

Everything is behind `src/longterm/encompass/` and needs no database and no network —
it is committed research, not a live call.

```js
const enc = require('src/longterm/encompass');
enc.summary();                       // one object describing the whole memory
```

| Module | What it holds |
|---|---|
| `field-intelligence.js` | The 3,783-field census. `field(id)`, `search(q)`, `dscrFields()`, `alwaysOnDscr()`, `productDifferences()`, `populatedAt(milestone)`, `calculatedFields()` |
| `loan-anatomy.js` | `LOAN_ROOT`, `BORROWER_PAIRS`, `SUBJECT_PROPERTY`, `TERMS`, `HOUSING_EXPENSE`, `MILESTONES`, `DSCR_STAGE_DISTRIBUTION` |
| `terms.js` | `TERM_STRUCTURES`, `TERM_STRUCTURES_NOT_PRESENT`, `PITI`, `DSCR_MEASURED`, `KNOWN_TERM_DEFECTS`, `describeStructure()`, `amortizingMonths()` |
| `formulas.js` | `DSCR_RATIO`, `KNOWN_DEFECTS`, `CREDIT_SCORE_LOGIC`, `computeDscr()` |
| `investors.js` | 33 investors, 117 spellings, `IDENTITY_CHAIN`, `resolve()`, `sameInvestor()`, `investorLoanNumber()` |
| `dropdowns.js` | 1,006 constrained fields, `DRIFT_KINDS`, `options()`, `normalizeValue()`, `isKnownValue()` |
| `conditions.js` | `ENDPOINTS`, `CONDITION_SHAPE`, `OBSERVED`, `EFOLDER`, `WRITE_PATH` |
| `mismo.js` | `APPRAISAL` (MISMO 2.6 valuation) and `ULAD` (3.4 / URLA), section by section |
| `api-surface.js` | What answers, what is blocked, and the false negatives |
| `completion-rules.js` | The Milestone Completion rules and their field requirements |
| `dictionary/*.json` | The raw research the modules read |

The settings layer is `src/longterm/settings/encompass-settings.js` — 44 settings in
10 groups, pre-filled with our values and every one changeable (see §6).

---

## 4. If you want it over HTTP

Read-only, no Encompass call, no database:

```
GET /api/lt/encompass/summary            the whole memory in one object
GET /api/lt/encompass/fields             the rule-derived field catalog
GET /api/lt/encompass/fields/:id         one field
GET /api/lt/encompass/intelligence       the live census
GET /api/lt/encompass/intelligence/:id   one field's census record
GET /api/lt/encompass/anatomy            how a loan file is put together
GET /api/lt/encompass/terms              term structures, PITI, DSCR   (?term=360&io=120)
GET /api/lt/encompass/programs           the loan-program taxonomy
GET /api/lt/encompass/conditions         conditions + the eFolder model
GET /api/lt/encompass/investors          the investor registry           (?resolve=Deepahven)
GET /api/lt/encompass/dropdowns          every dropdown and its options
GET /api/lt/encompass/api-surface        what the API can reach
GET /api/lt/encompass/completion-rules   the milestone completion rules
GET /api/lt/encompass/settings           the settings and their defaults
GET /api/lt/encompass/status             a live connectivity check
```

---

## 5. The findings that change what you build

Five things that are not obvious and cost real time to discover:

1. **`CX.PITIA` is wrong on every file that carries it.** Filled on 99.6% of
   long-term loans; on the 452 that carry both it and field 912, **zero agree**. Its
   formula sums the purchase price and cash-from-borrower into a monthly payment.
   Read field **912**. Never `CX.PITIA`.
2. **Read the PITI total; never rebuild it from its parts.** They match on 91.4% of
   files — and on 38 of the 39 that differ the tax line is blank while the total
   includes taxes. Rebuilding understates the expense by ~$1,300/month on 8% of files
   and **inflates the DSCR.**
3. **A `200 []` is not proof of absence.** Four v1 condition endpoints return an empty
   list on files that plainly have conditions — they answer for a legacy system this
   tenant does not use. The working call is
   `GET /encompass/v3/loans/{id}/conditions`.
4. **The document→condition link runs one way.** In the eFolder the DOCUMENT carries
   `conditions[]`; there is no condition→documents endpoint. "Which documents satisfy
   this condition" has to be built by inverting the mapping.
5. **Never compare an investor name as a string.** 151 spellings for ~30 companies.
   Compare `investors.resolve(x).key`, or call `sameInvestor(a, b)`.

And two the owner has now settled (2026-08-14):

- **The investor loan number is `VEND.X276`** — owner-confirmed, and what the code
  already keys on. It had been raised as a discrepancy because `VEND.X267` holds ZIP
  codes; measurement and the owner now agree.
- **There is no 20-year product.** "20-year" is the owner's name for the amortising
  tail of the 30-year / 10-year-interest-only structure. Do not build one.

---

## 6. The rules that shape everything

**The investor's name never reaches a client.** Owner-directed 2026-08-14: *"The client
should not be able to see the investor name. Never ever! Not borrowers, not TPOs, only
internal staff."* It covers the name in any spelling, the contact details, the
investor's own loan number and the funding channel — on every surface. One definition
in `src/longterm/audience.js`, built on the investor registry (the name is spelled 151
ways), failing closed, guarded by `scripts/test-lt-investor-block.js`. Read
`AUDIENCE-RULES.md` before you build a screen.

**The system must be sellable and re-customisable.** Nothing may hard-code a YS
Capital number, threshold, label or list. Every such value lives in the settings layer
pre-filled with our values and changeable by whoever buys the system. If you are about
to write a company-specific constant into a column default or a module, it belongs in
settings instead.

---

## 7. How the research was taken

- **Access:** OAuth resource-owner grant against the live tenant, `scope: lp`.
- **Population:** the whole pipeline — 772 loans — pulled and stored, then split by
  loan program. Anything named DSCR is long-term (490); Fix & Flip is short-term (251).
- **Fields:** every field id resolved to its JSON path, then every value on every loan
  read to record the type actually stored, the fill rate, the distinct-value count,
  the range, and the milestone at which it first appears.
- **PII:** no borrower name, SSN, date of birth, email, phone or property address
  value ships in the committed research. Enforced by a field-name rule **and** a
  value-pattern scrub, and asserted by `scripts/test-lt-encompass-intelligence.js`.
  Where a field's sample values were withheld, the export says so in its own column.

**Tests:** `scripts/test-lt-investor-block.js` (the investor name cannot reach a client),
`scripts/test-lt-encompass-intelligence.js` (the research is well-formed,
PII-free and settings-driven), `scripts/test-lt-encompass-readonly.js` (the
integration is structurally read-only), `scripts/test-lt-loan-schema-db.js` (the data
model holds a real file), `scripts/test-lt-encompass-milestones.js`. All in `npm test`.
