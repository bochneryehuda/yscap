'use strict';
/**
 * Proves the Encompass read-only gate (scripts/check-encompass-readonly.js) still
 * catches what it claims. Runs the real gate as a subprocess: it must PASS on the
 * repo as-is, and FAIL when a temporary violation fixture is dropped into a scanned
 * folder. Every fixture is removed in a finally, so a crash never leaves one behind.
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const GATE = path.join(ROOT, 'scripts', 'check-encompass-readonly.js');

let failures = 0;
function ok(name, cond, detail) {
  if (cond) console.log(`  ok   ${name}`);
  else { failures++; console.error(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
}

// Run the gate; returns { code, out }.
function runGate() {
  try { const out = execFileSync('node', [GATE], { cwd: ROOT, encoding: 'utf8' }); return { code: 0, out }; }
  catch (e) { return { code: e.status || 1, out: (e.stdout || '') + (e.stderr || '') }; }
}

// Write a temp fixture into a scanned folder, run the gate, always clean up.
function withFixture(relPath, contents, fn) {
  const abs = path.join(ROOT, relPath);
  fs.writeFileSync(abs, contents);
  try { return fn(); } finally { try { fs.unlinkSync(abs); } catch (_) {} }
}

function main() {
  console.log('Encompass read-only gate self-test');

  // (1) The gate passes on the repo as it is (flood authorized, clients read-only).
  const base = runGate();
  ok('gate PASSES clean on the current repo', base.code === 0, base.out.split('\n').slice(-3).join(' '));

  // (2) A raw Encompass WRITE that bypasses the guarded client → gate must FAIL.
  withFixture('scripts/__enc_gate_fixture_write.js',
    "async function bad(){ return fetch('https://api.elliemae.com/encompass/v3/loans/abc',{method:'PATCH',body:'{}'}); }\nmodule.exports={bad};\n",
    () => {
      const r = runGate();
      ok('gate FAILS on a raw Encompass write (PATCH to api.elliemae.com)', r.code !== 0);
      ok('  …and names the offending fixture', /__enc_gate_fixture_write\.js/.test(r.out), r.out.slice(0, 200));
    });

  // (3) A read-only-shaped Encompass client that grows a write helper + drops the
  //     READ_ONLY sentinel → gate must FAIL.
  withFixture('scripts/__enc_gate_fixture_client.js',
    "const cfg={baseUrl:'https://api.elliemae.com'};\n" +
    "async function _fetchGuarded(u,i){return fetch(u,i);}\n" +
    "async function login(){return _fetchGuarded(cfg.baseUrl+'/oauth2/v1/token',{method:'POST'});}\n" +
    "async function apiPatch(p){return _fetchGuarded(cfg.baseUrl+'/encompass/v3/loans/x',{method:'PATCH'});}\n" +
    "module.exports={apiPatch};\n",
    () => {
      const r = runGate();
      ok('gate FAILS on an unauthorized Encompass client with a write helper', r.code !== 0);
      ok('  …and flags the missing READ_ONLY sentinel or the write helper', /READ_ONLY|write helper|apiPatch|PATCH/i.test(r.out));
    });

  // (4) After the fixtures are gone, the gate is clean again (no residue).
  const after = runGate();
  ok('gate is clean again after fixtures removed', after.code === 0);

  if (failures) { console.error(`\n${failures} check(s) failed.`); process.exit(1); }
  console.log('\nOK — the Encompass read-only gate does what it promises.');
}

main();
