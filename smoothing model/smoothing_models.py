"""4-level causal cascade smoothing.

Models:
    - Causal trailing Savitzky-Golay
    - One-sided causal Gaussian
    - Causal local polynomial kernel

Important:
    Every output at bar i uses only data from bars <= i.
    No centered/future-looking filters are used.

For a closed candle n:
    CE[n] is invariant to all subsequent candles n+1, n+2, ...
"""

from __future__ import annotations

import math
from typing import Any, Dict, List, Tuple

import numpy as np


# ---------------------------------------------------------------------------
# Factory configuration
# ---------------------------------------------------------------------------

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

FACTORY = {
    "levels": [dict(row) for row in FACTORY_LEVELS]
}

META = {
    "id": "smoothing",
    "name": "Smoothing",
    "overlay": True,
    "draw": "lines",
    "ui": "smoothing",
    "factory": FACTORY,
    "params": [],
}


# ---------------------------------------------------------------------------
# Aliases
# ---------------------------------------------------------------------------

_MODEL_ALIASES = {
    "none": "none",
    "savgol": "savgol",
    "savitzky-golay": "savgol",
    "gaussian": "gaussian",
    "gaussian kernel": "gaussian",
    "kernel_poly": "kernel_poly",
    "kernel poly": "kernel_poly",
}

_INPUT_ALIASES = {
    "price": "price",
    "close": "price",
    "ce1": "ce1",
    "ac_ce1": "ce1",
    "ce2": "ce2",
    "ac_ce2": "ce2",
    "ce3": "ce3",
    "ac_ce3": "ce3",
}


# ---------------------------------------------------------------------------
# Numeric helpers
# ---------------------------------------------------------------------------

def _num(v: Any, default=None):
    try:
        if v is None or v == "":
            return default

        x = float(v)

        if not math.isfinite(x):
            return default

        return x

    except (TypeError, ValueError):
        return default


def _int(v: Any, default: int, lo=None, hi=None) -> int:
    n = _num(v, default)

    if n is None:
        n = default

    n = int(round(n))

    if lo is not None:
        n = max(lo, n)

    if hi is not None:
        n = min(hi, n)

    return n


def _float(v: Any, default: float, lo=None, hi=None) -> float:
    n = _num(v, default)

    if n is None:
        n = default

    if lo is not None:
        n = max(lo, n)

    if hi is not None:
        n = min(hi, n)

    return float(n)


def _bool(v: Any, default=True) -> bool:
    if v is None:
        return bool(default)

    if isinstance(v, str):
        return v.strip().lower() not in (
            "0",
            "false",
            "off",
            "no",
            "",
        )

    return bool(v)


# ---------------------------------------------------------------------------
# Candle parsing
# ---------------------------------------------------------------------------

def _parse_candles(raw):
    times = []
    closes = []

    for c in raw or []:
        if not isinstance(c, dict):
            continue

        ts = c.get("timestamp", c.get("time"))
        cl = _num(c.get("close"))

        if ts is None or cl is None:
            continue

        try:
            if isinstance(ts, float):
                times.append(ts)
            else:
                times.append(int(ts))
        except (TypeError, ValueError):
            continue

        closes.append(cl)

    return times, np.asarray(closes, dtype=float)


# ---------------------------------------------------------------------------
# Causal Savitzky-Golay
# ---------------------------------------------------------------------------

def _causal_savgol_coefficients(window: int, polyorder: int):
    """
    Calculate trailing Savitzky-Golay weights.

    Coordinates:

        -window+1 ... -2 -1 0

    The fitted polynomial is evaluated at x=0,
    which represents the CURRENT bar.

    Therefore no future samples are required.
    """

    window = int(window)
    polyorder = int(polyorder)

    if window < 3:
        window = 3

    if polyorder < 1:
        polyorder = 1

    polyorder = min(polyorder, window - 1)

    # Current bar is x=0.
    # Older bars are negative.
    x = -np.arange(window - 1, -1, -1, dtype=float)

    # Scale x to [-1, 0] for much better numerical conditioning.
    scale = max(float(window - 1), 1.0)
    z = x / scale

    X = np.vander(
        z,
        N=polyorder + 1,
        increasing=True,
    )

    # We want beta[0], the fitted value at z=0.
    try:
        xtx = X.T @ X
        weights = np.linalg.solve(
            xtx,
            X.T,
        )[0]

    except np.linalg.LinAlgError:
        weights = np.linalg.pinv(X)[0]

    return np.asarray(weights, dtype=float)


