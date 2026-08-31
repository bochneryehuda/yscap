'use strict';
/**
 * AD MORTGAGE (AIM Quick Pricer) — dump the live form schema for every program group.
 *
 * Writes src/longterm/admortgage/capture/schemas.json, which
 * docs/longterm/ppe-research/ADMORTGAGE-AIM-FIELD-MAP.md is generated from. Re-run this rather
 * than hand-editing that table: AD owns these option ids and may change them.
 *
 * READ-ONLY. Logs in, reads schemas, logs out. Never books, locks, or registers anything.
 * Credentials come from the environment ONLY — never commit them, never pass them on argv
 * (argv is visible in the process list).
 *
 *   AIM_EMAIL=... AIM_PASSWORD=... node scripts/aim-dump-schemas.js
 *
 * LT-only. No DB, no RTL import.
 */
const fs = require('fs');
const path = require('path');

const BASE = process.env.AIM_BASE || 'https://aim.admortgage.com';
const OUT = path.join(__dirname, '..', 'src', 'longterm', 'admortgage', 'capture', 'schemas.json');
const GROUPS = [
  [33001, 'Non-QM'], [33015, 'Non-QM Second Lien'], [33087, 'Jumbo'],
  [33154, 'Conventional'], [33192, 'Government'],
];

const jar = new Map();
function keepCookies(res) {
  for (const c of (res.headers.getSetCookie ? res.headers.getSetCookie() : [])) {
    const [kv] = c.split(';');
    const i = kv.indexOf('=');
    if (i > 0) jar.set(kv.slice(0, i).trim(), kv.slice(i + 1).trim());
  }
}

async function call(method, p, body) {
  const headers = { Accept: '*/*', Origin: BASE, Referer: `${BASE}/quick-pricer/` };
  if (jar.size) headers.Cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(BASE + p, {
    method, headers, redirect: 'manual',
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  keepCookies(res);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON body surfaces via text */ }
  return { status: res.status, text, json };
}

(async () => {
  const email = process.env.AIM_EMAIL;
  const password = process.env.AIM_PASSWORD;
  if (!email || !password) {
    console.error('Set AIM_EMAIL and AIM_PASSWORD in the environment.');
    process.exit(2);
  }

  const login = await call('POST', '/api/user/login', { email, password });
  if (login.status !== 200 || login.json?.success !== true) {
    // Never echo the body — a failed login response can carry account detail.
    console.error(`Login failed: HTTP ${login.status}`);
    process.exit(1);
  }

  const out = { capturedAt: new Date().toISOString(), base: BASE, groups: {} };
  for (const [gid, name] of GROUPS) {
    const r = await call('GET', `/api/qp/api/v1/extended/program-groups/${gid}`);
    if (r.status !== 200) { console.error(`  ${name} (${gid}): HTTP ${r.status} — skipped`); continue; }
    out.groups[gid] = { name, fields: r.json.data };
    const opts = r.json.data.reduce((n, f) => n + (f.values || []).length, 0);
    console.log(`  ${String(gid).padEnd(6)} ${name.padEnd(20)} ${String(r.json.data.length).padStart(2)} fields, ${String(opts).padStart(4)} options`);
  }

  await call('POST', '/api/user/logout', {});

  if (!Object.keys(out.groups).length) { console.error('No schemas captured.'); process.exit(1); }
  fs.writeFileSync(OUT, `${JSON.stringify(out, null, 1)}\n`);
  console.log(`\nWrote ${path.relative(path.join(__dirname, '..'), OUT)}`);
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
