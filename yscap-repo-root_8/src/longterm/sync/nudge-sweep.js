'use strict';
/**
 * LONG-TERM — "something changed in Encompass": working out WHICH loans, when
 * the message could not tell us.
 *
 * WHY THIS EXISTS (owner-reported 2026-08-24), stated as PROVEN vs UNCONFIRMED
 * because an earlier draft of this header asserted more than was known.
 *
 * PROVEN, from the tenant's own working rule: Encompass business-rule advanced
 * code CAN make an outbound HTTPS POST. Their live drivekosher rule does exactly
 * that with System.Net.HttpWebRequest, so the sandbox is NOT network-locked --
 * an earlier draft here claimed it was, and that was wrong.
 *
 * PROVEN, from the tenant's own compiler errors: neither `Loan` nor
 * `EncompassApplication` is in scope there. Both were refused by name.
 *
 * UNCONFIRMED at the time of writing: whether the advanced-code editor's
 * square-bracket field reference (`[364]` for the loan number) is substituted
 * before the code runs. If it is, the ping carries the loan number and the
 * receiver identifies the loan directly, and this module never runs.
 *
 * So the doorbell may ring without saying who is at the door -- either because
 * the tenant's rule sends a fixed body, or because the bracket was not
 * substituted and the body carries the literal text. Rather than leave that
 * outcome depending on an untested substitution, PILOT answers such a ring by
 * asking ENCOMPASS which loans just moved.
 *
 * IT IS STILL NUDGE-ONLY, and that is the whole safety story. Nothing in the
 * message is read, believed, or applied. The one thing that happens is that some
 * loans' `encompass_synced_at` stamps are cleared, which makes the ordinary sync
 * re-read them from Encompass over the authenticated read-only connection.
 * Encompass remains the source of truth AND the only source of values, and this
 * module cannot write a loan value even if it wanted to — the only UPDATE it
 * issues sets that one column to NULL.
 *
 * IT IS PRECISE, NOT A SWEEP. Encompass is asked for the most recently modified
 * loans, and a loan is nudged ONLY when Encompass's `Loan.LastModified` is NEWER
 * than the copy we already hold. A loan that has not moved since we last read it
 * is left alone, so a busy afternoon does not turn into a re-read of the book.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. It does not page. One call, `LIMIT` loans,
 * ordered newest-first. If more than that moved between two pings, the surplus
 * is picked up by the NEXT ping or by the sync's own round-robin rota, which
 * still reads every loan on its own schedule — this accelerates that rota, it
 * does not replace it. The count is REPORTED (`capped`) rather than silently
 * dropped, so "we saw as many as we asked for" is never mistaken for "we saw
 * everything".
 *
 * Every dependency is injected, so the whole path is provable with no network
 * and no credentials.
 */

/** The most-recently-modified loans, newest first — the same canonical field and
 *  sort the discovery pass already uses, so the two cannot disagree about what
 *  "recently changed" means. */
const SORT_FIELD = 'Loan.LastModified';

/** One call's worth. Deliberately modest: this runs on a doorbell that can ring
 *  many times a minute, and the rota is the backstop for anything past it. */
const DEFAULT_LIMIT = 50;

const ms = (v) => {
  if (v == null) return null;
  const t = (v instanceof Date) ? v.getTime() : Date.parse(String(v));
  return Number.isFinite(t) ? t : null;
};

const key = (v) => String(v == null ? '' : v).trim().toLowerCase();

/**
 * @param {object} a
 * @param {object} a.client  the LT Encompass client (pipelineSearch)
 * @param {object} a.db      the LT db
 * @param {number} a.limit   how many recently-modified loans to ask about
 * @returns {Promise<{ok:boolean, reason?:string, checked:number, capped:boolean,
 *                    nudged:Array, unchanged:number, unknown:Array}>}
 */
