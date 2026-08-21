'use strict';

/**
 * THE TRACK-RECORD SECTIONS — built ONCE, read by every export.
 *
 * Lifted out of `tpr-export.js` UNCHANGED (owner-directed 2026-08-21, item 7) so the STAFF
 * export door and the INVESTOR package build the same two sections, with the same columns, the
 * same review statuses and the same records stamp. A second copy is how a report an officer
 * downloads comes to disagree with the one the investor received about the same borrower — and
 * this one now has to serve three different row SETS (verified / all / unverified), which is
 * exactly the moment a duplicate would have been made.
 *
 * It stays a PURE builder — data in, sections out, no database and no IO. The formatting
 * helpers it needs (`addrText`, `dealLabel`, `dateStr`, and `exitInfo`, which carries the
 * frozen 3-year exit window) are required from `tpr-export` LAZILY, which is what lets that
 * module require this one back without a load-time cycle.
 */

/**
 * @param {Array}  records   `track_records` rows, already selected and ordered
 * @param {object} docsByTr  track_record_id -> [document rows]
 * @returns {Array} the two sections `track-record-export` renders
 */
function buildTrackRecordSections(records, docsByTr = {}) {
  const TPR = require('../tpr-export');
  const { addrText, dealLabel, exitInfo, dateStr } = TPR;
  const num = (v) => (v == null || v === '') ? null : Number(v);
  const monthsBetween = (a, b) => {
    if (!a || !b) return '';
    const d1 = new Date(a), d2 = new Date(b);
    if (isNaN(d1) || isNaN(d2)) return '';
    const m = Math.round((d2.getTime() - d1.getTime()) / (1000 * 60 * 60 * 24 * 30.44));
    return m >= 0 ? m : '';
  };
  const isHoldType = (r) => {
    const t = String(r.deal_type || '').toLowerCase();
    if (/rent|hold/.test(t)) return true;
    if (t) return false;   // flip / bridge / ground-up all exit by sale
    return !!(r.rent_amount || r.rent_date || r.refi_amount || r.refi_date);   // infer from data
  };
  const flipCols = [
    { header: 'Property', key: 'property', w: 3, align: 'left' },
    { header: 'Deal type', key: 'dealType', w: 1.3 },
    { header: 'Purchase price', key: 'purchase', w: 1.3, money: true, align: 'right', sum: true },
    { header: 'Purchase date', key: 'purchaseDate', w: 1.1, align: 'center' },
    { header: 'Rehab budget', key: 'rehab', w: 1.2, money: true, align: 'right', sum: true },
    { header: 'Sale price', key: 'sale', w: 1.3, money: true, align: 'right', sum: true },
    { header: 'Sale date', key: 'saleDate', w: 1.1, align: 'center' },
    { header: 'Hold (mo)', key: 'holdMo', w: 0.8, align: 'center' },
    { header: 'Gross profit', key: 'profit', w: 1.2, money: true, align: 'right', sum: true },
    { header: 'Review status', key: 'status', w: 1.5, align: 'center' },
    { header: 'Docs', key: 'docs', w: 0.7, align: 'center' },
    { header: 'Recent (3yr)', key: 'counts', w: 0.9, align: 'center' },
  ];
  const holdCols = [
    { header: 'Property', key: 'property', w: 3, align: 'left' },
    { header: 'Deal type', key: 'dealType', w: 1.3 },
    { header: 'Purchase price', key: 'purchase', w: 1.3, money: true, align: 'right', sum: true },
    { header: 'Purchase date', key: 'purchaseDate', w: 1.1, align: 'center' },
    { header: 'Rehab budget', key: 'rehab', w: 1.2, money: true, align: 'right', sum: true },
    { header: 'Monthly rent', key: 'rent', w: 1.2, money: true, align: 'right', sum: true },
    { header: 'Rented date', key: 'rentDate', w: 1.1, align: 'center' },
    { header: 'Refi amount', key: 'refi', w: 1.2, money: true, align: 'right', sum: true },
    { header: 'Refi date', key: 'refiDate', w: 1.0, align: 'center' },
    { header: 'Current value', key: 'currentValue', w: 1.3, money: true, align: 'right', sum: true },
    { header: 'Review status', key: 'status', w: 1.5, align: 'center' },
    { header: 'Docs', key: 'docs', w: 0.7, align: 'center' },
    { header: 'Recent (3yr)', key: 'counts', w: 0.9, align: 'center' },
  ];
  const trExport = require('../track-record-export');
  // The records-stamp column joins BOTH sections only when at least one line is
  // records-backed — an all-blank column on the investor package is noise, and
  // an unstamped back-book export stays byte-identical. Wording is the ONE
  // definition in track-record/records-stamp.js ("Verified to Elementix").
  const RSTAMP = require('./records-stamp');
  if (records.some((r) => r.records_stamp)) {
    const stampCol = { header: 'Public records', key: 'records', w: 1.8, align: 'left' };
    flipCols.push(stampCol); holdCols.push(stampCol);
  }
  const flipRows = [], holdRows = [];
  for (const r of records) {
    const { exit, counts } = exitInfo(r);
    // The REVIEW STATUS + whether documentation is attached (owner-directed
    // 2026-08-05): the export must say clearly which deals are verified, which
    // have documentation, which are pending review, and which have documentation
    // but are not yet verified — never "everything is verified".
    const hasDocs = (docsByTr[r.id] || []).length > 0;
    const statusKey = trExport.trackRecordReviewStatus({ is_verified: r.is_verified, entered_by_kind: r.entered_by_kind, hasDocs });
    const base = {
      property: addrText(r.property_address) || '', dealType: dealLabel(r.deal_type),
      purchase: num(r.purchase_price), rehab: num(r.rehab_amount),
      purchaseDate: dateStr(r.purchase_date),
      status: trExport.REVIEW_STATUS[statusKey].label,
      docs: hasDocs ? 'Attached' : '—',
      records: RSTAMP.exportCellText(r.records_stamp, r.records_stamp_at),
      // The PDF renderer re-derives its own cell from these (its font cannot
      // carry the glyphs), so the raw values must ride the row.
      __recordsStampAt: r.records_stamp_at || null,
      counts: counts ? 'Yes' : (exit ? 'No' : ''),
      __verified: !!r.is_verified, __status: statusKey, __hasDocs: hasDocs,
      __recordsStamp: r.records_stamp || null,
    };
    if (isHoldType(r)) {
      holdRows.push({ ...base, rent: num(r.rent_amount), rentDate: dateStr(r.rent_date),
        refi: num(r.refi_amount), refiDate: dateStr(r.refi_date), currentValue: num(r.current_value) });
    } else {
      const sale = num(r.sale_price);
      flipRows.push({ ...base, sale, saleDate: dateStr(r.sale_date),
        holdMo: monthsBetween(r.purchase_date, r.sale_date),
        profit: sale != null ? sale - (num(r.purchase_price) || 0) - (num(r.rehab_amount) || 0) : null });
    }
  }
  const trSections = [
    { title: 'FIX & FLIP EXPERIENCE   (exit = sale)', columns: flipCols, rows: flipRows },
    { title: 'FIX & HOLD / RENTAL EXPERIENCE   (exit = lease-up / refinance)', columns: holdCols, rows: holdRows },
  ];

  return trSections;
}

module.exports = { buildTrackRecordSections };
