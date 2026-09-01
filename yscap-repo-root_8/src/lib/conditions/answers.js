/**
 * THE CONDITIONS THAT ARE A CHOICE, NOT AN UPLOAD — SHARED.
 *
 * MOVED HERE FROM src/longterm/conditions-center/ (2026-08-30) because the ONE
 * sign-off gate has to read it. While it lived under src/longterm/, the shared
 * gate could not require it — RTL code may not reach into the side build, and
 * rightly so — and the result was measurable: the Long-Term door let the owner's
 * own answer through while the shared gate refused the very same condition for
 * want of a document. Two gates, two answers, one condition. The rule is the
 * owner's, it is pure, and both products' gates now read this one copy.
 * ── THE WAYS A CONDITION IS ANSWERED WHEN A DOCUMENT IS NOT THE ONLY WAY ────
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
/* WHO FCI IS, in the one place. It is written onto the answer rather than asked
   for, so every reader downstream — the payoff order, the person keying Encompass
   — sees a servicer on an FCI answer exactly as it sees one on a typed answer,
   and no screen has to know that this way is special. */
const FCI_SERVICER = 'FCI Lender Services';

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
        /* THE SERVICER ANSWERS ITSELF; THE TWO NUMBERS DO NOT. Owner-directed
           2026-08-31: *"if you're putting in that it's FCI then the servicer
           automatically selects it to be FCI, and our processor needs to go into
           FCI and look for the FCI loan number and put it in, and outstanding
           balance."*

           SUPERSEDES the first reading of this way, which asked for nothing at
           all on the grounds that we service the loan. We do — which is exactly
           why the numbers are OBTAINABLE, not why they are unnecessary: the
           loan-setup person still has to key a loan number and a balance into
           Encompass, and neither of them is in this file. What being the servicer
           removes is the QUESTION of who it is, and that is what `fixed` says. */
        why: 'We originated this loan and we service it — look the loan number and the balance up in FCI.',
        fixed: { servicer: FCI_SERVICER },
        fields: [
          { key: 'loan_number', label: 'FCI loan number', type: 'text' },
          { key: 'outstanding_balance', label: 'Outstanding principal balance', type: 'money' },
        ],
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
        /* ── THE MORTGAGE ON THE PROPERTY WE ARE REFINANCING ────────────────
           Owner-directed 2026-08-31: *"One of the options when you select hey
           this is a mortgage one of the option should be this is a mortgage
           related to subject property … do the research for the exact wording.
           … It should only come up if it's a refinance transaction."*

           THE WORDING. Encompass and the URLA call a lien against the property
           being financed a SUBJECT PROPERTY LIEN, and mark it "to be paid off at
           or before closing". "Subject property" is the term every processor,
           underwriter and closer already uses, so the label uses it and the
           parenthetical says what it means for anybody who does not.

           NO FIELDS, for the same reason `primary` asks for none: the address is
           the file's own subject property, which is already on the loan. Asking
           somebody to type an address PILOT is holding is how two versions of one
           address end up on a file.

           REFINANCE ONLY. `refinanceOnly` is read by the caller that knows the
           deal — `conditions-center/workspace.js` — rather than here, because
           this module is deliberately pure and is shared by both products. On a
           purchase there IS no subject-property mortgage, so offering it would
           invite an answer that cannot be true. */
        key: 'subject_property',
        label: 'This is the mortgage on the subject property (the loan being refinanced)',
        why: 'It is secured by the property this loan refinances, so it is paid off at closing — '
          + 'the statement is collected once, on the subject-property mortgage condition, rather than twice.',
        refinanceOnly: true,
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

/**
 * DOES THIS WAY APPLY TO THIS DEAL?
 *
 * ONE definition, read by BOTH halves — the screen that offers the ways and the
 * door that records an answer. Written twice they drift, and the drift here is
 * the expensive kind: a way hidden from the screen but still accepted by the
 * door is one somebody can post from a stale tab, an old bundle or a script, and
 * "this is the mortgage on the subject property" posted on a PURCHASE is a claim
 * about a loan that does not exist.
 *
 * FAILS CLOSED. `refinanceOnly` needs `isRefinance === true` — not merely "not
 * false". A file whose purpose PILOT cannot read yet is not a refinance as far
 * as anybody can prove, and offering the option there invites an answer nobody
 * can stand behind. The option appears the moment the purpose does.
 */
function wayApplies(way, deal = {}) {
  if (!way) return false;
  if (way.refinanceOnly) return deal.isRefinance === true;
  return true;
}

