# PILOT ↔ Encompass — Plain-Language Owner Brief

**For:** the owner. **From:** the research work on this branch. **Date:** 2026-07-20.
**Status:** Research and planning are finished. **No code has been written and nothing has touched Encompass.** Everything is now waiting on a handful of things only you (or Encompass's own support team) can provide. This page lists exactly those things, in everyday language.

> The detailed engineering versions of everything below live in the seven `ENCOMPASS-*.md` documents in this same folder. This page is the plain-English summary so you can act without reading the technical ones. If a word here needs a technical source, the matching technical doc is named in parentheses.

---

## 1. What this is, in one paragraph

Encompass is the system your ops team actually works loans in — where they open a file, tick off conditions, and get "clear to close." Today PILOT doesn't know anything Encompass knows; a staff member types Encompass's status into the portal by hand. The plan on this branch is to let PILOT **read** from Encompass automatically, so the portal shows the real, live loan status instead of a hand-typed guess — and eventually so PILOT won't let a file be marked "clear to close" unless Encompass agrees.

**The safety promise:** this is **read-only, one direction only**. PILOT reads from Encompass and never writes back — no edits, no uploads, nothing. That is deliberate. The ClickUp connection last month wrote in both directions and scrambled real data within half an hour of going live. A read-only connection **cannot damage Encompass at all**, because it never changes anything there. (Full reasoning: `ENCOMPASS-READONLY-GUARDRAILS.md`.)

---

## 2. Where things stand

- ✅ **The research is done** — how Encompass works, what's safe to read, how to match its loans to PILOT files, and a step-by-step build plan.
- ✅ **The safety design is done** — the read-only rule and five backup layers behind it.
- ⏸️ **Nothing is built, and building is paused on purpose** until you give a clear go-ahead.
- ⏳ **The hold-up is inputs, not work.** There are about 30 open questions, and almost none can be answered by more research — they need either a decision from you, a fact only you have, or an answer from Encompass's support team. This page is how we get those.

---

## 3. First and most urgent: one password needs to be reset

On July 17 you pasted the Encompass login secret into the chat so the research could use it. As a strict safety rule, **any password shared in a chat is treated as burned and must be reset before anyone uses it.** It was never saved into any file or used to call Encompass — but it still has to be regenerated.

**What you do:** in Encompass's "API Key Management" screen, click **Regenerate Secret**, and hand the new value straight to whoever sets up the server's settings — not through chat or email. Heads-up: regenerating it will break any *other* tool currently using that same key, so pick a moment when that's fine. (Technical detail: `ENCOMPASS-INTEGRATION-RESEARCH.md` §6, Decision D7.)

---

## 4. What I need from you to unblock the build

Three buckets. None of them is code — they're setup, questions, facts, and a few decisions.

### Bucket A — A few things only an Encompass administrator can set up

These are clicks inside Encompass that only a super-administrator can do (your Encompass admin, or ICE support walking you through it):

1. **Get the API key** (the Client ID + the reset secret from §3) and give both to whoever configures the server settings — directly, never through chat.
2. **Make a dedicated "robot" login** for the portal (e.g. `ysportal.svc`) — a normal user login. *Do not* tick the "API User" box on it (that box is for a different kind of partner and would break how we log in).
3. **Give that login a "look, don't touch" role** — a permission profile that can read loans but not change them. Do **not** reuse the Super Administrator login for this (that one ignores the very rules that keep us read-only).
4. **Set that role to "View Only" for loans**, and double-check it isn't accidentally hiding fields the portal needs to read.
5. **Budget one user seat** for the robot login, and make sure its **password won't auto-expire** — a surprise forced password change is the most common way this kind of connection quietly dies.

(Technical version with the exact screen names: `ENCOMPASS-INTEGRATION-RESEARCH.md` §6.)

### Bucket B — Four questions to ask your ICE / Encompass account manager

Their answers shape the design. Ask them:

1. **"Do we have a test/sandbox instance included in our contract?"** — Without a practice copy, all the early testing would run against real borrowers' live data, which we'd rather avoid. This is the single most important answer.
2. **"What are the speed limits on our account?"** — How many reads per minute we're allowed, and who else is already using that budget, so our reading never crowds out your ops team.
3. **"Is using the API to feed our own borrower portal an approved use?"** — Just confirming in writing that this is a sanctioned use of the connection, plus any seat/billing note.
4. **"How do the login tokens and key rotation work?"** — Timing details, and whether we can briefly hold two keys during a reset so there's no downtime. (This is a planning nicety, not a blocker.)

(Full list and why each matters: `ENCOMPASS-INTEGRATION-RESEARCH.md` §6 and §10, items OQ-01 through OQ-04.)

### Bucket C — Three facts only you have

These set the legal/compliance guardrails (data-retention rules, which regulators apply):

1. **Which states does YS Capital lend in?** — decides which privacy/breach rules apply.
2. **Roughly how many borrowers/consumers do we have on file** — above or below 5,000 changes which written data-protection rules apply.
3. **Who is the person who formally signs off** on "here's exactly which borrower fields we'll pull and how long we keep them"? (In compliance terms, the "Qualified Individual.")

(Technical version: `ENCOMPASS-INTEGRATION-RESEARCH.md` §10, items OQ-05 through OQ-08; `ENCOMPASS-READONLY-GUARDRAILS.md`.)

### Bucket D — A few yes/no decisions (with our recommendation)

You can just pick; each has a recommended answer so it's an easy call:

| Decision | Plain question | Recommended answer |
|---|---|---|
| **Webhooks** | Should Encompass "push" instant updates to us, or should we just check on a schedule? | **Check on a schedule** for now. Pushing adds moving parts and its own risks; start simple. (OQ-26) |
| **Auto-verify track records** | If Encompass shows a loan *we* funded, should PILOT auto-trust the borrower's track record from it, or keep a human sign-off? | **Keep the human sign-off** for now. (OQ-27) |
| **Borrower-facing** | Should borrowers see the Encompass-driven status too, or staff only at first? | **Staff only** at first. (OQ-28) |

(All three, with reasoning: `ENCOMPASS-IDEAS-AND-ROADMAP.md` §9.)

---

## 5. What happens after you come back with those

Once §3–§4 are answered, building goes in small, reversible stages — each one can be switched off instantly, and none of them ever writes to Encompass:

- **Stage 0 — Setup.** The items in Bucket A, done. No code yet.
- **Stage 1 — Dry run.** The portal quietly reads a few loans and logs "here's what I *would* show" — still changing nothing.
- **Stage 2 — Quiet mirror.** It starts saving Encompass's status alongside each file, with a review card whenever it's unsure which loan matches which file.
- **Stage 3 — Shadow check.** The portal's "clear to close" check starts *noticing* when Encompass disagrees, but only logs it — it doesn't block anything yet, so we can see how often it'd be right.
- **Stage 4 — Live gate.** Only after two clean weeks: the portal actually holds a file back if Encompass hasn't cleared it.
- **Stage 5 — Later, one decision at a time.** Optional extras, each needing your separate go-ahead.

(Full table: `ENCOMPASS-INTEGRATION-RESEARCH.md` §8. Build steps for engineers: `ENCOMPASS-BUILD-BLUEPRINT.md`.)

---

## 6. The one promise that never changes

Through every stage above, **PILOT never writes to Encompass.** Not a status, not a note, not a document — nothing. The connection is a window you look through, not a remote control. That's what makes it safe, and it's the one thing that will not be traded away for convenience. (`ENCOMPASS-READONLY-GUARDRAILS.md`.)

---

_Nothing described here is built. This page is the owner-facing summary of the research on this branch; the seven `ENCOMPASS-*.md` documents carry the engineering detail, and `encompass-research/` holds the raw findings behind them._
