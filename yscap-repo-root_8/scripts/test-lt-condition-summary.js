'use strict';
/**
 * THE OWNER'S CONDITION WRITE-UP IS GENERATED, AND THIS PROVES IT IS CURRENT.
 *
 * The owner asked for a plain-language summary of every condition — what it is, who
 * sees it (internal, or internal AND external), and what kind of thing it is. A
 * hand-written summary of 28 conditions is a document that is true on the day it is
 * written and quietly wrong a month later, which is worse than none: somebody reads
 * it, believes the borrower never sees a condition, and is wrong.
 *
 * So the write-up is RENDERED FROM `library.js` — the one place the conditions are
 * defined — and this suite asserts the file on disk is exactly what the library
 * renders today. Change a condition's audience and forget the doc, and CI says so.
 *
 * To regenerate after an intentional change:
 *     node scripts/test-lt-condition-summary.js --write
 *
 * WHY THIS FILE IS NAMED test-lt-*: it requires src/longterm/, and the separation
 * gate's `isLtTest` (/^scripts\/test-lt-[\w-]*\.(js|mjs|cjs)$/) is the only name
 * under which RTL-side code may do that. It is also why the require above is an
 * ordinary relative one rather than a computed path: a dynamic require is invisible
 * to the gate's static scan, so using one would slip a crossing past the very check
 * that exists to catch it.
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const L = require('../src/longterm/conditions-center/library');


const KIND_WORDS = {
  document: 'Upload — somebody sends us a file and a person accepts or rejects it.',
  form: 'Form — answered inside PILOT, no file needed.',
  order: 'Order — PILOT drafts an email to an outside company; a person reads it before it sends.',
  esign: 'Signature — goes out for signing and comes back signed.',
};
const AUD = {
  internal: ['Internal only', 'Only staff see this. The borrower is never asked and never sees it on their portal.'],
  both: ['Internal + external', 'Staff see it, and the borrower sees it on their portal in their own words and can answer it themselves.'],
  external: ['External', 'The borrower sees and answers it.'],
};
const BUCKETS = [
  ['prior_to_submission', 'Prior to submittal', 'Everything the file needs before it goes to underwriting.'],
  ['prior_to_ctc', 'Prior to clear to close', 'What has to be true before the file can be cleared to close.'],
  ['prior_to_docs', 'Prior to docs', ''],
  ['prior_to_funding', 'Prior to funding', ''],
  ['prior_to_purchase', 'Prior to purchase', ''],
];

function build() {
const rows = L.library();
const out = [];
out.push('# Every Long-Term condition, in plain language');
out.push('');
out.push('Generated from `src/longterm/conditions-center/library.js` — the one place the');
out.push('conditions are defined — so this page and the system cannot drift apart.');
out.push('Regenerate after any change to that file.');
out.push('');
out.push('**Who sees it.** *Internal only* means staff and nobody else. *Internal + external*');
out.push('means the borrower also sees it on their portal, written in their own words, and can');
out.push('answer it themselves.');
out.push('');
out.push('**What kind it is.** *Upload* wants a file. *Form* is answered inside PILOT with no');
out.push('file at all. *Order* sends an email out to a company and waits for what comes back.');
out.push('*Signature* goes out to be signed.');
out.push('');
const tot = rows.length;
const nInt = rows.filter(r => r.audience === 'internal').length;
out.push(`**${tot} conditions in total** — ${nInt} internal only, ${tot - nInt} that the borrower sees too.`);
out.push('');

for (const [key, title, blurb] of BUCKETS) {
  const list = rows.filter(r => r.bucketKey === key);
  if (!list.length) continue;
  out.push(`---`);
  out.push('');
  out.push(`## ${title}`);
  if (blurb) { out.push(''); out.push(blurb); }
  out.push('');
  out.push(`${list.length} conditions.`);
  out.push('');
  for (const c of list) {
    const [audShort] = AUD[c.audience] || ['—', ''];
    out.push(`### ${c.label}`);
    out.push('');
    out.push(`*${audShort} · ${(KIND_WORDS[c.kind] || c.kind).split(' —')[0]}*`);
    out.push('');
    if (c.hint) out.push(`**What it is.** ${c.hint}`);
    if (c.audience === 'both' && c.borrowerHint) {
      out.push('');
      out.push(`**What the borrower is asked.** “${c.borrowerHint}”`);
    }
    const bits = [];
    if (c.autoApply === 'always') bits.push('appears on every file');
    else if (c.autoApply === 'rules') bits.push('appears only when the file calls for it');
    if ((c.slots || []).length) {
      bits.push(`${c.slots.length} named slot${c.slots.length === 1 ? '' : 's'} (${c.slots.map(s => s.label || s.key).join(', ')})`);
    }
    if (c.config && c.config.orderType) bits.push(`sends the ${c.config.orderType} order`);
    if (c.config && c.config.savesToBorrowerProfile) bits.push('the answer is saved to the shared borrower profile, so the next loan starts from it');
    if (bits.length) { out.push(''); out.push(`**How it behaves.** ${bits.join('; ')}.`); }
    out.push('');
    out.push(`<sub>\`${c.code}\`</sub>`);
    out.push('');
  }
}
return out.join('\n');
}


const DOC = path.join(__dirname, '..', 'docs', 'longterm', 'CONDITIONS-IN-PLAIN-LANGUAGE.md');
const rendered = build();

if (process.argv.includes('--write')) {
  fs.writeFileSync(DOC, rendered);
  console.log('wrote ' + path.relative(path.join(__dirname, '..'), DOC));
  process.exit(0);
}

let n = 0;
const ok = (cond, what) => { assert.ok(cond, what); n++; };

ok(fs.existsSync(DOC), 'the write-up exists on disk');
const onDisk = fs.readFileSync(DOC, 'utf8');

// The whole point: byte-for-byte, or the doc is stale. The message names the fix so
// nobody has to go hunting for how to regenerate it.
if (onDisk !== rendered) {
  const a = onDisk.split('\n');
  const b = rendered.split('\n');
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  assert.fail('docs/longterm/CONDITIONS-IN-PLAIN-LANGUAGE.md is STALE — the condition library has '
    + 'changed since it was written. Regenerate with: node scripts/test-lt-condition-summary.js --write'
    + '\n  first difference at line ' + (i + 1)
    + '\n  on disk : ' + JSON.stringify(a[i] === undefined ? null : a[i])
    + '\n  library : ' + JSON.stringify(b[i] === undefined ? null : b[i]));
}
n++;
console.log('  ok - the write-up matches the condition library exactly');

/* And a few assertions about the CONTENT, so a render that silently produced an empty
   or audience-blind page cannot pass the byte-comparison above by matching an equally
   empty file on disk. */
const rows = L.library();
ok(rows.length >= 20, `the library has a real number of conditions (${rows.length})`);
ok(rows.some((r) => r.audience === 'internal'), 'some conditions are internal only');
ok(rows.some((r) => r.audience === 'both'), 'some conditions are internal AND external');
for (const r of rows) {
  ok(onDisk.includes(r.code), `the write-up names ${r.code}`);
  ok(onDisk.includes(r.label), `the write-up carries ${r.code}'s label verbatim`);
}
// Every borrower-facing condition must show the words the BORROWER reads, not only
// the staff wording — that difference is the whole of "internal vs internal+external".
for (const r of rows.filter((x) => x.audience === 'both' && x.borrowerHint)) {
  ok(onDisk.includes(r.borrowerHint), `the write-up quotes what the borrower reads for ${r.code}`);
}

console.log(`\ntest-lt-condition-summary: ${n} checks passed`);
