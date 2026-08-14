/**
 * PURE test — the AUTOMATIC appraisal-XML waiver a Hybrid Appraisal order records
 * (src/lib/appraisal/xml-waiver.js), owner-directed 2026-08-14:
 *
 *   "Whenever you order this type of appraisal on our system, the XML should
 *    automatically be waived because this appraisal does not require XML and
 *    doesn't work with XML."
 *
 *   node scripts/test-richer-value-xml-waiver.js
 *
 * WHAT MAKES THIS SAFE, and what each test is defending:
 *
 *   • It lifts the XML requirement AND NOTHING ELSE. The PDF report is still
 *     required on the appraisal condition, and the As-Is value and the ARV must
 *     still be on the file. Those two are what the `effective` flag is about, and
 *     they are the reason an order does not silently clear a condition the moment
 *     it is placed.
 *
 *   • It NEVER overwrites a waiver a human recorded. A reviewer who already
 *     recorded "the appraiser won't send the XML", with a note and an exception an
 *     admin is looking at, has made a decision about this file — replacing it with
 *     an automatic one would withdraw that exception and erase why.
 *
 *   • It NEVER applies to a file that already has an imported appraisal, because
 *     then there IS XML and "no XML available" would be a false claim.
 *
 *   • THE EXISTING TWO REASONS ARE UNTOUCHED. Half of what follows is proving
 *     that a transferred appraisal and an exception-backed waiver behave exactly
 *     as they did before a third reason existed.
 *
 * The module takes its `db` as an argument, so this runs against a stub with no
 * database — which is also what lets it assert the exact QUERIES the guards make.
 */
const assert = require('assert');
const R = require('path').resolve(__dirname, '..');
const W = require(R + '/src/lib/appraisal/xml-waiver');

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); pass++; };
const eq = (a, b, m) => { assert.strictEqual(a, b, `${m} (got ${JSON.stringify(a)}, wanted ${JSON.stringify(b)})`); pass++; };

/**
 * A stub database that answers by matching the SQL, and records every statement
 * so a test can assert what was asked as well as what came back.
 */
