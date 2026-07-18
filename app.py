import sys
import os

# Add local libs folder to path so all dependencies are self-contained
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "libs"))

import csv
import json
import time
import uuid
import pyotp
import requests as http
from datetime import datetime, timedelta
import threading
from flask import Flask, render_template, request, jsonify, session, make_response
from flask_socketio import SocketIO, emit, disconnect

# 5Paisa broker module
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "broker"))
import fivepaisa as fp

app = Flask(__name__)
app.secret_key = os.urandom(24)
socketio = SocketIO(app, cors_allowed_origins="*", async_mode="threading")

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
        access_token, exch, exch_type, scrip_code, interval, from_date, to_date
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

def _load_fp_instruments():
    global _fp_instruments, _fp_instruments_loading, _fp_instruments_last_loaded
    _fp_instruments_loading = True
    try:
        _fp_instruments = fp.download_scrip_master()
        _fp_instruments_last_loaded = datetime.utcnow()
        print("5Paisa scrip master loaded: " + str(len(_fp_instruments)) + " instruments")
    except Exception as e:
        _fp_instruments = []
        print("5Paisa scrip master load failed: " + str(e))
    finally:
        _fp_instruments_loading = False


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

DEFAULT_APP_SETTINGS = {
    "api_enabled": False,
    "dhan_enabled": True,
    "5paisa_enabled": True,
    "chart_refresh_interval": 0,
    "enabled_exchanges": ["N", "B", "M"],
    "enabled_instrument_types": ["C", "D"],
    "ta_enabled": False,
    "ta_indicators": [],
}

def load_app_settings() -> dict:
    if not os.path.exists(SETTINGS_FILE):
        s = dict(DEFAULT_APP_SETTINGS)
        s["api_key"] = str(uuid.uuid4())
        return s
    with open(SETTINGS_FILE, "r") as f:
        s = json.load(f)
    for k, v in DEFAULT_APP_SETTINGS.items():
        if k not in s:
            s[k] = v
    if "api_key" not in s:
        s["api_key"] = str(uuid.uuid4())
    return s


def save_app_settings(data: dict) -> None:
    existing = load_app_settings()
    existing.update(data)
    with open(SETTINGS_FILE, "w") as f:
        json.dump(existing, f, indent=2)


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
    fp_connected    = session.get("5paisa_connected", False)
    fp_user         = session.get("5paisa_user", {})
    fp_creds        = creds.get("5paisa", {})
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
        c["token_expiry_dt"] = (datetime.utcfromtimestamp(exp).strftime("%Y-%m-%d %H:%M UTC") if exp else "unknown")
        save_credentials({"5paisa": c})

        import threading
        threading.Thread(target=_load_fp_instruments, daemon=True).start()

        margin = fp.get_margin(user_key, client_code, access_token)
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
    return jsonify({
        "loaded":       len(_fp_instruments) > 0,
        "count":        len(_fp_instruments),
        "loading":      _fp_instruments_loading,
        "last_loaded":  _fp_instruments_last_loaded.strftime("%Y-%m-%d %H:%M UTC") if _fp_instruments_last_loaded else None,
    })


@app.route("/api/5paisa/scrip-master/update", methods=["POST"])
def scrip_master_update():
    creds        = load_credentials()
    access_token = creds.get("5paisa", {}).get("access_token", "").strip()
    if not access_token:
        return jsonify({"success": False, "message": "5Paisa not connected. Connect first to update scrip master."}), 400
    if _fp_instruments_loading:
        return jsonify({"success": False, "message": "Already loading scrip master, please wait..."}), 409
    import threading
    threading.Thread(target=_load_fp_instruments, daemon=True).start()
    return jsonify({"success": True, "message": "Scrip master update started in background."})


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


