# Officer CRM, skip trace, call recording, track-record verification — the plan

**Scope: RTL only** (owner-directed 2026-08-07). `leads` (db/008) is an RTL table and everything
below sits on it. Nothing here touches Long-Term. See the two-products rule atop `CLAUDE.md`.

Research this rests on:
- `docs/ELEMENTIX-RESEARCH.md` — what the Elementix connector actually returns, measured live.
- `docs/LEAD-OUTREACH-COMPLIANCE.md` — the calling / recording / FCRA rules to build around.

---

## 1. The finding that reshapes the request

The owner asked for two things: **skip trace for the officers' CRM**, and **use the same data
for track-record underwriting**. Those have to be built as **two systems that share nothing
but a vendor login**, because that boundary is exactly what FCRA polices:

- Skip-trace contact data is sold under a **non-FCRA** certification. **Marketing is not a
  permissible purpose** under §1681b, and §1681b(f) makes obtaining a report without
  certifying the purpose unlawful.
- A **business-purpose commercial loan is still a §1681b purpose** — being a commercial
  lender does not put us outside FCRA.
- So: contact data may be used to *call* someone. It may **never** reach a credit decision.
  Deed history used to corroborate a claim is a different pull, for a different purpose.

```
  MARKETING PLANE                        UNDERWRITING PLANE
  lead research + skip trace             deed/mortgage history on a real applicant
  → officer calls a prospect             → corroborates a claimed deal, advisory only
  ── never joined ──▶   ✗   ◀── never reads from ──
```

Enforced **at the query layer, not by policy**: separate tables, separate modules, and no
join. Every ingested field carries vendor, product, the vendor's FCRA classification, a
DPPA-source flag, the purpose asserted, and who asked for it.

**The second finding:** the B2B assumption does not protect us. The business-to-business
telemarketing exemption is FTC-only, is not a TCPA/FCC exemption, and gives no shield
against a private suit — at **$500–$1,500 per call, class-actionable**. An investor's
personal cell is presumptively residential. So a **compliance spine has to exist before the
first skip-traced number is dialed**, and it is Phase 1 for that reason.

---

## 2. What already exists (and how much smaller this makes the job)

### The lead CRM is largely built

`leads` + **`lead_activities`** (a real typed timeline: `call | email | sms | meeting | note |
status_change | task | file | assignment | system`, each with `direction`) + **`lead_tasks`** +
document attachments + a **kanban board** (`StaffLeads.jsx`) and a detail screen with an
activity composer, owner picker, claim/release and `next_follow_up` (`StaffLeadDetail.jsx`).
Inbound leads already round-robin to officers (`lib/lead-assignment.js`), and
`POST /leads/:id/convert` already turns one into a loan file.

So workflow #1 is **not "build a CRM"** — it is "add contacts, a real call log, and research
to a CRM that exists."

**The genuine gaps:**

| Gap | Consequence today |
|---|---|
| Only three contact slots (`email`, `phone`, `phone_alt`) | A skip trace returning 3 phones + 2 emails has nowhere to land, and no provenance |
| No external record id on `leads` | Nothing ties a lead to the property/person record it came from |
| No telephony of any kind (grep-verified) | No click-to-call, no recordings, no call outcome |
| A "call" is hand-typed free text | No duration, no disposition, no next action |
| `next_follow_up` has **no dispatcher** | The officer is never nudged. `reminders` (db/062) is file-only and cannot hold a lead |
| `first_contact_at` (db/421) has **zero writers** | Speed-to-lead is uncomputable |
| `PATCH /leads/:id` is **not audited** | Owner changes, stage changes and contact edits leave no GLBA trail |
| Lead scope is hand-rolled `officer_id = $1 OR officer_id IS NULL` | **Any officer can read, edit, reassign and convert every unassigned lead.** This violates the repo's own rule that visibility routes through `VISIBLE_OFFICERS_SQL` / `VISIBLE_BORROWER_SQL`, and there is no delegation or assistant arm |

### The track-record machinery is already the right shape

`track_record_findings` + `src/lib/track-record-findings.js` already: detects problems,
offers per-code resolution options, **blocks `rtl_p3_reo` sign-off while any finding is open**
(`experienceBlockReason`, which fails open on error), keeps a decided finding decided, and
requires a human actor for anything destructive.

**Adding "public records disagrees with the claim" is one `FINDINGS` entry, one detector, and
one action mapping.** The gate, the API, the screen and the audit trail come for free.

Better still: `verification_status = 'limited'` **already means** *"confirmed online (public
record); no documentation on file"* — and it already counts toward experience. Elementix
corroboration has a home in the existing model.

