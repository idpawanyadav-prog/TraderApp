"""
Option chain builder for 5Paisa.

Builds CE/PE rows from Instrument.csv, then enriches with MarketFeed quotes
and live Option Greeks (NSE WebSocket). Falls back to Black-Scholes Greeks
when the live feed is empty (e.g. after market hours).
"""
import csv
import json
import math
import os
from collections import defaultdict
from datetime import datetime, timedelta, timezone

import fivepaisa as fp

_APP_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
INSTRUMENT_CSV = os.path.join(_APP_ROOT, "Instrument.csv")
_OI_CACHE_PATH = os.path.join(_APP_ROOT, "oi_prev_close.json")
_IST = timezone(timedelta(hours=5, minutes=30))

# Last known OI per scrip so we can compute today's change vs previous close.
# {scrip_code: {"d": "YYYY-MM-DD", "base": prev_close_oi, "oi": last_oi}}
_OI_STATE = None

__all__ = [
    "list_underlyings",
    "list_expiries",
    "build_option_chain",
]


def _safe_float(v, default=None):
    try:
        if v is None or v == "":
            return default
        return float(v)
    except (TypeError, ValueError):
        return default


def _ist_today():
    return datetime.now(_IST).strftime("%Y-%m-%d")


def _load_oi_state():
    global _OI_STATE
    if _OI_STATE is not None:
        return _OI_STATE
    _OI_STATE = {}
    try:
        with open(_OI_CACHE_PATH, encoding="utf-8") as f:
            raw = json.load(f) or {}
        if isinstance(raw, dict):
            _OI_STATE = raw
    except Exception:
        _OI_STATE = {}
    return _OI_STATE


def _save_oi_state():
    if _OI_STATE is None:
        return
    try:
        with open(_OI_CACHE_PATH, "w", encoding="utf-8") as f:
            json.dump(_OI_STATE, f)
    except Exception:
        pass


def _day_oi_change(code, oi, api_chg, prev_oi=None):
    """Today's OI change vs previous close, not vs last refresh."""
    today = _ist_today()
    st = _load_oi_state()
    rec = st.get(str(code)) or {}
    rec_d = rec.get("d")
    last = rec.get("oi")
    base = rec.get("base")

    if rec_d != today:
        if rec_d and last is not None:
            base = last
        elif prev_oi is not None:
            base = prev_oi
        elif api_chg is not None and oi is not None:
            base = oi - api_chg
        else:
            base = oi
        rec = {"d": today, "base": base, "oi": oi}
    else:
        if base is None:
            if prev_oi is not None:
                base = prev_oi
            elif api_chg is not None and oi is not None:
                base = oi - api_chg
            else:
                base = last if last is not None else oi
        rec = {"d": today, "base": base, "oi": oi if oi is not None else last}
    st[str(code)] = rec

    if api_chg is not None:
        return api_chg
    if oi is None or rec.get("base") is None:
        return None
    return oi - rec["base"]


