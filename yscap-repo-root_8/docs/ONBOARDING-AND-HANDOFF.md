# PILOT — New Developer Onboarding & Handoff

_Read this top to bottom before writing any code. It assumes you know nothing about this project. By the end you will understand the whole backend, the rules you must follow, and exactly what is left to build._

---

# PART 1 — What this project is

**PILOT (a.k.a. "PILOT by YS Capital")** is the software platform for a private mortgage lender (YS Capital Group). It handles **business‑purpose real‑estate loans** — fix‑and‑flip, rental (DSCR), bridge, ground‑up construction. It is a Loan Origination System (LOS): borrowers apply, staff (loan officers, processors, underwriters, admins) work the file through a checklist of conditions, documents are collected, the loan is priced and registered, and it closes.

There are **three audiences** and you must always think about all three:
1. **Marketing website** — public pages + free tools (loan calculator, rehab‑budget builder, term‑sheet generator).
2. **Borrower portal** — where a borrower applies, uploads documents, chats, sees their loan status.
3. **Staff / internal portal** — where staff run the pipeline, review conditions, chat, manage leads.

---

# PART 2 — The single most important layout fact

**Everything lives in the subfolder `yscap-repo-root_8/`**, NOT at the git root. `package.json`, `src/`, `db/`, `web/`, `app/`, `app-v2/` are all inside it. **Run every `npm` command from inside `yscap-repo-root_8/`.**

---

# PART 3 — Architecture (backend, start to finish)

## 3.1 One server serves everything
`src/server.js` starts **one Express process** that serves:
- the JSON API under `/auth` and `/api/*`,
- the static marketing site and the prebuilt React app out of `web/`.

On boot it runs `src/migrate-boot.js`, which:
- waits for the database,
- applies `db/schema.sql` **only if the database is empty**,
- then applies every numbered migration `db/002_*.sql … db/NNN_*.sql` **on every boot** (they are all written to be safe to re‑run).

`GET /api/health` reports whether the DB and file storage are up.

## 3.2 Two front ends, one origin
- **`web/`** — the static marketing site + the standalone HTML tools in `web/tools/*.html`. There is also a `web/v2/` copy (the current PILOT brand). The pricing/guideline math inside these tools (`window.YSP`, `GSP`, `TitleCost`, `termsheet.js`) is **FROZEN** — never change the numbers.
- **`app-v2/`** — the **React** portal (Vite + HashRouter). You edit source in `app-v2/src/`, then **build it** into `web/v2/portal/`. The server serves that built folder at `/portal/`.
  - **CRITICAL:** Render (the host) does NOT build the frontend. After ANY change under `app-v2/src/`, you must run the build and **commit the regenerated `web/v2/portal/` bundle**, or your change will not deploy.
  - Build command (from `yscap-repo-root_8/app-v2/`): `npm run build`.
  - There is an OLD React app in `app/` that builds to `web/portal/` — that is **V1, frozen, kept at `/v1`**. Do not build new features there. All new work is `app-v2/`.

## 3.3 The database
PostgreSQL. Key tables (in `db/schema.sql` + migrations):
- **`borrowers`** — the person's PII (name, DOB, SSN encrypted, phone, address). **Separated** from…
- **`borrower_auth`** — their login (email, password hash) — so a login breach doesn't leak PII.
- **`applications`** — one row per property/loan (a borrower can have many). Holds the deal economics (purchase price, ARV, rehab budget, loan amount, program, etc.), the assigned `loan_officer_id` / `processor_id`, status, and the YS loan number.
- **`application_assignees`** (db/103) — the FULL team on a file: one primary loan officer + one primary processor (mirrored from the pointers above) plus full‑access "assistants".
- **`checklist_templates` / `checklist_items`** — these ARE the conditions/documents workflow. A template is a kind of condition; an item is that condition on a specific file. Items have an audience (borrower / staff / both) and carry a borrower‑facing label + an internal label.
- **`documents`** — uploaded files (bytes stored via `src/lib/storage.js`).
- **`staff_users`** — the team roster (the source of truth for who is staff).
- **`leads`** (db/008 + the CRM buildout) — marketing leads / prospects (NOT yet loan files).
- **`notifications`** — in‑app bell + email fan‑out.
- **`conversations` / `conversation_members` / `messages`** (db/035) — the chat system (see PART 6).
- **`audit_log`** — a trail of sensitive actions (PII reveals, etc.).

