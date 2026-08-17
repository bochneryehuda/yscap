#!/usr/bin/env node
'use strict';
/** Generate the developer-facing 500 report from the measured sweep, so the table can never drift
 *  from the measurement. Reads sweep-500-results.json; writes the markdown doc into the repo. */
const fs = require('fs');
const SC = '/tmp/claude-0/-home-user-yscap/6db8aea0-0d3b-522c-933a-d7a7206af179/scratchpad/';
const OUT = '/home/user/yscap/yscap-repo-root_8/docs/longterm/ppe-research/SEARCHRAW-FIELD-CONTRACT.md';

const res = JSON.parse(fs.readFileSync(SC + 'sweep-500-results.json', 'utf8'));
const good = JSON.parse(fs.readFileSync(SC + 'searchraw-request.json', 'utf8'));
const getP = (o, p) => p.split('.').reduce((c, k) => (c == null ? undefined : c[k]), o);

const rows = {};
for (const [k, v] of Object.entries(res)) {
  const i = k.lastIndexOf('|');
  const p = k.slice(0, i), m = k.slice(i + 1);
  (rows[p] = rows[p] || {})[m] = v;
}
const paths = Object.keys(rows).sort();
const probes = Object.keys(res).length;
const refusals = Object.values(res).filter((v) => v !== 200).length;

// How many leaves the known-good body actually has — so a partial run cannot be mistaken for a
// complete contract. A table that silently covers half the request is worse than no table: it reads
// as "these are the fields that matter" when it only means "these are the ones we got to".
function leafPaths(o, p = '', out = []) {
  if (o && typeof o === 'object' && !Array.isArray(o)) { for (const k of Object.keys(o)) leafPaths(o[k], p ? p + '.' + k : k, out); }
  else if (p) out.push(p);
  return out;
}
const totalLeaves = leafPaths(good).length;
const complete = paths.length >= totalLeaves;

const cell = (v) => (v === undefined ? '·' : v === 200 ? 'ok' : String(v));
const valOf = (p) => {
  const v = getP(good, p);
  const s = JSON.stringify(v);
  return s === undefined ? '—' : (s.length > 40 ? s.slice(0, 37) + '…' : s);
};

const strict = paths.filter((p) => Object.values(rows[p]).some((v) => v !== 200));
const free = paths.filter((p) => !Object.values(rows[p]).some((v) => v !== 200));

let md = `# searchRaw — the measured field contract

**What this is.** Lender Price answers a request it cannot process with a bare
\`{"status":500,"error":"Internal Server Error","message":"500 "}\` — no field name, no reason. The
only way to learn which values it refuses is to ask it, one field at a time, against a body that is
otherwise proven to price. That is what this table is: every leaf of a known-good request, probed
three ways against the live tenant.

**This file is GENERATED from the measurement** (\`sweep-500-results.json\`). Do not hand-edit it —
re-run the sweep and regenerate, or the table and the truth drift apart.

**Method.** Control = the captured frontend request, posted verbatim → HTTP 200. Then for each leaf:

| probe | meaning |
| --- | --- |
| \`null\` | the leaf set to JSON null — "may this field be null?" |
| \`delete\` | the leaf removed entirely — "is this field required?" |
| \`empty\` | \`""\` / \`[]\` / \`0\` / \`false\` by type — "may this field be blank?" |

\`ok\` = still HTTP 200. A number = the status the vendor answered. \`·\` = not probed (the empty probe
is skipped where the good value is already empty).

**Coverage: ${probes} probes over ${paths.length} of the request's ${totalLeaves} leaves; ${refusals} refusals.**

${complete ? '' : `> **⚠ THIS RUN IS INCOMPLETE — ${totalLeaves - paths.length} of ${totalLeaves} leaves have not been probed yet.**
> Every row below is measured and true. What is NOT here is not evidence of anything: an absent
> field has not been cleared, it has not been asked about. Do not read section 2 as "these are safe"
> until the coverage line above reads ${totalLeaves} of ${totalLeaves}.
`}

---

## 1. The fields that BREAK the request — hand this list to Lender Price

These are the leaves where at least one probe stopped the search from working. For each, we would
like to know from the vendor: is the field genuinely required, what is the permitted value set, and
what SHOULD a caller send when it has nothing to say?

| field | good value | null | delete | empty |
| --- | --- | --- | --- | --- |
`;
for (const p of strict) md += `| \`${p}\` | \`${valOf(p)}\` | ${cell(rows[p].NULL)} | ${cell(rows[p].DELETE)} | ${cell(rows[p].EMPTY)} |\n`;

