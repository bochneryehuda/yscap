# Long-Term exports that nothing in the product calls

**Generated. Do not hand-edit the lists** — run `node scripts/check-lt-export-reachability.js --update`.
You MAY add a reason after an entry with ` — your reason here`; the generator preserves it.

`scripts/check-lt-export-reachability.js` lists, for every Long-Term module the server can actually
reach, the exported names that nothing in `src/` references outside that module. It exists because
the three ledgers beside it each watch a different layer — an unrequired MODULE, an unrun TEST SUITE,
an unreachable ROUTE — and none of them can see a dark capability **inside a module that is wired**,
which is where this workstream's last two most serious defects lived (§2.45, §2.46).

**It is a RATCHET, not a ban.** Both lists below are the state of the tree today. What the checker
refuses is a name that is uncalled and NOT on these lists (the class growing), and a name on these
lists that has since gained a caller (a ledger that overstates what is dark). Wiring something means
striking it here in the same commit.

**A row is not a defect.** Plenty of these are deliberate: a constant exported so a suite can assert
against the definition instead of retyping it, an operator command, a capability written ahead of its
caller. A row is an invitation to say which — that is what the reason field is for.

**⛔ AND "REFERENCED NOWHERE" IS NOT THE SAME QUESTION AS "UNTESTED", which is the trap in reading this
file.** The checker counts references from OTHER files, so a helper its own module calls on every
request lands in the first list looking abandoned. `capture.scrubSecrets` — the credential scrub — is
in it, and it runs on every captured payload. What actually matters is whether the BEHAVIOUR is
pinned, and this file cannot answer that; only a mutation can.

**So the file now says it per row (§2.126d), instead of asking you to remember it.** A row marked
_(its own module uses it)_ is reached on the module's own path and only LOOKS abandoned — judge it with
a mutation, never with this list. A row WITHOUT that mark is the sharp case: nothing anywhere reaches
for it, inside the module or out. **51 of 272**
rows are in that state today, and `ppe/run-store.js :: partitionReadable` was one of them — the guard
§2.126b found built, tested, and wired to nothing while the go-live gate promoted investors off runs it
said could not be read.

**So the 23 rows recorded on 2026-08-19 were each measured, not labelled.** Every one was mutated on
its own and its suite re-run. **None was a missing wire**: each is either internal to its module and
proven THROUGH the door that calls it — which is the stronger test, since a scrub proven on the helper
says nothing about whether the sink runs it (§2.112) — or driven directly by a suite. Where a mutation
was run, the row records what it cost (*"MEASURED: making it always null fails 26 assertions"*). Those
counts are a SNAPSHOT of that day; treat a stale one as a prompt to re-measure, never as a live gate.
One mutation attempt in that pass silently failed to apply and reported a clean pass — **a mutation
that does not apply proves nothing**, so the harness now verifies the file actually changed before it
believes the result.

**⛔ THIS HEADER IS GENERATED TOO (§2.126c), and it had to become so.** The three paragraphs above were
hand-written into the file, under a heading that says the LISTS are generated — and `--update` rewrote
the whole file, so the next regeneration would have silently deleted the only record that those 23 rows
were measured rather than labelled. They now live in `renderLedger` and survive.

**⛔ AND THE ROWS BELOW ARE A NEWLY-VISIBLE BACKLOG, NOT A MEASURED SET (§2.126c).** Until 2026-08-19
the reader required an export block's closing brace to sit on its own line, so **56 of the 152**
Long-Term modules using the object form contributed ZERO names and were invisible — `ppe/run-store.js`
among them, whose `partitionReadable` is the exact guard §2.126b found built, tested and wired to
nothing. Fixing the reader made **240** real exports visible for the first time and struck **191**
names that were never exports at all (the old pattern flattened nested `_internals` seams into the
list, so the ledger carried rows about things that do not exist). Those newly-visible rows are recorded
so the ratchet can hold from here; they are **NOT** measured, and none of them should be read as
"checked and fine". The measured set is the 23 above.

## Referenced nowhere at all (91)

Not by production code and not by a test. Nothing asks for these, so nothing would notice if one were
wrong.

