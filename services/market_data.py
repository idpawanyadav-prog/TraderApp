"""
Market data service for the analysis modules.

Wraps the existing 5Paisa historical API (broker/fivepaisa.py) with:
  - a per-scan in-memory cache: each symbol is downloaded exactly once
  - concurrent prefetching via ThreadPoolExecutor
  - symbol -> scrip resolution supplied by the caller (app.py owns the
    scrip master), keeping this module free of app/Flask imports.
"""
import json
import logging
import os
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Callable, Dict, List, Optional

import numpy as np

import fivepaisa as fp

logger = logging.getLogger(__name__)

__all__ = ["PriceCache"]

_SETTINGS_FILE = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                              "settings.json")


def _datafeed_opts_from_settings():
    """Respect Settings → Enable Market → Save data in DataFeed folder."""
    try:
        with open(_SETTINGS_FILE, "r") as f:
            s = json.load(f)
        save = bool(s.get("save_to_datafeed", False))
    except Exception:
        save = False
    return {"save_to_datafeed": save, "use_cache": save}


class PriceCache(object):
    """Fetch-once cache of {symbol: {"time": ndarray, "close": ndarray}}.

    resolver(symbol) must return a dict with keys scrip_code/exch/exch_type
    (an entry from the 5Paisa scrip master) or None if unknown.
    """

    def __init__(self, access_token, resolver, interval, from_date, to_date,
                 max_workers=8):
        # type: (str, Callable[[str], Optional[dict]], str, str, str, int) -> None
        self._token = access_token
        self._resolve = resolver
        self._interval = interval
        self._from = from_date
        self._to = to_date
        self._max_workers = max_workers
        self._lock = threading.Lock()
        self._data = {}    # type: Dict[str, dict]
        self._errors = {}  # type: Dict[str, str]
        self._df_opts = _datafeed_opts_from_settings()

    def _fetch_one(self, symbol):
        # type: (str) -> None
        """Download one symbol; record data or error. Never raises."""
        try:
            inst = self._resolve(symbol)
            if not inst:
                raise ValueError("symbol not found in scrip master")
            candles = fp.get_historical_data(
                self._token, inst["exch"], inst["exch_type"],
                inst["scrip_code"], self._interval, self._from, self._to,
                symbol=inst.get("trading_symbol") or symbol,
                timeout=60,
                **self._df_opts,
            )
            times = np.array([c["time"] for c in candles
                              if isinstance(c["time"], int)], dtype=np.int64)
            closes = np.array([c["close"] for c in candles
                               if isinstance(c["time"], int)], dtype=np.float64)
            with self._lock:
                self._data[symbol] = {"time": times, "close": closes}
        except Exception as e:
            logger.warning("fetch failed for %s: %s", symbol, e)
            with self._lock:
                self._errors[symbol] = str(e)

    def prefetch(self, symbols, progress_cb=None, cancel_event=None):
        # type: (List[str], Optional[Callable[[int, int], None]], Optional[threading.Event]) -> None
        """Download all `symbols` concurrently (each exactly once)."""
        todo = []
        with self._lock:
            for s in symbols:
                if s not in self._data and s not in self._errors and s not in todo:
                    todo.append(s)
        total = len(todo)
        done = 0
        if not todo:
            return
        with ThreadPoolExecutor(max_workers=self._max_workers) as pool:
            futures = {pool.submit(self._fetch_one, s): s for s in todo}
            for fut in as_completed(futures):
                done += 1
                if progress_cb:
                    progress_cb(done, total)
                if cancel_event is not None and cancel_event.is_set():
                    for f in futures:
                        f.cancel()
                    break

    def get(self, symbol):
        # type: (str) -> Optional[dict]
        with self._lock:
            return self._data.get(symbol)

    def error(self, symbol):
        # type: (str) -> Optional[str]
        with self._lock:
            return self._errors.get(symbol)

    @property
    def loaded_symbols(self):
        # type: () -> List[str]
        with self._lock:
            return list(self._data.keys())
