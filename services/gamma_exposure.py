"""
Gamma Exposure (GEX) calculator, gamma-flip, regime score, and strategy layer.

Index convention (SpotGamma-style sign):
  Call GEX(K) = + Γ_call × OI_call × lot × S² × 0.01
  Put  GEX(K) = − Γ_put  × OI_put  × lot × S² × 0.01
  Net GEX     = Σ Call + Σ Put

Units are notional exposure for a 1% underlying move. Dealers are treated as
long calls / short puts on index flow (call OI → positive gamma, put OI →
negative gamma). Positive net GEX → hedge against the move (range / vol
compression). Negative net GEX → hedge with the move (trend / vol expansion).
"""
import math
import threading
import time
from collections import defaultdict, deque
from datetime import datetime

from services.option_chain import (
    _bs_greeks,
    _years_to_expiry,
    build_option_chain,
    list_expiries,
    list_underlyings,
)

_HIST_LOCK = threading.Lock()
_HIST = defaultdict(lambda: deque(maxlen=180))
_PREV_STRIKE = {}

__all__ = ["build_gamma_exposure", "list_underlyings", "list_expiries"]

_R = 0.06
_DEFAULT_LOTS = {
    "NIFTY": 75,
    "BANKNIFTY": 30,
    "FINNIFTY": 65,
    "MIDCPNIFTY": 120,
    "SENSEX": 20,
}
_MOCK_SPOT = {
    "NIFTY": 25080.0,
    "BANKNIFTY": 55200.0,
    "FINNIFTY": 26500.0,
    "MIDCPNIFTY": 13200.0,
    "SENSEX": 80500.0,
}


def _safe_float(v, default=0.0):
    try:
        if v is None or v == "":
            return default
        return float(v)
    except (TypeError, ValueError):
        return default


def _hist_key(symbol, expiry):
    return "{}|{}".format(symbol, expiry)


def _gex_notional(gamma, oi, lot, spot):
    g = _safe_float(gamma, 0.0)
    o = _safe_float(oi, 0.0)
    lot = max(1.0, _safe_float(lot, 1.0))
    s = _safe_float(spot, 0.0)
    if g == 0.0 or o == 0.0 or s <= 0:
        return 0.0
    return g * o * lot * s * s * 0.01


def _interp_zero(strikes, values, prefer_spot):
    """Linear zero-crossing nearest to prefer_spot. None if no sign change."""
    hits = []
    n = len(strikes)
    for i in range(n):
        v = values[i]
        if v == 0:
            hits.append(strikes[i])
            continue
        if i + 1 >= n:
            continue
        w = values[i + 1]
        if v * w < 0:
            denom = abs(v) + abs(w)
            t = abs(v) / denom if denom else 0.5
            hits.append(strikes[i] + t * (strikes[i + 1] - strikes[i]))
    if not hits:
        return None
    return min(hits, key=lambda x: abs(x - prefer_spot))


def _gamma_flip(strikes, net, spot):
    flip = _interp_zero(strikes, net, spot)
    if flip is not None:
        return round(flip, 2), "profile"
    cum = []
    acc = 0.0
    for v in net:
        acc += v
        cum.append(acc)
    flip = _interp_zero(strikes, cum, spot)
    if flip is not None:
        return round(flip, 2), "cumulative"
    return None, "none"


def _zones(rows, top_n=3):
    pos, neg = [], []
    run = None
    for r in rows:
        sign = 1 if r["net_gex"] > 0 else (-1 if r["net_gex"] < 0 else 0)
        if sign == 0:
            if run:
                (pos if run["sign"] > 0 else neg).append(run)
                run = None
            continue
        if run and run["sign"] == sign:
            run["to"] = r["strike"]
            run["net"] += r["net_gex"]
            if abs(r["net_gex"]) > abs(run["peak_gex"]):
                run["peak_gex"] = r["net_gex"]
                run["peak_strike"] = r["strike"]
        else:
            if run:
                (pos if run["sign"] > 0 else neg).append(run)
            run = {
                "sign": sign,
                "from": r["strike"],
                "to": r["strike"],
                "net": r["net_gex"],
                "peak_gex": r["net_gex"],
                "peak_strike": r["strike"],
            }
    if run:
        (pos if run["sign"] > 0 else neg).append(run)
    pos.sort(key=lambda z: -z["net"])
    neg.sort(key=lambda z: z["net"])
    def pack(z):
        return {
            "from": z["from"],
            "to": z["to"],
            "peak_strike": z["peak_strike"],
            "net_gex": round(z["net"], 2),
            "peak_gex": round(z["peak_gex"], 2),
        }
    return [pack(z) for z in pos[:top_n]], [pack(z) for z in neg[:top_n]]


