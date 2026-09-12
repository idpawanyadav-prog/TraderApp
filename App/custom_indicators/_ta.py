"""Causal technical helpers for strategy indicators (not a chart plugin)."""
from __future__ import annotations

import math
from datetime import datetime, timedelta, timezone


IST = timezone(timedelta(hours=5, minutes=30))


def num(v, default=None):
    try:
        if v is None or v == "":
            return default
        return float(v)
    except (TypeError, ValueError):
        return default


def as_int(v, default, lo=None, hi=None):
    n = num(v, default)
    if n is None:
        n = default
    n = int(round(n))
    if lo is not None:
        n = max(lo, n)
    if hi is not None:
        n = min(hi, n)
    return n


def as_float(v, default, lo=None, hi=None):
    n = num(v, default)
    if n is None:
        n = default
    if lo is not None:
        n = max(lo, n)
    if hi is not None:
        n = min(hi, n)
    return n


def as_bool(v, default=True):
    if v is None:
        return bool(default)
    if isinstance(v, str):
        return v.strip().lower() not in ("0", "false", "off", "no", "")
    return bool(v)


def parse_candles(raw):
    times, opens, highs, lows, closes, volumes = [], [], [], [], [], []
    for c in raw or []:
        if not isinstance(c, dict):
            continue
        ts = c.get("timestamp", c.get("time"))
        o = num(c.get("open"))
        h = num(c.get("high"))
        l = num(c.get("low"))
        cl = num(c.get("close"))
        if ts is None or None in (o, h, l, cl):
            continue
        times.append(int(ts) if not isinstance(ts, float) else ts)
        opens.append(o)
        highs.append(h)
        lows.append(l)
        closes.append(cl)
        volumes.append(num(c.get("volume"), 0.0) or 0.0)
    return times, opens, highs, lows, closes, volumes


def _ms(ts):
    t = float(ts)
    return t if t > 1e11 else t * 1000.0


def ist_dt(ts):
    return datetime.fromtimestamp(_ms(ts) / 1000.0, tz=IST)


def ist_minutes(ts):
    d = ist_dt(ts)
    return d.hour * 60 + d.minute


def ist_day_key(ts):
    return ist_dt(ts).strftime("%Y-%m-%d")


