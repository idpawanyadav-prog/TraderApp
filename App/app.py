import sys
import os

if sys.version_info < (3, 10):
    sys.exit("TraderApp requires Python 3.10 or newer (including 3.14).")

# Vendored ./libs (pip --target). Must process .pth / pywin32 DLLs or Excel COM fails.
import vendor_libs
libs_path = vendor_libs.setup()

import csv
import json
import socket
import time
import uuid
import pyotp
import requests as http
from datetime import datetime, timedelta, timezone
import threading
from flask import Flask, render_template, request, jsonify, session, make_response
from flask_socketio import SocketIO, emit, disconnect

# Broker modules — load best-effort so a broken/offline broker cannot block the app
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "broker"))


class _BrokerUnavailable:
    """Stand-in when a broker module fails to import. Calls raise RuntimeError."""

    def __init__(self, name, default_base_url=""):
        self._name = name
        self.DEFAULT_BASE_URL = default_base_url
        self.YAHOO_LIST_CSV = ""
        self.MAX_1M_DAYS = 8

    def __getattr__(self, name):
        def _missing(*args, **kwargs):
            raise RuntimeError(self._name + " broker is unavailable.")
        return _missing


try:
    import fivepaisa as fp
except Exception as e:
    print("5Paisa broker module failed to load (app will still start): " + str(e))
    fp = _BrokerUnavailable("5Paisa")

try:
    import yahoo as yf_broker
except Exception as e:
    print("Yahoo broker module failed to load (app will still start): " + str(e))
    yf_broker = _BrokerUnavailable(
        "Yahoo",
        "https://query1.finance.yahoo.com/v8/finance/chart/{YahooStockSymbol}"
        "?symbol={YahooStockSymbol}&period1={UTCStartDTM}&period2={UTCEndDTM}"
        "&useYfid=true&interval={Interval}",
    )

try:
    import excel as xl_broker
except Exception as e:
    print("Excel broker module failed to load (app will still start): " + str(e))
    xl_broker = _BrokerUnavailable("Excel")

# Analysis / services packages (Correlation Density screener)
from analysis.correlation_density import ScanParams
from analysis.pair_detail import compute_pair_detail
from services.pair_generator import load_sector_map
from services.scan_manager import ScanManager
from services.market_data import PriceCache
from services.pair_quotes import build_pair_live
from services.option_chain import list_underlyings, list_expiries, build_option_chain
from services.open_interest import build_oi_change
from services.gamma_exposure import build_gamma_exposure
from custom_indicators import catalog as py_ind_catalog, compute as py_ind_compute
from services.time_intervals import (
    RESAMPLE_OPTIONS,
    apply_interval_transform,
    combine_candles_to_interval,
    combine_overlays_to_interval,
    default_broker_intervals,
    native_catalog,
    normalize_all_intervals,
    normalize_broker_intervals,
    resolve_interval,
)

app = Flask(__name__)
_SECRET_FILE = os.path.join(os.path.dirname(__file__), ".flask_secret")
try:
    with open(_SECRET_FILE, "r") as _sf:
        _secret = _sf.read().strip()
except OSError:
    _secret = ""
if not _secret:
    _secret = os.urandom(24).hex()
    try:
        with open(_SECRET_FILE, "w") as _sf:
            _sf.write(_secret)
    except OSError:
        pass
app.secret_key = _secret
try:
    socketio = SocketIO(app, cors_allowed_origins="*", async_mode="threading")
except ValueError as e:
    sys.exit(
        "TraderApp failed to start Socket.IO (usually a missing package in App\\libs).\n"
        "Run Win\\install_libs.bat, then Win\\start_server.bat again.\n"
        "Details: " + str(e)
    )

# ---------- Live Feed (5Paisa WebSocket proxy) ----------
# Maps socket-session-id â†’ {scrip_code, exch, exch_type, interval}
_live_subs = {}   # protected by _live_lock
_live_lock  = threading.Lock()

def _fetch_latest_fp_candle(access_token, exch, exch_type, scrip_code, interval):
    """Fetch the latest candle from 5Paisa historical API."""
    today     = datetime.today()
    from_date = (today - timedelta(days=1)).strftime("%Y-%m-%d")
    to_date   = today.strftime("%Y-%m-%d")
    candles   = fp.get_historical_data(
        access_token, exch, exch_type, scrip_code, interval, from_date, to_date,
        save_to_datafeed=False, use_cache=False,
    )
    return candles[-1] if candles else None

def _live_feed_worker():
    """Background thread: poll 5Paisa every 5 s and push latest candle to subscribers."""
    while True:
        socketio.sleep(5)
        with _live_lock:
            subs_snapshot = dict(_live_subs)
        for sid, sub in subs_snapshot.items():
            try:
                creds        = load_credentials()
                access_token = creds.get("5paisa", {}).get("access_token", "").strip()
                if not access_token:
                    continue
                candle = _fetch_latest_fp_candle(
                    access_token, sub["exch"], sub["exch_type"],
                    sub["scrip_code"], sub["interval"]
                )
                if candle:
                    socketio.emit("price_update", candle, to=sid)
            except Exception:
                pass

@socketio.on("subscribe_live")
def on_subscribe_live(data):
    with _live_lock:
        _live_subs[request.sid] = data

@socketio.on("unsubscribe_live")
def on_unsubscribe_live():
    with _live_lock:
        _live_subs.pop(request.sid, None)

@socketio.on("disconnect")
def on_ws_disconnect():
    with _live_lock:
        _live_subs.pop(request.sid, None)

CRED_FILE       = os.path.join(os.path.dirname(__file__), "cred.json")
SETTINGS_FILE   = os.path.join(os.path.dirname(__file__), "settings.json")
INSTRUMENTS_CSV = os.path.join(os.path.dirname(__file__), "instruments.csv")
SECTOR_CSV      = os.path.join(os.path.dirname(__file__), "Sector.csv")

from services.datafeed_store import DATAFEED_DIR, INSTRUMENT_CSV as FP_INSTRUMENTS_CSV, ensure_datafeed_dir
ensure_datafeed_dir()

# Single global scan manager for the Correlation Density screener
_scan_manager = ScanManager()

# ---------- Instrument list (loaded once at startup) ----------

# Map CSV segment codes â†’ Dhan API exchangeSegment string
_SEG_MAP = {
    ("NSE", "E"): "NSE_EQ",
    ("BSE", "E"): "BSE_EQ",
    ("NSE", "D"): "NSE_FNO",
    ("BSE", "D"): "BSE_FNO",
    ("NSE", "C"): "NSE_CURRENCY",
    ("BSE", "C"): "BSE_CURRENCY",
    ("MCX", "M"): "MCX_COMM",
    ("",    "I"): "IDX_I",
}

_instruments = []   # list of dicts loaded at startup

