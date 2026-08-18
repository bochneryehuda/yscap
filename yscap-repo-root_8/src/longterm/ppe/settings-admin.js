'use strict';
/**
 * LT PPE — the AUDITED WRITE DOOR for the settings registry.
 *
 * WHY THIS MODULE EXISTS. `store.setSetting` / `store.clearSetting` have existed since
 * db/558 and, measured on 2026-08-18 across the whole of `src/`, had NO CALLER: the only
 * callers anywhere were two test scripts, and the router published `GET /api/lt/ppe/settings`
 * with no write route at all. So every parity tolerance, the rounding mode, the price floor
 * and the per-investor margin/holdback were read-only in practice and could only be changed
 * by hand in the database — where the change is unvalidated, unattributed and unrecorded.
 * This is the door, and it is the ONLY place a human's change goes through.
 *
 * FOUR THINGS IT DOES THAT THE PRIMITIVE DOES NOT, and each is the reason it is a separate
 * module rather than a fifth argument on `setSetting`:
 *
 *   1. IT DECIDES THE SLOT FROM AN EXPLICIT TARGET, and never from a scope string a caller
 *      built. `investor:<code>` is produced by `store.investorScope` and nowhere else.
 *   2. IT VALIDATES THE WHOLE BATCH BEFORE WRITING ANYTHING, so a request naming one bad key
 *      never half-applies. "It looked saved and it was not" is the worst outcome available
 *      here, and a partial apply is exactly that wearing a 200.
 *   3. IT READS THE BEFORE-STATE, so the audit row can say what the number changed FROM and
 *      whether that was a human's value or the shipped default — two different facts.
 *   4. IT WRITES THE CHANGE AND THE AUDIT ROW IN ONE TRANSACTION. A change that cannot be
 *      recorded is rolled back rather than committed silently.
 *
 * THE TYPED REGISTRY IS THE ONLY LIST. Every key, type, range, option set and default comes
 * from `settings.js`; there is no second list of keys here, and an unknown key is REFUSED
 * AND NAMED rather than dropped. Which keys are per-investor comes from the same place
 * (`settings.investorScopedKeys`) — see the note beside the `perInvestor` flags.
 *
 * PURE / IO SPLIT: everything above the divider is pure (no db, no network) and unit-tested
 * offline; the IO half is a thin reader/writer on top. LT-only. No RTL imports.
 */
const settings = require('./settings');
const store = require('./store');

const COMPANY_SCOPE = 'company';

// ---------------------------------------------------------------------------
// pure — the target, the checks, the plan
// ---------------------------------------------------------------------------

/**
 * Read the SLOT a request is aimed at. The caller states it in words and NEVER hands us a
 * scope string:
 *
 *   { target: 'company' }                       → the global slot
 *   { target: 'investor', investor: 'DHVN' }    → that investor's own slot
 *
 * WHY IT IS THIS SHAPE. A per-investor value landing in the global slot changes the price
 * for EVERY investor, and a scope string built by hand is one typo away from doing exactly
 * that with a 200 in front of it. So:
 *   · `target` is REQUIRED — there is no default, and a request that does not say which
 *     slot it means is refused rather than assumed to mean the global one.
 *   · a raw `scope` on the request is REFUSED OUTRIGHT, even when it happens to be spelled
 *     correctly. The prefix is attached in exactly one function (`store.investorScope`),
 *     which is what makes the shape of every stored scope guaranteed rather than hoped for.
 *   · a request that NAMES AN INVESTOR while asking for the global slot is CONTRADICTORY
 *     and is refused. It is not a puzzle to solve by picking one half — the caller means
 *     one of two very different things and only they know which.
 *
 * Returns { ok:true, kind, scope, investorCode } or { ok:false, error, message }.
 */
