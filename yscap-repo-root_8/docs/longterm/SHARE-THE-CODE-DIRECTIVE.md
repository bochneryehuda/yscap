# SHARE THE CODE — the owner's architecture directive for the Long-Term build
## (owner-directed 2026-08-30, twice, in their own words — this supersedes the parallel-build shape)

The first Long-Term shipment (PR #1376) BUILT PARALLEL COPIES of the Condition
Center, the Orders desk, the VOR and the document machinery inside
`src/longterm/**`. The owner rejected that wholesale:

> *"Delete everything that you built already in this session. Delete everything and
> start from scratch by actually sharing the code."*
>
> *"The point is not to reinvent the wheel over here. The point is to take everything
> that already exists that we already have and bring it over from the short-term side:
> the Condition Center, the Condition Logic, the way the Formset works, the way the
> document upload works, the same look of the Condition Center."*
>
> *"I gave you written authorization to bring that exact Condition Center over here.
> Take that exact Condition Center and make your conditions in that Condition Center
> follow those rules."*
>
> *"If I'm updating something in the logic of the Condition Center (the way you
> preview stuff, the way you preview the PDFs, the way you drag and drop, accept,
> reject, preview, download, and delete), it should update them both places. You need
> to share the code. The same thing with Order Center: you need to share the code.
> Same thing is with SharePoint: you need to share the code."*
>
> *"Every single thing that you're building, you first need to look if you can share
> the code somewhere else without rebuilding everything."*

## What this authorizes (the sharing set — each lands in the crossing ledger with its PR)

ONE implementation, used by both products, where an update lands on both:

1. **The Condition Center** — the conditions UI (list, white boxes, statuses), the
   document machinery (drag-and-drop upload, PDF preview with in-preview search,
   accept / reject / download / delete / supersede), slots, sign-off/waive logic.
2. **The Orders center** — the Gmail-style order box, draft-first composing, AI
   drafting, the reply-to routing, follow-ups, CC settings (borrower / helper), the
   send-as-user + deliverability posture, the DocuSign design and workflow.
3. **File contacts + the vendor directory** — *"should not copy. It should be the
   same, should be the exact same vendor setup and use the same information"*
   (`service_contacts` and the FileContacts logic).
4. **The entity/LLC logic** — *"Bring over the entire entity logic that we have all
   over… You should basically share the logic. Don't copy it."* Linked to the shared
   borrower profile; verified once, verified forever, both products.
5. **SharePoint syncing** — same integration, same folder logic, same code.
6. **The Cloudflare / off-site backup** — LT documents in the same backup.
7. **Profile-linked conditions** — photo ID from the shared profile; the
   credit-card-for-appraisal card BIDIRECTIONAL with the shared profile; the
   REO/mortgage answers saved to the shared profile.
8. **The address lookup** (the existing autocomplete) inside LT conditions.

## What deliberately STAYS SPLIT (the owner's own boundary, same message)

> *"Everything else should stay split as the original rule. Only after written
> confirmation, you can share different logics."*

- The two products' DATA: LT loans stay `lt_loans` + `lt_*`; a borrower/officer/LLC/
  vendor is the SHARED identity zone exactly as before. Sharing CODE is not sharing
  ROWS — *"You need to make sure you're not copying the information. You're just
  using the information from the short-term side."*
- The LT LOOK: *"this is not a redesign because I like the design that we have on the
  long-term side… Don't change the design. Stick with the design and with the
  fonts."* Keep: the header strip (loan number, subject, purpose, program, loan
  amount, LTV, DSCR, vesting), the big status stamp, the fonts. Bring over the FEEL:
  white boxes on the pipeline rows, every file section in its own white box, a File
  overview BUTTON instead of the always-on right rail. *"It shouldn't feel like two
  different systems."*
- The WORDING: LT condition language and order drafts are LT's own (the owner's
  drafts, verbatim — `docs/longterm/OWNER-ORDER-DRAFTS.md`).
- *"While you're sharing it, watch what you're doing not to break the other side of
  the business, the short-term side."* Every sharing change is proven byte-identical
  on the RTL side before it ships.

## Standing clarifications recovered from the whole conversation (each is owner-stated)

1. **NAN appraisal ordering is OFF the task list** — *"Skip the appraisal ordering.
   We're not going to do the appraisal ordering. We're removing the appraisal order
   NAN from the task list."* (The later re-paste of the original directive does not
   revive it; say so in the final write-up so one word from the owner reverses it.)
2. **REO/mortgages condition** — each mortgage line is satisfied by ONE of the three
   ways (upload a statement / link to his primary / type the address), "one out of
   three".
3. **Vesting entity condition** — same exact RTL logic, PRE-FILLED with the documents
   already on the profile and already-verified state; plus the OPTIONAL certificate
   of good standing slot.
4. **Subject property mortgage condition** — a FORM, not an upload-first design:
   outstanding balance + servicer + loan number (all three required), OR the
   RTL-originated/FCI-serviced tick ("you don't need anything"), OR the statement.
5. **Cash-out letter** — prior to CLEAR TO CLOSE, not prior to submittal.
6. **VOR** — the owner's EXACT blank form (`src/longterm/assets/blank-vor.pdf`,
   flat PDF, overlay prefill only); part two (completed by landlord) LEFT EMPTY with
   required DocuSign slots; dual send (DocuSign / manual email / both); a manually
   returned + accepted form VOIDS the envelope.
7. **FR0115** is the Encompass field for rents vs owns (primary residence);
   `cx.propertytype` / `urla.x205` for condo.
8. **The Render API key pasted in chat is COMPROMISED** — must be rotated by the
   owner before any use; never committed, never stored.

## Where the parked reinvention lives

The 2026-08-30 session's uncommitted audit fixes and the reinvented upload door are
parked (patch + file copies) outside the tree; the reinvented modules on main
(`src/longterm/conditions-center`, `src/longterm/orders`, `src/longterm/vor`, their
routes and screens) are deleted as each shared surface replaces them. What is NOT a
reinvention stays: reporting, the pipeline, the LtLoan header + stamp, the Encompass
condition mirror (`/api/lt/conditions`, db/612), book sync, ClickUp, the term sheet.
