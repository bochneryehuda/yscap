'use strict';
/**
 * LONG-TERM — READING A MORTGAGE STATEMENT: WHO SERVICES IT, ITS NUMBER, AND
 * WHAT IS STILL OWED.
 *
 * Owner-directed 2026-08-31: *"Let's bring in the logic that we have on the
 * document review section. Just very carefully bring in only what you need to be
 * able to share [the AI] and the OCR engine to be able to read the mortgage
 * statement and read who is the servicer name, who is the loan number, and
 * what's the outstanding principal balance, and should automatically fill."*
 *
 * The crossing that lets it use those two readers is recorded in
 * `docs/LONG-TERM-AUTHORIZED-COPIES.md`, along with what deliberately does NOT
 * cross: the document-review desk, its findings, its classifier and its
 * suggestions. This module reads one document and answers one condition.
 *
 * ── WHAT IT IS ALLOWED TO BE WRONG ABOUT ────────────────────────────────────
 *
 * The outstanding principal balance is keyed into a PAYOFF. A wrong one is money.
 * So this is held to the appraisal As-Is reader's rule, which exists for the same
 * shape of mistake: THE DETERMINISTIC SCANNER DECIDES, and the AI may only POINT
 * at a line the scanner then reads for itself.
 *
 * The two kinds of answer are grounded DIFFERENTLY, on purpose:
 *
 *   · A NUMBER (the balance, the loan number) survives only when the AI's quote
 *     is genuinely in the document AND our own scanner independently reads the
 *     same value, off a real label, out of the text around that quote. "The
 *     number appears somewhere in the document" is worth nothing for a number —
 *     a statement is full of numbers, and the escrow balance, the amount due and
 *     the original loan amount are all of them plausible.
 *   · A NAME (the servicer) survives when the name is PRINTED IN THE DOCUMENT,
 *     because that test is strong for a name and there is no honest deterministic
 *     rule for "which of these words is the company". It can never introduce a
 *     servicer the statement does not name.
 *
 * ── AND IT NEVER ANSWERS THE CONDITION BY ITSELF ────────────────────────────
 *
 * It PRE-FILLS. A person still confirms, exactly as they do with a figure they
 * typed, and what it filled says where it came from. `answers.js` holds the rule
 * that all three parts are given together or none of them are — this reader is
 * held to it too, so a statement it can only half read fills nothing rather than
 * handing the loan-setup person two thirds of an answer that reads as complete.
 *
 * PURE ABOVE THE FOLD: the scanner takes text and answers, so every rule below is
 * unit-testable with no OCR, no AI and no network.
 */

/* ── The words a statement uses ─────────────────────────────────────────────── */

const squash = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
const norm = (s) => squash(s).toLowerCase();

/**
 * WHAT IS STILL OWED — and the four things it is not.
 *
 * Every one of these appears on an ordinary statement, every one is money, and
 * every one is wrong: the escrow balance is somebody else's money we hold, the
 * amount due is one month, the payoff is the balance PLUS interest and fees (and
 * is a quote with an expiry, not the principal), and the original amount is what
 * was borrowed years ago. A reader that takes the biggest money on the page, or
 * the first, gets one of these far more often than the right one.
 */
const BALANCE_LABEL = /(outstanding|unpaid|current|remaining)?\s*principal\s*(balance)?|principal\s*balance/i;
/* AND THE FIFTH: THE MONTHLY PAYMENT. "Principal & Interest $2,145.18" is on
   every statement printed, and the label above matches its first word — a
   reader without this line hands a payoff desk one month's payment as the
   balance of the loan. */
const NOT_BALANCE = /(escrow|suspense|reserve)\s*(account\s*)?balance|amount\s*(now\s*)?due|total\s*due|past\s*due|payoff|interest\s*rate|original\s*(loan|principal|amount)|late\s*charge|year[\s-]*to[\s-]*date|ytd|deferred|available\s*credit|principal\s*(and|&|\+)\s*interest|\bp\s*&\s*i\b|monthly\s*payment/i;

