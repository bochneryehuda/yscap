'use strict';
/**
 * LONG-TERM — THE WAYS A CONDITION IS ANSWERED WHEN A DOCUMENT IS NOT THE ONLY WAY.
 *
 * Three conditions in this library are not "upload the thing". The owner
 * described each of them as a CHOICE, and the choice is the whole point:
 *
 *   · the subject property's mortgage — *"also has the option, instead of an
 *     upload, to be a form to type in a few pieces of information … and also you
 *     can just select that it's FCI, whatever, and then you don't need anything,
 *     not an attachment and not a form."*
 *
 *   · every mortgage on the credit report — *"every line item on a mortgage you
 *     should be able to upload a mortgage statement and/or you can select this is
 *     linked to his primary … and/or you should be able to satisfy it with typing
 *     in an address."*
 *
 * ── WHY THIS IS ITS OWN MODULE ──────────────────────────────────────────────
 *
 * TWO QUESTIONS HAVE TO AGREE OR THE CONDITION IS A TRAP: "may this be recorded"
 * (the write door) and "does what is recorded finish the condition" (the sign-off
 * gate). Written twice they drift, and the drift is silent in both directions —
 * a door that accepts an answer the gate does not honour leaves a person clicking
 * a button that changes nothing, and a gate that honours an answer the door never
 * validated signs a condition off on a half-filled form. So both call THIS.
 *
 * ── THE RULE THAT MATTERS MOST: ALL OF A WAY, OR NONE OF IT ─────────────────
 *
 * A payoff figure with no servicer, or a servicer with no loan number, is not a
 * substitute for a mortgage statement — it is a PARTIAL answer that reads as a
 * complete one, and it reads that way to the loan-setup person who then has
 * nothing to key in. Every field a way declares is required, and a way that is
 * short of one is refused NAMING the field, never accepted quietly.
 *
 * ── AND NOTHING HERE EVER DECIDES WHAT IS A MORTGAGE ────────────────────────
 *
 * Which liabilities are mortgages is proposed from the credit report and settled
 * by a PERSON (`library.js` config `classify: 'propose_only'`). A mis-classified
 * line either chases a borrower for a statement they do not owe or lets a real
 * mortgage through unasked, so this module answers only about the lines it is
 * HANDED and never about which lines there should be.
 *
 * PURE. No database, no network, no config. SEPARATION: `lt_*` only — it names
 * no short-term table, module or route.
 */

/** A way that needs nothing beyond being chosen. */
const NOTHING_MORE = [];

/**
 * THE WAYS, PER CONDITION CODE — the one table.
 *
 * `fields` are ALL required (see the header). `label` is what a person reading
 * the condition sees, and `why` is shown under a refusal so the next step is
 * never a guess.
 */
const WAYS = Object.freeze({
  // ── The mortgage on the property being refinanced ──────────────────────────
  lt_subject_mortgage_statement: {
    mode: 'choice',
    ways: [
      {
        key: 'statement',
        label: 'Upload the mortgage statement',
        needsDocument: 'statement',
        fields: NOTHING_MORE,
      },
      {
        key: 'typed',
        label: 'Type the loan in instead',
        // ALL THREE. The loan-setup person keys these into Encompass, and two of
        // the three is not something they can key in.
        fields: [
          { key: 'outstanding_balance', label: 'Outstanding principal balance', type: 'money' },
          { key: 'servicer', label: 'Servicer', type: 'text' },
          { key: 'loan_number', label: 'Loan number', type: 'text' },
        ],
      },
      {
        key: 'fci_serviced',
        label: 'This refinances one of our own short-term loans, serviced by FCI',
        // Nothing else is asked BECAUSE we already hold everything a statement
        // would say: we originated the loan and we service it.
        why: 'We originated this loan and we service it, so we already hold everything a statement would tell us.',
        fields: NOTHING_MORE,
      },
    ],
  },

  // ── Every mortgage on the credit report, one line at a time ────────────────
  lt_reo_liabilities: {
    mode: 'per_line',
    ways: [
      {
        key: 'statement',
        label: 'Upload a statement for this mortgage',
        needsDocument: true,          // tagged with the line's own key
        fields: NOTHING_MORE,
      },
      {
        key: 'primary',
        label: 'This is the mortgage on the home they live in',
        // The owner: *"if you mark it as primary then you don't need more
        // information"* — their own address is already on the file.
        fields: NOTHING_MORE,
      },
      {
        key: 'address',
        label: 'Say which property it is secured by',
        // The owner: *"if you're putting in any other property address you need
        // to put in if it's an investment or a second home and if it's an
        // investment you need to put in the rental income."*
        fields: [
          { key: 'address', label: 'Property address', type: 'address' },
          { key: 'occupancy', label: 'Investment or second home', type: 'choice', options: ['investment', 'second_home'] },
        ],
        // Asked only when the answer above makes it meaningful. A second home
        // earns no rent, so asking for it would be asking for a number that does
        // not exist — and a zero typed to get past a form is worse than a blank.
        conditionalFields: [
          { key: 'monthly_rent', label: 'Monthly rent', type: 'money', when: { field: 'occupancy', is: 'investment' } },
        ],
      },
    ],
  },
});