def _clamp(x, lo, hi):
    return lo if x < lo else hi if x > hi else x


def _tanh(x):
    try:
        return math.tanh(x)
    except Exception:
        return 0.0


def _regime_and_signal(spot, flip, rows, totals, prev, oi_stats, avg_iv, strike_step):
    net = totals["net_gex"]
    scale = abs(totals["call_gex"]) + abs(totals["put_gex"]) or 1.0
    net_ratio = _clamp(net / scale, -1.0, 1.0)

    flip_comp = 0.0
    if flip is not None and strike_step:
        flip_comp = _tanh((spot - flip) / (2.0 * max(strike_step, 1.0)))

    major_pos = max(rows, key=lambda r: r["net_gex"]) if rows else None
    major_neg = min(rows, key=lambda r: r["net_gex"]) if rows else None
    dist_pos = abs(spot - major_pos["strike"]) / max(strike_step, 1) if major_pos else 99
    dist_neg = abs(spot - major_neg["strike"]) / max(strike_step, 1) if major_neg else 99
    magnet_comp = _tanh((dist_neg - dist_pos) / 4.0)

    gex_chg = 0.0
    gex_chg_pct = None
    spot_chg = 0.0
    if prev:
        prev_net = prev.get("net_gex") or 0.0
        gex_chg = net - prev_net
        if abs(prev_net) > 1:
            gex_chg_pct = gex_chg / abs(prev_net)
        spot_chg = spot - (prev.get("spot") or spot)
    change_comp = _tanh((gex_chg_pct or 0.0) * 4.0)

    call_chg = oi_stats.get("call_oi_chg") or 0.0
    put_chg = oi_stats.get("put_oi_chg") or 0.0
    oi_den = abs(call_chg) + abs(put_chg) or 1.0
    # Put build / call unwind → supportive of upside in a trend regime
    oi_comp = _clamp((put_chg - call_chg) / oi_den, -1.0, 1.0)

    # Weighted blend in [-1, 1], then map to 0–100 with 50 = neutral.
    blend = (
        0.35 * net_ratio
        + 0.25 * flip_comp
        + 0.15 * magnet_comp
        + 0.15 * change_comp
        + 0.10 * oi_comp
    )
    score = int(round(_clamp(50 + 50 * blend, 0, 100)))
    signed = int(round(_clamp(blend * 100, -100, 100)))

    if score >= 62:
        regime = "POSITIVE GAMMA"
        expected = "Range / mean reversion"
        vol = "LOW/MODERATE"
        regime_says = "range"
    elif score <= 38:
        regime = "NEGATIVE GAMMA"
        expected = "Trend / volatility expansion"
        vol = "MODERATE/HIGH"
        regime_says = "trend"
    else:
        regime = "MIXED / TRANSITION"
        expected = "Regime unclear — watch flip and GEX change"
        vol = "MODERATE"
        regime_says = "mixed"

    if flip is not None:
        if spot >= flip and score >= 50:
            bias = "Neutral → Bullish"
        elif spot >= flip:
            bias = "Cautiously bullish (above flip, but GEX mixed)"
        elif spot < flip and score <= 50:
            bias = "Bearish / higher directional risk"
        else:
            bias = "Below flip but positive GEX — unstable"
    else:
        bias = "Neutral"

    breakout = "LOW"
    if regime_says == "trend":
        breakout = "HIGH" if dist_neg <= 2 else "MODERATE"
    elif abs(gex_chg_pct or 0) > 0.12:
        breakout = "MODERATE"
        if abs(gex_chg_pct or 0) > 0.25:
            expected = "Dealer positioning changing — regime transition"

    near_neg = dist_neg <= 1.6
    near_pos = dist_pos <= 1.6
    call_unwind = call_chg < 0
    put_build = put_chg > 0
    gex_more_neg = gex_chg < 0 and net < 0
    gex_more_pos = gex_chg > 0 and net > 0

    reasons = []
    signal = {
        "id": "none",
        "label": "No high-conviction setup",
        "side": None,
        "regime_says": regime_says,
        "confidence": 35,
        "setup": None,
        "reasons": reasons,
    }

    if regime_says == "trend" and near_neg and call_unwind and put_build and (gex_more_neg or net_ratio < -0.15):
        conf = 55
        if gex_more_neg:
            conf += 12
        if dist_neg <= 1.0:
            conf += 8
        if spot_chg > 0:
            conf += 8
        signal = {
            "id": "momentum_long",
            "label": "Momentum LONG",
            "side": "long",
            "regime_says": "trend",
            "confidence": min(92, conf),
            "setup": "LONG CALL",
            "reasons": [
                "Negative-gamma regime (dealer hedging can reinforce the move)",
                "Spot approaching a major −GEX acceleration zone",
                "Call OI unwinding while Put OI is increasing",
                "GEX becoming more negative" if gex_more_neg else "Net GEX already negative",
            ],
        }
    elif regime_says == "trend" and near_neg and not call_unwind and put_chg < 0 and net_ratio < -0.1:
        conf = 52
        if gex_chg > 0:
            conf += 6
        signal = {
            "id": "momentum_short",
            "label": "Momentum SHORT",
            "side": "short",
            "regime_says": "trend",
            "confidence": min(88, conf),
            "setup": "LONG PUT / futures short",
            "reasons": [
                "Negative-gamma regime",
                "Spot near a major −GEX zone",
                "Put OI unwinding (downside hedges coming off)",
                "Call OI not unwinding — breakout not being faded",
            ],
        }
    elif regime_says == "range" and near_pos:
        above = major_pos and spot > major_pos["strike"]
        side = "short" if above else "long"
        conf = 58
        if gex_more_pos:
            conf += 10
        if not (call_chg > 0 and put_chg < 0 and above):
            conf += 8
        else:
            conf -= 15  # OI actually supports a breakout
        signal = {
            "id": "mean_reversion_short" if above else "mean_reversion_long",
            "label": "Mean-reversion " + ("SHORT" if above else "LONG"),
            "side": side,
            "regime_says": "range",
            "confidence": min(90, max(40, conf)),
            "setup": "fade extension toward +GEX magnet",
            "reasons": [
                "Strong positive gamma (dealers hedge against the move)",
                "Spot near a large +GEX strike (price magnet / pin)",
                "OI structure is not clearly supporting a breakout"
                if conf >= 58 else "OI is mixed — treat as a lower-confidence fade",
            ],
        }
    else:
        if regime_says == "trend":
            reasons.append("Gamma says trend — wait for a −GEX zone + OI confirmation")
        elif regime_says == "range":
            reasons.append("Gamma says range — wait for price to tag a +GEX magnet")
        else:
            reasons.append("Mixed GEX — no clean trend vs range distinction yet")

    iv_label = "—"
    if avg_iv is not None:
        iv_pct = avg_iv * 100 if avg_iv < 1.5 else avg_iv
        if iv_pct < 11:
            iv_label = "LOW ({:.1f}%)".format(iv_pct)
        elif iv_pct < 16:
            iv_label = "MODERATE ({:.1f}%)".format(iv_pct)
        else:
            iv_label = "HIGH ({:.1f}%)".format(iv_pct)

    return {
        "score": score,
        "signed_score": signed,
        "regime": regime,
        "expected_behaviour": expected,
        "bias": bias,
        "volatility": vol,
        "iv_label": iv_label,
        "breakout_risk": breakout,
        "spot_vs_flip": (
            "above" if flip is not None and spot >= flip
            else "below" if flip is not None else "unknown"
        ),
        "gex_change": round(gex_chg, 2),
        "gex_change_pct": round(gex_chg_pct * 100, 2) if gex_chg_pct is not None else None,
        "spot_change": round(spot_chg, 2),
        "signal": signal,
    }


