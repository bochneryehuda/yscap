#!/usr/bin/env node
/* =====================================================================
   LOAN-OFFICER BRANDING BAR — where it mounts (web/brand.js + web/v2/brand.js)
   ---------------------------------------------------------------------
   Owner-reported 2026-08-03: "when a loan officer clicks on his personal LO
   link, every page of the marketing website gets branded to him with a header
   on top. Only the HOMEPAGE does not."

   ROOT CAUSE: injectBar() anchored on `.topbar` and otherwise fell back to the
   top of <body>. The home page (and the legal pages) have NO .topbar — their
   header is `.nav`, which is `position:fixed`. A fixed header is out of the
   document flow and PAINTS OVER the top of <body>, so the fallback put the bar
   underneath an opaque nav where nobody could ever see it. Nothing errored;
   the bar was in the DOM the whole time.

   THE CLASS, and why this test is pure: "insert it at the top of the page" is
   only true for a header that is IN THE FLOW. Whenever an element has to sit
   next to a page's header, the header's `position` decides where it can go —
   and a fixed header can only carry it by HOLDING it. A test that merely
   asserted "#loBar exists in the DOM" passed all along, so this asserts WHERE
   it landed. The end-to-end proof (nothing paints over it, the page content
   still clears the taller header, no sideways scroll) is done in a real
   browser; CI has no browser, so this pins the placement decision itself.

   No DB, no network, no browser — brand.js is run under a minimal fake DOM.
   ===================================================================== */
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const COPIES = ["web/brand.js", "web/v2/brand.js"].map((p) =>
  path.join(__dirname, "..", p)
);

let failures = 0;
function ok(cond, label) {
  if (!cond) failures++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
}
// DOM nodes are circular (child.parentNode), so JSON.stringify would throw and
// turn a clean FAIL into a crash. Describe an element by what it IS instead.
function show(v) {
  if (v && typeof v === "object" && typeof v.tagName === "string") {
    return `<${v.tagName.toLowerCase()}${v.id ? ` id=${v.id}` : ""}${v.className ? ` class="${v.className}"` : ""}>`;
  }
  try { return JSON.stringify(v); } catch (e) { return String(v); }
}
function eq(actual, expected, label) {
  ok(actual === expected, `${label}${actual === expected ? "" : ` (got ${show(actual)}, want ${show(expected)})`}`);
}

/* ---------------- the smallest DOM brand.js can run against -------------- */

function makeEl(tag, className) {
  const el = {
    tagName: String(tag).toUpperCase(),
    className: className || "",
    id: "",
    innerHTML: "",
    style: {},
    children: [],
    parentNode: null,
    offsetHeight: 0,
    _attrs: {},
    get firstElementChild() { return this.children[0] || null; },
    get firstChild() { return this.children[0] || null; },
    get nextSibling() {
      if (!this.parentNode) return null;
      const sibs = this.parentNode.children;
      return sibs[sibs.indexOf(this) + 1] || null;
    },
    insertBefore(node, ref) {
      const i = ref ? this.children.indexOf(ref) : -1;
      if (i < 0) this.children.push(node);
      else this.children.splice(i, 0, node);
      node.parentNode = this;
      return node;
    },
    appendChild(node) { return this.insertBefore(node, null); },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    addEventListener() {},
    setAttribute(k, v) { this._attrs[k] = v; },
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(this._attrs, k) ? this._attrs[k] : null; },
    classList: { add() {}, remove() {} },
  };
  return el;
}

/* headerKind: 'topbar' | 'fixed' | 'sticky' | 'none'
   barHeight:  what the injected bar measures once laid out. */
