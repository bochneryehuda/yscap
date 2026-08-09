#!/usr/bin/env node
/* =====================================================================
   TERM SHEET PDFs — a value must fit its slot, and never be lost silently
   ---------------------------------------------------------------------
   Owner-directed 2026-08-03, in the same pass as the Scope of Work address
   overlap. Two term-sheet surfaces wrapped a value to its slot and then drew
   only the FIRST wrapped line:

     · the proof-of-funds letter's "SUMMARY OF INDICATIVE TERMS" box
       (its "Property" row), and
     · the pricing-derivation page's key/value sections
       (their "Property" row).

   So a property line longer than its slot lost its city / state / ZIP, with
   NOTHING on the page to show that anything had been dropped. Ordinary
   addresses fit, so this never misfired in practice — but a proof-of-funds
   letter goes to a seller, and a half address on one is worse than a wrapped
   one.

   SAME FAMILY as the Scope of Work bug (a value that does not fit its slot),
   DIFFERENT symptom: there the tail was painted over the neighbouring box,
   here it was dropped. Both come from the same missing idea — a fixed slot
   has to be able to GROW, or the value has to be visibly truncated.

   THE RULE UNDER TEST (fitSlotLines): break at the FIRST comma (the street /
   city-state-ZIP seam) after shrinking a half point at a time, cap at TWO
   lines because both surfaces are fixed-height pages, and ellipsis-clamp
   past that so a truncation is at least VISIBLE. Critically: a value that
   ALREADY FITS must come back unchanged at its original size, so every term
   sheet that lays out correctly today is unchanged.

   PURE: no DB, no network, no browser. Loads the SAME vendored jsPDF the
   browser tools use, so the widths asserted here are the widths the real
   export measures.
   ===================================================================== */
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const COPIES = ["web/v2/tools/termsheet.js", "web/tools/termsheet.js"];

// The two real slots, with the page geometry each surface actually uses.
const SLOTS = [
  // proof-of-funds box: M=54, boxW = W-2M, value budget = boxW - 26 - 200
  { name: "proof-of-funds summary box", maxW: (612 - 2 * 54) - 26 - 200, size: 8.5, minSize: 7.5 },
  // derivation page: M=56, budget = (W-2M) * 0.56
  { name: "derivation page section", maxW: (612 - 2 * 56) * 0.56, size: 8.9, minSize: 7.5 },
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

function loadJsPDF() {
  const mod = require(path.join(ROOT, "web", "tools", "vendor", "jspdf.umd.min.js"));
  const jsPDF = (mod && typeof mod.jsPDF === "function") ? mod.jsPDF : (global.jspdf && global.jspdf.jsPDF);
  if (typeof jsPDF !== "function") throw new Error("vendored jsPDF did not load");
  return jsPDF;
}

function extractFn(src, name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`${name}() not found — did the fix get reverted?`);
  let depth = 0;
  const open = src.indexOf("{", start);
  if (open < 0) throw new Error(`${name}() has no body`);
  for (let j = open; j < src.length; j++) {
    if (src[j] === "{") depth++;
    else if (src[j] === "}") { depth--; if (depth === 0) return src.slice(start, j + 1); }
  }
  throw new Error(`${name}() body never closes`);
}

function compileFn(source, name) {
  const ctx = vm.createContext({});
  vm.runInContext(`${source}; this.__fn = ${name};`, ctx);
  return ctx.__fn;
}

/* ------------------------------ the battery ----------------------------- */

// Real property lines, in the shape the PoF letter and the derivation page
// build them ("<address>, <ST>"). The long ones are what used to lose a tail.
const PROPERTY_LINES = [
  "3091 Patricia Court, Manchester Township, NJ 08759, NJ",
  "1727 South Second Street, Piscataway Township, NJ 08854, NJ",
  "5701 15th Avenue Apartment 4D, Brooklyn, NY 11219, NY",
  "62 Highland Street, Wethersfield, CT 06109, CT",
  "A residential investment property to be identified",
  "129 Carlisle St, Wilkes-Barre, PA 18702, PA",
  // These slots are far roomier than the Scope of Work column (~278pt vs
  // ~154pt), so an ordinary address never tripped this — which is why it went
  // unnoticed. These are the lengths that DID lose their tail: a long street
  // with a unit, and a hyphenated / multi-word municipality.
  "1200 Northwest Kensington Boulevard Apartment 12B, Croton-on-Hudson, NY 10520, NY",
  "18 Saint Andrews Country Club Drive, Hasbrouck Heights Township, NJ 07604, NJ",
];
// Values that already fit — these must come back BYTE-FOR-BYTE unchanged, at
// full size, on one line. This is the "no existing term sheet moves" promise.
const FITTING = [
  "$1,250,000", "12 months, interest-only", "Purchase  ·  Fix & Flip",
  "Gold Standard Program", "Not provided", "—", "",
  "Rothschild Holdings LLC",
];


