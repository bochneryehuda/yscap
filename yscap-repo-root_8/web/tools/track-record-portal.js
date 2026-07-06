/* =====================================================================
   YS Track Record — portal bridge.
   Turns the static Track Record builder into the LIVE track record:
     · ?portal=1              — the borrower's own general track record
       (one dataset per borrower, reused by every loan file's condition)
     · ?staff=1&borrower=<id> — the same record opened by staff from a
       loan file: add / edit / remove entries, set the verification
       status of each deal, and attach supporting documents.
   State persists to the server (never the URL hash). Every add / edit /
   delete in the tool is diff-synced to the portal API. ?embed=1 strips
   the marketing chrome so the tool sits inside a portal page.
   Without these query params the tool behaves exactly as before.
   ===================================================================== */
(function () {
  "use strict";
  var q = new URLSearchParams(location.search);
  var borrowerMode = q.get("portal") === "1";
  var staffMode = q.get("internal") === "1" || q.get("staff") === "1"; // "staff" kept for legacy links
  var staffBorrowerId = q.get("borrower") || "";
  if (!borrowerMode && !staffMode) return;
  if (staffMode && !staffBorrowerId) return;
  var embed = q.get("embed") === "1";
  var token = null;
  try { token = localStorage.getItem("ys_portal_token"); } catch (e) {}

  window.TR_PORTAL = true;

  var STATUS_LABEL = { pending: "Pending review", docs: "Documentation required", verified: "Verified", limited: "Limited verification" };
  var STATUS_COLOR = { pending: "#8a949c", docs: "#c9a24b", verified: "#4caf7d", limited: "#7fa9b0" };

  function listUrl() { return staffMode ? "/api/staff/borrowers/" + staffBorrowerId + "/track-records" : "/api/borrower/track-records"; }
  function createUrl() { return listUrl(); }
  function recordUrl(id) { return (staffMode ? "/api/staff" : "/api/borrower") + "/track-records/" + id; }
  function docsUrl(id) { return recordUrl(id) + "/documents"; }
  function downloadUrl(docId) { return (staffMode ? "/api/staff" : "/api/borrower") + "/documents/" + docId + "/download"; }

  async function api(method, url, body) {
    var res = await fetch(url, {
      method: method,
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
      body: body != null ? JSON.stringify(body) : undefined,
    });
    var data = null; try { data = await res.json(); } catch (e) {}
    if (!res.ok) throw new Error((data && data.error) || ("HTTP " + res.status));
    return data;
  }
  function flash(msg) {
    var f = document.getElementById("tr-flash");
    if (!f) return;
    f.textContent = msg; f.classList.add("show");
    clearTimeout(flash._t); flash._t = setTimeout(function () { f.classList.remove("show"); }, 3200);
  }

  /* ---- server row <-> tool prop mapping ---- */
  function dstr(v) { return v ? String(v).slice(0, 10) : ""; }
  function nstr(v) { return v == null || v === "" ? "" : String(Math.round(Number(v))); }
  function propFromRow(r) {
    var a = r.property_address || {};
    var dt = String(r.deal_type || "").toLowerCase();
    var kind = (dt.indexOf("hold") >= 0 || dt.indexOf("rental") >= 0) ? "hold" : "flip";
    if (dt.indexOf("ground") >= 0) kind = (r.sale_price || r.sale_date) ? "flip" : "hold";
    return {
      id: r.id, kind: kind,
      address: a.street || a.line1 || a.oneLine || "", city: a.city || "", state: a.state || "", zip: a.zip || "",
      entity: r.entity_name || "", propType: r.property_type || "", seller: "",
      purchasePrice: nstr(r.purchase_price), purchaseDate: dstr(r.purchase_date), rehab: nstr(r.rehab_amount),
      salePrice: nstr(r.sale_price), saleDate: dstr(r.sale_date),
      rent: nstr(r.rent_amount), rentDate: dstr(r.rent_date),
      refiAmount: nstr(r.refi_amount), refiDate: dstr(r.refi_date), currentValue: nstr(r.current_value),
      notes: r.notes || "", loNotes: r.lo_notes || "",
      status: r.verification_status || (r.is_verified ? "verified" : "pending"),
      _verified: !!r.is_verified, _docCount: r.doc_count || 0, _dealType: r.deal_type || "",
    };
  }
  function payloadFromProp(p) {
    var addr = {
      street: p.address || "", city: p.city || "", state: p.state || "", zip: p.zip || "",
      oneLine: [p.address, [p.city, p.state].filter(Boolean).join(", "), p.zip].filter(function (x) { return x && String(x).trim(); }).join(", "),
    };
    var dealType = p.kind === "hold" ? "fix-and-hold" : "flip";
    if (p._dealType && /ground/i.test(p._dealType)) dealType = p._dealType;   // keep ground-up labelling
    var out = {
      dealType: dealType, propertyAddress: addr,
      purchasePrice: p.purchasePrice || "", purchaseDate: p.purchaseDate || "", rehabAmount: p.rehab || "",
      salePrice: p.kind === "flip" ? (p.salePrice || "") : "", saleDate: p.kind === "flip" ? (p.saleDate || "") : "",
      rentAmount: p.kind === "hold" ? (p.rent || "") : "", rentDate: p.kind === "hold" ? (p.rentDate || "") : "",
      refiAmount: p.kind === "hold" ? (p.refiAmount || "") : "", refiDate: p.kind === "hold" ? (p.refiDate || "") : "",
      currentValue: p.currentValue || "", notes: p.notes || "",
      propertyType: p.propType || "", entityName: p.entity || "",
    };
    // Entity typed to match one of the borrower's LLCs → hard-link the deal.
    var llc = llcByName(p.entity);
    out.llcId = llc ? llc.id : null;
    return out;
  }

  /* ---- borrower LLCs for entity linking ---- */
  var llcs = [];
  function llcByName(name) {
    var n = String(name || "").trim().toLowerCase();
    if (!n) return null;
    for (var i = 0; i < llcs.length; i++) {
      if (String(llcs[i].llc_name || "").trim().toLowerCase() === n) return llcs[i];
    }
    return null;
  }
  function loadLlcs() {
    var url = staffMode ? "/api/staff/borrowers/" + staffBorrowerId + "/llcs" : "/api/borrower/llcs";
    return api("GET", url).then(function (rows) { llcs = rows || []; }).catch(function () { llcs = []; });
  }

  /* ---- per-form enhancements: LLC picker + address autocomplete ---- */
  window.TR_PORTAL_ONFORM = function (ov) {
    try {
      var ent = ov.querySelector('[data-f="entity"]');
      if (ent && llcs.length) {
        var dl = document.getElementById("tr-portal-llcs");
        if (!dl) {
          dl = document.createElement("datalist");
          dl.id = "tr-portal-llcs";
          document.body.appendChild(dl);
        }
        dl.innerHTML = llcs.map(function (l) { return '<option value="' + String(l.llc_name || "").replace(/"/g, "&quot;") + '">'; }).join("");
        ent.setAttribute("list", "tr-portal-llcs");
        ent.placeholder = "Pick one of your LLCs, or type a name";
      }
      var addrIn = ov.querySelector('[data-f="address"]');
      if (addrIn && window.YSAddr) {
        window.YSAddr.attach(addrIn, function (a) {
          addrIn.value = a.line1 || addrIn.value;
          var set = function (key, val) {
            var el = ov.querySelector('[data-f="' + key + '"]');
            if (el && val) { el.value = val; el.dispatchEvent(new Event("input", { bubbles: true })); }
          };
          addrIn.dispatchEvent(new Event("input", { bubbles: true }));
          set("city", a.city); set("state", a.state); set("zip", a.zip);
        });
      }
    } catch (e) { /* form still works without enhancements */ }
  };

  /* ---- diff sync: the tool mutates its working set; we mirror it server-side ---- */
  var basePayloads = {};                 // server id -> JSON of last-known payload
  var knownIds = [];
  var propsById = {};                    // server id -> last-loaded prop (for UI badges)
  var loaded = false, syncing = false, pendingSnap = null, syncT = null;

  window.TR_PORTAL_ONSAVE = function (snapshot) {
    if (!loaded) return;
    pendingSnap = snapshot;
    clearTimeout(syncT);
    syncT = setTimeout(runSync, 650);
  };

  async function runSync() {
    if (syncing) { syncT = setTimeout(runSync, 300); return; }
    var snapshot = pendingSnap;
    if (!snapshot) return;
    pendingSnap = null; syncing = true;
    var ops = 0;
    try {
      var present = {};
      for (var i = 0; i < snapshot.props.length; i++) {
        var p = snapshot.props[i];
        var pay = payloadFromProp(p);
        var js = JSON.stringify(pay);
        if (knownIds.indexOf(p.id) < 0) { ops++; await api("POST", createUrl(), pay); }
        else { present[p.id] = true; if (basePayloads[p.id] !== js) { ops++; await api("PUT", recordUrl(p.id), pay); } }
      }
      for (var k = 0; k < knownIds.length; k++) {
        var id = knownIds[k];
        if (!present[id]) { ops++; await api("DELETE", recordUrl(id)); }
      }
    } catch (e) {
      flash((e && e.message) || "Couldn't save that change — reloading your record.");
      ops++;
    } finally {
      if (ops) await reload().catch(function () {});
      syncing = false;
      if (pendingSnap) syncT = setTimeout(runSync, 120);
    }
  }

  var displayName = "";
  async function reload() {
    var rows = await api("GET", listUrl());
    var props = (rows || []).map(propFromRow);
    basePayloads = {}; knownIds = []; propsById = {};
    props.forEach(function (p) {
      knownIds.push(p.id);
      propsById[p.id] = p;
      basePayloads[p.id] = JSON.stringify(payloadFromProp(p));
    });
    loaded = true;
    TR.setState({ borrower: displayName, props: props });
  }

  /* ---- per-card UI: verification badge, docs, staff status control ---- */
  window.TR_PORTAL_ONRENDER = function () {
    if (!loaded) return;
    document.querySelectorAll(".tr-card[data-card]").forEach(function (card) {
      var id = card.getAttribute("data-card");
      var p = propsById[id];
      if (!p) return;                                   // not yet synced (fresh add)
      var head = card.querySelector(".tr-card-head");
      var actions = card.querySelector(".tr-card-actions");
      if (head && !head.querySelector(".tr-portal-status")) {
        var st = p.status || "pending";
        var b = document.createElement("span");
        b.className = "tr-portal-status";
        b.textContent = STATUS_LABEL[st] || st;
        b.style.cssText = "font-size:.72rem;font-weight:700;letter-spacing:.04em;padding:.18rem .55rem;border-radius:999px;border:1px solid " + (STATUS_COLOR[st] || "#8a949c") + ";color:" + (STATUS_COLOR[st] || "#8a949c");
        head.appendChild(b);
      }
      if (!actions) return;
      // A verified/limited deal is locked underwriting evidence for the borrower.
      if (!staffMode && p._verified) {
        actions.querySelectorAll("[data-edit],[data-del]").forEach(function (btn) { btn.remove(); });
        if (!actions.querySelector(".tr-portal-lock")) {
          var lock = document.createElement("span");
          lock.className = "tr-portal-lock";
          lock.title = "Verified by your loan team — locked";
          lock.textContent = "🔒";
          lock.style.cssText = "opacity:.7;font-size:.9rem;align-self:center";
          actions.appendChild(lock);
        }
      }
      if (!actions.querySelector(".tr-portal-docs")) {
        var docsBtn = document.createElement("button");
        docsBtn.className = "tr-icon tr-portal-docs";
        docsBtn.title = "Supporting documents (closing statement, deed, lease…)";
        docsBtn.textContent = "📎" + (p._docCount ? p._docCount : "");
        docsBtn.style.cssText = "font-size:.8rem";
        docsBtn.onclick = function () { openDocs(p); };
        actions.appendChild(docsBtn);
      }
      if (staffMode && !actions.querySelector(".tr-portal-verify")) {
        var sel = document.createElement("select");
        sel.className = "tr-portal-verify";
        sel.title = "Verification status";
        sel.style.cssText = "font-size:.72rem;background:transparent;border:1px solid #4e777f;border-radius:6px;color:inherit;padding:.15rem .2rem";
        ["pending", "docs", "verified", "limited"].forEach(function (s) {
          var o = document.createElement("option");
          o.value = s; o.textContent = STATUS_LABEL[s];
          if ((p.status || "pending") === s) o.selected = true;
          sel.appendChild(o);
        });
        sel.onchange = function () {
          api("POST", recordUrl(p.id) + "/verify", { status: sel.value })
            .then(function () { flash("Verification updated — " + STATUS_LABEL[sel.value] + "."); return reload(); })
            .catch(function (e) { flash(e.message || "Could not update verification"); });
        };
        actions.appendChild(sel);
      }
    });
  };

  /* ---- documents overlay per track-record entry ---- */
  function openDocs(p) {
    var old = document.getElementById("tr-portal-docsov"); if (old) old.remove();
    var ov = document.createElement("div");
    ov.id = "tr-portal-docsov"; ov.className = "tr-ov";
    ov.innerHTML = '<div class="tr-ov-box"><button class="tr-ov-x" aria-label="Close">✕</button>' +
      '<h3>Supporting documents</h3><p style="opacity:.75">' +
      (p.address || "This deal") + " — closing statement, deed, lease, or anything that verifies this deal.</p>" +
      '<div id="tr-portal-doclist"><p style="opacity:.6">Loading…</p></div>' +
      '<div style="margin-top:1rem"><button class="tr-btn primary" id="tr-portal-upbtn">+ Upload a document</button>' +
      '<input id="tr-portal-upinput" type="file" style="display:none"></div></div>';
    document.body.appendChild(ov);
    document.body.style.overflow = "hidden";
    var close = function () { ov.remove(); document.body.style.overflow = ""; };
    ov.querySelector(".tr-ov-x").onclick = close;
    ov.addEventListener("click", function (e) { if (e.target === ov) close(); });

    function renderList() {
      api("GET", docsUrl(p.id)).then(function (docs) {
        var el = ov.querySelector("#tr-portal-doclist");
        if (!el) return;
        if (!docs || !docs.length) { el.innerHTML = '<p style="opacity:.6">No documents on this deal yet.</p>'; return; }
        el.innerHTML = docs.map(function (d) {
          return '<div style="display:flex;gap:.6rem;align-items:center;padding:.35rem 0;border-bottom:1px solid rgba(127,169,176,.2)">' +
            '<span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + String(d.filename).replace(/</g, "&lt;") + "</span>" +
            '<button class="tr-btn line" data-dl="' + d.id + '" data-fn="' + String(d.filename).replace(/"/g, "&quot;") + '" style="padding:.2rem .7rem;font-size:.75rem">Download</button></div>';
        }).join("");
        el.querySelectorAll("[data-dl]").forEach(function (b) {
          b.onclick = function () {
            fetch(downloadUrl(b.dataset.dl), { headers: { Authorization: "Bearer " + token } })
              .then(function (r) { if (!r.ok) throw new Error("Download failed"); return r.blob(); })
              .then(function (blob) {
                var a = document.createElement("a");
                a.href = URL.createObjectURL(blob); a.download = b.dataset.fn || "document";
                document.body.appendChild(a); a.click(); a.remove();
                setTimeout(function () { URL.revokeObjectURL(a.href); }, 1500);
              }).catch(function (e) { flash(e.message); });
          };
        });
      }).catch(function (e) { flash(e.message || "Couldn't load documents"); });
    }
    renderList();

    var input = ov.querySelector("#tr-portal-upinput");
    ov.querySelector("#tr-portal-upbtn").onclick = function () { input.click(); };
    input.onchange = function () {
      var file = input.files && input.files[0];
      if (!file) return;
      var r = new FileReader();
      r.onload = function () {
        var s = String(r.result);
        api("POST", docsUrl(p.id), {
          filename: file.name, contentType: file.type || "application/octet-stream",
          dataBase64: s.slice(s.indexOf(",") + 1),
        }).then(function () { flash('Uploaded "' + file.name + '" to this deal.'); renderList(); return reload(); })
          .catch(function (e) { flash(e.message || "Upload failed"); });
      };
      r.readAsDataURL(file);
      input.value = "";
    };
  }

  /* ---- chrome for portal / embed mode ---- */
  function styleForPortal() {
    var css = "";
    if (embed) css += ".topbar,.suite-footer,.fa-wrap,.float-actions{display:none!important}main{padding-top:0}.tr-hero{padding-top:1.2rem;padding-bottom:.6rem}.tr-hero h1{font-size:1.6rem}";
    css += ".tr-borrower-wrap input[disabled]{opacity:.7}";
    var s = document.createElement("style");
    s.textContent = css;
    document.head.appendChild(s);
    // Sharing makes no sense on the live record — the server is the save.
    // IMPORT stays: an Excel export (or the YS template) merges into the live
    // record and syncs to the server like any other change.
    document.querySelectorAll(".topbar-actions button").forEach(function (b) {
      if (/Share link/.test(b.textContent)) b.style.display = "none";
    });
    if (embed) {
      // In embed mode the topbar is hidden — surface Import/Export in a slim bar.
      var main = document.querySelector("main");
      var hero = document.querySelector(".tr-hero");
      if (main) {
        var bar = document.createElement("div");
        bar.style.cssText = "display:flex;gap:.5rem;align-items:center;margin:0 auto .4rem;max-width:1080px;padding:0 1rem";
        var mk = function (label, title, fn) {
          var b = document.createElement("button");
          b.type = "button"; b.className = "tr-btn line"; b.textContent = label; b.title = title;
          b.style.cssText = "padding:.3rem .9rem;font-size:.8rem";
          b.onclick = fn; bar.appendChild(b);
        };
        mk("Import Excel ⤒", "Import your experience from an Excel exported by this tool or the YS template — it merges into your live record.",
          function () { var i = document.getElementById("tr-import"); if (i) i.click(); });
        mk("Export Excel ⤓", "Download the branded Excel workbook", function () { TR.exportXlsx(this); });
        mk("Export PDF ⤓", "Download the branded PDF report", function () { TR.exportPdf(this); });
        main.insertBefore(bar, hero ? hero.nextSibling : main.firstChild);
      }
    }
    // Importing must MERGE into the live record, never wipe it: keep the
    // server rows and add the imported deals on top (skip near-duplicates).
    var origImport = TR.importXlsx;
    TR.importXlsx = async function (input) {
      var before = {};
      (TR._state().props || []).forEach(function (p) { before[p.id] = true; });
      await origImport(input);
      var imported = (TR._state().props || []).filter(function (p) { return !before[p.id]; });
      if (!imported.length) return;
      var existing = Object.keys(propsById).map(function (k) { return propsById[k]; });
      var dupKey = function (p) { return (String(p.address || "").toLowerCase().trim() + "|" + (p.purchaseDate || "")); };
      var seen = {};
      existing.forEach(function (p) { seen[dupKey(p)] = true; });
      var fresh = imported.filter(function (p) { var k = dupKey(p); if (seen[k]) return false; seen[k] = true; return true; });
      TR.setState({ borrower: displayName, props: existing.concat(fresh) });
      flash("Imported " + fresh.length + " deal" + (fresh.length === 1 ? "" : "s") + " — merged into your live track record.");
    };
    var hero = document.querySelector(".tr-hero p");
    if (hero) hero.textContent = staffMode
      ? "The borrower's live track record. Add, edit or remove deals, set each deal's verification status, and attach the documentation you verified it against. Changes save automatically."
      : "Your live track record — it saves automatically and links to every loan file you have with us. Add each completed deal as a Fix & Flip or a Fix & Hold; your loan team verifies them from the documents you attach.";
    var nameInput = document.getElementById("tr-borrower");
    if (nameInput) { nameInput.disabled = true; nameInput.title = "Linked to the borrower profile"; }
  }

  function boot() {
    if (!token) {
      flash("Sign in to the portal to use your live track record.");
      return;
    }
    styleForPortal();
    var namePromise = staffMode
      ? api("GET", "/api/staff/borrowers/" + staffBorrowerId).then(function (b) { return ((b.first_name || "") + " " + (b.last_name || "")).trim(); })
      : api("GET", "/api/borrower/profile").then(function (b) { return ((b.first_name || "") + " " + (b.last_name || "")).trim(); });
    namePromise.catch(function () { return ""; }).then(function (n) {
      displayName = n || "";
      return loadLlcs();
    }).then(function () {
      return reload();
    }).then(function () {
      flash("Connected — your track record saves automatically.");
    }).catch(function (e) {
      flash((e && e.message) || "Couldn't load the track record.");
    });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
