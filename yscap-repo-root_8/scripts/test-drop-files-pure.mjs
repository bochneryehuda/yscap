/**
 * READING A DROPPED DOCUMENT, INCLUDING ONE DRAGGED OUT OF OUTLOOK
 * (owner-directed 2026-07-28). Pure — no DOM, no browser, no server.
 *
 * An Outlook attachment is a VIRTUAL file: it lives in the .ost/.pst or on
 * Exchange, so Windows hands the drop target CFSTR_FILEDESCRIPTOR rather than
 * the CF_HDROP path list that `dataTransfer.files` reads. Every drop handler in
 * the portal used to read only `dataTransfer.files`, which is exactly why
 * dragging from Outlook did nothing. These fixtures reproduce the real shapes
 * a browser presents, so the virtual-file path can never be dropped again.
 *
 * The two assertions that matter most:
 *   · a virtual-file-only drop (Outlook) yields the document, and
 *   · a HALF-worked Outlook drag — a correctly-named 0-byte placeholder — never
 *     files an empty document against a condition. An empty "Final HUD.pdf" on
 *     a closing condition reads as done to everyone who looks at the file
 *     afterwards, which is worse than filing nothing.
 */
import { readDroppedFiles, onFilesDropped } from '../app-v2/src/lib/drop-files.js';

let failures = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };

/* A stand-in for a browser File — the reader only ever looks at name + size. */
const file = (name, size) => ({ name, size });

/* A DataTransferItem. `handle` present = the File System Access path is
   available for this item (Chrome/Edge 86+); `asFile` is the ordinary path. */
function item({ asFile = null, handle = undefined, kind = 'file' }) {
  const it = { kind, getAsFile: () => asFile };
  if (handle !== undefined) {
    it.getAsFileSystemHandle = () => (handle instanceof Error ? Promise.reject(handle) : Promise.resolve(handle));
  }
  return it;
}
const handleFor = (f) => ({ kind: 'file', getFile: () => Promise.resolve(f) });
const drop = (dt) => ({ dataTransfer: dt });

// ── the ordinary File-Explorer drag: CF_HDROP, dataTransfer.files populated ──
{
  const f = file('bank-statement.pdf', 4096);
  const r = await readDroppedFiles(drop({ files: [f], items: [item({ asFile: f })] }));
  ok(r.files.length === 1 && r.files[0] === f, 'Explorer drag: the file comes through');
  ok(r.problem === '', 'Explorer drag: no problem reported');
}

// ── OUTLOOK: a virtual file. dataTransfer.files is EMPTY; only the File System
//    Access handle reaches the bytes. This is the whole point of the change. ──
{
  const f = file('Final HUD.pdf', 88213);
  const r = await readDroppedFiles(drop({ files: [], items: [item({ asFile: null, handle: handleFor(f) })] }));
  ok(r.files.length === 1 && r.files[0] === f, 'Outlook attachment: read through the virtual-file handle');
  ok(r.problem === '', 'Outlook attachment: no problem reported');
}

// ── OUTLOOK, half-worked: a correctly-named 0-byte placeholder in
//    dataTransfer.files, the real bytes only behind the handle. ──────────────
{
  const empty = file('Final HUD.pdf', 0);
  const real = file('Final HUD.pdf', 88213);
  const r = await readDroppedFiles(drop({
    files: [empty],
    items: [item({ asFile: empty, handle: handleFor(real) })],
  }));
  ok(r.files.length === 1, 'placeholder + real: exactly one document');
  ok(r.files[0] === real, 'placeholder + real: the REAL bytes win, never the 0-byte placeholder');
}

// ── nothing readable anywhere (new Outlook, Firefox, Safari): say so, and file
//    NOTHING. An empty document on a closing condition reads as done. ─────────
{
  const empty = file('Invoice.pdf', 0);
  const r = await readDroppedFiles(drop({ files: [empty], items: [item({ asFile: empty })] }));
  ok(r.files.length === 0, 'unreadable drop: no empty document is ever filed');
  ok(/desktop first/.test(r.problem), 'unreadable drop: explains what to do instead');
}

