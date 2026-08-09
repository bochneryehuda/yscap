# Repo upgrade-history audit — did any work fail to survive into main?

_Run 2026-08-09 against `origin/main` @ `3d97df1` (#989). Engine:
`scripts/repo-history-audit/run-audit.sh`._

The question this answers: **across every upgrade ever made to this repo, is
there work that was done and then lost — clobbered by a branch that merged on
top of it without pulling first?**

**Answer: no work was lost that way. Zero stale-base clobbers.** The details,
including the several things that *looked* lost until checked, are below.

---

## 0. A blocker that had to be cleared first

The working clone was **shallow** — 50 commits, its history starting at #889,
with `main` pinned to a stale `#942`. Every survival number computed from it
would have been wrong, and the branch would have looked like it had diverged
from `main` when it had not.

`git fetch --unshallow --tags origin` restored the real history: **1345
commits, 96 merges, 273 branches, first commit 2026-07-05.** The engine now
refuses to run against a shallow clone rather than emit confident wrong
answers.

---

## 1. Scope covered

| | |
|---|---|
| Commits on `main` | 1345 |
| PRs landed on `main` | 1010 (numbered #1 – #1065) |
| Merge commits | 96 |
| Remote branches | 273 |
| History | 2026-07-05 → 2026-08-08 |

**Authorship — this is the finding that settles the question:**

| Author | Commits |
|---|---|
| bochneryehuda | 1060 |
| Claude | 284 |
| moses bochner | 1 |

There is effectively **one human** on this repository. The premise "somebody
else merged without them" has no second party to be true of. The single
outside commit is `2fffa26` (2026-07-17, "sms terms update", 4 files, +9/−3) —
a self-contained legal-copy edit that touched nothing anyone else was working
on.

---

## 2. Line survival

For every commit, lines it wrote vs. lines of its still alive in `main` today
(`git blame` tally against `git log --numstat`), excluding built bundles,
lockfiles and binaries.

| Era | Lines added | Still in main | Survival |
|---|---|---|---|
| 2026-07 | 780,715 | 463,230 | 59.3% |
| 2026-08 | 187,334 | 166,911 | 89.1% |
| **Overall** | **968,049** | **630,141** | **65.1%** |

65% overall with a rising trend is a healthy signature for a product rebuilt
mid-flight (the v1 → v2/PILOT migration lands squarely in July). It is *not* a
signature of lost work — as section 3 confirms case by case.

---

## 3. The things that looked lost, and what they actually were

Line survival is a proxy: a feature that was **re-implemented** shows 0%
survival even though the behaviour is intact. Every commit with ≥50 added
lines and zero survivors was therefore checked by hand. All of them resolved
to deliberate supersession:

| Work | Verdict |
|---|---|
| **#270** — staff file's Activity section collapsed by default | **Intent survived.** Activity is now a tab inside the "Communication & history" hub (`commTab === 'activity'`), which is collapsed-until-clicked by construction. |
| **#149** — interest-reserve logic synced into 4 engine copies | **Deliberately deleted** by **#984**, "Stop the term sheet generator shipping our guidelines and capital-partner names to browsers" — a security removal. The rule itself is alive: `web/tools/gold-standard.js` still reads _"Renovation (Light/Heavy Reno) may NOT finance an interest reserve."_ |
| **#821-era** — retry-safe finding resolve + decide | **Moved server-side and improved** by **#799**. The client's two-call 404/409 tolerance is gone because the server now returns `reason: 'already_resolved'` and `escalationClosed: false`. |
| **Nav** — training-proposals sidebar link | **Consolidated, not dropped.** `/internal/training` redirects to `/internal/ai?tab=training`; the AI Command Center owns it. |
| **#289** — digit-only phone/ZIP on the marketing form | **Intact in both copies.** `web/tools/` and `web/v2/tools/` are symmetric (71 `inputmode` each) — the exact two-copy drift the handoff doc warned about did not happen. |

---

## 4. Clobber detection — the direct test

For every commit, the lines it **deleted** were blamed against its parent to
identify whose work was erased, then filtered to erasures the erasing commit
never referenced.

**226 candidate pairs. Zero clobbers.** They fall into two groups, both
intentional:

- **Same workstream, 0–2 hours apart** — consecutive commits on one branch
  refining themselves, usually saying so outright: #803 → #802 ("plus the
  audit fixes on #802"), #804 → #803 ("Second-round audit fixes"), #542 → #541
  ("Post-merge audit fixes"), #939 → #936 ("remove it from the pipeline home
  page").
- **Weeks apart (400–700h)** — deliberate later rewrites: #984 removing the
  browser-shipped pricing engines, #992 replacing SharePoint sync internals,
  successive redesigns retiring the "v2 Stage 3" reskin.

A stale-base clobber requires a **short** gap — a branch cut before the work
landed and merged after. The long-gap erasures are the opposite: authored
weeks later, on purpose.

### Merges that discarded a side

Seven merges produced a tree identical to their first parent, meaning they
took nothing from side two — all from 2026-07-05/06:

`80aaef4` (#68) · `0805d7f` (#64) · `438ed91` (#60) · `77edd60` (#57) ·
`4a62bca` (#6) · `41504bf` (#5) · `00a580a`

**All benign.** In each case side-2 was already fully contained in side-1 at
merge time (0 differing files) — the branch had been brought up to date first,
so the merge was correctly a no-op. Spot-checked against today's tree: Chat v3
(`ChatThread.jsx`), `DocPreview.jsx`, and the Gold Standard renovation rule are
all present.

---

## 5. The last merge

`3d97df1` (#989), 2026-08-08 22:59 — _"Second post-merge audit: a quoted table
name still slipped the refused write, and English labels read as SQL."_ Three
files, +98/−17, confined to the product-separation gate and its charter doc.

**It carries no comments at all** — no issue comments, no review threads,
nothing outstanding. Nothing was left behind on it.

---

## 6. Where the "few hundred comments" actually are

They are **not on GitHub**. The platform holds:

- **38 PRs** with any comment, **maximum 2 each** (~40 comments total)
- **0 issues**
- **0 review threads**

The `(#81)`, `(#112)`, `(#56)`-style references throughout commit *titles* are
the **owner's own punch-list numbering**, delivered by chat and recorded in
commit messages — **171 distinct items** appear in subject lines alone, more in
bodies. That numbering is why an audit that only reads GitHub comments finds
almost nothing.

**Consequence, stated plainly:** requested enhancements can be traced through
commit messages and code, which this audit did — but the original request
wording lives outside the repository. Anything never written into a commit
message is beyond what git or the GitHub API can reach from here.

---

## 7. Work that genuinely never reached main

The one real category of "did not survive" — **11 PRs still open**, 8 of them
drafts idle for weeks:

| PR | Opened | Title |
|---|---|---|
| #319 | 07-17 | Credit report reissue + FICO verification (Xactus) — Phases 1a–1e + E1–E8 |
| #366 | 07-19 | Azure Document Intelligence + GPT-5 reasoning clients |
| #821 | 07-27 | A decision remembers the severity it was made at — closing the false clear #818 left live |
| #901 | 07-30 | Website content protection (marked "NOT for merge yet") |
| #997 | 08-03 | Issue #7 phase 1: teach the server to answer everything the studio asks the engines |
| #1018 | 08-04 | TPO broker portal — Phases 1–6e |
| #1060 | 08-07 | Class Valuation (2nd appraisal vendor) |
| #1066–#1069 | 08-09 | In flight |

**#821 is the one worth attention**: opened 2026-07-27 and untouched since,
its own title says it closes a false clear that **#818 left live** in `main`.
If that is still true, a known defect has been sitting in production for two
weeks with the fix parked in a draft.

Also still open by the repo's own record — `docs/HANDOFF-REMAINING-WORK.md`
(2026-07-15), never revised since 07-16, listing **#66** (ClickUp CRM ↔ lead-CRM
sync, blocked on board structure) and **#68**/**#75** (blocked on Resend inbound
domain config). These are blocked on decisions and configuration, not lost code.

---

## 8. Limits of this audit

- Line survival is a proxy. Section 3 hand-verified every zero-survival
  commit ≥50 lines; smaller ones were not individually reviewed.
- Clobber detection reads the top 5 erased-work sources per commit at a ≥25
  line threshold. A clobber smaller than that would not surface.
- Only `origin/main` was walked. Work living solely on one of the other 272
  branches is out of scope except where it appears as an open PR.
- Request wording that was never committed cannot be recovered from here.

## Re-running

```bash
git fetch --unshallow --tags origin      # only needed once, on a shallow clone
scripts/repo-history-audit/run-audit.sh  # writes to /tmp/repo-history-audit
```
