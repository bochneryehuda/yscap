'use strict';
/**
 * WHO RELEASES THE MONEY — and has this loan actually been sold yet?
 * (owner-directed 2026-08-09: "we should have a setting where we should be able to set every
 * property, also whether this property, by default, is released by the investor or released by
 * us. We should also have settings where we should be able to set that by capital provider …
 * Also, before we sell, you should be able to mark, 'Hey, this is not sold yet, so it's released
 * by us. Now it's sold, so it's released by them.'")
 *
 * NO SECOND CONCEPT IS INVENTED. `funding_mode` already answers "who releases this draw's money"
 * per draw and per file, and already defaults to the investor. What was missing is (a) the
 * CAPITAL-PROVIDER level, (b) a way for a screen to say WHERE the answer came from, and (c) the
 * sold signal. The pick itself still belongs to ./investor-delivery `resolveFundingModeAt`, so
 * "which mode?" has exactly one definition in this codebase and this module can never disagree
 * with the email that goes to the investor.
 *
 * THERE ARE TWO WAYS A LOAN IS SOLD, and missing the first is what would make this feature a
 * nuisance (owner-directed 2026-08-09):
 *
 *   TABLE FUNDED — sold AT the closing table. The closer funded it on the "Table Funding"
 *     warehouse line, or Encompass's own funding channel says so. Such a loan is sold the day it
 *     closes and a purchase advice date is NEVER coming, so the absence of one proves nothing.
 *     Checked FIRST, or every Fidelis deal we ever close would warn the coordinator and chase the
 *     closer forever over a date that does not exist. See ../lib/funding-channel.js.
 *   PURCHASE ADVICE — sold later, to the investor, and the PA date from Encompass records it.
 *
 * Both are read-only reference data — Encompass stays read-only, forever — and NEITHER flips the
 * release party by itself. All they do is raise a WARNING when the money is set to come from an
 * investor who may not own the loan yet.
 *
 * THE DEFAULT IS TO CARRY ON (owner-directed 2026-08-09: "default should be like it was sold
 * already, but it should give you a warning that it doesn't have a PA date if you're sure you want
 * to do investor delivery"). Sold is still a three-valued answer — sold / not sold / we cannot
 * tell — and both of the last two show the warning, because the only state that should silence it
 * is an affirmative "yes, it was sold". But the warning refuses nothing and writes nothing: it
 * offers going ahead first and releasing it ourselves second.
 *
 * The decision half is PURE (no DB, no network). The reader at the bottom takes its `db` as an
 * argument, so the whole file unit-tests against a stub.
 */

const ID = require('./investor-delivery');   // pure: MODES / resolveFundingModeAt / labels
// TABLE FUNDING — whether this loan was sold at the closing table, in which case no purchase
// advice date is ever coming. Pure (its only require is the Encompass value map).
const FC = require('../lib/funding-channel');

// ---------------------------------------------------------------------------
// The sold signal
// ---------------------------------------------------------------------------

const SOLD = { SOLD: 'sold', NOT_SOLD: 'not_sold', UNKNOWN: 'unknown' };

const SOLD_LABEL = {
  sold: 'Sold to the investor',
  not_sold: 'No purchase advice date yet',
  unknown: 'No purchase advice date yet',
};

/** How we know a loan was sold — so a screen can say WHY, not just that it was. */
const SOLD_VIA = { TABLE: 'table_funding', ADVICE: 'purchase_advice' };
const SOLD_VIA_LABEL = {
  table_funding: 'Table funded — sold at the closing table',
  purchase_advice: 'Purchase advice received',
};

/**
 * A stored PA date, as a plain 'YYYY-MM-DD' calendar string, or null.
 *
 * Calendar strings ONLY, like every other date in this repo — never a JS Date, which would drag a
 * timezone into a value that has none and could report the wrong day. A pg `date` column already
 * comes back as a string (src/db.js parses OID 1082 that way); a Date instance is accepted anyway
 * because the Encompass field reader hands back whatever the tenant stored.
 */
