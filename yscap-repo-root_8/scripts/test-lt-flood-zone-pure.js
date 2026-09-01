#!/usr/bin/env node
'use strict';
/**
 * LT — READING THE FLOOD ZONE OFF ENCOMPASS FIELD 541, AND NEVER OVER A PERSON.
 *
 * Owner-directed 2026-08-31: *"Right now, we have a flood insurance agent on
 * every file. This is only if you tick that this is a flood zone or if it
 * realizes from encompass that this is in a flood zone. Do research on how to
 * realize from encompass."* Asked which zone letters mean a flood zone, the owner
 * chose **the A and V zones**; asked what a file should say before Encompass has
 * answered, they chose **"show it greyed, saying we can't tell yet"**.
 *
 * ── WHAT IS PROVEN HERE, AND WHY EACH PART NEEDS ITS OWN KIND OF CHECK ───────
 *
 *   A. THE RULE. What every zone letter means, including the three that mean
 *      NOTHING — a blank field, FEMA's undetermined `D`, and the single bare word
 *      "Yes" the census found. This is the whole reason the module exists: "No"
 *      beside a flood question is a claim somebody prices a loan on.
 *   B. THE WORDING, which three surfaces share so one property's flood status can
 *      never be described three ways.
 *   C. THE WIRING, read as SOURCE. No unit test of a rule can see whether its one
 *      caller passes it the right thing — the Trinity eligibility rule was
 *      correct for two days while its caller handed it an undefined argument —
 *      and no test without live Encompass credentials can run the sync. So the
 *      three joins are pinned: field 541 really is in the batch the sync asks
 *      for, the writer really writes the three columns, and the manual switch
 *      really stamps its answer so the sync leaves it alone.
 *
 * PURE — no database, no network, no credentials.
 */

const fs = require('fs');
const path = require('path');

let pass = 0;
const fails = [];
const ok = (cond, name, detail) => {
  if (cond) { pass++; console.log('  ✓ ' + name); return; }
  fails.push(detail ? `${name} — ${detail}` : name);
  console.log('  ✗ ' + name + (detail ? ` — ${detail}` : ''));
};

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const flood = require('../src/longterm/flood-zone.js');

// ── A. THE RULE ─────────────────────────────────────────────────────────────
console.log('\nA. what a zone letter means');

const zone = (v) => flood.readFloodZone(v === undefined ? {} : { 541: v });

// The A and V families — the owner's own answer, and FEMA's own lettering.
for (const z of ['A', 'A1', 'A30', 'AE', 'AH', 'AO', 'AR', 'A99', 'V', 'V1', 'V30', 'VE']) {
  const r = zone(z);
  ok(r.answered === true && r.inFloodZone === true && r.zone === z,
    `${z} is a flood zone`, JSON.stringify(r));
}

// Outside it. B and C are the pre-2000 lettering; X and X500 replaced them.
for (const z of ['B', 'C', 'X', 'X500']) {
  const r = zone(z);
  ok(r.answered === true && r.inFloodZone === false && r.zone === z,
    `${z} is not a flood zone`, JSON.stringify(r));
}

// THE THREE THAT ANSWER NOTHING. This is the half that costs money to get wrong.
ok(zone(undefined).answered === false && zone(undefined).inFloodZone === null,
  'a blank field claims NOTHING — three in five long-term loans carry nothing here');
ok(zone('').inFloodZone === null && zone('   ').inFloodZone === null,
  'so does an empty or whitespace value');
{
  const d = zone('D');
  ok(d.answered === true && d.inFloodZone === null && d.zone === 'D',
    'FEMA\'s D — its own word for "undetermined" — is recorded and claims NOTHING, never a "no"');
  const y = zone('Yes');
  ok(y.answered === true && y.inFloodZone === null && y.zone === 'Yes',
    'the single bare "Yes" the census found is recorded VERBATIM and claims nothing — the owner picked the option that leaves it unread');
}

