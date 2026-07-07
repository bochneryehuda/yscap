/* =====================================================================
   YS Rehab Budget — Scope of Work builder (v2)
   1–10+ units · smart auto-placement · standard or per-unit budgets
   non-destructive mode switching · custom line items · validation
   detailed per-unit review · branded Excel + PDF export · import to resume
   state saved into the URL (#d=...)
   ===================================================================== */
const RB = (function(){
  "use strict";

  /* ---------- taxonomy (ROC-style categories; our line items) ---------- */
  const CATS = [
    { id:"soft",      label:"Soft Costs & Permits", cost:"soft", placement:"project",
      items:["Permits","Architectural / engineering","Survey","Inspections / testing","Interior design / drawings"] },
    { id:"genconds",  label:"General Conditions", cost:"soft", placement:"project", types:["heavy","ground"],
      items:["Supervision / project management","Temporary utilities","Temporary toilet","Dumpsters / debris","Equipment rental","Builder's risk / liability insurance"] },
    { id:"demo",      label:"Demolition", cost:"hard", placement:"unit",
      items:["Interior demolition","Exterior demolition","Dumpster / trash-out","Hazmat / mold remediation"] },
    { id:"site",      label:"Site Work", cost:"hard", placement:"exterior",
      items:["Grading / drainage","Driveway / walkway","Landscaping","Fencing","Tree removal","Retaining wall"] },
    { id:"siteutil",  label:"Site & Utilities", cost:"hard", placement:"exterior", types:["heavy","ground"],
      items:["Excavation / earthwork","Water service / tap","Sewer connection / septic","Electric service","Gas service","Storm drainage","Well"] },
    { id:"foundation",label:"Foundation & Structural", cost:"hard", placement:"unit",
      items:["Foundation repair","Structural framing","Beams / posts / supports","Waterproofing","Underpinning"] },
    { id:"shell",     label:"Foundation & Framing (new build)", cost:"hard", placement:"unit", types:["ground"],
      items:["Footings","Foundation walls","Slab","Framing package","Sheathing","Roof trusses","Structural steel"] },
    { id:"exterior",  label:"Exterior", cost:"hard", placement:"exterior",
      items:["Roof","Siding","Windows","Exterior doors","Gutters & downspouts","Exterior paint","Porch / deck","Garage door","Soffit / fascia"] },
    { id:"interior",  label:"Interior", cost:"hard", placement:"unit",
      items:["Framing / drywall","Insulation","Interior doors","Trim / millwork","Interior paint","Stairs / railings","Closets / shelving"] },
    { id:"flooring",  label:"Flooring", cost:"hard", placement:"unit",
      items:["Hardwood","Luxury vinyl / laminate","Tile","Carpet","Subfloor repair"] },
    { id:"mep",       label:"Services — MEP", cost:"hard", placement:"unit",
      items:["Electrical — rough","Electrical — finish","Panel / service upgrade","Plumbing — rough","Plumbing — finish","Water heater","HVAC system","Ductwork"] },
    { id:"kitchen",   label:"Kitchen", cost:"hard", placement:"unit",
      items:["Cabinets","Countertops","Backsplash","Sink & faucet","Kitchen flooring","Lighting"] },
    { id:"baths",     label:"Bathrooms", cost:"hard", placement:"unit",
      items:["Full bath remodel","Tub / shower","Vanity & top","Toilet","Tile","Fixtures"] },
    { id:"appliances",label:"Appliances", cost:"hard", placement:"unit",
      items:["Refrigerator","Range / oven","Dishwasher","Microwave","Washer / dryer"] },
    { id:"basement",  label:"Basement", cost:"hard", placement:"unit",
      items:["Finish basement","Egress window","Sump pump","Basement waterproofing"] },
    { id:"special",   label:"Special Construction", cost:"hard", placement:"project",
      items:["Pool / spa","ADU / addition","Solar","Other"] },
    { id:"final",     label:"Final Clean-Up", cost:"hard", placement:"project",
      items:["Final cleaning","Punch list","Staging"] },
    { id:"other",     label:"Additional / custom line items", cost:"hard", placement:"unit", items:[] }
  ];
  const CAT={}; CATS.forEach(c=>CAT[c.id]=c);
  const STEPS=[
    { id:"start",  label:"Property" },
    { id:"value",  label:"Value drivers" },
    { id:"scope",  label:"Scope of work" },
    { id:"budget", label:"Budget" },
    { id:"review", label:"Review" }
  ];

  /* ---------- smart auto-placement ---------- */
  function smartPlace(cid,name){
    const n=(name||"").toLowerCase();
    if(/solar/.test(n)) return "project";
    if(/pool|spa\b/.test(n)) return "exterior";
    if(/landscap|grading|driveway|walkway|sidewalk|fenc|tree|retaining|excavat|grade|septic|\bwell\b|site/.test(n)) return "exterior";
    if(/roof|siding|gutter|soffit|fascia|exterior|porch|deck|garage door/.test(n)) return "exterior";
    if(/permit|architect|engineer|survey|inspection|design|drawing|\bplan/.test(n)) return "project";
    if(/final clean|punch|staging|dumpster|trash|hauling/.test(n)) return "project";
    if(/adu|addition/.test(n)) return "project";
    return CAT[cid] ? CAT[cid].placement : "unit";
  }

  /* ---------- team directory (from the home page) ---------- */
  const TEAM=[
    { g:"Sales & Loan Coordinators", people:[
      {n:"Yehuda Bochner",r:"President",e:"Yehuda@yscapgroup.com"},
      {n:"Mendel Bochner",r:"Sales Manager",e:"Mendelb@yscapgroup.com"},
      {n:"Solomon Katz",r:"Loan Coordinator",e:"Solomon@yscapgroup.com"},
      {n:"Yosef Cohen",r:"Loan Coordinator",e:"Yosef@yscapgroup.com"},
      {n:"Moshe Mermelstein",r:"Loan Coordinator",e:"Moshe@yscapgroup.com"},
      {n:"Shia Kaff",r:"Loan Coordinator",e:"Shia@yscapgroup.com"},
      {n:"Joshua Friedlander",r:"Loan Coordinator",e:"Joshua@yscapgroup.com"},
      {n:"Abraham Eisen",r:"Loan Coordinator",e:"Abraham@yscapgroup.com"},
      {n:"Mendel Schwimmer",r:"Loan Coordinator",e:"Mendel@yscapgroup.com"},
      {n:"Solomon Weiss",r:"Loan Coordinator",e:"Sol@yscapgroup.com"},
      {n:"Isaac Zadmehr",r:"Loan Coordinator",e:"Isaac@yscapgroup.com"},
      {n:"Josef Schnitzler",r:"Loan Coordinator",e:"Josef@yscapgroup.com"},
      {n:"Chaim Lebowitz",r:"Loan Coordinator",e:"Chaim@yscapgroup.com"},
      {n:"Pinchus Wieder",r:"Loan Coordinator",e:"Pinchus@yscapgroup.com"},
      {n:"Yisroel Weinstock",r:"Loan Coordinator",e:"Yisroel@yscapgroup.com"},
      {n:"Simcha Shedrowitzky",r:"Loan Coordinator",e:"Simcha@yscapgroup.com"} ]},
    { g:"Operations & Back Office", people:[
      {n:"Esther Bochner",r:"MLO & Operations Manager",e:"Esther@yscapgroup.com"},
      {n:"Malky Katz",r:"Closer & Funder Manager",e:"Malky@yscapgroup.com"},
      {n:"Yonah Rapapaort",r:"Processing Manager",e:"Yonah@yscapgroup.com"},
      {n:"Goldy Rosenberg",r:"Senior Loan Processor",e:"Goldy@yscapgroup.com"},
      {n:"Ezra Green",r:"RTL Loan Processor",e:"Ezra@yscapgroup.com"},
      {n:"Sarah Amsel",r:"Loan Processor",e:"Sarah@yscapgroup.com"},
      {n:"Chaya Gruber",r:"Loan Setup",e:"Chaya@yscapgroup.com"},
      {n:"Lisa Katz",r:"Draw Coordinator",e:"Lisa@yscapgroup.com"} ]}
  ];

  /* ---------- Smart Scope templates (auto-select line items) ---------- */
  // each include entry is "catId:index"; cont sets a suggested contingency %
  const TEMPLATES={
    cosmetic:[
      { id:"cos1", name:"Basic Cosmetic Refresh", desc:"Paint, new flooring, and a clean-up — the lightest turn.", cont:10,
        items:["interior:4","flooring:1","mep:1","final:0"] },
      { id:"cos2", name:"Cosmetic + Kitchen & Baths", desc:"A refresh plus a light kitchen and bath update and new appliances.", cont:10,
        items:["interior:4","flooring:1","kitchen:0","kitchen:1","kitchen:3","kitchen:5","baths:2","baths:3","baths:5","appliances:1","appliances:2","mep:1","final:0"] },
      { id:"cos3", name:"Full Cosmetic Flip", desc:"Everything cosmetic inside and out, ready to list.", cont:12,
        items:["demo:2","interior:3","interior:4","flooring:1","flooring:2","kitchen:0","kitchen:1","kitchen:2","kitchen:3","kitchen:5","baths:0","appliances:0","appliances:1","appliances:2","exterior:5","mep:1","final:0","final:1"] }
    ],
    moderate:[
      { id:"mod1", name:"Standard Moderate Rehab", desc:"Demo, kitchen & baths, flooring, paint, trim, finish MEP, appliances, exterior touch-up.", cont:12,
        items:["demo:0","demo:2","kitchen:0","kitchen:1","kitchen:3","kitchen:5","baths:0","baths:4","flooring:1","flooring:2","interior:2","interior:3","interior:4","mep:1","mep:4","appliances:0","appliances:1","appliances:2","exterior:5","final:0","final:1"] },
      { id:"mod2", name:"Moderate + Systems", desc:"A standard rehab plus HVAC, water heater and a panel/service refresh.", cont:13,
        items:["demo:0","demo:2","kitchen:0","kitchen:1","kitchen:3","kitchen:5","baths:0","flooring:1","flooring:2","interior:2","interior:3","interior:4","mep:1","mep:4","mep:5","mep:6","mep:2","appliances:0","appliances:1","appliances:2","exterior:5","final:0","final:1"] }
    ],
    heavy:[
      { id:"hvy1", name:"Heavy / Gut Rehab", desc:"To the studs: permits, demo, framing, insulation, full MEP rough+finish, HVAC, kitchen, baths, flooring, paint, exterior, clean-up.", cont:15,
        items:["soft:0","demo:0","demo:2","interior:0","interior:1","interior:3","interior:4","mep:0","mep:1","mep:3","mep:4","mep:5","mep:6","mep:7","kitchen:0","kitchen:1","kitchen:3","kitchen:5","baths:0","flooring:1","flooring:2","exterior:0","exterior:5","final:0","final:1"] },
      { id:"hvy2", name:"Gut + Structural & Exterior", desc:"A full gut plus foundation/structural work and a full exterior (roof, siding, windows).", cont:15,
        items:["soft:0","soft:1","demo:0","demo:1","demo:2","foundation:0","foundation:1","foundation:3","interior:0","interior:1","interior:3","interior:4","mep:0","mep:1","mep:3","mep:4","mep:5","mep:6","mep:7","kitchen:0","kitchen:1","kitchen:3","kitchen:5","baths:0","flooring:1","flooring:2","exterior:0","exterior:1","exterior:2","exterior:5","site:0","final:0","final:1"] }
    ]
  };
  const TEMPLATES_EXTRA=[
    { id:"rental", name:"Rental Turnover", desc:"Fast make-ready: paint, flooring repair, appliances, basic fixtures, clean & punch.", cont:10, types:["cosmetic","moderate"],
      items:["interior:4","flooring:4","flooring:1","appliances:0","appliances:1","baths:5","mep:1","final:0","final:1"] },
    { id:"mf", name:"Multifamily Unit Package", desc:"A standard per-unit scope — kitchen, bath, flooring, paint and appliances in every unit. Add common-area / exterior on the next step.", cont:12, multiOnly:true,
      items:["kitchen:0","kitchen:1","kitchen:3","kitchen:5","baths:0","flooring:1","interior:4","appliances:0","appliances:1","appliances:2","final:0"] }
  ];
  function templatesFor(){ let out=(TEMPLATES[S.projType]||[]).slice();
    TEMPLATES_EXTRA.forEach(t=>{ if(t.multiOnly && !isMulti()) return; if(t.types && t.types.indexOf(S.projType)<0 && !(t.multiOnly&&isMulti())) return; out.push(t); });
    return out; }
  // Items implied by what the borrower told the appraiser they're changing.
  function valueDriverItems(){ const vd=S.vd, ks=[];
    if(vd.baths===true){ ks.push("baths:0","baths:4","mep:3","mep:4"); }                       // full bath remodel, tile, plumbing rough + finish
    if(vd.beds===true){ ks.push("interior:0","interior:1","interior:2","mep:0","mep:1"); }      // framing/drywall, insulation, doors, electrical rough + finish
    if(vd.expand===true){ ks.push("soft:1","interior:0","interior:1","foundation:1","exterior:0","exterior:1","mep:0","mep:3","mep:6"); } // arch/eng, framing, insulation, structural framing, roof, siding, elec rough, plumb rough, HVAC
    if(vd.basement===true){ ks.push("basement:0","basement:1","basement:3","interior:1","mep:1"); } // finish, egress, waterproofing, insulation, electrical finish
    if(vd.adu===true){ ks.push("soft:1","special:1","foundation:1","interior:0","mep:0","mep:3","mep:6","kitchen:0","baths:0"); } // arch, ADU line, framing, elec, plumb, HVAC, kitchen, bath
    if(vd.layout===true){ ks.push("demo:0","interior:0"); }                                      // interior demo + reframe/drywall
    if(vd.curb===true){ ks.push("exterior:5","site:2","exterior:6"); }                           // exterior paint, landscaping, porch/deck
    return ks; }
  // Permits/architectural are only pulled in when the work genuinely needs them:
  // heavy or ground-up, square-footage expansion, an ADU/addition, or structural work.
  function permitsWarranted(tpl){
    if(S.projType==="heavy"||S.projType==="ground") return true;
    if(S.vd.expand===true||S.vd.adu===true) return true;
    return (tpl.items||[]).concat(valueDriverItems()).some(k=>/^(foundation|shell|siteutil):/.test(k));
  }
  function applyTemplate(tpl){
    Object.keys(S.items).forEach(k=>{ if(!isCustom(k)) S.items[k].on=false; });
    S.cats={};
    let items=tpl.items.concat(valueDriverItems());
    if(!permitsWarranted(tpl)) items=items.filter(k=> k!=="soft:0" && k!=="soft:1"); // don't auto-add permits/arch on simple jobs
    items.forEach(k=>{ if(metaOf(k).cat==="other") return; const cid=k.split(":")[0]; if(!CAT[cid]) return;
      if(isMulti() && !S.doExterior && CAT[cid].placement==="exterior") return;
      if(c2gated(cid)) return;                       // respect project-type category gating
      st(k).on=true; S.cats[cid]=true; });
    S.appliedTemplate=tpl.name; templateNote=tpl.name;   // never prefill contingency/GC — the borrower enters those
  }
  // true if a category is hidden for the current project type (so we never auto-check it)
  function c2gated(cid){ const c=CAT[cid]; if(!c) return true; if(c.types && (!S.projType || c.types.indexOf(S.projType)<0)) return true; return false; }
  function openSmartBuilder(){
    let ov=document.getElementById("rb-smartov"); if(ov) ov.remove();
    const tpls=templatesFor(); const vd=S.vd; const ctx=[];
    if(vd.expand)ctx.push("adding square footage"); if(vd.beds)ctx.push("adding bedrooms"); if(vd.baths)ctx.push("adding bathrooms"); if(vd.basement)ctx.push("finishing the basement"); if(vd.layout)ctx.push("changing the layout"); if(vd.adu)ctx.push("an ADU / addition"); if(vd.curb)ctx.push("curb appeal");
    const PROJ={cosmetic:"cosmetic",moderate:"moderate",heavy:"heavy / gut",ground:"ground-up"};
    const ctxLine=(S.projType?("a "+PROJ[S.projType]+" project"):"your project")+(isMulti()?(" · "+unitCount()+" units"):" · single-family")+(ctx.length?(" · "+ctx.join(", ")):"");
    ov=document.createElement("div"); ov.id="rb-smartov"; ov.className="rb-ov";
    ov.innerHTML='<div class="rb-ov-box"><button class="rb-ov-x" aria-label="Close">✕</button>'+
      '<h3>Smart Scope Builder</h3>'+
      '<p>Tailored to <b>'+esc(ctxLine)+'</b>. Each package checks a typical scope for this kind of job and adds the items the appraiser will want for what you\'re changing. Permits are only pulled in when the work needs them (structural, added square footage, an addition, or a gut). Pick one, then price everything — including contingency and any GC fee — yourself before continuing.</p>'+
      '<div class="rb-ov-tpls">'+tpls.map(t=>'<button class="rb-tpl'+(S.appliedTemplate===t.name?" on":"")+'" data-tpl="'+t.id+'"><span class="rb-tpl-name">'+esc(t.name)+'</span><span class="rb-tpl-desc">'+esc(t.desc)+'</span><span class="rb-tpl-apply">'+(S.appliedTemplate===t.name?"✓ Applied":"Use this package →")+'</span></button>').join("")+'</div></div>';
    document.body.appendChild(ov); document.body.style.overflow="hidden";
    const close=()=>{ ov.remove(); document.body.style.overflow=""; document.removeEventListener("keydown",onKey); };
    const onKey=e=>{ if(e.key==="Escape") close(); };
    document.addEventListener("keydown",onKey);
    ov.addEventListener("click",e=>{ if(e.target===ov) close(); });
    ov.querySelector(".rb-ov-x").onclick=close;
    ov.querySelectorAll("[data-tpl]").forEach(b=> b.onclick=()=>{ const t=templateById(b.dataset.tpl); if(t) applyTemplate(t); close(); scopeNote=""; render(); });
  }
  let templateNote="";
  function templateById(id){ let all=[]; Object.keys(TEMPLATES).forEach(k=> all=all.concat(TEMPLATES[k])); all=all.concat(TEMPLATES_EXTRA); return all.find(t=>t.id===id); }

  /* ---------- state ---------- */
  function blank(){ return {
    txn:"", address:"", propType:"", units:1, doExterior:false, doCommon:false,
    budgetMode:"standard", projType:"", months:"", narrative:"", target:"", appliedTemplate:"",
    vd:{ expand:null, sqftNow:"", sqftAfter:"", beds:null, bedsNow:"", bedsAfter:"",
         baths:null, bathsNow:"", bathsAfter:"", basement:null, basementNotes:"",
         layout:null, layoutNotes:"", adu:null, aduNotes:"", curb:null, curbNotes:"", other:"" },
    cats:{}, items:{}, custom:[], cont:{ mode:"pct", value:"" }, gcFee:{ mode:"pct", value:"" }
  };}
  let S=blank(); let step=0; let scopeNote="";

  /* ---------- helpers ---------- */
  const $=s=>document.querySelector(s);
  const num=v=>{ const n=parseFloat(String(v==null?"":v).replace(/[^0-9.\-]/g,"")); return isFinite(n)?n:0; };
  const money=n=>"$"+(Math.round(n)).toLocaleString("en-US");
  const esc=s=>String(s==null?"":s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");

  function isMulti(){ return unitCount()>1; }
  function unitCount(){ if(S.propType==="single") return 1; return Math.max(1, parseInt(S.units,10)||1); }

  // key helpers: taxonomy "cid:idx"  |  custom "x:id"
  function isCustom(key){ return key.indexOf("x:")===0; }
  function metaOf(key){
    const ov = S.items[key] && S.items[key].label;
    if(isCustom(key)){ const id=key.slice(2); const c=S.custom.find(x=>x.id===id)||{cat:"other",name:""};
      return { cat:c.cat, name:(ov||c.name), cost:"hard", placement:smartPlace(c.cat,c.name) }; }
    const [cid,i]=key.split(":"); const orig=CAT[cid].items[+i]; return { cat:cid, name:(ov||orig), cost:CAT[cid].cost, placement:smartPlace(cid,orig) };
  }
  function defApplies(key){ const p=metaOf(key).placement; if(p!=="unit") return p; return (isMulti() && S.budgetMode==="separate") ? "split" : "each"; }
  function st(key){ if(!S.items[key]) S.items[key]={on:false,desc:"",applies:defApplies(key),each:"",u:{},common:"",exterior:"",project:"",pct:"",perUnitDesc:false,ud:{},label:""}; return S.items[key]; }
  function getItem(cid,i){ return st(cid+":"+i); }

  function sections(){
    if(!isMulti()) return [{key:"all",label:"Project",kind:"all"}];
    const out=[]; for(let u=1;u<=unitCount();u++) out.push({key:"u"+u,label:"Unit "+u,kind:"unit"});
    if(S.doCommon)   out.push({key:"common",label:"Common areas",kind:"common"});
    if(S.doExterior) out.push({key:"exterior",label:"Exterior",kind:"exterior"});
    out.push({key:"project",label:"Project-wide",kind:"project"});
    return out;
  }
  function appliesOptions(){
    const o=[{v:"each",t:"Same each unit"},{v:"split",t:"Per unit (split)"}];
    if(S.doCommon)   o.push({v:"common",t:"Common areas"});
    if(S.doExterior) o.push({v:"exterior",t:"Exterior"});
    o.push({v:"project",t:"Project-wide"});
    return o;
  }
  function lineTotal(key){
    const it=st(key); if(!it.on) return 0;
    if(!isMulti()) return num(it.each);
    switch(it.applies){
      case "each":   return num(it.each)*unitCount();
      case "split":  { let s=0; for(let u=1;u<=unitCount();u++) s+=num(it.u["u"+u]); return s; }
      case "common": return num(it.common);
      case "exterior": return num(it.exterior);
      default:       return num(it.project);
    }
  }
  function lineSectionVal(key,secKey){
    const it=st(key); if(!it.on) return 0;
    if(!isMulti()) return secKey==="all"?num(it.each):0;
    if(it.applies==="each")    return secKey.indexOf("u")===0 ? num(it.each):0;
    if(it.applies==="split")   return secKey.indexOf("u")===0 ? num(it.u[secKey]):0;
    if(it.applies==="common")  return secKey==="common" ? num(it.common):0;
    if(it.applies==="exterior")return secKey==="exterior" ? num(it.exterior):0;
    return secKey==="project" ? num(it.project):0;
  }
  function representative(it){ if(num(it.each)) return num(it.each);
    for(let u=1;u<=unitCount();u++){ if(num(it.u["u"+u])) return num(it.u["u"+u]); }
    return num(it.common)||num(it.exterior)||num(it.project)||""; }
  function changeApplies(key,to){ const it=st(key); const rep=representative(it);
    if(to==="split"){ for(let u=1;u<=unitCount();u++){ const k="u"+u; if(!num(it.u[k])) it.u[k]= rep||""; } }
    else if(to==="each"){ if(!num(it.each)) it.each=rep||""; }
    else if(to==="common"){ if(!num(it.common)) it.common=rep||""; }
    else if(to==="exterior"){ if(!num(it.exterior)) it.exterior=rep||""; }
    else if(to==="project"){ if(!num(it.project)) it.project=rep||""; }
    it.applies=to;
  }
  function applyBudgetMode(){ const want=(S.budgetMode==="separate")?"split":"each";
    Object.keys(S.items).forEach(k=>{ const it=S.items[k]; if(it.applies==="each"||it.applies==="split"){ if(it.applies!==want) changeApplies(k,want); } });
  }

  // chosen taxonomy item indexes for a category
  function chosenItems(cid){ const out=[]; if(!CAT[cid]) return out; CAT[cid].items.forEach((nm,i)=>{ if(st(cid+":"+i).on) out.push(i); }); return out; }
  function customKeys(cid){ return S.custom.filter(c=>c.cat===cid).map(c=>"x:"+c.id); }
  function groupKeys(cid){ return chosenItems(cid).map(i=>cid+":"+i).concat(customKeys(cid)); }
  function activeGroups(){ return CATS.filter(c=> groupKeys(c.id).length || c.id==="other"); }
  function allActiveKeys(){ let ks=[]; CATS.forEach(c=> ks=ks.concat(groupKeys(c.id))); return ks; }
  function catTotal(cid){ let s=0; groupKeys(cid).forEach(k=> s+=lineTotal(k)); return s; }

  function subtotal(){ let s=0; allActiveKeys().forEach(k=> s+=lineTotal(k)); return s; }
  function softTotal(){ let s=0; allActiveKeys().forEach(k=>{ if(metaOf(k).cost==="soft") s+=lineTotal(k); }); return s; }
  function hardTotal(){ let s=0; allActiveKeys().forEach(k=>{ if(metaOf(k).cost!=="soft") s+=lineTotal(k); }); return s; }
  function contingency(){ const stt=subtotal(); return S.cont.mode==="pct" ? stt*num(S.cont.value)/100 : num(S.cont.value); }
  function gcFeeAmt(){ const stt=subtotal(); return S.gcFee.mode==="pct" ? stt*num(S.gcFee.value)/100 : num(S.gcFee.value); }
  function grand(){ return subtotal()+contingency()+gcFeeAmt(); }

  /* ---------- URL save / restore ---------- */
  function snap(){ const o=JSON.parse(JSON.stringify(S)); const keep={};
    Object.keys(o.items||{}).forEach(k=>{ const it=o.items[k];
      const has=it.on||it.desc||it.each||it.common||it.exterior||it.project||it.pct||it.label||(it.u&&Object.keys(it.u).some(u=>it.u[u]));
      if(has) keep[k]=it; }); o.items=keep; return o; }
  function enc(o){ return btoa(unescape(encodeURIComponent(JSON.stringify(o)))).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,""); }
  function dec(s){ try{ let b=String(s).replace(/-/g,"+").replace(/_/g,"/"); while(b.length%4)b+="="; return JSON.parse(decodeURIComponent(escape(atob(b)))); }catch(e){ return null; } }
  let saveT;
  function save(){ clearTimeout(saveT); saveT=setTimeout(()=>{ try{ history.replaceState(null,"","#d="+enc(snap())+"&s="+step); }catch(e){}
    // Portal bridge hook: when the tool is opened from a loan file, every
    // change also autosaves onto that file's Scope of Work condition.
    if(window.RB_PORTAL_ONSAVE){ try{ window.RB_PORTAL_ONSAVE(snap()); }catch(e){} }
  },250); }
  function shareUrl(){ return location.origin+location.pathname+"#d="+enc(snap()); }
  function restore(){ const m=/[#&]d=([^&]+)/.exec(location.hash||""); if(m){ const o=dec(m[1]); if(o){ S=Object.assign(blank(),o); S.vd=Object.assign(blank().vd,o.vd||{}); S.cont=Object.assign(blank().cont,o.cont||{}); S.gcFee=Object.assign(blank().gcFee,o.gcFee||{}); S.custom=o.custom||[]; const sm=/[#&]s=(\d+)/.exec(location.hash||""); if(sm){ step=Math.max(0,Math.min(STEPS.length-1,parseInt(sm[1],10)||0)); } return true; } } return false; }
  function flash(msg){ const f=$("#rb-flash"); f.textContent=msg; f.classList.add("show"); clearTimeout(flash._t); flash._t=setTimeout(()=>f.classList.remove("show"),2600); }
  async function share(btn){ save(); const url=shareUrl(); let ok=false; try{ if(navigator.clipboard&&navigator.clipboard.writeText){ await navigator.clipboard.writeText(url); ok=true; } }catch(e){} if(!ok){ try{ window.prompt("Copy this link:",url); return; }catch(e){} } if(btn){ const o=btn.textContent; btn.textContent="Link copied ✓"; setTimeout(()=>btn.textContent=o,1800);} flash("Link copied — it saves your whole scope of work."); }

  /* ===================== RENDER ===================== */
  function renderSteps(){
    const wrap=$("#rb-steps"); wrap.innerHTML="";
    STEPS.forEach((s,i)=>{ const el=document.createElement("div");
      el.className="rb-step"+(i===step?" active":"")+(i<step?" done":"");
      el.innerHTML='<span class="dot">'+(i<step?"✓":(i+1))+'</span><span class="lbl">'+s.label+'</span>';
      el.onclick=()=>{ commit(); step=i; render({scroll:true}); };
      wrap.appendChild(el);
      if(i<STEPS.length-1){ const a=document.createElement("span"); a.className="arrow"; a.textContent="—"; wrap.appendChild(a); }
    });
  }
  function render(opts){
    const keepY=(!opts||!opts.scroll)?window.scrollY:null;
    renderSteps();
    const b=$("#rb-body");
    if(STEPS[step].id==="start")  b.innerHTML=viewStart();
    if(STEPS[step].id==="value")  b.innerHTML=viewValue();
    if(STEPS[step].id==="scope")  b.innerHTML=viewScope();
    if(STEPS[step].id==="budget") b.innerHTML=viewBudget();
    if(STEPS[step].id==="review") b.innerHTML=viewReview();
    renderNav(); bind();
    if(window.RB_PORTAL_ONRENDER){ try{ window.RB_PORTAL_ONRENDER(); }catch(e){} }
    if(opts&&opts.scroll){ window.scrollTo({top:0,behavior:"smooth"}); }
    else if(keepY!=null){ const h=document.documentElement,p=h.style.scrollBehavior; h.style.scrollBehavior="auto"; window.scrollTo(0,keepY); h.style.scrollBehavior=p; }
    save();
  }

  /* ----- step 1 ----- */
  function viewStart(){
    let unitPick="";
    if(S.propType==="multi"){
      unitPick='<div class="rb-grid three" style="margin-top:1rem">'+field("Number of units","u",'<div class="rb-inp"><select id="f-units">'+[2,3,4].map(u=>'<option value="'+u+'"'+(unitCount()===u?" selected":"")+'>'+u+' units</option>').join("")+'</select></div>')+'</div>';
    } else if(S.propType==="large"){
      unitPick='<div class="rb-grid three" style="margin-top:1rem">'+field("How many units? <span class=\"hint\">(5 or more)</span>","u",'<div class="rb-inp"><input id="f-units" type="number" min="5" max="40" step="1" value="'+(unitCount()<5?5:unitCount())+'"></div>')+'</div>';
    }
    return '<div class="rb-card">'+
      '<h2>Let\'s set up the property</h2>'+
      '<p class="sub">A few basics so we only ask what matters. You can change any of this later — nothing gets lost.</p>'+
      '<div class="rb-sec-title">Transaction'+iTip("Purchase = you're buying the property. Refinance = you already own it, so we'll also ask how much of each item is already finished.")+'</div>'+
      '<div class="rb-choice" data-choice="txn">'+choiceBtn("txn","purchase","Purchase","Buying the property")+choiceBtn("txn","refi","Refinance","You already own it")+'</div>'+
      '<div class="rb-sec-title">Property</div>'+
      '<div class="rb-grid">'+
        field("Property address","address",'<div class="rb-inp"><input id="f-address" type="text" placeholder="123 Main St, City, State ZIP" autocomplete="off" value="'+esc(S.address)+'"></div>')+
        field("How many months will the project take? <span class=\"hint\">(optional)</span>","months",'<div class="rb-inp"><input id="f-months" type="number" min="0" placeholder="e.g. 6" value="'+esc(S.months)+'"></div>')+
      '</div>'+
      '<div class="rb-sec-title">Property type'+iTip("Single-family is one combined scope — simplest. 2–4 or 5+ units let you budget each unit on its own and adds unit columns to your export.")+'</div>'+
      '<div class="rb-choice" data-choice="propType">'+
        choiceBtn("propType","single","Single-family","1 unit — one combined scope")+
        choiceBtn("propType","multi","2–4 units","Small multifamily")+
        choiceBtn("propType","large","5+ units","Larger multifamily")+
      '</div>'+ unitPick +
      '<div class="rb-sec-title">Project type'+iTip("Sets which categories appear. Cosmetic = paint/floors/fixtures. Heavy/gut = down to the studs. Ground-up = new construction (adds site, foundation & framing).")+' <span style="text-transform:none;letter-spacing:0;color:var(--muted-2);font-weight:400">— tailors which categories and line items appear</span></div>'+
      '<div class="rb-choice" data-choice="projType">'+
        choiceBtn("projType","cosmetic","Cosmetic","Paint, floors, fixtures — light refresh")+
        choiceBtn("projType","moderate","Moderate","Kitchens, baths, some systems")+
        choiceBtn("projType","heavy","Heavy / gut","To the studs, structural, full systems")+
        choiceBtn("projType","ground","Ground-up","New construction")+
      '</div>'+
      '<div class="rb-sec-title">Target rehab budget'+iTip("Optional. If you have a number in mind, we'll show how much you have left to allocate — or how far over you are — as you price the work.")+' <span style="text-transform:none;letter-spacing:0;color:var(--muted-2);font-weight:400">(optional — we\'ll track how close you are)</span></div>'+
      '<div class="rb-grid">'+field("Your target scope-of-work total","target",'<div class="rb-inp money"><input id="f-target" type="text" inputmode="decimal" placeholder="e.g. 75,000" value="'+esc(S.target)+'"></div>')+'</div>'+
      '<div class="rb-sec-title">Project narrative</div>'+
      '<div class="rb-grid one">'+field("Describe the project <span class=\"hint\">— the more detail, the better the appraisal outcome</span>","narrative",'<div class="rb-inp"><textarea id="f-narr" placeholder="What\'s being done inside and out? Any additions, conversions, or layout changes?">'+esc(S.narrative)+'</textarea></div>')+'</div>'+
    '</div>';
  }

  /* ----- step 2 ----- */
  function vTwoNum(k1,l1,k2,l2,half){ const step=half?' step="0.5"':''; return '<div class="rb-grid"><div class="rb-f"><label>'+l1+'</label><div class="rb-inp"><input data-vd="'+k1+'" type="number"'+step+' value="'+esc(S.vd[k1])+'"></div></div><div class="rb-f"><label>'+l2+'</label><div class="rb-inp"><input data-vd="'+k2+'" type="number"'+step+' value="'+esc(S.vd[k2])+'"></div></div></div>'; }
  function vOneText(k,ph){ return '<div class="rb-grid one"><div class="rb-f"><div class="rb-inp"><input data-vd="'+k+'" type="text" placeholder="'+ph+'" value="'+esc(S.vd[k])+'"></div></div></div>'; }
  function vCard(key,icon,title,detail){ const on=S.vd[key]===true; return '<div class="rb-vcard'+(on?" on":"")+'" data-vcard="'+key+'"><div class="rb-vcard-head"><span class="rb-vcard-chk">'+(on?"✓":"+")+'</span><span class="rb-vcard-ic">'+icon+'</span><span class="rb-vcard-title">'+title+'</span></div>'+(on?('<div class="rb-vcard-body">'+detail+'</div>'):'')+'</div>'; }
  function viewValue(){
    return '<div class="rb-card">'+
      '<h2>What should the appraiser know?'+iTip("Tap anything you're doing that adds value. We don't ask what it'll be worth — we capture the improvements an appraiser rewards, and they flow onto your scope of work.")+'</h2>'+
      '<p class="sub">Tap the ones that apply and add a quick detail — skip the rest. The more the appraiser can see, the stronger your after-repair value.</p>'+
      '<div class="rb-vgrid">'+
        vCard("expand","◳","Adding square footage", vTwoNum("sqftNow","Sq ft now","sqftAfter","Sq ft after"))+
        vCard("beds","🛏","Adding bedrooms", vTwoNum("bedsNow","Bedrooms now","bedsAfter","Bedrooms after"))+
        vCard("baths","🛁","Adding bathrooms", vTwoNum("bathsNow","Bathrooms now","bathsAfter","Bathrooms after",true))+
        vCard("basement","▤","Finishing the basement", vOneText("basementNotes","e.g. finish 600 sf, add egress + full bath"))+
        vCard("layout","⌗","Changing the layout", vOneText("layoutNotes","e.g. open up kitchen/living, relocate walls"))+
        vCard("adu","⌂","Adding an ADU / addition", vOneText("aduNotes","e.g. garage conversion to studio ADU"))+
        vCard("curb","❉","Improving exterior / curb appeal", vOneText("curbNotes","e.g. new siding, landscaping, front porch"))+
      '</div>'+
      '<div class="rb-sec-title">Anything else that adds value?</div>'+
      '<div class="rb-grid one"><div class="rb-f"><div class="rb-inp"><input data-vd="other" type="text" placeholder="Tell the appraiser…" value="'+esc(S.vd.other)+'"></div></div></div>'+
      '<p class="rb-note">These notes flow onto your scope of work so the appraiser sees exactly what\'s improving.</p>'+
    '</div>';
  }

  /* ----- step 3 ----- */
  function viewScope(){
    let setup="";
    if(isMulti()){
      setup='<div class="rb-card"><h2>How is the work split?</h2><p class="sub">We\'ll only show the columns you actually need.</p>'+
        '<div class="rb-grid">'+ynRow("Doing work on the building exterior / site?","doExterior")+ynRow("Doing work in shared common areas?","doCommon")+'</div>'+
        '<div class="rb-sec-title">How do you want to budget the units?'+iTip("Standard budget = the same spec across every unit; price it once and we multiply. Separate budget = price each unit individually (one column per unit).")+'</div>'+
        '<div class="rb-choice" data-choice="budgetMode">'+
          choiceBtn("budgetMode","standard","One standard budget","Same spec across every unit — we apply it to all "+unitCount()+" units")+
          choiceBtn("budgetMode","separate","Separate budget per unit","Price each unit on its own ("+unitCount()+" columns)")+
        '</div></div>';
    }
    const cats=CATS.filter(c=>c.id!=="other").map(c=>{
      if(c.types && (!S.projType || c.types.indexOf(S.projType)<0)) return "";
      if(isMulti() && !S.doExterior && c.placement==="exterior") return "";
      const on=!!S.cats[c.id]; const chosen=chosenItems(c.id).length;
      return '<div class="rb-cat'+(on?" on":"")+(on?" open":"")+'" data-cat="'+c.id+'">'+
        '<div class="rb-cat-head" data-toggle="'+c.id+'"><span class="chk">'+(on?"✓":"")+'</span><span class="nm">'+c.label+'</span>'+
        (on?('<span class="cnt">'+chosen+' selected</span>'):('<span class="ct">'+(c.cost==="soft"?"Soft cost":"Hard cost")+'</span>'))+'</div>'+
        '<div class="rb-cat-items">'+c.items.map((nm,i)=>{ const it=st(c.id+":"+i);
          return '<div class="rb-itemchk'+(it.on?" on":"")+'" data-item="'+c.id+':'+i+'"><span class="chk">'+(it.on?"✓":"")+'</span>'+esc(nm)+'</div>'; }).join("")+'</div></div>';
    }).join("");
    const note = scopeNote ? '<div class="rb-notice"><span class="ic">✋</span><span>'+scopeNote+'</span></div>' : "";
    const tpls=templatesFor(); let smart="";
    if(tpls.length){
      smart='<div class="rb-card rb-smart-card"><div class="rb-smart-row"><div><h2 style="display:flex;align-items:center;gap:.4rem">✨ Smart Scope Builder'+iTip("Opens a quick picker of ready-made packages tailored to your project type and what you told the appraiser. It only sets a starting point — edit anything after.")+'</h2>'+
        '<p class="sub" style="margin:.3rem 0 0">In a hurry? Let us check a typical scope for you, tailored to your answers. Or skip and tick items yourself below.</p></div>'+
        '<button class="rb-btn primary rb-smart-open" type="button" data-smart="1">Open Smart Scope Builder →</button></div>'+
        (templateNote?('<div class="rb-notice" style="background:rgba(127,169,176,.12);border-color:var(--teal);margin-top:1rem"><span class="ic">✓</span><span><b>Smart template "'+esc(templateNote)+'" applied.</b> Review the checked items below — add or remove anything — then tap Next. Tap the button again to switch packages.</span></div>'):'')+
      '</div>';
    }
    return setup+smart+'<div class="rb-card"><h2>What work are you doing?'+iTip("Check a category to open it, then tick only the specific line items you'll actually do. Anything you don't check stays hidden, so you only ever fill in what matters. You can also add your own custom line items on the next screen.")+'</h2>'+
      '<p class="sub">Check a category to open it, then tick only the line items you\'ll actually do. Everything else stays hidden so you\'re never staring at a thousand fields. You can add your own line items on the next screen too.</p>'+
      '<div class="rb-catbar"><span class="rb-mini" data-all="on">Expand all</span><span class="rb-mini" data-all="off">Collapse all</span></div>'+
      '<div class="rb-cats" style="margin-top:1rem">'+cats+'</div>'+ note +'</div>';
  }

  /* ----- step 4 ----- */
  function viewBudget(){
    const groups=activeGroups();
    const realWork = allActiveKeys().length>0;
    const opts=appliesOptions();
    let body=groups.map(c=>{
      const keys=groupKeys(c.id);
      const lines=keys.map(key=>lineRow(key,opts)).join("");
      const add='<div class="rb-addline"><input type="text" placeholder="Add a custom line item to '+esc(c.label.replace(/ \/.*$/,""))+'…" data-addinput="'+c.id+'"><button data-addbtn="'+c.id+'">+ Add line</button></div>';
      return '<div class="rb-bgroup"><h3>'+esc(c.label)+' <span class="gsub" data-gsub="'+c.id+'">'+money(catTotal(c.id))+'</span></h3>'+lines+add+'</div>';
    }).join("");

    const cont='<div class="rb-card" style="margin-top:1.4rem"><h2>Contingency'+iTip("A reserve for surprises and overruns — most rehabs carry one. Enter a percent of your budget or a flat dollar amount; heavier or older properties usually warrant more.")+'</h2>'+
      '<p class="sub">A reserve for surprises and overruns. Heavier or older properties usually warrant more. Enter a percent of your budget or a flat dollar amount.</p>'+
      '<div class="rb-line-row" style="margin-top:.6rem">'+
        '<div class="rb-cell"><label>Method</label><span class="rb-applies"><select id="cont-mode"><option value="pct"'+(S.cont.mode==="pct"?" selected":"")+'>Percentage</option><option value="usd"'+(S.cont.mode==="usd"?" selected":"")+'>Dollar amount</option></select></span></div>'+
        '<div class="rb-cell"><label>'+(S.cont.mode==="pct"?"Percent of budget":"Amount")+'</label><div class="rb-inp '+(S.cont.mode==="pct"?"pct":"money")+'"><input id="cont-val" type="text" inputmode="decimal" placeholder="0" value="'+esc(S.cont.value)+'"></div></div>'+
        '<div class="rb-line-total" id="cont-amt">'+money(contingency())+'</div></div></div>';

    const gc='<div class="rb-card" style="margin-top:1rem"><h2>General Contractor fee'+iTip("Your GC's fee or markup, if it's billed as a separate line rather than baked into each item. Enter a percent of the construction cost or a flat amount; leave blank or set to 0 if it's already inside your line-item prices.")+'</h2>'+
      '<p class="sub">Your GC\'s fee or markup, if it\'s a separate line. Enter a percent of the construction cost or a flat amount — or leave it blank / set to 0 if it\'s already baked into your line items.</p>'+
      '<div class="rb-line-row" style="margin-top:.6rem">'+
        '<div class="rb-cell"><label>Method</label><span class="rb-applies"><select id="gc-mode"><option value="pct"'+(S.gcFee.mode==="pct"?" selected":"")+'>Percentage</option><option value="usd"'+(S.gcFee.mode==="usd"?" selected":"")+'>Dollar amount</option></select></span></div>'+
        '<div class="rb-cell"><label>'+(S.gcFee.mode==="pct"?"Percent of budget":"Amount")+'</label><div class="rb-inp '+(S.gcFee.mode==="pct"?"pct":"money")+'"><input id="gc-val" type="text" inputmode="decimal" placeholder="0" value="'+esc(S.gcFee.value)+'"></div></div>'+
        '<div class="rb-line-total" id="gc-amt">'+money(gcFeeAmt())+'</div></div></div>';

    const lead='<div class="rb-card"><h2>Price the work'+(isMulti()?iTip("Each line has an \"applies to\" menu: Same each unit (type once, we apply it to every unit), Per unit (price each unit separately), Common areas, Exterior, or Project-wide. Type a description beside the amount; tick \"separate description per unit\" only if each unit differs."):iTip("Enter a cost for each line and an optional description beside it. Your running total, contingency and GC fee update live at the bottom."))+'</h2><p class="sub">'+
      (realWork? 'Only the items you picked appear. ':'Pick line items on the Scope step, or add your own below. ')+
      (isMulti()? 'Use <b>Same each unit</b> to price once and apply across all '+unitCount()+' units, or split per unit. Switching never erases what you typed.':'Enter a cost for each line.')+'</p></div>';
    return lead + body + cont + gc + stickyBar();
  }
  function lineRow(key,opts){
    const it=st(key); const m=metaOf(key); const cust=isCustom(key);
    const split = isMulti() && it.applies==="split";
    const sideDesc = !(split && it.perUnitDesc); // single description beside the amount, unless per-unit is on
    const top='<div class="rb-line-top">'+
      '<input class="rb-line-name-in" data-field="label" data-k="'+key+'" value="'+esc(m.name)+'" title="Rename this line item" aria-label="Line item name" spellcheck="false">'+(cust?'<span class="rb-tag-custom">custom</span>':'')+
      (isMulti()? '<span class="rb-applies"><select data-applies="'+key+'">'+opts.map(o=>'<option value="'+o.v+'"'+(it.applies===o.v?" selected":"")+'>'+o.t+'</option>').join("")+'</select></span>':'')+
      (split? '<label class="rb-pud'+(it.perUnitDesc?" on":"")+'" data-pud="'+key+'"><span class="rb-pud-box">'+(it.perUnitDesc?"✓":"")+'</span>Separate description per unit</label>':'')+
      (split? '<button class="rb-copy1" data-copy1="'+key+'" title="Fill every unit from Unit 1">Copy Unit 1 →</button>':'')+
      '<span class="rb-line-total" data-ltot="'+key+'">'+money(lineTotal(key))+'</span>'+
      (cust?'<button class="rb-del" data-del="'+key.slice(2)+'" title="Remove">✕</button>':'')+'</div>';
    const costs='<div class="rb-line-row">'+costInputs(key,it)+
      (S.txn==="refi"? '<div class="rb-cell"><label>% already done</label><div class="rb-inp pct"><input data-field="pct" data-k="'+key+'" type="text" inputmode="decimal" value="'+esc(it.pct)+'"></div></div>':'')+
      (sideDesc? '<div class="rb-desc"><label>Description</label><input data-field="desc" data-k="'+key+'" type="text" placeholder="Optional" value="'+esc(it.desc)+'"></div>':'')+'</div>';
    return '<div class="rb-line" data-line="'+key+'">'+top+costs+'</div>';
  }
  function cellMoney(field,key,val,label,u){ return '<div class="rb-cell"><label>'+label+'</label><div class="rb-inp money"><input data-field="'+field+'"'+(u?(' data-u="'+u+'"'):'')+' data-k="'+key+'" type="text" inputmode="decimal" value="'+esc(val)+'"></div></div>'; }
  function costInputs(key,it){
    if(!isMulti()) return cellMoney("each",key,it.each,"Cost");
    if(it.applies==="split"){
      if(it.perUnitDesc){
        let cards=""; for(let u=1;u<=unitCount();u++){ cards+='<div class="rb-ucol"><label>Unit '+u+'</label><div class="rb-inp money"><input data-field="u" data-u="u'+u+'" data-k="'+key+'" type="text" inputmode="decimal" value="'+esc(it.u["u"+u]||"")+'"></div><input class="rb-ud-in" data-field="ud" data-u="u'+u+'" data-k="'+key+'" type="text" placeholder="Unit '+u+' description…" value="'+esc(it.ud["u"+u]||"")+'"></div>'; }
        return '<div class="rb-ucards">'+cards+'</div>';
      }
      let cells=""; for(let u=1;u<=unitCount();u++) cells+=cellMoney("u",key,it.u["u"+u]||"","Unit "+u,"u"+u); return cells;
    }
    if(it.applies==="common")   return cellMoney("common",key,it.common,"Common areas");
    if(it.applies==="exterior") return cellMoney("exterior",key,it.exterior,"Exterior");
    if(it.applies==="project")  return cellMoney("project",key,it.project,"Project-wide");
    return cellMoney("each",key,it.each,"Cost / unit (× "+unitCount()+")");
  }
  function stickyBar(){
    const t=num(S.target),g=grand(),diff=t-g; let tcard="";
    if(t>0) tcard=diff>=0?'<div class="rb-tot"><span class="k">Left to allocate</span><span class="v teal">'+money(diff)+'</span></div>':'<div class="rb-tot"><span class="k">Over target</span><span class="v over">'+money(-diff)+'</span></div>';
    return '<div class="rb-sticky"><div class="rb-sticky-inner">'+
      '<div class="rb-tot"><span class="k">Hard costs</span><span class="v" id="sb-hard">'+money(hardTotal())+'</span></div>'+
      '<div class="rb-tot"><span class="k">Soft costs</span><span class="v" id="sb-soft">'+money(softTotal())+'</span></div>'+
      '<div class="rb-tot"><span class="k">Contingency</span><span class="v" id="sb-cont">'+money(contingency())+'</span></div>'+
      '<div class="rb-tot"><span class="k">GC fee</span><span class="v" id="sb-gc">'+money(gcFeeAmt())+'</span></div>'+
      '<div class="rb-spacer"></div><div id="sb-target">'+tcard+'</div>'+
      '<div class="rb-tot"><span class="k">Total scope of work</span><span class="v gold" id="sb-grand">'+money(g)+'</span></div></div></div>';
  }

  /* ----- review intelligence: warnings, readiness, education ----- */
  const EDU=[
    "Draws are usually reimbursed after the work is completed and inspected — not paid up front.",
    "Materials delivered but not yet installed often aren't reimbursable until they're in place.",
    "Changing the scope after closing may require lender approval, so try to be thorough now.",
    "Keep line items detailed enough that an inspector can verify each one on site.",
    "A realistic contingency protects your draws if costs come in higher than planned."
  ];
  function warnings(){ const w=[]; const has=(cid,idx)=>st(cid+":"+idx).on; const catOn=cid=> S.cats[cid] && chosenItems(cid).length;
    if(catOn("kitchen")){ const need=[[0,"cabinets"],[1,"countertops"],[3,"sink & faucet"],[5,"lighting"]].filter(n=>!has("kitchen",n[0])).map(n=>n[1]); if(need.length) w.push("Kitchen is in your scope but you haven't added "+need.join(", ")+"."); }
    if(catOn("baths") && !has("baths",0)){ const need=[[1,"tub/shower"],[2,"vanity"],[3,"toilet"],[4,"tile"]].filter(n=>!has("baths",n[0])).map(n=>n[1]); if(need.length) w.push("Bathrooms are in your scope but you haven't added "+need.join(", ")+" (or a full bath remodel)."); }
    if(S.vd.baths===true && !(has("mep",3)||has("mep",4))) w.push("You're adding bathrooms but haven't included plumbing (rough/finish).");
    if(S.vd.expand===true && !has("soft",0)) w.push("You're expanding square footage but haven't included permits.");
    if(S.vd.expand===true && !(has("interior",0)||has("foundation",1)||(CAT["shell"]&&chosenItems("shell").length))) w.push("You're expanding square footage but haven't included any framing.");
    if(S.projType==="heavy" && !catOn("demo")) w.push("This is a heavy/gut project but Demolition isn't in your scope.");
    if(S.projType==="ground" && !(CAT["siteutil"]&&chosenItems("siteutil").length)) w.push("This is a ground-up build but Site & Utilities isn't in your scope.");
    if((S.projType==="heavy"||S.projType==="ground") && !num(S.cont.value)) w.push("Heavy and ground-up projects should carry a contingency reserve — yours is currently 0.");
    else if(!num(S.cont.value)) w.push("Most rehab budgets include a contingency reserve — yours is currently 0.");
    if(S.txn==="refi"){ let m=0; allActiveKeys().forEach(k=>{ const it=st(k); if(lineTotal(k)>0 && (it.pct===""||it.pct==null)) m++; }); if(m) w.push(m+" priced item"+(m>1?"s":"")+" don't have a \u201c% already done\u201d — refinances usually need this so the lender funds only the remaining work."); }
    if(gcFeeAmt()>0 && allActiveKeys().some(k=>/markup|gc fee|contractor fee/i.test(st(k).desc||""))) w.push("You entered a GC fee and also mention markup in a line description — check you're not double-counting.");
    const sqft=num(S.vd.sqftAfter)||num(S.vd.sqftNow); if(sqft>0){ const psf=grand()/sqft; if(S.projType==="heavy"&&psf<40) w.push("At ~"+money(psf)+"/sq ft this looks light for a heavy rehab — review before submitting."); if(S.projType==="ground"&&psf<90) w.push("At ~"+money(psf)+"/sq ft this looks light for ground-up — review before submitting."); }
    return w;
  }
  function readiness(){ const items=[
      ["Property info complete", !!S.address && !!S.txn && !!S.propType],
      ["Project type selected", !!S.projType],
      ["Value drivers noted", ["expand","beds","baths","basement","layout","adu","curb"].some(k=>S.vd[k]===true)||!!S.vd.other],
      ["Major categories chosen", activeGroups().some(c=>groupKeys(c.id).length)],
      ["Line items priced", subtotal()>0],
      ["Contingency included", num(S.cont.value)>0],
      ["GC fee handled", S.gcFee.value!==""],
      ["Narrative written", (S.narrative||"").length>20],
      ["On or under target", num(S.target)>0 ? grand()<=num(S.target) : subtotal()>0],
      ["Warnings cleared", warnings().length===0] ];
    const ok=items.filter(i=>i[1]).length; const pct=Math.round(ok/items.length*100);
    const label= pct<40?"Needs work": pct<70?"Good start": pct<90?"Lender-ready":"Strong budget";
    return {pct,label,items};
  }

  /* ----- step 5: detailed review ----- */
  function viewReview(){
    const groups=activeGroups().filter(c=>groupKeys(c.id).length);
    const secAll=sections();
    const secTot={}; secAll.forEach(s=>secTot[s.key]=0);
    allActiveKeys().forEach(k=> secAll.forEach(s=> secTot[s.key]+=lineSectionVal(k,s.key)));

    const applyLbl={each:"Same each unit",split:"Per unit",common:"Common areas",exterior:"Exterior",project:"Project-wide"};
    let rows="";
    groups.forEach(c=>{
      rows+='<tr class="grp"><td colspan="3">'+esc(c.label)+'</td><td class="num">'+money(catTotal(c.id))+'</td></tr>';
      groupKeys(c.id).forEach(key=>{ const it=st(key); const m=metaOf(key);
        let bd="";
        if(isMulti()){
          if(it.applies==="each"){ const v=num(it.each); let chips=""; for(let u=1;u<=unitCount();u++) chips+='<span class="chip">Unit '+u+' <b>'+money(v)+'</b></span>'; bd=chips; }
          else if(it.applies==="split"){ let chips=""; for(let u=1;u<=unitCount();u++){ const d=it.perUnitDesc?(it.ud["u"+u]||""):""; chips+='<span class="chip">Unit '+u+' <b>'+money(num(it.u["u"+u]))+'</b>'+(d?(' — '+esc(d)):'')+'</span>'; } bd=chips; }
          else if(it.applies==="common")   bd='<span class="chip">Common areas <b>'+money(num(it.common))+'</b></span>';
          else if(it.applies==="exterior") bd='<span class="chip">Exterior <b>'+money(num(it.exterior))+'</b></span>';
          else bd='<span class="chip">Project-wide <b>'+money(num(it.project))+'</b></span>';
        }
        const desc=(it.desc?esc(it.desc):"")+(it.pct&&S.txn==="refi"?' <span style="color:var(--muted-2)">('+esc(it.pct)+'% done)</span>':'');
        rows+='<tr><td>'+esc(m.name)+(isCustom(key)?' <span class="rb-tag-custom">custom</span>':'')+'</td><td>'+(isMulti()?esc(applyLbl[it.applies]||""):"")+'</td><td><div class="rb-bd">'+bd+(desc?('<div>'+desc+'</div>'):'')+'</div></td><td class="num">'+money(lineTotal(key))+'</td></tr>';
      });
    });

    let byUnit="";
    if(isMulti()){
      byUnit='<div class="rb-sec-title">By section</div><table class="rb-tbl"><tbody>'+
        secAll.filter(s=> secTot[s.key]>0 || s.kind==="unit").map(s=>'<tr><td>'+esc(s.label)+'</td><td class="num">'+money(secTot[s.key])+'</td></tr>').join("")+
        '</tbody></table>';
    }
    const vd=S.vd; let vbits=[];
    if(vd.expand) vbits.push("Expanding "+esc(vd.sqftNow||"?")+" → "+esc(vd.sqftAfter||"?")+" sf");
    if(vd.beds) vbits.push("Beds "+esc(vd.bedsNow||"?")+" → "+esc(vd.bedsAfter||"?"));
    if(vd.baths) vbits.push("Baths "+esc(vd.bathsNow||"?")+" → "+esc(vd.bathsAfter||"?"));
    if(vd.basement) vbits.push("Basement: "+esc(vd.basementNotes||"yes"));
    if(vd.layout) vbits.push("Layout: "+esc(vd.layoutNotes||"reconfiguring"));
    if(vd.adu) vbits.push("ADU / addition: "+esc(vd.aduNotes||"yes"));
    if(vd.curb) vbits.push("Curb appeal: "+esc(vd.curbNotes||"yes"));
    if(vd.other) vbits.push(esc(vd.other));
    const t=num(S.target),g=grand(),diff=t-g;
    const PROJ={cosmetic:"Cosmetic",moderate:"Moderate",heavy:"Heavy / gut",ground:"Ground-up"};
    const sqft=num(S.vd.sqftAfter)||num(S.vd.sqftNow);
    const perUnit = unitCount()>0 ? g/unitCount() : 0;
    let metrics=[];
    if(isMulti()) metrics.push(money(perUnit)+" / unit");
    if(sqft>0) metrics.push(money(g/sqft)+" / sq ft");
    const rd=readiness(), wn=warnings();
    const rlClass = rd.pct<40?"low":rd.pct<70?"mid":rd.pct<90?"good":"top";
    const rdHtml='<div class="rb-ready"><div class="rb-ready-top"><span class="rb-ready-label rl-'+rlClass+'">'+rd.label+'</span><span class="rb-ready-pct">'+rd.pct+'%</span></div>'+
      '<div class="rb-ready-bar"><div class="rb-ready-fill rl-'+rlClass+'" style="width:'+rd.pct+'%"></div></div>'+
      '<div class="rb-checklist">'+rd.items.map(i=>'<span class="rb-chk-item'+(i[1]?" ok":"")+'">'+(i[1]?"✓":"○")+' '+esc(i[0])+'</span>').join("")+'</div></div>';
    const wnHtml = wn.length
      ? '<div class="rb-warns"><div class="rb-warns-head">⚠ '+wn.length+' thing'+(wn.length>1?"s":"")+' worth a look <span>— suggestions only, you can still export</span></div>'+wn.map(x=>'<div class="rb-warn">'+esc(x)+'</div>').join("")+'</div>'
      : '<div class="rb-warns ok"><div class="rb-warns-head">✓ No missing-scope warnings — this looks complete.</div></div>';
    const eduHtml='<details class="rb-edu"><summary>Good to know before you submit</summary><ul>'+EDU.map(e=>'<li>'+esc(e)+'</li>').join("")+'</ul></details>';
    return '<div class="rb-card"><h2>Review your scope of work</h2>'+
      '<p class="sub">'+esc(S.address||"(no address yet)")+' · '+(S.txn==="refi"?"Refinance":"Purchase")+(S.projType?(" · "+PROJ[S.projType]):"")+' · '+(isMulti()?(unitCount()+" units"):"Single-family")+(isMulti()?(" · "+(S.budgetMode==="separate"?"per-unit budget":"standard budget")):"")+(S.months?(" · "+esc(S.months)+" months"):"")+'</p>'+
      '<div class="rb-rev-cards">'+
        '<div class="rb-rev-card"><div class="k">Hard costs</div><div class="v">'+money(hardTotal())+'</div></div>'+
        '<div class="rb-rev-card"><div class="k">Soft costs</div><div class="v">'+money(softTotal())+'</div></div>'+
        '<div class="rb-rev-card"><div class="k">Contingency + GC</div><div class="v teal">'+money(contingency()+gcFeeAmt())+'</div></div>'+
        '<div class="rb-rev-card"><div class="k">Total scope of work</div><div class="v gold">'+money(g)+'</div></div></div>'+
      (metrics.length?('<p class="rb-note">'+metrics.join("  ·  ")+'</p>'):'')+
      '<div class="rb-sec-title">Budget readiness'+iTip("A simple completeness check — not underwriting. It rises as you fill in property info, scope, pricing, contingency, GC fee and narrative.")+'</div>'+
      rdHtml + wnHtml + eduHtml +
      (t>0?('<p class="rb-note">'+(diff>=0?("You're "+money(diff)+" under your "+money(t)+" target."):("You're "+money(-diff)+" over your "+money(t)+" target."))+'</p>'):'')+
      (vbits.length?('<div class="rb-sec-title">Value drivers</div><p class="sub">'+vbits.join(" · ")+'</p>'):'')+
      byUnit+
      '<div class="rb-sec-title">Line items</div>'+
      '<table class="rb-tbl"><thead><tr><th>Item</th><th>Applies to</th><th>Per-unit breakdown</th><th style="text-align:right">Total</th></tr></thead><tbody>'+
        rows+
        '<tr class="tot"><td colspan="3">Subtotal</td><td class="num">'+money(subtotal())+'</td></tr>'+
        '<tr><td colspan="3">Contingency'+(S.cont.mode==="pct"&&S.cont.value?(" ("+esc(S.cont.value)+"%)"):"")+'</td><td class="num">'+money(contingency())+'</td></tr>'+
        (gcFeeAmt()>0?('<tr><td colspan="3">General Contractor fee'+(S.gcFee.mode==="pct"&&S.gcFee.value?(" ("+esc(S.gcFee.value)+"%)"):"")+'</td><td class="num">'+money(gcFeeAmt())+'</td></tr>'):'')+
        '<tr class="tot"><td colspan="3">Total scope of work</td><td class="num">'+money(g)+'</td></tr>'+
      '</tbody></table>'+
      (S.narrative?('<div class="rb-sec-title">Narrative</div><p class="sub">'+esc(S.narrative)+'</p>'):'')+
      '<div class="rb-catbar" style="margin-top:1.4rem">'+
        '<button class="rb-btn primary" onclick="RB.exportXlsx(this)">Export Excel ⤓</button>'+
        '<button class="rb-btn" onclick="RB.exportPdf(this)">Export branded PDF ⤓</button>'+
        '<button class="rb-btn" onclick="RB.emailLO(this)">Email to loan officer ✉</button>'+
        '<button class="rb-btn" onclick="RB.share(this)">Copy share link 🔗</button></div>'+
      '<p class="rb-underwrite-note"><b>To underwrite your rehab budget, YS needs the Excel file — not the PDF.</b> The PDF is a branded copy for your records; our team underwrites from the Excel export. “Email to loan officer” sends both.</p>'+
      '<p class="rb-note">Your link already saved this scope of work — bookmark it to come back, or send it to your loan officer. The Excel export can be re-imported here to keep editing. <b>Email to loan officer</b> lets you pick the exact person on the YS team and sends with both files <b>attached</b>: on a phone it uses the share sheet, and on a computer it downloads a ready-to-send draft (.eml) that already has the PDF and Excel attached — just open it and hit send.</p>'+
      '<p class="rb-note" style="margin-top:.6rem">Already closed this loan with YS? Once your renovation is underway, <a href="https://portal.sitewire.co/login/YSCapitalGroup" target="_blank" rel="noopener">request a draw →</a> to be reimbursed from your rehab holdback as work is completed and verified.</p>'+
    '</div>';
  }

  /* ---------- view helpers ---------- */
  function field(label,key,inner){ return '<div class="rb-f"><label>'+label+'</label>'+inner+'</div>'; }
  function iTip(txt){ return '<span class="rb-itip"><button type="button" class="rb-i" aria-label="More information">i</button><span class="rb-tip">'+esc(txt)+'</span></span>'; }
  function choiceBtn(group,val,title,sub){ const sel=(S[group]===val); return '<button data-set="'+group+'" data-val="'+val+'" class="'+(sel?"sel":"")+'">'+title+'<span class="c-sub">'+sub+'</span></button>'; }
  function ynBlock(q,key,inner){ const on=S.vd[key]===true,off=S.vd[key]===false;
    return '<div class="rb-sec-title" style="display:flex;align-items:center;gap:1rem;justify-content:space-between;text-transform:none;letter-spacing:0;font-size:.98rem;color:var(--ivory);font-weight:600"><span>'+q+'</span><span class="rb-yn" data-vyn="'+key+'"><button data-v="yes" class="'+(on?"on":"")+'">Yes</button><button data-v="no" class="'+(off?"on":"")+'">No</button></span></div>'+
      '<div class="rb-vd-detail'+(on?"":" hide")+'" data-vddetail="'+key+'">'+inner+'</div>'; }
  function ynRow(q,key){ return '<div class="rb-f"><label>'+q+'</label><span class="rb-yn" data-syn="'+key+'"><button data-v="yes" class="'+(S[key]?"on":"")+'">Yes</button><button data-v="no" class="'+(!S[key]?"on":"")+'">No</button></span></div>'; }

  /* ---------- nav ---------- */
  function renderNav(){
    const n=$("#rb-nav");
    const back=step>0?'<button class="rb-btn" data-nav="back">← Back</button>':'<span></span>';
    const next=step<STEPS.length-1?'<button class="rb-btn primary" data-nav="next">'+(STEPS[step+1]?("Next: "+STEPS[step+1].label+" →"):"Next →")+'</button>':'<button class="rb-btn primary" onclick="RB.exportPdf(this)">Export PDF ⤓</button>';
    n.innerHTML=back+next;
    n.querySelectorAll("[data-nav]").forEach(b=> b.onclick=()=>{ commit();
      if(b.dataset.nav==="back"){ if(step>0)step--; render({scroll:true}); return; }
      // forward validation
      if(STEPS[step].id==="scope"){ const iss=scopeCheck(); if(iss){ scopeNote=iss; render(); return; } scopeNote=""; }
      if(step<STEPS.length-1)step++; render({scroll:true});
    });
  }
  function scopeCheck(){
    const opened=[]; let total=0;
    CATS.forEach(c=>{ if(c.id==="other") return; if(S.cats[c.id]){ const n=chosenItems(c.id).length; if(n===0) opened.push(c.label); total+=n; } });
    total += S.custom.length;
    if(total===0) return "You haven't added any work yet. Tap a category to open it, then check at least one line item you'll be doing.";
    if(opened.length) return "You opened <b>"+opened.join(", ")+"</b> but didn't check any items inside. Add at least one line item there, or uncheck the category — then you're good to go.";
    return "";
  }

  /* ---------- commit + bind ---------- */
  function commit(){ const g=id=>{ const e=document.getElementById(id); return e?e.value:undefined; };
    if(STEPS[step].id==="start"){ S.address=g("f-address")??S.address; S.months=g("f-months")??S.months; S.target=g("f-target")??S.target; S.narrative=g("f-narr")??S.narrative; if(document.getElementById("f-units")) S.units=parseInt(g("f-units"),10)||S.units; }
    if(STEPS[step].id==="value"){ document.querySelectorAll("[data-vd]").forEach(e=> S.vd[e.dataset.vd]=e.value); }
    if(STEPS[step].id==="budget"){ if(document.getElementById("cont-val")) S.cont.value=document.getElementById("cont-val").value; if(document.getElementById("gc-val")) S.gcFee.value=document.getElementById("gc-val").value; }
    save();
  }
  function bind(){
    document.querySelectorAll("[data-set]").forEach(b=> b.onclick=()=>{ commit(); const grp=b.dataset.set, val=b.dataset.val; S[grp]=val;
      if(grp==="propType"){ if(val==="single"){ S.units=1; S.doExterior=false; S.doCommon=false; } else if(val==="multi"){ if(unitCount()<2||unitCount()>4) S.units=2; } else if(val==="large"){ if(unitCount()<5) S.units=5; } }
      if(grp==="budgetMode") applyBudgetMode();
      render(); });
    document.querySelectorAll("[data-vyn]").forEach(yn=> yn.querySelectorAll("button").forEach(btn=> btn.onclick=()=>{ commit(); S.vd[yn.dataset.vyn]=btn.dataset.v==="yes"; render(); }));
    document.querySelectorAll(".rb-vcard-head").forEach(h=> h.onclick=()=>{ const key=h.closest("[data-vcard]").dataset.vcard; commit(); S.vd[key]=!(S.vd[key]===true); render(); });
    document.querySelectorAll("[data-syn]").forEach(yn=> yn.querySelectorAll("button").forEach(btn=> btn.onclick=()=>{ commit(); S[yn.dataset.syn]=btn.dataset.v==="yes"; render(); }));
    document.querySelectorAll("[data-toggle]").forEach(h=> h.onclick=(e)=>{ const cid=h.dataset.toggle; const card=h.closest(".rb-cat");
      if(e.target.closest(".chk")){ S.cats[cid]=!S.cats[cid]; scopeNote=""; render(); return; } card.classList.toggle("open"); });
    document.querySelectorAll("[data-item]").forEach(el=> el.onclick=()=>{ const [cid,i]=el.dataset.item.split(":"); const it=st(cid+":"+i); it.on=!it.on; if(it.on)S.cats[cid]=true; scopeNote=""; render(); });
    document.querySelectorAll("[data-all]").forEach(b=> b.onclick=()=> document.querySelectorAll(".rb-cat").forEach(c=> c.classList.toggle("open", b.dataset.all==="on")));
    document.querySelectorAll("[data-smart]").forEach(b=> b.onclick=()=> openSmartBuilder());
    document.querySelectorAll("[data-applies]").forEach(s=> s.onchange=()=>{ changeApplies(s.dataset.applies, s.value); render(); });
    document.querySelectorAll("[data-field]").forEach(inp=> inp.addEventListener("input",()=>{ const key=inp.dataset.k; const it=st(key); const f=inp.dataset.field;
      if(f==="u"){ it.u[inp.dataset.u]=inp.value; } else if(f==="ud"){ it.ud[inp.dataset.u]=inp.value; } else { it[f]=inp.value; } updateLine(key); updateTotals(); save(); }));
    document.querySelectorAll("[data-pud]").forEach(el=> el.onclick=(e)=>{ e.preventDefault(); const it=st(el.dataset.pud); it.perUnitDesc=!it.perUnitDesc; render(); });
    document.querySelectorAll("[data-copy1]").forEach(b=> b.onclick=()=>{ const it=st(b.dataset.copy1); const v=it.u["u1"]||""; for(let u=2;u<=unitCount();u++) it.u["u"+u]=v; if(it.perUnitDesc){ const d=it.ud["u1"]||""; for(let u=2;u<=unitCount();u++) it.ud["u"+u]=d; } render(); flash("Copied Unit 1 across all units."); });
    // add custom line
    document.querySelectorAll("[data-addbtn]").forEach(btn=> btn.onclick=()=>{ const cid=btn.dataset.addbtn; const inp=document.querySelector('[data-addinput="'+cid+'"]'); addCustom(cid, inp?inp.value:""); });
    document.querySelectorAll("[data-addinput]").forEach(inp=> inp.addEventListener("keydown",e=>{ if(e.key==="Enter"){ e.preventDefault(); addCustom(inp.dataset.addinput, inp.value); } }));
    document.querySelectorAll("[data-del]").forEach(b=> b.onclick=()=> removeCustom(b.dataset.del));
    const cm=document.getElementById("cont-mode"); if(cm) cm.onchange=()=>{ commit(); S.cont.mode=cm.value; render(); };
    const cv=document.getElementById("cont-val"); if(cv) cv.addEventListener("input",()=>{ S.cont.value=cv.value; updateTotals(); save(); });
    const gm=document.getElementById("gc-mode"); if(gm) gm.onchange=()=>{ commit(); S.gcFee.mode=gm.value; render(); };
    const gv=document.getElementById("gc-val"); if(gv) gv.addEventListener("input",()=>{ S.gcFee.value=gv.value; updateTotals(); save(); });
    ["f-address","f-months","f-target","f-narr"].forEach(id=>{ const e=document.getElementById(id); if(e) e.addEventListener("input",()=>{ commit(); }); });
    // Update unit count live (on input) without a full re-render. The old "change"
    // handler re-rendered on blur, and when the blur was caused by clicking a
    // project-type button, the rebuild swallowed that click. Nothing on this step
    // depends on the count visually, so we just store it; commit() also reads it on nav.
    const uf=document.getElementById("f-units"); if(uf) uf.addEventListener("input",()=>{ const v=parseInt(uf.value,10); if(v) S.units=v; save(); });
    document.querySelectorAll(".rb-i").forEach(b=> b.onclick=(e)=>{ e.preventDefault(); e.stopPropagation(); const tip=b.parentNode.querySelector(".rb-tip"); const open=tip.classList.contains("show"); document.querySelectorAll(".rb-tip.show").forEach(t=>t.classList.remove("show")); if(!open) tip.classList.add("show"); });
    maybeAutocomplete();
  }
  function addCustom(cat,name){ name=(name||"").trim(); if(!name) return; const id=Date.now().toString(36)+Math.random().toString(36).slice(2,6); S.custom.push({id,cat,name}); const it=st("x:"+id); it.on=true; if(document.activeElement&&document.activeElement.blur)document.activeElement.blur(); setTimeout(()=>render(),0); }
  function removeCustom(id){ S.custom=S.custom.filter(c=>c.id!==id); delete S.items["x:"+id]; setTimeout(()=>render(),0); }
  function updateLine(key){ const el=document.querySelector('[data-ltot="'+CSS.escape(key)+'"]'); if(el)el.textContent=money(lineTotal(key)); const m=metaOf(key); const g=document.querySelector('[data-gsub="'+m.cat+'"]'); if(g)g.textContent=money(catTotal(m.cat)); }
  function updateTotals(){ const set=(id,v)=>{ const e=document.getElementById(id); if(e)e.textContent=money(v); };
    set("sb-hard",hardTotal()); set("sb-soft",softTotal()); set("sb-cont",contingency()); set("sb-gc",gcFeeAmt()); set("sb-grand",grand()); set("cont-amt",contingency()); set("gc-amt",gcFeeAmt());
    const tc=document.getElementById("sb-target"); if(tc){ const t=num(S.target),g=grand(),d=t-g; tc.innerHTML= t>0?(d>=0?'<div class="rb-tot"><span class="k">Left to allocate</span><span class="v teal">'+money(d)+'</span></div>':'<div class="rb-tot"><span class="k">Over target</span><span class="v over">'+money(-d)+'</span></div>'):""; }
  }

  /* ---------- property-address autocomplete ---------- */
  // Prefer Google Places when the Maps JS API happens to be loaded; otherwise
  // fall back to the app's OWN address API (/api/address/suggest — the same
  // nominatim/smarty/google proxy every other address field on the site uses),
  // so the rehab budget always autocompletes + verifies addresses.
  function maybeAutocomplete(){ const inp=document.getElementById("f-address"); if(!inp) return;
    if(window.google&&google.maps&&google.maps.places){ try{ const ac=new google.maps.places.Autocomplete(inp,{types:["address"]}); ac.addListener("place_changed",()=>{ const p=ac.getPlace(); S.address=(p&&p.formatted_address)||inp.value; commit(); }); return; }catch(e){} }
    if(inp.dataset.acWired) return; inp.dataset.acWired="1";
    const wrap=inp.parentNode; if(wrap) wrap.style.position="relative";
    const box=document.createElement("div"); box.className="rb-ac";
    box.style.cssText="position:absolute;left:0;right:0;top:100%;z-index:60;background:#0e141a;border:1px solid rgba(127,169,176,.4);border-radius:8px;margin-top:2px;max-height:220px;overflow:auto;display:none";
    if(wrap) wrap.appendChild(box);
    let t=null, seq=0;
    const hide=()=>{ box.style.display="none"; box.innerHTML=""; };
    const pick=(label)=>{ inp.value=label; S.address=label; commit(); hide(); };
    inp.addEventListener("input",()=>{ const q=inp.value.trim(); clearTimeout(t);
      if(q.length<3){ hide(); return; }
      const mine=++seq;
      t=setTimeout(()=>{
        fetch("/api/address/suggest?q="+encodeURIComponent(q)).then(r=>r.ok?r.json():null).then(d=>{
          if(mine!==seq) return;                       // drop stale responses
          const list=(d&&d.suggestions)||[];
          if(!list.length){ hide(); return; }
          box.innerHTML="";
          list.slice(0,6).forEach(s=>{ const label=s.label||s.address||""; if(!label) return;
            const row=document.createElement("div"); row.textContent=label;
            row.style.cssText="padding:.5rem .6rem;cursor:pointer;font-size:.92rem;border-bottom:1px solid rgba(127,169,176,.12)";
            row.onmouseenter=()=>{row.style.background="rgba(127,169,176,.15)";}; row.onmouseleave=()=>{row.style.background="";};
            row.onmousedown=(e)=>{ e.preventDefault(); pick(label); };   // fire before blur
            box.appendChild(row);
          });
          box.style.display="block";
        }).catch(()=>{ /* one failure never disables the field */ });
      },250);
    });
    inp.addEventListener("blur",()=> setTimeout(hide,150));
  }

  /* ===================== EXCEL (xlsx-js-style — same engine as the other YS tools) ===================== */
  function loadScript(src){ return new Promise((res,rej)=>{ const s=document.createElement("script"); s.src=src; s.onload=res; s.onerror=rej; document.head.appendChild(s); }); }
  async function ensureXLSX(){ if(window.XLSX&&window.XLSX.utils) return;
    // Local vendored copy first (instant, works offline/behind firewalls); CDN as fallback.
    try{ await loadScript("vendor/xlsx.bundle.js"); }
    catch(e){ try{ await loadScript("https://cdn.jsdelivr.net/npm/xlsx-js-style@1.2.0/dist/xlsx.bundle.js"); }
    catch(e2){ await loadScript("https://unpkg.com/xlsx-js-style@1.2.0/dist/xlsx.bundle.js"); } }
    if(!(window.XLSX&&window.XLSX.utils)) throw new Error("spreadsheet library failed to load"); }
  function enc2(o){ return "YS"+btoa(unescape(encodeURIComponent(JSON.stringify(o)))); }
  function dec2(s){ try{ if(s&&s.slice(0,2)==="YS") return JSON.parse(decodeURIComponent(escape(atob(s.slice(2))))); }catch(e){} return null; }
  function fileBase(){ return (S.address?S.address.replace(/[^\w]+/g,"_").replace(/^_|_$/g,"").slice(0,40):"YS_Rehab_Budget")+"_SOW_"+new Date().toISOString().slice(0,10); }
  function downloadBlob(buf,fn,mime){ const blob=new Blob([buf],{type:mime}); const a=document.createElement("a"); a.href=URL.createObjectURL(blob); a.download=fn; document.body.appendChild(a); a.click(); setTimeout(()=>{ URL.revokeObjectURL(a.href); a.remove(); },1500); }

  async function exportXlsx(btn,opts){ opts=opts||{}; const o=btn?btn.textContent:null; if(btn){ btn.textContent="Preparing…"; btn.disabled=true; }
    try{
      commit(); await ensureXLSX(); const X=window.XLSX;
      const INK="0B1014",IVORY="F3EFE6",GOLD="9A7518",TEAL="4E777F",TEALD="1F3A40",LIGHT="EAF1F1",LINE="DCE1E2",GRAY="5B6770",DARK="1F2A30";
      const secs=sections(); const colKeys=isMulti()?secs.map(s=>s.key):["all"]; const colLabels=isMulti()?secs.map(s=>s.label):["Cost"];
      const N=3+colKeys.length+1;
      const aoa=[], merges=[], rowH={}, styleMap={};
      const A=(r,c)=>X.utils.encode_cell({r:r,c:c});
      const setRow=r=>{ if(!aoa[r]) aoa[r]=[]; };
      const put=(r,c,v,st)=>{ setRow(r); aoa[r][c]=(v==null?"":v); if(st) styleMap[A(r,c)]=st; };
      const styleSpan=(r,c1,c2,st)=>{ for(let c=c1;c<=c2;c++){ setRow(r); if(aoa[r][c]==null) aoa[r][c]=""; styleMap[A(r,c)]=st; } };
      const mergeRow=(r,c1,c2)=>{ if(c2>c1) merges.push({s:{r:r,c:c1},e:{r:r,c:c2}}); };
      const bd=rgb=>({style:"thin",color:{rgb:rgb}});
      const hair={bottom:{style:"hair",color:{rgb:LINE}}};
      const stTitle={font:{name:"Georgia",sz:18,bold:true,color:{rgb:IVORY}},fill:{fgColor:{rgb:INK}},alignment:{horizontal:"left",vertical:"center"}};
      const stTag={font:{name:"Georgia",sz:11,italic:true,color:{rgb:GOLD}},fill:{fgColor:{rgb:INK}},alignment:{horizontal:"left",vertical:"center"}};
      const stMeta={font:{name:"Arial",sz:9,color:{rgb:"B9C2C4"}},fill:{fgColor:{rgb:INK}},alignment:{horizontal:"left",vertical:"center"}};
      const stSec={font:{name:"Arial",sz:11,bold:true,color:{rgb:TEALD}},fill:{fgColor:{rgb:LIGHT}},alignment:{horizontal:"left",vertical:"center"},border:{bottom:bd(TEAL)}};
      const stKvL={font:{name:"Arial",sz:10,color:{rgb:"333333"}},border:hair};
      const stKvV={font:{name:"Arial",sz:10,bold:true,color:{rgb:INK}},alignment:{horizontal:"left"},border:hair};
      const stVdIntro={font:{name:"Arial",sz:9,italic:true,color:{rgb:GRAY}}};
      const stVdL={font:{name:"Arial",sz:10,bold:true,color:{rgb:TEALD}},border:hair};
      const stVdV={font:{name:"Arial",sz:10,color:{rgb:INK}},alignment:{horizontal:"left"},border:hair};
      const stNarr={font:{name:"Arial",sz:9,color:{rgb:"333333"}},alignment:{horizontal:"left",vertical:"top",wrapText:true}};
      const stTH=al=>({font:{name:"Arial",sz:9,bold:true,color:{rgb:IVORY}},fill:{fgColor:{rgb:DARK}},alignment:{horizontal:al,vertical:"center"}});
      const stCatL={font:{name:"Arial",sz:9,bold:true,color:{rgb:TEALD}},fill:{fgColor:{rgb:LIGHT}},alignment:{horizontal:"left"}};
      const stCatV={font:{name:"Arial",sz:9,bold:true,color:{rgb:TEALD}},fill:{fgColor:{rgb:LIGHT}},alignment:{horizontal:"right"},numFmt:"$#,##0"};
      const stNum={font:{name:"Arial",sz:9,color:{rgb:GRAY}},alignment:{horizontal:"center"},border:hair};
      const stName={font:{name:"Arial",sz:9,color:{rgb:"222222"}},border:hair};
      const stDesc={font:{name:"Arial",sz:9,color:{rgb:"555555"}},alignment:{wrapText:true},border:hair};
      const stMoney={font:{name:"Arial",sz:9,color:{rgb:"222222"}},alignment:{horizontal:"right"},numFmt:"$#,##0",border:hair};
      const stMoneyB={font:{name:"Arial",sz:9,bold:true,color:{rgb:INK}},alignment:{horizontal:"right"},numFmt:"$#,##0",border:hair};
      const stSubDesc={font:{name:"Arial",sz:8,italic:true,color:{rgb:GRAY}}};
      const stTotL=strong=>({font:{name:"Arial",sz:10,bold:true,color:{rgb:INK}},alignment:{horizontal:"left"},fill:strong?{fgColor:{rgb:LIGHT}}:undefined,border:{top:{style:strong?"medium":"thin",color:{rgb:TEAL}}}});
      const stTotV=strong=>({font:{name:"Arial",sz:10,bold:true,color:{rgb:strong?TEALD:INK}},alignment:{horizontal:"right"},numFmt:"$#,##0",fill:strong?{fgColor:{rgb:LIGHT}}:undefined,border:{top:{style:strong?"medium":"thin",color:{rgb:TEAL}}}});
      const stDisc={font:{name:"Arial",sz:8,italic:true,color:{rgb:GRAY}},alignment:{horizontal:"left",vertical:"center",wrapText:true}};
      const stFoot={font:{name:"Arial",sz:9,bold:true,color:{rgb:TEALD}},alignment:{horizontal:"left"}};

      let R=0;
      put(R,0,"YS CAPITAL GROUP",stTitle); styleSpan(R,0,N-1,stTitle); mergeRow(R,0,N-1); rowH[R]={hpt:26}; R++;
      put(R,0,"Rehab Budget — Scope of Work   ·   The scope of work serious investors say YES to.",stTag); styleSpan(R,0,N-1,stTag); mergeRow(R,0,N-1); rowH[R]={hpt:16}; R++;
      put(R,0,"Generated "+new Date().toLocaleDateString("en-US",{year:"numeric",month:"long",day:"numeric"})+"   ·   NMLS ID 2609746",stMeta); styleSpan(R,0,N-1,stMeta); mergeRow(R,0,N-1); rowH[R]={hpt:15}; R++;
      R++;
      const PROJ={cosmetic:"Cosmetic refresh",moderate:"Moderate rehab",heavy:"Heavy / gut rehab",ground:"Ground-up construction"};
      const propLabel=!isMulti()?"Single-family":(unitCount()+(S.propType==="large"?"-unit building":"-unit multifamily"));
      put(R,0,"PROPERTY",stSec); styleSpan(R,0,N-1,stSec); mergeRow(R,0,N-1); rowH[R]={hpt:18}; R++;
      const kv=(label,val)=>{ put(R,0,label,stKvL); put(R,1,val,stKvV); styleSpan(R,1,N-1,stKvV); mergeRow(R,1,N-1); R++; };
      kv("Property address",S.address||""); kv("Transaction",S.txn==="refi"?"Refinance":"Purchase"); kv("Property type",propLabel);
      if(S.projType)kv("Rehab type",PROJ[S.projType]);
      if(S.months)kv("Project timeline",S.months+" months"); if(S.target)kv("Target budget",money(num(S.target)));
      const vd=S.vd,vb=[]; const dlt=(a,b)=>{ const d=num(b)-num(a); return (num(a)||num(b))&&d!==0?("   ("+(d>0?"+":"")+d+")"):""; };
      const span=(a,b,suf)=> ((a||b)? ((a||"?")+" to "+(b||"?")+(suf||"")) : "");
      if(vd.expand)vb.push(["Square footage",span(vd.sqftNow,vd.sqftAfter," sq ft")+dlt(vd.sqftNow,vd.sqftAfter)]);
      if(vd.beds)vb.push(["Bedrooms",span(vd.bedsNow,vd.bedsAfter)+dlt(vd.bedsNow,vd.bedsAfter)]);
      if(vd.baths)vb.push(["Bathrooms",span(vd.bathsNow,vd.bathsAfter)+dlt(vd.bathsNow,vd.bathsAfter)]);
      if(vd.basement)vb.push(["Finished basement",vd.basementNotes||"Finishing the basement to add living area"]);
      if(vd.layout)vb.push(["Layout change",vd.layoutNotes||"Reconfiguring the floor plan"]);
      if(vd.adu)vb.push(["ADU / addition",vd.aduNotes||"Adding an accessory dwelling unit / addition"]);
      if(vd.curb)vb.push(["Exterior / curb appeal",vd.curbNotes||"Exterior and curb-appeal improvements"]);
      if(vd.other)vb.push(["Other value-add",vd.other]);
      if(vb.length){ R++;
        put(R,0,"VALUE DRIVERS  —  IMPROVEMENTS THAT SUPPORT THE AFTER-REPAIR VALUE",stSec); styleSpan(R,0,N-1,stSec); mergeRow(R,0,N-1); rowH[R]={hpt:18}; R++;
        put(R,0,"These are the improvements an appraiser should credit toward the after-repair value.",stVdIntro); styleSpan(R,0,N-1,stVdIntro); mergeRow(R,0,N-1); rowH[R]={hpt:16}; R++;
        vb.forEach(p=>{ put(R,0,p[0],stVdL); put(R,1,p[1],stVdV); styleSpan(R,1,N-1,stVdV); mergeRow(R,1,N-1); R++; });
      }
      if(S.narrative){ R++; put(R,0,"NARRATIVE",stSec); styleSpan(R,0,N-1,stSec); mergeRow(R,0,N-1); rowH[R]={hpt:18}; R++; put(R,0,S.narrative,stNarr); styleSpan(R,0,N-1,stNarr); mergeRow(R,0,N-1); rowH[R]={hpt:40}; R++; }
      R++;
      put(R,0,"SCOPE OF WORK",stSec); styleSpan(R,0,N-1,stSec); mergeRow(R,0,N-1); rowH[R]={hpt:18}; R++;
      const hdr=["#","Line item","Description"].concat(colLabels).concat(["Total"]);
      for(let c=0;c<N;c++) put(R,c,hdr[c],stTH(c<=2?"left":"right")); rowH[R]={hpt:20}; R++;
      let no=0;
      activeGroups().filter(c=>groupKeys(c.id).length).forEach(c=>{
        put(R,0,c.label.toUpperCase(),stCatL); styleSpan(R,0,N-2,stCatL); mergeRow(R,0,N-2); put(R,N-1,catTotal(c.id),stCatV); R++;
        groupKeys(c.id).forEach(key=>{ const it=st(key); no++;
          put(R,0,no,stNum); put(R,1,metaOf(key).name,stName); put(R,2,it.desc||"",stDesc);
          colKeys.forEach((k,ci)=>{ const v=lineSectionVal(key,k); put(R,3+ci, v||"", stMoney); });
          put(R,N-1,lineTotal(key),stMoneyB); R++;
          if(isMulti() && it.applies==="split" && it.perUnitDesc){ for(let u=1;u<=unitCount();u++){ const d=it.ud["u"+u]; if(d){ put(R,1,"> Unit "+u+" — "+d,stSubDesc); styleSpan(R,1,N-1,stSubDesc); mergeRow(R,1,N-1); R++; } } }
        });
      });
      const totRow=(label,val,strong)=>{ put(R,0,label,stTotL(strong)); styleSpan(R,0,N-2,stTotL(strong)); mergeRow(R,0,N-2); put(R,N-1,val,stTotV(strong)); R++; };
      totRow("Subtotal",subtotal(),false); totRow("Contingency"+(S.cont.mode==="pct"&&S.cont.value?(" ("+S.cont.value+"%)"):""),contingency(),false);
      if(gcFeeAmt()>0) totRow("General Contractor fee"+(S.gcFee.mode==="pct"&&S.gcFee.value?(" ("+S.gcFee.value+"%)"):""),gcFeeAmt(),false);
      totRow("Soft costs",softTotal(),false); totRow("Hard costs",hardTotal(),false); totRow("TOTAL SCOPE OF WORK",grand(),true);
      R++;
      put(R,0,"For estimation & education only — not a quote, approval, or commitment to lend. Final budget and advance rates depend on full underwriting and appraisal.",stDisc); styleSpan(R,0,N-1,stDisc); mergeRow(R,0,N-1); rowH[R]={hpt:30}; R++;
      put(R,0,"YS Capital Group   ·   NMLS ID 2609746   ·   Equal Housing Lender   ·   sales@yscapgroup.com",stFoot); styleSpan(R,0,N-1,stFoot); mergeRow(R,0,N-1); R++;

      const ws=X.utils.aoa_to_sheet(aoa); ws["!merges"]=merges;
      const rowsArr=[]; Object.keys(rowH).forEach(k=>{ rowsArr[+k]=rowH[k]; }); ws["!rows"]=rowsArr;
      const cols=[{wch:5},{wch:26},{wch:34}]; for(let i=0;i<colKeys.length;i++) cols.push({wch:14}); cols.push({wch:15}); ws["!cols"]=cols;
      Object.keys(styleMap).forEach(addr=>{ if(!ws[addr]) ws[addr]={t:"s",v:""}; ws[addr].s=styleMap[addr]; });
      const wb=X.utils.book_new(); X.utils.book_append_sheet(wb,ws,"Rehab Budget");
      const payload=enc2(snap()), CH=30000, nch=Math.max(1,Math.ceil(payload.length/CH));
      const hidAoa=[["YSREHAB1",nch]]; for(let i=0;i<nch;i++) hidAoa.push([payload.slice(i*CH,(i+1)*CH)]);
      X.utils.book_append_sheet(wb, X.utils.aoa_to_sheet(hidAoa), "_ys");
      wb.Workbook={Sheets:[{Hidden:0},{Hidden:2}]};
      const out=X.write(wb,{bookType:"xlsx",type:"array",cellStyles:true});
      const _xfn=fileBase()+".xlsx", _xmime="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
      if(opts.returnFile){ if(btn){ btn.textContent=o; btn.disabled=false; } return new File([out], _xfn, {type:_xmime}); }
      downloadBlob(out, _xfn, _xmime);
      flash("Branded Excel exported — re-import it here anytime to keep editing.");
    }catch(err){ if(opts.returnFile){ if(btn){btn.textContent=o;btn.disabled=false;} return null; } alert("Excel couldn't be generated here. On the published site it will download normally."); if(window.console)console.error(err); }
    finally{ if(btn){ btn.textContent=o; btn.disabled=false; } }
  }

  async function importXlsx(input){ const file=input.files&&input.files[0]; input.value=""; if(!file) return;
    try{ await ensureXLSX(); const X=window.XLSX; const buf=await file.arrayBuffer(); const wb=X.read(buf,{type:"array"});
      const sh=wb.Sheets["_ys"]; let stt=null;
      if(sh){ const cellStr=addr=>{ const c=sh[addr]; return c&&c.v!=null?String(c.v):""; };
        let n=parseInt(cellStr("B1"),10)||1, payload="";
        for(let i=0;i<n;i++) payload+=cellStr("A"+(2+i));
        if(payload) stt=dec2(payload);
      }
      if(!stt){ flash("Couldn't read that file — please import an Excel exported by this tool."); return; }
      S=Object.assign(blank(),stt); S.vd=Object.assign(blank().vd,stt.vd||{}); S.cont=Object.assign(blank().cont,stt.cont||{}); S.gcFee=Object.assign(blank().gcFee,stt.gcFee||{}); S.custom=stt.custom||[];
      step=STEPS.length-1; render({scroll:true}); flash("Imported — "+(isMulti()?(unitCount()+" units"):"single-family")+", "+(S.txn==="refi"?"refinance":"purchase")+". Pick up where you left off.");
    }catch(e){ flash("Import failed — please use a file exported by this tool."); if(window.console)console.error(e); }
  }

  /* ===================== BRANDED PDF (jsPDF — per-unit columns) ===================== */
  async function ensurePDF(){ if(window.jspdf&&window.jspdf.jsPDF){ if(!window.jspdf.jsPDF.API.autoTable){ try{ await loadScript("vendor/jspdf.plugin.autotable.min.js"); }catch(e){ try{ await loadScript("https://cdn.jsdelivr.net/npm/jspdf-autotable@3.8.2/dist/jspdf.plugin.autotable.min.js"); }catch(e2){} } } return; }
    // Local vendored copies first (instant, works offline); CDN as fallback.
    try{ await loadScript("vendor/jspdf.umd.min.js"); }
    catch(e){ try{ await loadScript("https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.umd.min.js"); }catch(e2){ await loadScript("https://unpkg.com/jspdf@2.5.1/dist/jspdf.umd.min.js"); } }
    try{ await loadScript("vendor/jspdf.plugin.autotable.min.js"); }
    catch(e){ try{ await loadScript("https://cdn.jsdelivr.net/npm/jspdf-autotable@3.8.2/dist/jspdf.plugin.autotable.min.js"); }catch(e2){ await loadScript("https://unpkg.com/jspdf-autotable@3.8.2/dist/jspdf.plugin.autotable.min.js"); } }
    if(!(window.jspdf&&window.jspdf.jsPDF)) throw new Error("pdf load failed"); }
  // Logo is embedded (rb-logo.js) so exports never depend on an async image load.
  function logoData(){ const L=(typeof window!=="undefined"&&window.RB_LOGO)?window.RB_LOGO:null; if(!L||!L.b64) return null; return { b64:L.b64, dataURI:"data:image/png;base64,"+L.b64, w:L.w||560, h:L.h||273 }; }
  // jsPDF's default font is Latin-1 only; strip characters it can't render (arrows etc.).
  function pdfSafe(s){ return String(s==null?"":s).replace(/\u2192/g,"to").replace(/\u2190/g,"<-").replace(/\u21b3/g,">").replace(/\u2713/g,"").replace(/\u2717|\u2715/g,"x").replace(/[\u2018\u2019]/g,"'").replace(/[\u201c\u201d]/g,'"').replace(/\u2026/g,"...").replace(/[\u2022\u25aa]/g,"-"); }

  async function exportPdf(btn,opts){ opts=opts||{}; const o=btn?btn.textContent:null; if(btn){ btn.textContent="Building PDF…"; btn.disabled=true; }
    try{ commit(); await ensurePDF(); const { jsPDF }=window.jspdf;
      const secs=sections(); const colKeys=isMulti()?secs.map(s=>s.key):[]; const colLabels=isMulti()?secs.map(s=>s.label):[];
      const useCols = isMulti() && colKeys.length<=6;     // dedicated section columns when they fit
      const doc=new jsPDF({unit:"pt",format:"letter",orientation:(useCols && colKeys.length>=3)?"landscape":"portrait"});
      const W=doc.internal.pageSize.getWidth(), M=42;
      const INK=[11,16,20], TEAL=[78,119,127], TEALD=[31,58,64], GOLD=[150,123,68], GRAY=[91,103,112], LIGHT=[234,241,241], IV=[243,239,230];
      // header band
      doc.setFillColor(INK[0],INK[1],INK[2]); doc.rect(0,0,W,88,"F");
      doc.setFillColor(GOLD[0],GOLD[1],GOLD[2]); doc.rect(0,88,W,2,"F"); // crisp gold rule under header
      const logo=logoData(); if(logo){ const h=40,w=logo.w*(h/logo.h); try{ doc.addImage(logo.dataURI,"PNG",M,26,w,h); }catch(e){} }
      doc.setTextColor(IV[0],IV[1],IV[2]); doc.setFont("times","bold"); doc.setFontSize(21); doc.text("Rehab Budget — Scope of Work", W-M, 42, {align:"right"});
      doc.setFont("times","italic"); doc.setFontSize(10.5); doc.setTextColor(GOLD[0],GOLD[1],GOLD[2]); doc.text("The scope of work serious investors say YES to.", W-M, 60, {align:"right"});
      doc.setFont("helvetica","normal"); doc.setFontSize(8); doc.setTextColor(170,178,182); doc.text("YS Capital Group · NMLS ID 2609746 · "+new Date().toLocaleDateString("en-US",{year:"numeric",month:"long",day:"numeric"}), W-M, 74, {align:"right"});
      let y=112;
      const PROJ={cosmetic:"Cosmetic refresh",moderate:"Moderate rehab",heavy:"Heavy / gut rehab",ground:"Ground-up construction"};
      const propLabel = !isMulti() ? "Single-family" : (unitCount()+(S.propType==="large"?"-unit building":"-unit multifamily"));
      const facts=[
        ["Property address", S.address||"—"],
        ["Transaction", S.txn==="refi"?"Refinance":"Purchase"],
        ["Property type", propLabel],
        ["Rehab type", S.projType?PROJ[S.projType]:"—"],
        ["Project timeline", S.months?(S.months+" months"):"—"],
        ["Target budget", S.target?money(num(S.target)):"—"]
      ];
      doc.setFontSize(9);
      for(let i=0;i<facts.length;i++){ const col=i%3, x=M+col*((W-2*M)/3); if(col===0&&i>0)y+=32; doc.setTextColor(GRAY[0],GRAY[1],GRAY[2]); doc.setFont("helvetica","bold"); doc.setFontSize(7.5); doc.text(pdfSafe(facts[i][0]).toUpperCase(),x,y); doc.setTextColor(18,22,26); doc.setFont("helvetica","bold"); doc.setFontSize(10.5); doc.text(pdfSafe(facts[i][1]),x,y+14); }
      y+=46;
      const vd=S.vd,vrows=[];
      const dlt=(a,b)=>{ const d=num(b)-num(a); return (num(a)||num(b))&&d!==0?("   ("+(d>0?"+":"")+d+")"):""; };
      const span=(a,b,suf)=> ((a||b)? ((a||"?")+" to "+(b||"?")+(suf||"")) : "");
      if(vd.expand)vrows.push(["Square footage", span(vd.sqftNow,vd.sqftAfter," sq ft")+dlt(vd.sqftNow,vd.sqftAfter)]);
      if(vd.beds)vrows.push(["Bedrooms", span(vd.bedsNow,vd.bedsAfter)+dlt(vd.bedsNow,vd.bedsAfter)]);
      if(vd.baths)vrows.push(["Bathrooms", span(vd.bathsNow,vd.bathsAfter)+dlt(vd.bathsNow,vd.bathsAfter)]);
      if(vd.basement)vrows.push(["Finished basement", vd.basementNotes||"Finishing the basement to add living area"]);
      if(vd.layout)vrows.push(["Layout change", vd.layoutNotes||"Reconfiguring the floor plan"]);
      if(vd.adu)vrows.push(["ADU / addition", vd.aduNotes||"Adding an accessory dwelling unit / addition"]);
      if(vd.curb)vrows.push(["Exterior / curb appeal", vd.curbNotes||"Exterior and curb-appeal improvements"]);
      if(vd.other)vrows.push(["Other value-add", vd.other]);
      if(vrows.length){
        const titleH=22, rowH=16, boxH=titleH+18+vrows.length*rowH+6;
        doc.setFillColor(247,250,250); doc.setDrawColor(TEAL[0],TEAL[1],TEAL[2]); doc.setLineWidth(1.1); doc.roundedRect(M,y,W-2*M,boxH,6,6,"FD");
        doc.setFillColor(TEALD[0],TEALD[1],TEALD[2]); doc.rect(M,y,W-2*M,titleH,"F");
        doc.setFont("helvetica","bold"); doc.setFontSize(9); doc.setTextColor(IV[0],IV[1],IV[2]); doc.text("VALUE DRIVERS — IMPROVEMENTS THAT SUPPORT THE AFTER-REPAIR VALUE", M+12, y+15);
        doc.setFont("helvetica","italic"); doc.setFontSize(8); doc.setTextColor(GRAY[0],GRAY[1],GRAY[2]); doc.text("What the appraiser should credit toward the after-repair value (ARV).", M+12, y+titleH+13);
        let yy=y+titleH+30; doc.setFontSize(9.5);
        vrows.forEach(r=>{ doc.setFont("helvetica","bold"); doc.setTextColor(TEALD[0],TEALD[1],TEALD[2]); doc.text(pdfSafe(r[0]), M+14, yy); doc.setFont("helvetica","normal"); doc.setTextColor(28,30,34); const dt=doc.splitTextToSize(pdfSafe(r[1]),W-2*M-185); doc.text(dt,M+172,yy); yy+=rowH; });
        y+=boxH+14;
      }
      if(S.narrative){ doc.setFont("helvetica","bold"); doc.setFontSize(8.5); doc.setTextColor(TEALD[0],TEALD[1],TEALD[2]); doc.text("NARRATIVE",M,y); y+=14; doc.setFont("helvetica","normal"); doc.setTextColor(35,38,42); doc.setFontSize(9); const ln=doc.splitTextToSize(pdfSafe(S.narrative),W-2*M); doc.text(ln,M,y); y+=ln.length*12+8; }

      const applyLbl={each:"Same each unit",split:"Per unit",common:"Common areas",exterior:"Exterior",project:"Project-wide"};
      let head, body=[], foot=[], colStyles;
      const moneyOr=v=> v? money(v) : "";
      if(useCols){
        head=[["#","Line item"].concat(colLabels).concat(["Total"])];
        const ncol=2+colKeys.length+1; let no=0;
        activeGroups().filter(c=>groupKeys(c.id).length).forEach(c=>{
          body.push([{content:c.label.toUpperCase(),colSpan:ncol-1,styles:{fillColor:LIGHT,textColor:TEALD,fontStyle:"bold"}},{content:money(catTotal(c.id)),styles:{fillColor:LIGHT,textColor:TEALD,fontStyle:"bold",halign:"right"}}]);
          groupKeys(c.id).forEach(key=>{ const it=st(key); no++;
            const row=[String(no),pdfSafe(metaOf(key).name)]; colKeys.forEach(k=> row.push(moneyOr(lineSectionVal(key,k)))); row.push(money(lineTotal(key))); body.push(row);
            if(it.desc) body.push([{content:"",styles:{}},{content:pdfSafe(it.desc),colSpan:ncol-1,styles:{fontStyle:"italic",textColor:GRAY,fontSize:7}}]);
            if(it.perUnitDesc && it.applies==="split"){ for(let u=1;u<=unitCount();u++){ const d=it.ud["u"+u]; if(d) body.push([{content:"",styles:{}},{content:pdfSafe("> Unit "+u+" - "+d),colSpan:ncol-1,styles:{fontStyle:"italic",textColor:GRAY,fontSize:7}}]); } }
          });
        });
        const spanL=ncol-1;
        const footRow=(l,v,strong)=>foot.push([{content:l,colSpan:spanL,styles:{halign:"left",fontStyle:"bold",fillColor:strong?LIGHT:[255,255,255],textColor:INK}},{content:money(v),styles:{halign:"right",fontStyle:"bold",fillColor:strong?LIGHT:[255,255,255],textColor:strong?TEALD:INK}}]);
        footRow("Subtotal",subtotal()); footRow("Contingency"+(S.cont.mode==="pct"&&S.cont.value?(" ("+S.cont.value+"%)"):""),contingency()); if(gcFeeAmt()>0)footRow("General Contractor fee",gcFeeAmt()); footRow("Soft costs",softTotal()); footRow("Hard costs",hardTotal()); footRow("TOTAL SCOPE OF WORK",grand(),true);
        colStyles={0:{cellWidth:22,halign:"center",textColor:GRAY},1:{cellWidth:useCols&&colKeys.length>=3?140:120}}; for(let i=0;i<colKeys.length;i++) colStyles[2+i]={halign:"right"}; colStyles[2+colKeys.length]={halign:"right",fontStyle:"bold"};
      } else {
        head=[["#","Line item","Detail",isMulti()?"Total":"Cost"]]; let no=0;
        activeGroups().filter(c=>groupKeys(c.id).length).forEach(c=>{
          body.push([{content:c.label.toUpperCase(),colSpan:3,styles:{fillColor:LIGHT,textColor:TEALD,fontStyle:"bold"}},{content:money(catTotal(c.id)),styles:{fillColor:LIGHT,textColor:TEALD,fontStyle:"bold",halign:"right"}}]);
          groupKeys(c.id).forEach(key=>{ const it=st(key); no++; let detail="";
            if(isMulti()){ if(it.applies==="split"){ const parts=[]; for(let u=1;u<=unitCount();u++){ const d=it.perUnitDesc?(it.ud["u"+u]||""):""; parts.push("U"+u+" "+money(num(it.u["u"+u]))+(d?(" ("+d+")"):"")); } detail=parts.join("   "); } else if(it.applies==="each"){ detail=money(num(it.each))+" × "+unitCount()+" units"; } else detail=(applyLbl[it.applies]||""); }
            if(it.desc) detail=(detail?detail+" — ":"")+it.desc; if(it.pct&&S.txn==="refi") detail=(detail?detail+" ":"")+"("+it.pct+"% done)";
            body.push([String(no),pdfSafe(metaOf(key).name),pdfSafe(detail),money(lineTotal(key))]); });
        });
        const footRow=(l,v,strong)=>foot.push([{content:l,colSpan:3,styles:{halign:"left",fontStyle:"bold",fillColor:strong?LIGHT:[255,255,255],textColor:INK}},{content:money(v),styles:{halign:"right",fontStyle:"bold",fillColor:strong?LIGHT:[255,255,255],textColor:strong?TEALD:INK}}]);
        footRow("Subtotal",subtotal()); footRow("Contingency"+(S.cont.mode==="pct"&&S.cont.value?(" ("+S.cont.value+"%)"):""),contingency()); if(gcFeeAmt()>0)footRow("General Contractor fee",gcFeeAmt()); footRow("Soft costs",softTotal()); footRow("Hard costs",hardTotal()); footRow("TOTAL SCOPE OF WORK",grand(),true);
        colStyles={0:{cellWidth:22,halign:"center",textColor:GRAY},1:{cellWidth:150},2:{cellWidth:"auto"},3:{cellWidth:70,halign:"right",fontStyle:"bold"}};
      }
      doc.autoTable({ startY:y+4, head:head, body:body, foot:foot, theme:"grid",
        styles:{font:"helvetica",fontSize:8,cellPadding:4,textColor:[40,40,40],lineColor:[220,225,226],overflow:"linebreak"},
        headStyles:{fillColor:INK,textColor:IV,fontStyle:"bold",halign:"left"},
        columnStyles:colStyles, margin:{left:M,right:M},
        didDrawPage:()=>{ const ph=doc.internal.pageSize.getHeight(); doc.setFontSize(7); doc.setTextColor(GRAY[0],GRAY[1],GRAY[2]); doc.setFont("helvetica","normal"); doc.text("For estimation & education only — not a quote, approval, or commitment to lend. Final budget and advance rates depend on full underwriting and appraisal.",M,ph-30,{maxWidth:W-2*M}); doc.text("© "+new Date().getFullYear()+" YS Capital Group · NMLS ID 2609746 · Equal Housing Lender",M,ph-16); }
      });
      const _pfn=fileBase()+".pdf";
      if(opts.returnFile){ if(btn){ btn.textContent=o; btn.disabled=false; } return new File([doc.output("blob")], _pfn, {type:"application/pdf"}); }
      doc.save(_pfn); flash("Branded PDF exported.");
    }catch(err){ if(opts.returnFile){ if(btn){btn.textContent=o;btn.disabled=false;} return null; } alert("PDF couldn't be generated here. On the published site it will download normally."); if(window.console)console.error(err); }
    finally{ if(btn){ btn.textContent=o; btn.disabled=false; } }
  }

  /* ---------- email to loan officer (team picker) ---------- */
  let _emailFiles=null;
  function emailBody(person){ const addr=S.address||"(property)"; const first=(person.n||"").split(" ")[0];
    return [ "Hi "+first+",", "", "Here is my scope of work for "+addr+".", "",
      "Transaction: "+(S.txn==="refi"?"Refinance":"Purchase"),
      "Property: "+(isMulti()?(unitCount()+" units"):"Single-family"),
      "Total scope of work: "+money(grand()),
      "Contingency: "+money(contingency())+(gcFeeAmt()>0?("   GC fee: "+money(gcFeeAmt())):""), "",
      "Live, editable breakdown:", shareUrl(), "", "Thank you." ].join("\n"); }
  // Build the PDF + Excel up front so the share call later fires inside a fresh
  // user gesture (the share API breaks if you build files after the click).
  async function emailLO(btn){ const o=btn?btn.textContent:null; if(btn){ btn.textContent="Preparing files…"; btn.disabled=true; }
    commit();
    let pdf=null,xls=null;
    try{ pdf=await exportPdf(null,{returnFile:true}); }catch(e){}
    try{ xls=await exportXlsx(null,{returnFile:true}); }catch(e){}
    _emailFiles={pdf:pdf,xls:xls};
    if(btn){ btn.textContent=o; btn.disabled=false; }
    openEmailPicker();
  }
  function openEmailPicker(){
    let ov=document.getElementById("rb-emailov"); if(ov) ov.remove();
    ov=document.createElement("div"); ov.id="rb-emailov"; ov.className="rb-ov";
    const groups=TEAM.map(g=>'<div class="rb-ov-group">'+esc(g.g)+'</div><div class="rb-ov-people">'+
      g.people.map(p=>'<button class="rb-ov-person" data-e="'+esc(p.e)+'" data-n="'+esc(p.n)+'"><span class="rb-ov-nm">'+esc(p.n)+'</span><span class="rb-ov-rl">'+esc(p.r)+'</span></button>').join("")+'</div>').join("");
    ov.innerHTML='<div class="rb-ov-box"><button class="rb-ov-x" aria-label="Close">✕</button>'+
      '<h3>Email your scope of work</h3>'+
      '<p>Pick who it goes to. On a phone the PDF + Excel attach right to the message; on a computer you\'ll get a ready-to-send draft (.eml) with both files already attached.</p>'+
      '<div class="rb-ov-list">'+groups+'</div></div>';
    document.body.appendChild(ov); document.body.style.overflow="hidden";
    const close=()=>{ ov.remove(); document.body.style.overflow=""; document.removeEventListener("keydown",onKey); };
    const onKey=e=>{ if(e.key==="Escape") close(); };
    document.addEventListener("keydown",onKey);
    ov.addEventListener("click",e=>{ if(e.target===ov) close(); });
    ov.querySelector(".rb-ov-x").onclick=close;
    ov.querySelectorAll(".rb-ov-person").forEach(b=> b.onclick=()=>{ close(); emailTo({n:b.dataset.n,e:b.dataset.e}); });
  }
  // Called synchronously off the person click so navigator.share keeps its gesture.
  function emailTo(person){
    const f=_emailFiles||{}; const files=[f.pdf,f.xls].filter(Boolean);
    const subj="Scope of Work — "+(S.address||"property"); const body=emailBody(person);
    if(files.length && navigator.canShare && navigator.canShare({files:files})){
      navigator.share({ files:files, title:subj, text:body })
        .then(function(){ flash("Pick Mail in the share sheet — the PDF & Excel are attached."); })
        .catch(function(err){ if(!(err&&err.name==="AbortError")) emailFallback(person,subj,body,files); });
      return;
    }
    emailFallback(person,subj,body,files);
  }
  async function emailFallback(person,subj,body,files){
    if(files.length){
      try{ await downloadEml(person,subj,body,files); flash("Draft (.eml) downloaded for "+person.n+" — open it and both files are already attached."); return; }
      catch(e){ if(window.console) console.error(e); }
    }
    files.forEach(function(f){ downloadBlob(f,f.name,f.type); });
    window.location.href="mailto:"+encodeURIComponent(person.e)+"?subject="+encodeURIComponent(subj)+"&body="+encodeURIComponent(body+"\n\n(The PDF & Excel just downloaded — please attach them.)");
    flash("Draft opened to "+person.n+".");
  }
  function fileToB64(file){ return new Promise(function(res,rej){ const r=new FileReader(); r.onload=function(){ const s=String(r.result); res(s.slice(s.indexOf(",")+1)); }; r.onerror=rej; r.readAsDataURL(file); }); }
  // Build a real RFC-822 .eml draft (X-Unsent:1 → opens in compose mode in classic
  // Outlook / Apple Mail / Thunderbird) with the PDF + Excel embedded as attachments.
  async function downloadEml(person,subj,body,files){
    const B="=_YSCAP_"+Date.now()+"_=";
    const wrap=function(s){ return s.replace(/(.{1,76})/g,"$1\r\n"); };
    let eml="To: "+person.e+"\r\nSubject: "+subj+"\r\nX-Unsent: 1\r\nDate: "+new Date().toUTCString()+"\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=\""+B+"\"\r\n\r\n";
    eml+="--"+B+"\r\nContent-Type: text/plain; charset=\"utf-8\"\r\nContent-Transfer-Encoding: base64\r\n\r\n"+wrap(btoa(unescape(encodeURIComponent(body))))+"\r\n";
    for(let i=0;i<files.length;i++){ const fl=files[i]; const b64=await fileToB64(fl);
      eml+="--"+B+"\r\nContent-Type: "+(fl.type||"application/octet-stream")+"; name=\""+fl.name+"\"\r\nContent-Transfer-Encoding: base64\r\nContent-Disposition: attachment; filename=\""+fl.name+"\"\r\n\r\n"+wrap(b64)+"\r\n"; }
    eml+="--"+B+"--\r\n";
    const blob=new Blob([eml],{type:"message/rfc822"});
    const a=document.createElement("a"); a.href=URL.createObjectURL(blob); a.download=fileBase()+".eml"; document.body.appendChild(a); a.click(); setTimeout(function(){ URL.revokeObjectURL(a.href); a.remove(); },1500);
  }

  /* ---------- prefill from the portal ----------
     When the borrower opens this tool from a loan file, the portal passes the
     application's known fields (e.g. the property address) as query params so
     they are NOT retyped. We only fill fields the borrower hasn't set yet — a
     restored/shared scope (#d=…) always wins, so in-progress work is never
     overwritten. */
  function prefillFromQuery(){
    try{
      if(!location.search) return;
      var q=new URLSearchParams(location.search);
      var addr=q.get("address");
      if(addr && !S.address) S.address=addr;
      var units=parseInt(q.get("units"),10);
      if(units>0 && (!S.units || S.units===1)) S.units=units;
      var txn=q.get("txn");
      if(txn && !S.txn && (txn==="purchase"||txn==="refi")) S.txn=txn;
      // property type + target budget from the loan file, so the builder
      // opens already matched to the application.
      var pt=q.get("propType");
      if(pt && !S.propType && (pt==="single"||pt==="multi"||pt==="large")){
        S.propType=pt;
        if(pt==="single") S.units=1;
        else if(pt==="multi" && !(units>=2&&units<=4)) S.units=2;
        else if(pt==="large" && !(units>=5)) S.units=5;
      }
      var target=parseFloat(String(q.get("target")||"").replace(/[^0-9.]/g,""));
      if(target>0 && !S.target) S.target=String(Math.round(target));
      var pj=q.get("projType");
      if(pj && !S.projType && /^(cosmetic|moderate|heavy|ground)$/.test(pj)) S.projType=pj;
    }catch(e){}
  }

  /* ---------- portal bridge state accessors ----------
     Used by rehab-budget-portal.js when the tool is opened from a loan file:
     the saved condition state replaces the URL-hash state, and submit reads
     the full state + grand total back out. */
  function setState(o){
    if(!o||typeof o!=="object") return;
    S=Object.assign(blank(),o);
    S.vd=Object.assign(blank().vd,o.vd||{});
    S.cont=Object.assign(blank().cont,o.cont||{});
    S.gcFee=Object.assign(blank().gcFee,o.gcFee||{});
    S.custom=o.custom||[];
    render();
  }

  /* ---------- init ---------- */
  function init(){ restore(); prefillFromQuery(); render(); document.addEventListener("click",()=>{ document.querySelectorAll(".rb-tip.show").forEach(t=>t.classList.remove("show")); }); }
  document.addEventListener("DOMContentLoaded", init);
  return { share, exportXlsx, importXlsx, exportPdf, emailLO,
           getState:()=>snap(), setState, grandTotal:()=>grand(), commit };
})();
if(typeof window!=="undefined") window.RB = RB;