# ---------- Chart Data ----------

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
    interval     = payload.get("interval", "1")      # "1","5","15","25","60" or "D"
    from_date    = payload.get("from_date", "")
    to_date      = payload.get("to_date", "")

    if not security_id:
        return jsonify({"success": False, "message": "security_id is required."}), 400

    # Default date range
    today = datetime.today()
    if not to_date:
        to_date = today.strftime("%Y-%m-%d")
    if not from_date:
        if interval == "D":
            from_date = (today - timedelta(days=365)).strftime("%Y-%m-%d")
        else:
            from_date = (today - timedelta(days=4)).strftime("%Y-%m-%d")

    headers = {
        "access-token":  access_token,
        "client-id":     client_id,
        "Content-type":  "application/json",
        "Accept":        "application/json",
    }

    try:
        if interval == "D":
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
                             json=body, headers=headers, timeout=15)
        else:
            body = {
                "dhanClientId":    client_id,
                "securityId":      security_id,
                "exchangeSegment": exch_seg,
                "instrument":      instrument,
                "interval":        int(interval),
                "fromDate":        from_date,
                "toDate":          to_date,
            }
            resp = http.post(f"{DHAN_BASE_URL}/charts/intraday",
                             json=body, headers=headers, timeout=15)

        resp.raise_for_status()
        data = resp.json()

        # Dhan returns parallel arrays: timestamp, open, high, low, close, volume
        timestamps = data.get("timestamp", [])
        opens      = data.get("open",      [])
        highs      = data.get("high",      [])
        lows       = data.get("low",       [])
        closes     = data.get("close",     [])
        volumes    = data.get("volume",    [])

        candles = []
        for i, ts in enumerate(timestamps):
            candles.append({
                "time":   ts,
                "open":   opens[i]  if i < len(opens)  else 0,
                "high":   highs[i]  if i < len(highs)  else 0,
                "low":    lows[i]   if i < len(lows)   else 0,
                "close":  closes[i] if i < len(closes) else 0,
                "volume": volumes[i] if i < len(volumes) else 0,
            })

        candles = _filter_market_hours(candles, interval)
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

    def score(i):
        sym   = i["trading_symbol"].upper()
        nse   = i["exch"] == "N" and i["exch_type"] == "C"
        exact = sym == q
        starts = sym.startswith(q)
        return (0 if exact else 1 if starts else 2, 0 if nse else 1)

    results = [
        i for i in _fp_instruments
        if q in i["trading_symbol"].upper() or q in i["name"].upper()
    ]
    results.sort(key=score)
    return jsonify(results[:limit])


# ---------- 5Paisa Chart Data ----------

@app.route("/api/5paisa/chart/data", methods=["POST"])
def fp_chart_data():
    if not session.get("5paisa_connected"):
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

    if not scrip_code:
        return jsonify({"success": False, "message": "scrip_code is required."}), 400

    today = datetime.today()
    if not to_date:
        to_date = today.strftime("%Y-%m-%d")
    if not from_date:
        if interval == "D":
            from_date = (today - timedelta(days=365)).strftime("%Y-%m-%d")
        else:
            from_date = (today - timedelta(days=4)).strftime("%Y-%m-%d")

    try:
        candles = fp.get_historical_data(
            access_token, exch, exch_type, scrip_code, interval, from_date, to_date
        )
        candles = _filter_market_hours(candles, interval)
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


# ---------- Settings API ----------

