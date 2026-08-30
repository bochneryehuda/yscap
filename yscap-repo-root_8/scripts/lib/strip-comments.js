'use strict';
/**
 * STRIP COMMENTS FROM JAVASCRIPT SOURCE — the ONE definition, for every source guard.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 *
 * A source guard proves a rule by reading the code, and it must read the CODE —
 * a rule's own explanation necessarily NAMES the thing the rule forbids, so a
 * guard that reads comments fails on its own explanation and then gets "fixed"
 * by deleting the explanation. Every one of these guards therefore strips
 * comments first, and 103 of them grew the same two-line regex to do it:
 *
 *     src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
 *
 * THAT IDIOM IS WRONG IN A WAY THAT IS SILENT IN BOTH DIRECTIONS, and it bit for
 * real on 2026-08-30. It strips BLOCK comments FIRST, so it cannot know that a
 * `/*` it found is sitting inside a LINE comment or inside a STRING. Line 3 of
 * `app-v2/src/longterm/api.js` reads:
 *
 *     // Every call goes to /api/lt/*, through Long-Term's own fetch helper …
 *
 * — prose, containing `/*`. For as long as that file held no `*` `/` anywhere,
 * the block regex matched nothing and every guard over it was correct BY LUCK.
 * The moment a genuine block comment was added 282 lines later, that stray `/*`
 * opened a "block comment" which ran to the new closing `*` `/` and ate 19,048 of
 * the file's 20,012 characters — so `clickupStatusReviews`, which is plainly in
 * the file, read as ABSENT and its guard failed.
 *
 * THE OTHER DIRECTION IS WORSE AND IS WHY THIS IS A SHARED MODULE RATHER THAN A
 * ONE-LINE PATCH: an assertion of the shape "X must NOT appear" PASSES over a
 * file the stripper swallowed. A guard reporting a clean bill of health on a
 * file it never actually read is the confident wrong answer this repo's rules
 * exist to prevent, and nothing about it is visible in a green build.
 *
 * ── HOW IT WORKS ────────────────────────────────────────────────────────────
 *
 * One left-to-right pass with a state machine, which is the only way to answer
 * "is this `/*` a comment?" — the question is not decidable by a regex, because
 * it depends on everything to the left. States: code, line comment, block
 * comment, the three string forms, and a regex literal.
 *
 * NEWLINES INSIDE A COMMENT ARE KEPT. The old idiom deleted them, which silently
 * joined the line above a block comment to the line below it — so a guard using
 * `^`/`$` with the `m` flag matched across a join that does not exist in the
 * file. Keeping them means the output has the same line count and the same line
 * numbers as the input, so a line-oriented assertion means what it says.
 *
 * A TEMPLATE LITERAL'S `${…}` IS CODE, and is scanned as such — a comment inside
 * one is a real comment, and a `//` inside the literal TEXT is not. Brace depth
 * is tracked so a nested object or a nested template closes at the right place.
 *
 * A REGEX LITERAL is recognised conservatively, from the previous significant
 * character: a `/` can only begin one where a value cannot already have ended.
 * The failure this guards against is a regex such as `/[//]/`, whose `//` would
 * otherwise read as a line comment and delete the rest of the line. Where the
 * heuristic is unsure it reads the `/` as DIVISION, which is the safe way to be
 * wrong: division leaves the text alone, and a mistaken regex would eat it.
 *
 * PURE. No requires, no filesystem, no configuration.
 */

/** The characters after which a `/` starts a REGEX rather than a division. Each
    one is a position where no value has been produced yet, so division would be a
    syntax error and only a regex can be meant. `)` and `]` are deliberately absent
    — `(a + b) / 2` and `xs[0] / 2` are division, which is the common case, and
    `if (x) /re/.test(y)` is not written in this codebase. */
const REGEX_MAY_FOLLOW = new Set([
  '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '~', '^', '<', '>', '\n',
]);

/** Keywords after which a `/` is a regex — `return /x/` is not a division. */
const REGEX_KEYWORDS = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void',
  'throw', 'case', 'do', 'else', 'yield', 'await',
]);

/** Does a `/` at `i` begin a regex literal? Looks LEFT past whitespace at the
    last significant character, then at the word it may be the tail of. */
