'use strict';
/**
 * WHAT ONE SEARCH SAW, RECORDED ONCE — FOR EVERY DOOR THAT SEARCHES.
 *
 * ── WHY THIS MODULE EXISTS (owner-reported 2026-09-03) ─────────────────────
 * The owner: *"You need to open up as well a separate agent to audit the settings.
 * Why the side by side doesn't work: it's not actually connected."* It was not.
 * Two registers are written after a general-engine search — the SIGHTINGS (which
 * rate sheet has produced which investor, which is the whole source of the
 * settings screen's "available on" column) and the MISSES (an investor the
 * settings point at LoanNEX which LoanNEX answered without carrying, which is what
 * emails the super admin). Both were written in ONE place: the DSCR-bands door.
 *
 * The immediate board — the first thing an officer sees, and on plenty of searches
 * the ONLY door that runs — computed both and threw them away. So a sheet could
 * produce an investor all day on the immediate board and the settings screen would
 * go on saying it had never been seen there, and an investor LoanNEX quietly did
 * not carry was never reported to anybody.
 *
 * ⛔ THIS IS A MOVE, NOT A SECOND IMPLEMENTATION. The rules below are the bands
 * door's own rules, lifted verbatim so both doors run the SAME code. A second copy
 * is how one door starts recording a sighting the other does not, and the settings
 * screen then answers differently depending on which door the officer happened to
 * trigger.
 *
 * ── THE TWO RULES THAT LOOK LIKE DETAILS AND ARE NOT ───────────────────────
 * ⛔ ONLY A SHEET THAT ANSWERED IS EVIDENCE. A vendor outage is no evidence about
 * any investor, and recording one would lock every investor that sheet normally
 * carries out of the settings screen's source buttons. `boardForScenario` already
 * reports `answered` per sheet and returns an EMPTY `missing` for a sheet that
 * refused, so one bad minute can never file forty reviews — but the observer
 * re-asserts it rather than trusting the caller.
 *
 * ⛔ ONE SEARCH IS ONE RECORD, ACROSS EVERY BAND. The bands door asks the sheets
 * once per DSCR band; an investor that answers in one band and not another is an
 * investor that sheet CARRIES, so the bands are UNIONED and flushed once at the
 * end. Writing per band would spend a settings round trip per band and, worse,
 * would record a narrow band's silence as evidence about the sheet.
 *
 * EVERY WRITE IS BEST-EFFORT. The officer's board has already been built by the
 * time any of this runs, so both writers swallow their own failures and report
 * them in the return value — a settings store that is briefly unwritable costs a
 * column on a settings screen, never a board.
 *
 * ⛔ HONEST NOTE ON THE TWO HALVES. The SIGHTINGS half is genuinely generic —
 * it walks `investor-sightings.SOURCES`, so a third rate sheet added there is
 * observed here with nothing to remember to update. The MISSES half is NOT: it
 * names `loannex` as the sheet that missed and reads `lenderprice` as "the
 * other sheet", because that is the only pair the owner has switched investors
 * between. A third sheet needs this half generalised deliberately; it will not
 * follow on its own, and saying otherwise would be the confident wrong answer.
 *
 * ── PART_OF_A_LARGER_SEARCH: ONE PRESS IS ONE SEARCH, ACROSS THE TWO DOORS ──
 * ⛔ THE RULE ABOVE SPANS THE BANDS OF ONE DOOR. IT DID NOT SPAN THE TWO DOORS OF ONE
 * PRESS (post-merge audit 2026-09-03), and on the General Pricing Engine one press is
 * always both: `LtPricer` calls the immediate board and then the band board on the same
 * press, and since #1436 both record. Three consequences, all of them real:
 *
 *   · A FALSE MISS, AND A FALSE EMAIL. The immediate door files its misses at once, off
 *     ONE unbanded board, before the bands door has asked anything. A narrower band can
 *     legitimately return nothing for an investor a wider one saw — this module's own
 *     rule, and the reason the band union exists — so the same press can file a miss for
 *     an investor it is about to prove the sheet carries. `source-misses.record` is one
 *     row per investor per day with an IS NULL-guarded alert, so the row and the email
 *     land and NOTHING retracts them.
 *   · THE REVIEWER'S COUNT IS DOUBLED. `lt_pricing_source_misses.hits` advances twice
 *     per press, so "is this every search or one odd scenario?" reads 2x.
 *   · A SOURCE BUTTON LOCKS OUT ON HALF THE EVIDENCE. `searches[source]` advances twice
 *     per press, so `NEVER_AFTER_SEARCHES = 20` — twenty VARIED searches — arrives after
 *     about ten presses.
 *
 * So a door that KNOWS another is following on the same press says so, and then:
 * it records its SIGHTINGS (what a sheet carried is a fact, and the register would lose
 * the immediate board's investors otherwise — the very thing #1436 fixed), without
 * counting the press as a second search, and it files NO misses. The door that finishes
 * the press files them, on the better evidence.
 *
 * ⛔ THE CALLER MUST BE HONEST, AND SILENCE MEANS "I AM THE WHOLE SEARCH". The bands door
 * does not always run — `LtPricer.runBrackets` returns early when the deal's figures
 * cannot be banded, which is an ordinary state for a quick price — so the flag is passed
 * only when the bands genuinely follow, and any door that does not set it records in
 * full, exactly as before. That default is the fail-safe direction: the worst a wrong
 * "false" can do is the double-count that already happens today, where a wrong "true"
 * would lose a real alert.
 *
 * PURE OF ROUTES: no Express, no request. Its two writers are injectable so the
 * whole thing runs in a test with no database.
 */

