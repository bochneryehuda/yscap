'use strict';
const gate = require('../src/lib/osm-gate');

(async () => {
  console.log('MIN_GAP_MS =', gate.MIN_GAP_MS);

  console.log('');
  console.log('--- 1. does a REJECTING fn poison the chain? (the old bug) ---');
  gate._internals.reset();
  let sawRejection = false;
  try { await gate.osmRun(async () => { throw new Error('provider 503'); }); }
  catch (e) { sawRejection = true; }
  console.log('   caller saw fn rejection:', sawRejection);
  const t = Date.now();
  const after = await gate.osmRun(async () => 'ok');
  console.log('   next caller still served:', after, 'after', Date.now() - t, 'ms');

  console.log('');
  console.log('--- 2. spacing of 5 back-to-back callers ---');
  gate._internals.reset();
  const starts = [];
  const t0 = Date.now();
  await Promise.all(Array.from({ length: 5 }, () => gate.osmRun(async () => { starts.push(Date.now() - t0); })));
  console.log('   start offsets (ms):', starts.join(', '));

  console.log('');
  console.log('--- 3. does fn duration hold the gate? (old address-canon serialized, new does not) ---');
  gate._internals.reset();
  const marks = [];
  const t1 = Date.now();
  const slow = gate.osmRun(async () => { marks.push('A start ' + (Date.now() - t1)); await new Promise((r) => setTimeout(r, 3000)); marks.push('A end ' + (Date.now() - t1)); });
  const quick = gate.osmRun(async () => { marks.push('B start ' + (Date.now() - t1)); });
  await Promise.all([slow, quick]);
  console.log('  ', marks.join(' | '));

  console.log('');
  console.log('--- 4. CROSS-TALK: a background sweep vs a public /suggest call ---');
  gate._internals.reset();
  // 25 background canonicalisations (the ClickUp address-backfill tick size)
  const bg = Array.from({ length: 25 }, () => gate.osmRun(async () => {}));
  const t2 = Date.now();
  await gate.osmRun(async () => {});
  console.log('   a public /suggest keystroke waited', Date.now() - t2, 'ms behind a 25-item background tick');
  await Promise.all(bg);

  console.log('');
  console.log('--- 5. unbounded queue depth (no shed at the gate) ---');
  gate._internals.reset();
  const many = Array.from({ length: 500 }, () => gate.osmRun(async () => {}));
  console.log('   500 callers queued with no refusal; each waits ~', gate.MIN_GAP_MS, 'ms more than the one before');
  console.log('   the 500th would be served at ~', (500 * gate.MIN_GAP_MS / 1000).toFixed(0), 'seconds');
  process.exit(0);
})();
