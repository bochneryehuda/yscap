'use strict';

// HTTP for the Encompass "memory" — the field catalog, the Milestone Completion
// rules, the request/authorization catalog, and the RTL reconciliation map.
// Mounted at /api/lt/encompass by src/longterm/index.js. Staff-authenticated at
// the server seam. Read-only reference knowledge — nothing here is enforced.

const express = require('express');
const router = express.Router();
const enc = require('../encompass');

// GET /api/lt/encompass/summary — a compact overview of the whole memory.
router.get('/summary', (req, res) => {
  try { res.json(enc.summary()); }
  catch (e) { console.error('[lt] encompass summary failed:', e && e.message); res.status(500).json({ error: 'Could not build the Encompass summary.' }); }
});

// GET /api/lt/encompass/fields — the unified field catalog (every known field,
// with when/why it is needed and any RTL usage). ?family=standard|custom|urla|form|vendor
// ?milestone=LO Prep|Submittal|Docs Out|Clear To Close   ?rtl=true|false   ?q=<text>
router.get('/fields', (req, res) => {
  try {
    let list = enc.fieldCatalog();
    const { family, milestone, rtl, q } = req.query;
    if (family) list = list.filter((f) => f.family === String(family));
    if (milestone) list = list.filter((f) => f.milestones.includes(String(milestone)));
    if (rtl != null) { const want = String(rtl) !== 'false'; list = list.filter((f) => f.isRtlReconciled === want); }
    if (q) { const s = String(q).toLowerCase(); list = list.filter((f) => f.fieldId.toLowerCase().includes(s) || (f.description || '').toLowerCase().includes(s)); }
    res.json({ fields: list, count: list.length });
  } catch (e) { console.error('[lt] encompass fields failed:', e && e.message); res.status(500).json({ error: 'Could not load the field catalog.' }); }
});

// GET /api/lt/encompass/fields/:id — one field by its Encompass id.
router.get('/fields/:id', (req, res) => {
  try {
    const f = enc.fieldById(req.params.id);
    if (!f) return res.status(404).json({ error: 'No such field in the catalog.' });
    res.json(f);
  } catch (e) { console.error('[lt] encompass field failed:', e && e.message); res.status(500).json({ error: 'Could not load the field.' }); }
});

// GET /api/lt/encompass/completion-rules — the Milestone Completion rules, the
// base rule's field set, and what is still missing.
router.get('/completion-rules', (req, res) => {
  try {
    res.json({
      productNote: enc.rules.PRODUCT_NOTE,
      rules: enc.rules.RULES,
      baseRuleFields: enc.rules.BASE_RULE_FIELDS,
      ruleFields: enc.rules.RULE_FIELDS,
      missing: enc.rules.MISSING,
    });
  } catch (e) { console.error('[lt] encompass rules failed:', e && e.message); res.status(500).json({ error: 'Could not load the completion rules.' }); }
});

// GET /api/lt/encompass/requests — the request & authorization catalog.
router.get('/requests', (req, res) => {
  try { res.json({ auth: enc.requests.AUTH, requests: enc.requests.REQUESTS, notAvailableViaApi: enc.requests.NOT_AVAILABLE_VIA_API }); }
  catch (e) { console.error('[lt] encompass requests failed:', e && e.message); res.status(500).json({ error: 'Could not load the request catalog.' }); }
});

// GET /api/lt/encompass/reconciliation-map — the RTL field map (all mapped fields,
// RTL usage labeled). Reference only.
router.get('/reconciliation-map', (req, res) => {
  try { res.json({ gate: enc.reconciliation.GATE, paDateFieldId: enc.reconciliation.PA_DATE_FIELD_ID, registry: enc.reconciliation.REGISTRY, identityMap: enc.reconciliation.IDENTITY_MAP, valueMaps: enc.reconciliation.VALUE_MAPS }); }
  catch (e) { console.error('[lt] encompass recon map failed:', e && e.message); res.status(500).json({ error: 'Could not load the reconciliation map.' }); }
});

// ── The live census (2026-08-14) ─────────────────────────────────────────────

