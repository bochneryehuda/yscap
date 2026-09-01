'use strict';
/**
 * LONG-TERM — the Pricing Engine's SAVED SCENARIOS (db/658, owner-directed
 * 2026-08-31; the research and the owner's six decisions are
 * `docs/longterm/SAVED-SCENARIOS-RESEARCH.md`).
 *
 * The owner: *"a new Scenario screen sharing the General Pricing Engine's
 * fields, plus optional property address / borrower name / entity name /
 * scenario name; a Save Scenario button; re-run anytime."*
 *
 * ⛔ A SAVED SCENARIO IS INPUTS. IT IS NOT A PRICE, AND EVERY RULE BELOW FOLLOWS
 * FROM THAT ONE SENTENCE. Rates move daily and the board is a live answer from
 * Lender Price, so a scenario re-run tomorrow is a DIFFERENT board — the same
 * question, a new answer. The most expensive mistake available in this feature
 * is to store a scenario in a way that lets somebody believe they saved a
 * price. PILOT already has the honest version of that and it is called a term
 * sheet: stamped, expiring, coded, and it says on its face when its pricing
 * dies.
 *
 * `savedBoard` is the ONE stored figure and it is a DATED HEADLINE (D4 — the
 * owner asked to be told what MOVED since a scenario was saved, and there has
 * to be something to compare against). It is never a quote, it is stored with
 * the moment it was true, and every surface that reads it must say so.
 *
 * ⛔ IT STORES THE FORM AS WELL AS THE SCENARIO, AND THAT IS NOT REDUNDANT.
 * `scenarioFields.toScenario` deliberately DROPS what was not typed — which is
 * what keeps the server the single authority on the third figure when somebody
 * types an LTV instead of a loan amount. A scenario that has been through that
 * filter therefore cannot restore the boxes: re-loading one would silently move
 * a person from LTV mode into loan mode and re-price a different deal. So
 * `form` is what was typed and `scenario` is what was sent, and the screen
 * re-derives the second from the first through that same one function.
 *
 * ⛔ IT HOLDS NO PRICING RULE AND ASKS NO VENDOR ANYTHING. This module stores
 * and lists. What a scenario MEANS is `scenarioFields.js` on the screen and
 * `search-model.js` on the server; the re-run calls the same
 * `/api/lt/dscr/price` door the pricing engine calls. A second pricing path
 * here would be a second answer to what a deal is.
 *
 * SEPARATION: reads and writes only `lt_pricer_scenarios` (plus the authorised
 * `staff_users` FK). No RTL table, no RTL import.
 */

const lazy = {
  get db() { return require('./db'); },
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** How much of a person's own typing we are willing to carry back to them. */
const MAX_NAME = 80;
const MAX_PARTY = 160;
/** A whole form is a few hundred bytes of short strings; this is a runaway
 *  guard, not a budget. A body larger than it is refused rather than truncated —
 *  half a scenario would re-price a different deal. */
const MAX_JSON_BYTES = 20000;

/** A name a person will recognise in a list, and nothing longer. */
function sanitizeName(v, max = MAX_NAME) {
  const s = String(v == null ? '' : v).trim().replace(/\s+/g, ' ');
  if (!s) return null;
  return s.slice(0, max);
}

/**
 * A plain object of scalars, or `{}`. Nothing here trusts the shape of what a
 * screen sent: the form is the vendor's question and it changes, so this stores
 * WHAT WAS TYPED without pretending to know which fields exist — but it refuses
 * anything that is not a flat bag of primitives, because a nested object here is
 * either a mistake or somebody storing something else in the scenario table.
 */
function sanitizeBag(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof k !== 'string' || !k || k.length > 60) continue;
    if (v === null) continue;
    const t = typeof v;
    if (t === 'string') { out[k] = v.slice(0, 200); continue; }
    if (t === 'number') { if (Number.isFinite(v)) out[k] = v; continue; }
    if (t === 'boolean') { out[k] = v; continue; }
    // Anything else — an object, an array, a function — is not a form field.
  }
  return out;
}

