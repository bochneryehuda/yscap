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
/**
 * WHAT THE SERVER CALLED THE FILE — its `Content-Disposition`, or null.
 *
 * ⛔ THE SERVER IS THE AUTHORITY ON A DOCUMENT'S NAME, AND THE CALLER'S IS ONLY A
 * FALLBACK (owner-reported 2026-08-31: *"the comparison, when you want to export
 * it, is basically issued and downloaded as the term sheet. It needs to be called
 * the comparison sheet."*).
 *
 * That was fixed on the SERVER — the term-sheet PDF route names the file from
 * `snapshot.KIND_WORDS`, so a comparison leaves as `comparison-sheet-TS-XXXXXX.pdf`
 * — and the fix could not be seen, because `a.download` OVERRIDES the header and
 * the one caller passed a hard-coded `term-sheet-${code}.pdf`. So a comparison
 * still landed in the officer's downloads named as a term sheet, which is the one
 * thing it must not be mistaken for: a comparison offers several options and
 * commits to none. Reading the header here fixes it for every download through
 * this function, present and future, and keeps the naming rule in the ONE place
 * that knows what kind of document it just drew.
 *
 * ⛔ IT IS SANITISED EVEN THOUGH WE SEND IT. A filename reaches the file system:
 * path separators and control characters are stripped and a leading dot is
 * refused, so a header that is ever wrong cannot become a path.
 */
export function filenameFromDisposition(header) {
  const h = typeof header === 'string' ? header : '';
  if (!h) return null;
  // RFC 5987 first — `filename*=UTF-8''name.pdf` wins over the plain form when
  // both are present, because it is the one that can carry a non-ASCII name.
  let raw = null;
  const ext = /filename\*\s*=\s*([^;]+)/i.exec(h);
  if (ext) {
    const v = ext[1].trim();
    const parts = v.split("'");
    const tail = parts.length >= 3 ? parts.slice(2).join("'") : v;
    try { raw = decodeURIComponent(tail); } catch { raw = tail; }
  }
  if (!raw) {
    // NOT named `plain`: `format.js` exports a formatter by that name and every
    // long-term module is swept for a local that shadows one.
    const quoted = /filename\s*=\s*("([^"]*)"|[^;]+)/i.exec(h);
    if (quoted) raw = (quoted[2] !== undefined ? quoted[2] : quoted[1]).trim();
  }
  if (!raw) return null;
  const clean = String(raw)
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .replace(/[\\/]/g, '')
    .trim();
  if (!clean || clean === '.' || clean === '..' || clean.startsWith('.')) return null;
  return clean.slice(0, 200);
}

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
    // The server's own name wins; the caller's is what to fall back to when
    // there is no header (or it cannot be read).
    a.download = filenameFromDisposition(res.headers.get('Content-Disposition')) || filename;
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

export const ltGet = (p) => ltFetch('GET', p);
export const ltPost = (p, b) => ltFetch('POST', p, b);
export const ltPut = (p, b) => ltFetch('PUT', p, b);
export const ltPatch = (p, b) => ltFetch('PATCH', p, b);
export const ltDel = (p) => ltFetch('DELETE', p);
