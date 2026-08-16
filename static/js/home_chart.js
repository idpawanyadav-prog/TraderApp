/* ── Home Chart (KLineChart) — drawings, built-in + custom indicators ── */
(function () {
  var IST_TZ = "Asia/Kolkata";
  var LS_CUSTOM = "traderapp.chart.customInds";
  var LS_FAV = "traderapp.chart.indFavorites";
  var LS_OVERLAYS = "traderapp.chart.overlays";
  var LS_INDS = "traderapp.chart.activeInds";
  var LS_LEGEND = "traderapp.chart.legendExpanded";
  var LS_CTYPE = "traderapp.chart.candleType";
  var LS_PY_DEFAULTS = "traderapp.chart.pyIndDefaults";
  var LS_SPLIT = "traderapp.chart.splitCount";
  var LS_SLOTMETA = "traderapp.chart.slotMeta";
  var LS_SYNC = "traderapp.chart.layoutSync";
  var LS_DRAW_RAIL = "traderapp.chart.drawRailExpanded";

  var chart = null;
  var _socket = null;
  var _liveSub = false;
  var selectedInstrument = null;
  var activeInterval = "1";
  var FALLBACK_INTERVALS = [
    { id: "1", label: "1m", source: "1", resample: "", days: 10, enabled: true },
    { id: "5", label: "5m", source: "5", resample: "", days: 21, enabled: true },
    { id: "15", label: "15m", source: "15", resample: "", days: 45, enabled: true },
    { id: "25", label: "25m", source: "25", resample: "", days: 60, enabled: true },
    { id: "60", label: "1h", source: "60", resample: "", days: 120, enabled: true },
    { id: "D", label: "1D", source: "D", resample: "", days: 1825, enabled: true }
  ];
  var EXCEL_CHART_INTERVALS = [
    { id: "1", label: "1m", source: "1", resample: "", days: 3650, enabled: true },
    { id: "5", label: "5m", source: "5", resample: "", days: 3650, enabled: true },
    { id: "15", label: "15m", source: "15", resample: "", days: 3650, enabled: true },
    { id: "25", label: "25m", source: "25", resample: "", days: 3650, enabled: true },
    { id: "60", label: "1h", source: "60", resample: "", days: 3650, enabled: true },
    { id: "D", label: "1D", source: "D", resample: "", days: 3650, enabled: true },
    { id: "W", label: "1W", source: "W", resample: "", days: 3650, enabled: true },
    { id: "M", label: "1M", source: "M", resample: "", days: 3650, enabled: true },
    { id: "Q", label: "1Q", source: "Q", resample: "", days: 3650, enabled: true },
    { id: "Y", label: "1Y", source: "Y", resample: "", days: 3650, enabled: true }
  ];
  var _brokerIntervals = {
    dhan: FALLBACK_INTERVALS.slice(),
    "5paisa": FALLBACK_INTERVALS.slice(),
    yahoo: FALLBACK_INTERVALS.slice(),
    excel: EXCEL_CHART_INTERVALS.slice()
  };
  function pickActiveBroker() {
    var s = window._brokerConnected || {};
    var en = window._brokerEnabled || {};
    var preferred = window._chartPreferredBroker;
    function ok(id) {
      if (id === "yahoo" || id === "excel") return !!s[id] && !!en[id];
      return !!s[id] && en[id] !== false;
    }
    if (preferred && ok(preferred)) return preferred;
    if (ok("5paisa")) return "5paisa";
    if (ok("dhan")) return "dhan";
    if (ok("yahoo")) return "yahoo";
    if (ok("excel")) return "excel";
    if (en.yahoo !== false && s.yahoo) return "yahoo";
    if (en.excel && s.excel) return "excel";
    return "5paisa";
  }
  var activeBroker = pickActiveBroker();

  function syncChartBrokerTabs() {
    var en = window._brokerEnabled || {};
    document.querySelectorAll(".cbrok-btn[data-broker]").forEach(function (btn) {
      var id = btn.dataset.broker;
      var on = en[id] !== false;
      if (id === "yahoo") on = !!en.yahoo;
      if (id === "excel") on = !!en.excel;
      btn.style.display = on ? "" : "none";
      btn.classList.toggle("active", id === activeBroker && on);
    });
  }
  function brokerIntervalRows() {
    var list = _brokerIntervals[activeBroker];
    if (!list || !list.length) list = activeBroker === "excel" ? EXCEL_CHART_INTERVALS : FALLBACK_INTERVALS;
    return list.filter(function (r) { return r && r.enabled !== false; });
  }

  function intervalCfg(iv) {
    var list = _brokerIntervals[activeBroker] || (activeBroker === "excel" ? EXCEL_CHART_INTERVALS : FALLBACK_INTERVALS);
    var i;
    for (i = 0; i < list.length; i++) {
      if (list[i].id === iv) return list[i];
    }
    var shown = brokerIntervalRows();
    return shown[0] || (activeBroker === "excel" ? EXCEL_CHART_INTERVALS[0] : FALLBACK_INTERVALS[0]);
  }

  function fetchInterval(iv) {
    var cfg = intervalCfg(iv);
    return cfg.source || cfg.id || iv;
  }

  function renderIntervalButtons() {
    if (!intervalGroup) return;
    intervalGroup.style.display = "";
    var rows = brokerIntervalRows();
    if (!rows.length) rows = activeBroker === "excel" ? EXCEL_CHART_INTERVALS : FALLBACK_INTERVALS;
    var ids = {};
    rows.forEach(function (r) { ids[r.id] = 1; });
    if (!ids[activeInterval]) activeInterval = rows[0].id;
    intervalGroup.innerHTML = rows.map(function (r) {
      var on = r.id === activeInterval ? " active" : "";
      var label = String(r.label || r.id).replace(/[&<>"]/g, function (c) {
        return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c];
      });
      return "<button class=\"ivl-btn" + on + "\" data-ivl=\"" + String(r.id).replace(/"/g, "") + "\">" +
        label + "</button>";
    }).join("");
  }

  window._chartSetBrokerIntervals = function (all) {
    if (!all || typeof all !== "object") return;
    ["dhan", "5paisa", "yahoo"].forEach(function (id) {
      if (all[id] && all[id].length) _brokerIntervals[id] = all[id];
    });
    renderIntervalButtons();
  };
  var _refreshTimer = null;
  var _refreshInterval = 0;
  var _lastBarTime = null;
  var _refreshing = false;
  var _histLoading = false;
  var _histMore = true;
  var MIN_REFRESH_MS = 1000;
  var overlayIds = [];
  var _excelOverlayIds = [];
  var _excelOverlayData = [];
  var _curSlot = 0;
  var EXCEL_IND_COLORS = ["#58a6ff", "#f0883e", "#3fb950", "#d2a8ff", "#f85149", "#79c0ff", "#ffa657", "#7ee787"];
  var selectedOverlayId = null;
  var pendingTextId = null;
  var pendingTextPrev = "";
  var pendingTextIsNew = false;
  var pendingRectId = null;
  var activeDraw = "cursor";
  var magnetOn = true;
  var _pendingDrawId = null;
  var _pendingDrawSlot = -1;
  var activeIndicators = [];
  var editingCustomId = null;
  var editingIndIdx = null;
  var pendingIndName = null;
  var _indSearch = "";
  var _indFocusIdx = -1;
  var _indTab = "technicals";
  var _legendExpanded = true;
  var _legendIndex = null;
  var IND_COLORS = ["#58a6ff", "#f0883e", "#3fb950", "#d2a8ff", "#f85149", "#79c0ff", "#ffa657", "#7ee787"];
  var CUSTOM_OVERLAYS = { tvText: 1, tvRect: 1, tvMeasure: 1, tvLongPosition: 1, tvShortPosition: 1, pyZone: 1, pySmooth: 1 };
  var _pyCatalog = [];
  var _pyRefreshTimer = null;
  var _pyCoveredN = 0;
  var _pyCoveredFirst = null;
  var _settingsKind = "builtin";
  var _settingsPyMeta = null;
  var _pyLineData = {};
  var SMOOTH_MODELS = [
    { id: "none", label: "None" },
    { id: "savgol", label: "Savitzky-Golay" },
    { id: "gaussian", label: "Gaussian Kernel" },
    { id: "kernel_poly", label: "Kernel Poly" }
  ];
  var SMOOTH_FALLBACK_FACTORY = {
    levels: [
      { enabled: true, input: "price", model: "savgol", window: 11, polyorder: 3, bandwidth: 3, degree: 2, color: "#58a6ff", thickness: 1, markers: false, marker_color: "#58a6ff" },
      { enabled: true, input: "ce1", model: "gaussian", window: 11, polyorder: 3, bandwidth: 3, degree: 2, color: "#f0883e", thickness: 1, markers: false, marker_color: "#f0883e" },
      { enabled: true, input: "ce2", model: "kernel_poly", window: 11, polyorder: 3, bandwidth: 8, degree: 2, color: "#3fb950", thickness: 1, markers: false, marker_color: "#3fb950" },
      { enabled: true, input: "ce3", model: "gaussian", window: 11, polyorder: 3, bandwidth: 6, degree: 2, color: "#d2a8ff", thickness: 1, markers: false, marker_color: "#d2a8ff" }
    ]
  };

  var OVERLAY_INDS = { MA: 1, EMA: 1, SMA: 1, BBI: 1, BOLL: 1, SAR: 1, AVP: 1, VWAP: 1, SuperTrend: 1, VOL: 1 };
  var LOCAL_INDS = { VWAP: 1, SuperTrend: 1 };
  var PANE_INDS = ["MACD", "KDJ", "RSI", "WR", "CCI", "DMI", "OBV", "ROC", "MTM", "AO", "BIAS", "TRIX", "DMA", "PSY", "VR", "EMV", "CR", "BRAR", "PVT"];
  var IND_SPECS = {
    MA:   { overlay: true,  csv: true, params: [{ label: "Lengths (candles)", def: "20" }] },
    EMA:  { overlay: true,  csv: true, params: [{ label: "Length (candles)", def: "20" }] },
    SMA:  { overlay: true,  params: [{ label: "Period", def: 12 }, { label: "Weight", def: 2 }] },
    BOLL: { overlay: true,  params: [{ label: "Length (candles)", def: 20 }, { label: "StdDev", def: 2, min: 0.1, step: 0.1, max: 10 }] },
    BBI:  { overlay: true,  params: [{ label: "N1", def: 3 }, { label: "N2", def: 6 }, { label: "N3", def: 12 }, { label: "N4", def: 24 }] },
    SAR:  { overlay: true,  params: [{ label: "Start AF", def: 2 }, { label: "Increment", def: 2 }, { label: "Max AF", def: 20 }] },
    AVP:  { overlay: true,  params: [{ label: "Fast", def: 5 }, { label: "Slow", def: 34 }] },
    VWAP: { overlay: true,  params: [] },
    SuperTrend: {
      overlay: true,
      hideColor: true,
      params: [
        { label: "ATR period", def: 10, min: 2, max: 200 },
        { label: "Multiplier", def: 3, min: 0.5, max: 20, step: 0.1 }
      ]
    },
    VOL:  { overlay: true, params: [] },
    MACD: { overlay: false, params: [{ label: "Fast", def: 12 }, { label: "Slow", def: 26 }, { label: "Signal", def: 9 }] },
    KDJ:  { overlay: false, params: [{ label: "Period", def: 9 }, { label: "K", def: 3 }, { label: "D", def: 3 }] },
    RSI:  { overlay: false, csv: true, params: [{ label: "Length (candles)", def: "14" }] },
    WR:   { overlay: false, csv: true, params: [{ label: "Length (candles)", def: "14" }] },
    CCI:  { overlay: false, params: [{ label: "Length (candles)", def: 20 }] },
    DMI:  { overlay: false, params: [{ label: "Period", def: 14 }, { label: "Signal", def: 6 }] },
    OBV:  { overlay: false, params: [{ label: "MA", def: 30 }] },
    ROC:  { overlay: false, params: [{ label: "Period", def: 12 }, { label: "MA", def: 6 }] },
    MTM:  { overlay: false, params: [{ label: "Period", def: 12 }, { label: "MA", def: 6 }] },
    AO:   { overlay: false, params: [{ label: "Fast", def: 5 }, { label: "Slow", def: 34 }] },
    BIAS: { overlay: false, csv: true, params: [{ label: "Lengths (candles)", def: "6, 12, 24" }] },
    TRIX: { overlay: false, params: [{ label: "Period", def: 12 }, { label: "Signal", def: 9 }] },
    DMA:  { overlay: false, params: [{ label: "Short", def: 10 }, { label: "Long", def: 50 }, { label: "MA", def: 10 }] },
    PSY:  { overlay: false, params: [{ label: "Period", def: 12 }, { label: "MA", def: 6 }] },
    VR:   { overlay: false, params: [{ label: "Period", def: 26 }, { label: "MA", def: 6 }] },
    EMV:  { overlay: false, params: [{ label: "Period", def: 14 }, { label: "MA", def: 9 }] },
    CR:   { overlay: false, params: [{ label: "Period", def: 26 }, { label: "MA1", def: 10 }, { label: "MA2", def: 20 }, { label: "MA3", def: 40 }, { label: "MA4", def: 60 }] },
    BRAR: { overlay: false, params: [{ label: "Period", def: 26 }] },
    PVT:  { overlay: false, params: [{ label: "MA1", def: 12 }, { label: "MA2", def: 6 }] }
  };
  var IND_LABELS = {
    MA: "Moving Average", EMA: "Exponential MA", SMA: "Smoothed MA",
    BOLL: "Bollinger Bands", BBI: "Bull and Bear Index", SAR: "Parabolic SAR",
    AVP: "AVP", VWAP: "VWAP", SuperTrend: "SuperTrend",
    VOL: "Volume", MACD: "MACD", KDJ: "KDJ", RSI: "RSI", WR: "Williams %R",
    CCI: "CCI", DMI: "DMI", OBV: "On Balance Volume", ROC: "Rate of Change",
    MTM: "Momentum", AO: "Awesome Oscillator", BIAS: "Bias", TRIX: "TRIX",
    DMA: "DMA", PSY: "Psychological Line", VR: "Volume Ratio", EMV: "Ease of Movement",
    CR: "CR", BRAR: "BRAR", PVT: "Price Volume Trend"
  };
  var DRAW_TOOLS = [
    { name: "cursor", label: "Cursor", shortcut: { key: "Escape" } },
    { name: "segment", label: "Trend Line", shortcut: { alt: true, code: "KeyT" } },
    { name: "rayLine", label: "Ray", shortcut: { alt: true, shift: true, code: "KeyT" } },
    { name: "straightLine", label: "Extended Line", shortcut: { alt: true, code: "KeyE" } },
    { name: "horizontalStraightLine", label: "Horizontal Line", shortcut: { alt: true, code: "KeyH" } },
    { name: "verticalStraightLine", label: "Vertical Line", shortcut: { alt: true, code: "KeyV" } },
    { name: "priceLine", label: "Price Line", shortcut: { alt: true, shift: true, code: "KeyH" } },
    { name: "parallelStraightLine", label: "Parallel Channel", shortcut: { alt: true, shift: true, code: "KeyC" } },
    { name: "priceChannelLine", label: "Price Channel", shortcut: { alt: true, shift: true, code: "KeyK" } },
    { name: "tvRect", label: "Rectangle", title: "Rectangle", shortcut: { alt: true, shift: true, code: "KeyR" } },
    { name: "tvMeasure", label: "Measure", title: "Measure bars, price and %", shortcut: { alt: true, shift: true, code: "KeyM" } },
    { name: "tvLongPosition", label: "Long Position", title: "Long position: click entry, target, then stop", shortcut: { alt: true, shift: true, code: "KeyB" } },
    { name: "tvShortPosition", label: "Short Position", title: "Short position: click entry, target, then stop", shortcut: { alt: true, shift: true, code: "KeyS" } },
    { name: "tvText", label: "Text", title: "Text note", shortcut: { alt: true, code: "KeyN" } },
    { name: "circle", label: "Circle", shortcut: { alt: true, code: "KeyO" } },
    { name: "triangle", label: "Triangle", shortcut: { alt: true, shift: true, code: "KeyG" } },
    { name: "fibonacciLine", label: "Fib Retracement", shortcut: { alt: true, code: "KeyF" } },
    { name: "fibonacciExtension", label: "Fib Extension", shortcut: { alt: true, shift: true, code: "KeyF" } },
    { name: "fibonacciSegment", label: "Fib Segment", shortcut: { alt: true, shift: true, code: "KeyD" } },
    { name: "fibonacciCircle", label: "Fib Circle", shortcut: { alt: true, shift: true, code: "KeyO" } },
    { name: "fibonacciSpeedResistanceFan", label: "Fib Fan", shortcut: { alt: true, shift: true, code: "KeyN" } },
    { name: "gannBox", label: "Gann Box", shortcut: { alt: true, shift: true, code: "KeyX" } }
  ];
  var MAGNET_SHORTCUT = { alt: true, code: "KeyM" };
  var DRAW_ICONS = {
    cursor: '<path d="M8 1.5v13M1.5 8h13"/><circle cx="8" cy="8" r="2"/>',
    segment: '<path d="M2.5 13.5L13.5 2.5"/>',
    rayLine: '<path d="M2.5 13.5L13.5 2.5"/><path d="M10.2 2.5H13.5V5.8"/>',
    straightLine: '<path d="M1 14.5L15 1.5"/>',
    horizontalStraightLine: '<path d="M1.5 8h13"/>',
    verticalStraightLine: '<path d="M8 1.5v13"/>',
    priceLine: '<path d="M1.5 8h8"/><rect x="9.5" y="5.5" width="5" height="5" rx="1"/>',
    parallelStraightLine: '<path d="M2 11L12 3"/><path d="M4 14L14 6"/>',
    priceChannelLine: '<path d="M1.5 10.5L11 3"/><path d="M3.5 13L13 5.5"/><path d="M5.5 15.2L15 8"/>',
    tvRect: '<rect x="2.5" y="3.5" width="11" height="9" rx="1"/>',
    tvMeasure: '<path d="M2 12h12M2 12V8.5M14 12V4.5"/><path d="M4.5 10.4v1.6M7.2 10.4v1.6M9.9 10.4v1.6"/>',
    tvLongPosition: '<rect x="3" y="2.5" width="10" height="11" rx="1"/><path d="M8 11.2V6.2M5.7 8.2L8 5.7l2.3 2.5"/>',
    tvShortPosition: '<rect x="3" y="2.5" width="10" height="11" rx="1"/><path d="M8 4.8v5M5.7 7.8L8 10.3l2.3-2.5"/>',
    tvText: '<path d="M3.5 4h9M8 4v8"/>',
    circle: '<circle cx="8" cy="8" r="5.5"/>',
    triangle: '<path d="M8 2.5L14 13.5H2z"/>',
    fibonacciLine: '<path d="M2 3.5h12M2 6.5h9M2 9.5h7M2 12.5h4"/>',
    fibonacciExtension: '<path d="M2 13h12M2 9h9M2 5h6"/><path d="M11 5l3-2.4"/>',
    fibonacciSegment: '<path d="M2.5 12.5L13.5 3.5"/><path d="M4.2 10.8h3.2M7.4 8h3.2"/>',
    fibonacciCircle: '<circle cx="8" cy="8" r="2"/><circle cx="8" cy="8" r="4"/><circle cx="8" cy="8" r="6"/>',
    fibonacciSpeedResistanceFan: '<path d="M2.5 13.5h11M2.5 13.5V2.5"/><path d="M2.5 13.5L13.5 9M2.5 13.5L13.5 5.5M2.5 13.5L10 2.5"/>',
    gannBox: '<rect x="2.5" y="2.5" width="11" height="11"/><path d="M2.5 2.5l11 11M13.5 2.5l-11 11"/>',
    magnet: '<path d="M3.5 8V5.6A4.5 4.5 0 0 1 12.5 5.6V8"/><path d="M3.5 8v3h2.4V8M10.1 8v3h2.4V8"/>'
  };
  function drawToolIcon(name) {
    var inner = DRAW_ICONS[name] || DRAW_ICONS.cursor;
    return '<svg class="chart-draw-icon" viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + inner + '</svg>';
  }

  function isMacUi() {
    return /Mac|iPhone|iPad/.test(navigator.platform || "");
  }

  function formatDrawShortcut(sc) {
    if (!sc) return "";
    if (sc.key === "Escape") return "Esc";
    var mac = isMacUi();
    var parts = [];
    if (sc.ctrl) parts.push(mac ? "⌘" : "Ctrl");
    if (sc.alt) parts.push(mac ? "⌥" : "Alt");
    if (sc.shift) parts.push(mac ? "⇧" : "Shift");
    var letter = sc.code ? sc.code.replace(/^Key/, "").replace(/^Digit/, "") : String(sc.key || "");
    if (letter) parts.push(letter);
    return parts.join(" + ");
  }

  function drawToolHoverText(label, shortcut, extra) {
    var keys = formatDrawShortcut(shortcut);
    var bits = [label || ""];
    if (extra) bits.push(extra);
    if (keys) bits.push(keys);
    return bits.filter(Boolean).join("  ");
  }

  function eventMatchesDrawShortcut(e, sc) {
    if (!sc || !e) return false;
    if (sc.key === "Escape") {
      return e.key === "Escape" && !e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey;
    }
    if (!!sc.alt !== !!e.altKey) return false;
    if (!!sc.shift !== !!e.shiftKey) return false;
    if (!!sc.ctrl !== !!(e.ctrlKey || e.metaKey)) return false;
    if (!sc.ctrl && (e.ctrlKey || e.metaKey)) return false;
    return e.code === sc.code;
  }

  function chartDrawModalOpen() {
    var ids = ["custom-ind-modal", "ind-settings-modal", "chart-text-modal", "chart-rect-modal"];
    return ids.some(function (id) {
      var el = document.getElementById(id);
      return el && !el.classList.contains("hidden");
    });
  }

  var _drawTipEl = null;
  function drawTipEl() {
    if (_drawTipEl) return _drawTipEl;
    var el = document.createElement("div");
    el.id = "chart-draw-tip";
    el.className = "chart-draw-tip hidden";
    el.setAttribute("role", "tooltip");
    document.body.appendChild(el);
    _drawTipEl = el;
    return el;
  }

  function hideDrawTip() {
    if (_drawTipEl) _drawTipEl.classList.add("hidden");
  }

  function showDrawTip(btn) {
    var name = btn && btn.getAttribute("data-tip-name");
    var keys = btn && btn.getAttribute("data-tip-keys");
    if (!name && !keys) { hideDrawTip(); return; }
    var el = drawTipEl();
    el.innerHTML = '<div class="chart-draw-tip-name"></div>' + (keys ? '<div class="chart-draw-tip-keys"></div>' : "");
    el.querySelector(".chart-draw-tip-name").textContent = name || "";
    var k = el.querySelector(".chart-draw-tip-keys");
    if (k) k.textContent = keys;
    el.classList.remove("hidden");
    var r = btn.getBoundingClientRect();
    var tw = el.offsetWidth;
    var th = el.offsetHeight;
    var left = Math.round(r.right + 8);
    var top = Math.round(r.top + (r.height - th) / 2);
    if (left + tw > window.innerWidth - 8) left = Math.max(8, Math.round(r.left - tw - 8));
    if (top < 8) top = 8;
    if (top + th > window.innerHeight - 8) top = Math.max(8, window.innerHeight - th - 8);
    el.style.left = left + "px";
    el.style.top = top + "px";
  }

  function bindDrawToolTip(btn, label, shortcut) {
    var keys = formatDrawShortcut(shortcut);
    var hover = drawToolHoverText(label, shortcut);
    btn.setAttribute("data-tip-name", label || "");
    if (keys) btn.setAttribute("data-tip-keys", keys);
    else btn.removeAttribute("data-tip-keys");
    btn.setAttribute("aria-label", hover);
    btn.removeAttribute("title");
  }

  var CANDLE_TYPES = [
    { id: "candle_solid", label: "Candles", ktype: "candle_solid" },
    { id: "candle_up_stroke", label: "Hollow candles", ktype: "candle_up_stroke" },
    { id: "candle_stroke", label: "Hollow (all)", ktype: "candle_stroke" },
    { id: "candle_down_stroke", label: "Hollow down", ktype: "candle_down_stroke" },
    { id: "ohlc", label: "Bars", ktype: "ohlc" },
    { id: "line", label: "Line", ktype: "area", line: true },
    { id: "area", label: "Area", ktype: "area" },
    { id: "heikin_ashi", label: "Heikin Ashi", ktype: "candle_solid", ha: true }
  ];
  var _candleType = "candle_solid";
  var _rawBars = [];
  var _prevClose = null;
  var REPLAY_SPEEDS = [1, 2, 3, 5, 10];
  var _replay = { active: false, picking: false, playing: false, index: -1, startIndex: 0, speed: 1, timer: null };
  (function () {
    var saved = storageGet(LS_CTYPE, "candle_solid");
    if (typeof saved === "string" && CANDLE_TYPES.some(function (t) { return t.id === saved; })) {
      _candleType = saved;
    }
  })();

  var searchInput = document.getElementById("stock-search");
  var dropdown = document.getElementById("search-dropdown");
  var intervalGroup = document.getElementById("interval-group");
  var loadBtn = document.getElementById("load-chart-btn");
  var chartContainer = document.getElementById("chart-container");
  var chartStage = document.querySelector("#page-home .chart-stage");
  var chartNav = document.getElementById("chart-nav");
  var chartMessage = document.getElementById("chart-message");
  var DEFAULT_BAR_SPACE = 8;
  var chartMeta = document.getElementById("chart-meta");
  var symbolLabel = document.getElementById("chart-symbol-label");
  var intervalLabelEl = document.getElementById("chart-interval-label");
  var liveQuoteEl = document.getElementById("chart-live-quote");
  var ohlcEl = document.getElementById("chart-ohlc");

  /* ── Chart split slots (TradingView-style multi-pane layouts) ── */
  var MAX_SLOTS = 16;
  var splitCount = 1;
  var splitLayoutId = "1";
  var activeSlot = 0;
  var chartSlots = [];
  var layoutSync = { symbol: false, interval: false, crosshair: true, time: false, dateRange: false };
  var _syncingXhair = false;
  var _syncingRange = false;
  var _layoutSyncBusy = false;
  var _rangeSyncRaf = 0;

  function _lc(c, r, cs, rs) { return { c: c, r: r, cs: cs || 1, rs: rs || 1 }; }
  function _lg(cols, rows) {
    var cells = [];
    var r, c;
    for (r = 1; r <= rows; r++) {
      for (c = 1; c <= cols; c++) cells.push(_lc(c, r));
    }
    return { cols: cols, rows: rows, cells: cells };
  }
  function _ll(id, pack) {
    return { id: id, n: pack.cells.length, cols: pack.cols, rows: pack.rows, cells: pack.cells };
  }
  var CHART_LAYOUTS = [
    _ll("1", _lg(1, 1)),
    _ll("2h", _lg(2, 1)),
    _ll("2v", _lg(1, 2)),
    _ll("3h", _lg(3, 1)),
    _ll("3v", _lg(1, 3)),
    _ll("3-l", { cols: 2, rows: 2, cells: [_lc(1, 1, 1, 2), _lc(2, 1), _lc(2, 2)] }),
    _ll("3-r", { cols: 2, rows: 2, cells: [_lc(1, 1), _lc(1, 2), _lc(2, 1, 1, 2)] }),
    _ll("3-t", { cols: 2, rows: 2, cells: [_lc(1, 1, 2, 1), _lc(1, 2), _lc(2, 2)] }),
    _ll("3-b", { cols: 2, rows: 2, cells: [_lc(1, 1), _lc(2, 1), _lc(1, 2, 2, 1)] }),
    _ll("4g", _lg(2, 2)),
    _ll("4h", _lg(4, 1)),
    _ll("4v", _lg(1, 4)),
    _ll("4-l", { cols: 2, rows: 3, cells: [_lc(1, 1, 1, 3), _lc(2, 1), _lc(2, 2), _lc(2, 3)] }),
    _ll("4-r", { cols: 2, rows: 3, cells: [_lc(1, 1), _lc(1, 2), _lc(1, 3), _lc(2, 1, 1, 3)] }),
    _ll("4-t", { cols: 3, rows: 2, cells: [_lc(1, 1, 3, 1), _lc(1, 2), _lc(2, 2), _lc(3, 2)] }),
    _ll("4-b", { cols: 3, rows: 2, cells: [_lc(1, 1), _lc(2, 1), _lc(3, 1), _lc(1, 2, 3, 1)] }),
    _ll("5-l", { cols: 3, rows: 2, cells: [_lc(1, 1, 1, 2), _lc(2, 1), _lc(3, 1), _lc(2, 2), _lc(3, 2)] }),
    _ll("5-r", { cols: 3, rows: 2, cells: [_lc(1, 1), _lc(2, 1), _lc(1, 2), _lc(2, 2), _lc(3, 1, 1, 2)] }),
    _ll("5-t", { cols: 2, rows: 3, cells: [_lc(1, 1, 2, 1), _lc(1, 2), _lc(2, 2), _lc(1, 3), _lc(2, 3)] }),
    _ll("5-b", { cols: 2, rows: 3, cells: [_lc(1, 1), _lc(2, 1), _lc(1, 2), _lc(2, 2), _lc(1, 3, 2, 1)] }),
    _ll("5h", _lg(5, 1)),
    _ll("5v", _lg(1, 5)),
    _ll("6-32", _lg(3, 2)),
    _ll("6-23", _lg(2, 3)),
    _ll("6h", _lg(6, 1)),
    _ll("6v", _lg(1, 6)),
    _ll("7-t", { cols: 3, rows: 3, cells: [_lc(1, 1, 3, 1), _lc(1, 2), _lc(2, 2), _lc(3, 2), _lc(1, 3), _lc(2, 3), _lc(3, 3)] }),
    _ll("7v", _lg(1, 7)),
    _ll("8-42", _lg(4, 2)),
    _ll("8-24", _lg(2, 4)),
    _ll("8h", _lg(8, 1)),
    _ll("8v", _lg(1, 8)),
    _ll("9g", _lg(3, 3)),
    _ll("9v", _lg(1, 9)),
    _ll("10-52", _lg(5, 2)),
    _ll("10-25", _lg(2, 5)),
    _ll("12-43", _lg(4, 3)),
    _ll("12-34", _lg(3, 4)),
    _ll("12-62", _lg(6, 2)),
    _ll("12-26", _lg(2, 6)),
    _ll("14-72", _lg(7, 2)),
    _ll("14-27", _lg(2, 7)),
    _ll("16g", _lg(4, 4)),
    _ll("16-82", _lg(8, 2)),
    _ll("16-28", _lg(2, 8))
  ];
  function layoutById(id) {
    var i;
    for (i = 0; i < CHART_LAYOUTS.length; i++) {
      if (CHART_LAYOUTS[i].id === id) return CHART_LAYOUTS[i];
    }
    return CHART_LAYOUTS[0];
  }
  function migrateSavedLayout(saved) {
    if (saved && typeof saved === "object" && saved.id) return layoutById(saved.id).id;
    if (saved === 2 || saved === "2") return "2v";
    if (saved === 3 || saved === "3") return "3v";
    if (saved === 4 || saved === "4") return "4g";
    if (typeof saved === "string") return layoutById(saved).id;
    return "1";
  }
  function layoutIsRegular(L) {
    if (!L || L.n !== L.cols * L.rows) return false;
    var i;
    for (i = 0; i < L.cells.length; i++) {
      if (L.cells[i].cs !== 1 || L.cells[i].rs !== 1) return false;
    }
    return true;
  }

  function makeSlotState(i) {
    return {
      idx: i,
      container: null,
      legendEl: null,
      titleEl: null,
      metaHostEl: null,
      intervalEl: null,
      quoteEl: null,
      ohlcSlotEl: null,
      indCountEl: null,
      chart: null,
      activeIndicators: [],
      overlayIds: [],
      selectedOverlayId: null,
      excelOverlayIds: [],
      excelOverlayData: [],
      loadedDrawKey: "",
      drawingCache: {},
      candleType: "candle_solid",
      pyLineData: {},
      pyCoveredN: 0,
      pyCoveredFirst: null,
      chartGen: 0,
      /* per-chart independent state */
      instrument: null,
      interval: "1",
      rawBars: [],
      prevClose: null,
      lastBarTime: null,
      liveSub: false,
      histMore: true,
      histLoading: false,
      refreshing: false,
      refreshTimer: null,
      refreshInterval: 0,
      replay: { active: false, picking: false, playing: false, index: -1, startIndex: 0, speed: 1, timer: null, viewSnap: null }
    };
  }

  /* Copy the current module globals into the active slot (persist + detach-safe). */
  function commitSlotGlobals() {
    var s = chartSlots[_curSlot];
    if (!s) return;
    s.chart = chart;
    s.chartGen = _chartGen;
    s.container = chartContainer;
    s.legendEl = s.legendEl || (chartContainer && chartContainer.parentElement
      ? chartContainer.parentElement.querySelector(".chart-ind-legend") : null);
    s.instrument = selectedInstrument;
    s.interval = activeInterval;
    s.rawBars = _rawBars;
    s.prevClose = _prevClose;
    s.lastBarTime = _lastBarTime;
    s.liveSub = _liveSub;
    s.histMore = _histMore;
    s.histLoading = _histLoading;
    s.refreshTimer = _refreshTimer;
    s.refreshInterval = _refreshInterval;
    s.pyCoveredN = _pyCoveredN;
    s.pyCoveredFirst = _pyCoveredFirst;
    s.candleType = _candleType;
    s.selectedOverlayId = selectedOverlayId;
    s.loadedDrawKey = _loadedDrawKey;
    s.replay = _replay;
    /* persist slot meta (instrument + interval) for reload restore */
    var metas = [];
    chartSlots.forEach(function (slot) {
      metas.push(slot.instrument ? { instrument: slot.instrument, interval: slot.interval } : null);
    });
    storageSet(LS_SLOTMETA, metas);
  }

  function slotIndKey() {
    return _curSlot === 0 ? LS_INDS : LS_INDS + "." + _curSlot;
  }
  function slotCtypeKey() {
    return ctypeKeyFor(_curSlot);
  }
  function ctypeKeyFor(i) {
    return i === 0 ? LS_CTYPE : LS_CTYPE + "." + i;
  }
  function resolveCandleType(saved, fallback) {
    if (typeof saved === "string" && CANDLE_TYPES.some(function (t) { return t.id === saved; })) return saved;
    return fallback || "candle_solid";
  }
  function activeLegendEl() {
    var s = chartSlots[activeSlot];
    return (s && s.legendEl) ? s.legendEl : document.getElementById("chart-ind-legend");
  }

  /* Point the module globals at a slot's state (no UI side-effects).
     Before switching, writes the current globals back into the slot so
     in-place mutations (indicators, drawings, py line data, etc.) are kept.
     Pass skipCommit=true only during init when globals are still empty. */
  function _useSlot(i, skipCommit) {
    if (!skipCommit) commitSlotGlobals();
    var s = chartSlots[i];
    if (!s) return;
    _curSlot = i;
    chart = s.chart;
    chartContainer = s.container;
    activeIndicators = s.activeIndicators;
    overlayIds = s.overlayIds;
    selectedOverlayId = s.selectedOverlayId;
    _excelOverlayIds = s.excelOverlayIds;
    _excelOverlayData = s.excelOverlayData;
    _loadedDrawKey = s.loadedDrawKey;
    _candleType = s.candleType;
    _pyLineData = s.pyLineData;
    _pyCoveredN = s.pyCoveredN;
    _pyCoveredFirst = s.pyCoveredFirst;
    _chartGen = s.chartGen;
    selectedInstrument = s.instrument;
    activeInterval = s.interval;
    _rawBars = s.rawBars;
    _prevClose = s.prevClose;
    _lastBarTime = s.lastBarTime;
    _liveSub = s.liveSub;
    _histMore = s.histMore;
    _histLoading = s.histLoading;
    _refreshTimer = s.refreshTimer;
    _refreshInterval = s.refreshInterval;
    _replay = s.replay;
  }

  function bindSlotInstance() {
    var s = chartSlots[_curSlot];
    if (!s) return;
    s.chart = chart;
    s.chartGen = _chartGen;
    s.container = chartContainer;
    s.pyCoveredN = _pyCoveredN;
    s.pyCoveredFirst = _pyCoveredFirst;
  }

  function focusActiveSlot() {
    if (_curSlot !== activeSlot && chartSlots[activeSlot]) _useSlot(activeSlot);
  }
  function withSlot(idx, fn) {
    if (idx == null || !chartSlots[idx]) return fn();
    if (idx === _curSlot) return fn();
    var prev = _curSlot;
    _useSlot(idx);
    try {
      return fn();
    } finally {
      if (chartSlots[prev]) _useSlot(prev);
      else if (chartSlots[activeSlot]) _useSlot(activeSlot);
    }
  }
  function intervalLabel(iv) {
    var list = _brokerIntervals[activeBroker] || (activeBroker === "excel" ? EXCEL_CHART_INTERVALS : FALLBACK_INTERVALS);
    var i;
    for (i = 0; i < list.length; i++) {
      if (list[i].id === iv) return list[i].label || list[i].id;
    }
    return iv || "";
  }
  function slotWatermarkText(s) {
    if (!s || !s.instrument) return "";
    return s.instrument.trading_symbol || "";
  }
  function slotTitleText(s) {
    if (!s || !s.instrument) return "";
    return s.instrument.trading_symbol || "";
  }
  function setActiveSlot(i) {
    if (i < 0 || i >= chartSlots.length || i >= splitCount) return;
    var switching = i !== activeSlot;
    var tool = activeDraw;
    if (switching) {
      clearPendingDraw();
      unsubscribeLive();
    }
    _useSlot(i);
    activeSlot = i;
    document.querySelectorAll(".chart-slot").forEach(function (el) {
      var idx = parseInt(el.getAttribute("data-slot"), 10);
      el.classList.toggle("active", idx === i);
    });
    positionChartMessage();
    positionChartMeta();
    syncToolbarToSlot();
    updateCandleTypeButton();
    renderChartLegend();
    renderIndicatorPop();
    updateSlotIndCounts();
    updateSlotTickers();
    updateReplayUi();
    if (selectedInstrument && activeBroker === "5paisa" && !intervalCfg(activeInterval).resample) {
      subscribeLive();
    }
    if (switching && tool && tool !== "cursor") {
      startDrawing(tool);
    }
    requestAnimationFrame(function () {
      if (chartSlots[activeSlot] && chartSlots[activeSlot].chart) {
        try { chartSlots[activeSlot].chart.setStyles(klineStyles()); } catch (_) {}
        try { chartSlots[activeSlot].chart.resize(); } catch (_) {}
      }
    });
  }

  /* Reflect the active slot's stock/timeframe in the toolbar + meta. */
  function syncToolbarToSlot() {
    var s = chartSlots[activeSlot];
    if (!s) return;
    if (searchInput) {
      searchInput.value = s.instrument
        ? (s.instrument.trading_symbol + " \u2014 " + (s.instrument.name || ""))
        : "";
    }
    renderIntervalButtons();
    if (symbolLabel) symbolLabel.textContent = "";
    syncSlotHeaderMeta(s);
    syncPrevClose();
    if (s.rawBars && s.rawBars.length) refreshLiveQuote();
    else {
      updateLiveQuote(NaN);
      if (ohlcEl) ohlcEl.innerHTML = "";
    }
    var msg = document.getElementById("chart-message");
    if (msg) {
      if (!s.instrument || !s.rawBars.length) {
        msg.textContent = "Select a stock and click Load Chart";
        msg.style.display = "flex";
      } else {
        msg.style.display = "none";
      }
    }
    positionChartMeta();
    updateSlotTickers();
    updateReplayUi();
  }

  /* Clear the ACTIVE slot's instrument/data only (used on explicit broker
     tab clicks so the selected chart starts fresh; other charts keep theirs).
     Auto broker-connect events must NOT call this, or they wipe restored
     charts on page load. */
  function clearActiveSlotInstrument() {
    var s = chartSlots[_curSlot];
    if (s) {
      s.instrument = null;
      s.rawBars.length = 0;
      s.prevClose = null;
      s.lastBarTime = null;
      s.liveSub = false;
      s.histMore = activeBroker !== "excel";
      s.histLoading = false;
      s.refreshing = false;
      if (s.refreshTimer) { clearInterval(s.refreshTimer); s.refreshTimer = null; }
      s.replay = { active: false, picking: false, playing: false, index: -1, startIndex: 0, speed: 1, timer: null, viewSnap: null };
    }
    selectedInstrument = null;
    _liveSub = false;
    _refreshTimer = null;
    if (searchInput) searchInput.value = "";
    if (dropdown) {
      dropdown.innerHTML = "";
      dropdown.classList.add("hidden");
    }
    var t = document.getElementById("live-badge");
    if (t) t.style.display = "none";
    commitSlotGlobals();
  }

  /* Keep the loading/error message overlaid on the active chart only. */
  function positionChartMessage() {
    var msg = document.getElementById("chart-message");
    if (!msg) return;
    var s = chartSlots[activeSlot];
    var host = (s && s.container) ? s.container.parentElement : null;
    if (host && msg.parentElement !== host) host.appendChild(msg);
  }

  function positionChartMeta() {
    /* Per-tile HUD owns interval/CMP/OHLC — keep shared #chart-meta off-screen. */
    if (!chartMeta) return;
    chartMeta.classList.add("hidden");
    chartMeta.classList.remove("in-slot");
  }

  function ensureSlotMetaDom(s) {
    if (!s || !s.metaHostEl) return;
    if (s.intervalEl && s.quoteEl && s.ohlcSlotEl) return;
    s.metaHostEl.innerHTML = "";
    var iv = document.createElement("span");
    iv.className = "chart-interval-label chart-slot-interval";
    var q = document.createElement("span");
    q.className = "chart-live-quote chart-slot-quote";
    var o = document.createElement("span");
    o.className = "chart-slot-ohlc";
    s.metaHostEl.appendChild(iv);
    s.metaHostEl.appendChild(q);
    s.metaHostEl.appendChild(o);
    s.intervalEl = iv;
    s.quoteEl = q;
    s.ohlcSlotEl = o;
  }

  function quoteHtml(price, prevClose) {
    price = Number(price);
    if (!isFinite(price)) return "";
    var cls = "";
    var chgHtml = "";
    if (prevClose != null && isFinite(prevClose) && prevClose !== 0) {
      var ch = price - prevClose;
      var pct = (ch / Math.abs(prevClose)) * 100;
      cls = ch > 0 ? "up" : (ch < 0 ? "down" : "flat");
      var sign = ch > 0 ? "+" : "";
      chgHtml = "<span class=\"chart-live-chg " + cls + "\">" + sign + fmtPx(ch) + " (" + sign + pct.toFixed(2) + "%)</span>";
    }
    return "<span class=\"chart-live-last" + (cls ? " " + cls : "") + "\">" + fmtPx(price) + "</span>" + chgHtml;
  }

  function ohlcHtml(d) {
    if (!d || d.close == null) return "";
    return (
      "<span class=\"ohlc-o\">O <b>" + Number(d.open).toFixed(2) + "</b></span>" +
      "<span class=\"ohlc-h\">H <b>" + Number(d.high).toFixed(2) + "</b></span>" +
      "<span class=\"ohlc-l\">L <b>" + Number(d.low).toFixed(2) + "</b></span>" +
      "<span class=\"ohlc-c\">C <b>" + Number(d.close).toFixed(2) + "</b></span>" +
      (d.volume ? "<span class=\"ohlc-v\">V <b>" + Number(d.volume).toLocaleString() + "</b></span>" : "")
    );
  }

  function setSlotOhlc(s, d) {
    if (!s) return;
    ensureSlotMetaDom(s);
    if (s.ohlcSlotEl) s.ohlcSlotEl.innerHTML = ohlcHtml(d);
  }

  function setSlotQuote(s, price, prevClose) {
    if (!s) return;
    ensureSlotMetaDom(s);
    if (s.quoteEl) s.quoteEl.innerHTML = quoteHtml(price, prevClose);
  }

  function syncSlotHeaderMeta(s) {
    s = s || chartSlots[activeSlot];
    if (!s) return;
    ensureSlotMetaDom(s);
    if (s.intervalEl) {
      s.intervalEl.textContent = (s.instrument) ? intervalLabel(s.interval || "") : "";
    }
  }

  function updateSlotTickers() {
    var i;
    for (i = 0; i < chartSlots.length; i++) {
      var s = chartSlots[i];
      if (!s || !s.titleEl) continue;
      var on = i < splitCount;
      s.titleEl.style.display = on ? "" : "none";
      if (!on) {
        if (s.metaHostEl) s.metaHostEl.style.display = "none";
        continue;
      }
      if (s.metaHostEl) s.metaHostEl.style.display = "";
      ensureSlotMetaDom(s);
      s.titleEl.textContent = slotTitleText(s);
      if (s.intervalEl) {
        s.intervalEl.textContent = s.instrument ? intervalLabel(s.interval || "") : "";
      }
      var bars = s.rawBars || [];
      if (!s.instrument || !bars.length) {
        if (s.quoteEl) s.quoteEl.innerHTML = "";
        if (s.ohlcSlotEl) s.ohlcSlotEl.innerHTML = "";
        continue;
      }
      var last = bars[bars.length - 1];
      var prev = s.prevClose != null ? s.prevClose : prevCloseFromBars(bars);
      setSlotQuote(s, last.close, prev);
      setSlotOhlc(s, last);
    }
  }

  function updateSlotIndCounts() {
    for (var i = 0; i < chartSlots.length; i++) {
      var s = chartSlots[i];
      if (s && s.indCountEl) {
        var n = s.activeIndicators ? s.activeIndicators.length : 0;
        s.indCountEl.textContent = n ? n + " ind" : "";
      }
    }
  }

  /* ── Split layout: CSS-grid tracks + drag-resize + drag-move ── */
  var _rowFracs = [1];
  var _colFracs = [1];
  var _slotDrag = null;

  function resetSplitFractions(L) {
    var layout = L && L.cols ? L : layoutById(splitLayoutId);
    _colFracs = [];
    _rowFracs = [];
    var c, r;
    for (c = 0; c < layout.cols; c++) _colFracs.push(1 / layout.cols);
    for (r = 0; r < layout.rows; r++) _rowFracs.push(1 / layout.rows);
  }

  function trackTemplate(fracs) {
    var parts = [];
    var i;
    for (i = 0; i < fracs.length; i++) {
      if (i) parts.push("6px");
      parts.push("minmax(0, " + (fracs[i] || (1 / Math.max(1, fracs.length))) + "fr)");
    }
    return parts.join(" ");
  }

  /* Rebuild the stage grid: template tracks, slot placement, resizers. */
  function applySplitLayout() {
    var stage = document.getElementById("chart-stage");
    if (!stage) return;
    var L = layoutById(splitLayoutId);
    var regular = layoutIsRegular(L);
    if (_colFracs.length !== L.cols || _rowFracs.length !== L.rows) resetSplitFractions(L);
    stage.classList.toggle("layout-multi", L.n > 1);
    stage.classList.toggle("layout-n-1", L.n === 1);
    stage.classList.toggle("grid-regular", regular);
    if (regular) {
      stage.style.gap = "0";
      stage.style.gridTemplateColumns = trackTemplate(_colFracs);
      stage.style.gridTemplateRows = trackTemplate(_rowFracs);
    } else {
      stage.style.gap = "6px";
      stage.style.gridTemplateColumns = _colFracs.map(function (f) { return "minmax(0, " + f + "fr)"; }).join(" ");
      stage.style.gridTemplateRows = _rowFracs.map(function (f) { return "minmax(0, " + f + "fr)"; }).join(" ");
    }

    stage.querySelectorAll(".chart-slot").forEach(function (el) {
      el.style.gridColumn = "";
      el.style.gridRow = "";
      el.classList.remove("dragging", "drop-target");
    });
    var j;
    for (j = 0; j < splitCount; j++) {
      var el = stage.querySelector('.chart-slot[data-slot="' + j + '"]');
      if (!el) continue;
      var cell = L.cells[j];
      if (!cell) continue;
      if (regular) {
        el.style.gridColumn = String((cell.c - 1) * 2 + 1) + " / span " + (cell.cs * 2 - 1);
        el.style.gridRow = String((cell.r - 1) * 2 + 1) + " / span " + (cell.rs * 2 - 1);
      } else {
        el.style.gridColumn = cell.c + " / span " + cell.cs;
        el.style.gridRow = cell.r + " / span " + cell.rs;
      }
    }

    stage.querySelectorAll(".chart-slot-resizer").forEach(function (el) { el.remove(); });
    if (regular && L.n >= 2) {
      var k;
      for (k = 0; k < L.cols - 1; k++) {
        var vd = document.createElement("div");
        vd.className = "chart-slot-resizer chart-slot-resizer-col";
        vd.dataset.axis = "col";
        vd.dataset.between = String(k);
        vd.style.gridColumn = String(k * 2 + 2);
        vd.style.gridRow = "1 / -1";
        stage.appendChild(vd);
      }
      for (k = 0; k < L.rows - 1; k++) {
        var hd = document.createElement("div");
        hd.className = "chart-slot-resizer chart-slot-resizer-row";
        hd.dataset.axis = "row";
        hd.dataset.between = String(k);
        hd.style.gridColumn = "1 / -1";
        hd.style.gridRow = String(k * 2 + 2);
        stage.appendChild(hd);
      }
      bindSlotResizers();
    }
    forEachChart(function (c) {
      try { c.resize(); } catch (_) {}
    });
    positionChartMessage();
    updateSlotIndCounts();
  }

  function bindSlotResizers() {
    var stage = document.getElementById("chart-stage");
    if (!stage) return;
    stage.querySelectorAll(".chart-slot-resizer").forEach(function (res) {
      if (res._bound) return;
      res._bound = true;
      res.addEventListener("pointerdown", function (e) {
        if (e.button != null && e.button !== 0 && e.pointerType === "mouse") return;
        e.preventDefault();
        e.stopPropagation();
        res.classList.add("active");
        var axis = res.dataset.axis;
        var between = parseInt(res.dataset.between, 10);
        var startPos = axis === "row" ? e.clientY : e.clientX;
        var base = axis === "row" ? _rowFracs.slice() : _colFracs.slice();
        function onMove(ev) {
          var stageEl = document.getElementById("chart-stage");
          var total = axis === "row" ? (stageEl.clientHeight || 1) : (stageEl.clientWidth || 1);
          var dFrac = ((axis === "row" ? ev.clientY : ev.clientX) - startPos) / total;
          if (!isFinite(between) || between < 0 || between + 1 >= base.length) return;
          var sum = base[between] + base[between + 1];
          var minShare = Math.min(0.12, sum * 0.2);
          var lo = Math.max(minShare, sum - (1 - minShare));
          var hi = Math.min(sum - minShare, sum - minShare);
          var f2 = Math.max(lo, Math.min(hi, base[between] + dFrac));
          var a = f2;
          var b = Math.max(minShare, sum - f2);
          var s2 = a + b;
          a *= sum / s2;
          b *= sum / s2;
          if (axis === "row") { _rowFracs[between] = a; _rowFracs[between + 1] = b; }
          else { _colFracs[between] = a; _colFracs[between + 1] = b; }
          applySplitLayout();
        }
        function onUp() {
          res.classList.remove("active");
          window.removeEventListener("pointermove", onMove);
          window.removeEventListener("pointerup", onUp);
        }
        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onUp);
      });
    });
  }

  function reorderSlotDOM() {
    var stage = document.getElementById("chart-stage");
    if (!stage) return;
    var els = [];
    chartSlots.forEach(function (s) {
      var el = stage.querySelector('.chart-slot[data-slot="' + s.idx + '"]');
      if (el) els.push(el);
    });
    els.forEach(function (el) { stage.appendChild(el); });
    els.forEach(function (el, i) {
      el.setAttribute("data-slot", String(i));
    });
    chartSlots.forEach(function (s, i) { s.idx = i; });
  }

  /* Swap the positions of two slots (drag a chart header onto another). */
  function swapSlots(a, b) {
    if (a === b || a < 0 || b < 0 || a >= splitCount || b >= splitCount) return;
    var tmp = chartSlots[a];
    chartSlots[a] = chartSlots[b];
    chartSlots[b] = tmp;
    var newActive = activeSlot;
    if (activeSlot === a) newActive = b;
    else if (activeSlot === b) newActive = a;
    reorderSlotDOM();
    applySplitLayout();
    activeSlot = newActive;
    _curSlot = newActive; /* globals already point at the active slot's state */
    document.querySelectorAll(".chart-slot").forEach(function (el, i) {
      el.classList.toggle("active", i === activeSlot);
    });
    updateSlotIndCounts();
  }

  function bindSlotReorder() {
    var stage = document.getElementById("chart-stage");
    if (!stage || stage._reorderBound) return;
    stage._reorderBound = true;
    stage.addEventListener("pointerdown", function (e) {
      if (e.button != null && e.button !== 0 && e.pointerType === "mouse") return;
      var head = e.target && e.target.closest
        ? (e.target.closest(".chart-ind-legend") || e.target.closest(".chart-meta"))
        : null;
      if (!head) return;
      var wrap = head.closest(".chart-slot");
      var fromIdx = parseInt(wrap.getAttribute("data-slot"), 10);
      if (!isFinite(fromIdx) || fromIdx < 0 || fromIdx >= splitCount) return;
      _slotDrag = { fromIdx: fromIdx, startX: e.clientX, startY: e.clientY, active: false };
      function onMove(ev) {
        if (!_slotDrag) return;
        var dx = ev.clientX - _slotDrag.startX;
        var dy = ev.clientY - _slotDrag.startY;
        if (!_slotDrag.active && dx * dx + dy * dy > 25) _slotDrag.active = true;
        if (!_slotDrag.active) return;
        wrap.classList.add("dragging");
        var under = document.elementFromPoint(ev.clientX, ev.clientY);
        var tw = under && under.closest ? under.closest(".chart-slot") : null;
        var targetIdx = tw ? parseInt(tw.getAttribute("data-slot"), 10) : -1;
        document.querySelectorAll(".chart-slot.drop-target").forEach(function (x) {
          x.classList.remove("drop-target");
        });
        if (tw && isFinite(targetIdx) && targetIdx !== fromIdx) tw.classList.add("drop-target");
        _slotDrag.targetIdx = (tw && isFinite(targetIdx) && targetIdx !== fromIdx) ? targetIdx : null;
      }
      function onUp() {
        if (!_slotDrag) return;
        var wasActive = _slotDrag.active;
        var to = _slotDrag.targetIdx;
        _slotDrag = null;
        wrap.classList.remove("dragging");
        document.querySelectorAll(".chart-slot.drop-target").forEach(function (x) {
          x.classList.remove("drop-target");
        });
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        if (wasActive && to != null && to !== fromIdx) swapSlots(fromIdx, to);
      }
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    });
  }

  /* Run fn for every live chart instance. */
  function forEachChart(fn) {
    for (var i = 0; i < splitCount; i++) {
      var s = chartSlots[i];
      if (s && s.chart && fn) {
        try { fn(s.chart, i); } catch (_) {}
      }
    }
  }

  /* Rebuild (or create) the klinecharts instance for every visible slot. */
  function ensureSlotCharts() {
    for (var i = 0; i < splitCount; i++) {
      if (!chartSlots[i].chart) {
        _useSlot(i);
        initChart();
        bindSlotInstance();
        chartSlots[i].chart = chart;
        chartSlots[i].chartGen = _chartGen;
      }
    }
    if (activeSlot >= splitCount) activeSlot = 0;
    setActiveSlot(activeSlot);
  }

  function ensureSlotDOM(n) {
    var stage = document.getElementById("chart-stage");
    if (!stage) return;
    for (var i = chartSlots.length; i < n; i++) {
      var s = makeSlotState(i);
      var src = chartSlots[activeSlot] || chartSlots[0];
      var inheritType = (src && src.candleType) || _candleType;
      s.candleType = resolveCandleType(storageGet(ctypeKeyFor(i), null), inheritType);
      var wrap = document.createElement("div");
      wrap.className = "chart-slot" + (i === activeSlot ? " active" : "");
      wrap.setAttribute("data-slot", String(i));
      var body = document.createElement("div");
      body.className = "chart-slot-body";
      var ticker = document.createElement("div");
      ticker.className = "chart-slot-ticker";
      var hud = document.createElement("div");
      hud.className = "chart-slot-hud";
      var titleRow = document.createElement("div");
      titleRow.className = "chart-slot-title-row";
      var title = document.createElement("span");
      title.className = "chart-slot-title";
      var metaHost = document.createElement("span");
      metaHost.className = "chart-slot-meta-host";
      titleRow.appendChild(title);
      titleRow.appendChild(metaHost);
      var legend = document.createElement("div");
      legend.className = "chart-ind-legend hidden";
      hud.appendChild(titleRow);
      hud.appendChild(legend);
      var canvas = document.createElement("div");
      canvas.className = "chart-slot-canvas";
      canvas.id = "chart-container-" + i;
      body.appendChild(ticker);
      body.appendChild(hud);
      body.appendChild(canvas);
      wrap.appendChild(body);
      var hint = document.getElementById("chart-replay-hint");
      stage.insertBefore(wrap, hint);
      s.container = canvas;
      s.legendEl = legend;
      s.tickerEl = ticker;
      s.titleEl = title;
      s.metaHostEl = metaHost;
      ensureSlotMetaDom(s);
      s.indCountEl = null;
      chartSlots.push(s);
    }
    for (var j = 0; j < chartSlots.length; j++) {
      var el = stage.querySelector('.chart-slot[data-slot="' + j + '"]');
      if (!el) continue;
      if (j >= n) {
        el.classList.add("slot-hidden");
        if (chartSlots[j].chart) {
          try { klinecharts.dispose(chartSlots[j].container); } catch (_) {}
          chartSlots[j].chart = null;
        }
        if (_curSlot === j) {
          chart = null;
          _curSlot = -1;
        }
      } else {
        el.classList.remove("slot-hidden");
      }
    }
    splitCount = n;
  }

  function persistLayoutSync() {
    storageSet(LS_SYNC, layoutSync);
  }

  function applyChartLayout(id) {
    var L = layoutById(id);
    if (!L) return;
    var n = Math.max(1, Math.min(MAX_SLOTS, L.n));
    if (splitLayoutId === L.id && splitCount === n) {
      renderSplitPop();
      return;
    }
    var prevCount = splitCount;
    persistVisibleDrawings();
    commitSlotGlobals();
    ensureSlotDOM(n);
    splitLayoutId = L.id;
    splitCount = n;
    /* New panes inherit candle colors/style from the chart being split. */
    var src = chartSlots[activeSlot] || chartSlots[0];
    var srcType = (src && src.candleType) || _candleType;
    var ni;
    for (ni = prevCount; ni < n; ni++) {
      if (!chartSlots[ni]) continue;
      chartSlots[ni].candleType = srcType;
      storageSet(ctypeKeyFor(ni), srcType);
      if (layoutSync.symbol && src) {
        chartSlots[ni].interval = src.interval || activeInterval;
        if (src.instrument) chartSlots[ni].instrument = src.instrument;
      }
    }
    if (activeSlot >= splitCount) activeSlot = 0;
    resetSplitFractions(L);
    applySplitLayout();
    storageSet(LS_SPLIT, L.id);
    ensureSlotCharts();
    if (window._chartApplyTheme) window._chartApplyTheme();
    if (layoutSync.symbol || layoutSync.interval) syncVisibleSlotsWithLayout();
    renderSplitPop();
  }

  function layoutIconSvg(L) {
    var w = 22, h = 16, pad = 1.15, gap = 1.05;
    var innerW = w - pad * 2;
    var innerH = h - pad * 2;
    var rects = "";
    var i;
    for (i = 0; i < L.cells.length; i++) {
      var cell = L.cells[i];
      var x = pad + ((cell.c - 1) / L.cols) * innerW;
      var y = pad + ((cell.r - 1) / L.rows) * innerH;
      var rw = (cell.cs / L.cols) * innerW - gap;
      var rh = (cell.rs / L.rows) * innerH - gap;
      if (rw < 1.4) rw = 1.4;
      if (rh < 1.4) rh = 1.4;
      rects += '<rect x="' + x.toFixed(2) + '" y="' + y.toFixed(2) + '" width="' + rw.toFixed(2) +
        '" height="' + rh.toFixed(2) + '" rx="0.55"/>';
    }
    return '<svg class="layout-icon" viewBox="0 0 ' + w + ' ' + h + '" aria-hidden="true">' + rects + "</svg>";
  }

  var SYNC_HELP = {
    symbol: "Keep the same symbol on every chart in this layout.",
    interval: "Keep the same timeframe on every chart in this layout.",
    crosshair: "Move the crosshair together across all charts.",
    time: "Keep the same time aligned as you scroll.",
    dateRange: "Keep the same visible date range and zoom on every chart."
  };

  function renderSplitPop() {
    var pop = document.getElementById("split-pop");
    if (!pop) return;
    var groups = [];
    var lastN = -1;
    var g = null;
    CHART_LAYOUTS.forEach(function (L) {
      if (L.n !== lastN) {
        g = { n: L.n, items: [] };
        groups.push(g);
        lastN = L.n;
      }
      g.items.push(L);
    });
    var html = '<div class="layout-grid">';
    groups.forEach(function (row) {
      html += '<div class="layout-row"><span class="layout-n">' + row.n + "</span><div class=\"layout-icons\">";
      row.items.forEach(function (L) {
        html += '<button type="button" class="layout-pick' + (L.id === splitLayoutId ? " on" : "") +
          '" data-layout="' + L.id + '" title="' + L.n + ' chart' + (L.n > 1 ? "s" : "") + '">' +
          layoutIconSvg(L) + "</button>";
      });
      html += "</div></div>";
    });
    html += '</div><div class="layout-sync">';
    html += '<div class="layout-sync-title">Sync in layout</div>';
    ["symbol", "interval", "crosshair", "time", "dateRange"].forEach(function (key) {
      var label = key === "dateRange" ? "Date range" : key.charAt(0).toUpperCase() + key.slice(1);
      html += '<div class="layout-sync-row">' +
        '<span class="layout-sync-label">' + label +
        '<span class="layout-sync-info" title="' + SYNC_HELP[key] + '">i</span></span>' +
        '<label class="toggle-switch layout-sync-toggle">' +
        '<input type="checkbox" data-sync="' + key + '"' + (layoutSync[key] ? " checked" : "") + " />" +
        '<span class="toggle-slider"></span></label></div>';
    });
    html += "</div>";
    pop.innerHTML = html;
    if (!pop._stopBound) {
      pop._stopBound = true;
      pop.addEventListener("click", function (e) { e.stopPropagation(); });
    }
    pop.querySelectorAll("[data-layout]").forEach(function (b) {
      b.addEventListener("click", function (e) {
        e.stopPropagation();
        applyChartLayout(b.getAttribute("data-layout"));
        pop.classList.add("hidden");
      });
    });
    pop.querySelectorAll("[data-sync]").forEach(function (inp) {
      inp.addEventListener("click", function (e) { e.stopPropagation(); });
      inp.addEventListener("change", function (e) {
        e.stopPropagation();
        var key = inp.getAttribute("data-sync");
        layoutSync[key] = !!inp.checked;
        persistLayoutSync();
        if (key === "symbol" && layoutSync.symbol && selectedInstrument) {
          applySymbolToLayout(selectedInstrument);
          loadSyncedSlots(activeSlot);
        }
        if (key === "interval" && layoutSync.interval) {
          var ii;
          for (ii = 0; ii < splitCount; ii++) {
            if (chartSlots[ii]) chartSlots[ii].interval = activeInterval;
          }
          commitSlotGlobals();
          updateSlotTickers();
          if (selectedInstrument) loadSyncedSlots(activeSlot);
        }
      });
    });
  }

  function applySymbolToLayout(item) {
    if (!item) return;
    var i;
    for (i = 0; i < splitCount; i++) {
      if (chartSlots[i]) chartSlots[i].instrument = item;
    }
    if (_curSlot >= 0 && _curSlot < splitCount) selectedInstrument = item;
    commitSlotGlobals();
    updateSlotTickers();
  }

  function instrumentsMatch(a, b) {
    var pa = instrumentKeyParts(a);
    var pb = instrumentKeyParts(b);
    if (!pa || !pb) return false;
    if (pa.id && pb.id) return pa.id === pb.id;
    return !!(pa.sym && pb.sym && pa.sym === pb.sym);
  }

  function copySeriesToSlot(srcIdx, dstIdx) {
    var src = chartSlots[srcIdx];
    var dst = chartSlots[dstIdx];
    if (!src || !dst || !dst.chart) return;
    dst.rawBars = (src.rawBars || []).map(function (b) {
      return {
        timestamp: b.timestamp, open: b.open, high: b.high, low: b.low, close: b.close,
        volume: b.volume || 0
      };
    });
    dst.prevClose = src.prevClose;
    dst.lastBarTime = src.lastBarTime;
    dst.histMore = src.histMore;
    dst.histLoading = false;
    dst.excelOverlayData = src.excelOverlayData;
    _useSlot(dstIdx);
    applyChartContainerTheme(dst.container);
    applyChartData(displaySeries(visibleRawBars()), dst.histMore !== false);
    try { dst.chart.setStyles(klineStyles()); } catch (_) {}
    try { dst.chart.resize(); } catch (_) {}
    setSlotOhlc(dst, dst.rawBars.length ? dst.rawBars[dst.rawBars.length - 1] : null);
  }

  function syncVisibleSlotsWithLayout() {
    var srcIdx = activeSlot;
    var src = chartSlots[srcIdx];
    if (!src) return;
    if (layoutSync.symbol && src.instrument) applySymbolToLayout(src.instrument);
    if (layoutSync.interval) {
      var ii;
      for (ii = 0; ii < splitCount; ii++) {
        if (chartSlots[ii]) chartSlots[ii].interval = src.interval || activeInterval;
      }
    }
    if (!layoutSync.symbol && !layoutSync.interval) return;
    var cloned = {};
    var i;
    for (i = 0; i < splitCount; i++) {
      if (i === srcIdx) continue;
      var s = chartSlots[i];
      if (!s || !s.chart || !s.instrument) continue;
      var sameSym = instrumentsMatch(s.instrument, src.instrument);
      var sameIv = String(s.interval || "1") === String(src.interval || "1");
      if (sameSym && sameIv && src.rawBars && src.rawBars.length) {
        copySeriesToSlot(srcIdx, i);
        cloned[i] = true;
      }
    }
    _useSlot(srcIdx);
    updateSlotTickers();
    var needFetch = false;
    for (i = 0; i < splitCount; i++) {
      if (i === srcIdx || cloned[i]) continue;
      if (chartSlots[i] && chartSlots[i].instrument) { needFetch = true; break; }
    }
    if (needFetch) loadSyncedSlots(srcIdx, cloned);
  }

  function loadSyncedSlots(exceptIdx, skipMap) {
    if (_layoutSyncBusy) return;
    if (!layoutSync.symbol && !layoutSync.interval) return;
    var jobs = [];
    var i;
    for (i = 0; i < splitCount; i++) {
      if (i === exceptIdx) continue;
      if (skipMap && skipMap[i]) continue;
      if (!chartSlots[i] || !chartSlots[i].instrument) continue;
      jobs.push(i);
    }
    if (!jobs.length) return;
    _layoutSyncBusy = true;
    var origin = activeSlot;
    Promise.all(jobs.map(function (idx) {
      var s = chartSlots[idx];
      var iv = s.interval || "1";
      var toDate = dateIST(Date.now());
      var fromDate = shiftDate(toDate, -lookbackDays(iv));
      var yrange = clampYahooRange(fromDate, toDate, iv);
      return fetchCandlesFor(s.instrument, iv, yrange.fromDate, toDate)
        .then(function (pack) { return { idx: idx, pack: pack }; })
        .catch(function () { return null; });
    })).then(function (results) {
      var chain = Promise.resolve();
      results.forEach(function (r) {
        if (!r || !r.pack) return;
        chain = chain.then(function () {
          return loadChartData(false, { slot: r.idx, prefetched: r.pack, syncLoad: true });
        });
      });
      return chain;
    }).then(function () {
      if (chartSlots[origin]) _useSlot(origin);
      else if (chartSlots[activeSlot]) _useSlot(activeSlot);
      updateSlotTickers();
      schedulePyRefresh(true);
    }).finally(function () {
      _layoutSyncBusy = false;
    });
  }

  /* Reload every on-screen slot that already has an instrument (skip empties).
     Network fetches run in parallel; chart applies stay ordered. */
  var _homeShowRefreshing = false;
  function refreshVisibleSlots() {
    if (_homeShowRefreshing || _layoutSyncBusy) return;
    var jobs = [];
    var i;
    for (i = 0; i < splitCount; i++) {
      if (!chartSlots[i] || !chartSlots[i].instrument) continue;
      jobs.push(i);
    }
    if (!jobs.length) return;
    _homeShowRefreshing = true;
    var origin = activeSlot;
    Promise.all(jobs.map(function (idx) {
      var s = chartSlots[idx];
      var iv = s.interval || "1";
      var toDate = dateIST(Date.now());
      var fromDate = shiftDate(toDate, -lookbackDays(iv));
      var yrange = clampYahooRange(fromDate, toDate, iv);
      return fetchCandlesFor(s.instrument, iv, yrange.fromDate, toDate)
        .then(function (pack) { return { idx: idx, pack: pack }; })
        .catch(function () { return null; });
    })).then(function (results) {
      var chain = Promise.resolve();
      results.forEach(function (r) {
        if (!r || !r.pack) return;
        chain = chain.then(function () {
          return loadChartData(true, { slot: r.idx, prefetched: r.pack });
        });
      });
      return chain;
    }).then(function () {
      if (chartSlots[origin]) _useSlot(origin);
      else if (chartSlots[activeSlot]) _useSlot(activeSlot);
      updateSlotTickers();
      syncToolbarToSlot();
    }).finally(function () {
      _homeShowRefreshing = false;
    });
  }

  function nearestDataIndex(list, ts) {
    if (!list || !list.length || ts == null) return -1;
    return timestampIndex(ts, list);
  }

  function syncLayoutCrosshair(srcIdx, data) {
    if (_syncingXhair || !layoutSync.crosshair || splitCount < 2) return;
    var d = data && (data.kLineData || data.data);
    var ts = d && d.timestamp;
    var srcX = data && data.x;
    var srcY = data && data.y;
    _syncingXhair = true;
    try {
      var i;
      for (i = 0; i < splitCount; i++) {
        if (i === srcIdx) continue;
        var s = chartSlots[i];
        if (!s || !s.chart || !s.chart.executeAction) continue;
        var payload = {};
        if (ts != null && s.chart.convertToPixel) {
          var list = [];
          try { list = s.chart.getDataList() || []; } catch (_) {}
          var idx = nearestDataIndex(list, ts);
          try {
            var spec = { timestamp: Number(ts) };
            if (idx >= 0) spec.dataIndex = idx;
            if (d && d.close != null) spec.value = d.close;
            var raw = s.chart.convertToPixel(spec, { paneId: "candle_pane" });
            var pt = Array.isArray(raw) ? raw[0] : raw;
            if (pt && isFinite(pt.x)) payload.x = pt.x;
            if (pt && isFinite(pt.y)) payload.y = pt.y;
          } catch (_) {}
        }
        if (payload.x == null && isFinite(srcX)) payload.x = srcX;
        if (payload.y == null && isFinite(srcY)) payload.y = srcY;
        if (payload.x == null && payload.y == null) continue;
        try { s.chart.executeAction("onCrosshairChange", payload); } catch (_) {}
      }
    } finally {
      _syncingXhair = false;
    }
  }

  function syncLayoutRange(srcIdx) {
    if (_syncingRange || splitCount < 2) return;
    if (!layoutSync.time && !layoutSync.dateRange) return;
    var src = chartSlots[srcIdx];
    if (!src || !src.chart) return;
    var snap = null;
    var prevChart = chart;
    var prevContainer = chartContainer;
    chart = src.chart;
    chartContainer = src.container;
    try { snap = captureChartView(); } catch (_) { snap = null; }
    chart = prevChart;
    chartContainer = prevContainer;
    if (!snap) return;
    if (!layoutSync.dateRange) snap.space = null;
    _syncingRange = true;
    try {
      var i;
      for (i = 0; i < splitCount; i++) {
        if (i === srcIdx) continue;
        var s = chartSlots[i];
        if (!s || !s.chart) continue;
        chart = s.chart;
        chartContainer = s.container;
        try { restoreChartView(snap); } catch (_) {}
      }
    } finally {
      chart = prevChart;
      chartContainer = prevContainer;
      _syncingRange = false;
    }
  }

  /* Initialize slot 0 from the existing DOM and point globals at it.
     Called at the bottom of the file once all vars are declared. */
  function initSlots() {
    var s0 = makeSlotState(0);
    s0.container = chartContainer;
    s0.legendEl = document.getElementById("chart-ind-legend");
    s0.tickerEl = document.querySelector('.chart-slot[data-slot="0"] .chart-slot-ticker');
    s0.titleEl = document.querySelector('.chart-slot[data-slot="0"] .chart-slot-title');
    s0.metaHostEl = document.querySelector('.chart-slot[data-slot="0"] .chart-slot-meta-host');
    ensureSlotMetaDom(s0);
    s0.indCountEl = null;
    s0.candleType = _candleType;
    chartSlots.push(s0);
    var savedSync = storageGet(LS_SYNC, null);
    if (savedSync && typeof savedSync === "object") {
      ["symbol", "interval", "crosshair", "time", "dateRange"].forEach(function (k) {
        if (typeof savedSync[k] === "boolean") layoutSync[k] = savedSync[k];
      });
    }
    splitLayoutId = migrateSavedLayout(storageGet(LS_SPLIT, 1));
    var L = layoutById(splitLayoutId);
    if (L.n > 1) {
      ensureSlotDOM(L.n);
      splitCount = L.n;
      resetSplitFractions(L);
    }
    /* Restore each slot's own instrument + interval from last session. */
    var metas = storageGet(LS_SLOTMETA, []);
    if (Array.isArray(metas)) {
      metas.forEach(function (m, i) {
        if (i >= splitCount || !m || !m.instrument) return;
        chartSlots[i].instrument = m.instrument;
        chartSlots[i].interval = m.interval || "1";
        chartSlots[i].histMore = true;
      });
    }
    _useSlot(0, true);
    applySplitLayout();
    bindSlotReorder();
    ensureSlotCharts();
    renderSplitPop();
  }

  renderIntervalButtons();

  function storageGet(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (_) { return fallback; }
  }
  function storageSet(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch (_) {}
  }
  _legendExpanded = storageGet(LS_LEGEND, false) === true;
  var _drawingCache = {};
  var _loadedDrawKey = "";
  var _saveDrawTimers = {};
  var _overlaysSuspended = false;

  function instrumentKeyParts(inst) {
    inst = inst || selectedInstrument;
    if (!inst) return null;
    var id = String(inst.scrip_code != null ? inst.scrip_code : (inst.security_id != null ? inst.security_id : ""));
    var sym = String(inst.trading_symbol || "").toUpperCase();
    var exch = String(inst.exch || inst.exchange_segment || "").toUpperCase();
    return { id: id, sym: sym, exch: exch };
  }
  function drawingStoreKey(inst, iv) {
    var parts = instrumentKeyParts(inst);
    if (!parts) return "";
    var interval = iv != null ? String(iv) : String(activeInterval || "");
    return [activeBroker, parts.exch, parts.sym, parts.id, interval].join("|");
  }
  function drawingKeyFallbacks(inst) {
    inst = inst || selectedInstrument;
    var parts = instrumentKeyParts(inst);
    if (!parts) return [];
    var base = [activeBroker, parts.exch, parts.sym, parts.id].join("|");
    var keys = [base];
    var i;
    for (i = 1; i < MAX_SLOTS; i++) keys.push(base + "|s" + i);
    keys.push(activeBroker + ":" + parts.id);
    keys.push(activeBroker + ":" + String(inst.scrip_code || inst.security_id || inst.trading_symbol || ""));
    return keys;
  }
  function forgetOverlayId(id, slotIdx) {
    if (!id) return;
    var idx = slotIdx != null ? slotIdx : _curSlot;
    var s = chartSlots[idx];
    var arr = (s && s.overlayIds) ? s.overlayIds : overlayIds;
    var i;
    for (i = arr.length - 1; i >= 0; i--) {
      if (arr[i] === id) arr.splice(i, 1);
    }
    if (s) s.overlayIds = arr;
    if (_curSlot === idx) overlayIds = arr;
  }
  function slotIndexForOverlay(oid) {
    var i, s, found;
    if (oid) {
      for (i = 0; i < chartSlots.length; i++) {
        s = chartSlots[i];
        if (s && s.overlayIds && s.overlayIds.indexOf(oid) >= 0) return i;
      }
      for (i = 0; i < splitCount; i++) {
        s = chartSlots[i];
        if (!s || !s.chart) continue;
        found = null;
        try { found = s.chart.getOverlayById(oid); } catch (_) {}
        if (found) return i;
      }
    }
    return _curSlot;
  }
  function loadCustomDefs() { return storageGet(LS_CUSTOM, []); }
  function saveCustomDefs(list) { storageSet(LS_CUSTOM, list); }

  function startAutoRefresh() {
    stopAutoRefresh();
    if (replayFrozen()) return;
    var iv = _refreshInterval;
    if (activeBroker === "excel" && selectedInstrument) {
      var sec = Number(selectedInstrument.poll_seconds || 5);
      iv = Math.max(MIN_REFRESH_MS, (isFinite(sec) ? sec : 5) * 1000);
    }
    if (iv > 0 && selectedInstrument) {
      iv = Math.max(MIN_REFRESH_MS, iv);
      var mySlot = _curSlot;
      _refreshTimer = setInterval(function () {
        var s = chartSlots[mySlot];
        if (!s || !s.instrument || !s.chart) return;
        if (s.replay && s.replay.active && !s.replay.picking && s.replay.index >= 0) return;
        _useSlot(mySlot);
        loadChartData(true);
      }, iv);
      if (chartSlots[_curSlot]) chartSlots[_curSlot].refreshTimer = _refreshTimer;
      if (chartSlots[_curSlot]) chartSlots[_curSlot].refreshInterval = iv;
    }
  }
  function stopAutoRefresh() {
    if (_refreshTimer) { clearInterval(_refreshTimer); _refreshTimer = null; }
    if (chartSlots[_curSlot]) chartSlots[_curSlot].refreshTimer = null;
  }

  window._chartSetRefreshInterval = function (ms) {
    _refreshInterval = ms;
    if (chartSlots[_curSlot]) chartSlots[_curSlot].refreshInterval = ms;
    startAutoRefresh();
  };

  function currentTypeSpec() {
    var i, t;
    for (i = 0; i < CANDLE_TYPES.length; i++) {
      t = CANDLE_TYPES[i];
      if (t.id === _candleType) return t;
    }
    return CANDLE_TYPES[0];
  }

  function toHeikinAshi(bars) {
    var out = [];
    var prevO = null;
    var prevC = null;
    for (var i = 0; i < bars.length; i++) {
      var b = bars[i];
      var haC = (b.open + b.high + b.low + b.close) / 4;
      var haO = (prevO == null) ? ((b.open + b.close) / 2) : ((prevO + prevC) / 2);
      out.push({
        timestamp: b.timestamp,
        open: haO,
        high: Math.max(b.high, haO, haC),
        low: Math.min(b.low, haO, haC),
        close: haC,
        volume: b.volume || 0
      });
      prevO = haO;
      prevC = haC;
    }
    return out;
  }

  function displaySeries(bars) {
    return currentTypeSpec().ha ? toHeikinAshi(bars || []) : (bars || []);
  }

  function replayFrozen() {
    return !!(!_replay.picking && _replay.active && _replay.index >= 0);
  }

  function visibleRawBars() {
    if (!replayFrozen()) return _rawBars;
    var n = Math.min(_replay.index + 1, _rawBars.length);
    return _rawBars.slice(0, Math.max(0, n));
  }

  function chartBarSpace() {
    if (!chart || !chart.getBarSpace) return DEFAULT_BAR_SPACE;
    var space = null;
    try { space = chart.getBarSpace(); } catch (_) {}
    if (space && typeof space === "object") space = space.bar;
    space = Number(space);
    return isFinite(space) && space > 0 ? space : DEFAULT_BAR_SPACE;
  }

  function pointAtChartX(x) {
    var h = (chartContainer && chartContainer.clientHeight) || 0;
    return pointFromPixel({ x: x, y: Math.max(24, h * 0.4) });
  }

  function timestampIndex(ts, list) {
    if (ts == null || !list || !list.length) return -1;
    var lo = 0;
    var hi = list.length - 1;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      var v = list[mid].timestamp;
      if (v === ts) return mid;
      if (v < ts) lo = mid + 1;
      else hi = mid - 1;
    }
    var i = Math.max(0, Math.min(list.length - 1, lo));
    var best = i;
    var dist = Math.abs(list[i].timestamp - ts);
    if (i > 0 && Math.abs(list[i - 1].timestamp - ts) < dist) best = i - 1;
    if (i + 1 < list.length && Math.abs(list[i + 1].timestamp - ts) < dist) best = i + 1;
    return best;
  }

  function overlayOwnerChart(overlay) {
    var oid = overlay && overlay.id;
    var i, s, found;
    if (oid) {
      for (i = 0; i < chartSlots.length; i++) {
        s = chartSlots[i];
        if (!s || !s.chart) continue;
        found = null;
        try { found = s.chart.getOverlayById(oid); } catch (_) {}
        if (found) return s.chart;
      }
    }
    return chart;
  }

  function chartDataListOf(c) {
    if (!c) return [];
    try { return c.getDataList() || []; } catch (_) { return []; }
  }

  function chartDataList() {
    return chartDataListOf(chart);
  }

  function visibleBarRangeOf(c, listLen) {
    var from = 0;
    var to = Math.max(0, (listLen | 0) - 1);
    try {
      var vr = c && c.getVisibleRange && c.getVisibleRange();
      if (vr && isFinite(vr.from) && isFinite(vr.to)) {
        from = Math.max(0, Math.floor(Number(vr.from)));
        to = Math.min(to, Math.ceil(Number(vr.to)));
      }
    } catch (_) {}
    if (to < from) to = from;
    return { from: from, to: to };
  }

  function visibleBarRange(listLen) {
    return visibleBarRangeOf(chart, listLen);
  }

  function panePoint(ts, value, dataIndex, xAxis, yAxis, owner) {
    var c = owner || chart;
    var di = dataIndex;
    if ((di == null || !isFinite(di)) && ts != null) {
      di = timestampIndex(ts, chartDataListOf(c));
    }
    var x = null;
    var y = null;
    if (xAxis && di != null && isFinite(di)) {
      try { x = xAxis.convertToPixel(di); } catch (_) {}
    }
    if (yAxis && value != null && isFinite(Number(value))) {
      try { y = yAxis.convertToPixel(Number(value)); } catch (_) {}
    }
    if (isFinite(x) && isFinite(y)) return { x: x, y: y };
    if (c && c.convertToPixel && (ts != null || (di != null && isFinite(di)))) {
      try {
        var spec = { value: value };
        if (ts != null && isFinite(Number(ts))) spec.timestamp = Number(ts);
        if (di != null && isFinite(di) && di >= 0) spec.dataIndex = di;
        var raw = c.convertToPixel(spec, { paneId: "candle_pane" });
        var pt = Array.isArray(raw) ? raw[0] : raw;
        if (pt && isFinite(pt.x) && isFinite(pt.y)) return { x: pt.x, y: pt.y };
      } catch (_) {}
    }
    return null;
  }

  function captureChartView() {
    if (!chart || !chartContainer) return null;
    var w = chartContainer.clientWidth || 0;
    var h = chartContainer.clientHeight || 0;
    if (w < 40 || h < 40) return _replay.viewSnap || null;
    var xs = [Math.max(48, w * 0.5), Math.max(48, w * 0.28), 56, Math.max(48, w * 0.72)];
    var anchorX = xs[0];
    var anchorTs = null;
    var i;
    for (i = 0; i < xs.length; i++) {
      var p = pointAtChartX(xs[i]);
      if (p && p.timestamp != null) {
        anchorX = xs[i];
        anchorTs = p.timestamp;
        break;
      }
    }
    if (anchorTs == null) {
      var list = [];
      try { list = chart.getDataList() || []; } catch (_) {}
      var range = null;
      try { range = chart.getVisibleRange && chart.getVisibleRange(); } catch (_) {}
      if (range && list[range.from] && list[range.from].timestamp != null) {
        anchorTs = list[range.from].timestamp;
        anchorX = 56;
      }
    }
    return {
      space: chartBarSpace(),
      anchorX: anchorX,
      anchorTs: anchorTs
    };
  }

  function restoreChartView(snap) {
    if (!chart || !snap || snap.anchorTs == null) return;
    function apply() {
      if (!chart) return;
      if (snap.space != null && isFinite(snap.space) && chart.setBarSpace) {
        var cur = chartBarSpace();
        if (Math.abs(cur - snap.space) > 0.2) {
          try { chart.setBarSpace(snap.space); } catch (_) {}
        }
      }
      if (!chart.convertToPixel || !chart.scrollByDistance) return;
      var list = [];
      try { list = chart.getDataList() || []; } catch (_) {}
      var idx = timestampIndex(snap.anchorTs, list);
      var raw = chart.convertToPixel({
        timestamp: snap.anchorTs,
        dataIndex: idx >= 0 ? idx : undefined
      }, { paneId: "candle_pane" });
      var pt = Array.isArray(raw) ? raw[0] : raw;
      if (pt && isFinite(pt.x) && snap.anchorX != null) {
        var dx = snap.anchorX - pt.x;
        if (Math.abs(dx) > 0.5) {
          try { chart.scrollByDistance(dx, 0); } catch (_) {}
        }
      }
    }
    apply();
    requestAnimationFrame(function () {
      apply();
      requestAnimationFrame(apply);
    });
  }

  function rememberChartView() {
    var snap = captureChartView();
    if (snap && snap.anchorTs != null) _replay.viewSnap = snap;
    return _replay.viewSnap;
  }

  function applyChartData(bars, more, after) {
    if (!chart) {
      if (typeof after === "function") requestAnimationFrame(after);
      return;
    }
    var moreFlag = more !== false;
    var done = typeof after === "function" ? after : null;
    try {
      chart.applyNewData(bars || [], moreFlag, function () {
        if (done) done();
      });
    } catch (_) {
      try { chart.applyNewData(bars || [], moreFlag); } catch (__) {}
      if (done) requestAnimationFrame(done);
    }
  }

  function upsertRawBar(bar) {
    if (!bar || bar.timestamp == null) return;
    if (!_rawBars.length || bar.timestamp > _rawBars[_rawBars.length - 1].timestamp) {
      _rawBars.push(bar);
      return;
    }
    if (bar.timestamp === _rawBars[_rawBars.length - 1].timestamp) {
      _rawBars[_rawBars.length - 1] = bar;
      return;
    }
    for (var i = _rawBars.length - 1; i >= 0; i--) {
      if (_rawBars[i].timestamp === bar.timestamp) {
        _rawBars[i] = bar;
        return;
      }
      if (_rawBars[i].timestamp < bar.timestamp) {
        _rawBars.splice(i + 1, 0, bar);
        return;
      }
    }
    _rawBars.unshift(bar);
  }

  function lastDisplayBar() {
    var series = displaySeries(visibleRawBars());
    return series.length ? series[series.length - 1] : null;
  }

  function fmtPx(v, digits) {
    v = Number(v);
    if (!isFinite(v)) return "—";
    var d = digits != null ? digits : (Math.abs(v) >= 1 ? 2 : 4);
    return v.toLocaleString("en-IN", { minimumFractionDigits: d, maximumFractionDigits: d });
  }

  function prevCloseFromBars(bars) {
    if (!bars || !bars.length) return null;
    if (bars.length === 1) return bars[0].open;
    var lastDay = dateIST(bars[bars.length - 1].timestamp);
    for (var i = bars.length - 2; i >= 0; i--) {
      if (dateIST(bars[i].timestamp) !== lastDay) return bars[i].close;
    }
    return bars[0].open;
  }

  function syncPrevClose() {
    _prevClose = prevCloseFromBars(visibleRawBars());
    if (chartSlots[_curSlot]) chartSlots[_curSlot].prevClose = _prevClose;
  }

  function updateLiveQuote(price) {
    var s = chartSlots[_curSlot] || chartSlots[activeSlot];
    price = Number(price);
    var prev = s && s.prevClose != null ? s.prevClose : _prevClose;
    if (!isFinite(price)) {
      if (s && s.quoteEl) s.quoteEl.innerHTML = "";
      if (liveQuoteEl) liveQuoteEl.innerHTML = "";
      return;
    }
    var html = quoteHtml(price, prev);
    if (s) setSlotQuote(s, price, prev);
    if (liveQuoteEl) liveQuoteEl.innerHTML = html;
  }

  function refreshLiveQuote() {
    var bars = visibleRawBars();
    if (!bars.length) {
      updateLiveQuote(NaN);
      return;
    }
    updateLiveQuote(bars[bars.length - 1].close);
  }

  function isHollowCandleType(id) {
    return id === "candle_up_stroke" || id === "candle_stroke" || id === "candle_down_stroke";
  }

  function candleBarColors(th, hollow) {
    if (!hollow) {
      return {
        upColor: "#3fb950", downColor: "#f85149", noChangeColor: "#8b949e",
        upBorderColor: "#3fb950", downBorderColor: "#f85149", noChangeBorderColor: "#8b949e",
        upWickColor: "#3fb950", downWickColor: "#f85149", noChangeWickColor: "#8b949e"
      };
    }
    /* Classic B&W hollow: up = open body, down = filled. Invert ink on dark charts. */
    var light = !!(th && th.bg && String(th.bg).toLowerCase() === "#ffffff");
    var ink = light ? "#000000" : "#ffffff";
    var paper = light ? "#ffffff" : "#000000";
    return {
      upColor: paper, downColor: ink, noChangeColor: "#8b949e",
      upBorderColor: ink, downBorderColor: ink, noChangeBorderColor: "#8b949e",
      upWickColor: ink, downWickColor: ink, noChangeWickColor: "#8b949e"
    };
  }

  function klineStyles() {
    var th = window._getChartTheme ? window._getChartTheme() : { bg: "#0d1117", text: "#8b949e", grid: "#21262d", border: "#30363d" };
    var spec = currentTypeSpec();
    var lineColor = "#58a6ff";
    var isLine = !!spec.line;
    var hollow = isHollowCandleType(spec.id);
    var bar = candleBarColors(th, hollow);
    return {
      grid: {
        show: true,
        horizontal: { show: true, size: 1, color: th.grid, style: "dashed" },
        vertical: { show: true, size: 1, color: th.grid, style: "dashed" }
      },
      candle: {
        type: spec.ktype,
        bar: bar,
        area: {
          lineSize: 2,
          lineColor: lineColor,
          value: "close",
          smooth: false,
          backgroundColor: [
            { offset: 0, color: isLine ? "rgba(88,166,255,0)" : "rgba(88,166,255,0.02)" },
            { offset: 1, color: isLine ? "rgba(88,166,255,0)" : "rgba(88,166,255,0.22)" }
          ],
          point: { show: spec.ktype === "area", color: lineColor, radius: isLine ? 3 : 4, animation: !isLine }
        },
        priceMark: {
          last: {
            upColor: hollow ? bar.upBorderColor : "#3fb950",
            downColor: hollow ? bar.downColor : "#f85149",
            noChangeColor: "#8b949e",
            /* Hollow ink is white on dark / black on light; default last-text is always white. */
            text: { color: hollow ? bar.upColor : "#FFFFFF" }
          }
        },
        tooltip: { showRule: "none" }
      },
      indicator: {
        tooltip: { showRule: "none" }
      },
      xAxis: {
        axisLine: { color: th.border },
        tickLine: { color: th.border },
        tickText: { color: th.text, size: 11 }
      },
      yAxis: {
        axisLine: { color: th.border },
        tickLine: { color: th.border },
        tickText: { color: th.text, size: 11 }
      },
      separator: { color: th.border },
      crosshair: {
        horizontal: { line: { color: th.text, style: "dashed" } },
        vertical: { line: { color: th.text, style: "dashed" } }
      }
    };
  }

  function applyChartContainerTheme(el) {
    var node = el || chartContainer;
    if (!node) return;
    var th = window._getChartTheme ? window._getChartTheme() : null;
    node.style.background = (th && th.bg) ? th.bg : "";
  }

  window._chartApplyTheme = function () {
    forEachChart(function (c, i) {
      _useSlot(i);
      applyChartContainerTheme(chartContainer);
      try { c.setStyles(klineStyles()); } catch (_) {}
      try { c.resize(); } catch (_) {}
    });
    document.querySelectorAll("#chart-stage .chart-slot-canvas, #chart-stage #chart-container").forEach(function (node) {
      applyChartContainerTheme(node);
    });
    _useSlot(activeSlot >= splitCount ? 0 : activeSlot);
  };

  function candleTypeIcon(id) {
    var g = "#3fb950";
    var r = "#f85149";
    var b = "#58a6ff";
    var ink = "#c9d1d9";
    if (id === "candle_solid") {
      return "<svg viewBox=\"0 0 22 16\" fill=\"none\"><path d=\"M6 2v12M5 5h2v6H5z\" stroke=\"" + g + "\" stroke-width=\"1.4\" fill=\"" + g + "\"/><path d=\"M16 1v14M15 4h2v8h-2z\" stroke=\"" + r + "\" stroke-width=\"1.4\" fill=\"" + r + "\"/></svg>";
    }
    if (id === "candle_up_stroke") {
      return "<svg viewBox=\"0 0 22 16\" fill=\"none\"><path d=\"M6 2v12\" stroke=\"" + ink + "\" stroke-width=\"1.4\"/><rect x=\"5\" y=\"5\" width=\"2\" height=\"6\" stroke=\"" + ink + "\" stroke-width=\"1.2\" fill=\"none\"/><path d=\"M16 1v14M15 4h2v8h-2z\" stroke=\"" + ink + "\" stroke-width=\"1.4\" fill=\"" + ink + "\"/></svg>";
    }
    if (id === "candle_stroke") {
      return "<svg viewBox=\"0 0 22 16\" fill=\"none\"><path d=\"M6 2v12\" stroke=\"" + ink + "\" stroke-width=\"1.4\"/><rect x=\"5\" y=\"5\" width=\"2\" height=\"6\" stroke=\"" + ink + "\" stroke-width=\"1.2\" fill=\"none\"/><path d=\"M16 1v14\" stroke=\"" + ink + "\" stroke-width=\"1.4\"/><rect x=\"15\" y=\"4\" width=\"2\" height=\"8\" stroke=\"" + ink + "\" stroke-width=\"1.2\" fill=\"none\"/></svg>";
    }
    if (id === "candle_down_stroke") {
      return "<svg viewBox=\"0 0 22 16\" fill=\"none\"><path d=\"M6 2v12M5 5h2v6H5z\" stroke=\"" + ink + "\" stroke-width=\"1.4\" fill=\"" + ink + "\"/><path d=\"M16 1v14\" stroke=\"" + ink + "\" stroke-width=\"1.4\"/><rect x=\"15\" y=\"4\" width=\"2\" height=\"8\" stroke=\"" + ink + "\" stroke-width=\"1.2\" fill=\"none\"/></svg>";
    }
    if (id === "ohlc") {
      return "<svg viewBox=\"0 0 22 16\" fill=\"none\"><path d=\"M5 3v10M3 6h2M5 11h2M17 2v12M15 5h2M17 10h2\" stroke=\"" + b + "\" stroke-width=\"1.4\" stroke-linecap=\"square\"/></svg>";
    }
    if (id === "line") {
      return "<svg viewBox=\"0 0 22 16\" fill=\"none\"><path d=\"M2 12l5-6 4 3 4-7 5 4\" stroke=\"" + b + "\" stroke-width=\"1.5\" stroke-linejoin=\"round\" stroke-linecap=\"round\"/></svg>";
    }
    if (id === "area") {
      return "<svg viewBox=\"0 0 22 16\" fill=\"none\"><path d=\"M2 14V12l5-6 4 3 4-7 5 4v8z\" fill=\"" + b + "\" fill-opacity=\"0.28\" stroke=\"" + b + "\" stroke-width=\"1.2\" stroke-linejoin=\"round\"/></svg>";
    }
    return "<svg viewBox=\"0 0 22 16\" fill=\"none\"><path d=\"M6 3v10M4.5 6h3v5h-3z\" stroke=\"" + g + "\" stroke-width=\"1.3\" fill=\"" + g + "\" fill-opacity=\"0.35\"/><path d=\"M16 2v12M14.5 5h3v7h-3z\" stroke=\"" + r + "\" stroke-width=\"1.3\" fill=\"" + r + "\" fill-opacity=\"0.35\"/></svg>";
  }

  function updateCandleTypeButton() {
    var btn = document.getElementById("btn-candle-type");
    if (!btn) return;
    var spec = currentTypeSpec();
    btn.title = "Chart type: " + spec.label;
    btn.setAttribute("aria-label", "Chart type: " + spec.label);
  }

  function renderCandleTypePop() {
    var pop = document.getElementById("candle-type-pop");
    if (!pop) return;
    var html = "<div class=\"chart-pop-title\">Chart type</div>";
    CANDLE_TYPES.forEach(function (t) {
      html += "<button type=\"button\" class=\"chart-type-item" + (t.id === _candleType ? " on" : "") + "\" data-ctype=\"" + t.id + "\">" +
        "<span class=\"chart-type-icon\">" + candleTypeIcon(t.id) + "</span><span>" + t.label + "</span></button>";
    });
    pop.innerHTML = html;
    pop.querySelectorAll("[data-ctype]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        applyCandleType(btn.getAttribute("data-ctype"));
        pop.classList.add("hidden");
      });
    });
  }

  function applyCandleType(id) {
    var spec = null;
    for (var i = 0; i < CANDLE_TYPES.length; i++) {
      if (CANDLE_TYPES[i].id === id) { spec = CANDLE_TYPES[i]; break; }
    }
    if (!spec) return;
    var wasHa = !!currentTypeSpec().ha;
    _candleType = spec.id;
    if (chartSlots[_curSlot]) chartSlots[_curSlot].candleType = _candleType;
    storageSet(slotCtypeKey(), _candleType);
    updateCandleTypeButton();
    renderCandleTypePop();
    if (!chart) return;
    chart.setStyles(klineStyles());
    if (wasHa !== !!spec.ha && _rawBars.length) {
      applyChartData(displaySeries(visibleRawBars()), _histMore);
    }
  }

  function getSocket() {
    if (!_socket) {
      _socket = io({ transports: ["websocket", "polling"] });
      _socket.on("price_update", function (candle) {
        /* Route the live tick to whichever slot is subscribed. */
        var subIdx = -1;
        chartSlots.forEach(function (s, i) {
          if (s.liveSub && s.instrument) subIdx = i;
        });
        if (subIdx < 0) return;
        _useSlot(subIdx);
        if (!chart || !candle) {
          _useSlot(activeSlot);
          return;
        }
        upsertRawBar({
          timestamp: candle.time * 1000,
          open: candle.open, high: candle.high, low: candle.low, close: candle.close,
          volume: candle.volume || 0
        });
        if (replayFrozen()) {
          _useSlot(activeSlot);
          return;
        }
        var bar = lastDisplayBar();
        if (bar) { try { chart.updateData(bar); } catch (_) {} }
        updateLiveQuote(candle.close);
        if (chartSlots[subIdx] && chartSlots[subIdx].rawBars && chartSlots[subIdx].rawBars.length) {
          setSlotOhlc(chartSlots[subIdx], chartSlots[subIdx].rawBars[chartSlots[subIdx].rawBars.length - 1]);
        }
        var dot = document.getElementById("live-dot");
        if (dot) { dot.classList.add("pulse"); setTimeout(function () { dot.classList.remove("pulse"); }, 400); }
        updateChartLegendValues();
        schedulePyRefresh();
        _useSlot(activeSlot);
      });
    }
    return _socket;
  }
  function subscribeLive() {
    if (activeBroker !== "5paisa" || !selectedInstrument) return;
    getSocket().emit("subscribe_live", {
      scrip_code: selectedInstrument.scrip_code,
      exch: selectedInstrument.exch,
      exch_type: selectedInstrument.exch_type,
      interval: fetchInterval(activeInterval)
    });
    _liveSub = true;
    if (chartSlots[_curSlot]) chartSlots[_curSlot].liveSub = true;
    var t = document.getElementById("live-badge");
    if (t) t.style.display = "none";
  }
  function unsubscribeLive() {
    if (!_liveSub) return;
    if (_socket) _socket.emit("unsubscribe_live");
    _liveSub = false;
    if (chartSlots[_curSlot]) chartSlots[_curSlot].liveSub = false;
    var t = document.getElementById("live-badge");
    if (t) t.style.display = "none";
  }

  window._chartSetBrokerEnabled = function (broker, enabled) {
    window._brokerEnabled = window._brokerEnabled || {};
    window._brokerEnabled[broker] = !!enabled;
    syncChartBrokerTabs();
    var next = pickActiveBroker();
    if (next !== activeBroker) {
      persistOverlays();
      activeBroker = next;
      renderIntervalButtons();
      if (typeof updateSearchPlaceholder === "function") updateSearchPlaceholder();
      unsubscribeLive();
      /* Auto-sync (settings/connect events): keep all slots' instruments. */
      commitSlotGlobals();
    }
  };

  window._chartSetConnected = function (broker, connected) {
    window._brokerConnected = window._brokerConnected || {};
    window._brokerConnected[broker] = !!connected;
    syncChartBrokerTabs();
    var next = pickActiveBroker();
    if (next !== activeBroker) {
      persistOverlays();
      activeBroker = next;
      renderIntervalButtons();
      if (typeof updateSearchPlaceholder === "function") updateSearchPlaceholder();
      unsubscribeLive();
      /* Auto-sync: keep all slots' instruments. */
      commitSlotGlobals();
      return;
    }
    if (connected) {
      /* Restore every tile that had a symbol saved — not only the active slot. */
      refreshVisibleSlots();
    }
  };

  if (intervalGroup) {
    intervalGroup.addEventListener("click", function (e) {
      var btn = e.target.closest(".ivl-btn");
      if (!btn || !intervalGroup.contains(btn)) return;
      intervalGroup.querySelectorAll(".ivl-btn").forEach(function (b) { b.classList.remove("active"); });
      btn.classList.add("active");
      focusActiveSlot();
      activeInterval = btn.dataset.ivl;
      if (chartSlots[_curSlot]) chartSlots[_curSlot].interval = activeInterval;
      if (layoutSync.interval) {
        var ii;
        for (ii = 0; ii < splitCount; ii++) {
          if (chartSlots[ii]) chartSlots[ii].interval = activeInterval;
        }
      }
      commitSlotGlobals();
      updateSlotTickers();
      if (selectedInstrument) {
        Promise.resolve(loadChartData()).then(function () {
          if (layoutSync.interval) loadSyncedSlots(_curSlot);
        });
      }
    });
  }

  document.querySelectorAll(".cbrok-btn[data-broker]").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var id = btn.dataset.broker;
      var en = window._brokerEnabled || {};
      if ((id === "yahoo" || id === "excel") ? !en[id] : en[id] === false) return;
      window._chartPreferredBroker = id;
      if (id === activeBroker) return;
      persistOverlays();
      activeBroker = id;
      syncChartBrokerTabs();
      renderIntervalButtons();
      updateSearchPlaceholder();
      unsubscribeLive();
      clearActiveSlotInstrument();
    });
  });

  var searchTimer = null;
  function updateSearchPlaceholder() {
    if (!searchInput) return;
    searchInput.placeholder = activeBroker === "excel"
      ? "Select Excel config\u2026"
      : "Search symbol e.g. RELIANCE, NIFTY\u2026";
  }
  updateSearchPlaceholder();
  searchInput.addEventListener("input", function () {
    clearTimeout(searchTimer);
    var q = searchInput.value.trim();
    if (activeBroker !== "excel" && q.length < 2) { dropdown.classList.add("hidden"); dropdown.innerHTML = ""; return; }
    searchTimer = setTimeout(function () { fetchSuggestions(q); }, 250);
  });
  if (searchInput) searchInput.addEventListener("focus", function () {
    if (activeBroker === "excel") fetchSuggestions(searchInput.value.trim());
  });
  searchInput.addEventListener("keydown", function (e) {
    var items = dropdown.querySelectorAll("li");
    var active = dropdown.querySelector("li.active");
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (!active) { items[0] && items[0].classList.add("active"); }
      else { active.classList.remove("active"); var n = active.nextElementSibling; if (n) n.classList.add("active"); }
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (active) { active.classList.remove("active"); var p = active.previousElementSibling; if (p) p.classList.add("active"); }
    } else if (e.key === "Enter") {
      if (active) active.click();
    } else if (e.key === "Escape") {
      dropdown.classList.add("hidden");
    }
  });
  document.addEventListener("click", function (e) {
    if (!e.target.closest(".chart-search-wrap")) dropdown.classList.add("hidden");
    if (!e.target.closest(".chart-menu-wrap")) {
      var tp = document.getElementById("candle-type-pop");
      var sp = document.getElementById("replay-speed-pop");
      var lp = document.getElementById("split-pop");
      if (tp) tp.classList.add("hidden");
      if (sp) sp.classList.add("hidden");
      if (lp) lp.classList.add("hidden");
    }
  });

  async function fetchSuggestions(q) {
    try {
      var url = "/api/instruments/search?q=" + encodeURIComponent(q) + "&limit=12";
      if (activeBroker === "5paisa") url = "/api/5paisa/instruments/search?q=" + encodeURIComponent(q) + "&limit=12";
      if (activeBroker === "yahoo") url = "/api/yahoo/instruments/search?q=" + encodeURIComponent(q) + "&limit=12";
      if (activeBroker === "excel") url = "/api/excel/instruments/search?q=" + encodeURIComponent(q) + "&limit=20";
      var res = await fetch(url);
      var items = await res.json();
      if (items.error) { dropdown.classList.add("hidden"); return; }
      dropdown.innerHTML = "";
      if (!items.length) { dropdown.classList.add("hidden"); return; }
      items.forEach(function (item) {
        var li = document.createElement("li");
        var sym = item.trading_symbol;
        var seg = item.exchange_label || item.exchange_segment || "";
        if (activeBroker === "yahoo" && item.yahoo_symbol) {
          seg = item.yahoo_symbol;
        }
        li.innerHTML = "<span class=\"sym\">" + sym + "</span>" + item.name + "<span class=\"seg\">" + seg + "</span>";
        li.addEventListener("click", function () {
          focusActiveSlot();
          selectedInstrument = item;
          if (chartSlots[activeSlot]) chartSlots[activeSlot].instrument = item;
          if (layoutSync.symbol) applySymbolToLayout(item);
          else {
            commitSlotGlobals();
            updateSlotTickers();
          }
          searchInput.value = sym + " \u2014 " + item.name;
          dropdown.classList.add("hidden");
          if (layoutSync.symbol) {
            Promise.resolve(loadChartData()).then(function () {
              loadSyncedSlots(activeSlot);
            });
          }
        });
        dropdown.appendChild(li);
      });
      dropdown.classList.remove("hidden");
    } catch (_) {}
  }

  loadBtn.addEventListener("click", function () {
    focusActiveSlot();
    if (!selectedInstrument) {
      chartMessage.textContent = "Please search and select a stock first.";
      chartMessage.style.display = "flex";
      return;
    }
    if (chartSlots[activeSlot]) chartSlots[activeSlot].instrument = selectedInstrument;
    if (layoutSync.symbol && selectedInstrument) applySymbolToLayout(selectedInstrument);
    if (layoutSync.interval) {
      var si;
      for (si = 0; si < splitCount; si++) {
        if (chartSlots[si]) chartSlots[si].interval = activeInterval;
      }
    }
    commitSlotGlobals();
    updateSlotTickers();
    Promise.resolve(loadChartData()).then(function () {
      if (layoutSync.symbol || layoutSync.interval) loadSyncedSlots(activeSlot);
    });
  });

  function toKLine(c) {
    return {
      timestamp: c.time * 1000,
      open: c.open, high: c.high, low: c.low, close: c.close,
      volume: c.volume || 0
    };
  }

  function initChart() {
    if (chart) {
      try { klinecharts.dispose(chartContainer); } catch (_) {}
      chart = null;
    }
    overlayIds.length = 0;
    _excelOverlayIds.length = 0;
    _chartGen += 1;
    chartContainer.innerHTML = "";
    chartMessage.style.display = "none";
    chartContainer.style.display = "block";
    applyChartContainerTheme(chartContainer);
    chart = klinecharts.init(chartContainer, {
      locale: "en-US",
      timezone: IST_TZ,
      styles: klineStyles()
    });
    bindSlotInstance();
    bindHistoryLoader();
    _pyCoveredN = 0;
    _pyCoveredFirst = null;
    var myChart = chart;
    var mySlot = _curSlot;
    var myContainer = chartContainer;
    chart.subscribeAction("onCrosshairChange", function (data) {
      var owner = chartSlots[mySlot];
      var d = data && (data.kLineData || data.data);
      if (!d || d.close == null) {
        if (owner && owner.rawBars && owner.rawBars.length) {
          setSlotOhlc(owner, owner.rawBars[owner.rawBars.length - 1]);
        } else {
          setSlotOhlc(owner, null);
        }
        if (myChart === (chartSlots[activeSlot] && chartSlots[activeSlot].chart)) {
          if (ohlcEl) ohlcEl.innerHTML = "";
          _legendIndex = null;
          updateChartLegendValues();
        }
      } else {
        setSlotOhlc(owner, d);
        if (myChart === (chartSlots[activeSlot] && chartSlots[activeSlot].chart)) {
          if (ohlcEl) ohlcEl.innerHTML = ohlcHtml(d);
          _legendIndex = data.dataIndex != null ? data.dataIndex : (data.realDataIndex != null ? data.realDataIndex : null);
          updateChartLegendValues();
        }
      }
      if (activeDraw === "cursor") syncLayoutCrosshair(mySlot, data);
    });
    function onReplayChartClick(data) {
      if (!_replay.picking || _replay.dragged) return;
      var ts = data && (
        data.timestamp ||
        (data.kLineData && data.kLineData.timestamp) ||
        (data.data && data.data.timestamp)
      );
      var idx = ts != null ? timestampIndex(ts, _rawBars) : -1;
      if (idx < 0) {
        var di = data && (data.dataIndex != null ? data.dataIndex : data.realDataIndex);
        var list = [];
        try { list = chart.getDataList() || []; } catch (_) {}
        if (di != null && list[di]) idx = timestampIndex(list[di].timestamp, _rawBars);
      }
      consumeReplayPick(idx);
    }
    try { chart.subscribeAction("onClick", onReplayChartClick); } catch (_) {}
    try { chart.subscribeAction("onCandleBarClick", onReplayChartClick); } catch (_) {}
    try {
      chart.subscribeAction("onVisibleRangeChange", function () {
        if (pythonCoverageStaleSlot(mySlot)) schedulePyRefresh(true);
        if (_syncingRange) return;
        if (_rangeSyncRaf) cancelAnimationFrame(_rangeSyncRaf);
        _rangeSyncRaf = requestAnimationFrame(function () {
          _rangeSyncRaf = 0;
          syncLayoutRange(mySlot);
        });
      });
    } catch (_) {}
    if (!myContainer._ro) {
      myContainer._ro = new ResizeObserver(function () {
        var inst = myContainer._kline;
        if (!inst || myContainer._resizing) return;
        myContainer._resizing = true;
        try { inst.resize(); } finally {
          requestAnimationFrame(function () { myContainer._resizing = false; });
        }
      });
      myContainer._ro.observe(myContainer);
    }
    myContainer._kline = myChart;
    bindReplayPointer(myContainer);
  }

  window._chartResize = function () {
    forEachChart(function (c) {
      try { c.resize(); } catch (_) {}
    });
    var snap = captureChartView() || _replay.viewSnap;
    try { if (chart) chart.resize(); } catch (_) {}
    restoreChartView(snap);
  };

  window._chartOnHomeHidden = function () {
    rememberChartView();
  };

  window._chartOnHomeShown = function () {
    forEachChart(function (c) {
      try { c.resize(); } catch (_) {}
    });
    var snap = _replay.viewSnap || captureChartView();
    if (chart) {
      try { chart.resize(); } catch (_) {}
    }
    restoreChartView(snap);
    if (_replay.picking || _replay.active) updateReplayUi();
    refreshVisibleSlots();
  };

  function chartCenterCoord() {
    return {
      x: (chartContainer && chartContainer.clientWidth ? chartContainer.clientWidth : 0) / 2,
      y: (chartContainer && chartContainer.clientHeight ? chartContainer.clientHeight : 0) / 2
    };
  }

  function chartNavZoom(scale) {
    if (!chart) return;
    if (chart.zoomAtCoordinate) {
      chart.zoomAtCoordinate(scale, chartCenterCoord(), 160);
      return;
    }
    var space = chart.getBarSpace && chart.getBarSpace();
    if (space && chart.setBarSpace) chart.setBarSpace(Math.max(1, space * scale));
  }

  function chartNavPan(dir) {
    if (!chart || !chart.scrollByDistance) return;
    var space = (chart.getBarSpace && chart.getBarSpace()) || DEFAULT_BAR_SPACE;
    chart.scrollByDistance(dir * space * 8, 160);
  }

  function chartNavReset() {
    if (!chart) return;
    if (chart.setBarSpace) chart.setBarSpace(DEFAULT_BAR_SPACE);
    if (chart.resetOffsetRightDistance) chart.resetOffsetRightDistance();
    if (chart.scrollToRealTime) chart.scrollToRealTime(200);
  }

  function setChartNavVisible(on) {
    if (!chartNav) return;
    chartNav.classList.toggle("is-visible", !!on);
    chartNav.setAttribute("aria-hidden", on ? "false" : "true");
  }

  function isChartNavHotspot(e) {
    if (!chartStage) return false;
    var r = chartStage.getBoundingClientRect();
    var x = e.clientX - r.left;
    var y = e.clientY - r.top;
    return Math.abs(x - r.width / 2) <= 130 && y >= r.height - 92;
  }

  function bindChartNav() {
    if (!chartStage || !chartNav || chartNav._bound) return;
    chartNav._bound = true;
    chartStage.addEventListener("mousemove", function (e) {
      if (!chart || (chartMessage && chartMessage.style.display !== "none" && chartMessage.style.display !== "")) {
        setChartNavVisible(false);
        return;
      }
      setChartNavVisible(isChartNavHotspot(e) || chartNav.contains(e.target));
    });
    chartStage.addEventListener("mouseleave", function () { setChartNavVisible(false); });
    chartNav.addEventListener("click", function (e) {
      var btn = e.target.closest("[data-nav]");
      if (!btn) return;
      e.preventDefault();
      e.stopPropagation();
      var action = btn.getAttribute("data-nav");
      if (action === "zoom-out") chartNavZoom(0.8);
      else if (action === "zoom-in") chartNavZoom(1.25);
      else if (action === "pan-left") chartNavPan(1);
      else if (action === "pan-right") chartNavPan(-1);
      else if (action === "reset") chartNavReset();
    });
    chartNav.addEventListener("mousedown", function (e) { e.stopPropagation(); });
  }

  function overlayIdFromEvent(ev) {
    if (!ev) return null;
    if (ev.overlay && ev.overlay.id) return ev.overlay.id;
    if (ev.id) return ev.id;
    if (ev.overlayId) return ev.overlayId;
    return null;
  }

  function overlayNameFromEvent(ev) {
    if (ev && ev.overlay && ev.overlay.name) return ev.overlay.name;
    var id = overlayIdFromEvent(ev);
    if (id && chart) {
      var o = chart.getOverlayById(id);
      if (o && o.name) return o.name;
    }
    return "";
  }

  function fmtDur(ms) {
    var s = Math.round(Math.abs(ms) / 1000);
    var d = Math.floor(s / 86400); s %= 86400;
    var h = Math.floor(s / 3600); s %= 3600;
    var m = Math.floor(s / 60);
    var out = [];
    if (d) out.push(d + "d");
    if (h) out.push(h + "h");
    if (m || !out.length) out.push(m + "m");
    return out.join(" ");
  }

  function hexToRgba(hex, a) {
    hex = String(hex || "#58a6ff").replace("#", "");
    if (hex.length === 3) hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
    var n = parseInt(hex, 16);
    if (!isFinite(n)) n = 0x58a6ff;
    return "rgba(" + ((n >> 16) & 255) + "," + ((n >> 8) & 255) + "," + (n & 255) + "," + a + ")";
  }

  function parseRectData(ext) {
    if (!ext) return { color: "#58a6ff", text: "" };
    if (typeof ext === "string") return { color: "#58a6ff", text: ext };
    return {
      color: ext.color || "#58a6ff",
      text: ext.text != null ? String(ext.text) : ""
    };
  }

  function parseTextData(ext) {
    if (ext == null || ext === "") return { text: "Text", color: "#ffffff" };
    if (typeof ext === "string") return { text: ext, color: "#ffffff" };
    return {
      text: ext.text != null && String(ext.text) !== "" ? String(ext.text) : "Text",
      color: ext.color || "#ffffff"
    };
  }

  function estimateTextBox(text, size) {
    var lines = String(text || "Text").split(/\r?\n/);
    var w = 40;
    try {
      var ctx = document.createElement("canvas").getContext("2d");
      ctx.font = "600 " + size + "px Segoe UI, sans-serif";
      lines.forEach(function (line) {
        w = Math.max(w, ctx.measureText(line || " ").width);
      });
    } catch (_) {
      lines.forEach(function (line) {
        w = Math.max(w, (line || " ").length * size * 0.62);
      });
    }
    return { w: Math.ceil(w + 10), h: Math.ceil(lines.length * size * 1.25 + 6) };
  }

  function fitTextFontSize(text, boxW, boxH) {
    var lines = String(text || "Text").split(/\r?\n/);
    var n = Math.max(1, lines.length);
    var maxLen = 1;
    lines.forEach(function (line) { maxLen = Math.max(maxLen, (line || " ").length); });
    var byH = boxH / (n * 1.25);
    var byW = boxW / Math.max(1, maxLen * 0.62);
    return Math.max(8, Math.min(96, Math.floor(Math.min(byH, byW))));
  }

  function pixelOfPoint(point) {
    if (!chart || !point) return null;
    var p = chart.convertToPixel({
      timestamp: point.timestamp,
      value: point.value,
      dataIndex: point.dataIndex
    }, { paneId: "candle_pane" });
    return Array.isArray(p) ? p[0] : p;
  }

  function pointFromPixel(xy) {
    if (!chart || !xy) return null;
    var p = chart.convertFromPixel({ x: xy.x, y: xy.y }, { paneId: "candle_pane" });
    return Array.isArray(p) ? p[0] : p;
  }

  function ensureTextBox(id) {
    if (!chart || !id) return;
    var o = chart.getOverlayById(id);
    if (!o || o.name !== "tvText" || !o.points || !o.points.length) return;
    if (o.points.length >= 4) return;
    var data = parseTextData(o.extendData);
    var c0 = pixelOfPoint(o.points[0]);
    if (!c0 || c0.x == null || c0.y == null) return;
    var c1 = o.points.length >= 2 ? pixelOfPoint(o.points[1]) : null;
    if (!c1 || c1.x == null || c1.y == null) {
      var est = estimateTextBox(data.text, 14);
      c1 = { x: c0.x + est.w, y: c0.y + est.h };
    }
    var left = Math.min(c0.x, c1.x);
    var right = Math.max(c0.x, c1.x);
    var top = Math.min(c0.y, c1.y);
    var bot = Math.max(c0.y, c1.y);
    if (right - left < 28) right = left + 28;
    if (bot - top < 16) bot = top + 16;
    var corners = [
      pointFromPixel({ x: left, y: top }),
      pointFromPixel({ x: right, y: top }),
      pointFromPixel({ x: right, y: bot }),
      pointFromPixel({ x: left, y: bot })
    ].filter(Boolean);
    if (corners.length < 4) return;
    chart.overrideOverlay({
      id: id,
      points: corners,
      extendData: { text: data.text, color: data.color }
    });
  }

  function textCornerPressed(params) {
    var pts = params.points;
    var idx = params.performPointIndex;
    var p = params.performPoint;
    if (!pts || pts.length < 4 || !p) return;
    function copyX(from, to) {
      if (!pts[from] || !pts[to]) return;
      pts[to].timestamp = pts[from].timestamp;
      pts[to].dataIndex = pts[from].dataIndex;
    }
    function copyY(from, to) {
      if (!pts[from] || !pts[to]) return;
      pts[to].value = pts[from].value;
    }
    if (idx === 0) { copyY(0, 1); copyX(0, 3); }
    else if (idx === 1) { copyY(1, 0); copyX(1, 2); }
    else if (idx === 2) { copyY(2, 3); copyX(2, 1); }
    else if (idx === 3) { copyY(3, 2); copyX(3, 0); }
  }

  function boxFigures(c0, c1, fill, border) {
    var x = Math.min(c0.x, c1.x);
    var y = Math.min(c0.y, c1.y);
    var w = Math.abs(c1.x - c0.x);
    var h = Math.abs(c1.y - c0.y);
    return {
      type: "rect",
      attrs: { x: x, y: y, width: w, height: h },
      styles: { style: "stroke_fill", color: fill, borderColor: border, borderSize: 1 }
    };
  }

  function parseCssRgb(color) {
    if (!color) return null;
    color = String(color).trim();
    var hex = color.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
    if (hex) {
      var h = hex[1];
      if (h.length === 3) h = h.charAt(0) + h.charAt(0) + h.charAt(1) + h.charAt(1) + h.charAt(2) + h.charAt(2);
      return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) };
    }
    var rgb = color.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/i);
    if (rgb) return { r: Number(rgb[1]), g: Number(rgb[2]), b: Number(rgb[3]) };
    return null;
  }

  function colorLuminance(color) {
    var rgb = parseCssRgb(color);
    if (!rgb) return 0;
    function lin(c) {
      c = Math.max(0, Math.min(255, c)) / 255;
      return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    }
    return 0.2126 * lin(rgb.r) + 0.7152 * lin(rgb.g) + 0.0722 * lin(rgb.b);
  }

  function chartBackgroundColor() {
    var bg = "";
    try {
      var th = window._getChartTheme && window._getChartTheme();
      if (th && th.bg) bg = th.bg;
    } catch (_) {}
    if (chartContainer) {
      try {
        var cs = window.getComputedStyle(chartContainer);
        if (cs && cs.backgroundColor && cs.backgroundColor !== "transparent" && cs.backgroundColor !== "rgba(0, 0, 0, 0)") {
          bg = cs.backgroundColor;
        }
      } catch (_) {}
    }
    return bg || "#0d1117";
  }

  function overlayContrastText() {
    return colorLuminance(chartBackgroundColor()) >= 0.55 ? "#111111" : "#ffffff";
  }

  function positionFigures(coordinates, overlay, side) {
    if (!coordinates || coordinates.length < 2) return [];
    var left = Math.min(coordinates[0].x, coordinates[1].x);
    var right = Math.max(coordinates[0].x, coordinates[1].x);
    var entryY = coordinates[0].y;
    var tpY = coordinates[1].y;
    var slY = coordinates.length > 2 ? coordinates[2].y : entryY;
    var pts = overlay.points || [];
    var entry = pts[0] && pts[0].value;
    var tp = pts[1] && pts[1].value;
    var sl = pts.length > 2 ? pts[2].value : null;
    var figs = [
      {
        type: "polygon",
        attrs: { coordinates: [
          { x: left, y: entryY }, { x: right, y: entryY },
          { x: right, y: tpY }, { x: left, y: tpY }
        ] },
        styles: { style: "fill", color: "rgba(63,185,80,0.22)" }
      },
      {
        type: "line",
        attrs: { coordinates: [{ x: left, y: entryY }, { x: right, y: entryY }] },
        styles: { color: "#c9d1d9", size: 1 }
      }
    ];
    if (coordinates.length > 2) {
      figs.push({
        type: "polygon",
        attrs: { coordinates: [
          { x: left, y: entryY }, { x: right, y: entryY },
          { x: right, y: slY }, { x: left, y: slY }
        ] },
        styles: { style: "fill", color: "rgba(248,81,73,0.22)" }
      });
    }
    var cx = (left + right) / 2;
    function badgeStyle(bg, border) {
      return {
        style: "fill",
        color: "#ffffff",
        size: 12,
        family: "Segoe UI, sans-serif",
        weight: "700",
        paddingLeft: 8,
        paddingRight: 8,
        paddingTop: 4,
        paddingBottom: 4,
        backgroundColor: bg,
        borderColor: border,
        borderSize: 1,
        borderRadius: 4
      };
    }
    if (entry != null && tp != null) {
      var profit = side === "short" ? (entry - tp) : (tp - entry);
      var pct = entry ? (profit / Math.abs(entry)) * 100 : 0;
      figs.push({
        type: "text",
        attrs: {
          x: cx, y: (entryY + tpY) / 2,
          text: (profit >= 0 ? "+" : "") + profit.toFixed(2) + "  (" + pct.toFixed(2) + "%)",
          align: "center", baseline: "middle"
        },
        styles: badgeStyle("rgba(8, 32, 18, 0.96)", "#3fb950")
      });
    }
    if (entry != null && sl != null && coordinates.length > 2) {
      var risk = side === "short" ? (sl - entry) : (entry - sl);
      var rpct = entry ? (risk / Math.abs(entry)) * 100 : 0;
      var profit2 = side === "short" ? (entry - tp) : (tp - entry);
      var rr = risk ? (profit2 / risk) : 0;
      figs.push({
        type: "text",
        attrs: {
          x: cx, y: (entryY + slY) / 2,
          text: "Stop " + risk.toFixed(2) + "  (" + rpct.toFixed(2) + "%)" + (isFinite(rr) ? "  RR " + Math.abs(rr).toFixed(2) : ""),
          align: "center", baseline: "middle"
        },
        styles: badgeStyle("rgba(48, 12, 12, 0.96)", "#f85149")
      });
    }
    return figs;
  }

  function positionMove(params) {
    var step = params.currentStep;
    var points = params.points;
    var p = params.performPoint;
    if (step === 3 && points[1] && points[2]) {
      points[2].timestamp = points[1].timestamp;
      points[2].dataIndex = points[1].dataIndex;
      if (params.performPointIndex === 2 && p && p.value != null) {
        points[2].value = p.value;
      }
    }
  }

  function positionPressed(params) {
    var points = params.points;
    var idx = params.performPointIndex;
    var p = params.performPoint;
    if (idx === 1 && points[2]) {
      points[2].timestamp = p.timestamp;
      points[2].dataIndex = p.dataIndex;
    }
    if (idx === 2 && points[1] && points[2]) {
      points[2].timestamp = points[1].timestamp;
      points[2].dataIndex = points[1].dataIndex;
    }
  }

  function registerDrawingOverlays() {
    if (!window.klinecharts || !klinecharts.registerOverlay) return;
    klinecharts.registerOverlay({
      name: "tvText",
      totalStep: 2,
      needDefaultPointFigure: true,
      styles: {
        text: {
          backgroundColor: "rgba(0,0,0,0)",
          borderColor: "rgba(0,0,0,0)",
          borderSize: 0,
          paddingLeft: 0,
          paddingRight: 0,
          paddingTop: 0,
          paddingBottom: 0
        }
      },
      performEventPressedMove: textCornerPressed,
      createPointFigures: function (params) {
        var c = params.coordinates;
        var overlay = params.overlay;
        if (!c.length) return [];
        var data = parseTextData(overlay.extendData);
        var text = data.text;
        var color = data.color;
        var left, top, right, bot, fontSize;
        if (c.length >= 2) {
          left = Math.min.apply(null, c.map(function (p) { return p.x; }));
          right = Math.max.apply(null, c.map(function (p) { return p.x; }));
          top = Math.min.apply(null, c.map(function (p) { return p.y; }));
          bot = Math.max.apply(null, c.map(function (p) { return p.y; }));
          fontSize = fitTextFontSize(text, Math.max(1, right - left), Math.max(1, bot - top));
        } else {
          var est = estimateTextBox(text, 14);
          left = c[0].x;
          top = c[0].y;
          right = left + est.w;
          bot = top + est.h;
          fontSize = 14;
        }
        var figs = [{
          type: "rect",
          attrs: { x: left, y: top, width: Math.max(1, right - left), height: Math.max(1, bot - top) },
          styles: { style: "fill", color: "rgba(0,0,0,0)", borderColor: "rgba(0,0,0,0)", borderSize: 0 }
        }];
        var lines = String(text).split(/\r?\n/);
        var lineH = fontSize * 1.25;
        lines.forEach(function (line, i) {
          figs.push({
            type: "text",
            attrs: {
              x: left + 2,
              y: top + 2 + i * lineH,
              text: line || " ",
              align: "left",
              baseline: "top"
            },
            styles: {
              style: "fill",
              color: color,
              size: fontSize,
              family: "Segoe UI, sans-serif",
              weight: "600",
              backgroundColor: "rgba(0,0,0,0)",
              borderColor: "rgba(0,0,0,0)",
              borderSize: 0,
              paddingLeft: 0,
              paddingRight: 0,
              paddingTop: 0,
              paddingBottom: 0
            }
          });
        });
        return figs;
      }
    });
    klinecharts.registerOverlay({
      name: "tvRect",
      totalStep: 3,
      needDefaultPointFigure: true,
      createPointFigures: function (params) {
        var c = params.coordinates;
        var overlay = params.overlay;
        if (c.length < 2) return [];
        var data = parseRectData(overlay.extendData);
        var figs = [boxFigures(c[0], c[1], hexToRgba(data.color, 0.18), data.color)];
        var raw = (data.text || "").trim();
        if (!raw) return figs;
        var lines = raw.split(/\r?\n/);
        var cx = (c[0].x + c[1].x) / 2;
        var cy = (c[0].y + c[1].y) / 2;
        var lineH = 17;
        var startY = cy - ((lines.length - 1) * lineH) / 2;
        lines.forEach(function (line, i) {
          figs.push({
            type: "text",
            attrs: {
              x: cx, y: startY + i * lineH,
              text: line || " ",
              align: "center", baseline: "middle"
            },
            styles: {
              style: "fill",
              color: "#ffffff",
              size: 12,
              family: "Segoe UI, sans-serif",
              weight: "700",
              paddingLeft: 8,
              paddingRight: 8,
              paddingTop: 3,
              paddingBottom: 3,
              backgroundColor: "rgba(13,17,23,0.9)",
              borderColor: data.color,
              borderSize: 1,
              borderRadius: 4
            }
          });
        });
        return figs;
      }
    });
    klinecharts.registerOverlay({
      name: "tvMeasure",
      totalStep: 3,
      needDefaultPointFigure: true,
      createPointFigures: function (params) {
        var c = params.coordinates;
        var overlay = params.overlay;
        if (c.length < 2) return [];
        var pts = overlay.points || [];
        var p0 = pts[0] || {};
        var p1 = pts[1] || {};
        var price = (p1.value != null && p0.value != null) ? (p1.value - p0.value) : 0;
        var pct = p0.value ? (price / Math.abs(p0.value)) * 100 : 0;
        var bars = 0;
        if (p0.dataIndex != null && p1.dataIndex != null) bars = Math.abs(p1.dataIndex - p0.dataIndex);
        var dur = (p0.timestamp != null && p1.timestamp != null) ? fmtDur(p1.timestamp - p0.timestamp) : "";
        var up = price >= 0;
        var fill = up ? "rgba(63,185,80,0.16)" : "rgba(248,81,73,0.16)";
        var border = up ? "#3fb950" : "#f85149";
        var cx = (c[0].x + c[1].x) / 2;
        var cy = (c[0].y + c[1].y) / 2;
        var sign = up ? "+" : "";
        return [
          boxFigures(c[0], c[1], fill, border),
          {
            type: "line",
            attrs: { coordinates: [c[0], c[1]] },
            styles: { color: border, size: 1, style: "dashed" }
          },
          {
            type: "text",
            attrs: {
              x: cx, y: cy - 14,
              text: bars + " bars  " + dur,
              align: "center", baseline: "middle"
            },
            styles: { color: "#e6edf3", size: 11, backgroundColor: "rgba(13,17,23,0.85)", paddingLeft: 6, paddingRight: 6, paddingTop: 2, paddingBottom: 2, borderRadius: 3 }
          },
          {
            type: "text",
            attrs: {
              x: cx, y: cy + 8,
              text: sign + price.toFixed(2) + "  (" + sign + pct.toFixed(2) + "%)",
              align: "center", baseline: "middle"
            },
            styles: { color: border, size: 12, weight: "bold", backgroundColor: "rgba(13,17,23,0.85)", paddingLeft: 6, paddingRight: 6, paddingTop: 2, paddingBottom: 2, borderRadius: 3 }
          }
        ];
      }
    });
    klinecharts.registerOverlay({
      name: "tvLongPosition",
      totalStep: 4,
      needDefaultPointFigure: true,
      needDefaultYAxisFigure: true,
      createPointFigures: function (params) {
        return positionFigures(params.coordinates, params.overlay, "long");
      },
      performEventMoveForDrawing: positionMove,
      performEventPressedMove: positionPressed
    });
    klinecharts.registerOverlay({
      name: "tvShortPosition",
      totalStep: 4,
      needDefaultPointFigure: true,
      needDefaultYAxisFigure: true,
      createPointFigures: function (params) {
        return positionFigures(params.coordinates, params.overlay, "short");
      },
      performEventMoveForDrawing: positionMove,
      performEventPressedMove: positionPressed
    });
    klinecharts.registerOverlay({
      name: "pyZone",
      totalStep: 3,
      needDefaultPointFigure: false,
      styles: {
        text: {
          backgroundColor: "rgba(0,0,0,0)",
          borderColor: "rgba(0,0,0,0)",
          borderSize: 0,
          paddingLeft: 0,
          paddingRight: 0,
          paddingTop: 0,
          paddingBottom: 0
        }
      },
      createPointFigures: function (params) {
        var c = params.coordinates;
        var overlay = params.overlay;
        if (c.length < 2) return [];
        var d = overlay.extendData || {};
        var fill = d.fill || "rgba(248,81,73,0.16)";
        var border = d.border || "#f85149";
        var left = Math.min(c[0].x, c[1].x);
        var right = Math.max(c[0].x, c[1].x);
        var top = Math.min(c[0].y, c[1].y);
        var bot = Math.max(c[0].y, c[1].y);
        var midY = (c[0].y + c[1].y) / 2;
        var labelColor = overlayContrastText();
        var bounding = params.bounding;
        var paneRight = right;
        if (bounding) {
          if (isFinite(bounding.right)) paneRight = bounding.right;
          else if (isFinite(bounding.width)) paneRight = (bounding.left || bounding.x || 0) + bounding.width;
        }
        if (d.live && isFinite(paneRight)) right = Math.max(right, paneRight - 2);
        var labelX = left + 6;
        if (d.style === "bos") {
          return [
            {
              type: "line",
              ignoreEvent: true,
              attrs: { coordinates: [{ x: left, y: midY }, { x: right, y: midY }] },
              styles: { color: border, size: 2 }
            },
            {
              type: "circle",
              ignoreEvent: true,
              attrs: { x: left, y: midY, r: 3 },
              styles: { style: "stroke_fill", color: border, borderColor: border }
            },
            {
              type: "text",
              ignoreEvent: true,
              attrs: { x: labelX, y: midY - 6, text: d.label || "BOS", align: "left", baseline: "bottom" },
              styles: { color: labelColor, size: 10, weight: "700" }
            }
          ];
        }
        var h = Math.max(1, bot - top);
        var fontSize = h >= 30 ? 15 : (h >= 20 ? 13 : 11);
        return [
          {
            type: "rect",
            ignoreEvent: true,
            attrs: { x: left, y: top, width: Math.max(1, right - left), height: h },
            styles: { style: "fill", color: fill }
          },
          {
            type: "line",
            ignoreEvent: true,
            attrs: { coordinates: [{ x: left, y: midY }, { x: right, y: midY }] },
            styles: { color: border, size: 1 }
          },
          {
            type: "text",
            ignoreEvent: true,
            attrs: {
              x: labelX,
              y: midY,
              text: d.label || "",
              align: "left",
              baseline: "middle"
            },
            styles: {
              style: "stroke",
              color: labelColor,
              size: fontSize,
              weight: "700",
              family: "Segoe UI, Arial, sans-serif",
              backgroundColor: "rgba(0,0,0,0)",
              borderColor: "rgba(0,0,0,0)",
              borderSize: 0,
              paddingLeft: 0,
              paddingRight: 0,
              paddingTop: 0,
              paddingBottom: 0
            }
          }
        ];
      }
    });
    klinecharts.registerOverlay({
      name: "pySmooth",
      totalStep: 2,
      needDefaultPointFigure: false,
      createPointFigures: function (params) {
        var ext = (params.overlay && params.overlay.extendData) || {};
        var lines = ext.lines || [];
        var times = ext.times || [];
        var xAxis = params.xAxis;
        var yAxis = params.yAxis;
        if (!xAxis || !yAxis || !lines.length) return [];
        var owner = overlayOwnerChart(params.overlay);
        var list = chartDataListOf(owner);
        if (!list.length) return [];
        var range = visibleBarRangeOf(owner, list.length);
        var from = range.from;
        var to = range.to;
        var span = to - from + 1;
        var step = Math.max(1, Math.ceil(span / 480));
        var figs = [];
        var li, i, vals, coords, v, ts, pt, lastI, map;
        for (li = 0; li < lines.length; li++) {
          vals = lines[li].values || [];
          map = null;
          if (times.length && times.length !== list.length) {
            map = {};
            for (i = 0; i < times.length; i++) {
              if (times[i] != null) map[times[i]] = vals[i];
            }
          }
          coords = [];
          lastI = -1;
          for (i = from; i <= to; i += step) {
            ts = list[i] && list[i].timestamp;
            v = map ? map[ts] : vals[i];
            if (v == null || !isFinite(v)) continue;
            pt = panePoint(ts, v, i, xAxis, yAxis, owner);
            if (!pt) continue;
            coords.push(pt);
            lastI = i;
          }
          if (lastI < to && list[to]) {
            ts = list[to].timestamp;
            v = map ? map[ts] : vals[to];
            if (v != null && isFinite(v)) {
              pt = panePoint(ts, v, to, xAxis, yAxis, owner);
              if (pt) coords.push(pt);
            }
          }
          if (coords.length > 1) {
            figs.push({
              type: "line",
              ignoreEvent: true,
              attrs: { coordinates: coords },
              styles: { color: lines[li].color || "#58a6ff", size: lines[li].thickness || 1 }
            });
          }
          if (lines[li].markers && coords.length) {
            var marks = 0;
            var prev = null;
            var cur;
            for (i = from + 1; i < to && marks < 24; i++) {
              ts = list[i] && list[i].timestamp;
              var v0 = map ? map[list[i - 1] && list[i - 1].timestamp] : vals[i - 1];
              cur = map ? map[ts] : vals[i];
              var v2 = map ? map[list[i + 1] && list[i + 1].timestamp] : vals[i + 1];
              if (v0 == null || cur == null || v2 == null) continue;
              if ((cur > v0 && cur >= v2) || (cur < v0 && cur <= v2)) {
                pt = panePoint(ts, cur, i, xAxis, yAxis, owner);
                if (pt) {
                  figs.push({
                    type: "circle",
                    ignoreEvent: true,
                    attrs: { x: pt.x, y: pt.y, r: 3 },
                    styles: { style: "stroke_fill", color: lines[li].markerColor || lines[li].color, borderColor: lines[li].markerColor || lines[li].color }
                  });
                  marks += 1;
                }
              }
              prev = cur;
            }
          }
        }
        return figs;
      }
    });
    klinecharts.registerOverlay({
      name: "excelLine",
      totalStep: 3,
      needDefaultPointFigure: false,
      createPointFigures: function (params) {
        var ext = (params.overlay && params.overlay.extendData) || {};
        var color = ext.color || "#58a6ff";
        var pts = ext.points || [];
        var xAxis = params.xAxis;
        var yAxis = params.yAxis;
        if (!pts.length || !xAxis || !yAxis) return [];
        var owner = overlayOwnerChart(params.overlay);
        var list = chartDataListOf(owner);
        var range = visibleBarRangeOf(owner, list.length);
        var coords = [];
        var i, p, ts, di, pt, v;
        for (i = 0; i < pts.length; i++) {
          p = pts[i];
          if (!p || p.value == null || !isFinite(Number(p.value))) continue;
          v = Number(p.value);
          ts = p.timestamp != null ? Number(p.timestamp) : null;
          di = p.dataIndex;
          if (list.length && ts != null) {
            di = timestampIndex(ts, list);
            if (di < range.from - 2 || di > range.to + 2) continue;
          }
          pt = panePoint(ts, v, di, xAxis, yAxis, owner);
          if (pt) coords.push(pt);
        }
        if (!coords.length) return [];
        if (coords.length === 1) {
          return [{
            type: "circle",
            ignoreEvent: true,
            attrs: { x: coords[0].x, y: coords[0].y, r: 3 },
            styles: { style: "stroke_fill", color: color, borderColor: color }
          }];
        }
        return [{
          type: "line",
          ignoreEvent: true,
          attrs: { coordinates: coords },
          styles: { color: color, size: 2 }
        }];
      }
    });
    klinecharts.registerOverlay({
      name: "excelLabel",
      totalStep: 2,
      needDefaultPointFigure: false,
      createPointFigures: function (params) {
        var c = (params.coordinates || [])[0];
        if (!c) return [];
        var ext = (params.overlay && params.overlay.extendData) || {};
        var text = ext.text != null ? String(ext.text) : "";
        var color = ext.color || "#3fb950";
        if (!text) return [];
        return [{
          type: "text",
          ignoreEvent: true,
          attrs: { x: c.x, y: c.y + 10, text: text, align: "center", baseline: "top" },
          styles: {
            style: "fill",
            color: color,
            size: 11,
            weight: "700",
            family: "Segoe UI, sans-serif",
            backgroundColor: "rgba(0,0,0,0)",
            borderColor: "rgba(0,0,0,0)",
            borderSize: 0
          }
        }];
      }
    });
  }

  function overlayHooks() {
    return {
      groupId: "userdraw",
      mode: magnetOn ? "weak_magnet" : "normal",
      onClick: function (ev) {
        if (!drawingAllowedOnEvent(ev)) return;
        selectedOverlayId = overlayIdFromEvent(ev);
      },
      onSelected: function (ev) {
        if (!drawingAllowedOnEvent(ev)) return;
        selectedOverlayId = overlayIdFromEvent(ev);
      },
      onDeselected: function () {
        selectedOverlayId = null;
      },
      onDrawEnd: function (ev) {
        var id = overlayIdFromEvent(ev);
        var drawSlot = slotIndexForOverlay(id);
        if (_pendingDrawId && id === _pendingDrawId) {
          _pendingDrawId = null;
          _pendingDrawSlot = -1;
        }
        setActiveDraw("cursor");
        var name = overlayNameFromEvent(ev);
        setTimeout(function () {
          withSlot(drawSlot, function () {
            if (name === "tvText" && id) {
              ensureTextBox(id);
              persistOverlays(drawSlot);
              openTextModal(id, true);
              return;
            }
            persistOverlays(drawSlot);
            if (name === "tvRect" && id) openRectModal(id);
          });
        }, 0);
      },
      onDoubleClick: function (ev) {
        if (!drawingAllowedOnEvent(ev)) return false;
        var id = overlayIdFromEvent(ev);
        var name = overlayNameFromEvent(ev);
        if (name === "tvText" && id) openTextModal(id, false);
        if (name === "tvRect" && id) openRectModal(id);
        return false;
      },
      onPressedMoveEnd: function (ev) {
        if (!drawingAllowedOnEvent(ev)) return;
        persistOverlays(slotIndexForOverlay(overlayIdFromEvent(ev)));
      },
      onRemoved: function (ev) {
        var id = overlayIdFromEvent(ev);
        var drawSlot = slotIndexForOverlay(id);
        forgetOverlayId(id, drawSlot);
        if (selectedOverlayId === id) selectedOverlayId = null;
        if (_pendingDrawId === id) {
          _pendingDrawId = null;
          _pendingDrawSlot = -1;
        }
        persistOverlays(drawSlot);
      }
    };
  }

  function drawingAllowedOnEvent(ev) {
    var oid = overlayIdFromEvent(ev);
    if (!oid) return _curSlot === activeSlot;
    var i, s, found;
    for (i = 0; i < splitCount; i++) {
      s = chartSlots[i];
      if (!s || !s.chart) continue;
      found = null;
      try { found = s.chart.getOverlayById(oid); } catch (_) {}
      if (found) return i === activeSlot;
    }
    return _curSlot === activeSlot;
  }

  function clearPendingDraw() {
    if (_pendingDrawId == null) return;
    var id = _pendingDrawId;
    var slotIdx = _pendingDrawSlot;
    _pendingDrawId = null;
    _pendingDrawSlot = -1;
    var s = (slotIdx >= 0 && chartSlots[slotIdx]) ? chartSlots[slotIdx] : null;
    var c = s && s.chart;
    if (c) {
      try { c.removeOverlay({ id: id }); } catch (_) {
        try { c.removeOverlay(id); } catch (__) {}
      }
    }
    forgetOverlayId(id, slotIdx >= 0 ? slotIdx : _curSlot);
    if (_curSlot === slotIdx && selectedOverlayId === id) selectedOverlayId = null;
  }

  function copyPoint(p) {
    if (!p || typeof p !== "object") return null;
    var out = {};
    if (p.timestamp != null && isFinite(Number(p.timestamp))) out.timestamp = Number(p.timestamp);
    if (p.value != null && isFinite(Number(p.value))) out.value = Number(p.value);
    if (p.dataIndex != null && isFinite(Number(p.dataIndex))) out.dataIndex = Number(p.dataIndex);
    return (out.timestamp != null || out.value != null || out.dataIndex != null) ? out : null;
  }

  function normalizeSavedPoints(name, points) {
    var pts = (points || []).map(copyPoint).filter(Boolean);
    if ((name === "tvLongPosition" || name === "tvShortPosition") && pts.length >= 2) {
      if (pts[1] && pts[2]) {
        if (pts[2].timestamp == null && pts[1].timestamp != null) pts[2].timestamp = pts[1].timestamp;
        if (pts[2].dataIndex == null && pts[1].dataIndex != null) pts[2].dataIndex = pts[1].dataIndex;
      }
    }
    return pts;
  }

  function collectOverlays() {
    if (!chart) return [];
    var saved = [];
    overlayIds.forEach(function (id) {
      var o = chart.getOverlayById(id);
      if (!o || !o.points || !o.points.length) return;
      if (o.name === "pyZone" || o.name === "pySmooth" || o.name === "excelLine" || o.name === "excelLabel") return;
      var points = normalizeSavedPoints(o.name, o.points);
      if (!points.length) return;
      saved.push({
        name: o.name,
        points: points,
        extendData: o.extendData
      });
    });
    return saved;
  }

  function persistOverlays(slotIdx) {
    function run() {
      if (_overlaysSuspended) return;
      var slot = chartSlots[_curSlot];
      var key = _loadedDrawKey || (slot && slot.loadedDrawKey) || drawingStoreKey();
      if (!key) return;
      var saved = collectOverlays();
      _drawingCache[key] = saved;
      if (slot) slot.loadedDrawKey = key;
      _loadedDrawKey = key;
      var all = storageGet(LS_OVERLAYS, {});
      all[key] = saved;
      storageSet(LS_OVERLAYS, all);
      clearTimeout(_saveDrawTimers[key]);
      _saveDrawTimers[key] = setTimeout(function () {
        delete _saveDrawTimers[key];
        fetch("/api/settings/chart-drawings", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ key: key, overlays: saved })
        }).catch(function () {});
      }, 350);
    }
    if (slotIdx == null || slotIdx === _curSlot) run();
    else withSlot(slotIdx, run);
  }
  function persistVisibleDrawings() {
    var i;
    for (i = 0; i < splitCount; i++) {
      if (chartSlots[i] && chartSlots[i].chart) persistOverlays(i);
    }
  }

  function applyOverlayList(saved) {
    overlayIds.length = 0;
    selectedOverlayId = null;
    if (!chart || !saved || !saved.length) return;
    saved.forEach(function (item) {
      if (!item || !item.name || !item.points || item.name === "pyZone" || item.name === "pySmooth" || item.name === "excelLine" || item.name === "excelLabel") return;
      var spec = Object.assign({
        name: item.name,
        points: normalizeSavedPoints(item.name, item.points)
      }, overlayHooks());
      if (item.extendData != null) spec.extendData = item.extendData;
      var id = chart.createOverlay(spec, "candle_pane");
      if (id) overlayIds.push(id);
    });
    overlayIds.forEach(function (id) { ensureTextBox(id); });
  }

  function pickSavedOverlays(key, inst, all, remote) {
    if (Object.prototype.hasOwnProperty.call(_drawingCache, key)) return _drawingCache[key] || [];
    if (all && Object.prototype.hasOwnProperty.call(all, key)) return all[key] || [];
    if (remote && Object.prototype.hasOwnProperty.call(remote, key)) return remote[key] || [];
    var fallbacks = drawingKeyFallbacks(inst);
    var i, lk;
    for (i = 0; i < fallbacks.length; i++) {
      lk = fallbacks[i];
      if (_drawingCache[lk] && _drawingCache[lk].length) return _drawingCache[lk];
      if (all && all[lk] && all[lk].length) return all[lk];
      if (remote && remote[lk] && remote[lk].length) return remote[lk];
    }
    return [];
  }

  async function restoreOverlays(slotIdx) {
    var idx = slotIdx != null ? slotIdx : _curSlot;
    var slot = chartSlots[idx];
    if (!slot || !slot.chart) return;
    var inst = slot.instrument;
    var key = drawingStoreKey(inst, slot.interval);
    slot.loadedDrawKey = key;
    if (_curSlot === idx) _loadedDrawKey = key;
    if (!key) return;
    var all = storageGet(LS_OVERLAYS, {});
    var saved = pickSavedOverlays(key, inst, all, null);
    var remoteAll = null;
    try {
      var res = await fetch("/api/settings/chart-drawings?key=" + encodeURIComponent(key));
      var data = await res.json();
      if (data && data.success && data.found) {
        saved = data.overlays || [];
      } else if (data && data.success && data.overlays && data.overlays.length) {
        saved = data.overlays;
      } else {
        if (!saved.length) {
          res = await fetch("/api/settings/chart-drawings");
          data = await res.json();
          remoteAll = (data && data.drawings) || {};
          saved = pickSavedOverlays(key, inst, all, remoteAll);
        }
        if (saved.length) {
          fetch("/api/settings/chart-drawings", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ key: key, overlays: saved })
          }).catch(function () {});
        }
      }
    } catch (_) {}
    if (!chartSlots[idx] || chartSlots[idx].chart !== slot.chart) return;
    withSlot(idx, function () {
      _drawingCache[key] = saved;
      slot.loadedDrawKey = key;
      _loadedDrawKey = key;
      applyOverlayList(saved);
    });
  }

  function persistIndicators() {
    var slim = activeIndicators.map(function (item) {
      return {
        kind: item.kind,
        name: item.name,
        id: item.id,
        uid: item.uid,
        calcParams: item.calcParams,
        params: item.params,
        color: item.color,
        overlay: item.overlay,
        visible: item.visible !== false
      };
    });
    storageSet(slotIndKey(), slim);
  }

  function loadActiveInds() {
    var raw = storageGet(slotIndKey(), []);
    if (Array.isArray(raw)) return raw;
    var best = [];
    Object.keys(raw || {}).forEach(function (k) {
      if ((raw[k] || []).length > best.length) best = raw[k];
    });
    return best;
  }

  function specOf(name) {
    return IND_SPECS[name] || { overlay: !!OVERLAY_INDS[name], params: [{ label: "Length (candles)", def: 20 }] };
  }

  function parsePeriods(raw, fallback) {
    var vals = String(raw == null ? "" : raw).split(/[,\s]+/).map(Number).filter(function (n) {
      return isFinite(n) && n >= 1 && n <= 500;
    }).map(function (n) { return Math.round(n); });
    return vals.length ? vals : (fallback || [20]);
  }

  function defaultParams(name) {
    if (name === "VOL") return [];
    var spec = specOf(name);
    if (spec.csv) return parsePeriods(spec.params[0].def, [Number(spec.params[0].def) || 20]);
    return spec.params.map(function (p) { return p.def; });
  }

  function nextIndColor() {
    return IND_COLORS[activeIndicators.length % IND_COLORS.length];
  }

  function formatIndLabel(item) {
    var name = item.name || item.indName || "Indicator";
    if (item.kind === "custom") return name;
    var p = item.calcParams || [];
    if (item.kind === "python") {
      var nums = p.filter(function (v) { return typeof v === "number" && isFinite(v); });
      return nums.length ? name + " (" + nums.join(", ") + ")" : name;
    }
    if (!p.length) return name;
    return name + " (" + p.join(", ") + ")";
  }

  function lineStyle(color) {
    return {
      style: "solid",
      smooth: false,
      size: 1,
      dashedValue: [2, 2],
      color: color || "#FF9600"
    };
  }

  var _indTemplates = {};
  var _indSeedQ = {};
  var _chartGen = 0;

  function newIndUid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }

  function uniqueIndName(baseName, uid) {
    return String(baseName) + "_" + String(uid);
  }

  function istDayKey(ts) {
    try {
      return new Intl.DateTimeFormat("en-CA", {
        timeZone: IST_TZ, year: "numeric", month: "2-digit", day: "2-digit"
      }).format(new Date(ts));
    } catch (_) {
      return new Date(ts).toISOString().slice(0, 10);
    }
  }

  function calcVwap(dataList) {
    var resetByDay = activeInterval !== "D";
    var cumPv = 0;
    var cumV = 0;
    var day = null;
    return (dataList || []).map(function (k) {
      var key = istDayKey(k.timestamp);
      if (resetByDay && key !== day) {
        cumPv = 0;
        cumV = 0;
        day = key;
      }
      var tp = (Number(k.high) + Number(k.low) + Number(k.close)) / 3;
      var vol = Number(k.volume) || 0;
      cumPv += tp * vol;
      cumV += vol;
      return { vwap: cumV > 0 ? cumPv / cumV : tp };
    });
  }

  function calcSuperTrend(dataList, indicator) {
    var params = (indicator && indicator.calcParams) || [10, 3];
    var period = Math.max(2, Math.round(Number(params[0]) || 10));
    var mult = Number(params[1]);
    if (!isFinite(mult) || mult <= 0) mult = 3;
    var n = (dataList || []).length;
    var out = new Array(n);
    var i;
    var tr = new Array(n);
    var atr = new Array(n);
    for (i = 0; i < n; i++) {
      var h = Number(dataList[i].high);
      var l = Number(dataList[i].low);
      var c = Number(dataList[i].close);
      var pc = i ? Number(dataList[i - 1].close) : c;
      tr[i] = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
    }
    var sum = 0;
    for (i = 0; i < n; i++) {
      if (i < period) {
        sum += tr[i];
        atr[i] = i === period - 1 ? sum / period : null;
      } else {
        atr[i] = (atr[i - 1] * (period - 1) + tr[i]) / period;
      }
    }
    var fu = new Array(n);
    var fl = new Array(n);
    var st = new Array(n);
    var dir = new Array(n);
    for (i = 0; i < n; i++) {
      if (atr[i] == null) {
        out[i] = {};
        continue;
      }
      var mid = (Number(dataList[i].high) + Number(dataList[i].low)) / 2;
      var bu = mid + mult * atr[i];
      var bl = mid - mult * atr[i];
      var prevC = i ? Number(dataList[i - 1].close) : Number(dataList[i].close);
      if (fu[i - 1] == null) {
        fu[i] = bu;
        fl[i] = bl;
      } else {
        fu[i] = (bu < fu[i - 1] || prevC > fu[i - 1]) ? bu : fu[i - 1];
        fl[i] = (bl > fl[i - 1] || prevC < fl[i - 1]) ? bl : fl[i - 1];
      }
      var close = Number(dataList[i].close);
      if (st[i - 1] == null) {
        dir[i] = close >= mid ? 1 : -1;
        st[i] = dir[i] === 1 ? fl[i] : fu[i];
      } else if (dir[i - 1] === 1) {
        if (close < fl[i]) {
          dir[i] = -1;
          st[i] = fu[i];
        } else {
          dir[i] = 1;
          st[i] = fl[i];
        }
      } else if (close > fu[i]) {
        dir[i] = 1;
        st[i] = fl[i];
      } else {
        dir[i] = -1;
        st[i] = fu[i];
      }
      out[i] = dir[i] === 1 ? { up: st[i], down: null } : { up: null, down: st[i] };
    }
    return out;
  }

  function localIndDef(baseName, uniqueName) {
    if (baseName === "VWAP") {
      return {
        name: uniqueName,
        shortName: "VWAP",
        series: "price",
        calcParams: [],
        figures: [{ key: "vwap", title: "VWAP: ", type: "line" }],
        calc: calcVwap
      };
    }
    return {
      name: uniqueName,
      shortName: "ST",
      series: "price",
      calcParams: [10, 3],
      figures: [
        { key: "up", title: "ST Up: ", type: "line" },
        { key: "down", title: "ST Down: ", type: "line" }
      ],
      styles: {
        lines: [
          { color: "#3fb950", size: 1 },
          { color: "#f85149", size: 1 }
        ]
      },
      calc: calcSuperTrend
    };
  }

  function registerLocalInd(baseName, uniqueName) {
    if (!LOCAL_INDS[baseName] || !uniqueName) return false;
    var supported = [];
    try { supported = klinecharts.getSupportedIndicators() || []; } catch (_) {}
    if (supported.indexOf(uniqueName) >= 0) return true;
    try {
      klinecharts.registerIndicator(localIndDef(baseName, uniqueName));
      return true;
    } catch (_) {
      return false;
    }
  }

  function snapshotIndTemplate(inst) {
    return {
      shortName: inst.shortName,
      series: inst.series,
      calcParams: (inst.calcParams || []).slice(),
      figures: inst.figures,
      precision: inst.precision,
      shouldOhlc: inst.shouldOhlc,
      shouldFormatBigNumber: inst.shouldFormatBigNumber,
      regenerateFigures: inst.regenerateFigures,
      createTooltipDataSource: inst.createTooltipDataSource,
      draw: inst.draw,
      calc: inst.calc
    };
  }

  function withIndTemplate(baseName, fn) {
    if (!chart) { fn(null); return; }
    if (_indTemplates[baseName]) { fn(_indTemplates[baseName]); return; }
    if (!_indSeedQ[baseName]) {
      _indSeedQ[baseName] = [];
      var gen = _chartGen;
      var paneId = null;
      try { paneId = chart.createIndicator(baseName, false, { height: 1 }); } catch (_) {}
      setTimeout(function () {
        var q = _indSeedQ[baseName] || [];
        delete _indSeedQ[baseName];
        if (!chart || gen !== _chartGen) {
          q.forEach(function (cb) { withIndTemplate(baseName, cb); });
          return;
        }
        var inst = null;
        try { inst = paneId ? chart.getIndicatorByPaneId(paneId, baseName) : null; } catch (_) {}
        if (inst) _indTemplates[baseName] = snapshotIndTemplate(inst);
        try { if (paneId) chart.removeIndicator(paneId, baseName); } catch (_) {}
        var tmpl = _indTemplates[baseName] || null;
        q.forEach(function (cb) { try { cb(tmpl); } catch (_) {} });
      }, 120);
    }
    _indSeedQ[baseName].push(fn);
  }

  function registerUniqueInd(baseName, uniqueName, tmpl) {
    if (!tmpl || !uniqueName) return false;
    var supported = [];
    try { supported = klinecharts.getSupportedIndicators() || []; } catch (_) {}
    if (supported.indexOf(uniqueName) >= 0) return true;
    try {
      klinecharts.registerIndicator({
        name: uniqueName,
        shortName: baseName,
        series: tmpl.series,
        calcParams: (tmpl.calcParams || []).slice(),
        figures: tmpl.figures,
        precision: tmpl.precision,
        shouldOhlc: tmpl.shouldOhlc,
        shouldFormatBigNumber: tmpl.shouldFormatBigNumber,
        regenerateFigures: tmpl.regenerateFigures,
        createTooltipDataSource: tmpl.createTooltipDataSource,
        draw: tmpl.draw,
        calc: tmpl.calc
      });
      return true;
    } catch (_) {
      return false;
    }
  }

  function overrideBuiltin(item) {
    if (!chart || !item || item.kind === "custom" || item.kind === "python") return;
    var params = item.name === "VOL" ? [] : (item.calcParams || defaultParams(item.name)).slice();
    var lines = [];
    var n = Math.max(item.name === "VOL" ? 0 : 1, params.length);
    var i;
    for (i = 0; i < n; i++) lines.push(lineStyle(item.color));
    var indName = item.indName || item.name;
    try {
      var spec = {
        name: indName,
        shortName: formatIndLabel(item),
        calcParams: params,
        visible: item.visible !== false
      };
      if (item.name === "SuperTrend") {
        spec.styles = { lines: [lineStyle("#3fb950"), lineStyle("#f85149")] };
      } else if (lines.length) {
        spec.styles = { lines: lines };
      }
      chart.overrideIndicator(spec, item.overlay ? "candle_pane" : item.paneId);
    } catch (_) {}
  }

  function applyItemToChart(item) {
    if (!chart || !item || item.kind === "custom" || item.kind === "python") return;
    if (!item.uid) item.uid = newIndUid();
    if (item.name === "VOL") item.overlay = true;
    var overlay = !!item.overlay;
    var params = item.name === "VOL" ? [] : (item.calcParams || defaultParams(item.name)).slice();
    if (item.name === "VOL") item.calcParams = [];
    if (!overlay) {
      var paneId = null;
      try {
        paneId = chart.createIndicator({
          name: item.name,
          shortName: formatIndLabel(item),
          calcParams: params
        }, false, { height: 100 });
      } catch (_) {}
      item.indName = item.name;
      item.paneId = paneId || item.name;
      setTimeout(function () { overrideBuiltin(item); updateChartLegendValues(); }, 80);
      return;
    }
    var uniqueName = uniqueIndName(item.name, item.uid);
    if (LOCAL_INDS[item.name]) {
      var localName = item.name;
      if (registerLocalInd(item.name, uniqueName)) localName = uniqueName;
      item.indName = localName;
      var localCreated = null;
      try {
        localCreated = chart.createIndicator({
          name: localName,
          shortName: formatIndLabel(item),
          calcParams: params
        }, true, { id: "candle_pane" });
      } catch (_) {}
      item.paneId = localCreated || "candle_pane";
      setTimeout(function () { overrideBuiltin(item); updateChartLegendValues(); }, 80);
      return;
    }
    withIndTemplate(item.name, function (tmpl) {
      if (!chart) return;
      var indName = item.name;
      if (tmpl && registerUniqueInd(item.name, uniqueName, tmpl)) indName = uniqueName;
      item.indName = indName;
      var created = null;
      try {
        created = chart.createIndicator({
          name: indName,
          shortName: formatIndLabel(item),
          calcParams: params
        }, true, { id: "candle_pane" });
      } catch (_) {}
      item.paneId = created || "candle_pane";
      setTimeout(function () { overrideBuiltin(item); updateChartLegendValues(); }, 80);
    });
  }

  function restoreIndicators() {
    var saved = loadActiveInds();
    activeIndicators.length = 0;
    saved.forEach(function (item) {
      if (!item) return;
      if (item.kind === "python") {
        applyPythonIndicator(item.id, true, {
          calcParams: item.calcParams,
          params: item.params,
          visible: item.visible !== false,
          name: item.name,
          uid: item.uid,
          color: item.color
        });
        return;
      }
      if (item.kind === "custom") {
        applyCustomToChart(item.id, true, {
          uid: item.uid,
          visible: item.visible !== false,
          color: item.color
        });
        return;
      }
      if (!IND_SPECS[item.name] && !OVERLAY_INDS[item.name] && PANE_INDS.indexOf(item.name) < 0) return;
      var spec = specOf(item.name);
      var next = {
        kind: "builtin",
        name: item.name,
        uid: item.uid,
        calcParams: item.name === "VOL" ? [] : ((item.calcParams && item.calcParams.length) ? item.calcParams.slice() : defaultParams(item.name)),
        color: item.color || nextIndColor(),
        overlay: item.name === "VOL" ? true : (item.overlay != null ? item.overlay : !!spec.overlay),
        visible: item.visible !== false
      };
      applyItemToChart(next);
      activeIndicators.push(next);
    });
    renderIndicatorPop();
    renderCustomPop();
  }

  function addIndicator(name, skipPersist, preset) {
    var spec = specOf(name);
    preset = preset || {};
    var item = {
      kind: "builtin",
      name: name,
      uid: newIndUid(),
      calcParams: name === "VOL" ? [] : ((preset.calcParams && preset.calcParams.length) ? preset.calcParams.slice() : defaultParams(name)),
      color: preset.color || nextIndColor(),
      overlay: name === "VOL" ? true : !!spec.overlay
    };
    applyItemToChart(item);
    activeIndicators.push(item);
    if (!skipPersist) persistIndicators();
    renderIndicatorPop();
  }

  function promptAddIndicator(name) {
    var spec = specOf(name);
    if (!spec.params || !spec.params.length) {
      addIndicator(name);
      return;
    }
    openIndSettingsAdd(name);
  }

  function removeActive(idx) {
    if (!activeIndicators[idx]) return;
    var item = activeIndicators[idx];
    if (chart) {
      try {
        if (item.kind === "python") {
          removePythonOverlays(item);
          if (item.indName) {
            try { chart.removeIndicator("candle_pane", item.indName); } catch (_) {}
          }
          item._lineOnChart = false;
          if (item.uid) delete _pyLineData[item.uid];
        } else {
          var n = item.indName || item.name;
          if (item.overlay) chart.removeIndicator("candle_pane", n);
          else chart.removeIndicator(item.paneId, n);
        }
      } catch (_) {}
    }
    activeIndicators.splice(idx, 1);
    persistIndicators();
    renderIndicatorPop();
    renderCustomPop();
  }

  function readIndSettingsFields() {
    var spec = _settingsKind === "python" && _settingsPyMeta
      ? _settingsPyMeta
      : specOf(pendingIndName || (activeIndicators[editingIndIdx] && activeIndicators[editingIndIdx].name) || "EMA");
    var colorEl = document.getElementById("ind-settings-color");
    var color = colorEl ? colorEl.value : "#58a6ff";
    if (isSmoothingMeta(spec)) {
      var sm = readSmoothingSettings(spec);
      return { calcParams: [], color: firstSmoothColor(sm), params: sm };
    }
    if (spec.csv) {
      var el = document.getElementById("ind-param-0");
      return { calcParams: parsePeriods(el ? el.value : spec.params[0].def, defaultParams(pendingIndName || "EMA")), color: color };
    }
    var vals = [];
    spec.params.forEach(function (p, i) {
      var inp = document.getElementById("ind-param-" + i);
      if (p.type === "bool") {
        vals.push(!!(inp && inp.checked));
        return;
      }
      var n = inp ? parseFloat(inp.value) : p.def;
      if (!isFinite(n)) n = p.def;
      var min = p.min != null ? p.min : 1;
      var max = p.max != null ? p.max : 500;
      if (n < min) n = min;
      if (n > max) n = max;
      vals.push(p.step && p.step < 1 ? Math.round(n * 100) / 100 : Math.round(n));
    });
    return { calcParams: vals, color: color };
  }

  function openIndSettingsAdd(name) {
    editingIndIdx = null;
    pendingIndName = name;
    _settingsKind = "builtin";
    _settingsPyMeta = null;
    fillIndSettingsModal(name, defaultParams(name), nextIndColor(), false);
  }

  function openIndSettings(idx) {
    var item = activeIndicators[idx];
    if (!item || item.kind === "custom") return;
    if (item.kind === "python") {
      openPyIndSettings(idx);
      return;
    }
    _settingsKind = "builtin";
    _settingsPyMeta = null;
    editingIndIdx = idx;
    pendingIndName = item.name;
    fillIndSettingsModal(item.name, item.calcParams || defaultParams(item.name), item.color || "#58a6ff", true);
  }

  function fillIndSettingsModal(name, params, color, isEdit, specOverride) {
    var spec = specOverride || specOf(name);
    var title = document.getElementById("ind-settings-title");
    var hint = document.getElementById("ind-settings-hint");
    var fields = document.getElementById("ind-settings-fields");
    var modal = document.getElementById("ind-settings-modal");
    var colorWrap = document.getElementById("ind-settings-color-wrap");
    var colorEl = document.getElementById("ind-settings-color");
    var resetBtn = document.getElementById("ind-settings-reset");
    var box = document.getElementById("ind-settings-box");
    if (resetBtn) resetBtn.classList.add("hidden");
    if (box) {
      box.classList.remove("chart-modal-wide");
      box.style.maxWidth = "400px";
    }
    if (title) title.textContent = (isEdit ? "Edit " : "Add ") + name;
    if (isSmoothingMeta(spec)) {
      if (hint) {
        hint.textContent = isEdit
          ? "This copy keeps its own settings. Apply also becomes the default for the next Smoothing you add. Reset restores factory values."
          : "Set CE1–CE4, then apply. Apply becomes the default for the next add. Each copy on the chart keeps its own settings.";
      }
      fillSmoothingSettings(params, spec);
      if (modal) modal.classList.remove("hidden");
      closeIndPicker();
      return;
    }
    if (hint) {
      hint.textContent = spec.csv
        ? (isEdit
          ? "Update this instance. Add the same indicator again for another length, e.g. EMA 20 and EMA 200."
          : "Enter the lookback in candles. Add this indicator again for another length (EMA 20 and EMA 200). Or type 9, 20, 50 for several lines in one instance.")
        : (isEdit
          ? "Update the existing values. You can change these anytime from Indicators."
          : "Set the inputs, then apply. You can add the same indicator more than once with different settings.");
    }
    if (fields) {
      if (spec.csv) {
        var csvVal = (params && params.length) ? params.join(", ") : spec.params[0].def;
        fields.innerHTML = '<div class="ind-param-grid"><div class="ind-param-row"><label for="ind-param-0">' +
          spec.params[0].label + '</label><input type="text" id="ind-param-0" value="' + csvVal + '" /></div></div>';
      } else {
        fields.innerHTML = '<div class="ind-param-grid">' + spec.params.map(function (p, i) {
          var val = params[i] != null ? params[i] : p.def;
          if (p.type === "bool") {
            var on = val === false || val === 0 || val === "0" || val === "false" ? false : !!val;
            return '<div class="ind-param-row ind-param-toggle"><span>' + p.label + "</span>" +
              '<label class="toggle-switch"><input type="checkbox" id="ind-param-' + i + '"' +
              (on ? " checked" : "") + ' /><span class="toggle-slider"></span></label></div>';
          }
          var min = p.min != null ? p.min : 1;
          var max = p.max != null ? p.max : 500;
          var step = p.step != null ? p.step : 1;
          return '<div class="ind-param-row"><label for="ind-param-' + i + '">' + p.label + '</label>' +
            '<input type="number" id="ind-param-' + i + '" min="' + min + '" max="' + max + '" step="' + step + '" value="' + val + '" /></div>';
        }).join("") + "</div>";
      }
    }
    if (colorWrap) colorWrap.style.display = (specOverride || spec.hideColor) ? "none" : "";
    if (colorEl) colorEl.value = color || "#58a6ff";
    if (modal) modal.classList.remove("hidden");
    closeIndPicker();
    setTimeout(function () {
      var first = document.getElementById("ind-param-0");
      if (first) { first.focus(); first.select(); }
    }, 30);
  }

  function closeIndSettings() {
    var modal = document.getElementById("ind-settings-modal");
    if (modal) modal.classList.add("hidden");
    editingIndIdx = null;
    pendingIndName = null;
    _settingsKind = "builtin";
    _settingsPyMeta = null;
  }

  var _savingInd = false;
  function saveIndSettings() {
    if (_savingInd) return;
    _savingInd = true;
    focusActiveSlot();
    var name = pendingIndName;
    var idx = editingIndIdx;
    var kind = _settingsKind;
    var vals = readIndSettingsFields();
    closeIndSettings();
    try {
      if (idx != null && activeIndicators[idx]) {
        var item = activeIndicators[idx];
        item.calcParams = vals.calcParams;
        item.color = vals.color;
        if (vals.params) item.params = vals.params;
        if (item.kind === "python") {
          if (vals.params) savePyLastUsed(item.id, vals.params);
          refreshPythonIndicator(item);
        } else overrideBuiltin(item);
        persistIndicators();
        renderIndicatorPop();
        renderCustomPop();
      } else if (name) {
        if (kind === "python") {
          if (vals.params) savePyLastUsed(name, vals.params);
          applyPythonIndicator(name, false, { calcParams: vals.calcParams, params: vals.params, color: vals.color });
        } else {
          addIndicator(name, false, { calcParams: vals.calcParams, color: vals.color });
        }
      }
    } finally {
      setTimeout(function () { _savingInd = false; }, 200);
    }
  }

  function customIndName(id, uid) {
    return "CUST_" + id + (uid ? "_" + uid : "");
  }

  var _customCalcs = {};
  function registerCustom(def, uniqueName) {
    var plot = def.plot || "line";
    var color = def.color || "#58a6ff";
    var name = uniqueName || customIndName(def.id);
    _customCalcs[name] = def;
    var supported = [];
    try { supported = klinecharts.getSupportedIndicators() || []; } catch (_) {}
    if (supported.indexOf(name) >= 0) return name;
    klinecharts.registerIndicator({
      name: name,
      shortName: def.name || "Custom",
      series: def.pane === "overlay" ? "price" : "normal",
      precision: 4,
      figures: [{ key: "v", title: (def.name || "VAL") + ": ", type: plot }],
      styles: {
        lines: [{ color: color, size: 1 }],
        bars: [{ upColor: color, downColor: color, noChangeColor: color }],
        circles: [{ color: color }]
      },
      calc: function (dataList) {
        var d = _customCalcs[name] || def;
        var values;
        try { values = evalFormula(d.formula, dataList); }
        catch (_) { values = dataList.map(function () { return null; }); }
        return values.map(function (v) {
          return (v == null || !isFinite(v)) ? {} : { v: v };
        });
      }
    });
    return name;
  }

  function applyCustomToChart(id, skipPersist, preset) {
    if (!chart) {
      if (chartMessage) {
        chartMessage.textContent = "Load a chart first, then add the indicator.";
        chartMessage.style.display = "flex";
      }
      return;
    }
    preset = preset || {};
    var def = loadCustomDefs().filter(function (d) { return d.id === id; })[0];
    if (!def) return;
    try { evalFormula(def.formula, [{ open: 1, high: 1, low: 1, close: 1, volume: 1 }]); }
    catch (e) { alert("Formula error: " + e.message); return; }
    var uid = preset.uid || newIndUid();
    var indName = registerCustom(def, customIndName(def.id, uid));
    var overlay = def.pane === "overlay";
    var paneId = overlay
      ? chart.createIndicator(indName, true, { id: "candle_pane" })
      : chart.createIndicator(indName, false, { height: 110 });
    var item = {
      kind: "custom",
      id: id,
      uid: uid,
      name: def.name,
      indName: indName,
      paneId: paneId,
      overlay: overlay,
      color: preset.color || def.color || "#58a6ff",
      visible: preset.visible !== false
    };
    activeIndicators.push(item);
    if (item.visible === false) {
      setTimeout(function () { setIndicatorVisible(item, false); }, 120);
    }
    if (!skipPersist) persistIndicators();
    renderCustomPop();
    renderIndicatorPop();
    setTimeout(updateChartLegendValues, 120);
  }

  function pyMeta(id) {
    var i;
    for (i = 0; i < _pyCatalog.length; i++) {
      if (_pyCatalog[i].id === id) return _pyCatalog[i];
    }
    return null;
  }

  function pyDefaultParams(meta) {
    return (meta.params || []).map(function (p) { return p.def; });
  }

  function pyParamsDict(meta, calcParams) {
    var o = {};
    (meta.params || []).forEach(function (p, i) {
      o[p.key] = calcParams && calcParams[i] != null ? calcParams[i] : p.def;
    });
    return o;
  }

  function isSmoothingMeta(meta) {
    return !!(meta && (meta.ui === "smoothing" || meta.id === "smoothing"));
  }

  function cloneJson(v) {
    return JSON.parse(JSON.stringify(v));
  }

  function smoothingFactory(meta) {
    var src = (meta && meta.factory) || SMOOTH_FALLBACK_FACTORY;
    return cloneJson(src);
  }

  function normalizeSmoothingParams(raw, meta) {
    var factory = smoothingFactory(meta);
    var srcLevels = (raw && raw.levels) || [];
    var levels = [];
    var i;
    for (i = 0; i < 4; i++) {
      var base = factory.levels[i] || SMOOTH_FALLBACK_FACTORY.levels[i];
      var row = Object.assign({}, base, (srcLevels[i] && typeof srcLevels[i] === "object") ? srcLevels[i] : {});
      var allowed = ["price"].concat([1, 2, 3, 4].slice(0, i).map(function (n) { return "ce" + n; }));
      var inp = String(row.input || "").toLowerCase();
      if (inp === "close") inp = "price";
      if (inp.indexOf("ac_") === 0) inp = inp.slice(3);
      row.input = allowed.indexOf(inp) >= 0 ? inp : allowed[allowed.length - 1];
      var model = String(row.model || "savgol").toLowerCase();
      if (model === "savitzky-golay") model = "savgol";
      if (model === "gaussian kernel") model = "gaussian";
      if (model === "kernel poly") model = "kernel_poly";
      if (["none", "savgol", "gaussian", "kernel_poly"].indexOf(model) < 0) model = "savgol";
      row.model = model;
      row.enabled = row.enabled !== false && row.enabled !== 0 && row.enabled !== "0";
      row.markers = !!(row.markers && row.markers !== "0" && row.markers !== "false");
      row.window = Number(row.window); if (!isFinite(row.window)) row.window = 11;
      row.polyorder = Number(row.polyorder); if (!isFinite(row.polyorder)) row.polyorder = 3;
      row.bandwidth = Number(row.bandwidth); if (!isFinite(row.bandwidth)) row.bandwidth = 3;
      row.degree = Number(row.degree); if (!isFinite(row.degree)) row.degree = 2;
      row.thickness = Number(row.thickness); if (!isFinite(row.thickness)) row.thickness = 1;
      row.thickness = Math.max(1, Math.min(10, Math.round(row.thickness)));
      row.color = row.color || base.color || "#58a6ff";
      row.marker_color = row.marker_color || row.markerColor || row.color;
      levels.push(row);
    }
    return { levels: levels };
  }

  function firstSmoothColor(params) {
    var levels = (params && params.levels) || [];
    var i;
    for (i = 0; i < levels.length; i++) {
      if (levels[i] && levels[i].enabled !== false && levels[i].color) return levels[i].color;
    }
    return (levels[0] && levels[0].color) || "#58a6ff";
  }

  function convSame(y, kernel) {
    var n = y.length;
    var klen = kernel.length;
    var half = (klen - 1) / 2;
    var out = new Array(n);
    var i, j, idx, acc, w, wsum;
    for (i = 0; i < n; i++) {
      acc = 0;
      wsum = 0;
      for (j = 0; j < klen; j++) {
        idx = i - half + j;
        if (idx < 0) idx = 0;
        else if (idx >= n) idx = n - 1;
        w = kernel[klen - 1 - j];
        acc += y[idx] * w;
        wsum += w;
      }
      out[i] = wsum ? acc / wsum : y[i];
    }
    return out;
  }

  function gaussKernel(radius, bw) {
    var k = new Array(radius * 2 + 1);
    var i, x, s = 0;
    for (i = 0; i < k.length; i++) {
      x = i - radius;
      k[i] = Math.exp(-0.5 * (x / bw) * (x / bw));
      s += k[i];
    }
    if (s) for (i = 0; i < k.length; i++) k[i] /= s;
    return k;
  }

  function localPolyKernel(radius, degree, bw) {
    var klen = radius * 2 + 1;
    var x = new Array(klen);
    var w = new Array(klen);
    var i, t, s = 0;
    for (i = 0; i < klen; i++) {
      t = i - radius;
      x[i] = t;
      w[i] = Math.exp(-0.5 * (t / bw) * (t / bw));
      s += w[i];
    }
    var deg = Math.max(1, Math.min(degree | 0, radius));
    var dim = deg + 1;
    var xtwx = [];
    var xtw = [];
    var r, c, k;
    for (r = 0; r < dim; r++) {
      xtwx[r] = [];
      xtw[r] = [];
      for (c = 0; c < dim; c++) {
        s = 0;
        for (k = 0; k < klen; k++) s += w[k] * Math.pow(x[k], r) * Math.pow(x[k], c);
        xtwx[r][c] = s;
      }
      for (k = 0; k < klen; k++) xtw[r][k] = w[k] * Math.pow(x[k], r);
    }
    var rhs = xtwx[0].slice();
    var aug = xtwx.map(function (row, ri) { return row.concat([ri === 0 ? 1 : 0]); });
    for (r = 0; r < dim; r++) {
      var piv = r;
      for (i = r + 1; i < dim; i++) if (Math.abs(aug[i][r]) > Math.abs(aug[piv][r])) piv = i;
      var tmp = aug[r]; aug[r] = aug[piv]; aug[piv] = tmp;
      var div = aug[r][r];
      if (!div) return gaussKernel(radius, bw);
      for (c = r; c <= dim; c++) aug[r][c] /= div;
      for (i = 0; i < dim; i++) {
        if (i === r) continue;
        var f = aug[i][r];
        for (c = r; c <= dim; c++) aug[i][c] -= f * aug[r][c];
      }
    }
    var beta0 = new Array(dim);
    for (r = 0; r < dim; r++) beta0[r] = aug[r][dim];
    var filt = new Array(klen);
    for (k = 0; k < klen; k++) {
      s = 0;
      for (r = 0; r < dim; r++) s += beta0[r] * xtw[r][k];
      filt[k] = s;
    }
    return filt;
  }

  function savgolKernel(window, polyorder) {
    if (window < 3) window = 3;
    if (window % 2 === 0) window += 1;
    if (polyorder < 1) polyorder = 1;
    if (polyorder >= window) polyorder = window - 1;
    var half = (window - 1) / 2;
    return localPolyKernel(half, polyorder, 1e9);
  }

  function smoothSeries(y, model, cfg) {
    var n = y.length;
    if (n < 3) return y.slice();
    var bw = Math.max(Number(cfg.bandwidth) || 3, 0.1);
    var radius = Math.max(1, Math.min(Math.ceil(4 * bw), 80, n - 1));
    var k;
    if (model === "savgol") {
      k = savgolKernel(cfg.window || 11, cfg.polyorder || 3);
    } else if (model === "kernel_poly") {
      k = localPolyKernel(radius, cfg.degree || 2, bw);
    } else if (model === "gaussian") {
      k = gaussKernel(radius, bw);
    } else {
      return y.slice();
    }
    return convSame(y, k);
  }

  function computeSmoothingJs(bars, params) {
    var times = [];
    var price = [];
    var i;
    var lastClose = null;
    for (i = 0; i < (bars || []).length; i++) {
      times.push(bars[i] ? bars[i].timestamp : null);
      if (bars[i] && bars[i].close != null && isFinite(Number(bars[i].close))) {
        lastClose = Number(bars[i].close);
        price.push(lastClose);
      } else {
        price.push(lastClose);
      }
    }
    var n = price.length;
    var firstPx = null;
    for (i = 0; i < n; i++) {
      if (price[i] != null && isFinite(price[i])) { firstPx = price[i]; break; }
    }
    if (firstPx != null) {
      for (i = 0; i < n; i++) {
        if (price[i] == null || !isFinite(price[i])) price[i] = firstPx;
        else firstPx = price[i];
      }
    }
    var empty = { series: { ce1: [], ce2: [], ce3: [], ce4: [] }, times: times, plot: [false, false, false, false] };
    if (n < 3) return empty;
    var cfg = normalizeSmoothingParams(params, pyMeta("smoothing"));
    var data = { price: price };
    var series = {};
    var plot = [];
    for (i = 0; i < 4; i++) {
      var row = cfg.levels[i];
      var key = "ce" + (i + 1);
      var src = data[row.input] || price;
      if (!row.enabled) {
        data[key] = src.slice();
        series[key] = [];
        plot.push(false);
        continue;
      }
      data[key] = smoothSeries(src, row.model, row);
      series[key] = data[key];
      plot.push(true);
    }
    return { series: series, times: times, plot: plot };
  }

  function pyLastUsedMap() {
    var raw = storageGet(LS_PY_DEFAULTS, {});
    return (raw && typeof raw === "object") ? raw : {};
  }

  function savePyLastUsed(id, params) {
    if (!id || !params) return;
    var all = pyLastUsedMap();
    all[id] = cloneJson(params);
    storageSet(LS_PY_DEFAULTS, all);
  }

  function pyLastOrFactory(meta) {
    if (!isSmoothingMeta(meta)) return null;
    var saved = pyLastUsedMap()[meta.id];
    return normalizeSmoothingParams(saved || null, meta);
  }

  function pythonComputeParams(item, meta) {
    if (isSmoothingMeta(meta) || (item.params && item.params.levels)) {
      return normalizeSmoothingParams(item.params, meta);
    }
    return pyParamsDict(meta, item.calcParams);
  }

  function smoothInputOptions(level) {
    var opts = [{ id: "price", label: "Price" }];
    var i;
    for (i = 1; i < level; i++) opts.push({ id: "ce" + i, label: "CE" + i });
    return opts;
  }

  function optionHtml(opts, selected) {
    return opts.map(function (o) {
      var id = o.id || o;
      var label = o.label || o;
      return "<option value=\"" + id + "\"" + (id === selected ? " selected" : "") + ">" + label + "</option>";
    }).join("");
  }

  function syncSmoothParamVisibility(root) {
    if (!root) return;
    root.querySelectorAll(".ce-level").forEach(function (card) {
      var modelEl = card.querySelector(".ce-model");
      var model = modelEl ? modelEl.value : "savgol";
      card.querySelectorAll("[data-for]").forEach(function (row) {
        var keys = (row.getAttribute("data-for") || "").split(",");
        row.style.display = keys.indexOf(model) >= 0 ? "" : "none";
      });
    });
  }

  function fillSmoothingSettings(params, meta) {
    var fields = document.getElementById("ind-settings-fields");
    var colorWrap = document.getElementById("ind-settings-color-wrap");
    var resetBtn = document.getElementById("ind-settings-reset");
    var box = document.getElementById("ind-settings-box");
    var cfg = normalizeSmoothingParams(params, meta);
    if (colorWrap) colorWrap.style.display = "none";
    if (resetBtn) resetBtn.classList.remove("hidden");
    if (box) {
      box.classList.add("chart-modal-wide");
      box.style.maxWidth = "640px";
    }
    if (!fields) return;
    var html = '<div class="ce-levels">';
    cfg.levels.forEach(function (row, i) {
      var lvl = i + 1;
      html += '<div class="ce-level" data-lvl="' + lvl + '">';
      html += '<div class="ce-level-head"><strong>CE' + lvl + '</strong>';
      html += '<label class="toggle-switch"><input type="checkbox" class="ce-enabled"' + (row.enabled ? " checked" : "") + ' /><span class="toggle-slider"></span></label></div>';
      html += '<div class="ce-level-grid">';
      html += '<div class="ind-param-row"><label>Input</label><select class="ce-input">' + optionHtml(smoothInputOptions(lvl), row.input) + "</select></div>";
      html += '<div class="ind-param-row"><label>Engine</label><select class="ce-model">' + optionHtml(SMOOTH_MODELS, row.model) + "</select></div>";
      html += '<div class="ce-span-2 ce-params">';
      html += '<div class="ind-param-row" data-for="savgol"><label>Window</label><input type="number" class="ce-window" min="3" max="501" step="2" value="' + row.window + '" /></div>';
      html += '<div class="ind-param-row" data-for="savgol"><label>Polyorder</label><input type="number" class="ce-polyorder" min="1" max="15" step="1" value="' + row.polyorder + '" /></div>';
      html += '<div class="ind-param-row" data-for="gaussian,kernel_poly"><label>Bandwidth</label><input type="number" class="ce-bandwidth" min="0.1" max="500" step="0.1" value="' + row.bandwidth + '" /></div>';
      html += '<div class="ind-param-row" data-for="kernel_poly"><label>Degree</label><input type="number" class="ce-degree" min="1" max="8" step="1" value="' + row.degree + '" /></div>';
      html += "</div></div>";
      html += '<div class="ce-style-row">';
      html += '<label>Line <input type="color" class="ce-color" value="' + (row.color || "#58a6ff") + '" /></label>';
      html += '<label>Thickness <input type="number" class="ce-thickness" min="1" max="10" step="1" value="' + (row.thickness != null ? row.thickness : 1) + '" style="width:64px" /></label>';
      html += '<label class="ind-param-toggle" style="margin:0"><span>Markers</span>';
      html += '<label class="toggle-switch"><input type="checkbox" class="ce-markers"' + (row.markers ? " checked" : "") + ' /><span class="toggle-slider"></span></label></label>';
      html += '<label>Marker <input type="color" class="ce-marker-color" value="' + (row.marker_color || row.color || "#58a6ff") + '" /></label>';
      html += "</div></div>";
    });
    html += "</div>";
    fields.innerHTML = html;
    fields.querySelectorAll(".ce-model").forEach(function (el) {
      el.addEventListener("change", function () { syncSmoothParamVisibility(fields); });
    });
    syncSmoothParamVisibility(fields);
  }

  function readSmoothingSettings(meta) {
    var fields = document.getElementById("ind-settings-fields");
    var factory = smoothingFactory(meta);
    var levels = [];
    var cards = fields ? fields.querySelectorAll(".ce-level") : [];
    var i;
    for (i = 0; i < 4; i++) {
      var card = cards[i];
      var base = factory.levels[i] || SMOOTH_FALLBACK_FACTORY.levels[i];
      if (!card) { levels.push(Object.assign({}, base)); continue; }
      var num = function (sel, fallback) {
        var el = card.querySelector(sel);
        var n = el ? parseFloat(el.value) : fallback;
        return isFinite(n) ? n : fallback;
      };
      var chk = function (sel) {
        var el = card.querySelector(sel);
        return !!(el && el.checked);
      };
      var val = function (sel, fallback) {
        var el = card.querySelector(sel);
        return el && el.value ? el.value : fallback;
      };
      levels.push({
        enabled: chk(".ce-enabled"),
        input: val(".ce-input", base.input),
        model: val(".ce-model", base.model),
        window: Math.round(num(".ce-window", base.window)),
        polyorder: Math.round(num(".ce-polyorder", base.polyorder)),
        bandwidth: num(".ce-bandwidth", base.bandwidth),
        degree: Math.round(num(".ce-degree", base.degree)),
        color: val(".ce-color", base.color),
        thickness: Math.round(num(".ce-thickness", base.thickness != null ? base.thickness : 1)),
        markers: chk(".ce-markers"),
        marker_color: val(".ce-marker-color", base.marker_color || base.color)
      });
    }
    return normalizeSmoothingParams({ levels: levels }, meta);
  }

  function loadPyCatalog() {
    fetch("/api/custom-indicators").then(function (r) { return r.json(); }).then(function (data) {
      _pyCatalog = (data && data.indicators) || [];
      renderCustomPop();
    }).catch(function () { _pyCatalog = []; });
  }

  function openPyIndSettings(idx) {
    var item = activeIndicators[idx];
    var meta = pyMeta(item && item.id);
    if (!item || !meta) return;
    _settingsKind = "python";
    _settingsPyMeta = meta;
    editingIndIdx = idx;
    pendingIndName = item.id;
    var params = isSmoothingMeta(meta)
      ? normalizeSmoothingParams(item.params, meta)
      : (item.calcParams || pyDefaultParams(meta));
    fillIndSettingsModal(meta.name, params, item.color || firstSmoothColor(item.params) || "#58a6ff", true, meta);
  }

  function openPyIndSettingsAdd(id) {
    var meta = pyMeta(id);
    if (!meta) return;
    if (!isSmoothingMeta(meta)) {
      applyPythonIndicator(id);
      return;
    }
    if (!chart) {
      if (chartMessage) {
        chartMessage.textContent = "Load a chart first, then add the indicator.";
        chartMessage.style.display = "flex";
      }
      return;
    }
    _settingsKind = "python";
    _settingsPyMeta = meta;
    editingIndIdx = null;
    pendingIndName = id;
    fillIndSettingsModal(meta.name, pyLastOrFactory(meta), firstSmoothColor(pyLastOrFactory(meta)), false, meta);
  }

  function pyLineIndName(item) {
    return "PY_" + String(item.id || "x") + "_" + String(item.uid || "0");
  }

  function applyPythonLines(item, data, meta) {
    if (!chart || !item) return;
    removePythonOverlays(item);
    if (item.indName) {
      try { chart.removeIndicator("candle_pane", item.indName); } catch (_) {}
      item.indName = null;
      item._lineOnChart = false;
    }
    if (item.visible === false) return;
    var params = normalizeSmoothingParams(item.params, meta);
    var times = data.times || [];
    var series = data.series || {};
    var plot = data.plot || [];
    var n = times.length;
    if (n < 2) return;
    var lines = [];
    var lvl, key, vals, v0, v1, i;
    for (lvl = 1; lvl <= 4; lvl++) {
      if (!plot[lvl - 1]) continue;
      key = "ce" + lvl;
      vals = series[key] || [];
      lines.push({
        color: (params.levels[lvl - 1] && params.levels[lvl - 1].color) || "#58a6ff",
        thickness: (params.levels[lvl - 1] && params.levels[lvl - 1].thickness) || 1,
        markerColor: (params.levels[lvl - 1] && (params.levels[lvl - 1].marker_color || params.levels[lvl - 1].color)) || "#58a6ff",
        markers: !!(params.levels[lvl - 1] && params.levels[lvl - 1].markers),
        values: vals
      });
    }
    item.pySeries = lines;
    item.color = firstSmoothColor(params);
    if (!lines.length) return;
    v0 = null;
    v1 = null;
    vals = lines[0].values || [];
    for (i = 0; i < vals.length; i++) {
      if (v0 == null && vals[i] != null && isFinite(vals[i])) v0 = vals[i];
    }
    for (i = vals.length - 1; i >= 0; i--) {
      if (vals[i] != null && isFinite(vals[i])) { v1 = vals[i]; break; }
    }
    if (v0 == null) v0 = 0;
    if (v1 == null) v1 = v0;
    var spec = {
      name: "pySmooth",
      groupId: pyGroupId(item),
      lock: true,
      points: [
        { timestamp: times[0], value: v0 },
        { timestamp: times[n - 1], value: v1 }
      ],
      extendData: { n: n, times: times, lines: lines }
    };
    var id = null;
    try { id = chart.createOverlay(spec, "candle_pane"); } catch (_) {}
    item.pyOverlayIds = id ? [id] : [];
  }

  function pyGroupId(item) {
    return "pyind-" + (item.id || "x") + "-" + (item.uid || "0");
  }

  function removePythonOverlays(item) {
    if (!chart || !item) return;
    try { chart.removeOverlay({ groupId: pyGroupId(item) }); } catch (_) {}
    (item.pyOverlayIds || []).forEach(function (id) {
      try { chart.removeOverlay({ id: id }); } catch (_) {}
    });
    item.pyOverlayIds = [];
  }

  function zoneOverlayData(z) {
    if (z.type === "bos") {
      return {
        style: "bos",
        label: "BOS",
        fill: "rgba(139,148,158,0.08)",
        border: "#8b949e",
        live: false
      };
    }
    if (z.type === "supply") {
      return {
        style: "zone",
        label: "SUPPLY",
        fill: "rgba(128,132,138,0.38)",
        border: "rgba(168,172,178,0.95)",
        live: !z.broken
      };
    }
    return {
      style: "zone",
      label: "DEMAND",
      fill: "rgba(20,196,184,0.26)",
      border: "#2dd4bf",
      live: !z.broken
    };
  }

  function drawPythonZones(item, zones) {
    if (!chart || !item) return;
    removePythonOverlays(item);
    if (item.visible === false) return;
    var ids = [];
    (zones || []).forEach(function (z) {
      var top = Number(z.top);
      var bottom = Number(z.bottom);
      var poi = Number(z.poi);
      var t0 = Number(z.start_time);
      var t1 = Number(z.end_time);
      if (!isFinite(top) || !isFinite(bottom) || !isFinite(t0) || !isFinite(t1)) return;
      var ext = zoneOverlayData(z);
      var points;
      var list = chartDataList();
      var i0 = timestampIndex(t0, list);
      var i1 = timestampIndex(t1, list);
      if (z.type === "bos") {
        var p = isFinite(poi) ? poi : (top + bottom) / 2;
        points = [
          { timestamp: t0, value: p, dataIndex: i0 >= 0 ? i0 : undefined },
          { timestamp: t1, value: p, dataIndex: i1 >= 0 ? i1 : undefined }
        ];
      } else {
        points = [
          { timestamp: t0, value: top, dataIndex: i0 >= 0 ? i0 : undefined },
          { timestamp: t1, value: bottom, dataIndex: i1 >= 0 ? i1 : undefined }
        ];
      }
      var spec = {
        name: "pyZone",
        groupId: pyGroupId(item),
        lock: true,
        points: points,
        extendData: ext,
        styles: {
          text: {
            backgroundColor: "rgba(0,0,0,0)",
            borderColor: "rgba(0,0,0,0)",
            borderSize: 0,
            paddingLeft: 0,
            paddingRight: 0,
            paddingTop: 0,
            paddingBottom: 0
          }
        }
      };
      var id = null;
      try { id = chart.createOverlay(spec, "candle_pane"); } catch (_) {}
      if (id) ids.push(id);
    });
    item.pyOverlayIds = ids;
  }

  function hasPythonIndicators() {
    return activeIndicators.some(function (item) {
      return item && item.kind === "python" && item.visible !== false;
    });
  }

  function slotVisibleRawBars(s) {
    if (!s) return [];
    var bars = s.rawBars || [];
    var r = s.replay;
    if (r && !r.picking && r.active && r.index >= 0) {
      var n = Math.min(r.index + 1, bars.length);
      return bars.slice(0, Math.max(0, n));
    }
    return bars;
  }

  function pythonCoverageStaleSlot(idx) {
    var s = chartSlots[idx];
    if (!s || !s.activeIndicators) return false;
    var hasPy = s.activeIndicators.some(function (item) {
      return item && item.kind === "python" && item.visible !== false;
    });
    if (!hasPy) return false;
    var bars = slotVisibleRawBars(s);
    if (!bars.length) return false;
    if (!s.pyCoveredN) return true;
    if (bars[0].timestamp !== s.pyCoveredFirst) return true;
    if (bars.length > s.pyCoveredN) return true;
    return false;
  }

  function pythonCoverageStale() {
    return pythonCoverageStaleSlot(_curSlot);
  }

  function markPythonCoverage() {
    var bars = visibleRawBars();
    _pyCoveredN = bars.length;
    _pyCoveredFirst = bars.length ? bars[0].timestamp : null;
  }

  function refreshPythonIndicator(item) {
    if (!item || item.kind !== "python") return;
    var meta = pyMeta(item.id) || { id: item.id, params: [] };
    var lines = isSmoothingMeta(meta) || (item.params && item.params.levels);
    var slotIdx = _curSlot;
    if (!chart || !visibleRawBars().length) {
      removePythonOverlays(item);
      return;
    }
    if (item.visible === false) {
      removePythonOverlays(item);
      if (item.indName) {
        try { chart.removeIndicator("candle_pane", item.indName); } catch (_) {}
      }
      return;
    }
    if (lines) {
      var local = computeSmoothingJs(displaySeries(visibleRawBars()), pythonComputeParams(item, meta));
      applyPythonLines(item, local, meta);
      updateChartLegendValues();
      return;
    }
    item._pyGen = (item._pyGen || 0) + 1;
    var gen = item._pyGen;
    if (item._pyAbort) {
      try { item._pyAbort.abort(); } catch (_) {}
    }
    item._pyAbort = typeof AbortController !== "undefined" ? new AbortController() : null;
    var slim = displaySeries(visibleRawBars()).map(function (b) {
      return { timestamp: b.timestamp, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume };
    });
    fetch("/api/custom-indicators/compute", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: item.id,
        params: pythonComputeParams(item, meta),
        candles: slim
      }),
      signal: item._pyAbort ? item._pyAbort.signal : undefined
    }).then(function (r) { return r.json(); }).then(function (data) {
      if (gen !== item._pyGen) return;
      if (!data || !data.success) return;
      withSlot(slotIdx, function () {
        if (!chart) return;
        item.pyStats = data.stats || {};
        drawPythonZones(item, data.zones || []);
        if (slotIdx === activeSlot) updateChartLegendValues();
      });
    }).catch(function () {});
  }

  function schedulePyRefresh(immediate) {
    clearTimeout(_pyRefreshTimer);
    var run = function () {
      for (var i = 0; i < splitCount; i++) {
        var s = chartSlots[i];
        if (!s || !s.chart) continue;
        var hasPy = s.activeIndicators.some(function (x) { return x && x.kind === "python"; });
        if (!hasPy) continue;
        _useSlot(i);
        markPythonCoverage();
        activeIndicators.forEach(function (item) {
          if (item.kind === "python") refreshPythonIndicator(item);
        });
      }
      _useSlot(activeSlot >= splitCount ? 0 : activeSlot);
    };
    if (immediate || pythonCoverageStale()) {
      run();
      return;
    }
    var hasSmooth = activeIndicators.some(function (item) {
      return item.kind === "python" && (item.id === "smoothing" || (item.params && item.params.levels));
    });
    _pyRefreshTimer = setTimeout(run, replayFrozen() ? (hasSmooth ? 280 : 70) : (hasSmooth ? 1500 : 180));
  }

  function resyncIndicatorsAfterReplay() {
    if (!chart) return;
    activeIndicators.forEach(function (item) {
      if (!item || item.visible === false) return;
      if (item.kind === "python") {
        refreshPythonIndicator(item);
        return;
      }
      var name = item.indName || item.name;
      if (!name) return;
      try {
        var spec = { name: name, visible: true };
        if (item.kind === "builtin") {
          spec.shortName = formatIndLabel(item);
          spec.calcParams = item.name === "VOL" ? [] : (item.calcParams || []).slice();
        }
        chart.overrideIndicator(spec, item.overlay ? "candle_pane" : item.paneId);
      } catch (_) {}
    });
    setTimeout(updateChartLegendValues, 80);
  }

  function applyPythonIndicator(id, skipPersist, preset) {
    preset = preset || {};
    var meta = pyMeta(id) || { id: id, name: id, overlay: true, params: [] };
    if (!chart) {
      if (chartMessage) {
        chartMessage.textContent = "Load a chart first, then add the indicator.";
        chartMessage.style.display = "flex";
      }
      return;
    }
    var smParams = null;
    if (isSmoothingMeta(meta)) {
      if (preset.params) smParams = normalizeSmoothingParams(preset.params, meta);
      else if (preset.uid) smParams = smoothingFactory(meta);
      else smParams = pyLastOrFactory(meta);
    }
    var item = {
      kind: "python",
      id: id,
      uid: preset.uid || newIndUid(),
      name: preset.name || meta.name || id,
      calcParams: (preset.calcParams && preset.calcParams.length) ? preset.calcParams.slice() : pyDefaultParams(meta),
      params: smParams || preset.params,
      overlay: true,
      color: isSmoothingMeta(meta)
        ? (preset.color || firstSmoothColor(smParams))
        : (preset.color || "#f85149"),
      visible: preset.visible !== false,
      pyOverlayIds: []
    };
    if (isSmoothingMeta(meta)) {
      item.overlay = true;
      item.paneId = "candle_pane";
    }
    activeIndicators.push(item);
    refreshPythonIndicator(item);
    if (!skipPersist) persistIndicators();
    renderCustomPop();
    renderIndicatorPop();
  }

  function setActiveDraw(name) {
    activeDraw = name;
    document.querySelectorAll("#chart-draw-tools .chart-tool-btn").forEach(function (b) {
      b.classList.toggle("active", b.dataset.tool === name);
    });
  }

  function startDrawing(name) {
    focusActiveSlot();
    if (name === "cursor") {
      clearPendingDraw();
      setActiveDraw("cursor");
      return;
    }
    if (!chart) {
      chartMessage.textContent = "Load a chart first, then draw.";
      chartMessage.style.display = "flex";
      return;
    }
    clearPendingDraw();
    setActiveDraw(name);
    var spec = Object.assign({ name: name }, overlayHooks());
    if (name === "tvText") spec.extendData = { text: "Text", color: overlayContrastText() };
    if (name === "tvRect") spec.extendData = { color: "#58a6ff", text: "" };
    var id = chart.createOverlay(spec, "candle_pane");
    if (id) {
      overlayIds.push(id);
      _pendingDrawId = id;
      _pendingDrawSlot = activeSlot;
      if (chartSlots[activeSlot]) chartSlots[activeSlot].overlayIds = overlayIds;
    } else {
      setActiveDraw("cursor");
    }
  }

  function applyDrawRailExpanded(on) {
    var rail = document.getElementById("chart-draw-rail");
    var tog = document.getElementById("btn-draw-rail-toggle");
    if (rail) rail.classList.toggle("expanded", !!on);
    if (tog) {
      tog.setAttribute("aria-expanded", on ? "true" : "false");
      bindDrawToolTip(tog, on ? "Hide drawing names" : "Show drawing names");
    }
  }

  function setMagnetOn(on) {
    magnetOn = !!on;
    var mag = document.querySelector('#chart-draw-tools .chart-tool-btn[data-tool="magnet"]');
    if (mag) mag.classList.toggle("active", magnetOn);
  }

  function bindDrawRailTips() {
    var rail = document.getElementById("chart-draw-rail");
    if (!rail || rail._drawTipsBound) return;
    rail._drawTipsBound = true;
    rail.addEventListener("pointerover", function (e) {
      var btn = e.target.closest(".chart-tool-btn, .chart-draw-toggle");
      if (!btn || !rail.contains(btn)) return;
      showDrawTip(btn);
    });
    rail.addEventListener("pointerout", function (e) {
      var btn = e.target.closest(".chart-tool-btn, .chart-draw-toggle");
      if (!btn) return;
      var next = e.relatedTarget;
      if (next && btn.contains(next)) return;
      hideDrawTip();
    });
    rail.addEventListener("pointerdown", hideDrawTip);
    rail.addEventListener("scroll", hideDrawTip, { passive: true });
  }

  function renderDrawTools() {
    var host = document.getElementById("chart-draw-tools");
    if (!host) return;
    var supported = {};
    try {
      (klinecharts.getSupportedOverlays() || []).forEach(function (n) { supported[n] = true; });
    } catch (_) {}
    host.innerHTML = "";
    DRAW_TOOLS.forEach(function (t) {
      if (t.name !== "cursor" && !CUSTOM_OVERLAYS[t.name] && Object.keys(supported).length && !supported[t.name]) return;
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "chart-tool-btn" + (t.name === "cursor" ? " active" : "");
      btn.dataset.tool = t.name;
      btn.innerHTML = drawToolIcon(t.name) + '<span class="chart-draw-label"></span>';
      btn.querySelector(".chart-draw-label").textContent = t.label;
      bindDrawToolTip(btn, t.label, t.shortcut);
      btn.addEventListener("click", function () { startDrawing(t.name); });
      host.appendChild(btn);
    });
    var mag = document.createElement("button");
    mag.type = "button";
    mag.dataset.tool = "magnet";
    mag.className = "chart-tool-btn" + (magnetOn ? " active" : "");
    mag.innerHTML = drawToolIcon("magnet") + '<span class="chart-draw-label">Magnet</span>';
    bindDrawToolTip(mag, "Magnet", MAGNET_SHORTCUT);
    mag.addEventListener("click", function () { setMagnetOn(!magnetOn); });
    host.appendChild(mag);
    bindDrawRailTips();
  }

  function escHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c];
    });
  }

  function formatLegendNum(v) {
    if (v == null || v === "" || !isFinite(Number(v))) return "n/a";
    v = Number(v);
    var a = Math.abs(v);
    if (a >= 1000) return v.toLocaleString(undefined, { maximumFractionDigits: 2 });
    if (a >= 1) return v.toFixed(2);
    if (a >= 0.01) return v.toFixed(4);
    return v.toFixed(6);
  }

  function legendPaneId(item) {
    return item.overlay ? "candle_pane" : item.paneId;
  }

  function legendIndName(item) {
    return item.indName || item.name;
  }

  function legendValuesFor(item, dataIndex) {
    if (!item) return [];
    if (item.kind === "python") {
      if (item.pySeries && item.pySeries.length) {
        var sidx = dataIndex;
        var slen = (item.pySeries[0].values || []).length;
        if (!slen) return [];
        if (sidx == null || sidx < 0 || sidx >= slen) sidx = slen - 1;
        return item.pySeries.map(function (line, i) {
          return { title: "CE" + (i + 1), value: line.values[sidx], color: line.color };
        }).filter(function (v) { return v.value != null && isFinite(Number(v.value)); });
      }
      var st = item.pyStats || {};
      return [
        { title: "S", value: st.supply },
        { title: "D", value: st.demand },
        { title: "BOS", value: st.bos }
      ];
    }
    if (!chart) return [];
    var inst = null;
    try { inst = chart.getIndicatorByPaneId(legendPaneId(item), legendIndName(item)); } catch (_) {}
    if (!inst) return [];
    var result = inst.result || [];
    if (!result.length) return [];
    var idx = dataIndex;
    if (idx == null || idx < 0 || idx >= result.length) idx = result.length - 1;
    var row = result[idx];
    if (row == null) return [];
    var figures = inst.figures || [];
    var out = [];
    if (figures.length) {
      figures.forEach(function (f) {
        var val = (typeof row === "object") ? row[f.key] : row;
        if (val == null || val === "" || !isFinite(Number(val))) return;
        out.push({ title: String(f.title || f.key || "").replace(/:\s*$/, ""), value: val });
      });
      return out;
    }
    if (typeof row === "object") {
      Object.keys(row).forEach(function (k) {
        if (row[k] == null || typeof row[k] === "object") return;
        out.push({ title: k, value: row[k] });
      });
    } else {
      out.push({ title: "", value: row });
    }
    return out;
  }

  function setIndicatorVisible(item, visible) {
    if (!item) return;
    item.visible = !!visible;
    if (!chart) return;
    if (item.kind === "python") {
      if (item.visible) refreshPythonIndicator(item);
      else {
        removePythonOverlays(item);
        if (item.indName) {
          try { chart.removeIndicator("candle_pane", item.indName); } catch (_) {}
        }
      }
      return;
    }
    try {
      chart.overrideIndicator({
        name: legendIndName(item),
        visible: item.visible
      }, legendPaneId(item));
    } catch (_) {}
  }

  function legendIco(kind) {
    if (kind === "eye") return '<svg viewBox="0 0 24 24"><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg>';
    if (kind === "eye-off") return '<svg viewBox="0 0 24 24"><path d="M3 3l18 18"/><path d="M10.6 10.6A3 3 0 0 0 12 15a3 3 0 0 0 2.4-4.4"/><path d="M6.7 6.7C4.2 8.3 2.5 11 2 12c.8 1.6 4.2 7 10 7 1.8 0 3.4-.5 4.8-1.3"/><path d="M17.3 17.3C19.8 15.7 21.5 13 22 12c-.8-1.6-4.2-7-10-7-1.1 0-2.2.2-3.2.6"/></svg>';
    if (kind === "gear") return '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a7.7 7.7 0 0 0 .1-2 7.7 7.7 0 0 0-.1-2l2-1.5-2-3.5-2.4 1a7.4 7.4 0 0 0-1.7-1L13 2h-2l-.4 2.5a7.4 7.4 0 0 0-1.7 1L6.5 4.5l-2 3.5 2 1.5a7.7 7.7 0 0 0-.1 2 7.7 7.7 0 0 0 .1 2l-2 1.5 2 3.5 2.4-1a7.4 7.4 0 0 0 1.7 1L11 22h2l.4-2.5a7.4 7.4 0 0 0 1.7-1l2.4 1 2-3.5-2-1.5Z"/></svg>';
    return '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>';
  }

  function renderChartLegend() {
    var el = activeLegendEl();
    if (!el) return;
    if (!activeIndicators.length || !chart) {
      el.className = "chart-ind-legend hidden";
      el.innerHTML = "";
      return;
    }
    var collapsed = !_legendExpanded;
    var n = activeIndicators.length;
    var html = '<div class="chart-ind-legend-head">' +
      '<button type="button" class="chart-ind-legend-toggle" title="' + (collapsed ? "Expand indicators" : "Collapse indicators") + '">' +
      (collapsed ? "▾" : "▴") + "</button>" +
      (collapsed
        ? '<span class="chart-ind-legend-count">' + n + "</span>"
        : '<span class="chart-ind-legend-title">Indicators</span>') +
      "</div>";
    html += '<div class="chart-ind-legend-body">';
    activeIndicators.forEach(function (item, i) {
      var hidden = item.visible === false;
      html += '<div class="chart-ind-legend-row' + (hidden ? " is-hidden" : "") + '" data-idx="' + i + '">' +
        '<span class="chart-ind-dot" style="background:' + escHtml(item.color || "#8b949e") + '"></span>' +
        '<span class="chart-ind-name">' + escHtml(formatIndLabel(item)) + "</span>" +
        '<span class="chart-ind-vals" data-vals="' + i + '"></span>' +
        '<span class="chart-ind-actions">' +
        '<button type="button" class="chart-ind-ico" data-vis="' + i + '" title="' + (hidden ? "Show" : "Hide") + '">' +
        (hidden ? legendIco("eye-off") : legendIco("eye")) + "</button>" +
        '<button type="button" class="chart-ind-ico" data-edit="' + i + '" title="Settings">' + legendIco("gear") + "</button>" +
        '<button type="button" class="chart-ind-ico" data-rm="' + i + '" title="Remove">' + legendIco("x") + "</button>" +
        "</span></div>";
    });
    html += "</div>";
    el.className = "chart-ind-legend" + (collapsed ? " collapsed" : "");
    el.innerHTML = html;
    var head = el.querySelector(".chart-ind-legend-head");
    if (head) {
      head.addEventListener("click", function (e) {
        e.stopPropagation();
        _legendExpanded = !_legendExpanded;
        storageSet(LS_LEGEND, _legendExpanded);
        renderChartLegend();
      });
    }
    el.querySelectorAll("[data-vis]").forEach(function (b) {
      b.addEventListener("click", function (e) {
        e.stopPropagation();
        var idx = parseInt(b.dataset.vis, 10);
        var item = activeIndicators[idx];
        if (!item) return;
        setIndicatorVisible(item, item.visible === false);
        persistIndicators();
        renderChartLegend();
      });
    });
    el.querySelectorAll("[data-edit]").forEach(function (b) {
      b.addEventListener("click", function (e) {
        e.stopPropagation();
        var idx = parseInt(b.dataset.edit, 10);
        var item = activeIndicators[idx];
        if (item && item.kind === "custom") openCustomModal(item.id);
        else openIndSettings(idx);
      });
    });
    el.querySelectorAll("[data-rm]").forEach(function (b) {
      b.addEventListener("click", function (e) {
        e.stopPropagation();
        removeActive(parseInt(b.dataset.rm, 10));
      });
    });
    updateChartLegendValues();
  }

  function updateChartLegendValues() {
    var el = activeLegendEl();
    if (!el || el.classList.contains("hidden") || el.classList.contains("collapsed")) return;
    activeIndicators.forEach(function (item, i) {
      var host = el.querySelector('[data-vals="' + i + '"]');
      if (!host) return;
      var vals = legendValuesFor(item, _legendIndex);
      if (!vals.length) { host.innerHTML = ""; return; }
      var many = vals.length > 1;
      host.innerHTML = vals.map(function (v) {
        var color = v.color || item.color || "#8b949e";
        var label = many && v.title ? '<span>' + escHtml(v.title) + "</span> " : "";
        return '<span class="chart-ind-val" style="color:' + escHtml(color) + '">' + label + "<b>" + escHtml(formatLegendNum(v.value)) + "</b></span>";
      }).join("");
    });
  }

  function indDisplayName(name) {
    return IND_LABELS[name] || name;
  }

  function catalogIndicators() {
    var out = [];
    Object.keys(OVERLAY_INDS).forEach(function (n) {
      out.push({ name: n, group: "Overlay", label: indDisplayName(n) });
    });
    PANE_INDS.forEach(function (n) {
      out.push({ name: n, group: "Separate pane", label: indDisplayName(n) });
    });
    return out;
  }

  function visibleCatalogIndicators() {
    var q = String(_indSearch || "").trim().toLowerCase();
    return catalogIndicators().filter(function (item) {
      if (!q) return true;
      return item.name.toLowerCase().indexOf(q) >= 0 ||
        item.label.toLowerCase().indexOf(q) >= 0 ||
        item.group.toLowerCase().indexOf(q) >= 0;
    });
  }

  var IND_STAR_SVG = '<svg class="ind-star" viewBox="0 0 18 18" aria-hidden="true"><path d="M9 2.2l1.96 3.97 4.38.64-3.17 3.09.75 4.36L9 12.2l-3.92 2.06.75-4.36L2.66 6.81l4.38-.64z"/></svg>';

  function loadIndFavorites() {
    var list = storageGet(LS_FAV, []);
    return Array.isArray(list) ? list.filter(function (x) { return x && x.kind && x.id; }) : [];
  }
  function saveIndFavorites(list) { storageSet(LS_FAV, list); }
  function isIndFav(kind, id) {
    var kid = String(id || "");
    return loadIndFavorites().some(function (f) { return f.kind === kind && String(f.id) === kid; });
  }
  function toggleIndFav(kind, id) {
    var kid = String(id || "");
    var list = loadIndFavorites();
    var i = list.findIndex(function (f) { return f.kind === kind && String(f.id) === kid; });
    if (i >= 0) list.splice(i, 1);
    else list.push({ kind: kind, id: kid });
    saveIndFavorites(list);
  }
  function removeIndFav(kind, id) {
    var kid = String(id || "");
    saveIndFavorites(loadIndFavorites().filter(function (f) {
      return !(f.kind === kind && String(f.id) === kid);
    }));
  }

  function closeIndPicker() {
    var modal = document.getElementById("ind-picker-modal");
    if (modal) modal.classList.add("hidden");
  }
  function isIndPickerOpen() {
    var modal = document.getElementById("ind-picker-modal");
    return !!(modal && !modal.classList.contains("hidden"));
  }

  function favStarBtn(kind, id) {
    var on = isIndFav(kind, id);
    return '<button type="button" class="ind-fav-btn' + (on ? " on" : "") +
      '" data-fav-kind="' + escHtml(kind) + '" data-fav-id="' + escHtml(id) +
      '" title="' + (on ? "Remove from favorites" : "Add to favorites") +
      '" aria-label="' + (on ? "Unfavorite" : "Favorite") + '">' + IND_STAR_SVG + "</button>";
  }

  function pickerPickables(pop) {
    return pop.querySelectorAll("[data-pick]");
  }

  function activatePickerItem(el) {
    if (!el) return;
    focusActiveSlot();
    var kind = el.getAttribute("data-pick");
    if (kind === "builtin") promptAddIndicator(el.dataset.add);
    else if (kind === "python") openPyIndSettingsAdd(el.dataset.py);
    else if (kind === "custom") applyCustomToChart(el.dataset.capply);
  }

  function bindIndicatorPop(pop) {
    var search = document.getElementById("ind-search");
    if (search) {
      search.addEventListener("click", function (e) { e.stopPropagation(); });
      search.addEventListener("input", function () {
        _indSearch = search.value;
        _indFocusIdx = 0;
        renderIndicatorPop(true);
      });
      search.addEventListener("keydown", function (e) {
        var items = pickerPickables(pop);
        if (e.key === "ArrowDown") {
          e.preventDefault();
          if (!items.length) return;
          _indFocusIdx = Math.min(items.length - 1, (_indFocusIdx < 0 ? 0 : _indFocusIdx + 1));
          highlightIndList(pop);
        } else if (e.key === "ArrowUp") {
          e.preventDefault();
          if (!items.length) return;
          _indFocusIdx = Math.max(0, (_indFocusIdx < 0 ? 0 : _indFocusIdx - 1));
          highlightIndList(pop);
        } else if (e.key === "Enter") {
          e.preventDefault();
          activatePickerItem(items[_indFocusIdx] || items[0]);
        } else if (e.key === "Escape") {
          e.preventDefault();
          _indSearch = "";
          _indFocusIdx = -1;
          closeIndPicker();
        }
      });
    }
    pop.querySelectorAll("[data-ind-tab]").forEach(function (b) {
      b.addEventListener("click", function (e) {
        e.stopPropagation();
        _indTab = b.getAttribute("data-ind-tab") || "technicals";
        _indFocusIdx = -1;
        renderIndicatorPop(true);
      });
    });
    var closeBtn = pop.querySelector("#ind-picker-close");
    if (closeBtn) closeBtn.addEventListener("click", function (e) {
      e.stopPropagation();
      closeIndPicker();
    });
    pop.querySelectorAll("[data-fav-kind]").forEach(function (b) {
      b.addEventListener("click", function (e) {
        e.stopPropagation();
        e.preventDefault();
        toggleIndFav(b.getAttribute("data-fav-kind"), b.getAttribute("data-fav-id"));
        renderIndicatorPop(true);
      });
    });
    pop.querySelectorAll("[data-pick]").forEach(function (b) {
      b.addEventListener("mouseenter", function () {
        var items = pickerPickables(pop);
        _indFocusIdx = Array.prototype.indexOf.call(items, b);
        highlightIndList(pop);
      });
      b.addEventListener("click", function (e) {
        e.stopPropagation();
        activatePickerItem(b);
      });
    });
    pop.querySelectorAll("[data-edit]").forEach(function (b) {
      b.addEventListener("click", function (e) {
        e.stopPropagation();
        focusActiveSlot();
        var idx = parseInt(b.dataset.edit, 10);
        var item = activeIndicators[idx];
        if (item && item.kind === "custom") openCustomModal(item.id);
        else openIndSettings(idx);
      });
    });
    pop.querySelectorAll("[data-rm]").forEach(function (b) {
      b.addEventListener("click", function (e) {
        e.stopPropagation();
        focusActiveSlot();
        removeActive(parseInt(b.dataset.rm, 10));
      });
    });
    highlightIndList(pop);
  }

  function highlightIndList(pop) {
    var items = pickerPickables(pop);
    items.forEach(function (el, i) {
      var row = el.closest(".ind-picker-row") || el;
      row.classList.toggle("hl", i === _indFocusIdx);
      el.classList.toggle("hl", i === _indFocusIdx);
    });
    if (_indFocusIdx >= 0 && items[_indFocusIdx]) {
      var row = items[_indFocusIdx].closest(".ind-picker-row") || items[_indFocusIdx];
      row.scrollIntoView({ block: "nearest" });
    }
  }

  function indPickerNavBtn(id, label, icon) {
    var on = _indTab === id ? " on" : "";
    return '<button type="button" class="ind-picker-nav-btn' + on + '" data-ind-tab="' + id + '">' +
      icon + "<span>" + label + "</span></button>";
  }

  function onChartSectionHtml() {
    var html = '<div class="ind-picker-onchart">';
    html += '<div class="chart-pop-title">On this chart</div>';
    if (!activeIndicators.length) {
      html += '<div class="chart-pop-row"><span class="settings-broker-desc">None added yet</span></div>';
    } else {
      activeIndicators.forEach(function (item, i) {
        html += "<div class=\"chart-pop-row\"><span>" + formatIndLabel(item) +
          "</span><span class=\"chart-pop-row-actions\">" +
          "<button type=\"button\" class=\"btn-secondary\" data-edit=\"" + i + "\">Settings</button>" +
          "<button type=\"button\" class=\"btn-secondary\" data-rm=\"" + i + "\">Remove</button></span></div>";
      });
    }
    html += "</div>";
    return html;
  }

  function technicalsListHtml() {
    var visible = visibleCatalogIndicators();
    var html = '<div class="ind-picker-cols"><span></span><span>Name</span><span>Type</span></div>';
    html += '<div class="ind-picker-body">';
    if (!visible.length) {
      html += '<div class="ind-pop-empty">No indicators match “' + escHtml(_indSearch) + '”</div>';
    } else {
      var lastGroup = "";
      visible.forEach(function (item) {
        if (item.group !== lastGroup) {
          lastGroup = item.group;
          html += "<div class=\"chart-pop-title\">" + item.group + "</div>";
        }
        html += '<div class="ind-picker-row">' + favStarBtn("builtin", item.name) +
          '<button type="button" class="ind-list-item" data-pick="builtin" data-add="' + escHtml(item.name) + '">' +
          '<span class="ind-list-name">' + escHtml(item.label) + "</span></button>" +
          '<span class="ind-list-code">' + escHtml(item.name) + "</span></div>";
      });
    }
    html += "</div>";
    return html;
  }

  function favoritesListHtml() {
    var q = String(_indSearch || "").trim().toLowerCase();
    var rows = [];
    loadIndFavorites().forEach(function (fav) {
      var item = resolveFavItem(fav);
      if (!item) return;
      if (q && item.label.toLowerCase().indexOf(q) < 0 && String(item.code).toLowerCase().indexOf(q) < 0) return;
      rows.push(item);
    });
    var html = '<div class="ind-picker-cols"><span></span><span>Name</span><span>Type</span></div>';
    html += '<div class="ind-picker-body">';
    if (!rows.length) {
      html += q
        ? '<div class="ind-pop-empty">No favorites match “' + escHtml(_indSearch) + '”</div>'
        : '<div class="ind-pop-empty">No favorites yet. Star an indicator in Technicals or Custom Indicators to save it here.</div>';
    } else {
      rows.forEach(function (item) {
        var pick = item.kind === "builtin"
          ? 'data-pick="builtin" data-add="' + escHtml(item.id) + '"'
          : (item.kind === "python"
            ? 'data-pick="python" data-py="' + escHtml(item.id) + '"'
            : 'data-pick="custom" data-capply="' + escHtml(item.id) + '"');
        html += '<div class="ind-picker-row">' + favStarBtn(item.kind, item.id) +
          '<button type="button" class="ind-list-item" ' + pick + '>' +
          '<span class="ind-list-name">' + escHtml(item.label) + "</span></button>" +
          '<span class="ind-list-code">' + escHtml(item.code) + "</span></div>";
      });
    }
    html += "</div>";
    return html;
  }

  function resolveFavItem(fav) {
    if (!fav || !fav.kind || !fav.id) return null;
    if (fav.kind === "builtin") {
      if (!OVERLAY_INDS[fav.id] && PANE_INDS.indexOf(fav.id) < 0) return null;
      return {
        kind: "builtin",
        id: fav.id,
        label: indDisplayName(fav.id),
        code: fav.id
      };
    }
    if (fav.kind === "python") {
      var meta = pyMeta(fav.id);
      if (!meta) return null;
      return { kind: "python", id: meta.id, label: meta.name, code: meta.id };
    }
    if (fav.kind === "custom") {
      var def = loadCustomDefs().filter(function (d) { return d.id === fav.id; })[0];
      if (!def) return null;
      return { kind: "custom", id: def.id, label: def.name, code: "Formula" };
    }
    return null;
  }

  function renderIndicatorPop(keepSearchFocus) {
    var pop = document.getElementById("ind-pop");
    if (!pop) return;
    var navFav = '<svg viewBox="0 0 16 16" fill="none"><path d="M8 2.2l1.6 3.24 3.58.52-2.59 2.52.61 3.56L8 10.36 4.8 12.04l.61-3.56L2.82 5.96l3.58-.52z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>';
    var navCustom = '<svg viewBox="0 0 16 16" fill="none"><path d="M4 3.2h8v9.6H4z" stroke="currentColor" stroke-width="1.3"/><path d="M6 6.2h4M6 8.4h4M6 10.6h2.4" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>';
    var navTech = '<svg viewBox="0 0 16 16" fill="none"><path d="M2.4 11.2l3.2-3.4 2.4 2.2 5.6-6" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round"/><path d="M2.4 13.2h11.2" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>';
    var html = '<div class="ind-picker-head"><h3 id="ind-picker-title">Indicators</h3>' +
      '<button type="button" class="chart-modal-close" id="ind-picker-close" title="Close">&times;</button></div>';
    html += '<div class="ind-picker-search"><div class="ind-picker-search-box">' +
      '<svg viewBox="0 0 16 16" fill="none"><circle cx="7" cy="7" r="4.2" stroke="currentColor" stroke-width="1.4"/><path d="M10.4 10.4L13.2 13.2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>' +
      '<input type="text" id="ind-search" placeholder="Search" autocomplete="off" spellcheck="false" /></div></div>';
    html += '<div class="ind-picker-main"><nav class="ind-picker-nav">';
    html += '<div class="ind-picker-nav-label">Personal</div>';
    html += indPickerNavBtn("favorites", "Favorites", navFav);
    html += indPickerNavBtn("custom", "Custom Indicators", navCustom);
    html += '<div class="ind-picker-nav-label">Built-in</div>';
    html += indPickerNavBtn("technicals", "Technicals", navTech);
    html += '</nav><div class="ind-picker-content">';
    if (_indTab === "favorites") html += favoritesListHtml();
    else if (_indTab === "custom") html += '<div id="ind-custom-section" class="ind-custom-section">' + customSectionHtml() + "</div>";
    else html += technicalsListHtml();
    html += onChartSectionHtml();
    html += "</div></div>";
    pop.innerHTML = html;
    var search = document.getElementById("ind-search");
    if (search) {
      search.value = _indSearch;
      if (keepSearchFocus) {
        search.focus();
        var len = search.value.length;
        try { search.setSelectionRange(len, len); } catch (_) {}
      }
    }
    bindCustomSection(pop.querySelector("#ind-custom-section"));
    bindIndicatorPop(pop);
    renderChartLegend();
    updateSlotIndCounts();
  }

  function customSectionHtml() {
    var defs = loadCustomDefs();
    var q = String(_indSearch || "").trim().toLowerCase();
    function matchName(name) {
      if (!q) return true;
      return String(name || "").toLowerCase().indexOf(q) >= 0;
    }
    var html = '<div class="ind-picker-toolbar"><button type="button" class="btn-primary" id="btn-new-custom">+ New custom indicator</button></div>';
    html += '<div class="ind-picker-cols with-actions"><span></span><span>Name</span><span>Type</span><span></span></div>';
    html += '<div class="ind-picker-body">';
    html += "<div class=\"chart-pop-title\">Python indicators</div>";
    var pyShown = 0;
    if (!_pyCatalog.length) {
      html += "<div class=\"chart-pop-row\"><span class=\"settings-broker-desc\">None found in custom_indicators/</span></div>";
    }
    _pyCatalog.forEach(function (m) {
      if (!matchName(m.name) && !matchName(m.id)) return;
      pyShown += 1;
      var n = activeIndicators.filter(function (x) { return x.kind === "python" && x.id === m.id; }).length;
      html += '<div class="ind-picker-row with-actions">' + favStarBtn("python", m.id) +
        '<button type="button" class="ind-list-item" data-pick="python" data-py="' + escHtml(m.id) + '">' +
        '<span class="ind-list-name">' + escHtml(m.name) + (n ? " · " + n + " on" : "") + "</span></button>" +
        '<span class="ind-list-code">Python</span><span class="chart-pop-row-actions"></span></div>';
    });
    if (_pyCatalog.length && !pyShown) {
      html += "<div class=\"chart-pop-row\"><span class=\"settings-broker-desc\">No Python indicators match</span></div>";
    }
    html += "<div class=\"chart-pop-title\">Saved formulas</div>";
    var savedShown = 0;
    if (!defs.length) html += "<div class=\"chart-pop-row\"><span class=\"settings-broker-desc\">No saved formulas yet</span></div>";
    defs.forEach(function (d) {
      if (!matchName(d.name) && !matchName(d.id)) return;
      savedShown += 1;
      var n = activeIndicators.filter(function (x) { return x.kind === "custom" && x.id === d.id; }).length;
      html += '<div class="ind-picker-row with-actions">' + favStarBtn("custom", d.id) +
        '<button type="button" class="ind-list-item" data-pick="custom" data-capply="' + escHtml(d.id) + '">' +
        '<span class="ind-list-name">' + escHtml(d.name) + (n ? " · " + n + " on" : "") + "</span></button>" +
        '<span class="ind-list-code">Formula</span><span class="chart-pop-row-actions">' +
        '<button type="button" class="btn-secondary" data-cedit="' + escHtml(d.id) + '">Edit</button>' +
        '<button type="button" class="btn-danger" data-cdel="' + escHtml(d.id) + '">×</button></span></div>';
    });
    if (defs.length && !savedShown) {
      html += "<div class=\"chart-pop-row\"><span class=\"settings-broker-desc\">No saved formulas match</span></div>";
    }
    html += "</div>";
    return html;
  }

  function bindCustomSection(root) {
    if (!root) return;
    var neu = root.querySelector("#btn-new-custom");
    if (neu) neu.addEventListener("click", function (e) { e.stopPropagation(); focusActiveSlot(); openCustomModal(null); });
    root.querySelectorAll("[data-cedit]").forEach(function (b) {
      b.addEventListener("click", function (e) {
        e.stopPropagation();
        focusActiveSlot();
        openCustomModal(b.dataset.cedit);
      });
    });
    root.querySelectorAll("[data-cdel]").forEach(function (b) {
      b.addEventListener("click", function (e) {
        e.stopPropagation();
        var id = b.dataset.cdel;
        var origin = activeSlot;
        var si;
        for (si = 0; si < splitCount; si++) {
          withSlot(si, function () {
            var i;
            for (i = activeIndicators.length - 1; i >= 0; i--) {
              if (activeIndicators[i].kind === "custom" && activeIndicators[i].id === id) removeActive(i);
            }
          });
        }
        saveCustomDefs(loadCustomDefs().filter(function (d) { return d.id !== id; }));
        removeIndFav("custom", id);
        withSlot(origin, function () { renderCustomPop(); });
      });
    });
  }

  function renderCustomPop() {
    renderIndicatorPop(isIndPickerOpen());
  }

  function openCustomModal(id) {
    editingCustomId = id;
    var modal = document.getElementById("custom-ind-modal");
    var err = document.getElementById("custom-ind-error");
    if (err) { err.classList.add("hidden"); err.textContent = ""; }
    var def = id ? loadCustomDefs().filter(function (d) { return d.id === id; })[0] : null;
    document.getElementById("custom-ind-title").textContent = def ? "Edit custom indicator" : "New custom indicator";
    document.getElementById("custom-ind-name").value = def ? def.name : "";
    document.getElementById("custom-ind-formula").value = def ? def.formula : "SMA(close, 20)";
    document.getElementById("custom-ind-pane").value = def ? def.pane : "overlay";
    document.getElementById("custom-ind-plot").value = def ? def.plot : "line";
    document.getElementById("custom-ind-color").value = def ? def.color : "#58a6ff";
    modal.classList.remove("hidden");
    closeIndPicker();
  }
  function closeCustomModal() {
    document.getElementById("custom-ind-modal").classList.add("hidden");
    editingCustomId = null;
  }
  function saveCustomFromModal() {
    focusActiveSlot();
    var name = document.getElementById("custom-ind-name").value.trim() || "Custom";
    var formula = document.getElementById("custom-ind-formula").value.trim();
    var err = document.getElementById("custom-ind-error");
    try {
      if (!formula) throw new Error("Formula is required.");
      evalFormula(formula, [
        { open: 10, high: 12, low: 9, close: 11, volume: 100 },
        { open: 11, high: 13, low: 10, close: 12, volume: 110 }
      ]);
    } catch (e) {
      err.textContent = e.message || String(e);
      err.classList.remove("hidden");
      return;
    }
    var list = loadCustomDefs();
    var def = {
      id: editingCustomId || ("c" + Date.now().toString(36)),
      name: name,
      formula: formula,
      pane: document.getElementById("custom-ind-pane").value,
      plot: document.getElementById("custom-ind-plot").value,
      color: document.getElementById("custom-ind-color").value
    };
    var i = list.findIndex(function (d) { return d.id === def.id; });
    if (i >= 0) list[i] = def; else list.push(def);
    saveCustomDefs(list);
    closeCustomModal();
    var addedAny = false;
    var origin = activeSlot;
    var si;
    Object.keys(_customCalcs).forEach(function (n) {
      if (_customCalcs[n] && _customCalcs[n].id === def.id) _customCalcs[n] = def;
    });
    for (si = 0; si < splitCount; si++) {
      withSlot(si, function () {
        var kept = [];
        var ri, cur;
        for (ri = activeIndicators.length - 1; ri >= 0; ri--) {
          cur = activeIndicators[ri];
          if (cur.kind === "custom" && cur.id === def.id) {
            kept.unshift({ uid: cur.uid, visible: cur.visible, color: cur.color });
            removeActive(ri);
          }
        }
        if (kept.length) {
          kept.forEach(function (p) { applyCustomToChart(def.id, true, p); });
          persistIndicators();
          addedAny = true;
        }
      });
    }
    if (!addedAny) {
      withSlot(origin, function () { applyCustomToChart(def.id); });
    }
    focusActiveSlot();
    renderCustomPop();
  }

  document.getElementById("btn-ind-menu").addEventListener("click", function (e) {
    e.stopPropagation();
    focusActiveSlot();
    var modal = document.getElementById("ind-picker-modal");
    var opening = modal && modal.classList.contains("hidden");
    if (opening) {
      _indSearch = "";
      _indFocusIdx = -1;
    }
    renderIndicatorPop();
    if (modal) modal.classList.toggle("hidden");
    var sp = document.getElementById("split-pop");
    if (sp) sp.classList.add("hidden");
    var tp = document.getElementById("candle-type-pop");
    if (tp) tp.classList.add("hidden");
    if (opening && isIndPickerOpen()) {
      var inp = document.getElementById("ind-search");
      if (inp) inp.focus();
    }
  });
  var indPickerModal = document.getElementById("ind-picker-modal");
  if (indPickerModal) {
    indPickerModal.addEventListener("click", function (e) {
      if (e.target.id === "ind-picker-modal") closeIndPicker();
    });
  }
  (function () {
    var btn = document.getElementById("btn-candle-type");
    if (!btn) return;
    updateCandleTypeButton();
    renderCandleTypePop();
    btn.addEventListener("click", function (e) {
      e.stopPropagation();
      renderCandleTypePop();
      var pop = document.getElementById("candle-type-pop");
      var sp3 = document.getElementById("split-pop");
      closeIndPicker();
      if (sp3) sp3.classList.add("hidden");
      if (pop) pop.classList.toggle("hidden");
    });
  })();
  var clearDrawBtn = document.getElementById("btn-clear-drawings");
  if (clearDrawBtn) {
    bindDrawToolTip(clearDrawBtn, "Remove all drawings");
    clearDrawBtn.addEventListener("click", function () {
      if (!chart) return;
      try { chart.removeOverlay({ groupId: "userdraw" }); } catch (_) {}
      overlayIds.length = 0;
      selectedOverlayId = null;
      persistOverlays();
    });
  }

  function isTypingTarget(el) {
    if (!el) return false;
    var tag = (el.tagName || "").toUpperCase();
    return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
  }

  function syncColorSwatches(rootId, color) {
    var host = document.getElementById(rootId);
    if (!host) return;
    var c = (color || "").toLowerCase();
    host.querySelectorAll(".rect-swatch").forEach(function (b) {
      b.classList.toggle("active", (b.dataset.color || "").toLowerCase() === c);
    });
  }

  function openTextModal(id, isNew) {
    pendingTextId = id;
    pendingTextIsNew = !!isNew;
    var o = chart && chart.getOverlayById(id);
    var data = parseTextData(o && o.extendData);
    pendingTextPrev = data.text;
    var inp = document.getElementById("chart-text-input");
    var colorEl = document.getElementById("chart-text-color");
    var modal = document.getElementById("chart-text-modal");
    if (inp) inp.value = data.text === "Text" && isNew ? "" : data.text;
    if (colorEl) colorEl.value = data.color;
    syncColorSwatches("chart-text-swatches", data.color);
    if (modal) modal.classList.remove("hidden");
    setTimeout(function () { if (inp) inp.focus(); }, 30);
  }

  function closeTextModal(save) {
    var modal = document.getElementById("chart-text-modal");
    if (modal) modal.classList.add("hidden");
    if (!chart || !pendingTextId) { pendingTextId = null; return; }
    var inp = document.getElementById("chart-text-input");
    var colorEl = document.getElementById("chart-text-color");
    var text = inp ? inp.value.trim() : "";
    if (save) {
      if (!text) text = "Text";
      chart.overrideOverlay({
        id: pendingTextId,
        extendData: {
          text: text,
          color: colorEl && colorEl.value ? colorEl.value : "#ffffff"
        }
      });
      persistOverlays();
    } else if (pendingTextIsNew) {
      try { chart.removeOverlay({ id: pendingTextId }); } catch (_) {}
      forgetOverlayId(pendingTextId, _curSlot);
      persistOverlays(_curSlot);
    }
    pendingTextId = null;
  }

  var textOk = document.getElementById("chart-text-ok");
  var textCancel = document.getElementById("chart-text-cancel");
  var textClose = document.getElementById("chart-text-close");
  if (textOk) textOk.addEventListener("click", function () { closeTextModal(true); });
  if (textCancel) textCancel.addEventListener("click", function () { closeTextModal(false); });
  if (textClose) textClose.addEventListener("click", function () { closeTextModal(false); });
  var textModal = document.getElementById("chart-text-modal");
  if (textModal) textModal.addEventListener("click", function (e) {
    if (e.target.id === "chart-text-modal") closeTextModal(false);
  });
  var textInp = document.getElementById("chart-text-input");
  if (textInp) textInp.addEventListener("keydown", function (e) {
    if (e.key === "Enter") { e.preventDefault(); closeTextModal(true); }
    if (e.key === "Escape") { e.preventDefault(); closeTextModal(false); }
  });
  var textColor = document.getElementById("chart-text-color");
  if (textColor) textColor.addEventListener("input", function () {
    syncColorSwatches("chart-text-swatches", textColor.value);
  });
  var textSwatches = document.getElementById("chart-text-swatches");
  if (textSwatches) {
    textSwatches.querySelectorAll(".rect-swatch").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var colorEl = document.getElementById("chart-text-color");
        if (colorEl) colorEl.value = btn.dataset.color;
        syncColorSwatches("chart-text-swatches", btn.dataset.color);
      });
    });
  }

  function syncRectSwatches(color) {
    syncColorSwatches("chart-rect-swatches", color);
  }

  function openRectModal(id) {
    pendingRectId = id;
    var o = chart && chart.getOverlayById(id);
    var data = parseRectData(o && o.extendData);
    var colorEl = document.getElementById("chart-rect-color");
    var textEl = document.getElementById("chart-rect-text");
    var modal = document.getElementById("chart-rect-modal");
    if (colorEl) colorEl.value = data.color;
    if (textEl) textEl.value = data.text;
    syncRectSwatches(data.color);
    if (modal) modal.classList.remove("hidden");
    setTimeout(function () { if (textEl) textEl.focus(); }, 30);
  }

  function closeRectModal(save) {
    var modal = document.getElementById("chart-rect-modal");
    if (modal) modal.classList.add("hidden");
    if (!chart || !pendingRectId) { pendingRectId = null; return; }
    if (save) {
      var colorEl = document.getElementById("chart-rect-color");
      var textEl = document.getElementById("chart-rect-text");
      chart.overrideOverlay({
        id: pendingRectId,
        extendData: {
          color: colorEl ? colorEl.value : "#58a6ff",
          text: textEl ? textEl.value : ""
        }
      });
      persistOverlays();
    }
    pendingRectId = null;
  }

  var rectOk = document.getElementById("chart-rect-ok");
  var rectCancel = document.getElementById("chart-rect-cancel");
  var rectClose = document.getElementById("chart-rect-close");
  if (rectOk) rectOk.addEventListener("click", function () { closeRectModal(true); });
  if (rectCancel) rectCancel.addEventListener("click", function () { closeRectModal(false); });
  if (rectClose) rectClose.addEventListener("click", function () { closeRectModal(false); });
  var rectModal = document.getElementById("chart-rect-modal");
  if (rectModal) rectModal.addEventListener("click", function (e) {
    if (e.target.id === "chart-rect-modal") closeRectModal(false);
  });
  var rectColor = document.getElementById("chart-rect-color");
  if (rectColor) rectColor.addEventListener("input", function () { syncRectSwatches(rectColor.value); });
  var rectSwatches = document.getElementById("chart-rect-swatches");
  if (rectSwatches) {
    rectSwatches.querySelectorAll(".rect-swatch").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var colorEl = document.getElementById("chart-rect-color");
        if (colorEl) colorEl.value = btn.dataset.color;
        syncRectSwatches(btn.dataset.color);
      });
    });
  }
  document.getElementById("custom-ind-close").addEventListener("click", closeCustomModal);
  document.getElementById("custom-ind-cancel").addEventListener("click", closeCustomModal);
  document.getElementById("custom-ind-save").addEventListener("click", saveCustomFromModal);
  document.getElementById("custom-ind-modal").addEventListener("click", function (e) {
    if (e.target.id === "custom-ind-modal") closeCustomModal();
  });
  var indSetSave = document.getElementById("ind-settings-save");
  var indSetCancel = document.getElementById("ind-settings-cancel");
  var indSetClose = document.getElementById("ind-settings-close");
  var indSetModal = document.getElementById("ind-settings-modal");
  if (indSetSave) indSetSave.addEventListener("click", saveIndSettings);
  var indSetReset = document.getElementById("ind-settings-reset");
  if (indSetReset) indSetReset.addEventListener("click", function (e) {
    e.preventDefault();
    e.stopPropagation();
    if (!isSmoothingMeta(_settingsPyMeta)) return;
    var factory = smoothingFactory(_settingsPyMeta);
    fillSmoothingSettings(factory, _settingsPyMeta);
    savePyLastUsed(_settingsPyMeta.id, factory);
    var idx = editingIndIdx;
    if (idx != null && activeIndicators[idx] && activeIndicators[idx].kind === "python") {
      var item = activeIndicators[idx];
      item.params = cloneJson(factory);
      item.color = firstSmoothColor(item.params);
      refreshPythonIndicator(item);
      persistIndicators();
      renderIndicatorPop();
      renderCustomPop();
    }
  });
  if (indSetCancel) indSetCancel.addEventListener("click", closeIndSettings);
  if (indSetClose) indSetClose.addEventListener("click", closeIndSettings);
  if (indSetModal) indSetModal.addEventListener("click", function (e) {
    if (e.target.id === "ind-settings-modal") closeIndSettings();
  });
  if (indSetModal) indSetModal.addEventListener("keydown", function (e) {
    if (e.key === "Enter") { e.preventDefault(); saveIndSettings(); }
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") {
      var modalOpen = chartDrawModalOpen();
      closeIndPicker();
      closeCustomModal();
      closeIndSettings();
      var tm = document.getElementById("chart-text-modal");
      if (tm && !tm.classList.contains("hidden")) closeTextModal(false);
      var rm = document.getElementById("chart-rect-modal");
      if (rm && !rm.classList.contains("hidden")) closeRectModal(false);
      if (!modalOpen && !isTypingTarget(e.target) && !_replay.active && !_replay.picking) {
        if (activeDraw !== "cursor" || _pendingDrawId) {
          clearPendingDraw();
          setActiveDraw("cursor");
        }
      }
      return;
    }
    if ((e.key === "Delete" || e.key === "Backspace") && selectedOverlayId && chart && !isTypingTarget(e.target)) {
      e.preventDefault();
      var id = selectedOverlayId;
      try { chart.removeOverlay({ id: id }); } catch (_) {}
      forgetOverlayId(id, _curSlot);
      selectedOverlayId = null;
      persistOverlays(_curSlot);
      return;
    }
    if (e.repeat || isTypingTarget(e.target) || chartDrawModalOpen()) return;
    var homePage = document.getElementById("page-home");
    if (!homePage || !homePage.classList.contains("active")) return;
    if (eventMatchesDrawShortcut(e, MAGNET_SHORTCUT)) {
      e.preventDefault();
      setMagnetOn(!magnetOn);
      return;
    }
    var i, tool;
    for (i = 0; i < DRAW_TOOLS.length; i++) {
      tool = DRAW_TOOLS[i];
      if (!tool.shortcut || tool.shortcut.key === "Escape") continue;
      if (!eventMatchesDrawShortcut(e, tool.shortcut)) continue;
      e.preventDefault();
      startDrawing(tool.name);
      return;
    }
  });

  function dateIST(tsMs) {
    try {
      return new Intl.DateTimeFormat("en-CA", {
        timeZone: IST_TZ, year: "numeric", month: "2-digit", day: "2-digit"
      }).format(new Date(tsMs));
    } catch (_) {
      return new Date(tsMs).toISOString().slice(0, 10);
    }
  }

  function shiftDate(ymd, days) {
    var p = String(ymd || "").split("-");
    if (p.length < 3) return ymd;
    var dt = new Date(Date.UTC(+p[0], +p[1] - 1, +p[2]));
    dt.setUTCDate(dt.getUTCDate() + days);
    var m = dt.getUTCMonth() + 1;
    var d = dt.getUTCDate();
    return dt.getUTCFullYear() + "-" + (m < 10 ? "0" : "") + m + "-" + (d < 10 ? "0" : "") + d;
  }

  function lookbackDays(iv) {
    var cfg = intervalCfg(iv);
    var days = parseInt(cfg.days, 10);
    if (days > 0) return days;
    if (iv === "D") return 1825;
    if (iv === "60") return 120;
    if (iv === "25") return 60;
    if (iv === "15") return 45;
    if (iv === "5") return 21;
    if (iv === "1" && activeBroker === "yahoo") return 8;
    return 10;
  }

  function moreChunkDays(iv) {
    var days = Math.max(5, Math.round(lookbackDays(iv) / 4));
    if (fetchInterval(iv) === "1" && activeBroker === "yahoo") return Math.min(days, 8);
    return days;
  }

  function yahooEarliestDate(iv) {
    var today = dateIST(Date.now());
    var src = fetchInterval(iv);
    if (src === "1") return shiftDate(today, -8);
    if (src === "25" || src === "30") return shiftDate(today, -60);
    return null;
  }

  function clampYahooRange(fromDate, toDate, iv) {
    if (activeBroker !== "yahoo") return { fromDate: fromDate, toDate: toDate, empty: false };
    var minFrom = yahooEarliestDate(iv || activeInterval);
    if (!minFrom) return { fromDate: fromDate, toDate: toDate, empty: false };
    if (toDate && toDate < minFrom) return { fromDate: minFrom, toDate: toDate, empty: true };
    if (fromDate && fromDate < minFrom) fromDate = minFrom;
    return { fromDate: fromDate, toDate: toDate, empty: false };
  }

  async function fetchCandlesFor(instrument, interval, fromDate, toDate) {
    if (!instrument) return { candles: [], overlays: [] };
    var res;
    if (activeBroker === "5paisa") {
      res = await fetch("/api/5paisa/chart/data", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          scrip_code: instrument.scrip_code,
          exch: instrument.exch,
          exch_type: instrument.exch_type,
          trading_symbol: instrument.trading_symbol || "",
          interval: interval,
          from_date: fromDate || "",
          to_date: toDate || ""
        })
      });
    } else if (activeBroker === "yahoo") {
      res = await fetch("/api/yahoo/chart/data", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          yahoo_symbol: instrument.yahoo_symbol || instrument.scrip_code || "",
          trading_symbol: instrument.trading_symbol || "",
          interval: interval,
          from_date: fromDate || "",
          to_date: toDate || ""
        })
      });
    } else if (activeBroker === "excel") {
      res = await fetch("/api/excel/chart/data", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          config_id: instrument.excel_config_id || instrument.scrip_code || "",
          trading_symbol: instrument.trading_symbol || "",
          interval: interval,
          from_date: fromDate || "",
          to_date: toDate || ""
        })
      });
    } else {
      res = await fetch("/api/chart/data", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          security_id: instrument.security_id,
          exchange_segment: instrument.exchange_segment,
          instrument: instrument.instrument,
          interval: interval,
          from_date: fromDate || "",
          to_date: toDate || ""
        })
      });
    }
    var data = await res.json();
    if (!data.success) {
      var err = new Error(data.message || "Failed to load chart data.");
      err.payload = data;
      throw err;
    }
    return {
      candles: (data.candles || []).map(toKLine),
      overlays: activeBroker === "excel" ? (data.overlays || []) : []
    };
  }

  async function fetchCandles(fromDate, toDate) {
    var pack = await fetchCandlesFor(selectedInstrument, activeInterval, fromDate, toDate);
    _excelOverlayData = pack.overlays || [];
    if (chartSlots[_curSlot]) chartSlots[_curSlot].excelOverlayData = _excelOverlayData;
    return pack.candles || [];
  }

  function clearExcelOverlays() {
    if (!chart) {
      _excelOverlayIds.length = 0;
      return;
    }
    _excelOverlayIds.forEach(function (id) {
      try { chart.removeOverlay({ id: id }); } catch (_) {
        try { chart.removeOverlay(id); } catch (__) {}
      }
    });
    _excelOverlayIds.length = 0;
  }

  function barByTime(ts) {
    var i;
    for (i = 0; i < _rawBars.length; i++) {
      if (_rawBars[i].timestamp === ts) return _rawBars[i];
    }
    return null;
  }

  function excelDataIndex(ts) {
    var i;
    for (i = 0; i < _rawBars.length; i++) {
      if (_rawBars[i].timestamp === ts) return i;
    }
    return -1;
  }

  function applyExcelOverlays() {
    if (!chart || activeBroker !== "excel") return;
    clearExcelOverlays();
    var list = _excelOverlayData || [];
    list.forEach(function (ov, idx) {
      if (!ov) return;
      var color = EXCEL_IND_COLORS[idx % EXCEL_IND_COLORS.length];
      var line = ov.line || [];
      var pts = [];
      line.forEach(function (p) {
        if (!p || p.value == null || !isFinite(Number(p.value))) return;
        var ts = Number(p.time) * 1000;
        var di = excelDataIndex(ts);
        if (di < 0) return;
        pts.push({ timestamp: ts, value: Number(p.value), dataIndex: di });
      });
      if (pts.length) {
        var anchors = pts.length >= 2 ? [pts[0], pts[pts.length - 1]] : [pts[0], pts[0]];
        var lid = chart.createOverlay({
          name: "excelLine",
          points: anchors,
          extendData: { color: color, name: ov.name || "", points: pts },
          lock: true,
          mode: "normal"
        }, "candle_pane");
        if (lid) _excelOverlayIds.push(lid);
      }
      (ov.labels || []).forEach(function (lb) {
        if (!lb || !lb.text) return;
        var ts = Number(lb.time) * 1000;
        var bar = barByTime(ts);
        var y = bar ? bar.low : null;
        if (y == null || !isFinite(y)) return;
        var tid = chart.createOverlay({
          name: "excelLabel",
          points: [{ timestamp: ts, value: y }],
          extendData: { text: String(lb.text), color: color },
          lock: true,
          mode: "normal"
        }, "candle_pane");
        if (tid) _excelOverlayIds.push(tid);
      });
    });
  }

  function bindHistoryLoader() {
    if (!chart || !chart.setLoadDataCallback) return;
    var mySlot = _curSlot;
    chart.setLoadDataCallback(function (params) {
      var type = params && params.type;
      var cb = params && params.callback;
      var data = params && params.data;
      function done(list, more) {
        if (cb) cb(list || [], more);
      }
      if (type !== "forward") {
        done([], false);
        return;
      }
      _useSlot(mySlot);
      if (activeBroker === "excel") {
        _useSlot(activeSlot);
        done([], false);
        return;
      }
      if (!_histMore || _histLoading || !selectedInstrument) {
        _useSlot(activeSlot);
        done([], !!_histMore);
        return;
      }
      var ts = data && data.timestamp;
      if (ts == null) { _useSlot(activeSlot); done([], false); return; }
      _histLoading = true;
      var toDate = dateIST(ts);
      var fromDate = shiftDate(toDate, -moreChunkDays(activeInterval));
      var yrange = clampYahooRange(fromDate, toDate);
      if (yrange.empty) {
        _histMore = false;
        _histLoading = false;
        _useSlot(activeSlot);
        done([], false);
        return;
      }
      fromDate = yrange.fromDate;
      fetchCandles(fromDate, toDate).then(function (candles) {
        /* Re-establish this chart's slot in case the user switched away. */
        if (_curSlot !== mySlot) _useSlot(mySlot);
        var older = (candles || []).filter(function (c) { return c.timestamp < ts; });
        if (!older.length) {
          _histMore = false;
          done([], false);
          commitSlotGlobals();
          _useSlot(activeSlot);
          return;
        }
        /* _rawBars must stay the same array reference (slot state) */
        older.forEach(function (b) { _rawBars.unshift(b); });
        if (_replay.active && _replay.index >= 0) _replay.index += older.length;
        if (_replay.startIndex != null) _replay.startIndex += older.length;
        syncPrevClose();
        refreshLiveQuote();
        updateReplayUi();
        if (currentTypeSpec().ha) {
          var ha = toHeikinAshi(visibleRawBars());
          done(ha.slice(0, older.length), _histMore);
        } else {
          done(older, _histMore);
        }
        schedulePyRefresh(true);
        commitSlotGlobals();
        _useSlot(activeSlot);
      }).catch(function () {
        if (_curSlot !== mySlot) _useSlot(mySlot);
        _histMore = false;
        done([], false);
        commitSlotGlobals();
        _useSlot(activeSlot);
      }).finally(function () {
        _histLoading = false;
        if (chartSlots[mySlot]) chartSlots[mySlot].histLoading = false;
        if (chartSlots[mySlot]) chartSlots[mySlot].histMore = _histMore;
      });
    });
  }

  async function loadChartData(silent, opts) {
    opts = opts || {};
    var loadSlot = opts.slot != null ? opts.slot : _curSlot;
    if (!silent && !_layoutSyncBusy && opts.slot == null) {
      focusActiveSlot();
      loadSlot = _curSlot;
    }
    var slot = chartSlots[loadSlot];
    if (!slot || !slot.instrument) return;
    if (silent && slot.refreshing) return;
    if (!silent && _refreshing && !_layoutSyncBusy) return;
    slot.refreshing = true;
    if (!silent) _refreshing = true;
    if (_curSlot !== loadSlot) _useSlot(loadSlot);
    if (!silent) {
      _lastBarTime = null;
      if (!opts.syncLoad && loadSlot === activeSlot) {
        chartMessage.textContent = "Loading chart data\u2026";
        chartMessage.style.display = "flex";
      }
    }
    var instrument = slot.instrument;
    var interval = slot.interval || "1";
    try {
      var pack = opts.prefetched || null;
      if (!pack) {
        var toDate = dateIST(Date.now());
        var fromDate = shiftDate(toDate, -lookbackDays(interval));
        var yrange = clampYahooRange(fromDate, toDate, interval);
        fromDate = yrange.fromDate;
        try {
          pack = await fetchCandlesFor(instrument, interval, fromDate, toDate);
        } catch (e) {
          var msg = e.message || "Failed to load chart data.";
          var payload = e.payload || {};
          if (payload.error_code === "DH-902" || (msg && msg.indexOf("Data API") >= 0)) {
            msg = "\u26a0\ufe0f Data API subscription required.\n" + msg + "\n\nSubscribe at: https://dhan.co/data-apis/";
          }
          if (!silent && loadSlot === activeSlot) {
            chartMessage.textContent = msg;
            chartMessage.style.display = "flex";
          }
          return;
        }
      }
      if (_curSlot !== loadSlot) _useSlot(loadSlot);
      var formatted = (pack && pack.candles) || [];
      _excelOverlayData = (pack && pack.overlays) || [];
      slot.excelOverlayData = _excelOverlayData;
      if (!formatted.length) {
        if (!silent && loadSlot === activeSlot) {
          chartMessage.textContent = "No data returned for selected range.";
          chartMessage.style.display = "flex";
        }
        return;
      }
      /* Full reload when not silent, chart missing, or slot has no bars yet (page restore). */
      var isFullLoad = !silent || !!opts.syncLoad || !chart || !_rawBars.length;
      if (isFullLoad) {
        persistOverlays(loadSlot);
        _overlaysSuspended = true;
        try {
          exitReplay(false);
          _histMore = activeBroker !== "excel";
          _histLoading = false;
          _rawBars.length = 0;
          formatted.forEach(function (b) { _rawBars.push(b); });
          initChart();
          chart.applyNewData(displaySeries(_rawBars), true);
          restoreIndicators();
          await restoreOverlays(loadSlot);
        } finally {
          _overlaysSuspended = false;
        }
        applyExcelOverlays();
      } else {
        for (var i = 0; i < formatted.length; i++) {
          upsertRawBar(formatted[i]);
        }
        if (!replayFrozen() && chart) {
          var shown = displaySeries(_rawBars);
          for (var j = 0; j < shown.length; j++) {
            if (_lastBarTime === null || shown[j].timestamp >= _lastBarTime) {
              try { chart.updateData(shown[j]); } catch (_) {}
            }
          }
          schedulePyRefresh();
          applyExcelOverlays();
        }
      }
      _lastBarTime = formatted.length ? formatted[formatted.length - 1].timestamp : _lastBarTime;
      syncPrevClose();
      if (_curSlot === activeSlot) {
        if (symbolLabel) symbolLabel.textContent = "";
        syncSlotHeaderMeta(chartSlots[activeSlot]);
        refreshLiveQuote();
        positionChartMeta();
        chartMessage.style.display = "none";
      }
      updateSlotTickers();
      if (isFullLoad && loadSlot === activeSlot) {
        unsubscribeLive();
        if (activeBroker === "5paisa" && !intervalCfg(activeInterval).resample) subscribeLive();
        startAutoRefresh();
      }
      commitSlotGlobals();
    } catch (e) {
      if (!silent && loadSlot === activeSlot) {
        chartMessage.textContent = "Error: " + e.message;
        chartMessage.style.display = "flex";
      }
    } finally {
      if (chartSlots[loadSlot]) chartSlots[loadSlot].refreshing = false;
      if (!silent) _refreshing = false;
      if (loadSlot !== _curSlot) _useSlot(loadSlot);
      if (chartSlots[_curSlot]) chartSlots[_curSlot].refreshing = false;
      if (activeSlot !== _curSlot && chartSlots[activeSlot]) _useSlot(activeSlot);
    }
  }

  /* ── Tiny formula language (Pine-like, array-based) ── */
  function tokenize(src) {
    var s = src.replace(/\s+/g, "");
    var toks = [];
    var i = 0;
    while (i < s.length) {
      var c = s[i];
      if (/[0-9.]/.test(c)) {
        var n = "";
        while (i < s.length && /[0-9.]/.test(s[i])) n += s[i++];
        toks.push({ t: "num", v: parseFloat(n) });
        continue;
      }
      if (/[A-Za-z_]/.test(c)) {
        var id = "";
        while (i < s.length && /[A-Za-z0-9_]/.test(s[i])) id += s[i++];
        toks.push({ t: "id", v: id.toLowerCase() });
        continue;
      }
      var two = s.slice(i, i + 2);
      if (two === ">=" || two === "<=" || two === "==" || two === "!=") {
        toks.push({ t: "op", v: two }); i += 2; continue;
      }
      if ("+-*/^(),><".indexOf(c) >= 0) {
        toks.push({ t: c === "," ? "comma" : (c === "(" ? "lp" : (c === ")" ? "rp" : "op")), v: c });
        i++; continue;
      }
      throw new Error("Unexpected character: " + c);
    }
    return toks;
  }

  function parseFormula(src) {
    var toks = tokenize(src);
    var p = 0;
    function peek() { return toks[p]; }
    function eat(t) {
      var x = toks[p];
      if (!x || (t && x.t !== t && x.v !== t)) throw new Error("Unexpected token");
      p++; return x;
    }
    function parseCmp() {
      var left = parseAdd();
      var tk = peek();
      if (tk && tk.t === "op" && (tk.v === ">" || tk.v === "<" || tk.v === ">=" || tk.v === "<=" || tk.v === "==" || tk.v === "!=")) {
        eat();
        return { k: "binop", op: tk.v, a: left, b: parseAdd() };
      }
      return left;
    }
    function parseAdd() {
      var left = parseMul();
      while (peek() && peek().t === "op" && (peek().v === "+" || peek().v === "-")) {
        var op = eat().v;
        left = { k: "binop", op: op, a: left, b: parseMul() };
      }
      return left;
    }
    function parseMul() {
      var left = parsePow();
      while (peek() && peek().t === "op" && (peek().v === "*" || peek().v === "/")) {
        var op = eat().v;
        left = { k: "binop", op: op, a: left, b: parsePow() };
      }
      return left;
    }
    function parsePow() {
      var left = parseUnary();
      if (peek() && peek().t === "op" && peek().v === "^") {
        eat();
        return { k: "binop", op: "^", a: left, b: parsePow() };
      }
      return left;
    }
    function parseUnary() {
      if (peek() && peek().t === "op" && peek().v === "-") {
        eat();
        return { k: "unary", op: "-", a: parseUnary() };
      }
      return parsePrimary();
    }
    function parsePrimary() {
      var tk = peek();
      if (!tk) throw new Error("Unexpected end of formula");
      if (tk.t === "num") { eat(); return { k: "num", v: tk.v }; }
      if (tk.t === "lp") {
        eat();
        var e = parseCmp();
        if (!peek() || peek().t !== "rp") throw new Error("Missing )");
        eat();
        return e;
      }
      if (tk.t === "id") {
        eat();
        if (peek() && peek().t === "lp") {
          eat();
          var args = [];
          if (peek() && peek().t !== "rp") {
            args.push(parseCmp());
            while (peek() && peek().t === "comma") { eat(); args.push(parseCmp()); }
          }
          if (!peek() || peek().t !== "rp") throw new Error("Missing ) after arguments");
          eat();
          return { k: "call", name: tk.v, args: args };
        }
        return { k: "id", v: tk.v };
      }
      throw new Error("Unexpected token");
    }
    var ast = parseCmp();
    if (p !== toks.length) throw new Error("Unexpected extra tokens");
    return ast;
  }

  function srcKey(name) {
    if (name === "open" || name === "high" || name === "low" || name === "close" || name === "volume") return name;
    if (name === "hl2" || name === "hlc3" || name === "ohlc4") return name;
    return null;
  }
  function barSrc(d, name) {
    if (name === "hl2") return (d.high + d.low) / 2;
    if (name === "hlc3") return (d.high + d.low + d.close) / 3;
    if (name === "ohlc4") return (d.open + d.high + d.low + d.close) / 4;
    return d[name];
  }
  function nlen(a, b) { return Math.max(a.length, b.length); }
  function asArr(x, n) {
    if (Array.isArray(x)) return x;
    var o = new Array(n);
    for (var i = 0; i < n; i++) o[i] = x;
    return o;
  }
  function bin(a, b, fn) {
    var n = nlen(asArr(a, 1), asArr(b, 1));
    if (!Array.isArray(a) && !Array.isArray(b)) n = 1;
    if (Array.isArray(a)) n = a.length;
    if (Array.isArray(b)) n = Math.max(n, b.length);
    a = asArr(a, n); b = asArr(b, n);
    var o = new Array(n);
    for (var i = 0; i < n; i++) {
      if (a[i] == null || b[i] == null || !isFinite(a[i]) || !isFinite(b[i])) o[i] = null;
      else o[i] = fn(a[i], b[i]);
    }
    return o;
  }
  function rolling(src, period, fn) {
    var n = Math.max(1, period | 0);
    var o = new Array(src.length);
    for (var i = 0; i < src.length; i++) {
      if (i < n - 1) { o[i] = null; continue; }
      var win = [];
      var ok = true;
      for (var j = i - n + 1; j <= i; j++) {
        if (src[j] == null || !isFinite(src[j])) { ok = false; break; }
        win.push(src[j]);
      }
      o[i] = ok ? fn(win) : null;
    }
    return o;
  }
  function ema(src, period) {
    var n = Math.max(1, period | 0);
    var k = 2 / (n + 1);
    var o = new Array(src.length);
    var prev = null;
    for (var i = 0; i < src.length; i++) {
      if (src[i] == null || !isFinite(src[i])) { o[i] = null; continue; }
      if (prev == null) {
        if (i < n - 1) { o[i] = null; continue; }
        var s = 0;
        for (var j = i - n + 1; j <= i; j++) s += src[j];
        prev = s / n;
        o[i] = prev;
      } else {
        prev = src[i] * k + prev * (1 - k);
        o[i] = prev;
      }
    }
    return o;
  }
  function rsi(src, period) {
    var n = Math.max(1, period | 0);
    var o = new Array(src.length);
    var ag = 0, al = 0;
    for (var i = 0; i < src.length; i++) {
      o[i] = null;
      if (i === 0 || src[i] == null || src[i - 1] == null) continue;
      var ch = src[i] - src[i - 1];
      var g = Math.max(ch, 0), l = Math.max(-ch, 0);
      if (i <= n) {
        ag += g; al += l;
        if (i === n) {
          ag /= n; al /= n;
          var rs = al === 0 ? 100 : ag / al;
          o[i] = 100 - 100 / (1 + rs);
        }
      } else {
        ag = (ag * (n - 1) + g) / n;
        al = (al * (n - 1) + l) / n;
        var rs2 = al === 0 ? 100 : ag / al;
        o[i] = 100 - 100 / (1 + rs2);
      }
    }
    return o;
  }
  function litPeriod(node) {
    if (!node || node.k !== "num") throw new Error("Period must be a number, e.g. SMA(close, 20)");
    return node.v;
  }
  function evalAst(node, dataList) {
    var n = dataList.length;
    if (node.k === "num") return node.v;
    if (node.k === "id") {
      if (!srcKey(node.v)) throw new Error("Unknown series: " + node.v);
      return dataList.map(function (d) { return barSrc(d, node.v); });
    }
    if (node.k === "unary") {
      var a = evalAst(node.a, dataList);
      if (!Array.isArray(a)) return -a;
      return a.map(function (v) { return v == null ? null : -v; });
    }
    if (node.k === "binop") {
      var left = evalAst(node.a, dataList);
      var right = evalAst(node.b, dataList);
      var op = node.op;
      return bin(left, right, function (x, y) {
        if (op === "+") return x + y;
        if (op === "-") return x - y;
        if (op === "*") return x * y;
        if (op === "/") return y === 0 ? null : x / y;
        if (op === "^") return Math.pow(x, y);
        if (op === ">") return x > y ? 1 : 0;
        if (op === "<") return x < y ? 1 : 0;
        if (op === ">=") return x >= y ? 1 : 0;
        if (op === "<=") return x <= y ? 1 : 0;
        if (op === "==") return x === y ? 1 : 0;
        if (op === "!=") return x !== y ? 1 : 0;
        return null;
      });
    }
    if (node.k === "call") {
      var fn = node.name;
      var args = node.args;
      if (fn === "abs") {
        var s = evalAst(args[0], dataList);
        return Array.isArray(s) ? s.map(function (v) { return v == null ? null : Math.abs(v); }) : Math.abs(s);
      }
      if (fn === "max" || fn === "min") {
        if (args.length < 2) throw new Error(fn.toUpperCase() + " needs two arguments");
        return bin(evalAst(args[0], dataList), evalAst(args[1], dataList), fn === "max" ? Math.max : Math.min);
      }
      if (fn === "if") {
        if (args.length < 3) throw new Error("IF(cond, a, b) needs 3 arguments");
        var cond = asArr(evalAst(args[0], dataList), n);
        var t = asArr(evalAst(args[1], dataList), n);
        var f = asArr(evalAst(args[2], dataList), n);
        return cond.map(function (c, i) { return c ? t[i] : f[i]; });
      }
      if (fn === "sma" || fn === "wma" || fn === "stdev" || fn === "hhv" || fn === "llv" || fn === "sum" || fn === "ema" || fn === "rsi" || fn === "ref" || fn === "change") {
        var src = asArr(evalAst(args[0], dataList), n);
        var per = litPeriod(args[1] || { k: "num", v: 1 });
        if (fn === "ema") return ema(src, per);
        if (fn === "rsi") return rsi(src, per);
        if (fn === "ref") {
          var o = new Array(n);
          for (var i = 0; i < n; i++) o[i] = i >= per ? src[i - per] : null;
          return o;
        }
        if (fn === "change") {
          var o2 = new Array(n);
          for (var i2 = 0; i2 < n; i2++) {
            o2[i2] = (i2 >= per && src[i2] != null && src[i2 - per] != null) ? src[i2] - src[i2 - per] : null;
          }
          return o2;
        }
        if (fn === "sma") return rolling(src, per, function (w) { return w.reduce(function (a, b) { return a + b; }, 0) / w.length; });
        if (fn === "sum") return rolling(src, per, function (w) { return w.reduce(function (a, b) { return a + b; }, 0); });
        if (fn === "hhv") return rolling(src, per, function (w) { return Math.max.apply(null, w); });
        if (fn === "llv") return rolling(src, per, function (w) { return Math.min.apply(null, w); });
        if (fn === "stdev") return rolling(src, per, function (w) {
          var m = w.reduce(function (a, b) { return a + b; }, 0) / w.length;
          var v = w.reduce(function (a, b) { return a + (b - m) * (b - m); }, 0) / w.length;
          return Math.sqrt(v);
        });
        if (fn === "wma") return rolling(src, per, function (w) {
          var num = 0, den = 0;
          for (var i = 0; i < w.length; i++) { num += w[i] * (i + 1); den += (i + 1); }
          return num / den;
        });
      }
      throw new Error("Unknown function: " + fn.toUpperCase());
    }
    throw new Error("Invalid formula");
  }
  function evalFormula(src, dataList) {
    var ast = parseFormula(src);
    var out = evalAst(ast, dataList);
    return asArr(out, dataList.length);
  }

  function fmtReplayClock(ts) {
    if (ts == null) return "";
    try {
      return new Intl.DateTimeFormat("en-IN", {
        timeZone: IST_TZ,
        day: "2-digit",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false
      }).format(new Date(ts));
    } catch (_) {
      return new Date(ts).toISOString().slice(0, 16).replace("T", " ");
    }
  }

  function stopReplayTimer() {
    if (_replay.timer) {
      clearInterval(_replay.timer);
      _replay.timer = null;
    }
    _replay.playing = false;
  }

  function updateReplayUi() {
    var bar = document.getElementById("chart-replay-bar");
    var hint = document.getElementById("chart-replay-hint");
    var btn = document.getElementById("btn-chart-replay");
    var badge = document.getElementById("replay-badge");
    var pickBtn = document.getElementById("replay-pick");
    var playBtn = document.getElementById("replay-play");
    var speedBtn = document.getElementById("replay-speed");
    var clock = document.getElementById("replay-clock");
    var pos = document.getElementById("replay-pos");
    var showBar = _replay.active;
    if (bar) {
      bar.classList.toggle("hidden", !showBar);
      bar.setAttribute("aria-hidden", showBar ? "false" : "true");
    }
    if (hint) hint.classList.toggle("hidden", !_replay.picking);
    if (chartStage) chartStage.classList.toggle("replay-picking", !!_replay.picking);
    if (btn) btn.classList.toggle("active", !!(_replay.active || _replay.picking));
    if (pickBtn) pickBtn.classList.toggle("active", !!_replay.picking);
    if (badge) badge.style.display = _replay.active && !_replay.picking ? "inline-flex" : "none";
    if (speedBtn) speedBtn.textContent = _replay.speed + "x ▾";
    if (playBtn) {
      playBtn.title = _replay.playing ? "Pause" : "Play";
      playBtn.innerHTML = _replay.playing
        ? "<svg viewBox=\"0 0 16 16\" aria-hidden=\"true\"><path d=\"M5 3.5h2.2v9H5zm3.8 0H11v9H8.8z\" fill=\"currentColor\"/></svg>"
        : "<svg viewBox=\"0 0 16 16\" aria-hidden=\"true\"><path d=\"M5 3.5v9l8-4.5z\" fill=\"currentColor\"/></svg>";
    }
    var vis = visibleRawBars();
    var last = vis.length ? vis[vis.length - 1] : null;
    if (clock) clock.textContent = last ? fmtReplayClock(last.timestamp) : "";
    if (pos) {
      pos.textContent = _replay.active
        ? (_replay.index + 1) + " / " + _rawBars.length
        : "";
    }
  }

  function applyReplaySlice(opts) {
    if (!chart) return;
    var shown = displaySeries(visibleRawBars());
    if (!shown.length) return;
    var snap = (opts && opts.snap) || ((opts && opts.keepView === false) ? null : (captureChartView() || _replay.viewSnap));
    if (opts && opts.step) {
      chart.updateData(shown[shown.length - 1]);
      if (opts.follow) ensureReplayHeadVisible();
      syncPrevClose();
      refreshLiveQuote();
      updateChartLegendValues();
      schedulePyRefresh();
      updateReplayUi();
      return;
    }
    applyChartData(shown, _histMore, function () {
      restoreChartView(snap);
      syncPrevClose();
      refreshLiveQuote();
      updateChartLegendValues();
      schedulePyRefresh(!!(opts && opts.pyImmediate) || pythonCoverageStale());
      updateReplayUi();
    });
  }

  function ensureReplayHeadVisible() {
    if (!chart || !chartContainer) return;
    var vis = visibleRawBars();
    if (!vis.length) return;
    var last = vis[vis.length - 1];
    var raw = chart.convertToPixel({ timestamp: last.timestamp }, { paneId: "candle_pane" });
    var pt = Array.isArray(raw) ? raw[0] : raw;
    if (!pt || !isFinite(pt.x)) return;
    var w = chartContainer.clientWidth || 0;
    var rightLimit = Math.max(80, w - 72);
    var leftLimit = 48;
    if (pt.x > rightLimit && chart.scrollByDistance) chart.scrollByDistance(rightLimit - pt.x, 0);
    else if (pt.x < leftLimit && chart.scrollByDistance) chart.scrollByDistance(leftLimit - pt.x, 0);
  }

  function setReplayIndex(idx, opts) {
    if (!_rawBars.length) return;
    idx = Math.max(0, Math.min(_rawBars.length - 1, idx | 0));
    var prev = _replay.index;
    var step = !!(opts && opts.step && _replay.active && !_replay.picking && idx === prev + 1);
    _replay.active = true;
    _replay.picking = false;
    _replay.index = idx;
    applyReplaySlice({ step: step, follow: !!(opts && opts.follow), snap: opts && opts.snap, pyImmediate: !step });
    if (idx >= _rawBars.length - 1) pauseReplay();
  }

  function pauseReplay() {
    stopReplayTimer();
    updateReplayUi();
  }

  function playReplay() {
    if (!_replay.active || _replay.picking) return;
    if (_replay.index >= _rawBars.length - 1) return;
    stopReplayTimer();
    _replay.playing = true;
    updateReplayUi();
    _replay.timer = setInterval(function () {
      if (!_replay.active || _replay.picking) {
        pauseReplay();
        return;
      }
      if (_replay.index >= _rawBars.length - 1) {
        pauseReplay();
        return;
      }
      setReplayIndex(_replay.index + 1, { step: true, follow: true });
    }, Math.max(70, Math.round(700 / Math.max(1, _replay.speed))));
  }

  function toggleReplayPlay() {
    if (_replay.playing) pauseReplay();
    else playReplay();
  }

  function beginReplayPick() {
    if (!chart || !_rawBars.length) {
      if (chartMessage) {
        chartMessage.textContent = "Load a chart first, then start replay.";
        chartMessage.style.display = "flex";
      }
      return;
    }
    pauseReplay();
    _replay.picking = true;
    unsubscribeLive();
    stopAutoRefresh();
    if (_replay.active) {
      var snap = rememberChartView();
      applyChartData(displaySeries(_rawBars), _histMore, function () {
        restoreChartView(snap);
        schedulePyRefresh();
      });
    }
    setActiveDraw("cursor");
    updateReplayUi();
  }

  function cancelReplayPick() {
    _replay.picking = false;
    if (_replay.active) {
      applyReplaySlice();
      return;
    }
    if (selectedInstrument && activeBroker === "5paisa") subscribeLive();
    startAutoRefresh();
    updateReplayUi();
  }

  function startReplayAt(idx, snap) {
    if (idx == null || !_rawBars.length) return;
    pauseReplay();
    unsubscribeLive();
    stopAutoRefresh();
    _replay.startIndex = idx;
    setReplayIndex(idx, { snap: snap || snapForBar(idx) });
  }

  function snapForBar(idx, clientX) {
    if (!_rawBars[idx]) return null;
    var ts = _rawBars[idx].timestamp;
    var anchorX = null;
    try {
      var raw = chart.convertToPixel({ timestamp: ts, dataIndex: idx }, { paneId: "candle_pane" });
      var pt = Array.isArray(raw) ? raw[0] : raw;
      if (pt && isFinite(pt.x)) anchorX = pt.x;
    } catch (_) {}
    if (anchorX == null && clientX != null && chartContainer) {
      anchorX = clientX - chartContainer.getBoundingClientRect().left;
    }
    if (anchorX == null || ts == null) return captureChartView();
    return { space: chartBarSpace(), anchorTs: ts, anchorX: anchorX };
  }

  function consumeReplayPick(idx, clientX) {
    if (!_replay.picking || idx == null || idx < 0) return;
    var now = Date.now();
    if (now - (_replay.pickAt || 0) < 250) return;
    _replay.pickAt = now;
    startReplayAt(idx, snapForBar(idx, clientX));
  }

  function exitReplay(restore) {
    var wasActive = _replay.active || _replay.picking;
    var snap = rememberChartView();
    pauseReplay();
    _replay.active = false;
    _replay.picking = false;
    _replay.index = -1;
    if (chartStage) chartStage.classList.remove("replay-picking");
    if (restore && wasActive && chart && _rawBars.length) {
      applyChartData(displaySeries(_rawBars), _histMore, function () {
        restoreChartView(snap);
        syncPrevClose();
        refreshLiveQuote();
        resyncIndicatorsAfterReplay();
      });
    }
    if (restore && selectedInstrument) {
      if (activeBroker === "5paisa") subscribeLive();
      startAutoRefresh();
    }
    updateReplayUi();
  }

  function barIndexFromPointer(e) {
    if (!chart || !e) return null;
    var rect = chartContainer.getBoundingClientRect();
    var p = pointFromPixel({ x: e.clientX - rect.left, y: e.clientY - rect.top });
    if (!p) return null;
    var ts = p.timestamp;
    if (ts == null && p.dataIndex != null) {
      var list = [];
      try { list = chart.getDataList() || []; } catch (_) {}
      if (list[p.dataIndex]) ts = list[p.dataIndex].timestamp;
    }
    if (ts == null) return null;
    var idx = timestampIndex(ts, _rawBars);
    return idx >= 0 ? idx : null;
  }

  function renderReplaySpeedPop() {
    var pop = document.getElementById("replay-speed-pop");
    if (!pop) return;
    pop.innerHTML = REPLAY_SPEEDS.map(function (s) {
      return "<button type=\"button\" class=\"chart-pop-row" + (s === _replay.speed ? " on" : "") + "\" data-rspeed=\"" + s + "\">" + s + "x</button>";
    }).join("");
    pop.querySelectorAll("[data-rspeed]").forEach(function (b) {
      b.addEventListener("click", function (e) {
        e.stopPropagation();
        _replay.speed = Number(b.getAttribute("data-rspeed")) || 1;
        pop.classList.add("hidden");
        if (_replay.playing) playReplay();
        else updateReplayUi();
      });
    });
  }

  function bindReplayPointer(container) {
    if (!container || container._replayPtrBound) return;
    container._replayPtrBound = true;
    container.addEventListener("pointerdown", function (e) {
      if (!_replay.picking) return;
      if (e.button != null && e.button !== 0) return;
      _replay.ptr = { x: e.clientX, y: e.clientY };
      _replay.dragged = false;
    });
    container.addEventListener("pointermove", function (e) {
      if (!_replay.ptr) return;
      var dx = e.clientX - _replay.ptr.x;
      var dy = e.clientY - _replay.ptr.y;
      if (dx * dx + dy * dy > 36) _replay.dragged = true;
    });
    container.addEventListener("pointerup", function (e) {
      if (!_replay.picking) {
        _replay.ptr = null;
        _replay.dragged = false;
        return;
      }
      var dragged = !!_replay.dragged;
      _replay.ptr = null;
      if (dragged) return;
      if (e.target.closest && (e.target.closest("#chart-nav") || e.target.closest("#chart-replay-bar"))) return;
      consumeReplayPick(barIndexFromPointer(e), e.clientX);
    });
  }

  function bindReplayControls() {
    var btn = document.getElementById("btn-chart-replay");
    if (btn) {
      btn.addEventListener("click", function () {
        if (_replay.active || _replay.picking) exitReplay(true);
        else beginReplayPick();
      });
    }
    var pick = document.getElementById("replay-pick");
    if (pick) pick.addEventListener("click", function () {
      beginReplayPick();
    });
    var back = document.getElementById("replay-back");
    if (back) back.addEventListener("click", function () {
      if (!_replay.active) return;
      pauseReplay();
      setReplayIndex(_replay.index - 1);
    });
    var fwd = document.getElementById("replay-fwd");
    if (fwd) fwd.addEventListener("click", function () {
      if (!_replay.active) return;
      pauseReplay();
      setReplayIndex(_replay.index + 1, { step: true });
    });
    var play = document.getElementById("replay-play");
    if (play) play.addEventListener("click", function () {
      if (!_replay.active) return;
      toggleReplayPlay();
    });
    var speedBtn = document.getElementById("replay-speed");
    var speedPop = document.getElementById("replay-speed-pop");
    if (speedBtn && speedPop) {
      speedBtn.addEventListener("click", function (e) {
        e.stopPropagation();
        renderReplaySpeedPop();
        speedPop.classList.toggle("hidden");
      });
    }
    var exitBtn = document.getElementById("replay-exit");
    if (exitBtn) exitBtn.addEventListener("click", function () { exitReplay(true); });
    bindReplayPointer(chartContainer);
    document.addEventListener("keydown", function (e) {
      if (!_replay.active && !_replay.picking) return;
      if (isTypingTarget(e.target)) return;
      if (e.key === "Escape") {
        e.preventDefault();
        if (_replay.picking) cancelReplayPick();
        else exitReplay(true);
      } else if (e.key === " " && _replay.active && !_replay.picking) {
        e.preventDefault();
        toggleReplayPlay();
      } else if (e.key === "ArrowRight" && _replay.active && !_replay.picking) {
        e.preventDefault();
        pauseReplay();
        setReplayIndex(_replay.index + 1, { step: true });
      } else if (e.key === "ArrowLeft" && _replay.active && !_replay.picking) {
        e.preventDefault();
        pauseReplay();
        setReplayIndex(_replay.index - 1);
      }
    });
    updateReplayUi();
  }

  registerDrawingOverlays();
  try {
    registerLocalInd("VWAP", "VWAP");
    registerLocalInd("SuperTrend", "SuperTrend");
  } catch (_) {}
  loadCustomDefs().forEach(function (d) {
    try { registerCustom(d); } catch (_) {}
  });

  /* Initialize chart slots (must run after all vars are declared). */
  initSlots();
  if (activeSlot > 0) _useSlot(0);
  requestAnimationFrame(function () {
    if (typeof window._chartResize === "function") window._chartResize();
  });

  /* Split control: open/close popup, close sibling menus. */
  var splitBtn = document.getElementById("btn-split");
  if (splitBtn) {
    splitBtn.addEventListener("click", function (e) {
      e.stopPropagation();
      renderSplitPop();
      var pop = document.getElementById("split-pop");
      if (!pop) return;
      var opening = pop.classList.contains("hidden");
      pop.classList.toggle("hidden");
      var tp = document.getElementById("candle-type-pop");
      if (opening) {
        closeIndPicker();
        if (tp) tp.classList.add("hidden");
      }
    });
  }

  /* Clicking a chart slot makes it the active (selected) chart.
     Use capture so we switch/cancel draws before the inactive chart handles the pointer. */
  var stageHost = document.getElementById("chart-stage");
  if (stageHost) {
    stageHost.addEventListener("pointerdown", function (e) {
      var wrap = e.target && e.target.closest ? e.target.closest(".chart-slot") : null;
      if (!wrap) return;
      var idx = parseInt(wrap.getAttribute("data-slot"), 10);
      if (!isFinite(idx) || idx < 0 || idx >= splitCount) return;
      if (idx === activeSlot) return;
      setActiveSlot(idx);
    }, true);
  }

  loadActiveInds().forEach(function (item) {
    if (!item) return;
    if (item.kind === "custom") {
      var def = loadCustomDefs().filter(function (d) { return d.id === item.id; })[0];
      activeIndicators.push({
        kind: "custom",
        id: item.id,
        uid: item.uid,
        name: (def && def.name) || item.name || "Custom",
        overlay: item.overlay,
        indName: item.id ? customIndName(item.id, item.uid) : undefined,
        color: item.color,
        visible: item.visible !== false
      });
      return;
    }
    if (item.kind === "python") {
      activeIndicators.push({
        kind: "python",
        id: item.id,
        uid: item.uid,
        name: item.name || item.id,
        calcParams: item.calcParams,
        params: item.params,
        overlay: true,
        color: item.color || "#f85149",
        visible: item.visible !== false,
        pyOverlayIds: []
      });
      return;
    }
    var spec = specOf(item.name);
    if (!IND_SPECS[item.name]) return;
    activeIndicators.push({
      kind: "builtin",
      name: item.name,
      uid: item.uid,
      calcParams: item.name === "VOL" ? [] : ((item.calcParams && item.calcParams.length) ? item.calcParams.slice() : defaultParams(item.name)),
      color: item.color,
      overlay: item.name === "VOL" ? true : (item.overlay != null ? item.overlay : !!spec.overlay),
      visible: item.visible !== false
    });
  });
  var _drawRailExpanded = storageGet(LS_DRAW_RAIL, false) === true;
  applyDrawRailExpanded(_drawRailExpanded);
  var drawRailToggle = document.getElementById("btn-draw-rail-toggle");
  if (drawRailToggle) {
    drawRailToggle.addEventListener("click", function () {
      _drawRailExpanded = !_drawRailExpanded;
      applyDrawRailExpanded(_drawRailExpanded);
      storageSet(LS_DRAW_RAIL, _drawRailExpanded);
    });
  }
  renderDrawTools();
  renderIndicatorPop();
  renderCustomPop();
  bindChartNav();
  bindReplayControls();
  loadPyCatalog();
  syncChartBrokerTabs();
  updateSlotTickers();
  /* After layout/meta restore, load all saved charts once brokers are ready. */
  setTimeout(function () {
    refreshVisibleSlots();
  }, 250);
  window.addEventListener("beforeunload", function () {
    chartSlots.forEach(function (s, i) {
      if (i >= splitCount || !s.chart) return;
      _useSlot(i);
      persistOverlays();
    });
    _useSlot(activeSlot >= splitCount ? 0 : activeSlot);
  });
})();
