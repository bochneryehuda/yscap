/* =====================================================================
   YS Capital Group — Borrower Track Record Builder
   Standalone, client-side. Mirrors the rehab tool's architecture:
   URL-hash persistence + xlsx-js-style + jsPDF exports, embedded logo.
   ===================================================================== */
const TR=(function(){
  "use strict";
  const $=s=>document.querySelector(s), $$=s=>Array.from(document.querySelectorAll(s));

  /* ---------- constants ---------- */
  const PROP_TYPES=["Single-family","2-4 unit residential","5+ unit multifamily","Condo / townhome","Mixed-use","Commercial","Land / lot"];
  const STATUS={
    pending:{label:"Pending review", cls:"pending", desc:"Submitted, not yet reviewed."},
    docs:{label:"Documentation required", cls:"docs", desc:"Needs a closing statement, deed, or lease to verify."},
    verified:{label:"Verified", cls:"verified", desc:"Confirmed with documentation."},
    limited:{label:"Limited verification", cls:"limited", desc:"Confirmed online (public record); no documentation on file."}
  };
  const EXIT_WINDOW_MO=36;   // deals exited within 36 months count toward current experience
  const MAX_HOLD_MO=12;      // > 12 months from purchase to exit is flagged
  // Clean line-art icons (modern, no emoji)
  const IC={
    hold:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 11.3 12 4l9 7.3"/><path d="M5.4 9.6V20h13.2V9.6"/><path d="M9.8 20v-5.2h4.4V20"/></svg>',
    flip:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 11.3 12 4l9 7.3"/><path d="M5.4 9.6V20h13.2V9.6"/><path d="M15 5.6a4.4 4.4 0 0 1 .2 8M14.4 16.2 16 13.9l2.3 1"/></svg>',
    edit:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h4L18.5 9.5l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/></svg>',
    dup:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h8"/></svg>',
    del:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16"/><path d="M9.5 7V4.5h5V7"/><path d="M6.5 7l1 12.5h9l1-12.5"/><path d="M10 10.5v6M14 10.5v6"/></svg>'
  };

  /* ---------- state ---------- */
  function blank(){ return { borrower:"", loMode:false, filterKind:"all", groupBy:"none", props:[] }; }
  function blankProp(kind){ return {
    id:"p"+Math.random().toString(36).slice(2,9),
    kind:kind||"flip",
    address:"", city:"", state:"", zip:"", entity:"", ownedPersonally:false, propType:"", seller:"",
    purchasePrice:"", purchaseDate:"", rehab:"",
    salePrice:"", saleDate:"",
    rent:"", rentDate:"", refiAmount:"", refiDate:"", currentValue:"",
    notes:"", status:"pending", loNotes:""
  }; }
  let S=blank();
  let editingId=null, addKind=null;  // add/edit overlay state

  /* ---------- helpers ---------- */
  function num(v){ if(v==null) return 0; const n=parseFloat(String(v).replace(/[^0-9.\-]/g,"")); return isFinite(n)?n:0; }
  function money(v){ const n=num(v); return "$"+Math.round(n).toLocaleString("en-US"); }
  function money2(v){ const n=num(v); return "$"+n.toLocaleString("en-US",{minimumFractionDigits:0,maximumFractionDigits:0}); }
  function esc(s){ return String(s==null?"":s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])); }
  function parseDate(s){ if(!s) return null; const m=/^(\d{4})-(\d{2})-(\d{2})/.exec(String(s)); if(m) return new Date(+m[1],+m[2]-1,+m[3]); const d=new Date(s); return isNaN(d)?null:d; }
  function fmtDate(s){ const d=parseDate(s); if(!d) return ""; return (d.getMonth()+1)+"/"+String(d.getDate()).padStart(2,"0")+"/"+d.getFullYear(); }
  function monthsBetween(a,b){ const da=parseDate(a),db=parseDate(b); if(!da||!db) return null; return (db.getFullYear()-da.getFullYear())*12+(db.getMonth()-da.getMonth())+(db.getDate()>=da.getDate()?0:-1); }
  function monthsAgo(s){ const d=parseDate(s); if(!d) return null; const now=new Date(); return (now.getFullYear()-d.getFullYear())*12+(now.getMonth()-d.getMonth())+(now.getDate()>=d.getDate()?0:-1); }
  function addrLine(p){ const a=[p.address, [p.city,p.state].filter(Boolean).join(", "), p.zip].filter(x=>x&&String(x).trim()).join(", "); return a||"(no address)"; }
  function flash(msg){ const f=$("#tr-flash"); if(!f) return; f.textContent=msg; f.classList.add("show"); clearTimeout(flash._t); flash._t=setTimeout(()=>f.classList.remove("show"),2800); }

  /* ---------- per-record derived figures ---------- */
  // The entity a deal was held under, for display/exports: the LLC name, or
  // "Personal name" when the borrower held it personally (no LLC).
  function entityLabel(p){ return p.ownedPersonally ? "Personal name" : (p.entity||""); }
  function exitDate(p){ return p.kind==="flip" ? p.saleDate : (p.rentDate||p.refiDate); }
  function exitLabel(p){ return p.kind==="flip" ? "Sold" : (p.rentDate?"Leased":(p.refiDate?"Refinanced":"Exit")); }
  function holdMonths(p){ return monthsBetween(p.purchaseDate, exitDate(p)); }

  function validate(p){
    const errs=[], alerts=[], warns=[];
    if(!String(p.address).trim()) errs.push("Property address is required.");
    if(!num(p.purchasePrice)) errs.push("Purchase price is required.");
    if(!p.purchaseDate) errs.push("Purchase date is required.");
    if(!num(p.rehab)) errs.push("Rehab budget is required.");
    if(p.kind==="flip"){
      if(!num(p.salePrice)) errs.push("Sale price is required for a flip.");
      if(!p.saleDate) errs.push("Sale date is required for a flip.");
    } else {
      if(!num(p.rent) && !num(p.refiAmount)) errs.push("Enter the monthly rent (or a refinance amount) for a hold.");
      if(!p.rentDate && !p.refiDate) errs.push("Enter the date it was rented out (or refinanced).");
    }
    const ex=exitDate(p), pd=p.purchaseDate;
    if(pd && ex){
      const hm=monthsBetween(pd,ex);
      if(hm!=null && hm<0) errs.push("The exit date is before the purchase date.");
      else if(hm!=null && hm>MAX_HOLD_MO) alerts.push("More than 12 months between purchase and exit ("+hm+" mo) — long for a "+(p.kind==="flip"?"flip":"value-add hold")+"; underwriting will likely ask about this.");
      const ma=monthsAgo(ex);
      if(ma!=null && ma>EXIT_WINDOW_MO) warns.push("Exit is older than 3 years ("+(Math.floor(ma/12))+" yr ago) — it does NOT count toward your experience tier or brackets.");
      else if(ma!=null && ma<0) warns.push("Exit date is in the future — it won't count toward your experience tier until it actually closes.");
    }
    return {errs,alerts,warns};
  }
  function recordOK(p){ return validate(p).errs.length===0; }   // blocking errors only
  function qualifies(p){
    // OWNER-DIRECTED — FROZEN (2026-07-07): ONLY a completed exit whose date is
    // within the last 3 years counts toward experience / brackets. An exit MORE
    // than 3 years ago counts toward NOTHING — not the tier, not experience, not
    // through anything. A future-dated exit also does not count (it hasn't
    // happened yet). Applies to the sale date (flips) and the lease/refi date
    // (holds) via exitDate(). Do not widen this window without owner direction.
    if(!recordOK(p)) return false;
    const ma=monthsAgo(exitDate(p));
    return ma!=null && ma>=0 && ma<=EXIT_WINDOW_MO;
  }

  /* ---------- portfolio summary ---------- */
  function summary(){
    const ps=S.props;
    const flips=ps.filter(p=>p.kind==="flip"), holds=ps.filter(p=>p.kind==="hold");
    const valid=ps.filter(recordOK);
    const qual=ps.filter(qualifies);
    const verified=ps.filter(p=>p.status==="verified"||p.status==="limited");
    const issues=ps.filter(p=>{ const v=validate(p); return v.errs.length||v.alerts.length||v.warns.length; });
    const vol=ps.reduce((s,p)=>s+num(p.purchasePrice),0);
    const rehab=ps.reduce((s,p)=>s+num(p.rehab),0);
    const holdsMo=valid.map(holdMonths).filter(m=>m!=null&&m>=0);
    const avgHold=holdsMo.length?Math.round(holdsMo.reduce((a,b)=>a+b,0)/holdsMo.length):null;
    const qn=qual.length;
    let tier="New investor", tcls="t0", tnext="Add your first completed exit within the last 3 years.";
    if(qn>=10){ tier="Expert"; tcls="t4"; tnext="10+ qualifying exits — top tier."; }
    else if(qn>=5){ tier="Seasoned"; tcls="t3"; tnext=(10-qn)+" more qualifying exits to reach Expert."; }
    else if(qn>=3){ tier="Experienced"; tcls="t2"; tnext=(5-qn)+" more to reach Seasoned."; }
    else if(qn>=1){ tier="Emerging"; tcls="t1"; tnext=(3-qn)+" more to reach Experienced."; }
    return {total:ps.length, flips:flips.length, holds:holds.length, valid:valid.length, qual:qn,
      verified:verified.length, issues:issues.length, vol, rehab, avgHold, tier, tcls, tnext};
  }

  /* ===================== RENDER ===================== */
  function render(){
    const root=$("#tr-app"); if(!root) return;
    root.innerHTML = viewSummary()+viewToolbar()+viewSections()+viewExportBar();
    wire();
    if(window.TR_PORTAL_ONRENDER){ try{ window.TR_PORTAL_ONRENDER(); }catch(e){} }
    save();
  }

  function viewSummary(){
    const s=summary();
    const stat=(v,l)=>'<div class="tr-stat"><div class="tr-stat-v">'+v+'</div><div class="tr-stat-l">'+l+'</div></div>';
    return '<section class="tr-summary">'+
      '<div class="tr-rank '+s.tcls+'">'+
        '<div class="tr-rank-main"><span class="tr-rank-eyebrow">Experience ranking</span><span class="tr-rank-tier">'+s.tier+'</span></div>'+
        '<div class="tr-rank-prog">'+
          '<div class="tr-rank-bar"><span style="width:'+Math.min(100,s.qual/10*100)+'%"></span></div>'+
          '<div class="tr-rank-sub">'+s.qual+' of '+s.total+' deal'+(s.total===1?"":"s")+' count as qualifying exits — completed and closed within the last 3 years · '+s.tnext+'</div>'+
        '</div>'+
      '</div>'+
      '<div class="tr-stats">'+
        stat(s.total, "Deals on record")+
        stat(s.flips, "Fix &amp; flips")+
        stat(s.holds, "Fix &amp; holds")+
        stat(money(s.vol), "Acquisition volume")+
        stat(money(s.rehab), "Rehab invested")+
        stat(s.avgHold!=null?(s.avgHold+" mo"):"—", "Avg hold")+
      '</div>'+
      (s.issues?('<div class="tr-summary-flag">⚠ '+s.issues+' record'+(s.issues===1?"":"s")+' need'+(s.issues===1?"s":"")+' attention — see the highlighted entries below.</div>'):'')+
    '</section>';
  }

  function viewToolbar(){
    const fbtn=(v,l)=>'<button class="tr-chip'+(S.filterKind===v?" on":"")+'" data-filter="'+v+'">'+l+'</button>';
    return '<section class="tr-toolbar">'+
      '<button class="tr-btn primary" data-add="1">+ Add a property</button>'+
      '<div class="tr-filters">'+fbtn("all","All")+fbtn("flip","Fix & flips")+fbtn("hold","Fix & holds")+'</div>'+
      '<div class="tr-toolbar-right">'+
        '<button class="tr-chip'+(S.groupBy==="entity"?" on":"")+'" data-group="'+(S.groupBy==="entity"?"none":"entity")+'" title="Group records by the LLC / entity on record">'+(S.groupBy==="entity"?"Ungroup":"Group by entity")+'</button>'+
      '</div>'+
    '</section>';
  }

  function sectionList(kind){
    let list=S.props.filter(p=>p.kind===kind);
    if(S.groupBy==="entity"){
      const groups={};
      list.forEach(p=>{ const k=(entityLabel(p)||"").trim()||"— No entity on record —"; (groups[k]=groups[k]||[]).push(p); });
      return Object.keys(groups).sort().map(g=>'<div class="tr-group"><div class="tr-group-h">'+esc(g)+' <span>'+groups[g].length+'</span></div>'+groups[g].map(card).join("")+'</div>').join("");
    }
    return list.map(card).join("");
  }

  function viewSections(){
    const show=k=>S.filterKind==="all"||S.filterKind===k;
    let out="";
    if(show("flip")){
      const n=S.props.filter(p=>p.kind==="flip").length;
      out+='<section class="tr-section"><div class="tr-section-h"><h2><span class="tr-secicon flip">'+IC.flip+'</span>Fix &amp; Flip experience</h2><span class="tr-section-sub">'+n+' propert'+(n===1?"y":"ies")+' · exit = sale</span></div>'+
        (n?sectionList("flip"):emptyState("flip"))+'</section>';
    }
    if(show("hold")){
      const n=S.props.filter(p=>p.kind==="hold").length;
      out+='<section class="tr-section"><div class="tr-section-h"><h2><span class="tr-secicon hold">'+IC.hold+'</span>Fix &amp; Hold / Rental experience</h2><span class="tr-section-sub">'+n+' propert'+(n===1?"y":"ies")+' · exit = lease-up / refinance</span></div>'+
        (n?sectionList("hold"):emptyState("hold"))+'</section>';
    }
    return out;
  }

  function emptyState(kind){
    const t=kind==="flip"?"fix &amp; flip":"fix &amp; hold";
    return '<div class="tr-empty"><div class="tr-empty-ic">'+(kind==="flip"?IC.flip:IC.hold)+'</div><p>No '+t+' deals yet.</p><button class="tr-btn line" data-add="'+kind+'">+ Add a '+t+' deal</button></div>';
  }

  function card(p){
    const v=validate(p);
    const ex=exitDate(p), hm=holdMonths(p);
    const figs=[];
    figs.push(["Purchase", (num(p.purchasePrice)?money(p.purchasePrice):"—")+(p.purchaseDate?(" · "+fmtDate(p.purchaseDate)):"")]);
    if(num(p.rehab)) figs.push(["Rehab", money(p.rehab)]);
    if(p.kind==="flip") figs.push(["Sold", (num(p.salePrice)?money(p.salePrice):"—")+(p.saleDate?(" · "+fmtDate(p.saleDate)):"")]);
    else { if(num(p.rent)||p.rentDate) figs.push(["Rented", (num(p.rent)?money(p.rent)+"/mo":"—")+(p.rentDate?(" · "+fmtDate(p.rentDate)):"")]);
           if(num(p.refiAmount)||p.refiDate) figs.push(["Refinanced", (num(p.refiAmount)?money(p.refiAmount):"—")+(p.refiDate?(" · "+fmtDate(p.refiDate)):"")]); }
    if(hm!=null && hm>=0) figs.push(["Hold period", hm+" mo"]);
    if(p.kind==="flip"&&num(p.salePrice)&&num(p.purchasePrice)){ const profit=num(p.salePrice)-num(p.purchasePrice)-num(p.rehab); figs.push(["Gross spread", (profit<0?"-":"")+money(Math.abs(profit))]); }

    const chips=v.errs.concat(v.alerts).map(e=>'<span class="tr-chip-err">⚠ '+esc(e)+'</span>').join("")+v.warns.map(w=>'<span class="tr-chip-warn">⚠ '+esc(w)+'</span>').join("");
    const hasErr=v.errs.length||v.alerts.length;
    const qual=qualifies(p);

    return '<article class="tr-card'+(hasErr?" has-err":(v.warns.length?" has-warn":""))+(qual?" qual":"")+'" data-card="'+p.id+'">'+
      '<div class="tr-card-main">'+
        '<div class="tr-card-head">'+
          '<span class="tr-badge '+p.kind+'">'+(p.kind==="flip"?"Fix &amp; Flip":"Fix &amp; Hold")+'</span>'+
          (p.propType?'<span class="tr-badge-2">'+esc(p.propType)+'</span>':'')+
          (qual?'<span class="tr-qual" title="Counts toward your 3-year experience tier">Recent exit</span>':(ex&&recordOK(p)?'<span class="tr-qual out" title="Older than 3 years — outside the experience window">Outside 3-yr window</span>':''))+
        '</div>'+
        '<div class="tr-card-addr">'+esc(addrLine(p))+(entityLabel(p)?'<span class="tr-card-entity">'+esc(entityLabel(p))+'</span>':'')+'</div>'+
        '<div class="tr-figs">'+figs.map(f=>'<div class="tr-fig"><span class="k">'+f[0]+'</span><span class="v">'+esc(f[1])+'</span></div>').join("")+'</div>'+
        (p.notes?'<div class="tr-notes">'+esc(p.notes)+'</div>':'')+
        (chips?'<div class="tr-chips">'+chips+'</div>':'')+
      '</div>'+
      '<div class="tr-card-actions">'+
        '<button class="tr-icon" data-edit="'+p.id+'" title="Edit">'+IC.edit+'</button>'+
        '<button class="tr-icon" data-dup="'+p.id+'" title="Duplicate">'+IC.dup+'</button>'+
        '<button class="tr-icon danger" data-del="'+p.id+'" title="Delete">'+IC.del+'</button>'+
      '</div>'+
    '</article>';
  }

  function viewExportBar(){
    return '<section class="tr-exportbar">'+
      '<div class="tr-export-txt"><b>Export your track record.</b> A branded PDF report and an Excel workbook with separate Fix &amp; Flip and Fix &amp; Hold sections. Re-import the Excel here anytime to keep editing.</div>'+
      '<div class="tr-export-btns">'+
        '<button class="tr-btn primary" data-exp="pdf">Export branded PDF ⤓</button>'+
        '<button class="tr-btn line" data-exp="xlsx">Export Excel ⤓</button>'+
      '</div>'+
    '</section>';
  }

  /* ===================== ADD / EDIT OVERLAY ===================== */
  function openChooser(){
    addKind=null; editingId=null;
    const ov=mkOverlay();
    ov.querySelector(".tr-ov-box").innerHTML=
      '<button class="tr-ov-x" aria-label="Close">✕</button>'+
      '<h3>Add a property</h3><p>What kind of deal was this? Pick one — you can change it later.</p>'+
      '<div class="tr-choose">'+
        '<button class="tr-choose-card" data-kind="flip"><span class="tr-choose-ic flip">'+IC.flip+'</span><span class="tr-choose-t">Fix &amp; Flip</span><span class="tr-choose-d">You bought, renovated, and <b>sold</b> it. We\'ll ask for the sale price and date.</span></button>'+
        '<button class="tr-choose-card" data-kind="hold"><span class="tr-choose-ic hold">'+IC.hold+'</span><span class="tr-choose-t">Fix &amp; Hold / Rental</span><span class="tr-choose-d">You bought, renovated, and <b>kept it as a rental</b>. We\'ll ask for the rent and lease date.</span></button>'+
      '</div>';
    ov.querySelector(".tr-ov-x").onclick=ov._close;
    ov.querySelectorAll("[data-kind]").forEach(b=> b.onclick=()=> openForm(blankProp(b.dataset.kind)) );
  }

  function openForm(p){
    addKind=p.kind; editingId=p.id;
    const ov=$("#tr-ov")||mkOverlay();
    const isFlip=p.kind==="flip";
    const opt=(sel)=>PROP_TYPES.map(t=>'<option'+(sel===t?" selected":"")+'>'+t+'</option>').join("");
    ov.querySelector(".tr-ov-box").innerHTML=
      '<button class="tr-ov-x" aria-label="Close">✕</button>'+
      '<div class="tr-form-head"><span class="tr-badge '+p.kind+'">'+(isFlip?"Fix &amp; Flip":"Fix &amp; Hold")+'</span><h3>'+(editingId&&S.props.some(x=>x.id===p.id)?"Edit property":"Add property")+'</h3>'+
        '<button class="tr-switch" data-switch="'+(isFlip?"hold":"flip")+'">Switch to '+(isFlip?"Fix &amp; Hold":"Fix &amp; Flip")+'</button></div>'+
      '<div class="tr-form">'+
        grp("Property",[
          fld("Property address","address",p.address,"text","123 Main St","wide"),
          fld("City","city",p.city),
          fld("State","state",p.state,"text","NY","sm"),
          fld("ZIP","zip",p.zip,"text","","sm"),
          sel2("Property type","propType",p.propType,opt(p.propType)),
          chk("Owned under my personal name","ownedPersonally",p.ownedPersonally,"No LLC — this property was held in your own name","wide"),
          fld("LLC / entity on record","entity",p.entity,"text","Optional — e.g. 123 Main LLC","wide opt"+(p.ownedPersonally?" hide":""))
        ])+
        grp("Acquisition",[
          fld("Purchase price","purchasePrice",p.purchasePrice,"money"),
          fld("Purchase date","purchaseDate",p.purchaseDate,"date"),
          fld("Rehab budget","rehab",p.rehab,"money")
        ])+
        (isFlip?
          grp("Exit — Sale",[
            fld("Sale price","salePrice",p.salePrice,"money"),
            fld("Sale date","saleDate",p.saleDate,"date")
          ])
          :
          grp("Exit — Lease-up / Refinance",[
            fld("Monthly rent","rent",p.rent,"money"),
            fld("Date rented out (lease date)","rentDate",p.rentDate,"date"),
            fld("Cash-out refinance amount","refiAmount",p.refiAmount,"money","Optional","opt"),
            fld("Refinance date","refiDate",p.refiDate,"date","","opt"),
            fld("Current / appraised value","currentValue",p.currentValue,"money","Optional","opt")
          ])
        )+
        grp("Notes",[ fld("Notes","notes",p.notes,"text","Anything the underwriter should know (optional)","wide opt") ])+
        '<div class="tr-form-msg" id="tr-form-msg"></div>'+
      '</div>'+
      '<div class="tr-form-foot"><button class="tr-btn ghost" data-cancel="1">Cancel</button><button class="tr-btn primary" data-save="1">'+(S.props.some(x=>x.id===p.id)?"Save changes":"Add property")+'</button></div>';
    // stash working copy
    ov._work=Object.assign({},p);
    wireForm(ov);
    // Portal bridge: LLC linking + address autocomplete on the open form.
    if(window.TR_PORTAL_ONFORM){ try{ window.TR_PORTAL_ONFORM(ov); }catch(e){} }
  }

  function grp(title,fields){ return '<div class="tr-fgrp"><div class="tr-fgrp-h">'+title+'</div><div class="tr-fgrid">'+fields.join("")+'</div></div>'; }
  function fld(label,key,val,type,ph,cls){ type=type||"text"; const adorn=type==="money"?'<span class="tr-adorn">$</span>':''; const it=type==="money"?"text":type;
    return '<div class="tr-fld '+(cls||"")+'"><label>'+label+(/\bopt\b/.test(cls||"")?' <em>(optional)</em>':'')+'</label><div class="tr-inp'+(type==="money"?" money":"")+'">'+adorn+'<input data-f="'+key+'" type="'+it+'"'+(type==="money"?' inputmode="decimal"':'')+' value="'+esc(val)+'"'+(ph?(' placeholder="'+esc(ph)+'"'):'')+'></div></div>'; }
  function sel2(label,key,val,opts,cls){ return '<div class="tr-fld '+(cls||"")+'"><label>'+label+'</label><div class="tr-inp sel"><select data-f="'+key+'"><option value="">Select…</option>'+opts+'</select></div></div>'; }
  function chk(label,key,val,hint,cls){ return '<div class="tr-fld check '+(cls||"")+'"><label class="tr-check"><input type="checkbox" data-f="'+key+'"'+(val?' checked':'')+'><span class="tr-check-t">'+label+(hint?'<em>'+hint+'</em>':'')+'</span></label></div>'; }

  function mkOverlay(){
    let ov=$("#tr-ov"); if(ov) ov.remove();
    ov=document.createElement("div"); ov.id="tr-ov"; ov.className="tr-ov";
    ov.innerHTML='<div class="tr-ov-box"></div>';
    document.body.appendChild(ov); document.body.style.overflow="hidden";
    const close=()=>{ ov.remove(); document.body.style.overflow=""; document.removeEventListener("keydown",onKey); };
    const onKey=e=>{ if(e.key==="Escape") close(); };
    document.addEventListener("keydown",onKey);
    ov.addEventListener("click",e=>{ if(e.target===ov) close(); });
    ov._close=close;
    return ov;
  }

  // Turn a blocking-error string ("Purchase price is required.") into a short
  // field label for the non-blocking "still needed" warning list.
  function missingLabel(e){ return String(e).replace(/\s*is required.*$/i,'').replace(/\s*for a (flip|hold)\.?$/i,'').replace(/^Enter (the )?/i,'').replace(/\.$/,'').trim(); }
  function wireForm(ov){
    ov.querySelector(".tr-ov-x").onclick=ov._close;
    ov.querySelectorAll("[data-cancel]").forEach(b=>b.onclick=ov._close);
    const msg=ov.querySelector("#tr-form-msg");
    const fval=el=>el.type==="checkbox"?el.checked:el.value;
    const readInputs=()=>{ ov.querySelectorAll("[data-f]").forEach(el=>{ ov._work[el.dataset.f]=fval(el); }); };
    // "Owned under my personal name" excludes an entity: hide + clear the
    // LLC/entity input while it's on.
    function syncPersonal(){
      const on=!!ov._work.ownedPersonally;
      const ent=ov.querySelector('[data-f="entity"]');
      if(!ent) return;
      const fld=ent.closest(".tr-fld");
      if(fld) fld.classList.toggle("hide",on);
      if(on && ent.value){ ent.value=""; ov._work.entity=""; }
    }
    // AUTOSAVE (owner-directed 2026-07-12): every line item saves as you type —
    // no Save click required, and NO field is mandatory except the address (the
    // line's identity). Partial entries persist; a live warning at the bottom
    // lists what's still needed to COUNT toward experience, but never blocks.
    function paintMsg(){
      const p=ov._work; const v=validate(p);
      const hasAddr=!!String(p.address||"").trim();
      if(!hasAddr){ msg.className="tr-form-msg info"; msg.innerHTML="Enter a property address to start — everything else saves as you go."; return; }
      if(v.errs.length){ msg.className="tr-form-msg warn"; msg.innerHTML="✔ Saved. Still needed to count toward your experience: <b>"+v.errs.map(e=>esc(missingLabel(e))).join("</b> · <b>")+"</b>"; }
      else if(v.warns.length){ msg.className="tr-form-msg warn"; msg.innerHTML="✔ Saved. "+v.warns.map(esc).join(" · "); }
      else { msg.className="tr-form-msg ok"; msg.innerHTML="✔ Saved — this deal is complete and counts toward your experience."; }
    }
    // Commit the working entry into S.props + persist (server/hash) — requires
    // only a non-empty address so we never create a totally-blank row.
    function commit(){ const p=ov._work; if(!String(p.address||"").trim()) return false;
      const i=S.props.findIndex(x=>x.id===p.id); if(i>=0) S.props[i]=Object.assign({},p); else S.props.push(Object.assign({},p)); save(); return true; }
    let _t=null;
    ov.querySelectorAll("[data-f]").forEach(el=> el.addEventListener("input",()=>{
      ov._work[el.dataset.f]=fval(el);
      if(el.dataset.f==="ownedPersonally") syncPersonal();
      clearTimeout(_t); _t=setTimeout(()=>{ commit(); paintMsg(); }, 450);
    }));
    const sw=ov.querySelector("[data-switch]"); if(sw) sw.onclick=()=>{ readInputs(); commit(); ov._work.kind=sw.dataset.switch; openForm(ov._work); };
    ov.querySelector("[data-save]").onclick=()=>{
      readInputs(); const p=ov._work;
      if(!String(p.address||"").trim()){ msg.className="tr-form-msg err"; msg.innerHTML="A property address is required to save this line."; msg.scrollIntoView({behavior:"smooth",block:"center"}); return; }
      const existed=S.props.some(x=>x.id===p.id); commit(); ov._close(); render();
      const v=validate(p);
      flash((existed?"Saved":"Added")+" — "+addrLine(p)+(v.errs.length?(" · still needs "+v.errs.length+" field"+(v.errs.length===1?"":"s")):" · complete"));
    };
    paintMsg();
  }

  /* ===================== WIRE MAIN ===================== */
  function wire(){
    $$("[data-add]").forEach(b=> b.onclick=()=>{ const k=b.dataset.add; if(k==="flip"||k==="hold") openForm(blankProp(k)); else openChooser(); });
    $$("[data-filter]").forEach(b=> b.onclick=()=>{ S.filterKind=b.dataset.filter; render(); });
    $$("[data-group]").forEach(b=> b.onclick=()=>{ S.groupBy=b.dataset.group; render(); });
    $$("[data-edit]").forEach(b=> b.onclick=()=>{ const p=S.props.find(x=>x.id===b.dataset.edit); if(p) openForm(Object.assign({},p)); });
    $$("[data-dup]").forEach(b=> b.onclick=()=>{ const p=S.props.find(x=>x.id===b.dataset.dup); if(p){ const c=Object.assign({},p,{id:blankProp().id}); S.props.push(c); render(); flash("Duplicated."); } });
    $$("[data-del]").forEach(b=> b.onclick=()=>{ const p=S.props.find(x=>x.id===b.dataset.del); if(p && confirm("Delete this property?\n"+addrLine(p))){ S.props=S.props.filter(x=>x.id!==b.dataset.del); render(); flash("Deleted."); } });
    $$("[data-exp]").forEach(b=> b.onclick=()=>{ if(b.dataset.exp==="pdf") exportPdf(b); else exportXlsx(b); });
  }

  /* ===================== PERSISTENCE (URL hash) ===================== */
  function snap(){ return { v:1, borrower:S.borrower, props:S.props }; }
  function enc(o){ return btoa(unescape(encodeURIComponent(JSON.stringify(o)))); }
  function dec(s){ try{ return JSON.parse(decodeURIComponent(escape(atob(s)))); }catch(e){ return null; } }
  let _saveT=null;
  function save(){ clearTimeout(_saveT); _saveT=setTimeout(()=>{
    // Portal bridge: when opened as the LIVE track record (borrower section /
    // loan file), state persists to the server, not the URL hash.
    if(window.TR_PORTAL){ if(window.TR_PORTAL_ONSAVE){ try{ window.TR_PORTAL_ONSAVE(snap()); }catch(e){} } return; }
    try{ history.replaceState(null,"","#d="+enc(snap())); }catch(e){}
  },300); }
  function restore(){ try{ const m=/[#&]d=([^&]+)/.exec(location.hash); if(m){ const o=dec(m[1]); if(o&&Array.isArray(o.props)){ S=blank(); S.borrower=o.borrower||""; S.props=o.props.map(p=>Object.assign(blankProp(p.kind),p)); } } }catch(e){} }

  /* ===================== EXPORT HELPERS (shared with rehab) ===================== */
  function loadScript(src){ return new Promise((res,rej)=>{ const s=document.createElement("script"); s.src=src; s.onload=res; s.onerror=rej; document.head.appendChild(s); }); }
  async function ensureXLSX(){ if(window.XLSX&&window.XLSX.utils) return;
    // Local vendored copy first (instant, works offline/behind firewalls); CDN as fallback.
    try{ await loadScript("vendor/xlsx.bundle.js"); }
    catch(e){ try{ await loadScript("https://cdn.jsdelivr.net/npm/xlsx-js-style@1.2.0/dist/xlsx.bundle.js"); }
    catch(e2){ await loadScript("https://unpkg.com/xlsx-js-style@1.2.0/dist/xlsx.bundle.js"); } }
    if(!(window.XLSX&&window.XLSX.utils)) throw new Error("spreadsheet library failed to load"); }
  async function ensurePDF(){ if(window.jspdf&&window.jspdf.jsPDF){ if(!window.jspdf.jsPDF.API.autoTable){ try{ await loadScript("vendor/jspdf.plugin.autotable.min.js"); }catch(e){ try{ await loadScript("https://cdn.jsdelivr.net/npm/jspdf-autotable@3.8.2/dist/jspdf.plugin.autotable.min.js"); }catch(e2){} } } return; }
    try{ await loadScript("vendor/jspdf.umd.min.js"); }
    catch(e){ try{ await loadScript("https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.umd.min.js"); }catch(e2){ await loadScript("https://unpkg.com/jspdf@2.5.1/dist/jspdf.umd.min.js"); } }
    try{ await loadScript("vendor/jspdf.plugin.autotable.min.js"); }
    catch(e){ try{ await loadScript("https://cdn.jsdelivr.net/npm/jspdf-autotable@3.8.2/dist/jspdf.plugin.autotable.min.js"); }catch(e2){ await loadScript("https://unpkg.com/jspdf-autotable@3.8.2/dist/jspdf.plugin.autotable.min.js"); } }
    if(!(window.jspdf&&window.jspdf.jsPDF)) throw new Error("pdf load failed"); }
  function logoData(){ const L=(typeof window!=="undefined"&&window.RB_LOGO)?window.RB_LOGO:null; if(!L||!L.b64) return null; return { b64:L.b64, dataURI:"data:image/png;base64,"+L.b64, w:L.w||560, h:L.h||273 }; }
  function pdfSafe(s){ return String(s==null?"":s).replace(/\u2192/g,"to").replace(/\u2190/g,"<-").replace(/\u21b3/g,">").replace(/\u2713/g,"").replace(/\u2717|\u2715/g,"x").replace(/[\u2018\u2019]/g,"'").replace(/[\u201c\u201d]/g,'"').replace(/\u2026/g,"...").replace(/[\u2022\u25aa]/g,"-").replace(/&amp;/g,"&"); }
  function fileBase(){ return (S.borrower?S.borrower.replace(/[^\w]+/g,"_").replace(/^_|_$/g,"").slice(0,40):"Borrower")+"_Track_Record_"+new Date().toISOString().slice(0,10); }
  function downloadBlob(buf,fn,mime){ const blob=new Blob([buf],{type:mime}); const a=document.createElement("a"); a.href=URL.createObjectURL(blob); a.download=fn; document.body.appendChild(a); a.click(); setTimeout(()=>{ URL.revokeObjectURL(a.href); a.remove(); },1500); }
  function enc2(o){ return "YS"+btoa(unescape(encodeURIComponent(JSON.stringify(o)))); }
  function dec2(s){ try{ if(s&&s.slice(0,2)==="YS") return JSON.parse(decodeURIComponent(escape(atob(s.slice(2))))); }catch(e){} return null; }

  /* ===================== EXCEL EXPORT (xlsx-js-style) ===================== */
  async function exportXlsx(btn,opts){ opts=opts||{}; const o=btn?btn.textContent:null; if(btn){ btn.textContent="Preparing…"; btn.disabled=true; }
    try{
      await ensureXLSX(); const X=window.XLSX;
      const INK="0B1014",IVORY="F3EFE6",GOLD="9A7518",TEAL="4E777F",TEALD="1F3A40",LIGHT="EAF1F1",LINE="DCE1E2",DARK="1F2A30",FLIPBG="6E5417",HOLDBG="1F3A40";
      const flipCols=[
        {h:"Entity / LLC",get:p=>entityLabel(p),w:20},
        {h:"Property address",get:p=>addrLine(p),w:34,al:"left"},
        {h:"Property type",get:p=>p.propType,w:16},
        {h:"Purchase price",get:p=>num(p.purchasePrice)||"",money:true,sum:true,al:"right",w:14},
        {h:"Purchase date",get:p=>fmtDate(p.purchaseDate),al:"center",w:13},
        {h:"Rehab budget",get:p=>num(p.rehab)||"",money:true,sum:true,al:"right",w:13},
        {h:"Sale price",get:p=>num(p.salePrice)||"",money:true,sum:true,al:"right",w:14},
        {h:"Sale date",get:p=>fmtDate(p.saleDate),al:"center",w:13},
        {h:"Hold (mo)",get:p=>{const h=holdMonths(p);return h==null?"":h;},al:"center",w:10},
        {h:"Gross profit",get:p=>{return num(p.salePrice)?(num(p.salePrice)-num(p.purchasePrice)-num(p.rehab)):"";},money:true,al:"right",w:13},
        {h:"Recent (3yr)",get:p=>qualifies(p)?"Yes":(exitDate(p)?"No":""),al:"center",w:12}
      ];
      const holdCols=[
        {h:"Entity / LLC",get:p=>entityLabel(p),w:20},
        {h:"Property address",get:p=>addrLine(p),w:34,al:"left"},
        {h:"Property type",get:p=>p.propType,w:16},
        {h:"Purchase price",get:p=>num(p.purchasePrice)||"",money:true,sum:true,al:"right",w:14},
        {h:"Purchase date",get:p=>fmtDate(p.purchaseDate),al:"center",w:13},
        {h:"Rehab budget",get:p=>num(p.rehab)||"",money:true,sum:true,al:"right",w:13},
        {h:"Monthly rent",get:p=>num(p.rent)||"",money:true,sum:true,al:"right",w:13},
        {h:"Rented date",get:p=>fmtDate(p.rentDate),al:"center",w:13},
        {h:"Refi amount",get:p=>num(p.refiAmount)||"",money:true,al:"right",w:13},
        {h:"Refi date",get:p=>fmtDate(p.refiDate),al:"center",w:12},
        {h:"Current value",get:p=>num(p.currentValue)||"",money:true,al:"right",w:14},
        {h:"Recent (3yr)",get:p=>qualifies(p)?"Yes":(exitDate(p)?"No":""),al:"center",w:12}
      ];
      const N=Math.max(flipCols.length, holdCols.length);
      const aoa=[], merges=[], rowH={}, styleMap={}; const A=(r,c)=>X.utils.encode_cell({r:r,c:c});
      const setRow=r=>{ if(!aoa[r])aoa[r]=[]; };
      const put=(r,c,v,st)=>{ setRow(r); aoa[r][c]=(v==null?"":v); if(st) styleMap[A(r,c)]=st; };
      const span=(r,c1,c2,st)=>{ for(let c=c1;c<=c2;c++){ setRow(r); if(aoa[r][c]==null)aoa[r][c]=""; styleMap[A(r,c)]=st; } };
      const merge=(r,c1,c2)=>{ if(c2>c1) merges.push({s:{r:r,c:c1},e:{r:r,c:c2}}); };
      const stTitle={font:{name:"Georgia",sz:16,bold:true,color:{rgb:IVORY}},fill:{fgColor:{rgb:INK}},alignment:{horizontal:"left",vertical:"center"}};
      const stTag={font:{name:"Georgia",sz:10,italic:true,color:{rgb:GOLD}},fill:{fgColor:{rgb:INK}},alignment:{horizontal:"left",vertical:"center"}};
      const stBanner=bg=>({font:{name:"Arial",sz:11,bold:true,color:{rgb:IVORY}},fill:{fgColor:{rgb:bg}},alignment:{horizontal:"left",vertical:"center"}});
      const stTH=al=>({font:{name:"Arial",sz:9,bold:true,color:{rgb:IVORY}},fill:{fgColor:{rgb:DARK}},alignment:{horizontal:al,vertical:"center",wrapText:true}});
      const stCell=al=>({font:{name:"Arial",sz:9,color:{rgb:"222222"}},alignment:{horizontal:al,vertical:"center",wrapText:true},border:{bottom:{style:"hair",color:{rgb:LINE}}}});
      const stMoney={font:{name:"Arial",sz:9,color:{rgb:"222222"}},alignment:{horizontal:"right",vertical:"center"},numFmt:"$#,##0",border:{bottom:{style:"hair",color:{rgb:LINE}}}};
      const stTot=al=>({font:{name:"Arial",sz:10,bold:true,color:{rgb:TEALD}},alignment:{horizontal:al,vertical:"center"},fill:{fgColor:{rgb:LIGHT}},border:{top:{style:"medium",color:{rgb:TEAL}}}});
      const stTotM={font:{name:"Arial",sz:10,bold:true,color:{rgb:TEALD}},alignment:{horizontal:"right",vertical:"center"},numFmt:"$#,##0",fill:{fgColor:{rgb:LIGHT}},border:{top:{style:"medium",color:{rgb:TEAL}}}};
      let R=0;
      put(R,0,"YS CAPITAL GROUP — BORROWER TRACK RECORD",stTitle); span(R,0,N-1,stTitle); merge(R,0,N-1); rowH[R]={hpt:24}; R++;
      put(R,0,(S.borrower?("Borrower: "+S.borrower+"   ·   "):"")+"Generated "+new Date().toLocaleDateString("en-US",{year:"numeric",month:"long",day:"numeric"})+"   ·   NMLS ID 2609746",stTag); span(R,0,N-1,stTag); merge(R,0,N-1); rowH[R]={hpt:15}; R++;
      R++;
      function block(title,kind,cols,bg){
        // SECTION WIDTH PARITY (owner-directed 2026-07-13): both sections span
        // the SAME N columns with no dangling stub — when a section has fewer
        // real columns than N (flip = 11 vs hold = 12), its LAST column is
        // merged across the remaining cells so the Fix & Flip block ends flush
        // at the same right edge as Fix & Hold instead of one column short.
        const lastC=cols.length-1, pad=cols.length<N;
        put(R,0,title,stBanner(bg)); span(R,0,N-1,stBanner(bg)); merge(R,0,N-1); rowH[R]={hpt:20}; R++;
        for(let c=0;c<N;c++) put(R,c,c<cols.length?cols[c].h:"",stTH(c<cols.length?(cols[c].al||"left"):(cols[lastC].al||"left")));
        if(pad) merge(R,lastC,N-1);
        rowH[R]={hpt:26}; R++;
        const list=S.props.filter(p=>p.kind===kind); const totals={};
        list.forEach(p=>{ for(let c=0;c<N;c++){ const col=cols[c]; if(col){ const val=col.get(p); put(R,c,val==null?"":val, col.money?stMoney:stCell(col.al||"left")); if(col.sum) totals[c]=(totals[c]||0)+num(val); } else put(R,c,"",stCell(cols[lastC].al||"left")); }
          if(pad) merge(R,lastC,N-1);
          R++; });
        if(!list.length){ put(R,0,"No "+(kind==="flip"?"fix & flip":"fix & hold")+" deals entered.",stCell("left")); span(R,0,N-1,stCell("left")); merge(R,0,N-1); R++; }
        else { const firstSum=cols.findIndex(c=>c.sum); const mEnd=Math.max(0,firstSum-1);
          put(R,0,"TOTALS ("+list.length+")",stTot("left")); span(R,0,mEnd,stTot("left")); merge(R,0,mEnd);
          for(let c=mEnd+1;c<N;c++){ if(totals[c]!=null) put(R,c,totals[c],stTotM); else put(R,c,"",stTot("right")); }
          if(pad) merge(R,lastC,N-1);
          R++;
        }
        R++; // spacer
      }
      block("FIX & FLIP EXPERIENCE   (exit = sale)","flip",flipCols,FLIPBG);
      block("FIX & HOLD / RENTAL EXPERIENCE   (exit = lease-up / refinance)","hold",holdCols,HOLDBG);

      const ws=X.utils.aoa_to_sheet(aoa); ws["!merges"]=merges;
      const rowsArr=[]; Object.keys(rowH).forEach(k=>{ rowsArr[+k]=rowH[k]; }); ws["!rows"]=rowsArr;
      const colW=[]; for(let c=0;c<N;c++){ const f=flipCols[c],h=holdCols[c]; colW.push({wch:Math.max(f?f.w:10,h?h.w:10)||14}); } ws["!cols"]=colW;
      Object.keys(styleMap).forEach(addr=>{ if(!ws[addr]) ws[addr]={t:"s",v:""}; ws[addr].s=styleMap[addr]; });
      const wb=X.utils.book_new();
      X.utils.book_append_sheet(wb,ws,"Track Record");
      // hidden re-import sheet (chunked)
      const payload=enc2(snap()), CH=30000, nch=Math.max(1,Math.ceil(payload.length/CH));
      const hidAoa=[["YSTRACK1",nch]]; for(let i=0;i<nch;i++) hidAoa.push([payload.slice(i*CH,(i+1)*CH)]);
      X.utils.book_append_sheet(wb, X.utils.aoa_to_sheet(hidAoa), "_ys");
      wb.Workbook={Sheets:[{Hidden:0},{Hidden:2}]};
      const out=X.write(wb,{bookType:"xlsx",type:"array",cellStyles:true});
      const fn=fileBase()+".xlsx", mime="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
      if(opts.returnFile){ if(btn){btn.textContent=o;btn.disabled=false;} return new File([out],fn,{type:mime}); }
      downloadBlob(out,fn,mime); flash("Excel exported — one sheet with Flip & Hold sections. Re-import here anytime.");
    }catch(err){ if(opts.returnFile){ if(btn){btn.textContent=o;btn.disabled=false;} return null; } alert("Excel couldn't be generated here. On the published site it will download normally."); if(window.console)console.error(err); }
    finally{ if(btn){ btn.textContent=o; btn.disabled=false; } }
  }

  async function importXlsx(input){ const file=input.files&&input.files[0]; input.value=""; if(!file) return;
    try{ await ensureXLSX(); const X=window.XLSX; const buf=await file.arrayBuffer(); const wb=X.read(buf,{type:"array"});
      const sh=wb.Sheets["_ys"]; let stt=null;
      if(sh){ const cell=a=>{ const c=sh[a]; return c&&c.v!=null?String(c.v):""; };
        let n=parseInt(cell("B1"),10)||1, payload=""; for(let i=0;i<n;i++) payload+=cell("A"+(2+i));
        if(payload) stt=dec2(payload);
      }
      if(stt && Array.isArray(stt.props)){ S=blank(); S.borrower=stt.borrower||""; S.props=stt.props.map(p=>Object.assign(blankProp(p.kind),p)); render(); var _nb=document.getElementById("tr-borrower"); if(_nb) _nb.value=S.borrower; flash("Imported "+S.props.length+" propert"+(S.props.length===1?"y":"ies")+"."); return; }
      // fall back: parse the visible Flip/Hold sheets (a hand-filled template)
      const parsed=parseSheets(X,wb);
      if(parsed.length){ S=blank(); S.props=parsed; render(); flash("Imported "+parsed.length+" propert"+(parsed.length===1?"y":"ies")+" from the template."); return; }
      flash("Couldn't read that file — use an Excel exported by this tool, or the YS template.");
    }catch(e){ flash("Import failed — please use a file exported by this tool."); if(window.console)console.error(e); }
  }

  // Parse a hand-filled YS template (Fix & Flip / Fix & Hold sheets) by header names.
  function parseSheets(X,wb){
    const out=[]; const want={"property address":"address","entity / llc":"entity","llc / entity name":"entity","entity name":"entity","city":"city","state":"state","zip code":"zip","zipcode":"zip","zip":"zip","property type":"propType","type of deal":"propType","purchase price":"purchasePrice","purchase date":"purchaseDate","rehab budget":"rehab","renovation budget":"rehab","sale price":"salePrice","sale date":"saleDate","monthly rent":"rent","rented date":"rentDate","refi amount":"refiAmount","refi date":"refiDate","current value":"currentValue","seller":"seller","seller name":"seller","notes":"notes"};
    const isHeader=r=>r.some(c=>/property address|llc \/ entity|entity name/i.test(String(c||"")));
    const kindFromHeader=hdr=>{ const s=hdr.join("|"); if(/monthly rent|rented date|lease/.test(s)) return "hold"; if(/sale price|sale date/.test(s)) return "flip"; return null; };
    wb.SheetNames.forEach(name=>{ if(name==="_ys") return;
      const rows=X.utils.sheet_to_json(wb.Sheets[name],{header:1,blankrows:false}); if(!rows.length) return;
      const nameKind=/hold|rent/i.test(name)?"hold":"flip";
      let hdr=null, hdrKind=null;
      for(let i=0;i<rows.length;i++){ const r=rows[i]; if(!r||!r.length) continue;
        if(isHeader(r)){ hdr=r.map(c=>String(c||"").trim().toLowerCase()); hdrKind=kindFromHeader(hdr)||nameKind; continue; }
        if(!hdr) continue;
        const c0=String(r[0]||"");
        if(/^totals/i.test(c0) || /^fix\s*&/i.test(c0) || /borrower track record/i.test(c0)) continue; // totals / section banners / title
        const p=blankProp(hdrKind); let any=false;
        hdr.forEach((h,c)=>{ const key=want[h]; if(key && r[c]!=null && String(r[c]).trim()!==""){ let v=r[c];
          if(/date/i.test(key)){ const d=(v instanceof Date)?v:parseDate(v); if(d) v=d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0"); }
          if(/price|rehab|rent|refiamount|currentvalue/i.test(key)) v=String(num(v)||"");
          p[key]=String(v); any=true; } });
        // "Personal name" in the Entity column round-trips to the personal flag.
        if(/^personal(\s+name)?$/i.test(String(p.entity||"").trim())){ p.ownedPersonally=true; p.entity=""; }
        if(any && String(p.address).trim() && (num(p.purchasePrice)>0 || num(p.salePrice)>0 || num(p.rent)>0)) out.push(p);
      }
    });
    return out;
  }

  /* ===================== PDF EXPORT (jsPDF) ===================== */
  async function exportPdf(btn,opts){ opts=opts||{}; const o=btn?btn.textContent:null; if(btn){ btn.textContent="Preparing…"; btn.disabled=true; }
    try{
      await ensurePDF(); const { jsPDF }=window.jspdf;
      const doc=new jsPDF({unit:"pt",format:"letter",orientation:"landscape"});
      const W=doc.internal.pageSize.getWidth(), H=doc.internal.pageSize.getHeight(), M=40;
      const INK=[11,16,20],TEAL=[78,119,127],TEALD=[31,58,64],GOLD=[150,123,68],GRAY=[91,103,112],IV=[243,239,230];
      const s=summary();
      function header(){
        doc.setFillColor(INK[0],INK[1],INK[2]); doc.rect(0,0,W,74,"F");
        doc.setFillColor(GOLD[0],GOLD[1],GOLD[2]); doc.rect(0,74,W,2,"F");
        const logo=logoData(); if(logo){ const h=34,w=logo.w*(h/logo.h); try{ doc.addImage(logo.dataURI,"PNG",M,21,w,h); }catch(e){} }
        doc.setTextColor(IV[0],IV[1],IV[2]); doc.setFont("times","bold"); doc.setFontSize(19); doc.text("Borrower Track Record", W-M, 35, {align:"right"});
        doc.setFont("times","italic"); doc.setFontSize(10); doc.setTextColor(GOLD[0],GOLD[1],GOLD[2]); doc.text("Verified real-estate experience", W-M, 52, {align:"right"});
        doc.setFont("helvetica","normal"); doc.setFontSize(8); doc.setTextColor(170,178,182);
        doc.text((S.borrower?(pdfSafe(S.borrower)+"  ·  "):"")+"YS Capital Group · NMLS 2609746 · "+new Date().toLocaleDateString("en-US",{year:"numeric",month:"long",day:"numeric"}), W-M, 66, {align:"right"});
      }
      header();
      let y=96;
      // experience ranking band
      doc.setFillColor(247,250,250); doc.setDrawColor(TEAL[0],TEAL[1],TEAL[2]); doc.setLineWidth(1); doc.roundedRect(M,y,W-2*M,46,6,6,"FD");
      doc.setFont("helvetica","bold"); doc.setFontSize(13); doc.setTextColor(TEALD[0],TEALD[1],TEALD[2]); doc.text("Experience ranking:  "+s.tier, M+14, y+20);
      doc.setFont("helvetica","normal"); doc.setFontSize(9.5); doc.setTextColor(40,44,48);
      doc.text(s.qual+" qualifying exit(s) in the last 3 years   ·   "+s.total+" total deals   ·   "+s.flips+" flips / "+s.holds+" holds   ·   "+money(s.vol)+" acquisition volume   ·   "+money(s.rehab)+" rehab", M+14, y+36);
      y+=62;

      const PROJ={flip:"Fix & Flip",hold:"Fix & Hold"};
      // SECTION WIDTH PARITY (owner-directed 2026-07-13): both section tables
      // share ONE fixed column layout (widths sum to the printable width), so
      // the Fix & Flip and Fix & Hold sections are exactly the same width with
      // their columns aligned — autoTable no longer sizes each independently.
      const COLW=[18,88,150,72,62,56,58,62,58,48,40];   // = W-2*M = 712pt
      const sharedCols={}; COLW.forEach((w,i)=>{ sharedCols[i]={cellWidth:w}; }); sharedCols[0].halign="center";
      function section(kind,title){
        const list=S.props.filter(p=>p.kind===kind);
        doc.setFont("helvetica","bold"); doc.setFontSize(11); doc.setTextColor(INK[0],INK[1],INK[2]); doc.text(pdfSafe(title)+" ("+list.length+")", M, y); y+=6;
        const head = kind==="flip"
          ? [["#","Entity","Property","Type","Purchase","Pur. date","Rehab","Sale","Sale date","Hold","Recent"]]
          : [["#","Entity","Property","Type","Purchase","Pur. date","Rehab","Rent/mo","Rented","Refi","Recent"]];
        const body=list.map((p,i)=>{ const hm=holdMonths(p);
          const common=[String(i+1),pdfSafe(entityLabel(p)||"—"),pdfSafe(addrLine(p)),pdfSafe(p.propType||"—"),num(p.purchasePrice)?money(p.purchasePrice):"—",fmtDate(p.purchaseDate)||"—",num(p.rehab)?money(p.rehab):"—"];
          const tail=[qualifies(p)?"Yes":(exitDate(p)?"No":"—")];
          if(kind==="flip") return common.concat([num(p.salePrice)?money(p.salePrice):"—",fmtDate(p.saleDate)||"—",(hm!=null&&hm>=0)?(hm+"mo"):"—"]).concat(tail);
          return common.concat([num(p.rent)?money(p.rent):"—",fmtDate(p.rentDate)||"—",num(p.refiAmount)?money(p.refiAmount):"—"]).concat(tail);
        });
        if(!list.length) body.push(["—","No "+title.toLowerCase()+" deals entered.","","","","","","","","",""]);
        doc.autoTable({ startY:y+4, head:head, body:body, theme:"grid", margin:{left:M,right:M}, tableWidth:W-2*M,
          styles:{font:"helvetica",fontSize:7.5,cellPadding:3,overflow:"linebreak",textColor:[34,38,42],lineColor:[224,228,228],lineWidth:.5},
          headStyles:{fillColor:[31,42,48],textColor:[243,239,230],fontStyle:"bold",fontSize:7.5},
          alternateRowStyles:{fillColor:[248,250,250]},
          columnStyles:sharedCols,
          didDrawPage:()=>{ header(); } });
        y=doc.lastAutoTable.finalY+18;
      }
      section("flip","Fix & Flip experience");
      if(y>H-120){ doc.addPage(); y=96; }
      section("hold","Fix & Hold / Rental experience");

      // footer compliance on last page
      doc.setFont("helvetica","normal"); doc.setFontSize(7); doc.setTextColor(120,128,134);
      doc.text("For lender review. Borrower-reported experience; verification status reflects YS Capital Group's review. Not a commitment to lend.", M, H-22);
      doc.text("© "+new Date().getFullYear()+" YS Capital Group · NMLS ID 2609746 · Equal Housing Lender", M, H-12);

      const fn=fileBase()+".pdf";
      if(opts.returnFile){ if(btn){btn.textContent=o;btn.disabled=false;} return doc.output("blob"); }
      doc.save(fn); flash("Branded PDF exported.");
    }catch(err){ if(opts.returnFile){ if(btn){btn.textContent=o;btn.disabled=false;} return null; } alert("PDF couldn't be generated here. On the published site it will download normally."); if(window.console)console.error(err); }
    finally{ if(btn){ btn.textContent=o; btn.disabled=false; } }
  }

  /* ===================== SHARE ===================== */
  function share(btn){ save(); const url=location.href.split("#")[0]+"#d="+enc(snap());
    if(navigator.clipboard&&navigator.clipboard.writeText){ navigator.clipboard.writeText(url).then(()=>flash("Link copied — it reopens this track record."),()=>prompt("Copy this link:",url)); }
    else prompt("Copy this link:",url);
  }
  function blobToB64(blob){ return new Promise((res,rej)=>{ const r=new FileReader(); r.onload=()=>{ const s=String(r.result); res(s.slice(s.indexOf(",")+1)); }; r.onerror=rej; r.readAsDataURL(blob); }); }
  // #99: send the borrower's track record straight to the branded officer
  // SERVER-SIDE (a real branded email with the PDF + Excel attached) — no .eml the
  // visitor has to open. Uses the exports' existing returnFile blob path.
  async function emailToOfficer(btn){
    save();
    const ob=window.YSBRAND||{};
    const code=ob.email?String(ob.email).split("@")[0].toLowerCase().replace(/[^a-z0-9._-]/g,""):"";
    const vemail=(prompt("Your email address (so your YS Capital officer can follow up):")||"").trim();
    if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(vemail)){ flash("Enter a valid email to send your track record."); return; }
    const o=btn?btn.textContent:null; if(btn){ btn.textContent="Sending…"; btn.disabled=true; }
    try{
      const files=[];
      try{ const pdf=await exportPdf(null,{returnFile:true}); if(pdf) files.push({filename:fileBase()+".pdf",contentType:"application/pdf",dataBase64:await blobToB64(pdf)}); }catch(e){}
      try{ const xls=await exportXlsx(null,{returnFile:true}); if(xls) files.push({filename:fileBase()+".xlsx",contentType:(xls&&xls.type)||"application/octet-stream",dataBase64:await blobToB64(xls)}); }catch(e){}
      const r=await fetch("/api/leads",{method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({tool:"track_record",officerCode:code||undefined,name:S.borrower||undefined,email:vemail,
          subject:"Track record — "+(S.borrower||"borrower"),
          message:"A borrower shared their real-estate track record from the Track Record tool. The "+(files.length>1?"PDF & Excel are":"PDF is")+" attached. Please review and follow up.",
          attachments:files, payload:{borrower:S.borrower||"", properties:(S.props||[]).length}}) });
      if(!r.ok) throw new Error("send "+r.status);
      flash("Sent — your YS Capital officer has your track record and will follow up.");
      if(btn){ btn.textContent="Sent ✓"; setTimeout(()=>{ btn.textContent=o; btn.disabled=false; },3200); }
    }catch(e){ if(window.console)console.error(e); flash("Couldn't send — please try again, or use Export and email it yourself."); if(btn){ btn.textContent=o; btn.disabled=false; } }
  }

  /* ===================== BOOT ===================== */
  function boot(){ restore(); render();
    // seed one borrower-name capture in the hero if present
    const nb=$("#tr-borrower"); if(nb){ nb.value=S.borrower; nb.addEventListener("input",()=>{ S.borrower=nb.value; save(); }); }
  }
  if(document.readyState==="loading") document.addEventListener("DOMContentLoaded",boot); else boot();

  /* Portal bridge accessor: replace the working set with server-loaded rows
     (record ids are the server uuids) and re-render. */
  function setState(o){
    S=blank();
    S.borrower=(o&&o.borrower)||"";
    S.props=((o&&o.props)||[]).map(p=>Object.assign(blankProp(p.kind),p));
    const nb=$("#tr-borrower"); if(nb) nb.value=S.borrower;
    render();
  }

  /* Portal bridge accessor: a freshly-added line starts with a client temp id
     ("p<random>"); the bridge creates it on the server and gets a real id back.
     Adopt that server id in place of the temp one across the working set, the
     add/edit overlay still open in front of the user, and any rendered card —
     so every later keystroke UPDATES this same row instead of inserting a new
     record each time (the autosave duplicate-record bug). */
  function adoptServerId(tempId, serverId){
    if(tempId==null||serverId==null||tempId===serverId) return;
    S.props.forEach(p=>{ if(p&&p.id===tempId) p.id=serverId; });
    if(editingId===tempId) editingId=serverId;
    const ov=$("#tr-ov");
    if(ov&&ov._work&&ov._work.id===tempId) ov._work.id=serverId;
    try{ document.querySelectorAll('[data-card="'+tempId+'"]').forEach(el=>el.setAttribute("data-card",serverId)); }catch(e){}
  }

  return { share, exportXlsx, importXlsx, exportPdf, emailToOfficer, _state:()=>S, setState, adoptServerId, snap:()=>snap() };
})();
if(typeof window!=="undefined") window.TR=TR;
