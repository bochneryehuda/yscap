/* =====================================================================
   YS CAPITAL — BRANDED EMAIL TEMPLATE
   Renders one branded HTML email (+ a clean plaintext fallback) from a
   small structured payload. Pure function, no I/O — notify.js feeds it.

   Design: deep-ink canvas, champagne hairline, muted-teal accent, serif
   wordmark. Built with tables + inline styles only (no <style> blocks, no
   web fonts, no external CSS) so it renders identically in Outlook, Gmail,
   Apple Mail and mobile clients. Colors mirror the site's :root palette.
   ===================================================================== */
'use strict';

// The logo URL is resolved from config (env-driven) but the module stays safe
// to require in isolation — fall back to no image (text wordmark) if config
// can't load for any reason.
var LOGO_URL = '';
try { LOGO_URL = require('../../config').emailLogoUrl || ''; } catch (e) { LOGO_URL = ''; }

var BRAND = {
  ink:    '#141B22',   // deep ink canvas
  ink1:   '#1B242D',   // card
  ink2:   '#232F3A',   // rule / chip
  teal:   '#7FA9B0',   // brand muted teal
  tealBr: '#AAD4D9',   // brighter teal (links/wordmark accent)
  gold:   '#C9A86A',   // champagne hairline
  ivory:  '#F4F0E7',   // primary text on ink
  muted:  '#A6B3BA',   // secondary text
  onAcc:  '#08232b'    // text on teal button
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

/* Header brand block. Uses the real YS Capital lockup (skyline mark + "YS
   CAPITAL GROUP" + "the answer is yes" tagline) hosted as a static asset, so
   emails carry the actual brand rather than a text approximation. If images are
   blocked or the URL is unset, the alt text / text wordmark below stands in. */
function brandHeader() {
  if (LOGO_URL) {
    return '<img src="' + esc(LOGO_URL) + '" width="230" alt="YS Capital Group — the answer is yes" ' +
      'style="display:block;border:0;outline:none;text-decoration:none;-ms-interpolation-mode:bicubic;' +
      'width:230px;max-width:230px;height:auto;">';
  }
  return wordmark();
}

/* Text wordmark fallback — always renders even with no image host. */
function wordmark() {
  return '' +
    '<span style="font-family:Georgia,\'Times New Roman\',serif;font-size:22px;' +
    'letter-spacing:3px;color:' + BRAND.ivory + ';font-weight:700;">YS&nbsp;CAPITAL</span>' +
    '<span style="font-family:Arial,Helvetica,sans-serif;font-size:11px;' +
    'letter-spacing:4px;color:' + BRAND.teal + ';text-transform:uppercase;">&nbsp;&nbsp;GROUP</span>';
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
            'color:' + BRAND.ivory + ';font-weight:600;text-align:right;">' + esc(m.value) + '</td>' +
        '</tr>';
    }).join('');
    metaHtml =
      '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" ' +
        'style="margin:18px 0 4px;border-top:1px solid ' + BRAND.ink2 + ';">' + rows + '</table>';
  }

  /* ---------------- BODY PARAGRAPHS ---------------- */
  var body = '';
  if (intro) body += para(intro);
  lines.forEach(function (l) { body += para(l); });

  function para(t) {
    return '<p style="margin:0 0 14px;font-family:Arial,Helvetica,sans-serif;font-size:15px;' +
      'line-height:1.6;color:' + BRAND.ivory + ';">' + esc(t) + '</p>';
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
      'color:' + BRAND.ivory + ';">' + esc(greeting) + '</p>'
    : '';

  /* ---------------- ONE-TIME CODE BOX ---------------- */
  var codeHtml = code
    ? '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:20px 0 6px;">' +
        '<tr><td align="center" style="padding:18px 14px;background:' + BRAND.ink2 + ';border:1px solid ' + BRAND.gold + ';border-radius:10px;">' +
          '<div style="font-family:\'Courier New\',Courier,monospace;font-size:30px;font-weight:700;' +
            'letter-spacing:8px;color:' + BRAND.ivory + ';">' + esc(code) + '</div>' +
        '</td></tr>' +
      '</table>'
    : '';

  /* ---------------- SHELL ---------------- */
  var html =
'<!DOCTYPE html><html><head><meta charset="utf-8">' +
'<meta name="viewport" content="width=device-width,initial-scale=1">' +
'<meta name="color-scheme" content="dark light"></head>' +
'<body style="margin:0;padding:0;background:' + BRAND.ink + ';">' +
  '<div style="display:none;max-height:0;overflow:hidden;opacity:0;">' + esc(pre) + '</div>' +
  '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:' + BRAND.ink + ';">' +
    '<tr><td align="center" style="padding:32px 16px;">' +
      '<table role="presentation" width="600" cellpadding="0" cellspacing="0" ' +
        'style="width:600px;max-width:600px;background:' + BRAND.ink1 + ';border-radius:14px;' +
        'border:1px solid ' + BRAND.ink2 + ';overflow:hidden;">' +
        /* header */
        '<tr><td style="padding:28px 34px 24px;border-bottom:1px solid ' + BRAND.ink2 + ';">' +
          brandHeader() +
        '</td></tr>' +
        /* gold hairline */
        '<tr><td style="height:3px;line-height:3px;font-size:0;background:' + BRAND.gold + ';">&nbsp;</td></tr>' +
        /* title + body */
        '<tr><td style="padding:30px 34px 8px;">' +
          '<h1 style="margin:0 0 18px;font-family:Georgia,\'Times New Roman\',serif;font-size:21px;' +
            'line-height:1.3;font-weight:700;color:' + BRAND.ivory + ';">' + esc(title) + '</h1>' +
          greetHtml + body + codeHtml + metaHtml + ctaHtml + noteHtml +
        '</td></tr>' +
        /* footer */
        '<tr><td style="padding:22px 34px 26px;border-top:1px solid ' + BRAND.ink2 + ';">' +
          '<p style="margin:0 0 5px;font-family:Arial,Helvetica,sans-serif;font-size:12px;color:' + BRAND.muted + ';">' +
            esc(COMPANY.name) + ' &middot; NMLS #' + esc(COMPANY.nmls) + ' &middot; ' + esc(COMPANY.addr) + '</p>' +
          '<p style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:12px;color:' + BRAND.muted + ';">' +
            '<a href="tel:' + esc(COMPANY.phone.replace(/[^0-9]/g,'')) + '" style="color:' + BRAND.teal + ';text-decoration:none;">' + esc(COMPANY.phone) + '</a>' +
            ' &nbsp;&middot;&nbsp; ' +
            '<a href="mailto:' + esc(COMPANY.email) + '" style="color:' + BRAND.teal + ';text-decoration:none;">' + esc(COMPANY.email) + '</a>' +
            ' &nbsp;&middot;&nbsp; ' +
            '<a href="' + esc(COMPANY.site) + '" style="color:' + BRAND.teal + ';text-decoration:none;">yscapgroup.com</a>' +
          '</p>' +
          '<p style="margin:12px 0 0;font-family:Arial,Helvetica,sans-serif;font-size:11px;line-height:1.5;color:#6E7B84;">' +
            'This message was sent by ' + esc(COMPANY.name) + ' regarding a business-purpose loan file. ' +
            'For business use only; not an offer to enter into an interest-rate lock or a commitment to lend.' +
          '</p>' +
        '</td></tr>' +
      '</table>' +
    '</td></tr>' +
  '</table>' +
'</body></html>';

  /* ---------------- PLAINTEXT FALLBACK ---------------- */
  var t = ['YS CAPITAL GROUP', '', title, ''];
  if (greeting) t.push(greeting, '');
  if (intro) t.push(intro, '');
  lines.forEach(function (l) { t.push(l, ''); });
  if (code) t.push('Code: ' + code, '');
  if (meta.length) { meta.forEach(function (m) { t.push(m.label + ': ' + m.value); }); t.push(''); }
  if (cta) t.push(cta.label + ': ' + cta.url, '');
  if (note) t.push(note, '');
  t.push('—', COMPANY.name + ' · NMLS #' + COMPANY.nmls, COMPANY.phone + ' · ' + COMPANY.email + ' · yscapgroup.com');

  return { subject: title, html: html, text: t.join('\n') };
}

module.exports = { render: render, BRAND: BRAND, COMPANY: COMPANY };
