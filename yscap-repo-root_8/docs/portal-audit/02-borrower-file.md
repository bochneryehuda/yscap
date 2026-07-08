# Section 2 — The Borrower's File: What the Borrower Sees

_Part of the [Portal Look-Back Audit](./00-MASTER-PLAN.md). We only write up
problems here — no code is being changed._

---

## What this section is about

This is the heart of your worry: **exactly what data reaches the borrower** —
on their screen, in their emails, in their PDFs — and whether anything
staff-only slips across. It also covers the flip side: **what a borrower is
allowed to change**, and whether they can change something that should be
locked.

Three AI agents went at this from three angles: (1) everything the **backend
sends** to a borrower, (2) everything the **screens, emails, and PDFs** actually
show, and (3) everything the borrower can **do / change**. I then checked their
biggest claims against the real code.

**What we wanted here (from all our chats):** the borrower sees a clean,
borrower-safe version of their own file — plain-English condition names, their
own numbers, their own documents — and **never** our capital-partner names,
our margin, internal notes, or staff identities. And they can fill in their
info, but they can't rewrite the deal.

---

## The big headline first: the capital-partner-name wall is holding — for now

Good news, and it's the thing you care about most: **we found no live leak of a
capital-partner name (BlueLake, Temple View, RCN, Churchill, Fidelis) to a
borrower today.**

