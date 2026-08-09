/* THE SEVEN ROOMS (docs/LOAN-FILE-NAVIGATION-AUDIT-2026-07.md, Phase 1).
   The staff loan file renders ONE room at a time; each room is a small set of
   the EXISTING sec-* sections, unchanged. This module is the single source of
   truth for that grouping and for the alias map that keeps every historical
   deep link landing (sec-* ids are permanent public addresses — rooms are
   presentation; the alias table is additive-only, never edited destructively).

   Pure data + pure helpers — no React, no DOM — so the link-contract test can
   run it under plain node. */

/* ORDER MATTERS IN THREE PLACES AND THEY MUST MOVE TOGETHER (learned the hard
   way): the ROOM RAIL reads its order from the `SECTIONS` array in
   StaffApplication.jsx, the PAGE reads its order from the literal JSX order of
   the <Section> blocks, and THIS array is ORDER-BLIND — it only feeds
   STATION_OF and the room badge roll-up. Changing one and not the others gets
   you a rail that disagrees with the page. */
export const STATIONS = [
  { id: 'st-overview', label: 'Overview', sections: ['sec-overview'] },
  /* Encompass sync is NOT listed here any more — it is a TAB of Application
     details, not a section of its own (owner-directed 2026-08-03). Its old
     address still lands: see RETIRED_SECTION below. */
  { id: 'st-deal', label: 'The Deal', sections: ['sec-application', 'sec-payoff', 'sec-pricing', 'sec-exceptions'] },
  /* Owner-directed 2026-08-02: conditions, then track record, then appraisal and
     findings, then document review, then documents. */
  { id: 'st-review', label: 'Review & Conditions', sections: ['sec-conditions', 'sec-track', 'sec-appraisal', 'sec-underwriting', 'sec-documents'] },
  /* ORDERS IS ITS OWN ROOM (owner-directed 2026-08-02: "that orders should be a
     separate section of orders … the same way we have a button now Signing and
     Closing, we should have a button Orders"). It sits BEFORE Signing & Closing
     because that is the order of the work — title and insurance are ordered, and
     closing prep is sent, well before anything is signed or closed.

     THREE SECTIONS, NOT ONE (owner-directed 2026-08-03: "once we click on orders
     by the left side we should also have the three options over there right away
     — we shouldn't need to go into orders and then see the 3 options"). The rail
     renders the active room's sections as spokes, but only when the room has more
     than one (FileSections.jsx) — so a single-section Orders room showed NOTHING
     under it and the three orders were reachable only by opening the room and
     then hunting inside it. Splitting them is what lights the rail up, and it
     also gives each order its own deep link, its own badge and its own scroll
     target. `sec-orders` still lands: see RETIRED_SECTION. */
  { id: 'st-orders', label: 'Orders', sections: ['sec-order-title', 'sec-order-insurance', 'sec-order-appraisal', 'sec-order-closing'] },
  /* E-signatures BEFORE closing (owner-directed 2026-08-02). */
  { id: 'st-signing', label: 'Signing & Closing', sections: ['sec-esign', 'sec-closing'] },
  { id: 'st-delivery', label: 'Send to Investor', sections: ['sec-tapes'] },
  { id: 'st-draws', label: 'Construction Draws', sections: ['sec-draws'] },
  { id: 'st-messages', label: 'Messages & History', sections: ['sec-messages'] },
];

/* Inner anchors that external callers and page furniture jump to. Each names
   the SECTION that must be open for the anchor to exist (a collapsed Section
   unmounts its children). sec-overview is open by default, so its anchors only
   need the room switch. */
export const ANCHOR_SECTION = {
  'note-buyer-slot': 'sec-overview',
  'ctc-outstanding': 'sec-overview',
  /* The retired "What needs you next" card's address. Its list merged INTO
     #ctc-outstanding (2026-08-02), and both ids now sit on that one panel — so
     an old bookmark resolves to the same room and the same element. A dead
     entry here is not harmless: the landing handler only acts on an anchor the
     map knows, so leaving it out is what makes a bookmark silently do nothing. */
  'next-up': 'sec-overview',
  'ai-findings': 'sec-underwriting',
  'conversations': 'sec-messages',
};

