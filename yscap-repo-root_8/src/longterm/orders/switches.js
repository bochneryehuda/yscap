'use strict';
/**
 * LONG-TERM — IS THIS ORDER SWITCHED ON?
 *
 * Owner-directed, over this whole build: *"everything should be setup with not
 * setting it on a hard level; everything should be able to be configured differently
 * in settings. The system is only prefilled with the rules of the system."*
 *
 * ── THE DEFECT THIS CLOSES ──────────────────────────────────────────────────
 *
 * An order kind's `enabled` lived in `kinds.js` as a CODE CONSTANT, while the
 * condition it answers carries its own switch in the condition LIBRARY, which an
 * administrator can turn on and off. So one question — "is this order on?" — had two
 * answers, and the one a person could reach was not the one that decided: switching
 * the template off left the order still placeable, and switching it on left an order
 * still refused by something nobody at the desk can change.
 *
 * So the TEMPLATE is the switch, and the code constant is only the SHIPPED DEFAULT —
 * what the system is prefilled with, exactly as the owner put it.
 *
 * ── IT FAILS TO THE SHIPPED DEFAULT, NOT TO "ON" ────────────────────────────
 *
 * An unreadable library answers with the default the code ships, so an outage can
 * never switch an order ON that shipped off, and can never switch OFF one that is
 * running. Nothing here throws: the desk reads it on every load, and the send
 * re-reads the same answer rather than trusting the screen's.
 *
 * SEPARATION: reads `lt_condition_templates` only.
 */
const db = require('../db');
const kinds = require('./kinds');

/**
 * The live on/off state for every order kind.
 *
 * @returns {Promise<Object<string,{enabled:boolean, reason:string|null, source:'settings'|'shipped', config:object}>>}
 */
async function resolve(client = db) {
  const out = {};
  for (const k of kinds.ORDER_KIND_KEYS) {
    const def = kinds.orderKind(k);
    out[k] = {
      enabled: def.enabled !== false,
      reason: def.enabled === false ? (def.disabledReason || null) : null,
      source: 'shipped',
      /* The template's own settings — the letter wording a buyer overrode, the
         anything else a kind puts there. Empty until a template
         is read, so a caller never has to check whether one was. */
      config: {},
    };
  }

  // The condition each kind answers. A kind with no condition has no switch to
  // read and keeps its shipped default.
  const byCondition = new Map();
  for (const k of kinds.ORDER_KIND_KEYS) {
    const def = kinds.orderKind(k);
    if (def.condition) byCondition.set(def.condition, k);
  }
  if (!byCondition.size) return out;

  let rows = [];
  try {
    rows = (await client.query(
      `SELECT code, is_enabled, is_active, disabled_reason, config
         FROM lt_condition_templates WHERE code = ANY($1)`,
      [[...byCondition.keys()]])).rows;
  } catch (_) {
    return out;             // unreadable → the shipped default, for every kind
  }

  for (const r of rows) {
    const k = byCondition.get(r.code);
    if (!k) continue;
    /* A RETIRED template (`is_active = false`) is not the same as a switched-off
       one, and it is treated as OFF for a different reason: the condition is not on
       any file, so an order answering it would have nothing to move. Its own reason
       says which of the two it is, because they send a person to two different
       screens. */
    const config = (r.config && typeof r.config === 'object') ? r.config : {};
    if (r.is_active === false) {
      out[k] = { enabled: false, reason: 'The condition this order answers has been retired in settings.', source: 'settings', config };
      continue;
    }
    const on = r.is_enabled !== false;
    out[k] = {
      enabled: on,
      reason: on ? null : (r.disabled_reason || 'This order is switched off in settings.'),
      source: 'settings',
      config,
    };
  }
  return out;
}

/** One kind, for a caller that already holds the map. Falls back to the shipped
    default when the map is absent, so nothing has to check whether it was read. */
function stateFor(map, kind) {
  const def = kinds.orderKind(kind);
  if (!def) return { enabled: false, reason: 'There is no such order.', source: 'shipped' };
  const s = map && map[kind];
  if (s) return s;
  return {
    enabled: def.enabled !== false,
    reason: def.enabled === false ? (def.disabledReason || null) : null,
    source: 'shipped',
    config: {},
  };
}

module.exports = { resolve, stateFor };
