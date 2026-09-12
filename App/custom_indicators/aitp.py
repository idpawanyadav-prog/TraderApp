"""Adaptive Intraday Trend Pullback (AITP) — causal strategy + backtest.

Higher-timeframe regime (default 15m) gates 5-minute pullback entries.
No future bars are used. A NO-TRADE state is first-class: weak ADX,
extreme ATR percentile, open/close windows, and score < threshold
produce no order.

Add from Home → Indicators → Custom → Python indicators.
Load a 5-minute chart of one liquid index (NIFTY) first.
"""
from __future__ import annotations

from analysis.strategy_backtest import run_backtest
from custom_indicators._ta import (
    adx as wilder_adx,
    align_htf,
    as_bool,
    as_float,
    as_int,
    atr as wilder_atr,
    ema,
    finite,
    infer_bar_minutes,
    parse_candles,
    percentile_rank,
    resample_completed,
    rsi as wilder_rsi,
    sma,
)

META = {
    "id": "aitp",
    "name": "AITP Strategy",
    "overlay": True,
    "draw": "strategy",
    "params": [
        {"key": "htf_minutes", "label": "Higher TF (min)", "def": 15, "min": 5, "max": 60, "step": 5, "group": "Regime"},
        {"key": "ema_fast", "label": "HTF EMA fast", "def": 50, "min": 5, "max": 200, "step": 1, "group": "Regime"},
        {"key": "ema_slow", "label": "HTF EMA slow", "def": 200, "min": 20, "max": 400, "step": 1, "group": "Regime"},
        {"key": "adx_period", "label": "ADX period", "def": 14, "min": 5, "max": 50, "step": 1, "group": "Regime"},
        {"key": "adx_trend", "label": "ADX trend >", "def": 20, "min": 10, "max": 40, "step": 1, "group": "Regime"},
        {"key": "adx_range", "label": "ADX range <", "def": 18, "min": 5, "max": 30, "step": 1, "group": "Regime"},
        {"key": "slope_bars", "label": "EMA slope bars", "def": 5, "min": 2, "max": 20, "step": 1, "group": "Regime"},
        {"key": "atr_period", "label": "ATR period", "def": 14, "min": 5, "max": 50, "step": 1, "group": "Volatility"},
        {"key": "atr_lookback", "label": "ATR percentile lookback", "def": 60, "min": 20, "max": 200, "step": 1, "group": "Volatility"},
        {"key": "atr_p_lo", "label": "ATR percentile min", "def": 30, "min": 0, "max": 50, "step": 1, "group": "Volatility"},
        {"key": "atr_p_hi", "label": "ATR percentile max", "def": 90, "min": 50, "max": 100, "step": 1, "group": "Volatility"},
        {"key": "ema20", "label": "Exec EMA 20", "def": 20, "min": 5, "max": 80, "step": 1, "group": "Pullback"},
        {"key": "ema50_exec", "label": "Exec EMA 50", "def": 50, "min": 10, "max": 200, "step": 1, "group": "Pullback"},
        {"key": "pb_atr_frac", "label": "Pullback EMA20 × ATR", "def": 0.5, "min": 0.1, "max": 2, "step": 0.1, "group": "Pullback"},
        {"key": "vol_sma", "label": "Volume SMA", "def": 20, "min": 5, "max": 80, "step": 1, "group": "Pullback"},
        {"key": "vol_confirm", "label": "Reversal volume ×", "def": 1.2, "min": 0.8, "max": 3, "step": 0.1, "group": "Pullback"},
        {"key": "rsi_period", "label": "RSI period", "def": 14, "min": 5, "max": 50, "step": 1, "group": "Pullback"},
        {"key": "score_threshold", "label": "Trade score ≥", "def": 75, "min": 50, "max": 95, "step": 1, "group": "Signal"},
        {"key": "use_causal", "label": "Causal CE trend filter", "def": True, "type": "bool", "group": "Signal"},
        {"key": "ce_slope_k", "label": "CE slope bars", "def": 5, "min": 2, "max": 20, "step": 1, "group": "Signal"},
        {"key": "ce_slope_th", "label": "CE slope / ATR ≥", "def": 0.05, "min": 0, "max": 2, "step": 0.01, "group": "Signal"},
        {"key": "tick_size", "label": "Tick size", "def": 0.05, "min": 0.01, "max": 5, "step": 0.01, "group": "Execution"},
        {"key": "tick_buffer", "label": "Entry tick buffer", "def": 1, "min": 0, "max": 20, "step": 1, "group": "Execution"},
        {"key": "lot_size", "label": "Lot size (units)", "def": 65, "min": 1, "max": 5000, "step": 1, "group": "Execution"},
        {"key": "account", "label": "Account (₹)", "def": 1000000, "min": 10000, "max": 100000000, "step": 10000, "group": "Risk"},
        {"key": "risk_pct", "label": "Risk / trade %", "def": 0.5, "min": 0.1, "max": 5, "step": 0.1, "group": "Risk"},
        {"key": "max_daily_loss_pct", "label": "Max daily loss %", "def": 1.5, "min": 0.2, "max": 10, "step": 0.1, "group": "Risk"},
        {"key": "max_consecutive_losses", "label": "Max consecutive losses", "def": 3, "min": 1, "max": 10, "step": 1, "group": "Risk"},
        {"key": "slippage_ticks", "label": "Slippage ticks", "def": 1, "min": 0, "max": 20, "step": 1, "group": "Costs"},
        {"key": "spread_ticks", "label": "Spread ticks", "def": 1, "min": 0, "max": 20, "step": 1, "group": "Costs"},
        {"key": "brokerage_pct", "label": "Brokerage % notional", "def": 0.03, "min": 0, "max": 1, "step": 0.01, "group": "Costs"},
        {"key": "skip_open_min", "label": "Skip first minutes", "def": 15, "min": 0, "max": 60, "step": 1, "group": "Session"},
        {"key": "no_entry_after_min", "label": "No entry after (min from midnight IST)", "def": 885, "min": 600, "max": 960, "step": 5, "group": "Session"},
        {"key": "square_off_min", "label": "Square-off (min IST)", "def": 915, "min": 720, "max": 960, "step": 5, "group": "Session"},
        {"key": "monte_carlo", "label": "Monte Carlo shuffles", "def": 0, "min": 0, "max": 500, "step": 50, "group": "Research"},
        {"key": "show_rejected", "label": "Mark near-miss setups", "def": False, "type": "bool", "group": "Research"},
    ],
}