function parseTarget(body = {}) {
  const b = body || {};
  if (b.scope !== undefined) {
    return {
      ok: false,
      error: 'scope_not_accepted',
      message: 'Do not send a scope. Send target:"company", target:"investor" with the investor code, or target:"officer" with the officer id.',
    };
  }
  const target = b.target === undefined || b.target === null ? '' : String(b.target).trim();
  if (!target) {
    return {
      ok: false,
      error: 'target_required',
      message: 'Say which settings these are: target:"company" for the company-wide value, or target:"investor" with an investor code.',
    };
  }
  const investorRaw = b.investor === undefined || b.investor === null ? '' : String(b.investor).trim();
  const officerRaw = b.officer === undefined || b.officer === null ? '' : String(b.officer).trim();

  if (target === 'company') {
    if (officerRaw) {
      return {
        ok: false,
        error: 'officer_with_company_target',
        message: `This asks for the company-wide value but names a loan officer. Those are different slots — send target:"officer" to set it for that officer only.`,
      };
    }
    if (investorRaw) {
      return {
        ok: false,
        error: 'investor_with_company_target',
        message: `This asks for the company-wide value but names investor "${investorRaw}". Those are different slots — send target:"investor" to set it for that investor only.`,
      };
    }
    return { ok: true, kind: 'company', scope: COMPANY_SCOPE, investorCode: null };
  }

  if (target === 'officer') {
    if (!officerRaw) {
      return { ok: false, error: 'officer_required', message: 'Name the loan officer these settings are for.' };
    }
    const scope = store.officerScope(officerRaw);
    if (!scope) {
      return {
        ok: false,
        error: `bad_officer_id:${officerRaw}`,
        message: `"${officerRaw}" is not a loan officer id.`,
      };
    }
    return { ok: true, kind: 'officer', scope, investorCode: null, officerId: officerRaw.toLowerCase() };
  }

  if (target === 'investor') {
    if (!investorRaw) {
      return { ok: false, error: 'investor_required', message: 'Name the investor these settings are for.' };
    }
    const scope = store.investorScope(investorRaw);
    if (!scope) {
      return {
        ok: false,
        error: `bad_investor_code:${investorRaw}`,
        message: `"${investorRaw}" is not a usable investor code. Use letters, digits, dashes and underscores.`,
      };
    }
    return { ok: true, kind: 'investor', scope, investorCode: investorRaw };
  }

  return {
    ok: false,
    error: `unknown_target:${target}`,
    message: `Unknown target "${target}". Use "company", "investor" or "officer".`,
  };
}

/**
 * May this key be written at this kind of slot? Returns null when it may, else a refusal
 * naming the key.
 *
 * A key with no definition is refused WHEREVER it is aimed — the registry is the only list
 * of what is configurable, so a key that is not in it is not a setting.
 *
 * A key the registry does NOT declare `perInvestor` is refused at an investor slot, and the
 * refusal says why in plain words: nothing reads such a row (the only investor-scope reader
 * in the codebase filters the layer through the same declaration), so storing it would
 * produce a value that looks saved, is saved, and changes nothing. The company slot accepts
 * every key including the per-investor ones — that is the pre-fill every investor inherits.
 */
function checkKeyForTarget(kind, key) {
  const def = settings.getDefinition(key);
  if (!def) {
    return {
      key,
      error: `unknown_setting:${key}`,
      message: `"${key}" is not a setting this engine has. Nothing was saved.`,
    };
  }
  if (kind === 'officer' && def.perOfficer !== true) {
    return {
      key,
      error: `not_per_officer:${key}`,
      message: `"${def.label || key}" is a company-wide setting — a loan officer cannot set it. Per-officer settings: ${settings.officerScopedKeys().join(', ')}.`,
    };
  }
  if (kind === 'investor' && def.perInvestor !== true) {
    return {
      key,
      error: `not_per_investor:${key}`,
      message: `"${def.label || key}" is a company-wide setting — it cannot be set for one investor. Per-investor settings: ${settings.investorScopedKeys().join(', ')}.`,
    };
  }
  return null;
}

/**
 * Turn a { key: value } patch into a plan, or refuse the WHOLE patch.
 *
 * ALL-OR-NOTHING ON PURPOSE. A patch carrying one bad key is refused entirely and every
 * refusal is listed by key, so the answer is actionable and nothing is half-applied. A
 * partial apply behind a 200 is the failure this whole surface exists to prevent.
 */
