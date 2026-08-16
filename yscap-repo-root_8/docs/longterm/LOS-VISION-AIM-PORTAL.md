# The vision — the portal we want to feel like

> **Recorded 2026-08-14. This is DIRECTION, not a specification.**
>
> The owner's own words when handing this over:
>
> > *"It doesn't mean that it needs to be followed exactly how it's there, but this is
> > the idea of how we want to build it. **Every single section still needs to be
> > confirmed with me**, but this should be your idea and your vision and the mindset
> > for long-term loans. This is just the portal that I love the most, and it's very
> > nice. It's very user-friendly, it feels very good, it's really amazing
> > technically."*
>
> So: **nothing below is approved to build.** It is the reference point — the standard
> of "good" we are aiming at, and the vocabulary we will use when discussing screens.
> Bring each section back to the owner before building it, one at a time.
>
> Read `LOS-BUILD-STRUCTURE.md` next: that is our own plan, and §18 there is my read of
> which parts of this we should take, which we should change, and which we already
> solved differently in the data model.

The portal walked through below is **AIM (A&D Mortgage)**. What follows is the full
walkthrough as it was handed to us, preserved verbatim so the intent is never lost in
paraphrase.

---

## 1. Global shell and navigation philosophy

The whole product is one persistent top bar (logo, five or six primary links, a
"Support" dropdown, and the logged-in user's name plus their organization printed
directly beneath it) that never changes regardless of how deep you go. Depth is
handled entirely inside the content area, never by stacking new top-level chrome. This
matters structurally: your build should have exactly one navigation shell component
that every other screen mounts into, with the loan-level UI (stepper, sidebar,
summary) as a nested "loan workspace" layout rather than a separate page template.

Three secondary tools in the nav (CRM/Loyalty, Learning Center) actually launch
separate applications in new tabs via SSO rather than being iframed in — a sign that
the vendor deliberately keeps its core LOS lightweight and offloads marketing/CRM and
documentation into their own dedicated apps instead of bloating the loan workspace.
That's a pattern worth copying: keep the loan engine focused, and treat "learning
center," "loyalty," and "CRM" as separate services behind single sign-on rather than
tabs competing for space inside the loan record.

## 2. Home dashboard

The landing screen is a personal cockpit, not a data grid. It greets the user by name,
shows their tier badge ("Pro"), shows their organization name with a secondary "Core"
badge that has an info tooltip explaining what that designation means, and puts one
single primary action ("New Loan") directly under the greeting. To the right of the
greeting are exactly three glanceable stats rendered as icon-plus-number pairs (points
balance, funded loan count, pull-through ratio) — deliberately limited to three so the
eye isn't overloaded.

Below that: a named Account Executive contact card (avatar, name, specialty tags,
phone, email) so the user always knows who their human backup is, a "Quick Links" grid
of six destinations (documents, appraisal center, guidelines, turn times, programs,
web-based 1003), and a gamified "ADvantage Level" horizontal progress track (Partner →
Expert → Pro → Master → Champion) with locked padlock icons on tiers not yet reached.

The lesson for your build: the home page's job is orientation and one clear next
action, not a dashboard of forty KPIs.

## 3. Pipeline — active, inactive, and every loan status in between

The pipeline is a single flat table, not a kanban or nested folder tree. Above the
table are two independent control rows that must be built as separate, composable
filters: a status chip row (Active, All, Started, Approved, Completed) and a scope chip
row (All Loans, My Loans, Recent Loans), plus a free-text search box on the same line.

I confirmed these are true independent filters — for example combining "All" status
with "All Loans" scope surfaces every lifecycle state at once: Completed/Cleared,
Denied/Open-with-a-count, Funded/Cleared, Deleted/Pending, and Started/Pending all
appear side by side in the same table with no visual segregation beyond the Loan Status
and Conditions columns.

