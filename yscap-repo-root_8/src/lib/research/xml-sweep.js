'use strict';
/**
 * THE XMLs THAT ARE ALREADY ON THE FILES — the "previous" half of db/462.
 *
 * `xml-catch.js` closes the doors going forward. This walks the back book: every
 * appraisal data file already sitting in storage that never reached the research
 * warehouse, because the door it came through never fed one. On a system that has been
 * taking uploads for months that is the larger half of the market data we own — every
 * comparable sale on every one of those reports, already paid for and already in the
 * building.
 *
 * PREVIOUS AND FUTURE is the standing rule here, and it exists precisely because a
 * go-forward fix reads to the owner as no fix at all: the reports on today's files
 * start appearing and the hundreds already on disk never do.
 *
 * HOW IT DRAINS, AND WHY THE STAMP IS ON THE DOCUMENT.
 *
 * Each document it considers is stamped `research_xml_checked_at`, whatever the
 * verdict — "we looked, it was a rent roll" is an answer, and a sweep that only
 * remembers its successes re-reads every non-appraisal XML in storage on every boot,
 * forever. So the drain lives on the DOCUMENT and the outcome lives on the
 * `research_imports` ledger; the two questions stay separately answerable.
 *
 * THE ONE THING THAT IS DELIBERATELY NOT STAMPED IS A FAILED READ. If storage is
 * unreachable, or the object is missing, the document is left unstamped and tried
 * again next time. Stamping there is the mistake that quietly drains a real report out
 * of the sweep permanently on the strength of one outage — the same rule the appraisal
 * desk's `as_is_read_at` follows.
 *
 * WHAT IT LOOKS AT, AND WHAT IT REFUSES TO CARE ABOUT.
 *
 * Every stored document, including superseded ones, rejected ones and ones nobody has
 * reviewed. That is right and it is worth saying plainly: a comparable sale that
 * happened, happened. Whether a REVIEWER accepted the document as evidence on a loan
 * file is a question about that file, not about whether a house on the next street
 * sold for $412,000 in March. The warehouse is internal — nothing here ever leaves the
 * building, so the "a document nobody accepted never leaves the building" rule
 * (db/424) is untouched, and the report-level de-dup means an older version of a
 * report cannot double-count anything.
 *
 * It never creates a loan file, an appraisal, a condition, a finding or a
 * notification; it never writes to a loan file at all; and it never throws.
 */
const catcher = require('./xml-catch');

/* Documents considered per pass. In line with its siblings in the same boot block
   (the ingest back-fill runs 400, the roll-up refresh 500, subject placement 200) —
   the first cut ran 25, which on a ten-thousand-document back book is FOUR HUNDRED
   DEPLOYS to satisfy a rule whose name is "previous AND future". Each one is a
   storage read and a parse, but the pass is fire-and-forget behind an already-
   listening server, so the cost is background time, not latency. */
const DEFAULT_LIMIT = Number(process.env.RESEARCH_XML_SWEEP_FILES || 200);

/* After this many failed READS a document is settled and stops being asked. See
   db/462 §2b: not stamping a failed read is right, and on its own it starves the
   queue, because the oldest rows are exactly the ones whose storage is gone. */
const MAX_READ_ATTEMPTS = 3;

/* The work queue, written once and used by BOTH the selection and the count. The
   count used to omit the size filter, so an oversized XML — never selectable, so
   never stamped — inflated "still to look at" forever, and because the boot log is
   gated on `looked` it was reported once as phantom work and then never mentioned
   again. A silent cap is the one thing this repo's boot passes are not allowed to be. */
const QUEUE_SQL = `
  research_xml_checked_at IS NULL
  AND storage_ref IS NOT NULL
  AND coalesce(research_xml_attempts, 0) < ${MAX_READ_ATTEMPTS}
  AND (lower(coalesce(filename,'')) LIKE '%.xml'
       OR lower(coalesce(content_type,'')) LIKE '%xml%')
  AND coalesce(size_bytes, 0) <= $SIZE$`;
/* `$SIZE$` is replaced with the BIND MARKER ('$1'/'$2'), not with a number — the two
   consumers bind the ceiling in different positions. Substituting a bare '2' produces
   `<= 2`, a literal two bytes, and the queue silently matches nothing at all. */

/**
 * One bounded pass. Returns a shaped summary — every number a person might ask for,
 * including the ones that mean something went wrong.
 *
 * @param {{query:Function}} db
 * @returns {Promise<{ran, looked, filed, alreadyThere, notAppraisals, unreadable, readFailed, remaining}>}
 */