const investorConfig = require('./investor-config');
const sourceMisses = require('./source-misses');
// The list of rate sheets comes from the register that STORES them, so a third
// sheet added there is observed here with nothing to remember to update.
const sightingsRegister = require('./investor-sightings');

/**
 * AN ACCUMULATOR FOR ONE SEARCH — however many boards that search builds.
 *
 * `observe(board)` takes a `boardForScenario` result (one band, or the whole
 * immediate board) and unions what it saw. `flush(opts)` writes both registers
 * once. Calling `flush` with nothing observed writes nothing at all.
 */
/**
 * IS THIS DOOR PART OF A LARGER SEARCH? — read from a request body, ONCE, here.
 *
 * ⛔ IT IS A FUNCTION SO IT CAN BE RUN, and that is the whole reason it exists. It was
 * one inline expression at the route (`partOfLargerSearch: body.bandsFollow === true`)
 * guarded by an UNANCHORED regex, and the re-audit of 2026-09-03 walked past it by
 * appending a disjunct: `|| body.full === true`. The regex still matched, every LT
 * suite in the chain stayed green — and since `GENERAL_ENGINE.price` sends `full: true` on every
 * press, the immediate door on the General Pricing Engine would then have filed NO miss
 * and counted NO search, ever, whatever the screen said. A rule that decides whether a
 * super admin is told about a rate sheet is not a thing to pin by spelling.
 *
 * STRICT ON PURPOSE. Only an explicit boolean `true` narrows what is recorded; a string
 * "true", a 1, a missing key and anything else all mean "I am the whole search", which
 * is the safe direction — its worst outcome is a duplicate, never a silence.
 */
function partOfLargerSearchFrom(body) {
  return !!(body && body.bandsFollow === true);
}

