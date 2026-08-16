"""Candlestick pattern detection with labeled text markers.

Detects common candlestick patterns and returns a text marker for each one,
placed above the candle (bearish → red, at the high) or below the candle
(bullish → green, at the low). Settings let the user toggle individual
patterns and pick the label font color and size.
"""
from __future__ import annotations


# (param key, label, marker code, direction)
# direction: "bull" (green / bottom), "bear" (red / top), "auto" (candle color)
_PATTERNS = [
    ("doji", "Doji", "D", "auto"),
    ("hammer", "Hammer", "H", "bull"),
    ("inverted_hammer", "Inverted Hammer", "IH", "bull"),
    ("shooting_star", "Shooting Star", "SS", "bear"),
    ("hanging_man", "Hanging Man", "HM", "bear"),
    ("marubozu", "Marubozu", "MB", "auto"),
    ("spinning_top", "Spinning Top", "ST", "auto"),
    ("pin_bar", "Pin Bar", "PB", "auto"),
    ("bullish_engulfing", "Bullish Engulfing", "BE", "bull"),
    ("bearish_engulfing", "Bearish Engulfing", "SE", "bear"),
    ("bullish_harami", "Bullish Harami", "BH", "bull"),
    ("bearish_harami", "Bearish Harami", "SH", "bear"),
    ("piercing_line", "Piercing Line", "PL", "bull"),
    ("dark_cloud_cover", "Dark Cloud Cover", "DC", "bear"),
    ("tweezer_bottom", "Tweezer Bottom", "TB", "bull"),
    ("tweezer_top", "Tweezer Top", "TT", "bear"),
    ("morning_star", "Morning Star", "MS", "bull"),
    ("evening_star", "Evening Star", "ES", "bear"),
    ("three_white_soldiers", "Three White Soldiers", "3W", "bull"),
    ("three_black_crows", "Three Black Crows", "3B", "bear"),
]

META = {
    "id": "candlestick_patterns",
    "name": "Candlestick Patterns",
    "overlay": True,
    "draw": "markers",
    "params": (
        [{"key": "show_" + key, "label": label, "def": True, "type": "bool"} for key, label, _c, _d in _PATTERNS]
        + [
            {"key": "font_size", "label": "Label Font Size", "def": 10, "min": 6, "max": 30, "step": 1},
            {"key": "bull_color", "label": "Bullish Color", "def": "#26a69a", "type": "color"},
            {"key": "bear_color", "label": "Bearish Color", "def": "#ef5350", "type": "color"},
        ]
    ),
}

_DEFAULT_BULL = "#26a69a"
_DEFAULT_BEAR = "#ef5350"


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