// THE REASON THE FAMILIES ARE WRITTEN OUT RATHER THAN MATCHED ON A FIRST LETTER.
// `/^A/` is shorter and would turn any future value beginning with A — an
// indicator word, a status, a misfiled note — into "this property is in a flood
// zone", which puts a real insurance requirement on a real loan.
for (const notAZone of ['Awaiting', 'Approved', 'AREA NOT MAPPED', 'Verified', 'Various']) {
  ok(zone(notAZone).inFloodZone === null,
    `"${notAZone}" begins with A or V and is NOT read as a flood zone`);
}

ok(zone('ae').inFloodZone === true && zone('  x  ').inFloodZone === false,
  'casing and stray spaces do not change the answer');
ok(zone('ae').zone === 'ae',
  '…and the zone is recorded as Encompass actually holds it, not as we normalised it');
ok(flood.readFloodZone(null).answered === false && flood.readFloodZone(undefined).answered === false,
  'no field map at all answers nothing rather than throwing');
ok(JSON.stringify(flood.FIELD_IDS) === JSON.stringify(['541']),
  'the one id it reads is 541 — the id the 772-loan census measured');

// ── B. THE WORDING ──────────────────────────────────────────────────────────
console.log('\nB. what a screen says');

const say = (row) => flood.describeFloodZone(row);
ok(say({ in_flood_zone: true, flood_zone: 'AE' }).known === true
  && /AE/.test(say({ in_flood_zone: true, flood_zone: 'AE' }).label),
  'a known flood zone names the zone');
ok(say({ in_flood_zone: false, flood_zone: 'X' }).known === true
  && /not a flood zone/i.test(say({ in_flood_zone: false, flood_zone: 'X' }).label),
  'a known non-flood zone says so plainly');
ok(say({}).known === false && /has not said/i.test(say({}).label),
  'nothing recorded says Encompass has not said — never a "no"');
ok(say({ flood_zone: 'D' }).known === false && /D/.test(say({ flood_zone: 'D' }).label),
  'a zone PILOT does not read still shows what Encompass holds');
ok(say({ inFloodZone: true, floodZone: 'VE' }).known === true,
  'it reads a camelCase row too, so a screen and a database row get the same sentence');

// A HUMAN'S ANSWER IS NEVER OVERWRITTEN BY A READ.
ok(flood.mayWriteFromEncompass(null) === true
  && flood.mayWriteFromEncompass(flood.SOURCE_ENCOMPASS) === true
  && flood.mayWriteFromEncompass(flood.SOURCE_MANUAL) === false,
  'Encompass may fill an unanswered file and may replace its own answer — never a person\'s');

// ── C. THE WIRING ───────────────────────────────────────────────────────────
console.log('\nC. the joins a unit test of the rule cannot see');

const syncSrc = read('src/longterm/sync/loans.js');
const writerSrc = read('src/longterm/application/sync.js');
const routeSrc = read('src/longterm/routes/orders.js');
const migration = read('db/666_lt_flood_zone_read_from_encompass_541.sql');

ok(/\.\.\.floodZone\.FIELD_IDS/.test(syncSrc),
  'the sync spreads field 541 into the ONE fieldReader batch — a second call per loan would cost the whole company a pacing gap');
{
  // The batch is built OUTSIDE the try on purpose (the 2026-08-25 outage), so the
  // spread must sit in that same expression rather than in a catch-swallowed one.
  const idsAt = syncSrc.indexOf('const ids = [...new Set([');
  const floodAt = syncSrc.indexOf('...floodZone.FIELD_IDS');
  const closeAt = syncSrc.indexOf('])];', idsAt);
  ok(idsAt > 0 && floodAt > idsAt && floodAt < closeAt,
    '…inside that id list, not somewhere a swallowed catch could hide it', `ids@${idsAt} flood@${floodAt} close@${closeAt}`);
}

