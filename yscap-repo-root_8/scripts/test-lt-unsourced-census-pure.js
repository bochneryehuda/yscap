'use strict';
/**
 * LT test — A REASON MAY NOT CONTRADICT THE CENSUS IT CITES.
 *
 * `application/unsourced.js` is the list of columns PILOT knowingly leaves empty,
 * and every entry carries a `why` that a person reads instead of a dash. Those
 * reasons are ARGUMENTS FROM THE CENSUS: "field 541 is filled on 40.2% of
 * long-term loans", "its six values were withheld", "nothing in 3,783 fields
 * carries a zone designation". That is the right way to write them — a measured
 * reason beats an opinion — and it is exactly what makes them able to go wrong
 * SILENTLY, which is the failure this whole file is about:
 *
 *   the census is regenerated, a number moves, and the sentence on the screen
 *   keeps quoting the old one; or a reason was simply wrong on the day it was
 *   written. Nothing errors. A person reads "Encompass does not give us this"
 *   and stops looking — which is worse than a dash, because a dash at least
 *   admits it is a blank.
 *
 * That is what happened here. The flood reason said field 541's values "were
 * withheld from the census by its own PII policy", and the zone reason said
 * NOTHING in the census carries a zone designation — while field 541, in the
 * same census, is a declared 89-value enum labelled "Property Info Flood Zone"
 * carrying X, AE, X500, A, C and Yes with a count each. Two sentences, one of
 * them contradicting the other's own cited field, and no test anywhere unhappy.
 *
 * So: every field a reason NAMES must exist in the census; every percentage a
 * reason quotes beside a field must be that field's own measured fill; and a
 * reason may not claim the census is SILENT about a field the census answers.
 *
 * A reason is allowed to RETRACT an earlier claim, and that is why `corrected`
 * exists rather than the retraction being written into the prose: a correction
 * necessarily QUOTES the wrong sentence, so a guard reading the live text would
 * fail on the very fix that closed the hole and would then be "fixed" by
 * deleting the explanation. The live reason says what is true now; `corrected`
 * carries what was said before and why it was wrong. This test is that field's
 * reader — it checks the retraction is complete and that the retracted sentence
 * is genuinely GONE from the live text.
 *
 * It reads the census and the module as DATA, so it needs no database and
 * cannot be satisfied by a stub.
 */

const fs = require('fs');
const path = require('path');

const unsourced = require('../src/longterm/application/unsourced');

const CENSUS_PATH = 'src/longterm/encompass/dictionary/field-dictionary.json';
const census = JSON.parse(fs.readFileSync(path.join(__dirname, '..', CENSUS_PATH), 'utf8'));
const FIELDS = census.fields || {};

let failures = 0;
const check = (cond, msg) => {
  if (cond) console.log(`  ok   ${msg}`);
  else { failures += 1; console.error(`  FAIL ${msg}`); }
};

/**
 * A citation is how a reason names a field the census measured. Three shapes are
 * in use and all three are real: a numbered Encompass field ("field 541"), a
 * tenant custom field ("CX.LLCNAME") and a form field ("URLA.X138"). The census
 * keys them exactly that way, so the citation IS the lookup key.
 */
const CITATION_RE = /\b[Ff]ield (\d+)\b|\b((?:CX|URLA|TQL)\.[A-Z0-9]+)\b/g;

/**
 * Phrases that assert the census has nothing to say. A reason carrying one of
 * these about a field the census DID record values for is the exact defect this
 * test exists to stop.
 */
const SILENCE_RE = /\bwithheld\b|\bnothing in\b|\bno field\b|\bcarries no\b/i;

function citationsOf(text) {
  const out = [];
  let m;
  CITATION_RE.lastIndex = 0;
  while ((m = CITATION_RE.exec(text))) out.push({ key: m[1] || m[2], at: m.index });
  return out;
}

/** The clause a citation owns runs to the NEXT citation — so a percentage quoted
 *  about one field can never be read as a claim about the field before it. */
