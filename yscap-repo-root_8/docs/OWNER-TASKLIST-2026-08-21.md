# Owner task list — 2026-08-21

**Status legend:** ☐ not started · ◐ in progress · ☑ shipped · ⚠ blocked / needs owner answer

This is the master list for the owner's 2026-08-21 instruction set. The owner's closing instruction was:

> *"Take the whole list layout, first an entire task list. Save every single word I said. You shouldn't
> forget anything. Make research on how it's the best way to build it on the strongest, highest level, not
> cheapy. Don't be afraid of wasting time. Not to everything in one batch, one shipment, high level,
> without mistakes. It's easy. You can take yourself several hours. If you have any questions, ask it now
> because I'm going to sleep."*

So: **the verbatim words are preserved in full in Appendix A at the bottom of this file** — nothing is
paraphrased away. The numbered sections below are the working breakdown of those same words, with the
research and the build plan attached to each.

Shipping rule from the owner: **not everything in one batch, one shipment.** Each numbered item lands as
its own commit (or its own small group of commits) with its own audit pass, per the mandatory
two-audit-agent gate in `CLAUDE.md`.

---

## Index

| # | Item | Area | Status |
|---|------|------|--------|
| 1 | Investor delivery data-tape Excel: scheduling | Investor delivery | ☑ |
| 2 | Investor delivery contacts: Fidelis / EMCAP prefill + CC | Investor delivery | ☑ |
| 3 | Data tape metrics: add Total LTC, remove Effective LTV | Investor delivery | ☑ |
| 4 | Refresh loses your place — deep-link state everywhere | Front end, global | ◐ |
| 5 | Email replies: manual attach + drag-and-drop | Email surfaces | ☐ |
| 6 | Drag-and-drop upload everywhere it's missing | Uploads, global | ◐ |
| 7 | Export all / export unverified with a NOT-VERIFIED stamp | Exports | ☐ |
| 8 | Feasibility report + GC contact into TPR export & SharePoint | Ground-up conditions | ☑ |
| 9 | Plans & permits → TPR, SharePoint **and Sitewire** | Ground-up conditions | ☑ |
| 10 | GC information condition: informational fields + GC PDF | Conditions | ☑ |
| 11 | Resend Draw form must work when unseen/expired | Draws | ☑ |
| 12 | Credit report import reads the WRONG scores (2 borrowers) | Credit | ☑ |
| 13 | Condition center: external notes for borrowers + TPOs | Conditions | ☑ |
| 14 | Conditions: add a document slot (not a borrower request) | Conditions | ☑ |
| 15 | Borrower profile reachable from inside a file | Navigation | ☑ |
| 16 | Overview hover button missing on full screens | Navigation | ☑ |
| 17 | Scope of work Excel import: drag-and-drop | Uploads | ☑ |
| 18 | ClickUp: Joshua Freidlander's files land in Lead Capture | ClickUp | ◐ |
| 19 | ClickUp: assigning an officer moves the task to their folder | ClickUp | ☐ |
| 20 | Rehab Budget PDF: value-add / narrative overlap | PDF | ☑ |
| 21 | Funded date auto-read from Encompass (`CX.FUNDEDDATE`) | Encompass | ☐ |
| 22 | Experience-count condition stuck at the old requirement | Conditions | ◐ |
| 23 | DocuSign: processor + officer always CC'd as viewers | DocuSign | ☑ |
| 24 | Marketing term-sheet leads: one session, contact info, officer link | Leads | ☐ |
| 25 | Trinity Manual section in the Draw Coordinator | Trinity | ☐ |

---

## 1. Investor delivery data-tape Excel — add the scheduling feature

> *"The invested delivery of the data tape Excel sheet is not set up well: 1. We need to add the
> scheduling feature over there."*

**What it means.** The investor-delivery send screen (the one that ships the data tape Excel) does not
offer scheduling. Other order-email surfaces in this system already schedule sends. The tape delivery
needs the same: pick a date/time, queue it, show it as pending, allow cancel/reschedule.

**Notes.** `db/599_scheduled_sends_for_order_emails.sql` already exists — the scheduled-send machinery is
in the repo for order emails. The highest-end shape is to reuse that one scheduler rather than build a
second one (CLAUDE.md: *one definition, never two*).

---

## 2. Investor delivery contacts — Fidelis and EMCAP prefill, plus CC

> *"It's automatically filling in the FileContacts as those same as the draw. It's a different contact.
> The draw context is the delivery contact for tape delivery for Fidelis is
> MBrancatella@fidelis-investors.com and you need to give the option to CC more people, and you
> automatically CC the people of the file, which is the processor or the officer. And for Emcap, we need
> to pre-fill the contacts for the data tape and Vesta delivery to bdetommaso@emcapfinancial.com and
> tmartello@emcapfinancial.com"*

**What it means.**
- The tape-delivery screen currently prefills the **draw** contacts. Wrong list — tape delivery has its
  own recipients.
- **Fidelis** tape delivery → `MBrancatella@fidelis-investors.com`.
- **EMCAP** data tape **and Vesta delivery** → `bdetommaso@emcapfinancial.com` **and**
  `tmartello@emcapfinancial.com`.
- There must be an **"add more CC"** option (free entry of extra people).
- The **file's own people are CC'd automatically** — the processor and/or the loan officer on that file.

**Build note.** Per-investor delivery recipients belong in one registry keyed by investor, not hard-coded
at the call site, so a future investor is a row and not a code change.

---

## 3. Data tape metrics — add Total LTC, remove Effective LTV

> *"and also, on the data-taped invested delivery, there is a new matrix that we don't have anywhere in
> our system, which is the effective LTV. He's calculating the total loan amount divided by the as-is,
> which is a ronc, and it's coming up as 108 LTV, 140 LTV. It's a stupid matrix, and I don't see any LTC
> total amount. We currently have initial LTV over there and total ARV TV. We need to add over there the
> total LTC and remove this other effective LTV, which calculates the total loan amount according to the
> initial and gets to 140 LTV."*

