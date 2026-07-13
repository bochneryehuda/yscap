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
      entity: r.entity_name || "", ownedPersonally: !!r.owned_personally, propType: r.property_type || "", seller: "",
      purchasePrice: nstr(r.purchase_price), purchaseDate: dstr(r.purchase_date), rehab: nstr(r.rehab_amount),
      salePrice: nstr(r.sale_price), saleDate: dstr(r.sale_date),
      rent: nstr(r.rent_amount), rentDate: dstr(r.rent_date),
      refiAmount: nstr(r.refi_amount), refiDate: dstr(r.refi_date), currentValue: nstr(r.current_value),
      notes: r.notes || "", loNotes: r.lo_notes || "",
      status: r.verification_status || (r.is_verified ? "verified" : "pending"),
      _verified: !!r.is_verified, _docCount: r.doc_count || 0, _dealType: r.deal_type || "",
      _docs: r.docs || [], _requests: r.doc_requests || [],
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
      propertyType: p.propType || "", entityName: p.ownedPersonally ? "" : (p.entity || ""),
      ownedPersonally: !!p.ownedPersonally,
    };
    // Entity typed to match one of the borrower's LLCs → hard-link the deal.
    // A personal-name property carries no entity link at all.
    var llc = p.ownedPersonally ? null : llcByName(p.entity);
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
  var idMap = {};                        // client temp id ("p<random>") -> server id
  var loaded = false, syncing = false, pendingSnap = null, syncT = null;

  // Drop a server id from every local index (after a DELETE) so it can't be
  // re-deleted or leak a stale temp->server mapping.
  function forgetId(id) {
    var i = knownIds.indexOf(id);
    if (i >= 0) knownIds.splice(i, 1);
    delete basePayloads[id];
    delete propsById[id];
    Object.keys(idMap).forEach(function (t) { if (idMap[t] === id) delete idMap[t]; });
  }

  window.TR_PORTAL_ONSAVE = function (snapshot) {
    if (!loaded) return;
    pendingSnap = snapshot;
    clearTimeout(syncT);
    syncT = setTimeout(runSync, 650);
  };

  // The portal's full-screen tool sheet closes tools through a save handshake
  // (same contract as the Scope of Work): flush any pending diff-sync, then
  // confirm so the sheet can close without losing the last edit.
  window.addEventListener("message", function (e) {
    if (!e.data || e.data.type !== "ys-tool-save-close") return;
    var reply = function () { try { window.parent.postMessage({ type: "ys-tool-saved" }, "*"); } catch (err) {} };
    var waitFlushed = function () {
      if (syncing || pendingSnap) { setTimeout(waitFlushed, 250); return; }
      reply();
    };
    if (pendingSnap) { clearTimeout(syncT); runSync().then(waitFlushed, reply); }
    else waitFlushed();
  });

  async function runSync() {
    if (syncing) { syncT = setTimeout(runSync, 300); return; }
    var snapshot = pendingSnap;
    if (!snapshot) return;
    pendingSnap = null; syncing = true;
    var changed = false, failed = false;
    try {
      var present = {};
      for (var i = 0; i < snapshot.props.length; i++) {
        var p = snapshot.props[i];
        // A line the tool just added carries a client temp id; once we've created
        // it server-side we remember its real id here, so this resolves to that
        // real id on every later pass.
        var sid = idMap[p.id] != null ? idMap[p.id] : p.id;
        var pay = payloadFromProp(p);
        var js = JSON.stringify(pay);
        if (knownIds.indexOf(sid) < 0) {
          // BRAND-NEW line — create it exactly ONCE. Then adopt the server id
          // back into the tool + the open form so the next keystroke UPDATES
          // this row instead of inserting another (the bug that saved a fresh
          // record for "13", "130", "1305 Barbara", … while typing an address).
          // Send the line's stable local id as an idempotency key: if this POST
          // is ever retried (network replay, second tab) the server UPDATEs the
          // one row instead of inserting a duplicate (db/087). Belt-and-suspenders.
          var created = await api("POST", createUrl(), Object.assign({ clientRowId: p.id }, pay));
          var newId = created && (created.trackRecordId != null ? created.trackRecordId : created.id);
          changed = true;
          if (newId != null) {
            idMap[p.id] = newId;
            knownIds.push(newId);
            basePayloads[newId] = js;
            present[newId] = true;
            propsById[newId] = Object.assign({}, p, { id: newId, status: "pending", _verified: false, _docCount: 0, _dealType: pay.dealType });
            try { TR.adoptServerId(p.id, newId); } catch (e) { /* tool still works */ }
          }
        } else {
          present[sid] = true;
          if (basePayloads[sid] !== js) { await api("PUT", recordUrl(sid), pay); basePayloads[sid] = js; changed = true; }
        }
      }
      // Anything we know server-side that's no longer in the tool was deleted.
      var toDelete = knownIds.filter(function (id) { return !present[id]; });
      for (var k = 0; k < toDelete.length; k++) { await api("DELETE", recordUrl(toDelete[k])); forgetId(toDelete[k]); changed = true; }
    } catch (e) {
      failed = true;
      flash((e && e.message) || "Couldn't save that change — reloading your record.");
    } finally {
      syncing = false;
      if (failed) {
        // Hard failure: pull the server's truth back so the tool and our indexes
        // agree again (this reload replaces the working set — safe here because
        // the edit already failed).
        await reload().catch(function () {});
      } else if (changed) {
        // Keep the host page's requirement counts live and refresh the saved
        // static copy — WITHOUT the wholesale reload()/setState() that used to
        // wipe an in-progress add and re-create it as a new record every pass.
        try { window.parent.postMessage({ type: "ys-tr-sync", counts: bucketCounts(snapshot.props) }, location.origin); } catch (e) { /* not embedded */ }
        scheduleSnapshot();
      }
      if (pendingSnap) syncT = setTimeout(runSync, 120);
    }
  }

  var displayName = "";
  async function reload() {
    var rows = await api("GET", listUrl());
    var props = (rows || []).map(propFromRow);
    // A full reload rebuilds identity from the server — every row now carries its
    // real id, so any client-temp->server mapping is obsolete.
    basePayloads = {}; knownIds = []; propsById = {}; idMap = {};
    props.forEach(function (p) {
      knownIds.push(p.id);
      propsById[p.id] = p;
      basePayloads[p.id] = JSON.stringify(payloadFromProp(p));
    });
    loaded = true;
    TR.setState({ borrower: displayName, props: props });
    // Tell the hosting portal page where the record stands NOW, so condition
    // counts / requirement chips update live while the tool is open.
    try {
      window.parent.postMessage({ type: "ys-tr-sync", counts: bucketCounts(props) }, location.origin);
    } catch (e) { /* not embedded */ }
    scheduleSnapshot();
  }

  /* ---- the SAVED STATIC COPY: a self-contained HTML file with the data ---- */
  // Rebuilt and pushed to the server after every change (debounced), so the
  // profile / every loan file always carries a current, openable static copy.
  function bucketCounts(props) {
    var c = { flips: 0, holds: 0, ground: 0, total: 0 };
    (props || []).forEach(function (p) {
      var t = String(p._dealType || "").toLowerCase();
      if (t.indexOf("ground") >= 0) c.ground++;
      else if (t ? t.indexOf("flip") >= 0 : p.kind === "flip") c.flips++;
      else c.holds++;
      c.total++;
    });
    return c;
  }
  function escH(s) { return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
  function fmtMoney(v) { var n = Number(v); return isFinite(n) && n ? "$" + Math.round(n).toLocaleString("en-US") : "—"; }
  function encSnap(o) { return btoa(unescape(encodeURIComponent(JSON.stringify(o)))); }
  function snapshotHtml() {
    var snap = TR.snap();
    var props = snap.props || [];
    var counts = bucketCounts(props);
    var openUrl = location.origin + "/tools/track-record.html#d=" + encSnap(snap);
    var when = new Date().toLocaleString("en-US");
    function exitCell(p) {
      if (p.kind === "flip") return "Sold " + fmtMoney(p.salePrice) + (p.saleDate ? " · " + escH(p.saleDate) : "");
      var bits = [];
      if (p.rent) bits.push("Rents " + fmtMoney(p.rent) + "/mo" + (p.rentDate ? " since " + escH(p.rentDate) : ""));
      if (p.refiAmount) bits.push("Refi " + fmtMoney(p.refiAmount) + (p.refiDate ? " · " + escH(p.refiDate) : ""));
      return bits.join("<br>") || "—";
    }
    function row(p) {
      var st = propsById[p.id] ? (propsById[p.id].status || "pending") : "pending";
      return "<tr><td>" + escH([p.address, [p.city, p.state].filter(Boolean).join(", "), p.zip].filter(Boolean).join(", ") || "—") +
        "</td><td>" + escH(p.ownedPersonally ? "Personal name" : (p.entity || "—")) +
        "</td><td>" + escH(p.propType || "—") +
        "</td><td>" + fmtMoney(p.purchasePrice) + (p.purchaseDate ? "<br><small>" + escH(p.purchaseDate) + "</small>" : "") +
        "</td><td>" + fmtMoney(p.rehab) +
        "</td><td>" + exitCell(p) +
        "</td><td>" + escH(STATUS_LABEL[st] || st) + "</td></tr>";
    }
    function section(title, list) {
      if (!list.length) return "";
      return "<h2>" + escH(title) + " <small>(" + list.length + ")</small></h2>" +
        "<div class=\"tw\"><table><thead><tr><th>Property</th><th>Entity</th><th>Type</th><th>Purchase</th><th>Rehab</th><th>Exit</th><th>Verification</th></tr></thead><tbody>" +
        list.map(row).join("") + "</tbody></table></div>";
    }
    var isG = function (p) { return /ground/i.test(String(p._dealType || "")); };
    var flips = props.filter(function (p) { return !isG(p) && p.kind === "flip"; });
    var holds = props.filter(function (p) { return !isG(p) && p.kind !== "flip"; });
    var ground = props.filter(isG);
    return "<!DOCTYPE html>\n<html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">" +
      "<title>Track Record — " + escH(snap.borrower || "Borrower") + "</title><style>" +
      "body{font-family:'Hanken Grotesk',system-ui,Arial,sans-serif;background:#141B22;color:#F4F0E7;margin:0;padding:2rem 1rem;line-height:1.5}" +
      "main{max-width:960px;margin:0 auto}h1{font-family:Georgia,serif;font-weight:600;margin:0 0 .2rem}" +
      "h2{font-family:Georgia,serif;font-weight:600;margin:1.6rem 0 .5rem}h2 small{color:#A6B3BA;font-size:.7em}" +
      ".sum{display:flex;gap:.6rem;flex-wrap:wrap;margin:.8rem 0 1rem}" +
      ".chip{border:1px solid rgba(127,169,176,.5);border-radius:999px;padding:.25rem .8rem;font-size:.82rem;font-weight:600}" +
      ".muted{color:#A6B3BA;font-size:.85rem}.tw{overflow-x:auto;border:1px solid rgba(255,255,255,.09);border-radius:12px}" +
      "table{border-collapse:collapse;width:100%;min-width:680px;font-size:.86rem}" +
      "th,td{text-align:left;padding:.55rem .7rem;border-bottom:1px solid rgba(255,255,255,.09);vertical-align:top}" +
      "th{font-size:.72rem;letter-spacing:.06em;text-transform:uppercase;color:#A6B3BA}tr:last-child td{border-bottom:0}" +
      "small{color:#A6B3BA}a.open{display:inline-block;margin:1.4rem 0;padding:.6rem 1.3rem;border-radius:10px;background:#7FA9B0;color:#08232b;font-weight:700;text-decoration:none}" +
      "footer{margin-top:2rem;color:#A6B3BA;font-size:.78rem}" +
      "</style></head><body><main>" +
      "<h1>YS Capital Group — Borrower Track Record</h1>" +
      "<p class=\"muted\">" + escH(snap.borrower || "") + (snap.borrower ? " · " : "") + "saved " + escH(when) + "</p>" +
      "<div class=\"sum\">" +
      "<span class=\"chip\">" + counts.total + " deal" + (counts.total === 1 ? "" : "s") + "</span>" +
      "<span class=\"chip\">" + counts.flips + " fix &amp; flip</span>" +
      "<span class=\"chip\">" + counts.holds + " fix &amp; hold</span>" +
      (counts.ground ? "<span class=\"chip\">" + counts.ground + " ground-up</span>" : "") +
      "</div>" +
      section("Fix & Flip", flips) + section("Fix & Hold", holds) + section("Ground-up", ground) +
      "<a class=\"open\" href=\"" + escH(openUrl) + "\">Open in the live Track Record builder →</a>" +
      "<p class=\"muted\">This is the saved static copy of the live track record — it reopens the builder with these exact deals. The portal keeps it in sync automatically.</p>" +
      "<footer>YS Capital Group · NMLS ID 2609746 · For verification and underwriting reference.</footer>" +
      "</main></body></html>";
  }
  function snapshotUrl() {
    return staffMode
      ? "/api/staff/borrowers/" + staffBorrowerId + "/track-record/snapshot"
      : "/api/borrower/track-record/snapshot";
  }
  function snapshotName() {
    var who = String(displayName || "Borrower").replace(/[^\w]+/g, "_").replace(/^_|_$/g, "").slice(0, 40);
    return "Track_Record_" + (who || "Borrower") + "_" + new Date().toISOString().slice(0, 10) + ".html";
  }
  var snapT = null, lastSnapKey = null, snapReady = false;
  function scheduleSnapshot() {
    clearTimeout(snapT);
    snapT = setTimeout(pushSnapshot, 2500);
  }
  async function pushSnapshot() {
    if (!loaded || !snapReady) return;
    try {
      var key = JSON.stringify(TR.snap());
      if (key === lastSnapKey) return;
      await api("PUT", snapshotUrl(), { html: snapshotHtml(), filename: snapshotName() });
      lastSnapKey = key;
    } catch (e) { /* best-effort — the next change tries again */ }
  }
  // Opening the tool shouldn't re-save an unchanged copy: if the server already
  // holds one, the current state is the baseline and only a real change pushes.
  function seedSnapshotBaseline() {
    return api("GET", snapshotUrl()).then(function (existing) {
      if (existing && existing.documentId) lastSnapKey = JSON.stringify(TR.snap());
      snapReady = true;
      scheduleSnapshot();
    }).catch(function () { snapReady = true; scheduleSnapshot(); });
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
      // Inline documents strip (owner-directed 2026-07-13): upload DIRECTLY on
      // the line item — file picker + drag-and-drop on the card, no popup and
      // no separate page. Uploaded documents render as chips right on the card.
      var main = card.querySelector(".tr-card-main");
      if (main && !main.querySelector(".tr-docstrip")) renderDocStrip(card, main, p);
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
          var prev = p.status || "pending";
          var wasVerified = prev === "verified" || prev === "limited";
          var nowCounts = sel.value === "verified" || sel.value === "limited";
          var body = { status: sel.value };
          // Revoking a verified project reopens the borrower's experience and
          // notifies them — so it requires a reason (mirrors the LLC revoke).
          if (wasVerified && !nowCounts) {
            var reason = window.prompt("Revoke this project's verification. The borrower is notified with this reason:");
            if (reason == null) { sel.value = prev; return; }       // cancelled
            if (!reason.trim()) { flash("A reason is required to revoke verification."); sel.value = prev; return; }
            body.reason = reason.trim();
          }
          api("POST", recordUrl(p.id) + "/verify", body)
            .then(function () { flash("Verification updated — " + STATUS_LABEL[sel.value] + "."); return reload(); })
            .catch(function (e) { flash(e.message || "Could not update verification"); sel.value = prev; });
        };
        actions.appendChild(sel);
      }
    });
  };

  /* ---- inline documents strip per track-record entry ----
     Replaces the old popup overlay (owner-directed 2026-07-13): the borrower
     (and staff) upload supporting documents DIRECTLY on the line item — click
     "Add document" or drop files anywhere on the card. Uploaded docs show as
     chips (click to download); open back-office document requests show as an
     amber banner that clears once the document arrives. */
  function escA(s) { return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;"); }
  function downloadDoc(id, fn) {
    fetch(downloadUrl(id), { headers: { Authorization: "Bearer " + token } })
      .then(function (r) { if (!r.ok) throw new Error("Download failed"); return r.blob(); })
      .then(function (blob) {
        var a = document.createElement("a");
        a.href = URL.createObjectURL(blob); a.download = fn || "document";
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(function () { URL.revokeObjectURL(a.href); }, 1500);
      }).catch(function (e) { flash(e.message); });
  }
  function uploadFilesToRecord(p, files, done) {
    var list = Array.prototype.slice.call(files || []).filter(Boolean);
    if (!list.length) { if (done) done(); return; }
    var i = 0, okCount = 0;
    function next() {
      if (i >= list.length) {
        if (okCount) flash(okCount === 1 ? ('Uploaded "' + list[0].name + '" to this deal.') : ("Uploaded " + okCount + " documents to this deal."));
        // Pull the server truth (doc chips, request status, counts) once per batch.
        reload().catch(function () {}).then(function () { if (done) done(); });
        return;
      }
      var file = list[i++];
      var r = new FileReader();
      r.onload = function () {
        var s = String(r.result);
        api("POST", docsUrl(p.id), {
          filename: file.name, contentType: file.type || "application/octet-stream",
          dataBase64: s.slice(s.indexOf(",") + 1),
        }).then(function () { okCount++; next(); })
          .catch(function (e) { flash(e.message || ('Upload failed — "' + file.name + '"')); next(); });
      };
      r.onerror = function () { flash('Could not read "' + file.name + '"'); next(); };
      r.readAsDataURL(file);
    }
    next();
  }
  function renderDocStrip(card, main, p) {
    var strip = document.createElement("div");
    strip.className = "tr-docstrip";
    var reqs = (p._requests || []).filter(function (rq) { return rq && rq.status !== "satisfied" && rq.status !== "received"; });
    var docs = p._docs || [];
    var html = '<div class="tr-docstrip-h"><span class="tr-docstrip-l">Documents</span>' +
      '<button type="button" class="tr-doc-add" title="Closing statement, deed, lease… — or drag files onto this card">+ Add document</button>' +
      '<span style="font-size:.72rem;color:var(--muted-2)">or drag &amp; drop onto the card</span></div>';
    reqs.forEach(function (rq) {
      html += '<div class="tr-doc-req">⚠ Requested by your loan team: ' + escA(rq.label || "a document") + '</div>';
    });
    if (docs.length) {
      html += '<div class="tr-doc-chips">' + docs.map(function (d) {
        var st = d.review_status === "accepted" ? "accepted" : (d.review_status === "rejected" ? "rejected" : "pending");
        return '<button type="button" class="tr-doc-chip ' + st + '" data-dl="' + escA(d.id) + '" data-fn="' + escA(d.filename) + '" title="' +
          (st === "rejected" ? "Rejected — please replace this document. " : (st === "accepted" ? "Accepted. " : "")) + 'Click to download">' +
          '<span class="st"></span><span class="fn">' + escA(d.filename) + '</span></button>';
      }).join("") + '</div>';
    }
    strip.innerHTML = html;
    var input = document.createElement("input");
    input.type = "file"; input.multiple = true; input.style.display = "none";
    strip.appendChild(input);
    var addBtn = strip.querySelector(".tr-doc-add");
    addBtn.onclick = function () { input.click(); };
    input.onchange = function () {
      addBtn.classList.add("busy"); addBtn.textContent = "Uploading…";
      uploadFilesToRecord(p, input.files, function () { addBtn.classList.remove("busy"); addBtn.textContent = "+ Add document"; });
      input.value = "";
    };
    strip.querySelectorAll("[data-dl]").forEach(function (b) {
      b.onclick = function () { downloadDoc(b.dataset.dl, b.dataset.fn); };
    });
    // Drag & drop anywhere on the card.
    if (!card._trDnd) {
      card._trDnd = true;
      ["dragenter", "dragover"].forEach(function (ev) {
        card.addEventListener(ev, function (e) { e.preventDefault(); e.stopPropagation(); card.classList.add("tr-dropping"); });
      });
      ["dragleave", "drop"].forEach(function (ev) {
        card.addEventListener(ev, function (e) { e.preventDefault(); e.stopPropagation(); card.classList.remove("tr-dropping"); });
      });
      card.addEventListener("drop", function (e) {
        if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) uploadFilesToRecord(p, e.dataTransfer.files);
      });
    }
    main.appendChild(strip);
  }

  /* ---- chrome for portal / embed mode ---- */
  function styleForPortal() {
    var css = "";
    // The portal frame already says where you are — in embed mode drop the
    // marketing hero (eyebrow + intro paragraph) too, so the tool starts at
    // the top. Matters most on phones, where the hero filled the screen.
    if (embed) css += ".topbar,.suite-footer,.fa-wrap,.float-actions{display:none!important}main{padding-top:0}" +
      ".tr-hero .eyebrow,.tr-hero>p{display:none!important}" +
      ".tr-hero{padding-top:1.2rem;padding-bottom:.6rem}.tr-hero h1{font-size:1.6rem}";
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
      return seedSnapshotBaseline();
    }).then(function () {
      flash("Connected — your track record saves automatically.");
    }).catch(function (e) {
      flash((e && e.message) || "Couldn't load the track record.");
    });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
