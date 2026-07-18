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
# (required order in Python 3.6 to avoid the SSL conflict error)
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
    "60": "60m",
    "D":  "1d",
}


def download_scrip_master() -> list:
    """Download 5Paisa scrip master and return list of dicts (equity only)."""
    resp = _session.get(SCRIP_MASTER_URL, timeout=30)
    resp.raise_for_status()
    import csv, io
    reader = csv.DictReader(io.StringIO(resp.text))
    rows = []
    for row in reader:
        exch      = row["Exch"].strip()
        exch_type = row["ExchType"].strip()
        series    = row.get("Series", "").strip()
        scrip     = row["ScripCode"].strip()
        name      = row["Name"].strip()
        fullname  = row["FullName"].strip()
        sym_root  = row.get("SymbolRoot", "").strip()
        if not scrip:
            continue
        if exch == "M":
            if exch_type != "D":
                continue
            exch_label = "MCX_COM"
        elif exch_type in ("C", "D"):
            exch_label = ("NSE" if exch == "N" else "BSE") + ("_EQ" if exch_type == "C" else "_FNO")
        else:
            continue
        rows.append({
            "scrip_code":       scrip,
            "exch":             exch,
            "exch_type":        exch_type,
            "exchange_label":   exch_label,
            "trading_symbol":   name,
            "name":             fullname,
            "series":           series,
        })
    return rows


def get_historical_data(access_token: str, exch: str, exch_type: str,
                        scrip_code: str, interval: str,
                        from_date: str, to_date: str) -> list:
    """
    Fetch OHLCV candles from 5Paisa historical API.
    Returns list of {time, open, high, low, close, volume}.
    """
    fp_interval = INTERVAL_MAP.get(interval, "15m")
    url = f"{HIST_BASE_URL}/{exch}/{exch_type}/{scrip_code}/{fp_interval}"
    hdrs = {
        "Authorization":             f"Bearer {access_token}",
        "Ocp-Apim-Subscription-Key": SUBSCRIPTION_KEY,
        "Content-Type":              "application/json",
    }
    resp = _session.get(url, params={"from": from_date, "end": to_date},
                        headers=hdrs, timeout=20)
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
        candles.append({
            "time":   ts,
            "open":   float(c[1]),
            "high":   float(c[2]),
            "low":    float(c[3]),
            "close":  float(c[4]),
            "volume": int(c[5]) if len(c) > 5 else 0,
        })
    return candles

