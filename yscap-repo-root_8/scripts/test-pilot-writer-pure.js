#!/usr/bin/env node
'use strict';
/* PILOT AI — the writing assistant (owner-directed 2026-08-18). Pure:
 *   A. request validation — every refusal is plain language, junk never reaches
 *      the model.
 *   B. the prompts encode the contract: fix never rephrases, draft never
 *      invents (bracketed placeholders), rewrite carries the chosen tone,
 *      and every mode forbids invented facts.
 *   C. assist() never throws: unconfigured AI answers {ok:false, reason};
 *      the OUTPUT scrub is applied on the external doors' path (a
 *      capital-partner name typed in can never ride back), and a scrub
 *      FAILURE withholds the text rather than returning it raw.
 *   D. the three doors exist and the external two pass the borrower-safe
 *      scrub (source guard) — and NOTHING calls assist outside the routes
 *      (strictly manual; no cron, no hook).
 */
let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) pass++; else { fail++; console.log(`FAIL ${name}`); } };

const fs = require('fs');
const path = require('path');
const PW = require('../src/lib/ai/pilot-writer');
const azure = require('../src/lib/ai/azure-openai');

(async () => {
  // ---- A. validation ----------------------------------------------------------------------
  ok('A1 an unknown mode refuses', /fix, rewrite, or draft/.test(PW.requestProblem({ mode: 'summon' })));
  ok('A2 fix with nothing typed refuses', /nothing typed/i.test(PW.requestProblem({ mode: 'fix', text: '  ' })));
  ok('A3 draft with no instruction refuses', /what the message should do/i.test(PW.requestProblem({ mode: 'draft' })));
  ok('A4 oversize input refuses with the cap named', new RegExp(PW.MAX_INPUT.toLocaleString('en-US')).test(PW.requestProblem({ mode: 'rewrite', text: 'x'.repeat(PW.MAX_INPUT + 1) })));
  ok('A5 an unknown tone refuses', /offered tones/.test(PW.requestProblem({ mode: 'rewrite', text: 'hi', tone: 'sassy' })));
  ok('A6 a clean request passes', PW.requestProblem({ mode: 'rewrite', text: 'hi there', tone: 'firm' }) === '');

  // ---- B. the prompts ---------------------------------------------------------------------
  ok('B1 fix forbids rephrasing', /Do NOT rephrase/.test(PW.systemFor('fix')));
  ok('B2 draft demands placeholders over invention', /\[bracketed placeholder\]/.test(PW.systemFor('draft')));
  ok('B3 rewrite carries the chosen tone', /polite but firm/.test(PW.systemFor('rewrite', 'firm')));
  ok('B4 every mode forbids invented facts', PW.MODES.every((m) => /never invent a fact/.test(PW.systemFor(m))));
  ok('B5 every mode returns ONLY the text', PW.MODES.every((m) => /Return ONLY the finished text/.test(PW.systemFor(m))));

  // ---- C. assist() ------------------------------------------------------------------------
  const realAvailable = azure.available, realComplete = azure.complete;
  try {
    azure.available = () => false;
    const off = await PW.assist({ mode: 'fix', text: 'helo there' });
    ok('C1 unconfigured AI answers a plain reason, never throws', off.ok === false && /not turned on/.test(off.reason));

    azure.available = () => true;
    azure.complete = async () => ({ ok: true, text: '  BlueLake will review your file shortly.  ' });
    const scrubbed = await PW.assist({ mode: 'fix', text: 'bluelake will review' },
      { scrub: require('../src/lib/borrower-safe').scrubText });
    ok('C2 the external doors\' scrub rewrites a capital-partner name out of the OUTPUT',
      scrubbed.ok === true && !/blue\s*lake/i.test(scrubbed.text) && /review your file/.test(scrubbed.text));
    const unscrubbed = await PW.assist({ mode: 'fix', text: 'bluelake will review' });
    ok('C3 the staff door gets the text verbatim (trimmed)', unscrubbed.ok === true && /^BlueLake will review/.test(unscrubbed.text));

    const broken = await PW.assist({ mode: 'fix', text: 'x y z' }, { scrub: () => { throw new Error('boom'); } });
    ok('C4 a scrub FAILURE withholds the text — the raw answer is never returned', broken.ok === false && !broken.text);

    azure.complete = async () => ({ ok: false, reason: 'the analyzer timed out' });
    const timed = await PW.assist({ mode: 'rewrite', text: 'hello', tone: 'plain' });
    ok('C5 a model failure surfaces its reason', timed.ok === false && /timed out/.test(timed.reason));

    azure.complete = async () => { throw new Error('exploded'); };
    const threw = await PW.assist({ mode: 'fix', text: 'abc' });
    ok('C6 a thrown error never escapes', threw.ok === false && typeof threw.reason === 'string');
  } finally {
    azure.available = realAvailable; azure.complete = realComplete;
  }

  // ---- D. the doors -----------------------------------------------------------------------
  const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
  const staff = read('src/routes/staff.js');
  const borrower = read('src/routes/borrower.js');
  const tpo = read('src/routes/tpo.js');
  ok('D1 the staff door exists', /router\.post\('\/pilot-writer'/.test(staff));
  const bMatch = borrower.match(/router\.post\('\/pilot-writer'[\s\S]{0,400}/);
  ok('D2 the borrower door passes the borrower-safe scrub', !!bMatch && /scrub:\s*scrubText/.test(bMatch[0]));
  const tMatch = tpo.match(/router\.post\('\/pilot-writer'[\s\S]{0,400}/);
  ok('D3 the broker door passes the borrower-safe scrub', !!tMatch && /scrub:\s*scrubText/.test(tMatch[0]));
  // Strictly manual: assist() is called ONLY by the three routes — no cron, no
  // hook, no worker may compose text on its own.
  const { execSync } = require('child_process');
  const callers = execSync(`grep -rln "pilot-writer" src/ --include=*.js`, { cwd: path.join(__dirname, '..') })
    .toString().trim().split('\n').filter(Boolean).sort();
  ok('D4 nothing outside the three routes (and the module itself) touches pilot-writer',
    JSON.stringify(callers) === JSON.stringify(['src/lib/ai/pilot-writer.js', 'src/routes/borrower.js', 'src/routes/staff.js', 'src/routes/tpo.js']));

  console.log(`test-pilot-writer-pure: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
