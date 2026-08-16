# Keeping the schema map fresh without a human remembering

**Status:** research, nothing built. Written 2026-08-16 at the owner's request —
*"real research on how Microsoft/Google/the military would build it before it is written."*

The question on the table is item (a) of the agreed next build:

> CI regenerates the schema map itself after each merge to main and commits it
> back, scoped to `docs/schema` only, with `[skip ci]` so it cannot re-trigger a
> deploy.

This document does not build that. It measures what this repository actually
does, reports what three organisations that take this seriously actually do,
and then costs four designs — including the one asked for. **The recommendation
is not the design in the request**, and the reasoning is set out in full so the
owner can overrule it.

---

## 1. Why this is worth building at all

The map (`docs/schema/`) is regenerated from a database built by the migrations.
It goes stale the moment a migration lands and nobody re-runs it.

Measured on `origin/main`, 60 days to 2026-08-16:

| | |
|---|---|
| migrations in `db/` | 553 |
| added in the last 60 days | 550 |
| commits that add at least one migration | **362** |
| all commits on main | 1,481 |
| **migration-bearing commits per day** | **~6** |

**Roughly six times a day, something lands that can move the map.** That is not
an occasional event to be handled by remembering; at that rate a manual step is
forgotten by construction. Automation is justified. The rest of this document is
only about *which* automation.

One more measurement decides more than any other:

```
98 of the last 100 commits on main carry a "(#NNNN)" subject  → squash-merged from a PR
only 6 of 362 migration commits are merge commits             → migrations arrive inside PRs
```

**Every migration reaches main through a pull request.** So there is a moment,
before anything is on main, when the change that invalidates the map is sitting
in a branch with CI attached to it. That moment is the cheapest place to fix the
map, and it is upstream of every problem discussed below.

---

## 2. What the request would actually touch

| fact | value | why it matters |
|---|---|---|
| `schema:snapshot`, `schema:map` | **need a live database** | so the refresh can only run in `test-db`, ~25 min into the run |
| `schema:picture`, `schema:restamp` | pure, no database | these could run anywhere |
| workflow triggers | `pull_request`, `push:[main]`, `schedule`, `workflow_dispatch` | a push to main is a deploy trigger |
| `deploy` job | `needs: [test, test-db]`, `if: push && ref == refs/heads/main` | **anything that lands on main is a deploy candidate** |
| `permissions:` in `test.yml` | **absent — none declared** | the workflow holds no write grant today, anywhere |
| third-party actions | `actions/checkout@v4`, `actions/setup-node@v4`, `actions/upload-artifact@v4` | each inherits whatever the job is granted |
| gap between commits on main | median **34 min**, p90 187 min, **min 0** | concurrent landings happen |

The last two rows are the ones that make "commit back to main" more expensive
here than it looks.

---

## 3. What serious organisations actually do

### Google / Kubernetes — CI *verifies*, humans *regenerate*

Kubernetes' `hack/verify-codegen.sh` is the canonical treatment of a checked-in
generated file. It copies the tree to a temporary directory, regenerates, and
diffs. **On failure it writes nothing.** It exits non-zero and prints:

> Generated files need to be updated … Please run `hack/update-codegen.sh`

The generated artefact is committed — but always by the human, inside the same
reviewed pull request as the change that invalidated it. CI's job is to make it
impossible to forget, not to do it. This is the pattern behind `make verify` /
`make update` across the Kubernetes ecosystem and Google's presubmit culture
generally.

**What that buys:** the generated file is always in a reviewed commit,
attributable to a person, alongside the change that caused it. CI needs no write
access to anything.

**What it costs:** the author must be able to regenerate — which here means
having a Postgres to hand.

### Microsoft (Azure SDK) — the bot opens a **draft pull request**

Azure's SDK generation pipeline regenerates client code from the API
specifications and then opens a PR titled `[Automation] Generate … SDK for
<module>` — **as a draft**, for a human to review and merge. Microsoft runs this
at far greater volume than six times a day and still does not have the bot push
to the trunk.

Dependabot and Renovate are the same shape, and it is the shape most automation
that must *write* converges on: the bot writes to a branch it owns, and the
trunk is only ever changed by a merge.

### Defence / supply-chain standards — writes to the trunk are the controlled thing

The NIST NCCoE DevSecOps reference model has artefacts reviewed *"by other tools
and team members prior to merging changes into relevant branches."* SLSA's Source
Track puts two-party review on protected branches at its top level, and — the
part that bears directly here — requires the producer to **track every actor who
can control a privileged bot**, because influencing a robot account with commit
rights is named as a standard attack path.

The consistent principle across all three is not *"never automate"*. It is
**automation proposes; the protected branch is changed by review.** The trunk is
the control point precisely because everything downstream trusts it.

### And the pattern the request describes

CI committing straight back to main is real and widespread — `git-auto-commit-action`
and friends — but it is a small-repository pattern. None of the three references
above use it for the trunk. It is worth knowing why, and two of the reasons are
mechanical rather than philosophical.

---

## 4. Four mechanics that decide this

