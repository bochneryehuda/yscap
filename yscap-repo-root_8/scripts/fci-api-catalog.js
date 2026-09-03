#!/usr/bin/env node
'use strict';
/**
 * THE FCI API CATALOGUE — GENERATED, NEVER HAND-MAINTAINED.
 *
 * FCI Lender Services publishes its integration documentation as a PUBLIC Postman collection at
 * https://integrate.myfci.com/. That page is a single-page app, so a human (or an agent) reading
 * the rendered HTML gets a title and nothing else — but the app fetches ONE JSON document that
 * contains every folder, every request, every saved GraphQL query, every filter description and
 * every sample response. That document is the whole API surface, and it is the thing this script
 * reads.
 *
 * WHY A GENERATOR AND NOT A HAND-WRITTEN REFERENCE. A hand-typed list of 66 GraphQL operations and
 * ~700 field names is wrong the day FCI ships v9. Worse, it is wrong SILENTLY: nothing fails, a
 * field just quietly stops existing and some report renders blank. So the reference in
 * `docs/fci/API-CATALOG.md` is OUTPUT. The INPUT is `docs/fci/collection-snapshot.json`, a pinned
 * copy of FCI's own published collection, and `--check` proves the two still agree. Edit the
 * markdown by hand and the build tells you.
 *
 * THREE MODES:
 *   node scripts/fci-api-catalog.js            regenerate docs/fci/API-CATALOG.md from the snapshot
 *   node scripts/fci-api-catalog.js --check     regenerate into memory; exit 1 if the file on disk
 *                                               differs (this is what the test runs)
 *   node scripts/fci-api-catalog.js --fetch     re-pin the snapshot from FCI's live published
 *                                               collection FIRST, then regenerate. Run this when
 *                                               FCI announces a release; commit both files.
 *
 * IT TALKS TO NOBODY BY DEFAULT. Without `--fetch` this script makes no network call at all, so it
 * is safe in CI, safe offline, and its output depends only on files in this repository.
 *
 * IT IS DOCUMENTATION MACHINERY, NOT AN INTEGRATION. It holds no credential, reads no database,
 * and cannot call FCI's API — the published collection is world-readable and needs no key. Nothing
 * here can move money or touch a loan.
 */

const fs = require('fs');
const path = require('path');

// FCI's published collection. The owner id + published id are FCI's own, taken from the
// <meta> tags the documentation page serves; they change only if FCI re-publishes the collection
// under a new link, which is exactly when `--fetch` would fail loudly instead of drifting quietly.
const COLLECTION_URL =
  'https://integrate.myfci.com/api/collections/13291498/TzseH5wM?segregateAuth=true&versionTag=latest';

const ROOT = path.resolve(__dirname, '..');
const SNAPSHOT = path.join(ROOT, 'docs', 'fci', 'collection-snapshot.json');
const OUTPUT = path.join(ROOT, 'docs', 'fci', 'API-CATALOG.md');

// A base64 run this long in a saved example is a sample PDF attachment, not API surface. FCI's
// collection carries one of ~40KB. Keeping it would make the snapshot unreadable and its diffs
// useless, so it is replaced on the way in — and the replacement SAYS what was removed, because a
// silently shortened document is the thing this repo does not do.
const B64_RUN = /[A-Za-z0-9+/]{300,}={0,2}/g;

function scrubBase64(v) {
  if (typeof v === 'string') {
    return v.replace(B64_RUN, (m) => `<base64 sample attachment, ${m.length} chars, removed from the pinned snapshot>`);
  }
  if (Array.isArray(v)) return v.map(scrubBase64);
  if (v && typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v)) o[k] = scrubBase64(v[k]);
    return o;
  }
  return v;
}

// ---------------------------------------------------------------------------
// Reading the collection
// ---------------------------------------------------------------------------

