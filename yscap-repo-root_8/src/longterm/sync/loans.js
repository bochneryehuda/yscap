'use strict';
/**
 * LONG-TERM — Phase 2, half two: bringing the loans in.
 *
 * Discovery says which loans exist and which have moved (discover.js, from the
 * pipeline). This mirrors them into `lt_loans`, records the stage they are at, and
 * pulls each one's team through the contact map. **Nothing is written to Encompass.**
 *
 * WHAT IS AND IS NOT TAKEN FROM THE PIPELINE — the plan's rule, made concrete.
 *
 *   The pipeline reads the Reporting Database, which lags a loan save and returns
 *   several computed fields as null. So it supplies IDENTITY and FRESHNESS only —
 *   the guid, the loan number, the folder, the milestone NAME, and when the loan
 *   last changed. Money, rate, term, DSCR and every other decision-bearing figure
 *   are deliberately left for the per-loan read, and this module writes none of
 *   them. `loan_amount` is the one borderline case and it is written from the
 *   pipeline ONLY to fill a blank, never to correct a value a real read established.
 *
 * FRESHNESS IS THE WHOLE ENGINE. `encompass_last_modified` is Encompass's own stamp;
 * `encompass_synced_at` is ours. A loan is re-read when Encompass's stamp is newer
 * than the one we stored — so an ordinary pass over 700 loans does almost no work,
 * and a loan somebody saved five minutes ago is picked up on the next tick.
 *
 * A FAILURE IS RECORDED ON THE LOAN, NOT SWALLOWED. `encompass_sync_error` holds the
 * reason one loan could not be read, and the pass continues. One unreadable file
 * must never stop the other 699, and a sync that fails silently is worse than one
 * that fails loudly — the column is what makes "why is this file stale?" answerable.
 *
 * SEPARATION: writes only `lt_*`.
 */

const stages = require('../stages');
// The master on/off switch. Asked DIRECTLY rather than through the Encompass client,
// because the tests replace that module wholesale in require.cache and a stub carries
// only the handful of methods the test needs — this one is pure and is never stubbed.
const killSwitch = require('../encompass/enabled');
const discover = require('./discover');
const contacts = require('../people/contacts');
const locks = require('../locks');
const milestones = require('../milestones');
const purchased = require('../milestone-purchased');
const productTerm = require('../product-term');
const trash = require('../trash');
const book = require('../pipeline-book');
const borrowerMatch = require('../borrower-match');
const application = require('../application/sync');
const vesting = require('../vesting');

const lazy = {
  get db() { return require('../db'); },
  get client() { return require('../encompass/client'); },
  get settings() { return require('../settings/store'); },
};

/** How many loans one pass will fully READ. Discovery is cheap; a loan read is not. */
const DEFAULT_READ_BUDGET = 25;

/**
 * Where a loan sits, in all three layers at once.
 *
 * The milestone name is stored VERBATIM — it is Encompass's word and the borrower's
 * label is derived from it, not from ours — and our own stage key is stored beside
 * it so the pipeline can group without re-deriving on every row. Both are written,
 * because an unmapped milestone must still land somewhere visible.
 */
function stageFor(milestoneName, settings) {
  const cfg = stages.configFrom(settings || {});
  const stage = stages.stageForMilestone(milestoneName, cfg);
  return { milestoneName: milestoneName || null, stageKey: stage.key, mapped: stage.mapped };
}

/**
 * Mirror what DISCOVERY knows. Identity and freshness only.
 *
 * NOTHING HERE CAN BLANK A COLUMN. The Reporting Database omits an unpopulated
 * field entirely, and reading that omission as "cleared" would empty the pipeline
 * a column at a time — so every column below is COALESCEd. Which side comes FIRST
 * is the real decision, and the two shapes mean different things:
 *
 *   COALESCE(EXCLUDED.x, lt_loans.x)  — the pipeline's value WINS when it has one
 *                                       (loan_number, borrower_name, loan_folder).
 *   COALESCE(lt_loans.x, EXCLUDED.x)  — FILL-ONLY: the pipeline may fill a blank
 *                                       and may never correct what is already
 *                                       there (loan_amount, milestone_name,
 *                                       stage_key), because the per-loan read is
 *                                       the authority on those and the pipeline's
 *                                       copy of them LAGS.
 *
 * `loan_amount` is fill-only for that reason, which is only safe because the full
 * read now writes it from field 1109 (owner-reported 2026-08-24). Before that it
 * was fill-only here and written NOWHERE else, so the figure was taken once at
 * discovery and never corrected — the bug this comment used to describe as though
 * it were the design.
 */
async function upsertDiscovered(dbc, loan, settings) {
  const { milestoneName, stageKey } = stageFor(loan.milestoneName, settings);
  const { rows } = await dbc.query(
    `INSERT INTO lt_loans
       (id, encompass_loan_guid, loan_number, loan_amount, milestone_name, stage_key,
        loan_folder, borrower_name, encompass_last_modified, updated_at,
        program_name, term_months)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $8, $7::timestamptz, now(), $9, $10)
     ON CONFLICT (encompass_loan_guid) DO UPDATE SET
       loan_number = COALESCE(EXCLUDED.loan_number, lt_loans.loan_number),
       borrower_name = COALESCE(EXCLUDED.borrower_name, lt_loans.borrower_name),
       loan_amount = COALESCE(lt_loans.loan_amount, EXCLUDED.loan_amount),
       -- FILL-ONLY since db/623. The pipeline's milestone column is the LAGGING
       -- active-form reading (it stays on the last WORKED step — Birch read
       -- "Funding" after Funding completed), while the full read establishes the
       -- SITTING milestone from the loan's own ladder. New-wins here would flip a
       -- healed loan back to the lagging form on every discovery pass; a real
       -- move still lands, because it bumps encompass_last_modified and the full
       -- read follows on the same tick.
       milestone_name = COALESCE(lt_loans.milestone_name, EXCLUDED.milestone_name),
       stage_key = COALESCE(lt_loans.stage_key, EXCLUDED.stage_key),
       loan_folder = COALESCE(EXCLUDED.loan_folder, lt_loans.loan_folder),
       -- THE TWO THAT SAY WHOSE LOAN THIS IS. Discovery now reads them (fields 1401
       -- and 4), and storing them here rather than waiting for the per-loan read is
       -- what makes the pipeline's "this is the long-term pipeline" filter work on a
       -- book that has only just been discovered — otherwise every loan reads as
       -- unclassifiable until its full read lands, which on 772 files is the whole
       -- first hour. COALESCE(new, old) like every other mirrored column: a pass that
       -- could not read them must never blank what we already hold.
       program_name = COALESCE(EXCLUDED.program_name, lt_loans.program_name),
       term_months = COALESCE(EXCLUDED.term_months, lt_loans.term_months),
       encompass_last_modified = GREATEST(
         COALESCE(EXCLUDED.encompass_last_modified, lt_loans.encompass_last_modified),
         COALESCE(lt_loans.encompass_last_modified, EXCLUDED.encompass_last_modified)),
       updated_at = now()
     RETURNING id, encompass_synced_at, encompass_last_modified, milestone_name,
               encompass_sync_error`,
    // Discovery has always READ `Loan.BorrowerName` and thrown it away. It is the
    // only thing an admin can recognise a loan's borrower BY while deciding a
    // link, and it costs nothing — it is already on the row we are writing.
    [loan.encompassLoanGuid, loan.loanNumber, loan.loanAmount, milestoneName, stageKey,
      loan.loanFolder, loan.lastModified, loan.borrowerName || null,
      loan.programName == null ? null : loan.programName,
      loan.termMonths == null ? null : loan.termMonths],
  );
  // WHAT THE PIPELINE SAID THIS PASS, carried out beside what we hold. The row's
  // own `milestone_name` is the FILL-ONLY column above — deliberately unchanged by
  // discovery — so the two together are "where Encompass says the file is" and
  // "where we last established it". `needsRead` compares them; see its header.
  return { ...rows[0], pipeline_milestone: milestoneName || null };
}

/** How long a loan may go unread before it is re-read on the ROTA alone, whatever
 *  the stamps say. `0` switches the rota off and restores stamp-only freshness. */
