"""4-level cascade smoothing (Savitzky–Golay, Gaussian, Kernel Poly).

Causal (left-sided) filters: each bar uses only that bar and earlier bars,
so a drawn point never moves when a later / current candle updates.
"""
from __future__ import annotations

import math

import numpy as np

FACTORY_LEVELS = [
    {
        "enabled": True,
        "input": "price",
        "model": "savgol",
        "window": 11,
        "polyorder": 3,
        "bandwidth": 3.0,
        "degree": 2,
        "color": "#58a6ff",
        "thickness": 1,
        "markers": False,
        "marker_color": "#58a6ff",
    },
    {
        "enabled": True,
        "input": "ce1",
        "model": "gaussian",
        "window": 11,
        "polyorder": 3,
        "bandwidth": 3.0,
        "degree": 2,
        "color": "#f0883e",
        "thickness": 1,
        "markers": False,
        "marker_color": "#f0883e",
    },
    {
        "enabled": True,
        "input": "ce2",
        "model": "kernel_poly",
        "window": 11,
        "polyorder": 3,
        "bandwidth": 8.0,
        "degree": 2,
        "color": "#3fb950",
        "thickness": 1,
        "markers": False,
        "marker_color": "#3fb950",
    },
    {
        "enabled": True,
        "input": "ce3",
        "model": "gaussian",
        "window": 11,
        "polyorder": 3,
        "bandwidth": 6.0,
        "degree": 2,
        "color": "#d2a8ff",
        "thickness": 1,
        "markers": False,
        "marker_color": "#d2a8ff",
    },
]

FACTORY = {"levels": [dict(row) for row in FACTORY_LEVELS]}

META = {
    "id": "smoothing",
    "name": "Smoothing",
    "overlay": True,
    "draw": "lines",
    "ui": "smoothing",
    "factory": FACTORY,
    "params": [],
}

_MODEL_ALIASES = {
    "none": "none",
    "savitzky-golay": "savgol",
    "savgol": "savgol",
    "gaussian kernel": "gaussian",
    "gaussian": "gaussian",
    "kernel poly": "kernel_poly",
    "kernel_poly": "kernel_poly",
}