/**
 * THE DATED HEADLINE, and the reason it is a WHITELIST rather than "whatever the
 * screen sent". It is the one figure this table stores, so it is the one place
 * a saved price could creep in: an open bag would let a whole board be written
 * here and read back later as though it were still true. Four numbers and a
 * count, each of which is meaningless without the date beside it.
 */
function sanitizeBoard(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const num = (v) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : null);
  const out = {};
  const bestRate = num(raw.bestRate);
  const bestPrice = num(raw.bestPrice);
  const programs = num(raw.programs);
  const lenders = num(raw.lenders);
  if (bestRate != null) out.bestRate = bestRate;
  if (bestPrice != null) out.bestPrice = bestPrice;
  if (programs != null) out.programs = Math.max(0, Math.round(programs));
  if (lenders != null) out.lenders = Math.max(0, Math.round(lenders));
  return Object.keys(out).length ? out : null;
}

/**
 * THE NAME, WHEN NOBODY TYPED ONE (D6 — *"No — auto-named from the address or
 * the headline terms when blank"*). A required name is the field people abandon
 * a save on, and a list of "Untitled, Untitled, Untitled" is the same problem
 * one step later.
 *
 * The address first because it is what a person recognises; then the party;
 * then the headline terms, which are always available because the form always
 * holds them. NEVER a date alone — "31 August" tells a reader nothing about
 * which deal it was.
 */
function deriveName({ propertyAddress, borrowerName, entityName, form }) {
  const addr = sanitizeName(propertyAddress, MAX_PARTY);
  if (addr) return addr.slice(0, MAX_NAME);
  const who = sanitizeName(entityName, MAX_PARTY) || sanitizeName(borrowerName, MAX_PARTY);
  if (who) return who.slice(0, MAX_NAME);
  const f = form || {};
  const bits = [];
  const purpose = sanitizeName(f.purpose, 40);
  if (purpose) bits.push(purpose);
  const amount = String(f.loan == null ? '' : f.loan).trim();
  if (amount) bits.push(`$${amount}`);
  const ltv = String(f.ltv == null ? '' : f.ltv).trim();
  if (!amount && ltv) bits.push(`${ltv}% LTV`);
  const type = sanitizeName(f.propertyType, 40);
  if (type) bits.push(type);
  return bits.length ? bits.join(' · ').slice(0, MAX_NAME) : 'Untitled scenario';
}

/** Refuse a body too large to be a form, rather than storing half of one. */
function tooBig(...objs) {
  let n = 0;
  for (const o of objs) n += Buffer.byteLength(JSON.stringify(o || {}), 'utf8');
  return n > MAX_JSON_BYTES;
}

