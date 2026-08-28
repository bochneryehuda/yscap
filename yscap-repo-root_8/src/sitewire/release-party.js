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
 * THERE ARE THREE WAYS WE KNOW A LOAN IS SOLD, and missing any of them makes this feature a
 * nuisance — a file everyone knows is sold reading as unsold on the draw desk:
 *
 *   TABLE FUNDED — sold AT the closing table. The closer funded it on the "Table Funding"
 *     warehouse line, or Encompass's own funding channel says so. Such a loan is sold the day it
 *     closes and a purchase advice date is NEVER coming, so the absence of one proves nothing.
 *     Checked FIRST, or every Fidelis deal we ever close would warn the coordinator and chase the
 *     closer forever over a date that does not exist. See ../lib/funding-channel.js.
 *   PURCHASE ADVICE, FROM ENCOMPASS — sold later, and the PA date (field 2370) records it.
 *   PURCHASE ADVICE, FROM OUR OWN PURCHASING DESK — `purchasing_advice.advice_date`, written by our
 *     team the day the advice arrives, usually with the advice document filed alongside it
 *     (owner-reported 2026-08-13). It is the same fact recorded a different way, and usually
 *     EARLIER than Encompass, which is re-read on a rota. Leaving it out is what made PILOT
 *     disagree with itself: the 30-day "no purchase advice" chase has always accepted either.
 *
 * All three are read-only reference data — Encompass stays read-only, forever.
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
const SOLD_VIA = {
  TABLE: 'table_funding',
  ADVICE: 'purchase_advice',
  OUR_RECORD: 'our_purchase_advice',
  OVERRIDE: 'coordinator',
};
const SOLD_VIA_LABEL = {
  table_funding: 'Table funded — sold at the closing table',
  purchase_advice: 'Purchase advice received',
  // OUR OWN DESK'S RECORD of the same advice — the purchasing team recorded the date (and usually
  // filed the advice document itself) on the purchasing desk. Just as real as the Encompass field,
  // and usually EARLIER: Encompass is re-read on a rota, our own screen is written the day it lands.
  our_purchase_advice: 'Purchase advice recorded on the purchasing desk',
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
  tableFunded = null, channel = null, ourAdviceDate = null } = {}) {
  // TABLE FUNDED IS SOLD, FULL STOP, AND IT IS CHECKED FIRST (owner-directed 2026-08-09:
  // "anything that is set in Encompass for table funding means that it's right away sold, so you
  // can right away consider it for the investor to release … if that says table funding, then it
  // is not going to have a PA date"). A table-funded loan is sold AT the closing table, so no
  // purchase advice is ever coming and its absence proves nothing. Checked before the PA date
  // precisely so the missing date can never be read as "not sold" on these files — which would
  // warn the coordinator, and chase the closer, on every single Fidelis deal, forever.
  if (FC.soldAtTable({ tableFunded, channel })) return SOLD.SOLD;
  if (paDateOf(paDate)) return SOLD.SOLD;      // a real date is proof, whatever else is missing
  // OUR OWN DESK'S RECORD COUNTS TOO (owner-reported 2026-08-13: a file sold two weeks earlier was
  // still reading as not sold on the draw desk). The purchasing team records the purchase advice —
  // date, and usually the advice document — in `purchasing_advice` the day it arrives, while the
  // Encompass column is filled by a read-only poll that reaches each file on a rota. Reading only
  // Encompass therefore made OUR OWN system disagree with itself: the 30-day "no purchase advice"
  // chase has always treated EITHER source as an advice, and the draw desk did not. It does now.
  if (paDateOf(ourAdviceDate)) return SOLD.SOLD;
  if (!fieldConfigured) return SOLD.UNKNOWN;
  if (!pulled) return SOLD.UNKNOWN;
  return SOLD.NOT_SOLD;
}

/** Why we say a loan is sold — table funding / Encompass / our own desk / the override, or null. */
function soldVia({ paDate = null, tableFunded = null, channel = null, ourAdviceDate = null, treatAsSold = false } = {}) {
  if (FC.soldAtTable({ tableFunded, channel })) return SOLD_VIA.TABLE;
  if (paDateOf(paDate)) return SOLD_VIA.ADVICE;
  if (paDateOf(ourAdviceDate)) return SOLD_VIA.OUR_RECORD;
  if (treatAsSold) return SOLD_VIA.OVERRIDE;
  return null;
}

