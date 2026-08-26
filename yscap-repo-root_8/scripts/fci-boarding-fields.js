#!/usr/bin/env node
'use strict';
/**
 * THE FCI BOARDING FIELD INVENTORY — GENERATED, NEVER HAND-MAINTAINED.
 *
 * `insertBoarding` is the one mutation that starts servicing: it is how a closed loan becomes a
 * loan FCI services. It carries ~130 fields across five blocks, and getting ONE of them wrong on a
 * live loan is not a rendering bug — it is a borrower billed the wrong amount, or interest
 * accruing on the wrong balance for the life of the file. So the field list this repo maps against
 * has to come from FCI's own published collection, not from anybody's reading of it.
 *
 * THIS SCRIPT IS THE EXTRACTOR. It reads the pinned snapshot (docs/fci/collection-snapshot.json,
 * the same INPUT scripts/fci-api-catalog.js reads) and writes docs/fci/BOARDING-FIELDS.md: every
 * boarding field, which block it belongs to, the sample value FCI ships for it, the type that
 * sample implies, and the enum legend when FCI publishes one.
 *
 * IT READS THREE SOURCES AND THEY DISAGREE. FCI ships the boarding structure three times over, and
 * the three copies are NOT the same document:
 *
 *   1. the folder documentation      (the prose sample on the "Boarding Loans" folder)
 *   2. the saved single-loan request (the request body of "Boarding a Loan")
 *   3. the saved bulk request        (the request body of "Boarding Multiple Loans", an array form)
 *
 * Reading only one of them loses fields, and the differences are load-bearing rather than
 * cosmetic — the folder doc spells the reinstatement approval `approvaleReinstatement` while the
 * saved request spells it `approvalReinstatement`; `deliveryOptions` appears only in the saved
 * request; `loanType` and `originalVendor` appear only in the doc and the bulk form. One of those
 * spellings is what the server accepts and we cannot know which without a live call, so the
 * inventory carries BOTH and says where each one came from. A generator that quietly picked one
 * would be inventing the answer.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. It does not say what PILOT should put in any field — that is a
 * decision, it lives in src/fci/boarding-map.js, and scripts/test-fci-boarding-map-pure.js proves
 * the decisions and this inventory still cover each other exactly. Keeping the two apart is the
 * point: FCI owns the field list, we own the mapping, and neither can drift without the build
 * noticing.
 *
 * TWO MODES:
 *   node scripts/fci-boarding-fields.js          regenerate docs/fci/BOARDING-FIELDS.md
 *   node scripts/fci-boarding-fields.js --check  regenerate into memory; exit 1 if the file differs
 *
 * NO NETWORK, EVER. Re-pinning the snapshot is scripts/fci-api-catalog.js --fetch's job. This
 * script only ever reads files already in the repository, holds no credential, and cannot call FCI.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SNAPSHOT = path.join(ROOT, 'docs', 'fci', 'collection-snapshot.json');
const OUTPUT = path.join(ROOT, 'docs', 'fci', 'BOARDING-FIELDS.md');

// The five blocks of the boarding payload, in the order FCI writes them. `loan` is the object
// itself; the other four are arrays of sub-objects, and a field name can legitimately repeat
// across blocks (`street`, `city`, `trustAccount`, `rateType` all do), which is why every row in
// the inventory is keyed by block AND name rather than by name alone.
const BLOCKS = ['loan', 'setBorrower', 'setLenders', 'setProperties', 'setFundings'];

function htmlToText(html) {
  return String(html)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
}

/**
 * Walk the collection and return every string that carries an insertBoarding PAYLOAD, tagged with
 * where it came from. Walking beats hard-coded item indexes: FCI reorders its folders between
 * releases, and an index that silently points at the wrong request is exactly the failure the
 * pinned-snapshot design exists to prevent.
 *
 * `insertBoarding` alone is not the test. FCI's saved RESPONSE bodies echo the mutation name back
 * (`{"data":{"insertBoarding":"test-23b0c368f8"}}`) and matching on the name alone pulled those in
 * as if they were field sources — which is how the first run of this script reported 146 fields
 * instead of the real count, having read a response's `data` and `insertBoarding` keys as boarding
 * fields. The payload is what carries `insertLoan`, so that is what is matched.
 */
