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

## Referenced nowhere at all (115)

Not by production code and not by a test. Nothing asks for these, so nothing would notice if one were
wrong.

- `access.js :: ADMIN_FLOOR_ROLE`
- `access.js :: effectiveStaffIdOf`
- `access.js :: SCOPE_OWN`
- `access.js :: scopeForRole`
- `audience.js :: AMBIGUOUS_ALONE`
- `audience.js :: CLIENT_AUDIENCES`
- `audience.js :: INTERNAL_ONLY`
- `audience.js :: internalOnlyFieldIds`
- `borrower-match.js :: SHADOW_EMAIL_DOMAINS`
- `client-view.js :: isInternalColumn` — internal to the column guard; exported for symmetry with the allowlist and used only there
- `client-view.js :: NOT_NUMBERED` — the sentinel for a field with no Encompass number; internal
- `encompass/formulas.js :: CREDIT_SCORE_LOGIC`
- `encompass/formulas.js :: OTHER_FORMULAS`
- `encompass/index.js :: familyOf`
- `encompass/loan-anatomy.js :: BORROWER_PAIRS`
- `encompass/loan-anatomy.js :: DSCR_STAGE_DISTRIBUTION`
- `encompass/loan-anatomy.js :: HOUSING_EXPENSE`
- `encompass/loan-anatomy.js :: LOAN_ROOT`
- `file.js :: describeResidence`
- `lenderprice/client.js :: enrichZip`
- `lenderprice/client.js :: fetchDefaultSearch`
- `lenderprice/client.js :: fetchSmoRegistry`
- `lenderprice/client.js :: mapPrepay`
- `lenderprice/client.js :: mapPropertyType`
- `lenderprice/client.js :: reauthenticate`
- `lenderprice/client.js :: requireLiveFoundation`
- `lenderprice/client.js :: searchRawWithRecovery`
- `locks.js :: datesFromFields`
- `people/contacts.js :: DEFAULT_ENCOMPASS_ROLE_NAMES`
- `people/contacts.js :: MIN_REASON`
- `people/contacts.js :: roleConfig`
- `people/links.js :: staffIdForLogin`
- `people/match.js :: DEFAULT_PLACEHOLDER_EMAILS`
- `people/roster.js :: fetchRoster`
- `pipeline-book.js :: BOOKS`
- `ppe/adjustment-overlap.js :: collisionsIn` — the overlap primitive its own suite asserts through; the pricing path calls `resolveDoubleCharges`, which wraps it
- `ppe/agreement-dimensions.js :: soleLeafFact`
- `ppe/agreement-scenario-generator.js :: collectThresholds`
- `ppe/agreement-scenario-generator.js :: falsifyLeaf`
- `ppe/agreement-scenario-generator.js :: satisfyLeaf`
- `ppe/agreement-store.js :: KIND_OVERRIDE`
- `ppe/agreement-store.js :: KIND_RUN`
- `ppe/canary-driver.js :: DEFAULT_LEASE_MS` — the default beside it; internal
- `ppe/canary-driver.js :: ON_VALUES` — the only strings that mean ON; internal to driverEnabled
- `ppe/canary-driver.js :: recordDenied` — writes the turned-away instance onto the state row; internal
- `ppe/canary-driver.js :: recordOutcome` — writes the tick result onto the state row; internal
- `ppe/canary-driver.js :: TIMING_HOLDS` — the timing-hold set; internal to classifyTick
- `ppe/canary-schedule.js :: MINUTE_MS`
- `ppe/cutover.js :: OPEN_FINDING_STATUSES`
- `ppe/disqualifier-reconciler.js :: defaultLayerOf`
- `ppe/disqualifier-reconciler.js :: normalizeAuthority`
- `ppe/disqualifier-reconciler.js :: ourVerdictFromQuote`
- `ppe/disqualifier-reconciler.js :: PPP_DIMENSIONS`
- `ppe/disqualifier-reconciler.js :: reconcileLayer`
- `ppe/disqualify-crosswalk.js :: featureLeaf`
- `ppe/disqualify-crosswalk.js :: findState`
- `ppe/disqualify-crosswalk.js :: inferOperator`
- `ppe/disqualify-crosswalk.js :: thresholdLeaf`
- `ppe/divergence.js :: explainSimple`
- `ppe/facade.js :: DEEP_ONLY`
- `ppe/facade.js :: deepCompare`
- `ppe/facade.js :: deepRecordable`
- `ppe/facade.js :: lpLadder`
- `ppe/facade.js :: parityLabel`
- `ppe/lp-normalize-full.js :: rungOf`
- `ppe/lp-scope.js :: EQUALITY_KEYS`
- `ppe/overlay.js :: overlayReasonsOf`
- `ppe/parity-matrix.js :: addToCell`
- `ppe/parity-matrix.js :: emptyCell`
- `ppe/parity-matrix.js :: finishCell`
- `ppe/pricing-breakdown.js :: normRungFromLpRung`
- `ppe/pricing-breakdown.js :: pickRung`
- `ppe/pricing.js :: DEFAULT_ROUNDING_INCREMENT_MILLI`
- `ppe/pricing.js :: roundToIncrement`
- `ppe/ratesheet-agreement.js :: declineMismatchRows`
- `ppe/ratesheet-agreement.js :: KNOWN_UNENCODED_FAMILIES`
- `ppe/ratesheet-agreement.js :: matchByRate`
- `ppe/ratesheet-agreement.js :: ourAdjustmentsOf`
- `ppe/ratesheet-agreement.js :: WHAT_IS_NOT_STORED`
- `ppe/ratesheet-agreement.js :: worstRungOf`
- `ppe/ratesheet-diff.js :: CANONICALIZER_VERSION`
- `ppe/ratesheet-diff.js :: stableJson`
- `ppe/review-queue.js :: priorityScore`
- `ppe/review-queue.js :: SEVERITY_BY_KIND`
- `ppe/rule-authoring-store.js :: rowToDraft` — the row→draft mapper; every read in this store already goes through it, so nothing outside needs it
- `ppe/rule-authoring-store.js :: targetRuleset` — loads the ruleset a draft would land in; used inside `checkDraft`, exported so the DB suite can assert the scoping directly
- `ppe/rule-authoring.js :: collisionFindings` — one of the checks `checkRule` composes; exported so its own truth table can be asserted without going through the whole check
- `ppe/rule-authoring.js :: coverageWarnings` — same — a composed check, exported for its own assertions
- `ppe/rule-authoring.js :: DIMENSION_LABELS` — the dimension wording; the board gets it through the catalog on the list route, and the suite asserts against this definition
- `ppe/rule-authoring.js :: dimensionOfFact` — used by `catalog`; exported so the fact→dimension map can be asserted fact by fact
- `ppe/rule-authoring.js :: INTENTS` — the intent vocabulary; served to the board inside the catalog, asserted here rather than retyped
- `ppe/rule-authoring.js :: labelOfFact` — used by the renderer; exported so every fact can be checked for a label
- `ppe/rule-authoring.js :: milliText` — milli→plain-English formatter used by `renderRule`; exported for its own rounding assertions
- `ppe/rule-authoring.js :: neverFiresRefusal` — a composed check inside `checkRule`; exported for its own assertions
- `ppe/rule-authoring.js :: plainShapeError` — turns a validator throw into plain words for a refusal; used inside this module
- `ppe/rule-authoring.js :: pppKeysIn` — walks a predicate for prepayment keys; used by `pppWarnings`, exported so the walk can be asserted on nested shapes
- `ppe/rule-authoring.js :: pppStructureRefusal` — a composed check inside `checkRule`; exported for its own assertions
- `ppe/rule-authoring.js :: pppWarnings` — a composed check inside `checkRule`; exported for its own assertions
- `ppe/rule-authoring.js :: predicateText` — the predicate half of `renderRule`; exported so each node shape can be asserted on its own
- `ppe/rule-authoring.js :: resultText` — the result half of `renderRule`; same reason
- `ppe/rule-builder.js :: factAppearsNested` — predicate-walk helper used by the builder; exported so the nesting cases can be asserted directly
- `ppe/rule-builder.js :: factContains` — same — a predicate-walk helper with its own assertions
- `ppe/rule-builder.js :: fromConjuncts` — builds an AND node from a list; used inside the builder, exported for its own shape assertions
- `ppe/rule-builder.js :: leafForDimension` — builds one dimension leaf; used inside the builder, exported so every dimension can be asserted
- `ppe/rule-coverage.js :: halfOpenStandard`
- `ppe/rule-coverage.js :: intersect`
- `ppe/rule-coverage.js :: regionsMeet`
- `ppe/rung-digest.js :: theirRungs`
- `ppe/scoreboard.js :: latestRunSummary`
- `ppe/store.js :: publishRateSheetVersionUnchecked`
- `routes/settings.js :: PERSONAL_KEYS`
- `settings/store.js :: DEFAULT_SCOPE`
- `stages.js :: tpoStatusOf`
- `sync/loans.js :: readLoan`
- `views.js :: defaultView`

