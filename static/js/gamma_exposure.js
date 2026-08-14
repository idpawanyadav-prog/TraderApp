/* ── Gamma Exposure dashboard ── */
(function () {
  var el = function (id) { return document.getElementById(id); };
  var state = {
    payload: null,
    loading: false,
    timer: null,
    hoverIdx: -1,
    layout: null,
  };

  function showPageActive() {
    var page = el("page-gamma-exposure");
    return page && page.classList.contains("active");
  }

  function cssVar(name, fallback) {
    var v = getComputedStyle(document.documentElement).getPropertyValue(name);
    return (v && v.trim()) || fallback;
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

  function showMsg(msg, isError) {
    var box = el("gx-msg");
    if (!box) return;
    box.textContent = msg;
    box.className = "message-box " + (isError ? "error" : "success");
    box.classList.remove("hidden");
    setTimeout(function () { box.classList.add("hidden"); }, 7000);
  }

  function hitBarIndex(evt) {
    var layout = state.layout;
    var canvas = el("gx-chart");
    if (!layout || !canvas || !layout.series.length) return -1;
    var rect = canvas.getBoundingClientRect();
    var x = evt.clientX - rect.left;
    if (x < layout.padL || x > layout.padL + layout.plotW) return -1;
    var i = Math.floor((x - layout.padL) / layout.slot);
    if (i < 0 || i >= layout.series.length) return -1;
    return i;
  }

  function hideTooltip() {
    var t = el("gx-tooltip");
    if (t) t.classList.add("hidden");
    if (state.hoverIdx !== -1) {
      state.hoverIdx = -1;
      drawChart();
    }
  }

  function showTooltip(evt, idx) {
    var t = el("gx-tooltip");
    var p = state.payload;
    if (!t || !p) return;
    var r = p.strikes[idx];
    if (!r) return;
    t.innerHTML =
      "<b>" + fmtNum(r.strike, 0) + "</b>" +
      "<div>Call GEX " + fmtSigned(r.call_gex) + "</div>" +
      "<div>Put GEX " + fmtSigned(r.put_gex) + "</div>" +
      "<div>Net " + fmtSigned(r.net_gex) + "</div>" +
      "<div>Call OI chg " + fmtSigned(r.call_oi_chg) + " · Put OI chg " + fmtSigned(r.put_oi_chg) + "</div>";
    t.classList.remove("hidden");
    var wrap = el("gx-chart-wrap");
    var rect = wrap.getBoundingClientRect();
    t.style.left = Math.min(evt.clientX - rect.left + 12, wrap.clientWidth - 180) + "px";
    t.style.top = Math.max(8, evt.clientY - rect.top - 70) + "px";
  }

  function xOfStrike(strike, padL, plotW, lo, hi) {
    if (hi === lo) return padL + plotW / 2;
    return padL + ((strike - lo) / (hi - lo)) * plotW;
  }

  function drawChart() {
    var canvas = el("gx-chart");
    var wrap = el("gx-chart-wrap");
    if (!canvas || !wrap) return;
    var p = state.payload;
    var ctx = canvas.getContext("2d");
    var dpr = window.devicePixelRatio || 1;
    var w = wrap.clientWidth || 800;
    var h = 420;
    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
    canvas.style.width = w + "px";
    canvas.style.height = h + "px";
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (!p || !(p.strikes || []).length) return;

    var series = p.strikes;
    var padL = 62, padR = 18, padT = 28, padB = 44;
    var plotW = w - padL - padR;
    var plotH = h - padT - padB;
    var maxAbs = 1;
    series.forEach(function (s) {
      maxAbs = Math.max(maxAbs, Math.abs(s.call_gex), Math.abs(s.put_gex), Math.abs(s.net_gex));
    });
    var yMax = maxAbs * 1.15;
    function yx(v) {
      return padT + plotH / 2 - (v / yMax) * (plotH / 2);
    }
    var text = cssVar("--muted", "#8b949e");
    var grid = cssVar("--border", "#30363d");
    var callC = "#3dd68c";
    var putC = "#f87171";
    var netC = "#58a6ff";
    var lo = series[0].strike;
    var hi = series[series.length - 1].strike;

    ctx.fillStyle = "rgba(61, 214, 140, 0.06)";
    ctx.fillRect(padL, padT, plotW, plotH / 2);
    ctx.fillStyle = "rgba(248, 113, 113, 0.06)";
    ctx.fillRect(padL, padT + plotH / 2, plotW, plotH / 2);

    ctx.fillStyle = text;
    ctx.font = "10px Segoe UI, sans-serif";
    ctx.textAlign = "left";
    ctx.fillText("Positive gamma", padL + 6, padT + 14);
    ctx.fillText("Negative gamma", padL + 6, padT + plotH - 8);

    ctx.strokeStyle = grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    var zeroY = padT + plotH / 2;
    ctx.moveTo(padL, zeroY);
    ctx.lineTo(padL + plotW, zeroY);
    ctx.stroke();

    ctx.fillStyle = text;
    ctx.font = "11px Segoe UI, sans-serif";
    ctx.textAlign = "right";
    [-1, -0.5, 0, 0.5, 1].forEach(function (t) {
      var y = padT + plotH / 2 - t * (plotH / 2);
      ctx.fillText(fmtCompact(t * yMax), padL - 8, y + 4);
    });

    var n = series.length;
    var slot = plotW / n;
    var barW = Math.max(2, Math.min(12, slot * 0.28));
    state.layout = { series: series, padL: padL, plotW: plotW, slot: slot };

    series.forEach(function (s, i) {
      var cx = padL + slot * i + slot / 2;
      if (i === state.hoverIdx) {
        ctx.fillStyle = "rgba(88, 166, 255, 0.10)";
        ctx.fillRect(padL + slot * i, padT, slot, plotH);
      }
      ctx.fillStyle = callC;
      var yCall = yx(s.call_gex);
      ctx.fillRect(cx - barW - 1, Math.min(yCall, zeroY), barW, Math.abs(zeroY - yCall) || 1);
      ctx.fillStyle = putC;
      var yPut = yx(s.put_gex);
      ctx.fillRect(cx + 1, Math.min(yPut, zeroY), barW, Math.abs(zeroY - yPut) || 1);

      var labelEvery = n > 24 ? 4 : n > 16 ? 2 : 1;
      if (i % labelEvery === 0) {
        ctx.fillStyle = text;
        ctx.textAlign = "center";
        ctx.fillText(String(s.strike), cx, h - 14);
      }
    });

    ctx.beginPath();
    ctx.strokeStyle = netC;
    ctx.lineWidth = 2;
    series.forEach(function (s, i) {
      var cx = padL + slot * i + slot / 2;
      var y = yx(s.net_gex);
      if (i === 0) ctx.moveTo(cx, y);
      else ctx.lineTo(cx, y);
    });
    ctx.stroke();

    if (p.spot != null) {
      var sx = xOfStrike(p.spot, padL, plotW, lo, hi);
      ctx.setLineDash([5, 4]);
      ctx.strokeStyle = cssVar("--text-bright", "#e6edf3");
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.moveTo(sx, padT);
      ctx.lineTo(sx, padT + plotH);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = cssVar("--text-bright", "#e6edf3");
      ctx.textAlign = "center";
      ctx.font = "11px Segoe UI, sans-serif";
      ctx.fillText("Spot " + fmtNum(p.spot, 0), sx, padT - 8);
    }

    if (p.gamma_flip != null) {
      var fx = xOfStrike(p.gamma_flip, padL, plotW, lo, hi);
      ctx.setLineDash([2, 4]);
      ctx.strokeStyle = "#ffa657";
      ctx.beginPath();
      ctx.moveTo(fx, padT);
      ctx.lineTo(fx, padT + plotH);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = "#ffa657";
      ctx.textAlign = "center";
      ctx.fillText("Flip " + fmtNum(p.gamma_flip, 0), fx, padT + plotH + 28);
    }
  }

  function renderZones(p) {
    var box = el("gx-zones");
    if (!box) return;
    var bits = [];
    (p.positive_zones || []).forEach(function (z) {
      bits.push('<span class="gx-zone gx-zone-pos">+GEX ' +
        fmtNum(z.from, 0) + "–" + fmtNum(z.to, 0) +
        " (peak " + fmtNum(z.peak_strike, 0) + ")</span>");
    });
    (p.negative_zones || []).forEach(function (z) {
      bits.push('<span class="gx-zone gx-zone-neg">−GEX ' +
        fmtNum(z.from, 0) + "–" + fmtNum(z.to, 0) +
        " (peak " + fmtNum(z.peak_strike, 0) + ")</span>");
    });
    box.innerHTML = bits.join("") || "";
  }

  function renderInterp(p) {
    var body = el("gx-interp-body");
    if (!body) return;
    body.innerHTML = (p.interpretations || []).map(function (r) {
      return "<tr class=\"" + (r.active ? "gx-row-active" : "") + "\">" +
        "<td>" + r.condition + "</td>" +
        "<td>" + r.interpretation + "</td>" +
        "<td>" + r.expected + "</td></tr>";
    }).join("");
  }

  function renderRegime(p) {
    var r = p.regime || {};
    var signed = r.signed_score;
    var num = el("gx-score-num");
    num.textContent = signed == null ? "—" : ((signed > 0 ? "+" : "") + signed);
    num.className = "gx-score-num " + (signed > 12 ? "gx-pos" : signed < -12 ? "gx-neg" : "");
    el("gx-score-name").textContent = r.regime || "—";
    var fill = el("gx-meter-fill");
    var pct = r.score == null ? 50 : r.score;
    fill.style.width = pct + "%";
    fill.className = "gx-meter-fill " + (pct >= 62 ? "pos" : pct <= 38 ? "neg" : "mix");
    el("gx-expected").textContent = r.expected_behaviour || "—";
    el("gx-kv-spot").textContent = fmtNum(p.spot, 2);
    el("gx-kv-flip").textContent = p.gamma_flip != null ? fmtNum(p.gamma_flip, 2) : "—";
    el("gx-kv-pos").textContent = p.major_pos_strike != null ? fmtNum(p.major_pos_strike, 0) : "—";
    el("gx-kv-neg").textContent = p.major_neg_strike != null ? fmtNum(p.major_neg_strike, 0) : "—";
    el("gx-kv-bias").textContent = r.bias || "—";
    el("gx-kv-vol").textContent = (r.volatility || "—") + (r.iv_label && r.iv_label !== "—" ? " · " + r.iv_label : "");
    el("gx-kv-brk").textContent = r.breakout_risk || "—";
    var chg = r.gex_change_pct != null
      ? fmtSigned(r.gex_change) + " (" + (r.gex_change_pct > 0 ? "+" : "") + r.gex_change_pct + "%)"
      : fmtSigned(r.gex_change);
    el("gx-kv-chg").textContent = chg;

    var says = el("gx-says");
    var tag = r.signal && r.signal.regime_says;
    if (tag === "trend") says.textContent = "Gamma says TREND";
    else if (tag === "range") says.textContent = "Gamma says RANGE";
    else says.textContent = "Gamma says MIXED";
    says.className = "gx-says gx-says-" + (tag || "mixed");

    var sig = r.signal || {};
    el("gx-sig-label").textContent = sig.label || "—";
    el("gx-sig-label").className = "gx-sig-label " + (sig.side || "");
    var meta = [];
    if (sig.setup) meta.push(sig.setup);
    if (sig.confidence) meta.push("Confidence " + sig.confidence);
    el("gx-sig-meta").textContent = meta.join(" · ");
    el("gx-sig-reasons").innerHTML = (sig.reasons || []).map(function (x) {
      return "<li>" + x + "</li>";
    }).join("");
  }

  function render(p) {
    el("gx-spot").textContent = fmtNum(p.spot, 2);
    el("gx-net").textContent = fmtSigned(p.net_gex);
    el("gx-net").className = p.net_gex >= 0 ? "gx-pos" : "gx-neg";
    el("gx-call").textContent = fmtSigned(p.call_gex);
    el("gx-put").textContent = fmtSigned(p.put_gex);
    el("gx-flip").textContent = p.gamma_flip != null ? fmtNum(p.gamma_flip, 2) : "—";
    el("gx-maxk").textContent = p.max_gamma_strike != null ? fmtNum(p.max_gamma_strike, 0) : "—";
    el("gx-maj-pos").textContent = p.major_pos_strike != null ? fmtNum(p.major_pos_strike, 0) : "—";
    el("gx-maj-neg").textContent = p.major_neg_strike != null ? fmtNum(p.major_neg_strike, 0) : "—";
    el("gx-src-badge").textContent = "Data: " + (p.source === "live" ? "Live" : "Sample");
    el("gx-greeks-badge").textContent = "Greeks: " + (p.greeks_source || "—");
    el("gx-pcr-badge").textContent = "PCR " + (p.pcr != null ? p.pcr : "—");
    el("gx-refreshed").textContent = "Last refreshed: " + (p.updated || new Date().toLocaleTimeString());
    renderZones(p);
    renderInterp(p);
    renderRegime(p);
    drawChart();
  }

  async function loadExpiries() {
    var symbol = el("gx-symbol").value;
    var sel = el("gx-expiry");
    if (!symbol || !sel) return;
    sel.innerHTML = '<option value="">Loading…</option>';
    try {
      var res = await fetch("/api/5paisa/option-chain/expiries?symbol=" + encodeURIComponent(symbol));
      var data = await res.json();
      var dates = (data.expiries || []);
      if (!dates.length) {
        sel.innerHTML = '<option value="">No expiries (sample OK)</option>';
        return;
      }
      sel.innerHTML = dates.map(function (d, i) {
        return '<option value="' + d + '"' + (i === 0 ? " selected" : "") + ">" + d + "</option>";
      }).join("");
    } catch (_) {
      sel.innerHTML = '<option value="">—</option>';
    }
  }

  async function loadUnderlyings() {
    var sel = el("gx-symbol");
    if (!sel) return;
    try {
      var res = await fetch("/api/5paisa/option-chain/underlyings");
      var data = await res.json();
      if (!data.success || !(data.underlyings || []).length) return;
      var preferred = ["NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY", "SENSEX"];
      var items = data.underlyings.slice();
      items.sort(function (a, b) {
        var ia = preferred.indexOf(a.symbol);
        var ib = preferred.indexOf(b.symbol);
        if (ia === -1) ia = 999;
        if (ib === -1) ib = 999;
        if (ia !== ib) return ia - ib;
        return b.contracts - a.contracts;
      });
      var current = sel.value || "NIFTY";
      sel.innerHTML = "";
      items.forEach(function (u) {
        var opt = document.createElement("option");
        opt.value = u.symbol;
        opt.textContent = u.symbol;
        if (u.symbol === current) opt.selected = true;
        sel.appendChild(opt);
      });
      if (!sel.value && items.length) sel.value = items[0].symbol;
    } catch (_) {}
  }

  function setRefreshing(on) {
    var b = el("gx-load-btn");
    if (!b) return;
    b.disabled = on;
    b.textContent = on ? "Loading…" : "Load GEX";
  }

  async function loadGex(silent) {
    if (silent && state.loading) return;
    state.loading = true;
    if (!silent) setRefreshing(true);
    try {
      var body = {
        symbol: el("gx-symbol").value || "NIFTY",
        expiry: el("gx-expiry").value || "",
        strike_window: parseInt(el("gx-window").value, 10) || 18,
      };
      var res = await fetch("/api/gamma-exposure", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      var data = await res.json();
      if (!data.success) {
        showMsg(data.message || "Failed to load GEX.", true);
        return;
      }
      state.payload = data;
      if (data.source_note && data.source === "mock" && !silent) {
        showMsg(data.source_note, false);
      }
      render(data);
    } catch (e) {
      showMsg(String(e), true);
    } finally {
      state.loading = false;
      if (!silent) setRefreshing(false);
    }
  }

  function setAuto(on) {
    if (state.timer) {
      clearInterval(state.timer);
      state.timer = null;
    }
    if (on) {
      state.timer = setInterval(function () {
        if (showPageActive()) loadGex(true);
      }, 15000);
    }
  }

  function wire() {
    if (!el("gx-symbol")) return;
    el("gx-symbol").addEventListener("change", function () {
      loadExpiries().then(function () { loadGex(false); });
    });
    el("gx-expiry").addEventListener("change", function () { loadGex(false); });
    el("gx-load-btn").addEventListener("click", function () { loadGex(false); });
    el("gx-auto-refresh").addEventListener("change", function () {
      setAuto(el("gx-auto-refresh").checked);
    });
    var canvas = el("gx-chart");
    if (canvas) {
      canvas.addEventListener("mousemove", function (evt) {
        var idx = hitBarIndex(evt);
        if (idx < 0) { hideTooltip(); return; }
        if (idx !== state.hoverIdx) {
          state.hoverIdx = idx;
          drawChart();
        }
        showTooltip(evt, idx);
      });
      canvas.addEventListener("mouseleave", hideTooltip);
    }
    window.addEventListener("resize", function () {
      if (state.payload) drawChart();
    });
    document.querySelectorAll(".nav-item[data-page]").forEach(function (link) {
      link.addEventListener("click", function () {
        if (link.dataset.page === "gamma-exposure") {
          if (!el("gx-symbol").dataset.loaded) {
            el("gx-symbol").dataset.loaded = "1";
            loadUnderlyings().then(loadExpiries).then(function () { loadGex(false); });
          } else if (!state.payload) {
            loadGex(false);
          } else {
            drawChart();
          }
        } else {
          setAuto(false);
          if (el("gx-auto-refresh")) el("gx-auto-refresh").checked = false;
        }
      });
    });
  }

  window._gammaExposureApplyTheme = function () {
    if (state.payload) drawChart();
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", wire);
  } else {
    wire();
  }
})();
