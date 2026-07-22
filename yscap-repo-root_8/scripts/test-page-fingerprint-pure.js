'use strict';
/**
 * R5.7 — pure tests for page fingerprinting (perceptual + text hash).
 * Proves it (1) hashes a page's text to a STABLE key that ignores whitespace/
 * punctuation/accents, (2) detects an EXACT duplicate, (3) detects a NEAR
 * duplicate (a footer/date/OCR-flip difference) via simhash Hamming distance,
 * (4) uses a supplied perceptual IMAGE hash to pair visually-identical pages OCR
 * can't tell apart (two blank separators), (5) never calls two EMPTY pages text
 * duplicates, (6) clusters duplicate pages, and (7) never throws on junk.
 */
const assert = require('assert');
const fp = require('../src/lib/underwriting/page-fingerprint');

let passed = 0;
const ok = (n) => { console.log(`  ok  ${n}`); passed++; };

// --- text hash is stable across whitespace / punctuation / accents / case ---
const h1 = fp.textHash('Bank of America — Statement, Account #1234');
const h2 = fp.textHash('bank   of  america  statement  account  1234');
const h3 = fp.textHash('BANK OF AMERICA\nStatement\tAccount 1234');
assert.strictEqual(h1, h2, 'punctuation + spacing + case are normalized away');
assert.strictEqual(h1, h3, 'newlines/tabs normalize the same');
assert.notStrictEqual(h1, fp.textHash('Wells Fargo Statement Account 9999'), 'different text → different hash');
ok('text hash is stable across whitespace/punctuation/case and distinguishes different pages');

// --- exact duplicate detection ---
let c = fp.compare(
  { text: 'Chase checking statement January 2026 balance $12,500.00 page 1 of 3' },
  { text: 'CHASE  checking   statement, January 2026. Balance: $12,500.00 (page 1 of 3)' },
);
assert.strictEqual(c.relation, 'identical', 'same normalized text is an exact duplicate');
assert.strictEqual(c.textIdentical, true);
assert.strictEqual(c.similarity, 1);
ok('two pages with the same text (different punctuation) are detected as an exact duplicate');

// --- near-duplicate: SAME page, only a small footer/watermark stamp added ---
const bodyA = 'wells fargo business checking account 4821 statement period march 1 2026 through march 31 2026 beginning balance 84210 dollars ending balance 91355 dollars deposits 21000 withdrawals 13855 account holder acme holdings llc';
const bodyB = bodyA + ' page 1 of 3 confidential'; // a footer/watermark stamp on the same page
c = fp.compare({ text: bodyA }, { text: bodyB });
assert.strictEqual(c.relation, 'near_duplicate', 'a footer/watermark difference is a near-duplicate, not distinct');
assert.strictEqual(c.textIdentical, false, 'not an EXACT duplicate');
assert.ok(c.textHamming >= 1 && c.textHamming <= fp.NEAR_TEXT_HAMMING, `hamming ${c.textHamming} within near threshold`);
assert.ok(c.similarity > 0.9, 'similarity is high');
ok('a page differing only by a small footer/watermark stamp is a NEAR duplicate (simhash Hamming under threshold)');

// --- CRITICAL: two DIFFERENT months of the same statement template are DISTINCT ---
// (they share a template but carry different balances/dates — collapsing them would
//  double-count or drop a real account in liquidity math; the threshold must reject them)
const march = bodyA;
const april = 'wells fargo business checking account 4821 statement period april 1 2026 through april 30 2026 beginning balance 91355 dollars ending balance 78200 dollars deposits 9000 withdrawals 22155 account holder acme holdings llc';
c = fp.compare({ text: march }, { text: april });
assert.strictEqual(c.relation, 'distinct', 'two different months of the same template are NOT duplicates');
assert.ok(c.textHamming > fp.NEAR_TEXT_HAMMING, `different-month hamming ${c.textHamming} is safely above the near threshold`);
ok('two different months of the same statement template are reported DISTINCT (never collapsed)');

// --- CRITICAL (audit HIGH): the amount veto keeps two different months DISTINCT
//     even when their simhash IS near — the liquidity double-count guard. ---
// On a boilerplate-heavy statement summary page two different months can drift into
// simhash range (a real risk the auditor measured at Hamming 6). We force that
// "simhash is near" condition here with a wide nearTextHamming so the test targets
// the VETO directly (independent of any fragile boilerplate distance): differing
// balances must still veto the near-duplicate call.
const marHeavy = 'bank of america member fdic account 4821 statement period march beginning balance 84210 ending balance 91355 total deposits 21000 total withdrawals 13855 acme holdings llc';
const aprHeavy = 'bank of america member fdic account 4821 statement period april beginning balance 91355 ending balance 78200 total deposits 9000 total withdrawals 22155 acme holdings llc';
c = fp.compare({ text: marHeavy }, { text: aprHeavy }, { nearTextHamming: 64 }); // force "simhash near"
assert.strictEqual(c.relation, 'distinct', 'different dollar amounts VETO a near-duplicate call even when simhash is (forced) near');
ok('AUDIT HIGH: different dollar amounts VETO a near-duplicate even when the simhash is within threshold (liquidity double-count guard)');