const REREAD_HOURS = (() => {
  const n = parseInt(process.env.LT_ENCOMPASS_REREAD_HOURS || '12', 10);
  return Number.isFinite(n) && n >= 0 ? n : 12;
})();

/** How long the milestone-move trigger waits before it may fire again for the same
 *  loan. A ceiling on the pathological case only — see `needsRead`. */
const MOVE_FLOOR_MIN = (() => {
  const n = parseInt(process.env.LT_ENCOMPASS_MOVE_FLOOR_MIN || '10', 10);
  return Number.isFinite(n) && n >= 0 ? n : 10;
})();

/** The same rota, for a loan whose last read left a recorded miss. Bounded by
 *  REREAD_HOURS, because a "sooner" that is later than the ordinary rota is not
 *  sooner — and setting REREAD_HOURS to 0 switches the whole rota off, which this
 *  must not quietly override. */
const PARTIAL_REREAD_HOURS = (() => {
  const n = parseInt(process.env.LT_ENCOMPASS_PARTIAL_REREAD_HOURS || '1', 10);
  const v = Number.isFinite(n) && n >= 0 ? n : 1;
  return REREAD_HOURS > 0 ? Math.min(v, REREAD_HOURS) : v;
})();

/**
 * Are these two the same milestone?
 *
 * COMPARED ON THE NAME, AND THE NAME ONLY — MEASURED, NOT ASSUMED. The first
 * version of this compared STAGES, on the theory that the pipeline's active-form
 * wording and the stored form would drift ("Submittal" against "Submitted") and a
 * strict comparison would call every loan changed on every pass. Seventeen real
 * loans, one per distinct milestone in the book, say otherwise:
 *
 *     13 of 17   pipeline and stored agree EXACTLY — both sides use the same
 *                Encompass vocabulary, with no drift at all
 *      2 of 17   genuinely stale (pipeline "Schedule Closing" over a stored
 *                "Clear To Close"; pipeline "Submittal" over a stored "Started")
 *      2 of 17   the pipeline did not return the loan, so there is nothing to
 *                compare and this never speaks
 *
 * So the drift the stage comparison existed to absorb does not happen, and the
 * stage comparison ACTIVELY BROKE the feature: `Final Docs`, `Investor Delivery`
 * and `Purchasing Conditions` all map to `post_closing`, so a file moving between
 * them would have compared EQUAL and never been re-read — three of the busiest
 * steps in this book, silently blind. Comparing the name is both simpler and
 * strictly more sensitive.
 *
 * A missing value on either side is NOT a disagreement: a pass that could not read
 * the milestone must stay quiet rather than declare every loan moved.
 */
function sameMilestone(a, b) {
  const norm = (v) => String(v == null ? '' : v).trim().toLowerCase().replace(/\s+/g, ' ');
  const na = norm(a); const nb = norm(b);
  if (!na || !nb) return true;
  return na === nb;
}

/**
 * Does this loan need a full read?
 *
 * Never read → yes. Encompass's stamp newer than our sync → yes. Not read for
 * `REREAD_HOURS` → yes, on the rota. Otherwise no.
 *
 * THE ROTA IS THE POINT OF THIS FUNCTION NOW (owner-reported 2026-08-25: three
 * Sherman Ave files that never filled in, a loan stuck on "File started" after LO
 * Prep completed, and the full-pull button appearing to do nothing — all three were
 * this test answering NOT DUE). The stamp comparison had TWO ways to freeze a loan
 * for ever, and both had actually happened:
 *
 *   · A WRONG STAMP. `encompass_last_modified` was being stored four hours early
 *     (`tenant-time`'s header has the measurement), so it could never overtake an
 *     `encompass_synced_at` set after the edit. Fixed at the parser — and fixing the
 *     parser alone would have left the same trap armed for the next stamp problem.
 *   · NO STAMP AT ALL. `if (!encompass_last_modified) return false` read "we cannot
 *     prove it changed" as "never look again", so one loan the pipeline search
 *     returned no date for was mirrored once and abandoned.
 *
 * A MIRROR MUST FAIL TOWARD LOOKING AGAIN. The cost of the rota is one read per loan
 * per twelve hours — on a ~770-loan book, comfortably inside one pass's budget over
 * a day, and nothing at all on a book that is being read for other reasons anyway.
 * The cost of the old reading was a file frozen in the state it was discovered in,
 * silently, with every screen insisting it had been read. An unreadable stamp is
 * treated the same way: look again.
 */
function needsRead(row, now = Date.now(), settings = {}) {
  if (!row) return false;

  // ═══════════════════════════════════════════════════════════════════════
  // THE MILESTONE MOVED, WHATEVER THE STAMPS SAY.
  //
  // MEASURED on YSCAP258134720, 2026-08-25 16:01Z, after the owner reported a
  // status they had changed half an hour earlier still not showing:
  //
  //     Encompass pipeline   milestone "Clear To Close"
  //                          Loan.LastModified "8/25/2026 8:30:05 AM"
  //     PILOT                milestone_name "Submittal"
  //                          encompass_synced_at 13:02:27Z  (= 9:02 AM, tenant time)
  //
  // The stamp is converted correctly — 8:30 AM tenant time IS 12:30:05Z. The
  // problem is that it never moved: the milestone was completed HOURS after
  // 8:30 AM and `Loan.LastModified` still reads 8:30 AM. **Completing a milestone
  // does not touch this tenant's LastModified.**
  //
  // Everything below this block compares stamps, so a milestone move was invisible
  // to all of it. `upsertDiscovered`'s own comment states the premise out loud —
  // *"a real move still lands, because it bumps encompass_last_modified and the
  // full read follows on the same tick"* — and that premise is false. A file could
  // walk the entire ladder and wait the full twelve-hour rota to be noticed.
  //
  // The answer costs NOTHING. Discovery already asks the pipeline for
  // `Loan.CurrentMilestoneName` on every pass (discover.js) and already throws it
  // away. So the fresh milestone is in hand every five minutes; it just had no way
  // to say anything. Now a disagreement between what the pipeline reports and what
  // we last established IS the trigger.
  //
  // ONLY THE TRIGGER CHANGES, NEVER THE STORED VALUE. The pipeline's milestone is
  // the LAGGING active-form reading (it sits on the last WORKED step), while the
  // full read establishes the SITTING milestone from the loan's own ladder — which
  // is why discovery's write stays fill-only. This does not adopt the lagging
  // value; it uses the DISAGREEMENT as evidence that the file moved, and sends the
  // ladder read to find out where it really stands.
  //
  // A loan we have never read is caught by the next test anyway, so this one only
  // ever speaks about a loan we have a settled milestone for.
  //
  // BOUNDED, SO A LOAN THAT NEVER SETTLES CANNOT SPIN. The measurement above says
  // this converges — a read brings the two into agreement and the trigger goes
  // quiet — but "measured to converge" is not "cannot fail to", and the failure
  // mode is a loan re-read every five minutes for ever against a call budget
  // shared with every other integration on this tenant. So the move trigger will
  // not fire twice inside MOVE_FLOOR_MIN minutes. Ten is far below the twelve-hour
  // rota it replaces and far above the five-minute sweep, so in ordinary use it
  // never speaks; it exists to put a ceiling on the pathological case.
  if (row.milestone_name && row.pipeline_milestone
      && !sameMilestone(row.pipeline_milestone, row.milestone_name)) {
    const synced = row.encompass_synced_at ? new Date(row.encompass_synced_at).getTime() : NaN;
    if (!Number.isFinite(synced) || now - synced >= MOVE_FLOOR_MIN * 60 * 1000) return true;
  }

  if (!row.encompass_synced_at) return true;
  const synced = new Date(row.encompass_synced_at).getTime();
  // A stamp we cannot read is not evidence that the loan is up to date.
  if (!Number.isFinite(synced)) return true;
  // A READ THAT CAME BACK EMPTY COMES ROUND AGAIN SOONER. `readLoan` now records
  // what a read failed to fill, and a loan carrying one of those notes is a loan
  // somebody is looking at a blank screen for. Twelve hours is the right patience
  // for a file that is merely OLD; it is far too much for one that is EMPTY.
  //
  // It is an hour rather than "immediately" on purpose: not stamping at all, or
  // re-reading every tick, would put a permanently unfillable loan in a hot loop
  // against a call budget shared with every other integration on this tenant. An
  // hour is twelve chances a day where there was one, and still bounded.
  if (row.encompass_sync_error && REREAD_HOURS > 0
      && now - synced >= PARTIAL_REREAD_HOURS * 3600 * 1000) return true;
  if (REREAD_HOURS > 0 && now - synced >= REREAD_HOURS * 3600 * 1000) return true;
  if (!row.encompass_last_modified) return false;
  const modified = new Date(row.encompass_last_modified).getTime();
  if (!Number.isFinite(modified)) return false;
  return modified > synced;
}