def _causal_ce(closes):
    try:
        from custom_indicators.smoothing import apply_model, FACTORY_LEVELS
    except Exception:
        return None
    if not FACTORY_LEVELS or len(closes) < 8:
        return None
    y = list(closes)
    src = y
    last = None
    for i, cfg in enumerate(FACTORY_LEVELS):
        row = dict(cfg)
        last = apply_model(src, row.get("model"), row)
        src = last
    return last


def _regime(fast, slow, slope, adx_v, adx_trend, adx_range):
    if not all(finite(x) for x in (fast, slow, slope, adx_v)):
        return "NONE"
    if adx_v < adx_range:
        return "RANGE"
    if adx_range <= adx_v <= adx_trend:
        return "DEAD"
    if fast > slow and slope > 0 and adx_v > adx_trend:
        return "STRONG_UPTREND"
    if fast < slow and slope < 0 and adx_v > adx_trend:
        return "STRONG_DOWNTREND"
    return "NONE"


def _score_long(htf_ok, adx_v, ema_dist, ema_slope, pb_vol, vol_ok, rsi_v, structure, vol_ok_band):
    s = 0.0
    s += 20.0 if htf_ok else 0.0
    s += 10.0 * min(max((adx_v or 0.0) / 40.0, 0.0), 1.0)
    s += 10.0 * min(max((ema_dist or 0.0) / 2.0, 0.0), 1.0)
    s += 10.0 * min(max(ema_slope or 0.0, 0.0), 1.0)
    if pb_vol is not None and pb_vol < 1.0:
        s += 15.0
    elif pb_vol is not None and pb_vol < 1.2:
        s += 7.0
    s += 10.0 if vol_ok else 0.0
    if rsi_v is not None:
        s += 10.0 * min(max((rsi_v - 50.0) / 20.0, 0.0), 1.0)
    s += 10.0 if structure else 0.0
    s += 5.0 if vol_ok_band else 0.0
    return s


