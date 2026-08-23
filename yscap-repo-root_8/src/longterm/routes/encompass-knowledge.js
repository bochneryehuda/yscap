'use strict';

// HTTP for the Encompass "memory" — the field catalog, the Milestone Completion
// rules, the request/authorization catalog, and the RTL reconciliation map.
// Mounted at /api/lt/encompass by src/longterm/index.js. Staff-authenticated at
// the server seam. Read-only reference knowledge — nothing here is enforced.

const express = require('express');
const killSwitch = require('../encompass/enabled');
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

// GET /api/lt/encompass/terms — the term structures that actually exist in the book,
// the PITI they build, and the DSCR arithmetic on top. Reference knowledge only.
// ?term=360&io=120 describes a structure without classifying it into the nearest bucket.
router.get('/terms', (req, res) => {
  try {
    const body = {
      summary: enc.terms.summary(),
      fields: enc.terms.TERM_FIELDS,
      structures: enc.terms.TERM_STRUCTURES,
      notPresent: enc.terms.TERM_STRUCTURES_NOT_PRESENT,
      piti: enc.terms.PITI,
      dscr: enc.terms.DSCR_MEASURED,
      defects: enc.terms.KNOWN_TERM_DEFECTS,
    };
    if (req.query.term !== undefined) {
      body.described = enc.terms.describeStructure(req.query.term, req.query.io);
    }
    res.json(body);
  } catch (e) {
    console.error('[lt] encompass terms failed:', e && e.message);
    res.status(500).json({ error: 'Could not load the term structures.' });
  }
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

// GET /api/lt/encompass/investors — the canonical investor list and every spelling
// seen in the tenant. ?resolve=<typed name> answers "which investor is this?".
router.get('/investors', (req, res) => {
  try {
    const I = enc.investors;
    if (req.query.resolve != null) return res.json(I.resolve(String(req.query.resolve)));
    res.json({
      summary: I.summary(),
      investors: I.list(),
      nonValues: I.NON_VALUES,
      investorFields: I.INVESTOR_FIELDS,
      tableFunderValues: I.TABLE_FUNDER_VALUES,
    });
  } catch (e) { console.error('[lt] encompass investors failed:', e && e.message); res.status(500).json({ error: 'Could not load the investor registry.' }); }
});

// GET /api/lt/encompass/dropdowns — every constrained field with its option set.
// ?id=<fieldId> one field · ?kind=standard|custom · ?minLoans=<n> · ?drift=true
router.get('/dropdowns', (req, res) => {
  try {
    const D = enc.dropdowns;
    const { id, kind, minLoans, drift, inferred } = req.query;
    if (id) {
      const f = D.field(id);
      if (!f) return res.status(404).json({ error: 'That field is not a known dropdown.' });
      return res.json({ field: f, options: D.options(id) });
    }
    const fields = D.list({
      kind: kind || null,
      minLoans: minLoans ? Number(minLoans) : 0,
      inferredOnly: String(inferred) === 'true',
      driftOnly: String(drift) === 'true',
    });
    res.json({ summary: D.summary(), driftKinds: D.DRIFT_KINDS, notable: D.NOTABLE, count: fields.length, fields });
  } catch (e) { console.error('[lt] encompass dropdowns failed:', e && e.message); res.status(500).json({ error: 'Could not load the dropdown catalog.' }); }
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
    // WHY it is not connected, not only THAT it is not — a switched-off connection
    // and a missing credential need two different actions from whoever is reading.
    const reason = !killSwitch.encompassEnabled() ? killSwitch.OFF_REASON
      : (configured ? null : 'Encompass is not connected yet — add the long-term Encompass credentials first.');
    if (!configured || String(req.query.ping) !== 'true') return res.json({ configured, reason, readOnly: enc.client.READ_ONLY });
    const ping = await enc.client.ping();
    res.json({ configured, readOnly: enc.client.READ_ONLY, reachable: ping.ok, reason: ping.reason });
  } catch (e) { console.error('[lt] encompass status failed:', e && e.message); res.status(500).json({ error: 'Could not check Encompass status.' }); }
});

module.exports = router;
