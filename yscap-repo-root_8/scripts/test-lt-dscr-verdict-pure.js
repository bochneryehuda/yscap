'use strict';
/**
 * LT test — the DSCR verdict: whose thresholds, and when to say nothing.
 *
 * The DSCR is the number a long-term file is underwritten on, and the questions
 * that matter here are not "does 0.9 read as below 1.0" — they are the ones where
 * a wrong answer puts a red mark on a loan nobody measured, or a green one on a
 * loan that fails.
 */

const path = require('path');
const fs = require('fs');

const V = require('../src/longterm/dscr-verdict');
const verdict = V.dscrVerdict;

let failures = 0;
const check = (cond, msg) => {
  if (cond) console.log(`  ok   ${msg}`);
  else { failures += 1; console.error(`  FAIL ${msg}`); }
};

console.log('the ratio is judged against the COMPANY\'s own thresholds');

check(verdict(0.92, {}).level === 'below',
  'under the minimum reads as below — the property does not cover its own debt service on the figures we hold');
check(verdict(1.10, {}).level === 'thin',
  'over the minimum but under the comfortable line reads as thin');
check(verdict(1.40, {}).level === 'comfortable', 'over the comfortable line reads as comfortable');
check(verdict(1.00, {}).level === 'thin' && verdict(1.20, {}).level === 'comfortable',
  'the thresholds are inclusive at the line — a loan exactly AT the minimum is not below it, and one exactly at the comfortable line is comfortable');

const v = verdict(0.9, {});
check(v.minimum === 1 && v.comfort === 1.2,
  'the thresholds travel WITH the answer, so a screen can say what it compared against instead of pronouncing on the loan');

const buyer = { 'dscr.minimumRatio': 1.15, 'dscr.comfortRatio': 1.35 };
check(verdict(1.10, buyer).level === 'below' && verdict(1.20, buyer).level === 'thin'
  && verdict(1.40, buyer).level === 'comfortable',
  'THE ONE THAT MATTERS: a company that works to different figures changes two SETTINGS and every verdict moves with them — no code change, which is the whole promise the settings registry makes to a buyer');

console.log('\nit never judges a ratio nobody measured');

for (const nothing of [null, undefined, '', 'n/a', NaN, [], {}, false]) {
  if (verdict(nothing, {}) !== null) {
    failures += 1;
    console.error(`  FAIL ${JSON.stringify(nothing)} should produce NO verdict`);
  }
}
check(true,
  'a missing DSCR gets no verdict at all — "we have not read it" and "it is bad" are different facts, and this is the one place where confusing them would put a red mark on a loan nobody has measured');
check(verdict('1.4', {}) === null,
  '…and a ratio that arrived as TEXT is not judged either: this takes the number the mirror stored, and quietly parsing a string here would hide the day it stops being one');

console.log('\na misconfigured threshold fails the safe way');

check(verdict(0.5, { 'dscr.minimumRatio': null }).level === 'below'
  && verdict(0.5, { 'dscr.minimumRatio': '' }).level === 'below'
  && verdict(0.5, { 'dscr.minimumRatio': false }).level === 'below',
  'a CLEARED threshold falls back to the shipped one — `Number(null)`, `Number("")` and `Number(false)` are all a perfectly finite 0, and a minimum of zero would pass every loan there has ever been');
check(verdict(0.5, { 'dscr.minimumRatio': 0 }).level === 'below',
  '…and so does an explicit zero, for the same reason: a DSCR floor of nothing is a misconfiguration, never a policy');
check(verdict(0.5, { 'dscr.minimumRatio': 'tomorrow' }).level === 'below',
  '…and so does a threshold nobody could read as a number');

// These three are what make the type test in `threshold()` a real guard rather
// than decoration: each one SURVIVES the `> 0` check and becomes a live threshold.
// NOTE the boolean is tried on the COMFORTABLE line, not the minimum: `Number(true)`
// is 1, which is exactly the shipped minimum, so a boolean there produces the right
// answer for the wrong reason and no ratio could ever tell the two apart. On the
// comfortable line it collapses the whole "thin" band, which is visible.
check(verdict(1.10, { 'dscr.comfortRatio': true }).level === 'thin',
  'THE ONE THAT MATTERS: a checkbox saved into a threshold reads as NOTHING, not as a line of 1.00 — `Number(true)` is a perfectly good 1, and taken as the comfortable line it would call a thin 1.10 loan comfortable');
check(verdict(1.05, { 'dscr.minimumRatio': [1.5] }).level === 'thin',
  '…and neither does a one-element list, which converts to 1.5 as happily as the string would');
check(verdict(3.0, { 'dscr.minimumRatio': new Date('2026-08-18') }).level === 'comfortable',
  '…and neither does a date, which converts to about 1.79 TRILLION and would put every loan this company has ever written below its own minimum');
check(verdict('x', {}) === null && verdict(1.3, null) !== null,
  'and it never throws on junk — a missing settings object simply means the shipped thresholds');

const upside = verdict(1.05, { 'dscr.minimumRatio': 1.2, 'dscr.comfortRatio': 1.0 });
check(upside.level === 'below' && upside.comfort >= upside.minimum,
  'a comfortable line set BELOW the minimum is a misconfiguration, not an opinion: the minimum wins, so the worst a bad pair can do is collapse two verdicts into one rather than call a failing loan comfortable');

console.log('\nit is one definition, and the screen says what it compared against');

