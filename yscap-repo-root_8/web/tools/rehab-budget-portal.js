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

  // ---- FATAL banner ----------------------------------------------------------
  // A big, unmissable red banner pinned to the top of the builder. Raised when
  // the Scope of Work total does NOT match the file's required rehab budget
  // (#75): the save is refused server-side, the condition stays open, and the
  // borrower/officer sees exactly why. Cleared on the next successful save.
  var fatalBar = null;
  function showFatal(msg) {
    if (!fatalBar) {
      fatalBar = document.createElement("div");
      fatalBar.className = "rb-portal-fatal";
      fatalBar.setAttribute("role", "alert");
      fatalBar.style.cssText =
        "position:sticky;top:0;z-index:120;margin:0 0 .9rem;padding:.85rem 1rem;border-radius:12px;" +
        "border:1px solid #e06666;background:#3a1414;color:#ffd9d9;font-weight:600;line-height:1.45;" +
        "box-shadow:0 6px 24px rgba(0,0,0,.35)";
      var wrap = document.querySelector(".rb-wrap");
      if (wrap) wrap.insertBefore(fatalBar, wrap.firstChild);
    }
    fatalBar.innerHTML =
      '<div style="display:flex;gap:.6rem;align-items:flex-start">' +
      '<span style="font-size:1.15rem;line-height:1">⛔</span>' +
      '<div><strong style="display:block;margin-bottom:.15rem">Budget mismatch — this Scope of Work was NOT saved</strong>' +
      '<span style="font-weight:500">' + esc(msg) + '</span></div></div>';
    fatalBar.style.display = "";
    try { fatalBar.scrollIntoView({ behavior: "smooth", block: "start" }); } catch (e) {}
  }
  function clearFatal() { if (fatalBar) fatalBar.style.display = "none"; }

  // ---- non-blocking "saved as a draft" notice --------------------------------
  // Owner-directed: a Scope of Work whose total doesn't match the file's rehab
  // budget still SAVES (as a draft) — the condition simply stays open. This amber
  // notice explains that WITHOUT blocking; the user can keep working or exit.
  var noticeBar = null;
  function showNotice(msg) {
    if (!noticeBar) {
      noticeBar = document.createElement("div");
      noticeBar.className = "rb-portal-notice";
      noticeBar.setAttribute("role", "status");
      noticeBar.style.cssText =
        "position:sticky;top:0;z-index:115;margin:0 0 .9rem;padding:.8rem 1rem;border-radius:12px;" +
        "border:1px solid #e8c477;background:#fff7e6;color:#7a5a12;font-weight:600;line-height:1.45;" +
        "box-shadow:0 6px 20px rgba(0,0,0,.08)";
      var wrap = document.querySelector(".rb-wrap");
      if (wrap) wrap.insertBefore(noticeBar, wrap.firstChild);
    }
    noticeBar.innerHTML =
      '<div style="display:flex;gap:.6rem;align-items:flex-start">' +
      '<span style="font-size:1.1rem;line-height:1">💾</span>' +
      '<div><strong style="display:block;margin-bottom:.15rem">Saved as a draft — this condition stays open</strong>' +
      '<span style="font-weight:500">' + esc(msg) + '</span></div></div>';
    noticeBar.style.display = "";
  }
  function clearNotice() { if (noticeBar) noticeBar.style.display = "none"; }

  // A cheap signature of the current builder state + grand total. When the file
  // is closed ("Done") and nothing changed since the last successful save, we
  // skip re-exporting — that redundant second save is what left the borrower
  // "stuck" watching the spinner (#76).
  var lastSavedSig = null;
  function curSig() {
    try { return JSON.stringify(RB.getState()) + "|" + RB.grandTotal(); }
    catch (e) { return null; }
  }

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
        // Treat an already-submitted scope as "saved" so closing without edits
        // confirms instantly instead of re-exporting the same thing (#76).
        if (d && d.submitted) lastSavedSig = curSig();
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
    // embed=1 so a later preview of this saved copy renders in the clean, dark
    // embedded layout instead of flashing the light marketing shell (#76).
    var url = location.origin + location.pathname + "?embed=1#d=" + encState(state);
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
  // Returns a result object so callers (the "Done"/close handshake) can react:
  //   { ok:true }                         → saved
  //   { ok:false, fatal:true, message }   → budget mismatch, refused (#75)
  //   { ok:false, message }               → other failure (retry)
  var busy = false;
  async function submit() {
    if (busy) return { ok: false, message: "a save is already in progress" };
    busy = true;
    var orig = submitBtn ? submitBtn.textContent : SAVE_LABEL;
    if (submitBtn) { submitBtn.textContent = "Preparing exports…"; submitBtn.disabled = true; }
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
      if (submitBtn) submitBtn.textContent = "Saving to your loan file…";
      var res = await fetch(submitUrl, {
        method: "POST", headers: hdrs(),
        body: JSON.stringify({ payload: {
          state: state,
          total: RB.grandTotal(),
          // Construction subtotal + contingency amount so the server can verify the
          // Gold Standard Program's >=5% contingency rule without the frozen engine.
          subtotal: (RB.subtotal ? RB.subtotal() : undefined),
          contingency: (RB.contingency ? RB.contingency() : undefined),
          address: state.address || "",
          submittedAt: new Date().toISOString(),
          attachments: attachments,
        } }),
      });
      var d = null; try { d = await res.json(); } catch (e) {}
      if (!res.ok) {
        // 422 = the FATAL budget-mismatch gate (#75). The Scope of Work total
        // must match the file's required rehab budget EXACTLY; the server refused
        // and the condition stays open. Surface it loudly and DON'T report saved.
        var fatal = res.status === 422 || (d && d.fatal);
        var message = (d && d.error) || ("HTTP " + res.status);
        if (submitBtn) { submitBtn.textContent = orig; submitBtn.disabled = false; }
        busy = false;
        if (fatal) { showFatal(message); setChip("Not saved — budget mismatch", "err"); }
        else setChip("Save failed: " + message, "err");
        return { ok: false, fatal: !!fatal, message: message };
      }
      clearFatal();
      lastSavedSig = curSig();
      // Owner-directed: a total that doesn't match the file budget STILL saved (as a
      // draft). Show a non-blocking notice and let the user exit — the condition
      // stays open until the line items total the budget exactly.
      if (d && d.mismatch) {
        showNotice((d.mismatch && d.mismatch.message) || "The Scope of Work total doesn't match the file's rehab budget yet, so this condition stays open. Your work is saved — reopen any time to finish the line items.");
        if (submitBtn) submitBtn.textContent = "Saved (draft) ✓";
        setChip("Saved as a draft — doesn't match the budget yet");
        setTimeout(function () { if (submitBtn) { submitBtn.textContent = orig; submitBtn.disabled = false; } busy = false; }, 2500);
        return { ok: true, mismatch: true };
      }
      clearNotice();
      if (submitBtn) submitBtn.textContent = "Saved ✓";
      setChip("Rehab budget saved — HTML, Excel & PDF are on the condition ✓");
      setTimeout(function () { if (submitBtn) { submitBtn.textContent = orig; submitBtn.disabled = false; } busy = false; }, 2500);
      var fl = document.getElementById("rb-flash");
      if (fl) { fl.textContent = "Saved — the condition now carries this Scope of Work (editable HTML" + (attachments.length > 1 ? " + fresh Excel & PDF" : "") + "). Old versions were marked outdated."; fl.classList.add("show"); setTimeout(function () { fl.classList.remove("show"); }, 3500); }
      return { ok: true };
    } catch (err) {
      if (submitBtn) { submitBtn.textContent = orig; submitBtn.disabled = false; }
      busy = false;
      var em = (err && err.message) ? err.message : "please try again";
      setChip("Save failed: " + em, "err");
      return { ok: false, message: em };
    }
  }

  // Closing the portal overlay ("Done" / back / Esc) SAVES first: the host asks
  // for a full save and waits for confirmation before the sheet closes. Three
  // outcomes are reported back to the host:
  //   ys-tool-saved        → saved (or already saved, nothing changed) → close
  //   ys-tool-save-error   → FATAL budget mismatch (#75) → stay open, show it
  // "Done" therefore does exactly what "Save Rehab Budget" does — on BOTH the
  // borrower and the internal login (#77) — and never re-exports redundantly
  // when nothing changed since the last save (#76: no more stuck spinner).
  window.addEventListener("message", function (e) {
    if (!e.data || e.data.type !== "ys-tool-save-close") return;
    var saved = function () { try { window.parent.postMessage({ type: "ys-tool-saved" }, "*"); } catch (err) {} };
    var failed = function (msg, fatal) { try { window.parent.postMessage({ type: "ys-tool-save-error", message: msg || "", fatal: !!fatal }, "*"); } catch (err) {} };

    var finishFrom = function (r) {
      if (!r || r.ok) { saved(); return; }
      failed(r.message, r.fatal);        // fatal mismatch (or hard failure): keep the user in the tool
    };

    // Nothing changed since the last successful save → confirm instantly, no
    // second export. (curSig()===null means state is unreadable; save to be safe.)
    var sig = curSig();
    if (sig != null && lastSavedSig != null && sig === lastSavedSig) { saved(); return; }

    var started = false;
    var run = function () {
      if (busy) {                        // a save is already in flight — wait for it
        started = true;
        setTimeout(run, 400);
        return;
      }
      if (started) {                     // the in-flight save finished — reflect its result
        finishFrom(lastSavedSig != null && curSig() === lastSavedSig ? { ok: true } : { ok: false, message: "the save didn't complete — please try again" });
        return;
      }
      Promise.resolve(submit()).then(finishFrom, function () { saved(); });
    };
    run();
  });

  function boot() { injectUI(); loadState(); }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
