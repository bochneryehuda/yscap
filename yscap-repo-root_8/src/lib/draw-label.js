'use strict';
/**
 * WHICH DRAW IS THIS? — the one place a draw's number becomes a label
 * (owner-directed 2026-08-09: "all the notification emails that are going out
 * through the entire process, either to the draw coordinator or to the borrower or
 * to the investor, have the draw number on the subject line: Draw 1, Draw 2, Draw
 * 3, Draw 4 — to keep track correctly").
 *
 * THE PROBLEM. Around fifty draw emails go out — to the borrower, to the draw
 * coordinator, to the investor — and not one of them puts the draw number in the
 * subject. Every one reads "Your inspection is complete — please confirm the
 * amount · YSCAP258134591 · Klein · 195 Parrish St", so three draws on one property
 * produce three identical-looking subjects and nobody can tell them apart in an
 * inbox or in a reply chain.
 *
 * WHAT THIS IS NOT. It does not assign, allocate or reconcile draw numbers, and it
 * does not touch how a draw links to its property or its platform — that plumbing
 * (Sitewire, TrustPoint, Trinity) is owner-directed off limits. Every number here
 * is READ from the row that already holds it.
 *
 * THE ONE RULE THAT MATTERS: a wrong number is worse than no number. A subject
 * saying "Draw 2" about draw 3 sends somebody to the wrong money, and the reader
 * has no way to know. So every uncertain path returns null and the email simply
 * goes out with no draw tag — exactly as it does today.
 *
 * PURE label helpers (no DB, no network, no requires); the resolver takes its `db`
 * as an argument so it unit-tests against a stub.
 */

/** A whole, positive draw number, or null. Rejects 0, negatives, fractions and junk. */
function normNumber(n) {
  if (n == null || n === '') return null;
  const x = Number(n);
  if (!Number.isFinite(x) || !Number.isInteger(x) || x <= 0) return null;
  return x;
}

/**
 * "Draw 1" — the owner's own wording. Deliberately NOT "Draw #1": the owner wrote
 * the list out as Draw 1 / Draw 2 / Draw 3 / Draw 4, and this label is the thing
 * people will read every day.
 * @returns {string|null} null when there is no usable number
 */
function drawLabel(n) {
  const v = normNumber(n);
  return v == null ? null : `Draw ${v}`;
}

/**
 * The subject-line tag for one OR several draws — the scheduled reminders group
 * several draws on one file into a single email, and naming only the first would
 * be a lie about the other.
 *   [2]        -> "Draw 2"
 *   [3, 2]     -> "Draws 2, 3"     (sorted, de-duplicated)
 *   [2, null]  -> null             (see below)
 *   []         -> null
 *
 * A LIST CONTAINING AN UNKNOWN IS AN UNKNOWN. If a reminder covers three draws and
 * we can only name two, "Draws 2, 3" reads as a complete list and quietly drops the
 * third — so the whole tag is withheld rather than printing a partial one.
 */
function drawTagFor(numbers) {
  const list = Array.isArray(numbers) ? numbers : [numbers];
  if (!list.length) return null;
  const out = [];
  for (const raw of list) {
    const v = normNumber(raw);
    if (v == null) return null;
    if (!out.includes(v)) out.push(v);
  }
  if (!out.length) return null;
  out.sort((a, b) => a - b);
  return out.length === 1 ? `Draw ${out[0]}` : `Draws ${out.join(', ')}`;
}

/**
 * Read the number for ONE draw. Never throws; returns null when it cannot be known.
 *
 * `ref` names the draw the way the caller already holds it:
 *   { sitewireDrawId }   — the platform draw id (what almost every call site has)
 *   { trustpointDrawId } — a TrustPoint draw id (text; a different id space)
 *   { portalRequestId }  — a draw composed on our own portal, before close-out
 *
 * THE TWO PLATFORMS NUMBER INDEPENDENTLY, and their ids must never be matched
 * against each other — that trap is documented in investor-delivery-send.js and
 * would put another draw's number (and, downstream, another draw's money) in front
 * of a reader. The ONLY crossing used here is `trustpoint_draws.sitewire_draw_id`,
 * which is the link the mirror itself already maintains.
 */