**But three hard rules constrain it:**
1. **Nothing may auto-verify.** db/458 is owner-directed: a track record entered by anyone
   stays pending until a human reviews it with documentation. `is_verified = true` has exactly
   one door (`POST /track-records/:id/verify`, behind `sign_off_conditions`).
2. **Nothing may auto-merge or auto-alter a line.** A human confirms; `removeLine` refuses a
   verified row.
3. **A verification result is not a read-only act.** Lowering verified experience reopens a
   signed-off condition and can flag a live registration stale (db/071 / db/072). So a
   detector that writes must be treated as a pricing-adjacent change.

### Nothing exists for Elementix or telephony

No provider client, no ownership/party tables, no external-record store. The existing
`src/lib/underwriting/public-records-crosscheck.js` is a stub whose own header says the
public-records integration is *"deferred (no key yet)."* This is that integration.

---

## 3. What Elementix gives us, in one paragraph

Deterministic linking (`match_address`, `match_person` — exactly one match or nothing, with
`differs` flags). Per-person ownership history that **is** a track record: purchase price,
sale price, acquired/sold dates, hold period, the LLC used, co-investors on the deed, and
`isNonArmsLengthTransfer`. A person summary with `preforeclosureCount`, current exposure,
recent-activity velocity, per-lender-type first-borrow dates, and **`nameCommonnessScore`** —
the field that decides whether a match may be trusted without a human. Skip trace is
**paid per person**, asynchronous, and has a **free** status check that says whether a click
would charge. Coverage is fresh (1–3 weeks) but the entity→people linkage swings from **82.9%
(Essex) to 39.8% (Passaic)**, so **"no record found" is never evidence a claim is false.**
One shared ceiling: **1,000 requests/hour for the whole company, across every client.**

---

## 4. Build order

Phases 0, 1 and 4 need **nothing from Elementix** — they can start immediately, while the
authentication question is outstanding.

### Phase 0 — repair the CRM foundations *(no external dependency)*

1. **`lead_contacts`** table, mirroring the established `borrower_contacts` shape
   (`kind` email|phone, `value`, `is_primary`, `UNIQUE(lead_id, kind, value)`), plus the
   provenance columns the compliance rules demand: source vendor, product, external record
   id, `traced_at`, DPPA flag, requesting staff id, and the purpose asserted. Accumulate-only;
   promotion to the lead's primary phone/email stays a deliberate action, as it is for
   borrowers.
2. **Route lead scope through the shared visibility rule** instead of the hand-rolled clause,
   so an officer's own book is genuinely their own and delegation/assistants work as they do
   everywhere else. Deliberate decision needed: does an unassigned lead stay visible to all?
3. **Audit `PATCH /leads/:id`.**
4. **A follow-up dispatcher** for `next_follow_up`, on the existing digest cadence with its
   own self-gating audit stamp (the pattern in `notification-digests.js`). Register the new
   notification type in the three notify maps; a routine nudge is in-app, an overdue one may
   email.
5. **Write `first_contact_at`** on the first outbound activity, so speed-to-lead exists.

### Phase 1 — the compliance spine *(no external dependency; blocks Phase 3)*

Per phone number, stored and checked **before a dial is offered**: line type, national DNC
scrub date + result (safe harbour needs ≤31 days), internal DNC flag, state-list flag,
consent record if any, and revocation events. Hard blocks: internal DNC; national DNC with
no consent; a stale scrub; **outside 8am–9pm at the called number's local time**; and the
FL/OK/WA/MD frequency caps. A structured **do-not-call capture** the officer can hit in one
click, honoured company-wide across every channel (the April 2025 revocation rule). A
scripted opener with a stored version. Immutable per-attempt logging.

**Never built:** prerecorded or AI voice, ringless voicemail, predictive dialing, or any
"call this whole list" button.

### Phase 2 — Elementix research panel, read-only *(needs the auth answer)*

`src/elementix/client.js` on the house pattern: the only module that talks to Elementix,
`ELEMENTIX_ENABLED` + `ELEMENTIX_DRYRUN` in `src/lib/integrations/switches.js`, a local token
bucket well under the shared 1,000/hr ceiling, read-only, integration card on the API-Health
page, credential pluggable so it works with whatever Elementix answers.

On a lead: paste an address or a name → owner, their portfolio, exposure, recent activity,
foreclosure count, with a link back to Elementix. **No contact data at this stage** — this
phase is worth shipping on its own, because it is the research an officer does by hand today.

### Phase 3 — skip trace *(needs Phases 1 + 2)*

`get_contact_status` first, always — an already-unlocked person is free. Then an explicit
per-person human click, never a batch, with the cost stated on the button. Poll
`get_contact_info` in a worker. Results land in `lead_contacts` with full provenance, each
number entering Phase 1's checks before it can be dialed. Per-officer spend budget and an
admin view of it, keyed off `unlockedBy`.

