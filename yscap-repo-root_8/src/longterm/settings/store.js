'use strict';
/**
 * LONG-TERM — the settings STORE (db/553 `lt_settings`).
 *
 * `encompass-settings.js` has declared 44 settings in 10 groups, with OUR values
 * as their defaults and a `resolve(overrides)` that accepts overrides, since the
 * day it was written. It has never had anywhere to save an override. This is that
 * place, and nothing else: the DECLARATIONS stay there, the VALUES live here.
 *
 * THE RULE THIS EXISTS TO SERVE (owner-directed): "everything that I'm telling you
 * to build, which is customizable to us, should be in the settings pre-filled
 * customizable for us, but everything should be able to be changed so we can sell
 * the system eventually and customize it according to someone else's needs."
 *
 * FOUR PROPERTIES, each load-bearing:
 *
 *   1. AN UNKNOWN KEY IS REFUSED, never stored. The declaration list is the
 *      whitelist. Without this the table becomes a junk drawer and "what settings
 *      exist" stops having an answer.
 *
 *   2. READS START FROM THE DEFAULTS and overlay the row. A missing row, a missing
 *      key, a brand-new setting nobody has saved — all resolve to a concrete value.
 *
 *   3. IT FAILS TO *OUR* BEHAVIOUR, never to nothing. If the table is missing or
 *      the database is unreachable, `load()` returns the declared defaults and says
 *      so. A settings outage must not change how the system behaves; it must only
 *      stop somebody's customisation from applying.
 *
 *   4. IT IS CACHED, because settings are read on nearly every request and change
 *      perhaps monthly. The cache is busted on every write in this process; the TTL
 *      is what carries a write made by another instance.
 *
 * A FIFTH, ADDED FOR THE MAPS: a declaration may carry its OWN write door
 * (`validate`) and its own load hook (`applyOnLoad`), and this store runs them.
 * A setting whose value is a small database of its own — the investors added by
 * hand, whose white labels are names a client may see — cannot be checked by
 * "is the key declared"; the rules that make it safe live with the thing it
 * describes, and running them HERE is what makes them unskippable: every write
 * lands through `save()`, so there is no second path that stores the value
 * unchecked. `applyOnLoad` is the mirror: a value that something in the process
 * must be TOLD about (the audience block, which has to know a hand-added
 * investor's spellings before it can scrub them) is handed over on the read that
 * loaded it, so nothing has to remember to do it.
 *
 * SEPARATION: reads and writes only `lt_settings`. No RTL table, no RTL import.
 */

const decl = require('./encompass-settings');
// The pool is required LAZILY. `isKnown`, `defaults` and `validate` are pure
// policy — the whitelist and the declared values — and must load without a database
// driver in reach, so the rules can be unit-tested and so a caller that only
// validates never opens a connection.
const lazyDb = () => require('../db');

const TTL_MS = Number(process.env.LT_SETTINGS_TTL_MS || 60000);
const DEFAULT_SCOPE = 'company';

/** @type {Map<string, {at:number, settings:object, degraded:boolean}>} */
const cache = new Map();

/** True when `key` is a declared setting. The whitelist, in one place. */
function isKnown(key) {
  return decl.definition(String(key)) !== null;
}

/**
 * Every declared setting with OUR value. Never throws — this is what the whole
 * module falls back to.
 */
function defaults() {
  return decl.defaults();
}

/**
 * The effective settings for a scope: the declared defaults with any saved
 * overrides laid over them.
 *
 * Returns `{settings, degraded, stored, source}`. `stored` is the set of keys
 * this scope holds a row of its own for — which is a different question from
 * "does the value differ from the default", and the one a caller asking "did
 * somebody choose this" needs. `degraded` is true when the stored
 * overrides could not be read — the caller still gets a complete, usable settings
 * object, and anything that wants to warn a human can see that it is not the full
 * picture.
 */
