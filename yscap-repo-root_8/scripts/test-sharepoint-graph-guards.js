/* Fault-injection tests for the SharePoint GRAPH CLIENT guards (src/lib/sharepoint.js).
 *
 * These are the safety-critical branches — "never overwrite human content",
 * "verify every upload", the ONE sanctioned delete behind seven guards, and the
 * one legal move — that previously had NO direct coverage (the e2e test stubs
 * sharepoint.uploadNew out entirely, so uploadNew's integrity check and the
 * delete/move guards never actually ran under test). This suite drives the REAL
 * functions with a stubbed global fetch (a fake Graph), injecting the exact
 * failures each guard exists to stop, and asserts the guard holds.
 *
 * No DB / no network. Run: node scripts/test-sharepoint-graph-guards.js
 * (Industry-standard fault injection: WireMock/Toxiproxy-style programmed Graph
 *  failures — 4xx/5xx, size drift, eTag/parent mismatch — proving the guards.)
 */
process.env.MS_TENANT_ID = process.env.MS_TENANT_ID || 't';
process.env.MS_CLIENT_ID = process.env.MS_CLIENT_ID || 'c';
process.env.MS_CLIENT_SECRET = process.env.MS_CLIENT_SECRET || 's';

const sp = require('../src/lib/sharepoint');

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) pass++; else { fail++; console.log(`FAIL ${name}`); } };
async function throws(name, fn, matchRe) {
  try { await fn(); fail++; console.log(`FAIL ${name} (expected throw, got none)`); }
  catch (e) { if (!matchRe || matchRe.test(e.message)) pass++; else { fail++; console.log(`FAIL ${name} (wrong error: ${e.message})`); } }
}

// ── fake Graph over global fetch ────────────────────────────────────────────
function mkResp(status, body, headers = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body || {});
  const h = {}; for (const k of Object.keys(headers)) h[k.toLowerCase()] = String(headers[k]);
  return { status, ok: status >= 200 && status < 300, headers: { get: (k) => h[String(k).toLowerCase()] ?? null },
    text: async () => text, json: async () => (text ? JSON.parse(text) : {}) };
}
let route = null;             // per-test: (url, opts) => mkResp(...)
const calls = [];             // every non-token request
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.includes('login.microsoftonline.com')) return mkResp(200, { access_token: 'faketoken', expires_in: 3600, token_type: 'Bearer' });
  calls.push({ url: u, method: (opts.method || 'GET').toUpperCase(), headers: opts.headers || {}, body: opts.body });
  if (!route) throw new Error(`no route set for ${u}`);
  return route(u, opts);
};
const reset = (fn) => { route = fn; calls.length = 0; };
const has = (id) => (u) => u.includes(`/items/${id}`);

