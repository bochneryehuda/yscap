/* THE DOWNLOAD HEADER — a filename built from data may never make a download impossible.
 *
 * Found live 2026-08-21 while building the track-record export (owner item 7): the file was named
 * `<Borrower> — Track Record (Verified) <date>.xlsx`, the em dash is above U+00FF, Node's
 * `setHeader` THREW `ERR_INVALID_CHAR`, the route's catch turned it into a 500 — and EVERY press
 * of that button failed, for every borrower. The same trap was latent on eight other download
 * routes whose filename carries a borrower's name: `O’Brien` written anywhere by Word, iOS or
 * Outlook carries U+2019 and would have done exactly the same thing.
 *
 * What this pins:
 *   A. the header is ALWAYS legal — proven by handing it to a REAL Node response, not by reading
 *      the string, because the ceiling being tested is Node's own validator;
 *   B. both halves of RFC 6266 are there, so the reader still gets the real name back;
 *   C. nothing a person types can inject a second header or escape the quoted parameter;
 *   D. an ordinary ASCII filename is byte-identical to what the routes sent before.
 *
 * Pure — no database. Run: node scripts/test-content-disposition-pure.js
 */
'use strict';
const http = require('http');
const CD = require('../src/lib/content-disposition');

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) pass++; else { fail++; console.log(`FAIL ${name}`); } };
const eq = (name, got, exp) => {
  if (got === exp) pass++;
  else { fail++; console.log(`FAIL ${name}: got ${JSON.stringify(got)} expected ${JSON.stringify(exp)}`); }
};

const NUL = String.fromCharCode(0);

// The real names this exists for — each one is something a person actually types.
const NAMES = [
  'Ann O’Brien — Track Record (Verified) 2026-08-21.xlsx',   // curly apostrophe + em dash
  'שלמה כהן.pdf',                                             // Hebrew
  '“Quoted” title – report.csv',                             // smart quotes + en dash
  'Café façade.pdf',                                          // Latin-1 accents
  'plain-name_2026.xlsx',                                     // the ordinary case
  '',                                                         // nothing at all
  'a'.repeat(400) + '.pdf',                                   // absurdly long
];

// ---------------------------------------------------------------- A + C. always legal
{
  // Anything Node's own header validator refuses.
  // eslint-disable-next-line no-control-regex
  const ILLEGAL = /[^\t\x20-\x7E\x80-\xFF]/;
  for (const n of NAMES) {
    const v = CD.contentDisposition(n);
    ok(`A1 legal header characters for ${JSON.stringify(n.slice(0, 24))}`, !ILLEGAL.test(v));
    ok('A2 …one line only', !/[\r\n]/.test(v));
  }
  const evil = 'a"\r\nX-Injected: yes\r\n\r\n<script>.pdf';
  const v = CD.contentDisposition(evil);
  ok('C1 a newline can never inject a second header', !/[\r\n]/.test(v));
  ok('C2 …and a quote can never escape the quoted parameter', (v.match(/"/g) || []).length === 2);
  ok('C3 a NUL byte never survives into the header', !CD.contentDisposition(`bad${NUL}name.pdf`).includes(NUL));
}

// A header Node ITSELF accepts — the only test that proves the bug is gone, since what is being
// tested is Node's own ceiling, not a rule this file restates.
(async () => {
  const server = http.createServer((req, res) => {
    try {
      CD.setContentDisposition(res, decodeURIComponent(req.url.slice(1)), { inline: req.headers['x-inline'] === '1' });
      res.end('ok');
    } catch (e) { res.statusCode = 500; res.end('threw: ' + e.code); }
  });
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  const get = (name, inline) => new Promise((resolve, reject) => {
    const r = http.get({ port, path: '/' + encodeURIComponent(name), headers: inline ? { 'x-inline': '1' } : {} },
      (res) => {
        const c = [];
        res.on('data', (d) => c.push(d));
        res.on('end', () => resolve({ status: res.statusCode, cd: String(res.headers['content-disposition'] || ''), body: Buffer.concat(c).toString() }));
      });
    r.on('error', reject);
  });

  for (const n of NAMES) {
    const r = await get(n, false);
    ok(`A3 a REAL response accepts it: ${JSON.stringify(n.slice(0, 24))}`, r.status === 200 && !!r.cd);
  }

  // ------------------------------------------------------------ B. both halves
  {
    const r = await get('Ann O’Brien — Track Record (Verified).xlsx', false);
    ok('B1 the ASCII fallback is there for any client', /filename="[\x20-\x7E]+"/.test(r.cd));
    ok('B2 …and keeps the extension, which decides what opens it', /\.xlsx"/.test(r.cd));
    ok('B3 the real name rides the RFC 5987 parameter, so the reader gets it back exactly',
      r.cd.includes("filename*=UTF-8''")
      && decodeURIComponent(r.cd.split("filename*=UTF-8''")[1]) === 'Ann O’Brien — Track Record (Verified).xlsx');
    ok('B4 the fold is readable, never a row of underscores',
      /Ann O-Brien - Track Record \(Verified\)\.xlsx/.test(r.cd));
  }
  {
    const r = await get('preview me.pdf', true);
    ok('B5 an inline download says inline', r.cd.startsWith('inline;'));
    const r2 = await get('preview me.pdf', false);
    ok('B6 …and everything else is an attachment', r2.cd.startsWith('attachment;'));
  }

  // ------------------------------------------------------------ D. unchanged for ASCII
  {
    const plain = 'pilot-pipeline-2026-08-21.xlsx';
    const r = await get(plain, false);
    eq('D1 an ordinary filename is quoted exactly as the routes always quoted it',
      r.cd.split('; filename*=')[0], `attachment; filename="${plain}"`);
    eq('D2 …and a caller may keep its own ASCII fallback (serve-document’s safeName)',
      CD.contentDisposition('réal name.pdf', { ascii: 'real_name.pdf' }).split('; filename*=')[0],
      'attachment; filename="real_name.pdf"');
    eq('D3 nothing at all still produces a usable name',
      CD.contentDisposition('').split('; filename*=')[0], 'attachment; filename="download"');
    ok('D4 an absurd length is capped on both halves', CD.contentDisposition('a'.repeat(400) + '.pdf').length < 700);
  }

  server.close();
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('FAIL threw:', e && e.stack); process.exit(1); });