- The built borrower app has **zero** partner-name text in it.
- Term-sheet PDFs say only **"YS Capital Group."**
- Borrower emails are clean.
- The one place a partner name was ever seeded into a condition ("BlueLake file →
  two months of statements") is **automatically scrubbed on every server start**
  by a later migration.

**But there's a loaded gun** (finding S2-01/S2-02 below): the borrower's *emails
and alerts* are built to fall back to the **internal** condition wording when the
borrower-friendly wording is blank. Today that shows clunky internal phrasing.
The day any staffer types a partner name into an internal label — which the
system *allows* on staff screens — that name gets emailed straight to the
borrower. The guardrail you rely on everywhere else is missing in the alert
code. That's why S2-01 and S2-02 are the top of this list.

Also note: **Section 1's two biggest leaks live on this same borrower file** —
the internal margin (S1-04's cousin) and the raw application. This section
widens that into the full list of what's leaking and adds the write-side
problems.

---

## The scoreboard for this section

| 🔴 Critical | 🟠 High | 🟡 Medium | ⚪ Low | Total |
|:-:|:-:|:-:|:-:|:-:|
| 0 | 3 | 6 | 4 | **13** |

Start with **S2-01, S2-02, S2-04** (the leaks) and **S2-05** (borrower rewriting
the deal).

---

## The findings

Format, same as always: **🐞 The Bug → 🔎 Troubleshooting → 🔧 The Fix.**

---

### 🟠 S2-01 — Borrower emails, alerts, and the LLC screen fall back to our INTERNAL condition wording
**Severity: 🟠 High** · Where: `src/routes/staff.js:2703, 2738` (+ the "added a document" and reminder alerts), `src/lib/llc.js:41-42`

**🐞 The Bug.** Every condition on a file has two names: a plain **borrower**
version and an **internal** staff version that can hold underwriting or
capital-partner context. The borrower's main portal list correctly never shows
the internal one. But the code that writes the borrower's **emails and pop-up
alerts** — and the borrower's **LLC document screen** — says "use the borrower
name, but if it's blank, use the internal name." When the borrower name was
never filled in, the borrower gets the internal wording.

**🔎 Troubleshooting.** In the alert builders, the query literally reads
"borrower label, or the internal label if that's empty," then drops the result
straight into the message sent to the borrower. We can see it live: the
bank-statements condition has no borrower-friendly name set, only the internal
one — *"Bank statements received & meet required liquidity."* If staff reject a
document there, the borrower's email title reads exactly that. Compare the safe
path — the portal's own condition list substitutes a generic *"an item your loan
team needs"* instead. The alerts and the LLC screen skip that safety net. **This
is the loaded gun for a partner-name leak:** put "BlueLake payoff" in an internal
label and it emails out.

**🔧 The Fix.** In every alert/email builder and on the LLC screen, **stop
falling back to the internal wording.** Use the borrower version; when it's
blank, use a generic phrase like *"an item your loan team needs"* — the exact
thing the portal list already does. Also give the bank-statements condition a
proper borrower-friendly name so borrowers see plain language.

---

### 🟠 S2-02 — The "request a document" button emails whatever staff type, word-for-word
**Severity: 🟠 High** · Where: `src/routes/staff.js:992-1009`

**🐞 The Bug.** When staff use the quick "request a document" action, whatever
they type is saved as the **internal** name (there's no separate borrower box on
this button), and the borrower is **immediately emailed that exact text**.

**🔎 Troubleshooting.** The email inserts the raw staff-typed string:
*"[whatever they typed]" was added to your conditions.* Oddly, the portal then
shows that same item as the generic *"an item your loan team needs"* — because
this button never fills the borrower name. So the borrower sees the raw staff
text **in the email** but a generic label **in the portal** — which both proves
the raw text is leaking through the email and looks sloppy/inconsistent.

**🔧 The Fix.** Give this quick-add its **own borrower-facing wording**, and
never email the internal name. (Either add a "what the borrower sees" box, or
treat the typed text as borrower-facing and show it in the portal too — pick one
so the email and portal always match.)

---

### 🟠 S2-04 — The borrower's own file screen leaks our internal appraised value, the assigned underwriter, and a raw copy of our ClickUp data
**Severity: 🟠 High** · Where: `src/routes/borrower.js:272-315` (the strip-list) — _widens Section 1's S1-03_

**🐞 The Bug.** When a borrower opens their file, the system grabs **every**
column about that file and then deletes a hand-written list of "secret" ones
before sending. That list is out of date, so a pile of internal fields ride
along: **our internal appraised value** for the property, **which underwriter**
is assigned, a **raw mirror of our ClickUp fields**, and more — plus the two
Section 1 leaks (the margin inside the registered quote, and the raw
application).

**🔎 Troubleshooting.** We confirmed these are real columns on the file that are
**not** on the delete-list: `actual_appraised_value` and `approx_appraised_value`
(our internal appraisal figures), `underwriter_id` (the assigned underwriter),
`clickup_shadow` + `clickup_shadow_hash` (a JSON copy of our internal ClickUp
fields), plus `visible_officer_ids`, `co_borrower_task_id`, and sync bookkeeping.
The capital-partner name column itself **is** on the delete-list (good) — but
this is the same trap as before: **send-everything-then-hide** means the *next*
internal field added leaks automatically.

**🔧 The Fix.** Flip this screen from a **"hide-list" to a "show-list"**: send
only the specific fields the borrower screen needs — exactly how the file *list*
screen already works. That one change closes this **and** the Section 1 margin /
raw-application leaks in one move, and makes future leaks impossible by default.

---

### 🟡 S2-05 — A borrower can silently rewrite the deal's numbers (ARV, rehab, price) — even after it's approved — with no record
**Severity: 🟡 Medium** (High once the file is priced) · Where: `src/routes/borrower.js:1008-1042`

**🐞 The Bug.** There's a "fill in missing details" action that's supposed to let
a borrower complete blank fields early on. But it doesn't check the field is
actually blank, doesn't check the loan's stage, and **writes nothing to the audit
log.** So a borrower (or co-borrower) can change the after-repair value, rehab
budget, purchase price, program, and property type **at any time** — including on
an approved or funded file — and nothing records that it happened.

**🔎 Troubleshooting.** The "only if empty" check looks at the value *coming in*,
not the value *already saved* — so a real number sent in overwrites whatever was
there. There's no loan-stage lock, and unlike the sibling "info condition" path
(which does write an audit trail), this action writes none. These fields feed the
pricing engine and the condition rules, so changing them shifts the deal. The
borrower's activity feed only shows *audited* actions, so this change is
invisible there too.

**🔧 The Fix.** Lock these deal-economics edits once the file moves past early
intake (the same stage-lock the "link entity" action already uses), only fill a
field when it's genuinely empty, and **write a before/after audit entry** the way
the staff edit screen does.

---

### 🟡 S2-06 — The borrower's track-record screen shows our internal loan-officer notes
**Severity: 🟡 Medium** · Where: `src/routes/borrower.js:1134-1141`

**🐞 The Bug.** The screen that lists a borrower's past deals sends **every**
column of each record — including `lo_notes`, the **internal loan-officer note**
about that deal, and which staffer verified it.

**🔎 Troubleshooting.** The query is a "send all columns" (`SELECT t.*`), and
`lo_notes` is a real staff-only column on those records. So a candid internal
note like *"borrower's numbers don't add up on this flip"* would be sent straight
to the borrower, along with the verifier's staff id.

**🔧 The Fix.** Change this to a **show-list** of only the borrower-safe facts
(the deal details, whether it's verified, and the document count) — drop
`lo_notes`, the verifier id, and the sync bookkeeping.

---

### 🟡 S2-07 — A borrower can overwrite an underwriter's private note on a condition
**Severity: 🟡 Medium** · Where: `src/routes/borrower.js:653-658`

**🐞 The Bug.** When a borrower submits a tool-backed task (like the rehab
budget), the code lets a `notes` value from the borrower **overwrite** the
condition's internal staff note.

**🔎 Troubleshooting.** The save uses "use the borrower's note if they sent one,
otherwise keep the existing note" — but the field it writes to is
`checklist_items.notes`, which is the **internal staff note** (the same field the
portal is careful never to *show* a borrower). So a borrower who includes a
`notes` value in that submission replaces whatever an underwriter had written.

**🔧 The Fix.** Don't let the borrower write the internal note field at all. If we
want to capture a borrower comment, store it in a **separate borrower-owned
field**, never the staff note column.

---

### 🟡 S2-08 — Our internal fee/margin block rides along in the borrower's pricing responses
**Severity: 🟡 Medium** · Where: `src/routes/borrower.js:394-395, 407-408, 495` (three pricing endpoints)

**🐞 The Bug.** The pricing engine attaches an internal `adminPricing` block
(our markup, origination %, and fee build-up) to every quote. One borrower
pricing screen correctly strips it out; **the other three pricing responses don't.**

**🔎 Troubleshooting.** The read screen deliberately removes `adminPricing`
before sending — proof it's meant to be hidden — but the live quote it computes,
and the "quote" and "register" buttons, return it raw. In the everyday case the
actual **markup number** is blank for a normal borrower (only staff can set it),
so the sensitive spread usually doesn't escape here — but the whole internal
block is on your "never show" list, and any staff-registered scenario that
carried a markup would surface it.

**🔧 The Fix.** Run all three pricing responses through the **same strip** the
read screen already uses — remove the `adminPricing` block (and all the internal
override fields, not just the two it removes today) before sending to a borrower.

---

### 🟡 S2-09 — A borrower can mark a staff-only condition as "received"
**Severity: 🟡 Medium** (needs the item's hidden id) · Where: `src/routes/borrower.js:1091-1096, 1304-1311`

**🐞 The Bug.** Two borrower actions — attaching a document, and submitting a
service contact — check only that the condition belongs to the borrower's file,
**not** that the condition is a borrower-facing one. So a borrower could flip an
**internal, staff-only** condition to "received."

**🔎 Troubleshooting.** Other borrower actions correctly require the condition to
be borrower-facing; these two forgot that check. Practically, it requires knowing
the condition's hidden id (a long random code we don't normally show the
borrower), which limits how easily it can be done — but the check should be there.

**🔧 The Fix.** Add the same **"borrower-facing only"** check to the
document-attach and service-contact actions, and confirm the contact action is
only used on actual contact tasks.

---

### 🟡 S2-03 — "Request more documents" permanently copies internal hint text into the borrower-visible field
**Severity: 🟡 Medium** · Where: `src/routes/staff.js:2680-2687`

**🐞 The Bug.** When staff accept a document but ask for another, the code reads
the current hint as "borrower hint, or the **internal** hint if blank," adds
"Still needed: …," and writes the result back into the **borrower-visible** hint.
If there was no borrower hint, this **permanently promotes the internal hint into
borrower-visible text.**

**🔎 Troubleshooting.** This is the S2-01 fallback problem, but worse: S2-01 shows
the internal wording once in an alert; this one **saves** it into the borrower
field, so it stays visible on the file from then on.

**🔧 The Fix.** Build the "Still needed" note from the **borrower hint only**
(never the internal hint), and only ever write borrower-safe text into the
borrower hint field.

---

### ⚪ S2-10 — A co-borrower can switch the loan's vesting entity to their own LLC
**Severity: ⚪ Low** · Where: `src/routes/borrower.js:831-853`

**🐞 The Bug.** On a joint file, the "link entity" action lets **either** party
set the file's vesting LLC — so a co-borrower could make the loan vest in **their
own** entity instead of the primary borrower's.

**🔎 Troubleshooting.** The action checks the LLC belongs to "the person logged
in," but on a joint file that can be the co-borrower. Everywhere else, entity
*management* is kept with its owner (a co-borrower gets read-only) — but this one
action lets them change which entity the loan vests in.

**🔧 The Fix.** Limit "link entity" to the **primary borrower**, or require the
chosen LLC to belong to the file's primary borrower.

---

### ⚪ S2-11 — Borrower screens reveal which staff member verified/reviewed their file
**Severity: ⚪ Low** · Where: `src/lib/llc.js:46`, `src/routes/borrower.js:1134`, `src/lib/llc.js:138`

**🐞 The Bug.** The borrower's LLC and track-record screens include the **name or
id of the staff member** who verified the entity or reviewed each document.

**🔎 Troubleshooting.** These screens legitimately show *whether* something is
verified and any rejection reason — but they also carry `verified_by` (a staff
id) and `reviewed_by_name` (the reviewer's full name), which the borrower has no
need to see and who may not even be on their contact card.

**🔧 The Fix.** Drop the reviewer name and verifier id from the borrower-facing
screens (select only the borrower-relevant columns).

---

### ⚪ S2-12 — A staff document uploaded without tagging a condition becomes borrower-visible by default
**Severity: ⚪ Low** · Where: `db/014_document_visibility.sql:17`, `src/routes/staff.js:2564-2593`

**🐞 The Bug.** A staff upload is marked "staff-only" **only** when it's tied to a
staff condition. If a staffer uploads an internal document to the file **without**
attaching it to a condition, it falls through to the default of
**borrower-visible** — so the borrower can download it.

**🔎 Troubleshooting.** The borrower download path correctly requires
"borrower-visible," so everything hinges on staff uploads being classified
right. The known internal conditions are handled correctly; the gap is ad-hoc
internal uploads with no condition attached.

**🔧 The Fix.** Flip the default so a document is **staff-only unless someone
deliberately makes it borrower-visible** (or require every staff upload to state
its visibility).

---

### ⚪ S2-13 — The pricing engine in the browser contains our internal 0.5% markup (pre-existing / already public)
**Severity: ⚪ Low — business decision** · Where: `web/portal/engines/gold-standard.js`, `standard-program.js` (frozen engines)

**🐞 The Bug.** The pricing math runs in the borrower's browser, and the code
carries our internal **0.5% markup** and the full rate matrix as readable values.
A technical borrower could open developer tools and read them.

**🔎 Troubleshooting.** On screen and in the PDF, only the final borrower rate
shows — the markup never displays separately. But the raw number is in the
shipped file. **Important:** these are the **frozen** engines that also run on
your **public marketing tools**, so this exposure already exists publicly and
predates the portal — the portal didn't create it. Per our rules, the frozen
engines must not be edited piecemeal.

**🔧 The Fix.** This is a **business decision**: if the 0.5% markup is a secret,
it needs a bigger, coordinated change (compute pricing on the server, or ship a
browser build without the markup) done together with the marketing site — not a
quick edit. If you're OK with it being discoverable (as it already is publicly),
we simply write that decision down and move on.

---

## Watch-items (not bugs today — keep them from becoming bugs)

- **Migration must keep scrubbing the seeded partner name.** The old
  `db/005_rtl_workflow.sql` source still contains the word "BlueLake" in a
  condition hint; a later migration overwrites it on every boot. Keep that
  overwrite in place, and **never seed a capital-partner name into a borrower-
  facing condition template.**
- **Never put a partner name in an internal condition label/hint** while S2-01,
  S2-02, and S2-03 are open — that's the path that would email it out.
- **The activity feed has a latent partner-name display path** (`lender` is in its
  field-label map); it's safe today only because staff actions are filtered out of
  the borrower feed. Keep that filter intact.

## Two things to double-check (NEEDS VERIFICATION)

- **Claimed experience.** A borrower can enter "claimed" experience through an
  info-condition. The authoritative pricing correctly ignores it — but confirm no
  condition *rule* quietly gives a pricing or tier benefit from claimed-only
  experience.
- **Product labels.** The product/program labels shown to the borrower appear to
  only ever be "Gold Standard / Standard" variants — confirm none of the live
  labels contains a capital-partner name.

---

## What's already solid (don't re-worry about these)

- **No capital-partner name reaches a borrower today** — confirmed across the
  built app, emails, PDFs, and all borrower data.
- **A borrower cannot verify themselves, set their own tier, change their file's
  status, or reassign their loan officer** — none of those fields is writable on
  any borrower route. This is genuinely well-locked.
- **Verified records are protected** — a borrower can't edit, delete, or swap
  documents on a track record or LLC that staff already verified.
- **Claimed experience can't beat the verified record** in the official
  (registered) pricing.
- **The portal condition & checklist lists never show internal wording** — they
  substitute a generic phrase (this is the exact guardrail S2-01/02/03 are
  missing elsewhere).
- **Borrower chat only ever shows the borrower channel** — internal team notes are
  structurally unreachable.
- **The activity feed shows the borrower only their own actions** — staff edits,
  reprices, and internal conditions are filtered out.
- **Documents, notifications, and messages are all scoped to the borrower's own
  file**, and a borrower can never self-accept a document.
- **Term-sheet PDFs and borrower emails are clean** — "YS Capital Group" only, no
  margin, no partner names.
- **The staff "cockpit" screen** (which shows FICO/margin/economics) is **staff-
  only** and never loaded on the borrower side.

---

## Suggested order to fix (when we get to building)

1. **S2-01 + S2-02 + S2-03** — close the internal-wording leak in emails/alerts
   and the LLC screen (the partner-name loaded gun). Fix these together.
2. **S2-04** — convert the borrower file screen to a show-list (also closes the
   Section 1 margin / raw-application leaks).
3. **S2-05** — lock deal-number edits + add an audit trail.
4. **S2-06 + S2-07** — stop the track-record note leak and the staff-note
   overwrite.
5. **S2-08 + S2-09** — strip the margin block from pricing responses; add the
   borrower-facing check to the two condition actions.
6. Then the Lows (S2-10 → S2-13), with S2-13 handled as a written business
   decision.

---

_Next section: **Section 3 — The Loan Officer's Desk (pipeline & the staff
file).** We'll turn the lens around: which files a loan officer can reach, the
SSN/PII reveal, edit/assign/verify, and what one staffer can see about another's
files._