/** The purchase advice date we actually hold, from either source — Encompass first. */
function adviceDateOf({ paDate = null, ourAdviceDate = null } = {}) {
  return paDateOf(paDate) || paDateOf(ourAdviceDate) || null;
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
  tableFunded = null, channel = null, ourAdviceDate = null,
  treatAsSold = false, treatedBy = null, treatedAt = null } = {}) {
  const at = ID.resolveFundingModeAt({ drawMode, fileMode, ruleMode, companyMode });
  // The FACT, then what we PROCESS this draw as (the coordinator's override can only move it
  // towards sold), then the mode that fact enforces. `mode` is the EFFECTIVE answer — the one the
  // ledger, the checklist and the investor email all act on — and `configuredMode` is what the
  // settings ladder holds, so a screen can say "we release, because this loan is not sold yet"
  // without either half having to re-derive the other.
  const sold = soldStatus({ paDate, fieldConfigured, pulled, tableFunded, channel, ourAdviceDate });
  const effective = effectiveSold({ sold, treatAsSold });
  const enforced = enforcedMode({ mode: at.mode, sold: effective });
  const via = soldVia({ paDate, tableFunded, channel, ourAdviceDate, treatAsSold });
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
    // The date itself, from EITHER source (Encompass first), so a screen never has to ask twice —
    // plus each source on its own, so it can say which one answered.
    paDate: adviceDateOf({ paDate, ourAdviceDate }),
    paDateEncompass: paDateOf(paDate),
    ourAdviceDate: paDateOf(ourAdviceDate),
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
            cw.table_funded, pa.advice_date AS our_advice_date
       FROM applications a
       LEFT JOIN closing_workflow cw ON cw.application_id = a.id
       LEFT JOIN purchasing_advice pa ON pa.application_id = a.id
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
    ourAdviceDate: app.our_advice_date || null,
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
 * WHAT THE LAST READ OF THE PURCHASE ADVICE FIELD ACTUALLY DID (db/608).
 *
 * Owner-reported 2026-08-21: a file with a purchase advice date in Encompass was chased as
 * "no purchase advice 64 days after funding". It had never been ASKED — the per-file Encompass
 * pull is a round-robin over the whole book, so a file waits its turn, and a field read can also
 * come back without the id in it. The column was NULL in every one of those cases and the chase
 * could not tell them apart from "Encompass says there is none".
 *
 *   value        a date came back — the loan is sold
 *   blank        the field was returned and is empty — the ONLY state worth chasing
 *   not_returned the read ran and this id was not in the answer. `client.readFields` splits its
 *                batch on an invalid-field 400 and merges what SUCCEEDED, so an id the tenant
 *                does not permit goes MISSING rather than raising
 *   no_field_id  this deployment has no purchase advice field configured at all
 *   no_loan_link PILOT holds no Encompass loan guid for this file (stamped by the sweep only)
 */
const PA_READ = {
  VALUE: 'value',
  BLANK: 'blank',
  NOT_RETURNED: 'not_returned',
  NO_FIELD_ID: 'no_field_id',
  NO_LOAN_LINK: 'no_loan_link',
};

/**
 * Record what a read of the purchase advice field did, on the file.
 *
 * `purchase_advice_read_at` ALWAYS moves, even when the verdict is unchanged — it is what the
 * back-book sweep drains on, so a state-only guard would make the sweep re-read the same file
 * forever. Never throws: this is bookkeeping riding a best-effort sync.
 */
async function stampPaRead(db, appId, state, fieldId) {
  try {
    await db.query(
      `UPDATE applications
          SET purchase_advice_read_at = now(),
              purchase_advice_read_state = $2,
              purchase_advice_field_id = $3
        WHERE id = $1`,
      [appId, state, fieldId ? String(fieldId) : null]);
  } catch (_) { /* best-effort */ }
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
async function syncPurchaseAdviceDate(db, appId, fieldValues, { silentDiscovery = false, fieldId: readFieldId = null } = {}) {
  try {
    /* THE ID THAT ACTUALLY ANSWERED, when the caller knows it. The sweep now tries the tenant's
       own purchase-advice-named fields after the configured one, so the key present in the answer
       is not always the configured id — reading the map under the wrong key would report
       `not_returned` about a field that answered perfectly well. Callers that do not know (the
       per-file pull, which reads the whole registry batch) fall back to the configured id, which
       is what they asked for. */
    const fieldId = readFieldId || require('../lib/integrations/encompass-field-map').PA_DATE_FIELD_ID;
    if (!fieldId) {
      await stampPaRead(db, appId, PA_READ.NO_FIELD_ID, null);
      return { skipped: 'no_field_id' };
    }
    // THE READ ITSELF FAILED (no `_fieldValues` at all — a fieldReader outage, an auth problem).
    // Deliberately NOT stamped: that is transient, and stamping it would drain the file out of the
    // sweep and let the chase treat one bad minute as an answer about the loan.
    if (!fieldValues || typeof fieldValues !== 'object') return { skipped: 'no_field_read' };
    if (!Object.prototype.hasOwnProperty.call(fieldValues, fieldId)) {
      await stampPaRead(db, appId, PA_READ.NOT_RETURNED, fieldId);
      return { skipped: 'field_not_returned' };
    }
    const paDate = paDateOf(fieldValues[fieldId]);
    // Encompass answered ABOUT THIS LOAN. `blank` is the one state the 30-day chase may fire on.
    await stampPaRead(db, appId, paDate ? PA_READ.VALUE : PA_READ.BLANK, fieldId);
    const r = await db.query(
      `UPDATE applications SET purchase_advice_date=$2, updated_at=now()
        WHERE id=$1 AND purchase_advice_date IS DISTINCT FROM $2::date
        RETURNING id`, [appId, paDate]);
    const changed = !!(r && r.rowCount);
    // ENCOMPASS SAYS THIS LOAN SOLD — TELL THE POST-PURCHASE TEAM (owner-directed 2026-08-13).
    // THIS is the place to do it, and only this place: all three ways the date can arrive (the poll
    // worker, the draw desk's own refresh, the manual button) land here, so the hand-off cannot
    // depend on which of them happened to notice. Once-only and every "stay quiet" case is decided
    // inside `announceSold`, which never throws — a mail problem must never break a sync.
    let cardMoved = null;
    // DISCOVERING A DATE IS NOT THE SAME EVENT AS A DATE ARRIVING, and only the second is news.
    // The back-book sweep asks about files PILOT has never asked about, so on that FIRST read a
    // purchase advice dated in March lands as "changed" — and firing the hand-off would email the
    // purchasing desk "this loan has been sold" about a sale months old, and drag its ClickUp card
    // forward, for every such file at once on the first deploy. That is a back-book blast dressed
    // as a notification. So the sweep asks for a SILENT first read: the date still lands (which is
    // the whole fix — every downstream reader treats it as sold from that moment), and the file is
    // COUNTED as discovered rather than announced, so nothing is hidden. Every LATER read of that
    // same file announces and moves the card exactly as it always did, and the per-file pull is
    // untouched — a date arriving on a file we are already watching is still news.
    const discovered = !!(silentDiscovery && changed && paDate);
    if (changed && paDate && !silentDiscovery) {
      try { await require('../lib/post-purchase').announceSold(appId, paDate); } catch (_) { /* best-effort */ }
    }
    /* THE CLICKUP CARD IS NOT MOVED HERE (owner-directed 2026-08-21, restructured 2026-08-23).
       It used to be: this function pushed `sold` itself AND then called `syncSoldStage`, which
       pushes `sold` too. Two pushes for one sale, from two different conditions — this one fired
       on `changed && paDate && !silentDiscovery`, that one on `marked && announce` — so "when
       does the card move?" had two answers that already disagreed on a CLEARED date and on a
       table-funded file. The second push was a no-op only because `decideStage` refuses to move a
       card that is already there; that is a collision being absorbed, not a design.
       The card now follows the STAGE, in `sold-status.syncSoldStage`, once. That is also the
       correct owner, because the stage is the thing that carries the owner's table-funded
       exclusion — a table-funded loan must not be dragged to `pa issued-post closing.` either. */
    /* AND THE FILE'S OWN SOLD STAGE FOLLOWS (owner-directed 2026-08-21: *"the files that are
       being sold should have a status of 'Sold', and that status should automatically change
       when the PA date is filled"*). It runs on EVERY change, including a silent first read and
       including a CLEARED date — the stage is a description of the file, so it must track the
       evidence in both directions, and only the ANNOUNCEMENT is withheld on a discovery.

       `sold-status` owns the whole rule, table funding included: a table-funded loan was sold at
       the closing table, never receives a purchase advice, and the owner excluded it by name. */
    let soldStage = null;
    if (changed) {
      soldStage = await require('../lib/sold-status')
        .syncSoldStage(db, appId, { announce: !silentDiscovery });
      // What the card did, reported by the one thing that moves it. `cardMoved` keeps its old name
      // and shape so the sweep summary and every existing caller read exactly as before.
      cardMoved = (soldStage && soldStage.cardMoved) || null;
    }
    return { paDate, changed, cardMoved, discovered, soldStage };
  } catch (_) { return { skipped: 'error' }; }
}

// ---------------------------------------------------------------------------
// KEEPING THE SOLD SIGNAL FRESH BY ITSELF — no Refresh button (owner-reported 2026-08-13)
// ---------------------------------------------------------------------------

/**
 * THE PROBLEM THIS SOLVES, in the owner's words: *"it was sold more than two weeks ago. Why did we
 * need to click the Refresh button? This should automatically realize."*
 *
 * ROOT CAUSE. The purchase advice date reaches PILOT two ways, and BOTH were slow for one file:
 *   · our own purchasing desk records it — now read directly (`soldStatus` above), which fixes
 *     every file whose advice our team has already logged;
 *   · Encompass is re-read by `src/sync/encompass-sync.js`, which pulls ONE file every 15 minutes,
 *     round-robin by staleness across every non-declined file with a loan number. A given file's
 *     turn therefore comes around once every (files ÷ ~96) days — days to weeks on a real book.
 *     Nothing re-read a SPECIFIC file on demand except the manual button.
 *
 * SO THE FILE BEING LOOKED AT REFRESHES ITSELF. When the draw desk reads a file that still says
 * "not sold", this re-reads the purchase advice date ALONE — one field by number, not the whole
 * loan — and lands it through the same `syncPurchaseAdviceDate` the full pull uses. That is the
 * cheapest possible Encompass call, and it happens exactly where the answer is about to matter.
 *
 * EVERY GUARD IS DELIBERATE:
 *   · it runs ONLY when the file is not already sold — a sold file has nothing to look up;
 *   · it needs a CACHED loan GUID, so it never triggers a pipeline search (the expensive path the
 *     round-robin owns);
 *   · it is THROTTLED per file (`sold_check_at`, db/544 — default 30 minutes), so a desk left open
 *     on a genuinely unsold file cannot hammer the API;
 *   · it has its own TIMEOUT, so a slow Encompass can never hold up a screen;
 *   · it is READ-ONLY into our own column, like every other Encompass read in this codebase;
 *   · and it NEVER throws — a failure just leaves the answer where it was, and the manual Refresh
 *     button still exists for "check right now".
 *
 * Returns { checked:false, reason } when it declined, or { checked:true, paDate, changed }.
 */
const SOLD_RECHECK_MINUTES = Math.max(1, Number(process.env.DRAW_SOLD_RECHECK_MINUTES) || 30);

async function refreshSoldSignal(db, appId, { sold = null, timeoutMs = 2500, force = false, client = null } = {}) {
  try {
    if (!appId) return { checked: false, reason: 'no_file' };
    if (sold === SOLD.SOLD) return { checked: false, reason: 'already_sold' };
    const fieldId = paFieldConfigured() && require('../lib/integrations/encompass-field-map').PA_DATE_FIELD_ID;
    if (!fieldId) return { checked: false, reason: 'no_field_id' };
    // The Encompass client is INJECTABLE for the same reason `db` is: the whole path — the throttle,
    // the one-field read, the landing — is then provable against a stub, with no network and no
    // credentials. Production passes nothing and gets the real read-only client.
    const api = client || require('../encompass/client');
    if (!api.configured()) return { checked: false, reason: 'encompass_not_configured' };

    // The throttle and the GUID in one read. `sold_check_at` lives on the draw project, so a file
    // with no draw project is not a draw file and is left to the ordinary poll.
    const row = (await db.query(
      `SELECT a.encompass_loan_guid AS guid, pl.sold_check_at
         FROM sitewire_property_links pl JOIN applications a ON a.id = pl.application_id
        WHERE pl.application_id=$1 AND pl.matched_by='created'`, [appId])).rows[0];
    if (!row) return { checked: false, reason: 'no_draw_project' };
    if (!row.guid) return { checked: false, reason: 'no_loan_guid' };
    if (!force && row.sold_check_at
        && (Date.now() - new Date(row.sold_check_at).getTime()) < SOLD_RECHECK_MINUTES * 60000) {
      return { checked: false, reason: 'checked_recently' };
    }
    // Stamp BEFORE the call, not after: a slow or failing Encompass must not let every page load
    // start another read.
    await db.query(`UPDATE sitewire_property_links SET sold_check_at=now() WHERE application_id=$1 AND matched_by='created'`, [appId]);

    const vals = await Promise.race([
      api.readFields(row.guid, [String(fieldId)]),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), Math.max(500, timeoutMs))),
    ]);
    const out = await syncPurchaseAdviceDate(db, appId, vals);
    return { checked: true, paDate: out && out.paDate, changed: !!(out && out.changed) };
  } catch (e) {
    return { checked: false, reason: (e && e.message) ? String(e.message).slice(0, 120) : 'error' };
  }
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