### Phase 4 — RingCentral call recording → CRM *(no Elementix dependency)*

**Shape:** one **JWT service user** (a dedicated Super Admin extension, not per-officer
tokens — RingCentral's own docs recommend exactly this) → account-wide
`telephony/sessions` webhook filtered `statusCode=Disconnected&withRecordings=true` → queue
the `telephonySessionId` → a deferred worker polls the company call log (`view=Detailed`)
with backoff → download from `recording.contentUri` → store in our own storage → attach to
the lead.

The traps, all confirmed in RingCentral's docs:
- **There is no recording-ready event.** The webhook says the call ended, not that media
  exists. Media lags by seconds to minutes and 404s until processed — a first 404 is not
  "no recording."
- **Call Log APIs are the "Heavy" bucket: 10 requests/minute.** That is the binding
  constraint. On a 429, stop — retrying resets the penalty window.
- **`view=Simple` omits `legs`**, and a transferred call carries its recording on a leg.
- **Media is on a different host** (`media.` not `platform.`) and needs the Bearer header
  carried across the redirect — many HTTP clients strip it.
- **Retention is 90 days OR 100,000 recordings, whichever comes first** — a busy account can
  lose recordings well inside 90 days. Copy within days.
- Correlate on `sessionId`/`telephonySessionId`, never `id`, or one call attaches twice.
- **Automatic recording (ACR) must be switched on by an admin**, and cannot be tested in
  sandbox at all — this needs a production pilot on two extensions.

**Gating requirement:** recording cannot ship before the announcement does. Pennsylvania is
an all-party-consent state and we lend there; California's §632.7 covers cell calls and
applies to the *parties* (*Smith v. LoanMe*) at $5,000 per violation. So: an announcement on
100% of recorded calls, played before any audio is written, buffer discarded if it fails,
and the strictest state's rule applied to every call. If we ever transcribe, the
announcement must say so and the vendor needs a no-training DPA.

### Phase 5 — track-record verification *(underwriting plane, separate from all of the above)*

For each claimed deal on a real applicant: `match_person(name, state)` → gate on
`nameCommonnessScore` → `get_person_properties` → match each claimed line through the
**existing** `track-record-key.matchTrackRecord` chokepoint, never a new normalizer.

Then compare what the borrower typed against the record: purchase price, sale price,
acquired and sold dates, hold period. Raise **one new advisory finding code** in
`track_record_findings` with resolution options, which automatically blocks the experience
condition until a human settles it.

**The rules this must obey, and none is negotiable:**
- **Silence is not a negative finding.** In Passaic, 60% of LLCs cannot be linked to their
  owners. A missing record raises nothing.
- **Nothing auto-verifies and nothing auto-writes to a track-record line.** PILOT proposes;
  a human clicks. `verification_status='limited'` is a human's choice, offered with the
  evidence attached.
- **A common name never auto-matches** — that is what `nameCommonnessScore` is for.
- **Show the borrower the data and let them explain before any decision.** If terms move
  because of it, an adverse-action notice is owed (ECOA/Reg B applies to business credit,
  and vendor-sourced data pulls in FCRA §615(a)).
- **Advisory only**, per the governing rule that automated findings never block a human.
- Remember it is not read-only: lowering verified experience reopens conditions and can flag
  a registration stale.

**Genuine value beyond verification:** `isNonArmsLengthTransfer` (a "flip" sold to a related
party is not a market exit), `otherPeople` (a claimed solo deal that was a partnership),
`preforeclosureCount`, and per-lender-type first-borrow dates as a cross-check on claimed
experience. We have no source for any of those today.

---

## 5. Open questions

1. **Elementix authentication** — outstanding with the vendor. Phases 0, 1 and 4 do not wait
   on it. Phase 2's client is built with the credential pluggable.
2. **Is Elementix's contact product FCRA or non-FCRA classified?** This decides whether the
   two-plane separation is sufficient or whether the underwriting use needs a different
   product entirely. Ask the vendor; then counsel.
3. **Unassigned leads** — today every officer can convert any unassigned lead. Intended?
4. **Automatic call recording** — on for every officer, or only some? It cannot be tested in
   sandbox, so this needs a production pilot.
5. **Skip-trace budget** — per officer per month, and who approves an increase.

## 6. Explicitly not building

Prerecorded / AI-voice outreach · ringless voicemail · predictive or progressive dialing ·
any bulk "trace this whole list" action · any automatic skip-trace spend · promotion of
marketing-plane contact data into an underwriting decision · export of enriched contact data
anywhere · auto-verification of a track record · a shared "investor score" surfaced to note
buyers (that would likely make us a consumer reporting agency).
</content>
