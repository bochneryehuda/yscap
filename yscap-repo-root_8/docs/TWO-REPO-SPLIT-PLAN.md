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

## 7. Phases

### Phase 1 — Consolidate the LT work (do first, urgent)
Rebase/merge `loan-pipeline-architecture-5nql6q` onto current `main`, cherry-pick the DSCR pricer,
verify the separation + Encompass read-only gates stay green, land it. **While still one repo** —
merging here is far cheaper and the existing gates protect it.

### Phase 2 — Extract `yscap-longterm`
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
consumer and that rule is the hardest in the repo.

### Phase 3 — `yscap-design`
Extract tokens, primitives, brand and `ProductSwitch`. Both repos consume it as a pinned git
dependency.

### Phase 4 — Unified login + unified profiles
One `/auth/login`, one `/auth/me`, one profile surface per persona. Built as a facade; no identity
migration.

### Phase 5 — Domain routing + the switch
Path routing in front of both services (`/` and `/portal/*` → short term, `/lt/*` → long term), shared
`JWT_SECRET`, switch becomes a hard navigation.

### Phase 6 — Cleanups (later)
Flatten `yscap-repo-root_8/` in the short-term repo once the open drafts drain; optionally move LT to
its own database (a config change by design).

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
