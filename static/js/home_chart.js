/* ── Home Chart (KLineChart) — drawings, built-in + custom indicators ── */
(function () {
  var IST_TZ = "Asia/Kolkata";
  var LS_CUSTOM = "traderapp.chart.customInds";
  var LS_OVERLAYS = "traderapp.chart.overlays";
  var LS_INDS = "traderapp.chart.activeInds";
  var LS_LEGEND = "traderapp.chart.legendExpanded";
  var LS_CTYPE = "traderapp.chart.candleType";
  var LS_PY_DEFAULTS = "traderapp.chart.pyIndDefaults";

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
  var EXCEL_IND_COLORS = ["#58a6ff", "#f0883e", "#3fb950", "#d2a8ff", "#f85149", "#79c0ff", "#ffa657", "#7ee787"];
  var selectedOverlayId = null;
  var pendingTextId = null;
  var pendingTextPrev = "";
  var pendingTextIsNew = false;
  var pendingRectId = null;
  var activeDraw = "cursor";
  var magnetOn = true;
  var activeIndicators = [];
  var editingCustomId = null;
  var editingIndIdx = null;
  var pendingIndName = null;
  var _indSearch = "";
  var _indFocusIdx = -1;
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

  var OVERLAY_INDS = { MA: 1, EMA: 1, SMA: 1, BBI: 1, BOLL: 1, SAR: 1, AVP: 1, VWAP: 1, SuperTrend: 1 };
  var LOCAL_INDS = { VWAP: 1, SuperTrend: 1 };
  var PANE_INDS = ["VOL", "MACD", "KDJ", "RSI", "WR", "CCI", "DMI", "OBV", "ROC", "MTM", "AO", "BIAS", "TRIX", "DMA", "PSY", "VR", "EMV", "CR", "BRAR", "PVT"];
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
    VOL:  { overlay: false, params: [] },
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
    { name: "cursor", label: "Cursor" },
    { name: "segment", label: "Trend" },
    { name: "rayLine", label: "Ray" },
    { name: "straightLine", label: "Line" },
    { name: "horizontalStraightLine", label: "H-Line" },
    { name: "verticalStraightLine", label: "V-Line" },
    { name: "priceLine", label: "Price" },
    { name: "parallelStraightLine", label: "Parallel" },
    { name: "priceChannelLine", label: "Channel" },
    { name: "tvRect", label: "Rectangle", title: "Rectangle" },
    { name: "tvMeasure", label: "Measure", title: "Measure bars, price and %" },
    { name: "tvLongPosition", label: "Long", title: "Long position: click entry, target, then stop" },
    { name: "tvShortPosition", label: "Short", title: "Short position: click entry, target, then stop" },
    { name: "tvText", label: "Text", title: "Text note" },
    { name: "circle", label: "Circle" },
    { name: "triangle", label: "Triangle" },
    { name: "fibonacciLine", label: "Fib" },
    { name: "fibonacciExtension", label: "Fib Ext" },
    { name: "fibonacciSegment", label: "Fib Seg" },
    { name: "fibonacciCircle", label: "Fib Cir" },
    { name: "fibonacciSpeedResistanceFan", label: "Fib Fan" },
    { name: "gannBox", label: "Gann" }
  ];

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
  var liveQuoteEl = document.getElementById("chart-live-quote");
  var ohlcEl = document.getElementById("chart-ohlc");
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
  _legendExpanded = storageGet(LS_LEGEND, true) !== false;
  var _drawingCache = {};
  var _loadedDrawKey = "";
  var _saveDrawTimer = null;

  function chartKey() {
    if (!selectedInstrument) return "";
    var inst = selectedInstrument;
    var id = String(inst.scrip_code != null ? inst.scrip_code : (inst.security_id != null ? inst.security_id : ""));
    var sym = String(inst.trading_symbol || "").toUpperCase();
    var exch = String(inst.exch || inst.exchange_segment || "").toUpperCase();
    return [activeBroker, exch, sym, id].join("|");
  }
  function legacyChartKeys() {
    if (!selectedInstrument) return [];
    var inst = selectedInstrument;
    var id = String(inst.scrip_code || inst.security_id || inst.trading_symbol || "");
    return [activeBroker + ":" + id];
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
      _refreshTimer = setInterval(function () {
        if (selectedInstrument && chart && !replayFrozen()) loadChartData(true);
      }, iv);
    }
  }
  function stopAutoRefresh() {
    if (_refreshTimer) { clearInterval(_refreshTimer); _refreshTimer = null; }
  }

  window._chartSetRefreshInterval = function (ms) {
    _refreshInterval = ms;
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

  function chartDataList() {
    if (!chart) return [];
    try { return chart.getDataList() || []; } catch (_) { return []; }
  }

  function visibleBarRange(listLen) {
    var from = 0;
    var to = Math.max(0, (listLen | 0) - 1);
    try {
      var vr = chart && chart.getVisibleRange && chart.getVisibleRange();
      if (vr && isFinite(vr.from) && isFinite(vr.to)) {
        from = Math.max(0, Math.floor(Number(vr.from)));
        to = Math.min(to, Math.ceil(Number(vr.to)));
      }
    } catch (_) {}
    if (to < from) to = from;
    return { from: from, to: to };
  }

  function panePoint(ts, value, dataIndex, xAxis, yAxis) {
    var di = dataIndex;
    if ((di == null || !isFinite(di)) && ts != null) {
      di = timestampIndex(ts, chartDataList());
    }
    if (chart && chart.convertToPixel && (ts != null || (di != null && isFinite(di)))) {
      try {
        var spec = { value: value };
        if (ts != null && isFinite(Number(ts))) spec.timestamp = Number(ts);
        if (di != null && isFinite(di) && di >= 0) spec.dataIndex = di;
        var raw = chart.convertToPixel(spec, { paneId: "candle_pane" });
        var pt = Array.isArray(raw) ? raw[0] : raw;
        if (pt && isFinite(pt.x) && isFinite(pt.y)) return { x: pt.x, y: pt.y };
      } catch (_) {}
    }
    var x = null;
    var y = null;
    if (xAxis && di != null && isFinite(di)) x = xAxis.convertToPixel(di);
    if (yAxis && value != null && isFinite(Number(value))) y = yAxis.convertToPixel(Number(value));
    if (isFinite(x) && isFinite(y)) return { x: x, y: y };
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
    if (!chart) return;
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
  }

  function updateLiveQuote(price) {
    if (!liveQuoteEl) return;
    price = Number(price);
    if (!isFinite(price)) {
      liveQuoteEl.innerHTML = "";
      return;
    }
    var cls = "";
    var chgHtml = "";
    if (_prevClose != null && isFinite(_prevClose) && _prevClose !== 0) {
      var ch = price - _prevClose;
      var pct = (ch / Math.abs(_prevClose)) * 100;
      cls = ch > 0 ? "up" : (ch < 0 ? "down" : "flat");
      var sign = ch > 0 ? "+" : "";
      chgHtml = "<span class=\"chart-live-chg " + cls + "\">" + sign + fmtPx(ch) + " (" + sign + pct.toFixed(2) + "%)</span>";
    }
    liveQuoteEl.innerHTML = "<span class=\"chart-live-last" + (cls ? " " + cls : "") + "\">" + fmtPx(price) + "</span>" + chgHtml;
  }

  function refreshLiveQuote() {
    var bars = visibleRawBars();
    if (!bars.length) {
      updateLiveQuote(NaN);
      return;
    }
    updateLiveQuote(bars[bars.length - 1].close);
  }

  function klineStyles() {
    var th = window._getChartTheme ? window._getChartTheme() : { bg: "#0d1117", text: "#8b949e", grid: "#21262d", border: "#30363d" };
    var spec = currentTypeSpec();
    var lineColor = "#58a6ff";
    var isLine = !!spec.line;
    return {
      grid: {
        show: true,
        horizontal: { show: true, size: 1, color: th.grid, style: "dashed" },
        vertical: { show: true, size: 1, color: th.grid, style: "dashed" }
      },
      candle: {
        type: spec.ktype,
        bar: {
          upColor: "#3fb950", downColor: "#f85149", noChangeColor: "#8b949e",
          upBorderColor: "#3fb950", downBorderColor: "#f85149", noChangeBorderColor: "#8b949e",
          upWickColor: "#3fb950", downWickColor: "#f85149", noChangeWickColor: "#8b949e"
        },
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
          last: { upColor: "#3fb950", downColor: "#f85149", noChangeColor: "#8b949e" }
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

  window._chartApplyTheme = function () {
    if (!chart) return;
    if (chartContainer) chartContainer.style.background = (window._getChartTheme() || {}).bg || "";
    chart.setStyles(klineStyles());
    try { chart.resize(); } catch (_) {}
  };

  function candleTypeIcon(id) {
    var g = "#3fb950";
    var r = "#f85149";
    var b = "#58a6ff";
    if (id === "candle_solid") {
      return "<svg viewBox=\"0 0 22 16\" fill=\"none\"><path d=\"M6 2v12M5 5h2v6H5z\" stroke=\"" + g + "\" stroke-width=\"1.4\" fill=\"" + g + "\"/><path d=\"M16 1v14M15 4h2v8h-2z\" stroke=\"" + r + "\" stroke-width=\"1.4\" fill=\"" + r + "\"/></svg>";
    }
    if (id === "candle_up_stroke") {
      return "<svg viewBox=\"0 0 22 16\" fill=\"none\"><path d=\"M6 2v12\" stroke=\"" + g + "\" stroke-width=\"1.4\"/><rect x=\"5\" y=\"5\" width=\"2\" height=\"6\" stroke=\"" + g + "\" stroke-width=\"1.2\" fill=\"none\"/><path d=\"M16 1v14M15 4h2v8h-2z\" stroke=\"" + r + "\" stroke-width=\"1.4\" fill=\"" + r + "\"/></svg>";
    }
    if (id === "candle_stroke") {
      return "<svg viewBox=\"0 0 22 16\" fill=\"none\"><path d=\"M6 2v12\" stroke=\"" + g + "\" stroke-width=\"1.4\"/><rect x=\"5\" y=\"5\" width=\"2\" height=\"6\" stroke=\"" + g + "\" stroke-width=\"1.2\" fill=\"none\"/><path d=\"M16 1v14\" stroke=\"" + r + "\" stroke-width=\"1.4\"/><rect x=\"15\" y=\"4\" width=\"2\" height=\"8\" stroke=\"" + r + "\" stroke-width=\"1.2\" fill=\"none\"/></svg>";
    }
    if (id === "candle_down_stroke") {
      return "<svg viewBox=\"0 0 22 16\" fill=\"none\"><path d=\"M6 2v12M5 5h2v6H5z\" stroke=\"" + g + "\" stroke-width=\"1.4\" fill=\"" + g + "\"/><path d=\"M16 1v14\" stroke=\"" + r + "\" stroke-width=\"1.4\"/><rect x=\"15\" y=\"4\" width=\"2\" height=\"8\" stroke=\"" + r + "\" stroke-width=\"1.2\" fill=\"none\"/></svg>";
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
    btn.textContent = currentTypeSpec().label + " ▾";
    btn.title = "Chart type: " + currentTypeSpec().label;
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
    storageSet(LS_CTYPE, _candleType);
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
        if (!chart || !candle) return;
        upsertRawBar({
          timestamp: candle.time * 1000,
          open: candle.open, high: candle.high, low: candle.low, close: candle.close,
          volume: candle.volume || 0
        });
        if (replayFrozen()) return;
        var bar = lastDisplayBar();
        if (bar) chart.updateData(bar);
        updateLiveQuote(candle.close);
        var dot = document.getElementById("live-dot");
        if (dot) { dot.classList.add("pulse"); setTimeout(function () { dot.classList.remove("pulse"); }, 400); }
        updateChartLegendValues();
        schedulePyRefresh();
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
    var t = document.getElementById("live-badge");
    if (t) t.style.display = "inline-flex";
  }
  function unsubscribeLive() {
    if (!_liveSub) return;
    if (_socket) _socket.emit("unsubscribe_live");
    _liveSub = false;
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
      selectedInstrument = null;
      if (searchInput) searchInput.value = "";
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
      selectedInstrument = null;
      if (searchInput) searchInput.value = "";
      if (dropdown) {
        dropdown.innerHTML = "";
        dropdown.classList.add("hidden");
      }
      return;
    }
    if (connected && selectedInstrument) loadChartData();
  };

  if (intervalGroup) {
    intervalGroup.addEventListener("click", function (e) {
      var btn = e.target.closest(".ivl-btn");
      if (!btn || !intervalGroup.contains(btn)) return;
      intervalGroup.querySelectorAll(".ivl-btn").forEach(function (b) { b.classList.remove("active"); });
      btn.classList.add("active");
      activeInterval = btn.dataset.ivl;
      if (selectedInstrument) loadChartData();
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
      selectedInstrument = null;
      if (searchInput) searchInput.value = "";
      if (dropdown) {
        dropdown.innerHTML = "";
        dropdown.classList.add("hidden");
      }
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
      var ip = document.getElementById("ind-pop");
      var cp = document.getElementById("custom-pop");
      var tp = document.getElementById("candle-type-pop");
      var sp = document.getElementById("replay-speed-pop");
      if (ip) ip.classList.add("hidden");
      if (cp) cp.classList.add("hidden");
      if (tp) tp.classList.add("hidden");
      if (sp) sp.classList.add("hidden");
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
          selectedInstrument = item;
          searchInput.value = sym + " \u2014 " + item.name;
          dropdown.classList.add("hidden");
        });
        dropdown.appendChild(li);
      });
      dropdown.classList.remove("hidden");
    } catch (_) {}
  }

  loadBtn.addEventListener("click", function () {
    if (!selectedInstrument) {
      chartMessage.textContent = "Please search and select a stock first.";
      chartMessage.style.display = "flex";
      return;
    }
    loadChartData();
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
    overlayIds = [];
    _excelOverlayIds = [];
    _chartGen += 1;
    chartContainer.innerHTML = "";
    chartMessage.style.display = "none";
    chartContainer.style.display = "block";
    chart = klinecharts.init(chartContainer, {
      locale: "en-US",
      timezone: IST_TZ,
      styles: klineStyles()
    });
    bindHistoryLoader();
    _pyCoveredN = 0;
    _pyCoveredFirst = null;
    chart.subscribeAction("onCrosshairChange", function (data) {
      var d = data && (data.kLineData || data.data);
      if (!d || d.close == null) {
        ohlcEl.innerHTML = "";
        _legendIndex = null;
        updateChartLegendValues();
        return;
      }
      ohlcEl.innerHTML =
        "<span class=\"ohlc-o\">O <b>" + Number(d.open).toFixed(2) + "</b></span>" +
        "<span class=\"ohlc-h\">H <b>" + Number(d.high).toFixed(2) + "</b></span>" +
        "<span class=\"ohlc-l\">L <b>" + Number(d.low).toFixed(2) + "</b></span>" +
        "<span class=\"ohlc-c\">C <b>" + Number(d.close).toFixed(2) + "</b></span>" +
        (d.volume ? "<span class=\"ohlc-v\">V <b>" + Number(d.volume).toLocaleString() + "</b></span>" : "");
      _legendIndex = data.dataIndex != null ? data.dataIndex : (data.realDataIndex != null ? data.realDataIndex : null);
      updateChartLegendValues();
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
        if (pythonCoverageStale()) schedulePyRefresh(true);
      });
    } catch (_) {}
    if (!chartContainer._ro) {
      chartContainer._ro = new ResizeObserver(function () {
        if (!chart || chartContainer._resizing) return;
        chartContainer._resizing = true;
        try { chart.resize(); } finally {
          requestAnimationFrame(function () { chartContainer._resizing = false; });
        }
      });
      chartContainer._ro.observe(chartContainer);
    }
  }

  window._chartResize = function () {
    if (!chart) return;
    var snap = captureChartView() || _replay.viewSnap;
    try { chart.resize(); } catch (_) {}
    restoreChartView(snap);
  };

  window._chartOnHomeHidden = function () {
    rememberChartView();
  };

  window._chartOnHomeShown = function () {
    var snap = _replay.viewSnap || captureChartView();
    if (chart) {
      try { chart.resize(); } catch (_) {}
    }
    restoreChartView(snap);
    if (_replay.picking || _replay.active) updateReplayUi();
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
        var list = chartDataList();
        if (!list.length) return [];
        var range = visibleBarRange(list.length);
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
            pt = panePoint(ts, v, i, xAxis, yAxis);
            if (!pt) continue;
            coords.push(pt);
            lastI = i;
          }
          if (lastI < to && list[to]) {
            ts = list[to].timestamp;
            v = map ? map[ts] : vals[to];
            if (v != null && isFinite(v)) {
              pt = panePoint(ts, v, to, xAxis, yAxis);
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
                pt = panePoint(ts, cur, i, xAxis, yAxis);
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
        var list = chartDataList();
        var range = visibleBarRange(list.length);
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
          pt = panePoint(ts, v, di, xAxis, yAxis);
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
        selectedOverlayId = overlayIdFromEvent(ev);
      },
      onSelected: function (ev) {
        selectedOverlayId = overlayIdFromEvent(ev);
      },
      onDeselected: function () {
        selectedOverlayId = null;
      },
      onDrawEnd: function (ev) {
        setActiveDraw("cursor");
        var id = overlayIdFromEvent(ev);
        var name = overlayNameFromEvent(ev);
        setTimeout(function () {
          if (name === "tvText" && id) {
            ensureTextBox(id);
            persistOverlays();
            openTextModal(id, true);
            return;
          }
          persistOverlays();
          if (name === "tvRect" && id) openRectModal(id);
        }, 0);
      },
      onDoubleClick: function (ev) {
        var id = overlayIdFromEvent(ev);
        var name = overlayNameFromEvent(ev);
        if (name === "tvText" && id) openTextModal(id, false);
        if (name === "tvRect" && id) openRectModal(id);
        return false;
      },
      onPressedMoveEnd: function () { persistOverlays(); },
      onRemoved: function (ev) {
        var id = overlayIdFromEvent(ev);
        if (id) overlayIds = overlayIds.filter(function (x) { return x !== id; });
        if (selectedOverlayId === id) selectedOverlayId = null;
        persistOverlays();
      }
    };
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

  function persistOverlays() {
    var key = _loadedDrawKey || chartKey();
    if (!key) return;
    var saved = collectOverlays();
    _drawingCache[key] = saved;
    var all = storageGet(LS_OVERLAYS, {});
    all[key] = saved;
    storageSet(LS_OVERLAYS, all);
    clearTimeout(_saveDrawTimer);
    _saveDrawTimer = setTimeout(function () {
      fetch("/api/settings/chart-drawings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: key, overlays: saved })
      }).catch(function () {});
    }, 350);
  }

  function applyOverlayList(saved) {
    overlayIds = [];
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

  async function restoreOverlays() {
    if (!chart) return;
    overlayIds = [];
    selectedOverlayId = null;
    var key = chartKey();
    _loadedDrawKey = key;
    if (!key) return;
    var all = storageGet(LS_OVERLAYS, {});
    var saved = _drawingCache[key] || all[key] || [];
    if (!saved.length) {
      legacyChartKeys().forEach(function (lk) {
        if (!saved.length && all[lk] && all[lk].length) saved = all[lk];
      });
    }
    try {
      var res = await fetch("/api/settings/chart-drawings?key=" + encodeURIComponent(key));
      var data = await res.json();
      if (data && data.success && data.overlays && data.overlays.length) {
        saved = data.overlays;
      } else if (saved.length) {
        fetch("/api/settings/chart-drawings", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ key: key, overlays: saved })
        }).catch(function () {});
      }
    } catch (_) {}
    _drawingCache[key] = saved;
    applyOverlayList(saved);
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
    storageSet(LS_INDS, slim);
  }

  function loadActiveInds() {
    var raw = storageGet(LS_INDS, []);
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
    activeIndicators = [];
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
        overlay: item.overlay != null ? item.overlay : !!spec.overlay,
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
      overlay: spec.overlay
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
      var pop = document.getElementById("ind-pop");
      if (pop) pop.classList.add("hidden");
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
      var popS = document.getElementById("ind-pop");
      if (popS) popS.classList.add("hidden");
      var cpopS = document.getElementById("custom-pop");
      if (cpopS) cpopS.classList.add("hidden");
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
    var pop = document.getElementById("ind-pop");
    if (pop) pop.classList.add("hidden");
    var cpop = document.getElementById("custom-pop");
    if (cpop) cpop.classList.add("hidden");
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

  function registerCustom(def, uniqueName) {
    var plot = def.plot || "line";
    var color = def.color || "#58a6ff";
    var name = uniqueName || customIndName(def.id);
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
        var values;
        try { values = evalFormula(def.formula, dataList); }
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

  function pythonCoverageStale() {
    if (!hasPythonIndicators()) return false;
    var bars = visibleRawBars();
    if (!bars.length) return false;
    if (!_pyCoveredN) return true;
    if (bars[0].timestamp !== _pyCoveredFirst) return true;
    if (bars.length > _pyCoveredN) return true;
    return false;
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
      item.pyStats = data.stats || {};
      drawPythonZones(item, data.zones || []);
      updateChartLegendValues();
    }).catch(function () {});
  }

  function schedulePyRefresh(immediate) {
    clearTimeout(_pyRefreshTimer);
    var run = function () {
      markPythonCoverage();
      activeIndicators.forEach(function (item) {
        if (item.kind === "python") refreshPythonIndicator(item);
      });
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
    if (name === "cursor") { setActiveDraw("cursor"); return; }
    if (!chart) {
      chartMessage.textContent = "Load a chart first, then draw.";
      chartMessage.style.display = "flex";
      return;
    }
    setActiveDraw(name);
    var spec = Object.assign({ name: name }, overlayHooks());
    if (name === "tvText") spec.extendData = { text: "Text", color: overlayContrastText() };
    if (name === "tvRect") spec.extendData = { color: "#58a6ff", text: "" };
    var id = chart.createOverlay(spec, "candle_pane");
    if (id) overlayIds.push(id);
    else setActiveDraw("cursor");
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
      btn.textContent = t.label;
      btn.title = t.title || t.label;
      btn.addEventListener("click", function () { startDrawing(t.name); });
      host.appendChild(btn);
    });
    var mag = document.createElement("button");
    mag.type = "button";
    mag.className = "chart-tool-btn" + (magnetOn ? " active" : "");
    mag.textContent = "Magnet";
    mag.title = "Snap drawings to candles";
    mag.addEventListener("click", function () {
      magnetOn = !magnetOn;
      mag.classList.toggle("active", magnetOn);
    });
    host.appendChild(mag);
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
    var el = document.getElementById("chart-ind-legend");
    if (!el) return;
    if (!activeIndicators.length || !chart) {
      el.className = "chart-ind-legend hidden";
      el.innerHTML = "";
      return;
    }
    var collapsed = !_legendExpanded;
    var title = collapsed
      ? activeIndicators.map(function (item) { return formatIndLabel(item); }).join(", ")
      : "Indicators";
    var html = '<div class="chart-ind-legend-head">' +
      '<button type="button" class="chart-ind-legend-toggle" title="' + (collapsed ? "Expand" : "Collapse") + '">' +
      (collapsed ? "▸" : "▾") + "</button>" +
      '<span class="chart-ind-legend-title">' + escHtml(title) + "</span></div>";
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
    var tog = el.querySelector(".chart-ind-legend-toggle");
    if (tog) {
      tog.addEventListener("click", function (e) {
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
    var el = document.getElementById("chart-ind-legend");
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
        var items = pop.querySelectorAll("[data-add]");
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
          var target = items[_indFocusIdx] || items[0];
          if (target) promptAddIndicator(target.dataset.add);
        } else if (e.key === "Escape") {
          e.preventDefault();
          _indSearch = "";
          _indFocusIdx = -1;
          pop.classList.add("hidden");
        }
      });
    }
    pop.querySelectorAll("[data-add]").forEach(function (b) {
      b.addEventListener("mouseenter", function () {
        var items = pop.querySelectorAll("[data-add]");
        _indFocusIdx = Array.prototype.indexOf.call(items, b);
        highlightIndList(pop);
      });
      b.addEventListener("click", function (e) {
        e.stopPropagation();
        promptAddIndicator(b.dataset.add);
      });
    });
    pop.querySelectorAll("[data-edit]").forEach(function (b) {
      b.addEventListener("click", function (e) {
        e.stopPropagation();
        var idx = parseInt(b.dataset.edit, 10);
        var item = activeIndicators[idx];
        if (item && item.kind === "custom") openCustomModal(item.id);
        else openIndSettings(idx);
      });
    });
    pop.querySelectorAll("[data-rm]").forEach(function (b) {
      b.addEventListener("click", function (e) {
        e.stopPropagation();
        removeActive(parseInt(b.dataset.rm, 10));
      });
    });
    highlightIndList(pop);
  }

  function highlightIndList(pop) {
    var items = pop.querySelectorAll("[data-add]");
    items.forEach(function (el, i) {
      el.classList.toggle("hl", i === _indFocusIdx);
    });
    if (_indFocusIdx >= 0 && items[_indFocusIdx]) {
      items[_indFocusIdx].scrollIntoView({ block: "nearest" });
    }
  }

  function renderIndicatorPop(keepSearchFocus) {
    var pop = document.getElementById("ind-pop");
    if (!pop) return;
    var html = '<div class="ind-pop-search"><input type="text" id="ind-search" placeholder="Search indicators" autocomplete="off" spellcheck="false" /></div>';
    html += '<div class="ind-pop-body">';
    html += "<div class=\"chart-pop-title\">On chart (all symbols)</div>";
    if (!activeIndicators.length) html += "<div class=\"chart-pop-row\"><span class=\"settings-broker-desc\">None added yet</span></div>";
    activeIndicators.forEach(function (item, i) {
      html += "<div class=\"chart-pop-row\"><span>" + formatIndLabel(item) +
        "</span><span class=\"chart-pop-row-actions\">" +
        "<button type=\"button\" class=\"btn-secondary\" data-edit=\"" + i + "\">Settings</button>" +
        "<button type=\"button\" class=\"btn-secondary\" data-rm=\"" + i + "\">Remove</button></span></div>";
    });
    var visible = visibleCatalogIndicators();
    if (!visible.length) {
      html += '<div class="ind-pop-empty">No indicators match “' + escHtml(_indSearch) + '”</div>';
    } else {
      var lastGroup = "";
      visible.forEach(function (item) {
        if (item.group !== lastGroup) {
          if (lastGroup) html += "</div>";
          lastGroup = item.group;
          html += "<div class=\"chart-pop-title\">" + item.group + "</div><div class=\"ind-list\">";
        }
        html += '<button type="button" class="ind-list-item" data-add="' + escHtml(item.name) + '">' +
          '<span class="ind-list-name">' + escHtml(item.label) + "</span>" +
          '<span class="ind-list-code">' + escHtml(item.name) + "</span></button>";
      });
      if (lastGroup) html += "</div>";
    }
    html += "</div>";
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
    bindIndicatorPop(pop);
    renderChartLegend();
  }

  function renderCustomPop() {
    var pop = document.getElementById("custom-pop");
    if (!pop) return;
    var defs = loadCustomDefs();
    var html = "<button type=\"button\" class=\"btn-primary\" id=\"btn-new-custom\" style=\"width:100%;margin-bottom:8px\">+ New custom indicator</button>";
    html += "<div class=\"chart-pop-title\">Python indicators</div>";
    if (!_pyCatalog.length) {
      html += "<div class=\"chart-pop-row\"><span class=\"settings-broker-desc\">None found in custom_indicators/</span></div>";
    }
    _pyCatalog.forEach(function (m) {
      var n = activeIndicators.filter(function (x) { return x.kind === "python" && x.id === m.id; }).length;
      html += "<div class=\"chart-pop-row\"><span>" + escHtml(m.name) + (n ? " · " + n + " on" : "") +
        "</span><span class=\"chart-pop-row-actions\">" +
        "<button type=\"button\" class=\"btn-secondary\" data-py=\"" + escHtml(m.id) + "\">Add</button></span></div>";
    });
    html += "<div class=\"chart-pop-title\">Saved formulas</div>";
    if (!defs.length) html += "<div class=\"chart-pop-row\"><span class=\"settings-broker-desc\">No saved formulas yet</span></div>";
    defs.forEach(function (d) {
      var n = activeIndicators.filter(function (x) { return x.kind === "custom" && x.id === d.id; }).length;
      html += "<div class=\"chart-pop-row\"><span>" + d.name + (n ? " · " + n + " on" : "") + "</span><span>" +
        "<button type=\"button\" class=\"btn-secondary\" data-apply=\"" + d.id + "\">Add</button> " +
        "<button type=\"button\" class=\"btn-secondary\" data-edit=\"" + d.id + "\">Edit</button> " +
        "<button type=\"button\" class=\"btn-danger\" data-del=\"" + d.id + "\">×</button></span></div>";
    });
    pop.innerHTML = html;
    var neu = document.getElementById("btn-new-custom");
    if (neu) neu.addEventListener("click", function (e) { e.stopPropagation(); openCustomModal(null); });
    pop.querySelectorAll("[data-py]").forEach(function (b) {
      b.addEventListener("click", function (e) {
        e.stopPropagation();
        openPyIndSettingsAdd(b.dataset.py);
      });
    });
    pop.querySelectorAll("[data-apply]").forEach(function (b) {
      b.addEventListener("click", function (e) {
        e.stopPropagation();
        applyCustomToChart(b.dataset.apply);
      });
    });
    pop.querySelectorAll("[data-edit]").forEach(function (b) {
      b.addEventListener("click", function (e) {
        e.stopPropagation();
        openCustomModal(b.dataset.edit);
      });
    });
    pop.querySelectorAll("[data-del]").forEach(function (b) {
      b.addEventListener("click", function (e) {
        e.stopPropagation();
        var id = b.dataset.del;
        for (var i = activeIndicators.length - 1; i >= 0; i--) {
          if (activeIndicators[i].kind === "custom" && activeIndicators[i].id === id) removeActive(i);
        }
        saveCustomDefs(loadCustomDefs().filter(function (d) { return d.id !== id; }));
        renderCustomPop();
      });
    });
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
    document.getElementById("custom-pop").classList.add("hidden");
  }
  function closeCustomModal() {
    document.getElementById("custom-ind-modal").classList.add("hidden");
    editingCustomId = null;
  }
  function saveCustomFromModal() {
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
    var kept = [];
    for (var ri = activeIndicators.length - 1; ri >= 0; ri--) {
      var cur = activeIndicators[ri];
      if (cur.kind === "custom" && cur.id === def.id) {
        kept.unshift({ uid: cur.uid, visible: cur.visible, color: cur.color });
        removeActive(ri);
      }
    }
    closeCustomModal();
    if (kept.length) {
      kept.forEach(function (p) { applyCustomToChart(def.id, true, p); });
      persistIndicators();
    } else {
      applyCustomToChart(def.id);
    }
  }

  document.getElementById("btn-ind-menu").addEventListener("click", function (e) {
    e.stopPropagation();
    var pop = document.getElementById("ind-pop");
    var opening = pop && pop.classList.contains("hidden");
    if (opening) {
      _indSearch = "";
      _indFocusIdx = -1;
    }
    renderIndicatorPop();
    pop.classList.toggle("hidden");
    document.getElementById("custom-pop").classList.add("hidden");
    var tp = document.getElementById("candle-type-pop");
    if (tp) tp.classList.add("hidden");
    if (opening && pop && !pop.classList.contains("hidden")) {
      var inp = document.getElementById("ind-search");
      if (inp) inp.focus();
    }
  });
  document.getElementById("btn-custom-menu").addEventListener("click", function (e) {
    e.stopPropagation();
    renderCustomPop();
    document.getElementById("custom-pop").classList.toggle("hidden");
    document.getElementById("ind-pop").classList.add("hidden");
    var tp2 = document.getElementById("candle-type-pop");
    if (tp2) tp2.classList.add("hidden");
  });
  (function () {
    var btn = document.getElementById("btn-candle-type");
    if (!btn) return;
    updateCandleTypeButton();
    renderCandleTypePop();
    btn.addEventListener("click", function (e) {
      e.stopPropagation();
      renderCandleTypePop();
      var pop = document.getElementById("candle-type-pop");
      var ip = document.getElementById("ind-pop");
      var cp = document.getElementById("custom-pop");
      if (ip) ip.classList.add("hidden");
      if (cp) cp.classList.add("hidden");
      if (pop) pop.classList.toggle("hidden");
    });
  })();
  document.getElementById("btn-clear-drawings").addEventListener("click", function () {
    if (!chart) return;
    try { chart.removeOverlay({ groupId: "userdraw" }); } catch (_) {}
    overlayIds = [];
    selectedOverlayId = null;
    persistOverlays();
  });

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
      overlayIds = overlayIds.filter(function (x) { return x !== pendingTextId; });
      persistOverlays();
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
      closeCustomModal();
      closeIndSettings();
      var tm = document.getElementById("chart-text-modal");
      if (tm && !tm.classList.contains("hidden")) closeTextModal(false);
      var rm = document.getElementById("chart-rect-modal");
      if (rm && !rm.classList.contains("hidden")) closeRectModal(false);
      return;
    }
    if ((e.key === "Delete" || e.key === "Backspace") && selectedOverlayId && chart && !isTypingTarget(e.target)) {
      e.preventDefault();
      var id = selectedOverlayId;
      try { chart.removeOverlay({ id: id }); } catch (_) {}
      overlayIds = overlayIds.filter(function (x) { return x !== id; });
      selectedOverlayId = null;
      persistOverlays();
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

  function clampYahooRange(fromDate, toDate) {
    if (activeBroker !== "yahoo") return { fromDate: fromDate, toDate: toDate, empty: false };
    var minFrom = yahooEarliestDate(activeInterval);
    if (!minFrom) return { fromDate: fromDate, toDate: toDate, empty: false };
    if (toDate && toDate < minFrom) return { fromDate: minFrom, toDate: toDate, empty: true };
    if (fromDate && fromDate < minFrom) fromDate = minFrom;
    return { fromDate: fromDate, toDate: toDate, empty: false };
  }

  async function fetchCandles(fromDate, toDate) {
    if (!selectedInstrument) return [];
    var res;
    if (activeBroker === "5paisa") {
      res = await fetch("/api/5paisa/chart/data", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          scrip_code: selectedInstrument.scrip_code,
          exch: selectedInstrument.exch,
          exch_type: selectedInstrument.exch_type,
          trading_symbol: selectedInstrument.trading_symbol || "",
          interval: activeInterval,
          from_date: fromDate || "",
          to_date: toDate || ""
        })
      });
    } else if (activeBroker === "yahoo") {
      res = await fetch("/api/yahoo/chart/data", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          yahoo_symbol: selectedInstrument.yahoo_symbol || selectedInstrument.scrip_code || "",
          trading_symbol: selectedInstrument.trading_symbol || "",
          interval: activeInterval,
          from_date: fromDate || "",
          to_date: toDate || ""
        })
      });
    } else if (activeBroker === "excel") {
      res = await fetch("/api/excel/chart/data", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          config_id: selectedInstrument.excel_config_id || selectedInstrument.scrip_code || "",
          trading_symbol: selectedInstrument.trading_symbol || "",
          interval: activeInterval,
          from_date: fromDate || "",
          to_date: toDate || ""
        })
      });
    } else {
      res = await fetch("/api/chart/data", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          security_id: selectedInstrument.security_id,
          exchange_segment: selectedInstrument.exchange_segment,
          instrument: selectedInstrument.instrument,
          interval: activeInterval,
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
    _excelOverlayData = activeBroker === "excel" ? (data.overlays || []) : [];
    return (data.candles || []).map(toKLine);
  }

  function clearExcelOverlays() {
    if (!chart) {
      _excelOverlayIds = [];
      return;
    }
    _excelOverlayIds.forEach(function (id) {
      try { chart.removeOverlay({ id: id }); } catch (_) {
        try { chart.removeOverlay(id); } catch (__) {}
      }
    });
    _excelOverlayIds = [];
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
      if (activeBroker === "excel") {
        done([], false);
        return;
      }
      if (!_histMore || _histLoading || !selectedInstrument) {
        done([], !!_histMore);
        return;
      }
      var ts = data && data.timestamp;
      if (ts == null) { done([], false); return; }
      _histLoading = true;
      var toDate = dateIST(ts);
      var fromDate = shiftDate(toDate, -moreChunkDays(activeInterval));
      var yrange = clampYahooRange(fromDate, toDate);
      if (yrange.empty) {
        _histMore = false;
        _histLoading = false;
        done([], false);
        return;
      }
      fromDate = yrange.fromDate;
      fetchCandles(fromDate, toDate).then(function (candles) {
        var older = (candles || []).filter(function (c) { return c.timestamp < ts; });
        if (!older.length) {
          _histMore = false;
          done([], false);
          return;
        }
        _rawBars = older.concat(_rawBars);
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
      }).catch(function () {
        _histMore = false;
        done([], false);
      }).finally(function () {
        _histLoading = false;
      });
    });
  }

  async function loadChartData(silent) {
    if (silent && _refreshing) return;
    _refreshing = true;
    if (!silent) {
      chartMessage.textContent = "Loading chart data\u2026";
      chartMessage.style.display = "flex";
      _lastBarTime = null;
    }
    try {
      var toDate = dateIST(Date.now());
      var fromDate = shiftDate(toDate, -lookbackDays(activeInterval));
      var yrange = clampYahooRange(fromDate, toDate);
      fromDate = yrange.fromDate;
      var formatted;
      try {
        formatted = await fetchCandles(fromDate, toDate);
      } catch (e) {
        var msg = e.message || "Failed to load chart data.";
        var payload = e.payload || {};
        if (payload.error_code === "DH-902" || (msg && msg.indexOf("Data API") >= 0)) {
          msg = "\u26a0\ufe0f Data API subscription required.\n" + msg + "\n\nSubscribe at: https://dhan.co/data-apis/";
        }
        if (!silent) { chartMessage.textContent = msg; chartMessage.style.display = "flex"; }
        return;
      }
      if (!formatted.length) {
        if (!silent) {
          chartMessage.textContent = "No data returned for selected range.";
          chartMessage.style.display = "flex";
        }
        return;
      }
      var isFullLoad = !silent || !chart;
      if (isFullLoad) {
        persistOverlays();
        exitReplay(false);
        _histMore = activeBroker !== "excel";
        _histLoading = false;
        _rawBars = formatted.slice();
        initChart();
        chart.applyNewData(displaySeries(_rawBars), true);
        restoreIndicators();
        await restoreOverlays();
        applyExcelOverlays();
      } else {
        for (var i = 0; i < formatted.length; i++) {
          upsertRawBar(formatted[i]);
        }
        if (!replayFrozen()) {
          var shown = displaySeries(_rawBars);
          for (var j = 0; j < shown.length; j++) {
            if (_lastBarTime === null || shown[j].timestamp >= _lastBarTime) {
              chart.updateData(shown[j]);
            }
          }
          schedulePyRefresh();
          applyExcelOverlays();
        }
      }
      _lastBarTime = formatted.length ? formatted[formatted.length - 1].timestamp : _lastBarTime;
      var seg = selectedInstrument.exchange_label || selectedInstrument.exchange_segment || "";
      if (activeBroker === "yahoo") seg = selectedInstrument.yahoo_symbol || "Yahoo";
      if (activeBroker === "excel") seg = selectedInstrument.name || "Excel";
      symbolLabel.textContent = selectedInstrument.trading_symbol + " \u00b7 " + seg;
      syncPrevClose();
      refreshLiveQuote();
      chartMeta.classList.remove("hidden");
      chartMessage.style.display = "none";
      if (isFullLoad) {
        unsubscribeLive();
        if (activeBroker === "5paisa" && !intervalCfg(activeInterval).resample) subscribeLive();
        startAutoRefresh();
      }
    } catch (e) {
      if (!silent) {
        chartMessage.textContent = "Error: " + e.message;
        chartMessage.style.display = "flex";
      }
    } finally {
      _refreshing = false;
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
    if (chartContainer && !chartContainer._replayPtrBound) {
      chartContainer._replayPtrBound = true;
      chartContainer.addEventListener("pointerdown", function (e) {
        if (!_replay.picking) return;
        if (e.button != null && e.button !== 0) return;
        _replay.ptr = { x: e.clientX, y: e.clientY };
        _replay.dragged = false;
      });
      chartContainer.addEventListener("pointermove", function (e) {
        if (!_replay.ptr) return;
        var dx = e.clientX - _replay.ptr.x;
        var dy = e.clientY - _replay.ptr.y;
        if (dx * dx + dy * dy > 36) _replay.dragged = true;
      });
      chartContainer.addEventListener("pointerup", function (e) {
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
      overlay: item.overlay != null ? item.overlay : !!spec.overlay,
      visible: item.visible !== false
    });
  });
  renderDrawTools();
  renderIndicatorPop();
  renderCustomPop();
  bindChartNav();
  bindReplayControls();
  loadPyCatalog();
  syncChartBrokerTabs();
  window.addEventListener("beforeunload", function () { persistOverlays(); });
})();
