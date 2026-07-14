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
 * render({ title, preheader, greeting, intro, lines[], meta[{label,value}],
 *          cta{label,url}, note, audience })
 *   -> { subject, html, text }
 */
function render(p) {
  p = p || {};
  var title    = p.title || 'Notification';
  var pre      = p.preheader || p.intro || title;
  var greeting = p.greeting || '';
  var intro    = p.intro || '';
  var lines    = Array.isArray(p.lines) ? p.lines : [];
  var meta     = Array.isArray(p.meta) ? p.meta : [];
  var cta      = p.cta && p.cta.url ? p.cta : null;
  var note     = p.note || '';
  var code     = (p.code != null && p.code !== '') ? String(p.code) : '';

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

  var greetHtml = greeting
    ? '<p style="margin:0 0 14px;font-family:Arial,Helvetica,sans-serif;font-size:15px;' +
      'color:' + BRAND.ink + ';">' + esc(greeting) + '</p>'
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
        '<tr><td style="padding:30px 34px 8px;">' +
          '<h1 style="margin:0 0 18px;font-family:Georgia,\'Times New Roman\',serif;font-size:21px;' +
            'line-height:1.3;font-weight:700;color:' + BRAND.ink + ';">' + esc(title) + '</h1>' +
          greetHtml + body + codeHtml + metaHtml + filesHtml + ctaHtml + noteHtml +
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
  var t = ['PILOT · by YS Capital', '', title, ''];
  if (greeting) t.push(greeting, '');
  if (intro) t.push(intro, '');
  lines.forEach(function (l) { t.push(l, ''); });
  if (code) t.push('Code: ' + code, '');
  if (files.length) { t.push((files.length === 1 ? 'Attached: ' : 'Attachments: ') + files.join(', '), ''); }
  if (meta.length) { meta.forEach(function (m) { t.push(m.label + ': ' + m.value); }); t.push(''); }
  if (cta) t.push(cta.label + ': ' + cta.url, '');
  if (note) t.push(note, '');
  t.push('—', COMPANY.name + ' · NMLS #' + COMPANY.nmls, COMPANY.phone + ' · ' + COMPANY.email + ' · yscapgroup.com');

  return { subject: title, html: html, text: t.join('\n') };
}

module.exports = { render: render, BRAND: BRAND, COMPANY: COMPANY };
