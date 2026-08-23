/* THE UPLOAD SHOWS ITS WORK — the properties of the one mechanism.

   Owner-reported 2026-08-23: *"everywhere in our system … when you upload a document,
   right now it's not doing anything while it's uploading. It's just blank, and it
   sounds like it's not uploading. For example, in the condition center … the second
   you upload a document, while the system is working to upload, it already has the
   document over there with a bar and a percentage."*

   Two things had to change, and both are asserted here:

     1. THE TRANSPORT HAD TO BE ABLE TO REPORT PROGRESS AT ALL. Every upload used
        `fetch`, whose promise settles when the RESPONSE arrives and which has no
        event for "42% of the request body has been sent". So no surface could have
        drawn a bar even if it wanted to — there was no number. Only
        XMLHttpRequest.upload reports bytes sent, so the streaming door must use it,
        and must keep using it: a future "tidy-up" back to fetch would silently
        reinstate the exact defect.

     2. THE STATE HAD TO BE SHARED. Roughly twenty upload sites, each with its own
        local state, is twenty chances to forget — which is how "everywhere in our
        system" became true. The transport writes to one store; a surface renders a
        row. Asserted: the store's behaviour, and that the surfaces the owner named
        actually render it.

   Pure — no DOM, no browser, no network, no database.
*/
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
// Strip comments before any "must not appear" check: these files necessarily NAME the
// pattern they exist to replace, and a guard that read comments would fail on its own
// explanation — and then get "fixed" by deleting the explanation.
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

let pass = 0, fail = 0;
const ok = (c, m, extra) => { if (c) { pass++; } else { fail++; console.log('  FAIL:', m, extra ? `— ${extra}` : ''); } };

const up = await import('../app-v2/src/lib/upload-progress.js');

// ---- the target key: every upload files itself somewhere sensible, unasked -----
ok(up.uploadTarget({ checklistItemId: 'c1' }) === 'condition:c1', 'a condition upload files under its condition');
ok(up.uploadTarget({ llcId: 'l1' }) === 'entity:l1', 'an entity-slot upload files under its entity');
ok(up.uploadTarget({ trackRecordId: 't1' }) === 'track:t1', 'a track-record upload files under its record');
ok(up.uploadTarget({ applicationId: 'a1' }) === 'file:a1', 'an unattached upload files under the loan file');
ok(up.uploadTarget({}) === 'global', 'an upload with no context still gets a key, never undefined');
ok(up.uploadTarget(null) === 'global', 'null metadata does not throw');
// A condition wins over the entity when BOTH are present (an entity slot uploaded from
// the condition centre) — that is the box the row is rendered in.
ok(up.uploadTarget({ checklistItemId: 'c1', llcId: 'l1' }) === 'condition:c1',
  'when an upload carries both, it files where the row is actually rendered');
ok(up.uploadTarget({ progressKey: 'custom:1', checklistItemId: 'c1' }) === 'custom:1',
  'an explicit progressKey overrides the derivation');

// ---- the row's life -----------------------------------------------------------
up._reset();
let seen = [];
const unsub = up.subscribe((rows) => { seen = rows; });

const id = up.startUpload({ target: 'condition:c1', filename: 'insurance-binder.pdf', size: 1000 });
ok(seen.length === 1, 'a row appears the moment the upload starts — before any byte moves');
ok(seen[0].filename === 'insurance-binder.pdf', 'and it carries the real filename, as the owner asked');
ok(seen[0].pct === 0 && seen[0].status === 'uploading', 'starting at 0%, uploading');

up.updateUpload(id, { loaded: 250, total: 1000 });
ok(seen[0].pct === 25, `250 of 1000 bytes is 25% (got ${seen[0].pct})`);

/* THE CAP AT 99 IS NOT COSMETIC. The browser fires its final upload event when the last
   byte is handed to the SOCKET — the server has not stored the file, and on a large
   document has not finished writing it. 100% there is a claim we cannot back, and the
   bar would then sit at 100% doing nothing, which reads as stuck for exactly the reason
   the whole defect reads as broken. */
