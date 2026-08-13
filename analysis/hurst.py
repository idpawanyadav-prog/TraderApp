"""
Hurst exponent estimation via the aggregated-lag variance method.

H < 0.5  -> mean reverting
H ~ 0.5  -> random walk
H > 0.5  -> trending
"""
import logging
import math

import numpy as np

logger = logging.getLogger(__name__)

__all__ = ["hurst_exponent"]


def hurst_exponent(series, max_lag=64):
    # type: (np.ndarray, int) -> float
    """Estimate the Hurst exponent from the scaling of lagged differences.

    Uses std(x_{t+lag} - x_t) ~ lag^H; H is the slope of the log-log fit.
    """
    try:
        s = np.asarray(series, dtype=np.float64)
        s = s[np.isfinite(s)]
        n = s.size
        if n < 40:
            return float("nan")
        max_lag = int(min(max_lag, n // 4))
        if max_lag < 4:
            return float("nan")
        lags = np.unique(np.logspace(math.log10(2), math.log10(max_lag), num=12).astype(int))
        lags = lags[lags >= 2]
        taus = []
        used = []
        for lag in lags:
            diff = s[lag:] - s[:-lag]
            sd = diff.std()
            if sd > 0:
                taus.append(sd)
                used.append(lag)
        if len(used) < 3:
            return float("nan")
        slope = np.polyfit(np.log(used), np.log(taus), 1)[0]
        return float(slope)
    except Exception:
        logger.exception("hurst_exponent failed")
        return float("nan")
