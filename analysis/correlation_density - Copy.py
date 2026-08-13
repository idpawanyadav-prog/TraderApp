"""
Correlation Density Curve — pair metric computation and signal scoring.

This module is pure computation: it takes aligned close-price arrays and
produces a PairResult. Data fetching, threading and HTTP live elsewhere
(services/market_data.py and the Flask routes).
"""
import logging
import math
from dataclasses import dataclass, field, asdict
from datetime import datetime
from typing import List, Optional

import numpy as np

from analysis.statistics import (
    align_series, rolling_mean, rolling_std, normal_cdf, pearson,
    rolling_correlation_last, zscore,
)
from analysis.cointegration import engle_granger
from analysis.half_life import half_life
from analysis.hurst import hurst_exponent
from analysis.backtester import historical_win_rate

logger = logging.getLogger(__name__)

__all__ = ["ScanParams", "PairResult", "compute_pair", "signal_strength_label"]


@dataclass
class ScanParams:
    """User-configurable scan parameters (defaults per spec)."""
    interval: str = "D"
    from_date: str = ""
    to_date: str = ""
    sector: str = ""                 # empty = all sectors
    rolling_window: int = 250
    lower_density: float = 0.01
    upper_density: float = 0.99
    min_correlation: float = 0.80
    coint_pvalue_max: float = 0.05


@dataclass
class PairResult:
    sector: str
    instrument1: str
    instrument2: str
    correlation: Optional[float] = None
    density: Optional[float] = None
    current_ratio: Optional[float] = None
    mean_ratio: Optional[float] = None
    std_dev: Optional[float] = None
    z_score: Optional[float] = None
    rolling_correlation: Optional[float] = None
    coint_pvalue: Optional[float] = None
    half_life: Optional[float] = None
    hurst: Optional[float] = None
    volatility_ratio: Optional[float] = None
    expected_reversion_bars: Optional[float] = None
    recommendation: str = "No Action"
    signal_strength: Optional[float] = None
    signal_label: str = ""
    historical_win_pct: Optional[float] = None
    bars_used: int = 0
    last_updated: str = ""
    skipped_reason: str = ""

    def to_dict(self):
        d = asdict(self)
        for k, v in d.items():
            if isinstance(v, float) and not math.isfinite(v):
                d[k] = None
        return d


def _clean(x):
    # type: (float) -> Optional[float]
    """NaN/inf -> None so results JSON-serialize cleanly."""
    if x is None:
        return None
    try:
        xf = float(x)
    except (TypeError, ValueError):
        return None
    return xf if math.isfinite(xf) else None


def signal_strength_label(score):
    # type: (Optional[float]) -> str
    if score is None:
        return ""
    if score >= 90:
        return "Very Strong"
    if score >= 75:
        return "Strong"
    if score >= 55:
        return "Moderate"
    return "Weak"


def _signal_strength(density, roll_corr, coint_p, hl_bars, hurst_val, win_pct,
                     lower, upper, window):
    """Composite 0-100 score. Each component is normalized to 0-1 and weighted.

    Components: signal extremity (density), rolling correlation, cointegration
    confidence, half-life speed, mean-reversion tendency (hurst), historical
    win rate. Missing components fall back to a neutral 0.5 so one failed
    statistic doesn't zero the score.
    """
    parts = []   # (weight, value 0..1)

    # Density extremity: 1 at/beyond the limits, 0 at the neutral midpoint.
    if density is not None:
        if density <= lower:
            parts.append((0.25, 1.0))
        elif density >= upper:
            parts.append((0.25, 1.0))
        else:
            mid = 0.5
            extremity = abs(density - mid) / (mid - lower) if mid > lower else 0.0
            parts.append((0.25, max(0.0, min(1.0, extremity))))
    else:
        parts.append((0.25, 0.0))

    parts.append((0.20, max(0.0, min(1.0, roll_corr)) if roll_corr is not None else 0.5))

    if coint_p is not None:
        parts.append((0.20, max(0.0, min(1.0, 1.0 - coint_p / 0.10))))
    else:
        parts.append((0.20, 0.5))

    if hl_bars is not None and hl_bars > 0:
        # Fast reversion is good: 1.0 when hl <= 5% of window, 0 when >= window
        parts.append((0.15, max(0.0, min(1.0, 1.0 - hl_bars / float(window)))))
    else:
        parts.append((0.15, 0.0))

    if hurst_val is not None:
        # 0.0 -> strongly mean reverting (1.0 score); 0.5 random (0.0 score)
        parts.append((0.10, max(0.0, min(1.0, (0.5 - hurst_val) / 0.5))))
    else:
        parts.append((0.10, 0.5))

    parts.append((0.10, win_pct / 100.0 if win_pct is not None else 0.5))

    total_w = sum(w for w, _ in parts)
    score = sum(w * v for w, v in parts) / total_w * 100.0
    return round(score, 1)