const inFlight = new Map();
/**
 * How many times each scope has been invalidated.
 *
 * ⛔ WHAT THIS IS FOR, and it is a bug the de-duplication above created rather
 * than found: a read that is already in flight when somebody calls `bust()` —
 * or writes, which busts — is carrying values from BEFORE that moment. Letting
 * it fill the cache on arrival re-installs the stale settings the bust existed
 * to throw away, and they then stand for a full TTL. So a read stamps the
 * generation it started in and declines to cache its answer if the generation
 * has moved on. The caller still gets its (slightly stale) answer, which is no
 * worse than any other read that raced a write; what it may not do is publish it
 * to everybody else.
 */
const generation = new Map();
const genOf = (key) => generation.get(key) || 0;

async function load(scope = DEFAULT_SCOPE, opts = {}) {
  // ⛔ ONE READ AT A TIME PER SCOPE. `ensureWarm` runs on every request, so a
  // cold process taking N concurrent requests used to fire N concurrent SELECTs
  // before the first one filled the cache — a thundering herd this feature
  // created by mounting the guard everywhere. Callers share the in-flight read
  // instead. A `fresh` read is not shared with a cached-path caller (it is
  // asking for something different), but two `fresh` readers still share.
  const key = String(scope || DEFAULT_SCOPE);
  const lane = `${key}:${opts.fresh ? 'fresh' : 'any'}`;
  const running = inFlight.get(lane);
  if (running) return running;
  const p = loadNow(key, opts).finally(() => { inFlight.delete(lane); });
  inFlight.set(lane, p);
  return p;
}

async function loadNow(scope, { fresh = false } = {}) {
  const key = String(scope || DEFAULT_SCOPE);
  const startedIn = genOf(key);
  const hit = cache.get(key);
  if (!fresh && hit && Date.now() - hit.at < TTL_MS) {
    // ⛔ A CACHE HIT RE-ASSERTS. It used to skip the hooks on the grounds that
    // the values were the same object they had already seen — which is true of
    // the VALUES and says nothing about what has happened to the thing they were
    // pushed into. Anything that could narrow the audience block between two
    // company reads then stayed narrowed until the entry expired. Re-asserting
    // is a JSON identity check against a map of a handful of entries; being
    // told once is not enough if something else can untell it.
    if (hit.degraded) applyUnreadable(hit.settings, key);
    else applyHooks(hit.settings, null, key);
    return { settings: hit.settings, degraded: hit.degraded, stored: hit.stored, source: 'cache' };
  }

  const base = defaults();
  // WHICH KEYS CAME FROM A ROW, as distinct from which values differ from ours.
  // Merging rows over the defaults loses that, and it is not the same question:
  // a value somebody DELIBERATELY set to the figure we happen to pre-fill is
  // stored, and is a decision. `isOverridden` answers "is this different from
  // ours" — right for a settings screen, and the wrong question to ask about a
  // choice. See `routes/me.js`, where asking the wrong one silently moved people
  // off the side they had chosen.
  const stored = new Set();
  let degraded = false;

  try {
    const { rows } = await lazyDb().query(
      'SELECT key, value FROM lt_settings WHERE scope = $1',
      [key],
    );
    for (const r of rows) {
      // An unknown key is IGNORED on read as well as refused on write. A setting
      // that is retired in code must not keep applying from a stale row.
      if (!isKnown(r.key)) continue;
      base[r.key] = r.value;
      stored.add(r.key);
    }
  } catch (_e) {
    // Fail to OUR behaviour, loudly enough to be visible and quietly enough not
    // to break the request. `stored` stays EMPTY on a failed read — claiming a
    // person chose something because the database was briefly unreachable is the
    // one answer worse than falling back to the default.
    degraded = true;
  }

  // TELL WHOEVER ASKED TO BE TOLD — but only about a reading we actually took.
  // A DEGRADED read has no values to hand over: `base` is the declared defaults,
  // and pushing those would tell the hooks that nobody has configured anything,
  // which for a value like the investors added by hand means "block fewer
  // names". So an outage says "I could not read" and whatever was already in
  // force stands.
  // A read that raced a write does not get to publish what it read. It also does
  // not get to APPLY it: pushing a stale map into the audience block is the same
  // mistake one layer further on, and the write's own hook run has already told
  // the block the truth.
  if (genOf(key) !== startedIn) {
    return { settings: base, degraded, stored, source: 'db-stale', hooksFailed: [] };
  }

  const hooksFailed = degraded ? applyUnreadable(base, key) : applyHooks(base, null, key);

  cache.set(key, { at: Date.now(), settings: base, degraded, stored });
  return { settings: base, degraded, stored, source: 'db', hooksFailed };
}