def _causal_polyfit_value(
    y_window: np.ndarray,
    polyorder: int,
) -> float:
    """
    Causal polynomial fit evaluated at the LAST sample.

    Used for startup bars where a complete trailing window
    is not yet available.
    """

    m = int(y_window.size)

    if m <= 0:
        return float("nan")

    if m == 1:
        return float(y_window[-1])

    deg = min(
        int(polyorder),
        m - 1,
    )

    if deg <= 0:
        return float(y_window[-1])

    # Current sample = 0.
    # Previous samples are negative.
    x = -np.arange(
        m - 1,
        -1,
        -1,
        dtype=float,
    )

    scale = max(float(m - 1), 1.0)
    z = x / scale

    X = np.vander(
        z,
        N=deg + 1,
        increasing=True,
    )

    try:
        beta = np.linalg.lstsq(
            X,
            y_window,
            rcond=None,
        )[0]

        return float(beta[0])

    except np.linalg.LinAlgError:
        return float(y_window[-1])


def savgol_smooth(
    y,
    window=11,
    polyorder=3,
):
    """
    Trailing causal Savitzky-Golay.

    For bar i:

        output[i] = f(y[i-window+1 : i+1])

    No future values are used.
    """

    y = np.asarray(y, dtype=float)

    n = y.size

    if n == 0:
        return y.copy()

    window = _int(
        window,
        11,
        lo=3,
        hi=501,
    )

    polyorder = _int(
        polyorder,
        3,
        lo=1,
        hi=15,
    )

    polyorder = min(
        polyorder,
        window - 1,
    )

    out = np.empty(
        n,
        dtype=float,
    )

    # Complete-window filter.
    if n >= window:

        weights = _causal_savgol_coefficients(
            window,
            polyorder,
        )

        # np.convolve reverses the second argument,
        # so reverse the causal weights here.
        out[window - 1:] = np.convolve(
            y,
            weights[::-1],
            mode="valid",
        )

    # Startup region.
    startup_count = min(
        window - 1,
        n,
    )

    for i in range(startup_count):

        out[i] = _causal_polyfit_value(
            y[: i + 1],
            polyorder,
        )

    return out


# ---------------------------------------------------------------------------
# Causal Gaussian
# ---------------------------------------------------------------------------

def _gaussian_kernel(
    radius: int,
    bandwidth: float,
):
    lags = np.arange(
        radius + 1,
        dtype=float,
    )

    return np.exp(
        -0.5 * (lags / bandwidth) ** 2
    )


def gaussian_smooth(
    y,
    bandwidth=3.0,
):
    """
    One-sided causal Gaussian smoothing.

    For bar i:

        output[i] =
            weighted average of
            y[i], y[i-1], ..., y[i-radius]

    No future samples are used.
    """

    y = np.asarray(y, dtype=float)

    n = y.size

    if n == 0:
        return y.copy()

    bandwidth = _float(
        bandwidth,
        3.0,
        lo=0.1,
        hi=500.0,
    )

    radius = min(
        int(math.ceil(4.0 * bandwidth)),
        80,
        max(1, n - 1),
    )

    radius = max(
        1,
        radius,
    )

    # b[0] = current-bar weight
    # b[1] = one-bar-back weight
    # ...
    b = _gaussian_kernel(
        radius,
        bandwidth,
    )

    # Causal convolution.
    numerator = np.convolve(
        y,
        b,
        mode="full",
    )[:n]

    # Number/weight normalization at startup.
    denominator = np.convolve(
        np.ones(n, dtype=float),
        b,
        mode="full",
    )[:n]

    denominator = np.maximum(
        denominator,
        np.finfo(float).eps,
    )

    return numerator / denominator


