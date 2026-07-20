/**
 * build-assets.js — BUILD-TIME tool (dev only; NOT imported at send time).
 *
 * The Heter Iska is a SACRED Hebrew document. jsPDF's core font is Latin-1 and
 * cannot render Hebrew, and our Render host has no LibreOffice/Chromium to convert
 * the filled Word template → PDF at send time. Re-typesetting the nusach with an
 * embedded Hebrew font in jsPDF would be unverifiable on Render and risks corrupting
 * sacred text — unacceptable.
 *
 * So we split the problem: this tool renders the STATIC nusach ONCE here (Chromium
 * via Playwright renders Hebrew RTL flawlessly), captures each letter page as a
 * high-resolution JPEG, and records the exact rectangle of every VARIABLE slot
 * (loan amount, borrower/co-borrower name, and the signature/date anchor points).
 * The committed page images + `iska-layout.json` are then consumed at send time by
 * iska-pdf.js, which lays the page image into a jsPDF page and draws ONLY Latin text
 * (the amount + names) and the invisible DocuSign anchors on top — no Hebrew rendering
 * on the server at all. What we verify HERE is byte-for-byte what ships.
 *
 * The Hebrew nusach is EXTRACTED byte-exact from the Word template (../heter_iska.docx)
 * — never re-typed — so the rendered image always agrees with the template the office
 * keeps. Re-run this tool (node build-assets.js) whenever the template changes, then
 * eyeball the emitted PNGs before committing.
 *
 * Run:  node src/lib/esign/templates/iska/build-assets.js
 * Deps: Playwright + the pinned Chromium (dev/CI only). Guarded so a missing dep
 *       fails loudly with guidance rather than at server boot.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { unzip } = require('../../../zip');

const HERE = __dirname;
const DOCX = path.join(HERE, '..', 'heter_iska.docx');
const OUT_LAYOUT = path.join(HERE, 'iska-layout.json');
const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

// ---- byte-exact text extraction from the Word template ----------------------
// The template's cached mail-merge tokens look like «FieldName»; the nusach around
// them is plain w:t text. We pull each paragraph's concatenated w:t runs verbatim.
function templateParagraphs() {
  const entries = unzip(fs.readFileSync(DOCX));
  const xml = entries.find((e) => e.name === 'word/document.xml').data.toString('utf8');
  const paras = xml.match(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/g) || [];
  return paras.map((p) => {
    const text = [...p.matchAll(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g)].map((m) => m[1]).join('')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&apos;/g, "'");
    return text;
  });
}

// The nusach body is a stable, ordered set of paragraph indices in the template
// (verified against the current heter_iska.docx). Blank spacer paragraphs and the
// stray NMLS/footer runs are intentionally excluded — they carry no nusach.
const NUSACH_INDICES = [30, 31, 33, 34, 35, 36, 37, 38, 39, 45, 46, 47, 48, 49, 50, 51];
const IDX = { besiyata: 25, title: 28, rabbiAuthority: 1, rabbiName: 2 };
const AMOUNT_TOKEN = '«Loan_Amount_1109»';
const NAME_TOKENS = [
  '«Borrower_First_And_Middle_Name_36»', '«Borrower_Last_Name_4002»',
  '«Co_Borrower_First_Name_4004»', '«Co_Borrower_Last_Name_4006»',
];

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const dataUri = (file, mime) => `data:${mime};base64,` + fs.readFileSync(path.join(HERE, file)).toString('base64');

// ---- HTML document ----------------------------------------------------------
// One flowing column at letter width; the build script paginates greedily so no
// nusach paragraph is ever split across a page. Slots are fixed-width so the
// send-time overlay always fits, regardless of bidi reflow around them.
function buildHtml(P, withCo) {
  // A zero-size inline baseline probe: its top edge sits exactly on the text
  // baseline, so we can align the send-time overlay to the same baseline jsPDF uses.
  const baseref = '<i class="baseref"></i>';
  const nusach = NUSACH_INDICES.map((i) => {
    let t = P[i];
    if (t.includes(AMOUNT_TOKEN)) {
      // Keep the surrounding Hebrew byte-exact; swap only the token for the slot.
      const [before, after] = t.split(AMOUNT_TOKEN);
      return `<p class="body">${esc(before)}<span class="slot amt" id="slot-amt">&nbsp;${baseref}</span>${esc(after)}</p>`;
    }
    return `<p class="body">${esc(t)}</p>`;
  }).join('\n');

  const sigBlock = (who, label, nameId, sigId, dtId) => `
    <div class="sig">
      <div class="sigline">
        <span class="anchor" id="${sigId}">&nbsp;${baseref}</span>
        <span class="ln"></span>
        <span class="dt">Date: <span class="anchor" id="${dtId}">&nbsp;${baseref}</span><span class="ln short"></span></span>
      </div>
      <p class="body naom">&#x202B;&#x5E0;&#x5D0;&#x5D5;&#x5DD;&#x202C;</p>
      <p class="signame">${label}: <span class="slot name" id="${nameId}">&nbsp;${baseref}</span></p>
    </div>`;

  const co = withCo ? sigBlock('co', 'Co-Borrower', 'slot-cbname', 'anchor-b2-sig', 'anchor-b2-dt') : '';

  return `<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8">
<style>
  @font-face { font-family:'HebrewSerif'; src: local('FreeSerif'); }
  * { box-sizing: border-box; }
  html,body { margin:0; padding:0; background:#fff; }
  #flow { width: 696px; margin:0; font-family:'FreeSerif','DejaVu Serif',serif; color:#111; }
  .watermark { position:absolute; inset:0; opacity:0.05; z-index:0; pointer-events:none; }
  .header { display:flex; justify-content:space-between; align-items:flex-start; gap:16px; margin-bottom:6px; }
  .header .brand { text-align:left; direction:ltr; }
  .header .brand img { width:150px; height:auto; display:block; }
  .header .brand .addr { font-family:'DejaVu Sans',sans-serif; font-size:10px; line-height:1.35; color:#333; margin-top:4px; }
  .header .rabbi { text-align:right; direction:rtl; font-size:14px; line-height:1.4; }
  .header .rabbi .nm { font-weight:bold; }
  .rule { height:2px; background:#967B44; margin:6px 0 4px; }
  .besiyata { text-align:center; font-size:13px; margin:2px 0; }
  .title { text-align:center; font-weight:bold; font-size:31px; margin:8px 0 12px; letter-spacing:1px; }
  p.body { direction:rtl; text-align:justify; font-size:15.5px; line-height:1.72; margin:0 0 9px; }
  p.body.naom { text-align:right; margin:10px 0 2px; font-size:15.5px; }
  .slot { display:inline-block; border-bottom:1px solid #111; text-align:center; vertical-align:baseline; }
  .slot.amt { width:96px; direction:ltr; }
  .slot.name { width:300px; direction:ltr; text-align:left; }
  .sig { margin-top:18px; break-inside:avoid; }
  .sigline { display:flex; align-items:flex-end; direction:ltr; gap:12px; }
  .sigline .ln { display:inline-block; border-bottom:1px solid #111; width:300px; height:14px; }
  .sigline .ln.short { width:110px; }
  .sigline .dt { display:flex; align-items:flex-end; gap:6px; font-family:'DejaVu Sans',sans-serif; font-size:12px; }
  .anchor { display:inline-block; width:1px; height:12px; overflow:hidden; color:transparent; }
  .baseref { display:inline-block; width:0; height:0; vertical-align:baseline; overflow:hidden; }
  .signame { direction:ltr; text-align:left; font-family:'DejaVu Sans',sans-serif; font-size:13px; margin:6px 0 0; }
</style></head>
<body><div id="flow">
  <div class="header">
    <div class="brand">
      <img src="${dataUri('ys_logo.png', 'image/png')}" alt="YS Capital Group">
      <div class="addr">YS Capital Group<br>5 New Montrose Avenue #Bsmt<br>Brooklyn, NY 11211<br>Phone: (718) 635-0277<br>NMLS ID: 2609746</div>
    </div>
    <div class="rabbi">
      <div class="nm">${esc(P[IDX.rabbiName])}</div>
      <div>${esc(P[IDX.rabbiAuthority])}</div>
    </div>
  </div>
  <div class="rule"></div>
  <div class="besiyata">${esc(P[IDX.besiyata])}</div>
  <div class="title">${esc(P[IDX.title])}</div>
  ${nusach}
  ${sigBlock('b', 'Borrower', 'slot-bname', 'anchor-b1-sig', 'anchor-b1-dt')}
  ${co}
</div></body></html>`;
}

// ---- render + paginate + measure --------------------------------------------
const PAGE_W = 816, PAGE_H = 1056;                 // letter @96dpi (CSS px)
const MARGIN = { top: 54, bottom: 60, left: 60, right: 60 };
const CONTENT_H = PAGE_H - MARGIN.top - MARGIN.bottom;
const DPR = 2;                                      // device pixels per CSS px
const PX_TO_PT = 612 / PAGE_W;                      // 0.75 (72/96)

async function render(chromium, P, withCo, tag) {
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox', '--disable-gpu'] });
  try {
    const page = await browser.newPage({ deviceScaleFactor: DPR, viewport: { width: PAGE_W, height: PAGE_H } });
    await page.setContent(buildHtml(P, withCo), { waitUntil: 'networkidle' });

    // Greedy pagination: append each top-level block to the current page; when it
    // overflows the content box, move it to a fresh page. Keeps blocks intact.
    const pageCount = await page.evaluate(({ PAGE_W, PAGE_H, MARGIN, CONTENT_H }) => {
      const flow = document.getElementById('flow');
      const blocks = Array.from(flow.children);
      flow.remove();
      const pagesEl = [];
      function newPage() {
        const pg = document.createElement('div');
        pg.className = 'page';
        Object.assign(pg.style, {
          position: 'relative', width: PAGE_W + 'px', height: PAGE_H + 'px',
          background: '#fff', overflow: 'hidden',
        });
        const inner = document.createElement('div');
        inner.className = 'inner';
        Object.assign(inner.style, {
          position: 'absolute', top: MARGIN.top + 'px', left: MARGIN.left + 'px',
          width: (PAGE_W - MARGIN.left - MARGIN.right) + 'px',
        });
        pg.appendChild(inner);
        document.body.appendChild(pg);
        pagesEl.push({ pg, inner });
        return { pg, inner };
      }
      let cur = newPage();
      for (const b of blocks) {
        cur.inner.appendChild(b);
        if (cur.inner.scrollHeight > CONTENT_H && cur.inner.children.length > 1) {
          cur.inner.removeChild(b);
          cur = newPage();
          cur.inner.appendChild(b);
        }
      }
      // stack pages vertically in the document so each has a stable page box
      document.body.style.margin = '0';
      return pagesEl.length;
    }, { PAGE_W, PAGE_H, MARGIN, CONTENT_H });

    // Screenshot each .page element → JPEG (small, no bloat via jsPDF DCTDecode).
    const images = [];
    const pageEls = await page.$$('.page');
    for (let i = 0; i < pageEls.length; i++) {
      const file = `iska_${tag}_p${i + 1}.jpg`;
      await pageEls[i].screenshot({ path: path.join(HERE, file), type: 'jpeg', quality: 90 });
      images.push({ file, wPt: PAGE_W * PX_TO_PT, hPt: PAGE_H * PX_TO_PT });
    }

    // Locate each variable slot: which page + rectangle (in PDF points, page-relative).
    const slots = {};
    const wanted = withCo
      ? ['slot-amt', 'slot-bname', 'slot-cbname', 'anchor-b1-sig', 'anchor-b1-dt', 'anchor-b2-sig', 'anchor-b2-dt']
      : ['slot-amt', 'slot-bname', 'anchor-b1-sig', 'anchor-b1-dt'];
    const pageBoxes = [];
    for (const el of pageEls) pageBoxes.push(await el.boundingBox());
    for (const id of wanted) {
      const box = await page.locator('#' + id).boundingBox();
      if (!box) throw new Error(`slot #${id} not found in ${tag}`);
      // The baseref's TOP edge sits exactly on the text baseline (see .baseref CSS).
      const bref = await page.locator(`#${id} .baseref`).boundingBox();
      if (!bref) throw new Error(`baseref for #${id} not found in ${tag}`);
      // Which page does this slot's top fall in?
      let pageIdx = 0;
      for (let i = 0; i < pageBoxes.length; i++) {
        if (box.y >= pageBoxes[i].y - 1 && box.y < pageBoxes[i].y + pageBoxes[i].height) { pageIdx = i; break; }
      }
      const px = pageBoxes[pageIdx].x, py = pageBoxes[pageIdx].y;
      slots[id] = {
        page: pageIdx,
        xPt: +((box.x - px) * PX_TO_PT).toFixed(2),          // slot left edge
        wPt: +(box.width * PX_TO_PT).toFixed(2),             // slot width
        baselinePt: +((bref.y - py) * PX_TO_PT).toFixed(2),  // text baseline (for jsPDF doc.text y)
        topPt: +((box.y - py) * PX_TO_PT).toFixed(2),
        hPt: +(box.height * PX_TO_PT).toFixed(2),
      };
    }
    return { pages: images, slots };
  } finally {
    await browser.close();
  }
}

async function main() {
  let chromium;
  try { ({ chromium } = require(require('child_process').execSync('npm root -g').toString().trim() + '/playwright')); }
  catch (e) { console.error('Playwright not available (dev/CI only). Install it to rebuild Iska assets.\n', e.message); process.exit(1); }

  const P = templateParagraphs();
  // sanity: the tokens we depend on must still be where we expect them
  if (!P[31] || !P[31].includes(AMOUNT_TOKEN)) throw new Error('loan-amount token not at expected paragraph — template changed; re-map NUSACH_INDICES/IDX');
  for (const tok of NAME_TOKENS) if (!P.some((t) => t.includes(tok))) throw new Error(`name token ${tok} missing — template changed`);

  const co = await render(chromium, P, true, 'co');
  const solo = await render(chromium, P, false, 'solo');
  // Dedupe byte-identical pages across variants (page 1 is the same for co & solo)
  // so we don't commit the same image twice.
  const crypto = require('crypto');
  const seen = new Map();
  for (const variant of [co, solo]) {
    for (const pg of variant.pages) {
      const abs = path.join(HERE, pg.file);
      const hash = crypto.createHash('sha1').update(fs.readFileSync(abs)).digest('hex');
      if (seen.has(hash)) {
        fs.unlinkSync(abs);          // identical to an already-kept image → drop the dup
        pg.file = seen.get(hash);
      } else {
        seen.set(hash, pg.file);
      }
    }
  }
  const layout = {
    _note: 'Generated by build-assets.js from heter_iska.docx. Do not hand-edit. Consumed by iska-pdf.js at send time.',
    pageWidthPt: 612, pageHeightPt: 792,
    variants: { co, solo },
  };
  fs.writeFileSync(OUT_LAYOUT, JSON.stringify(layout, null, 2));
  console.log('Wrote', OUT_LAYOUT);
  console.log('co pages:', co.pages.map((p) => p.file).join(', '), '| slots:', Object.keys(co.slots).join(','));
  console.log('solo pages:', solo.pages.map((p) => p.file).join(', '), '| slots:', Object.keys(solo.slots).join(','));
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
module.exports = { templateParagraphs, buildHtml, NUSACH_INDICES, IDX };
