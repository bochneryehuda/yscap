'use strict';

/**
 * desk-sync — forwards the investor-guideline OVERLAY's "not happy" items into the
 * real staff finding surface (ai_suggestions), so a note-buyer coverage gap or a
 * guideline conflict actually SURFACES (a fatal notifies the LO/processor via the
 * ai-suggestions fatal-notify path) instead of only appearing inside the Investor
 * Guidelines panel when a human happens to open it.
 *
 * OVERLAY SEMANTICS (owner-directed 2026-07-23): the desk stays quiet unless the
 * note buyer would NOT be happy with the file as-is. This forwards ONLY those
 * unhappy items:
 *   - coverage_gap — the note buyer REQUIRES a condition that is not on the file
 *     at all. FATAL for a construction feasibility report on a ground-up / heavy
 *     rehab file (the owner's "pop up something big"); a warning otherwise.
 *   - conflict — a value on the file is outside the note buyer's guideline.
 *   - concern — a disposition:'concern' guideline (e.g. a non-arms-length
 *     transaction) that is NEVER raised proactively and surfaces ONLY when a real
 *     concern signal fired (a party-collusion / assignment-fraud detector). A
 *     warning finding for a human to verify — there is no document to post.
 * An OPEN condition (the document just hasn't arrived) is FINE and is never raised.
 *
 * ADVISORY ONLY — records ai_suggestions, never blocks, never posts/clears a
 * condition, and touches no frozen number. Best-effort; every entry point is
 * guarded and NEVER throws.
 */

const aiSug = require('../ai-suggestions');

const SOURCE = 'investor_guideline_desk';

/**
 * deskToSuggestions(desk) → Array<ai-suggestions.record payload> (PURE, never throws).
 * Maps a desk result's `unhappy[]` into suggestion payloads. Returns [] for a happy,
 * empty, or malformed desk. Does NOT include applicationId — the DB layer adds it.
 */
