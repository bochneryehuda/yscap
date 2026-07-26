'use strict';
/**
 * Identity chain deep check (R4.2, owner-directed 2026-07-22).
 *
 * Composes with R3.9 (entity chain) and R3.23 (public-records cross-check):
 * those check SELLER + ENTITY relationships across docs. This one checks
 * BORROWER IDENTITY across every doc that carries it — driver's license,
 * credit report, bank statement, tax return, insurance dec, LLC operating
 * agreement, etc.
 *
 * Flags:
 *   * SSN last-4 disagrees between two docs (loud — identity fraud signal)
 *   * DOB disagrees between two docs after strict day equality
 *   * Name variations that aren't explainable by suffix/initial normalization
 *
 * Per HARD RULE: never touches the file. Emits ai_suggestions only.
 */

const aiSug = require('./ai-suggestions');

function last4(ssn) {
  const digits = String(ssn || '').replace(/\D/g, '');
  if (digits.length < 4) return null;
  return digits.slice(-4);
}
function normName(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[.,]/g, ' ')
    .replace(/\bjr\b|\bsr\b|\bii\b|\biii\b|\biv\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
function initialsMatch(a, b) {
  // 'John Doe' vs 'J. Doe' → same. Split into tokens; require the LAST token
  // to be identical, and every earlier token to either match exactly or be a
  // single-letter initial matching the first letter of the counterpart.
  const A = normName(a).split(' ').filter(Boolean);
  const B = normName(b).split(' ').filter(Boolean);
  if (!A.length || !B.length) return false;
  if (A[A.length - 1] !== B[B.length - 1]) return false;
  const shorter = A.length < B.length ? A : B;
  const longer = A.length < B.length ? B : A;
  for (let i = 0; i < shorter.length - 1; i += 1) {
    const s = shorter[i]; const l = longer[i];
    if (!s || !l) return false;
    if (s === l) continue;
    if (s.length === 1 && s === l[0]) continue;
    if (l.length === 1 && l === s[0]) continue;
    return false;
  }
  return true;
}

function docLabel(t) {
  return ({
    drivers_license: 'ID', credit_report: 'Credit report', bank_statement: 'Bank statement',
    tax_return: 'Tax return', insurance: 'Insurance dec', operating_agreement: 'Operating agreement',
    purchase_contract: 'Purchase contract', appraisal: 'Appraisal', title: 'Title', settlement: 'Settlement',
  }[t]) || String(t || 'Doc');
}

/**
 * PURE — walk every extraction and return the list of identity mismatches.
 * Zero DB.
 * @param {Array<{doc_type, fields}>} extractions
 * @returns {{issues:Array<{code, severity, title, howTo, docsInvolved, values}>}}
 */
function analyze(extractions = []) {
  const seenSsn = new Map();
  const seenDob = new Map();
  const seenName = new Map();
  const issues = [];

  for (const e of extractions) {
    const doc = e.doc_type || e.docType;
    const f = e.fields || {};
    const ssn = last4(f.borrowerSSN || f.ssn || f.borrower_ssn || f.ssnLast4);
    const dob = f.borrowerDOB || f.dob || f.date_of_birth || null;
    const name = f.borrowerName || f.borrower_full_name || f.applicantName || f.fullName || null;

    if (ssn) {
      const prev = seenSsn.get(ssn);
      if (!prev) seenSsn.set(ssn, { docType: doc });
      for (const [otherSsn, meta] of seenSsn.entries()) {
        if (otherSsn === ssn) continue;
        issues.push({
          code: 'identity_ssn_mismatch', severity: 'fatal',
          title: `Two different SSNs seen on this borrower`,
          howTo: `The ${docLabel(meta.docType)} shows SSN ending ${otherSsn} but the ${docLabel(doc)} shows ${ssn}. Confirm with the borrower which SSN is theirs — an SSN mismatch is a hard identity-fraud signal.`,
          docsInvolved: [meta.docType, doc], values: { docA_last4: otherSsn, docB_last4: ssn },
        });
        seenSsn.set(otherSsn, meta); // keep first
        break; // one mismatch per doc is enough
      }
    }
    if (dob) {
      const prev = seenDob.get(dob);
      if (!prev) seenDob.set(dob, { docType: doc });
      for (const [otherDob, meta] of seenDob.entries()) {
        if (otherDob === dob) continue;
        issues.push({
          code: 'identity_dob_mismatch', severity: 'warning',
          title: `Two different dates of birth seen on this borrower`,
          howTo: `The ${docLabel(meta.docType)} shows DOB ${otherDob} but the ${docLabel(doc)} shows ${dob}. Verify with the borrower which is correct — the discrepancy may just be a typo but must not carry into the loan file.`,
          docsInvolved: [meta.docType, doc], values: { docA: otherDob, docB: dob },
        });
        break;
      }
    }
    if (name) {
      const nrm = normName(name);
      const prev = seenName.get(nrm);
      if (!prev) {
        // Walk previously-seen names and check compatibility
        let compat = false;
        for (const seen of seenName.keys()) {
          if (initialsMatch(nrm, seen)) { compat = true; break; }
        }
        if (!compat && seenName.size > 0) {
          const otherNorm = seenName.keys().next().value;
          const meta = seenName.get(otherNorm);
          issues.push({
            code: 'identity_name_variation', severity: 'info',
            title: `Borrower name reads differently on two documents`,
            howTo: `The ${docLabel(meta.docType)} names "${meta.original}" but the ${docLabel(doc)} names "${name}". Often benign (nickname, middle-initial vs full middle name, married vs maiden), but note it and confirm with the ID which name is legal.`,
            docsInvolved: [meta.docType, doc], values: { docA: meta.original, docB: name },
          });
        }
        seenName.set(nrm, { docType: doc, original: name });
      }
    }
  }
  return { issues };
}

/**
 * DB bridge — record each mismatch as an ai_suggestion (source='entity_chain',
 * dedupe key per code+docs pair).
 */
async function analyzeAndRecord(client, { applicationId, extractions }) {
  const v = analyze(extractions);
  if (!v.issues.length) return { recorded: 0, deduped: 0, failed: 0 };
  const suggestions = v.issues.map((m) => ({
    applicationId,
    source: 'entity_chain', kind: 'finding',
    title: m.title, body: m.howTo,
    severity: m.severity,
    evidence: { code: m.code, docs: m.docsInvolved, values: m.values, layer: 'identity_chain' },
    proposedAction: {
      type: 'create_finding',
      fields: { code: m.code, severity: m.severity, title: m.title, howTo: m.howTo, source: 'identity_chain' },
    },
    dedupeKey: `identity:${m.code}:${(m.docsInvolved || []).sort().join(',')}`,
  }));
  return aiSug.recordMany(client, suggestions);
}

module.exports = { analyze, analyzeAndRecord, _internals: { normName, initialsMatch, last4 } };