def _score_short(htf_ok, adx_v, ema_dist, ema_slope, pb_vol, vol_ok, rsi_v, structure, vol_ok_band):
    s = 0.0
    s += 20.0 if htf_ok else 0.0
    s += 10.0 * min(max((adx_v or 0.0) / 40.0, 0.0), 1.0)
    s += 10.0 * min(max((ema_dist or 0.0) / 2.0, 0.0), 1.0)
    s += 10.0 * min(max(-(ema_slope or 0.0), 0.0), 1.0)
    if pb_vol is not None and pb_vol < 1.0:
        s += 15.0
    elif pb_vol is not None and pb_vol < 1.2:
        s += 7.0
    s += 10.0 if vol_ok else 0.0
    if rsi_v is not None:
        s += 10.0 * min(max((50.0 - rsi_v) / 20.0, 0.0), 1.0)
    s += 10.0 if structure else 0.0
    s += 5.0 if vol_ok_band else 0.0
    return s


def _pullback_vol(volumes, vol_sma, start, end):
    if start < 0 or end < start:
        return None
    vals = []
    for j in range(start, end + 1):
        base = vol_sma[j]
        if base and base > 0:
            vals.append(volumes[j] / base)
    if not vals:
        return None
    return sum(vals) / len(vals)


def _swing_low(lows, start, end):
    sl = None
    for j in range(max(0, start), min(end, len(lows) - 1) + 1):
        sl = lows[j] if sl is None else min(sl, lows[j])
    return sl


def _swing_high(highs, start, end):
    sh = None
    for j in range(max(0, start), min(end, len(highs) - 1) + 1):
        sh = highs[j] if sh is None else max(sh, highs[j])
    return sh


