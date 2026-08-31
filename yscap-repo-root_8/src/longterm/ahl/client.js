'use strict';
/**
 * LONG-TERM — the American Heritage Lending Quick Pricer client.
 *
 * A pricing VIEWER. It reads AHL's public Quick Pricer and nothing else: it
 * never locks, registers, books, submits or writes anything at AHL.
 *
 * ── THERE ARE NO CREDENTIALS, AND THAT CHANGES THE OBLIGATIONS ─────────────
 * Measured 2026-08-30: the Quick Pricer sends no cookie, sets no cookie, and
 * requires no token, CSRF value or Referer. A bare POST returns a live board.
 * That removes the auth problem and replaces it with two others, both handled
 * here rather than left to a caller:
 *
 *   1. NO QUOTA MEANS NO GOODWILL EITHER. Nothing at AHL rate-limits us, which
 *      is exactly why this client limits itself: one scenario at a time, the
 *      legs of it capped by `AHL_MAX_CONCURRENCY` (2), and a hard ceiling on
 *      legs per scenario so a bad caller cannot turn one board into forty
 *      requests.
 *   2. NO CONTRACT MEANS NO STABILITY PROMISE. A public PHP page can change its
 *      markup on any deploy. `health()` re-reads the form and diffs it against
 *      the captured registry, which is what the canary calls.
 *
 * ── THE ALLOWLIST IS POSITIVE, NOT A BLOCKLIST ─────────────────────────────
 * Two paths are reachable and every other URL is refused BEFORE the wire. A
 * blocklist is only as good as the last endpoint somebody knew about, and this
 * page's own form posts an `Action` field whose other values (`Select Rate`,
 * `Lock`) are exactly the ones a viewer must never send — so `Action` is pinned
 * to `Get Pricing` here as well as in `scenario.js`, and a body carrying any
 * other value is refused.
 *
 * LT-only. Reads `process.env` directly, touches no database, imports no RTL code.
 */

const scenario = require('./scenario');
const parse = require('./parse');
const registry = require('./field-registry');

const BASE = () => String(process.env.AHL_BASE_URL || 'https://client.ahlend.com').replace(/\/+$/, '');
const TIMEOUT_MS = () => Number(process.env.AHL_TIMEOUT_MS || 30000);
const MAX_CONCURRENCY = () => Math.max(1, Math.min(4, Number(process.env.AHL_MAX_CONCURRENCY || 2)));
/** One scenario is at most this many requests. Four legs is the whole DSCR shelf at both locks. */
const MAX_LEGS = 8;
const USER_AGENT = 'YSCAP-LT-Pricing/1.0 (+pricing viewer; contact yscapgroup.com)';

/** The only two paths this client may ever reach. */
const ALLOWED_PATHS = new Set(['/quickpricer/index.php', '/ajax/getcitystatecountyfromzip.json']);
/** The only `Action` a viewer may send. `Select Rate` and `Lock` are writes. */
const ALLOWED_ACTION = 'Get Pricing';

class AhlClientError extends Error {
  constructor(code, message, extra = {}) { super(message); this.code = code; this.name = 'AhlClientError'; Object.assign(this, extra); }
}

function assertUrl(path) {
  if (!ALLOWED_PATHS.has(path)) {
    throw new AhlClientError('path_not_allowed', `${path} is not on this client's allowlist. It is a pricing viewer: only the Quick Pricer and the zip lookup are reachable, and everything else is refused before the wire.`);
  }
  const url = `${BASE()}${path}`;
  const u = new URL(url);
  if (u.protocol !== 'https:') throw new AhlClientError('insecure_url', 'AHL is only ever reached over https.');
  return url;
}

function assertReadOnlyBody(pairs) {
  const action = (pairs.find(([k]) => k === 'Action') || [])[1];
  if (action !== ALLOWED_ACTION) {
    throw new AhlClientError('write_action_refused',
      `This client may only send Action="${ALLOWED_ACTION}". ${JSON.stringify(String(action))} is one of the form's WRITE actions and is refused — a pricing viewer never selects or locks a rate.`);
  }
}

async function postForm(path, pairs, opts = {}) {
  const url = assertUrl(path);
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), opts.timeoutMs || TIMEOUT_MS());
  const started = Date.now();
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': USER_AGENT, Accept: 'text/html,application/json' },
      body: scenario.encode(pairs),
      signal: controller.signal,
      redirect: 'manual',
    });
    // A REDIRECT IS NOT A PRICE. `/tpo/*` answers 302 to the login; if the Quick
    // Pricer ever starts doing the same, that is AHL putting it behind a wall and
    // must surface as a refusal rather than as an empty board.
    if (res.status >= 300 && res.status < 400) {
      throw new AhlClientError('redirected', `AHL redirected the Quick Pricer to ${res.headers.get('location') || 'somewhere else'} — it is no longer answering publicly.`, { status: res.status });
    }
    if (!res.ok) throw new AhlClientError('http_error', `AHL answered HTTP ${res.status}.`, { status: res.status });
    const body = await res.text();
    return { body, status: res.status, ms: Date.now() - started };
  } catch (e) {
    if (e && e.name === 'AbortError') throw new AhlClientError('timeout', `AHL did not answer within ${opts.timeoutMs || TIMEOUT_MS()}ms.`);
    throw e;
  } finally { clearTimeout(t); }
}

