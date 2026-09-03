'use strict';
/**
 * IS THIS RATE SHEET ACTUALLY CONNECTED — and does it matter on this screen?
 *
 * ── THE REPORT THIS EXISTS FOR ─────────────────────────────────────────────
 * Owner, 2026-09-03, after the five investors were switched to LoanNEX:
 * *"It still does not. I searched again. It still does not come up in any of the
 * new five. It's not pulling on the ink from loannex yet."*
 *
 * Everything upstream of that sentence was working. The code was live (the
 * served bundle carried the settings section), the five investors were routed
 * to LoanNEX by default, and `investor-routing.applyRouting` did exactly what
 * it was told: an investor whose sheet does not answer is HIDDEN, never quietly
 * served from the other sheet — *"this investor is priced there, so ours would
 * be second-hand."*
 *
 * ⛔ AND THE OWNER ASKED FOR THE PRICING PAGE TO STAY QUIET ABOUT IT — *"leave
 * that investor out of the board silently… and email the super admin."* Which
 * is right, and which is also why a sheet with no login configured produces a
 * board that is short five investors and says nothing at all. The information
 * exists (it rides on `sources.loannex.error`); there was nowhere it was READ.
 *
 * ── SO THE STATEMENT BELONGS ON THE SETTINGS SCREEN ────────────────────────
 * Not the pricing page (the owner's rule stands). The settings screen is where
 * somebody is already standing when they point an investor at a rate sheet, and
 * it is the only screen where "that sheet has no login" is actionable.
 *
 * ── WHY THIS IS A MODULE AND NOT THREE LINES IN THE ROUTE ──────────────────
 * The two clients answer the same question in TWO SHAPES — Lender Price's
 * `configured()` returns a BOOLEAN, LoanNEX's returns an OBJECT — which is the
 * drift this repo keeps getting bitten by. `readConfigured` is the one place
 * that reconciles them, and the wording lives beside it so a screen cannot
 * invent its own.
 *
 * PURE: no requires, no network, no database. Every rule here is unit-testable.
 */

/** The three honest answers. `unknown` is never rendered as either of the others. */
const YES = 'connected';
const NO = 'not_connected';
const UNKNOWN = 'unknown';

const LABEL = { lenderprice: 'Lender Price', loannex: 'LoanNEX' };

/** How a sheet is signed in to, for the message that tells somebody what to set. */
const HOW = {
  loannex: 'a LoanNEX username and password (NEX_USERNAME and NEX_PASSWORD), or a NEX_TOKEN_KEY',
  lenderprice: 'the Lender Price credentials',
};

/**
 * NORMALISE WHATEVER A CLIENT'S `configured()` HANDED BACK.
 *
 * ⛔ IT MAY NEVER ANSWER `connected` ON A GUESS. Telling somebody a sheet is
 * connected when we cannot tell sends them looking for the fault everywhere
 * except the one place it is; the opposite mistake merely sends them to check a
 * credential that turns out to be fine. So anything unrecognisable is UNKNOWN.
 *
 * Accepts a boolean (Lender Price), an object with `ok` (LoanNEX), or a thrown
 * error's absence — a caller that could not even load the client passes null.
 */
function readConfigured(answer) {
  if (answer === true) return YES;
  if (answer === false) return NO;
  if (answer && typeof answer === 'object') {
    if (answer.ok === true) return YES;
    if (answer.ok === false) return NO;
  }
  return UNKNOWN;
}

/**
 * ONE SHEET'S STANDING, AND WHETHER THIS SCREEN SHOULD SAY ANYTHING ABOUT IT.
 *
 * `routedCount` is the whole reason this is not just a status light: a sheet
 * nobody is routed to being unconfigured is not a problem, and a banner about
 * it is noise that teaches people to ignore banners. The message is raised only
 * when a real investor on this screen is pointed at a sheet that cannot answer.
 *
 * @param {string} source        'lenderprice' | 'loannex'
 * @param {*}      answer        whatever that client's configured() returned
 * @param {number} routedCount   how many ENABLED investors are pointed at it
 */
function standingFor(source, answer, routedCount) {
  const state = readConfigured(answer);
  const name = LABEL[source] || String(source || 'this rate sheet');
  const n = Number(routedCount);
  const routed = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  const many = routed === 1 ? 'investor is' : 'investors are';

  let message = null;
  if (routed > 0 && state === NO) {
    message = `${routed} ${many} set to be priced from ${name}, but ${name} has no login set on this server. `
      + `Until ${HOW[source] || 'its credentials'} ${HOW[source] ? 'is' : 'are'} set, those investors will not appear on the board at all — `
      + `their price is not taken from the other sheet instead, on purpose.`;
  } else if (routed > 0 && state === UNKNOWN) {
    message = `${routed} ${many} set to be priced from ${name}, and PILOT could not check whether ${name} is connected. `
      + `If those investors are missing from the board, that is the first thing to check.`;
  }

  return {
    source,
    label: name,
    state,
    connected: state === YES,
    routed,
    /* `speak` is what a screen keys on. Deliberately NOT `!connected`: a sheet
       nobody uses, and a sheet that is fine, are both silent. */
    speak: message !== null,
    message,
  };
}

