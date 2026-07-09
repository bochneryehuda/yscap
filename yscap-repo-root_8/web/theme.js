/* YS Capital — site-wide light/dark theme toggle.
   Loaded early in <head> so the saved theme is applied before paint (no flash).
   Injects a toggle button into the page header (or floats it if no header found). */
(function(){
  "use strict";
  var KEY="ys-theme";
  function get(){
    try{ var s=localStorage.getItem(KEY); if(s==="light"||s==="dark") return s; }catch(e){}
    // White-first is the standard (matches the portal). We intentionally do NOT
    // auto-follow the OS to dark anymore — a dark-mode device was rendering the
    // OLD dark marketing/tools theme, which looked un-redesigned. Dark stays
    // available on demand via the manual toggle (saved per browser).
    return "light";
  }
  function save(t){ try{ localStorage.setItem(KEY,t); }catch(e){} }
  function apply(t){ document.documentElement.setAttribute("data-theme", t); }
  // In light theme, swap the teal-on-dark logo for the dark-teal logo that reads on light paper.
  function swapLogos(t){
    var dark=(t==="light"); var imgs=document.getElementsByTagName("img");
    for(var i=0;i<imgs.length;i++){ var s=imgs[i].getAttribute("src")||"";
      if(/ys-logo-t(-dark)?\.png/.test(s)) imgs[i].setAttribute("src", s.replace(/ys-logo-t(-dark)?\.png/, dark?"ys-logo-t-dark.png":"ys-logo-t.png")); }
  }
  apply(get()); // run immediately (before stylesheets render)

  var SUN='<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4.2"/><path d="M12 1.8v2.2M12 20v2.2M4 12H1.8M22.2 12H20M5.7 5.7 4.1 4.1M19.9 19.9l-1.6-1.6M18.3 5.7l1.6-1.6M4.1 19.9l1.6-1.6"/></svg>';
  var MOON='<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20.5 13.2A8.4 8.4 0 1 1 10.8 3.5a6.6 6.6 0 0 0 9.7 9.7Z"/></svg>';

  function build(){
    if(document.querySelector(".ys-theme-toggle")) return;
    var btn=document.createElement("button");
    btn.className="ys-theme-toggle"; btn.type="button";
    btn.setAttribute("aria-label","Switch between light and dark theme");
    function paint(){ var t=get(); /* show the theme you'd switch TO */ btn.innerHTML=(t==="light"?MOON:SUN)+'<span class="ys-theme-lbl">'+(t==="light"?"Dark":"Light")+'</span>'; btn.title=(t==="light"?"Switch to dark":"Switch to light"); }
    paint();
    btn.addEventListener("click",function(){ var t=get()==="light"?"dark":"light"; save(t); apply(t); swapLogos(t); paint(); });
    var host=document.querySelector(".topbar-actions")||document.querySelector(".nav-actions");
    if(host){ host.insertBefore(btn, host.firstChild); }
    else { btn.classList.add("ys-theme-floating"); document.body.appendChild(btn); }
    swapLogos(get());
  }
  if(document.readyState==="loading") document.addEventListener("DOMContentLoaded", build); else build();
})();