md += `
### What the pattern says

- **A \`400\` is a real validation error** — the vendor read the request and told us what was wrong.
  Those are the good ones. Everything else is a \`500\`, which means the request reached code that
  did not expect it.
- **\`@class\` markers are structural.** \`rateRange.@class\` and \`brokerCriteria.rangeComplan.@class\`
  refuse null, blank and removal alike. They are Jackson polymorphic type tags: without them the
  vendor cannot decide which class to build, and it fails before any business rule runs.
- **An enum may not be an empty string.** Every \`""\` refusal in the table is a field whose value is
  drawn from a fixed list; blank is not a member of that list.
- **A list may not be null**, even where an empty list is accepted.

---

## 2. The fields that tolerate every probe we ran${complete ? '' : ' SO FAR'}

Proven harmless — worth recording so they stop being suspected during the next outage.
${complete ? '' : '**Partial run: this list will grow as the remaining leaves are probed.**'}

<details><summary>${free.length} leaves, all probes returned HTTP 200</summary>

`;
for (const p of free) md += `- \`${p}\`\n`;
md += `
</details>

---

## 3. What we already fixed on our side, and what it was

Each of these was measured, not reasoned about.

1. **We were posting the wrong document.** \`GET /pricing/defaultSearch\` returns the company's
   CONFIGURATION model; the browser transforms it into a request before calling \`searchRaw\`. Our
   builder cloned it and posted it as-is whenever a live foundation was available — which is every
   time in production. 8,576 bytes, 203 structural differences from the working request, HTTP 500 on
   every scenario. Now the request is always built from the captured working request, and the live
   model contributes values only, through a strict normalizer.
2. **\`criteria.mortgageTypes\` arrived null** on that configuration model, and the table above shows
   null there is a 500. That single leaf was the trigger. It is now forced.
3. **The shadow/canary path priced a different location than the real pricer.** \`validateScenario\`
   is what fills county and state in from a ZIP, and only one of the three callers ran it — so the
   comparison that governs the cutover was measuring two different requests. Validation and
   enrichment moved inside \`price()\`, where no caller can skip them.
4. **A saved company preference could change what kind of search we ran** — a live model turned
   \`loanType\` into ARM and \`mortgageTypes\` into FHA on a DSCR search, with no error. The five
   fields that define a DSCR investor search are now forced last.
5. **The address went out untyped** — a lowercase state, a county FIPS as a number (losing a leading
   zero), an object where a county name belongs.

## 4. Still open — the questions for Lender Price

1. **\`criteria.fico\`**: null → 500 AND removed → 500. So a search must always carry a credit score.
   Is that intended? What should a caller send when the score is genuinely not yet known?
2. **\`dynamicPropertiesMap.DSCRRATIO\`**: we generate it on every DSCR request; the captured working
   request does not contain the key at all. What is it for, when does the frontend add it, and what
   are the permitted values?
3. **The special mortgage option \`Prepay Buyout\`** (id \`5f64dbe6ce8ad00001f91b69\`) is in every
   working request we have; we replace it with a DSCR-band option that carries **no id**. Is the
   band option real, and should Prepay Buyout always be present?
4. **Prepay option ids** for No/1/2/4/5-year PPP were inferred from the one confirmed 3-year id being
   \`…dd63\`. Please confirm the real ids — a wrong id changes the price silently.
5. **Product counts.** The same scenario returns 17 programs / 439 priced rows from the website. We
   need the same numbers from the API before this can be trusted, and any request-shape difference
   that would explain a gap.
`;
fs.mkdirSync(require('path').dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, md);
console.log('wrote ' + OUT + '  (' + md.length + ' bytes, ' + strict.length + ' refusing leaves, ' + free.length + ' clean)');
