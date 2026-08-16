# Splitting PILOT into two repos — the plan

**Status: RESEARCH COMPLETE, NOTHING BUILT. This is the plan for owner approval.**
Owner-directed 2026-08-16: *"split up my entire system into two separate repos — short term and long
term … totally separate if it's possible … everybody should just have a slider, and then the entire
system should be totally different … same logins, same profiles."*

Read `AGENTS.md` and the *TWO PRODUCTS, TWO SYSTEMS* section of `CLAUDE.md` first. This document does
not change one word of the separation law — it proposes moving the boundary that law already draws
from a folder line to a repository line.

---

## 1. The answer: yes, and the cut line already exists

The separation law of 2026-08-02 has been enforced by CI on every change since. Measured against the
current tree, that enforcement has produced exactly the property a repo split needs:

| Requirement for a clean extraction | State today |
|---|---|
| LT back end in one place | `src/longterm/**` — 31 files, ~4,900 lines |
| LT front end in one place | `app-v2/src/longterm/**` (on the pipeline branch) |
| LT owns its HTTP surface | `/api/lt/*` only |
| LT owns its tables | `lt_*` only, migrations `db/NNN_lt_*.sql` |
| LT owns its tests | `scripts/test-lt-*.js` |
| **LT imports zero RTL modules** | **Confirmed — the one seam is `src/server.js` mounting the router** |
| **LT opens its own Postgres pool** | `src/longterm/db.js`, written explicitly so a second database is "a trivial change later" |

So extraction is `git filter-repo` over a known path set — not a refactor. The gate
(`scripts/check-product-separation.js`) is what made this possible and must not be weakened during the
move; after the move it becomes two mirrored gates ("no `src/longterm/` here" / "no RTL imports here").

## 2. What must stay shared, and where each lives

Two repos does not mean two of everything. Three things are genuinely shared and each needs a decided
owner, or the split produces drift instead of parallelism.

### 2.1 Identity — owned by the short-term repo

The shared-identity zone (`docs/LONG-TERM-AUTHORIZED-COPIES.md`) is `borrowers`, `borrower_auth`,
`staff_users`, `tpo_firms`, `borrower_officers`, `src/auth/index.js` and the one shared borrower
editor. LT reads `borrowers`/`staff_users` and writes exactly one identity table
(`borrower_officers`).

**Phase 1 shape: one Postgres, both services connect to it.** LT keeps reading those tables directly,
exactly as today. Nothing about the identity zone changes on day one.

**Phase 2 shape (optional, later): `/api/identity/*` served by the short-term repo.** LT stops reading
identity tables and asks over HTTP. This is the only change that a second database would require, and
`src/longterm/db.js` was written anticipating it.

Session sharing across two origins is the ordinary JWT case: one `JWT_SECRET`, both services run the
same `authenticate()` contract, and a token minted by one validates in the other. The per-device `sid`
revocation (db/321) and the `token_version` hammer both continue to work because both services read the
same rows.

### 2.2 Design system — owned by a third small repo

Owner-directed: *"the design should be the same."* That is only true if the tokens and primitives live
in one place. `app-v2/src/styles.css` is 4,771 lines and carries the PILOT palette + type tokens; the
lockup lives in `Layout.jsx`.

Recommendation: a third repo `yscap-design` consumed by both as a **pinned** npm git-dependency. Pinned,
not floating — a design change must never be able to reach the live RTL service without a deliberate
version bump.

The **ProductSwitch is part of this repo**, not the LT repo, because after the split it must render on
both sides.

#### What belongs in `yscap-design`, and what must never

Owner asked 2026-08-16 whether authentication, logins, credentials, profiles, track records, LLCs and
ID documents should also live in the design repo "as a shared backbone of the entire system". **No** —
and the boundary is worth stating explicitly, because the two are shared for opposite reasons.

`yscap-design` is a **build-time library**: it is copied into both bundles, runs in the browser, holds
no data, opens no database, and needs no secret. Identity is a **runtime service over regulated PII**:
it needs `DATABASE_URL`, `JWT_SECRET`, `SSN_ENCRYPTION_KEY`, the GLBA audit trail, and — the governing
property — exactly ONE writer for the person record (CLAUDE.md rule 2, and the reason a dozen RTL
modules are allowed to heal and de-duplicate `borrowers` safely).

Putting identity in the design repo would hand the SSN encryption key to a package whose job is fonts,
and would put a button-colour change in the same blast radius as the borrower PII store.