function planSet(kind, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    return { ok: false, refusals: [{ error: 'bad_settings_object', message: 'Send the changes as an object of setting keys.' }] };
  }
  const keys = Object.keys(patch);
  if (!keys.length) {
    return { ok: false, refusals: [{ error: 'no_settings', message: 'Nothing to save — no settings were sent.' }] };
  }
  const refusals = [];
  const changes = [];
  for (const key of keys) {
    const scopeProblem = checkKeyForTarget(kind, key);
    if (scopeProblem) { refusals.push(scopeProblem); continue; }
    const value = patch[key];
    const v = settings.validateValue(key, value);
    if (!v.ok) {
      const def = settings.getDefinition(key);
      refusals.push({ key, error: v.error, message: valueRefusalMessage(def, key, value, v.error) });
      continue;
    }
    changes.push({ key, value });
  }
  if (refusals.length) return { ok: false, refusals };
  return { ok: true, changes };
}

/** Turn a list of keys to clear into a plan, or refuse the whole list. */
function planClear(kind, keys) {
  if (!Array.isArray(keys) || !keys.length) {
    return { ok: false, refusals: [{ error: 'no_keys', message: 'Name the settings to put back to the default.' }] };
  }
  const refusals = [];
  const out = [];
  for (const raw of keys) {
    const key = String(raw == null ? '' : raw);
    const problem = checkKeyForTarget(kind, key);
    if (problem) { refusals.push(problem); continue; }
    out.push(key);
  }
  if (refusals.length) return { ok: false, refusals };
  return { ok: true, keys: out };
}

/**
 * Plain-language wording for a value refusal. The registry's own error codes are precise
 * and unreadable (`above_max:pricing.price_floor_milli:900000>200000`); both go back, the
 * code for a machine and this for the person who typed the number.
 */
function valueRefusalMessage(def, key, value, code) {
  const name = (def && def.label) || key;
  const shown = typeof value === 'object' ? JSON.stringify(value) : String(value);
  if (!def) return `"${key}" is not a setting this engine has.`;
  if (code.startsWith('not_in_options')) return `${name} must be one of: ${def.options.join(', ')}. "${shown}" is not.`;
  if (code.startsWith('not_a_number')) return `${name} must be a number. "${shown}" is not.`;
  if (code.startsWith('not_an_integer')) return `${name} must be a whole number. "${shown}" is not.`;
  if (code.startsWith('below_min')) return `${name} cannot be below ${def.min}. You sent ${shown}.`;
  if (code.startsWith('above_max')) return `${name} cannot be above ${def.max}. You sent ${shown}.`;
  if (code.startsWith('not_a_boolean')) return `${name} must be true or false. "${shown}" is not.`;
  if (code.startsWith('not_a_string')) return `${name} must be text.`;
  if (code.startsWith('too_long')) return `${name} is too long (max ${def.maxLength} characters).`;
  if (code.startsWith('not_json')) return `${name} must be a list or an object.`;
  if (code.startsWith('bad_item_type')) return `Every entry in ${name} must be a ${def.itemType}.`;
  if (code.startsWith('null_not_allowed')) return `${name} cannot be left blank.`;
  return `${name} was refused (${code}).`;
}

/**
 * How a stored value and a resolved source read to a HUMAN. `settings.resolve` speaks in
 * layers (`tenant` / `org` / `product_default`) because it is a pure function that does not
 * know what the layers MEAN here; this names them.
 */
function layerName(kind, source) {
  if (source === 'product_default') return 'product_default';
  if (kind === 'investor') return source === 'tenant' ? 'investor' : 'company';
  if (kind === 'officer') return source === 'tenant' ? 'officer' : 'company';
  return 'company';
}

// ---------------------------------------------------------------------------
// IO — read the state, apply a change, record it
// ---------------------------------------------------------------------------

