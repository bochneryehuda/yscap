/**
 * scripts/render-fee-panel-rows.js — OUR FEE'S TWO PARTS, AS THE OFFICER ACTUALLY SEES THEM.
 *
 * OWNER-DIRECTED 2026-08-26, pointing at the studio's "Estimated fees & cash to close" block:
 * *"I want this broken down, not a full total."* It had been showing ONE combined row
 * ("UW / processing / legal $3,200.00") with both figures spelled out in a small sub-line — a
 * total with an explanation, which is not a breakdown. It now carries a row EACH, and the legal
 * row NAMES its rung so the officer can see why it is $2,000 rather than $995 without opening
 * the admin zone. The combined row survives only for a file carrying a typed whole-number total,
 * where there are no two figures to show.
 *
 * TWO TRAPS THIS HARNESS HAD TO LEARN, both of which made it green while measuring nothing:
 *   - The fee rows live in the structure drill-in, which is CLOSED by default, so every row read
 *     as hidden. It now asserts the panel actually opened before asserting anything in it.
 *   - That card TOGGLES, so a blind click shuts it again (the documented trap) — it is clicked
 *     only when `progDetail.offsetParent === null`.
 *
 * Browser-dependent, and IN `npm test` since 2026-09-04 — it SKIPs without
 * Playwright. The markup half is pinned by H7/H7a/H8 in `test-lender-fees-pure`, which runs in CI.
 */
const path=require('path'); let chromium=null;
for (const m of ['/opt/node22/lib/node_modules/playwright','playwright']) { try { ({chromium}=require(m)); break; } catch(_){} }
if (!chromium){ console.log('SKIP render-fee-panel-rows (no playwright)'); process.exit(0); }
const TOOL=path.join(__dirname,'..','web/v2/tools/term-sheet.html');
let pass=0,fail=0; const ok=(n,c)=>{c?(pass++,console.log('  ok  '+n)):(fail++,console.log('  FAIL '+n));};
const set=async(p,id,v)=>p.evaluate(([i,val])=>{const e=document.getElementById(i); if(!e) return; 
  if(e.tagName==='SELECT'){const o=[...e.options].find(o=>o.value===val||o.textContent.trim()===val); if(o)e.value=o.value;}
  else e.value=val; e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('change',{bubbles:true}));},[id,v]);
(async()=>{
  const b=await chromium.launch(); const page=await b.newPage({viewport:{width:1440,height:1000}});
  await page.goto('file://'+TOOL,{waitUntil:'load'}); await page.waitForTimeout(800);
  // A NJ ground-up: legal fee should be its own $2,000 row beside a $1,200 underwriting row.
  for (const [id,v] of [['dealType','Ground-up Construction'],['price','300000'],['construction','400000'],
                        ['arv','1100000'],['asIs','300000'],['fico','740'],['expGround','3'],['propState','NJ']]) await set(page,id,v);
  await page.waitForTimeout(900);
  // The fee rows live in the structure drill-in, which is closed by default. Open it ONLY if it
  // is closed — the card TOGGLES, so a blind click shuts it again (the documented trap).
  await page.evaluate(()=>{ const d=document.getElementById('progDetail');
    if (d && d.offsetParent===null) { const c=document.getElementById('stdCta'); if(c) c.click(); } });
  await page.waitForTimeout(700);
  const r=await page.evaluate(()=>{
    const vis=id=>{const e=document.getElementById(id); return !!e && e.offsetParent!==null;};
    const txt=id=>{const e=document.getElementById(id); return e?e.textContent.trim():null;};
    return {panelOpen:vis('progDetail'),uwRow:vis('rUwRow'),legalRow:vis('rLegalRow'),combined:vis('rLenderRow'),
            uw:txt('rUwFee'),legal:txt('rLegalFee'),legalLbl:txt('rLegalLbl'),oldSub:!!document.getElementById('rLenderSub')};
  });
  console.log('   ',JSON.stringify(r));
  ok('the structure panel actually opened (never assert on a hidden page)',r.panelOpen);
  ok('the two parts are their OWN rows, not a total',r.uwRow&&r.legalRow);
  ok('the combined row is hidden when the fee is split',!r.combined);
  ok('underwriting reads $1,200.00',r.uw==='$1,200.00');
  ok('legal reads $2,000.00 on a NJ ground-up',r.legal==='$2,000.00');
  ok('and the row SAYS why it is 2,000',/ground-up/i.test(r.legalLbl||''));
  ok('the old combined sub-line is gone from the markup',!r.oldSub);
  await b.close(); console.log(`\nrender-fee-panel-rows: ${pass} passed, ${fail} failed`); process.exit(fail?1:0);
})();