def _interpretations(spot, flip, totals, major_pos, major_neg, regime):
    net = totals["net_gex"]
    rows = [
        {
            "condition": "Positive GEX" if net >= 0 else "Negative GEX",
            "interpretation": (
                "Dealers generally hedge against price movement"
                if net >= 0 else
                "Dealer hedging can reinforce price movement"
            ),
            "expected": (
                "Mean reversion / volatility compression"
                if net >= 0 else
                "Trend / volatility expansion"
            ),
            "active": True,
        },
        {
            "condition": "Spot above gamma flip" if (flip is not None and spot >= flip)
            else "Spot below gamma flip" if flip is not None
            else "Gamma flip unavailable",
            "interpretation": (
                "Positive-gamma regime may dominate"
                if flip is not None and spot >= flip
                else "Negative-gamma regime may dominate"
                if flip is not None
                else "Not enough sign-change in the GEX profile"
            ),
            "expected": (
                "More range-bound" if flip is not None and spot >= flip
                else "Higher directional risk" if flip is not None
                else "—"
            ),
            "active": flip is not None,
        },
        {
            "condition": "Large +GEX strike",
            "interpretation": "Potential price magnet / resistance / support",
            "expected": (
                "Price may gravitate toward {:.0f}".format(major_pos["strike"])
                if major_pos else "—"
            ),
            "active": bool(major_pos),
        },
        {
            "condition": "Large −GEX strike",
            "interpretation": "Potential acceleration zone",
            "expected": (
                "Breakouts can become stronger near {:.0f}".format(major_neg["strike"])
                if major_neg else "—"
            ),
            "active": bool(major_neg),
        },
        {
            "condition": "GEX rapidly changing",
            "interpretation": "Dealer positioning changing",
            "expected": "Regime transition",
            "active": abs(regime.get("gex_change_pct") or 0) >= 12,
        },
    ]
    return rows


