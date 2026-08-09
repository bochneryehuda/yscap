'use strict';
/**
 * THE ONE COMPOSER FOR EVERY PRICING / EXCEPTION / REGISTRATION EMAIL.
 *
 * Owner-directed 2026-08-07, quoting three of these notifications back verbatim:
 *
 *   · on the pricing-override approval — *"Come on, this email is so [confusing] I can't even see
 *     what they want from me. We need to nicer lay this out: What exactly is the exception request
 *     for? Nicely laid out and designed. For all the exception requests, everything is very
 *     [confusing]."*
 *   · on the product-registered notice — *"are you serious? Come on! The top part, 'Product
 *     registered,' is simple, ugly text. This needs to be nicely designed … It should represent
 *     who we are."*
 *   · on the exception-approved notice — *"emails like this should clearly show what exception was
 *     approved, nicely laid out."*
 *
 * WHAT WAS WRONG, precisely:
 *
 *   1. THE ASK WAS A RUN-ON SENTENCE. "…was priced OFF the company defaults and is waiting for
 *      approval in the Escalations box. Changed from the defaults: Rate markup / YSP — Gold: 0.4%
 *      → 0%; Rate markup / YSP — Silver: 0.4% → 0.5%; Origination points — Standard: 1.25% → 1%;
 *      Origination points — Gold: 1.25% → 1%." Four separate decisions, joined by semicolons, in a
 *      paragraph — at the exact moment somebody has to approve or decline them. The SAME list was
 *      then repeated a second time as a single `meta` row, so the email said it twice and
 *      explained it neither time. It is now the template's CHANGE LEDGER: one row per moved value,
 *      the standard struck through, the ask in the accent.
 *
 *   2. THE DEAL WAS NOWHERE. An approver was shown the loan amount and nothing else — no
 *      leverage, no as-is/ARV, no cash to close. "Approve 0.5% of extra markup" is not a question
 *      anybody can answer without the deal it is being asked about.
 *
 *   3. NOTHING SAID WHAT HAPPENS IF THEY DO NOTHING. The consequence — the borrower gets no terms
 *      and no term sheet can go out — was buried mid-paragraph.
 *
 *   4. THE DECISION EMAIL DID NOT NAME THE DECISION. "The manual-review exception on <file> was
 *      approved by a super-admin" tells the reader an exception existed, not WHICH one — and the
 *      escalation row has carried the full change list all along.
 *
 * PURE — no DB, no network, no `require` of anything that touches either. Every figure is passed
 * in by the caller from the registration quote; NOTHING here computes a pricing number. That is
 * not a stylistic preference: the pricing engines are frozen (CLAUDE.md HARD RULE), so a display
 * module that did arithmetic would be a second, unfrozen source for a guideline figure.
 */

const num = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

/** Whole dollars, or null when the figure is genuinely unknown (never "$0" for "we don't know"). */
function usd(v) {
  const n = num(v);
  return n == null ? null : '$' + Math.round(n).toLocaleString('en-US');
}

/** A percentage that keeps real precision — 87.5 stays 87.5, 10 renders as 10%. */
function pct(v) {
  const n = num(v);
  if (n == null) return null;
  return `${Math.round(n * 100) / 100}%`;
}

/**
 * Render ONE override change the way `pricing-overrides.describeOverrides` renders its text form,
 * split into the parts the ledger draws separately. Kept byte-compatible in MEANING with that
 * function on purpose — the audit trail, the escalation screen and this email must never describe
 * the same change differently.
 */
function fmtOverrideValue(unit, v) {
  if (v == null) return null;
  if (unit === 'flag') return 'on';
  if (unit === 'pct') return `${Number(v)}%`;
  if (unit === 'frac') return `${(Number(v) * 100).toFixed(2)}%`;
  if (unit === 'money') return '$' + Math.round(Number(v)).toLocaleString('en-US');
  return String(v);
}

/**
 * The change ledger from the structured `overrideChanges` the register route already records
 * ([{key,label,unit,value,defaultValue}]).
 *
 * FALLBACK: an older escalation row may carry only `overrideLines` — the pre-rendered
 * "Label: 1.25% → 1%" strings. Those are parsed back apart so a historical row still renders as a
 * ledger rather than dropping to a paragraph. The parse is deliberately conservative: it splits on
 * the LAST ": " and on the arrow, and anything that does not match that exact shape becomes a
 * label-only row rather than being guessed at.
 */