/**
 * THE ONE SPELLING of a partial read, shared with the screen that has to tell a
 * PARTIAL read apart from a file that could not be read at all. The owner was
 * misled once by a heading that called both 'files we could not read', so the
 * distinction is carried in data rather than re-derived by matching prose twice.
 */
const PARTIAL_READ_PREFIX = 'Read from Encompass, but';

/**
 * WHICH PARTS OF A READ ACTUALLY MISSED — and, just as importantly, which ones
 * were CORRECTLY empty (owner-reported 2026-08-25: sixteen files listed under
 * "Files we could not read", every one of them read perfectly).
 *
 * THE DEFECT THIS REPLACES WAS MINE, and it was introduced by the fix for the
 * opposite problem. When a read used to stamp itself green before it filled the
 * file, I made every part that wrote nothing a MISS: `r.written === false`. That
 * conflated two completely different things —
 *
 *   · the part FAILED — we asked and could not get an answer, and
 *   · the part had NOTHING TO WRITE — we asked, Encompass answered, and the
 *     field is genuinely empty on this file.
 *
 * — and the second is the ordinary state of a brand-new or a withdrawn file. An
 * investor is assigned late; a file at "Started" has none, and a withdrawn file
 * never will. MEASURED on the sixteen: five sit at Started (Prospect, Pipeline,
 * Pre-Approval) and eleven are Withdrawn or Trash. Asked of Encompass directly,
 * with its own credentials: HTTP 200, all five investor fields absent from the
 * payload, no INVESTOR contact. The read was perfect. It had nothing to write.
 * PILOT called that a failure, showed it as unreadable, counted it as Failing,
 * and re-read those files every hour, forever, for a field that will never fill.
 *
 * The old test was `r.written === false`, which was also applied unevenly:
 * `syncBorrowerPairs` reports `{pairs: 0}` and carries no `written` key at all,
 * so a loan with no borrowers was never flagged while a loan with no investor
 * always was. A signal that only fires on the parts that happen to share a key
 * is not a signal.
 *
 * SO: a MISS is a part that failed — nothing came back, or it answered `ok:false`.
 * That is all. An empty part is recorded separately and alarms nobody.
 *
 * THE ORIGINAL PROTECTION IS KEPT, and sharpened. The defect that started this
 * was a read that answered and filled NOTHING (owner-reported: "Sherman files
 * read but empty"). One empty part among four is an early file; ALL FOUR empty
 * on a read that answered is that defect, and it is still reported. Because the
 * four parts report success in three different shapes, `filled` reads all of
 * them rather than the one key three of them happen to share.
 */
function classifyParts(parts) {
  const filled = (r) => {
    if (!r || r.ok === false) return false;
    if (r.written === true) return true;
    return Number(r.pairs) > 0 || Number(r.parties) > 0 || Number(r.found) > 0;
  };
  const misses = [];
  const empties = [];
  for (const { what, result } of parts) {
    if (!result) { misses.push(`${what}: nothing came back`); continue; }
    if (result.ok === false) { misses.push(`${what}: ${result.reason || 'failed'}`); continue; }
    if (!filled(result)) empties.push(`${what}: ${result.reason || 'the payload carried nothing'}`);
  }
  return { misses, empties, filledAny: parts.some((p) => filled(p.result)) };
}

/**
 * Read ONE loan properly and write what it says. READ-ONLY against Encompass.
 *
 * The milestone comes from the loan itself here rather than from the pipeline,
 * because the pipeline lags a save and the stage is what every screen groups by.
 */
