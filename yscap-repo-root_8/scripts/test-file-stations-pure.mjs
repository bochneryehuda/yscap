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

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

let failures = 0;
const ok = (cond, what) => { if (cond) console.log(`  ✓ ${what}`); else { failures++; console.error(`  ✗ ${what}`); } };

const { STATIONS, STATION_OF, ANCHOR_SECTION, RETIRED_SECTION, stationOf, resolveSection, stationLabel, whereDidItGo } =
  await import(join(ROOT, 'app-v2/src/lib/stations.js'));

/* ---------------------------------------------- 1. the map itself is sound */
console.log('1. the room map');
/* EIGHTEEN live sections. `sec-encompass` LEFT this list on 2026-08-03 — the
   Encompass comparison is a TAB of Application details, and the shell section
   that pointed at that tab was the duplicate the owner asked to remove. So did
   `sec-orders`, on the same day, when the three orders were split into three
   sections so the rail could list them. Both ids live on as retired ADDRESSES
   (section 1b), never as sections. */
const ALL_SECTIONS = [
  'sec-overview', 'sec-application', 'sec-payoff', 'sec-pricing', 'sec-exceptions',
  'sec-conditions', 'sec-underwriting', 'sec-appraisal', 'sec-track',
  'sec-documents', 'sec-esign',
  'sec-order-title', 'sec-order-insurance', 'sec-order-appraisal', 'sec-order-closing',
  'sec-closing', 'sec-tapes',
  'sec-draws', 'sec-messages',
];
ok(ALL_SECTIONS.length === 19, 'the inventory names 19 sections');
const flat = STATIONS.flatMap((s) => s.sections);
ok(flat.length === new Set(flat).size, 'no section is claimed by two rooms');
for (const sec of ALL_SECTIONS) ok(!!STATION_OF[sec], `${sec} has a room`);
ok(flat.length === ALL_SECTIONS.length && ALL_SECTIONS.every((s) => flat.includes(s)),
  'the rooms cover exactly the 19 sections — nothing homeless, nothing invented');
ok(!flat.includes('sec-encompass'),
  'no room CLAIMS sec-encompass — a retired address is not a section');
/* EIGHT rooms now. The original promise was seven; the owner then asked for
   Orders to get its own button ("the same way we have a button now Signing and
   Closing, we should have a button Orders", 2026-08-02), which is a room the
   owner ADDED deliberately. The number is pinned rather than derived so that
   another room can never appear by accident — growing this list is a decision. */
ok(STATIONS.length === 8, 'eight rooms — the original seven plus the owner-requested Orders');
/* THE RAIL ONLY DRAWS SPOKES FOR A ROOM WITH MORE THAN ONE SECTION
   (FileSections.jsx), so a one-section Orders room showed nothing at all beneath
   "Orders" — the owner's report. Three sections is what lights it up, so the
   COUNT is the load-bearing part of this assertion, not just the names. */
ok(STATIONS.some((s) => s.id === 'st-orders'
   && s.sections.join() === 'sec-order-title,sec-order-insurance,sec-order-appraisal,sec-order-closing'),
  'Orders holds its four order sections, in work order (appraisal beside title/insurance/attorney)');
ok(STATIONS.find((s) => s.id === 'st-orders').sections.length > 1,
  'Orders has more than one section — which is what makes the rail show them');
ok(STATIONS.find((s) => s.id === 'st-signing').sections.join() === 'sec-esign,sec-closing',
  'Signing & Closing is e-signatures THEN closing, with orders gone');
ok(STATIONS.find((s) => s.id === 'st-review').sections.join()
   === 'sec-conditions,sec-track,sec-appraisal,sec-underwriting,sec-documents',
  'Review & Conditions is in the owner\'s order: conditions, track record, appraisal, document review, documents');
ok(STATIONS.every((s) => s.label && !/hub|station|palette|canvas/i.test(s.label)),
  'room labels are plain words (no internal jargon)');
ok(stationLabel('st-delivery') === 'Send to Investor',
  '"Send to Investor" (owner-fit review) — never "Investor Delivery"');