/** One row, as a screen reads it. */
function shape(r) {
  return {
    id: r.id,
    name: r.name,
    borrowerName: r.borrower_name || null,
    entityName: r.entity_name || null,
    propertyAddress: r.property_address || null,
    form: r.form || {},
    scenario: r.scenario || {},
    calc: r.calc || {},
    /* ⛔ THE HEADLINE NEVER TRAVELS WITHOUT ITS DATE. A figure with no "as at"
       beside it is exactly the saved price this feature must not become, so the
       two are one object and a board with no date is not returned at all. */
    savedBoard: r.saved_board && r.saved_board_at
      ? { ...r.saved_board, at: r.saved_board_at }
      : null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

const COLS = `id, name, borrower_name, entity_name, property_address,
              form, scenario, calc, saved_board, saved_board_at, created_at, updated_at`;

/**
 * This person's scenarios, newest first. Scoped in the QUERY, never on the
 * screen (D2 — a scenario is visible only to the person who saved it).
 */
async function listScenarios(staffId, dbc = null) {
  if (!staffId) return [];
  const q = dbc || lazy.db;
  const { rows } = await q.query(
    `SELECT ${COLS}
       FROM lt_pricer_scenarios
      WHERE staff_id = $1::uuid AND deleted_at IS NULL
      ORDER BY updated_at DESC, created_at DESC`,
    [String(staffId)],
  );
  return rows.map(shape);
}

/** One scenario, if it is this person's and not deleted. */
async function getScenario(id, staffId, dbc = null) {
  if (!staffId || !UUID_RE.test(String(id || ''))) return null;
  const q = dbc || lazy.db;
  const { rows } = await q.query(
    `SELECT ${COLS}
       FROM lt_pricer_scenarios
      WHERE id = $1::uuid AND staff_id = $2::uuid AND deleted_at IS NULL`,
    [String(id), String(staffId)],
  );
  return rows.length ? shape(rows[0]) : null;
}

/**
 * Save a NEW scenario. Always a new row — deliberately never an upsert on the
 * name, unlike an investor group: two searches on the same property with
 * different leverage are two scenarios a person wants both of, and silently
 * overwriting the first would lose work nobody asked to lose. Renaming and
 * re-saving an existing one is `updateScenario`.
 *
 * Returns `{ok:false, reason}` for anything a person can fix, never a throw.
 */
async function saveScenario({
  staffId, name, borrowerName, entityName, propertyAddress, form, scenario, calc, savedBoard,
}) {
  if (!staffId) return { ok: false, reason: 'A scenario needs a signed-in person.' };
  const cleanForm = sanitizeBag(form);
  const cleanScenario = sanitizeBag(scenario);
  const cleanCalc = sanitizeBag(calc);
  if (!Object.keys(cleanForm).length) {
    return { ok: false, reason: 'There is nothing in this scenario to save yet.' };
  }
  if (tooBig(cleanForm, cleanScenario, cleanCalc)) {
    return { ok: false, reason: 'That scenario is too large to save.' };
  }
  const party = {
    borrowerName: sanitizeName(borrowerName, MAX_PARTY),
    entityName: sanitizeName(entityName, MAX_PARTY),
    propertyAddress: sanitizeName(propertyAddress, MAX_PARTY),
  };
  const cleanName = sanitizeName(name) || deriveName({ ...party, form: cleanForm });
  const board = sanitizeBoard(savedBoard);
  const { rows } = await lazy.db.query(
    `INSERT INTO lt_pricer_scenarios
       (id, staff_id, name, borrower_name, entity_name, property_address,
        form, scenario, calc, saved_board, saved_board_at)
     VALUES (gen_random_uuid(), $1::uuid, $2, $3, $4, $5,
             $6::jsonb, $7::jsonb, $8::jsonb, $9::jsonb, $10::timestamptz)
     RETURNING ${COLS}`,
    [
      String(staffId), cleanName, party.borrowerName, party.entityName, party.propertyAddress,
      JSON.stringify(cleanForm), JSON.stringify(cleanScenario), JSON.stringify(cleanCalc),
      board ? JSON.stringify(board) : null,
      // ⛔ THE DATE IS OURS, NEVER THE CALLER'S. A headline is only honest with
      // the moment it was true beside it, and a client clock is not that moment.
      board ? new Date().toISOString() : null,
    ],
  );
  return { ok: true, scenario: shape(rows[0]) };
}

/**
 * Rename, or re-save what a scenario holds. Only the fields that were SENT
 * move — a rename must not blank the deal, and a re-save must not blank a name.
 *
 * `savedBoard` follows the same rule as the save: a headline is stamped with
 * OUR clock at the moment it is written, and one that is not sent is left
 * exactly as it was rather than silently cleared.
 */
async function updateScenario(id, staffId, patch = {}) {
  if (!staffId || !UUID_RE.test(String(id || ''))) return { ok: false, reason: 'That scenario is not yours.' };
  const sets = [];
  const vals = [String(id), String(staffId)];
  const put = (sql, v) => { vals.push(v); sets.push(`${sql} = $${vals.length}`); };

  if (Object.prototype.hasOwnProperty.call(patch, 'name')) {
    // A name cleared by hand goes back to the derived one rather than to blank:
    // an unnamed row in a list is a row nobody can pick out.
    const current = await getScenario(id, staffId);
    if (!current) return { ok: false, reason: 'That scenario is not yours.' };
    put('name', sanitizeName(patch.name) || deriveName({
      propertyAddress: Object.prototype.hasOwnProperty.call(patch, 'propertyAddress')
        ? patch.propertyAddress : current.propertyAddress,
      borrowerName: current.borrowerName,
      entityName: current.entityName,
      form: Object.prototype.hasOwnProperty.call(patch, 'form') ? sanitizeBag(patch.form) : current.form,
    }));
  }
  for (const [key, col, max] of [
    ['borrowerName', 'borrower_name', MAX_PARTY],
    ['entityName', 'entity_name', MAX_PARTY],
    ['propertyAddress', 'property_address', MAX_PARTY],
  ]) {
    if (Object.prototype.hasOwnProperty.call(patch, key)) put(col, sanitizeName(patch[key], max));
  }
  const bags = {};
  for (const [key, col] of [['form', 'form'], ['scenario', 'scenario'], ['calc', 'calc']]) {
    if (Object.prototype.hasOwnProperty.call(patch, key)) {
      bags[col] = sanitizeBag(patch[key]);
      put(`${col}`, JSON.stringify(bags[col]));
    }
  }
  if (Object.keys(bags).length && tooBig(...Object.values(bags))) {
    return { ok: false, reason: 'That scenario is too large to save.' };
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'savedBoard')) {
    const board = sanitizeBoard(patch.savedBoard);
    put('saved_board', board ? JSON.stringify(board) : null);
    put('saved_board_at', board ? new Date().toISOString() : null);
  }
  if (!sets.length) return { ok: false, reason: 'Nothing to change.' };
  sets.push('updated_at = now()');
  const castFor = (s) => (s.startsWith('form') || s.startsWith('scenario') || s.startsWith('calc') || s.startsWith('saved_board ')
    ? `${s}::jsonb` : s.startsWith('saved_board_at') ? `${s}::timestamptz` : s);
  const { rows } = await lazy.db.query(
    `UPDATE lt_pricer_scenarios
        SET ${sets.map(castFor).join(', ')}
      WHERE id = $1::uuid AND staff_id = $2::uuid AND deleted_at IS NULL
      RETURNING ${COLS}`,
    vals,
  );
  if (!rows.length) return { ok: false, reason: 'That scenario is not yours.' };
  return { ok: true, scenario: shape(rows[0]) };
}

/**
 * Remove a scenario — SOFT, and only its owner's. The WHERE is the whole
 * authorisation, exactly as it is for an investor group.
 *
 * ⛔ SOFT ON PURPOSE, AND BY HAND ONLY (D5). The owner accepted that a list
 * never ages out, so nothing anywhere may set `deleted_at` on a timer: this
 * function is the only writer of it, and it runs from a person's press.
 */
async function deleteScenario(id, staffId) {
  if (!staffId || !UUID_RE.test(String(id || ''))) return { ok: false };
  const { rowCount } = await lazy.db.query(
    `UPDATE lt_pricer_scenarios
        SET deleted_at = now(), updated_at = now()
      WHERE id = $1::uuid AND staff_id = $2::uuid AND deleted_at IS NULL`,
    [String(id), String(staffId)],
  );
  return { ok: rowCount > 0 };
}

module.exports = {
  listScenarios, getScenario, saveScenario, updateScenario, deleteScenario,
  _internals: { sanitizeName, sanitizeBag, sanitizeBoard, deriveName, tooBig, shape, MAX_JSON_BYTES },
};
