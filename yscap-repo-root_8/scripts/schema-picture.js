'use strict';

// =============================================================================
// SCHEMA PICTURE — the database as something a person can actually look at
// =============================================================================
//
// Plan §6c: *"Generate a picture, not just a file … it gives the non-developer
// view of the 321 tables that a `.prisma` file does not."*
//
// The plan named SchemaSpy. This does the same job without it, on purpose:
// SchemaSpy is a Java program that wants a JDBC driver, Graphviz and a live
// database connection, and none of those can be added to a build that must stay
// `express` + `pg`. Everything it would show is ALREADY in
// `docs/schema/beyond-prisma.json`, so this reads that and writes one
// self-contained HTML file.
//
// THAT HAS A PROPERTY WORTH MORE THAN THE TOOL: this needs NO DATABASE. The
// snapshot is committed, so anyone — on a laptop, on a plane, in a container
// with no Postgres — can regenerate the picture with one command and no setup.
// The thing it describes is a copy, and it says so, with the date and the
// migration watermark on the page.
//
// NOTHING IS INVENTED. Every number, every table, every link is read from the
// snapshot. The only hand-written content is the plain-English note on the
// ~30 tables at the centre of the system (`GLOSSARY`) and the domain grouping
// (`DOMAINS`) — and both are guarded: `test-schema-picture-pure.js` fails if a
// glossary entry names a table that no longer exists, and the grouping is
// asserted to be a PARTITION, so a table can never be quietly left out of the
// picture.
//
// Usage:
//   node scripts/schema-picture.js            # writes docs/schema/PICTURE.html
//   node scripts/schema-picture.js --print    # counts only, writes nothing

const fs = require('fs');
const path = require('path');

const OUT_DIR = path.join(__dirname, '..', 'docs', 'schema');
const SNAPSHOT = path.join(OUT_DIR, 'beyond-prisma.json');
const OUT_FILE = path.join(OUT_DIR, 'PICTURE.html');

