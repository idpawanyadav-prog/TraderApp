"""
5Paisa broker module (Phase 1).
Implements TOTP-based OAuth flow + historical chart data via 5Paisa REST API.

Flow:
  1. POST /TOTPLogin         → RequestToken
  2. POST /GetAccessToken    → JWTToken (access_token)
  3. POST /V4/Margin         → margin / account info
  4. GET  /V2/historical/... → OHLCV candles
"""
import sys
import os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "libs"))

import ssl
import urllib3
import requests
from requests.adapters import HTTPAdapter

urllib3.disable_warnings()

# Custom adapter that sets check_hostname=False BEFORE verify_mode=CERT_NONE
# (required order to avoid the SSL conflict error)
class _NoSSLAdapter(HTTPAdapter):
    def init_poolmanager(self, *args, **kwargs):
        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
        kwargs["ssl_context"] = ctx
        super().init_poolmanager(*args, **kwargs)

_session = requests.Session()
_session.mount("https://", _NoSSLAdapter())
_session.verify = False

BASE_URL  = "https://Openapi.5paisa.com/VendorsAPI/Service1.svc"
API_UID   = "ka7SFqAU6SC"

_BASE_HEADERS = {
    "Content-Type":   "application/json",
    "5Paisa-API-Uid": API_UID,
}


def _headers(access_token: str = "") -> dict:
    h = dict(_BASE_HEADERS)
    if access_token:
        h["Authorization"] = f"Bearer {access_token}"
    return h


def get_request_token(user_key: str, email: str, totp: str, pin: str) -> str:
    """Step 1 — Exchange registered email + TOTP + PIN for a RequestToken."""
    payload = {
        "head": {"Key": user_key},
        "body": {
            "Email_ID": email,
            "TOTP":     totp,
            "PIN":      pin,
        },
    }
    resp = _session.post(
        f"{BASE_URL}/TOTPLogin",
        json=payload,
        headers=_headers(),
        timeout=15,
    )
    resp.raise_for_status()
    body = resp.json().get("body", {})
    if body.get("Status") != 0:
        raise Exception(body.get("Message") or "TOTPLogin failed")
    return body["RequestToken"]


def get_access_token(user_key: str, user_id: str, encryption_key: str,
                     request_token: str) -> str:
    """Step 2 — Exchange RequestToken for a JWT access token."""
    payload = {
        "head": {"Key": user_key},
        "body": {
            "RequestToken": request_token,
            "EncryKey":     encryption_key,
            "UserId":       user_id,
        },
    }
    resp = _session.post(
        f"{BASE_URL}/GetAccessToken",
        json=payload,
        headers=_headers(),
        timeout=15,
    )
    resp.raise_for_status()
    body = resp.json().get("body", {})
    if not body.get("AccessToken"):
        raise Exception(body.get("Message") or "GetAccessToken failed")
    return body["AccessToken"]


def get_margin(user_key: str, client_code: str, access_token: str) -> dict:
    """Fetch equity margin / available balance."""
    payload = {
        "head": {"key": user_key},
        "body": {"ClientCode": client_code},
    }
    resp = _session.post(
        f"{BASE_URL}/V4/Margin",
        json=payload,
        headers=_headers(access_token),
        timeout=15,
    )
    resp.raise_for_status()
    body = resp.json().get("body", {})
    margins = body.get("EquityMargin", [])
    return margins[0] if margins else body


# ── Scrip Master ──────────────────────────────────────────────

SCRIP_MASTER_URL   = f"{BASE_URL}/ScripMaster/segment/All"
HIST_BASE_URL      = "https://openapi.5paisa.com/V2/historical"
SUBSCRIPTION_KEY   = "c89fab8d895a426d9e00db380b433027"

# Interval map: our UI key → 5Paisa interval string
INTERVAL_MAP = {
    "1":  "1m",
    "5":  "5m",
    "15": "15m",
    "25": "30m",   # nearest available
    "30": "30m",
    "60": "60m",
    "D":  "1d",
}


def _parse_scrip_master_text(text: str) -> list:
    """Parse scrip-master CSV text into instrument dicts."""
    import csv, io
    reader = csv.DictReader(io.StringIO(text))
    rows = []
    for row in reader:
        exch      = row["Exch"].strip()
        exch_type = row["ExchType"].strip()
        series    = row.get("Series", "").strip()
        scrip     = row["ScripCode"].strip()
        name      = row["Name"].strip()
        fullname  = row["FullName"].strip()
        scrip_type = row.get("ScripType", "").strip().upper()
        if not scrip:
            continue
        if exch == "M":
            if exch_type != "D":
                continue
            exch_label = "MCX_COM"
        elif exch_type == "C":
            exch_label = ("NSE" if exch == "N" else "BSE") + "_EQ"
        elif exch_type == "D":
            exch_label = ("NSE" if exch == "N" else "BSE") + "_FNO"
        elif exch_type == "U":
            exch_label = ("NSE" if exch == "N" else "BSE") + "_CURRENCY"
        else:
            continue
        rows.append({
            "scrip_code":       scrip,
            "exch":             exch,
            "exch_type":        exch_type,
            "scrip_type":       scrip_type,
            "exchange_label":   exch_label,
            "trading_symbol":   name,
            "name":             fullname,
            "series":           series,
        })
    return rows


