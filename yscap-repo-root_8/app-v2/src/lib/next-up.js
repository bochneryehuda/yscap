/* The ORDERING BRAIN behind "What needs you next" (components/NextUpPanel.jsx).
 *
 * Kept out of the component and free of JSX so it can be tested directly —
 * see scripts/test-next-up-pure.js. This card is the first thing anyone sees on
 * a loan file, so "which item is at the top" is worth locking down: get it
 * wrong and the front door quietly points at the wrong work.
 *
 * It reads the payload GET /api/staff/applications/:id/gating already returns
 * and adds nothing to it. No fetch, no state, no schema.
 */

/* Rows PILOT raised are never work that holds the file (owner-directed
   2026-07-27). advancementBlockers() already separates them into `advisories`,
   and this module never looks at that array — a second lock on the same door. */

/* Sort key: what would a processor pick up first?
   overdue → a gate (it holds the file outright) → longest open → title.
   An item with no ageing data sorts last within its group rather than
   pretending to be brand new. */
function rank(row) {
  return [
    row.overdue ? 0 : 1,
    row.kind === 'gate' ? 0 : 1,
    -(Number.isFinite(row.daysOpen) ? row.daysOpen : -1),
  ];
}

export function byUrgency(a, b) {
  const ra = rank(a), rb = rank(b);
  for (let i = 0; i < ra.length; i++) if (ra[i] !== rb[i]) return ra[i] - rb[i];
  return String(a.title || '').localeCompare(String(b.title || ''));
}

/* Build the card's two groups from the gating payload.
 *
 * `holding`  — clear-to-close conditions + gates. Real work, holding the file now.
 * `next`     — the FUNDING half of the same payload, which nothing has ever
 *              rendered, minus anything already in `holding` so nothing is
 *              listed twice.
 *
 * `items` (checklist rows) and `conds` (underwriting-condition rows) are passed
 * in only to supply ageing — both endpoints already stamp daysOpen / overdue /
 * overdueBy, and until now nothing in the front end read them. Ids are uuids
 * from two tables, so the two spaces cannot collide.
 */
export function buildNextUp(gating, items, conds) {
  if (!gating) return { holding: [], next: [], all: [], overdue: 0 };
  const ctc = gating.clear_to_close || {};
  const fund = gating.funded || {};

  const ageById = new Map();
  for (const row of [...(items || []), ...(conds || [])]) {
    if (row && row.id) ageById.set(row.id, row);
  }
  const withAge = (r) => {
    const a = ageById.get(r.id);
    return a ? { ...r, daysOpen: a.daysOpen, overdue: a.overdue, overdueBy: a.overdueBy } : r;
  };

  const holding = [...(ctc.conditions || []), ...(ctc.gates || [])].map(withAge);
  const seen = new Set(holding.map((r) => `${r.kind}-${r.id}`));
  const next = [...(fund.conditions || []), ...(fund.gates || [])]
    .map(withAge)
    .filter((r) => !seen.has(`${r.kind}-${r.id}`));

  holding.sort(byUrgency);
  next.sort(byUrgency);
  const all = [...holding, ...next];
  return { holding, next, all, overdue: all.filter((r) => r.overdue).length };
}
