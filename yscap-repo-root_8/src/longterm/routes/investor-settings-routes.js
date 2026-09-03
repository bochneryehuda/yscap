'use strict';
/**
 * THE INVESTOR SETTINGS DOORS — ONE DEFINITION, MOUNTED BY BOTH ENGINES.
 *
 * ── WHY THIS FILE EXISTS ───────────────────────────────────────────────────
 * Four stored settings decide, for every investor, whether it prices at all,
 * which rate sheet it is fetched from, what a client may call it, and what
 * margin is held back. They were the Combined Pricing Engine's own doors. The
 * owner then directed (2026-09-03) that the SIDE-BY-SIDE LIST — the one screen
 * where all four are set — belongs in the GENERAL Pricing Engine's settings:
 *
 *   *"I want the side-by-side list… in the settings of the regular pricing
 *   engine… three options should be like a nice modern design: price it from
 *   Lender Price, price it from LoanNEX, or turn off this investor."*
 *
 * ⛔ SO THE DOORS ARE LIFTED OUT RATHER THAN COPIED. Two engines writing four
 * settings through two sets of route bodies is two chances for the validation,
 * the refusals and the answer shape to drift — and the one that drifts is the
 * one somebody prices a loan on. This factory is mounted TWICE and is the only
 * definition; neither engine can disagree with the other about what a save does.
 *
 * ⛔ AND THE GENERAL ENGINE'S MOUNT IS NOT BEHIND THE COMBINED ENGINE'S KILL
 * SWITCH. `LT_COMBINED_PRICING=off` hides the engine the owner is auditing
 * privately; it must never take the general engine's own settings screen down
 * with it, which is exactly what mounting the combined router twice would have
 * done. Each mount carries its own gate.
 *
 * PURE OF ENGINE: this file knows nothing about pricing a board. It reads and
 * writes four settings and answers with the shape a settings screen draws.
 */

const express = require('express');

const settingsStore = require('../settings/store');
const routing = require('./../pricing/investor-routing');
const investorLinks = require('./../pricing/investor-links');
const roster = require('./../pricing/investor-roster');
const vendorMargin = require('./../pricing/vendor-margin');
const investorConfig = require('./../pricing/investor-config');
const sightings = require('./../pricing/investor-sightings');
const investorSettings = require('./../pricing/investor-settings');
const sourceMisses = require('./../pricing/source-misses');
const sheetConnection = require('./../pricing/sheet-connection');
const { whiteLabelOf } = require('../lenderprice/investor-programs');

const reasonOf = (e) => String((e && e.message) || e || 'unknown').slice(0, 300);

/**
 * IS EACH RATE SHEET SIGNED IN — asked of the client that owns the answer.
 *
 * ⛔ LAZY AND CAUGHT, both deliberately. This file is otherwise pure of the
 * pricing engines, and a settings screen must never fail to draw because a
 * vendor module would not load. An unreadable answer becomes `null`, which
 * `sheet-connection` reads as UNKNOWN and says so — never as "connected".
 *
 * `configured()` is an environment read on both clients: no network, no vendor
 * call, nothing spent.
 */
function sheetConfigured() {
  /* PLAIN STRING REQUIRES, ONE PER SHEET — never a computed path. A dynamic
     require() is the one import shape the product-separation gate cannot follow,
     and it refuses the file outright (it caught exactly this on the first cut).
     The repetition is the point: every module this file can reach is readable. */
  const call = (fn) => { try { return typeof fn === 'function' ? fn() : null; } catch (_) { return null; } };
  let lenderprice = null;
  let loannex = null;
  try { lenderprice = call(require('./../lenderprice/client').configured); } catch (_) { lenderprice = null; }
  try { loannex = call(require('./../loannex/client').configured); } catch (_) { loannex = null; }
  return { lenderprice, loannex };
}

/* The four stored reads, through the ONE module that owns their key strings. */
const settingsRaw = () => investorConfig.investorsRaw();
const holdbackRaw = () => investorConfig.holdbackRaw();
const linksRaw = () => investorConfig.linksRaw();
const customRaw = () => investorConfig.customRaw();

/**
 * Mount the four settings doors onto a router.
 *
 * @param {import('express').Router} router  the router to attach them to
 */