// ── dragging text / a link / a selection is not an error, just not a document ─
{
  const r = await readDroppedFiles(drop({ files: [], items: [item({ kind: 'string' })] }));
  ok(r.files.length === 0 && r.problem === '', 'a text drag reports neither a file nor a problem');
}
{
  const r = await readDroppedFiles(drop({ files: [], items: [] }));
  ok(r.files.length === 0 && r.problem === '', 'an empty drag reports neither a file nor a problem');
}
{
  const r = await readDroppedFiles({});
  ok(r.files.length === 0 && r.problem === '', 'a drop with no dataTransfer never throws');
}

// ── the same document arriving down BOTH paths is ONE document, not two ──────
{
  const f = file('EIN letter.pdf', 12000);
  const r = await readDroppedFiles(drop({ files: [f], items: [item({ asFile: f, handle: handleFor(file('EIN letter.pdf', 12000)) })] }));
  ok(r.files.length === 1, 'the same document down both paths is de-duplicated');
}

// ── a rejecting / absent handle must never lose what the ordinary path read ──
{
  const f = file('contract.pdf', 900);
  const r = await readDroppedFiles(drop({ files: [f], items: [item({ asFile: f, handle: new Error('nope') })] }));
  ok(r.files.length === 1 && r.files[0] === f, 'a failing handle still yields the ordinary file');
}
{
  const f = file('contract.pdf', 900);
  const r = await readDroppedFiles(drop({ files: [f], items: [item({ asFile: f, handle: null })] }));
  ok(r.files.length === 1 && r.files[0] === f, 'a null handle still yields the ordinary file');
}
// A directory handle is not a document — dropping a folder uploads nothing.
{
  const r = await readDroppedFiles(drop({ files: [], items: [item({ asFile: null, handle: { kind: 'directory' } })] }));
  ok(r.files.length === 0 && /desktop first/.test(r.problem), 'a dropped folder is not filed as a document');
}

// ── multiple documents keep their dropped order (slot numbering depends on it) ─
{
  const a = file('page1.pdf', 10), b = file('page2.pdf', 20), c = file('page3.pdf', 30);
  const r = await readDroppedFiles(drop({
    files: [],
    items: [a, b, c].map((f) => item({ asFile: null, handle: handleFor(f) })),
  }));
  ok(r.files.map((f) => f.name).join(',') === 'page1.pdf,page2.pdf,page3.pdf', 'multi-file drop keeps its order');
}

// ── THE SYNCHRONOUS-READ CONTRACT ───────────────────────────────────────────
// A DataTransfer is emptied the moment the drop handler returns. If anything
// awaits before reading it, the read comes back empty and Outlook silently
// stops working. Reproduce that by emptying the fixture on the next microtask:
// the document must already have been captured.
{
  const f = file('Closed package.pdf', 51200);
  const dt = { files: [], items: [item({ asFile: null, handle: handleFor(f) })] };
  const p = readDroppedFiles(drop(dt));
  dt.files = []; dt.items = [];          // the browser neuters it right after the handler
  const r = await p;
  ok(r.files.length === 1 && r.files[0] === f, 'the event is read synchronously — a neutered DataTransfer loses nothing');
}

// ── onFilesDropped: the whole body of a drop handler ────────────────────────
{
  const f = file('tracking-label.pdf', 700);
  let delivered = null, problem = null;
  await onFilesDropped(drop({ files: [f], items: [item({ asFile: f })] }), (x) => { delivered = x; }, (m) => { problem = m; });
  ok(delivered && delivered.length === 1 && delivered[0] === f, 'onFilesDropped delivers the documents');
  ok(problem === null, 'onFilesDropped reports no problem on a good drop');
}
{
  let delivered = null, problem = null;
  const empty = file('x.pdf', 0);
  await onFilesDropped(drop({ files: [empty], items: [item({ asFile: empty })] }), (x) => { delivered = x; }, (m) => { problem = m; });
  ok(delivered === null, 'onFilesDropped delivers nothing when nothing could be read');
  ok(typeof problem === 'string' && problem.length > 0, 'onFilesDropped reports the problem to the caller');
}
{
  // No onProblem given: the default notice needs a document, and there is none
  // under node — it must degrade quietly rather than throw into the handler.
  let threw = null;
  try { await onFilesDropped(drop({ files: [file('x.pdf', 0)], items: [] }), () => {}); }
  catch (e) { threw = e; }
  ok(threw === null, 'the default problem notice never throws where there is no DOM');
}

console.log(failures ? `test-drop-files-pure FAILED (${failures})` : 'test-drop-files-pure: all checks passed');
process.exit(failures ? 1 : 0);