// but the SAME page with a footer stamp (identical amounts) is NOT vetoed — when
// simhash is near and the amounts match, it stays a near-duplicate.
c = fp.compare({ text: marHeavy }, { text: marHeavy + ' page 1 of 3 confidential printed 2026' }, { nearTextHamming: 64 });
assert.strictEqual(c.relation, 'near_duplicate', 'identical amounts + a footer stamp is still a near-duplicate (the veto does not over-fire)');
ok('the amount veto does not over-fire: identical amounts keep a near simhash a near-duplicate');

// --- genuinely different pages are distinct ---
c = fp.compare(
  { text: 'appraisal report subject property 12 oak street market value 450000 comparable sales approach' },
  { text: 'promissory note borrower acme llc principal 315000 interest rate 11.5 percent maturity date' },
);
assert.strictEqual(c.relation, 'distinct', 'an appraisal and a note are not duplicates');
assert.ok(c.textHamming > fp.NEAR_TEXT_HAMMING, 'their simhashes are far apart');
ok('two genuinely different documents are reported distinct');

// --- perceptual image hash pairs visually-identical pages OCR cannot distinguish ---
// two blank separator pages: no usable text, but the renderer gave the same aHash
c = fp.compare(
  { text: '   ', imageHash: 'ffffffff00000000' },
  { text: '', imageHash: 'ffffffff00000000' },
);
assert.strictEqual(c.relation, 'near_duplicate', 'identical image hashes pair two blank pages');
assert.strictEqual(c.imageHamming, 0);
// a near (not exact) image hash still pairs (a few flipped pixels)
c = fp.compare(
  { text: '', imageHash: 'ffffffff00000000' },
  { text: '', imageHash: 'ffffffff00000003' }, // 2 bits differ
);
assert.strictEqual(c.relation, 'near_duplicate', 'a 2-bit image-hash difference is still a visual near-duplicate');
assert.strictEqual(c.imageHamming, 2);
ok('a perceptual image hash pairs visually-identical/near-identical pages OCR text cannot distinguish');

// --- two EMPTY pages are NOT text duplicates without a matching image hash ---
c = fp.compare({ text: '' }, { text: '  \n ' });
assert.strictEqual(c.relation, 'distinct', 'two blank pages do not "match" on empty text alone');
assert.strictEqual(c.textIdentical, false, 'empty text is never treated as an identical match');
assert.strictEqual(c.textHamming, null, 'empty pages contribute no text hamming');
ok('two empty pages are never called duplicates on empty-text alone (only a matching image hash pairs them)');

// --- hamming refuses to compare mismatched-length / non-hex hashes ---
assert.strictEqual(fp.hamming('ff00', 'ff0000'), null, 'different lengths → null (never coerce)');
assert.strictEqual(fp.hamming('zzzz', 'ff00'), null, 'non-hex → null');
assert.strictEqual(fp.hamming('ff00', 'ff01'), 1, 'one differing bit');
ok('hamming distance refuses mismatched-length / non-hex hashes instead of coercing');

// --- fingerprintPage carries page number + marks empties + validates image hash ---
let f = fp.fingerprintPage({ text: 'the quick brown fox jumps over the lazy dog underwriting', page_number: 7, imageHash: 'ABCD1234' });
assert.strictEqual(f.pageNumber, 7, 'page number carried');
assert.strictEqual(f.empty, false);
assert.strictEqual(f.imageHash, 'abcd1234', 'a valid hex image hash is lowercased + carried');
f = fp.fingerprintPage({ text: 'hi', imageHash: 'not-hex!' });
assert.strictEqual(f.empty, true, 'too-short text is marked empty');
assert.strictEqual(f.imageHash, null, 'a non-hex image hash is dropped, not carried as garbage');
ok('fingerprintPage carries the page number, marks empty pages, and validates the image hash');