## 3.4 Auth & roles
- Custom JWT (HS256), scrypt password hashing, optional TOTP MFA, AES‑256‑GCM SSN encryption — all on Node's built‑in `crypto` (no native dependencies, so it builds cleanly on Render).
- Borrowers **self‑register**; staff are **invited/created by an admin**.
- Staff roles, most to least powerful: `super_admin > admin > {loan_officer, processor, underwriter}`.
- `admin`, `super_admin`, `underwriter` see **every** file. `loan_officer` and `processor` see only files they are **assigned** to. This scoping is enforced in one place: `VISIBLE_OFFICERS_SQL(...)` in `src/routes/staff.js`. Always route access checks through the existing helpers — never hand‑write a new "who can see this" SQL clause.

## 3.5 Email & notifications
- `src/lib/notify.js` always writes an in‑app notification and best‑effort sends a branded email.
- The email provider is Resend (see `src/lib/email/`); `template.js` renders the branded HTML; `catalog.js` builds the messages. All emails go through one template so brand changes happen once.
- **Do not revert emails to a dark theme** — they are white‑first PILOT brand.

## 3.6 The two big outside integrations
- **ClickUp sync** (`src/clickup/`, `src/sync/`) — two‑way sync between the loan pipeline and a ClickUp board (this is how the team also works deals in ClickUp). This code is **extremely safety‑guarded** (see PART 5 rules) because a bad write can corrupt real data.
- **SharePoint mirror** (`src/lib/sharepoint*.js`) — one‑way copy of every uploaded document into the team's SharePoint. **Never deletes anything, ever.**

## 3.7 How to run and verify it locally
- There is **no test runner** wired to `npm test`. You verify by **booting the server against a real local Postgres and hitting endpoints**. A real Postgres is required — nothing is mocked.
- There ARE targeted test scripts you should run before merging: `scripts/test-*.js` (checklist sync, ClickUp guards/mapper/transforms, sync‑autoresolve, sync‑file‑review). Run each with `DATABASE_URL=... node scripts/test-xyz.js`.
- To eyeball the frontend, boot the server and open the portal; Chromium + Playwright are available for automated screenshots.

---

# PART 4 — How to work here (process)

1. You develop on a branch, commit, push, open a **draft** pull request, mark it ready, then **squash‑merge to `main`**. Deploying is triggered separately by the owner.
2. **Commit + merge promptly** — don't leave finished work sitting on a branch.
3. After ANY `app-v2/src/` change: rebuild the bundle and commit `web/v2/portal/`.
4. Every schema change is a **new numbered idempotent `db/0NN_*.sql`** file (use `IF NOT EXISTS` / `ON CONFLICT`). **Never edit an old migration.**

---

# PART 5 — The rules you MUST follow (these are hard rules from the owner)

1. **DON'T GUESS — ASK.** If a requirement is ambiguous, or you'd have to guess a field mapping / business rule / data shape, **stop and ask the owner**. Guessing here corrupts real borrower data. It is always better to ask a question than to build the wrong thing.

2. **Merging — keep EVERYONE's work. This is critical because several people/agents land on `main` at the same time, so `main` moves under you.** Every single time you merge:
   - **Re‑fetch the newest `main` first** (`git fetch origin main`) and rebase/merge onto it. Never merge a branch built on a stale base.
   - If there are **any** conflicts, do **NOT** pick one side wholesale and do **NOT** let the merge silently drop the other side's work. Read **both** versions, understand what each change is for, and hand‑write a resolution where **both** enhancements survive and work together. **Respect other people's comments/changes** — their work must remain intact.
   - For the **built bundle** (`web/v2/portal/*`), the only correct resolution is to **rebuild it from the fully‑merged `app-v2/src`** — never keep one side's prebuilt bundle.
   - If two migrations grabbed the **same number** (e.g. two `db/112`), **renumber YOURS** to the next free number (never theirs — theirs may already be applied in production) and update any references.
   - After resolving: re‑run the affected test scripts + eslint on changed JSX + boot the server (so all migrations apply and the whole module graph loads) **before** pushing. Confirm the markers of BOTH sides are present.

3. **Fix the ROOT, and every place it can appear.** A reported bug is a symptom. Find the underlying cause, then fix it **everywhere it can occur**: marketing site + borrower + staff; frontend + backend; and add a backfill migration so **existing** files get the fix too (not just new ones).

4. **A green build does NOT mean it works.** The build treats an undeclared variable as a global and emits it — so a React component that uses a variable it was never given will build fine and then crash the page at render ("Something went wrong"). Before committing frontend changes, run **eslint `no-undef`** on the changed `.jsx` and make sure every identifier is a prop, local, import, or known global.

