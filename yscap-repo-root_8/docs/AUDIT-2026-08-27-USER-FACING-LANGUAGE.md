# User-Facing Language Audit — internal/developer copy shown to users

**Date:** 2026-08-27 · **Scope:** every rendered string in the product — 388 files across the long-term side, the short-term (RTL) side, shared components, borrower/TPO/public screens, all email and notification bodies, server-composed `why`/`note`/`hint` fields, and the `db/` condition wording. Read end-to-end, nothing sampled.

**Status: AUDIT ONLY. No code was changed.** The owner asked for a full sweep and a report, and stated he will approve which groups to fix. Owner report published as an artifact; this file is the line-by-line backing list.

**Result:** 589 findings, 54 of them serious, across 388 files. 52 files came back completely clean.

---

## Why this happened

The codebase follows a good rule — never show a blank without saying why. The rule was followed everywhere. The failure is that the "why" was written in engineer's language, and there is no single place that owns how PILOT speaks, so all 589 sentences were hand-written at the point of use.

**The pattern that leaked:** long explanatory prose, which is correct and valuable in code comments and in `CLAUDE.md` rules, was promoted verbatim into rendered props (`note=`, `hint=`, `title=`, JSX text) and into server-composed `why` / `note` / `historyNote` fields.

---

## Category letters used throughout

| | Category |
|---|---|
| **A** | Plumbing lecture — where data comes from, read/write mechanics |
| **B** | Read-only lecture |
| **C** | Build narration — rollout state, "when X goes live", what is/isn't wired up |
| **D** | Jargon leak — payload, GUID, webhook, rows, soft-delete, env var names, vendor dashboards |
| **E** | Over-explaining / apologetic hedging |
| **F** | System first-person — "what PILOT watched", "our permissions", "we never guess" |

**Severity:** H = clearly internal/unprofessional or wrong-audience leak · M = wrong tone/over-long · L = borderline.

---

## The two lines the owner quoted

| # | Quote | Location |
|---|---|---|
| 1 | "Read from Encompass. Nothing here is editable — the long-term side reads Encompass and never writes to it." | `app-v2/src/longterm/LtLoan.jsx:891-894` — prepended to **every** application section body (Borrowers, Property, Terms, Income, Assets, REO, Declarations, Investor). Variants at `LtLoan.jsx:902-905` and `LtConditionCenter.jsx:311-314`. |
| 2 | "What PILOT watched change between two reads — not Encompass's own milestone log, which our permissions do not reach." | `app-v2/src/longterm/LtFileSections.jsx:698`. **Server-side sibling** at `src/longterm/locks.js:406-407` (`historyNote`), stamped onto every rate-lock panel — one edit fixes every screen. |

---

## Findings by area

Detail for each area is in the sections below. Counts:

| Area | Files | Findings | Serious |
|---|---:|---:|---:|
| Staff screens F–Z | 33 | 133 | 17 |
| Shared components A–F | 67 | 98 | 13 |
| Staff screens A–E | 32 | 95 | 4 |
| Long-term front end | 31 | 78 | 10 |
| Shared components G–Z + arena + track-record | 70 | 74 | 4 |
| Emails & notifications | 46 | 38 | 2 |
| Long-term back end | ~40 | 38 | 4 |
| RTL back end + `db/` + public site | ~40 | 23 | 0 |
| Borrower / TPO / public screens | 29 | 12 | 0 |
| **Total** | **388** | **589** | **54** |

**Long-term side** (`src/longterm/**` + `app-v2/src/longterm/**`): 116 findings, 14 serious.
**Short-term side** (everything else): 473 findings, 40 serious.

---

## Confirmed non-wording defects

1. **`app-v2/src/screens/StaffCompanyPricing.jsx:441-442`** — renders literal template code to admins: `A general file is ${fmtMoney(lf.underwriting)} + ${fmtMoney(lf.legal)} = ${fmtMoney(lfTotal)}.` The JSX brace escapes emit the `${...}` text verbatim; `fmtMoney` and `lfTotal` are defined nowhere in the file (grep-verified: they appear only on line 442).
2. **`app-v2/src/longterm/LtPpe.jsx:300-303`** — renders a source-file path in the UI: `src/longterm/ppe/README.md`.
3. **Raw data dumps on five screens** — `ActivityFeed.jsx:97`, `AppraisalOrderSection.jsx:3849/3715/3722`, `DrawsPanel.jsx:1211-1213`, `StaffApplication.jsx:1836`, `StaffClickup.jsx` (`match_detail`).
4. **`DashboardCard.jsx:261-263`** — a "Show the exact query" control revealing raw SQL in a `<pre>` on a staff dashboard.

**Six internal key names printed on screen:** `DOCUSIGN_SEND_ENABLED` (`DrawsPanel.jsx:706`, inside a `<code>` tag), `AZURE_DOCAI_LABEL_SAS_TOKEN` / `AZURE_DOCINT_CLASSIFIER_ID` (`StaffLabelingConsole.jsx:118/125`), `USPS_CLIENT_ID` / `USPS_CLIENT_SECRET` (`UspsAddressVerification.jsx:269`), `LT_CLICKUP_WRITE_ENABLED` (LT refusals). The hosting provider is named to staff in four places.

---

## Audience verification

**Investor / note-buyer names never reach a client — VERIFIED, holds.** All 29 borrower/TPO/public screens read end-to-end plus a grep sweep of every `borrower_label` / `borrower_hint` across all 63 hint-bearing migrations. Zero live leaks. The one historical seed (`db/005:89`) was already remediated by `db/012` + `058`/`070`/`533`.

**Client-visible findings: ~38, of which 2 serious.**

- `[H]` `LlcManager.jsx:266-271` (borrower portal) — "We have this entity down as an LLC because that is what almost every entity here is — nobody has confirmed it."
- `[H]` `AppraisalPanel.jsx:1700` (ungated, borrower + staff) — "The As-Is figure was read from the report's narrative — PILOT opens a task for an officer to confirm it rather than guess."

The remaining ~36 are minor and listed in the per-area sections.

**Reaches client paperwork:** `web/v2/termsheet.js:3060-3065` PROV_COPY stamps ("Generated from an active loan file — Products & Pricing") and `:3374` ("Effective purchase price (admin exception)") print internal screen names on the signable PDF. `web/v2/loan-application.html:980,990-991` exposes a visible "Admin mode" panel that speaks about "the borrower" in third person on the borrower's own page.

---

## Recommended restructure

1. **Write the house rule down once** (add to `CLAUDE.md`). Every rendered line must pass: *say what is true, say what to do, stop.* Never name the source system, never narrate what PILOT did/tried/read/was not permitted to do, never explain build state, never give setup instructions to someone who cannot perform them. This is the only prevention; everything else is cleanup.

2. **One translation layer instead of 589 hand-written sentences.** The working model already exists in-repo: `EncompassSyncPanel.jsx`'s `plainReason()` maps machine reason codes to plain sentences. Standardise on it — server emits a code, one shared module owns the wording. After that, changing PILOT's voice is one file.

