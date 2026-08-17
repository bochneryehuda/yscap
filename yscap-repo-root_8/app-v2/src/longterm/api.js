// Long-Term's OWN API client.
//
// Every call goes to /api/lt/*, through Long-Term's own fetch helper — never RTL's
// client, which the separation gate correctly refuses (Long-Term starts at zero;
// the one authorized front-end component crossing is BorrowerProfilePanel.jsx). It
// defines no RTL endpoint, and no RTL screen imports it.
//
// The one rule: a path here always starts `/api/lt/`. Anything else belongs to the
// other product.

import { ltGet, ltPost, ltPut, ltPatch, ltDel } from './http.js';

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
  ppePublishRateSheet: (id, body = {}) => ltPost(lt(`/ppe/rate-sheets/${encodeURIComponent(id)}/publish`), body),
};

export default ltApi;