function overrideLedger({ changes = [], lines = [], title = null, subtitle = null, note = null, tone = 'action' } = {}) {
  let rows = (Array.isArray(changes) ? changes : [])
    .filter((c) => c && c.label)
    .map((c) => ({
      label: String(c.label),
      from: fmtOverrideValue(c.unit, c.defaultValue),
      to: fmtOverrideValue(c.unit, c.value),
    }));

  if (!rows.length && Array.isArray(lines) && lines.length) {
    rows = lines.filter(Boolean).map((raw) => {
      const s = String(raw);
      const cut = s.lastIndexOf(': ');
      if (cut < 0) return { label: s };
      const label = s.slice(0, cut);
      const value = s.slice(cut + 2);
      const arrow = value.split(/\s*(?:→|->)\s*/);
      return arrow.length === 2
        ? { label, from: arrow[0], to: arrow[1] }
        : { label, to: value };
    });
  }

  if (!rows.length) return null;
  return {
    title: title || 'Changed from the company defaults',
    subtitle: subtitle || null,
    note: note || null,
    tone,
    rows,
  };
}

/**
 * A ledger of the PLAIN-LANGUAGE reasons a scenario needs manual review (the engine's own
 * `manualReasons` strings). These are not from→to changes — they are statements — so each becomes
 * a label-only row. Rendering them in the same component as the overrides is deliberate: from the
 * approver's seat "the rehab exceeds what this program finances" and "origination cut to 1%" are
 * the same kind of thing, namely a reason this file is on their desk.
 */
function reasonLedger(reasons, { title = 'Why this needs manual review', tone = 'action' } = {}) {
  const rows = (Array.isArray(reasons) ? reasons : []).filter(Boolean).map((r) => ({ label: String(r) }));
  return rows.length ? { title, tone, rows } : null;
}

/**
 * WHAT IS BEING ASKED FOR, in one sentence a person can act on. The old copy opened with the
 * mechanism ("A Silver Program registration on YSCAP258134797 · 62 Highland St … was priced OFF
 * the company defaults and is waiting for approval in the Escalations box") — the file reference
 * before the question. `kind` is the escalation's own discriminator, so this can never disagree
 * with what the Escalations screen shows.
 */
const ASK = {
  pricing_override: {
    title: 'A pricing exception needs your approval',
    noun: 'pricing exception',
    ask: 'A loan officer priced this deal off the company defaults and is asking you to approve it.',
    settled: 'This deal was priced off the company defaults.',
    badge: 'Needs approval',
  },
  manual_product: {
    title: 'A manual product needs your approval',
    noun: 'manual product',
    ask: 'A Manual Program was built on this file with hand-set LTV / LTC / ARV leverage, and is asking for your approval.',
    settled: 'A Manual Program was built on this file with hand-set LTV / LTC / ARV leverage.',
    badge: 'Needs approval',
  },
  manual_review: {
    title: 'A guideline exception needs your approval',
    noun: 'guideline exception',
    ask: 'This deal is not eligible as priced under the program guidelines and needs a guideline exception.',
    settled: 'This deal is not eligible as priced under the program guidelines and needed a guideline exception.',
    badge: 'Needs approval',
  },
};

function askFor(kind) {
  return ASK[String(kind || '')] || ASK.manual_review;
}

/**
 * THE DEAL, as an approver needs to see it. Every row is omitted when its figure is unknown — the
 * missing-vs-zero discipline: a blank ARV row reads as "we do not have one", and printing "$0"
 * there would be a statement we cannot support.
 *
 * `deal` is passed straight from the register route's own quote/sizing objects; nothing is derived.
 */