### 4a. `[skip ci]` is not what stops the deploy — the token is

GitHub's documented rule: **when a workflow uses the repository's `GITHUB_TOKEN`
to push, that push does not create a new workflow run.** Loop prevention is built
in. So with `GITHUB_TOKEN`, `[skip ci]` is belt-and-braces, not the mechanism.

The trap is the other direction. Branch protection commonly refuses
`GITHUB_TOKEN` pushes, and the usual fix is a GitHub App token or a PAT — and
**those do re-trigger workflows.** The moment someone makes that swap to get past
a protection rule, every schema commit fires `push: branches:[main]`, which means
926 tests and — because `deploy` needs only `test` and `test-db` — **a production
deploy, six times a day, for a docs change.** `[skip ci]` in the commit message
is what stands between that swap and a deploy loop, which is a good reason to
write it even though it is redundant today.

This is worth stating plainly: *the safety of the requested design depends on a
token choice that a future maintainer would reasonably change for an unrelated
reason.*

### 4b. Main's HEAD would stop being a commit that CI ran on

A `[skip ci]` commit on main is, by definition, a commit no test run covers and
no deploy corresponds to. The product code is identical — the map is docs — so
nothing ships wrong. But "what is deployed is main's HEAD" stops being true about
six times a day, and the deploy gate this branch has just spent considerable
effort proving byte-identical becomes a gate that main's tip routinely bypasses.
That is a real cost even when the content is harmless.

### 4c. The write grant is the largest single change in the proposal

`test.yml` declares **no `permissions:` block at all** today. Adding
`contents: write` to `test-db` would be the first write grant in this workflow —
and it would be held by the job that runs 926 test steps, i.e. the job that
executes the most repository-controlled code. Current guidance on Actions
hardening is uniform: a compromised workflow inherits its token's permissions, so
`contents: write` on a job that runs the test suite is the permission you least
want to grant.

Blast radius is the honest way to compare the options:

| design | token can write to | if the job is compromised |
|---|---|---|
| commit to main | **the trunk** | attacker writes to main directly |
| push to the PR branch | one feature branch | attacker writes to a branch that still needs a merge |
| bot opens a PR | a bot-owned branch | same, plus the PR is visible |
| verify only | nothing | nothing |

### 4d. The race is not theoretical here

The refresh can only run after the migrations are applied — about 25 minutes into
`test-db`. The measured gap between consecutive commits on main is **median 34
minutes, p90 187, minimum 0**. The push window and the inter-commit gap are the
same order of magnitude, so `git push` losing a race to a non-fast-forward is a
routine event, not an edge case. Any commit-to-main design needs fetch/rebase/retry
with backoff — and, because another run may have already refreshed the map, it
must **re-check staleness after rebasing** rather than blindly re-pushing.

That is all solvable. It is just more moving parts than the request implies, on
the trunk, in the job that has no write access today.

---

## 5. The property that makes a better design available

**The map is a pure function of `db/*.sql`.** Same migrations in, byte-identical
map out — that is what `check-schema-behind` and the header test already rely on.

Three consequences:

1. Two runs regenerating from the same migrations produce the same bytes, so
   last-writer-wins is *correct*, not merely tolerable.
2. It can be regenerated by anyone, at any time, from committed inputs.
3. **It can be regenerated before the migration reaches main at all.**

Point 3 is the one the request leaves on the table. Every migration arrives in a
PR (98 of the last 100 commits). If the map is refreshed there, main is never
stale — so there is nothing for a bot on main to fix.

---

## 6. Four designs, costed

### A. Verify-only on the PR (Kubernetes' answer)

`test-db` regenerates into a scratch directory and **fails the PR** if
`docs/schema/` disagrees, printing `npm run schema:snapshot && npm run
schema:restamp`.

*For:* no token, no race, no loop, no trunk write. Every byte of the map stays in
a reviewed commit. It is what the largest projects do.
*Against:* the author needs a local Postgres to comply, and a docs staleness
becomes a blocking failure roughly six times a day. With agents doing most of the
work, that is six interruptions a day to fix a file nobody reads during the fix.

### B. CI pushes the refreshed map to **the PR branch** ★ recommended

`test-db` regenerates; if stale, it commits *only* `docs/schema/` and pushes to
the head branch of the PR that is being tested — **never with force.** If the
branch has moved (non-fast-forward), it does not retry into a fight: it falls
back to today's behaviour, attaching the artefact and emitting the warning.

*For:* the map lands in the same PR as the migration that moved it, so it is
reviewed and attributable — Google's property, without needing a database on the
author's machine. Main is never stale, so the trunk needs no bot at all. The
write grant is scoped to a feature branch. The race disappears: the map is a pure
function, so whichever run pushes last is right.
*Against:* it writes to a branch an agent may be actively pushing to. **This is
the objection the current branch already recorded as its reason for not
committing back** — and it is a real one. The answer is that refusing to force is
sufficient: a losing push changes nothing and degrades to exactly today's
behaviour. No agent's work can be destroyed by a push that is never forced.
Also: with `GITHUB_TOKEN` the push does not re-run CI, so the PR's own green
checks would predate the map commit — acceptable for docs, but it should be
stated, not discovered.