/** What ways this condition offers, or null when it is an ordinary condition. */
function plan(condition) {
  const code = String((condition && condition.code) || '');
  return WAYS[code] || null;
}

/** One way by key, or null. Never invents a way. */
function wayFor(condition, key) {
  const p = plan(condition);
  if (!p) return null;
  return p.ways.find((w) => w.key === String(key || '')) || null;
}

/** Is a value present? A blank string, null and undefined are all "not answered".
    ZERO IS PRESENT — an outstanding balance of exactly 0 is a real answer (the
    loan is paid down to nothing), and reading it as missing would refuse it. */
function has(v) {
  if (v === null || v === undefined) return false;
  if (typeof v === 'string') return v.trim() !== '';
  if (typeof v === 'number') return Number.isFinite(v);
  if (typeof v === 'object') return Object.keys(v).length > 0;
  return true;
}

/** A money field must be a real, non-negative number — never text, never NaN. */
function moneyProblem(label, v) {
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[$,\s]/g, ''));
  if (!Number.isFinite(n)) return `${label} needs to be a number.`;
  if (n < 0) return `${label} cannot be negative.`;
  return null;
}

/** Which fields a way asks for, given what has been answered so far. */
function fieldsFor(way, values) {
  const base = Array.isArray(way.fields) ? way.fields.slice() : [];
  for (const f of way.conditionalFields || []) {
    const w = f.when || {};
    if (values && String(values[w.field] || '') === String(w.is)) base.push(f);
  }
  return base;
}

/**
 * Is this ONE answer complete?
 *
 * @returns {null|string} null when it is, otherwise the sentence to show. Never
 *   throws — an unrecognised shape is refused in words, not by an exception.
 */
function wayProblem(condition, way, values, opts = {}) {
  if (!way) return 'That is not one of the ways this condition can be answered.';
  const v = values && typeof values === 'object' ? values : {};

  for (const f of fieldsFor(way, v)) {
    if (!has(v[f.key])) return `${f.label} is needed before this counts as answered.`;
    if (f.type === 'money') {
      const p = moneyProblem(f.label, v[f.key]);
      if (p) return p;
    }
    if (f.type === 'choice' && !(f.options || []).includes(String(v[f.key]))) {
      return `${f.label} has to be one of: ${(f.options || []).join(', ')}.`;
    }
    if (f.type === 'address' && !has(v[f.key])) return `${f.label} is needed.`;
  }

  // A way that says it needs a document needs an ACCEPTED one. `opts.hasDocument`
  // is the caller's answer about the documents actually on the condition — this
  // module never reads a database.
  if (way.needsDocument && !opts.hasDocument) {
    return 'Upload the statement, or choose one of the other ways to answer this.';
  }
  return null;
}