function clausesOf(text) {
  const marks = citationsOf(text);
  return marks.map((mark, i) => ({
    key: mark.key,
    clause: text.slice(mark.at, i + 1 < marks.length ? marks[i + 1].at : text.length),
  }));
}

console.log('the census this test reads is the real one');

check(Object.keys(FIELDS).length > 3000,
  `the census parsed with its ${Object.keys(FIELDS).length} fields — a census that quietly read as empty would make every check below pass by finding nothing`);
check(FIELDS['541'] && Array.isArray(FIELDS['541'].observedValues) && FIELDS['541'].observedValues.length === 6,
  '…including field 541 and its six recorded values, which is the case this test was written for');

const entries = Object.entries(unsourced.UNSOURCED);
check(entries.length >= 20, `and the list under test really has its entries (${entries.length})`);

// ── Every field a reason names is a field the census measured ──────────────
//
// A citation the census does not carry is a reason nobody can check: the reader
// is asked to trust a measurement against a field that is not in the measurement.
console.log('\nevery field a reason names is one the census measured');

const unknown = [];
const cited = new Set();
for (const [key, entry] of entries) {
  for (const { key: field } of clausesOf(`${entry.why} ${entry.unblock}`)) {
    cited.add(field);
    if (!FIELDS[field]) unknown.push(`${key} cites ${field}`);
  }
}
check(unknown.length === 0,
  `no reason cites a field the census does not carry${unknown.length ? ` — these do: ${unknown.join(', ')}` : ''}`);
check(cited.size >= 10,
  `…and the reasons really do argue from the census (${cited.size} distinct fields cited), so this check is measuring something`);

// ── THE ONE THAT MATTERS: a quoted percentage is the census's own ──────────
//
// "filled on 40.2% of long-term loans" is a MEASUREMENT, and the census is where
// it was measured. Regenerate the census on a fresh pull and this is the first
// thing to go stale — silently, because prose does not fail a build.
console.log('\nevery percentage a reason quotes is the number the census holds');

const wrong = [];
const checkedPcts = [];
let quotedPcts = 0;
for (const [key, entry] of entries) {
  const text = `${entry.why} ${entry.unblock}`;
  quotedPcts += (text.match(/\d+(?:\.\d+)?%/g) || []).length;
  for (const { key: field, clause } of clausesOf(text)) {
    const row = FIELDS[field];
    if (!row) continue;
    // Exactly one percentage per clause, and it is the one written about this
    // field: the moment a sentence turns to another field it NAMES it, which
    // opens that field's own clause. The count check below is what keeps that
    // true — see it for why this is a rule rather than a convention.
    const pct = (clause.match(/(\d+(?:\.\d+)?)%/) || [])[1];
    if (pct === undefined) continue;
    const measured = row.fill && row.fill.dscrPct;
    checkedPcts.push(`${field}=${pct}%`);
    if (Number(pct) !== Number(measured)) {
      wrong.push(`${key}: says ${field} is ${pct}% of long-term loans, census says ${measured}%`);
    }
  }
}
check(wrong.length === 0,
  `THE ONE THAT MATTERS: no reason quotes a fill the census disagrees with${wrong.length ? ` — ${wrong.join('; ')}` : ''}`);
check(checkedPcts.length >= 8,
  `…and there are real numbers being checked (${checkedPcts.length}) — a binder that matched nothing would pass the check above by finding nothing`);

// The check above can only judge a percentage it managed to BIND to a field,
// so a number no citation owns is a number nobody checks — silently. That is
// not hypothetical: this test shipped with a case-sensitive `field` in its
// citation pattern, a reason was rewritten to open with "Field 541", and the
// 40.2% in it stopped being checked while every assertion still read green.
// Counting is what makes that impossible: an unbindable number fails the build.
check(checkedPcts.length === quotedPcts,
  `EVERY percentage quoted in a reason is bound to a field and checked (${checkedPcts.length} of ${quotedPcts})${checkedPcts.length === quotedPcts ? '' : ' — one is quoted next to no field this test can look up, so nothing is verifying it'}`);