// ---------------------------------------------------------------------------
// REFRESHING THE WHOLE BOOK'S PURCHASE ADVICE FIELD — the owner's "refresh your entire system"
// ---------------------------------------------------------------------------

/**
 * Owner-directed 2026-08-21, on the false chase: *"If you're refreshing yourself and something is
 * wrong, you need to refresh your entire system and make sure it's looking at the correct field."*
 *
 * WHAT IT DOES. Takes funded files that have been asked about LEAST RECENTLY (never-asked first),
 * re-reads THE PURCHASE ADVICE FIELD ALONE — one field by number, never the whole loan and never a
 * pipeline search — and lands the answer through `syncPurchaseAdviceDate`, which is what records
 * `purchase_advice_read_state`. So after a few passes every funded file carries a stated verdict
 * and the 30-day chase can fire on `blank` alone instead of on the absence of a column nobody ever
 * filled in.
 *
 * WHY IT IS SEPARATE FROM THE POLL. `src/sync/encompass-sync.js` pulls the WHOLE loan for one file
 * every 15 minutes — the right shape for keeping the mirror fresh, far too slow to answer one
 * question about the funded book (a given file's turn comes around once every (files ÷ ~96) days).
 * This asks the one question, so it can move through the book orders of magnitude faster at a
 * fraction of the cost.
 *
 * EVERY GUARD IS DELIBERATE, and each one is the same guard `refreshSoldSignal` already carries:
 *   · FUNDED files only — a purchase advice belongs to a loan that closed; asking about a file in
 *     underwriting would burn the budget on a question with no answer;
 *   · a CACHED loan guid only. A file PILOT has never linked to Encompass is stamped `no_loan_link`
 *     and drains out of the queue, because "we hold no loan to ask about" is a real answer and a
 *     different piece of work from "Encompass says none";
 *   · ONE field id per call, and the calls are PACED (`gapMs`) so a sweep can never look like a
 *     burst to Encompass or crowd out the ordinary poll;
 *   · BOUNDED per pass (`limit`), draining on `purchase_advice_read_at NULLS FIRST` (the db/608
 *     partial index), so a partial pass always resumes exactly where it stopped;
 *   · the READ FAILING is deliberately NOT stamped (`syncPurchaseAdviceDate` returns
 *     `no_field_read` and writes nothing), so one bad minute never drains a real file out of the
 *     sweep carrying a verdict nobody read;
 *   · NEVER throws, and the client is INJECTABLE exactly like `db` — the whole path is provable
 *     against a stub with no network and no credentials.
 *
 * Returns a summary of what it did — never a bare count, because a sweep that reports only "50
 * files" cannot tell a working pass from one that stamped fifty `no_loan_link`s.
 */
