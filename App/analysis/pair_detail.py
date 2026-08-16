"""
Pair Detail — full time-series payload for the pair dashboard page.

Builds on compute_pair (headline stats) and adds the series the six
dashboard panels need: normalized prices, ratio with SD bands, density
distribution curve, rolling correlation, z-score, and entry/exit signals.
"""
import logging
import math
from typing import Dict, List, Optional

import numpy as np

from analysis.statistics import (
    align_series, rolling_mean, rolling_std, normal_cdf, rolling_correlation,
)
from analysis.correlation_density import ScanParams, compute_pair

logger = logging.getLogger(__name__)

__all__ = ["compute_pair_detail"]


def _series(values):
    # type: (np.ndarray) -> List[Optional[float]]
    """ndarray -> JSON-safe list (NaN/inf -> None)."""
    out = []
    for v in np.asarray(values, dtype=np.float64):
        out.append(round(float(v), 6) if math.isfinite(v) else None)
    return out


def _signal_markers(z, entry=2.0, exit_band=0.05):
    # type: (np.ndarray, float, float) -> Dict[str, List[int]]
    """Indices of entry/exit events on the z-score series.

    Entry: |z| crosses beyond `entry` (from inside). Exit: z crosses zero
    (sign change or |z| <= exit_band) while a position is open.
    """
    entries, exits = [], []
    in_pos = False
    prev = None
    for i, v in enumerate(z):
        if v is None or not math.isfinite(v):
            continue
        if prev is not None:
            if not in_pos and abs(prev) < entry and abs(v) >= entry:
                entries.append(i)
                in_pos = True
            elif in_pos and (prev * v < 0 or abs(v) <= exit_band):
                exits.append(i)
                in_pos = False
        prev = v
    return {"entries": entries, "exits": exits}


def _strength_breakdown(summary, params):
    # type: (dict, ScanParams) -> List[dict]
    """Per-factor breakdown mirroring _signal_strength weights in
    correlation_density.py — keep the two in sync."""
    w = int(params.rolling_window)
    density = summary.get("density")
    if density is not None:
        if density <= params.lower_density or density >= params.upper_density:
            dens_score = 1.0
        else:
            mid = 0.5
            dens_score = max(0.0, min(1.0, abs(density - mid) / (mid - params.lower_density)))
    else:
        dens_score = 0.0
    rc = summary.get("rolling_correlation")
    rc_score = max(0.0, min(1.0, rc)) if rc is not None else 0.5
    cp = summary.get("coint_pvalue")
    cp_score = max(0.0, min(1.0, 1.0 - cp / 0.10)) if cp is not None else 0.5
    hl = summary.get("half_life")
    hl_score = max(0.0, min(1.0, 1.0 - hl / float(w))) if hl and hl > 0 else 0.0
    hu = summary.get("hurst")
    hu_score = max(0.0, min(1.0, (0.5 - hu) / 0.5)) if hu is not None else 0.5
    wp = summary.get("historical_win_pct")
    wp_score = wp / 100.0 if wp is not None else 0.5
    factors = [
        ("Density Extremity",    dens_score, 0.25),
        ("Rolling Correlation",  rc_score,   0.20),
        ("Cointegration",        cp_score,   0.20),
        ("Half Life (Speed)",    hl_score,   0.15),
        ("Hurst (Mean Reversion)", hu_score, 0.10),
        ("Historical Win Rate",  wp_score,   0.10),
    ]
    return [{"factor": n, "score": round(sc, 2), "weight": int(wt * 100),
             "contribution": round(sc * wt * 100, 1)} for n, sc, wt in factors]


def compute_pair_detail(sector, sym1, sym2, series1, series2, params):
    # type: (str, str, str, dict, dict, ScanParams) -> dict
    """Full dashboard payload for one pair. Raises ValueError on bad data."""
    summary = compute_pair(sector, sym1, sym2, series1, series2, params)
    if summary.skipped_reason:
        raise ValueError(summary.skipped_reason)

    t, c1, c2 = align_series(series1["time"], series1["close"],
                             series2["time"], series2["close"])
    nz = c2 != 0
    t, c1, c2 = t[nz], c1[nz], c2[nz]
    w = int(params.rolling_window)

    ratio = c1 / c2
    mean_r = rolling_mean(ratio, w)
    std_r = rolling_std(ratio, w)
    with np.errstate(invalid="ignore", divide="ignore"):
        z = np.where(std_r > 0, (ratio - mean_r) / std_r, np.nan)

    # Normalized prices (base 100 at first common bar)
    norm1 = c1 / c1[0] * 100.0
    norm2 = c2 / c2[0] * 100.0

    roll_corr = rolling_correlation(c1, c2, w)

    # Density distribution curve around the latest rolling mean/std
    m, s = float(mean_r[-1]), float(std_r[-1])
    dist = {}
    if math.isfinite(m) and math.isfinite(s) and s > 0:
        xs = np.linspace(m - 4 * s, m + 4 * s, 121)
        pdf = np.exp(-0.5 * ((xs - m) / s) ** 2) / (s * math.sqrt(2 * math.pi))
        dist = {
            "x": _series(xs),
            "pdf": _series(pdf),
            "mean": round(m, 6),
            "std": round(s, 6),
            "lower_cut": round(m + s * _norm_ppf(params.lower_density), 6),
            "upper_cut": round(m + s * _norm_ppf(params.upper_density), 6),
            "current": round(float(ratio[-1]), 6),
        }

    bands = {}
    if math.isfinite(m) and math.isfinite(s):
        bands = {"mean": round(m, 6),
                 "p1sd": round(m + s, 6), "m1sd": round(m - s, 6),
                 "p2sd": round(m + 2 * s, 6), "m2sd": round(m - 2 * s, 6)}

    z_list = _series(z)
    return {
        "summary": summary.to_dict(),
        "breakdown": _strength_breakdown(summary.to_dict(), params),
        "time": [int(x) for x in t],
        "norm1": _series(norm1),
        "norm2": _series(norm2),
        "close1": _series(c1),
        "close2": _series(c2),
        "ratio": _series(ratio),
        "ratio_mean": _series(mean_r),
        "ratio_std": _series(std_r),
        "bands": bands,
        "distribution": dist,
        "rolling_corr": _series(roll_corr),
        "zscore": z_list,
        "signals": _signal_markers(z_list),
    }


def _norm_ppf(p):
    # type: (float) -> float
    """Inverse normal CDF (Acklam's rational approximation, |err| < 1.2e-9)."""
    if p <= 0.0:
        return -8.0
    if p >= 1.0:
        return 8.0
    a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02,
         1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00]
    b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02,
         6.680131188771972e+01, -1.328068155288572e+01]
    c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00,
         -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00]
    d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00,
         3.754408661907416e+00]
    plow, phigh = 0.02425, 1 - 0.02425
    if p < plow:
        q = math.sqrt(-2 * math.log(p))
        return (((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) / \
               ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1)
    if p > phigh:
        q = math.sqrt(-2 * math.log(1 - p))
        return -(((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) / \
                ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1)
    q = p - 0.5
    r = q * q
    return (((((a[0]*r+a[1])*r+a[2])*r+a[3])*r+a[4])*r+a[5])*q / \
           (((((b[0]*r+b[1])*r+b[2])*r+b[3])*r+b[4])*r+1)
