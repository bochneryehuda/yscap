/* =====================================================================
   PILOT · YS CAPITAL — BRANDED EMAIL TEMPLATE
   Renders one branded HTML email (+ a clean plaintext fallback) from a
   small structured payload. Pure function, no I/O — notify.js feeds it.

   Design (owner-directed 2026-07-14): the new brand is LIGHT everywhere,
   so the email matches the site — a warm Paper canvas, a white card, a
   PILOT Gold hairline, muted-teal accents and ink text. The header is the
   exact site top-left lockup (gold navigation-chevron mark + "PILOT" in
   Fraunces + a quiet "by YS Capital"), shipped as an image so the real
   pilot font renders in clients that strip web fonts. Built with tables +
   inline styles only (no <style> blocks, no web fonts) so it renders
   identically in Outlook, Gmail, Apple Mail and mobile. The regulated
   YS Capital entity + NMLS stays in the footer.
   ===================================================================== */
'use strict';

// The header lockup image URL is resolved from config (env-driven) but the
// module stays safe to require in isolation — fall back to a bulletproof text
// lockup (no image) if config can't load or the image is unset/blocked.
var LOGO_URL = '';
try { LOGO_URL = require('../../config').emailLogoUrl || ''; } catch (e) { LOGO_URL = ''; }

// PILOT palette — LIGHT / white-first (owner-directed 2026-07-14), 1:1 with the
// site portal tokens (app-v2/src/styles.css): Paper canvas, white card, PILOT
// Gold hairline, PILOT Teal accent, ink text. Links use the deeper teal so small
// text clears WCAG AA on white.
var BRAND = {
  paper:  '#F6F3EC',   // page canvas (PILOT Paper / --ink)
  card:   '#FFFFFF',   // card surface (--ink-1)
  soft:   '#F4F1EA',   // soft chip surface (meta / files / code) (--ink-2)
  line:   '#D9D4C8',   // hairline / borders (--line)
  teal:   '#2F7F86',   // PILOT Teal accent / button bg (--teal)
  tealDk: '#256168',   // deeper teal for link text on white (--teal-br)
  gold:   '#AE8746',   // PILOT Gold hairline / mark (--gold)
  ink:    '#141B22',   // primary text — headings + body (--text)
  muted:  '#4B585C',   // secondary text (--text-muted)
  soft2:  '#7A8285',   // softest text — fine print (--text-soft)
  onAcc:  '#FFFFFF'    // text on the teal button
};

var COMPANY = {
  name: 'YS Capital Group',
  nmls: '2609746',
  addr: 'Brooklyn, NY',
  phone: '718-831-2168',
  email: 'sales@yscapgroup.com',
  site: 'https://yscapgroup.com'
};

// Semantic state tones for pills / hero bands / callouts. Each is a soft tinted
// ground + an AA-legible foreground, derived from the PILOT hues (gold/teal) and
// two quiet status hues (a deep pine for positive, a clay for action) that sit in
// the same warm family — NOT new brand colors. `bar` is the saturated accent.
var TONE = {
  gold:    { bg: '#F4EAD5', fg: '#6E521C', bar: '#AE8746' },
  teal:    { bg: '#DFEDEE', fg: '#1E565B', bar: '#2F7F86' },
  positive:{ bg: '#E1EEE5', fg: '#2A6244', bar: '#3B7D57' },   // pine — funded / cleared / accepted
  action:  { bg: '#F5E4DB', fg: '#8A3A22', bar: '#B24A2B' },   // clay — needs the reader to act
  neutral: { bg: '#F1EDE4', fg: '#4B585C', bar: '#7A8285' }
};
function tone(name) { return TONE[name] || TONE.teal; }

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/* Header brand block — the PILOT co-brand lockup (owner-directed): the exact
   site top-left lockup as an image (gold navigation-chevron mark + "PILOT" in
   the real Fraunces face + a quiet "by YS Capital"), baked onto white so it sits
   seamlessly on the white header cell and stays readable even if a client
   force-inverts a light email. If the image URL is unset/blocked, fall back to a
   bulletproof text lockup (Georgia serif "PILOT" + "by YS Capital") so the
   header is never empty. The regulated YS Capital entity + NMLS lives in the
   footer. */