function dealFacts(deal = {}, { skip = null } = {}) {
  const rows = [];
  const skipped = skip instanceof Set ? skip : new Set(Array.isArray(skip) ? skip : []);
  const add = (label, value, key) => {
    if (key && skipped.has(key)) return;      // the money band already said it — never twice
    if (value != null && value !== '') rows.push({ label, value });
  };

  add('Loan amount', usd(deal.loanAmount), 'loanAmount');
  add('Note rate', deal.noteRate != null ? deal.noteRate : null, 'noteRate');
  add('Program', deal.programLabel, 'programLabel');
  add('Requested product', deal.productLabel);
  add('Purchase price', usd(deal.purchasePrice));
  add('As-is value', usd(deal.asIsValue));
  add('ARV', usd(deal.arv));
  add('Rehab budget', usd(deal.rehabBudget));
  add('Initial advance', usd(deal.initialAdvance));
  add('Rehab holdback', usd(deal.rehabHoldback));
  add('Cash to close', usd(deal.cashToClose), 'cashToClose');
  add('Liquidity to verify', usd(deal.liquidity), 'liquidity');
  // Leverage at FULL precision (the frozen display rule — 87.5 never rounds to 87).
  add('Initial / as-is LTV', pct(deal.acqLtvPct));
  add('ARV LTV', pct(deal.arvPct));
  add('Loan-to-cost', pct(deal.ltcPct));
  add('Liquidity months required', deal.assetMonths != null ? `${deal.assetMonths} month${Number(deal.assetMonths) === 1 ? '' : 's'}` : null);

  return rows.length ? { title: 'The deal', rows } : null;
}

/**
 * THE MONEY BAND for a registration / approval email: the loan amount at headline size with the
 * rate beneath it, then up to three supporting figures. Returns null when the loan amount is
 * unknown — a headline reading "$0" is worse than no band at all.
 */
function dealFigures(deal = {}, { label = 'Loan amount' } = {}) {
  const amount = usd(deal.loanAmount);
  if (!amount) return null;
  const secondary = [];
  const push = (l, v, key) => { if (v != null && v !== '') secondary.push({ label: l, value: v, _key: key }); };
  push('Cash to close', usd(deal.cashToClose), 'cashToClose');
  push('Liquidity to verify', usd(deal.liquidity), 'liquidity');
  push('Down payment', usd(deal.downPayment), 'downPayment');
  const shown = secondary.slice(0, 3);
  return {
    primary: {
      label,
      value: amount,
      sub: [deal.programLabel, deal.noteRate != null ? `at ${deal.noteRate}` : null, deal.termMonths ? `${deal.termMonths}-month term` : null]
        .filter(Boolean).join(' · ') || null,
      tone: deal.tone || 'teal',
    },
    secondary: shown,
    // Which deal keys this band has already stated, so the facts box below it never repeats one.
    // A figure printed twice at two sizes reads as two different facts.
    _consumed: new Set(['loanAmount', 'noteRate', 'programLabel',
      ...shown.map((x) => x._key).filter(Boolean)]),
  };
}

/**
 * THE FULL PAYLOAD for an "X needs approval" email. The caller adds its own file identity `meta`
 * (from notify.fileContext) and the CTA.
 */
function approvalRequestEmail({ kind, deal = {}, overrideChanges = [], overrideLines = [], manualReasons = [] } = {}) {
  const a = askFor(kind);
  // The override ledger and the manual-review reasons are two different ledgers, and a scenario
  // can genuinely carry both (a manual-review deal that was ALSO priced off the defaults). The
  // template renders one `changes` block, so they are merged with each ledger keeping its own
  // heading as a divider row — never silently dropping one of them.
  const ovr = overrideLedger({ changes: overrideChanges, lines: overrideLines });
  const why = reasonLedger(manualReasons);
  let changes = null;
  if (ovr && why) {
    changes = {
      title: 'What you are being asked to approve',
      tone: 'action',
      rows: [
        ...why.rows.map((r) => ({ ...r, note: 'Guideline exception' })),
        ...ovr.rows,
      ],
      note: 'The struck-through figure is the company default; the bold figure is what is being asked for.',
    };
  } else if (ovr) {
    changes = { ...ovr, title: 'What you are being asked to approve', note: 'The struck-through figure is the company default; the bold figure is what is being asked for.' };
  } else if (why) {
    changes = { ...why, title: 'What you are being asked to approve' };
  }

  const figures = dealFigures(deal);
  const skip = figures && figures._consumed;
  // `_consumed` is build-time bookkeeping. It is DELETED before the payload leaves this module
  // because a notification payload can be PARKED as JSON in the loan officer's Drafts (the LO
  // gate), and a Set serialises to `{}` — a field that silently changes shape across a round trip
  // is exactly the kind of thing that reads as working until the day it does not.
  if (figures) delete figures._consumed;
  return {
    title: a.title,
    badge: { text: a.badge, tone: 'action' },
    // `emailBody` (not `intro`) — see notify.buildEmail: `intro` is derived from body/emailBody.
    emailBody: a.ask,
    body: a.ask,
    figures,
    changes,
    facts: dealFacts(deal, { skip }),
    callout: {
      title: 'Until you decide',
      body: 'The borrower is not sent terms and no term sheet can go out on this file. Approving confirms these terms and releases them; declining leaves the file as it is.',
      tone: 'action',
    },
  };
}

