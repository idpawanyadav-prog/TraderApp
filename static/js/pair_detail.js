/* ── Pair Detail Dashboard ── */
(function () {

  var el = function (id) { return document.getElementById(id); };
  var _detail = null;

  // Theme-aware palette for canvas drawing
  function pal() {
    var light = document.documentElement.getAttribute("data-theme") === "light";
    return {
      text:   light ? "#57606a" : "#8b949e",
      grid:   light ? "#eaeef2" : "#21262d",
      axis:   light ? "#d0d7de" : "#30363d",
      blue:   light ? "#0969da" : "#58a6ff",
      orange: "#f0883e",
      green:  light ? "#1a7f37" : "#3fb950",
      red:    light ? "#cf222e" : "#f85149",
      purple: light ? "#8250df" : "#bc8cff",
      yellow: light ? "#9a6700" : "#d29922",
      fill:   light ? "rgba(9,105,218,0.10)" : "rgba(88,166,255,0.10)",
    };
  }

  // ── Tiny canvas line-chart helper ────────────────────────────
  function sizeCanvas(cv) {
    var dpr = window.devicePixelRatio || 1;
    var w = cv.parentElement.clientWidth - 8;
    var hAttr = parseInt(cv.getAttribute("height")) || 200;
    cv.style.width = w + "px";
    cv.style.height = hAttr + "px";
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(hAttr * dpr);
    var ctx = cv.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx: ctx, w: w, h: hAttr };
  }

  function fmtDate(ts) {
    var d = new Date(ts * 1000);
    var mo = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    return mo[d.getUTCMonth()] + " '" + String(d.getUTCFullYear()).slice(2);
  }

  // Generic renderer: series = [{data, color, width, dash, fill}], hlines = [{y, color, dash, label}]
  function drawChart(cvId, times, series, opts) {
    opts = opts || {};
    var cv = el(cvId);
    if (!cv) return;
    var s = sizeCanvas(cv), ctx = s.ctx, W = s.w, H = s.h;
    var P = pal();
    var padL = 46, padR = opts.padR || 54, padT = 10, padB = 22;
    var pw = W - padL - padR, ph = H - padT - padB;
    ctx.clearRect(0, 0, W, H);

    // y-extent over all series + hlines
    var lo = Infinity, hi = -Infinity;
    series.forEach(function (sr) {
      sr.data.forEach(function (v) {
        if (v !== null && isFinite(v)) { if (v < lo) lo = v; if (v > hi) hi = v; }
      });
    });
    (opts.hlines || []).forEach(function (h) {
      if (isFinite(h.y)) { if (h.y < lo) lo = h.y; if (h.y > hi) hi = h.y; }
    });
    if (!isFinite(lo) || !isFinite(hi)) return;
    if (opts.yMin !== undefined) lo = Math.min(lo, opts.yMin);
    if (opts.yMax !== undefined) hi = Math.max(hi, opts.yMax);
    var span = hi - lo || 1;
    lo -= span * 0.06; hi += span * 0.06; span = hi - lo;

    var X = function (i) { return padL + pw * (times.length <= 1 ? 0 : i / (times.length - 1)); };
    var Y = function (v) { return padT + ph * (1 - (v - lo) / span); };

    // grid + y labels
    ctx.strokeStyle = P.grid; ctx.fillStyle = P.text;
    ctx.font = "10px 'Segoe UI', sans-serif"; ctx.lineWidth = 1;
    var ticks = 4;
    for (var g = 0; g <= ticks; g++) {
      var yv = lo + span * g / ticks, yy = Y(yv);
      ctx.beginPath(); ctx.moveTo(padL, yy); ctx.lineTo(W - padR, yy); ctx.stroke();
      ctx.textAlign = "right";
      ctx.fillText(yv.toFixed(opts.dp !== undefined ? opts.dp : 2), padL - 5, yy + 3);
    }
    // x labels (~6)
    ctx.textAlign = "center";
    var step = Math.max(1, Math.floor(times.length / 6));
    for (var i = 0; i < times.length; i += step) {
      ctx.fillText(fmtDate(times[i]), X(i), H - 6);
    }

    // hlines
    (opts.hlines || []).forEach(function (h) {
      ctx.strokeStyle = h.color; ctx.setLineDash(h.dash || [5, 4]); ctx.lineWidth = 1;
      var yy = Y(h.y);
      ctx.beginPath(); ctx.moveTo(padL, yy); ctx.lineTo(W - padR, yy); ctx.stroke();
      ctx.setLineDash([]);
      if (h.label) {
        ctx.fillStyle = h.color; ctx.textAlign = "left";
        ctx.fillText(h.label, W - padR + 4, yy + 3);
      }
    });

    // series lines
    series.forEach(function (sr) {
      ctx.strokeStyle = sr.color; ctx.lineWidth = sr.width || 1.4;
      ctx.setLineDash(sr.dash || []);
      ctx.beginPath();
      var started = false;
      sr.data.forEach(function (v, i) {
        if (v === null || !isFinite(v)) { started = false; return; }
        var x = X(i), y = Y(v);
        if (!started) { ctx.moveTo(x, y); started = true; }
        else ctx.lineTo(x, y);
      });
      ctx.stroke(); ctx.setLineDash([]);
      // last-value tag
      if (sr.tag) {
        var lastIdx = sr.data.length - 1;
        while (lastIdx >= 0 && (sr.data[lastIdx] === null || !isFinite(sr.data[lastIdx]))) lastIdx--;
        if (lastIdx >= 0) {
          var ly = Y(sr.data[lastIdx]);
          ctx.fillStyle = sr.color;
          ctx.fillRect(W - padR + 2, ly - 8, padR - 6, 15);
          ctx.fillStyle = "#fff"; ctx.textAlign = "center";
          ctx.fillText(Number(sr.data[lastIdx]).toFixed(opts.dp !== undefined ? opts.dp : 2),
                       W - padR / 2, ly + 3);
        }
      }
    });

    // markers: {idx, type:'up'|'down'|'circle', color}
    (opts.markers || []).forEach(function (mk) {
      var v = (opts.markerSeries || series[0].data)[mk.idx];
      if (v === null || !isFinite(v)) return;
      var x = X(mk.idx), y = Y(v);
      ctx.fillStyle = mk.color; ctx.strokeStyle = mk.color;
      if (mk.type === "up") {
        ctx.beginPath(); ctx.moveTo(x, y + 9); ctx.lineTo(x - 5, y + 17); ctx.lineTo(x + 5, y + 17); ctx.fill();
      } else if (mk.type === "down") {
        ctx.beginPath(); ctx.moveTo(x, y - 9); ctx.lineTo(x - 5, y - 17); ctx.lineTo(x + 5, y - 17); ctx.fill();
      } else {
        ctx.beginPath(); ctx.arc(x, y, 4, 0, Math.PI * 2); ctx.stroke();
      }
    });

    return { X: X, Y: Y, ctx: ctx, W: W, H: H, padL: padL, padR: padR };
  }

  // Density distribution: filled normal curve + cut regions + markers
  function drawDistribution(d) {
    var cv = el("pd-c-dist");
    if (!cv || !d || !d.x) return;
    var s = sizeCanvas(cv), ctx = s.ctx, W = s.w, H = s.h;
    var P = pal();
    var padL = 34, padR = 14, padT = 26, padB = 22;
    var pw = W - padL - padR, ph = H - padT - padB;
    ctx.clearRect(0, 0, W, H);
    var xs = d.x, pdf = d.pdf;
    var xmin = xs[0], xmax = xs[xs.length - 1];
    var pmax = Math.max.apply(null, pdf);
    var X = function (x) { return padL + pw * (x - xmin) / (xmax - xmin); };
    var Y = function (p) { return padT + ph * (1 - p / (pmax * 1.08)); };

    // filled curve
    ctx.beginPath();
    ctx.moveTo(X(xs[0]), Y(0));
    xs.forEach(function (x, i) { ctx.lineTo(X(x), Y(pdf[i])); });
    ctx.lineTo(X(xs[xs.length - 1]), Y(0));
    ctx.closePath();
    ctx.fillStyle = P.fill; ctx.fill();
    ctx.strokeStyle = P.blue; ctx.lineWidth = 1.6;
    ctx.beginPath();
    xs.forEach(function (x, i) { i ? ctx.lineTo(X(x), Y(pdf[i])) : ctx.moveTo(X(x), Y(pdf[i])); });
    ctx.stroke();

    // tail fills beyond cuts
    function tail(from, to, color) {
      ctx.beginPath(); var began = false;
      xs.forEach(function (x, i) {
        if (x >= from && x <= to) {
          if (!began) { ctx.moveTo(X(x), Y(0)); began = true; }
          ctx.lineTo(X(x), Y(pdf[i]));
        }
      });
      if (!began) return;
      ctx.lineTo(X(Math.min(to, xmax)), Y(0)); ctx.closePath();
      ctx.fillStyle = color; ctx.fill();
    }
    tail(xmin, d.lower_cut, "rgba(63,185,80,0.35)");
    tail(d.upper_cut, xmax, "rgba(248,81,73,0.35)");

    // mean + current markers
    ctx.setLineDash([5, 4]); ctx.lineWidth = 1;
    ctx.strokeStyle = P.text;
    ctx.beginPath(); ctx.moveTo(X(d.mean), padT); ctx.lineTo(X(d.mean), Y(0)); ctx.stroke();
    ctx.strokeStyle = P.red;
    ctx.beginPath(); ctx.moveTo(X(d.current), padT); ctx.lineTo(X(d.current), Y(0)); ctx.stroke();
    ctx.setLineDash([]);
    ctx.font = "10px 'Segoe UI', sans-serif";
    ctx.fillStyle = P.text; ctx.textAlign = "center";
    ctx.fillText("Mean " + d.mean.toFixed(4), X(d.mean), padT - 12);
    ctx.fillStyle = P.red;
    ctx.fillText("Current " + d.current.toFixed(4), X(d.current), padT - 2);

    // x labels
    ctx.fillStyle = P.text;
    for (var g = 0; g <= 4; g++) {
      var xv = xmin + (xmax - xmin) * g / 4;
      ctx.fillText(xv.toFixed(2), X(xv), H - 6);
    }
  }

  // Semicircle gauge for signal strength
  function drawGauge(score) {
    var cv = el("pd-gauge");
    if (!cv) return;
    var ctx = cv.getContext("2d");
    var dpr = window.devicePixelRatio || 1;
    cv.width = 150 * dpr; cv.height = 88 * dpr;
    cv.style.width = "150px"; cv.style.height = "88px";
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, 150, 88);
    var cx = 75, cy = 78, r = 58;
    var segs = [[0, 0.4, "#f85149"], [0.4, 0.65, "#f0883e"], [0.65, 0.85, "#d29922"], [0.85, 1, "#3fb950"]];
    segs.forEach(function (sg) {
      ctx.beginPath();
      ctx.arc(cx, cy, r, Math.PI * (1 + sg[0]), Math.PI * (1 + sg[1]));
      ctx.lineWidth = 12; ctx.strokeStyle = sg[2]; ctx.stroke();
    });
    // needle
    var ang = Math.PI * (1 + (score || 0) / 100);
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + (r - 16) * Math.cos(ang), cy + (r - 16) * Math.sin(ang));
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = pal().text; ctx.stroke();
    ctx.beginPath(); ctx.arc(cx, cy, 4, 0, Math.PI * 2);
    ctx.fillStyle = pal().text; ctx.fill();
    // score text
    ctx.font = "700 20px 'Segoe UI', sans-serif";
    ctx.fillStyle = score >= 85 ? "#3fb950" : score >= 65 ? "#d29922" : score >= 40 ? "#f0883e" : "#f85149";
    ctx.textAlign = "center";
    ctx.fillText(score !== null && score !== undefined ? Math.round(score) : "—", cx, cy - 12);
  }

  // ── Render everything from a detail payload ──────────────────
  function fmtN(v, dp) { return v === null || v === undefined ? "—" : Number(v).toFixed(dp); }

  function tagFor(metric, v) {
    if (v === null || v === undefined) return "";
    switch (metric) {
      case "density": return v >= 0.95 || v <= 0.05 ? "Very High" : v >= 0.85 || v <= 0.15 ? "High" : "Normal";
      case "z": return Math.abs(v) >= 2.5 ? "Very Strong" : Math.abs(v) >= 2 ? "Strong" : Math.abs(v) >= 1 ? "Moderate" : "Low";
      case "corr": return v >= 0.9 ? "Very Strong" : v >= 0.8 ? "Strong" : v >= 0.6 ? "Moderate" : "Weak";
    }
    return "";
  }

  function render(detail) {
    _detail = detail;
    var sm = detail.summary, P = pal();
    el("pd-loading").classList.add("hidden");
    el("pd-dash").classList.remove("hidden");

    el("pd-sym1").textContent = sm.instrument1;
    el("pd-sym2").textContent = sm.instrument2;
    el("pd-sector").textContent = sm.sector || "—";
    var iv = detail.params.interval;
    el("pd-interval").textContent = iv === "D" ? "Daily" : iv + " min";
    el("pd-period").textContent = detail.params.from_date + " to " + detail.params.to_date;
    el("pd-ratio-title").textContent = "2. Price Ratio (" + sm.instrument1 + " / " + sm.instrument2 + ")";

    el("pd-m-density").textContent = sm.density === null ? "—" : (sm.density * 100).toFixed(2) + "%";
    el("pd-m-density-tag").textContent = tagFor("density", sm.density);
    el("pd-m-z").textContent = sm.z_score === null ? "—" : (sm.z_score > 0 ? "+" : "") + sm.z_score.toFixed(2);
    el("pd-m-z-tag").textContent = tagFor("z", sm.z_score);
    el("pd-m-corr").textContent = fmtN(sm.correlation, 2);
    el("pd-m-corr-tag").textContent = tagFor("corr", sm.correlation);
    el("pd-m-rcorr").textContent = fmtN(sm.rolling_correlation, 2);
    el("pd-m-rcorr-tag").textContent = tagFor("corr", sm.rolling_correlation);
    el("pd-m-hl").textContent = sm.half_life === null ? "—" : Math.round(sm.half_life);

    drawGauge(sm.signal_strength);
    el("pd-gauge-label").textContent = sm.signal_label || "—";

    var reco = el("pd-reco");
    if (sm.recommendation && sm.recommendation !== "No Action") {
      var parts = sm.recommendation.split(" / ");
      reco.innerHTML = '<div class="pd-reco-sell">' +
        (parts[0].indexOf("SELL") === 0 ? parts[0] : parts[1]) + "</div>" +
        '<div class="pd-reco-buy">' +
        (parts[0].indexOf("BUY") === 0 ? parts[0] : parts[1]) + "</div>";
      el("pd-reco-sub").textContent = "Mean Reversion Expected";
    } else {
      reco.innerHTML = '<div class="pd-reco-none">No Action</div>';
      el("pd-reco-sub").textContent = "";
    }

    var t = detail.time;

    drawChart("pd-c-norm", t, [
      { data: detail.norm1, color: P.blue, tag: true },
      { data: detail.norm2, color: P.orange, tag: true },
    ], { dp: 1 });

    var hl = [];
    if (detail.bands.mean !== undefined) {
      hl = [
        { y: detail.bands.p2sd, color: P.red,    label: fmtN(detail.bands.p2sd, 4) },
        { y: detail.bands.p1sd, color: P.orange, label: fmtN(detail.bands.p1sd, 4) },
        { y: detail.bands.mean, color: P.text,   label: fmtN(detail.bands.mean, 4) },
        { y: detail.bands.m1sd, color: P.green,  label: fmtN(detail.bands.m1sd, 4) },
        { y: detail.bands.m2sd, color: P.green,  label: fmtN(detail.bands.m2sd, 4) },
      ];
    }
    drawChart("pd-c-ratio", t, [
      { data: detail.ratio, color: P.green, tag: true },
    ], { hlines: hl, dp: 4, padR: 62 });

    drawDistribution(detail.distribution);

    drawChart("pd-c-rcorr", t, [
      { data: detail.rolling_corr, color: P.yellow, tag: true },
    ], { dp: 2, yMax: 1.0 });

    drawChart("pd-c-z", t, [
      { data: detail.zscore, color: P.purple, tag: true },
    ], {
      dp: 1,
      hlines: [
        { y: 2,  color: P.red,   label: "SELL" },
        { y: 0,  color: P.text },
        { y: -2, color: P.green, label: "BUY" },
      ],
    });

    var markers = [];
    (detail.signals.entries || []).forEach(function (i) {
      markers.push({ idx: i, type: "up", color: P.green });
    });
    (detail.signals.exits || []).forEach(function (i) {
      markers.push({ idx: i, type: "down", color: P.red });
    });
    drawChart("pd-c-sig", t, [
      { data: detail.zscore, color: P.purple, tag: true },
    ], {
      dp: 1,
      hlines: [
        { y: 2,  color: P.red,   label: "+2 Entry" },
        { y: 0,  color: P.text,  label: "Exit (0)" },
        { y: -2, color: P.green, label: "-2 Entry" },
      ],
      markers: markers,
      markerSeries: detail.zscore,
      padR: 62,
    });

    // Stats table
    var check = '<span class="pd-ok">✔</span>';
    var stats = [
      ["Correlation (Full Period)", fmtN(sm.correlation, 2)],
      ["Rolling Correlation (" + detail.params.rolling_window + ")", fmtN(sm.rolling_correlation, 2)],
      ["Density (Current)", sm.density === null ? "—" : (sm.density * 100).toFixed(2) + "%"],
      ["Z Score (Current)", sm.z_score === null ? "—" : (sm.z_score > 0 ? "+" : "") + sm.z_score.toFixed(2)],
      ["Cointegration (p-value)", sm.coint_pvalue === null ? "—"
        : sm.coint_pvalue.toFixed(4) + (sm.coint_pvalue <= 0.05 ? ' <span class="pd-pass">PASS</span>' : ' <span class="pd-fail">FAIL</span>')],
      ["Half Life", sm.half_life === null ? "—" : Math.round(sm.half_life) + " Bars"],
      ["Hurst Exponent", fmtN(sm.hurst, 2)],
      ["Volatility Ratio", fmtN(sm.volatility_ratio, 2)],
      ["Expected Reversion", sm.expected_reversion_bars === null ? "—" : Math.round(sm.expected_reversion_bars) + " Bars"],
      ["Historical Win Rate", sm.historical_win_pct === null ? "—" : sm.historical_win_pct + "%"],
      ["Bars Used", sm.bars_used],
      ["Last Updated", sm.last_updated],
    ];
    el("pd-stats").innerHTML = stats.map(function (r) {
      return "<tr><td>" + r[0] + "</td><td class=\"num\">" + r[1] + " " + check + "</td></tr>";
    }).join("");

    // Breakdown table
    el("pd-breakdown").innerHTML =
      "<tr><th>Factor</th><th>Score</th><th>Weight</th><th>Contrib.</th></tr>" +
      (detail.breakdown || []).map(function (b) {
        var barColor = b.score >= 0.85 ? "#3fb950" : b.score >= 0.6 ? "#d29922" : "#f0883e";
        return "<tr><td>" + b.factor + "</td>" +
          "<td><div class=\"pd-bar\"><div class=\"pd-bar-fill\" style=\"width:" + (b.score * 100) + "%;background:" + barColor + "\"></div></div> " + b.score.toFixed(2) + "</td>" +
          "<td class=\"num\">" + b.weight + "%</td>" +
          "<td class=\"num\">" + b.contribution.toFixed(1) + "</td></tr>";
      }).join("");
    el("pd-total").innerHTML = "TOTAL SCORE &nbsp; <b>" +
      (sm.signal_strength !== null ? Math.round(sm.signal_strength) : "—") + "</b> / 100";
  }

  // ── Loading a pair (called from the screener grid) ───────────
  window._openPairDetail = async function (req) {
    // Navigate to the page
    document.querySelectorAll(".nav-item").forEach(function (l) { l.classList.remove("active"); });
    document.querySelectorAll(".page").forEach(function (p) { p.classList.remove("active"); });
    el("page-pair-detail").classList.add("active");
    el("pd-loading").classList.remove("hidden");
    el("pd-dash").classList.add("hidden");
    el("pd-loading").textContent = "Loading " + req.instrument1 + " vs " + req.instrument2 + "…";
    try {
      var res = await fetch("/api/analysis/cdc/pair-detail", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(req),
      });
      var data = await res.json();
      if (!data.success) {
        el("pd-loading").textContent = "Error: " + (data.message || "failed to load pair.");
        return;
      }
      render(data);
    } catch (e) {
      el("pd-loading").textContent = "Error: " + e.message;
    }
  };

  el("pd-back-btn").addEventListener("click", function () {
    document.querySelectorAll(".page").forEach(function (p) { p.classList.remove("active"); });
    el("page-correlation-density").classList.add("active");
    document.querySelectorAll(".nav-item").forEach(function (l) {
      l.classList.toggle("active", l.dataset.page === "correlation-density");
    });
  });

  // Redraw on resize / theme change
  var _rsTimer = null;
  function scheduleRedraw() {
    clearTimeout(_rsTimer);
    _rsTimer = setTimeout(function () { if (_detail) render(_detail); }, 150);
  }
  window.addEventListener("resize", scheduleRedraw);
  // Panel widths also change without a window resize (sidebar toggle,
  // grid reflow) — observe the dashboard container itself.
  if (window.ResizeObserver) {
    var _lastW = 0;
    new ResizeObserver(function (entries) {
      var w = entries[0].contentRect.width;
      if (Math.abs(w - _lastW) > 4) { _lastW = w; scheduleRedraw(); }
    }).observe(el("pd-dash"));
  }
  window._pairDetailApplyTheme = function () { if (_detail) render(_detail); };

})();
