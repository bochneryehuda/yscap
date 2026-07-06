/* =====================================================================
   YS Rehab Budget — loan-file portal bridge.
   When the static Scope of Work builder is opened FROM a loan file
   (?app=<applicationId>&item=<checklistItemId>[&staff=1]) and a portal
   session exists (same-origin token in localStorage), this bridge:
     · loads the condition's saved state and restores the builder to it
     · autosaves every change back onto the condition (RB_PORTAL_ONSAVE)
     · adds a "Submit to loan file" action that snapshots the state and
       attaches fresh PDF + Excel exports to the condition — superseding
       the previous exports, so the file always carries current versions.
   Without those query params the tool behaves exactly as before.
   ===================================================================== */
(function () {
  "use strict";
  var q = new URLSearchParams(location.search);
  var appId = q.get("app"), itemId = q.get("item");
  if (!appId || !itemId) return;
  var staffMode = q.get("internal") === "1" || q.get("staff") === "1"; // "staff" kept for legacy links
  var embed = q.get("embed") === "1";
  var token = null;
  try { token = localStorage.getItem("ys_portal_token"); } catch (e) {}
  var base = staffMode ? "/api/staff" : "/api/borrower";
  var stateUrl = base + "/applications/" + appId + "/checklist/" + itemId + "/tool-state";
  var submitUrl = base + "/applications/" + appId + "/checklist/" + itemId + "/tool";
  function hdrs() { return { "Content-Type": "application/json", Authorization: "Bearer " + token }; }

  window.RB_PORTAL = true;

  var chip, submitBtn;
  function setChip(txt, tone) {
    if (!chip) return;
    chip.textContent = txt;
    chip.style.color = tone === "err" ? "#e08585" : tone === "busy" ? "" : "#7fa9b0";
  }
  var SAVE_LABEL = "Save Rehab Budget ✓";
  var SAVE_TITLE = "Saves this Scope of Work onto the loan-file condition: the editable HTML version plus a fresh Excel and PDF export (previous versions are marked old).";
  function injectUI() {
    // Inside the portal iframe (?embed=1) only the tool itself shows: the
    // marketing header, hero copy and footer disappear; the step strip stays.
    if (embed) {
      var st = document.createElement("style");
      st.textContent =
        ".topbar,.suite-footer,.fa-wrap,#floatActions{display:none!important}" +
        ".rb-hero .suite-eyebrow,.rb-hero h1,.rb-hero .tool-tagline,.rb-hero .intro{display:none!important}" +
        ".rb-hero{padding:0.6rem 1rem 0.2rem}" +
        "main{padding-top:0!important}" +
        ".rb-wrap{padding-left:max(10px,2vw);padding-right:max(10px,2vw)}" +
        "@media (max-width:720px){.rb-portal-bar{flex-wrap:wrap}.rb-portal-bar .btn{flex:1 1 auto;text-align:center}}";
      document.head.appendChild(st);
    }
    // A loan-file session doesn't need the share-link flow — the file IS the
    // save — and shouldn't navigate away to the marketing suite.
    document.querySelectorAll(".topbar-actions button").forEach(function (b) {
      if (/Share link/.test(b.textContent)) b.style.display = "none";
    });
    document.querySelectorAll(".topbar-actions a.back").forEach(function (a) { a.style.display = "none"; });
    document.querySelectorAll(".topbar-brand, .topbar-crumb a").forEach(function (a) {
      a.removeAttribute("href"); a.style.pointerEvents = "none";
    });

    // Slim portal action bar above the builder: Save (main) · Export PDF ·
    // Export Excel · Import · autosave chip.
    var wrap = document.querySelector(".rb-wrap");
    if (!wrap) return;
    var bar = document.createElement("div");
    bar.className = "rb-portal-bar";
    bar.style.cssText = "display:flex;gap:.5rem;align-items:center;margin:0 0 .9rem;padding:.6rem .8rem;" +
      "border:1px solid rgba(127,169,176,.35);border-radius:12px;background:rgba(11,16,20,.35);position:sticky;top:0;z-index:50;backdrop-filter:blur(6px)";
    submitBtn = document.createElement("button");
    submitBtn.type = "button";
    submitBtn.className = "btn rb-btn primary";
    submitBtn.style.cssText = "font-weight:700";
    submitBtn.textContent = SAVE_LABEL;
    submitBtn.title = SAVE_TITLE;
    submitBtn.onclick = submit;
    bar.appendChild(submitBtn);

    var mk = function (label, title, fn) {
      var b = document.createElement("button");
      b.type = "button"; b.className = "btn rb-btn"; b.textContent = label; b.title = title || "";
      b.onclick = fn; bar.appendChild(b); return b;
    };
    mk("Export PDF ⤓", "Download a branded PDF copy", function () { RB.exportPdf(this); });
    mk("Export Excel ⤓", "Download the Excel workbook (re-importable)", function () { RB.exportXlsx(this); });
    var imp = document.getElementById("rb-import");
    if (imp) mk("Import ⤒", "Resume from an Excel exported by this tool", function () { imp.click(); });

    chip = document.createElement("span");
    chip.className = "rb-portal-chip";
    chip.style.cssText = "font-size:.78rem;opacity:.85;margin-left:auto;white-space:nowrap;overflow:hidden;text-overflow:ellipsis";
    bar.appendChild(chip);
    wrap.insertBefore(bar, wrap.firstChild);

    var crumb = document.querySelector(".topbar-crumb .here");
    if (crumb) crumb.textContent = "Rehab Budget — on your loan file";
  }

  // Rewire the review step every render: the primary action on the file is
  // SAVE (Excel + PDF + HTML onto the condition), with Export PDF secondary.
  window.RB_PORTAL_ONRENDER = function () {
    document.querySelectorAll("#rb-body button").forEach(function (b) {
      var t = b.textContent || "";
      if (/Export Excel/.test(t)) {
        b.textContent = SAVE_LABEL;
        b.title = SAVE_TITLE;
        b.classList.add("primary");
        b.removeAttribute("onclick");
        b.onclick = function (e) { e.preventDefault(); submit(); };
      } else if (/Copy share link/.test(t)) {
        b.style.display = "none";
      }
    });
  };

  if (!token) {
    document.addEventListener("DOMContentLoaded", function () {
      var f = document.getElementById("rb-flash");
      if (f) { f.textContent = "Sign in to the portal first, then reopen this Scope of Work from your loan file."; f.classList.add("show"); }
    });
    return;
  }

  // ---- autosave (debounced on top of the tool's own debounce) ----
  var saveT = null;
  window.RB_PORTAL_ONSAVE = function (state) {
    setChip("Saving…", "busy");
    clearTimeout(saveT);
    saveT = setTimeout(function () {
      fetch(stateUrl, { method: "PUT", headers: hdrs(), body: JSON.stringify({ state: state }) })
        .then(function (r) { setChip(r.ok ? "Autosaved to loan file ✓" : "Autosave failed — retrying on next change", r.ok ? "" : "err"); })
        .catch(function () { setChip("Autosave failed — retrying on next change", "err"); });
    }, 900);
  };

  // ---- restore the condition's saved state ----
  function loadState() {
    fetch(stateUrl, { headers: hdrs() })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        if (d && d.state && window.RB && RB.setState) RB.setState(d.state);
        setChip(d && d.submitted ? "Previously submitted — changes re-submit new exports" : "Connected to your loan file ✓");
      })
      .catch(function () { setChip("Couldn't load the saved scope — working from this device", "err"); });
  }

  function fileToB64(file) {
    return new Promise(function (res, rej) {
      var r = new FileReader();
      r.onload = function () { var s = String(r.result); res(s.slice(s.indexOf(",") + 1)); };
      r.onerror = rej;
      r.readAsDataURL(file);
    });
  }

  // The "living static version": an HTML file that carries the full scope-of-
  // work state and reopens this exact builder when opened. It is saved onto
  // the condition next to the PDF/Excel and versioned the same way.
  function encState(o) {
    return btoa(unescape(encodeURIComponent(JSON.stringify(o)))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  function esc(s) { return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
  function htmlSnapshot(state) {
    var url = location.origin + location.pathname + "#d=" + encState(state);
    var addr = state.address || "your property";
    var html = "<!DOCTYPE html>\n<html lang=\"en\"><head><meta charset=\"utf-8\">" +
      "<title>Scope of Work — " + esc(addr) + "</title></head><body style=\"font-family:sans-serif;background:#0b1014;color:#f3efe6;padding:2rem\">" +
      "<h2>YS Capital Group — Scope of Work</h2>" +
      "<p>" + esc(addr) + " · saved " + new Date().toLocaleString("en-US") + "</p>" +
      "<p>Opening the live Scope of Work builder with this saved version…</p>" +
      "<p><a style=\"color:#7fa9b0\" href=\"" + url + "\">Open it manually if nothing happens →</a></p>" +
      "<script>location.replace(" + JSON.stringify(url) + ");<\/script>" +
      "</body></html>";
    return btoa(unescape(encodeURIComponent(html)));
  }
  function snapName(state, ext) {
    return ((state.address ? String(state.address).replace(/[^\w]+/g, "_").replace(/^_|_$/g, "").slice(0, 40) : "Scope_of_Work")
      + "_SOW_" + new Date().toISOString().slice(0, 10) + ext);
  }

  // ---- submit: state snapshot + fresh PDF & Excel exports onto the condition ----
  var busy = false;
  async function submit() {
    if (busy) return;
    busy = true;
    var orig = submitBtn.textContent;
    submitBtn.textContent = "Preparing exports…";
    submitBtn.disabled = true;
    try {
      if (RB.commit) RB.commit();                      // flush in-flight inputs
      var pdf = null, xls = null;
      try { pdf = await RB.exportPdf(null, { returnFile: true }); } catch (e) {}
      try { xls = await RB.exportXlsx(null, { returnFile: true }); } catch (e) {}
      var attachments = [];
      var files = [pdf, xls];
      for (var i = 0; i < files.length; i++) {
        var f = files[i];
        if (!f) continue;
        attachments.push({ filename: f.name, contentType: f.type || "application/octet-stream", dataBase64: await fileToB64(f) });
      }
      var state = RB.getState();
      // Always include the living static HTML version of this scope of work.
      attachments.push({ filename: snapName(state, ".html"), contentType: "text/html", dataBase64: htmlSnapshot(state) });
      submitBtn.textContent = "Saving to your loan file…";
      var res = await fetch(submitUrl, {
        method: "POST", headers: hdrs(),
        body: JSON.stringify({ payload: {
          state: state,
          total: RB.grandTotal(),
          address: state.address || "",
          submittedAt: new Date().toISOString(),
          attachments: attachments,
        } }),
      });
      if (!res.ok) { var d = null; try { d = await res.json(); } catch (e) {} throw new Error((d && d.error) || ("HTTP " + res.status)); }
      submitBtn.textContent = "Saved ✓";
      setChip("Rehab budget saved — HTML, Excel & PDF are on the condition ✓");
      setTimeout(function () { submitBtn.textContent = orig; submitBtn.disabled = false; busy = false; }, 2500);
      var fl = document.getElementById("rb-flash");
      if (fl) { fl.textContent = "Saved — the condition now carries this Scope of Work (editable HTML" + (attachments.length > 1 ? " + fresh Excel & PDF" : "") + "). Old versions were marked outdated."; fl.classList.add("show"); setTimeout(function () { fl.classList.remove("show"); }, 3500); }
    } catch (err) {
      submitBtn.textContent = orig;
      submitBtn.disabled = false;
      busy = false;
      setChip("Submit failed: " + (err && err.message ? err.message : "please try again"), "err");
    }
  }

  // Closing the portal overlay SAVES first: the host page asks for a full
  // save (HTML + Excel + PDF onto the condition) and waits for confirmation.
  window.addEventListener("message", function (e) {
    if (!e.data || e.data.type !== "ys-tool-save-close") return;
    var reply = function () { try { window.parent.postMessage({ type: "ys-tool-saved" }, "*"); } catch (err) {} };
    var started = false;
    var run = function () {
      if (busy) {
        // A save is already in flight — just wait for it to land, then confirm.
        started = true;
        setTimeout(run, 400);
        return;
      }
      if (started) { reply(); return; }                  // the in-flight save finished
      Promise.resolve(submit()).then(reply, reply);
    };
    run();
  });

  function boot() { injectUI(); loadState(); }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