def _load_instruments():
    global _instruments
    if not os.path.exists(INSTRUMENTS_CSV):
        return
    rows = []
    with open(INSTRUMENTS_CSV, encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row in reader:
            exch = row["SEM_EXM_EXCH_ID"].strip()
            seg  = row["SEM_SEGMENT"].strip()
            instr = row["SEM_INSTRUMENT_NAME"].strip()
            series = row["SEM_SERIES"].strip()
            sym  = row["SEM_TRADING_SYMBOL"].strip()
            custom = row["SEM_CUSTOM_SYMBOL"].strip()
            name = row["SM_SYMBOL_NAME"].strip()
            sid  = row["SEM_SMST_SECURITY_ID"].strip()
            exchange_segment = _SEG_MAP.get((exch, seg)) or _SEG_MAP.get(("", seg), "")
            if not exchange_segment or not sid:
                continue
            rows.append({
                "security_id":       sid,
                "exchange_segment":  exchange_segment,
                "instrument":        instr,
                "series":            series,
                "trading_symbol":    sym,
                "custom_symbol":     custom,
                "name":              name,
                "label":             f"{sym} â€” {name} [{exchange_segment}]",
            })
    _instruments = rows

_load_instruments()

# ---------- 5Paisa instrument list (loaded after connect) ----------
_fp_instruments = []
_fp_instruments_loading = False
_fp_instruments_last_loaded = None   # datetime or None

INSTRUMENT_CSV_MAX_AGE_DAYS = 7


def _instrument_csv_path():
    if os.path.exists(FP_INSTRUMENTS_CSV):
        return FP_INSTRUMENTS_CSV
    legacy = os.path.join(DATAFEED_DIR, "Instrument.csv")
    if os.path.exists(legacy):
        return legacy
    return None


def _instrument_csv_mtime():
    path = _instrument_csv_path()
    if not path:
        return None
    try:
        return os.path.getmtime(path)
    except OSError:
        return None


def _instrument_csv_is_stale(max_age_days=INSTRUMENT_CSV_MAX_AGE_DAYS):
    mtime = _instrument_csv_mtime()
    if mtime is None:
        return True
    return (time.time() - mtime) >= max_age_days * 86400


def _refresh_fp_instruments_async(force=False):
    global _fp_instruments_loading
    if _fp_instruments_loading:
        return
    _fp_instruments_loading = True
    threading.Thread(target=_load_fp_instruments, kwargs={"force": force}, daemon=True).start()


def _load_fp_instruments(force=False):
    """Load 5Paisa instruments from Instrument.csv in the app folder, downloading only when missing or force=True."""
    global _fp_instruments, _fp_instruments_loading, _fp_instruments_last_loaded
    _fp_instruments_loading = True
    try:
        # Migrate from older datafeed/Instrument.csv location if needed
        _legacy_df = os.path.join(DATAFEED_DIR, "Instrument.csv")
        if (not os.path.exists(FP_INSTRUMENTS_CSV)) and os.path.exists(_legacy_df):
            try:
                import shutil
                shutil.move(_legacy_df, FP_INSTRUMENTS_CSV)
            except Exception:
                pass
        from_cache = (not force) and os.path.exists(FP_INSTRUMENTS_CSV)
        _fp_instruments = fp.download_scrip_master(cache_path=FP_INSTRUMENTS_CSV, force=force)
        _fp_instruments_last_loaded = datetime.now(timezone.utc)
        src = "cache" if from_cache else "download"
        print("5Paisa scrip master loaded from " + src + ": " +
              str(len(_fp_instruments)) + " instruments (" + FP_INSTRUMENTS_CSV + ")")
    except Exception as e:
        _fp_instruments = []
        print("5Paisa scrip master load failed: " + str(e))
    finally:
        _fp_instruments_loading = False


def _startup_fp_instruments():
    """Parse cache / refresh scrip master off the server thread so Flask can bind immediately."""
    def _run():
        try:
            cached = (
                os.path.exists(FP_INSTRUMENTS_CSV)
                or os.path.exists(os.path.join(DATAFEED_DIR, "Instrument.csv"))
            )
            if cached:
                _load_fp_instruments(force=False)
            if _instrument_csv_is_stale():
                _load_fp_instruments(force=True)
        except Exception as e:
            print("5Paisa scrip master startup load failed: " + str(e))
    threading.Thread(target=_run, daemon=True, name="fp-scrip-master").start()


_startup_fp_instruments()


# ---------- Credential helpers ----------

def load_credentials() -> dict:
    """Load credentials from cred.json. Returns empty dict if file missing."""
    if not os.path.exists(CRED_FILE):
        return {}
    with open(CRED_FILE, "r") as f:
        return json.load(f)


def save_credentials(data: dict) -> None:
    """Persist credentials to cred.json."""
    existing = load_credentials()
    existing.update(data)
    with open(CRED_FILE, "w") as f:
        json.dump(existing, f, indent=2)


def _jwt_expiry(token):
    """Decode JWT payload (no sig verify) and return exp Unix timestamp, or None."""
    try:
        import base64 as _b64, json as _json
        payload = token.split(".")[1]
        payload += "=" * (4 - len(payload) % 4)
        data = _json.loads(_b64.urlsafe_b64decode(payload).decode("utf-8"))
        return data.get("exp")
    except Exception:
        return None


def _fp_valid_access_token():
    """Return a non-expired 5Paisa access token from cred.json, or empty string."""
    creds = load_credentials()
    c = creds.get("5paisa", {}) or {}
    token = (c.get("access_token") or "").strip()
    if not token:
        return ""
    exp = _jwt_expiry(token)
    if exp is None:
        exp = c.get("token_expiry") or 0
    try:
        exp = int(exp)
    except (TypeError, ValueError):
        exp = 0
    if exp and time.time() >= exp - 120:
        return ""
    return token


def _ensure_fp_session():
    """Treat a valid saved 5Paisa token as connected (Flask session is lost on restart)."""
    if not _fp_valid_access_token():
        session.pop("5paisa_connected", None)
        return False
    session["5paisa_connected"] = True
    return True


# ---------- App Settings helpers ----------

TA_CATALOG = {
    "sma": {
        "label": "SMA",
        "params": [{"name": "period", "default": 20, "min": 1, "max": 500}],
    },
    "ema": {
        "label": "EMA",
        "params": [{"name": "period", "default": 20, "min": 1, "max": 500}],
    },
    "rsi": {
        "label": "RSI",
        "params": [{"name": "period", "default": 14, "min": 2, "max": 100}],
    },
    "macd": {
        "label": "MACD",
        "params": [
            {"name": "fast", "default": 12, "min": 2, "max": 100},
            {"name": "slow", "default": 26, "min": 3, "max": 200},
            {"name": "signal", "default": 9, "min": 2, "max": 100},
        ],
    },
    "atr": {
        "label": "ATR",
        "params": [{"name": "period", "default": 14, "min": 1, "max": 200}],
    },
    "wma": {
        "label": "WMA",
        "params": [{"name": "period", "default": 20, "min": 1, "max": 500}],
    },
    "hma": {
        "label": "HMA",
        "params": [{"name": "period", "default": 21, "min": 2, "max": 500}],
    },
    "vwma": {
        "label": "VWMA",
        "params": [{"name": "period", "default": 20, "min": 1, "max": 500}],
    },
    "tema": {
        "label": "TEMA",
        "params": [{"name": "period", "default": 20, "min": 1, "max": 500}],
    },
    "dema": {
        "label": "DEMA",
        "params": [{"name": "period", "default": 20, "min": 1, "max": 500}],
    },
    "kama": {
        "label": "KAMA",
        "params": [
            {"name": "period", "default": 10, "min": 2, "max": 200},
            {"name": "fast", "default": 2, "min": 1, "max": 30},
            {"name": "slow", "default": 30, "min": 2, "max": 200},
        ],
    },
    "bbands": {
        "label": "Bollinger Bands",
        "params": [
            {"name": "period", "default": 20, "min": 2, "max": 500},
            {"name": "stddev", "default": 2, "min": 1, "max": 5},
        ],
    },
    "kc": {
        "label": "Keltner Channel",
        "params": [
            {"name": "period", "default": 20, "min": 2, "max": 500},
            {"name": "multiplier", "default": 2, "min": 1, "max": 5},
        ],
    },
    "donchian": {
        "label": "Donchian Channel",
        "params": [{"name": "period", "default": 20, "min": 2, "max": 500}],
    },
    "cci": {
        "label": "CCI",
        "params": [{"name": "period", "default": 20, "min": 2, "max": 300}],
    },
    "stoch": {
        "label": "Stochastic",
        "params": [
            {"name": "k", "default": 14, "min": 2, "max": 200},
            {"name": "d", "default": 3, "min": 1, "max": 50},
            {"name": "smooth", "default": 3, "min": 1, "max": 50},
        ],
    },
    "williamsr": {
        "label": "Williams %R",
        "params": [{"name": "period", "default": 14, "min": 2, "max": 200}],
    },
    "roc": {
        "label": "ROC",
        "params": [{"name": "period", "default": 12, "min": 1, "max": 200}],
    },
    "momentum": {
        "label": "Momentum",
        "params": [{"name": "period", "default": 10, "min": 1, "max": 200}],
    },
    "adx": {
        "label": "ADX",
        "params": [{"name": "period", "default": 14, "min": 2, "max": 200}],
    },
    "dmi": {
        "label": "DMI",
        "params": [{"name": "period", "default": 14, "min": 2, "max": 200}],
    },
    "psar": {
        "label": "Parabolic SAR",
        "params": [
            {"name": "step", "default": 2, "min": 1, "max": 20},
            {"name": "max_step", "default": 20, "min": 5, "max": 50},
        ],
    },
    "supertrend": {
        "label": "SuperTrend",
        "params": [
            {"name": "period", "default": 10, "min": 2, "max": 200},
            {"name": "multiplier", "default": 3, "min": 1, "max": 10},
        ],
    },
    "obv": {
        "label": "OBV",
        "params": [],
    },
    "mfi": {
        "label": "MFI",
        "params": [{"name": "period", "default": 14, "min": 2, "max": 200}],
    },
    "cmf": {
        "label": "CMF",
        "params": [{"name": "period", "default": 20, "min": 2, "max": 300}],
    },
    "vwap": {
        "label": "VWAP",
        "params": [],
    },
    "ichimoku": {
        "label": "Ichimoku",
        "params": [
            {"name": "tenkan", "default": 9, "min": 2, "max": 100},
            {"name": "kijun", "default": 26, "min": 2, "max": 200},
            {"name": "senkou", "default": 52, "min": 2, "max": 300},
        ],
    },
    "pivot": {
        "label": "Pivot Points",
        "params": [],
    },
    "trix": {
        "label": "TRIX",
        "params": [{"name": "period", "default": 15, "min": 2, "max": 300}],
    },
    "ppo": {
        "label": "PPO",
        "params": [
            {"name": "fast", "default": 12, "min": 2, "max": 100},
            {"name": "slow", "default": 26, "min": 3, "max": 200},
            {"name": "signal", "default": 9, "min": 2, "max": 100},
        ],
    },
    "ultimate": {
        "label": "Ultimate Oscillator",
        "params": [
            {"name": "short", "default": 7, "min": 2, "max": 50},
            {"name": "medium", "default": 14, "min": 3, "max": 100},
            {"name": "long", "default": 28, "min": 4, "max": 200},
        ],
    },
    "ao": {
        "label": "Awesome Oscillator",
        "params": [
            {"name": "fast", "default": 5, "min": 2, "max": 50},
            {"name": "slow", "default": 34, "min": 3, "max": 200},
        ],
    },
    "ac": {
        "label": "Accelerator Oscillator",
        "params": [
            {"name": "fast", "default": 5, "min": 2, "max": 50},
            {"name": "slow", "default": 34, "min": 3, "max": 200},
            {"name": "signal", "default": 5, "min": 2, "max": 100},
        ],
    },
    "stochrsi": {
        "label": "Stoch RSI",
        "params": [
            {"name": "rsi_period", "default": 14, "min": 2, "max": 200},
            {"name": "stoch_period", "default": 14, "min": 2, "max": 200},
            {"name": "k", "default": 3, "min": 1, "max": 50},
            {"name": "d", "default": 3, "min": 1, "max": 50},
        ],
    },
}

DEFAULT_OC_PRICE_FIELDS = [
    {"key": "oi", "label": "OI", "visible": True},
    {"key": "oi_chg", "label": "OI Chg", "visible": True},
    {"key": "interp", "label": "Int.", "visible": True},
    {"key": "volume", "label": "Volume", "visible": True},
    {"key": "chg", "label": "Chg", "visible": True},
    {"key": "chg_pct", "label": "Chg%", "visible": True},
    {"key": "ltp", "label": "LTP", "visible": True},
]

DEFAULT_OC_GREEKS_FIELDS = [
    {"key": "iv", "label": "IV", "visible": True},
    {"key": "delta", "label": "Delta", "visible": True},
    {"key": "gamma", "label": "Gamma", "visible": True},
    {"key": "theta", "label": "Theta", "visible": True},
    {"key": "vega", "label": "Vega", "visible": True},
    {"key": "rho", "label": "Rho", "visible": True},
    {"key": "vanna", "label": "Vanna", "visible": True},
    {"key": "charm", "label": "Charm", "visible": True},
    {"key": "volga", "label": "Volga", "visible": True},
    {"key": "iv_vwap", "label": "IV VWAP", "visible": True},
    {"key": "speed", "label": "Speed", "visible": True},
    {"key": "zomma", "label": "Zomma", "visible": True},
    {"key": "color", "label": "Color", "visible": True},
    {"key": "veta", "label": "Veta", "visible": True},
]

DEFAULT_APP_SETTINGS = {
    "api_enabled": False,
    "dhan_enabled": True,
    "5paisa_enabled": True,
    "yahoo_enabled": False,
    "yahoo_base_url": yf_broker.DEFAULT_BASE_URL,
    "excel_enabled": False,
    "excel_configs": [],
    "chart_refresh_interval": 0,
    "enabled_exchanges": ["N", "B", "M"],
    "enabled_exch_types": ["C", "D", "U"],
    "enabled_scrip_types": ["EQ", "XX", "OP"],
    "save_to_datafeed": False,
    "oc_price_fields": [dict(x) for x in DEFAULT_OC_PRICE_FIELDS],
    "oc_greeks_fields": [dict(x) for x in DEFAULT_OC_GREEKS_FIELDS],
    "ta_enabled": False,
    "ta_indicators": [],
    "chart_drawings": {},
    "broker_intervals": default_broker_intervals(),
}

VALID_EXCHANGES = {"N", "B", "M"}
VALID_EXCH_TYPES = {"C", "D", "U"}
VALID_SCRIP_TYPES = {"EQ", "XX", "OP"}  # OP = CE/PE Option
VALID_OC_PRICE_KEYS = {x["key"] for x in DEFAULT_OC_PRICE_FIELDS}
VALID_OC_GREEKS_KEYS = {x["key"] for x in DEFAULT_OC_GREEKS_FIELDS}


def _normalize_oc_fields(raw_fields, defaults, valid_keys):
    """Merge saved option-chain field prefs with defaults (order + visibility)."""
    label_by_key = {d["key"]: d["label"] for d in defaults}
    out = []
    seen = set()
    for item in (raw_fields or []):
        if not isinstance(item, dict):
            continue
        key = str(item.get("key") or "").strip()
        if key not in valid_keys or key in seen:
            continue
        seen.add(key)
        out.append({
            "key": key,
            "label": label_by_key.get(key, key),
            "visible": bool(item.get("visible", True)),
        })
    for d in defaults:
        if d["key"] not in seen:
            out.append({"key": d["key"], "label": d["label"], "visible": True})
    if not any(x["visible"] for x in out):
        out = [{"key": d["key"], "label": d["label"], "visible": True} for d in defaults]
    return out


def _normalize_option_chain_settings(s):
    return {
        "oc_price_fields": _normalize_oc_fields(
            s.get("oc_price_fields"), DEFAULT_OC_PRICE_FIELDS, VALID_OC_PRICE_KEYS
        ),
        "oc_greeks_fields": _normalize_oc_fields(
            s.get("oc_greeks_fields"), DEFAULT_OC_GREEKS_FIELDS, VALID_OC_GREEKS_KEYS
        ),
    }


def _normalize_market_settings(s):
    """Ensure market filter keys exist (migrate older settings shapes)."""
    exchanges = [x for x in (s.get("enabled_exchanges") or []) if x in VALID_EXCHANGES]
    # Prefer new key; fall back to legacy enabled_instrument_types
    raw_exch_types = s.get("enabled_exch_types")
    if raw_exch_types is None:
        raw_exch_types = s.get("enabled_instrument_types", ["C", "D", "U"])
    exch_types = [x for x in (raw_exch_types or []) if x in VALID_EXCH_TYPES]
    scrip_types = [x for x in (s.get("enabled_scrip_types") or []) if x in VALID_SCRIP_TYPES]
    return {
        "enabled_exchanges": exchanges or list(DEFAULT_APP_SETTINGS["enabled_exchanges"]),
        "enabled_exch_types": exch_types or list(DEFAULT_APP_SETTINGS["enabled_exch_types"]),
        "enabled_scrip_types": scrip_types or list(DEFAULT_APP_SETTINGS["enabled_scrip_types"]),
        "save_to_datafeed": bool(s.get("save_to_datafeed", False)),
    }


def _datafeed_opts():
    """Flags for historical downloads based on Enable Market checkbox."""
    save = bool(load_app_settings().get("save_to_datafeed", False))
    return {"save_to_datafeed": save, "use_cache": save}


def _scrip_type_matches(scrip_type, exch_type, enabled_scrip_types):
    """Match Instrument.csv ScripType against UI codes (OP=CE/PE; EQ includes cash XX)."""
    enabled = set(enabled_scrip_types or [])
    if not enabled:
        return False
    st = (scrip_type or "").strip().upper()
    et = (exch_type or "").strip().upper()
    if not st:
        # Older cached rows without ScripType — do not hide everything
        return True
    if st in ("CE", "PE"):
        return "OP" in enabled
    if st == "EQ":
        return "EQ" in enabled
    if st == "XX":
        # Cash XX rows are equity-like in 5Paisa master; D/U XX are futures
        if et == "C":
            return "EQ" in enabled
        return "XX" in enabled
    return False


def _market_allowed(inst, markets=None):
    """True if instrument passes Enable Market filters."""
    m = markets or _normalize_market_settings(load_app_settings())
    if inst.get("exch") not in m["enabled_exchanges"]:
        return False
    if inst.get("exch_type") not in m["enabled_exch_types"]:
        return False
    return _scrip_type_matches(
        inst.get("scrip_type", ""),
        inst.get("exch_type", ""),
        m["enabled_scrip_types"],
    )

def load_app_settings() -> dict:
    s = None
    if os.path.exists(SETTINGS_FILE):
        try:
            with open(SETTINGS_FILE, "r", encoding="utf-8") as f:
                raw = f.read().strip()
            if raw:
                parsed = json.loads(raw)
                if isinstance(parsed, dict):
                    s = parsed
        except (json.JSONDecodeError, OSError, TypeError, ValueError):
            s = None
    if s is None:
        s = dict(DEFAULT_APP_SETTINGS)
        s["api_key"] = str(uuid.uuid4())
        try:
            with open(SETTINGS_FILE, "w", encoding="utf-8") as f:
                json.dump(s, f, indent=2)
        except OSError:
            pass
        return s
    for k, v in DEFAULT_APP_SETTINGS.items():
        if k not in s:
            s[k] = v
    if "api_key" not in s:
        s["api_key"] = str(uuid.uuid4())
    s["broker_intervals"] = normalize_all_intervals(s.get("broker_intervals"))
    return s


def save_app_settings(data: dict) -> None:
    existing = load_app_settings()
    existing.update(data)
    tmp = SETTINGS_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(existing, f, indent=2)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, SETTINGS_FILE)


# ---------- Public API helpers ----------

def _cors(response):
    """Add CORS headers to allow external apps to call the public API."""
    response.headers["Access-Control-Allow-Origin"]  = "*"
    response.headers["Access-Control-Allow-Headers"] = "X-API-Key, Content-Type"
    response.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
    return response


def _check_api_enabled():
    """Return (ok, error_response). Validates that API access is enabled."""
    s = load_app_settings()
    if not s.get("api_enabled"):
        r = make_response(jsonify({"error": "API access is disabled. Enable it in Settings."}), 403)
        return False, _cors(r)
    return True, None


# ---------- TOTP ----------

def generate_totp(secret: str) -> str:
    """Generate current TOTP code from a base-32 secret."""
    totp = pyotp.TOTP(secret)
    return totp.now()


# ---------- Dhan broker helper ----------

DHAN_BASE_URL = "https://api.dhan.co/v2"

def dhan_get(endpoint: str, access_token: str, client_id: str = "") -> dict:
    """Make an authenticated GET request to the Dhan REST API."""
    headers = {
        "access-token": access_token,
        "Content-type": "application/json",
        "Accept":       "application/json",
    }
    if client_id:
        headers["client-id"] = client_id
    resp = http.get(f"{DHAN_BASE_URL}{endpoint}", headers=headers, timeout=10)
    resp.raise_for_status()
    return resp.json()


# ---------- Routes ----------

@app.route("/")
def index():
    creds = load_credentials()
    dhan_creds = creds.get("dhan", {})
    connected       = session.get("dhan_connected", False)
    dhan_user       = session.get("dhan_user", {})
    fp_connected    = _ensure_fp_session()
    fp_user         = session.get("5paisa_user", {})
    fp_creds        = creds.get("5paisa", {})
    app_s           = load_app_settings()
    yahoo_enabled   = bool(app_s.get("yahoo_enabled"))
    excel_enabled   = bool(app_s.get("excel_enabled"))
    dhan_enabled    = app_s.get("dhan_enabled", True) is not False
    fp_enabled      = app_s.get("5paisa_enabled", True) is not False
    yahoo_base_url  = (app_s.get("yahoo_base_url") or yf_broker.DEFAULT_BASE_URL).strip() or yf_broker.DEFAULT_BASE_URL
    return render_template(
        "index.html",
        client_id=dhan_creds.get("client_id", ""),
        dhan_access_token=dhan_creds.get("access_token", ""),
        totp_secret=dhan_creds.get("totp_secret", ""),
        connected=connected,
        dhan_user=dhan_user,
        fp_connected=fp_connected,
        fp_user=fp_user,
        fp_email=fp_creds.get("email", ""),
        fp_client_code=fp_creds.get("client_code", ""),
        fp_user_key=fp_creds.get("user_key", ""),
        fp_user_id=fp_creds.get("user_id", ""),
        fp_pin=fp_creds.get("pin", ""),
        fp_encryption_key=fp_creds.get("encryption_key", ""),
        fp_totp_secret=fp_creds.get("totp_secret", ""),
        fp_access_token=fp_creds.get("access_token", ""),
        fp_token_expiry_dt=fp_creds.get("token_expiry_dt", ""),
        yahoo_enabled=yahoo_enabled,
        yahoo_base_url=yahoo_base_url,
        excel_enabled=excel_enabled,
        dhan_enabled=dhan_enabled,
        fp_enabled=fp_enabled,
    )


