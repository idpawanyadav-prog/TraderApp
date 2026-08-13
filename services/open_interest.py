"""
Open Interest (OI Change vs Strike) data layer.

Payload shape from build_oi_change():
{
  "symbol": "NIFTY",
  "source": "live" | "mock",          # live = 5Paisa current OI; path is synthetic
  "source_note": str,
  "spot": float,
  "india_vix": float | None,
  "pcr": float | None,
  "session_date": "YYYY-MM-DD",
  "session_label": "Thu, 13 Aug",
  "market_open": "09:15",
  "market_close": "15:30",
  "times": ["09:15", ...],            # 5-minute buckets
  "minutes": [0, 5, ...],             # minutes from 09:15
  "spot_series": [float, ...],        # same length as times
  "expiries": [{date, label, kind, weekday}],
  "selected_expiries": ["YYYY-MM-DD", ...],
  "atm_strike": float,
  "strike_step": float,
  "strike_min": float,
  "strike_max": float,
  "strikes": [
    {
      "strike": float,
      "call_oi": [float, ...],        # OI at each time bucket
      "put_oi": [float, ...]
    },
    ...
  ]
}

Live mode uses MarketSnapshot OI for the last bucket. Earlier buckets are a
deterministic synthetic path ending at that live OI (5Paisa historical candles
do not include OI). Swap _synth_paths() for a real snapshot store when available.
"""
import csv
import math
import os
import random
import threading
import time
from collections import defaultdict, deque
from datetime import datetime, timedelta

import fivepaisa as fp

from services.option_chain import (
    _find_underlying,
    _load_contracts,
    list_expiries,
    list_underlyings,
)

_APP_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
INSTRUMENT_CSV = os.path.join(_APP_ROOT, "Instrument.csv")

MARKET_OPEN = "09:15"
MARKET_CLOSE = "15:30"
BUCKET_MIN = 1
SESSION_MINUTES = 6 * 60 + 15  # 09:15 → 15:30
_SNAP_LOCK = threading.Lock()
_SNAPS = defaultdict(lambda: deque(maxlen=480))

__all__ = [
    "build_oi_change",
    "list_underlyings",
]


def _safe_float(v, default=None):
    try:
        if v is None or v == "":
            return default
        return float(v)
    except (TypeError, ValueError):
        return default


def _session_buckets():
    times = []
    minutes = []
    h, m = 9, 15
    elapsed = 0
    while elapsed <= SESSION_MINUTES:
        times.append("{:02d}:{:02d}".format(h, m))
        minutes.append(elapsed)
        elapsed += BUCKET_MIN
        m += BUCKET_MIN
        if m >= 60:
            h += m // 60
            m = m % 60
    return times, minutes


def _fmt_session_label(iso_date):
    try:
        dt = datetime.strptime(iso_date[:10], "%Y-%m-%d")
    except Exception:
        dt = datetime.today()
    return dt.strftime("%a, %d %b")


def _tag_expiries(dates):
    parsed = []
    for d in dates:
        try:
            parsed.append(datetime.strptime(d[:10], "%Y-%m-%d"))
        except Exception:
            continue
    by_month = defaultdict(list)
    for dt in parsed:
        by_month[(dt.year, dt.month)].append(dt)
    monthly = set()
    for items in by_month.values():
        monthly.add(max(items).strftime("%Y-%m-%d"))
    out = []
    for dt in parsed:
        iso = dt.strftime("%Y-%m-%d")
        kind = "monthly" if iso in monthly else "weekly"
        label = dt.strftime("%d %b")
        if kind == "monthly":
            label += " (Monthly)"
        out.append({
            "date": iso,
            "label": label,
            "kind": kind,
            "weekday": dt.strftime("%a"),
        })
    return out


def _default_selected(expiries):
    if not expiries:
        return []
    first = expiries[0]["date"]
    monthly = next((e["date"] for e in expiries if e["kind"] == "monthly"), None)
    selected = [first]
    if monthly and monthly not in selected:
        selected.append(monthly)
    return selected


def _strike_step(symbol, strikes):
    symbol = (symbol or "").upper()
    if symbol in ("BANKNIFTY",):
        return 100.0
    if symbol in ("SENSEX",):
        return 100.0
    if len(strikes) >= 2:
        diffs = sorted(set(round(strikes[i + 1] - strikes[i], 4) for i in range(len(strikes) - 1)))
        diffs = [d for d in diffs if d > 0]
        if diffs:
            return diffs[0]
    return 50.0


