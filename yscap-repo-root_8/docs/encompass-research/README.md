# Encompass Integration — Research Corpus & Handoff Index

**Date:** 2026-07-19 · **Status:** RESEARCH / DESIGN ONLY — no code exists, no Encompass call was ever made, nothing is merged. This folder is the **complete working memory** behind the seven polished Encompass documents in `../` (the parent `docs/` folder). It is committed so **another AI agent (or engineer) can continue this branch with full context** — every raw finding, the endpoint classification, and the QA history that produced the final docs.

> ⚠️ **Before any real work:** the Encompass Developer Connect **client secret** the owner shared in chat on 2026-07-17 is treated as **burned** and must be **regenerated** in ICE's API Key Management before first use. It appears in **no** file here or anywhere in the repo. Never commit any secret.

---

## Start here (reading order for whoever continues)

0. **`../ENCOMPASS-OWNER-BRIEF.md`** — the plain-language owner summary: what this is, and the exact setup steps, ICE questions, facts, and yes/no decisions needed from the owner to unblock the build. Read this to the owner; everything below is engineering detail.
1. **`../ENCOMPASS-INTEGRATION-RESEARCH.md`** — the master plan + the canonical open-question tracker (OQ-01…OQ-31). Read first.
2. **`../ENCOMPASS-READONLY-GUARDRAILS.md`** — the write-freeze doctrine. **Mandatory** before touching any Encompass code.
3. **`../ENCOMPASS-DATA-MAPPING.md`** — canonical DB schema (§2.1), match ladder, the three-door clear-to-close gate.
4. **`../ENCOMPASS-API-ATLAS.md`** — auth, the 800-operation classification, the deny-by-default allowlist.
5. **`../ENCOMPASS-IDEAS-AND-ROADMAP.md`** and **`../ENCOMPASS-INDUSTRY-LANDSCAPE.md`** — the vision and the outside-world context.
6. **`../ENCOMPASS-BUILD-BLUEPRINT.md`** — the Phase-1 build order (WO-1 … WO-9). This is what a build session executes, one work order at a time, **only after an explicit owner go-ahead**.

The seven documents above are the **primary artifacts**. Everything in *this* folder is the **supporting evidence** behind them — go here when you need the deep detail, the raw classification data, or the reasoning behind a decision.

---

## Folder map

### `findings/` — the 31 raw research reports (the deep detail)

Produced by a 39-agent research workflow. Each polished doc is a synthesis of several of these; when a polished doc is too summarized, the source detail is here.

| Group | Files | Covers |
|---|---|---|
| **A — existing portal guards** | A1–A6 | ClickUp write/delete guards (A1), ClickUp sync architecture (A2), manual review queues (A3), SharePoint one-way guards (A4), security/PII posture (A5), incident lessons / never-again list (A6) |
| **B — our system** | B1–B5 | Portal data model + match keys (B1), conditions engine (B2), borrower profile/track record (B3), document pipeline (B4), loan lifecycle & clear-to-close today (B5) |
| **C — Encompass platform** | C1–C7 | Auth/token lifecycle (C1), reading loan data / V1-vs-V3 / field IDs (C2), pipeline discovery (C3), webhooks (C4), conditions/eFolder/disclosure (C5), milestones/locks/lifecycle (C6), **full 800-operation read/write classification (C7)** |
| **D — industry** | D1–D4 | Vendor/partner landscape (D1), developer-community lessons (D2), compliance/governance norms (D3), platform/licensing/commercial risk (D4) |
| **E — ideas** | E1–E4 | Borrower intelligence (E1), verification-gate rule catalog (E2), ops automation (E3), long-term vision + simplicity filter (E4) |
| **F — architecture** | F1–F5 | Read-only enforcement design (F1), sync architecture (F2), data governance (F3), rules-engine integration (F4), failure-mode & risk register — 29 risks (F5) |

### `analysis/` — derived, machine-readable analysis

- **`postman-endpoint-index.md`** — all 800 requests in the EDC 26.2 Postman collection, indexed by folder / name / method / path.
- **`endpoint-classification.json`** — the authoritative classification of every operation into READ / READ_VIA_POST / WRITE_LOAN (forbidden) / WRITE_CONFIG / AUTH / AMBIGUOUS. **This is the source data for the allowlist in `ENCOMPASS-API-ATLAS §10` and the guard in the blueprint's WO-1.** Machine-readable, so a build session can drive the allowlist from it.
- **`endpoint-rows-raw.json`** — the intermediate raw rows behind the classification (kept for traceability).
- **`pipeline-query-extract.json`** — extracted detail on the loan-pipeline discovery API.
- **`conditions-efolder-extract.md`**, **`milestones-locks-extract.md`** — working extracts from the ICE reference docs for the conditions/eFolder and milestone/lock areas.

### `review/` — the quality-assurance trail

- **`critiques.md`** — the two independent critic agents' full reports (a completeness critic and an accuracy skeptic) that reviewed the six original drafts.
- **`decisions-D1-D17.md`** — the 17 binding decisions that resolved every critic finding and made the six docs internally consistent. Each polished doc's header carries a "Revision note (2026-07-19)" pointing back to these. **If two docs ever seem to disagree, this file is the tiebreaker.**

---

## What is deliberately NOT in this folder (and why)

- **The raw 4 MB vendor Postman collection** (`Encompass_Developer_Connect` EDC 26.2) and its **environment file** — these are ICE's sample artifacts (the environment is placeholder-only, no secrets), an *input* the owner supplied, not our research output. Our derived `analysis/` files capture everything we learned from them. If a future agent wants to re-derive or verify against the source, the owner can re-supply the collection; it was the official **EDC 26.2** Postman collection from ICE's developer portal.
- **Throwaway extraction scripts** (small `.py` helpers used once to parse the collection) and a **downloaded ICE reference PDF** (vendor content; its substance is captured in the `analysis/` extracts).
- **No secrets, tokens, or credentials** — by policy, and verified by scan before commit.

---

## How to continue this branch (for the next agent)

1. **Do not build without an explicit owner go-ahead** — the owner has paused implementation. This branch is research + design memory only.
2. When cleared to build, follow **`../ENCOMPASS-BUILD-BLUEPRINT.md`** in order (WO-1 first: the read-only client + allowlist + CI guard test — the write-freeze must exist *before* any live call is possible).
3. Honor the standing rules: **poll-only Phase 1, zero writes to Encompass (not even webhook subscriptions), no SSN/DOB pull at launch, gates read local snapshots (never a live call in the request path), and the mandatory two-audit-agent gate on every change.**
4. Keep this branch un-merged until the owner decides; it is the shared handoff surface.
