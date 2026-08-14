/* ── Theme Toggle ── */
window._getChartTheme = function () {
  var light = document.documentElement.getAttribute("data-theme") === "light";
  return light
    ? { bg: "#ffffff", text: "#57606a", grid: "#eaeef2", border: "#d0d7de" }
    : { bg: "#0d1117", text: "#8b949e", grid: "#21262d", border: "#30363d" };
};

(function () {
  function applyTheme(theme) {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("app_theme", theme);
    document.querySelectorAll(".theme-opt").forEach(function (b) {
      b.classList.toggle("active", b.dataset.themeOpt === theme);
    });
    if (window._chartApplyTheme) window._chartApplyTheme();
    if (window._pairDetailApplyTheme) window._pairDetailApplyTheme();
    if (window._optionStrategyApplyTheme) window._optionStrategyApplyTheme();
    if (window._openInterestApplyTheme) window._openInterestApplyTheme();
    if (window._gammaExposureApplyTheme) window._gammaExposureApplyTheme();
  }
  document.querySelectorAll(".theme-opt").forEach(function (btn) {
    btn.addEventListener("click", function () { applyTheme(btn.dataset.themeOpt); });
  });
  applyTheme(localStorage.getItem("app_theme") === "light" ? "light" : "dark");
})();

/* ── Sidebar Toggle ── */
document.getElementById("sidebar-toggle").addEventListener("click", () => {
  document.getElementById("sidebar").classList.toggle("collapsed");
  if (typeof window._chartResize === "function") window._chartResize();
  window.dispatchEvent(new Event("resize"));
});

/* ── Page Navigation ── */
function syncOptionAnalysisNav(pageId) {
  var accordion = document.querySelector(".nav-accordion");
  var parent = document.getElementById("nav-option-analysis");
  if (!accordion || !parent) return;
  var optionPages = ["option-chain", "open-interest", "gamma-exposure", "option-strategy"];
  var isOption = optionPages.indexOf(pageId) !== -1;
  accordion.classList.toggle("open", isOption);
  parent.setAttribute("aria-expanded", isOption ? "true" : "false");
}

document.querySelectorAll(".nav-item[data-page]").forEach(link => {
  link.addEventListener("click", e => {
    e.preventDefault();
    var leavingHome = document.getElementById("page-home") && document.getElementById("page-home").classList.contains("active");
    if (leavingHome && link.dataset.page !== "home" && typeof window._chartOnHomeHidden === "function") {
      window._chartOnHomeHidden();
    }
    document.querySelectorAll(".nav-item").forEach(l => l.classList.remove("active"));
    link.classList.add("active");
    document.querySelectorAll(".page").forEach(p => p.classList.remove("active"));
    const page = document.getElementById("page-" + link.dataset.page);
    if (page) page.classList.add("active");
    syncOptionAnalysisNav(link.dataset.page);

    // Initialize Option Strategy Builder when that page is activated
    if (link.dataset.page === "option-strategy" && typeof window.initOptionStrategy === 'function') {
      window.initOptionStrategy();
    }
    if (link.dataset.page === "home" && typeof window._chartOnHomeShown === "function") {
      window._chartOnHomeShown();
    }
  });
});

(function () {
  var parent = document.getElementById("nav-option-analysis");
  var accordion = document.querySelector(".nav-accordion");
  if (!parent || !accordion) return;
  parent.addEventListener("click", function () {
    var open = accordion.classList.toggle("open");
    parent.setAttribute("aria-expanded", open ? "true" : "false");
  });
})();

// Initialize Option Strategy Builder on page load if it's the active page
document.addEventListener('DOMContentLoaded', function() {
  const activePage = document.querySelector('.page.active');
  if (activePage && activePage.id === 'page-option-strategy' && typeof window.initOptionStrategy === 'function') {
    window.initOptionStrategy();
  }
});

