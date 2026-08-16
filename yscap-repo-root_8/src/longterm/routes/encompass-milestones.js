'use strict';

// HTTP for the Encompass milestone / status catalog.
// Mounted at /api/lt/encompass by src/longterm/index.js. Staff authentication is
// applied at the mount seam in src/server.js (like the /api/admin routers), so
// this router imports no RTL auth code. Read-only.

const express = require('express');
const router = express.Router();
const catalog = require('../lib/encompass-milestones');

// GET /api/lt/encompass/milestones — the whole catalog, ordered by pipeline
// position. `?includeArchived=false` hides Encompass-archived milestones.
router.get('/milestones', async (req, res) => {
  try {
    const includeArchived = String(req.query.includeArchived ?? 'true') !== 'false';
    const milestones = await catalog.listMilestones({ includeArchived });
    res.json({ milestones, count: milestones.length });
  } catch (e) {
    console.error('[lt] list Encompass milestones failed:', (e && e.message) || e);
    res.status(500).json({ error: 'Could not load the Encompass milestone catalog.' });
  }
});

// GET /api/lt/encompass/milestones/:id — one milestone by its Encompass id.
router.get('/milestones/:id', async (req, res) => {
  try {
    const milestone = await catalog.getMilestone(req.params.id);
    if (!milestone) return res.status(404).json({ error: 'No such milestone.' });
    res.json(milestone);
  } catch (e) {
    console.error('[lt] get Encompass milestone failed:', (e && e.message) || e);
    res.status(500).json({ error: 'Could not load the milestone.' });
  }
});

module.exports = router;
