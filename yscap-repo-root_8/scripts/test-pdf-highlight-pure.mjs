/**
 * Highlight-the-conflicting-text matcher (owner-directed 2026-07-22). Pure —
 * finds which PDF.js text items cover a value we want to highlight, trying a few
 * forms of the value so a money figure matches regardless of $/comma formatting.
 */
import { highlightCandidates, findHighlightItems } from '../app-v2/src/lib/pdfHighlight.js';
import assert from 'node:assert';

let failures = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };

// candidate forms for a money value
{
  const c = highlightCandidates('$425,000');
  ok(c.includes('$425,000') && c.includes('425,000') && c.includes('425000'), 'candidates: money value yields $-form, comma-form, and digits');
  ok(highlightCandidates('').length === 0 && highlightCandidates(null).length === 0, 'candidates: empty/null → none');
}

// a value that sits inside one item
{
  const items = [{ str: 'Purchase Price: ' }, { str: '$425,000' }];
  ok(JSON.stringify(findHighlightItems(items, '$425,000')) === JSON.stringify([1]), 'match: value inside one item → that item');
}

// a value SPLIT across items (425 / , / 000) — the comma-form matches all three
{
  const items = [{ str: '425' }, { str: ',' }, { str: '000' }];
  ok(JSON.stringify(findHighlightItems(items, '$425,000')) === JSON.stringify([0, 1, 2]), 'match: value split across items → all covering items');
}

// a differently-formatted PDF number ("425,000.00") still matches "$425,000"
{
  const items = [{ str: 'Amount 425,000.00 total' }];
  ok(JSON.stringify(findHighlightItems(items, '$425,000')) === JSON.stringify([0]), 'match: comma-form found inside a longer run');
}

// a name in one item
{
  const items = [{ str: 'Seller of record: John Smith' }];
  ok(JSON.stringify(findHighlightItems(items, 'John Smith')) === JSON.stringify([0]), 'match: a name found in one item');
}

// no match → empty (the viewer just opens to the page, no box)
{
  const items = [{ str: 'nothing relevant here' }];
  ok(findHighlightItems(items, '$999,999').length === 0, 'no-match: returns empty');
  ok(findHighlightItems([], '$425,000').length === 0 && findHighlightItems(null, 'x').length === 0, 'no-match: empty/null items → empty');
}

assert.strictEqual(failures, 0, `${failures} assertion(s) failed`);
console.log(failures ? `\n${failures} failed` : '\nALL pdf-highlight assertions passed');
process.exit(failures ? 1 : 0);