| Concern | Home | Why |
|---|---|---|
| Palette, type tokens, buttons, inputs, page shell, `ProductSwitch` | `yscap-design` | No data, no secrets; must be identical on both sides |
| **Layout** of the borrower / officer / TPO profile screens | `yscap-design` | The empty form, not the record — so a profile looks the same on both sides |
| Pure display rules both sides must agree on — `person-name.js` (first/middle/last/suffix), address canonicalisation, SSN display format | `yscap-design` | Pure functions, no DB. This also retires the existing mirror-and-drift-test pattern (`app-v2/src/lib/personName.js` mirroring `src/lib/person-name.js`, likewise `dealBasis.js`, `payoff.js`) |
| Login, password hashing, MFA, sessions, `sid` revocation | **`yscap` (short term)** | Live production sign-in; one implementation of `authenticate()` |
| `borrowers`, `staff_users`, `tpo_firms`, `borrower_auth`, `borrower_officers` | **`yscap`** | The identity zone; single writer |
| Track records, LLCs / entities, ID documents, LLC documents | **`yscap`** | Regulated PII with an audit trail and a document store |
| All of the above, read-only | `yscap-longterm` | Already the rule — LT reads the person record, writes only `borrower_officers` |

**Do not move identity into `yscap-design`, and do not extract it into a fourth service during this
split.** A standalone identity service is a legitimate future step — it is the same change §2.1 already
describes as Phase 2 (`/api/identity/*`) — but it means re-plumbing the sign-in of a live,
borrower-facing system in order to serve a side build that is not live. Revisit when LT goes live, not
before.

### 2.3 The database — one, for now

Splitting the database on day one buys none of the stated goals (conflicts, CI weight, parallelism) and
costs a real distributed-systems problem on a live production system serving borrowers. Recommend one
Postgres, `lt_*` namespace unchanged, and revisit only if LT goes live.

**Recommended shape: three repos, one database, one domain, two deploys.**

```
                    yscap-design  (new, small)
                    tokens · primitives · brand · ProductSwitch
                              │
              ┌───────────────┴───────────────┐
              ▼                               ▼
      yscap (short term)              yscap-longterm (new)
      live production                 side build, not live
      owns identity                   reads identity
      Render: web + worker + 2 crons  Render: web (+ worker later)
              │                               │
              └────────── one Postgres ───────┘
                     RTL tables    lt_* tables
```

## 3. The switch

`app-v2/src/longterm/ProductSwitch.jsx` already exists on
`claude/loan-pipeline-architecture-5nql6q`: a top-bar pill, per-user preference saved server-side via
`/api/lt/me`, fails quiet (hides itself when LT is unreachable, so an officer who has never heard of the
long-term side is never shown a broken control).

Changes needed for two repos:

1. `nav('/internal/lt')` becomes `window.location.assign('/lt')`. One line.
2. The component moves into `yscap-design` so both sides can render it.
3. The preference endpoint stays on LT (`/api/lt/me`) or moves to identity — either works; LT is
   simpler and already built.

The switch then genuinely swaps systems rather than routes, which is what the owner asked for.

## 4. Same logins, same profiles

### What exists today

| Ask | Current state |
|---|---|
| One password for everyone | Three doors (`/auth/borrower/login`, `/staff/login`, `/tpo/login`), but `answerCrossSurfaceLogin` already makes the client door accept staff and assistant credentials |
| Processors / back office / front office | Already `staff_users` rows with different roles |
| TPOs | Already `staff_users` rows, `is_external=true` + `tpo_firm_id`; token `kind='tpo'` |
| Borrower profile (personal, email, track record, LLCs, ID docs, LLC docs) | Exists in full: `borrowers` + `llcs`/`llc_borrowers` + `track_record_*` + `documents`, edited through the one shared `BorrowerProfilePanel.jsx` |
| Officer profile | `staff_users` row only — no track record, no document sections |
| TPO profile | `staff_users` + `tpo_firms` — same gap |

### What to build

- **One `/auth/login`** that resolves any credential store, replacing three doors. The cross-surface
  fallback already proves the pattern; this generalises it and keeps one lockout counter per store.
- **One `/auth/me`** returning `{ personId, personas[], products[] }` — the single answer to "who is
  this and what may they see", which both repos read.
- **One profile surface**, rendered per persona, with `BorrowerProfilePanel` as the model the officer
  and TPO profiles adopt.

