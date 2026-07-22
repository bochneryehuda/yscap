'use strict';
/* Automatic request-audit log — chokepoint tests (owner-directed 2026-07-22).
   Verifies the redactor never lets a password / SSN / token value reach the
   buffer, the body summary keeps KEY NAMES only, the entity inference walks
   the path correctly, and shouldLog() screens out static asset noise while
   letting every /api + /auth request through. NO DB — pure module tests.
   Run: node scripts/test-request-audit.js */
const assert = require('assert');
const ra = require('../src/lib/request-audit');
const { redactQuery, summarizeBody, isSensitive, inferEntity, shouldLog } = ra._internals;

let n = 0; const ok = (m) => { n++; console.log('  ok -', m); };

/* ---------------- isSensitive: exact + substring matching ---------------- */
{
  assert.strictEqual(isSensitive('password'), true, 'password → sensitive');
  assert.strictEqual(isSensitive('PASSWORD'), true, 'case-insensitive');
  assert.strictEqual(isSensitive('newPassword'), true, 'substring "password"');
  assert.strictEqual(isSensitive('resetToken'), true, 'substring "token"');
  assert.strictEqual(isSensitive('borrowerSsn'), true, 'substring "ssn"');
  assert.strictEqual(isSensitive('client_secret'), true, 'exact hit');
  assert.strictEqual(isSensitive('propertyAddress'), false, 'not sensitive');
  assert.strictEqual(isSensitive(''), false, 'empty → not sensitive');
  assert.strictEqual(isSensitive(null), false, 'null → not sensitive');
  ok('sensitive-key matcher accepts exact + substring hits and rejects normal fields');
}

/* ---------------- redactQuery: values for sensitive keys are stripped ---- */
{
  const out = redactQuery({
    token: 'abc.def.ghi',
    password: 'hunter2',
    ssn: '123-45-6789',
    q: 'main street',
    limit: 50,
    active: true,
    ids: ['a', 'b', 'c'],
  });
  assert.strictEqual(out.token, '[REDACTED]', 'token value stripped');
  assert.strictEqual(out.password, '[REDACTED]', 'password value stripped');
  assert.strictEqual(out.ssn, '[REDACTED]', 'ssn value stripped');
  assert.strictEqual(out.q, 'main street', 'non-sensitive string preserved');
  assert.strictEqual(out.limit, 50, 'number preserved');
  assert.strictEqual(out.active, true, 'boolean preserved');
  assert.strictEqual(out.ids, '[3 items]', 'arrays summarized, not stored raw');
  ok('query redactor strips sensitive VALUES but keeps the field name');
}

/* ---------------- redactQuery: long strings are truncated ----------------- */
{
  const long = 'x'.repeat(400);
  const out = redactQuery({ note: long });
  assert.ok(out.note.length <= 205, 'long string truncated');
  assert.ok(out.note.endsWith('…'), 'ellipsis marks truncation');
  ok('query values > 200 chars get truncated');
}

/* ---------------- summarizeBody: NEVER stores values --------------------- */
{
  const s = summarizeBody({
    email: 'ben@example.com',
    password: 'never-log-me',
    ssn: '123-45-6789',
    amount: 1500,
    lines: [1, 2, 3],
    nested: { a: 1 },
  });
  assert.ok(s._keys === 6, 'key count reported');
  const fields = s.fields.join('|');
  assert.ok(!fields.includes('ben@example.com'), 'email VALUE never appears');
  assert.ok(!fields.includes('never-log-me'), 'password VALUE never appears');
  assert.ok(!fields.includes('123-45-6789'), 'ssn VALUE never appears');
  assert.ok(fields.includes('password=[REDACTED]'), 'password key flagged');
  assert.ok(fields.includes('ssn=[REDACTED]'), 'ssn key flagged');
  assert.ok(fields.includes('email=str(15)'), 'email key kept with length only');
  assert.ok(fields.includes('amount=number'), 'number kind kept');
  assert.ok(fields.includes('lines=array(3)'), 'array size kept');
  assert.ok(fields.includes('nested=object'), 'object kind kept');
  ok('body summary keeps KEY NAMES only — never a raw sensitive VALUE');
}

/* ---------------- summarizeBody: null / empty / array ------------------- */
{
  assert.strictEqual(summarizeBody(null), null, 'null body → null summary');
  assert.strictEqual(summarizeBody(undefined), null, 'undefined body → null summary');
  assert.strictEqual(summarizeBody({}), null, 'empty object → null summary');
  const arr = summarizeBody([1, 2, 3]);
  assert.deepStrictEqual(arr, { _kind: 'array', _len: 3 }, 'array body summarized by length');
  ok('body summary handles null / empty / array cleanly');
}

/* ---------------- inferEntity: first UUID after an entity keyword -------- */
{
  const uid = '11111111-2222-3333-4444-555555555555';
  const uid2 = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  assert.deepStrictEqual(
    inferEntity(`/api/staff/applications/${uid}/documents/${uid2}`),
    { type: 'application', id: uid },
    'first UUID after "applications" is the file id');
  assert.deepStrictEqual(
    inferEntity(`/api/staff/borrowers/${uid}`),
    { type: 'borrower', id: uid },
    'borrowers segment maps to borrower entity');
  assert.deepStrictEqual(
    inferEntity(`/api/staff/pipeline`),
    { type: null, id: null },
    'no UUID → no entity');
  ok('entity inference walks the path once and stops at the first UUID');
}

/* ---------------- shouldLog: /api + /auth pass, static assets skipped ---- */
{
  const mk = (p) => ({ path: p });
  assert.strictEqual(shouldLog(mk('/api/staff/pipeline')), true, '/api/* logs');
  assert.strictEqual(shouldLog(mk('/auth/borrower/login')), true, '/auth logs');
  assert.strictEqual(shouldLog(mk('/link/reset')), true, '/link/* logs');
  assert.strictEqual(shouldLog(mk('/e/o/abc.gif')), true, 'open pixel logs');
  assert.strictEqual(shouldLog(mk('/portal/index.html')), false, '.html suffix skipped');
  assert.strictEqual(shouldLog(mk('/assets/index-a1b2.js')), false, '.js suffix skipped');
  assert.strictEqual(shouldLog(mk('/assets/logo.svg')), false, '.svg suffix skipped');
  assert.strictEqual(shouldLog(mk('/assets/pilot-lockup.png')), false, '.png suffix skipped');
  assert.strictEqual(shouldLog(mk('/portal/some-deep-link')), true, 'SPA deep link (no ext) logs');
  ok('shouldLog admits every API/auth/webhook path and screens out static assets');
}

console.log(`\nAll ${n} request-audit checks passed.`);
