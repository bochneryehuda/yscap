# PILOT — Remaining work handoff

_Written 2026-07-15. Everything below is what is **not done**, **not finished**, **blocked on a decision/config**, or where I have an **open question**. Each item is written in plain language plus the exact code location so another developer can pick it up._

Everything else the owner requested this session **is done, merged to `main`, and tested** (see "Already shipped" at the bottom).

---

## 1. #56 — Site‑wide polish sweep  ·  STATUS: not started (open‑ended)

**What it is (plain language):** A pass over the whole product — the marketing website *and* the borrower/staff portal — to fix small things and make small improvements (typos, spacing, tiny bugs, wording, mobile quirks).

**Why it isn't done:** It's deliberately open‑ended ("small enhancements + error fixes across the whole website"). There's no single spec, so it needs either (a) a specific list of the small things to fix, or (b) a defined area to focus on.

**What the developer should do:**
- Ask the owner for a concrete list, OR pick one surface at a time (e.g. "the marketing homepage", "the borrower dashboard", "the staff pipeline") and do a focused polish pass on that one surface, then show it.
- One concrete, already‑scoped piece: the **marketing static forms** (`web/tools/loan-application.html` and its copy under `web/v2/tools/`) still use plain text boxes for **phone** and **ZIP**. The portal was already fixed (see #92 in "Already shipped") — the same digit‑only / formatting constraint should be applied to the static marketing form. Note: these are "frozen" tool files — do **not** touch the pricing math inside them, only the input fields, and bump the `?v=` number on their `<script>`/`<link>` tags so browsers don't serve a stale cached copy. There are **two copies** to keep in sync (`web/tools/` and `web/v2/tools/`).

**What's needed from the owner:** A short list of the specific small fixes they want, or a green light to just do the marketing‑form phone/ZIP constraint as the first slice.

---

## 2. #68 — Per‑file email inbox + one shared reply‑to  ·  STATUS: half done; the rest is blocked on email config

**What it is (plain language):** On each loan file, staff should see **every email that was sent for that file**, and there should be **one email address people can reply to that forwards the reply to all the assigned staff** (loan officer + processor + assistants).

**What's already done:** The "see every email sent for this file" part is **live** (task #80, "Email notifications" section on the staff file page). The plumbing for **inbound replies** (receiving an email reply and routing it into the system) was also built for the chat feature (see #75 below) — the same webhook can be reused.

**What's left / why it's blocked:** The "unique reply‑to that forwards to all assignees" part needs an **inbound email domain** set up in Resend (our email provider). Without an inbound domain, there is nowhere for a reply email to land. This is a **configuration step on the owner's Resend account**, not code.

**What the developer should do once the domain exists:**
- Reuse the inbound webhook pattern already built at `src/routes/inbound-chat.js` (mounted at `/api/inbound/chat`). Add a sibling route (or extend it) that recognizes a per‑file reply address like `file+<fileId>@<inbound-domain>` and fans the reply out by email to the file's assignees (`application_assignees`).
- Put the per‑file reply address on the outbound file emails (`src/lib/notify.js` / `src/lib/email/catalog.js`) using the `replyTo` field that already exists on the email sender (`src/lib/email/resend.js`).

**What's needed from the owner:**
- In the Resend dashboard, add and verify an **inbound domain** (e.g. `reply.yscapgroup.com`), create an inbound route, and point its webhook at our server.
- Set the environment variable `CHAT_REPLY_DOMAIN` (in Render) to that domain. (Same variable also switches on the chat reply‑by‑email — see #75.)

---

## 3. #66 — ClickUp CRM ↔ PILOT lead‑CRM two‑way sync  ·  STATUS: blocked on the ClickUp board structure

**What it is (plain language):** We already sync the **loan pipeline** with ClickUp. This is a **separate** request: two‑way sync between PILOT's **lead CRM** (marketing leads / prospects) and a **ClickUp CRM board** — so a lead added in one shows up in the other, and updates flow both ways.

**Why it's blocked:** I don't know the **structure of the owner's ClickUp CRM board** — which list/space it lives in, and which ClickUp custom fields map to which PILOT lead fields (name, email, phone, status, source, owner, etc.). Guessing the field mapping would corrupt data, and this repo has very strict data‑safety rules around ClickUp writes.

**What the developer should do once they have the mapping:**
- Model it on the existing loan‑pipeline sync: `src/clickup/` (client, mapping, orchestrator, ingest) and `src/sync/`. Reuse the write‑safety chokepoints (`src/clickup/client.js` `setField`/`guardNoFieldClearing`, the outbound circuit breaker, the `sync_review_queue` for anything ambiguous). Leads live in the `leads` table (`db/008` + the CRM buildout, task #59).
- Add a lead‑specific mapping file (ClickUp CRM field id → PILOT lead column) and a lead orchestrator that pushes/pulls through the same guarded machinery. Never write empty values (they clear fields); journal every write; send anything uncertain to the review queue.

**What's needed from the owner:**
- The ClickUp **CRM board location** (workspace / space / list) and the **list of custom fields** on it, and how each maps to a PILOT lead field. A screenshot of the board's fields + one example task is enough to start.

---

## 4. #75 — Chat with external guests: **code is DONE**, but needs one config switch to go fully live

**What it is:** Add outside people (a borrower's partner, secretary, attorney) to a chat by email; they get every message by email, can **reply by email**, and can **open the chat online** by a private link. All of this is **built, merged, and tested** this session.

**What still needs to happen (owner config, not code):** The **reply‑by‑email** and part of the online experience depend on the **same inbound email domain** as #68. Until it's set:
- Guests **do** receive every chat message by email and **can** open the chat online and type there (that already works).
- Guests **cannot reply by email** yet (there's nowhere for the reply to land).

**What's needed from the owner:** Set up the Resend inbound domain and the `CHAT_REPLY_DOMAIN` env var (exactly the same step as #68), and point the inbound webhook at `/api/inbound/chat`. Once set, replies‑by‑email start working immediately with no code change.

**Open question for the owner (optional future work):** Today the "open the chat online" guest access is a **private magic link** (no password — like a Google Docs "anyone with the link" link, but the link is unguessable and only opens that one chat, nothing else). If instead you want guests to create a **real account with a password** (a "chat‑only login"), that's a separate, larger build. The magic link satisfies "they can sign up for the chat and still get emails." **Tell me if you want the password‑account version instead.**

---

## 5. #84 — "Yaniv Erez" deep belt‑and‑suspenders sweep  ·  STATUS: you told me to HOLD

**What it is (plain language):** A deeper audit of the root cause behind the duplicate‑file bug (task #79, Yaniv Erez / same address making a second file) — going back through **all** history to make sure no other files were affected, and adding extra safety guards.

**Why it isn't done:** You explicitly said "hold off on #84 for now."

**What the developer should do when un‑held:** Audit `src/clickup/ingest.js` (the duplicate‑task lifecycle + `linkOrCreateApplication`) and the review‑queue machinery, run a historical scan for same‑borrower/same‑address file pairs, and add tests. The core #79 fix already shipped; this is the extra‑thorough follow‑up.

**What's needed from the owner:** Just a green light when you want it.

---

## Already shipped this session (done, merged to `main`, tested — listed so nothing looks "missing")

- **#119** — Start a real loan file from a saved pricing scenario, one click, pre‑filled from the scenario + the borrower's profile.
- **#65** — File Overview redesigned bigger and clearer (kept the current design language).
- **#81** — The staff "Activity" history is now collapsed by default (open it when you want).
- **#92** — Every phone and ZIP box in the portal now only accepts valid input (digits, right format), on both the borrower and staff sides.
- **#75** — Chat overhaul: add/remove members on the built‑in chats (Loan Team, Officer↔Processor), and add outside people by email who receive/reply by email and can open the chat online.
- **#114** — Re‑verified the whole app after all the parallel merges: 7 automated test suites (475 checks) all pass, the app boots and migrates cleanly, health is green.

---

## The ONE thing that unlocks the most (a single owner action)

Setting up **one inbound email domain in Resend** and the **`CHAT_REPLY_DOMAIN`** environment variable in Render switches on BOTH:
- reply‑by‑email for external chat guests (#75), and
- the per‑file shared reply‑to inbox forwarding (#68).

Everything else on this list is either open‑ended (needs a small spec: #56), needs the ClickUp CRM board layout (#66), or is on hold (#84).
