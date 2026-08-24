'use strict';

// HTTP for the STATUS MAP — the three layers of wording on the long-term side, in
// one read, so they can be looked at together and OURS can be renamed.
//
// Mounted at /api/lt/stages by src/longterm/index.js; staff authentication is
// applied at the mount seam in src/server.js, so this router imports no RTL auth
// code. READ-ONLY: it changes nothing. Renaming a stage or re-pointing a milestone
// is a SETTINGS change and goes through `PATCH /api/lt/settings`, which is the one
// writer, already validated and already audited — a second write door here would be
// a second way to change one thing.
//
// WHY THIS EXISTS. The owner asked for the report of every file's milestone and
// status *"so I can give you the exact mapping of what everything means. We need to
// rephrase this in our system with our own statuses, more user-friendly."* The three
// layers were built (§4.1.1) and both configurable settings existed, but there was
// nowhere to SEE them together: the generic settings screen deliberately shows a
// `map` read-only, because a free-text editor over the milestone ladder would let
// one mistyped brace destroy it. A purpose-built surface is the answer that rule
// points at — every choice a dropdown of stages that exist, so a typo is impossible.
//
// THE THIRD LAYER IS ENCOMPASS'S AND IS SHOWN READ-ONLY. `consumer_status` is the
// tenant's own borrower-facing wording, mirrored from Encompass, and Encompass is
// read-only to PILOT. It is displayed so a person can see what a client is being
// told, never edited here.

const express = require('express');
const router = express.Router();

const access = require('../access');
const db = require('../db');
const stages = require('../stages');
const settingsStore = require('../settings/store');
const milestoneCatalog = require('../lib/encompass-milestones');

/**
 * GET /api/lt/stages — the whole ladder, three layers wide.
 *
 * The COUNTS are what make this a decision surface rather than a diagram: "move
 * Waiting for Docs from Conditions Out to In Underwriting" is a different question
 * when it is one file than when it is ninety. They are counted through the
 * pipeline's OWN access rule, so this can never show a scoped viewer the size of a
 * book their pipeline would hide from them.
 */
router.get('/', async (req, res) => {
  try {
    const { settings } = await settingsStore.load().catch(() => ({ settings: {} }));
    const cfg = stages.configFrom(settings);
    const canManage = access.mayManagePeople(req.actor, settings);

    // Live counts, scoped exactly as the pipeline scopes its rows.
    const scope = access.pipelineScopeSql(access.accessFor(req.actor, settings), req.actor && req.actor.id, 1);
    const where = scope.where ? `WHERE ${scope.where}` : '';
    const { rows: counts } = await db.query(
      `SELECT COALESCE(NULLIF(TRIM(l.milestone_name), ''), '') AS milestone,
              COALESCE(NULLIF(TRIM(l.stage_key), ''), '') AS stage_key,
              count(*)::int AS n
         FROM lt_loans l ${where}
        GROUP BY 1, 2`,
      scope.params,
    );

    const byMilestone = new Map();
    const byStage = new Map();
    for (const r of counts) {
      byMilestone.set(stages.milestoneKey(r.milestone), (byMilestone.get(stages.milestoneKey(r.milestone)) || 0) + r.n);
      if (r.stage_key) byStage.set(r.stage_key, (byStage.get(r.stage_key) || 0) + r.n);
    }

    // OUR stages, in order, each with how many files are sitting in it.
    const ours = stages.stageList({ stages: cfg.stages }).map((s) => ({
      key: s.key, label: s.label, order: s.order, files: byStage.get(s.key) || 0,
    }));

    // ENCOMPASS's milestones. The catalog is the tenant's published ladder (db/547);
    // a milestone that is only ever SEEN on a loan and is not in the catalog still
    // has to appear, or the one row somebody needs to map would be the one row this
    // screen hides.
    let catalog = [];
    try { catalog = await milestoneCatalog.listMilestones({ includeArchived: false }); }
    catch (_) { catalog = []; }

    // PUNCTUATION-BLIND on BOTH sides (audit round 5, obs 2). This was the one
    // milestone-name join left on `normalizeMilestone`, which KEEPS punctuation:
    // consistent today only because the live ladder and the catalog happen to
    // spell "Cond. Approval" identically. The day they differ by a dot, a real
    // milestone is listed as a catalog STRAY and its file count is attached to
    // neither row — the same class obs 4 found in the board. Every other join
    // over these names already keys through `milestoneKey`.
    const seen = new Set(catalog.map((m) => stages.milestoneKey(m.milestoneName)));
    const strays = [...new Set(counts
      .map((r) => r.milestone)
      .filter((m) => m && !seen.has(stages.milestoneKey(m))))];

    const describe = (name, row) => {
      const stage = stages.stageForMilestone(name, cfg);
      return {
        milestone: name,
        sequence: row ? row.sequence : null,
        role: row ? (row.role || null) : null,
        // Encompass's own words for the client. Read-only — Encompass is read-only
        // to PILOT, and this is the tenant's wording, not ours to rewrite here.
        borrowerWording: row ? stages.consumerStatusOf(row) : null,
        stageKey: stage.mapped ? stage.key : null,
        mapped: stage.mapped,
        files: byMilestone.get(stages.milestoneKey(name)) || 0,
        // A milestone the catalog does not carry: it is on real loans, so it is
        // real, and it is exactly the row somebody has to answer for.
        inCatalog: !!row,
      };
    };

    const milestones = [
      ...catalog.map((m) => describe(m.milestoneName, m)),
      ...strays.map((m) => describe(m, null)),
    ].sort((a, b) => {
      if (a.sequence != null && b.sequence != null) return a.sequence - b.sequence;
      if (a.sequence != null) return -1;
      if (b.sequence != null) return 1;
      return String(a.milestone).localeCompare(String(b.milestone));
    });

    res.json({
      stages: ours,
      milestones,
      unmappedStage: { ...stages.UNMAPPED_STAGE, files: byStage.get(stages.UNMAPPED_STAGE.key) || 0 },
      canManage,
      // Named on the payload so the screen never has to know WHICH settings carry
      // this, and so "what do I change to rename a stage" is answerable from the
      // response rather than from the source.
      settingKeys: { stages: 'stages.order', map: 'stages.map' },
      note: 'Renaming one of our stages changes only the words on our screens. '
        + 'What the borrower sees comes from Encompass and is shown here read-only.',
    });
  } catch (e) {
    console.error('[lt] status map failed:', (e && e.message) || e);
    res.status(500).json({ error: 'Could not load the status map.' });
  }
});

module.exports = router;
