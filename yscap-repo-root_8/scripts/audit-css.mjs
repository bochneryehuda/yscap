/* =====================================================================
   THE CSS / LAYOUT AUDIT — every screen, in a real browser, measured
   ---------------------------------------------------------------------
   Reading a stylesheet cannot tell you that a 118-character entity name
   runs out of its card, that a hint is grey-on-grey at 2.9:1, or that two
   tiles in the same row are 40px different in height. Only a laid-out page
   can, because all three are facts about the RENDERED box, not the rule.

   So this loads every screen in the product — the three sign-ins, every
   borrower screen, every /internal screen, the marketing pages and every
   standalone tool — at desktop and phone widths, against the deliberately
   awkward data from `qa-seed-css-audit.js`, and measures:

     · TEXT THAT ESCAPES ITS BOX  (scrollWidth > clientWidth, overflow
       visible) — the value that paints over its neighbour.
     · TEXT SILENTLY CUT          (same, but overflow hidden with no
       ellipsis) — the half address nobody can see is half.
     · THE PAGE SCROLLING SIDEWAYS (documentElement wider than the window)
       — and which element is doing it.
     · UNREADABLE TEXT            (contrast below WCAG AA against the real
       composited background, and anything under 11px).
     · UNEVEN SLOTS               (siblings built from the same class whose
       heights disagree) — the owner's "slots bigger than this other one".
     · TEXT ON TOP OF TEXT        (two text leaves whose boxes overlap).
     · TAP TARGETS under 24px, and any screen that CRASHED rather than
       rendered — a crashed screen has not been audited, and saying so is
       the difference between "clean" and "not looked at".

   Findings land in docs/css-audit/findings.json + report.md, and every
   screen is screenshotted to docs/css-audit/shots/ so a finding can be
   looked at rather than taken on faith.

   Run:  node scripts/audit-css.mjs [--only=substring] [--width=1440]
   ===================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { buildFontCache, serveFonts, FONT_CSS_URLS } from './lib/font-cache.mjs';

const ROOT = '/home/user/yscap/yscap-repo-root_8';
const require = createRequire(ROOT + '/');
const { chromium } = require('/opt/node22/lib/node_modules/playwright');

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://yscap:yscap@127.0.0.1:5432/yscap_t3';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'css-audit-secret';
process.env.NODE_ENV = process.env.NODE_ENV || 'development';

const OUT = path.join(ROOT, 'docs/css-audit');
const SHOTS = path.join(OUT, 'shots');
fs.mkdirSync(SHOTS, { recursive: true });

const argOnly = (process.argv.find((a) => a.startsWith('--only=')) || '').slice(7);
const argWidth = (process.argv.find((a) => a.startsWith('--width=')) || '').slice(8);

// ---------------------------------------------------------------------------
// SEED — the awkward data. Its ids go into the routes below.
// ---------------------------------------------------------------------------
const seed = JSON.parse(execFileSync('node', [path.join(ROOT, 'scripts/qa-seed-css-audit.js')], {
  cwd: ROOT, env: process.env, encoding: 'utf8',
}).trim().split('\n').pop());

// ---------------------------------------------------------------------------
// THE SCREENS. `as` picks which token the browser carries.
// ---------------------------------------------------------------------------
const P = '/portal/#';
const routes = [
  // ---- the sign-ins, and everything reachable without one ----------------
  ['borrower sign-in',            `${P}/login`,            'anon'],
  ['staff sign-in',               `${P}/internal/login`,   'anon'],
  ['assistant sign-in',           `${P}/assistant/login`,  'anon'],
  ['borrower forgot password',    `${P}/forgot`,           'anon'],
  ['staff forgot password',       `${P}/internal/forgot`,  'anon'],
  ['reset password',              `${P}/reset?token=demo`, 'anon'],
  ['verify email',                `${P}/verify?token=demo`,'anon'],
  ['accept invitation',           `${P}/accept?token=demo`,'anon'],
  ['e-sign done',                 `${P}/esign/done`,       'anon'],

  // ---- borrower ----------------------------------------------------------
  ['borrower dashboard',          `${P}/dashboard`,        'borrower'],
  ['borrower tasks',              `${P}/tasks`,            'borrower'],
  ['borrower file',               `${P}/app/${seed.longFile}`, 'borrower'],
  ['borrower apply',              `${P}/apply`,            'borrower'],
  ['borrower profile',            `${P}/profile`,          'borrower'],
  ['borrower helpers',            `${P}/helpers`,          'borrower'],
  ['borrower entities',           `${P}/entities`,         'borrower'],
  ['borrower track record',       `${P}/track-record`,     'borrower'],
  ['borrower pricing',            `${P}/pricing`,          'borrower'],
  ['borrower notifications',      `${P}/settings/notifications`, 'borrower'],

  // ---- staff -------------------------------------------------------------
  ['staff queue',                 `${P}/internal`,                 'staff'],
  ['staff new file',              `${P}/internal/new`,             'staff'],
  ['staff tasks',                 `${P}/internal/tasks`,           'staff'],
  ['staff workflow',              `${P}/internal/workflow`,        'staff'],
  ['staff file',                  `${P}/internal/app/${seed.longFile}`, 'staff'],
  ['staff file draws',            `${P}/internal/app/${seed.longFile}/draws`, 'staff'],
  ['staff team',                  `${P}/internal/team`,            'staff'],
  ['staff conditions studio',     `${P}/internal/conditions`,      'staff'],
  ['staff pricing',               `${P}/internal/pricing`,         'staff'],
  ['staff approvals',             `${P}/internal/approvals`,       'staff'],
  ['staff settings',              `${P}/internal/settings`,        'staff'],
  ['staff AI center',             `${P}/internal/ai`,              'staff'],
  ['staff archived',              `${P}/internal/archived`,        'staff'],
  ['staff leads',                 `${P}/internal/leads`,           'staff'],
  ['staff emails',                `${P}/internal/emails`,          'staff'],
  ['staff orders',                `${P}/internal/orders`,          'staff'],
  ['staff investor suite',        `${P}/internal/investor-suite`,  'staff'],
  ['staff term sheet',            `${P}/internal/term-sheet`,      'staff'],
  ['staff borrowers',             `${P}/internal/borrowers`,       'staff'],
  ['staff borrower detail',       `${P}/internal/borrowers/${seed.borrowerId}`, 'staff'],
  ['staff borrower view',         `${P}/internal/borrower-view`,   'staff'],
  ['staff vendors',               `${P}/internal/vendors`,         'staff'],
  ['staff research',              `${P}/internal/research`,        'staff'],
  ['staff research comps',        `${P}/internal/research/comps`,  'staff'],
  ['staff research market',       `${P}/internal/research/market`, 'staff'],
  ['staff research adjustments',  `${P}/internal/research/adjustments`, 'staff'],
  ['staff research appraisers',   `${P}/internal/research/appraisers`,  'staff'],
  ['staff research quick answer', `${P}/internal/research/quick`,  'staff'],
  ['staff research areas',        `${P}/internal/research/areas`,  'staff'],
  ['staff chat',                  `${P}/internal/chat`,            'staff'],
  ['staff api health',            `${P}/internal/api-health`,      'staff'],
  ['staff pipeline shadow',       `${P}/internal/pipeline-shadow`, 'staff'],
  ['staff clickup',               `${P}/internal/clickup`,         'staff'],
  ['staff draws',                 `${P}/internal/draws`,           'staff'],
  ['staff closing',               `${P}/internal/closing`,         'staff'],
  ['staff purchasing',            `${P}/internal/purchasing`,      'staff'],
  ['staff draw rules',            `${P}/internal/draw-rules`,      'staff'],
  ['staff tapes',                 `${P}/internal/tapes`,           'staff'],
  ['staff audit log',             `${P}/internal/audit`,           'staff'],
  ['staff e-sign',                `${P}/internal/esign`,           'staff'],
  ['staff dashboards',            `${P}/internal/dashboards`,      'staff'],
  ['staff notifications',         `${P}/internal/notifications`,   'staff'],

  // ---- the public site and the standalone tools --------------------------
  ['site home',                   '/',                      'anon'],
  ['site investor suite',         '/suite.html',            'anon'],
  ['site privacy',                '/privacy.html',          'anon'],
  ['site terms',                  '/terms.html',            'anon'],
  ['site disclosures',            '/disclosures.html',      'anon'],
  ['site sms terms',              '/sms-terms.html',        'anon'],
  ['tool deal analyzer',          '/tools/deal-analyzer.html',      'anon'],
  ['tool equity compare',         '/tools/equity-compare.html',     'anon'],
  ['tool flip analyzer',          '/tools/flip-analyzer.html',      'anon'],
  ['tool loan application',       '/tools/loan-application.html',   'anon'],
  ['tool term sheet studio',      '/tools/term-sheet.html',         'anon'],
  ['tool portfolio tracker',      '/tools/portfolio-tracker.html',  'anon'],
  ['tool qualifier pro',          '/tools/qualifier-pro.html',      'anon'],
  ['tool ratesaver',              '/tools/ratesaver.html',          'anon'],
  ['tool refi breakpoint',        '/tools/refi-breakpoint.html',    'anon'],
  ['tool rehab budget',           '/tools/rehab-budget.html',       'anon'],
  ['tool term sheet',             '/tools/term-sheet.html',         'anon'],
  ['tool track record',           '/tools/track-record.html',       'anon'],
  ['design system',               '/design-system/',                'anon'],
].filter((r) => !argOnly || (r[0] + r[1]).toLowerCase().includes(argOnly.toLowerCase()));

const VIEWPORTS = (argWidth
  ? [{ name: `w${argWidth}`, width: Number(argWidth), height: 900 }]
  : [
      { name: 'desktop', width: 1440, height: 900 },
      { name: 'laptop', width: 1280, height: 800 },
      { name: 'phone', width: 390, height: 844 },
    ]);

// ===========================================================================
// THE MEASUREMENT. Runs inside the page.
// ===========================================================================
function domAudit(opts) {
  const scrolledPass = !!(opts && opts.scrolled);
  const vw = window.innerWidth;
  const findings = [];
  const add = (kind, severity, el, detail, extra) => findings.push({
    kind, severity, sel: sel(el), text: textOf(el), detail, ...(extra || {}),
  });

  const sel = (el) => {
    const bits = [];
    let n = el, depth = 0;
    while (n && n.nodeType === 1 && depth++ < 4) {
      let s = n.tagName.toLowerCase();
      if (n.id) { s += '#' + n.id; bits.unshift(s); break; }
      const cls = (typeof n.className === 'string' ? n.className : '').trim();
      if (cls) s += '.' + cls.split(/\s+/).slice(0, 3).join('.');
      bits.unshift(s);
      n = n.parentElement;
    }
    return bits.join(' > ');
  };
  const textOf = (el) => (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 90);

  const els = Array.from(document.querySelectorAll('body *'));
  const info = new Map();
  for (const el of els) {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;
    if (parseFloat(cs.opacity) < 0.06) continue;
    // The content of a CLOSED <details> is still in the DOM, is not
    // `display:none`, and reports its parent's rect — so every collapsed FAQ
    // answer piles onto the same coordinates and reads as a pile of colliding
    // text. `checkVisibility` is the browser's own answer to "would the user
    // see this", and it covers content-visibility and closed <details> that
    // the display/visibility/opacity tests above cannot.
    if (typeof el.checkVisibility === 'function'
      && !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true, contentVisibilityAuto: true })) continue;
    info.set(el, { cs, r });
  }

  // ---- 1/2/3. content that does not fit its box ---------------------------
  for (const [el, { cs, r }] of info) {
    const over = el.scrollWidth - el.clientWidth;
    if (over <= 2 || el.clientWidth <= 0) continue;
    // A box that is MEANT to scroll is not a defect.
    if (/(auto|scroll)/.test(cs.overflowX)) continue;
    // A <select>/<input> reports its own intrinsic width; not a layout escape.
    if (/^(select|input|textarea|img|svg|canvas|iframe)$/i.test(el.tagName)) continue;
    const hasOwnText = Array.from(el.childNodes)
      .some((n) => n.nodeType === 3 && n.textContent.trim().length > 1);
    // A CLOSED tooltip/popover is absolutely positioned and hidden, but it is
    // still laid out — so it inflates its ancestor's scrollWidth without a
    // single pixel of text being anywhere near the edge of the box. Measuring
    // that as "text escapes the box" describes a bubble nobody can see. (The
    // page-level `overflow-x:clip` guard is what stops such a bubble widening
    // the layout viewport, and this audit confirms it works: no screen at any
    // width scrolls sideways.)
    const hasClosedPopover = Array.from(el.querySelectorAll('*')).some((d) => {
      if (d === el) return false;
      const ds = getComputedStyle(d);
      return /(absolute|fixed)/.test(ds.position)
        && (ds.visibility === 'hidden' || parseFloat(ds.opacity) < 0.06 || ds.display === 'none');
    });
    if (hasClosedPopover) continue;
    if (/(hidden|clip)/.test(cs.overflowX)) {
      // Ellipsis is a deliberate, VISIBLE truncation. A hard cut is not.
      if (cs.textOverflow === 'ellipsis') {
        if (hasOwnText) add('ellipsized', 'info', el, `${over}px past its box (…)`, { over });
      } else {
        add('clipped', 'high', el, `${over}px of content cut off with no ellipsis`, { over });
      }
    } else if (hasOwnText) {
      add('spill', 'high', el, `${over}px of text escapes the box (overflow visible)`, { over });
    }
  }

  // ---- 4. the page itself scrolling sideways ------------------------------
  const docOver = document.documentElement.scrollWidth - vw;
  if (docOver > 2) {
    const blame = [];
    for (const [el, { r }] of info) {
      if (r.right > vw + 2 && r.width < vw * 3) blame.push({ el, past: Math.round(r.right - vw) });
    }
    blame.sort((a, b) => b.past - a.past);
    // Report the widest few — the innermost offender is the real cause, its
    // ancestors are just carrying it.
    for (const b of blame.slice(0, 4)) {
      add('page-overflow', 'high', b.el, `sticks ${b.past}px past the right edge (page scrolls sideways by ${Math.round(docOver)}px)`, { over: b.past });
    }
    if (!blame.length) findings.push({ kind: 'page-overflow', severity: 'high', sel: 'html', text: '', detail: `page scrolls sideways by ${Math.round(docOver)}px`, over: Math.round(docOver) });
  }

  // ---- 5. contrast + tiny text -------------------------------------------
  const parse = (c) => {
    const m = /rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/.exec(c || '');
    return m ? { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] } : null;
  };
  const over = (fg, bg) => ({
    r: fg.r * fg.a + bg.r * (1 - fg.a),
    g: fg.g * fg.a + bg.g * (1 - fg.a),
    b: fg.b * fg.a + bg.b * (1 - fg.a), a: 1,
  });
  const lum = (c) => {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
  };
  const ratio = (a, b) => { const l1 = lum(a), l2 = lum(b); const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1]; return (hi + 0.05) / (lo + 0.05); };
  const bgOf = (el) => {
    let n = el, acc = null, guard = 0;
    while (n && n.nodeType === 1 && guard++ < 40) {
      const cs = info.get(n)?.cs || getComputedStyle(n);
      if (cs.backgroundImage && cs.backgroundImage !== 'none') return null;   // unknowable
      const c = parse(cs.backgroundColor);
      if (c && c.a > 0) { acc = acc ? over(acc, c) : c; if (acc.a >= 1 || c.a >= 1) return acc; }
      n = n.parentElement;
    }
    return acc && acc.a >= 1 ? acc : { r: 255, g: 255, b: 255, a: 1 };
  };

  for (const [el, { cs, r }] of info) {
    const own = Array.from(el.childNodes)
      .filter((n) => n.nodeType === 3 && n.textContent.trim().length > 1);
    if (!own.length) continue;
    const size = parseFloat(cs.fontSize);
    const weight = Number(cs.fontWeight) || 400;
    if (size && size < 11) add('tiny-text', 'medium', el, `${size}px text`, { size });

    const fg = parse(cs.color);
    const bg = bgOf(el);
    if (!fg || !bg || fg.a === 0) continue;
    const composited = fg.a < 1 ? over(fg, bg) : fg;
    const cr = ratio(composited, bg);
    const large = size >= 24 || (size >= 18.66 && weight >= 700);
    const need = large ? 3 : 4.5;
    if (cr < need) {
      add(cr < need - 1.2 ? 'contrast' : 'contrast-near', cr < 2.2 ? 'high' : 'medium', el,
        `${cr.toFixed(2)}:1 (needs ${need}:1) — ${cs.color} on rgb(${Math.round(bg.r)},${Math.round(bg.g)},${Math.round(bg.b)}) at ${size}px`,
        { ratio: +cr.toFixed(2), need, size });
    }
  }

  // ---- 6. siblings that should match and don't ----------------------------
  const byParent = new Map();
  for (const [el, { r }] of info) {
    const p = el.parentElement;
    if (!p) continue;
    const cls = (typeof el.className === 'string' ? el.className : '').trim();
    if (!cls) continue;
    const key = p;
    if (!byParent.has(key)) byParent.set(key, new Map());
    const m = byParent.get(key);
    if (!m.has(cls)) m.set(cls, []);
    m.get(cls).push({ el, r });
  }
  for (const [parent, m] of byParent) {
    for (const [cls, list] of m) {
      if (list.length < 2) continue;
      // Only rows/tiles laid out SIDE BY SIDE are expected to match in height;
      // a stacked list legitimately has rows of different heights.
      const sameRow = list.filter((x) => Math.abs(x.r.top - list[0].r.top) < 4);
      if (sameRow.length < 2) continue;
      const hs = sameRow.map((x) => x.r.height);
      const min = Math.min(...hs), max = Math.max(...hs);
      if (max - min > 8 && max - min > min * 0.12) {
        add('uneven-slots', 'medium', sameRow[0].el,
          `${sameRow.length} side-by-side .${cls.split(/\s+/)[0]} in one row differ in height: ${Math.round(min)}px vs ${Math.round(max)}px`,
          { min: Math.round(min), max: Math.round(max) });
      }
    }
  }

  // ---- 7. text drawn on top of text --------------------------------------
  // TWO ELEMENTS OVERLAPPING IS ONLY A BUG WITHIN ONE STACKING CONTEXT.
  // A tool sheet, a modal, a dropdown or a popover is DRAWN OVER the page on
  // purpose — its text and the page's text overlap by design, and reporting
  // that is noise that buries the real collisions. So each text leaf is keyed
  // by the nearest ancestor that creates a stacking context; a pair from two
  // different contexts is layering, and only a pair from the SAME one is a
  // collision. (Checking the leaf's own `position` is not enough — the leaf
  // inside an overlay is nearly always statically positioned itself.)
  const makesStackingContext = (el, cs) => {
    if (cs.position === 'fixed' || cs.position === 'sticky') return true;
    if (cs.position !== 'static' && cs.zIndex !== 'auto') return true;
    if (parseFloat(cs.opacity) < 1) return true;
    if (cs.transform !== 'none' || cs.filter !== 'none' || cs.perspective !== 'none') return true;
    if (cs.isolation === 'isolate' || cs.mixBlendMode !== 'normal') return true;
    if (cs.contain && /paint|layout|strict|content/.test(cs.contain)) return true;
    if (cs.willChange && /transform|opacity|filter/.test(cs.willChange)) return true;
    return false;
  };
  const stackCache = new Map();
  const stackRoot = (el) => {
    if (stackCache.has(el)) return stackCache.get(el);
    let n = el.parentElement, root = null, guard = 0;
    while (n && n.nodeType === 1 && guard++ < 60) {
      const cs = info.get(n)?.cs || getComputedStyle(n);
      if (makesStackingContext(n, cs)) { root = n; break; }
      n = n.parentElement;
    }
    stackCache.set(el, root);
    return root;
  };

  const leaves = [];
  for (const [el, { cs, r }] of info) {
    const own = Array.from(el.childNodes).filter((n) => n.nodeType === 3 && n.textContent.trim().length > 1);
    if (!own.length) continue;
    if (r.width < 8 || r.height < 6) continue;
    leaves.push({ el, r, cs });
    if (leaves.length > 500) break;
  }
  const seen = new Set();
  for (let i = 0; i < leaves.length; i++) {
    for (let j = i + 1; j < leaves.length; j++) {
      const A = leaves[i], B = leaves[j];
      if (A.el.contains(B.el) || B.el.contains(A.el)) continue;
      const w = Math.min(A.r.right, B.r.right) - Math.max(A.r.left, B.r.left);
      const h = Math.min(A.r.bottom, B.r.bottom) - Math.max(A.r.top, B.r.top);
      if (w <= 1 || h <= 1) continue;
      const inter = w * h;
      const small = Math.min(A.r.width * A.r.height, B.r.width * B.r.height);
      if (inter < small * 0.35) continue;
      if (stackRoot(A.el) !== stackRoot(B.el)) continue;   // layered, not collided
      // A leaf that is itself lifted out of the flow over its neighbour is a
      // deliberate badge/tooltip, not a collision.
      if ([A, B].some((x) => /(absolute|fixed)/.test(x.cs.position))) continue;
      const key = sel(A.el) + '|' + sel(B.el);
      if (seen.has(key)) continue;
      seen.add(key);
      add('overlap', 'high', A.el, `overlaps "${textOf(B.el).slice(0, 40)}" (${sel(B.el)}) by ${Math.round(inter / small * 100)}%`);
      if (seen.size > 25) break;
    }
    if (seen.size > 25) break;
  }

  // ---- 8. tap targets -----------------------------------------------------
  for (const [el, { r, cs }] of info) {
    if (!/^(button|a)$/i.test(el.tagName) && el.getAttribute('role') !== 'button') continue;
    if (!(el.textContent || '').trim() && !el.querySelector('svg,img')) continue;
    if (cs.display === 'inline') continue;              // a link inside a paragraph
    if (r.height < 24 || r.width < 24) {
      add('tap-target', 'low', el, `${Math.round(r.width)}×${Math.round(r.height)}px (min 24×24)`);
    }
  }

  // ---- 9. a form control under 16px makes iOS Safari zoom the page ---------
  // Documented in CLAUDE.md: every field focus on a phone zooms the whole
  // screen if the control's text is smaller than 16px.
  if (vw <= 720) {
    for (const [el, { cs, r }] of info) {
      if (!/^(input|select|textarea)$/i.test(el.tagName)) continue;
      if (/^(checkbox|radio|hidden|range|color)$/i.test(el.getAttribute('type') || '')) continue;
      const size = parseFloat(cs.fontSize);
      if (size && size < 16) add('ios-zoom-field', 'medium', el, `${size}px control — iOS zooms the page on focus (needs 16px)`, { size });
    }
  }

  // ---- 10. text something is PAINTED OVER --------------------------------
  // The layering question, asked the only way that actually answers it: is
  // the text the topmost thing at its own coordinates? A floating chat
  // button, a sticky bar or a badge sitting over a value is invisible to a
  // box-overlap test (it lives in its own stacking context, which is exactly
  // why rule 7 skips it) but it is precisely what "is it layered correctly"
  // means. Three samples across the line, two must be blocked, so an element
  // merely clipping one edge is not reported.
  const vh = window.innerHeight;
  for (const { el } of leaves) {
    const rect = el.getClientRects()[0];
    if (!rect || rect.width < 6 || rect.height < 6) continue;
    const y = rect.top + rect.height / 2;
    if (y < 1 || y > vh - 2) continue;                    // outside the viewport
    let blocker = null, blocked = 0;
    for (const fx of [0.15, 0.5, 0.85]) {
      const x = rect.left + rect.width * fx;
      if (x < 1 || x > vw - 2) continue;
      const top = document.elementFromPoint(x, y);
      if (!top || top === el || el.contains(top) || top.contains(el)) continue;
      blocker = top; blocked++;
    }
    if (blocked < 2 || !blocker) continue;
    // WHO is doing the covering decides whether this is a defect.
    // A sticky/fixed overlay (a pinned sidebar footer, a floating chat
    // button, a sticky bar) covers text only until the reader scrolls — it is
    // worth SEEING, but it is not broken layout, and the staff sidebar's
    // pinned footer is there by explicit owner direction. An IN-FLOW element
    // painted over text cannot be scrolled apart: that is a real collision.
    let n = blocker, chrome = false, guard = 0;
    while (n && n.nodeType === 1 && guard++ < 20) {
      const p = (info.get(n)?.cs || getComputedStyle(n)).position;
      if (p === 'fixed' || p === 'sticky') { chrome = true; break; }
      n = n.parentElement;
    }
    if (chrome) {
      // On the scrolled pass this is just "content passed under the bar".
      if (!scrolledPass) {
        add('covered-by-overlay', 'low', el, `sits under ${sel(blocker)} until you scroll — check it is not the only place this value shows`);
      }
      continue;
    }
    add('covered-text', 'high', el, `painted over by ${sel(blocker)} — nothing can scroll them apart`);
  }

  const crashed = /Something went wrong/i.test(document.body.innerText || '');
  return { findings, crashed, docOver: Math.round(docOver), count: info.size, innerWidth: vw };
}

// ===========================================================================
// DRIVE IT
// ===========================================================================
const db = require(ROOT + '/src/db');
const app = require(ROOT + '/src/server');

const all = [];
let crashes = 0, visited = 0;

const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
const base = `http://127.0.0.1:${server.address().port}`;
console.log(`server on ${base}`);

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });

// The REAL typefaces, or the audit is measuring a page nobody sees.
const fonts = buildFontCache(FONT_CSS_URLS, path.join(OUT, '.fontcache'));
if (!fonts) console.log('WARNING: rendering in fallback faces — widths below are NOT production widths');

for (const vp of VIEWPORTS) {
  const ctx = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    serviceWorkers: 'block',
    deviceScaleFactor: 1,
  });
  await serveFonts(ctx, fonts);
  // Outside calls never leave this box; a screen must not be judged on a
  // network timeout it would never have in production. Aborted rather than
  // left to hang — a stalled tile request is not a layout defect.
  for (const host of ['maps.googleapis.com', '*.tile.openstreetmap.org', 'nominatim.openstreetmap.org',
    'maps.gstatic.com', 'www.google-analytics.com', 'cdn.jsdelivr.net', 'unpkg.com']) {
    await ctx.route(`**://${host}/**`, (r) => r.abort());
  }

  for (const [name, url, as] of routes) {
    const token = as === 'staff' ? seed.staffToken : as === 'borrower' ? seed.borrowerToken : null;
    const page = await ctx.newPage();
    const consoleErrors = [];
    page.on('pageerror', (e) => consoleErrors.push(String(e).slice(0, 200)));
    page.on('console', (m) => {
      if (m.type() === 'error' && !/net::ERR_|Failed to load resource/.test(m.text())) {
        consoleErrors.push(m.text().slice(0, 200));
      }
    });
    await page.addInitScript((t) => {
      try {
        if (t) localStorage.setItem('ys_portal_token', t); else localStorage.removeItem('ys_portal_token');
      } catch {}
    }, token);

    const slug = `${name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}--${vp.name}`;
    try {
      await page.goto(base + url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(1800);                       // data + render settle
      // Measuring before the real faces are applied measures the fallback
      // font's widths, which is the one thing this audit must not do.
      await page.evaluate(() => document.fonts && document.fonts.ready).catch(() => {});
      await page.waitForTimeout(250);
      const res = await page.evaluate(domAudit, { scrolled: false });
      visited++;
      // A FIXED overlay covers whatever scrolls under it, so the top of the
      // page is the one place it is least likely to be caught. Re-ask the
      // layering question once further down; keep only that answer.
      const scrolled = await page.evaluate(() => {
        const y = Math.min(document.documentElement.scrollHeight - window.innerHeight, window.innerHeight * 1.6);
        if (y > 40) { window.scrollTo(0, y); return true; }
        return false;
      });
      if (scrolled) {
        await page.waitForTimeout(350);
        const more = await page.evaluate(domAudit, { scrolled: true });
        const seenSel = new Set(res.findings.filter((f) => f.kind === 'covered-text').map((f) => f.sel));
        for (const f of more.findings) {
          if (f.kind !== 'covered-text' || seenSel.has(f.sel)) continue;
          res.findings.push(f); seenSel.add(f.sel);
        }
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.waitForTimeout(120);
      }
      if (res.crashed) crashes++;
      await page.screenshot({ path: path.join(SHOTS, slug + '.png'), fullPage: true })
        .catch(() => page.screenshot({ path: path.join(SHOTS, slug + '.png') }));
      for (const f of res.findings) all.push({ ...f, screen: name, url, viewport: vp.name, width: vp.width, shot: slug + '.png' });
      // The documented mobile trap: one phantom overflow widens the LAYOUT
      // viewport, every max-width rule stops applying and the phone renders
      // the desktop layout zoomed out. `innerWidth` is the only honest tell.
      if (res.innerWidth !== vp.width) {
        all.push({ kind: 'viewport-blowup', severity: 'high', screen: name, url, viewport: vp.name, width: vp.width, sel: 'html', text: '', detail: `layout viewport is ${res.innerWidth}px on a ${vp.width}px screen — the phone breakpoints are switched OFF and the page renders zoomed out`, shot: slug + '.png' });
      }
      if (res.crashed) all.push({ kind: 'crash', severity: 'high', screen: name, url, viewport: vp.name, width: vp.width, sel: 'body', text: '', detail: 'screen rendered the ErrorBoundary instead of itself — NOT audited', shot: slug + '.png' });
      const bad = res.findings.filter((f) => f.severity === 'high').length;
      console.log(`${res.crashed ? 'CRASH' : '  ok '} ${vp.name.padEnd(7)} ${name.padEnd(30)} ${String(res.findings.length).padStart(3)} findings (${bad} high)${res.docOver > 2 ? `  ←sideways ${res.docOver}px` : ''}`);
    } catch (e) {
      console.log(` FAIL ${vp.name.padEnd(7)} ${name.padEnd(30)} ${String(e).slice(0, 90)}`);
      all.push({ kind: 'load-failure', severity: 'high', screen: name, url, viewport: vp.name, width: vp.width, sel: '', text: '', detail: String(e).slice(0, 200), shot: null });
    }
    if (consoleErrors.length) {
      all.push({ kind: 'console-error', severity: 'low', screen: name, url, viewport: vp.name, width: vp.width, sel: '', text: '', detail: consoleErrors.slice(0, 3).join(' | '), shot: slug + '.png' });
    }
    await page.close();
  }
  await ctx.close();
}

await browser.close();
server.close();
await db.pool.end().catch(() => {});

// ---------------------------------------------------------------------------
// REPORT
// ---------------------------------------------------------------------------
fs.writeFileSync(path.join(OUT, 'findings.json'), JSON.stringify(all, null, 1));

const byKind = {};
for (const f of all) (byKind[f.kind] ||= []).push(f);
const order = ['crash', 'load-failure', 'viewport-blowup', 'page-overflow', 'spill', 'clipped', 'covered-text', 'overlap', 'contrast', 'contrast-near', 'tiny-text', 'ios-zoom-field', 'uneven-slots', 'covered-by-overlay', 'ellipsized', 'tap-target', 'console-error'];

let md = `# CSS / layout audit\n\n`;
md += `${visited} screen-loads across ${VIEWPORTS.length} widths (${VIEWPORTS.map((v) => v.width).join(', ')}px), `;
md += `${routes.length} screens. **${all.length} findings**, ${all.filter((f) => f.severity === 'high').length} high.\n\n`;
md += `| what | count | screens |\n|---|---:|---:|\n`;
for (const k of order) {
  if (!byKind[k]) continue;
  md += `| ${k} | ${byKind[k].length} | ${new Set(byKind[k].map((f) => f.screen)).size} |\n`;
}
for (const k of order) {
  if (!byKind[k]) continue;
  md += `\n## ${k} (${byKind[k].length})\n\n`;
  const byScreen = {};
  for (const f of byKind[k]) (byScreen[f.screen] ||= []).push(f);
  for (const [screen, list] of Object.entries(byScreen)) {
    md += `\n**${screen}** — ${[...new Set(list.map((f) => f.viewport))].join(', ')}\n\n`;
    for (const f of list.slice(0, 8)) {
      md += `- \`${f.sel}\` ${f.detail}${f.text ? `\n  > ${f.text}` : ''}\n`;
    }
    if (list.length > 8) md += `- …and ${list.length - 8} more\n`;
  }
}
fs.writeFileSync(path.join(OUT, 'report.md'), md);

console.log(`\n${all.length} findings (${all.filter((f) => f.severity === 'high').length} high), ${crashes} crashed screens`);
console.log(`→ docs/css-audit/report.md, findings.json, shots/`);
for (const k of order) if (byKind[k]) console.log(`   ${k.padEnd(16)} ${byKind[k].length}`);
process.exit(0);
