#!/usr/bin/env node
'use strict';
/**
 * The remove-an-entity feature's structural guards, no database (owner-directed
 * 2026-08-10). The end-to-end behavior is proven by test-entity-remove-route-db.js;
 * this pins the things a DB test cannot, and the things that must never regress:
 *   · the module LOADS (a wrong require path — './db' vs '../db' — would 500 every
 *     door; this file catches that class the moment it is introduced);
 *   · both doors carry the HARD super_admin gate;
 *   · the migration creates entity_removals with the action CHECK;
 *   · the client exposes the two methods the screen calls.
 */
const fs = require('fs');
const path = require('path');
const R = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log(`FAIL ${m}`); } };

// 1) The module loads with no database in reach and exposes its two functions.
const er = require('../src/lib/entity-remove');
ok(typeof er.previewRemoval === 'function', 'exposes previewRemoval');
ok(typeof er.removeEntity === 'function', 'exposes removeEntity');
ok(er._internals && typeof er._internals.otherOwners === 'function', 'exposes its internals for testing');
ok(er._internals && typeof er._internals.classifyUsage === 'function', 'exposes the usage-tier classifier');

// 1b) THE TIER RULE (owner-directed 2026-08-10): an orphan or an in-progress-only
//     entity is removable by ANYBODY; a CLOSED (funded) loan or a TRACK RECORD locks
//     it to super_admin; and the in-progress files are exactly the reopen set.
const cls = er._internals.classifyUsage;
ok(cls({ vesting: [], trackRecords: 0, pillarRefs: 0 }).requiredLevel === 'anybody', 'an orphan entity is removable by anybody');
ok(cls({ vesting: [{ id: 'a', status: 'underwriting' }] }).requiredLevel === 'anybody', 'an in-progress-only entity is removable by anybody');
ok(cls({ vesting: [{ id: 'a', status: 'underwriting' }] }).liveApps.length === 1, 'an in-progress file is a reopen target');
ok(cls({ vesting: [{ id: 'a', status: 'funded' }] }).requiredLevel === 'super_admin', 'a funded (closed) loan locks removal to super_admin');
ok(cls({ vesting: [{ id: 'a', status: 'funded' }] }).liveApps.length === 0, 'a funded loan is never a reopen target');
ok(cls({ vesting: [{ id: 'a', status: 'declined' }] }).requiredLevel === 'anybody', 'a declined (dead) file does not lock removal');
ok(cls({ vesting: [{ id: 'a', status: 'declined' }] }).liveApps.length === 0, 'a terminal file is never a reopen target');
ok(cls({ vesting: [], trackRecords: 1, pillarRefs: 0 }).requiredLevel === 'super_admin', 'a track-record line locks removal to super_admin');
ok(cls({ vesting: [], trackRecords: 0, pillarRefs: 1 }).requiredLevel === 'super_admin', 'track-record pillar evidence locks removal to super_admin');
ok(cls({ vesting: [{ id: 'a', status: 'underwriting' }, { id: 'b', status: 'funded' }] }).requiredLevel === 'super_admin'
   && cls({ vesting: [{ id: 'a', status: 'underwriting' }, { id: 'b', status: 'funded' }] }).liveApps.map((x) => x.id).join() === 'a',
   'an entity on a funded AND an in-progress file is super_admin-only, and only the in-progress file reopens');

// 2) The doors gate on BORROWER ACCESS (not a super_admin hard-gate), and the TIER
//    is enforced inside the module. The old requireRole('super_admin') on the route
//    is GONE on purpose — do not reintroduce it (it would lock out the anybody tier).
const staff = fs.readFileSync(path.join(R, 'src/routes/staff.js'), 'utf8');
const erSrc = fs.readFileSync(path.join(R, 'src/lib/entity-remove.js'), 'utf8');
ok(!/removal-preview',\s*requireRole\('super_admin'\)/.test(staff)
   && !/\/remove',\s*requireRole\('super_admin'\)/.test(staff),
   'neither door hard-gates super_admin any more — the tier is enforced in the module');
ok(/removal-preview',\s*async \(req, res\) => \{\s*[\r\n]+\s*if \(!\(await canSeeBorrower\(req\)\)\)/.test(staff),
   'the preview door gates on borrower access');
ok(/\/llcs\/:llcId\/remove',\s*async \(req, res\) => \{\s*[\r\n]+\s*if \(!\(await canSeeBorrower\(req\)\)\)/.test(staff),
   'the remove door gates on borrower access');
ok(/actorRole:\s*\(req\.actor && req\.actor\.role\)/.test(staff), 'the route hands the actor role to the module');
// The module ENFORCES the tier itself and refuses a non-super-admin on a locked entity.
ok(/requiredLevel === 'super_admin' && actorRole !== 'super_admin'/.test(erSrc),
   'the module refuses a non-super-admin on a closed-loan / track-record entity');
// A DELETE reopens the vesting condition (rtl_p1_llc) on the IN-PROGRESS files, in the txn.
ok(/rtl_p1_llc/.test(erSrc) && /reopenedAppIds/.test(erSrc),
   'a DELETE reopens rtl_p1_llc on in-progress files so they cannot clear to close');
// The remove door audits and re-syncs un-vested files.
ok(/entity_removed_from_profile/.test(staff), 'the removal is audited');
ok(/for \(const appId of out\.affectedAppIds/.test(staff), 'un-vested files are re-synced after the removal');

// 3) The migration creates entity_removals with the two-action CHECK.
const mig = fs.readFileSync(path.join(R, 'db/514_entity_removals.sql'), 'utf8');
ok(/CREATE TABLE IF NOT EXISTS entity_removals/.test(mig), 'db/514 creates entity_removals (idempotent)');
ok(/action\s+text NOT NULL CHECK \(action IN \('deleted','transferred'\)\)/.test(mig), 'action is constrained to deleted|transferred');
ok(/entity_snapshot\s+jsonb NOT NULL/.test(mig), 'the recovery snapshot is required');
ok(!/REFERENCES\s+llcs/.test(mig) && !/REFERENCES\s+borrowers/.test(mig),
  'the snapshot has NO FK into llcs/borrowers — it must outlive the entity it records');

// 4) The client exposes the two methods the Entities screen calls.
const api = fs.readFileSync(path.join(R, 'app-v2/src/lib/api.js'), 'utf8');
ok(/staffEntityRemovalPreview:/.test(api), 'client: staffEntityRemovalPreview');
ok(/staffRemoveEntity:/.test(api), 'client: staffRemoveEntity');

console.log(`test-entity-remove-pure: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
