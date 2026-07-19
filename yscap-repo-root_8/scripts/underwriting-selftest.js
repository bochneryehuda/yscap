'use strict';
/**
 * Underwriting self-test — run this in the Render Shell (where your keys already live)
 * to (1) confirm the reader + brain keys are entered correctly, and (2) optionally run a
 * REAL document all the way through and print the findings.
 *
 *   node scripts/underwriting-selftest.js
 *       → checks both keys work, prints OK / FAILED (with the reason).
 *
 *   node scripts/underwriting-selftest.js <path-to-document> <docType>
 *       → reads + understands + checks one real document and prints the extracted
 *         fields and the findings. docType = government_id | purchase_contract.
 *         (Compares against a blank file, so you'll see what it EXTRACTED and any
 *          "unreadable/never-guess" routing — the real file-comparison happens in the app.)
 *
 * Nothing here is exposed outside your own Render environment. Sensitive ID/account
 * numbers are shown masked, same as they're stored.
 */
const fs = require('fs');
const path = require('path');
const cfg = require('../src/config');
const docint = require('../src/lib/ai/docint');
const openai = require('../src/lib/ai/azure-openai');
const { analyzeDocument } = require('../src/lib/underwriting/engine');
const { maskFields } = require('../src/lib/underwriting/store');

function line(label, ok, reason) {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${ok ? '' : `  —  ${reason || 'failed'}`}`);
}

async function checkKeys() {
  console.log('\n1) Are the keys entered correctly?\n');
  console.log(`  Reader endpoint:   ${cfg.docint.endpoint || '(not set)'}`);
  console.log(`  Brain endpoint:    ${cfg.azureOpenai.endpoint || '(not set)'}`);
  console.log(`  Brain deployment:  ${cfg.azureOpenai.deployment || '(not set)'}\n`);

  const r = await docint.ping();
  line('Reader (Azure Document Intelligence) reachable + key valid', r.ok, r.reason);
  const o = await openai.ping();
  line('Brain (Azure OpenAI GPT-5) reachable + key + deployment valid', o.ok, o.reason);
  return r.ok && o.ok;
}

function guessMime(p) {
  const e = path.extname(p).toLowerCase();
  return ({ '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.tif': 'image/tiff', '.tiff': 'image/tiff', '.bmp': 'image/bmp' })[e] || 'application/pdf';
}

async function runDocument(file, docType) {
  console.log(`\n2) Running a real document through the pipeline\n     file: ${file}\n     type: ${docType}\n`);
  const buffer = fs.readFileSync(file);
  const res = await analyzeDocument({ docType, buffer, mimeType: guessMime(file), subject: {}, today: new Date().toISOString().slice(0, 10) });
  if (!res.ok && res.reason && !res.extraction) {
    line('analysis', false, res.reason);
    return;
  }
  console.log('  Extracted fields (sensitive values masked):');
  console.log('  ' + JSON.stringify(maskFields((res.extraction && res.extraction.fields) || {}), null, 2).replace(/\n/g, '\n  '));
  console.log(`\n  Findings (${res.findings.length}):`);
  if (!res.findings.length) console.log('    (none — nothing to flag against a blank test file)');
  for (const f of res.findings) {
    console.log(`    • [${f.severity}] ${f.code} — ${f.title}`);
  }
  console.log('\n  Note: this compares against a BLANK file, so mismatch findings only appear');
  console.log('  once the app compares to a real loan file. This proves read→understand→check works.');
}

(async () => {
  console.log('=== PILOT underwriting self-test ===');
  const keysOk = await checkKeys();
  const file = process.argv[2], docType = process.argv[3];
  if (file && docType) {
    if (!keysOk) { console.log('\nKeys are not all valid yet — fix the ✗ above before testing a document.\n'); process.exit(1); }
    await runDocument(file, docType);
  } else if (!file) {
    console.log('\nTip: to test a real document too, run:');
    console.log('  node scripts/underwriting-selftest.js /path/to/document.pdf government_id\n');
  }
  process.exit(keysOk ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
