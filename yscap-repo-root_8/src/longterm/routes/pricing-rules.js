'use strict';
/**
 * LONG-TERM — THE PRICING RULE CENTER'S DOOR.
 *
 * Owner-directed 2026-09-04: *"a rule center connected to the general pricing
 * engine. Separate section, not part of the general settings, a separate center
 * for pricing engine rules, where I can manually start adding rules."*
 *
 * ⛔ SUPER ADMIN ONLY, AND IT ANSWERS 404. These rules decide which quotes reach
 * an officer and move the price on the ones that do — the same authority the
 * investor sources beside them require, and for the same reason. A 404 rather
 * than a 403 because a control the rest of the team may not use should not
 * announce itself to them (`routes/pricer-sources.js` is the pattern).
 *
 * ⛔ IT VALIDATES THROUGH THE SAME MODULES THE OVERLAY READS. Nothing here
 * re-implements what a valid rule is; a second opinion at the door is how a rule
 * gets saved that the board then cannot run.
 */

const express = require('express');
const store = require('../pricing/rules/store');
const fields = require('../pricing/rules/fields');
const ruleActions = require('../pricing/rules/actions');
const logic = require('../pricing/rules/logic');
const overlay = require('../pricing/rules/overlay');
const audit = require('../pricing/rules/audit');
const facts = require('../pricing/rules/facts');

/** The REAL staff role, never a long-term override — an override may not hand this out. */
function isSuperAdmin(req) {
  const a = req.actor;
  return !!(a && a.kind === 'staff' && String(a.role || '') === 'super_admin');
}

const staffId = (req) => (req.actor && req.actor.kind === 'staff' ? req.actor.id : null) || null;

/** One shape for every refusal, so a screen renders them all the same way. */
const refuse = (res, problems) => res.status(422).json({ error: 'invalid_rule', problems });

