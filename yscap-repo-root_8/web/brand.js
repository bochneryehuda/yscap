/* =====================================================================
   YS CAPITAL — LOAN-OFFICER BRANDING (URL-driven, no backend, no storage)

   How it works
   ------------
   • Branding is decided ONLY by the ?lo=<code> URL parameter. There is no
     localStorage / cookie: strip ?lo from the address and the page is the
     plain company site again (no personal contact on screen or on the PDF).
   • A borrower who opens an officer's link (…?lo=mendelb) sees that officer's
     contact on every tool, and the ?lo code is carried onto every internal
     link they click, so it "sticks" through the whole session and into any
     share link they copy.
   • The home-page sales cards are turned into branded entry links here, so
     nothing in index.html has to be hand-edited when the roster changes —
     this file is the single source of truth for who is brandable.

   The LENDER on every document is always YS Capital Group (company NMLS).
   The officer is shown as the point of contact — never as a separate lender.
   ===================================================================== */
(function () {
  "use strict";

  /* ---- Roster: code = email local-part, lowercased. Keep in sync with the
     sales grid in index.html. The lender is always YS Capital Group (company
     NMLS); an unlicensed coordinator carries no individual NMLS. A LICENSED
     MLO carries their own `nmls` here, which is shown as a contact credential
     (not as a separate lender). */
  var TEAM = {
    yehuda:   { name: "Yehuda Bochner",      role: "President",        email: "Yehuda@yscapgroup.com" },
    mendelb:  { name: "Mendel Bochner",      role: "Sales Manager",    email: "Mendelb@yscapgroup.com", cell: "929-454-2924" },
    solomon:  { name: "Solomon Katz",        role: "Loan Coordinator", email: "Solomon@yscapgroup.com", direct: "718-247-8703", ext: "103", cell: "845-324-3818" },
    yosef:    { name: "Yosef Cohen",         role: "Loan Coordinator", email: "Yosef@yscapgroup.com",   direct: "718-247-8704", ext: "104", cell: "347-461-8924" },
    moshe:    { name: "Moshe Mermelstein",   role: "Loan Coordinator", email: "Moshe@yscapgroup.com",   direct: "718-247-8706", ext: "106", cell: "929-214-7102" },
    shia:     { name: "Shia Kaff",           role: "MLO & Loan Coordinator", nmls: "2723073", email: "Shia@yscapgroup.com",    direct: "718-247-8707", ext: "107", cell: "718-501-5654" },
    joshua:   { name: "Joshua Friedlander",  role: "MLO & Loan Coordinator", nmls: "2762861", email: "Joshua@yscapgroup.com",  direct: "718-247-8708", ext: "108", cell: "347-768-4596" },
    abraham:  { name: "Abraham Eisen",       role: "Loan Coordinator", email: "Abraham@yscapgroup.com", direct: "718-307-4316", ext: "116", cell: "347-324-7762" },
    mendel:   { name: "Mendel Schwimmer",    role: "Loan Coordinator", email: "Mendel@yscapgroup.com",  direct: "718-247-8759", ext: "113", cell: "845-745-5595" },
    sol:      { name: "Solomon Weiss",       role: "Loan Coordinator", email: "Sol@yscapgroup.com",     direct: "718-307-4314", ext: "114", cell: "929-486-3939" },
    isaac:    { name: "Isaac Zadmehr",       role: "Loan Coordinator", email: "Isaac@yscapgroup.com",   cell: "818-941-1437" },
    josef:    { name: "Josef Schnitzler",    role: "Loan Coordinator", email: "Josef@yscapgroup.com",   cell: "347-957-0738" },
    chaim:    { name: "Chaim Lebowitz",      role: "Loan Coordinator", email: "Chaim@yscapgroup.com",   cell: "845-717-1641" },
    pinchus:  { name: "Pinchus Wieder",      role: "Loan Coordinator", email: "Pinchus@yscapgroup.com", cell: "347-782-3357" },
    yisroel:  { name: "Yisroel Weinstock",   role: "Loan Coordinator", email: "Yisroel@yscapgroup.com", cell: "929-475-3015" },
    simcha:   { name: "Simcha Shedrowitzky", role: "Loan Coordinator", email: "Simcha@yscapgroup.com",  cell: "929-276-5925" }
  };

  function codeFromParam() {
    try { return (new URLSearchParams(location.search).get("lo") || "").toLowerCase().trim(); }
    catch (e) { return ""; }
  }
  var CODE = codeFromParam();
  var OFFICER = (CODE && TEAM.hasOwnProperty(CODE)) ? TEAM[CODE] : null;

  // Public surface used by the tools (e.g. the term-sheet PDF reads window.YSBRAND).
  window.YSBRAND = OFFICER ? assign({ code: CODE }, OFFICER) : null;
  window.YSBrand = {
    team: TEAM,
    current: function () { return window.YSBRAND; },
    codeOf: function (email) { return (email || "").split("@")[0].toLowerCase(); },
    // add ?lo=code to a RELATIVE internal href, preserving its own query + hash
    link: function (href) {
      if (!OFFICER || !href) return href;
      if (href.charAt(0) === "#") return href;
      if (/^(mailto:|tel:|javascript:|https?:\/\/|\/\/|data:)/i.test(href)) return href;
      var hash = "", q = "", h = href, i = h.indexOf("#");
      if (i >= 0) { hash = h.slice(i); h = h.slice(0, i); }
      i = h.indexOf("?");
      if (i >= 0) { q = h.slice(i + 1); h = h.slice(0, i); }
      var sp; try { sp = new URLSearchParams(q); } catch (e) { sp = new URLSearchParams(); }
      // An href that ALREADY names an officer wins. The home page's team cards
      // are built by enhanceHomeCards() as `suite.html?lo=<that officer>`, and
      // propagateLinks() runs straight after — stamping the CURRENT officer over
      // them would point every card on the page at the same person.
      if (!sp.get("lo")) sp.set("lo", CODE);
      return h + "?" + sp.toString() + hash;
    },
    phone: function (o) { return (o && (o.direct || o.cell)) || ""; },
    contactLine: function (o) {
      if (!o) return "";
      var ph = o.direct || o.cell || "";
      return o.name + (o.role ? ", " + o.role : "") + (ph ? "  \u00b7  " + ph : "") + (o.email ? "  \u00b7  " + o.email : "");
    }
  };

  function assign(t, s) { for (var k in s) if (s.hasOwnProperty(k)) t[k] = s[k]; return t; }
  function initials(name) { var p = (name || "").trim().split(/\s+/); return (((p[0] || "")[0] || "") + ((p[p.length - 1] || "")[0] || "")).toUpperCase(); }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]; }); }

  /* ---- home page: make each SALES card a branded entry link ---- */
  function enhanceHomeCards() {
    var grid = document.querySelector(".team .team-grid"); // first grid = sales
    if (!grid) return;
    var cards = grid.querySelectorAll(".member");
    for (var n = 0; n < cards.length; n++) {
      (function (card) {
        var mail = card.querySelector('a[href^="mailto:"], a[href^="mailto:" i]');
        if (!mail) return;
        var email = (mail.getAttribute("href") || "").replace(/^mailto:/i, "").trim();
        var code = email.split("@")[0].toLowerCase();
        if (!TEAM.hasOwnProperty(code)) return;
        var url = "suite.html?lo=" + code;
        var h3 = card.querySelector("h3");
        if (h3 && !h3.querySelector("a")) {
          var a = document.createElement("a");
          a.className = "member-open"; a.href = url; a.textContent = h3.textContent;
          h3.textContent = ""; h3.appendChild(a);
        }
        card.classList.add("member-clickable");
        card.setAttribute("data-lo", code);
        card.addEventListener("click", function (ev) {
          if (ev.target.closest("a")) return;           // let the email / name links work normally
          location.href = url;
        });
      })(cards[n]);
    }
  }

  /* ---- branded pages: carry ?lo onto internal links + show the contact bar ---- */
  function propagateLinks() {
    var as = document.querySelectorAll("a[href]");
    for (var i = 0; i < as.length; i++) {
      var href = as[i].getAttribute("href");
      as[i].setAttribute("href", window.YSBrand.link(href));
    }
  }

  function injectBar(o) {
    if (document.getElementById("loBar")) return;
    ensureCallStyles();
    var ph = o.direct || o.cell || "";
    var tel = ph.replace(/[^0-9]/g, "");
    var bar = document.createElement("div");
    bar.id = "loBar"; bar.className = "lo-bar";
    bar.innerHTML =
      '<div class="lo-inner">' +
        '<span class="lo-ava" aria-hidden="true">' + esc(initials(o.name)) + '</span>' +
        '<span class="lo-meta">' +
          '<span class="lo-name">' + esc(o.name) + '</span>' +
          '<span class="lo-role">' + esc(o.role) + ' \u00b7 YS Capital Group' + (o.nmls ? ' \u00b7 NMLS #' + esc(o.nmls) : '') + '</span>' +
        '</span>' +
        '<span class="lo-contact">' +
          (ph ? '<a href="tel:' + tel + '">' + esc(ph) + '</a>' : '') +
          '<a href="mailto:' + esc(o.email) + '">' + esc(o.email) + '</a>' +
          // "Request a call" (#28, owner-directed 2026-08-05): a lightweight capture
          // so a visitor on this officer's branded link can leave their name + phone
          // WITHOUT hunting for the contact form. It files a `contact` lead attributed
          // to this officer (officerCode = CODE), which the existing routing emails to
          // THAT officer and saves to the leads desk. Every branded page carries it.
          '<button type="button" class="lo-callbtn">Request a call</button>' +
        '</span>' +
      '</div>';
    var cb = bar.querySelector(".lo-callbtn");
    if (cb) cb.addEventListener("click", function () { openCallForm(o); });
    /* ---- where the bar goes -------------------------------------------
       Three page shapes, and only one of them used to work everywhere:

       (a) a static `.topbar` in normal flow (the tools) -> put the bar right
           after it. Unchanged.
       (b) NO .topbar and a header that is `position:fixed` -- the HOME PAGE
           and the legal pages, whose header is `.nav`. A fixed header is out
           of the document flow and paints OVER the top of <body>, so the
           fallback below dropped the bar underneath an opaque nav where
           nobody could see it. That is why the home page was the one page
           that never showed the officer (owner-reported 2026-08-03). A fixed
           header can only carry the bar by HOLDING it, so the bar is mounted
           inside the header, directly under the nav row and above the mobile
           menu, and the page is pushed down by the height it added.
       (c) anything else (a `position:sticky` header, or no header at all) ->
           the bar goes at the top of <body>. A sticky header does not overlay
           its own initial position, so the bar is visible there. Unchanged.
       ------------------------------------------------------------------- */
    var tb = document.querySelector(".topbar");
    if (tb && tb.parentNode) { tb.parentNode.insertBefore(bar, tb.nextSibling); return; }

    var fx = fixedHeader();
    if (fx) {
      bar.className = "lo-bar lo-bar-fixed";
      var firstRow = fx.firstElementChild;
      fx.insertBefore(bar, firstRow ? firstRow.nextSibling : null);
      offsetForFixedBar(bar);
      return;
    }

    document.body.insertBefore(bar, document.body.firstChild);
  }

  // The page's own header, when it is taken out of the flow (position:fixed).
  function fixedHeader() {
    var cands = document.querySelectorAll("header, .nav, .site-header");
    for (var i = 0; i < cands.length; i++) {
      var pos = "";
      try { pos = window.getComputedStyle(cands[i]).position; } catch (e) { pos = ""; }
      if (pos === "fixed") return cands[i];
    }
    return null;
  }

  // A fixed header that now carries the bar is taller, so everything it paints
  // over has to move down by exactly that much -- the page content (body
  // padding) and the landing point of every in-page #anchor (scroll padding).
  // Measured, never hard-coded: the bar wraps to two lines on a phone, and it
  // grows again when the web fonts land.
  function offsetForFixedBar(bar) {
    var html = document.documentElement;
    var basePad = 0, baseScroll = 0;
    try {
      basePad = parseFloat(window.getComputedStyle(document.body).paddingTop);
      baseScroll = parseFloat(window.getComputedStyle(html).scrollPaddingTop);
    } catch (e) {}
    if (!isFinite(basePad)) basePad = 0;
    if (!isFinite(baseScroll)) baseScroll = 0;   // "auto" -> 0

    function apply() {
      var h = bar.offsetHeight || 0;
      document.body.style.paddingTop = (basePad + h) + "px";
      html.style.scrollPaddingTop = (baseScroll + h) + "px";
    }
    apply();
    window.addEventListener("resize", apply);
    window.addEventListener("load", apply);
    if (window.ResizeObserver) { try { new window.ResizeObserver(apply).observe(bar); } catch (e) {} }
  }

  // ---- "Request a call" capture (#28) ------------------------------------
  // Injected once. Light palette to match the marketing site (dark text on
  // white); the modal is a plain fixed overlay so it works under every header
  // shape the bar itself handles.
  function ensureCallStyles() {
    if (!document.head || document.getElementById("lo-call-styles")) return;
    var s = document.createElement("style");
    s.id = "lo-call-styles";
    s.textContent =
      ".lo-callbtn{font:inherit;font-weight:600;font-size:13px;cursor:pointer;border:0;border-radius:8px;" +
      "padding:6px 12px;background:#2F7F86;color:#fff;line-height:1.2;white-space:nowrap}" +
      ".lo-callbtn:hover{background:#256168}" +
      ".lo-call-ov{position:fixed;inset:0;z-index:9999;background:rgba(20,27,34,.5);display:flex;" +
      "align-items:center;justify-content:center;padding:18px}" +
      ".lo-call-card{background:#fff;color:#141B22;max-width:400px;width:100%;border-radius:14px;" +
      "box-shadow:0 24px 60px -20px rgba(20,27,34,.5);padding:22px 22px 20px;position:relative;font-family:inherit}" +
      ".lo-call-card h3{margin:0 0 4px;font-size:19px;color:#141B22}" +
      ".lo-call-card p.sub{margin:0 0 14px;font-size:13px;color:#4B585C}" +
      ".lo-call-card label{display:block;font-size:12px;font-weight:600;color:#3A4550;margin:10px 0 4px}" +
      ".lo-call-card input{width:100%;box-sizing:border-box;font:inherit;font-size:16px;padding:9px 11px;" +
      "border:1px solid #d9d3c6;border-radius:8px;color:#141B22;background:#fff}" +
      ".lo-call-card input:focus{outline:2px solid #2F7F86;outline-offset:0;border-color:#2F7F86}" +
      ".lo-call-hp{position:absolute;left:-9999px;top:-9999px;width:1px;height:1px;overflow:hidden}" +
      ".lo-call-card .go{margin-top:16px;width:100%;font:inherit;font-weight:700;font-size:15px;cursor:pointer;" +
      "border:0;border-radius:9px;padding:11px;background:#AE8746;color:#fff}" +
      ".lo-call-card .go:hover{background:#987337}.lo-call-card .go:disabled{opacity:.6;cursor:default}" +
      ".lo-call-x{position:absolute;top:10px;right:12px;border:0;background:none;font-size:22px;line-height:1;" +
      "cursor:pointer;color:#4B585C}" +
      ".lo-call-err{color:#b3261e;font-size:13px;margin-top:10px}" +
      ".lo-call-ok{color:#141B22;font-size:15px;margin:8px 0 2px}";
    document.head.appendChild(s);
  }

  function openCallForm(o) {
    if (document.querySelector(".lo-call-ov")) return;
    var ov = document.createElement("div");
    ov.className = "lo-call-ov";
    ov.innerHTML =
      '<div class="lo-call-card" role="dialog" aria-modal="true" aria-label="Request a call">' +
        '<button type="button" class="lo-call-x" aria-label="Close">×</button>' +
        '<h3>Have ' + esc(o.name) + ' call you</h3>' +
        '<p class="sub">Leave your name and number and ' + esc((o.name || "").split(/\s+/)[0] || "your loan officer") + ' will reach out shortly.</p>' +
        '<div class="lo-call-body">' +
          '<label for="loCallName">Your name</label>' +
          '<input id="loCallName" type="text" autocomplete="name" />' +
          '<label for="loCallPhone">Phone</label>' +
          '<input id="loCallPhone" type="tel" inputmode="tel" autocomplete="tel" placeholder="(555) 555-5555" />' +
          '<label for="loCallEmail">Email <span style="font-weight:400;color:#4B585C">(optional)</span></label>' +
          '<input id="loCallEmail" type="email" autocomplete="email" />' +
          // Honeypot — a bot fills it, a human never sees it; leads.js drops any
          // submission carrying `website`.
          '<div class="lo-call-hp" aria-hidden="true"><input type="text" id="loCallHp" tabindex="-1" autocomplete="off" /></div>' +
          '<div class="lo-call-err" style="display:none"></div>' +
          '<button type="button" class="go">Request a call</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(ov);
    var card = ov.querySelector(".lo-call-card");
    var errEl = ov.querySelector(".lo-call-err");
    var goBtn = ov.querySelector(".go");
    function close() { if (ov.parentNode) ov.parentNode.removeChild(ov); document.removeEventListener("keydown", onKey); }
    function onKey(e) { if (e.key === "Escape") close(); }
    document.addEventListener("keydown", onKey);
    ov.addEventListener("click", function (e) { if (e.target === ov) close(); });
    ov.querySelector(".lo-call-x").addEventListener("click", close);
    var nameEl = ov.querySelector("#loCallName");
    if (nameEl) nameEl.focus();

    goBtn.addEventListener("click", function () {
      var name = (ov.querySelector("#loCallName").value || "").trim();
      var phone = (ov.querySelector("#loCallPhone").value || "").trim();
      var email = (ov.querySelector("#loCallEmail").value || "").trim();
      var hp = (ov.querySelector("#loCallHp").value || "").trim();
      errEl.style.display = "none";
      if (phone.replace(/[^0-9]/g, "").length < 7 && !email) {
        errEl.textContent = "Please enter a phone number (or an email) so we can reach you.";
        errEl.style.display = "block"; return;
      }
      if (!window.fetch) {
        errEl.textContent = "Please call or email " + ((o.name || "").split(/\s+/)[0] || "us") + " directly.";
        errEl.style.display = "block"; return;
      }
      goBtn.disabled = true; goBtn.textContent = "Sending…";
      var body = {
        tool: "contact", name: name, phone: phone, email: email,
        officerCode: CODE, website: hp,
        subject: "Call request — " + (o.name || ""),
        message: "Requested a call from " + (o.name || "their loan officer") + "'s branded page.",
      };
      fetch("/api/leads", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      }).then(function (r) { return r.ok ? r.json() : Promise.reject(r); }).then(function () {
        card.querySelector(".lo-call-body").innerHTML =
          '<p class="lo-call-ok"><strong>Thanks' + (name ? ", " + esc(name.split(/\s+/)[0]) : "") + "!</strong> " +
          esc((o.name || "").split(/\s+/)[0] || "Your loan officer") + " will reach out shortly.</p>";
        card.querySelector("h3").textContent = "Request received";
        card.querySelector("p.sub").style.display = "none";
        setTimeout(close, 3000);
      }).catch(function () {
        goBtn.disabled = false; goBtn.textContent = "Request a call";
        errEl.textContent = "Sorry — that didn't go through. Please call or email " +
          (o.name ? (o.name || "").split(/\s+/)[0] : "us") + " directly.";
        errEl.style.display = "block";
      });
    });
  }

  function run() {
    enhanceHomeCards();          // safe no-op off the home page
    if (OFFICER) {
      propagateLinks();
      injectBar(OFFICER);
    }
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", run);
  else run();
})();