**What it means.**
- **Remove** the "Effective LTV" column/metric. It computes *total loan amount ÷ as-is value*, which is
  nonsense for a rehab loan (the total loan includes the rehab holdback, the as-is doesn't) and prints
  absurd values like 108% and 140%.
- **Add "Total LTC"** — loan-to-**cost**, the metric that is actually missing.
- Keep what's already right: **Initial LTV** and **Total ARV LTV** (owner says "total ARV TV" = ARV LTV).

**Open definition to confirm against our existing engine:** Total LTC = total loan amount ÷ total cost,
where total cost = purchase price (or as-is basis on a refinance) + total rehab budget. We already compute
LTC in pricing/eligibility — the tape must read **that same** definition, never a second copy.

---

## 4. Refresh loses your place — deep-link state everywhere

> *"There are a lot of places where, when you refresh your screen, you're not staying in the place where
> you are. Certain places it's fixed, but certain places, when you refresh, you get to a totally new
> section. I want you to dig in and find more places. For example, on the draw center, this is a major
> issue. For example, when I'm at application detail, like on the Deal section where I can go to
> application detail and Campus Thinking, let's say when I go to Campus Thinking and I refresh, I think
> I'm not staying there. We need to try to stay in the most possible exact place where you were originally
> when you refresh."*

**What it means.** Tab/section/sub-section state must survive a browser refresh. Some screens already do
this; many don't. **Draw center is called out as the major offender.** Application detail (the Deal
section → application detail, and the Encompass view — owner's "Campus Thinking" is Encompass) is called
out as another.

**Scope of the job:** audit **every** tabbed/sectioned staff screen, not just the two named, and make the
active tab, sub-tab, expanded panel, and selected row round-trip through the URL.

**Build note.** One shared hook that syncs UI state to the URL (and restores from it), applied everywhere —
not 30 hand-rolled `useState` fixes.

---

**SHIPPED (the mechanism + the places you named).** One shared thing, not thirty patches — the build note
on this item asked for exactly that.

**What was wrong.** Every screen kept "which section is open" and "which tab am I on" in its own private
memory, so each one lost your place its own way and any new screen inherited the problem by default. The
Draw Center was the worst case and for a structural reason: eleven of its thirteen sections are closed to
begin with, so a refresh threw away everything you had opened.

**What it does now.** Where you are lives in the address bar. So a refresh puts you back exactly where you
were — and, as a free consequence, the Back button works, and you can send somebody a link that opens on
the same spot. The address only ever records what you actually *changed*: a screen sitting at its defaults
still has a short, clean link.

**Covered:** every collapsible section on every screen that uses the standard layout (the loan file, the
Draw Center, the borrower's own file, the draw rules and broker-firm screens) — one change, all of them;
the **Encompass tab** ("Campus Thinking"); the pipeline's Pipeline/Leads tab; and the draw desk's filter.

**Proven in a real browser, not just built.** A build passing says nothing about whether a page renders, so
there is now a test that boots the real system, signs in, opens a section, refreshes, and checks it is
still open — and it was run against the *old* code first to confirm it reproduces exactly what you
reported.

**Not done yet:** the remaining smaller screens from the audit (roughly a dozen more filters and view
toggles). They now have one obvious way to be fixed, and none of them is the case you called major.

## 5. Email replies — manual attach + drag-and-drop into the compose box

> *"I don't know if we added this already, but on any reply to any Gmail section that we currently have,
> if it's The insurance order / The title order / The draw section / The general email inbox — We need to
> be able to attach documents over there manually and also drag and drop into the box of the email."*

**Surfaces named:** insurance order, title order, draw section, general email inbox — **and any other
reply box we have**. Both a manual attach button **and** drag-and-drop onto the compose box.

### ☑ SHIPPED

**All five surfaces at once, because there is only ONE composer.** The insurance order, the title order,
the draw section, the general email inbox and the closing chain all render the same reply box — so it took
one change, and it could not be half-done. A test asserts each of those screens still uses the shared one.

**Both doors.** An **Attach** button, and the **whole compose box** is the drop target — a person dragging
a document at an email aims at the message, not at a little tray beside it. Attached files show as chips
with a × to take one back off, and the box says so when it is empty.

**The email plumbing already carried attachments** (the closing package, the investor delivery and the order
emails all send them, both providers take them, and the Email Center records them) — what did not exist was
a way for a person to put one on a message they were writing. That is what was built, and every branch of
the reply carries them identically: closing chain, title, insurance, and the plain file reply.

**What it refuses, and why each one is there:**
- **bytes that are not really a file** — read through the one decoding chokepoint, never a bare decode
  (whose silent character-skipping is what once mirrored garbage into SharePoint as "a corrupted document");
- **a type taken from what the sender SAID rather than from the bytes** — a file called `invoice.pdf` that
  actually contains a web page is a script aimed at whoever opens it, and these attachments are opened by an
  outside company whose mail client we do not control. Web pages and SVGs are refused outright;
- **a filename that is not a filename** — paths, quotes, newlines and a NUL are stripped, and two files
  called `scan.pdf` are told apart rather than arriving as one name twice;
- **more, or bigger, than the provider will actually take** — measured against the LIVE provider's real
  ceiling in both dimensions (raw bytes AND the size on the wire, which is the number a receiving mail
  server measures). That ceiling is the closing package's own, reused rather than restated.

**Nothing is ever silently dropped.** Anything that cannot ride comes back named, with a reason in plain
words, and the screen says so — and the message still SENDS. One bad attachment never loses the reply.

Tests `scripts/test-email-compose-attach-pure.js` (44) and `scripts/test-email-compose-attach-db.js` (23,
real Postgres through the real HTTP door with the mailer stubbed, so what the provider was actually handed
is read back — a pure test cannot prove that, and this codebase has been bitten there before). **Five
mutations of the production code were each proven to fail them.**

---

## 6. Drag-and-drop upload everywhere it's missing

> *"We need to dig in. Where can we upload documents when we don't have the drag-in feature? The drag-in
> feature is very important, and in several places the drag-in feature is still missing. We can only click
> on it, and it will close your file, explode it, and it doesn't have the drag-drop."*

**What it means.** Audit **every** upload control in the product. Any that is click-only (opens the file
picker and nothing else) must also accept a dragged file. This is a sweep, not a spot fix.

---

**PARTLY SHIPPED — the dangerous half first.**

**The most important part is not drag-and-drop at all.** You said a file dropped in the wrong place "will
close your file, explode it" — and that is exactly what was happening. It is the *browser's* behaviour: with
nothing stopping it, dropping a file on a page makes the browser throw the whole app away and open the file
instead. Everything unsaved goes with it, and the file is not uploaded either. Nothing anywhere in PILOT was
stopping that.

**PILOT now stops it, on every screen.** A file dropped anywhere that is not an upload box does nothing
except tell you so — in PILOT's own words, naming where to drop it instead. Your work stays on screen. This
alone makes every remaining click-only upload merely *unhelpful* rather than *destructive*, which is why it
came first. Verified in a real browser, and verified against the old code to confirm it reproduces what you
described.

**Uploads that now take a dragged file** (they kept their button — this is in addition): the **message
attachment** on every thread — staff, borrower and broker; the **credit report import**, which now sorts a
drop by type so you can drag the data file *and* the report over together and both land in the right slot;
the **appraisal XML import**; and **lead files**.

**Every zone that was still click-only in the portal now takes a dragged file.** The list that was named
here as outstanding is done: the draws panel (**the manual wire form** and **the supporting documents**),
the **borrower's own draw uploads** (all three — adding a document to a draw, the documents that ride with
a draw request, and the per-line dispute photos), the **broker portal's uploads** (per condition and
unattached), **purchasing** (the purchase advice), the **new-file MISMO import**, the **labeling console**
and the **Arena proof photo** — plus the email compose box from item 5.

Each one keeps its button; the drag is *in addition*, never instead. Every one routes through the one shared
drop component, so a zone added next year gets the same behaviour in one line, and the test now lists all
twelve converted zones by name — a zone that loses its drop support fails the build.

**Two judgement calls worth knowing about.** On the borrower's draw-request uploads a DROP **appends** while
the picker **replaces**: the picker always reports its whole current selection, so replacing keeps the screen
equal to what will be sent, but a drop is additive by nature and dropping a second photo must not discard the
first. And the per-line dispute photos sit inside a list, which is exactly why the shared piece is a
*component* and not a hook — React forbids a hook in a loop.

**Still outstanding, named rather than implied:** the **non-owner-occupied affidavit**, and three of the
marketing-site tools (track record, term sheet, loan application), which need the small refactor the Scope of
Work tool has already had.

**Item 17 was already working** — the Scope of Work importer has accepted a dragged file for some time,
including one dragged straight out of Outlook.


## 7. Export button — export all / export unverified, with a NOT-VERIFIED stamp

> *"We're looking to enhance the export button. Right now, it's only exporting verified. We need to add a
> button over there for 'Export all of them' and also down verified ones. It should have a stamp next to
> it on the PDF or on the Excel, whatever you are exporting. Again, the regular export button (PDF or
> Excel) should only export the verified ones. There should be an extra option to export the PDF or an
> Excel from the unverified ones, but everything that is unverified should have a stamp that it's not
> verified yet, and it still needs to go through verification."*

**What it means.**
- Default/regular export (PDF **and** Excel) — **unchanged**, verified only.
- New: **Export all**, and **export the unverified ones**.
- Every **unverified** row/record in those exports carries a visible **stamp** — "NOT VERIFIED — still
  needs to go through verification" — in both the PDF and the Excel.

**Context:** this is the track-record export (verified vs unverified experiences). Confirm against the
export surface before building.

---

## 8. Feasibility report + GC contact info into the TPR export and SharePoint

> *"Please make sure you're adding the feasibility report that is uploaded to the feasibility condition
> and the contractor contact information in the TPR export and in the SharePoint."*

The feasibility report document (uploaded to the feasibility condition) and the contractor contact
information must both flow into the **TPR export** and the **SharePoint** mirror.

**SHIPPED — and it is two different jobs, so it was done as two.**

**The feasibility report was already there** and is now pinned. Anything uploaded to the feasibility
condition files with the **Scope of Work** in both the investor package and the team site, through the one
shared categorizer. That is not luck: the filename fallback does **not** recognise the word "feasibility",
so it rests entirely on the condition being mapped — which a test now states, so removing the entry cannot
quietly send it to the catch-all folder.

**The contractor's information had nowhere to come from** — see item 10, which is the same deliverable
from the other end: PILOT now keeps a real contractor record and prints it as a sheet that rides into both.

---

## 9. Plans and permits → TPR, SharePoint, **and Sitewire**

> *"In general, we need to make sure that any time plans and permits are uploaded, they should be included
> in the TPR and SharePoint, and it should be sent over to Sitewire as well. If there is Plans and Permits
> on File and Plans and Permits condition, it should be sent over to Sitewire the same way the appraisal
> is being sent over to Sitewire."*

Any plans-and-permits upload → TPR export **and** SharePoint **and** pushed to Sitewire, using the **same
path the appraisal already uses** to reach Sitewire. Both sources count: "Plans and Permits on File" and
the "Plans and Permits" condition.

**SHIPPED.**

**The TPR and SharePoint half was already true, and is now pinned.** Both plans conditions —
*Plans & permits (ground-up)* and *Plans & permits — confirmed before the first draw* — already file with
the **Scope of Work** in the investor package and in the team site, through the one shared categorizer, so
the two can never disagree. What was missing was a test saying so; there is one now, and it also covers the
feasibility report and the GC record, because "feasibility" and "general contractor" are **not** words the
filename fallback recognises — those two rely entirely on the code map, so removing an entry would quietly
send them to the catch-all folder.

**Sitewire is the new half, and it is the same path the appraisal takes** — your own words. It is a fourth
slot on the same Documents-tab push, with one difference that matters: unlike the appraisal it is a
**family, not one document**. A builder files a site plan, a permit and approved drawings separately and
the inspector standing on the site needs all of them, so each becomes its own Sitewire document, named
after the document itself (*"Plans and Permits - Building Permit.pdf"*) rather than numbered — an
inspector needs to tell a site plan from a permit. The keys are **stable**: a document filed later never
re-letters the ones already up there, or every re-push would look like a change and re-upload what
Sitewire already holds.

