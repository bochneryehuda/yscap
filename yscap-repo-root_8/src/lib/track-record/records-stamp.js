'use strict';
/**
 * THE RECORDS STAMP — one definition of "this line is backed by the public
 * records (Elementix)", read by every screen and every export.
 *
 * ═══ TWO HONEST STATES, NEVER ONE ══════════════════════════════════════════
 * The owner asked for "a stamp that is coming from Elementix" on every property
 * imported through Elementix or verified through Elementix (2026-08-19). Those
 * are two different claims and the stamp must never collapse them:
 *
 *   'sourced'   — the LINE CAME FROM the county records: the Elementix importer
 *                 wrote it (`origin='public_records'`, importer.js header), or a
 *                 staged Elementix candidate was imported onto / merged into it
 *                 (`track_record_candidates.source='elementix'`). The figures
 *                 were copied from recorded deeds — but nobody has run the
 *                 line-by-line records check on THIS line.
 *   'verified'  — the records CHECK ran and the county records PROVED the deal:
 *                 a `track_record_pillars` row for ownership or exit carries
 *                 `auto_source='elementix'` + `auto_verdict='proved'` (db/494 —
 *                 the machine's observation columns, written only by
 *                 verify-run.js). This is the state the export stamp calls
 *                 "Verified to Elementix", the owner's own words.
 *
 * NEITHER state is `track_records.is_verified` — that is the HUMAN's full
 * verification for experience, a third thing, and this module never reads or
 * implies it. A re-run of the records check that stops proving (the records
 * changed, or an ambiguity appeared) downgrades the stamp on its own, because
 * the stamp is DERIVED on every read — never stored, so it can never go stale.
 *
 * ═══ WHY SQL FRAGMENTS, NOT A STORED COLUMN ════════════════════════════════
 * Three writers already record the provenance this stamp reads (the importer,
 * the candidate decisions, the verify run). A fourth writer maintaining a
 * denormalized stamp column would drift from them the first time one changed;
 * a derived CASE cannot. The lists this joins are per-borrower (dozens of
 * rows), so the correlated subqueries are cheap.
 *
 * The WORDING lives here too, once. The browser mirror is
 * `app-v2/src/components/track-record/RecordsStamp.jsx` (the portal cannot
 * require server code — the lib/payoff.js arrangement), and
 * `scripts/test-records-stamp-pure.js` reads BOTH files and fails the moment
 * the words disagree.
 */

const STAMP = { VERIFIED: 'verified', SOURCED: 'sourced' };

/** The pillar test — which rows make a line 'verified' to the records. Recency
 *  is derived from dates (auto_source='derived'), never a records match, so
 *  only ownership + exit count. */
const VERIFIED_PILLAR_WHERE = (a) => `
      sp.track_record_id = ${a}.id
      AND sp.pillar IN ('ownership','exit')
      AND sp.auto_source = 'elementix'
      AND sp.auto_verdict = 'proved'`;

/** WHAT DISQUALIFIES A LINE FROM 'verified', however many pillars proved.
 *
 *  A PROVED ownership beside a CONTRADICTED exit is the module's own headline
 *  finding — "they say they sold it and the records still show them owning
 *  it" — and an EXISTS over an OR would have printed "✓ Verified to Elementix"
 *  on exactly that line, on the investor package. A stamp that survives the
 *  records disagreeing with the line is not a verification, it is decoration.
 *
 *  A human REJECTION outranks the machine for the same reason the pillar table
 *  keeps `human_verdict` in its own column: a person looked at this and said
 *  no. The stamp must never re-assert over them. (`human_verdict='confirmed'`
 *  is deliberately NOT required — a records match is a fact about the records,
 *  and waiting for a human to co-sign it would make the stamp mean the human
 *  verification, which is the third thing this module must never imply.)
 *
 *  A disqualified line is not un-stamped: it falls through to the `sourced`
 *  branch, so a line that genuinely came from the records still says so. */
