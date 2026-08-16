"""Demand & Supply zones from confirmed swing highs/lows + ATR (Pine-style).

Supply = pivot high box (top = swing high, bottom = high - ATR buffer)
Demand = pivot low box (bottom = swing low, top = low + ATR buffer)
Overlapping POIs within 2×ATR are rejected. Close through the zone edge → BOS.
"""
from __future__ import annotations


META = {
    "id": "demand_supply",
    "name": "Demand & Supply",
    "overlay": True,
    "draw": "zones",
    "params": [
        {"key": "swing_length", "label": "Swing Length", "def": 10, "min": 1, "max": 100, "step": 1},
        {"key": "atr_period", "label": "ATR Period", "def": 50, "min": 2, "max": 200, "step": 1},
        {"key": "box_width", "label": "Box Width", "def": 2.5, "min": 0.1, "max": 20, "step": 0.1},
        {"key": "overlap_atr", "label": "Overlap ATR ×", "def": 2.0, "min": 0.1, "max": 20, "step": 0.1},
        {"key": "history", "label": "Zone History", "def": 20, "min": 1, "max": 100, "step": 1},
        {"key": "show_supply", "label": "Supply band", "def": True, "type": "bool"},
        {"key": "show_demand", "label": "Demand band", "def": True, "type": "bool"},
        {"key": "show_bos", "label": "BOS", "def": True, "type": "bool"},
    ],
}


def _num(v, default=None):
    try:
        if v is None or v == "":
            return default
        return float(v)
    except (TypeError, ValueError):
        return default


def _int(v, default, lo=None, hi=None):
    n = _num(v, default)
    if n is None:
        n = default
    n = int(round(n))
    if lo is not None:
        n = max(lo, n)
    if hi is not None:
        n = min(hi, n)
    return n


def _float(v, default, lo=None, hi=None):
    n = _num(v, default)
    if n is None:
        n = default
    if lo is not None:
        n = max(lo, n)
    if hi is not None:
        n = min(hi, n)
    return n


def _bool(v, default=True):
    if v is None:
        return bool(default)
    if isinstance(v, str):
        return v.strip().lower() not in ("0", "false", "off", "no", "")
    return bool(v)


def _parse_candles(raw):
    times, opens, highs, lows, closes, volumes = [], [], [], [], [], []
    for c in raw or []:
        if not isinstance(c, dict):
            continue
        ts = c.get("timestamp", c.get("time"))
        o = _num(c.get("open"))
        h = _num(c.get("high"))
        l = _num(c.get("low"))
        cl = _num(c.get("close"))
        if ts is None or o is None or h is None or l is None or cl is None:
            continue
        times.append(int(ts) if not isinstance(ts, float) else ts)
        opens.append(o)
        highs.append(h)
        lows.append(l)
        closes.append(cl)
        volumes.append(_num(c.get("volume"), 0.0) or 0.0)
    return times, opens, highs, lows, closes, volumes


def _rma_atr(highs, lows, closes, period):
    n = len(closes)
    atr = [None] * n
    if n == 0 or period < 1:
        return atr
    tr = [0.0] * n
    tr[0] = max(0.0, highs[0] - lows[0])
    for i in range(1, n):
        tr[i] = max(
            highs[i] - lows[i],
            abs(highs[i] - closes[i - 1]),
            abs(lows[i] - closes[i - 1]),
        )
    if n < period:
        return atr
    atr[period - 1] = sum(tr[:period]) / period
    alpha = 1.0 / period
    for i in range(period, n):
        atr[i] = atr[i - 1] + alpha * (tr[i] - atr[i - 1])
    return atr


def _is_strict_pivot(values, i, left, right, want_high):
    v = values[i]
    lo = i - left
    hi = i + right
    for j in range(lo, hi + 1):
        if j == i:
            continue
        if want_high:
            if values[j] >= v:
                return False
        else:
            if values[j] <= v:
                return False
    return True


def _push(arr, item, cap):
    arr.insert(0, item)
    while len(arr) > cap:
        arr.pop()


def _poi_too_close(poi, zones, threshold):
    if threshold is None:
        return True
    for z in zones:
        if abs(poi - z["poi"]) <= threshold:
            return True
    return False


def _dump_zone(z, last_i, last_t):
    end_i = z["end_i"] if z["end_i"] is not None else last_i
    end_t = z["end_t"] if z["end_t"] is not None else last_t
    if end_i < z["start_i"]:
        end_i = z["start_i"]
        end_t = z["start_t"]
    return {
        "type": z["type"],
        "top": z["top"],
        "bottom": z["bottom"],
        "poi": z["poi"],
        "start_index": z["start_i"],
        "end_index": end_i,
        "start_time": z["start_t"],
        "end_time": end_t,
        "broken": bool(z["broken"]),
    }