// --- groupDuplicates clusters duplicate pages across a packet ---
const packet = [
  { text: 'chase statement january 2026 balance 12500 page one', page_number: 1 },
  { text: 'appraisal subject 12 oak street market value 450000 comparable sales approach', page_number: 2 },
  { text: 'CHASE Statement, January 2026 — balance 12500 (page one)', page_number: 3 }, // dup of 1 (exact after norm)
  { text: 'promissory note principal 315000 rate 11.5 maturity', page_number: 4 },
  { text: 'appraisal subject 12 oak street market value 450000 comparable sales approach final', page_number: 5 }, // near-dup of 2
];
const g = fp.groupDuplicates(packet);
assert.strictEqual(g.clusters.length, 2, 'two duplicate clusters found');
const chaseCluster = g.clusters.find((cl) => cl.pages.includes(1));
assert.deepStrictEqual(chaseCluster.pages.slice().sort((a, b) => a - b), [1, 3], 'pages 1 & 3 cluster');
assert.strictEqual(chaseCluster.exact, true, 'the chase pages are an EXACT-text cluster');
const apprCluster = g.clusters.find((cl) => cl.pages.includes(2));
assert.deepStrictEqual(apprCluster.pages.slice().sort((a, b) => a - b), [2, 5], 'pages 2 & 5 cluster (near)');
assert.strictEqual(apprCluster.exact, false, 'the appraisal cluster is a NEAR (not exact) cluster');
assert.strictEqual(g.duplicatePageCount, 4, 'four pages belong to a cluster');
assert.strictEqual(g.uniquePageCount, 3, 'note(4) + one representative of each cluster = 3 unique');
ok('groupDuplicates clusters exact and near-duplicate pages and counts unique vs duplicate pages');

// --- AUDIT MEDIUM: a cluster bridged by a NEAR link is not flagged `exact` ---
// two exact pairs (1==2, 4==5) bridged by a near link (2~4) form one cluster, but
// pages 1 and 5 are NOT identical — the cluster must NOT claim exact:true.
const bBody = 'chase bank statement business checking account number ending 5555 statement period january 2026 beginning balance 40000 ending balance 40000 no activity this period thank you for banking with chase page one of one';
const bridged = [
  { text: bBody, page_number: 1 },
  { text: bBody.toUpperCase().replace('5555', '5555,'), page_number: 2 }, // == 1 after normalization
  { text: bBody + ' reference code xyz', page_number: 4 }, // near 1/2 (Hamming 6), not exact, SAME amounts
  { text: bBody + ' reference code xyz', page_number: 5 }, // == 4
];
let gg = fp.groupDuplicates(bridged);
const bigCluster = gg.clusters.find((cl) => cl.pages.includes(1));
assert.ok(bigCluster && bigCluster.size >= 3, 'the near link bridges the two exact pairs into one cluster');
assert.strictEqual(bigCluster.exact, false, 'a cluster containing non-identical members is NOT flagged exact');
// a cluster of purely identical pages IS exact
gg = fp.groupDuplicates([
  { text: 'wells fargo statement balance 12000 page 1', page_number: 1 },
  { text: 'WELLS FARGO Statement — balance 12000 (page 1)', page_number: 2 },
]);
assert.strictEqual(gg.clusters[0].exact, true, 'a cluster of byte-identical (normalized) pages IS exact');
ok('AUDIT MEDIUM: exact is true only when every cluster member is identical, never when a near link bridged two exact pairs');

// --- AUDIT LOW: a text value whose toString throws never breaks the never-throws contract ---
const evil = { toString() { throw new Error('boom'); } };
assert.doesNotThrow(() => fp.fingerprintPage({ text: evil }), 'a throwing toString must not escape fingerprintPage');
assert.doesNotThrow(() => fp.textHash(evil));
assert.doesNotThrow(() => fp.simHash(evil));
assert.doesNotThrow(() => fp.compare({ text: evil }, { text: 'x' }));
assert.strictEqual(fp.fingerprintPage({ text: evil }).empty, true, 'an unstringifiable text is treated as empty, not a crash');
ok('AUDIT LOW: a text value whose toString throws is handled safely (never-throws contract holds)');

// --- simhash of empty / whitespace is all zeros; a real page is not ---
assert.strictEqual(fp.simHash(''), '0000000000000000');
assert.strictEqual(fp.simHash('   .,;  '), '0000000000000000', 'normalizes to nothing → zero simhash');
assert.notStrictEqual(fp.simHash('a real sentence with several distinct words here'), '0000000000000000');
assert.strictEqual(fp.simHash('same text'), fp.simHash('SAME    text!'), 'simhash is deterministic + normalized');
ok('simhash is deterministic, zero for empty text, non-zero for real text');

// --- empty / null / junk input is safe ---
assert.doesNotThrow(() => fp.fingerprintPage(null));
assert.doesNotThrow(() => fp.fingerprintPage(undefined));
assert.doesNotThrow(() => fp.compare(null, null));
assert.strictEqual(fp.compare(null, null).relation, 'distinct', 'two null pages are distinct, not a crash');
assert.doesNotThrow(() => fp.groupDuplicates(null));
assert.deepStrictEqual(fp.groupDuplicates(null).clusters, []);
assert.doesNotThrow(() => fp.textHash(null));
assert.doesNotThrow(() => fp.simHash(null));
assert.strictEqual(fp.fingerprintPage({ text: 1234567890123 }).empty, false, 'a numeric text value is coerced, not a crash');
ok('empty / null / junk input is safe (never throws)');

console.log(`\nR5.7 page-fingerprint pure — ${passed} checks passed`);
