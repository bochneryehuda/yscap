// Long-Term's OWN API client.
//
// Every call goes to /api/lt/*, through Long-Term's own fetch helper — never RTL's
// client, which the separation gate correctly refuses (Long-Term starts at zero;
// the one authorized front-end component crossing is BorrowerProfilePanel.jsx). It
// defines no RTL endpoint, and no RTL screen imports it.
//
// The one rule: a path here always starts `/api/lt/`. Anything else belongs to the
// other product.

import { ltGet, ltPost, ltPut, ltPatch, ltDel, ltDownload } from './http.js';

const lt = (p) => `/api/lt${p}`;

export const ltApi = {
  // Which side this person opens on, what they may do, and whether the Condition
  // Center has been switched on yet.
  me: () => ltGet(lt('/me')),
  setProduct: (product) => ltPut(lt('/me/product'), { product }),

  // The pipeline. Only the keys that are SET are sent: the server appends a filter
  // rather than OR-ing an unset one, so an empty string must not travel as a filter.
  pipeline(params = {}) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
    }
    const q = qs.toString();
    return ltGet(lt(`/pipeline${q ? `?${q}` : ''}`));
  },
  loan: (id) => ltGet(lt(`/pipeline/${encodeURIComponent(id)}`)),

  // Reassign one role on one file to a PILOT person — or, with `staffId` null,
  // clear the reassignment and go back to what Encompass says. Nothing is written
  // to Encompass either way; this only decides whose pipeline the file is in here.
  reassign: (loanId, role, { staffId = null, reason = '' } = {}) => ltPost(
    lt(`/pipeline/${encodeURIComponent(loanId)}/contacts/${encodeURIComponent(role)}/override`),
    { staffId, reason },
  ),

  // THE BORROWER'S OWN long-term files. Behind BORROWER authentication (the
  // /api/lt/my seam), unlike everything else here — so it is the one call on this
  // client a client makes. No id is sent: the scope comes from the session.
  //
  // It answers 200 with `enabled:false` when the owner has not switched the
  // borrower-facing side on, so the portal can tell "off" from "broken".
  myLoans: () => ltGet(lt('/my/loans')),

  // The BOOK — the owner's census of every long-term file, with the folder, the
  // status and the milestone each one sits in, plus how much of the borrower and
  // officer mapping is done. The spreadsheet is the SAME census from the same
  // route, so the screen and the download can never disagree about a count.
  book: () => ltGet(lt('/book')),
  bookCsv: () => ltDownload(lt('/book/export.csv'), 'long-term-book.csv'),

  // The BORROWER map — which PILOT borrower profile each long-term loan belongs
  // to. Confirming one is what puts a file on a client's own login, so every one
  // of these is a suggestion until an administrator presses the button.
  borrowerMap: () => ltGet(lt('/borrowers')),
  confirmBorrower: (email, borrowerId, opts = {}) =>
    ltPost(lt('/borrowers/confirm'), { email, borrowerId, ...(opts.force ? { force: true } : {}) }),
  rejectBorrower: (email) => ltPost(lt('/borrowers/reject'), { email }),
  unlinkBorrower: (email) => ltPost(lt('/borrowers/unlink'), { email }),

  // THE STATUS MAP — Encompass's milestones, our stages and the borrower's own
  // wording, side by side. Reading is its own route; SAVING goes through the
  // settings door below, because that is the one writer for a setting and a second
  // one here would be a second way to change the same thing.
  statusMap: () => ltGet(lt('/stages')),

  // The people map.
  people: () => ltGet(lt('/people')),
  syncRoster: () => ltPost(lt('/people/sync'), {}),
  confirmPerson: (loginId, staffId) => ltPost(lt(`/people/${encodeURIComponent(loginId)}/confirm`), { staffId }),
  rejectPerson: (loginId) => ltPost(lt(`/people/${encodeURIComponent(loginId)}/reject`), {}),
  unlinkPerson: (loginId) => ltDel(lt(`/people/${encodeURIComponent(loginId)}/link`)),

  // The loan sync.
  syncState: () => ltGet(lt('/sync')),
  runSync: (body = {}) => ltPost(lt('/sync'), body),

  // Saved pipeline views. A view carries FILTERS and never a scope — the server
  // appends them to whatever the signed-in person is allowed to see — so opening
  // somebody else's shared view can never show a row this person could not open.
  views: () => ltGet(lt('/views')),
  saveView: (body) => ltPost(lt('/views'), body),
  deleteView: (id) => ltDel(lt(`/views/${encodeURIComponent(id)}`)),

  // The settings. The COMPANY screen is drawn from `settings()` — the server's own
  // description of every group and every declaration — so this client never carries
  // a list of setting keys and cannot drift from the server's.
  settings: () => ltGet(lt('/settings')),
  saveSettings: (settings) => ltPatch(lt('/settings'), { settings }),
  resetSettings: (keys) => ltPost(lt('/settings/reset'), { keys }),

  // A person's OWN preferences. No id is sent: the scope comes from the session, so
  // there is nothing in the request that could point at somebody else.
  mySettings: () => ltGet(lt('/settings/mine')),
  saveMySettings: (settings) => ltPatch(lt('/settings/mine'), { settings }),

  // The Product & Pricing Engine. Lender Price stays authoritative — these read
  // the SHADOW: what our engine disagreed with, and how far it is from ready.
  // Every list is served pre-ordered by the server's own review queue, so this
  // client never sorts and cannot drift from "what to work on first".
  // The pricing engine's own SETTINGS — the parity tolerances, the rounding, the price
  // floor, the per-investor margin/holdback. The screen is drawn ENTIRELY from what the
  // server returns (`settings[]` carries the type, the range, the options, the default and
  // where the value in force came from), so this client holds no list of setting keys and
  // cannot drift from the server's.
  //
  // The SLOT is stated in words and never as a scope string: no investor reads/writes the
  // company-wide value, `investor` reads/writes that investor's own. The server refuses a
  // hand-built scope outright, which is what makes a per-investor value unable to land in
  // the global slot by accident.
  ppeSettings: (investor) => ltGet(lt(`/ppe/settings${investor ? `?investor=${encodeURIComponent(investor)}` : ''}`)),
  ppeSaveSettings: (target, settingsPatch) => ltPost(lt('/ppe/settings'), { ...target, settings: settingsPatch }),
  ppeClearSettings: (target, keys) => ltPost(lt('/ppe/settings/clear'), { ...target, keys }),
  ppeSettingsAudit(params = {}) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
    }
    const q = qs.toString();
    return ltGet(lt(`/ppe/settings/audit${q ? `?${q}` : ''}`));
  },

  ppeHealth: () => ltGet(lt('/ppe/health')),
  ppeInvestors: () => ltGet(lt('/ppe/investors')),
  ppeFindings(params = {}) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
    }
    const q = qs.toString();
    return ltGet(lt(`/ppe/findings${q ? `?${q}` : ''}`));
  },
  ppeScoreboard: (investor) => ltGet(lt(`/ppe/scoreboard?investor=${encodeURIComponent(investor)}`)),
  // The "mother interface" (owner-directed 2026-08-17) — the LP-style transparency view:
  // base price, every itemized LLPA/adjustment with its running effect, the final price,
  // and both engines' eligibility/disqualifications, for ONE scenario. The server assembles
  // the view over an already-priced scenario; this client never re-does the math.
  ppeBreakdown: (body) => ltPost(lt('/ppe/breakdown'), body),
  // THE SHADOW COMPARISON — Lender Price answers, our engine prices the same scenario
  // beside it, and every disagreement is written to the findings ledger.
  //
  // This is the ONLY caller of the only route that runs `facade.priceWithShadow` and
  // `finding-store.persistRun` outside a canary battery. Until it existed the ledger and
  // the parity-cell series had no producer a screen could reach, so an EMPTY pricing-engine
  // board was indistinguishable from a CLEAN one — a measurement surface reporting success
  // by having never run.
  //
  // IT COSTS A LIVE VENDOR CALL AND IT WRITES. Deliberately NOT wired to any load, poll or
  // form change: `LtShadowCompare` calls it from a click handler only, behind copy that
  // states the cost before the press. Do not call it from an effect.
  ppeQuote: (body) => ltPost(lt('/ppe/quote'), body),
  // Admin-only on the server. Called anyway from a non-admin's screen so the
  // REFUSAL is shown — a hidden button is indistinguishable from a broken one.
  ppeDecideFinding: (key, body) => ltPost(lt(`/ppe/findings/${encodeURIComponent(key)}/decide`), body),
  // WHERE the two engines disagree, run after run (P9). The scoreboard above carries ONE
  // agreement rate per day, from which per-band history cannot be recovered later — so this
  // is the only thing that can answer "has this band been off for three weeks, or was that
  // one bad afternoon?". The server RANKS by how persistently a cell has disagreed and holds
  // no threshold: what counts as clean enough belongs to the cutover decision, not to a list.
  // Passing `dimension` AND `cellKey` narrows to that one cell's day-by-day history.
  ppeParityCells(params = {}) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
    }
    const q = qs.toString();
    return ltGet(lt(`/ppe/parity-cells${q ? `?${q}` : ''}`));
  },

  // THE CANARY — the ONE producer of everything the two screens above read.
  //
  // `ppeFindings` and `ppeParityCells` are both READS of a ledger that only a canary run writes, and
  // until this method existed nothing in the product could write it: the route was reachable by a
  // hand-run curl and by nothing else, so the findings queue and the per-band series could only ever
  // show what somebody typed into a terminal. That is why the run button is owed to this console.
  //
  // IT COSTS MONEY. One live Lender Price call per scenario in the battery, every time. The screen
  // arms it behind a deliberate second confirmation and nothing on any page may call this on load —
  // the cost is the reason the client method is not enough on its own.
  //
  // The battery is the CALLER's: either `scenarios` (an array) or `matrix` (axes to expand). Nothing
  // here supplies a default, because an agreement rate measured over scenarios nobody chose still
  // feeds the promotion gate.
  ppeCanary: (body) => ltPost(lt('/ppe/canary'), body),

  // The DAILY cadence (D19). A saved schedule is not a running one — the server reports what the
  // runner would decide about each row, and the screen prints that verbatim rather than drawing a
  // saved-but-unrunnable schedule as armed.
  //
  // `investor` on the delete is the schedule's own key, and the company-wide row (no investor) is
  // addressed as '-' — the route's own convention. `scheduleTarget` in CanaryConsole.jsx is the one
  // place that translation is made.
  ppeCanarySchedules: () => ltGet(lt('/ppe/canary/schedules')),
  ppeSaveCanarySchedule: (body) => ltPost(lt('/ppe/canary/schedules'), body),
  ppeDeleteCanarySchedule: (investor) => ltDel(lt(`/ppe/canary/schedules/${encodeURIComponent(investor)}`)),

  // WHICH Lender Price programs each of our rate sheets is measured against (db/574).
  //
  // The write door has existed since the scope columns landed and nothing could reach it: it needs a
  // program's id, and no read surface published one — so no sheet could be scoped at all, and an
  // unscoped sheet's shadow comparison ABSTAINS. On a findings screen an abstention is
  // indistinguishable from two engines agreeing, which is why the list reports what is UNSCOPED
  // rather than only what is set. Reading is open; writing is admin-only on the server, and the
  // screen calls it anyway so the refusal is shown.
  ppePrograms: () => ltGet(lt('/ppe/programs')),
  ppeSetProgramLpScope: (id, body) => ltPost(lt(`/ppe/programs/${encodeURIComponent(id)}/lp-scope`), body),

  // The per-investor rule loop (P5/P7). Lender Price's own declines are mined into
  // PROPOSALS; a human accepts one and it becomes a real rule our engine enforces.
  // Nothing here is auto-applied — accept and dismiss are the only two ways a
  // suggestion leaves the list, and both are a deliberate person's click.
  ppeSuggestions(params = {}) {
    const q = new URLSearchParams();
    if (params.status) q.set('status', params.status);
    if (params.investor) q.set('investor', params.investor);
    const s = q.toString();
    return ltGet(lt(`/ppe/suggestions${s ? `?${s}` : ''}`));
  },
  ppeAcceptSuggestion: (id, body = {}) => ltPost(lt(`/ppe/suggestions/${encodeURIComponent(id)}/accept`), body),
  ppeDismissSuggestion: (id, body = {}) => ltPost(lt(`/ppe/suggestions/${encodeURIComponent(id)}/dismiss`), body),
  // MINE new proposals out of a Lender Price decline. It COSTS A LIVE VENDOR CALL when it is given a
  // `searchKey` — the server polls Lender Price for the disqualification result — so nothing on a
  // screen may fire it on load. It is a button, pressed by a person who has a search key in hand.
  ppeMineSuggestions: (body = {}) => ltPost(lt('/ppe/suggestions/mine'), body),

  // THE RULES IN FORCE, and what that set does to itself.
  //
  // Both routes existed with no caller. `/ppe/rules` is the stored set — house rules, an investor's,
  // a program's — which is the only place a person can see WHAT our engine enforces. `/rules/coverage`
  // is the advisory read over the set a program actually evaluates: PRICING rules that overlap (a loan
  // adjusted twice) and holes between banded ones. It refuses nothing and decides nothing.
  ppeRules(params = {}) {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') q.set(k, String(v));
    }
    const s = q.toString();
    return ltGet(lt(`/ppe/rules${s ? `?${s}` : ''}`));
  },
  ppeRuleCoverage(params = {}) {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') q.set(k, String(v));
    }
    const s = q.toString();
    return ltGet(lt(`/ppe/rules/coverage${s ? `?${s}` : ''}`));
  },

  // WHAT CHANGED between two versions of a rate sheet. A new version is loaded by pasting a vendor's
  // grid over the previous one, and "which cells actually moved" was answerable by nothing. Reads
  // only: no cell is applied, published or accepted by asking.
  ppeRateSheetDiff(id, params = {}) {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') q.set(k, String(v));
    }
    const s = q.toString();
    return ltGet(lt(`/ppe/rate-sheets/${encodeURIComponent(id)}/diff${s ? `?${s}` : ''}`));
  },

  // A program's Lender Price scope, READ FROM THE SERVER. The console sets a scope and re-reads it
  // from the write's own response, which proves the request was accepted and nothing about what is
  // stored. This is the read that can disagree with it.
  ppeProgramLpScope: (id) => ltGet(lt(`/ppe/programs/${encodeURIComponent(id)}/lp-scope`)),

  // ---- rule DRAFTS: authoring, which is not publishing -----------------------
  // The rule-authoring service (`ppe/rule-authoring.js` + its store, db/577) had no HTTP door at all.
  // These are the READ and DRAFT doors. A draft lives in its own table that nothing in the pricing
  // path reads, so none of these can move a priced number.
  //
  // There is deliberately NO `ppePublishRuleDraft`, and its absence is not an oversight: publishing a
  // rule DOES change what a loan is priced at, and who is allowed to do that is an open owner
  // question (§2.51 in docs/longterm/LENDER-PRICE-PARITY-STATUS.md). A method here would need a route,
  // and building the route behind the nearest available gate would answer the question by accident.
  ppeRuleDrafts(params = {}) {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') q.set(k, String(v));
    }
    const s = q.toString();
    return ltGet(lt(`/ppe/rule-drafts${s ? `?${s}` : ''}`));
  },
  ppeRuleDraft: (id) => ltGet(lt(`/ppe/rule-drafts/${encodeURIComponent(id)}`)),
  ppeRenderRuleDraft: (id) => ltGet(lt(`/ppe/rule-drafts/${encodeURIComponent(id)}/render`)),
  ppeSaveRuleDraft: (body) => ltPost(lt('/ppe/rule-drafts'), body),
  ppeDiscardRuleDraft(id, params = {}) {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') q.set(k, String(v));
    }
    const s = q.toString();
    return ltDel(lt(`/ppe/rule-drafts/${encodeURIComponent(id)}${s ? `?${s}` : ''}`));
  },

  // The DSCR FIELD MANIFEST (D28) — the machine-readable contract of what the pricer
  // accepts, split into {core, advanced, overlay, meta, counts}. It is what the Basic
  // vs Advanced scenario-entry screen draws itself from, so that screen carries no
  // field list of its own and cannot drift from what the pricer really accepts.
  //
  // The path is the DSCR pricer's own router mount (`/dscr`, src/longterm/index.js),
  // which is where the manifest handler is actually wired — NOT `/ppe/fields`, which
  // does not exist. Read-only and pure on the server (no Lender Price call).
  dscrFields: () => ltGet(lt('/dscr/fields')),

  // ---- onboarding + the rate-sheet console --------------------------------
  // These are the WRITERS that had no door: before them an investor could not be
  // onboarded through the product at all, and the ≥200-scenario Lender Price
  // agreement gate on the publish guarded something nothing could reach.
  //
  // There is deliberately NO method here that records an agreement RUN. A run comes
  // from the harness; a typed one would satisfy the gate with nothing compared. The
  // human path is `ppePublishRateSheet(id, { override, overrideReason })`, which the
  // server records against the version with the person's name on it.
  ppeCreateInvestor: (body) => ltPost(lt('/ppe/investors'), body),
  ppeCreateProgram: (body) => ltPost(lt('/ppe/programs'), body),
  ppeCreateRateSheet: (programId, body = {}) => ltPost(lt(`/ppe/programs/${encodeURIComponent(programId)}/rate-sheets`), body),
  ppeRateSheet: (id) => ltGet(lt(`/ppe/rate-sheets/${encodeURIComponent(id)}`)),
  ppeSetBasePrices: (id, rows) => ltPut(lt(`/ppe/rate-sheets/${encodeURIComponent(id)}/base-prices`), { rows }),
  ppeSetAdjustments: (id, rows) => ltPut(lt(`/ppe/rate-sheets/${encodeURIComponent(id)}/adjustments`), { rows }),
  ppeSetPriceLimit: (id, body) => ltPut(lt(`/ppe/rate-sheets/${encodeURIComponent(id)}/price-limit`), body),
  ppeRateSheetAgreement: (id) => ltGet(lt(`/ppe/rate-sheets/${encodeURIComponent(id)}/agreement`)),
  // The two checks a person runs on a sheet, and they are not interchangeable.
  //   · COVERAGE is FREE and offline: which of the sheet's own cells can nothing ever reach. Run it
  //     first — a transposed band should be fixed before a paid battery is spent on the sheet.
  //   · The RUN prices the whole canonical battery against Lender Price and RECORDS the verdict. It
  //     costs money and it is the only thing that can open the publish gate by measurement.
  // Neither takes a result from the caller: this one ASKS the server to measure, and there is still no
  // method anywhere that records a verdict somebody typed.
  ppeRateSheetCoverage: (id) => ltGet(lt(`/ppe/rate-sheets/${encodeURIComponent(id)}/coverage`)),
  ppeRunRateSheetAgreement: (id, body = {}) => ltPost(lt(`/ppe/rate-sheets/${encodeURIComponent(id)}/agreement/run`), body),
  ppePublishRateSheet: (id, body = {}) => ltPost(lt(`/ppe/rate-sheets/${encodeURIComponent(id)}/publish`), body),
};

export default ltApi;