function boardingSources(node, where, out) {
  if (Array.isArray(node)) {
    node.forEach((v, i) => boardingSources(v, `${where}/${i}`, out));
    return out;
  }
  if (node && typeof node === 'object') {
    for (const k of Object.keys(node)) boardingSources(node[k], `${where}/${k}`, out);
    return out;
  }
  if (typeof node === 'string' && node.includes('insertBoarding') && /insertLoan\s*:/.test(node)) {
    // A saved EXAMPLE repeats its own request verbatim (response[].originalRequest). Keeping both
    // copies would double every field's provenance list for no information, so the example's copy
    // is skipped and the request it echoes is the one that counts.
    if (where.includes('/originalRequest/')) return out;
    const isDoc = where.endsWith('/description');
    const text = isDoc ? htmlToText(node) : node;
    // The bulk form takes an ARRAY of loans (`insertLoan: [ { … } ]`); the single form takes one
    // object. They carry different field sets, so the two are told apart and labelled separately.
    const isBulk = /insertLoan\s*:\s*\[/.test(text);
    out.push({ where, label: isDoc ? 'folder documentation' : isBulk ? 'saved bulk request' : 'saved request', text });
  }
  return out;
}

/**
 * FCI's enum legends do NOT live with the boarding structure. They sit in sibling folder
 * descriptions — "Loan Variables", "Property Variables", "Borrower Variables", "Funding
 * Variables" — so collecting only the descriptions that mention insertBoarding finds none of them.
 * This walks the whole collection and keeps every description that reads like a legend: a heading
 * line followed by `NAME = value` pairs.
 */
function legendTexts(node, out) {
  if (Array.isArray(node)) { node.forEach((v) => legendTexts(v, out)); return out; }
  if (node && typeof node === 'object') {
    for (const k of Object.keys(node)) {
      if (k === 'description' && typeof node[k] === 'string') {
        const text = htmlToText(node[k]);
        // Two `=` pairs is enough to be a legend and few enough to catch the short ones
        // (deliveryOptions has four entries, AgreementeTemplate has four).
        if ((text.match(/^\s*[A-Za-z0-9_ ]+\s*=\s*[A-Za-z0-9_]+\s*,?\s*$/gm) || []).length >= 2) out.push(text);
      } else {
        legendTexts(node[k], out);
      }
    }
    return out;
  }
  return out;
}

/**
 * Parse one boarding mutation into { block, name, sample } rows.
 *
 * The payload is GraphQL argument syntax, not JSON — no quoted keys, commas optional, and FCI's
 * own samples are inconsistent about both. So this tracks brace/bracket depth rather than trying to
 * JSON.parse anything: a `name:` at the depth of the insertLoan object is a loan field, and one
 * inside `setBorrower:[{ … }]` belongs to that block. Anything that is not a plain `name: value`
 * pair — the mutation header, the closing braces — simply never matches.
 */
function parseBoarding(text) {
  const rows = [];
  let block = null;
  // Depth is counted from the first `{` after insertLoan:, so the loan object sits at depth 1 and
  // a sub-object inside one of the four arrays sits at depth 2.
  let depth = 0;
  let started = false;
  const lines = text.replace(/\r/g, '').split('\n');
  for (const raw of lines) {
    const line = raw.trim();
    if (!started) {
      if (/insertLoan\s*:/.test(line)) started = true;
      // `insertLoan: {` and `insertLoan: [` can open on the same line as the key.
      if (started) { depth += (line.match(/[{[]/g) || []).length - (line.match(/[}\]]/g) || []).length; }
      continue;
    }
    const opensBlock = line.match(/^(set[A-Za-z]+)\s*:\s*\[?\{?\s*$/);
    const opens = (line.match(/[{[]/g) || []).length;
    const closes = (line.match(/[}\]]/g) || []).length;
    if (opensBlock) {
      block = opensBlock[1];
      depth += opens - closes;
      continue;
    }
    // A bare `{`, `}`, `[`, `]`, `)` line only moves depth. When the depth falls back to the loan
    // object's own level, whichever array we were inside has closed and we are back on the loan.
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.+?),?\s*$/);
    if (m && !/^(mutation|query)$/.test(m[1])) {
      const name = m[1];
      const sample = m[2].replace(/[,\s]+$/, '');
      // A key whose value opens a block (`setFundings: [`) was handled above; anything else that
      // opens a brace here is a shape this parser has not seen, and guessing at it would put a
      // half-read field in the inventory. Recording it as-is keeps it visible instead.
      rows.push({ block: block || 'loan', name, sample });
    }
    depth += opens - closes;
    if (depth <= 1) block = null;
    if (depth <= 0) break;
  }
  return rows;
}

/**
 * The type a sample value implies. FCI publishes no schema, so this is inference from its own
 * samples and it is labelled as such in the output — `12.3` is a decimal, `"08/25/2020"` is a
 * date-shaped string, `BROKER` is an unquoted enum token. The distinction that matters most is the
 * last one: FCI's enums go OUT as bare tokens or integers and come BACK as display strings, which
 * is hazard #5 in the blueprint and the reason the inventory records the outbound form.
 */
function inferType(sample) {
  const s = String(sample).trim();
  if (/^(true|false)$/i.test(s)) return 'boolean';
  if (/^"\d{1,2}\/\d{1,2}\/\d{2,4}"$/.test(s)) return 'date (MM/DD/YYYY string)';
  if (/^".*"$/.test(s)) return 'string';
  if (/^-?\d+\.\d+$/.test(s)) return 'decimal';
  if (/^-?\d+$/.test(s)) return 'integer';
  if (/^[A-Z][A-Z0-9_]*$/.test(s)) return 'enum token (unquoted)';
  return 'unknown';
}

/**
 * FCI's enum legends live in the folder documentation as loose `LABEL = value` / `value = LABEL`
 * lists under a heading. Both orders appear — `FULLY_AMORTIZED = 1` but `0 = EIN` — so both are
 * read, and the heading is matched to a field name case-insensitively. Two headings do not match
 * their field name and are mapped explicitly; everything else is found by name.
 */
const LEGEND_ALIASES = {
  // The property block's field is `type`; FCI heads its legend just "Type" under Property Variables.
  Type: 'setProperties.type',
  // The funding block's field carries an EnumValue suffix the legend heading drops.
  AgreementeTemplate: 'setFundings.agreementeTemplateEnumValue',
};

function parseLegends(docTexts) {
  const legends = new Map();
  for (const text of docTexts) {
    const lines = text.replace(/\r/g, '').split('\n');
    let heading = null;
    let items = [];
    const flush = () => {
      if (heading && items.length) {
        const key = LEGEND_ALIASES[heading] || heading;
        // The heading is kept alongside the values. FCI documents `RateType` once, under Loan
        // Variables, but the funding block has a `rateType` too — attaching the list without
        // saying where it came from would present an inference as FCI's own word on the funding
        // field. Naming the heading lets the reader see the match for what it is.
        if (!legends.has(key)) legends.set(key, { heading, items: items.slice() });
      }
      heading = null; items = [];
    };
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      // `NAME = 1,` or `NAME = 1` or `1 = NAME`. The label may START with a digit — FCI's
      // LienPosition legend reads `1st = 1`, `2nd = 2`, and a pattern that insisted on a leading
      // letter dropped that whole legend silently, which is why the label side accepts digits.
      const pair = line.match(/^([A-Za-z0-9_][A-Za-z0-9_ ]*?)\s*=\s*([A-Za-z0-9_]+)\s*,?$/);
      // `DUE_TO_DUE_FIXED = 0 → Regular Period (Due Date to Due Date)` — FCI annotates one legend
      // with what each value MEANS. The arrow half is kept: it is the only place the accrual
      // methods are explained in words.
      const arrow = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(\d+)\s*(?:→|->)\s*(.+)$/);
      if (arrow) { items.push(`${arrow[1]} = ${arrow[2]} — ${arrow[3]}`); continue; }
      if (pair) { items.push(`${pair[1].trim()} = ${pair[2]}`); continue; }
      // A non-pair line ends the current legend and may start the next one.
      flush();
      if (/^[A-Za-z][A-Za-z0-9_]*$/.test(line)) heading = line;
    }
    flush();
  }
  return legends;
}