function collector(deps = {}, opts = {}) {
  const recordSightings = deps.recordSightings || investorConfig.recordSightings;
  const recordMisses = deps.recordMisses || sourceMisses.record;
  /* ⛔ IS THIS DOOR THE WHOLE SEARCH, OR PART OF ONE? See `PART_OF_A_LARGER_SEARCH`
     below. Default TRUE — a caller that says nothing is treated as the whole search
     and records everything, which is the behaviour every door had before and the
     safe direction: the failure it can produce is a duplicate, never a silence. */
  const whole = opts.partOfLargerSearch !== true;

  const sighted = {};
  for (const s of sightingsRegister.SOURCES) sighted[s] = { answered: false, keys: new Set() };
  const missedKeys = new Set();
  let observed = 0;

  /* A LIST WE WERE HANDED, OR NOTHING. `for…of` over a NUMBER throws
     ("number 7 is not iterable"), and this runs after the officer's board is
     already built — on the immediate door a throw here would turn a board the
     vendor call has already been paid for into a bare 500. The header promises
     best-effort; this is what makes that true of the SHAPE as well as of the
     writes. Today's `boardForScenario` cannot produce a non-list, so this is a
     guard against a future shape, not a live bug. */
  const listOf = (v) => (Array.isArray(v) ? v : (v instanceof Set ? [...v] : []));

  function observe(board) {
    if (!board || board.ok === false) return; // a refused board is not evidence about anything
    observed += 1;
    for (const src of sightingsRegister.SOURCES) {
      const o = board.sightings && board.sightings[src];
      // ANSWERED, not merely present: see the header. A sheet that refused says
      // nothing about any investor, in either register.
      if (!o || !o.answered) continue;
      sighted[src].answered = true;
      for (const k of listOf(o.keys)) sighted[src].keys.add(k);
    }
    for (const k of listOf(board.missing)) missedKeys.add(k);
  }

  async function flush(opts = {}) {
    if (!observed) return { ok: true, sightings: null, misses: null };

    const observedOut = {};
    for (const s of sightingsRegister.SOURCES) {
      observedOut[s] = { answered: sighted[s].answered, keys: [...sighted[s].keys] };
    }
    let sightingsResult = null;
    try {
      sightingsResult = await recordSightings(observedOut, {
        staffId: opts.staffId || null,
        // What was SEEN is recorded either way; what is not counted twice is the SEARCH.
        counts: whole,
      });
    } catch (e) {
      sightingsResult = { ok: false, problem: String((e && e.message) || e).slice(0, 200) };
    }

    /* ⛔ THE BAND UNION APPLIES TO BOTH HALVES — this is the second half of the
       header's own rule, and it was missing.

       The bands door asks the sheets once per DSCR band, and a narrower band can
       legitimately return nothing for an investor the SAME search saw in a wider
       one. Unioning only the sightings meant one search could record NQM as SEEN
       on LoanNEX and, in the same breath, file a miss for NQM against LoanNEX —
       emailing the super admin about an investor it had just proved was there.

       So a key the sheet actually carried somewhere in this search is not a miss.
       On the immediate door there is one board, so this can only ever be a no-op
       there; it is the multi-band door it exists for. */
    for (const k of sighted.loannex.keys) missedKeys.delete(k);

    let missesResult = null;
    /* ⛔ AND A PART-DOOR FILES NO MISS AT ALL. A miss is a claim that a sheet answered
       a search and did not carry an investor — and on this press the search is not
       finished. The door that finishes it asks the same scenario across every band, so
       its answer is strictly better informed; filing here would email the super admin
       about an investor the same press is about to prove the sheet carries. */
    if (missedKeys.size && whole) {
      try {
        missesResult = await recordMisses(
          [...missedKeys].map((key) => ({
            key,
            /* Did the OTHER sheet have them? The owner's own question, and the one that
               tells "the second sheet is having a bad day" apart from "this investor has
               no product for this loan". Only answerable when that sheet actually
               answered — otherwise it is `null`, never a confident false. */
            otherSourceHad: sighted.lenderprice.answered
              ? sighted.lenderprice.keys.has(key)
              : null,
          })),
          {
            source: 'loannex',
            scenario: opts.scenario,
            note: opts.note
              || 'The second rate sheet answered this search and did not carry this investor.',
          },
        );
      } catch (e) {
        missesResult = { ok: false, problem: String((e && e.message) || e).slice(0, 200) };
      }
    }

    return { ok: true, sightings: sightingsResult, misses: missesResult };
  }

  return { observe, flush };
}

/** The one-board shorthand: observe it and flush, in one call. */
async function recordOne(board, opts = {}, deps = {}) {
  const c = collector(deps, { partOfLargerSearch: opts.partOfLargerSearch === true });
  c.observe(board);
  return c.flush(opts);
}

/* ── THE OFFICER'S BOARD MUST NOT WAIT FOR THE BOOKKEEPING ──────────────────
   MEASURED on the real handler: 161 ms to answer without the alert, 3,183 ms
   with a three-second mail provider. The module header has said since it was
   written that the board "has already been built" by the time this runs — it
   was BUILT, and it was not DELIVERED: both doors `await`ed the recording
   before `res.json`, so an officer pricing a loan waited on a settings write
   and, on the first miss of the day, on an outbound email.

   `sourceMisses.record` is safe to run after the answer has gone: its alert
   claims each row with an IS NULL-guarded UPDATE and RELEASES that claim if the
   send fails, so nothing is lost by finishing late and nothing is sent twice.

   IT CAN NEVER REJECT. Detached work whose promise nobody holds is an unhandled
   rejection, which on some Node configurations takes the process down — a far
   worse outcome than the missed column it is protecting.

   `settled()` exists so a test can be DETERMINISTIC about work that is
   deliberately off the response path: awaiting it is exact, where a sleep is a
   guess that goes flaky on a loaded build server. */
const inFlight = new Set();

function later(fn) {
  const w = Promise.resolve().then(fn).catch(() => {}).finally(() => inFlight.delete(w));
  inFlight.add(w);
  return w;
}

/** Wait for every detached write started so far. For tests; a route never calls it. */
async function settled() {
  while (inFlight.size) await Promise.all([...inFlight]);
}

module.exports = {
  partOfLargerSearchFrom, collector, recordOne, later, settled };
