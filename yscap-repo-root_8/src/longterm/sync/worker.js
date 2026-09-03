'use strict';
/**
 * LONG-TERM — the pass that runs on its own.
 *
 * WHY THIS EXISTS. Everything the long-term side mirrors — the loans, their
 * stage, their team, their lock, the whole 1003, the Condition Center — filled
 * ONLY when a human opened the Sync screen and pressed a button. A loan somebody
 * changed in Encompass overnight stayed stale until a person happened to notice,
 * which is the same "built but never triggered" failure as a mirror with no
 * writer, one level up: every writer existed and nothing ever called them.
 *
 * ⛔ THIS PARAGRAPH SAID "OFF BY DEFAULT, and it says so" AND WAS FALSE FROM
 * 2026-08-23, when the default flipped — see the owner-directed note further down
 * this same file, and `enabled()` below, which returns TRUE when the variable is
 * unset. Two other files quoted this sentence as their authority and were corrected
 * on 2026-09-03; the file that owns the default kept it a day longer, which is the
 * more dangerous half: a reader who checks the source of a claim found the claim
 * repeated.
 *
 * ON BY DEFAULT. `LT_SYNC_ENABLED=0` turns it off — the reverse of
 * `ENCOMPASS_ENABLED` and `CLICKUP_OUTBOUND_ENABLED`, which still gate their own
 * workers the ordinary way, so do not read across from them. With the switch off
 * this module schedules nothing, reads nothing and costs nothing; with it ON but no
 * Encompass credentials, a pass costs one refused call (see below).
 *
 * IT IS BOUNDED BY THE PASSES IT CALLS, NOT BY A LIMIT OF ITS OWN. `loans.syncOnce`
 * reads at most its own budget of loans per pass and `conditions.syncOnce` its
 * own; both report whether there is more to do. That matters on a tenant whose API
 * budget is shared with every other integration and capped at 30 concurrent calls
 * — a worker with its own idea of "how much" would be a second place for that to
 * be got wrong.
 *
 * NOTHING IT DOES CAN THROW INTO THE EVENT LOOP. Every tick is wrapped: an
 * unhandled rejection inside a timer takes the whole process down, and a sync that
 * kills the server is worse than a sync that misses an hour.
 *
 * ENCOMPASS STAYS ONE-WAY. Every call this schedules is a read.
 */

const loans = require('./loans');
const conditions = require('../conditions/sync');
const conditionRules = require('../conditions-center/sweep');
const milestoneCatalog = require('./milestone-catalog');
const milestoneLadder = require('./milestone-ladder');
const landlordMemory = require('../landlord-memory');
const contacts = require('../people/contacts');
const clickupLink = require('../clickup/link');
const clickupPush = require('../clickup/push');
const clickupSubmittal = require('../clickup/submittal');
const borrowerAutolink = require('../borrower-autolink');
const vorDesk = require('../vor/desk');
const priceSnapshot = require('../pricing/daily-pass');
const runLog = require('./run-log');

/**
 * Minutes between passes.
 *
 * WAS 20, on the reasoning that the tenant's own pacing makes a tighter loop
 * pointless. That reasoning was about the COST of a pass and it is still true; what
 * it missed is the WAIT, which is what an office actually feels. Owner-directed
 * 2026-08-23: *"we need to make PILOT refresh themselves more often from Encompass,
 * so everything should go simultaneously."*
 *
 * Twenty minutes is also what turned a simple question into an hour of digging: an
 * officer withdrew files in Encompass, PILOT still showed them working, and there
 * was no way to tell "not fetched yet" from "not saved" — because a book last swept
 * twenty minutes ago looks exactly like a book that missed the change.
 *
 * Five keeps a pass cheap — `needsRead` is answered from the database, so a caught-up
 * book costs one discovery call and stops — while putting the worst-case wait inside
 * the time it takes someone to switch windows and look.
 */
const POLL_MIN = (() => {
  const raw = Number(process.env.LT_SYNC_POLL_MIN);
  return Number.isFinite(raw) && raw >= 1 ? Math.trunc(raw) : 5;
})();

/** How long after boot the first pass runs — long enough for migrations to finish. */
const FIRST_RUN_MS = (() => {
  const raw = Number(process.env.LT_SYNC_FIRST_RUN_SEC);
  return (Number.isFinite(raw) && raw >= 0 ? Math.trunc(raw) : 90) * 1000;
})();