const VERIFIED_BLOCKED_WHERE = (a) => `
      sq.track_record_id = ${a}.id
      AND sq.pillar IN ('ownership','exit')
      AND (sq.auto_verdict = 'contradicted' OR sq.human_verdict = 'rejected')`;

/** The candidate test — which decided candidates make a line 'sourced'. A
 *  DECLINED candidate pointing at a line proves nothing about the line, so
 *  only the two success verbs count, each on its own id column. */
const SOURCED_CANDIDATE_WHERE = (a) => `
      sc.source = 'elementix'
      AND ((sc.imported_track_record_id = ${a}.id AND sc.status = 'imported')
        OR (sc.match_track_record_id = ${a}.id AND sc.status = 'merged'))`;

/** 'verified' | 'sourced' | NULL for one track_records row aliased `a`. */
function STAMP_SQL(a = 't') {
  return `CASE
    WHEN EXISTS (SELECT 1 FROM track_record_pillars sp WHERE ${VERIFIED_PILLAR_WHERE(a)})
      AND NOT EXISTS (SELECT 1 FROM track_record_pillars sq WHERE ${VERIFIED_BLOCKED_WHERE(a)})
    THEN 'verified'
    WHEN ${a}.origin = 'public_records'
      OR EXISTS (SELECT 1 FROM track_record_candidates sc WHERE ${SOURCED_CANDIDATE_WHERE(a)})
    THEN 'sourced'
    ELSE NULL
  END`;
}

/** When the stamp was earned: the records check for 'verified', the import
 *  decision (or the line's own creation) for 'sourced'. NULL with no stamp. */
function STAMP_AT_SQL(a = 't') {
  /* The pillar date is used ONLY while the line is actually verified — it is
     gated by the same disqualifier, or a contradicted line would fall back to
     'sourced' and then date that stamp by the records CHECK rather than by the
     import it is actually claiming. */
  return `COALESCE(
    (SELECT max(sp.auto_checked_at) FROM track_record_pillars sp
      WHERE ${VERIFIED_PILLAR_WHERE(a)}
        AND NOT EXISTS (SELECT 1 FROM track_record_pillars sq WHERE ${VERIFIED_BLOCKED_WHERE(a)})),
    (SELECT max(COALESCE(sc.decided_at, sc.created_at)) FROM track_record_candidates sc WHERE ${SOURCED_CANDIDATE_WHERE(a)}),
    CASE WHEN ${a}.origin = 'public_records' THEN ${a}.created_at END)`;
}

/** The two columns every list SELECT appends — one spelling everywhere. */
function stampSelect(a = 't') {
  return `${STAMP_SQL(a)} AS records_stamp, ${STAMP_AT_SQL(a)} AS records_stamp_at`;
}

/** An ENTITY's stamp: the db/400 adoption stamp names the source that put the
 *  company on the profile; 'elementix' is the deep import (deep-history.js).
 *  One state only — an entity's document verification (`llcs.is_verified`) is a
 *  human judgement about its papers, never a records claim. */
function ENTITY_STAMP_SQL(a = 'l') {
  return `CASE WHEN ${a}.adopted_source = 'elementix' THEN 'sourced' ELSE NULL END`;
}

/* ── THE WORDING, ONCE ─────────────────────────────────────────────────────
   Screen chips say "public records" (what the claim is about); the export
   stamp says "Elementix" by name — the owner's exact words for the artifact:
   "it should have a stamp which says 'Verified to Elementix'". Elementix is a
   records vendor, not a capital partner, so naming it breaks no scrub rule. */
const WORDING = {
  verified: {
    chip: 'VERIFIED · PUBLIC RECORDS',
    long: 'Matched to the county public records via Elementix',
    cell: '✓ Verified to Elementix',     // ✓ — a text glyph, never an emoji
    cellAscii: 'Verified to Elementix',  // the same claim, for a WinAnsi PDF font
    stamp: 'VERIFIED TO ELEMENTIX',
    stampSub: 'Matched to the county public records',
  },
  sourced: {
    chip: 'FROM PUBLIC RECORDS',
    long: 'Imported from the county public records via Elementix — not yet matched line by line',
    cell: '○ Sourced via Elementix',     // ○
    cellAscii: 'Sourced via Elementix',
    stamp: 'SOURCED VIA ELEMENTIX',
    stampSub: 'Imported from the county public records — not yet matched',
  },
};