## Named by a test and by no production code (166)

This is the §2.45 / §2.46 shape exactly — built, tested, and asked by nothing — and it is also the
shape of a perfectly good exported table that a suite asserts against. The list is watched, not
banned.

- `access.js :: DEFAULT_ADMIN_ROLES`
- `access.js :: DEFAULT_ROLE_SCOPES`
- `access.js :: longTermRoleFor`
- `access.js :: LT_ROLES`
- `access.js :: SCOPE_ALL`
- `audience.js :: INTERNAL_ONLY_KEYS`
- `audience.js :: mentionsInvestor`
- `audience.js :: REDACTION`
- `borrower-match.js :: groupLoansByEmail`
- `client-view.js :: CLIENT_LOAN_FIELDS` — the allowlist its own sweep asserts against, so the test can never drift from the definition
- `client-view.js :: withheldFields` — the same — what was held back, read by the sweep
- `encompass/client.js :: tokenProbe`
- `encompass/dropdowns.js :: isKnownValue`
- `encompass/formulas.js :: DSCR_RATIO`
- `encompass/formulas.js :: KNOWN_DEFECTS`
- `encompass/investors.js :: IDENTITY_CHAIN`
- `encompass/investors.js :: INVESTOR_LOAN_NUMBER_FIELD`
- `encompass/investors.js :: INVESTOR_LOAN_NUMBER_OWNER_CONFIRMED`
- `encompass/investors.js :: sameInvestor`
- `encompass/terms.js :: amortizingMonths`
- `file.js :: describeEmployment`
- `file.js :: sumOrNull`
- `lenderprice/client.js :: API_BASE`
- `lenderprice/client.js :: applyPollDelta`
- `lenderprice/client.js :: AUTH_BASE`
- `lenderprice/client.js :: authDiagnostics`
- `lenderprice/client.js :: basicClientAuthorization`
- `lenderprice/client.js :: buildSearchPayload`
- `lenderprice/client.js :: classifyUpstreamError`
- `lenderprice/client.js :: CLIENT_ID`
- `lenderprice/client.js :: DISQ_STORE`
- `lenderprice/client.js :: disqStore`
- `lenderprice/client.js :: expireRefreshBackoff`
- `lenderprice/client.js :: fetchPpeUserId`
- `lenderprice/client.js :: foundationLiveGate`
- `lenderprice/client.js :: foundationProvenance`
- `lenderprice/client.js :: hasStoredSearch`
- `lenderprice/client.js :: invalidateFoundation`
- `lenderprice/client.js :: invalidatePpeUser`
- `lenderprice/client.js :: invalidateSession`
- `lenderprice/client.js :: loginSelfTest`
- `lenderprice/client.js :: mergeRefreshed`
- `lenderprice/client.js :: recordRecovery`
- `lenderprice/client.js :: RECOVERY_MAX`
- `lenderprice/client.js :: REFRESH_GRANT_BACKOFF_MS`
- `lenderprice/client.js :: refreshBackoffMs`
- `lenderprice/client.js :: refreshSession`
- `lenderprice/client.js :: renewalPlan`
- `lenderprice/client.js :: requestIdOf`
- `lenderprice/client.js :: resetTokenState`
- `lenderprice/client.js :: searchKeyFor`
- `lenderprice/client.js :: sessionFromTokenBody`
- `lenderprice/client.js :: storeKickoff`
- `lenderprice/zip-county.js :: splitZipCount`
- `lenderprice/zip-county.js :: STATE_BY_FIPS`
- `lenderprice/zip-county.js :: zipCount`
- `locks.js :: dayDiff`
- `locks.js :: DEFAULT_LOCKED_WORDS`
- `locks.js :: DEFAULT_UNLOCKED_WORDS`
- `locks.js :: postureFor`
- `milestones.js :: decideMilestoneEvent`
- `milestones.js :: EVENT_BASELINE`
- `milestones.js :: EVENT_ENTERED`
- `people/contacts.js :: confirmedLinkMap`
- `people/contacts.js :: contactsFromFields`
- `people/contacts.js :: DEFAULT_ROLES`
- `people/contacts.js :: reassignProblem`
- `people/contacts.js :: setOverride`
- `people/contacts.js :: writeContacts`
- `people/roster.js :: loadStaff`
- `people/roster.js :: toRosterRow`
- `people/roster.js :: USERS_PATH`
- `people/roster.js :: writeSuggestions`
- `pipeline-book.js :: folderKey`
- `pipeline.js :: buildFacetQueries`
- `pipeline.js :: DEFAULT_SORT`
- `pipeline.js :: ignoredScopeFilters`
- `pipeline.js :: NO_STAGE`
- `pipeline.js :: stageChips`
- `ppe/advanced-facts.js :: ADVANCED_FACTS`
- `ppe/advanced-facts.js :: getAdvancedFact`
- `ppe/advanced-facts.js :: isAdvancedFact`
- `ppe/advanced-facts.js :: lpPricedKeys`
- `ppe/agreement-scenario-generator.js :: distinctFrom`
- `ppe/agreement-store.js :: gateDecision`
- `ppe/canary-driver.js :: classifyTick` — the timing-hold vs cannot-ever-run split, asserted directly by the driver suite
- `ppe/canary-driver.js :: driverEnabled` — the off-switch reader; the suite drives its whole truth table
- `ppe/canary-driver.js :: intervalMsOf` — the interval floor reader; same
- `ppe/canary-driver.js :: leaseMsOf` — the lease-length reader; same
- `ppe/canary-driver.js :: lockKeyFor` — the lease key; the suite races two contenders through it
- `ppe/canary-driver.js :: MIN_LEASE_MS` — the floor the suite asserts against rather than retyping
- `ppe/canary-driver.js :: tickOnce` — the one pass; start() calls it internally and the suite drives it directly
- `ppe/canary-schedule.js :: MAX_BATTERY_SCENARIOS`
- `ppe/canary-schedule.js :: MAX_INTERVAL_MS`
- `ppe/cutover.js :: consecutiveCleanDays`
- `ppe/deephaven-overlay-rules.js :: _cuts`
- `ppe/deephaven-overlay-rules.js :: FN_MAX_LOAN`
- `ppe/deephaven-overlay-rules.js :: FN_MIN_DSCR`
- `ppe/deephaven-overlay-rules.js :: FTI_MIN_DSCR`
- `ppe/deephaven-overlay-rules.js :: FTI_MIN_FICO`
- `ppe/deephaven-overlay-rules.js :: RURAL_MAX_LTV`
- `ppe/deephaven-overlay-rules.js :: STR_MAX_LTV`
- `ppe/deephaven-overlay-rules.js :: STR_MIN_FICO`
- `ppe/deephaven-ppp-matrix.js :: normBorrowerType`
- `ppe/deephaven-ppp-matrix.js :: STATE_RULES`
- `ppe/deephaven-ppp-matrix.js :: SUPPORTED_WHEN_KEYS`
- `ppe/deephaven-ppp-matrix.js :: WHEN_HANDLERS`
- `ppe/divergence.js :: explainPriceDivergence`
- `ppe/finding.js :: mergeOne`
- `ppe/finding.js :: RATE_KINDS`
- `ppe/lp-normalize-full.js :: llpasOf`
- `ppe/lp-scope.js :: MAX_LEN`
- `ppe/lp-scope.js :: safePattern`
- `ppe/parity-cell-store.js :: MAX_CELLS_PER_RUN`
- `ppe/parity-cell-store.js :: rowsFromMatrix`
- `ppe/parity-cell-store.js :: rowToCell`
- `ppe/parity-matrix.js :: bandIndex`
- `ppe/parity-matrix.js :: bandsFromProgram`
- `ppe/parity-matrix.js :: MAX_CELLS_PER_DIMENSION`
- `ppe/parity-matrix.js :: reconcilesAll`
- `ppe/ppp-structures.js :: PPP_STRUCTURES` — the prepayment-structure library itself; the rule board reads it through `rule-authoring.catalog`, and the suite asserts against this definition rather than retyping it
- `ppe/pricing-breakdown.js :: humanLabel`
- `ppe/pricing.js :: interpolatePrice`
- `ppe/pricing.js :: pointsToPrice`
- `ppe/pricing.js :: roundPrice`
- `ppe/ratesheet-agreement.js :: bestRungsOf`
- `ppe/ratesheet-agreement.js :: DECLINE_ROWS_PER_SCENARIO`
- `ppe/ratesheet-agreement.js :: declineOutcome`
- `ppe/ratesheet-agreement.js :: DIMENSION_ROWS_PER_SCENARIO`
- `ppe/ratesheet-agreement.js :: DISAGREEMENT_SAMPLE`
- `ppe/ratesheet-agreement.js :: disagreementRecord`
- `ppe/ratesheet-agreement.js :: programOf`
- `ppe/ratesheet-agreement.js :: REASON_TEXT_MAX`
- `ppe/ratesheet-agreement.js :: safeDigest`
- `ppe/ratesheet-agreement.js :: safeReconcileDeclines`
- `ppe/rule-authoring.js :: verifyDimensionLabels` — a self-check that every dimension carries a label — an operator/suite command, deliberately not on a request path
- `ppe/rule-store.js :: coverageAfterAcceptSafe`
- `ppe/rule-store.js :: coverageForAcceptedRule`
- `ppe/rule-store.js :: dedupeKeyOf`
- `ppe/rule-store.js :: rowToRule`
- `ppe/scoreboard.js :: dailySeries`
- `ppe/store.js :: clearSetting`
- `ppe/store.js :: currentRateSheetVersion`
- `ppe/store.js :: investorScope`
- `ppe/store.js :: loadSettingOverrides`
- `ppe/store.js :: normAlias`
- `ppe/store.js :: resolveMarginHoldbackForInvestor`
- `ppe/store.js :: resolveSetting`
- `ppe/store.js :: setSetting`
- `product-term.js :: productSql`
- `product-term.js :: programSaysShortTerm`
- `product-term.js :: splitByProduct`
- `settings/encompass-settings.js :: classifyProgram`
- `stages.js :: DEFAULT_MAP`
- `stages.js :: DEFAULT_STAGES`
- `sync/discover.js :: buildFilter`
- `sync/discover.js :: DISCOVERY_FIELDS`
- `sync/discover.js :: parseAmount`
- `sync/discover.js :: parsePipelineDate`
- `sync/discover.js :: rowToLoan`
- `sync/loans.js :: needsRead`
- `sync/loans.js :: stageFor`
- `sync/loans.js :: upsertDiscovered`
- `views.js :: FILTER_KEYS`
- `views.js :: sanitizeFilters`
- `views.js :: sanitizeName`
