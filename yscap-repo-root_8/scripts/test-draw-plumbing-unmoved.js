'use strict';
/**
 * THE PLUMBING DID NOT MOVE — a guard on the draw-workflow build (owner-directed 2026-08-09).
 *
 * The owner, twice: "I don't want to restructure the way it links each and every draw, each and
 * every property, to the source, to Trinity, or to Sitewire, because that's working already.
 * That's the logic, and I don't want to touch that logic because I believe it's too risky. Just
 * want to enhance the workflow." And: "Don't touch the way it's set up, the details."
 *
 * So the draw enhancements SIT ON TOP: new columns, new tables, new screens, new emails, new
 * reminders. This test is the mechanical proof that the linking logic underneath is untouched,
 * because "I was careful" is not a guarantee anybody can check later.
 *
 * WHAT IT ACTUALLY CHECKS, and why it is shaped this way. A line-count or a hash of a whole file
 * would be a tripwire that fires on an unrelated fix and gets deleted the first time it cries
 * wolf. Instead it pins the SPECIFIC INVARIANTS that would have to break for the plumbing to have
 * been restructured:
 *
 *   1. The functions that link a draw / a property to its source still exist, exported, with the
 *      same names — nothing was "cleaned up" or renamed underneath a caller.
 *   2. THE TWO ID SPACES ARE STILL NEVER MATCHED AGAINST EACH OTHER. A Sitewire draw id and a
 *      TrustPoint draw id are unrelated numbers; the only legal crossing is the mirror's own
 *      `trustpoint_draws.sitewire_draw_id` link column. Everything this batch added that had to
 *      cross the two goes through it, and this asserts that no new code compares them directly.
 *   3. The only-ours rule still holds: every new surface that reads a project is scoped to a link
 *      PILOT created (`matched_by='created'`).
 *   4. The one-source-of-money rule still holds: nothing new recomputes a draw's figures.
 *
 * No DB, no network — it reads the source.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let n = 0;
const ok = (cond, what) => { assert.ok(cond, what); n++; };
// Deep-compares via JSON: assert.strictEqual on two arrays compares references and fails on
// identical contents.
const eq = (a, b, what) => { assert.strictEqual(JSON.stringify(a), JSON.stringify(b), `${what} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); n++; };

const SRC = path.join(__dirname, '..', 'src');
const read = (rel) => fs.readFileSync(path.join(SRC, rel), 'utf8');

// ─────────────────────────────────────────── 1. the linking functions still exist, by name
{
  const orchestrator = require('../src/sitewire/orchestrator');
  for (const fn of ['pushFile', 'pushBudget', 'resolveCapitalPartnerId', 'resolveRule', 'resolveInspection', 'getLink', 'isManaged', 'park', 'journal', 'circuitCheck']) {
    eq(typeof orchestrator[fn], 'function', `1a orchestrator.${fn} is still exported`);
  }
  const mapper = require('../src/sitewire/mapper');
  for (const fn of ['explodeSow', 'reconcileToBudget', 'unitCount']) {
    eq(typeof mapper[fn], 'function', `1b mapper.${fn} is still exported`);
  }
  const routing = require('../src/sitewire/routing');
  for (const fn of ['platformOf', 'isTrustpoint', 'isExternal', 'resolveFilePlatform']) {
    eq(typeof routing[fn], 'function', `1c routing.${fn} is still exported`);
  }
}

// ─────────────────────────────────────────── 2. the two id spaces are never matched directly
//
// The legal crossing is `trustpoint_draws.sitewire_draw_id`. What is NOT legal is comparing a
// Sitewire draw id to a TrustPoint draw id — `tp_draw_id = <a sitewire id>` or the reverse. That
// mistake finds a row often enough to look correct and is wrong about which draw it describes.
{
  const FILES = [
    'sitewire/draw-checklist.js', 'sitewire/draw-attachments.js', 'sitewire/auto-release.js',
    'sitewire/stage-events.js', 'sitewire/draw-settings.js', 'sitewire/release-party.js',
    'sitewire/investor-delivery-send.js', 'lib/draw-label.js',
  ];
  // `tp_draw_id` compared to anything whose name says "sitewire".
  const BAD = [
    /tp_draw_id\s*=\s*\$?\d*\s*::?\s*bigint\s*(?:AND|\)|$)?[^\n]*sitewire_draw_id/i,
    /tp_draw_id\s*=\s*[^\n]*\bsitewireDrawId\b/,
    /sitewire_draw_id\s*=\s*[^\n]*\btp_draw_id\b(?![^\n]*trustpoint_draws)/,
  ];
  for (const f of FILES) {
    const src = read(f);
    for (const re of BAD) {
      ok(!re.test(src), `2a ${f} never matches a TrustPoint draw id against a Sitewire one`);
    }
    // Any file that DOES mention tp_draw_id must reach it through the mirror's own link column.
    if (/tp_draw_id/.test(src)) {
      ok(/trustpoint_draws/.test(src) && /sitewire_draw_id/.test(src),
        `2b ${f} crosses the two id spaces only through trustpoint_draws' own link column`);
    }
  }
  // The link column itself is still what the label resolver and the delivery use.
  ok(/trustpoint_draws WHERE sitewire_draw_id=\$1::bigint/.test(read('lib/draw-label.js')),
    '2c the draw-number resolver still reads TrustPoint through the mirror link, never by matching ids');
}

// ─────────────────────────────────────────── 3. only-ours: PILOT follows what PILOT created
{
  // Every NEW module that FOLLOWS a project answers the only-ours question — either by scoping its
  // own read to matched_by='created', or by resolving management through something that does
  // (releaseStateFor, resolveFilePlatform). Note the shape of the rule: `application_id` is UNIQUE
  // on sitewire_property_links, so an unscoped read of a per-file COLUMN (the out-of-pocket floor)
  // is unambiguous and byte-identical to a scoped one — and the manual release route reads it that
  // way, so the automatic writer must too or the two money paths would differ. What matters is that
  // nothing DECIDES to manage a file without asking.
  for (const f of ['sitewire/release-party.js', 'sitewire/auto-release.js']) {
    const src = read(f);
    if (!/sitewire_property_links/.test(src)) continue;
    ok(/matched_by\s*=\s*'created'/.test(src) || /releaseStateFor\(|resolveFilePlatform\(/.test(src),
      `3a ${f} only ever follows a property PILOT created (the go-forward-only rule)`);
  }
  // …and so is every new reminder sweep, through the shared helper.
  const digests = read('lib/notification-digests.js');
  for (const fn of ['drawInspectionLateOnce', 'drawFindingsUnreviewedOnce', 'drawApprovedUnrecordedOnce']) {
    const body = digests.slice(digests.indexOf(`async function ${fn}`), digests.indexOf(`async function ${fn}`) + 2600);
    ok(/activeManagedLink\(/.test(body), `3b ${fn} is scoped to an ACTIVE PILOT-managed project`);
  }
  // The retainage sweep reads the link directly and must be scoped the same way.
  const ret = digests.slice(digests.indexOf('async function retainageReleasableOnce'), digests.indexOf('async function retainageReleasableOnce') + 2200);
  ok(/matched_by='created'/.test(ret), '3c the retainage sweep only follows a PILOT-created project');
}

// ─────────────────────────────────────────── 4. nothing new recomputes a draw's money
//
// `approval.drawMoney()` (through `rollup.loadRollup`) is the ONE source of per-draw money. The
// automatic ledger writer reads it and hands the figures to the SAME `money.computeRelease` the
// manual release route uses — it must never do its own arithmetic on approved/fee/retainage.
{
  const src = read('sitewire/auto-release.js');
  ok(/rollupMod\.loadRollup\(/.test(src), '4a the automatic ledger writer reads the rollup');
  ok(/computeRelease\(/.test(src), '4b …and splits it with the shared splitter');
  // No hand-rolled retainage or net arithmetic.
  ok(!/retainage[_A-Za-z]*\s*=\s*[^;]*\*\s*\(?\s*pct/i.test(src), '4c …and never computes retainage itself');
  ok(!/net[_A-Za-z]*\s*=\s*approved\s*-\s*fee/i.test(src), '4d …nor the borrower\'s net');
  // The checklist and the release-party card describe; they never write money.
  for (const f of ['sitewire/draw-checklist.js', 'sitewire/release-party.js']) {
    const s2 = read(f);
    ok(!/INSERT INTO draw_disbursements/i.test(s2), `4e ${f} never writes to the money ledger`);
  }
  // The release-party module writes TWO things and only two: the read-only PA date it materializes
  // from Encompass (on `applications`), and the draw desk's "process this file as sold" override
  // (on the draw project, db/543 — owner-directed 2026-08-13). The guard is unchanged in substance:
  // what it exists to prove is that this module never sets who releases the money by itself.
  const rp = read('sitewire/release-party.js');
  // Match real SQL only (`UPDATE <table> SET`) — a bare /UPDATE\s+\w+/ also catches the word in a
  // sentence, which is how this first read "is" as a table name.
  const updates = [...new Set([...rp.matchAll(/UPDATE\s+(\w+)\s+SET/gi)].map((m) => m[1]))].sort();
  eq(updates, ['applications', 'sitewire_property_links'], '4f release-party writes two tables only');
  ok(/purchase_advice_date/.test(rp) && !/investor_funding_mode\s*=\s*[^=]/.test(rp),
    '4g …and never the funding mode — it never changes who releases the money by itself');
  // Every column it writes on the draw project is the override and nothing else.
  const linkCols = [...rp.matchAll(/UPDATE\s+sitewire_property_links\s+SET([\s\S]*?)WHERE/gi)]
    .flatMap((m) => [...m[1].matchAll(/(\w+)\s*=/g)].map((c) => c[1]))
    .filter((c) => c !== 'now');
  eq([...new Set(linkCols)].sort(),
    ['sold_check_at', 'treat_as_sold_at', 'treat_as_sold_by', 'treat_as_sold_note', 'updated_at'],
    '4h …and the override + the sold-recheck stamp are ALL it writes there — never the release setting, never money');
  // The override moves the answer towards SOLD only; it can never write the sold FACT itself.
  ok(!/purchase_advice_date\s*=\s*\$?\d?\s*(?!.*fieldValues)/.test(rp.split('syncPurchaseAdviceDate')[0] || ''),
    '4i …and nothing outside the Encompass sync writes the purchase advice date');
}

// ─────────────────────────────────────────── 5. Encompass is still read-only
{
  // The new registry entry is pull-only and reference-gated — it can never compare or gate.
  const fm = require('../src/lib/integrations/encompass-field-map');
  const entry = fm.BY_KEY.purchase_advice_date;
  if (entry) {   // only present when the owner's field id is configured
    eq(entry.direction, 'pull', '5a the PA-date entry is pull-only');
    eq(entry.compare, 'reference', '5b …never compared');
    eq(entry.blocksCtc, false, '5c …never blocks clear-to-close');
    eq(entry.blocksFunding, false, '5d …never blocks funding');
  } else {
    ok(fm.PA_DATE_FIELD_ID === null, '5a the PA-date entry is absent exactly when no field id is configured');
  }
  // Nothing in the new code writes to Encompass.
  for (const f of ['sitewire/release-party.js', 'sitewire/auto-release.js', 'sitewire/draw-settings.js']) {
    ok(!/encompass\/v\d|apiPost|updateLoan|patchLoan/i.test(read(f)), `5e ${f} never writes to Encompass`);
  }
}

console.log(`test-draw-plumbing-unmoved: all ${n} plumbing-unchanged checks passed.`);