/* ------- the recipient block's ONE-LINE property + expiry (2026-08-09) ------
   "Property: <address>   .   Valid through <date>", drawn at M=40 on Letter so
   the whole width of the page is the slot (532pt), helvetica normal 8pt. It is
   ONE baseline that cannot stack (the "Prepared by" block sits 10.5pt under
   it), so the answer here is to shorten the ADDRESS and keep the head and the
   expiry WHOLE. It takes roughly a 90-character address to overflow, which is
   why nobody had hit it — but nothing capped it either, so a long one ran off
   the edge of the page with no warning. */
const ONE_LINE = {
  maxW: 612 - 2 * 40, size: 8,
  head: "Property: ",
  tail: "   \u00b7   Valid through Aug 9, 2026",
};
const ONE_LINE_ADDRESSES = [
  "3091 Patricia Court, Manchester Township, NJ 08759, NJ",
  "1727 South Second Street, Piscataway Township, NJ 08854, NJ",
  "5701 15th Avenue Apartment 4D, Brooklyn, NY 11219, NY",
  "18 Saint Andrews Country Club Drive, Hasbrouck Heights Township, NJ 07604, NJ",
  "1200 Northwest Kensington Boulevard Apartment 12B, Croton-on-Hudson, NY 10520, NY",
  // These two DO overflow 532pt. The first is rescued by dropping the ZIP
  // alone; the second needs the ladder to keep dropping trailing parts.
  "1200 Northwest Kensington Boulevard Apartment 12B, Croton-on-Hudson-upon-Thames Township, NY 10520-4417, NY",
  "8875 Southwest Commonwealth Preservation Parkway Building C Suite 1400, Rancho Santa Margarita Township, CA 92688-3312, CA",
];

const jsPDF = loadJsPDF();
let firstSource = null;
let firstOneSource = null;

