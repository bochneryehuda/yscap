# Long-Term ↔ Encompass — the complete picture

**Owner-directed 2026-08-14.** This is the Long-Term product's **full Encompass
understanding** — brought in so *"when my developer is sitting on it, he should see
everything, and when any AI is starting to work on it, he should really understand
the entire structure of the Encompass integration."*

**Encompass (ICE Mortgage Technology / Ellie Mae) is the long-term source of truth.**
Everything here is **reference knowledge / memory** for the build. **None of it is
enforced.** No condition here blocks anything. It is a map, not a gate.

> **Two-product rule.** Everything Long-Term is separate from RTL (see
> `docs/LONG-TERM-LOANS-SEPARATION-CHARTER.md`). The Encompass integration was
> **explicitly authorized** to be brought into Long-Term (2026-08-14, recorded in
> `docs/LONG-TERM-AUTHORIZED-COPIES.md`) — as a **self-contained by-value copy** that
> imports **zero** RTL code and touches **no** RTL table. Everything lives in
> `src/longterm/encompass/**`.

---

## 1. Where everything lives

| Piece | File | What it is |
|---|---|---|
| Read-only API client | `src/longterm/encompass/client.js` | OAuth auth + every read request. **READ-ONLY**, self-contained. |
| Config (credentials) | `src/longterm/config.js` (`encompass`) | `LT_ENCOMPASS_*` env, falling back to shared `ENCOMPASS_*`. No secret values in code. |
| Milestone Completion rules | `src/longterm/encompass/completion-rules.js` | The 22 visible rules + the base rule's field set + what's missing. |
| The unified field catalog | `src/longterm/encompass/index.js` (`fieldCatalog()`) | Every known field merged from all sources, with when/why. |
| RTL reconciliation map | `src/longterm/encompass/reconciliation-map.js` | The RTL field map, brought in for reference, RTL usage labeled. |
| Request / auth catalog | `src/longterm/encompass/requests.js` | Every endpoint, the auth flow, corrected paths. |
| Milestone/status catalog | `lt_encompass_milestones` (`db/547`) | The 19 Encompass milestones (identity, TPO status, consumer status, role, days). |
| Read-only API | `/api/lt/encompass/*` | Serves all of the above to staff, read-only. |

**API surface** (`/api/lt/encompass/…`, staff-authenticated, read-only):
`milestones`, `milestones/:id`, `summary`, `fields`, `fields/:id`,
`completion-rules`, `requests`, `reconciliation-map`, `status`.

---

## 2. How Encompass is structured (the mental model)

A **loan** in Encompass moves through **milestones** (Started → LO Prep → Loan Setup
→ Submittal → … → Clear To Close → Funding → … → Completion). The 19 active
milestones, with the status each one shows the **TPO (broker)** and the **borrower
(consumer)**, the assigned **role**, and the expected **days**, are in
`lt_encompass_milestones` (this is the ONLY part the Encompass API returns — see §5).

**Milestone Completion business rules** decide which loan **fields** (and docs/tasks)
must be filled before a milestone can complete. Each rule has:
- a **name**,
- the **channel(s)** it applies to,
- a **condition** (when it turns on — e.g. `[19] = "Purchase"`), and
- a set of **required fields**, each tagged with the **milestone** by which it must be
  present (LO Prep / Submittal / Docs Out / Clear To Close).

Field syntax in conditions: `[<id>]` reads a loan field, `[#FR0112]` a form field,
`[CX.NAME]` a custom field; string comparisons are quoted.

---

## 3. The long-term (DSCR) core rule