/**
 * ON BY DEFAULT since 2026-08-23, owner-directed: *"Set up the pullback and set
 * everything on, and she will automatically pull old files and also future files."*
 *
 * It shipped OFF because a worker nobody asked for should cost nothing. The owner has
 * now asked for it, so the default flips and `LT_SYNC_ENABLED=0` is the way to stop
 * it. Turning it on is deliberately NOT the same as making it do something: with no
 * Encompass credentials `loans.syncOnce` returns "Encompass is not connected yet" and
 * the pass costs one refused call, so a deployment that has never configured
 * long-term Encompass is unaffected by this change.
 */
const enabled = () => {
  const raw = String(process.env.LT_SYNC_ENABLED == null ? '' : process.env.LT_SYNC_ENABLED).trim();
  if (!raw) return true;
  return !/^(0|false|no|off)$/i.test(raw);
};

/**
 * THE BACKFILL. How long one tick may keep pulling history, in seconds.
 *
 * `loans.syncOnce` reads at most its own budget (25) per call and reports how many
 * are still due, so a book of 772 files needs about 31 calls. At one call per
 * 20-minute tick that is ten hours before an officer can see their own closed
 * files — which is not "pull everything backwards" in any useful sense.
 *
 * So a tick keeps calling while there is more to do, until either the book is caught
 * up or this budget is spent. It is a WALL-CLOCK bound rather than a pass count
 * because what has to be protected is the gap before the next tick, and a pass takes
 * as long as the tenant's pacing makes it take. Default 10 minutes, comfortably
 * inside the poll gap so a drain can never still be running when the next tick lands
 * (and `running` would skip it anyway). IT MOVES WITH THE POLL: when the gap dropped
 * from 20 minutes to 5 this had to come down from 10 minutes to 4 or every other tick
 * would arrive mid-drain and be skipped — a faster schedule that silently syncs no
 * more often than the old one. The invariant, not the number, is the point, and
 * `test-lt-sync-worker-pure` asserts it so the pair cannot drift apart again.
 *
 * ONCE THE HISTORY IS IN, THIS COSTS NOTHING. `needsRead` is answered from the
 * database — a loan is due only if it has never been read or Encompass has touched
 * it since — so a caught-up book drains in one pass that finds nothing and stops.
 */
const DRAIN_SEC = (() => {
  const raw = Number(process.env.LT_SYNC_DRAIN_SEC);
  return Number.isFinite(raw) && raw >= 0 ? Math.trunc(raw) : 240;
})();

/**
 * A hard ceiling on passes per tick, so a bug that always reports "more to do" burns
 * a bounded number of calls rather than every call the tenant has. It is the backstop
 * and not the control: the wall clock above is what normally ends a drain.
 */
const MAX_PASSES = (() => {
  const raw = Number(process.env.LT_SYNC_MAX_PASSES);
  return Number.isFinite(raw) && raw >= 1 ? Math.trunc(raw) : 60;
})();

/**
 * Drain the loan backlog: pass after pass until the book is caught up or the budget
 * is spent.
 *
 * Returns the LAST pass's shape with the totals accumulated across the drain, so a
 * caller (and the log line) sees one answer rather than a list. `passes` and
 * `caughtUp` are what say whether the history is in yet.
 */
async function drainLoans(now) {
  const deadline = now() + DRAIN_SEC * 1000;
  let last = null;
  let passes = 0;
  let read = 0;
  let failed = 0;
  for (;;) {
    /* eslint-disable no-await-in-loop */ // deliberately serial: see the pacing note above
    last = await loans.syncOnce({});
    passes += 1;
    if (!last || last.ok === false) break;          // a refusal ends the drain, not the tick
    read += last.read || 0;
    failed += last.failed || 0;
    // Caught up is the ordinary exit, and it is the one that matters: it is what
    // turns this back into a cheap incremental sync once the history is in.
    if (!last.remaining) break;
    if (passes >= MAX_PASSES) break;
    if (now() >= deadline) break;
  }
  if (!last || last.ok === false) return { ...(last || {}), passes };
  return { ...last, read, failed, passes, caughtUp: !last.remaining };
}