ok(/floodZone\.readFloodZone\(/.test(writerSrc),
  'the property writer asks flood-zone.js rather than reading the letter itself');
for (const col of ['in_flood_zone', 'flood_zone', 'flood_zone_source']) {
  ok(new RegExp(`\\b${col}\\b`).test(writerSrc), `…and writes ${col}`);
}
ok(/flood_zone_source, ''\) = 'manual'/.test(writerSrc)
  && (writerSrc.match(/flood_zone_source, ''\) = 'manual'/g) || []).length === 3,
  'all THREE flood columns refuse to write over a person\'s answer — one missed column would leak the sync\'s answer back onto a ticked file');
ok(/COALESCE\(lt_properties\.flood_zone_source, ''\)/.test(writerSrc),
  '…and the guard COALESCEs, because a bare NULL = \'manual\' is NULL rather than false');

{
  // COMMENTS STRIPPED FIRST, and this is the whole reason: the code that stamps
  // the answer necessarily EXPLAINS itself by naming the same literal, so a guard
  // reading the raw file passes on a route that has had the stamp deleted — which
  // is exactly what a mutation run proved. Assert on the statement, never on the
  // prose that describes it.
  const routeCode = routeSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const upAt = routeCode.indexOf('UPDATE lt_properties');
  const whereAt = routeCode.indexOf('WHERE loan_id', upAt);
  const stmt = upAt >= 0 && whereAt > upAt ? routeCode.slice(upAt, whereAt) : '';
  ok(/flood_zone_source = 'manual'/.test(stmt),
    'the manual switch STAMPS its answer, IN THE STATEMENT — without it the next sync overwrites the tick and the switch looks broken',
    stmt.slice(0, 160));
}
ok(/ADD COLUMN IF NOT EXISTS flood_zone_source/.test(migration)
  && /flood_zone_source IN \('encompass', 'manual'\)/.test(migration),
  'db/658 adds the source column and refuses a value that is not one of the two');
ok(/floodZoneSource\s+String\?\s+@map\("flood_zone_source"\)/.test(read('src/longterm/prisma/schema.prisma')),
  'the LT model declares the new column in the same commit as the migration (the db/621 lesson)');

// The mapper's own contract: it says it has no requires, and it must keep saying
// the truth — which is why the flood read is joined at the WRITER instead.
ok(!/require\(/.test(read('src/longterm/application/mapper.js')),
  'the mapper is still require-free, so its "PURE, no requires" header is still true');

// The answered question came OFF the knowingly-unfilled list, or the screen would
// go on saying "PILOT never reads this" about a column it now reads.
const unsourced = require('../src/longterm/application/unsourced.js');
ok(!unsourced.unsourced('lt_properties', 'in_flood_zone')
  && !unsourced.unsourced('lt_properties', 'flood_zone'),
  'neither flood column still claims to be unread');
ok(!!unsourced.RESOLVED['lt_properties.in_flood_zone'],
  '…and the answer that filled it is kept, so a column that quietly stopped being listed does not read as one that was never a question');

// A DASH STILL MEANS SOMETHING. The static "we never read this" is gone, so the
// per-loan sentence has to take its place or a blank field reads as "No".
const fileSrc = read('src/longterm/file.js');
ok(/floodNote\(prop\)/.test(fileSrc) && /describeFloodZone/.test(fileSrc),
  'the file screen carries a per-loan flood sentence in place of the retired static one');
{
  const m = fileSrc.match(/function floodNote\(prop\) \{[\s\S]*?\n\}/);
  ok(!!m && /in_flood_zone === true \|\| prop\.in_flood_zone === false/.test(m[0]),
    '…and it gives way the moment there is a real yes or no');
}

const readSrc = read('src/longterm/conditions-center/read.js');
ok(/FIELD_UNKNOWN\[t\.whenField\]/.test(readSrc)
  && /cannot tell yet whether this is a flood zone/i.test(readSrc),
  'a greyed contact row says we cannot tell yet — the owner\'s own answer — rather than the generic "not established"');
ok(/ticks the flood-zone switch/.test(readSrc),
  '…and names BOTH routes, so nobody hunts for a control that is not the only way');

console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) { fails.forEach((f) => console.error('  FAIL ' + f)); process.exit(1); }