@app.route("/api/dhan/save-credentials", methods=["POST"])
def save_dhan_credentials():
    """Save Dhan credentials (client_id, access_token, totp_secret) to cred.json."""
    payload = request.get_json(force=True)
    client_id = payload.get("client_id", "").strip()
    access_token = payload.get("access_token", "").strip()
    totp_secret = payload.get("totp_secret", "").strip()

    if not client_id or not access_token:
        return jsonify({"success": False, "message": "Client ID and Access Token are required."}), 400

    save_credentials({
        "dhan": {
            "client_id": client_id,
            "access_token": access_token,
            "totp_secret": totp_secret,
        }
    })
    return jsonify({"success": True, "message": "Credentials saved successfully."})


@app.route("/api/dhan/generate-totp", methods=["GET"])
def api_generate_totp():
    """Return the current TOTP code using the stored secret."""
    creds = load_credentials()
    secret = creds.get("dhan", {}).get("totp_secret", "").strip()
    if not secret:
        return jsonify({"success": False, "message": "TOTP secret not configured."}), 400
    try:
        code = generate_totp(secret)
        totp_obj = pyotp.TOTP(secret)
        remaining = totp_obj.interval - (int(time.time()) % totp_obj.interval)
        return jsonify({"success": True, "totp": code, "remaining_seconds": remaining})
    except Exception as e:
        return jsonify({"success": False, "message": f"Invalid TOTP secret: {e}"}), 400


@app.route("/api/dhan/connect", methods=["POST"])
def dhan_connect():
    """Test connection to Dhan broker using stored / provided credentials."""
    creds = load_credentials()
    dhan_creds = creds.get("dhan", {})
    client_id = dhan_creds.get("client_id", "").strip()
    access_token = dhan_creds.get("access_token", "").strip()

    if not client_id or not access_token:
        return jsonify({"success": False, "message": "Credentials not found. Please save credentials first."}), 400

    try:
        fund = dhan_get("/fundlimit", access_token, client_id)

        # Fetch user profile using dhan_login.user_profile equivalent
        profile = {}
        try:
            profile = dhan_get("/profile", access_token, client_id)
        except Exception:
            pass

        session["dhan_connected"] = True
        session["dhan_user"] = {
            "client_id":          profile.get("dhanClientId", client_id),
            "token_validity":     profile.get("tokenValidity", ""),
            "active_segment":     profile.get("activeSegment", ""),
            "ddpi":               profile.get("ddpi", ""),
            "mtf":                profile.get("mtf", ""),
            "data_plan":          profile.get("dataPlan", ""),
            "data_validity":      profile.get("dataValidity", ""),
            "available_balance":  fund.get("availabelBalance", ""),
            "utilized_amount":    fund.get("utilizedAmount", ""),
            "withdrawable":       fund.get("withdrawableBalance", ""),
            "collateral":         fund.get("collateralAmount", ""),
        }
        return jsonify({
            "success": True,
            "message": "Connected to Dhan successfully!",
            "user": session["dhan_user"],
        })
    except http.exceptions.HTTPError as e:
        session["dhan_connected"] = False
        status = e.response.status_code if e.response is not None else 500
        msg = "Invalid credentials." if status in (401, 403) else f"Dhan API error: {e}"
        return jsonify({"success": False, "message": msg}), status
    except Exception as e:
        session["dhan_connected"] = False
        return jsonify({"success": False, "message": f"Connection error: {e}"}), 500


@app.route("/api/dhan/disconnect", methods=["POST"])
def dhan_disconnect():
    session.pop("dhan_connected", None)
    session.pop("dhan_user", None)
    return jsonify({"success": True, "message": "Disconnected from Dhan."})


# â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
#  5Paisa Broker Routes
# â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

@app.route("/api/5paisa/save-credentials", methods=["POST"])
def save_5paisa_credentials():
    payload = request.get_json(force=True)
    required = ["user_key", "encryption_key", "user_id", "client_code", "pin"]
    for field in required:
        if not payload.get(field, "").strip():
            return jsonify({"success": False, "message": field + " is required."}), 400
    save_credentials({
        "5paisa": {
            "email":          payload.get("email", "").strip(),
            "user_key":       payload["user_key"].strip(),
            "encryption_key": payload["encryption_key"].strip(),
            "user_id":        payload["user_id"].strip(),
            "client_code":    payload["client_code"].strip(),
            "pin":            payload["pin"].strip(),
            "totp_secret":    payload.get("totp_secret", "").strip(),
            "access_token":   payload.get("access_token", "").strip(),
            "token_expiry":   None,
            "token_expiry_dt": "",
        }
    })
    return jsonify({"success": True, "message": "5Paisa credentials saved."})


@app.route("/api/5paisa/generate-totp", methods=["GET"])
def api_5paisa_generate_totp():
    creds = load_credentials()
    secret = creds.get("5paisa", {}).get("totp_secret", "").strip()
    if not secret:
        return jsonify({"success": False, "message": "TOTP secret not configured."}), 400
    try:
        clean = secret.upper().replace(" ", "")
        totp_obj = pyotp.TOTP(clean)
        now_ts = int(time.time())
        code = totp_obj.at(now_ts)
        remaining = totp_obj.interval - (now_ts % totp_obj.interval)
        # Show adjacent codes so user can compare with their authenticator app
        prev_code = totp_obj.at(now_ts - 30)
        next_code = totp_obj.at(now_ts + 30)
        return jsonify({
            "success": True,
            "totp": code,
            "remaining_seconds": remaining,
            "prev": prev_code,
            "next": next_code,
            "secret_normalized": clean[:4] + "****",
        })
    except Exception as e:
        return jsonify({"success": False, "message": "Invalid TOTP secret: " + str(e)}), 400


@app.route("/api/5paisa/connect", methods=["POST"])
def fivepaisa_connect():
    creds = load_credentials()
    c = creds.get("5paisa", {})
    email          = c.get("email", "").strip()
    user_key       = c.get("user_key", "").strip()
    encryption_key = c.get("encryption_key", "").strip()
    user_id        = c.get("user_id", "").strip()
    client_code    = c.get("client_code", "").strip()
    pin            = c.get("pin", "").strip()
    totp_secret    = c.get("totp_secret", "").strip()
    # Email is optional; fall back to client_code for Email_ID if not set
    email_id       = email if email else client_code

    if not all([user_key, encryption_key, user_id, client_code, pin]):
        return jsonify({"success": False,
                        "message": "Credentials incomplete. Please save all 5Paisa credentials first."}), 400

    import time as _time

    def _finish_connect(access_token, token_reused=False):
        """Save token, load instruments, fetch margin, set session."""
        exp = _jwt_expiry(access_token)
        c["access_token"]   = access_token
        c["token_expiry"]   = exp
        c["token_expiry_dt"] = (datetime.fromtimestamp(exp, timezone.utc).strftime("%Y-%m-%d %H:%M UTC") if exp else "unknown")
        save_credentials({"5paisa": c})

        # Reuse cache unless missing or Instrument.csv is older than a week
        if _instrument_csv_is_stale():
            _refresh_fp_instruments_async(force=True)
        elif not _fp_instruments:
            _refresh_fp_instruments_async(force=False)

        try:
            margin = fp.get_margin(user_key, client_code, access_token) or {}
        except Exception:
            margin = {}
        session["5paisa_connected"] = True
        session["5paisa_user"] = {
            "client_code":    client_code,
            "net_available":  margin.get("NetAvailableMargin", margin.get("AvailableMargin", "")),
            "utilized_margin": margin.get("MarginUtilized", ""),
            "collateral":     margin.get("Collateral", ""),
            "adhoc_margin":   margin.get("AdhocMargin", ""),
            "payin_amount":   margin.get("PayinAmount", ""),
            "payout_amount":  margin.get("PayoutAmount", ""),
        }
        return jsonify({
            "success":      True,
            "message":      "Reconnected using saved token." if token_reused else "Connected to 5Paisa successfully!",
            "token_reused": token_reused,
            "token_expiry": c["token_expiry_dt"],
            "user":         session["5paisa_user"],
        })

    try:
        # ── Try reusing existing token if not expired ──────────────────────
        existing_token = c.get("access_token", "").strip()
        if existing_token:
            exp = _jwt_expiry(existing_token) or c.get("token_expiry", 0)
            if exp and _time.time() < exp - 120:   # valid with 2-min buffer
                try:
                    return _finish_connect(existing_token, token_reused=True)
                except Exception:
                    pass  # token rejected — fall through to fresh auth

        # ── Fresh TOTP authentication ──────────────────────────────────────
        totp_code    = request.get_json(force=True).get("totp", "").strip()
        clean_secret = totp_secret.upper().replace(" ", "") if totp_secret else ""

        if not totp_code and not clean_secret:
            return jsonify({"success": False,
                            "message": "TOTP code required. Provide totp_secret in credentials or pass totp in request."}), 400

        req_token = None
        last_err  = None

        if clean_secret:
            now_ts   = int(_time.time())
            totp_obj = pyotp.TOTP(clean_secret)
            for offset in (0, -30, 30, -60, 60):
                candidate = totp_obj.at(now_ts + offset)
                try:
                    req_token = fp.get_request_token(user_key, email_id, candidate, pin)
                    break
                except Exception as e:
                    last_err = e
            if req_token is None:
                raise last_err
        else:
            req_token = fp.get_request_token(user_key, email_id, totp_code, pin)

        access_token = fp.get_access_token(user_key, user_id, encryption_key, req_token)
        return _finish_connect(access_token, token_reused=False)

    except http.exceptions.HTTPError as e:
        session["5paisa_connected"] = False
        try:
            msg = e.response.json().get("message") or str(e)
        except Exception:
            msg = str(e)
        return jsonify({"success": False, "message": msg}), e.response.status_code if e.response else 500
    except Exception as e:
        session["5paisa_connected"] = False
        hint = (
            "Error: " + str(e) +
            " | Sent \u2192 Email_ID: '" + (email_id[:4] + "***" if len(email_id) > 4 else email_id) + "'" +
            "  client_code: '" + (client_code[:3] + "***" if len(client_code) > 3 else client_code) + "'" +
            "  PIN length: " + str(len(pin)) +
            "  user_key prefix: " + (user_key[:4] + "..." if user_key else "EMPTY") +
            "  user_id prefix: " + (user_id[:4] + "..." if user_id else "EMPTY")
        )
        return jsonify({"success": False, "message": hint}), 500


@app.route("/api/5paisa/disconnect", methods=["POST"])
def fivepaisa_disconnect():
    session.pop("5paisa_connected", None)
    session.pop("5paisa_user", None)
    return jsonify({"success": True, "message": "Disconnected from 5Paisa."})


@app.route("/api/5paisa/scrip-master/status", methods=["GET"])
def scrip_master_status():
    mtime = _instrument_csv_mtime()
    age_days = ((time.time() - mtime) / 86400.0) if mtime is not None else None
    return jsonify({
        "loaded":       len(_fp_instruments) > 0,
        "count":        len(_fp_instruments),
        "loading":      _fp_instruments_loading,
        "last_loaded":  _fp_instruments_last_loaded.strftime("%Y-%m-%d %H:%M UTC") if _fp_instruments_last_loaded else None,
        "cache_file":   "Instrument.csv",
        "cache_exists": os.path.exists(FP_INSTRUMENTS_CSV),
        "cache_mtime":  datetime.fromtimestamp(mtime, timezone.utc).strftime("%Y-%m-%d %H:%M UTC") if mtime else None,
        "cache_age_days": round(age_days, 2) if age_days is not None else None,
        "stale":        _instrument_csv_is_stale(),
        "max_age_days": INSTRUMENT_CSV_MAX_AGE_DAYS,
        "datafeed_dir": DATAFEED_DIR,
    })


@app.route("/api/5paisa/scrip-master/update", methods=["POST"])
def scrip_master_update():
    creds        = load_credentials()
    access_token = creds.get("5paisa", {}).get("access_token", "").strip()
    if not access_token:
        return jsonify({"success": False, "message": "5Paisa not connected. Connect first to update scrip master."}), 400
    if _fp_instruments_loading:
        return jsonify({"success": False, "message": "Already loading scrip master, please wait..."}), 409
    _refresh_fp_instruments_async(force=True)
    return jsonify({"success": True, "message": "Scrip master update started — saving Instrument.csv in the app folder."})


# ---------- Instrument Search ----------

@app.route("/api/instruments/search")
def instruments_search():
    q = request.args.get("q", "").strip().upper()
    limit = int(request.args.get("limit", 15))
    if len(q) < 2:
        return jsonify([])

    def score(i):
        sym  = i["trading_symbol"].upper()
        eq   = i["exchange_segment"] in ("NSE_EQ", "BSE_EQ")
        nse  = i["exchange_segment"] == "NSE_EQ"
        exact = sym == q
        starts = sym.startswith(q)
        return (0 if exact else 1 if starts else 2, 0 if nse else 1 if eq else 2)

    results = [
        i for i in _instruments
        if q in i["trading_symbol"].upper() or q in i["name"].upper()
    ]
    results.sort(key=score)
    return jsonify(results[:limit])


@app.route("/api/5paisa/current-price", methods=["GET"])
def get_current_price():
    """Get the current price for a specific instrument."""
    if not _ensure_fp_session():
        return jsonify({"success": False, "message": "Not connected to 5Paisa."}), 400
    
    # Get parameters
    symbol = request.args.get("symbol", "").upper()
    if not symbol:
        return jsonify({"success": False, "message": "Symbol is required."}), 400
    
    # Instrument to scrip code mapping
    scrip_mapping = {
        "NIFTY": {"scrip_code": "26000", "exch": "N", "exch_type": "D"},
        "BANKNIFTY": {"scrip_code": "26009", "exch": "N", "exch_type": "D"},
        "FINNIFTY": {"scrip_code": "35007", "exch": "N", "exch_type": "D"},
        "RELIANCE": {"scrip_code": "2885", "exch": "N", "exch_type": "C"},
        "INFY": {"scrip_code": "11190", "exch": "N", "exch_type": "C"},
        "HDFCBANK": {"scrip_code": "1349", "exch": "N", "exch_type": "C"}
    }
    
    # Check if symbol is supported
    if symbol not in scrip_mapping:
        return jsonify({"success": False, "message": f"Unsupported symbol: {symbol}"}), 400
    
    # Get scrip details
    scrip_details = scrip_mapping[symbol]
    scrip_code = scrip_details["scrip_code"]
    exch = scrip_details["exch"]
    exch_type = scrip_details["exch_type"]
    
    # Get access token
    creds = load_credentials()
    access_token = creds.get("5paisa", {}).get("access_token", "")
    if not access_token:
        return jsonify({"success": False, "message": "Access token not available."}), 400
    
    try:
        # Fetch latest candle data (1-minute interval for most current price)
        today = datetime.today()
        from_date = (today - timedelta(days=1)).strftime("%Y-%m-%d")
        to_date = today.strftime("%Y-%m-%d")
        
        candles = fp.get_historical_data(
            access_token, exch, exch_type, scrip_code, "1", from_date, to_date,
            symbol=symbol, **_datafeed_opts(),
        )
        
        if not candles:
            return jsonify({"success": False, "message": "No price data available."}), 400
        
        # Get the latest candle (most recent price)
        latest_candle = candles[-1]
        current_price = latest_candle["close"]
        
        return jsonify({
            "success": True,
            "symbol": symbol,
            "price": current_price,
            "timestamp": latest_candle["time"]
        })
    except Exception as e:
        return jsonify({"success": False, "message": f"Failed to fetch price: {str(e)}"}), 500