This is a facade over existing tables — the low-risk way to do it on a live system. No identity
migration is required for the split itself.

**Open item:** the owner's message says *"BataWare profiles"*. That term appears nowhere in the
repository. Everything described alongside it (personal information, email, track records, LLCs, ID
documentation, LLC documentation) is precisely what the borrower profile holds. Reading it as
**borrower** pending confirmation.

## 5. The in-flight long-term work

Every branch carrying unmerged LT commits, measured against `main`:

| Branch | PR | LT commits | Contents |
|---|---|---|---|
| `claude/loan-pipeline-architecture-5nql6q` | #1178 | 14 | LOS master plan, industry research, people map, pipeline foundation, **the product switch**, LT shell + screens (`LtLayout` / `LtPipeline` / `LtPeople` / `LtSync` / `LtConditions`), loan workspace, `src/longterm/{encompass,people,settings,sync,routes}`, `prisma/schema.prisma` (1,100 lines), 14 docs |
| `claude/encompass-field-mapping-l1cbvp` | — | 11 | LT Encompass research: investors, dropdowns, MISMO, terms/PITI, DSCR, the LOS loan application (db/548), design vision, the investor-name hard rule |
| `claude/lender-price-frontend-agent-tgxgcc` | #1180 | 1 | LT DSCR Quick Pricer — `src/longterm/dscr-pricer/` (quick-pricer.html 1,224 lines, pricing-desk.html, 3 design docs) |
| `claude/encompass-field-mapping-iflnzg` | — | 3 | Earlier Encompass milestone catalog + field pass — **superseded** |

**Key finding:** `loan-pipeline-architecture-5nql6q`'s `src/longterm/` tree is a strict superset of
`encompass-field-mapping-l1cbvp`'s (file-list diff: nothing in l1cbvp is absent from it). So the
consolidation is: pipeline branch as the base, cherry-pick the DSCR pricer on top. Nothing else needs
moving.

**Urgency:** the pipeline branch is 111 commits behind `main` and the pricer 66. Both rot daily.
Consolidate before extracting.

**Open item:** the owner referred to *"the campus branch"*. `claude/encampus-address-matching-bug-072g5f`
exists but holds one RTL commit (Encompass address reconcile) and no LT work. Reading "campus" as
**Encompass**, i.e. `encompass-field-mapping-l1cbvp` — which is already contained in the pipeline
branch. Confirm before Phase 1 completes.

## 6. Why this addresses the stated pain

| Pain | Today | After |
|---|---|---|
| CI weight | `npm test` is **892 chained steps**, one job, blocking every deploy | LT gets its own suite (~10–20 `test-lt-*`), under a minute |
| Conflicts | Every agent edits `src/server.js`, `package.json` (41 KB), `app-v2/src/App.jsx` | LT touches none of them |
| Deploy risk | One web service; an LT change redeploys live RTL | Two services; an LT deploy cannot reach production |
| Repo weight | 297 MB `.git`, 78 MB tree, 724 KB `CLAUDE.md` | LT starts near-empty with its own short rulebook |
| Parallelism | One working tree, one CI queue | Two of each |

## 6a. Risk register — measured, not assumed

Owner asked 2026-08-16: *"our entire short-term system now relies on the backbone, which is the
borrower's profile … how do we make sure this is not going to break … you add a new co-borrower, you
add a new borrower, you add new details, you add a new LLC, and it's added to the backbone. How will
that work?"*

### 6a.0 The premise to correct first: the profile does not move

The identity zone is not being extracted, copied, mirrored or synchronised. It stays in the short-term
repo, in the same database, with the same writers. Measured: **78 write statements across 19 modules**
touch `borrowers`, and every one of them stays exactly where it is.

**There is therefore no synchronisation problem, because there is no second copy.** Both products read
the same row of the same table:

| Action | Today | After the split |
|---|---|---|
| New borrower | `INSERT INTO borrowers` | identical |
| New co-borrower | `applications.co_borrower_id` → `borrowers(id)` | identical |
| New details | `UPDATE borrowers` through the one shared editor + `PATCH /api/staff/borrowers/:id` | identical |
| New LLC | `llcs` (FK `borrower_id`) + `llc_borrowers` join, via the one `findOrCreateLlc` chokepoint | identical |
| LT sees it | reads the same row | identical |

