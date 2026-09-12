"""Parallel channel identifier (linear regression channel).

Fits a least-squares regression line through recent price action and draws two
parallel lines at ±k standard deviations above and below it. The center line,
upper line and lower line are all parallel by construction, forming a trend
channel. The band between the outer lines can be filled.
"""
from __future__ import annotations

import math


META = {
    "id": "parallel_channel",
    "name": "Parallel Channel",
    "overlay": True,
    "draw": "channel",
    "params": [
        {"key": "length", "label": "Length (bars)", "def": 100, "min": 10, "max": 1000, "step": 1},
        {"key": "deviation", "label": "Channel Width (σ)", "def": 2.0, "min": 0.5, "max": 5.0, "step": 0.1},
        {"key": "show_upper", "label": "Upper line", "def": True, "type": "bool"},
        {"key": "show_mid", "label": "Center line", "def": True, "type": "bool"},
        {"key": "show_lower", "label": "Lower line", "def": True, "type": "bool"},
        {"key": "fill", "label": "Fill channel", "def": True, "type": "bool"},
        {"key": "upper_color", "label": "Upper Color", "def": "#ef5350", "type": "color"},
        {"key": "mid_color", "label": "Center Color", "def": "#58a6ff", "type": "color"},
        {"key": "lower_color", "label": "Lower Color", "def": "#26a69a", "type": "color"},
        {"key": "fill_color", "label": "Fill Color", "def": "#58a6ff", "type": "color"},
    ],
}

_DEFAULT_UPPER = "#ef5350"
_DEFAULT_MID = "#58a6ff"
_DEFAULT_LOWER = "#26a69a"
_DEFAULT_FILL = "#58a6ff"


def _num(v, default=None):
    try:
        if v is None or v == "":
            return default
        return float(v)
    except (TypeError, ValueError):
        return default


def _bool(v, default=True):
    if v is None:
        return bool(default)
    if isinstance(v, str):
        return v.strip().lower() not in ("0", "false", "off", "no", "")
    return bool(v)


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


def _color(v, default):
    if isinstance(v, str) and v.strip():
        s = v.strip()
        if s.startswith("#") or s.startswith("rgb") or s.startswith("hsl"):
            return s
    return default


def _parse_candles(raw):
    times, opens, highs, lows, closes = [], [], [], [], []
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
    return times, opens, highs, lows, closes


def _channel(times, prices, start, slope, intercept, half_width):
    n = len(times)
    upper = [None] * n
    mid = [None] * n
    lower = [None] * n
    for i in range(start, n):
        x = float(i)
        center = intercept + slope * x
        mid[i] = center
        upper[i] = center + half_width
        lower[i] = center - half_width
    return upper, mid, lower


def compute(candles, params=None):
    params = params if isinstance(params, dict) else {}

    length = _int(params.get("length"), 100, 5, 2000)
    deviation = _float(params.get("deviation"), 2.0, 0.0, 20.0)
    show_upper = _bool(params.get("show_upper"), True)
    show_mid = _bool(params.get("show_mid"), True)
    show_lower = _bool(params.get("show_lower"), True)
    fill = _bool(params.get("fill"), True)
    upper_color = _color(params.get("upper_color"), _DEFAULT_UPPER)
    mid_color = _color(params.get("mid_color"), _DEFAULT_MID)
    lower_color = _color(params.get("lower_color"), _DEFAULT_LOWER)
    fill_color = _color(params.get("fill_color"), _DEFAULT_FILL)

    times, _o, _h, _l, closes = _parse_candles(candles)
    n = len(closes)

    empty = {
        "channel": {
            "times": times,
            "upper": [None] * n,
            "mid": [None] * n,
            "lower": [None] * n,
            "show_upper": show_upper,
            "show_mid": show_mid,
            "show_lower": show_lower,
            "fill": fill,
            "upper_color": upper_color,
            "mid_color": mid_color,
            "lower_color": lower_color,
            "fill_color": fill_color,
        },
        "stats": {"slope": 0.0, "half_width": 0.0, "bars": 0},
    }
    if n < 2:
        return empty

    start = max(0, n - length)
    m = n - start
    if m < 2:
        start = max(0, n - 2)
        m = n - start

    prices = closes[start:]
    xs = [float(start + k) for k in range(m)]
    xm = sum(xs) / m
    ym = sum(prices) / m
    sxx = 0.0
    sxy = 0.0
    for k in range(m):
        dx = xs[k] - xm
        sxx += dx * dx
        sxy += dx * (prices[k] - ym)

    if sxx <= 0.0:
        slope = 0.0
        intercept = ym
    else:
        slope = sxy / sxx
        intercept = ym - slope * xm

    resid = [prices[k] - (intercept + slope * xs[k]) for k in range(m)]
    var = sum(r * r for r in resid) / m
    std = math.sqrt(var)
    half_width = deviation * std

    upper, mid, lower = _channel(times, closes, start, slope, intercept, half_width)

    return {
        "channel": {
            "times": times,
            "upper": upper,
            "mid": mid,
            "lower": lower,
            "show_upper": show_upper,
            "show_mid": show_mid,
            "show_lower": show_lower,
            "fill": fill,
            "upper_color": upper_color,
            "mid_color": mid_color,
            "lower_color": lower_color,
            "fill_color": fill_color,
        },
        "stats": {
            "slope": slope,
            "half_width": half_width,
            "bars": m,
        },
    }