# ---------- Chart Data ----------

def _interval_cfg(broker, interval_id):
    return resolve_interval(load_app_settings(), broker, interval_id)


def _chart_default_from(interval, broker="5paisa"):
    cfg = _interval_cfg(broker, interval)
    days = int(cfg.get("days") or 10)
    return (datetime.today() - timedelta(days=days)).strftime("%Y-%m-%d")


def _dhan_parse_candles(data):
    timestamps = data.get("timestamp", [])
    opens = data.get("open", [])
    highs = data.get("high", [])
    lows = data.get("low", [])
    closes = data.get("close", [])
    volumes = data.get("volume", [])
    candles = []
    for i, ts in enumerate(timestamps):
        candles.append({
            "time": ts,
            "open": opens[i] if i < len(opens) else 0,
            "high": highs[i] if i < len(highs) else 0,
            "low": lows[i] if i < len(lows) else 0,
            "close": closes[i] if i < len(closes) else 0,
            "volume": volumes[i] if i < len(volumes) else 0,
        })
    return candles


@app.route("/api/chart/data", methods=["POST"])
def chart_data():
    if not session.get("dhan_connected"):
        return jsonify({"success": False, "message": "Not connected. Please connect to Dhan first."}), 401

    creds = load_credentials()
    dhan_creds = creds.get("dhan", {})
    access_token = dhan_creds.get("access_token", "").strip()
    client_id    = dhan_creds.get("client_id", "").strip()

    payload      = request.get_json(force=True)
    security_id  = payload.get("security_id", "").strip()
    exch_seg     = payload.get("exchange_segment", "NSE_EQ").strip()
    instrument   = payload.get("instrument", "EQUITY").strip()
    interval     = payload.get("interval", "1")
    from_date    = payload.get("from_date", "")
    to_date      = payload.get("to_date", "")
    cfg          = _interval_cfg("dhan", interval)
    source       = cfg.get("source") or interval

    if not security_id:
        return jsonify({"success": False, "message": "security_id is required."}), 400

    today = datetime.today()
    if not to_date:
        to_date = today.strftime("%Y-%m-%d")
    if not from_date:
        from_date = _chart_default_from(interval, "dhan")

    headers = {
        "access-token":  access_token,
        "client-id":     client_id,
        "Content-type":  "application/json",
        "Accept":        "application/json",
    }

    try:
        if source == "D":
            body = {
                "dhanClientId":    client_id,
                "securityId":      security_id,
                "exchangeSegment": exch_seg,
                "instrument":      instrument,
                "expiryCode":      0,
                "fromDate":        from_date,
                "toDate":          to_date,
            }
            resp = http.post(f"{DHAN_BASE_URL}/charts/historical",
                             json=body, headers=headers, timeout=30)
        else:
            body = {
                "dhanClientId":    client_id,
                "securityId":      security_id,
                "exchangeSegment": exch_seg,
                "instrument":      instrument,
                "interval":        int(source),
                "fromDate":        from_date,
                "toDate":          to_date,
            }
            resp = http.post(f"{DHAN_BASE_URL}/charts/intraday",
                             json=body, headers=headers, timeout=30)

        resp.raise_for_status()
        candles = apply_interval_transform(_dhan_parse_candles(resp.json()), cfg, _filter_market_hours)
        return jsonify({"success": True, "candles": candles, "count": len(candles)})

    except http.exceptions.HTTPError as e:
        status = e.response.status_code if e.response is not None else 500
        # Try to extract Dhan's error message from the response body
        try:
            err_body = e.response.json()
            dhan_msg = err_body.get("errorMessage") or err_body.get("message") or str(e)
            err_code = err_body.get("errorCode", "")
        except Exception:
            dhan_msg = str(e)
            err_code = ""
        return jsonify({"success": False, "message": dhan_msg, "error_code": err_code}), status
    except Exception as e:
        return jsonify({"success": False, "message": str(e)}), 500


# ---------- 5Paisa Instrument Search ----------

@app.route("/api/5paisa/instruments/search")
def fp_instruments_search():
    q = request.args.get("q", "").strip().upper()
    limit = int(request.args.get("limit", 15))
    if len(q) < 2:
        return jsonify([])
    if not _fp_instruments:
        return jsonify({"error": "Scrip master not loaded. Connect to 5Paisa first."}), 503

    markets = _normalize_market_settings(load_app_settings())

    def score(i):
        sym   = i["trading_symbol"].upper()
        nse   = i["exch"] == "N" and i["exch_type"] == "C"
        exact = sym == q
        starts = sym.startswith(q)
        return (0 if exact else 1 if starts else 2, 0 if nse else 1)

    results = [
        i for i in _fp_instruments
        if _market_allowed(i, markets)
        and (q in i["trading_symbol"].upper() or q in i["name"].upper())
    ]
    results.sort(key=score)
    return jsonify(results[:limit])


# ---------- 5Paisa Chart Data ----------

@app.route("/api/5paisa/chart/data", methods=["POST"])
def fp_chart_data():
    if not _ensure_fp_session():
        return jsonify({"success": False, "message": "Not connected. Please connect to 5Paisa first."}), 401

    creds       = load_credentials()
    c           = creds.get("5paisa", {})
    access_token = c.get("access_token", "").strip()
    if not access_token:
        return jsonify({"success": False, "message": "No access token. Please reconnect to 5Paisa."}), 401

    payload    = request.get_json(force=True)
    scrip_code = payload.get("scrip_code", "").strip()
    exch       = payload.get("exch", "N").strip()
    exch_type  = payload.get("exch_type", "C").strip()
    interval   = payload.get("interval", "15")
    from_date  = payload.get("from_date", "")
    to_date    = payload.get("to_date", "")
    symbol     = (payload.get("trading_symbol") or payload.get("symbol") or "").strip()
    cfg        = _interval_cfg("5paisa", interval)
    source     = cfg.get("source") or interval

    if not scrip_code:
        return jsonify({"success": False, "message": "scrip_code is required."}), 400

    if not symbol:
        symbol = _symbol_for_scrip(scrip_code, exch, exch_type)

    today = datetime.today()
    if not to_date:
        to_date = today.strftime("%Y-%m-%d")
    if not from_date:
        from_date = _chart_default_from(interval, "5paisa")

    try:
        candles = fp.get_historical_data(
            access_token, exch, exch_type, scrip_code, source, from_date, to_date,
            symbol=symbol, timeout=40, **_datafeed_opts(),
        )
        candles = apply_interval_transform(candles, cfg, _filter_market_hours)
        return jsonify({"success": True, "candles": candles, "count": len(candles)})
    except http.exceptions.HTTPError as e:
        status = e.response.status_code if e.response is not None else 500
        try:
            msg = e.response.json().get("message") or str(e)
        except Exception:
            msg = str(e)
        return jsonify({"success": False, "message": msg}), status
    except Exception as e:
        return jsonify({"success": False, "message": str(e)}), 500


def _yahoo_base_url():
    s = load_app_settings()
    url = (s.get("yahoo_base_url") or yf_broker.DEFAULT_BASE_URL).strip()
    return url or yf_broker.DEFAULT_BASE_URL


def _cdc_use_yahoo():
    s = load_app_settings()
    yahoo_on = bool(s.get("yahoo_enabled"))
    fp_on = s.get("5paisa_enabled", True) is not False
    fp_token = load_credentials().get("5paisa", {}).get("access_token", "").strip()
    return yahoo_on and (not fp_on or not fp_token)


def _resolve_yahoo_symbol(symbol):
    return yf_broker.lookup_instrument(symbol)


def _yahoo_price_fetcher(interval, from_date, to_date):
    base = _yahoo_base_url()

    def fetch(inst):
        ysym = (inst or {}).get("yahoo_symbol") or ""
        return yf_broker.get_historical_data(
            ysym, interval, from_date, to_date, base_url=base, timeout=60,
        )
    return fetch


# ---------- Yahoo Finance ----------

@app.route("/api/yahoo/save", methods=["POST"])
def yahoo_save():
    body = request.get_json(force=True) or {}
    url = str(body.get("base_url") or "").strip() or yf_broker.DEFAULT_BASE_URL
    for token in ("{YahooStockSymbol}", "{UTCStartDTM}", "{UTCEndDTM}", "{Interval}"):
        if token not in url:
            return jsonify({
                "success": False,
                "message": "Base URL must include " + token + ".",
            }), 400
    s = load_app_settings()
    s["yahoo_base_url"] = url
    save_app_settings(s)
    return jsonify({"success": True, "message": "Yahoo Finance Base URL saved.", "yahoo_base_url": url})


@app.route("/api/yahoo/connect", methods=["POST"])
def yahoo_connect():
    if not os.path.exists(yf_broker.YAHOO_LIST_CSV):
        return jsonify({
            "success": False,
            "message": "Yahoo Stock List.csv not found in the app folder.",
        }), 400
    rows = yf_broker.list_instruments()
    if not rows:
        return jsonify({
            "success": False,
            "message": "Yahoo Stock List.csv is empty or missing Instrument / YahooStockSymbol columns.",
        }), 400
    return jsonify({
        "success": True,
        "message": "Yahoo Finance ready. {} symbols loaded.".format(len(rows)),
        "count": len(rows),
        "yahoo_base_url": _yahoo_base_url(),
    })


@app.route("/api/yahoo/instruments/search")
def yahoo_instruments_search():
    q = request.args.get("q", "").strip()
    limit = int(request.args.get("limit", 15))
    if len(q) < 2:
        return jsonify([])
    return jsonify(yf_broker.search_instruments(q, limit=limit))


@app.route("/api/yahoo/chart/data", methods=["POST"])
def yahoo_chart_data():
    s = load_app_settings()
    if not s.get("yahoo_enabled"):
        return jsonify({"success": False, "message": "Yahoo Finance is disabled in Settings."}), 400
    payload = request.get_json(force=True) or {}
    yahoo_symbol = (payload.get("yahoo_symbol") or payload.get("scrip_code") or "").strip()
    trading_symbol = (payload.get("trading_symbol") or payload.get("symbol") or "").strip()
    interval = payload.get("interval", "D")
    from_date = payload.get("from_date", "")
    to_date = payload.get("to_date", "")
    cfg = _interval_cfg("yahoo", interval)
    source = cfg.get("source") or interval
    if not yahoo_symbol and trading_symbol:
        rec = yf_broker.lookup_instrument(trading_symbol)
        yahoo_symbol = (rec or {}).get("yahoo_symbol") or ""
    if not yahoo_symbol:
        return jsonify({"success": False, "message": "YahooStockSymbol is required."}), 400
    today = datetime.today()
    if not to_date:
        to_date = today.strftime("%Y-%m-%d")
    if not from_date:
        from_date = _chart_default_from(interval, "yahoo")
        if str(source) == "1":
            cap = (today - timedelta(days=yf_broker.MAX_1M_DAYS)).strftime("%Y-%m-%d")
            if from_date < cap:
                from_date = cap
        elif str(source) in ("25", "30"):
            cap = (today - timedelta(days=yf_broker.MAX_30M_DAYS)).strftime("%Y-%m-%d")
            if from_date < cap:
                from_date = cap
    try:
        candles = yf_broker.get_historical_data(
            yahoo_symbol, source, from_date, to_date,
            base_url=_yahoo_base_url(), timeout=40,
        )
        candles = apply_interval_transform(candles, cfg, None)
        return jsonify({"success": True, "candles": candles, "count": len(candles)})
    except http.exceptions.HTTPError as e:
        status = e.response.status_code if e.response is not None else 500
        return jsonify({"success": False, "message": str(e)}), status
    except Exception as e:
        return jsonify({"success": False, "message": str(e)}), 500


def _sanitize_excel_config(raw, fallback_id=""):
    if not isinstance(raw, dict):
        return None
    name = str(raw.get("name") or "").strip()[:80]
    if not name:
        return None
    cid = str(raw.get("id") or fallback_id or uuid.uuid4()).strip() or str(uuid.uuid4())
    try:
        header_row = int(raw.get("header_row") or 0)
    except (TypeError, ValueError):
        header_row = 0
    header_row = max(0, min(header_row, 20000))
    try:
        poll = int(raw.get("poll_seconds") or 5)
    except (TypeError, ValueError):
        poll = 5
    poll = max(1, min(poll, 3600))
    mapping_in = raw.get("mapping") if isinstance(raw.get("mapping"), dict) else {}
    mapping = {}
    for key in ("date", "open", "high", "low", "close", "volume"):
        mapping[key] = str(mapping_in.get(key) or "").strip()[:80]
    indicators = []
    seen = set()
    for item in (raw.get("indicators") or []):
        if not isinstance(item, dict):
            continue
        iname = str(item.get("name") or "").strip()[:40]
        col = str(item.get("column") or "").strip()[:80]
        if not iname or not col:
            continue
        key = iname.lower()
        if key in seen:
            continue
        seen.add(key)
        indicators.append({"name": iname, "column": col})
        if len(indicators) >= 16:
            break
    return {
        "id": cid,
        "name": name,
        "workbook": str(raw.get("workbook") or "").strip()[:200],
        "sheet": str(raw.get("sheet") or "").strip()[:120],
        "header_row": header_row,
        "poll_seconds": poll,
        "mapping": mapping,
        "indicators": indicators,
    }


def _excel_configs():
    s = load_app_settings()
    out = []
    seen = set()
    for item in (s.get("excel_configs") or []):
        cfg = _sanitize_excel_config(item)
        if not cfg:
            continue
        if cfg["id"] in seen:
            cfg["id"] = str(uuid.uuid4())
        seen.add(cfg["id"])
        out.append(cfg)
    return out


@app.route("/api/excel/workbooks")
def excel_workbooks():
    try:
        names = xl_broker.list_workbooks()
        return jsonify({"success": True, "workbooks": names})
    except Exception as e:
        return jsonify({"success": False, "message": str(e), "workbooks": []}), 400


@app.route("/api/excel/sheets")
def excel_sheets():
    workbook = request.args.get("workbook", "").strip()
    try:
        sheets = xl_broker.list_sheets(workbook)
        return jsonify({"success": True, "sheets": sheets})
    except Exception as e:
        return jsonify({"success": False, "message": str(e), "sheets": []}), 400


@app.route("/api/excel/preview", methods=["POST"])
def excel_preview():
    body = request.get_json(force=True) or {}
    try:
        data = xl_broker.preview_sheet(
            body.get("workbook") or "",
            body.get("sheet") or "",
            body.get("header_row"),
        )
        return jsonify(data)
    except Exception as e:
        return jsonify({"success": False, "message": str(e)}), 400