// A pass never overlaps itself. A tick that lands while the previous one is still
// reading would double this worker's share of a shared API budget, and on a slow
// tenant it would keep doing so — so a busy pass is SKIPPED rather than queued.
let running = false;
let started = false;

/**
 * One pass: the loans, then the Condition Center.
 *
 * Both halves are best-effort and independent. The condition sweep refuses
 * politely while `conditions.enabled` is off, so this is safe on a deployment
 * that has not turned that on; and a loan pass that fails must not stop the
 * conditions, because the two read different things and fail for different
 * reasons.
 */
async function tickOnce({ trigger = 'worker' } = {}) {
  if (running) return { ok: false, reason: 'a pass is already running' };
  running = true;
  const started_at = Date.now();
  const out = { loans: null, conditions: null, milestoneCatalog: null, milestoneLadders: null, pilotRoles: null, clickupLink: null, borrowerLinks: null, vorEnvelopes: null };
  try {
    // EVERY PASS RECORDS WHAT IT DID (db/616). The log line below says the same
    // thing, and a log line is not an answer: the owner asked twice why nothing was
    // arriving and nobody could tell them, because a refusal or an outage leaves NO
    // loan row and the Sync screen is built entirely out of loan rows. `runLog.record`
    // writes the verdict — including the reason — somewhere a screen can read it.
    // It can never change what a pass does: it re-throws whatever the pass threw, into
    // the same catch that was already there.
    try {
      out.loans = await runLog.record('loans', trigger, () => drainLoans(Date.now));
    } catch (e) {
      out.loans = { ok: false, reason: (e && e.message) || String(e) };
    }
    try {
      out.conditions = await runLog.record('conditions', trigger, () => conditions.syncOnce({}));
    } catch (e) {
      out.conditions = { ok: false, reason: (e && e.message) || String(e) };
    }
    // THE CONDITION RULES RUN BY THEMSELVES (owner-directed 2026-09-02: *"You
    // don't need to click this button; that populates automatically on all the
    // files and always re-checks if stuff and rules were updated"*). OUR OWN
    // rules engine over OUR OWN conditions — not the Encompass mirror above —
    // for every loan that is DUE: never evaluated, its mirror moved since, or
    // the library moved since. A bounded batch per tick, oldest attempt first;
    // a caught-up book costs one SELECT that finds nothing. Runs AFTER the loan
    // drain so a file read this tick is evaluated this tick, and LOCAL work, so
    // it runs whether or not Encompass is reachable. Its own off switch:
    // LT_CONDITION_RULES_ENABLED=0.
    try {
      out.conditionRules = await runLog.record('condition_rules', trigger, () => conditionRules.sweepOnce({}));
    } catch (e) {
      out.conditionRules = { ok: false, reason: (e && e.message) || String(e) };
    }
    // THE ORDERS FOLLOW THEIR CONDITIONS (owner-directed 2026-09-03). An order
    // whose condition is signed off is finished; one whose condition holds a
    // document has its documents in — whichever email chain they came back on.
    // The live doors (sign-off, waive, upload) do this at once; this pass is the
    // "previous AND future" half over the whole book, through the same module.
    try {
      out.orderConditions = await require('../orders/condition-sync').sweepOnce({});
    } catch (e) {
      out.orderConditions = { ok: false, reason: (e && e.message) || String(e) };
    }
    // The tenant's own milestone catalog. It skips itself unless a day has passed,
    // so this costs nothing on all but one pass — and when it does run it is what
    // stops a step a buyer added from blanking the progress bar on every file
    // sitting at it. Independent of the other two, like they are of each other.
    try {
      out.milestoneCatalog = await runLog.record('milestone_catalog', trigger, () => milestoneCatalog.refreshOnce({}));
    } catch (e) {
      out.milestoneCatalog = { ok: false, reason: (e && e.message) || String(e) };
    }
    // THE MILESTONE LADDERS for the already-mirrored book (db/623). The ordinary
    // loan read ladders every loan it touches, but it only touches a loan whose
    // Encompass stamp moved — so a finished file (precisely the ones whose
    // milestone read wrong, like Birch) would keep the lagging reading forever.
    // Drains on `ladder_synced_at IS NULL`, a bounded batch per tick, and
    // self-terminates: a laddered book costs one SELECT that finds nothing.
    try {
      out.milestoneLadders = await runLog.record('milestone_ladder', trigger, () => milestoneLadder.backfillLadders({}));
    } catch (e) {
      out.milestoneLadders = { ok: false, reason: (e && e.message) || String(e) };
    }
    /* THE LANDLORD ALREADY ON A FILE, remembered against the home that borrower
       rents, so their NEXT file fills it in by itself (owner-directed
       2026-08-31). The live path records a landlord the moment it is linked, so
       this exists only for the book that already has one — it drains on
       `lt_loan_vendors.remembered_at IS NULL` and a swept book costs one SELECT
       that finds nothing. */
    try {
      out.landlordMemory = await runLog.record('landlord_memory', trigger, () => landlordMemory.backfillOnce({}));
    } catch (e) {
      out.landlordMemory = { ok: false, reason: (e && e.message) || String(e) };
    }
    // THE STANDING REALIGN (owner-directed 2026-08-24): move every laddered
    // loan onto its LAST-COMPLETED milestone, from the mirror alone — no
    // Encompass call, no history event (a re-definition is not a move). One
    // cheap SELECT once aligned; also self-heals any future mirror/loan drift.
    // LOCAL work, so it runs whether or not Encompass is reachable.
    try {
      out.milestoneRealign = await runLog.record('milestone_realign', trigger, () => milestoneLadder.realignStanding({}));
    } catch (e) {
      out.milestoneRealign = { ok: false, reason: (e && e.message) || String(e) };
    }
    // THE ROLES ENCOMPASS HAS NOBODY FOR — today, who sets a file up. It cannot ride
    // the loan read, because a loan is only re-read when Encompass's own stamp moves
    // (`loans.needsRead`), so a caught-up book would never gain the assignment. It
    // costs NO Encompass call at all — it is one statement per role against our own
    // database, fill-only, and a caught-up book inserts nothing. Independent of the
    // three passes above, like they are of each other.
    try {
      out.pilotRoles = await runLog.record('pilot_roles', trigger, () => contacts.backfillPilotRoles({}));
    } catch (e) {
      out.pilotRoles = { ok: false, reason: (e && e.message) || String(e) };
    }
    // WHICH CLICKUP CARD IS EACH LOAN'S CARD — the tie the owner asked for, kept
    // from BOTH sides exactly like RTL keeps it: the loan row holds the card's id,
    // the card holds PILOT's file id in its Portal File Id field. One pass links
    // the reconciled book; every later pass links whatever new file gained a card
    // since — same code path, so "already stamped" and "stamp the new one" can
    // never drift apart. Runs AFTER the loan drain, so a file discovered this very
    // tick can link this very tick. Its own off switch (LT_CLICKUP_LINK_ENABLED=0),
    // and the ClickUp-side write stays behind stamp.js's separate switch.
    try {
      out.clickupLink = await runLog.record('clickup_link', trigger, () => clickupLink.linkPass({}));
    } catch (e) {
      out.clickupLink = { ok: false, reason: (e && e.message) || String(e) };
    }
    // THE OBVIOUS BORROWER MATCHES CONFIRM THEMSELVES (owner-directed 2026-08-23):
    // email matched one profile and the name is the same person spelled Encompass's
    // way. Everything short of that stays a suggestion for a human, and every
    // confirmation goes through the same door as the admin's button, so the guards
    // re-run and the trail says 'auto'. Its own switch: LT_BORROWER_AUTOLINK_ENABLED=0.
    try {
      out.borrowerLinks = await runLog.record('borrower_links', trigger, () => borrowerAutolink.autoLinkPass({}));
    } catch (e) {
      out.borrowerLinks = { ok: false, reason: (e && e.message) || String(e) };
    }
    /* THE VERIFICATION-OF-RENT ENVELOPES. The DocuSign Connect webhook is a NUDGE,
       not the correctness machinery: a delivery can be lost, dropped by a deploy
       mid-request, or refused while an HMAC key is rotated — and the failure is
       SILENT, so the landlord signs and the condition sits open with a form somebody
       believes is still out. This asks DocuSign about the envelopes still out, a
       bounded handful per pass. The DESK paces itself — one question per envelope
       per 15 minutes (DocuSign's polling policy), whatever POLL_MIN is — so calling
       it every tick is safe. It skips itself entirely when DocuSign is not
       configured, so it costs nothing on a deployment that does not use it. */
    try {
      out.vorEnvelopes = await runLog.record('vor_envelopes', trigger, () => vorDesk.reconcileOpenEnvelopes({}));
    } catch (e) {
      out.vorEnvelopes = { ok: false, reason: (e && e.message) || String(e) };
    }
    // THE FIELD WRITER (db/625, owner-directed 2026-08-23): a brand-new
    // Encompass file gets its card in the officer's folder, and a linked card
    // gets its fields refreshed whenever the mirror moved. Runs AFTER the link
    // pass so a card linked this tick pushes this tick, and a file the link
    // pass could not match is the one the create pass may card. OFF until the
    // owner flips LT_CLICKUP_WRITE_ENABLED (blank = off; DRYRUN logs the plan).
    /* ONE DAY'S PRICE SNAPSHOT (db/659). The reports the owner asked for —
       *"how much more expensive every single program is"* — have nothing to
       compare against unless somebody was recording, and a rate sheet is gone
       the moment it is replaced. So the collector ships before the reports and
       starts on day one. It costs ONE INDEXED SELECT on every tick that is not
       the day's first after 1 PM Eastern, and one vendor call on the tick that
       is — a single Lender Price search returns the whole book, so this is never
       a loop over programmes. Off with LT_PRICE_SNAPSHOT_ENABLED=0. */
    try {
      out.priceSnapshot = await runLog.record('price_snapshot', trigger, () => priceSnapshot.dailyPass({}));
    } catch (e) {
      out.priceSnapshot = { ok: false, reason: (e && e.message) || String(e) };
    }
    try {
      out.clickupCreate = await runLog.record('clickup_create', trigger, () => clickupPush.createPass({}));
    } catch (e) {
      out.clickupCreate = { ok: false, reason: (e && e.message) || String(e) };
    }
    try {
      out.clickupPush = await runLog.record('clickup_push', trigger, () => clickupPush.pushPass({}));
    } catch (e) {
      out.clickupPush = { ok: false, reason: (e && e.message) || String(e) };
    }
    // "PRIOR TO SUBMITTAL CONDITIONS → COMPLETED" ON THE CARD (db/673,
    // owner-directed 2026-09-02). The click pushes it on the spot; this is the
    // retry for a loan whose card was linked AFTER the click, or whose push met
    // an outage — declared complete and not yet on the card, oldest first.
    // Runs AFTER the link and push passes so a card linked this tick is told
    // this tick. Behind the writer's own switch; a caught-up book costs one SELECT.
    try {
      out.submittalPush = await runLog.record('submittal_clickup', trigger, () => clickupSubmittal.pushPass({}));
    } catch (e) {
      out.submittalPush = { ok: false, reason: (e && e.message) || String(e) };
    }
  } finally {
    running = false;
  }

  // Said out loud, every pass. A sync nobody can see the shape of is a sync
  // nobody notices has stopped working.
  const l = out.loans || {};
  const c = out.conditions || {};
  console.log('[lt-sync] pass in %ds — loans: %s; conditions: %s',
    Math.round((Date.now() - started_at) / 1000),
    l.ok === false ? `failed (${l.reason})`
      : `${l.read || 0} read of ${l.discovered || 0} in ${l.passes || 1} pass(es)`
        + `${l.failed ? `, ${l.failed} failed` : ''}`
        + `${l.caughtUp === false ? `, ${l.remaining} still to backfill` : ''}`,
    c.ok === false ? `skipped (${c.reason})` : `${c.read || 0} read of ${c.due || 0}${c.failed ? `, ${c.failed} failed` : ''}${c.more ? ', more to go' : ''}`);

  // Said separately, and ONLY when it did something or could not. A pass that filled
  // nothing on a caught-up book is the normal case and needs no line; a company whose
  // setup default names nobody must be able to find that out from the log.
  // The snapshot says something only on the day it takes one, or when it could
  // not — a line every five minutes saying "already taken today" is noise.
  const ps = out.priceSnapshot || {};
  if (ps.ok === false || Number(ps.stored) > 0) {
    console.log('[lt-sync] price snapshot: %s',
      ps.ok === false ? `failed — ${ps.reason}`
        : `${ps.stored} programme(s) recorded for ${ps.day}${ps.unusable ? `, ${ps.unusable} unreadable` : ''}`);
  }

  // The rules pass speaks only when it evaluated something or could not: a
  // caught-up book says nothing, every five minutes, on purpose.
  const cr = out.conditionRules || {};
  if (cr.ok === false || Number(cr.evaluated) > 0) {
    console.log('[lt-sync] condition rules: %s',
      cr.ok === false ? `skipped — ${cr.reason}`
        : `${cr.evaluated} loan(s) evaluated (${cr.added} condition(s) added, ${cr.removed} taken off`
          + `${cr.failed ? `, ${cr.failed} failed` : ''})${cr.more ? ', more to go' : ''}`);
  }

  const r = out.pilotRoles || {};
  if (r.filled || r.reason) {
    console.log('[lt-sync] file setup: %s%s',
      r.filled ? `${r.filled} file(s) assigned${r.more ? ', more to go' : ''}` : 'nothing assigned',
      r.reason ? ` — ${r.reason}` : '');
  }

  return out;
}

