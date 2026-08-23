// LONG-TERM — how the Condition Center's list is folded up.
//
// Its own file, with no JSX and no imports, so the rule can be RUN in a test
// rather than eyeballed in a screen: which gate a condition belongs to, how much
// of that gate is still outstanding, and whether the section should be open when
// somebody arrives. All three are decisions a person will disagree with if they
// are wrong, and none of them is visible in a screenshot of a folded section.
//
// It DECIDES nothing about the data — every figure here is counted from what the
// server already sent (`open` is Encompass's own outstanding flag, mirrored, and
// `group` is its own `priorTo`). Nothing is re-derived from a status word.

/**
 * Conditions, bucketed by the gate they block, with the count that has to survive
 * being folded away.
 *
 * ORDER IS THE SERVER'S, and deliberately not re-sorted here: it sends unapproved
 * first and then oldest first, a stable order chosen so the list does not reshuffle
 * under somebody's cursor between two reads. A second sort in the browser is how
 * the screen and the API start disagreeing about what "first" means.
 *
 * A condition with no stated gate gets its OWN honest bucket rather than being
 * folded into a real gate it may not belong to.
 */
export function groupConditions(items) {
  const groups = new Map();
  for (const it of (Array.isArray(items) ? items : [])) {
    const g = (it && it.group) || 'Not stated';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(it);
  }
  return [...groups.entries()].map(([name, list]) => ({
    name,
    items: list,
    // `open` is a three-valued thing on the wire — true, false, and a null that
    // the server already reports as open — so this counts what it was TOLD is
    // outstanding rather than counting the closed ones and subtracting.
    open: list.filter((i) => i && i.open).length,
    total: list.length,
  }));
}

/**
 * Is this gate finished?
 *
 * The one rule the fold and the wording both read, so a section can never say
 * "all done" while sitting open because something is still outstanding.
 */
export function groupDone(group) {
  return !!group && group.total > 0 && group.open === 0;
}

/** What the header says — it is on the SUMMARY, so it survives being folded. */
export function groupSummary(group) {
  if (!group || !group.total) return 'nothing here';
  return groupDone(group)
    ? `all ${group.total} done`
    : `${group.open} of ${group.total} outstanding`;
}