def download_scrip_master(cache_path: str = None, force: bool = False) -> list:
    """Load 5Paisa scrip master, caching to ``cache_path`` for reuse.

    If ``cache_path`` exists and ``force`` is False, parse the local file.
    Otherwise download, save to ``cache_path`` (when given), and parse.
    """
    if cache_path and not force and os.path.exists(cache_path):
        with open(cache_path, "r", encoding="utf-8") as f:
            return _parse_scrip_master_text(f.read())

    resp = _session.get(SCRIP_MASTER_URL, timeout=30)
    resp.raise_for_status()
    text = resp.text
    if cache_path:
        cache_dir = os.path.dirname(cache_path)
        if cache_dir and not os.path.isdir(cache_dir):
            os.makedirs(cache_dir)
        with open(cache_path, "w", encoding="utf-8", newline="") as f:
            f.write(text)
    return _parse_scrip_master_text(text)


def get_historical_data(access_token: str, exch: str, exch_type: str,
                        scrip_code: str, interval: str,
                        from_date: str, to_date: str,
                        save_to_datafeed: bool = False,
                        use_cache: bool = False,
                        symbol: str = "",
                        timeout: int = 20) -> list:
    """
    Fetch OHLCV candles from 5Paisa historical API.
    Returns list of {time, open, high, low, close, volume}.

    When save_to_datafeed is True, candles are written under <app>/datafeed/
    as one CSV per stock (symbol in the filename only).
    When use_cache is True, a matching local file is reused instead of hitting the API.
    """
    symbol = (symbol or "").strip()
    try:
        _app_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        if _app_root not in sys.path:
            sys.path.insert(0, _app_root)
        from services import datafeed_store as dfs
    except Exception:
        dfs = None

    if use_cache and save_to_datafeed and dfs is not None:
        cached = dfs.load_candles(exch, exch_type, scrip_code, interval, from_date, to_date,
                                  symbol=symbol)
        if cached is not None:
            return cached

    fp_interval = INTERVAL_MAP.get(interval, "15m")
    url = f"{HIST_BASE_URL}/{exch}/{exch_type}/{scrip_code}/{fp_interval}"
    hdrs = {
        "Authorization":             f"Bearer {access_token}",
        "Ocp-Apim-Subscription-Key": SUBSCRIPTION_KEY,
        "Content-Type":              "application/json",
    }
    resp = _session.get(url, params={"from": from_date, "end": to_date},
                        headers=hdrs, timeout=timeout)
    resp.raise_for_status()
    data = resp.json()
    candles_raw = data.get("data", {}).get("candles", [])
    candles = []
    for c in candles_raw:
        # c = [datetime_str, open, high, low, close, volume]
        if len(c) < 5:
            continue
        # Convert "YYYY-MM-DDTHH:MM:SS+05:30" (IST) → Unix UTC timestamp
        dt_str = c[0][:19]   # strip timezone suffix
        try:
            import calendar as _cal, datetime as _dt
            dt_ist = _dt.datetime.strptime(dt_str, "%Y-%m-%dT%H:%M:%S")
            # IST = UTC+5:30 → subtract 5h 30m to get UTC
            dt_utc = dt_ist - _dt.timedelta(hours=5, minutes=30)
            ts = int(_cal.timegm(dt_utc.timetuple()))
        except Exception:
            ts = dt_str
        row = {
            "time":   ts,
            "open":   float(c[1]),
            "high":   float(c[2]),
            "low":    float(c[3]),
            "close":  float(c[4]),
            "volume": int(c[5]) if len(c) > 5 else 0,
        }
        candles.append(row)

    if save_to_datafeed and dfs is not None and candles:
        try:
            dfs.save_candles(exch, exch_type, scrip_code, interval,
                             from_date, to_date, candles, symbol=symbol)
        except Exception:
            pass
    return candles


# ── Option chain / market feed / Greeks ───────────────────────

GREEKS_WS_URL = "wss://gateway.5paisa.com/openapi/greeks"