def compute_pair(sector, sym1, sym2, series1, series2, params):
    # type: (str, str, str, dict, dict, ScanParams) -> PairResult
    """Compute all screener metrics for one instrument pair.

    series1/series2: {"time": np.ndarray, "close": np.ndarray}
    Never raises — failures return a PairResult with skipped_reason set.
    """
    res = PairResult(sector=sector, instrument1=sym1, instrument2=sym2,
                     last_updated=datetime.now().strftime("%Y-%m-%d %H:%M:%S"))
    try:
        _, c1, c2 = align_series(series1["time"], series1["close"],
                                 series2["time"], series2["close"])
        w = int(params.rolling_window)
        min_bars = max(w, 40)
        if c1.size < min_bars:
            res.skipped_reason = "insufficient overlapping history ({} bars, need {})".format(c1.size, min_bars)
            return res
        if np.any(c2 == 0):
            nz = c2 != 0
            c1, c2 = c1[nz], c2[nz]
            if c1.size < min_bars:
                res.skipped_reason = "insufficient history after removing zero prices"
                return res
        res.bars_used = int(c1.size)

        corr = pearson(c1, c2)
        res.correlation = _clean(corr)
        if res.correlation is None or res.correlation < params.min_correlation:
            res.skipped_reason = "correlation below minimum"
            return res

        ratio = c1 / c2
        mean_r = rolling_mean(ratio, w)
        std_r = rolling_std(ratio, w)

        cur = float(ratio[-1])
        m = float(mean_r[-1])
        s = float(std_r[-1])
        res.current_ratio = _clean(cur)
        res.mean_ratio = _clean(m)
        res.std_dev = _clean(s)
        res.z_score = _clean(zscore(cur, m, s))
        res.density = _clean(normal_cdf(cur, m, s))

        res.rolling_correlation = _clean(rolling_correlation_last(c1, c2, w))

        # Cointegration on log prices (standard practice for stat-arb)
        with np.errstate(all="ignore"):
            l1, l2 = np.log(c1), np.log(c2)
        if np.all(np.isfinite(l1)) and np.all(np.isfinite(l2)):
            _, pval = engle_granger(l1, l2)
            res.coint_pvalue = _clean(pval)

        hl = half_life(ratio)
        res.half_life = _clean(hl)
        res.hurst = _clean(hurst_exponent(ratio))

        rs1 = rolling_std(c1, w)
        rs2 = rolling_std(c2, w)
        v1, v2 = float(rs1[-1]), float(rs2[-1])
        res.volatility_ratio = _clean(v1 / v2) if v2 and math.isfinite(v2) and v2 > 0 else None

        # Expected bars back to mean: distance in half-lives times half-life
        if res.half_life and res.z_score is not None and math.isfinite(res.z_score):
            res.expected_reversion_bars = _clean(res.half_life * min(abs(res.z_score), 4.0))

        # Historical win rate over the full aligned window
        with np.errstate(all="ignore"):
            z_series = (ratio - mean_r) / std_r
        dens_series = np.full(ratio.size, np.nan)
        valid = np.isfinite(mean_r) & np.isfinite(std_r) & (std_r > 0)
        idx = np.where(valid)[0]
        for i in idx:
            dens_series[i] = normal_cdf(float(ratio[i]), float(mean_r[i]), float(std_r[i]))
        res.historical_win_pct = None
        if res.half_life:
            res.historical_win_pct = historical_win_rate(
                z_series, dens_series,
                params.lower_density, params.upper_density, res.half_life,
            )
        if res.historical_win_pct is not None:
            res.historical_win_pct = round(res.historical_win_pct, 1)

        # Recommendation
        if res.density is not None:
            if res.density <= params.lower_density:
                res.recommendation = "BUY {} / SELL {}".format(sym1, sym2)
            elif res.density >= params.upper_density:
                res.recommendation = "SELL {} / BUY {}".format(sym1, sym2)

        res.signal_strength = _signal_strength(
            res.density, res.rolling_correlation, res.coint_pvalue,
            res.half_life, res.hurst, res.historical_win_pct,
            params.lower_density, params.upper_density, w,
        )
        res.signal_label = signal_strength_label(res.signal_strength)
        return res
    except Exception as e:
        logger.exception("compute_pair failed for %s-%s", sym1, sym2)
        res.skipped_reason = "error: {}".format(e)
        return res
