# The crossing ledger — what the owner has authorized, in writing

**Nothing built for RTL may be re-used by Long-Term (or the reverse) unless it is written down here.**
This is the machine-readable record of rule 2 of the two-product law
(`CLAUDE.md` → "TWO PRODUCTS, TWO SYSTEMS", mirrored in `.github/PRODUCT-SEPARATION.md` and `AGENTS.md`).

`scripts/check-product-separation.js` reads the block below on every `npm test` run and in CI. **A crossing that
is not listed here fails the build.** That is the point: "written authorization" is not a memory or a chat
message that scrolls away — it is an entry in this file, in the same commit as the code it permits.

## How to add an entry

1. Ask the owner for the specific thing, by name. *"May Long-Term re-use the password-hashing module we built
   for RTL?"* — never *"may I re-use some of the RTL code?"*
2. Get a **yes in writing**. Quote it.
3. Add one line to the `authorized` block below **and** one row to the log table, in the same pull request as
   the code that relies on it.

Authorization is **per item, never blanket**. A yes for one module is not a yes for the module next to it.
A yes for LT→RTL is not a yes for RTL→LT. If the owner's answer was "not for now", it does not go in this file.

## Entry kinds

| Kind | Means | Example |
|---|---|---|
| `import <path>` | Long-Term code (`src/longterm/**`, `app-v2/src/longterm/**`) may `require()`/`import` this RTL module — including a shared front-end component. Path is repo-relative (from `yscap-repo-root_8/`). | `import src/lib/crypto.js` |
| `rtl-import <path>` | This one RTL file may `require()` Long-Term code. `src/server.js` (the mount seam) and `scripts/test-lt-*.js` are already allowed and need no entry. | `rtl-import src/worker.js` |
| `sql-ref <table>` | An `lt_*` table may carry a foreign key to this RTL table. | `sql-ref borrowers` |
| `sql-read <table>` | Long-Term code may **read** this table in SQL (`FROM` / `JOIN`). Reading is not writing. | `sql-read borrowers` |
| `sql-write <table>` | Long-Term code may **change** this table (`INSERT` / `UPDATE` / `DELETE`). Implies read. | `sql-write borrowers` |
| `column <table>.<column>` | This ONE owner-authorized Long-Term column may exist on this RTL table (the 2026-08-30 share-the-code grant — a fourth owner scope needs its owner column). Any other lt-named column on an RTL table still fails the gate. | `column documents.lt_loan_id` |

Lines starting with `#` are comments. Everything else must match one of the six kinds exactly.

**Only the FIRST `authorized` block in this file counts.** An example block written later in the prose can never
quietly become a real permission.