function deskToSuggestions(desk) {
  try {
    if (!desk || !Array.isArray(desk.unhappy) || !desk.unhappy.length) return [];
    const nb = (desk.noteBuyer && desk.noteBuyer.name) || 'the note buyer';
    const out = [];
    for (const u of desk.unhappy) {
      if (!u || u.cond_no == null) continue;
      const code = u.pilot_template_code || null;
      const sev = u.severity === 'fatal' ? 'fatal' : 'warning';
      if (u.flag === 'coverage_gap') {
        // The guideline→PILOT crosswalk is many-to-one, so the desk COLLAPSES all the
        // note-buyer requirements that map to ONE missing PILOT condition into a single
        // gap (carrying gapKey + coveredConditions[] + coveredCount). Key the suggestion
        // on that collapsed code — NOT on cond_no — so one absent condition raises ONE
        // "post this" row listing every requirement it satisfies, never N duplicates.
        const covered = Array.isArray(u.coveredConditions) && u.coveredConditions.length
          ? u.coveredConditions
          : [u.name].filter(Boolean);
        const count = u.coveredCount || covered.length || 1;
        // Mirror desk.js's key derivation EXACTLY (trim+lowercase FIRST, then fall back) so a
        // raw item with a whitespace-only pilot code keys identically on both sides.
        const normCode = String(u.pilot_template_code || '').trim().toLowerCase();
        const gapKey = u.gapKey || normCode || `cond:${u.cond_no}`;
        const many = count > 1;
        const reqList = covered.join(', ');
        out.push({
          source: SOURCE, kind: 'condition', severity: sev, important: sev === 'fatal',
          title: many
            ? `${nb} needs ${count} requirements — no condition on the file covers them`
            : `${nb} requires "${u.name}" — no condition on the file`,
          body: (many
            ? `${nb}'s own guidelines require ${count} things that all belong on one condition (${reqList}), but there is no condition on the file covering it.`
            : `${nb}'s own guidelines require this, but there is no condition on the file covering it.`)
            + (sev === 'fatal' ? ' Post one now — the note buyer will not take the file without it.' : '')
            + (u.required_evidence ? ` Needs: ${u.required_evidence}` : ''),
          evidence: { code, domain: u.domain || null, cond_no: u.cond_no, noteBuyer: nb, flag: 'coverage_gap', coveredConditions: covered, coveredCount: count },
          proposedAction: { type: 'attach_condition', fields: { code, cond_no: u.cond_no } },
          dedupeKey: `isg-gap:${gapKey}`,
        });
      } else if (u.flag === 'conflict') {
        const conflicts = Array.isArray(u.checks)
          ? u.checks.filter((k) => k && k.status === 'conflict').map((k) => k.detail || k.text).filter(Boolean)
          : [];
        out.push({
          source: SOURCE, kind: 'finding', severity: 'fatal', important: true,
          title: `"${u.name}" conflicts with ${nb}'s guideline`,
          body: u.reason || `A value on this file is outside ${nb}'s guideline for ${u.name}.`,
          evidence: { code, domain: u.domain || null, cond_no: u.cond_no, noteBuyer: nb, flag: 'conflict', conflicts },
          proposedAction: { type: 'review_guideline_conflict', fields: { code, cond_no: u.cond_no } },
          dedupeKey: `isg-conflict:${u.cond_no}`,
        });
      } else if (u.flag === 'concern') {
        // A disposition:'concern' item (e.g. a non-arms-length transaction) is NEVER raised
        // proactively — the desk surfaced it ONLY because a real concern signal is present
        // (a party-collusion / assignment-fraud detector fired). Forward it as an advisory
        // warning finding for a human to verify — there is no condition to "post" (concern
        // conditions clear by internal verification, not a document), so this is a finding,
        // never a coverage_gap.
        out.push({
          source: SOURCE, kind: 'finding', severity: sev, important: sev === 'fatal',
          title: `Possible ${(u.name || 'guideline').toLowerCase()} concern — ${nb} needs it verified`,
          body: (u.reason || `PILOT sees a possible concern on this file that ${nb} would want checked before taking the loan.`)
            + (u.required_evidence ? ` What to confirm: ${u.required_evidence}` : ''),
          evidence: { code, domain: u.domain || null, cond_no: u.cond_no, noteBuyer: nb, flag: 'concern', concern_field: u.concern_field || null },
          proposedAction: { type: 'review_guideline_concern', fields: { code, cond_no: u.cond_no } },
          dedupeKey: `isg-concern:${u.cond_no}`,
        });
      } else if (u.flag === 'info_missing' || u.flag === 'appraisal_review') {
        // THESE TWO WERE DELIBERATELY NOT FORWARDED, AND THAT LEFT THEM UN-SILENCEABLE (post-merge
        // audit 2026-07-27). They were held back for one reason only: a fatal suggestion emails the
        // whole file team, and neither of these is a chase-a-document event worth a notification.
        // But the ai_suggestions row is ALSO what carries a human's Dismiss — so with no row, the
        // desk re-raised them on every single file view with no way to act on or quiet them. That is
        // exactly the "reappears with nothing to click" trap the merged work fixed for the other
        // three kinds, and folding the desk's own panel into the background made these the most
        // visible instance of it.
        //
        // They are forwarded now, with `suppressNotify` — the row exists (so Dismiss / Add a note /
        // Escalate all work and stick), the team is not emailed. One mapper covers all five kinds.
        const isInfo = u.flag === 'info_missing';
        const name = u.name || 'this requirement';
        out.push({
          source: SOURCE, kind: 'finding', severity: sev, important: false, suppressNotify: true,
          title: isInfo
            ? `${nb} needs "${name}" — the slot on the file is empty`
            : `"${name}" — found while reviewing the appraisal for ${nb}`,
          body: (isInfo
            ? 'This is information that belongs ON the file, not a document to collect — the slot is empty. Fill it in and this clears.'
            : ((u.reason ? `${u.reason} ` : '') + `This came out of the appraisal read${sev === 'fatal' ? ' — escalate it.' : '.'}`))
            + (u.required_evidence ? ` What to confirm: ${u.required_evidence}` : ''),
          evidence: { code, domain: u.domain || null, cond_no: u.cond_no, noteBuyer: nb, flag: u.flag,
            concern_field: u.concern_field || null },
          proposedAction: { type: isInfo ? 'fill_file_field' : 'review_appraisal_finding', fields: { code, cond_no: u.cond_no } },
          // Keyed on cond_no, NOT the template code: two rules of the same flag can share a
          // pilot_template_code, and a shared key would collapse them into one row.
          dedupeKey: `isg-${u.flag}:${u.cond_no}`,
        });
      }
    }
    return out;
  } catch (_e) { return []; }
}

/**
 * syncInvestorGuidelineFindings(client, appId, opts?) → { raised, fatal } (DB, best-effort).
 * Runs the desk for the file (or uses opts.desk if the caller already computed it) and
 * records each unhappy item as an ai_suggestion. Dedupe keys collapse re-fires to one
 * OPEN row per condition, so repeated file views never spam. NEVER throws.
 */
