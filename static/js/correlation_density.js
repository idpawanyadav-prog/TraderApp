/* ── Correlation Density Curve Screener ── */
(function () {

  var COLUMNS = [
    { key: "sector",                  label: "Sector",          num: false },
    { key: "instrument1",             label: "Instrument 1",    num: false },
    { key: "instrument2",             label: "Instrument 2",    num: false },
    { key: "correlation",             label: "Correlation",     num: true, dp: 3 },
    { key: "density",                 label: "Density",         num: true, dp: 4 },
    { key: "current_ratio",           label: "Current Ratio",   num: true, dp: 4 },
    { key: "mean_ratio",              label: "Mean Ratio",      num: true, dp: 4 },
    { key: "std_dev",                 label: "Std Dev",         num: true, dp: 5 },
    { key: "z_score",                 label: "Z Score",         num: true, dp: 2 },
    { key: "rolling_correlation",     label: "Rolling Corr",    num: true, dp: 3 },
    { key: "coint_pvalue",            label: "Coint p-value",   num: true, dp: 4 },
    { key: "half_life",               label: "Half Life",       num: true, dp: 1 },
    { key: "hurst",                   label: "Hurst",           num: true, dp: 3 },
    { key: "volatility_ratio",        label: "Vol Ratio",       num: true, dp: 3 },
    { key: "expected_reversion_bars", label: "Exp. Reversion",  num: true, dp: 1 },
    { key: "recommendation",          label: "Recommendation",  num: false },
    { key: "signal_strength",         label: "Signal",          num: true, dp: 1 },
    { key: "historical_win_pct",      label: "Win %",           num: true, dp: 1 },
    { key: "last_updated",            label: "Last Updated",    num: false },
  ];

  var _results   = [];
  var _visibleRows = [];
  var _sortKey   = "signal_strength";
  var _sortDesc  = true;
  var _pollTimer = null;

  var el = function (id) { return document.getElementById(id); };

  var INTERVAL_DEFAULTS = {
    D:  { days: 730, window: 250 },
    "60": { days: 60,  window: 80 },
    "25": { days: 45,  window: 80 },
    "15": { days: 30,  window: 80 },
    "5":  { days: 15,  window: 60 },
    "1":  { days: 5,   window: 50 },
  };

  function ymd(d) {
    return d.toISOString().slice(0, 10);
  }

  function applyIntervalDefaults() {
    var iv = el("cdc-interval").value;
    var cfg = INTERVAL_DEFAULTS[iv] || INTERVAL_DEFAULTS["15"];
    var today = new Date();
    var from = new Date();
    from.setDate(today.getDate() - cfg.days);
    el("cdc-to").value = ymd(today);
    el("cdc-from").value = ymd(from);
    el("cdc-window").value = cfg.window;
  }

  // ── Init defaults ──
  function initDefaults() {
    applyIntervalDefaults();
    loadSectors();
    renderHead();
    var ivSel = el("cdc-interval");
    if (ivSel) ivSel.addEventListener("change", applyIntervalDefaults);
  }

  async function loadSectors() {
    try {
      var res  = await fetch("/api/analysis/sectors");
      var data = await res.json();
      var sel  = el("cdc-sector");
      sel.innerHTML = '<option value="">All Sectors</option>';
      if (!data.file_found) {
        showMsg("Sector.csv not found in the app folder. Create it with Instrument,Sector columns.", true);
        return;
      }
      (data.sectors || []).forEach(function (s) {
        var opt = document.createElement("option");
        opt.value = s.name;
        opt.textContent = s.name + " (" + s.count + ")";
        sel.appendChild(opt);
      });
    } catch (_) {}
  }

  function showMsg(msg, isError) {
    var box = el("cdc-msg");
    box.textContent = msg;
    box.className = "message-box " + (isError ? "error" : "success");
    box.classList.remove("hidden");
    setTimeout(function () { box.classList.add("hidden"); }, 8000);
  }

  // ── Scan lifecycle ──
  async function startScan() {
    var body = {
      from_date:       el("cdc-from").value,
      to_date:         el("cdc-to").value,
      interval:        el("cdc-interval").value,
      sector:          el("cdc-sector").value,
      // density limits are still sent: the backend uses them for the
      // historical win-rate backtest; display filtering happens client-side
      lower_density:   parseFloat(el("cdc-lower").value)   || 0.01,
      upper_density:   parseFloat(el("cdc-upper").value)   || 0.99,
      rolling_window:  parseInt(el("cdc-window").value)    || 250,
    };
    try {
      var res  = await fetch("/api/analysis/cdc/scan", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      var data = await res.json();
      if (!data.success) { showMsg(data.message || "Failed to start scan.", true); return; }
      if (data.from_date) el("cdc-from").value = data.from_date;
      if (data.to_date) el("cdc-to").value = data.to_date;
      if (data.rolling_window) el("cdc-window").value = data.rolling_window;
      if (data.clamped) showMsg(data.message, false);
      setScanning(true);
      pollStatus();
    } catch (e) { showMsg("Error: " + e.message, true); }
  }

  async function cancelScan() {
    try { await fetch("/api/analysis/cdc/cancel", { method: "POST" }); } catch (_) {}
  }

  function setScanning(on) {
    el("cdc-scan-btn").disabled = on;
    el("cdc-cancel-btn").classList.toggle("hidden", !on);
    el("cdc-progress-wrap").classList.toggle("hidden", !on);
    if (on) { el("cdc-progress-fill").style.width = "0%"; el("cdc-status-label").textContent = "Starting…"; }
  }

  function pollStatus() {
    clearInterval(_pollTimer);
    _pollTimer = setInterval(async function () {
      try {
        var res  = await fetch("/api/analysis/cdc/status");
        var st   = await res.json();
        el("cdc-progress-fill").style.width = (st.progress || 0) + "%";
        el("cdc-status-label").textContent  = st.message || st.phase;
        if (!st.running && st.phase !== "idle") {
          clearInterval(_pollTimer);
          setScanning(false);
          if (st.phase === "error") showMsg(st.message, true);
          else showMsg(st.message, false);
          await loadResults();
        }
      } catch (_) {}
    }, 700);
  }

  async function loadResults() {
    try {
      var res  = await fetch("/api/analysis/cdc/results");
      var data = await res.json();
      _results = data.results || [];
      el("cdc-export-btn").disabled = !_results.length;
      renderGrid();
      var foot = el("cdc-grid-footer");
      var skipped = (data.skipped || []).length;
      var fetchErrs = Object.keys(data.fetch_errors || {}).length;
      if (_results.length || skipped || fetchErrs) {
        foot.textContent = _results.length + " pairs qualified · " + skipped +
          " skipped" + (fetchErrs ? " · " + fetchErrs + " symbols failed to download" : "");
        foot.classList.remove("hidden");
      } else {
        foot.classList.add("hidden");
      }
    } catch (_) {}
  }

  // ── Grid rendering (sort + filter) ──
  function renderHead() {
    var tr = el("cdc-grid-head");
    tr.innerHTML = "";
    COLUMNS.forEach(function (c) {
      var th = document.createElement("th");
      th.textContent = c.label;
      th.title = "Sort by " + c.label;
      if (_sortKey === c.key) th.textContent += _sortDesc ? " ▼" : " ▲";
      th.addEventListener("click", function () {
        if (_sortKey === c.key) _sortDesc = !_sortDesc;
        else { _sortKey = c.key; _sortDesc = c.num; }
        renderHead();
        renderGrid();
      });
      tr.appendChild(th);
    });
  }

  function fmt(v, col) {
    if (v === null || v === undefined || v === "") return "—";
    if (col.num && typeof v === "number") return v.toFixed(col.dp !== undefined ? col.dp : 2);
    return String(v);
  }

  function visibleResults() {
    var q = (el("cdc-grid-filter").value || "").trim().toUpperCase();
    var rows = _results.slice();

    // ── Screener: filter by density limits + minimum correlation ──
    if (el("cdc-screener-on").checked) {
      var lower   = parseFloat(el("cdc-lower").value);
      var upper   = parseFloat(el("cdc-upper").value);
      var minCorr = parseFloat(el("cdc-mincorr").value);
      if (isNaN(lower))   lower   = 0.01;
      if (isNaN(upper))   upper   = 0.99;
      if (isNaN(minCorr)) minCorr = 0.80;
      rows = rows.filter(function (r) {
        if (r.correlation === null || r.correlation === undefined || r.correlation < minCorr) return false;
        if (r.density === null || r.density === undefined) return false;
        return r.density <= lower || r.density >= upper;   // only actionable extremes
      });
    }

    if (q) {
      rows = rows.filter(function (r) {
        return COLUMNS.some(function (c) {
          var v = r[c.key];
          return v !== null && v !== undefined && String(v).toUpperCase().indexOf(q) !== -1;
        });
      });
    }
    rows.sort(function (a, b) {
      var va = a[_sortKey], vb = b[_sortKey];
      var na = va === null || va === undefined, nb = vb === null || vb === undefined;
      if (na && nb) return 0;
      if (na) return 1;                  // nulls always last
      if (nb) return -1;
      if (typeof va === "number" && typeof vb === "number") {
        return _sortDesc ? vb - va : va - vb;
      }
      va = String(va); vb = String(vb);
      return _sortDesc ? vb.localeCompare(va) : va.localeCompare(vb);
    });
    return rows;
  }

  // Recommendation derived live from the current screener density limits,
  // so tweaking limits after a scan updates BUY/SELL without a re-scan.
  function liveRecommendation(r) {
    if (r.density === null || r.density === undefined) return "No Action";
    var lower = parseFloat(el("cdc-lower").value);
    var upper = parseFloat(el("cdc-upper").value);
    if (isNaN(lower)) lower = 0.01;
    if (isNaN(upper)) upper = 0.99;
    if (r.density <= lower) return "BUY " + r.instrument1 + " / SELL " + r.instrument2;
    if (r.density >= upper) return "SELL " + r.instrument1 + " / BUY " + r.instrument2;
    return "No Action";
  }

  function renderGrid() {
    var rows = visibleResults();
    _visibleRows = rows;                       // kept for row-click → pair detail
    var body = el("cdc-grid-body");
    el("cdc-grid-empty").style.display = rows.length ? "none" : "";

    var countEl = el("cdc-screener-count");
    if (el("cdc-screener-on").checked) {
      countEl.textContent = rows.length + " of " + _results.length + " pairs match screener";
    } else {
      countEl.textContent = _results.length ? _results.length + " pairs" : "";
    }

    var html = rows.map(function (r, ri) {
      var rec = liveRecommendation(r);
      var cls = "";
      if (rec.indexOf("BUY " + r.instrument1) === 0) cls = "cdc-row-buy";
      else if (rec.indexOf("SELL " + r.instrument1) === 0) cls = "cdc-row-sell";
      return "<tr class=\"" + cls + "\" data-ri=\"" + ri + "\" title=\"Open pair dashboard\">" + COLUMNS.map(function (c) {
        var v = c.key === "recommendation" ? rec : fmt(r[c.key], c);
        var extra = "";
        if (c.key === "signal_strength" && r.signal_label) {
          extra = " <span class=\"cdc-sig-label\">" + r.signal_label + "</span>";
        }
        return "<td" + (c.num ? " class=\"num\"" : "") + ">" + escapeHtml(v) + extra + "</td>";
      }).join("") + "</tr>";
    }).join("");
    body.innerHTML = html;
  }

  function escapeHtml(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  // ── CSV export (respects current filter + sort) ──
  function exportCsv() {
    var rows = visibleResults();
    if (!rows.length) return;
    var esc = function (v) {
      if (v === null || v === undefined) return "";
      v = String(v);
      return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
    };
    var lines = [COLUMNS.map(function (c) { return esc(c.label); }).join(",")];
    rows.forEach(function (r) {
      lines.push(COLUMNS.map(function (c) {
        return esc(c.key === "recommendation" ? liveRecommendation(r) : r[c.key]);
      }).join(","));
    });
    var blob = new Blob([lines.join("\r\n")], { type: "text/csv;charset=utf-8;" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "correlation_density_" + new Date().toISOString().slice(0, 10) + ".csv";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(a.href);
  }

  // ── Wire up ──
  el("cdc-scan-btn").addEventListener("click", startScan);
  el("cdc-cancel-btn").addEventListener("click", cancelScan);
  el("cdc-export-btn").addEventListener("click", exportCsv);
  el("cdc-grid-filter").addEventListener("input", renderGrid);
  // Row click → open the pair-detail dashboard with the scan's inputs
  el("cdc-grid-body").addEventListener("click", function (e) {
    var tr = e.target.closest("tr[data-ri]");
    if (!tr || !window._openPairDetail) return;
    var r = _visibleRows[parseInt(tr.dataset.ri)];
    if (!r) return;
    window._openPairDetail({
      instrument1:    r.instrument1,
      instrument2:    r.instrument2,
      sector:         r.sector,
      interval:       el("cdc-interval").value,
      from_date:      el("cdc-from").value,
      to_date:        el("cdc-to").value,
      rolling_window: parseInt(el("cdc-window").value) || 250,
      lower_density:  parseFloat(el("cdc-lower").value) || 0.01,
      upper_density:  parseFloat(el("cdc-upper").value) || 0.99,
    });
  });
  // Screener controls re-filter the already-loaded results instantly
  el("cdc-screener-on").addEventListener("change", renderGrid);
  ["cdc-lower", "cdc-upper", "cdc-mincorr"].forEach(function (id) {
    el(id).addEventListener("input", renderGrid);
  });

  initDefaults();

  // Resume polling if a scan is already running when the page loads
  fetch("/api/analysis/cdc/status").then(function (r) { return r.json(); })
    .then(function (st) {
      if (st.running) { setScanning(true); pollStatus(); }
      else if (st.phase === "done") loadResults();
    }).catch(function () {});

})();
