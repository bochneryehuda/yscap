'use strict';
/**
 * THE CLASS ATTACHMENT PATH — the one their own guide contradicts itself about.
 *
 * The V1 guide prints two different paths for the same call: the newer
 * order-completion walkthrough says `GET /orders/{id}/attachments`, the older
 * reference section says `GET /{id}/attachments`. `src/class/client.js` took the
 * newer one and left a note: if the first live pull 404s, THAT — not the
 * credential — is the thing to try.
 *
 * It did. Production logs, every five minutes, on a real order:
 *   [class] attachment list failed for order 29 — Class attachments failed: HTTP 404
 * …which means a finished Class appraisal could never be pulled onto the file.
 *
 * This pins the resolver that answers it. Pure — the caller is injected, so no
 * network, no credentials, no database.
 */
const path = require('path');
const client = require(path.join(__dirname, '..', 'src/class/client'));
const { attachmentPathTry, ATTACH_PATHS, resetAttachPath } = client._internals;

let n = 0, failures = 0;
const ok = (c, m) => { n++; console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };
const httpErr = (status) => Object.assign(new Error(`HTTP ${status}`), { status });

(async () => {
  // ---- 1. The documented path is tried first and, when it answers, that is that.
  {
    resetAttachPath();
    const seen = [];
    const out = await attachmentPathTry(async (p) => { seen.push(p); return { ok: true, p }; }, 29);
    ok(seen.length === 1 && seen[0] === '/orders/29', '1a: the documented path is tried first');
    ok(out && out.p === '/orders/29', '1b: its answer is returned unchanged');
  }

  // ---- 2. A 404 on the documented path falls back to the other one.
  {
    resetAttachPath();
    const seen = [];
    const out = await attachmentPathTry(async (p) => {
      seen.push(p);
      if (p === '/orders/29') throw httpErr(404);
      return { ok: true, p };
    }, 29);
    ok(seen.length === 2 && seen[1] === '/29', '2a: a 404 makes it try the guide’s other path');
    ok(out && out.p === '/29', '2b: the working path’s answer is returned');
  }

  // ---- 3. …and it REMEMBERS, so the next call does not pay for the 404 again.
  {
    const seen = [];
    const out = await attachmentPathTry(async (p) => { seen.push(p); return { ok: true, p }; }, 30);
    ok(seen.length === 1 && seen[0] === '/30', '3: the shape that answered is used first next time');
    ok(out && out.p === '/30', '3b: …and still returns its answer');
  }

  // ---- 4. Anything that is NOT a 404 is a real answer — never re-asked elsewhere.
  //         Re-asking on a different path would bury the actual reason (a dead
  //         credential, their service down) behind a second, unrelated failure.
  for (const status of [401, 403, 429, 500]) {
    resetAttachPath();
    const seen = [];
    let caught = null;
    try { await attachmentPathTry(async (p) => { seen.push(p); throw httpErr(status); }, 31); }
    catch (e) { caught = e; }
    ok(seen.length === 1, `4.${status}a: an HTTP ${status} is not retried on the other path`);
    ok(caught && caught.status === status, `4.${status}b: …and the real error is what surfaces`);
  }

  // ---- 5. BOTH paths 404 → the FIRST error is thrown. That is the honest answer:
  //         this order genuinely has no attachments at Class.
  {
    resetAttachPath();
    const seen = [];
    let caught = null;
    try { await attachmentPathTry(async (p) => { seen.push(p); throw httpErr(404); }, 32); }
    catch (e) { caught = e; }
    ok(seen.length === ATTACH_PATHS.length, '5a: every shape is tried before giving up');
    ok(caught && caught.status === 404, '5b: a genuine "no such order" still reports 404');
  }

  // ---- 6. A remembered shape that starts failing re-opens the search, so a tenant
  //         moved between API revisions heals itself on the next call.
  {
    resetAttachPath();
    await attachmentPathTry(async (p) => { if (p === '/orders/33') throw httpErr(404); return { p }; }, 33);
    const seen = [];
    const out = await attachmentPathTry(async (p) => {
      seen.push(p);
      if (p === '/34') throw httpErr(404);
      return { ok: true, p };
    }, 34);
    ok(seen.length === 2 && seen[0] === '/34' && seen[1] === '/orders/34',
      '6a: the remembered shape is tried first, then the other when it 404s');
    ok(out && out.p === '/orders/34', '6b: …and it recovers without anyone intervening');
  }

  // ---- 7. The order id is URL-encoded on every path (their ids are opaque strings).
  {
    resetAttachPath();
    const seen = [];
    await attachmentPathTry(async (p) => { seen.push(p); return { p }; }, 'a b/c');
    ok(seen[0] === '/orders/a%20b%2Fc', '7: the order id is encoded, so a slash in it cannot forge a path');
  }

  console.log(failures ? `\n${failures} FAILURE(S) of ${n}` : `\nOK  class-attachment-path-pure: ${n} checks passed`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('ERROR', e); process.exit(1); });
