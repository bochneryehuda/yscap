#!/usr/bin/env node
'use strict';
/**
 * Long-Term DSCR pricer — the FIELD MANIFEST (D28 backend contract). No network, no DB.
 *
 * The manifest is the machine-readable "what does the pricer accept" contract, split into the sections
 * the frontend's basic vs advanced search UI needs. The invariant that makes it trustworthy: the three
 * FIELD sections (core / advanced / overlay) are DISJOINT and their union is EXACTLY the accepted set
 * (SUPPORTED_FIELDS). A field added to only one segment would break that partition — this test is the
 * guard, so the manifest can never silently disagree with what the pricer actually accepts.
 */
const dp = require('../src/longterm/routes/dscr-pricer');
const { buildFieldManifest } = dp._internals;

let fail = 0;
function ok(c, l) { console.log(`${c ? '  ok  ' : ' FAIL '} ${l}`); if (!c) fail++; }

console.log('LT DSCR — field manifest (D28)\n');

const m = buildFieldManifest();
const core = new Set(m.core);
const adv = new Set(m.advanced);
const ovl = new Set(m.overlay.map((o) => o.key));

// ---- the PARTITION invariant: disjoint sections whose union is exactly SUPPORTED_FIELDS -------------
ok(m.core.every((k) => !adv.has(k) && !ovl.has(k)), 'core is disjoint from advanced and overlay');
ok(m.advanced.every((k) => !ovl.has(k)), 'advanced is disjoint from overlay');
ok(m.core.length === core.size && m.advanced.length === adv.size && m.overlay.length === ovl.size, 'no key repeats within a section');
{
  const union = new Set([...m.core, ...m.advanced, ...m.overlay.map((o) => o.key)]);
  const supported = dp.SUPPORTED_FIELDS;
  const missing = [...supported].filter((k) => !union.has(k));
  const extra = [...union].filter((k) => !supported.has(k));
  ok(missing.length === 0 && extra.length === 0, `core ∪ advanced ∪ overlay === SUPPORTED_FIELDS (${union.size} fields; 0 missing, 0 extra)`);
}

// ---- counts are self-consistent --------------------------------------------------------------------
ok(m.counts.core === m.core.length && m.counts.advanced === m.advanced.length && m.counts.overlay === m.overlay.length && m.counts.meta === m.meta.length, 'counts match the section lengths');
ok(m.counts.supported === dp.SUPPORTED_FIELDS.size && m.counts.supported === m.counts.core + m.counts.advanced + m.counts.overlay, 'counts.supported = SUPPORTED_FIELDS.size = core + advanced + overlay');

// ---- meta keys are the request-envelope keys, NOT pricing inputs -----------------------------------
ok(m.meta.every((k) => dp.META_FIELDS.has(k)) && m.meta.length === dp.META_FIELDS.size, 'meta lists exactly the request-envelope (non-pricing) keys');
ok(m.meta.every((k) => !dp.SUPPORTED_FIELDS.has(k)), 'no meta key is also a pricing field');

// ---- the OVERLAY section carries its UI shape, and every overlay fact is LP-invisible ---------------
ok(m.overlay.every((o) => o.key && o.label && o.type && Object.prototype.hasOwnProperty.call(o, 'effect')), 'every overlay entry carries key + label + type + effect (the UI shape)');
ok(m.overlay.every((o) => o.lpVisible === false), 'every overlay fact is lpVisible:false (the Lender-Price-cannot-see class the D36 overlay rules act on)');
{
  const occ = m.overlay.find((o) => o.key === 'occupancy');
  ok(occ && occ.type === 'enum' && Array.isArray(occ.enumValues) && occ.enumValues.includes('vacant'), 'the occupancy overlay fact publishes its enum values (leased/vacant)');
}

// ---- core holds the basic pricing contract; a couple of anchors ------------------------------------
ok(['purpose', 'loan', 'ltv', 'fico', 'dscr', 'value', 'state'].every((k) => core.has(k)), 'core includes the basic pricing anchors (purpose/loan/ltv/fico/dscr/value/state)');
ok(!core.has('occupancy') && !core.has('bankruptcy'), 'core excludes overlay/advanced-only fields');

// ---- the GET /fields handler returns the manifest --------------------------------------------------
{
  let body = null;
  const res = { json: (b) => { body = b; } };
  // handler is async but synchronous-bodied; resolve then assert
  Promise.resolve(dp.handlers.fields({}, res)).then(() => {
    ok(body && body.ok === true && body.manifest && Array.isArray(body.manifest.core) && Array.isArray(body.manifest.overlay), 'GET /fields handler returns { ok:true, manifest:{core, advanced, overlay, meta, counts} }');
    console.log(`\n${fail === 0 ? 'OFFLINE: all passed' : 'FAILURES: ' + fail}`);
    process.exit(fail === 0 ? 0 : 1);
  });
}