def get_expiry(user_key, client_code, access_token, exch, symbol):
    """Return sorted list of expiry date strings (YYYY-MM-DD) for an underlying."""
    payload = {
        "head": {"key": user_key},
        "body": {
            "ClientCode": client_code,
            "Exch": exch,
            "Symbol": symbol,
        },
    }
    resp = _session.post(
        f"{BASE_URL}/V2/GetExpiryForSymbolOptions",
        json=payload,
        headers=_headers(access_token),
        timeout=20,
    )
    resp.raise_for_status()
    body = resp.json().get("body", {}) or {}
    raw = body.get("Expiry") or body.get("ExpiryDate") or []
    out = []
    for item in raw:
        # API may return ms timestamps or /Date(ms)/ strings
        ms = None
        if isinstance(item, (int, float)):
            ms = int(item)
        elif isinstance(item, str):
            s = item.strip()
            if s.startswith("/Date("):
                try:
                    ms = int(s[6:].split(")")[0].split("+")[0].split("-")[0])
                except Exception:
                    ms = None
            elif s.isdigit():
                ms = int(s)
            elif len(s) >= 10 and s[4] == "-":
                out.append(s[:10])
                continue
        if ms is not None:
            import datetime as _dt
            out.append(_dt.datetime.fromtimestamp(ms / 1000.0, _dt.timezone.utc).strftime("%Y-%m-%d"))
    # unique sorted
    seen = set()
    dates = []
    for d in sorted(out):
        if d not in seen:
            seen.add(d)
            dates.append(d)
    return dates


def get_options_for_symbol(user_key, client_code, access_token, exch, symbol, expiry_ms):
    """Call GetOptionsForSymbol. expiry_ms is Unix ms timestamp."""
    payload = {
        "head": {"key": user_key},
        "body": {
            "ClientCode": client_code,
            "Exch": exch,
            "Symbol": symbol,
            "ExpiryDate": "/Date({})/".format(int(expiry_ms)),
        },
    }
    resp = _session.post(
        f"{BASE_URL}/GetOptionsForSymbol",
        json=payload,
        headers=_headers(access_token),
        timeout=30,
    )
    resp.raise_for_status()
    return resp.json().get("body", {}) or {}


def market_feed(user_key, client_code, access_token, instruments):
    """
    Fetch last traded quotes via MarketSnapshot (includes OI / volume / change).
    instruments: list of {exch, exch_type, scrip_code}
    Returns dict keyed by str(scrip_code) -> quote fields.
    """
    feed = []
    for inst in instruments:
        code = inst.get("scrip_code", "")
        try:
            code_val = int(str(code).strip())
        except (TypeError, ValueError):
            code_val = str(code).strip()
        if code_val == "" or code_val is None:
            continue
        feed.append({
            "Exchange": str(inst.get("exch", "N")),
            "ExchangeType": str(inst.get("exch_type", "D")),
            "ScripCode": code_val,
            "ScripData": "",
        })
    if not feed:
        return {}

    out = {}
    chunk_size = 40
    for i in range(0, len(feed), chunk_size):
        chunk = feed[i:i + chunk_size]
        payload = {
            "head": {"key": user_key},
            "body": {
                "ClientCode": client_code or "",
                "Data": chunk,
            },
        }
        resp = _session.post(
            f"{BASE_URL}/MarketSnapshot",
            json=payload,
            headers=_headers(access_token),
            timeout=25,
        )
        resp.raise_for_status()
        body = resp.json().get("body", {}) or {}
        data = body.get("Data")
        if not data:
            # Fallback to V1/MarketFeed (no OI) if snapshot fails
            mf_chunk = [{
                "Exch": x["Exchange"],
                "ExchType": x["ExchangeType"],
                "ScripCode": x["ScripCode"],
                "ScripData": "",
            } for x in chunk]
            mf_payload = {
                "head": {"key": user_key},
                "body": {
                    "MarketFeedData": mf_chunk,
                    "LastRequestTime": "/Date(0)/",
                    "RefreshRate": "H",
                },
            }
            mf_resp = _session.post(
                f"{BASE_URL}/V1/MarketFeed",
                json=mf_payload,
                headers=_headers(access_token),
                timeout=25,
            )
            mf_resp.raise_for_status()
            data = (mf_resp.json().get("body") or {}).get("Data") or []
        if isinstance(data, dict):
            data = [data]
        for row in data:
            token = str(row.get("ScripCode") or row.get("Token") or "")
            if not token:
                continue
            ltp = _to_float(
                row.get("LastTradedPrice") or row.get("LastRate") or row.get("LTP")
            )
            pclose = _to_float(row.get("PClose") or row.get("PreviousClose"))
            if ltp is None or ltp == 0:
                ltp = pclose
            chg = _to_float(row.get("NetChange") or row.get("Chg"))
            if chg is None and ltp is not None and pclose:
                chg = ltp - pclose
            chg_pct = None
            if chg is not None and pclose:
                chg_pct = (chg / pclose) * 100.0
            elif row.get("ChgPcnt") is not None:
                chg_pct = _to_float(row.get("ChgPcnt"))
            out[token] = {
                "ltp": ltp,
                "open": _to_float(row.get("Open")),
                "high": _to_float(row.get("High")),
                "low": _to_float(row.get("Low")),
                "prev_close": pclose,
                "chg": chg,
                "chg_pct": chg_pct,
                "volume": _to_float(row.get("Volume") or row.get("TotalQty")),
                "oi": _to_float(row.get("OpenInterest") or row.get("OI")),
                "oi_chg_day": _to_float(
                    row.get("ChangeInOpenInterest")
                    or row.get("ChangeInOI")
                    or row.get("OIChange")
                    or row.get("ChgInOI")
                    or row.get("OIChg")
                    or row.get("ChangeinOpenInterest")
                ),
                "prev_oi": _to_float(
                    row.get("PreviousOpenInterest")
                    or row.get("PrevOpenInterest")
                    or row.get("PreviousOI")
                    or row.get("PrevOI")
                    or row.get("POI")
                ),
                "bid_qty": _to_float(row.get("BuyQuantity") or row.get("TotalBuyQuantity")),
                "ask_qty": _to_float(row.get("SellQuantity") or row.get("TotalSellQuantity")),
                "avg_price": _to_float(row.get("AverageTradePrice")),
            }
            prev_oi = out[token]["prev_oi"]
            oi = out[token]["oi"]
            if out[token]["oi_chg_day"] is None and oi is not None and prev_oi is not None:
                out[token]["oi_chg_day"] = oi - prev_oi
    return out


