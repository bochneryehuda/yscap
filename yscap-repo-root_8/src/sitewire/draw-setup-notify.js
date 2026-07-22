'use strict';
/**
 * Borrower "your construction draw is set up" welcome email — the DB-bound sender (owner-directed
 * 2026-07-21). Fires ONCE per file, the first time the property is actually live in Sitewire
 * (managed). Shared by the coordinator's Start-draw route AND the worker's stranded-birth backfill,
 * so the welcome lands whichever path first makes the property live. Best-effort + idempotent — it
 * claims a single-send stamp (sitewire_property_links.setup_email_sent_at) atomically, so a re-push
 * or a second caller never re-emails. Content + recipients (borrower set + officer BCC + the draws@
 * coordinator desk) + the per-file reply-to come from notify + the pure draw-setup-email builder.
 */
const db = require('../db');
const orchestrator = require('./orchestrator');
const rehab = require('../lib/rehab-budget');
const notify = require('../lib/notify');
const { drawSetupNotifyOpts } = require('../lib/email/draw-setup-email');

// Robust one-line property address from the property_address jsonb (mirrors routes/sitewire.addrExpr).
function addrExpr(alias) {
  const p = `${alias}.property_address`;
  return `COALESCE(
    NULLIF(btrim(${p}->>'oneLine'), ''),
    NULLIF(btrim(${p}->>'formatted_address'), ''),
    NULLIF(btrim(concat_ws(', ',
      NULLIF(btrim(concat_ws(' ', ${p}->>'line1', ${p}->>'street', ${p}->>'unit')), ''),
      NULLIF(btrim(${p}->>'city'), ''),
      NULLIF(btrim(concat_ws(' ', ${p}->>'state', ${p}->>'zip')), ''))), ''))`;
}

/**
 * @returns {Promise<{sent:boolean, reason?:string}>} — never throws.
 */
async function sendDrawSetupWelcome(appId) {
  try {
    // Only ever for a property that is genuinely live in Sitewire (managed, go-forward-only).
    if (!(await orchestrator.isManaged(appId))) return { sent: false, reason: 'not_managed' };

    // Audit finding C-9 (2026-07-21): resolve the effective inspection method BEFORE claiming the
    // atomic single-send stamp. The old order — claim first, resolve second, default 'mobile' on
    // error — meant a TRANSIENT loadFile/resolve failure on a physical-inspection file sent the
    // VIRTUAL instructions once, and the stamp then permanently prevented the correct email from
    // ever going out. Now: if resolution fails, RETURN early without claiming; the next call
    // retries. Only after resolution succeeds do we claim + send.
    let method;
    try {
      const a = await orchestrator.loadFile(appId);
      const link = await orchestrator.getLink(appId);
      if (a) {
        const program = /gold/i.test(String(a.registered_program || '')) ? 'gold' : 'standard';
        const cp = await orchestrator.resolveCapitalPartnerId(a.lender);
        const rule = await orchestrator.resolveRule(a.lender, cp && cp.id, program);
        const insp = orchestrator.resolveInspection(link, rule);
        method = (insp && insp.method) || (link && link.inspection_method) || null;
      } else if (link && link.inspection_method) {
        method = link.inspection_method;
      }
    } catch (e) {
      // Do NOT claim on a resolution error — retry next time (the caller/backfill re-drives).
      console.warn('[sitewire] draw-setup welcome: inspection-method resolution failed; will retry:', e && e.message);
      return { sent: false, reason: 'inspection_resolution_failed' };
    }
    // A null method means neither the rule nor the link knew — that's also a "come back later"
    // signal, not a "default to virtual" (which was the exact wrong-instructions bug). Retry.
    if (!method) return { sent: false, reason: 'inspection_method_unknown' };

    // Atomically claim the single send so a re-push / a second caller can't re-email.
    const claim = await db.query(
      `UPDATE sitewire_property_links SET setup_email_sent_at = now()
        WHERE application_id = $1 AND setup_email_sent_at IS NULL RETURNING application_id`, [appId]);
    if (!claim.rows[0]) return { sent: false, reason: 'already_sent' };

    const dollars = await rehab.requiredRehabBudget(appId).catch(() => null);
    const row = (await db.query(`SELECT ${addrExpr('a')} AS addr FROM applications a WHERE a.id = $1`, [appId])).rows[0];

    const opts = drawSetupNotifyOpts({
      address: (row && row.addr) || null,
      budgetCents: dollars != null ? Math.round(Number(dollars) * 100) : 0,
      method,
    });
    await notify.notifyAppBorrowers(appId, opts);
    return { sent: true };
  } catch (e) {
    console.warn('[sitewire] draw-setup welcome email failed:', e && e.message);
    return { sent: false, reason: 'error' };
  }
}

module.exports = { sendDrawSetupWelcome, _addrExpr: addrExpr };