// =============================================================================
// THE GROUPING
// =============================================================================
//
// 321 tables in one list is not a picture, it is the same problem in a
// different font. They are grouped by what they are FOR.
//
// It is matched by PREFIX, longest first, so `lt_dscr_quotes` lands in
// Long-Term rather than in whatever `dscr` might match. There are 105 distinct
// first words among the table names and 50 of those appear exactly once, so a
// purely automatic grouping produces 105 groups and helps nobody — this is
// curated, and it is guarded instead: the groups must PARTITION the tables, so
// a table matching nothing lands in "Everything else" and is LISTED there. No
// table can fall out of the picture.
const DOMAINS = [
  {
    key: 'lt',
    name: 'Long-Term loans',
    blurb: 'The second product, built separately from the ground up. By the '
      + 'separation law every one of its tables is named lt_*, and none of them '
      + 'may reference a short-term table.',
    prefixes: ['lt_'],
  },
  {
    key: 'deal',
    name: 'Loan files and the deal itself',
    blurb: 'A loan file, the conditions on it, the product registered against '
      + 'it, and the exceptions and approvals that move it along.',
    prefixes: ['applications', 'application_', 'checklist', 'condition', 'conditions',
      'product_registrations', 'loan_exception', 'exception', 'workflow', 'stage_',
      'change_requests', 'pricing', 'company_pricing', 'manual_program', 'leads',
      'lead_', 'quote', 'term_sheet', 'esign', 'file_orders', 'file_lock', 'liquidity',
      'custom_fields', 'file_order_events', 'sow_change_request', 'docusign',
      'section_1071'],
  },
  {
    key: 'people',
    name: 'People, entities and track record',
    blurb: 'The borrower as a person rather than as a loan file — their login, '
      + 'their companies, the deals they have done before, and our own staff.',
    prefixes: ['borrower', 'borrowers', 'staff', 'llc', 'llcs', 'track_record',
      'service_contacts', 'contacts', 'invites', 'invite', 'partners',
      'entity_removals', 'usps_address'],
  },
  {
    key: 'docs',
    name: 'Documents and the file cabinet',
    blurb: 'Every document in the system, plus the one-way mirror into '
      + 'SharePoint that keeps a copy nobody can delete by accident.',
    prefixes: ['document', 'documents', 'sharepoint', 'storage', 'doclab', 'tpr',
      'logical_document', 'evidence_spans'],
  },
  {
    key: 'uw',
    name: 'Underwriting, findings and PILOT’s own reading',
    blurb: 'What the system notices about a file, what a human decided about '
      + 'each finding, and the record of every automated review run.',
    prefixes: ['underwriting', 'finding', 'findings', 'ai_', 'fraud', 'guideline',
      'tieout', 'fact_', 'facts', 'risk', 'insight', 'training', 'labeling',
      'root_cause', 'remediation_options', 'shadow_decisions', 'evaluation_',
      'label_', 'decision_certificates', 'loan_facts', 'internal_overlays',
      'routing_outcomes'],
  },
  {
    key: 'appraisal',
    name: 'Appraisals and property research',
    blurb: 'Appraisal reports and everything read out of them — plus the '
      + 'cross-file warehouse of every property, comparable sale and appraiser '
      + 'we have ever been shown.',
    prefixes: ['appraisal', 'appraiser', 'property', 'properties', 'comp_', 'avm',
      'research', 'valuation', 'market_', 'hpi_index'],
  },
  {
    key: 'credit',
    name: 'Credit',
    blurb: 'Credit reports pulled for each borrower, and the waivers that let a '
      + 'report obtained elsewhere satisfy the condition.',
    prefixes: ['credit'],
  },
  {
    key: 'draws',
    name: 'Construction draws',
    blurb: 'Money released against building work as it is completed — the '
      + 'inspections, the photographs, the approvals and the wires.',
    prefixes: ['draw', 'sitewire', 'trustpoint', 'trinity', 'inspection',
      'portal_draw'],
  },
  {
    key: 'closing',
    name: 'Closing, purchasing and investors',
    blurb: 'Getting to the table, and what happens after: who buys the loan, '
      + 'the data tapes they receive, and the purchase advice that follows.',
    prefixes: ['closing', 'purchasing', 'investor', 'investors', 'tape', 'wire',
      'payoff', 'post_purchase', 'release', 'post_closing', 'note_buyer'],
  },
  {
    key: 'tpo',
    name: 'The broker channel',
    blurb: 'Third-party originators — outside brokerages that bring us loans, '
      + 'and their people, kept strictly inside their own firm’s files.',
    prefixes: ['tpo'],
  },
  {
    key: 'integrations',
    name: 'Outside systems we talk to',
    blurb: 'ClickUp, Encompass, email in and out, appraisal management, and '
      + 'every queue and review that keeps them in step with us.',
    prefixes: ['clickup', 'encompass', 'sync', 'amc', 'elementix', 'rv_', 'richer',
      'class', 'lo_', 'integration', 'webhook', 'inbound', 'outbound'],
  },
  {
    key: 'talk',
    name: 'Messages, email and notifications',
    blurb: 'Everything the system says to a person, and everything said back — '
      + 'in-app messages, the email threads a file collects, and the record of '
      + 'what was sent to whom.',
    prefixes: ['email', 'emails', 'notification', 'notifications', 'chat',
      'conversation', 'conversations', 'messages', 'message', 'sent_emails',
      'reminders'],
  },
  {
    key: 'platform',
    name: 'Plumbing and housekeeping',
    blurb: 'The parts no one asks for by name but nothing works without: the '
      + 'audit trail, the backups, sessions, locks and scheduled work.',
    prefixes: ['audit', 'backup', 'request_audit', 'sessions', 'revoked',
      'app_results', 'cron', 'locks', 'lock', 'health', 'schema_', 'address_canon',
      'api_', 'cost', 'usage', 'settings', 'config', 'feature', 'artifact_versions',
      'data_migrations', 'dashboard', 'dashboards'],
  },
];