async function readLoan(loanId, guid, settings) {
  let loan;
  try {
    loan = await lazy.client.getLoan(guid);
  } catch (e) {
    const reason = String((e && e.message) || e).slice(0, 500);
    await lazy.db.query(
      `UPDATE lt_loans SET encompass_sync_error = $2, updated_at = now() WHERE id = $1::uuid`,
      [loanId, reason],
    );
    return { ok: false, reason };
  }

  // WHERE THE FILE STANDS (db/623 + owner-directed 2026-08-24, Birch Dr). The
  // loan's own milestone LADDER decides: the file stands at its LAST COMPLETED
  // step, and every screen displays that step's COMPLETED wording
  // (`stages.completedFormLabel` — Funding done reads "Funded", never
  // "Funding" and never the not-yet-happened "Investor Delivery"). The loan
  // JSON's `currentMilestone` is the fallback for a ladder that could not be
  // read — it carries the last WORKED step until somebody starts the next,
  // which AGREES with the last-completed standing on any loan whose next step
  // has not started.
  const ladderMod = require('./milestone-ladder');
  const ladder = await ladderMod.readLadder(guid, { client: lazy.client });
  //
  // THE KEY IS `milestoneCurrentName`, AND THE THREE THAT WERE HERE DO NOT EXIST.
  // Measured against this repo's own 772-loan field dictionary, which was built from
  // live Encompass answers:
  //
  //     currentMilestone                    0 occurrences
  //     currentMilestoneName                0 occurrences
  //     loanProductData.currentMilestone    0 occurrences
  //     milestoneCurrentName                MS.STATUS, "Tracking - Current Milestone
  //                                         Name", 100% filled at EVERY stage
  //                                         including "Started", across 490 DSCR loans
  //
  // So this whole fallback has always evaluated to `undefined`, and a loan whose
  // ladder read failed before it was ever laddered kept discovery's "Started" for
  // ever — which is the "stuck on File started" report, precisely. RTL has read the
  // right key all along (`src/encompass/enrich.js`), which is why only Long-Term
  // showed the symptom.
  //
  // The three dead keys are KEPT behind the live one rather than deleted: they cost
  // nothing, and if this tenant is ever configured to send one of them, the fallback
  // still works. What matters is that the key which is actually filled is asked FIRST.
  //
  // Read off `loan` and nothing else. MS.STATUS reaches this function a second way —
  // `ms.status`, read by number through the field batch — but that batch is issued a
  // hundred and fifty lines BELOW this point, so naming it here would be a reference
  // to a `const` in its temporal dead zone: a ReferenceError on every single read,
  // thrown from inside the drain loop. `loan` is already in hand and already proven
  // (we are past `getLoan`'s catch), so it is the only honest source at this line.
  const laggingMilestone = loan && (loan.milestoneCurrentName || loan.currentMilestone
    || loan.currentMilestoneName
    || (loan.loanProductData && loan.loanProductData.currentMilestone));

  // …BUT THE FALLBACK IS ONLY FOR A LOAN THAT HAS NO LADDER YET (audit round 3,
  // D3). On an ALREADY-LADDERED loan the lagging field is the last WORKED step,
  // which under the last-completed rule is the step AHEAD of where the loan
  // stands the moment somebody starts working it — so a failed ladder read used
  // to walk the standing forward, record an `entered` event for a move that
  // never happened, and RESET `milestone_since` to the moment of the failure
  // (the "at this milestone N days" figure dropping to 0 on a step the loan had
  // been past for weeks). `realignStanding` would then quietly put the
  // milestone back, leaving the bogus event and the reset clock behind.
  //
  // So: a ladder we could read decides; a ladder we could NOT read on a loan
  // that already has one claims NOTHING (null → the COALESCE below keeps what
  // we hold, and `writeMilestone` sees no change). Only a loan with no ladder
  // at all still takes the lagging reading, which is better than nothing.
  let laddered = false;
  // Whether the probe ANSWERED at all. Two different rules read this one fact
  // and they need it to fail in OPPOSITE directions, so a single boolean cannot
  // carry both (see `redefinition` below): the D3 fallback is safe when an
  // unreadable probe reads as ALREADY laddered, and the phantom-event guard is
  // safe when it reads as a FIRST read. Both conservative answers hold at once
  // — claim no milestone, and record no movement — but only if the failure
  // itself is remembered rather than collapsed into `laddered`.
  let probeAnswered = true;
  try {
    const { rows: lr } = await lazy.db.query(
      'SELECT ladder_synced_at FROM lt_loans WHERE id = $1::uuid', [String(loanId)]);
    laddered = !!(lr.length && lr[0].ladder_synced_at);
  } catch (e) {
    probeAnswered = false;
    // FAIL TOWARD THE SAFE READING (audit round 4). Defaulting to `false`
    // here means an unreadable probe reinstates the very fallback D3
    // removed — so on the one path that reaches this line (the ladder read
    // ALREADY failed) a second failure would bring back the phantom event
    // and the reset clock. Treating the loan as laddered simply claims
    // nothing; the only loan it under-serves is a brand-new one, which
    // waits a pass.
    laddered = true;
    // …but SAY SO. Failing closed silently is only half the rule (round 5,
    // defect 6): without this line a loan that quietly claims no milestone,
    // pass after pass, looks identical to one Encompass has nothing to say
    // about, and nobody would know which. Value-free, like every log here.
    console.warn('[lt-sync] could not read ladder_synced_at for a loan — claiming no milestone this pass:',
      String((e && e.message) || e).slice(0, 200));
  }

  const standing = ladder.ok ? ladder.sitting : (laddered ? null : laggingMilestone);
  // CLAIMING NOTHING MEANS CLAIMING NOTHING — including the STAGE.
  // `stageFor(null)` answers the UNMAPPED bucket ('other'), which is a real
  // value, and the UPDATE below COALESCEs it OVER the stage we already hold —
  // so a failed ladder read would drop a correctly-bucketed loan into "Other".
  const { milestoneName, stageKey } = standing
    ? stageFor(standing, settings)
    : { milestoneName: null, stageKey: null };

  // WHICH PRODUCT IS THIS LOAN? The pipeline discovers with `Loan.LoanAmount > 0`
  // — the WHOLE Encompass book — because no folder separates the two products at
  // the source, so the long-term side mirrors RTL loans too and nothing told them
  // apart. `product-term.js` is that rule (owner-directed 2026-08-16: a program
  // naming FLIP is short-term; under 36 months is short-term; over 36 is the
  // long-term list). It needs two facts, and BOTH ride on the loan we already
  // hold — no second call and no fieldReader batch:
  //   · term  — field 4,    $.loanAmortizationTermMonths (int, filled on 760/772)
  //   · program — field 1401, $.loanProgramName          (str, filled on 754/772)
  // Read off the JSON deliberately rather than added to the fieldReader ids: the
  // LT client does NOT split a failed batch, so one unpermitted id would blank the
  // team AND the lock read for every loan. `_fieldValues`, when a caller has
  // already read them, still WINS — a value read by NUMBER is authoritative, and
  // the same field number sits at a different path from loan to loan.
  const fv = (loan && loan._fieldValues) || null;
  const termMonths = productTerm.termMonthsOf(
    (fv && (fv['4'] != null ? fv['4'] : fv[4])) ?? (loan && loan.loanAmortizationTermMonths),
  );
  const programName = String(
    (fv && (fv['1401'] != null ? fv['1401'] : fv[1401])) ?? (loan && loan.loanProgramName) ?? '',
  ).trim() || null;

  // THE LOAN AMOUNT, CORRECTED BY THE REAL READ (owner-reported 2026-08-24:
  // *"The loan amounts always need to update"*). It was written ONLY by
  // `upsertDiscovered`, and fill-only there — so the figure was taken once when
  // the loan was first discovered and never corrected again, on the pipeline's
  // own lagging copy. Every other decision-bearing figure on this loan (rate,
  // DSCR, the ARM terms, the expenses) is refreshed by the application sync
  // below; this one column was simply missed, and the module header has claimed
  // since it shipped that discovery fills a blank "never to correct a value a
  // real read established" — this is the real read that was supposed to.
  //
  // Field 1109, read BY NUMBER and falling back to the path, exactly as term (4)
  // and program (1401) above: the same field number sits at a different JSON path
  // from loan to loan, so a value read by number wins. Written through the same
  // COALESCE(new, old) never-blank rule — a read that could not see the amount
  // must never blank one we hold, while a real change lands.
  const loanAmount = (() => {
    const raw = (fv && (fv['1109'] != null ? fv['1109'] : fv[1109])) ?? (loan && loan.baseLoanAmount);
    if (raw == null || String(raw).trim() === '') return null;
    const n = Number(String(raw).replace(/[$,\s]/g, ''));
    // A figure we cannot read cleanly states NOTHING rather than writing a 0 or a
    // NaN over a real amount — this column is money on a mortgage.
    return Number.isFinite(n) && n >= 0 ? n : null;
  })();

  // WHO IS THE BORROWER? `lt_loans.borrower_id` has existed since db/549 and
  // nothing has ever written it, so a borrower signing in sees none of their
  // long-term files (owner-directed 2026-08-16). The link is proposed by matching
  // the borrower's EMAIL against their PILOT profile, and the address is right
  // here on the loan we already hold — field 1240,
  // `$.applications[0].borrower.emailAddressText`, filled on 92.4% of the DSCR
  // cohort (dictionary/field-dictionary.json, 772 loans, 2026-08-14). Read off the
  // JSON for the same reason the term and the program are: the LT client does not
  // split a failed fieldReader batch, so one unpermitted id would blank the team
  // and the lock for every loan. A value read BY NUMBER still wins where a caller
  // already has one — the same field sits at a different path from loan to loan.
  const app0 = (loan && Array.isArray(loan.applications) && loan.applications[0]) || null;
  const b0 = (app0 && app0.borrower) || null;
  const byNum = (id) => (fv && (fv[String(id)] != null ? fv[String(id)] : fv[id])) ?? undefined;
  const text = (v) => String(v == null ? '' : v).trim() || null;
  const borrowerFirst = text(byNum(4000) ?? (b0 && b0.firstName));
  const borrowerLast = text(byNum(4002) ?? (b0 && b0.lastName));
  // Stored normalised, because the matcher compares lowercased on both sides and
  // an index on a column half of whose rows carry stray casing is a lookup miss
  // dressed up as "no such borrower".
  const borrowerEmail = borrowerMatch.normalizeEmail(
    byNum(1240) ?? (b0 && b0.emailAddressText),
  ) || null;

  // HAS THE INVESTOR BOUGHT THIS LOAN? The owner's own workflow carries a PURCHASED
  // step that Encompass's nineteen milestones do not (owner-directed 2026-08-23), and
  // the fact behind it has been sitting on the loan payload unread all along: field
  // 2031, `$.rateLock.sellSideInvestorStatus` — a read-only Encompass dropdown filled
  // on 100% of loans at Investor Delivery, Purchasing Conditions and Final Docs — with
  // field 2370, `$.rateLock.date`, carrying the purchase advice DATE beside it.
  //
  // Read off the JSON for exactly the reason the term and the borrower's email are:
  // the long-term client does NOT split a failed fieldReader batch, so adding two ids
  // to it would risk blanking the team AND the lock read for every loan in the book to
  // learn one fact that is already in hand. A value read BY NUMBER still wins where a
  // caller has one.
  //
  // THREE ANSWERS, NOT TWO. A status Encompass did not give is `null` — not "no" —
  // and it leaves both columns exactly as they are, because an absent reading is not
  // evidence of anything. A status that is present but is NOT a purchased value
  // CLEARS the stamp: a sale corrected away in Encompass must not leave "Purchased"
  // standing here. That is why these two columns are written PLAINLY and are the only
  // two on this statement not wrapped in COALESCE.
  const sale = purchased.readPurchase(loan, purchased.configFrom(settings || {}));

  // ONE fieldReader for everything read by number — the team's ids, the lock's and
  // the two status-wording ids together. The pacing rule on this tenant is a
  // self-imposed gap between calls, so two calls per loan is twice as long holding
  // a connection the whole company shares. Every id in this batch is VERIFIED
  // (MS.STATUS/MS.STATUSDATE live-probed 2026-08-24 — the FR0117 lesson: the LT
  // client does NOT split a failed batch, so one bad id blanks every read).
  // A failure here is its own: a loan whose team or lock could not be read is
  // still a loan we successfully mirrored, and the failure must not undo that.
  //
  // THE ID LIST IS BUILT OUTSIDE THE try, AND THAT PLACEMENT IS THE LESSON OF A REAL
  // OUTAGE (2026-08-25). `vesting.js` was replaced by a module of the same name whose
  // job was the OPPOSITE end of this pipe — the display rule — so `vesting.FIELD_IDS`
  // became `undefined`, spreading it threw a TypeError, and the catch below swallowed
  // it into `values = null`. That reads to every consumer as "Encompass returned
  // nothing", so the team, the rate lock, the milestone ladder AND the vesting were
  // silently blank on EVERY loan, on every read, with no error anywhere. The catch is
  // for a VENDOR miss — a timeout, a 400, an unpermitted id — which is genuinely not
  // this loan's fault and must not undo a mirror that otherwise succeeded. A mistake
  // in OUR OWN code is not that, and must fail loudly the first time it runs.
  const ids = [...new Set([
    ...contacts.fieldIdsFor(settings), ...locks.fieldIdsFor(settings),
    ...ladderMod.MS_FIELD_IDS, ...vesting.FIELD_IDS,
  ])];
  let values = null;
  try {
    if (ids.length) values = await lazy.client.fieldReader(guid, ids);
  } catch (_) { /* each consumer below reports its own miss */ }
  const ms = ladderMod.msStatusOf(values);
  // HOW TITLE VESTS (db/624, owner-directed): field 4008 decides, and only an
  // entity vesting ever reads the entity name — "individual" means individual.
  const vest = vesting.vestingOf(values);

  // What we held BEFORE the write, because the write is what destroys the evidence.
  // Encompass's own milestone log is 403 on this tenant, so noticing that the
  // milestone is not what it was is the only history available — and it can only be
  // noticed from here, one statement earlier than the UPDATE.
  const priorMilestone = await milestones.loadPrior(loanId);

  await lazy.db.query(
    `UPDATE lt_loans
        SET milestone_name = COALESCE($2, milestone_name),
            stage_key = COALESCE($3, stage_key),
            term_months = COALESCE($4, term_months),
            program_name = COALESCE($5, program_name),
            borrower_first_name = COALESCE($6, borrower_first_name),
            borrower_last_name = COALESCE($7, borrower_last_name),
            borrower_email = COALESCE($8, borrower_email),
            purchased_status = CASE WHEN $9::boolean THEN $10 ELSE purchased_status END,
            purchased_at = CASE WHEN $9::boolean THEN $11::date ELSE purchased_at END,
            ms_status = COALESCE($12, ms_status),
            ms_status_date = COALESCE($13, ms_status_date),
            vesting_type = CASE WHEN $14::boolean THEN $15 ELSE vesting_type END,
            vesting_entity_name = CASE WHEN $14::boolean THEN $16 ELSE vesting_entity_name END,
            loan_amount = COALESCE($17::numeric, loan_amount),
            updated_at = now()
      WHERE id = $1::uuid`,
    // COALESCE(new, old) — the milestone's own rule. A read that could not see the
    // term (an older payload, a partial read) must never BLANK one we already hold;
    // a real change still lands, because Encompass is the authority on both.
    // The borrower's identity rides the same COALESCE rule, and it matters more
    // here than anywhere else on the row: blanking an email would silently drop
    // every loan on that address out of its confirmed link, and the borrower would
    // watch their own files disappear from their login with nothing having changed.
    // $9 is "Encompass answered about the sale at all". Only then are $10/$11 written,
    // so a read that could not see the field leaves a recorded purchase alone while a
    // read that saw "Shipped" genuinely clears one. $12/$13 are the tenant's own
    // status wording + stamp (MS.STATUS/MS.STATUSDATE), same never-blank rule.
    // $14 is "field 4008 answered at all": only then are $15/$16 written PLAINLY —
    // a loan re-vested from an entity to an individual must have its entity name
    // CLEARED (the owner's "individual means individual"), which COALESCE could
    // never do; while a read that saw nothing leaves both columns alone.
    [loanId, milestoneName, stageKey, termMonths, programName,
      borrowerFirst, borrowerLast, borrowerEmail,
      sale.purchased !== null, sale.status, sale.at,
      ms.status, ms.date,
      vest.answered, vest.vestingType, vest.entityName,
      loanAmount],
  );

  // ═══════════════════════════════════════════════════════════════════════
  // THE FIRST LADDER READ IS A RE-DEFINITION, NOT A MOVE — THE SECOND CALL
  // SITE (post-merge audit, defect 1).
  //
  // `ladderOne` got this guard in round 5; THIS function performs the IDENTICAL
  // conversion and did not, which made the fix worth nothing in practice: the
  // worker drains loans through here BEFORE it runs the ladder backfill, so on
  // the ordinary sync path every already-synced loan still gained a BACKWARD
  // "Investor Delivery -> Funding" event that never happened, had
  // `milestone_since` reset to now, and had `milestone_since_is_baseline`
  // cleared — the exact outcome round 5 believed it had closed. The
  // Encompass webhook nudges a loan straight down this path, so it is also the
  // path that runs on a real milestone change.
  //
  // THE LESSON, which is the standing rule in CLAUDE.md and was broken anyway:
  // a rule pinned at one of its two call sites is not fixed, it is half-fixed,
  // and the half that is left is the one that runs first.
  //
  // Same reading as the ladder twin: before db/623 the mirror stored the
  // LAGGING active milestone and stamped `milestone_since`, so on the FIRST
  // ladder read the last-done standing legitimately differs from what is
  // stored. That is a re-definition of the position we were already looking at,
  // not a movement — so the standing is written (the UPDATE above already did
  // it) and NO event is recorded, leaving the clock and its honest baseline
  // flag exactly as they were.
  //
  // Gated on `ladder.ok` because the conversion only happens when a ladder was
  // actually read; with no ladder in hand the ordinary rules still apply. A
  // genuinely new loan has no `milestone_since`, so `hasRecord` is false and it
  // still gets its baseline. An unanswered probe counts as a first read, so it
  // fails toward recording nothing.
  // ═══════════════════════════════════════════════════════════════════════
  const firstLadderRead = !probeAnswered || !laddered;
  const redefinition = ladder.ok && firstLadderRead && priorMilestone.hasRecord;

  // A first sighting is recorded as a BASELINE, never as an arrival — we cannot know
  // how long the loan had already been sitting there, and dating it from today would
  // make the whole back book look freshly moved. Best-effort: never undoes the
  // mirror above.
  const milestoneWrite = redefinition
    ? { ok: true, action: 'none', reason: 'redefinition' }
    : await milestones.writeMilestone(
      loanId, priorMilestone, { milestoneName, stageKey },
    );

  // The ladder itself — every step with done/date/associate — mirrored beside the
  // loan and stamping `ladder_synced_at` (which is what drains this loan out of
  // the backfill). Best-effort: an unrecordable ladder must not undo the mirror.
  let ladderWrite = null;
  if (ladder.ok) ladderWrite = await ladderMod.writeLadder(loanId, ladder.rows);

  const team = await contacts.syncLoanContacts(loanId, guid, { values });

  // THE SUBJECT PROPERTY RIDES THE PAYLOAD WE ALREADY HAVE. db/549 shipped
  // `lt_properties` and the file's Property section, the summary rail and the
  // pipeline's own address and LTV columns all READ it — while nothing wrote it,
  // so all three answered blank on every loan from the day they shipped. It costs
  // no call: the figures are on the loan JSON in hand, and any value this caller
  // already read BY NUMBER wins over the path. Best-effort — a property we could
  // not read must never undo the loan we just mirrored.
  let property = null;
  try {
    property = await application.syncSubjectProperty(loanId, loan, { values });
  } catch (e) {
    property = { ok: false, reason: (e && e.message) || String(e) };
  }

  // The people on the file ride the same payload, for the same reason and at the
  // same cost. `lt_borrower_pairs` and `lt_parties` are what the file's Borrowers
  // section reads and what its residences, employments, incomes, assets,
  // liabilities and declarations all hang off — so nothing else in the 1003 can
  // fill until these do. The SSN itself is never written; see application/sync.js.
  // The loan's OWN terms — its amortization, its interest-only period, its
  // prepayment penalty, the whole PITIA block and the DSCR. Twenty-seven columns
  // db/549 carries, all of them read by the file's Terms section and the summary
  // rail, none of them ever written. Same payload, same pass, no extra call.
  let terms = null;
  try {
    terms = await application.syncLoanTerms(loanId, loan, { values });
  } catch (e) {
    terms = { ok: false, reason: (e && e.message) || String(e) };
  }

  let pairs = null;
  try {
    pairs = await application.syncBorrowerPairs(loanId, loan);
  } catch (e) {
    pairs = { ok: false, reason: (e && e.message) || String(e) };
  }

  // WHO BOUGHT IT. db/549 built the investor identity chain the owner said must
  // "survive like crazy" — the shorthand name, the accurate name, their OWN loan
  // number, their email domain and the funding channel — and nothing has ever
  // written a row into it. Every condition in this tenant sits on a loan that is
  // already sold, so "who is this with?" is a question staff ask on almost every
  // file. Same payload, same pass, no extra call. STAFF-ONLY: nothing here goes
  // near a client surface.
  let investor = null;
  try {
    investor = await application.syncLoanInvestor(loanId, loan, { values });
  } catch (e) {
    investor = { ok: false, reason: (e && e.message) || String(e) };
  }

  // The lock posture rides the loan we already have — no lock endpoint is called,
  // and none would answer: every lock-specific endpoint on this tenant is 403.
  const lock = locks.lockFromLoan(loan, values, settings);
  const lockWrite = await locks.writeLock(loanId, lock);

  // ═══════════════════════════════════════════════════════════════════════
  // ONLY NOW IS THE READ STAMPED, AND ONLY NOW MAY THE ERROR BE CLEARED.
  //
  // It used to be stamped in the UPDATE above — a hundred lines and five writes
  // BEFORE the property, the terms, the borrowers and the investor were even
  // attempted. Each of those four is wrapped in its own try/catch and each hands
  // back `{ok:false, reason}` on a miss, and every one of those reasons went into
  // this function's return value, which `syncOnce` throws away. So the row said
  // "read just now, no error" while the address, the rate and the DSCR stayed
  // blank, the twelve-hour rota came back, failed identically, and re-stamped it.
  //
  // That is the owner's report of 2026-08-25, exactly: *"This is how this file was:
  // it was empty for 20 hours. Only when I went into the section of Encompass
  // syncing and I clicked sync to the file for that particular file did it pull
  // information... Why didn't it go by itself?"* It DID go by itself. It went by
  // itself twice, said it had succeeded both times, and wrote nothing.
  //
  // A stamp that is written before the work is a stamp that cannot report the
  // work. The module header has claimed since it was written that "a failure is
  // recorded on the loan, not swallowed" — that was true of the one `getLoan`
  // throw at the top and false of everything below it. This makes the header true.
  //
  // WHY IT STILL STAMPS ON A PARTIAL READ. Not stamping would make `needsRead`
  // answer yes on every tick for ever, and a loan that cannot be filled would then
  // be re-read every pass — a hot loop against a call budget shared with every
  // other integration on this tenant. So the stamp is written either way and the
  // MISS is recorded beside it, which is what `needsRead` reads to bring a partly
  // read loan back in an hour instead of twelve.
  const { misses, empties, filledAny } = classifyParts([
    { what: 'subject property', result: property },
    { what: 'loan terms', result: terms },
    { what: 'borrowers', result: pairs },
    { what: 'investor', result: investor },
  ]);
  // AN EMPTY ANSWER IS NOT AN ANSWER. `fieldReader` can hand back `{}` — truthy,
  // so a `values === null` test alone sails straight past the case where the batch
  // connected and returned nothing, which is the shape a single unreadable field id
  // produces for the whole batch.
  const gotValues = values !== null && typeof values === 'object' && Object.keys(values).length > 0;
  if (!gotValues && ids.length) {
    misses.push(`${ids.length} field(s) asked for by number: the batch read ${values === null ? 'did not answer' : 'came back empty'}`);
  }
  if (!ladder.ok) misses.push(`milestone ladder: ${ladder.reason || 'could not be read'}`);

  // THE ORIGINAL DEFECT, KEPT: a read that ANSWERED and filled nothing at all.
  // One empty part among four is an early or withdrawn file and alarms nobody;
  // all four empty, on a batch that did answer, is the shape the owner reported
  // as "read but empty" and it is still surfaced. `empties` carries the reasons
  // so the sentence says which parts, not merely that there were some.
  if (!misses.length && gotValues && !filledAny && empties.length) {
    misses.push(`the read answered but filled nothing — ${empties.join('; ')}`);
  }

  // The reason column is 500 characters (see the `getLoan` catch above), so the
  // sentence is built to fit rather than trusted to.
  const readError = misses.length
    ? `${PARTIAL_READ_PREFIX} ${misses.length} part(s) came back empty — ${misses.join('; ')}`.slice(0, 500)
    : null;

  await lazy.db.query(
    `UPDATE lt_loans
        SET encompass_synced_at = now(),
            encompass_sync_error = $2,
            updated_at = now()
      WHERE id = $1::uuid`,
    [loanId, readError],
  );

  return { ok: true, partial: misses.length > 0, misses,
    milestoneName, stageKey, team, milestone: milestoneWrite, sale,
    ladder: ladder.ok ? { steps: ladder.rows.length, sitting: ladder.sitting, ...(ladderWrite || {}) } : { ok: false, reason: ladder.reason },
    msStatus: ms.status,
    lock: { ...lockWrite, posture: lock.posture }, property, terms, pairs, investor };
}

