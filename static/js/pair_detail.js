/* ── Pair Detail Dashboard ── */
(function () {

  var el = function (id) { return document.getElementById(id); };
  var _detail = null;
  var _liveTimer = null;
  var _liveData = null;
  var _hedgeFront = [];
  var _hedgeIdx = -1;

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

  // Size the bitmap to the CSS box (wrapper) at the current DPI so plots
  // stay aligned when the window, sidebar, or display scaling changes.
  function sizeCanvas(cv) {
    var dpr = window.devicePixelRatio || 1;
    var box = cv.parentElement || cv;
    var w = Math.max(0, Math.floor(box.clientWidth));
    var h = Math.max(0, Math.floor(box.clientHeight));
    if (w < 40 || h < 40) return null;
    var bw = Math.round(w * dpr), bh = Math.round(h * dpr);
    if (cv.width !== bw) cv.width = bw;
    if (cv.height !== bh) cv.height = bh;
    var ctx = cv.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx: ctx, w: w, h: h };
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
    var s = sizeCanvas(cv);
    if (!s) return;
    var ctx = s.ctx, W = s.w, H = s.h;
    var P = pal();
    var padL = W < 360 ? 36 : 46;
    var padR = opts.padR || (W < 360 ? 44 : 54);
    var padT = 10, padB = H < 170 ? 18 : 22;
    var pw = Math.max(20, W - padL - padR), ph = Math.max(20, H - padT - padB);
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

    // grid + y labels (drop ticks if the plot is too short to fit them)
    ctx.strokeStyle = P.grid; ctx.fillStyle = P.text;
    ctx.font = (W < 360 ? "9px" : "10px") + " 'Segoe UI', sans-serif"; ctx.lineWidth = 1;
    var ticks = ph < 90 ? 2 : ph < 140 ? 3 : 4;
    var lastLabelY = -999;
    for (var g = 0; g <= ticks; g++) {
      var yv = lo + span * g / ticks, yy = Y(yv);
      ctx.beginPath(); ctx.moveTo(padL, yy); ctx.lineTo(W - padR, yy); ctx.stroke();
      if (Math.abs(yy - lastLabelY) < 12) continue;
      lastLabelY = yy;
      ctx.textAlign = "right";
      ctx.fillText(yv.toFixed(opts.dp !== undefined ? opts.dp : 2), padL - 5, yy + 3);
    }
    // x labels (~4–6 depending on width)
    ctx.textAlign = "center";
    var nX = W < 400 ? 4 : 6;
    var step = Math.max(1, Math.floor(times.length / nX));
    for (var i = 0; i < times.length; i += step) {
      ctx.fillText(fmtDate(times[i]), X(i), H - 5);
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
    var s = sizeCanvas(cv);
    if (!s) return;
    var ctx = s.ctx, W = s.w, H = s.h;
    var P = pal();
    var padL = 10, padR = 10, padT = 28, padB = 22;
    var pw = Math.max(20, W - padL - padR), ph = Math.max(20, H - padT - padB);
    ctx.clearRect(0, 0, W, H);
    var xs = d.x, pdf = d.pdf;
    var xmin = xs[0], xmax = xs[xs.length - 1];
    if (!isFinite(xmin) || !isFinite(xmax) || xmax === xmin) xmax = xmin + 1e-6;
    var pmax = Math.max.apply(null, pdf);
    if (!isFinite(pmax) || pmax <= 0) pmax = 1;
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
    ctx.font = (W < 360 ? "9px" : "10px") + " 'Segoe UI', sans-serif";
    ctx.textAlign = "center";
    var meanX = X(d.mean), curX = X(d.current);
    var meanY = padT - 14, curY = padT - 2;
    ctx.fillStyle = P.text;
    ctx.fillText("Mean " + d.mean.toFixed(4), meanX, meanY);
    ctx.fillStyle = P.red;
    ctx.fillText("Current " + d.current.toFixed(4), curX, curY);

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

  function lastClose(arr) {
    if (!arr || !arr.length) return null;
    for (var i = arr.length - 1; i >= 0; i--) {
      if (arr[i] !== null && isFinite(arr[i]) && arr[i] > 0) return arr[i];
    }
    return null;
  }

  function sellSymbolFrom(detail) {
    var sm = detail.summary || {};
    var rec = sm.recommendation || "";
    var m = rec.match(/SELL\s+([A-Z0-9.&-]+)/i);
    if (m) return m[1].toUpperCase();
    if (sm.z_score != null && sm.z_score < 0) return sm.instrument2;
    return sm.instrument1;
  }

  function fmtInr(v) {
    if (v === null || v === undefined || !isFinite(v)) return "—";
    return "₹" + Number(v).toLocaleString("en-IN", { maximumFractionDigits: 2 });
  }

  function fmtChg(chg, pct) {
    if (pct === null || pct === undefined || !isFinite(pct)) return { text: "", cls: "" };
    var sign = pct > 0 ? "+" : "";
    var chgTxt = chg !== null && isFinite(chg) ? sign + Number(chg).toFixed(2) + "  " : "";
    return { text: chgTxt + sign + Number(pct).toFixed(2) + "%", cls: pct >= 0 ? "up" : "down" };
  }

  function numVal(id, fallback) {
    var v = parseFloat(el(id).value);
    return isFinite(v) && v > 0 ? v : (fallback || 0);
  }

  function intVal(id, fallback) {
    var v = parseInt(el(id).value, 10);
    return isFinite(v) && v > 0 ? v : (fallback || 1);
  }

  function quoteLeg(which, seg) {
    if (!_liveData) return null;
    var pack = seg === "futures" ? _liveData.futures : _liveData.cash;
    return pack ? pack["leg" + which] : null;
  }

  function applySegment(which, resetQty) {
    var seg = el("pd-c-seg" + which).value;
    var lotEl = el("pd-c-lot" + which);
    var leg = quoteLeg(which, seg);
    var cash = quoteLeg(which, "cash");
    if (seg === "futures") {
      var lot = (leg && leg.has_future && leg.lot_size) ? leg.lot_size : 1;
      lotEl.disabled = false;
      if (resetQty || !intVal("pd-c-lot" + which, 0)) lotEl.value = lot;
      if (leg && leg.ltp) el("pd-c-price" + which).value = Number(leg.ltp).toFixed(2);
      if (resetQty) {
        el("pd-c-nlot" + which).value = 1;
        el("pd-c-qty" + which).value = lot;
      }
      el("pd-hedge-note").textContent = (leg && !leg.has_future)
        ? (leg.symbol + " has no NSE future; lot size starts at 1 and can be edited.")
        : "Cash: Lot Size is 1, so Lot and Qty stay in sync. Future: Lot is number of lots; Qty = Lot × Lot Size.";
    } else {
      lotEl.value = 1;
      lotEl.disabled = true;
      if (cash && cash.ltp) el("pd-c-price" + which).value = Number(cash.ltp).toFixed(2);
      if (resetQty) {
        el("pd-c-nlot" + which).value = 1;
        el("pd-c-qty" + which).value = 1;
      } else {
        el("pd-c-nlot" + which).value = intVal("pd-c-qty" + which);
      }
    }
    _hedgeFront = [];
    _hedgeIdx = -1;
    refreshTotals();
  }

  function syncFromLots(which) {
    var ls = intVal("pd-c-lot" + which);
    var n = intVal("pd-c-nlot" + which);
    el("pd-c-qty" + which).value = n * ls;
    refreshTotals();
  }

  function syncFromQty(which) {
    var ls = intVal("pd-c-lot" + which);
    var qty = intVal("pd-c-qty" + which);
    var n = Math.max(1, Math.round(qty / ls));
    el("pd-c-nlot" + which).value = n;
    el("pd-c-qty" + which).value = n * ls;
    refreshTotals();
  }

  function refreshTotals() {
    var p1 = numVal("pd-c-price1"), p2 = numVal("pd-c-price2");
    var q1 = intVal("pd-c-qty1"), q2 = intVal("pd-c-qty2");
    var v1 = p1 * q1, v2 = p2 * q2;
    el("pd-c-val1").textContent = v1 ? fmtInr(v1) : "—";
    el("pd-c-val2").textContent = v2 ? fmtInr(v2) : "—";
    if (!v1 || !v2) {
      el("pd-h-imb").textContent = "—";
      el("pd-h-gross").textContent = "—";
      return;
    }
    var imb = Math.abs(v1 - v2) / ((v1 + v2) / 2) * 100;
    el("pd-h-imb").textContent = imb.toFixed(2) + "%";
    el("pd-h-gross").textContent = fmtInr(v1 + v2);
  }

  function applyHedgePick(pick, lot1, lot2) {
    el("pd-c-nlot1").value = pick.n1;
    el("pd-c-nlot2").value = pick.n2;
    el("pd-c-qty1").value = pick.n1 * lot1;
    el("pd-c-qty2").value = pick.n2 * lot2;
    refreshTotals();
  }

  // Cash lot = 1 share; a futures lot is price × lot size. Caps must be large
  // enough to match at least one of the other side (e.g. ~257 M&M shares vs 1 Hero fut).
  function lotCap(seg, uThis, uOther) {
    var need = Math.max(1, Math.ceil(uOther / uThis));
    if (seg === "futures") return Math.min(120, Math.max(40, need + 8));
    return Math.min(20000, Math.max(400, need * 2));
  }

  function hedgeCandidates(u1, u2, max1, max2) {
    var seen = {}, list = [];
    function consider(n1, n2) {
      if (n1 < 1 || n2 < 1 || n1 > max1 || n2 > max2) return;
      var key = n1 + ":" + n2;
      if (seen[key]) return;
      seen[key] = true;
      var v1 = n1 * u1, v2 = n2 * u2;
      var imb = Math.abs(v1 - v2) / ((v1 + v2) / 2);
      list.push({ n1: n1, n2: n2, v1: v1, v2: v2, imb: imb, tot: v1 + v2 });
    }
    function sweep(nMax, fromFirst) {
      for (var n = 1; n <= nMax; n++) {
        var t = fromFirst ? (n * u1 / u2) : (n * u2 / u1);
        var cands = [Math.round(t), Math.floor(t), Math.ceil(t), Math.round(t) - 1, Math.round(t) + 1];
        for (var i = 0; i < cands.length; i++) {
          if (fromFirst) consider(n, cands[i]);
          else consider(cands[i], n);
        }
      }
    }
    sweep(max1, true);
    sweep(max2, false);
    list.sort(function (a, b) { return a.tot - b.tot || a.imb - b.imb; });
    var front = [], bestImb = Infinity;
    list.forEach(function (c) {
      if (c.imb < bestImb - 1e-12) {
        front.push(c);
        bestImb = c.imb;
      }
    });
    return front;
  }

  function calculateHedge() {
    var p1 = numVal("pd-c-price1"), p2 = numVal("pd-c-price2");
    var lot1 = intVal("pd-c-lot1"), lot2 = intVal("pd-c-lot2");
    if (!p1 || !p2) {
      el("pd-live-stamp").textContent = "Enter prices first";
      return;
    }
    var u1 = p1 * lot1, u2 = p2 * lot2;
    var max1 = lotCap(el("pd-c-seg1").value, u1, u2);
    var max2 = lotCap(el("pd-c-seg2").value, u2, u1);
    _hedgeFront = hedgeCandidates(u1, u2, max1, max2);
    if (!_hedgeFront.length) return;
    _hedgeIdx = _hedgeFront.length - 1;
    var best = _hedgeFront[_hedgeIdx];
    applyHedgePick(best, lot1, lot2);
    el("pd-hedge-note").textContent =
      "Lowest imbalance " + (best.imb * 100).toFixed(2) + "% · " +
      best.n1 + " lot vs " + best.n2 + " lot. Click Lower for a cheaper mix.";
  }

  function lowerHedge() {
    if (!_hedgeFront.length) {
      calculateHedge();
      if (_hedgeFront.length < 2) {
        el("pd-hedge-note").textContent = "No cheaper mix with a next-best imbalance.";
        return;
      }
    }
    if (_hedgeIdx <= 0) {
      el("pd-hedge-note").textContent = "Already at the lowest capital on this curve.";
      return;
    }
    _hedgeIdx -= 1;
    var pick = _hedgeFront[_hedgeIdx];
    var lot1 = intVal("pd-c-lot1"), lot2 = intVal("pd-c-lot2");
    applyHedgePick(pick, lot1, lot2);
    el("pd-hedge-note").textContent =
      "Lower capital " + fmtInr(pick.tot) + " · imbalance " + (pick.imb * 100).toFixed(2) +
      "% · " + pick.n1 + " lot vs " + pick.n2 + " lot" +
      (_hedgeIdx === 0 ? " (lowest capital)." : ". Click Lower again for cheaper.");
  }

  function renderHeadQuotes() {
    var cash = _liveData && _liveData.cash;
    if (!cash) return;
    [1, 2].forEach(function (n) {
      var leg = cash["leg" + n];
      if (!leg) return;
      el("pd-head-px" + n).textContent = leg.ltp != null ? fmtInr(leg.ltp) : "—";
      var c = fmtChg(leg.chg, leg.chg_pct);
      var chgEl = el("pd-head-chg" + n);
      chgEl.textContent = c.text;
      chgEl.className = "pd-title-chg " + c.cls;
    });
  }

  function fillCalcPrices() {
    applySegment(1, false);
    applySegment(2, false);
  }

  function initCalculator() {
    if (!_detail) return;
    var sm = _detail.summary;
    el("pd-c-sym1").textContent = sm.instrument1;
    el("pd-c-sym2").textContent = sm.instrument2;
    var sell = sellSymbolFrom(_detail);
    el("pd-c-trade1").value = sell === sm.instrument1 ? "SELL" : "BUY";
    el("pd-c-trade2").value = sell === sm.instrument1 ? "BUY" : "SELL";
    el("pd-c-seg1").value = "cash";
    el("pd-c-seg2").value = "cash";
    var c1 = lastClose(_detail.close1), c2 = lastClose(_detail.close2);
    if (c1) el("pd-c-price1").value = Number(c1).toFixed(2);
    if (c2) el("pd-c-price2").value = Number(c2).toFixed(2);
    el("pd-c-lot1").value = 1;
    el("pd-c-lot2").value = 1;
    el("pd-c-lot1").disabled = true;
    el("pd-c-lot2").disabled = true;
    el("pd-c-nlot1").value = 1;
    el("pd-c-nlot2").value = 1;
    el("pd-c-qty1").value = 1;
    el("pd-c-qty2").value = 1;
    refreshTotals();
  }

  async function fetchLiveQuotes(updateCalc) {
    if (!_detail) return;
    var sm = _detail.summary;
    try {
      var res = await fetch("/api/analysis/cdc/pair-live", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          instrument1: sm.instrument1,
          instrument2: sm.instrument2,
          sell_symbol: sellSymbolFrom(_detail),
          last_close1: lastClose(_detail.close1),
          last_close2: lastClose(_detail.close2),
        }),
      });
      var data = await res.json();
      if (!data.success) {
        el("pd-live-stamp").textContent = data.message || "Quote error";
        return;
      }
      _liveData = data;
      renderHeadQuotes();
      if (updateCalc) fillCalcPrices();
      el("pd-live-stamp").textContent = "Updated " + new Date().toLocaleTimeString();
    } catch (e) {
      el("pd-live-stamp").textContent = "Quote error: " + e.message;
    }
  }

  function stopLiveQuotes() {
    if (_liveTimer) { clearInterval(_liveTimer); _liveTimer = null; }
  }

  function startLiveQuotes() {
    stopLiveQuotes();
    fetchLiveQuotes(true);
    _liveTimer = setInterval(function () { fetchLiveQuotes(false); }, 15000);
  }

  el("pd-c-seg1").addEventListener("change", function () { applySegment(1, true); });
  el("pd-c-seg2").addEventListener("change", function () { applySegment(2, true); });
  el("pd-c-nlot1").addEventListener("input", function () { syncFromLots(1); });
  el("pd-c-nlot2").addEventListener("input", function () { syncFromLots(2); });
  el("pd-c-qty1").addEventListener("input", function () { syncFromQty(1); });
  el("pd-c-qty2").addEventListener("input", function () { syncFromQty(2); });
  el("pd-c-lot1").addEventListener("input", function () { syncFromLots(1); });
  el("pd-c-lot2").addEventListener("input", function () { syncFromLots(2); });
  ["pd-c-price1", "pd-c-price2"].forEach(function (id) {
    el(id).addEventListener("input", refreshTotals);
  });
  el("pd-calc-btn").addEventListener("click", calculateHedge);
  el("pd-lower-btn").addEventListener("click", lowerHedge);
  el("pd-px-refresh").addEventListener("click", function () {
    el("pd-live-stamp").textContent = "Refreshing…";
    fetchLiveQuotes(true);
  });

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

    requestAnimationFrame(function () { drawAllCharts(); });
    var c1 = lastClose(detail.close1), c2 = lastClose(detail.close2);
    if (c1) el("pd-head-px1").textContent = fmtInr(c1);
    if (c2) el("pd-head-px2").textContent = fmtInr(c2);
    el("pd-head-chg1").textContent = "";
    el("pd-head-chg2").textContent = "";
    initCalculator();
    el("pd-live-stamp").textContent = "Fetching live quotes…";
    startLiveQuotes();

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

  function drawAllCharts() {
    if (!_detail) return;
    var detail = _detail, t = detail.time, P = pal();

    drawChart("pd-c-norm", t, [
      { data: detail.norm1, color: P.blue, tag: true },
      { data: detail.norm2, color: P.orange, tag: true },
    ], { dp: 1 });

    var hl = [];
    if (detail.bands && detail.bands.mean !== undefined) {
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
    stopLiveQuotes();
    document.querySelectorAll(".page").forEach(function (p) { p.classList.remove("active"); });
    el("page-correlation-density").classList.add("active");
    document.querySelectorAll(".nav-item").forEach(function (l) {
      l.classList.toggle("active", l.dataset.page === "correlation-density");
    });
  });

  // Redraw on resize / DPI / sidebar / theme — match the live box size
  var _rsTimer = 0;
  function scheduleRedraw() {
    if (_rsTimer) cancelAnimationFrame(_rsTimer);
    _rsTimer = requestAnimationFrame(function () {
      _rsTimer = requestAnimationFrame(function () {
        _rsTimer = 0;
        drawAllCharts();
      });
    });
  }
  window.addEventListener("resize", scheduleRedraw);
  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", scheduleRedraw);
  }
  if (window.ResizeObserver) {
    var ro = new ResizeObserver(scheduleRedraw);
    ro.observe(el("pd-dash"));
    document.querySelectorAll("#page-pair-detail .pd-chart-wrap").forEach(function (wrap) {
      ro.observe(wrap);
    });
  }
  window._pairDetailApplyTheme = function () { if (_detail) render(_detail); };

})();
