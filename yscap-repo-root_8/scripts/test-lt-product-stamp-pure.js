'use strict';
/**
 * LT test — the product stamp.
 *
 * CLAUDE.md §7: a screen that can show both books must carry "a visible product stamp
 * on every row and every file header so anyone can tell at a glance which product a
 * file is", and the merge happens only in the read/view layer — "each product answers
 * for its own rows, the edge tags and concatenates".
 *
 * THE PROPERTY THIS SUITE EXISTS FOR: the stamp is a property of the ROW, never of
 * the screen. A long-term screen printing "Long-term" because it is the long-term
 * screen looks identical today and is wrong the moment one pipeline lists both books
 * — every row would carry the same word, and the exact confusion the stamp exists to
 * prevent is what it would cause. So the source guard below fails if the front end
 * hard-codes a label instead of rendering what the row carries.
 */

const fs = require('fs');
const path = require('path');
const product = require('../src/longterm/product');

let failures = 0;
const check = (cond, msg) => {
  if (cond) console.log(`  ok   ${msg}`);
  else { failures += 1; console.error(`  FAIL ${msg}`); }
};

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

// ── The tag ─────────────────────────────────────────────────────────────────
console.log('the tag this product puts on its own rows');

const s = product.stamp();
check(s.product === 'long_term' && s.productLabel === 'Long-term',
  'a long-term row is tagged with a machine key and the word a person reads');
check(product.PRODUCT_KEY === 'long_term' && product.PRODUCT_LABEL === 'Long-term',
  'and both are exported, so nothing downstream retypes the string');

const row = { id: 'x', loan_number: 'YSCAP1' };
const tagged = product.tagRow(row);
check(tagged.product === 'long_term' && tagged.loan_number === 'YSCAP1',
  'tagging a row keeps everything already on it');
check(!('product' in row),
  'and never mutates what it was handed — a caller reusing the row must not find it changed');

const list = product.tagRows([{ id: 'a' }, { id: 'b' }]);
check(list.length === 2 && list.every((r) => r.product === 'long_term'),
  'THE ONE THAT MATTERS: EVERY row is tagged, not just the first — the rule is every row');
check(product.tagRows(null) === null && product.tagRow(null) === null,
  'a non-list and a non-row pass through untouched rather than being coerced into something');

// ── It tags only its own product ────────────────────────────────────────────
console.log('\nit speaks for the long-term book and no other');

const code = strip(read('src/longterm/product.js'));
check(!/\brtl\b/i.test(code),
  'the long-term tagger names no RTL product — a shared tagger would be a shared module between two products that never share one');
check(!/require\(/.test(code), 'it is pure: no database, no config, nothing to fail');

// ── The rows and the header really carry it ─────────────────────────────────
console.log('\nevery row and every file header carries it');

const pipeline = strip(read('src/longterm/pipeline.js'));
check(/product\.tagRows\(rows\)/.test(pipeline),
  'the pipeline tags EVERY row it returns');
const route = strip(read('src/longterm/routes/pipeline.js'));
check(/product\.tagRow\(rows\[0\]\)/.test(route) && /\.\.\.product\.stamp\(\)/.test(route),
  'and the single-file route stamps the FILE HEADER as well as the loan row');

// ── The trap ────────────────────────────────────────────────────────────────
console.log('\nthe stamp comes from the row, never from the screen');

const stampSrc = strip(read('app-v2/src/longterm/ProductStamp.jsx'));
check(!/['"`]Long-term['"`]/.test(stampSrc),
  'THE ONE THAT MATTERS: the stamp component does NOT hard-code "Long-term" — on a combined pipeline a screen-derived label puts the same word on every row and causes the exact confusion the stamp exists to prevent');
check(/if \(!product \|\| !label\) return null/.test(stampSrc),
  'an UNTAGGED row renders no stamp at all — an honest blank beats a confident wrong label');

for (const f of ['app-v2/src/longterm/LtPipeline.jsx', 'app-v2/src/longterm/LtLoan.jsx']) {
  const src = strip(read(f));
  check(/<ProductStamp/.test(src), `${path.basename(f)} renders the stamp`);
  check(/label=\{[a-zA-Z.]*[Pp]roductLabel\}/.test(src),
    `${path.basename(f)} passes the label FROM THE DATA, not a literal`);
}

// The file header's stamp must not hang off another request succeeding. The scope
// banner in LtLayout is gated on `me` loading; if the header's stamp were too, a
// failed lookup would silently remove the one marker saying which book this is.
const loanSrc = strip(read('app-v2/src/longterm/LtLoan.jsx'));
check(/productLabel \? \(/.test(loanSrc) && !/me && me\.ltRole/.test(loanSrc),
  'the file header stamp depends only on the loan it is drawn for — never on a separate lookup that can fail');

console.log(`\n${failures ? `${failures} FAILED` : 'all passed'}`);
process.exit(failures ? 1 : 0);
