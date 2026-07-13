/* =====================================================================
   YS CAPITAL — address autocomplete (vanilla, dependency-free).
   Attaches a typeahead to any text input; suggestions come from our own
   /api/address/suggest (key stays server-side). On select it fills the caller's
   fields. Degrades silently to plain manual entry if the API is unavailable.

     YSAddr.attach(document.getElementById('pStreet'), function (addr) {
       // addr = { line1, city, state, zip, country }
     });

   The suggestion menu is rendered as a FIXED-position element anchored to the
   input's bounding rect and appended to <body> (owner-directed 2026-07-12) — so
   it can NEVER be clipped by an ancestor's overflow (the old "only 1 address /
   too short" bug) and NEVER overlaps the field itself (the old "pops up on top
   of the text bar" bug). It's white-first to match the portal, dark only under
   [data-theme="dark"]. Repositions on scroll/resize while open, and flips above
   the field when there isn't room below.
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
      // WHITE-FIRST: default light, matches the (light) tools/portal.
      ".ysaddr-menu{position:fixed;z-index:2147483000;background:#fff;" +
      "border:1px solid #DCE7E5;border-radius:11px;box-shadow:0 18px 50px -12px rgba(22,32,29,.30);overflow-y:auto;" +
      "font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-height:min(320px,44vh)}" +
      ".ysaddr-item{padding:11px 14px;font-size:14px;color:#172326;cursor:pointer;line-height:1.35;" +
      "border-bottom:1px solid #F1ECE1;display:flex;gap:9px;align-items:flex-start}" +
      ".ysaddr-item:last-child{border-bottom:0}" +
      ".ysaddr-item .pin{color:#2F7F86;flex:0 0 auto;margin-top:2px}" +
      ".ysaddr-item.active,.ysaddr-item:hover{background:#F1F6F5}" +
      ".ysaddr-foot{padding:7px 14px;font-size:10.5px;color:#8A979C;text-align:right;letter-spacing:.03em}" +
      // Dark only when the page is explicitly in the dark theme.
      ':root[data-theme="dark"] .ysaddr-menu{background:#1B242D;border-color:#2A3742;box-shadow:0 18px 50px -12px rgba(0,0,0,.6)}' +
      ':root[data-theme="dark"] .ysaddr-item{color:#F4F0E7;border-bottom-color:#232F3A}' +
      ':root[data-theme="dark"] .ysaddr-item .pin{color:#7FA9B0}' +
      ':root[data-theme="dark"] .ysaddr-item.active,:root[data-theme="dark"] .ysaddr-item:hover{background:#232F3A}' +
      ':root[data-theme="dark"] .ysaddr-foot{color:#74848C}';
    document.head.appendChild(s);
  }

  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]; }); }

  function attach(input, onSelect) {
    if (!input || input._ysaddr) return;
    input._ysaddr = true;
    injectStyle();
    input.setAttribute("autocomplete", "off");

    var menu = null, items = [], active = -1, seq = 0, lastQ = "", timer = null;

    // Keep the menu glued to the input on scroll/resize while it is open.
    function position() {
      if (!menu) return;
      var r = input.getBoundingClientRect();
      var vh = window.innerHeight || document.documentElement.clientHeight;
      var below = vh - r.bottom, above = r.top;
      var mh = menu.offsetHeight || 0;
      menu.style.left = Math.round(r.left) + "px";
      menu.style.width = Math.round(r.width) + "px";
      // Flip above only when there's clearly more room up top and it won't fit below.
      if (mh && below < mh + 8 && above > below) {
        menu.style.top = Math.round(r.top - mh - 4) + "px";
      } else {
        menu.style.top = Math.round(r.bottom + 4) + "px";
      }
    }
    var onScroll = function () { position(); };

    function close() {
      if (menu) { menu.remove(); menu = null; }
      items = []; active = -1;
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
    }
    function open() {
      if (!menu) {
        menu = document.createElement("div");
        menu.className = "ysaddr-menu";
        document.body.appendChild(menu);         // escape ancestor overflow/stacking
        // `true` (capture) so scrolling of ANY ancestor container repositions us.
        window.addEventListener("scroll", onScroll, true);
        window.addEventListener("resize", onScroll);
      }
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
      position();                                // measure AFTER content is in the DOM
    }
    function highlight(n) {
      var els = menu ? menu.querySelectorAll(".ysaddr-item") : [];
      if (!els.length) return;
      active = (n + els.length) % els.length;
      Array.prototype.forEach.call(els, function (el, i) {
        el.classList.toggle("active", i === active);
        if (i === active && el.scrollIntoView) el.scrollIntoView({ block: "nearest" });
      });
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
