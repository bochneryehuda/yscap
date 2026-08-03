'use strict';
/* Adversarial probe of the re-audited surfaces. No network: geocodeProperty is stubbed. */
const http = require('http');
const express = require('express');
const path = require('path');
const ROOT = '/home/user/yscap/yscap-repo-root_8';

const RG = require(path.join(ROOT, 'src/lib/research/geocode'));
const cfg = require(path.join(ROOT, 'src/config'));
cfg.addressProvider = 'osm';

let stubDelay = 0;
let calls = [];
RG.geocodeProperty = async (subject) => {
  calls.push(subject);
  if (stubDelay) await new Promise((r) => setTimeout(r, stubDelay));
  return { ok: true, lat: 40.7, lng: -73.9, source: 'census', precision: 'address', matched: 'X' };
};

const app = express();
app.use(express.json());
app.use('/api/address', require(path.join(ROOT, 'src/routes/address')));
// mimic server.js json error middleware
app.use((err, req, res, next) => { res.status(500).json({ error: 'server error', msg: String(err && err.message) }); });
const server = http.createServer(app);

function get(p) {
  return new Promise((resolve) => {
    http.get({ port: server.address().port, path: p }, (r) => {
      let b = ''; r.on('data', (c) => b += c);
      r.on('end', () => resolve({ status: r.statusCode, body: b }));
    }).on('error', (e) => resolve({ status: 0, body: String(e.message) }));
  });
}

const BAD = [
  '/api/address/position?state[x]=1',
  '/api/address/position?q[x]=1',
  '/api/address/position?line1[]=a&line1[]=b',
  '/api/address/position?city[a][b]=1&state=NJ&zip=08854',
  '/api/address/position?q=' + encodeURIComponent('26 S 10th St, Brooklyn, NY 11249'),
  '/api/address/position?q=' + encodeURIComponent('New Jersey'),
  '/api/address/position?line1=26%20S%2010th%20St&state=NJ',
  '/api/address/position?line1=26%20S%2010th%20St%20Apt%204D&city=Brooklyn&state=New%20York&zip=11249',
  '/api/address/position?zip=' + encodeURIComponent('11249') + '&line1=' + encodeURIComponent('5 Main St'),
  '/api/address/position?q=' + encodeURIComponent('a'.repeat(50000)),
  '/api/address/position?q=' + encodeURIComponent(' '.repeat(20000) + '12345'),
  '/api/address/position?q=' + encodeURIComponent('1 Main St Apt ' + 'A'.repeat(5000) + ', Trenton, NJ'),
  '/api/address/position?q=' + encodeURIComponent('123 Main St #' + '9'.repeat(3000) + ', Trenton, NJ 08600'),
  '/api/address/position?lat=1&q=' + encodeURIComponent('__proto__'),
  '/api/address/parse?q[x]=1',
  '/api/address/suggest?q[x]=1',
  '/api/address/verify?state[x]=1&line1=5%20Main%20St',
];

(async () => {
  await new Promise((r) => server.listen(0, r));
  console.log('--- adversarial query params ---');
  for (const u of BAD) {
    const t0 = Date.now();
    const r = await get(u);
    const ms = Date.now() - t0;
    const flag = r.status !== 200 ? '  <<< NON-200' : (ms > 1500 ? '  <<< SLOW' : '');
    console.log(String(r.status).padStart(3), String(ms).padStart(6) + 'ms', u.slice(0, 92), flag);
    if (r.status !== 200) console.log('      ', r.body.slice(0, 300));
  }

  console.log('\n--- what geocodeProperty was actually asked (subject shapes) ---');
  for (const c of calls.slice(0, 12)) console.log('   ', JSON.stringify(c).slice(0, 160));

  // ---- shed test -------------------------------------------------------
  console.log('\n--- shed / queue behaviour (POS_MAX_INFLIGHT=2, POS_MAX_QUEUE=8) ---');
  stubDelay = 400;
  calls = [];
  const N = 30;
  const t0 = Date.now();
  const rs = await Promise.all(Array.from({ length: N }, (_, i) =>
    get('/api/address/position?line1=' + i + '%20Main%20St&city=Trenton&state=NJ&zip=0860' + (i % 10))));
  const bodies = rs.map((r) => JSON.parse(r.body));
  const busy = bodies.filter((b) => /busy/.test(b.why || '')).length;
  const placed = bodies.filter((b) => b.lat != null).length;
  console.log(`  ${N} concurrent: placed=${placed} shed(busy)=${busy} other=${N - placed - busy} in ${Date.Now === undefined ? Date.now() - t0 : 0}ms`);
  console.log('  all answered 200:', rs.every((r) => r.status === 200));

  // Give the tail a moment, then confirm counters drained by firing one more.
  await new Promise((r) => setTimeout(r, 1500));
  const after = JSON.parse((await get('/api/address/position?line1=999%20Zeta%20St&city=Trenton&state=NJ&zip=08611')).body);
  console.log('  after the burst a fresh request is served (no leak):', after.lat != null, JSON.stringify(after).slice(0, 90));

  server.close();
  process.exit(0);
})();
