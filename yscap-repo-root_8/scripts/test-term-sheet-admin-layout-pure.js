#!/usr/bin/env node
'use strict';
/* THE TERM-SHEET ADMIN ACCORDION (owner-directed 2026-08-18: "modernize +
 * reorganize the Manual section of Products & Pricing / Term Sheet generator")
 * is a LAYOUT-ONLY restructure — every admin control, id, default and engine
 * input must survive byte-level intact inside the new <details> sections.
 * This suite is the guard that the restructure (and any future re-touch of the
 * page) never drops, duplicates or re-defaults a pricing control:
 *
 *   A. every admin field id exists EXACTLY once (a dropped id silently
 *      disconnects a pricing knob from termsheet.js — gather() reads by id and
 *      a missing element reads as "blank", which prices the default without a
 *      word; a duplicated id makes getElementById nondeterministic).
 *   B. the load-bearing attributes survive: data-noshare on every admin input
 *      (the share-link scrubber keys on it), tsMinIntManual stays CHECKED by
 *      default (the manual-product min-interest rule), tsManualFields /
 *      tsMinIntManualRow / tsManualHint stay hidden, tsLadderPick stays a
 *      hidden input.
 *   C. the accordion shape: 7 sections, Manual scenario FIRST and the only one
 *      open by default, in the designed order; each carries an "In use" chip.
 *   D. the chip script's own exclusions (tsMinIntManual, tsLadderPick) — the
 *      two fields whose "engaged" reading would otherwise lie.
 *   E. the frozen engine <script> tags are untouched (layout may never ride
 *      along with an engine edit).
 */
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) pass++; else { fail++; console.log(`FAIL ${name}`); } };

const html = fs.readFileSync(path.join(__dirname, '..', 'web', 'v2', 'tools', 'term-sheet.html'), 'utf8');

// ---- A. every admin control id exactly once --------------------------------------------------
const IDS = [
  // gate + shell
  'tsAdminTrigger', 'tsAdminLock', 'tsAdminPw', 'tsAdminGo', 'tsAdminErr', 'tsAdminPanel', 'tsAdminHide',
  // markup / YSP
  'tsYspStd', 'tsYspGold', 'tsYspSilver', 'tsYspGoldT1',
  // origination
  'tsOrigStd', 'tsOrigGold', 'tsOrigSilver', 'tsOrigManual',
  // closing costs
  'tsFeeUW', 'tsFeeCredit', 'tsFeeAppr', 'tsFeeTitle',
  // exceptions
  'tsEffPrice', 'tsEffPriceHint', 'tsOopRehabMax', 'tsOopRehab', 'oopInfoWrap', 'oopInitialCut', 'oopMaxRehab',
  // loan amount
  'tsLadderPick', 'tsTargetLoan', 'tsTargetLoanHint',
  // manual scenario
  'tsManualOn', 'tsManualFields', 'tsMLtv', 'tsMArv', 'tsMLtc', 'tsMRate', 'tsMIr', 'tsManualHint',
  // options + min interest
  'tsAccrual', 'tsDeferredOrig', 'tsMinIntProgRow', 'tsMinIntStd', 'tsMinIntGold', 'tsMinIntSilver',
  'tsMinIntManualRow', 'tsMinIntManual',
];
for (const id of IDS) {
  const n = (html.match(new RegExp(`id="${id}"`, 'g')) || []).length;
  ok(`A id="${id}" appears exactly once`, n === 1);
}

// ---- B. load-bearing attributes --------------------------------------------------------------
const tagOf = (id) => {
  const m = html.match(new RegExp(`<(?:input|select)[^>]*id="${id}"[^>]*>`));
  return m ? m[0] : '';
};
const NOSHARE_INPUTS = ['tsYspStd', 'tsYspGold', 'tsYspSilver', 'tsYspGoldT1', 'tsOrigStd', 'tsOrigGold',
  'tsOrigSilver', 'tsOrigManual', 'tsFeeUW', 'tsFeeCredit', 'tsFeeAppr', 'tsFeeTitle', 'tsEffPrice',
  'tsOopRehabMax', 'tsOopRehab', 'tsLadderPick', 'tsTargetLoan', 'tsManualOn', 'tsMLtv', 'tsMArv',
  'tsMLtc', 'tsMRate', 'tsMIr', 'tsAccrual', 'tsDeferredOrig', 'tsMinIntStd', 'tsMinIntGold',
  'tsMinIntSilver', 'tsMinIntManual'];
