/**
 * Long-Term's OWN fetch helper.
 *
 * WHY THIS IS NOT `../lib/api.js`. Long-Term may not import RTL code — the
 * separation gate catches it, and it is right to: Long-Term "starts at zero", and
 * the only authorized front-end component crossing is BorrowerProfilePanel.jsx.
 * Re-using RTL's client would be convenient and would tie the two products' request
 * layers together, which is exactly what the charter forbids.
 *
 * WHAT IT DOES SHARE — and why that is not a crossing — is the LOGIN. The owner's
 * rule is one login for both sides ("same login same borrower record"), so both
 * products necessarily read the SAME browser token. That is the identity zone, not
 * an import: this file names the storage key and never reaches into RTL's module.
 * If that key ever changes, this line changes with it — a cost the separation is
 * worth, and cheaper than the products sharing a request layer.
 *
 * Deliberately small. No retry ladder, no global session-expiry handling: those
 * belong to the product that owns the screen a user is actually working in, and a
 * side build that is not live must not be able to sign anybody out of the live one.
 * A 401 here surfaces as an ordinary error on a Long-Term screen.
 */

/* THE ONE RECORD OF WHAT IS UPLOADING RIGHT NOW — shared with the short-term
   side under the 2026-08-30 share-the-code grant (see the crossing ledger).
   The store and its `uploadTarget()` are product-neutral: a row files itself
   under `condition:<id>` from the upload's own metadata, so the shared
   `<UploadRows/>` renders a Long-Term upload without knowing which product it
   belongs to. Publishing into it is what makes the bar appear at all; a second
   progress store would be a second answer to "is this uploading?", and the one
   that drifts is the one the person is looking at. */
import * as up from '../lib/upload-progress.js';

const TOKEN_KEY = 'ys_portal_token';

const token = () => {
  try { return localStorage.getItem(TOKEN_KEY) || ''; } catch { return ''; }
};

/** A message a person can read, from whatever the server actually sent.
 *
 *  ⛔ THE HUMAN SENTENCE WINS OVER THE MACHINE CODE. An LT route answers a refusal as
 *  `{ ok:false, error:'<code>', message:'<sentence>' }` — `error` is the code a caller BRANCHES on
 *  and `message` is the one a person READS. This preferred `error`, so a refusal that had taken the
 *  trouble to explain itself still reached the screen as `unknown_zip`. Falling back to `error`
 *  keeps every route that carries no message behaving exactly as before. */
function messageFor(status, data) {
  if (data && typeof data.message === 'string' && data.message.trim()) return data.message;
  if (data && typeof data.error === 'string' && data.error.trim()) return data.error;
  if (status === 401) return 'Your session has ended. Sign in again.';
  if (status === 403) return 'You do not have access to that.';
  if (status === 404) return 'That is not here.';
  if (status >= 500) return 'Something went wrong at our end. Try again in a moment.';
  return 'That did not work.';
}

