'use strict';
/**
 * LT test — A ZONELESS WALL CLOCK IS NOT UTC, AND A MIRROR MUST FAIL TOWARD LOOKING
 * AGAIN.
 *
 * WHY THIS EXISTS (owner-reported 2026-08-25). Three brand-new files never filled in;
 * a loan sat on "File started" long after LO Prep completed; and "Pull everything from
 * Encompass" appeared to do nothing. THREE REPORTS, ONE CAUSE, and it was arithmetic:
 * `discover.parsePipelineDate` read Encompass's `"8/14/2026 10:48:18 AM"` — a wall
 * clock in the tenant's own timezone, carrying no offset — through `Date.UTC(...)`,
 * so every last-changed stamp was stored FOUR HOURS EARLY. `loans.needsRead` compares
 * that stamp against `encompass_synced_at`, which is a true instant, so a loan edited
 * minutes after PILOT read it compared as edited BEFORE and answered NOT DUE. A file
 * discovered while it was still empty then stayed empty for ever, and the full-pull
 * button correctly found no work and looked broken.
 *
 * SECTION 1 IS THE REPRODUCTION, not a description of it: it runs the OLD parser
 * beside the new one on the tenant's own sample string and asserts the four-hour gap,
 * then walks the owner's exact scenario through the real `needsRead`.
 *
 * SECTION 3 IS THE HALF THAT MATTERS LONGEST. Fixing the parser fixes today's stamp
 * problem and leaves the trap armed for the next one — a clock skew, a field the
 * tenant stops returning, a loan the search dates differently. So `needsRead` re-reads
 * every loan on a ROTA whatever the stamps say, and an unreadable or absent stamp
 * reads as "look again" rather than "never look again".
 *
 * PURE. No database, no network, no credentials.
 */

const path = require('path');
const fs = require('fs');

let failures = 0;
const check = (cond, msg) => {
  if (cond) console.log(`  ok   ${msg}`);
  else { failures += 1; console.error(`  FAIL ${msg}`); }
};

const tenantTime = require('../src/longterm/sync/tenant-time');
const discover = require('../src/longterm/sync/discover');
const loans = require('../src/longterm/sync/loans');

const parse = discover.parsePipelineDate;
const needsRead = loans.needsRead || (loans._internals && loans._internals.needsRead);

const H = 3600 * 1000;

/** The parser EXACTLY as it read before the fix — the baseline is built by writing
 *  out the old rule, deliberately NOT by reading git: once the fix is committed,
 *  HEAD carries the new rule and a git baseline degenerates into "the parser equals
 *  itself", passing for ever while proving nothing. */
function OLD_parsePipelineDate(v) {
  const s = String(v == null ? '' : v).trim();
  if (!s) return null;
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?)?$/i);
  if (!m) { const t = Date.parse(s); return Number.isFinite(t) ? new Date(t).toISOString() : null; }
  const [, mo, d, y, hh, mi, ss, ap] = m;
  let hour = hh == null ? 0 : Number(hh);
  if (ap) {
    const upper = ap.toUpperCase();
    if (upper === 'PM' && hour < 12) hour += 12;
    if (upper === 'AM' && hour === 12) hour = 0;
  }
  const dt = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d), hour, Number(mi || 0), Number(ss || 0)));
  return Number.isFinite(dt.getTime()) ? dt.toISOString() : null;
}

// ── 1. The bug, reproduced ───────────────────────────────────────────────────
console.log('the reported bug, reproduced against the old rule');

// The tenant's own sample, quoted verbatim in discover.js's header.
const SAMPLE = '8/14/2026 10:48:18 AM';
const before = OLD_parsePipelineDate(SAMPLE);
const after = parse(SAMPLE);

check(before === '2026-08-14T10:48:18.000Z',
  `the old rule read the tenant's own sample as ${before} — the digits, as if they were UTC`);
check(after === '2026-08-14T14:48:18.000Z',
  `the fixed rule reads it as ${after} — 10:48 in New York, which is what Encompass meant`);
const skewHours = (Date.parse(after) - Date.parse(before)) / H;
check(skewHours === 4,
  `every last-changed stamp was stored ${skewHours} hours early in summer`);
check((Date.parse(parse('1/14/2026 10:48:18 AM')) - Date.parse(OLD_parsePipelineDate('1/14/2026 10:48:18 AM'))) / H === 5,
  'and five hours early in winter — the offset is read per date, never assumed');

// The owner's scenario, through the REAL freshness test.
const readAt = Date.UTC(2026, 7, 14, 13, 0, 0);          // PILOT read it at 09:00 New York
const now = Date.UTC(2026, 7, 14, 15, 0, 0);             // it is now 11:00 New York
const rowOld = { encompass_synced_at: new Date(readAt).toISOString(), encompass_last_modified: before };
const rowNew = { encompass_synced_at: new Date(readAt).toISOString(), encompass_last_modified: after };

