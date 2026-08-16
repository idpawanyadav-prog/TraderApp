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
import xml.etree.ElementTree as _ET
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime as _parsedate_to_datetime
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


NEWS_RSS_URL = "https://news.google.com/rss/search"
NEWS_RSS_REGION = "IN"
NEWS_RSS_LANG = "en-IN"

# Friendlier search phrases for well-known non-stock symbols, so results stay
# on-topic instead of searching a raw ticker like "^NSEI".
_NEWS_QUERY_OVERRIDES = {
    "^NSEI": "Nifty 50 index",
    "^NSEBANK": "Bank Nifty index",
    "^NSEMDCP50": "Nifty Midcap 50 index",
    "NIFTY_FIN_SERVICE.NS": "Nifty Financial Services index",
}


def _news_query(name, yahoo_symbol):
    """Build a Google News search phrase for an instrument."""
    override = _NEWS_QUERY_OVERRIDES.get((yahoo_symbol or "").strip())
    if override:
        return override
    base = (name or "").replace("/", " ").strip()
    sym = (yahoo_symbol or "").strip()
    if not base:
        base = sym.replace("/", " ").strip()
    if not base:
        return ""
    if sym.endswith((".NS", ".BO")):
        return base + " share price"
    if sym.startswith("^"):
        return base + " index"
    if sym.endswith("=X"):
        return base + " exchange rate"
    if sym.endswith("=F"):
        return base + " price"
    return base


def _news_from_yfinance(yahoo_symbol, count=8):
    """Fetch news via yfinance (Yahoo Finance search endpoint).

    Returns a list of {title, publisher, link, published, thumbnail} or [].
    Yahoo's search endpoint is US-centric and rate-limited, so this may return
    nothing or generic items; callers should fall back to Google News RSS.
    """
    try:
        import yfinance as yf
    except Exception:
        return []
    symbol = (yahoo_symbol or "").strip()
    if not symbol:
        return []
    try:
        ticker = yf.Ticker(symbol)
        news = ticker.news or []
    except Exception:
        return []
    items = []
    for raw in news:
        if not isinstance(raw, dict):
            continue
        title = (raw.get("title") or "").strip()
        link = (raw.get("link") or "").strip()
        if not title or not link:
            continue
        thumb = ""
        resolutions = ((raw.get("thumbnail") or {}).get("resolutions")) or []
        if resolutions:
            thumb = (resolutions[0].get("url") or "").strip()
        items.append({
            "title": title,
            "publisher": (raw.get("publisher") or "").strip(),
            "link": link,
            "published": int(raw.get("providerPublishTime") or 0),
            "thumbnail": thumb,
        })
        if len(items) >= max(1, int(count or 8)):
            break
    return items


def _news_from_google_rss(yahoo_symbol, name, count=8, timeout=20):
    """Fallback: fetch ticker-relevant headlines via Google News RSS."""
    query = _news_query(name, yahoo_symbol)
    if not query:
        return []
    try:
        resp = _session.get(
            NEWS_RSS_URL,
            params={
                "q": query,
                "hl": NEWS_RSS_LANG,
                "gl": NEWS_RSS_REGION,
                "ceid": NEWS_RSS_REGION + ":" + NEWS_RSS_LANG.split("-")[0],
            },
            timeout=timeout,
        )
        resp.raise_for_status()
    except Exception:
        return []

    items = []
    try:
        root = _ET.fromstring(resp.content)
    except Exception:
        return []
    for node in root.findall("./channel/item"):
        title = (node.findtext("title") or "").strip()
        link = (node.findtext("link") or "").strip()
        if not title or not link:
            continue
        publisher = (node.findtext("source") or "").strip()
        # Google News appends " - Publisher" to the headline; strip it.
        if publisher and title.endswith(" - " + publisher):
            title = title[: -(len(" - " + publisher))].strip()
        published = 0
        pub_date = (node.findtext("pubDate") or "").strip()
        if pub_date:
            try:
                dt = _parsedate_to_datetime(pub_date)
                published = int(dt.timestamp())
            except (TypeError, ValueError, OverflowError):
                published = 0
        items.append({
            "title": title,
            "publisher": publisher,
            "link": link,
            "published": published,
            "thumbnail": "",
        })
        if len(items) >= max(1, int(count or 8)):
            break
    return items


def get_news(yahoo_symbol, name=None, count=8, timeout=20):
    """Return recent news headlines for a symbol.

    Tries yfinance (Yahoo Finance) first, then falls back to Google News RSS
    keyed off the instrument name — which is what actually returns
    ticker-relevant items for Indian (.NS/.BO) symbols. Each item is
    {title, publisher, link, published (unix seconds), thumbnail}.
    """
    items = _news_from_yfinance(yahoo_symbol, count)
    if items:
        return items
    return _news_from_google_rss(yahoo_symbol, name, count, timeout)


# ── Fundamentals ────────────────────────────────────────────────────────────