_INPUT_ALIASES = {
    "price": "price",
    "close": "price",
    "ac_ce1": "ce1",
    "ce1": "ce1",
    "ac_ce2": "ce2",
    "ce2": "ce2",
    "ac_ce3": "ce3",
    "ce3": "ce3",
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
    times, closes = [], []
    for c in raw or []:
        if not isinstance(c, dict):
            continue
        ts = c.get("timestamp", c.get("time"))
        cl = _num(c.get("close"))
        if ts is None or cl is None:
            continue
        times.append(int(ts) if not isinstance(ts, float) else ts)
        closes.append(cl)
    return times, np.asarray(closes, dtype=float)


def _causal_polyfit_edge(y_win, polyorder):
    m = int(y_win.size)
    if m <= 0:
        return float("nan")
    deg = min(int(polyorder), m - 1)
    if deg < 1:
        return float(y_win[-1])
    xx = np.arange(m, dtype=float)
    coef = np.polyfit(xx, y_win, deg)
    return float(np.polyval(coef, xx[-1]))


def savgol_smooth(y, window, polyorder):
    """Trailing-window Savitzky–Golay: value at i uses y[i-window+1 : i+1] only."""
    y = np.asarray(y, dtype=float)
    n = y.size
    window = int(window)
    polyorder = int(polyorder)
    if window < 3:
        window = 3
    if polyorder < 1:
        polyorder = 1
    if polyorder >= window:
        polyorder = window - 1
    if n == 0:
        return y.copy()
    x = np.arange(window, dtype=float)
    xt = np.array([float(window - 1) ** k for k in range(polyorder + 1)], dtype=float)
    filt = xt @ np.linalg.pinv(np.vander(x, N=polyorder + 1, increasing=True))
    out = np.empty(n, dtype=float)
    if n >= window:
        out[window - 1 :] = np.convolve(y, filt[::-1], mode="valid")
    for i in range(min(window - 1, n)):
        out[i] = _causal_polyfit_edge(y[: i + 1], polyorder)
    return out


def gaussian_smooth(y, bandwidth):
    """One-sided Gaussian: value at i uses y[0 : i+1] (lag kernel), never future bars."""
    y = np.asarray(y, dtype=float)
    n = y.size
    if n == 0:
        return y.copy()
    bw = max(float(bandwidth), 1e-6)
    radius = max(1, min(int(math.ceil(4.0 * bw)), 80, max(1, n - 1)))
    b = np.exp(-0.5 * (np.arange(radius + 1, dtype=float) / bw) ** 2)
    num = np.convolve(y, b, mode="full")[:n]
    den = np.convolve(np.ones(n, dtype=float), b, mode="full")[:n]
    den = np.where(den > 0.0, den, 1.0)
    return num / den


def _causal_poly_kernel(radius, degree, bw):
    x = -np.arange(radius + 1, dtype=float)
    w = np.exp(-0.5 * (x / bw) ** 2)
    deg = max(1, min(int(degree), radius))
    xmat = np.vander(x, N=deg + 1, increasing=True)
    xtw = xmat.T * w
    try:
        return np.linalg.solve(xtw @ xmat, xtw)[0]
    except np.linalg.LinAlgError:
        s = float(w.sum()) or 1.0
        return w / s


def kernel_poly_smooth(y, degree, bandwidth):
    """Causal local polynomial: fit on past lags only, evaluate at the current bar."""
    y = np.asarray(y, dtype=float)
    n = y.size
    if n == 0:
        return y.copy()
    deg = max(1, int(degree))
    bw = max(float(bandwidth), 1e-6)
    radius = max(deg + 1, min(int(math.ceil(4.0 * bw)), 80, max(1, n - 1)))
    filt = _causal_poly_kernel(radius, deg, bw)
    out = np.convolve(y, filt, mode="full")[:n]
    for i in range(min(radius, n)):
        lo, hi = 0, i + 1
        if hi - lo <= deg:
            out[i] = y[i]
            continue
        xx = np.arange(lo, hi, dtype=float) - i
        w = np.exp(-0.5 * (xx / bw) ** 2)
        yy = y[lo:hi]
        d = min(deg, hi - lo - 1)
        xmat = np.vander(xx, N=d + 1, increasing=True)
        xtw = xmat.T * w
        try:
            beta = np.linalg.solve(xtw @ xmat, xtw @ yy)
            out[i] = float(beta[0])
        except np.linalg.LinAlgError:
            s = float(w.sum())
            out[i] = float(np.dot(w, yy) / s) if s else float(y[i])
    return out


def apply_model(y, model, cfg):
    model = _MODEL_ALIASES.get(str(model or "").strip().lower(), "none")
    if model == "savgol":
        return savgol_smooth(y, cfg.get("window", 11), cfg.get("polyorder", 3))
    if model == "gaussian":
        return gaussian_smooth(y, cfg.get("bandwidth", 3.0))
    if model == "kernel_poly":
        return kernel_poly_smooth(y, cfg.get("degree", 2), cfg.get("bandwidth", 8.0))
    return np.asarray(y, dtype=float).copy()


def _merge_levels(params):
    raw = []
    if isinstance(params, dict):
        raw = params.get("levels") or []
    if not isinstance(raw, list):
        raw = []
    out = []
    for i in range(4):
        row = dict(FACTORY_LEVELS[i])
        if i < len(raw) and isinstance(raw[i], dict):
            for k, v in raw[i].items():
                row[k] = v
        row["enabled"] = _bool(row.get("enabled"), True)
        row["markers"] = _bool(row.get("markers"), False)
        row["window"] = _int(row.get("window"), 11, 3, 501)
        row["polyorder"] = _int(row.get("polyorder"), 3, 1, 15)
        row["bandwidth"] = _float(row.get("bandwidth"), 3.0, 0.1, 500)
        row["degree"] = _int(row.get("degree"), 2, 1, 8)
        row["thickness"] = _int(row.get("thickness"), 1, 1, 10)
        inp = _INPUT_ALIASES.get(str(row.get("input") or "").strip().lower(), None)
        allowed = ["price"] + [f"ce{j}" for j in range(1, i + 1)]
        row["input"] = inp if inp in allowed else allowed[-1]
        model = _MODEL_ALIASES.get(str(row.get("model") or "").strip().lower(), "savgol")
        row["model"] = model
        out.append(row)
    return out


def _to_json_nums(arr, plot):
    if not plot:
        return [None] * len(arr)
    out = []
    for v in arr:
        if v is None or (isinstance(v, float) and (math.isnan(v) or math.isinf(v))):
            out.append(None)
        else:
            out.append(float(v))
    return out


def compute(candles, params=None):
    times, price = _parse_candles(candles)
    n = int(price.size)
    empty = {
        "series": {"ce1": [], "ce2": [], "ce3": [], "ce4": []},
        "times": [],
        "plot": [False, False, False, False],
        "stats": {},
    }
    if n < 3:
        return empty

    levels = _merge_levels(params)
    data = {"price": price}
    plot = []
    series = {}
    for i, cfg in enumerate(levels):
        key = f"ce{i + 1}"
        src_key = cfg["input"]
        src = data.get(src_key, price)
        if not cfg["enabled"]:
            data[key] = np.asarray(src, dtype=float).copy()
            series[key] = _to_json_nums(data[key], False)
            plot.append(False)
            continue
        data[key] = apply_model(src, cfg["model"], cfg)
        series[key] = _to_json_nums(data[key], True)
        plot.append(True)

    return {
        "series": series,
        "times": times,
        "plot": plot,
        "stats": {
            "ce1": plot[0],
            "ce2": plot[1],
            "ce3": plot[2],
            "ce4": plot[3],
        },
    }