export async function ltFetch(method, path, body) {
  const headers = { 'Content-Type': 'application/json' };
  const t = token();
  if (t) headers.Authorization = `Bearer ${t}`;

  const res = await fetch(path, {
    method,
    headers,
    body: body != null ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });

  let data = null;
  try { data = await res.json(); } catch { /* an empty or non-JSON body is fine */ }

  if (!res.ok) {
    const err = new Error(messageFor(res.status, data));
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

/**
 * Download a file the server builds (today: the census spreadsheet).
 *
 * It cannot be a plain `<a href>`: every /api/lt route is behind the session, and
 * a bare link sends no Authorization header — so the browser would navigate to a
 * 401 and the person would see a broken page instead of a spreadsheet. So the
 * bytes are fetched with the header, turned into a blob, and handed to a
 * throwaway link. The object URL is REVOKED afterwards or the whole file stays in
 * memory for the life of the tab.
 *
 * A FAILURE IS THROWN, never saved. Without the `res.ok` check the caller would
 * "download" the error JSON as a .csv — a file that opens to a shrug.
 */
export async function ltDownload(path, filename) {
  const headers = {};
  const t = token();
  if (t) headers.Authorization = `Bearer ${t}`;

  const res = await fetch(path, { method: 'GET', headers, credentials: 'same-origin' });
  if (!res.ok) {
    let data = null;
    try { data = await res.json(); } catch { /* the status is enough */ }
    const err = new Error(messageFor(res.status, data));
    err.status = res.status;
    throw err;
  }

  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    // Deferred: Safari reads the URL asynchronously after the click, so revoking
    // in the same tick can hand it an already-freed blob and save nothing.
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }
}

/**
 * Fetch a document and hand back a blob: URL for an `<iframe>` or an `<img>`.
 *
 * An `<iframe src>` cannot carry the Bearer token — the same lesson the broker draw
 * photos taught — so a preview that points a frame straight at the route renders a
 * sign-in page instead of the document. The caller MUST revoke the URL when it is
 * done with it, or every re-render leaks a copy of the file into the tab.
 */
export async function ltBlobUrl(path) {
  const headers = {};
  const t = token();
  if (t) headers.Authorization = `Bearer ${t}`;
  const res = await fetch(path, { method: 'GET', headers, credentials: 'same-origin' });
  if (!res.ok) {
    let data = null;
    try { data = await res.json(); } catch { /* the status is enough */ }
    const err = new Error(messageFor(res.status, data));
    err.status = res.status;
    throw err;
  }
  return URL.createObjectURL(await res.blob());
}

/**
 * UPLOAD A DOCUMENT, AND SHOW THE BAR WHILE IT GOES.
 *
 * THE ASK (owner-reported 2026-08-23 on the short-term side, and now true here):
 * *"the second you upload a document, while the system is working to upload, it
 * already has the document over there with a bar and a percentage. You should see
 * that the system is actually doing work for you."*
 *
 * TWO THINGS MAKE THAT POSSIBLE AND NEITHER IS OPTIONAL:
 *
 *   · XMLHttpRequest, NOT fetch. `fetch()`'s promise settles when the RESPONSE
 *     arrives and there is no event in between for "42% of the request body has
 *     been sent", so a surface that wanted a bar had no number to put in it.
 *     `xhr.upload.onprogress` is the only browser API that reports bytes sent.
 *
 *   · The progress is PUBLISHED into the shared store the shared `<UploadRows/>`
 *     component reads. That store and its `uploadTarget()` are product-neutral —
 *     a row files itself under `condition:<id>` from the upload's OWN metadata —
 *     so Long-Term gets the identical row in the identical place, with no second
 *     progress mechanism to keep in step. Without it an LT upload would render
 *     NOTHING while it ran and read as "it is not uploading", which is exactly
 *     the defect the short-term side already had reported once.
 *
 * THE PERCENTAGE IS HONEST: it is the bytes of THIS REQUEST that have left the
 * machine. The body is JSON carrying base64, so what goes on the wire is about a
 * third larger than the file — the row therefore reports the REQUEST's own size
 * rather than the file's, because a percentage of a number we are not sending is
 * the kind of small lie a progress bar cannot afford.
 */
export function ltUpload(path, body) {
  const meta = body || {};
  const filename = meta.filename || 'file';
  const payload = JSON.stringify(meta);
  /* A DOM string is UTF-16 and the wire is UTF-8. Blob is the browser's own
     answer to "how many bytes is this really"; without it a filename carrying an
     accent makes every percentage slightly wrong. */
  let size = payload.length;
  try { size = new Blob([payload]).size; } catch { /* the length is a fair estimate */ }

  const rowId = up.startUpload({ target: up.uploadTarget(meta), filename, size });

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', path, true);
    xhr.setRequestHeader('Content-Type', 'application/json');
    const t = token();
    if (t) xhr.setRequestHeader('Authorization', `Bearer ${t}`);
    xhr.responseType = 'text';

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) up.updateUpload(rowId, { loaded: e.loaded, total: e.total });
    };
    // The body is out; from here the server is storing it and we are waiting.
    xhr.upload.onload = () => up.finishSending(rowId);

    xhr.onload = () => {
      let data = null;
      try { data = JSON.parse(xhr.responseText); } catch { /* an empty or non-JSON body is fine */ }
      if (xhr.status >= 200 && xhr.status < 300) { up.completeUpload(rowId); resolve(data); return; }
      const err = new Error(messageFor(xhr.status, data));
      err.status = xhr.status;
      err.data = data;
      up.failUpload(rowId, err.message);
      reject(err);
    };
    /* A dropped connection, a timeout and an abort are three different things to
       the person watching, and one wording for all three is what makes a system
       feel broken. Say which it was. */
    const fail = (message) => { up.failUpload(rowId, message); reject(new Error(message)); };
    xhr.onerror = () => fail('The connection dropped while uploading. Check your connection and try again.');
    xhr.ontimeout = () => fail('The upload timed out. Try again, or try a smaller file.');
    xhr.onabort = () => fail('Upload cancelled.');

    xhr.send(payload);
  });
}

/**
 * Fetch a document as BYTES, for an in-place preview.
 *
 * `ltBlobUrl` above hands back an object URL, which is what an `<img src>` wants;
 * the shared preview wants the blob ITSELF so it can decide by TYPE what to do
 * with it (render a PDF page by page, show an image, lay out text). It also needs
 * the server's own filename, which only the response headers carry.
 */
export async function ltBlob(path) {
  const headers = {};
  const t = token();
  if (t) headers.Authorization = `Bearer ${t}`;
  const res = await fetch(path, { method: 'GET', headers, credentials: 'same-origin' });
  if (!res.ok) {
    let data = null;
    try { data = await res.json(); } catch { /* the status is enough */ }
    const err = new Error(messageFor(res.status, data));
    err.status = res.status;
    throw err;
  }
  return {
    blob: await res.blob(),
    filename: filenameFromDisposition(res.headers.get('content-disposition')),
  };
}

/** The name the server gave the file, read off its Content-Disposition. */
function filenameFromDisposition(value) {
  const s = String(value || '');
  // RFC 5987 first — it is the form that survives a non-ASCII filename.
  const star = /filename\*=(?:UTF-8'')?([^;]+)/i.exec(s);
  if (star) {
    try { return decodeURIComponent(star[1].replace(/^"|"$/g, '')); } catch { /* fall through */ }
  }
  const plain = /filename="?([^";]+)"?/i.exec(s);
  return plain ? plain[1] : '';
}

export const ltGet = (p) => ltFetch('GET', p);
export const ltPost = (p, b) => ltFetch('POST', p, b);
export const ltPut = (p, b) => ltFetch('PUT', p, b);
export const ltPatch = (p, b) => ltFetch('PATCH', p, b);
export const ltDel = (p) => ltFetch('DELETE', p);