@app.route("/api/excel/configs", methods=["GET", "POST"])
def excel_configs():
    if request.method == "GET":
        return jsonify({"success": True, "configs": _excel_configs()})
    body = request.get_json(force=True) or {}
    raw_list = body.get("configs")
    if raw_list is None and isinstance(body.get("config"), dict):
        existing = {c["id"]: c for c in _excel_configs()}
        one = _sanitize_excel_config(body.get("config"))
        if not one:
            return jsonify({"success": False, "message": "Config name is required."}), 400
        existing[one["id"]] = one
        raw_list = list(existing.values())
    if not isinstance(raw_list, list):
        return jsonify({"success": False, "message": "configs must be a list."}), 400
    cleaned = []
    seen = set()
    for item in raw_list[:40]:
        cfg = _sanitize_excel_config(item)
        if not cfg:
            continue
        if cfg["id"] in seen:
            cfg["id"] = str(uuid.uuid4())
        seen.add(cfg["id"])
        cleaned.append(cfg)
    s = load_app_settings()
    s["excel_configs"] = cleaned
    save_app_settings(s)
    return jsonify({"success": True, "configs": cleaned})


@app.route("/api/excel/configs/<config_id>", methods=["DELETE"])
def excel_config_delete(config_id):
    want = str(config_id or "").strip()
    cleaned = [c for c in _excel_configs() if c["id"] != want]
    s = load_app_settings()
    s["excel_configs"] = cleaned
    save_app_settings(s)
    return jsonify({"success": True, "configs": cleaned})


@app.route("/api/excel/connect", methods=["POST"])
def excel_connect():
    s = load_app_settings()
    if not s.get("excel_enabled"):
        return jsonify({"success": False, "message": "Excel is disabled in Settings."}), 400
    try:
        names = xl_broker.list_workbooks()
    except Exception as e:
        return jsonify({"success": False, "message": str(e)}), 400
    ncfg = len(_excel_configs())
    return jsonify({
        "success": True,
        "message": "Excel ready. {} open workbook(s), {} saved config(s).".format(len(names), ncfg),
        "workbooks": names,
        "count": ncfg,
    })


@app.route("/api/excel/instruments/search")
def excel_instruments_search():
    q = request.args.get("q", "").strip()
    limit = int(request.args.get("limit", 20))
    return jsonify(xl_broker.search_configs(_excel_configs(), q, limit=limit))


@app.route("/api/excel/chart/data", methods=["POST"])
def excel_chart_data():
    s = load_app_settings()
    if not s.get("excel_enabled"):
        return jsonify({"success": False, "message": "Excel is disabled in Settings."}), 400
    payload = request.get_json(force=True) or {}
    config_id = (payload.get("config_id") or payload.get("excel_config_id")
                 or payload.get("scrip_code") or payload.get("trading_symbol") or "").strip()
    cfg = xl_broker.find_config(_excel_configs(), config_id)
    if not cfg:
        return jsonify({"success": False, "message": "Excel config not found. Save it on Connect to Broker first."}), 400
    try:
        data = xl_broker.get_chart_data(cfg)
        interval = str(payload.get("interval") or "1")
        candles = data.get("candles") or []
        overlays = data.get("overlays") or []
        data["candles"] = combine_candles_to_interval(candles, interval)
        data["overlays"] = combine_overlays_to_interval(overlays, interval, candles)
        data["count"] = len(data["candles"])
        data["interval"] = interval
        return jsonify(data)
    except Exception as e:
        return jsonify({"success": False, "message": str(e)}), 400


# ---------- Python custom indicators ----------

@app.route("/api/custom-indicators", methods=["GET"])
def custom_indicators_catalog():
    return jsonify({"success": True, "indicators": py_ind_catalog()})


@app.route("/api/custom-indicators/compute", methods=["POST"])
def custom_indicators_compute():
    body = request.get_json(force=True) or {}
    ind_id = str(body.get("id") or "").strip()
    if not ind_id:
        return jsonify({"success": False, "message": "id is required."}), 400
    candles = body.get("candles")
    if not isinstance(candles, list):
        return jsonify({"success": False, "message": "candles must be a list."}), 400
    if len(candles) > 25000:
        candles = candles[-25000:]
    params = body.get("params") if isinstance(body.get("params"), dict) else {}
    try:
        result = py_ind_compute(ind_id, candles, params)
    except ValueError as e:
        return jsonify({"success": False, "message": str(e)}), 404
    except Exception as e:
        return jsonify({"success": False, "message": str(e)}), 500
    if not isinstance(result, dict):
        result = {"result": result}
    out = {"success": True, "id": ind_id}
    out.update(result)
    return jsonify(out)


# ---------- Settings API ----------

@app.route("/api/settings", methods=["GET"])
def get_settings():
    s = load_app_settings()
    return jsonify({
        "api_enabled": s.get("api_enabled", False),
        "dhan_enabled": s.get("dhan_enabled", True),
        "5paisa_enabled": s.get("5paisa_enabled", True),
        "yahoo_enabled": s.get("yahoo_enabled", False),
        "yahoo_base_url": (s.get("yahoo_base_url") or yf_broker.DEFAULT_BASE_URL).strip() or yf_broker.DEFAULT_BASE_URL,
        "excel_enabled": s.get("excel_enabled", False),
        "excel_configs": _excel_configs(),
        "chart_refresh_interval": int(s.get("chart_refresh_interval", 0) or 0),
        "broker_intervals": s.get("broker_intervals") or default_broker_intervals(),
        "broker_native_intervals": {
            "dhan": native_catalog("dhan"),
            "5paisa": native_catalog("5paisa"),
            "yahoo": native_catalog("yahoo"),
        },
        "interval_resample_options": list(RESAMPLE_OPTIONS),
    })


@app.route("/api/settings/api-access", methods=["POST"])
def set_api_access():
    body = request.get_json(force=True)
    enabled = bool(body.get("enabled", False))
    s = load_app_settings()
    s["api_enabled"] = enabled
    save_app_settings(s)
    return jsonify({"success": True, "api_enabled": enabled})


@app.route("/api/settings/brokers", methods=["POST"])
def set_broker_settings():
    body = request.get_json(force=True) or {}
    s = load_app_settings()
    if "dhan_enabled" in body:
        s["dhan_enabled"] = bool(body.get("dhan_enabled"))
    if "5paisa_enabled" in body:
        s["5paisa_enabled"] = bool(body.get("5paisa_enabled"))
    if "yahoo_enabled" in body:
        s["yahoo_enabled"] = bool(body.get("yahoo_enabled"))
    if "excel_enabled" in body:
        s["excel_enabled"] = bool(body.get("excel_enabled"))
    save_app_settings(s)
    return jsonify({
        "success": True,
        "dhan_enabled": s.get("dhan_enabled", True),
        "5paisa_enabled": s.get("5paisa_enabled", True),
        "yahoo_enabled": s.get("yahoo_enabled", False),
        "excel_enabled": s.get("excel_enabled", False),
    })


@app.route("/api/settings/chart", methods=["POST"])
def set_chart_settings():
    body = request.get_json(force=True) or {}
    value = body.get("chart_refresh_interval", 0)
    try:
        refresh_ms = max(0, int(value))
    except Exception:
        refresh_ms = 0
    s = load_app_settings()
    s["chart_refresh_interval"] = refresh_ms
    save_app_settings(s)
    return jsonify({"success": True, "chart_refresh_interval": refresh_ms})


@app.route("/api/settings/intervals", methods=["POST"])
def set_broker_intervals():
    body = request.get_json(force=True) or {}
    broker = str(body.get("broker") or "").strip().lower()
    if broker not in ("dhan", "5paisa", "yahoo"):
        return jsonify({"success": False, "message": "broker must be dhan, 5paisa, or yahoo."}), 400
    rows = normalize_broker_intervals(body.get("intervals"), broker)
    s = load_app_settings()
    intervals = dict(s.get("broker_intervals") or default_broker_intervals())
    intervals[broker] = rows
    s["broker_intervals"] = normalize_all_intervals(intervals)
    save_app_settings(s)
    return jsonify({
        "success": True,
        "broker": broker,
        "intervals": s["broker_intervals"][broker],
        "broker_intervals": s["broker_intervals"],
    })


def _sanitize_chart_overlays(raw):
    cleaned = []
    if not isinstance(raw, list):
        return cleaned
    for item in raw[:80]:
        if not isinstance(item, dict):
            continue
        name = str(item.get("name") or "").strip()[:64]
        points = item.get("points")
        if not name or not isinstance(points, list) or not points:
            continue
        pts = []
        for p in points[:12]:
            if not isinstance(p, dict):
                continue
            pt = {}
            if p.get("timestamp") is not None:
                try:
                    pt["timestamp"] = int(float(p["timestamp"]))
                except (TypeError, ValueError):
                    pass
            if p.get("value") is not None:
                try:
                    pt["value"] = float(p["value"])
                except (TypeError, ValueError):
                    pass
            if p.get("dataIndex") is not None:
                try:
                    pt["dataIndex"] = int(float(p["dataIndex"]))
                except (TypeError, ValueError):
                    pass
            if "timestamp" not in pt and "dataIndex" not in pt and "value" not in pt:
                continue
            pts.append(pt)
        if not pts:
            continue
        cleaned.append({
            "name": name,
            "points": pts,
            "extendData": item.get("extendData"),
        })
    return cleaned


@app.route("/api/settings/chart-drawings", methods=["GET", "POST"])
def chart_drawings():
    s = load_app_settings()
    drawings = s.get("chart_drawings")
    if not isinstance(drawings, dict):
        drawings = {}
    if request.method == "GET":
        key = str(request.args.get("key") or "").strip()
        if key:
            found = key in drawings
            return jsonify({
                "success": True,
                "key": key,
                "found": found,
                "overlays": drawings.get(key) or [],
            })
        return jsonify({"success": True, "drawings": drawings})
    body = request.get_json(force=True) or {}
    key = str(body.get("key") or "").strip()[:160]
    if not key:
        return jsonify({"success": False, "message": "key required"}), 400
    overlays = _sanitize_chart_overlays(body.get("overlays"))
    drawings[key] = overlays
    s["chart_drawings"] = drawings
    save_app_settings(s)
    return jsonify({"success": True, "count": len(overlays)})


@app.route("/api/settings/markets", methods=["GET", "POST"])
def market_settings():
    if request.method == "GET":
        s = load_app_settings()
        return jsonify(_normalize_market_settings(s))

    body = request.get_json(force=True) or {}
    exchanges = [x for x in (body.get("enabled_exchanges") or []) if x in VALID_EXCHANGES]
    # Accept new or legacy key from clients
    raw_exch_types = body.get("enabled_exch_types")
    if raw_exch_types is None:
        raw_exch_types = body.get("enabled_instrument_types") or []
    exch_types = [x for x in raw_exch_types if x in VALID_EXCH_TYPES]
    scrip_types = [x for x in (body.get("enabled_scrip_types") or []) if x in VALID_SCRIP_TYPES]

    if not exchanges or not exch_types or not scrip_types:
        return jsonify({
            "success": False,
            "message": "Select at least one option in Exch, ExchType, and ScripType.",
        }), 400

    s = load_app_settings()
    s["enabled_exchanges"] = exchanges
    s["enabled_exch_types"] = exch_types
    s["enabled_scrip_types"] = scrip_types
    s["save_to_datafeed"] = bool(body.get("save_to_datafeed", False))
    # Keep legacy key in sync for older readers
    s["enabled_instrument_types"] = [x for x in exch_types if x in ("C", "D")]
    save_app_settings(s)
    out = _normalize_market_settings(s)
    out["success"] = True
    return jsonify(out)


@app.route("/api/settings/option-chain", methods=["GET", "POST"])
def option_chain_settings():
    if request.method == "GET":
        s = load_app_settings()
        return jsonify(_normalize_option_chain_settings(s))

    body = request.get_json(force=True) or {}
    price = _normalize_oc_fields(
        body.get("oc_price_fields"), DEFAULT_OC_PRICE_FIELDS, VALID_OC_PRICE_KEYS
    )
    greeks = _normalize_oc_fields(
        body.get("oc_greeks_fields"), DEFAULT_OC_GREEKS_FIELDS, VALID_OC_GREEKS_KEYS
    )
    if not any(x["visible"] for x in price):
        return jsonify({
            "success": False,
            "message": "Keep at least one Price field visible.",
        }), 400
    if not any(x["visible"] for x in greeks):
        return jsonify({
            "success": False,
            "message": "Keep at least one Greeks field visible.",
        }), 400

    s = load_app_settings()
    s["oc_price_fields"] = price
    s["oc_greeks_fields"] = greeks
    save_app_settings(s)
    out = _normalize_option_chain_settings(s)
    out["success"] = True
    return jsonify(out)


@app.route("/api/settings/indicators", methods=["GET", "POST"])
def indicator_settings():
    if request.method == "GET":
        s = load_app_settings()
        return jsonify({
            "ta_enabled": bool(s.get("ta_enabled", False)),
            "ta_indicators": s.get("ta_indicators", []),
        })

    body = request.get_json(force=True) or {}
    s = load_app_settings()

    if "ta_enabled" in body:
        s["ta_enabled"] = bool(body.get("ta_enabled"))

    if "ta_indicators" in body:
        indicators = body.get("ta_indicators")
        if isinstance(indicators, list):
            custom_ok = {m["id"]: m for m in _custom_api_catalog()}
            cleaned = []
            for ind in indicators:
                if not isinstance(ind, dict):
                    continue
                source = str(ind.get("source") or "builtin").strip().lower()
                if source == "custom":
                    ind_type = str(ind.get("type", "")).strip()
                    if not ind_type or ind_type not in custom_ok:
                        continue
                    params = ind.get("params", {}) if isinstance(ind.get("params", {}), dict) else {}
                    cleaned.append({
                        "id": str(ind.get("id", "")).strip() or ind_type,
                        "type": ind_type,
                        "source": "custom",
                        "params": params,
                    })
                    continue
                ind_type = str(ind.get("type", "")).strip().lower()
                if not ind_type or ind_type not in TA_CATALOG:
                    continue
                params = ind.get("params", {}) if isinstance(ind.get("params", {}), dict) else {}
                cleaned.append({
                    "id": str(ind.get("id", "")).strip() or ind_type,
                    "type": ind_type,
                    "source": "builtin",
                    "params": params,
                })
            s["ta_indicators"] = cleaned

    save_app_settings(s)
    return jsonify({
        "success": True,
        "ta_enabled": bool(s.get("ta_enabled", False)),
        "ta_indicators": s.get("ta_indicators", []),
    })


def _ta_catalog_payload():
    return {
        "success": True,
        "indicators": TA_CATALOG,
        "custom_indicators": _custom_api_catalog(),
    }


@app.route("/api/ta/catalog", methods=["GET"])
def ta_catalog():
    """In-app catalog. Public callers must use /public/api/ta/catalog."""
    return jsonify(_ta_catalog_payload())


@app.route("/public/api/ta/catalog", methods=["GET", "OPTIONS"])
def public_ta_catalog():
    if request.method == "OPTIONS":
        return _cors(make_response("", 204))
    ok, err = _check_api_enabled()
    if not ok:
        return err
    return _cors(make_response(jsonify(_ta_catalog_payload()), 200))


