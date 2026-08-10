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

// 2) Both doors are gated on super_admin (the hard role, per the owner's rule).
const staff = fs.readFileSync(path.join(R, 'src/routes/staff.js'), 'utf8');
const previewRoute = /router\.get\('\/borrowers\/:id\/llcs\/:llcId\/removal-preview',\s*requireRole\('super_admin'\)/.test(staff);
const removeRoute = /router\.post\('\/borrowers\/:id\/llcs\/:llcId\/remove',\s*requireRole\('super_admin'\)/.test(staff);
ok(previewRoute, 'the preview door is gated on super_admin');
ok(removeRoute, 'the remove door is gated on super_admin');
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
