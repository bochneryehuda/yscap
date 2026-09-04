/**
 * WHICH BOXES A RULE NEEDS, AND WHAT THEY BUILD.
 *
 * Owner-directed 2026-09-04. Extracted out of the Rule Center screen for the
 * reason this repository has already learned twice: a source guard over the
 * caller can only ever pin the SPELLING. Whether the right boxes come out for a
 * given rule is arithmetic, so it lives in functions a test can call and assert
 * the answer of — `test-lt-pricing-rules-preview-pure.js` runs every one of
 * them.
 *
 * ⛔ IT DECIDES NOTHING ABOUT THE MAPPING. Which box fills which fact comes from
 * the SERVER (`/catalog` → `cat.scenarioInput` / `cat.quoteInput` /
 * `cat.derivedFacts`), because a fact's name is not the name of the box that
 * fills it — the loan amount arrives as `loan`, the property value as `value` —
 * and a copy of those spellings kept in the browser would drift. A drifted copy
 * tries the rule against a different loan than the boxes on screen describe,
 * with total confidence, which is worse than offering no preview at all.
 *
 * PURE: no React, no network, no clock.
 */

const isGroup = (n) => !!n && typeof n === 'object' && Array.isArray(n.rules);

/** Every field a rule reads, in the order it reads them, without repeats. */
export function fieldsUsedBy(tree, out) {
  const list = out || [];
  if (!tree || typeof tree !== 'object') return list;
  for (const n of (tree.rules || [])) {
    if (isGroup(n)) fieldsUsedBy(n, list);
    else if (n && n.field && !list.includes(n.field)) list.push(n.field);
  }
  return list;
}

/**
 * The boxes to offer — one per fact the rule reads that a person can state.
 *
 * A WORKED-OUT FACT FOLLOWS BACK TO WHAT MAKES IT. A rule written purely on the
 * DSCR band has no box of its own; offering none would leave that rule exactly
 * as untestable as the fixed four-box panel left everything else, so the server
 * says what it is computed from and those boxes are offered instead.
 *
 * A fact that is neither — the engine a quote came from, which the panel asks
 * for separately — is skipped rather than drawn as a box that does nothing.
 */
export function previewBoxes(usedKeys, cat, byKey) {
  const seen = new Set();
  const boxes = [];
  const add = (factKey) => {
    if (seen.has(factKey)) return;
    const f = (byKey || {})[factKey];
    if (!f) return;
    const sPath = ((cat && cat.scenarioInput) || {})[factKey];
    const qKey = ((cat && cat.quoteInput) || {})[factKey];
    if (sPath) { seen.add(factKey); boxes.push({ factKey, field: f, where: 'scenario', path: sPath }); return; }
    if (qKey) { seen.add(factKey); boxes.push({ factKey, field: f, where: 'quote', path: qKey }); }
  };
  for (const key of (usedKeys || [])) {
    const from = ((cat && cat.derivedFacts) || {})[key];
    if (from) { for (const src of from) add(src); continue; }
    add(key);
  }
  return boxes;
}

/** Put a value at a dot path, making the objects on the way. */
export function putAt(obj, path, value) {
  const parts = String(path || '').split('.').filter(Boolean);
  if (!parts.length) return obj;
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i += 1) {
    if (!cur[parts[i]] || typeof cur[parts[i]] !== 'object') cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
  return obj;
}

/**
 * What the person typed, in the shape the preview door takes.
 *
 * ⛔ A BOX LEFT BLANK IS OMITTED, never sent as an empty string. `Number('')` is
 * 0 and 0 is finite, so a blank rate sent through would arrive as a real quoted
 * 0.000% and a rule reading "note rate is under 7" would fire on a loan nobody
 * described. Blank means NOT STATED — and on a yes/no field that is a third
 * state, not a hidden "no", because a live board hands a rule an unstated flag
 * most of the time.
 */
export function buildSample(boxes, values) {
  const scenario = {};
  const quote = {};
  for (const b of (boxes || [])) {
    const raw = (values || {})[b.factKey];
    if (raw === undefined || raw === null || raw === '') continue;
    let v = raw;
    if (b.field.type === 'boolean') v = raw === true || raw === 'yes' || raw === 'true';
    else if (b.field.type === 'money' || b.field.type === 'pct' || b.field.type === 'number') {
      const n = Number(raw);
      if (!Number.isFinite(n)) continue;
      v = n;
    }
    if (b.where === 'scenario') putAt(scenario, b.path, v);
    else quote[b.path] = v;
  }
  return { scenario, quote };
}