function legendFor(legends, block, name) {
  const qualified = `${block}.${name}`;
  if (legends.has(qualified)) return legends.get(qualified);
  for (const [k, v] of legends) {
    if (k.includes('.')) continue;
    if (k.toLowerCase() === name.toLowerCase()) return v;
  }
  return null;
}

// FCI heads each legend inside one of four "…Variables" folders. A legend whose heading was
// documented for a DIFFERENT block than the field it is being shown against is an inference on our
// part, not FCI's statement, and the output says so.
const LEGEND_BLOCK = {
  LienPosition: 'loan', AmortizationType: 'loan', RateType: 'loan', PaymentFrequency: 'loan',
  PrimaryPurpose: 'loan', noteType: 'loan', accruedMethod: 'loan', approvalPayoff: 'loan',
  approvalChangeFeesTerms: 'loan', approvaleReinstatement: 'loan', approvalStartForeclosure: 'loan',
  tinType: 'setBorrower', deliveryOptions: 'setBorrower',
  Type: 'setProperties', OccupancyStatus: 'setProperties',
  AgreementeTemplate: 'setFundings',
};

function buildInventory() {
  if (!fs.existsSync(SNAPSHOT)) {
    throw new Error(`missing ${path.relative(ROOT, SNAPSHOT)} — run scripts/fci-api-catalog.js --fetch to pin it`);
  }
  const collection = JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8'));
  const sources = boardingSources(collection, '', []);
  if (!sources.length) throw new Error('no insertBoarding mutation found in the pinned snapshot');

  // block+name -> { block, name, sample, type, seenIn:Set }
  const byKey = new Map();
  const docTexts = legendTexts(collection, []);
  for (const src of sources) {
    for (const row of parseBoarding(src.text)) {
      const key = `${row.block}.${row.name}`;
      if (!byKey.has(key)) {
        byKey.set(key, { block: row.block, name: row.name, sample: row.sample, seenIn: new Set() });
      }
      byKey.get(key).seenIn.add(src.label);
    }
  }

  const legends = parseLegends(docTexts);
  const rows = [...byKey.values()].map((r) => ({
    block: r.block,
    name: r.name,
    sample: r.sample,
    type: inferType(r.sample),
    seenIn: [...r.seenIn].sort(),
    legend: legendFor(legends, r.block, r.name),
  }));
  rows.sort((a, b) => (BLOCKS.indexOf(a.block) - BLOCKS.indexOf(b.block)) || a.name.localeCompare(b.name));
  return { rows, sources: sources.map((s) => ({ label: s.label, where: s.where })) };
}