/** One effective value. */
async function get(settingKey, scope = DEFAULT_SCOPE) {
  const { settings } = await load(scope);
  return settings[String(settingKey)];
}

/**
 * Validate a patch WITHOUT touching the database.
 *
 * Returns `{ok, clean, rejected}`. `rejected` names every key that is not a
 * declared setting, so a caller can tell the user exactly what was wrong rather
 * than answering a flat "invalid".
 */
function validate(patch) {
  const clean = {};
  const rejected = [];
  const problems = [];
  for (const [k, v] of Object.entries(patch || {})) {
    const def = decl.definition(k);
    if (!def) { rejected.push(k); continue; }
    if (v === undefined) continue;
    // THE DECLARATION'S OWN DOOR. A setting that carries one is refused WHOLE
    // when it fails — a half-saved map of investors is worse than a refused one,
    // because the person who filled the form in cannot tell which half applied.
    if (typeof def.validate === 'function') {
      let verdict;
      try {
        verdict = def.validate(v);
      } catch (e) {
        // A door that THREW checked nothing. Treat that as a refusal, never as a
        // pass: this is the only place the value is examined at all.
        verdict = { ok: false, problems: [{ problem: 'check_failed', says: (e && e.message) || String(e) }] };
      }
      if (!verdict || verdict.ok !== true) {
        for (const p of (verdict && verdict.problems) || []) problems.push({ setting: k, ...p });
        if (!problems.some((p) => p.setting === k)) problems.push({ setting: k, problem: 'refused' });
        continue;
      }
      clean[k] = verdict.value === undefined ? v : verdict.value;
      continue;
    }
    clean[k] = v;
  }
  return { ok: rejected.length === 0 && problems.length === 0, clean, rejected, problems };
}

/**
 * Hand every loaded value to its declaration's `applyOnLoad`, where one exists.
 *
 * ⛔ THE COMPANY SCOPE ALONE, AND THIS IS A RULE-10 GUARD, NOT AN OPTIMISATION.
 *
 * `lt_settings` is keyed on (scope, key). A PER-USER read answers the DECLARED
 * DEFAULT for every key that person has never set — an empty map for the
 * investors added by hand — and running the hooks on it handed that empty map
 * to the audience block, switching the investor-name rule OFF for the whole
 * process. The company-scope cache hit afterwards did not re-assert it, so it
 * stayed off for the cache's lifetime. `routes/me.js`, `routes/settings.js` and
 * `routes/term-sheet.js` each read both scopes in one `Promise.all`, and the
 * term-sheet request goes straight on to build a borrower's document: a real
 * investor name reached a borrower this way. A scope other than the company's
 * knows nothing about a company-wide setting and must be structurally incapable
 * of narrowing one.
 *
 * A hook that throws is reported, never swallowed and never fatal: settings are
 * read on the way to something else, and a broken hook must not take that
 * request down with it.
 */
function applyHooks(settings, onlyKeys = null, scope = DEFAULT_SCOPE) {
  if (String(scope) !== DEFAULT_SCOPE) return [];
  const failed = [];
  for (const s of decl.SETTINGS) {
    if (!s || typeof s.applyOnLoad !== 'function') continue;
    // A WRITE only knows about the keys it wrote. Handing a hook the DECLARED
    // DEFAULT for a key this patch never touched would quietly undo somebody
    // else's saved value — so a filtered run skips it and leaves the value the
    // load already applied standing.
    if (onlyKeys && !onlyKeys.has(s.key)) continue;
    try {
      s.applyOnLoad(settings[s.key]);
    } catch (e) {
      failed.push(s.key);
      console.error(`[lt-settings] applyOnLoad failed for ${s.key}:`, (e && e.message) || e);
    }
  }
  return failed;
}

