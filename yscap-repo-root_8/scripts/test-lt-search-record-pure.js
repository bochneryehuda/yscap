'use strict';
/**
 * WHAT ONE SEARCH RECORDS — the rules, RUN.
 *
 * ── WHY THIS SUITE EXISTS (pre-merge audit, 2026-09-03) ────────────────────
 * `search-record.js` shipped with its whole coverage being two REGEXES over the
 * route that mentions it. So the answered-only rule, the band union, the
 * `otherSourceHad` null rule, the never-throw guarantee and the
 * nothing-observed short-circuit were untested — in a module whose own header
 * says its writers are injectable "so the whole thing runs in a test with no
 * database". They are, and this is that test.
 *
 * Both writers are stubs that RECORD what they were handed, so every assertion
 * below reads a real argument rather than a mock agreeing with itself.
 *
 * PURE: no database, no network, no Express.
 */

const path = require('path');
const ROOT = path.join(__dirname, '..');
const SR = require(path.join(ROOT, 'src/longterm/pricing/search-record.js'));

let pass = 0; let fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  ok   ${m}`); } else { fail++; console.log(`  FAIL ${m}`); } };

/** A collector whose two writers only remember what they were asked to write. */
function spy(extra = {}) {
  const calls = { sightings: [], misses: [] };
  const deps = {
    recordSightings: async (observed, opts) => { calls.sightings.push({ observed, opts }); return { ok: true }; },
    recordMisses: async (list, opts) => { calls.misses.push({ list, opts }); return { ok: true, recorded: list.length }; },
    ...extra,
  };
  return { calls, deps };
}

const board = (o) => Object.assign({ ok: true, sightings: {}, missing: [] }, o);
const seen = (keys) => ({ answered: true, keys });

console.log('\nA · only a sheet that ANSWERED is evidence');
(async () => {
  {
    const { calls, deps } = spy();
    const c = SR.collector(deps);
    c.observe(board({
      sightings: { lenderprice: seen(['verus']), loannex: { answered: false, keys: [] } },
    }));
    await c.flush({ staffId: 's1' });
    const o = calls.sightings[0].observed;
    ok(o.lenderprice.answered === true && o.lenderprice.keys.includes('verus'),
      'A1 a sheet that answered is recorded, with what it carried');
    ok(o.loannex.answered === false && o.loannex.keys.length === 0,
      'A2 a sheet that did NOT answer records nothing — an outage is no evidence about any investor');
  }
  {
    // A sheet present-but-not-answered must not have its keys read either: recording
    // them would lock every investor it normally carries out of the settings screen.
    const { calls, deps } = spy();
    const c = SR.collector(deps);
    c.observe(board({ sightings: { loannex: { answered: false, keys: ['nqm', 'acra'] } } }));
    await c.flush({});
    ok(calls.sightings[0].observed.loannex.keys.length === 0,
      'A3 …not even the keys it happens to be carrying — "answered" is the whole test');
  }
  {
    const { calls, deps } = spy();
    const c = SR.collector(deps);
    c.observe({ ok: false, sightings: { lenderprice: seen(['verus']) }, missing: ['nqm'] });
    const r = await c.flush({});
    ok(calls.sightings.length === 0 && calls.misses.length === 0,
      'A4 a REFUSED board is not evidence about anything — neither register is written');
    ok(r.ok === true && r.sightings === null,
      'A5 …and the caller is told plainly that nothing was observed');
  }
  {
    const { calls, deps } = spy();
    await SR.collector(deps).flush({});
    ok(calls.sightings.length === 0, 'A6 flushing with nothing observed writes nothing at all');
  }

  console.log('\nB · one search is ONE record, across every band');
  {
    /* The bands door asks the sheets once per DSCR band. An investor that answers in a
       WIDE band and not in a NARROW one is an investor that sheet CARRIES. */
    const { calls, deps } = spy();
    const c = SR.collector(deps);
    c.observe(board({ sightings: { loannex: seen(['nqm', 'acra']) } }));
    c.observe(board({ sightings: { loannex: seen(['acra']) } }));
    c.observe(board({ sightings: { loannex: seen(['clearedge']) } }));
    await c.flush({});
    ok(calls.sightings.length === 1, 'B1 three bands are ONE settings write, not three');
    const keys = calls.sightings[0].observed.loannex.keys.slice().sort();
    ok(JSON.stringify(keys) === JSON.stringify(['acra', 'clearedge', 'nqm']),
      `B2 …and the bands are UNIONED (${keys.join(',')})`);
  }
  {
    /* ⛔ THE UNION APPLIES TO THE MISSES HALF TOO — the defect the audit found.
       Band 1 carries NQM; the narrower band 2 does not. Filing a miss for NQM would
       email the super admin about an investor the SAME search had just proved is there. */
    const { calls, deps } = spy();
    const c = SR.collector(deps);
    c.observe(board({ sightings: { loannex: seen(['nqm']), lenderprice: seen(['nqm']) }, missing: [] }));
    c.observe(board({ sightings: { loannex: seen([]), lenderprice: seen(['nqm']) }, missing: ['nqm'] }));
    await c.flush({});
    ok(calls.misses.length === 0,
      'B3 an investor SEEN in one band is not filed as missing because a narrower band was quiet');
    ok(calls.sightings[0].observed.loannex.keys.includes('nqm'),
      'B4 …and it is still recorded as seen, which is the fact that makes the miss wrong');
  }
  {
    // A genuine miss — carried in no band at all — is still filed.
    const { calls, deps } = spy();
    const c = SR.collector(deps);
    c.observe(board({ sightings: { loannex: seen(['acra']), lenderprice: seen(['nqm']) }, missing: ['nqm'] }));
    await c.flush({ scenario: { loan: 375000 } });
    ok(calls.misses.length === 1 && calls.misses[0].list[0].key === 'nqm',
      'B5 an investor no band carried IS filed — the union narrows the misses, it does not silence them');
    ok(calls.misses[0].opts.source === 'loannex',
      'B6 …against the sheet that answered without carrying it');
  }

  console.log('\nC · "did the other sheet have them?" — answered, or left open');
  {
    const { calls, deps } = spy();
    const c = SR.collector(deps);
    c.observe(board({ sightings: { loannex: seen([]), lenderprice: seen(['nqm']) }, missing: ['nqm'] }));
    await c.flush({});
    ok(calls.misses[0].list[0].otherSourceHad === true,
      'C1 the other sheet answered and HAD it — "this investor is elsewhere" is a real answer');
  }
  {
    const { calls, deps } = spy();
    const c = SR.collector(deps);
    c.observe(board({ sightings: { loannex: seen([]), lenderprice: seen(['verus']) }, missing: ['nqm'] }));
    await c.flush({});
    ok(calls.misses[0].list[0].otherSourceHad === false,
      'C2 …answered and did NOT have it — also a real answer');
  }
  {
    const { calls, deps } = spy();
    const c = SR.collector(deps);
    c.observe(board({
      sightings: { loannex: seen([]), lenderprice: { answered: false, keys: [] } }, missing: ['nqm'],
    }));
    await c.flush({});
    ok(calls.misses[0].list[0].otherSourceHad === null,
      'C3 the other sheet did not answer, so the question is left OPEN — never a confident false');
  }

  console.log('\nD · best-effort: it can never cost the board');
  {
    const { deps } = spy({ recordSightings: async () => { throw new Error('settings store is down'); } });
    const c = SR.collector(deps);
    c.observe(board({ sightings: { lenderprice: seen(['verus']) } }));
    let threw = null; let r = null;
    try { r = await c.flush({}); } catch (e) { threw = e; }
    ok(!threw, 'D1 an unwritable settings store does not throw at the caller');
    ok(r && r.sightings && r.sightings.ok === false && /down/.test(r.sightings.problem || ''),
      'D2 …the failure is REPORTED in the return value rather than swallowed silently');
  }
  {
    const { calls, deps } = spy({ recordMisses: async () => { throw new Error('mailer exploded'); } });
    const c = SR.collector(deps);
    c.observe(board({ sightings: { loannex: seen([]), lenderprice: seen([]) }, missing: ['nqm'] }));
    const r = await c.flush({});
    ok(calls.sightings.length === 1 && r.misses.ok === false,
      'D3 a failing MISS write does not take the sightings write down with it');
  }
  {
    /* A shape today's `boardForScenario` cannot produce, but a throw here would turn a
       board the vendor call has already been paid for into a bare 500. */
    const { deps } = spy();
    let threw = null;
    try {
      const c = SR.collector(deps);
      c.observe({ ok: true, sightings: { lenderprice: { answered: true, keys: 7 } }, missing: 5 });
      await c.flush({});
    } catch (e) { threw = e; }
    ok(!threw, 'D4 a sightings list that is not a list does not throw — best-effort about the SHAPE too');
  }

  console.log('\nE · off the response path, and deterministic for a test');
  {
    const { calls, deps } = spy();
    let resolved = false;
    const w = SR.later(async () => { await SR.recordOne(board({ sightings: { lenderprice: seen(['verus']) } }), {}, deps); resolved = true; });
    ok(resolved === false, 'E1 `later` returns before the work runs — the officer\'s board never waits on it');
    await SR.settled();
    ok(resolved === true && calls.sightings.length === 1,
      'E2 …and `settled()` waits for it exactly, so a test needs no sleep');
    await w;
  }
  {
    // Detached work whose promise nobody holds is an unhandled rejection, which on some
    // Node configurations takes the process down — far worse than the missed column.
    let threw = null;
    try { SR.later(() => { throw new Error('boom'); }); await SR.settled(); } catch (e) { threw = e; }
    ok(!threw, 'E3 a detached write that throws can never become an unhandled rejection');
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  if (fail) process.exit(1);
})().catch((e) => { console.error(e); process.exit(1); });