/* THE THREE SOURCES ARE `timestamptz`, SO pg HANDS THIS A JS `Date`, NOT A
   STRING. src/db.js string-parses OID 1082 (`date`) only, so every server-side
   caller — the TPR investor cell, both saved-copy builders — was matching a
   regex against "Mon Aug 19 2026 …" and silently printing no date at all,
   forever. The browser mirrors never saw it because JSON serialises a Date to
   an ISO string on the way out, which is exactly why the mirror-drift guard
   could not catch it: it feeds strings to both sides.
   A Date is read in New York, matching how every other artifact here states a
   day (html-copy's own "saved …" line), so a 9pm stamp is not printed as
   tomorrow. `en-CA` yields YYYY-MM-DD; the result is re-validated and falls
   back to the UTC day rather than printing something malformed. */
const day = (v) => {
  if (v == null) return '';
  if (v instanceof Date) {
    if (!Number.isFinite(v.getTime())) return '';
    try {
      const s = v.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
      if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    } catch (_) { /* fall through to the UTC day */ }
    return v.toISOString().slice(0, 10);
  }
  const m = String(v).match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : '';
};

/**
 * The one-cell text for a spreadsheet / plain-text surface. '' with no stamp,
 * so an unstamped line's cell stays genuinely empty.
 *
 * `{ ascii: true }` DROPS THE GLYPH, and that is not cosmetic. pdf-lib's
 * StandardFonts are WinAnsi, which cannot encode `✓` (U+2713) or `○` (U+25CB)
 * — `drawText` THROWS on them. The investor package's track-record PDF is
 * built inside a try/catch that only console.warns, so a stamped line made the
 * whole PDF vanish from the delivered ZIP with nothing said on any screen.
 * (The repo's own tool PDF documents the same trap and avoids the glyphs; the
 * server renderer had to learn it too.) The WORDS are identical either way —
 * only the tick and the ring are dropped — so the two surfaces can never
 * disagree about what they claim, and `·`, the em dash and every letter used
 * here are all inside WinAnsi.
 */
function exportCellText(stamp, at, opts = {}) {
  const w = WORDING[stamp];
  if (!w) return '';
  const cell = opts && opts.ascii ? w.cellAscii : w.cell;
  const d = day(at);
  return d ? `${cell} · ${d}` : cell;
}

/**
 * The headline line for an export ("Verified to Elementix — N of M …").
 * Counts what the ROWS actually carry, so the sentence can never claim more
 * than the per-line cells show. Returns null when nothing is stamped — an
 * export with no records-backed line carries no stamp at all.
 */
function summaryLine(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const total = list.length;
  const verified = list.filter((r) => r && r.records_stamp === STAMP.VERIFIED).length;
  const sourced = list.filter((r) => r && r.records_stamp === STAMP.SOURCED).length;
  if (!verified && !sourced) return null;
  if (verified) {
    return `VERIFIED TO ELEMENTIX — ${verified} of ${total} propert${total === 1 ? 'y' : 'ies'} matched to the county public records`
      + (sourced ? `; ${sourced} more imported from the records` : '');
  }
  return `SOURCED VIA ELEMENTIX — ${sourced} of ${total} propert${total === 1 ? 'y' : 'ies'} imported from the county public records`;
}

module.exports = {
  STAMP, WORDING,
  STAMP_SQL, STAMP_AT_SQL, stampSelect, ENTITY_STAMP_SQL,
  exportCellText, summaryLine,
  _internals: { day, VERIFIED_PILLAR_WHERE, SOURCED_CANDIDATE_WHERE },
};