async function sweepOnce(db, { limit = DEFAULT_LIMIT } = {}) {
  const out = {
    ran: false, looked: 0, filed: 0, alreadyThere: 0,
    notAppraisals: 0, unreadable: 0, readFailed: 0, gaveUp: 0, remaining: null,
    comparables: 0, properties: 0,
  };
  if (process.env.RESEARCH_XML_SWEEP_DISABLED === '1') return out;
  if (!(limit > 0)) return out;

  let rows;
  try {
    // OLDEST FIRST, matching `ingest.backfill`: the end state is the same as if every
    // report had been filed as it arrived, so a later report's roll-up wins over an
    // earlier one exactly as it would have at the time.
    rows = (await db.query(
      `SELECT id, coalesce(research_xml_attempts, 0) AS attempts
         FROM documents
        WHERE ${QUEUE_SQL.replace('$SIZE$', '$2')}
        ORDER BY created_at
        LIMIT $1`,
      [limit, catcher.MAX_XML_BYTES])).rows;
  } catch (e) {
    // The column arrives with db/462; on a database that has not migrated yet this is
    // simply not time to run, and saying so is better than an alarm.
    console.warn('[research-xml-sweep] could not read the work queue (skipping):', (e && e.message) || e);
    return out;
  }
  if (!rows.length) { out.ran = true; out.remaining = 0; return out; }
  out.ran = true;

  for (const row of rows) {
    let r;
    try {
      r = await catcher.catchDocumentById(db, row.id, { why: 'already on a file' });
    } catch (e) {
      // `catchDocumentById` is written never to throw; this is the belt to its braces
      // so one pathological document cannot end the pass.
      r = { readFailed: true, reason: (e && e.message) || String(e) };
    }
    out.looked++;

    if (r.readFailed) {
      /* NOT STAMPED — the whole point is that a storage outage must not settle a real
         report. But the attempt IS counted, so a document whose bytes are genuinely
         gone stops holding the front of the queue after MAX_READ_ATTEMPTS. An outage
         is one attempt; three failures across three boots is not an outage. The
         give-up is COUNTED and named in the log, never silent. */
      out.readFailed++;
      const next = Number(row.attempts || 0) + 1;
      if (next >= MAX_READ_ATTEMPTS) out.gaveUp++;
      try {
        await db.query(
          `UPDATE documents SET research_xml_attempts = coalesce(research_xml_attempts,0) + 1
            WHERE id = $1`, [row.id]);
      } catch (_) { /* the counter is a courtesy; the read failure already stands */ }
      continue;
    }
    if (r.filed) {
      out.filed++;
      out.comparables += r.comparables || 0;
      out.properties += r.properties || 0;
    } else if (r.considered) {
      // It IS an appraisal: either already in the warehouse, or the parser could not
      // read it (a UAD 3.6 report, a truncated file). Either way the answer is settled
      // for these bytes, and the ledger row carries the reason in words.
      if (r.reason && /already in the database/i.test(r.reason)) out.alreadyThere++;
      else out.unreadable++;
    } else {
      out.notAppraisals++;
    }

    try {
      await db.query(`UPDATE documents SET research_xml_checked_at = now() WHERE id = $1`, [row.id]);
    } catch (e) {
      // Failing to stamp costs a repeat next pass — never the report.
      console.warn('[research-xml-sweep] could not stamp a document (it will be re-checked):', (e && e.message) || e);
    }
  }

  try {
    // THE SAME PREDICATE THE WORK QUEUE USES, so "still to look at" means documents
    // this pass could actually reach. Anything else is a number an operator cannot act
    // on, and it never falls to zero.
    out.remaining = (await db.query(
      `SELECT count(*)::int AS n FROM documents WHERE ${QUEUE_SQL.replace('$SIZE$', '$1')}`,
      [catcher.MAX_XML_BYTES])).rows[0].n;
  } catch (_) { /* the count is a courtesy */ }

  return out;
}

/**
 * The boot pass: one bounded sweep, announced only when it actually did something.
 * A quiet boot log is the point — this runs on every deploy for the rest of the
 * system's life, and once the back book is drained it has nothing to say.
 */
async function sweepOnBoot(db, opts = {}) {
  try {
    const r = await sweepOnce(db, opts);
    if (r.looked) {
      console.log(`[research-xml-sweep] looked at ${r.looked} stored file${r.looked === 1 ? '' : 's'}: `
        + `${r.filed} filed (${r.comparables} comparables, ${r.properties} properties), `
        + `${r.alreadyThere} already there, ${r.notAppraisals} not appraisals, `
        + `${r.unreadable} unreadable`
        + (r.readFailed ? `, ${r.readFailed} could not be read (will retry)` : '')
        + (r.gaveUp ? `, ${r.gaveUp} given up on after ${MAX_READ_ATTEMPTS} tries — their stored copy is gone` : '')
        + (r.remaining ? ` — ${r.remaining} still to look at` : ''));
    }
    return r;
  } catch (e) {
    console.error('[research-xml-sweep] pass failed (non-fatal):', (e && e.message) || e);
    return null;
  }
}

module.exports = { sweepOnce, sweepOnBoot, DEFAULT_LIMIT };