### C. Bot opens a draft PR against main (Microsoft's answer)

After a merge to main, if stale, push `docs/schema/` to a bot branch and
open/update a draft PR.

*For:* trunk untouched, fully auditable, the PR runs its own CI, and the branch
is a scratchpad so repeated runs simply overwrite it.
*Against:* about six PRs a day to merge, for a file whose content nobody
disputes. Realistically those get auto-merged, at which point the review is
ceremonial — and if it is ceremonial, C is B with more steps.

### D. Commit directly to main with `[skip ci]` (as requested)

*For:* nothing to merge, main is authoritative within ~25 minutes of any
migration, and it is the least work to describe.
*Against:* everything in §4 — a write grant on the trunk held by the test job
(§4c), main's tip routinely uncovered by CI (§4b), a rebase-retry loop against a
34-minute median gap (§4d), and a safety property that silently depends on the
token remaining `GITHUB_TOKEN` (§4a).

---

## 7. Recommendation

**Build B, and add A's gate as the backstop.**

- **B** puts the refresh where the cause is, which is the property all three
  reference organisations are protecting when they refuse to let a bot write to
  the trunk — the generated file stays inside a reviewed change. It removes the
  need for the main-side bot entirely, and with it §4a, §4b and §4d.
- **A** as a non-blocking check on main answers "did B ever silently stop
  working?" — because a refresh that quietly fails looks identical to one that
  had nothing to do, which is the exact failure this branch already fixed once in
  the advisory step.

If the owner prefers D as asked, it is buildable and the risks are manageable —
but it should then carry, at minimum: an explicit `permissions: contents: write`
on `test-db` alone (never workflow-level), a hard assertion that the commit
touches nothing outside `docs/schema/`, `[skip ci]` in the message even though it
is redundant today, fetch/rebase/**re-check**/retry with backoff, and a test that
fails if the token is ever changed to one that re-triggers workflows.

## 8. What would have to be proven before any of it ships

Same standard as everything else on this branch — each check proven to fail, with
an unmutated control green either side:

1. A commit touching a file outside `docs/schema/` is **refused** (mutate the
   path filter; the guard must go red).
2. A losing race changes nothing and falls back to the artefact — no force, ever.
   Prove it by moving the branch under the job.
3. The refresh being *broken* is distinguishable from having *nothing to do* —
   the failure this branch already found once and must not reintroduce.
4. The deploy job does not fire for a map commit, proven against the real
   workflow rather than by reading it.
5. Regenerating twice from the same migrations produces identical bytes — the
   purity the whole design rests on, currently assumed and never asserted.

---

## Sources

- [GITHUB_TOKEN — GitHub Docs](https://docs.github.com/en/actions/concepts/security/github_token) and [Triggering a workflow — GitHub Docs](https://docs.github.com/actions/using-workflows/triggering-a-workflow) — pushes made with `GITHUB_TOKEN` do not create new workflow runs; App tokens and PATs do.
- [kubernetes/hack/verify-codegen.sh](https://github.com/kubernetes/kubernetes/blob/master/hack/verify-codegen.sh) and [hack/update-codegen.sh](https://github.com/kubernetes/kubernetes/blob/master/hack/update-codegen.sh) — verify reports and exits non-zero; it never writes.
- [Azure SDK for Java — generation pipeline opens a draft PR](https://github.com/Azure/azure-sdk-for-java/wiki/Protocol-Methods-Quickstart-with-AutoRest) and [AutoRest and OpenAPI: the backbone of Azure SDK](https://devblogs.microsoft.com/azure-sdk/code-generation-with-autorest/).
- [NIST NCCoE — notional reference model for DevSecOps](https://pages.nist.gov/nccoe-devsecops/notational-reference-model.html) and [DoD Enterprise DevSecOps Reference Design](https://dodcio.defense.gov/Portals/0/Documents/Library/DevSecOpsReferenceDesign.pdf) — review before merging to protected branches.
- [SLSA v1.2 Source Requirements](https://slsa.dev/spec/v1.2/source-requirements) and [SLSA Threats & mitigations](https://slsa.dev/spec/v1.2/threats) — two-party review on protected branches; actors who control privileged bots must be tracked.
- [Wiz — GitHub Actions security guide](https://www.wiz.io/blog/github-actions-security-guide) and [GitGuardian — Actions security cheat sheet](https://blog.gitguardian.com/github-actions-security-cheat-sheet/) — a compromised workflow inherits its token's permissions; grant least privilege per job.
- [Bypassing required reviews using GitHub Actions](https://medium.com/cider-sec/bypassing-required-reviews-using-github-actions-6e1b29135cc7) and [Allowing github-actions[bot] to push to a protected branch](https://github.com/orgs/community/discussions/25305) — why the token gets swapped, and what that swap turns on.
- [Git Rebase Push action](https://github.com/marketplace/actions/git-rebase-push) — the rebase-retry loop concurrent trunk writes require.
