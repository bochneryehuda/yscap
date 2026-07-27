'use strict';
/**
 * SharePoint short-path fixes (owner-directed 2026-07-27) — PURE, no DB/network.
 *
 * The Windows/OneDrive local path limit is 259 characters; past it Office/Acrobat
 * refuse to OPEN a synced file ("the file path is more than 259 characters").
 * Two changes shorten every mirrored path:
 *   1) stripPathEchoes() removes the redundant address/borrower/officer/LLC slug
 *      the export tools bake into the filename (the folder already names them).
 *   2) resolveSyncFolder creates officer/borrower/address folders PLAINLY — the
 *      "Synced by Pilot" marker is kept once (the leaf) — and the matcher still
 *      recognizes existing MARKED folders so nothing is duplicated/renamed.
 */
const B = require('../src/lib/sharepoint-backup');
const M = require('../src/lib/sharepoint-map');
const SP = require('../src/lib/sharepoint');

const strip = B.stripPathEchoes;
let pass = 0, fail = 0;
const eq = (msg, got, want) => {
  if (got === want) { pass++; }
  else { fail++; console.error(`FAIL ${msg}\n   got:  ${JSON.stringify(got)}\n   want: ${JSON.stringify(want)}`); }
};
const ok = (msg, cond) => eq(msg, !!cond, true);

// ── 1) echo-strip: the reported case (Scope of Work embeds the address) ──────
const goldman = { address_one_line: '62 Highland Street, Wethersfield, CT 06109',
                  borrower_first: 'Aron', borrower_last: 'Goldman', officer_name: 'Josef Schnitzler' };
eq('SOW pdf drops the address echo',
   strip('62_Highland_Street_Wethersfield_CT_06109_SOW_2026-07-26.pdf', goldman),
   'SOW_2026-07-26.pdf');
eq('SOW xlsx drops the address echo (ext preserved)',
   strip('62_Highland_Street_Wethersfield_CT_06109_SOW_2026-07-26.xlsx', goldman),
   'SOW_2026-07-26.xlsx');
ok('the stripped name is meaningfully shorter',
   strip('62_Highland_Street_Wethersfield_CT_06109_SOW_2026-07-26.pdf', goldman).length
     < '62_Highland_Street_Wethersfield_CT_06109_SOW_2026-07-26.pdf'.length);

// ── echo in the MIDDLE (term sheet / track record embed the borrower name) ───
const lichtman = { borrower_first: 'Pinches', borrower_last: 'Lichtman' };
eq('term sheet drops the borrower echo (middle of the name)',
   strip('YS_Term_Sheet_Pinches_Lichtman_2026-07-27.pdf', lichtman), 'YS_Term_Sheet_2026-07-27.pdf');
eq('track record html drops the borrower echo',
   strip('Track_Record_Pinches_Lichtman_2026-07-26.html', lichtman), 'Track_Record_2026-07-26.html');

