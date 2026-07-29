'use strict';
/**
 * #9 — the reply to the REQUESTER on their own exception is FORCED (owner-directed
 * 2026-07-29): a loan officer can never turn off the notification tied to their own
 * exception request, so a super-admin's "why do you need this?" always reaches them.
 * The ordinary exception-comment notification (to reviewers/other participants)
 * stays disableable. Pure — reads the catalog + the notify maps, no DB.
 */
const assert = require('assert');
const catalog = require('../src/lib/notification-catalog');

let passed = 0;
const ok = (n) => { console.log(`  ok  ${n}`); passed++; };

// 1. The requester-reply type is a real catalog entry and is FORCED.
{
  const entry = catalog.entryForKey('exception_request_reply');
  assert.ok(entry, 'exception_request_reply is in the catalog');
  assert.strictEqual(entry.forced, true, 'it is forced (non-disableable)');
  assert.strictEqual(catalog.isForced(catalog.keyForType('exception_request_reply'), 'exception_request_reply'), true);
  ok('exception_request_reply is a forced (non-disableable) notification');
}

// 2. The ordinary comment notifications stay disableable — only the requester's is forced.
{
  for (const t of ['exception_comment', 'guaranty_exception_comment']) {
    assert.strictEqual(catalog.isForced(catalog.keyForType(t), t), false, `${t} stays disableable`);
  }
  ok('the general exception-comment notifications remain disableable');
}

// 3. The type is wired into the notify maps (so it emails, not just an in-app row).
{
  const notifySrc = require('fs').readFileSync(require('path').join(__dirname, '../src/lib/notify.js'), 'utf8');
  assert.ok(/exception_request_reply:\s*'conditions'/.test(notifySrc), 'CATEGORY_OF maps it to conditions (emails)');
  assert.ok(/exception_request_reply:\s*'[^']+'/.test(notifySrc.split('KICKER_OF')[1] || notifySrc), 'KICKER_OF has an eyebrow for it');
  ok('exception_request_reply is registered in the notify category + kicker maps');
}

// 4. The admin-exceptions comment route routes the REQUESTER through the forced type.
{
  const src = require('fs').readFileSync(require('path').join(__dirname, '../src/routes/admin-exceptions.js'), 'utf8');
  assert.ok(/isRequester\s*\?\s*'exception_request_reply'/.test(src), 'the requester gets the forced type; others get the ordinary one');
  ok('the comment route sends the requester the forced reply notification');
}

console.log(`\nexception forced-notify pure — ${passed} checks passed`);