/**
 * BOTH SHEETS, FOR THE SETTINGS SCREEN.
 *
 * NEVER THROWS — this rides on a settings read, and a decoration that can 500
 * the screen it decorates is worse than no decoration. A source that blows up
 * reads as UNKNOWN, which is the honest answer about it.
 *
 * @param {object} answers  { lenderprice: <configured()>, loannex: <configured()> }
 * @param {object} counts   { lenderprice: n, loannex: n } enabled investors routed there
 */
function connectionsFor(answers, counts) {
  const a = answers || {};
  const c = counts || {};
  const out = {};
  for (const src of ['lenderprice', 'loannex']) {
    try {
      out[src] = standingFor(src, a[src], c[src]);
    } catch (_) {
      out[src] = standingFor(src, null, c[src]);
    }
  }
  return out;
}

/**
 * HOW MANY ENABLED INVESTORS EACH SHEET IS ASKED FOR, off the rows the screen is
 * about to draw. `both` counts toward BOTH, because an investor set to both is
 * genuinely expected from each.
 */
function routedCounts(rows) {
  const out = { lenderprice: 0, loannex: 0 };
  for (const r of rows || []) {
    if (!r || !r.enabled) continue;
    if (r.source === 'lenderprice' || r.source === 'both') out.lenderprice += 1;
    if (r.source === 'loannex' || r.source === 'both') out.loannex += 1;
  }
  return out;
}

/**
 * WHEN THIS SHEET LAST ACTUALLY ANSWERED A SEARCH.
 *
 * ── WHY THIS EXISTS ON TOP OF THE CONNECTION CHECK ─────────────────────────
 * Owner, 2026-09-03, reasonably: *"I see already in the search the new
 * investor's name. When I click Narrow Down, where exactly are we off?"*
 *
 * ⛔ SEEING THE NEW NAMES THERE IS NOT EVIDENCE THE SHEET IS WORKING, and that
 * is the trap this line closes. "Narrow to certain investors" is drawn from
 * `engine.investors()` — a free read of OUR OWN settings roster, with the code's
 * own comment saying "no vendor call, no billing" — so it lists the five
 * whether or not LoanNEX has ever answered anything.
 *
 * And `configured()` is not enough either: it reads the ENVIRONMENT, so a login
 * that is SET BUT WRONG (a rotated password, a changed portal, a vendor
 * timeout) reports "connected" and still produces nothing. The register already
 * holds the fact that settles it — the moment a sheet produces a board, its
 * timestamp is written — and nothing read it out loud.
 *
 * NEVER GUESSES: an absent or unreadable stamp is reported as "never answered",
 * which is what an absent stamp means, and never as a time.
 *
 * ⛔ IT RETURNS THE FACT, NOT THE SENTENCE. A date has to be rendered in the
 * READER'S OWN timezone, which only their browser knows — a server-composed
 * "last answered at 13:02" is 13:02 somewhere else. So the screen writes that
 * one line and this writes none; the never-answered wording has no date in it
 * and stays here. One home each, neither duplicated.
 */
function lastAnsweredFor(source, boards, now) {
  const name = LABEL[source] || String(source || 'this rate sheet');
  const raw = boards && typeof boards === 'object' ? boards[source] : null;
  const at = typeof raw === 'string' ? raw : null;
  const t = at ? Date.parse(at) : NaN;
  if (!at || !Number.isFinite(t)) {
    return { source, label: name, at: null, everAnswered: false, ageHours: null,
      neverNote: `${name} has never answered a search on this system.` };
  }
  const nowMs = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  /* A stamp in the FUTURE is a clock disagreement, not an age — reported as
     answered, with no age, rather than as a negative number of hours. */
  const ageHours = nowMs > t ? (nowMs - t) / 3600000 : null;
  return { source, label: name, at, everAnswered: true, ageHours, neverNote: null };
}

/** Both sheets' last answer, for the settings screen. NEVER THROWS. */
function lastAnsweredAll(boards, now) {
  const out = {};
  for (const src of ['lenderprice', 'loannex']) {
    try { out[src] = lastAnsweredFor(src, boards, now); } catch (_) { out[src] = lastAnsweredFor(src, null, now); }
  }
  return out;
}

module.exports = {
  connectionsFor, routedCounts, standingFor, readConfigured,
  lastAnsweredFor, lastAnsweredAll,
  STATES: { YES, NO, UNKNOWN },
  _internals: { LABEL, HOW },
};