def compute(candles, params=None):
    params = params if isinstance(params, dict) else {}
    swing = _int(params.get("swing_length"), 10, 1, 200)
    atr_period = _int(params.get("atr_period"), 50, 2, 500)
    box_width = _float(params.get("box_width"), 2.5, 0.1, 50)
    overlap_mult = _float(params.get("overlap_atr"), 2.0, 0.0, 50)
    history = _int(params.get("history"), 20, 1, 200)
    show_supply = _bool(params.get("show_supply"), True)
    show_demand = _bool(params.get("show_demand"), True)
    show_bos = _bool(params.get("show_bos"), True)

    times, _o, highs, lows, closes, _v = _parse_candles(candles)
    n = len(closes)
    empty = {"zones": [], "stats": {"supply": 0, "demand": 0, "bos": 0}}
    if n < max(swing * 2 + 1, atr_period + 1):
        return empty

    atr = _rma_atr(highs, lows, closes, atr_period)
    buf_mult = box_width / 10.0

    ph_val = [None] * n
    ph_idx = [None] * n
    pl_val = [None] * n
    pl_idx = [None] * n
    for i in range(swing, n - swing):
        conf = i + swing
        if _is_strict_pivot(highs, i, swing, swing, True):
            ph_val[conf] = highs[i]
            ph_idx[conf] = i
        if _is_strict_pivot(lows, i, swing, swing, False):
            pl_val[conf] = lows[i]
            pl_idx[conf] = i

    supply, demand, bos = [], [], []

    def break_side(arr, i, is_supply):
        kept = []
        for z in arr:
            hit = closes[i] >= z["top"] if is_supply else closes[i] <= z["bottom"]
            if hit:
                z["broken"] = True
                z["end_i"] = i
                z["end_t"] = times[i]
                z["type"] = "bos"
                _push(bos, z, history)
            else:
                kept.append(z)
        return kept

    for i in range(n):
        supply = break_side(supply, i, True)
        demand = break_side(demand, i, False)
        if ph_val[i] is not None:
            a = atr[i]
            if a is not None and a > 0:
                buf = a * buf_mult
                top = ph_val[i]
                bottom = top - buf
                poi = (top + bottom) / 2.0
                if top > bottom and not _poi_too_close(poi, supply + demand, a * overlap_mult):
                    z = {
                        "type": "supply",
                        "top": top,
                        "bottom": bottom,
                        "poi": poi,
                        "start_i": ph_idx[i],
                        "start_t": times[ph_idx[i]],
                        "end_i": None,
                        "end_t": None,
                        "broken": False,
                    }
                    if closes[i] >= top:
                        z["broken"] = True
                        z["end_i"] = i
                        z["end_t"] = times[i]
                        z["type"] = "bos"
                        _push(bos, z, history)
                    else:
                        _push(supply, z, history)
        if pl_val[i] is not None:
            a = atr[i]
            if a is not None and a > 0:
                buf = a * buf_mult
                bottom = pl_val[i]
                top = bottom + buf
                poi = (top + bottom) / 2.0
                if top > bottom and not _poi_too_close(poi, demand + supply, a * overlap_mult):
                    z = {
                        "type": "demand",
                        "top": top,
                        "bottom": bottom,
                        "poi": poi,
                        "start_i": pl_idx[i],
                        "start_t": times[pl_idx[i]],
                        "end_i": None,
                        "end_t": None,
                        "broken": False,
                    }
                    if closes[i] <= bottom:
                        z["broken"] = True
                        z["end_i"] = i
                        z["end_t"] = times[i]
                        z["type"] = "bos"
                        _push(bos, z, history)
                    else:
                        _push(demand, z, history)

    last_i = n - 1
    last_t = times[last_i]
    zones = []
    if show_demand:
        for z in reversed(demand):
            zones.append(_dump_zone(z, last_i, last_t))
    if show_supply:
        for z in reversed(supply):
            zones.append(_dump_zone(z, last_i, last_t))
    if show_bos:
        for z in reversed(bos):
            zones.append(_dump_zone(z, last_i, last_t))
    return {
        "zones": zones,
        "stats": {
            "supply": len(supply) if show_supply else 0,
            "demand": len(demand) if show_demand else 0,
            "bos": len(bos) if show_bos else 0,
        },
    }
