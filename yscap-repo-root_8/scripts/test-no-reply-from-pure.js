/**
 * A NO-REPLY SENDER CANNOT BE CONFIGURED IN (owner-directed 2026-08-26: "No
 * email should come from a no-reply because it technically is a reply").
 *
 * Every email carries a real, unique reply-to — but a mail client displays the
 * FROM header, so the production Render dashboard's NOTIFY_FROM of
 * no-reply@yscapgroup.com made every email READ as no-reply while the reply-to
 * plumbing was working perfectly. Two halves proven here, no DB needed:
 *   (1) the vocabulary — src/lib/email/no-reply.js recognises the whole
 *       no-reply family and repairs a From to the monitored local part on the
 *       SAME (verified) domain, keeping the display name;
 *   (2) the enforcement — src/config.js resolveNotifyFrom actually consumes it
 *       (source-guarded), so an env value can never reach the wire as no-reply
 *       on Resend, and Graph (where the From must be a REAL mailbox) warns
 *       instead of rewriting.
 * The end-to-end proof that cfg.notifyFrom lands repaired (through the real
 * config load with the env set) is in scripts/test-lo-branding.js.
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const NR = require(path.join(__dirname, '..', 'src', 'lib', 'email', 'no-reply'));

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); pass++; };
const eq = (a, b, m) => { assert.strictEqual(a, b, `${m} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); pass++; };

console.log('no-reply From guard — pure');

// ---------------------------------------------------------------------------
// 1. The family — every spelling the rule must catch, and none it must not.
// ---------------------------------------------------------------------------
for (const bad of [
  'no-reply@yscapgroup.com',                         // the production value that caused the report
  'noreply@yscapgroup.com',
  'no_reply@yscapgroup.com',
  'No-Reply@YSCapGroup.com',
  'do-not-reply@yscapgroup.com',
  'donotreply@x.test',
  'dont-reply@x.test',
  'PILOT by YS Capital <no-reply@yscapgroup.com>',   // display-name form
  '"YS Capital Group" <noreply@updates.yscapgroup.com>',
]) ok(NR.isNoReplyAddress(bad), `recognised as no-reply: ${bad}`);

for (const good of [
  'notifications@yscapgroup.com',
  'PILOT by YS Capital <notifications@yscapgroup.com>',
  'sales@yscapgroup.com',
  'draws@yscapgroup.com',
  'replies@yscapgroup.com',                          // contains "repl" but is a real inbox
  'norep@x.test',                                    // not in the family — never over-match
  '', null, undefined, 'not-an-email',
]) ok(!NR.isNoReplyAddress(good), `NOT flagged: ${JSON.stringify(good)}`);

// ---------------------------------------------------------------------------
// 2. The repair — monitored local part, same domain, display name kept.
// ---------------------------------------------------------------------------
{
  const r = NR.repairNoReplyFrom('PILOT by YS Capital <no-reply@yscapgroup.com>');
  ok(r.changed, 'the production shape is repaired');
  eq(r.from, 'PILOT by YS Capital <notifications@yscapgroup.com>', 'display name kept, domain kept, local part swapped');
}
{
  const r = NR.repairNoReplyFrom('no-reply@updates.yscapgroup.com');
  eq(r.from, 'notifications@updates.yscapgroup.com', 'a bare address on a sub-domain keeps ITS domain — Resend verifies the domain, so the rewrite is deliverability-neutral');
}
{
  const r = NR.repairNoReplyFrom('PILOT <notifications@yscapgroup.com>');
  ok(!r.changed, 'a monitored From is untouched');
  eq(r.from, 'PILOT <notifications@yscapgroup.com>', 'byte-identical when nothing is wrong');
}

// ---------------------------------------------------------------------------
// 3. The enforcement is WIRED — config.js consumes the module (source guard,
//    comments stripped so the explanation cannot satisfy its own check).
// ---------------------------------------------------------------------------
{
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'config.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  ok(/require\((['"])\.\/lib\/email\/no-reply\1\)/.test(src), 'config.js requires the shared no-reply module');
  ok(/resolveNotifyFrom\(/.test(src) && /notifyFrom:\s*resolveNotifyFrom\(/.test(src),
    'cfg.notifyFrom goes through resolveNotifyFrom — the env value cannot bypass the guard');
  ok(/repairNoReplyFrom\(/.test(src), 'and the guard repairs (not merely warns) on a repairable provider');
  ok(/graph/.test(src.slice(src.indexOf('function resolveNotifyFrom'), src.indexOf('function resolveNotifyFrom') + 1600)),
    'Graph is special-cased — its From must be a real mailbox, so it warns instead of rewriting');
}

// ---------------------------------------------------------------------------
// 4. The live config load — a no-reply env value lands repaired.
//    (Fresh process-level require with the env staged; provider 'none' so the
//    repair path — not the Graph warn path — runs.)
// ---------------------------------------------------------------------------
{
  const { execFileSync } = require('child_process');
  const out = execFileSync(process.execPath, ['-e', `
    process.env.NOTIFY_FROM = 'YS Capital Group <no-reply@yscapgroup.com>';
    process.env.EMAIL_PROVIDER = 'none';
    const cfg = require(${JSON.stringify(path.join(__dirname, '..', 'src', 'config.js'))});
    console.log(cfg.notifyFrom);
  `], { encoding: 'utf8' });
  ok(out.includes('YS Capital Group <notifications@yscapgroup.com>'),
    `a no-reply NOTIFY_FROM lands repaired in cfg (got: ${out.trim().split('\n').pop()})`);

  const graphOut = execFileSync(process.execPath, ['-e', `
    process.env.NOTIFY_FROM = 'YS Capital Group <no-reply@yscapgroup.com>';
    process.env.EMAIL_PROVIDER = 'graph';
    const cfg = require(${JSON.stringify(path.join(__dirname, '..', 'src', 'config.js'))});
    console.log(cfg.notifyFrom);
  `], { encoding: 'utf8' });
  ok(graphOut.includes('<no-reply@yscapgroup.com>'),
    'under Graph the value is NOT rewritten (the From must be a real tenant mailbox) — the loud warning is the enforcement there');
}

console.log(`\nOK — ${pass} checks passed.`);