/** Longest-prefix match, so a more specific group always wins. */
function domainOf(tableName) {
  let best = null;
  let bestLen = -1;
  for (const d of DOMAINS) {
    for (const p of d.prefixes) {
      if (tableName === p || tableName.startsWith(p)) {
        if (p.length > bestLen) { best = d.key; bestLen = p.length; }
      }
    }
  }
  return best || 'other';
}

// =============================================================================
// THE GLOSSARY — plain English, only where it is genuinely known
// =============================================================================
//
// A note here is knowledge, not a guess. There are 321 tables and this covers
// about thirty: the ones at the centre of the system, which is what a person
// needs to orient themselves. A table with no note simply shows its real name —
// FAR better than a generated sentence that sounds confident and is wrong.
//
// It cannot go stale silently: the test asserts every key here is still a real
// table, so a rename fails the build rather than quietly dropping the note.
const GLOSSARY = {
  applications: 'One loan file — one property, one deal. Almost everything in the system hangs off this.',
  borrowers: 'The person. Kept apart from their login on purpose, so a problem with one cannot reach the other.',
  borrower_auth: 'The borrower’s login — password and two-factor only. Deliberately holds no personal details.',
  staff_users: 'The team roster. Also where an outside broker’s login lives, flagged as external.',
  llcs: 'The company a loan is taken in the name of. Despite the name it now holds corporations, partnerships and trusts too.',
  documents: 'Every document in the system, whoever uploaded it and wherever it is filed.',
  checklist_items: 'The conditions on a file — what is still needed before it can close.',
  checklist_templates: 'The master list the conditions are created from.',
  product_registrations: 'The priced structure of a deal at the moment it was registered — the numbers the term sheet was printed from.',
  notifications: 'Everything the system has told someone, in the app and by email.',
  audit_log: 'Who did what, and when. The record that answers questions years later.',
  appraisals: 'An appraisal report, and everything read out of it.',
  appraisal_comparables: 'The other properties an appraiser compared this one to.',
  credit_reports: 'A credit pull for one borrower, including the scores the deal was priced on.',
  track_records: 'Deals a borrower has done before — what their experience level is built from.',
  application_assignees: 'Who on the team is on which file, and in what role.',
  conditions: 'Conditions raised on a file outside the standard checklist.',
  sync_queue: 'Work waiting to be pushed out to ClickUp or another outside system.',
  sync_review_queue: 'Disagreements between us and an outside system that a person has to settle.',
  clickup_task_index: 'The link between a card in ClickUp and a loan file here.',
  encompass_loan_snapshot: 'A read-only copy of what Encompass holds for a loan. We never write back to it.',
  sitewire_property_links: 'The link between a loan file and its construction-draw project.',
  draw_findings: 'What an inspector found on site, and what it means for the money.',
  draw_disbursements: 'Money actually released on a draw, and the fee taken out of it.',
  closing_workflow: 'The run-up to the closing table for one file.',
  loan_exceptions: 'The register of policy exceptions — what was asked for, who approved it, and why.',
  properties: 'Every property the system has ever been shown, across all files.',
  property_observations: 'What one appraiser said about one property on one date. Never overwritten.',
  invite_tokens: 'Outstanding invitations — to join the team, or for a borrower to set up their login.',
  tpo_firms: 'The outside brokerages that bring us loans.',
  borrower_assistants: 'Someone a borrower has asked to help them with their file.',
  underwriting_runs: 'One complete automated read of a whole loan file.',
  document_findings: 'Something the system noticed in a document that a person should look at.',
  amc_orders: 'An appraisal ordered through an appraisal management company, and where that order has got to.',
  messages: 'Messages inside the system — between the team, and with a borrower or a broker.',
  finding_decisions: 'A human’s verdict on a finding, kept so it is never asked again.',
};

// =============================================================================
// SHAPING THE DATA
// =============================================================================