- `access.js :: effectiveStaffIdOf` _(its own module uses it)_
- `access.js :: SCOPE_OWN` _(its own module uses it)_
- `access.js :: scopeForRole` _(its own module uses it)_
- `audience.js :: CLIENT_AUDIENCES` _(its own module uses it)_
- `audience.js :: INTERNAL_ONLY` _(its own module uses it)_
- `audience.js :: internalOnlyFieldIds` _(its own module uses it)_
- `borrower-match.js :: SHADOW_EMAIL_DOMAINS` _(its own module uses it)_
- `client-view.js :: NOT_NUMBERED` _(its own module uses it)_ — the sentinel for a field with no Encompass number; internal
- `encompass/completion-rules.js :: MILESTONES_SEEN`
- `encompass/conditions.js :: CONDITION_SHAPE`
- `encompass/conditions.js :: EFOLDER`
- `encompass/conditions.js :: WRITE_PATH` _(its own module uses it)_
- `encompass/formulas.js :: CREDIT_SCORE_LOGIC`
- `encompass/formulas.js :: OTHER_FORMULAS`
- `encompass/index.js :: familyOf` _(its own module uses it)_
- `encompass/loan-anatomy.js :: BORROWER_PAIRS` _(its own module uses it)_
- `encompass/loan-anatomy.js :: DSCR_STAGE_DISTRIBUTION`
- `encompass/loan-anatomy.js :: HOUSING_EXPENSE`
- `encompass/loan-anatomy.js :: LOAN_ROOT`
- `lenderprice/client.js :: enrichZip` — MEASURED 2026-08-19: zero callers in `src/` and zero in `scripts/`, so the conforming mortgage limit is never fetched. Its heading claimed "zip → county / limits / AMI" and it does only the limit; the county comes from `./zip-county.js`, which IS wired. Kept, not deleted — whether a conforming limit belongs in a non-QM DSCR quote is an owner question (§2.126d)
- `lenderprice/client.js :: fetchDefaultSearch` _(its own module uses it)_
- `lenderprice/client.js :: fetchSmoRegistry` _(its own module uses it)_
- `observed.js :: SUGGESTERS` _(its own module uses it)_
- `people/contacts.js :: DEFAULT_ENCOMPASS_ROLE_NAMES` _(its own module uses it)_
- `people/contacts.js :: MIN_REASON` _(its own module uses it)_
- `people/contacts.js :: roleConfig` _(its own module uses it)_
- `people/links.js :: staffIdForLogin`
- `people/match.js :: DEFAULT_PLACEHOLDER_EMAILS` _(its own module uses it)_
- `people/roster.js :: fetchRoster` _(its own module uses it)_
- `pipeline-book.js :: BOOKS` _(its own module uses it)_
- `ppe/adjustment-overlap.js :: collisionsIn` _(its own module uses it)_ — the overlap primitive its own suite asserts through; the pricing path calls `resolveDoubleCharges`, which wraps it
- `ppe/agreement-dimensions.js :: FACT_ALIASES` _(its own module uses it)_ — the one-entry alias table `factsForDimension` reads; internal, and pinned through the dimension classifier the reconciler drives
- `ppe/agreement-store.js :: KIND_OVERRIDE` _(its own module uses it)_
- `ppe/agreement-store.js :: KIND_RUN` _(its own module uses it)_
- `ppe/comp-plan.js :: SPLIT_BASES` _(its own module uses it)_
- `ppe/cutover-ledger.js :: daysInCurrentMode` _(its own module uses it)_
- `ppe/cutover-store.js :: rowToEntry` _(its own module uses it)_
- `ppe/cutover.js :: _isRegressed` — the §2.74 "a fix that came undone" predicate, exported under the test seam so its truth table is asserted directly; the scoreboard uses it through `buildScoreboard`
- `ppe/cutover.js :: OPEN_FINDING_STATUSES` _(its own module uses it)_
- `ppe/deephaven-dscr-prepay-maxprice.js :: lockTermLlpaTables` _(its own module uses it)_ — the raw lock-term tables; the compiler reads them inside this module
- `ppe/deephaven-dscr-prepay-maxprice.js :: maxPriceLpMilli` _(its own module uses it)_ — the measured Lender Price ceiling this block was built from — kept as the source figure, read inside this module
- `ppe/deephaven-dscr-prepay-maxprice.js :: prepayLlpaTables` _(its own module uses it)_ — the raw prepayment tables the compiler reads inside this module
- `ppe/deephaven-dscr-sheet.js :: LP_TABLES`
- `ppe/disqualifier-reconciler.js :: defaultLayerOf` _(its own module uses it)_
- `ppe/disqualifier-reconciler.js :: ourVerdictFromQuote` _(its own module uses it)_
- `ppe/disqualifier-reconciler.js :: PPP_DIMENSIONS` _(its own module uses it)_
- `ppe/disqualifier-review-store.js :: itemKey` _(its own module uses it)_
- `ppe/disqualifier-review-store.js :: rowToItem` _(its own module uses it)_
- `ppe/disqualifier-review.js :: CLASSIFICATIONS` _(its own module uses it)_
- `ppe/disqualifier-review.js :: inWords` _(its own module uses it)_
- `ppe/divergence.js :: explainSimple` _(its own module uses it)_
- `ppe/finding-store.js :: upsertRecord` _(its own module uses it)_
- `ppe/lp-decline-sentence.js :: decodeClause` _(its own module uses it)_ — the per-clause step `decodeSentence` composes. MEASURED: making it always refuse fails 27 assertions
- `ppe/lp-normalize-full.js :: programRe` _(its own module uses it)_ — builds the program-family matcher from an LP scope; used by the scope filter in this module
- `ppe/lp-scope.js :: EQUALITY_KEYS` _(its own module uses it)_
- `ppe/overlay.js :: overlayReasonsOf` _(its own module uses it)_
- `ppe/ppp-unresolved.js :: fieldUsable` _(its own module uses it)_ — decides whether one fact is usable for a state rule; used inside the missing-fact rule
- `ppe/ppp-unresolved.js :: NUMERIC_FIELDS` _(its own module uses it)_ — which prepayment facts must read as numbers; used inside this module and asserted against the definition
- `ppe/price-limit.js :: listScenarioRules` — lists the scenario-level cap rules a sheet publishes; exported so the suite can assert the set without pricing anything
- `ppe/pricing.js :: DEFAULT_ROUNDING_INCREMENT_MILLI` _(its own module uses it)_
- `ppe/pricing.js :: roundToIncrement`
- `ppe/purpose.js :: isKnownPurpose`
- `ppe/quote.js :: unpriceableReasons` _(its own module uses it)_ — every reason a scenario cannot be priced confidently; used by `quoteProgram`, exported so each reason can be asserted without pricing
- `ppe/ratesheet-agreement.js :: KNOWN_UNENCODED_FAMILIES` _(its own module uses it)_
- `ppe/ratesheet-agreement.js :: WHAT_IS_NOT_STORED` _(its own module uses it)_
- `ppe/ratesheet-diff.js :: CANONICALIZER_VERSION` _(its own module uses it)_
- `ppe/ratesheet-diff.js :: stableJson` _(its own module uses it)_
- `ppe/ratesheet.js :: translateRoundingMode` _(its own module uses it)_
- `ppe/review-queue.js :: priorityScore` _(its own module uses it)_
- `ppe/review-queue.js :: SEVERITY_BY_KIND` _(its own module uses it)_
- `ppe/rule-authoring-store.js :: rowToDraft` _(its own module uses it)_ — the row→draft mapper; every read in this store already goes through it, so nothing outside needs it
- `ppe/rule-authoring-store.js :: targetRuleset` _(its own module uses it)_ — loads the ruleset a draft would land in; used inside `checkDraft`, exported so the DB suite can assert the scoping directly
- `ppe/rule-authoring.js :: DIMENSION_LABELS` _(its own module uses it)_ — the dimension wording; the board gets it through the catalog on the list route, and the suite asserts against this definition
- `ppe/rule-authoring.js :: INTENTS` _(its own module uses it)_ — the intent vocabulary; served to the board inside the catalog, asserted here rather than retyped
- `ppe/rule-authoring.js :: predicateText` _(its own module uses it)_ — the predicate half of `renderRule`; exported so each node shape can be asserted on its own
- `ppe/rule-authoring.js :: resultText` _(its own module uses it)_ — the result half of `renderRule`; same reason
- `ppe/schedule-store.js :: rowToSchedule` _(its own module uses it)_
- `ppe/scoreboard.js :: latestRunSummary` _(its own module uses it)_
- `ppe/settings-admin.js :: COMPANY_SCOPE` _(its own module uses it)_ — the company slot name; used inside this module and asserted against the definition rather than retyped
- `ppe/settings-admin.js :: layerName` _(its own module uses it)_ — plain-English name for a settings layer, used in the refusals this module writes
- `ppe/settings-admin.js :: valueRefusalMessage` _(its own module uses it)_ — the wording of a rejected value; used inside the validator, exported so the message can be asserted without a write
- `ppe/store.js :: loadSettingOverridesStrict` _(its own module uses it)_ — the strict settings read (it propagates a failure rather than degrading, which is what the PRICING path needs); the two resolvers in this module call it, and the suite asserts the strict-vs-degrading split directly
- `ppe/store.js :: officerIdOfScope`
- `ppe/store.js :: priceLimitChangedFields` _(its own module uses it)_ — names which fields of a price limit actually moved; used by the audited write in this module so a no-op is never recorded as a change
- `ppe/store.js :: priceLimitShape` _(its own module uses it)_ — the canonical price-limit shape the audit records at both ends; used inside the write, exported so the suite asserts against the definition
- `routes/dscr-pricer.js :: CORE_FIELDS` _(its own module uses it)_
- `routes/settings.js :: PERSONAL_KEYS` _(its own module uses it)_
- `settings/store.js :: DEFAULT_SCOPE` _(its own module uses it)_
- `stages.js :: tpoStatusOf`
- `sync/loans.js :: readLoan` _(its own module uses it)_
- `views.js :: defaultView`

