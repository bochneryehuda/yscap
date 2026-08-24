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

Lines starting with `#` are comments. Everything else must match one of the five kinds exactly.

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
```

## Log of authorizations

| Date | Kind + item | Direction | The owner's words | PR |
|---|---|---|---|---|
| 2026-08-03 | `import src/auth/index.js` — one login for both products | RTL → LT | *"same login same borrower record, keep it separate everything else"* | #975 |
| 2026-08-03 | `sql-ref borrowers` + `sql-read borrowers` — one person record, read by Long-Term | RTL → LT | *"same borrower record … all the borrowers should be able to see all their files even if its long term or short term"* | #975 |
| 2026-08-03 | `sql-ref staff_users` + `sql-read staff_users` — a Long-Term file knows its officer | RTL → LT | *"officers should be able to see all of their files even if it's long term or short term"* (an officer can only see their Long-Term files if a Long-Term file records its officer, and officers are the same accounts as the shared login) | #975 |
| 2026-08-03 | `import app-v2/src/components/BorrowerProfilePanel.jsx` — the ONE shared borrower editor, mounted on a long-term file | RTL → LT | *"officers should be able to change the borrower profile on long term files"* — confirmed in the same breath as *"keep borrower read only"*, so the edit goes through the existing shared editor and the existing borrower endpoint; Long-Term code still never writes `borrowers` | #975 |
| 2026-08-03 | `sql-ref borrower_officers` + `sql-write borrower_officers` — Long-Term records the officer↔person link | RTL → LT | Required to make the line above actually work: a non-privileged officer may only open a borrower profile they have a recorded relationship to, and today that means an **RTL** file. `borrower_officers` (db/327) is the identity-zone link built for precisely this — *"the client who has only ever done non-RTL business with them, so there is no file to match on"* | #975 |
| 2026-08-14 | `rtl-import app-v2/src/App.jsx` + `rtl-import app-v2/src/components/StaffLayout.jsx` — the FRONT-END mount seam: the router mounts the Long-Term screens, and the staff shell renders the Short-Term / Long-Term switch | LT → RTL | *"You were authorized to touch that switch of the short-term shell."* Asked directly, because rule 5 forbids touching RTL to make LT work and the switch cannot exist without it. Deliberately as narrow as the back-end seam (`src/server.js`): these two files may reference LT code ONLY to mount it and to render the switch — no RTL screen may import an LT component for its own use, and no LT logic may move into a shared file | this PR |
| 2026-08-17 | `rtl-import app-v2/src/screens/Dashboard.jsx` — the borrower's HOME SCREEN renders the Short-Term / Long-Term switch | LT → RTL | *"put the switch on the borrower's home screen"* — answering a direct question that named the cost: the client's long-term page was already built and routed at `/long-term`, and moving its entry point onto the borrower dashboard makes an RTL screen reference LT code, which the 2026-08-14 seam permits only per file, in writing. Scoped exactly as narrowly as the staff shell: this file imports ONE component (`BorrowerLongTermSwitch`) and renders it — no LT logic, no LT data read, no second LT import. Whether there is anything to switch TO is decided on the Long-Term side, so the RTL screen never carries that rule | this PR |
| 2026-08-16 | `import src/lib/address-canon.js` — ZIP → city/state/county/county-FIPS lookup for the Long-Term DSCR pricer | RTL → LT | *"Yes, you have my written OK to reuse that."* Asked as one specific question: the vendor's own screen turns a ZIP into the full location before pricing, while our connector required the caller to supply the county FIPS and refused an incomplete location. Scoped to this one module used as a READ-ONLY lookup — NOT the RTL address writers, and Long-Term still rewrites no RTL address record. **CORRECTION (2026-08-16, same day): the authorized module was ultimately NOT used.** It returns a county NAME with no FIPS, refuses a bare ZIP (it is built for a full street address), and needs a `DATABASE_URL` — none of which suits a pure pricing path, and the owner separately corrected the premise: the screen is ZIP-driven, no street address is involved. The shipped answer is `src/longterm/lenderprice/zip-county.js` + a committed Census ZCTA table — LT-only, so not a crossing at all. The permission stands and is recorded here as granted, not as a description of the shipment | #1220 |
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

## Log of things we ASKED for and were told NO / not yet

Keeping the refusals is as important as keeping the approvals — it stops the same question being re-asked and
stops a "no" quietly turning into a "yes" months later.

| Date | What was asked | Answer |
|---|---|---|
| 2026-08-02 | Conditions, document underwriting, and orders for Long-Term | **Not for now** — "we're not going to build conditions we're not going to bring in document underwriting we're not going to bring in orders for now". ⟶ **CONDITIONS were REVERSED by the owner on 2026-08-14** — *"you should set up your DSCR condition center — it should pull the conditions directly from Encompass"* and *"We should build a condition center … with all the documents in there linked"*. See CLAUDE.md rule 6 and the charter §4. **This is a SCOPE change, not a separation change**: the LT condition center is a brand-new build, so re-using ANY of RTL's `checklist_templates` / `checklist_items` / `conditions` / `src/lib/conditions/**` / document + eFolder code still needs its own row in the approvals log above. **Document underwriting and orders remain NO.** |
| 2026-08-02 | New columns / new field mappings anywhere for Long-Term | **No** — "don't add any columns don't add any mapping unless we specifically ask you to" |
| 2026-08-02 | Sharing the database connection pool (`src/db.js`) with Long-Term | **Not asked yet** — until it is, Long-Term opens its own pool in `src/longterm/db.js`, which needs no authorization (open question 11 in the charter) |
| 2026-08-03 | **Long-Term WRITING the borrower record** (`sql-write borrowers`) | **No — confirmed by the owner: "keep borrower read only".** An officer CAN change a borrower profile from a long-term file, but through the ONE shared editor and the existing borrower endpoint — not through Long-Term write code. The person record keeps a single owner, which matters because a dozen RTL modules already heal, enrich and de-duplicate it (Encompass enrich, ClickUp sync, credit store, name-heal, merge). |
| 2026-08-03 | Long-Term re-using RTL's **workflow, statuses, document sets, conditions or integrations** | **No — explicitly.** *"the workflow will be different, the sets will be different, integrations will be different, it will be a brand new build."* **EXCEPTION (2026-08-14): the Encompass integration was later authorized to be brought into Long-Term** (see the log row above). That exception is Encompass-only; every other integration (ClickUp, SharePoint, DocuSign, Sitewire, Trustpoint) still stays separate unless the owner authorizes it by name. |

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
# ---------------------------------------------------------------------------