/** Run at most `limit` at a time, preserving input order in the result. */
async function pooled(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    for (;;) {
      const i = next; next += 1;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * Price one scenario: build every leg, post them, merge the answers into ONE
 * board with the 0.25 margin holdback NOT yet applied.
 *
 * ⛔ THE HOLDBACK IS DELIBERATELY NOT APPLIED HERE. It belongs to
 * `../pricing/vendor-margin.js`, which is the one place it is taken for any
 * vendor and which refuses to run twice on one board. Taking it here as well
 * would be the second place, and a holdback taken in two places is a holdback
 * taken twice.
 *
 * A LEG THAT FAILS DOES NOT SINK THE BOARD, and it does not vanish either: the
 * others are still returned and the failure rides along in `legErrors`, so a
 * board showing only the 30-year product can always say the 40-year leg errored
 * rather than implying AHL does not offer one.
 */
async function priceScenario(sc, opts = {}) {
  const built = scenario.build(sc, opts);
  if (built.legs.length > MAX_LEGS) {
    throw new AhlClientError('too_many_legs', `${built.legs.length} legs for one scenario exceeds the ${MAX_LEGS}-request ceiling. AHL sets no quota, so this client sets its own.`);
  }
  for (const leg of built.legs) assertReadOnlyBody(leg.body);

  const legErrors = [];
  const results = await pooled(built.legs, MAX_CONCURRENCY(), async (leg) => {
    try {
      const res = await postForm('/quickpricer/index.php', leg.body, opts);
      return parse.parse(res.body, leg);
    } catch (e) {
      legErrors.push({ leg: leg.key, code: e && e.code ? e.code : 'error', message: e && e.message ? e.message : String(e) });
      return null;
    }
  });

  const boards = results.filter(Boolean);
  if (!boards.length) {
    throw new AhlClientError('all_legs_failed', `Every one of AHL's ${built.legs.length} product legs failed; no board can be built.`, { legErrors });
  }
  const board = parse.mergeLegs(boards);
  board.channel = built.channel;
  board.legsRequested = built.legs.map((l) => l.key);
  board.legErrors = legErrors;
  return board;
}

/** zip → city / state / county — and AHL's own `licensed` answer for the state. */
async function lookupZip(zip, opts = {}) {
  const res = await postForm('/ajax/getcitystatecountyfromzip.json', [['zip', String(zip)]], opts);
  try { return JSON.parse(res.body); }
  catch (_) { throw new AhlClientError('unparsable_zip_answer', 'AHL answered the zip lookup with something that is not JSON.'); }
}

/**
 * Is AHL still answering, and is its form still the one we mapped?
 *
 * BOTH QUESTIONS, because they fail differently and only one of them is loud. A
 * page that stops answering is obvious; a page that quietly renames an option is
 * not, and it is the one that mis-prices. `registryChanged` is what the canary
 * watches.
 */
async function health(opts = {}) {
  const url = assertUrl('/quickpricer/index.php');
  const started = Date.now();
  try {
    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, redirect: 'manual' });
    const ms = Date.now() - started;
    if (res.status >= 300 && res.status < 400) return { ok: false, reason: 'redirected', status: res.status, ms, location: res.headers.get('location') };
    if (!res.ok) return { ok: false, reason: 'http_error', status: res.status, ms };
    const html = await res.text();
    const fresh = extractForm(html);
    const d = registry.diff(fresh);
    return {
      ok: true, status: res.status, ms,
      selectCount: Object.keys(fresh).length,
      registryChanged: d.changed,
      registryChanges: d.changes,
      note: d.changed
        ? 'AHL has changed its Quick Pricer form since the captured registry. The mapping must be re-read before this board is trusted.'
        : 'AHL is answering and its form matches the captured registry.',
    };
  } catch (e) {
    return { ok: false, reason: 'unreachable', ms: Date.now() - started, message: e && e.message ? e.message : String(e) };
  }
}

/**
 * Pull the `<select>` registry back out of a live page — the same extraction the
 * captured `capture/form-registry.json` was made with, kept here so `health`
 * compares like with like rather than against a differently-produced file.
 */
function extractForm(html) {
  const doc = parse._internals.repairOperators(html);
  const out = {};
  const reSel = /<select\b([^>]*)>([\s\S]*?)<\/select>/g;
  let m;
  while ((m = reSel.exec(doc)) !== null) {
    const nm = /name="([^"]+)"/.exec(m[1]);
    if (!nm) continue;
    const opts = [];
    const reOpt = /<option\b([^>]*)>([\s\S]*?)<\/option>/g;
    let o;
    while ((o = reOpt.exec(m[2])) !== null) {
      const v = /value="([^"]*)"/.exec(o[1]);
      const c = /class="([^"]*)"/.exec(o[1]);
      opts.push({ value: v ? v[1] : null, text: parse._internals.text(o[2]), class: c ? c[1].trim() : '' });
    }
    out[nm[1]] = opts;
  }
  return out;
}

module.exports = {
  AhlClientError, ALLOWED_PATHS, ALLOWED_ACTION, MAX_LEGS,
  priceScenario, lookupZip, health, extractForm,
  _internals: { assertUrl, assertReadOnlyBody, postForm, pooled, BASE },
};