/** THE LOAN'S OWN NUMBER — never the property, the phone or the statement date. */
const LOANNO_LABEL = /\b(loan|account|acct)\s*(number|no\.?|#|id)\b/i;
const NOT_LOANNO = /(phone|tel|fax|customer\s*service|routing|check|invoice|property|parcel|apn|policy|escrow)\s*(number|no\.?|#)?/i;

/** WHO SERVICES IT, when the statement says so in as many words. */
const SERVICER_LABEL = /\b(loan\s*)?servicer\b|\bserviced\s*by\b|\bservicing\s*(agent|company)\b/i;

/**
 * A balance a mortgage can plausibly have. Not a validation of the loan — a
 * refusal of the obvious misreads: a 3-digit late charge and an 11-digit run of
 * an account number with a decimal point glued on by OCR.
 */
const MIN_BALANCE = 1000;
const MAX_BALANCE = 100000000;

function money(raw) {
  const s = String(raw == null ? '' : raw).replace(/[,$\s]/g, '');
  if (!/^-?\d+(\.\d{1,2})?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

const plausibleBalance = (n) => typeof n === 'number' && Number.isFinite(n) && n >= MIN_BALANCE && n <= MAX_BALANCE;

/**
 * A loan number as a servicer prints one: digits, sometimes with letters or a
 * dash. Bounded at both ends — three characters is a page number and thirty is a
 * scanning artefact — and a pure year is refused, because "2019" beside the word
 * "loan" is the origination year on a great many statements.
 */
function plausibleLoanNumber(raw) {
  const s = squash(raw).replace(/[^0-9A-Za-z-]/g, '');
  if (s.length < 5 || s.length > 24) return null;
  if (!/\d/.test(s)) return null;                 // a word is not a loan number
  if (/^(19|20)\d{2}$/.test(s)) return null;      // a year
  return s;
}

/* ── The scanner ────────────────────────────────────────────────────────────── */

/** The document as lines, with the blank ones dropped and the runs squashed. */
function linesOf(text) {
  return String(text == null ? '' : text)
    .split(/\r?\n/)
    .map((l) => squash(l))
    .filter(Boolean);
}

/**
 * Read the three facts out of the statement's own text.
 *
 * A LABEL AND ITS VALUE MAY SIT ON TWO LINES. Layout OCR routinely puts a label
 * in one cell and its amount in the next, so each line is read joined to the one
 * after it as well — the same pairing the appraisal reader needs, and for the
 * same reason.
 *
 * Returns every candidate it can defend, in the order it found them, each with
 * the line it came from so a person can be shown WHERE it was read.
 */
function scanStatement(text) {
  const lines = linesOf(text);
  const out = { balances: [], loanNumbers: [], servicers: [] };
  const consider = (line, next) => {
    const joined = next ? `${line} ${next}` : line;

    // ── the balance ───────────────────────────────────────────────────────
    /* READ THE WINDOW BETWEEN THIS LABEL AND THE NEXT RIVAL ONE, never the whole
       run. A statement prints its balances in COLUMNS —
       "Principal Balance $412,506.19   Escrow Balance $3,204.00" — so vetoing any
       line that mentions escrow throws the right answer away on the commonest
       layout there is. Starting at the principal label excludes a rival BEFORE
       it, and cutting at the next rival excludes one after; what is left is the
       amount this label is actually pointing at. */
    const bAt = joined.search(BALANCE_LABEL);
    if (bAt >= 0) {
      let window = joined.slice(bAt);
      const rival = window.slice(1).search(NOT_BALANCE);
      if (rival >= 0) window = window.slice(0, rival + 1);
      /* AND THE WORD IMMEDIATELY BEFORE IT, because the rivals that matter most
         are QUALIFIERS: "Original Principal Amount" and "Payoff / Principal
         Balance" both put their disqualifying word in FRONT of the label, so a
         window that starts at the label reads them as the balance. Twelve
         characters is the qualifier and not the neighbouring column — long
         enough for "Original " and "Payoff / ", short enough that an escrow
         figure printed to the left of the principal one does not veto it. */
      const lead = joined.slice(Math.max(0, bAt - 12), bAt);
      if (!NOT_BALANCE.test(lead + window)) {
        const m = window.match(/\$?\s*(\d[\d,]*(?:\.\d{1,2})?)/g) || [];
        for (const raw of m) {
          const n = money(raw);
          if (plausibleBalance(n)) { out.balances.push({ value: n, line: joined }); break; }
        }
      }
    }

    // ── the loan number ───────────────────────────────────────────────────
    if (LOANNO_LABEL.test(joined) && !NOT_LOANNO.test(joined)) {
      /* Read AFTER the label, never from the whole line: a statement header
         carries the property address and the statement date on the same run, and
         taking the first number on it hands back a house number. */
      const at = joined.search(LOANNO_LABEL);
      const tail = joined.slice(at).replace(LOANNO_LABEL, ' ');
      const m = tail.match(/[0-9][0-9A-Za-z-]{3,}/);
      const v = m ? plausibleLoanNumber(m[0]) : null;
      if (v) out.loanNumbers.push({ value: v, line: joined });
    }

    // ── the servicer, when it is labelled ─────────────────────────────────
    if (SERVICER_LABEL.test(joined)) {
      const at = joined.search(SERVICER_LABEL);
      const tail = squash(joined.slice(at).replace(SERVICER_LABEL, ' ').replace(/^[:\-–—\s]+/, ''));
      /* Two characters is not a company and a whole paragraph is the sentence
         explaining what a servicer IS, which every statement carries. */
      if (tail.length >= 3 && tail.length <= 80) out.servicers.push({ value: tail, line: joined });
    }
  };
  for (let i = 0; i < lines.length; i += 1) consider(lines[i], lines[i + 1] || null);
  return out;
}

/**
 * The scanner's own answer: the first candidate of each, or nothing.
 *
 * FIRST, NOT BEST. A statement states its principal balance once and repeats the
 * amount due; picking "the largest" would take a payoff quote where one is
 * printed, and picking "the last" takes whatever the footer happens to carry.
 */
function fromScan(text) {
  const s = scanStatement(text);
  return {
    balance: s.balances.length ? s.balances[0].value : null,
    loanNumber: s.loanNumbers.length ? s.loanNumbers[0].value : null,
    servicer: s.servicers.length ? s.servicers[0].value : null,
    _scan: s,
  };
}

/**
 * IS THIS EVEN A MORTGAGE STATEMENT? Two of the three marks, at least.
 *
 * A reader pointed at the wrong document answers confidently about it — an
 * insurance declaration page has an account number and a dollar amount and would
 * furnish two thirds of an answer. So a document that does not read as a mortgage
 * statement fills nothing, and says that rather than saying it found nothing.
 */
const STATEMENT_MARKS = [
  /mortgage\s*statement|monthly\s*statement|statement\s*date/i,
  /principal\s*balance|escrow|amount\s*due|payment\s*due/i,
  /\b(loan|account|acct)\s*(number|no\.?|#)/i,
];

function looksLikeStatement(text) {
  const t = String(text || '');
  return STATEMENT_MARKS.filter((re) => re.test(t)).length >= 2;
}

/* ── Reading a real document ────────────────────────────────────────────────
   Everything below takes its readers as ARGUMENTS. The module can therefore be
   run end to end in a test with no OCR account, no AI key and no network, which
   is the only way the grounding gates below can be proven to bite. */

const AI_SYSTEM = 'You read mortgage statements. You never estimate and never infer: you point at what is printed.';
const AI_INSTRUCTION = [
  'From the statement text, find three things and quote the exact line each is printed on:',
  '  1. the SERVICER — the company that services this loan and sends this statement;',
  '  2. the LOAN NUMBER — this loan\'s own account number, not a phone or property number;',
  '  3. the OUTSTANDING PRINCIPAL BALANCE — what is still owed on the principal.',
  'The outstanding principal balance is NOT the escrow balance, NOT the amount due,',
  'NOT the payoff amount, NOT the original loan amount and NOT the monthly principal-and-interest payment.',
  'If the statement does not state one of them, say so for that one rather than guessing.',
].join('\n');
const AI_SCHEMA = {
  type: 'object',
  properties: {
    servicer: { type: ['string', 'null'] },
    servicer_quote: { type: ['string', 'null'] },
    loan_number: { type: ['string', 'null'] },
    loan_number_quote: { type: ['string', 'null'] },
    balance: { type: ['number', 'null'] },
    balance_quote: { type: ['string', 'null'] },
  },
};

/** The window of the document around a quote, so a re-scan sees the quote's
 *  neighbours — the stacked-label and qualifier guards above both read them. */
function windowAround(text, quote, pad = 300) {
  const hay = squash(text).toLowerCase();
  const needle = squash(quote).toLowerCase();
  if (!needle || needle.length < 6) return null;
  const at = hay.indexOf(needle);
  if (at < 0) return null;
  const ratio = hay.length ? text.length / hay.length : 1;
  const from = Math.max(0, Math.floor(at * ratio) - pad);
  const to = Math.min(text.length, Math.ceil((at + needle.length) * ratio) + pad);
  return text.slice(from, to);
}

/**
 * Ask the AI to POINT, then read for ourselves.
 *
 * A NUMBER survives only when our own scanner reads the SAME value off a real
 * label in the text around the quote. A NAME survives when it is printed in the
 * document — for a name that test is strong, and there is no honest
 * deterministic rule for "which of these words is the company".
 *
 * Never throws.
 */
async function aiLocate(text, deps = {}) {
  const ai = deps.ai;
  if (!ai || typeof ai.available !== 'function' || !ai.available()) {
    return { ok: false, why: 'the AI reader is not configured' };
  }
  let r;
  try {
    r = await ai.extract({
      system: AI_SYSTEM,
      instructions: AI_INSTRUCTION,
      schema: AI_SCHEMA,
      ocrText: String(text || '').slice(0, 60000),
      maxTokens: 700,
      traceMeta: { opName: 'lt-mortgage-statement-read' },
    });
  } catch (e) {
    return { ok: false, why: `the AI reader failed (${(e && e.message) || e})` };
  }
  if (!r || !r.ok || !r.data) return { ok: false, why: (r && r.reason) || 'the AI reader returned nothing' };
  const d = r.data;
  const out = { ok: true, servicer: null, loanNumber: null, balance: null, refused: [] };

  // THE NAME. Printed in the document, or it did not come from the document.
  const servicer = squash(d.servicer || '');
  if (servicer) {
    if (norm(text).includes(norm(servicer)) && servicer.length >= 3 && servicer.length <= 80) out.servicer = servicer;
    else out.refused.push('the servicer it named is not printed on the statement');
  }

  // THE NUMBERS. Re-read by our own scanner, in the text around the quote.
  const balWindow = windowAround(text, d.balance_quote);
  if (d.balance != null) {
    const want = Number(d.balance);
    const scan = balWindow ? scanStatement(balWindow).balances.map((b) => b.value) : [];
    if (plausibleBalance(want) && scan.includes(want)) out.balance = want;
    else out.refused.push('the balance it pointed at does not read as an outstanding principal balance');
  }
  const numWindow = windowAround(text, d.loan_number_quote);
  const wantNo = plausibleLoanNumber(d.loan_number);
  if (d.loan_number != null) {
    const scan = numWindow ? scanStatement(numWindow).loanNumbers.map((n) => n.value) : [];
    if (wantNo && scan.includes(wantNo)) out.loanNumber = wantNo;
    else out.refused.push('the loan number it pointed at does not read as this loan\'s number');
  }
  return out;
}

/**
 * READ ONE UPLOADED STATEMENT.
 *
 * @param {{buffer:Buffer, filename?:string}} doc
 * @param {{ocr, ai, allowSpend}} deps — the OCR router, the AI transport and the
 *        per-file spend gate, all injected so this is testable with none of them.
 *
 * ALL THREE OR NOTHING, the same rule a person typing them is held to and the
 * same one `answers.js` enforces: two thirds of an answer reads as a whole one to
 * the loan-setup person, who then has nothing to key in. What was short is named.
 *
 * NEVER THROWS.
 */
async function readStatement(doc, deps = {}) {
  const buffer = doc && doc.buffer;
  if (!buffer || !buffer.length) return { ok: false, why: 'there were no bytes to read' };
  const ocr = deps.ocr;
  if (!ocr || typeof ocr.configured !== 'function' || !ocr.configured()) {
    return { ok: false, why: 'no OCR engine is configured on this deployment' };
  }

  let text = '';
  try {
    const r = await ocr.read({ buffer, filename: (doc && doc.filename) || 'statement.pdf' });
    if (!r || !r.ok) return { ok: false, why: `the statement could not be read (${(r && r.reason) || 'no text'})` };
    text = String(r.text || '');
  } catch (e) {
    return { ok: false, why: `the statement could not be read (${(e && e.message) || e})` };
  }
  if (!text.trim()) return { ok: false, why: 'the statement came back with no readable text' };

  /* IS IT THE RIGHT KIND OF DOCUMENT? A reader pointed at an insurance
     declaration page answers confidently about it — it has an account number and
     dollar amounts — so a document that does not read as a mortgage statement
     fills nothing and says which it was. */
  if (!looksLikeStatement(text)) return { ok: false, why: 'this does not read as a mortgage statement' };

  const scan = fromScan(text);
  let servicer = scan.servicer;
  let loanNumber = scan.loanNumber;
  let balance = scan.balance;
  const refused = [];
  let usedAi = false;

  if (!servicer || !loanNumber || balance == null) {
    /* THE SPEND GATE IS ASKED BEFORE THE MODEL, never after: a cap consulted
       afterwards is a bill, not a brake. An unreadable gate is treated as a NO —
       the deterministic read still stands, so refusing costs a pre-fill and
       spending on an unknown budget costs money. */
    let mayAsk = false;
    try { mayAsk = !deps.allowSpend || (await deps.allowSpend()) === true; } catch (_) { mayAsk = false; }
    if (mayAsk) {
      const located = await aiLocate(text, deps);
      if (located.ok) {
        usedAi = true;
        if (!servicer && located.servicer) servicer = located.servicer;
        if (!loanNumber && located.loanNumber) loanNumber = located.loanNumber;
        if (balance == null && located.balance != null) balance = located.balance;
        for (const r of (located.refused || [])) refused.push(r);
      } else if (located.why) {
        refused.push(located.why);
      }
    }
  }

  const short = [];
  if (!servicer) short.push('the servicer');
  if (!loanNumber) short.push('the loan number');
  if (balance == null) short.push('the outstanding principal balance');
  if (short.length) {
    return {
      ok: false,
      why: `the statement was read, but it does not clearly state ${short.join(', ')}`,
      short, refused, usedAi,
    };
  }
  return {
    ok: true,
    servicer,
    loanNumber,
    balance,
    usedAi,
    refused,
    /* WHERE IT CAME FROM, in the words the answer will carry. A figure that
       appears by itself with nothing saying how is one nobody trusts. */
    sourceNote: `Read from the mortgage statement${usedAi ? ' (PILOT read the document)' : ''}. Check it against the statement before this is used for a payoff.`,
  };
}

/* ── Filling the condition in ───────────────────────────────────────────────── */

const CODE = 'lt_subject_mortgage_statement';

/**
 * READ THE STATEMENT SOMEBODY JUST UPLOADED, AND PRE-FILL THE CONDITION.
 *
 * @param {{loanId, conditionId, documentId, code}} where
 * @param {{db, storage, ocr, ai, allowSpend}} deps — every reader injected.
 *
 * ── WHAT IT WILL NOT DO ─────────────────────────────────────────────────────
 *
 * IT NEVER OVERWRITES A PERSON. An answer somebody chose is left exactly as it
 * is: quietly replacing a closer's typed loan number with one a machine read off
 * a scan is the silent overwrite this repo has been bitten by before. The only
 * answer it will replace is one IT wrote, which is what lets a re-uploaded
 * statement correct itself.
 *
 * IT NEVER ANSWERS THE CONDITION. It fills the boxes; a person still confirms,
 * and what it filled says where it came from.
 *
 * IT NEVER THROWS, and it never blocks the upload. The document is filed either
 * way — a reading that failed costs a pre-fill, and it says why so the screen can
 * repeat it rather than leaving somebody wondering whether it tried.
 */
async function fillFromUpload(where, deps = {}) {
  const out = { filled: false };
  try {
    if (!where || String(where.code || '') !== CODE) return { filled: false, why: 'not_that_condition' };
    const db = deps.db;
    const answers = require('../lib/conditions/answers');

    const { rows } = await db.query(
      'SELECT tool_payload AS answer FROM checklist_items WHERE id = $1::uuid',
      [String(where.conditionId)],
    );
    if (!rows.length) return { filled: false, why: 'no_condition' };
    const existing = rows[0].answer && typeof rows[0].answer === 'object' ? rows[0].answer : {};
    /* A PERSON'S ANSWER STANDS. `way` is set only by somebody choosing one or by
       a previous fill; anything not marked as OUR OWN fill belongs to a human —
       including one the credit report filled, which somebody marked a line for. */
    if (existing.way && !answers.filledFromStatement(existing)) {
      return { filled: false, why: 'already_answered' };
    }

    const bytes = await deps.storage.read(where.storageRef);
    if (!bytes || !bytes.length) return { filled: false, why: 'no_bytes' };

    const read = await readStatement({ buffer: bytes, filename: where.filename }, deps);
    if (!read.ok) return { filled: false, why: 'unreadable', detail: read.why, short: read.short || null };

    const fill = answers.statementFill({
      servicer: read.servicer,
      loanNumber: read.loanNumber,
      balance: read.balance,
      documentId: where.documentId,
    });
    if (!fill.ok) return { filled: false, why: 'incomplete', detail: fill.why };

    /* JUDGED BY THE SAME GATE A TYPED ANSWER IS. A fill the door would refuse is
       one nobody could have entered by hand, and recording it would leave a
       condition holding a shape the gate ignores. */
    const problem = answers.answerProblem({ code: CODE }, fill.answer, { hasDocument: true });
    if (problem) return { filled: false, why: 'refused', detail: problem };

    await db.query(
      'UPDATE checklist_items SET tool_payload = $2::jsonb, updated_at = now() WHERE id = $1::uuid',
      [String(where.conditionId), JSON.stringify(fill.answer)],
    );
    return {
      filled: true,
      servicer: read.servicer,
      loanNumber: read.loanNumber,
      balance: read.balance,
      usedAi: !!read.usedAi,
      note: answers.sourceNote(fill.answer),
    };
  } catch (e) {
    console.error('[lt-statement] could not read the mortgage statement:', (e && e.message) || e);
    return { filled: false, why: 'error' };
  }
  return out;
}

module.exports = {
  scanStatement, fromScan, looksLikeStatement, readStatement, fillFromUpload, CODE,
  plausibleBalance, plausibleLoanNumber, money, linesOf,
  MIN_BALANCE, MAX_BALANCE,
  _internals: { BALANCE_LABEL, NOT_BALANCE, LOANNO_LABEL, NOT_LOANNO, SERVICER_LABEL, squash, norm, aiLocate, windowAround },
};