check(needsRead(rowOld, now) === false,
  'THE DEFECT: a loan edited 1h48m AFTER PILOT last read it answered NOT DUE under the old stamp');
check(needsRead(rowNew, now) === true,
  'and answers DUE with the stamp read correctly — the same loan, the same code, the right timezone');

// ── 2. The parser still refuses what it always refused ───────────────────────
console.log('');
console.log('the parser still guesses at nothing');

check(parse('') === null, 'an empty string states nothing');
check(parse(null) === null, 'so does an absent value');
check(parse('not a date') === null, 'and so does anything it cannot read — never a guess');
check(parse('2026-08-14T14:48:18Z') === '2026-08-14T14:48:18.000Z',
  'a real ISO instant with its own offset is taken verbatim, never re-zoned');
check(parse('12/31/2026') === '2026-12-31T05:00:00.000Z',
  'a date with no time is midnight IN THE TENANT`S ZONE, not midnight UTC');

// A DST boundary: 2:30 AM on the spring-forward morning does not exist in New York.
// The two-pass correction must still answer an instant rather than NaN or a throw.
const spring = parse('3/8/2026 2:30:00 AM');
check(typeof spring === 'string' && Number.isFinite(Date.parse(spring)),
  `a wall-clock time inside the spring-forward gap still answers a real instant (${spring})`);

// ── 3. The rota — the half that outlives this particular stamp bug ───────────
console.log('');
console.log('a mirror fails toward looking again');

const t = Date.UTC(2026, 7, 14, 20, 0, 0);
const at = (hoursAgo) => new Date(t - hoursAgo * H).toISOString();

check(needsRead({ encompass_synced_at: null }, t) === true,
  'never read → due');
check(needsRead({ encompass_synced_at: at(1), encompass_last_modified: at(0.5) }, t) === true,
  'edited since we read it → due');
check(needsRead({ encompass_synced_at: at(1), encompass_last_modified: at(2) }, t) === false,
  'not edited since we read it, and read recently → not due');

check(needsRead({ encompass_synced_at: at(13), encompass_last_modified: null }, t) === true,
  'THE ROTA: a loan with NO Encompass stamp at all is re-read after twelve hours — the old rule answered "never look again" and abandoned it');
check(needsRead({ encompass_synced_at: at(1), encompass_last_modified: null }, t) === false,
  'but one read an hour ago is left alone, so the rota is a backstop and not a re-read of the book every pass');
check(needsRead({ encompass_synced_at: at(13), encompass_last_modified: at(20) }, t) === true,
  'and the rota fires even when the stamps insist nothing changed — which is exactly the case it exists for');

check(needsRead({ encompass_synced_at: 'not a date' }, t) === true,
  'an unreadable last-read stamp is not evidence that a loan is up to date');
check(needsRead({ encompass_synced_at: at(1), encompass_last_modified: 'not a date' }, t) === false,
  'an unreadable Encompass stamp claims no change — the rota is what eventually looks again');
check(needsRead(null, t) === false, 'no row at all is not a loan');

// ── 4. The drain cannot starve the rota ──────────────────────────────────────
console.log('');
console.log('the pass drains the longest-unread first');

const src = fs.readFileSync(path.join(__dirname, '..', 'src/longterm/sync/loans.js'), 'utf8');
check(/due\.push\(\{[^}]*syncedAt/.test(src),
  'each due loan carries its own last-read stamp into the queue');
check(/const drain = due\.slice\(\)\.sort\(/.test(src) && /for \(const item of drain\.slice\(0, readBudget\)\)/.test(src),
  'and the pass reads them oldest-first rather than in discovery order');
check(!/for \(const item of due\.slice\(0, readBudget\)\)/.test(src),
  'THE STARVATION: discovery hands loans over newest-changed first, so slicing THAT order would give the busy handful every slot and a loan on the rota would never reach the front');

// ── 5. The timezone is a setting, and a bad one degrades rather than throws ──
console.log('');
console.log('the timezone is configurable and fails soft');

check(tenantTime.DEFAULT_TZ === 'America/New_York',
  'the default is the tenant`s own zone — the same default the ClickUp side has read dates correctly with since it shipped');
check(tenantTime.zoneUsable('America/New_York') === true, 'a real zone is usable');
check(tenantTime.zoneUsable('Not/AZone') === false, 'and a nonsense one is reported as unusable rather than trusted');
check(tenantTime.wallClockToUtcMs(2026, 8, 14, 10, 48, 18, 'Not/AZone') === Date.UTC(2026, 7, 14, 10, 48, 18),
  'a nonsense zone degrades to the historic UTC reading — a mis-typed setting may not stop every read');
check(tenantTime.wallClockToUtcMs(2026, 8, 14, 10, 48, 18, 'Europe/London') === Date.UTC(2026, 7, 14, 9, 48, 18),
  'and a different real zone is honoured, so this is a setting rather than a hard-coded offset');

console.log('');
if (failures) {
  console.error(`\n${failures} FAILED`);
  process.exit(1);
}
console.log('all good');