def compute(candles, params=None):
    params = params if isinstance(params, dict) else {}

    enabled = {}
    for key, _label, _code, _dir in _PATTERNS:
        enabled[key] = _bool(params.get("show_" + key), True)

    font_size = _int(params.get("font_size"), 10, 6, 40)
    bull_color = _color(params.get("bull_color"), _DEFAULT_BULL)
    bear_color = _color(params.get("bear_color"), _DEFAULT_BEAR)

    times, opens, highs, lows, closes = _parse_candles(candles)
    n = len(closes)

    empty = {
        "markers": [],
        "font_size": font_size,
        "stats": {"bullish": 0, "bearish": 0, "total": 0},
    }
    if n < 1:
        return empty

    body = [abs(closes[i] - opens[i]) for i in range(n)]
    rng = [highs[i] - lows[i] for i in range(n)]
    up_shadow = [highs[i] - max(opens[i], closes[i]) for i in range(n)]
    lo_shadow = [min(opens[i], closes[i]) - lows[i] for i in range(n)]
    is_bull = [closes[i] > opens[i] for i in range(n)]
    is_bear = [closes[i] < opens[i] for i in range(n)]

    markers = []
    n_bull = 0
    n_bear = 0

    def add(i, code, bull):
        nonlocal n_bull, n_bear
        if bull:
            n_bull += 1
            markers.append({
                "time": times[i],
                "value": lows[i],
                "position": "bottom",
                "text": code,
                "color": bull_color,
            })
        else:
            n_bear += 1
            markers.append({
                "time": times[i],
                "value": highs[i],
                "position": "top",
                "text": code,
                "color": bear_color,
            })

    # Average candle range for tolerance thresholds (tweezer matching etc.)
    avg_rng = 0.0
    seen = 0
    for r in rng:
        if r and r > 0:
            avg_rng += r
            seen += 1
    avg_rng = (avg_rng / seen) if seen else 0.0
    tol = max(avg_rng * 0.05, 1e-9)

    for i in range(n):
        r = rng[i]
        b = body[i]

        # --- Doji (very small body) ---
        if enabled.get("doji") and r > 0 and b <= 0.1 * r:
            add(i, "D", is_bull[i])

        # --- Hammer (bullish) ---
        if enabled.get("hammer") and b > 0 and r > 0 and lo_shadow[i] >= 2 * b and up_shadow[i] <= 0.2 * b and b <= 0.35 * r:
            add(i, "H", True)

        # --- Inverted Hammer (bullish) ---
        if enabled.get("inverted_hammer") and b > 0 and r > 0 and up_shadow[i] >= 2 * b and lo_shadow[i] <= 0.2 * b and b <= 0.35 * r:
            add(i, "IH", True)

        # --- Shooting Star (bearish, after up move) ---
        if enabled.get("shooting_star") and i >= 1 and b > 0 and r > 0 and up_shadow[i] >= 2 * b and lo_shadow[i] <= 0.2 * b and b <= 0.35 * r and is_bull[i - 1]:
            add(i, "SS", False)

        # --- Hanging Man (bearish, after up move) ---
        if enabled.get("hanging_man") and i >= 1 and b > 0 and r > 0 and lo_shadow[i] >= 2 * b and up_shadow[i] <= 0.2 * b and b <= 0.35 * r and is_bull[i - 1]:
            add(i, "HM", False)

        # --- Marubozu (large body, tiny shadows) ---
        if enabled.get("marubozu") and r > 0 and b >= 0.85 * r and b > 0:
            add(i, "MB", is_bull[i])

        # --- Spinning Top (small body, both shadows) ---
        if enabled.get("spinning_top") and r > 0 and 0.1 * r <= b <= 0.3 * r and up_shadow[i] >= 0.2 * r and lo_shadow[i] >= 0.2 * r:
            add(i, "ST", is_bull[i])

        # --- Pin Bar (one dominant shadow) ---
        if enabled.get("pin_bar") and b > 0 and r > 0:
            if lo_shadow[i] >= 2 * b and up_shadow[i] <= 0.2 * b:
                add(i, "PB", True)
            elif up_shadow[i] >= 2 * b and lo_shadow[i] <= 0.2 * b:
                add(i, "PB", False)

        # --- Two-candle patterns ---
        if i >= 1:
            po, pc = opens[i - 1], closes[i - 1]
            pb = body[i - 1]

            if enabled.get("bullish_engulfing") and is_bear[i - 1] and is_bull[i] and closes[i] >= po and opens[i] <= pc:
                add(i, "BE", True)

            if enabled.get("bearish_engulfing") and is_bull[i - 1] and is_bear[i] and opens[i] >= pc and closes[i] <= po:
                add(i, "SE", False)

            if enabled.get("bullish_harami") and pb > 0 and is_bear[i - 1] and is_bull[i] and closes[i] <= po and opens[i] >= pc:
                add(i, "BH", True)

            if enabled.get("bearish_harami") and pb > 0 and is_bull[i - 1] and is_bear[i] and opens[i] <= pc and closes[i] >= po:
                add(i, "SH", False)

            if enabled.get("piercing_line") and pb > 0 and is_bear[i - 1] and is_bull[i]:
                mid = (po + pc) / 2.0
                if opens[i] < pc and mid < closes[i] < po:
                    add(i, "PL", True)

            if enabled.get("dark_cloud_cover") and pb > 0 and is_bull[i - 1] and is_bear[i]:
                mid = (po + pc) / 2.0
                if opens[i] > pc and po < closes[i] < mid:
                    add(i, "DC", False)

            if enabled.get("tweezer_bottom") and is_bear[i - 1] and abs(lows[i] - lows[i - 1]) <= tol:
                add(i, "TB", True)

            if enabled.get("tweezer_top") and is_bull[i - 1] and abs(highs[i] - highs[i - 1]) <= tol:
                add(i, "TT", False)

        # --- Three-candle patterns ---
        if i >= 2:
            if enabled.get("morning_star"):
                b0 = body[i - 2]
                if is_bear[i - 2] and is_bull[i] and b0 > 0 and body[i] > 0:
                    mid = (opens[i - 2] + closes[i - 2]) / 2.0
                    star = body[i - 1] <= 0.3 * max(b0, body[i])
                    if star and closes[i] > mid:
                        add(i, "MS", True)

            if enabled.get("evening_star"):
                b0 = body[i - 2]
                if is_bull[i - 2] and is_bear[i] and b0 > 0 and body[i] > 0:
                    mid = (opens[i - 2] + closes[i - 2]) / 2.0
                    star = body[i - 1] <= 0.3 * max(b0, body[i])
                    if star and closes[i] < mid:
                        add(i, "ES", False)

            if enabled.get("three_white_soldiers"):
                ok = is_bull[i - 2] and is_bull[i - 1] and is_bull[i]
                if ok and closes[i] > closes[i - 1] > closes[i - 2]:
                    ok = opens[i - 1] >= opens[i - 2] and opens[i - 1] <= closes[i - 2]
                    ok = ok and opens[i] >= opens[i - 1] and opens[i] <= closes[i - 1]
                    if ok:
                        add(i, "3W", True)

            if enabled.get("three_black_crows"):
                ok = is_bear[i - 2] and is_bear[i - 1] and is_bear[i]
                if ok and closes[i] < closes[i - 1] < closes[i - 2]:
                    ok = opens[i - 1] <= opens[i - 2] and opens[i - 1] >= closes[i - 2]
                    ok = ok and opens[i] <= opens[i - 1] and opens[i] >= closes[i - 1]
                    if ok:
                        add(i, "3B", False)

    return {
        "markers": markers,
        "font_size": font_size,
        "stats": {
            "bullish": n_bull,
            "bearish": n_bear,
            "total": n_bull + n_bear,
        },
    }