/* ------------------------------------------------------ 1b. retired addresses */
/* A sec-* id is a PERMANENT public address — emails already sent carry it — so
   deleting a section means RETIRING its id, never dropping it. Every one of
   these must still resolve to a room and must rewrite to a section that really
   exists, or the link is dead. */
console.log('1b. retired section addresses');
for (const [old, to] of Object.entries(RETIRED_SECTION)) {
  ok(!ALL_SECTIONS.includes(old), `${old} is genuinely gone from the page`);
  ok(ALL_SECTIONS.includes(to.section), `${old} rewrites to ${to.section}, which is a live section`);
  ok(stationOf(old) === STATION_OF[to.section], `${old} still resolves — to ${to.section}'s room`);
  const r = resolveSection(`#${old}`);
  ok(r.moved && r.id === to.section && r.appTab === (to.appTab || null),
    `resolveSection('#${old}') → ${to.section}${to.appTab ? ` + the "${to.appTab}" tab` : ''}`);
}
ok(RETIRED_SECTION['sec-encompass'] && RETIRED_SECTION['sec-encompass'].appTab === 'encompass',
  'sec-encompass lands on the Encompass TAB, not merely on Application details');
/* Every "documents came back on the title order" email PILOT has ever sent
   deep-links to #sec-orders, and those emails do not expire. */
ok(RETIRED_SECTION['sec-orders'] && RETIRED_SECTION['sec-orders'].section === 'sec-order-title'
   && stationOf('sec-orders') === 'st-orders',
  'sec-orders still lands — on the title order, in the Orders room');
{
  const live = resolveSection('sec-pricing');
  ok(!live.moved && live.id === 'sec-pricing' && live.appTab === null,
    'a live id passes through resolveSection unchanged (behavior elsewhere is byte-identical)');
  const unknown = resolveSection('sec-nonsense');
  ok(!unknown.moved && unknown.id === 'sec-nonsense', 'an unknown id passes through too');
  ok(resolveSection('').id === '' && resolveSection(null).id === '', 'blank/null are safe');
}

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
  // The e-sign Encompass blocker and the tape gate now ask for the TAB and open
  // the section that holds it, so they point at a live id. ExceptionCard keeps
  // the RETIRED id on purpose — it is a URL, and only the retired address
  // carries "open the Encompass tab" with it.
  'EsignFileSection encompass-gate': 'sec-application',
  'ExceptionCard (encompass, retired address)': 'sec-encompass',
  'TapeExport gate links': 'sec-overview',
  '?focus=ai-findings': 'ai-findings',
  '?focus=chat': 'conversations',
  'CTC badge / DealSnapshot': 'ctc-outstanding',
  'NoteBuyerRef / CondNoteBuyerEntry': 'note-buyer-slot',
  'a bookmark to the retired What-needs-you-next card': 'next-up',
};
for (const [who, target] of Object.entries(CLIENT_TARGETS)) {
  ok(!!stationOf(target), `${who} → ${target} resolves`);
}
/* Server-emitted anchors (emails must land forever). The scan used to cover only
   the three `#sec-*` producers and only the `sec-` prefix, which is exactly why
   two dead links survived a green suite (post-merge audit 2026-08-02): a
   `#ai-findings-<id>` that matches no element at all, and a `#ai-findings` the
   staff screen's landing regex dropped. So: scan EVERY producer, and match ANY
   anchor shape, not just `sec-`.

   The list is WALKED, not hand-typed: a hand-typed list is how the two dead
   links survived in the first place, and it can only ever describe the
   producers somebody remembered on the day. */
const ANCHOR_PRODUCERS = readdirSync(join(ROOT, 'src'), { recursive: true })
  .filter((f) => String(f).endsWith('.js'))
  .map((f) => join('src', String(f)))
  .filter((p) => /\/internal\/app\/\$\{[^}]+\}#/.test(read(p)));
/* The walk must not silently find NOTHING — a typo in the path or the regex
   would make every assertion below vacuously true. Pinned by naming the
   producers we know emit an anchor today rather than by a count, which would
   go stale the moment one of them switches to a query link (ai-suggestions.js
   just did). Anything new the walk turns up is checked by the loop below. */
