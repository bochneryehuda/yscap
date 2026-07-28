'use strict';
/**
 * TrustPoint per-draw CONVERSATION mirror (owner-directed 2026-07-27: "we should also be able to
 * see the real messages in our system related to each and every draw — all the messages going back
 * and forth").
 *
 * The draw desk could see WHAT a draw was doing but never WHY. The reason a draw is stuck is a
 * real exchange living inside TrustPoint — verified on the live account, draw #2 of
 * 105-107 N 10th St carries five messages, including "Please update the ZIP code. It is missing a
 * 0, and therefore the draw request has failed." That is the answer to "why has this not moved?",
 * and it was invisible here.
 *
 * READ-ONLY, exactly like the draws and service orders. PILOT never posts a comment back: a reply
 * belongs in TrustPoint where the administrator will actually see it, and a one-way mirror can
 * never put words in our coordinator's mouth.
 *
 * Best-effort and idempotent throughout — it can never block or reverse a draw reaction.
 * Off-switch `TRUSTPOINT_COMMENTS_ENABLED=0`.
 */

const lazy = { get db() { return require('../db'); }, get client() { return require('./client'); } };

const enabled = () => process.env.TRUSTPOINT_COMMENTS_ENABLED !== '0';
const PREFIX = () => String(process.env.TRUSTPOINT_PATH_PREFIX || '/public-api').replace(/\/+$/, '');

/**
 * TrustPoint stores a comment body as HTML (`<p>Thank you.</p>`). Render it to the plain text a
 * desk actually wants, PURE and defensively — this text is displayed, so a stray tag must never
 * reach a screen as markup, and a hostile body must never become one.
 */
function toPlainText(html) {
  let s = String(html == null ? '' : html);
  if (!s) return '';
  s = s.replace(/<\s*(script|style)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, ' '); // drop script/style CONTENT
  s = s.replace(/<\s*br\s*\/?\s*>/gi, '\n');
  s = s.replace(/<\s*\/\s*(p|div|li|tr|h[1-6])\s*>/gi, '\n');
  s = s.replace(/<[^>]*>/g, '');                                            // remaining tags
  s = s.replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<')
       .replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;/gi, "'")
       .replace(/&#(\d{1,6});/g, (m, d) => { const n = Number(d); return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : ' '; });
  s = s.replace(/[ \t ]+/g, ' ').replace(/\s*\n\s*/g, '\n').replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

/** A display name from whatever author shape TrustPoint sends (they vary). Never guesses. */
function authorOf(c) {
  const a = c && (c.author || c.created_by || c.user || c.commented_by);
  if (!a) return null;
  if (typeof a === 'string') return a.trim() || null;
  if (typeof a !== 'object') return null;
  const direct = a.name || a.full_name || a.display_name;
  if (direct) return String(direct).trim() || null;
  try {
    const n = require('../lib/person-name').displayName(a);
    return n || null;
  } catch (_) { return null; }
}

/** Upsert one comment. COALESCE protects a previously-hydrated field from a thinner later read. */
async function upsertComment(appId, tpProjectId, tpDrawId, c) {
  const id = String((c && (c.id || c.comment_id)) || '').trim();
  if (!id) return false;
  const body = toPlainText(c.message != null ? c.message : c.body);
  const tags = Array.isArray(c.tags) ? JSON.stringify(c.tags.slice(0, 20).map((t) => String(t).slice(0, 80))) : null;
  const raw = ((x) => (x && x.length <= 20000 ? x : null))(JSON.stringify(c));
  const r = await lazy.db.query(
    `INSERT INTO trustpoint_draw_comments (tp_comment_id, application_id, tp_project_id, tp_draw_id,
        parent_id, author, body, tags, is_pinned, commented_at, edited_at, raw, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12::jsonb,now())
     ON CONFLICT (tp_comment_id) DO UPDATE SET
        application_id = EXCLUDED.application_id,
        tp_draw_id     = COALESCE(EXCLUDED.tp_draw_id, trustpoint_draw_comments.tp_draw_id),
        parent_id      = COALESCE(EXCLUDED.parent_id, trustpoint_draw_comments.parent_id),
        author         = COALESCE(EXCLUDED.author, trustpoint_draw_comments.author),
        body           = COALESCE(NULLIF(EXCLUDED.body, ''), trustpoint_draw_comments.body),
        tags           = COALESCE(EXCLUDED.tags, trustpoint_draw_comments.tags),
        is_pinned      = EXCLUDED.is_pinned,
        edited_at      = COALESCE(EXCLUDED.edited_at, trustpoint_draw_comments.edited_at),
        raw            = COALESCE(EXCLUDED.raw, trustpoint_draw_comments.raw),
        updated_at     = now()
     RETURNING (xmax = 0) AS inserted`,
    [id, appId, tpProjectId == null ? null : String(tpProjectId), tpDrawId == null ? null : String(tpDrawId),
     c.parent_id == null ? null : String(c.parent_id), authorOf(c), body, tags, !!c.is_pinned,
     c.created_at || null, c.message_updated_at || c.updated_at || null, raw]);
  return !!(r.rows[0] && r.rows[0].inserted);
}

/** Mirror the whole conversation on one draw. Safe to call repeatedly. */
async function syncDrawComments(appId, tpProjectId, tpDrawId) {
  if (!enabled()) return { skipped: 'off' };
  try {
    const res = await lazy.client.call(
      `${PREFIX()}/projects/${tpProjectId}/draw_requests/${tpDrawId}/comments/`, { query: { limit: 100 } });
    const rows = Array.isArray(res && res.results) ? res.results : (Array.isArray(res) ? res : []);
    let added = 0;
    for (const c of rows) {
      try { if (await upsertComment(appId, tpProjectId, tpDrawId, c)) added++; } catch (_) { /* one bad comment never stops the thread */ }
    }
    return { ok: true, seen: rows.length, added };
  } catch (e) {
    console.warn(`[trustpoint] comment sync failed (draw ${tpDrawId}): ${e && e.message}`);
    return { error: true };
  }
}

/**
 * The thread for a draw, oldest first, with replies attached to their parent — the order a person
 * reads a conversation in.
 */
async function threadFor(appId, tpDrawId) {
  const rows = (await lazy.db.query(
    `SELECT tp_comment_id, parent_id, author, body, tags, is_pinned, commented_at, edited_at
       FROM trustpoint_draw_comments
      WHERE application_id=$1 AND tp_draw_id=$2 AND NULLIF(btrim(COALESCE(body,'')),'') IS NOT NULL
      ORDER BY commented_at ASC NULLS LAST, tp_comment_id`, [appId, String(tpDrawId)])).rows;
  const byId = new Map(rows.map((r) => [r.tp_comment_id, { ...r, replies: [] }]));
  const top = [];
  for (const r of byId.values()) {
    const parent = r.parent_id ? byId.get(r.parent_id) : null;
    if (parent) parent.replies.push(r); else top.push(r);
  }
  return top;
}

module.exports = { syncDrawComments, threadFor, toPlainText, _authorOf: authorOf, _upsertComment: upsertComment };