## Named by a test and by no production code (181)

This is the §2.45 / §2.46 shape exactly — built, tested, and asked by nothing — and it is also the
shape of a perfectly good exported table that a suite asserts against. The list is watched, not
banned.

- `access.js :: DEFAULT_ADMIN_ROLES` _(its own module uses it)_
- `access.js :: DEFAULT_ROLE_SCOPES` _(its own module uses it)_
- `access.js :: longTermRoleFor` _(its own module uses it)_
- `access.js :: LT_ROLES` _(its own module uses it)_
- `access.js :: SCOPE_ALL` _(its own module uses it)_
- `audience.js :: INTERNAL_ONLY_KEYS` _(its own module uses it)_
- `audience.js :: mentionsInvestor`
- `audience.js :: REDACTION` _(its own module uses it)_
- `borrower-match.js :: groupLoansByEmail` _(its own module uses it)_
- `client-view.js :: CLIENT_LOAN_FIELDS` _(its own module uses it)_ — the allowlist its own sweep asserts against, so the test can never drift from the definition
- `client-view.js :: withheldFields` — the same — what was held back, read by the sweep
- `encompass/client.js :: tokenProbe`
- `encompass/conditions.js :: OBSERVED`
- `encompass/dropdowns.js :: isKnownValue`
- `encompass/formulas.js :: DSCR_RATIO`
- `encompass/formulas.js :: KNOWN_DEFECTS`
- `encompass/investors.js :: IDENTITY_CHAIN` _(its own module uses it)_
- `encompass/investors.js :: INVESTOR_LOAN_NUMBER_FIELD` _(its own module uses it)_
- `encompass/investors.js :: INVESTOR_LOAN_NUMBER_OWNER_CONFIRMED` _(its own module uses it)_
- `encompass/investors.js :: sameInvestor` _(its own module uses it)_
- `encompass/mismo.js :: ULAD` _(its own module uses it)_
- `encompass/terms.js :: amortizingMonths` _(its own module uses it)_
- `lenderprice/capture.js :: CAPTURE_KINDS` _(its own module uses it)_ — the closed kind list; the suite reads it to prove no call site can hand the sink a computed kind
- `lenderprice/capture.js :: looksSecretKey` _(its own module uses it)_ — the key test the scrub is built on; the suite drives it directly AND through `capture()`
- `lenderprice/capture.js :: readCapture` — reads one stored payload back — the suite's way of proving what landed on disk
- `lenderprice/capture.js :: scrubSecrets` _(its own module uses it)_ — the credential scrub; called by `capture()` on both the payload and the index, and deliberately proven THROUGH the door (§2.112 — a scrub the sink does not call is the failure this exists to prevent)
- `lenderprice/citizenship.js :: FOREIGN_NATIONAL_TOKEN` _(its own module uses it)_ — the canonical token; the vendor door uses the mapper, the suite pins the token itself so a rename is caught
- `lenderprice/citizenship.js :: FOREIGN_NATIONAL_TOKENS` _(its own module uses it)_ — every spelling the vendor has been seen to use; read by the suite as the closed list
- `lenderprice/citizenship.js :: isForeignNationalToken` _(its own module uses it)_ — the membership test behind the mapper; pinned directly because a foreign national priced as a citizen is a money defect (§2.x, task #149)
- `lenderprice/client.js :: buildSearchPayload`
- `lenderprice/client.js :: hasStoredSearch`
- `lenderprice/client.js :: loginSelfTest`
- `lenderprice/disqualify-store.js :: _setDb`
- `lenderprice/echo-check.js :: CHECKED_DYNAMICS` _(its own module uses it)_
- `lenderprice/echo-check.js :: VENDOR_COMPUTED` _(its own module uses it)_
- `lenderprice/search-model.js :: clearScenarioOwnedFields` _(its own module uses it)_
- `lenderprice/search-model.js :: LpValidationError` _(its own module uses it)_
- `lenderprice/search-model.js :: mergeKnownRequestDefaults` _(its own module uses it)_
- `lenderprice/search-model.js :: validateInputs` _(its own module uses it)_
- `lenderprice/search-model.js :: validateLocation` _(its own module uses it)_
- `lib/encompass-milestones.js :: countMilestones`
- `locks.js :: DEFAULT_LOCKED_WORDS` _(its own module uses it)_
- `locks.js :: DEFAULT_UNLOCKED_WORDS` _(its own module uses it)_
- `locks.js :: postureFor` _(its own module uses it)_
- `milestones.js :: decideMilestoneEvent` _(its own module uses it)_
- `milestones.js :: EVENT_BASELINE` _(its own module uses it)_
- `milestones.js :: EVENT_ENTERED` _(its own module uses it)_
- `people/contacts.js :: confirmedLinkMap` _(its own module uses it)_
- `people/contacts.js :: contactsFromFields` _(its own module uses it)_
- `people/contacts.js :: DEFAULT_ROLES` _(its own module uses it)_
- `people/contacts.js :: reassignProblem` _(its own module uses it)_
- `people/contacts.js :: setOverride` _(its own module uses it)_
- `people/contacts.js :: writeContacts` _(its own module uses it)_
- `people/roster.js :: toRosterRow` _(its own module uses it)_
- `people/roster.js :: USERS_PATH` _(its own module uses it)_
- `pipeline-book.js :: folderKey` _(its own module uses it)_
- `pipeline-columns.js :: DEFAULT_ORDER` _(its own module uses it)_
- `pipeline.js :: buildFacetQueries` _(its own module uses it)_
- `pipeline.js :: DEFAULT_SORT` _(its own module uses it)_
- `pipeline.js :: ignoredScopeFilters` _(its own module uses it)_
- `pipeline.js :: NO_STAGE` _(its own module uses it)_
- `pipeline.js :: stageChips` _(its own module uses it)_
- `ppe/advanced-facts.js :: ADVANCED_FACTS` _(its own module uses it)_
- `ppe/advanced-facts.js :: getAdvancedFact`
- `ppe/advanced-facts.js :: isAdvancedFact`
- `ppe/advanced-facts.js :: lpPricedKeys` _(its own module uses it)_
- `ppe/agreement-dimensions.js :: soleLeafFact` _(its own module uses it)_
- `ppe/agreement-preflight.js :: runOursOnly` _(its own module uses it)_
- `ppe/agreement-priced-probe.js :: classifyQuote` _(its own module uses it)_
- `ppe/agreement-priced-probe.js :: probeBlocker`
- `ppe/agreement-provenance.js :: coversWholeBattery` _(its own module uses it)_
- `ppe/agreement-provenance.js :: describeProvenance`
- `ppe/agreement-provenance.js :: NARROWERS` _(its own module uses it)_
- `ppe/agreement-store.js :: gateDecision` _(its own module uses it)_
- `ppe/agreement-store.js :: incomparableOf` _(its own module uses it)_ — reads a stored run's incomparable reason; the suite uses it to prove the reason survives the round trip
- `ppe/agreement-store.js :: provenanceCaveats` _(its own module uses it)_
- `ppe/canary-clock.js :: EASTERN_HOURS` _(its own module uses it)_ — the owner's six scheduled hours; read inside this module's own tick decision, exported so the suite asserts the hours rather than retyping them
- `ppe/canary-driver.js :: classifyTick` _(its own module uses it)_ — the timing-hold vs cannot-ever-run split, asserted directly by the driver suite
- `ppe/canary-driver.js :: driverEnabled` _(its own module uses it)_ — the off-switch reader; the suite drives its whole truth table
- `ppe/canary-driver.js :: healthOf` _(its own module uses it)_
- `ppe/canary-driver.js :: intervalMsOf` _(its own module uses it)_ — the interval floor reader; same
- `ppe/canary-driver.js :: leaseMsOf` _(its own module uses it)_ — the lease-length reader; same
- `ppe/canary-driver.js :: lockKeyFor` _(its own module uses it)_ — the lease key; the suite races two contenders through it
- `ppe/canary-driver.js :: SOURCE_CRON` _(its own module uses it)_ — the source labels the driver stamps a run with; compared inside this module, exported so a suite names them rather than spelling the strings
- `ppe/canary-driver.js :: SOURCE_TIMER` _(its own module uses it)_ — same pair, and the default when a caller names no source
- `ppe/canary-schedule.js :: MAX_BATTERY_SCENARIOS` _(its own module uses it)_
- `ppe/canary-schedule.js :: MAX_INTERVAL_MS` _(its own module uses it)_
- `ppe/coverage.js :: oneFieldGoldens`
- `ppe/cutover-ledger.js :: lastTransitionTo` _(its own module uses it)_
- `ppe/cutover-store.js :: listHistory` _(its own module uses it)_
- `ppe/deephaven-dscr-prepay-maxprice.js :: extensionAdjustment` _(its own module uses it)_ — the lock-extension LLPA lookup; the sheet is consumed through `deephavenPriceLimitRules`, and the suite asserts this table cell by cell
- `ppe/deephaven-dscr-prepay-maxprice.js :: extensionProblem` _(its own module uses it)_ — the extension refusal wording; same — asserted directly rather than through a whole quote
- `ppe/deephaven-dscr-prepay-maxprice.js :: loanAmountCapTiers` _(its own module uses it)_ — the loan-size cap tiers; `price-limit.js` reads them through the compiled rules, and the suite asserts the tiers themselves
- `ppe/deephaven-dscr-prepay-maxprice.js :: loanAmountMaxPrice` _(its own module uses it)_ — the tier lookup behind those caps; asserted band by band
- `ppe/deephaven-dscr-prepay-maxprice.js :: lockTermAdjustment` — the lock-term LLPA lookup; consumed through the compiled rules, asserted here
- `ppe/deephaven-dscr-prepay-maxprice.js :: lockTermFacts` _(its own module uses it)_ — the fact keys the lock-term rules read; exported so the suite can prove every one is published
- `ppe/deephaven-dscr-prepay-maxprice.js :: prepayFactsFor` _(its own module uses it)_ — the prepayment fact set for a scenario; exported so the suite can assert the vocabulary directly
- `ppe/deephaven-dscr-prepay-maxprice.js :: prepayLlpa` — the prepayment LLPA lookup; consumed through the compiled rules, asserted here
- `ppe/deephaven-dscr-prepay-maxprice.js :: prepayMaxPrice` _(its own module uses it)_ — the prepayment price ceiling lookup; asserted structure by structure
- `ppe/deephaven-dscr-prepay-maxprice.js :: resolveHoldbackMilli` _(its own module uses it)_ — resolves the holdback this block prices against; called by the four builders in this file
- `ppe/deephaven-matrix.js :: gridCell` _(its own module uses it)_
- `ppe/deephaven-overlay-rules.js :: _cuts`
- `ppe/deephaven-ppp-matrix.js :: normBorrowerType` _(its own module uses it)_
- `ppe/deephaven-ppp-matrix.js :: STATE_RULES` _(its own module uses it)_
- `ppe/deephaven-ppp-matrix.js :: STATE_WHEN_KEYS` _(its own module uses it)_ — the condition keys a state rule may test; the compiler reads them, and the suite proves every key has a handler
- `ppe/divergence.js :: diagnose` _(its own module uses it)_ — the diagnosis itself. It went dark in §2.78 and that IS the fix: `attachDiagnosis` moved into this module and calls it as a bare local, so the one place it is used is the same file, and both live callers (the canary runner and the facade) reach it through `attachDiagnosis`. Its suite asserts it directly rather than through a whole comparison.
- `ppe/divergence.js :: explainPriceDivergence` _(its own module uses it)_
- `ppe/field-manifest-meta.js :: describeField` _(its own module uses it)_
- `ppe/finding.js :: RATE_KINDS` _(its own module uses it)_
- `ppe/lp-agreement-legs.js :: UNRESOLVED_PPP_POLICIES` _(its own module uses it)_ — the two policies a caller must choose between; the route names one explicitly, and the suite asserts the set rather than retyping it
- `ppe/lp-container-partition.js :: isContainerPartitionReason` — a boolean wrapper over `classifyReason`, which IS the definition and IS called by `disqualifier-reconciler` and `disqualify-crosswalk` on the live path. Nothing is dark behind it
- `ppe/lp-decline-sentence.js :: readNumber` _(its own module uses it)_ — the number reader (leading decimals, MM/M/K); the suite drives it directly — 13 assertions
- `ppe/lp-decline-sentence.js :: splitClauses` _(its own module uses it)_ — the comma/colon split whose thousands-separator rule was a real defect (§2.111); driven directly — 8 assertions
- `ppe/lp-normalize-full.js :: llpaSortKey` _(its own module uses it)_ — the deterministic LLPA order (§2.x, the vendor returns them shuffled); the suite drives it directly
- `ppe/lp-scope.js :: MAX_LEN` _(its own module uses it)_
- `ppe/lp-scope.js :: safePattern` _(its own module uses it)_
- `ppe/parity-cell-store.js :: comparabilityOf` _(its own module uses it)_
- `ppe/parity-cell-store.js :: MAX_CELLS_PER_RUN` _(its own module uses it)_
- `ppe/parity-cell-store.js :: rowsFromMatrix` _(its own module uses it)_
- `ppe/parity-cell-store.js :: rowToCell` _(its own module uses it)_
- `ppe/parity-matrix.js :: bandsFromProgram` _(its own module uses it)_
- `ppe/parity-matrix.js :: reconcilesAll` _(its own module uses it)_
- `ppe/parity.js :: isOverlayResult` _(its own module uses it)_
- `ppe/ppp-structures.js :: PPP_STRUCTURES` _(its own module uses it)_ — the prepayment-structure library itself; the rule board reads it through `rule-authoring.catalog`, and the suite asserts against this definition rather than retyping it
- `ppe/price-limit.js :: CAP_STATUS` _(its own module uses it)_ — the cap-status vocabulary; the quote carries a value from it, and the suite asserts against this definition rather than retyping the strings
- `ppe/pricing-breakdown.js :: humanLabel` _(its own module uses it)_
- `ppe/pricing.js :: interpolatePrice` _(its own module uses it)_
- `ppe/pricing.js :: pointsToPrice`
- `ppe/pricing.js :: roundPrice` _(its own module uses it)_
- `ppe/program-audit.js :: auditProgramMatrix`
- `ppe/program-engine.js :: reconcileUnverifiable` _(its own module uses it)_
- `ppe/program-engine.js :: REQUIRED_SLOTS` _(its own module uses it)_
- `ppe/purpose.js :: CASHOUT` _(its own module uses it)_
- `ppe/quote.js :: activeBasisFacts` _(its own module uses it)_ — the pricing-basis dependencies live for THIS program; used by the refusal, exported so the table can be asserted directly
- `ppe/quote.js :: PRICING_BASIS_FACTS` _(its own module uses it)_ — the declaration itself — which scenario facts the pricing BASIS reads outside any rule; the suite scans the source against it
- `ppe/quote.js :: RUNG_SELECTION_FACTS` — the facts that choose WHICH rungs rather than their price; the source scan needs both lists to tell a real hole from a selector
- `ppe/ratesheet-agreement-diff.js :: lpLlpaDimension` _(its own module uses it)_
- `ppe/ratesheet-agreement.js :: DECLINE_ROWS_PER_SCENARIO` _(its own module uses it)_
- `ppe/ratesheet-agreement.js :: DIMENSION_ROWS_PER_SCENARIO` _(its own module uses it)_
- `ppe/ratesheet-agreement.js :: DISAGREEMENT_SAMPLE` _(its own module uses it)_
- `ppe/ratesheet-agreement.js :: memoizeLeg` _(its own module uses it)_ — the ask-each-question-once wrapper (§2.95); the suite drives it directly to count the calls it saved
- `ppe/ratesheet-agreement.js :: REASON_TEXT_MAX` _(its own module uses it)_
- `ppe/ratesheet.js :: ineligibilityToRule` _(its own module uses it)_
- `ppe/rule-authoring.js :: verifyDimensionLabels` — a self-check that every dimension carries a label — an operator/suite command, deliberately not on a request path
- `ppe/rule-store.js :: coverageAfterAcceptSafe` _(its own module uses it)_
- `ppe/rule-store.js :: coverageForAcceptedRule` _(its own module uses it)_
- `ppe/rule-store.js :: dedupeKeyOf` _(its own module uses it)_
- `ppe/rule-store.js :: rowToRule` _(its own module uses it)_
- `ppe/rules.js :: declaredAbsentFacts` _(its own module uses it)_ — the facts whose ABSENCE a rule set itself gives a meaning to; used by the evaluator, exported so the carve-out can be asserted directly
- `ppe/rules.js :: evalPredicate3` _(its own module uses it)_ — the three-valued (true/false/unknown) predicate pass that runs beside the boolean one; exported so the Kleene truth table can be asserted node by node
- `ppe/rules.js :: missingFactsOf` _(its own module uses it)_ — which facts a rule needs and this scenario lacks; used by the evaluator, exported for its own assertions
- `ppe/run-store.js :: partitionReadable` — §2.126b wired the READABILITY DECISION, not this wrapper: `scoreboard.assemble` and this function both go through `agreement-provenance.recordIsReadable`, so there is one definition and this split is the store's own convenience. Its suite drives it directly
- `ppe/schedule-store.js :: loadSchedule`
- `ppe/scoreboard.js :: dailySeries` _(its own module uses it)_
- `ppe/settings-admin.js :: checkKeyForTarget` _(its own module uses it)_ — refuses a key at a slot it does not belong to; used inside the batch plan, exported so the whole refusal table can be asserted
- `ppe/store.js :: investorCodeOfScope` — reads the investor code back out of a scope string; used by the settings layer here
- `ppe/store.js :: loadInvestorOverrides` _(its own module uses it)_
- `ppe/store.js :: loadOfficerOverrides` _(its own module uses it)_
- `ppe/store.js :: normAlias` _(its own module uses it)_
- `ppe/store.js :: publishRateSheetVersionUnchecked` _(its own module uses it)_
- `ppe/store.js :: resolveMarginHoldbackForInvestor` _(its own module uses it)_
- `ppe/store.js :: resolveSetting`
- `product-term.js :: productSql`
- `product-term.js :: programSaysShortTerm` _(its own module uses it)_
- `product-term.js :: splitByProduct`
- `product.js :: PRODUCT_KEY` _(its own module uses it)_
- `product.js :: PRODUCT_LABEL` _(its own module uses it)_
- `routes/dscr-pricer.js :: META_FIELDS` _(its own module uses it)_
- `settings/encompass-settings.js :: classifyProgram`
- `stages.js :: DEFAULT_MAP` _(its own module uses it)_
- `stages.js :: DEFAULT_STAGES` _(its own module uses it)_
- `sync/discover.js :: buildFilter` _(its own module uses it)_
- `sync/discover.js :: DISCOVERY_FIELDS` _(its own module uses it)_
- `sync/discover.js :: parseAmount` _(its own module uses it)_
- `sync/discover.js :: parsePipelineDate` _(its own module uses it)_
- `sync/discover.js :: rowToLoan` _(its own module uses it)_
- `sync/loans.js :: needsRead` _(its own module uses it)_
- `sync/loans.js :: stageFor` _(its own module uses it)_
- `sync/loans.js :: upsertDiscovered` _(its own module uses it)_
- `views.js :: sanitizeFilters` _(its own module uses it)_
- `views.js :: sanitizeName` _(its own module uses it)_