# ---------- Public API (for external apps) ----------

@app.route("/public/api/status", methods=["GET", "OPTIONS"])
def public_status():
    if request.method == "OPTIONS":
        return _cors(make_response("", 204))
    ok, err = _check_api_enabled()
    if not ok:
        return err
    resp = make_response(jsonify({
        "status": "ok",
        "dhan_connected":    session.get("dhan_connected", False),
        "5paisa_connected":  session.get("5paisa_connected", False),
        "timestamp":         datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
    }))
    return _cors(resp)


@app.route("/public/api/5paisa/search", methods=["GET", "OPTIONS"])
def public_fp_search():
    if request.method == "OPTIONS":
        return _cors(make_response("", 204))
    ok, err = _check_api_enabled()
    if not ok:
        return err
    q     = request.args.get("q", "").strip().upper()
    limit = min(int(request.args.get("limit", 15)), 50)
    if len(q) < 2:
        return _cors(make_response(jsonify([]), 200))
    if not _fp_instruments:
        return _cors(make_response(jsonify({"error": "Scrip master not loaded. Connect to 5Paisa first."}), 503))

    markets = _normalize_market_settings(load_app_settings())

    def score(i):
        sym = i["trading_symbol"].upper()
        nse = i["exch"] == "N" and i["exch_type"] == "C"
        return (0 if sym == q else 1 if sym.startswith(q) else 2, 0 if nse else 1)

    results = [i for i in _fp_instruments
               if _market_allowed(i, markets)
               and (q in i["trading_symbol"].upper() or q in i["name"].upper())]
    results.sort(key=score)
    return _cors(make_response(jsonify(results[:limit]), 200))


@app.route("/public/api/5paisa/chart", methods=["POST", "OPTIONS"])
def public_fp_chart():
    if request.method == "OPTIONS":
        return _cors(make_response("", 204))
    ok, err = _check_api_enabled()
    if not ok:
        return err
    creds        = load_credentials()
    access_token = creds.get("5paisa", {}).get("access_token", "").strip()
    if not access_token:
        return _cors(make_response(jsonify({"error": "5Paisa not connected."}), 401))
    payload    = request.get_json(force=True) or {}
    use_ta     = _request_wants_ta(payload)
    scrip_code = str(payload.get("scrip_code", "")).strip()
    exch       = payload.get("exch", "N").strip()
    exch_type  = payload.get("exch_type", "C").strip()
    interval   = payload.get("interval", "15")
    symbol     = (payload.get("trading_symbol") or payload.get("symbol") or "").strip()
    today      = datetime.today()
    from_date  = payload.get("from_date") or (today - timedelta(days=4)).strftime("%Y-%m-%d")
    to_date    = payload.get("to_date")   or today.strftime("%Y-%m-%d")
    if not scrip_code:
        return _cors(make_response(jsonify({"error": "scrip_code required."}), 400))
    if not symbol:
        symbol = _symbol_for_scrip(scrip_code, exch, exch_type)
    try:
        candles = fp.get_historical_data(
            access_token, exch, exch_type, scrip_code, interval, from_date, to_date,
            symbol=symbol, **_datafeed_opts(),
        )
        candles = _filter_market_hours(candles, interval)
        candles, applied_ta_ids, ta_warning = _apply_saved_ta(candles, use_ta)
        result = {"success": True, "candles": candles, "count": len(candles), "ta_applied": applied_ta_ids}
        if ta_warning:
            result["ta_warning"] = ta_warning
        return _cors(make_response(jsonify(result), 200))
    except Exception as e:
        return _cors(make_response(jsonify({"error": str(e)}), 500))


def _resolve_symbol(symbol):
    sym = symbol.upper().strip()
    nse_match = None
    bse_match = None
    for inst in _fp_instruments:
        if inst["trading_symbol"].upper() == sym and inst["exch_type"] == "C":
            if inst["exch"] == "N" and nse_match is None:
                nse_match = inst
            elif inst["exch"] == "B" and bse_match is None:
                bse_match = inst
    return nse_match or bse_match


def _symbol_for_scrip(scrip_code, exch="", exch_type=""):
    """Look up trading_symbol from the loaded scrip master."""
    code = str(scrip_code).strip()
    if not code:
        return ""
    for inst in _fp_instruments:
        if str(inst.get("scrip_code", "")).strip() != code:
            continue
        if exch and inst.get("exch") != exch:
            continue
        if exch_type and inst.get("exch_type") != exch_type:
            continue
        return inst.get("trading_symbol") or ""
    return ""


_INTERVAL_MINS = {"1": 1, "5": 5, "15": 15, "25": 30, "60": 60}
_IST = timedelta(hours=5, minutes=30)


def _filter_market_hours(candles, interval):
    """Keep intraday candles within 09:15-15:30 IST.
    Also keep candles after 15:30 if volume > 0.
    Candles before 09:15 are always dropped."""
    if interval in ("D", "W", "M", "Q", "Y"):
        return candles
    result = []
    for c in candles:
        ist_time = (datetime.fromtimestamp(c["time"], timezone.utc) + _IST).strftime("%H:%M:%S")
        if "09:15:00" <= ist_time <= "15:30:00":
            result.append(c)
        elif ist_time > "15:30:00" and c.get("volume", 0) > 0:
            result.append(c)
    return result


def _forward_fill_candles(candles, interval):
    """Fill intraday time gaps with the previous candle's values (forward-fill).
    Only fills gaps within the same calendar date (IST); gaps across dates
    (holidays / weekends) are left as-is so no fake data is inserted."""
    if interval == "D" or not candles:
        return candles
    step_mins = _INTERVAL_MINS.get(interval)
    if not step_mins:
        return candles
    step_secs = int(timedelta(minutes=step_mins).total_seconds())
    filled = [candles[0]]
    for i in range(1, len(candles)):
        prev = filled[-1]
        curr = candles[i]
        expected_ts = prev["time"] + step_secs
        prev_date = (datetime.fromtimestamp(prev["time"], timezone.utc) + _IST).date()
        curr_date = (datetime.fromtimestamp(curr["time"], timezone.utc) + _IST).date()
        if prev_date == curr_date:
            # Same trading day — fill any missing slots within this day
            while expected_ts < curr["time"]:
                fill_date = (datetime.fromtimestamp(expected_ts, timezone.utc) + _IST).date()
                if fill_date != prev_date:
                    break  # don't spill into the next date
                filled.append({
                    "time":   expected_ts,
                    "open":   prev["close"],
                    "high":   prev["close"],
                    "low":    prev["close"],
                    "close":  prev["close"],
                    "volume": 0,
                })
                expected_ts += step_secs
        filled.append(curr)
    return filled


def _candles_to_field_rows(candles, field_codes):
    FIELD_MAP = {
        "D":   lambda c: (datetime.fromtimestamp(c["time"], timezone.utc) + _IST).strftime("%Y-%m-%d %H:%M:%S"),
        "DTM": lambda c: (datetime.fromtimestamp(c["time"], timezone.utc) + _IST).strftime("%Y-%m-%d %H:%M:%S"),
        "T":   lambda c: c["time"],
        "O":   lambda c: c["open"],
        "H":   lambda c: c["high"],
        "L":   lambda c: c["low"],
        "C":   lambda c: c["close"],
        "V":   lambda c: c["volume"],
    }
    rows = []
    for candle in candles:
        row = {}
        for code in field_codes:
            if code in FIELD_MAP:
                row[code] = FIELD_MAP[code](candle)
            elif code in candle:
                row[code] = candle.get(code)
        rows.append(row)
    return rows


def _to_float(value, default=0.0):
    try:
        return float(value)
    except Exception:
        return default


def _sma(values, period):
    n = len(values)
    out = [None] * n
    if period <= 0:
        return out
    run = 0.0
    for i, v in enumerate(values):
        run += v
        if i >= period:
            run -= values[i - period]
        if i >= period - 1:
            out[i] = run / period
    return out


def _ema(values, period):
    n = len(values)
    out = [None] * n
    if period <= 0 or n == 0:
        return out
    alpha = 2.0 / (period + 1.0)
    prev = values[0]
    for i, v in enumerate(values):
        prev = (v * alpha) + (prev * (1.0 - alpha)) if i > 0 else v
        out[i] = prev
    return out


def _wma(values, period):
    n = len(values)
    out = [None] * n
    if period <= 0:
        return out
    denom = period * (period + 1) / 2
    for i in range(period - 1, n):
        acc = 0.0
        w = 1
        for j in range(i - period + 1, i + 1):
            acc += values[j] * w
            w += 1
        out[i] = acc / denom
    return out


def _rsi(values, period):
    n = len(values)
    out = [None] * n
    if period <= 0 or n < 2:
        return out
    gains = [0.0] * n
    losses = [0.0] * n
    for i in range(1, n):
        ch = values[i] - values[i - 1]
        gains[i] = ch if ch > 0 else 0.0
        losses[i] = -ch if ch < 0 else 0.0
    avg_gain = 0.0
    avg_loss = 0.0
    for i in range(1, n):
        if i <= period:
            avg_gain += gains[i]
            avg_loss += losses[i]
            if i == period:
                avg_gain /= period
                avg_loss /= period
        else:
            avg_gain = ((avg_gain * (period - 1)) + gains[i]) / period
            avg_loss = ((avg_loss * (period - 1)) + losses[i]) / period
        if i >= period:
            if avg_loss == 0:
                out[i] = 100.0
            else:
                rs = avg_gain / avg_loss
                out[i] = 100.0 - (100.0 / (1.0 + rs))
    return out


def _atr(highs, lows, closes, period):
    n = len(closes)
    out = [None] * n
    if period <= 0 or n == 0:
        return out
    tr = [0.0] * n
    for i in range(n):
        if i == 0:
            tr[i] = highs[i] - lows[i]
        else:
            tr[i] = max(
                highs[i] - lows[i],
                abs(highs[i] - closes[i - 1]),
                abs(lows[i] - closes[i - 1]),
            )
    return _ema(tr, period)


def _custom_api_catalog():
    items = []
    for meta in py_ind_catalog():
        if not meta.get("api"):
            continue
        items.append(meta)
    return items


def _normalize_ta_indicators(raw_indicators):
    out = []
    for ind in raw_indicators or []:
        if not isinstance(ind, dict):
            continue
        source = str(ind.get("source") or "builtin").strip().lower()
        ind_type = str(ind.get("type", "")).strip()
        if source != "custom":
            ind_type = ind_type.lower()
        if not ind_type:
            continue
        params = ind.get("params", {}) if isinstance(ind.get("params", {}), dict) else {}
        out.append({
            "id": str(ind.get("id", "")).strip() or ind_type,
            "type": ind_type,
            "source": "custom" if source == "custom" else "builtin",
            "params": params,
        })
    return out


def _candles_for_custom_ta(candles):
    out = []
    for c in candles:
        row = dict(c)
        if "timestamp" not in row and row.get("time") is not None:
            row["timestamp"] = row["time"]
        out.append(row)
    return out


def _apply_custom_ta_indicator(candles, ind):
    """Attach line-series values as separate candle fields. Returns field names."""
    ind_id = ind["id"]
    ind_type = ind["type"]
    params = ind.get("params") or {}
    try:
        result = py_ind_compute(ind_type, _candles_for_custom_ta(candles), params)
    except Exception:
        return []
    if not isinstance(result, dict):
        return []

    def _set_field(field, vals, times=None):
        tmap = None
        if isinstance(times, list) and isinstance(vals, list) and len(times) == len(vals):
            tmap = {}
            for i, ts in enumerate(times):
                try:
                    tmap[int(ts)] = vals[i]
                except (TypeError, ValueError):
                    continue
        for i, candle in enumerate(candles):
            if tmap is not None:
                ts = candle.get("time", candle.get("timestamp"))
                try:
                    candle[field] = tmap.get(int(ts))
                except (TypeError, ValueError):
                    candle[field] = None
            else:
                candle[field] = vals[i] if isinstance(vals, list) and i < len(vals) else None

    series = result.get("series")
    plot = result.get("plot") if isinstance(result.get("plot"), list) else []
    times = result.get("times") if isinstance(result.get("times"), list) else None
    stats = result.get("stats") if isinstance(result.get("stats"), dict) else {}
    field_ids = []
    if isinstance(series, dict) and series:
        for i, (key, vals) in enumerate(series.items()):
            enabled = True
            if i < len(plot):
                enabled = bool(plot[i])
            elif key in stats:
                enabled = bool(stats[key])
            if not enabled or not isinstance(vals, list):
                continue
            field = f"{ind_id}_{key}"
            field_ids.append(field)
            _set_field(field, vals, times)
        return field_ids

    for key in ("values", "line", "data"):
        vals = result.get(key)
        if isinstance(vals, list):
            field_ids.append(ind_id)
            _set_field(ind_id, vals, times)
            return field_ids
    return []


