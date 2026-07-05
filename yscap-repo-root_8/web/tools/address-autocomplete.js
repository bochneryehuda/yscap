/* =====================================================================
   YS CAPITAL — address autocomplete (vanilla, dependency-free).
   Attaches a typeahead to any text input; suggestions come from our own
   /api/address/suggest (key stays server-side). On select it fills the caller's
   fields. Degrades silently to plain manual entry if the API is unavailable.

     YSAddr.attach(document.getElementById('pStreet'), function (addr) {
       // addr = { line1, city, state, zip, country }
     });
   ===================================================================== */
(function () {
  "use strict";
  if (window.YSAddr) return;

  var STYLE_ID = "ysaddr-style";
  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var s = document.createElement("style");
    s.id = STYLE_ID;
    s.textContent =
      ".ysaddr-menu{position:absolute;z-index:9999;left:0;right:0;margin-top:4px;background:#1B242D;" +
      "border:1px solid #2A3742;border-radius:10px;box-shadow:0 18px 50px -12px rgba(0,0,0,.6);overflow:hidden;" +
      "font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-height:280px;overflow-y:auto}" +
      ".ysaddr-item{padding:10px 13px;font-size:13.5px;color:#F4F0E7;cursor:pointer;line-height:1.35;" +
      "border-bottom:1px solid #232F3A;display:flex;gap:9px;align-items:flex-start}" +
      ".ysaddr-item:last-child{border-bottom:0}" +
      ".ysaddr-item .pin{color:#7FA9B0;flex:0 0 auto;margin-top:1px}" +
      ".ysaddr-item.active,.ysaddr-item:hover{background:#232F3A}" +
      ".ysaddr-foot{padding:7px 13px;font-size:10.5px;color:#74848C;text-align:right;letter-spacing:.03em}" +
      "@media (prefers-color-scheme:light){.ysaddr-menu{background:#fff;border-color:#E4DDCE}" +
      ".ysaddr-item{color:#1B242D;border-bottom-color:#F1ECE1}.ysaddr-item.active,.ysaddr-item:hover{background:#F6F2E9}" +
      ".ysaddr-foot{color:#8A979C}}";
    document.head.appendChild(s);
  }

  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]; }); }

  function attach(input, onSelect) {
    if (!input || input._ysaddr) return;
    input._ysaddr = true;
    injectStyle();
    input.setAttribute("autocomplete", "off");
    // The input needs a positioned ancestor for the absolute menu; wrap it.
    var host = input.parentNode;
    if (getComputedStyle(host).position === "static") host.style.position = "relative";

    var menu = null, items = [], active = -1, seq = 0, lastQ = "", timer = null;

    function close() { if (menu) { menu.remove(); menu = null; } items = []; active = -1; }
    function open() {
      if (!menu) { menu = document.createElement("div"); menu.className = "ysaddr-menu"; host.appendChild(menu); }
    }
    function render(list, provider) {
      open();
      menu.innerHTML = list.map(function (s, i) {
        return '<div class="ysaddr-item" data-i="' + i + '"><span class="pin">&#9679;</span><span>' + esc(s.label) + "</span></div>";
      }).join("") + '<div class="ysaddr-foot">Address lookup' + (provider === "google" ? " &middot; Google" : provider === "smarty" ? " &middot; Smarty" : " &middot; OpenStreetMap") + "</div>";
      items = list; active = -1;
      Array.prototype.forEach.call(menu.querySelectorAll(".ysaddr-item"), function (el) {
        el.addEventListener("mousedown", function (e) { e.preventDefault(); choose(parseInt(el.getAttribute("data-i"), 10)); });
      });
    }
    function highlight(n) {
      var els = menu ? menu.querySelectorAll(".ysaddr-item") : [];
      if (!els.length) return;
      active = (n + els.length) % els.length;
      Array.prototype.forEach.call(els, function (el, i) { el.classList.toggle("active", i === active); });
    }

    async function choose(i) {
      var s = items[i]; if (!s) return;
      close();
      var addr = s.address;
      if (!addr && s.id) {
        try {
          var r = await fetch("/api/address/details?id=" + encodeURIComponent(s.id));
          var j = await r.json(); addr = j.address;
        } catch (e) { addr = null; }
      }
      if (addr) {
        input.value = addr.line1 || input.value;
        if (typeof onSelect === "function") onSelect(addr);
      } else {
        input.value = s.label;
      }
    }

    async function query(q) {
      var mine = ++seq;
      try {
        var r = await fetch("/api/address/suggest?q=" + encodeURIComponent(q));
        var j = await r.json();
        if (mine !== seq) return;                 // a newer keystroke won
        if (document.activeElement !== input) return;
        if (j.suggestions && j.suggestions.length) render(j.suggestions, j.provider);
        else close();
      } catch (e) { close(); }
    }

    input.addEventListener("input", function () {
      var q = input.value.trim();
      if (q === lastQ) return; lastQ = q;
      clearTimeout(timer);
      if (q.length < 3) { close(); return; }
      timer = setTimeout(function () { query(q); }, 250);
    });
    input.addEventListener("keydown", function (e) {
      if (!menu) return;
      if (e.key === "ArrowDown") { e.preventDefault(); highlight(active + 1); }
      else if (e.key === "ArrowUp") { e.preventDefault(); highlight(active - 1); }
      else if (e.key === "Enter") { if (active >= 0) { e.preventDefault(); choose(active); } }
      else if (e.key === "Escape") { close(); }
    });
    input.addEventListener("blur", function () { setTimeout(close, 150); });
  }

  window.YSAddr = { attach: attach };
})();