function paDateOf(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date) {
    if (!Number.isFinite(v.getTime())) return null;
    return v.toISOString().slice(0, 10);
  }
  const s = String(v).trim();
  // An ISO timestamp, an ISO date, or a US-style m/d/yyyy — the three shapes Encompass returns.
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) {
    const y = Number(m[1]);
    if (y < 1900 || y > 2100) return null;              // the repo's date sanity window
    return `${m[1]}-${m[2]}-${m[3]}`;
  }
  m = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})/.exec(s);
  if (m) {
    const y = Number(m[3]), mo = Number(m[1]), d = Number(m[2]);
    if (y < 1900 || y > 2100 || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    return `${m[3]}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }
  return null;
}

/**
 * Has this loan been sold?
 *
 *   paDate         the file's stored Purchase Advice date (or null)
 *   fieldConfigured  whether PILOT can actually read the PA date at all — i.e. the owner's
 *                  Encompass field id has been supplied. Without it a blank column proves
 *                  nothing, so the answer is 'unknown', not 'not_sold'.
 *   pulled         whether this file has ever been pulled from Encompass. A file we have never
 *                  read is likewise 'unknown' rather than a confident "not sold".
 *
 * Never throws. Anything it cannot read is 'unknown', which shows the warning.
 */
function soldStatus({ paDate = null, fieldConfigured = false, pulled = true,
  tableFunded = null, channel = null } = {}) {
  // TABLE FUNDED IS SOLD, FULL STOP, AND IT IS CHECKED FIRST (owner-directed 2026-08-09:
  // "anything that is set in Encompass for table funding means that it's right away sold, so you
  // can right away consider it for the investor to release … if that says table funding, then it
  // is not going to have a PA date"). A table-funded loan is sold AT the closing table, so no
  // purchase advice is ever coming and its absence proves nothing. Checked before the PA date
  // precisely so the missing date can never be read as "not sold" on these files — which would
  // warn the coordinator, and chase the closer, on every single Fidelis deal, forever.
  if (FC.soldAtTable({ tableFunded, channel })) return SOLD.SOLD;
  if (paDateOf(paDate)) return SOLD.SOLD;      // a real date is proof, whatever else is missing
  if (!fieldConfigured) return SOLD.UNKNOWN;
  if (!pulled) return SOLD.UNKNOWN;
  return SOLD.NOT_SOLD;
}

/** Why we say a loan is sold — 'table_funding' | 'purchase_advice' | null (we do not say it is). */
function soldVia({ paDate = null, tableFunded = null, channel = null } = {}) {
  if (FC.soldAtTable({ tableFunded, channel })) return SOLD_VIA.TABLE;
  if (paDateOf(paDate)) return SOLD_VIA.ADVICE;
  return null;
}

// ---------------------------------------------------------------------------
// Who actually sends the money
// ---------------------------------------------------------------------------

/**
 * Which side wires the borrower on this mode — the value the money ledger records as
 * `release_party`, or null when this mode does not answer the question.
 *
 *   investor_direct → 'investor'   the investor wires the borrower and sends us our fee
 *   reimbursement   → 'us'         we wire the borrower and the investor reimburses us
 *   manual          → null         handled outside PILOT; nobody told us who wired, so PILOT
 *                                  records nothing on its own and the coordinator's typed-in
 *                                  release stays the record. Null is the SAFE answer here: it
 *                                  keeps the automatic ledger writer out of a draw whose money
 *                                  movement PILOT genuinely did not witness.
 */
function ledgerParty(mode) {
  const m = String(mode || '');
  if (m === 'investor_direct') return 'investor';
  if (m === 'reimbursement') return 'us';
  return null;
}

/** Does PILOT write the money ledger row itself for this mode? Only when the investor released. */
function autoLedgers(mode) { return ledgerParty(mode) === 'investor'; }

// ---------------------------------------------------------------------------
// The not-sold warning
// ---------------------------------------------------------------------------

const NOT_SOLD_TITLE = 'No purchase advice date on this file';

/**
 * The warning, or null when there is nothing to warn about.
 *
 * IT IS A CHECK, NOT A STOP, AND THE DEFAULT IS TO CARRY ON (owner-directed 2026-08-09: "default
 * should be like it was sold already, but it should give you a warning that it doesn't have a PA
 * date if you're sure you want to do investor delivery"). Nothing here changes a stored value,
 * nothing refuses the delivery, and the wording leads with the FACT (no purchase advice date)
 * rather than the old conclusion ("this loan isn't sold yet") — which was too strong now that a
 * table-funded loan is correctly read as sold without one, and which read as an accusation on a
 * file that was merely waiting on paperwork.
 *
 * It fires only when BOTH halves are true: the money is set to come from the investor, AND we
 * cannot confirm the investor owns this loan. Switching to "We release" stays offered as the
 * SECOND option rather than the recommendation.
 */
function notSoldWarning({ mode = null, sold = SOLD.UNKNOWN } = {}) {
  if (ledgerParty(mode) !== 'investor') return null;          // we release, or manual — not our question
  if (sold === SOLD.SOLD) return null;
  const certain = sold === SOLD.NOT_SOLD;
  return {
    code: 'not_sold_yet',
    title: NOT_SOLD_TITLE,
    body: (certain
      ? 'This file has no purchase advice date, so PILOT cannot confirm the loan has been sold to the investor yet. '
      : 'PILOT cannot tell whether this loan has been sold yet — there is no purchase advice date on file. ')
      + 'You can go ahead with the investor delivery if you know it is sold. If it is not, you can release the money yourself instead.',
    suggestMode: 'reimbursement',
    suggestLabel: 'Switch to “We release”',
    certain,
  };
}

// ---------------------------------------------------------------------------
// The whole answer for one file (and optionally one draw), assembled
// ---------------------------------------------------------------------------

/**
 * `release` describes who releases the money and why, `sold` describes the loan.
 * Shape (everything a screen needs, nothing it has to work out for itself):
 *
 *   { mode, level, levelLabel, modeLabel, modeHelp, party, autoLedger,
 *     sold, soldLabel, soldVia, soldViaLabel, tableFunded, paDate, warning,
 *     levels: { draw, project, capital_provider, company } }   ← what each level actually holds
 */
function describe({ drawMode = null, fileMode = null, ruleMode = null, companyMode = null,
  paDate = null, fieldConfigured = false, pulled = true,
  tableFunded = null, channel = null } = {}) {
  const at = ID.resolveFundingModeAt({ drawMode, fileMode, ruleMode, companyMode });
  const sold = soldStatus({ paDate, fieldConfigured, pulled, tableFunded, channel });
  const via = soldVia({ paDate, tableFunded, channel });
  const keep = (v) => (ID.MODES.includes(String(v || '')) ? String(v) : null);
  return {
    mode: at.mode,
    level: at.level,
    levelLabel: ID.LEVEL_LABEL[at.level] || ID.LEVEL_LABEL.default,
    modeLabel: ID.MODE_LABEL[at.mode] || at.mode,
    modeHelp: ID.MODE_HELP[at.mode] || '',
    party: ledgerParty(at.mode),
    autoLedger: autoLedgers(at.mode),
    sold,
    // A table-funded loan reads "Table funded — sold at the closing table" rather than the generic
    // "Sold to the investor", so a coordinator can see WHY there is no purchase advice date on a
    // file that is nonetheless completely fine.
    soldLabel: (via && SOLD_VIA_LABEL[via]) || SOLD_LABEL[sold],
    soldVia: via,
    soldViaLabel: via ? SOLD_VIA_LABEL[via] : null,
    tableFunded: FC.soldAtTable({ tableFunded, channel }),
    paDate: paDateOf(paDate),
    warning: notSoldWarning({ mode: at.mode, sold }),
    // The levels are reported RAW (an unrecognised stored value reads as null, exactly as the
    // resolver treats it) so the settings screen can show what each level holds without having
    // to re-implement the fall-through.
    levels: {
      draw: keep(drawMode), project: keep(fileMode),
      capital_provider: keep(ruleMode), company: keep(companyMode),
    },
  };
}

// ---------------------------------------------------------------------------
// The IO half — read the four levels for a file. Never throws.
// ---------------------------------------------------------------------------

/** Is the PA date readable at all on this deployment? (The owner's Encompass field id.) */
function paFieldConfigured() {
  try { return !!require('../lib/integrations/encompass-field-map').PA_DATE_FIELD_ID; }
  catch (_) { return false; }
}

/**
 * Read every level for one file — and, when `sitewireDrawId` is given, that draw's own choice.
 *
 * The capital-provider level rides the SAME rule row the inspection method and the draw fee
 * already resolve from (`orchestrator.resolveRule`), so a coordinator never has to learn a second
 * place where a note buyer's defaults live. Every read is independently guarded: a level PILOT
 * cannot read simply does not answer, and the resolution falls through to the next one — which is
 * the same thing an unset level does, so a database hiccup can never redirect a wire.
 */
async function releaseStateFor(db, appId, { sitewireDrawId = null } = {}) {
  const q = async (sql, params) => {
    try { const r = await db.query(sql, params); return (r && r.rows) || []; } catch (_) { return []; }
  };

  // `encompass_extra` carries the funding channel Encompass holds; `table_funded` is the closer's
  // own answer, derived from the warehouse line they funded on. EITHER means sold at the table —
  // see FC.soldAtTable for why either alone is enough.
  const app = (await q(
    `SELECT a.purchase_advice_date, a.encompass_last_pulled_at, a.lender, a.encompass_extra,
            cw.table_funded
       FROM applications a
       LEFT JOIN closing_workflow cw ON cw.application_id = a.id
      WHERE a.id=$1`, [appId]))[0] || {};

  const link = (await q(
    `SELECT investor_funding_mode FROM sitewire_property_links
      WHERE application_id=$1 AND matched_by='created'`, [appId]))[0] || {};

  let drawMode = null;
  if (sitewireDrawId != null && /^\d+$/.test(String(sitewireDrawId))) {
    const f = (await q(
      `SELECT funding_mode FROM draw_findings
        WHERE application_id=$1 AND sitewire_draw_id=$2
        ORDER BY id DESC LIMIT 1`, [appId, String(sitewireDrawId)]))[0] || {};
    drawMode = f.funding_mode || null;
  }

  // The capital-provider level, read off the SAME rule row this file's inspection method and draw
  // fee already resolve from (`routing.resolveFilePlatform` → `orchestrator.resolveRule`, which
  // matches by note-buyer label then capital-partner id, most specific program first). Reusing it
  // rather than re-resolving means a coordinator never has to learn a second place where a note
  // buyer's defaults live, and this can never pick a different rule row than the fee did. When it
  // cannot be read the level simply does not answer and the resolution falls through — the same
  // thing an unset level does, so a database hiccup can never redirect a wire.
  let ruleMode = null;
  try {
    const rp = await require('./routing').resolveFilePlatform(appId);
    ruleMode = (rp && rp.rule && rp.rule.investor_funding_mode) || null;
  } catch (_) { /* unreadable level: no answer, fall through */ }

  const companyMode = (await q(
    `SELECT value FROM sitewire_settings WHERE key='investor_funding_mode_default'`))
    .map((r) => (typeof r.value === 'string' ? r.value : (r.value && String(r.value))))[0] || null;

  // The Encompass channel, read out of the stored pull through the SAME extractor the panel uses,
  // so this and the Encompass screen can never read one stored value two different ways. Guarded:
  // a file never pulled, or a stored copy this cannot parse, simply has no channel and the closer's
  // own table_funded flag answers on its own.
  let channel = null;
  try {
    const fm = require('../lib/integrations/encompass-field-map');
    const t = app.encompass_extra ? fm.extractFields(app.encompass_extra) : null;
    channel = (t && FC.channelKey(t.funding_channel)) || null;
  } catch (_) { channel = null; }

  const state = describe({
    drawMode, fileMode: link.investor_funding_mode || null, ruleMode, companyMode,
    paDate: app.purchase_advice_date || null,
    fieldConfigured: paFieldConfigured(),
    pulled: !!app.encompass_last_pulled_at,
    tableFunded: app.table_funded === true ? true : (app.table_funded === false ? false : null),
    channel,
  });
  // STAFF-ONLY: the note buyer's name rides along so the desk can say "Fidelis releases the
  // money" instead of the anonymous "the investor". Every consumer of this is behind
  // `manage_draws` — it must never reach a borrower surface (the frozen borrower-safe rule).
  return { ...state, noteBuyer: app.lender || null };
}

/**
 * Materialize the PA date onto the file, from an Encompass field-by-number read.
 *
 * Called from the per-file Encompass pull with the `_fieldValues` map it just read. Encompass is
 * the ONLY source of this value and stays READ-ONLY — this writes into OUR column, which is the
 * sanctioned direction and the same thing the borrower-profile enrichment does.
 *
 * A KEY THAT IS ABSENT AND A KEY THAT IS BLANK ARE DIFFERENT ANSWERS, and conflating them would
 * silently un-sell a sold loan: `client.readFields` splits its id list on an invalid-field 400 and
 * merges what succeeded, so a field it could not read is MISSING from the map, while a field it
 * read and found empty is PRESENT and empty. So a missing key writes nothing at all; a present
 * one writes what it says, including clearing the column when the purchase advice is genuinely
 * gone. The UPDATE is `IS DISTINCT FROM`-guarded so an echoing pull touches no row.
 *
 * Never throws — this rides a best-effort sync and must never break a pull.
 * Returns { skipped } or { paDate, changed }.
 */
async function syncPurchaseAdviceDate(db, appId, fieldValues) {
  try {
    const fieldId = require('../lib/integrations/encompass-field-map').PA_DATE_FIELD_ID;
    if (!fieldId) return { skipped: 'no_field_id' };
    if (!fieldValues || typeof fieldValues !== 'object') return { skipped: 'no_field_read' };
    if (!Object.prototype.hasOwnProperty.call(fieldValues, fieldId)) return { skipped: 'field_not_returned' };
    const paDate = paDateOf(fieldValues[fieldId]);
    const r = await db.query(
      `UPDATE applications SET purchase_advice_date=$2, updated_at=now()
        WHERE id=$1 AND purchase_advice_date IS DISTINCT FROM $2::date
        RETURNING id`, [appId, paDate]);
    return { paDate, changed: !!(r && r.rowCount) };
  } catch (_) { return { skipped: 'error' }; }
}

module.exports = {
  SOLD, SOLD_LABEL, SOLD_VIA, SOLD_VIA_LABEL, NOT_SOLD_TITLE,
  paDateOf, soldStatus, soldVia, ledgerParty, autoLedgers, notSoldWarning, describe,
  paFieldConfigured, releaseStateFor, syncPurchaseAdviceDate,
};