function stubDb({ waiver = null, app = {}, exception = null, appraisal = null, onInsert, onDelete } = {}) {
  const seen = [];
  return {
    seen,
    async query(sql, params) {
      seen.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
      // The write branches are tested FIRST: "DELETE FROM appraisal_xml_waivers"
      // also matches a bare /FROM appraisal_xml_waivers/, so a SELECT-shaped test
      // placed above them silently swallows the delete and the test proves nothing.
      if (/INSERT INTO appraisal_xml_waivers/.test(sql)) { if (onInsert) onInsert(params, sql); return { rows: [], rowCount: 1 }; }
      if (/DELETE FROM appraisal_xml_waivers/.test(sql)) { if (onDelete) onDelete(params, sql); return { rows: [], rowCount: 1 }; }
      if (/FROM appraisal_xml_waivers/.test(sql)) return { rows: waiver ? [waiver] : [], rowCount: waiver ? 1 : 0 };
      if (/FROM applications/.test(sql)) return { rows: [app], rowCount: 1 };
      if (/FROM loan_exceptions/.test(sql)) return { rows: exception ? [exception] : [], rowCount: exception ? 1 : 0 };
      if (/FROM appraisals/.test(sql)) return { rows: appraisal ? [appraisal] : [], rowCount: appraisal ? 1 : 0 };
      if (/UPDATE checklist_items/.test(sql)) return { rows: [], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
  };
}

const VALUES_ON_FILE = { as_is_value: '90000', arv: '164700' };
const NO_VALUES = { as_is_value: null, arv: null };

/* ========================================================================== *
 * A. The new reason clears itself — with no exception and no transfer letter.
 * ========================================================================== */
(async () => {
  {
    const w = await W.loadWaiver('app-1', stubDb({
      waiver: { reason: 'hybrid_appraisal', requires_transfer_letter: false, exception_id: null },
      app: VALUES_ON_FILE,
    }));
    eq(w.present, true, 'A1 the waiver is found');
    eq(w.autoCleared, true, 'A2 the hybrid reason clears itself');
    eq(w.productHasNoXml, true, 'A3 and is flagged as "this product has no data file"');
    eq(w.exceptionId, null, 'A4 with no exception opened');
    eq(w.requiresTransferLetter, false, 'A5 and no transfer letter asked for');
    eq(w.effective, true, 'A6 so with the values on the file it counts');
  }

  /* ---- but ONLY once the two figures are on the file --------------------- */
  {
    const w = await W.loadWaiver('app-1', stubDb({
      waiver: { reason: 'hybrid_appraisal', requires_transfer_letter: false, exception_id: null },
      app: NO_VALUES,
    }));
    eq(w.autoCleared, true, 'A7 the reason still clears itself');
    eq(w.valuesOnFile, false, 'A8 but the values are not there');
    eq(w.effective, false,
      'A9 so the waiver does NOT count yet — placing an order must never clear the appraisal condition on its own');
  }
  {
    // One figure is not both. An ARV with no As-Is is exactly the state a
    // half-applied write leaves, and it must not read as done.
    const w = await W.loadWaiver('app-1', stubDb({
      waiver: { reason: 'hybrid_appraisal', requires_transfer_letter: false, exception_id: null },
      app: { as_is_value: null, arv: '164700' },
    }));
    eq(w.effective, false, 'A10 one figure of the two is not enough');
  }

  /* ========================================================================== *
   * B. THE OTHER TWO REASONS ARE UNCHANGED. This is the half that proves adding
   *    a third reason did not loosen the two that were already there.
   * ========================================================================== */
  {
    const w = await W.loadWaiver('app-1', stubDb({
      waiver: { reason: 'transferred_appraisal', requires_transfer_letter: true, exception_id: null },
      app: VALUES_ON_FILE,
    }));
    eq(w.effective, true, 'B1 a transferred appraisal still auto-clears');
    eq(w.requiresTransferLetter, true, 'B2 and still asks for its transfer letter');
    eq(w.productHasNoXml, false, 'B3 and is not the product reason');
  }
  {
    const w = await W.loadWaiver('app-1', stubDb({
      waiver: { reason: 'appraiser_no_xml', requires_transfer_letter: false, exception_id: 'ex-1' },
      app: VALUES_ON_FILE,
      exception: { status: 'requested' },
    }));
    eq(w.autoCleared, false, 'B4 "the appraiser will not send it" does NOT clear itself');
    eq(w.effective, false, 'B5 and waits for an admin, exactly as before');
  }
  {
    const w = await W.loadWaiver('app-1', stubDb({
      waiver: { reason: 'appraiser_no_xml', requires_transfer_letter: false, exception_id: 'ex-1' },
      app: VALUES_ON_FILE,
      exception: { status: 'approved' },
    }));
    eq(w.effective, true, 'B6 and counts once the admin approves it');
  }
  {
    // FAIL CLOSED: an unreadable waiver is treated as absent, never as a bypass.
    const broken = { async query() { throw new Error('database is having a moment'); } };
    const w = await W.loadWaiver('app-1', broken);
    eq(w.present, false, 'B7 an unreadable waiver reads as no waiver');
  }

  /* ========================================================================== *
   * C. RECORDING IT — the five things it refuses to do.
   * ========================================================================== */
  {
    let inserted = null;
    let insertSql = '';
    const db = stubDb({ onInsert: (p, sql) => { inserted = p; insertSql = sql.replace(/\s+/g, ' '); } });
    const out = await W.applyProductNoXmlWaiver('app-1', { note: 'ordered a Hybrid Appraisal', staffId: 'staff-1', db });
    eq(out.applied, true, 'C1 a clean file records the waiver');
    eq(inserted[1], W.PRODUCT_NO_XML_REASON, 'C2 under the product reason');
    // The transfer-letter flag and the exception id are LITERALS in the statement,
    // not parameters — which is the point: there is no code path by which this
    // waiver can open an exception or demand a transfer letter.
    ok(/VALUES \(\$1, \$2, \$3, false, NULL, \$4, now\(\)\)/.test(insertSql),
      'C3 no transfer letter and NO exception id — nothing is sent to an admin, and it is not even parameterised');
    ok(db.seen.some((s) => /UPDATE checklist_items/.test(s.sql)),
      'C4 and the appraisal condition is nudged off "outstanding", the same nudge the manual waiver makes');
  }
  {
    // A human's waiver is a decision about this file. Never replace it.
    const db = stubDb({ waiver: { reason: 'appraiser_no_xml' } });
    const out = await W.applyProductNoXmlWaiver('app-1', { db });
    eq(out.applied, false, 'C5 a waiver a human recorded is left alone');
    eq(out.reason, 'human_waiver_present', 'C6 and says so');
    ok(!db.seen.some((s) => /INSERT INTO appraisal_xml_waivers/.test(s.sql)), 'C7 nothing was written');
  }
  {
    // A second order on the same file is a no-op, not a duplicate.
    const db = stubDb({ waiver: { reason: 'hybrid_appraisal' } });
    const out = await W.applyProductNoXmlWaiver('app-1', { db });
    eq(out.applied, false, 'C8 a second Hybrid order does not re-record it');
    eq(out.reason, 'already_applied', 'C9 and reports why');
  }
  {
    // A file with an imported appraisal HAS XML — the claim would be false.
    const db = stubDb({ appraisal: { x: 1 } });
    const out = await W.applyProductNoXmlWaiver('app-1', { db });
    eq(out.applied, false, 'C10 a file with an imported appraisal is never waived');
    eq(out.reason, 'appraisal_imported', 'C11 and says why');
  }
  {
    // It may never fail the order that is paying for the report.
    const broken = { async query() { throw new Error('nope'); } };
    const out = await W.applyProductNoXmlWaiver('app-1', { db: broken });
    eq(out.applied, false, 'C12 an unrecordable waiver never throws');
    eq(out.reason, 'error', 'C13 it reports the failure instead');
  }
  {
    const out = await W.applyProductNoXmlWaiver(null, { db: stubDb({}) });
    eq(out.applied, false, 'C14 no application, nothing recorded');
  }

  /* ========================================================================== *
   * D. WITHDRAWING IT — only ever its own.
   * ========================================================================== */
  {
    let deleted = null;
    const db = stubDb({ onDelete: (p) => { deleted = p; } });
    await W.withdrawProductNoXmlWaiver('app-1', { db });
    eq(deleted[1], W.PRODUCT_NO_XML_REASON,
      'D1 the delete is keyed on the product reason, so a waiver a human recorded can never be removed by cancelling an order');
  }
  {
    const broken = { async query() { throw new Error('nope'); } };
    const out = await W.withdrawProductNoXmlWaiver('app-1', { db: broken });
    eq(out.removed, false, 'D2 and it never throws either');
  }

  /* ========================================================================== *
   * E. The vocabulary itself.
   * ========================================================================== */
  {
    ok(W.AUTO_CLEAR_REASONS.has('transferred_appraisal'), 'E1 the transfer reason is self-clearing');
    ok(W.AUTO_CLEAR_REASONS.has('hybrid_appraisal'), 'E2 and so is the product reason');
    eq(W.AUTO_CLEAR_REASONS.has('appraiser_no_xml'), false, 'E3 and nothing else is');
    eq(W.AUTO_CLEAR_REASONS.size, 2, 'E4 exactly two reasons clear themselves — a third needs a deliberate decision');

    // The manual reason list on the staff route must NOT offer this one: the
    // claim it makes is "an order for a no-XML product exists on this file", and
    // only the order desk can know that.
    const staffSrc = require('fs').readFileSync(R + '/src/routes/staff.js', 'utf8');
    const list = /APPRAISAL_XML_WAIVE_REASONS\s*=\s*\{([^}]*)\}/.exec(staffSrc);
    ok(list, 'E5 the manual reason list is still there');
    eq(/hybrid_appraisal/.test(list[1]), false,
      'E6 and does NOT offer the product reason — a person cannot claim it by hand without an order');
  }

  console.log(`test-richer-value-xml-waiver: ${pass} assertions passed`);
})().catch((e) => { console.error(e); process.exit(1); });