/**
 * THE DECISION email — what was actually approved or declined. Same ledger, past tense, so the
 * team reads the decision and the thing decided in one place (owner-directed: *"emails like this
 * should clearly show what exception was approved"*).
 */
function approvalDecidedEmail({ kind, decision, deal = {}, overrideChanges = [], overrideLines = [], manualReasons = [], decidedBy = null, note = null } = {}) {
  const approved = decision === 'approved';
  const a = askFor(kind);
  const ovr = overrideLedger({ changes: overrideChanges, lines: overrideLines });
  const why = reasonLedger(manualReasons, { title: 'Guideline exception' });
  const rows = [
    ...(why ? why.rows.map((r) => ({ ...r, note: 'Guideline exception' })) : []),
    ...(ovr ? ovr.rows : []),
  ];
  const figuresD = dealFigures(deal, { label: approved ? 'Approved loan amount' : 'Requested loan amount' });
  const skipD = figuresD && figuresD._consumed;
  if (figuresD) delete figuresD._consumed;

  return {
    title: approved ? 'Exception approved' : 'Exception declined',
    badge: { text: approved ? 'Approved' : 'Declined', tone: approved ? 'positive' : 'neutral' },
    // Short enough for an in-app notification row; the email opens with the fuller sentence.
    body: `The ${a.noun} on this file was ${approved ? 'approved' : 'declined'}${decidedBy ? ` by ${decidedBy}` : ''}.`,
    emailBody: approved
      ? `${a.settled} It was approved${decidedBy ? ` by ${decidedBy}` : ''}, so these terms now stand and the borrower can be sent them.`
      : `${a.settled} It was declined${decidedBy ? ` by ${decidedBy}` : ''}, so the file keeps the terms it had and the borrower is not sent these ones.`,
    figures: figuresD,
    changes: rows.length
      ? {
        title: approved ? 'What was approved' : 'What was declined',
        tone: approved ? 'positive' : 'neutral',
        rows,
        note: approved
          ? 'The struck-through figure is the company default; the bold figure is what now applies to this file.'
          : 'The struck-through figure is the company default; the bold figure is what was asked for and not granted.',
      }
      : null,
    facts: dealFacts(deal, { skip: skipD }),
    callout: note
      ? { title: approved ? 'Approver’s note' : 'Why it was declined', body: String(note), tone: approved ? 'positive' : 'action' }
      : null,
  };
}

/**
 * THE PRODUCT-REGISTERED notice to the file's team. It carried the whole story as one comma-run
 * ("Gold Standard Program · $523,125 @ 10.00% on YSCAP258134713 · 276 Blake St · cash to close
 * $78,411 · liquidity $109,799") with the headline "Product registered" as plain text above it.
 * The numbers are the message, so they get the money band; the deal is the supporting read.
 */
function productRegisteredEmail({ deal = {}, statusNote = null, needsApproval = false } = {}) {
  const figures = dealFigures(deal);
  const skipR = figures && figures._consumed;
  if (figures) delete figures._consumed;
  return {
    title: 'Product registered',
    badge: needsApproval
      ? { text: 'Pending approval', tone: 'action' }
      : { text: 'Registered', tone: 'positive' },
    emailBody: needsApproval
      ? 'This product is on the file, but it was priced off the company defaults or needs manual review — so the borrower is not sent terms until an admin approves it.'
      : 'This product is registered on the file. Its terms, cash to close and liquidity requirement all flow from these numbers.',
    figures,
    facts: dealFacts(deal, { skip: skipR }),
    callout: statusNote ? { title: 'Note', body: String(statusNote), tone: 'gold' } : null,
  };
}

module.exports = {
  approvalRequestEmail, approvalDecidedEmail, productRegisteredEmail,
  overrideLedger, reasonLedger, dealFacts, dealFigures, askFor, usd, pct, fmtOverrideValue,
};
