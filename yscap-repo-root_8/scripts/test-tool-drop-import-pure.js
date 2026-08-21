#!/usr/bin/env node
/* =====================================================================
   DRAG A FILE ONTO A TOOL PAGE — web/v2/tools/drop-import.js
   ---------------------------------------------------------------------
   Owner-directed 2026-08-21 (item 6): *"A lot of the uploads are missing the
   drag and drop option. You can only click and upload… Please dig in."*  And,
   on this exact control (2026-08-18): *"Everywhere in our system drag-and-drop
   works — that button should too."*

   The four Investor-Suite tools each import ONE spreadsheet through a hidden
   `<input type="file">`. Three of them were click-only; the fourth (the rehab
   budget) had its own private copy of the drop handling. This pins the shared
   module that now serves all four, and the wiring on each page.

   WHY A PURE TEST. Two of the three things that can go wrong here are silent:
   a page that simply forgets the script tag still LOOKS finished, and a drop
   handler that omits `preventDefault` on `dragover` is invisible until a user
   drops a file and the browser NAVIGATES AWAY — the owner's *"it will close
   your file, explode it"*. Neither shows up in a screenshot. CI has no
   browser, so the module runs here under a minimal fake DOM and the page
   wiring is read out of the HTML.

   Run: node scripts/test-tool-drop-import-pure.js
   ===================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const TOOLS = path.join(__dirname, '..', 'web', 'v2', 'tools');
const MODULE_PATH = path.join(TOOLS, 'drop-import.js');
const SRC = fs.readFileSync(MODULE_PATH, 'utf8');

let pass = 0, fail = 0;
const ok = (label, cond) => { if (cond) pass++; else { fail++; console.log(`FAIL ${label}`); } };
const eq = (label, got, want) => {
  const same = JSON.stringify(got) === JSON.stringify(want);
  if (same) pass++;
  else { fail++; console.log(`FAIL ${label}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`); }
};
const read = (p) => fs.readFileSync(path.join(TOOLS, p), 'utf8');

/* ------------------------------------------------------------------ *
 * The smallest DOM the module can run against.                        *
 * ------------------------------------------------------------------ */
function makeDom() {
  const listeners = {};
  const bodyClasses = new Set();
  const styles = [];

  function el(tag) {
    return {
      tagName: String(tag).toUpperCase(),
      _attrs: {},
      _children: [],
      files: null,
      events: [],
      setAttribute(k, v) { this._attrs[k] = String(v); },
      getAttribute(k) { return Object.prototype.hasOwnProperty.call(this._attrs, k) ? this._attrs[k] : null; },
      appendChild(n) { this._children.push(n); return n; },
      addEventListener() {},
      dispatchEvent(ev) { this.events.push(ev); return true; },
    };
  }

  const marked = [];
  const head = el('head');
  const document = {
    readyState: 'complete',
    head,
    documentElement: el('html'),
    body: {
      classList: {
        add: (c) => bodyClasses.add(c),
        remove: (c) => bodyClasses.delete(c),
        has: (c) => bodyClasses.has(c),
      },
    },
    createElement: (t) => el(t),
    createTextNode: (t) => ({ text: String(t) }),
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    querySelectorAll(sel) { return sel === '[data-ys-drop]' ? marked.slice() : []; },
    getElementById(id) { return marked.find((m) => m._attrs.id === id) || null; },
  };

  const warnings = [];
  const alerts = [];
  const sandbox = {
    document,
    window: {
      alert: (m) => alerts.push(String(m)),
      console: { warn: (m) => warnings.push(String(m)) },
    },
    console: { warn: (m) => warnings.push(String(m)) },
    Event: function Event(type, opts) { this.type = type; this.bubbles = !!(opts && opts.bubbles); },
    DataTransfer: function DataTransfer() {
      this._files = [];
      this.items = { add: (f) => this._files.push(f) };
      Object.defineProperty(this, 'files', { get: () => this._files });
    },
    Promise,
    Array,
    String,
    Number,
    setTimeout,
  };
  sandbox.window.document = document;
  sandbox.window.window = sandbox.window;
  vm.createContext(sandbox);

  return {
    sandbox, listeners, bodyClasses, warnings, alerts, marked, head, styles,
    el,
    addMarked(attrs) { const n = el('input'); Object.assign(n._attrs, attrs); marked.push(n); return n; },
    load() { vm.runInContext(SRC, sandbox, { filename: 'drop-import.js' }); return sandbox.window.YSDropImport; },
    fire(type, event) { (listeners[type] || []).forEach((fn) => fn(event)); },
  };
}

