/* ── Open Interest (OI Change vs Strike) ── */
(function () {
  var el = function (id) { return document.getElementById(id); };
  var state = {
    symbol: "NIFTY",
    view: "change",
    atmN: 10,
    fromIdx: 0,
    toIdx: 0,
    preset: "full",
    showOi: false,
    payload: null,
    underlyings: [],
    loading: false,
    timer: null,
  };

  function showPageActive() {
    var page = el("page-open-interest");
    return page && page.classList.contains("active");
  }

  function fmtNum(n, dp) {
    if (n === null || n === undefined || isNaN(n)) return "—";
    return Number(n).toLocaleString(undefined, {
      minimumFractionDigits: dp,
      maximumFractionDigits: dp,
    });
  }

  function fmtCompact(n) {
    if (n === null || n === undefined || isNaN(n)) return "—";
    var sign = n < 0 ? "-" : "";
    var a = Math.abs(n);
    if (a >= 1e7) return sign + (a / 1e7).toFixed(2) + " Cr";
    if (a >= 1e5) return sign + (a / 1e5).toFixed(2) + " L";
    if (a >= 1e3) return sign + (a / 1e3).toFixed(1) + " K";
    return sign + a.toFixed(0);
  }

  function fmtSigned(n) {
    if (n === null || n === undefined || isNaN(n)) return "—";
    var s = fmtCompact(n);
    return n > 0 && s[0] !== "+" ? "+" + s : s;
  }

  function fmtTimeLabel(hhmm) {
    if (!hhmm) return "—";
    var p = hhmm.split(":");
    var h = parseInt(p[0], 10);
    var m = p[1] || "00";
    var ap = h >= 12 ? "PM" : "AM";
    var h12 = h % 12;
    if (!h12) h12 = 12;
    return h12 + ":" + m + " " + ap;
  }

  function filteredStrikes(payload) {
    var rows = (payload && payload.strikes) || [];
    var minV = parseFloat(el("oi-strike-min").value);
    var maxV = parseFloat(el("oi-strike-max").value);
    if (!isNaN(minV) || !isNaN(maxV)) {
      return rows.filter(function (r) {
        if (!isNaN(minV) && r.strike < minV) return false;
        if (!isNaN(maxV) && r.strike > maxV) return false;
        return true;
      });
    }
    if (state.atmN === "all" || state.atmN === 0) return rows;
    var atm = payload.atm_strike;
    var step = payload.strike_step || 50;
    var n = Number(state.atmN) || 10;
    var lo = atm - n * step;
    var hi = atm + n * step;
    return rows.filter(function (r) { return r.strike >= lo && r.strike <= hi; });
  }

  function idxClamped(payload, idx) {
    var n = (payload.times || []).length;
    if (!n) return 0;
    return Math.max(0, Math.min(n - 1, idx));
  }

  function applyPreset(mins) {
    var p = state.payload;
    if (!p || !p.minutes) return;
    var last = p.minutes.length - 1;
    state.preset = String(mins);
    if (mins === "full") {
      state.fromIdx = 0;
      state.toIdx = last;
    } else {
      var m = parseInt(mins, 10) || 3;
      var bucket = 1;
      if (p.minutes.length > 1) bucket = Math.max(1, p.minutes[1] - p.minutes[0]);
      var steps = Math.max(1, Math.round(m / bucket));
      state.toIdx = last;
      state.fromIdx = Math.max(0, last - steps);
    }
    el("oi-slider-from").value = String(state.fromIdx);
    el("oi-slider-to").value = String(state.toIdx);
    document.querySelectorAll("#oi-presets .oi-chip").forEach(function (b) {
      b.classList.toggle("active", String(b.dataset.mins) === String(mins));
    });
    renderChart();
  }

  function cssVar(name, fallback) {
    var v = getComputedStyle(document.documentElement).getPropertyValue(name);
    return (v && v.trim()) || fallback;
  }

  function drawChart() {
    var canvas = el("oi-chart");
    var empty = el("oi-chart-empty");
    if (!canvas) return;
    var p = state.payload;
    var ctx = canvas.getContext("2d");
    var wrap = el("oi-chart-wrap");
    var dpr = window.devicePixelRatio || 1;
    var w = wrap.clientWidth || 800;
    var h = 420;
    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
    canvas.style.width = w + "px";
    canvas.style.height = h + "px";
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    if (!p) return;
    var rows = filteredStrikes(p);
    var from = idxClamped(p, state.fromIdx);
    var to = idxClamped(p, state.toIdx);
    if (from > to) { var tmp = from; from = to; to = tmp; }

    var absMode = state.view === "oi";
    var series = rows.map(function (r) {
      var ce0 = (r.call_oi || [])[from] || 0;
      var pe0 = (r.put_oi || [])[from] || 0;
      var ce1 = (r.call_oi || [])[to] || 0;
      var pe1 = (r.put_oi || [])[to] || 0;
      return {
        strike: r.strike,
        call: absMode ? ce1 : (ce1 - ce0),
        put: absMode ? pe1 : (pe1 - pe0),
        callOi: ce1,
        putOi: pe1,
      };
    });

    var padL = 58, padR = 16, padT = 28, padB = 42;
    var plotW = w - padL - padR;
    var plotH = h - padT - padB;
    var maxAbs = 1;
    series.forEach(function (s) {
      maxAbs = Math.max(maxAbs, Math.abs(s.call), Math.abs(s.put));
      if (state.showOi && !absMode) {
        maxAbs = Math.max(maxAbs, Math.abs(s.callOi) * 0.15, Math.abs(s.putOi) * 0.15);
      }
    });
    var yMax = maxAbs * 1.12;
    function yx(v) {
      return padT + plotH / 2 - (v / yMax) * (plotH / 2);
    }
    if (absMode) {
      yx = function (v) {
        return padT + plotH - (v / yMax) * plotH;
      };
    }

    var text = cssVar("--muted", "#8b949e");
    var grid = cssVar("--border", "#30363d");
    var putC = "#3dd68c";
    var callC = "#f87171";
    var atm = p.atm_strike;

    ctx.strokeStyle = grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    var zeroY = absMode ? yx(0) : padT + plotH / 2;
    ctx.moveTo(padL, zeroY);
    ctx.lineTo(padL + plotW, zeroY);
    ctx.stroke();

    ctx.fillStyle = text;
    ctx.font = "11px Segoe UI, sans-serif";
    ctx.textAlign = "right";
    var ticks = absMode ? [0, 0.25, 0.5, 0.75, 1] : [-1, -0.5, 0, 0.5, 1];
    ticks.forEach(function (t) {
      var v = t * yMax;
      var y = absMode ? yx(Math.abs(v)) : (padT + plotH / 2 - t * (plotH / 2));
      ctx.fillText(fmtCompact(v), padL - 8, y + 4);
    });

    var n = series.length;
    if (!n) return;
    var slot = plotW / n;
    var barW = Math.max(2, Math.min(14, slot * 0.32));

    series.forEach(function (s, i) {
      var cx = padL + slot * i + slot / 2;
      if (state.showOi && !absMode) {
        ctx.globalAlpha = 0.18;
        ctx.fillStyle = callC;
        ctx.fillRect(cx - barW - 1, yx(s.callOi * 0.15), barW, zeroY - yx(s.callOi * 0.15));
        ctx.fillStyle = putC;
        ctx.fillRect(cx + 1, yx(s.putOi * 0.15), barW, zeroY - yx(s.putOi * 0.15));
        ctx.globalAlpha = 1;
      }
      ctx.fillStyle = callC;
      var yCall = yx(s.call);
      ctx.fillRect(cx - barW - 1, Math.min(yCall, zeroY), barW, Math.abs(zeroY - yCall) || 1);
      ctx.fillStyle = putC;
      var yPut = yx(s.put);
      ctx.fillRect(cx + 1, Math.min(yPut, zeroY), barW, Math.abs(zeroY - yPut) || 1);

      if (Math.abs(s.strike - atm) < (p.strike_step || 1) * 0.51) {
        ctx.setLineDash([4, 4]);
        ctx.strokeStyle = cssVar("--accent", "#58a6ff");
        ctx.beginPath();
        ctx.moveTo(cx, padT);
        ctx.lineTo(cx, padT + plotH);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = cssVar("--text-bright", "#e6edf3");
        ctx.textAlign = "center";
        ctx.fillText(p.symbol + " " + fmtNum(p.spot, 0), cx, padT - 8);
      }

      var labelEvery = n > 24 ? 4 : n > 16 ? 2 : 1;
      if (i % labelEvery === 0) {
        ctx.fillStyle = text;
        ctx.textAlign = "center";
        ctx.fillText(String(s.strike), cx, h - 14);
      }
    });

    ctx.textAlign = "left";
    ctx.fillStyle = putC;
    ctx.fillRect(padL, h - 8, 10, 4);
    ctx.fillStyle = text;
    ctx.fillText(absMode ? "Put OI" : "Put OI chg", padL + 14, h - 5);
    ctx.fillStyle = callC;
    ctx.fillRect(padL + 110, h - 8, 10, 4);
    ctx.fillStyle = text;
    ctx.fillText(absMode ? "Call OI" : "Call OI chg", padL + 124, h - 5);
  }

  function renderChart() {
    var p = state.payload;
    if (!p) return;
    var from = idxClamped(p, state.fromIdx);
    var to = idxClamped(p, state.toIdx);
    if (from > to) { var tmp = from; from = to; to = tmp; }
    el("oi-time-from").textContent = fmtTimeLabel(p.times[from]);
    el("oi-time-to").textContent = fmtTimeLabel(p.times[to]);

    var rows = filteredStrikes(p);
    var absMode = state.view === "oi";
    var call = 0, put = 0;
    rows.forEach(function (r) {
      var ce0 = (r.call_oi || [])[from] || 0;
      var pe0 = (r.put_oi || [])[from] || 0;
      var ce1 = (r.call_oi || [])[to] || 0;
      var pe1 = (r.put_oi || [])[to] || 0;
      call += absMode ? ce1 : (ce1 - ce0);
      put += absMode ? pe1 : (pe1 - pe0);
    });
    el("oi-sum-call").textContent = absMode ? fmtCompact(call) : fmtSigned(call);
    el("oi-sum-put").textContent = absMode ? fmtCompact(put) : fmtSigned(put);
    el("oi-sum-call").className = call >= 0 ? "oi-up" : "oi-down";
    el("oi-sum-put").className = put >= 0 ? "oi-up" : "oi-down";
    var spot0 = (p.spot_series || [])[from];
    var spot1 = (p.spot_series || [])[to];
    el("oi-sum-start").textContent = fmtNum(spot0, 2);
    el("oi-sum-end").textContent = fmtNum(spot1, 2);
    document.querySelector("#oi-summary .oi-sum-cell:nth-child(1) span").textContent =
      absMode ? "Call OI" : "Call OI change";
    document.querySelector("#oi-summary .oi-sum-cell:nth-child(2) span").textContent =
      absMode ? "Put OI" : "Put OI change";

    el("oi-chart-title").textContent = absMode
      ? "Open Interest vs Strike"
      : ("OI Change on " + (p.session_label || ""));
    el("oi-pcr-badge").textContent = "PCR " + (p.pcr != null ? p.pcr : "—");
    el("oi-vix-badge").textContent = "INDIAVIX " + (p.india_vix != null ? fmtNum(p.india_vix, 1) : "—");
    el("oi-src-badge").textContent = "Data: " + (p.source === "live" ? "Live" : "Sample");
    el("oi-refreshed").textContent = "Last refreshed: " + new Date().toLocaleTimeString();
    drawChart();
  }

  function renderExpiries(payload) {
    var box = el("oi-expiry-list");
    if (!box) return;
    var selected = {};
    (payload.selected_expiries || []).forEach(function (d) { selected[d] = true; });
    box.innerHTML = (payload.expiries || []).map(function (e) {
      var days = "";
      try {
        var t = new Date(e.date + "T00:00:00");
        var n = Math.round((t - new Date()) / 86400000);
        days = " (" + Math.max(0, n) + " days)";
      } catch (_) {}
      return '<label class="oi-exp-item"><input type="checkbox" value="' + e.date + '"' +
        (selected[e.date] ? " checked" : "") + " /> " + e.label + days + "</label>";
    }).join("");
  }

  function selectedExpiries() {
    return Array.prototype.map.call(
      document.querySelectorAll("#oi-expiry-list input:checked"),
      function (c) { return c.value; }
    );
  }

  function setView(view) {
    state.view = view;
    document.querySelectorAll(".oi-subtab").forEach(function (b) {
      b.classList.toggle("active", b.dataset.oiView === view);
    });
    var built = view === "change" || view === "oi";
    el("oi-placeholder").classList.toggle("hidden", built);
    el("oi-chart-wrap").classList.toggle("hidden", !built);
    el("oi-time-block").classList.toggle("hidden", !built);
    el("oi-summary").classList.toggle("hidden", !built);
    if (built) renderChart();
  }

  async function loadOi(silent) {
    if (state.loading) return;
    state.loading = true;
    try {
      var body = {
        symbol: state.symbol,
        expiries: selectedExpiries(),
      };
      if (el("oi-range-mode") && document.querySelector("#oi-range-mode .oi-seg-btn.active") &&
          document.querySelector("#oi-range-mode .oi-seg-btn.active").dataset.mode === "custom") {
        var d = el("oi-custom-date").value;
        if (d) body.session_date = d;
      }
      var res = await fetch("/api/open-interest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      var data = await res.json();
      if (!data.success) throw new Error(data.message || "Failed to load OI");
      var keepPreset = state.preset;
      var keepFrom = state.fromIdx;
      var keepTo = state.toIdx;
      var had = !!state.payload;
      state.payload = data;
      var last = (data.times || []).length - 1;
      el("oi-slider-from").max = String(Math.max(0, last));
      el("oi-slider-to").max = String(Math.max(0, last));
      if (!had || !silent) {
        renderExpiries(data);
        applyPreset(keepPreset || "full");
      } else {
        state.fromIdx = Math.min(keepFrom, last);
        state.toIdx = Math.min(keepTo, last);
        el("oi-slider-from").value = String(state.fromIdx);
        el("oi-slider-to").value = String(state.toIdx);
        renderChart();
      }
      var search = el("oi-symbol-search");
      if (search && !search.value) search.value = data.symbol;
    } catch (e) {
      if (!silent) {
        el("oi-src-badge").textContent = "Error: " + e.message;
      }
    } finally {
      state.loading = false;
    }
  }

  async function loadUnderlyings() {
    try {
      var res = await fetch("/api/5paisa/option-chain/underlyings");
      var data = await res.json();
      state.underlyings = (data.underlyings || []).map(function (u) { return u.symbol; });
      if (!state.underlyings.length) {
        state.underlyings = ["NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY", "SENSEX"];
      }
    } catch (_) {
      state.underlyings = ["NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY", "SENSEX"];
    }
  }

  function renderSymbolDd(q) {
    var dd = el("oi-symbol-dd");
    var query = (q || "").toUpperCase();
    var items = state.underlyings.filter(function (s) {
      return !query || s.indexOf(query) !== -1;
    }).slice(0, 12);
    if (!items.length) {
      dd.classList.add("hidden");
      dd.innerHTML = "";
      return;
    }
    dd.innerHTML = items.map(function (s) {
      return "<li data-sym=\"" + s + "\">" + s + "</li>";
    }).join("");
    dd.classList.remove("hidden");
  }

  function startTimer() {
    stopTimer();
    state.timer = setInterval(function () {
      if (showPageActive()) loadOi(true);
    }, 15000);
  }

  function stopTimer() {
    if (state.timer) {
      clearInterval(state.timer);
      state.timer = null;
    }
  }

  function wire() {
    if (!el("page-open-interest")) return;

    el("oi-subtabs").addEventListener("click", function (e) {
      var btn = e.target.closest(".oi-subtab");
      if (btn) setView(btn.dataset.oiView);
    });

    el("oi-how-btn").addEventListener("click", function () {
      el("oi-howto").classList.toggle("hidden");
    });
    el("oi-show-oi").addEventListener("change", function () {
      state.showOi = el("oi-show-oi").checked;
      renderChart();
    });

    el("oi-atm-window").addEventListener("click", function (e) {
      var btn = e.target.closest(".oi-chip");
      if (!btn) return;
      state.atmN = btn.dataset.n === "all" ? "all" : parseInt(btn.dataset.n, 10);
      el("oi-atm-window").querySelectorAll(".oi-chip").forEach(function (b) {
        b.classList.toggle("active", b === btn);
      });
      el("oi-strike-min").value = "";
      el("oi-strike-max").value = "";
      renderChart();
    });

    el("oi-strike-reset").addEventListener("click", function () {
      el("oi-strike-min").value = "";
      el("oi-strike-max").value = "";
      renderChart();
    });
    el("oi-strike-min").addEventListener("change", renderChart);
    el("oi-strike-max").addEventListener("change", renderChart);

    el("oi-presets").addEventListener("click", function (e) {
      var btn = e.target.closest(".oi-chip");
      if (btn) applyPreset(btn.dataset.mins);
    });

    function onSlider() {
      state.fromIdx = parseInt(el("oi-slider-from").value, 10) || 0;
      state.toIdx = parseInt(el("oi-slider-to").value, 10) || 0;
      state.preset = "custom";
      document.querySelectorAll("#oi-presets .oi-chip").forEach(function (b) {
        b.classList.remove("active");
      });
      renderChart();
    }
    el("oi-slider-from").addEventListener("input", onSlider);
    el("oi-slider-to").addEventListener("input", onSlider);

    el("oi-range-mode").addEventListener("click", function (e) {
      var btn = e.target.closest(".oi-seg-btn");
      if (!btn) return;
      el("oi-range-mode").querySelectorAll(".oi-seg-btn").forEach(function (b) {
        b.classList.toggle("active", b === btn);
      });
      el("oi-custom-wrap").classList.toggle("hidden", btn.dataset.mode !== "custom");
      if (btn.dataset.mode === "intraday") loadOi(false);
    });
    el("oi-custom-date").addEventListener("change", function () { loadOi(false); });

    el("oi-expiry-list").addEventListener("change", function () { loadOi(false); });

    var search = el("oi-symbol-search");
    search.addEventListener("focus", function () { renderSymbolDd(search.value); });
    search.addEventListener("input", function () { renderSymbolDd(search.value); });
    search.addEventListener("keydown", function (e) {
      if (e.key === "Enter") {
        var first = el("oi-symbol-dd").querySelector("li");
        var sym = (first && first.dataset.sym) || search.value.trim().toUpperCase();
        if (sym) {
          state.symbol = sym;
          search.value = sym;
          el("oi-symbol-dd").classList.add("hidden");
          loadOi(false);
        }
      }
    });
    el("oi-symbol-dd").addEventListener("click", function (e) {
      var li = e.target.closest("li");
      if (!li) return;
      state.symbol = li.dataset.sym;
      search.value = state.symbol;
      el("oi-symbol-dd").classList.add("hidden");
      loadOi(false);
    });
    document.addEventListener("click", function (e) {
      if (!e.target.closest(".oi-search-group")) {
        el("oi-symbol-dd").classList.add("hidden");
      }
    });

    window.addEventListener("resize", function () {
      if (showPageActive()) drawChart();
    });

    document.querySelectorAll(".nav-item[data-page]").forEach(function (link) {
      link.addEventListener("click", function () {
        if (link.dataset.page === "open-interest") {
          if (!state.underlyings.length) {
            loadUnderlyings().then(function () { loadOi(false); });
          } else {
            loadOi(false);
          }
          startTimer();
        } else {
          stopTimer();
        }
      });
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", wire);
  } else {
    wire();
  }
})();