def _find_vix():
    if not os.path.exists(INSTRUMENT_CSV):
        return None
    with open(INSTRUMENT_CSV, encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row in reader:
            name = (row.get("Name") or "").strip().upper()
            root = (row.get("SymbolRoot") or "").strip().upper()
            full = (row.get("FullName") or "").strip().upper()
            blob = " ".join((name, root, full))
            if "INDIAVIX" in blob.replace(" ", "") or "INDIA VIX" in blob:
                if row.get("Exch", "").strip() != "N":
                    continue
                return {
                    "scrip_code": row["ScripCode"].strip(),
                    "exch": row["Exch"].strip(),
                    "exch_type": row.get("ExchType", "C").strip() or "C",
                    "trading_symbol": row["Name"].strip(),
                }
    return None


def _synth_path(end_value, n, rng, noise_frac=0.01):
    end_value = max(0.0, float(end_value or 0))
    if n <= 1:
        return [end_value]
    start = end_value * rng.uniform(0.78, 0.97)
    path = []
    val = start
    for i in range(n - 1):
        remain = n - 1 - i
        val += (end_value - val) / max(remain, 1)
        val += rng.gauss(0, max(end_value, 1) * noise_frac)
        val = max(0.0, val)
        path.append(val)
    path.append(end_value)
    return path


def _mock_expiries(session_date):
    try:
        start = datetime.strptime(session_date[:10], "%Y-%m-%d")
    except Exception:
        start = datetime.today()
    # Upcoming Thursdays (NIFTY weekly)
    dates = []
    d = start
    while len(dates) < 6:
        if d.weekday() == 3 and d >= start:
            dates.append(d.strftime("%Y-%m-%d"))
        d += timedelta(days=1)
        if d > start + timedelta(days=80):
            break
    return _tag_expiries(dates)


def _mock_spot(symbol):
    table = {
        "NIFTY": 24500.0,
        "BANKNIFTY": 55200.0,
        "FINNIFTY": 26500.0,
        "MIDCPNIFTY": 13200.0,
        "SENSEX": 80500.0,
        "RELIANCE": 1380.0,
    }
    return table.get((symbol or "NIFTY").upper(), 1000.0)


def _build_mock_strikes(symbol, spot, n_each_side=25):
    step = 50.0 if (symbol or "").upper() in ("NIFTY", "FINNIFTY", "MIDCPNIFTY") else 100.0
    if (symbol or "").upper() not in ("NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY", "SENSEX"):
        step = 20.0 if spot < 2000 else 50.0
    atm = round(spot / step) * step
    strikes = [atm + i * step for i in range(-n_each_side, n_each_side + 1)]
    return atm, step, strikes


def _mock_end_oi(strike, atm, step, side, rng):
    dist = abs(strike - atm) / max(step, 1)
    base = rng.uniform(1.1e6, 1.8e6) if side == "put" else rng.uniform(0.9e6, 1.6e6)
    # Peak OI a few strikes OTM (typical wall)
    peak_shift = 4 if side == "call" else -4
    wall = math.exp(-0.5 * ((dist - abs(peak_shift)) / 6.5) ** 2)
    near = math.exp(-0.5 * (dist / 9.0) ** 2)
    return max(8000.0, base * (0.35 * near + 0.85 * wall) * rng.uniform(0.75, 1.25))


def _assemble_payload(symbol, session_date, source, source_note, spot, vix,
                      expiries, selected, atm, step, strike_ends, times, minutes, rng):
    n = len(times)
    spot_series = _synth_path(spot, n, rng, noise_frac=0.0015)
    # Keep last point exactly at live/mock spot
    if spot_series:
        spot_series[-1] = spot
    strikes_out = []
    for strike in sorted(strike_ends.keys()):
        ce_end, pe_end = strike_ends[strike]
        ce_rng = random.Random(rng.random())
        pe_rng = random.Random(rng.random())
        strikes_out.append({
            "strike": strike,
            "call_oi": _synth_path(ce_end, n, ce_rng),
            "put_oi": _synth_path(pe_end, n, pe_rng),
        })
    last_call = sum(s["call_oi"][-1] for s in strikes_out) or 0.0
    last_put = sum(s["put_oi"][-1] for s in strikes_out) or 0.0
    pcr = (last_put / last_call) if last_call else None
    all_strikes = [s["strike"] for s in strikes_out]
    return {
        "symbol": symbol,
        "source": source,
        "source_note": source_note,
        "spot": spot,
        "india_vix": vix,
        "pcr": round(pcr, 2) if pcr is not None else None,
        "session_date": session_date,
        "session_label": _fmt_session_label(session_date),
        "market_open": MARKET_OPEN,
        "market_close": MARKET_CLOSE,
        "times": times,
        "minutes": minutes,
        "spot_series": spot_series,
        "expiries": expiries,
        "selected_expiries": selected,
        "atm_strike": atm,
        "strike_step": step,
        "strike_min": min(all_strikes) if all_strikes else None,
        "strike_max": max(all_strikes) if all_strikes else None,
        "strikes": strikes_out,
    }


def _mock_payload(symbol, session_date, selected=None):
    symbol = (symbol or "NIFTY").strip().upper() or "NIFTY"
    times, minutes = _session_buckets()
    expiries = _mock_expiries(session_date)
    if not expiries:
        expiries = _tag_expiries([session_date])
    if selected:
        selected = [d for d in selected if any(e["date"] == d for e in expiries)]
    if not selected:
        selected = _default_selected(expiries)
    spot = _mock_spot(symbol)
    atm, step, strikes = _build_mock_strikes(symbol, spot)
    rng = random.Random("{}|{}|mock".format(symbol, session_date))
    ends = {}
    for k in strikes:
        ends[k] = (
            _mock_end_oi(k, atm, step, "call", rng),
            _mock_end_oi(k, atm, step, "put", rng),
        )
    vix = round(rng.uniform(11.2, 14.8), 2)
    return _assemble_payload(
        symbol, session_date, "mock",
        "Sample NIFTY-style OI (no broker snapshot). Connect 5Paisa for live OI at the last bucket.",
        spot, vix, expiries, selected, atm, step, ends, times, minutes, rng,
    )


def _live_payload(user_key, client_code, access_token, symbol, session_date, selected):
    symbol = (symbol or "NIFTY").strip().upper() or "NIFTY"
    times, minutes = _session_buckets()
    dates = list_expiries(symbol)
    if access_token and user_key and client_code:
        try:
            api_dates = fp.get_expiry(user_key, client_code, access_token, "N", symbol)
            for d in api_dates:
                if d not in dates:
                    dates.append(d)
            dates = sorted(set(dates))
        except Exception:
            pass
    expiries = _tag_expiries(dates)
    if not expiries:
        raise ValueError("No expiries found for {}".format(symbol))
    if selected:
        selected = [d for d in selected if any(e["date"] == d for e in expiries)]
    if not selected:
        selected = _default_selected(expiries)

    underlying = _find_underlying(symbol)
    spot = None
    vix = None
    feed = []
    if underlying:
        feed.append(underlying)
    vix_inst = _find_vix()
    if vix_inst:
        feed.append(vix_inst)

    contracts_by_expiry = {}
    all_rows = []
    for exp in selected:
        rows = _load_contracts(symbol, exp)
        contracts_by_expiry[exp] = rows
        all_rows.extend(rows)
        for r in rows:
            if r.get("ce"):
                feed.append(r["ce"])
            if r.get("pe"):
                feed.append(r["pe"])

    quotes = {}
    try:
        quotes = fp.market_feed(user_key, client_code, access_token, feed)
    except Exception:
        quotes = {}

    if underlying:
        uq = quotes.get(str(underlying["scrip_code"])) or {}
        spot = uq.get("ltp") or uq.get("prev_close")
    if vix_inst:
        vq = quotes.get(str(vix_inst["scrip_code"])) or {}
        vix = vq.get("ltp") or vq.get("prev_close")
    if spot is None and all_rows:
        spot = all_rows[len(all_rows) // 2]["strike"]
    if spot is None:
        spot = _mock_spot(symbol)

    # Aggregate OI across selected expiries by strike
    agg = defaultdict(lambda: [0.0, 0.0])
    strike_list = sorted(set(r["strike"] for r in all_rows))
    if not strike_list:
        raise ValueError("No option contracts for {} {}".format(symbol, ",".join(selected)))
    step = _strike_step(symbol, strike_list)
    atm = min(strike_list, key=lambda s: abs(s - spot))

    for r in all_rows:
        strike = r["strike"]
        if r.get("ce"):
            q = quotes.get(str(r["ce"]["scrip_code"])) or {}
            oi = q.get("oi")
            if oi:
                agg[strike][0] += oi
        if r.get("pe"):
            q = quotes.get(str(r["pe"]["scrip_code"])) or {}
            oi = q.get("oi")
            if oi:
                agg[strike][1] += oi

    # If snapshot returned no OI, fall back to mock magnitudes scaled around ATM
    has_oi = any(v[0] or v[1] for v in agg.values())
    rng = random.Random("{}|{}|live".format(symbol, session_date))
    ends = {}
    window = 40
    lo = atm - window * step
    hi = atm + window * step
    use_strikes = [s for s in strike_list if lo <= s <= hi] or strike_list
    if not has_oi:
        for s in use_strikes:
            ends[s] = (
                _mock_end_oi(s, atm, step, "call", rng),
                _mock_end_oi(s, atm, step, "put", rng),
            )
        note = (
            "5Paisa quotes loaded but OI was empty (common after hours). "
            "Showing sample OI path ending at synthetic levels."
        )
        source = "mock"
    else:
        for s in use_strikes:
            ce, pe = agg[s]
            if ce <= 0:
                ce = _mock_end_oi(s, atm, step, "call", rng) * 0.15
            if pe <= 0:
                pe = _mock_end_oi(s, atm, step, "put", rng) * 0.15
            ends[s] = (ce, pe)
        note = (
            "Live OI from 5Paisa MarketSnapshot (last bar). "
            "Intraday path is synthetic until a snapshot history is stored. "
            "Exchange OI lags 1–3 minutes."
        )
        source = "live"

    payload = _assemble_payload(
        symbol, session_date, source, note,
        float(spot), float(vix) if vix is not None else None,
        expiries, selected, float(atm), float(step), ends, times, minutes, rng,
    )
    snap_key = symbol + "|" + ",".join(selected)
    if has_oi:
        _record_oi_snap(snap_key, float(spot), ends)
        _apply_oi_snaps(payload, snap_key)
        payload["source_note"] = (
            "Live OI from 5Paisa MarketSnapshot. "
            "Keep this tab open so Last 3 mins uses real samples. "
            "Exchange OI lags 1–3 minutes."
        )
    return payload


def _record_oi_snap(key, spot, ends):
    ts = time.time()
    oi = {float(k): (float(v[0] or 0), float(v[1] or 0)) for k, v in ends.items()}
    with _SNAP_LOCK:
        q = _SNAPS[key]
        if q and ts - q[-1]["ts"] < 8:
            q[-1] = {"ts": ts, "spot": spot, "oi": oi}
        else:
            q.append({"ts": ts, "spot": spot, "oi": oi})
        cutoff = ts - 10 * 3600
        while q and q[0]["ts"] < cutoff:
            q.popleft()


def _apply_oi_snaps(payload, key):
    with _SNAP_LOCK:
        snaps = list(_SNAPS.get(key) or [])
    if not snaps:
        return
    n = len(payload["times"])
    by_strike = {s["strike"]: s for s in payload["strikes"]}
    latest = snaps[-1]["ts"]
    for snap in snaps:
        rel_min = int(round((latest - snap["ts"]) / 60.0))
        idx = n - 1 - rel_min
        if idx < 0 or idx >= n:
            continue
        if snap.get("spot") is not None:
            payload["spot_series"][idx] = snap["spot"]
        for strike, pair in (snap.get("oi") or {}).items():
            row = by_strike.get(float(strike))
            if not row:
                continue
            row["call_oi"][idx] = pair[0]
            row["put_oi"][idx] = pair[1]
    payload["snapshot_count"] = len(snaps)


def build_oi_change(symbol="NIFTY", expiries=None, session_date=None,
                    creds=None):
    """
    Build OI-change-vs-strike payload. Uses 5Paisa when creds are valid;
    otherwise returns mock NIFTY-style data.
    """
    symbol = (symbol or "NIFTY").strip().upper() or "NIFTY"
    session_date = (session_date or datetime.today().strftime("%Y-%m-%d"))[:10]
    selected = None
    if expiries:
        selected = [str(d).strip()[:10] for d in expiries if str(d).strip()]

    creds = creds or {}
    access_token = (creds.get("access_token") or "").strip()
    user_key = (creds.get("user_key") or "").strip()
    client_code = (creds.get("client_code") or "").strip()
    if access_token and user_key and client_code:
        try:
            return _live_payload(
                user_key, client_code, access_token, symbol, session_date, selected,
            )
        except Exception:
            mock = _mock_payload(symbol, session_date, selected)
            mock["source_note"] = (
                "Live OI fetch failed; showing sample data. " + (mock.get("source_note") or "")
            )
            return mock
    return _mock_payload(symbol, session_date, selected)
