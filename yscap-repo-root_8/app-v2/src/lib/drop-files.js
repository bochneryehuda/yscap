/* READING A DROPPED DOCUMENT — including one dragged straight out of the
   Outlook DESKTOP app (owner-directed 2026-07-28).

   An Outlook attachment is not a file on disk. It lives inside the .ost/.pst or
   on Exchange, so when you drag it out Windows hands the drop target a VIRTUAL
   file — the CFSTR_FILEDESCRIPTOR / CFSTR_FILECONTENTS clipboard formats —
   instead of the ordinary CF_HDROP path list that every File-Explorer drag
   uses. Reading `e.dataTransfer.files` (what every drop handler in this app
   used to do, and the only thing an <input type=file> understands) sees CF_HDROP
   and nothing else, which is why dragging from Outlook did nothing at all.

   TWO paths reach the real bytes. We try BOTH and keep whichever one actually
   produces them:
     1. `dataTransfer.files` — Chromium (Chrome / Edge 76+ on Windows)
        materialises the virtual file into a temp file when the drop lands, so
        with the CLASSIC Outlook desktop app this usually just works.
     2. `DataTransferItem.getAsFileSystemHandle()` (Chrome / Edge 86+, the File
        System Access API) — the virtual-file path proper. This is what reads an
        Outlook attachment when (1) hands back nothing, or hands back a
        correctly-named but EMPTY placeholder. It also covers a file dragged out
        of a zip or out of a cloud-backed folder.

   HARD CONSTRAINT — a DataTransfer is emptied the instant the drop handler
   returns, so every read off the event happens SYNCHRONOUSLY, up front, and
   only the RESOLVING is awaited. Never `await` before touching `dataTransfer`:
   that is exactly what makes getAsFileSystemHandle come back empty.

   A ZERO-BYTE result is treated as a FAILURE, never as a document. A half-working
   Outlook drag produces a correctly-named 0-byte placeholder, and filing an empty
   "Final HUD.pdf" against a closing condition is worse than filing nothing — it
   reads as done to everyone who looks at the file afterwards. We say what went
   wrong instead.

   KNOWN LIMITS, which the message names rather than hides:
     · The NEW Outlook for Windows (the WebView2/React one) does not hand a real
       file to anything outside itself — not to File Explorer, not to any
       browser. No web page can fix that; Microsoft's own answer is "save the
       attachment first, or use classic Outlook".
     · Firefox and Safari have no virtual-file path, so an Outlook drag into
       them cannot work either. Chrome and Edge are the supported combination.
     · Outlook on the WEB (a browser tab) drags a download link, not a file.
   In every one of those cases the user still has the Upload button, and the
   message points them at it. */

const CANT_READ =
  "That didn't come through as a file. If it came from the new Outlook, drag it "
  + 'to your desktop first and then drop it here — or use the Upload button. '
  + '(Dragging straight out of Outlook works in Chrome and Edge with the classic '
  + 'Outlook desktop app.)';

const NOTHING = { files: [], problem: '' };

/* Keep only entries that are a real file with real bytes, first one wins.
   The same document can arrive down both paths at once (temp file AND handle),
   so it is de-duplicated on name+size — two different documents sharing both
   are the same document for our purposes. */
function usable(list) {
  const out = [];
  const seen = new Set();
  for (let i = 0; i < list.length; i++) {
    const f = list[i];
    if (!f || !f.name || !(Number(f.size) > 0)) continue;
    const key = `${f.size}:${f.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(f);
  }
  return out;
}

/* Read the documents out of a drop event.

   MUST be called synchronously from the drop handler (see the constraint above).
   Resolves to { files, problem }: `files` is every readable document that was
   dropped, `problem` is a plain-language explanation set ONLY when something
   file-shaped was dropped and none of it could be read. Dropping text, a link
   or a selection resolves to neither — that is not an error, it is just not a
   document. */
export function readDroppedFiles(e) {
  const dt = e && e.dataTransfer;
  if (!dt) return Promise.resolve(NOTHING);

  /* ---- synchronous capture — nothing may await above this line ---- */
  let direct = [];
  try { direct = Array.from(dt.files || []); } catch (_) { direct = []; }
  let items = [];
  try { items = Array.from(dt.items || []).filter((it) => it && it.kind === 'file'); } catch (_) { items = []; }
  // The virtual-file path (Outlook). Older browsers have no such method.
  const handles = items.map((it) => {
    try { return typeof it.getAsFileSystemHandle === 'function' ? it.getAsFileSystemHandle() : null; }
    catch (_) { return null; }
  });
  // The ordinary per-item path — same files as dt.files on a normal drag, and a
  // second chance on browsers that populate items but not files.
  const itemFiles = items.map((it) => { try { return it.getAsFile(); } catch (_) { return null; } });
  /* ---- end synchronous capture ---- */

  if (!direct.length && !items.length) return Promise.resolve(NOTHING);

  const settle = (extra) => {
    const files = usable(extra.concat(direct, itemFiles));
    return files.length ? { files, problem: '' } : { files: [], problem: CANT_READ };
  };

  return Promise.all(handles.map((p) => (p && typeof p.then === 'function'
    ? p.then((h) => (h && h.kind === 'file' && typeof h.getFile === 'function' ? h.getFile() : null)).catch(() => null)
    : Promise.resolve(null))))
    .then(settle)
    // A handle that rejects must never lose a document the ordinary path did read.
    .catch(() => settle([]));
}

/* The whole body of a drop handler: read the documents, hand them to `deliver`,
   and explain it when nothing readable arrived. `onProblem` defaults to the
   floating notice below. Returns a promise so a caller can await the upload. */
export function onFilesDropped(e, deliver, onProblem) {
  return readDroppedFiles(e).then(({ files, problem }) => {
    if (files.length) return deliver ? deliver(files) : undefined;
    if (problem) (onProblem || showDropProblem)(problem);
    return undefined;
  });
}

/* A failed drop has to be readable WHERE the file was dropped. These screens are
   long, and a notice pinned to the top of a panel is off-screen by the time you
   are dropping onto a condition near the bottom — which reads as "nothing
   happened" (the same trap the Save-button notice hit on 2026-07-27). So the
   message floats over the viewport, and clicking it dismisses it.

   Colours are explicit dark ink on white: `var(--ink)` is a LIGHT token in this
   palette and would render the text invisible (HARD RULE, 2026-07-26). */
let noticeEl = null;
let noticeTimer = 0;

export function showDropProblem(msg) {
  if (typeof document === 'undefined' || !msg) return;
  if (!noticeEl) {
    noticeEl = document.createElement('div');
    noticeEl.setAttribute('role', 'alert');
    noticeEl.style.cssText = [
      'position:fixed', 'left:50%', 'bottom:24px', 'transform:translateX(-50%)',
      'z-index:2147483000', 'max-width:min(560px,calc(100vw - 32px))',
      'background:#FFFFFF', 'color:#141B22', 'border:1px solid #AE8746',
      'border-radius:10px', 'padding:12px 14px',
      'box-shadow:0 10px 28px rgba(20,27,34,.18)',
      'font-family:inherit', 'font-size:14px', 'line-height:1.45',
      'cursor:pointer',
    ].join(';');
    noticeEl.addEventListener('click', hideDropProblem);
  }
  noticeEl.textContent = msg;
  if (!noticeEl.isConnected) document.body.appendChild(noticeEl);
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(hideDropProblem, 14000);
}

export function hideDropProblem() {
  clearTimeout(noticeTimer);
  if (noticeEl && noticeEl.isConnected) noticeEl.remove();
}