/** `"loan_amount numeric(14,2) NOT NULL DEFAULT 0"` → its three parts. */
function splitColumn(sig) {
  const s = String(sig);
  const name = s.split(' ')[0];
  const rest = s.slice(name.length).trim();
  const notNull = / NOT NULL(\s|$)/.test(' ' + rest);
  const m = rest.match(/\sDEFAULT\s(.+)$/);
  const type = rest.replace(/\s*NOT NULL/, '').replace(/\s*DEFAULT\s.+$/, '').trim();
  return { name, type, notNull, def: m ? m[1] : null };
}

/** `"FOREIGN KEY (borrower_id) REFERENCES borrowers(id) ON DELETE CASCADE"` → parts. */
function readForeignKey(fk) {
  const def = String(fk.definition || '');
  const cols = (def.match(/FOREIGN KEY \(([^)]*)\)/) || [])[1] || '';
  const onDelete = (def.match(/ON DELETE ([A-Z ]+)/) || [])[1] || 'NO ACTION';
  return {
    name: fk.name,
    from: fk.table,
    to: fk.references,
    columns: cols.split(',').map((c) => c.trim()).filter(Boolean),
    onDelete: onDelete.trim(),
  };
}

/**
 * Build the whole payload the page renders from.
 *
 * PURE — the snapshot object goes in, everything the page needs comes out — so
 * the grouping, the partition guarantee and the connection counts are testable
 * without a filesystem or a database.
 */
function buildPicture(inv) {
  const schema = inv.schema || {};
  const fks = (schema.foreignKeys || []).map(readForeignKey);

  const tables = new Map();
  for (const t of inv.tables || []) {
    tables.set(t.name, {
      name: t.name,
      domain: domainOf(t.name),
      note: GLOSSARY[t.name] || null,
      columns: (t.columns || []).map(splitColumn),
      pointsTo: [],
      pointedAtBy: [],
    });
  }

  // A FOREIGN KEY IS THE ANSWER TO TWO DIFFERENT QUESTIONS, and a person
  // looking at a table wants both: what does this depend on, and what would
  // break if I removed it. Both directions are recorded.
  for (const fk of fks) {
    const from = tables.get(fk.from);
    const to = tables.get(fk.to);
    if (from) from.pointsTo.push(fk);
    if (to) to.pointedAtBy.push(fk);
  }

  const list = [...tables.values()];
  for (const t of list) {
    t.links = t.pointsTo.length + t.pointedAtBy.length;
    // WHAT WOULD BE DELETED ALONGSIDE IT. `CASCADE` means the child rows go
    // when the parent does, which is the single most consequential thing a
    // link can say and the one no count would ever show.
    t.cascadesIn = t.pointedAtBy.filter((f) => f.onDelete === 'CASCADE').length;
  }

  // The spine: the tables everything else hangs off. Ranked by how connected
  // they are, because that is a measurement rather than an opinion.
  const spine = list.slice().sort((a, b) => b.links - a.links || a.name.localeCompare(b.name)).slice(0, 12);

  const groups = DOMAINS.map((d) => ({
    key: d.key,
    name: d.name,
    blurb: d.blurb,
    tables: list.filter((t) => t.domain === d.key).sort((a, b) => b.links - a.links || a.name.localeCompare(b.name)),
  })).filter((g) => g.tables.length);

  const leftovers = list.filter((t) => t.domain === 'other')
    .sort((a, b) => b.links - a.links || a.name.localeCompare(b.name));
  if (leftovers.length) {
    // NAMED, NEVER HIDDEN. A grouping that silently drops what it does not
    // recognise is how a picture starts lying about the thing it describes.
    groups.push({
      key: 'other',
      name: 'Everything else',
      blurb: 'Tables that do not fall into one of the groups above. They are '
        + 'listed here rather than left out — a picture that quietly drops what '
        + 'it does not recognise is worse than no picture.',
      tables: leftovers,
    });
  }

  const grouped = groups.reduce((n, g) => n + g.tables.length, 0);
  if (grouped !== list.length) {
    // Cannot happen — every table gets a domain and `other` catches the rest —
    // but "cannot happen" is exactly what this is for.
    throw new Error(`grouping lost tables: ${grouped} grouped of ${list.length}`);
  }

  return {
    counts: inv.counts || {},
    generatedFrom: inv.generatedFrom || {},
    tables: list.sort((a, b) => a.name.localeCompare(b.name)),
    groups,
    spine,
    enums: schema.enums || [],
    fkCount: fks.length,
    cascadeCount: fks.filter((f) => f.onDelete === 'CASCADE').length,
    setNullCount: fks.filter((f) => f.onDelete === 'SET NULL').length,
  };
}