/**
 * The full state of one slot: every declared setting, the value in force, WHERE that value
 * came from, and — separately — whether a human set it HERE.
 *
 * "which values are defaults and which a human set" are TWO facts and both are reported.
 * `source` says which layer won (`product_default` | `company` | `investor`); `isDefault`
 * is the plain reading of that; `setHere` says whether a row exists at THIS slot, with who
 * and when. They can disagree honestly: an investor slot can hold a value while the company
 * value is what is in force for a key the investor has not overridden.
 *
 * Degrades the way the rest of this engine does: an unreadable override table resolves to
 * the coded defaults and SAYS the values are a fallback rather than presenting them as the
 * tenant's configuration.
 */
async function describe(db, target) {
  const companyOverrides = await store.loadSettingOverrides(db, COMPANY_SCOPE);
  let layers;
  let hereRows = {};

  // A NON-COMPANY SLOT IS READ THE SAME WAY WHOEVER IT BELONGS TO — the only difference is which
  // declaration says a key may live there, and that comes from the registry rather than from a second
  // list here. Adding a third kind of slot is one entry.
  const SLOT_FILTER = { investor: settings.isInvestorScoped, officer: settings.isOfficerScoped };
  if (SLOT_FILTER[target.kind]) {
    const raw = await store.loadSettingOverrides(db, target.scope);
    const filtered = {};
    for (const k of Object.keys(raw)) if (SLOT_FILTER[target.kind](k)) filtered[k] = raw[k];
    layers = { tenant: filtered, org: companyOverrides };
    hereRows = await loadRows(db, target.scope);
  } else {
    layers = { tenant: companyOverrides };
    hereRows = await loadRows(db, COMPANY_SCOPE);
  }

  const company = settings.resolveAll({ tenant: companyOverrides });
  const rows = settings.allDefinitions().map((def) => {
    const r = settings.resolve(def.key, layers);
    const source = layerName(target.kind, r.source);
    const settable = target.kind === 'company'
      || (target.kind === 'investor' && def.perInvestor === true)
      || (target.kind === 'officer' && def.perOfficer === true);
    const storedRaw = hereRows[def.key] || null;
    // A row at this slot for a key that is NOT settable here is a row NOTHING READS — the
    // door refuses to write one and the resolver filters it out. Reporting it as "set here"
    // would tell a human a value is in force that is not. It is reported as IGNORED instead,
    // which is the true and useful thing to say: never silently, and never as a live value.
    const stored = settable ? storedRaw : null;
    return {
      key: def.key,
      label: def.label || def.key,
      group: def.group || 'Other',
      help: def.help || '',
      type: def.type,
      options: def.options || null,
      min: def.min == null ? null : def.min,
      max: def.max == null ? null : def.max,
      integer: def.integer === true,
      nullable: def.nullable === true,
      itemType: def.itemType || null,
      perInvestor: def.perInvestor === true,
      perOfficer: def.perOfficer === true,
      // settable AT THIS SLOT. A company-wide setting shown on an investor screen is
      // read-only there, and the screen says so rather than offering a control the
      // server would refuse.
      settable,
      // the value in force at this slot, and where it came from
      value: r.value,
      source,
      isDefault: source === 'product_default',
      // the shipped default, always, so a screen can offer "put it back"
      default: def.default === undefined ? null : def.default,
      // did a human set it AT THIS SLOT (a different question from `source`)
      setHere: !!stored,
      setBy: stored ? stored.updated_by : null,
      setAt: stored ? stored.updated_at : null,
      // a stored row at this slot that nothing reads (see above) — normally false
      ignoredHere: !settable && !!storedRaw,
      // what an investor slot falls back TO, so the screen can show both numbers
      companyValue: target.kind === 'company' ? undefined : company.values[def.key],
      companySource: target.kind === 'company' ? undefined : layerName('company', company.sources[def.key]),
    };
  });

  return {
    target: {
      kind: target.kind, investor: target.investorCode || null,
      officer: target.officerId || null, scope: target.scope,
    },
    investorScopedKeys: settings.investorScopedKeys(),
    officerScopedKeys: settings.officerScopedKeys(),
    settings: rows,
  };
}

/** Stored override rows at ONE scope, as { key: row }. Never throws. */
async function loadRows(db, scope) {
  try {
    const r = await db.query(
      'SELECT key, value, updated_by, updated_at FROM lt_ppe_setting_value WHERE scope = $1', [scope]);
    const out = {};
    for (const row of r.rows || []) out[row.key] = row;
    return out;
  } catch (_e) {
    return {};
  }
}