**And the database enforces the join, physically.** `db/549_lt_loan_application.sql` creates real
foreign keys — `lt_loans.borrower_id → borrowers(id)`, `lt_parties.borrower_id → borrowers(id)`,
`lt_loans.loan_officer_id → staff_users(id)` — each authorized by a `sql-ref` line in the ledger.
Postgres will refuse to let a long-term loan reference a borrower that does not exist. That is not a
convention someone has to remember; it is a constraint.

**The corollary is the reason §2.3 says one database, and it is structural rather than cautious:
foreign keys cannot cross databases.** Two databases is not a configuration change while those FKs
exist — they would have to be dropped and replaced with an application-level reference plus a
reconciliation job. Keep one database until there is a reason strong enough to pay that.

### 6a.1 The crossing surface today is five column names

The ledger authorizes eight crossings, but what LT's code *actually* touches right now is far smaller:

| Crossing | Authorized | In code today |
|---|---|---|
| `sql-read staff_users` | yes | **one query**, `people/roster.js` — `id, email, role, is_active, full_name` |
| `sql-read borrowers` | yes | **none yet** |
| `sql-write borrower_officers` | yes | **none yet** |
| `sql-ref borrowers` / `staff_users` | yes | 4 foreign keys (db/549) |
| `import src/auth/index.js` | yes | mount-time only, in `src/server.js` |
| `import BorrowerProfilePanel.jsx` | yes | **none yet** |

So the contract that has to hold across the repo boundary on day one is **five column names and four
foreign keys**. It will grow — but only deliberately, because the ledger requires per-item written
authorization before anything is added.

### 6a.2 The risks, ranked

**R1 — A silent schema break. (Highest.)** Today a rename of `borrowers.cell_phone` is caught because
LT's tests run in the same tree on the same PR. After the split there are two CIs, and RTL can rename a
column that LT depends on with nothing failing until somebody opens a long-term file.
*Mitigation:* put the guard on the side that can break it. An **identity contract** file naming every
column LT depends on, with a test in the **short-term** repo that reads `information_schema` and fails
the build if one disappears — plus a mirror test in the LT repo against a freshly-migrated schema. The
repo already has this pattern (`test-column-bounds-doors-db.js` reads `information_schema`;
`test-corrfirst-conditions-db.js` asserts a template is still active). **Build this before anything
moves** — see the revised Phase 2.

**R2 — Two migration runners on one database.** `ensureSchema()` has **no advisory lock**. It is safe
today only because exactly one process runs it: `src/worker.js` carries the explicit warning *"IT MUST
NOT RUN MIGRATIONS … concurrent migration on boot is a corruption hazard"*. A second service is
precisely that hazard. The `schema_migrations` ledger is keyed by `filename`, shared by both.
*Mitigation:* LT gets its **own** ledger table (`lt_schema_migrations`), its **own** runner that reads
only its own folder and refuses any file not named `*_lt_*`, and a **Postgres advisory lock** so the two
can never run concurrently. Plus a boot-order guard: an LT migration that adds an FK to `borrowers`
must wait for `borrowers` to exist (matters on a fresh test/staging database, never in production).

**R3 — Making the live site depend on a brand-new repo.** Extracting the design means the live
borrower portal's appearance is served from a package that did not exist last week.
*Mitigation:* **do not have RTL adopt it in the same step that creates it.** Create the design repo,
have **LT adopt it first** — LT is not live, so a mistake costs nothing — prove it, then RTL adopts.
Pin by exact commit, never a floating branch, so a design change can never reach production without a
deliberate bump PR.

**R4 — The separation gate goes half-blind.** It currently scans 2,081 files across both products in
one tree. Each repo will only see itself.
*Mitigation:* two mirrored gates. RTL's asserts *"no `src/longterm/` here, and nothing reaches into
LT"*. LT's asserts *"no RTL import, and no RTL table in SQL outside the ledger's `sql-read`/`sql-ref`
list"*. The ledger travels with LT — it is LT's permission slip — and RTL's gate does not need it.

**R5 — The extraction losing files.** `git filter-repo` with an incomplete path list drops files in
silence.
*Mitigation:* derive the path list from the gate's own definition of what LT owns (it already counts
them: 22 LT code files, 2 LT migrations), diff the extracted tree against the original file by file,
and **copy rather than move** — leave the LT folders in RTL with the router unmounted until LT has run
standalone for a soak period. That is also the rollback: re-mounting one line in `src/server.js`.

