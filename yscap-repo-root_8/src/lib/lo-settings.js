'use strict';
/**
 * lo-settings.js — per-loan-officer BUSINESS settings (owner-directed
 * 2026-07-31). One jsonb bag per staffer (db/391), read/written through this
 * module only, with a hard key WHITELIST: an unknown key is refused, never
 * stored — so the bag can grow a setting at a time without ever becoming a
 * junk drawer. Defaults live here too, so a missing row/key always reads a
 * concrete value.
 *
 * Keys today:
 *   ccBorrowerOnTitleOrder     (bool, default false) — whether the officer's
 *     files CC the borrower on the TITLE order email by default.
 *   ccBorrowerOnInsuranceOrder (bool, default false) — same, for the INSURANCE
 *     order email (owner-directed 2026-08-05: the COMPANY default is now OFF for
 *     every order kind, so this is how an officer sets a default different from
 *     the company's — turning CC back ON for their own files).
 *   ccHelperOnTitleOrder       (bool, default false) — whether the officer's
 *     files CC the borrower's HELPER (the standing second login a borrower
 *     authorizes — `borrower_assistants`) on the TITLE order email by default.
 *   ccHelperOnInsuranceOrder   (bool, default false) — same, for the INSURANCE
 *     order email (owner-directed 2026-08-28: "you should also be able to have an
 *     option to CC the helper as well if there is a borrower helper on file").
 *     The helper's footing is its OWN question, never a rider on the borrower's —
 *     an officer may want the helper chasing the title company while the borrower
 *     stays off the chain.
 *   All four default OFF; each order can still flip them per file at place time,
 *   and a file with no helper on it has nothing to CC either way.
 *
 * Adding a setting = one entry in SETTINGS_KEYS + the UI row in
 * StaffSettings.jsx. Never bypass validate() on a write.
 */

const db = require('../db');

const SETTINGS_KEYS = Object.freeze({
  ccBorrowerOnTitleOrder: {
    type: 'bool',
    default: false,
    label: 'CC my borrowers on title order emails by default',
    help: 'Off (the default): the borrower is not looped into the title insurance order email. You can still turn it on for any single order when you place it.',
  },
  ccBorrowerOnInsuranceOrder: {
    type: 'bool',
    default: false,
    label: 'CC my borrowers on insurance order emails by default',
    help: 'Off (the default): the borrower is not looped into the insurance order email. You can still turn it on for any single order when you place it.',
  },
  ccHelperOnTitleOrder: {
    type: 'bool',
    default: false,
    label: 'CC my borrowers’ helpers on title order emails by default',
    help: 'Off (the default): the borrower’s helper is not looped into the title order email. This is a separate choice from CC’ing the borrower — you can copy the helper without copying the borrower, or the other way round. It only ever does anything on a file where the borrower has set a helper up.',
  },
  ccHelperOnInsuranceOrder: {
    type: 'bool',
    default: false,
    label: 'CC my borrowers’ helpers on insurance order emails by default',
    help: 'Off (the default): the borrower’s helper is not looped into the insurance order email. This is a separate choice from CC’ing the borrower, and it only ever does anything on a file where the borrower has set a helper up.',
  },
});

function coerce(spec, value) {
  if (spec.type === 'bool') {
    if (value === true || value === 'true' || value === 1 || value === '1') return true;
    if (value === false || value === 'false' || value === 0 || value === '0' || value == null) return false;
    return null; // unrecognized → refuse
  }
  return null;
}

/** Validate a patch {key: value}. Returns {ok, clean} or {ok:false, error}. */
function validate(patch) {
  const clean = {};
  for (const [k, v] of Object.entries(patch || {})) {
    const spec = SETTINGS_KEYS[k];
    if (!spec) return { ok: false, error: `Unknown setting “${k}”.` };
    const cv = coerce(spec, v);
    if (cv === null && spec.type === 'bool') return { ok: false, error: `Setting “${k}” must be on or off.` };
    clean[k] = cv;
  }
  return { ok: true, clean };
}

/** The staffer's settings, defaults filled in. Never throws (defaults on error). */
async function getSettings(staffId, client = db) {
  const out = {};
  for (const [k, spec] of Object.entries(SETTINGS_KEYS)) out[k] = spec.default;
  if (!staffId) return out;
  try {
    const r = await client.query(`SELECT settings FROM lo_settings WHERE staff_id=$1`, [staffId]);
    let s = r.rows[0] && r.rows[0].settings;
    if (typeof s === 'string') { try { s = JSON.parse(s); } catch (_) { s = null; } }
    if (s && typeof s === 'object') {
      for (const k of Object.keys(SETTINGS_KEYS)) {
        const cv = coerce(SETTINGS_KEYS[k], s[k]);
        if (s[k] != null && cv !== null) out[k] = cv;
      }
    }
  } catch (_) { /* defaults stand */ }
  return out;
}

/** Merge a validated patch into the staffer's bag (upsert). */
async function setSettings(staffId, patch, client = db) {
  const v = validate(patch);
  if (!v.ok) { const e = new Error(v.error); e.status = 400; throw e; }
  await client.query(
    `INSERT INTO lo_settings (staff_id, settings, updated_at)
     VALUES ($1, $2::jsonb, now())
     ON CONFLICT (staff_id) DO UPDATE
       SET settings = lo_settings.settings || EXCLUDED.settings, updated_at = now()`,
    [staffId, JSON.stringify(v.clean)]);
  return getSettings(staffId, client);
}

/** One key for one staffer (defaults when unset). */
async function getSetting(staffId, key, client = db) {
  const all = await getSettings(staffId, client);
  return all[key];
}

module.exports = { SETTINGS_KEYS, validate, getSettings, setSettings, getSetting };