// =============================================================================
// THE PAGE
// =============================================================================

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

const CSS = `
:root{
  --paper:#F6F3EC; --card:#FFFFFF; --ink:#141B22; --ink-2:#41505C; --ink-3:#6B7A85;
  --gold:#AE8746; --teal:#2F7F86; --line:#E2DCCD; --line-2:#EFEADF;
  --warn:#8A5A2B; --chip:#F1ECE0;
}
@media (prefers-color-scheme: dark){
  :root:not([data-theme="light"]){
    --paper:#10151A; --card:#171E25; --ink:#ECE7DC; --ink-2:#AFBAC2; --ink-3:#7E8C97;
    --gold:#D2A863; --teal:#5FB2B8; --line:#28323B; --line-2:#212A32;
    --warn:#D2A863; --chip:#1E262E;
  }
}
:root[data-theme="dark"]{
  --paper:#10151A; --card:#171E25; --ink:#ECE7DC; --ink-2:#AFBAC2; --ink-3:#7E8C97;
  --gold:#D2A863; --teal:#5FB2B8; --line:#28323B; --line-2:#212A32;
  --warn:#D2A863; --chip:#1E262E;
}
*{box-sizing:border-box}
/* The search bar is sticky, so anything jumped-to must clear it — otherwise
   opening a table scrolls its column headings underneath the bar. */
html{scroll-padding-top:92px}
details.tbl,details.grp{scroll-margin-top:92px}
body{
  margin:0; background:var(--paper); color:var(--ink);
  font:400 16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
  -webkit-font-smoothing:antialiased;
}
code,.mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace}
.wrap{max-width:1120px;margin:0 auto;padding:0 20px}
a{color:var(--teal)}

header.top{border-bottom:1px solid var(--line);background:var(--card)}
header.top .wrap{padding-top:44px;padding-bottom:36px}
.eyebrow{font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:var(--gold);font-weight:700;margin:0 0 12px}
h1{font-size:clamp(30px,4.4vw,46px);line-height:1.1;margin:0 0 14px;letter-spacing:-.02em;text-wrap:balance}
.lede{font-size:18px;color:var(--ink-2);max-width:66ch;margin:0 0 8px}
.stamp{font-size:13px;color:var(--ink-3);margin-top:18px}

.figs{display:grid;grid-template-columns:repeat(auto-fit,minmax(132px,1fr));gap:1px;background:var(--line);
      border:1px solid var(--line);border-radius:10px;overflow:hidden;margin:30px 0 0}
.fig{background:var(--card);padding:16px 18px}
.fig b{display:block;font-size:26px;font-weight:700;letter-spacing:-.01em;font-variant-numeric:tabular-nums}
.fig span{display:block;font-size:12.5px;color:var(--ink-3);margin-top:3px}

section{padding:44px 0 8px}
h2{font-size:25px;margin:0 0 8px;letter-spacing:-.015em}
h3{font-size:17px;margin:0 0 6px}
.sub{color:var(--ink-2);max-width:70ch;margin:0 0 22px}

.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:14px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px 18px}
.card .nm{font-size:14.5px;font-weight:600;word-break:break-all}
.card .note{font-size:14px;color:var(--ink-2);margin:8px 0 12px}
.card .meta{font-size:12.5px;color:var(--ink-3);display:flex;flex-wrap:wrap;gap:10px;
            border-top:1px solid var(--line-2);padding-top:10px;font-variant-numeric:tabular-nums}

.grp{background:var(--card);border:1px solid var(--line);border-radius:10px;margin-bottom:12px;overflow:hidden}
.grp>summary{cursor:pointer;padding:15px 18px;list-style:none;display:flex;align-items:baseline;
             gap:12px;flex-wrap:wrap}
.grp>summary::-webkit-details-marker{display:none}
.grp>summary::before{content:"▸";color:var(--gold);font-size:13px;line-height:1.7}
.grp[open]>summary::before{content:"▾"}
.grp>summary .gn{font-weight:650;font-size:17px}
.grp>summary .gc{font-size:13px;color:var(--ink-3);font-variant-numeric:tabular-nums}
.grp .body{padding:0 18px 16px;border-top:1px solid var(--line-2)}
.grp .blurb{color:var(--ink-2);font-size:14.5px;margin:14px 0 16px;max-width:70ch}

.tbl{border-top:1px solid var(--line-2)}
.tbl>summary{cursor:pointer;padding:9px 2px;list-style:none;display:flex;gap:12px;align-items:baseline;flex-wrap:wrap}
.tbl>summary::-webkit-details-marker{display:none}
.tbl .tn{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:13.5px;font-weight:600;word-break:break-all}
.tbl .tm{font-size:12px;color:var(--ink-3);margin-left:auto;white-space:nowrap;font-variant-numeric:tabular-nums}
.tbl .tnote{font-size:13.5px;color:var(--ink-2);flex-basis:100%;margin-top:-2px}
.detail{padding:6px 0 18px}
.scroll{overflow-x:auto;-webkit-overflow-scrolling:touch}
table.cols{border-collapse:collapse;width:100%;font-size:13px;min-width:520px}
table.cols th{text-align:left;font-size:11px;letter-spacing:.09em;text-transform:uppercase;
              color:var(--ink-3);font-weight:700;padding:6px 12px 6px 0;border-bottom:1px solid var(--line)}
table.cols td{padding:5px 12px 5px 0;border-bottom:1px solid var(--line-2);vertical-align:top}
table.cols td.c{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;word-break:break-all}
table.cols td.t{color:var(--ink-2);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px}
.req{color:var(--gold);font-size:11px;font-weight:700}
.links{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:16px;margin-top:16px}
.links h4{font-size:11px;letter-spacing:.09em;text-transform:uppercase;color:var(--ink-3);margin:0 0 7px}
.links ul{margin:0;padding:0;list-style:none;font-size:13px}
.links li{padding:3px 0;border-bottom:1px solid var(--line-2)}
.links .a{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12.5px;word-break:break-all}
.tag{display:inline-block;font-size:10.5px;font-weight:700;letter-spacing:.05em;padding:1px 6px;
     border-radius:4px;background:var(--chip);color:var(--ink-2);margin-left:6px;white-space:nowrap}
.tag.cascade{color:var(--warn)}

.search{position:sticky;top:0;z-index:5;background:var(--paper);padding:14px 0 12px;
        border-bottom:1px solid var(--line);margin-bottom:22px}
.search input{width:100%;padding:11px 14px;font-size:16px;color:var(--ink);background:var(--card);
              border:1px solid var(--line);border-radius:8px}
.search input:focus{outline:2px solid var(--teal);outline-offset:1px}
.hits{font-size:13px;color:var(--ink-3);margin-top:8px;min-height:1.2em}
:focus-visible{outline:2px solid var(--teal);outline-offset:2px}
footer{border-top:1px solid var(--line);margin-top:52px;padding:26px 0 60px;color:var(--ink-3);font-size:13.5px}
footer p{max-width:74ch;margin:0 0 9px}
@media (max-width:640px){ header.top .wrap{padding-top:30px;padding-bottom:26px} .tbl .tm{margin-left:0} }
`;

