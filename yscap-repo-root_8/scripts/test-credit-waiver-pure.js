'use strict';
/**
 * PURE test for the credit-import waiver — sign the credit condition off on a
 * report obtained ELSEWHERE (owner-directed 2026-08-03). No DB, no network.
 *
 * What it pins, and why each one is here:
 *   • the exception type is registered with the right SHAPE (not expirable — a
 *     clock must never re-arm a condition somebody cleared; not record-only — it
 *     is a real request → decision; no decideRole — the register's default
 *     admin gate, matching "the admin should sign off");
 *   • the reason codes, including that a reason belonging to ANOTHER type is
 *     refused (the appraisal waiver's codes must not leak in here);
 *   • the uploaded-report predicate excludes the IMPORTER'S OWN two documents —
 *     if `credit_pdf` counted, every ordinary imported file would look as though
 *     it carried an outside report, and an approved exception would then clear a
 *     condition on the importer's own PDF;
 *   • the TWO-HALF rule, over the full truth table: an approved exception with
 *     nothing accepted does NOT count, an accepted report with no approval does
 *     NOT count, and only both together do;
 *   • it FAILS CLOSED — a throwing/absent table reads as "no waiver", never as a
 *     silent bypass;
 *   • the FOLDER half of the owner's instruction: an uploaded credit report is
 *     categorized to "Credit Report" by BOTH the TPR export and the SharePoint
 *     mirror. That is pure and provable here; the acceptance half (only an
 *     accepted document ships) is proven in the DB test.
 */
const assert = require('assert');
const LE = require('../src/lib/loan-exceptions');
const waiver = require('../src/lib/credit/waiver');
const tpr = require('../src/lib/tpr-export');
const sp = require('../src/lib/sharepoint-backup');

let failures = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };

// ── 1) the exception type is registered, with the shape the policy needs ──────
ok(LE.isExceptionType('credit_import_waiver'), 'credit_import_waiver is a registered exception type');
const cfg = LE.typeConfig('credit_import_waiver');
ok(!!cfg, 'it has a type config');
ok(cfg && cfg.subject === 'file', 'its subject is the FILE (not a named co-borrower)');
ok(cfg && cfg.expirable === false,
  'it is NOT expirable — a condition somebody signed off must never be re-armed by a clock');
ok(cfg && cfg.recordOnly === false,
  'it is NOT record-only — it is a real request an admin decides, never born approved');
ok(cfg && !cfg.decideRole,
  'it carries no decideRole — the register default (manage_pricing = admins + super-admins) applies');
ok(typeof LE.requestCreditImportWaiver === 'function', 'requestCreditImportWaiver is exported');

// ── 2) reason codes ──────────────────────────────────────────────────────────
for (const code of ['report_from_elsewhere', 'avoid_new_inquiry', 'vendor_unavailable', 'other']) {
  ok(LE.isReasonCodeFor('credit_import_waiver', code), `${code} is a valid reason`);
  ok(!!LE.reasonLabelFor('credit_import_waiver', code), `${code} has a human label`);
}
ok(!LE.isReasonCodeFor('credit_import_waiver', 'appraiser_no_xml'),
  'a reason belonging to the APPRAISAL waiver is refused here');
ok(!LE.isReasonCodeFor('credit_import_waiver', 'nonsense'), 'a junk reason is refused');

// ── 3) the uploaded-report predicate ─────────────────────────────────────────
// It must exclude BOTH documents the importer files itself. `credit_pdf` is the
// dangerous one: it is a real, readable credit report PDF, so counting it would
// make every ordinary imported file look as though it carried an outside report.
const sql = waiver.UPLOADED_REPORT_SQL('d');
ok(/d\.doc_kind/.test(sql), 'the predicate is alias-aware');
ok(/credit_xml/.test(sql) && /credit_pdf/.test(sql),
  "it names BOTH of the importer's own kinds");
ok(/NOT IN/.test(sql), 'it EXCLUDES them (a human upload is anything else)');
ok(/COALESCE\(d\.doc_kind,''\)/.test(sql),
  'doc_kind is COALESCEd — a human upload carries NULL, and a bare nullable column in a NOT IN is the repo’s three-valued-logic trap');
ok(!/d\.d\./.test(waiver.UPLOADED_REPORT_SQL('')), 'an empty alias produces an unqualified column');

// ── 4) the TWO-HALF rule, over the whole truth table ─────────────────────────
// A tiny stub db: one waiver row, a document count, an exception status.
function stubDb({ hasWaiver = true, uploaded = 0, accepted = 0, exStatus = 'requested', throwOn = null }) {
  return {
    query: async (text) => {
      if (throwOn && text.includes(throwOn)) throw new Error('boom');
      if (text.includes('FROM credit_import_waivers')) {
        return { rows: hasWaiver ? [{ application_id: 'app-1', reason: 'report_from_elsewhere', note: 'broker pulled it', exception_id: exStatus ? 'ex-1' : null }] : [] };
      }
      if (text.includes('FROM documents')) return { rows: [{ uploaded, accepted }] };
      if (text.includes('FROM loan_exceptions')) return { rows: exStatus ? [{ status: exStatus }] : [] };
      return { rows: [] };
    },
  };
}

