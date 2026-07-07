/**
 * Live dropdown-option registry. ClickUp dropdowns write the option UUID and
 * read the orderindex, so the mapper needs the current option list per field.
 * All our mapped dropdowns are space-level, so one `getListFields` on any
 * Pipeline list returns them (with type_config.options). Cached with a TTL and
 * refreshed on demand (options can be added in ClickUp).
 *
 * DB overrides (clickup_field_mappings) layer on top once the Control Center
 * lets an admin remap — code/live options are the fallback default.
 */
const clickup = require('./client');

let _optionCache = null;
let _optionAt = 0;
const TTL_MS = 10 * 60 * 1000;

/** Fetch fieldId -> optionList from a representative Pipeline list. */
async function loadOptionsFromList(listId) {
  const r = await clickup.getListFields(listId);
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