async function drawNumberFor(db, appId, ref) {
  if (!db || !appId || !ref) return null;
  const q = (sql, params) => db.query(sql, params).then((r) => (r && r.rows) || []).catch(() => null);

  try {
    // ---- a platform draw ---------------------------------------------------
    if (ref.sitewireDrawId != null && ref.sitewireDrawId !== '') {
      const id = String(ref.sitewireDrawId);
      if (!/^\d+$/.test(id)) return null;              // a bigint column: never bind junk
      const own = await q(
        `SELECT number FROM sitewire_draws WHERE sitewire_draw_id=$1 AND application_id=$2`, [id, appId]);
      if (own == null) return null;                    // the read failed — say nothing
      if (own.length) {
        const n = normNumber(own[0].number);
        if (n != null) return n;
      }
      // A file routed to TrustPoint is administered there, so the number a human
      // sees on that draw is TrustPoint's. Read it through the mirror's own link
      // column — never by matching the two id spaces.
      const tp = await q(
        `SELECT number FROM trustpoint_draws WHERE sitewire_draw_id=$1::bigint AND application_id=$2`, [id, appId]);
      if (tp && tp.length) {
        const n = normNumber(tp[0].number);
        if (n != null) return n;
      }
      // Nothing numbered it. Fall back to the file's own ordering — but only when
      // that is safe (see ordinalFor).
      return ordinalFor(q, appId, { table: 'sitewire_draws', key: 'sitewire_draw_id', value: id });
    }

    // ---- a TrustPoint draw -------------------------------------------------
    if (ref.trustpointDrawId != null && ref.trustpointDrawId !== '') {
      const tp = await q(
        `SELECT number, sitewire_draw_id FROM trustpoint_draws WHERE tp_draw_id=$1 AND application_id=$2`,
        [String(ref.trustpointDrawId), appId]);
      if (tp == null || !tp.length) return null;
      const n = normNumber(tp[0].number);
      if (n != null) return n;
      // Unnumbered on TrustPoint but tied to a platform draw that IS numbered.
      if (tp[0].sitewire_draw_id != null) {
        return drawNumberFor(db, appId, { sitewireDrawId: tp[0].sitewire_draw_id });
      }
      return null;
    }

    // ---- a portal-composed draw -------------------------------------------
    if (ref.portalRequestId != null && ref.portalRequestId !== '') {
      const id = String(ref.portalRequestId);
      if (!/^\d+$/.test(id)) return null;
      // Once it has been closed out into the platform it carries a real number.
      const row = await q(
        `SELECT sitewire_draw_id FROM portal_draw_requests WHERE id=$1 AND application_id=$2`, [id, appId]);
      if (row == null || !row.length) return null;
      if (row[0].sitewire_draw_id != null) {
        const n = await drawNumberFor(db, appId, { sitewireDrawId: row[0].sitewire_draw_id });
        if (n != null) return n;
      }
      return ordinalFor(q, appId, { table: 'portal_draw_requests', key: 'id', value: id });
    }
  } catch (_) { /* never throw out of a subject-line helper */ }
  return null;
}

/**
 * The last resort: this draw's position in the file's own draw order.
 *
 * SAFE ONLY WHEN NOTHING ON THE FILE IS NUMBERED. If some of a file's draws carry
 * real platform numbers and this one does not, an ordinal would collide with them —
 * counting to "2" on a file whose platform already calls a different draw 2. So the
 * fallback refuses unless EVERY draw on the file is unnumbered, which is exactly the
 * portal case it exists for. Ordered by when we first saw each draw, so the answer
 * is stable across reads and across instances.
 */
async function ordinalFor(q, appId, { table, key, value }) {
  const ORDER = table === 'sitewire_draws'
    ? 'COALESCE(first_seen_at, created_at)'
    : 'created_at';
  const numbered = table === 'sitewire_draws'
    ? await q(`SELECT count(*)::int AS c FROM sitewire_draws WHERE application_id=$1 AND number IS NOT NULL`, [appId])
    : [{ c: 0 }];                                     // portal requests have no number column at all
  if (numbered == null) return null;
  if (Number(numbered[0] && numbered[0].c) > 0) return null;   // mixed — never guess

  const rows = await q(
    `SELECT ${key} AS k FROM ${table} WHERE application_id=$1 ORDER BY ${ORDER} ASC, ${key} ASC`, [appId]);
  if (rows == null) return null;
  const idx = rows.findIndex((r) => String(r.k) === String(value));
  return idx < 0 ? null : idx + 1;
}

/**
 * The convenience every call site actually wants: read the number and hand back the
 * ready subject tag ("Draw 2"), or null. One await, nothing to get wrong.
 */
async function drawTagForRef(db, appId, ref) {
  return drawLabel(await drawNumberFor(db, appId, ref));
}

/**
 * The same thing for a reminder that covers SEVERAL draws on one file — "Draws 2, 3".
 * A file's draws are a handful, and this only runs in the scheduled sweeps, so reading
 * them one at a time is fine and keeps the (already dense) digest SQL untouched.
 *
 * Inherits `drawTagFor`'s rule: if ANY of them cannot be named, the whole tag is
 * withheld rather than printing a list that reads complete and is not.
 */
async function drawTagForDraws(db, appId, ids, kind = 'sitewire') {
  const list = (Array.isArray(ids) ? ids : [ids]).filter((x) => x != null && x !== '');
  if (!list.length) return null;
  const nums = [];
  for (const id of list) {
    // `kind` names WHICH id space the caller is holding. The two are never
    // interchangeable — passing a TrustPoint or portal id as a platform draw id is the
    // trap that puts another draw's number (and downstream, another draw's money) in
    // front of a reader — so the caller states it rather than this guessing.
    const ref = kind === 'portal' ? { portalRequestId: id } : { sitewireDrawId: id };
    const n = await drawNumberFor(db, appId, ref);
    if (n == null) return null;
    nums.push(n);
  }
  return drawTagFor(nums);
}

module.exports = {
  drawLabel, drawTagFor, drawNumberFor, drawTagForRef, drawTagForDraws,
  _internals: { normNumber, ordinalFor },
};
