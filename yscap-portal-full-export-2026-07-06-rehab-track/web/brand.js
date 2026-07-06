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
     sales grid in index.html. Individual NMLS is intentionally omitted for
     coordinators (business-purpose lending; the company NMLS is the lender). */
  var TEAM = {
    yehuda:   { name: "Yehuda Bochner",      role: "President",        email: "Yehuda@yscapgroup.com" },
    mendelb:  { name: "Mendel Bochner",      role: "Sales Manager",    email: "Mendelb@yscapgroup.com", cell: "929-454-2924" },
    solomon:  { name: "Solomon Katz",        role: "Loan Coordinator", email: "Solomon@yscapgroup.com", direct: "718-247-8703", ext: "103", cell: "845-324-3818" },
    yosef:    { name: "Yosef Cohen",         role: "Loan Coordinator", email: "Yosef@yscapgroup.com",   direct: "718-247-8704", ext: "104", cell: "347-461-8924" },
    moshe:    { name: "Moshe Mermelstein",   role: "Loan Coordinator", email: "Moshe@yscapgroup.com",   direct: "718-247-8706", ext: "106", cell: "929-214-7102" },
    shia:     { name: "Shia Kaff",           role: "Loan Coordinator", email: "Shia@yscapgroup.com",    direct: "718-247-8707", ext: "107", cell: "718-501-5654" },
    joshua:   { name: "Joshua Friedlander",  role: "Loan Coordinator", email: "Joshua@yscapgroup.com",  direct: "718-247-8708", ext: "108", cell: "347-768-4596" },
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
      sp.set("lo", CODE);
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
    var ph = o.direct || o.cell || "";
    var tel = ph.replace(/[^0-9]/g, "");
    var bar = document.createElement("div");
    bar.id = "loBar"; bar.className = "lo-bar";
    bar.innerHTML =
      '<div class="lo-inner">' +
        '<span class="lo-ava" aria-hidden="true">' + esc(initials(o.name)) + '</span>' +
        '<span class="lo-meta">' +
          '<span class="lo-name">' + esc(o.name) + '</span>' +
          '<span class="lo-role">' + esc(o.role) + ' \u00b7 YS Capital Group</span>' +
        '</span>' +
        '<span class="lo-contact">' +
          (ph ? '<a href="tel:' + tel + '">' + esc(ph) + '</a>' : '') +
          '<a href="mailto:' + esc(o.email) + '">' + esc(o.email) + '</a>' +
        '</span>' +
      '</div>';
    var tb = document.querySelector(".topbar");
    if (tb && tb.parentNode) tb.parentNode.insertBefore(bar, tb.nextSibling);
    else document.body.insertBefore(bar, document.body.firstChild);
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
