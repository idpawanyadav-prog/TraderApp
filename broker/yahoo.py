"""
Yahoo Finance chart data (no login).

Uses the v8 chart endpoint with a configurable Base URL template:
  {YahooStockSymbol}  ticker from Yahoo Stock List.csv
  {UTCStartDTM}       Unix UTC start
  {UTCEndDTM}         Unix UTC end
  {Interval}          Yahoo interval (1m, 5m, 15m, 30m, 60m, 1d)
"""
from __future__ import annotations

import csv
import os
import threading
from datetime import datetime, timedelta, timezone
from urllib.parse import quote

import requests

_APP_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
YAHOO_LIST_CSV = os.path.join(_APP_ROOT, "Yahoo Stock List.csv")
INSTRUMENT_CSV = os.path.join(_APP_ROOT, "Instrument.csv")

DEFAULT_BASE_URL = (
    "https://query1.finance.yahoo.com/v8/finance/chart/{YahooStockSymbol}"
    "?symbol={YahooStockSymbol}&period1={UTCStartDTM}&period2={UTCEndDTM}"
    "&useYfid=true&interval={Interval}"
)

MAX_1M_DAYS = 8
MAX_1M_SECONDS = MAX_1M_DAYS * 24 * 60 * 60
MAX_30M_DAYS = 60
MAX_30M_SECONDS = MAX_30M_DAYS * 24 * 60 * 60

INTERVAL_MAP = {
    "1": "1m",
    "5": "5m",
    "15": "15m",
    "25": "30m",
    "30": "30m",
    "60": "60m",
    "90": "90m",
    "D": "1d",
    "W": "1wk",
    "M": "1mo",
    "Q": "3mo",
}

_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/124.0.0.0 Safari/537.36"
)

_lock = threading.Lock()
_cache = {"mtime": None, "rows": [], "by_instrument": {}}  # type: dict
_inst_names = {"mtime": None, "names": set()}  # type: dict

_session = requests.Session()
_session.headers.update({
    "User-Agent": _UA,
    "Accept": "application/json,text/plain,*/*",
})


def _row_from_csv(raw):
    instrument = (raw.get("Instrument") or raw.get("instrument") or "").strip()
    yahoo_sym = (
        raw.get("YahooStockSymbol")
        or raw.get("YahooStocksymbol")
        or raw.get("Symbol")
        or raw.get("symbol")
        or ""
    ).strip()
    if not instrument or not yahoo_sym:
        return None
    return {
        "trading_symbol": instrument,
        "name": instrument,
        "yahoo_symbol": yahoo_sym,
        "exchange_label": "Yahoo",
        "scrip_code": yahoo_sym,
    }


def _ensure_list():
    path = YAHOO_LIST_CSV
    if not os.path.exists(path):
        with _lock:
            _cache["mtime"] = None
            _cache["rows"] = []
            _cache["by_instrument"] = {}
        return
    mtime = os.path.getmtime(path)
    with _lock:
        if _cache["mtime"] == mtime and _cache["rows"]:
            return
        rows = []
        by_inst = {}
        with open(path, encoding="utf-8-sig", newline="") as f:
            for raw in csv.DictReader(f):
                rec = _row_from_csv(raw)
                if not rec:
                    continue
                rows.append(rec)
                key = rec["trading_symbol"].upper()
                if key not in by_inst:
                    by_inst[key] = rec
        _cache["mtime"] = mtime
        _cache["rows"] = rows
        _cache["by_instrument"] = by_inst


def _ensure_instrument_names():
    path = INSTRUMENT_CSV
    if not os.path.exists(path):
        with _lock:
            _inst_names["mtime"] = None
            _inst_names["names"] = set()
        return
    mtime = os.path.getmtime(path)
    with _lock:
        if _inst_names["mtime"] == mtime:
            return
        names = set()
        with open(path, encoding="utf-8-sig", newline="") as f:
            for raw in csv.DictReader(f):
                name = (raw.get("Name") or "").strip().upper()
                root = (raw.get("SymbolRoot") or "").strip().upper()
                if name:
                    names.add(name)
                if root:
                    names.add(root)
        _inst_names["mtime"] = mtime
        _inst_names["names"] = names


def list_instruments():
    _ensure_list()
    with _lock:
        return list(_cache["rows"])


def lookup_instrument(symbol):
    """Map Sector/Instrument.csv symbol -> Yahoo list row via Instrument field."""
    _ensure_list()
    key = (symbol or "").strip().upper()
    if not key:
        return None
    with _lock:
        rec = _cache["by_instrument"].get(key)
        if rec:
            return dict(rec)
        for inst, row in _cache["by_instrument"].items():
            if inst.replace("/", "") == key.replace("/", ""):
                return dict(row)
    return None


