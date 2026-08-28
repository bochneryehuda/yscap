'use strict';
/**
 * LONG-TERM — live dropdown-option registry for the ClickUp field writer.
 *
 * BY-VALUE COPY of the RTL pattern (src/clickup/registry.js), under the CLICKUP
 * WRITER'S INHERITANCE sanction (owner, 2026-08-23 — recorded in
 * docs/LONG-TERM-AUTHORIZED-COPIES.md). Zero RTL imports — the fetch goes
 * through Long-Term's own writer-client.
 *
 * WHY IT EXISTS: ClickUp dropdowns READ as the option's orderindex integer and
 * WRITE as the option UUID, and option UUIDs churn when somebody edits a
 * dropdown in ClickUp — so write-ids are resolved LIVE, per field, from the
 * list's own current option set, never hardcoded. Custom fields are SPACE-level
 * on this tenant (verified live 2026-08-24 — the same 161 fields appear on
 * every officer list), so one list's fetch covers the space. Cached with a TTL
 * because the option set changes rarely and a fetch costs a shared-budget call.
 */
const writer = require('./writer-client');

let _optionCache = null;
let _optionAt = 0;
const TTL_MS = 10 * 60 * 1000;

/** Fetch fieldId -> optionList from a representative Loan Pipeline list. */
async function loadOptionsFromList(listId) {
  const r = await writer.getListFields(listId);
  const map = {};
  for (const f of (r && r.fields) || []) {
    if (f.type_config && Array.isArray(f.type_config.options)) map[f.id] = f.type_config.options;
  }
  return map;
}

/** Cached { [fieldId]: optionList } for writes/reads. */
async function optionMap(listId, { force = false } = {}) {
  const now = Date.now();
  if (!force && _optionCache && now - _optionAt < TTL_MS) return _optionCache;
  if (!listId) return _optionCache || {};
  _optionCache = await loadOptionsFromList(listId);
  _optionAt = now;
  return _optionCache;
}

function bust() { _optionCache = null; _optionAt = 0; }
function peek() { return _optionCache || {}; }

module.exports = { optionMap, loadOptionsFromList, bust, peek };