/**
 * Schedule it. Called once, by the long-term module's own entry point — this is
 * LT deciding its own background work rather than a second seam into RTL.
 */
function start() {
  if (started) return false;
  if (!enabled()) {
    console.log('[lt-sync] disabled (LT_SYNC_ENABLED is set to off — unset it to turn the sync back on)');
    return false;
  }
  started = true;
  // SAID AT BOOT, because this is the state somebody will be looking for in the log
  // when the book stops filling. The passes are still SCHEDULED — every one of them
  // refuses cheaply while the switch is off (no Encompass call, no token, nothing on
  // the wire) and picks straight back up the moment it is turned on, which is why
  // the worker is not torn down here.
  const enc = require('../encompass/enabled');
  if (!enc.encompassEnabled()) {
    console.log('[lt-sync] %s Passes will run and do nothing until it is turned back on.', enc.OFF_REASON);
  }
  console.log('[lt-sync] on — a pass every %d min, first in %ds', POLL_MIN, Math.round(FIRST_RUN_MS / 1000));

  const safeTick = () => { tickOnce().catch((e) => console.error('[lt-sync] pass failed:', (e && e.message) || e)); };

  // UNREF'D, AND THAT BECAME LOAD-BEARING THE DAY THIS WENT ON BY DEFAULT. A pending
  // timer keeps the Node event loop alive, so once `start()` actually schedules
  // something, ANY process that merely requires the long-term module stops being able
  // to exit — every `scripts/test-lt-*.js` hung, and the whole chain went from 32
  // seconds to a timeout. Found by running the suite, not by reading the diff.
  //
  // `unref` says "do not stay alive for me". A real server is held open by its HTTP
  // listener, so the passes still fire exactly as before; a test or a CLI that loads
  // the module and finishes can now finish.
  // ⛔ IF LONG-TERM EVER BECOMES ITS OWN RENDER SERVICE, IT NEEDS A REF'D
  // KEEPALIVE OF ITS OWN — the way `src/worker.js` has one. Both timers here are
  // deliberately `unref`'d, and since 2026-09-02 the long-term pool sets
  // `allowExitOnIdle` (see `src/longterm/db.js`), so a process whose ONLY
  // reason to stay alive was this worker would now exit within a second and
  // stop syncing silently. Today nothing is in that position: this runs inside
  // the API service, held open by its HTTP listener. Splitting it out is what
  // would change that.
  const first = setTimeout(safeTick, FIRST_RUN_MS);
  const every = setInterval(safeTick, POLL_MIN * 60 * 1000);
  if (typeof first.unref === 'function') first.unref();
  if (typeof every.unref === 'function') every.unref();
  return true;
}

/**
 * Is a pass in flight right now?
 *
 * Exported so the manual pull button can SAY "one is already running" rather than
 * answering "started" about a pass `tickOnce` is about to refuse — the refusal is a
 * return value, and the button fires it through `setImmediate` where nothing reads it.
 */
function isRunning() { return running; }

module.exports = { start, tickOnce, isRunning, _internals: { enabled, drainLoans, POLL_MIN, FIRST_RUN_MS, DRAIN_SEC, MAX_PASSES } };