function runBrand(src, { search, headerKind, barHeight = 54, bodyPad = "0px", scrollPad = "96px" }) {
  const html = makeEl("html");
  const body = makeEl("body");
  const existingBodyChild = makeEl("main");
  body.appendChild(existingBodyChild);

  let header = null;
  if (headerKind !== "none") {
    header = makeEl("header", headerKind === "topbar" ? "topbar" : "nav");
    header.appendChild(makeEl("div", "nav-inner"));   // the nav row
    header.appendChild(makeEl("div", "nav-mobile"));  // the mobile menu, after it
    if (headerKind === "topbar") body.insertBefore(header, body.firstChild);
  }

  const anchors = [
    Object.assign(makeEl("a"), { _attrs: { href: "suite.html" } }),
    Object.assign(makeEl("a"), { _attrs: { href: "suite.html?lo=solomon" } }),
    Object.assign(makeEl("a"), { _attrs: { href: "https://example.com/x" } }),
  ];

  const position =
    headerKind === "fixed" ? "fixed" : headerKind === "sticky" ? "sticky" : "static";

  const document = {
    readyState: "complete",
    documentElement: html,
    body,
    createElement: (t) => makeEl(t),
    getElementById: () => null,
    addEventListener() {},
    querySelector(sel) {
      if (sel === ".topbar") return headerKind === "topbar" ? header : null;
      return null; // ".team .team-grid" — no home-page card grid in this fixture
    },
    querySelectorAll(sel) {
      if (sel === "a[href]") return anchors;
      if (sel === "header, .nav, .site-header") return header ? [header] : [];
      return [];
    },
  };

  const listeners = [];
  const sandbox = {
    document,
    location: { search },
    URLSearchParams,
    console,
    window: null,
  };
  sandbox.window = {
    document,
    location: sandbox.location,
    addEventListener: (t, fn) => listeners.push([t, fn]),
    getComputedStyle(el) {
      if (el === body) return { position: "static", paddingTop: bodyPad, scrollPaddingTop: "auto" };
      if (el === html) return { position: "static", paddingTop: "0px", scrollPaddingTop: scrollPad };
      return { position: el === header ? position : "static", paddingTop: "0px", scrollPaddingTop: "auto" };
    },
    // no ResizeObserver on purpose: brand.js must not depend on it
  };
  sandbox.globalThis = sandbox;

  vm.createContext(sandbox);
  // The bar is measured the moment it is in the tree, so give any element the
  // test's height once it has been given the lo-bar class.
  const origCreate = document.createElement;
  document.createElement = (t) => {
    const el = origCreate(t);
    Object.defineProperty(el, "offsetHeight", {
      get() { return /(^|\s)lo-bar(\s|$)/.test(this.className) ? barHeight : 0; },
    });
    return el;
  };

  vm.runInContext(src, sandbox, { filename: "brand.js" });

  const findBar = (node) => {
    for (const c of node.children) {
      if (c.id === "loBar") return c;
      const hit = findBar(c);
      if (hit) return hit;
    }
    return null;
  };
  const bar = findBar(body) || (header ? findBar(header) : null);
  return { bar, header, body, html, anchors, YSBrand: sandbox.window.YSBrand, listeners };
}

/* ------------------------------------ tests ----------------------------- */