**"Any time they are uploaded" is a sweep, not a hook.** A plans document can arrive from at least four
doors (a staffer, the borrower, a broker, a vendor's email) and there is no single place they all pass
through — so a hook would be a list somebody has to remember to extend, and a door added next year would
silently not push. Instead a background pass picks up any managed file holding a plans document newer than
its newest plans push. It is cheap when there is nothing to do (the push dedupes on the content hash and
does not even open a Sitewire session unless something genuinely needs uploading), and a file drops out of
the sweep the moment it is up to date.

**Two things stated plainly.** (1) There is a **limit of 6** documents per push, and it is **reported, not
silent** — the draw panel says how many the file has and how many are not going, so nobody believes a tidy
list that quietly omits three sheets. Raise `SITEWIRE_PLANS_MAX` if the inspector needs more. (2) It uses
the **same document filter the appraisal slot uses** — current, not rejected, never internal, never the
purchase advice (that one names the note buyer, and Sitewire is where the borrower submits draws). It is
**not** accepted-only: holding a permit back until somebody reviews it would leave an inspector on a site
without it. Tightening that is your call, and it would have to move the appraisal beside it too.

Proof: eight new cases in `scripts/test-sitewire-doc-push.js` (both condition codes feeding it, stable
keys, every exclusion, the reported cap, the sweep picking a file up and letting it go again, and an
unmanaged file never being touched) plus the category pins in `scripts/test-sharepoint-category.js`. Six
mutations were proven to fail them.

---

## 10. GC information condition — informational fields + a laid-out GC PDF

> *"The GC information condition now only has an upload document slot. Keep that slot as an optional slot,
> which means it should not need to upload something to sign off the condition. You need to add that
> condition to be informational, to put in: the name / the phone number / the email address / license
> information. You can do research if there are any other official things that we need to enter as
> informational stuff from our official GC. Maybe business name is optional. Don't make all the fields
> required. And then, in the TPR export and in the SharePoint sync, you need to take this information and
> lay it out on a PDF GC contractor information nicely to include in the invested delivery TPR export
> SharePoint."*

**What it means.**
- The GC condition keeps its upload slot but the **upload becomes optional** — you can sign the condition
  off without a document.
- The condition becomes **informational**: name, phone, email, license information — **plus** whatever
  else research says a general contractor record officially carries (business/DBA name, license state +
  expiry, insurance/GL + workers-comp carrier and expiry, EIN, address, W-9 — to be decided by research).
- **Not all fields required.** Business name explicitly optional.
- A **generated "GC Contractor Information" PDF**, nicely laid out, is produced from those fields and
  included in the **TPR export** and the **SharePoint** sync (and therefore in investor delivery).

**SHIPPED** (db/605).

**The upload is optional now, and the condition still counts.** You can sign the GC condition off with
nothing uploaded — your words. It is still a **required** condition, so it still has to be dealt with
before clear-to-close, and it is still where a license certificate or a W-9 gets filed. (Making it
*optional* instead would have dropped it out of the readiness list altogether, which is not what you
asked for.) An ordinary document condition still refuses an empty sign-off — the change is only this slot.

**The record: what research says a contractor file actually carries.** You asked for name / phone / email /
license and for research into "any other official things". What a lender's contractor package and an
investor's file review actually ask for:

- **License number, license STATE and expiry.** The number alone is not checkable — a contractor license
  is issued per state, and only the pair can be looked up on a public register. Plenty of trades and a few
  states do not license at all, which is one reason nothing here is required.
- **General liability** and **workers' compensation** — each with carrier, policy number and expiry, kept
  **apart** on purpose: they are two different policies, more often than not from two different carriers,
  and a file that has one and not the other is a real state a reviewer must be able to see.
- **EIN from their W-9** — a business identifier that is already on every W-9 in the file. A personal
  Social is never typed here.
- **Business address and website** — how somebody confirms the company is real before a draw is wired.

**Nothing is required.** Your instruction, and also right: a builder gives you a phone number today and an
insurance certificate next week, and a record that refuses to save until it is complete is a record nobody
starts. A blank field simply does not print, and the sheet says in its footer that **a blank is a blank** —
never "there is no license".

**The name and phone are NOT retyped here.** The contractor is a **file contact**, which is the one record
this system already keeps of a company — so the card shows it and points at the contacts section to change
it. A second box for the same phone number is exactly how two records of one company start disagreeing.
What is edited on the condition is only the part that would be meaningless on a title company.

**The sheet.** Saving redraws a one-page **"General Contractor Information"** PDF in the PILOT house style,
files it on the GC condition, and it reaches the investor package and the team site's **Scope of Work**
folder with no new export machinery — because a document on that condition already files there. It is born
**accepted** (PILOT drew it; there is nobody to review it, and a pending copy would be held back from the
very export it exists for), it **supersedes only its own predecessor** — never the license certificate a
human filed on the same condition — and saving the same thing twice redraws **nothing**, which is what
keeps the SharePoint version folders from filling with identical sheets. A policy that has already lapsed
prints **(expired)** beside it; that is the one thing a reader cannot work out at a glance.

Proof: `scripts/test-gc-record-pure.js` (the field list, that nothing is required, and the sheet's own
words read back OUT of the PDF — including the expired flag and the sparse case that prints no empty
headings) and `scripts/test-gc-record-db.js` (real Postgres, real HTTP: the optional sign-off with an
ordinary condition as a control, the partial save that does not blank what came before, and the sheet
actually being selected into the investor package). Four mutations were proven to fail them.

**One open question for you:** should signing off the GC condition require *something* — at least a name
and a way to reach them — or stay entirely at the team's discretion? You said the upload should not be
required; you did not say whether the record should be. It is currently at their discretion.

---

## 11. Resend Draw form when it's gone stale or expired

> *"Make sure the Resend Draw form works if the borrower hasn't seen it for a long time or the form has
> expired. The Resend button actually works by the Draw section."*

The Resend button on the Draw section must genuinely work — including the case where the borrower never
opened it for a long time, or the link/form has expired. Re-issue a fresh, valid form.

**SHIPPED.** What was actually wrong, in plain words: a "resend" only pokes the form that is already out
there — it never makes a new one. But a form nobody signs does not live for ever: DocuSign kills it after
about four months, which is exactly the case the owner described. So the reminder had nothing left to poke.

Two things were happening, and only one of them was visible:

* **When PILOT already knew the form was dead**, the Draw section was fine — it swaps the Resend button for
  "Re-send draw request form", which sends a brand-new one. That half already worked.
* **When PILOT had not caught up yet** — our copy still said "out for signature" while DocuSign had already
  killed it — pressing Resend gave a plain **"server error"**. That is the dead end, and that is what is fixed.

Now: PILOT asks DocuSign, and when the answer is "that form is gone" it says so in words, records it, and
offers **"Send a fresh draw form now?"** — one click, and the new form goes out. The same wording is used
whether PILOT works it out itself or hears it from DocuSign, so nobody ever gets two different answers about
the same form. A form that is still alive but simply old is still sent a reminder — with a note saying how
long it has been waiting, so nobody presses the button five more times.

The e-sign panel (term sheet, Heter Iska) shares the same button, so it is fixed there too, and the card now
refreshes itself so the "issue a new one" button is actually on screen when the message tells you to use it.

Nothing here can send a form on its own, and nothing changes what the borrower signs.

---

## 12. Credit report import reads the WRONG scores

> *"render api rnd_Vbpp85PouGqZSXIL7JdjWJBZ1mEc — you can use this to troubleshoot a major bug that we
> have. Maybe this bug is even further than I think, but right now I'm looking at a file that has two
> borrowers. I imported the two credit reports for them, and it's not reading the scores correctly. Again,
> the final middle score that he's getting is correct because our rule is that we're using the middle
> score of the higher-scoring borrower, but the scores he's populating are not actually correct. Look at
> the two screenshots I'm giving you. The file information: try to access the actual XML and the PDF of
> the credit report. Try to see why he's importing the wrong scores. I have no idea what's going on with
> him. How stupid can a human be? Mordechai Scharf & Michelle Bleier · 598 Pawling Ave, Troy, NY
> 12180-5814 · YSCAP258134859 · Fix & Hold (BRRRR) · Purchase · $216,688"*

**Evidence from the two screenshots the owner attached.**

Credit report page (all pulled 08/20/2026):

| Name on the report | Repository | Model | Score | Reported On |
|---|---|---|---|---|
| Mordechai Scharf | TransUnion | FICO Score 4 | **685** | TUC-B1 |
| Mordechai Scharf | Experian | FICO Score 2 | **704** | EXP-B1 |
| Mordechai Scharf | Equifax | FICO Score 5 | **674** | EQX-B1 |
| Michelle H. Bleier | TransUnion | FICO Score 4 | **719** | TUC-C1 |
| Michelle H. Bleier | Experian | FICO Score 2 | **680** | EXP-C1 |
| **Michelle Katz** | Equifax | FICO Score 5 | **732** | EQX-C1 |

PILOT's Credit & Background panel shows: **Mordechai Scharf · MIDDLE 719**, **Michelle Bleier · MIDDLE
719**, **719 HIGHER — PRICES THE DEAL**. Soft pull, new order, dated Aug 20 2026, imported 8/20/2026
4:50:17 PM, ref 93123672.

**The truth.** Mordechai's three scores are 685 / 704 / 674 → **middle = 685**. Michelle's three are
719 / 680 / 732 → **middle = 719**. Higher borrower's middle = **719**, which prices the deal. So the
final number is right **by luck** — but **Mordechai's middle is printed as 719 instead of 685**, i.e. the
importer is attributing Michelle's row to Mordechai (or collapsing both borrowers into one bucket and
showing the same middle twice).

