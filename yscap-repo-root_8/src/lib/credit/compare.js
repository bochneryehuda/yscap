'use strict';

/**
 * Re-pull COMPARISON (E6) — "what changed since the last pull".
 *
 * This feature exists to RE-ISSUE (re-pull) a borrower's credit report. When an
 * underwriter opens a freshly re-pulled report, the most valuable question is
 * "what changed since we last looked?" — did the score move (and cross a pricing
 * bracket), did a collection clear, did a fraud/OFAC alert resolve, did a new
 * derogatory account or inquiry appear. This module answers that by diffing the
 * two reports' stored "blocks" (the E1 tradelines / collections / public records /
 * inquiries), their per-bureau scores, and their underwriting findings (E2).
 *
 * PURE: block rows + report rows in, a diff object out. No DB, no I/O. It reads
 * the SAME snake_case column shapes the detail endpoint returns, so the endpoint
 * can hand it exactly what it already loaded.
 *
 * ADVISORY only — like the risk summary, it never gates sign-off. It is a
 * heads-up for the human. It is also the plain-language story BEHIND the gate's
 * supersession rule (a clean re-pull superseding an earlier fatal finding): the
 * "cleared findings" list is literally what got resolved.
 *
 * SECURITY: it only ever touches masked/last-4 fields (never the encrypted
 * account column, never a raw SSN) — the endpoint hands it the masked detail
 * rows, and every block echoed back in the result is slimmed to a masked shape.
 */

const { summarizeRisk } = require('./risk-summary');
const { normalizeFindings } = require('./underwriting');
const scoring = require('./scoring');

// ---- small pure helpers ----------------------------------------------------
const num = (v) => { if (v == null || v === '') return null; const n = Number(String(v).replace(/[^0-9.\-]/g, '')); return Number.isFinite(n) ? n : null; };
const numOr0 = (v) => num(v) || 0;
const digits = (v) => String(v == null ? '' : v).replace(/\D/g, '');
const last4 = (masked) => digits(masked).slice(-4);
// Normalize a free-text label for matching: uppercase, strip everything but
// letters/digits, collapse. So "CHASE BANK, N.A." and "Chase Bank NA" match.
const normStr = (s) => String(s == null ? '' : s).toUpperCase().replace(/[^A-Z0-9]/g, '');
const money = (n) => `$${Math.round(numOr0(n)).toLocaleString('en-US')}`;
const isClosed = (t) => /paid|closed/i.test(String(t && t.account_status_type || ''));

// Human labels for the finding types (E2 categories) — for the headline copy.
const FINDING_LABEL = {
  fico_mismatch: 'FICO mismatch',
  fraud_alert: 'Fraud alert',
  active_duty: 'Active-duty alert',
  deceased: 'Deceased flag',
  ofac: 'OFAC alert',
  ssn_alert: 'SSN alert',
  address_discrepancy: 'Address discrepancy',
  high_risk_score: 'High-risk fraud score',
  security_freeze: 'Security freeze',
  consumer_statement: 'Consumer statement',
  id_ssn_mismatch: 'Reported-SSN mismatch',
  id_dob_mismatch: 'Reported-DOB mismatch',
  id_name_mismatch: 'Reported-name mismatch',
  joint_blocks_unsplit: 'Joint accounts under primary',
  other: 'Credit-file alert',
};
const findingLabel = (f) => FINDING_LABEL[f && (f.type || f.code)] || 'Credit-file alert';

// Slim a finding to the masked, display-safe fields the UI needs.
const slimFinding = (f) => ({
  type: f.type || f.code || 'other',
  severity: f.severity || 'warning',
  label: findingLabel(f),
  message: f.message || '',
});

// Multiset diff by a stable key: what's ADDED (in cur, not matched in prev),
// REMOVED (in prev, not matched in cur), and COMMON (paired same-key rows). Using
// a multiset (list per key) so two identical-key rows don't collapse to one.
function diffSets(curArr, prevArr, keyFn) {
  const build = (arr) => {
    const m = new Map();
    for (const x of (Array.isArray(arr) ? arr : [])) { const k = keyFn(x); if (!m.has(k)) m.set(k, []); m.get(k).push(x); }
    return m;
  };
  const cur = build(curArr), prev = build(prevArr);
  const added = [], removed = [], common = [];
  for (const [k, list] of cur) {
    const pl = prev.get(k) || [];
    const n = Math.min(list.length, pl.length);
    for (let i = 0; i < n; i++) common.push([list[i], pl[i]]);
    for (let i = n; i < list.length; i++) added.push(list[i]);
  }
  for (const [k, list] of prev) {
    const cl = cur.get(k) || [];
    for (let i = Math.min(cl.length, list.length); i < list.length; i++) removed.push(list[i]);
  }
  return { added, removed, common };
}

