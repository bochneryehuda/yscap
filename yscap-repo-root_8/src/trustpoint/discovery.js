'use strict';
/**
 * TrustPoint project DISCOVERY + LINKING (phase 2 — blueprint §4, owner D1).
 * The investor creates projects; PILOT sweeps the project list (full-pagination
 * id-diff — projects carry no created_at and there is no Project Created webhook),
 * stores newcomers as UNLINKED rows, and links them to files:
 *   auto — Tier 1 (loan number) or Tier 2 (unique address) via the pure matcher;
 *   manual — the desk confirms a suggestion or picks a file (never fuzzy auto-bound).
 * On link: milestone crosswalk build + a silent BASELINE hydrate of the project's
 * draw history (go-forward — no notification burst for history).
 */

const db = require('../db');
const client = require('./client');
const matcher = require('./matcher');
const mirror = require('./mirror');
const notify = require('../lib/notify');

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');

/** Candidate PILOT files for linking: funded, note buyer routed to the trustpoint platform. */
async function candidateFiles() {
  const labels = (await db.query(
    `SELECT partner_label FROM sitewire_inspection_rules WHERE draw_platform='trustpoint' AND partner_label IS NOT NULL`)).rows
    .map((r) => norm(r.partner_label)).filter(Boolean);
  if (!labels.length) return [];
  const rows = (await db.query(
    `SELECT a.id, a.ys_loan_number, a.lender, a.rehab_budget,
            a.property_address->>'oneLine' AS addr_one_line, a.property_address->>'zip' AS zip,
            b.email AS borrower_email, l.llc_name
       FROM applications a
       JOIN borrowers b ON b.id = a.borrower_id
       LEFT JOIN llcs l ON l.id = a.llc_id
      WHERE a.deleted_at IS NULL AND a.status = 'funded'
        AND regexp_replace(lower(COALESCE(a.lender,'')), '[^a-z0-9]+', '', 'g') = ANY($1::text[])`, [labels])).rows;
  return rows.map((r) => ({
    id: r.id, ys_loan_number: r.ys_loan_number, addr_one_line: r.addr_one_line, zip: r.zip,
    rehab_budget_cents: client.centsFromTp(r.rehab_budget),
    borrower_email: r.borrower_email, llc_name: r.llc_name,
  }));
}

/** Extract the matcher's project shape from a TrustPoint project read. */
function projectShape(tpId, p) {
  const addr = p && p.address ? (p.address.address || [p.address.address_1, p.address.city, p.address.state, p.address.zip_code].filter(Boolean).join(', ')) : null;
  const emails = [];
  for (const c of (p && Array.isArray(p.companies) ? p.companies : [])) {
    for (const m of (Array.isArray(c.members) ? c.members : [])) if (m && m.email) emails.push(m.email);
  }
  return {
    tp_project_id: String(tpId),
    name: (p && p.name) || null,
    external_id: p && p.loan ? p.loan.external_id : null,
    address_text: addr,
    zip: p && p.address ? (p.address.zip_code || null) : null,
    budget_cents: p && p.loan ? client.centsFromTp(p.loan.budget_commitment) : null,
    borrower_emails: emails,
    entity_name: (p && p.legal_entity) || null,
    status: (p && p.status) || null,
  };
}

/** Record/refresh an unlinked project row (also the just-in-time webhook path). */
async function noteUnknownProject(tpProjectId, loanId) {
  await db.query(
    `INSERT INTO trustpoint_project_links (tp_project_id, loan_external_id)
     VALUES ($1,$2)
     ON CONFLICT (tp_project_id) DO UPDATE SET loan_external_id=COALESCE(EXCLUDED.loan_external_id, trustpoint_project_links.loan_external_id), updated_at=now()`,
    [String(tpProjectId), loanId || null]);
}