# ---------------------------------------------------------------------------
# Causal local polynomial kernel
# ---------------------------------------------------------------------------

def _causal_poly_kernel(
    radius: int,
    degree: int,
    bandwidth: float,
):
    """
    Calculate causal local-polynomial weights.

    Coordinates:

        0, -1, -2, ..., -radius

    The regression is evaluated at x=0,
    i.e. the current bar.
    """

    radius = max(
        1,
        int(radius),
    )

    degree = max(
        1,
        min(int(degree), radius),
    )

    bandwidth = max(
        float(bandwidth),
        1e-6,
    )

    # Current bar = 0.
    # Older observations = negative lags.
    lags = -np.arange(
        radius + 1,
        dtype=float,
    )

    # Scale the polynomial coordinate.
    #
    # This does NOT change the fitted value at x=0,
    # but substantially improves numerical conditioning.
    z = lags / bandwidth

    weights = np.exp(
        -0.5 * z ** 2
    )

    X = np.vander(
        z,
        N=degree + 1,
        increasing=True,
    )

    XTW = X.T * weights

    try:
        beta_operator = np.linalg.solve(
            XTW @ X,
            XTW,
        )

        # First row estimates beta[0].
        return np.asarray(
            beta_operator[0],
            dtype=float,
        )

    except np.linalg.LinAlgError:

        # Safe fallback to weighted average.
        s = float(weights.sum())

        if s <= 0.0:
            result = np.zeros(
                radius + 1,
                dtype=float,
            )
            result[0] = 1.0
            return result

        return weights / s


def _causal_poly_startup_value(
    y,
    end_index,
    degree,
    bandwidth,
):
    """
    Local polynomial regression for a startup bar.

    Only samples 0..end_index are allowed.
    """

    if end_index < 0:
        return float("nan")

    yy = np.asarray(
        y[: end_index + 1],
        dtype=float,
    )

    m = yy.size

    if m <= 1:
        return float(yy[-1])

    degree = min(
        int(degree),
        m - 1,
    )

    if degree <= 0:
        return float(yy[-1])

    # Current bar = 0.
    lags = -np.arange(
        m - 1,
        -1,
        -1,
        dtype=float,
    )

    bandwidth = max(
        float(bandwidth),
        1e-6,
    )

    z = lags / bandwidth

    weights = np.exp(
        -0.5 * z ** 2
    )

    X = np.vander(
        z,
        N=degree + 1,
        increasing=True,
    )

    XTW = X.T * weights

    try:
        beta = np.linalg.solve(
            XTW @ X,
            XTW @ yy,
        )

        return float(beta[0])

    except np.linalg.LinAlgError:

        s = float(weights.sum())

        if s <= 0.0:
            return float(yy[-1])

        return float(
            np.dot(weights, yy) / s
        )


def kernel_poly_smooth(
    y,
    degree=2,
    bandwidth=8.0,
):
    """
    Causal local polynomial kernel smoother.

    Every output[i] uses only:

        y[0], ..., y[i]

    No future samples are accessed.
    """

    y = np.asarray(
        y,
        dtype=float,
    )

    n = y.size

    if n == 0:
        return y.copy()

    degree = _int(
        degree,
        2,
        lo=1,
        hi=8,
    )

    bandwidth = _float(
        bandwidth,
        8.0,
        lo=0.1,
        hi=500.0,
    )

    radius = min(
        int(math.ceil(4.0 * bandwidth)),
        80,
        max(1, n - 1),
    )

    radius = max(
        degree + 1,
        radius,
    )

    # Full-window causal filter.
    weights = _causal_poly_kernel(
        radius,
        degree,
        bandwidth,
    )

    out = np.empty(
        n,
        dtype=float,
    )

    if n > radius:

        out[radius:] = np.convolve(
            y,
            weights[::-1],
            mode="valid",
        )

    # Startup region.
    startup_count = min(
        radius,
        n,
    )

    for i in range(startup_count):

        out[i] = _causal_poly_startup_value(
            y,
            i,
            degree,
            bandwidth,
        )

    return out


# ---------------------------------------------------------------------------
# Model dispatcher
# ---------------------------------------------------------------------------

