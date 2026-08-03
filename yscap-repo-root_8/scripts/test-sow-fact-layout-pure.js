#!/usr/bin/env node
/* =====================================================================
   SCOPE OF WORK PDF — the property address must stay inside its column
   ---------------------------------------------------------------------
   Owner-reported 2026-08-03 (906284e0 / 3091 Patricia Court, Manchester
   Township): on the exported Scope of Work the property address ran across
   the divider and was drawn ON TOP of the TRANSACTION fact next to it.

   ROOT CAUSE: the property-summary panel shrank a fact value to fit its
   column and then, at the shrink FLOOR, drew it as ONE unbounded line. Text
   drawn past its column does not wrap, error or clip — jsPDF just paints it,
   so a long value silently overwrote its neighbour. Confirmed in the reported
   PDF: the address is drawn at x=56 at 8pt while the next fact starts at
   x=232, and the string is ~220pt wide.

   THE CLASS: a shrink-to-fit with a floor is not a fit. Whenever a value is
   drawn into a fixed slot, the slot has to be able to GROW (stack the value)
   or the value has to be truncated — a floor alone leaves the overflow armed
   for the next slightly-longer input.

   This is a PURE test: no DB, no network, no browser. It loads the SAME
   vendored jsPDF the browser tools use, extracts fitFactValue() out of each
   tool copy and measures its output with the real font metrics, so the widths
   asserted here are the widths the real export measures.
   ===================================================================== */
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const COPIES = [
  // [tool file, font, style, max size, min size, column width used by that copy]
  ["web/v2/tools/rehab-budget.js", "times", "bold", 11.5, 9, (612 - 84) / 3 - 14 - 8],
  ["web/tools/rehab-budget.js", "helvetica", "bold", 10.5, 8, (612 - 84) / 3 - 10],
];

let failures = 0;
function ok(cond, label) {
  if (!cond) failures++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
}
function eq(actual, expected, label) {
  const same = actual === expected;
  if (!same) failures++;
  console.log(`${same ? "PASS" : "FAIL"}  ${label}${same ? "" : ` (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`}`);
}

/* ---------------- the real jsPDF the browser tools load ------------------ */

function loadJsPDF() {
  const abs = path.join(ROOT, "web", "tools", "vendor", "jspdf.umd.min.js");
  const mod = require(abs);
  const jsPDF = (mod && typeof mod.jsPDF === "function") ? mod.jsPDF : (global.jspdf && global.jspdf.jsPDF);
  if (typeof jsPDF !== "function") throw new Error("vendored jsPDF did not load");
  return jsPDF;
}

/* ------- pull fitFactValue() out of a tool file (balanced braces) --------
   The function is deliberately identical in both copies, so extracting it by
   name also lets us assert the two have not drifted apart.                 */
function extractFn(src, name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`${name}() not found — did the fix get reverted?`);
  let depth = 0, i = src.indexOf("{", start);
  if (i < 0) throw new Error(`${name}() has no body`);
  for (let j = i; j < src.length; j++) {
    const ch = src[j];
    if (ch === "{") depth++;
    else if (ch === "}") { depth--; if (depth === 0) return src.slice(start, j + 1); }
  }
  throw new Error(`${name}() body never closes`);
}

function compileFn(source) {
  const ctx = vm.createContext({});
  vm.runInContext(`${source}; this.__fn = ${"fitFactValue"};`, ctx);
  return ctx.__fn;
}

/* ------------------------------ the battery ----------------------------- */

// The owner's real address, plus the shapes that used to overflow with it.
const ADDRESSES = [
  "3091 Patricia Court, Manchester Township, NJ 08759",   // the reported one
  "62 Highland Street, Wethersfield, CT 06109",
  "1727 South Second Street, Piscataway Township, NJ 08854",
  "5701 15th Avenue Apartment 4D, Brooklyn, NY 11219",
  "129 Carlisle St, Wilkes-Barre, PA 18702",
  "26 S 10th St, Brooklyn, NY 11249",
  "1 Elm St, Rye, NY 10580",                              // short: must stay one line
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", // unbreakable run
  "",                                                     // empty
  "—",                                               // the "no value" em-dash
];
const OTHER_FACTS = ["Purchase", "Refinance", "Single-family", "4-unit multifamily",
  "Moderate rehab", "Ground-up construction", "12 months", "$203,700", "—"];

