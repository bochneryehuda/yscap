'use strict';
/**
 * THE EDITED-EMAIL CHOKEPOINT (owner-directed 2026-08-26: "instead of it automatically
 * sending an email, it should populate a full preview … it should be fully editable …
 * Don't remove any option to add recipients or anything").
 *
 * Every MANUAL send family (title/insurance orders + follow-ups, attorney closing prep,
 * the investor tape, the draw investor delivery) already builds its email through its own
 * PURE builder. The preview a screen shows is that builder's own output — subject + the
 * TEXT rendering — and when the person edits it, the send lands the edit through THIS one
 * module, so "how does a hand-edit land" has exactly one answer:
 *
 *   · cleanOverride(raw) — validates what a screen sent. A blank field means "keep the
 *     built one" (an empty subject or body is never sent), NULs are stripped (the jsonb /
 *     22021 class), sizes are capped.
 *   · applyOverride(built, override, opts) — `built` is the family's own {subject, html,
 *     text}. An edited SUBJECT replaces the subject verbatim. An edited BODY is
 *     re-rendered through the ONE branded template as paragraphs of the typed text —
 *     NEVER spliced into the original rich HTML (mapping edited text back into a
 *     structured table layout would be a guess, and a guessed splice on an email to an
 *     outside vendor is worse than a plain branded letter). No override → the built
 *     email comes back byte-identical, `edited:false`.
 *
 * PURE: no database, no config beyond the shared template. The SCHEDULED sends inherit
 * this for free — the dispatcher re-posts the stored payload into the ordinary send
 * route, so an override stored in the payload flows through the same door.
 */
const tpl = require('./template');

const SUBJECT_MAX = 300;
const BODY_MAX = 20000;

/** Validate a screen's {subject?, text?} — null when nothing was really edited. */
function cleanOverride(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const subject = typeof raw.subject === 'string'
    ? raw.subject.replace(/\u0000/g, '').replace(/[\r\n]+/g, ' ').trim().slice(0, SUBJECT_MAX) : '';
  const text = typeof raw.text === 'string'
    ? raw.text.replace(/\u0000/g, '').replace(/\r\n/g, '\n').trim().slice(0, BODY_MAX) : '';
  if (!subject && !text) return null;
  return { subject: subject || null, text: text || null };
}

/**
 * Land an override on a built email. `built` = {subject, html, text} from the family's
 * own pure builder; `opts` may carry {title, note, replyable, cta} for the branded
 * re-render of an edited body. Returns {subject, html, text, edited}.
 */
function applyOverride(built, override, opts = {}) {
  const o = cleanOverride(override);
  if (!o) return { subject: built.subject, html: built.html, text: built.text, edited: false };
  const subject = o.subject || built.subject;
  if (!o.text || o.text === String(built.text || '').trim()) {
    // Subject-only edit (or a body posted back unchanged): the rich built body stands.
    return { subject, html: built.html, text: built.text, edited: subject !== built.subject };
  }
  // PHYSICAL lines, not only blank-line paragraphs (post-merge audit): template.para()
  // escapes without converting \n, so a paragraph passed whole renders its internal
  // single newlines as collapsed whitespace — every "Label: value" block in a preview
  // body (single-newline separated) became one run-on line in the HTML. Each physical
  // line is its own template line, so the edited body keeps its shape.
  const paras = o.text.split(/\n{2,}/).map((s) => s.trim()).filter(Boolean);
  const firstLines = (paras[0] || '').split('\n').map((s) => s.trim()).filter(Boolean);
  const restLines = paras.slice(1).flatMap((p) => p.split('\n').map((s) => s.trim()).filter(Boolean));
  const r = tpl.render({
    title: opts.title || subject,
    intro: firstLines[0] || '',
    lines: [...firstLines.slice(1), ...restLines],
    replyable: opts.replyable !== false,
    note: opts.note || '',
    cta: opts.cta || null,
  });
  // The subject is OURS verbatim — never the template's derived one.
  return { subject, html: r.html, text: r.text || o.text, edited: true };
}

/** The shape every manual-send preview endpoint answers with. */
function previewShape(built, extra = {}) {
  return { subject: built.subject || '', text: built.text || '', ...extra };
}

module.exports = { cleanOverride, applyOverride, previewShape, _internals: { SUBJECT_MAX, BODY_MAX } };