5. **Verify every write endpoint.** After a save returns 200, **re‑fetch and confirm the value actually persisted.** "Returned 200 but didn't save" (a camelCase/snake_case mismatch, or a `COALESCE` that swallowed the update) is the #1 recurring bug here.

6. **Never show capital‑partner / note‑buyer names to borrowers.** On any borrower‑facing surface, the program is called the **"Gold Standard program."** Real partner names may appear only on staff‑only surfaces.

7. **Never commit secrets.** All secrets come from environment variables (`src/config.js`). Never hard‑code an API key, DB URL, token, or client secret into source, a commit message, a PR body, or a comment. If a secret is ever pasted into chat, treat it as compromised and have the owner rotate it.

8. **The pricing engines are frozen.** Never change the loan‑pricing math in `web/tools/*` or `src/lib/pricing.js` unless the owner explicitly directs a guideline change.

9. **ClickUp & dates are heavily guarded — don't weaken them.** Date‑only values are `'YYYY-MM-DD'` strings end‑to‑end (never a JS `Date` mid‑pipeline). Every ClickUp field write goes through the guarded chokepoint, is journaled, and anything suspicious (e.g. a changed date of birth) stops in a **review queue** for a human — it is never silently applied. If you add any date field or ClickUp write, wire it through the existing helpers (`lib/fields.normalizeTypedDate`, `sanitizeDob`, `transforms.dateOnlyToClickUpEpoch`, the `sync_review_queue`).

10. **Mobile matters.** The portal must render at the device width. Keep `html { overflow-x: clip }` and the mobile breakpoints intact; form inputs must be ≥16px on phones (or iOS zooms on focus).

---

# PART 6 — The chat system (you'll likely extend this — here's how it works)

Chat is first‑class. Model (`db/035` + `db/113`):
- **`conversations`** — a named chat on a file. `kind` is one of `borrower` (borrower‑visible), `internal` ("Loan Team"), `lo_processor` ("Officer ↔ Processor"), or `custom`. Renameable, has an emoji.
- **`conversation_members`** — who is in a chat. `member_kind` is `borrower` or `staff`. Soft‑removed with `removed_at` (kept for history). Read/unread is tracked by watermarks (`last_read_seq`), not per‑message receipt rows.
- **`messages`** — `sender_kind` is `borrower`, `staff`, `system`, or **`external`** (an outside email guest — added this session). `seq` is a global increasing number used for ordering and unread math.
- **`conversation_external_participants`** (`db/113`, added this session) — an outside person added by **email** (partner/secretary/attorney). They are NOT a portal user. Fields: `email`, `name`, an unguessable `reply_key` (their private capability token), `signed_up_at`, `guest_borrower_id` (reserved for a future full account), `removed_at`.

Core backend logic is in **`src/lib/chat.js`**. Chat routes: `src/routes/staff-chat.js` (staff), `src/routes/borrower-chat.js` (borrower), `src/routes/guest-chat.js` (outside email guests, key‑authenticated), `src/routes/inbound-chat.js` (receives email replies from guests).

---

# PART 7 — What was BUILT THIS SESSION (so you know the current state and where to extend)