/** The ways this condition offers FOR THIS DEAL, in the table's own order. */
function waysFor(condition, deal = {}) {
  const p = plan(condition);
  if (!p) return [];
  return p.ways.filter((w) => wayApplies(w, deal));
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
 * WRITE IN WHAT THE WAY ITSELF ANSWERS.
 *
 * A way may carry `fixed` values — facts that follow from CHOOSING it rather than
 * from anything a person types. Today that is the servicer on the FCI way: saying
 * "this is one of ours, serviced by FCI" IS saying who the servicer is, so asking
 * for it again would be asking a question the answer already contains.
 *
 * WRITTEN ONTO THE ANSWER, not resolved at each reader. Every consumer — the
 * payoff order, the person keying Encompass, the screen showing what was recorded
 * — then sees a servicer on an FCI answer exactly as it sees one on a typed
 * answer, and none of them has to know this way is special. A reader that had to
 * remember is a reader that eventually forgets, and the fact that goes missing is
 * who to send the payoff request to.
 *
 * A TYPED VALUE STILL WINS. `fixed` fills what is blank; it never overwrites what
 * somebody put in, because a person correcting a servicer name knows something
 * this table does not.
 *
 * Returns a NEW answer object; never mutates the caller's. Never throws.
 */
function withFixed(condition, answer) {
  const a = answer && typeof answer === 'object' ? answer : {};
  const p = plan(condition);
  if (!p || p.mode !== 'choice') return a;
  const way = wayFor(condition, a.way);
  if (!way || !way.fixed || typeof way.fixed !== 'object') return a;
  const values = { ...(a.values && typeof a.values === 'object' ? a.values : {}) };
  for (const [k, v] of Object.entries(way.fixed)) {
    if (!has(values[k])) values[k] = v;
  }
  return { ...a, values };
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
    if (!wayApplies(way, opts.deal || {})) return notForThisDeal(way);
    return wayProblem(condition, way, a.values, { hasDocument: opts.hasDocument });
  }

  if (p.mode === 'per_line') {
    const lines = a.lines && typeof a.lines === 'object' ? a.lines : {};
    for (const key of Object.keys(lines)) {
      const entry = lines[key] || {};
      const way = wayFor(condition, entry.way);
      if (!way) return 'One of the mortgages has no way chosen.';
      /* A WAY THE SCREEN WOULD NOT OFFER IS REFUSED HERE TOO. Both halves read
         `wayApplies`, so a stale tab or an old bundle cannot post "this is the
         mortgage on the subject property" onto a purchase. */
      if (!wayApplies(way, opts.deal || {})) {
        return `${opts.lineLabels && opts.lineLabels[key] ? `${opts.lineLabels[key]}: ` : ''}${notForThisDeal(way)}`;
      }
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

/** Why a way was refused, in the words of the deal rather than of the code. */
function notForThisDeal(way) {
  if (way && way.refinanceOnly) {
    return 'That answer is only for a refinance — there is no mortgage on the subject property being paid off here.';
  }
  return 'That answer does not apply to this loan.';
}

/* ── THE SUBJECT-PROPERTY MORTGAGE, PRE-FILLED FROM THE CREDIT REPORT ───────
   Owner-directed 2026-08-31: *"It should have a mark that their information is
   on the credit report and automatically fill in from the credit report the
   servicer name, the loan number, and outstanding principal balance. It should
   satisfy two things at once."*

   ALL THREE OR NOTHING, exactly as a person typing it is held to. A fill short
   of one field is a partial answer that reads as a complete one to the loan-setup
   person, which is the whole reason this module refuses those — so a credit
   report that cannot furnish all three furnishes none, and says which one it was
   short of.

   THE LOAN NUMBER IS THE HONEST PART. A credit report carries the LAST FOUR
   digits of an account, not the full number — `lt_liabilities.account_last4` is
   the only account column there is. So the fill states that on its face
   (`loanNumberIsLastFour`) and `sourceNote` puts it in words wherever the answer
   is read. Filling four digits silently, as though they were the number a closer
   keys into Encompass, is the confident wrong answer this file exists to stop.

   PURE. It is handed a line and answers about that line. */
const CREDIT_REPORT = 'credit_report';
/* THE OTHER SOURCE THAT IS NOT A PERSON — the statement itself, read by OCR and
   the AI (owner-directed 2026-08-31). It is a SIBLING of the credit-report fill
   rather than a second mechanism: same answer shape, same `source` mark, same
   "a value that did not come from the person reading it says so" rule. */
const STATEMENT_READ = 'statement_read';

function creditReportFill(line) {
  const l = line && typeof line === 'object' ? line : {};
  const servicer = String(l.creditor == null ? '' : l.creditor).trim();
  const last4 = String(l.last4 == null ? '' : l.last4).trim();
  /* ZERO IS AN ANSWER, NULL IS NOT — and `Number(null)` is 0, which is finite,
     so an absent balance sails through a bare `Number.isFinite` check and fills
     a mortgage in at nothing owed. `has` is this module's own reading of
     "answered", so the two can never drift apart. */
  const balance = has(l.balance) ? Number(l.balance) : NaN;

  if (!servicer) return { ok: false, why: 'the credit report does not name the servicer' };
  if (!Number.isFinite(balance)) return { ok: false, why: 'the credit report does not carry an outstanding balance' };
  if (!last4) return { ok: false, why: 'the credit report does not carry an account number' };

  return {
    ok: true,
    answer: {
      way: 'typed',
      values: {
        servicer,
        outstanding_balance: balance,
        loan_number: last4,
      },
      source: CREDIT_REPORT,
      sourceLine: String(l.key || ''),
      sourceLabel: String(l.label || servicer),
      loanNumberIsLastFour: true,
    },
  };
}

/** Was this answer filled in from the credit report, and by which line? */
function filledFromCreditReport(answer, lineKey) {
  const a = answer && typeof answer === 'object' ? answer : {};
  if (a.source !== CREDIT_REPORT) return false;
  return lineKey === undefined ? true : String(a.sourceLine || '') === String(lineKey);
}

/**
 * THE ANSWER PILOT READ OFF THE STATEMENT ITSELF.
 *
 * `documentId` records WHICH document it was read from, which is what lets the
 * fill follow the paper: a statement replaced by a newer one may be re-read, and
 * a fill whose document is gone can be cleared, without either of them being able
 * to touch an answer a PERSON gave.
 */
function statementFill({ servicer, loanNumber, balance, documentId, note }) {
  const s = String(servicer == null ? '' : servicer).trim();
  const n = String(loanNumber == null ? '' : loanNumber).trim();
  const b = has(balance) ? Number(balance) : NaN;
  /* ALL THREE OR NOTHING, the same rule a person typing them is held to. Two
     thirds of an answer reads as a whole one to the loan-setup person, who then
     has nothing to key in — which is the entire reason this module refuses a
     partial typed answer, and there is no reason a machine should be trusted
     further than a person. */
  if (!s) return { ok: false, why: 'the statement does not name the servicer' };
  if (!n) return { ok: false, why: 'the statement does not carry a loan number' };
  if (!Number.isFinite(b)) return { ok: false, why: 'the statement does not state an outstanding principal balance' };
  return {
    ok: true,
    answer: {
      way: 'typed',
      values: { servicer: s, outstanding_balance: b, loan_number: n },
      source: STATEMENT_READ,
      sourceDocumentId: documentId ? String(documentId) : null,
      sourceLabel: note ? String(note) : null,
    },
  };
}

/** Was this answer read off a statement, and off which document? */
function filledFromStatement(answer, documentId) {
  const a = answer && typeof answer === 'object' ? answer : {};
  if (a.source !== STATEMENT_READ) return false;
  return documentId === undefined ? true : String(a.sourceDocumentId || '') === String(documentId);
}

/**
 * THE MARK, in plain words — one wording, read by every surface.
 *
 * Returns null for an answer a person typed themselves: a note explaining where
 * a value came from is only worth saying when it did not come from the person
 * reading it.
 */
function sourceNote(answer) {
  if (filledFromStatement(answer)) {
    /* THE PAYOFF IS THE REASON FOR THE SECOND SENTENCE. This figure is keyed into
       a payoff, and a machine reading a scanned statement is a good reader, not
       an authority — so the note asks for the one check that costs ten seconds
       and prevents wiring against the wrong number. */
    return 'PILOT read this off the mortgage statement on this condition — the servicer, the loan number '
      + 'and the outstanding principal balance. Check them against the statement before they are used for a payoff.';
  }
  if (!filledFromCreditReport(answer)) return null;
  const a = answer || {};
  const from = a.sourceLabel ? ` (${a.sourceLabel})` : '';
  const number = a.loanNumberIsLastFour
    ? ' The loan number is the LAST FOUR DIGITS only — that is all a credit report carries — so confirm the full number with the servicer before it is keyed in.'
    : '';
  return `Filled in from the mortgage on the credit report${from}, which somebody marked as the mortgage on the subject property.${number}`;
}

/** Every code this module governs — so a test can assert the library and this
    table describe the same conditions rather than drifting into two lists. */
const GOVERNED_CODES = Object.freeze(Object.keys(WAYS));

module.exports = {
  WAYS, GOVERNED_CODES, CREDIT_REPORT, plan, wayFor, wayApplies, waysFor,
  answerProblem, satisfies, withFixed, creditReportFill, filledFromCreditReport, sourceNote,
  statementFill, filledFromStatement, STATEMENT_READ, FCI_SERVICER,
  _internals: { has, moneyProblem, fieldsFor, wayProblem, notForThisDeal },
};