const PA_SWEEP_LIMIT = Math.max(1, Number(process.env.PA_SWEEP_FILES) || 25);
const PA_SWEEP_GAP_MS = Math.max(0, Number(process.env.PA_SWEEP_GAP_MS) || 400);

async function sweepPurchaseAdviceOnce(db, { limit = PA_SWEEP_LIMIT, gapMs = PA_SWEEP_GAP_MS, client = null } = {}) {
  const out = {
    looked: 0, value: 0, blank: 0, notReturned: 0, noLoanLink: 0, readFailed: 0, discovered: 0,
    fieldId: null, skipped: null,
  };
  try {
    const fieldId = paFieldConfigured() && require('../lib/integrations/encompass-field-map').PA_DATE_FIELD_ID;
    if (!fieldId) { out.skipped = 'no_field_id'; return out; }
    out.fieldId = String(fieldId);
    const api = client || require('../encompass/client');
    if (!api.configured()) { out.skipped = 'encompass_not_configured'; return out; }

    const rows = (await db.query(
      `SELECT a.id, a.encompass_loan_guid AS guid, a.ys_loan_number,
              (a.purchase_advice_read_at IS NULL) AS first_read
         FROM applications a
        WHERE a.deleted_at IS NULL
          AND a.status = 'funded'
        ORDER BY a.purchase_advice_read_at NULLS FIRST
        LIMIT $1`, [Math.max(1, Math.min(500, Number(limit) || PA_SWEEP_LIMIT))])).rows;

    /* WHICH IDS TO ASK ABOUT — the configured one first, then whatever THIS TENANT'S OWN field
       catalogue calls a purchase advice (owner-directed 2026-08-21: *"I want you to fix the bug so
       that you should be able to reach and read the field. The field is there."*). Resolved once
       per pass, not per file: the catalogue does not change mid-sweep. */
    const paField = require('./pa-field');
    const candidates = await paField.paFieldCandidates(db, fieldId);
    out.candidates = candidates.length;

    for (const r of rows) {
      out.looked += 1;
      /* NO LOAN TO ASK ABOUT — so FIND IT. The sweep used to stamp `no_loan_link` and move on,
         which meant a funded file that had never been through the per-file pull could sit
         permanently unreadable while its purchase advice sat in Encompass. One pipeline search by
         loan number caches the GUID, and every read after this one is the cheap by-number path. */
      let guid = r.guid;
      if (!guid) {
        guid = await paField.ensureLoanGuid(db, r.id, { api, loanNumber: r.ys_loan_number, existingGuid: null });
        if (guid) out.linked = (out.linked || 0) + 1;
      }
      if (!guid) { await stampPaRead(db, r.id, PA_READ.NO_LOAN_LINK, fieldId); out.noLoanLink += 1; continue; }
      const read = await paField.readPaField(api, guid, candidates);
      const vals = read.values;
      /* WHICH FIELD ANSWERED is recorded on the file, not assumed — a verdict that came from a
         fallback id must be traceable to it. */
      if (read.fieldId && read.fieldId !== String(fieldId)) out.viaFallback = (out.viaFallback || 0) + 1;
      // A FILE THIS SWEEP HAS NEVER ASKED ABOUT LANDS ITS DATE SILENTLY (see the note in
      // `syncPurchaseAdviceDate`): PILOT cannot tell a sale that happened this morning from one
      // that happened in March, and announcing the whole back book at once is not a notification,
      // it is a blast. Discoveries are counted and logged instead.
      const res = await syncPurchaseAdviceDate(db, r.id, vals, {
        silentDiscovery: !!r.first_read,
        fieldId: read.fieldId || fieldId,
      });
      if (res && res.discovered) out.discovered += 1;
      if (res && res.skipped === 'no_field_read') out.readFailed += 1;
      else if (res && res.skipped === 'field_not_returned') out.notReturned += 1;
      else if (res && res.paDate) out.value += 1;
      else out.blank += 1;
      if (gapMs) await new Promise((res2) => setTimeout(res2, gapMs));
    }
    return out;
  } catch (e) {
    out.skipped = (e && e.message) ? String(e.message).slice(0, 120) : 'error';
    return out;
  }
}


module.exports = {
  SOLD, SOLD_LABEL, SOLD_VIA, SOLD_VIA_LABEL, NOT_SOLD_TITLE, NOT_SOLD_MODE,
  paDateOf, adviceDateOf, soldStatus, soldVia, effectiveSold, enforcedMode,
  ledgerParty, autoLedgers, notSoldBadge, describe,
  // The badge kept its old export name too, so nothing that already imports it has to change.
  notSoldWarning: notSoldBadge,
  paFieldConfigured, releaseStateFor, syncPurchaseAdviceDate, setTreatAsSold,
  PA_READ, stampPaRead, sweepPurchaseAdviceOnce,
  refreshSoldSignal, SOLD_RECHECK_MINUTES,
};