3. **Fix at the source, not the screen.** ~12 server strings account for 100+ screen appearances: `locks.js:406` (every lock panel), `read-state.js:36-37` (rail + pipeline chip + panel), `db/354:48-53` (every file's appraisal condition), `unsourced.js` flood-zone/rent/ARM/acquisition, `milestones.js:126/130`, `people/contacts.js:254-257`, `routes/encompass-file.js:59-61`. Do these before touching individual screens.

4. **Name the screens allowed to speak about the machine** — sync review, API health, the Encompass and ClickUp panels, `LtSync`, the document-training console. System language is legitimate there because it *is* the subject. Everywhere else it is banned. Tighten those screens too, but they are not the emergency.

---

## Approval groups (as presented to the owner)

| # | Group | Places | Side | Recommendation |
|---|---|---:|---|---|
| 1 | The two quoted lines and their family | ~25 | Both | Yes, first |
| 2 | Setup instructions + internal key names | ~24 | Short-term | Yes |
| 3 | The four real defects | 4 | Both | Yes — #1 regardless |
| 4 | Server-side "why is this blank" notes | ~35 sentences / 100+ appearances | Both | Yes — best value |
| 5 | Emails leaving the company | 5 | Short-term | Yes |
| 6 | Build/rollout narration | ~20 | Both | Yes, except the owner-approved one |
| 7 | Everything a client or broker can see | ~38 | Short-term | Yes; move the 2 serious into group 1 |
| 8 | The `[auto]` tag on condition notes | ~13 | Short-term | Yes — keep stored, hide from display |
| 9 | Long tail of staff wording | ~425 | Both | Approve the approach, not a deadline |

---

## Owner decisions required

1. **`web/v2/disclosures.html`** still states "Every program carries a minimum earned-interest provision of three months." This contradicts the 2026-07-22 owner-directed toggle rule (OFF by default on Standard/Gold/Silver). Stale legal copy on the public site — **out of scope for this audit, but the most time-sensitive item found.**
2. **Sitewire named to borrowers** (`BorrowerDraws.jsx:380,385,526`). Sitewire *is* the borrowers' own draw portal by design, so this may be intentional. Owner call.
3. **"Shadow test" explainer** (`StaffTrainingProposals.jsx:86`). `CLAUDE.md` records this as owner-directed 2026-07-24. It is build narration by this audit's standard, but it was requested. Owner call.

---

## Exemplars — the house style to copy

- **`EncompassSyncPanel.jsx`** — `plainReason()` translation layer. The structural model for the whole fix.
- **Borrower product emails** — terms-ready, status, draws, e-sign, verdicts, reminders. Near-zero work needed.
- **Recent staff screens** — `StaffCrmDesk`, `StaffEscalations`, `StaffExceptions`, `StaffDashboard(s)`.
- **Borrower-only components** — `ConfirmFoundProperties`, `Entities`, `BorrowerDraws`, `ChangeRequestPanel`.
- **Refusal copy platform-wide** — `staff.js` / `borrower.js` refusals and `signOffGate` messages are consistently professional.

---

# Per-area detail

## Area 1 — Long-term front end (`app-v2/src/longterm`, 31 files, ~11,275 lines) — 10 H

### HIGH
- `LtLoan.jsx:891-894` — owner quote #1, on every application section body. → "Read-only." (or a small "From Encompass" chip)
- `LtLoan.jsx:902-905` — "This loan's headline figures are in File Details, on the right. Nothing here is editable: the long-term side reads Encompass and never writes to it." → "See File Details on the right."
- `LtFileSections.jsx:698` — owner quote #2. → "Milestone changes recorded in PILOT." or drop.
- `LtFileSections.jsx:741-743` — "PILOT has not worked out which sections this loan has yet — that comes with the full read. Nothing here is a statement about the loan itself." → "Full loan details haven't loaded yet."
- `LtConditionCenter.jsx:311-314` — "Read from Encompass. Nothing here is editable — … and filing a document into the eFolder from PILOT is not switched on." → "Read-only."
- `LtConditions.jsx:34-38` — "…since every condition on this Encompass instance sits on a loan that has already closed and been sold." Internal data analysis + "this Encompass instance" on a nav screen. → plain instructions.
- `LtConditions.jsx:39-42` — "It is read-only in both directions: nothing there writes to Encompass, and filing a document into the eFolder from PILOT is not switched on." → drop.
- `LtConditions.jsx:55-57` — "The Condition Center is set aside while the rest of the long-term side is built. Nothing is waiting on it: on this Encompass instance… not one active file has any." → "Coming soon."
- `LtArchive.jsx:71-77` — sync-mechanics lecture. → "Files deleted or archived in Encompass. Deleting here removes them from PILOT permanently."
- `LtPpe.jsx:300-303` — renders `src/longterm/ppe/README.md`. → drop the line.

### MEDIUM (staff unless noted)
- `BorrowerLongTerm.jsx:193-197` **(BORROWER)** "The long-term side of your login is not switched on yet." → "Long-term loans aren't available in your account yet."
- `LtLoan.jsx:879-882` "A person shown as not linked simply has no confirmed match on the People screen yet." → "Link people on the Team screen."
- `LtLoan.jsx:348` "Encompass's milestone ladder has not been read for this loan yet, so no progress is claimed." → "Milestones haven't loaded for this loan yet."
- `LtLoan.jsx:381-384` "This loan's own ladder has not been read from Encompass yet…"
- `LtLoan.jsx:448-449` heading "What PILOT has watched move" → "Milestone history"
- `LtLoan.jsx:454` "first seen at X (a baseline, not an arrival)" → "at X when first recorded"
- `LtLoan.jsx:500-501` heading "What we have watched change" → "Lock history"
- `LtLoan.jsx:703` "The rate lock, and everything we have watched change on it." → "The rate lock and its history."
- `LtLoan.jsx:942-943` "…once it is in Encompass's trash, it leaves PILOT on the next sync." → "…drops off here automatically."
- `LtLoan.jsx:513` `{lock.historyNote}` — server-supplied; fix in `src/longterm/locks.js`.
- `LtFileSections.jsx:169-172` "…not showing anything rather than showing an empty list — an empty list would say there is nothing on this loan." → "This section couldn't be loaded right now."
- `LtFileSections.jsx:226` "The qualifying score is the one Encompass computed — it is read here, never recomputed." → drop.
- `LtFileSections.jsx:406-412` (+ `LtPipeline.jsx:146-152`) "Under the X minimum PILOT ships by default…" → "below the default minimum of X"
- `LtFileSections.jsx:433` "The two figures the ratio rests on are above, so the ratio is not a bare number." → drop.
- `LtFileSections.jsx:669` "(from the pipeline; the application has not been read yet)" → "(preliminary — full details pending)"
- `LtFileSections.jsx:717-724` "What has been read from Encompass" + empty-vs-unreadable lecture + "Nothing is being claimed about it either way." → "Data on file" + short note.
- `LtFileSections.jsx:810-816` renders internal `canonicalKey` in `<code>` + "PILOT does not recognise this spelling…" → drop mechanics.
- `LtFileSections.jsx:851-854` "…Nothing is shown here rather than an empty form, which would say the loan is blank." → "This loan's application details couldn't be loaded right now."
- `LtConditionCenter.jsx:291-293` "Nothing is lost — this is a read of Encompass, so try again in a moment." → "Couldn't load conditions — try again in a moment."
- `LtConditionCenter.jsx:326-330` "That is what Encompass says — not a filter on this screen…" → "No conditions or eFolder documents on this loan yet."
- `LtConditionCenter.jsx:98-99` "…M have not been read across yet." → "Showing K of N comments."
- `LtConditionCenter.jsx:355-357` "A document is a SLOT and its files are the paper in it…" → "Documents with no files attached are still outstanding."
- `LtClickupSection.jsx:101` "…the stamp pass does that on its own." → "File ID not yet on the card — added automatically."
- `LtBorrowers.jsx:82-83` "We suggest a match by email address and never adopt a profile on our own — you decide." → "Matches are suggested by email and take effect only when you confirm."
- `LtBorrowers.jsx:97` "N we will not guess at" → "N unmatched"
- `LtBorrowers.jsx:253-254` "…the next sync will bring them here to be matched." → "…they'll then appear here for matching."
- `LtBook.jsx:144-147` "N files disagree with themselves — a Flip program carrying a long term. The program wins…" → plain review note.
- `LtStatusReviews.jsx:86-88` "…this is what we have seen, not a fresh comparison of the whole book." → "Files are checked as they sync…"
- `LtSync.jsx:437` heading "Files read, with parts of the payload empty" → "…some sections empty in Encompass"
- `LtPpe.jsx:175-177` "The engine could not read its own tables…" → "Engine status couldn't be loaded."
- `LtPpe.jsx:188-190` "The order comes from the server — this page never re-sorts it…" → "Sorted by severity, hardest first."
- `LtPricer.jsx:2010-2012` "Nothing here narrows the answer: Lender Price returns every rate…" → "Everything below is a starting point you can change."
- `LtPricer.jsx:555-557` (+`1572`, `2469-2471`; `investorFilter.js:94-95`) "Display only — Lender Price is still asked for every investor…" → "Showing only the ticked investors — clear the filter to see everyone."
- `LtPricer.jsx:1539` "Lender Price works the ineligible side out AFTER the price…" → "Ineligible products load shortly after pricing."
- `LtPricer.jsx:2378-2386` "…a lender the registry cannot place is never hidden. They need a name before any consumer surface can show them." → "No display name set up yet for: X."

### LOW (families)
`LtArchive` title "Archive — deleted in Encompass"; `LtBook` tab notes / "Read X of Y files"; `LtClickupSection` dry-run/sync narration (dedicated panel — tighten only); `LtConditionCenter` "last read" stamps; `LtEncompassSection` ping/pipeline-search wording (owner-requested panel — tighten only); `LtFileSections` "has not been read (from Encompass) yet" family → "No X on file yet."; "Observed" columns → "Date"; `LtLoan` rail "Read from Encompass {day}" → "Updated {day}"; `LtPeople`/`LtStatusReviews` "we suggest/you decide" tails; `LtPipeline` chips "READ REFUSED"/"NOT READ YET" → "LOAD FAILED"/"NOT LOADED YET"; `LtPpe` shadow-mode narration; `LtSettings` "Nothing reads this yet" → "Not active yet"; `LtStatuses` "the names we shipped with"; `LtSync` dedicated-screen narration; `LtPricer` paging / "no priced rungs"; `http.js:41` "That is not here." → "Not found."

### Deliberate — not findings
Encompass section's pull/refresh/webhook vocabulary (owner requested); `LtPricer` business-purpose disclosure (legal); "From Encompass" column headers on dedicated mapping screens; Lender Price vendor naming on the staff pricer; `scenarioFields` refusals; `LtPipeline` empty-state guidance.

---

## Area 2 — Shared components A–F (67 files) — 13 H

### HIGH
- `AbPieceCard.jsx:92` "does NOT match what is recorded here. PILOT only reads Encompass, so correct whichever side is wrong." → "Doesn't match this record — correct whichever side is wrong."
- `AppraisalOrderSection.jsx:1249` "On the API Health page, turn ON both 'Order appraisals from Class Valuation (reading)' and 'Place appraisal orders with Class Valuation (write)'." → "Class ordering is unavailable — ask an admin to enable it."
- `AppraisalOrderSection.jsx:1250` "To actually send it, turn ON … The reading switch on its own does NOT send orders." → "Sending to Class is unavailable — ask an admin."
- `AppraisalOrderSection.jsx:1264` "To place the order for real, turn OFF 'Class Valuation orders — TEST MODE'…" → "Test mode is on — no order will be sent. Ask an admin to switch it off."
- `AppraisalOrderSection.jsx:2031` "Turn on 'Order Hybrid Appraisals from Richer Values'…" → "Richer Values ordering isn't available yet — ask an admin."
- `AppraisalOrderSection.jsx:2032` "A sign-in or an API token is set, but PILOT still needs to know which of their companies to order for. See the API Health page." → "Richer Values isn't fully set up — ask an admin."
- `AppraisalOrderSection.jsx:2039` "Turn on 'Place Hybrid Appraisal orders with Richer Values'." → "Ordering is unavailable — ask an admin."
- `AppraisalOrderSection.jsx:2049` "To place the order for real, turn OFF 'Richer Values orders — TEST MODE'." → "Test mode is on — nothing will be sent."
- `AppraisalPanel.jsx:1700` **(BORROWER + staff, ungated)** "The As-Is figure was read from the report's narrative — PILOT opens a task for an officer to confirm it rather than guess." → "The As-Is figure is being confirmed."
- `BorrowerDraws.jsx:380,385,526` **(BORROWER)** Sitewire named directly — **owner decision**, likely intentional.
- `BorrowerProfilePanel.jsx:284` "A two-way ClickUp field — a spelling it cannot translate is dropped from the push in silence, so this is a fixed list." → "Pick from the list."
- `ClosingPanel.jsx:238` "Set PILOT to match Encompass below — or, if Encompass is the wrong one, fix it there (PILOT never writes to Encompass)." **Owner archetype verbatim.** → "Set this to match Encompass below, or correct Encompass if it's the one that's wrong."
- `DrawsPanel.jsx:706` "DocuSign sending is turned off. Turn on `DOCUSIGN_SEND_ENABLED` to send this form." **Raw env var in a `<code>` tag.** → "DocuSign sending is turned off — ask an admin to enable it."

### MEDIUM (selected)
- `AbPieceCard.jsx:53-56` "Nothing here changes the loan… it's our own record."
- `AppDialog.jsx:70` global default error title "PILOT can't do that yet" → "That didn't work."
- Raw dumps: `ActivityFeed.jsx:97`, `DashboardCard.jsx:261-263` (SQL), `AppraisalOrderSection.jsx:3849/3715/3722`, `DrawsPanel.jsx:1211-1213` → admin-only.
- `AppraisalOrderSection.jsx` `459-463` "PILOT will not adopt one on its own" · `658/800/2878` "fills in once the appraisal catalog syncs" · `889/894` "Turn on sending to the AMC first" · `958` "written to the log" · `1386/1869-1872/1951-1953` card-encryption mechanics · `1903` "Sending to AppraisalScope is switched off…"
- `AppraisalPanel.jsx` `311` chip "As-Is read from narrative — verify" **(borrower)** · `1435` "From narrative" **(borrower)** · `1698` "stored separately so pricing never confuses the two" · `1729` comp-split mechanism banner · `241-243` "Advisory — PILOT worked this out…" · `378` "it is the read, not the to-do" · `1466-1471` build-state gate explanation · `1459` "can't be signed off until every dealbreaker is resolved"
- `ClosingPanel.jsx` `212,250,727,732,740` warehouse/funding mechanics · `782` tooltip "(read-only — nothing is written to Encompass)" **owner archetype** · `793` "(re-ingests this file's ClickUp card)"
- `ClosingPrepCard.jsx:589` "Something on the server is holding this order (its code is "{b}") and this screen does not know how to explain it yet… the portal needs an update."
- `CompMap.jsx` `247-249,426-430,434-437,415-417` trilateration + "within about 17 feet" + geocode-source lectures
- `CompReport.jsx` `124-127` "A range, not a point…" · `280` "…only where the appraisal we paid for carried them."
- `CreditReport.jsx` `392` "shared Xactus login" · `570` setup instruction · `1211/1268` "run the 'Test connection' on the API Health page" · `1021-1022` "a report nobody has accepted never leaves the building."
- `DrawsPanel.jsx` `288-294` "PILOT only runs the draw process for properties it pushes itself…" · `336` "Live in PILOT since {date} — PILOT is the source of record… Go-live: {date}." · `364-366` "(reads are on; writing is still off)" · `389/3173` borrower-safe scrub-policy narration · `709` "only allow-listed test emails" · `1998` "the composer here is parked (compliance)" · `2194` "Mirrored from the note buyer's draw administrator…" · `2875-2876` Sitewire login setup instruction · `3785` "(read-only — nothing is written to Encompass)"
- `ElementixProfile.jsx:165` "Elementix answered, but we have not confirmed how this part comes back — so an empty list here is not proof there is nothing."

### LOW (families)
`ActivityFeed` "Nothing is missing from the record — this page could not read it." + verbose-log tooltip; `AddressAutocomplete:305` geocoder attribution (likely legally required — leave); `AiReasoningChat` "isn't turned on here yet"; `AuthShell` "Audited PII access"; `AppraisalOrderSection` connection-status/test-mode/"derived by PILOT" family (~17 spots); `ClosingEmailChain` inbound-domain ask; `ClosingPrepCard` "rode along"; `CompMap` map-source notes; `CompReport` source/derivation notes; `ConditionActions:276` "(never synced to SharePoint)"; `CreditReport` "PILOT reads each borrower out of the one file…" family + MISMO 3.4 chip + "Live pull: not set up" + "no PDF in the response"; `CriticalDates` "…deactivated in Sitewire so the borrower cannot submit one either" + "Sitewire did not confirm the block. Check the sync review queue."; `DocumentDossier:143` sha256 "Fingerprint" + raw `storage.error`; `DocumentsPanel` "(never synced to SharePoint)" / "excluded from the TPR export"; `DrawsPanel` SETUP_BLURB "didn't return the ids PILOT needs to bind" + the dry-run/writes-off staging family (~14 spots) + Trinity "Nothing reaches the borrower on its own"; `EditFileDetails` ClickUp-option instruction + "the server re-checks the role" + "stands the entity documents down" + "re-drives the pricing engine"; `ElementixProfile:114` "This build has no Elementix cost check wired up…"; `EncompassSyncPanel:303` raw JSON (sanctioned panel); `EsignBorrowerCard:99` DocuSign email reference (possibly stale after the 2026-08-21 restructure); `EsignGatePanel`/`EsignFileSection` "term-sheet correctness" tier vocabulary; `EsignFileSection:23` Heter Iska "Never in the TPR export or SharePoint."; `ExceptionCard` "it was decided in the moment, so there was nothing to approve here." + "ships in the TPR export"; `ExceptionRegisterCard:44-46` empty-state instruction manual + "appear on the decision certificate… automatically"; `FileContacts:92/80` **(borrower)** "saved to the company vendor directory"; `FileOverviewSlideOver:160` **(borrower + broker)** "as the file is priced and registered"; `FileTasksPanel` "spawns its next occurrence; a repeating reminder re-arms itself" + "each fires at its due moment"; `FreeAndClearControl:74` "free-and-clear flag".

### Clean (34)
`ActionNeeded`, `AddConditionPanel`, `AddressBox`, `AppraisalCardEntry`, `ArenaWheel`, `AssistantBanner`, `BorrowerProfileLink`, `BorrowerViewBanner`, `BorrowerViewButton`, `ChangeRequestPanel`, `ChatBubble`, `ChatThread`, `ConditionLine`, `ConditionTeamNote`, `ConfirmFoundProperties`, `DashboardCardEditor`, `DealSnapshot`, `DocCompare`, `DocPreview`, `DraftingPanel`, `DropZone`, `ElementixFinder`, `EmailCenter`, `EmailListInput`, `EmailPreview`, `EncompassSyncPanel`, `Entities`, `ErrorBoundary`, `ExceptionComments`, `ExceptionConditions`, `FileNotificationOverrides`, `FileSections`, `FlashToast`, `FormattedInputs`.

---

## Area 3 — Shared components G–Z + `arena/` + `track-record/` (70 files, 22,641 lines) — 4 H

### HIGH
- `UspsAddressVerification.jsx:269` "USPS is not configured on this service. Add USPS_CLIENT_ID and USPS_CLIENT_SECRET to enable verification." → "Address verification isn't available right now. Ask an admin to switch it on."
- `UnderwritingPanel.jsx:2364` "No AVM providers configured yet — set at least one vendor key in Render to start getting AVM opinions." → "Automatic valuations aren't switched on for this account."
- `UnderwritingPanel.jsx:3486-3487` (banner on **every** file's underwriting desk) "The automatic document reader is not fully switched on yet (OCR reader) (AI analyzer). Add the Azure keys in the site settings to turn it on…" → "The automatic document reader is off. Documents can still be reviewed by hand."
- `LlcManager.jsx:266-271` **(BORROWER + staff, borrower portal)** "We have this entity down as an LLC because that is what almost every entity here is — nobody has confirmed it." → "Entity type: LLC — confirm this is right."

### MEDIUM
- `GcRecordCard.jsx:100-103` "prints on the 'General Contractor Information' sheet that goes out with the investor package and into SharePoint."
- `InvestorGuidelinesPanel.jsx:121-124` "A backend read of the file against {noteBuyer}'s own guidelines… Advisory; it decides nothing."
- `LoDrawView.jsx:156` "the composer here is parked (compliance)."
- `NearbyComps.jsx:104-107` "PILOT places a batch of properties every time it restarts, working through the ones that come up most often first — this one will get its turn."
- `OrdersPanel.jsx:708` "Something on the server is holding this order (its code is "{b}") and this screen does not know how to explain it yet… the portal needs an update."
- `OrdersPanel.jsx:1226-1228` "…there is one place that talks to the appraisal company, so nothing here can disagree with it." → drop.
- `ProductStudioPanel.jsx:428-430` **(BORROWER/TPO + staff)** leverage-band tier explanation → "This deal prices below the program maximum for its tier."
- `ProductStudioPanel.jsx:499` **(BORROWER/TPO)** "Our rate table does not have this jurisdiction — this is the conservative fallback." → "Estimated — confirm with the title company."
- `ProductStudioPanel.jsx:1851` "…Every detail saves back onto the file and the exact term sheet PDF is attached (previous sheets are marked superseded)."
- `ProductStudioPanel.jsx:1879-1884` "…re-register here and the sheet regenerates as the final one — that is the version DocuSign sends for signature."
- `ResearchImportPanel.jsx:209-211` "Nothing here touches a loan file… no file is created, no condition is opened, nobody is emailed."
- `ScheduleSend.jsx:104-105` "Nothing is written now — everything is checked again when it goes out…"
- `TrinityBudgetReview.jsx:67` "Test mode is on — PILOT built the order and sent nothing." → "Test mode — nothing was sent."
- `UnderwritingPanel.jsx:1719` "Canonical facts and per-condition cure proofs — the underlying evidence layer PILOT computes on."
- `UnderwritingPanel.jsx:1812` "…stops the reconciler from flipping this value on new sources (until you retract)."
- `UnderwritingPanel.jsx:2391` "no appraisal ARV recorded on the twin."
- `UnderwritingPanel.jsx:2589` "The math uses the same pricing engine the file was registered against; nothing here changes the file."
- `UnderwritingPanel.jsx:2747,2753` "{n} AI calls · {n} tokens · last …" / "· {tokens} tok · ${cost}" → show spend and date only.
- `UnderwritingPanel.jsx:2877,2884` "run the deep cross-doc consistency check with GPT-5" / "Run GPT-5 cross-document contradiction check" → "Run the deep cross-document check."
- `UnderwritingPanel.jsx:3024,3025,3103` dedupe mechanics ("{n} repeats of Open findings hidden")
- `UnderwritingPanel.jsx:3042` "Re-run every free AI check (entity chain, bank, bad-clearance, public records, identity chain) on the file's current extractions" → "Re-check this file's documents."
- `UnderwritingPanel.jsx:3255,3259` (super-admin) "Every future finding with this code will be dropped before it reaches any file." / "Manage the mute list at /internal/ai-silenced-codes."
- `UnderwritingPanel.jsx:3587` "PILOT did NOT change anything on the file."
- `UnderwritingPanel.jsx:3706-3712` "A finding you dismiss… stays gone — it will not come back on the next read."
- `UspsAddressVerification.jsx:407` "Import adopts it as the working property address for the loan, financing tapes and TPR exports…"
- `arena/ArenaControlRoom.jsx:874` "Where this came from: {game.origin}" → drop the row.
- `arena/ArenaMonitor.jsx:159-161` "The full list, because you are the one running the day…"
- `arena/ArenaProof.jsx:99-104` (+`92-96`) step-by-step SHA-256/HMAC recipe in the fairness modal → keep the checks and fingerprints, move the recipe behind a link.

### LOW (families)
`GcRecordCard` save toasts ×3 ("was redrawn for the investor package and the team site"); `InvestorGuidelinesPanel:164` "this desk"; `NoteBuyerCard` "Nobody is buying this loan yet in the system." + "Saving also re-checked the whole file" + "These are the note buyers ClickUp offers"; `OrdersPanel:1156` "Tracked on the Orders desk as"; `PdfViewer:351` **(borrower)** "Text reading isn't turned on for this account."; `ProductStudioPanel` `370-372`/`556`/`1570`/`1830`/`1873-1875`/`1916-1918`/`674` (several **borrower/TPO**-visible); `RateTermCashCard:116-117` "a deal the system mis-costed"; `StaffLayout:517` "PILOT reports these and never settles them itself" + `630` "Pipeline (shadow)… V2-vs-V1 comparison"; `ToolModal:184/204` **(borrower)** "only the Excel/PDF exports are skipped"; `UnderwritingPanel` `759`/`2241`/`2382`/`2856`/`3020`/`3058`/`3105`/`3497`/`3559`/`3786` ("What PILOT read", "the AI never changes the file itself", vendor-key note, cost dialog — the cost disclosure itself is legitimate); `WhatsLeftPanel:93-94` "it is here to be read, not to block you."; `arena/ArenaChallenges:151` "waiting on a super admin"; `arena/ArenaControlRoom` `785`/`1781-1783`/`1852-1855`; `track-record/ExperienceHeader:105`; `RecordLedger:164` "nothing entered is ever lost"; `SpreadsheetEditor:51`; `LineDetail` `431`/`1095` "never synced to SharePoint", `715-716` shared-lookup-allowance mechanics (the cost warning is legitimate), `724` "It never marks the line verified by itself.", `838-841` "this says nothing about the deal.", `875` "A value anybody typed is never overwritten."

---

## Area 4 — Borrower / TPO / public screens (`app-v2/src/screens`, 29 files) — 0 H

- `[M]` `Application.jsx:1257` (borrower) "It autosaves onto this condition; submitting attaches a fresh PDF + Excel for underwriting" → "Build your scope of work in the builder — your work saves as you go; submit it when it's ready."
- `[L]` `Application.jsx:1130` (borrower) "Reprice any time — your scenario autosaves and re-registering replaces the old terms." → "Reprice and re-register any time — the newest registration is the one that counts."
- `[L]` `Application.jsx:1015` (borrower) "Ask your officer to update deal numbers — they flow into pricing automatically."
- `[M]` `Apply.jsx:932-936` (borrower) "This is the live YS Term Sheet Studio, prefilled from your application — the same guidelines, limits and pricing as our public tool. … saved onto your loan file." → "Price your deal, compare programs, then tap a program card and register — your terms are saved to your loan file."
- `[M]` `Apply.jsx:908` (borrower) "Your file will go to our Lead Capture desk for prompt assignment." → "We'll assign a loan officer to your file right away."
- `[L]` `Apply.jsx:327,356` (borrower) "Autosave hit a snag — your changes are on this device and will retry." → "We couldn't save your latest changes — we'll keep retrying automatically."
- `[L]` `Apply.jsx:640` (borrower) "lets us request the payoff letter without chasing you for it." → "…so we can request the payoff letter directly."
- `[M]` `EsignDashboard.jsx:328` (staff) "PILOT's own DocuSign cockpit — every package, every signer, live." → "Every signing package and every signer, live."
- `[L]` `EsignDashboard.jsx:383` (staff) "Sends are automatically pacing themselves and will catch up — nothing is lost." → "DocuSign is busy — queued sends will go out automatically."
- `[M]` `TpoFile.jsx:302` **(TPO broker)** "Credit ordering isn't set up here — your loan team can pull it." → "To order credit on this file, ask your loan team."
- `[L]` `TpoFile.jsx:292` (TPO) "Your loan team reviews the report — scores and the report itself stay with them." → "Your loan team receives and reviews the report."
- `[M]` `TpoTeam.jsx:67` **(TPO broker)** "Invitation created. Email delivery is off, so share this link with them:" → "Invitation created — send them this link to set up their account:"

**Coverage:** 29/29 read fully. Grep-verified: zero vendor/investor names in rendered borrower/TPO text — all hits are code comments. DocuSign named once in borrower copy (appropriate — it is the email brand they receive).

---

## Area 5 — Staff screens A–E (32 files) — 4 H, 11 clean

### HIGH
- `StaffAiAdminInbox.jsx:68` "Your answer closes the on-file suggestion AND becomes a training signal so the agent gets smarter without a developer changing code." → "Your answer resolves the question and helps PILOT handle similar cases in future."
- `StaffApiHealth.jsx:519` SitewireExplorer "A behind-the-scenes helper for building new Sitewire features. It peeks at Sitewire's own test system… never touches your real Sitewire account…" → one plain sentence.
- `StaffClickup.jsx:219` backfill panel "Dry-run samples real ClickUp tasks… Build identity graph ingests every task into shadow borrower profiles / LLCs / track records (no loan files). Full backfill also materializes RTL loan files…" → operator language.
- `StaffCompanyPricing.jsx:441` **RENDERING BUG** — prints `A general file is ${fmtMoney(lf.underwriting)} + ${fmtMoney(lf.legal)} = ${fmtMoney(lfTotal)}.` → interpolate real values.

### MEDIUM (selected)
`StaffAdjustments.jsx:125/155/181/187` honesty-essay voice ("This is a statement about our reports — not about the market…", "Our warehouse holds…", "more lines than one reading can hold"); `StaffAiAdminInbox.jsx:102` placeholder "…This feeds the AI's learning."; `StaffApiHealth.jsx:531` "…a developer adds a separate Sitewire test login… as SITEWIRE_TEST_ACCESS_TOKEN…"; `:1106` "…never here, so a problem in the app can never leak a key."; `:899` "PILOT paces itself so it never asks an outside service for more than they allow — counted across every part of PILOT at once, not per copy."; `StaffApplication.jsx:1836` raw `JSON.stringify(tool_payload)`, `:4114` raw snake_case `field_key`, `:4116` "(activates with the e-sign integration)", `:4457` "…the same test the sync itself uses…", `:969` "…so the data comparison can match them against the other documents.", `:6471` "…Nothing is ever written onto the loan file automatically.", `:6513` "…Each turns on once its login is set up."; `StaffClickup.jsx:226` "shadow profiles… materialize RTL loan files", `:280` placeholder "application UUID", `:151` "Descope" + "Neither writes to ClickUp."; `StaffCompSearch.jsx:483` "…a half-mile from an unknown point is not a half-mile.", `:491` "This database only knows houses that appeared in an appraisal we paid for…"; `StaffCompanyPricing.jsx:428` "(the frozen title-cost table)"; `StaffConditionStudio.jsx:60/359` "When the e-sign integration goes live…"; `StaffElementix.jsx:144` matching-methodology lecture, `:252` "None of this spends a credit… PILOT is bringing these in by itself…", `:273` "One shared super-admin connection runs everything…"

### LOW (families)
`StaffAiCenter`/`StaffAiSilencedCodes` intros; `StaffApiHealth` switch hints/monitor banner; `StaffApplication` WHY-map strings, "(we normally read these off the XML)", "borrower status re-derived", "(38-status workflow)", "Left for a human on purpose…"; `StaffAppraiserDetail` "Read straight off their reports…"; `StaffApprovals` "PILOT ⇄ ClickUp disagreements waiting for a human to pick a side."; `StaffArena` fairness note; `StaffBorrowerDetail` "what PILOT actually uses…", "so it flows through the reminder system"; `StaffBorrowerView` over-long intro; `StaffClickup` dry-run flashes, "Materializable", raw `match_detail` JSON, "Webhook secret"; `StaffCompSearch` source-mention ×3, "Had to look wider…"; `StaffConditionStudio` "TPR clean-file export", raw `fieldKey` pill; `StaffCrmDesk` import tooltips + "the table scrolls sideways — swipe it"; `StaffDashboards` "ships"; `StaffDrawRules` "ships with"/"mirrored back"/"Nothing is guessed"; `StaffDraws` chips "Writing on"/"Read-only"/"Dry-run", "flows into Sitewire"; `StaffExceptions` "time-boxable", "counter-offer haggle".

### Clean (11)
`StaffAllExceptions`, `StaffAppraisers`, `StaffArchived`, `StaffAuditLog`, `StaffBorrowers`, `StaffChat`, `StaffClosing`, `StaffCompReportScreen`, `StaffDashboard`, `StaffEmails`, `StaffEscalations`.

---

## Area 6 — Staff screens F–Z (33 files) — 17 H, 6 clean. **Worst area.**

### `SyncReviews.jsx` — ~42 findings, 6 H (worst single file in the product)
- `[H]` `:41` "Encompass is read-only here, so whichever value you pick is written to the PILOT profile (and pushed on to their ClickUp cards); nothing is ever sent back to Encompass." **Near-verbatim owner-quote class.** → "Pick the correct address — it updates the borrower's PILOT profile."
- `[H]` `:688` the same lecture repeated inline above the Encompass resolve buttons → drop entirely.
- `[H]` `:42` "…until now the next sync read ClickUp's old value back and UNDID the change… which is why an edit like Fix & Flip → Fix & Hold kept 'bouncing back'. PILOT now KEEPS its value…" **Changelog rendered as UI copy.** → "ClickUp's dropdown has no option for this value, so the update was skipped."
- `[H]` `:18` "…move an existing ClickUp DOB by exactly one day — the corruption signature. Nothing was written." → "A one-day birthdate change was held for review — nothing was changed."
- `[H]` `:75` tooltip "Materialize this task as a brand-new PILOT file (all guards still apply)" → "Create a new PILOT file from this task."
- `[H]` `:102` tooltip "Re-arm the document's mirror retries and kick a sync pass — fix the underlying cause first" → "Retry saving this document to SharePoint."
- `[M]` `:19,20,26,27,28,29,32,33,34,35,37,44,45,57,79,82,86,99,474,496,624` — "the date-repair tooling", "mid-typing artifact", "bulk repush… may only fill blanks", "identity signals… point at more than one existing file", "deliberately waiting rather than creating a twin file", "orphaned", "automatic recovery window", "(the mirror never moves or renames anything itself)", "soft-archive", "the normal guarded push", "geocode", "PILOT manages the draw process only for properties it pushed itself".
- `[L]` `:21,30,36,40,43,64,106,247,264,424,531,661,698,714,813` — "Nothing was changed anywhere (identity fields never overwrite silently)", "re-read live, audited", "re-point", "Close this without writing anything anywhere", "Resolved automatically — no clicks needed."

### Other HIGH
- `StaffPurchasing.jsx:154` "Read from the loan in Encompass. It fills in here by itself, and marks the loan Sold, moves the ClickUp card and stamps the critical dates." **Owner-quote class.** → "From Encompass."
- `StaffPurchasing.jsx:138` "PILOT asked, and Encompass answered without that field. An admin needs to check which field PILOT is reading." → "The purchase advice date can't be read right now — ask an admin."
- `StaffPurchasing.jsx:140` "This deployment is not reading a purchase advice field at all — ask an admin." → "Purchase advice tracking isn't set up — ask an admin."
- `StaffPipelineShadow.jsx:77` whole-screen rollout narration "A read-only look at the new document pipeline running quietly beside the current one… before turning any document type on for real."
- `StaffPipelineShadow.jsx:90` "Exposed pipeline: V1 (the new pipeline runs in shadow only) · Families in shadow: … · Background worker: on/off" → remove.
- `StaffPipelineShadow.jsx:96` "To try it, set the shadow switches in the hosting dashboard…" **Setup instructions as UI copy.** → remove.
- `StaffLabelingConsole.jsx:118` "Azure Blob storage is not configured. Add AZURE_DOCAI_LABEL_SAS_TOKEN (or AZURE_DOCAI_LABEL_ACCOUNT_KEY) in Render." → "Document storage isn't connected — uploads are off until setup is complete."
- `StaffLabelingConsole.jsx:125` "Classifier project id is not set (AZURE_DOCINT_CLASSIFIER_ID). Once the classifier is trained in Azure Studio…"
- `StaffInvestorSuite.jsx:312` "(No email provider is configured on this environment, so nothing actually left the building.)" → "Email sending is turned off — this message was not sent."
- `StaffPropertyResearch.jsx:425` "…The industry moves to a new one on 2 November 2026 … This needs to be built before that date." — dev task narrated to staff.
- `StaffTrainingProposals.jsx:86` "Shadow test — let PILOT try this change quietly on new files in the background… The safe first step." **`CLAUDE.md` records this as owner-directed 2026-07-24 — owner reconciliation required.**

### MEDIUM (by screen)
`StaffFindingEscalations` `119,171,265`; `StaffInsightsDashboard` `50` "shows what PILOT sees", `291` "what's live on this deploy"; `StaffLabelingConsole` `53,114`; `StaffMarket` `168`; `StaffMarketAreas` `94,209,213` ("A circle cannot say this side of the highway", "bounding box"); `StaffNotificationCenter` `1087` "the worker", `1071` "shadow mode" (the feature is named Learning mode), `1270` "How email leaves the system for you", `1271` "In-app rows are always written"; `StaffPipelineShadow` `87,123,205,227,236`; `StaffPropertyDetail` `396,399` "rows"; `StaffPropertyResearch` `436`; `StaffPropertyWorkbench` `787` "There is no bulk import, on purpose"; `StaffPurchasing` `137,139,141,155,160,149`; `StaffSettings` `110`; `StaffTrainingProposals` `78,128,145,152,59` ("normalizer alias", "committee prompt", raw `JSON.stringify(change)`); `StaffVendors` `197,502` ("soft-deleted", "row", "loser").

### LOW (families)
`StaffLeadDetail`/`StaffLeads` source-unknown narration; `StaffMyExceptions`; `StaffNewFile` "no duplicate will be created" ×2, "Draft saved — nothing you type is lost", "will refuse to register"; `StaffQuickAnswer` "below five matches it says nothing at all", "What it looked at"; `StaffTapes` "its program isn't live yet"; `StaffTasks` "firing"; `StaffTeam`; `StaffTpoFirms` "Header (Basic auth)"; `StaffTpoView`; `StaffValuation` teaching copy + "a rate is refused below M of them"; `StaffVendors` "pairwise", "row".

### Clean (6)
`StaffFileDraws`, `StaffLogin`, `StaffOrders`, `StaffQueue`, `StaffTrackRecordWorkspace`, `StaffWorkflow`.

---

## Area 7 — Emails & notifications (46 files) — 2 H

### HIGH
- `src/sitewire/investor-delivery-send.js:772` **(INVESTOR)** "One document is/N documents are too large to attach, so it is/they are linked below…" — the attachment-apology family the owner **already banned in this exact email on 2026-08-13**; the ban's comment sits at `:750` but this sentence survived. → "Also enclosed via the links below: X."
- `src/lib/email/draw-email.js:214` **(BORROWER + staff — no borrower gate)** "the $X on this draw isn't counted in the figures above yet — its line detail hasn't synced" → omit for borrowers / "figures for this draw are still being finalized."

### MEDIUM
- `catalog.js:419` (borrower) "The executed copy is on your loan file in the portal — it was too large to attach here." → "Your executed copy is saved on your loan file in the portal — download it there any time."
- `notification-digests.js:1495` (closer + super admins) "PILOT asked Encompass and no purchase advice date has come back… PILOT may be reading the wrong field."
- `notification-digests.js:2325` (staff) "The daily surveillance sweep noticed N canonical fact change(s)… stamp a fresh snapshot from the file's Sovereign panel."
- `notification-digests.js:2726-2728` (admins/owner) "Open the Render dashboard and check the 'ys-capital-backup' job… docs/DATABASE-BACKUP-AND-RESTORE.md" → "Nightly backups have stopped — have technical support restart the backup service today."
- `sync-review.js:156-164` (LO) SP_DOC_PARKED bodies ("The copy PILOT put in the drive is no longer there… PILOT will NOT put it back on its own…")
- `sync-review.js:178` (LO) "PILOT keeps retrying on its own, but this one needs a look…"
- `sync-review.js:262` (LO) "PILOT did NOT move it on its own — Clear to Close is a major milestone…"
- `sync-review.js:266-268` (LO) frozen-economics lecture.
- `esign/webhook.js:350-351` (staff→admins) "…PILOT couldn't save the signed copies back to this file (${reason}). PILOT keeps retrying automatically…" — raw `err.message` in the body → sanitize.
- `closing-prep.js:1143` **(ATTORNEY)** "The term sheet is NOT attached — it was too large to send by email. Tell us and we will get it straight over…" → "The term sheet will follow separately — please do not draft until you have it."
- `closing-prep.js:1021` + `463-498` **(ATTORNEY)** skipped rows "filename (no stored copy / could not be read / empty file / too large…)" → filenames only.
- `closing-prep.js:1360-1361` **(ATTORNEY)** "The executed copy was too large to attach here — tell us…" → "will follow separately."
- `tapes/investor-send.js:~298/304` **(INVESTOR)** "…goes straight to the loan file's team inbox (file+<id>@domain)." → "Reply to this email and it reaches the whole team."
- `investor-delivery-send.js:784` **(INVESTOR)** "…no documents could be attached." → "Documents will follow separately."
- `file-inbox.js:791` (staff/admins) "Check the Resend dashboard for the original message."
- `sharepoint-backup.js:2979-2980, 3003-3006` (admins/owner) "…may need a restart (a re-deploy)."
- `post-purchase.js:211-214` (staff) "PILOT can see that X was sold… You do not need to type the date — it came across from Encompass on its own."
- `encompass-funded.js:195` (staff) "PILOT filled the funded date in and moved this file to Funded… It is NOT reconciled — reconciling is still a human's three-system check."

### LOW (families)
`catalog.js:336` anti-phishing line (fine, could soften); `catalog.js:597` TrustPoint parenthetical; `notify.js:1411-1412`; `deliver-findings.js:343-348`; digests `1574`/`1580`/`898`/`615`/`752`/`778`; `sync-review` `281-283`/`274`/`280` ("retry the push" → "send it again"); `integrations/monitor.js:136-138` (path note: `src/lib/integrations/monitor.js`); `file-inbox` `1046`/`1162`; `sharepoint-backup` `2925-2930`; `sold-status.js:153`; `routes/sitewire.js:983`/`4020`; `sitewire.js:1659` + `trustpoint/mirror.js:508` "written to the money ledger automatically".

**Coverage:** 46 files; all read fully + every send-site chased via greps (orders, reminders, chat, term-sheet-offer, leads, intake, admin, richervalues, backup/report, lo-notification-worker, deliver-findings, draw-accepted-notice, encompass-funded, post-purchase, sold-status, sharepoint-backup, file-inbox, esign/webhook, trustpoint/mirror + `staff.js`/`borrower.js`/`sitewire.js` bodies — clean).

**Borrower product emails (terms-ready, status, draws, e-sign, verdicts, reminders) are in excellent shape — nearly no work needed.**

---

## Area 8 — Long-term back end (`src/longterm`) — 4 H

### HIGH
- `locks.js:406-407` (every Rate-lock section) "Encompass's lock request history is not readable on our current API permissions, so this list is what PILOT itself watched change between reads." **Server sibling of owner quote #2.** → "Lock activity."
- `locks.js:250` (no-expiration case) "…It is never calculated from the lock date plus a day count — an extension moves it, and a calculated date would be wrong in the direction that costs money." → "No expiration date on file for this lock — confirm it with the lock desk."
- `application/unsourced.js:47` (Property + Income of **every** file) "Encompass holds a flood zone letter rather than a yes-or-no — nobody has said yet how PILOT should read it." → "Flood-zone determination not on file."
- `read-state.js:36-37` (highest-visibility waiting state — rail, pipeline chip, panel) "PILOT has found this loan in Encompass but has not read the file itself yet, so only what the pipeline search returns is filled in. It is in the queue and fills in on its own." → "Full details are still loading from Encompass — they fill in automatically."

### MEDIUM
`unsourced.js:58` "Encompass does hold a zone letter on many of these loans — PILOT is not reading it yet."; `:69` "…\"actual\" is a separate figure nobody has told us where to read."; `:135` "…Encompass gives us no figure for them we can trust."; `:94` "Encompass does not date the rows on the schedule of real estate."; `workspace.js:88` "The Condition Center is switched off for this company. It is built — turning it on is a settings change, not a new release."; `routes/conditions.js:60` "The Condition Center is coming soon." (contradicts `workspace.js:88` — unify); `milestones.js:130` "This is where the loan already was when PILOT started watching it…"; `:126` "PILOT has not read this loan yet, so there is no record of when it reached this milestone."; `milestone-purchased.js:187` "Encompass has not said what the investor has done with this loan yet."; `people/contacts.js:257` "This role is ours: Encompass has no file-setup assignment, so PILOT keeps it. Nothing is written back to Encompass."; `:255` "Reassigned in PILOT. Encompass still names the person above; nothing was written back."; `:254`; `routes/encompass-file.js:59-61` "PILOT does not hold this loan's Encompass id… next discovery pass."; `settings/encompass-settings.js:47-50` NW_PINNED_FIELD "…the build fails if a path disagrees with it — that guard is what caught three field paths…"; `:54-56` NW_SETTLED_RULE; `routes/dscr-pricer.js:188` "Transmitted as numeric criteria.cashoutAmount — the captured vendor field… the earlier fail-closed behaviour existed because… dynamicPropertiesMap.undefined bug…"; `clickup/status-push.js:153` "…no milestone has fired, so PILOT left the card alone"; `:137` "first status pass for this loan — the watermark is taken and no status is written"; `sync/loans.js:366`+`822` "…rate lock: the payload carried nothing"; `clickup/push.js:835-836` "a milestone fired wanting \"X\"… PILOT never invents one"; `routes/clickup.js:225-241` serves **raw reason codes** `dob_change_blocked_pending_review` / `pii_overwrite_blocked` → map to sentences server-side.

### LOW (families)
`locks.js` "mirrored"/"payload"; `workspace.js` greyed-entry "has been read from Encompass" family; `vesting-view` "Encompass has not said…"; `milestones` "milestone catalog"; `read-state` raw vendor error passthrough; `file-sync-view` "a bare ping — PILOT asked Encompass…"; `routes/stages`; `routes/clickup` disagreement note; `routes/borrowers` "never adopts a profile on its own"; env-var names in refusals (`LT_CLICKUP_WRITE_ENABLED` etc.) → "an administrator can turn it on"; `status-engine` "field 1393 says…"; `push.js:680`; `pipeline-columns` "Encompass has not given us…"; `pipeline.js:784`; **settings evidence: 73 strings of census/build narration on the admin settings screen** (trim the archaeology, keep the tenant facts); `dscr-pricer`/`quick-pricer.html` (unserved preview — must be cleaned if it ever ships).

### Not-findings
`book-diag`/`lenderprice-diag` (secret-gated diagnostic tools — plumbing *is* their product); `encompass-knowledge` reference library; professional actionable route errors; match NO_MATCH reasons; `unsourced` why/unblock (not served); `my-loans.js` borrower door is whitelisted + scrubbed — none of these strings reach a borrower; no investor-name leak to clients found.

---

## Area 9 — `db/` condition wording + RTL server strings + public site

### `db/` condition wording
- `[M]` `db/354:48-53` (staff, stock hint on `appraisal_as_is_verify` on **every** file) "PILOT reads the appraisal's values and writes them onto the file… The As-Is is looked for in the data file first, then in the report PDF with OCR and AI…" → "Confirm the As-Is and ARV against the appraisal report. If a value is blank or wrong, enter the correct figure here." (`db/353:75-79` = superseded same lecture.)
- `[M]` **`[auto]` note stamps, pervasive (staff):** `db/071:31`, `096:72`, `126:132`, `145:76`, `155:35`, `190:99`, `374:82`, `375:68`, `417:87` + `experience.js:380-389`, `rehab-budget.js:192-194`, `staff.js:2873/15135/18465`, `conditions/extra-slots.js:119`. The tag is **load-bearing in storage** (`notes LIKE '[auto]%'` guards) → keep stored, render as a small "automatic" badge, strip from display. Staff-only (borrower routes never select `ci.notes`).
- `[M]` `db/005:89` historical "BlueLake file → TWO months" in an `audience='both'` hint — already remediated by `db/012` + `058`/`070`/`533` re-word each boot; **no current exposure**.
- `[L]` `db/367:82` + `db/393:45` trailing "PILOT never issues one."; `db/520:62` 69-word e-sign explainer (`db/467:35/46` same class); `db/380:42`; `db/144:13-16`; `db/210:45,59` "(this also syncs to the ClickUp file list). Internal only — never shown to the borrower."; `db/215:28`; `db/379:34` "API"; `db/032:50` borrower_hint "register your product".
- **Not findings:** investor names in *staff* label/hint = genuine work instructions; all `borrower_label`/`borrower_hint` across 63 hint-bearing migrations checked — no investor name live; `db/303`/`400`/`464`/`473`/`509` borrower hints are model copy.

### RTL server display strings
- `[M]` `appraisal/as-is-reader.js:868-872` (staff condition note) "[auto] PILOT could not confidently read the As-Is value — it checked the appraisal data file and then read the appraisal report PDF with OCR (engine) and AI… a value is never guessed." → "The As-Is value could not be read from the appraisal. Read it off the report and enter it here."
- `[M]` `as-is-reader.js:832-847` "[auto] PILOT LOWERED the As-Is value on this file from $X to $Y… so no OCR was involved…" 5-sentence diary → the change + one action sentence.
- `[M]` `as-is-reader.js:878-891` `buildAsIsHint` "PILOT lowered this file's As-Is value from what it read…" / "…but this file's figures are locked, so it changed nothing."
- `[M]` `underwriting/misfiled-document-advisory.js:101-102` "…being read with the wrong template… PILOT will not do this on its own." → plain re-file instruction.
- `[M]` `underwriting/splitter-suggest.js:68-69` "…(and read by the matching field extractor)." → end at "filed under the right condition."
- `[M]` `liquidity.js:166-171` — a `borrower_hint` written in **staff voice** ("the borrower's bank statements must show…") served to the borrower on their own condition → compose a borrower variant ("your bank statements…").
- `[M]` `routes/borrower.js:2214` (borrower 409) "This file is Clear to Close — the vesting entity is locked. Move it back to an earlier status to change it." — staff instruction served to a borrower → "Your file is cleared to close, so the vesting entity is locked. Contact your loan officer…"
- `[L]` `bad-clearance.js:71-72` confidence % in prose → badge; `liquidity.js:53` loud banner "according to the registration" (**owner-dictated 2026-07-30 — changing needs owner sign-off**); `file-lock.js:241-269` parenthetical mechanics (staff variants; borrower branches exemplary); `underwriting.js:1818` "page-bounded"; `term-sheet-stamp.js:113-115`; `order-requirements-post.js:110` AMC comment author name 'PILOT' → "YS Capital".
- **Positives:** `staff.js`/`borrower.js` refusals + `signOffGate` messages consistently professional; `term-options.js` term-sheet lines proper; `experience`/`track-record-todo` clean.

### `web/v2` static + tools
- `[M]` `termsheet.js:2308` (applicant on-screen note) "Unit count taken as 4 (the sheet only knows \"2-4 units\")… set the exact number in the admin section." → "Taxes are estimated at 4 units — confirm the exact unit count for a precise figure."
- `[M]` `termsheet.js:3060-3065` PROV_COPY **stamped on the signable PDF**: `file` "Generated from an active loan file — Products & Pricing" → "Prepared from your loan file"; `borrower_portal` "Self-generated in the borrower portal" → "Prepared in the borrower portal"; `file_final` sub "…all clearances complete" → "ready for signature". *(Borderline-H: internal names on the client's signature document.)*
- `[M]` `termsheet.js:3374` printed on the signed term sheet "Effective purchase price (admin exception)" → "(approved exception)".
- `[M]` `loan-application.html:980,990-991` (public page) visible "Admin mode" trigger + "Pricing controls [Admin] — … Nothing here is saved with the application, emailed, or shown to the borrower." — third-person about the borrower on the borrower's own page; same pattern on `term-sheet.html` (gated → L there). Hide the trigger behind a shortcut or `?admin`, and re-voice.
- `[L]` `loan-application.html:2010,2101` toasts "(loads the spreadsheet engine)" / "(loads the PDF engine)" → drop; `termsheet.js:3641-3650` "Authorized representative — required to validate" → "Authorized representative".
- **Positives:** `index`/`disclosures`/`rehab-budget`/`track-record` visible copy polished; compliance wording proper; `track-record.js` coaching good.
- **OUT-OF-SCOPE ACCURACY NOTE:** `disclosures.html` still says "Every program carries a minimum earned-interest provision of three months" — contradicts the 2026-07-22 off-by-default toggle rule. Stale legal copy; **owner decision needed.**
