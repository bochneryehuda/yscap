/* DRAG A FILE ONTO A TOOL PAGE — one definition for all four tools.
 *
 * Owner-directed (item 6, 2026-08-21): *"A lot of the uploads are missing the drag and drop option.
 * You can only click and upload… Please dig in."* And, on this exact control (2026-08-18):
 * *"Everywhere in our system drag-and-drop works — that button should too."*
 *
 * THE WHOLE PAGE IS THE TARGET. A 40px "Import ⤒" button is a needle to hit with a file in hand,
 * and every one of these pages does ONE import, so there is nothing to disambiguate.
 *
 * IT FEEDS THE PAGE'S OWN FILE INPUT RATHER THAN ITS IMPORT FUNCTION. Each tool already has a
 * working import path hanging off a hidden `<input type="file">` — an inline `onchange` on three of
 * them, an `addEventListener` on the fourth. Assigning the dropped file to that input and firing its
 * `change` event runs the EXACT path the button runs, so a dropped file and a picked file can never
 * behave differently, and not one line of any tool's own logic is touched (which matters most on the
 * term sheet, whose file carries frozen pricing code that must not be edited for a UI convenience).
 *
 * IT IS WIRED BY AN ATTRIBUTE ON THAT INPUT, NOT BY A CALL PER PAGE — `data-ys-drop`. Two things
 * fall out of that and both are the point: WHICH FILES THE PAGE TAKES is read from the input's own
 * `accept` attribute, so the drop and the file picker can never disagree about what is allowed; and
 * a page adopts this by touching the markup it already has, with no inline script to keep in step.
 *
 * TWO OF THESE INPUTS ON ONE PAGE IS REFUSED, LOUDLY, rather than guessed at. The whole page is the
 * target, so with two importers there is no answer to "which one did they mean" — and feeding the
 * wrong one would silently overwrite the work on the screen. A page that genuinely needs two needs a
 * per-zone decision, not a coin toss.
 *
 * THREE THINGS THAT LOOK OPTIONAL AND ARE NOT:
 *   · `dragover` MUST preventDefault, or the browser NAVIGATES to the dropped file and the page —
 *     with everything typed into it — is gone. That is the owner's "it will close your file,
 *     explode it".
 *   · `dragleave` only clears the highlight when the pointer actually left the WINDOW
 *     (`relatedTarget === null`); child-to-child moves fire it constantly and would flicker.
 *   · a file dragged out of Outlook arrives in `dataTransfer.items`, not `.files` — and on Windows
 *     an Outlook attachment is not a file on disk at all, so `getAsFile()` hands back nothing (or a
 *     0-byte File) and only `getAsFileSystemHandle()` reaches its bytes. Reading `.files` alone
 *     silently ignores the commonest real-world drag in this office. Everything must be read off the
 *     event SYNCHRONOUSLY — a DataTransfer is emptied the moment the handler returns — so the handles
 *     are collected first and only then awaited.
 *
 * A DROP THAT PRODUCED NOTHING SAYS SO. An Outlook drag that yields no bytes is exactly the case a
 * silent handler makes unreportable ("I dropped it and nothing happened"), so it falls back to the
 * same plain-language guidance the portal gives, through the tools' own `alert` convention.
 *
 * THE SECOND READER IN THIS FOLDER IS DELIBERATE, NOT A DUPLICATE. `track-record-portal.js`
 * `readDroppedFiles` answers a DIFFERENT question — every DOCUMENT dropped on one track-record line,
 * many files, each kept — while this answers "the ONE spreadsheet this page imports". They share the
 * Outlook handling because the browser API is the same; if a third reader is ever needed, fold it
 * into one of these two rather than writing a third.
 *
 * No dependencies, no build step, and it never throws: a page that includes it and marks nothing
 * behaves exactly as it did.
 */