**Suspected cause to prove, not guess.** The per-borrower attribution. Note the report's Equifax row for
the co-borrower is under a **different surname — "Michelle Katz"** (a maiden/alias name), while the
borrower record says "Michelle Bleier". If the importer matches score rows to borrowers **by name**, the
Katz row won't match Michelle and the bucketing collapses. The report itself carries the authoritative
key in **`Reported On`: `*-B1` = borrower, `*-C1` = co-borrower** — that partition is exact and
name-independent, and it is what the importer should be keyed on (Xactus/MISMO `BorrowerID` /
`_PartyIdentifier`).

**To do:** pull the actual **XML and PDF** for ref `93123672` on file `YSCAP258134859` (Render API key
supplied above), prove the parse, fix the attribution at the source, and backfill.

---

## 13. Condition center — external notes visible to borrowers and TPOs

> *"on the condition center, maybe we implemented it already. Right now, I only see internal notes. We
> should also be able to put external notes that should be visible for the borrowers and TpOS."*

Two note streams on a condition: **internal** (staff only, exists today) and **external** (visible to the
borrower and to TPOs). Must be unmistakably distinguishable so nobody posts an internal note externally by
accident.

**SHIPPED** (db/604).

**What was actually missing.** A condition had exactly ONE note field, and it is internal — the borrower's
own screen says so in the code and refuses to read it, because it carries underwriting reasoning and
capital-partner names. So the only ways to tell a borrower something about a *specific* condition were to
reject a document (which needs a document to reject) or send a message that is not attached to the
condition at all. The sentence a borrower most needs — *"the August statement, not July"* — had nowhere to
live next to the thing it is about.

**Now there are two, and they can never swap places.** They are two different columns, written through the
same one door, read by different surfaces. Nothing that was internal yesterday can become visible: no
existing note was copied anywhere, and every borrower and broker route still refuses to select the
internal one.

**Telling them apart is done in words, never by colour.** The external note says who will read it *three
times before you type* — on the button ("+ Add a note the borrower will see"), in the box itself, and in a
band that stays on screen the whole time the box is open — plus a teal rule down the side that the internal
note does not have. Staff also see **who wrote it and when**; the borrower and the broker see the note and
the date, never the name — putting an individual underwriter's name in front of an outside party is a new
exposure nobody asked for.

**It is scrubbed like everything else a human types.** A staff member can absolutely write "Fidelis is fine
with the August statement" into an external note, so it goes out through the same capital-partner scrub as
every other borrower-facing word — and the shared reader **refuses to send anything at all** if the
scrubber is missing, rather than sending an unscrubbed note.

**It does not email anybody, deliberately.** The note appears on the condition it is about, on the screen
they are already working from. Turning it into an email would be a new routine-activity notification,
which is exactly the bombardment the notification rules cut back. Making it notify is your call.

Proof: `scripts/test-condition-external-note-db.js` (real Postgres, real HTTP, all three surfaces at once —
with a capital-partner name sitting in the internal note the whole run as a live control, so a reversed
wiring would put the word "Fidelis" on the borrower's screen and the test would say so) and
`scripts/test-condition-external-note-pure.js` (the rules, and the source invariants, in the no-database
job too). Five mutations were proven to fail them — including one that only bit after the assertion was
anchored to the start of a line.

---

## 14. Conditions — add a document slot yourself (not a borrower request)

> *"In the conditions right now, you can request another doc, and it opens up another slot, like a
> separate slot for the invoice, separate slots for the binder. You can do that on any condition, but that
> is putting only a request, which is requesting it from the battle. If you have a document that you want
> to put in a separate slot, I don't use that request button. Next to the request button, maybe add the
> feature: I just open a new document slot in this condition, and it should go together with that
> condition in the same folder and stuff like that."*

Today "Request another doc" opens a slot **and asks the borrower for it**. Add, **next to** that button, an
"**Add a document slot**" action that opens an extra slot **without** sending a request — for a document
staff already has. It files into the **same condition and the same folder** as everything else on that
condition.

**SHIPPED.** The button is there, next to the request button, on every document condition.

**Half of this was already built and unreachable, which is worth recording.** The server side has always
been able to open a slot without asking the borrower for anything — `lib/conditions/extra-slots.js` has
carried an `internal` audience since the day it shipped, and only an EXTERNAL ask sets the condition to
"requested" or notifies the borrower. What was missing was a way to get to it: there was ONE button, and
the internal option sat behind **two** confirm dialogs that only appeared on a borrower-facing condition.
So *"I don't use that request button"* was exactly right — opening an empty slot of your own meant
answering two questions about the borrower first.

**Now the button IS the choice.** A borrower-facing condition shows both — *Request another document*
(asks the borrower, shows on their portal, notifies them) and *Add a document slot* (opens an empty named
slot for us, asks the borrower for nothing). A staff-only condition shows only *Add a document slot*,
because there is nobody to request from. The two dialogs are gone: pressing one button is the whole
decision, so there is nothing left to confirm.

Either way the slot belongs to that condition, so what you upload into it inherits the condition's TPR
export folder and its SharePoint folder with no second machinery — the owner's *"it should go together
with that condition in the same folder"*. Opening a slot on a signed-off condition reopens it, whichever
button opened it: the sign-off was made before the new document was asked for.

Proof: `scripts/test-condition-slot-buttons-pure.mjs` (the reachability — both doors, each naming its
audience as a literal, the add-a-slot door NOT hidden behind the borrower-facing guard, both condition
rows still mounting it; three mutations proven to fail it) and new sections **B5–B8** in
`scripts/test-condition-extra-slots-db.js` (against a real Postgres: an internal slot does NOT turn the
condition into a request and tells the borrower NOTHING — measured against the external ask in the same
run as a live control — and still reopens a signed-off condition; both proven to fail when the server's
external-only guards are mutated out).

---

## 15. Borrower profile reachable from inside a file

> *"Right now, when you're in a file, you don't have anywhere to access the borrower profile. In general,
> there's an entire massive profile of entities and stuff like that. You only see the details of the file.
> There should be a link somewhere to open up the full. In the file, you should be able to access it
> directly somehow and open up the borrower's profile on a full page. Think of an idea for the best way to
> do it."*

From inside a loan file you can only see the file's own details. There is a whole borrower profile
(entities/LLCs, track record, all their files) that is unreachable from there. Add a direct way in — full
page. **Owner asked us to think of the best way to do it**, so this ships with a designed answer, not the
first idea.

**SHIPPED.**

**First, honestly: a button already existed, and it did not count.** The profile panel on the file has
carried an "Open full profile" button — but it sits inside *Application details*, which is collapsed by
default, and then inside that section's *People* tab. So reaching a person's profile meant opening two
things first and knowing which two. The report is exact: from where you actually stand in a file, there
was nowhere to go.

**The answer is the name.** The place you are standing when you think *"show me everything about this
person"* is the party list at the top of the file, looking at their name — so **the name is now the way
in**, on the overview, with no section to open first. It stays dark ink (a party list whose values turned
blue would read as a row of links) with a dotted underline and a small ↗ so it is obviously clickable.
Both people are linked: a file with a co-borrower must not offer only one of them. With no borrower on the
row it stays plain text — a name that looks like a link and goes nowhere is worse than a name.

**The way back is half the feature.** A full page opened from inside a file is a one-way trip: browser
Back works until you touch a tab on the profile, and then the file is gone. So every link carries the file
it came from, and the profile screen turns that into a plain **"← Back to the loan file"** bar naming the
property and the loan number. It is a **hint, never an authorization** — the screen resolves it against
that person's *own* file list, which is already scoped on the server, so a file that is not theirs (or
that the person reading cannot see) simply produces no bar rather than a link that fails. It costs no new
endpoint: it is the same list the profile's Files tab already renders.

**One definition, three doors.** `components/BorrowerProfileLink.jsx` (over the React-free
`lib/borrowerProfileUrl.js`) is the only place that knows where a profile link goes and what it carries.
The party names, the panel's own button, and the "open the other profile" link in the duplicate-Social
flow all go through it, so none of them can land differently or quietly drop the way back.

Proof: `scripts/test-borrower-profile-link-pure.mjs` — the URL rule is EXECUTED (it imports nothing, so it
runs in CI where `app-v2/node_modules` does not exist), and the wiring is read from source: both names
link, a missing id renders plain text, no surface builds its own URL, the bar is resolved against the
person's own files and renders nothing without a match, and the name stays ink. Four mutations were proven
to fail it — including one that only bit after the assertion was anchored to the start of a line, which is
why the mutations are run rather than reasoned about. The rendering was checked in headless Chromium
against the real built stylesheet at desktop and iPhone widths: dark text, a real hit area, no sideways
scroll.

---

## 16. Overview hover button missing on full screens

