/* ── Option Strategy Builder (Sensibull-style) ── */
(function () {
  var el = function (id) { return document.getElementById(id); };

  var STRATEGIES = {
    bullish: [
      { id: "buy-call", name: "Buy Call", shape: "call", legs: [{ side: "B", type: "CE", offset: 0 }] },
      { id: "sell-put", name: "Sell Put", shape: "call", legs: [{ side: "S", type: "PE", offset: 0 }] },
      { id: "bull-call-spread", name: "Bull Call Spread", shape: "bull-spread", legs: [
        { side: "B", type: "CE", offset: 0 }, { side: "S", type: "CE", offset: 2 }
      ]},
      { id: "bull-put-spread", name: "Bull Put Spread", shape: "bull-spread", legs: [
        { side: "S", type: "PE", offset: 0 }, { side: "B", type: "PE", offset: -2 }
      ]}
    ],
    bearish: [
      { id: "buy-put", name: "Buy Put", shape: "put", legs: [{ side: "B", type: "PE", offset: 0 }] },
      { id: "sell-call", name: "Sell Call", shape: "put", legs: [{ side: "S", type: "CE", offset: 0 }] },
      { id: "bear-put-spread", name: "Bear Put Spread", shape: "bear-spread", legs: [
        { side: "B", type: "PE", offset: 0 }, { side: "S", type: "PE", offset: -2 }
      ]},
      { id: "bear-call-spread", name: "Bear Call Spread", shape: "bear-spread", legs: [
        { side: "S", type: "CE", offset: 0 }, { side: "B", type: "CE", offset: 2 }
      ]}
    ],
    neutral: [
      { id: "short-straddle", name: "Short Straddle", shape: "short-vol", legs: [
        { side: "S", type: "CE", offset: 0 }, { side: "S", type: "PE", offset: 0 }
      ]},
      { id: "short-strangle", name: "Short Strangle", shape: "short-vol", legs: [
        { side: "S", type: "CE", offset: 2 }, { side: "S", type: "PE", offset: -2 }
      ]},
      { id: "iron-fly", name: "Iron Fly", shape: "short-vol", legs: [
        { side: "B", type: "PE", offset: -2 }, { side: "S", type: "PE", offset: 0 },
        { side: "S", type: "CE", offset: 0 }, { side: "B", type: "CE", offset: 2 }
      ]},
      { id: "iron-condor", name: "Iron Condor", shape: "short-vol", legs: [
        { side: "B", type: "PE", offset: -4 }, { side: "S", type: "PE", offset: -2 },
        { side: "S", type: "CE", offset: 2 }, { side: "B", type: "CE", offset: 4 }
      ]},
      { id: "long-straddle", name: "Long Straddle", shape: "long-vol", legs: [
        { side: "B", type: "CE", offset: 0 }, { side: "B", type: "PE", offset: 0 }
      ]},
      { id: "long-strangle", name: "Long Strangle", shape: "long-vol", legs: [
        { side: "B", type: "CE", offset: 2 }, { side: "B", type: "PE", offset: -2 }
      ]}
    ],
    others: [
      { id: "call-butterfly", name: "Call Butterfly", shape: "butterfly", legs: [
        { side: "B", type: "CE", offset: -2, lots: 1 },
        { side: "S", type: "CE", offset: 0, lots: 2 },
        { side: "B", type: "CE", offset: 2, lots: 1 }
      ]},
      { id: "put-butterfly", name: "Put Butterfly", shape: "butterfly", legs: [
        { side: "B", type: "PE", offset: -2, lots: 1 },
        { side: "S", type: "PE", offset: 0, lots: 2 },
        { side: "B", type: "PE", offset: 2, lots: 1 }
      ]},
      { id: "jade-lizard", name: "Jade Lizard", shape: "bull-spread", legs: [
        { side: "S", type: "PE", offset: -2 },
        { side: "S", type: "CE", offset: 2 },
        { side: "B", type: "CE", offset: 4 }
      ]},
      { id: "ratio-call", name: "Call Ratio Spread", shape: "bear-spread", legs: [
        { side: "B", type: "CE", offset: 0, lots: 1 },
        { side: "S", type: "CE", offset: 2, lots: 2 }
      ]}
    ]
  };

  var state = {
    wired: false,
    underlyings: [],
    symbol: "NIFTY",
    expiry: "",
    expiries: [],
    chain: [],
    spot: 0,
    prevClose: 0,
    lot: 1,
    legs: [],
    strategyName: "New Strategy",
    strategyId: "",
    bias: "bullish",
    targetPct: 0,
    dateFrac: 1,
    loading: false,
    timer: null,
    chainOpen: false
  };

  function fmt(v, dp) {
    if (v === null || v === undefined || isNaN(v)) return "—";
    return Number(v).toLocaleString(undefined, {
      minimumFractionDigits: dp === undefined ? 2 : dp,
      maximumFractionDigits: dp === undefined ? 2 : dp
    });
  }

  function fmtIv(v) {
    if (v === null || v === undefined || v === "") return "—";
    var n = Number(v);
    if (isNaN(n)) return "—";
    if (Math.abs(n) <= 2) n *= 100;
    return n.toFixed(1) + "%";
  }

  function showMsg(msg, isError) {
    var box = el("sb-msg");
    if (!box) return;
    box.textContent = msg;
    box.className = "message-box " + (isError ? "error" : "success");
    box.classList.remove("hidden");
    setTimeout(function () { box.classList.add("hidden"); }, 5000);
  }

  function strikeStep() {
    var rows = state.chain;
    if (!rows || rows.length < 2) return 50;
    var diffs = [];
    for (var i = 1; i < rows.length; i++) diffs.push(Math.abs(rows[i].strike - rows[i - 1].strike));
    diffs.sort(function (a, b) { return a - b; });
    return diffs[Math.floor(diffs.length / 2)] || 50;
  }

  function atmStrike() {
    if (!state.chain.length) return Math.round(state.spot);
    var best = state.chain[0];
    var spot = state.spot || best.strike;
    state.chain.forEach(function (r) {
      if (Math.abs(r.strike - spot) < Math.abs(best.strike - spot)) best = r;
    });
    return best.strike;
  }

  function nearestStrike(target) {
    if (!state.chain.length) return target;
    var best = state.chain[0];
    state.chain.forEach(function (r) {
      if (Math.abs(r.strike - target) < Math.abs(best.strike - target)) best = r;
    });
    return best.strike;
  }

  function sideAt(strike, type) {
    for (var i = 0; i < state.chain.length; i++) {
      if (state.chain[i].strike === strike) {
        return type === "CE" ? (state.chain[i].ce || {}) : (state.chain[i].pe || {});
      }
    }
    return {};
  }

  function daysToExpiry(expiry) {
    if (!expiry) return 1;
    var exp = new Date(expiry + "T15:30:00");
    var now = new Date();
    return Math.max((exp - now) / 86400000, 0.02);
  }

  function yearsLeft(frac) {
    var dte = daysToExpiry(state.expiry);
    var remain = dte * (1 - (frac === undefined ? state.dateFrac : frac));
    if (state.dateFrac >= 0.999 && frac === undefined) remain = 0;
    return Math.max(remain, 0) / 365;
  }

  function normCdf(x) {
    return 0.5 * (1 + erf(x / Math.sqrt(2)));
  }

  function erf(x) {
    var sign = x < 0 ? -1 : 1;
    x = Math.abs(x);
    var a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
    var t = 1 / (1 + p * x);
    var y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
    return sign * y;
  }

  function bsPrice(spot, strike, t, sigma, type) {
    if (t <= 1e-8 || !sigma) {
      return type === "CE" ? Math.max(spot - strike, 0) : Math.max(strike - spot, 0);
    }
    var sqrtT = Math.sqrt(t);
    var d1 = (Math.log(spot / strike) + (0.06 + 0.5 * sigma * sigma) * t) / (sigma * sqrtT);
    var d2 = d1 - sigma * sqrtT;
    if (type === "CE") return spot * normCdf(d1) - strike * Math.exp(-0.06 * t) * normCdf(d2);
    return strike * Math.exp(-0.06 * t) * normCdf(-d2) - spot * normCdf(-d1);
  }

  function ivOf(side) {
    var iv = Number(side && side.iv);
    if (!iv || isNaN(iv)) return 0.18;
    return iv > 2 ? iv / 100 : iv;
  }

  function intrinsic(spot, strike, type) {
    return type === "CE" ? Math.max(spot - strike, 0) : Math.max(strike - spot, 0);
  }

  function lotOf() {
    for (var i = 0; i < state.chain.length; i++) {
      var ce = state.chain[i].ce || {};
      if (ce.lot_size) return ce.lot_size;
      var pe = state.chain[i].pe || {};
      if (pe.lot_size) return pe.lot_size;
    }
    return state.symbol === "BANKNIFTY" ? 15 : 75;
  }

  function signedQty(leg) {
    var sign = leg.side === "B" ? 1 : -1;
    return sign * (leg.lots || 1) * (state.lot || 1);
  }

  function pnlAt(spot, tYears) {
    var total = 0;
    state.legs.forEach(function (leg) {
      var px;
      if (!tYears) px = intrinsic(spot, leg.strike, leg.type);
      else px = bsPrice(spot, leg.strike, tYears, ivOf(leg), leg.type);
      total += (px - leg.price) * signedQty(leg);
    });
    return total;
  }

  function netPremium() {
    var p = 0;
    state.legs.forEach(function (leg) {
      p += (leg.side === "S" ? 1 : -1) * leg.price * (leg.lots || 1);
    });
    return p;
  }

  function uniqueStrikes() {
    var set = {};
    state.legs.forEach(function (l) { set[l.strike] = true; });
    return Object.keys(set).map(Number).sort(function (a, b) { return a - b; });
  }

  function analysis() {
    if (!state.legs.length) {
      return { maxP: null, maxL: null, be: [], rr: null, pop: null, tv: 0, delta: 0, theta: 0, vega: 0, gamma: 0 };
    }
    var spot = state.spot || atmStrike();
    var step = strikeStep();
    var lo = spot * 0.88;
    var hi = spot * 1.12;
    var pts = [];
    var n = 240;
    var tNow = daysToExpiry(state.expiry) / 365;
    var tv = 0;
    var greeks = { delta: 0, theta: 0, vega: 0, gamma: 0 };
    state.legs.forEach(function (leg) {
      var q = signedQty(leg);
      var intr = intrinsic(spot, leg.strike, leg.type);
      tv += (leg.price - intr) * q;
      greeks.delta += (Number(leg.delta) || 0) * q;
      greeks.theta += (Number(leg.theta) || 0) * q;
      greeks.vega += (Number(leg.vega) || 0) * q;
      greeks.gamma += (Number(leg.gamma) || 0) * q;
    });

    var maxP = -Infinity, maxL = Infinity, pos = 0;
    var be = [];
    var prev = null;
    for (var i = 0; i <= n; i++) {
      var s = lo + (hi - lo) * i / n;
      var y = pnlAt(s, 0);
      pts.push({ s: s, y: y });
      if (y > maxP) maxP = y;
      if (y < maxL) maxL = y;
      if (y > 0) pos++;
      if (prev && ((prev.y <= 0 && y >= 0) || (prev.y >= 0 && y <= 0))) {
        var t = prev.y / (prev.y - y);
        be.push(prev.s + t * (s - prev.s));
      }
      prev = { s: s, y: y };
    }
    var farLo = pnlAt(lo - step * 20, 0);
    var farHi = pnlAt(hi + step * 20, 0);
    if (farLo > maxP) maxP = farLo;
    if (farHi > maxP) maxP = farHi;
    if (farLo < maxL) maxL = farLo;
    if (farHi < maxL) maxL = farHi;
    var uncappedP = farLo > maxP * 0.98 && farLo > 1000 || farHi > maxP * 0.98 && farHi > 1000;
    var uncappedL = farLo < maxL * 0.98 && farLo < -1000 || farHi < maxL * 0.98 && farHi < -1000;
    var rr = (maxL < 0 && maxP > 0) ? Math.abs(maxP / maxL) : null;
    return {
      maxP: uncappedP ? Infinity : maxP,
      maxL: uncappedL ? -Infinity : maxL,
      be: be,
      rr: rr,
      pop: pos / (n + 1),
      tv: tv,
      delta: greeks.delta,
      theta: greeks.theta,
      vega: greeks.vega,
      gamma: greeks.gamma,
      pts: pts,
      tNow: tNow
    };
  }

  function money(v, infLabel) {
    if (v === null || v === undefined || isNaN(v)) return "—";
    if (v === Infinity) return infLabel || "Unlimited";
    if (v === -Infinity) return infLabel || "Unlimited";
    var sign = v > 0 ? "+" : "";
    return sign + fmt(v, 0);
  }

  function renderMetrics() {
    var a = analysis();
    el("sb-max-profit").textContent = money(a.maxP, "Unlimited");
    el("sb-max-profit").className = a.maxP > 0 || a.maxP === Infinity ? "sb-pos" : "sb-neg";
    el("sb-max-loss").textContent = a.maxL === -Infinity ? "Unlimited" : money(a.maxL);
    el("sb-max-loss").className = "sb-neg";
    if (!a.be.length) el("sb-breakeven").textContent = "—";
    else {
      el("sb-breakeven").textContent = a.be.map(function (x) {
        var pct = state.spot ? ((x / state.spot - 1) * 100) : 0;
        return fmt(x, 0) + " (" + (pct >= 0 ? "+" : "") + pct.toFixed(1) + "%)";
      }).join(" · ");
    }
    el("sb-rr").textContent = a.rr ? a.rr.toFixed(1) : "—";
    el("sb-pop").textContent = a.pop === null ? "—" : Math.round(a.pop * 100) + "%";
    el("sb-tv").textContent = money(a.tv);
    el("sb-delta").textContent = fmt(a.delta, 1);
    el("sb-theta").textContent = fmt(a.theta, 1);
    el("sb-vega").textContent = fmt(a.vega, 1);
    var net = netPremium();
    el("sb-net-price").textContent = (net >= 0 ? "Rcv " : "Pay ") + fmt(Math.abs(net), 2);
    el("sb-premium").textContent = (net >= 0 ? "Rcv " : "Pay ") + fmt(Math.abs(net) * state.lot, 0);
    el("sb-lot").textContent = state.lot;
    el("sb-strategy-title").textContent = state.strategyName || "New Strategy";
  }

  function renderLegs() {
    var body = el("sb-legs-body");
    if (!state.legs.length) {
      body.innerHTML = '<tr class="sb-empty-row"><td colspan="8">Pick a ready-made strategy or Add/Edit legs from the chain.</td></tr>';
      if (el("sb-trade-btn")) el("sb-trade-btn").disabled = true;
      renderMetrics();
      drawPayoff();
      renderPnlTable();
      renderGreeksTable();
      renderChain();
      return;
    }
    body.innerHTML = state.legs.map(function (leg, i) {
      var expOpts = state.expiries.map(function (d) {
        var sel = d === (leg.expiry || state.expiry) ? " selected" : "";
        return "<option value=\"" + d + "\"" + sel + ">" + fmtExpiry(d) + "</option>";
      }).join("");
      var strikeOpts = state.chain.map(function (r) {
        var sel = Number(r.strike) === Number(leg.strike) ? " selected" : "";
        return "<option value=\"" + r.strike + "\"" + sel + ">" + r.strike + "</option>";
      }).join("");
      return "<tr>" +
        "<td><input type=\"checkbox\" checked data-i=\"" + i + "\" class=\"sb-leg-on\" /></td>" +
        "<td><button type=\"button\" class=\"sb-bs " + (leg.side === "B" ? "buy" : "sell") + "\" data-i=\"" + i + "\">" +
          (leg.side === "B" ? "B" : "S") + "</button></td>" +
        "<td><select data-i=\"" + i + "\" class=\"sb-leg-exp\">" + expOpts + "</select></td>" +
        "<td><select data-i=\"" + i + "\" class=\"sb-leg-strike\">" + strikeOpts + "</select></td>" +
        "<td><select data-i=\"" + i + "\" class=\"sb-leg-type\">" +
          "<option value=\"CE\"" + (leg.type === "CE" ? " selected" : "") + ">CE</option>" +
          "<option value=\"PE\"" + (leg.type === "PE" ? " selected" : "") + ">PE</option>" +
        "</select></td>" +
        "<td><input type=\"number\" min=\"1\" step=\"1\" value=\"" + (leg.lots || 1) + "\" data-i=\"" + i + "\" class=\"sb-leg-lots\" /></td>" +
        "<td>" + fmt(leg.price, 2) + "</td>" +
        "<td><button type=\"button\" class=\"sb-icon-btn\" data-del=\"" + i + "\" title=\"Remove\">✕</button></td>" +
      "</tr>";
    }).join("");
    if (el("sb-trade-btn")) el("sb-trade-btn").disabled = !state.legs.length;
    renderMetrics();
    drawPayoff();
    renderPnlTable();
    renderGreeksTable();
    renderChain();
  }

  function fmtExpiry(d) {
    if (!d) return "";
    var p = d.split("-");
    if (p.length < 3) return d;
    var months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    return p[2] + " " + months[parseInt(p[1], 10) - 1];
  }

  function refreshLegQuote(leg) {
    var side = sideAt(leg.strike, leg.type);
    leg.price = Number(side.ltp) || leg.price || 0;
    leg.iv = side.iv;
    leg.delta = side.delta;
    leg.gamma = side.gamma;
    leg.theta = side.theta;
    leg.vega = side.vega;
    leg.oi = side.oi;
    leg.scrip_code = side.scrip_code;
    if (side.lot_size) state.lot = side.lot_size;
  }

  function applyTemplate(tpl) {
    if (!state.chain.length) {
      showMsg("Load the option chain first.", true);
      return;
    }
    var atm = atmStrike();
    var step = strikeStep();
    state.strategyName = tpl.name;
    state.strategyId = tpl.id;
    state.legs = tpl.legs.map(function (spec) {
      var strike = nearestStrike(atm + spec.offset * step);
      var leg = {
        side: spec.side,
        type: spec.type,
        strike: strike,
        lots: spec.lots || 1,
        expiry: state.expiry,
        price: 0
      };
      refreshLegQuote(leg);
      return leg;
    });
    document.querySelectorAll(".sb-ready-card").forEach(function (c) {
      c.classList.toggle("active", c.dataset.id === tpl.id);
    });
    renderLegs();
  }

  function thumbSvg(shape) {
    var d = {
      call: "M4 28 L22 28 L36 8",
      put: "M4 8 L18 8 L36 28",
      "bull-spread": "M4 28 L16 28 L28 10 L36 10",
      "bear-spread": "M4 10 L12 10 L24 28 L36 28",
      "short-vol": "M4 10 L18 28 L32 10",
      "long-vol": "M4 28 L18 10 L32 28",
      butterfly: "M4 22 L14 22 L20 10 L26 22 L36 22"
    }[shape] || "M4 20 L36 20";
    return '<svg viewBox="0 0 40 36" aria-hidden="true"><path d="' + d +
      '" fill="none" stroke="#58a6ff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  }

  function renderReady() {
    var grid = el("sb-ready-grid");
    var list = STRATEGIES[state.bias] || [];
    grid.innerHTML = list.map(function (s) {
      return '<button type="button" class="sb-ready-card' + (state.strategyId === s.id ? " active" : "") +
        '" data-id="' + s.id + '">' + thumbSvg(s.shape) + "<span>" + s.name + "</span></button>";
    }).join("");
  }

  function findTpl(id) {
    var keys = Object.keys(STRATEGIES);
    for (var i = 0; i < keys.length; i++) {
      var found = STRATEGIES[keys[i]].filter(function (s) { return s.id === id; })[0];
      if (found) return found;
    }
    return null;
  }

  function toggleLegFromChain(strike, type, side) {
    var idx = -1;
    for (var i = 0; i < state.legs.length; i++) {
      if (state.legs[i].strike === strike && state.legs[i].type === type) { idx = i; break; }
    }
    if (idx >= 0) {
      if (state.legs[idx].side === side) {
        state.legs.splice(idx, 1);
      } else {
        state.legs[idx].side = side;
        refreshLegQuote(state.legs[idx]);
      }
    } else {
      var leg = { side: side, type: type, strike: strike, lots: 1, expiry: state.expiry, price: 0 };
      refreshLegQuote(leg);
      state.legs.push(leg);
    }
    state.strategyName = state.legs.length ? "Custom" : "New Strategy";
    state.strategyId = "";
    renderLegs();
  }

  function renderChain() {
    var body = el("sb-chain-body");
    if (!state.chain.length) {
      body.innerHTML = '<tr><td colspan="9" class="oc-empty">Load an underlying to see the chain.</td></tr>';
      return;
    }
    function bsPair(strike, type) {
      var onB = state.legs.some(function (l) { return l.strike === strike && l.type === type && l.side === "B"; });
      var onS = state.legs.some(function (l) { return l.strike === strike && l.type === type && l.side === "S"; });
      return '<div class="sb-bs-pair">' +
        '<button type="button" class="sb-bs-mini' + (onB ? " on-b" : "") + '" data-k="' + strike + '" data-t="' + type + '" data-s="B">B</button>' +
        '<button type="button" class="sb-bs-mini' + (onS ? " on-s" : "") + '" data-k="' + strike + '" data-t="' + type + '" data-s="S">S</button>' +
        "</div>";
    }
    body.innerHTML = state.chain.map(function (r) {
      var ce = r.ce || {};
      var pe = r.pe || {};
      return "<tr" + (r.atm ? ' class="oc-atm"' : "") + ">" +
        "<td>" + bsPair(r.strike, "CE") + "</td>" +
        "<td class=\"oc-ltp\">" + fmt(ce.ltp, 2) + "</td>" +
        "<td>" + fmtIv(ce.iv) + "</td>" +
        "<td>" + fmt(ce.oi, 0) + "</td>" +
        "<td class=\"oc-strike-cell\">" + fmt(r.strike, 0) + "</td>" +
        "<td>" + fmt(pe.oi, 0) + "</td>" +
        "<td>" + fmtIv(pe.iv) + "</td>" +
        "<td class=\"oc-ltp\">" + fmt(pe.ltp, 2) + "</td>" +
        "<td>" + bsPair(r.strike, "PE") + "</td>" +
      "</tr>";
    }).join("");
  }

  function cssVar(name, fallback) {
    var v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  }

  function drawPayoff() {
    var canvas = el("sb-payoff");
    if (!canvas) return;
    var wrap = canvas.parentElement;
    var w = Math.max(wrap.clientWidth || 640, 320);
    var h = 340;
    var dpr = window.devicePixelRatio || 1;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    canvas.style.width = w + "px";
    canvas.style.height = h + "px";
    var ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    var bg = cssVar("--surface", "#161b22");
    var grid = cssVar("--border", "#30363d");
    var text = cssVar("--muted", "#8b949e");
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);

    var pad = { l: 56, r: 16, t: 16, b: 36 };
    var spot = state.spot || atmStrike() || 100;
    var lo = spot * 0.92;
    var hi = spot * 1.08;
    if (state.legs.length) {
      var ks = uniqueStrikes();
      lo = Math.min(lo, ks[0] - strikeStep() * 2);
      hi = Math.max(hi, ks[ks.length - 1] + strikeStep() * 2);
    }
    var n = 220;
    var tExp = 0;
    var tTgt = yearsLeft();
    var xs = [], ye = [], yt = [];
    var minY = 0, maxY = 0;
    for (var i = 0; i <= n; i++) {
      var s = lo + (hi - lo) * i / n;
      xs.push(s);
      var a = state.legs.length ? pnlAt(s, tExp) : 0;
      var b = state.legs.length ? pnlAt(s, tTgt) : 0;
      ye.push(a); yt.push(b);
      minY = Math.min(minY, a, b);
      maxY = Math.max(maxY, a, b);
    }
    if (minY === maxY) { minY = -1000; maxY = 1000; }
    var padY = (maxY - minY) * 0.12;
    minY -= padY; maxY += padY;
    function X(s) { return pad.l + (s - lo) / (hi - lo) * (w - pad.l - pad.r); }
    function Y(v) { return pad.t + (maxY - v) / (maxY - minY) * (h - pad.t - pad.b); }

    var maxOi = 1;
    state.chain.forEach(function (r) {
      maxOi = Math.max(maxOi, Number((r.ce || {}).oi) || 0, Number((r.pe || {}).oi) || 0);
    });
    var barH = (h - pad.t - pad.b) * 0.28;
    var zero = Y(0);
    state.chain.forEach(function (r) {
      var x = X(r.strike);
      var ceOi = Number((r.ce || {}).oi) || 0;
      var peOi = Number((r.pe || {}).oi) || 0;
      var bw = Math.max(3, (w - pad.l - pad.r) / Math.max(state.chain.length, 1) * 0.28);
      ctx.fillStyle = "rgba(248,113,113,0.28)";
      ctx.fillRect(x - bw - 1, zero - (ceOi / maxOi) * barH, bw, (ceOi / maxOi) * barH);
      ctx.fillStyle = "rgba(61,214,140,0.28)";
      ctx.fillRect(x + 1, zero - (peOi / maxOi) * barH, bw, (peOi / maxOi) * barH);
    });

    ctx.strokeStyle = grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(pad.l, zero);
    ctx.lineTo(w - pad.r, zero);
    ctx.stroke();

    function strokeLine(arr, color, width) {
      ctx.beginPath();
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      arr.forEach(function (v, i) {
        var x = X(xs[i]), y = Y(v);
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      });
      ctx.stroke();
    }

    if (state.legs.length) {
      ctx.beginPath();
      ye.forEach(function (v, i) {
        var x = X(xs[i]), y = Y(v);
        if (i === 0) ctx.moveTo(x, zero);
        ctx.lineTo(x, y);
        if (i === ye.length - 1) ctx.lineTo(x, zero);
      });
      ctx.closePath();
      var g = ctx.createLinearGradient(0, pad.t, 0, h - pad.b);
      g.addColorStop(0, "rgba(61,214,140,0.22)");
      g.addColorStop(0.5, "rgba(61,214,140,0.04)");
      g.addColorStop(0.5, "rgba(248,113,113,0.04)");
      g.addColorStop(1, "rgba(248,113,113,0.22)");
      ctx.fillStyle = g;
      ctx.fill();
      strokeLine(ye, "#3dd68c", 2);
      if (tTgt > 1e-6) strokeLine(yt, "#58a6ff", 2);
    }

    var tgt = spot * (1 + state.targetPct / 100);
    ctx.strokeStyle = "#f85149";
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(X(spot), pad.t);
    ctx.lineTo(X(spot), h - pad.b);
    ctx.stroke();
    ctx.setLineDash([]);
    if (Math.abs(tgt - spot) > 0.01) {
      ctx.strokeStyle = "#58a6ff";
      ctx.setLineDash([2, 3]);
      ctx.beginPath();
      ctx.moveTo(X(tgt), pad.t);
      ctx.lineTo(X(tgt), h - pad.b);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    ctx.fillStyle = text;
    ctx.font = "11px Segoe UI, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(fmt(lo, 0), X(lo), h - 10);
    ctx.fillText(fmt(spot, 2), X(spot), h - 10);
    ctx.fillText(fmt(hi, 0), X(hi), h - 10);
    ctx.textAlign = "right";
    ctx.fillText(fmt(maxY, 0), pad.l - 6, Y(maxY) + 4);
    ctx.fillText("0", pad.l - 6, zero + 4);
    ctx.fillText(fmt(minY, 0), pad.l - 6, Y(minY) + 4);
    ctx.textAlign = "left";
    ctx.fillStyle = "#f85149";
    ctx.fillText("Spot " + fmt(spot, 2), X(spot) + 6, pad.t + 12);
  }

  function renderPnlTable() {
    var tb = el("sb-pnl-table").querySelector("tbody");
    if (!state.legs.length) {
      tb.innerHTML = '<tr><td colspan="3" class="oc-empty">No legs yet.</td></tr>';
      return;
    }
    var spot = state.spot || atmStrike();
    var step = strikeStep();
    var rows = [];
    for (var s = nearestStrike(spot - step * 8); s <= spot + step * 8 + 0.01; s += step) {
      rows.push(s);
    }
    var tTgt = yearsLeft();
    tb.innerHTML = rows.map(function (s) {
      var a = pnlAt(s, 0);
      var b = pnlAt(s, tTgt);
      var clsA = a > 0 ? "oc-up" : a < 0 ? "oc-down" : "";
      var clsB = b > 0 ? "oc-up" : b < 0 ? "oc-down" : "";
      var mark = Math.abs(s - atmStrike()) < 0.01 ? " style=\"font-weight:700\"" : "";
      return "<tr" + mark + "><td>" + fmt(s, 0) + "</td><td class=\"" + clsA + "\">" + money(a) +
        "</td><td class=\"" + clsB + "\">" + money(b) + "</td></tr>";
    }).join("");
  }

  function renderGreeksTable() {
    var tb = el("sb-greeks-table").querySelector("tbody");
    if (!state.legs.length) {
      tb.innerHTML = '<tr><td colspan="6" class="oc-empty">No legs yet.</td></tr>';
      return;
    }
    var rows = state.legs.map(function (leg) {
      var q = signedQty(leg);
      return "<tr><td>" + leg.side + " " + fmt(leg.strike, 0) + " " + leg.type +
        "</td><td>" + fmt((leg.delta || 0) * q, 2) +
        "</td><td>" + fmt((leg.gamma || 0) * q, 4) +
        "</td><td>" + fmt((leg.theta || 0) * q, 2) +
        "</td><td>" + fmt((leg.vega || 0) * q, 2) +
        "</td><td>" + fmtIv(leg.iv) + "</td></tr>";
    });
    var a = analysis();
    rows.push("<tr><td><b>Total</b></td><td><b>" + fmt(a.delta, 2) + "</b></td><td><b>" +
      fmt(a.gamma, 4) + "</b></td><td><b>" + fmt(a.theta, 2) + "</b></td><td><b>" +
      fmt(a.vega, 2) + "</b></td><td></td></tr>");
    tb.innerHTML = rows.join("");
  }

  function updateSliders() {
    var spot = state.spot || 0;
    var tgt = spot * (1 + state.targetPct / 100);
    el("sb-target-pct").textContent = (state.targetPct >= 0 ? "+" : "") + state.targetPct.toFixed(1) + "%";
    el("sb-target-val").textContent = spot ? fmt(tgt, 2) : "—";
    var dte = daysToExpiry(state.expiry);
    var remain = dte * (1 - state.dateFrac);
    if (state.dateFrac >= 0.999) {
      el("sb-date-label").textContent = "Expiry";
      el("sb-date-val").textContent = fmtExpiry(state.expiry);
    } else {
      el("sb-date-label").textContent = remain.toFixed(1) + "D left";
      var dt = new Date();
      dt.setTime(dt.getTime() + remain * 86400000);
      el("sb-date-val").textContent = dt.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
    }
  }

  function shiftStrikes(dir) {
    var step = strikeStep() * dir;
    state.legs.forEach(function (leg) {
      leg.strike = nearestStrike(leg.strike + step);
      refreshLegQuote(leg);
    });
    renderLegs();
  }

  function widthStrikes(dir) {
    if (state.legs.length < 2) return;
    var atm = atmStrike();
    state.legs.forEach(function (leg) {
      if (leg.strike === atm) return;
      var step = strikeStep() * dir * (leg.strike > atm ? 1 : -1);
      leg.strike = nearestStrike(leg.strike + step);
      refreshLegQuote(leg);
    });
    renderLegs();
  }

  function hedgeStrikes(dir) {
    var atm = atmStrike();
    var step = strikeStep();
    if (dir > 0) {
      var hasCeHedge = state.legs.some(function (l) { return l.side === "B" && l.type === "CE" && l.strike > atm; });
      var hasPeHedge = state.legs.some(function (l) { return l.side === "B" && l.type === "PE" && l.strike < atm; });
      if (!hasCeHedge) {
        var ce = { side: "B", type: "CE", strike: nearestStrike(atm + 4 * step), lots: 1, expiry: state.expiry, price: 0 };
        refreshLegQuote(ce); state.legs.push(ce);
      }
      if (!hasPeHedge) {
        var pe = { side: "B", type: "PE", strike: nearestStrike(atm - 4 * step), lots: 1, expiry: state.expiry, price: 0 };
        refreshLegQuote(pe); state.legs.push(pe);
      }
    } else {
      state.legs = state.legs.filter(function (l) {
        return !(l.side === "B" && ((l.type === "CE" && l.strike > atm + step) || (l.type === "PE" && l.strike < atm - step)));
      });
    }
    renderLegs();
  }

  async function loadUnderlyings() {
    var sel = el("sb-symbol");
    try {
      var res = await fetch("/api/5paisa/option-chain/underlyings");
      var data = await res.json();
      state.underlyings = (data.underlyings || []).map(function (u) { return u.symbol; });
      sel.innerHTML = "";
      var preferred = ["NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY"];
      var items = (data.underlyings || []).slice();
      items.sort(function (a, b) {
        var ia = preferred.indexOf(a.symbol); var ib = preferred.indexOf(b.symbol);
        if (ia < 0) ia = 99; if (ib < 0) ib = 99;
        return ia - ib || b.contracts - a.contracts;
      });
      items.forEach(function (u) {
        var opt = document.createElement("option");
        opt.value = u.symbol;
        opt.textContent = u.symbol;
        if (u.symbol === "NIFTY") opt.selected = true;
        sel.appendChild(opt);
      });
      if (!sel.value && items.length) sel.value = items[0].symbol;
      state.symbol = sel.value || "NIFTY";
      el("sb-symbol-search").value = state.symbol;
      await loadExpiries();
    } catch (e) {
      showMsg("Could not load underlyings. Connect 5Paisa and update scrip master.", true);
    }
  }

  async function loadExpiries() {
    var symbol = state.symbol;
    var sel = el("sb-expiry");
    sel.innerHTML = "<option>Loading…</option>";
    try {
      var res = await fetch("/api/5paisa/option-chain/expiries?symbol=" + encodeURIComponent(symbol));
      var data = await res.json();
      sel.innerHTML = "";
      state.expiries = data.expiries || [];
      if (!state.expiries.length) {
        sel.innerHTML = "<option>No expiries</option>";
        return;
      }
      state.expiries.forEach(function (d, i) {
        var opt = document.createElement("option");
        opt.value = d;
        opt.textContent = fmtExpiry(d) + " (" + d + ")";
        if (i === 0) opt.selected = true;
        sel.appendChild(opt);
      });
      state.expiry = sel.value;
      await loadChain(false);
    } catch (e) {
      sel.innerHTML = "<option>Failed</option>";
    }
  }

  async function loadChain(silent) {
    if (state.loading) return;
    var symbol = state.symbol;
    var expiry = el("sb-expiry").value;
    if (!symbol || !expiry) return;
    state.loading = true;
    var btn = el("sb-load-btn");
    if (btn && !silent) { btn.disabled = true; btn.textContent = "Loading…"; }
    el("sb-status").textContent = "Loading chain…";
    try {
      var res = await fetch("/api/5paisa/option-chain", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbol: symbol, expiry: expiry, strike_window: 16 })
      });
      var data = await res.json();
      if (!data.success) {
        showMsg(data.message || "Failed to load chain.", true);
        el("sb-status").textContent = data.message || "Failed";
        return;
      }
      state.expiry = expiry;
      state.chain = data.chain || [];
      state.spot = Number(data.spot) || 0;
      state.lot = lotOf();
      var chgEl = el("sb-chg");
      el("sb-spot").textContent = fmt(state.spot, 2);
      chgEl.textContent = "";
      chgEl.className = "sb-chg";
      state.legs.forEach(refreshLegQuote);
      renderChain();
      renderLegs();
      updateSliders();
      el("sb-status").textContent = "Updated " + new Date().toLocaleTimeString();
      if (!silent) showMsg("Loaded " + (data.strike_count || 0) + " strikes.", false);
    } catch (e) {
      showMsg("Error: " + e.message, true);
    } finally {
      state.loading = false;
      if (btn) { btn.disabled = false; btn.textContent = "Load"; }
    }
  }

  function filterSymbols(q) {
    q = (q || "").toUpperCase();
    return state.underlyings.filter(function (s) { return s.indexOf(q) >= 0; }).slice(0, 12);
  }

  function showSymbolDd() {
    var dd = el("sb-symbol-dd");
    var q = el("sb-symbol-search").value;
    var items = filterSymbols(q);
    if (!items.length) { dd.classList.add("hidden"); return; }
    dd.innerHTML = items.map(function (s) { return "<li data-sym=\"" + s + "\">" + s + "</li>"; }).join("");
    dd.classList.remove("hidden");
  }

  function pickSymbol(sym) {
    state.symbol = sym;
    el("sb-symbol").value = sym;
    el("sb-symbol-search").value = sym;
    el("sb-symbol-dd").classList.add("hidden");
    state.legs = [];
    state.strategyName = "New Strategy";
    state.strategyId = "";
    loadExpiries();
  }

  function setTab(tab) {
    document.querySelectorAll(".sb-chart-tab").forEach(function (b) {
      b.classList.toggle("active", b.dataset.tab === tab);
    });
    el("sb-payoff-wrap").classList.toggle("hidden", tab !== "payoff");
    el("sb-pnl-wrap").classList.toggle("hidden", tab !== "pnl");
    el("sb-greeks-wrap").classList.toggle("hidden", tab !== "greeks");
    if (tab === "payoff") drawPayoff();
  }

  function wire() {
    if (!el("sb-symbol") || state.wired) return;
    state.wired = true;
    renderReady();

    el("sb-symbol-search").addEventListener("input", showSymbolDd);
    el("sb-symbol-search").addEventListener("focus", showSymbolDd);
    el("sb-symbol-dd").addEventListener("click", function (e) {
      var li = e.target.closest("li");
      if (li) pickSymbol(li.dataset.sym);
    });
    document.addEventListener("click", function (e) {
      if (!e.target.closest(".sb-symbol-wrap")) el("sb-symbol-dd").classList.add("hidden");
    });
    el("sb-expiry").addEventListener("change", function () { loadChain(false); });
    el("sb-load-btn").addEventListener("click", function () { loadChain(false); });
    el("sb-auto-refresh").addEventListener("change", function () {
      clearInterval(state.timer);
      state.timer = null;
      if (el("sb-auto-refresh").checked) {
        state.timer = setInterval(function () { loadChain(true); }, 5000);
      }
    });
    el("sb-clear-btn").addEventListener("click", function () {
      state.legs = [];
      state.strategyName = "New Strategy";
      state.strategyId = "";
      renderLegs();
      renderReady();
    });
    el("sb-add-edit-btn").addEventListener("click", function () {
      state.chainOpen = !state.chainOpen;
      el("sb-chain-panel").classList.toggle("hidden", !state.chainOpen);
      el("sb-add-edit-btn").textContent = state.chainOpen ? "Hide Chain" : "Add/Edit";
    });
    el("sb-trade-btn").addEventListener("click", function () { setTab("payoff"); drawPayoff(); });

    el("sb-bias").addEventListener("click", function (e) {
      var btn = e.target.closest(".sb-bias-btn");
      if (!btn) return;
      state.bias = btn.dataset.bias;
      document.querySelectorAll(".sb-bias-btn").forEach(function (b) {
        b.classList.toggle("active", b === btn);
      });
      renderReady();
    });
    el("sb-ready-grid").addEventListener("click", function (e) {
      var card = e.target.closest(".sb-ready-card");
      if (!card) return;
      var tpl = findTpl(card.dataset.id);
      if (tpl) applyTemplate(tpl);
    });

    el("sb-legs-body").addEventListener("click", function (e) {
      var del = e.target.closest("[data-del]");
      if (del) {
        state.legs.splice(parseInt(del.dataset.del, 10), 1);
        renderLegs();
        return;
      }
      var bs = e.target.closest(".sb-bs");
      if (bs) {
        var i = parseInt(bs.dataset.i, 10);
        state.legs[i].side = state.legs[i].side === "B" ? "S" : "B";
        renderLegs();
      }
    });
    el("sb-legs-body").addEventListener("change", function (e) {
      var t = e.target;
      var i = parseInt(t.dataset.i, 10);
      if (isNaN(i) || !state.legs[i]) return;
      if (t.classList.contains("sb-leg-strike")) state.legs[i].strike = Number(t.value);
      if (t.classList.contains("sb-leg-type")) state.legs[i].type = t.value;
      if (t.classList.contains("sb-leg-exp")) state.legs[i].expiry = t.value;
      if (t.classList.contains("sb-leg-lots")) state.legs[i].lots = Math.max(1, parseInt(t.value, 10) || 1);
      refreshLegQuote(state.legs[i]);
      renderLegs();
    });

    el("sb-chain-body").addEventListener("click", function (e) {
      var btn = e.target.closest(".sb-bs-mini");
      if (!btn) return;
      toggleLegFromChain(Number(btn.dataset.k), btn.dataset.t, btn.dataset.s);
    });

    document.querySelectorAll(".sb-adj button").forEach(function (b) {
      b.addEventListener("click", function () {
        var adj = b.dataset.adj;
        var dir = parseInt(b.dataset.dir, 10);
        if (adj === "shift") shiftStrikes(dir);
        if (adj === "width") widthStrikes(dir);
        if (adj === "hedge") hedgeStrikes(dir);
      });
    });

    el("sb-chart-tabs").addEventListener("click", function (e) {
      var tab = e.target.closest(".sb-chart-tab");
      if (tab) setTab(tab.dataset.tab);
    });
    el("sb-target-range").addEventListener("input", function () {
      state.targetPct = Number(el("sb-target-range").value);
      updateSliders();
      drawPayoff();
      renderPnlTable();
      renderMetrics();
    });
    el("sb-date-range").addEventListener("input", function () {
      state.dateFrac = Number(el("sb-date-range").value) / 100;
      updateSliders();
      drawPayoff();
      renderPnlTable();
      renderGreeksTable();
    });
    window.addEventListener("resize", function () {
      if (el("page-option-strategy").classList.contains("active")) drawPayoff();
    });
    document.querySelectorAll(".nav-item[data-page]").forEach(function (link) {
      link.addEventListener("click", function () {
        if (link.dataset.page === "option-strategy") {
          drawPayoff();
          if (!el("sb-symbol").dataset.loaded) {
            el("sb-symbol").dataset.loaded = "1";
            loadUnderlyings();
          }
        } else {
          clearInterval(state.timer);
          state.timer = null;
          if (el("sb-auto-refresh")) el("sb-auto-refresh").checked = false;
        }
      });
    });
  }

  function init() {
    wire();
    if (el("sb-symbol") && !el("sb-symbol").dataset.loaded) {
      el("sb-symbol").dataset.loaded = "1";
      loadUnderlyings();
    } else {
      drawPayoff();
    }
  }

  window.initOptionStrategy = init;
  window._optionStrategyApplyTheme = function () { drawPayoff(); };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", wire);
  } else {
    wire();
  }
})();