DSCR / long-term is a **no-income-doc** product, so the tenant models it as
**Loan Doc Type = "No Documentation"**. That is the exact condition on the base rule,
**"milestone completion field requirements"** (rule #12), which therefore carries the
**long-term core field set** — **117 fields** (video-confirmed end-to-end) tagged to
LO Prep / Submittal / Ready for Docs / Docs Out / Clear To Close. The complete list is
in `completion-rules.js` → `BASE_RULE_FIELDS`.

DSCR-specific fields worth knowing: `1005` Gross Rent, `CUST01FV` DSCR,
`CX.DSCRLOANAMOUNT`, `CX.DSCRLTV` (the DSCR ratio inputs); `CX.PPPTERM` / `CX.PPPTYPE`
(prepayment penalty — long-term carries one, RTL bridge doesn't); `1487` Occupancy
Rate, `1811` Occupancy Status (rental occupancy); `CX.BUYPRICE`, `CX.RESERVES`,
`CX.HOLDBACK`. Investor/note-buyer fields (`CX.WHICHINVESTOR`,
`CX.SUBMITTEDTOINVESTOR`, `VEND.X263`, `VEND.X276`) are **staff-only** — never
borrower-facing, the same rule RTL follows.

Other rules that apply to long-term: **entity vesting** (`if vesting officer require
LLC set`, condition `[4008]="Trustee" OR "Officer"` — the LLC/trust vesting fields),
**refinance** (`if refi`), **non-delegated investor** (investor name + ref #). RTL-only
rules (Fix & Flip, fidelis, delegate) are kept in the list, **labeled `rtl:true`**, for
the full picture.

---

## 4. Authentication & requests (all READ-ONLY)

**Auth** — OAuth 2.0 password grant (Developer Connect):
`POST https://api.elliemae.com/oauth2/v1/token`, username
`<username>@encompass:<instance-id>`, form values password + client id + client secret
+ scope `lp`. Credentials come from `LT_ENCOMPASS_*` env (falling back to shared
`ENCOMPASS_*`); **no secret values live in code**.

**Read requests** (client method in parentheses):
- `GET /encompass/v3/loans/{id}` (`getLoan`)
- `POST /encompass/v3/loanPipeline` — pipeline SEARCH (`pipelineSearch`)
- `POST /encompass/v3/loans/{id}/fieldReader` — read fields **by field number** (`fieldReader`)
- `GET /encompass/v3/loans/{id}/milestones` (`getLoanMilestones`)
- `GET /encompass/v3/loans/{id}/milestoneLogs` (`getLoanMilestoneLogs`)
- `GET /encompass/v3/settings/milestones` — milestone settings (`getMilestoneSettings`)
- `GET /encompass/v3/schemas/loan/standardFields?ids=…` — resolve field ids (`getStandardFieldSchema`)
- `GET /encompass/v3/settings/loan/customFields` — custom fields (`getCustomFieldSettings`)

**READ-ONLY is structural, not a promise.** Only three POSTs are allowed and all are
read-shaped (token, pipeline search, fieldReader); every other non-GET is refused
before it hits the wire by `_fetchGuarded`. There is **no** write/flood path in
Long-Term (that one owner-authorized Encompass write is RTL-only). Guarded by
`scripts/test-lt-encompass-readonly.js`.

### Two paths corrected vs RTL (audit 2026-08-14, verified live)

| Data | RTL path (outdated, 403) | Long-Term path (current, 200) |
|---|---|---|
| Milestones | `/encompass/v3/settings/loan/milestones` | `/encompass/v3/settings/milestones` |
| Standard fields | `/encompass/v3/settings/loan/standardFields` | `/encompass/v3/schemas/loan/standardFields` |

The earlier 403 on those was NOT a permissions problem — the paths had simply moved.

---

## 5. What the API can and cannot give us (important)

- The Encompass API **returns the 19 milestone SETTINGS** (identity, status, role,
  duration) — that's `lt_encompass_milestones`. Confirmed live in the audit.
- The API does **NOT** return the **Milestone Completion rule definitions** (required
  fields/tasks per milestone, activation conditions). Those are configured in
  **Encompass Desktop → Settings → Business Rules → Milestone Completion** and must be
  exported from there (or via an ICE-supported SDK / system-settings export).
- So the rules in `completion-rules.js` come from the **screen recordings**, not the
  API. See §6 for exactly how complete that is.

Field ids can be resolved to descriptions/types with
`GET /encompass/v3/schemas/loan/standardFields?ids=<csv>` and the custom-field
settings endpoint. (Verified: `418` = "Borr Declarations A", boolean,
`loan.currentApplication.borrower.intentToOccupyIndicator`; `169` = "Borr
Declarations G", `outstandingJudgementsIndicator`.)

---

## 6. Completeness — what is confirmed, reconstructed, and missing

| Part | Status |
|---|---|
| 19 milestone settings | ✅ **Confirmed** live from the API |
| 22 of 91 Milestone Completion rules (names, channels, conditions, last-modified) | ✅ **Confirmed** (visible in the recording, normalized in the audit CSVs) |
| Field→milestone requirements for the 6 rules opened on camera (#12, #13, #15, #16, #18, #21) | ✅ **Confirmed** (video, each field `source: 'video'`/`'audit_csv'`) |
| The base rule's full **117-field** list | ✅ **Confirmed** end-to-end across two frame passes (was reconstructed at ~111; the deeper pass added L72 "HUD1 File #" → Ready for Docs, and URLA.X100/X102/X104/X106/X170). |
| **69 of 91 rules** | ❌ **Missing** — the master list was never scrolled past rule 22. |
| Required-Fields tabs for rule 17 (iska) + the RTL rules 14/19/20/22 | ❌ Not opened on camera. |
| Required Tasks / Advanced Conditions tabs (any rule) | ❌ Not opened (Required Docs was shown empty for every opened rule). |
| Audio narration | ❌ Not transcribable in the capture environment. |

**How to get the rest** (in `completion-rules.js` → `MISSING.howToGetTheRest`): an
Encompass admin opens Settings → Business Rules → Milestone Completion and captures
every enabled rule's condition + Required Fields + Required Tasks + target milestone,
then the field ids are resolved in bulk via the standard/custom field endpoints.

---

## 7. The field catalog

`src/longterm/encompass/index.js` builds ONE unified catalog (`fieldCatalog()`)
merging every source, keyed on field id. Each entry carries: the family
(standard/custom/urla/form/vendor), the description, **which rules require it and at
which milestone**, whether it is **RTL-reconciled** (and the RTL column/gate if so),
and staff-only/PII flags. So field `364` shows *both* that it's required at LO Prep
by the base rule *and* that RTL reconciles it as `ys_loan_number` (a blocking match).
Query it at `/api/lt/encompass/fields` (`?family=`, `?milestone=`, `?rtl=`, `?q=`).

**RTL vs long-term.** The RTL reconciliation map (`reconciliation-map.js`) is the
field set RTL actively compares against Encompass. It is brought in **whole**, and
each entry is **labeled with its RTL usage** (the `our` column, the gate). Long-Term
does not reconcile anything yet; when it builds its own mapping it decides
field-by-field what to reuse — nothing is assumed.
