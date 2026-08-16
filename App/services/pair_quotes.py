"""
Live quotes and min-capital equal-notional hedge for the pair dashboard.
"""
from __future__ import annotations

import csv
import math
import os
import threading
from datetime import date
from typing import Dict, List, Optional

from services.datafeed_store import INSTRUMENT_CSV

__all__ = ["build_pair_live"]

_lock = threading.Lock()
_cache = {"mtime": None, "cash": {}, "futs": {}}  # type: dict


def _lot(row):
    try:
        v = int(float(row.get("LotSize") or 1))
    except (TypeError, ValueError):
        v = 1
    return max(1, v)


def _strike(row):
    try:
        return float(row.get("StrikeRate") or 0)
    except (TypeError, ValueError):
        return 0.0


def _ensure_index():
    path = INSTRUMENT_CSV
    if not os.path.exists(path):
        return
    mtime = os.path.getmtime(path)
    with _lock:
        if _cache["mtime"] == mtime and _cache["cash"]:
            return
        cash = {}  # type: Dict[str, dict]
        futs = {}  # type: Dict[str, List[dict]]
        with open(path, encoding="utf-8") as f:
            for row in csv.DictReader(f):
                if (row.get("Exch") or "").strip() != "N":
                    continue
                et = (row.get("ExchType") or "").strip().upper()
                st = (row.get("ScripType") or "").strip().upper()
                name = (row.get("Name") or "").strip().upper()
                root = (row.get("SymbolRoot") or "").strip().upper() or name
                code = (row.get("ScripCode") or "").strip()
                if not code:
                    continue
                rec = {
                    "scrip_code": code,
                    "exch": "N",
                    "exch_type": et,
                    "name": (row.get("Name") or "").strip(),
                    "root": root,
                    "lot_size": _lot(row),
                    "expiry": (row.get("Expiry") or "").strip()[:10],
                    "series": (row.get("Series") or "").strip().upper(),
                }
                if et == "C" and st in ("EQ", "XX", ""):
                    key = name
                    prev = cash.get(key)
                    # Prefer EQ series over others
                    if prev is None or (rec["series"] == "EQ" and prev.get("series") != "EQ"):
                        cash[key] = rec
                    if root and root not in cash:
                        cash[root] = rec
                elif et == "D" and st == "XX" and _strike(row) == 0 and rec["expiry"]:
                    futs.setdefault(root, []).append(rec)
        for lst in futs.values():
            lst.sort(key=lambda x: x["expiry"])
        _cache["mtime"] = mtime
        _cache["cash"] = cash
        _cache["futs"] = futs


def _cash(symbol):
    _ensure_index()
    return _cache["cash"].get((symbol or "").strip().upper())


def _near_future(symbol, today=None):
    _ensure_index()
    today = today or date.today().isoformat()
    lst = _cache["futs"].get((symbol or "").strip().upper()) or []
    for rec in lst:
        if rec["expiry"] >= today:
            return rec
    return lst[-1] if lst else None


def _quote_map(creds, instruments):
    import fivepaisa as fp
    c = creds.get("5paisa") or {}
    token = (c.get("access_token") or "").strip()
    user_key = (c.get("user_key") or "").strip()
    client = (c.get("client_code") or "").strip()
    if not token or not user_key:
        return {}
    uniq, seen = [], set()
    for inst in instruments:
        if not inst:
            continue
        key = (inst["exch"], inst["exch_type"], str(inst["scrip_code"]))
        if key in seen:
            continue
        seen.add(key)
        uniq.append(inst)
    if not uniq:
        return {}
    try:
        return fp.market_feed(user_key, client, token, uniq) or {}
    except Exception:
        return {}


def _ltp(quotes, inst, fallback=None):
    if not inst:
        return fallback
    q = quotes.get(str(inst["scrip_code"])) or {}
    px = q.get("ltp")
    if px is None or not math.isfinite(px) or px <= 0:
        px = q.get("prev_close")
    if px is None or not math.isfinite(px) or px <= 0:
        return fallback
    return float(px)


def _chg(quotes, inst):
    if not inst:
        return None, None
    q = quotes.get(str(inst["scrip_code"])) or {}
    return q.get("chg"), q.get("chg_pct")