for (const id of NOSHARE_INPUTS) {
  ok(`B data-noshare survives on ${id}`, /\bdata-noshare\b/.test(tagOf(id)));
}
ok('B tsMinIntManual is still CHECKED by default (manual-product min-interest rule)',
  /\bchecked\b/.test(tagOf('tsMinIntManual')));
ok('B tsMinIntStd/Gold/Silver are NOT default-checked',
  ['tsMinIntStd', 'tsMinIntGold', 'tsMinIntSilver'].every((id) => !/\bchecked\b/.test(tagOf(id))));
ok('B tsLadderPick is still a hidden input', /type="hidden"/.test(tagOf('tsLadderPick')));
ok('B tsManualFields still starts hidden', /<div[^>]*id="tsManualFields"[^>]*\bhidden\b/.test(html));
ok('B tsMinIntManualRow still starts hidden', /<div[^>]*id="tsMinIntManualRow"[^>]*\bhidden\b/.test(html));
ok('B tsManualHint still starts hidden', /<p[^>]*id="tsManualHint"[^>]*\bhidden\b/.test(html));
ok('B tsAccrual still defaults to non_dutch (first option)',
  /<select id="tsAccrual"[^>]*>\s*<option value="non_dutch">/.test(html.replace(/\n\s*/g, ' ').replace(/> </g, '><')) ||
  /value="non_dutch">[^<]*default/i.test(html));

// ---- C. the accordion shape ------------------------------------------------------------------
const secRe = /<details class="ts-adm-sec"( open)?>\s*<summary>[\s\S]*?<span class="ts-adm-title">([\s\S]*?)<\/span>/g;
const secs = [];
let m;
while ((m = secRe.exec(html))) secs.push({ open: !!m[1], title: m[2].replace(/<[^>]+>/g, '').trim() });
ok('C 7 accordion sections', secs.length === 7);
ok('C exactly ONE section is open by default', secs.filter((s) => s.open).length === 1);
ok('C the Manual scenario is FIRST and is the open one',
  secs[0] && secs[0].open && /^Manual scenario/.test(secs[0].title));
const ORDER = [/^Manual scenario/, /^Loan amount/, /^Rate markup \/ YSP/, /^Origination points/,
  /^Closing-cost overrides/, /^Deal exceptions/, /^Term-sheet options/];
ok('C sections come in the designed order',
  secs.length === 7 && ORDER.every((re, i) => re.test(secs[i].title)));
ok('C every section carries an In-use chip (hidden until engaged)',
  (html.match(/<span class="ts-adm-chip" hidden>In use<\/span>/g) || []).length === 7);
ok('C the Gold top tier sub-group lives inside the page (merged under YSP)',
  /<div class="ts-admin-group">Gold top tier — manual markup<\/div>/.test(html));
ok('C the min-interest sub-group lives inside the page (merged under options)',
  /<div class="ts-admin-group">3-month minimum earned interest /.test(html));
ok('C the Silver 1.00% hard-cap note survives verbatim',
  /hard-capped at 1\.00%/.test(html));
ok('C the loan-amount reduce/approve note survives verbatim',
  /goes to an admin for approval/.test(html));

// ---- D. the chip script ----------------------------------------------------------------------
const scriptM = html.match(/Admin accordion "In use" chips[\s\S]*?<\/script>/);
ok('D the chip script exists', !!scriptM);
const script = scriptM ? scriptM[0] : '';
ok('D …and excludes tsMinIntManual (checked by default is not "in use")', /tsMinIntManual/.test(script));
ok('D …and excludes the internal tsLadderPick hand-off', /tsLadderPick/.test(script));
ok('D …and re-checks on a tick (programmatic snapshot restores fire no events)', /setInterval/.test(script));

// ---- E. the frozen engine script tags are untouched ------------------------------------------
for (const eng of ['standard-program.js', 'gold-standard.js', 'silver-program.js', 'termsheet.js']) {
  ok(`E the page still loads ${eng}`, new RegExp(`<script src="[^"]*${eng.replace('.', '\\.')}[^"]*"`).test(html));
}

console.log(`test-term-sheet-admin-layout-pure: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
