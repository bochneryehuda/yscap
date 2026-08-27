/**
 * THE PRICING ENGINE'S INVESTOR FILTER — the pure rules (owner-directed 2026-08-27).
 *
 * ⛔ A DISPLAY OVERLAY, NEVER A SEARCH INPUT. The owner's words: *"This should
 * all be on overlays on top of Lender Price … You should just hide the rest of
 * the data that you're getting and only display the data that the person wants
 * to see."* So everything here runs on the ANSWER — the search always asks for
 * everything, and nothing in this module can reach the wire: it takes parsed
 * programs and a selection, and answers which rows to draw.
 *
 * ⛔ NOTHING IS SILENTLY DROPPED. A filtered board must SAY it is filtered and
 * how much it is hiding, and a selected investor that returned nothing on this
 * scenario is NAMED ("CorrFirst returned nothing here") rather than silently
 * absent — the owner's own example: an investor not yet live in Lender Price is
 * on the pre-search list, and after the results it must not pretend to be a row.
 *
 * ⛔ WHY A PLAIN `.js` MODULE: same reason as priceBuild.js — a rule inside the
 * screen is a rule CI cannot run, and no CI job installs the front end's build
 * tools. `scripts/test-lt-investor-filter-pure.mjs` imports this directly.
 *
 * The selection is a Set of CANONICAL investor keys (the server resolves every
 * vendor spelling to one key and annotates each program with `investorKey`).
 * `null` — or an empty Set — means ALL investors: the screen's default, and the
 * state the one-press "Show all" returns to.
 */

/** Is the overlay actually narrowing anything? */
export function selectionActive(sel) {
  return !!(sel && sel.size > 0);
}

/**
 * The programs to DRAW. With no selection the answer is the input, untouched —
 * byte-for-byte, so the unfiltered board cannot drift. With one, a program is
 * kept when its `investorKey` is selected; a program the server could not
 * resolve (`investorKey` null — a brand-new lender nobody has mapped) is KEPT
 * whatever the selection, because hiding a row nobody chose to hide is the
 * silent-drop this engine exists not to do. Returns `{ programs, hidden,
 * total }` — `hidden` is what the overlay is holding back, for the screen to
 * say out loud.
 */
export function filterPrograms(programs, sel) {
  const list = Array.isArray(programs) ? programs : [];
  if (!selectionActive(sel)) return { programs: list, hidden: 0, total: list.length };
  const kept = list.filter((p) => !p || p.investorKey == null || sel.has(p.investorKey));
  return { programs: kept, hidden: list.length - kept.length, total: list.length };
}

/**
 * The ineligible board's lender groups, same rule, same shape of answer.
 * (The server annotates each group with `investorKey` too.)
 */
export function filterDisqualifiedLenders(lenders, sel) {
  const list = Array.isArray(lenders) ? lenders : [];
  if (!selectionActive(sel)) return { lenders: list, hidden: 0, total: list.length };
  const kept = list.filter((g) => !g || g.investorKey == null || sel.has(g.investorKey));
  return { lenders: kept, hidden: list.length - kept.length, total: list.length };
}

/** Toggle one key. Returns a NEW Set — state must never be mutated in place. */
export function toggleKey(sel, key) {
  const next = new Set(sel || []);
  if (next.has(key)) next.delete(key); else next.add(key);
  return next;
}

/**
 * The selected investors that are NOT in this answer, with the names to say it
 * with. `roster` is the answer's own investor roster (what populated);
 * `fullRoster` is the whole white-label sheet (what the names mean). An
 * investor selected and absent is a FACT worth a sentence — "their product
 * didn't populate" — never a silent nothing.
 */
export function missingFromAnswer(sel, roster, fullRoster) {
  if (!selectionActive(sel)) return [];
  const present = new Set((Array.isArray(roster) ? roster : []).map((r) => r && r.key).filter(Boolean));
  const nameOf = new Map((Array.isArray(fullRoster) ? fullRoster : [])
    .map((r) => [r && r.key, r]).filter(([k]) => k));
  return [...sel].filter((k) => !present.has(k)).map((k) => {
    const hit = nameOf.get(k);
    return { key: k, whiteLabel: (hit && hit.whiteLabel) || k, investorLabel: (hit && hit.investorLabel) || k };
  }).sort((a, b) => a.whiteLabel.localeCompare(b.whiteLabel));
}

/**
 * One sentence for the strip: what the overlay is doing. Always says DISPLAY
 * ONLY when narrowing — the reader must never wonder whether the search was
 * narrowed, because it never is.
 */
export function overlaySummary(sel, hidden) {
  if (!selectionActive(sel)) return null;
  const n = sel.size;
  const h = Number.isFinite(hidden) ? hidden : 0;
  return `Showing ${n} ${n === 1 ? 'investor' : 'investors'} — display only`
    + (h > 0 ? ` (${h} ${h === 1 ? 'programme' : 'programmes'} hidden; Lender Price was asked for everything)` : '');
}

/**
 * Every key a Set of rate-row keys should hold for EXPAND ALL, plus every
 * lender-group key with more than one programme — "every section should expand
 * to its max" (owner-directed 2026-08-27). `groupByLender` is handed in rather
 * than imported so this module keeps zero dependencies and the caller decides
 * which grouping the board actually uses.
 */
export function expandAllKeys(rates, groupByLender) {
  const rateKeys = [];
  const lenderKeys = [];
  for (const row of Array.isArray(rates) ? rates : []) {
    if (!row || row.key == null) continue;
    rateKeys.push(row.key);
    if (typeof groupByLender !== 'function') continue;
    for (const g of groupByLender(row.quotes || [])) {
      if (g && g.programCount > 1) lenderKeys.push(`${row.key}|${g.key}`);
    }
  }
  return { rateKeys, lenderKeys };
}
