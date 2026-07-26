/**
 * 'starting' cards materialize as intake files (owner-directed 2026-07-21).
 *
 * A ClickUp task created directly in the 'starting' status must now sync into
 * the portal RIGHT AWAY as a FILE_INTAKE file — closing the Moshe Spitzer /
 * 76 Thompson St duplicate gap (an officer-made 'starting' card that stayed
 * invisible, so a second card was later minted from the portal). The >=2
 * identity-field junk filter stays; 'prospect / pricing' stays scratch.
 *
 * Pure unit test — no DB, no network.
 */
const assert = require('assert');
const sync = require('../src/sync/clickup-sync');
const statusMap = require('../src/clickup/status');

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log('  ok -', msg); pass++; };

// A real deal in 'starting' (2+ identity fields: name + email + address).
const startingReal = {
  internalStatus: 'starting',
  borrower: { first_name: 'Moshe', last_name: 'Spitzer', email: 'moshespitzer123@gmail.com' },
  app: { property_address: { formatted_address: '76 Thompson St, New Haven, CT 06511, USA' } },
};
// A junk placeholder in 'starting' (no identity fields).
const startingJunk = { internalStatus: 'starting', borrower: {}, app: {} };
// A softer pre-file prospect — stays scratch, no auto-create.
const prospectReal = {
  internalStatus: 'prospect / pricing',
  borrower: { first_name: 'Moshe', last_name: 'Spitzer', email: 'moshespitzer123@gmail.com' },
  app: { property_address: { formatted_address: '76 Thompson St, New Haven, CT 06511, USA' } },
};
// Casing/space-insensitive (ClickUp statuses carry irregular casing).
const startingCased = { ...startingReal, internalStatus: '  Starting ' };

ok(sync.canMaterialize(startingReal) === true,
  "a real deal in 'starting' now materializes (was blocked before)");
ok(sync.canMaterialize(startingCased) === true,
  "'starting' match is trim/case-insensitive");
ok(sync.canMaterialize(startingJunk) === false,
  "a junk 'starting' card with <2 identity fields still does NOT materialize");
ok(sync.canMaterialize(prospectReal) === false,
  "'prospect / pricing' stays a scratch status (no auto-create)");

// The intake mapping the materialized file lands in.
ok(statusMap.externalFor('starting') === 'file_intake',
  "'starting' maps to the file_intake (intake) stage");

console.log(`\n[test-clickup-starting-materialize] ${pass} assertions passed`);
