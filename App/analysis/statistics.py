"""
Core statistical primitives for the Correlation Density screener.

All functions are pure, numpy-based and unit-testable. No I/O here.
"""
import math
from typing import Optional, Tuple

import numpy as np

__all__ = [
    "rolling_mean", "rolling_std", "normal_cdf", "pearson",
    "rolling_correlation_last", "rolling_correlation", "zscore", "align_series",
]


def align_series(t1, v1, t2, v2):
    # type: (np.ndarray, np.ndarray, np.ndarray, np.ndarray) -> Tuple[np.ndarray, np.ndarray, np.ndarray]
    """Intersect two (timestamp, value) series on common timestamps.

    Returns (common_times, values1, values2) sorted ascending.
    NaN values in either series drop the row from both.
    """
    common, i1, i2 = np.intersect1d(t1, t2, assume_unique=False, return_indices=True)
    a = np.asarray(v1, dtype=np.float64)[i1]
    b = np.asarray(v2, dtype=np.float64)[i2]
    mask = np.isfinite(a) & np.isfinite(b)
    return common[mask], a[mask], b[mask]


def rolling_mean(values, window):
    # type: (np.ndarray, int) -> np.ndarray
    """Simple rolling mean; positions < window-1 are NaN."""
    values = np.asarray(values, dtype=np.float64)
    n = values.size
    out = np.full(n, np.nan)
    if window <= 0 or n < window:
        return out
    csum = np.cumsum(np.insert(values, 0, 0.0))
    out[window - 1:] = (csum[window:] - csum[:-window]) / window
    return out


def rolling_std(values, window, ddof=1):
    # type: (np.ndarray, int, int) -> np.ndarray
    """Rolling sample standard deviation; positions < window-1 are NaN.

    Uses the two-pass cumulative-sum identity; numerically fine for
    price-ratio magnitudes handled here.
    """
    values = np.asarray(values, dtype=np.float64)
    n = values.size
    out = np.full(n, np.nan)
    if window <= 1 or n < window:
        return out
    csum = np.cumsum(np.insert(values, 0, 0.0))
    csum2 = np.cumsum(np.insert(values * values, 0, 0.0))
    s1 = csum[window:] - csum[:-window]
    s2 = csum2[window:] - csum2[:-window]
    var = (s2 - s1 * s1 / window) / (window - ddof)
    var = np.maximum(var, 0.0)
    out[window - 1:] = np.sqrt(var)
    return out


def normal_cdf(x, mean=0.0, std=1.0):
    # type: (float, float, float) -> float
    """Normal CDF — same semantics as Excel NORM.DIST(x, mean, std, TRUE)."""
    if std <= 0 or not math.isfinite(std):
        return float("nan")
    return 0.5 * (1.0 + math.erf((x - mean) / (std * math.sqrt(2.0))))


def pearson(a, b):
    # type: (np.ndarray, np.ndarray) -> float
    """Pearson correlation of two equal-length arrays; NaN-safe."""
    a = np.asarray(a, dtype=np.float64)
    b = np.asarray(b, dtype=np.float64)
    mask = np.isfinite(a) & np.isfinite(b)
    a, b = a[mask], b[mask]
    if a.size < 3:
        return float("nan")
    sa, sb = a.std(), b.std()
    if sa == 0 or sb == 0:
        return float("nan")
    return float(np.corrcoef(a, b)[0, 1])


def rolling_correlation_last(a, b, window):
    # type: (np.ndarray, np.ndarray, int) -> float
    """Pearson correlation over the trailing `window` bars (the most recent value
    of a rolling correlation series)."""
    a = np.asarray(a, dtype=np.float64)
    b = np.asarray(b, dtype=np.float64)
    if a.size < window or window < 3:
        return float("nan")
    return pearson(a[-window:], b[-window:])


def rolling_correlation(a, b, window):
    # type: (np.ndarray, np.ndarray, int) -> np.ndarray
    """Full rolling Pearson correlation series; positions < window-1 are NaN.

    Cumulative-sum implementation: O(n) regardless of window size.
    """
    a = np.asarray(a, dtype=np.float64)
    b = np.asarray(b, dtype=np.float64)
    n = a.size
    out = np.full(n, np.nan)
    if window < 3 or n < window:
        return out
    ca  = np.cumsum(np.insert(a, 0, 0.0))
    cb  = np.cumsum(np.insert(b, 0, 0.0))
    cab = np.cumsum(np.insert(a * b, 0, 0.0))
    ca2 = np.cumsum(np.insert(a * a, 0, 0.0))
    cb2 = np.cumsum(np.insert(b * b, 0, 0.0))
    sa  = ca[window:]  - ca[:-window]
    sb  = cb[window:]  - cb[:-window]
    sab = cab[window:] - cab[:-window]
    sa2 = ca2[window:] - ca2[:-window]
    sb2 = cb2[window:] - cb2[:-window]
    cov = sab - sa * sb / window
    va  = sa2 - sa * sa / window
    vb  = sb2 - sb * sb / window
    denom = np.sqrt(np.maximum(va, 0.0) * np.maximum(vb, 0.0))
    with np.errstate(invalid="ignore", divide="ignore"):
        vals = np.where(denom > 0, cov / denom, np.nan)
    out[window - 1:] = np.clip(vals, -1.0, 1.0)
    return out


def zscore(current, mean, std):
    # type: (float, float, float) -> float
    """(current - mean) / std with divide-by-zero safety."""
    if std is None or std <= 0 or not math.isfinite(std):
        return float("nan")
    return (current - mean) / std