def _strike_step(strikes):
    if len(strikes) < 2:
        return 50.0
    diffs = sorted(set(round(strikes[i + 1] - strikes[i], 4) for i in range(len(strikes) - 1)))
    diffs = [d for d in diffs if d > 0]
    return diffs[0] if diffs else 50.0


def _from_chain(symbol, expiry, chain_payload):
    spot = _safe_float(chain_payload.get("spot"), 0.0)
    chain = chain_payload.get("chain") or []
    rows = []
    call_gex = put_gex = 0.0
    call_oi = put_oi = 0.0
    call_oi_chg = put_oi_chg = 0.0
    ivs = []
    key = _hist_key(symbol, expiry)
    prev_map = _PREV_STRIKE.get(key) or {}

    for item in chain:
        strike = _safe_float(item.get("strike"))
        ce = item.get("ce") or {}
        pe = item.get("pe") or {}
        lot_ce = max(1.0, _safe_float(ce.get("lot_size"), _DEFAULT_LOTS.get(symbol, 1)))
        lot_pe = max(1.0, _safe_float(pe.get("lot_size"), _DEFAULT_LOTS.get(symbol, 1)))
        ce_oi = _safe_float(ce.get("oi"), 0.0)
        pe_oi = _safe_float(pe.get("oi"), 0.0)
        ce_g = _gex_notional(ce.get("gamma"), ce_oi, lot_ce, spot)
        pe_g = -_gex_notional(pe.get("gamma"), pe_oi, lot_pe, spot)
        prev = prev_map.get(strike) or {}
        ce_chg = ce.get("oi_chg")
        pe_chg = pe.get("oi_chg")
        if ce_chg is None and prev.get("ce_oi") is not None:
            ce_chg = ce_oi - prev["ce_oi"]
        if pe_chg is None and prev.get("pe_oi") is not None:
            pe_chg = pe_oi - prev["pe_oi"]
        ce_chg = _safe_float(ce_chg, 0.0)
        pe_chg = _safe_float(pe_chg, 0.0)
        rows.append({
            "strike": strike,
            "call_gex": round(ce_g, 2),
            "put_gex": round(pe_g, 2),
            "net_gex": round(ce_g + pe_g, 2),
            "call_gamma": ce.get("gamma"),
            "put_gamma": pe.get("gamma"),
            "call_oi": ce_oi,
            "put_oi": pe_oi,
            "call_oi_chg": ce_chg,
            "put_oi_chg": pe_chg,
            "call_iv": ce.get("iv"),
            "put_iv": pe.get("iv"),
            "atm": bool(item.get("atm")),
        })
        call_gex += ce_g
        put_gex += pe_g
        call_oi += ce_oi
        put_oi += pe_oi
        call_oi_chg += ce_chg
        put_oi_chg += pe_chg
        if ce.get("iv"):
            ivs.append(_safe_float(ce.get("iv")))
        if pe.get("iv"):
            ivs.append(_safe_float(pe.get("iv")))

    _PREV_STRIKE[key] = {
        r["strike"]: {"ce_oi": r["call_oi"], "pe_oi": r["put_oi"]} for r in rows
    }
    avg_iv = (sum(ivs) / len(ivs)) if ivs else None
    return rows, {
        "call_gex": call_gex,
        "put_gex": put_gex,
        "net_gex": call_gex + put_gex,
        "call_oi": call_oi,
        "put_oi": put_oi,
        "call_oi_chg": call_oi_chg,
        "put_oi_chg": put_oi_chg,
        "pcr": (put_oi / call_oi) if call_oi else None,
        "avg_iv": avg_iv,
    }