for (const file of COPIES) {
  const src = fs.readFileSync(file, "utf8");
  const label = path.relative(path.join(__dirname, ".."), file);
  console.log(`\n=== ${label} ===`);

  // (1) THE REPORTED BUG: fixed header, no .topbar (the home page).
  {
    const r = runBrand(src, { search: "?lo=mendelb", headerKind: "fixed", barHeight: 54 });
    ok(!!r.bar, "fixed header — the bar is injected");
    eq(r.bar && r.bar.parentNode, r.header, "fixed header — the bar is mounted INSIDE the header (not under it)");
    ok(r.bar && r.body.children.indexOf(r.bar) === -1, "fixed header — the bar is NOT a child of <body> (that is where it used to hide)");
    eq(r.header && r.header.children.indexOf(r.bar), 1, "fixed header — the bar sits under the nav row, above the mobile menu");
    ok(/lo-bar-fixed/.test(r.bar.className), "fixed header — carries the .lo-bar-fixed hook");
    eq(r.body.style.paddingTop, "54px", "fixed header — <body> is pushed down by the height the bar added");
    eq(r.html.style.scrollPaddingTop, "150px", "fixed header — #anchors land below the taller header (96 + 54)");
  }

  // (2) A phone wraps the bar onto two lines — the offset is MEASURED, never
  //     a hard-coded constant.
  {
    const r = runBrand(src, { search: "?lo=mendelb", headerKind: "fixed", barHeight: 87 });
    eq(r.body.style.paddingTop, "87px", "fixed header — the offset follows the bar's real height");
    eq(r.html.style.scrollPaddingTop, "183px", "fixed header — scroll padding follows it too");
  }

  // (3) A page with no scroll-padding of its own must not inherit a phantom one.
  {
    const r = runBrand(src, { search: "?lo=mendelb", headerKind: "fixed", barHeight: 54, scrollPad: "auto" });
    eq(r.html.style.scrollPaddingTop, "54px", "fixed header — scrollPaddingTop:auto counts as 0, never NaN");
  }

  // (4) UNCHANGED: the tools' static .topbar still anchors the bar after it.
  {
    const r = runBrand(src, { search: "?lo=mendelb", headerKind: "topbar" });
    eq(r.bar && r.bar.parentNode, r.body, "topbar — the bar stays in the flow next to it");
    eq(r.body.children.indexOf(r.bar), 1, "topbar — the bar goes directly AFTER the topbar");
    eq(r.body.style.paddingTop, undefined, "topbar — no offset is applied (the header is in the flow)");
  }

  // (5) UNCHANGED: a sticky header does not overlay its own initial position,
  //     so the top of <body> is still the right place.
  {
    const r = runBrand(src, { search: "?lo=mendelb", headerKind: "sticky" });
    eq(r.bar && r.bar.parentNode, r.body, "sticky header — the bar goes at the top of <body>");
    eq(r.body.children.indexOf(r.bar), 0, "sticky header — the bar is the first thing on the page");
    eq(r.body.style.paddingTop, undefined, "sticky header — no offset is applied");
  }

  // (6) No ?lo= is the plain company site: no bar, nothing moved.
  {
    const r = runBrand(src, { search: "", headerKind: "fixed" });
    ok(!r.bar, "no ?lo= — no officer bar anywhere");
    eq(r.body.style.paddingTop, undefined, "no ?lo= — the page is not shifted");
    eq(r.anchors[0].getAttribute("href"), "suite.html", "no ?lo= — links are left alone");
  }

  // (7) An unknown ?lo= code brands nobody (the roster is the allowlist).
  {
    const r = runBrand(src, { search: "?lo=notarealofficer", headerKind: "fixed" });
    ok(!r.bar, "unknown ?lo= code — no bar is injected");
  }

  // (8) An href that ALREADY names an officer wins. The home page builds each
  //     team card as `suite.html?lo=<that officer>`; stamping the current
  //     officer over them pointed every card at the same person.
  {
    const r = runBrand(src, { search: "?lo=mendelb", headerKind: "fixed" });
    eq(r.anchors[0].getAttribute("href"), "suite.html?lo=mendelb", "link() stamps ?lo= on a plain internal link");
    eq(r.anchors[1].getAttribute("href"), "suite.html?lo=solomon", "link() PRESERVES an href that already names another officer");
    eq(r.anchors[2].getAttribute("href"), "https://example.com/x", "link() leaves an absolute URL alone");
    eq(r.YSBrand.link("#faq"), "#faq", "link() leaves a bare hash alone");
    eq(r.YSBrand.link("tools/a.html#x"), "tools/a.html?lo=mendelb#x", "link() keeps the hash on the end");
  }
}

/* The two copies are the same file; a fix applied to one only would put the
   V1 site back where it started. */
{
  const [v1, v2] = COPIES.map((f) => fs.readFileSync(f, "utf8"));
  ok(v1 === v2, "\nweb/brand.js and web/v2/brand.js are still identical");
}

console.log(failures ? `\n${failures} FAILURE(S)` : "\nlo-branding-bar: all good");
process.exit(failures ? 1 : 0);
