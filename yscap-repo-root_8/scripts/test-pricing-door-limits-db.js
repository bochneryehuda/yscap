'use strict';
/**
 * THE PUBLIC PRICING DOOR REFUSES CHEAPLY.
 *
 * `/api/pricing/studio` is the only door in PILOT an anonymous visitor can
 * call. An audit (2026-08-03) measured that the global 32MB JSON parser ran
 * BEFORE this door's rate limit, so a 24MB body was fully parsed — 223ms of
 * blocked event loop, during which nothing else in PILOT is served — and a
 * request that was going to be 429'd paid that cost anyway. The limiter
 * protected nothing expensive.
 *
 * This pins the two properties that fix depends on, plus the things that must
 * NOT have moved: the global parser still accepts a large upload on the doors
 * that legitimately need one, `/api/pricing-defaults` is untouched (it is a
 * DIFFERENT path that merely shares a prefix), and NUL stripping still happens.
 *
 * SELF-SKIPS WITHOUT A DATABASE and requires nothing that opens a pool until
 * after that check — the rule every *-db.js suite here follows.
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-pricing-door-limits-db (no DATABASE_URL)'); process.exit(0); }

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-pricing-door';
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || 'test-ssn-key-for-verification-only-32bytes!!';
process.env.EMAIL_PROVIDER = 'none';
process.env.NODE_ENV = 'test';

const http = require('http');
const app = require('../src/server');

let pass = 0; const fails = [];
const ok = (c, m) => { if (c) { pass++; } else { fails.push(m); console.log(`FAIL ${m}`); } };

function post(server, path, payload, headers) {
  return new Promise((resolve) => {
    const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
    const req = http.request({
      host: '127.0.0.1', port: server.address().port, path, method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }, headers || {}),
    }, (res) => {
      let d = ''; res.on('data', (c) => { d += c; });
      res.on('end', () => { let j = null; try { j = JSON.parse(d); } catch (_) { /* not json */ } resolve({ status: res.statusCode, body: j, raw: d, headers: res.headers }); });
    });
    req.on('error', () => resolve({ status: 0, body: null, raw: '' }));
    req.end(body);
  });
}
function get(server, path) {
  return new Promise((resolve) => {
    http.get({ host: '127.0.0.1', port: server.address().port, path }, (res) => {
      let d = ''; res.on('data', (c) => { d += c; });
      res.on('end', () => { let j = null; try { j = JSON.parse(d); } catch (_) {} resolve({ status: res.statusCode, body: j }); });
    }).on('error', () => resolve({ status: 0, body: null }));
  });
}

const DEAL = {
  loanType: 'Purchase', strategy: 'Fix & Flip', state: 'NJ', propertyType: 'SFR',
  fico: 740, expFlips: 12, expHolds: 2, expGround: 0,
  purchasePrice: 400000, asIsValue: 400000, arv: 600000, rehabBudget: 80000, term: 12, irMonths: 6,
};