/* ── Broker Connect Module ── */
(function () {

  function showMsg(elId, msg, isError) {
    const el = document.getElementById(elId);
    if (!el) return;
    el.textContent = msg;
    el.className = "message-box " + (isError ? "error" : "success");
    el.classList.remove("hidden");
    setTimeout(() => el.classList.add("hidden"), 6000);
  }

  function setStatus(elId, connected) {
    const el = document.getElementById(elId);
    if (!el) return;
    el.innerHTML = connected
      ? '<span class="badge connected">\u25cf Connected</span>'
      : '<span class="badge disconnected">\u25cf Disconnected</span>';
  }

  // Show/hide password fields
  document.querySelectorAll(".btn-mask[data-target]").forEach(btn => {
    btn.addEventListener("click", () => {
      const inp = document.getElementById(btn.dataset.target);
      if (!inp) return;
      inp.type = inp.type === "password" ? "text" : "password";
      btn.textContent = inp.type === "password" ? "\ud83d\udc41" : "\ud83d\ude48";
    });
  });

  // Broker panel tabs on Connect page
  document.querySelectorAll(".tab-btn[data-broker]").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      document.querySelectorAll(".broker-panel").forEach(p => p.classList.add("hidden"));
      const panel = document.getElementById("panel-" + btn.dataset.broker);
      if (panel) panel.classList.remove("hidden");
    });
  });

  var _nativeIntervals = {
    dhan: [{id:"1",label:"1m"},{id:"5",label:"5m"},{id:"15",label:"15m"},{id:"25",label:"25m"},{id:"60",label:"1h"},{id:"D",label:"1D"}],
    "5paisa": [{id:"1",label:"1m"},{id:"5",label:"5m"},{id:"15",label:"15m"},{id:"25",label:"30m"},{id:"60",label:"1h"},{id:"D",label:"1D"}],
    yahoo: [{id:"1",label:"1m"},{id:"5",label:"5m"},{id:"15",label:"15m"},{id:"25",label:"30m"},{id:"60",label:"1h"},{id:"90",label:"90m"},{id:"D",label:"1D"},{id:"W",label:"1W"},{id:"M",label:"1M"},{id:"Q",label:"1Q"}]
  };
  var _resampleOptions = [
    {id:"", label:"Native"},
    {id:"W", label:"Weekly"},
    {id:"M", label:"Monthly"},
    {id:"Q", label:"Quarterly"},
    {id:"Y", label:"Yearly"}
  ];
  var _intervalDraft = { dhan: [], "5paisa": [], yahoo: [] };

  function optionHtml(list, selected) {
    return list.map(function (o) {
      var sel = String(o.id) === String(selected) ? " selected" : "";
      return "<option value=\"" + o.id + "\"" + sel + ">" + o.label + "</option>";
    }).join("");
  }

  function renderIntervalTable(broker) {
    var box = document.querySelector('.ti-config[data-broker="' + broker + '"] .ti-table-wrap');
    if (!box) return;
    var natives = _nativeIntervals[broker] || [];
    var rows = _intervalDraft[broker] || [];
    var html = "<table class=\"ti-table\"><thead><tr>" +
      "<th>Label</th><th>TimeInterval</th><th>Combine as</th><th>Days</th><th>On</th><th></th>" +
      "</tr></thead><tbody>";
    rows.forEach(function (row, idx) {
      html += "<tr data-idx=\"" + idx + "\">" +
        "<td class=\"ti-label\"><input type=\"text\" data-field=\"label\" value=\"" + (row.label || "").replace(/"/g, "&quot;") + "\" maxlength=\"16\" /></td>" +
        "<td><select data-field=\"source\">" + optionHtml(natives, row.source) + "</select></td>" +
        "<td><select data-field=\"resample\">" + optionHtml(_resampleOptions, row.resample || "") + "</select></td>" +
        "<td class=\"ti-days\"><input type=\"number\" data-field=\"days\" min=\"1\" max=\"7300\" step=\"1\" value=\"" + (row.days || 30) + "\" /></td>" +
        "<td class=\"ti-on\"><input type=\"checkbox\" data-field=\"enabled\"" + (row.enabled === false ? "" : " checked") + " /></td>" +
        "<td class=\"ti-del\"><button type=\"button\" class=\"ti-del-btn\" title=\"Remove\">&times;</button></td>" +
        "</tr>";
    });
    html += "</tbody></table>";
    box.innerHTML = html;
  }

  function collectIntervalRows(broker) {
    var box = document.querySelector('.ti-config[data-broker="' + broker + '"] .ti-table-wrap');
    var rows = [];
    if (!box) return rows;
    box.querySelectorAll("tbody tr").forEach(function (tr) {
      var idx = parseInt(tr.dataset.idx, 10);
      var prev = (_intervalDraft[broker] || [])[idx] || {};
      rows.push({
        id: prev.id || "",
        label: (tr.querySelector('[data-field="label"]') || {}).value || "",
        source: (tr.querySelector('[data-field="source"]') || {}).value || "",
        resample: (tr.querySelector('[data-field="resample"]') || {}).value || "",
        days: parseInt((tr.querySelector('[data-field="days"]') || {}).value, 10) || 30,
        enabled: !!(tr.querySelector('[data-field="enabled"]') || {}).checked
      });
    });
    _intervalDraft[broker] = rows;
    return rows;
  }

  function renderAllIntervalEditors(data) {
    if (data && data.broker_native_intervals) {
      _nativeIntervals = data.broker_native_intervals;
    }
    if (data && data.interval_resample_options) {
      _resampleOptions = data.interval_resample_options;
    }
    var all = (data && data.broker_intervals) || {};
    ["dhan", "5paisa", "yahoo"].forEach(function (broker) {
      _intervalDraft[broker] = (all[broker] || []).map(function (r) { return Object.assign({}, r); });
      renderIntervalTable(broker);
    });
  }

  document.querySelectorAll(".ti-config").forEach(function (wrap) {
    var broker = wrap.dataset.broker;
    var toggle = wrap.querySelector(".ti-config-toggle");
    var body = wrap.querySelector(".ti-config-body");
    var chevron = wrap.querySelector(".ta-collapse-btn");
    if (toggle && body) {
      toggle.addEventListener("click", function () {
        body.classList.toggle("hidden");
        if (chevron) chevron.classList.toggle("open", !body.classList.contains("hidden"));
      });
    }
    wrap.addEventListener("click", function (e) {
      var del = e.target.closest(".ti-del-btn");
      if (del) {
        collectIntervalRows(broker);
        var tr = del.closest("tr");
        var idx = tr ? parseInt(tr.dataset.idx, 10) : -1;
        if (idx >= 0) _intervalDraft[broker].splice(idx, 1);
        if (!_intervalDraft[broker].length) {
          _intervalDraft[broker].push({ id: "D", label: "1D", source: "D", resample: "", days: 1825, enabled: true });
        }
        renderIntervalTable(broker);
        return;
      }
      if (e.target.closest(".ti-add-btn")) {
        collectIntervalRows(broker);
        _intervalDraft[broker].push({
          id: "",
          label: "Weekly",
          source: "D",
          resample: "W",
          days: 1825,
          enabled: true
        });
        renderIntervalTable(broker);
        return;
      }
      if (e.target.closest(".ti-save-btn")) {
        var rows = collectIntervalRows(broker);
        var msgEl = wrap.querySelector(".ti-msg");
        fetch("/api/settings/intervals", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ broker: broker, intervals: rows })
        }).then(function (res) { return res.json(); }).then(function (data) {
          if (!data.success) throw new Error(data.message || "Save failed.");
          _intervalDraft[broker] = data.intervals || rows;
          renderIntervalTable(broker);
          if (window._chartSetBrokerIntervals) {
            window._chartSetBrokerIntervals(data.broker_intervals || {});
          }
          if (msgEl) {
            msgEl.textContent = "TimeInterval settings saved.";
            msgEl.className = "message-box success ti-msg";
            msgEl.classList.remove("hidden");
            setTimeout(function () { msgEl.classList.add("hidden"); }, 2500);
          }
        }).catch(function (err) {
          if (msgEl) {
            msgEl.textContent = err.message || "Save failed.";
            msgEl.className = "message-box error ti-msg";
            msgEl.classList.remove("hidden");
          }
        });
      }
    });
    wrap.addEventListener("change", function () {
      collectIntervalRows(broker);
    });
  });

  // ── DHAN ──────────────────────────────────────────────────────────────────

  let totpTimer = null;

  function startTotpTimer(remaining) {
    clearInterval(totpTimer);
    const timerEl = document.getElementById("totp-timer");
    let secs = remaining;
    if (timerEl) timerEl.textContent = secs + "s";
    totpTimer = setInterval(() => {
      secs--;
      if (timerEl) timerEl.textContent = secs + "s";
      if (secs <= 0) { clearInterval(totpTimer); refreshTotp(); }
    }, 1000);
  }

  async function refreshTotp() {
    try {
      const res  = await fetch("/api/dhan/generate-totp");
      const data = await res.json();
      if (data.success) {
        document.getElementById("totp-code").textContent = data.totp;
        document.getElementById("totp-display").classList.remove("hidden");
        startTotpTimer(data.remaining_seconds);
      } else {
        document.getElementById("totp-display").classList.add("hidden");
        showMsg("message-box", data.message, true);
      }
    } catch (e) { showMsg("message-box", "Error: " + e.message, true); }
  }

  const genTotpBtn = document.getElementById("gen-totp-btn");
  if (genTotpBtn) genTotpBtn.addEventListener("click", refreshTotp);

  const saveCredBtn = document.getElementById("save-cred-btn");
  if (saveCredBtn) saveCredBtn.addEventListener("click", async () => {
    const body = {
      client_id:    document.getElementById("client-id").value.trim(),
      access_token: document.getElementById("access-token").value.trim(),
      totp_secret:  document.getElementById("totp-secret").value.trim(),
    };
    const res  = await fetch("/api/dhan/save-credentials", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = await res.json();
    showMsg("message-box", data.message, !data.success);
  });

  let _dhanConnecting = false;
  async function connectDhan() {
    if (_dhanConnecting) return;
    _dhanConnecting = true;
    showMsg("message-box", "Connecting\u2026", false);
    try {
      const res  = await fetch("/api/dhan/connect", { method: "POST" });
      const data = await res.json();
      showMsg("message-box", data.message, !data.success);
      setStatus("dhan-status", data.success);
      if (window._chartSetConnected) window._chartSetConnected("dhan", data.success);
      if (data.success && data.user) {
        const u    = data.user;
        const grid = document.getElementById("user-grid");
        if (grid) grid.innerHTML = [
          ["Client ID", u.client_id], ["Token Validity", u.token_validity],
          ["Active Segments", u.active_segment], ["Available Balance", "\u20b9 " + u.available_balance],
          ["Utilized Amount", "\u20b9 " + u.utilized_amount], ["Withdrawable", "\u20b9 " + u.withdrawable],
          ["Collateral", "\u20b9 " + u.collateral],
        ].filter(r => r[1]).map(r =>
          `<div class="info-item"><span class="info-label">${r[0]}</span><span class="info-value">${r[1]}</span></div>`
        ).join("");
        const sec = document.getElementById("user-info-section");
        if (sec) sec.style.display = "";
      }
    } catch (e) {
      showMsg("message-box", "Error: " + e.message, true);
    } finally {
      _dhanConnecting = false;
    }
  }
  const connectBtn = document.getElementById("connect-btn");
  if (connectBtn) connectBtn.addEventListener("click", connectDhan);

  const disconnectBtn = document.getElementById("disconnect-btn");
  if (disconnectBtn) disconnectBtn.addEventListener("click", async () => {
    const res  = await fetch("/api/dhan/disconnect", { method: "POST" });
    const data = await res.json();
    showMsg("message-box", data.message, !data.success);
    setStatus("dhan-status", false);
    if (window._chartSetConnected) window._chartSetConnected("dhan", false);
    const sec = document.getElementById("user-info-section");
    if (sec) sec.style.display = "none";
  });

  // ── 5PAISA ────────────────────────────────────────────────────────────────

  let fpTotpTimer = null;

  function startFpTotpTimer(remaining) {
    clearInterval(fpTotpTimer);
    const timerEl = document.getElementById("fp-totp-timer");
    let secs = remaining;
    if (timerEl) timerEl.textContent = secs + "s";
    fpTotpTimer = setInterval(() => {
      secs--;
      if (timerEl) timerEl.textContent = secs + "s";
      if (secs <= 0) { clearInterval(fpTotpTimer); refreshFpTotp(); }
    }, 1000);
  }

  async function refreshFpTotp() {
    try {
      const res  = await fetch("/api/5paisa/generate-totp");
      const data = await res.json();
      if (data.success) {
        document.getElementById("fp-totp-code").textContent = data.totp;
        document.getElementById("fp-totp-display").classList.remove("hidden");
        startFpTotpTimer(data.remaining_seconds);
      } else {
        document.getElementById("fp-totp-display").classList.add("hidden");
        showMsg("fp-message-box", data.message, true);
      }
    } catch (e) { showMsg("fp-message-box", "Error: " + e.message, true); }
  }

  const fpGenTotpBtn = document.getElementById("fp-gen-totp-btn");
  if (fpGenTotpBtn) fpGenTotpBtn.addEventListener("click", refreshFpTotp);

  const fpSaveCredBtn = document.getElementById("fp-save-cred-btn");
  if (fpSaveCredBtn) fpSaveCredBtn.addEventListener("click", async () => {
    const body = {
      email:          document.getElementById("fp-email").value.trim(),
      client_code:    document.getElementById("fp-client-code").value.trim(),
      pin:            document.getElementById("fp-pin").value.trim(),
      user_id:        document.getElementById("fp-user-id").value.trim(),
      user_key:       document.getElementById("fp-user-key").value.trim(),
      encryption_key: document.getElementById("fp-encryption-key").value.trim(),
      totp_secret:    document.getElementById("fp-totp-secret").value.trim(),
      access_token:   document.getElementById("fp-access-token").value.trim(),
    };
    const res  = await fetch("/api/5paisa/save-credentials", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = await res.json();
    showMsg("fp-message-box", data.message, !data.success);
  });

  let _fpConnecting = false;
  async function connect5Paisa() {
    if (_fpConnecting) return;
    _fpConnecting = true;
    showMsg("fp-message-box", "Connecting\u2026", false);
    try {
      const res  = await fetch("/api/5paisa/connect", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) });
      const data = await res.json();
      showMsg("fp-message-box", data.message, !data.success);
      setStatus("5paisa-status", data.success);
      if (window._chartSetConnected) window._chartSetConnected("5paisa", data.success);
      if (data.success && data.user) {
        const u    = data.user;
        const grid = document.getElementById("fp-user-grid");
        if (grid) grid.innerHTML = [
          ["Client Code", u.client_code],
          ["Net Available Margin", "\u20b9 " + u.net_available],
          ["Margin Utilized", "\u20b9 " + u.utilized_margin],
          ["Collateral", "\u20b9 " + u.collateral],
          ["Adhoc Margin", "\u20b9 " + u.adhoc_margin],
          ["Pay-in Amount", "\u20b9 " + u.payin_amount],
          ["Pay-out Amount", "\u20b9 " + u.payout_amount],
        ].filter(r => r[1] && r[1] !== "\u20b9 ").map(r =>
          `<div class="info-item"><span class="info-label">${r[0]}</span><span class="info-value">${r[1]}</span></div>`
        ).join("");
        const sec = document.getElementById("fp-user-info-section");
        if (sec) sec.style.display = "";
        if (data.token_expiry) showMsg("fp-message-box", "Connected. Token expires: " + data.token_expiry, false);
      }
    } catch (e) {
      showMsg("fp-message-box", "Error: " + e.message, true);
    } finally {
      _fpConnecting = false;
    }
  }
  const fpConnectBtn = document.getElementById("fp-connect-btn");
  if (fpConnectBtn) fpConnectBtn.addEventListener("click", connect5Paisa);

  const fpDisconnectBtn = document.getElementById("fp-disconnect-btn");
  if (fpDisconnectBtn) fpDisconnectBtn.addEventListener("click", async () => {
    const res  = await fetch("/api/5paisa/disconnect", { method: "POST" });
    const data = await res.json();
    showMsg("fp-message-box", data.message, !data.success);
    setStatus("5paisa-status", false);
    if (window._chartSetConnected) window._chartSetConnected("5paisa", false);
    const sec = document.getElementById("fp-user-info-section");
    if (sec) sec.style.display = "none";
  });

  // ── YAHOO FINANCE ─────────────────────────────────────────────────────────

  async function connectYahoo() {
    showMsg("yahoo-message-box", "Connecting\u2026", false);
    try {
      const urlInp = document.getElementById("yahoo-base-url");
      const baseUrl = urlInp ? urlInp.value.trim() : "";
      if (baseUrl) {
        const saveRes = await fetch("/api/yahoo/save", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ base_url: baseUrl }),
        });
        const saveData = await saveRes.json();
        if (!saveData.success) {
          showMsg("yahoo-message-box", saveData.message, true);
          return;
        }
      }
      const res = await fetch("/api/yahoo/connect", { method: "POST" });
      const data = await res.json();
      showMsg("yahoo-message-box", data.message, !data.success);
      setStatus("yahoo-status", data.success);
      if (window._chartSetConnected) window._chartSetConnected("yahoo", data.success);
    } catch (e) {
      showMsg("yahoo-message-box", "Error: " + e.message, true);
    }
  }
  const yahooSaveBtn = document.getElementById("yahoo-save-btn");
  if (yahooSaveBtn) yahooSaveBtn.addEventListener("click", async () => {
    const urlInp = document.getElementById("yahoo-base-url");
    const res = await fetch("/api/yahoo/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ base_url: urlInp ? urlInp.value.trim() : "" }),
    });
    const data = await res.json();
    showMsg("yahoo-message-box", data.message, !data.success);
  });
  const yahooConnectBtn = document.getElementById("yahoo-connect-btn");
  if (yahooConnectBtn) yahooConnectBtn.addEventListener("click", connectYahoo);

  async function connectExcel() {
    showMsg("excel-message-box", "Connecting\u2026", false);
    try {
      const res = await fetch("/api/excel/connect", { method: "POST" });
      const data = await res.json();
      showMsg("excel-message-box", data.message, !data.success);
      setStatus("excel-status", data.success);
      if (window._chartSetConnected) window._chartSetConnected("excel", data.success);
    } catch (e) {
      showMsg("excel-message-box", "Error: " + e.message, true);
    }
  }
  const excelConnectBtn = document.getElementById("excel-connect-btn");
  if (excelConnectBtn) excelConnectBtn.addEventListener("click", connectExcel);

  window._connectBroker = { dhan: connectDhan, "5paisa": connect5Paisa, yahoo: connectYahoo, excel: connectExcel };

  (function excelConfigUi() {
    var configs = [];
    var headers = [];
    var mapping = { date: "", open: "", high: "", low: "", close: "", volume: "" };
    var indicators = [];
    var selectedId = "";
    var skipSheetChange = false;

    function el(id) { return document.getElementById(id); }
    function showExcelMsg(text, err) { showMsg("excel-message-box", text, !!err); }

    function fillSelect(sel, values, current) {
      if (!sel) return;
      var opts = ['<option value="">Select\u2026</option>'];
      (values || []).forEach(function (v) {
        var s = String(v);
        opts.push('<option value="' + s.replace(/"/g, "&quot;") + '"' + (s === current ? " selected" : "") + ">" + s.replace(/</g, "&lt;") + "</option>");
      });
      sel.innerHTML = opts.join("");
      if (current) sel.value = current;
    }

    function renderList() {
      var list = el("excel-config-list");
      if (!list) return;
      if (!configs.length) {
        list.innerHTML = '<li class="excel-config-empty">No saved configs yet</li>';
        return;
      }
      list.innerHTML = configs.map(function (c) {
        var on = c.id === selectedId ? " active" : "";
        var meta = ((c.workbook || "") + (c.sheet ? " \u00b7 " + c.sheet : "")).replace(/</g, "&lt;");
        return '<li data-id="' + c.id + '" class="' + on.trim() + '">' +
          String(c.name || "").replace(/</g, "&lt;") +
          (meta ? "<small>" + meta + "</small>" : "") +
          "</li>";
      }).join("");
    }

    function renderMap() {
      var table = el("excel-map-table");
      if (!table) return;
      var ohlc = [
        { key: "date", label: "Date" },
        { key: "open", label: "Open" },
        { key: "high", label: "High" },
        { key: "low", label: "Low" },
        { key: "close", label: "Close" },
        { key: "volume", label: "Volume (optional)" }
      ];
      function headerOpts(selected) {
        var html = '<option value="">Select column\u2026</option>';
        headers.forEach(function (h) {
          html += '<option value="' + String(h).replace(/"/g, "&quot;") + '"' +
            (h === selected ? " selected" : "") + ">" + String(h).replace(/</g, "&lt;") + "</option>";
        });
        return html;
      }
      var html = '<div class="excel-map-core">';
      ohlc.forEach(function (f) {
        html += '<div class="excel-map-row"><label>' + f.label + '</label>' +
          '<select data-map="' + f.key + '">' + headerOpts(mapping[f.key] || "") + "</select></div>";
      });
      html += "</div>";
      if (indicators.length) {
        html += '<div class="excel-map-title excel-map-title-sub">Indicator columns</div><div class="excel-ind-rows">';
        indicators.forEach(function (ind, idx) {
          html += '<div class="excel-ind-row">' +
            '<input type="text" data-ind-name="' + idx + '" value="' +
            String(ind.name || "").replace(/"/g, "&quot;") + '" placeholder="Name on chart" />' +
            '<select data-ind-col="' + idx + '">' + headerOpts(ind.column || "") + "</select>" +
            '<button type="button" class="excel-ind-del" data-ind-del="' + idx + '" title="Remove">\u00d7</button>' +
            "</div>";
        });
        html += "</div>";
      }
      table.innerHTML = html;
    }

    function readForm() {
      indicators.forEach(function (ind, idx) {
        var n = document.querySelector('[data-ind-name="' + idx + '"]');
        var c = document.querySelector('[data-ind-col="' + idx + '"]');
        if (n) ind.name = n.value.trim();
        if (c) ind.column = c.value;
      });
      document.querySelectorAll("[data-map]").forEach(function (sel) {
        mapping[sel.getAttribute("data-map")] = sel.value;
      });
      return {
        id: (el("excel-config-id") && el("excel-config-id").value) || selectedId || "",
        name: (el("excel-config-name") && el("excel-config-name").value.trim()) || "",
        workbook: (el("excel-workbook") && el("excel-workbook").value) || "",
        sheet: (el("excel-sheet") && el("excel-sheet").value) || "",
        header_row: parseInt(el("excel-header-row") && el("excel-header-row").value, 10) || 0,
        poll_seconds: parseInt(el("excel-poll-seconds") && el("excel-poll-seconds").value, 10) || 5,
        mapping: Object.assign({}, mapping),
        indicators: indicators.map(function (x) { return { name: x.name, column: x.column }; })
      };
    }

    function applyConfig(cfg) {
      cfg = cfg || {};
      selectedId = cfg.id || "";
      if (el("excel-config-id")) el("excel-config-id").value = selectedId;
      if (el("excel-config-name")) el("excel-config-name").value = cfg.name || "";
      if (el("excel-poll-seconds")) el("excel-poll-seconds").value = cfg.poll_seconds || 5;
      if (el("excel-header-row")) el("excel-header-row").value = cfg.header_row || "";
      mapping = Object.assign({ date: "", open: "", high: "", low: "", close: "", volume: "" }, cfg.mapping || {});
      indicators = (cfg.indicators || []).map(function (x) {
        return { name: x.name || "", column: x.column || "" };
      });
      renderList();
      renderMap();
    }

    function blankConfig() {
      applyConfig({
        id: "",
        name: "",
        poll_seconds: 5,
        header_row: "",
        mapping: { date: "", open: "", high: "", low: "", close: "", volume: "" },
        indicators: []
      });
      headers = [];
      renderMap();
    }

    async function loadConfigs() {
      try {
        var res = await fetch("/api/excel/configs");
        var data = await res.json();
        configs = data.configs || [];
        renderList();
        if (selectedId) {
          var found = configs.filter(function (c) { return c.id === selectedId; })[0];
          if (found) applyConfig(found);
        }
      } catch (_) {}
    }

    async function refreshWorkbooks(keep, silent) {
      keep = keep || (el("excel-workbook") && el("excel-workbook").value) || "";
      try {
        var res = await fetch("/api/excel/workbooks");
        var data = await res.json();
        if (!data.success) {
          fillSelect(el("excel-workbook"), keep ? [keep] : [], keep);
          if (!silent) showExcelMsg(data.message || "Could not list Excel files.", true);
          return;
        }
        fillSelect(el("excel-workbook"), data.workbooks || [], keep);
      } catch (e) {
        if (!silent) showExcelMsg("Error: " + e.message, true);
      }
    }

    async function refreshSheets(keep) {
      var wb = el("excel-workbook") && el("excel-workbook").value;
      if (!wb) {
        fillSelect(el("excel-sheet"), [], "");
        return;
      }
      keep = keep || (el("excel-sheet") && el("excel-sheet").value) || "";
      try {
        var res = await fetch("/api/excel/sheets?workbook=" + encodeURIComponent(wb));
        var data = await res.json();
        if (!data.success) {
          fillSelect(el("excel-sheet"), keep ? [keep] : [], keep);
          showExcelMsg(data.message || "Could not list tabs.", true);
          return;
        }
        fillSelect(el("excel-sheet"), data.sheets || [], keep);
      } catch (e) {
        showExcelMsg("Error: " + e.message, true);
      }
    }

    async function runPreview(manualRow) {
      var wb = el("excel-workbook") && el("excel-workbook").value;
      var sh = el("excel-sheet") && el("excel-sheet").value;
      if (!wb || !sh) return;
      var body = { workbook: wb, sheet: sh };
      var row = manualRow != null ? manualRow : (parseInt(el("excel-header-row") && el("excel-header-row").value, 10) || 0);
      if (row) body.header_row = row;
      try {
        var res = await fetch("/api/excel/preview", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body)
        });
        var data = await res.json();
        if (!data.success) {
          showExcelMsg(data.message || "Preview failed.", true);
          return;
        }
        headers = data.headers || [];
        if (el("excel-header-row")) el("excel-header-row").value = data.header_row || "";
        if (!row) {
          mapping = Object.assign(mapping, data.mapping || {});
        }
        renderMap();
        showExcelMsg("Header row " + data.header_row + " \u2014 " + headers.length + " columns.", false);
      } catch (e) {
        showExcelMsg("Error: " + e.message, true);
      }
    }

    if (el("excel-refresh-files")) el("excel-refresh-files").addEventListener("click", function () {
      refreshWorkbooks();
    });
    if (el("excel-workbook")) el("excel-workbook").addEventListener("change", async function () {
      await refreshSheets("");
      if (el("excel-sheet") && el("excel-sheet").value) runPreview(0);
    });
    if (el("excel-sheet")) el("excel-sheet").addEventListener("change", function () {
      if (skipSheetChange) return;
      runPreview(0);
    });
    if (el("excel-header-row")) el("excel-header-row").addEventListener("change", function () {
      var row = parseInt(el("excel-header-row").value, 10) || 0;
      if (row) runPreview(row);
    });
    if (el("excel-detect-btn")) el("excel-detect-btn").addEventListener("click", function () {
      if (el("excel-header-row")) el("excel-header-row").value = "";
      runPreview(0);
    });
    if (el("excel-add-ind")) el("excel-add-ind").addEventListener("click", function () {
      var form = readForm();
      mapping = form.mapping;
      indicators = form.indicators;
      indicators.push({ name: "Indicator" + (indicators.length + 1), column: "" });
      renderMap();
    });
    var mapTable = el("excel-map-table");
    if (mapTable) mapTable.addEventListener("click", function (e) {
      var btn = e.target.closest("[data-ind-del]");
      if (!btn) return;
      var form = readForm();
      mapping = form.mapping;
      indicators = form.indicators;
      var idx = parseInt(btn.getAttribute("data-ind-del"), 10);
      if (idx >= 0) indicators.splice(idx, 1);
      renderMap();
    });
    if (el("excel-new-btn")) el("excel-new-btn").addEventListener("click", function () {
      blankConfig();
    });
    if (el("excel-config-list")) el("excel-config-list").addEventListener("click", async function (e) {
      var li = e.target.closest("li[data-id]");
      if (!li) return;
      var found = configs.filter(function (c) { return c.id === li.dataset.id; })[0];
      if (!found) return;
      applyConfig(found);
      skipSheetChange = true;
      await refreshWorkbooks(found.workbook);
      await refreshSheets(found.sheet);
      skipSheetChange = false;
      if (found.workbook && found.sheet) {
        await runPreview(found.header_row || 0);
        mapping = Object.assign(mapping, found.mapping || {});
        indicators = (found.indicators || []).map(function (x) {
          return { name: x.name || "", column: x.column || "" };
        });
        renderMap();
      }
    });
    if (el("excel-save-btn")) el("excel-save-btn").addEventListener("click", async function () {
      var cfg = readForm();
      if (!cfg.name) { showExcelMsg("Config Name is required.", true); return; }
      if (!cfg.workbook || !cfg.sheet) { showExcelMsg("Select an open Excel file and tab.", true); return; }
      try {
        var res = await fetch("/api/excel/configs", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ config: cfg })
        });
        var data = await res.json();
        if (!data.success) { showExcelMsg(data.message || "Save failed.", true); return; }
        configs = data.configs || [];
        var match = configs.filter(function (c) { return c.name === cfg.name; }).pop();
        selectedId = (match && match.id) || cfg.id;
        if (el("excel-config-id")) el("excel-config-id").value = selectedId;
        renderList();
        showExcelMsg("Config saved.", false);
      } catch (e) {
        showExcelMsg("Error: " + e.message, true);
      }
    });
    if (el("excel-delete-btn")) el("excel-delete-btn").addEventListener("click", async function () {
      var id = (el("excel-config-id") && el("excel-config-id").value) || selectedId;
      if (!id) { blankConfig(); return; }
      try {
        var res = await fetch("/api/excel/configs/" + encodeURIComponent(id), { method: "DELETE" });
        var data = await res.json();
        configs = data.configs || [];
        blankConfig();
        renderList();
        showExcelMsg("Config deleted.", false);
      } catch (e) {
        showExcelMsg("Error: " + e.message, true);
      }
    });

    renderMap();
    loadConfigs();
    refreshWorkbooks("", true);
  })();

})();

