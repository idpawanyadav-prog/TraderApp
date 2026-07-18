/* ── Sidebar Toggle ── */
document.getElementById("sidebar-toggle").addEventListener("click", () => {
  document.getElementById("sidebar").classList.toggle("collapsed");
});

/* ── Page Navigation ── */
document.querySelectorAll(".nav-item[data-page]").forEach(link => {
  link.addEventListener("click", e => {
    e.preventDefault();
    document.querySelectorAll(".nav-item").forEach(l => l.classList.remove("active"));
    link.classList.add("active");
    document.querySelectorAll(".page").forEach(p => p.classList.remove("active"));
    const page = document.getElementById("page-" + link.dataset.page);
    if (page) page.classList.add("active");
  });
});

/* ── Chart Module (LightweightCharts v4) ── */
(function () {

  const IST_OFFSET = 19800; // UTC → IST shift in seconds

  let chart        = null;
  let candleSeries = null;
  let _socket      = null;
  let _liveSub     = false;
  let selectedInstrument = null;
  let activeInterval     = "1";
  let activeBroker       = "dhan";
  let _refreshTimer    = null;
  let _refreshInterval = 0;   // ms; 0 = disabled

  function startAutoRefresh() {
    stopAutoRefresh();
    if (_refreshInterval > 0 && selectedInstrument) {
      _refreshTimer = setInterval(function() {
        if (selectedInstrument && chart) loadChartData(true);
      }, _refreshInterval);
    }
  }

  function stopAutoRefresh() {
    if (_refreshTimer) { clearInterval(_refreshTimer); _refreshTimer = null; }
  }

  // Called by Settings Module when user changes the interval
  window._chartSetRefreshInterval = function(ms) {
    _refreshInterval = ms;
    startAutoRefresh();
  };


  const searchInput    = document.getElementById("stock-search");
  const dropdown       = document.getElementById("search-dropdown");
  const intervalBtns   = document.querySelectorAll(".ivl-btn");
  const loadBtn        = document.getElementById("load-chart-btn");
  const chartContainer = document.getElementById("chart-container");
  const chartMessage   = document.getElementById("chart-message");
  const chartMeta      = document.getElementById("chart-meta");
  const symbolLabel    = document.getElementById("chart-symbol-label");
  const ohlcEl         = document.getElementById("chart-ohlc");

  // ── Socket.IO live feed (5Paisa only) ──
  function getSocket() {
    if (!_socket) {
      _socket = io({ transports: ["websocket", "polling"] });
      _socket.on("price_update", candle => {
        if (!candleSeries) return;
        const dot = document.getElementById("live-dot");
        candleSeries.update({
          time:   candle.time + IST_OFFSET,
          open:   candle.open,
          high:   candle.high,
          low:    candle.low,
          close:  candle.close,
        });
        if (dot) { dot.classList.add("pulse"); setTimeout(() => dot.classList.remove("pulse"), 400); }
      });
    }
    return _socket;
  }

  function subscribeLive() {
    if (activeBroker !== "5paisa" || !selectedInstrument) return;
    getSocket().emit("subscribe_live", {
      scrip_code: selectedInstrument.scrip_code,
      exch:       selectedInstrument.exch,
      exch_type:  selectedInstrument.exch_type,
      interval:   activeInterval,
    });
    _liveSub = true;
    const t = document.getElementById("live-badge");
    if (t) t.style.display = "inline-flex";
  }

  function unsubscribeLive() {
    if (!_liveSub) return;
    if (_socket) _socket.emit("unsubscribe_live");
    _liveSub = false;
    const t = document.getElementById("live-badge");
    if (t) t.style.display = "none";
  }

  // ── Broker source tabs ──
  document.querySelectorAll(".cbrok-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".cbrok-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      activeBroker = btn.dataset.cbrok;
      unsubscribeLive();
      selectedInstrument = null;
      searchInput.value = "";
      dropdown.innerHTML = "";
      dropdown.classList.add("hidden");
    });
  });

  // ── Interval buttons ──
  intervalBtns.forEach(btn => {
    btn.addEventListener("click", () => {
      intervalBtns.forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      activeInterval = btn.dataset.ivl;
      if (selectedInstrument) loadChartData();
    });
  });

  // ── Stock search typeahead ──
  let searchTimer = null;
  searchInput.addEventListener("input", () => {
    clearTimeout(searchTimer);
    const q = searchInput.value.trim();
    if (q.length < 2) { dropdown.classList.add("hidden"); dropdown.innerHTML = ""; return; }
    searchTimer = setTimeout(() => fetchSuggestions(q), 250);
  });

  searchInput.addEventListener("keydown", e => {
    const items  = dropdown.querySelectorAll("li");
    const active = dropdown.querySelector("li.active");
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (!active) { items[0] && items[0].classList.add("active"); }
      else { active.classList.remove("active"); const n = active.nextElementSibling; if (n) n.classList.add("active"); }
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (active) { active.classList.remove("active"); const p = active.previousElementSibling; if (p) p.classList.add("active"); }
    } else if (e.key === "Enter") {
      if (active) active.click();
    } else if (e.key === "Escape") {
      dropdown.classList.add("hidden");
    }
  });

  document.addEventListener("click", e => {
    if (!e.target.closest(".chart-search-wrap")) dropdown.classList.add("hidden");
  });

  async function fetchSuggestions(q) {
    try {
      const url = activeBroker === "5paisa"
        ? `/api/5paisa/instruments/search?q=${encodeURIComponent(q)}&limit=12`
        : `/api/instruments/search?q=${encodeURIComponent(q)}&limit=12`;
      const res   = await fetch(url);
      const items = await res.json();
      if (items.error) { dropdown.classList.add("hidden"); return; }
      dropdown.innerHTML = "";
      if (!items.length) { dropdown.classList.add("hidden"); return; }
      items.forEach(item => {
        const li  = document.createElement("li");
        const sym = item.trading_symbol;
        const seg = activeBroker === "5paisa" ? item.exchange_label : item.exchange_segment;
        li.innerHTML = `<span class="sym">${sym}</span>${item.name}<span class="seg">${seg}</span>`;
        li.addEventListener("click", () => {
          selectedInstrument = item;
          searchInput.value  = `${sym} \u2014 ${item.name}`;
          dropdown.classList.add("hidden");
        });
        dropdown.appendChild(li);
      });
      dropdown.classList.remove("hidden");
    } catch (_) {}
  }

  // ── Load Chart button ──
  loadBtn.addEventListener("click", () => {
    if (!selectedInstrument) {
      chartMessage.textContent = "Please search and select a stock first.";
      chartMessage.style.display = "flex";
      return;
    }
    loadChartData();
  });

  // ── Init LightweightCharts ──
  function initChart() {
    if (chart) { chart.remove(); chart = null; }
    chartMessage.style.display = "none";
    chartContainer.style.display = "block";

    chart = LightweightCharts.createChart(chartContainer, {
      layout:          { background: { color: "#0d1117" }, textColor: "#8b949e" },
      grid:            { vertLines: { color: "#21262d" }, horzLines: { color: "#21262d" } },
      crosshair:       { mode: LightweightCharts.CrosshairMode.Normal },
      rightPriceScale: { borderColor: "#30363d" },
      timeScale:       { borderColor: "#30363d", timeVisible: true, secondsVisible: false },
      width:           chartContainer.clientWidth,
      height:          480,
    });

    candleSeries = chart.addCandlestickSeries({
      upColor:         "#3fb950",
      downColor:       "#f85149",
      borderUpColor:   "#3fb950",
      borderDownColor: "#f85149",
      wickUpColor:     "#3fb950",
      wickDownColor:   "#f85149",
    });

    // Crosshair OHLC tooltip
    chart.subscribeCrosshairMove(param => {
      if (!param.time || !param.seriesData) { ohlcEl.innerHTML = ""; return; }
      const d = param.seriesData.get(candleSeries);
      if (!d) return;
      ohlcEl.innerHTML =
        `<span class="ohlc-o">O <b>${d.open.toFixed(2)}</b></span>` +
        `<span class="ohlc-h">H <b>${d.high.toFixed(2)}</b></span>` +
        `<span class="ohlc-l">L <b>${d.low.toFixed(2)}</b></span>` +
        `<span class="ohlc-c">C <b>${d.close.toFixed(2)}</b></span>`;
    });

    new ResizeObserver(() => {
      if (chart) chart.applyOptions({ width: chartContainer.clientWidth });
    }).observe(chartContainer);
  }

  // ── Load chart data ──
  async function loadChartData(silent) {
    if (!silent) {
      chartMessage.textContent = "Loading chart data\u2026";
      chartMessage.style.display = "flex";
      if (chart) { chart.remove(); chart = null; }
    }

    try {
      let res;
      if (activeBroker === "5paisa") {
        res = await fetch("/api/5paisa/chart/data", {
          method:  "POST",
          headers: { "Content-Type": "application/json" },
          body:    JSON.stringify({
            scrip_code: selectedInstrument.scrip_code,
            exch:       selectedInstrument.exch,
            exch_type:  selectedInstrument.exch_type,
            interval:   activeInterval,
          }),
        });
      } else {
        res = await fetch("/api/chart/data", {
          method:  "POST",
          headers: { "Content-Type": "application/json" },
          body:    JSON.stringify({
            security_id:      selectedInstrument.security_id,
            exchange_segment: selectedInstrument.exchange_segment,
            instrument:       selectedInstrument.instrument,
            interval:         activeInterval,
          }),
        });
      }

      const data = await res.json();
      if (!data.success) {
        let msg = data.message || "Failed to load chart data.";
        if (data.error_code === "DH-902" || (msg && msg.includes("Data API"))) {
          msg = `\u26a0\ufe0f Data API subscription required.\n${msg}\n\nSubscribe at: https://dhan.co/data-apis/`;
        }
        chartMessage.textContent = msg;
        chartMessage.style.display = "flex";
        return;
      }
      if (!data.candles.length) {
        chartMessage.textContent = "No data returned for selected range.";
        chartMessage.style.display = "flex";
        return;
      }

      if (!silent || !chart) initChart();

      // Convert UTC unix timestamps → IST for display
      // LightweightCharts v4 has no timezone support; shift by +19800s (IST = UTC+5:30)
      const formatted = data.candles.map(c => {
        let t;
        if (activeInterval === "D") {
          const d = new Date((c.time + IST_OFFSET) * 1000);
          t = d.toISOString().slice(0, 10);
        } else {
          t = c.time + IST_OFFSET;
        }
        return { time: t, open: c.open, high: c.high, low: c.low, close: c.close };
      });

      candleSeries.setData(formatted);
      chart.timeScale().fitContent();

      const seg = activeBroker === "5paisa"
        ? selectedInstrument.exchange_label
        : selectedInstrument.exchange_segment;
      symbolLabel.textContent = `${selectedInstrument.trading_symbol} \u00b7 ${seg} [${activeBroker === "5paisa" ? "5Paisa" : "Dhan"}]`;
      chartMeta.classList.remove("hidden");
      chartMessage.style.display = "none";

      unsubscribeLive();
      if (activeBroker === "5paisa") subscribeLive();
      startAutoRefresh();

    } catch (e) {
      chartMessage.textContent = "Error: " + e.message;
      chartMessage.style.display = "flex";
    }
  }

})();

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

  const connectBtn = document.getElementById("connect-btn");
  if (connectBtn) connectBtn.addEventListener("click", async () => {
    showMsg("message-box", "Connecting\u2026", false);
    const res  = await fetch("/api/dhan/connect", { method: "POST" });
    const data = await res.json();
    showMsg("message-box", data.message, !data.success);
    setStatus("dhan-status", data.success);
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
  });

  const disconnectBtn = document.getElementById("disconnect-btn");
  if (disconnectBtn) disconnectBtn.addEventListener("click", async () => {
    const res  = await fetch("/api/dhan/disconnect", { method: "POST" });
    const data = await res.json();
    showMsg("message-box", data.message, !data.success);
    setStatus("dhan-status", false);
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

  const fpConnectBtn = document.getElementById("fp-connect-btn");
  if (fpConnectBtn) fpConnectBtn.addEventListener("click", async () => {
    showMsg("fp-message-box", "Connecting\u2026", false);
    const res  = await fetch("/api/5paisa/connect", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) });
    const data = await res.json();
    showMsg("fp-message-box", data.message, !data.success);
    setStatus("5paisa-status", data.success);
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
  });

  const fpDisconnectBtn = document.getElementById("fp-disconnect-btn");
  if (fpDisconnectBtn) fpDisconnectBtn.addEventListener("click", async () => {
    const res  = await fetch("/api/5paisa/disconnect", { method: "POST" });
    const data = await res.json();
    showMsg("fp-message-box", data.message, !data.success);
    setStatus("5paisa-status", false);
    const sec = document.getElementById("fp-user-info-section");
    if (sec) sec.style.display = "none";
  });

})();