/** Bind a project to a file (auto or manual). Fails loudly on double-links. */
async function linkProject(tpProjectId, applicationId, { matchedBy = 'manual', reason = null, staffId = null, baselineHydrate = true } = {}) {
  const existing = (await db.query(`SELECT application_id FROM trustpoint_project_links WHERE tp_project_id=$1`, [String(tpProjectId)])).rows[0];
  if (existing && existing.application_id && existing.application_id !== applicationId) {
    const e = new Error('project already linked to another file'); e.code = 'already_linked'; throw e;
  }
  const taken = (await db.query(`SELECT tp_project_id FROM trustpoint_project_links WHERE application_id=$1 AND tp_project_id<>$2`, [applicationId, String(tpProjectId)])).rows[0];
  if (taken) { const e = new Error('file already linked to another TrustPoint project'); e.code = 'file_taken'; throw e; }
  try {
    await db.query(
      `INSERT INTO trustpoint_project_links (tp_project_id, application_id, matched_by, match_detail, confirmed_by)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (tp_project_id) DO UPDATE SET application_id=EXCLUDED.application_id, matched_by=EXCLUDED.matched_by,
          match_detail=EXCLUDED.match_detail, confirmed_by=COALESCE(EXCLUDED.confirmed_by, trustpoint_project_links.confirmed_by),
          candidate_application_id=NULL, candidate_reason=NULL, updated_at=now()`,
      [String(tpProjectId), applicationId, matchedBy, reason, staffId]);
  } catch (e) {
    // The concurrent-race loser hits UNIQUE(application_id) — surface it as the same
    // typed conflict the pre-check produces, never a raw 500 (phase-2 audit #20).
    if (e && e.code === '23505') { const err = new Error('file already linked to another TrustPoint project'); err.code = 'file_taken'; throw err; }
    throw e;
  }
  await notify.notifyAppStaff(applicationId, {
    type: 'draw_inbound', title: 'File linked to its TrustPoint project',
    body: `This file is now linked to its TrustPoint project (${matchedBy === 'manual' ? 'confirmed by hand' : 'matched by ' + matchedBy.replace('_', ' ')}${reason ? ' — ' + reason : ''}). Draw activity there will show here.`,
    applicationId, link: `/internal/app/${applicationId}/draws`, inAppOnly: true,
  }).catch(() => {});
  // Crosswalk + silent history baseline.
  try { await buildMilestoneLinks(applicationId, String(tpProjectId)); } catch (e) { console.warn('[trustpoint] milestone crosswalk failed:', e && e.message); }
  if (baselineHydrate === false) {
    // The caller explicitly opted out of the history hydrate (it asserts there is no
    // pre-link history to guard) — the link counts as baselined so live reactions flow.
    await db.query(`UPDATE trustpoint_project_links SET baselined_at=now(), updated_at=now() WHERE tp_project_id=$1`, [String(tpProjectId)]);
  } else if (client.available()) {
    try {
      await mirror.hydrateProject(applicationId, String(tpProjectId), { baseline: true });
      await db.query(`UPDATE trustpoint_project_links SET baselined_at=now(), updated_at=now() WHERE tp_project_id=$1`, [String(tpProjectId)]);
    } catch (e) {
      // Leave baselined_at NULL — the sweep retries the baseline before any live
      // reaction can fire for this project's history (phase-2 audit #9).
      console.warn('[trustpoint] baseline hydrate failed (sweep will retry):', e && e.message);
    }
  }
  return { linked: true };
}

async function unlinkProject(tpProjectId, staffId) {
  const id = String(tpProjectId);
  // Mirror rows are DERIVED data — remove them with the link so a mis-link never
  // strands another borrower's draw amounts on the wrong file (phase-2 audit #10).
  // A correct re-link re-hydrates everything from TrustPoint.
  await db.query(`DELETE FROM trustpoint_draw_lines WHERE tp_draw_id IN (SELECT tp_draw_id FROM trustpoint_draws WHERE tp_project_id=$1)`, [id]).catch(() => {});
  await db.query(`DELETE FROM trustpoint_milestone_snapshots WHERE tp_project_id=$1`, [id]).catch(() => {});
  await db.query(`DELETE FROM trustpoint_draws WHERE tp_project_id=$1`, [id]);
  await db.query(`DELETE FROM trustpoint_service_orders WHERE tp_project_id=$1`, [id]);
  await db.query(`DELETE FROM trustpoint_milestone_links WHERE tp_project_id=$1`, [id]);
  await db.query(
    `UPDATE trustpoint_project_links SET application_id=NULL, matched_by=NULL, match_detail=NULL, baselined_at=NULL, confirmed_by=$2, updated_at=now()
      WHERE tp_project_id=$1`, [id, staffId || null]);
  return { unlinked: true };
}

/** D4 crosswalk: TrustPoint milestones ↔ the file's Sitewire per-line ledger. */
async function buildMilestoneLinks(applicationId, tpProjectId) {
  if (!client.available()) return { matched: 0, unmatched: 0, skipped: 'no_api' };
  const milestones = (await client.listMilestones(tpProjectId)).map((m) => ({
    tp_milestone_id: String(m.id), name: m.name || null,
    amount_cents: client.centsFromTp(m.original_estimate_amount ?? m.estimate_amount ?? m.prefunding_amount),
    raw: m,
  }));
  const sowLines = (await db.query(
    `SELECT sitewire_job_item_id, sow_line_key, name, budgeted_cents FROM sitewire_job_item_links
      WHERE application_id=$1 AND (state IS NULL OR state <> 'deleted') AND is_media_item = false AND sitewire_job_item_id IS NOT NULL`,
    [applicationId])).rows;
  const { matched, unmatched } = matcher.matchMilestones(milestones, sowLines);
  for (const m of milestones) {
    const hit = matched.find((x) => x.tp_milestone_id === m.tp_milestone_id) || null;
    await db.query(
      `INSERT INTO trustpoint_milestone_links (application_id, tp_project_id, tp_milestone_id, name, amount_cents, sitewire_job_item_id, sow_line_key, matched_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (tp_milestone_id) DO UPDATE SET name=EXCLUDED.name, amount_cents=EXCLUDED.amount_cents,
          sitewire_job_item_id=COALESCE(trustpoint_milestone_links.sitewire_job_item_id, EXCLUDED.sitewire_job_item_id),
          sow_line_key=COALESCE(trustpoint_milestone_links.sow_line_key, EXCLUDED.sow_line_key),
          matched_by=COALESCE(trustpoint_milestone_links.matched_by, EXCLUDED.matched_by), updated_at=now()`,
      [applicationId, tpProjectId, m.tp_milestone_id, m.name, m.amount_cents,
       hit ? hit.sitewire_job_item_id : null, hit ? hit.sow_line_key : null, hit ? hit.matched_by : null]);
  }
  return { matched: matched.length, unmatched: unmatched.length };
}