```authorized
# ---------------------------------------------------------------------------
# SHARED IDENTITY — authorized in writing by the owner, 2026-08-03:
#   "same login same borrower record, keep it separate everything else …
#    all the borrowers should be able to see all their files even if its long
#    term or short term … officers should be able to see all of their files
#    even if it's long term or short term."
#
# This is the ONLY zone that crosses. Everything else — workflow, statuses,
# integrations, documents, money, screens — is a brand-new Long-Term build.
# Do not add a line here to make a build pass; add it only after the owner has
# said yes, in writing, to that exact item.
# ---------------------------------------------------------------------------

# One login for both products (staff and borrowers alike).
import src/auth/index.js

# One borrower = one person record, whichever product the file belongs to.
# READ only: Long-Term shows the borrower, it does not rewrite the person record.
sql-ref  borrowers
sql-read borrowers

# A Long-Term file knows its officer, so "officers see all of their files"
# can be true across both products. Same staff accounts as the login above.
sql-ref  staff_users
sql-read staff_users

# "Officers should be able to change the borrower profile on long term files"
# (owner, 2026-08-03). The officer edits through the ONE shared borrower editor
# that already exists — Long-Term does not get a second one, and Long-Term code
# still never writes `borrowers` itself.
import   app-v2/src/components/BorrowerProfilePanel.jsx

# …and for that editor to open, the officer must be allowed to see the person.
# That permission is the identity zone's own link table — built for exactly this
# case: "the client who has only ever done non-RTL business with them, so there
# is no file to match on" (db/327). Long-Term records the officer↔person link
# there when a long-term file gets an officer.
sql-ref   borrower_officers
sql-write borrower_officers

# ---------------------------------------------------------------------------
# THE VESTING ENTITY — authorized in writing by the owner, twice.
#
# 2026-08-30 (the original directive):
#   "So it should populate that LLC as an LLC slot and it should be linked
#    directly to his profile. So if that LLC is already verified somehow on his
#    profile or even if it is not verified, even if it has some documentation on
#    his profile already like formation documents, operating units, whatever it
#    has that information should automatically be pre-filled in this condition …
#    You have the entire entity logic. Bring over the entire entity logic that we
#    have all over. Bring it over there. You should basically share the logic.
#    Don't copy it. We need to share that logic from there. It should be directly
#    linked to the profile. It should be saved to the profile. If that entity
#    exists already in the profile, then it should pre-fill with that entity docs
#    already there … when you put in the documents and you verify it should be
#    verified to his profile in future when you use this LLC it's already
#    verified."
#
# 2026-08-30 (the correction that closed it):
#   "For this one, we need to bring over the same exact logic. If this upload is
#    already uploaded in this entity slot on the profile, then it should be
#    pre-filled with the documents already there and verified already. Also,
#    you're missing the optional certificate of good standing."
#
# WHY IT IS AN IMPORT AND NOT A COPY, in the owner's own words: "share the logic,
# don't copy it." A second entity implementation would be a second answer to "is
# this company verified?" — and the one that drifts is the one that lets an
# unverified company take title. Sharing also picks up rules a copy would have
# missed and nobody would have noticed were missing: the Certificate of Good
# Standing is OPTIONAL and EXPIRES AFTER 30 DAYS (`llc.js` GS_SLOT_CODE), the
# layered-entity walk verifies bottom-up, and `missingForVerification` already
# knows what a corporation is asked for versus an LLC, a partnership or a trust.
#
# THE ENTITY IS THE BORROWER'S, NOT THE PRODUCT'S. `llcs` hangs off `borrowers`,
# which is already the shared identity zone — the same reasoning that authorized
# `service_contacts`. One company, one set of formation documents, verified once.
#
# SCOPE. Long-Term reads and writes the entity through THIS module and never with
# raw SQL of its own, so every rule above applies to both products by
# construction. It does not reach the RTL condition engine, the RTL file screens,
# or any RTL loan data.
# ---------------------------------------------------------------------------

# The one entity definition: find-or-create, the document slots, the members,
# what is still missing before it can be verified, and the good-standing expiry.
import   src/lib/llc.js

# The entity record itself, and the document slots that hang off it. WRITE is
# authorized because the owner asked for it by name — "it should be saved to the
# profile … when you put in the documents and you verify it should be verified to
# his profile" — and it happens THROUGH the shared module above, never in raw SQL.
sql-ref   llcs
sql-write llcs

# ---------------------------------------------------------------------------
# CLICKUP FOR LONG-TERM — authorized in writing by the owner, 2026-08-23:
#   "Bring over the basic details of the ClickUp connector and actual
#    credentials from the ClickUp connector from the RTL side over to the
#    long-term side … You already have the officer syncing and all the
#    folders … you can just take it over and bring it over to the long-term
#    side the correct folder ids for every officer."
#
# WHAT CROSSES, AND WHY IT IS THESE TWO FILES AND NOT THE INTEGRATION. The
# ClickUp WORKSPACE is the company's, not RTL's: both products' files sit in
# one Loan Pipeline space, in the same per-officer folders. So the field ids
# and the officer->folder map are FACTS ABOUT THE TENANT, not RTL behaviour,
# and a second copy of them in src/longterm would be two hand-kept lists of
# the same ids drifting apart — the failure this ledger exists to prevent.
# Both modules are pure data with no requires and no behaviour.
#
# WHAT DOES NOT CROSS: the RTL ClickUp CLIENT, orchestrator, ingest, mapper,
# crosswalk, enqueue and status machinery. Long-Term gets its own client under
# src/longterm/clickup/, exactly as it has its own Encompass client, reading
# LT_CLICKUP_* and falling back to the shared CLICKUP_* environment values —
# which is what "the actual credentials" means: the same token, named in the
# environment, never a value in code.
# ---------------------------------------------------------------------------

# The tenant's ClickUp custom-field ids (including the YS loan number and the
# portal-file-id stamp) and the per-officer folder routing. Data, not logic.
import src/clickup/fields.js
import src/clickup/routing.js

# ---------------------------------------------------------------------------
# THE FRONT-END MOUNT SEAM — authorized in writing by the owner, 2026-08-14:
#   "You were authorized to touch that switch of the short-term shell."
#
# The back end already has one sanctioned seam: src/server.js mounts the LT
# router. The front end had no equivalent, so nothing could route to
# app-v2/src/longterm/** and no switch could be rendered.
#
# This is the front-end analogue, and it is deliberately just as narrow: two
# RTL files may reference Long-Term code, and ONLY to mount it and to render
# the product switch. No RTL screen may import an LT component for its own
# use, and no LT logic may be lifted into a shared file.
# ---------------------------------------------------------------------------

# The router mounts the Long-Term screens.
rtl-import app-v2/src/App.jsx

# The staff shell renders the Short-Term / Long-Term switch.
rtl-import app-v2/src/components/StaffLayout.jsx

# ---------------------------------------------------------------------------
# THE CLIENT'S OWN SWITCH — authorized in writing by the owner, 2026-08-17:
#   "put the switch on the borrower's home screen"
#
# Asked as one specific question — the client's long-term page was built and
# routed at /long-term, and putting its entry point on the borrower dashboard
# means an RTL screen referencing Long-Term code, which the seam above says
# needs the owner's written OK per file. This is that OK, for that one file.
#
# SCOPE: exactly the same narrowness as the staff shell — this file may
# reference Long-Term code ONLY to render the switch. It imports ONE component
# (`BorrowerLongTermSwitch`) and renders it; it holds no Long-Term logic, reads
# no Long-Term data itself, and may not import a second Long-Term component.
# The decision of whether there is anything to switch TO lives on the
# Long-Term side, so the RTL screen never learns how that is judged.
# ---------------------------------------------------------------------------

# The borrower's home screen renders the Short-Term / Long-Term switch.
rtl-import app-v2/src/screens/Dashboard.jsx

# ---------------------------------------------------------------------------
# ADDRESS → COUNTY LOOKUP — authorized in writing by the owner, 2026-08-16:
#   "Yes, you have my written OK to reuse that."
#
# Asked as one specific question: the Lender Price DSCR pricer needs a ZIP to
# become city / state / county name / county FIPS before it can price, exactly
# as the vendor's own screen does. We already own that ability — but it lives
# in the RTL/shared zone, so re-using it is a crossing.
#
# SCOPE: this ONE module, used as a READ-ONLY LOOKUP (resolveCounty / geocode /
# canonicalize). It is not a licence to reuse RTL's address WRITERS
# (address-heal, address-review-close, address-usps-verify) or to let Long-Term
# rewrite any RTL address record — those need their own row.
#
# NOTE for a future reader: the module keeps its own permanent lookup cache
# (`address_canon_cache`, db/124) and uses the RTL pool internally. That is the
# module's own business and is covered by this import — Long-Term code writes
# no SQL against it. The alternative (a second Long-Term geocoder) was
# deliberately rejected: it would duplicate a solved problem, need its own API
# keys and cache, and drift from the one the rest of the company relies on.
# ---------------------------------------------------------------------------

# ZIP → city / state / county name / county FIPS, so a Long-Term DSCR quote can
# be priced from a ZIP instead of demanding a county FIPS from the caller.
#
# AUTHORIZED BUT NOT USED — kept deliberately, and it must not be read as a
# description of what shipped. On inspection the module could not answer this
# question: `resolveCounty` returns a county NAME and no FIPS (the pricer needs
# the 5-digit FIPS), it refuses a bare ZIP (it is built for a full street
# address, for the RTL order desk's rooftop-precision rule), and it needs a
# DATABASE_URL for its cache — so it cannot run inside the pure pricing path.
# What shipped instead is `src/longterm/lenderprice/zip-county.js`: the Census
# Bureau's own ZCTA-to-county table, generated + committed, pure and offline.
# That is NOT a crossing, so nothing here is required to make it legal. The
# owner's permission stands and is broader than what was used; if a future
# Long-Term surface genuinely needs the RTL geocoder, this line already covers
# it. See the log row below.
import src/lib/address-canon.js

# ---------------------------------------------------------------------------
# THE ADDRESS LOOK-UP BOX ON A LONG-TERM TERM SHEET — recorded in writing by the
# owner, 2026-08-30:
#   "You can put in property addresses. The property address should be linked
#    with the Find My Property address to autofill the property address from the
#    short-term site. You can use the same credentials."
#
# WHAT SHIPPED IS **NOT A CROSSING**, and this block exists so that the next
# reader does not have to work that out again.
#
# `app-v2/src/longterm/AddressField.jsx` is a brand-new Long-Term component. It
# imports NO short-term code — it calls `GET /api/address/suggest` and
# `GET /api/address/details`, which are:
#
#   · mounted at the TOP LEVEL of the server, not under /api/staff or any
#     product namespace;
#   · described by their own header as serving "the marketing site AND portal",
#     i.e. every surface this company has;
#   · a PROXY whose only reason to exist is that the provider's key must not
#     leave the server. They hold no loan data, read no RTL table, and return
#     nothing about either product.
#
# So this is the same class as the LOGIN TOKEN that `app-v2/src/longterm/http.js`
# already reads and documents: infrastructure both products stand on, not a
# short-term feature lifted across. The owner described it as coming "from the
# short-term site" because that is where they have seen it, which is why it is
# written down here rather than left to inference.
#
# NO `import` LINE IS ADDED, deliberately — the five entry kinds describe module
# and table crossings, and an HTTP call to a shared door is neither. Adding a
# line that matches no kind would fail the gate's own parser.
#
# WHAT WOULD BE A CROSSING, and is not done: importing RTL's own address input
# component, or reaching `src/lib/address*` from Long-Term server code. The
# geocoder crossing directly above (`address-canon.js`) is separate, already
# authorized, and still unused.
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# THE COMPANY'S SENDING IDENTITY — authorized in writing by the owner,
# 2026-08-30, answering a direct question about the first Long-Term feature
# that sends email (the daily rate-movement reports):
#
#   "Yes I'm giving you a written authorization to use the sender credentials
#    from the short-term side. Send it out from lock desk @ YS Capital
#    Whatever. Basically that should be the idea but follow the resend
#    credentials."
#
# WHAT CROSSES, AND WHY IT IS THE TRANSPORT AND NOT THE EMAIL. A sending
# domain's reputation, its DMARC alignment and its suppression list are
# properties of THE COMPANY, not of a product: two independent senders on one
# domain is how a domain's deliverability is damaged, and the second sender is
# the one that gets it wrong. So Long-Term uses `src/lib/email/index.js` as a
# TRANSPORT — hand it a rendered message, it picks the configured provider
# (Resend, per the owner's direction) and sends. The same reasoning the owner
# applied to the ClickUp connector on 2026-08-23: the WORKSPACE was the
# company's, not RTL's.
#
# WHAT DOES NOT CROSS: RTL's notification machinery. No `notify.js`, no
# `catalog.js`, no `template.js`, no digests, no in-app rows, no
# `notifications` table. Long-Term builds its own message bodies in
# `src/longterm/**` and hands the finished thing to the transport, exactly as
# it has its own Encompass client and its own ClickUp client.
#
# THE FROM ADDRESS is the owner's ("lock desk @ YS Capital"), configured in the
# hosting environment like every other address here — never a value in code.
#
# NOT USED YET, DELIBERATELY. The reports are Phase 2 and are not built. The
# grant is recorded now, in the owner's own words, so the authorization is the
# ledger entry rather than a chat message that scrolls away — the same shape as
# the `address-canon.js` line above, which is likewise authorized and unused.
# ---------------------------------------------------------------------------

# The DIRECTIVE for this crossing is declared ONCE, further down, on the entry
# that describes it in use (the order sender). Main authorized the same module
# independently and in more detail on the same day; this block records the
# SECOND owner conversation — the rate-movement reports — because the two grants
# were given separately and both belong in the record. One crossing, one line.
# ---------------------------------------------------------------------------

# THE FILE-OVERVIEW SLIDE-OVER — authorized in writing by the owner, 2026-08-30:
#   "Right now, the file overview is always displaying on the right side. We want
#    to go and do the same thing that we have on the short term side, where we
#    have a file overview button. It should be the same feel. We open it up, and
#    it comes up with all the details of the file overview."
#   … and, over the whole instruction: "You need to make sure you're not copying
#    the information. You're just using the information from the short-term side
#    … Everything should share the code, so we don't need to rewrite the code.
#    We are just sharing the code. If the code is updated, he's also updating it."
#
# WHY THIS FILE AND NOTHING AROUND IT. `FileOverviewSlideOver.jsx` is already
# product-neutral BY CONSTRUCTION: it takes a `fetcher` and renders whatever
# `{header, sections[]}` that fetcher resolves. It reads no table, knows no
# product, and holds no RTL rule — which is exactly why RTL itself mounts the one
# component on three different surfaces (staff, borrower, broker) with three
# different fetchers. Long-Term becomes the fourth caller and supplies its own
# data, so the AUDIENCE BOUNDARY stays where it already is: with whoever hands it
# the payload, never inside the panel.
#
# THE ALTERNATIVE WAS REJECTED ON THE OWNER'S OWN TERMS. A long-term lookalike
# would be a second copy of a solved problem, and the owner asked for the
# opposite in the same breath ("share the code … if the code is updated, he's
# also updating it"). The `.fov-*` stylesheet is already global and shared, so a
# copy would have shadowed the same CSS with different markup — the drift this
# ledger exists to prevent.
#
# WHAT DOES NOT CROSS: nothing else on the RTL file screen. Long-Term does not get
# `FileSections.jsx`, `DealSnapshot.jsx`, the `.snap-*` components or any RTL
# fetcher. It renders its own long-term data through this one panel.
#
# TRANSITIVE, AND DELIBERATELY NOT LISTED SEPARATELY: the panel imports
# `app-v2/src/lib/overlay-layers.js` (the z-order store that keeps the tab
# clickable over a document preview). That is RTL importing RTL, which is not a
# crossing and needs no entry — it is named here so a future reader knows it came
# along and is covered by this authorization.
# ---------------------------------------------------------------------------

# The long-term file screen opens its overview in the ONE shared slide-over.
import app-v2/src/components/FileOverviewSlideOver.jsx

# ---------------------------------------------------------------------------
# ORDERS — authorized in writing by the owner, 2026-08-30, asked as a specific
# question about the long-term Orders section:
#
#   "Everything should share the code, so we don't need to rewrite the code. We
#    are just sharing the code. If the code is updated, he's also updating it."
#
#   "You need to make sure you're not copying the information. You're just using
#    the information from the short-term side."
#
#   "While you're sharing it, watch what you're doing not to break the other
#    side of the business, the short-term side."
#
# THREE SENTENCES, THREE DIFFERENT INSTRUCTIONS, and each one shapes what is
# below:
#
#   1. SHARE THE CODE — one definition, so a fix to the order letter helps both
#      products rather than one.
#   2. USE THE INFORMATION, DO NOT COPY IT — the vendor directory is the
#      company's, not RTL's. A title company corrected once is corrected
#      everywhere, which is only true if there is one row rather than two.
#   3. DO NOT BREAK THE SHORT-TERM SIDE — which is why what crosses is a PURE
#      module extracted out of `src/lib/orders.js` and re-exported BY it, rather
#      than Long-Term reaching into the order desk itself.
#
# WHAT CROSSES, AND WHY IT IS THIS AND NOT `src/lib/orders.js`. That file is 900
# lines and most of it reads RTL tables — `applications`, `checklist_items`,
# `file_orders` — and requires the RTL pool at module load. Importing it would
# not be "sharing code", it would be Long-Term running on RTL's data layer, and
# rule 4 forbids that outright ("no shared database pool", "LT may not read or
# write an RTL table in raw SQL either").
#
# So the SHAREABLE half was extracted into `src/lib/order-email.js`: the letter
# itself, the mortgagee clause, the recipient rule, the reply-address minting and
# the send verdict. It touches NO database and requires no RTL data module.
# `src/lib/orders.js` re-exports every one of those names, so the short-term desk
# is byte-identical and there is exactly ONE definition of an order letter — which
# is precisely what the owner asked for.
#
# WHAT DOES NOT CROSS: `src/lib/orders.js` itself, `getOrderData`, `placeOrder`,
# `file_orders`, `file_order_events`, RTL's inbound mail routing, and RTL's
# notification system. Long-Term has its own `lt_file_orders` and its own desk,
# and no `lt_*` table references an RTL one.
# ---------------------------------------------------------------------------

# The order LETTER and everything pure around it — one definition for both
# products. Extracted from src/lib/orders.js, which re-exports it.
import src/lib/order-email.js

# The branded email renderer. The owner asked for "the same Gmail-style box" on
# the long-term side; a second renderer would be a second brand.
import src/lib/email/template.js
import src/lib/email/quote.js

# The unique per-order reply address, so a vendor's reply and the documents they
# send back route to the order that asked for them. One definition, or the two
# products would mint addresses the one inbound webhook cannot tell apart.
import src/lib/file-address.js

# Reading an inbound message — which addresses a delivery names, the Receiving-API
# retrieval, the attachment download with its two honest drop counters, the
# sender-authentication verdict and the auto-responder test. Extracted from
# src/lib/file-inbox.js (which re-exports it) for the same reason the letter was:
# that file is the SHORT-TERM inbox and requires the short-term pool at module
# load. A vendor's reply to a long-term order has to be read the SAME way, and a
# second copy of a security-relevant reading is the copy that drifts.
import src/lib/inbound-mail.js

# The Resend/Svix webhook signature check. There is ONE inbound webhook secret and
# ONE verification, on node's own crypto and nothing else; a second copy of a
# signature verifier is the one duplication that must never exist.
import src/lib/resend-webhook.js

# THE MAIL SENDER. One Resend/Graph account, one From identity, one SPF/DKIM/DMARC
# story — a second sender would be a second deliverability posture and a second
# place the provider's ceiling is (not) respected.
#
# STATED PLAINLY RATHER THAN SMUGGLED: `email/rate-limit.js` lazily reaches for
# `src/db` to spend from the outbound budget every process shares (db/619). That is
# the ONE place a long-term send touches the short-term pool, and it is deliberate:
# there is ONE Resend account, so there is ONE ceiling, and two independent budgets
# would let the two products together burst past it and get the whole company
# throttled — which is the failure that budget exists to prevent. It carries no loan
# data in either direction. Long-Term sends with `_skipCapture: true`, so the
# short-term Email Center is never written; the long-term thread is its own
# `lt_order_events` row.
import src/lib/email/index.js

# WHERE THE BYTES GO. One storage layer — one persistent disk / one bucket, one
# path-traversal defence, one atomic write, one integrity hash. A second one is a
# second place a document can be silently lost.
import src/lib/storage.js

# What a file actually IS, from its own first bytes, and the one tolerant base64
# decode. A second sniffer is a second answer to "is this a PDF or an HTML error
# page saved as one", and the lenient decoder is what silently garbles a document.
import src/lib/upload-bytes.js

# An email-signature logo is not a returned document. One definition, or the
# long-term desk re-lives the months of rejecting company logos by hand that the
# short-term desk already lived through.
import src/lib/order-return-filter.js

# WHERE A PERSON'S OWN REPLY ENDS AND THE QUOTED HISTORY BEGINS. The order letter
# PRINTS the shared reply marker at the top of its content; this is the reader that
# cuts on it. They are two halves of one mechanism, so a second copy of the cut
# would file a vendor's whole thread on the loan on every round.
import src/lib/email/reply-cut.js

# WHO AN EMAIL COMES FROM, and whether we are allowed to say so. There is ONE
# company identity, ONE verified sending domain and therefore ONE answer to "may we
# put this person's address in the From line" — the arithmetic is DKIM alignment, not
# a preference, and a second copy of it would be a second deliverability posture.
# PURE: no config, no network; the caller supplies the configuration.
# docs/SEND-AS-USER-AND-DELIVERABILITY.md is the research behind it.
import src/lib/send-as.js

# THE DOCUSIGN TRANSPORT — the low-level client only.
#
# The owner asked for the long-term verification of rent to go out "by DocuSign, as
# an email attachment, or both". There is ONE DocuSign account, ONE integration key,
# ONE one-time JWT impersonation consent granted to it, ONE access-token cache and
# ONE Connect HMAC secret — so a second client would mint a second JWT against the
# same user on the same rate-limited token endpoint, and would be a second place the
# inbound webhook's signature is verified. A second copy of a signature verifier is
# the one duplication that must never exist.
#
# WHAT IS SHARED IS THE TRANSPORT, NOT THE WORKFLOW. This module's own header says
# it: "It does NOT decide WHEN to send, own the send-once claim, or clear
# conditions." Long-Term builds all of that itself in src/longterm/vor/** against
# its own lt_vor_* tables; nothing here reads an RTL table and no RTL module reads a
# long-term envelope.
#
# THE SHARED CONNECT WEBHOOK NEEDED A CLAIM, exactly like the shared inbound-email
# endpoint: DocuSign posts every envelope's events to one URL, and the RTL drainer
# answers an envelope it does not own with `skipped: 'untracked'` — correct for it,
# and it would have swallowed the landlord's signature in silence. Long-Term's claim
# is mounted IN FRONT of the RTL route at that endpoint and hands on anything that is
# not one of its own.
import src/lib/integrations/docusign.js

# HOW A VENDOR'S ADDRESSES AND PHONES ARE READ — the PURE half only
# (`allEmails` / `allPhones` / `dedupBy`). db/224 added an `emails text[]` beside
# the legacy scalar `email` and backfilled only the rows that existed then, so on
# many live cards the array is NULL and the scalar is the only value while on
# others the scalar is merely the first entry. Reading either alone drops
# addresses, which on this desk means a title company's closing@ inbox never
# receiving the order and nobody knowing. One definition, or the long-term desk
# rediscovers that column pair the hard way.
#
# `suggest()` was declared OFF LIMITS here for ONE reason, and it is worth stating
# what that reason actually was: it lazily reached for `src/db` and its "used on N
# files" count named `application_service_contacts`, so calling it from Long-Term
# would have run a long-term read on the short-term pool AND counted a link table a
# long-term loan can never appear in. UNDER THE 2026-08-30 SHARE-THE-CODE GRANT
# (*"it should be the exact same vendor setup and use the same information"*) both
# of those are now PARAMETERS: the pool has always been injectable (`dbc`), and the
# counted link table is `usedCountFrom` — defaulted to the short-term one, so every
# short-term caller is byte-identical, and validated as a bare identifier because a
# table name cannot be a bind parameter. So the suggester CAN be shared; when
# Long-Term calls it, it MUST hand over its OWN pool and its OWN link table
# (`lt_loan_vendors`), or it is back to both of the faults above.
#
# NOT YET CALLED FROM LONG-TERM, deliberately: the desk's own search is replaced
# when the shared FileContacts screen lands. `scripts/test-lt-orders-pure.js` still
# holds every module in `src/longterm/orders/**` and the orders routes to the PURE
# half — that guard is what stops the shared suggester being reached for with the
# short-term pool by habit, and it stays until the caller passes both parameters.
# The seam itself is proven on a real database by
# scripts/test-lt-vendor-write-db.js, which also proves the short-term type-ahead
# did not move a byte.
#
# NO NEW LEDGER LINE IS NEEDED for the long-term WRITE half (create-and-link + edit
# a vendor card from the orders desk): this `import` already authorizes the pure
# helpers it uses, and `sql-write service_contacts` is authorized below.
import src/lib/vendor-directory.js

# ---------------------------------------------------------------------------
# THE VENDOR DIRECTORY — the second sentence above, in table form.
#
# `service_contacts` hangs off `borrowers`, which is ALREADY the shared identity
# zone (2026-08-03). A title company, an insurance agent or an attorney is the
# COMPANY'S record of a vendor, not a fact about which product a loan is. The
# owner's "you're just using the information from the short-term side" is a
# refusal of a second copy, and a second copy is exactly what a Long-Term vendor
# table would be: the same companies, typed again, drifting.
#
# LONG-TERM READS AND WRITES IT, because adding a title company from a long-term
# file has to put it where the short-term side will see it — that is the whole
# point. What Long-Term does NOT touch is `application_service_contacts`, the
# per-FILE link, which is keyed on an RTL application: Long-Term keeps its own
# `lt_loan_vendors` link, so no lt_* table references an RTL one.
# ---------------------------------------------------------------------------

sql-ref   service_contacts
sql-read  service_contacts
sql-write service_contacts

# ---------------------------------------------------------------------------
# THE ONE CONDITION CENTER — authorized in writing by the owner, 2026-08-30
# (the SHARE-THE-CODE directive; full quotes + boundary in
# docs/longterm/SHARE-THE-CODE-DIRECTIVE.md):
#
#   "I gave you written authorization to bring that exact Condition Center
#    over here. Take that exact Condition Center and make your conditions in
#    that Condition Center follow those rules."
#   "If I'm updating something in the logic of the Condition Center ... it
#    should update them both places. You need to share the code."
#
# The Condition Center was multi-owner from day one (scope application /
# borrower_profile / llc, chk_one_owner = exactly one owner column). The
# Long-Term loan joins as the FOURTH owner: scope 'lt_loan', owner column
# lt_loan_id on the two tables below (db/652). Every RTL selector is already
# scope-filtered, so an lt_loan row is invisible to every RTL pass by
# construction. DELIBERATELY NO FK to lt_loans — the gate forbids welding an
# RTL table to the side build, and it is right; the column is a bare uuid the
# Long-Term code interprets.
# ---------------------------------------------------------------------------

column checklist_items.lt_loan_id
column documents.lt_loan_id

# Long-Term code reads and writes its OWN rows in the shared Condition Center
# tables (scope 'lt_loan' / lt_loan_id) — the same grant, the same directive.
# Every LT statement against these tables is scoped to lt_loan_id in the
# statement itself; an RTL-scoped row is unreachable from LT code by
# construction, and the reverse.

sql-read  checklist_templates
sql-write checklist_templates
sql-read  checklist_items
sql-write checklist_items
sql-read  documents
sql-write documents

# WHO OWNS A CONDITION OR A DOCUMENT — one descriptor, both products. The same
# 2026-08-30 share-the-code grant: "if I'm updating something in the logic of the
# Condition Center ... it should update them both places. You need to share the
# code."
#
# WHY IT IS AN IMPORT AND NOT A COPY. This module answers three questions —
# which product owns this row, how do I say so in a WHERE clause, which column do
# I set on an INSERT — and every one of them was previously written out by hand
# at each call site as `application_id = $1`. That is exactly the shape that
# cannot be shared: the second product's copy of a hand-written owner predicate
# is the copy that drifts, and a drifted owner predicate is a document from one
# loan answering for another. It is PURE (no database, no config, no requires)
# and it FAILS CLOSED — an unknown scope or a missing id THROWS rather than
# quietly defaulting to a product.
import src/lib/condition-owner.js

# THE GENERIC REQUIRED-SLOTS RULE. Ported OUT of
# src/longterm/conditions-center/write.js (`missingSlots`) into the shared
# sign-off gate, which had no generic version and states the same rule three
# times by hand. Long-Term imports it BACK rather than keeping the original as a
# second copy — a second copy is precisely what the port removed, and a condition
# that reads as "still waiting on the invoice" at the sign-off door and as
# finished on the Long-Term screen is the drift this ledger exists to prevent.
# PURE apart from one read of the two shared tables already authorized above.
import src/lib/conditions/required-slots.js

# WHAT A CHECK CONSTRAINT ACTUALLY ADMITS, read out of Postgres's own catalogue
# (`pg_constraint`), so the Long-Term library can prove at BUILD time that every
# value its vocabulary mapping emits is one the shared column will take. A value
# set written down beside a column is a copy, and a copy nothing checks is the
# copy that drifts — the first anybody hears of it is a check violation on a
# loan file.
#
# NOT PRODUCT CODE, AND IT TOUCHES NO PRODUCT'S TABLES. `pg_constraint` is
# Postgres's own catalogue, exactly like `information_schema`, which this repo
# already reads to enumerate foreign keys (lib/borrower-merge.js) and to keep the
# numeric-column bounds table honest (scripts/test-column-bounds-doors-db.js).
# It is shared rather than Long-Term's own because "what does this constraint
# admit?" is a question either product may need to ask, and two answers to it is
# the duplication this ledger exists to prevent.
import src/lib/conditions/live-check-values.js

# THE OWNER'S "ANSWERED ANOTHER WAY" RULE — the one definition, read by BOTH gates.
#
# 2026-08-30 share-the-code grant. This module was Long-Term's own
# (src/longterm/conditions-center/answers.js) and it MOVED to the shared library
# for a reason that was measured, not anticipated: three conditions are a CHOICE
# rather than an upload, and the owner said so plainly — *"you can just select
# that it's FCI, whatever, and then you don't need anything, not an attachment and
# not a form."* While the rule lived under src/longterm/, the ONE shared sign-off
# gate could not require it (RTL code may not reach into the side build, and that
# stays true). The result: the Long-Term product door ALLOWED the owner's own
# answer while the shared gate REFUSED the very same condition for want of a
# document — two gates, two answers, one condition, and the refusal was permanent
# with no way through but a super-admin override.
#
# It is PURE (no database, no config, no requires of its own), so moving it costs
# nothing and buys one definition that the door recording an answer and both gates
# judging one all read. Long-Term imports it back from the shared library here.
import src/lib/conditions/answers.js

# THE THREE COLUMNS THE SHARED TABLES GAIN SO A LONG-TERM CONDITION CAN LIVE IN
# THEM (db/653, the same grant). None is lt_-prefixed, so the gate does not
# require these lines — they are recorded because the rule is per item and a
# reader should be able to see the whole crossing in one place:
#   checklist_templates.config       the Long-Term library's own per-condition
#                                    settings, which no existing column holds
#   checklist_items.slots            the PER-ITEM required-slot list the generic
#                                    sign-off arm reads (RTL writes it nowhere,
#                                    which is what makes that arm a no-op there)
#   checklist_items.waived_reason    WHY, beside the waived_by/waived_at this
#                                    table has carried for a long time

# ---------------------------------------------------------------------------
# THE ONE SHAREPOINT MIRROR — the same 2026-08-30 share-the-code grant:
#   "Same thing is with SharePoint: you need to share the code."
#   "The SharePoint looks for the same exact folder, same exact logic that we
#    build up on the short-term side."
#
# There is ONE mirror (src/lib/sharepoint-backup.js) and it now files an
# lt_loan-scoped document into the SAME Pipeline Drive tree. The one thing it
# cannot know by itself is WHERE a long-term loan keeps its officer / borrower /
# property, because that reads lt_* tables — and RTL code naming a Long-Term
# table is refused outright, with no ledger override, exactly as it should be.
# So src/longterm/sharepoint-scope.js states those facts (SQL fragments + one
# pure predicate, no mirror logic) and the shared mirror requires it, through a
# try/catch so the live product keeps mirroring if the side build is absent.
# This is the crossing that authorizes that one require().
rtl-import src/lib/sharepoint-backup.js

# ---------------------------------------------------------------------------
# THE CONDITION-DOCUMENT MACHINERY — the 2026-08-30 share-the-code grant, and
# the owner's own list of verbs:
#
#   "If I'm updating something in the logic of the Condition Center (the way you
#    preview stuff, the way you preview the PDFs, the way you drag and drop,
#    accept, reject, preview, download, and delete), it should update them both
#    places. You need to share the code."
#   "You can't really upload stuff. You can't do anything. Nothing actually
#    works."
#
# The Long-Term Condition Center had eighteen routes and NOT ONE of them
# accepted a document, so a condition asking for a bank statement had nowhere to
# put one. These four modules are the ONE implementation of what happens to a
# document on a condition — the intake contract and the filename sanitiser, the
# visibility rule, the slot label, the de-duplication, the INSERT through
# `ownerCols`, the supersede rules, the evidence re-open; then the verdict's
# stamps and the condition moves it causes; then the permanent delete and the
# re-open when nothing accepted is left; then the authorized row lookup the one
# serving path streams from.
#
# WHY IMPORTED AND NOT COPIED. Every one of those rules is a rule about
# DOCUMENTS rather than about a product, and each is a rule a second copy would
# get subtly wrong in a way nobody would see for months — an accept that marks a
# condition SATISFIED instead of RECEIVED (#135) flies a multi-document
# condition away on its first accepted file; a delete that forgets the re-open
# leaves a condition reading "received" with nothing on it. What each product
# does ABOUT a document is NOT shared: the ClickUp push, the borrower portal
# notification and the Sitewire memory are HOOKS, defaulted to the short-term
# set for `scope='application'` and to NOTHING for any other owner, and the
# Long-Term door passes an empty set explicitly on top of that.
#
# The owner scoping is welded into the STATEMENT (`ownerWhere`), so a document
# belonging to the other product is not merely refused by the Long-Term door —
# it is unreachable from it.
import src/lib/condition-docs/upload.js
import src/lib/condition-docs/review.js
import src/lib/condition-docs/remove.js
import src/lib/condition-docs/serve.js

# ---------------------------------------------------------------------------
# THE TRANSPORT THAT CARRIES A BIG DOCUMENT — the same grant again, and the half
# without which the four doors above are capped at a size real loan documents
# routinely exceed.
#
# Every legacy upload door in this repo takes {filename, contentType, dataBase64}
# as JSON, which express buffers and parses WHOLE — measured at roughly five
# times the file — so `takeUpload` caps that transport at `maxJsonUploadMb`
# (25 MB, and base64 inflates by about a third, so nearer 18 MB of real file).
# The short-term side answered that on 2026-08-21 by registering each document
# door TWICE: the JSON door, and a `…/binary` sibling behind `binaryIntake`,
# which streams the bytes to storage as they arrive and is bounded by
# `maxUploadMb` (1 GB) instead.
#
# Long-Term had only the JSON door, so ONE Condition Center gave two different
# answers about the same appraisal-with-photographs, the same scanned closing
# package, the same survey — 25 MB on a long-term file, 1 GB on a short-term one.
#
# NOTHING IS COPIED. `takeUpload` reads `req.uploaded` FIRST, so the Long-Term
# handler is byte-for-byte the same function on either transport and never learns
# which door it was called through; the two registrations share ONE handler
# exactly as `src/routes/staff.js` does. Re-implementing the streaming door on
# the Long-Term side would be a second place a document can be truncated, a
# second temp-file cleanup to get right, and a second answer to "how big may a
# document be" — which is the shape the owner rejected.
import src/lib/upload-stream.js

# ---------------------------------------------------------------------------
# THE CONDITION CENTER'S SCREEN — the same grant, the same sentence, the other
# half of it: "the same look of the Condition Center."
#
# Long-Term had a LOOKALIKE of the Condition Center — its own condition row, its
# own action buttons, its own document list, no preview and no upload at all —
# which is precisely what the owner rejected. These are the REAL components the
# short-term file screen draws, mounted by the Long-Term screen.
#
# THEY ARE SHAREABLE AS THEY STAND, and that is why they are the ones listed:
# each takes its I/O as function props (`onPatch`, `onReviewDoc`,
# `onDownloadDoc`, `onPreview`, `load`) and NONE of them imports an API client,
# so the Long-Term screen hands over functions backed by `ltApi` hitting the
# /api/lt doors and the components cannot tell which product they are drawing.
# Their own transitive imports are RTL→RTL and need no line here; the gate reads
# the location of the IMPORTING file.
#
# WHAT IS NOT SHARED IS THE PAGE. The owner, in the same conversation: "this is
# not a redesign … I like the design that we have on the long-term side. Don't
# change the design. Stick with the design and with the fonts." So the gates,
# the three-number summary, the white boxes and the fonts stay Long-Term's own,
# and the shared parts are dropped INTO that page. Nothing in these files was
# changed to make Long-Term fit: the row-shape translation lives on the
# Long-Term side, because renaming a field inside one of these would silently
# change what the live short-term product reads off its own rows.
import app-v2/src/components/ConditionLine.jsx
import app-v2/src/components/ConditionActions.jsx
import app-v2/src/components/DocPreview.jsx
import app-v2/src/components/DropZone.jsx
import app-v2/src/components/UploadRows.jsx
import app-v2/src/components/LoudHint.jsx

# THE ONE RECORD OF WHAT IS UPLOADING RIGHT NOW. `UploadRows` above renders only
# what this store holds, and until now only the short-term transport published
# into it — so a Long-Term upload would have rendered NOTHING while it ran and
# read as "it is not uploading", which is the exact defect the owner already
# reported once on the short-term side (2026-08-23). The store and its
# `uploadTarget()` are product-neutral: a row files itself under
# `condition:<id>` from the upload's own metadata. Long-Term's own transport
# (app-v2/src/longterm/http.js) publishes the same start/update/finish calls, so
# the bar is the same bar rather than a second progress mechanism to keep in
# step with it.
import app-v2/src/lib/upload-progress.js
```

## Log of authorizations

| Date | Kind + item | Direction | The owner's words | PR |
|---|---|---|---|---|
| 2026-08-03 | `import src/auth/index.js` — one login for both products | RTL → LT | *"same login same borrower record, keep it separate everything else"* | #975 |
| 2026-08-30 | `import src/lib/condition-docs/{upload,review,remove,serve}.js` — the ONE condition-document service: what happens to a document when it lands on a condition, what a verdict does to that condition, what a delete re-opens, and which row a download is allowed to have | RTL → LT | *"You can't really upload stuff. You can't do anything. Nothing actually works."* … *"if I'm updating something in the logic of the Condition Center (the way you preview stuff, the way you preview the PDFs, the way you drag and drop, accept, reject, preview, download, and delete), it should update them both places. You need to share the code."* The Long-Term Condition Center had eighteen routes and not one accepted a document. The four /api/lt doors are THIN CALLERS of these, exactly as `src/routes/staff.js` is — the same functions with a different owner, the owner welded into the STATEMENT so a document from the other product is unreachable. **No short-term hooks are passed**: the ClickUp push, the borrower portal notification and the Sitewire memory are that product's own and the Long-Term door hands over an empty set | this PR |
| 2026-08-30 | `import src/lib/upload-stream.js` — the STREAMING upload transport: one shared `binaryIntake` + `takeUpload`, so a `…/binary` sibling of the condition-document door writes bytes to storage as they arrive instead of holding a base64 copy of the whole file in memory | RTL → LT | *"We don't want to reinvent the code. We want to use the same exact condition center, and when we update something, it should update on both… You need to share the code."* The Long-Term Condition Center had only the base64-in-JSON door, capped at 25 MB — nearer 18 MB of real file — while the short-term side has taken 1 GB through its streamed sibling since 2026-08-21. Same Condition Center, two different answers about the same appraisal. `takeUpload` reads `req.uploaded` first, so the ONE handler is identical on either transport and never learns which door it came through | this PR |
| 2026-08-30 | `import app-v2/src/components/{ConditionLine,ConditionActions,DocPreview,DropZone,UploadRows,LoudHint}.jsx` — the REAL Condition Center components, mounted by the Long-Term screen | RTL → LT | *"the same look of the Condition Center … the way you preview stuff, the way you preview the PDFs, the way you drag and drop, accept, reject, preview, download, and delete"*, and, in the same conversation, *"this is not a redesign … I like the design that we have on the long-term side. Don't change the design. Stick with the design and with the fonts."* So the COMPONENTS are shared and the PAGE is not: the gates, the three-number summary, the white boxes and the fonts stay Long-Term's own. Each of these takes its I/O as function props and imports no API client, which is what makes them mountable as they stand; **not one was changed to make Long-Term fit** — the row-shape translation lives on the Long-Term side, because renaming a field inside a shared component would silently change what the live short-term product reads | this PR |
| 2026-08-30 | `import app-v2/src/lib/upload-progress.js` — the one record of what is uploading right now | RTL → LT | The same grant. `UploadRows` renders only what this store holds, and only the short-term transport published into it — so a Long-Term upload would have rendered NOTHING while it ran and read as *"it is not uploading"*, the exact defect the owner reported on the short-term side on 2026-08-23. The store and its `uploadTarget()` are product-neutral; Long-Term's own transport publishes the same start/update/finish calls, so it is one bar rather than two mechanisms to keep in step | this PR |
| 2026-08-30 | `rtl-import src/lib/sharepoint-backup.js` — the ONE SharePoint mirror asks the Long-Term side where an lt_loan keeps its officer / borrower / property (`src/longterm/sharepoint-scope.js`: SQL fragments + one pure predicate, no mirror logic). Required through a try/catch, so RTL keeps mirroring if the side build is absent | LT → RTL | *"Same thing is with SharePoint: you need to share the code."* … *"the SharePoint looks for the same exact folder, same exact logic that we build up on the short-term side"* | this PR |
| 2026-08-30 | `import src/lib/order-email.js` — the order letter, one definition for both products | RTL → LT | *"Everything should share the code, so we don't need to rewrite the code. We are just sharing the code. If the code is updated, he's also updating it."* | #1376 |
| 2026-08-30 | `import src/lib/inbound-mail.js` — reading an inbound message (retrieval, attachments, sender authentication, auto-responder detection), extracted from `src/lib/file-inbox.js`, which re-exports it | RTL → LT | *"You need to make sure you're not copying the information. You're just using the information from the short-term side."* The vendor reply that carries a long-term order's documents has to be read the same way the short-term one is | #1376 |
| 2026-08-30 | `import src/lib/resend-webhook.js` — the inbound webhook signature check | RTL → LT | The same message arrives on the same domain through the same webhook; one signing secret, one verification. A second copy of a signature verifier is the duplication that must never exist | #1376 |
| 2026-08-30 | `import src/lib/email/index.js` — the mail sender | RTL → LT | *"make sure all the orders are coming from the user that is actually ordering, from his email, from his name"* — sending the order IS the order. One account, one From identity, one deliverability posture. **Recorded explicitly: the shared outbound rate budget reaches the RTL pool (db/619), because there is one Resend ceiling and two budgets would burst it. No loan data crosses, and Long-Term sends with `_skipCapture` so the short-term Email Center is never written** | #1376 |
| 2026-08-30 | `import src/lib/storage.js` + `import src/lib/upload-bytes.js` + `import src/lib/order-return-filter.js` — where a returned document's bytes go, what the bytes actually are, and the email-signature filter | RTL → LT | *"You need to make sure you're not copying the information. You're just using the information from the short-term side."* A second storage layer is a second place a document is lost; a second sniffer is a second answer to "is this a PDF"; a second signature filter means re-living the months of rejecting company logos by hand | #1376 |
| 2026-08-30 | `import src/lib/vendor-directory.js` — the PURE half only: how a vendor card's addresses and phones are read | RTL → LT | The same directory is shared, so the same reading of it must be. db/224's `email` scalar + `emails` array pair drops addresses when either is read alone. **`suggest()` is off limits** — it reaches the short-term pool; Long-Term queries `service_contacts` on its own pool and folds with these helpers | #1376 |
| 2026-08-30 | **Not a crossing — recorded for the record.** The Long-Term term sheet's property-address box calls the shared `/api/address/*` proxy | neither | *"The property address should be linked with the Find My Property address to autofill the property address from the short-term site. You can use the same credentials."* — a top-level, product-neutral vendor-key proxy serving the marketing site and both portals, holding no loan data and reading no RTL table. Same class as the shared login token. **No RTL module is imported**, so no `authorized` line is needed or added | #1383 |
| 2026-08-30 | `import src/lib/email/reply-cut.js` — where a person's own reply ends and the quoted history begins | RTL → LT | The order letter prints the SHARED reply marker; this is the reader that cuts on it. Two halves of one mechanism — a second copy files the vendor's whole thread on the loan every round |  #1376 |
| 2026-08-30 | `import src/lib/send-as.js` — who an order comes from | RTL → LT | *"make sure all the orders are coming from the user that is actually ordering, from his email, from his name."* One company identity, one verified sending domain, one answer to whether an address may go in a From line — the rule is DKIM alignment, not a preference. The short-term desk is deliberately NOT switched over; that is the owner's call | #1376 |
| 2026-08-30 | `import src/lib/integrations/docusign.js` — the DocuSign transport (envelope create, void, status, documents, the Connect HMAC) | RTL → LT | *"it can go by DocuSign, as an email attachment, or both"* on the long-term verification of rent. One DocuSign account, one integration key, one JWT consent, one token cache, one Connect HMAC — a second client would mint a second JWT against the same rate-limited endpoint and be a second copy of a signature verifier. **The transport only: the module's own header says it does not decide when to send, own the send-once claim or clear a condition — Long-Term builds all of that in `src/longterm/vor/**` against its own `lt_vor_*` tables. The shared Connect webhook carries a long-term claim in front of the RTL route, because the RTL drainer answers an envelope it does not own with `skipped: 'untracked'` and would have swallowed the landlord's signature** | #1376 |
| 2026-08-30 | `import src/lib/email/{template,quote}.js` — the one branded email | RTL → LT | *"it should have the same feel … the same Gmail-style box"* | #1376 |
| 2026-08-30 | `import src/lib/file-address.js` — the unique per-order reply address | RTL → LT | *"Everything should share the code … If the code is updated, he's also updating it."* | #1376 |
| 2026-08-30 | `sql-ref` / `sql-read` / `sql-write service_contacts` — the shared vendor directory | RTL ↔ LT | *"You need to make sure you're not copying the information. You're just using the information from the short-term side."* | #1376 |
| 2026-08-03 | `sql-ref borrowers` + `sql-read borrowers` — one person record, read by Long-Term | RTL → LT | *"same borrower record … all the borrowers should be able to see all their files even if its long term or short term"* | #975 |
| 2026-08-03 | `sql-ref staff_users` + `sql-read staff_users` — a Long-Term file knows its officer | RTL → LT | *"officers should be able to see all of their files even if it's long term or short term"* (an officer can only see their Long-Term files if a Long-Term file records its officer, and officers are the same accounts as the shared login) | #975 |
| 2026-08-03 | `import app-v2/src/components/BorrowerProfilePanel.jsx` — the ONE shared borrower editor, mounted on a long-term file | RTL → LT | *"officers should be able to change the borrower profile on long term files"* — confirmed in the same breath as *"keep borrower read only"*, so the edit goes through the existing shared editor and the existing borrower endpoint; Long-Term code still never writes `borrowers` | #975 |
| 2026-08-03 | `sql-ref borrower_officers` + `sql-write borrower_officers` — Long-Term records the officer↔person link | RTL → LT | Required to make the line above actually work: a non-privileged officer may only open a borrower profile they have a recorded relationship to, and today that means an **RTL** file. `borrower_officers` (db/327) is the identity-zone link built for precisely this — *"the client who has only ever done non-RTL business with them, so there is no file to match on"* | #975 |
| 2026-08-14 | `rtl-import app-v2/src/App.jsx` + `rtl-import app-v2/src/components/StaffLayout.jsx` — the FRONT-END mount seam: the router mounts the Long-Term screens, and the staff shell renders the Short-Term / Long-Term switch | LT → RTL | *"You were authorized to touch that switch of the short-term shell."* Asked directly, because rule 5 forbids touching RTL to make LT work and the switch cannot exist without it. Deliberately as narrow as the back-end seam (`src/server.js`): these two files may reference LT code ONLY to mount it and to render the switch — no RTL screen may import an LT component for its own use, and no LT logic may move into a shared file | this PR |
| 2026-08-17 | `rtl-import app-v2/src/screens/Dashboard.jsx` — the borrower's HOME SCREEN renders the Short-Term / Long-Term switch | LT → RTL | *"put the switch on the borrower's home screen"* — answering a direct question that named the cost: the client's long-term page was already built and routed at `/long-term`, and moving its entry point onto the borrower dashboard makes an RTL screen reference LT code, which the 2026-08-14 seam permits only per file, in writing. Scoped exactly as narrowly as the staff shell: this file imports ONE component (`BorrowerLongTermSwitch`) and renders it — no LT logic, no LT data read, no second LT import. Whether there is anything to switch TO is decided on the Long-Term side, so the RTL screen never carries that rule | this PR |
| 2026-08-16 | `import src/lib/address-canon.js` — ZIP → city/state/county/county-FIPS lookup for the Long-Term DSCR pricer | RTL → LT | *"Yes, you have my written OK to reuse that."* Asked as one specific question: the vendor's own screen turns a ZIP into the full location before pricing, while our connector required the caller to supply the county FIPS and refused an incomplete location. Scoped to this one module used as a READ-ONLY lookup — NOT the RTL address writers, and Long-Term still rewrites no RTL address record. **CORRECTION (2026-08-16, same day): the authorized module was ultimately NOT used.** It returns a county NAME with no FIPS, refuses a bare ZIP (it is built for a full street address), and needs a `DATABASE_URL` — none of which suits a pure pricing path, and the owner separately corrected the premise: the screen is ZIP-driven, no street address is involved. The shipped answer is `src/longterm/lenderprice/zip-county.js` + a committed Census ZCTA table — LT-only, so not a crossing at all. The permission stands and is recorded here as granted, not as a description of the shipment | #1220 |
| 2026-08-30 | `import src/lib/email/index.js` — the company's one email TRANSPORT, so Long-Term's rate-movement reports send from the same identity as everything else | RTL → LT | *"Yes I'm giving you a written authorization to use the sender credentials from the short-term side. Send it out from lock desk @ YS Capital Whatever. Basically that should be the idea but follow the resend credentials."* Asked as one specific question, naming the cost: Long-Term has no mailer, and a second sender on the company's own domain damages the domain's own deliverability — a sending identity is a fact about the COMPANY, the same reasoning that authorized the ClickUp workspace on 2026-08-23. Scoped to the TRANSPORT only: no `notify.js`, no `catalog.js`, no `template.js`, no digests, no in-app rows, no `notifications` table — Long-Term renders its own bodies and hands over a finished message. **AUTHORIZED, NOT YET USED** — the reports are Phase 2 and are not built; recorded now so the authorization lives in the ledger rather than in a chat message | this PR |
| 2026-08-30 | `import app-v2/src/components/FileOverviewSlideOver.jsx` — the long-term file screen opens its overview in the ONE shared slide-over, behind a button, instead of an always-on right-hand rail | RTL → LT | *"Right now, the file overview is always displaying on the right side. We want to go and do the same thing that we have on the short term side, where we have a file overview button. It should be the same feel."* — and, governing the whole instruction, *"You need to make sure you're not copying the information. You're just using the information from the short-term side … Everything should share the code, so we don't need to rewrite the code … If the code is updated, he's also updating it."* Scoped to this ONE component, which is product-neutral by construction (it takes a `fetcher` and renders whatever `{header, sections[]}` it resolves) and is already mounted on three RTL surfaces with three different fetchers; Long-Term is the fourth caller and supplies its own payload, so the audience boundary stays with the caller. NOT a licence for any other RTL file-screen component | this PR |
| 2026-08-14 | **The Encompass integration — brought into Long-Term as a self-contained BY-VALUE copy** (logic, authorization, requests, credentials mechanism, field map). Lives entirely in `src/longterm/encompass/**`. | RTL → LT | *"Pull in and copy: the logic of Encompass integration, the credentials of Encompass integration, the requests, the authorization. We need to start long-term loans with a full Encompass understanding … take also all the fields from this mapping and bring it in."* This is a specific, owner-directed exception to the 2026-08-03 "no shared integrations" line below (Encompass only; everything else still stays separate). | this PR |

### Note on the Encompass copy (2026-08-14)

This is a **by-value copy**, not an import — so it needs **no machine-readable `authorized`
entry above**: the Long-Term Encompass code (`src/longterm/encompass/**`) imports **zero** RTL
modules and reaches **no** RTL table. It is fully self-contained (its own config, its own pacing,
its own read-only client), which keeps the two products separate exactly as the charter requires.
What was brought in: the read-only OAuth client + request logic (`client.js`), the request /
authorization catalog (`requests.js`), the Milestone Completion rules + field requirements
(`completion-rules.js`), and the RTL reconciliation field map, kept as **reference and clearly
labeled as RTL usage** (`reconciliation-map.js`). No secret credential VALUES are in code — only
env-var names (`LT_ENCOMPASS_*`, falling back to the shared `ENCOMPASS_*`). Long-Term's Encompass
connection is **READ-ONLY** and has **no** flood/write path (that one owner-authorized Encompass
write stays RTL-only). None of this knowledge is enforced — it is memory for the build.

**That is the whole list.** The owner's same sentence closed everything else: *"keep it separate everything else …
the back end of the entire thing will be different, the workflow will be different, the sets will be different,
integrations will be different, it will be a brand new build. Don't assume anything that we're building on one
thing to build that also on the other thing — it's totally separate."*
| 2026-08-30 | The **PILOT term-sheet DESIGN and the YS Capital lockup**, copied BY VALUE into `src/longterm/termsheet/brand.js` + `src/longterm/termsheet/assets/pilot-lockup-light.png` | RTL → LT | *"Everything should be in our pilot branding the same way our RTL term sheet is. Follow the same kind of design that our RTL term sheet have … Look at the design we have on the RTL. Try to bring in that nice pilot design … Make sure to include our logos and our designs."* **What crossed is the DESIGN**: the palette (`INK` / `TEAL` / `GOLD` / `LINE` / ivory), the header-band geometry (a 76pt full-bleed ink band, a 2.2pt gold rule, the lockup 30pt tall at the left margin), the teal section band with its gold tab, the ivory accent row, the three-line footer, and the SHAPE of a disclosures page — each value read off `web/v2/tools/termsheet.js`'s own `header()` / `band()` / `rowIn` / `footer()` / `disclosuresPage()`. **NOT ONE LINE OF RTL LOGIC CROSSED, and it may not**: that file is a FROZEN RTL pricing engine, so requiring it would put a frozen engine on Long-Term's render path and break rule 4 outright. The lockup is the same PNG the RTL sheet embeds (`web/v2/tools/rb-logo.js`), extracted to its own asset so Long-Term reads no RTL file at runtime. The disclosure TEXT is deliberately NOT copied — the RTL page describes a business-purpose bridge loan (minimum earned interest, a deferred origination fee at exit, construction draws) and a 30-year DSCR rental loan has none of those, so copying it would put terms on the document that are not terms of the loan | this PR |

| 2026-08-30 | **THE SHARE-THE-CODE DIRECTIVE** — the owner ordered the parallel Long-Term build deleted and the RTL implementations SHARED: the Condition Center (conditions UI + document upload / drag-and-drop / preview / accept / reject / download / delete), the Orders center (the Gmail box, drafts, AI, reply routing, CC settings, DocuSign design), FileContacts + the vendor setup, the entity/LLC logic linked to the shared profile, SharePoint syncing, and the Cloudflare/off-site backup. The full quoted authorization + the boundary of what stays split is `docs/longterm/SHARE-THE-CODE-DIRECTIVE.md`; each concrete `import` line is added to the authorized block in the same PR that lands it, under this grant | RTL → LT | *"I gave you written authorization to bring that exact Condition Center over here. Take that exact Condition Center and make your conditions in that Condition Center follow those rules."* … *"The same thing with Order Center: you need to share the code. Same thing is with SharePoint: you need to share the code."* … *"Every single thing that you're building, you first need to look if you can share the code somewhere else without rebuilding everything."* | this PR |

## Log of things we ASKED for and were told NO / not yet

Keeping the refusals is as important as keeping the approvals — it stops the same question being re-asked and
stops a "no" quietly turning into a "yes" months later.

| Date | What was asked | Answer |
|---|---|---|
| 2026-08-02 | Conditions, document underwriting, and orders for Long-Term | **Not for now** — "we're not going to build conditions we're not going to bring in document underwriting we're not going to bring in orders for now". ⟶ **CONDITIONS were REVERSED by the owner on 2026-08-14** — *"you should set up your DSCR condition center — it should pull the conditions directly from Encompass"* and *"We should build a condition center … with all the documents in there linked"*. See CLAUDE.md rule 6 and the charter §4. **This is a SCOPE change, not a separation change**: the LT condition center is a brand-new build, so re-using ANY of RTL's `checklist_templates` / `checklist_items` / `conditions` / `src/lib/conditions/**` / document + eFolder code still needs its own row in the approvals log above. **Document underwriting remains NO. ORDERS were REVERSED by the owner on 2026-08-30** — the whole Orders directive (title / insurance / flood / settlement agent / VOR / condo questionnaire, with the owner's own drafts) and then, same day, the share-the-code order: *"The same thing with Order Center: you need to share the code."* |
| 2026-08-02 | New columns / new field mappings anywhere for Long-Term | **No** — "don't add any columns don't add any mapping unless we specifically ask you to" |
| 2026-08-02 | Sharing the database connection pool (`src/db.js`) with Long-Term | **Not asked yet** — until it is, Long-Term opens its own pool in `src/longterm/db.js`, which needs no authorization (open question 11 in the charter) |
| 2026-08-03 | **Long-Term WRITING the borrower record** (`sql-write borrowers`) | **No — confirmed by the owner: "keep borrower read only".** An officer CAN change a borrower profile from a long-term file, but through the ONE shared editor and the existing borrower endpoint — not through Long-Term write code. The person record keeps a single owner, which matters because a dozen RTL modules already heal, enrich and de-duplicate it (Encompass enrich, ClickUp sync, credit store, name-heal, merge). |
| 2026-08-03 | Long-Term re-using RTL's **workflow, statuses, document sets, conditions or integrations** | **No — explicitly.** *"the workflow will be different, the sets will be different, integrations will be different, it will be a brand new build."* **EXCEPTION (2026-08-14): the Encompass integration was later authorized to be brought into Long-Term** (see the log row above). That exception was Encompass-only at the time. **Since then the owner authorized, by name: ClickUp (2026-08-23, the writer's inheritance below), DocuSign + the mail sender (2026-08-30, #1376 rows above), and — 2026-08-30, the share-the-code directive — SharePoint syncing and the Cloudflare/off-site backup: *"Same thing is with SharePoint: you need to share the code."* Sitewire and Trustpoint remain separate (draw management is not an LT feature).** |

# ---------------------------------------------------------------------------
# THE CLICKUP WRITER'S INHERITANCE — authorized in writing by the owner,
# 2026-08-23, before any of it is copied:
#
#   "for the click-up syncing, we put in a lot of hours and effort to make sure
#    the RTL side works perfectly and a lot of guards are in place ... Bring over
#    that logic over here ... Use all the logic from there, all the mapping from
#    here, and all the requests from there. You can bring everything over and use
#    what we need."
#
# and, same day, on the shape of the tie itself:
#
#   "please use the same kind of logic that we're using on the RTL side, where
#    everything is stamped in pilot and everything is stamped and clicked up and
#    holding them together tied."
#
# WHAT THIS AUTHORIZES: copying the RTL ClickUp machinery's PROVEN logic into
# src/longterm/clickup/** as the Long-Term field writer is built — the date rule
# (4 AM America/New_York epochs, round-trip asserted), the chokepoint guards
# (no deletion, no field clearing, allowlisted task updates), read-before-write
# with no-op suppression, the write journal, the overwrite storm alarm and the
# volume circuit breaker, the dropdown read/write asymmetry, and the per-field
# type transforms. Each file copied under this authorization still gets its own
# entry here naming source and destination, per the standing rule — this block
# is the owner's sanction those entries cite, not a blanket import license.
# LT copies stay copies: no LT file imports RTL logic modules directly.
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# FILES COPIED UNDER THE CLICKUP WRITER'S INHERITANCE (owner, 2026-08-23 — the
# sanction quoted above). BY-VALUE copies: each destination imports ZERO RTL
# logic modules and touches NO RTL table, so none of these is a machine-read
# `import` entry (the Encompass-copy precedent, 2026-08-14). One line per file,
# source -> destination, added in the same PR as the copy (2026-08-24):
#
#   copy src/clickup/transforms.js   -> src/longterm/clickup/transforms.js
#        (the 4AM America/New_York date rule + round-trip assert, dropdown
#         read/write asymmetry, money/phone/marital transforms, placeholder +
#         shadow-email + loan-number sentinels, SSN masking. LT additions: the
#         US 'MM/DD/YYYY' parse and Encompass's '//' unreached-date convention.
#         The RTL-only card-line and marital-AI hooks did NOT cross.)
#   copy src/clickup/client.js       -> src/longterm/clickup/writer-client.js
#        (the wire chokepoint guards: no task deletion — v2 AND v3 — no field
#         clearing incl. the nested-null JSON class, status-only task updates,
#         the retry/idempotency contract, value-free errors. MINUS the RTL
#         assignment-clear carve-out — the LT writer clears NOTHING, ever —
#         and MINUS the shared lib/api-rate-limit bucket: LT self-paces.)
#   copy src/clickup/registry.js     -> src/longterm/clickup/registry.js
#        (the live dropdown option map, 10-min TTL — dropdowns READ orderindex
#         ints and WRITE option UUIDs, and the UUIDs churn, so write-ids are
#         resolved live, never hardcoded.)
#   copy src/clickup/mapper.js       -> src/longterm/clickup/mapper.js
#        (writeValue per type, isBlankClickupValue, the addressField finite-
#         coordinate refusal, fieldValueEquivalent per-type no-op suppression,
#         resolveOnly, the DOB-change detector, the PII-shield/review-key
#         shape. The FIELD MAP DATA is Long-Term's own — every ClickUp id read
#         off the live catalog, every Encompass id live-verified 2026-08-24.
#         LT departure, SAFER: locations are fill-only, never rewritten, so
#         the RTL address comparator was not needed and did not cross.)
#   copy src/clickup/orchestrator.js -> src/longterm/clickup/push.js
#        (read-before-write with fail-closed scoped pushes, no-op suppression,
#         the PII overwrite shield + review queue, fill-only mode, the write
#         journal, the volume circuit breaker + boot seed, the overwrite-storm
#         alarm, push-failure accounting — a lossy push is never marked done —
#         and the create-then-link flow. Journal/review/breaker state lives in
#         LT's OWN tables (db/625) — never RTL's.)
#
# The queue-dedupe shape in db/625's lt_clickup_review_queue open-row partial
# unique index follows src/lib/sync-review.js's dedupe design (one open row
# per task+field+proposal) — recorded here since the shape, not the text, was
# reused. src/lib/address.js was NOT copied and is NOT imported: the fill-only
# location posture removed the need.
#
# PURPOSE NOTE for the existing `import src/lib/address-canon.js` grant
# (pre-merge audit 2026-08-24): src/longterm/clickup/push.js reads
# addressCanon.geocode() to resolve coordinates for the two ClickUp LOCATION
# fields (a ClickUp location write requires real lat/lng). That is a READ of
# the shared geocoder whose own permanent cache (address_canon_cache) it fills
# as designed — the same behavior every RTL caller gets. The 2026-08-16 grant
# above was worded for the DSCR pricer's ZIP lookup; this records the writer's
# use of the SAME authorized import for geocoding, so the per-item rule stays
# honest. No RTL address RECORD is read or written — only the geocode cache.
# ---------------------------------------------------------------------------
