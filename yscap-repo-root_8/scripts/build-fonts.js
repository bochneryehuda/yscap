#!/usr/bin/env node
/* =====================================================================
   build-fonts.js — regenerate the self-hosted webfonts.

   WHY THE FONTS ARE SELF-HOSTED
   Every page used to block on `fonts.googleapis.com`. A stylesheet <link> is
   render-blocking, so when that third party is slow, blocked or unreachable the
   page shows NOTHING until the browser gives up. Measured on the Term Sheet
   Studio, from local disk with zero network latency:
       fonts answering normally ....... 177 ms to usable
       fonts not answering ......... 12,911 ms to usable
   Same page, same files. It also sent every visitor's IP to Google, which is
   the reason German courts have ruled that embedding is a GDPR problem.

   HOW TO REGENERATE
       npm install --no-save @fontsource-variable/fraunces@5 \
                             @fontsource-variable/hanken-grotesk@5 \
                             @fontsource-variable/inter@5
       node scripts/build-fonts.js
       npm prune            # drop the temporary packages again

   WHICH VARIANTS, AND WHY
   - Fraunces keeps its OPTICAL-SIZE axis (`standard` = opsz + wght). CSS
     `font-optical-sizing` defaults to `auto`, so a browser automatically adapts
     the letterforms by size whenever that axis exists. Shipping a weight-only
     file would silently change how every heading renders.
   - Hanken Grotesk and Inter are weight-only upstream, matching what Google
     served for them.
   - Italic is included because it is genuinely used (the hero/tool taglines set
     `font-style: italic` on the display face, and the pages carry ~90 <em>
     tags). Without a real italic the browser synthesises a slanted face.
   - latin + latin-ext only. Each @font-face carries its `unicode-range`, so a
     browser downloads a file ONLY when it actually needs a character from it —
     latin-ext and italic cost nothing until something needs them.
   - Inter is here for V1 ONLY: `app/src/styles.css` puts 'Inter' FIRST in both
     --serif and --sans, so V1's portal genuinely renders in it. V2 lists Inter
     merely as a fallback after 'Hanken Grotesk', so V2 never fetches it.
   ===================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');

const NM = path.join(__dirname, '..', 'node_modules', '@fontsource-variable');
const OUT = path.join(__dirname, '..', 'web', 'v2', 'assets', 'fonts');

/* One stylesheet for the whole site. A browser only downloads the families it
   actually resolves, so V1 (Inter) and V2 (Fraunces + Hanken) each fetch just
   what they render. */
const WANT = [
  { pkg: 'fraunces',       css: 'standard.css',        style: 'normal' },
  { pkg: 'fraunces',       css: 'standard-italic.css', style: 'italic' },
  { pkg: 'hanken-grotesk', css: 'wght.css',            style: 'normal' },
  { pkg: 'hanken-grotesk', css: 'wght-italic.css',     style: 'italic' },
  { pkg: 'inter',          css: 'wght.css',            style: 'normal' },
  { pkg: 'inter',          css: 'wght-italic.css',     style: 'italic' },
];

function main() {
  if (!fs.existsSync(NM)) {
    console.error('@fontsource-variable packages are not installed — see the header of this file.');
    process.exit(2);
  }
  fs.mkdirSync(OUT, { recursive: true });

  // Clear out any previously generated file so a removed variant cannot linger.
  for (const f of fs.readdirSync(OUT)) {
    if (/\.(woff2|css)$/.test(f)) fs.unlinkSync(path.join(OUT, f));
  }

  const header =
`/* SELF-HOSTED WEBFONTS — do not hand-edit; regenerate with scripts/build-fonts.js.

   These used to come from fonts.googleapis.com, which is render-blocking: when
   that third party was slow or blocked, the page stayed blank until the browser
   gave up (measured: 177 ms to usable when it answered, 12,911 ms when it did
   not). Serving them ourselves removes that dependency entirely.

   Each rule carries its own unicode-range, so a browser downloads a file only
   when it needs a character from it. Fraunces keeps its optical-size axis, so
   headings render exactly as before. */
`;

  const rules = [];
  let copied = 0, bytes = 0;

  for (const w of WANT) {
    const cssPath = path.join(NM, w.pkg, w.css);
    if (!fs.existsSync(cssPath)) { console.error('missing ' + cssPath); process.exit(2); }
    for (const block of fs.readFileSync(cssPath, 'utf8').split('@font-face').slice(1)) {
      const file = (block.match(/url\(\.\/files\/([^)]+\.woff2)\)/) || [])[1];
      if (!file) continue;
      const isExt = file.includes('-latin-ext-');
      const isLatin = file.includes('-latin-') && !isExt;
      if (!isLatin && !isExt) continue;                       // skip cyrillic/greek/vietnamese

      const famRaw = (block.match(/font-family:\s*'([^']+)'/) || [])[1] || '';
      const family = famRaw.replace(/\s*Variable$/, '');      // the site says 'Fraunces', not 'Fraunces Variable'
      const weight = ((block.match(/font-weight:\s*([^;]+);/) || [])[1] || '400').trim();
      const range  = ((block.match(/unicode-range:\s*([^;]+);/) || [])[1] || '').trim();

      const src = path.join(NM, w.pkg, 'files', file);
      if (!fs.existsSync(src)) continue;
      const buf = fs.readFileSync(src);
      fs.writeFileSync(path.join(OUT, file), buf);
      copied++; bytes += buf.length;

      rules.push(
        `@font-face{font-family:'${family}';font-style:${w.style};font-display:swap;` +
        `font-weight:${weight};src:url(/assets/fonts/${file}) format('woff2-variations');` +
        (range ? `unicode-range:${range}` : '') + `}`
      );
    }
  }

  fs.writeFileSync(path.join(OUT, 'fonts.css'), header + rules.join('\n') + '\n');

  const fams = [...new Set(rules.map(r => (r.match(/font-family:'([^']+)'/) || [])[1]))];
  console.log(`families : ${fams.join(', ')}`);
  console.log(`files    : ${copied} woff2, ${bytes.toLocaleString()} bytes on disk`);
  console.log(`rules    : ${rules.length} @font-face`);
  console.log(`written  : ${path.relative(process.cwd(), path.join(OUT, 'fonts.css'))}`);
}

main();