/**
 * Apply a validated plan (a set, a clear, or both) and record one audit row per change,
 * in ONE transaction.
 *
 * A CHANGE THAT MOVES NOTHING WRITES NOTHING. Sending a setting the value it already holds,
 * or clearing one that is not set, is a no-op reported as `unchanged` rather than an audit
 * row claiming a change — a trail padded with non-events is a trail nobody reads.
 *
 * THE AUDIT ROW CARRIES BOTH HALVES OF BOTH ENDS: the value before and the value after, and
 * for each of them whether it was a human's stored override or the shipped default. On a
 * clear, `to_value` is the default the setting fell back TO, recorded rather than derived,
 * because the coded default can change in a later release and the record must still say what
 * the number actually became on the day.
 */
async function apply(db, { target, changes = [], clears = [], actor = {} }) {
  const client = await (typeof db.getClient === 'function' ? db.getClient() : db.connect());
  const applied = [];
  try {
    await client.query('BEGIN');

    for (const ch of changes) {
      const before = await store.readStoredSetting(client, target.scope, ch.key);
      const def = settings.getDefinition(ch.key);
      const beforeValue = before ? before.value : def.default;
      const beforeSource = before ? 'stored' : 'product_default';

      if (before && sameValue(before.value, ch.value)) {
        applied.push({ key: ch.key, action: 'set', changed: false, value: ch.value, reason: 'unchanged' });
        continue;
      }
      if (!before && sameValue(def.default, ch.value)) {
        // Setting a key to exactly its default while nothing is stored: the caller means
        // "the default", which is already what is in force. Nothing is stored, so the
        // setting keeps FOLLOWING the default rather than being pinned to today's value.
        applied.push({ key: ch.key, action: 'set', changed: false, value: ch.value, reason: 'already_default' });
        continue;
      }

      const w = await store.setSetting(client, target.scope, ch.key, ch.value, actor.id || null);
      if (!w.ok) throw new Error(`setting_write_refused:${w.error}`);
      await store.appendSettingAudit(client, {
        scope: target.scope,
        key: ch.key,
        action: 'set',
        fromValue: beforeValue,
        fromSource: beforeSource,
        toValue: ch.value,
        toSource: 'stored',
        actorId: actor.id || null,
        actorLabel: actor.label || null,
      });
      applied.push({ key: ch.key, action: 'set', changed: true, from: beforeValue, fromSource: beforeSource, value: ch.value });
    }

    for (const key of clears) {
      const before = await store.readStoredSetting(client, target.scope, key);
      if (!before) {
        applied.push({ key, action: 'clear', changed: false, reason: 'not_set' });
        continue;
      }
      const def = settings.getDefinition(key);
      await store.clearSetting(client, target.scope, key);
      await store.appendSettingAudit(client, {
        scope: target.scope,
        key,
        action: 'clear',
        fromValue: before.value,
        fromSource: 'stored',
        toValue: def.default === undefined ? null : def.default,
        toSource: 'product_default',
        actorId: actor.id || null,
        actorLabel: actor.label || null,
      });
      applied.push({ key, action: 'clear', changed: true, from: before.value, value: def.default === undefined ? null : def.default });
    }

    await client.query('COMMIT');
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) { /* the original error is the one that matters */ }
    throw e;
  } finally {
    client.release();
  }
  return { applied };
}

/**
 * Do two setting values MEAN the same thing? A jsonb round-trip is stable for the shapes
 * this registry holds (numbers, booleans, strings, arrays, plain objects), so comparing the
 * serialized forms is exact for every declared type and cannot fall for `0 == false`.
 */
function sameValue(a, b) {
  try { return JSON.stringify(a === undefined ? null : a) === JSON.stringify(b === undefined ? null : b); } catch (_e) { return false; }
}

module.exports = {
  COMPANY_SCOPE,
  parseTarget, checkKeyForTarget, planSet, planClear, valueRefusalMessage, layerName, sameValue,
  describe, apply,
};