def _mock_chain_like(symbol, expiry, strike_window):
    """Synthetic chain with BS gamma + wall-shaped OI so the UI works offline."""
    symbol = (symbol or "NIFTY").upper()
    spot = _MOCK_SPOT.get(symbol, 1000.0)
    step = 50.0 if symbol in ("NIFTY", "FINNIFTY", "MIDCPNIFTY") else 100.0
    if symbol not in _MOCK_SPOT:
        step = 20.0 if spot < 2000 else 50.0
    atm = round(spot / step) * step
    n = max(8, min(40, int(strike_window)))
    lot = _DEFAULT_LOTS.get(symbol, 25)
    t = _years_to_expiry(expiry) if expiry else 7.0 / 365.0
    chain = []
    for i in range(-n, n + 1):
        k = atm + i * step
        dist = abs(i)
        sigma = 0.13 + 0.01 * (dist / 8.0)
        ce_g = _bs_greeks(spot, k, t, _R, sigma, "CE")
        pe_g = _bs_greeks(spot, k, t, _R, sigma, "PE")
        ce_oi = 1.4e6 * math.exp(-0.5 * ((i - 4) / 6.5) ** 2)
        pe_oi = 1.6e6 * math.exp(-0.5 * ((i + 4) / 6.5) ** 2)
        chain.append({
            "strike": k,
            "atm": abs(k - atm) < 0.1,
            "ce": {
                "gamma": ce_g.get("gamma"),
                "iv": ce_g.get("iv"),
                "oi": ce_oi,
                "oi_chg": (-18000 if i >= 0 else 4000) * math.exp(-dist / 8.0),
                "lot_size": lot,
            },
            "pe": {
                "gamma": pe_g.get("gamma"),
                "iv": pe_g.get("iv"),
                "oi": pe_oi,
                "oi_chg": (22000 if i <= 0 else -3000) * math.exp(-dist / 8.0),
                "lot_size": lot,
            },
        })
    return {
        "symbol": symbol,
        "expiry": expiry,
        "spot": spot,
        "greeks_source": "mock",
        "chain": chain,
    }