function startsRegex(src, i) {
  let j = i - 1;
  while (j >= 0 && (src[j] === ' ' || src[j] === '\t')) j -= 1;
  if (j < 0) return true;                       // a regex at the very start of the file
  const ch = src[j];
  if (REGEX_MAY_FOLLOW.has(ch)) return true;
  if (!/[A-Za-z0-9_$]/.test(ch)) return false;  // some other punctuation — division
  let k = j;
  while (k >= 0 && /[A-Za-z0-9_$]/.test(src[k])) k -= 1;
  return REGEX_KEYWORDS.has(src.slice(k + 1, j + 1));
}

/**
 * Return `src` with every comment removed and everything else — strings,
 * template literals, regex literals and their contents — left byte for byte.
 * Newlines inside a comment are preserved, so line numbers do not move.
 */
function stripComments(src) {
  const s = String(src == null ? '' : src);
  let out = '';
  let i = 0;
  // The brace depth of each template literal we are inside, innermost last. An
  // entry is pushed on `` ` `` and consulted on `}` to know whether that brace
  // closes a `${…}` and hands us back to the literal's text.
  const templates = [];

  while (i < s.length) {
    const c = s[i];
    const d = s[i + 1];

    // ── the TEXT of a template literal, asked FIRST ─────────────────────────
    // Nothing in here is a comment or a string: `` `see //example` `` is text.
    // This must be decided BEFORE the comment tests below, or a `//` or a `/*`
    // in an interpolated URL deletes the rest of the literal.
    if (templates.length && templates[templates.length - 1] === 0) {
      if (c === '\\') { out += c + (s[i + 1] || ''); i += 2; continue; }
      if (c === '`') { out += c; i += 1; templates.pop(); continue; }
      if (c === '$' && d === '{') {
        out += '${'; i += 2; templates[templates.length - 1] += 1; continue;
      }
      out += c; i += 1; continue;
    }

    // ── a comment ───────────────────────────────────────────────────────────
    if (c === '/' && d === '/') {
      i += 2;
      while (i < s.length && s[i] !== '\n') i += 1;
      continue;                                   // the '\n' itself is copied next pass
    }
    if (c === '/' && d === '*') {
      i += 2;
      while (i < s.length && !(s[i] === '*' && s[i + 1] === '/')) {
        if (s[i] === '\n') out += '\n';           // keep the line count honest
        i += 1;
      }
      i += 2;                                     // past the closing '*' '/'
      continue;
    }

    // ── a string ────────────────────────────────────────────────────────────
    if (c === "'" || c === '"') {
      out += c; i += 1;
      while (i < s.length) {
        if (s[i] === '\\') { out += s[i] + (s[i + 1] || ''); i += 2; continue; }
        out += s[i];
        if (s[i] === c || s[i] === '\n') { i += 1; break; }   // a newline ends it too: unterminated
        i += 1;
      }
      continue;
    }

    // ── a template literal ──────────────────────────────────────────────────
    if (c === '`') { out += c; i += 1; templates.push(0); continue; }
    if (templates.length && c === '}') {
      out += c; i += 1; templates[templates.length - 1] -= 1; continue;
    }
    if (templates.length && c === '{') {
      out += c; i += 1; templates[templates.length - 1] += 1; continue;
    }

    // ── a regex literal ─────────────────────────────────────────────────────
    if (c === '/' && startsRegex(s, i)) {
      out += c; i += 1;
      let inClass = false;
      while (i < s.length) {
        const r = s[i];
        if (r === '\\') { out += r + (s[i + 1] || ''); i += 2; continue; }
        if (r === '\n') break;                    // unterminated — not a regex after all
        out += r; i += 1;
        if (r === '[') inClass = true;
        else if (r === ']') inClass = false;
        else if (r === '/' && !inClass) break;
      }
      continue;
    }

    out += c; i += 1;
  }

  return out;
}

/** The same source with every run of whitespace collapsed to one space — for an
    assertion about WORDING, which JSX wraps at whatever column it lands on. */
function stripToProse(src) {
  return stripComments(src).replace(/\s+/g, ' ');
}

module.exports = { stripComments, stripToProse, _internals: { startsRegex } };