/** Postman stores descriptions as a string OR as { content, type }. One reader for both. */
function descriptionOf(node) {
  const d = node && (node.description !== undefined ? node.description : null);
  if (!d) return '';
  return typeof d === 'string' ? d : String(d.content || '');
}

/**
 * FCI writes its documentation as HTML inside those descriptions — tables of filters, enum
 * legends, the whole data dictionary. Rendering it as text keeps it readable in markdown without
 * dragging an HTML parser into the build. Deliberately small and total: it never throws, and the
 * worst case is a slightly ugly line, not a lost one.
 */
function htmlToText(html) {
  return String(html || '')
    .replace(/<\/(tr|p|li|h[1-6]|div|table|blockquote)>/gi, '\n')
    .replace(/<\/t[dh]>/gi, ' | ')
    .replace(/<li>/gi, '- ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&rsquo;|&lsquo;/g, "'")
    .replace(/&ldquo;|&rdquo;/g, '"')
    .replace(/&hellip;/g, '...')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** The request URL, whichever of Postman's two shapes it is stored in. */
function urlOf(req) {
  if (!req) return '';
  const u = req.url;
  if (!u) return '';
  return typeof u === 'string' ? u : String(u.raw || '');
}

/**
 * The GraphQL query FCI actually saved for a request.
 *
 * NOT `request.body` — that is empty on most of this collection. FCI documents each operation by
 * SAVING AN EXAMPLE, and the query lives on the example's `originalRequest`. A reader that looks
 * only at `request.body` sees 66 endpoints with no fields, which is precisely the wrong answer.
 */
function queryOfExample(example) {
  const b = example && example.originalRequest && example.originalRequest.body;
  if (!b) return { kind: 'none', text: '' };
  if (b.mode === 'graphql' && b.graphql) return { kind: 'graphql', text: String(b.graphql.query || '') };
  if (b.mode === 'formdata' && Array.isArray(b.formdata)) {
    return {
      kind: 'formdata',
      text: b.formdata.map((f) => `${f.key}: ${f.type === 'file' ? '<file>' : f.value}`).join('\n'),
    };
  }
  if (b.raw) return { kind: 'raw', text: String(b.raw) };
  return { kind: 'none', text: '' };
}

/** The root GraphQL operation names a query/mutation invokes — the thing you actually call. */
function rootFields(queryText) {
  const found = [];
  const re = /\b(get[A-Za-z0-9_]+|insert[A-Za-z0-9_]+)\s*[({\n]/g;
  let m;
  while ((m = re.exec(queryText)) !== null) if (!found.includes(m[1])) found.push(m[1]);
  return found;
}

/** Walk the collection into a flat list of operations, each remembering its folder path. */
function collectOperations(items, folderPath, out) {
  for (const it of items || []) {
    if (Array.isArray(it.item)) {
      collectOperations(it.item, folderPath.concat(it.name), out);
      continue;
    }
    const req = it.request || {};
    const examples = (it.response || []).map((ex) => {
      const q = queryOfExample(ex);
      return {
        name: String(ex.name || ''),
        code: ex.code || null,
        status: ex.status || null,
        url: urlOf(ex.originalRequest) || urlOf(req),
        bodyKind: q.kind,
        body: q.text,
        response: String(ex.body || ''),
      };
    });
    const primary = examples.find((e) => e.body) || examples[0] || null;
    out.push({
      folder: folderPath.join(' / '),
      name: String(it.name || ''),
      method: String(req.method || ''),
      url: (primary && primary.url) || urlOf(req),
      description: htmlToText(descriptionOf(req)),
      roots: primary ? rootFields(primary.body) : [],
      examples,
    });
  }
  return out;
}

/** Every folder that carries documentation of its own — FCI's data dictionaries live here. */
function collectFolderNotes(items, folderPath, out) {
  for (const it of items || []) {
    if (!Array.isArray(it.item)) continue;
    const text = htmlToText(descriptionOf(it));
    const p = folderPath.concat(it.name);
    if (text) out.push({ folder: p.join(' / '), text });
    collectFolderNotes(it.item, p, out);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Writing the catalogue
// ---------------------------------------------------------------------------

/**
 * How much of a saved RESPONSE this file prints.
 *
 * FCI's examples repeat the same row shape hundreds of times — one of them is 137KB of loan notes.
 * The SHAPE is what a reader needs (field names, date formats, the `"n/a"` sentinel, whether a
 * number arrives as a number or a string), and a few rows carry all of it. The rest is bulk that
 * makes the catalogue unusable. So a long response is cut, and the cut SAYS how much was cut and
 * where the whole thing still is — a truncation nobody can see is the thing this repo does not do.
 */
const RESPONSE_CHARS = 3000;

function clipResponse(text) {
  const t = String(text || '');
  if (t.length <= RESPONSE_CHARS) return t;
  return `${t.slice(0, RESPONSE_CHARS)}\n\n... truncated: ${t.length} characters in total. `
    + 'The complete example is in docs/fci/collection-snapshot.json.';
}

function fence(text, lang) {
  const t = String(text || '').replace(/\s+$/, '');
  if (!t) return '';
  // A body that itself contains a fence would break the block; back-tick runs are widened to suit.
  const longest = (t.match(/`+/g) || []).reduce((a, b) => Math.max(a, b.length), 0);
  const bars = '`'.repeat(Math.max(3, longest + 1));
  return `${bars}${lang || ''}\n${t}\n${bars}\n`;
}

function render(collection) {
  const ops = collectOperations(collection.item, [], []);
  const notes = collectFolderNotes(collection.item, [], []);
  const overview = htmlToText(descriptionOf(collection.info || {}));

  const hosts = {};
  for (const o of ops) {
    const h = (o.url.match(/^https?:\/\/([^/]+)/) || [])[1];
    if (h) hosts[h] = (hosts[h] || 0) + 1;
  }

  const L = [];
  L.push('# FCI API — the complete published surface');
  L.push('');
  L.push('**GENERATED FILE — do not edit by hand.** `node scripts/fci-api-catalog.js` rebuilds it');
  L.push('from `docs/fci/collection-snapshot.json`, a pinned copy of FCI\'s own public Postman');
  L.push('collection (<https://integrate.myfci.com/>). `npm test` re-runs the generator and fails if');
  L.push('this file has drifted from it, so a hand edit cannot survive. To take up a new FCI release:');
  L.push('`node scripts/fci-api-catalog.js --fetch` and commit both files.');
  L.push('');
  L.push('What this file is FOR: knowing, without guessing, which call answers a question, what it');
  L.push('returns, what it can be filtered by, and how fresh the answer is. The design that uses it —');
  L.push('the workflow, the ownership rules, the reminders — is `docs/FCI-SERVICING-INTEGRATION-RESEARCH.md`.');
  L.push('');
  L.push('## In numbers');
  L.push('');
  L.push('| | |');
  L.push('|---|---|');
  L.push(`| Operations documented | ${ops.length} |`);
  L.push(`| Distinct GraphQL root fields | ${new Set(ops.flatMap((o) => o.roots)).size} |`);
  L.push(`| Saved examples (query + response) | ${ops.reduce((n, o) => n + o.examples.length, 0)} |`);
  L.push(`| Folder-level data dictionaries | ${notes.length} |`);
  for (const h of Object.keys(hosts).sort()) L.push(`| Requests against \`${h}\` | ${hosts[h]} |`);
  L.push('');
  L.push('## FCI\'s own overview page');
  L.push('');
  L.push(fence(overview));
  L.push('## Operation index');
  L.push('');
  L.push('| Folder | Request | Root field | Host |');
  L.push('|---|---|---|---|');
  for (const o of ops) {
    const host = (o.url.match(/^https?:\/\/([^/]+)/) || [])[1] || '';
    const pathPart = o.url.replace(/^https?:\/\/[^/]+/, '');
    L.push(`| ${o.folder || '(root)'} | ${o.name} | ${o.roots.map((r) => '`' + r + '`').join(', ') || '_(REST)_'} | \`${host}${pathPart === '/graphql' ? '' : pathPart}\` |`);
  }
  L.push('');
  L.push('## Folder documentation (FCI\'s data dictionaries and enum legends)');
  L.push('');
  for (const n of notes) {
    L.push(`### ${n.folder}`);
    L.push('');
    L.push(fence(n.text));
  }
  L.push('## Every operation in full');
  L.push('');
  for (const o of ops) {
    L.push(`### ${o.folder ? o.folder + ' / ' : ''}${o.name}`);
    L.push('');
    L.push(`- **Method / URL:** \`${o.method} ${o.url}\``);
    if (o.roots.length) L.push(`- **Root field:** ${o.roots.map((r) => '`' + r + '`').join(', ')}`);
    L.push('');
    if (o.description) {
      L.push('**FCI\'s notes (filters, parameters, enum legends):**');
      L.push('');
      L.push(fence(o.description));
    }
    for (const ex of o.examples) {
      L.push(`**Example — ${ex.name}**`);
      L.push('');
      if (ex.body) L.push(fence(ex.body, ex.bodyKind === 'graphql' ? 'graphql' : ''));
      if (ex.response) L.push(fence(clipResponse(ex.response), 'json'));
    }
  }
  return L.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\s*$/, '\n');
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function refetch() {
  process.stdout.write(`[fci-catalog] fetching ${COLLECTION_URL}\n`);
  const r = await fetch(COLLECTION_URL, { headers: { Accept: 'application/json' } });
  if (!r.ok) throw new Error(`FCI returned HTTP ${r.status} for the published collection`);
  const json = await r.json();
  if (!json || !Array.isArray(json.item)) {
    throw new Error('the fetched document is not a Postman collection (no `item` array) — FCI may have re-published under a new link');
  }
  fs.writeFileSync(SNAPSHOT, JSON.stringify(scrubBase64(json), null, 1) + '\n');
  process.stdout.write(`[fci-catalog] re-pinned ${path.relative(ROOT, SNAPSHOT)}\n`);
}

async function main() {
  const argv = process.argv.slice(2);
  const check = argv.includes('--check');
  if (argv.includes('--fetch')) await refetch();

  if (!fs.existsSync(SNAPSHOT)) {
    throw new Error(`missing ${path.relative(ROOT, SNAPSHOT)} — run with --fetch to pin it`);
  }
  const collection = JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8'));
  const rendered = render(collection);

  if (check) {
    const onDisk = fs.existsSync(OUTPUT) ? fs.readFileSync(OUTPUT, 'utf8') : null;
    if (onDisk === rendered) {
      process.stdout.write('[fci-catalog] docs/fci/API-CATALOG.md matches the pinned collection\n');
      return;
    }
    process.stderr.write(
      '[fci-catalog] FAIL: docs/fci/API-CATALOG.md does NOT match what the pinned collection generates.\n'
      + '  The catalogue is generated output. Either it was edited by hand (undo that), or the\n'
      + '  snapshot/generator changed and the file was not rebuilt.\n'
      + '  Fix: node scripts/fci-api-catalog.js\n');
    process.exitCode = 1;
    return;
  }

  fs.writeFileSync(OUTPUT, rendered);
  process.stdout.write(`[fci-catalog] wrote ${path.relative(ROOT, OUTPUT)} (${rendered.length} bytes)\n`);
}

if (require.main === module) {
  main().catch((e) => {
    process.stderr.write(`[fci-catalog] ${e && e.message ? e.message : e}\n`);
    process.exit(1);
  });
}

module.exports = { render, htmlToText, rootFields, queryOfExample, scrubBase64, COLLECTION_URL, SNAPSHOT, OUTPUT };