/** A drop event carrying real files. */
function fileDrop(files, opts = {}) {
  const prevented = { count: 0 };
  return {
    prevented,
    preventDefault() { prevented.count++; },
    stopPropagation() {},
    relatedTarget: opts.relatedTarget === undefined ? null : opts.relatedTarget,
    dataTransfer: {
      types: opts.types || (files.length ? ['Files'] : []),
      files: opts.noFilesList ? [] : files,
      items: (opts.items || files.map((f) => ({ kind: 'file', getAsFile: () => f }))),
    },
  };
}
const F = (name, size = 10) => ({ name, size });

/* ================================================================== *
 * A. Every tool page is wired, and wired the same way                 *
 * ================================================================== */
const PAGES = [
  { file: 'track-record.html', input: 'tr-import', accept: '.xlsx' },
  { file: 'term-sheet.html', input: 'tsImport', accept: '.xlsx,.xls' },
  { file: 'loan-application.html', input: 'app-import', accept: '.xlsx' },
  { file: 'rehab-budget.html', input: 'rb-import', accept: '.xlsx' },
];

for (const p of PAGES) {
  const html = read(p.file);
  const marks = html.match(/data-ys-drop(?![-\w])/g) || [];
  ok(`A1 ${p.file}: the import input is marked for drag-and-drop`, marks.length === 1);
  ok(`A2 ${p.file}: …and the shared module is loaded`, /<script[^>]+src="drop-import\.js\?v=/.test(html));

  // The mark must sit on the SAME input the Import button already feeds — a mark on any other
  // element would wire a page whose dropped file goes nowhere.
  const tag = (html.match(new RegExp(`<input[^>]*\\bid="${p.input}"[^>]*>`, 'i')) || [])[0] || '';
  ok(`A3 ${p.file}: the mark is on the input the button uses (#${p.input})`, /data-ys-drop(?![-\w])/.test(tag));
  ok(`A4 ${p.file}: …which states what it accepts, so the drop cannot allow more than the picker`,
    new RegExp(`accept="${p.accept.replace(/\./g, '\\.')}"`).test(tag));
}

/* The rehab budget keeps its OWN halo + wording (rehab-budget.css), so the module must be told not
   to inject a second one over it. */
{
  const html = read('rehab-budget.html');
  ok('A5 the rehab budget keeps its own drop styling', /data-ys-drop-class="rb-dropping"/.test(html));
  ok('A6 …and the CSS behind it still exists', /body\.rb-dropping/.test(read('rehab-budget.css')));
}

/* ================================================================== *
 * B. ONE definition — the private copies are gone                      *
 * ================================================================== */
{
  const rb = read('rehab-budget.js');
  ok('B1 the rehab budget no longer carries its own drop handler', !/function wireDrop\(/.test(rb));
  ok('B2 …nor its own copy of the drop reader', !/function droppedFile\(/.test(rb));
  ok('B3 …and init() no longer calls one', !/wireDrop\(\)/.test(rb));

  // Any OTHER page-level drop wiring in this folder is a second definition waiting to drift. The
  // one documented exception is the track-record portal's line-level DOCUMENT drop, which answers a
  // different question (many files, kept as documents, on ONE row).
  const EXEMPT = new Set(['drop-import.js', 'track-record-portal.js']);
  const offenders = fs.readdirSync(TOOLS)
    .filter((f) => f.endsWith('.js') && !EXEMPT.has(f))
    .filter((f) => {
      const body = fs.readFileSync(path.join(TOOLS, f), 'utf8');
      return /addEventListener\(\s*["']drop["']/.test(body) || /\.dataTransfer\b/.test(body);
    });
  eq('B4 no tool keeps a second copy of the drop handling', offenders, []);

  /* THE TWO READERS SHARE THE TRACK-RECORD PAGE, so the inner one must SWALLOW its drops. A
     per-line document zone that let the event bubble would hand the same file to BOTH: the line
     would file it as a document AND the page importer would import it, replacing the whole record
     with whatever was dropped on one row. `stopPropagation` on the card's own drop is what keeps
     them apart — a bubble-phase listener on `document` never sees it. */
  const portal = read('track-record-portal.js');
  const cardDrop = (portal.match(/\["dragleave", "drop"\][\s\S]{0,260}?\n      \}\);/) || [''])[0];
  ok('B5 a drop on a track-record line is swallowed there, never handed to the page importer too',
    /stopPropagation\(\)/.test(cardDrop));
  const cardOver = (portal.match(/\["dragenter", "dragover"\][\s\S]{0,260}?\n      \}\);/) || [''])[0];
  ok('B6 …and so is the drag over it, so the page does not also light up as a target',
    /stopPropagation\(\)/.test(cardOver));
}

/* ================================================================== *
 * C. Reading the file out of a drop event                              *
 * ================================================================== */
{
  const dom = makeDom();
  const D = dom.load();

  eq('C1 a plain drag from the desktop is read', D.droppedFile(fileDrop([F('deal.xlsx')])).name, 'deal.xlsx');

  // Outlook does not put its attachment in .files — reading only .files ignores the commonest drag
  // in this office.
  const outlookish = fileDrop([], {
    types: ['Files'],
    items: [{ kind: 'file', getAsFile: () => F('from-outlook.xlsx') }],
  });
  eq('C2 a file offered only through items[] is read', D.droppedFile(outlookish).name, 'from-outlook.xlsx');
  eq('C3 a drag with nothing in it reads as nothing', D.droppedFile(fileDrop([])), null);
  ok('C4 junk never throws', (() => {
    [undefined, null, {}, { dataTransfer: null }, { dataTransfer: {} }].forEach((e) => D.droppedFile(e));
    return true;
  })());
}

/* On Windows an Outlook attachment is a VIRTUAL file: getAsFile() hands back a 0-byte placeholder
   and only getAsFileSystemHandle() reaches the bytes. A 0-byte "file" imported as-is fails with a
   confusing error, so the handle must win. */
(async () => {
  const dom = makeDom();
  const D = dom.load();

  const placeholder = F('quote.xlsx', 0);
  const real = F('quote.xlsx', 4096);
  const ev = fileDrop([], {
    types: ['Files'],
    items: [{
      kind: 'file',
      getAsFile: () => placeholder,
      getAsFileSystemHandle: () => Promise.resolve({ kind: 'file', getFile: () => Promise.resolve(real) }),
    }],
  });
  const got = await D.droppedFileAsync(ev);
  eq('C5 a 0-byte Outlook placeholder loses to the real bytes behind it', got && got.size, 4096);

  const noHandle = fileDrop([], {
    types: ['Files'],
    items: [{ kind: 'file', getAsFile: () => placeholder }],
  });
  eq('C6 …and with no way to reach the bytes it reads as nothing, never as a 0-byte file',
    await D.droppedFileAsync(noHandle), null);

  const broken = fileDrop([], {
    types: ['Files'],
    items: [{ kind: 'file', getAsFile: () => null, getAsFileSystemHandle: () => Promise.reject(new Error('nope')) }],
  });
  eq('C7 a handle that rejects is not a crash', await D.droppedFileAsync(broken), null);

  eq('C8 a real desktop file never waits on a handle',
    (await D.droppedFileAsync(fileDrop([F('a.xlsx', 9)]))).name, 'a.xlsx');

  /* ================================================================ *
   * D. What the page accepts comes from the input itself              *
   * ================================================================ */
  ok('D1 the extension is matched however it is cased', D.accepted(F('DEAL.XLSX'), ['.xlsx']));
  ok('D2 a second allowed extension is honoured', D.accepted(F('old.xls'), ['.xlsx', '.xls']));
  ok('D3 anything else is refused', !D.accepted(F('scan.pdf'), ['.xlsx']));
  ok('D4 an empty list accepts anything', D.accepted(F('scan.pdf'), []));

  const input = { getAttribute: (k) => (k === 'accept' ? '.xlsx,.xls' : null) };
  eq('D5 the accept attribute is read off the input', D.acceptFromInput(input), ['.xlsx', '.xls']);
  const mimey = { getAttribute: () => 'application/vnd.ms-excel,.xlsx' };
  eq('D6 …and a MIME type in it is not mistaken for a filename test', D.acceptFromInput(mimey), ['.xlsx']);
  eq('D7 no accept attribute means no restriction', D.acceptFromInput({ getAttribute: () => null }), []);

  /* ================================================================ *
   * E. The page, end to end                                           *
   * ================================================================ */
  {
    const dom2 = makeDom();
    const target = dom2.addMarked({ id: 'tr-import', accept: '.xlsx', 'data-ys-drop': '', 'data-ys-drop-hint': 'Drop the Excel' });
    dom2.load();   // auto-wires on load (readyState 'complete')

    // dragover MUST preventDefault or the browser navigates to the file and the page is gone.
    const over = fileDrop([F('x.xlsx')]);
    dom2.fire('dragover', over);
    ok('E1 a drag over the page is intercepted (or the browser opens the file and the page is lost)',
      over.prevented.count === 1);
    ok('E2 …and the page shows it is a drop target', dom2.bodyClasses.has('ys-dropping'));

    // dragleave fires constantly moving between children; only leaving the WINDOW clears it.
    dom2.fire('dragleave', fileDrop([], { relatedTarget: { tagName: 'DIV' } }));
    ok('E3 moving between elements does not flicker the highlight', dom2.bodyClasses.has('ys-dropping'));
    dom2.fire('dragleave', fileDrop([], { relatedTarget: null }));
    ok('E4 …leaving the window does clear it', !dom2.bodyClasses.has('ys-dropping'));

    const drop = fileDrop([F('record.xlsx', 120)]);
    dom2.fire('drop', drop);
    ok('E5 the drop itself is intercepted', drop.prevented.count === 1);
    await Promise.resolve(); await Promise.resolve();
    eq('E6 the dropped file is handed to the page\'s own input', target.files && target.files[0].name, 'record.xlsx');
    eq('E7 …and its change event is fired, so the SAME import runs as the button', target.events.length, 1);
    eq('E8 …bubbling, because a page may listen higher up', target.events[0].bubbles, true);
    eq('E9 nothing was reported to the user on a good drop', dom2.alerts, []);
    ok('E10 the drop pill was styled for a page that asked for one',
      dom2.head._children.some((n) => n._attrs['data-ys-drop-style'] === 'ys-dropping'));
  }

  {
    const dom3 = makeDom();
    const target = dom3.addMarked({ id: 'tr-import', accept: '.xlsx', 'data-ys-drop': '' });
    dom3.load();
    dom3.fire('drop', fileDrop([F('contract.pdf', 500)]));
    await Promise.resolve(); await Promise.resolve();
    eq('E11 a file this page does not import is not fed to the importer', target.files, null);
    ok('E12 …and the user is told why, rather than nothing happening',
      dom3.alerts.length === 1 && /\.xlsx/.test(dom3.alerts[0]));
  }

  {
    const dom4 = makeDom();
    dom4.addMarked({ id: 'tr-import', accept: '.xlsx', 'data-ys-drop': '' });
    dom4.load();
    // Dragging selected text or a link across the page is not a failed import.
    dom4.fire('drop', fileDrop([], { types: ['text/plain'] }));
    await Promise.resolve(); await Promise.resolve();
    eq('E13 dragging text across the page says nothing', dom4.alerts, []);

    dom4.fire('drop', fileDrop([], { types: ['Files'] }));
    await Promise.resolve(); await Promise.resolve();
    ok('E14 …but a file drop that produced no bytes is never silent', dom4.alerts.length === 1);
  }

  {
    // Two importers on one page cannot be aimed at — the whole page is the target.
    const dom5 = makeDom();
    const a = dom5.addMarked({ id: 'one', accept: '.xlsx', 'data-ys-drop': '' });
    const b = dom5.addMarked({ id: 'two', accept: '.xlsx', 'data-ys-drop': '' });
    dom5.load();
    dom5.fire('drop', fileDrop([F('deal.xlsx', 12)]));
    await Promise.resolve(); await Promise.resolve();
    ok('E15 two marked inputs wire nothing rather than guessing', a.files === null && b.files === null);
    ok('E16 …and say so out loud', dom5.warnings.some((w) => /data-ys-drop/.test(w)));
  }

  {
    // A page that includes the module and marks nothing behaves exactly as it did.
    const dom6 = makeDom();
    dom6.load();
    eq('E17 a page that marks nothing is untouched', Object.keys(dom6.listeners), []);
  }

  {
    // The rehab budget's own styling must not be doubled up on.
    const dom7 = makeDom();
    dom7.addMarked({ id: 'rb-import', accept: '.xlsx', 'data-ys-drop': '', 'data-ys-drop-class': 'rb-dropping' });
    dom7.load();
    dom7.fire('dragover', fileDrop([F('b.xlsx')]));
    ok('E18 a page with its own halo uses its own class', dom7.bodyClasses.has('rb-dropping'));
    ok('E19 …and the module injects no styling over it', dom7.head._children.length === 0);
  }

  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
