'use strict';
/**
 * THE PUBLISHED CONDITION LIST, GENERATED FROM THE LIBRARY — never hand-kept.
 *
 * Owner-directed 2026-08-31: *"Look for missing conditions from the original
 * list."* Every one of the 28 on that list was on the file; what had gone wrong
 * was the LIST — it still showed three condo documents where the owner's own
 * condo letter asks for four, and it had never heard of the payoff contact
 * added since. A page somebody has to remember to update is a page that goes
 * stale silently, and this one is the page the owner reads to decide whether
 * anything is missing, so a stale copy is worse than no copy at all.
 *
 * So it is DERIVED. The label, the wording the borrower sees, who sees it, what
 * kind of thing it is, which files get it and every document slot come straight
 * out of `src/longterm/conditions-center/library.js`; the design is the shell
 * the owner already has (`page/shell-*.html`), untouched. Add a condition and
 * it appears here on the next run with nobody having to remember.
 *
 * TWO THINGS ARE NOT DERIVABLE and are written down instead, in ONE table each:
 *   · WAYS — a handful of conditions are satisfied in alternative ways rather
 *     than by filling every slot, and nothing in the library says so in words.
 *   · CHIP_HELP — the hover wording on the two tags.
 * `scripts/test-lt-condition-sets-page-pure.js` fails the build if either table
 * names a condition that no longer exists, so neither can rot either.
 *
 *   node src/longterm/conditions-center/page/build.js [outfile]
 */
const fs = require('fs');
const path = require('path');

const lib = require('../library');
const registry = require('../field-registry');

const SHELL = __dirname;

/* ── the alternative-satisfaction blurbs, keyed on the condition ──────────── */
const WAYS = {
  lt_reo_liabilities: {
    lead: 'Each mortgage is answered one of three ways — not a form to fill in:',
    ways: [
      ['Upload a statement for this mortgage', 'nothing further'],
      ['This is the mortgage on the home they live in', 'nothing further'],
      ['Say which property it is secured by', 'property address, investment or second home, monthly rent, the last only when it applies'],
    ],
  },
  lt_subject_mortgage_statement: {
    lead: 'Answered one of three ways — a document is only one of them:',
    ways: [
      ['Upload the mortgage statement', 'nothing further'],
      ['Type the loan in instead', 'outstanding principal balance, servicer, loan number'],
      ['This refinances one of our own short-term loans, serviced by FCI', 'nothing further'],
    ],
  },
};

const CHIP_HELP = {
  borrower: 'The borrower sees this on their own screen, in their own wording. We see it too.',
  internal: 'Only our team sees this. The borrower is never shown it.',
  document: 'a file gets uploaded',
  form: 'boxes filled in on screen',
  order: 'an email goes out to an outside company',
  esign: 'it goes out for signature',
};
const KIND_LABEL = { document: 'Document upload', form: 'Form', order: 'Order', esign: 'DocuSign' };

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/* ── which files get it, in words a person can read ──────────────────────────
   The FIELD's own label is used, never its key. The published page said
   "Applies to in_flood_zone is yes" on four conditions and "It is a refinance
   is yes" on the rest — the same sentence written two ways because half of it
   was typed by hand. One reader, one wording. */
const OPS = { is_true: 'is yes', is_false: 'is no', eq: 'is', neq: 'is not' };
function fieldLabel(key) {
  const f = (registry.FIELDS || []).find((x) => x.key === key);
  return f && f.label ? f.label : key;
}
function ruleText(rule) {
  if (!rule || !Array.isArray(rule.rules) || !rule.rules.length) return 'Every file.';
  const join = rule.combinator === 'or' ? ' or ' : ' and ';
  return `${rule.rules.map((r) => {
    const op = OPS[r.operator] || r.operator;
    return `${fieldLabel(r.field)} ${op}${r.value == null || r.value === '' ? '' : ` ${r.value}`}`;
  }).join(join)}.`;
}

function slotsHtml(cond) {
  const slots = cond.slots || [];
  if (!slots.length) return '';
  const li = slots.map((s) => {
    const notes = [];
    if (s.required === false && !/\(optional\)\s*$/i.test(s.label)) notes.push('optional');
    if (s.whenField) notes.push(`only when ${fieldLabel(s.whenField)}`);
    if (s.notWhenField) notes.push(`not when ${fieldLabel(s.notWhenField)}`);
    return `<li>${esc(s.label)}${notes.length ? ` <em>(${esc(notes.join(', '))})</em>` : ''}</li>`;
  }).join('');
  return `<ul class="slots">${li}</ul>`;
}

