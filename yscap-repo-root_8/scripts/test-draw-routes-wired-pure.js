'use strict';
/**
 * EVERY DRAW ROUTE THIS BATCH ADDED HAS SOMETHING THAT CALLS IT (owner-directed 2026-08-09 build).
 *
 * WHY THIS EXISTS. Three of the routes in this batch shipped with a working back end, a passing DB
 * test, and NO CALLER — the "fees owed by investors" list, the per-file draw settings, and the
 * inspection review stamp. Every one of them was green: the route was correct, its query was
 * EXPLAIN'd, its behaviour was unit-tested. None of that can notice that no screen ever asks the
 * question, so the feature simply did not exist for the person it was built for.
 *
 * THE CLASS: a back end is not a feature. A route with no caller is indistinguishable from a
 * finished one in every test that exercises the route directly — which is every test we write.
 *
 * WHAT THIS CHECKS. For each route below, that its path still appears somewhere under `app-v2/src`.
 * It is a WIRING check, not a behaviour check: it cannot tell you the screen is good, only that the
 * question is asked at all. That is exactly the gap the other suites cannot see.
 *
 * A route that is DELIBERATELY server-only belongs in SERVER_ONLY with the reason written down —
 * so "nothing calls this" is always either a failure or a recorded decision, never an accident.
 *
 * No DB, no network — it reads the source.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let n = 0;
const ok = (cond, what) => { assert.ok(cond, what); n++; };

const ROOT = path.join(__dirname, '..');
const APP = path.join(ROOT, 'app-v2', 'src');

// Every .js/.jsx under app-v2/src, concatenated once.
function readAppSource() {
  const out = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(js|jsx|mjs)$/.test(e.name)) out.push(fs.readFileSync(p, 'utf8'));
    }
  })(APP);
  return out.join('\n');
}
const APP_SRC = readAppSource();

// ─────────────────────────────────────────── the routes this batch added, and who asks
//
// Each `match` is a REGEX pinning the call as it is WRITTEN at the call site — a template literal,
// so a `:param` segment appears as `${...}` and only the literal runs can be matched. They are
// deliberately per-ROUTE rather than per-route-family: `/fees-owed` and `/fees-owed/:id/received`
// are two different features, and a substring test for the family passes when only one is wired.
const WIRED = [
  { match: /['"`]\/api\/sitewire\/fees-owed['"`]/,          what: 'the list of fees investors owe us' },
  { match: /\/fees-owed\/\$\{[^}]+\}\/received/,            what: 'marking one of those fees received' },
  { match: /\/draw-settings`/,                              what: 'every knob on this file and which level decided it' },
  { match: /\/release-party`/,                              what: 'who releases the money on this project' },
  { match: /\/investor-answer`/,                            what: "recording the investor's answer" },
  { match: /\/findings\/\$\{[^}]+\}\/review`/,              what: 'the inspection review stamp' },
  { match: /\/draws\/\$\{[^}]+\}\/attachments`/,            what: 'supporting documents on a draw' },
  { match: /\/attachments\/\$\{[^}]+\}\/file`/,             what: 'opening one of those documents' },
];

for (const r of WIRED) {
  ok(r.match.test(APP_SRC),
    `a screen asks for ${r.what} — nothing under app-v2/src matches ${r.match}, so the back end exists and nobody can reach it`);
}

// ─────────────────────────────────────────── deliberately server-only, with the reason
const SERVER_ONLY = [
  { match: '/findings/public', why: 'the borrower opens it from an emailed token link, not from the portal bundle' },
];
for (const r of SERVER_ONLY) {
  ok(typeof r.why === 'string' && r.why.length > 20, `a server-only route records WHY nothing calls it (${r.match})`);
}

// ─────────────────────────────────────────── the two the desk cannot render without
//
// A route can be called and still be useless if the payload it answers with is missing the one
// field the screen keys on. These two were both real: the rollup returned findings WITHOUT
// `reviewed_at`, so the review stamp could never show as done; and the fee rows are what the fees
// card renders per line.
{
  const routes = fs.readFileSync(path.join(ROOT, 'src', 'routes', 'sitewire.js'), 'utf8');
  ok(/SELECT[^;]*reviewed_at[^;]*FROM draw_findings/.test(routes),
    'the rollup returns `reviewed_at` on a finding — without it the desk can never show the review as done');
  const auto = fs.readFileSync(path.join(ROOT, 'src', 'sitewire', 'auto-release.js'), 'utf8');
  ok(/sd\.number AS draw_number/.test(auto),
    'the fees-owed rows carry the DRAW NUMBER — the fees card says "Draw 2", never a platform id');
}

// ─────────────────────────────────────────── the threshold has ONE reader
//
// The chase reminder and the fees card must never disagree about which fee is overdue, so neither
// may re-inline the fallback. The screen takes the number the server resolved.
{
  const digests = fs.readFileSync(path.join(ROOT, 'src', 'lib', 'notification-digests.js'), 'utf8');
  ok(/daysSettingFor\(/.test(digests),
    'the reminder sweeps resolve their day thresholds through draw-settings.daysSettingFor');
  const routes = fs.readFileSync(path.join(ROOT, 'src', 'routes', 'sitewire.js'), 'utf8');
  ok(/chase_days\s*=\s*await drawSettings\.daysSettingFor\(/.test(routes),
    '…and the fees route hands the SAME resolved number to the screen');
  ok(!/const\s+LATE_DAYS\s*=\s*\d+/.test(fs.readFileSync(path.join(APP, 'screens', 'StaffDraws.jsx'), 'utf8')),
    '…and the screen never hard-codes it — a constant there would drift the moment the setting changed');
}

console.log(`test-draw-routes-wired-pure: all ${n} wiring checks passed.`);
