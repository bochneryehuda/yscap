'use strict';
/**
 * PROGRAM AVAILABILITY — turn a pricing program ON or OFF company-wide, with a
 * per-file super-admin exception (owner-directed 2026-08-18, in their own words:
 * "we should have the option to turn on and turn off certain programs … right
 * now we're discontinuing the gold program … the super admin in the manual
 * section should be able to say, hey, for this particular transaction, we're
 * turning on the gold program for stuff that's already in process … On the term
 * sheet generated products and pricing, that entire box of the gold program
 * should disappear … Pre-fill the saying that the gold program is discontinued
 * … leave it in a setting where we can, any time, turn off and turn on any
 * program").
 *
 * THE ONE DEFINITION. Company switches live in
 * company_pricing_settings.program_availability (db/582), read through
 * pricing-settings; per-file exceptions live in applications.program_exceptions
 * (db/582), written only by the super-admin-gated endpoint in routes/staff.js.
 * Every consumer — the six register doors, the pricing GET payloads, the
 * Pricing Admin Center, the Term Sheet Studio's program cards and the public
 * /api/pricing-defaults — asks THIS module. Never re-inline the rule.
 *
 * WHY THIS IS NOT A CHANGE TO ANY FROZEN ENGINE. Nothing here touches a number,
 * a formula, a cap or an engine input: a discontinued program still PRICES
 * byte-identically wherever it is quoted (quotes persist nothing). What is
 * gated is whether that program may be OFFERED on the Products & Pricing cards
 * and whether a REGISTRATION into it is accepted — the same layered-on-top
 * shape as lib/vesting-program-rule.js, whose programKey this module reuses so
 * "which program is this?" keeps one answer.
 *
 * FAIL DIRECTION, deliberate and asymmetric:
 *   - An UNKNOWN or blank program, and the MANUAL program, are never refused
 *     (manual is the admin-priced custom product with its own approval chain —
 *     it is the escape hatch, not a marketed program).
 *   - Unreadable settings read as "everything offered": this gate exists to
 *     stop NEW deals entering a discontinued program, and refusing every
 *     registration in the company over a settings hiccup would be the far more
 *     expensive failure. The doors pass the settings in, so a caller that DID
 *     read them gets the real answer.
 *
 * PURE — no database, no config, no IO. The only require is the (equally pure)
 * programKey normalizer, so this can be unit-tested exactly and can never throw
 * into a registration.
 */

const { programKey } = require('./vesting-program-rule');

// The three MARKETED pricing programs — the only ones an admin may switch off.
// 'manual' is deliberately absent: it is the admins' own custom-priced product
// (every manual registration already routes to approval) and switching it off
// would remove the exception path itself.
const PROGRAM_KEYS = ['standard', 'gold', 'silver'];
const PROGRAM_LABEL = { standard: 'Standard', gold: 'Gold Standard', silver: 'Silver' };

/** The pre-filled wording (owner: "Pre-fill the saying that the gold program is
 *  discontinued") — an admin may replace it per program in the Pricing Admin
 *  Center. Borrower-safe by construction: it names OUR program label, never a
 *  capital partner. */
function defaultDiscontinuedNote(prog) {
  const label = PROGRAM_LABEL[programKey(prog)] || 'This';
  return `The ${label} program has been discontinued and is not being offered on new deals right now.`;
}

/* Normalize the COMPANY jsonb (or an API body) into
 *   null | { gold: { active:false, note:'…' }, … }
 * Only recognized programs that are explicitly OFF are kept — "on" is the
 * default state and is never stored, so an unconfigured company (NULL column)
 * and a company with everything on are the same value: null. A note is kept
 * only when an admin typed one; readers fall back to defaultDiscontinuedNote. */
function cleanProgramAvailability(v) {
  let obj = v;
  if (typeof obj === 'string') { try { obj = JSON.parse(obj); } catch (_) { return null; } }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const out = {};
  for (const prog of PROGRAM_KEYS) {
    const src = obj[prog];
    if (!src || typeof src !== 'object') continue;
    if (src.active !== false) continue;              // only an explicit OFF is stored
    const row = { active: false };
    const note = String(src.note == null ? '' : src.note).trim().slice(0, 300);
    if (note) row.note = note;
    out[prog] = row;
  }
  return Object.keys(out).length ? out : null;
}

/* Normalize the PER-FILE jsonb into {} | { gold: { by, byName, at, reason } }.
 * Only recognized programs count; junk shapes read as "no exception" (an
 * exception must be provably a super-admin's recorded decision, never inferred
 * from a malformed blob). */