const src = fs.readFileSync(path.join(__dirname, '..', 'src/longterm/dscr-verdict.js'), 'utf8');
check(!/require\(/.test(src),
  'the rule is pure — no database, no settings load, nothing that can fail, so the file screen and anything that judges a ratio later can share it');

const fileSrc = fs.readFileSync(path.join(__dirname, '..', 'src/longterm/file.js'), 'utf8');
check(/dscrVerdict\.dscrVerdict\(num\(l\.dscr_ratio\), opts\.settings\)/.test(fileSrc),
  'the file screen sends the verdict beside the ratio, judged on the settings the route already loaded');
const routeSrc = fs.readFileSync(path.join(__dirname, '..', 'src/longterm/routes/pipeline.js'), 'utf8');
check(/loadFile\(rows\[0\]\.id, rows\[0\], \{ settings \}\)/.test(routeSrc),
  '…and the route hands them over — without them every loan would be judged on the shipped figures whatever the company set');

const ui = fs.readFileSync(path.join(__dirname, '..', 'app-v2/src/longterm/LtFileSections.jsx'), 'utf8');
check(/function DscrFigure/.test(ui) && /verdict\.minimum/.test(ui),
  'the screen NAMES the threshold it fell under — "below the 1.00 minimum this company set" is a fact somebody can act on, while a red number on its own is an opinion nobody can check');
check(/if \(!verdict\) return <span>\{shown\}<\/span>/.test(ui),
  '…and draws a plain figure when there is no verdict, rather than inventing one');

console.log('\nand the pipeline reads the SAME rule, so one loan is never two answers');

const cols = fs.readFileSync(path.join(__dirname, '..', 'src/longterm/pipeline-columns.js'), 'utf8');
check(/dscr: \{ label: 'DSCR', field: 'dscr_ratio'[^}]*kind: 'dscr'/.test(cols),
  'the pipeline\'s DSCR column is its own kind rather than a bare ratio, which is what lets the cell say more than a number');
check(/raw === ''\) \? null : Number\(raw\)/.test(routeSrc.replace(/\s+/g, ' '))
  && /dscrVerdict\.dscrVerdict\(Number\.isFinite\(r\) \? r : null, settings\)/.test(routeSrc),
  'THE ONE THAT MATTERS: the pipeline computes the verdict with the SAME module the file screen uses, off the same conversion — a copy in the browser is how two screens come to call one loan below and thin, and `Number("")` being a finite 0 is how one of them puts a red mark on a blank ratio');
check(/cols\.columns\.some\(\(c\) => c\.key === 'dscr'\)/.test(routeSrc),
  '…and only when the column is actually drawn, because a field nothing renders is the shape this side keeps finding');

const pipeUi = fs.readFileSync(path.join(__dirname, '..', 'app-v2/src/longterm/LtPipeline.jsx'), 'utf8');
check(/function DscrCell/.test(pipeUi) && /case 'dscr': return <DscrCell row=\{row\} \/>/.test(pipeUi),
  'the pipeline draws it');
check(/if \(!v\) return <span>\{shown\}<\/span>/.test(pipeUi),
  '…and a loan nobody has measured gets a plain dash there too, never a red mark');

console.log('\nand it says WHOSE number it is');

// A red mark attributed to a rule nobody wrote is the same mistake as reading
// "does this differ from ours" as "did they choose": the value and its AUTHORSHIP
// are two questions, and only one of them was being answered.
{
  const ours = V.dscrVerdict(0.9, {});
  check(ours.level === 'below' && ours.minimum === 1,
    'with nothing configured a thin loan is still judged, on the shipped figures');
  check(ours.minimumIsCompany === false,
    'THE ONE THAT MATTERS: …and the verdict says the minimum is OURS, not theirs — both screens word it "this company set", which is a plain falsehood about a company that never set one, and it is the sentence under a red mark on somebody\'s loan');
  check(ours.comfortIsCompany === false, '…and the comfortable line likewise');

  const theirs = V.dscrVerdict(1.05, { 'dscr.minimumRatio': 1.1, 'dscr.comfortRatio': 1.35 });
  check(theirs.minimum === 1.1 && theirs.minimumIsCompany === true,
    'a company that DID set a minimum is credited with it');
  check(theirs.comfort === 1.35 && theirs.comfortIsCompany === true, '…and with their comfortable line');

  // A value the settings screen would accept but the rule refuses falls back to
  // ours, so it is ours — being present is not the same as being usable.
  for (const junk of [true, [1.15], 'soon', '', null, 0, -1]) {
    const v = V.dscrVerdict(1.05, { 'dscr.minimumRatio': junk });
    check(v.minimumIsCompany === false,
      `a minimum of ${JSON.stringify(junk)} is refused, so the threshold is OURS and is not credited to them`);
  }

  // A comfortable line raised to meet the minimum is no longer their number,
  // whatever they configured.
  const raised = V.dscrVerdict(1.5, { 'dscr.minimumRatio': 1.3, 'dscr.comfortRatio': 1.1 });
  check(raised.comfort === 1.3 && raised.comfortIsCompany === false,
    'THE ONE THAT MATTERS: a comfortable line configured BELOW the minimum is raised to meet it — and the raised figure is no longer the number they set, so it is not reported as theirs');
  check(raised.minimumIsCompany === true, '…while the minimum still is');
}

{
  const fs2 = require('fs');
  for (const f of ['app-v2/src/longterm/LtPipeline.jsx', 'app-v2/src/longterm/LtFileSections.jsx']) {
    const src = fs2.readFileSync(path.join(__dirname, '..', f), 'utf8');
    check(/minimumIsCompany/.test(src) && /comfortIsCompany/.test(src),
      `${f.split('/').pop()} reads whose number it is rather than asserting "this company set"`);
    check(!/minimum this company set/.test(src),
      `…and no longer carries the flat claim, which was false on every unconfigured company`);
  }
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