async function sweepRecentlyChanged({ client, db, limit } = {}) {
  const cap = Math.max(1, Math.min(200, parseInt(limit, 10) || DEFAULT_LIMIT));
  const out = { ok: true, checked: 0, capped: false, nudged: [], unchanged: 0, unknown: [] };

  if (!client || typeof client.pipelineSearch !== 'function') {
    return { ...out, ok: false, reason: 'the Encompass connection is not available' };
  }

  // ASK ENCOMPASS WHAT MOVED. A read, over the read-only connection, with the
  // same shape the discovery pass has used since it shipped.
  let rows;
  try {
    const body = await client.pipelineSearch({
      fields: ['Loan.LoanNumber', 'Loan.GUID', SORT_FIELD],
      sortOrder: [{ canonicalName: SORT_FIELD, order: 'Descending' }],
    }, { limit: cap, start: 0 });
    rows = Array.isArray(body) ? body : (body && Array.isArray(body.loans) ? body.loans : []);
  } catch (e) {
    // FAILS CLOSED: an unreadable answer nudges nothing. A doorbell we could not
    // answer costs a few minutes of the ordinary rota; guessing costs a re-read
    // of loans that never moved.
    return { ...out, ok: false, reason: `Encompass could not be asked what changed: ${String((e && e.message) || e).slice(0, 160)}` };
  }

  out.checked = rows.length;
  out.capped = rows.length >= cap;
  if (!rows.length) return out;

  // WHAT DO WE ALREADY HOLD? One query for the whole batch — never one per loan.
  const numbers = [];
  const guids = [];
  for (const r of rows) {
    const f = (r && r.fields) || r || {};
    const n = f['Loan.LoanNumber'] || r.loanNumber;
    const g = f['Loan.GUID'] || r.loanGuid || r.loanGuidString || r.id;
    if (n) numbers.push(String(n));
    if (g) guids.push(String(g));
  }

  let mine = [];
  try {
    ({ rows: mine } = await db.query(
      `SELECT id, loan_number, encompass_loan_guid, encompass_last_modified
         FROM lt_loans
        WHERE (loan_number = ANY($1::text[]) AND $1 IS NOT NULL)
           OR (LOWER(encompass_loan_guid) = ANY($2::text[]) AND $2 IS NOT NULL)`,
      [numbers, guids.map((g) => g.toLowerCase())]));
  } catch (e) {
    return { ...out, ok: false, reason: `could not read the mirror: ${String((e && e.message) || e).slice(0, 160)}` };
  }

  const byNumber = new Map();
  const byGuid = new Map();
  for (const m of mine) {
    if (m.loan_number) byNumber.set(key(m.loan_number), m);
    if (m.encompass_loan_guid) byGuid.set(key(m.encompass_loan_guid), m);
  }

  // DECIDE, PER LOAN. Only a loan Encompass says is NEWER than our copy is
  // nudged; everything else is counted and left alone.
  const toNudge = [];
  for (const r of rows) {
    const f = (r && r.fields) || r || {};
    const n = f['Loan.LoanNumber'] || r.loanNumber;
    const g = f['Loan.GUID'] || r.loanGuid || r.loanGuidString || r.id;
    const theirs = ms(f[SORT_FIELD] || r.lastModified);

    const m = (g && byGuid.get(key(g))) || (n && byNumber.get(key(n))) || null;
    if (!m) {
      // Not mirrored yet — the NEW FILE case. Discovery owns creation (with its
      // trash and duplicate guards), so nothing is created here.
      if (n) out.unknown.push(String(n));
      continue;
    }
    const ours = ms(m.encompass_last_modified);
    // An UNREADABLE date on either side is treated as "we cannot prove it moved"
    // and left to the rota — never nudged on a guess, never nudged on a NaN.
    if (theirs == null || ours == null || theirs > ours) {
      if (theirs != null && ours != null) {
        toNudge.push({ id: m.id, loanNumber: m.loan_number, was: m.encompass_last_modified, now: f[SORT_FIELD] || r.lastModified });
      } else {
        out.unchanged++;   // cannot tell; the rota still reads it on its own turn
      }
    } else {
      out.unchanged++;
    }
  }

  if (!toNudge.length) return out;

  // THE NUDGE. The ONLY write this module makes, and it clears one column.
  try {
    await db.query(
      `UPDATE lt_loans SET encompass_synced_at = NULL, updated_at = now()
        WHERE id = ANY($1::uuid[])`, [toNudge.map((t) => String(t.id))]);
    out.nudged = toNudge.map((t) => ({ loanNumber: t.loanNumber, was: t.was, now: t.now }));
  } catch (e) {
    return { ...out, ok: false, reason: `could not record the nudge: ${String((e && e.message) || e).slice(0, 160)}` };
  }

  return out;
}

module.exports = { sweepRecentlyChanged, SORT_FIELD, DEFAULT_LIMIT, _internals: { ms, key } };
