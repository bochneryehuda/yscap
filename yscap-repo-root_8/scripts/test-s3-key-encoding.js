/**
 * THE PATH ON THE WIRE MUST BE THE PATH THAT WAS SIGNED.
 *
 * `signV4` signs `canonicalUri(path)` — RFC-3986 per segment, '/' separators kept. Both S3 clients
 * used to hand the RAW path to `http.request`, so any key needing encoding was signed one way and
 * sent another. Against real S3 that is a 403 SignatureDoesNotMatch; a literal space is not even a
 * legal HTTP request line. It was found by a disaster-recovery rehearsal in which a document called
 * `bank statement (1).pdf` silently failed to copy into the vault.
 *
 * It is unreachable today and is pinned as a TRAP, not a live fault: every key the system writes is
 * machine-generated and already safe — `db/<yyyy>/<mm>/<stamp>-<hex>.ysbak` in the vault, and
 * `storage-s3.newRef`'s `<hex>/<hex><.ext>` for documents. So the first assertion below is that the
 * fix changes NOTHING for the keys we really use, and the rest are what happens the day somebody
 * stores an object under a human filename — a very ordinary thing to add.
 */
const assert = require('assert');
const http = require('http');
const { canonicalUri } = require('../src/lib/storage-s3')._internals;
const { createVault, vaultConfigFromEnv } = require('../src/lib/backup/vault');

let n = 0; const ok = (m) => { n++; console.log('  ok -', m); };

// ── 1. PURE: a no-op for every key shape this system actually writes ──────────
const REAL_KEYS = [
  '/yscap-backup-vault/db/2026/08/20260803T054420Z-a4ebd63b.ysbak',
  '/yscap-backup-vault/db/2026/08/20260803T054420Z-a4ebd63b.manifest.json',
  '/yscap-backup-vault/db/2026/08/20260803T054420Z-a4ebd63b.inventory.ysbak',
  '/yscap-backup-vault/documents/ab/abcdef0123456789abcdef0123456789.pdf.ysbak',
  '/yscap-backup-vault/_probe/1785719371149-a1b2c3d4.txt',
  '/pilot-documents/ab/abcdef0123456789abcdef0123456789.xlsx',
];
for (const k of REAL_KEYS) {
  assert.strictEqual(canonicalUri(k), k, `encoding must not alter a real key: ${k}`);
}
ok(`every key shape the system writes is byte-identical after encoding (${REAL_KEYS.length} shapes)`);

// A '/' is a separator and must never become %2F, or every object lands in one flat key.
assert.strictEqual(canonicalUri('/b/a/c/d.txt'), '/b/a/c/d.txt');
assert.ok(canonicalUri('/b/x y.txt').includes('%20'));
ok("separators survive; a space becomes %20");

// ── 2. LIVE: what actually goes on the wire ──────────────────────────────────
(async () => {
  const seen = [];
  const srv = http.createServer((req, res) => {
    seen.push({ method: req.method, url: req.url });
    req.resume();
    req.on('end', () => {
      if (req.method === 'GET') { res.writeHead(200); res.end('payload'); }
      else if (req.method === 'HEAD') { res.writeHead(200, { 'content-length': '7' }); res.end(); }
      else { res.writeHead(200, { etag: '"x"' }); res.end(); }
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;

  const vault = createVault(Object.assign(vaultConfigFromEnv('BACKUP_S3', {
    BACKUP_S3_BUCKET: 'vault',
    BACKUP_S3_ENDPOINT: `http://127.0.0.1:${port}`,
    BACKUP_S3_ACCESS_KEY_ID: 'k',
    BACKUP_S3_SECRET_ACCESS_KEY: 's',
    BACKUP_S3_REGION: 'auto',
  }), { label: 'test' }));

  // A safe key must be sent EXACTLY as-is — this is the production no-op, proven on the wire.
  seen.length = 0;
  await vault.put('db/2026/08/20260803T054420Z-a4ebd63b.ysbak', Buffer.from('x'));
  assert.strictEqual(seen[0].url, '/vault/db/2026/08/20260803T054420Z-a4ebd63b.ysbak');
  ok('a real backup key goes on the wire completely unchanged');

  // An awkward key must be percent-encoded on the wire — and decode back to the original.
  const awkward = 'documents/2026/bank statement (1).pdf.ysbak';
  for (const [verb, call] of [
    ['PUT', () => vault.put(awkward, Buffer.from('x'))],
    ['GET', () => vault.get(awkward)],
    ['HEAD', () => vault.head(awkward)],
  ]) {
    seen.length = 0;
    await call();
    const url = seen[0].url;
    assert.ok(!/ /.test(url), `${verb} put a raw space on the wire: ${url}`);
    assert.ok(url.includes('%20') && url.includes('%28'), `${verb} did not encode: ${url}`);
    assert.strictEqual(decodeURIComponent(url), `/vault/${awkward}`,
      `${verb} encoded to something that does not decode back to the key`);
  }
  ok('a key with spaces and brackets is encoded on PUT, GET and HEAD — and decodes back exactly');

  // Non-ASCII too: a borrower document could easily be named in another language.
  seen.length = 0;
  await vault.get('documents/2026/rapport été.pdf.ysbak');
  assert.ok(seen[0].url.includes('%C3%A9'), `non-ASCII not UTF-8 encoded: ${seen[0].url}`);
  assert.strictEqual(decodeURIComponent(seen[0].url), '/vault/documents/2026/rapport été.pdf.ysbak');
  ok('a non-ASCII key is UTF-8 percent-encoded and round-trips');

  // The query string was already encoded correctly; prove the path fix did not disturb it.
  seen.length = 0;
  await vault.list('documents/');
  const listed = seen[0].url;
  assert.ok(listed.startsWith('/vault?') || listed.startsWith('/vault/?'), listed);
  assert.ok(/list-type=2/.test(listed) && /prefix=documents%2F/.test(listed), listed);
  ok('LIST still signs and sends its query the same way');

  srv.close();
  console.log(`\ntest-s3-key-encoding: ${n} assertions passed`);
  process.exit(0);
})().catch((e) => { console.error('FAILED:', e); process.exit(1); });
