# Borrower names: one big field, plus first / middle / last

**Owner-directed 2026-07-27.** Two directions, in the owner's own words:

1. *"Split up the name with first and last name and middle name. Middle name
   should be obviously optional, and it should automatically take any name that
   has two words and split that in half. Research the ClickUp integration —
   ClickUp has the full name in one line — and the Encompass integration, where
   it is split into three separate fields."*
2. *"Leave the field where it has one big field for the borrower's name. When
   somebody types it separately it should go over there, the full name. All the
   places where you were using the name should still use the existing full name
   field. We should just ADD fields to enter first, middle and last — so the big
   field is still used everywhere it was used until now and nothing breaks."*

---

## 1. What was actually wrong

PILOT stored a person as **two** columns, `borrowers.first_name` +
`borrowers.last_name`. Every one-line name arriving from ClickUp was cut with
`lastIndexOf(' ')` (`clickup/transforms.splitName`), which means:

| ClickUp "Borrower Name" | stored first_name | stored last_name |
|---|---|---|
| `Dov Steiner` | `Dov` | `Steiner` | ✅ |
| `Issac Michael Grunzweig` | `Issac Michael` | `Grunzweig` | ❌ middle name swallowed |
| `John Michael Smith Jr` | `John Michael Smith` | `Jr` | ❌ **the suffix became the surname** |

The three systems disagree about the shape of a name:

| System | Shape |
|---|---|
| **ClickUp** | ONE short-text field, `Borrower Name` (`474a54a3-…`), plus a second `Co-Borrower Name` (`5e4d2128-…`) |
| **Encompass** | THREE fields per party — `applications[].{borrower,coBorrower}.firstName / .middleName / .lastName`, plus `.suffixToName` (standard field ids 4000/4001/4002 borrower, 4004/4005/4006 co-borrower) |
| **MISMO 3.4** | `<NAME><FirstName><MiddleName><LastName><SuffixName>` — `mismo/build.js` already emitted `<MiddleName>`, and nothing ever filled it |
| **PILOT (before)** | TWO columns, so the middle name had nowhere to go |

### The expensive consequence

`lib/integrations/encompass-field-map.js` had to record the middle name as:

```
key: 'middle_suffix', our: '(no column)', match: 'findingOnly',
note: 'No home in our schema — finding only (drop/append), never a block'
```

…and `encompass/reconcile.compareIdentity` compared the borrower name by
**joining first + last on both sides**. So on a file whose Encompass copy is
correctly split, our merged `Issac Michael` + `Grunzweig` produced
`"Issac Michael Grunzweig"` against their `"Issac Grunzweig"` → **mismatch**.
That row is `GATE.BLOCK`, which **holds the term sheet** — on a file where
nothing is actually wrong.

---

## 2. The shape now

```
borrowers.first_name    ── typed / split
borrowers.middle_name   ── OPTIONAL. NULL = this person has none.        (db/343)
borrowers.last_name
borrowers.name_suffix   ── 'Jr.', 'III', 'MD' — kept OUT of last_name    (db/343)
borrowers.full_name     ── GENERATED ALWAYS, the whole line              (db/344)
```

`full_name` is a **Postgres generated column**, not a trigger and not application
code, so it cannot drift from the parts — there is no write path anywhere,
present or future, that could leave the big field disagreeing with the pieces.
Writing a full name means writing the parts (the API splits a typed line first);
reading the whole name is always this one column.

Two more columns support the human half:

```
borrowers.name_review_needed  ── PILOT had to judge where the name splits
borrowers.name_review_reason  ── the machine key behind the plain-language prompt
borrowers.name_split_checked_at ── so the boot repair is resumable + idempotent
```

The review flag is **a prompt, never a gate**. Nothing on a file waits for it.

---

## 3. The splitter — `src/lib/person-name.js`

One pure module (no DB, no network), used by every surface. Rules, with the
owner's rule first:

| Input | first | middle | last | suffix | Confidence | Asks a human? |
|---|---|---|---|---|---|---|
| `Dov Steiner` | Dov | | Steiner | | high | no — **the owner's rule: two words split in half** |
| `John A. Smith` | John | A. | Smith | | high | no — a single initial is unambiguous |
| `Issac Michael Grunzweig` | Issac | Michael | Grunzweig | | medium | **yes** |
| `Maria Elena Sofia Rodriguez` | Maria | Elena Sofia | Rodriguez | | low | **yes** |
| `John Michael Smith Jr.` | John | Michael | Smith | Jr. | medium | yes |
| `Ludwig van Beethoven` | Ludwig | | van Beethoven | | high | no |
| `Juan de la Cruz` | Juan | | de la Cruz | | medium | **yes** |
| `Rabbi Moshe Klein` | Moshe | | Klein | | high | no — the title is dropped |
| `Klein, Avrohom Yitzchok` | Avrohom | Yitzchok | Klein | | low | **yes** |
| `Stauber` | Stauber | | | | low | **yes** |
| `Unknown` / blank | | | | | low | **no** (nothing to review) |

Deliberate conservatism, each one a real trap:

* **Suffix detection excludes a bare `V` and `X`** — a trailing single letter is
  far more often an initial standing in for a surname than a regnal number, and
  mis-reading it would DELETE someone's surname.
* **Surname particles are split STRONG vs WEAK.** `van`, `von`, `della`, `dos`,
  `du`, `ter` are essentially never given names → attached at full confidence.
  `de`, `del`, `la`, `al`, **`ben`** are also real given names, so they only
  attach when the writer left them **lowercase**, and the split is flagged.
  `Mac` / `Mc` are deliberately NOT in the list — standalone they are rare, and
  including them would mangle `John Mac Smith`.
* **A blank or placeholder name never raises a prompt.** The sync mints
  `Unknown Unknown` shadow rows in volume; nagging about those would bury the
  real ones.

Comparison (`compareNames`) is **middle-name tolerant**: first name and surname
must agree, a suffix present on BOTH sides must agree (a father and his son are
different people), and the middle name matches when either side omits it or
carries an initial of the other. A genuinely different middle name still
mismatches. It also re-splits a **legacy merged** `first_name` on the fly, so the
comparison never depends on the backfill having run.

---

## 4. Previous files — `src/lib/name-heal.js`

Runs at boot, like `address-heal.js`. It is JavaScript, not a migration, on
purpose: a PL/pgSQL twin of the splitter would inevitably drift from the one the
live sync uses (exactly the class `pilot_term_norm` / `pilot_property_type_norm`
needed a dedicated drift test to contain). One splitter, called from one place.

Safety, in order:

* **It never changes what a name SAYS.** `splitStoredName` only redistributes
  tokens already present, and the pass re-asserts that by rebuilding the whole
  line before and after and refusing any row where the words differ (a leading
  courtesy title is the one permitted removal).
* It never touches a row that already carries a middle name, or a placeholder.
* The `UPDATE` re-checks the values it read, so a concurrent human edit wins.
* Every row it looks at is stamped, so the pass is resumable, idempotent, and a
  fast no-op on every later boot.
* It never throws.

`splitStoredName` is deliberately narrower than `splitFullName`: it redistributes
**within** the stored first name and never moves a token across the first/last
boundary — because the stored surname may have been typed by a human on the
application form. The two exceptions are the two shapes the old splitter
provably produced: a suffix stored as the surname, and surname particles
stranded at the end of the first name.

---

## 5. ClickUp — one line in, one line out

**Inbound** (`clickup/mapper.readTaskFields`): the single `Borrower Name` field
is split into all four columns, and the split's confidence rides along as
`_nameSplit` so `ingest.healBorrowerFields` can raise the confirm prompt. Same
for the task-title fallback and the `Co-Borrower Name` field.

**Outbound** (`buildTaskFields`): `borrowers.full_name` is written back into that
one field, so the card shows the whole name. The task title uses it too.