def compute(candles, params=None):
    params = params if isinstance(params, dict) else {}
    times, opens, highs, lows, closes, volumes = parse_candles(candles)
    n = len(times)
    empty = {"markers": [], "trades": [], "stats": {"bars": n}}
    if n < 250:
        empty["stats"]["error"] = "Need at least 250 bars (load more 5m history)."
        return empty

    htf_min = as_int(params.get("htf_minutes"), 15, 5, 60)
    ema_fast_n = as_int(params.get("ema_fast"), 50, 5, 200)
    ema_slow_n = as_int(params.get("ema_slow"), 200, 20, 400)
    adx_n = as_int(params.get("adx_period"), 14, 5, 50)
    adx_trend = as_float(params.get("adx_trend"), 20, 10, 40)
    adx_range = as_float(params.get("adx_range"), 18, 5, 30)
    slope_bars = as_int(params.get("slope_bars"), 5, 2, 20)
    atr_n = as_int(params.get("atr_period"), 14, 5, 50)
    atr_lb = as_int(params.get("atr_lookback"), 60, 20, 200)
    p_lo = as_float(params.get("atr_p_lo"), 30, 0, 50)
    p_hi = as_float(params.get("atr_p_hi"), 90, 50, 100)
    ema20_n = as_int(params.get("ema20"), 20, 5, 80)
    ema50e_n = as_int(params.get("ema50_exec"), 50, 10, 200)
    pb_frac = as_float(params.get("pb_atr_frac"), 0.5, 0.1, 2.0)
    vol_n = as_int(params.get("vol_sma"), 20, 5, 80)
    vol_x = as_float(params.get("vol_confirm"), 1.2, 0.8, 3.0)
    rsi_n = as_int(params.get("rsi_period"), 14, 5, 50)
    thresh = as_float(params.get("score_threshold"), 75, 50, 95)
    use_ce = as_bool(params.get("use_causal"), True)
    ce_k = as_int(params.get("ce_slope_k"), 5, 2, 20)
    ce_th = as_float(params.get("ce_slope_th"), 0.05, 0, 2)
    tick = as_float(params.get("tick_size"), 0.05, 0.01, 5)
    tick_buf = as_int(params.get("tick_buffer"), 1, 0, 20)
    show_rej = as_bool(params.get("show_rejected"), False)

    bar_min = infer_bar_minutes(times)
    same_tf = bar_min >= htf_min - 0.6

    if same_tf:
        h_open, h_high, h_low, h_close = opens, highs, lows, closes
        h_map = list(range(n))
        htf = {"map": h_map, "c": h_close, "h": h_high, "l": h_low, "o": h_open}
    else:
        htf = resample_completed(times, opens, highs, lows, closes, volumes, htf_min)
        h_open, h_high, h_low, h_close = htf["o"], htf["h"], htf["l"], htf["c"]
        if len(h_close) < ema_slow_n + 10:
            empty["stats"]["error"] = "Not enough completed %sm bars (need ~%s)." % (htf_min, ema_slow_n + 10)
            empty["stats"]["htf_bars"] = len(h_close)
            return empty

    h_ema_f = ema(h_close, ema_fast_n)
    h_ema_s = ema(h_close, ema_slow_n)
    h_atr = wilder_atr(h_high, h_low, h_close, atr_n)
    h_adx, _, _ = wilder_adx(h_high, h_low, h_close, adx_n)
    h_atr_pct = percentile_rank(h_atr, atr_lb)
    h_ce = _causal_ce(h_close) if use_ce else None

    a_fast = align_htf(h_ema_f, htf["map"])
    a_slow = align_htf(h_ema_s, htf["map"])
    a_atr = align_htf(h_atr, htf["map"])
    a_adx = align_htf(h_adx, htf["map"])
    a_pct = align_htf(h_atr_pct, htf["map"])
    a_ce = align_htf(list(h_ce) if h_ce is not None else [], htf["map"]) if h_ce is not None else [None] * n

    e20 = ema(closes, ema20_n)
    e50 = ema(closes, ema50e_n)
    e_atr = wilder_atr(highs, lows, closes, atr_n)
    e_rsi = wilder_rsi(closes, rsi_n)
    v_sma = sma(volumes, vol_n)

    setups = []
    markers = []
    last_long_pb = None
    last_short_pb = None
    n_up = n_down = n_range = n_dead = 0
    n_long_cand = n_short_cand = 0

    for i in range(1, n):
        hj = htf["map"][i]
        if hj < 0:
            continue
        fast = a_fast[i]
        slow = a_slow[i]
        atr_h = a_atr[i]
        adx_v = a_adx[i]
        atr_p = a_pct[i]
        if not all(finite(x) for x in (fast, slow, atr_h, adx_v, e20[i], e50[i], e_atr[i])):
            continue
        if atr_h <= 0 or e_atr[i] <= 0:
            continue

        slope = None
        hj_prev = hj - slope_bars
        if hj_prev >= 0 and finite(h_ema_f[hj]) and finite(h_ema_f[hj_prev]):
            slope = (h_ema_f[hj] - h_ema_f[hj_prev]) / atr_h
        else:
            continue

        regime = _regime(fast, slow, slope, adx_v, adx_trend, adx_range)
        if regime == "STRONG_UPTREND":
            n_up += 1
        elif regime == "STRONG_DOWNTREND":
            n_down += 1
        elif regime == "RANGE":
            n_range += 1
        elif regime == "DEAD":
            n_dead += 1
        vol_ok_band = finite(atr_p) and p_lo <= atr_p <= p_hi
        ema_dist = abs(fast - slow) / atr_h

        ce_slope = None
        if h_ce is not None and hj >= ce_k and finite(h_ce[hj]) and finite(h_ce[hj - ce_k]):
            ce_slope = (float(h_ce[hj]) - float(h_ce[hj - ce_k])) / atr_h

        near20 = lows[i] <= e20[i] + pb_frac * e_atr[i]
        near20_s = highs[i] >= e20[i] - pb_frac * e_atr[i]

        if regime == "STRONG_UPTREND" and near20 and closes[i] >= e50[i]:
            last_long_pb = i
        if regime == "STRONG_DOWNTREND" and near20_s and closes[i] <= e50[i]:
            last_short_pb = i
        if last_long_pb is not None and i - last_long_pb > 12:
            last_long_pb = None
        if last_short_pb is not None and i - last_short_pb > 12:
            last_short_pb = None

        vol_ok = finite(v_sma[i]) and v_sma[i] > 0 and volumes[i] > v_sma[i] * vol_x
        long_struct = closes[i] > opens[i] and closes[i] > highs[i - 1]
        short_struct = closes[i] < opens[i] and closes[i] < lows[i - 1]
        long_pb = last_long_pb is not None and (i - last_long_pb) <= 12
        short_pb = last_short_pb is not None and (i - last_short_pb) <= 12

        ce_long = (not use_ce) or (ce_slope is not None and ce_slope > ce_th)
        ce_short = (not use_ce) or (ce_slope is not None and ce_slope < -ce_th)

        pb_vol_l = None
        if last_long_pb is not None:
            pb_vol_l = _pullback_vol(volumes, v_sma, max(0, last_long_pb - 8), i)
        pb_vol_s = None
        if last_short_pb is not None:
            pb_vol_s = _pullback_vol(volumes, v_sma, max(0, last_short_pb - 8), i)

        htf_long = regime == "STRONG_UPTREND"
        htf_short = regime == "STRONG_DOWNTREND"

        long_ok = (
            htf_long and vol_ok_band and long_pb and long_struct
            and finite(e_rsi[i]) and e_rsi[i] > 50 and vol_ok and ce_long
        )
        short_ok = (
            htf_short and vol_ok_band and short_pb and short_struct
            and finite(e_rsi[i]) and e_rsi[i] < 50 and vol_ok and ce_short
        )
        if htf_long and long_pb and long_struct:
            n_long_cand += 1
        if htf_short and short_pb and short_struct:
            n_short_cand += 1

        score_l = _score_long(
            htf_long, adx_v, ema_dist, slope or 0.0, pb_vol_l, vol_ok,
            e_rsi[i], long_struct, vol_ok_band,
        )
        score_s = _score_short(
            htf_short, adx_v, ema_dist, slope or 0.0, pb_vol_s, vol_ok,
            e_rsi[i], short_struct, vol_ok_band,
        )

        def emit(side, score, cond):
            if cond and score >= thresh:
                if side == 1:
                    entry = highs[i] + tick_buf * tick
                    pb0 = last_long_pb if last_long_pb is not None else i - 12
                    s1 = _swing_low(lows, pb0, i)
                    s2 = entry - 1.2 * e_atr[i]
                    stop = min(s1 if s1 is not None else s2, s2)
                else:
                    entry = lows[i] - tick_buf * tick
                    pb0 = last_short_pb if last_short_pb is not None else i - 12
                    s1 = _swing_high(highs, pb0, i)
                    s2 = entry + 1.2 * e_atr[i]
                    stop = max(s1 if s1 is not None else s2, s2)
                setups.append({
                    "index": i,
                    "side": side,
                    "entry": entry,
                    "stop": stop,
                    "atr": e_atr[i],
                    "score": round(score, 1),
                    "time": times[i],
                })
                markers.append({
                    "time": times[i],
                    "value": lows[i] if side == 1 else highs[i],
                    "text": "L" if side == 1 else "S",
                    "position": "bottom" if side == 1 else "top",
                    "color": "#26a69a" if side == 1 else "#ef5350",
                })
            elif show_rej and score >= thresh - 15 and (htf_long if side == 1 else htf_short):
                if (side == 1 and long_pb) or (side == -1 and short_pb):
                    markers.append({
                        "time": times[i],
                        "value": lows[i] if side == 1 else highs[i],
                        "text": str(int(score)),
                        "position": "bottom" if side == 1 else "top",
                        "color": "#8b949e",
                    })

        if long_ok and short_ok:
            if score_l >= score_s:
                emit(1, score_l, True)
            else:
                emit(-1, score_s, True)
        elif long_ok:
            emit(1, score_l, True)
        elif short_ok:
            emit(-1, score_s, True)
        elif show_rej:
            emit(1, score_l, False)
            emit(-1, score_s, False)

    bt = run_backtest(candles, setups, params)
    stats = dict(bt.get("stats") or {})
    stats.update({
        "bars": n,
        "bar_minutes": round(bar_min, 2),
        "htf_minutes": htf_min,
        "setups": len(setups),
        "threshold": thresh,
        "regime_up": n_up,
        "regime_down": n_down,
        "regime_range": n_range,
        "regime_dead": n_dead,
        "pullback_long": n_long_cand,
        "pullback_short": n_short_cand,
        "backtest": True,
    })
    if stats.get("monte_carlo"):
        mc = stats["monte_carlo"]
        stats["mc_dd_p95"] = mc.get("dd_p95")
        stats["mc_net_p50"] = mc.get("net_p50")

    trades = bt.get("trades") or []
    for t in trades:
        side_long = t.get("side") == "long"
        markers.append({
            "time": t.get("exit_time"),
            "value": t.get("exit_price"),
            "text": (t.get("reason") or "x")[:2].upper(),
            "position": "top" if side_long else "bottom",
            "color": "#3fb950" if t.get("win") else "#f85149",
        })

    return {
        "markers": markers,
        "trades": trades,
        "equity": bt.get("equity") or [],
        "stats": stats,
    }