// ── the tools slice the address slug to 40 chars — that prefix is stripped too ─
const longAddr = { address_one_line: '4830 Northwest Industrial Park Boulevard, Springfield, IL 62704' };
const slug40 = String('4830 Northwest Industrial Park Boulevard').replace(/[^\w]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
eq('a 40-char-sliced address prefix is stripped',
   strip(slug40 + '_SOW_2026-07-26.pdf', longAddr), 'SOW_2026-07-26.pdf');

// ── LLC echo (formation docs nest under the LLC name) ────────────────────────
eq('LLC-name echo is stripped',
   strip('76_Thompson_St_LLC_formation.pdf', { llc_name: '76 Thompson St LLC' }), 'formation.pdf');

// ── a borrower-uploaded name that HAPPENS to lead with the borrower name ─────
eq('a leading borrower echo on an upload is stripped (rest kept as-is)',
   strip('Aron Goldman bank statement.pdf', goldman), 'bank statement.pdf');

// ── ECHO-ONLY: names with no echo are returned byte-for-byte UNCHANGED ────────
eq('an ordinary upload with a space keeps its exact name',
   strip('bank statement.pdf', goldman), 'bank statement.pdf');
eq('a system name with no echo is unchanged',
   strip('credit-report.pdf', goldman), 'credit-report.pdf');
eq('no echo when the row carries no context',
   strip('SOW_2026-07-26.pdf', {}), 'SOW_2026-07-26.pdf');

// ── robustness: never throws on missing/odd input ────────────────────────────
let threw = false;
try {
  strip('x.pdf', null);
  strip(null, {});
  strip('', goldman);
  strip('.gitignore', goldman);
  strip('no-extension-file', { borrower_last: 'Goldman' });
} catch (e) { threw = true; console.error('threw:', e.message); }
ok('never throws on null/empty/odd input', !threw);
// a 2-3 letter name/token is never stripped (would be dangerous)
eq('a too-short slug is never stripped', strip('Al_report.pdf', { borrower_last: 'Al' }), 'Al_report.pdf');
// a SHORT single-token surname must not over-strip a real word (audit finding)
eq('a 4-letter single-token surname is NOT stripped', strip('Park_Avenue_appraisal.pdf', { borrower_last: 'Park' }), 'Park_Avenue_appraisal.pdf');
eq('a 4-letter single-token LLC is NOT stripped', strip('Acme_invoice.pdf', { llc_name: 'Acme' }), 'Acme_invoice.pdf');
// a >=6-char single-token surname still strips (safe)
eq('a 7-letter single-token surname still strips', strip('Goldman_id.pdf', { borrower_last: 'Goldman' }), 'id.pdf');
// a multi-token slug still strips at >=4 chars (the whole point)
ok('a multi-token borrower name still strips', strip('Al Ng bank.pdf', { borrower_first: 'Al', borrower_last: 'Ng' }) === 'bank.pdf' || strip('Al Ng bank.pdf', { borrower_first: 'Al', borrower_last: 'Ng' }) === 'Al Ng bank.pdf');

// ── 2) matcher safety: plain AND marked folders both match (no duplication) ──
ok('a PLAIN borrower folder matches going forward', M.borrowerMatches('Aron Goldman', 'Aron', 'Goldman'));
ok('an EXISTING marked borrower folder still matches', M.borrowerMatches('Aron Goldman, Synced by Pilot', 'Aron', 'Goldman'));
ok('a legacy-marked borrower folder still matches', M.borrowerMatches('Aron Goldman, YS portal syncing', 'Aron', 'Goldman'));
ok('a PLAIN address folder matches going forward', M.addressMatches('62 Highland Street, Wethersfield, CT 06109', '62 Highland Street'));
ok('an EXISTING marked address folder still matches', M.addressMatches('62 Highland Street, Wethersfield, CT 06109, Synced by Pilot', '62 Highland Street'));
ok('a PLAIN officer folder matches', M.officerMatches('Josef Schnitzler', 'Josef Schnitzler'));

// ── 3) backwards repair: dropSyncMarker un-marks the app's OWN folders ───────
eq('drops the new marker', SP.dropSyncMarker('Aron Goldman, Synced by Pilot'), 'Aron Goldman');
eq('drops the legacy marker', SP.dropSyncMarker('62 Highland Street, Wethersfield, CT 06109, YS portal syncing'), '62 Highland Street, Wethersfield, CT 06109');
eq('drops the legacy short marker', SP.dropSyncMarker('Josef Schnitzler, YS portal sync'), 'Josef Schnitzler');
eq('a plain folder has no marker to drop', SP.dropSyncMarker('Aron Goldman'), null);
eq('the LEAF sync folder is NEVER un-marked (it is the marker)', SP.dropSyncMarker('Synced by Pilot'), null);
eq('a folder whose name merely contains the words is not falsely stripped', SP.dropSyncMarker('Synced by Pilot notes'), null);
eq('null/empty is safe', SP.dropSyncMarker(null), null);
ok('renameOwnItem + dropSyncMarker are exported', typeof SP.renameOwnItem === 'function' && typeof SP.dropSyncMarker === 'function');
// Regression guard for the folder-repair no-op: renameOwnItem tells a folder from
// a file via cur.folder, which Graph only returns when the $select asks for it.
ok('ITEM_META_SELECT requests the folder facet (else the folder repair silently no-ops)', /[,=]folder(?:,|$)/.test(String(SP._ITEM_META_SELECT || '')));
ok('ITEM_META_SELECT still requests file + eTag', /[,=]file,/.test(String(SP._ITEM_META_SELECT || '')) && /eTag/.test(String(SP._ITEM_META_SELECT || '')));

console.log(`test-sharepoint-shortpath: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
