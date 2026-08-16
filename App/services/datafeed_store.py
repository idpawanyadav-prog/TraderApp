"""
Persist downloaded market data under <app>/datafeed for reuse.

All broker downloads that should be kept on disk go through this helper so
files land in one place next to the app. One CSV per stock (symbol in the
filename, not as a column inside the file).
"""
import csv
import os
import threading

_APP_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATAFEED_DIR = os.path.join(_APP_ROOT, "datafeed")
INSTRUMENT_CSV = os.path.join(_APP_ROOT, "Instrument.csv")

_lock = threading.Lock()
_CANDLE_FIELDS = ["time", "open", "high", "low", "close", "volume"]


def ensure_datafeed_dir():
    """Create datafeed/ under the app folder if missing."""
    if not os.path.isdir(DATAFEED_DIR):
        os.makedirs(DATAFEED_DIR)
    return DATAFEED_DIR


def _safe_token(value):
    text = str(value).strip()
    return "".join(c if (c.isalnum() or c in "-_") else "_" for c in text) or "NA"


def candle_cache_path(exch, exch_type, scrip_code, interval, from_date, to_date,
                      symbol=""):
    """One file per stock: SYMBOL_interval_from_to.csv (falls back to scrip_code)."""
    ensure_datafeed_dir()
    stock = _safe_token(symbol) if symbol else _safe_token(scrip_code)
    name = "{}_{}_{}_{}.csv".format(
        stock,
        _safe_token(interval),
        _safe_token(from_date),
        _safe_token(to_date),
    )
    return os.path.join(DATAFEED_DIR, name)


def save_candles(exch, exch_type, scrip_code, interval, from_date, to_date, candles,
                 symbol=""):
    """Write OHLCV candles to a stock-wise CSV under datafeed/. No symbol column."""
    if not candles:
        return None
    path = candle_cache_path(exch, exch_type, scrip_code, interval, from_date, to_date,
                             symbol=symbol)
    tmp = path + ".tmp"
    with _lock:
        with open(tmp, "w", encoding="utf-8", newline="") as f:
            writer = csv.DictWriter(f, fieldnames=_CANDLE_FIELDS)
            writer.writeheader()
            for c in candles:
                writer.writerow({
                    "time":   c.get("time", ""),
                    "open":   c.get("open", ""),
                    "high":   c.get("high", ""),
                    "low":    c.get("low", ""),
                    "close":  c.get("close", ""),
                    "volume": c.get("volume", 0),
                })
        os.replace(tmp, path)
    return path


def load_candles(exch, exch_type, scrip_code, interval, from_date, to_date,
                 symbol=""):
    """Load candles from datafeed/ if a matching stock-wise file exists; else None."""
    path = candle_cache_path(exch, exch_type, scrip_code, interval, from_date, to_date,
                             symbol=symbol)
    if not os.path.exists(path):
        return None
    rows = []
    try:
        with open(path, "r", encoding="utf-8") as f:
            reader = csv.DictReader(f)
            for row in reader:
                ts = row.get("time", "")
                try:
                    ts = int(ts)
                except (TypeError, ValueError):
                    pass
                rows.append({
                    "time":   ts,
                    "open":   float(row["open"]),
                    "high":   float(row["high"]),
                    "low":    float(row["low"]),
                    "close":  float(row["close"]),
                    "volume": int(float(row.get("volume") or 0)),
                })
    except Exception:
        return None
    return rows if rows else None