# (label, yfinance info key, formatter) grouped into display sections.
_FUND_SECTIONS = [
    ("Overview", [
        ("Name", "longName", "text"),
        ("Sector", "sector", "text"),
        ("Industry", "industry", "text"),
        ("Exchange", "fullExchangeName", "text"),
        ("Website", "website", "text"),
        ("Market State", "marketState", "text"),
    ]),
    ("Price", [
        ("Current Price", "currentPrice", "price"),
        ("Previous Close", "previousClose", "price"),
        ("Open", "open", "price"),
        ("Day High", "dayHigh", "price"),
        ("Day Low", "dayLow", "price"),
        ("52-Week High", "fiftyTwoWeekHigh", "price"),
        ("52-Week Low", "fiftyTwoWeekLow", "price"),
        ("Analyst Target", "targetMeanPrice", "price"),
        ("Rating", "recommendationKey", "text"),
    ]),
    ("Valuation", [
        ("Market Cap", "marketCap", "money"),
        ("Enterprise Value", "enterpriseValue", "money"),
        ("P/E (TTM)", "trailingPE", "ratio"),
        ("P/E (Forward)", "forwardPE", "ratio"),
        ("Price / Book", "priceToBook", "ratio"),
        ("Price / Sales", "priceToSales", "ratio"),
        ("EPS (TTM)", "trailingEps", "ratio"),
        ("EPS (Forward)", "forwardEps", "ratio"),
        ("Book Value", "bookValue", "price"),
    ]),
    ("Profitability", [
        ("Profit Margin", "profitMargins", "pct"),
        ("Operating Margin", "operatingMargins", "pct"),
        ("Gross Margin", "grossMargins", "pct"),
        ("Return on Equity", "returnOnEquity", "pct"),
        ("Return on Assets", "returnOnAssets", "pct"),
    ]),
    ("Growth", [
        ("Revenue Growth", "revenueGrowth", "pct"),
        ("Earnings Growth", "earningsGrowth", "pct"),
    ]),
    ("Dividends", [
        ("Dividend Yield", "dividendYield", "pct"),
        ("Dividend Rate", "dividendRate", "price"),
    ]),
    ("Liquidity", [
        ("Beta (5Y)", "beta", "ratio"),
        ("Avg Volume", "averageVolume", "int"),
        ("Avg Volume (10D)", "averageDailyVolume10Day", "int"),
        ("Shares Outstanding", "sharesOutstanding", "int"),
    ]),
]


def _fmt_text(v):
    if v is None:
        return None
    s = str(v).strip()
    return s or None


def _fmt_price(v):
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    if f != f:  # NaN
        return None
    return "%.2f" % f


def _fmt_ratio(v):
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    if f != f:
        return None
    return "%.2f" % f


def _fmt_int(v):
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    if f != f:
        return None
    return "{:,.0f}".format(f)


def _fmt_pct(v):
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    if f != f:
        return None
    return "%.2f%%" % (f * 100.0)


def _fmt_money(v, currency=""):
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    if f != f:
        return None
    sign = "-" if f < 0 else ""
    a = abs(f)
    if currency == "INR":
        if a >= 1e12:
            return "%s₹%.2f Lakh Cr" % (sign, a / 1e12)
        if a >= 1e7:
            return "%s₹%.2f Cr" % (sign, a / 1e7)
        if a >= 1e5:
            return "%s₹%.2f L" % (sign, a / 1e5)
        return "%s₹%.2f" % (sign, a)
    if a >= 1e12:
        return "%s$%.2f T" % (sign, a / 1e12)
    if a >= 1e9:
        return "%s$%.2f B" % (sign, a / 1e9)
    if a >= 1e6:
        return "%s$%.2f M" % (sign, a / 1e6)
    return "%s$%.2f" % (sign, a)


def _fmt_fund(raw, kind, currency=""):
    if kind == "text":
        return _fmt_text(raw)
    if kind == "price":
        return _fmt_price(raw)
    if kind == "ratio":
        return _fmt_ratio(raw)
    if kind == "int":
        return _fmt_int(raw)
    if kind == "pct":
        return _fmt_pct(raw)
    if kind == "money":
        return _fmt_money(raw, currency)
    return _fmt_text(raw)


def _fund_symbol_candidates(yahoo_symbol):
    """Yield ticker candidates to try, in order.

    If the symbol is a bare root (e.g. "RELIANCE"), try the NSE (.NS) and then
    BSE (.BO) suffix so fundamentals resolve even when Yahoo has no data for
    the unsuffixed symbol.
    """
    symbol = (yahoo_symbol or "").strip()
    if not symbol:
        return
    yield symbol
    upper = symbol.upper()
    if upper.endswith((".NS", ".BO")):
        # Already suffixed; don't guess further.
        return
    if upper.startswith("^"):
        return
    yield symbol + ".NS"
    yield symbol + ".BO"


def _fetch_fund_info(symbol):
    try:
        import yfinance as yf
    except Exception:
        return None
    try:
        info = yf.Ticker(symbol).info or {}
    except Exception:
        return None
    return info or None


def get_fundamentals(yahoo_symbol, timeout=20, try_suffixes=False):
    """Return fundamental data for a ticker via yfinance.

    When ``try_suffixes`` is True (used for bare roots coming from Dhan /
    5Paisa), the given symbol is tried as-is, then with `.NS` appended, then
    `.BO` appended. When False (Yahoo broker — symbols are already correct),
    only the given symbol is tried. Returns
    {"name", "sections": [{"title", "rows": [{"label", "value"}]}]}
    or None when nothing could be retrieved.
    """
    info = None
    resolved = ""
    candidates = _fund_symbol_candidates(yahoo_symbol) if try_suffixes else [((yahoo_symbol or "").strip())]
    for symbol in candidates:
        if not symbol:
            continue
        data = _fetch_fund_info(symbol)
        if not data:
            continue
        info = data
        resolved = symbol
        break
    if not info:
        return None
    currency = str(info.get("currency") or "")
    result = {
        "name": _fmt_text(info.get("longName") or info.get("shortName")) or resolved,
        "sections": [],
    }
    for title, fields in _FUND_SECTIONS:
        rows = []
        for label, key, kind in fields:
            value = _fmt_fund(info.get(key), kind, currency)
            if value is None:
                continue
            rows.append({"label": label, "value": value})
        if rows:
            result["sections"].append({"title": title, "rows": rows})
    if not result["sections"]:
        return None
    return result