def _pack(symbol, expiry, source, source_note, chain_payload, greeks_source):
    rows, totals = _from_chain(symbol, expiry, chain_payload)
    spot = _safe_float(chain_payload.get("spot"))
    strikes = [r["strike"] for r in rows]
    nets = [r["net_gex"] for r in rows]
    step = _strike_step(strikes)
    flip, flip_method = _gamma_flip(strikes, nets, spot)
    pos_zones, neg_zones = _zones(rows)
    major_pos = max(rows, key=lambda r: r["net_gex"]) if rows else None
    major_neg = min(rows, key=lambda r: r["net_gex"]) if rows else None
    max_abs = max(rows, key=lambda r: abs(r["net_gex"])) if rows else None

    key = _hist_key(symbol, expiry)
    with _HIST_LOCK:
        hist = _HIST[key]
        prev = hist[-1] if hist else None
        snap = {
            "ts": time.time(),
            "net_gex": totals["net_gex"],
            "call_gex": totals["call_gex"],
            "put_gex": totals["put_gex"],
            "spot": spot,
        }
        hist.append(snap)
        history = [
            {
                "ts": h["ts"],
                "net_gex": round(h["net_gex"], 2),
                "spot": h["spot"],
            }
            for h in hist
        ]

    regime = _regime_and_signal(
        spot, flip, rows, totals, prev,
        {
            "call_oi_chg": totals["call_oi_chg"],
            "put_oi_chg": totals["put_oi_chg"],
        },
        totals.get("avg_iv"),
        step,
    )
    interp = _interpretations(spot, flip, totals, major_pos, major_neg, regime)

    pcr = totals["pcr"]
    return {
        "symbol": symbol,
        "expiry": expiry,
        "source": source,
        "source_note": source_note,
        "greeks_source": greeks_source,
        "spot": spot,
        "strike_step": step,
        "net_gex": round(totals["net_gex"], 2),
        "call_gex": round(totals["call_gex"], 2),
        "put_gex": round(totals["put_gex"], 2),
        "gamma_flip": flip,
        "gamma_flip_method": flip_method,
        "max_gamma_strike": max_abs["strike"] if max_abs else None,
        "max_gamma_gex": round(max_abs["net_gex"], 2) if max_abs else None,
        "major_pos_strike": major_pos["strike"] if major_pos else None,
        "major_pos_gex": round(major_pos["net_gex"], 2) if major_pos else None,
        "major_neg_strike": major_neg["strike"] if major_neg else None,
        "major_neg_gex": round(major_neg["net_gex"], 2) if major_neg else None,
        "positive_zones": pos_zones,
        "negative_zones": neg_zones,
        "pcr": round(pcr, 2) if pcr is not None else None,
        "call_oi": totals["call_oi"],
        "put_oi": totals["put_oi"],
        "call_oi_chg": totals["call_oi_chg"],
        "put_oi_chg": totals["put_oi_chg"],
        "avg_iv": totals.get("avg_iv"),
        "regime": regime,
        "interpretations": interp,
        "history": history,
        "strikes": rows,
        "updated": datetime.now().strftime("%H:%M:%S"),
    }


def build_gamma_exposure(symbol, expiry, creds=None, strike_window=18):
    """
    Live GEX from 5Paisa option chain when connected; otherwise a sample profile.
    """
    symbol = (symbol or "NIFTY").strip().upper() or "NIFTY"
    expiry = (expiry or "").strip()[:10]
    strike_window = max(8, min(40, int(strike_window or 18)))
    creds = creds or {}
    access_token = (creds.get("access_token") or "").strip()
    user_key = (creds.get("user_key") or "").strip()
    client_code = (creds.get("client_code") or "").strip()

    dates = list_expiries(symbol)
    if not expiry:
        expiry = dates[0] if dates else datetime.today().strftime("%Y-%m-%d")

    if access_token and user_key and client_code:
        try:
            chain = build_option_chain(
                user_key, client_code, access_token, symbol, expiry,
                strike_window=strike_window,
            )
            payload = _pack(
                symbol, expiry, "live",
                "GEX from live OI × gamma (5Paisa chain). Call GEX positive, put GEX negative.",
                chain, chain.get("greeks_source") or "live",
            )
            payload["expiries"] = dates or [expiry]
            return payload
        except Exception as e:
            mock = _mock_chain_like(symbol, expiry, strike_window)
            payload = _pack(
                symbol, expiry, "mock",
                "Live chain failed ({}). Showing sample GEX profile.".format(e),
                mock, "mock",
            )
            payload["expiries"] = dates or [expiry]
            return payload

    mock = _mock_chain_like(symbol, expiry, strike_window)
    payload = _pack(
        symbol, expiry, "mock",
        "Sample GEX (no broker snapshot). Connect 5Paisa for live OI × gamma.",
        mock, "mock",
    )
    payload["expiries"] = dates or [expiry]
    payload["underlyings_hint"] = True
    return payload