function renderTable(t) {
  const cols = t.columns.map((c) => `<tr><td class="c">${esc(c.name)}${c.notNull ? ' <span class="req">required</span>' : ''}</td>`
    + `<td class="t">${esc(c.type)}</td>`
    + `<td class="t">${c.def ? esc(c.def) : ''}</td></tr>`).join('');

  const out = t.pointsTo.length
    ? t.pointsTo.map((f) => `<li><span class="a">${esc(f.columns.join(', '))}</span> → <span class="a">${esc(f.to)}</span>`
      + `${f.onDelete !== 'NO ACTION' ? `<span class="tag${f.onDelete === 'CASCADE' ? ' cascade' : ''}">on delete ${esc(f.onDelete.toLowerCase())}</span>` : ''}</li>`).join('')
    : '<li style="color:var(--ink-3)">Nothing — this table stands on its own.</li>';

  const inn = t.pointedAtBy.length
    ? t.pointedAtBy.map((f) => `<li><span class="a">${esc(f.from)}</span>`
      + `${f.onDelete === 'CASCADE' ? '<span class="tag cascade">deleted with it</span>' : ''}</li>`).join('')
    : '<li style="color:var(--ink-3)">Nothing points at this table.</li>';

  return `<details class="tbl" data-name="${esc(t.name)}" data-note="${esc(t.note || '')}">
<summary><span class="tn">${esc(t.name)}</span>
<span class="tm">${t.columns.length} field${t.columns.length === 1 ? '' : 's'} · ${t.links} link${t.links === 1 ? '' : 's'}</span>
${t.note ? `<span class="tnote">${esc(t.note)}</span>` : ''}</summary>
<div class="detail">
  <div class="scroll"><table class="cols"><thead><tr><th>Field</th><th>Kind</th><th>Default</th></tr></thead><tbody>${cols}</tbody></table></div>
  <div class="links">
    <div><h4>Depends on</h4><ul>${out}</ul></div>
    <div><h4>Depended on by</h4><ul>${inn}</ul></div>
  </div>
</div></details>`;
}