function cleanProgramExceptions(v) {
  let obj = v;
  if (typeof obj === 'string') { try { obj = JSON.parse(obj); } catch (_) { return {}; } }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return {};
  const out = {};
  for (const prog of PROGRAM_KEYS) {
    const src = obj[prog];
    if (!src || typeof src !== 'object') continue;
    out[prog] = {
      by: src.by ? String(src.by) : null,
      byName: String(src.byName == null ? '' : src.byName).trim().slice(0, 120) || null,
      at: src.at ? String(src.at) : null,
      reason: String(src.reason == null ? '' : src.reason).trim().slice(0, 500) || null,
    };
  }
  return out;
}

/** The file's recorded exception for a program, or null. `app` is an
 *  applications row (needs program_exceptions) or a plain object carrying it. */
function fileException(app, prog) {
  const key = programKey(prog);
  if (!key || !PROGRAM_KEYS.includes(key)) return null;
  const exc = cleanProgramExceptions(app && app.program_exceptions);
  return exc[key] || null;
}

/** Is this program switched ON company-wide? Unknown programs and 'manual'
 *  always read as active (they are not togglable). */
function programActive(prog, settings) {
  const key = programKey(prog);
  if (!key || !PROGRAM_KEYS.includes(key)) return true;
  const map = cleanProgramAvailability(settings && settings.programAvailability);
  if (!map) return true;
  const row = map[key];
  return !(row && row.active === false);
}

/** The discontinued wording for a program, or null while it is active. */
function discontinuedInfo(prog, settings) {
  const key = programKey(prog);
  if (!key || !PROGRAM_KEYS.includes(key)) return null;
  if (programActive(key, settings)) return null;
  const map = cleanProgramAvailability(settings && settings.programAvailability) || {};
  const row = map[key] || {};
  return { note: row.note || defaultDiscontinuedNote(key) };
}

/** May this program be offered / registered on this file? Active company-wide,
 *  OR discontinued but carrying this file's recorded exception. */
function programOffered(prog, settings, app) {
  const key = programKey(prog);
  if (!key || !PROGRAM_KEYS.includes(key)) return true;
  if (programActive(key, settings)) return true;
  return !!fileException(app, key);
}

/**
 * Should this registration be refused? PURE — returns a plain reason string, or
 * null when there is nothing to refuse. Called at EVERY register door (staff,
 * borrower, TPO, accept-counter, the term-sheet-offer auto-register and the
 * intake auto-register), exactly like vesting-program-rule.registrationRefusal.
 *
 * @param program  the program being registered (the RESOLVED program — a manual
 *                 product passes 'manual' and is never refused here)
 * @param app      the applications row (needs program_exceptions)
 * @param settings the company pricing settings (pricing-settings load()/current())
 */
function registrationRefusal(program, app, settings) {
  const key = programKey(program);
  if (!key || !PROGRAM_KEYS.includes(key)) return null;
  if (programOffered(key, settings, app)) return null;
  const info = discontinuedInfo(key, settings) || { note: defaultDiscontinuedNote(key) };
  return `${info.note} A super admin can turn the ${PROGRAM_LABEL[key]} program back on for this file only `
    + '(an exception for a deal already in process) from the file’s Products & Pricing panel — '
    + 'or price the deal on a different program.';
}

/**
 * The EFFECTIVE availability map a screen consumes — one row per program:
 *   { standard: { key, label, active, offered }, gold: { …, note, exception } }
 * `active`   — the company switch; `offered` — active OR this file's exception;
 * `note`     — the discontinued wording (only while active === false);
 * `exception`— the file's recorded exception (only when app was given + one
 *              exists). With no `app`, `offered` simply mirrors `active` — the
 *              shape the public /api/pricing-defaults and the standalone
 *              marketing tool use.
 */
function availabilityFor(settings, app) {
  const out = {};
  for (const key of PROGRAM_KEYS) {
    const active = programActive(key, settings);
    const row = { key, label: PROGRAM_LABEL[key], active, offered: active };
    if (!active) {
      row.note = (discontinuedInfo(key, settings) || {}).note || defaultDiscontinuedNote(key);
      const exc = app ? fileException(app, key) : null;
      if (exc) { row.offered = true; row.exception = exc; }
    }
    out[key] = row;
  }
  return out;
}

/** True when at least one program is switched off company-wide — drives whether
 *  the per-file exception card renders at all. */
function anyDiscontinued(settings) {
  return PROGRAM_KEYS.some((k) => !programActive(k, settings));
}

module.exports = {
  PROGRAM_KEYS, PROGRAM_LABEL,
  defaultDiscontinuedNote, cleanProgramAvailability, cleanProgramExceptions,
  fileException, programActive, discontinuedInfo, programOffered,
  registrationRefusal, availabilityFor, anyDiscontinued,
};
