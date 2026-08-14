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