/* ── Settings Module ── */
(function () {

  // ── Broker visibility ──────────────────────────────────────────────────────

  function applyBrokerVisibility(broker, enabled) {
    window._brokerEnabled = window._brokerEnabled || {};
    window._brokerEnabled[broker] = !!enabled;
    var tab = document.querySelector('.tab-btn[data-broker="' + broker + '"]');
    if (tab) {
      tab.style.display = enabled ? '' : 'none';
      if (!enabled && tab.classList.contains('active')) {
        var others = document.querySelectorAll('.tab-btn[data-broker]');
        for (var i = 0; i < others.length; i++) {
          if (others[i] !== tab && others[i].style.display !== 'none') {
            others[i].click();
            break;
          }
        }
      }
    }
    if (!enabled) {
      var panel = document.getElementById('panel-' + broker);
      if (panel) panel.classList.add('hidden');
    }
    var cbtn = document.querySelector('.cbrok-btn[data-broker="' + broker + '"]');
    if (cbtn) cbtn.style.display = enabled ? '' : 'none';
    if (window._chartSetBrokerEnabled) window._chartSetBrokerEnabled(broker, enabled);
  }

  function applyOptionAnalysisVisibility() {
    var en = window._brokerEnabled || {};
    var yahooOnly = !en.dhan && !en['5paisa'] && (!!en.yahoo || !!en.excel);
    var acc = document.querySelector('.nav-accordion');
    if (acc) acc.classList.toggle('nav-disabled', yahooOnly);
    if (yahooOnly) {
      var optionPages = { 'option-chain': 1, 'open-interest': 1, 'gamma-exposure': 1, 'option-strategy': 1 };
      var active = document.querySelector('.page.active');
      var pageId = active && active.id ? active.id.replace(/^page-/, '') : '';
      if (optionPages[pageId]) {
        var home = document.querySelector('.nav-item[data-page="home"]');
        if (home) home.click();
      }
    }
  }

  var _autoConnectStarted = false;
  function autoConnectSingleBroker(data) {
    if (_autoConnectStarted || !window._connectBroker) return;
    var dhanOn = data.dhan_enabled !== false;
    var fpOn = data['5paisa_enabled'] !== false;
    var yahooOn = !!data.yahoo_enabled;
    var excelOn = !!data.excel_enabled;
    var connected = window._brokerConnected || {};
    var enabledCount = (dhanOn ? 1 : 0) + (fpOn ? 1 : 0) + (yahooOn ? 1 : 0) + (excelOn ? 1 : 0);
    if (yahooOn && !connected.yahoo && window._connectBroker.yahoo) {
      window._connectBroker.yahoo();
      if (enabledCount === 1) _autoConnectStarted = true;
    }
    if (excelOn && !connected.excel && window._connectBroker.excel) {
      window._connectBroker.excel();
      if (enabledCount === 1) _autoConnectStarted = true;
    }
    if (dhanOn && !fpOn && !yahooOn) {
      if (connected.dhan) return;
      _autoConnectStarted = true;
      window._connectBroker.dhan();
    } else if (fpOn && !dhanOn && !yahooOn) {
      if (connected['5paisa']) return;
      _autoConnectStarted = true;
      window._connectBroker['5paisa']();
    }
  }

  // ── Load settings on page open ─────────────────────────────────────────────

  async function loadSettings() {
    try {
      var res  = await fetch('/api/settings');
      var data = await res.json();
      var apiChk  = document.getElementById('setting-enable-api');
      var dhanChk = document.getElementById('setting-enable-dhan');
      var fpChk   = document.getElementById('setting-enable-5paisa');
      var yfChk   = document.getElementById('setting-enable-yahoo');
      var xlChk   = document.getElementById('setting-enable-excel');
      if (apiChk)  { apiChk.checked  = !!data.api_enabled;              toggleApiPanel(apiChk.checked); }
      if (dhanChk) { dhanChk.checked = data.dhan_enabled !== false;      applyBrokerVisibility('dhan',   dhanChk.checked); }
      if (fpChk)   { fpChk.checked   = data['5paisa_enabled'] !== false; applyBrokerVisibility('5paisa', fpChk.checked); }
      if (yfChk)   { yfChk.checked   = !!data.yahoo_enabled;            applyBrokerVisibility('yahoo',  yfChk.checked); }
      if (xlChk)   { xlChk.checked   = !!data.excel_enabled;            applyBrokerVisibility('excel',  xlChk.checked); }
      if (data.yahoo_base_url) {
        var yUrl = document.getElementById('yahoo-base-url');
        if (yUrl && !yUrl.value) yUrl.value = data.yahoo_base_url;
      }
      applyOptionAnalysisVisibility();
      var ri = document.getElementById('chart-refresh-interval');
      if (ri && data.chart_refresh_interval !== undefined) ri.value = data.chart_refresh_interval;
      if (window._chartSetRefreshInterval) window._chartSetRefreshInterval(data.chart_refresh_interval || 0);
      if (window._chartSetBrokerIntervals) {
        window._chartSetBrokerIntervals(data.broker_intervals || {});
      }
      renderAllIntervalEditors(data);
      autoConnectSingleBroker(data);
    } catch (_) {}
    loadTaSettings();

  // ── Chart auto-refresh interval ──────────────────────────────────────────

  var saveRefreshBtn = document.getElementById('btn-save-refresh-interval');
  if (saveRefreshBtn) saveRefreshBtn.addEventListener('click', async function() {
    var inp = document.getElementById('chart-refresh-interval');
    var ms  = Math.max(0, parseInt(inp ? inp.value : 0) || 0);
    if (inp) inp.value = ms;
    var msgEl = document.getElementById('refresh-interval-msg');
    try {
      await fetch('/api/settings/chart', {
        method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({chart_refresh_interval: ms}),
      });
      if (window._chartSetRefreshInterval) window._chartSetRefreshInterval(ms);
      if (msgEl) {
        msgEl.textContent = 'Saved! Refresh ' + (ms === 0 ? 'disabled.' : 'every ' + ms + 'ms.');
        msgEl.className = 'message-box success';
        msgEl.classList.remove('hidden');
        setTimeout(function() { msgEl.classList.add('hidden'); }, 3000);
      }
    } catch (e) {
      if (msgEl) {
        msgEl.textContent = 'Error: ' + e.message;
        msgEl.className = 'message-box error';
        msgEl.classList.remove('hidden');
      }
    }
  });

  document.querySelectorAll('.preset-btn').forEach(function(btn) {
    btn.addEventListener('click', function() {
      var ms = parseInt(btn.dataset.ms) || 0;
      var inp = document.getElementById('chart-refresh-interval');
      if (inp) inp.value = ms;
    });
  });

  }

  // ── API Access toggle ──────────────────────────────────────────────────────

  function toggleApiPanel(enabled) {
    var panel = document.getElementById('api-access-panel');
    if (!panel) return;
    if (enabled) { panel.classList.remove('hidden'); renderApiDocs(); }
    else panel.classList.add('hidden');
  }

  function renderApiDocs() {
    var list = document.getElementById('api-endpoint-list');
    if (!list || list.querySelector('.ep-card')) return;
    var base = window.location.origin;

    var endpoints = [
      {
        method: 'GET', path: '/public/api/status',
        desc: 'Server & connection status', params: [],
        example: '/public/api/status',
      },
      {
        method: 'GET', path: '/public/api/5paisa/search',
        desc: 'Search instruments by name or symbol',
        params: [
          { name: 'q',     req: true,  note: 'Search query e.g. RELIANCE' },
          { name: 'limit', req: false, note: 'Max results (default 10)' },
        ],
        example: '/public/api/5paisa/search?q=RELIANCE&limit=10',
      },
      {
        method: 'GET', path: '/public/api/5paisa/historical',
        desc: 'Historical OHLCV candles \u2014 single symbol',
        params: [
          { name: 'symbol',   req: true,  note: 'Trading symbol e.g. RELIANCE' },
          { name: 'interval', req: false, note: '1 | 5 | 15 | 25 | 60 | D  (default 15)' },
          { name: 'from',     req: false, note: 'YYYY-MM-DD (default 4 days ago)' },
          { name: 'to',       req: false, note: 'YYYY-MM-DD (default today)' },
          { name: 'v',        req: false, note: '1 = JSON (default) | 2 = pipe-delimited' },
          { name: 'TA',       req: false, note: 'true = append configured indicators' },
          { name: 'fields',   req: false, note: 'Comma-separated: D,O,H,L,C,V,T' },
        ],
        example: '/public/api/5paisa/historical?symbol=RELIANCE&interval=15&from=2026-07-01&to=2026-07-13&TA=true',
      },
      {
        method: 'GET', path: '/public/api/5paisa/historical',
        desc: 'Historical close prices \u2014 multiple symbols (aligned by datetime)',
        params: [
          { name: 'symbols',  req: true,  note: 'Comma-separated e.g. RELIANCE,TCS,INFY' },
          { name: 'interval', req: false, note: '1 | 5 | 15 | 25 | 60 | D  (default 15)' },
          { name: 'from',     req: false, note: 'YYYY-MM-DD' },
          { name: 'to',       req: false, note: 'YYYY-MM-DD' },
          { name: 'v',        req: false, note: '1 = JSON | 2 = pipe-delimited' },
        ],
        example: '/public/api/5paisa/historical?symbols=RELIANCE,TCS,INFY&interval=15&v=2',
      },
      {
        method: 'POST', path: '/public/api/5paisa/chart',
        desc: 'OHLCV candles by scrip_code (use when symbol is ambiguous)',
        params: [
          { name: 'scrip_code', req: true,  note: 'Numeric scrip code from search' },
          { name: 'exch',       req: true,  note: 'N = NSE | B = BSE' },
          { name: 'exch_type',  req: true,  note: 'C = Cash | D = Derivatives' },
          { name: 'interval',   req: false, note: '1 | 5 | 15 | 25 | 60 | D' },
          { name: 'from_date',  req: false, note: 'YYYY-MM-DD' },
          { name: 'to_date',    req: false, note: 'YYYY-MM-DD' },
        ],
        example: '{"scrip_code":500325,"exch":"N","exch_type":"C","interval":"15"}',
        isPost: true,
      },
    ];

    list.innerHTML = endpoints.map(function(ep, i) {
      var exUrl = ep.isPost
        ? '<div class="ep-example-label">Request body:</div><pre class="ep-example-body">' + ep.example + '</pre>'
        : '<div class="ep-example-wrap">'
            + '<span class="ep-example-label">Example:</span>'
            + '<code class="ep-example-url">' + base + ep.example + '</code>'
            + '<button class="ep-copy-btn" data-url="' + (base + ep.example).replace(/"/g, '&quot;') + '" title="Copy URL">\u2398</button>'
          + '</div>';

      var paramsHtml = ep.params.length ? '<div class="ep-params">' + ep.params.map(function(p) {
        return '<span class="ep-param' + (p.req ? ' req' : '') + '">'
          + '<code>' + p.name + '</code>'
          + '<span class="ep-param-note">' + (p.req ? '<b>required</b>' : 'optional') + ' \u2014 ' + p.note + '</span>'
          + '</span>';
      }).join('') + '</div>' : '';

      return '<div class="ep-card">'
        + '<div class="ep-card-head">'
          + '<span class="ep-method ' + ep.method.toLowerCase() + '">' + ep.method + '</span>'
          + '<code class="ep-path">' + ep.path + '</code>'
          + '<span class="ep-desc">' + ep.desc + '</span>'
        + '</div>'
        + paramsHtml
        + '<div class="ep-example">' + exUrl + '</div>'
        + '</div>';
    }).join('');

    list.querySelectorAll('.ep-copy-btn').forEach(function(btn) {
      btn.addEventListener('click', function() {
        if (navigator.clipboard) {
          navigator.clipboard.writeText(btn.dataset.url).then(function() {
            btn.textContent = '\u2713';
            setTimeout(function() { btn.innerHTML = '\u2398'; }, 1500);
          });
        }
      });
    });

    var epBtn = document.getElementById('ep-collapse-btn');
    if (epBtn && !epBtn.dataset.bound) {
      epBtn.dataset.bound = '1';
      epBtn.addEventListener('click', function() {
        var panel = document.getElementById('ep-panel');
        if (!panel) return;
        var isOpen = !panel.classList.contains('hidden');
        if (isOpen) { panel.classList.add('hidden'); epBtn.classList.remove('open'); }
        else         { panel.classList.remove('hidden'); epBtn.classList.add('open'); }
      });
      var epHeader = document.getElementById('ep-section-header');
      if (epHeader) epHeader.addEventListener('click', function(e) {
        if (!e.target.closest('#ep-collapse-btn')) epBtn.click();
      });
    }
  }

  var apiToggle = document.getElementById('setting-enable-api');
  if (apiToggle) apiToggle.addEventListener('change', async function() {
    await fetch('/api/settings/api-access', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: apiToggle.checked }),
    });
    toggleApiPanel(apiToggle.checked);
  });

  // ── Broker toggles ─────────────────────────────────────────────────────────

  var dhanToggle = document.getElementById('setting-enable-dhan');
  if (dhanToggle) dhanToggle.addEventListener('change', async function() {
    await fetch('/api/settings/brokers', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dhan_enabled: dhanToggle.checked }),
    });
    applyBrokerVisibility('dhan', dhanToggle.checked);
    applyOptionAnalysisVisibility();
  });

  var fpToggle = document.getElementById('setting-enable-5paisa');
  if (fpToggle) fpToggle.addEventListener('change', async function() {
    await fetch('/api/settings/brokers', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ '5paisa_enabled': fpToggle.checked }),
    });
    applyBrokerVisibility('5paisa', fpToggle.checked);
    applyOptionAnalysisVisibility();
  });

  var yahooToggle = document.getElementById('setting-enable-yahoo');
  if (yahooToggle) yahooToggle.addEventListener('change', async function() {
    await fetch('/api/settings/brokers', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ yahoo_enabled: yahooToggle.checked }),
    });
    applyBrokerVisibility('yahoo', yahooToggle.checked);
    applyOptionAnalysisVisibility();
    if (yahooToggle.checked && window._connectBroker && window._connectBroker.yahoo) {
      window._connectBroker.yahoo();
    } else if (!yahooToggle.checked && window._chartSetConnected) {
      window._chartSetConnected('yahoo', false);
      var st = document.getElementById('yahoo-status');
      if (st) st.innerHTML = '<span class="badge disconnected">\u25cf Disabled</span>';
    }
  });

  var excelToggle = document.getElementById('setting-enable-excel');
  if (excelToggle) excelToggle.addEventListener('change', async function() {
    await fetch('/api/settings/brokers', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ excel_enabled: excelToggle.checked }),
    });
    applyBrokerVisibility('excel', excelToggle.checked);
    applyOptionAnalysisVisibility();
    if (excelToggle.checked && window._connectBroker && window._connectBroker.excel) {
      window._connectBroker.excel();
    } else if (!excelToggle.checked && window._chartSetConnected) {
      window._chartSetConnected('excel', false);
      var st = document.getElementById('excel-status');
      if (st) st.innerHTML = '<span class="badge disconnected">\u25cf Disabled</span>';
    }
  });

  // ── Technical Indicators ───────────────────────────────────────────────────

  var _taCatalog   = {};   // loaded from /public/api/ta/catalog
  var _taCustomCatalog = []; // line-chart custom indicators
  var _taIndicators = [];  // current list of configured indicators
  var _TA_SMOOTH_MODELS = [
    { id: 'savgol', label: 'Savitzky-Golay' },
    { id: 'gaussian', label: 'Gaussian Kernel' },
    { id: 'kernel_poly', label: 'Kernel Poly' },
  ];
  var _TA_SMOOTH_FACTORY = {
    levels: [
      { enabled: true, input: 'price', model: 'savgol', window: 11, polyorder: 3, bandwidth: 3, degree: 2 },
      { enabled: true, input: 'ce1', model: 'gaussian', window: 11, polyorder: 3, bandwidth: 3, degree: 2 },
      { enabled: true, input: 'ce2', model: 'kernel_poly', window: 11, polyorder: 3, bandwidth: 8, degree: 2 },
      { enabled: true, input: 'ce3', model: 'gaussian', window: 11, polyorder: 3, bandwidth: 6, degree: 2 },
    ],
  };

  async function loadTaSettings() {
    try {
      var r = await fetch('/public/api/ta/catalog');
      var d = await r.json();
      if (d.success) {
        _taCatalog = d.indicators || {};
        _taCustomCatalog = d.custom_indicators || [];
        _populateTaTypeSelect();
      }
    } catch (_) {}
    try {
      var r2 = await fetch('/api/settings/indicators');
      var d2 = await r2.json();
      _taIndicators = d2.ta_indicators || [];
      var taChk = document.getElementById('setting-enable-ta');
      if (taChk) taChk.checked = !!d2.ta_enabled;
      _renderTaRows();
    } catch (_) {}
  }

  function _customMeta(id) {
    for (var i = 0; i < _taCustomCatalog.length; i++) {
      if (_taCustomCatalog[i].id === id) return _taCustomCatalog[i];
    }
    return null;
  }

  function _isCustomInd(ind) {
    return !!(ind && (ind.source === 'custom' || _customMeta(ind.type)));
  }

  function _isSmoothingInd(ind) {
    var meta = _customMeta(ind && ind.type);
    return !!(meta && (meta.ui === 'smoothing' || meta.id === 'smoothing'));
  }

  function _cloneJson(v) {
    return JSON.parse(JSON.stringify(v));
  }

  function _smoothingFactory(meta) {
    var src = (meta && meta.factory) || _TA_SMOOTH_FACTORY;
    return _cloneJson(src);
  }

  function _normalizeSmoothingParams(raw, meta) {
    var factory = _smoothingFactory(meta);
    var srcLevels = (raw && raw.levels) || [];
    var levels = [];
    for (var i = 0; i < 4; i++) {
      var base = factory.levels[i] || _TA_SMOOTH_FACTORY.levels[i];
      var row = Object.assign({}, base, (srcLevels[i] && typeof srcLevels[i] === 'object') ? srcLevels[i] : {});
      var allowed = ['price'].concat([1, 2, 3, 4].slice(0, i).map(function(n) { return 'ce' + n; }));
      var inp = String(row.input || '').toLowerCase();
      if (inp === 'close') inp = 'price';
      if (inp.indexOf('ac_') === 0) inp = inp.slice(3);
      row.input = allowed.indexOf(inp) >= 0 ? inp : allowed[allowed.length - 1];
      var model = String(row.model || 'savgol').toLowerCase();
      if (model === 'savitzky-golay') model = 'savgol';
      if (model === 'gaussian kernel') model = 'gaussian';
      if (model === 'kernel poly') model = 'kernel_poly';
      if (['savgol', 'gaussian', 'kernel_poly', 'none'].indexOf(model) < 0) model = 'savgol';
      row.model = model;
      row.enabled = row.enabled !== false && row.enabled !== 0 && row.enabled !== '0';
      row.window = Number(row.window); if (!isFinite(row.window)) row.window = 11;
      row.polyorder = Number(row.polyorder); if (!isFinite(row.polyorder)) row.polyorder = 3;
      row.bandwidth = Number(row.bandwidth); if (!isFinite(row.bandwidth)) row.bandwidth = 3;
      row.degree = Number(row.degree); if (!isFinite(row.degree)) row.degree = 2;
      levels.push(row);
    }
    return { levels: levels };
  }

  function _optionHtml(opts, selected) {
    return opts.map(function(o) {
      var id = o.id || o;
      var label = o.label || o;
      return '<option value="' + id + '"' + (id === selected ? ' selected' : '') + '>' + label + '</option>';
    }).join('');
  }

  function _smoothInputOptions(level) {
    var opts = [{ id: 'price', label: 'Price' }];
    for (var i = 1; i < level; i++) opts.push({ id: 'ce' + i, label: 'CE' + i });
    return opts;
  }

  function _syncTaSmoothVisibility(root) {
    if (!root) return;
    root.querySelectorAll('.ce-level').forEach(function(card) {
      var modelEl = card.querySelector('.ce-model');
      var model = modelEl ? modelEl.value : 'savgol';
      card.querySelectorAll('[data-for]').forEach(function(row) {
        var keys = (row.getAttribute('data-for') || '').split(',');
        row.style.display = keys.indexOf(model) >= 0 ? '' : 'none';
      });
    });
  }

  function _customDefaultParams(meta) {
    if (!meta) return {};
    if (meta.ui === 'smoothing' || meta.id === 'smoothing') {
      return _normalizeSmoothingParams(_smoothingFactory(meta), meta);
    }
    var params = {};
    (meta.params || []).forEach(function(p) { params[p.key] = p.def; });
    return params;
  }

  function _populateTaTypeSelect() {
    var sel = document.getElementById('ta-type-select');
    if (!sel) return;
    var html = '<optgroup label="Technical Indicators">';
    html += Object.keys(_taCatalog).map(function(k) {
      return '<option value="' + k + '">' + _taCatalog[k].label + '</option>';
    }).join('');
    html += '</optgroup>';
    if (_taCustomCatalog.length) {
      html += '<optgroup label="Custom Indicators">';
      html += _taCustomCatalog.map(function(m) {
        return '<option value="custom:' + m.id + '">' + (m.name || m.id) + '</option>';
      }).join('');
      html += '</optgroup>';
    }
    sel.innerHTML = html;
  }

  function _uniqueTaId(base) {
    var id = base;
    var n = 2;
    while (_taIndicators.some(function(x) { return x.id === id; })) {
      id = base + '_' + n;
      n += 1;
    }
    return id;
  }

  function _makeIndicatorId(type, params) {
    var p = _taCatalog[type] ? _taCatalog[type].params : [];
    if (!p.length) return type;
    var vals = p.map(function(pd) { return params[pd.name] || pd.default; });
    return type + '_' + vals.join('_');
  }

  function _taFieldKeys(ind) {
    if (_isSmoothingInd(ind)) {
      var meta = _customMeta(ind.type);
      var cfg = _normalizeSmoothingParams(ind.params, meta);
      var keys = [];
      cfg.levels.forEach(function(row, i) {
        if (row.enabled) keys.push(ind.id + '_ce' + (i + 1));
      });
      return keys;
    }
    return [ind.id];
  }

  function _renderSmoothingParams(ind, idx) {
    var meta = _customMeta(ind.type);
    var cfg = _normalizeSmoothingParams(ind.params, meta);
    var html = '<div class="ce-levels" data-idx="' + idx + '">';
    cfg.levels.forEach(function(row, i) {
      var lvl = i + 1;
      html += '<div class="ce-level" data-lvl="' + lvl + '">';
      html += '<div class="ce-level-head"><strong>CE' + lvl + '</strong>';
      html += '<label class="toggle-switch"><input type="checkbox" class="ce-enabled"' + (row.enabled ? ' checked' : '') + ' /><span class="toggle-slider"></span></label></div>';
      html += '<div class="ce-level-grid">';
      html += '<div class="ind-param-row"><label>Input</label><select class="ce-input ta-param-select">' + _optionHtml(_smoothInputOptions(lvl), row.input) + '</select></div>';
      html += '<div class="ind-param-row"><label>Engine</label><select class="ce-model ta-param-select">' + _optionHtml(_TA_SMOOTH_MODELS, row.model) + '</select></div>';
      html += '<div class="ce-span-2 ce-params">';
      html += '<div class="ind-param-row" data-for="savgol"><label>Window</label><input type="number" class="ce-window ta-param-input" min="3" max="501" step="1" value="' + row.window + '" /></div>';
      html += '<div class="ind-param-row" data-for="savgol"><label>Polyorder</label><input type="number" class="ce-polyorder ta-param-input" min="1" max="15" step="1" value="' + row.polyorder + '" /></div>';
      html += '<div class="ind-param-row" data-for="gaussian,kernel_poly"><label>Bandwidth</label><input type="number" class="ce-bandwidth ta-param-input" min="0.1" max="500" step="0.1" value="' + row.bandwidth + '" /></div>';
      html += '<div class="ind-param-row" data-for="kernel_poly"><label>Degree</label><input type="number" class="ce-degree ta-param-input" min="1" max="8" step="1" value="' + row.degree + '" /></div>';
      html += '</div></div></div>';
    });
    html += '</div>';
    return html;
  }

  function _readSmoothingFromRow(rowEl, meta) {
    var factory = _smoothingFactory(meta);
    var levels = [];
    var cards = rowEl.querySelectorAll('.ce-level');
    for (var i = 0; i < 4; i++) {
      var card = cards[i];
      var base = factory.levels[i] || _TA_SMOOTH_FACTORY.levels[i];
      if (!card) { levels.push(Object.assign({}, base)); continue; }
      var num = function(sel, fallback) {
        var el = card.querySelector(sel);
        var n = el ? parseFloat(el.value) : fallback;
        return isFinite(n) ? n : fallback;
      };
      var chk = function(sel) {
        var el = card.querySelector(sel);
        return !!(el && el.checked);
      };
      var val = function(sel, fallback) {
        var el = card.querySelector(sel);
        return el && el.value ? el.value : fallback;
      };
      levels.push({
        enabled: chk('.ce-enabled'),
        input: val('.ce-input', base.input),
        model: val('.ce-model', base.model),
        window: Math.round(num('.ce-window', base.window)),
        polyorder: Math.round(num('.ce-polyorder', base.polyorder)),
        bandwidth: num('.ce-bandwidth', base.bandwidth),
        degree: Math.round(num('.ce-degree', base.degree)),
      });
    }
    return _normalizeSmoothingParams({ levels: levels }, meta);
  }

  function _renderCustomParamInputs(ind, idx, meta) {
    return (meta.params || []).map(function(pd) {
      var val = (ind.params && ind.params[pd.key] !== undefined) ? ind.params[pd.key] : pd.def;
      if (pd.type === 'bool') {
        return '<span class="ta-param-group">' +
          '<span class="ta-param-label">' + (pd.label || pd.key) + ':</span>' +
          '<input class="ta-custom-param" type="checkbox" data-idx="' + idx + '" data-param="' + pd.key + '" data-ptype="bool"' + (val ? ' checked' : '') + ' />' +
          '</span>';
      }
      return '<span class="ta-param-group">' +
        '<span class="ta-param-label">' + (pd.label || pd.key) + ':</span>' +
        '<input class="ta-param-input ta-custom-param" type="number" data-idx="' + idx + '" data-param="' + pd.key + '"' +
          (pd.min != null ? ' min="' + pd.min + '"' : '') +
          (pd.max != null ? ' max="' + pd.max + '"' : '') +
          (pd.step != null ? ' step="' + pd.step + '"' : '') +
          ' value="' + val + '" />' +
        '</span>';
    }).join('');
  }

  function _renderTaRows() {
    var list = document.getElementById('ta-indicator-list');
    if (!list) return;
    if (!_taIndicators.length) {
      list.innerHTML = '<div style="color:#8b949e;font-size:0.78rem;padding:4px 0;">No indicators configured yet.</div>';
      return;
    }
    list.innerHTML = _taIndicators.map(function(ind, idx) {
      var isCustom = _isCustomInd(ind);
      var meta = isCustom ? _customMeta(ind.type) : null;
      var label = isCustom ? ((meta && meta.name) || ind.type) : ((_taCatalog[ind.type] && _taCatalog[ind.type].label) || ind.type);
      var cat = _taCatalog[ind.type] || { label: ind.type, params: [] };
      var paramHtml;
      if (isCustom && _isSmoothingInd(ind)) {
        paramHtml = _renderSmoothingParams(ind, idx);
      } else if (isCustom && meta) {
        paramHtml = _renderCustomParamInputs(ind, idx, meta);
      } else {
        paramHtml = cat.params.map(function(pd) {
          var val = (ind.params && ind.params[pd.name] !== undefined) ? ind.params[pd.name] : pd.default;
          return '<span class="ta-param-group">' +
            '<span class="ta-param-label">' + pd.name + ':</span>' +
            '<input class="ta-param-input" type="number" data-idx="' + idx + '" data-param="' + pd.name + '" min="' + pd.min + '" max="' + pd.max + '" value="' + val + '" />' +
            '</span>';
        }).join('');
      }
      var keys = _taFieldKeys(ind);
      return '<div class="ta-indicator-row' + (isCustom ? ' ta-custom-row' : '') + '" data-idx="' + idx + '">' +
        '<span class="ta-row-label">' + label + (isCustom ? ' <span class="ta-param-label">(custom)</span>' : '') + '</span>' +
        '<div class="ta-row-params">' + paramHtml + '</div>' +
        '<button class="ta-remove-btn" data-idx="' + idx + '" title="Remove">\u00d7</button>' +
        '<span class="ta-row-id">fields: ' + keys.join(', ') + '</span>' +
        '</div>';
    }).join('');

    list.querySelectorAll('.ta-param-input:not(.ta-custom-param)').forEach(function(inp) {
      if (inp.closest('.ce-level')) return;
      inp.addEventListener('change', function() {
        var i = parseInt(this.dataset.idx);
        var param = this.dataset.param;
        if (_taIndicators[i]) {
          if (!_taIndicators[i].params) _taIndicators[i].params = {};
          _taIndicators[i].params[param] = parseInt(this.value) || parseFloat(this.value);
          _taIndicators[i].id = _makeIndicatorId(_taIndicators[i].type, _taIndicators[i].params);
          _renderTaRows();
        }
      });
    });
    list.querySelectorAll('.ta-custom-param').forEach(function(inp) {
      inp.addEventListener('change', function() {
        var i = parseInt(this.dataset.idx);
        var param = this.dataset.param;
        if (!_taIndicators[i]) return;
        if (!_taIndicators[i].params) _taIndicators[i].params = {};
        if (this.type === 'checkbox' || this.dataset.ptype === 'bool') {
          _taIndicators[i].params[param] = this.checked;
        } else {
          var n = parseFloat(this.value);
          _taIndicators[i].params[param] = isFinite(n) ? n : this.value;
        }
      });
    });
    list.querySelectorAll('.ce-levels').forEach(function(wrap) {
      _syncTaSmoothVisibility(wrap);
      var idx = parseInt(wrap.dataset.idx);
      var sync = function() {
        if (!_taIndicators[idx]) return;
        _taIndicators[idx].params = _readSmoothingFromRow(wrap, _customMeta(_taIndicators[idx].type));
        var keysEl = wrap.closest('.ta-indicator-row');
        if (keysEl) {
          var idEl = keysEl.querySelector('.ta-row-id');
          if (idEl) idEl.textContent = 'fields: ' + _taFieldKeys(_taIndicators[idx]).join(', ');
        }
        _syncTaSmoothVisibility(wrap);
      };
      wrap.querySelectorAll('input, select').forEach(function(el) {
        el.addEventListener('change', sync);
      });
    });
    list.querySelectorAll('.ta-remove-btn').forEach(function(btn) {
      btn.addEventListener('click', function() {
        var i = parseInt(this.dataset.idx);
        _taIndicators.splice(i, 1);
        _renderTaRows();
      });
    });
  }

  // Collapse / Expand
  function _setTaPanel(open) {
    var panel = document.getElementById('ta-panel');
    var btn   = document.getElementById('ta-collapse-btn');
    if (!panel || !btn) return;
    if (open) { panel.classList.remove('hidden'); btn.classList.add('open'); }
    else       { panel.classList.add('hidden');    btn.classList.remove('open'); }
  }

  var taEnableChk = document.getElementById('setting-enable-ta');
  if (taEnableChk) taEnableChk.addEventListener('change', async function() {
    _setTaPanel(taEnableChk.checked);
    await fetch('/api/settings/indicators', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ta_enabled: taEnableChk.checked }),
    });
  });

  var taHeader = document.getElementById('ta-collapse-btn');
  if (taHeader) taHeader.addEventListener('click', function() {
    var panel = document.getElementById('ta-panel');
    if (panel) _setTaPanel(panel.classList.contains('hidden'));
  });

  var taAddBtn = document.getElementById('ta-add-btn');
  if (taAddBtn) taAddBtn.addEventListener('click', function() {
    var sel  = document.getElementById('ta-type-select');
    if (!sel || !sel.value) return;
    var raw = sel.value;
    if (raw.indexOf('custom:') === 0) {
      var cid = raw.slice(7);
      var meta = _customMeta(cid);
      if (!meta) { _showTaSaveMsg('Custom indicator not available.', true); return; }
      var params = _customDefaultParams(meta);
      var id = _uniqueTaId(cid);
      _taIndicators.push({ id: id, type: cid, source: 'custom', params: params });
      _renderTaRows();
      return;
    }
    var type = raw;
    var cat  = _taCatalog[type] || { params: [] };
    var params = {};
    cat.params.forEach(function(pd) { params[pd.name] = pd.default; });
    var id = _makeIndicatorId(type, params);
    var exists = _taIndicators.some(function(x) { return x.id === id; });
    if (exists) { _showTaSaveMsg('Indicator already added.', true); return; }
    _taIndicators.push({ id: id, type: type, source: 'builtin', params: params });
    _renderTaRows();
  });

  var taSaveBtn = document.getElementById('ta-save-btn');
  if (taSaveBtn) taSaveBtn.addEventListener('click', async function() {
    try {
      var taChk = document.getElementById('setting-enable-ta');
      await fetch('/api/settings/indicators', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ta_enabled: taChk ? taChk.checked : false,
          ta_indicators: _taIndicators,
        }),
      });
      _showTaSaveMsg('Saved!', false);
    } catch (e) {
      _showTaSaveMsg('Error: ' + e.message, true);
    }
  });

  function _showTaSaveMsg(msg, isError) {
    var el = document.getElementById('ta-save-msg');
    if (!el) return;
    el.textContent = msg;
    el.className = 'ta-save-msg' + (isError ? ' error' : '');
    setTimeout(function() { el.textContent = ''; }, 3000);
  }

  // ── Scrip master ───────────────────────────────────────────────────────────

  async function loadScripStatus() {
    try {
      var res  = await fetch('/api/5paisa/scrip-master/status');
      var data = await res.json();
      var el   = document.getElementById('scrip-master-status');
      if (el) {
        if (data.loading) {
          el.textContent = 'Updating Instrument.csv\u2026';
        } else if (data.loaded) {
          var src = data.cache_exists ? 'Instrument.csv' : 'memory';
          var age = (data.cache_age_days != null) ? (' \u2014 ' + data.cache_age_days + ' days old') : '';
          el.textContent = 'Loaded \u2014 ' + data.count.toLocaleString() +
            ' instruments from ' + src +
            (data.last_loaded ? ' (' + data.last_loaded + ')' : '') + age +
            (data.stale ? ' \u2014 refresh in progress' : '');
        } else if (data.cache_exists) {
          el.textContent = 'Instrument.csv found \u2014 connect or Update to load.';
        } else {
          el.textContent = 'Not loaded. Connect to 5Paisa to download Instrument.csv.';
        }
      }
      if (data.loading) {
        setTimeout(loadScripStatus, 4000);
      }
    } catch (_) {}
  }

  var updateBtn = document.getElementById('btn-update-scrip-master');
  if (updateBtn) updateBtn.addEventListener('click', async function() {
    var msgEl = document.getElementById('scrip-master-msg');
    updateBtn.disabled = true; updateBtn.textContent = 'Updating\u2026';
    try {
      var res  = await fetch('/api/5paisa/scrip-master/update', { method: 'POST' });
      var data = await res.json();
      if (msgEl) {
        msgEl.textContent = data.message || (data.success ? 'Update started.' : 'Failed.');
        msgEl.className   = 'message-box ' + (data.success ? 'success' : 'error');
        msgEl.classList.remove('hidden');
      }
      setTimeout(loadScripStatus, 3000);
    } catch (e) {
      if (msgEl) { msgEl.textContent = 'Error: ' + e.message; msgEl.className = 'message-box error'; msgEl.classList.remove('hidden'); }
    } finally {
      updateBtn.disabled = false; updateBtn.textContent = '\ud83d\udd04 Update';
    }
  });


  // -- Market Settings --
  var MARKET_GROUPS = {
    exch:      '.market-exch-chk',
    exchType:  '.market-exch-type-chk',
    scripType: '.market-scrip-type-chk',
  };

  function syncSelectAll(group) {
    var sel = MARKET_GROUPS[group];
    if (!sel) return;
    var items = Array.from(document.querySelectorAll(sel));
    var allEl = document.querySelector('.market-select-all[data-group="' + group + '"]');
    if (!allEl || !items.length) return;
    allEl.checked = items.every(function(c) { return c.checked; });
    allEl.indeterminate = !allEl.checked && items.some(function(c) { return c.checked; });
  }

  function setGroupChecked(group, checked) {
    var sel = MARKET_GROUPS[group];
    if (!sel) return;
    document.querySelectorAll(sel).forEach(function(c) { c.checked = checked; });
    syncSelectAll(group);
  }

  function applyMarketSettings(data) {
    var exchanges = data.enabled_exchanges || [];
    var exchTypes = data.enabled_exch_types || data.enabled_instrument_types || [];
    var scripTypes = data.enabled_scrip_types || [];
    document.querySelectorAll('.market-exch-chk').forEach(function(chk) {
      chk.checked = exchanges.indexOf(chk.dataset.code) !== -1;
    });
    document.querySelectorAll('.market-exch-type-chk').forEach(function(chk) {
      chk.checked = exchTypes.indexOf(chk.dataset.code) !== -1;
    });
    document.querySelectorAll('.market-scrip-type-chk').forEach(function(chk) {
      chk.checked = scripTypes.indexOf(chk.dataset.code) !== -1;
    });
    var dfChk = document.getElementById('chk-save-datafeed');
    if (dfChk) dfChk.checked = !!data.save_to_datafeed;
    Object.keys(MARKET_GROUPS).forEach(syncSelectAll);
  }

  async function loadMarketSettings() {
    try {
      var res  = await fetch('/api/settings/markets');
      var data = await res.json();
      applyMarketSettings(data);
    } catch (_) {}
  }

  Object.keys(MARKET_GROUPS).forEach(function(group) {
    var allEl = document.querySelector('.market-select-all[data-group="' + group + '"]');
    if (allEl) {
      allEl.addEventListener('change', function() {
        setGroupChecked(group, allEl.checked);
      });
    }
    document.querySelectorAll(MARKET_GROUPS[group]).forEach(function(chk) {
      chk.addEventListener('change', function() { syncSelectAll(group); });
    });
  });

  var btnResetMarkets = document.getElementById('btn-reset-markets');
  if (btnResetMarkets) {
    btnResetMarkets.addEventListener('click', function() {
      Object.keys(MARKET_GROUPS).forEach(function(group) { setGroupChecked(group, true); });
      var msgEl = document.getElementById('market-save-msg');
      if (msgEl) {
        msgEl.textContent = 'All markets selected — click Save Markets to apply.';
        msgEl.className = 'ta-save-msg';
      }
    });
  }

  var btnSaveMarkets = document.getElementById('btn-save-markets');
  if (btnSaveMarkets) {
    btnSaveMarkets.addEventListener('click', async function() {
      var exchanges = Array.from(document.querySelectorAll('.market-exch-chk'))
        .filter(function(c) { return c.checked; }).map(function(c) { return c.dataset.code; });
      var exchTypes = Array.from(document.querySelectorAll('.market-exch-type-chk'))
        .filter(function(c) { return c.checked; }).map(function(c) { return c.dataset.code; });
      var scripTypes = Array.from(document.querySelectorAll('.market-scrip-type-chk'))
        .filter(function(c) { return c.checked; }).map(function(c) { return c.dataset.code; });
      var dfChk = document.getElementById('chk-save-datafeed');
      var saveToDatafeed = !!(dfChk && dfChk.checked);
      var msgEl = document.getElementById('market-save-msg');
      if (!exchanges.length || !exchTypes.length || !scripTypes.length) {
        if (msgEl) {
          msgEl.textContent = 'Select at least one in each column.';
          msgEl.className = 'ta-save-msg error';
        }
        return;
      }
      try {
        var res = await fetch('/api/settings/markets', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            enabled_exchanges: exchanges,
            enabled_exch_types: exchTypes,
            enabled_scrip_types: scripTypes,
            save_to_datafeed: saveToDatafeed,
          }),
        });
        var data = await res.json();
        if (!res.ok || data.success === false) {
          if (msgEl) {
            msgEl.textContent = data.message || 'Error saving.';
            msgEl.className = 'ta-save-msg error';
          }
          return;
        }
        applyMarketSettings(data);
        if (msgEl) {
          msgEl.textContent = 'Saved.';
          msgEl.className = 'ta-save-msg success';
          setTimeout(function() { msgEl.textContent = ''; }, 2000);
        }
      } catch (e) {
        if (msgEl) { msgEl.textContent = 'Error saving.'; msgEl.className = 'ta-save-msg error'; }
      }
    });
  }

  /* ── Option Chain field settings ── */
  var OC_DEFAULT_PRICE = [
    { key: 'oi', label: 'OI', visible: true },
    { key: 'oi_chg', label: 'OI Chg', visible: true },
    { key: 'interp', label: 'Int.', visible: true },
    { key: 'volume', label: 'Volume', visible: true },
    { key: 'chg', label: 'Chg', visible: true },
    { key: 'chg_pct', label: 'Chg%', visible: true },
    { key: 'ltp', label: 'LTP', visible: true },
  ];
  var OC_DEFAULT_GREEKS = [
    { key: 'iv', label: 'IV', visible: true },
    { key: 'delta', label: 'Delta', visible: true },
    { key: 'gamma', label: 'Gamma', visible: true },
    { key: 'theta', label: 'Theta', visible: true },
    { key: 'vega', label: 'Vega', visible: true },
    { key: 'rho', label: 'Rho', visible: true },
    { key: 'vanna', label: 'Vanna', visible: true },
    { key: 'charm', label: 'Charm', visible: true },
    { key: 'volga', label: 'Volga', visible: true },
    { key: 'iv_vwap', label: 'IV VWAP', visible: true },
    { key: 'speed', label: 'Speed', visible: true },
    { key: 'zomma', label: 'Zomma', visible: true },
    { key: 'color', label: 'Color', visible: true },
    { key: 'veta', label: 'Veta', visible: true },
  ];
  var _ocPriceFields = OC_DEFAULT_PRICE.map(function(x) { return Object.assign({}, x); });
  var _ocGreeksFields = OC_DEFAULT_GREEKS.map(function(x) { return Object.assign({}, x); });

  function renderOcFieldList(listId, fields, kind) {
    var list = document.getElementById(listId);
    if (!list) return;
    list.innerHTML = fields.map(function(f, i) {
      var hiddenCls = f.visible ? '' : ' oc-field-hidden';
      return '<div class="oc-field-row' + hiddenCls + '" data-kind="' + kind + '" data-idx="' + i + '">' +
        '<input type="checkbox" class="oc-field-vis" data-kind="' + kind + '" data-idx="' + i + '"' +
          (f.visible ? ' checked' : '') + ' />' +
        '<span class="oc-field-name">' + f.label +
          '<span class="oc-field-key">' + f.key + '</span></span>' +
        '<div class="oc-field-sort">' +
          '<button type="button" class="oc-field-up" data-kind="' + kind + '" data-idx="' + i + '"' +
            (i === 0 ? ' disabled' : '') + ' title="Move up">&#9650;</button>' +
          '<button type="button" class="oc-field-down" data-kind="' + kind + '" data-idx="' + i + '"' +
            (i === fields.length - 1 ? ' disabled' : '') + ' title="Move down">&#9660;</button>' +
        '</div></div>';
    }).join('');
  }

  function refreshOcFieldLists() {
    renderOcFieldList('oc-price-fields', _ocPriceFields, 'price');
    renderOcFieldList('oc-greeks-fields', _ocGreeksFields, 'greeks');
  }

  function ocFieldsFor(kind) {
    return kind === 'greeks' ? _ocGreeksFields : _ocPriceFields;
  }

  function moveOcField(kind, idx, dir) {
    var arr = ocFieldsFor(kind);
    var j = idx + dir;
    if (j < 0 || j >= arr.length) return;
    var tmp = arr[idx];
    arr[idx] = arr[j];
    arr[j] = tmp;
    refreshOcFieldLists();
  }

  function applyOcFieldSettings(data) {
    _ocPriceFields = (data.oc_price_fields && data.oc_price_fields.length)
      ? data.oc_price_fields.map(function(x) {
          return { key: x.key, label: x.label || x.key, visible: x.visible !== false };
        })
      : OC_DEFAULT_PRICE.map(function(x) { return Object.assign({}, x); });
    _ocGreeksFields = (data.oc_greeks_fields && data.oc_greeks_fields.length)
      ? data.oc_greeks_fields.map(function(x) {
          return { key: x.key, label: x.label || x.key, visible: x.visible !== false };
        })
      : OC_DEFAULT_GREEKS.map(function(x) { return Object.assign({}, x); });
    refreshOcFieldLists();
  }

  async function loadOcFieldSettings() {
    try {
      var res = await fetch('/api/settings/option-chain');
      var data = await res.json();
      applyOcFieldSettings(data);
    } catch (_) {
      refreshOcFieldLists();
    }
  }

  var ocListRoot = document.getElementById('oc-settings-panel');
  if (ocListRoot) {
    ocListRoot.addEventListener('click', function(e) {
      var up = e.target.closest('.oc-field-up');
      var down = e.target.closest('.oc-field-down');
      if (up) {
        moveOcField(up.dataset.kind, parseInt(up.dataset.idx, 10), -1);
        return;
      }
      if (down) {
        moveOcField(down.dataset.kind, parseInt(down.dataset.idx, 10), 1);
      }
    });
    ocListRoot.addEventListener('change', function(e) {
      if (!e.target.classList.contains('oc-field-vis')) return;
      var kind = e.target.dataset.kind;
      var idx = parseInt(e.target.dataset.idx, 10);
      var arr = ocFieldsFor(kind);
      if (!arr[idx]) return;
      arr[idx].visible = !!e.target.checked;
      refreshOcFieldLists();
    });
  }

  var btnResetOc = document.getElementById('btn-reset-oc-fields');
  if (btnResetOc) {
    btnResetOc.addEventListener('click', function() {
      _ocPriceFields = OC_DEFAULT_PRICE.map(function(x) { return Object.assign({}, x); });
      _ocGreeksFields = OC_DEFAULT_GREEKS.map(function(x) { return Object.assign({}, x); });
      refreshOcFieldLists();
      var msgEl = document.getElementById('oc-fields-save-msg');
      if (msgEl) {
        msgEl.textContent = 'Defaults restored — click Save Option Chain to apply.';
        msgEl.className = 'ta-save-msg';
      }
    });
  }

  var btnSaveOc = document.getElementById('btn-save-oc-fields');
  if (btnSaveOc) {
    btnSaveOc.addEventListener('click', async function() {
      var msgEl = document.getElementById('oc-fields-save-msg');
      var priceVis = _ocPriceFields.some(function(f) { return f.visible; });
      var greeksVis = _ocGreeksFields.some(function(f) { return f.visible; });
      if (!priceVis || !greeksVis) {
        if (msgEl) {
          msgEl.textContent = 'Keep at least one field visible in each list.';
          msgEl.className = 'ta-save-msg error';
        }
        return;
      }
      try {
        var res = await fetch('/api/settings/option-chain', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            oc_price_fields: _ocPriceFields,
            oc_greeks_fields: _ocGreeksFields,
          }),
        });
        var data = await res.json();
        if (!res.ok || data.success === false) {
          if (msgEl) {
            msgEl.textContent = data.message || 'Error saving.';
            msgEl.className = 'ta-save-msg error';
          }
          return;
        }
        applyOcFieldSettings(data);
        window.dispatchEvent(new CustomEvent('traderapp:oc-settings-saved'));
        if (msgEl) {
          msgEl.textContent = 'Saved.';
          msgEl.className = 'ta-save-msg success';
          setTimeout(function() { msgEl.textContent = ''; }, 2000);
        }
      } catch (e) {
        if (msgEl) { msgEl.textContent = 'Error saving.'; msgEl.className = 'ta-save-msg error'; }
      }
    });
  }

  loadSettings();
  loadMarketSettings();
  loadOcFieldSettings();
  loadScripStatus();

  document.querySelectorAll('#page-settings .settings-card-header').forEach(function(header) {
    header.addEventListener('click', function() {
      var body = header.nextElementSibling;
      var btn = header.querySelector('.ta-collapse-btn');
      if (!body || !body.classList.contains('settings-card-body') || !btn) return;
      var isHidden = body.classList.contains('hidden');
      if (isHidden) { body.classList.remove('hidden'); btn.classList.add('open'); }
      else { body.classList.add('hidden'); btn.classList.remove('open'); }
    });
  });

})();