@app.route("/api/settings", methods=["GET"])
def get_settings():
    s = load_app_settings()
    return jsonify({
        "api_enabled": s.get("api_enabled", False),
        "dhan_enabled": s.get("dhan_enabled", True),
        "5paisa_enabled": s.get("5paisa_enabled", True),
        "chart_refresh_interval": int(s.get("chart_refresh_interval", 0) or 0),
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
    save_app_settings(s)
    return jsonify({
        "success": True,
        "dhan_enabled": s.get("dhan_enabled", True),
        "5paisa_enabled": s.get("5paisa_enabled", True),
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


@app.route("/api/settings/markets", methods=["GET", "POST"])
def market_settings():
    valid_exchanges = {"N", "B", "M"}
    valid_instr_types = {"C", "D"}
    if request.method == "GET":
        s = load_app_settings()
        return jsonify({
            "enabled_exchanges": s.get("enabled_exchanges", ["N", "B", "M"]),
            "enabled_instrument_types": s.get("enabled_instrument_types", ["C", "D"]),
        })

    body = request.get_json(force=True) or {}
    exchanges = body.get("enabled_exchanges", ["N", "B", "M"])
    instr_types = body.get("enabled_instrument_types", ["C", "D"])

    exchanges = [x for x in exchanges if x in valid_exchanges]
    instr_types = [x for x in instr_types if x in valid_instr_types]

    s = load_app_settings()
    s["enabled_exchanges"] = exchanges or ["N", "B", "M"]
    s["enabled_instrument_types"] = instr_types or ["C", "D"]
    save_app_settings(s)
    return jsonify({
        "success": True,
        "enabled_exchanges": s["enabled_exchanges"],
        "enabled_instrument_types": s["enabled_instrument_types"],
    })


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
            cleaned = []
            for ind in indicators:
                if not isinstance(ind, dict):
                    continue
                ind_type = str(ind.get("type", "")).strip().lower()
                if not ind_type or ind_type not in TA_CATALOG:
                    continue
                params = ind.get("params", {}) if isinstance(ind.get("params", {}), dict) else {}
                cleaned.append({
                    "id": str(ind.get("id", "")).strip() or ind_type,
                    "type": ind_type,
                    "params": params,
                })
            s["ta_indicators"] = cleaned

    save_app_settings(s)
    return jsonify({
        "success": True,
        "ta_enabled": bool(s.get("ta_enabled", False)),
        "ta_indicators": s.get("ta_indicators", []),
    })


@app.route("/public/api/ta/catalog", methods=["GET", "OPTIONS"])
def public_ta_catalog():
    if request.method == "OPTIONS":
        return _cors(make_response("", 204))
    return _cors(make_response(jsonify({"success": True, "indicators": TA_CATALOG}), 200))


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
        "timestamp":         datetime.utcnow().isoformat() + "Z",
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

    def score(i):
        sym = i["trading_symbol"].upper()
        nse = i["exch"] == "N" and i["exch_type"] == "C"
        return (0 if sym == q else 1 if sym.startswith(q) else 2, 0 if nse else 1)

    results = [i for i in _fp_instruments
               if q in i["trading_symbol"].upper() or q in i["name"].upper()]
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
    payload    = request.get_json(force=True)
    scrip_code = str(payload.get("scrip_code", "")).strip()
    exch       = payload.get("exch", "N").strip()
    exch_type  = payload.get("exch_type", "C").strip()
    interval   = payload.get("interval", "15")
    today      = datetime.today()
    from_date  = payload.get("from_date") or (today - timedelta(days=4)).strftime("%Y-%m-%d")
    to_date    = payload.get("to_date")   or today.strftime("%Y-%m-%d")
    if not scrip_code:
        return _cors(make_response(jsonify({"error": "scrip_code required."}), 400))
    try:
        candles = fp.get_historical_data(access_token, exch, exch_type, scrip_code, interval, from_date, to_date)
        candles = _filter_market_hours(candles, interval)
        return _cors(make_response(jsonify({"success": True, "candles": candles, "count": len(candles)}), 200))
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


_INTERVAL_MINS = {"1": 1, "5": 5, "15": 15, "25": 30, "60": 60}
_IST = timedelta(hours=5, minutes=30)


def _filter_market_hours(candles, interval):
    """Keep intraday candles within 09:15-15:30 IST.
    Also keep candles after 15:30 if volume > 0.
    Candles before 09:15 are always dropped."""
    if interval == "D":
        return candles
    result = []
    for c in candles:
        ist_time = (datetime.utcfromtimestamp(c["time"]) + _IST).strftime("%H:%M:%S")
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
        prev_date = (datetime.utcfromtimestamp(prev["time"]) + _IST).date()
        curr_date = (datetime.utcfromtimestamp(curr["time"]) + _IST).date()
        if prev_date == curr_date:
            # Same trading day — fill any missing slots within this day
            while expected_ts < curr["time"]:
                fill_date = (datetime.utcfromtimestamp(expected_ts) + _IST).date()
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
        "D":   lambda c: (datetime.utcfromtimestamp(c["time"]) + _IST).strftime("%Y-%m-%d %H:%M:%S"),
        "DTM": lambda c: (datetime.utcfromtimestamp(c["time"]) + _IST).strftime("%Y-%m-%d %H:%M:%S"),
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


def _normalize_ta_indicators(raw_indicators):
    out = []
    for ind in raw_indicators or []:
        if not isinstance(ind, dict):
            continue
        ind_type = str(ind.get("type", "")).strip().lower()
        if not ind_type:
            continue
        params = ind.get("params", {}) if isinstance(ind.get("params", {}), dict) else {}
        out.append({
            "id": str(ind.get("id", "")).strip() or ind_type,
            "type": ind_type,
            "params": params,
        })
    return out


def _apply_ta_indicators(candles, indicators):
    if not candles or not indicators:
        return candles

    closes = [_to_float(c.get("close", 0.0)) for c in candles]
    highs = [_to_float(c.get("high", 0.0)) for c in candles]
    lows = [_to_float(c.get("low", 0.0)) for c in candles]
    vols = [_to_float(c.get("volume", 0.0)) for c in candles]

    def p(params, name, default):
        return int(_to_float(params.get(name, default), default))

    for ind in indicators:
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

    return candles


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
    ta_param = request.args.get("TA", "false").strip().lower()
    use_ta = ta_param in ("1", "true", "yes", "y", "on")
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
                    inst["scrip_code"], interval, from_date, to_date
                )
                candles = _forward_fill_candles(candles, interval)
                candles = _filter_market_hours(candles, interval)
                for c in candles:
                    dtm = (datetime.utcfromtimestamp(c["time"]) + _IST).strftime("%Y-%m-%d %H:%M:%S")
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
        candles = fp.get_historical_data(access_token, exch, exch_type, scrip_code, interval, from_date, to_date)
        candles = _forward_fill_candles(candles, interval)
        candles = _filter_market_hours(candles, interval)
        applied_ta_ids = []
        if use_ta:
            s = load_app_settings()
            ta_enabled = bool(s.get("ta_enabled", False))
            ta_indicators = _normalize_ta_indicators(s.get("ta_indicators", []))
            if ta_enabled and ta_indicators:
                candles = _apply_ta_indicators(candles, ta_indicators)
                applied_ta_ids = [x["id"] for x in ta_indicators]

        field_codes = [f.strip().upper() for f in fields_param.split(",") if f.strip()] if fields_param else ["DTM", "O", "H", "L", "C", "V"]

        if version == "2":
            export_codes = list(field_codes)
            if use_ta and applied_ta_ids:
                for ta_id in applied_ta_ids:
                    if ta_id not in export_codes:
                        export_codes.append(ta_id)
            rows_data = _candles_to_field_rows(candles, export_codes)
            header = "|".join(export_codes)
            rows = [header]
            for row in rows_data:
                rows.append("|".join(str(row.get(k, "")) for k in export_codes))
            resp = make_response("\n".join(rows), 200)
            resp.headers["Content-Type"] = "text/plain; charset=utf-8"
            return _cors(resp)

        if fields_param:
            data = _candles_to_field_rows(candles, field_codes)
            return _cors(make_response(jsonify({
                "success": True, "symbol": resolved_symbol, "interval": interval,
                "from": from_date, "to": to_date, "fields": field_codes,
                "ta_applied": applied_ta_ids,
                "count": len(data), "data": data,
            }), 200))
        else:
            return _cors(make_response(jsonify({
                "success": True, "symbol": resolved_symbol, "scrip_code": scrip_code,
                "exch": exch, "exch_type": exch_type, "interval": interval,
                "ta_applied": applied_ta_ids,
                "from": from_date, "to": to_date, "count": len(candles), "candles": candles,
            }), 200))
    except Exception as e:
        return _cors(make_response(jsonify({"error": str(e)}), 500))



if __name__ == "__main__":
    socketio.start_background_task(_live_feed_worker)
    socketio.run(app, debug=True, host="127.0.0.1", port=5000)
else:
    socketio.start_background_task(_live_feed_worker)

