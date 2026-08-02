/* SEVEN ROOMS — the deep-link CONTRACT (Phase 1, docs/LOAN-FILE-NAVIGATION-AUDIT-2026-07.md §6).
   sec-* ids are permanent public addresses; rooms are presentation. This test
   pins: (1) the alias map covers every section and every inner anchor exactly
   once, (2) every deep-link target the audit inventoried — client screens AND
   server-emitted email anchors — resolves to a room, (3) the staff screen
   actually renders all 17 sections behind the room switch with the resolver
   registered (and unregistered on unmount), (4) the borrower screen and the
   Draw Center stay on the legacy path (no stations prop — byte-identical), and
   (5) the classic-view escape hatch exists. Pure — real import of stations.js
   plus source reading; no DB, no browser. */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

let failures = 0;
const ok = (cond, what) => { if (cond) console.log(`  ✓ ${what}`); else { failures++; console.error(`  ✗ ${what}`); } };

const { STATIONS, STATION_OF, ANCHOR_SECTION, stationOf, stationLabel, whereDidItGo } =
  await import(join(ROOT, 'app-v2/src/lib/stations.js'));

/* ---------------------------------------------- 1. the map itself is sound */
console.log('1. the room map');
const ALL_SECTIONS = [
  'sec-overview', 'sec-application', 'sec-payoff', 'sec-pricing', 'sec-exceptions',
  'sec-encompass', 'sec-conditions', 'sec-underwriting', 'sec-appraisal', 'sec-track',
  'sec-documents', 'sec-esign', 'sec-orders', 'sec-closing', 'sec-tapes',
  'sec-draws', 'sec-messages',
];
ok(ALL_SECTIONS.length === 17, 'the inventory names 17 sections');
const flat = STATIONS.flatMap((s) => s.sections);
ok(flat.length === new Set(flat).size, 'no section is claimed by two rooms');
for (const sec of ALL_SECTIONS) ok(!!STATION_OF[sec], `${sec} has a room`);
ok(flat.length === ALL_SECTIONS.length && ALL_SECTIONS.every((s) => flat.includes(s)),
  'the rooms cover exactly the 17 sections — nothing homeless, nothing invented');
ok(STATIONS.length === 7, 'seven rooms, as the owner was promised');
ok(STATIONS.every((s) => s.label && !/hub|station|palette|canvas/i.test(s.label)),
  'room labels are plain words (no internal jargon)');
ok(stationLabel('st-delivery') === 'Send to Investor',
  '"Send to Investor" (owner-fit review) — never "Investor Delivery"');

/* -------------------------------------------------------- 2. inner anchors */
console.log('2. inner anchors');
for (const [anchor, sec] of Object.entries(ANCHOR_SECTION)) {
  ok(STATION_OF[anchor] === STATION_OF[sec], `#${anchor} resolves to ${sec}'s room`);
}
ok(stationOf('#sec-pricing') === 'st-deal', 'stationOf tolerates a # prefix');
ok(stationOf('sec-nonsense') === null, 'an unknown id resolves to null (resolver declines)');
ok(stationOf('') === null && stationOf(null) === null, 'blank/null resolve to null');

/* --------------------- 3. every audited deep-link target still has a home */
console.log('3. the audited deep-link inventory');
// Client producers (screen → target), from the audit's §6 evidence table.
const CLIENT_TARGETS = {
  'StaffOrders "Open"': 'sec-orders',
  'StaffClosing "Open"': 'sec-closing',
  'SyncReviews FIELD_SECTION': 'sec-overview',
  'SyncReviews (address/phone/loan#)': 'sec-application',
  'SyncReviews (sitewire)': 'sec-draws',
  'SyncReviews (sharepoint)': 'sec-documents',
  'ExceptionCard (pricing/guaranty)': 'sec-pricing',
  'ExceptionCard (esign)': 'sec-esign',
  'ExceptionCard (underwriting)': 'sec-underwriting',
  'ExceptionCard (appraisal)': 'sec-appraisal',
  'ExceptionCard footer': 'sec-conditions',
  'server blocker stamps': 'sec-conditions',
  'EditFileDetails payoff link': 'sec-payoff',
  'EsignFileSection encompass-gate': 'sec-encompass',
  'TapeExport gate links': 'sec-overview',
  '?focus=ai-findings': 'ai-findings',
  '?focus=chat': 'conversations',
  'CTC badge / DealSnapshot': 'ctc-outstanding',
  'NoteBuyerRef / CondNoteBuyerEntry': 'note-buyer-slot',
};
for (const [who, target] of Object.entries(CLIENT_TARGETS)) {
  ok(!!stationOf(target), `${who} → ${target} resolves`);
}
/* Server-emitted anchors (emails must land forever). The scan used to cover only
   the three `#sec-*` producers and only the `sec-` prefix, which is exactly why
   two dead links survived a green suite (post-merge audit 2026-08-02): a
   `#ai-findings-<id>` that matches no element at all, and a `#ai-findings` the
   staff screen's landing regex dropped. So: scan EVERY producer, and match ANY
   anchor shape, not just `sec-`. */