(async () => {
  const noWaiver = await waiver.loadWaiver('item-1', stubDb({ hasWaiver: false }));
  ok(noWaiver.present === false, 'no waiver row → present:false');
  ok(!noWaiver.effective, 'and it is not effective');
  ok(await waiver.creditWaiverActive('item-1', stubDb({ hasWaiver: false })) === false,
    'creditWaiverActive is false with no waiver — the ordinary import rule stands');

  const pendingEx = await waiver.loadWaiver('item-1', stubDb({ uploaded: 1, accepted: 1, exStatus: 'requested' }));
  ok(pendingEx.present && !pendingEx.effective,
    'an ACCEPTED report with the exception still WAITING does not count');
  ok(/waiting for an admin/i.test(waiver.pendingReason(pendingEx) || ''),
    'and it says the exception is waiting on an admin');

  const deniedEx = await waiver.loadWaiver('item-1', stubDb({ uploaded: 1, accepted: 1, exStatus: 'denied' }));
  ok(!deniedEx.effective, 'a DENIED exception does not count');
  ok(/DENIED/i.test(waiver.pendingReason(deniedEx) || ''), 'and it says so');

  const withdrawnEx = await waiver.loadWaiver('item-1', stubDb({ uploaded: 1, accepted: 1, exStatus: 'withdrawn' }));
  ok(!withdrawnEx.effective, 'a WITHDRAWN exception does not count');

  const noDoc = await waiver.loadWaiver('item-1', stubDb({ uploaded: 0, accepted: 0, exStatus: 'approved' }));
  ok(noDoc.present && !noDoc.effective,
    'an APPROVED exception with NO report on the condition does not count — it would clear the condition on nothing');
  ok(/no credit report uploaded/i.test(waiver.pendingReason(noDoc) || ''), 'and it says there is no report');

  const pendingDoc = await waiver.loadWaiver('item-1', stubDb({ uploaded: 1, accepted: 0, exStatus: 'approved' }));
  ok(!pendingDoc.effective,
    'an APPROVED exception over a report nobody has ACCEPTED does not count (owner: "the PDF if it’s accepted")');
  ok(/has not been accepted yet/i.test(waiver.pendingReason(pendingDoc) || ''), 'and it says to accept it first');

  const good = await waiver.loadWaiver('item-1', stubDb({ uploaded: 2, accepted: 1, exStatus: 'approved' }));
  ok(good.effective, 'APPROVED exception + an ACCEPTED report → the waiver counts');
  ok(good.acceptedCount === 1 && good.uploadedCount === 2, 'it reports both counts');
  ok(waiver.pendingReason(good) === null, 'an effective waiver has nothing outstanding to report');
  ok(await waiver.creditWaiverActive('item-1', stubDb({ uploaded: 1, accepted: 1, exStatus: 'approved' })) === true,
    'creditWaiverActive is true only in that state');

  // ── 5) FAILS CLOSED ───────────────────────────────────────────────────────
  for (const t of ['FROM credit_import_waivers', 'FROM documents', 'FROM loan_exceptions']) {
    const broken = await waiver.loadWaiver('item-1', stubDb({ uploaded: 1, accepted: 1, exStatus: 'approved', throwOn: t }));
    ok(broken.present === false && !broken.effective,
      `a read error on "${t}" reads as NO waiver — never a silent bypass`);
  }
  ok(await waiver.creditWaiverActive(null, stubDb({})) === false, 'no item id → no waiver');

  // ── 6) the FOLDER half: it files under "Credit Report" on both surfaces ────
  // A human upload on the credit condition carries doc_kind NULL, so the
  // condition's template code is its whole identity on both sides.
  const uploadedDoc = { doc_kind: null, template_code: 'rtl_cond_credit', item_label: 'Credit report',
    filename: 'borrower-credit-report.pdf', slot_label: 'Credit report (uploaded)' };
  ok(tpr.categoryFor(uploadedDoc) === 'Credit Report',
    'the TPR export files an uploaded credit report under "Credit Report"');
  ok(sp.categoryFor(uploadedDoc) === 'Credit Report',
    'the SharePoint mirror files it under the SAME "Credit Report" folder');
  // The co-borrower's own credit condition uses the same template code, so its
  // uploaded report lands in the same folder rather than an uncategorized one.
  ok(tpr.categoryFor({ ...uploadedDoc, item_label: 'Credit report (co-borrower)' }) === 'Credit Report',
    "a co-borrower's uploaded report files under Credit Report too");

  console.log(failures ? `\ntest-credit-waiver-pure: ${failures} FAILURE(S)` : '\ntest-credit-waiver-pure: all checks passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('test-credit-waiver-pure CRASHED', e); process.exit(1); });