**R6 — Sign-in secret drift.** Both services must carry the same `JWT_SECRET`. Rotate one and not the
other and every user is bounced off one side, reported as "it logged me out".
*Mitigation:* treat it as a paired value in the runbook, and add a check to LT's health endpoint that
reports whether it can validate a token minted by short term. (`/api/health` already warns
`jwtStable:false` when the secret is unset entirely.)

**R7 — The shared profile panel.** The ledger authorizes LT's front end to import
`app-v2/src/components/BorrowerProfilePanel.jsx`. After the split that import is physically impossible
across repos. Nothing breaks today because it is not yet used — but it means the design repo is **not
optional**: it is where that panel must live for an already-granted authorization to remain usable.

**R8 — Document storage.** LT will eventually store documents in the same R2 account.
*Mitigation:* its own bucket prefix and its own scoped credential, following the rule already
established for backups — a credential that cannot address another area cannot damage it.

### 6a.3 What is explicitly NOT a risk here

- **Data drift between the two systems** — there is one row, not two.
- **A sync job falling behind** — there is no sync job.
- **LT corrupting a borrower record** — LT has no write path to `borrowers`, the gate refuses one, and
  the ledger authorizes writes to exactly one identity table (`borrower_officers`).
- **A borrower losing their files** — file visibility resolves through the same records it does today.

## 6b. External validation — what the industry actually does, and where it disagrees with us

Owner asked 2026-08-16 for validation against industry standards and against how Apple / Microsoft /
Google / the US military would build this. The honest answer has three parts, and the first one is a
challenge to this plan rather than support for it.

### 6b.1 The pushback: the biggest companies would not split this repo

**Google keeps ~2 billion lines in ONE repository. Meta does the same. Microsoft develops Windows in a
single Git repo.** The published rationale is atomic cross-cutting change: one commit updates the API,
its consumers and its tests together, and CI proves the whole thing. A polyrepo replaces that with N
pull requests and a hope that versions stay aligned.

**And "two deployables sharing one database" is the canonical microservices anti-pattern** — Sam
Newman's rule is that a service owns its data; a shared schema produces hidden coupling and schema
lock-in, and the classic failure mode is believing you have independent services when you have a
*distributed monolith*.

Both criticisms are real and neither should be waved away. Recorded here so nobody later discovers
them and concludes the plan was made in ignorance.

### 6b.2 Why the plan still holds — the three grounds, stated precisely

**(a) We are not building microservices, and must never start pretending to.** The shape being built is
two deployables over one governed data core — a *modular monolith with two deployment units*. The
literature endorses exactly this below Fowler's "microservice premium" threshold (commonly cited around
50–100 engineers): a single database transaction context, ACID guarantees, no sagas, no eventual
consistency, no distributed transactions. The anti-pattern bites when independent teams on independent
release cadences share a schema with no governance. Here the shared surface is **five column names and
four foreign keys** (§6a.1), has a **single writer**, and is governed by a per-item written-authorization
ledger that CI enforces. That is the opposite of an ungoverned shared schema.

**(b) The split is on a product boundary the owner has already declared**, not an arbitrary one. The
standard polyrepo criterion is independent product lines with different release cadences and different
risk profiles. RTL is live with real borrowers; LT is a not-live side build. The 2026-08-02 law already
states they are *"two different companies' software that happen to share one repository."*

**(c) The classic monorepo argument assumes human developers, and this codebase is not built that way.**
The literature's case for a monorepo rests on atomic refactors and shared tooling for people with IDEs.
The constraint here is different: many AI agents working in parallel, each of which must load a **724 KB
`CLAUDE.md`** and can physically reach every file in a **297 MB** repository. A repository boundary is
the strongest available blast-radius containment and the largest available context reduction. That is a
real 2026 justification the 2016 literature did not anticipate — and it is the owner's stated reason
("fewer conflicts, less heavy, easier to manage").

### 6b.3 The alternative, stated fairly

**One repo, two deployables, path-filtered deploys** would deliver deploy isolation *and* keep atomic
cross-cutting change *and* eliminate the schema-contract risk (R1) entirely, because both sides stay in
one CI. Combined with affected-target test selection it would also fix the 892-step problem. It is what
Google and Microsoft actually do.

**It does not deliver** the context reduction, the hard agent containment, or the independent history —
which are the owner's stated reasons. Recorded so the decision is informed, not so it is reopened.