function brandHeader() {
  if (LOGO_URL) {
    return '' +
      '<img src="' + esc(LOGO_URL) + '" alt="PILOT by YS Capital" width="200" height="66" ' +
        'style="display:block;width:200px;height:66px;border:0;outline:none;text-decoration:none;" />';
  }
  // Text fallback (no image): ink "PILOT" wordmark + quiet "by YS Capital".
  return '' +
    '<table role="presentation" cellpadding="0" cellspacing="0"><tr>' +
      '<td style="vertical-align:middle;padding-right:12px;">' +
        '<div style="font-family:Georgia,\'Times New Roman\',serif;font-size:16px;color:' + BRAND.gold + ';line-height:1;">&#9650;</div>' +
      '</td>' +
      '<td style="vertical-align:middle;">' +
        '<div style="font-family:Georgia,\'Times New Roman\',serif;font-size:23px;' +
          'letter-spacing:4px;color:' + BRAND.ink + ';font-weight:700;line-height:1;">PILOT</div>' +
        '<div style="font-family:Arial,Helvetica,sans-serif;font-size:10.5px;letter-spacing:1.5px;' +
          'color:' + BRAND.muted + ';text-transform:uppercase;margin-top:5px;">by YS Capital</div>' +
      '</td>' +
    '</tr></table>';
}

/**
 * render({ title, subjectTag, kicker, preheader, greeting, intro, lines[],
 *          meta[{label,value}], cta{label,url}, note, replyable, audience })
 *   -> { subject, html, text }
 *
 * subjectTag  — a short file identifier (e.g. "YS-1042 · 123 Main St") appended
 *               to the SUBJECT line (never to the in-body H1) so the recipient
 *               sees WHICH file the email is about straight from their inbox.
 * kicker      — a small upper-case category label rendered above the H1
 *               (e.g. "DOCUMENT REJECTED", "STATUS UPDATE") for a scannable layout.
 * replyable   — when true, the footer states the email can be replied to directly
 *               (owner-directed 2026-07-20: every notification is genuinely
 *               repliable — the "no-reply" framing was untrue).
 */