function waysHtml(cond) {
  const w = WAYS[cond.code];
  if (!w) return '';
  const li = w.ways.map(([what, note]) => `<li>${esc(what)} <em>(${esc(note)})</em></li>`).join('');
  return `<p class="why"><strong>${esc(w.lead)}</strong></p><ul class="slots ways">${li}</ul>`;
}

function card(cond) {
  const seesBorrower = cond.audience === 'both' || cond.audience === 'borrower';
  const who = seesBorrower
    ? `<span class="chip teal" title="${esc(CHIP_HELP.borrower)}">Borrower sees it</span>`
    : `<span class="chip slate" title="${esc(CHIP_HELP.internal)}">Internal only</span>`;
  const kind = `<span class="chip gold" title="${esc(CHIP_HELP[cond.kind] || '')}">${esc(KIND_LABEL[cond.kind] || cond.kind)}</span>`;
  const alias = seesBorrower && cond.borrowerLabel
    ? `\n  <p class="alias"><span>They see it as</span> ${esc(cond.borrowerLabel)}</p>` : '';
  return `<article class="cond">
  <div class="cond-h">
    <h3>${esc(cond.label)}</h3>
    <div class="chips">${who}${kind}</div>
  </div>
  <p class="why">${esc(cond.hint)}</p>${alias}
  <p class="when"><span>Applies to</span> ${esc(ruleText(cond.rule))}</p>
  ${waysHtml(cond) || slotsHtml(cond)}
</article>`;
}

function tally(list) {
  const borrower = list.filter((c) => c.audience === 'both' || c.audience === 'borrower').length;
  const kinds = {};
  for (const c of list) kinds[c.kind] = (kinds[c.kind] || 0) + 1;
  return { total: list.length, borrower, internal: list.length - borrower, kinds };
}

function gate(id, title, blurb, list) {
  const t = tally(list);
  const kindLine = Object.entries(t.kinds)
    .map(([k, n]) => `<li><b>${n}</b> ${esc((KIND_LABEL[k] || k).toLowerCase())}</li>`).join('');
  return `<section class="gate" id="${id}">
  <header class="gate-h">
    <h2>${esc(title)}</h2>
    <p>${esc(blurb)}</p>
    <ul class="tally">
      <li><b>${t.total}</b> conditions</li>
      <li><b>${t.borrower}</b> the borrower sees</li>
      <li><b>${t.internal}</b> internal only</li>
    </ul>
    <ul class="tally quiet">${kindLine}</ul>
  </header>
  <div class="conds">${list.map(card).join('\n')}</div>
</section>`;
}

function build() {
  const sub = lib.PRIOR_TO_SUBMISSION;
  const ctc = lib.PRIOR_TO_CTC;
  const all = [...sub, ...ctc];
  const t = tally(all);

  const head = fs.readFileSync(path.join(SHELL, 'shell-head.html'), 'utf8');
  const hero = fs.readFileSync(path.join(SHELL, 'shell-hero.html'), 'utf8')
    .replace('{{TOTAL}}', String(t.total))
    .replace('{{BORROWER}}', String(t.borrower))
    .replace('{{INTERNAL}}', String(t.internal));
  const close = fs.readFileSync(path.join(SHELL, 'shell-close.html'), 'utf8');

  return `${head}${hero}
${gate('prior_to_submission', 'Prior to submission',
    'Everything that has to be true before the file goes to the investor.', sub)}
${gate('prior_to_ctc', 'Prior to clear to close',
    'Everything the investor wants back before they will clear it.', ctc)}
${close}</div>
`;
}

module.exports = { build, card, WAYS, CHIP_HELP, ruleText, tally };

if (require.main === module) {
  const out = process.argv[2] || path.join(__dirname, '..', '..', '..', '..', 'docs', 'longterm', 'condition-sets.html');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, build());
  const t = tally([...lib.PRIOR_TO_SUBMISSION, ...lib.PRIOR_TO_CTC]);
  console.log(`wrote ${out} — ${t.total} conditions (${t.borrower} the borrower sees, ${t.internal} internal only)`);
}