def _apply_ta_indicators(candles, indicators):
    if not candles or not indicators:
        return candles, []

    closes = [_to_float(c.get("close", 0.0)) for c in candles]
    highs = [_to_float(c.get("high", 0.0)) for c in candles]
    lows = [_to_float(c.get("low", 0.0)) for c in candles]
    vols = [_to_float(c.get("volume", 0.0)) for c in candles]

    def p(params, name, default):
        return int(_to_float(params.get(name, default), default))

    applied_fields = []
    for ind in indicators:
        if ind.get("source") == "custom":
            applied_fields.extend(_apply_custom_ta_indicator(candles, ind))
            continue
        ind_type = ind["type"]
        ind_id = ind["id"]
        params = ind.get("params", {})
        values = [None] * len(candles)

        if ind_type == "sma":
            values = _sma(closes, p(params, "period", 20))
        elif ind_type == "ema":
            values = _ema(closes, p(params, "period", 20))
        elif ind_type == "wma":
            values = _wma(closes, p(params, "period", 20))
        elif ind_type == "dema":
            period = p(params, "period", 20)
            e1 = _ema(closes, period)
            e2 = _ema([x if x is not None else closes[i] for i, x in enumerate(e1)], period)
            values = [None if e1[i] is None or e2[i] is None else (2 * e1[i] - e2[i]) for i in range(len(closes))]
        elif ind_type == "tema":
            period = p(params, "period", 20)
            e1 = _ema(closes, period)
            e2 = _ema([x if x is not None else closes[i] for i, x in enumerate(e1)], period)
            e3 = _ema([x if x is not None else closes[i] for i, x in enumerate(e2)], period)
            values = [None if e1[i] is None or e2[i] is None or e3[i] is None else (3 * e1[i] - 3 * e2[i] + e3[i]) for i in range(len(closes))]
        elif ind_type == "hma":
            period = max(2, p(params, "period", 21))
            half = max(1, period // 2)
            root = max(1, int(period ** 0.5))
            w1 = _wma(closes, half)
            w2 = _wma(closes, period)
            diff = [0.0 if w1[i] is None or w2[i] is None else (2 * w1[i] - w2[i]) for i in range(len(closes))]
            values = _wma(diff, root)
        elif ind_type == "vwma":
            period = p(params, "period", 20)
            for i in range(period - 1, len(closes)):
                s_pv = 0.0
                s_v = 0.0
                for j in range(i - period + 1, i + 1):
                    s_pv += closes[j] * vols[j]
                    s_v += vols[j]
                values[i] = (s_pv / s_v) if s_v > 0 else None
        elif ind_type == "rsi":
            values = _rsi(closes, p(params, "period", 14))
        elif ind_type == "atr":
            values = _atr(highs, lows, closes, p(params, "period", 14))
        elif ind_type == "roc":
            period = p(params, "period", 12)
            for i in range(period, len(closes)):
                base = closes[i - period]
                values[i] = ((closes[i] - base) / base * 100.0) if base != 0 else None
        elif ind_type == "momentum":
            period = p(params, "period", 10)
            for i in range(period, len(closes)):
                values[i] = closes[i] - closes[i - period]
        elif ind_type == "macd" or ind_type == "ppo":
            fast = p(params, "fast", 12)
            slow = p(params, "slow", 26)
            signal = p(params, "signal", 9)
            ef = _ema(closes, fast)
            es = _ema(closes, slow)
            macd_line = [None if ef[i] is None or es[i] is None else (ef[i] - es[i]) for i in range(len(closes))]
            sig = _ema([x if x is not None else 0.0 for x in macd_line], signal)
            if ind_type == "macd":
                values = [
                    None if macd_line[i] is None or sig[i] is None else {
                        "macd": macd_line[i],
                        "signal": sig[i],
                        "hist": macd_line[i] - sig[i],
                    }
                    for i in range(len(closes))
                ]
            else:
                values = [
                    None if ef[i] is None or es[i] in (None, 0) or sig[i] is None else {
                        "ppo": ((ef[i] - es[i]) / es[i]) * 100.0,
                        "signal": sig[i],
                    }
                    for i in range(len(closes))
                ]
        elif ind_type == "bbands":
            period = p(params, "period", 20)
            stddev = _to_float(params.get("stddev", 2), 2)
            mids = _sma(closes, period)
            for i in range(period - 1, len(closes)):
                win = closes[i - period + 1:i + 1]
                mean = mids[i]
                var = sum((x - mean) ** 2 for x in win) / period
                sd = var ** 0.5
                values[i] = {"mid": mean, "upper": mean + stddev * sd, "lower": mean - stddev * sd}
        elif ind_type == "obv":
            obv = 0.0
            for i in range(len(closes)):
                if i > 0:
                    if closes[i] > closes[i - 1]:
                        obv += vols[i]
                    elif closes[i] < closes[i - 1]:
                        obv -= vols[i]
                values[i] = obv
        elif ind_type == "vwap":
            cum_pv = 0.0
            cum_v = 0.0
            for i in range(len(closes)):
                tp = (highs[i] + lows[i] + closes[i]) / 3.0
                cum_pv += tp * vols[i]
                cum_v += vols[i]
                values[i] = (cum_pv / cum_v) if cum_v > 0 else None
        else:
            # Unsupported formulas still get an explicit key in response.
            values = [None] * len(candles)

        for i, candle in enumerate(candles):
            candle[ind_id] = values[i]
        applied_fields.append(ind_id)

    return candles, applied_fields


def _request_wants_ta(payload=None):
    """True when the caller asked for indicators via TA=true (query or JSON body)."""
    for key, val in request.args.items():
        if str(key).lower() == "ta" and str(val).strip().lower() in ("1", "true", "yes", "y", "on"):
            return True
    if payload is None:
        payload = request.get_json(silent=True) if request.is_json else None
    if isinstance(payload, dict):
        for key in ("TA", "ta"):
            if str(payload.get(key, "")).strip().lower() in ("1", "true", "yes", "y", "on"):
                return True
    return False


def _apply_saved_ta(candles, use_ta):
    """Attach Settings indicators when TA=true. The Settings toggle is not required."""
    applied = []
    warning = None
    if not use_ta:
        return candles, applied, warning
    indicators = _normalize_ta_indicators(load_app_settings().get("ta_indicators", []))
    if not indicators:
        return candles, applied, "TA=true but no indicators are saved in Settings."
    candles, applied = _apply_ta_indicators(candles, indicators)
    if not applied:
        warning = "TA=true but no indicator fields were produced."
    return candles, applied, warning


def _with_ta_fields(field_codes, applied_ta_ids):
    out = list(field_codes)
    for ta_id in applied_ta_ids or []:
        if ta_id not in out:
            out.append(ta_id)
    return out


@app.route("/public/api/5paisa/historical", methods=["GET", "OPTIONS"])
def public_fp_historical():
    """
    GET /public/api/5paisa/historical

    Single symbol:
      symbol     - trading symbol e.g. RELIANCE (NSE checked first, then BSE)
      scrip_code - alternative to symbol (also pass exch, exch_type)
      interval   - 1 | 5 | 15 | 25 | 60 | D  (default 15)
      from       - YYYY-MM-DD (default 4 days ago; 365 days for D)
      to         - YYYY-MM-DD (default today)
      fields     - comma-separated: D=datetime, O=open, H=high, L=low, C=close, V=volume, T=unix

    Multiple symbols (returns datetime-aligned rows):
      symbols    - comma-separated e.g. RELIANCE,TCS
      Returns:   [{"DTM": "...", "RELIANCE": 1250.5, "TCS": 3400.0}, ...]
    """
    if request.method == "OPTIONS":
        return _cors(make_response("", 204))
    ok, err = _check_api_enabled()
    if not ok:
        return err

    creds        = load_credentials()
    access_token = creds.get("5paisa", {}).get("access_token", "").strip()
    if not access_token:
        return _cors(make_response(jsonify({"error": "5Paisa not connected. Connect via the TraderApp UI first."}), 503))

    # Auto-load instruments from saved token if not yet in memory
    if not _fp_instruments and access_token:
        _load_fp_instruments()   # blocking load so symbol lookups work immediately

    interval = request.args.get("interval", "15").strip()
    use_ta = _request_wants_ta()
    version  = request.args.get("v", "1").strip()   # v=1 JSON (default), v=2 pipe-delimited
    today    = datetime.today()
    valid_intervals = {"1", "5", "15", "25", "60", "D"}
    if interval not in valid_intervals:
        return _cors(make_response(jsonify({"error": "interval must be one of: 1, 5, 15, 25, 60, D."}), 400))

    if interval == "D":
        default_from = (today - timedelta(days=365)).strftime("%Y-%m-%d")
    else:
        default_from = (today - timedelta(days=4)).strftime("%Y-%m-%d")

    from_date = request.args.get("from", default_from).strip()
    to_date   = request.args.get("to", today.strftime("%Y-%m-%d")).strip()

    # Multiple symbols
    raw_symbols = request.args.get("symbols", "").strip()
    if raw_symbols:
        sym_list = [s.strip().upper() for s in raw_symbols.split(",") if s.strip()]
        resolved = {}
        not_found = []
        for sym in sym_list:
            inst = _resolve_symbol(sym)
            if inst:
                resolved[sym] = inst
            else:
                not_found.append(sym)
        if not_found:
            return _cors(make_response(jsonify({"error": "Symbol(s) not found: " + ", ".join(not_found)}), 404))
        if not resolved:
            return _cors(make_response(jsonify({"error": "5Paisa not connected or scrip master not loaded yet. Connect first."}), 503))

        from collections import OrderedDict
        dtm_index = OrderedDict()
        errors = {}
        for sym, inst in resolved.items():
            try:
                candles = fp.get_historical_data(
                    access_token, inst["exch"], inst["exch_type"],
                    inst["scrip_code"], interval, from_date, to_date,
                    symbol=sym, **_datafeed_opts(),
                )
                candles = _forward_fill_candles(candles, interval)
                candles = _filter_market_hours(candles, interval)
                for c in candles:
                    dtm = (datetime.fromtimestamp(c["time"], timezone.utc) + _IST).strftime("%Y-%m-%d %H:%M:%S")
                    if dtm not in dtm_index:
                        dtm_index[dtm] = {"DTM": dtm}
                    dtm_index[dtm][sym] = c["close"]
            except Exception as e:
                errors[sym] = str(e)

        data = list(dtm_index.values())
        sym_keys = list(resolved.keys())

        # Drop rows outside 09:15–15:30 IST; keep after-15:30 rows only if they were included
        # (already handled per-symbol by _filter_market_hours)

        # Forward-fill missing symbol values across aligned rows
        last_vals = {sym: None for sym in sym_keys}
        for row in data:
            for sym in sym_keys:
                if sym in row:
                    last_vals[sym] = row[sym]
                elif last_vals[sym] is not None:
                    row[sym] = last_vals[sym]

        if version == "2":
            # Pipe-delimited: header row + data rows
            header = "DTM|" + "|".join(sym_keys)
            rows = [header]
            for row in data:
                vals = [row.get("DTM", "")]
                for sym in sym_keys:
                    v = row.get(sym, "")
                    vals.append("" if v == "" else str(v))
                rows.append("|".join(vals))
            resp = make_response("\n".join(rows), 200)
            resp.headers["Content-Type"] = "text/plain; charset=utf-8"
            return _cors(resp)

        result = {"success": True, "symbols": sym_keys,
                  "interval": interval, "from": from_date, "to": to_date,
                  "count": len(data), "data": data}
        if errors:
            result["errors"] = errors
        return _cors(make_response(jsonify(result), 200))

    # Single symbol
    symbol_param = request.args.get("symbol", "").strip()
    scrip_code   = request.args.get("scrip_code", "").strip()
    fields_param = request.args.get("fields", "").strip()

    if symbol_param:
        inst = _resolve_symbol(symbol_param)
        if not inst:
            return _cors(make_response(jsonify({"error": "Symbol not found: " + symbol_param}), 404))
        scrip_code      = inst["scrip_code"]
        exch            = inst["exch"]
        exch_type       = inst["exch_type"]
        resolved_symbol = inst["trading_symbol"]
    elif scrip_code:
        exch      = request.args.get("exch", "N").strip().upper()
        exch_type = request.args.get("exch_type", "C").strip().upper()
        if exch not in ("N", "B"):
            return _cors(make_response(jsonify({"error": "exch must be N or B."}), 400))
        if exch_type not in ("C", "D"):
            return _cors(make_response(jsonify({"error": "exch_type must be C or D."}), 400))
        resolved_symbol = scrip_code
    else:
        return _cors(make_response(jsonify({"error": "Provide symbol or scrip_code query param."}), 400))

    try:
        candles = fp.get_historical_data(
            access_token, exch, exch_type, scrip_code, interval, from_date, to_date,
            symbol=resolved_symbol, **_datafeed_opts(),
        )
        candles = _forward_fill_candles(candles, interval)
        candles = _filter_market_hours(candles, interval)
        candles, applied_ta_ids, ta_warning = _apply_saved_ta(candles, use_ta)

        field_codes = [f.strip().upper() for f in fields_param.split(",") if f.strip()] if fields_param else ["DTM", "O", "H", "L", "C", "V"]
        export_codes = _with_ta_fields(field_codes, applied_ta_ids)
        ta_meta = {"ta_applied": applied_ta_ids}
        if ta_warning:
            ta_meta["ta_warning"] = ta_warning

        if version == "2":
            rows_data = _candles_to_field_rows(candles, export_codes)
            header = "|".join(export_codes)
            rows = [header]
            for row in rows_data:
                rows.append("|".join(str(row.get(k, "")) for k in export_codes))
            resp = make_response("\n".join(rows), 200)
            resp.headers["Content-Type"] = "text/plain; charset=utf-8"
            return _cors(resp)

        if fields_param:
            data = _candles_to_field_rows(candles, export_codes)
            payload = {
                "success": True, "symbol": resolved_symbol, "interval": interval,
                "from": from_date, "to": to_date, "fields": export_codes,
                "count": len(data), "data": data,
            }
            payload.update(ta_meta)
            return _cors(make_response(jsonify(payload), 200))
        else:
            payload = {
                "success": True, "symbol": resolved_symbol, "scrip_code": scrip_code,
                "exch": exch, "exch_type": exch_type, "interval": interval,
                "from": from_date, "to": to_date, "count": len(candles), "candles": candles,
            }
            payload.update(ta_meta)
            return _cors(make_response(jsonify(payload), 200))
    except Exception as e:
        return _cors(make_response(jsonify({"error": str(e)}), 500))



# ═════════════════════════════════════════
#  Analysis: Correlation Density Curve
# ═════════════════════════════════════════

@app.route("/api/analysis/sectors", methods=["GET"])
def analysis_sectors():
    """List sectors and instrument counts from Sector.csv."""
    sectors = load_sector_map(SECTOR_CSV)
    return jsonify({
        "success": True,
        "file_found": os.path.exists(SECTOR_CSV),
        "sectors": [{"name": k, "count": len(v)} for k, v in sectors.items()],
    })


# Max calendar-day lookback for CDC / historical pulls by interval.
# 5Paisa caps intraday history at ~6 months; shorter bars also hit
# payload/timeout limits, so keep finer intervals tighter.
_CDC_MAX_DAYS = {
    "D":  3650,
    "60": 120,
    "25": 90,
    "15": 60,
    "5":  30,
    "1":  8,
}
_CDC_DEFAULT_DAYS = {
    "D":  730,
    "60": 60,
    "25": 45,
    "15": 30,
    "5":  15,
    "1":  5,
}
_CDC_DEFAULT_WINDOW = {
    "D":  250,
    "60": 80,
    "25": 80,
    "15": 80,
    "5":  60,
    "1":  50,
}


def _cdc_normalize_range(interval, from_date, to_date, rolling_window=None):
    """Clamp CDC date range and suggest a workable rolling window for the interval."""
    today = datetime.today().date()
    try:
        to_d = datetime.strptime(str(to_date)[:10], "%Y-%m-%d").date() if to_date else today
    except ValueError:
        to_d = today
    if to_d > today:
        to_d = today

    max_days = _CDC_MAX_DAYS.get(interval, 30)
    default_days = _CDC_DEFAULT_DAYS.get(interval, 30)
    if _cdc_use_yahoo():
        if interval == "1":
            max_days = min(max_days, yf_broker.MAX_1M_DAYS)
        elif interval in ("25", "30"):
            max_days = min(max_days, yf_broker.MAX_30M_DAYS)
    try:
        from_d = datetime.strptime(str(from_date)[:10], "%Y-%m-%d").date() if from_date else (to_d - timedelta(days=default_days))
    except ValueError:
        from_d = to_d - timedelta(days=default_days)

    if from_d > to_d:
        from_d = to_d - timedelta(days=default_days)

    span = (to_d - from_d).days
    clamped = False
    if span > max_days:
        from_d = to_d - timedelta(days=max_days)
        clamped = True
    if _cdc_use_yahoo() and interval in ("25", "30"):
        earliest = today - timedelta(days=yf_broker.MAX_30M_DAYS)
        if from_d < earliest:
            from_d = earliest
            clamped = True
        if to_d < earliest:
            to_d = today
            from_d = earliest
            clamped = True
    if from_d > to_d:
        from_d = to_d

    if rolling_window is None:
        window = _CDC_DEFAULT_WINDOW.get(interval, 80)
    else:
        try:
            window = int(rolling_window)
        except (TypeError, ValueError):
            window = _CDC_DEFAULT_WINDOW.get(interval, 80)
        # Keep window reachable for the selected span (rough bar-count floor)
        bars_per_day = {"D": 1, "60": 7, "25": 13, "15": 25, "5": 75, "1": 375}.get(interval, 25)
        max_sensible = max(20, int((to_d - from_d).days * bars_per_day * 0.7))
        if window > max_sensible:
            window = max(20, min(window, max_sensible))
            clamped = True
        window = max(20, min(5000, window))

    return {
        "from_date": from_d.strftime("%Y-%m-%d"),
        "to_date": to_d.strftime("%Y-%m-%d"),
        "rolling_window": window,
        "clamped": clamped,
        "max_days": max_days,
    }


@app.route("/api/analysis/cdc/scan", methods=["POST"])
def cdc_scan_start():
    """Start a Correlation Density scan in the background."""
    use_yahoo = _cdc_use_yahoo()
    access_token = ""
    resolver = _resolve_symbol
    fetcher = None
    if use_yahoo:
        if not yf_broker.list_instruments():
            return jsonify({"success": False,
                            "message": "Yahoo Stock List.csv missing or empty."}), 400
        resolver = _resolve_yahoo_symbol
    else:
        creds = load_credentials()
        access_token = creds.get("5paisa", {}).get("access_token", "").strip()
        if not access_token:
            return jsonify({"success": False,
                            "message": "5Paisa not connected. Connect first."}), 401
        if not _fp_instruments:
            if _fp_instruments_loading:
                return jsonify({"success": False,
                                "message": "Scrip master still loading, try again shortly."}), 503
            _load_fp_instruments()
            if not _fp_instruments:
                return jsonify({"success": False,
                                "message": "Could not load scrip master."}), 503

    body  = request.get_json(force=True) or {}
    interval = str(body.get("interval", "D")).strip()
    if interval not in {"1", "5", "15", "25", "60", "D"}:
        return jsonify({"success": False, "message": "Invalid interval."}), 400

    def _num(key, default, lo, hi, cast=float):
        try:
            v = cast(body.get(key, default))
        except (TypeError, ValueError):
            v = default
        return max(lo, min(hi, v))

    rng = _cdc_normalize_range(
        interval,
        body.get("from_date"),
        body.get("to_date"),
        body.get("rolling_window", _CDC_DEFAULT_WINDOW.get(interval, 80)),
    )

    params = ScanParams(
        interval=interval,
        from_date=rng["from_date"],
        to_date=rng["to_date"],
        sector=str(body.get("sector", "")).strip(),
        rolling_window=rng["rolling_window"],
        lower_density=_num("lower_density", 0.01, 0.0, 0.5),
        upper_density=_num("upper_density", 0.99, 0.5, 1.0),
        min_correlation=_num("min_correlation", 0.80, -1.0, 1.0),
    )

    sectors = load_sector_map(SECTOR_CSV)
    if not sectors:
        return jsonify({"success": False,
                        "message": "Sector.csv missing or empty. Add Instrument,Sector rows."}), 400

    started = _scan_manager.start(
        access_token, resolver, sectors, params,
        fetcher=_yahoo_price_fetcher(interval, rng["from_date"], rng["to_date"]) if use_yahoo else None,
    )
    if not started:
        return jsonify({"success": False,
                        "message": "A scan is already running."}), 409

    msg = "Scan started."
    if rng["clamped"]:
        msg = ("Scan started with adjusted range {} → {} (max {} days for this interval) "
               "and rolling window {}.").format(
            rng["from_date"], rng["to_date"], rng["max_days"], rng["rolling_window"])
    return jsonify({
        "success": True,
        "message": msg,
        "from_date": rng["from_date"],
        "to_date": rng["to_date"],
        "rolling_window": rng["rolling_window"],
        "clamped": rng["clamped"],
    })


@app.route("/api/analysis/cdc/status", methods=["GET"])
def cdc_scan_status():
    return jsonify(_scan_manager.status())


@app.route("/api/analysis/cdc/results", methods=["GET"])
def cdc_scan_results():
    return jsonify(_scan_manager.results())


@app.route("/api/analysis/cdc/cancel", methods=["POST"])
def cdc_scan_cancel():
    cancelled = _scan_manager.cancel()
    return jsonify({"success": cancelled,
                    "message": "Cancelling..." if cancelled else "No scan running."})


# ---------- Option Chain + Greeks ----------

@app.route("/api/5paisa/option-chain/underlyings", methods=["GET"])
def oc_underlyings():
    if not os.path.exists(FP_INSTRUMENTS_CSV):
        return jsonify({"success": False,
                        "message": "Instrument.csv missing. Connect / update scrip master first."}), 400
    items = list_underlyings()
    return jsonify({"success": True, "underlyings": items})


@app.route("/api/5paisa/option-chain/expiries", methods=["GET"])
def oc_expiries():
    symbol = request.args.get("symbol", "").strip().upper()
    if not symbol:
        return jsonify({"success": False, "message": "symbol is required."}), 400
    # Prefer local Instrument.csv (fast / offline). Optionally merge API expiries.
    dates = list_expiries(symbol)
    creds = load_credentials()
    c = creds.get("5paisa", {})
    access_token = c.get("access_token", "").strip()
    user_key = c.get("user_key", "").strip()
    client_code = c.get("client_code", "").strip()
    if access_token and user_key and client_code:
        try:
            api_dates = fp.get_expiry(user_key, client_code, access_token, "N", symbol)
            for d in api_dates:
                if d not in dates:
                    dates.append(d)
            dates = sorted(set(dates))
        except Exception:
            pass
    if not dates:
        return jsonify({"success": False,
                        "message": "No expiries found for {}. Update Instrument.csv.".format(symbol)}), 404
    return jsonify({"success": True, "symbol": symbol, "expiries": dates})


@app.route("/api/5paisa/option-chain", methods=["POST"])
def oc_chain():
    creds = load_credentials()
    c = creds.get("5paisa", {})
    access_token = c.get("access_token", "").strip()
    user_key = c.get("user_key", "").strip()
    client_code = c.get("client_code", "").strip()
    if not access_token:
        return jsonify({"success": False,
                        "message": "5Paisa not connected. Connect first."}), 401

    body = request.get_json(force=True) or {}
    symbol = str(body.get("symbol", "")).strip().upper()
    expiry = str(body.get("expiry", "")).strip()[:10]
    try:
        strike_window = int(body.get("strike_window", 12))
    except (TypeError, ValueError):
        strike_window = 12
    strike_window = max(5, min(40, strike_window))

    if not symbol or not expiry:
        return jsonify({"success": False, "message": "symbol and expiry are required."}), 400

    try:
        data = build_option_chain(
            user_key, client_code, access_token, symbol, expiry,
            strike_window=strike_window,
        )
        data["success"] = True
        return jsonify(data)
    except ValueError as e:
        return jsonify({"success": False, "message": str(e)}), 400
    except Exception as e:
        app.logger.exception("option-chain failed")
        return jsonify({"success": False, "message": str(e)}), 500


@app.route("/api/open-interest", methods=["POST"])
def open_interest_change():
    """
    OI Change vs Strike payload.

    Body: { symbol, expiries?: [YYYY-MM-DD], session_date?: YYYY-MM-DD }
    Live last-bucket OI when 5Paisa is connected; otherwise mock.
    """
    body = request.get_json(force=True) or {}
    symbol = str(body.get("symbol") or "NIFTY").strip().upper() or "NIFTY"
    session_date = str(body.get("session_date") or "").strip()[:10] or None
    expiries = body.get("expiries")
    if isinstance(expiries, str):
        expiries = [expiries]
    if not isinstance(expiries, list):
        expiries = None
    creds = load_credentials().get("5paisa", {})
    try:
        data = build_oi_change(
            symbol=symbol,
            expiries=expiries,
            session_date=session_date,
            creds=creds,
        )
        data["success"] = True
        return jsonify(data)
    except ValueError as e:
        return jsonify({"success": False, "message": str(e)}), 400
    except Exception as e:
        app.logger.exception("open-interest failed")
        return jsonify({"success": False, "message": str(e)}), 500


@app.route("/api/gamma-exposure", methods=["POST"])
def gamma_exposure():
    """
    GEX profile, gamma flip, regime score, and strategy signal.

    Body: { symbol, expiry?, strike_window? }
    Live when 5Paisa is connected; otherwise a sample NIFTY-style profile.
    """
    body = request.get_json(force=True) or {}
    symbol = str(body.get("symbol") or "NIFTY").strip().upper() or "NIFTY"
    expiry = str(body.get("expiry") or "").strip()[:10]
    try:
        strike_window = int(body.get("strike_window", 18))
    except (TypeError, ValueError):
        strike_window = 18
    creds = load_credentials().get("5paisa", {})
    try:
        data = build_gamma_exposure(
            symbol=symbol,
            expiry=expiry,
            creds=creds,
            strike_window=strike_window,
        )
        data["success"] = True
        return jsonify(data)
    except ValueError as e:
        return jsonify({"success": False, "message": str(e)}), 400
    except Exception as e:
        app.logger.exception("gamma-exposure failed")
        return jsonify({"success": False, "message": str(e)}), 500


@app.route("/api/analysis/cdc/pair-detail", methods=["POST"])
def cdc_pair_detail():
    """Full time-series dashboard payload for one pair."""
    use_yahoo = _cdc_use_yahoo()
    access_token = ""
    resolver = _resolve_symbol
    fetcher = None
    if use_yahoo:
        if not yf_broker.list_instruments():
            return jsonify({"success": False,
                            "message": "Yahoo Stock List.csv missing or empty."}), 400
        resolver = _resolve_yahoo_symbol
    else:
        creds = load_credentials()
        access_token = creds.get("5paisa", {}).get("access_token", "").strip()
        if not access_token:
            return jsonify({"success": False,
                            "message": "5Paisa not connected. Connect first."}), 401
        if not _fp_instruments:
            if _fp_instruments_loading:
                return jsonify({"success": False,
                                "message": "Scrip master still loading, try again shortly."}), 503
            _load_fp_instruments()
            if not _fp_instruments:
                return jsonify({"success": False, "message": "Could not load scrip master."}), 503

    body = request.get_json(force=True) or {}
    sym1 = str(body.get("instrument1", "")).strip().upper()
    sym2 = str(body.get("instrument2", "")).strip().upper()
    if not sym1 or not sym2:
        return jsonify({"success": False,
                        "message": "instrument1 and instrument2 are required."}), 400

    interval = str(body.get("interval", "D")).strip()
    if interval not in {"1", "5", "15", "25", "60", "D"}:
        return jsonify({"success": False, "message": "Invalid interval."}), 400

    def _num(key, default, lo, hi, cast=float):
        try:
            v = cast(body.get(key, default))
        except (TypeError, ValueError):
            v = default
        return max(lo, min(hi, v))

    rng = _cdc_normalize_range(
        interval,
        body.get("from_date"),
        body.get("to_date"),
        body.get("rolling_window", _CDC_DEFAULT_WINDOW.get(interval, 80)),
    )

    params = ScanParams(
        interval=interval,
        from_date=rng["from_date"],
        to_date=rng["to_date"],
        sector=str(body.get("sector", "")).strip(),
        rolling_window=rng["rolling_window"],
        lower_density=_num("lower_density", 0.01, 0.0, 0.5),
        upper_density=_num("upper_density", 0.99, 0.5, 1.0),
    )

    try:
        cache = PriceCache(
            access_token, resolver, params.interval,
            params.from_date, params.to_date, max_workers=2,
            fetcher=_yahoo_price_fetcher(params.interval, params.from_date, params.to_date) if use_yahoo else None,
        )
        cache.prefetch([sym1, sym2])
        d1, d2 = cache.get(sym1), cache.get(sym2)
        if d1 is None:
            return jsonify({"success": False,
                            "message": "No data for {}: {}".format(sym1, cache.error(sym1))}), 404
        if d2 is None:
            return jsonify({"success": False,
                            "message": "No data for {}: {}".format(sym2, cache.error(sym2))}), 404
        detail = compute_pair_detail(params.sector or "", sym1, sym2, d1, d2, params)
        detail["success"] = True
        detail["params"] = {
            "interval": params.interval, "from_date": params.from_date,
            "to_date": params.to_date, "rolling_window": params.rolling_window,
            "lower_density": params.lower_density, "upper_density": params.upper_density,
        }
        return jsonify(detail)
    except ValueError as e:
        return jsonify({"success": False, "message": str(e)}), 422
    except Exception as e:
        app.logger.exception("pair-detail failed")
        return jsonify({"success": False, "message": str(e)}), 500


@app.route("/api/analysis/cdc/pair-live", methods=["POST"])
def cdc_pair_live():
    """Live LTPs + min-capital equal-notional hedge (cash and futures lots)."""
    creds = load_credentials()
    if not creds.get("5paisa", {}).get("access_token", "").strip():
        return jsonify({"success": False,
                        "message": "5Paisa not connected. Connect first."}), 401
    body = request.get_json(force=True) or {}
    sym1 = str(body.get("instrument1", "")).strip().upper()
    sym2 = str(body.get("instrument2", "")).strip().upper()
    if not sym1 or not sym2:
        return jsonify({"success": False,
                        "message": "instrument1 and instrument2 are required."}), 400

    def _px(key):
        try:
            v = float(body.get(key))
        except (TypeError, ValueError):
            return None
        if v != v or v <= 0:
            return None
        return v

    try:
        data = build_pair_live(
            creds, sym1, sym2,
            sell_symbol=str(body.get("sell_symbol") or "").strip().upper(),
            last_close1=_px("last_close1"),
            last_close2=_px("last_close2"),
        )
        return jsonify(data)
    except Exception as e:
        app.logger.exception("pair-live failed")
        return jsonify({"success": False, "message": str(e)}), 500


if __name__ == "__main__":
    socketio.start_background_task(_live_feed_worker)
    # Bind to 0.0.0.0 by default so iPhones/iPads on the same Wi-Fi network
    # can open TraderApp from their browser. Override with env vars, e.g.
    #   TRADERAPP_HOST=127.0.0.1 TRADERAPP_PORT=5001 ./mac/start_server.sh
    host = os.environ.get("TRADERAPP_HOST", "0.0.0.0")
    try:
        port = int(os.environ.get("TRADERAPP_PORT", "5000"))
    except ValueError:
        port = 5000
    try:
        _probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        _probe.connect(("8.8.8.8", 80))
        lan_ip = _probe.getsockname()[0]
        _probe.close()
    except Exception:
        lan_ip = "127.0.0.1"
    print("=" * 56)
    print("  TraderApp is running")
    print("  Local (this computer): http://127.0.0.1:{}/".format(port))
    if host != "127.0.0.1":
        print("  iPhone/iPad (same Wi-Fi): http://{}:{}/".format(lan_ip, port))
    print("=" * 56)
    socketio.run(app, debug=True, host=host, port=port, allow_unsafe_werkzeug=True)
else:
    socketio.start_background_task(_live_feed_worker)

