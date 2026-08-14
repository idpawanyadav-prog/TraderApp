"""
Scan job manager for the Correlation Density screener.

Runs one scan at a time on background threads so Flask stays responsive.
Progress, status and results are polled by the UI via /api/analysis routes.

Designed for reuse: schedule_scan() could later be driven by a scheduler or
a real-time monitor without changing this module.
"""
import logging
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime
from typing import Callable, Dict, List, Optional

from analysis.correlation_density import ScanParams, compute_pair
from services.market_data import PriceCache
from services.pair_generator import generate_pairs

logger = logging.getLogger(__name__)

__all__ = ["ScanManager"]


class ScanManager(object):
    """Owns the lifecycle of the current scan (single active scan)."""

    def __init__(self, compute_workers=None):
        # type: (Optional[int]) -> None
        import os
        self._lock = threading.Lock()
        self._cancel = threading.Event()
        self._thread = None            # type: Optional[threading.Thread]
        self._compute_workers = compute_workers or min(8, (os.cpu_count() or 4))
        self._reset_state()

    def _reset_state(self):
        self._state = {
            "running": False,
            "phase": "idle",          # idle | fetching | computing | done | error | cancelled
            "message": "",
            "progress": 0,            # 0-100
            "pairs_total": 0,
            "pairs_done": 0,
            "symbols_total": 0,
            "symbols_done": 0,
            "started_at": None,
            "finished_at": None,
            "results": [],            # list of PairResult dicts
            "skipped": [],            # pairs skipped with reasons
            "fetch_errors": {},       # symbol -> error
        }

    # ── Public API ────────────────────────────────────────────────

    def status(self):
        # type: () -> dict
        with self._lock:
            s = dict(self._state)
            # Don't ship full results on every poll — status is lightweight
            s["result_count"] = len(s.pop("results"))
            s["skipped_count"] = len(s.pop("skipped"))
            return s

    def results(self):
        # type: () -> dict
        with self._lock:
            return {
                "results": list(self._state["results"]),
                "skipped": list(self._state["skipped"]),
                "fetch_errors": dict(self._state["fetch_errors"]),
                "phase": self._state["phase"],
            }

    def cancel(self):
        # type: () -> bool
        with self._lock:
            if not self._state["running"]:
                return False
        self._cancel.set()
        return True

    def start(self, access_token, resolver, sectors, params, fetcher=None):
        # type: (str, Callable, Dict[str, List[str]], ScanParams, Optional[Callable]) -> bool
        """Kick off a scan in a background thread. False if one is running."""
        with self._lock:
            if self._state["running"]:
                return False
            self._reset_state()
            self._state["running"] = True
            self._state["phase"] = "fetching"
            self._state["started_at"] = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        self._cancel.clear()
        self._thread = threading.Thread(
            target=self._run, args=(access_token, resolver, sectors, params, fetcher),
            daemon=True, name="cdc-scan",
        )
        self._thread.start()
        return True

    # ── Internals ─────────────────────────────────────────────────

    def _set(self, **kw):
        with self._lock:
            self._state.update(kw)

    def _run(self, access_token, resolver, sectors, params, fetcher=None):
        try:
            pairs = generate_pairs(sectors, params.sector)
            symbols = sorted({s for _, a, b in pairs for s in (a, b)})
            if not pairs:
                self._set(running=False, phase="done", progress=100,
                          message="No pairs to scan (check sector file / filter).",
                          finished_at=datetime.now().strftime("%Y-%m-%d %H:%M:%S"))
                return

            self._set(pairs_total=len(pairs), symbols_total=len(symbols),
                      message="Downloading {} symbols...".format(len(symbols)))

            cache = PriceCache(access_token, resolver, params.interval,
                               params.from_date, params.to_date, fetcher=fetcher)

            def fetch_progress(done, total):
                # Fetch phase occupies 0-50% of the progress bar
                self._set(symbols_done=done,
                          progress=int(50.0 * done / max(total, 1)),
                          message="Downloading data {}/{}".format(done, total))

            cache.prefetch(symbols, progress_cb=fetch_progress,
                           cancel_event=self._cancel)

            if self._cancel.is_set():
                self._finish("cancelled", "Scan cancelled during download.")
                return

            with self._lock:
                self._state["fetch_errors"] = {
                    s: cache.error(s) for s in symbols if cache.error(s)
                }
            self._set(phase="computing", message="Computing pair statistics...")

            results = []
            skipped = []
            done_count = [0]
            lock = threading.Lock()

            def work(pair):
                sector, s1, s2 = pair
                d1, d2 = cache.get(s1), cache.get(s2)
                if d1 is None or d2 is None:
                    reason = cache.error(s1) if d1 is None else cache.error(s2)
                    missing = s1 if d1 is None else s2
                    return None, {"sector": sector, "instrument1": s1,
                                  "instrument2": s2,
                                  "reason": "no data for {}: {}".format(missing, reason or "unknown")}
                r = compute_pair(sector, s1, s2, d1, d2, params)
                if r.skipped_reason:
                    return None, {"sector": sector, "instrument1": s1,
                                  "instrument2": s2, "reason": r.skipped_reason}
                return r.to_dict(), None

            with ThreadPoolExecutor(max_workers=self._compute_workers) as pool:
                futures = [pool.submit(work, p) for p in pairs]
                for fut in as_completed(futures):
                    if self._cancel.is_set():
                        for f in futures:
                            f.cancel()
                        break
                    try:
                        result, skip = fut.result()
                        if result:
                            results.append(result)
                        elif skip:
                            skipped.append(skip)
                    except Exception:
                        logger.exception("pair computation crashed")
                    with lock:
                        done_count[0] += 1
                    # Compute phase occupies 50-100%
                    self._set(pairs_done=done_count[0],
                              progress=50 + int(50.0 * done_count[0] / len(pairs)),
                              message="Computing {}/{} pairs".format(done_count[0], len(pairs)))

            if self._cancel.is_set():
                self._finish("cancelled", "Scan cancelled.", results, skipped)
                return

            results.sort(key=lambda r: -(r.get("signal_strength") or 0))
            self._finish("done",
                         "Scan complete: {} pairs qualified, {} skipped.".format(
                             len(results), len(skipped)),
                         results, skipped)
        except Exception as e:
            logger.exception("scan failed")
            self._finish("error", "Scan failed: {}".format(e))

    def _finish(self, phase, message, results=None, skipped=None):
        with self._lock:
            self._state["running"] = False
            self._state["phase"] = phase
            self._state["message"] = message
            self._state["progress"] = 100
            self._state["finished_at"] = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
            if results is not None:
                self._state["results"] = results
            if skipped is not None:
                self._state["skipped"] = skipped