/**
 * The company settings could not be read — tell the hooks THAT, rather than
 * handing them the defaults.
 *
 * ⛔ THE FAIL-CLOSED HALF. The store's own posture is "fail to OUR behaviour":
 * the caller still gets a complete settings object built from the declared
 * defaults, which is right for a value with a sensible default. It is exactly
 * wrong for a value whose empty state means "protect fewer things" — pushing
 * the default there would let a database blip REMOVE a rule-10 protection. A
 * declaration that owns such a value says so with `applyOnUnreadable`, and
 * keeps whatever it already had.
 */
function applyUnreadable(base, scope = DEFAULT_SCOPE) {
  if (String(scope) !== DEFAULT_SCOPE) return [];
  const failed = [];
  for (const s of decl.SETTINGS) {
    if (!s) continue;
    if (typeof s.applyOnUnreadable === 'function') {
      try {
        s.applyOnUnreadable();
      } catch (e) {
        failed.push(s.key);
        console.error(`[lt-settings] applyOnUnreadable failed for ${s.key}:`, (e && e.message) || e);
      }
      continue;
    }
    // ⛔ A DECLARATION THAT ONLY SAYS `applyOnLoad` IS STILL APPLIED, with the
    // declared default, exactly as it was before an outage path existed — and it
    // SAYS SO. The alternative is the trap this branch was written to avoid: the
    // next declaration to add a load hook without an outage hook would silently
    // stop being applied during an outage, and nothing anywhere would mention it.
    // Whether the default is the right answer during an outage is a decision only
    // the declaration can make; not making it is not the same as choosing.
    if (typeof s.applyOnLoad !== 'function') continue;
    if (!WARNED_NO_UNREADABLE.has(s.key)) {
      WARNED_NO_UNREADABLE.add(s.key);
      console.warn(`[lt-settings] ${s.key} has applyOnLoad but no applyOnUnreadable — `
        + 'applying the DECLARED DEFAULT while the store is unreadable. If that is wrong for this '
        + 'setting (it is for anything whose empty state means "protect less"), declare applyOnUnreadable.');
    }
    try {
      s.applyOnLoad(base[s.key]);
    } catch (e) {
      failed.push(s.key);
      console.error(`[lt-settings] applyOnLoad (degraded) failed for ${s.key}:`, (e && e.message) || e);
    }
  }
  return failed;
}
const WARNED_NO_UNREADABLE = new Set();

/**
 * Save a patch. Refuses the whole patch if ANY key is unknown — a partial save
 * on a form the user filled in once would leave them unable to tell what applied.
 *
 * A value equal to the declared default is DELETED rather than stored, so the
 * table only ever holds genuine deviations and "what has this lender changed?"
 * has an honest answer.
 *
 * `keepDefault: true` turns that off, and there is exactly one shape of caller that
 * needs it: a PER-USER scope layered over a company one. There, "this person chose
 * X" and "this person has never chosen" are different facts, and collapsing them
 * loses a real choice — a lender whose company default is the long-term side would
 * otherwise silently override the one person who deliberately chose RTL, because
 * RTL is also the DECLARED default and their row would have been deleted. The
 * company scope must never pass it: there, storing a value equal to the default is
 * exactly the junk this rule exists to keep out.
 */