def _to_float(v):
    try:
        if v is None or v == "":
            return None
        return float(v)
    except (TypeError, ValueError):
        return None


def fetch_greeks_snapshot(access_token, scrip_codes, wait_seconds=2.5):
    """
    Subscribe briefly to the NSE Option Greeks WebSocket and collect one
    snapshot per scrip. Returns {scrip_code: {iv, delta, theta, vega, gamma, ...}}.
    """
    try:
        import json as _json
        import time as _time
        import websocket
    except Exception:
        return {}

    codes = [str(c).strip() for c in scrip_codes if str(c).strip()]
    if not codes or not access_token:
        return {}

    results = {}
    url = "{}?access_token={}".format(GREEKS_WS_URL, access_token)
    done = {"closed": False}

    def _on_message(ws, message):
        try:
            data = _json.loads(message)
        except Exception:
            return
        rows = data if isinstance(data, list) else [data]
        for row in rows:
            token = str(row.get("Token") or row.get("token") or "")
            if not token:
                continue
            results[token] = {
                "iv": _to_float(row.get("IV")),
                "delta": _to_float(row.get("DELTA") or row.get("Delta")),
                "theta": _to_float(row.get("THETA") or row.get("Theta")),
                "vega": _to_float(row.get("VEGA") or row.get("Vega")),
                "gamma": _to_float(row.get("GAMMA") or row.get("Gamma")),
                "iv_vwap": _to_float(row.get("IV_VWAP")),
                "vanna": _to_float(row.get("VANNA")),
                "charm": _to_float(row.get("CHARM")),
                "speed": _to_float(row.get("SPEED")),
                "zomma": _to_float(row.get("ZOMMA")),
                "color": _to_float(row.get("COLOR")),
                "volga": _to_float(row.get("VOLGA")),
                "veta": _to_float(row.get("VETA")),
                "tgr": _to_float(row.get("TGR")),
                "tv": _to_float(row.get("TV")),
                "dtr": _to_float(row.get("DTR")),
            }

    def _on_open(ws):
        # Subscribe in chunks of 40
        for i in range(0, len(codes), 40):
            chunk = codes[i:i + 40]
            payload = {
                "Method": "Subscribe",
                "Operation": "optiongreek",
                "instruments": ["og{}".format(c) for c in chunk],
            }
            try:
                ws.send(_json.dumps(payload))
            except Exception:
                pass

    def _on_error(ws, error):
        pass

    def _on_close(ws, *args):
        done["closed"] = True

    ws = websocket.WebSocketApp(
        url,
        on_open=_on_open,
        on_message=_on_message,
        on_error=_on_error,
        on_close=_on_close,
    )
    import threading
    t = threading.Thread(
        target=lambda: ws.run_forever(sslopt={"cert_reqs": __import__("ssl").CERT_NONE}),
        daemon=True,
    )
    t.start()
    deadline = _time.time() + max(1.0, float(wait_seconds))
    while _time.time() < deadline:
        if len(results) >= min(len(codes), 1) and _time.time() > deadline - 0.5:
            break
        _time.sleep(0.1)
    try:
        ws.close()
    except Exception:
        pass
    return results