function attach(router) {
  /**
   * THE MARGIN HOLDBACK — read it, and change it.
   *
   * Owner-directed 2026-08-30: *"there should always be in the settings the
   * possibility to move up the margin hold back, remove the margin hold back, or
   * move it down."*
   *
   * The answer always says WHERE the number came from and what the pre-fill is,
   * so a screen can offer the way back to 0.25 rather than leaving somebody to
   * remember it — the same rule the investor rows follow.
   */
  router.get('/margin-holdback', async (req, res) => {
    const saved = await holdbackRaw();
    const r = vendorMargin.resolveHoldback('loannex', saved);
    res.json({
      ok: true,
      points: r.points,
      origin: r.origin,
      problem: r.problem,
      prefill: vendorMargin.holdbackFor('loannex'),
      max: vendorMargin.MAX_HOLDBACK_POINTS,
      // Stated rather than left to be inferred: the OTHER program is not
      // configurable here, and the reason is a fact about its feed.
      note: 'Held back on every LoanNEX quote before the two programs are compared. Lender Price is not '
        + 'listed because its feed already carries our holdback — taking it again there would double it.',
    });
  });

  /**
   * WRITE. `points: null` returns it to the standing 0.25; `points: 0` removes
   * it deliberately.
   *
   * ⛔ A REFUSED VALUE IS REFUSED, NOT STORED. `resolveHoldback` is deliberately
   * forgiving at READ time (a bad stored value keeps the 0.25 rather than taking
   * the engine down), and that forgiveness must not become a way to save
   * nonsense: if the door accepted it, the board would go on quoting 0.25 while
   * the screen showed whatever was typed, and the two would disagree forever.
   * So the door runs the SAME resolver and refuses anything it reports a problem
   * with, naming the problem.
   */
  router.put('/margin-holdback', async (req, res) => {
    const b = req.body || {};
    const raw = b.points === undefined ? b : b.points;
    if (raw === null || raw === '') {
      try {
        await settingsStore.save({ 'pricing.combinedMarginHoldback': null }, { scope: 'company', staffId: (req.actor && req.actor.id) || null });
      } catch (e) {
        return res.status(500).json({ ok: false, error: 'save_failed', message: reasonOf(e) });
      }
      const r = vendorMargin.resolveHoldback('loannex', undefined);
      return res.json({ ok: true, points: r.points, origin: r.origin, problem: null, prefill: vendorMargin.holdbackFor('loannex'), max: vendorMargin.MAX_HOLDBACK_POINTS });
    }
    const check = vendorMargin.resolveHoldback('loannex', raw);
    if (check.problem) {
      return res.status(422).json({ ok: false, error: check.problem.error, message: check.problem.message });
    }
    try {
      await settingsStore.save({ 'pricing.combinedMarginHoldback': check.points }, { scope: 'company', staffId: (req.actor && req.actor.id) || null });
    } catch (e) {
      return res.status(500).json({ ok: false, error: 'save_failed', message: reasonOf(e) });
    }
    res.json({ ok: true, points: check.points, origin: check.origin, problem: null, prefill: vendorMargin.holdbackFor('loannex'), max: vendorMargin.MAX_HOLDBACK_POINTS });
  });

  router.get('/investors', async (req, res) => {
    const src = await settingsRaw();
    const c = await customRaw();
    const sight = await investorConfig.sightingsRaw();
    const d = routing.describeSettings(src.raw, { origin: src.origin, custom: c.custom });
    /**
     * WHICH RATE SHEET HAS ACTUALLY PRODUCED THIS INVESTOR — measured, never typed
     * (owner-directed 2026-09-03: *"which systems that investor is available on"*, and
     * *"the other option is locked out, but the investor can always be turned off"*).
     *
     * ⛔ THE LOCK IS THE ANSWER'S, NOT THE SCREEN'S. A browser deciding for itself which
     * button to grey out would be a second copy of the rule, free to disagree with the
     * board; `sightings.availabilityFor` states the three answers and the row carries
     * `lockedOut` already resolved. `off` is never in that list — the owner's rule is
     * that an investor can always be turned off, whatever the register says.
     */
    const investorsWithAvailability = d.investors.map((r) => {
      const availability = sightings.availabilityFor(r.key, sight);
      /* The source THIS investor is set to is passed so it can never be locked out —
         a row routed to LoanNEX whose LoanNEX button is dead cannot be re-routed or
         turned off and back on, and reads as a broken screen. */
      return {
        ...r,
        availability,
        lockedOut: sightings.lockedOutFor(r.key, sight, r.source),
        /* WHETHER THIS ROW CARRIES A SETTING SOMEBODY SAVED — answered HERE, by the
           one definition, so the screen's "use the pre-fill" control and the rule that
           KEEPS the row on this list can never disagree about the same row. */
        carriesSetting: investorSettings.carriesOwnSetting(r),
      };
    });
    /**
     * THE OWNER'S LIST, NOT OUR WHOLE REGISTRY (owner-reported 2026-09-03: *"the list of
     * lenders that I put in my settings is way bigger than the list I gave you… I gave you
     * a list only of ones that have white-labeled names"*).
     *
     * The rule lives in `investorSettings.belongsOnSettingsList` — one definition, with the
     * reasoning — and is applied HERE rather than inside `roster()` on purpose: the board
     * builds `expectedFromLoanNex` from the full roster, so narrowing that would change
     * which investors it expects and reports as missing. This narrows the SCREEN only.
     *
     * A new investor a rate sheet has actually produced still comes through, off and
     * unnamed, which is the case the owner asked for by name.
     */
    const shown = investorsWithAvailability.filter(
      (r) => investorSettings.belongsOnSettingsList(r, r.availability),
    );
    /**
     * WHY AN INVESTOR SET TO A RATE SHEET MIGHT NOT REACH THE BOARD AT ALL.
     *
     * The pricing page stays silent about a missing investor by the owner's own
     * direction; this is the screen where that silence is answerable. Counted
     * over the rows ACTUALLY SHOWN so the sentence and the list agree — a
     * message reading "6 investors" above five countable rows is the same
     * self-contradiction the summary block above was fixed for.
     */
    const connections = sheetConnection.connectionsFor(
      sheetConfigured(), sheetConnection.routedCounts(shown),
    );
    /* WHEN EACH SHEET LAST ACTUALLY ANSWERED. `configured()` reads the
       ENVIRONMENT, so a login that is set but WRONG reports connected and still
       produces nothing; this is the fact that tells those two apart. Read from
       the register the board already writes — nothing new is recorded. */
    const lastAnswered = sheetConnection.lastAnsweredAll(sight && sight.boards);
    res.json({
      ok: true, ...d,
      investors: shown,
      connections,
      lastAnswered,
      /* THE COUNTS DESCRIBE WHAT IS ON SCREEN. `describeSettings` totals the whole roster,
         so spreading it unchanged beside a narrowed list would print "43" above 26 rows and
         make the screen contradict itself. */
      summary: {
        ...d.summary,
        total: shown.length,
        on: shown.filter((r) => r.enabled).length,
        off: shown.filter((r) => !r.enabled).length,
        fromLenderPrice: shown.filter((r) => r.enabled && r.source === 'lenderprice').length,
        fromLoanNex: shown.filter((r) => r.enabled && r.source === 'loannex').length,
        fromBoth: shown.filter((r) => r.enabled && r.source === 'both').length,
        missingWhiteLabel: shown.filter((r) => r.whiteLabelMissing).length,
        custom: shown.filter((r) => r.custom).length,
        withExtraHoldback: shown.filter((r) => r.holdbackOrigin === 'setting' && r.holdback !== 0).length,
      },
      /* What the screen is NOT showing, and why — so an empty-looking list is never a
         mystery and nobody goes hunting for an investor that is deliberately absent. */
      hidden: {
        count: investorsWithAvailability.length - shown.length,
        reason: 'no white-label name, never seen on a rate sheet, and no setting of its own',
      },
      /* Said plainly so a screen can explain an empty column rather than reading a
         cold register as "this investor is on nothing". */
      sightings: {
        boards: sight.boards,
        known: Object.keys(sight.investors || {}).length,
        problem: sight.problem || null,
      },
      customInvestors: { count: c.custom.size, problems: c.problems, problem: c.problem },
      // The ones with no client-safe name yet, named out loud so somebody can
      // go and name them — an investor with no white label may never be put in
      // front of a borrower or a broker.
      needsWhiteLabel: shown.filter((r) => r.whiteLabelMissing).map((r) => ({ key: r.key, investor: r.label })),
      storedProblem: src.problem || null,
    });
  });

  /**
   * WRITE. Super-admin only — which the whole router already is, so there is no
   * second gate here and no chance of the two drifting apart.
   *
   * ⛔ THE WHOLE MAP IS REPLACED, deliberately, and the screen always sends every
   * row it is showing. A per-key patch would make "this investor has no setting"
   * and "this investor's setting was not in the request" indistinguishable, so
   * there would be no way to take a setting back OFF and return an investor to
   * its pre-fill — which is the one thing somebody auditing this will want to do
   * most often.
   *
   * Every row is validated by the SAME `readSettings` the board reads with, and
   * a rejected row is reported BY NAME rather than dropped: a typo that silently
   * hides a lender is exactly what that validation exists to prevent. A save that
   * carries any problem is REFUSED WHOLE — a half-applied settings form leaves
   * somebody unable to tell what took effect.
   */
  router.put('/investors', async (req, res) => {
    const body = (req.body && typeof req.body === 'object' && req.body.investors) || req.body || {};
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return res.status(400).json({ ok: false, error: 'not_an_object', message: 'Send an object of investorKey -> {source, enabled, whiteLabel, holdback}.' });
    }
    // Validated against the EFFECTIVE roster, so a row for an investor somebody
    // added by hand is a known investor here exactly as it is on the board.
    const c0 = await customRaw();
    const check = routing.readSettings(body, c0.custom);
    if (check.problems.length) {
      return res.status(422).json({ ok: false, error: 'invalid_settings', problems: check.problems });
    }
    try {
      await settingsStore.save({ 'pricing.combinedInvestors': check.settings }, {
        scope: 'company', staffId: (req.actor && req.actor.id) || null,
      });
    } catch (e) {
      return res.status(500).json({ ok: false, error: 'save_failed', message: reasonOf(e) });
    }
    const src = await settingsRaw();
    const c = await customRaw();
    const d = routing.describeSettings(src.raw, { origin: src.origin, custom: c.custom });
    res.json({ ok: true, saved: Object.keys(check.settings).length, ...d,
      needsWhiteLabel: d.investors.filter((r) => r.whiteLabelMissing).map((r) => ({ key: r.key, investor: r.label })) });
  });

  /**
   * THE INVESTOR LINKS — "this one and this one are the same investor".
   *
   * Owner-directed 2026-08-30. GET returns the map a person has recorded plus
   * every investor the registry knows, so the screen can offer a list to pick
   * from rather than asking somebody to type a key.
   *
   * It deliberately does NOT price anything. The side-by-side of what each
   * program actually called an investor comes back on the PRICE answer
   * (`investorPairing`), because that is the only place the real names exist —
   * asking this door for them would mean pricing two vendors to draw a settings
   * screen.
   */
  router.get('/investor-links', async (req, res) => {
    const cur = await linksRaw();
    const c = await customRaw();
    res.json({
      ok: true,
      links: cur.raw,
      linkCount: Object.keys(cur.raw || {}).length,
      problem: cur.problem || null,
      /**
       * THE PICK-LIST, A TO Z (owner-directed 2026-09-02: *"the list should be
       * alphabetical so I can find a name"*).
       *
       * It was ordered by how often the registry had SEEN each investor, which
       * puts the common ones on top and leaves everything else in an order
       * nobody can predict — on a list of forty-odd names, hunting. Sorted here
       * as well as on the screen so the answer is already in order for anything
       * that renders it without sorting.
       *
       * The list is the EFFECTIVE roster, so an investor somebody added by hand
       * is linkable the moment it exists.
       */
      investors: roster.effectiveList(c.custom)
        .map((i) => ({
          key: i.key,
          label: i.label,
          whiteLabel: whiteLabelOf(i.key, c.custom) || null,
          custom: i.custom === true,
        }))
        .sort((a, b) => a.label.localeCompare(b.label)),
      customInvestors: { count: c.custom.size, problems: c.problems, problem: c.problem },
    });
  });

  /**
   * RECORD THE LINKS. The WHOLE map is sent, exactly like the investor settings
   * beside it — a partial write cannot express a REMOVED link, and a link
   * somebody meant to delete quietly surviving is the worst outcome here.
   *
   * REFUSES RATHER THAN REPAIRS (422 with every problem named): a link that
   * points at an investor this system does not know cannot be honoured, and
   * storing it anyway would look to the person like it had worked.
   */
  router.put('/investor-links', async (req, res) => {
    const cLinks = await customRaw();
    const check = investorLinks.validateLinks((req.body || {}).links, cLinks.custom);
    if (!check.ok) return res.status(422).json({ ok: false, error: 'bad_links', problems: check.problems });
    try {
      await settingsStore.save({ [investorLinks.SETTING_KEY]: check.links }, {
        scope: 'company', staffId: (req.actor && req.actor.id) || null,
      });
    } catch (e) {
      return res.status(500).json({ ok: false, error: 'save_failed', message: reasonOf(e) });
    }
    const cur = await linksRaw();
    res.json({ ok: true, saved: Object.keys(check.links).length, links: cur.raw });
  });


  /**
   * THE INVESTORS SOMEBODY ADDED BY HAND (owner-directed 2026-09-02: *"I want to
   * be able to add a new investor myself… And I need to give it our own name,
   * the way the others have one."*).
   *
   * GET returns the stored map AND the list the screen draws, already in order,
   * beside the whole effective roster — so the "is this key already taken?"
   * question is answerable on the screen rather than only at the door.
   */
  router.get('/custom-investors', async (req, res) => {
    const c = await customRaw();
    res.json({
      ok: true,
      investors: c.raw,
      count: c.custom.size,
      list: [...c.custom.values()]
        .map((e) => ({
          key: e.key,
          label: e.label,
          whiteLabel: e.whiteLabel || null,
          aliases: e.aliases.slice(),
          addedBy: e.addedBy || null,
          addedAt: e.addedAt || null,
        }))
        .sort((a, b) => a.label.localeCompare(b.label)),
      problems: c.problems,
      problem: c.problem || null,
      // Every key already in use, registry and hand-added together, so the form
      // can say "that key is taken" before anybody presses save.
      keysInUse: roster.effectiveList(c.custom).map((i) => i.key),
    });
  });

  /**
   * ADD, EDIT AND REMOVE THEM. The WHOLE map is sent, exactly like the investor
   * settings and the links beside it — a partial write cannot express a REMOVED
   * investor, and an investor somebody meant to delete quietly surviving is the
   * worst outcome here.
   *
   * REFUSES RATHER THAN REPAIRS. `validateCustom` is the same door the settings
   * store runs on the way in (it is declared beside the key), so a save that
   * gets past this one cannot fail there: a bad key, a label or alias that
   * collides with a spelling already recorded, or a white label that would not
   * survive the audience scrub is answered with every problem NAMED.
   *
   * ⛔ AND AN INVESTOR STILL BEING USED IS NEVER REMOVED SILENTLY. A link or a
   * settings row pointing at a key nobody knows would be refused by its own
   * door on the next save, leaving somebody with a screen they cannot save and
   * no way to see why — so the removal is refused HERE, naming what still
   * points at it.
   */
  router.put('/custom-investors', async (req, res) => {
    const body = (req.body && typeof req.body === 'object' && req.body.investors) || req.body || {};
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return res.status(400).json({ ok: false, error: 'not_an_object', message: 'Send an object of investor key -> { label, whiteLabel, aliases }.' });
    }

    const check = roster.validateCustom(body);
    if (!check.ok) {
      return res.status(422).json({ ok: false, error: 'invalid_custom_investors', problems: check.problems });
    }

    const before = await customRaw();
    const gone = [...before.custom.keys()].filter((k) => !Object.prototype.hasOwnProperty.call(check.custom, k));
    if (gone.length) {
      const [linksNow, settingsNow] = await Promise.all([linksRaw(), settingsRaw()]);
      // `readLinks` answers a MAP, keyed on the normalized spelling and carrying
      // the person's own spelling on the entry — that spelling is what the
      // refusal has to quote, because it is the one they are looking at.
      const links = investorLinks.readLinks(linksNow.raw, before.custom).links || new Map();
      const rows = routing.readSettings(settingsNow.raw, before.custom).settings || {};
      const stillUsed = [];
      for (const key of gone) {
        const spellings = [...links.values()].filter((v) => v && v.key === key).map((v) => v.name);
        const hasRow = Object.prototype.hasOwnProperty.call(rows, key);
        if (!spellings.length && !hasRow) continue;
        const label = (before.custom.get(key) || {}).label || key;
        const parts = [];
        if (spellings.length) parts.push(`${spellings.length} linked spelling${spellings.length === 1 ? '' : 's'} (${spellings.join(', ')})`);
        if (hasRow) parts.push('a saved setting of its own');
        stillUsed.push({
          key,
          problem: 'still_in_use',
          message: `"${label}" still has ${parts.join(' and ')}. Take those off first, then remove the investor.`,
        });
      }
      if (stillUsed.length) {
        return res.status(422).json({ ok: false, error: 'invalid_custom_investors', problems: stillUsed });
      }
    }

    // WHO ADDED IT AND WHEN, stamped once and never rewritten: an edit to the
    // label is not a new investor, and overwriting the stamp would lose the one
    // record of where the name came from.
    const now = new Date().toISOString();
    const actor = (req.actor && req.actor.id) || null;
    const clean = {};
    for (const [key, entry] of Object.entries(check.custom)) {
      const prior = before.custom.get(key);
      clean[key] = {
        ...entry,
        addedBy: (prior && prior.addedBy) || entry.addedBy || actor,
        addedAt: (prior && prior.addedAt) || entry.addedAt || now,
      };
    }

    try {
      await settingsStore.save({ [roster.SETTING_KEY]: clean }, {
        scope: 'company', staffId: actor,
      });
    } catch (e) {
      // The store runs the SAME door again on the way in, so a refusal here is
      // reported as one rather than as a mystery 500.
      if (e && e.status === 400 && Array.isArray(e.problems) && e.problems.length) {
        return res.status(422).json({ ok: false, error: 'invalid_custom_investors', problems: e.problems });
      }
      return res.status(500).json({ ok: false, error: 'save_failed', message: reasonOf(e) });
    }

    const after = await customRaw();
    res.json({
      ok: true,
      saved: Object.keys(clean).length,
      removed: gone.length,
      investors: after.raw,
      count: after.custom.size,
      list: [...after.custom.values()]
        .map((e) => ({
          key: e.key,
          label: e.label,
          whiteLabel: e.whiteLabel || null,
          aliases: e.aliases.slice(),
          addedBy: e.addedBy || null,
          addedAt: e.addedAt || null,
        }))
        .sort((a, b) => a.label.localeCompare(b.label)),
      problems: after.problems,
      problem: after.problem || null,
      keysInUse: roster.effectiveList(after.custom).map((i) => i.key),
    });
  });

  /**
   * WHAT MIGHT THIS NAME BE? A proposal, never applied.
   *
   * The screen asks this for a spelling nobody has linked, and a person clicks
   * one. Nothing here writes: an automatic join would put one investor's pricing
   * under another investor's name, and that name is the one thing a client may
   * see.
   */
  router.get('/investor-links/suggest', async (req, res) => {
    const c = await customRaw();
    const name = String((req.query && req.query.name) || '').trim();
    if (!name) return res.status(400).json({ ok: false, error: 'missing_name', message: 'Send the spelling you want suggestions for.' });
    res.json({ ok: true, name, suggestions: investorLinks.suggestFor(name, { custom: c.custom }) });
  });

  /**
   * THE MISSING-INVESTOR REVIEW — the record behind the silence.
   *
   * Owner-directed 2026-09-03: an investor the second rate sheet answered about and did not
   * carry is left off the board SILENTLY and the super admin is emailed, plus *"a manual
   * review section recording the scenario, which investor LoanNEX missed, and whether Lender
   * Price had it, so the cause can be dug into."* This is the read of that record.
   *
   * ⛔ AN UNREADABLE LOG SAYS SO. Answering with an empty list would read as "nothing has
   * ever gone wrong", which is the one thing this section must never claim.
   */
  router.get('/misses', async (req, res) => {
    const r = await sourceMisses.list({
      openOnly: String((req.query && req.query.open) || '') === '1',
      limit: req.query && req.query.limit,
    });
    res.json({ ok: true, ...r });
  });

  /**
   * MARK ONE LOOKED AT, with the reviewer's own note — and un-mark it, because a row settled
   * by mistake must be recoverable without a second door.
   */
  router.put('/misses/:id', async (req, res) => {
    const b = req.body || {};
    const r = await sourceMisses.review(req.params.id, {
      reviewed: b.reviewed === false ? false : true,
      note: b.note,
      staffId: (req.actor && req.actor.id) || null,
    });
    if (!r.ok) return res.status(r.error === 'not_found' ? 404 : 500).json(r);
    res.json(r);
  });

  return router;
}

/** A router carrying nothing but the settings doors — for a caller that wants its own mount. */
function makeRouter() {
  return attach(express.Router());
}

module.exports = { attach, makeRouter, _internals: { settingsRaw, holdbackRaw, linksRaw, customRaw, reasonOf } };