All of these are **done, merged to `main`, and tested**:
- **Start a loan from a saved pricing scenario** — after pricing a loan, one click creates a real application draft pre‑filled from the scenario + the borrower's profile. Code: `app-v2/src/lib/scenario.js`, `app-v2/src/screens/PricingStudio.jsx`.
- **File Overview redesign** — the staff file's top "cockpit" is now bigger and clearer (a hero band + labeled clusters). Code: `app-v2/src/components/DealSnapshot.jsx` + `app-v2/src/styles.css` (`.snap-*`).
- **Activity collapsed** — the staff file's Activity history starts collapsed. Code: `app-v2/src/screens/StaffApplication.jsx` (the `sec-activity` Section).
- **Phone/ZIP field constraints** — every phone and ZIP box in the portal only accepts valid input. Code: `app-v2/src/components/FormattedInputs.jsx` (`ZipInput`, `PhoneInput`), applied across the borrower + staff forms.
- **Chat overhaul (#75)** — three parts:
  1. Add/remove members on the built‑in chats (not just custom groups). `src/routes/staff-chat.js` + `app-v2/src/components/ChatThread.jsx`.
  2. External **email guests** — add an outside person by email; they receive every message by email and can reply by email; replies land back in the chat. `db/113`, `src/lib/chat.js` (`emailExternalParticipants`, `postExternalReply`), `src/routes/inbound-chat.js`, staff endpoints in `staff-chat.js`.
  3. Guest **magic‑link** view — the guest can open the chat online via a private unguessable link (no login), scoped to only that one conversation. `src/routes/guest-chat.js`, `app-v2/src/screens/GuestChat.jsx`, route `/guest/:key` in `app-v2/src/App.jsx`.

---

# PART 8 — OUTSTANDING TASKS (what you must build) — full detail

> For each task: the background, exactly what to build, where in the code, what's needed from the owner, and my recommended approach. **If any part is unclear, ask the owner — do not guess.**

---

## TASK A — #68: Per‑file email inbox with one shared reply‑to
**Status: half done. The remaining half is blocked on one email‑configuration step from the owner.**

**Background (plain language):** For each loan file, staff want two things:
1. See **every email that was sent about that file** (to the borrower, co‑borrower, each staffer) — with delivery status.
2. Have **one email address that anyone can reply to, and the reply is forwarded to all the assigned staff** (loan officer + processor + assistants). So if a borrower replies to any file email, the whole team gets it.

**What's already built:** Part 1 (see every email sent for a file) is **live** — it's the "Email notifications" section on the staff file page. Also, the machinery to **receive** an inbound email reply already exists (built for chat): `src/routes/inbound-chat.js`, mounted at `/api/inbound/chat`, plus a `replyTo` field already supported by the email sender (`src/lib/email/resend.js`).

**What's left to build:**
- A per‑file reply address, e.g. `file+<applicationId>@<inbound-domain>`.
- Put that address as the `replyTo` on the outbound file emails (in `src/lib/notify.js` / `src/lib/email/catalog.js`).
- Add an inbound handler (a sibling of `inbound-chat.js`, or extend it) that: parses `file+<applicationId>@…` out of the "To" address, looks up the file's assignees from `application_assignees`, and forwards the reply's text by email to each of them (and optionally records it on the file).

**Recommended approach:** Copy the exact pattern of `src/routes/inbound-chat.js` (tolerant parsing, silent no‑op on unknown address, never return a 500 to the email provider). Reuse `application_assignees` for the recipient list. Keep it best‑effort so a bad email never crashes anything.

**BLOCKED ON — the owner must do this first:**
- In the **Resend** dashboard: add and verify an **inbound email domain** (e.g. `reply.yscapgroup.com`), create an inbound route, and point its webhook at our server's inbound endpoint.
- In **Render** (env vars): set `CHAT_REPLY_DOMAIN` to that domain.
- Until this exists, there is nowhere for a reply email to arrive, so this half cannot be finished or tested.

---

## TASK B — #75 config: turn ON reply‑by‑email for chat guests
**Status: the CODE is 100% done and merged. It needs the SAME one config step as Task A.**

**Background:** External chat guests can already **receive** every message by email and open the chat online. The only missing piece is letting them **reply by email** — which needs somewhere for the reply to land.

**What to do:** Nothing in code. Once the owner sets up the Resend inbound domain + `CHAT_REPLY_DOMAIN` (same step as Task A) and points the inbound webhook at `/api/inbound/chat`, reply‑by‑email starts working immediately. Then verify: add a guest, send a chat message, reply to that email, confirm the reply appears in the chat as the guest.

**Open question for the owner (decide before building more):** Today "open the chat online" for a guest is a **private magic link** (no password; the link is unguessable and only opens that one chat, nothing else — like a "anyone with the link" share). If the owner instead wants guests to create a **real password login** (a limited "chat‑only account"), that is a **separate, larger build** (a new limited auth scope). The magic link already satisfies "they can join the chat online and still get emails." **Ask the owner which they want before building the password version.**

---

## TASK C — #66: ClickUp CRM ↔ PILOT lead‑CRM two‑way sync
**Status: not started. Blocked because I don't know the ClickUp CRM board's structure.**

**Background:** We already two‑way‑sync the **loan pipeline** with ClickUp. This is a **different, separate** integration: sync PILOT's **lead CRM** (marketing leads / prospects, in the `leads` table) with a **ClickUp CRM board** — so a lead added in one appears in the other, and edits flow both ways.

**Why it's blocked:** To map fields correctly I need the owner's **ClickUp CRM board layout**: which workspace/space/list it's in, and which ClickUp custom fields correspond to which PILOT lead fields (name, email, phone, status, source, owner, notes, etc.). Guessing the mapping would write data into the wrong fields.

**What to build once you have the mapping:**
- Model it on the existing loan‑pipeline sync in `src/clickup/` (`client.js`, `mapping.js`, `orchestrator.js`, `ingest.js`) and `src/sync/`.
- Add a **lead‑specific mapping** (ClickUp CRM field id → `leads` column) and a lead orchestrator that pushes/pulls through the **same guarded machinery**: the write chokepoint (`src/clickup/client.js` `setField` / `guardNoFieldClearing`), the outbound volume circuit breaker, and the `sync_review_queue` for anything ambiguous.
- **Never write empty values** (they clear fields); **journal every write**; send anything uncertain to the review queue.

**BLOCKED ON — the owner must provide:** the ClickUp CRM board location + a list of its custom fields and how each maps to a PILOT lead field. A screenshot of the board's fields + one example task is enough to start.

---

## TASK D — #56: Site‑wide polish sweep
**Status: not started. Open‑ended — needs a concrete list or a chosen slice.**

**Background:** A pass over the whole product (marketing site + portal) to fix small things and make small improvements — typos, spacing, wording, tiny bugs, mobile quirks.

**Why it's not done:** There is no single spec; "small enhancements + error fixes across the whole website" is too broad to build blindly.

**Recommended approach:** Ask the owner for a specific list, OR do it one surface at a time (e.g. marketing homepage, then borrower dashboard, then staff pipeline) and show each. **One concrete, already‑scoped first slice:** the static **marketing** loan‑application form (`web/tools/loan-application.html` and its copy in `web/v2/tools/`) still uses plain text boxes for **phone** and **ZIP** — apply the same digit‑only formatting the portal already got (see `ZipInput`/`PhoneInput`). Notes: these are "frozen" tool files — change only the input fields, **not** the pricing math; there are **two copies** to keep identical; and bump the `?v=` number on their `<script>`/`<link>` tags so browsers don't serve a stale cached version.

---

## TASK E — #84: "Yaniv Erez" deep belt‑and‑suspenders sweep
**Status: on hold by the owner's instruction.**

**Background:** There was a bug where a duplicate ClickUp task could create a second loan file for the same borrower + same address (case: Yaniv Erez / 19620 NE 21st Ct, Miami). The **core fix already shipped**. #84 is the extra‑thorough follow‑up: scan **all** history for any other files that were affected, and add more safety guards.

**What to build when un‑held:** Audit `src/clickup/ingest.js` (the duplicate‑task lifecycle + `linkOrCreateApplication`) and the review‑queue machinery, run a historical scan for same‑borrower/same‑address file pairs, add tests. **Wait for the owner's green light** before starting.

---

# PART 9 — The exact things the owner must provide (config / decisions)

1. **Resend inbound email domain** (e.g. `reply.yscapgroup.com`) — verified in Resend, with an inbound route + webhook pointed at our server. → unblocks **Task A (#68)** AND **Task B (#75 reply‑by‑email)**.
2. **`CHAT_REPLY_DOMAIN`** env var in Render, set to that domain.
3. **ClickUp CRM board layout** — space/list + field list + field→lead mapping. → unblocks **Task C (#66)**.
4. **Decision:** guests use the private **magic link** (current) or a **password account** (bigger build)? → affects **Task B**.
5. **A concrete list** of the small fixes wanted for **Task D (#56)**, or a green light for the marketing phone/ZIP slice.
6. **Green light** for **Task E (#84)** when ready.

---

# PART 10 — First‑day checklist for the new developer

1. Clone the repo. Everything is under `yscap-repo-root_8/`.
2. Start a local Postgres; set `DATABASE_URL`. From `yscap-repo-root_8/`, run `npm start` — the server migrates on boot and serves at `/`.
3. From `yscap-repo-root_8/app-v2/`, run `npm install && npm run build` once to confirm the frontend builds into `web/v2/portal/`.
4. Run the test scripts: `for t in scripts/test-*.js; do node "$t"; done` (with `DATABASE_URL` set) — they should all pass.
5. Read `CLAUDE.md` at the repo root — it holds the detailed, authoritative rules (this doc is the friendly summary).
6. Pick a task from PART 8. If anything is unclear, **ask the owner — do not guess.**
7. When you merge: re‑fetch `main` first, keep everyone's work on conflicts, rebuild the bundle from merged source, renumber a colliding migration to the next free number, re‑run tests + eslint + a boot, then push. Nothing that drops someone else's change is acceptable.

_End of handoff._