def infer_bar_minutes(times):
    if not times or len(times) < 3:
        return 5.0
    deltas = []
    for i in range(1, min(len(times), 400)):
        d = (_ms(times[i]) - _ms(times[i - 1])) / 60000.0
        if 0.4 <= d <= 24 * 60:
            deltas.append(d)
    if not deltas:
        return 5.0
    deltas.sort()
    return float(deltas[len(deltas) // 2])


def ema(values, period):
    n = len(values)
    out = [None] * n
    period = max(1, int(period))
    if n < period:
        return out
    k = 2.0 / (period + 1.0)
    seed = sum(values[:period]) / period
    out[period - 1] = seed
    prev = seed
    for i in range(period, n):
        prev = values[i] * k + prev * (1.0 - k)
        out[i] = prev
    return out


def rma(values, period):
    n = len(values)
    out = [None] * n
    period = max(1, int(period))
    if n < period:
        return out
    seed = sum(values[:period]) / period
    out[period - 1] = seed
    alpha = 1.0 / period
    prev = seed
    for i in range(period, n):
        prev = prev + alpha * (values[i] - prev)
        out[i] = prev
    return out


def sma(values, period):
    n = len(values)
    out = [None] * n
    period = max(1, int(period))
    if n < period:
        return out
    acc = 0.0
    for i in range(n):
        acc += values[i]
        if i >= period:
            acc -= values[i - period]
        if i >= period - 1:
            out[i] = acc / period
    return out


def atr(highs, lows, closes, period):
    n = len(closes)
    tr = [0.0] * n
    if n:
        tr[0] = max(0.0, highs[0] - lows[0])
    for i in range(1, n):
        tr[i] = max(
            highs[i] - lows[i],
            abs(highs[i] - closes[i - 1]),
            abs(lows[i] - closes[i - 1]),
        )
    return rma(tr, period)


def adx(highs, lows, closes, period=14):
    n = len(closes)
    plus_dm = [0.0] * n
    minus_dm = [0.0] * n
    tr = [0.0] * n
    if n:
        tr[0] = max(0.0, highs[0] - lows[0])
    for i in range(1, n):
        up = highs[i] - highs[i - 1]
        down = lows[i - 1] - lows[i]
        plus_dm[i] = up if up > down and up > 0 else 0.0
        minus_dm[i] = down if down > up and down > 0 else 0.0
        tr[i] = max(
            highs[i] - lows[i],
            abs(highs[i] - closes[i - 1]),
            abs(lows[i] - closes[i - 1]),
        )
    atr_s = rma(tr, period)
    pdm_s = rma(plus_dm, period)
    mdm_s = rma(minus_dm, period)
    dx = [None] * n
    pdi = [None] * n
    mdi = [None] * n
    for i in range(n):
        a = atr_s[i]
        if a is None or a <= 0:
            continue
        pdi[i] = 100.0 * (pdm_s[i] or 0.0) / a
        mdi[i] = 100.0 * (mdm_s[i] or 0.0) / a
        s = pdi[i] + mdi[i]
        if s > 0:
            dx[i] = 100.0 * abs(pdi[i] - mdi[i]) / s
    adx_v = [None] * n
    dx_fill = [d if d is not None else 0.0 for d in dx]
    r = rma(dx_fill, period)
    start = 2 * period - 1
    for i in range(n):
        if i >= start and dx[i] is not None:
            adx_v[i] = r[i]
    return adx_v, pdi, mdi


def rsi(closes, period=14):
    n = len(closes)
    out = [None] * n
    period = max(1, int(period))
    if n < period + 1:
        return out
    gains = [0.0] * n
    losses = [0.0] * n
    for i in range(1, n):
        ch = closes[i] - closes[i - 1]
        gains[i] = ch if ch > 0 else 0.0
        losses[i] = -ch if ch < 0 else 0.0
    avg_g = sum(gains[1:period + 1]) / period
    avg_l = sum(losses[1:period + 1]) / period
    if avg_l <= 0:
        out[period] = 100.0
    else:
        out[period] = 100.0 - 100.0 / (1.0 + avg_g / avg_l)
    for i in range(period + 1, n):
        avg_g = (avg_g * (period - 1) + gains[i]) / period
        avg_l = (avg_l * (period - 1) + losses[i]) / period
        if avg_l <= 0:
            out[i] = 100.0
        else:
            out[i] = 100.0 - 100.0 / (1.0 + avg_g / avg_l)
    return out


def percentile_rank(values, lookback):
    n = len(values)
    out = [None] * n
    lookback = max(2, int(lookback))
    for i in range(n):
        v = values[i]
        if v is None:
            continue
        lo = max(0, i - lookback + 1)
        window = [values[j] for j in range(lo, i + 1) if values[j] is not None]
        if len(window) < max(5, lookback // 3):
            continue
        below = sum(1 for x in window if x <= v)
        out[i] = 100.0 * below / len(window)
    return out


def htf_bucket(ts, minutes):
    d = ist_dt(ts)
    total = d.hour * 60 + d.minute
    snapped = (total // minutes) * minutes
    hour, minute = divmod(snapped, 60)
    base = d.replace(hour=hour, minute=minute, second=0, microsecond=0)
    return int(base.timestamp() * 1000)


def resample_completed(times, opens, highs, lows, closes, volumes, htf_minutes):
    """Build completed higher-timeframe candles, then map last completed HTF
    index onto each execution bar (causal: never uses a still-forming HTF bar).
    """
    n = len(times)
    empty = {
        "o": [], "h": [], "l": [], "c": [], "v": [], "t": [],
        "map": [-1] * n,
    }
    if n == 0 or htf_minutes <= 0:
        return empty
    bars = []
    cur = None
    mapping = [-1] * n
    last_completed = -1

    def close_bar():
        nonlocal last_completed
        if cur is None:
            return
        bars.append({
            "t": cur["t"],
            "o": cur["o"],
            "h": cur["h"],
            "l": cur["l"],
            "c": cur["c"],
            "v": cur["v"],
        })
        last_completed = len(bars) - 1

    for i in range(n):
        b = htf_bucket(times[i], htf_minutes)
        if cur is None:
            cur = {
                "t": b, "o": opens[i], "h": highs[i], "l": lows[i],
                "c": closes[i], "v": volumes[i],
            }
        elif b != cur["t"]:
            close_bar()
            cur = {
                "t": b, "o": opens[i], "h": highs[i], "l": lows[i],
                "c": closes[i], "v": volumes[i],
            }
        else:
            cur["h"] = max(cur["h"], highs[i])
            cur["l"] = min(cur["l"], lows[i])
            cur["c"] = closes[i]
            cur["v"] += volumes[i]
        mapping[i] = last_completed

    return {
        "o": [b["o"] for b in bars],
        "h": [b["h"] for b in bars],
        "l": [b["l"] for b in bars],
        "c": [b["c"] for b in bars],
        "v": [b["v"] for b in bars],
        "t": [b["t"] for b in bars],
        "map": mapping,
    }


def align_htf(series, mapping):
    out = [None] * len(mapping)
    for i, j in enumerate(mapping):
        if j is not None and j >= 0 and j < len(series):
            out[i] = series[j]
    return out


def finite(v):
    try:
        if v is None:
            return False
        return math.isfinite(float(v))
    except (TypeError, ValueError):
        return False