// ── A reason may not claim silence the census disproves ────────────────────
//
// This is the half that caught the live defect. "Its six recorded values were
// withheld" and "nothing carries a zone designation" were both written about a
// field whose values the census records in full, with a count each.
console.log('\nno reason claims the census is silent about a field the census answers');

const contradicted = [];
for (const [key, entry] of entries) {
  const text = `${entry.why} ${entry.unblock}`;
  if (!SILENCE_RE.test(text)) continue;
  for (const { key: field, clause } of clausesOf(text)) {
    if (!SILENCE_RE.test(clause)) continue;
    const row = FIELDS[field];
    const values = (row && row.observedValues) || [];
    if (values.length) {
      contradicted.push(`${key}: says the census is silent about ${field}, census records ${values.length} value(s) (${values.map((v) => v.value).join(', ')})`);
    }
  }
}
check(contradicted.length === 0,
  `no silence claim is made about a field the census recorded values for${contradicted.length ? ` — ${contradicted.join('; ')}` : ''}`);

// ── The retraction is a record, not a decoration ──────────────────────────
//
// `corrected` is read HERE and nowhere else, which is the point: it is what
// lets a reason quote the claim it is retracting without a guard reading that
// quote as a live claim. So it has to be held to something, or it becomes one
// more thing that is declared and never triggered.
console.log('\na retracted claim is recorded, complete, and really gone');

const corrections = entries.filter(([, e]) => e.corrected);
check(corrections.length > 0,
  `at least one entry records a correction (${corrections.length}) — otherwise the checks below pass by finding nothing`);

for (const [key, e] of corrections) {
  const c = e.corrected;
  check(/^\d{4}-\d{2}-\d{2}$/.test(String(c.on || '')),
    `${key}: the correction says WHEN (${c.on})`);
  check(String(c.was || '').length > 20 && String(c.why || '').length > 20,
    `${key}: it says what was claimed before and why that was wrong — "was" and "why" are different sentences and the next reader needs both`);
  const live = `${e.show} ${e.why} ${e.unblock}`;
  check(!live.includes(String(c.was || '').slice(0, 60)),
    `${key}: and the retracted sentence is GONE from what a reader is shown — a claim still standing in the live text has not been retracted`);
}

// ── And the flood pair specifically, because it is the case that went wrong ─
//
// A generic rule is only as good as the case that produced it. The per-field
// silence rule above catches a claim made INSIDE a field's own clause; it can
// not judge a sentence like "nothing in 3,783 fields carries a zone
// designation", which names no field at all. These pin that one to the census
// by hand, so a well-meaning rewrite has to argue with the measurement again.
console.log('\nand the flood reasons say what was measured');

const floodZone = unsourced.unsourced('lt_properties', 'flood_zone');
const inFlood = unsourced.unsourced('lt_properties', 'in_flood_zone');
check(!!floodZone && !!inFlood, 'both flood columns are still explained rather than silently blank');
check(floodZone && !/Nothing in [\d,]+ measured fields carries a zone designation/i.test(floodZone.why),
  'the zone reason no longer says nothing in the census carries a zone designation — field 541 carries X, AE, X500, A and C');
check(inFlood && !/withheld/i.test(`${inFlood.show} ${inFlood.why} ${inFlood.unblock}`),
  "the flood-determination reason no longer says field 541's values were withheld — the census lists all six");
check(inFlood && /allowed|declared|enum|its own list/i.test(inFlood.why),
  '…and it says what the field actually is, so the next reader learns the vocabulary is DECLARED rather than guessed at');
check(!!(floodZone && floodZone.corrected) && !!(inFlood && inFlood.corrected),
  '…and both record what they used to say, so the next person can see this was measured and corrected rather than quietly reworded');

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