**Either way, do §6b.4(3): affected-target CI is worth doing on its own merits and is not a
split/no-split question.**

### 6b.4 The hardening to adopt — named practices, each answering a specific risk

**1. Parallel Change (expand → migrate → contract) for every shared-schema change. [R1]**
Martin Fowler's pattern, and the direct answer to "a rename breaks the other side": *never rename or
drop in place.* Add the new column alongside the old, migrate both readers, and only then remove — the
governing rule being **"never remove something until nothing depends on it."** Make this a written rule
for every column in the identity contract, in the same class as the existing frozen-engine rules. Note
the discipline it demands: a contract phase that never runs leaves the schema worse than before.

**2. Consumer-driven contract testing with a `can-i-deploy` gate. [R1 — this supersedes my §6a proposal]**
My original mitigation was a one-directional `information_schema` guard. The industry standard is
stronger and bidirectional: the consumer (LT) publishes a contract describing exactly what it needs;
the provider (RTL) *verifies* it on every build; and **neither side deploys unless the broker confirms
the deployed pair is compatible.** Reported to catch several breaking deployments per month in real
use. Adopt the shape — LT publishes, RTL verifies, both gate on it — whether or not the Pact tooling
itself is used for a database contract.

**3. Affected-target CI. [the 892-step problem]**
Affected-only execution is documented as the single biggest lever on monorepo CI time — running 4
packages instead of 45 beats any caching optimisation. Do this regardless of the split.

**4. CODEOWNERS on the identity zone + a merge queue. [R1, and the conflicts pain]**
Put the identity tables, the auth module and the shared editor behind CODEOWNERS so no change to the
backbone can merge without a named human. This is also the separation-of-duties / two-person rule that
defence-grade process requires, expressed in a tool the repo already has.

**5. Progressive rollout and "roll back first, diagnose after." [R3, and the login unification]**
Google SRE's canarying: a partial, time-limited deployment evaluated before full rollout — reported to
catch the large majority of service-impacting issues before they reach everyone; and on unexpected
behaviour, **roll back first and diagnose afterwards to minimise time-to-recovery.** Apply to the three
moments this plan puts the live system at risk: RTL adopting the design package, the unified login, and
the domain routing cut-over. Each behind a kill switch, in the style the repo already uses everywhere
(`*_ENABLED` / `*_DISABLED`).

**6. Supply-chain integrity on the design package — the "military-grade" part. [R3]**
This is where the DoD/NIST answer is concrete rather than rhetorical. Once the live borrower portal
depends on a package from another repo, that package is a **software supply chain**, and pinning a
version is not sufficient on its own. NIST SSDF (the framework DoD software factories align to,
alongside NIST 800-53 / 800-37 / 800-190) covers the lifecycle practices; SLSA covers build integrity
and **provenance** — verifiable metadata about how an artifact was produced. Practically, in ascending
order of cost: pin by **exact commit SHA, never a branch or a range**; require **signed commits** on the
design repo; generate **build provenance** for the published package and verify it at install; keep an
**SBOM**. The first two are cheap and should be day-one.

**7. `git filter-repo` mechanics — the documented pitfalls. [R5]**
It replays every commit keeping only the paths you name, so history survives for `git blame` and audit.
Known traps to plan for: **branches and tags do not come across**; a folder that lived at **more than one
path across history** needs explicit path-rename rules or those commits are silently dropped (relevant
here — LT code has moved between layouts); and it requires **Git ≥ 2.22**. Do a dry run and diff the
extracted tree against the original file-by-file before trusting it, and keep the copy-don't-delete rule
(R5) as the real safety net.

**8. Do not drift toward microservices. [the standing rule]**
No event bus, no eventual consistency, no per-service schema, no saga, no sync job between the two
sides. If someone later proposes one of those, that is the moment this design has changed shape and the
trade-offs must be re-examined from §6b.1.

### 6b.5 Gate reviews — the defence-grade framing

The genuinely transferable military practice is not a technology, it is **defining the acceptance
evidence for a phase before the phase starts**. For each phase in §7, write down beforehand what
must be true to proceed, and do not proceed on judgement alone:

| Phase | Evidence required before proceeding |
|---|---|
| 2 — contract + guard | The guard demonstrably FAILS when a depended-on column is removed (mutation-tested, the standard this repo already holds its own tests to) |
| 3 — extract | Extracted tree diffed file-by-file against the original; LT boots and serves against the shared database; RTL unchanged with the router unmounted |
| 4 — remove | LT has run standalone for the agreed soak with no identity-related defect; rollback rehearsed at least once |
| 5 — design | LT on the package for the agreed soak; RTL adoption canaried, kill switch tested |
| 6 — login | Old and new doors run in parallel (Parallel Change); rollout staged; session revocation and MFA verified on both |
| 7 — routing | Switch verified in both directions with one session; both health endpoints green |

## 7. Phases

### Phase 1 — Consolidate the LT work (do first, urgent)
Rebase/merge `loan-pipeline-architecture-5nql6q` onto current `main`, cherry-pick the DSCR pricer,
verify the separation + Encompass read-only gates stay green, land it. **While still one repo** —
merging here is far cheaper and the existing gates protect it.

### Phase 2 — Build the identity contract and its guard, BEFORE anything moves
Write the contract file naming every identity column and foreign key LT depends on, plus the
`information_schema` test that fails the short-term build when one disappears (R1), and the mirrored
test in what will become the LT repo. **Land this while both sides are still one tree**, so the guard is
proven against the real schema before it has to work across a boundary. Also add the LT migration runner
changes (own ledger, own lock, own file filter — R2) while they can still be tested in one place.

This phase is the whole safety answer to "will this break the live system". Everything after it is a
move; this is the thing that makes the move detectable if it goes wrong.

### Phase 3 — Extract `yscap-longterm` — copy, do not delete
`git filter-repo` over the LT path set, history preserved:

```
yscap-repo-root_8/src/longterm/**
yscap-repo-root_8/app-v2/src/longterm/**
yscap-repo-root_8/docs/longterm/**
yscap-repo-root_8/db/*_lt_*.sql
yscap-repo-root_8/scripts/test-lt-*.js
```

New repo gets a **clean git root** (no `yscap-repo-root_8/` nesting), which also means its
`render.yaml` actually auto-applies — the live RTL service was created by hand precisely because the
nesting blocks blueprints. Copy the Encompass read-only gate across; LT is the largest Encompass
consumer and that rule is the hardest in the repo, and add the mirrored separation gate (R4).

**The LT folders stay in RTL, with the router unmounted** (R5). Nothing is deleted in this phase.

### Phase 4 — Soak, then remove
Run the LT service standalone against the same database until it is plainly working. Only then delete
`src/longterm/**` and the LT front-end folders from the short-term repo. Until that deletion, rollback
is re-mounting one line in `src/server.js`.

### Phase 5 — `yscap-design` — LT adopts first, RTL later
Extract tokens, primitives, brand, `ProductSwitch`, the profile-screen layouts (incl.
`BorrowerProfilePanel` — R7) and the shared display rules. **LT adopts it first**, because LT is not
live and a mistake there costs nothing (R3). RTL adopts only after that has held. Both consume it
**pinned to an exact commit**, never a branch.

### Phase 6 — Unified login + unified profiles
One `/auth/login`, one `/auth/me`, one profile surface per persona. Built as a facade; no identity
migration.

### Phase 7 — Domain routing + the switch
Path routing in front of both services (`/` and `/portal/*` → short term, `/lt/*` → long term), shared
`JWT_SECRET` (R6), switch becomes a hard navigation.

### Phase 8 — Cleanups (later)
Flatten `yscap-repo-root_8/` in the short-term repo once the open drafts drain. A second database is
**not** a config change while the four cross-product foreign keys exist (§6a.0) — reopen only with a
reason strong enough to pay for replacing them.

## 8. What not to do

- **Do not split the database on day one.** No stated goal requires it; it converts a table read into a
  network call on a live system.
- **Do not build a standalone auth service.** That re-plumbs live production sign-in to serve a side
  build that is not live.
- **Do not flatten `yscap-repo-root_8/` yet.** Ten open PRs would conflict on every path at once.
- **Do not copy RTL code into LT during the move.** The written-authorization ledger rule still applies
  in full, and the gate cannot see a copy-by-value. That discipline is what made this split possible.

## 9. Open questions for the owner

1. **"BataWare"** — confirm this means **borrower**.
2. **"The campus branch"** — confirm this means the Encompass long-term work
   (`encompass-field-mapping-l1cbvp`), which the pipeline branch already contains.
3. **A third repo for the shared design** — approve, or accept that the two sides will drift apart
   visually.

Phase 1 is worth starting regardless of the answer to (3).