def apply_model(
    y,
    model,
    cfg,
):
    model = _MODEL_ALIASES.get(
        str(model or "")
        .strip()
        .lower(),
        "none",
    )

    if model == "savgol":
        return savgol_smooth(
            y,
            cfg.get("window", 11),
            cfg.get("polyorder", 3),
        )

    if model == "gaussian":
        return gaussian_smooth(
            y,
            cfg.get("bandwidth", 3.0),
        )

    if model == "kernel_poly":
        return kernel_poly_smooth(
            y,
            cfg.get("degree", 2),
            cfg.get("bandwidth", 8.0),
        )

    return np.asarray(
        y,
        dtype=float,
    ).copy()


# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

def _merge_levels(params):
    raw = []

    if isinstance(params, dict):
        raw = params.get("levels") or []

    if not isinstance(raw, list):
        raw = []

    levels = []

    for i in range(4):

        row = dict(
            FACTORY_LEVELS[i]
        )

        if (
            i < len(raw)
            and isinstance(raw[i], dict)
        ):
            row.update(raw[i])

        row["enabled"] = _bool(
            row.get("enabled"),
            True,
        )

        row["markers"] = _bool(
            row.get("markers"),
            False,
        )

        row["window"] = _int(
            row.get("window"),
            11,
            3,
            501,
        )

        row["polyorder"] = _int(
            row.get("polyorder"),
            3,
            1,
            15,
        )

        row["bandwidth"] = _float(
            row.get("bandwidth"),
            3.0,
            0.1,
            500.0,
        )

        row["degree"] = _int(
            row.get("degree"),
            2,
            1,
            8,
        )

        row["thickness"] = _int(
            row.get("thickness"),
            1,
            1,
            10,
        )

        inp = _INPUT_ALIASES.get(
            str(row.get("input") or "")
            .strip()
            .lower()
        )

        allowed = [
            "price"
        ] + [
            f"ce{j}"
            for j in range(1, i + 1)
        ]

        row["input"] = (
            inp
            if inp in allowed
            else allowed[-1]
        )

        model = _MODEL_ALIASES.get(
            str(row.get("model") or "")
            .strip()
            .lower(),
            "savgol",
        )

        row["model"] = model

        levels.append(row)

    return levels


# ---------------------------------------------------------------------------
# JSON conversion
# ---------------------------------------------------------------------------

def _to_json_nums(
    arr,
    plot,
):
    if not plot:
        return [None] * len(arr)

    out = []

    for v in arr:

        try:
            x = float(v)

            if not math.isfinite(x):
                out.append(None)
            else:
                out.append(x)

        except (TypeError, ValueError):
            out.append(None)

    return out


# ---------------------------------------------------------------------------
# Main calculation
# ---------------------------------------------------------------------------

def compute(
    candles,
    params=None,
):
    times, price = _parse_candles(
        candles
    )

    n = int(
        price.size
    )

    empty = {
        "series": {
            "ce1": [],
            "ce2": [],
            "ce3": [],
            "ce4": [],
        },
        "times": [],
        "plot": [
            False,
            False,
            False,
            False,
        ],
        "stats": {},
    }

    if n < 3:
        return empty

    levels = _merge_levels(
        params
    )

    data = {
        "price": price
    }

    plot = []
    series = {}

    for i, cfg in enumerate(levels):

        key = f"ce{i + 1}"

        src_key = cfg["input"]

        src = data.get(
            src_key,
            price,
        )

        # Disabled level acts as a transparent/pass-through level.
        if not cfg["enabled"]:

            data[key] = np.asarray(
                src,
                dtype=float,
            ).copy()

            series[key] = _to_json_nums(
                data[key],
                False,
            )

            plot.append(False)

            continue

        result = apply_model(
            src,
            cfg["model"],
            cfg,
        )

        # Safety check.
        result = np.asarray(
            result,
            dtype=float,
        )

        if result.size != n:
            raise ValueError(
                f"{key}: model returned "
                f"{result.size} values; "
                f"expected {n}"
            )

        data[key] = result

        series[key] = _to_json_nums(
            result,
            True,
        )

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