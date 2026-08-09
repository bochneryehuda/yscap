# Where DocLab's data is shaped differently from ours — and what we should change on our side

**Owner-directed, 2026-08-09:** *"Keep in mind to come back with feedback if their data is
structured differently than our data… maybe we're going to take our software and enhance it so it
should match DocLab even better."*

This is that feedback. It is written in plain language on purpose — it is a list of decisions for
the owner, not a task list for a developer. Nothing in it has been built.

Every item below was found by comparing DocLab's published field list against the columns PILOT
actually has. Where I say "we don't store it", I checked.

---

## First, the good news: our name split is already right

The owner's own example was names — a full-name box on our side against first / middle / last on
theirs. **It is the other way round, and we are the better one.**

PILOT stores a person as **first name, middle name, last name and suffix**, with the full name built
from those four by the database itself (the 2026-07-27 name-split work). DocLab has no split at all
— its `borrower_name`, `guarantor_name`, `signatory_name` and `pledgor` are each a single line of
text. So we hand them our assembled full name and nothing is lost.

That is worth saying out loud for two reasons. It shows the instinct behind the question is the
right one. And it means the fix for a shape mismatch is not always "add fields" — sometimes we are
already ahead, and the work is just to make sure the good structure actually reaches them.

---

## The ten real gaps, worst first

### 1. ~~We call every company an "LLC"~~ — **BUILT 2026-08-09**

**This was the biggest one by a distance. It is now closed** (owner-directed 2026-08-09; db/506,
db/507, `src/lib/entity-type.js`). The write-up below is kept because it explains *why* the change
was worth making — and what still has to happen on each file.

**What now happens.** Every company record carries an entity type — **LLC, corporation, partnership
or trust** — and every door that creates one asks for it: the marketing loan application, the
borrower's own application, the staff new-file form, the entity screens on both portals, and the
public intake. `src/lib/entity-type.js` is the one definition; it turns that single answer into all
six DocLab fields, into which documents we ask the borrower for, and into which titles their owners
may hold.

**Everything created before that day is an LLC — and says it was assumed.** The owner's rule was
"everything created till now should automatically be default LLC, only going forward this change to
go in effect", so the whole back book is stamped `llc` — *and* stamped **not confirmed**, because
"we assumed" and "a person chose" are different facts and only one of them is safe to print on a
mortgage. Nothing behaves differently on an unconfirmed entity; it just lets the closing desk, and
the DocLab payload, say they are assuming instead of stating a guess as a fact.

**Still to do on each file:** somebody has to actually confirm the type on the entities already on
the books, and fill in each owner's title. Both are nudged at the closing desk rather than blocked —
they are ten-second fixes that must not stop a closing.

*The original write-up follows.*

Our table for a borrowing company is literally called `llcs`, and it has no field for *what kind of
company it is*. Every company on every file is treated as an LLC.

But a **limited liability company** has an *operating agreement* and *members* who own a
*percentage*. A **corporation** has *bylaws* and *shareholders* who own a *number of shares*
evidenced by a *stock certificate*. A **trust** and a **partnership** are different again.

DocLab asks us which one it is, and then five more fields hang off the answer:

| DocLab asks for | For an LLC | For a corporation |
|---|---|---|
| `type_of_organization` | "limited liability company" | "corporation" |
| `acknowledgement_corporate_status` | "operating agreement and its members" | "bylaws and its shareholders" |
| `bylaws_operating_agreement` | "operating agreement" | "bylaws" |
| `membership_interest_percentage` | 100 | — |
| `number_of_shares` | — | 1,000 |
| `certificate_number` | — | the certificate being pledged |

Get this wrong and the loan documents describe the wrong kind of company, in the resolution, in the
pledge and in the notary block.

**What I suggest:** add an entity-type field to the company record, with a short fixed list (LLC /
corporation / partnership / trust / sole proprietorship). Ask for it once, on the screen where the
company is added. Everything above then fills itself in.

There is a bonus: our entity-document conditions currently ask everyone for an "operating
agreement". A corporation does not have one, so today we are asking some borrowers for a document
that does not exist. This fixes that too.

### 2. ~~Nobody's *title* is recorded~~ — **BUILT 2026-08-09**

Also closed in the same pass. Every owner of an entity — on both owner tables, because PILOT splits
them into "owners who are our borrowers" and "everybody else" and a loan document does not care
about that distinction — now carries a **title**, chosen from a fixed list per entity type
(`Managing Member`, `President`, `Trustee`, …, always with `Authorized Signatory` as the catch-all).