async function syncInvestorGuidelineFindings(client, appId, opts) {
  const o = opts || {};
  try {
    if (!appId || !client) return { raised: 0, fatal: 0 };
    let desk = o.desk || null;
    if (!desk) {
      const deskMod = require('./desk');
      desk = await deskMod.runInvestorGuidelineDesk(appId, client).catch(() => null);
    }
    const payloads = deskToSuggestions(desk);
    // A HUMAN'S DECISION IS NOT RE-OPENED (audit 2026-07-27).
    //
    // `aiSug.record` refreshes an existing row only when it is still `status='open'`; against a
    // CLOSED row it finds nothing and INSERTS a fresh open one. The desk is a pure function of the
    // file, so it re-raises the same item on every view — which meant a staffer's Dismiss was undone
    // the next time anyone opened the loan, forever. That was already true before the findings merge;
    // the merge just made it load-bearing, because the file view now DROPS a guideline finding whose
    // suggestion is closed. Without this the drop would be reversed within one page load.
    //
    // Keyed on `decided_by_staff_id`, which is the only thing that distinguishes the two ways a row
    // closes: `decide()` stamps the staffer who acted, and `retractStale`'s automatic withdrawal is a
    // raw UPDATE that never touches it. So a rule the DESK retracted and later legitimately raises
    // again comes straight back (decided_by is NULL → not suppressed), while a judgement a person
    // actually made stands. Best-effort: a failed read suppresses nothing.
    // A DECISION ON A WARNING DOES NOT SILENCE A LATER FATAL. The dedupe key
    // (`isg-gap:rtl_cond_feasibility`) encodes neither severity nor the state of the file, so a
    // dismissal made while an item was a warning on a light-rehab file would otherwise keep it quiet
    // after the deal converts to ground-up and the SAME rule becomes a dealbreaker. Silencing a
    // dealbreaker with a decision that was made about something milder is a false clear, so the
    // suppression only holds while the item is no worse than what the person actually judged.
    // FLAGGING AN ITEM MUST NOT CLONE IT — the 298-email burst (re-audit 2026-07-27, reproduced on
    // the live DB against `origin/main` too, so this is a pre-existing hole this branch simply makes
    // easy to reach: Escalate / Mark important are now one click on the merged finding card).
    //
    // `record()` refreshes a row only while it is `status='open'`. `escalated` /`marked_important` /
    // `asked_admin` are NOT decisions — they mean "still needs handling, louder" — but they are also
    // not `open`, so the refresh missed them and INSERTED a second row for the same key. A fresh
    // insert of a FATAL fires `_notifyFatalNew`, which fans out to the whole file team: one page load
    // after a staffer clicked Escalate produced 298 "New fatal AI finding" sends and left a phantom
    // duplicate open row behind.
    //
    // So the skip set has TWO members, for two different reasons:
    //   ALIVE   — the key already owns a live row in a status `record()` cannot refresh. Re-recording
    //             it adds nothing and costs a duplicate + a mail-out.
    //   DECIDED — a human closed it (see above), and only while the item is no worse than what they
    //             actually judged.
    const SEV_RANK = { fatal: 3, warning: 2, info: 1 };
    const ALIVE_NOT_OPEN = ['escalated', 'marked_important', 'asked_admin'];
    const decidedSev = new Map();   // dedupe_key → the most serious severity a human has decided on
    const aliveKeys = new Set();    // dedupe_key → already live under a status record() can't refresh
    try {
      const d = await client.query(
        `SELECT dedupe_key, severity, status, decided_by_staff_id FROM ai_suggestions
          WHERE application_id=$1 AND source=$2 AND dedupe_key IS NOT NULL
            AND (status = ANY($3::text[])
                 OR (decided_by_staff_id IS NOT NULL AND status NOT IN ('open') AND NOT (status = ANY($3::text[]))))`,
        [appId, SOURCE, ALIVE_NOT_OPEN]);
      for (const r of d.rows) {
        const k = String(r.dedupe_key);
        if (ALIVE_NOT_OPEN.includes(r.status)) { aliveKeys.add(k); continue; }
        const rank = SEV_RANK[String(r.severity || '').toLowerCase()] || 0;
        if (!decidedSev.has(k) || rank > decidedSev.get(k)) decidedSev.set(k, rank);
      }
    } catch (_e) { /* suppress nothing on a read failure */ }
    let raised = 0, fatal = 0, heldByHuman = 0;
    for (const p of payloads) {
      const key = p.dedupeKey ? String(p.dedupeKey) : null;
      if (key && aliveKeys.has(key)) { heldByHuman += 1; continue; }
      const decided = key ? decidedSev.get(key) : undefined;
      if (decided !== undefined && decided >= (SEV_RANK[String(p.severity || '').toLowerCase()] || 0)) {
        heldByHuman += 1; continue;
      }
      try {
        await aiSug.record(client, Object.assign({ applicationId: appId }, p));
        raised += 1;
        if (p.severity === 'fatal') fatal += 1;
      } catch (_e) { /* one bad row never stops the rest */ }
    }
    // CONVERGE — close what the desk no longer says (owner-reported 2026-07-26).
    //
    // This sync only ever INSERTED. Nothing retracted a guideline finding when the rule stopped
    // raising it, so every notice written before a rule was corrected stayed open on that file
    // FOREVER. The owner reviewed a file on 2026-07-26 and saw blank "Blue Lake requires X"
    // notices whose rules had been given their correct dispositions on 2026-07-24 — the fix was
    // real and completely invisible, because the screen was showing history rather than the
    // system's current judgement. That is also why they said "fix this also for all the previous
    // files": append-only means every future rule fix has exactly the same problem.
    //
    // So the desk's output is now the AUTHORITY for its own rows: anything open under this source
    // that is not in the current set is retracted.
    // ...but ONLY when the desk demonstrably ASSESSED the file.
    //
    // `runInvestorGuidelineDesk` returns a well-formed EMPTY result on any internal failure — a
    // require error, a loadRuleContext throw, a null load — indistinguishable in shape from a
    // genuine "nothing applies". Retracting on that would mean a transient database blip during a
    // file view silently CLOSES EVERY open guideline finding on the file. Wiping real findings on a
    // hiccup is far worse than leaving a stale one visible for one more cycle, so retraction
    // requires positive evidence the desk actually evaluated rules: at least one verdict.
    //
    // Cost of being conservative: a file whose rules genuinely all stopped applying keeps its stale
    // rows until the desk has something to say. That is the right side to err on.
    //
    // ...and only when the desk saw the WHOLE file (audit 2026-07-26). `verdicts` is computed from
    // the applicable RULES, before and independently of the signal loaders — and each of those
    // loaders (conditions on file, twin facts, borrower email, appraisal, the concern signal, the
    // SOW contingency) swallows its own error so a bad query can never break a file view. A failed
    // appraisal read silently removes every appraisal item from `unhappy[]`; a failed concern read
    // removes every concern item. `verdicts.length` stays healthy through all of that, so the guard
    // below on its own would happily retract live findings and stamp them "the rule was corrected"
    // — which would be a lie, and on the next good run they would be re-INSERTED, re-firing the
    // fatal-notify email to the loan officer every cycle. So the desk now names the loaders that
    // failed, and a degraded read retracts nothing.
    const assessed = !!(desk && Array.isArray(desk.verdicts) && desk.verdicts.length);
    const degraded = !!(desk && Array.isArray(desk.degraded) && desk.degraded.length);
    const retracted = (assessed && !degraded)
      ? await retractStale(client, appId, payloads.map((p) => p.dedupeKey))
      : 0;
    // Name the loaders, not just the fact — "the appraisal read failed" is actionable, "degraded"
    // is not, and this is what the caller logs when a retraction is skipped.
    return { raised, fatal, retracted, assessed, degraded, heldByHuman,
      degradedSources: degraded ? desk.degraded.slice() : [] };
  } catch (_e) { return { raised: 0, fatal: 0, retracted: 0, assessed: false, degraded: false, heldByHuman: 0, degradedSources: [] }; }
}