for (const known of ['src/lib/ai/cost-meter.js', 'src/lib/closing-inbox.js',
  'src/lib/notification-digests.js', 'src/routes/admin-exceptions.js']) {
  ok(ANCHOR_PRODUCERS.includes(known), `the producer walk sees ${known}`);
}
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
/* The removal itself: no Section renders at a retired id, or the "duplicate
   Encompass room" the owner asked to delete is back. */
for (const old of Object.keys(RETIRED_SECTION)) {
  ok(!new RegExp(`<Section [^>]*id="${old}"`).test(staff), `no <Section> renders at the retired id ${old}`);
}
/* …and the two halves that keep the retired ADDRESS landing. Both are needed:
   classic view registers no resolver, so the landing handler must resolve too. */
ok(/const moved = t\.kind === 'section' \? resolveSection\(t\.id\) : null;/.test(staff),
  'the room resolver rewrites a retired section id before it looks up a room');
ok(/const moved = resolveSection\(target\);/.test(staff),
  'the deep-link landing handler resolves it too (classic view has no resolver)');
ok(/if \(t\.appTab\) requestAppDetailTab\(t\.appTab\);/.test(staff),
  'a queued jump carries the Application-details tab, so the link lands on the right tab');
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
/* A room must never be reachable but empty, and must never hide something the
   viewer is allowed to use. st-draws still pairs 1:1 with its section's gate.
   st-delivery no longer does, ON PURPOSE: it gained the TPR and MISMO exports
   (owner-directed 2026-08-02), which every staffer on the file may run, so
   gating the room on export_data_tapes would have taken them away from every
   loan officer who has them today. The tape workbook keeps that permission,
   inside the section. */
ok(/'st-draws'\) return can\('manage_draws'\)/.test(staff),
  'Construction Draws uses the same gate as its section');
ok(/'st-delivery'\) return true;/.test(staff),
  'Send to investor is open to anyone on the file (its exports are ungated)');