// GET /api/lt/encompass/intelligence — what the fields actually CONTAIN.
// ?q=<text> search · ?view=always-on|differences|shared|calculated · ?stage=<milestone>
// ?minPct=<n> · ?kind=standard|custom
router.get('/intelligence', (req, res) => {
  try {
    const I = enc.intelligence;
    const { q, view, stage, minPct, kind } = req.query;
    let fields;
    if (q) fields = I.search(q, { limit: 200 });
    else if (stage) fields = I.populatedAt(stage);
    else if (view === 'always-on') fields = I.alwaysOnDscr(minPct ? Number(minPct) : 95);
    else if (view === 'differences') fields = I.productDifferences({ minGap: minPct ? Number(minPct) : 40 });
    else if (view === 'shared') fields = I.sharedCore();
    else if (view === 'calculated') fields = I.calculatedFields();
    else fields = I.dscrFields({ minPct: minPct ? Number(minPct) : 1, kind: kind || null });
    res.json({ meta: I.META, count: fields.length, fields });
  } catch (e) { console.error('[lt] encompass intelligence failed:', e && e.message); res.status(500).json({ error: 'Could not load the field intelligence.' }); }
});

// GET /api/lt/encompass/intelligence/:id — one field's measured behaviour.
router.get('/intelligence/:id', (req, res) => {
  try {
    const f = enc.intelligence.field(req.params.id);
    if (!f) return res.status(404).json({ error: 'No evidence for that field id in the census.' });
    res.json(f);
  } catch (e) { console.error('[lt] encompass field intel failed:', e && e.message); res.status(500).json({ error: 'Could not load the field.' }); }
});

// GET /api/lt/encompass/anatomy — how an Encompass loan file is structured.
router.get('/anatomy', (req, res) => {
  try { res.json({ ...enc.anatomy, formulas: enc.formulas }); }
  catch (e) { console.error('[lt] encompass anatomy failed:', e && e.message); res.status(500).json({ error: 'Could not load the loan anatomy.' }); }
});

// GET /api/lt/encompass/programs — the loan-program taxonomy (term, IO, purpose mix).
router.get('/programs', (req, res) => {
  try { res.json(enc.programs); }
  catch (e) { console.error('[lt] encompass programs failed:', e && e.message); res.status(500).json({ error: 'Could not load the program taxonomy.' }); }
});

// GET /api/lt/encompass/conditions — the condition + eFolder model and the tenant's
// condition library. Reference knowledge; performs no Encompass call.
router.get('/conditions', (req, res) => {
  try {
    res.json({
      model: enc.conditions,
      library: enc.conditionLibrary,
      efolderCatalog: enc.efolderCatalog,
    });
  } catch (e) { console.error('[lt] encompass conditions failed:', e && e.message); res.status(500).json({ error: 'Could not load the condition model.' }); }
});

// GET /api/lt/encompass/api-surface — which Encompass requests work, and which error.
router.get('/api-surface', (req, res) => {
  try {
    res.json({
      summary: enc.apiSurface.summary(),
      access: enc.apiSurface.ACCESS_NOTES,
      falseNegatives: enc.apiSurface.FALSE_NEGATIVES,
      working: enc.apiSurface.working(),
      blocked: enc.apiSurface.blocked(),
    });
  } catch (e) { console.error('[lt] encompass api surface failed:', e && e.message); res.status(500).json({ error: 'Could not load the API surface.' }); }
});

// GET /api/lt/encompass/settings — every tenant-specific choice, with OUR value as
// the default and the evidence behind it. This is the layer a future buyer edits.
router.get('/settings', (req, res) => {
  try {
    const s = require('../settings/encompass-settings');
    res.json({ groups: s.groups(), defaults: s.defaults(), count: s.SETTINGS.length });
  } catch (e) { console.error('[lt] encompass settings failed:', e && e.message); res.status(500).json({ error: 'Could not load the settings registry.' }); }
});

// GET /api/lt/encompass/status — is the LT Encompass connection configured/reachable?
// (Reachability only; never returns credentials.)
router.get('/status', async (req, res) => {
  try {
    const configured = enc.client.configured();
    if (!configured || String(req.query.ping) !== 'true') return res.json({ configured, readOnly: enc.client.READ_ONLY });
    const ping = await enc.client.ping();
    res.json({ configured, readOnly: enc.client.READ_ONLY, reachable: ping.ok, reason: ping.reason });
  } catch (e) { console.error('[lt] encompass status failed:', e && e.message); res.status(500).json({ error: 'Could not check Encompass status.' }); }
});

module.exports = router;
