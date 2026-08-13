"""
Engle-Granger cointegration test (two series, constant term).

Implemented from first principles with numpy because statsmodels/scipy are
not required as app dependencies.

Method:
  1. OLS: y = alpha + beta * x + eps  -> residuals
  2. ADF regression on residuals (with `maxlag` lagged differences):
         d(e_t) = gamma * e_{t-1} + sum_i phi_i * d(e_{t-i}) + u_t
     t-statistic of gamma is the Engle-Granger tau statistic.
  3. p-value: monotone interpolation over the MacKinnon (2010) response-surface
     critical values for N=2, constant, large T. This is an approximation —
     accurate to a few 1/100ths near the conventional 1%/5%/10% decision
     thresholds, which is what a screener needs. It is NOT a substitute for
     statsmodels.coint when exact p-values matter.
"""
import logging
import math
from typing import Tuple

import numpy as np

logger = logging.getLogger(__name__)

__all__ = ["engle_granger", "adf_tstat", "ols_residuals"]

# MacKinnon (2010) asymptotic critical values, Engle-Granger tau,
# 2 variables, constant, no trend.  (quantile, tau)
_EG_TAU_QUANTILES = [
    (0.01, -3.914),
    (0.05, -3.344),
    (0.10, -3.048),
    (0.25, -2.617),   # interpolated helper point
    (0.50, -2.187),   # approximate median of the tau distribution
    (0.90, -1.240),
    (0.99, -0.070),
]


def ols_residuals(y, x):
    # type: (np.ndarray, np.ndarray) -> Tuple[np.ndarray, float, float]
    """OLS of y on [1, x]. Returns (residuals, alpha, beta)."""
    x = np.asarray(x, dtype=np.float64)
    y = np.asarray(y, dtype=np.float64)
    X = np.column_stack([np.ones_like(x), x])
    coef, _, _, _ = np.linalg.lstsq(X, y, rcond=None)
    alpha, beta = float(coef[0]), float(coef[1])
    resid = y - (alpha + beta * x)
    return resid, alpha, beta


def adf_tstat(series, maxlag=1):
    # type: (np.ndarray, int) -> float
    """t-statistic of gamma in the ADF regression (no constant — residuals
    are already mean-zero by construction)."""
    e = np.asarray(series, dtype=np.float64)
    de = np.diff(e)
    n = de.size
    if n <= maxlag + 2:
        return float("nan")

    # Regressors: e_{t-1} plus `maxlag` lagged differences
    rows = n - maxlag
    y = de[maxlag:]
    cols = [e[maxlag:-1]]
    for i in range(1, maxlag + 1):
        cols.append(de[maxlag - i:n - i])
    X = np.column_stack(cols)

    coef, _, _, _ = np.linalg.lstsq(X, y, rcond=None)
    fitted = X.dot(coef)
    u = y - fitted
    dof = rows - X.shape[1]
    if dof <= 0:
        return float("nan")
    s2 = float(u.dot(u)) / dof
    try:
        xtx_inv = np.linalg.inv(X.T.dot(X))
    except np.linalg.LinAlgError:
        return float("nan")
    se_gamma = math.sqrt(max(s2 * xtx_inv[0, 0], 0.0))
    if se_gamma == 0:
        return float("nan")
    return float(coef[0]) / se_gamma


def _tau_to_pvalue(tau):
    # type: (float) -> float
    """Monotone piecewise-linear interpolation of p over the tau table."""
    if not math.isfinite(tau):
        return float("nan")
    pts = _EG_TAU_QUANTILES
    if tau <= pts[0][1]:
        return pts[0][0] * math.exp(tau - pts[0][1])  # decay below 1% point
    if tau >= pts[-1][1]:
        return pts[-1][0]
    for (p_lo, t_lo), (p_hi, t_hi) in zip(pts, pts[1:]):
        if t_lo <= tau <= t_hi:
            frac = (tau - t_lo) / (t_hi - t_lo)
            return p_lo + frac * (p_hi - p_lo)
    return float("nan")


def engle_granger(y, x, maxlag=1):
    # type: (np.ndarray, np.ndarray, int) -> Tuple[float, float]
    """Run the Engle-Granger test. Returns (tau_statistic, p_value).

    Lower p-value => stronger evidence the pair is cointegrated.
    """
    try:
        resid, _, _ = ols_residuals(y, x)
        tau = adf_tstat(resid, maxlag=maxlag)
        return tau, _tau_to_pvalue(tau)
    except Exception:
        logger.exception("engle_granger failed")
        return float("nan"), float("nan")