> *"The nice overview button on the right side that you can click and it hovers over a nice overview, that
> button is not available in the full screens that are populated, including: the terms you generated /
> products and pricing / track record full screen / scope of work for full screen. This should always be
> available."*

The right-side overview button must be present on **every** full-screen surface — the generated terms,
products and pricing, track record full screen, scope of work full screen, and any other full screen.
**Always available.**

**SHIPPED.** The button was always there — the full-screen sheets were simply painted on top of it. The
four screens named are two pieces of the system (the Scope of Work / track record sheet, and the Products &
Pricing studio that also produces the terms), and both now step aside so the button stays on top and stays
clickable.

This is the same fix that was made a few days ago so the overview stayed reachable while a PDF is open — one
layer further up. A **toast still appears above everything**, and a **question the app asks you still wins
over both**, so nothing that needs your attention can end up buried behind the overview.

**Checked in a real browser, not just in the code:** the test asks the browser what is actually on top at
that button's own position — first proving a full-screen sheet really does cover it (so the check cannot
pass by accident), then that the fix puts it back on top. And a guard now fails the build if a *new*
full-screen sheet is ever added without this, so it cannot quietly come back.

---

## 17. Scope of work Excel import — drag-and-drop

> *"Maybe we fixed this already. I don't remember. We need to make sure that the import button on the
> scope of work that imports an Excel sheet should also be drag-and-drop into that import button."*

The scope-of-work Excel import button must also accept a dragged file.

---

**ALREADY WORKING — verified, not assumed.** The Scope of Work builder has accepted a dragged Excel file for
some time: the whole page is a drop target, it shares the exact same import path as the Import button, and it
even handles a file dragged straight out of Outlook (which needs special handling most sites skip). It is
guarded by a test so it cannot quietly break.


## 18. ClickUp — Joshua Freidlander's files all land in Lead Capture

> *"Massive bug. All of the files from Joshua Freidlander is going into the lead capture folder in
> ClickUp, and it's not going into the correct officers folder in ClickUp. Please dig in. Let me know if
> you need a ClickUp connector, or you can access it through the render API that I gave you."*

Every file belonging to loan officer **Joshua Freidlander** routes to the **Lead Capture** folder instead
of **his** officer folder. Root-cause it (officer→folder mapping, name spelling, missing registry row,
routing fallback), fix it, and repair the already-misfiled tasks.

---

## 19. ClickUp — assigning an officer must move the task out of Lead Capture

> *"We also need to enhance the future so that if, let's say, some file comes in without a loan officer
> and we assign a loan officer to it, it should automatically move from the lead capture folder in ClickUp
> to the loan officers folder in ClickUp. That task should move over. Do a lot of research on how to make
> sure to do that and not mess up other stuff."*

A file that arrives with no officer correctly lands in Lead Capture. The moment an officer **is** assigned,
the ClickUp task must **move** to that officer's folder automatically. **Owner explicitly asked for a lot
of research so this doesn't break anything else** — custom fields, statuses, comments, watchers, existing
crosswalk rows and the relink logic all have to survive the move.

### ☑ SHIPPED — and the research first, because that is what the owner asked for

Everything below was **measured against the live workspace on 2026-08-21**, not assumed. Each item is a
way this could have quietly broken something.

**1. There is no v2 way to move a task.** `POST /v2/list/{id}/task/{id}` is the "Tasks in Multiple Lists"
feature — it *adds* a second home, it does not move one — and its DELETE sibling is permanently blocked
here by the no-deletion hard stop. The one endpoint that relocates a task is **v3**:
`PUT /v3/workspaces/{team}/tasks/{task}/home_list/{list}`. So the client gained a second base URL, fenced
so that **this is the only v3 call the integration can make** — any other method or path on v3 is refused
before the wire, and deleting a task is still impossible.

**2. Custom fields do not travel by themselves.** ClickUp's own docs: the move carries them only when
`move_custom_fields` is set. PILOT's entire sync lives in custom fields, so losing them would be a
data-loss event. **Measured: all 73 custom-field ids PILOT reads or writes are defined at the SPACE level**
of the Loan Pipeline space, so every list in that space already carries the definitions and nothing can be
lost. The flag is sent anyway — it costs nothing and it is what protects the day somebody makes one of
those fields list-scoped.

**3. Statuses are LIST-level here, and the sets genuinely differ.** This is the real hazard. Lead Capture's
list carries `approved`, `imported to bank (2-em)` and `paid off`, which an officer list does not; an
officer list carries the whole `delegated …` ladder and the post-closing statuses, which Lead Capture does
not. Move a card naively and ClickUp re-buckets it — and PILOT reads that status straight back inbound,
which moves the borrower's own status and, on a `(#-em)` status, makes **ClickUp** send an email.

**4. So a status is only ever mapped through the table that cannot change its meaning.** If the card's
status name exists in the destination, nothing is mapped and nothing can change. If it does not, the
mapping goes through `LANDING_INTERNAL` — the same table the portal's own status door uses, whose stated
invariants are that the borrower-facing word is preserved and that PILOT never lands on an email-firing
status except Clear to Close and Funded. If that target is **also** missing from the destination, the move
is **refused and recorded** — never guessed. A test asserts the word-preserving property over *every*
status either real list can hold, not on a couple of examples.

**5. Nothing else is lost, and that was checked rather than assumed.** The task ID does not change, so
every crosswalk row, the Portal-File-ID stamp, comments, watchers, attachments and subtasks still address
the same card. Both folders are in the SAME space, so a space-scoped webhook still delivers. And the
folder set the reconcile poll scans contains Lead Capture **and** every officer folder, so the card is
inside the polled set on both sides of the move.

**What it does.** Assigning a loan officer fires the move; a ten-minute sweep is the other half, for cards
already sitting in Lead Capture — the owner's case (assigned while ClickUp was unreachable) **and the back
book left by item 18's routing bug**, which look identical from here. The destination is the *same list a
brand-new card would be created in*. It reads the card's current home **live** and never trusts our cached
folder column (a human may have filed it by hand — trusting the cache would move their card back). After
the write it re-reads the card and checks three things: it landed, its status still means the same thing,
and the Portal-File-ID stamp survived; anything that does not check out is reported loudly, and a card that
provably landed somewhere else does **not** get our caches rewritten to claim it moved.

**What it deliberately does NOT do: reassignment.** A card already in an officer's folder is left alone
even when the file's officer is now somebody else. Pulling a live file out of the folder its owner keeps it
in is a much bigger decision than filing an unfiled one, and it is not what was asked for. Say the word and
it is a small change.

**Two real bugs found on the way, and fixed.** Two ClickUp statuses were missing from the borrower-facing
derivation map entirely and fell through its keyword fallback (which matches "approval", not "approved")
to **Processing**: a card on `approved` and a card on `paid off` both showed the borrower "Processing".
Both now read correctly (`Approved`, `Funded`). A paid-off file passed through Funded earlier in its life,
so its notification watermark already says Funded and no stale email can fire; an `approved` file will
correctly tell the borrower it is approved.

Off switch `CLICKUP_OFFICER_MOVE_DISABLED=1`; it also obeys the live outbound switch and the dry-run flag,
and counts into the same outbound volume breaker every other ClickUp write does. Tests
`scripts/test-clickup-officer-move-pure.js` (33) and `scripts/test-clickup-officer-move-db.js` (37, real
Postgres with ClickUp stubbed so nothing leaves the machine). **Six mutations of the production code were
each proven to fail them.**

---

## 20. Rehab Budget PDF — value-add details and narrative overlap

> *"On the Rehab Budget PDF, the value add details, if it's long, and the narrative of the Scope of Work
> Rehab Budget are overlapping with each other. We need to fix it over here and enhance it like crazy.
> Maybe if it's longer, the document should give it more space and should be very nice."*

Long "value add details" text collides with the scope-of-work narrative on the Rehab Budget PDF. Fix the
collision **and enhance the layout hard** — blocks that grow get more space, flow onto the next page
cleanly, and the whole thing looks very nice.

---

## 21. Funded date read automatically from Encompass

> *"Right now, you need to enter a funded date in Pilot, and Pilot does not automatically recognize from
> Encampus the funded date. We need to make sure that whenever it is set up on an automatic basis,
> whatever the setup is, no matter how long it is, we check any file that gets the funded date in Encampus
> filled, which I believe is cx.fundeddate it should automatically fill in the funded date for that file
> in Pilot and should automatically change the status for that file, but it should still not be reconciled
> because reconciled will also require making sure ClickUp matches as well."*

On whatever automatic schedule we run, check every file for a filled funded date in Encompass (owner
believes the field is **`CX.FUNDEDDATE`** — verify against the real field list) and:
- fill the funded date in PILOT automatically,
- change the file's status automatically,
- **but do NOT mark it reconciled** — reconciled additionally requires ClickUp to match.

**Encompass is READ-ONLY** (`AGENTS.md` §3) — this is a read, which is allowed. Nothing writes back.

### ☑ SHIPPED