function render({ rows, sources }) {
  const L = [];
  L.push('# FCI boarding fields — every field `insertBoarding` accepts');
  L.push('');
  L.push('**GENERATED — do not edit.** Written by `scripts/fci-boarding-fields.js` from');
  L.push('`docs/fci/collection-snapshot.json`, FCI\'s own published Postman collection. Run');
  L.push('`node scripts/fci-boarding-fields.js --check` to prove this file still matches the snapshot;');
  L.push('`node scripts/fci-api-catalog.js --fetch` re-pins the snapshot when FCI ships a release.');
  L.push('');
  L.push('This file is the FIELD LIST only. What PILOT puts in each field is a decision and lives in');
  L.push('`src/fci/boarding-map.js`; `scripts/test-fci-boarding-map-pure.js` proves the two cover each');
  L.push('other exactly, so a field FCI adds cannot go unmapped and a mapping cannot name a field that');
  L.push('does not exist.');
  L.push('');
  L.push('## In numbers');
  L.push('');
  for (const b of BLOCKS) {
    const n = rows.filter((r) => r.block === b).length;
    if (n) L.push(`- \`${b}\` — **${n}** fields`);
  }
  const legendPublished = rows.filter((r) => r.legend && LEGEND_BLOCK[r.legend.heading] === r.block).length;
  const legendInferred = rows.filter((r) => r.legend && LEGEND_BLOCK[r.legend.heading] !== r.block).length;
  L.push(`- **${rows.length}** fields in total`);
  L.push(`- **${legendPublished}** carry an enum legend FCI published for that block`
    + (legendInferred
      ? `, and **${legendInferred}** ${legendInferred === 1 ? 'carries' : 'carry'} one matched by name from another block (flagged inline as our inference)`
      : ''));
  L.push('');
  L.push('## Where the field list came from');
  L.push('');
  L.push('FCI ships the boarding structure more than once and the copies are not identical, so all of');
  L.push('them are read and every field records which copies carry it. A field seen in only one copy is');
  L.push('not necessarily wrong — but it is not confirmed either, and the `Seen in` column is the only');
  L.push('honest way to say so without a live call.');
  L.push('');
  L.push('| Copy | Path in the collection |');
  L.push('|---|---|');
  for (const s of sources) L.push(`| ${s.label} | \`${s.where}\` |`);
  L.push('');

  for (const b of BLOCKS) {
    const inBlock = rows.filter((r) => r.block === b);
    if (!inBlock.length) continue;
    L.push(`## \`${b}\``);
    L.push('');
    L.push('| Field | Type (inferred from FCI\'s sample) | FCI\'s sample value | Seen in |');
    L.push('|---|---|---|---|');
    for (const r of inBlock) {
      L.push(`| \`${r.name}\` | ${r.type} | \`${r.sample}\` | ${r.seenIn.join(', ')} |`);
    }
    L.push('');
  }

  const withLegend = rows.filter((r) => r.legend);
  if (withLegend.length) {
    L.push('## Enum legends FCI publishes');
    L.push('');
    L.push('These are the OUTBOUND forms — what a boarding payload sends. FCI\'s read side returns the');
    L.push('same concepts as display strings, which is why nothing may round-trip an enum by assuming');
    L.push('what went in is what comes back.');
    L.push('');
    for (const r of withLegend) {
      L.push(`### \`${r.block}.${r.name}\``);
      L.push('');
      const documentedFor = LEGEND_BLOCK[r.legend.heading];
      if (documentedFor && documentedFor !== r.block) {
        L.push(`> FCI documents this list as **${r.legend.heading}**, under the \`${documentedFor}\` block. Applying it`);
        L.push(`> to \`${r.block}.${r.name}\` is OUR inference from the shared field name — FCI has not published a`);
        L.push('> legend for this block\'s copy. Confirm it before boarding anything live.');
        L.push('');
      }
      for (const item of r.legend.items) L.push(`- ${item}`);
      L.push('');
    }
  }
  return L.join('\n') + '\n';
}

function main(argv) {
  const check = argv.includes('--check');
  const rendered = render(buildInventory());
  if (check) {
    const onDisk = fs.existsSync(OUTPUT) ? fs.readFileSync(OUTPUT, 'utf8') : '';
    if (onDisk !== rendered) {
      const at = (() => {
        const a = onDisk.split('\n'); const b = rendered.split('\n');
        for (let i = 0; i < Math.max(a.length, b.length); i++) if (a[i] !== b[i]) return i + 1;
        return 0;
      })();
      process.stderr.write(
        `${path.relative(ROOT, OUTPUT)} does not match the pinned snapshot — they diverge at line ${at}.\n`
        + 'It is GENERATED: run `node scripts/fci-boarding-fields.js` instead of editing it.\n');
      process.exit(1);
    }
    process.stdout.write(`${path.relative(ROOT, OUTPUT)} matches the snapshot.\n`);
    return;
  }
  fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
  fs.writeFileSync(OUTPUT, rendered);
  process.stdout.write(`wrote ${path.relative(ROOT, OUTPUT)} (${rendered.length} bytes)\n`);
}

if (require.main === module) main(process.argv.slice(2));

module.exports = { buildInventory, parseBoarding, inferType, BLOCKS };
