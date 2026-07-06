/* ===========================================================
   YS CAPITAL — INVESTOR SUITE — shared library
   Finance math + formatting helpers used by every tool page.
   The actual per-tool formulas live inline on each tool page so
   they're easy to read; this file only holds reusable building blocks.
   =========================================================== */
window.YS = (function () {
  "use strict";

  /* --- Amortized monthly payment (mirrors Excel PMT, returns a positive number) ---
     payment = L * r / (1 - (1+r)^-n),  r = monthly rate, n = number of payments
     L = loan amount, annPct = annual rate as a percent (e.g. 6.5), years = term  */
  function monthlyPayment(L, annPct, years) {
    L = +L || 0; const r = (+annPct || 0) / 100 / 12; const n = (+years || 0) * 12;
    if (L <= 0 || n <= 0) return 0;
    if (r === 0) return L / n;
    return (L * r) / (1 - Math.pow(1 + r, -n));
  }

  /* --- input readers --- */
  function el(id) { return document.getElementById(id); }
  function raw(id) { const e = el(id); return e ? String(e.value).trim() : ""; }
  // numeric value, commas stripped; blank/non-numeric => 0
  function num(id) {
    const v = raw(id).replace(/,/g, "");
    const n = parseFloat(v);
    return isFinite(n) ? n : 0;
  }
  // returns null when blank (used for optional manual overrides)
  function opt(id) {
    const v = raw(id).replace(/,/g, "");
    if (v === "") return null;
    const n = parseFloat(v);
    return isFinite(n) ? n : null;
  }

  /* --- formatters --- */
  function fmtUSD(n, dec) {
    if (!isFinite(n)) return "—";
    return n.toLocaleString("en-US", { style: "currency", currency: "USD",
      minimumFractionDigits: dec == null ? 0 : dec, maximumFractionDigits: dec == null ? 0 : dec });
  }
  function fmtUSD2(n) { return fmtUSD(n, 2); }
  function fmtPct(n, dec) {
    if (!isFinite(n)) return "—";
    return (n * 100).toFixed(dec == null ? 1 : dec) + "%";
  }
  function fmtX(n, dec) {
    if (!isFinite(n)) return "—";
    return n.toFixed(dec == null ? 2 : dec) + "×";
  }
  function fmtNum(n, dec) {
    if (!isFinite(n)) return "—";
    return n.toLocaleString("en-US", { minimumFractionDigits: dec || 0, maximumFractionDigits: dec || 0 });
  }
  // write text to an element by id
  function put(id, text) { const e = el(id); if (e) e.textContent = text; }
  // toggle pos/neg color class on a result value
  function signClass(id, n) {
    const e = el(id); if (!e) return;
    e.classList.remove("pos", "neg");
    if (n > 0.0000001) e.classList.add("pos");
    else if (n < -0.0000001) e.classList.add("neg");
  }

  /* --- wire every input/select on the page to a recompute fn --- */
  function live(compute) {
    // restore any shared scenario from the URL before first paint
    applyState(readState());
    document.querySelectorAll("input, select").forEach(function (inp) {
      inp.addEventListener("input", function () { compute(); syncURL(); });
      inp.addEventListener("change", function () { compute(); syncURL(); });
    });
    compute();
    syncURL(); // give a fresh page its own shareable link immediately
  }

  /* --- scroll reveal + mobile niceties --- */
  function reveal() {
    const els = document.querySelectorAll(".reveal-up");
    if (!("IntersectionObserver" in window)) { els.forEach(e => e.classList.add("in")); return; }
    const io = new IntersectionObserver((ents) => ents.forEach(en => {
      if (en.isIntersecting) { en.target.classList.add("in"); io.unobserve(en.target); }
    }), { threshold: 0.1, rootMargin: "0px 0px -6% 0px" });
    els.forEach(e => io.observe(e));
  }
  document.addEventListener("DOMContentLoaded", reveal);

  /* ===========================================================
     SHAREABLE LINKS
     The investor's inputs are encoded into the page's URL (in the
     #fragment, so nothing hits a server and it works on any static
     host). A loan officer fills in a tool, copies the link, and the
     borrower opens it to the exact same scenario — fully live and
     editable. As anyone edits, their own link updates in step.
     =========================================================== */
  function encodeState(obj) {
    const json = JSON.stringify(obj);
    const b64 = btoa(unescape(encodeURIComponent(json)));
    return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  function decodeState(str) {
    try {
      let b64 = String(str).replace(/-/g, "+").replace(/_/g, "/");
      while (b64.length % 4) b64 += "=";
      return JSON.parse(decodeURIComponent(escape(atob(b64))));
    } catch (e) { return null; }
  }
  // gather every id'd input/select/textarea on the page (+ portfolio rows, if present)
  function collectState() {
    const v = {}, cb = {}, rad = {};
    document.querySelectorAll("input[id], select[id], textarea[id]").forEach(function (inp) {
      if (inp.hasAttribute("data-noshare")) return;   // admin-only fields never enter shared/exported state
      if (inp.type === "checkbox") { cb[inp.id] = inp.checked; }
      else if (inp.type === "radio") { /* captured by name below */ }
      else { v[inp.id] = inp.value; }
    });
    document.querySelectorAll('input[type="radio"][name]').forEach(function (r) { if (r.checked) rad[r.name] = r.value; });
    const st = { v: v };
    if (Object.keys(cb).length) st.c = cb;
    if (Object.keys(rad).length) st.rad = rad;
    if (typeof window.YS_getRows === "function") { const r = window.YS_getRows(); if (r && r.length) st.r = r; }
    return st;
  }
  function applyState(st) {
    if (!st) return;
    if (st.v) {
      Object.keys(st.v).forEach(function (id) {
        const e = document.getElementById(id);
        if (e && e.type !== "checkbox" && e.type !== "radio") e.value = st.v[id];
      });
    }
    if (st.c) {
      Object.keys(st.c).forEach(function (id) { const e = document.getElementById(id); if (e) e.checked = !!st.c[id]; });
    }
    if (st.rad) {
      Object.keys(st.rad).forEach(function (name) {
        document.querySelectorAll('input[type="radio"][name="' + name + '"]').forEach(function (r) { if (r.value === st.rad[name]) r.checked = true; });
      });
    }
    if (st.r && typeof window.YS_setRows === "function") window.YS_setRows(st.r);
  }
  function readState() {
    const m = /[#&]d=([^&]+)/.exec(location.hash || "");
    return m ? decodeState(m[1]) : null;
  }
  function syncURL() {
    try {
      const enc = encodeState(collectState());
      history.replaceState(null, "", location.pathname + location.search + "#d=" + enc);
    } catch (e) { /* ignore */ }
  }
  function shareURL() {
    try { return location.origin + location.pathname + location.search + "#d=" + encodeState(collectState()); }
    catch (e) { return location.href; }
  }
  function showToast(msg) {
    let t = document.getElementById("ys-toast");
    if (!t) { t = document.createElement("div"); t.id = "ys-toast"; t.className = "ys-toast"; document.body.appendChild(t); }
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(showToast._t);
    showToast._t = setTimeout(function () { t.classList.remove("show"); }, 2600);
  }
  async function shareLink(btn) {
    syncURL();
    const url = shareURL();
    let copied = false;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) { await navigator.clipboard.writeText(url); copied = true; }
    } catch (e) { copied = false; }
    if (!copied) {
      // older/file:// contexts: fall back to a manual copy prompt
      try { window.prompt("Copy this link to share with your borrower:", url); return; } catch (e2) { /* ignore */ }
    }
    if (btn) {
      const o = btn.textContent; btn.textContent = "Link copied ✓";
      setTimeout(function () { btn.textContent = o; }, 2000);
    }
    showToast("Link copied — share it and the numbers travel with it.");
  }

  /* ===========================================================
     EXPORT TO EXCEL
     Reads the tool's live inputs + results straight off the page
     and writes a branded, styled .xlsx the investor can save.
     One generic exporter serves every tool — the page is the
     single source of truth, so exports never drift from the UI.
     Uses xlsx-js-style (a styled superset of SheetJS), lazy-loaded
     from a CDN on first click.
     =========================================================== */
  function loadScript(src) {
    return new Promise(function (res, rej) {
      const s = document.createElement("script");
      s.src = src; s.onload = res; s.onerror = rej;
      document.head.appendChild(s);
    });
  }
  async function ensureXLSX() {
    if (window.XLSX && window.XLSX.utils) return;
    try { await loadScript("https://cdn.jsdelivr.net/npm/xlsx-js-style@1.2.0/dist/xlsx.bundle.js"); }
    catch (e) { await loadScript("https://unpkg.com/xlsx-js-style@1.2.0/dist/xlsx.bundle.js"); }
    if (!(window.XLSX && window.XLSX.utils)) throw new Error("spreadsheet library failed to load");
  }

  // format a single input's value for display in the sheet ($ commas, % suffix, plain text)
  function inputDisplay(field) {
    const inp = field.querySelector("input, select");
    if (!inp) return "";
    if (inp.tagName === "SELECT") return inp.options[inp.selectedIndex] ? inp.options[inp.selectedIndex].text : "";
    let val = String(inp.value).trim();
    if (val === "") return "";
    const adorn = field.querySelector(".adorn");
    const sym = adorn ? adorn.textContent.trim() : "";
    const n = parseFloat(val.replace(/,/g, ""));
    if (sym === "$" && isFinite(n)) return "$" + n.toLocaleString("en-US", { maximumFractionDigits: 2 });
    if (sym === "%") return val.replace(/,/g, "") + "%";
    return val;
  }

  // read a <table> into {headers, rows}; dropLast skips a trailing actions column
  function readTable(tbl, dropLast) {
    const head = [];
    tbl.querySelectorAll("thead th").forEach(function (th) { head.push(th.textContent.trim()); });
    if (dropLast) head.pop();
    const rows = [];
    tbl.querySelectorAll("tbody tr").forEach(function (tr) {
      const tds = tr.querySelectorAll("td");
      if (tds.length === 1 && tds[0].hasAttribute("colspan")) return; // placeholder row
      const cells = [];
      tds.forEach(function (td) {
        const inp = td.querySelector("input");
        if (inp) {
          let v = String(inp.value).trim();
          const num = parseFloat(v.replace(/,/g, ""));
          cells.push(inp.classList.contains("txt") || !isFinite(num) ? v : num.toLocaleString("en-US"));
        } else { cells.push(td.textContent.trim()); }
      });
      if (dropLast) cells.pop();
      rows.push(cells);
    });
    const foot = [];
    tbl.querySelectorAll("tfoot tr td").forEach(function (td) { foot.push(td.textContent.trim()); });
    if (dropLast && foot.length) foot.pop();
    return { headers: head, rows: rows, foot: foot };
  }

  // FALLBACK: build a clean branded snapshot from the live page (used only if the
  // template can't be fetched — e.g. opened from disk with no web server).
  function buildSnapshot(X) {
      // ---- gather content from the page ----
      const h1 = document.querySelector(".tool-hero h1");
      const name = (h1 ? h1.textContent : "YS Investor Suite").replace(/™/g, "").trim();

      const inputs = [];
      // walk inputs in document order, tracking the current panel heading + sub-heading
      // so each field is labelled with its group (e.g. "Option 1 — Interest rate (%)").
      let grp = "", sub = "";
      document.querySelectorAll(".inputs-col h2, .inputs-col .subhead, .inputs-col .field").forEach(function (node) {
        if (node.tagName === "H2") {
          let g = node.textContent.replace(/\s+/g, " ").trim();
          const pn = node.querySelector(".panel-num");
          if (pn) g = g.slice(pn.textContent.length).trim();
          grp = g; sub = "";
          return;
        }
        if (node.classList.contains("subhead")) { sub = node.textContent.replace(/\s+/g, " ").trim(); return; }
        const lab = node.querySelector("label");
        if (!lab) return;
        let nm = lab.textContent.replace(/\s+/g, " ").trim();
        const prefix = sub || grp;
        if (prefix) nm = prefix + " — " + nm;
        inputs.push([nm, inputDisplay(node)]);
      });

      const results = [];
      const hero = document.querySelector(".result-hero");
      if (hero) {
        const hl = hero.querySelector(".rh-label"), hv = hero.querySelector(".rh-value");
        const hs = hero.querySelector(".rh-sub"), vd = hero.querySelector(".verdict");
        results.push({ hero: true, label: hl ? hl.textContent.trim() : "Result",
          value: hv ? hv.textContent.trim() : "", note: hs ? hs.textContent.trim() : "" });
        if (vd) results.push({ label: "Assessment", value: vd.textContent.trim(), note: "" });
      }
      document.querySelectorAll(".result").forEach(function (r) {
        const l = r.querySelector(".r-label"), v = r.querySelector(".r-value"), hint = r.querySelector(".r-hint");
        results.push({ label: l ? l.textContent.replace(/\s+/g, " ").trim() : "",
          value: v ? v.textContent.trim() : "", note: hint ? hint.textContent.trim() : "" });
      });

      const cmp = document.querySelector(".cmp-table");
      const pf  = document.querySelector(".pf-table");
      const cmpTable = cmp ? readTable(cmp, false) : null;
      const pfTable  = pf ? readTable(pf, true) : null;

      // ---- styles ----
      const INK="0B1014", IVORY="F3EFE6", GOLD="C9A86A", LIGHT="EAF1F1", HERO="E1ECEC",
            LINE="DCE1E2", GRAY="5B6770", DARK="1F2A30", DEEP="1F3A40";
      const A = function (h, v) { return { horizontal: h, vertical: v || "center", wrapText: true }; };
      const titleStyle   = { font:{name:"Georgia",sz:18,bold:true,color:{rgb:IVORY}}, fill:{fgColor:{rgb:INK}}, alignment:A("left") };
      const tagStyle     = { font:{name:"Georgia",sz:11,italic:true,color:{rgb:GOLD}}, fill:{fgColor:{rgb:INK}}, alignment:A("left") };
      const metaStyle    = { font:{name:"Arial",sz:9,color:{rgb:GRAY}}, alignment:A("left") };
      const sectionStyle = { font:{name:"Arial",sz:11,bold:true,color:{rgb:DEEP}}, fill:{fgColor:{rgb:LIGHT}}, alignment:A("left"), border:{bottom:{style:"thin",color:{rgb:"4E777F"}}} };
      const labelStyle   = { font:{name:"Arial",sz:10,color:{rgb:"333333"}}, alignment:A("left"), border:{bottom:{style:"hair",color:{rgb:LINE}}} };
      const valueStyle   = { font:{name:"Arial",sz:10,bold:true,color:{rgb:INK}}, alignment:A("right"), border:{bottom:{style:"hair",color:{rgb:LINE}}} };
      const noteStyle    = { font:{name:"Arial",sz:9,italic:true,color:{rgb:GRAY}}, alignment:A("left"), border:{bottom:{style:"hair",color:{rgb:LINE}}} };
      const heroLabel    = { font:{name:"Arial",sz:10,bold:true,color:{rgb:DEEP}}, fill:{fgColor:{rgb:HERO}}, alignment:A("left") };
      const heroValue    = { font:{name:"Georgia",sz:14,bold:true,color:{rgb:INK}}, fill:{fgColor:{rgb:HERO}}, alignment:A("right") };
      const heroNote     = { font:{name:"Arial",sz:9,italic:true,color:{rgb:DEEP}}, fill:{fgColor:{rgb:HERO}}, alignment:A("left") };
      const thStyle      = { font:{name:"Arial",sz:9,bold:true,color:{rgb:IVORY}}, fill:{fgColor:{rgb:DARK}}, alignment:A("right") };
      const thStyleL     = { font:{name:"Arial",sz:9,bold:true,color:{rgb:IVORY}}, fill:{fgColor:{rgb:DARK}}, alignment:A("left") };
      const tdStyle      = { font:{name:"Arial",sz:9,color:{rgb:"333333"}}, alignment:A("right"), border:{bottom:{style:"hair",color:{rgb:LINE}}} };
      const tdStyleL     = { font:{name:"Arial",sz:9,color:{rgb:"333333"}}, alignment:A("left"), border:{bottom:{style:"hair",color:{rgb:LINE}}} };
      const totStyle     = { font:{name:"Arial",sz:9,bold:true,color:{rgb:INK}}, alignment:A("right"), border:{top:{style:"thin",color:{rgb:"4E777F"}}} };
      const discStyle    = { font:{name:"Arial",sz:8,italic:true,color:{rgb:GRAY}}, alignment:A("left","top") };
      const footStyle    = { font:{name:"Arial",sz:9,bold:true,color:{rgb:DEEP}}, alignment:A("left") };

      // ---- build sheet ----
      const maxC = Math.max(3, cmpTable ? cmpTable.headers.length : 0, pfTable ? pfTable.headers.length : 0);
      const aoa = [], styleMap = {}, merges = [], rowH = [];
      function enc(r, c) { return X.utils.encode_cell({ r: r, c: c }); }
      function styleRow(r, c0, c1, s) { for (let c = c0; c <= c1; c++) styleMap[enc(r, c)] = s; }
      function row(vals) { aoa.push(vals.slice()); return aoa.length - 1; }
      function pad(arr) { while (arr.length < maxC) arr.push(""); return arr; }

      let r;
      r = row(pad([name]));                          merges.push({ s:{r:r,c:0}, e:{r:r,c:maxC-1} }); styleRow(r,0,maxC-1,titleStyle); rowH[r]={hpt:26};
      r = row(pad(["Powered by YS Capital Group — The tool serious investors say YES to."])); merges.push({ s:{r:r,c:0}, e:{r:r,c:maxC-1} }); styleRow(r,0,maxC-1,tagStyle); rowH[r]={hpt:18};
      r = row(pad(["Generated " + new Date().toLocaleDateString("en-US",{year:"numeric",month:"long",day:"numeric"}) + "  ·  Prepared by Yehuda Bochner"])); merges.push({ s:{r:r,c:0}, e:{r:r,c:maxC-1} }); styleRow(r,0,maxC-1,metaStyle);
      row(pad([""]));

      if (inputs.length) {
        r = row(pad(["YOUR INPUTS"])); merges.push({ s:{r:r,c:0}, e:{r:r,c:maxC-1} }); styleRow(r,0,maxC-1,sectionStyle); rowH[r]={hpt:18};
        inputs.forEach(function (it) {
          r = row(pad([it[0], it[1]]));
          styleMap[enc(r,0)] = labelStyle; styleMap[enc(r,1)] = valueStyle;
          for (let c = 2; c < maxC; c++) styleMap[enc(r,c)] = labelStyle;
        });
        row(pad([""]));
      }

      if (results.length) {
        r = row(pad(["RESULTS"])); merges.push({ s:{r:r,c:0}, e:{r:r,c:maxC-1} }); styleRow(r,0,maxC-1,sectionStyle); rowH[r]={hpt:18};
        results.forEach(function (it) {
          r = row(pad([it.label, it.value, it.note || ""]));
          if (it.hero) { styleMap[enc(r,0)]=heroLabel; styleMap[enc(r,1)]=heroValue; styleMap[enc(r,2)]=heroNote; for(let c=3;c<maxC;c++)styleMap[enc(r,c)]=heroNote; rowH[r]={hpt:22}; }
          else { styleMap[enc(r,0)]=labelStyle; styleMap[enc(r,1)]=valueStyle; styleMap[enc(r,2)]=noteStyle; for(let c=3;c<maxC;c++)styleMap[enc(r,c)]=noteStyle; }
        });
        row(pad([""]));
      }

      function writeTable(title, tb) {
        if (!tb || !tb.headers.length) return;
        r = row(pad([title])); merges.push({ s:{r:r,c:0}, e:{r:r,c:maxC-1} }); styleRow(r,0,maxC-1,sectionStyle); rowH[r]={hpt:18};
        r = row(pad(tb.headers.slice()));
        for (let c = 0; c < tb.headers.length; c++) styleMap[enc(r,c)] = (c === 0 ? thStyleL : thStyle);
        rowH[r] = { hpt: 26 };
        tb.rows.forEach(function (cells) {
          r = row(pad(cells.slice()));
          for (let c = 0; c < cells.length; c++) styleMap[enc(r,c)] = (c === 0 ? tdStyleL : tdStyle);
        });
        if (tb.foot && tb.foot.length) {
          r = row(pad(tb.foot.slice()));
          for (let c = 0; c < maxC; c++) styleMap[enc(r,c)] = totStyle;
        }
        row(pad([""]));
      }
      writeTable("RATE OPTIONS", cmpTable);
      writeTable("PROPERTIES", pfTable);

      // disclaimer + contact
      r = row(pad(["DISCLAIMER"])); merges.push({ s:{r:r,c:0}, e:{r:r,c:maxC-1} }); styleRow(r,0,maxC-1,sectionStyle); rowH[r]={hpt:18};
      r = row(pad(["For estimation and education only. Outputs are estimates based on your inputs and are not a quote, an approval, or a commitment to lend, nor financial, legal or tax advice. Final terms depend on full underwriting. YS Capital Group assumes no liability for use of this tool. Use is at your own risk."]));
      merges.push({ s:{r:r,c:0}, e:{r:r,c:maxC-1} }); styleRow(r,0,maxC-1,discStyle); rowH[r]={hpt:58};
      row(pad([""]));
      r = row(pad(["YS Capital Group  ·  NMLS ID 2609746  ·  Equal Housing Lender"])); merges.push({ s:{r:r,c:0}, e:{r:r,c:maxC-1} }); styleRow(r,0,maxC-1,footStyle);
      r = row(pad(["718-831-2168  ·  sales@yscapgroup.com  ·  www.yscapgroup.com"])); merges.push({ s:{r:r,c:0}, e:{r:r,c:maxC-1} }); styleRow(r,0,maxC-1,metaStyle);

      // ---- assemble + download ----
      const ws = X.utils.aoa_to_sheet(aoa);
      ws["!merges"] = merges;
      ws["!rows"] = rowH;
      const cols = [{ wch: 42 }, { wch: 22 }, { wch: 34 }];
      for (let c = 3; c < maxC; c++) cols.push({ wch: 14 });
      ws["!cols"] = cols;
      Object.keys(styleMap).forEach(function (addr) {
        if (!ws[addr]) ws[addr] = { t: "s", v: "" };
        ws[addr].s = styleMap[addr];
      });
      const wb = X.utils.book_new();
      X.utils.book_append_sheet(wb, ws, "YS Results");
      const fname = name.replace(/[^\w]+/g, "_").replace(/^_|_$/g, "") + "_" +
        new Date().toISOString().slice(0, 10) + ".xlsx";
      return { wb: wb, fname: fname };
  }

  /* ===========================================================
     PRIMARY EXPORT — fill the original branded workbook
     Each tool ships with its source .xlsx as a template. On export
     we fetch it, drop the investor's current inputs into the right
     cells, clear cached formula values so Excel recalculates, and
     hand back a workbook that looks and behaves exactly like the
     uploaded sheet — fully editable, every formula live.
     =========================================================== */

  // map entries: [inputId, cell] or [inputId, cell, opt] where opt is:
  //   "blank"       leave the cell empty when the input is blank (for IF(=="") overrides)
  //   "div100"      store a percent as its decimal (6.5 -> 0.065)
  //   "div100skip"  like div100, but skip the cell entirely when the input is blank
  const EXPORT_CONFIG = {
    "qualifier-pro": {
      template: "templates/qualifier-pro.xlsx", sheet: "Enhanced Mortgage Calculator",
      map: [["price","B18"],["ltv","B19","blank"],["loanOverride","B22","blank"],["rate","B24"],
            ["term","B25"],["insA","B27"],["taxA","B28"],["hoa","B29"],["util","B32"],
            ["maint","B33"],["mgmt","B34"],["rent","B44"]]
    },
    "deal-analyzer": {
      template: "templates/deal-analyzer.xlsx", sheet: "Deal Analyzer",
      map: [["price","B23"],["ltv","B26","blank"],["loanOverride","B29","blank"],["rate","B31"],
            ["term","B32"],["rent","F20"],["bad","F33","div100"],["vac","F34","div100"],
            ["oTax","F40"],["oIns","F41"],["oHoa","F42"],["oMgmt","F43"],["oMaint","F44"],
            ["oUtil","F45"],["oOther","F51"],["aClose","B40"],["aImprove","B41"],["aHold","B42"],
            ["aLease","B43"],["aRefi","B44"],["aInspect","B45"],["aOther","B46"],["arv","B52"]]
    },
    "flip-analyzer": {
      template: "templates/flip-analyzer.xlsx", sheet: "YS Flip Anylyzer",
      map: [["price","B20"],["wholesale","B21"],["broker","B22"],["closing","B23"],["inspect","B24"],
            ["mortgageFees","B25"],["interior","B29"],["exterior","B30"],["systems","B31"],
            ["permits","B32"],["architect","B33"],["demo","B34"],["overage","B35"],["misc","B36"],
            ["contingency","B37"],["constrOverride","B38","blank"],["loan","B42"],["rate","B43"],
            ["months","B44"],["hTax","B47"],["hIns","B48"],["hUtil","B49"],["hMaint","B50"],
            ["hHoa","B51"],["risk","F19"],["commission","F30","div100"],["attorney","F31"],
            ["transfer","F32"],["staging","F33"],["concessions","F34"],["arv","F39"]]
    },
    "equity-compare": {
      template: "templates/equity-compare.xlsx", sheet: "Loan Comparison",
      map: [["o1amt","B18"],["o1rate","B19"],["o1term","B20"],["o2amt","B21"],["o2rate","B22"],
            ["o2term","B23"],["ioamt","B24"],["iorate","B25"],["coamt","B27"],["corate","B28"],["coterm","B29"]]
    },
    "ratesaver": {
      template: "templates/ratesaver.xlsx", sheet: "Rate Buydown Analysis",
      map: [["loan","B28"],["term","B29"],["freeRate","F26","div100"],
            ["r1","B16","div100"],["p1","C16","div100"],["r2","B17","div100"],["p2","C17","div100"],
            ["r3","B18","div100"],["p3","C18","div100"],["r4","B19","div100skip"],["p4","C19","div100skip"]]
    },
    "refi-breakpoint": {
      template: "templates/refi-breakpoint.xlsx", sheet: "Refinance Break-Even",
      map: [["broker","B16"],["appraisal","B17"],["mortgageTax","B18"],["recording","B19"],
            ["title","B20"],["attorney","B21"],["bank","B22"],["other","B23"],["prepay","B24"],
            ["loan","F16"],["oldRate","F17","div100"],["newRate","F18","div100"]]
    },
    "portfolio-tracker": {
      template: "templates/portfolio-tracker.xlsx", sheet: "YS Portfolio Tracker™",
      rows: { start: 21, max: 24,
              cols: { addr:"A", type:"B", price:"C", value:"E", mort:"F", cash:"H", rent:"J", pmt:"K", other:"L" } }
    }
  };

  function toolKey() { return (location.pathname.split("/").pop() || "").replace(/\.html?$/i, ""); }
  function rdVal(id) { const e = document.getElementById(id); return e ? String(e.value).replace(/,/g, "").trim() : ""; }

  // fflate (tiny zip library) lets us edit the workbook in place without disturbing
  // its embedded logos, drawings, styles or charts.
  async function ensureFflate() {
    if (window.fflate) return;
    try { await loadScript("https://cdn.jsdelivr.net/npm/fflate@0.8.2/umd/index.js"); }
    catch (e) { await loadScript("https://unpkg.com/fflate@0.8.2/umd/index.js"); }
    if (!window.fflate) throw new Error("zip library failed to load");
  }

  function decodeEntities(s) {
    return String(s).replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, function (_, d) { return String.fromCharCode(+d); });
  }
  function xesc(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
  function fmtNumX(n) { n = Number(n); return isFinite(n) ? String(n) : "0"; }

  // replace an existing <c r="REF" .../> cell, preserving its style index (s="..")
  function putCellXML(xml, ref, value, kind) {
    const re = new RegExp('<c r="' + ref + '"([^>]*?)(?:/>|>[\\s\\S]*?</c>)');
    return xml.replace(re, function (whole, attrs) {
      const sm = /\bs="(\d+)"/.exec(attrs); const s = sm ? (' s="' + sm[1] + '"') : "";
      if (kind === "blank") return '<c r="' + ref + '"' + s + '/>';
      if (kind === "text")  return '<c r="' + ref + '"' + s + ' t="inlineStr"><is><t xml:space="preserve">' + xesc(value) + '</t></is></c>';
      return '<c r="' + ref + '"' + s + '><v>' + value + '</v></c>';
    });
  }

  function downloadBlob(blob, fname) {
    const a = document.createElement("a");
    const url = URL.createObjectURL(blob);
    a.href = url; a.download = fname; document.body.appendChild(a); a.click();
    setTimeout(function () { document.body.removeChild(a); URL.revokeObjectURL(url); }, 1500);
  }

  // PRIMARY: patch the original .xlsx zip with the user's inputs, untouched branding.
  async function patchTemplate(cfg) {
    const resp = await fetch(cfg.template);
    if (!resp.ok) throw new Error("template fetch failed: " + resp.status);
    const buf = new Uint8Array(await resp.arrayBuffer());
    const files = window.fflate.unzipSync(buf);
    const dec = new TextDecoder(), enc = new TextEncoder();
    const td = function (p) { return dec.decode(files[p]); };

    let wbxml = td("xl/workbook.xml");
    const relsxml = td("xl/_rels/workbook.xml.rels");

    // resolve the target sheet -> its index (for activeTab) + worksheet XML path
    const sheetTags = wbxml.match(/<sheet\b[^>]*\/>/g) || [];
    let idx = 0, rid = null;
    for (let i = 0; i < sheetTags.length; i++) {
      const nm = /name="([^"]*)"/.exec(sheetTags[i]);
      const ri = /r:id="(rId\d+)"/.exec(sheetTags[i]);
      if (nm && ri && decodeEntities(nm[1]) === cfg.sheet) { idx = i; rid = ri[1]; break; }
    }
    if (rid === null) throw new Error("sheet not found: " + cfg.sheet);
    const rel = new RegExp('Id="' + rid + '"[^>]*?Target="([^"]*)"').exec(relsxml);
    if (!rel) throw new Error("sheet relationship not found");
    let tgt = rel[1];
    const spath = tgt.charAt(0) === "/" ? tgt.slice(1) : "xl/" + tgt;

    let xml = td(spath);

    if (cfg.map) {
      cfg.map.forEach(function (m) {
        const id = m[0], addr = m[1], opt = m[2];
        const raw = rdVal(id);
        if (opt === "blank" && raw === "") { xml = putCellXML(xml, addr, null, "blank"); return; }
        if (opt === "div100skip" && raw === "") return;
        let n = parseFloat(raw); if (!isFinite(n)) n = 0;
        if (opt === "div100" || opt === "div100skip") n = n / 100;
        xml = putCellXML(xml, addr, fmtNumX(n), "num");
      });
    }
    if (cfg.rows) {
      const C = cfg.rows.cols;
      let i = 0;
      document.querySelectorAll(".pf-table tbody tr").forEach(function (tr) {
        if (i >= cfg.rows.max) return;
        const rn = cfg.rows.start + i;
        const g = function (k) { const inp = tr.querySelector('input[data-k="' + k + '"]'); return inp ? String(inp.value).replace(/,/g, "").trim() : ""; };
        xml = putCellXML(xml, C.addr + rn, g("addr"), "text");
        xml = putCellXML(xml, C.type + rn, g("type"), "text");
        ["price", "value", "mort", "cash", "rent", "pmt", "other"].forEach(function (k) {
          const v = parseFloat(g(k)); xml = putCellXML(xml, C[k] + rn, fmtNumX(isFinite(v) ? v : 0), "num");
        });
        i++;
      });
    }

    // drop cached formula results on this sheet so the workbook recalculates on open
    xml = xml.replace(/<\/f><v>[\s\S]*?<\/v>/g, "</f>");
    xml = xml.replace(/(<f[^>]*\/>)<v>[\s\S]*?<\/v>/g, "$1");
    files[spath] = enc.encode(xml);

    // force a full recalc on load + open on the calculator sheet
    if (/<calcPr\b[^>]*\/>/.test(wbxml)) wbxml = wbxml.replace(/<calcPr\b[^>]*\/>/, '<calcPr calcId="0" fullCalcOnLoad="1"/>');
    else wbxml = wbxml.replace("</workbook>", '<calcPr calcId="0" fullCalcOnLoad="1"/></workbook>');
    if (/<workbookView\b[^>]*\/>/.test(wbxml)) {
      wbxml = wbxml.replace(/<workbookView\b([^>]*?)\/>/, function (_, a) {
        return '<workbookView' + a.replace(/\s*activeTab="\d+"/, "") + ' activeTab="' + idx + '"/>';
      });
    }
    files["xl/workbook.xml"] = enc.encode(wbxml);

    const out = window.fflate.zipSync(files, { level: 6 });
    const blob = new Blob([out], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });

    const h1 = document.querySelector(".tool-hero h1");
    const name = (h1 ? h1.textContent : "YS Investor Suite").replace(/™/g, "").trim();
    const fname = name.replace(/[^\w]+/g, "_").replace(/^_|_$/g, "") + "_" + new Date().toISOString().slice(0, 10) + ".xlsx";
    return { blob: blob, fname: fname };
  }

  async function exportXLSX(btn) {
    const original = btn ? btn.textContent : null;
    if (btn) { btn.textContent = "Preparing…"; btn.disabled = true; }
    try {
      const cfg = EXPORT_CONFIG[toolKey()];
      if (cfg) {
        try {
          await ensureFflate();
          const out = await patchTemplate(cfg);
          downloadBlob(out.blob, out.fname);
          return;
        } catch (e) {
          if (window.console) console.warn("Branded template export unavailable, using snapshot:", e);
        }
      }
      // FALLBACK (e.g. opened from disk with no web server): clean styled snapshot
      await ensureXLSX();
      const X = window.XLSX;
      const snap = buildSnapshot(X);
      X.writeFile(snap.wb, snap.fname, { cellStyles: true, compression: true });
    } catch (err) {
      alert("Sorry — the Excel export couldn't be generated. If you opened this page directly from a file on your computer, try it on the published website instead.");
      if (window.console) console.error(err);
    } finally {
      if (btn) { btn.textContent = original; btn.disabled = false; }
    }
  }

  return { monthlyPayment, num, opt, raw, fmtUSD, fmtUSD2, fmtPct, fmtX, fmtNum, put, signClass, live, el, exportXLSX,
           readState, syncURL, shareLink, collectState, applyState };
})();
