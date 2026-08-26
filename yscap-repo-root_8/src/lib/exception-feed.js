'use strict';
/**
 * EVERY REQUEST TO DEVIATE, IN ONE LIST — the admin's single place to see what
 * anybody has asked for on any file, whichever queue it landed in.
 *
 * Owner-directed 2026-08-26: *"The admin currently has 5 or 6 separate
 * workflows … There are too many separate sections, and it is very hard to keep
 * track of it. It is very hard to understand everything and look at where
 * somebody requested an exception. We need to look at every place where
 * exceptions are landing, even for different types of exceptions, and just
 * merge everything into one place with filters for exceptions … You should be
 * able to see all exceptions and search by loan number, by address, or by
 * anything. All exceptions at that address should come up, and you should be
 * able to filter by statuses."*
 *
 * MERGING A LIST IS NOT MERGING A DECISION, and that distinction is the whole
 * design. Each store's DECIDE route carries rules that took a long time to get
 * right — requester≠approver with a super-admin exemption, per-store
 * permissions, counter-offers, the register's own re-escalation — so this
 * module READS and never writes. A row carries where it is decided; the
 * decision still happens where its rules live. Re-implementing three approval
 * flows behind one button is how a careful rule quietly stops applying.
 *
 * THE THREE STORES SPEAK THREE DIFFERENT STATUS VOCABULARIES, measured off
 * their own CHECK constraints:
 *   loan_exceptions            requested | approved | denied | withdrawn | cleared | expired
 *   manual_program_escalations pending   | countered | approved | declined
 *   finding_escalations        open      | resolved  | dismissed
 * A filter that means one thing on one queue and another on the next is worse
 * than no filter, so every row is normalised to ONE vocabulary for FILTERING
 * (`state`) while keeping its own word for DISPLAY (`status`). Nothing is
 * translated away: a countered pricing approval still reads "countered".
 *
 * NOTHING IS EVER SILENTLY SHORT. If one store cannot be read, its rows are
 * missing and the caller is TOLD which one (`failed`), because a merged list
 * that quietly drops a queue looks exactly like a queue with nothing in it —
 * and the whole point of this screen is to stop things being missed.
 */

const db = require('../db');
const fileSearch = require('./file-search');

/* THE ONE VOCABULARY. `state` is what a filter means; `status` stays whatever
   the row's own store called it, so the screen never tells a half-truth. */
const STATES = Object.freeze(['open', 'approved', 'denied', 'withdrawn', 'settled']);

/* Each store's own word → the shared state. An UNKNOWN word maps to 'open'
   deliberately: a request nobody recognises is one somebody should look at, and
   hiding it because its status is unfamiliar is the failure this screen exists
   to prevent. */
const STATE_OF = Object.freeze({
  // loan_exceptions
  requested: 'open', approved: 'approved', denied: 'denied',
  withdrawn: 'withdrawn', cleared: 'settled', expired: 'settled',
  // manual_program_escalations
  pending: 'open', countered: 'open', declined: 'denied',
  // finding_escalations
  open: 'open', resolved: 'settled', dismissed: 'settled',
});

function stateOf(status) {
  const k = String(status == null ? '' : status).trim().toLowerCase();
  return STATE_OF[k] || 'open';
}

/* THE SOURCES. Adding a fourth place an exception can land is one entry here
   plus its row mapper — never a second screen, which is what produced the six
   tabs this replaces. */
const SOURCES = Object.freeze({
  exception: { label: 'Policy exception', decidedAt: '/internal/approvals?tab=exceptions' },
  pricing: { label: 'Pricing approval', decidedAt: '/internal/approvals?tab=escalations' },
  finding: { label: 'Finding review', decidedAt: '/internal/approvals?tab=findings' },
});


const STAFF_NAME = (t) => `NULLIF(btrim(COALESCE(${t}.full_name,'')),'')`;

/* THE FILE IDENTITY EVERY ROW CARRIES, written once. Selected the same way for
   all three stores so a row reads identically wherever it came from. */
function fileCols(a = 'a', b = 'b') {
  return `${a}.id AS application_id, ${a}.ys_loan_number, ${a}.property_address,
          ${a}.status AS file_status, ${a}.loan_amount,
          NULLIF(btrim(COALESCE(${b}.first_name,'') || ' ' || COALESCE(${b}.last_name,'')),'') AS borrower_name`;
}

/* One WHERE builder for all three, so the search and the status filter cannot
   drift between queues — the drift is exactly what made six tabs six different
   answers to one question. */