(async () => {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  try {
    console.log('== A. an ordinary quote is unaffected ==');
    const t0 = Date.now();
    const good = await post(server, '/api/pricing/studio', DEAL);
    ok(good.status === 200, `a real deal still prices (${good.status})`);
    ok(good.body && good.body.available === true, 'and answers');
    ok(Buffer.byteLength(JSON.stringify(DEAL)) < 2000, `a studio quote is small (${Buffer.byteLength(JSON.stringify(DEAL))} bytes) — 32kb is generous`);
    console.log(`   (${Date.now() - t0}ms)`);

    console.log('\n== B. an oversized body is REFUSED, and refused fast ==');
    // 1MB is already ~1,400x a real quote. The old limit was 32MB.
    const fat = { ...DEAL, junk: 'x'.repeat(1024 * 1024) };
    const t1 = Date.now();
    const big = await post(server, '/api/pricing/studio', fat);
    const bigMs = Date.now() - t1;
    ok(big.status === 413, `a 1MB body is refused with 413 Payload Too Large (${big.status})`);
    ok(bigMs < 1500, `and refused quickly (${bigMs}ms)`);

    // The one that matters: a body far past anything legitimate.
    const huge = { ...DEAL, junk: 'x'.repeat(8 * 1024 * 1024) };
    const t2 = Date.now();
    const hugeRes = await post(server, '/api/pricing/studio', huge);
    const hugeMs = Date.now() - t2;
    ok(hugeRes.status === 413, `an 8MB body is refused too (${hugeRes.status})`);
    ok(hugeMs < 3000, `without parsing it (${hugeMs}ms — the old path spent ~223ms on 24MB and rising)`);

    console.log('\n== C. a body just under the cap still works ==');
    // Proves the cap is a CAP, not a blanket refusal — and that the studio has
    // room to grow before anyone has to think about this again.
    const roomy = { ...DEAL, city: 'x'.repeat(20 * 1024) };
    const okBig = await post(server, '/api/pricing/studio', roomy);
    ok(okBig.status === 200, `a 20kb body is accepted (${okBig.status})`);

    console.log('\n== D. NOTHING ELSE MOVED ==');
    // (1) /api/pricing-defaults merely SHARES A PREFIX with /api/pricing. Express
    //     only matches a mount path at a segment boundary, so it must be
    //     untouched — if that ever changed, the marketing page would start
    //     getting rate-limited and size-capped by this door's rules.
    const defaults = await get(server, '/api/pricing-defaults');
    ok(defaults.status === 200, `/api/pricing-defaults still answers (${defaults.status})`);
    ok(defaults.body && typeof defaults.body === 'object', 'and still returns its settings');

    // (2) The global parser must still accept a real upload. A document upload
    //     is base64 inside JSON, so the global limit is deliberately ~32MB; the
    //     new 32kb cap must apply to /api/pricing ONLY. This door needs auth, so
    //     a 401 proves the BODY was accepted and the request reached the auth
    //     check — a 413 would mean the small cap leaked onto every route.
    const upload = await post(server, '/api/staff/applications/x/documents', { filename: 'a.pdf', contentType: 'application/pdf', dataBase64: 'A'.repeat(2 * 1024 * 1024) });
    ok(upload.status !== 413, `a 2MB upload body is NOT size-refused elsewhere (${upload.status})`);

    // (3) NUL stripping still runs on this door's body. The small parser is
    //     mounted ABOVE the global one, and nul-strip sits BELOW it reading
    //     req.body — so moving the parse must not have skipped the scrub.
    const nul = await post(server, '/api/pricing/studio', { ...DEAL, city: 'Bro\u0000oklyn' });
    ok(nul.status === 200, `a body containing a NUL still answers (${nul.status})`);
    ok(nul.body && nul.body.deal && !String(nul.body.deal.city || '').includes('\u0000'),
      'and the NUL was stripped before the route saw it');

    // (4) Malformed JSON is still a client error, not a 500.
    const bad = await post(server, '/api/pricing/studio', '{not json');
    ok(bad.status >= 400 && bad.status < 500, `malformed JSON is a client error (${bad.status})`);

    /* == E. THE LIMIT IS REAL, AND IT REFUSES ==
       Added after a break-it sweep (2026-08-03) deleted this door's rate limit
       outright and then set it to nine million, and every test in the repo
       still passed. The limit is the ONLY thing bounding how fast an anonymous
       visitor can walk the guideline space one priced deal at a time, and how
       much engine CPU they can burn in a single-process product — so an
       untested limit is the same as no limit.

       This section runs LAST on purpose: the bucket is keyed on (bucket, IP)
       and every request above came from 127.0.0.1, so the burst below spends
       the same counter everything else was using. */
    console.log('\n== E. the rate limit is mounted, configured, and refuses ==');
    // The limiter stamps its own configuration on every answer it lets through,
    // so ONE ordinary request proves it is mounted on THIS path with THIS max —
    // no hammering needed, and it fails if the mount is removed or re-tuned.
    const stamped = await post(server, '/api/pricing/studio', DEAL);
    ok(stamped.headers && stamped.headers['ratelimit-limit'] === '240',
      `the public door answers with its own limit (RateLimit-Limit: ${stamped.headers && stamped.headers['ratelimit-limit']})`);
    ok(stamped.headers && Number(stamped.headers['ratelimit-remaining']) < 240,
      'and the counter is actually counting this caller');

    /* And it genuinely REFUSES, which the header alone does not prove. The burst
       goes to a path under the same mount that does NOT exist: the limiter runs
       before routing, so a 404 costs no engine work — 250 real quotes would be
       750 engine evaluations for an assertion about counting. */
    let limited = null; let sent = 0;
    for (let i = 0; i < 300 && !limited; i++) {
      sent++;
      const r = await post(server, '/api/pricing/__ratelimit_probe', { x: 1 });
      if (r.status === 429) limited = r;
    }
    ok(!!limited, `a burst is eventually refused with 429 (gave up after ${sent})`);
    ok(sent <= 260, `and refused at about the configured limit, not far past it (${sent} requests)`);
    ok(!!(limited && limited.headers && limited.headers['retry-after']),
      `the refusal tells the caller when to come back (Retry-After: ${limited && limited.headers && limited.headers['retry-after']})`);
    ok(!!(limited && limited.body && /too many/i.test(String(limited.body.error || ''))),
      'and says so in plain words');

    console.log(`\n${fails.length ? 'FAILED' : 'ALL PASS'} — ${pass} assertions, ${fails.length} failure(s)`);
    fails.forEach((f) => console.log('  - ' + f));
  } catch (e) {
    fails.push('threw: ' + (e && e.stack || e));
    console.log('FAIL threw:', e && e.stack || e);
  } finally {
    server.close();
    try { await require('../src/db').pool.end(); } catch (_) { /* already closed */ }
  }
  process.exit(fails.length ? 1 : 0);
})();