ok(/\{can\('export_data_tapes'\) && <TapeExport/.test(staff),
  '…and the capital-provider tape keeps its own permission, inside the section');
ok(/id="sec-tapes"[^>]*title="Send to investor"/.test(staff)
  && !/\{can\('export_data_tapes'\) && \(\s*<Section/.test(staff),
  'the Send-to-investor SECTION itself is no longer permission-wrapped');
/* WHAT THIS ASSERTS IS WHERE THE EXPORTS LIVE, NOT WHAT ORDER THEY SIT IN.
   It used to demand <TprExport> be IMMEDIATELY followed by <MismoExport>, which
   made adding a THIRD export to this section (the CorrFirst track-record CSV) a
   test failure — an over-specified source shape standing in for the real rule.
   So: bound the slice to the section's own JSX (never to the end of the file,
   or the components' own later definitions would satisfy it) and require each
   export to render inside it. Add an export here when you add one to the
   section, so this keeps biting. */
{
  const from = staff.indexOf('id="sec-tapes"');
  const to = staff.indexOf('id="sec-messages"');
  const delivery = (from >= 0 && to > from) ? staff.slice(from, to) : '';
  ok(delivery.length > 0, 'the Send-to-investor section is locatable in the source');
  for (const [name, what] of [
    ['TprExport', 'the TPR clean-file export'],
    ['MismoExport', 'the MISMO 3.4 export'],
    ['CorrfirstExport', 'the Corrfirst track-record export'],
  ]) {
    ok(new RegExp(`<${name} appId=\\{id\\} ?/>`).test(delivery),
      `${what} lives in Send to investor, not in Documents`);
  }
}
ok(/id="sec-documents"[^>]*title="Documents"/.test(staff),
  'Documents is called just "Documents" now that the exports have left');
/* A badge must follow its section. When sec-orders moved into its own room the
   "N to assign" count was still being added to Signing & Closing, which would
   have pointed at work that is no longer in that room. */
ok(/if \(st\.id === 'st-orders'\) badge \+= nOrdersToAssign;/.test(staff)
  && !/'st-signing'\) badge \+= nOrdersToAssign/.test(staff),
  'the orders badge followed sec-orders into the Orders room');
/* THE THREE ORDER SECTIONS ARE REALLY ON THE PAGE, each fed the ONE order type it
   is named for. The rail reads the SECTIONS array, so a room whose sections are
   listed but never rendered gives you three spokes that scroll to nothing. */
for (const [sec, only, title] of [
  ['sec-order-title', 'title', 'Title'],
  ['sec-order-insurance', 'insurance', 'Insurance'],
  ['sec-order-closing', 'closing', 'Attorney closing prep'],
]) {
  ok(new RegExp(`id="${sec}"[^>]*title="${title}"`).test(staff), `${sec} is rendered, titled "${title}"`);
  ok(new RegExp(`id="${sec}"[\\s\\S]{0,600}?only="${only}"`).test(staff),
    `${sec} renders the ${only} order and only that one`);
  ok(new RegExp(`\\{ id: '${sec}',`).test(staff), `${sec} is in the SECTIONS array the rail reads`);
}
/* The appraisal order section is a vendor DESK, not an OrdersPanel-backed email
   order — so it renders the vendor panels rather than an `only=` OrdersPanel. It
   sits in the Orders room beside the other three.

   The section mounts ONE unified <AppraisalOrderSection>: a vendor selector chooses
   which backend the builder targets, and the active-order cards + the one drafts/
   failed drawer show orders from BOTH vendors together, each carrying its vendor
   stamp. NEITHER vendor is the default. The "both vendors present" guarantee moved
   INTO the component itself (asserted below against AppraisalOrderSection.jsx), so
   an ordering desk can never quietly disappear. */
ok(/id="sec-order-appraisal"[^>]*title="Appraisal"/.test(staff), 'sec-order-appraisal is rendered, titled "Appraisal"');
ok(/id="sec-order-appraisal"[\s\S]{0,1600}?<AppraisalOrderSection\b/.test(staff), 'sec-order-appraisal mounts the unified <AppraisalOrderSection>');
ok(/<AppraisalOrderSection\b[^>]*\bappId=/.test(staff) && /<AppraisalOrderSection\b[^>]*\bonChanged=/.test(staff),
  'the unified section is passed appId + onChanged (so a Pay / condition change refreshes the file)');
/* The two vendors — and neither-is-default — now live INSIDE the component, so a
   vendor cannot quietly vanish: assert both are carried in AppraisalOrderSection. */
const aord = read('app-v2/src/components/AppraisalOrderSection.jsx');
for (const vendor of ['AppraisalScope / NAN', 'Class Valuation']) {
  ok(aord.includes(vendor), `AppraisalOrderSection carries the ${vendor} vendor`);
}
ok(/\{ id: 'sec-order-appraisal',/.test(staff), 'sec-order-appraisal is in the SECTIONS array the rail reads');
/* The three open by DEFAULT. Landing in the Orders room and finding three
   collapsed headers is the "go into orders and then see the 3 options" the split
   exists to end, so a defaultOpen={false} here would undo the whole change. */
ok(!/id="sec-order-(title|insurance|appraisal|closing)"[^>]*defaultOpen=\{false\}/.test(staff),
  'the order sections open by default — the room shows the work, not the lids');
/* A DERIVED open-state prop is what slammed the Title section shut on its own
   "sent to <vendor>" confirmation the instant the order was placed. Comments are
   stripped first — the fix's own comment quotes the offending line, and a check
   that its own explanation trips is a check nobody can keep green. */
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const ordersPanel = stripComments(read('app-v2/src/components/OrdersPanel.jsx'));
ok(!/open=\{!isPlaced\(/.test(ordersPanel),
  'no section takes its open state from whether the order has been placed');

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
/* The list's whole job is "where did X go?", and a DELETED section is the most
   likely thing to be looked up in it — it is no longer in the SECTIONS array the
   screen passes, so it must come from the retired table. */
{
  const enc = map.find((r) => r.old === 'Encompass sync');
  ok(!!enc, 'a retired section still appears in the "where did everything go?" list');
  ok(enc && /Application details/.test(enc.now) && /Encompass sync/.test(enc.now),
    '…and it names the TAB, not just the room the reader is already standing in');
}

if (failures) { console.error(`\n${failures} FAILURE(S)`); process.exit(1); }
console.log('\nAll Seven Rooms link-contract checks passed.');
