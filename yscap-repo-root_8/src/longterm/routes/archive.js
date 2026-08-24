'use strict';
/**
 * LONG-TERM — the archive screen's HTTP: Encompass's deleted loans, listed and
 * permanently removable.
 *
 * Owner-directed 2026-08-23: *"Everything that is now in the trash folder should go
 * in your archive folder and should not even be visible as part of the pipeline …
 * It should be totaled in the archive folder, and you can click over there to
 * delete it permanently."*
 *
 * WHAT "DELETE PERMANENTLY" MEANS HERE — and what it can never mean. It removes
 * PILOT's MIRROR ROW (and everything hanging off it). It cannot touch Encompass:
 * that connection is read-only, always, and the Encompass copy is already sitting
 * in Encompass's own trash. The guard lives in the statement itself
 * (src/longterm/trash.js): the delete matches only a row whose folder IS the
 * trash, so no id anybody passes can remove a live loan.
 *
 * GATES: viewing is the people-managing admins (`access.mayManagePeople`, the same
 * gate the sync button uses); DELETING is the super-admin alone — it is the one
 * destructive action on this side, so it takes the top authority.
 *
 * SEPARATION: `lt_*` tables only, through trash.js.
 */

const express = require('express');
const router = express.Router();

const access = require('../access');
const trash = require('../trash');
const settingsStore = require('../settings/store');

async function requireArchiveAdmin(req, res, next) {
  try {
    const { settings } = await settingsStore.load();
    if (!access.mayManagePeople(req.actor, settings)) {
      return res.status(403).json({ error: 'Only an administrator can open the long-term archive.' });
    }
    return next();
  } catch (e) {
    console.error('[lt] archive gate failed:', (e && e.message) || e);
    return res.status(503).json({ error: 'Could not check your permissions just now. Try again in a moment.' });
  }
}

function requireSuperAdmin(req, res, next) {
  const role = String((req.actor && req.actor.role) || '');
  if (role !== 'super_admin') {
    return res.status(403).json({ error: 'Only a super-admin can permanently delete an archived file.' });
  }
  return next();
}

// GET /api/lt/archive — every deleted-in-Encompass loan, newest first.
router.get('/', requireArchiveAdmin, async (_req, res) => {
  try {
    const rows = await trash.listArchive();
    res.json({ ok: true, count: rows.length, loans: rows });
  } catch (e) {
    console.error('[lt] archive list failed:', (e && e.message) || e);
    res.status(500).json({ error: 'Could not load the archive.' });
  }
});

// DELETE /api/lt/archive/:id — permanently remove ONE archived loan from PILOT.
router.delete('/:id', requireArchiveAdmin, requireSuperAdmin, async (req, res) => {
  const id = String(req.params.id || '');
  if (!/^[0-9a-f-]{36}$/i.test(id)) return res.status(400).json({ error: 'That is not a file id.' });
  try {
    const gone = await trash.deleteArchivedLoan(id);
    if (!gone) {
      // Two honest possibilities, one safe answer: it was already deleted, or the
      // id names a LIVE loan — which the statement refuses by construction.
      return res.status(404).json({ error: 'That file is not in the archive (already deleted, or not a deleted file).' });
    }
    console.log(`[lt] archive: ${req.actor.id} permanently deleted mirror row for ${gone.loan_number || gone.id}`);
    res.json({ ok: true, deleted: { loanNumber: gone.loan_number || null } });
  } catch (e) {
    console.error('[lt] archive delete failed:', (e && e.message) || e);
    res.status(500).json({ error: 'Could not delete that file. Nothing was removed.' });
  }
});

// POST /api/lt/archive/delete-all — empty the archive. Same authority, one click.
router.post('/delete-all', requireArchiveAdmin, requireSuperAdmin, async (req, res) => {
  try {
    const out = await trash.deleteAllArchived();
    console.log(`[lt] archive: ${req.actor.id} emptied the archive — ${out.deleted} deleted, ${out.failed.length} failed`);
    res.json({ ok: true, ...out });
  } catch (e) {
    console.error('[lt] archive delete-all failed:', (e && e.message) || e);
    res.status(500).json({ error: 'Could not empty the archive.' });
  }
});

module.exports = router;