async function save(patch, { scope = DEFAULT_SCOPE, staffId = null, keepDefault = false } = {}) {
  const { ok, clean, rejected, problems } = validate(patch);
  if (!ok) {
    const err = new Error(rejected.length
      ? `unknown setting key(s): ${rejected.join(', ')}`
      : `setting refused: ${problems.map((p) => p.setting).join(', ')}`);
    err.status = 400;
    err.rejected = rejected;
    // WHAT WAS WRONG, not just THAT it was wrong. A map refused for a name
    // collision has to be able to say which name — the person is looking at a
    // form, not a log.
    err.problems = problems;
    throw err;
  }

  const base = defaults();
  const written = [];
  const cleared = [];

  const client = await lazyDb().getClient();
  try {
    await client.query('BEGIN');
    for (const [k, v] of Object.entries(clean)) {
      const isDefault = !keepDefault && JSON.stringify(v) === JSON.stringify(base[k]);
      if (isDefault) {
        await client.query('DELETE FROM lt_settings WHERE scope = $1 AND key = $2', [scope, k]);
        cleared.push(k);
        continue;
      }
      await client.query(
        `INSERT INTO lt_settings (scope, key, value, updated_by, updated_at)
              VALUES ($1, $2, $3::jsonb, $4, now())
         ON CONFLICT (scope, key)
           DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
        [scope, k, JSON.stringify(v), staffId],
      );
      written.push(k);
    }
    await client.query('COMMIT');
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) { /* the original error is the one that matters */ }
    throw e;
  } finally {
    client.release();
  }

  cache.delete(scope);
  // A WRITE MUST REACH THE HOOKS TOO, and immediately — the whole point of
  // `applyOnLoad` on the investors-added-by-hand map is that the audience block
  // knows the new spellings before the next quote is drawn, not a cache TTL
  // later. A CLEARED key goes back to its declared default, which is the value
  // that now applies.
  const base2 = defaults();
  const applied = {};
  for (const k of written) applied[k] = clean[k];
  for (const k of cleared) applied[k] = base2[k];
  const hooksFailed = applyHooks(applied, new Set([...written, ...cleared]), scope);

  return { written, cleared, hooksFailed };
}

/**
 * Read the company settings once, so whatever the declarations push is in force.
 *
 * ⛔ WHY THIS EXISTS. The investor-name block is fed by `applyOnLoad`, and the
 * surfaces that most need it — a borrower's conditions, the term-sheet snapshot
 * and the PDF — never read settings at all. Nothing warmed the map, so the FIRST
 * borrower to open their conditions after a deploy was read to from a block that
 * had never been told about the investors somebody added by hand.
 *
 * Never throws. Answers whether the read was CLEAN, which is what the retry
 * loop needs: a degraded read is not a warm, it is a cache entry full of
 * declared defaults with a flag on it.
 */
async function warm(scope = DEFAULT_SCOPE) {
  try {
    const r = await load(scope, { fresh: true });
    return { ok: !r.degraded, degraded: !!r.degraded };
  } catch (e) {
    console.error('[lt-settings] warm failed:', (e && e.message) || e);
    return { ok: false, degraded: true };
  }
}

let KEEP = null;

/**
 * KEEP the company settings warm: retry until the first clean read, then re-read
 * on an interval.
 *
 * ⛔ THE TWO THINGS THIS FIXES, both measured on the previous cut.
 *
 * ONE — a single fire-and-forget warm at boot is a RACE and a DEAD END. The
 * require returned and the read landed ~28ms later, with `app.listen()` in
 * between, so a request in that window was served by a cold block; and if that
 * one read came back degraded it gave up, the degraded entry was cached for the
 * full TTL, and — because the borrower-facing surfaces never read settings —
 * the block could stay cold indefinitely on borrower-only traffic. Retrying
 * with backoff until a CLEAN read bounds that to the retry interval instead of
 * "forever", and `ensureWarm` closes the race for anything served through a
 * Long-Term router.
 *
 * TWO — it bounds the CROSS-PROCESS window. A save applies at once in the
 * process that made it; every other process learns on its next company read.
 * Left to the cache TTL that was up to `LT_SETTINGS_TTL_MS` (60s), and it is a
 * real rule-10 exposure for that whole time: a process whose cache predates the
 * save does not recognise the new investor's name, so a staff-typed condition
 * naming it is served to a borrower unredacted. The steady interval here is the
 * bound, and it is deliberately shorter than the TTL. It costs one small query
 * per process per interval.
 *
 * The timer is `unref`'d: it must never hold a process open, least of all a test
 * runner's.
 */
function keepWarm(opts = {}) {
  if (KEEP) return KEEP;
  const steady = Number(opts.intervalMs || process.env.LT_SETTINGS_REFRESH_MS || 15000);
  const first = Number(opts.retryMs || 250);
  const maxRetry = Number(opts.maxRetryMs || 10000);
  let retry = first;
  let timer = null;
  let stopped = false;
  let settle;
  const ready = new Promise((r) => { settle = r; });

  const arm = (ms) => {
    if (stopped) return;
    timer = setTimeout(tick, ms);
    if (timer && typeof timer.unref === 'function') timer.unref();
  };

  async function tick() {
    if (stopped) return;
    const r = await warm();
    if (r.ok) {
      retry = first;
      settle(true);
      arm(steady);
      return;
    }
    // Backoff, capped: a store that is down should not be asked ten times a
    // second, and must still be asked again.
    retry = Math.min(retry * 2, maxRetry);
    arm(retry);
  }

  tick();
  KEEP = {
    ready,
    stop() { stopped = true; if (timer) clearTimeout(timer); KEEP = null; },
  };
  return KEEP;
}

/**
 * Express middleware: make sure the company settings have been read — and their
 * declarations applied — before this request is served.
 *
 * This is what makes "before any request" true rather than aspirational.
 *
 * ⛔ IT ASKS ABOUT THE STATE, NOT THE HISTORY, and it does so on EVERY request.
 * An earlier version skipped once any company read had ever succeeded, which is
 * a fact about the past and not about what is in force now. What this costs on a
 * warm cache is a `Date.now()` comparison plus the cache-hit re-assertion — a
 * JSON identity check over a map of a handful of entries — and NOT, as this
 * comment once claimed, "one boolean": the body calls `load` every time, and a
 * doc that describes a cheaper function than the one below is how the next
 * person budgets wrongly. The cold path is the one that actually waits, once.
 *
 * It never fails a request: a read that will not work leaves the handler to run
 * exactly as it would have.
 *
 * The returned function is NAMED because a test asserts it is the FIRST layer on
 * the routers that need it. A grep for the call site cannot do that — the
 * comment explaining the call site satisfies the grep — and a guard mounted
 * second is a guard that does not run for the route mounted first.
 */
function ensureWarm() {
  return function ltSettingsEnsureWarm(req, res, next) {
    load(DEFAULT_SCOPE).then(() => next(), () => next());
  };
}

/** Drop the cache. Exposed for tests and for an admin "reload settings" action. */
function bust(scope = null) {
  if (scope) {
    const key = String(scope);
    cache.delete(key);
    generation.set(key, genOf(key) + 1);
    return;
  }
  cache.clear();
  for (const key of new Set([...generation.keys(), DEFAULT_SCOPE])) generation.set(key, genOf(key) + 1);
}

/**
 * Everything a settings SCREEN needs in one object: the groups, each setting's
 * declaration, its default, its effective value, and whether it has been changed
 * from ours. A generic renderer can draw the whole screen from this, so adding a
 * setting server-side makes it appear with no front-end change.
 */
async function describe(scope = DEFAULT_SCOPE) {
  const { settings, degraded } = await load(scope);
  const base = defaults();
  // decl.groups() returns an OBJECT keyed by group name -> array of declarations.
  const groups = Object.entries(decl.groups()).map(([name, list]) => ({
    group: name,
    settings: list.map(({ validate: _v, applyOnLoad: _a, ...s }) => ({
      // A declaration's own door and load hook are FUNCTIONS — machinery, not
      // anything a settings screen can draw. They are dropped here rather than
      // left to JSON.stringify, so the object this returns is the object the
      // screen receives.
      ...s,
      value: settings[s.key],
      default: base[s.key],
      isOverridden: JSON.stringify(settings[s.key]) !== JSON.stringify(base[s.key]),
    })),
  }));
  return { scope, groups, degraded };
}

/**
 * ONE setting off an ALREADY-LOADED scope, with the caller's fallback when nothing
 * is stored.
 *
 * `load()` returns the whole scope, so most readers want one key off the object
 * they already have rather than another round trip — and every one of them has to
 * make the same judgement: a stored empty string means "nothing is set" here, not
 * "set to blank", because that is what an admin clearing a text box produces.
 * Written once so the term-sheet route and `termsheet/deliver.js` cannot answer
 * that question two different ways about the same key: the layout options a PDF is
 * built from are read here, and the download and the emailed copy must be the same
 * document down to the expiry line.
 */
function pick(loaded, key, fallback) {
  const v = loaded && loaded.settings ? loaded.settings[key] : undefined;
  return v === undefined || v === null || v === '' ? fallback : v;
}

module.exports = {
  DEFAULT_SCOPE,
  isKnown,
  defaults,
  pick,
  load,
  get,
  validate,
  save,
  bust,
  describe,
  applyHooks,
  applyUnreadable,
  warm,
  keepWarm,
  ensureWarm,
};
