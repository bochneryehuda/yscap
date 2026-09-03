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
function collector(deps = {}) {
  const recordSightings = deps.recordSightings || investorConfig.recordSightings;
  const recordMisses = deps.recordMisses || sourceMisses.record;

  const sighted = {};
  for (const s of sightingsRegister.SOURCES) sighted[s] = { answered: false, keys: new Set() };
  const missedKeys = new Set();
  let observed = 0;

  function observe(board) {
    if (!board || board.ok === false) return; // a refused board is not evidence about anything
    observed += 1;
    for (const src of sightingsRegister.SOURCES) {
      const o = board.sightings && board.sightings[src];
      // ANSWERED, not merely present: see the header. A sheet that refused says
      // nothing about any investor, in either register.
      if (!o || !o.answered) continue;
      sighted[src].answered = true;
      for (const k of o.keys || []) sighted[src].keys.add(k);
    }
    for (const k of board.missing || []) missedKeys.add(k);
  }

  async function flush(opts = {}) {
    if (!observed) return { ok: true, sightings: null, misses: null };

    const observedOut = {};
    for (const s of sightingsRegister.SOURCES) {
      observedOut[s] = { answered: sighted[s].answered, keys: [...sighted[s].keys] };
    }
    let sightingsResult = null;
    try {
      sightingsResult = await recordSightings(observedOut, { staffId: opts.staffId || null });
    } catch (e) {
      sightingsResult = { ok: false, problem: String((e && e.message) || e).slice(0, 200) };
    }

    let missesResult = null;
    if (missedKeys.size) {
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
  const c = collector(deps);
  c.observe(board);
  return c.flush(opts);
}

module.exports = { collector, recordOne };