/* ── Settings Module ── */
(function () {

  // ── Broker visibility ──────────────────────────────────────────────────────

  function applyBrokerVisibility(broker, enabled) {
    var cbrok = document.querySelector('.cbrok-btn[data-cbrok="' + broker + '"]');
    if (cbrok) cbrok.style.display = enabled ? '' : 'none';
    var tab = document.querySelector('.tab-btn[data-broker="' + broker + '"]');
    if (tab) {
      tab.style.display = enabled ? '' : 'none';
      if (!enabled && tab.classList.contains('active')) {
        var other = document.querySelector('.tab-btn[data-broker]:not([data-broker="' + broker + '"])');
        if (other && other.style.display !== 'none') other.click();
      }
    }
    if (!enabled) {
      var panel = document.getElementById('panel-' + broker);
      if (panel) panel.classList.add('hidden');
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
      if (apiChk)  { apiChk.checked  = !!data.api_enabled;              toggleApiPanel(apiChk.checked); }
      if (dhanChk) { dhanChk.checked = data.dhan_enabled !== false;      applyBrokerVisibility('dhan',   dhanChk.checked); }
      if (fpChk)   { fpChk.checked   = data['5paisa_enabled'] !== false; applyBrokerVisibility('5paisa', fpChk.checked); }
      var ri = document.getElementById('chart-refresh-interval');
      if (ri && data.chart_refresh_interval !== undefined) ri.value = data.chart_refresh_interval;
      if (window._chartSetRefreshInterval) window._chartSetRefreshInterval(data.chart_refresh_interval || 0);
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
    if (epBtn) epBtn.addEventListener('click', function() {
      var panel = document.getElementById('ep-panel');
      if (!panel) return;
      var isOpen = !panel.classList.contains('hidden');
      if (isOpen) { panel.classList.add('hidden'); epBtn.classList.remove('open'); }
      else         { panel.classList.remove('hidden'); epBtn.classList.add('open'); }
    });
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
  });

  var fpToggle = document.getElementById('setting-enable-5paisa');
  if (fpToggle) fpToggle.addEventListener('change', async function() {
    await fetch('/api/settings/brokers', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ '5paisa_enabled': fpToggle.checked }),
    });
    applyBrokerVisibility('5paisa', fpToggle.checked);
  });

  // ── Technical Indicators ───────────────────────────────────────────────────

  var _taCatalog   = {};   // loaded from /public/api/ta/catalog
  var _taIndicators = [];  // current list of configured indicators

  async function loadTaSettings() {
    // Load catalog
    try {
      var r = await fetch('/public/api/ta/catalog');
      var d = await r.json();
      if (d.success) {
        _taCatalog = d.indicators;
        _populateTaTypeSelect();
      }
    } catch (_) {}
    // Load saved config
    try {
      var r2 = await fetch('/api/settings/indicators');
      var d2 = await r2.json();
      _taIndicators = d2.ta_indicators || [];
      var taChk = document.getElementById('setting-enable-ta');
      if (taChk) taChk.checked = !!d2.ta_enabled;
      _renderTaRows();
      // If enabled, expand panel
      if (d2.ta_enabled) _setTaPanel(true);
    } catch (_) {}
  }

  function _populateTaTypeSelect() {
    var sel = document.getElementById('ta-type-select');
    if (!sel) return;
    sel.innerHTML = Object.keys(_taCatalog).map(function(k) {
      return '<option value="' + k + '">' + _taCatalog[k].label + '</option>';
    }).join('');
  }

  function _makeIndicatorId(type, params) {
    var p = _taCatalog[type] ? _taCatalog[type].params : [];
    if (!p.length) return type;
    var vals = p.map(function(pd) { return params[pd.name] || pd.default; });
    return type + '_' + vals.join('_');
  }

  function _renderTaRows() {
    var list = document.getElementById('ta-indicator-list');
    if (!list) return;
    if (!_taIndicators.length) {
      list.innerHTML = '<div style="color:#8b949e;font-size:0.78rem;padding:4px 0;">No indicators configured yet.</div>';
      return;
    }
    list.innerHTML = _taIndicators.map(function(ind, idx) {
      var cat = _taCatalog[ind.type] || { label: ind.type, params: [] };
      var paramHtml = cat.params.map(function(pd) {
        var val = (ind.params && ind.params[pd.name] !== undefined) ? ind.params[pd.name] : pd.default;
        return '<span class="ta-param-group">' +
          '<span class="ta-param-label">' + pd.name + ':</span>' +
          '<input class="ta-param-input" type="number" data-idx="' + idx + '" data-param="' + pd.name + '" min="' + pd.min + '" max="' + pd.max + '" value="' + val + '" />' +
          '</span>';
      }).join('');
      return '<div class="ta-indicator-row" data-idx="' + idx + '">' +
        '<span class="ta-row-label">' + cat.label + '</span>' +
        '<div class="ta-row-params">' + paramHtml + '</div>' +
        '<button class="ta-remove-btn" data-idx="' + idx + '" title="Remove">\u00d7</button>' +
        '<span class="ta-row-id">key: ' + ind.id + '</span>' +
        '</div>';
    }).join('');
    // Bind param change
    list.querySelectorAll('.ta-param-input').forEach(function(inp) {
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
    // Bind remove
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
    var type = sel.value;
    var cat  = _taCatalog[type] || { params: [] };
    var params = {};
    cat.params.forEach(function(pd) { params[pd.name] = pd.default; });
    var id = _makeIndicatorId(type, params);
    // Prevent exact duplicate
    var exists = _taIndicators.some(function(x) { return x.id === id; });
    if (exists) { _showTaSaveMsg('Indicator already added.', true); return; }
    _taIndicators.push({ id: id, type: type, params: params });
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
        if (data.loaded)       el.textContent = 'Loaded \u2014 ' + data.count.toLocaleString() + ' instruments (' + (data.last_loaded || '') + ')';
        else if (data.loading) el.textContent = 'Loading\u2026';
        else                   el.textContent = 'Not loaded. Connect to 5Paisa first.';
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
  async function loadMarketSettings() {
    try {
      var res  = await fetch('/api/settings/markets');
      var data = await res.json();
      document.querySelectorAll('.market-exch-chk').forEach(function(chk) {
        chk.checked = data.enabled_exchanges.indexOf(chk.dataset.code) !== -1;
      });
      document.querySelectorAll('.market-instr-type-chk').forEach(function(chk) {
        chk.checked = data.enabled_instrument_types.indexOf(chk.dataset.code) !== -1;
      });
    } catch (_) {}
  }

  var mColBtn = document.getElementById('market-collapse-btn');
  var mPanel  = document.getElementById('market-panel');
  if (mColBtn && mPanel) {
    mColBtn.addEventListener('click', function() {
      var isHidden = mPanel.classList.contains('hidden');
      if (isHidden) { mPanel.classList.remove('hidden'); mColBtn.classList.add('open'); }
      else { mPanel.classList.add('hidden'); mColBtn.classList.remove('open'); }
    });
    var mHeader = document.getElementById('market-section-header');
    if (mHeader) mHeader.addEventListener('click', function(e) {
      if (!e.target.closest('#market-collapse-btn')) mColBtn.click();
    });
  }

  var btnSaveMarkets = document.getElementById('btn-save-markets');
  if (btnSaveMarkets) {
    btnSaveMarkets.addEventListener('click', async function() {
      var exchanges = Array.from(document.querySelectorAll('.market-exch-chk'))
        .filter(function(c) { return c.checked; }).map(function(c) { return c.dataset.code; });
      var instrTypes = Array.from(document.querySelectorAll('.market-instr-type-chk'))
        .filter(function(c) { return c.checked; }).map(function(c) { return c.dataset.code; });
      var msgEl = document.getElementById('market-save-msg');
      try {
        await fetch('/api/settings/markets', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled_exchanges: exchanges, enabled_instrument_types: instrTypes }),
        });
        if (msgEl) { msgEl.textContent = 'Saved.'; msgEl.className = 'ta-save-msg success'; setTimeout(function() { msgEl.textContent = ''; }, 2000); }
      } catch (e) {
        if (msgEl) { msgEl.textContent = 'Error saving.'; msgEl.className = 'ta-save-msg error'; }
      }
    });
  }

  loadSettings();
  loadMarketSettings();
  loadScripStatus();

})();
