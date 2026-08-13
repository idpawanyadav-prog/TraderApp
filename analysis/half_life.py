"""
Half-life of mean reversion via Ornstein-Uhlenbeck regression.

Regress d(s_t) = lambda * s_{t-1} + c;  half_life = -ln(2) / lambda.
A negative lambda indicates mean reversion; non-negative lambda means the
series is not mean-reverting and half-life is reported as NaN.
"""
import logging
import math

import numpy as np

logger = logging.getLogger(__name__)

__all__ = ["half_life"]


def half_life(series):
    # type: (np.ndarray) -> float
    """Estimate mean-reversion half-life in bars. NaN if not mean-reverting."""
    try:
        s = np.asarray(series, dtype=np.float64)
        s = s[np.isfinite(s)]
        if s.size < 20:
            return float("nan")
        lagged = s[:-1]
        delta = np.diff(s)
        X = np.column_stack([np.ones_like(lagged), lagged])
        coef, _, _, _ = np.linalg.lstsq(X, delta, rcond=None)
        lam = float(coef[1])
        if lam >= 0:
            return float("nan")
        return -math.log(2.0) / lam
    except Exception:
        logger.exception("half_life failed")
        return float("nan")
