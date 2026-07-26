# Critique Resolution Decisions (binding for all doc fixes)

These decisions resolve every BLOCKER/MAJOR and the accepted MINORs from the two critic reports (see critiques.md in this directory). Every fix agent applies these EXACTLY — no re-litigating. Where a doc currently says otherwise, rewrite it to match. Each decision below lists the canonical wording intent; adapt phrasing to each doc's voice but keep the substance identical.

## D1 — CTC gate freshness (resolves Critic1 #1 BLOCKER, Critic2 #2)
DECIDED: The gate evaluator NEVER performs network I/O in the request path — by construction, the evaluator module holds no HTTP client (F4's design wins). Freshness is enforced instead: the clear-to-close gate requires the loan's local Encompass snapshot to be no older than the CTC freshness ceiling (15 minutes recommended, configurable). If the snapshot is older, the gate FAILS CLOSED with a "refreshing Encompass data — retry shortly" outcome, and an immediate high-priority refresh is enqueued for the background sync worker. A live blocking fetch at decision time is explicitly REJECTED for Phase 1 (it would put Encompass availability in the request path); revisiting that is a Phase-2 open question. Lower-severity gates (soft warnings) tolerate the standard snapshot age (poll cadence). ALL FOUR mentions must align: Master §4.2, Guardrails §6.2, Atlas §7.4, Ideas §5 — each states this decision and cites "Decision D1 (2026-07-19)".

## D2 — Phase-1 transport is POLL-ONLY (resolves Critic1 #2, Critic2 #10)
DECIDED: Phase 1 is poll-only. No webhook subscriptions are created in Phase 1 — which means Phase 1 performs ZERO writes of any kind to Encompass, not even platform-config writes. Benefits: no public endpoint, no signing-key management, no config write, simplest possible freeze story. Webhooks become the Phase-1.5/2 accelerator, explicitly an OWNER DECISION gate; when adopted, webhook subscription CRUD becomes the one sanctioned config-write category (admin-credential, out-of-band, per the Atlas §10.2 table) and polling remains the source of truth (webhooks only accelerate). The ICE auto-disable/auto-delete behavior for failing subscriptions (Industry §4.1 lesson 6) must be mentioned wherever webhooks are designed: a daily subscription-drift read check is mandatory once webhooks exist. Master §5.3/§5.4, Ideas §3/§9, Atlas §6 all align and cite "Decision D2 (2026-07-19)".

## D3 — Borrower matching launches WITHOUT SSN/DOB (resolves Critic1 #3)
DECIDED: Tier 3 (SSN/DOB pull from Encompass) launches DISABLED, per Guardrails §5.1 and Industry §5.4. Therefore DATA-MAPPING's matching ladder must rank the non-SSN ladder as PRIMARY for launch: (1) ys_loan_number ↔ Encompass Loan Number, (2) canonical property address + borrower/entity last name, (3) borrower full name + entity name + amount/date corroboration. ssn_hash matching is documented as a FUTURE stronger key that only exists if the owner later enables Tier 3; every mention of "strong SSN match attaches" is rewritten to "strong multi-signal match attaches (SSN-hash key available only if Tier 3 is ever enabled)". Auto-attach threshold without SSN must be conservative; ambiguous cases go to manual review (crosswalk state `ambiguous`/`review`). DATA-MAPPING §2/§4 rewritten; cite "Decision D3 (2026-07-19)".

## D4 — ONE canonical schema, owned by DATA-MAPPING §2.1 (resolves Critic1 #4, Critic2 #3)
DECIDED canonical Phase-1 tables (names final):
- `encompass_loan_index` — one row per Encompass loan GUID seen; crosswalk to portal `application_id` (nullable); match state ENUM: `unmatched`, `auto_matched`, `manual_confirmed`, `ambiguous`, `conflict`, `data_only`, `ignored` (7 states — merged superset; `data_only` = enrichment-only loans e.g. historical/closed, `conflict` = match disputed by data, `ambiguous` = multiple candidates, needs review).
- `encompass_snapshots` — append-only raw JSONB snapshot per loan per fetch (diffable, replayable).
- `encompass_pull_log` — the READ journal: one row per outbound Encompass API call (endpoint, verb, loan, status, duration, bytes). Also referred to as the request log; `encompass_request_log` naming is RETIRED — use `encompass_pull_log` everywhere.
- `encompass_gate_log` — one row per gate evaluation (rule, application, decision, snapshot id + age, evidence summary, override info).
Structured convenience mirrors (`encompass_conditions`, `encompass_milestones` as typed projections of snapshots) are OPTIONAL Phase-1 implementation detail, mentioned as such in Ideas — not separate sources of truth. Binding is via `encompass_loan_index.application_id` ONLY; NO new column on `applications` in Phases 1–2 (Master Stage-2 "no application/borrower columns touched" stands; a convenience column is a possible later denormalization, noted as such). Gate precondition wording everywhere: "match state ∈ {auto_matched, manual_confirmed}". All docs reference DATA-MAPPING §2.1 as the canonical schema appendix and drop their divergent table lists; cite "Decision D4 (2026-07-19)".

## D5 — ONE roadmap of record: the Master's (resolves Critic1 #5)
DECIDED: Master §8 stages 0–5 are the roadmap of record. IDEAS §7 is rewritten to map its phases onto the Master stages (a small mapping table: Ideas Phase 0→Stage 0–1, Phase 1→Stage 2–3, Phase 2→Stage 4, Phase 3→Stage 5+). Borrower milestone timeline sits where the MASTER puts it (Stage 5 "Later"). The Master roadmap must explicitly acknowledge the Phase-3 write-back candidates from IDEAS (eFolder document push L6 etc.) in one sentence: they are EXPLICITLY OUT OF SCOPE for the roadmap of record and would require the Guardrails unfreeze ceremony + owner sign-off; nothing in stages 0–5 writes to Encompass. Cite "Decision D5 (2026-07-19)".

## D6 — CTC gate covers ALL THREE doors (resolves Critic1 #6)
DECIDED: the gate covers (1) the status PATCH endpoint, (2) the internal-status endpoint (staff.js:4298 door that today bypasses advancementBlockers), and (3) ClickUp-inbound status application — where "blocking" means: the inbound ClickUp CTC status change is NOT applied locally; it lands in the sync review queue with reason `encompass_gate_blocked`, exactly like other suspicious inbound changes. (We cannot stop ClickUp itself from changing; we refuse to mirror it ungated.) DATA-MAPPING §5.4 wording wins; IDEAS §5 and the E2-derived rule text updated to match. Cite "Decision D6 (2026-07-19)".

## D7 — The credential incident is FACT (resolves Critic1 #7, Critic2 #1)
VERIFIED BY THE SESSION ITSELF (the orchestrating assistant is an eyewitness): on 2026-07-17 the owner pasted the Encompass Developer Connect Client ID, Client Secret, and Instance ID into the task chat for this research session. The secret was never written to any file, commit, or document, and no API call was ever made with it. Per the standing CLAUDE.md rule ("a credential pasted into a chat/transcript is considered compromised"), it is treated as burned: REGENERATE the client secret in the Encompass API Key Management page before first use. Both docs state this identically; Guardrails Open Question 1 is CLOSED with this answer (remove it from open questions, note the resolution). Master keeps rotation as step 1 of Stage 0. Cite "Decision D7 (2026-07-19)". Do NOT include any part of the actual credential values.

## D8 — Master §10 becomes the canonical open-question superset (resolves Critic1 #8)
DECIDED: Master §10 is rebuilt as the single deduplicated tracker with stable IDs OQ-01, OQ-02, … covering: everything already there, PLUS IDEAS §9 owner decisions (auto-verify funded-loan track records; borrower-facing gating; outage/fail-closed tolerance duration; tolerance culture; webhook adoption timing per D2), INDUSTRY §8 counsel items (licensed-state list; 5,000-consumer Safeguards threshold applicability; signed-agreement data-replication language), Guardrails Q11 (Qualified Individual / retention sign-off). Note: former Guardrails Q1 (credential) is resolved by D7 and listed as RESOLVED. Sibling docs keep their local lists but add one line at the top: "Canonical tracker: Master §10 (OQ-xx IDs); this local list is subsumed." Cite "Decision D8 (2026-07-19)".

## D9 — "Mapped conditions only" honesty (resolves Critic1 #9)
DECIDED: everywhere the headline rule is stated, it reads "a MAPPED portal condition cannot be cleared unless Encompass agrees" (gating is opt-in per condition via the mapping table; unmapped conditions behave exactly as today), and the Master exec summary adds the coverage expectation: enforcement turns on only after mapping coverage of active-pipeline conditions reaches the ≥90% coverage gate (IDEAS §7).

## D10 — Layer count: SIX layers, numbered 0–5 (resolves Critic1 #10, Critic2 #11)
DECIDED: Guardrails §2 is the source of truth and says "six independent layers (numbered 0–5)" including the DB constraint as layer 5. Master §5.2 says six and cites Guardrails §2. Atlas §11 and Industry §7 label their summaries "condensed view of the six-layer doctrine (Guardrails §2)".

## D11 — Call volume: one harmonized estimate (resolves Critic1 #11, Critic2 #7)
DECIDED: both docs state "roughly 500–1,750 calls/day depending on book size and poll cadence" with one sentence: the low end assumes C3's minimal-poll cadence, the high end F2's denser cadence; assumptions live in Atlas §5, Master cites it.

## D12 — Token regime honesty (resolves Critic1 #12)
DECIDED: Industry §4.1 lesson 1 rewritten: ICE's own docs state two conflicting token-lifetime regimes (15-min-activity/30-min window up to 24h max vs 30-min fixed); design for the stricter reading; there is NO refresh token — "refreshing" means re-authenticating with stored credentials; never cache a token past its observed validity; introspection is available for verification. Align with Atlas §2.2.

## D13 — Incident framing consistency (resolves Critic1 #13, Critic2 #9)
DECIDED: IDEAS §0 uses the same framing as Master/Guardrails: the two-way ClickUp sync suffered 16 forensically-reconstructed incidents in 9 days, the first corruption 32 minutes after go-live — that history is WHY this integration is read-only.

## D14 — API User flag warning cross-ref (resolves Critic1 #14)
DECIDED: Industry §6.1 adds a warning box: for a LENDER service account do NOT check Encompass's "API User" flag (that designation is for ISV partners and breaks the lender password grant) — follow Master §6 provisioning steps exactly.

## D15 — Webhook auto-deletion visibility (resolves Critic1 #15)
DECIDED: Atlas §6.3 adds: ICE auto-disables/deletes webhook subscriptions that persistently fail delivery — an integration can silently go deaf; once webhooks exist (Phase 1.5+, per D2), a daily subscription-drift read check (list subscriptions, compare to expected) is mandatory. Master's future-webhook paragraph mentions it in half a sentence.

## D16 — Decommission step for superseded surfaces (resolves Critic1 #16)
DECIDED: Master roadmap Stage 4 gains a decommission item: retire or re-label the hand-typed `applications.encompass_status` ClickUp-mirror column and the five manual "check in Encompass" checklist tasks (db/005_rtl_workflow.sql:74-84) once their auto-verified equivalents are live; DATA-MAPPING §1 notes they are "superseded at Stage 4 (Master roadmap)".

## D17 — Precision fixes (resolves Critic2 #4, #5, #6, #8, #12)
- DATA-MAPPING §3.1 line cites: `loan_amount` = db/schema.sql:187, `ltv` = db/schema.sql:188 (`ys_loan_number`:164 stays). crypto.js NYDFS comment cite → :164. `redactPII` cite → redact.js:9. Migration count wording → "126 numbered migration files (127 SQL files in db/ including schema.sql)".
- IDEAS §3 local-mirror row: replace stale borrower.js line numbers with route names: "GET /applications/:id (the SELECT a.* full-row response) and the track-record SELECT t.* response" — no line numbers.
- Master §7 AND Guardrails §6: F5 catalogs 29 risks (FM-01…FM-44, non-contiguous IDs), not 27.
- Atlas §10.1 B6: REMOVE `GET .../conversationLogs` from the runtime allowlist; add note: "classified READ but deliberately NOT allowlisted — excluded by data governance (Guardrails §5.1 Tier 4: free-text conversation logs)".
- Atlas §4.3: PRECON.* = 18 fields (not 19); mark `ENHANCEDCOND.X1` as docs-sourced (not present in collection samples) — adjust the table's verification claim accordingly.
- Atlas §7.2: use the full export path `POST /efolder/v1/loans/{loanId}/exportJobsCreator`; add: the collection variant carries a `skipPersonaChecks` query param — the allowlist's query validation must explicitly DENY/never send it (persona checks stay on).

## Global rules for every fix agent
- Edit ONLY the draft files assigned to you in /tmp/claude-0/-home-user-yscap/bc1190a9-8c27-5008-86bb-f6bc23bac524/scratchpad/research/drafts/. NEVER touch /home/user/yscap.
- Never introduce credential-looking strings.
- Keep each doc's existing voice, structure and length; these are surgical fixes, not rewrites (exception: Master §10 superset rebuild per D8).
- Where a decision changes a recommendation, ensure the doc no longer argues for the losing side elsewhere (sweep the whole doc for stragglers).
- Add a short "Revision note (2026-07-19)" line under each doc's header: post-critique consistency pass applied (decisions D1–D17).
