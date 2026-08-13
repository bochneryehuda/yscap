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
 * Both are read-only reference data — Encompass stays read-only, forever.
 *
 * THE SOLD SIGNAL NOW DECIDES WHO RELEASES (owner-directed 2026-08-13, superseding the advisory
 * warning of 2026-08-09): *"if Encompass has a PA date already, then it should always proceed with
 * the setting of the file … if it's not yet sold, then it should always be set up that we release
 * the net amount."* Sold is still a three-valued answer — sold / not sold / we cannot tell — and
 * both of the last two put the file on "we release", because an investor who has not bought the
 * loan is neither wiring this borrower nor reimbursing us. See `enforcedMode`.
 *
 * AND THE DRAW DESK CAN STILL SAY OTHERWISE. Encompass's PA date lands on its own schedule, so a
 * loan really can be sold before PILOT can see it: `treat_as_sold` (db/543) records a coordinator's
 * decision to process a file as sold, with who and when, behind a double warning on the screen. It
 * never rewrites the loan — `soldStatus` keeps answering the FACT and `effectiveSold` answers what
 * we process this draw as, so a sale and a decision to proceed as if are never confused.
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
const SOLD_VIA = { TABLE: 'table_funding', ADVICE: 'purchase_advice', OVERRIDE: 'coordinator' };
const SOLD_VIA_LABEL = {
  table_funding: 'Table funded — sold at the closing table',
  purchase_advice: 'Purchase advice received',
  // NOT a claim that the loan is sold — a record that a human decided to proceed as if it were.
  coordinator: 'Processed as sold — set by the draw desk',
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

/** Why we say a loan is sold — 'table_funding' | 'purchase_advice' | 'coordinator' | null. */
function soldVia({ paDate = null, tableFunded = null, channel = null, treatAsSold = false } = {}) {
  if (FC.soldAtTable({ tableFunded, channel })) return SOLD_VIA.TABLE;
  if (paDateOf(paDate)) return SOLD_VIA.ADVICE;
  if (treatAsSold) return SOLD_VIA.OVERRIDE;
  return null;
}

/**
 * WHAT THE DRAW DESK ACTS ON — the sold FACT, or the coordinator's decision to proceed as if.
 *
 * `soldStatus` above answers what Encompass and the closing desk actually know, and it keeps that
 * job unchanged: it is the FACT, and nothing a human clicks may rewrite it. This is the separate,
 * second question — "what do we process this draw as?" — and it is the one the money reads.
 *
 * The override exists because Encompass is read-only and its purchase advice date lands on its own
 * schedule, so a loan really can be sold before PILOT can see it (owner-directed 2026-08-13: *"even
 * if Encompass doesn't have a PA date yet — technically the loan is not sold yet — the draw
 * coordinator should be able to switch a file … imagine if it was sold already. In case anything
 * goes wrong, she should have this ability"*). It only ever moves the answer TOWARDS sold: a file
 * Encompass says IS sold cannot be un-sold by a click, because that is a fact about a loan sale and
 * not a preference.
 */
function effectiveSold({ sold = SOLD.UNKNOWN, treatAsSold = false } = {}) {
  if (sold === SOLD.SOLD) return SOLD.SOLD;
  return treatAsSold ? SOLD.SOLD : (sold || SOLD.UNKNOWN);
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

/** The mode an UNSOLD loan is always processed as: we wire the borrower their net ourselves. */
const NOT_SOLD_MODE = 'reimbursement';

/**
 * THE SOLD SIGNAL NOW DECIDES WHO RELEASES (owner-directed 2026-08-13, superseding the advisory
 * warning of 2026-08-09): *"If Encompass has a PA date already, then it should always proceed with
 * the setting of the file — if the investor releases directly, or if we release and we get
 * reimbursed. If it's not yet sold, then it should always be set up that we release the net
 * amount."*
 *
 * SOLD (or processed as sold) → the file's own setting stands, untouched, whichever way it points.
 * NOT SOLD / CANNOT TELL → we release, always. An investor who has not bought the loan is not
 * wiring this borrower and is not reimbursing us: the money is ours, we wire the net, and our fee
 * simply stays out of the wire. Recording it any other way would put a wire in the ledger against
 * a party that never sent one, and would book a fee receivable nobody owes.
 *
 * `manual` is left alone deliberately — it means the money moved outside PILOT entirely, so PILOT
 * has no business claiming it knows who wired.
 *
 * Returns { mode, forced, configured } — `forced` is true only when this actually changed the
 * answer, so a screen can say WHY the file is on "we release" without guessing.
 */
function enforcedMode({ mode = null, sold = SOLD.UNKNOWN } = {}) {
  const configured = String(mode || '');
  if (sold === SOLD.SOLD) return { mode: configured, forced: false, configured };
  if (configured === 'manual') return { mode: configured, forced: false, configured };
  return { mode: NOT_SOLD_MODE, forced: configured !== NOT_SOLD_MODE, configured };
}

// ---------------------------------------------------------------------------
// The not-sold warning
// ---------------------------------------------------------------------------

const NOT_SOLD_TITLE = 'This file was not sold yet';

/**
 * THE NOT-SOLD BADGE — on every file the sold signal cannot confirm, and null on the rest.
 *
 * It replaces the advisory warning of 2026-08-09, which asked a question and changed nothing. The
 * owner's 2026-08-13 rule answers that question up front — an unsold loan is released by us — so
 * the badge STATES what is happening and offers the coordinator the one thing they may still need:
 * *"every file that is not sold yet should have a badge … but the draw coordinator can click
 * Change Setting and process the draw. Imagine if it was sold already. In case anything goes
 * wrong, she should have this ability, which should give her a double warning."*
 *
 * `certain` separates a proven "no purchase advice date" from "we cannot tell", because those are
 * different things to say to a person. `treated` flips the badge into its second state: the file
 * IS being processed as sold, by a named human, and the way back is offered instead.
 *
 * It still refuses nothing and writes nothing.
 */
function notSoldBadge({ sold = SOLD.UNKNOWN, treatAsSold = false, treatedBy = null, treatedAt = null } = {}) {
  if (sold === SOLD.SOLD) return null;                  // really sold — no badge at all
  if (treatAsSold) {
    return {
      code: 'treated_as_sold',
      title: 'Being processed as sold',
      body: 'Encompass has no purchase advice date on this file yet, but the draw desk set it to be '
        + 'processed as if the loan is already sold. Draws follow the file’s own release setting, and '
        + 'the investor’s draw fee is deducted from ours.'
        + (treatedBy ? ` Set by ${treatedBy}` : '') + (treatedAt ? ` on ${String(treatedAt).slice(0, 10)}.` : (treatedBy ? '.' : '')),
      treated: true,
      certain: sold === SOLD.NOT_SOLD,
      actionLabel: 'Go back to “not sold yet”',
      action: 'clear',
    };
  }
  const certain = sold === SOLD.NOT_SOLD;
  return {
    code: 'not_sold_yet',
    title: NOT_SOLD_TITLE,
    body: (certain
      ? 'There is no purchase advice date on this file, so the loan has not been sold to the investor yet. '
      : 'PILOT cannot tell whether this loan has been sold yet — there is no purchase advice date on file. ')
      + 'Until it is sold, WE release the draw: the borrower is wired the net amount out of our own money, '
      + 'our fee simply stays out of that wire, and the investor charges no draw fee because they are '
      + 'neither releasing nor reimbursing. If you know the loan is already sold, you can process this '
      + 'file as sold.',
    treated: false,
    certain,
    actionLabel: 'Process this file as sold',
    action: 'treat_as_sold',
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
  tableFunded = null, channel = null,
  treatAsSold = false, treatedBy = null, treatedAt = null } = {}) {
  const at = ID.resolveFundingModeAt({ drawMode, fileMode, ruleMode, companyMode });
  // The FACT, then what we PROCESS this draw as (the coordinator's override can only move it
  // towards sold), then the mode that fact enforces. `mode` is the EFFECTIVE answer — the one the
  // ledger, the checklist and the investor email all act on — and `configuredMode` is what the
  // settings ladder holds, so a screen can say "we release, because this loan is not sold yet"
  // without either half having to re-derive the other.
  const sold = soldStatus({ paDate, fieldConfigured, pulled, tableFunded, channel });
  const effective = effectiveSold({ sold, treatAsSold });
  const enforced = enforcedMode({ mode: at.mode, sold: effective });
  const via = soldVia({ paDate, tableFunded, channel, treatAsSold });
  const keep = (v) => (ID.MODES.includes(String(v || '')) ? String(v) : null);
  return {
    mode: enforced.mode,
    level: at.level,
    levelLabel: ID.LEVEL_LABEL[at.level] || ID.LEVEL_LABEL.default,
    modeLabel: ID.MODE_LABEL[enforced.mode] || enforced.mode,
    modeHelp: ID.MODE_HELP[enforced.mode] || '',
    party: ledgerParty(enforced.mode),
    autoLedger: autoLedgers(enforced.mode),
    // What the settings ladder actually holds, and whether the sold rule overrode it. The segmented
    // control on the desk keeps showing the coordinator's own choice (`levels.project`); this says
    // why the file is nonetheless releasing the way it is.
    configuredMode: enforced.configured || null,
    configuredModeLabel: ID.MODE_LABEL[enforced.configured] || null,
    forcedByNotSold: enforced.forced,
    sold,
    // A table-funded loan reads "Table funded — sold at the closing table" rather than the generic
    // "Sold to the investor", so a coordinator can see WHY there is no purchase advice date on a
    // file that is nonetheless completely fine.
    soldLabel: (via && SOLD_VIA_LABEL[via]) || SOLD_LABEL[sold],
    soldVia: via,
    soldViaLabel: via ? SOLD_VIA_LABEL[via] : null,
    tableFunded: FC.soldAtTable({ tableFunded, channel }),
    paDate: paDateOf(paDate),
    // Whether this deployment has the owner's Encompass PA-date field id configured — so a
    // screen can offer a "re-pull the PA date" button only where a re-pull can actually read
    // it. With no field id the read does nothing and the button would be a dead action.
    paConfigured: !!fieldConfigured,
    // WHAT WE PROCESS THIS DRAW AS — the sold fact, or the coordinator's decision to proceed as if.
    // The money (who released, and whether the investor keeps part of our fee) reads THIS, never
    // `sold`, so the ledger and the badge on the screen can never say different things.
    soldEffective: effective,
    treatedAsSold: !!(treatAsSold && sold !== SOLD.SOLD),
    treatedBy: treatAsSold ? (treatedBy || null) : null,
    treatedAt: treatAsSold ? (treatedAt || null) : null,
    // The badge every not-sold file carries, with the coordinator's way past it. `warning` is kept
    // as its old name so the existing screens and the delivery preview keep rendering it.
    badge: notSoldBadge({ sold, treatAsSold, treatedBy, treatedAt }),
    warning: notSoldBadge({ sold, treatAsSold, treatedBy, treatedAt }),
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

  // The project's own release setting, plus the draw desk's "process this file as sold" override
  // (db/543) with WHO set it and WHEN, so the badge is never anonymous. A database that predates
  // the override answers nothing here and the file simply has none — `q` swallows the error.
  let link = (await q(
    `SELECT pl.investor_funding_mode, pl.treat_as_sold_at, pl.treat_as_sold_note,
            su.full_name AS treat_as_sold_by_name
       FROM sitewire_property_links pl
       LEFT JOIN staff_users su ON su.id = pl.treat_as_sold_by
      WHERE pl.application_id=$1 AND pl.matched_by='created'`, [appId]))[0];
  if (!link) {
    link = (await q(
      `SELECT investor_funding_mode FROM sitewire_property_links
        WHERE application_id=$1 AND matched_by='created'`, [appId]))[0] || {};
  }

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
    treatAsSold: !!link.treat_as_sold_at,
    treatedBy: link.treat_as_sold_by_name || null,
    treatedAt: link.treat_as_sold_at || null,
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

/**
 * SET (or clear) "process this file as sold" — the draw desk's override (db/543).
 *
 * It writes ONE thing, on the draw project, and it never touches
 * `applications.purchase_advice_date`: Encompass owns the sold FACT and stays read-only, so this
 * records that a human decided to proceed as if, with their name and the moment attached. Clearing
 * it puts the file straight back on the fact.
 *
 * Returns { ok:false, reason:'no_draw_project' } when the file has no draw project yet — the same
 * shape the release-party route already answers with, rather than silently succeeding.
 */
async function setTreatAsSold(db, appId, { on = true, by = null, note = null } = {}) {
  const r = await db.query(
    `UPDATE sitewire_property_links
        SET treat_as_sold_at   = CASE WHEN $2 THEN COALESCE(treat_as_sold_at, now()) ELSE NULL END,
            treat_as_sold_by   = CASE WHEN $2 THEN COALESCE(treat_as_sold_by, $3::uuid) ELSE NULL END,
            treat_as_sold_note = CASE WHEN $2 THEN $4 ELSE NULL END,
            updated_at = now()
      WHERE application_id=$1 AND matched_by='created'
      RETURNING treat_as_sold_at`, [appId, !!on, by, note ? String(note).slice(0, 500) : null]);
  if (!r.rowCount) return { ok: false, reason: 'no_draw_project' };
  return { ok: true, treatAsSold: !!r.rows[0].treat_as_sold_at };
}

module.exports = {
  SOLD, SOLD_LABEL, SOLD_VIA, SOLD_VIA_LABEL, NOT_SOLD_TITLE, NOT_SOLD_MODE,
  paDateOf, soldStatus, soldVia, effectiveSold, enforcedMode,
  ledgerParty, autoLedgers, notSoldBadge, describe,
  // The badge kept its old export name too, so nothing that already imports it has to change.
  notSoldWarning: notSoldBadge,
  paFieldConfigured, releaseStateFor, syncPurchaseAdviceDate, setTreatAsSold,
};
