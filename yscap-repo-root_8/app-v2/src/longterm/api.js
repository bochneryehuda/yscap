// Long-Term's OWN API client.
//
// Every call goes to /api/lt/*, through Long-Term's own fetch helper — never RTL's
// client, which the separation gate correctly refuses (Long-Term starts at zero;
// the one authorized front-end component crossing is BorrowerProfilePanel.jsx). It
// defines no RTL endpoint, and no RTL screen imports it.
//
// The one rule: a path here always starts `/api/lt/`. Anything else belongs to the
// other product.

import { ltGet, ltPost, ltPut, ltPatch, ltDel, ltDownload, ltBlobUrl, ltUpload, ltBlob } from './http.js';

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
  /* THE BORROWER'S OWN CONDITIONS, on the same borrower-authenticated mount as
     their loans list. Their file is resolved from the SESSION plus the loan id —
     never from anything the page passes about who they are. */
  myConditions: (loanId) => ltGet(lt(`/my/loans/${encodeURIComponent(loanId)}/conditions`)),
  /* THE STREAMED DOOR, for the same reason the staff side takes it: a borrower
     photographing a bank statement on a phone is exactly the upload that would
     hit the base64 ceiling. */
  myConditionDocUpload: (loanId, conditionId, body) => ltUpload(
    lt(`/my/loans/${encodeURIComponent(loanId)}/conditions/${encodeURIComponent(conditionId)}/documents/binary`),
    { ...body, checklistItemId: conditionId }),

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
  // THE INVESTOR FILTER'S TWO FREE READS (owner-directed 2026-08-27). The roster is the
  // owner's whole white-label sheet — every investor, live in Lender Price or not — and
  // the groups are the signed-in person's own named sets. Both are reads of OUR server
  // (no vendor call, no billing), which is why the screen may fetch them from an effect.
  // The filter they drive is DISPLAY ONLY: nothing about the selection ever reaches the
  // Lender Price search.
  dscrInvestors: () => ltGet(lt('/dscr/investors')),
  dscrInvestorGroups: () => ltGet(lt('/dscr/investor-groups')),
  dscrSaveInvestorGroup: (name, investors) => ltPost(lt('/dscr/investor-groups'), { name, investors }),
  dscrDeleteInvestorGroup: (id) => ltDel(lt(`/dscr/investor-groups/${encodeURIComponent(id)}`)),

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
  // THE GENERAL CONDITION CENTER (owner-directed 2026-08-30) — OUR OWN
  // conditions, not the Encompass mirror above.
  //
  // NAMED `fileConditions*`, NOT `conditionCenter*`, AND THAT MATTERS: this
  // client already has a `conditionCenter()` for the Encompass mirror, and in an
  // object literal the LATER key silently wins. A second `conditionCenter` here
  // would have re-pointed the existing mirror screen at this endpoint with no
  // error anywhere — the screen would simply have started showing the wrong
  // conditions. Two centres, two names.
  fileConditions: (loanId) => ltGet(lt(`/condition-center/loans/${encodeURIComponent(loanId)}`)),
  fileConditionsEvaluate: (loanId) => ltPost(lt(`/condition-center/loans/${encodeURIComponent(loanId)}/evaluate`), {}),
  // THE THREE CONDITIONS THAT ARE A CHOICE, not an upload — the mortgages on
  // the credit report, the mortgage on the property being refinanced, and the
  // vesting entity. Their working data has its own door because the conditions
  // LIST is loaded by every screen and every borrower, and these reads are only
  // wanted once somebody opens one of them.
  conditionWorkspace: (loanId, id) => ltGet(
    lt(`/condition-center/loans/${encodeURIComponent(loanId)}/conditions/${encodeURIComponent(id)}/workspace`)),
  conditionAnswer: (loanId, id, answer) => ltPost(
    lt(`/condition-center/loans/${encodeURIComponent(loanId)}/conditions/${encodeURIComponent(id)}/answer`), { answer }),

  conditionSatisfy: (loanId, id) => ltPost(lt(`/condition-center/loans/${encodeURIComponent(loanId)}/conditions/${encodeURIComponent(id)}/satisfy`), {}),
  conditionWaive: (loanId, id, reason) => ltPost(lt(`/condition-center/loans/${encodeURIComponent(loanId)}/conditions/${encodeURIComponent(id)}/waive`), { reason }),
  conditionReopen: (loanId, id) => ltPost(lt(`/condition-center/loans/${encodeURIComponent(loanId)}/conditions/${encodeURIComponent(id)}/reopen`), {}),
  conditionStatus: (loanId, id, status) => ltPost(lt(`/condition-center/loans/${encodeURIComponent(loanId)}/conditions/${encodeURIComponent(id)}/status`), { status }),
  conditionNote: (loanId, id, note) => ltPost(lt(`/condition-center/loans/${encodeURIComponent(loanId)}/conditions/${encodeURIComponent(id)}/note`), { note }),
  conditionAdd: (loanId, code, fieldKey) => ltPost(lt(`/condition-center/loans/${encodeURIComponent(loanId)}/conditions`), { code, fieldKey }),
  conditionRemove: (loanId, id) => ltDel(lt(`/condition-center/loans/${encodeURIComponent(loanId)}/conditions/${encodeURIComponent(id)}`)),

  /* THE LOGIN-FREE LINK — email this loan's borrower everything still needed,
     with a direct button per condition (owner-directed 2026-08-28: *"an email
     directly with links to upload and enter the information over there …
     without him being able to set up an account or portal."*).

     The preview is a READ that changes nothing: it says who it could go to,
     what would be sent, every link already out, and — the part that matters on
     screen — every reason it CANNOT be sent, in words a person can act on. The
     send re-checks all of them, so the screen's answer is never what authorises
     the email. */
  conditionsOutreach: (loanId) => ltGet(lt(`/condition-center/loans/${encodeURIComponent(loanId)}/outreach`)),
  conditionsOutreachSend: (loanId, emails, note) => ltPost(
    lt(`/condition-center/loans/${encodeURIComponent(loanId)}/outreach`), { emails, note }),
  conditionsOutreachRevoke: (loanId, linkId) => ltPost(
    lt(`/condition-center/loans/${encodeURIComponent(loanId)}/outreach/${encodeURIComponent(linkId)}/revoke`), {}),

  /* THE DOCUMENTS ON A CONDITION — the owner's own list of verbs, in one place:
     *"the way you preview stuff, the way you preview the PDFs, the way you drag
     and drop, accept, reject, preview, download, and delete."* Each of these is a
     thin call to the /api/lt door, which is itself a thin caller of the ONE
     shared condition-document service. The `checklistItemId` rides in the
     metadata so the shared upload-progress store files the bar against the right
     condition without this client passing it twice. */
  /* THE STREAMED DOOR (`…/documents/binary`), which is the short-term side's own
     pair: the JSON door caps at 25 MB because a base64 body must be held in memory
     to decode, and this one writes to storage as the bytes arrive. Same handler
     behind both — `takeUpload` reads `req.uploaded` first — so nothing but the
     transport differs. */
  conditionDocUpload: (loanId, conditionId, body) => ltUpload(
    lt(`/condition-center/loans/${encodeURIComponent(loanId)}/conditions/${encodeURIComponent(conditionId)}/documents/binary`),
    { ...body, checklistItemId: conditionId }),
  /* THE VESTING COMPANY ON THE BORROWER'S PROFILE — the write half of the
     entity block the condition already reads.

     `vestingEntityToProfile` puts the company on the profile (create-or-REUSE)
     and gives it its document slots. `vestingEntityDocUpload` then files a
     document onto one of the COMPANY's own slots — not onto this loan — so the
     next loan for the same company finds it already there. Nothing is copied
     anywhere: the shared upload door files it against the company the first
     time, which is why this takes the slot's own item id rather than a
     condition's. Streamed door for the same reason every other upload here uses
     one — an operating agreement is routinely past the JSON ceiling. */
  /* THE CARD ON THE PERSON. The body carries a card number, so the response
     deliberately carries back only the brand and the last four — the server
     never decrypts a number and nothing here could render one. */
  appraisalCardSave: (loanId, body) => ltPost(
    lt(`/condition-center/loans/${encodeURIComponent(loanId)}/appraisal-card`), body),
  vestingEntityToProfile: (loanId) => ltPost(
    lt(`/condition-center/loans/${encodeURIComponent(loanId)}/vesting-entity`), {}),
  vestingEntityDocUpload: (loanId, slotItemId, body) => ltUpload(
    lt(`/condition-center/loans/${encodeURIComponent(loanId)}/vesting-entity/slots/${encodeURIComponent(slotItemId)}/documents/binary`),
    { ...body, checklistItemId: slotItemId }),
  conditionDocReview: (documentId, body) => ltPost(
    lt(`/condition-center/documents/${encodeURIComponent(documentId)}/review`), body),
  conditionDocRemove: (documentId) => ltDel(
    lt(`/condition-center/documents/${encodeURIComponent(documentId)}`)),
  // Two ways to reach the same door. A download saves the file; a PREVIEW asks
  // the shared serving path to render it inline (`?inline=1`) and hands the bytes
  // to the shared previewer — an `<iframe src>` cannot carry the session token,
  // which is why a preview fetches rather than pointing a frame at the route.
  conditionDocDownload: (documentId, filename) => ltDownload(
    lt(`/condition-center/documents/${encodeURIComponent(documentId)}/file`), filename || 'document'),
  conditionDocBlob: (documentId) => ltBlob(
    lt(`/condition-center/documents/${encodeURIComponent(documentId)}/file?inline=1`)),

  // The LIBRARY — the settings side. The rule builder draws its whole field
  // picker from this response, so a screen can never offer a field the evaluator
  // would then refuse.
  conditionLibrary: () => ltGet(lt('/condition-center/library')),
  conditionTemplateSave: (code, patch) => ltPatch(lt(`/condition-center/library/${encodeURIComponent(code)}`), patch),
  conditionRulePreview: (rule, loanId) => ltPost(lt('/condition-center/library/preview'), { rule, loanId }),
  conditionReseed: () => ltPost(lt('/condition-center/library/reseed'), {}),
  conditionBuckets: () => ltGet(lt('/condition-center/buckets')),
  conditionBucketSave: (b) => ltPost(lt('/condition-center/buckets'), b),
  conditionBucketRetire: (key) => ltDel(lt(`/condition-center/buckets/${encodeURIComponent(key)}`)),

  // THE REPORTING CENTRE (owner-directed 2026-08-30). The field catalog comes from
  // the SERVER, so the column picker and the compiler can never disagree about what
  // exists — the browser keeps no second copy of the field list. A report definition
  // is a set of catalog KEYS and operators; it is never SQL, and the server refuses
  // a key its catalog does not carry.
  reportFields: () => ltGet(lt('/reports/fields')),
  runReport: (report) => ltPost(lt('/reports/run'), { report }),
  describeReport: (report) => ltPost(lt('/reports/describe'), { report }),
  savedReports: () => ltGet(lt('/reports/saved')),
  saveReport: (body) => ltPost(lt('/reports/saved'), body),
  deleteReport: (id) => ltDel(lt(`/reports/saved/${encodeURIComponent(id)}`)),
  // Per-person figures over the whole book. Refused to somebody scoped to their own
  // pipeline — a processor's average measured over a slice of their work, printed
  // under their name, is worse than no number at all.
  scorecard: (params = {}) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v != null && v !== '') q.set(k, String(v));
    const s = q.toString();
    return ltGet(lt(`/reports/scorecard${s ? `?${s}` : ''}`));
  },
  // One file's own story: every span it can measure, the ladder with Encompass's
  // date and OUR observation side by side, and the events behind them.
  fileTimeline: (loanId) => ltGet(lt(`/reports/loans/${encodeURIComponent(loanId)}/timeline`)),

  // THE ORDERS DESK (owner-directed 2026-08-30). The LETTER is the short-term
  // desk's own — one definition, shared — so `orderPreview` returns exactly what
  // the send would put on the wire rather than a second rendering of it. Every
  // blocker carries the SERVER's own sentence; the screen prints it verbatim,
  // because a refusal reworded in the browser is a second answer to one question.
  orders: (loanId) => ltGet(lt(`/orders/loans/${encodeURIComponent(loanId)}`)),
  orderThread: (loanId, kind) => ltGet(lt(`/orders/loans/${encodeURIComponent(loanId)}/${encodeURIComponent(kind)}/thread`)),
  orderPreview: (loanId, kind, opts = {}) => {
    const q = new URLSearchParams();
    if (opts.followup) q.set('followup', '1');
    if (opts.note) q.set('note', opts.note);
    const s = q.toString();
    return ltGet(lt(`/orders/loans/${encodeURIComponent(loanId)}/${encodeURIComponent(kind)}/preview${s ? `?${s}` : ''}`));
  },
  orderPlace: (loanId, kind, body = {}) => ltPost(lt(`/orders/loans/${encodeURIComponent(loanId)}/${encodeURIComponent(kind)}/place`), body),
  orderFollowUp: (loanId, kind, body = {}) => ltPost(lt(`/orders/loans/${encodeURIComponent(loanId)}/${encodeURIComponent(kind)}/follow-up`), body),
  orderCancel: (loanId, kind, reason) => ltPost(lt(`/orders/loans/${encodeURIComponent(loanId)}/${encodeURIComponent(kind)}/cancel`), { reason }),

  // The vendor cards on a loan, and the SHARED directory behind them.
  orderVendors: (loanId) => ltGet(lt(`/orders/loans/${encodeURIComponent(loanId)}/vendors`)),
  orderVendorSearch: (loanId, kind, q) => ltGet(lt(`/orders/loans/${encodeURIComponent(loanId)}/vendors/search?kind=${encodeURIComponent(kind)}&q=${encodeURIComponent(q)}`)),
  orderVendorLink: (loanId, body) => ltPost(lt(`/orders/loans/${encodeURIComponent(loanId)}/vendors`), body),
  /* A contact NOBODY has entered yet: the card is written into the shared
     directory and linked in one breath. Link (above) needs a card that already
     exists; this is the other half, and without it the only way a vendor reaches
     a long-term loan is for somebody to have typed it on a short-term file first
     — which is how a second contact store gets started. */
  orderVendorCreate: (loanId, body) => ltPost(lt(`/orders/loans/${encodeURIComponent(loanId)}/vendors/new`), body),
  /* Correcting a card corrects it EVERYWHERE — it is the one shared row. That is
     the owner's "one company, one card, corrected in one place", not a leak. */
  orderVendorEdit: (loanId, linkId, body) => ltPatch(lt(`/orders/loans/${encodeURIComponent(loanId)}/vendors/${encodeURIComponent(linkId)}`), body),
  orderVendorUnlink: (loanId, linkId) => ltDel(lt(`/orders/loans/${encodeURIComponent(loanId)}/vendors/${encodeURIComponent(linkId)}`)),

  orderLetters: () => ltGet(lt('/orders/letters')),

  /* THE VERIFICATION OF RENT. The form's DATA is what is edited and saved; the PDF
     is RENDERED from it on every preview and again at the moment of sending, so the
     document that goes out is by construction the one that was reviewed. There is
     deliberately no endpoint that takes PDF bytes from the browser: a hand-edited
     document cannot be re-anchored, so its required questions would silently stop
     being asked. */
  vor: (loanId) => ltGet(lt(`/vor/loans/${encodeURIComponent(loanId)}`)),
  vorSave: (loanId, data) => ltPost(lt(`/vor/loans/${encodeURIComponent(loanId)}/form`), { data }),
  vorPreviewUrl: (loanId) => ltBlobUrl(lt(`/vor/loans/${encodeURIComponent(loanId)}/preview.pdf`)),
  vorDownload: (loanId) => ltDownload(lt(`/vor/loans/${encodeURIComponent(loanId)}/preview.pdf`), 'verification-of-rent.pdf'),
  vorSend: (loanId, body) => ltPost(lt(`/vor/loans/${encodeURIComponent(loanId)}/send`), body),
  vorManualReturn: (loanId, body) => ltPost(lt(`/vor/loans/${encodeURIComponent(loanId)}/manual-return`), body),

  dscrDisqualifications: (searchKey, params) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params || {})) if (v != null && v !== '') q.set(k, String(v));
    const s = q.toString();
    return ltGet(lt(`/dscr/disqualifications/${encodeURIComponent(searchKey)}${s ? `?${s}` : ''}`));
  },

  // ── TERM SHEETS (owner-directed 2026-08-30) ───────────────────────────────
  // Issue, replay by ID, and the comparison cart. `preview` mints NO code and
  // stores nothing — a term sheet ID is a promise that a document exists and can
  // be pulled up again, so it is never spent on a look.
  termSheetPreview: (body) => ltPost(lt('/dscr/term-sheet/preview'), body),
  termSheetIssue: (body) => ltPost(lt('/dscr/term-sheet'), body),
  termSheetList: () => ltGet(lt('/dscr/term-sheet')),
  termSheetGet: (code) => ltGet(lt(`/dscr/term-sheet/${encodeURIComponent(code)}`)),
  // The PDF is rebuilt from the STORED snapshot, never re-priced, so the download
  // is the document that was sent.
  termSheetPdf: (code) => ltDownload(
    lt(`/dscr/term-sheet/${encodeURIComponent(code)}/pdf`), `term-sheet-${code}.pdf`),
  termSheetReplay: (code, body) => ltPost(lt(`/dscr/term-sheet/${encodeURIComponent(code)}/replay`), body),

  // EVENING OUT A PRICE (§40) — what the price reads at, what it could be rounded
  // to, and what each of those would cost us. READ-ONLY and a round trip on
  // purpose: the compensation an adjustment comes out of is the server's own
  // resolution and is never sent to the browser, so this screen cannot work the
  // suggestions out for itself — which is exactly the point.
  termSheetPriceAdjust: (body) => ltPost(lt('/dscr/term-sheet/price-adjust'), body),

  // EMAIL IT TO THE BORROWER — the same PDF the download gives, with the branded
  // letter, from the officer's own name and address. The server decides who it
  // comes from (off the roster) and refuses a note that names the investor, so
  // this posts only the address and the note.
  termSheetEmail: (code, body) => ltPost(lt(`/dscr/term-sheet/${encodeURIComponent(code)}/email`), body),
  // Who this sheet has already been sent to. A screen offering "send it" has to be
  // able to answer "did she get it?" without another copy in the borrower's inbox.
  termSheetDeliveries: (code) => ltGet(lt(`/dscr/term-sheet/${encodeURIComponent(code)}/deliveries`)),

  termSheetCart: () => ltGet(lt('/dscr/term-sheet/cart')),
  termSheetCartAdd: (selection) => ltPost(lt('/dscr/term-sheet/cart'), { selection }),
  termSheetCartAnchor: (anchorPosition) => ltPatch(lt('/dscr/term-sheet/cart'), { anchorPosition }),
  termSheetCartRemove: (memberId) => ltDel(lt(`/dscr/term-sheet/cart/${encodeURIComponent(memberId)}`)),
  termSheetCartClear: () => ltDel(lt('/dscr/term-sheet/cart')),
};

export default ltApi;