(function () {
  'use strict';

  var DEFAULT_CLASS = 'ys-dropping';
  var wiredClasses = {};   // one <style> per highlight class, however many times wire() is called
  var wiredPage = false;   // the listeners are on `document`, so they go on ONCE

  /** The dropped file, from either place a browser can put it. */
  function droppedFile(e) {
    var dt = e && e.dataTransfer;
    if (!dt) return null;
    if (dt.files && dt.files.length) return dt.files[0];
    if (dt.items && dt.items.length) {
      for (var i = 0; i < dt.items.length; i++) {
        var it = dt.items[i];
        if (it && it.kind === 'file' && it.getAsFile) {
          var f = it.getAsFile();
          if (f) return f;
        }
      }
    }
    return null;
  }

  /** Real bytes, not a 0-byte placeholder standing in for an Outlook attachment. */
  function usable(f) { return !!(f && f.name && Number(f.size) > 0); }

  /* Did they drop a FILE, or drag some selected text / a link across the page? Only a file drop that
     came up empty is worth telling somebody about — complaining at a stray text drag would train
     people to dismiss the one notice that matters. */
  function looksLikeFileDrop(e) {
    var dt = e && e.dataTransfer;
    if (!dt) return false;
    try {
      var types = dt.types ? Array.prototype.slice.call(dt.types) : [];
      if (types.indexOf('Files') >= 0) return true;
    } catch (err) { /* fall through to the item/file test */ }
    try { if (dt.files && dt.files.length) return true; } catch (err) { /* ignore */ }
    try {
      var list = dt.items || [];
      for (var i = 0; i < list.length; i++) if (list[i] && list[i].kind === 'file') return true;
    } catch (err) { /* ignore */ }
    return false;
  }

  /**
   * The dropped file, INCLUDING one dragged straight out of the Outlook desktop app.
   *
   * Reads everything it needs off the event synchronously (the DataTransfer is emptied the moment
   * this returns) and only then awaits the File System Access handles. Resolves to null when the
   * drop produced no bytes at all — which the caller reports rather than swallows.
   */
  function droppedFileAsync(e) {
    var dt = e && e.dataTransfer;
    if (!dt) return Promise.resolve(null);

    var direct = null;
    try { if (dt.files && dt.files.length) direct = dt.files[0]; } catch (err) { direct = null; }

    var items = [];
    try {
      var list = dt.items || [];
      for (var i = 0; i < list.length; i++) {
        if (list[i] && list[i].kind === 'file') items.push(list[i]);
      }
    } catch (err) { items = []; }

    var plain = null;
    for (var j = 0; j < items.length && !plain; j++) {
      try { plain = items[j].getAsFile ? items[j].getAsFile() : null; } catch (err) { plain = null; }
    }
    var handles = items.map(function (it) {
      try {
        return typeof it.getAsFileSystemHandle === 'function' ? it.getAsFileSystemHandle() : null;
      } catch (err) { return null; }
    });

    if (usable(direct)) return Promise.resolve(direct);
    if (usable(plain)) return Promise.resolve(plain);
    if (!handles.some(Boolean)) return Promise.resolve(null);

    return Promise.all(handles.map(function (p) {
      return p && typeof p.then === 'function'
        ? p.then(function (h) {
            return h && h.kind === 'file' && typeof h.getFile === 'function' ? h.getFile() : null;
          }).catch(function () { return null; })
        : Promise.resolve(null);
    })).then(function (files) {
      for (var k = 0; k < files.length; k++) if (usable(files[k])) return files[k];
      return null;
    }).catch(function () { return null; });
  }

  /** Does this file look like the thing the page imports? An empty list accepts anything. */
  function accepted(file, exts) {
    if (!exts || !exts.length) return true;
    var name = String((file && file.name) || '').toLowerCase();
    for (var i = 0; i < exts.length; i++) {
      var ext = String(exts[i]).trim().toLowerCase();
      if (!ext) continue;
      if (name.slice(-ext.length) === ext) return true;
    }
    return false;
  }

  /** The input's own `accept` (".xlsx,.xls") — so the drop and the file picker can never disagree. */
  function acceptFromInput(input) {
    var raw = input && input.getAttribute ? input.getAttribute('accept') : '';
    return String(raw || '').split(',')
      .map(function (s) { return s.trim(); })
      .filter(function (s) { return s.charAt(0) === '.'; });   // a MIME type is not a filename test
  }

  /** The halo + the "drop it here" pill, for a page that has not styled the state itself. */
  function ensureStyle(cls, hint) {
    if (!hint || wiredClasses[cls]) return;
    wiredClasses[cls] = true;
    try {
      var css = 'body.' + cls + '{outline:3px dashed #2F7F86;outline-offset:-6px}'
        + 'body.' + cls + '::after{content:"' + String(hint).replace(/["\\]/g, '') + '";'
        /* BOTTOM, not top: every one of these pages has its action buttons (Share link, Export,
           Import) pinned to a sticky header, and a pill at the top of the viewport lands on top
           of them — found by RENDERING it, not by reading it. The foot of the window is clear on
           all four. */
        + 'position:fixed;left:50%;bottom:24px;transform:translateX(-50%);background:#2F7F86;color:#fff;'
        + 'font-weight:700;padding:8px 18px;border-radius:999px;z-index:9999;pointer-events:none;font-size:14px}';
      var el = document.createElement('style');
      el.setAttribute('data-ys-drop-style', cls);
      el.appendChild(document.createTextNode(css));
      (document.head || document.documentElement).appendChild(el);
    } catch (err) { /* styling is a nicety; the drop itself must still work */ }
  }

  /* The wording the track-record portal already gives for this exact case — one phrasing for a
     failed drag across the whole site, so a user who meets it twice is told the same thing. */
  var NO_BYTES = "That didn't come through as a file. Drag it to your desktop first, then drop it "
    + 'here — or use the upload button.';

  /** "…imports .xlsx files." — named from the input's OWN accept, so it can never misquote it. */
  function wrongTypeMessage(exts) {
    var list = (exts || []).join(' or ');
    return list
      ? 'That file type is not what this page imports — drop a ' + list + ' file, '
        + 'or use the upload button.'
      : 'That did not come through as a file this page can import.';
  }

  /** Never silent: a drop that produced nothing is said out loud, the way these tools say things. */
  function report(o, message) {
    try {
      if (typeof o.onProblem === 'function') { o.onProblem(message); return; }
      if (typeof window.alert === 'function') window.alert(message);
    } catch (err) { /* a failed notice must not throw out of an event handler */ }
    if (window.console && console.warn) console.warn('[ys-drop] ' + message);
  }

  /**
   * Wire the page.
   *
   * @param {object} opts
   *   - input     {string|Element}  the hidden file input the button already uses (id or node)
   *   - accept    {string[]}        extensions to accept; defaults to the input's own `accept`
   *   - className {string}          class put on <body> while a drag is over the page
   *   - hint      {string}          text for the drop pill; omit when the page styles the state
   *   - onFile    {function}        OPTIONAL — called instead of the input when a page has no input
   *   - onProblem {function}        OPTIONAL — how to tell the user a drop produced no bytes
   */
  function wire(opts) {
    var o = opts || {};
    var cls = o.className || DEFAULT_CLASS;

    function resolveInput() {
      if (!o.input) return null;
      return typeof o.input === 'string' ? document.getElementById(o.input) : o.input;
    }

    var exts = o.accept || acceptFromInput(resolveInput());
    ensureStyle(cls, o.hint);

    function hand(file) {
      if (!file) return;
      if (!accepted(file, exts)) { report(o, wrongTypeMessage(exts)); return; }
      if (typeof o.onFile === 'function') { o.onFile(file); return; }
      var input = resolveInput();
      if (!input) return;
      /* Hand it to the page's OWN input so the existing change handler runs. A DataTransfer is
         the only way to set `input.files`; where the browser refuses (older Safari), fall back to
         `onFile` if the caller gave one — never silently do nothing. */
      try {
        var dt = new DataTransfer();
        dt.items.add(file);
        input.files = dt.files;
        input.dispatchEvent(new Event('change', { bubbles: true }));
      } catch (err) {
        if (typeof o.onFile === 'function') o.onFile(file);
      }
    }

    if (wiredPage) return;   // the listeners live on `document`; binding twice would double-import
    wiredPage = true;

    ['dragenter', 'dragover'].forEach(function (ev) {
      document.addEventListener(ev, function (e) {
        e.preventDefault(); e.stopPropagation();
        document.body.classList.add(cls);
      });
    });
    document.addEventListener('dragleave', function (e) {
      e.preventDefault(); e.stopPropagation();
      if (!e.relatedTarget) document.body.classList.remove(cls);
    });
    document.addEventListener('drop', function (e) {
      e.preventDefault(); e.stopPropagation();
      document.body.classList.remove(cls);
      /* preventDefault FIRST and the event read synchronously inside droppedFileAsync — awaiting
         before either of those loses the file (and lets the browser navigate away from the page). */
      var wasFileDrop = looksLikeFileDrop(e);
      droppedFileAsync(e).then(function (file) {
        if (file) { hand(file); return; }
        if (wasFileDrop) report(o, NO_BYTES);
      });
    });
  }

  /** Wire whatever the page marked with `data-ys-drop`. Exactly one, or nothing. */
  function autoWire(root) {
    var doc = root || document;
    var marked;
    try { marked = doc.querySelectorAll('[data-ys-drop]'); } catch (err) { return null; }
    if (!marked || !marked.length) return null;
    if (marked.length > 1) {
      // Ambiguous by construction — the whole page is the target, so two importers have no answer.
      if (window.console && console.warn) {
        console.warn('[ys-drop] ' + marked.length + ' elements carry data-ys-drop; drag-and-drop is off '
          + 'because a dropped file cannot be aimed at one of them.');
      }
      return null;
    }
    var input = marked[0];
    wire({
      input: input,
      className: input.getAttribute('data-ys-drop-class') || DEFAULT_CLASS,
      hint: input.getAttribute('data-ys-drop-hint') || '',
    });
    return input;
  }

  function onReady(fn) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn);
    else fn();
  }
  onReady(function () { try { autoWire(); } catch (err) { /* never break a tool page */ } });

  window.YSDropImport = {
    wire: wire, autoWire: autoWire,
    droppedFile: droppedFile, droppedFileAsync: droppedFileAsync,
    accepted: accepted, acceptFromInput: acceptFromInput,
    looksLikeFileDrop: looksLikeFileDrop, wrongTypeMessage: wrongTypeMessage, NO_BYTES: NO_BYTES,
  };
}());