(async () => {
  // ══ uploadNew: conflictBehavior + integrity verification ═══════════════════
  const buf = Buffer.from('hello world');   // 11 bytes, not an Office format

  // 1. happy small upload → returns item; and NEVER uses conflictBehavior=replace
  reset((u, o) => (o.method === 'PUT' ? mkResp(201, { id: 'item1', size: buf.length }) : mkResp(500, 'unexpected')));
  const up = await sp.uploadNew('d', 'p', 'deed.pdf', buf, 'application/pdf');
  ok('uploadNew small happy path returns the committed item', up.item && up.item.id === 'item1');
  ok('uploadNew requests conflictBehavior=fail (never overwrites)', calls.some((c) => c.url.includes('conflictBehavior=fail')));
  ok('uploadNew NEVER requests conflictBehavior=replace', !calls.some((c) => /conflictBehavior=replace/i.test(c.url)));

  // 2. size mismatch on a non-Office file → transit corruption, throws
  reset((u, o) => (o.method === 'PUT' ? mkResp(201, { id: 'item2', size: buf.length + 5 }) : mkResp(500)));
  await throws('uploadNew rejects a size-mismatched (transit-corrupted) upload',
    () => sp.uploadNew('d', 'p', 'deed.pdf', buf, 'application/pdf'), /integrity check failed/i);

  // 3. Office format size drift → property promotion, accepted (warn-only)
  reset((u, o) => (o.method === 'PUT' ? mkResp(201, { id: 'item3', size: buf.length + 5 }) : mkResp(500)));
  const office = await sp.uploadNew('d', 'p', 'budget.xlsx', buf, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  ok('uploadNew ACCEPTS an Office-format size drift (property promotion, not corruption)', office.item && office.item.id === 'item3');

  // 4. missing id/size on the committed item → unverifiable → throws
  reset((u, o) => (o.method === 'PUT' ? mkResp(201, {}) : mkResp(500)));
  await throws('uploadNew rejects an unverifiable (missing id/size) result',
    () => sp.uploadNew('d', 'p', 'deed.pdf', buf, 'application/pdf'), /missing id\/size/i);

  // 5. name conflict (409) → reported as {conflict:true}, never overwrites
  reset((u, o) => (o.method === 'PUT' ? mkResp(409, { error: { code: 'nameAlreadyExists', message: 'exists' } }) : mkResp(500)));
  const conf = await sp.uploadNew('d', 'p', 'deed.pdf', buf, 'application/pdf');
  ok('uploadNew on a 409 name conflict returns {conflict:true} (never clobbers)', conf.conflict === true && !conf.item);

  // 6. large file (>4MB) uses a resumable upload SESSION, not a simple PUT
  const big = Buffer.alloc(4 * 1024 * 1024 + 1024, 7);
  reset((u, o) => {
    if (u.includes('createUploadSession')) return mkResp(200, { uploadUrl: 'https://up.example/session/abc' });
    if (u.includes('up.example/session')) return mkResp(201, { id: 'bigitem', size: big.length }); // single 5MB chunk
    return mkResp(500, 'unexpected');
  });
  const bigUp = await sp.uploadNew('d', 'p', 'appraisal.pdf', big, 'application/pdf');
  ok('uploadNew uses createUploadSession for a >4MB file', calls.some((c) => c.url.includes('createUploadSession')));
  ok('uploadNew large-file happy path returns the committed item', bigUp.item && bigUp.item.id === 'bigitem');

  // ══ moveOwnItem: the one legal move — expected-parent + If-Match ══════════
  await throws('moveOwnItem refuses without an expectedParentId',
    () => sp.moveOwnItem('d', 'itemX', 'newP', {}), /expectedParentId is required/i);

  reset((u, o) => (o.method === 'GET' ? mkResp(200, { id: 'itemX', name: 'f.pdf', parentReference: { id: 'SOMEONE_ELSE' }, eTag: 'W/"1"' }) : mkResp(500)));
  await throws('moveOwnItem refuses when the item is NOT in the expected portal folder',
    () => sp.moveOwnItem('d', 'itemX', 'newP', { expectedParentId: 'EXPECTED' }), /not in the expected/i);

  reset((u, o) => {
    if (o.method === 'GET') return mkResp(200, { id: 'itemX', name: 'f.pdf', parentReference: { id: 'EXPECTED' }, eTag: 'W/"9"' });
    if (o.method === 'PATCH') return mkResp(200, { id: 'itemX', parentReference: { id: 'newP' } });
    return mkResp(500);
  });
  const moved = await sp.moveOwnItem('d', 'itemX', 'newP', { expectedParentId: 'EXPECTED' });
  ok('moveOwnItem relocates its own item when the parent matches', moved && moved.parentReference.id === 'newP');
  ok('moveOwnItem pins the PATCH with If-Match (concurrency safety)',
    calls.some((c) => c.method === 'PATCH' && c.headers['If-Match'] === 'W/"9"'));

  // ══ deleteReplacedCorruptMirror: the seven guards ════════════════════════
  // A fully-valid scenario; each test perturbs exactly ONE fact to trip ONE guard.
  const D = 'd', CORRUPT = 'corruptId', REPL = 'replId', PARENT = 'parentFolder';
  const goodRoute = (over = {}) => (u, o) => {
    if (has(REPL)(u)) return mkResp(200, { id: REPL, size: over.replSize ?? 500 });
    if (has(CORRUPT)(u) && o.method === 'DELETE') return mkResp(204, '');
    if (has(CORRUPT)(u)) return mkResp(200, { id: CORRUPT, name: 'bad.pdf', size: over.corruptCur ?? 999,
      parentReference: { id: over.corruptParent ?? PARENT }, eTag: over.eTag === undefined ? 'W/"7"' : over.eTag });
    if (has(PARENT)(u)) return mkResp(200, { id: PARENT, name: over.leafName ?? 'Synced by Pilot', parentReference: { id: 'gp' } });
    // grandparent hop for the ancestry walk (non-Pilot, top of tree — no further parent)
    if (u.includes('/items/gp')) return mkResp(200, { id: 'gp', name: 'Documents' });
    return mkResp(500, 'unexpected');
  };
  const args = { expectedParentId: PARENT, corruptSize: 999, replacementItemId: REPL, localSize: 500 };

  // G1 — kill switch
  process.env.SHAREPOINT_DELETE_REPLACED_CORRUPT = '0';
  reset(goodRoute());
  await throws('G1 kill switch disables the sanctioned delete',
    () => sp.deleteReplacedCorruptMirror(D, CORRUPT, args), /disabled by SHAREPOINT_DELETE_REPLACED_CORRUPT/i);
  delete process.env.SHAREPOINT_DELETE_REPLACED_CORRUPT;

  // required args — corruptSize omitted (fail closed, A-Z audit F4)
  reset(goodRoute());
  await throws('missing corruptSize fails closed (no silent no-op of G4)',
    () => sp.deleteReplacedCorruptMirror(D, CORRUPT, { ...args, corruptSize: null }), /missing itemId|missing .*corruptSize|refused/i);

  // G3 — replacement not yet the local bytes
  reset(goodRoute({ replSize: 499 }));
  await throws('G3 refuses when the good replacement is not verified in place',
    () => sp.deleteReplacedCorruptMirror(D, CORRUPT, args), /replacement copy missing or size-unverified/i);

  // G5 — corrupt item moved out of the expected folder (human touched it)
  reset(goodRoute({ corruptParent: 'HUMAN_MOVED_IT' }));
  await throws('G5 refuses when the corrupt item is not in the recorded folder',
    () => sp.deleteReplacedCorruptMirror(D, CORRUPT, args), /not in the recorded portal-managed folder/i);

  // G4 — corrupt item's size changed since diagnosis (possible human fix)
  reset(goodRoute({ corruptCur: 1000 }));
  await throws('G4 refuses when the item size changed since diagnosis',
    () => sp.deleteReplacedCorruptMirror(D, CORRUPT, args), /size changed since diagnosis/i);

  // G6 — item is NOT inside a Pilot-created sync tree
  reset(goodRoute({ leafName: 'Some Human Folder' }));
  await throws('G6 refuses when the item is not inside a Pilot sync folder',
    () => sp.deleteReplacedCorruptMirror(D, CORRUPT, args), /not inside a Pilot-created sync folder/i);

  // G7 — no eTag to pin the delete
  reset(goodRoute({ eTag: null }));
  await throws('G7 refuses when there is no eTag to pin the delete',
    () => sp.deleteReplacedCorruptMirror(D, CORRUPT, args), /no eTag to pin/i);

  // corrupt === replacement id → refuse (never delete the good copy)
  reset(goodRoute());
  await throws('refuses when corrupt and replacement are the same item',
    () => sp.deleteReplacedCorruptMirror(D, CORRUPT, { ...args, replacementItemId: CORRUPT }), /same item|size-unverified/i);

  // ALL guards pass → the delete fires, pinned with If-Match
  reset(goodRoute());
  const del = await sp.deleteReplacedCorruptMirror(D, CORRUPT, args);
  ok('all seven guards satisfied → the corrupt mirror is deleted', del && del.deleted === true);
  ok('the sanctioned DELETE is pinned with If-Match (the eTag)',
    calls.some((c) => c.method === 'DELETE' && c.headers['If-Match'] === 'W/"7"'));

  // remove() stays a throwing no-op for everything else
  await throws('general remove() is still a forbidden throwing no-op',
    () => sp.remove('d', 'anything'), /no-delete by policy/i);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('GRAPH-GUARDS CRASH:', e); process.exit(1); });