const metaOf = (r) => {
  const rep = r && r.report ? r.report : {};
  const score = num(rep.representative_score);
  return {
    id: rep.id != null ? rep.id : null,
    createdAt: rep.created_at || null,
    reportIdentifier: rep.credit_report_identifier || null,
    mismoVersion: rep.mismo_version || null,
    status: rep.status || null,
    representativeScore: score,
    representativeBracket: rep.representative_bracket || (score != null ? scoring.bracketOf(score) : null),
  };
};

/**
 * Compare a CURRENT report against the PREVIOUS one for the same file.
 *
 * @param {object} cur  { report, scores[], tradelines[], collections[], inquiries[], publicRecords[] }
 * @param {object} prev same shape (the earlier imported report), or null/undefined
 * @param {object} opts { nowMs }
 * @returns {object} diff (see below). `hasPrevious:false` when there is nothing to compare to.
 */
function compareReports(cur, prev, opts = {}) {
  if (!cur || !cur.report) return { hasPrevious: false };
  if (!prev || !prev.report) return { hasPrevious: false, current: metaOf(cur) };
  const nowMs = opts.nowMs != null ? opts.nowMs : Date.now();

  const headlines = [];
  const push = (tag, text, weight = 1) => headlines.push({ tag, text, weight });

  // ---- representative FICO + pricing bracket -------------------------------
  const cScore = num(cur.report.representative_score);
  const pScore = num(prev.report.representative_score);
  const cBracket = cur.report.representative_bracket || (cScore != null ? scoring.bracketOf(cScore) : null);
  const pBracket = prev.report.representative_bracket || (pScore != null ? scoring.bracketOf(pScore) : null);
  let representativeScore = null;
  let repHeadline = false; // did the representative FICO already tell the score story?
  if (cScore != null && pScore != null) {
    const delta = cScore - pScore;
    const bracketChanged = !!(cBracket && pBracket && cBracket !== pBracket);
    representativeScore = { current: cScore, previous: pScore, delta, currentBracket: cBracket, previousBracket: pBracket, bracketChanged };
    if (delta !== 0) {
      const n = Math.abs(delta);
      let t = `Representative FICO went ${delta > 0 ? 'up' : 'down'} ${n} point${n === 1 ? '' : 's'} (${pScore} → ${cScore})`;
      if (bracketChanged) t += ` — pricing bracket changed (${pBracket} → ${cBracket})`;
      push(delta > 0 ? 'good' : 'bad', t, bracketChanged ? 4 : 2);
      repHeadline = true;
    }
  }

  // ---- per-borrower / per-bureau score deltas ------------------------------
  const scoreKey = (s) => `${s.report_borrower_id != null ? s.report_borrower_id : ''}|${s.bureau || ''}|${s.model || ''}`;
  const prevScoreMap = new Map((prev.scores || []).map((s) => [scoreKey(s), s]));
  const scoreDeltas = [];
  for (const s of (cur.scores || [])) {
    const p = prevScoreMap.get(scoreKey(s));
    const cv = num(s.value), pv = p ? num(p.value) : null;
    if (cv != null && pv != null && cv !== pv) {
      scoreDeltas.push({ bureau: s.bureau || null, reportBorrowerId: s.report_borrower_id != null ? s.report_borrower_id : null, borrowerId: s.borrower_id || null, model: s.model || null, current: cv, previous: pv, delta: cv - pv });
    }
  }
  // If a bureau's score moved but the REPRESENTATIVE didn't cross (so no headline
  // above), surface the bureau move so `changed` isn't true-with-nothing-shown.
  if (scoreDeltas.length && !repHeadline) {
    const parts = scoreDeltas.slice(0, 3).map((d) => `${d.bureau || 'Bureau'} ${d.previous}→${d.current}`);
    const more = scoreDeltas.length > 3 ? ` +${scoreDeltas.length - 3} more` : '';
    const up = scoreDeltas.some((d) => d.delta > 0), down = scoreDeltas.some((d) => d.delta < 0);
    push(up && !down ? 'good' : (down && !up ? 'bad' : 'neutral'), `Bureau score${scoreDeltas.length > 1 ? 's' : ''} changed: ${parts.join(', ')}${more}`, 2);
  }

  // ---- underwriting findings: new vs cleared -------------------------------
  // Match on type/code + which reported borrower it is about. A finding present
  // (and unreconciled) in the previous pull but gone from this pull is CLEARED —
  // that is the human story behind the gate's "clean re-pull supersedes" rule.
  const fKey = (f) => `${f.type || f.code || ''}|${f.reportBorrowerId != null ? f.reportBorrowerId : ''}`;
  // "Active" must match the gate's own definition (underwriting.activeFatalFindings):
  // a WHOLE-report reconcile (underwriting_finding_reconciled_at set) clears EVERY
  // finding, not just the per-finding-flagged ones — otherwise a finding a human
  // already reconciled on the prior pull would be mis-reported as "cleared by this
  // re-pull", or one reconciled on this pull would show as "no change".
  const activeOf = (rep) => (rep && rep.underwriting_finding_reconciled_at)
    ? []
    : normalizeFindings(rep && rep.underwriting_finding).filter((f) => f && !f.reconciled);
  const curActive = activeOf(cur.report);
  const prevActive = activeOf(prev.report);
  const prevFKeys = new Set(prevActive.map(fKey));
  const curFKeys = new Set(curActive.map(fKey));
  const newFindings = curActive.filter((f) => !prevFKeys.has(fKey(f))).map(slimFinding);
  const clearedFindings = prevActive.filter((f) => !curFKeys.has(fKey(f))).map(slimFinding);
  for (const f of clearedFindings) push('good', `${f.label} cleared since the last pull`, f.severity === 'fatal' ? 4 : 2);
  for (const f of newFindings) push('bad', `New ${f.label.toLowerCase()} on this pull`, f.severity === 'fatal' ? 4 : 2);

  // ---- collections: new vs cleared -----------------------------------------
  // Key on IDENTITY ONLY (bureau|agency|original-creditor), NOT the amount — a
  // collection's balance routinely drifts between pulls (interest, partial pay),
  // and folding the amount into the key would make the SAME collection look both
  // "cleared" AND "new", falsely reporting a rosy "collection cleared". (Matches
  // how tradelines key on identity and treat the balance as a per-line attribute.)
  const colKey = (c) => `${c.bureau || ''}|${normStr(c.collection_agency_name)}|${normStr(c.original_creditor_name)}`;
  const col = diffSets(cur.collections, prev.collections, colKey);
  const slimCol = (c) => ({ bureau: c.bureau || null, agency: c.collection_agency_name || null, originalCreditor: c.original_creditor_name || null, amount: num(c.amount) });
  if (col.added.length) push('bad', `${col.added.length} new collection${col.added.length > 1 ? 's' : ''} (${money(col.added.reduce((s, c) => s + numOr0(c.amount), 0))})`, 3);
  if (col.removed.length) push('good', `${col.removed.length} collection${col.removed.length > 1 ? 's' : ''} cleared`, 3);

  // ---- public records: new vs cleared --------------------------------------
  // Identity = bureau|record-type|filed-date (a judgment/lien amount can be
  // amended between pulls; keying on it would false-"clear" the same record).
  const prKey = (p) => `${p.bureau || ''}|${normStr(p.record_type)}|${p.filed_date || ''}`;
  const pub = diffSets(cur.publicRecords, prev.publicRecords, prKey);
  const slimPub = (p) => ({ bureau: p.bureau || null, recordType: p.record_type || null, filedDate: p.filed_date || null, amount: num(p.amount) });
  if (pub.added.length) push('bad', `${pub.added.length} new public record${pub.added.length > 1 ? 's' : ''}`, 4);
  if (pub.removed.length) push('good', `${pub.removed.length} public record${pub.removed.length > 1 ? 's' : ''} cleared`, 3);

  // ---- inquiries: new since last pull --------------------------------------
  const inqKey = (q) => `${q.bureau || ''}|${normStr(q.inquiring_party_name)}|${q.inquiry_date || ''}`;
  const inq = diffSets(cur.inquiries, prev.inquiries, inqKey);
  const slimInq = (q) => ({ bureau: q.bureau || null, party: q.inquiring_party_name || null, date: q.inquiry_date || null });
  if (inq.added.length) push('neutral', `${inq.added.length} new inquir${inq.added.length > 1 ? 'ies' : 'y'} since the last pull`, 1);

  // ---- tradelines: best-effort account-level diff --------------------------
  // Matched per bureau by creditor + last-4 + account type. This is heuristic —
  // bureaus don't hand out stable IDs across pulls — so it's labelled "best
  // effort" in the UI and only drives soft, additive headlines.
  const tlKey = (t) => `${t.bureau || ''}|${normStr(t.creditor_name)}|${last4(t.account_identifier_masked)}|${normStr(t.account_type)}`;
  const tl = diffSets(cur.tradelines, prev.tradelines, tlKey);
  const slimTl = (t) => ({ bureau: t.bureau || null, creditor: t.creditor_name || null, accountType: t.account_type || null, last4: last4(t.account_identifier_masked) || null, balance: num(t.unpaid_balance) });
  let newlyDerogatory = 0, newlyLate = 0, nowPaid = 0;
  for (const [c, p] of tl.common) {
    const cDerog = c.derogatory_indicator === true || c.is_collection === true;
    const pDerog = p.derogatory_indicator === true || p.is_collection === true;
    if (cDerog && !pDerog) newlyDerogatory++;
    const cLate = numOr0(c.late_30_count) + numOr0(c.late_60_count) + numOr0(c.late_90_count);
    const pLate = numOr0(p.late_30_count) + numOr0(p.late_60_count) + numOr0(p.late_90_count);
    if (cLate > pLate) newlyLate++;
    if (!isClosed(p) && isClosed(c)) nowPaid++;
  }
  if (tl.added.length) push('neutral', `${tl.added.length} new account${tl.added.length > 1 ? 's' : ''} reported`, 1);
  if (tl.removed.length) push('neutral', `${tl.removed.length} account${tl.removed.length > 1 ? 's' : ''} no longer reported`, 1);
  if (newlyDerogatory) push('bad', `${newlyDerogatory} account${newlyDerogatory > 1 ? 's' : ''} newly reported derogatory`, 4);
  if (newlyLate) push('bad', `${newlyLate} account${newlyLate > 1 ? 's' : ''} picked up a new late payment`, 3);
  if (nowPaid) push('good', `${nowPaid} account${nowPaid > 1 ? 's' : ''} now paid/closed`, 1);

  // ---- risk-summary deltas (whole file) ------------------------------------
  const blocksOf = (r) => ({ tradelines: r.tradelines, collections: r.collections, inquiries: r.inquiries, publicRecords: r.publicRecords });
  const curRisk = summarizeRisk(blocksOf(cur), { nowMs });
  const prevRisk = summarizeRisk(blocksOf(prev), { nowMs });
  const pairDelta = (was, now) => ({ previous: was == null ? null : was, current: now == null ? null : now, delta: (was == null || now == null) ? null : now - was });
  const riskDeltas = {
    revolvingUtilizationPct: pairDelta(prevRisk.revolvingUtilizationPct, curRisk.revolvingUtilizationPct),
    totalBalance: pairDelta(prevRisk.totalBalance, curRisk.totalBalance),
    derogatoryCount: pairDelta(prevRisk.derogatoryCount, curRisk.derogatoryCount),
    collectionsCount: pairDelta(prevRisk.collectionsCount, curRisk.collectionsCount),
    publicRecordCount: pairDelta(prevRisk.publicRecordCount, curRisk.publicRecordCount),
    late90Count: pairDelta(prevRisk.late90Count, curRisk.late90Count),
  };
  if (curRisk.revolvingUtilizationPct != null && prevRisk.revolvingUtilizationPct != null && curRisk.revolvingUtilizationPct !== prevRisk.revolvingUtilizationPct) {
    const d = curRisk.revolvingUtilizationPct - prevRisk.revolvingUtilizationPct;
    push(d < 0 ? 'good' : 'bad', `Revolving utilization ${d < 0 ? 'dropped' : 'rose'} from ${prevRisk.revolvingUtilizationPct}% to ${curRisk.revolvingUtilizationPct}%`, Math.abs(d) >= 15 ? 2 : 1);
  }
  // A MATERIAL total-balance move (≥ $1,000) that no line-level headline above
  // already captured — surfaced so `changed` never hides a real dollar swing.
  const balDelta = numOr0(curRisk.totalBalance) - numOr0(prevRisk.totalBalance);
  if (Math.abs(balDelta) >= 1000) {
    push(balDelta < 0 ? 'good' : 'neutral', `Total balances ${balDelta < 0 ? 'fell' : 'rose'} ${money(Math.abs(balDelta))} (${money(prevRisk.totalBalance)} → ${money(curRisk.totalBalance)})`, 1);
  }

  // Most significant first (weight desc), then by original order for stability.
  const sortedHeadlines = headlines.map((h, i) => ({ h, i }))
    .sort((a, b) => (b.h.weight - a.h.weight) || (a.i - b.i)).map((x) => x.h);

  // `changed` is defined as "there is a headline to show" — every material delta
  // above emits one — so the flag exactly matches what the panel renders (no
  // true-but-blank panel, and no unshown-but-flagged change). Immaterial drift
  // (a sub-$1k balance nudge, a collection amount tick) intentionally stays quiet.
  const changed = sortedHeadlines.length > 0;

  return {
    hasPrevious: true,
    changed,
    current: metaOf(cur),
    previous: metaOf(prev),
    representativeScore,
    scoreDeltas,
    findings: { new: newFindings, cleared: clearedFindings },
    collections: { added: col.added.map(slimCol), removed: col.removed.map(slimCol) },
    publicRecords: { added: pub.added.map(slimPub), removed: pub.removed.map(slimPub) },
    inquiries: { added: inq.added.map(slimInq) },
    tradelines: { added: tl.added.map(slimTl), removed: tl.removed.map(slimTl), newlyDerogatory, newlyLate, nowPaid },
    risk: { current: curRisk, previous: prevRisk, deltas: riskDeltas },
    headlines: sortedHeadlines,
  };
}

module.exports = { compareReports };