/**
 * Close every OPEN row from this desk whose dedupeKey the desk no longer raises.
 *
 * UNTOUCHED ROWS ONLY (`status='open'`). The moment a human escalates, notes, dismisses, converts
 * to a condition or task, marks important, or asks an admin, the row stops being ours to withdraw —
 * their decision is a record of a judgement made, and silently deleting it would be far worse than
 * the noise this fixes. Those statuses are all excluded by the `status='open'` predicate.
 *
 * Marked `dismissed` with a status_reason naming the retraction, so the audit trail shows WHY it
 * closed rather than it simply vanishing. Never throws — a failed retraction must not break the
 * file view (worst case the stale row stays one more cycle).
 */
async function retractStale(client, appId, currentKeys) {
  try {
    const keys = (currentKeys || []).filter(Boolean);
    const r = await client.query(
      `UPDATE ai_suggestions
          SET status = 'dismissed',
              status_reason = 'Retracted automatically: the guideline desk no longer raises this for '
                              || 'the file (the rule was corrected, or the file changed).',
              updated_at = now()
        WHERE application_id = $1
          AND source = $2
          AND status = 'open'
          AND NOT (dedupe_key = ANY($3::text[]))
        RETURNING id`,
      [appId, SOURCE, keys]);
    return r.rowCount || 0;
  } catch (_e) { return 0; }
}

module.exports = { deskToSuggestions, syncInvestorGuidelineFindings, retractStale, SOURCE };