function render(p) {
  p = p || {};
  var title    = p.title || 'Notification';
  var subjectTag = (p.subjectTag != null && String(p.subjectTag).trim()) ? String(p.subjectTag).trim() : '';
  var kicker   = (p.kicker != null && String(p.kicker).trim()) ? String(p.kicker).trim() : '';
  var pre      = p.preheader || p.intro || title;
  var greeting = p.greeting || '';
  var intro    = p.intro || '';
  var lines    = Array.isArray(p.lines) ? p.lines : [];
  var meta     = Array.isArray(p.meta) ? p.meta : [];
  var cta      = p.cta && p.cta.url ? p.cta : null;
  var note     = p.note || '';
  var replyable = !!p.replyable;
  var code     = (p.code != null && p.code !== '') ? String(p.code) : '';
  // Premium components (all optional, all bulletproof/table-based):
  var badge    = (p.badge && p.badge.text) ? p.badge : null;                  // status pill {text,tone}
  var hero     = (p.hero && (p.hero.value || p.hero.label)) ? p.hero : null;  // {value,label,sub,tone}
  var steps    = Array.isArray(p.steps) ? p.steps.filter(function (s) { return s && s.label; }) : [];  // journey [{label,state}]
  var progress = (p.progress && p.progress.total > 0) ? p.progress : null;    // {done,total,label}
  var callout  = (p.callout && (p.callout.body || p.callout.title)) ? p.callout : null;  // {title,body,tone}
  var officer  = (p.officer && p.officer.name) ? p.officer : null;            // contact card

  /* ---------------- STATUS PILL ---------------- */
  function pill(b) {
    var t = tone(b.tone);
    return '<span style="display:inline-block;padding:5px 12px;border-radius:100px;background:' + t.bg + ';color:' + t.fg +
      ';font-family:Arial,Helvetica,sans-serif;font-size:11px;font-weight:700;letter-spacing:.07em;text-transform:uppercase;mso-line-height-rule:exactly;line-height:1;">' +
      esc(b.text) + '</span>';
  }

  /* ---------------- HERO BAND (one key fact, big) ---------------- */
  function heroBand(h) {
    var t = tone(h.tone);
    var out = '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:4px 0 22px;">' +
      '<tr><td align="center" style="padding:26px 22px;background:' + t.bg + ';border-radius:14px;">';
    if (h.label) out += '<div style="font-family:Arial,Helvetica,sans-serif;font-size:11px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:' + t.fg + ';opacity:.85;margin:0 0 8px;">' + esc(h.label) + '</div>';
    if (h.value) out += '<div style="font-family:Georgia,\'Times New Roman\',serif;font-size:34px;line-height:1.1;font-weight:700;color:' + BRAND.ink + ';">' + esc(h.value) + '</div>';
    if (h.sub)   out += '<div style="font-family:Arial,Helvetica,sans-serif;font-size:13px;color:' + t.fg + ';margin:9px 0 0;">' + esc(h.sub) + '</div>';
    out += '</td></tr></table>';
    return out;
  }

  /* ---------------- LOAN-JOURNEY STEPPER ----------------
     A row of dots the reader can scan to see exactly where their loan is: a
     completed stage is a filled teal dot with a check, the current stage is a
     filled gold dot, upcoming stages are quiet hollow rings. Bulletproof: one
     table row, one cell per stage, no overlapping/absolute positioning. */
  function stepper(list) {
    var n = list.length, w = Math.floor(100 / n);
    var cells = list.map(function (s) {
      var st = s.state || 'upcoming';
      var dot, inner = '&nbsp;';
      if (st === 'done')        { dot = 'background:' + BRAND.teal + ';color:#FFFFFF;'; inner = '&#10003;'; }
      else if (st === 'current'){ dot = 'background:' + BRAND.gold + ';color:#FFFFFF;'; inner = '&bull;'; }
      else                      { dot = 'background:' + BRAND.card + ';border:2px solid ' + BRAND.line + ';color:' + BRAND.soft2 + ';'; }
      var lblColor = st === 'upcoming' ? BRAND.soft2 : BRAND.ink;
      var lblWeight = st === 'current' ? '700' : '400';
      return '<td width="' + w + '%" align="center" valign="top" style="padding:0 3px;">' +
        '<div style="width:24px;height:24px;line-height:22px;border-radius:24px;margin:0 auto 8px;text-align:center;' +
          'font-family:Arial,Helvetica,sans-serif;font-size:12px;font-weight:700;' + dot + '">' + inner + '</div>' +
        '<div style="font-family:Arial,Helvetica,sans-serif;font-size:10px;line-height:1.3;color:' + lblColor + ';font-weight:' + lblWeight + ';">' + esc(s.label) + '</div>' +
      '</td>';
    }).join('');
    return '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:6px 0 20px;">' +
      '<tr>' + cells + '</tr></table>';
  }

  /* ---------------- COMPLETION METER ---------------- */
  function meter(pr) {
    var pct = Math.max(0, Math.min(100, Math.round((pr.done / pr.total) * 100)));
    var label = pr.label || (pr.done + ' of ' + pr.total + ' complete');
    return '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:4px 0 18px;">' +
      '<tr><td style="font-family:Arial,Helvetica,sans-serif;font-size:12px;color:' + BRAND.muted + ';padding:0 0 7px;">' + esc(label) +
        '<span style="float:right;color:' + BRAND.ink + ';font-weight:700;">' + pct + '%</span></td></tr>' +
      '<tr><td>' +
        '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:' + BRAND.soft + ';border-radius:100px;">' +
          '<tr><td style="padding:0;font-size:0;line-height:0;">' +
            '<table role="presentation" width="' + pct + '%" cellpadding="0" cellspacing="0"><tr>' +
              '<td style="height:8px;line-height:8px;font-size:0;background:' + BRAND.teal + ';border-radius:100px;">&nbsp;</td>' +
            '</tr></table>' +
          '</td></tr>' +
        '</table>' +
      '</td></tr></table>';
  }

  /* ---------------- "YOUR NEXT STEP" CALLOUT ---------------- */
  function calloutBox(c) {
    var t = tone(c.tone || 'gold');
    return '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:6px 0 18px;background:' + t.bg + ';border-radius:12px;">' +
      '<tr>' +
        '<td width="5" style="background:' + t.bar + ';border-radius:12px 0 0 12px;font-size:0;line-height:0;">&nbsp;</td>' +
        '<td style="padding:14px 18px;">' +
          (c.title ? '<div style="font-family:Arial,Helvetica,sans-serif;font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:' + t.fg + ';margin:0 0 5px;">' + esc(c.title) + '</div>' : '') +
          (c.body ? '<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.55;color:' + BRAND.ink + ';">' + esc(c.body) + '</div>' : '') +
        '</td>' +
      '</tr></table>';
  }

  /* ---------------- LOAN-OFFICER CARD ----------------
     An initial-avatar contact card so the borrower always sees a real person and
     how to reach them. Only ever the officer's own business contact. */
  function officerCard(o) {
    var initial = esc((String(o.name).trim()[0] || 'Y').toUpperCase());
    var first = esc(String(o.name).trim().split(/\s+/)[0] || 'your loan officer');
    var reach = [];
    if (o.phone) reach.push('<a href="tel:' + esc(String(o.phone).replace(/[^0-9+]/g, '')) + '" style="color:' + BRAND.tealDk + ';text-decoration:none;font-weight:600;">' + esc(o.phone) + '</a>');
    if (o.email) reach.push('<a href="mailto:' + esc(o.email) + '" style="color:' + BRAND.tealDk + ';text-decoration:none;font-weight:600;">' + esc(o.email) + '</a>');
    return '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:18px 0 4px;background:' + BRAND.soft + ';border:1px solid ' + BRAND.line + ';border-radius:12px;">' +
      '<tr><td style="padding:16px 18px;">' +
        '<table role="presentation" cellpadding="0" cellspacing="0"><tr>' +
          '<td width="46" valign="top">' +
            '<div style="width:44px;height:44px;line-height:44px;border-radius:44px;background:' + BRAND.teal + ';color:#FFFFFF;text-align:center;font-family:Georgia,\'Times New Roman\',serif;font-size:20px;font-weight:700;">' + initial + '</div>' +
          '</td>' +
          '<td valign="top" style="padding-left:14px;">' +
            '<div style="font-family:Arial,Helvetica,sans-serif;font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:' + BRAND.muted + ';margin:0 0 3px;">Your loan officer</div>' +
            '<div style="font-family:Georgia,\'Times New Roman\',serif;font-size:17px;font-weight:700;color:' + BRAND.ink + ';line-height:1.2;">' + esc(o.name) + '</div>' +
            '<div style="font-family:Arial,Helvetica,sans-serif;font-size:12px;color:' + BRAND.muted + ';margin:2px 0 0;">' + esc(o.title || 'Loan Officer') + (o.nmls ? ' &middot; NMLS #' + esc(o.nmls) : '') + '</div>' +
            (reach.length ? '<div style="font-family:Arial,Helvetica,sans-serif;font-size:13px;color:' + BRAND.ink + ';margin:8px 0 0;">' + reach.join('&nbsp;&middot;&nbsp;') + '</div>' : '') +
          '</td>' +
        '</tr></table>' +
        '<div style="font-family:Arial,Helvetica,sans-serif;font-size:12px;color:' + BRAND.muted + ';margin:12px 0 0;padding:10px 0 0;border-top:1px solid ' + BRAND.line + ';">Have a question? Just reply to this email and it reaches ' + first + ' directly.</div>' +
      '</td></tr></table>';
  }

  /* ---------------- META ROWS (label / value grid) ---------------- */
  var metaHtml = '';
  if (meta.length) {
    var rows = meta.map(function (m) {
      return '' +
        '<tr>' +
          '<td style="padding:7px 0;font-family:Arial,Helvetica,sans-serif;font-size:12px;' +
            'color:' + BRAND.muted + ';white-space:nowrap;vertical-align:top;">' + esc(m.label) + '</td>' +
          '<td style="padding:7px 0 7px 18px;font-family:Arial,Helvetica,sans-serif;font-size:13px;' +
            'color:' + BRAND.ink + ';font-weight:600;text-align:right;">' + esc(m.value) + '</td>' +
        '</tr>';
    }).join('');
    metaHtml =
      '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" ' +
        'style="margin:18px 0 4px;border-top:1px solid ' + BRAND.line + ';">' + rows + '</table>';
  }

  /* ---------------- ATTACHED FILES LIST ---------------- */
  var files = Array.isArray(p.files) ? p.files.filter(Boolean) : [];
  var filesHtml = '';
  if (files.length) {
    var chips = files.map(function (fn) {
      return '<tr><td style="padding:6px 0;font-family:Arial,Helvetica,sans-serif;font-size:13px;color:' + BRAND.ink + ';">' +
        '<span style="color:' + BRAND.gold + ';">&#128206;</span>&nbsp;' + esc(fn) + '</td></tr>';
    }).join('');
    filesHtml =
      '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" ' +
        'style="margin:16px 0 4px;padding:12px 16px;background:' + BRAND.soft + ';border:1px solid ' + BRAND.line + ';border-radius:10px;">' +
        '<tr><td style="padding:0 0 4px;font-family:Arial,Helvetica,sans-serif;font-size:11px;' +
          'letter-spacing:.08em;text-transform:uppercase;color:' + BRAND.muted + ';">' +
          (files.length === 1 ? 'Attached' : files.length + ' attachments') + '</td></tr>' +
        chips +
      '</table>';
  }

  /* ---------------- BODY PARAGRAPHS ---------------- */
  var body = '';
  if (intro) body += para(intro);
  lines.forEach(function (l) { body += para(l); });

  function para(t) {
    return '<p style="margin:0 0 14px;font-family:Arial,Helvetica,sans-serif;font-size:15px;' +
      'line-height:1.6;color:' + BRAND.ink + ';">' + esc(t) + '</p>';
  }

  /* ---------------- CTA BUTTON (bulletproof) ---------------- */
  var ctaHtml = '';
  if (cta) {
    ctaHtml =
      '<table role="presentation" cellpadding="0" cellspacing="0" style="margin:22px 0 6px;"><tr><td ' +
        'style="border-radius:8px;background:' + BRAND.teal + ';">' +
        '<a href="' + esc(cta.url) + '" target="_blank" ' +
          'style="display:inline-block;padding:13px 26px;font-family:Arial,Helvetica,sans-serif;' +
          'font-size:14px;font-weight:700;letter-spacing:.3px;color:' + BRAND.onAcc + ';' +
          'text-decoration:none;border-radius:8px;">' + esc(cta.label || 'Open portal') + ' &rarr;</a>' +
      '</td></tr></table>';
  }

  var noteHtml = note
    ? '<p style="margin:18px 0 0;font-family:Arial,Helvetica,sans-serif;font-size:12px;' +
      'line-height:1.5;color:' + BRAND.muted + ';">' + esc(note) + '</p>'
    : '';

  /* ---------------- REPLY-ABOVE-THIS-LINE MARKER (chat emails) ----------------
     A visible delimiter so a reply-by-email posts ONLY the freshly typed text
     back into the chat. It is rendered at the TOP of the message content (and in
     plaintext) so that when a mail client quotes the whole email below the
     recipient's fresh reply, the marker sits ABOVE the quoted body — and the
     inbound parser (src/routes/inbound-chat.js) can cut at the FIRST occurrence of
     the phrase "Reply above this line" (or the client's own quote attribution,
     whichever comes first) and keep exactly what was typed. Keep the phrase
     verbatim in both HTML and plaintext — it's the stable token both sides key on.*/
  var marker = p.replyMarker ? String(p.replyMarker) : '';
  var markerHtml = marker
    ? '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 20px;">' +
        '<tr><td style="padding:0 0 8px;font-family:Arial,Helvetica,sans-serif;font-size:11px;' +
          'letter-spacing:.04em;color:' + BRAND.soft2 + ';text-align:center;">' + esc(marker) + '</td></tr>' +
        '<tr>' +
          '<td style="width:100%;border-top:1px solid ' + BRAND.line + ';font-size:0;line-height:0;">&nbsp;</td>' +
        '</tr>' +
      '</table>'
    : '';

  var greetHtml = greeting
    ? '<p style="margin:0 0 14px;font-family:Arial,Helvetica,sans-serif;font-size:15px;' +
      'color:' + BRAND.ink + ';">' + esc(greeting) + '</p>'
    : '';

  /* ---------------- KICKER (small category label above the title) ----------------
     A quiet upper-case tag (e.g. "DOCUMENT REJECTED", "STATUS UPDATE") that lets
     the reader classify the email at a glance before reading the headline. Gold,
     letter-spaced, tiny — matches the site's section eyebrows. */
  var kickerHtml = kicker
    ? '<div style="margin:0 0 10px;font-family:Arial,Helvetica,sans-serif;font-size:11px;' +
      'font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:' + BRAND.gold + ';">' +
      esc(kicker) + '</div>'
    : '';

  /* ---------------- ONE-TIME CODE BOX ---------------- */
  var codeHtml = code
    ? '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:20px 0 6px;">' +
        '<tr><td align="center" style="padding:18px 14px;background:' + BRAND.soft + ';border:1px solid ' + BRAND.gold + ';border-radius:10px;">' +
          '<div style="font-family:\'Courier New\',Courier,monospace;font-size:30px;font-weight:700;' +
            'letter-spacing:8px;color:' + BRAND.ink + ';">' + esc(code) + '</div>' +
        '</td></tr>' +
      '</table>'
    : '';

  /* ---------------- BUILT PREMIUM COMPONENTS ---------------- */
  // Eyebrow row: kicker on the left, status pill on the right (either may be absent).
  var eyebrowHtml = (kicker || badge)
    ? '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 12px;"><tr>' +
        '<td valign="middle" style="font-family:Arial,Helvetica,sans-serif;font-size:11px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:' + BRAND.gold + ';">' + (kicker ? esc(kicker) : '') + '</td>' +
        '<td valign="middle" align="right">' + (badge ? pill(badge) : '') + '</td>' +
      '</tr></table>'
    : '';
  var heroHtml     = hero ? heroBand(hero) : '';
  var stepsHtml    = steps.length ? stepper(steps) : '';
  var progressHtml = progress ? meter(progress) : '';
  var calloutHtml  = callout ? calloutBox(callout) : '';
  var officerHtml  = officer ? officerCard(officer) : '';

  /* ---------------- SHELL ---------------- */
  var html =
'<!DOCTYPE html><html><head><meta charset="utf-8">' +
'<meta name="viewport" content="width=device-width,initial-scale=1">' +
'<meta name="color-scheme" content="light">' +
'<meta name="supported-color-schemes" content="light"></head>' +
'<body style="margin:0;padding:0;background:' + BRAND.paper + ';">' +
  '<div style="display:none;max-height:0;overflow:hidden;opacity:0;">' + esc(pre) + '</div>' +
  '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:' + BRAND.paper + ';">' +
    '<tr><td align="center" style="padding:32px 16px;">' +
      '<table role="presentation" width="600" cellpadding="0" cellspacing="0" ' +
        'style="width:600px;max-width:600px;background:' + BRAND.card + ';border-radius:14px;' +
        'border:1px solid ' + BRAND.line + ';overflow:hidden;">' +
        /* header */
        '<tr><td style="padding:26px 34px 22px;background:' + BRAND.card + ';border-bottom:1px solid ' + BRAND.line + ';">' +
          brandHeader() +
        '</td></tr>' +
        /* gold hairline */
        '<tr><td style="height:3px;line-height:3px;font-size:0;background:' + BRAND.gold + ';">&nbsp;</td></tr>' +
        /* title + body */
        '<tr><td style="padding:30px 34px 10px;">' +
          markerHtml +
          eyebrowHtml +
          heroHtml +
          '<h1 style="margin:0 0 16px;font-family:Georgia,\'Times New Roman\',serif;font-size:23px;' +
            'line-height:1.28;font-weight:700;color:' + BRAND.ink + ';">' + esc(title) + '</h1>' +
          greetHtml + body + stepsHtml + progressHtml + calloutHtml + codeHtml + metaHtml + officerHtml + filesHtml + ctaHtml + noteHtml +
        '</td></tr>' +
        /* footer */
        '<tr><td style="padding:22px 34px 26px;background:' + BRAND.soft + ';border-top:1px solid ' + BRAND.line + ';">' +
          '<p style="margin:0 0 5px;font-family:Arial,Helvetica,sans-serif;font-size:12px;color:' + BRAND.muted + ';">' +
            esc(COMPANY.name) + ' &middot; NMLS #' + esc(COMPANY.nmls) + ' &middot; ' + esc(COMPANY.addr) + '</p>' +
          '<p style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:12px;color:' + BRAND.muted + ';">' +
            '<a href="tel:' + esc(COMPANY.phone.replace(/[^0-9]/g,'')) + '" style="color:' + BRAND.tealDk + ';text-decoration:none;">' + esc(COMPANY.phone) + '</a>' +
            ' &nbsp;&middot;&nbsp; ' +
            '<a href="mailto:' + esc(COMPANY.email) + '" style="color:' + BRAND.tealDk + ';text-decoration:none;">' + esc(COMPANY.email) + '</a>' +
            ' &nbsp;&middot;&nbsp; ' +
            '<a href="' + esc(COMPANY.site) + '" style="color:' + BRAND.tealDk + ';text-decoration:none;">yscapgroup.com</a>' +
          '</p>' +
          /* Reply affordance (owner-directed 2026-07-20): these emails are NOT
             no-reply — a reply reaches the loan team. State it plainly so the
             recipient knows they can just hit reply. */
          (replyable
            ? '<p style="margin:0 0 10px;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:1.5;color:' + BRAND.ink + ';">' +
              '<strong>You can reply directly to this email</strong> to reach your ' +
              (p.audience === 'borrower' ? 'loan team' : 'YS Capital team') + ' — a real person receives it.' +
            '</p>'
            : '') +
          /* legal fine print stays AA-legible on the soft footer: muted (6.5:1),
             not soft2 (~3.5:1 at 11px) — disclosure copy must be readable. */
          '<p style="margin:12px 0 0;font-family:Arial,Helvetica,sans-serif;font-size:11px;line-height:1.5;color:' + BRAND.muted + ';">' +
            'Sent by PILOT, the ' + esc(COMPANY.name) + ' investor platform, regarding a business-purpose loan file. ' +
            'For business use only; not an offer to enter into an interest-rate lock or a commitment to lend.' +
          '</p>' +
        '</td></tr>' +
      '</table>' +
    '</td></tr>' +
  '</table>' +
'</body></html>';

  /* ---------------- PLAINTEXT FALLBACK ---------------- */
  // The reply-above-this-line delimiter is the VERY FIRST plaintext line (above
  // even the brand line) so that when a client quotes the plaintext part on reply,
  // NOTHING of ours sits above the marker — the inbound parser cuts at the phrase
  // and keeps only what the recipient typed.
  var t = [];
  if (marker) t.push(marker, '');
  t.push('PILOT · by YS Capital', '', title, '');
  if (greeting) t.push(greeting, '');
  if (intro) t.push(intro, '');
  lines.forEach(function (l) { t.push(l, ''); });
  if (code) t.push('Code: ' + code, '');
  if (files.length) { t.push((files.length === 1 ? 'Attached: ' : 'Attachments: ') + files.join(', '), ''); }
  if (meta.length) { meta.forEach(function (m) { t.push(m.label + ': ' + m.value); }); t.push(''); }
  if (cta) t.push(cta.label + ': ' + cta.url, '');
  if (note) t.push(note, '');
  if (replyable) t.push('You can reply directly to this email to reach your '
    + (p.audience === 'borrower' ? 'loan team.' : 'YS Capital team.'), '');
  t.push('—', COMPANY.name + ' · NMLS #' + COMPANY.nmls, COMPANY.phone + ' · ' + COMPANY.email + ' · yscapgroup.com');

  // Subject carries the file tag ("<title> · <loan# · property>") so the reader
  // sees WHICH file this is about straight from their inbox — the in-body H1
  // stays the clean title.
  var subject = subjectTag ? (title + ' · ' + subjectTag) : title;
  return { subject: subject, html: html, text: t.join('\n') };
}

module.exports = { render: render, BRAND: BRAND, COMPANY: COMPANY };