It is a **drop-down, never a text box**, on purpose: the value prints under a signature line and
DocLab merges it verbatim, so "managing member", "Managing Member" and "MGR" must not all be
reachable. It is **staff-only** (the owner's call), and the **closing desk is told by name** which
owners still have none — a nudge, never a blocker.

A corporation additionally carries each owner's **share count** and **stock certificate number**;
see the note under gap 1 for what a certificate number is.

*The original write-up follows.*

We know who the members of a company are and what percentage they own. We do not record that
somebody is the **Managing Member**, the **President** or the **Manager**.

DocLab wants a title for the borrower (`borrower_title`) and for each person who signs
(`signatory_title`) — and that title is printed under the signature line on every document.

We also do not record **who is authorised to sign**. Right now we would have to assume it is
everyone, or guess.

**What I suggest:** two small additions to each member — a title, and a "can sign for the company"
tick. Both are things the officer already knows when they set the company up.

### 3. The county is on the appraisal, but not on the file

Every RTL loan document DocLab drafts asks for `collateral_property_county`. Property is recorded at
the **county** office, so this is not optional.

We do have the county — the appraisal reads it and we store it on the appraisal record. But the
property address on the loan file has an empty county slot, and that is the address everything else
reads.

**What I suggest:** copy the county from the appraisal onto the file address when the appraisal is
imported. This is the easiest win on the whole list — the data is already in the building.

### 4. The legal description is inside a PDF, not in a field

The **legal description** — the metes-and-bounds paragraph that legally identifies the land — goes
on the mortgage and the deed. It is on the title commitment, which we hold as a document, but we
have never pulled the text out of it.

DocLab will also accept a link to a Word file containing it, which may be the practical answer for a
description that runs half a page.

**What I suggest:** decide between (a) reading it off the title commitment automatically, the way we
already read appraisals, or (b) a paste box on the closing screen. (b) is a day of work; (a) is
better and slower. This one genuinely blocks documents, so it needs an answer.

### 5. New York needs four numbers we don't hold

A **NY Building Loan** and a **CEMA** need the tax-map **section, block, lot and district**. We store
none of the four. They are on the title commitment.

Worth noting because New York is one of the products the owner specifically named.

### 6. The *title underwriter* is a different company from the title agent

We store the title company as a file contact. DocLab separately wants the **title underwriter** —
the insurance company standing behind the policy (Fidelity National, First American, Old Republic).
The agent issues; the underwriter insures. They are not the same and a document names the
underwriter.

**Careful:** we have a staff role called "underwriter". Wiring that in would print the name of the
person who approved the credit onto a title clause. The code has a warning about this in it.

### 7. Deed-of-trust states need a *trustee*, and we have nowhere to put one

About half the country uses a **deed of trust** instead of a mortgage, and a deed of trust needs a
third party — the **trustee** — named in it. Usually the title company, but several states require a
local trustee instead.

We have no field for it. Since the loan documents cannot be drafted in those states without one,
this is a real blocker for anything outside mortgage states.

### 8. We store one property per loan; they allow several

DocLab's payload takes a **list** of collateral properties and a **list** of borrowers. A PILOT loan
file is one property and one borrowing entity.

That is fine for today's business and I would not change it now. But it is worth knowing that
**cross-collateralised deals and portfolio loans are already possible on their side** — so if the
owner ever wants to lend on five properties at once, the document side is ready and our side is the
part that would need work. Flagging it as a future decision, not a gap to fix today.

### 9. Our fees don't say what *kind* of fee they are

We keep extra closing fees as a name and an amount. DocLab distinguishes fees that have their **own
paragraph of legal language** (Legal Fee, Interest Reserve, Origination Fee, Prepaid Interest, the
three draw fees, Exit Fee, Appraisal Holdback) from **generic named fees**, which repeat one standard
sentence.

So "Interest Reserve" typed as a free-text fee name would come out as a generic sentence instead of
the proper interest-reserve clause — which is a real paragraph of the loan agreement.

**What I suggest:** let the person adding a fee pick from a short list where one applies, and leave
free text for the rest. The list of nine is already in the code.

### 10. Standing loan terms live in people's heads, not on the file

Six things DocLab prints on the documents are not on the file anywhere:

- the **default interest rate** and the **maximum default rate** the state allows
- **which state's law governs** the loan
- the **last day the borrower may draw** from the holdback
- the **maximum LTV** the borrower must pay down to (a covenant, not our calculated LTV)
- the **servicer's name and address**, printed on the note

Most are the same on every loan, so they belong in settings rather than on each file. The last day
to draw is per-file — the usual convention is two months before maturity, but that is a convention
and somebody has to say whether it is *our* rule.

---

## What I would do, in order

**Do now (small, and they unblock the most):**
1. ~~Entity type on the company record~~ — **DONE 2026-08-09.** It unlocked six DocLab fields and
   fixed the condition we were asking wrongly (a corporation being asked for an operating
   agreement). Owner titles, share counts and certificate numbers came with it.
2. Copy the county from the appraisal to the file. The data is already ours.
3. Put the standing terms (default rate, governing law, servicer) into settings.

**Decide next (needs the owner's answer, not just code):**
4. How the legal description gets in — read it, or paste it.
5. ~~Titles on members~~ — **DONE 2026-08-09.** Signing AUTHORITY (which of the owners may sign
   alone) is still not recorded; the title is the closest thing we have to it today.
6. Trustee and title underwriter — where they get captured at closing.

**Leave alone for now:**
7. Multiple properties per loan. Their side is ready; ours would be a big change for a deal type we
   do not write today.

None of this is urgent this week. The reason to decide it soon is that **every one of these is a
blank on a recorded document if it is still missing on the day we go live** — and DocLab does not
reject a package with a blank in it. It drafts it.
