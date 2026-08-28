'use strict';
/**
 * WHERE EACH OFFICER'S CARDS LIVE — the folder map the card creator will trust.
 *
 * A wrong id here files a new deal into another officer's folder, where the right
 * officer never looks: nothing errors, the office just "loses" the card. So the
 * two ids added by hand (Chaim, Ezra — owner-directed 2026-08-23) are pinned to
 * the values MEASURED off live tasks in each folder, and the convention that lets
 * RTL's table serve the rest — "<Name> Files" IS the routing pipeline id — is
 * asserted against the one officer it was verified on.
 */
const assert = require('assert');
let checks = 0;
const ok = (c, w) => { assert.ok(c, w); console.log('  ok  ', w); checks += 1; };
const eq = (a, b, w) => { assert.strictEqual(a, b, `${w} (got ${JSON.stringify(a)})`); console.log('  ok  ', w); checks += 1; };

const r = require('../src/longterm/clickup/routing');

eq(r.folderForOfficer('Ezra Green').pipeline, '90118271998',
  'Ezra Green routes to the folder measured off FILLE-2081 (task 868kur80x)');
eq(r.folderForOfficer('Chaim Lebowitz').pipeline, '90118110153',
  'Chaim Lebowitz routes to the folder measured off FILLE-2057 (task 868kqpntt)');
eq(r.folderForOfficer('Yehuda Bochner').pipeline, '90115017377',
  'the convention holds where it was verified: "Yehuda Bochner Files" IS the RTL routing id');
eq(r.folderForOfficer('Nobody Real'), null,
  'a name nobody recorded answers null — the caller must refuse to create, never guess a folder');
eq(r.folderForOfficer(''), null, 'a blank name is null too');
eq(r.folderForOfficer('  Ezra Green  ').pipeline, '90118271998', 'whitespace is typing, not identity');
ok(r.knownOfficers().includes('Ezra Green') && r.knownOfficers().includes('Chaim Lebowitz'),
  'both new officers are enumerable, so a screen can offer them');
ok(r.knownOfficers().length >= 12, 'and the RTL table came through underneath them');

console.log(`\nall good — ${checks} checks`);