/**
 * VALIDATE AN INCOMING ANSWER before it is recorded.
 *
 * `answer` is the whole shape the screen posts:
 *   choice   → { way, values }
 *   per_line → { lines: { <lineKey>: { way, values } } }
 *
 * @returns {null|string} null when it may be recorded.
 */
function answerProblem(condition, answer, opts = {}) {
  const p = plan(condition);
  if (!p) return 'This condition is not answered that way.';
  const a = answer && typeof answer === 'object' ? answer : {};

  if (p.mode === 'choice') {
    const way = wayFor(condition, a.way);
    if (!way) return 'Choose how you want to answer this condition.';
    return wayProblem(condition, way, a.values, { hasDocument: opts.hasDocument });
  }

  if (p.mode === 'per_line') {
    const lines = a.lines && typeof a.lines === 'object' ? a.lines : {};
    for (const key of Object.keys(lines)) {
      const entry = lines[key] || {};
      const way = wayFor(condition, entry.way);
      if (!way) return 'One of the mortgages has no way chosen.';
      const hasDoc = !!(opts.documentsByLine && opts.documentsByLine[key]);
      const problem = wayProblem(condition, way, entry.values, { hasDocument: hasDoc });
      // NAME THE LINE. "Monthly rent is needed" over a list of eight mortgages
      // tells nobody which one to go and fix.
      if (problem) return `${opts.lineLabels && opts.lineLabels[key] ? `${opts.lineLabels[key]}: ` : ''}${problem}`;
    }
    return null;
  }

  return 'This condition is not answered that way.';
}

/**
 * DOES WHAT IS RECORDED FINISH THE CONDITION?
 *
 * The sign-off gate's question. It is deliberately STRICTER than
 * `answerProblem`: recording a partial answer as you go is fine, finishing on one
 * is not.
 *
 * `ctx.lines` — for a per-line condition, every line that MUST be answered (the
 * ones a person marked as a mortgage). A condition with no mortgages on it is
 * ANSWERED, not blocked: a borrower with no mortgages has nothing to send.
 *
 * @returns {{ok: true} | {ok: false, why: string}}
 */
function satisfies(condition, answer, ctx = {}) {
  const p = plan(condition);
  if (!p) return { ok: true };                     // not our business
  const a = answer && typeof answer === 'object' ? answer : {};

  if (p.mode === 'choice') {
    if (!has(a.way)) {
      return { ok: false, why: `Choose how to answer this: ${p.ways.map((w) => w.label).join('; or ')}.` };
    }
    const problem = answerProblem(condition, a, ctx);
    return problem ? { ok: false, why: problem } : { ok: true };
  }

  if (p.mode === 'per_line') {
    const lines = Array.isArray(ctx.lines) ? ctx.lines : [];
    if (!lines.length) return { ok: true };        // nothing to answer
    const answered = a.lines && typeof a.lines === 'object' ? a.lines : {};
    const missing = [];
    for (const line of lines) {
      const key = String(line.key || line);
      const entry = answered[key];
      if (!entry || !has(entry.way)) { missing.push(line.label || key); continue; }
      const way = wayFor(condition, entry.way);
      const hasDoc = !!(ctx.documentsByLine && ctx.documentsByLine[key]);
      if (wayProblem(condition, way, entry.values, { hasDocument: hasDoc })) missing.push(line.label || key);
    }
    if (missing.length) {
      const shown = missing.slice(0, 4).join(', ');
      const more = missing.length > 4 ? `, and ${missing.length - 4} more` : '';
      return {
        ok: false,
        why: `${missing.length} mortgage${missing.length === 1 ? '' : 's'} still ${missing.length === 1 ? 'needs' : 'need'} an answer: ${shown}${more}.`,
      };
    }
    return { ok: true };
  }

  return { ok: true };
}

/** Every code this module governs — so a test can assert the library and this
    table describe the same conditions rather than drifting into two lists. */
const GOVERNED_CODES = Object.freeze(Object.keys(WAYS));

module.exports = {
  WAYS, GOVERNED_CODES, plan, wayFor, answerProblem, satisfies,
  _internals: { has, moneyProblem, fieldsFor, wayProblem },
};
