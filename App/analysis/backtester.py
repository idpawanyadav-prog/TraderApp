"""
Historical signal backtester for the density screener.

For every bar where the density crossed the configured limits (i.e. a
BUY/SELL signal would have fired), check whether the ratio z-score reverted
to ~0 within one half-life worth of bars. Reports the win percentage.
"""
import logging
import math
from typing import Optional

import numpy as np

logger = logging.getLogger(__name__)

__all__ = ["historical_win_rate"]


def historical_win_rate(zscores, densities, lower, upper, half_life_bars,
                        revert_band=0.25):
    # type: (np.ndarray, np.ndarray, float, float, float, float) -> Optional[float]
    """Percentage of historical density signals that mean-reverted in time.

    A signal at bar i "wins" if |z| dips below `revert_band` within
    ceil(half_life_bars) bars after i. Returns None when there were no
    historical signals or half-life is unusable.
    """
    try:
        if half_life_bars is None or not math.isfinite(half_life_bars) or half_life_bars <= 0:
            return None
        horizon = int(math.ceil(half_life_bars))
        z = np.asarray(zscores, dtype=np.float64)
        d = np.asarray(densities, dtype=np.float64)
        n = z.size
        if n == 0 or d.size != n:
            return None

        signal_idx = np.where(np.isfinite(d) & ((d <= lower) | (d >= upper)))[0]
        # Skip signals too close to the end to have a full observation window
        signal_idx = signal_idx[signal_idx + 1 < n]
        if signal_idx.size == 0:
            return None

        wins = 0
        evaluated = 0
        last_counted = -10**9
        for i in signal_idx:
            # De-duplicate clustered signals: count one per half-life window
            if i - last_counted < horizon:
                continue
            last_counted = i
            evaluated += 1
            end = min(i + horizon + 1, n)
            window = np.abs(z[i + 1:end])
            window = window[np.isfinite(window)]
            if window.size and window.min() <= revert_band:
                wins += 1
        if evaluated == 0:
            return None
        return 100.0 * wins / evaluated
    except Exception:
        logger.exception("historical_win_rate failed")
        return None
