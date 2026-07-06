/* YS Capital — site-wide floating actions (Apply + Contact popup) and Apply chooser.
   Drop-in: add <script src="float-actions.js"></script> (or ../float-actions.js under /tools/).
   Fully self-contained and idempotent — injects only what a page is missing, so it is safe
   to include alongside pages that already have the chooser (e.g. the Investor Suite). */
(function () {
  var PORTAL = "https://yscapgroup.mymortgage-online.com/loan-app/?siteId=5722777381&lar=admin&workFlowId=241919";
  var WA = "https://wa.me/message/SR7AK2L5DOCNJ1";
  var TEL = "+17188312168", TELD = "718-831-2168";
  var EMAIL = "sales@yscapgroup.com";
  var IN_TOOLS = /\/tools\//.test(location.pathname);
  var BASE = IN_TOOLS ? "" : "tools/";           // path prefix to reach /tools/*.html

  function ready(fn) {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", fn);
    else fn();
  }

  // ---- 1. CSS (inject once) --------------------------------------------------
  function injectCSS() {
    if (document.getElementById("ys-fa-css")) return;
    var css = document.createElement("style");
    css.id = "ys-fa-css";
    css.textContent = [
      /* floating actions */
      ".float-actions{position:fixed;right:1.2rem;bottom:1.2rem;z-index:90;transform:translateY(140px);opacity:0;pointer-events:none;transition:transform .5s var(--ease,cubic-bezier(.2,.8,.25,1)),opacity .4s;}",
      ".float-actions.show{transform:translateY(0);opacity:1;pointer-events:auto;}",
      ".float-btns{display:flex;align-items:center;gap:.6rem;}",
      ".float-apply{background:var(--teal);color:var(--on-accent,#062018);font-weight:700;font-size:.92rem;padding:.85rem 1.5rem;border-radius:100px;text-decoration:none;box-shadow:0 12px 34px -10px rgba(0,0,0,.7);transition:background .3s,transform .2s,box-shadow .3s;}",
      ".float-apply:hover{background:var(--teal-br);transform:translateY(-2px);}",
      ".float-contact{display:inline-flex;align-items:center;gap:.5rem;cursor:pointer;background:var(--ink-2);color:var(--ivory);border:1px solid var(--line);font-family:var(--font-b,inherit);font-weight:700;font-size:.92rem;padding:.8rem 1.25rem;border-radius:100px;box-shadow:0 12px 34px -10px rgba(0,0,0,.55);transition:border-color .3s,color .3s,transform .2s,background .3s;}",
      ".float-contact:hover{border-color:var(--teal);color:var(--teal-br);transform:translateY(-2px);}",
      ".float-contact .fc-ico{display:inline-flex;}.float-contact .fc-ico svg{width:18px;height:18px;}",
      ".contact-pop{position:absolute;right:0;bottom:100%;margin-bottom:.8rem;width:274px;background:linear-gradient(180deg,var(--ink-2),var(--ink-1));border:1px solid var(--line);border-radius:16px;padding:.65rem;box-shadow:0 30px 64px -22px rgba(0,0,0,.75);transform:translateY(10px) scale(.96);transform-origin:bottom right;opacity:0;pointer-events:none;transition:transform .24s var(--ease,cubic-bezier(.2,.8,.25,1)),opacity .24s;}",
      ".contact-pop.open{transform:translateY(0) scale(1);opacity:1;pointer-events:auto;}",
      ".cpop-head{display:flex;align-items:center;justify-content:space-between;padding:.35rem .55rem .55rem;}",
      ".cpop-head span{font-weight:700;font-size:.72rem;letter-spacing:.14em;text-transform:uppercase;color:var(--muted);}",
      ".cpop-x{background:none;border:0;color:var(--muted);font-size:1.35rem;line-height:1;cursor:pointer;padding:0 .15rem;transition:color .2s;}.cpop-x:hover{color:var(--ivory);}",
      ".cpop-item{display:flex;align-items:center;gap:.7rem;padding:.6rem;border-radius:11px;text-decoration:none;transition:background .2s;}",
      ".cpop-item:hover{background:rgba(127,169,176,.09);}",
      ".cpop-ico{flex:none;width:40px;height:40px;border-radius:11px;display:grid;place-items:center;background:rgba(127,169,176,.1);border:1px solid var(--line);color:var(--teal-br);}.cpop-ico svg{width:21px;height:21px;}",
      ".cpop-item.is-wa .cpop-ico{background:rgba(37,211,102,.13);border-color:rgba(37,211,102,.4);color:#25D366;}",
      ".cpop-body{display:flex;flex-direction:column;line-height:1.3;}",
      ".cpop-t{color:var(--ivory);font-weight:700;font-size:.95rem;}.cpop-s{color:var(--muted);font-size:.8rem;}",
      ":root[data-theme=\"light\"] .float-contact{box-shadow:0 12px 30px -14px rgba(22,32,29,.4);}",
      ":root[data-theme=\"light\"] .contact-pop{box-shadow:0 30px 60px -24px rgba(22,32,29,.45);}",
      ":root[data-theme=\"light\"] .cpop-item:hover{background:rgba(36,90,100,.07);}",
      "@media (max-width:560px){.float-actions{right:1rem;bottom:1rem;}.contact-pop{width:min(274px,calc(100vw - 2rem));}}",
      /* apply chooser (only used if the page doesn't already have one) */
      ".apply-modal{position:fixed;inset:0;z-index:120;display:none;}.apply-modal.open{display:block;}",
      ".apply-overlay{position:absolute;inset:0;background:rgba(8,11,14,.62);backdrop-filter:blur(7px);-webkit-backdrop-filter:blur(7px);opacity:0;transition:opacity .28s ease;}.apply-modal.open .apply-overlay{opacity:1;}",
      ".apply-dialog{position:absolute;left:50%;top:50%;transform:translate(-50%,-46%);width:min(620px,calc(100vw - 36px));max-height:calc(100vh - 48px);overflow:auto;background:linear-gradient(180deg,var(--ink-2,#141a1f),var(--ink-1,#0f1418));border:1px solid var(--line,#2a3138);border-radius:22px;padding:2.1rem 2.1rem 1.6rem;box-shadow:0 40px 120px rgba(0,0,0,.45);opacity:0;transition:transform .3s cubic-bezier(.2,.8,.25,1),opacity .3s ease;}.apply-modal.open .apply-dialog{transform:translate(-50%,-50%);opacity:1;}",
      ".apply-x{position:absolute;top:14px;right:16px;width:36px;height:36px;border-radius:50%;border:1px solid var(--line,#2a3138);background:transparent;color:var(--muted,#9aa6ac);font-size:1.4rem;line-height:1;cursor:pointer;transition:.2s;}.apply-x:hover{color:var(--ivory-soft,#f3efe6);border-color:var(--teal-dp,#3c5a5f);transform:rotate(90deg);}",
      ".apply-kicker{font-family:var(--font-b);font-size:.72rem;text-transform:uppercase;letter-spacing:.16em;color:var(--teal-br,#7fa9b0);margin-bottom:.5rem;}",
      ".apply-head h2{font-family:var(--font-d);font-weight:600;font-size:1.62rem;line-height:1.15;color:var(--ivory-soft,#f3efe6);margin:0 0 .45rem;}",
      ".apply-head p{color:var(--muted,#9aa6ac);font-size:.95rem;margin:0 0 1.3rem;}",
      ".apply-options{display:flex;flex-direction:column;gap:.85rem;}",
      ".apply-card{display:flex;align-items:center;gap:1rem;padding:1.05rem 1.1rem;border:1px solid var(--line,#2a3138);border-radius:15px;background:rgba(127,169,176,.035);text-decoration:none;transition:.22s;}.apply-card:hover{border-color:var(--teal-br,#7fa9b0);background:rgba(127,169,176,.09);transform:translateY(-2px);box-shadow:0 16px 40px rgba(0,0,0,.3);}",
      ".apply-ico{flex:none;width:46px;height:46px;border-radius:12px;display:grid;place-items:center;background:rgba(127,169,176,.12);border:1px solid var(--teal-dp,#3c5a5f);}.apply-ico svg{width:23px;height:23px;fill:none;stroke:var(--teal-br,#7fa9b0);stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round;}",
      ".apply-card-body{flex:1;min-width:0;}.apply-card-title{display:block;font-family:var(--font-d);font-weight:600;font-size:1.12rem;color:var(--ivory-soft,#f3efe6);margin-bottom:.18rem;}.apply-card-desc{display:block;font-size:.85rem;line-height:1.45;color:var(--muted-2,#7d878d);}",
      ".apply-go{flex:none;font-size:1.3rem;color:var(--teal-br,#7fa9b0);transition:transform .2s;}.apply-card:hover .apply-go{transform:translateX(4px);}",
      ".apply-foot{margin-top:1.3rem;padding-top:1.05rem;border-top:1px solid var(--line-2,#222a30);text-align:center;font-size:.88rem;color:var(--muted-2,#7d878d);}.apply-foot a{color:var(--teal-br,#7fa9b0);text-decoration:none;font-weight:600;}.apply-foot a:hover{text-decoration:underline;}",
      "@media (max-width:520px){.apply-dialog{padding:1.6rem 1.3rem 1.3rem;}.apply-head h2{font-size:1.4rem;}.apply-card-desc{font-size:.82rem;}}"
    ].join("\n");
    document.head.appendChild(css);
  }

  // ---- 2. Apply chooser (inject only if the page doesn't already have one) ----
  function injectChooser() {
    if (document.getElementById("applyModal")) return; // page already provides it
    var wrap = document.createElement("div");
    wrap.className = "apply-modal";
    wrap.id = "applyModal";
    wrap.setAttribute("aria-hidden", "true");
    wrap.innerHTML =
      '<div class="apply-overlay" data-apply-close></div>' +
      '<div class="apply-dialog" role="dialog" aria-modal="true" aria-labelledby="applyTitle">' +
        '<button class="apply-x" type="button" data-apply-close aria-label="Close">&times;</button>' +
        '<div class="apply-head"><div class="apply-kicker">Let\'s get you funded</div>' +
          '<h2 id="applyTitle">Which loan are you here for?</h2>' +
          '<p>Pick your path and we\'ll take you straight to the right place.</p></div>' +
        '<div class="apply-options">' +
          '<a class="apply-card" href="' + PORTAL + '" target="_blank" rel="noopener">' +
            '<span class="apply-ico"><svg viewBox="0 0 24 24"><path d="M3 11l9-7 9 7M5 10v10h14V10M9 20v-6h6v6"/><path d="M12 7.5v3M10.5 9h3"/></svg></span>' +
            '<span class="apply-card-body"><span class="apply-card-title">DSCR rental loan</span>' +
            '<span class="apply-card-desc">Long-term, 30-year financing for rental properties — qualified on the property\'s cash flow, not your tax returns. Continue to our secure application portal.</span></span>' +
            '<span class="apply-go" aria-hidden="true">→</span></a>' +
          '<a class="apply-card" href="' + BASE + 'loan-application.html">' +
            '<span class="apply-ico"><svg viewBox="0 0 24 24"><path d="M14 7l3 3M3 21l4-1 11-11a2.1 2.1 0 0 0-3-3L4 17l-1 4z"/><path d="M14.5 5.5l4 4"/></svg></span>' +
            '<span class="apply-card-body"><span class="apply-card-title">Fix &amp; Flip / Fix &amp; Hold</span>' +
            '<span class="apply-card-desc">Short-term bridge financing for flips, BRRRR and ground-up. A fast, guided application with a live loan estimate as you fill it out.</span></span>' +
            '<span class="apply-go" aria-hidden="true">→</span></a>' +
        '</div>' +
        '<div class="apply-foot">Not ready to apply? <a href="' + BASE + 'term-sheet.html" data-apply-close>Build an instant term sheet →</a></div>' +
      '</div>';
    document.body.appendChild(wrap);

    if (!window.YSApply) {
      window.YSApply = (function () {
        var m, lastFocus;
        function modal() { return m || (m = document.getElementById("applyModal")); }
        function open(e) { if (e) { e.preventDefault(); } var d = modal(); if (!d) return false; lastFocus = document.activeElement; d.classList.add("open"); d.setAttribute("aria-hidden", "false"); document.body.style.overflow = "hidden"; var x = d.querySelector(".apply-x"); if (x) x.focus(); return false; }
        function close() { var d = modal(); if (!d) return; d.classList.remove("open"); d.setAttribute("aria-hidden", "true"); document.body.style.overflow = ""; if (lastFocus && lastFocus.focus) lastFocus.focus(); }
        document.addEventListener("click", function (ev) { var t = ev.target.closest && ev.target.closest("[data-apply-close]"); if (t) close(); });
        document.addEventListener("keydown", function (ev) { if (ev.key === "Escape") close(); });
        return { open: open, close: close };
      })();
    }
  }

  // ---- 3. Floating actions (inject only if missing, e.g. not the home page) --
  function injectFloat() {
    if (document.getElementById("floatActions")) return; // home page already has it
    var fa = document.createElement("div");
    fa.className = "float-actions";
    fa.id = "floatActions";
    fa.innerHTML =
      '<div class="contact-pop" id="contactPop" role="dialog" aria-label="Contact YS Capital" aria-hidden="true">' +
        '<div class="cpop-head"><span>Contact us</span>' +
          '<button class="cpop-x" id="contactPopClose" type="button" aria-label="Close contact menu">&times;</button></div>' +
        '<a class="cpop-item is-wa" href="' + WA + '" target="_blank" rel="noopener">' +
          '<span class="cpop-ico"><svg viewBox="0 0 32 32" aria-hidden="true"><path d="M16.04 3.2c-7.1 0-12.87 5.76-12.87 12.86 0 2.27.6 4.49 1.73 6.44L3.1 28.8l6.47-1.7a12.83 12.83 0 0 0 6.47 1.74h.01c7.1 0 12.87-5.77 12.87-12.87 0-3.44-1.34-6.67-3.77-9.1a12.78 12.78 0 0 0-9.1-3.77zm0 23.44h-.01a10.66 10.66 0 0 1-5.43-1.49l-.39-.23-4.04 1.06 1.08-3.94-.25-.4a10.63 10.63 0 0 1-1.63-5.68c0-5.9 4.8-10.7 10.71-10.7 2.86 0 5.55 1.12 7.57 3.14a10.63 10.63 0 0 1 3.13 7.57c0 5.9-4.8 10.7-10.7 10.7zm5.87-8.02c-.32-.16-1.9-.94-2.2-1.05-.29-.11-.5-.16-.72.16-.21.32-.82 1.05-1.01 1.26-.19.22-.37.24-.69.08-.32-.16-1.36-.5-2.59-1.6-.96-.85-1.6-1.91-1.79-2.23-.19-.32-.02-.5.14-.66.14-.14.32-.37.48-.56.16-.19.21-.32.32-.53.11-.22.05-.4-.03-.56-.08-.16-.72-1.74-.99-2.38-.26-.62-.52-.54-.72-.55l-.61-.01c-.21 0-.56.08-.85.4-.29.32-1.11 1.09-1.11 2.66 0 1.57 1.14 3.08 1.3 3.3.16.21 2.25 3.43 5.44 4.81.76.33 1.35.52 1.81.67.76.24 1.46.21 2 .13.61-.09 1.9-.78 2.17-1.53.27-.75.27-1.39.19-1.53-.08-.13-.29-.21-.61-.37z" fill="currentColor"/></svg></span>' +
          '<span class="cpop-body"><span class="cpop-t">WhatsApp</span><span class="cpop-s">Chat with us now</span></span></a>' +
        '<a class="cpop-item" href="tel:' + TEL + '">' +
          '<span class="cpop-ico"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.6 10.8a15.5 15.5 0 0 0 6.6 6.6l2.2-2.2a1 1 0 0 1 1-.24 11.4 11.4 0 0 0 3.6.58 1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1c0 1.25.2 2.46.58 3.6a1 1 0 0 1-.25 1l-2.2 2.2z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg></span>' +
          '<span class="cpop-body"><span class="cpop-t">Call us</span><span class="cpop-s">' + TELD + '</span></span></a>' +
        '<a class="cpop-item" href="mailto:' + EMAIL + '">' +
          '<span class="cpop-ico"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2.2" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M4 7l8 6 8-6" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg></span>' +
          '<span class="cpop-body"><span class="cpop-t">Email</span><span class="cpop-s">' + EMAIL + '</span></span></a>' +
      '</div>' +
      '<div class="float-btns">' +
        '<button class="float-contact" id="floatContact" type="button" aria-label="Contact us" aria-expanded="false" aria-controls="contactPop">' +
          '<span class="fc-ico"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg></span>' +
          '<span class="fc-lbl">Contact</span></button>' +
        '<a class="float-apply" id="floatApplyBtn" href="' + PORTAL + '" target="_blank" rel="noopener">Apply</a>' +
      '</div>';
    document.body.appendChild(fa);

    // Apply button opens the chooser
    var ab = fa.querySelector("#floatApplyBtn");
    if (ab) ab.addEventListener("click", function (e) { if (window.YSApply) return window.YSApply.open(e); });

    // Scroll reveal
    var onScroll = function () { fa.classList.toggle("show", window.scrollY > 500); };
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();

    // Contact popup
    var cbtn = fa.querySelector("#floatContact"), pop = fa.querySelector("#contactPop");
    if (cbtn && pop) {
      var openPop = function () { pop.classList.add("open"); pop.setAttribute("aria-hidden", "false"); cbtn.setAttribute("aria-expanded", "true"); };
      var closePop = function () { pop.classList.remove("open"); pop.setAttribute("aria-hidden", "true"); cbtn.setAttribute("aria-expanded", "false"); };
      cbtn.addEventListener("click", function (e) { e.preventDefault(); e.stopPropagation(); pop.classList.contains("open") ? closePop() : openPop(); });
      var xb = fa.querySelector("#contactPopClose"); if (xb) xb.addEventListener("click", function (e) { e.preventDefault(); closePop(); });
      pop.addEventListener("click", function (e) { if (e.target.closest(".cpop-item")) closePop(); });
      document.addEventListener("click", function (e) { if (pop.classList.contains("open") && !pop.contains(e.target) && !cbtn.contains(e.target)) closePop(); });
      document.addEventListener("keydown", function (e) { if (e.key === "Escape") closePop(); });
    }
  }

  ready(function () { injectCSS(); injectChooser(); injectFloat(); });
})();