That's an important structural decision: inactive loans (Denied, Deleted, Cancelled)
are not hidden or archived into a separate area — they stay in the same list,
distinguished only by a status-column label. Your system should resist the urge to
build separate "archive" screens; keep one loans table with a rich, filterable status
field, because that's what let this pipeline stay simple while still being exhaustive.

The Conditions column in this table is doing real work on its own: it shows either
"Pending" (nothing submitted yet), "Open" with a red badge count of unresolved
conditions, or "Cleared" with a small document icon — meaning a user can triage
condition urgency from the list view without opening a single loan.

## 4. The loan record shell — stepper, sidebar, and the persistent Summary panel

Every loan record uses the same three-region layout, and this is the single most
important structural pattern to copy.

**Region one** is a horizontal milestone stepper pinned above the content (Submitted →
Approved → Locked → CTC → PC Review → Funded), where each node is a circle that's
either a green check with a completion date beneath it, or a grey X for a milestone not
yet reached. On a Denied loan, only "Submitted" is checked and everything past it is
X'd, immediately communicating "this stopped early" without a single word of text.

**Region two** is a left vertical menu of sections, and each item in that menu carries
its own micro-status indicator — a filled check, a half-filled progress ring, an empty
circle, or a fully greyed-out disabled state with a hover tooltip explaining why (I
directly triggered the tooltip "'Conditions' screen will be available once loan is
Submitted" and, inside the 1003, "Employment and Income information is not required for
DSCR loans").

**Region three** is the right-hand Summary panel, and critically it does not change or
disappear as you navigate between sections — it's a fixed-position, independently
scrollable rail that stays on Loan Information, 1003, Conditions, Contacts, everywhere.
I scrolled it fully and it contains, in this order: Seller Loan ID, Borrower Name,
Business Channel, Loan Purpose, Refi Purpose, Occupancy Type, Loan Amount, Appraised
Value, Sales Price (purchase only), LTV/CLTV, DSCR, Credit Score, Interest Rate, Final
Price, PI Payment, ITIA, Pricing Status, Waive Escrow, Prepayment, Prepayment Amount,
Address, City/County, State/ZIP, Property Type, Program, Doc Type, Product Status, Lock
Status, and Lock Expiration.

That's roughly twenty-five fields, and the reason it works is that it's the exact set of
numbers a loan officer or processor needs to answer "where does this loan stand
financially" without clicking anything — it's a permanently visible answer to the
most-asked question. Build this as a dedicated, independently-scrollable component fed
by a single loan-summary API/selector, mounted once at the loan-workspace layout level,
not re-fetched or re-rendered per section.

The sidebar itself is longer for loans further along in their life cycle — a brand-new
loan shows roughly eleven sections (Loan Information, 1003, Products and Pricing, Rate
Lock, AUS/Credit Reissue, Loan Documents, Conditions, Contacts, Loan Dates, Actions,
Exception), while a funded loan gains additional post-approval sections (Initial CD
Progress, Fees, Mortgage Insurance, Points and Fees, Disclosure Documents, Disclosures
Tracking). This tells you the sidebar should be dynamically generated from the loan's
current stage and loan type (DSCR loans skip Employment and Income entirely) rather
than hard-coded — treat it as a rules-driven menu, not a static list.

## 5. Loan Information and Products and Pricing (field inventory)

Loan Information is organized into two visually separated card groups on one scrollable
page rather than a wizard.

**Card one, "Loan Information,"** holds Lender Loan Number, MIN, Purpose of Loan,
Purpose of Refinance, Document Type, Term (months), Appraised Value, Loan Amount,
Financed Fees, Total Loan Amount, and (pre-submission) an Estimated Closing Date.

**Card two, "Subject Property Information,"** holds Address Line, Number of Units, Year
Built, Unit Type, Unit No., City, State, ZIP, County, Renovation, Property Type, Type
(attached/detached), a "Property will be" occupancy field, a Transferred Appraisal
yes/no, a checkbox for mixed-use commercial space, and — only for investment/DSCR loans
— a Subject Property Gross Rent field. A "Select Property" button sits at the card
header, implying an address-lookup/autofill service rather than pure manual entry.

Products and Pricing is a near-duplicate of some of these same fields (Address, ZIP,
County, City, State, Occupancy, Property Type, Loan Purpose, Appraised Value, Base Loan
Amount) presented again as a fresh pricing-search form. **That duplication is a real
weakness in their design, not a strength** — worth calling out explicitly: build your
system so these fields are entered once and referenced everywhere (a single Property
and single Loan Terms entity), with Products and Pricing reading from that shared
entity and only asking for the incremental fields a rate search actually needs, rather
than re-asking for the address and loan amount a second time.

## 6. The 1003 loan application (full sub-section breakdown)

The 1003 is its own collapsible sub-menu nested under one sidebar item, with nine
children: Personal Information, Employment and Income, Assets, Liabilities, Real Estate
Owned, Housing Expenses, Details of Transaction, Declarations, and Government
Monitoring.

**Personal Information** opens with a "Borrower type" dropdown (e.g., "BOR. 1 Moshe
Friedman") plus a delete icon and two buttons, "Add Co-borrower" and "Add Borrower" — so
multi-borrower loans are handled by adding discrete borrower records selectable from one
dropdown, not by cramming multiple people into one long form. Fields captured:
First/Middle/Last/Suffix name, SSN, Date of Birth, Citizenship, three phone fields
(Cell/Home/Work), Email, Marital Status, Dependents count, Dependents' ages
(comma-separated), Veteran status, a "mailing same as current address" checkbox, and a
full Current Address block.

**Assets** uses a list-and-detail pattern: a left-hand list of asset categories (Stocks
and Bonds, Business Owned in the example I opened) with the selected category's fields
on the right (Asset Belongs To, Financial Institution, Account Number, Balance), a
running "Total Assets Balance" computed at the bottom, and explicit Discard/Save buttons
rather than autosave.

**Real Estate Owned** uses the identical list-and-detail pattern but the left list is
every property the borrower owns (I saw upward of ten addresses on one funded loan),
each with Occupancy Type, Property Status, Property Type, Primary Residence and Subject
Property checkboxes, full address fields, Property Belongs To, and Market Value.

This list-and-detail component is reusable — build it once and use it for Assets,
Liabilities, and Real Estate Owned alike, since all three are "multiple repeating
records with a running total" problems.

## 7. Rate Lock

One page: a "Price Details" button, the selected product name with a green "Valid" or
red "Expired" pill next to it, a "Lock Status" label, then six fields (Commitment, Final
Rate %, Final Price, Lock Date, Lock Expiration, Lock Days Left — which goes negative
once expired, shown in red — and Prepayment type plus Prepayment Amount), followed by
four action buttons: Lock Loan, Lock Extension, Request Relock, and Lock History.

Every one of those buttons is disabled/greyed unless the loan is in the right state to
use it, which reinforces the pattern from the Actions page: show the full menu of what's
possible on this loan type, but only light up what's actually actionable right now.

## 8. Loan Documents

A "Download All" button sits above a drag-and-drop upload zone with an explicit
constraint line ("PDF and image files only, 150MB limit") and a checkbox that lets a
user upload one combined PDF which the system will auto-split into individual documents
— a genuinely clever convenience feature worth adopting.

Below that is a document table: Type, Category, Date Created (sortable, descending by
default), File Name, and an editable Comment field with an inline pencil icon. On a
long-running funded loan, the table auto-accumulates recurring monthly statement uploads
with a predictable auto-generated filename pattern
(`MonthlyStatement_{loanId}_{MM-DD-YYYY}.pdf`), which tells you documents aren't just
user-uploaded blobs — the system programmatically names and files recurring document
types into the same category automatically.

## 9. The Conditions Center — the centerpiece, examined in every state

This is the section you specifically asked me to dig into, and I looked at it on four
different loans in four different states: a brand-new pending-conditions purchase loan
with exactly one open item, a fully funded and completed loan with everything satisfied,
a denied loan, and a completed loan with a clean empty state.

Structurally, Conditions is one page with two top-level tabs, "Partner Conditions" and
"Lender Conditions" (on every loan I checked, Lender Conditions was empty — that tab
exists for a different counterparty workflow than the one my test user represents).
Directly under the tabs sits a timestamp bar showing "Last Submitted" and "Last
Reviewed" with exact date/times, so both sides of a conditions exchange (broker submits,
lender reviews) are timestamped and visible at once.

Below that, conditions are grouped into collapsible accordion sections that map to loan
stages — Submission, Underwriting, Closing, Post Closing — and only the sections that
actually contain data are expanded by default; a section with an outstanding item shows
a small red numeric badge next to its header even while collapsed, which is what makes
it possible to land on the page and instantly know "Post Closing has 1 thing I still owe
them" without expanding anything.

Inside each expanded stage section is a three-way filter chip row — All, Approved,
Unapproved — and I found the default selected filter is always "Unapproved," meaning the
system is opinionated about showing you your outstanding work first rather than a
neutral "everything" view; you have to deliberately click "All" to see what's already
been cleared.

The table itself has six columns: ID (a numeric condition code, e.g., 12001, with a
small copy-to-clipboard icon), Category, Condition (the full free-text requirement,
which can be long — e.g., "Photo ID is required for all borrowers. For a Foreign
National, a copy of the passport and valid Visa are required"), Type (a short controlled-
vocabulary tag like "Prior to Approval" or "Post Closing"), Status (color-coded text — I
saw "Satisfied" rendered in amber/gold and "New" rendered the same amber, so status
color here signals "needs attention" rather than strictly good/bad), and either an
Approved Date or a Comments column depending on context.

Critically, clicking anywhere on a condition row opens a modal titled "Condition
details" showing the condition ID as a pill, the full condition text restated in full
(no truncation), a labeled "Upload Your Documents" drag-and-drop zone identical in style
to the main Loan Documents uploader, a table of any files already attached to that
specific condition (File Name, Type, Date Created, Comment), and a Save button.

**This is the single most important interaction pattern in the whole product:**
conditions are not just a checklist, they are each an individual micro-upload target, so
a user resolving twenty seven open conditions works condition-by-condition, attaching
exactly the right document to exactly the right requirement, rather than dumping
everything into one undifferentiated folder and hoping underwriting matches it up.

Above the whole conditions list sits a persistent amber banner reminder — "Remember to
click 'Submit Conditions' after uploading your documents. This step is required to send
your documents for review" — and a primary button (labeled "Submit Post Closing
Conditions" or similar depending on stage) that is greyed out until there's something
new to submit. On a fully cleared, completed loan, that reminder banner disappears
entirely and the default "Unapproved" filter simply renders "No results found" — a
clean, quiet empty state rather than an empty table with visible column headers and dead
space.

For your build, the data model this implies is: a Loan has many Conditions; each
Condition has a stage, category, type, free-text body, a status enum, an approved date,
a comment thread, and its own file attachments (a one-to-many join table between
conditions and documents, not a shared flat document pool); and there is a separate
"submission event" log (Last Submitted / Last Reviewed) that is distinct from the
condition's own status, because a condition can be uploaded-but-not-yet-submitted,
submitted-but-not-yet-reviewed, or reviewed-and-satisfied.

## 10. Contacts

Two tabs, "AD Contacts" and "My Contacts." AD Contacts groups people by function rather
than a flat directory: a top row of two prominent cards (Account Executive, Account
Executive Manager) with avatar photo, role label above the name, colored tag pills
describing what each person handles (Pipeline, Scenarios, Trainings / Escalations),
phone, and email; then flat single-line entries for shared department lines (Partner
Support, Lock Desk) showing phone-with-extension and a truncated email; then full team
rosters for Disclosure Team and Underwriting Team as small tables (Role, Name, Phone,
Email) — the underwriting team alone had four named individuals with distinct titles
(Underwriter 1, Senior Underwriter, Collateral Underwriter, Underwriting Manager).

The organizing principle is "who do I call for what," not an alphabetical directory —
replicate that by tagging every contact with the functional role it serves on this
specific loan.

## 11. Loan Dates

A List/Calendar toggle over the same underlying date data. List view splits into two
side-by-side columns, "Key Dates" (Submission, Loan Approval, Appraisal Effective,
Redisclosure, 3-Day CD Signing, 3-Day CD Request, CTC, Submitted to Initial UW) and
"Document Expiration Dates" (Insurance Effective, Appraisal/Assets/Credit/Income/VVOE/
Title/CPL Expiration), with a plain em-dash for any date that doesn't apply yet rather
than a blank cell. Calendar view renders a standard month grid with the current day
highlighted in red and any date carrying an event shown with a small badge.

This is a good example of "one dataset, two lenses" — don't build two separate features,
build one date-events model and two renderers.

## 12. Actions

A card grid, each card an icon plus bold title plus one-line description: Submit Loan,
Delete Loan, Lock Rate, Lock Extension, Exception, Change Request, Schedule Closing,
Concierge Service, Order an Appraisal, Print 1003, Print 1008, Print Approval Letter,
Export Loan.

Unavailable actions are rendered greyed-out in place rather than hidden, so the user
always sees the full universe of what this loan could eventually need, which sets
expectations about the process ahead even before they're able to click it.

## 13. Exception and My Requests (the cross-loan layer)

Exception, inside a single loan, is nearly empty by design — just a "New Exception"
button and, once something exists, a list. The real payoff is at the organization level:
"My Requests" in the top nav aggregates every change request and exception across every
loan into one screen, with tabs (All / Change Requests / Exceptions), a secondary status
filter (All / Pending / Approved / Rejected-Withdrawn), and a table (Loan ID, Request
type, Request, Status, Date created, Requestor) where each row expands in place to
reveal the requestor's name and their free-text justification without navigating away.

I saw real statuses in the wild here: "Approved," "Pending," and "Approved With
Conditions" — that third one is worth noting as its own state, distinct from a plain
approval, because it implies the requester got a conditional yes that still needs
something resolved.

## 14. Adjacent tools worth knowing about, even if out of scope for your MVP

**Quick Pricer Pro** is a scenario calculator with tabs for loan category (Non-QM First
Lien, Non-QM Second Lien, Jumbo, Conventional, Government), up to three savable scenario
slots in a left rail, a Property Information and Loan Information form, and a live
"Programs" results panel of selectable rate options with a "Report an Issue" escape
hatch.

**Concierge Service** is a request-tracking queue specifically for income-documentation
calculations (bank statements, tax returns), with color-coded status pills (teal
"Complete," amber "Insufficient Docs," red "Withdrawn"), a results column, a "Create a
Loan" action once a calculation completes, and a contextual help card plus a
support-email card in the left rail.

**CRM/Loyalty and Learning Center** are entirely separate applications reached via SSO —
the CRM ("LEADEr, powered by A&D") is a lead/task/marketing dashboard with a genuinely
well-built gamification layer (a tier progress stepper, two progress-ring stats for
points earned and actions completed, and an "Earn/Redeem Points" carousel), and the
Learning Center is a searchable knowledge base with quick-navigation cards, a
trending-news feed, a deeply nested collapsible sidebar taxonomy, and a floating
AI-assistant chat bubble. Neither of these needs to be built into your v1 LOS, but both
demonstrate that this vendor deliberately keeps "engagement and education" features out
of the transactional loan workspace.

## 15. Why this feels so good — the underlying principles, stated plainly

Nothing about this product's warmth comes from decoration. It comes from five
disciplined habits repeated everywhere:

1. **Always show where you are** (the milestone stepper, the sidebar status dots).
2. **Always show what matters most without a click** (the persistent Summary panel).
3. **Always show the full menu of what's possible, not just what's currently clickable**
   (greyed-but-visible Actions and sidebar items).
4. **Always explain unavailability instead of leaving a dead end** (the contextual
   tooltips).
5. **Always default to showing outstanding work before showing everything** (the
   Unapproved-first condition filter, the red badge counts).

None of that requires a single design system decision about color or type — it's
information architecture discipline, which is exactly what you can and should replicate
regardless of your own visual branding.

## 16. Concrete build recommendations for your ground-up system

Model your data around a Loan aggregate with strongly typed, stage-aware sub-entities
(Application/1003, Conditions, Documents, Dates, Contacts) rather than one giant flat
loan record — the fact that AIM can show or hide entire sidebar sections based on loan
type (DSCR skips Employment/Income) and loan stage (Conditions locked until Submitted)
tells you the sidebar and section-availability logic needs to be a rules engine reading
off the loan's type and current milestone, not hardcoded per page.

Build the Summary panel as a single reusable component fed by one loan-summary selector
and mount it once at the workspace layout level so it truly persists across every
section instead of being re-implemented per page.

Build Conditions as first-class records with their own attachments, status, stage, and a
separate submission-event log, and build the per-condition upload modal as a generic
"attach documents to any entity" component you can reuse for conditions today and other
attachable entities later.

Build one generic "list with left-hand item picker and right-hand detail-with-running-
total" component and reuse it for Assets, Liabilities, and Real Estate Owned instead of
three bespoke forms.

Eliminate the field-duplication problem AIM has between Loan Information and Products
and Pricing by making Property and Loan Terms shared entities referenced everywhere
rather than re-entered per feature.

And bake "show it, but grey it out and explain why" into your base component library
from day one — a disabled button or disabled sidebar item should be a first-class
variant with a required tooltip prop, not an afterthought.

## 17. What the walkthrough could not cover

The walkthrough was done in a browser with no access to our Encompass instance, our
field research, or this repository. So it could not compare AIM's fields against ours,
and it could not write anything into the branch.

**Both of those gaps are now closed on our side:** the field comparison is possible
because the full 3,783-field census is committed here (see `README.md`), and this
document is the walkthrough saved into the branch.

---

## How this connects to what we have already built

| The walkthrough says | Where we stand |
|---|---|
| Sidebar must be **rules-driven**, DSCR skips Employment | Already in the model — `lt_loans.employment_applies` defaults **false**, measured at 98% of the live book |
| Multi-borrower via **discrete borrower records**, not one long form | Already in the model — `lt_borrower_pairs` is a list, tenant configured for six |
| **List-and-detail with a running total**, reused for Assets / Liabilities / REO | Already three separate tables with the same shape — `lt_assets`, `lt_liabilities`, `lt_reo_properties` |
| Conditions are **first-class records with their own attachments** | Designed in `LOS-BUILD-STRUCTURE.md` §7; not built (owner asked for structure first) |
| A separate **submission-event log** distinct from condition status | Same — and it matches what Encompass itself exposes (`Last Submitted` / `Last Reviewed`) |
| **Do not duplicate fields** between Loan Information and Products and Pricing | Already avoided — Property and Loan Terms are single entities (`lt_properties`, `lt_loans`) |
| The persistent **Summary panel** of ~25 numbers | Every field it lists exists in our model or in the Encompass census. See §18 of `LOS-BUILD-STRUCTURE.md` for the one that must **never** appear there |

**The one thing in that Summary panel we will not copy:** AIM shows the loan's
counterparty context freely because their user *is* the broker talking to *them*. Ours
is not the same shape — see the **investor-name rule** in
`docs/longterm/AUDIENCE-RULES.md`. It is a hard rule and it outranks any layout in this
document.
