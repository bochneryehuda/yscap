/**
 * PILOT'S OWN MESSAGE BOX — never the browser's.
 *
 * WHY THIS EXISTS (owner-reported 2026-08-06, with the screenshot). Clicking
 * Sign off on a credit condition that is not ready produced a dialog titled
 * **"yscap.onrender.com says"** — the browser's native `alert()`, which stamps
 * the ORIGIN HOSTNAME on the message and cannot be styled. So PILOT's own
 * refusal, carefully worded in plain English, was presented to the team as if
 * it came from a hosting provider they have never heard of. The owner: "the
 * error message is coming from OnRender.com. We need to update the branding. It
 * should come directly from our system whenever you have an error message."
 *
 * THE SHAPE. `alert()` and `confirm()` are SYNCHRONOUS and block the page, so a
 * drop-in replacement cannot be — this returns a PROMISE instead. That is safe
 * for the ~60 call sites we migrate because every one of them either ends its
 * handler or `return`s immediately after; nothing reads a value back from an
 * alert. A confirm DOES read a value back, so those sites must `await` — which
 * is why `confirm()` here is deliberately opt-in rather than a blanket
 * find-and-replace (a `window.confirm` swapped in without an `await` reads as
 * "the user said yes" on EVERY click, which would fire destructive actions
 * nobody agreed to).
 *
 * FALLS BACK TO THE BROWSER — deliberately. If no host is mounted (a screen
 * rendered outside the app shell, an error thrown before the tree mounts) the
 * native dialog is used instead. An ugly message the user can read beats a
 * beautiful one that never appears: a swallowed error is strictly worse than an
 * unbranded one, and this file must never be the reason someone misses a
 * refusal.
 */

let seq = 0;
let host = null;                 // the mounted <AppDialogHost/>'s setter
const pending = [];              // requests waiting for a host / for their turn

function flush() {
  if (host && pending.length) host(pending[0]);
}

/** The host subscribes on mount; returns its unsubscribe. */
export function subscribeDialog(fn) {
  host = fn;
  flush();
  return () => { host = null; };
}

/** The host calls this when the top request is answered. */
export function resolveTop(value) {
  const req = pending.shift();
  if (req) req.resolve(value);
  if (host) host(pending[0] || null);
}

function push(req) {
  return new Promise((resolve) => {
    // NO HOST → the browser's dialog, right now. Never queue a message nobody
    // will ever see (see the fallback note above).
    if (!host) {
      if (req.kind === 'confirm') { resolve(window.confirm(dialogText(req))); return; }
      if (req.kind === 'prompt') {
        // window.prompt's own two-valued answer is preserved exactly: a string
        // (possibly empty) when they typed, null when they cancelled.
        resolve(window.prompt(dialogText(req), req.defaultValue == null ? '' : String(req.defaultValue)));
        return;
      }
      window.alert(dialogText(req));
      resolve(undefined);
      return;
    }
    pending.push({ ...req, id: ++seq, resolve });
    flush();
  });
}

/* What the NATIVE fallback shows — title and body together, since a native
   dialog has no title of its own (its title is the hostname, which is the whole
   problem we are working around). */
function dialogText(req) {
  return req.title ? `${req.title}\n\n${req.message}` : req.message;
}

/**
 * Show a message. Returns a promise that settles when it is dismissed; callers
 * that just want it on screen can ignore it.
 * @param {string} message
 * @param {{title?:string, tone?:'error'|'info'}} [opts]
 */
export function showMessage(message, opts = {}) {
  return push({ kind: 'alert', message: String(message == null ? '' : message), ...opts });
}

/** Ask a yes/no question. MUST be awaited — see the note above. */
export function askConfirm(message, opts = {}) {
  return push({ kind: 'confirm', message: String(message == null ? '' : message), ...opts });
}

/**
 * Ask for a line of text. MUST be awaited, for the same reason `askConfirm`
 * must — an un-awaited call hands back a Promise, and every caller here reads
 * the answer.
 *
 * THE RETURN CONTRACT IS `window.prompt`'s, EXACTLY, and it is two-valued on
 * purpose: a STRING (possibly `''`) when they typed and submitted, and `null`
 * when they CANCELLED. Call sites in this app genuinely depend on the
 * difference — several read `if (x == null) return;` (they backed out, say
 * nothing) and then separately `if (!x.trim()) setErr('Add a short reason')`
 * (they submitted nothing, so tell them). Collapsing the two into `''` would
 * silently turn "changed my mind" into an error message, and collapsing them
 * into `null` would drop a deliberate empty answer.
 *
 * @param {string} message
 * @param {{title?:string, defaultValue?:string, placeholder?:string,
 *          confirmLabel?:string, cancelLabel?:string, multiline?:boolean}} [opts]
 * @returns {Promise<string|null>}
 */
export function askPrompt(message, opts = {}) {
  return push({ kind: 'prompt', message: String(message == null ? '' : message), ...opts });
}

export const _internals = { dialogText };