for (const rel of COPIES) {
  console.log(`\n=== ${rel} ===`);
  const src = fs.readFileSync(path.join(ROOT, rel), "utf8");

  // (0) SOURCE GUARD: the draw-only-the-first-line pattern must be gone. This
  //     is the actual defect; a helper that exists but is not wired up would
  //     otherwise pass every assertion below.
  ok(!/doc\.text\(\s*vlines\[0\]/.test(src), "no surface draws only the first wrapped line any more");

  /* (0b) THE PDF ENGINE COMES FROM OUR OWN SERVER FIRST.
     Owner-directed 2026-08-03. Both loaders reached for a CDN and NOTHING
     ELSE, so a jsdelivr/unpkg outage — or an officer whose corporate network
     blocks public file hosts — lost the term sheet PDF, the proof-of-funds
     letter AND the Excel export at once, on a browser already talking to us.
     The vendored copies had been sitting in tools/vendor/ the whole time and
     the Scope of Work / Track Record tools always tried them first.
     Asserted at SOURCE level because CI has no browser; the end-to-end proof
     (both documents generating with cdn.jsdelivr and unpkg BLOCKED, no
     injection) is a headless-Chromium run. */
  for (const [fn, local] of [["ensurePDF", "vendor/jspdf.umd.min.js"], ["ensureXLSX", "vendor/xlsx.bundle.js"]]) {
    let body = "";
    try { body = extractFn(src, fn); } catch (e) { ok(false, `${fn}() is present: ${e.message}`); continue; }
    const srcs = [...body.matchAll(/"([^"]*(?:vendor\/|cdn\.jsdelivr|unpkg)[^"]*)"/g)].map(m => m[1]);
    ok(srcs.length >= 2, `${fn}() lists a local copy AND a fallback (${srcs.length} sources)`);
    eq(srcs[0], local, `${fn}() tries OUR OWN copy first`);
    ok(srcs.slice(1).some(s => /^https:/.test(s)), `${fn}() keeps an outside host as the backup`);
    // The vendored file must actually be there, in BOTH trees, or "local first"
    // silently costs a wasted request on every export and changes nothing.
    const dir = path.dirname(path.join(ROOT, rel));
    ok(fs.existsSync(path.join(dir, local)), `${local} exists beside ${path.basename(rel)}`);
  }
  // A source that loads but defines nothing must fall through to the next one —
  // otherwise a stale/blank vendored file would break exports permanently.
  ok(/if \(ready\(\)\) return;/.test(extractFn(src, "loadFirst")), "loadFirst() only stops once the library is really there");

  let fnSource;
  try { fnSource = extractFn(src, "fitSlotLines"); }
  catch (e) { ok(false, `fitSlotLines() is present: ${e.message}`); continue; }

  if (firstSource === null) firstSource = fnSource;
  else ok(fnSource === firstSource, "fitSlotLines() is byte-identical to the other copy");

  const fit = compileFn(fnSource, "fitSlotLines");
  const doc = new jsPDF({ unit: "pt", format: "letter", orientation: "portrait" });
  const widthOf = (line, size) => { doc.setFont("helvetica", "bold"); doc.setFontSize(size); return doc.getTextWidth(line); };

  for (const slot of SLOTS) {
    console.log(`  -- ${slot.name} (${slot.maxW.toFixed(1)}pt, ${slot.size}→${slot.minSize}pt) --`);
    const run = (v) => fit(doc, v, slot.maxW, "helvetica", "bold", slot.size, slot.minSize, 2);

    // (1) A value that already fits is UNTOUCHED — same text, same size, one
    //     line. Every term sheet that is correct today stays exactly as it is.
    for (const v of FITTING) {
      const r = run(v);
      ok(r.lines.length === 1 && r.lines[0] === v && r.fs === slot.size,
        `"${v || "(empty)"}" is untouched (one line, ${slot.size}pt, verbatim)`);
    }

    // (2) THE BUG: no property line may lose text, and none may be drawn past
    //     the slot. "Nothing lost" is the whole point — the old code dropped
    //     everything after the first wrapped line.
    let widest = 0, widestOf = "";
    for (const v of PROPERTY_LINES) {
      const r = run(v);
      // The comma AT THE BREAK is consumed by the line break — standard
      // address typography, and what the Scope of Work fix does too. So this
      // compares the words, which is the thing that must never be lost.
      const words = (s) => s.replace(/[,\s]+/g, " ").trim();
      ok(words(r.lines.join(" ")) === words(v), `"${v.slice(0, 40)}…" keeps every word`);
      ok(r.lines.length <= 2, `"${v.slice(0, 40)}…" uses at most two lines`);
      for (const line of r.lines) {
        const w = widthOf(line, r.fs);
        if (w > widest) { widest = w; widestOf = line; }
      }
    }
    ok(widest <= slot.maxW + 0.01, `nothing is drawn past the slot (widest ${widest.toFixed(1)}pt of ${slot.maxW.toFixed(1)}pt — "${widestOf}")`);

    // (3) THE BATTERY MUST ACTUALLY REACH THE BUG. These slots are wide, so a
    //     battery of ordinary addresses would pass every assertion above
    //     without a single one ever wrapping — proving nothing. Find the lines
    //     that genuinely overflow on one line, and assert there IS one.
    const overflowing = PROPERTY_LINES.filter(v => widthOf(v, slot.size) > slot.maxW);
    ok(overflowing.length > 0, `the battery contains a line that really overflows this slot (${overflowing.length} of ${PROPERTY_LINES.length})`);

    // (4) Such a line stacks at its FIRST comma — street on line one, the
    //     city / state / ZIP on line two — and keeps every word.
    for (const v of overflowing) {
      const r = run(v);
      const street = v.slice(0, v.indexOf(",")).trim();
      eq(r.lines.length, 2, `"${v.slice(0, 34)}…" is laid out on TWO lines`);
      eq(r.lines[0], street, `"${v.slice(0, 34)}…" puts the street on line one`);
      ok(r.lines[1].startsWith(v.slice(v.indexOf(",") + 1).trim().split(",")[0]),
        `"${v.slice(0, 34)}…" starts line two with the city`);
    }
    // A line that ALREADY fits is never split, comma or not.
    for (const v of PROPERTY_LINES.filter(x => widthOf(x, slot.size) <= slot.maxW)) {
      eq(run(v).lines.length, 1, `"${v.slice(0, 34)}…" fits, so it is not split needlessly`);
    }

    // (4) A value with no comma and no space cannot be stacked, so it must be
    //     ellipsis-clamped — VISIBLY truncated, never silently dropped.
    const runOn = fit(doc, "X".repeat(400), slot.maxW, "helvetica", "bold", slot.size, slot.minSize, 2);
    ok(runOn.lines.length <= 2, "a pathological run is capped at two lines");
    ok(runOn.lines.every(l => widthOf(l, runOn.fs) <= slot.maxW + 0.01), "a pathological run stays inside the slot");
    ok(runOn.lines[runOn.lines.length - 1].endsWith("..."), "a truncation is VISIBLE (ends in an ellipsis)");

    // (6) PROVE THE OLD BEHAVIOR WAS WRONG. Run the exact code that shipped
    //     before — wrap to the slot, draw only line 0 — and show it really did
    //     drop text. This is what makes the test a regression guard rather
    //     than a description of the new code.
    for (const v of overflowing) {
      doc.setFont("helvetica", "bold"); doc.setFontSize(slot.size);
      const oldFirstLineOnly = doc.splitTextToSize(v, slot.maxW)[0] || "";
      ok(oldFirstLineOnly !== v && v.startsWith(oldFirstLineOnly.trim().slice(0, 10)),
        `the OLD code dropped the tail of "${v.slice(0, 34)}…" (it drew only "${oldFirstLineOnly.slice(0, 40)}…")`);
    }
  }

  /* =====================================================================
     THE RECIPIENT BLOCK'S PROPERTY + EXPIRY LINE (fitOneLine)
     The last unbounded value on the term sheet. Unlike the two slots above
     it cannot stack, so the rule is different: shorten the ADDRESS and keep
     the head and the "Valid through" tail WHOLE, because the expiry is the
     legally meaningful half of that sentence.
     ===================================================================== */
  console.log(`  -- recipient block property line (${ONE_LINE.maxW}pt, ${ONE_LINE.size}pt) --`);
  let oneSource;
  try { oneSource = extractFn(src, "fitOneLine"); }
  catch (e) { ok(false, `fitOneLine() is present: ${e.message}`); continue; }
  if (firstOneSource === null) firstOneSource = oneSource;
  else ok(oneSource === firstOneSource, "fitOneLine() is byte-identical to the other copy");

  // It must actually be WIRED UP — a helper nobody calls fixes nothing, and
  // the old unbounded concatenation must be gone.
  // Escaping differs between the two copies (V1 spells the middot \\u00b7, V2
  // uses the character), so this matches on the words and asserts that EVERY
  // draw of the expiry line goes through the helper.
  const expiryDraws = src.split("\n").filter(l => /doc\.text\(/.test(l) && /Valid through/.test(l));
  ok(expiryDraws.length > 0, "the recipient block still draws the property + expiry line");
  ok(expiryDraws.every(l => /fitOneLine\(/.test(l)), "every draw of that line goes through fitOneLine()");

  const one = compileFn(oneSource, "fitOneLine");
  const oneDoc = new jsPDF({ unit: "pt", format: "letter", orientation: "portrait" });
  const oneW = (line) => { oneDoc.setFont("helvetica", "normal"); oneDoc.setFontSize(ONE_LINE.size); return oneDoc.getTextWidth(line); };
  const runOne = (addr) => one(oneDoc, ONE_LINE.head, addr, ONE_LINE.tail, ONE_LINE.maxW, "helvetica", "normal", ONE_LINE.size);

  // (A) THE BATTERY MUST REACH THE BUG — it takes a ~90-character address, so
  //     a battery of ordinary ones would prove nothing.
  const oneOverflow = ONE_LINE_ADDRESSES.filter(a => oneW(ONE_LINE.head + a + ONE_LINE.tail) > ONE_LINE.maxW);
  ok(oneOverflow.length > 0, `the battery contains an address that really runs off the page (${oneOverflow.length} of ${ONE_LINE_ADDRESSES.length})`);

  for (const addr of ONE_LINE_ADDRESSES) {
    const out = runOne(addr);
    const fits = oneW(ONE_LINE.head + addr + ONE_LINE.tail) <= ONE_LINE.maxW;
    // (B) NOTHING is drawn past the page.
    ok(oneW(out) <= ONE_LINE.maxW + 0.01, `"${addr.slice(0, 34)}…" stays inside the page (${oneW(out).toFixed(1)}pt of ${ONE_LINE.maxW}pt)`);
    // (C) The head and the expiry ALWAYS survive whole — only the address may
    //     be shortened. This is the promise the whole helper exists to keep.
    ok(out.startsWith(ONE_LINE.head), `"${addr.slice(0, 34)}…" keeps the "Property:" label`);
    ok(out.endsWith(ONE_LINE.tail), `"${addr.slice(0, 34)}…" keeps the "Valid through" date`);
    // (D) An address that already fits is BYTE-FOR-BYTE unchanged, so every
    //     term sheet that lays out correctly today is untouched.
    if (fits) eq(out, ONE_LINE.head + addr + ONE_LINE.tail, `"${addr.slice(0, 34)}…" fits, so it is verbatim`);
    // (E) An address that does NOT fit is shortened from the END — the street
    //     number and street name, the part that identifies the property, are
    //     never the first thing lost.
    else ok(out.indexOf(addr.split(",")[0].trim()) === ONE_LINE.head.length,
      `"${addr.slice(0, 34)}…" keeps the street whole and shortens from the end`);
  }

  // (F) THE ZIP GOES FIRST. An address that overflows by only a little is
  //     rescued by dropping the ZIP alone, so the city and state survive —
  //     the same ladder the e-sign subject shortener uses.
  const zipCase = "1200 Northwest Kensington Boulevard Apartment 12B, Croton-on-Hudson-upon-Thames Township, NY 10520-4417, NY";
  const zipOut = runOne(zipCase);
  ok(oneW(ONE_LINE.head + zipCase + ONE_LINE.tail) > ONE_LINE.maxW, "the ZIP case really does overflow to begin with");
  ok(!/10520-4417/.test(zipOut), "the ZIP is the first thing dropped");
  ok(/Croton-on-Hudson-upon-Thames Township/.test(zipOut), "the city survives the ZIP being dropped");

  // (G) THE addrTBD SHAPE — no address at all — is untouched.
  eq(one(oneDoc, "Property: To be determined", "", ONE_LINE.tail, ONE_LINE.maxW, "helvetica", "normal", ONE_LINE.size),
    "Property: To be determined" + ONE_LINE.tail, "a to-be-determined property line is unchanged");

  // (H) A pathological unbreakable run cannot be laddered, so it must be
  //     VISIBLY clamped — never allowed to run off the page in silence.
  const runOnOne = runOne("X".repeat(400));
  ok(oneW(runOnOne) <= ONE_LINE.maxW + 0.01, "a pathological address stays inside the page");
  ok(/\.\.\./.test(runOnOne), "a pathological address is VISIBLY truncated");
  ok(runOnOne.endsWith(ONE_LINE.tail), "a pathological address still keeps the expiry date");

  // (I) PROVE THE OLD BEHAVIOR WAS WRONG — the plain concatenation the code
  //     used to draw really did run past the edge of the page.
  for (const addr of oneOverflow) {
    ok(oneW(ONE_LINE.head + addr + ONE_LINE.tail) > ONE_LINE.maxW,
      `the OLD code ran "${addr.slice(0, 34)}…" off the page (${oneW(ONE_LINE.head + addr + ONE_LINE.tail).toFixed(1)}pt of ${ONE_LINE.maxW}pt)`);
  }
}

console.log(`\n${failures ? `FAILED (${failures})` : "ALL PASS"}`);
process.exit(failures ? 1 : 0);