/**
 * One pass: discover everything, mirror it, then fully read the loans that moved —
 * up to a budget, so a pass is bounded no matter how much changed.
 *
 * Never throws for an ordinary failure; returns `{ok:false, reason}` so a screen can
 * say what happened.
 */
async function syncOnce({ readBudget = DEFAULT_READ_BUDGET, loanFolder = null } = {}) {
  // Say WHICH of the two states this is: "the credentials are missing" is useless
  // advice on a tenant whose credentials are sitting right there and were switched
  // off on purpose.
  if (!killSwitch.encompassEnabled()) return { ok: false, reason: killSwitch.OFF_REASON };
  if (!lazy.client.configured()) {
    return { ok: false, reason: 'Encompass is not connected yet — add the long-term Encompass credentials first.' };
  }

  const { settings } = await lazy.settings.load();

  let found;
  try {
    found = await discover.discoverLoans({ loanFolder });
  } catch (e) {
    return { ok: false, reason: `Could not read the Encompass pipeline: ${(e && e.message) || e}` };
  }
  if (!found.loans.length) {
    // Nothing is deleted or deactivated on an empty read — an empty pipeline is far
    // more likely an outage or a filter change than seven hundred loans vanishing.
    return { ok: true, discovered: 0, read: 0, failed: 0, truncated: found.truncated, note: 'The pipeline returned no loans, so nothing was changed.' };
  }

  // WHICH RECORDS ARE ARCHIVED INSIDE ENCOMPASS (owner-reported 2026-08-23,
  // YSCAP258134474: "I only see one copy in Encompass … Get rid of the other
  // one"). Discovery runs WITH `includeArchivedLoans` because a withdrawn file
  // needs it — and that flag also returns records Encompass has ARCHIVED, which
  // its own pipeline view hides. A stale archived copy of a live loan then shows
  // in PILOT with numbers the owner cannot even find in Encompass. The tell is a
  // DIFF: a second, flag-less search — a record present only WITH the flag is
  // archived. FAIL CLOSED: if the flag-less sweep errors, truncates, or comes
  // back implausibly empty while the main sweep found loans, NOTHING is marked
  // this pass — a hiccup here must never retire a live loan.
  let visibleGuids = null;
  try {
    const plain = await discover.discoverLoans({ loanFolder, includeArchived: false });
    if (!plain.truncated && plain.loans.length) {
      visibleGuids = new Set(plain.loans.map((l) => l.encompassLoanGuid).filter(Boolean));
    }
  } catch (_) { /* fail closed — the flags keep last pass's answer */ }

  const dbc = await lazy.db.getClient();
  // ONLY OUR OWN LOANS COME IN (owner-directed 2026-08-23: *"make sure it's only
  // gonna pull according to our rule: only long-term files"*).
  //
  // Discovery reads the WHOLE Encompass book because no folder separates the two
  // products at the source — 772 loans, 251 of them fix-and-flip. Every one of those
  // used to be written into `lt_loans` and then READ, one Encompass call each, to
  // establish something the discovery row could already have told us.
  //
  // THE RULE IS `product-term.js`, AND IT IS NOT RE-STATED HERE. It is the same one
  // definition the census, the pipeline stamp and the SQL twin all use, so "is this
  // ours?" has exactly one answer in this codebase.
  //
  // ONLY A PROVABLE SHORT-TERM LOAN IS SKIPPED. `boundary` (exactly 36 months) and
  // `unknown` (no program and no term) are MIRRORED: refusing to bring in a loan we
  // cannot place would make files disappear with nothing anywhere saying so, which is
  // the confident-wrong-answer this side keeps finding. They are counted and reported
  // instead, and the census lists them for a human to settle.
  //
  // AND WHEN WE COULD NOT ASK, WE DO NOT JUDGE. If Encompass refused the two
  // classifying fields, every loan reads as unclassifiable and NOTHING is skipped —
  // the pass behaves exactly as it did before this rule existed, and says so.
  const mirrorShortTerm = settings['sync.mirrorShortTerm'] === true;
  const canClassify = found.classifyFields !== 'refused';
  let skippedShortTerm = 0;

  const due = [];
  // ENCOMPASS'S TRASH GOES TO THE ARCHIVE, NEVER THE BOOK (owner-directed
  // 2026-08-23: "real trash … should not be part of the pipeline at all"). The
  // pipeline search returns the `(Trash)` folder because `includeArchivedLoans` —
  // which a WITHDRAWN file genuinely needs — brings the recycle bin along with the
  // archives. The rule here is UPDATE-ONLY: a loan we already hold that somebody
  // deletes in Encompass gets its folder moved (which retires it into the archive
  // on this very pass), and a loan that was ALREADY trash when first seen is never
  // inserted — so a permanently deleted archive row stays deleted, and a loan
  // RESTORED from Encompass's trash comes straight back as an ordinary discovery.
  // Counted, never silent.
  let archivedTrash = 0;
  // Superseded archived copies: marked into the archive, and never re-inserted
  // after a permanent delete. Counted like the trash.
  let archivedDupSkipped = 0;
  let archivedDuplicates = 0;
  // ONE LOAN THAT WILL NOT SAVE MUST NOT DISCARD THE BOOK (owner-reported
  // 2026-08-23, and the run log is what finally named it: *"The last pull did not
  // work — Could not save the discovered loans: duplicate key value violates unique
  // constraint lt_loans_loan_number_key"*).
  //
  // The whole discovered book was mirrored inside ONE transaction with the loop
  // BARE inside it, so the first row Postgres refused aborted the transaction and
  // the catch rolled back every loan in the pass. Two Encompass loans sharing one
  // human loan number — an ordinary state of that system, see db/617 — therefore
  // emptied the entire pipeline, on every pass, with the count of loans actually at
  // fault being ONE. THE CLASS: a per-row failure inside a batch transaction is a
  // total failure unless something scopes it to its own row.
  //
  // A SAVEPOINT per loan is what scopes it — the same shape `finding-decisions.js`
  // uses. Postgres puts a transaction into a failed state on ANY error and refuses
  // every later statement until it is rewound, so releasing the savepoint on success
  // and rolling back TO it on failure is not decoration: without it the next loan's
  // insert fails with `current transaction is aborted` and the whole book still goes.
  //
  // The batch stays ONE transaction on purpose. Discovery is a mirror of a moment,
  // and committing per row would let a pass that dies half way leave a book that is
  // part yesterday and part today, with nothing saying which rows are which.
  //
  // NOTHING IS SILENTLY DROPPED. A refused loan is counted, its loan number and
  // Encompass id are kept, and the pass REPORTS them — a mirror that quietly skips
  // a real loan is the confident wrong answer this side keeps finding.
  const refused = [];
  try {
    await dbc.query('BEGIN');
    for (const loan of found.loans) {
      if (!mirrorShortTerm && canClassify) {
        const verdict = productTerm.classifyProduct({
          programName: loan.programName,
          termMonths: loan.termMonths,
        });
        if (verdict.product === productTerm.PRODUCT.SHORT) { skippedShortTerm += 1; continue; }
      }
      await dbc.query('SAVEPOINT lt_loan_row');
      try {
        if (trash.isTrashFolder(loan.loanFolder)) {
          await dbc.query(
            `UPDATE lt_loans
                SET loan_folder = $2,
                    encompass_last_modified = GREATEST(
                      COALESCE($3::timestamptz, encompass_last_modified),
                      COALESCE(encompass_last_modified, $3::timestamptz)),
                    updated_at = now()
              WHERE encompass_loan_guid = $1`,
            [loan.encompassLoanGuid, loan.loanFolder, loan.lastModified],
          );
          archivedTrash += 1;
          await dbc.query('RELEASE SAVEPOINT lt_loan_row');
          continue; // never scheduled for a full read — nobody spends a call on trash
        }
        // AN ARCHIVED RECORD SUPERSEDED BY A LIVE TWIN IS NEVER BROUGHT IN FRESH —
        // the same update-only rule the trash branch applies, for the same reason:
        // a permanently deleted archive row must stay deleted, not boomerang back
        // on the next sweep (the record still exists inside Encompass, archived).
        // A record we already hold falls through to the ordinary upsert; the
        // marking sweep below is what retires it.
        if (visibleGuids && !visibleGuids.has(loan.encompassLoanGuid) && loan.loanNumber) {
          const { rows: held } = await dbc.query(
            'SELECT 1 FROM lt_loans WHERE encompass_loan_guid = $1', [loan.encompassLoanGuid]);
          if (!held.length) {
            const { rows: twin } = await dbc.query(
              `SELECT 1 FROM lt_loans t
                WHERE t.loan_number = $1 AND t.encompass_archived = false
                  AND ${book.folderNormSql('t')} <> '(trash)'
                LIMIT 1`, [loan.loanNumber]);
            if (twin.length) {
              archivedDupSkipped += 1;
              await dbc.query('RELEASE SAVEPOINT lt_loan_row');
              continue;
            }
          }
        }
        const row = await upsertDiscovered(dbc, loan, settings);
        await dbc.query('RELEASE SAVEPOINT lt_loan_row');
        if (needsRead(row, Date.now(), settings)) {
          // The loan's own last-read stamp rides along so the slice below can drain
          // OLDEST FIRST — see the sort there for why that is not cosmetic.
          due.push({ id: row.id, guid: loan.encompassLoanGuid, syncedAt: row.encompass_synced_at });
        }
      } catch (rowErr) {
        // Rewind only this row. If the rewind ITSELF fails the transaction is
        // unusable, so rethrow and let the outer catch report honestly rather than
        // loop on a connection that will refuse everything from here on.
        await dbc.query('ROLLBACK TO SAVEPOINT lt_loan_row');
        await dbc.query('RELEASE SAVEPOINT lt_loan_row');
        refused.push({
          loanNumber: loan.loanNumber || null,
          encompassLoanGuid: loan.encompassLoanGuid || null,
          reason: (rowErr && rowErr.message) || String(rowErr),
        });
      }
    }

    // THE ARCHIVED FLAGS, refreshed from the diff — only for the loans THIS pass
    // discovered, and only when the flag-less sweep genuinely answered. Then the
    // retirement: an archived record whose loan number a live record also carries
    // is `archived_duplicate`, which `trash.trashSql` reads as the archive — it
    // leaves every pipeline read and shows on the archive screen instead. SELF-
    // HEALING both ways: un-archive the record in Encompass (or lose the live
    // twin) and the next pass clears the mark, bringing it straight back.
    if (visibleGuids) {
      const discoveredGuids = found.loans.map((l) => l.encompassLoanGuid).filter(Boolean);
      const archivedNow = discoveredGuids.filter((g) => !visibleGuids.has(g));
      const liveNow = discoveredGuids.filter((g) => visibleGuids.has(g));
      await dbc.query(
        `UPDATE lt_loans SET encompass_archived = true, updated_at = now()
          WHERE encompass_loan_guid = ANY($1::text[]) AND encompass_archived = false`, [archivedNow]);
      await dbc.query(
        `UPDATE lt_loans SET encompass_archived = false, updated_at = now()
          WHERE encompass_loan_guid = ANY($1::text[]) AND encompass_archived = true`, [liveNow]);
    }
    // The marking runs every pass off the STORED flags (idempotent), so a pass
    // whose flag-less sweep failed still converges on last pass's facts. ONE
    // definition — trash.js owns what "superseded archived copy" means.
    const swept = await trash.sweepArchivedDuplicates(dbc);
    archivedDuplicates = swept.marked;

    await dbc.query('COMMIT');
  } catch (e) {
    try { await dbc.query('ROLLBACK'); } catch (_) { /* the original error is the one that matters */ }
    return { ok: false, reason: `Could not save the discovered loans: ${(e && e.message) || e}` };
  } finally {
    dbc.release();
  }

  // The full reads run OUTSIDE the transaction, one at a time: each is a network
  // call, and holding a transaction open across dozens of them would pin a
  // connection for minutes and roll back every loan because one failed.
  let read = 0;
  let failed = 0;
  // A read that finished but filled nothing. Counted apart from `read` and `failed`
  // because it is neither: the loan WAS read, and the file is still empty.
  let partial = 0;
  // DRAIN THE LONGEST-UNREAD FIRST. Discovery hands these over sorted by Encompass's
  // own LastModified DESCENDING, so without this the same busy handful of loans would
  // take all 25 slots on every pass and a quiet loan on the re-read rota would never
  // reach the front — the rota would exist and starve. Never-read loans (no stamp)
  // lead, because a file nobody has ever read is the emptiest thing on the screen.
  const drain = due.slice().sort((a, b) => {
    const ta = a.syncedAt ? new Date(a.syncedAt).getTime() : -Infinity;
    const tb = b.syncedAt ? new Date(b.syncedAt).getTime() : -Infinity;
    const na = Number.isFinite(ta) ? ta : -Infinity;
    const nb = Number.isFinite(tb) ? tb : -Infinity;
    return na - nb;
  });
  // ONE LOAN THAT THROWS MUST NOT STARVE THE ONES BEHIND IT (2026-08-25).
  //
  // `readLoan` guards its own `getLoan`, but everything after that — the main
  // UPDATE, the field batch, the contacts sync, the lock write — can throw, and
  // this loop had no catch. A throw walked out through `drainLoans` and ended the
  // whole pass. Combined with the sort directly above, which puts NEVER-READ loans
  // first so the emptiest files are served soonest, that turned one bad loan into a
  // total outage: it was read first on every pass, threw, and every loan behind it
  // was never reached. Nobody would see why, because the throw was the pass ending
  // rather than anything recorded against a loan.
  //
  // That is not hypothetical. It is exactly what the vesting-module collision did
  // last week — `vesting.FIELD_IDS` came back undefined, the spread threw, and the
  // Long-Term book stopped filling in silently. That particular throw is fixed; this
  // is the shape of it, closed, so the next one costs one loan instead of the book.
  let starved = 0;
  const starvedLoans = [];
  for (const item of drain.slice(0, readBudget)) {
    let out;
    try {
      out = await readLoan(item.id, item.guid, settings);
    } catch (e) {
      const reason = String((e && e.message) || e).slice(0, 500);
      starved += 1;
      if (starvedLoans.length < 10) starvedLoans.push({ id: item.id, reason });
      // Record it ON THE LOAN, which is the module's own stated contract, and stamp
      // it so the rota does not pin this loan to the front of the queue for ever.
      try {
        await lazy.db.query(
          `UPDATE lt_loans
              SET encompass_sync_error = $2, encompass_synced_at = now(), updated_at = now()
            WHERE id = $1::uuid`,
          [item.id, `The read threw before it finished: ${reason}`],
        );
      } catch (_) { /* the row is unreachable; the count below still reports it */ }
      failed += 1;
      continue;
    }
    if (out.ok) read += 1; else failed += 1;
    if (out.partial) partial += 1;
  }

  // A borrower link a human confirmed YESTERDAY has to reach a loan that arrived
  // TODAY. The decision is recorded against the email address, and a freshly
  // mirrored loan carries that address with no `borrower_id` — so without this the
  // borrower would have to be re-confirmed for every new loan, forever, and nobody
  // would. Best-effort by construction: it never throws and it can never undo the
  // mirror above, so a failure costs one pass, not the sync.
  const links = await require('../borrower-links').applyConfirmedLinks();

  // THE OFFICER MAP REFRESHES WITH THE LOANS (owner-directed 2026-08-17: "make sure
  // officer mapping is on"). The loans that just arrived name Encompass logins, and
  // a login nobody has proposed a match for is an officer with no PILOT profile —
  // so their file shows a name we cannot connect to a person, and, because officer
  // scope is `own`, it reaches nobody's pipeline. Refreshing the roster on the same
  // pass is what stops the two drifting: the proposals are always about the logins
  // the book actually carries, rather than whenever somebody last pressed a button
  // on the people screen.
  //
  // IT PROPOSES AND NEVER DECIDES — unchanged. `syncRoster` writes `suggested` rows
  // only; a `confirmed` or `rejected` row is never re-litigated (people/links.js).
  // Automating the CONFIRM is the one thing that must not happen here: a wrong link
  // hands somebody another officer's book with nothing on screen to say so.
  //
  // Best-effort, exactly like the borrower links above: the loan mirror is the job,
  // and a people failure may not cost it.
  // `syncRoster` reports an ordinary failure by RETURNING `{ok:false, reason}` rather
  // than throwing (no credentials, an empty roster it refuses to write), so both
  // shapes are read — treating an `ok:false` as a caught error would report a
  // confident "0 officers proposed" on a pass that never ran.
  let officers = { proposed: 0, waiting: 0, reason: null };
  try {
    const r = await require('../people/roster').syncRoster();
    if (r && r.ok) officers = { proposed: r.proposedNow || 0, waiting: r.unmatched || 0, reason: null };
    else officers = { proposed: 0, waiting: 0, reason: (r && r.reason) || 'the people map did not run' };
  } catch (e) {
    officers = { proposed: 0, waiting: 0, reason: (e && e.message) || String(e) };
  }
  if (officers.reason) console.error('[lt] officer roster refresh:', officers.reason);

  return {
    ok: true,
    discovered: found.loans.length,
    due: due.length,
    read,
    failed,
    // A READ THAT FILLED NOTHING IS NOT A SUCCESSFUL READ. These two are the whole
    // point of the change: `partial` counts loans Encompass answered for but whose
    // property, terms, borrowers or investor came back empty, and `starved` counts
    // loans whose read threw outright. Both used to be invisible — the first was
    // counted as a success, the second ended the pass — and between them they are
    // why a file could sit empty for twenty hours with every screen insisting it had
    // just been read. They ride the run log, so "why is this file blank?" has an
    // answer without anyone reading a server log.
    partial,
    starved,
    starvedLoans,
    borrowersLinked: links.linked || 0,
    // What a human still has to do: `officersProposed` are new matches waiting for a
    // confirm, `officersUnmatched` are logins the machine could not match at all.
    officersProposed: officers.proposed,
    officersUnmatched: officers.waiting,
    officerSyncReason: officers.reason,
    remaining: Math.max(0, due.length - readBudget),
    truncated: found.truncated,
    // NO SILENT FILTERING. How many of Encompass's loans were left where they belong,
    // and — when the classifying fields were refused — that none could be.
    skippedShortTerm,
    // Deleted-in-Encompass loans seen this pass: existing rows retired into the
    // archive, brand-new trash never brought in. Reported, never silent.
    archivedTrash,
    // Superseded archived copies: newly retired this pass, and fresh ones never
    // brought back after a permanent delete.
    archivedDuplicates,
    archivedDupSkipped,
    classifyFields: found.classifyFields || 'answered',
    // NO SILENT CAPS. Loans Postgres refused, named so a human can go and look at
    // them in Encompass; `refusedLoans` carries the first few with their reason.
    refused: refused.length,
    refusedLoans: refused.slice(0, 10),
  };
}

module.exports = {
  PARTIAL_READ_PREFIX,
  classifyParts,
  DEFAULT_READ_BUDGET,
  stageFor,
  sameMilestone,
  needsRead,
  upsertDiscovered,
  readLoan,
  syncOnce,
};