**No churn, and no false review.** `fieldValueEquivalent` now treats two names
that describe the same person as equivalent for the name fields — so a repush of
`Issac Michael Grunzweig` over ClickUp's `Issac Grunzweig` is **suppressed**
instead of rewriting the card (or, on a full repush, being blocked by the PII
overwrite shield and queuing a pointless review row for every borrower with a
middle name). The tolerance is dropped when the push carries `humanEditKeys`
naming a name column or is an approved sync review — the two ways a human says
"write this" — so a deliberate correction still reaches the card.

The task↔file **identity graph** (`clickup/identity.js`) deliberately keeps
using first + last: it compares that string EXACTLY against identities recorded
on earlier syncs, which predate these columns, and adding the middle name would
silently weaken every stored match on the duplicate-a-task workflow the graph
exists to protect.

---

## 6. Encompass — read-only, still

* `IDENTITY_MAP` gains real `middle_name` and `name_suffix` entries
  (`match: 'nameEqualsLoose'`) in place of the old `(no column) — finding only`.
* `reconcile.compareIdentity` compares the borrower and co-borrower by MEANING
  through `person-name.compareNames`, so the false BLOCK-gated mismatch is gone
  while a genuinely different name still mismatches.
* `encompass/enrich.js` gains `verifyMiddleName` — Encompass keeps the middle
  name in its own field, which makes a loan copy the best source PILOT has for
  the one part of a name a ClickUp one-liner usually omits. Same discipline as
  the home address: **fill a blank, agree silently, or queue a review**. It never
  overwrites, never touches the first or last name, and never writes back to
  Encompass. When the two agree, it clears the confirm prompt — Encompass has
  independently confirmed our split.

**Nothing here writes to Encompass.** No new POST endpoint, no widened predicate,
no change to the export surface. The read-only doctrine is untouched.

---

## 7. Everywhere else

* **MISMO** — `<MiddleName>` and `<SuffixName>` are finally filled on export; an
  import fills a blank middle name / suffix on our side.
* **The one big field is still what everything reads.** Every SQL
  `first_name || ' ' || last_name` became `NULLIF(x.full_name,'')`, and every JS
  join became `person-name.displayName(row)` / `personName.fullNameOf(row)` in
  the portal — both of which prefer `full_name` and fall back to joining the
  parts, so a query that has not been updated behaves exactly as before.
* **Forms** — the loan application, the borrower's own profile, the staff
  borrower profile, both co-borrower forms and intake all take a middle name.
  The staff profile shows **one big Full name box with First / Middle / Last /
  Suffix underneath**; typing in either updates the other.
* **Government-ID check** — `id-checks.fileName` now uses the whole name, and the
  displayed value is the same string it compared, so a reviewer and the check can
  never disagree. `namesMatchLoose` was already middle-name and suffix-tolerant,
  so this cannot manufacture a mismatch against an ID printing only first + last.
* **SharePoint** — deliberately untouched. `borrowerMatches` was already
  middle-name tolerant on both sides, so an existing `Issac Michael Grunzweig`
  folder still matches; new folders are simply shorter, which helps the 259-char
  Windows path ceiling.
* **A locked borrower** (one with an accepted file) change-requests a middle name
  or suffix edit through the loan team, exactly like the first and last name.

---

## 8. Tests

* `scripts/test-person-name.js` — 121 pure assertions: the owner's two-word rule,
  every confidence verdict, suffixes, titles, particles, the comma form, the
  legacy-shape comparison, `displayName`, round trips, and a never-throws battery.
* `scripts/test-name-split-db.js` — real Postgres: the backfill (split, suffix
  recovery, clean rows untouched, placeholders skipped, idempotent second pass,
  the never-restate invariant), the ClickUp round trip incl. the no-churn and
  human-edit cases, the Encompass comparison, and a **real HTTP** round trip
  through the staff doors (type one full name → three fields + the big field;
  confirm; edit the parts → the big field follows; clear the middle name; blank
  and placeholder names refused).

Both are in `npm test`.
