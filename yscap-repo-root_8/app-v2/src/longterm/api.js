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

  // The archive — Encompass's deleted loans, out of every pipeline view. Listing is
  // for admins; the permanent delete is the super-admin's (the server enforces both).
  archive: () => ltGet(lt('/archive')),
  archiveDelete: (id) => ltDel(lt(`/archive/${encodeURIComponent(id)}`)),
  archiveDeleteAll: () => ltPost(lt('/archive/delete-all'), {}),

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
  // The FULL pull — the whole book, not one 25-loan pass. It answers straight away
  // and works in the background, because a drain can run for ten minutes and no
  // browser will hold a request open that long.
  pullFromEncompass: () => ltPost(lt('/sync/pull'), {}),
  // The Condition Center's own pass, without re-reading every loan. Admin-only
  // on the server; called anyway from a non-admin's screen so the REFUSAL is
  // shown — a hidden button is indistinguishable from a broken one.
  runConditionSync: (body = {}) => ltPost(lt('/sync/conditions'), body),

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

  // The Condition Center, READ side. One call per loan gives BOTH feeds — this
  // loan's conditions with the documents that answer each one, and the eFolder
  // needs list — plus `face`, which says which of the two this file's work
  // actually is. There is deliberately no write here: nothing in the Condition
  // Center writes to Encompass or to us (the eFolder upload stays blocked).
  conditionCenter: (loanId) => ltGet(lt(`/conditions/${encodeURIComponent(loanId)}`)),

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
  // Admin-only on the server. Called anyway from a non-admin's screen so the
  // REFUSAL is shown — a hidden button is indistinguishable from a broken one.
  ppeDecideFinding: (key, body) => ltPost(lt(`/ppe/findings/${encodeURIComponent(key)}/decide`), body),

  // ---- THE PRICING ENGINE (owner-directed 2026-08-23) --------------------------
  // Two doors, and they are the whole engine. Both have been shipping, staff-gated,
  // since the DSCR pricer was written, and nothing in the product could reach them:
  // this file had exactly one `/dscr` method, the field manifest. The engine was
  // never a missing integration — it was a missing wire.
  //
  // ⛔ BOTH COST A LIVE VENDOR CALL. Never fire one from an effect, never on a
  // keystroke, only on a deliberate press. A search that runs itself on render bills
  // us for every mounted screen, and a debounce on a money call is a slow leak.
  //
  // `dscrPrice` answers the ELIGIBLE side — every lender, every programme, every rung
  // of every rate ladder, with the whole build behind each price — plus `understood`,
  // the vendor's own confirmation of the scenario it actually ran, and a `searchKey`.
  //
  // The INELIGIBLE side is computed by the vendor AFTER the price, so it is polled by
  // that key rather than re-searched: 200 once ready, 202 while it is still computing
  // (surfaced as an ordinary body, `ready:false`), 409 once the key has expired.
  dscrPrice: (scenario, opts) => ltPost(lt('/dscr/price'), { scenario, ...(opts || {}) }),
  // The ONE door here that costs NOTHING. A ZIP resolves its state, county and county FIPS out of a
  // committed Census table on our own server — no vendor call, no session, no billing — which is
  // why this one MAY be fired as somebody types, unlike the two above.
  dscrZip: (zip) => ltGet(lt(`/dscr/zip/${encodeURIComponent(String(zip || '').trim())}`)),
  // The signed-in person's COMPENSATION PLAN — what the pricing engine's three-way switch
  // (borrower-paid / raw / lender-paid) overlays on the displayed numbers. Display only:
  // the Lender Price search itself never changes (owner-directed 2026-08-23).
  dscrCompPlan: () => ltGet(lt('/dscr/comp-plan')),

  // THE CLICKUP SYNCING SECTION (#36): everything the writer does automatically,
  // visible + manually drivable per file. Every write goes through the guarded
  // writer on the server — these calls only press its buttons.
  clickupSection: (loanId, { compare = false } = {}) => ltGet(
    lt(`/clickup/loans/${encodeURIComponent(loanId)}${compare ? '?compare=1' : ''}`)),
  clickupPush: (loanId) => ltPost(lt(`/clickup/loans/${encodeURIComponent(loanId)}/push`), {}),
  clickupPushField: (loanId, key) => ltPost(lt(`/clickup/loans/${encodeURIComponent(loanId)}/push-field`), { key }),
  clickupCreate: (loanId) => ltPost(lt(`/clickup/loans/${encodeURIComponent(loanId)}/create`), {}),
  clickupLink: (loanId, taskId, confirm = false) => ltPost(
    lt(`/clickup/loans/${encodeURIComponent(loanId)}/link`), { taskId, confirm }),
  clickupReview: (loanId, reviewId, decision) => ltPost(
    lt(`/clickup/loans/${encodeURIComponent(loanId)}/reviews/${encodeURIComponent(reviewId)}/${decision === 'approve' ? 'approve' : 'reject'}`), {}),

  // THE ENCOMPASS SYNCING SECTION (#52, owner-directed 2026-08-25): what has been
  // read for this loan and what has not, when Encompass last changed it, when a
  // webhook last asked us to look, and a button that reads it again on the spot.
  // READ-ONLY towards Encompass — `encompassFileRead` opens the loan and reads it;
  // nothing here can write to Encompass.
  encompassFileSection: (loanId) => ltGet(lt(`/encompass-file/loans/${encodeURIComponent(loanId)}`)),
  encompassFileRead: (loanId) => ltPost(lt(`/encompass-file/loans/${encodeURIComponent(loanId)}/read`), {}),

  // Every file where the ClickUp status and the Encompass milestones disagree, as
  // of the last time PILOT looked at that card. Scoped by the server exactly like
  // the pipeline, and it reads OUR OWN rows — no ClickUp call, so it can never be
  // rate-limited into being wrong.
  clickupStatusReviews: (limit) => ltGet(
    lt(`/clickup/status-reviews${limit ? `?limit=${encodeURIComponent(limit)}` : ''}`)),
  dscrDisqualifications: (searchKey, params) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params || {})) if (v != null && v !== '') q.set(k, String(v));
    const s = q.toString();
    return ltGet(lt(`/dscr/disqualifications/${encodeURIComponent(searchKey)}${s ? `?${s}` : ''}`));
  },
};

export default ltApi;