function renderHtml(p) {
  const c = p.counts;
  const mig = (p.generatedFrom || {}).migrations || null;
  const built = mig
    ? `built from ${mig.count} migration files, up to db/${mig.highest}`
    : 'built from an unrecorded set of migrations';

  const fig = (n, label) => `<div class="fig"><b>${Number(n || 0).toLocaleString('en-US')}</b><span>${esc(label)}</span></div>`;

  const spine = p.spine.map((t) => `<div class="card">
    <div class="nm mono">${esc(t.name)}</div>
    <div class="note">${esc(t.note || 'No plain-English note for this one yet — the name is the real name in the database.')}</div>
    <div class="meta"><span>${t.columns.length} fields</span><span>${t.pointedAtBy.length} things depend on it</span><span>${t.pointsTo.length} it depends on</span></div>
  </div>`).join('');

  const groups = p.groups.map((g) => `<details class="grp">
    <summary><span class="gn">${esc(g.name)}</span><span class="gc">${g.tables.length} table${g.tables.length === 1 ? '' : 's'}</span></summary>
    <div class="body"><p class="blurb">${esc(g.blurb)}</p>${g.tables.map(renderTable).join('')}</div>
  </details>`).join('');

  const enums = p.enums.length
    ? `<section><div class="wrap"><h2>Fixed lists of choices</h2>
       <p class="sub">Where the database itself only allows a set list of values, rather than any text.</p>
       <div class="cards">${p.enums.map((e) => `<div class="card"><div class="nm mono">${esc(e.name)}</div>
       <div class="note">${esc(e.values)}</div></div>`).join('')}</div></div></section>`
    : '';

  return `<title>The PILOT database, in plain view</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>${CSS}</style>

<header class="top"><div class="wrap">
  <p class="eyebrow">PILOT · YS Capital</p>
  <h1>The database, in plain view</h1>
  <p class="lede">Every table in the system, what it holds, and what it is connected to.
  This is a picture of a copy — nothing here can change anything.</p>
  <div class="figs">
    ${fig(c.tables, 'tables')}
    ${fig(c.columns, 'fields')}
    ${fig(p.fkCount, 'connections')}
    ${fig(c.triggers, 'automatic rules')}
    ${fig(c.checkConstraints, 'value guards')}
    ${fig(c.indexes, 'lookups')}
  </div>
  <p class="stamp">Generated from the committed schema map — ${esc(built)}. Regenerate with <code>npm run schema:picture</code>; it needs no database.</p>
</div></header>

<section><div class="wrap">
  <h2>The spine</h2>
  <p class="sub">The tables the rest of the system hangs off, ranked by how much is connected to them.
  That ranking is measured from the connections themselves, not chosen.</p>
  <div class="cards">${spine}</div>
</div></section>

<section><div class="wrap">
  <h2>Everything, by what it is for</h2>
  <p class="sub">All ${Number(c.tables || 0).toLocaleString('en-US')} tables, grouped. Open a group, then open a table to see its
  fields and what it connects to. <strong>“Deleted with it”</strong> marks a connection where removing the
  parent record removes these too — the single most consequential thing a connection can say.</p>
  <div class="search">
    <input id="q" type="search" placeholder="Search for a table or a field — try: borrower, draw, appraisal" autocomplete="off" aria-label="Search tables and fields">
    <div class="hits" id="hits"></div>
  </div>
  <div id="groups">${groups}</div>
</div></section>

${enums}

<footer><div class="wrap">
  <p><strong>Where this comes from.</strong> It is generated from <code>docs/schema/beyond-prisma.json</code>,
  which is read straight out of the database’s own catalogue. Nothing on this page is typed by hand except
  the group names and the plain-English notes on the ${Object.keys(GLOSSARY).length} tables at the centre of the
  system — and a note is only written where it is genuinely known, because a confident wrong sentence is
  worse than a table name.</p>
  <p><strong>What it cannot tell you.</strong> This is the shape of the system, not what is in it. It holds no
  borrower, no loan, no document — only the names of the drawers they are filed in.</p>
</div></footer>

<script>
(function(){
  var q=document.getElementById('q'), hits=document.getElementById('hits');
  var rows=[].slice.call(document.querySelectorAll('details.tbl'));
  var groups=[].slice.call(document.querySelectorAll('details.grp'));
  var index=rows.map(function(r){
    return {el:r, hay:(r.getAttribute('data-name')+' '+r.getAttribute('data-note')+' '+r.textContent).toLowerCase()};
  });
  function run(){
    var s=q.value.trim().toLowerCase();
    if(!s){
      index.forEach(function(i){ i.el.style.display=''; i.el.open=false; });
      groups.forEach(function(g){ g.style.display=''; g.open=false; });
      hits.textContent=''; return;
    }
    var n=0;
    index.forEach(function(i){
      var m=i.hay.indexOf(s)>=0;
      i.el.style.display=m?'':'none';
      if(m) n++;
    });
    groups.forEach(function(g){
      var any=g.querySelectorAll('details.tbl:not([style*="none"])').length;
      g.style.display=any?'':'none';
      g.open=!!any;
    });
    hits.textContent=n+(n===1?' table matches':' tables match')+' “'+q.value.trim()+'”';
  }
  q.addEventListener('input',run);
})();
</script>`;
}

function main() {
  let inv;
  try {
    inv = JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8'));
  } catch (e) {
    console.error(`schema-picture: could not read ${path.relative(process.cwd(), SNAPSHOT)} (${e.message})`);
    console.error('  Generate it first with:  DATABASE_URL=… npm run schema:snapshot');
    process.exit(1);
  }

  const p = buildPicture(inv);
  console.log(`schema-picture: ${p.tables.length} tables in ${p.groups.length} groups, `
    + `${p.fkCount} connections (${p.cascadeCount} delete their children, ${p.setNullCount} unlink them)`);

  if (process.argv.includes('--print')) return;

  const html = renderHtml(p);
  fs.writeFileSync(OUT_FILE, html);
  console.log(`schema-picture: wrote ${path.relative(process.cwd(), OUT_FILE)} `
    + `(${(Buffer.byteLength(html) / 1024).toFixed(0)} KB, opens in any browser, no internet needed)`);
}

if (require.main === module) main();

module.exports = { buildPicture, domainOf, splitColumn, readForeignKey, DOMAINS, GLOSSARY, OUT_FILE };