const ANCHOR_PRODUCERS = [
  'src/routes/admin-exceptions.js', 'src/lib/closing-inbox.js', 'src/lib/notification-digests.js',
  'src/lib/ai/cost-meter.js', 'src/lib/underwriting/ai-suggestions.js',
];
for (const p of ANCHOR_PRODUCERS) {
  const src = read(p);
  const anchors = [...src.matchAll(/\/internal\/app\/\$\{[^}]+\}#([a-z][a-z0-9-]*)/g)].map((m) => m[1]);
  for (const a of new Set(anchors)) ok(!!stationOf(a), `${p} emits #${a} — resolves to a room`);
}
// The dead form specifically: an anchor with the suggestion id glued on can never
// resolve, so no producer may emit one. Deep-linking a finding uses `?finding=`.
for (const p of ANCHOR_PRODUCERS) {
  ok(!/#ai-findings-\$\{/.test(read(p)), `${p} does not emit the dead #ai-findings-<id> form`);
}
ok(/\?finding=\$\{suggestionId\}/.test(read('src/lib/underwriting/ai-suggestions.js')),
  'the fatal-finding email deep-links with ?finding= (the form the panel actually consumes)');
// The staff screen's landing handler must not filter a known anchor out before
// the map is consulted — it reads any anchor and asks stationOf().
{
  const staffSrc = read('app-v2/src/screens/StaffApplication.jsx');
  ok(!/match\(\/#\(sec-\[a-z-\]\+\)\$\//.test(staffSrc),
    'the landing handler no longer hard-filters to sec-* (it dropped #ai-findings)');
  ok(/stationOf\(m\[1\]\)/.test(staffSrc), 'the landing handler consults the room map for the anchor it found');
}

/* ---------------------------- 4. the staff screen is wired the audited way */
console.log('4. staff screen wiring');
const staff = read('app-v2/src/screens/StaffApplication.jsx');
for (const sec of ALL_SECTIONS) {
  const re = new RegExp(`<Section hidden=\\{!show\\('${sec}'\\)\\} id="${sec}"`, 'g');
  ok((staff.match(re) || []).length === 1, `${sec} renders once, behind the room switch`);
}
ok(/return setSectionResolver\(/.test(staff), 'the resolver registers in an effect WITH cleanup (returns the unregister)');
ok(/if \(classic\) return undefined;/.test(staff), 'classic view never registers the resolver (byte-identical behavior)');
ok(/get\('finding'\)/.test(staff) && /h\.indexOf\('\?'\)/.test(staff),
  '?finding= handler exists and parses the query-inside-hash form (red-team R1)');
ok(/onOpenStudio=\{openStudioAnywhere\}/.test(staff), '"Open the studio" works cross-room (red-team R2)');
ok(!/apprSummary/.test(staff.slice(staff.indexOf('const STATION_DEFS'), staff.indexOf('const railFooter'))),
  'room badges never read the mount-dependent panel summaries (red-team R3)');
ok(/Full file \(classic view\)/.test(staff), 'the classic-view escape hatch exists');
ok(/Where did everything go\?/.test(staff), 'the "where did X go" one-pager exists');
ok(/hidden=\{!show\('sec-draws'\)\} id="sec-draws" title="Construction draws" collapsible=\{false\}/.test(staff),
  'sec-draws keeps collapsible={false}');
ok(/'st-delivery'\) return can\('export_data_tapes'\)/.test(staff)
  && /'st-draws'\) return can\('manage_draws'\)/.test(staff),
  'permission-gated rooms use the SAME gates as their sections');

/* ----------------------- 5. the legacy path stays byte-identical elsewhere */
console.log('5. legacy consumers untouched');
const borrower = read('app-v2/src/screens/Application.jsx');
ok(!/stations=/.test(borrower), 'the borrower screen passes no stations prop (legacy rail)');
ok(!/setSectionResolver/.test(borrower), 'the borrower screen never registers a resolver');
const draws = read('app-v2/src/components/DrawsPanel.jsx');
ok(!/stations=/.test(draws) && !/setSectionResolver/.test(draws), 'the Draw Center stays on the legacy path');
const fs = read('app-v2/src/components/FileSections.jsx');
ok(/stations = null/.test(fs), 'FileSections defaults stations to null (legacy default)');
ok(fs.indexOf('if (hidden) return null;') > fs.lastIndexOf('useEffect(() => {', fs.indexOf('if (hidden) return null;')),
  'Section\'s hidden null-render sits AFTER its hooks (no conditional-hooks violation)');
ok(/if \(sectionResolver && sectionResolver\(\{ kind: 'section'/.test(fs),
  'goToSection consults the resolver before its default path');

/* ------------------------------------------------------------- 6. helpers */
console.log('6. helpers');
const map = whereDidItGo([{ id: 'sec-tapes', label: 'Capital-provider data tapes' }]);
ok(map[0].now === 'Send to Investor', 'whereDidItGo maps an old label to its room');

if (failures) { console.error(`\n${failures} FAILURE(S)`); process.exit(1); }
console.log('\nAll Seven Rooms link-contract checks passed.');