def equal_notional(p_sell, p_buy, lot_sell=1, lot_buy=1, max_units=80, max_imb=0.03):
    """Smallest lot-multiple hedge with roughly equal rupee value both sides."""
    if not p_sell or not p_buy or p_sell <= 0 or p_buy <= 0:
        return None
    ls = max(1, int(lot_sell or 1))
    lb = max(1, int(lot_buy or 1))
    us = ls * float(p_sell)
    ub = lb * float(p_buy)
    ratio = max(us, ub) / min(us, ub)
    limit = max(int(max_units), min(80, int(math.ceil(ratio)) + 8))
    best = None
    for ns in range(1, limit + 1):
        target = ns * us / ub
        nbs = {
            max(1, int(round(target))),
            max(1, int(math.floor(target))),
            max(1, int(math.ceil(target))),
        }
        for nb in nbs:
            if nb > 8000:
                continue
            vs = ns * us
            vb = nb * ub
            mid = (vs + vb) / 2.0
            imb = abs(vs - vb) / mid if mid else 1.0
            tot = vs + vb
            rec = (imb, tot, ns, nb, vs, vb)
            if best is None or rec < best:
                best = rec
    if not best:
        return None
    _imb, tot, ns, nb, vs, vb = best
    return {
        "sell_lots": ns,
        "buy_lots": nb,
        "sell_qty": ns * ls,
        "buy_qty": nb * lb,
        "sell_lot_size": ls,
        "buy_lot_size": lb,
        "sell_notional": round(vs, 2),
        "buy_notional": round(vb, 2),
        "imbalance_pct": round(_imb * 100.0, 2),
        "gross_investment": round(tot, 2),
    }


def _leg_payload(symbol, cash, fut, quotes, fallback_px, kind):
    inst = fut if kind == "FUT" and fut else cash
    px = _ltp(quotes, inst, fallback_px)
    chg, chg_pct = _chg(quotes, inst)
    out = {
        "symbol": symbol,
        "kind": "FUT" if inst and inst.get("exch_type") == "D" else "EQ",
        "ltp": round(px, 4) if px else None,
        "chg": round(chg, 4) if chg is not None else None,
        "chg_pct": round(chg_pct, 2) if chg_pct is not None else None,
        "lot_size": inst["lot_size"] if inst else 1,
        "scrip_code": inst["scrip_code"] if inst else None,
        "contract": inst["name"] if inst else symbol,
        "expiry": inst.get("expiry") if inst else None,
        "has_future": bool(fut),
    }
    if kind == "FUT" and not fut:
        out["note"] = "No NSE future listed; using cash."
    return out, px, (inst["lot_size"] if inst else 1)


def build_pair_live(creds, sym1, sym2, sell_symbol=None, last_close1=None, last_close2=None):
    # type: (dict, str, str, Optional[str], Optional[float], Optional[float]) -> dict
    sym1 = (sym1 or "").strip().upper()
    sym2 = (sym2 or "").strip().upper()
    sell = (sell_symbol or "").strip().upper() or sym1
    buy = sym2 if sell == sym1 else sym1

    c1, c2 = _cash(sym1), _cash(sym2)
    f1, f2 = _near_future(sym1), _near_future(sym2)
    quotes = _quote_map(creds, [c1, c2, f1, f2])

    def pack(kind):
        L1, p1, lot1 = _leg_payload(sym1, c1, f1, quotes, last_close1, kind)
        L2, p2, lot2 = _leg_payload(sym2, c2, f2, quotes, last_close2, kind)
        p_sell = p1 if sell == sym1 else p2
        p_buy = p2 if sell == sym1 else p1
        lot_sell = lot1 if sell == sym1 else lot2
        lot_buy = lot2 if sell == sym1 else lot1
        # Futures: both legs in lots. Cash: 1-share units (cash lot, usually 1).
        # If buying a future, the sell side is also rounded to that instrument's lot.
        max_u = 12 if kind == "FUT" else 120
        hedge = equal_notional(p_sell, p_buy, lot_sell, lot_buy, max_units=max_u)
        if hedge:
            hedge["sell_symbol"] = sell
            hedge["buy_symbol"] = buy
            hedge["sell_price"] = round(p_sell, 4) if p_sell else None
            hedge["buy_price"] = round(p_buy, 4) if p_buy else None
        return {"leg1": L1, "leg2": L2, "hedge": hedge}

    return {
        "success": True,
        "instrument1": sym1,
        "instrument2": sym2,
        "sell_symbol": sell,
        "buy_symbol": buy,
        "cash": pack("EQ"),
        "futures": pack("FUT"),
    }
