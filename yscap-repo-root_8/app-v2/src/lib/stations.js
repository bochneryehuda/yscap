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
  { id: 'st-deal', label: 'The Deal', sections: ['sec-application', 'sec-payoff', 'sec-pricing', 'sec-exceptions', 'sec-encompass'] },
  /* Owner-directed 2026-08-02: conditions, then track record, then appraisal and
     findings, then document review, then documents. */
  { id: 'st-review', label: 'Review & Conditions', sections: ['sec-conditions', 'sec-track', 'sec-appraisal', 'sec-underwriting', 'sec-documents'] },
  /* ORDERS IS ITS OWN ROOM (owner-directed 2026-08-02: "that orders should be a
     separate section of orders … the same way we have a button now Signing and
     Closing, we should have a button Orders"). It sits BEFORE Signing & Closing
     because that is the order of the work — title and insurance are ordered, and
     closing prep is sent, well before anything is signed or closed. */
  { id: 'st-orders', label: 'Orders', sections: ['sec-orders'] },
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

/* sec-* id (or inner anchor id) → owning room id. Built, not hand-typed, so
   the table can never disagree with STATIONS. */
export const STATION_OF = (() => {
  const map = {};
  for (const st of STATIONS) for (const sec of st.sections) map[sec] = st.id;
  for (const [anchor, sec] of Object.entries(ANCHOR_SECTION)) map[anchor] = map[sec];
  return map;
})();

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
  return (sectionsList || []).map((s) => ({
    old: s.label,
    now: stationLabel(STATION_OF[s.id]) || 'Overview',
  }));
}