function common({ q, state, appId, mine }, statusCol, requesterCol, params, extraSearch = []) {
  const conds = [];
  const like = fileSearch.likeParam(q);
  if (like) {
    params.push(like);
    const p = `$${params.length}`;
    /* "search by loan number, by address, or BY ANYTHING" (owner's words). The
       shared file predicate answers the first two and the borrower; a queue of
       requests is also searched by WHO raised it, WHO decided it, and what it
       SAYS — which is how somebody actually looks for one they half-remember.
       The extra terms are ADDED here rather than pushed into the shared
       predicate, because the approvals queues search FILES and widening that
       one would change what every other caller means by a search. */
    const extra = [
      `COALESCE(${STAFF_NAME('rq')},'') ILIKE ${p}`,
      `COALESCE(${STAFF_NAME('dc')},'') ILIKE ${p}`,
      ...extraSearch.map((c) => `COALESCE(${c},'') ILIKE ${p}`),
    ];
    conds.push(`(${fileSearch.fileSearchSql(params.length, { app: 'a', borrower: 'b' })} OR ${extra.join(' OR ')})`);
  }
  if (appId) { params.push(appId); conds.push(`a.id = $${params.length}::uuid`); }
  if (mine) { params.push(mine); conds.push(`${requesterCol} = $${params.length}::uuid`); }
  /* THE STATE FILTER IS EXPANDED INTO THAT STORE'S OWN WORDS rather than
     computed in SQL: each store spells the same state differently, and a CASE
     repeated in three queries is three chances to disagree. */
  if (state && STATES.includes(state)) {
    const words = Object.keys(STATE_OF).filter((w) => STATE_OF[w] === state);
    params.push(words);
    conds.push(`${statusCol} = ANY($${params.length}::text[])`);
  }
  return conds;
}

const row = (o) => ({ ...o, state: stateOf(o.status), source_label: (SOURCES[o.source] || {}).label || o.source,
  decided_at_screen: (SOURCES[o.source] || {}).decidedAt || null });

async function fromExceptions(f, limit, client) {
  const params = [];
  const conds = common(f, 'e.status', 'e.requested_by', params,
    ['e.exception_type', 'e.reason_code', 'e.reason_note', 'e.decision_note']);
  params.push(limit);
  const r = await client.query(
    `SELECT e.id, e.status, e.exception_type AS type_key, e.exception_seq AS seq,
            e.reason_code, e.reason_note, e.decision_note, e.severity,
            e.requested_at, e.decided_at, e.requested_by, e.requested_by_kind,
            ${STAFF_NAME('rq')} AS requested_by_name, ${STAFF_NAME('dc')} AS decided_by_name,
            ${fileCols()}
       FROM loan_exceptions e
       JOIN applications a ON a.id = e.application_id
       JOIN borrowers b ON b.id = a.borrower_id
       LEFT JOIN staff_users rq ON rq.id = e.requested_by
       LEFT JOIN staff_users dc ON dc.id = e.decided_by
      ${conds.length ? 'WHERE ' + conds.join(' AND ') : ''}
      ORDER BY e.requested_at DESC NULLS LAST LIMIT $${params.length}`, params);
  return r.rows.map((x) => row({
    source: 'exception', id: x.id, ref: x.seq != null ? `EX-${x.seq}` : null,
    type_key: x.type_key, status: x.status, severity: x.severity,
    reason: x.reason_code ? String(x.reason_code).replace(/_/g, ' ') : null,
    note: x.reason_note || null, decision_note: x.decision_note || null,
    requested_at: x.requested_at, decided_at: x.decided_at,
    requested_by: x.requested_by,
    requested_by_name: x.requested_by_kind === 'borrower' ? 'Borrower' : x.requested_by_name,
    decided_by_name: x.decided_by_name,
    application_id: x.application_id, ys_loan_number: x.ys_loan_number,
    property_address: x.property_address, borrower_name: x.borrower_name,
    file_status: x.file_status, loan_amount: x.loan_amount,
  }));
}

async function fromPricing(f, limit, client) {
  const params = [];
  const conds = common(f, 'e.status', 'e.requested_by', params,
    [`e.summary->>'kind'`, 'e.decision_note']);
  params.push(limit);
  const r = await client.query(
    `SELECT e.id, e.status, e.summary, e.decision_note, e.created_at, e.decided_at, e.requested_by,
            ${STAFF_NAME('rq')} AS requested_by_name, ${STAFF_NAME('dc')} AS decided_by_name,
            ${fileCols()}
       FROM manual_program_escalations e
       JOIN applications a ON a.id = e.application_id
       JOIN borrowers b ON b.id = a.borrower_id
       LEFT JOIN staff_users rq ON rq.id = e.requested_by
       LEFT JOIN staff_users dc ON dc.id = e.decided_by
      ${conds.length ? 'WHERE ' + conds.join(' AND ') : ''}
      ORDER BY e.created_at DESC NULLS LAST LIMIT $${params.length}`, params);
  return r.rows.map((x) => {
    const kind = x.summary && typeof x.summary === 'object' && x.summary.kind
      ? String(x.summary.kind).replace(/_/g, ' ') : 'manual program';
    return row({
      source: 'pricing', id: x.id, ref: null, type_key: kind, status: x.status, severity: null,
      reason: kind, note: null, decision_note: x.decision_note || null,
      requested_at: x.created_at, decided_at: x.decided_at,
      requested_by: x.requested_by, requested_by_name: x.requested_by_name,
      decided_by_name: x.decided_by_name,
      application_id: x.application_id, ys_loan_number: x.ys_loan_number,
      property_address: x.property_address, borrower_name: x.borrower_name,
      file_status: x.file_status, loan_amount: x.loan_amount,
    });
  });
}