/**
 * The discovery SWEEP: full-pagination id-diff over GET /projects/, store newcomers,
 * auto-link Tier 1/2, refresh mirrored project status (DISCARDED → flag for review).
 */
async function sweep() {
  if (!client.available() || !client.enabled()) return { skipped: 'off' };
  const projects = await client.listProjects();
  const known = new Set((await db.query(`SELECT tp_project_id FROM trustpoint_project_links`)).rows.map((r) => r.tp_project_id));
  const candidates = await candidateFiles();
  let discovered = 0, autoLinked = 0;
  for (const p of projects) {
    const tpId = String(p.id);
    const isNew = !known.has(tpId);
    let detail = p;
    if (isNew) { try { detail = await client.getProject(tpId); } catch (_) {} }
    const shape = projectShape(tpId, detail);
    await db.query(
      `INSERT INTO trustpoint_project_links (tp_project_id, loan_external_id, project_name, address_text, tp_status, discarded, raw)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)
       ON CONFLICT (tp_project_id) DO UPDATE SET
          loan_external_id=COALESCE(EXCLUDED.loan_external_id, trustpoint_project_links.loan_external_id),
          project_name=COALESCE(EXCLUDED.project_name, trustpoint_project_links.project_name),
          address_text=COALESCE(EXCLUDED.address_text, trustpoint_project_links.address_text),
          tp_status=COALESCE(EXCLUDED.tp_status, trustpoint_project_links.tp_status),
          discarded=EXCLUDED.discarded, updated_at=now()`,
      [tpId, shape.external_id, shape.name, shape.address_text, shape.status, shape.status === 'DISCARDED', isNew ? ((x) => x.length > 50000 ? null : x)(JSON.stringify(detail)) : null]);
    if (isNew) discovered++;
    // A linked project whose baseline hydrate failed at link time retries here BEFORE any
    // live reaction can fire on its history (audit #9).
    const lrow = (await db.query(`SELECT application_id, baselined_at, discarded FROM trustpoint_project_links WHERE tp_project_id=$1`, [tpId])).rows[0];
    if (lrow && lrow.application_id && !lrow.baselined_at) {
      try {
        await mirror.hydrateProject(lrow.application_id, tpId, { baseline: true });
        await db.query(`UPDATE trustpoint_project_links SET baselined_at=now(), updated_at=now() WHERE tp_project_id=$1`, [tpId]);
      } catch (e) { console.warn('[trustpoint] baseline retry failed:', e && e.message); }
    }
    // A LINKED project flipping to DISCARDED needs a human look at the link (audit #22).
    if (lrow && lrow.application_id && shape.status === 'DISCARDED' && !lrow.discarded) {
      await notify.notifyAppStaff(lrow.application_id, {
        type: 'draw_inbound', title: 'TrustPoint project was discarded',
        body: 'The TrustPoint project linked to this file was DISCARDED on their side. Check whether the link is still right (it may have been replaced by a new project).',
        applicationId: lrow.application_id, link: `/internal/app/${lrow.application_id}/draws`,
      }).catch(() => {});
    }
    // (re)try the auto-matcher for any still-unlinked project
    const row = (await db.query(`SELECT application_id FROM trustpoint_project_links WHERE tp_project_id=$1`, [tpId])).rows[0];
    if (row && !row.application_id && candidates.length) {
      const m = matcher.matchProject(shape, candidates);
      if (m.tier && m.applicationId) {
        try { await linkProject(tpId, m.applicationId, { matchedBy: m.matchedBy, reason: m.reason }); autoLinked++; }
        catch (e) { if (e.code !== 'already_linked' && e.code !== 'file_taken') console.warn('[trustpoint] auto-link failed:', e && e.message); }
      } else if (m.reason) {
        await db.query(`UPDATE trustpoint_project_links SET candidate_reason=$2, updated_at=now() WHERE tp_project_id=$1 AND application_id IS NULL`, [tpId, m.reason]);
      }
    }
  }
  return { projects: projects.length, discovered, autoLinked };
}

module.exports = { sweep, linkProject, unlinkProject, buildMilestoneLinks, noteUnknownProject, candidateFiles, projectShape };