function attach(router) {
  /**
   * WHAT A RULE MAY ASK AND WHAT IT MAY DO — the builder's whole vocabulary,
   * served rather than shipped in the bundle, so a field added to the registry
   * appears in the builder without a front-end deploy.
   */
  router.get('/catalog', (req, res) => {
    res.json({
      ok: true,
      groups: fields.grouped(),
      operatorsByType: require('../../lib/conditions/rules').OPERATORS_BY_TYPE,
      operatorLabels: require('../../lib/conditions/rules').OPERATOR_LABEL,
      noValueOperators: require('../../lib/conditions/rules').NO_VALUE_OPS,
      rangeOperators: require('../../lib/conditions/rules').RANGE_OPS,
      listOperators: require('../../lib/conditions/rules').LIST_OPS,
      actions: ruleActions.KEYS.map((k) => ruleActions.ACTIONS[k]),
      maxPoints: ruleActions.MAX_POINTS,
      engines: [
        { v: 'all', label: 'Both engines' },
        { v: 'general', label: 'General Pricing Engine' },
        { v: 'combined', label: 'Combined Pricing Engine' },
      ],
    });
  });

  router.get('/', async (req, res) => {
    try {
      const rules = await store.listRules({ includeArchived: String(req.query.archived || '') === '1' });
      res.json({ ok: true, rules, count: rules.length });
    } catch (e) { res.status(500).json({ error: 'server_error', detail: String(e && e.message || e) }); }
  });

  router.get('/events', async (req, res) => {
    try {
      res.json({ ok: true, events: await store.events({ limit: req.query.limit, ruleId: req.query.ruleId }) });
    } catch (e) { res.status(500).json({ error: 'server_error', detail: String(e && e.message || e) }); }
  });

  /* ⛔ EVERY LITERAL PATH IS REGISTERED BEFORE `/:id`, WHICH MATCHES ANYTHING.
     Express takes the FIRST route that matches, so `/audit` registered after it
     is read as a rule whose id is the word "audit" — the door 404s and the whole
     audit screen is empty, with nothing anywhere saying why. */
  /**
   * THE AUDIT — IS EVERY RULE ACTUALLY FIRING?
   *
   * Owner-directed 2026-09-04: *"open audit engines to make sure that every rule
   * is actually firing."*
   *
   * Every rule the centre holds, worst first, each with what it has actually
   * DONE on real boards (the db/696 ledger) and, when it cannot run at all, the
   * reason in the words a person can act on.
   *
   * ⛔ AN UNREADABLE LEDGER IS REPORTED, NEVER DRAWN AS ZEROES. Every counter
   * would read 0, which is the exact sentence "this rule has never fired" — so a
   * database hiccup would put every rule in the centre on the screen as broken.
   * `firingSummary` answers its own `problem` and the screen says it could not
   * read the numbers.
   */
  router.get('/audit', async (req, res) => {
    try {
      const days = Number(req.query.days) || 90;
      const rules = await store.listRules({ includeArchived: true });
      const ledger = await store.firingSummary({ days });
      const out = audit.auditAll(rules, ledger.byRule, { days: ledger.days });
      res.json({
        ok: true,
        ...out,
        ledgerProblem: ledger.problem,
        /* WHAT THE RECORDER ITSELF HAS BEEN DOING. An audit trail that is
           failing to write must be visible on the screen that reads it, or the
           numbers quietly become fiction. */
        recorder: ledgerStats(),
      });
    } catch (e) { res.status(500).json({ error: 'server_error', detail: String(e && e.message || e) }); }
  });

  /**
   * THE FIRE DRILL — every rule against one scenario, and WHY each one does not
   * fire. The owner's *"make sure that every rule that you fire will actually
   * work"* asked directly.
   *
   * ⛔ IT JUDGES ARCHIVED AND SWITCHED-OFF RULES TOO, and says which is which.
   * Trying a rule before turning it on is the whole point; refusing to judge it
   * would answer a question nobody asked.
   */
  router.post('/audit/dry-run', async (req, res) => {
    try {
      const b = req.body || {};
      const scenario = b.scenario || {};
      const quote = b.quote || {};
      /* THE SAME FACT BAG THE BOARD BUILDS, through the same module — a drill
         run against a hand-made bag would answer about a loan the engine never
         sees, which is worse than no drill at all. */
      const bag = facts.factsFor(
        facts.scenarioFacts(scenario),
        {
          investorKey: quote.investorKey || 'sample',
          whiteLabel: quote.whiteLabel || 'Sample program',
          lender: quote.lender || null,
          investor: quote.investor || null,
          program: quote.program || 'Sample',
          product: quote.product || null,
          pricedBy: quote.source || null,
          priceBuild: {
            noteRate: quote.noteRate == null ? null : Number(quote.noteRate),
            price: quote.price == null ? 100 : Number(quote.price),
            borrowerPaidPoints: quote.points == null ? 0 : Number(quote.points),
          },
          terms: {
            ltv: quote.quotedLtv == null ? null : Number(quote.quotedLtv),
            dscr: quote.quotedDscr == null ? null : Number(quote.quotedDscr),
            termYears: quote.quotedTermYears == null ? null : Number(quote.quotedTermYears),
            dayLock: quote.quotedLockDays == null ? null : Number(quote.quotedLockDays),
            amortizationType: quote.amortization || null,
          },
          marginHoldback: quote.marginHoldback == null ? null : Number(quote.marginHoldback),
        },
        null,
        {},
      );

      const rules = await store.listRules({ includeArchived: true });
      const engine = b.engine === 'combined' ? 'combined' : b.engine === 'general' ? 'general' : null;
      res.json({ ok: true, engine, facts: bag, ...audit.dryRun(rules, bag, { engine }) });
    } catch (e) { res.status(500).json({ error: 'server_error', detail: String(e && e.message || e) }); }
  });
  router.get('/:id', async (req, res) => {
    try {
      const rule = await store.getRule(req.params.id);
      if (!rule) return res.status(404).json({ error: 'not_found' });
      res.json({ ok: true, rule, reads: [...logic.fieldsUsed(rule.when)] });
    } catch (e) { res.status(500).json({ error: 'server_error', detail: String(e && e.message || e) }); }
  });

  router.post('/', async (req, res) => {
    try {
      const out = await store.createRule(req.body || {}, staffId(req), (req.body || {}).changeNote);
      if (!out.ok) return refuse(res, out.problems);
      res.status(201).json({ ok: true, rule: out.rule });
    } catch (e) { res.status(500).json({ error: 'server_error', detail: String(e && e.message || e) }); }
  });

  router.put('/:id', async (req, res) => {
    try {
      const out = await store.updateRule(req.params.id, req.body || {}, staffId(req), (req.body || {}).changeNote);
      if (out.notFound) return res.status(404).json({ error: 'not_found' });
      if (!out.ok) return refuse(res, out.problems);
      res.json({ ok: true, rule: out.rule });
    } catch (e) { res.status(500).json({ error: 'server_error', detail: String(e && e.message || e) }); }
  });

  router.delete('/:id', async (req, res) => {
    try {
      const out = await store.archiveRule(req.params.id, staffId(req), (req.body || {}).changeNote);
      if (out.notFound) return res.status(404).json({ error: 'not_found' });
      res.json({ ok: true, rule: out.rule });
    } catch (e) { res.status(500).json({ error: 'server_error', detail: String(e && e.message || e) }); }
  });

  router.post('/:id/restore', async (req, res) => {
    try {
      const out = await store.restoreRule(req.params.id, staffId(req), (req.body || {}).changeNote);
      if (out.notFound) return res.status(404).json({ error: 'not_found' });
      res.json({ ok: true, rule: out.rule, note: 'A restored rule comes back switched off — read it, then turn it on.' });
    } catch (e) { res.status(500).json({ error: 'server_error', detail: String(e && e.message || e) }); }
  });

  /**
   * TRY IT BEFORE YOU TURN IT ON — the owner's *"test that it actually works"*.
   *
   * Takes a rule (saved or not yet), a scenario, and an optional sample quote,
   * and answers what it WOULD do. It runs the REAL `overlay.apply`, not a
   * simplified copy — a preview that agrees with a model of the engine instead
   * of the engine is a preview that lies on the day they differ.
   */
  router.post('/test', (req, res) => {
    const b = req.body || {};
    const rule = b.rule || {};
    const problems = store.problemsWith(rule);
    if (problems.length) return refuse(res, problems);

    const quote = b.quote || {};
    /* A SAMPLE ROW IN THE BOARD'S OWN SHAPE, so the same code path the board
       takes is the one the preview takes. */
    const row = {
      investorKey: quote.investorKey || 'sample',
      whiteLabel: quote.whiteLabel || 'Sample program',
      lender: quote.lender || null,
      investor: quote.investor || null,
      program: quote.program || 'Sample',
      product: quote.product || null,
      pricedBy: quote.source || null,
      priceBuild: {
        noteRate: quote.noteRate == null ? null : Number(quote.noteRate),
        price: quote.price == null ? 100 : Number(quote.price),
        borrowerPaidPoints: quote.points == null ? 0 : Number(quote.points),
      },
      terms: {
        ltv: quote.quotedLtv == null ? null : Number(quote.quotedLtv),
        dscr: quote.quotedDscr == null ? null : Number(quote.quotedDscr),
        termYears: quote.quotedTermYears == null ? null : Number(quote.quotedTermYears),
        dayLock: quote.quotedLockDays == null ? null : Number(quote.quotedLockDays),
        amortizationType: quote.amortization || null,
      },
      marginHoldback: quote.marginHoldback == null ? null : Number(quote.marginHoldback),
    };

    const engine = b.engine === 'combined' ? 'combined' : 'general';
    const out = overlay.apply([row], {
      rules: [{ ...rule, id: rule.id || 'preview', enabled: true }],
      scenario: b.scenario || {},
      engine,
    });

    const kept = out.programs[0] || null;
    const before = row.priceBuild.price;
    const after = kept && kept.priceBuild ? kept.priceBuild.price : null;
    res.json({
      ok: true,
      matched: !!(out.applied.length || out.ineligible.length || out.blocked.length),
      wouldStop: out.ineligible.length ? 'ineligible' : out.blocked.length ? 'block_investor' : null,
      reason: (out.ineligible[0] || out.blocked[0] || {}).reason || null,
      priceBefore: before,
      priceAfter: after,
      adjustPoints: kept && kept.houseRules ? kept.houseRules.adjustPoints : 0,
      did: kept && kept.houseRules ? kept.houseRules.applied : [],
      problems: out.problems,
      says: logic.summarize(rule.when),
      does: ruleActions.summarize(rule.then),
    });
  });

}

/* The recorder's own health, read lazily so this module never pulls the ledger
   (and its database handle) in for a test that only wants the pure halves. */
function ledgerStats() {
  try { return require('../pricing/rules/ledger').stats(); } catch (_) { return null; }
}

function makeRouter(opts = {}) {
  const router = express.Router();
  const superAdminOnly = opts.superAdminOnly !== false;
  router.use((req, res, next) => (!superAdminOnly || isSuperAdmin(req) ? next() : res.status(404).json({ error: 'not_found' })));
  attach(router);
  return router;
}

module.exports = { makeRouter, attach, _internals: { isSuperAdmin } };
