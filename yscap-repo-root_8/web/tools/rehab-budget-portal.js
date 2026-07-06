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
  var staffMode = q.get("staff") === "1";
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
  function injectUI() {
    var actions = document.querySelector(".topbar-actions");
    if (!actions) return;
    // A loan-file session doesn't need the share-link flow — the file IS the
    // save — and shouldn't navigate away to the marketing suite.
    actions.querySelectorAll("button").forEach(function (b) {
      if (/Share link/.test(b.textContent)) b.style.display = "none";
    });
    actions.querySelectorAll("a.back").forEach(function (a) { a.style.display = "none"; });
    document.querySelectorAll(".topbar-brand, .topbar-crumb a").forEach(function (a) {
      a.removeAttribute("href"); a.style.pointerEvents = "none";
    });
    chip = document.createElement("span");
    chip.className = "rb-portal-chip";
    chip.style.cssText = "font-size:.78rem;opacity:.85;margin-right:.4rem;white-space:nowrap";
    submitBtn = document.createElement("button");
    submitBtn.type = "button";
    submitBtn.className = "btn btn-line";
    submitBtn.style.cssText = "border-color:#9a7518;color:#e9c46a;font-weight:600";
    submitBtn.textContent = "Submit to loan file ✓";
    submitBtn.title = "Saves this Scope of Work onto your loan file and attaches a fresh PDF + Excel export (previous exports are replaced).";
    submitBtn.onclick = submit;
    actions.appendChild(chip);
    actions.appendChild(submitBtn);
    var crumb = document.querySelector(".topbar-crumb .here");
    if (crumb) crumb.textContent = "Rehab Budget — on your loan file";
  }

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
      submitBtn.textContent = "Submitted ✓";
      setChip(attachments.length ? "Scope of Work + PDF & Excel saved to your loan file ✓" : "Scope of Work saved to your loan file ✓");
      setTimeout(function () { submitBtn.textContent = orig; submitBtn.disabled = false; busy = false; }, 2500);
      var fl = document.getElementById("rb-flash");
      if (fl) { fl.textContent = "Submitted — your loan file now carries this Scope of Work" + (attachments.length ? " with a fresh PDF & Excel export." : "."); fl.classList.add("show"); setTimeout(function () { fl.classList.remove("show"); }, 3500); }
    } catch (err) {
      submitBtn.textContent = orig;
      submitBtn.disabled = false;
      busy = false;
      setChip("Submit failed: " + (err && err.message ? err.message : "please try again"), "err");
    }
  }

  function boot() { injectUI(); loadState(); }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
