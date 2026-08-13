/* ── Option Chain + Greeks ── */
(function () {
  var el = function (id) { return document.getElementById(id); };
  var _timer = null;
  var _loading = false;
  var _lastData = null;
  var _view = "price"; // price | greeks

  var PRICE_COL_META = {
    oi: { key: "oi", label: "OI", dp: 0 },
    oi_chg: { key: "oi_chg", label: "OI Chg", dp: 0 },
    volume: { key: "volume", label: "Volume", dp: 0 },
    chg: { key: "chg", label: "Chg", dp: 2 },
    chg_pct: { key: "chg_pct", label: "Chg%", dp: 2, pct: true },
    ltp: { key: "ltp", label: "LTP", dp: 2, ltp: true },
  };

  var GREEKS_COL_META = {
    iv: { key: "iv", label: "IV", iv: true },
    delta: { key: "delta", label: "Delta", dp: 3 },
    gamma: { key: "gamma", label: "Gamma", dp: 4 },
    theta: { key: "theta", label: "Theta", dp: 2 },
    vega: { key: "vega", label: "Vega", dp: 2 },
    rho: { key: "rho", label: "Rho", dp: 3 },
    vanna: { key: "vanna", label: "Vanna", dp: 4 },
    charm: { key: "charm", label: "Charm", dp: 4 },
    volga: { key: "volga", label: "Volga", dp: 4 },
    iv_vwap: { key: "iv_vwap", label: "IV VWAP", iv: true },
    speed: { key: "speed", label: "Speed", dp: 4 },
    zomma: { key: "zomma", label: "Zomma", dp: 4 },
    color: { key: "color", label: "Color", dp: 4 },
    veta: { key: "veta", label: "Veta", dp: 4 },
  };

  var DEFAULT_PRICE_ORDER = ["oi", "oi_chg", "volume", "chg", "chg_pct", "ltp"];
  var DEFAULT_GREEKS_ORDER = [
    "iv", "delta", "gamma", "theta", "vega", "rho", "vanna", "charm",
    "volga", "iv_vwap", "speed", "zomma", "color", "veta",
  ];

  var PRICE_COLS = DEFAULT_PRICE_ORDER.map(function (k) { return PRICE_COL_META[k]; });
  var GREEKS_COLS = DEFAULT_GREEKS_ORDER.map(function (k) { return GREEKS_COL_META[k]; });

  function applyFieldPrefs(meta, defaults, prefs) {
    var ordered = [];
    var seen = {};
    (prefs || []).forEach(function (p) {
      if (!p || !p.key || !meta[p.key] || seen[p.key]) return;
      if (p.visible === false) return;
      seen[p.key] = true;
      var col = Object.assign({}, meta[p.key]);
      if (p.label) col.label = p.label;
      ordered.push(col);
    });
    if (!ordered.length) {
      defaults.forEach(function (k) {
        if (meta[k]) ordered.push(Object.assign({}, meta[k]));
      });
    }
    return ordered;
  }

  async function loadColumnSettings() {
    try {
      var res = await fetch("/api/settings/option-chain");
      var data = await res.json();
      PRICE_COLS = applyFieldPrefs(PRICE_COL_META, DEFAULT_PRICE_ORDER, data.oc_price_fields);
      GREEKS_COLS = applyFieldPrefs(GREEKS_COL_META, DEFAULT_GREEKS_ORDER, data.oc_greeks_fields);
    } catch (_) {
      PRICE_COLS = DEFAULT_PRICE_ORDER.map(function (k) { return Object.assign({}, PRICE_COL_META[k]); });
      GREEKS_COLS = DEFAULT_GREEKS_ORDER.map(function (k) { return Object.assign({}, GREEKS_COL_META[k]); });
    }
    if (_lastData) renderChain(_lastData);
    else renderHead();
  }

  function showMsg(msg, isError) {
    var box = el("oc-msg");
    if (!box) return;
    box.textContent = msg;
    box.className = "message-box " + (isError ? "error" : "success");
    box.classList.remove("hidden");
    setTimeout(function () { box.classList.add("hidden"); }, 6000);
  }

  function fmt(v, dp) {
    if (v === null || v === undefined || v === "") return "—";
    var n = Number(v);
    if (isNaN(n)) return "—";
    if (dp === undefined) dp = 2;
    return n.toLocaleString(undefined, {
      minimumFractionDigits: dp,
      maximumFractionDigits: dp,
    });
  }

  function fmtIv(v) {
    if (v === null || v === undefined || v === "") return "—";
    var n = Number(v);
    if (isNaN(n)) return "—";
    if (Math.abs(n) <= 2) n = n * 100;
    return n.toFixed(1) + "%";
  }

  function cellValue(side, col) {
    var v = side[col.key];
    if (col.iv) return fmtIv(v);
    if (col.pct) {
      if (v === null || v === undefined || v === "") return "—";
      var n = Number(v);
      if (isNaN(n)) return "—";
      return (n >= 0 ? "+" : "") + n.toFixed(2) + "%";
    }
    return fmt(v, col.dp);
  }

  function chgClass(v) {
    var n = Number(v);
    if (isNaN(n) || n === 0) return "";
    return n > 0 ? " oc-up" : " oc-down";
  }

  function currentCols() {
    return _view === "greeks" ? GREEKS_COLS : PRICE_COLS;
  }

  function renderHead() {
    var head = el("oc-thead");
    if (!head) return;
    var cols = currentCols();
    var n = cols.length;
    var top = "<tr>" +
      "<th colspan=\"" + n + "\" class=\"oc-th-ce\">CALLS</th>" +
      "<th class=\"oc-th-strike\">Strike</th>" +
      "<th colspan=\"" + n + "\" class=\"oc-th-pe\">PUTS</th>" +
      "</tr>";
    var ce = cols.map(function (c) { return "<th>" + c.label + "</th>"; }).join("");
    var pe = cols.slice().reverse().map(function (c) { return "<th>" + c.label + "</th>"; }).join("");
    var sub = "<tr>" + ce + "<th class=\"oc-th-strike\">Strike</th>" + pe + "</tr>";
    head.innerHTML = top + sub;
  }

  function renderChain(data) {
    _lastData = data;
    renderHead();
    var body = el("oc-tbody");
    var rows = data.chain || [];
    var cols = currentCols();
    var colCount = cols.length * 2 + 1;
    if (!rows.length) {
      body.innerHTML = '<tr><td colspan="' + colCount + '" class="oc-empty">No strikes returned.</td></tr>';
      return;
    }

    body.innerHTML = rows.map(function (r) {
      var ce = r.ce || {};
      var pe = r.pe || {};
      var cls = r.atm ? " class=\"oc-atm\"" : "";
      var ceCells = cols.map(function (c) {
        var extra = "";
        if (c.key === "chg" || c.key === "chg_pct" || c.key === "oi_chg") extra = chgClass(ce[c.key]);
        if (c.ltp) extra += " oc-ltp";
        return "<td class=\"" + extra.trim() + "\">" + cellValue(ce, c) + "</td>";
      }).join("");
      var peCells = cols.slice().reverse().map(function (c) {
        var extra = "";
        if (c.key === "chg" || c.key === "chg_pct" || c.key === "oi_chg") extra = chgClass(pe[c.key]);
        if (c.ltp) extra += " oc-ltp";
        return "<td class=\"" + extra.trim() + "\">" + cellValue(pe, c) + "</td>";
      }).join("");
      return "<tr" + cls + ">" +
        ceCells +
        "<td class=\"oc-strike-cell\">" + fmt(r.strike, 0) + "</td>" +
        peCells +
        "</tr>";
    }).join("");

    el("oc-spot-label").textContent = "Spot: " + fmt(data.spot, 2) + " · " + (data.symbol || "");
    var src = data.greeks_source || "—";
    if (src === "live") src = "Live (5Paisa WS)";
    else if (src === "bs") src = "Black–Scholes (from LTP)";
    el("oc-greeks-src").textContent = "Greeks: " + src;
    el("oc-updated").textContent = "Updated: " + new Date().toLocaleTimeString();
  }

  async function loadUnderlyings() {
    var sel = el("oc-symbol");
    if (!sel) return;
    try {
      var res = await fetch("/api/5paisa/option-chain/underlyings");
      var data = await res.json();
      sel.innerHTML = "";
      if (!data.success || !(data.underlyings || []).length) {
        sel.innerHTML = '<option value="">No underlyings (need Instrument.csv)</option>';
        return;
      }
      var preferred = ["NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY", "RELIANCE", "TCS", "INFY"];
      var items = data.underlyings.slice();
      items.sort(function (a, b) {
        var ia = preferred.indexOf(a.symbol);
        var ib = preferred.indexOf(b.symbol);
        if (ia === -1) ia = 999;
        if (ib === -1) ib = 999;
        if (ia !== ib) return ia - ib;
        return b.contracts - a.contracts;
      });
      items.forEach(function (u) {
        var opt = document.createElement("option");
        opt.value = u.symbol;
        opt.textContent = u.symbol + " (" + u.contracts + ")";
        if (u.symbol === "NIFTY") opt.selected = true;
        sel.appendChild(opt);
      });
      loadExpiries();
    } catch (e) {
      sel.innerHTML = '<option value="">Failed to load</option>';
    }
  }

  async function loadExpiries() {
    var symbol = el("oc-symbol").value;
    var sel = el("oc-expiry");
    sel.innerHTML = '<option value="">Loading…</option>';
    if (!symbol) {
      sel.innerHTML = '<option value="">Select symbol first</option>';
      return;
    }
    try {
      var res = await fetch("/api/5paisa/option-chain/expiries?symbol=" + encodeURIComponent(symbol));
      var data = await res.json();
      sel.innerHTML = "";
      if (!data.success || !(data.expiries || []).length) {
        sel.innerHTML = '<option value="">' + (data.message || "No expiries") + "</option>";
        return;
      }
      data.expiries.forEach(function (d, i) {
        var opt = document.createElement("option");
        opt.value = d;
        opt.textContent = d;
        if (i === 0) opt.selected = true;
        sel.appendChild(opt);
      });
    } catch (e) {
      sel.innerHTML = '<option value="">Failed to load expiries</option>';
    }
  }

  async function loadChain(silent) {
    if (_loading) return;
    var symbol = el("oc-symbol").value;
    var expiry = el("oc-expiry").value;
    var windowN = parseInt(el("oc-window").value, 10) || 12;
    if (!symbol || !expiry) {
      if (!silent) showMsg("Select underlying and expiry.", true);
      return;
    }
    _loading = true;
    var btn = el("oc-load-btn");
    if (btn && !silent) {
      btn.disabled = true;
      btn.textContent = "Loading…";
    }
    try {
      var res = await fetch("/api/5paisa/option-chain", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          symbol: symbol,
          expiry: expiry,
          strike_window: windowN,
        }),
      });
      var data = await res.json();
      if (!data.success) {
        showMsg(data.message || "Failed to load option chain.", true);
        return;
      }
      renderChain(data);
      if (!silent) showMsg("Loaded " + (data.strike_count || 0) + " strikes.", false);
    } catch (e) {
      showMsg("Error: " + e.message, true);
    } finally {
      _loading = false;
      if (btn) {
        btn.disabled = false;
        btn.textContent = "Load Chain";
      }
    }
  }

  function setAutoRefresh(on) {
    clearInterval(_timer);
    _timer = null;
    if (on) {
      _timer = setInterval(function () { loadChain(true); }, 5000);
    }
  }

  function setView(view) {
    _view = view === "greeks" ? "greeks" : "price";
    document.querySelectorAll(".oc-view-btn").forEach(function (b) {
      b.classList.toggle("active", b.dataset.view === _view);
    });
    if (_lastData) renderChain(_lastData);
    else renderHead();
  }

  function wire() {
    if (!el("oc-symbol")) return;
    loadColumnSettings();
    el("oc-symbol").addEventListener("change", loadExpiries);
    el("oc-load-btn").addEventListener("click", function () { loadChain(false); });
    el("oc-auto-refresh").addEventListener("change", function () {
      setAutoRefresh(el("oc-auto-refresh").checked);
    });
    document.querySelectorAll(".oc-view-btn").forEach(function (btn) {
      btn.addEventListener("click", function () { setView(btn.dataset.view); });
    });
    document.querySelectorAll(".nav-item[data-page]").forEach(function (link) {
      link.addEventListener("click", function () {
        if (link.dataset.page === "option-chain") {
          loadColumnSettings();
          if (!el("oc-symbol").dataset.loaded) {
            el("oc-symbol").dataset.loaded = "1";
            loadUnderlyings();
          }
        } else {
          setAutoRefresh(false);
          if (el("oc-auto-refresh")) el("oc-auto-refresh").checked = false;
        }
      });
    });
    window.addEventListener("traderapp:oc-settings-saved", function () {
      loadColumnSettings();
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", wire);
  } else {
    wire();
  }
})();