**The field is right, and it was already being read — it was just never written anywhere.** `CX.FUNDEDDATE`
has been on the Encompass panel for months (the field map carries it, `closing.readEncompassFundedDate` digs
it back out for the closing desk's three-way reconciliation), so the closer was retyping by hand a date PILOT
was already holding. Nothing errored, which is exactly why it lasted.

**What happens now.** On every Encompass pull, and once over the whole back book, `src/lib/encompass-funded.js`
reads that date off the loan PILOT just stored and:

- **fills the funded date on the file** — *fill-only*: a date somebody typed is never replaced (the Encompass
  panel already shows both sides when they disagree, so a human can see it; silently swapping the closer's
  figure for the vendor's is how the number money moved on changes with nobody deciding);
- **moves the file to Funded** — not gated on open conditions, because Encompass carrying a funded date means
  the money moved and refusing to record a fact would be wrong. Forward only; a DECLINED or WITHDRAWN file is
  left completely alone (a funded date on a declined loan is two systems contradicting each other and belongs
  to a human);
- **never reconciles it** — the owner's own carve-out. `closing_workflow` is not written in any column: not the
  stage, not `fully_reconciled_at`, not `reconciled_ok`. A test asserts that on a file that HAS a closing
  workflow to disturb, which is the only way that assertion can bite.

**Previous AND future.** The per-file Encompass pull is a round-robin that takes ONE file every 15 minutes, so a
file's turn comes round once every (files ÷ ~96) days. Every file already synced is therefore sitting on a stored
loan JSON that already carries the date. A **one-shot** boot walk reads that stored JSON — **zero Encompass calls,
nothing new is fetched** — with a durable bookmark so it resumes across restarts and stops for good when it is
finished. It is a one-shot rather than a timer because a blob only gains a funded date on a pull, and every pull
now lands it itself. Off with `ENCOMPASS_FUNDED_BACKFILL_DISABLED=1`.

**Encompass is untouched.** Nothing here calls Encompass at all — it reads the loan JSON already on
`applications.encompass_extra` and writes only into our own columns, the same direction the purchase-advice date
and the borrower-profile enrichment already write. The read-only gate stays green.

**Two deliberate decisions, said out loud rather than buried:**

1. **The borrower is NOT emailed by this door, and that is on purpose.** The "your loan is now Funded" email is
   fired by a watermark (`status_notified_external`). Moving that watermark here would make the email silent
   *forever after* — the ClickUp echo that would have sent it reads as an already-announced status — and on the
   first run it would blast a back book of loans that funded months ago. So the watermark is left alone: the
   borrower is told at the moment the team actually processes the funding, and OUR TEAM is told immediately here,
   because nobody in PILOT made this move and somebody has to know.
2. **Nothing is pushed to ClickUp.** Landing the card on `closed (6-email funded)` sends an email *from ClickUp*,
   which is an outward-facing action nobody asked an automatic reader to take.

**A KNOWN LIMIT, stated rather than papered over — and it is a question for the owner (see the questions section).**
`status` is co-owned with ClickUp: the inbound pull writes the file's status from the card on every ingest, and the
status pair is deliberately excluded from the guard that protects portal edits. So until the file's ClickUp card
also reads a funded stage, a re-ingest of that card can move PILOT's status back off Funded. That is exactly the
"ClickUp has to match as well" half the owner separated out — but it does mean the status change may not *stick*
on a file whose card is stale, and whether PILOT should hold its ground there (or drive the card) is the owner's
call, not mine.

Tests `scripts/test-encompass-funded-pure.js` (36 checks — the decision table, fill-only, both tenant field shapes,
and source guards that this can never call Encompass, never reconcile, never move the watermark, never push to
ClickUp) and `scripts/test-encompass-funded-db.js` (40 checks against a real Postgres — the owner's case end to end,
the closing workflow proven untouched, the refusals, idempotency, stage history, the audit record, the borrower
still being told once ClickUp agrees, and the back-book walk). **Six mutations of the production code were each
proven to fail them**, with an unmutated control green either side.

---

## 22. Experience-count condition stuck at the old requirement

> *"We have a bug. We started a file and entered five experiences. The condition says that we need five
> experiences. We verified only three experiences, and we changed the application to only three
> experiences. We changed the products and prices to only three experiences, but the condition is still
> requiring five experiences, and we can't sign off that condition. That condition should live within the
> file, and if the file is updating and the product pricing is reregistered, then the condition requirement
> should be less according to the new product and pricing."*

The experience-count condition froze at 5 after the file was re-registered at 3. It must **live within the
file** and **re-derive its requirement** whenever the application / products-and-pricing are re-registered
— up or down — so it can be signed off.

**PARTLY SHIPPED, and the honest part first: I could not reproduce it from the steps as described.** Walked
exactly as written — register on five, verify three, change the application to three, re-register Products &
Pricing on three — against a real system through the real screens' own doors, the condition **does** drop to
three and can be signed off. That is now pinned as a test so it can never quietly break.

**So the requirement is already re-derived on every re-register.** What it is derived FROM is the *registered
product*, not the application — deliberately: a lowered claim only counts once the product has actually been
re-priced on it, otherwise anybody could clear the condition by typing a smaller number into the application.
That rule is right and I have not changed it.

**What was genuinely broken is that the screen never explained itself.** It printed a bare "5" with no hint
of where the 5 came from, so a file whose re-register didn't carry the lower number (a stale Products &
Pricing box, or a re-register that was refused) looked simply stuck. It now says so in words: *"this comes
from the REGISTERED product (priced on 5 flips); the file itself now claims 3, so re-register Products &
Pricing to bring the requirement down"* — and the moment they disagree, the file says so.

**What would help me finish it:** if this is still happening on that file, send me the loan number. With the
file in front of me I can tell in a minute which of the two it was — a re-register that didn't take, or one
that was refused — instead of guessing. I have deliberately not "fixed" it by making the number follow the
application, because that would let the condition be cleared without the loan ever being re-priced.

---

## 23. DocuSign — processor and officer always looped in as viewers

> *"The processor on the file should be looped in on the Docusigns as a viewer to be able to see when it's
> going out. Get a notification from Docusign when it's signed and when it's being viewed. The processor
> and the officer on the file should always be looped in as a viewer in Docusign. When you're sending out
> the term sheet package, when you're sending out the ISKA, and when you're sending out the draw form,
> then the draw coordinator and the loan officer should be looped in as viewers in the Docusign envelope."*

- **Always**: the file's **processor** and **loan officer** are added to every DocuSign envelope as
  **viewers** (carbon copy recipients), so they see it go out and get DocuSign's notifications when it is
  **viewed** and when it is **signed**.
- **Term sheet package, ISKA, and draw form** envelopes additionally loop in the **draw coordinator** and
  the **loan officer** as viewers.

**SHIPPED.** Most of this already worked and the useful part of the job was finding the two places it
didn't.

* **Already working:** the file's processor and loan officer are already copied on every envelope, and the
  draw coordinator was already on the draw form. On the term sheet the loan officer actually **signs**, which
  is a stronger seat than being copied.
* **The draw coordinator now rides the term sheet and the Heter Iska too** — that is the owner's ask, and it
  reverses a decision we made on 2026-07-28 (we had scoped the coordinator to the draw form on the reasoning
  that they have no part in an origination package; the owner has now said otherwise, so it is recorded as a
  reversal rather than quietly flipped).
* **One thing needed care:** a file has no draw project until it *funds*, so at term-sheet time there is
  never a coordinator assigned — and the draw-form rule falls back to "the whole draw desk plus the shared
  draws@ inbox" so a wire form is never uncovered. Copying that onto a term sheet would put the entire
  servicing desk on every borrower's loan documents. So the origination packages take **only a coordinator
  the file actually has**, and the wire form keeps its cover exactly as before.
* **The real bug: they were being copied at the wrong moment.** DocuSign emails a copied person when the
  signing order reaches them — and they were placed *last*, behind the counter-signer. So the processor heard
  nothing until the borrower and the officer had both already signed: they were told about the finished
  article, which is the one moment they didn't need telling. The owner's words were "to be able to see when
  it's **going out**", so they are now copied as it goes out. The "it's signed" half is not lost — PILOT's own
  alert already fires on completion and files the signed copy.

**Two live bugs found next door and fixed in the same pass** (both proven against the real system first, not
assumed):

* **The non-owner-occupied certification could never be sent, ever.** It is a real package with its own
  document, condition and screen wording — but the database had never been told the name, so the very first
  step of sending one was rejected and the screen said "server error". Measured, then fixed (db/603).
* **The safety net that stops test sends reaching real people never looked at viewers.** It checked the
  people signing and not the people copied — so on the test system DocuSign would still have emailed every
  copied staff member while the check reported the send safe. This work adds viewers, so it widened exactly
  that hole; it is closed.
* Draw-form alerts also called it a generic "e-signature package" because two hand-kept name lists had gone
  stale. There is now one list, so a package added later gets its name automatically.

**One thing deliberately NOT changed — and it is a question for the owner (see Appendix B).** On a broker
(TPO) file the *broker* is the loan officer, so today they are copied on that file's envelopes. That is
existing behaviour, not something this change introduced, and whether an outside brokerage should be a viewer
on loan documents is a business call, not ours to guess.

---

## 24. Marketing term-sheet leads — one session, contact info required, officer link

> *"Everybody that is using our marketing site and is generating a term sheet is now getting a lead. First
> of all, they're getting added to the loan officer's lead box. You need to make sure that if it's on one
> session, it only gets one lead and only gets the one loan officer, even if he's exporting several term
> sheets and he's pricing several deals. The main thing is that only if he puts in his contact
> information, either a phone number or an email, then he should become a lead. If he's just generating
> term sheets, he should not become a lead, not get into loan officers' notifications that somebody
> generated a term sheet, only if it was with contact information. If somebody is using the loan officers'
> specific link, then the loan officer should get a notification the same way he's getting now, with the
> full details of his term sheet, and should be added to his system as a lead. Only if it's coming from
> the loan officers' unique link and it should specifically say in the email, letting them know that it
> was from their link."*

Rules:
1. **One session → at most one lead**, and **one** loan officer, no matter how many term sheets are
   generated or deals priced in that session.
2. **No contact information → no lead and no notification.** A phone number **or** an email is what makes
   a visitor a lead.
3. Generating term sheets alone must **not** notify a loan officer that someone generated a term sheet.
4. **Officer's unique link** → that officer gets the notification he gets today, with the **full term
   sheet details**, and the lead is added to **his** book — and the email must **say explicitly that it
   came from his link**.

---

## 25. Trinity Manual — a full manual control section in the Draw Coordinator

> *"In the Draw Coordinator section, we need to open up a section over there, which would be called
> Trinity Manual. At any time, even though a process is not set up for autopilot on Trinity (for example,
> something that belongs to Bluelake before it's sold or something that is set up for virtual but, one
> time, he doesn't have access and he wants to order a physical), we should have a full section set up.
> All the features that are available from Trinity should be set up in that section, and that section
> should also be available when it's on auto. You should be able to do all the features from that section
> over there. You should be able to see the status of the inspection, message their team, see updates,
> inspection was scheduled, inspection happened, report came in. All the features should be available over
> there, nicely designed, communication next level, and it should be able to be manually placed on any
> file.*
>
> *Also, you need to make sure that the product that you ordered is the correct product. I want to make
> sure to get the list of products and that we're ordering the correct product, which is a thing they call
> it a I think for any 1:4, they call it an SFR drone inspection. The general price for it depends on how
> big the budget is. It's for single-family, 1:4 units. If it's more buildings, then it's more.*
>
> *Do research and also make sure that we should have all the controls on the projects that are going on
> autopilot on physicals (which is the physical inspections that we're not doing with Bluelake). Even with
> Bluelake, we should have the option to order it physically if we ever want to annually. For virtuals, we
> should have the option to order it physically manually.*
>
> *Make a whole section for it with all the controls nicely designed with stunning CSS. Do a lot of
> research and make sure to include every feature that is available, A to Z, that actually works, and
> start using it."*

**Requirements.**
- New **"Trinity Manual"** section inside the **Draw Coordinator**.
- Works **whether or not** the file is on Trinity autopilot — including files that belong to **Bluelake
  before they're sold**, and the case where a file is set to **virtual** but this one time we need a
  **physical**.
- **Manually placeable on any file.**
- **Every** Trinity feature, A to Z, that actually works: order, see inspection status, **message their
  team**, see updates — scheduled, inspection happened, report came in.
- **Correct product.** Get the real product list. For **1–4 units** it's the **SFR drone inspection**.
  Price scales with **budget size**; more buildings costs more. Verify the product catalogue against
  Trinity before we order anything.
- Full controls for **autopilot physicals** (physical inspections not done through Bluelake), the option to
  order **physical** even on Bluelake files (annual), and the option to order a **physical manually** on
  virtual files.
- **Nicely designed, stunning CSS, communication next level.** Then **start using it**.

---

## Appendix A — the owner's message, verbatim and complete

> The invested delivery of the data tape Excel sheet is not set up well:
>
> 1. We need to add the scheduling feature over there.
> 2. It's automatically filling in the FileContacts as those same as the draw. It's a different contact. The draw context is the delivery contact for tape delivery for Fidelis is MBrancatella@fidelis-investors.com and you need to give the option to CC more people, and you automatically CC the people of the file, which is the processor or the officer. And for Emcap, we need to pre-fill the contacts for the data tape and Vesta delivery to bdetommaso@emcapfinancial.com and tmartello@emcapfinancial.com and also, on the data-taped invested delivery, there is a new matrix that we don't have anywhere in our system, which is the effective LTV. He's calculating the total loan amount divided by the as-is, which is a ronc, and it's coming up as 108 LTV, 140 LTV. It's a stupid matrix, and I don't see any LTC total amount. We currently have initial LTV over there and total ARV TV. We need to add over there the total LTC and remove this other effective LTV, which calculates the total loan amount according to the initial and gets to 140 LTV.
>
> There are a lot of places where, when you refresh your screen, you're not staying in the place where you are. Certain places it's fixed, but certain places, when you refresh, you get to a totally new section.
>
> I want you to dig in and find more places. For example, on the draw center, this is a major issue. For example, when I'm at application detail, like on the Deal section where I can go to application detail and Campus Thinking, let's say when I go to Campus Thinking and I refresh, I think I'm not staying there. We need to try to stay in the most possible exact place where you were originally when you refresh.
>
> I don't know if we added this already, but on any reply to any Gmail section that we currently have, if it's The insurance order
>
> * The title order
> * The draw section
> * The general email inbox
>
> We need to be able to attach documents over there manually and also drag and drop into the box of the email.
>
> We need to dig in. Where can we upload documents when we don't have the drag-in feature? The drag-in feature is very important, and in several places the drag-in feature is still missing. We can only click on it, and it will close your file, explode it, and it doesn't have the drag-drop.
>
> ---We're looking to enhance the export button. Right now, it's only exporting verified. We need to add a button over there for "Export all of them" and also down verified ones. It should have a stamp next to it on the PDF or on the Excel, whatever you are exporting.
>
> Again, the regular export button (PDF or Excel) should only export the verified ones. There should be an extra option to export the PDF or an Excel from the unverified ones, but everything that is unverified should have a stamp that it's not verified yet, and it still needs to go through verification. -----
>
> ---Please make sure you're adding the feasibility report that is uploaded to the feasibility condition and the contractor contact information in the TPR export and in the SharePoint. In general, we need to make sure that any time plans and permits are uploaded, they should be included in the TPR and SharePoint, and it should be sent over to Sitewire as well. If there is Plans and Permits on File and Plans and Permits condition, it should be sent over to Sitewire the same way the appraisal is being sent over to Sitewire. ------
>
> The GC information condition now only has an upload document slot. Keep that slot as an optional slot, which means it should not need to upload something to sign off the condition. You need to add that condition to be informational, to put in:
>
> * the name
> * the phone number
> * the email address
> * license information
>
> You can do research if there are any other official things that we need to enter as informational stuff from our official GC. Maybe business name is optional. Don't make all the fields required. And then, in the TPR export and in the SharePoint sync, you need to take this information and lay it out on a PDF GC contractor information nicely to include in the invested delivery TPR export SharePoint. ---
>
> Make sure the Resend Draw form works if the borrower hasn't seen it for a long time or the form has expired. The Resend button actually works by the Draw section. ---
>
> render api rnd_Vbpp85PouGqZSXIL7JdjWJBZ1mEc  you can use this to troubleshoot a major bug that we have. Maybe this bug is even further than I think, but right now I'm looking at a file that has two borrowers. I imported the two credit reports for them, and it's not reading the scores correctly.
>
> Again, the final middle score that he's getting is correct because our rule is that we're using the middle score of the higher-scoring borrower, but the scores he's populating are not actually correct. Look at the two screenshots I'm giving you. The file information: try to access the actual XML and the PDF of the credit report. Try to see why he's importing the wrong scores. I have no idea what's going on with him. How stupid can a human be? Mordechai Scharf & Michelle Bleier · 598 Pawling Ave, Troy, NY 12180-5814
> YSCAP258134859 · Fix & Hold (BRRRR) · Purchase · $216,688----
>
> on the condition center, maybe we implemented it already. Right now, I only see internal notes. We should also be able to put external notes that should be visible for the borrowers and TpOS. ----
>
> In the conditions right now, you can request another doc, and it opens up another slot, like a separate slot for the invoice, separate slots for the binder. You can do that on any condition, but that is putting only a request, which is requesting it from the battle. If you have a document that you want to put in a separate slot, I don't use that request button. Next to the request button, maybe add the feature: I just open a new document slot in this condition, and it should go together with that condition in the same folder and stuff like that. -----
>
> Right now, when you're in a file, you don't have anywhere to access the borrower profile. In general, there's an entire massive profile of entities and stuff like that. You only see the details of the file. There should be a link somewhere to open up the full. In the file, you should be able to access it directly somehow and open up the borrower's profile on a full page. Think of an idea for the best way to do it. -----
>
> The nice overview button on the right side that you can click and it hovers over a nice overview, that button is not available in the full screens that are populated, including:
>
> * the terms you generated
> * products and pricing
> * track record full screen
> * scope of work for full screen
>
> This should always be available.-------
>
> Maybe we fixed this already. I don't remember. We need to make sure that the import button on the scope of work that imports an Excel sheet should also be drag-and-drop into that import button. ------
>
> Massive bug. All of the files from  Joshua Freidlander  is going into the lead capture folder in ClickUp, and it's not going into the correct officers folder in ClickUp. Please dig in. Let me know if you need a ClickUp connector, or you can access it through the render API that I gave you. ---
>
> We also need to enhance the future so that if, let's say, some file comes in without a loan officer and we assign a loan officer to it, it should automatically move from the lead capture folder in ClickUp to the loan officers folder in ClickUp. That task should move over. Do a lot of research on how to make sure to do that and not mess up other stuff. -----
>
> On the Rehab Budget PDF, the value add details, if it's long, and the narrative of the Scope of Work Rehab Budget are overlapping with each other. We need to fix it over here and enhance it like crazy. Maybe if it's longer, the document should give it more space and should be very nice. ----
>
> Right now, you need to enter a funded date in Pilot, and Pilot does not automatically recognize from Encampus the funded date. We need to make sure that whenever it is set up on an automatic basis, whatever the setup is, no matter how long it is, we check any file that gets the funded date in Encampus filled, which I believe is cx.fundeddate it should automatically fill in the funded date for that file in Pilot and should automatically change the status for that file, but it should still not be reconciled because reconciled will also require making sure ClickUp matches as well. ------
>
> We have a bug. We started a file and entered five experiences. The condition says that we need five experiences. We verified only three experiences, and we changed the application to only three experiences. We changed the products and prices to only three experiences, but the condition is still requiring five experiences, and we can't sign off that condition. That condition should live within the file, and if the file is updating and the product pricing is reregistered, then the condition requirement should be less according to the new product and pricing. ------
>
> The processor on the file should be looped in on the Docusigns as a viewer to be able to see when it's going out. Get a notification from Docusign when it's signed and when it's being viewed.
>
> The processor and the officer on the file should always be looped in as a viewer in Docusign. When you're sending out the term sheet package, when you're sending out the ISKA, and when you're sending out the draw form, then the draw coordinator and the loan officer should be looped in as viewers in the Docusign envelope. -------
>
> Everybody that is using our marketing site and is generating a term sheet is now getting a lead. First of all, they're getting added to the loan officer's lead box.
>
> You need to make sure that if it's on one session, it only gets one lead and only gets the one loan officer, even if he's exporting several term sheets and he's pricing several deals. The main thing is that only if he puts in his contact information, either a phone number or an email, then he should become a lead.
>
> If he's just generating term sheets, he should not become a lead, not get into loan officers' notifications that somebody generated a term sheet, only if it was with contact information. If somebody is using the loan officers' specific link, then the loan officer should get a notification the same way he's getting now, with the full details of his term sheet, and should be added to his system as a lead. Only if it's coming from the loan officers' unique link and it should specifically say in the email, letting them know that it was from their link. -----
>
> In the Draw Coordinator section, we need to open up a section over there, which would be called Trinity Manual.
>
> At any time, even though a process is not set up for autopilot on Trinity (for example, something that belongs to Bluelake before it's sold or something that is set up for virtual but, one time, he doesn't have access and he wants to order a physical), we should have a full section set up. All the features that are available from Trinity should be set up in that section, and that section should also be available when it's on auto.
>
> You should be able to do all the features from that section over there. You should be able to see the status of the inspection, message their team, see updates, inspection was scheduled, inspection happened, report came in. All the features should be available over there, nicely designed, communication next level, and it should be able to be manually placed on any file.
>
> Also, you need to make sure that the product that you ordered is the correct product. I want to make sure to get the list of products and that we're ordering the correct product, which is a thing they call it a  I think for any 1:4, they call it an SFR drone inspection. The general price for it depends on how big the budget is. It's for single-family, 1:4 units. If it's more buildings, then it's more.
>
> Do research and also make sure that we should have all the controls on the projects that are going on autopilot on physicals (which is the physical inspections that we're not doing with Bluelake). Even with Bluelake, we should have the option to order it physically if we ever want to annually. For virtuals, we should have the option to order it physically manually.
>
> Make a whole section for it with all the controls nicely designed with stunning CSS. Do a lot of research and make sure to include every feature that is available, A to Z, that actually works, and start using it.
>
> --Take the whole list layout, first an entire task list. Save every single word I said. You shouldn't forget anything. Make research on how it's the best way to build it on the strongest, highest level, not cheapy. Don't be afraid of wasting time. Not to everything in one batch, one shipment, high level, without mistakes. It's easy. You can take yourself several hours. If you have any questions, ask it now because I'm going to sleep.

### Screenshot 1 — the credit report page (owner-attached)

Borrower **Mordechai Scharf**, SSN 052-92-5287, DOB 01/29/2002, 1672 57th St, Brooklyn, NY 11204.
Co-borrower **Michelle Bleier**, SSN 057-92-6929, DOB 03/10/2002, 1972 52nd St, Brooklyn, NY 11204.

Credit Score Information, all calculated 08/20/2026, all developed by Fair Isaac:

- **685** — Mordechai Scharf — TransUnion — FICO Score 4 — range 309–839 — reported on **TUC-B1**
  (factors: 014 length of time accounts established · 010 proportion of balances to credit limits too high
  on bank/national revolving or other revolving accounts · 011 amount owed on revolving accounts too high ·
  005 too many accounts with balances) — **highlighted in the screenshot**
- **704** — Mordechai Scharf — Experian — FICO Score 2 — range 320–844 — **EXP-B1**
- **674** — Mordechai Scharf — Equifax — FICO Score 5 — range 334–818 — **EQX-B1**
- **719** — Michelle H. Bleier — TransUnion — FICO Score 4 — range 309–839 — **TUC-C1**
- **680** — Michelle H. Bleier — Experian — FICO Score 2 — range 320–844 — **EXP-C1**
- **732** — **Michelle Katz** — Equifax — FICO Score 5 — range 334–818 — **EQX-C1**

### Screenshot 2 — PILOT's Credit & Background panel (owner-attached)

Credit report condition · "Internal only" · "PILOT: ready to clear". PILOT's note: *"PILOT has the credit
report on file for everyone on the loan."* Cards shown:

- **719 — MORDECHAI SCHARF · MIDDLE** — *highlighted by the owner as the wrong number*
- **719 — MICHELLE BLEIER · MIDDLE**
- **719 — HIGHER — PRICES THE DEAL**

Soft pull · new order · dated Aug 20, 2026 · imported 8/20/2026, 4:50:17 PM · **ref 93123672**.

---

## Appendix B — open questions for the owner

Asked here because the owner went to sleep; each has a stated assumption so the build is not blocked.

1. **Total LTC definition (item 3).** Assuming **total loan amount ÷ (purchase price or as-is basis +
   total rehab budget)**, read from the existing pricing engine's LTC — not a second formula. Confirm.
2. **"Vesta delivery" (item 2).** Assuming Vesta is the second EMCAP delivery artifact that ships
   alongside the data tape, and both go to the same two EMCAP addresses. Confirm.
3. **"ISKA" (item 23) — ANSWERED, no longer a question.** The earlier assumption (ISAOA / an insurance
   authorization) was **wrong**. "ISKA" is the **Heter Iska** — a real, first-class DocuSign package here,
   with its own document, condition and clearing logic. ISAOA does exist in the system but only as the
   lender's mortgagee-clause wording on insurance checks; there is no ISAOA envelope at all. Item 23 was
   built against the Heter Iska.
3b. **Should a broker (TPO) be a viewer on their own file's DocuSign envelopes? (item 23)** On a broker
   file the broker IS the loan officer, so today they are copied on that file's envelopes — that is
   existing behaviour, unchanged by item 23. It is arguably right (it is their deal) and arguably wrong
   (an outside company on loan documents). Left exactly as it was, because which one it is, is a business
   call. Say the word either way and it is one line.
4. **Export button (item 7).** Assuming this is the **track record** export (verified vs unverified
   experiences). If it means a different export surface, say which and it moves.
5. **Trinity products (item 25).** The product catalogue will be read from Trinity's live API; if their
   API does not expose a catalogue we will need the price sheet from them.
6. **Funded status vs. ClickUp (item 21) — a real one, and it is a workflow call.** PILOT now moves a file
   to **Funded** the moment Encompass shows a funded date. But the file's status is co-owned with ClickUp:
   the inbound sync writes the status from the ClickUp card on every ingest, so if the card is still on an
   earlier stage, a re-ingest of that card can move PILOT back off Funded. Three ways to go, and it is your
   call — I have not guessed:
   **(a)** leave it exactly as built — PILOT records it, and it settles when somebody moves the ClickUp card
   (this is what ships today);
   **(b)** PILOT holds its ground — an inbound ClickUp status can no longer move a funded file backwards;
   **(c)** PILOT drives the ClickUp card to the funded stage itself — which is what happens when a human sets
   Funded in PILOT today, **but** that ClickUp stage (`closed (6-email funded)`) fires an email from ClickUp,
   so having an automatic reader trigger it is a decision I would not make for you.
   Related: today the **borrower is not emailed** by this door either (they are told when ClickUp catches up)
   — deliberately, so switching this on does not email a back book of loans that funded months ago. Say if
   you want the borrower told the moment Encompass shows it instead.