const jsPDF = loadJsPDF();
let firstSource = null;

for (const [rel, font, style, maxSize, minSize, maxW] of COPIES) {
  console.log(`\n--- ${rel} (${font} ${style}, ${maxSize}→${minSize}pt, column ${maxW.toFixed(1)}pt) ---`);
  const src = fs.readFileSync(path.join(ROOT, rel), "utf8");

  let fnSource;
  try { fnSource = extractFn(src, "fitFactValue"); }
  catch (e) { ok(false, `fitFactValue() is present: ${e.message}`); continue; }

  // Both copies must carry the SAME rule — a drift here is how the two PDFs
  // start disagreeing about where an address breaks.
  if (firstSource === null) firstSource = fnSource;
  else ok(fnSource === firstSource, "fitFactValue() is byte-identical to the other copy");

  const fit = compileFn(fnSource);
  const doc = new jsPDF({ unit: "pt", format: "letter", orientation: "portrait" });
  const widthOf = (line, size) => { doc.setFont(font, style); doc.setFontSize(size); return doc.getTextWidth(line); };

  // (1) THE BUG: nothing may ever be drawn wider than its own column.
  let widest = 0, widestOf = "";
  for (const val of ADDRESSES.concat(OTHER_FACTS)) {
    const r = fit(doc, val, maxW, font, style, maxSize, minSize);
    for (const line of r.lines) {
      const w = widthOf(line, r.fs);
      if (w > widest) { widest = w; widestOf = `${val} → "${line}"`; }
    }
    ok(r.fs <= maxSize && r.fs >= minSize, `"${val.slice(0, 34)}" sizes within ${minSize}–${maxSize}pt (${r.fs}pt)`);
  }
  ok(widest <= maxW + 0.01, `no value is drawn past its column (widest ${widest.toFixed(1)}pt of ${maxW.toFixed(1)}pt — ${widestOf})`);

  // (2) The reported address stacks street / city-state-ZIP, at the comma.
  const rep = fit(doc, ADDRESSES[0], maxW, font, style, maxSize, minSize);
  eq(rep.lines.length, 2, "the reported address is laid out on TWO lines");
  eq(rep.lines[0], "3091 Patricia Court", "line one is the street");
  eq(rep.lines[1], "Manchester Township, NJ 08759", "line two is the city, state and ZIP");

  // (3) It used to overflow: prove the single-line form really is too wide,
  //     so this test would have caught the reported bug.
  ok(widthOf(ADDRESSES[0], minSize) > maxW,
    `the address on one line overflows even at the ${minSize}pt floor (${widthOf(ADDRESSES[0], minSize).toFixed(1)}pt) — the old behavior`);

  // (4) A value that fits is untouched: one line, full size, same text.
  const short = fit(doc, "Purchase", maxW, font, style, maxSize, minSize);
  eq(short.lines.length, 1, "a short value stays on one line");
  eq(short.fs, maxSize, "a short value keeps the full font size");
  eq(short.lines[0], "Purchase", "a short value is drawn verbatim");

  // (5) A short address that fits must NOT be split just because it has a comma.
  const tiny = fit(doc, "1 Elm St, Rye, NY 10580", maxW, font, style, maxSize, minSize);
  eq(tiny.lines.length, 1, "a short address is not split needlessly");

  // (6) A run with no comma and no space still has to fit. jsPDF hard-breaks
  //     it across lines, so nothing is lost; the ellipsis clamp in the helper
  //     is the last-resort guard for anything it cannot break.
  const runOn = fit(doc, ADDRESSES[7], maxW, font, style, maxSize, minSize);
  ok(runOn.lines.every(l => widthOf(l, runOn.fs) <= maxW + 0.01), "an unbreakable run stays inside the column");
  ok(runOn.lines.length > 1, "an unbreakable run is wrapped onto several lines");
  eq(runOn.lines.join(""), ADDRESSES[7], "wrapping an unbreakable run loses no characters");

  // (7) Empty / em-dash values are left alone (they are the “no value” form).
  eq(fit(doc, "", maxW, font, style, maxSize, minSize).lines.join(""), "", "an empty value stays empty");
  eq(fit(doc, "—", maxW, font, style, maxSize, minSize).lines.length, 1, "the em-dash placeholder stays one line");
}

console.log(`\n${failures ? `FAILED (${failures})` : "ALL PASS"}`);
process.exit(failures ? 1 : 0);