/* RETIRED SECTIONS — a `sec-*` id is a PERMANENT public address. Emails already
   in people's inboxes carry it, so a section that stops existing still has to
   land on whatever holds its content now.

   `sec-encompass` was removed from the page 2026-08-03 (owner-directed: the
   Encompass comparison "is now duplicated also in the application details and
   it's also a separate section in the deal … it should not be a separate
   section in the deal"). It had been left behind on 2026-08-02 as a shell whose
   only job was a button pointing at the tab — which is exactly the duplicate
   the owner is describing. The section is gone; its ADDRESS still works, and now
   opens Application details with the Encompass tab already showing.

   ADDITIVE ONLY: deleting a row here is how a link that used to work goes dead.
   `appTab` names a tab of the OWNING section's sub-hub (the Application-details
   tab strip today) — null when the target is the whole section. `label`/`where`
   are what the "Where did everything go?" one-pager says about it. */
export const RETIRED_SECTION = {
  'sec-encompass': {
    section: 'sec-application',
    appTab: 'encompass',
    label: 'Encompass sync',
    where: 'The Deal → Application details → Encompass sync',
  },
  /* `sec-orders` was ONE section holding all three orders until 2026-08-03, when
     it was split so the rail could list them (see st-orders above). Its address is
     live in the wild — every "documents came back on the title order" notification
     PILOT has ever sent deep-links to it, and those emails do not expire — so it
     resolves to the title order, the first of the three. */
  'sec-orders': {
    section: 'sec-order-title',
    appTab: null,
    label: 'Orders (title, insurance & closing prep)',
    where: 'Orders → Title / Insurance / Attorney closing prep',
  },
};

/* sec-* id (or inner anchor id) → owning room id. Built, not hand-typed, so
   the table can never disagree with STATIONS. A retired id inherits the room of
   the section that took its content, so `stationOf('sec-encompass')` keeps
   answering — which is what lets the resolver take the jump over instead of
   declining it to a default path with nothing to scroll to. */
export const STATION_OF = (() => {
  const map = {};
  for (const st of STATIONS) for (const sec of st.sections) map[sec] = st.id;
  for (const [anchor, sec] of Object.entries(ANCHOR_SECTION)) map[anchor] = map[sec];
  for (const [old, to] of Object.entries(RETIRED_SECTION)) map[old] = map[to.section];
  return map;
})();

/* "Where does this target live NOW?" — every jump runs through this, so a
   caller never needs a special case for a retired id. A live id (or an id this
   map has never heard of) comes back unchanged, so the behavior elsewhere is
   byte-identical. */
export function resolveSection(target) {
  const id = String(target || '').replace(/^#/, '');
  const moved = RETIRED_SECTION[id];
  if (!moved) return { id, appTab: null, moved: false };
  return { id: moved.section, appTab: moved.appTab || null, moved: true };
}

/* Resolve any target — '#sec-pricing', 'sec-pricing', 'ai-findings' — to its
   room id, or null for a target that is not part of the loan file (so the
   resolver can decline and leave behavior byte-identical elsewhere). */
export function stationOf(target) {
  return STATION_OF[String(target || '').replace(/^#/, '')] || null;
}

export function stationLabel(stationId) {
  const st = STATIONS.find((s) => s.id === stationId);
  return st ? st.label : '';
}

/* "Where did everything go?" — old section label → new room label, for the
   one-pager keyed by the old names (consolidation research: publish the map,
   never make people guess). */
export function whereDidItGo(sectionsList) {
  const live = (sectionsList || []).map((s) => ({
    old: s.label,
    now: stationLabel(STATION_OF[s.id]) || 'Overview',
  }));
  /* A DELETED section is the thing somebody is most likely to open this list
     looking for — and it is no longer in `sectionsList`, so it has to come from
     the retired table or the one question the list exists to answer goes
     unanswered. Its destination names the TAB, because a room label on its own
     ("The Deal") would send them hunting the room they are already standing in. */
  const retired = Object.values(RETIRED_SECTION)
    .filter((r) => r.label)
    .map((r) => ({ old: r.label, now: r.where || stationLabel(STATION_OF[r.section]) || 'Overview' }));
  return [...live, ...retired];
}