up.updateUpload(id, { loaded: 1000, total: 1000 });
ok(seen[0].pct === 99, `the bar stops at 99% while the server is still storing (got ${seen[0].pct})`);

up.finishSending(id);
ok(seen[0].status === 'processing', 'once the body is out the row says it is saving, not that it is done');

up.completeUpload(id);
ok(seen[0].pct === 100 && seen[0].status === 'done', '100% means the SERVER said yes');

// A sizeless upload (the base64 door, where the bytes were already in memory) reports
// no percentage rather than a made-up one.
up._reset();
const id2 = up.startUpload({ target: 'condition:c2', filename: 'scan.jpg', size: 0 });
up.updateUpload(id2, { loaded: 10, total: 0 });
ok(seen[0].pct === null, 'with no known size there is no percentage — the row renders indeterminate, not a fake bar');

// ---- a failure STAYS ----------------------------------------------------------
up._reset();
const id3 = up.startUpload({ target: 'condition:c3', filename: 'deed.pdf', size: 500 });
up.failUpload(id3, 'That file type is not accepted.');
ok(seen.length === 1 && seen[0].status === 'error', 'a failed row stays on screen');
ok(seen[0].error === 'That file type is not accepted.', "carrying the server's own reason, not a generic message");
await new Promise((r) => setTimeout(r, 60));
ok(up.rowsFor('condition:c3').length === 1,
  'and it does NOT disappear on its own — a silent failure is the same defect as a silent upload');
up.dismissUpload(id3);
ok(up.rowsFor('condition:c3').length === 0, 'until it is dismissed');

// ---- rows are scoped to their target ------------------------------------------
up._reset();
up.startUpload({ target: 'condition:a', filename: '1.pdf', size: 1 });
up.startUpload({ target: 'condition:b', filename: '2.pdf', size: 1 });
up.startUpload({ target: 'condition:a', filename: '3.pdf', size: 1 });
ok(up.rowsFor('condition:a').length === 2 && up.rowsFor('condition:b').length === 1,
  'each condition shows only its own uploads');
unsub();

// ---- the transport must keep the only API that can report progress ------------
const api = code(read('app-v2/src/lib/api.js'));
ok(/xhr\.upload\.onprogress/.test(api),
  'the streaming upload reports progress from XMLHttpRequest.upload — the ONLY browser API that can');
ok(!/resilientFetch\([^)]*method:\s*'POST'[^)]*body:\s*file/s.test(api),
  'the streaming upload no longer goes through fetch, which cannot report upload progress');
ok(/up\.startUpload\(/.test(api) && /up\.completeUpload\(/.test(api) && /up\.failUpload\(/.test(api),
  'the transport writes to the shared store, so no upload site has to remember to');

// Every base64 door is tracked too — "everywhere" has to mean everywhere.
const untracked = api.split('\n').filter((l) =>
  /:\s*req\('POST',[^)]*normalizeUpload\(b\)\)/.test(l) && !/trackJsonUpload/.test(l));
ok(untracked.length === 0,
  'every base64 upload door is tracked as well as the streaming one',
  untracked.join(' | '));

// ---- the surfaces the owner named actually render a row -----------------------
const MUST_RENDER = [
  ['app-v2/src/screens/StaffApplication.jsx', 'the condition centre (named in the report)'],
  ['app-v2/src/screens/Application.jsx', "the borrower's own conditions"],
  ['app-v2/src/screens/TpoFile.jsx', "the broker's conditions"],
  ['app-v2/src/components/DrawsPanel.jsx', 'draw supporting documents'],
];
for (const [f, what] of MUST_RENDER) {
  ok(/<UploadRows\s/.test(read(f)), `${what} renders an upload row`, f);
}

console.log(`\ntest-upload-progress-pure: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