async function fromFindings(f, limit, client) {
  const params = [];
  const conds = common(f, 'e.status', 'e.requested_by', params,
    ['e.code', 'e.title', 'e.question', 'e.decision_note']);
  params.push(limit);
  const r = await client.query(
    `SELECT e.id, e.status, e.code, e.title, e.severity, e.question, e.decision, e.decision_note,
            e.created_at, e.decided_at, e.requested_by,
            ${STAFF_NAME('rq')} AS requested_by_name, ${STAFF_NAME('dc')} AS decided_by_name,
            ${fileCols()}
       FROM finding_escalations e
       JOIN applications a ON a.id = e.application_id
       JOIN borrowers b ON b.id = a.borrower_id
       LEFT JOIN staff_users rq ON rq.id = e.requested_by
       LEFT JOIN staff_users dc ON dc.id = e.decided_by
      ${conds.length ? 'WHERE ' + conds.join(' AND ') : ''}
      ORDER BY e.created_at DESC NULLS LAST LIMIT $${params.length}`, params);
  return r.rows.map((x) => row({
    source: 'finding', id: x.id, ref: null, type_key: x.code || 'finding', status: x.status,
    severity: x.severity, reason: x.title || x.code || null, note: x.question || null,
    decision_note: x.decision_note || null,
    requested_at: x.created_at, decided_at: x.decided_at,
    requested_by: x.requested_by, requested_by_name: x.requested_by_name,
    decided_by_name: x.decided_by_name,
    application_id: x.application_id, ys_loan_number: x.ys_loan_number,
    property_address: x.property_address, borrower_name: x.borrower_name,
    file_status: x.file_status, loan_amount: x.loan_amount,
  }));
}

const READERS = Object.freeze({ exception: fromExceptions, pricing: fromPricing, finding: fromFindings });

/**
 * EVERY request to deviate, from every store, newest first.
 *
 *   q       free text — loan number, address, borrower (the SHARED predicate)
 *   state   one of STATES, or null for every state
 *   source  narrow to one store, or null for all of them
 *   mine    a staff id — only what that person raised (this is what the old
 *           "My requests" tab was, and why it did not need a tab)
 *   appId   every request on ONE file ("all exceptions at that address")
 */
async function listAll({ q = null, state = null, source = null, mine = null, appId = null,
  limit = 100 } = {}, client = db) {
  const page = Math.min(300, Math.max(1, Number(limit) || 100));
  const want = source && READERS[source] ? [source] : Object.keys(READERS);
  const failed = [];
  /* Each store is read to page+1 so the MERGED top page is provably right: every
     source is already sorted newest-first, so the global newest `page` rows can
     only come from each source's own newest `page`. The +1 is what MEASURES a
     next page rather than inferring one from a full one. */
  const settled = await Promise.all(want.map(async (k) => {
    try { return { k, rows: await READERS[k]({ q, state, mine, appId }, page + 1, client) }; }
    catch (e) { failed.push({ source: k, reason: e && e.message ? String(e.message).slice(0, 200) : 'unreadable' }); return { k, rows: [] }; }
  }));
  const all = settled.flatMap((x) => x.rows);
  all.sort((x, y) => {
    const ax = x.requested_at ? new Date(x.requested_at).getTime() : 0;
    const ay = y.requested_at ? new Date(y.requested_at).getTime() : 0;
    if (ay !== ax) return ay - ax;
    return String(y.id).localeCompare(String(x.id));   // a total order, never an arbitrary one
  });
  const hasMore = all.length > page;
  return { rows: all.slice(0, page), hasMore, pageSize: page, failed, sources: want };
}

/* The per-state counts the screen's filter chips show. Same filters as the list
   MINUS the state, so a chip says how many the OTHER filters leave in it. */
async function counts(f = {}, client = db) {
  const out = { open: 0, approved: 0, denied: 0, withdrawn: 0, settled: 0 };
  const r = await listAll({ ...f, state: null, limit: 300 }, client);
  for (const x of r.rows) if (out[x.state] != null) out[x.state] += 1;
  return { counts: out, capped: r.hasMore, failed: r.failed };
}

module.exports = { STATES, STATE_OF, stateOf, SOURCES, listAll, counts, _internals: { common, fileCols } };