def search_instruments(q, limit=15):
    """Search Yahoo Stock List Instrument names; rank matches that exist in Instrument.csv first."""
    q = (q or "").strip().upper()
    if len(q) < 2:
        return []
    _ensure_list()
    _ensure_instrument_names()
    with _lock:
        rows = list(_cache["rows"])
        csv_names = set(_inst_names["names"])

    def score(rec):
        inst = rec["trading_symbol"].upper()
        ysym = rec["yahoo_symbol"].upper()
        in_master = inst in csv_names
        exact = inst == q
        starts = inst.startswith(q)
        return (
            0 if exact else 1 if starts else 2,
            0 if in_master else 1,
            0 if q in inst else 1 if q in ysym else 2,
            inst,
        )

    hits = [
        rec for rec in rows
        if q in rec["trading_symbol"].upper() or q in rec["yahoo_symbol"].upper()
    ]
    hits.sort(key=score)
    return hits[: max(1, min(50, int(limit or 15)))]


def yahoo_interval(app_interval):
    return INTERVAL_MAP.get(str(app_interval or "D"), "1d")


def utc_period(from_date, to_date, interval=None):
    """Unix UTC seconds for Yahoo period1 / period2.

    1-minute bars: at most 8 days per request.
    30-minute bars: range must fall within the last 60 days.
    """
    try:
        start = datetime.strptime(str(from_date)[:10], "%Y-%m-%d").replace(tzinfo=timezone.utc)
    except (TypeError, ValueError):
        start = datetime.now(timezone.utc) - timedelta(days=MAX_1M_DAYS)
    try:
        end = datetime.strptime(str(to_date)[:10], "%Y-%m-%d").replace(tzinfo=timezone.utc)
        end = end + timedelta(days=1)
    except (TypeError, ValueError):
        end = datetime.now(timezone.utc)
    now = datetime.now(timezone.utc)
    if end > now:
        end = now
    p1 = int(start.timestamp())
    p2 = int(end.timestamp())
    if p2 <= p1:
        p2 = p1 + 60
    yiv = yahoo_interval(interval) if interval is not None else ""
    if yiv == "1m" or str(interval) == "1":
        if p2 - p1 > MAX_1M_SECONDS:
            p1 = p2 - MAX_1M_SECONDS
    elif yiv == "30m" or str(interval) in ("25", "30"):
        earliest = int((now - timedelta(days=MAX_30M_DAYS)).timestamp())
        if p1 < earliest:
            p1 = earliest
        if p2 < earliest:
            p2 = earliest + 60
        if p2 <= p1:
            p2 = p1 + 60
    return p1, p2


def build_chart_url(base_url, yahoo_symbol, from_date, to_date, interval):
    template = (base_url or DEFAULT_BASE_URL).strip() or DEFAULT_BASE_URL
    encoded = quote(str(yahoo_symbol or ""), safe="")
    p1, p2 = utc_period(from_date, to_date, interval)
    yiv = yahoo_interval(interval)
    return (
        template
        .replace("{YahooStockSymbol}", encoded)
        .replace("{UTCStartDTM}", str(p1))
        .replace("{UTCEndDTM}", str(p2))
        .replace("{Interval}", yiv)
    )


def get_historical_data(yahoo_symbol, interval, from_date, to_date,
                        base_url=None, timeout=40):
    """Return list of {time, open, high, low, close, volume} (Unix UTC seconds)."""
    symbol = (yahoo_symbol or "").strip()
    if not symbol:
        raise ValueError("YahooStockSymbol is required.")
    url = build_chart_url(base_url, symbol, from_date, to_date, interval)
    resp = _session.get(url, timeout=timeout)
    resp.raise_for_status()
    payload = resp.json() if resp.content else {}
    chart = payload.get("chart") or {}
    err = chart.get("error")
    if err:
        desc = err.get("description") or err.get("code") or str(err)
        raise ValueError(desc)
    results = chart.get("result") or []
    if not results:
        return []
    result = results[0]
    timestamps = result.get("timestamp") or []
    quote = ((result.get("indicators") or {}).get("quote") or [{}])[0]
    opens = quote.get("open") or []
    highs = quote.get("high") or []
    lows = quote.get("low") or []
    closes = quote.get("close") or []
    volumes = quote.get("volume") or []
    candles = []
    for i, ts in enumerate(timestamps):
        try:
            close = closes[i] if i < len(closes) else None
            if close is None:
                continue
            candles.append({
                "time": int(ts),
                "open": float(opens[i] if i < len(opens) and opens[i] is not None else close),
                "high": float(highs[i] if i < len(highs) and highs[i] is not None else close),
                "low": float(lows[i] if i < len(lows) and lows[i] is not None else close),
                "close": float(close),
                "volume": int(volumes[i] or 0) if i < len(volumes) else 0,
            })
        except (TypeError, ValueError):
            continue
    return candles