def list_underlyings(limit=80):
    """Popular NSE option underlyings from Instrument.csv (by contract count)."""
    counts = defaultdict(int)
    if not os.path.exists(INSTRUMENT_CSV):
        return []
    with open(INSTRUMENT_CSV, encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row in reader:
            if row.get("Exch", "").strip() != "N":
                continue
            if row.get("ExchType", "").strip() != "D":
                continue
            if row.get("ScripType", "").strip().upper() not in ("CE", "PE"):
                continue
            root = (row.get("SymbolRoot") or "").strip().upper()
            if root:
                counts[root] += 1
    ranked = sorted(counts.items(), key=lambda x: -x[1])
    return [{"symbol": s, "contracts": n} for s, n in ranked[:limit]]


def list_expiries(symbol, exch="N"):
    """Distinct upcoming/active expiries for SymbolRoot from Instrument.csv."""
    symbol = (symbol or "").strip().upper()
    dates = set()
    if not symbol or not os.path.exists(INSTRUMENT_CSV):
        return []
    today = datetime.today().strftime("%Y-%m-%d")
    with open(INSTRUMENT_CSV, encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row in reader:
            if row.get("Exch", "").strip() != exch:
                continue
            if row.get("ExchType", "").strip() != "D":
                continue
            if row.get("ScripType", "").strip().upper() not in ("CE", "PE"):
                continue
            root = (row.get("SymbolRoot") or "").strip().upper()
            if root != symbol:
                continue
            exp = (row.get("Expiry") or "").strip()[:10]
            if exp and exp >= today:
                dates.add(exp)
    return sorted(dates)


def _find_underlying(symbol, exch="N"):
    """Return best cash/index scrip for spot quote."""
    symbol = (symbol or "").strip().upper()
    prefer = None
    fallback = None
    if not os.path.exists(INSTRUMENT_CSV):
        return None
    with open(INSTRUMENT_CSV, encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row in reader:
            name = (row.get("Name") or "").strip().upper()
            root = (row.get("SymbolRoot") or "").strip().upper()
            if name != symbol and root != symbol:
                continue
            if row.get("Exch", "").strip() != exch:
                # Prefer NSE; keep BSE cash as weak fallback
                if row.get("ExchType", "").strip() == "C" and fallback is None:
                    fallback = row
                continue
            st = row.get("ScripType", "").strip().upper()
            et = row.get("ExchType", "").strip().upper()
            if et == "C" and st == "EQ":
                return {
                    "scrip_code": row["ScripCode"].strip(),
                    "exch": row["Exch"].strip(),
                    "exch_type": "C",
                    "trading_symbol": row["Name"].strip(),
                }
            if et == "C" and prefer is None:
                prefer = row
    row = prefer or fallback
    if not row:
        return None
    return {
        "scrip_code": row["ScripCode"].strip(),
        "exch": row["Exch"].strip(),
        "exch_type": row["ExchType"].strip(),
        "trading_symbol": row["Name"].strip(),
    }


def _load_contracts(symbol, expiry, exch="N"):
    symbol = (symbol or "").strip().upper()
    expiry = (expiry or "").strip()[:10]
    by_strike = {}
    with open(INSTRUMENT_CSV, encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row in reader:
            if row.get("Exch", "").strip() != exch:
                continue
            if row.get("ExchType", "").strip() != "D":
                continue
            st = row.get("ScripType", "").strip().upper()
            if st not in ("CE", "PE"):
                continue
            root = (row.get("SymbolRoot") or "").strip().upper()
            if root != symbol:
                continue
            exp = (row.get("Expiry") or "").strip()[:10]
            if exp != expiry:
                continue
            strike = _safe_float(row.get("StrikeRate"))
            if strike is None:
                continue
            key = round(strike, 4)
            slot = by_strike.setdefault(key, {"strike": key, "ce": None, "pe": None})
            lot = int(_safe_float(row.get("LotSize"), 1) or 1)
            side = {
                "scrip_code": row["ScripCode"].strip(),
                "exch": "N",
                "exch_type": "D",
                "scrip_type": st,
                "trading_symbol": row["Name"].strip(),
                "name": (row.get("FullName") or row["Name"]).strip(),
                "lot_size": max(1, lot),
            }
            if st == "CE":
                slot["ce"] = side
            else:
                slot["pe"] = side
    return [by_strike[k] for k in sorted(by_strike.keys())]


def _norm_cdf(x):
    return 0.5 * (1.0 + math.erf(x / math.sqrt(2.0)))


def _norm_pdf(x):
    return math.exp(-0.5 * x * x) / math.sqrt(2.0 * math.pi)


def _bs_price(spot, strike, t, r, sigma, opt_type):
    if t <= 0 or sigma <= 0 or spot <= 0 or strike <= 0:
        return max(0.0, (spot - strike) if opt_type == "CE" else (strike - spot))
    sqrt_t = math.sqrt(t)
    d1 = (math.log(spot / strike) + (r + 0.5 * sigma * sigma) * t) / (sigma * sqrt_t)
    d2 = d1 - sigma * sqrt_t
    if opt_type == "CE":
        return spot * _norm_cdf(d1) - strike * math.exp(-r * t) * _norm_cdf(d2)
    return strike * math.exp(-r * t) * _norm_cdf(-d2) - spot * _norm_cdf(-d1)


def _implied_vol(spot, strike, t, r, price, opt_type):
    if price is None or price <= 0 or spot <= 0 or strike <= 0 or t <= 0:
        return None
    lo, hi = 1e-4, 5.0
    for _ in range(60):
        mid = 0.5 * (lo + hi)
        val = _bs_price(spot, strike, t, r, mid, opt_type)
        if abs(val - price) < 1e-4:
            return mid
        if val > price:
            hi = mid
        else:
            lo = mid
    return 0.5 * (lo + hi)


def _bs_greeks(spot, strike, t, r, sigma, opt_type):
    if not sigma or sigma <= 0 or t <= 0 or spot <= 0 or strike <= 0:
        return {}
    sqrt_t = math.sqrt(t)
    d1 = (math.log(spot / strike) + (r + 0.5 * sigma * sigma) * t) / (sigma * sqrt_t)
    d2 = d1 - sigma * sqrt_t
    pdf = _norm_pdf(d1)
    gamma = pdf / (spot * sigma * sqrt_t)
    vega = spot * pdf * sqrt_t / 100.0  # per 1% IV
    if opt_type == "CE":
        delta = _norm_cdf(d1)
        theta = (-(spot * pdf * sigma) / (2 * sqrt_t)
                 - r * strike * math.exp(-r * t) * _norm_cdf(d2)) / 365.0
        rho = strike * t * math.exp(-r * t) * _norm_cdf(d2) / 100.0
    else:
        delta = _norm_cdf(d1) - 1.0
        theta = (-(spot * pdf * sigma) / (2 * sqrt_t)
                 + r * strike * math.exp(-r * t) * _norm_cdf(-d2)) / 365.0
        rho = -strike * t * math.exp(-r * t) * _norm_cdf(-d2) / 100.0
    # Common higher-order approximations
    vanna = vega / spot * (1.0 - d1 / (sigma * sqrt_t)) if sigma and sqrt_t else None
    volga = vega * d1 * d2 / sigma if sigma else None
    charm = None
    try:
        charm = (-pdf * (2.0 * r * t - d2 * sigma * sqrt_t) /
                 (2.0 * t * sigma * sqrt_t)) / 365.0
        if opt_type == "PE":
            charm = charm  # same leading term; ignore discrete bits for display
    except Exception:
        charm = None
    return {
        "iv": sigma,
        "delta": delta,
        "gamma": gamma,
        "theta": theta,
        "vega": vega,
        "rho": rho,
        "vanna": vanna,
        "volga": volga,
        "charm": charm,
        "source": "bs",
    }


def _years_to_expiry(expiry):
    try:
        exp = datetime.strptime(expiry[:10], "%Y-%m-%d")
    except Exception:
        return 1.0 / 365.0
    days = max((exp - datetime.today()).total_seconds() / 86400.0, 1.0 / 24.0)
    return days / 365.0


_GREEK_KEYS = (
    "iv", "delta", "gamma", "theta", "vega", "rho",
    "iv_vwap", "vanna", "charm", "speed", "zomma", "color", "volga", "veta", "tgr", "tv", "dtr",
)


def _empty_side():
    side = {
        "scrip_code": "",
        "ltp": None, "open": None, "high": None, "low": None, "prev_close": None,
        "chg": None, "chg_pct": None, "volume": None, "oi": None, "oi_chg": None,
        "oi_chg_day": None,
        "bid_qty": None, "ask_qty": None, "avg_price": None,
        "lot_size": 1,
        "greeks_source": "",
    }
    for k in _GREEK_KEYS:
        side[k] = None
    return side


def _apply_greeks(side, greek, source):
    if not greek:
        return
    any_val = False
    for k in _GREEK_KEYS:
        if greek.get(k) is not None:
            side[k] = greek.get(k)
            any_val = True
    if any_val:
        side["greeks_source"] = source


def _merge_side(contract, quote, greek, spot, strike, t, opt_type):
    side = _empty_side()
    if not contract:
        return side
    code = contract["scrip_code"]
    side["scrip_code"] = code
    side["trading_symbol"] = contract.get("trading_symbol", "")
    side["lot_size"] = contract.get("lot_size") or 1
    if quote:
        side["ltp"] = quote.get("ltp")
        side["open"] = quote.get("open")
        side["high"] = quote.get("high")
        side["low"] = quote.get("low")
        side["prev_close"] = quote.get("prev_close")
        side["chg"] = quote.get("chg")
        side["chg_pct"] = quote.get("chg_pct")
        side["volume"] = quote.get("volume")
        side["oi"] = quote.get("oi")
        side["oi_chg_day"] = quote.get("oi_chg_day")
        side["bid_qty"] = quote.get("bid_qty")
        side["ask_qty"] = quote.get("ask_qty")
        side["avg_price"] = quote.get("avg_price")
        if side["oi"] is not None or side["oi_chg_day"] is not None:
            side["oi_chg"] = _day_oi_change(
                code, side["oi"], side["oi_chg_day"], quote.get("prev_oi"),
            )

    if greek and any(greek.get(k) is not None for k in ("iv", "delta", "theta", "vega", "gamma")):
        _apply_greeks(side, greek, "live")
    elif spot and side.get("ltp"):
        iv = _implied_vol(spot, strike, t, 0.06, side["ltp"], opt_type)
        g = _bs_greeks(spot, strike, t, 0.06, iv, opt_type) if iv else {}
        if g:
            _apply_greeks(side, g, "bs")
    return side


def build_option_chain(user_key, client_code, access_token, symbol, expiry,
                       strike_window=12, exch="N"):
    """
    Full option chain for symbol/expiry with quotes + Greeks.
    strike_window: number of strikes each side of ATM (default 12).
    """
    symbol = (symbol or "").strip().upper()
    expiry = (expiry or "").strip()[:10]
    if not symbol or not expiry:
        raise ValueError("symbol and expiry are required")
    if not os.path.exists(INSTRUMENT_CSV):
        raise ValueError("Instrument.csv not found. Connect / update scrip master first.")

    rows = _load_contracts(symbol, expiry, exch=exch)
    if not rows:
        raise ValueError("No option contracts found for {} {}".format(symbol, expiry))

    underlying = _find_underlying(symbol, exch=exch)

    # Phase 1: spot only (needed to pick ATM window)
    spot = None
    if underlying:
        try:
            uq = fp.market_feed(user_key, client_code, access_token, [underlying])
            q = uq.get(str(underlying["scrip_code"])) or {}
            spot = q.get("ltp") or q.get("prev_close")
            spot_chg = q.get("chg")
            spot_chg_pct = q.get("chg_pct")
        except Exception:
            spot = None
            spot_chg = None
            spot_chg_pct = None
    else:
        spot_chg = None
        spot_chg_pct = None
    if spot is None:
        spot = rows[len(rows) // 2]["strike"]

    atm_idx = min(range(len(rows)), key=lambda i: abs(rows[i]["strike"] - spot))
    lo = max(0, atm_idx - int(strike_window))
    hi = min(len(rows), atm_idx + int(strike_window) + 1)
    window_rows = rows[lo:hi]

    feed_req = []
    for r in window_rows:
        if r.get("ce"):
            feed_req.append(r["ce"])
        if r.get("pe"):
            feed_req.append(r["pe"])

    quotes = {}
    try:
        quotes = fp.market_feed(user_key, client_code, access_token, feed_req)
    except Exception:
        quotes = {}

    scrip_codes = []
    for r in window_rows:
        if r.get("ce"):
            scrip_codes.append(r["ce"]["scrip_code"])
        if r.get("pe"):
            scrip_codes.append(r["pe"]["scrip_code"])

    greeks = {}
    greeks_source = "none"
    try:
        greeks = fp.fetch_greeks_snapshot(access_token, scrip_codes, wait_seconds=2.8)
        if greeks:
            greeks_source = "live"
    except Exception:
        greeks = {}

    t = _years_to_expiry(expiry)
    chain = []
    for r in window_rows:
        strike = r["strike"]
        ce_q = quotes.get(str(r["ce"]["scrip_code"])) if r.get("ce") else None
        pe_q = quotes.get(str(r["pe"]["scrip_code"])) if r.get("pe") else None
        ce_g = greeks.get(str(r["ce"]["scrip_code"])) if r.get("ce") else None
        pe_g = greeks.get(str(r["pe"]["scrip_code"])) if r.get("pe") else None
        chain.append({
            "strike": strike,
            "atm": False,
            "ce": _merge_side(r.get("ce"), ce_q, ce_g, spot, strike, t, "CE"),
            "pe": _merge_side(r.get("pe"), pe_q, pe_g, spot, strike, t, "PE"),
        })

    # Mark single ATM row
    if chain:
        best = min(chain, key=lambda x: abs(x["strike"] - spot))
        for row in chain:
            row["atm"] = row is best

    live_count = sum(
        1 for row in chain
        for side in (row["ce"], row["pe"])
        if side.get("greeks_source") == "live"
    )
    if live_count == 0 and any(
        side.get("greeks_source") == "bs"
        for row in chain for side in (row["ce"], row["pe"])
    ):
        greeks_source = "bs"

    _save_oi_state()
    return {
        "symbol": symbol,
        "expiry": expiry,
        "exch": exch,
        "spot": spot,
        "spot_chg": spot_chg,
        "spot_chg_pct": spot_chg_pct,
        "underlying": underlying,
        "strike_count": len(chain),
        "greeks_source": greeks_source,
        "chain": chain,
    }
