"""Causal, bar-by-bar strategy backtester for custom-indicator signals.

Fill, stop, and target logic uses only the current and earlier bars.
When stop and target could both be valid on the same bar, the stop is
taken first (pessimistic, avoids inflated expectancy).
"""
from __future__ import annotations

import math
import random

from custom_indicators._ta import as_bool, as_float, as_int, ist_day_key, ist_minutes, num, parse_candles


def _round_qty(raw, lot_size):
    lot = max(1.0, float(lot_size))
    if raw <= 0:
        return 0.0
    lots = math.floor(raw / lot + 1e-12)
    return lots * lot


def _clip_cost(entry, exit_px, side, slip, spread_half):
    """Apply slippage/spread in the adverse direction."""
    fill = exit_px - side * (slip + spread_half)
    return fill


def run_backtest(candles, setups, params=None):
    params = params if isinstance(params, dict) else {}
    times, opens, highs, lows, closes, _vols = parse_candles(candles)
    n = len(times)
    if n < 10:
        return {"trades": [], "equity": [], "stats": {"error": "not enough bars"}}

    account = as_float(params.get("account"), 1_000_000.0, 10_000, 1e12)
    risk_pct = as_float(params.get("risk_pct"), 0.5, 0.05, 5.0) / 100.0
    daily_loss_pct = as_float(params.get("max_daily_loss_pct"), 1.5, 0.1, 20.0) / 100.0
    max_consec = as_int(params.get("max_consecutive_losses"), 3, 1, 20)
    lot_size = as_float(params.get("lot_size"), 1.0, 1, 1e6)
    tick = as_float(params.get("tick_size"), 0.05, 0.0001, 10.0)
    slip_ticks = as_float(params.get("slippage_ticks"), 1.0, 0, 50)
    spread_ticks = as_float(params.get("spread_ticks"), 1.0, 0, 50)
    broker_pct = as_float(params.get("brokerage_pct"), 0.03, 0, 2.0) / 100.0
    round_turn = as_float(params.get("round_turn_rupees"), 0.0, 0, 1e6)
    exit1_r = as_float(params.get("exit1_r"), 1.0, 0.2, 10.0)
    exit2_r = as_float(params.get("exit2_r"), 2.0, 0.4, 20.0)
    exit1_frac = as_float(params.get("exit1_frac"), 0.40, 0, 1.0)
    exit2_frac = as_float(params.get("exit2_frac"), 0.30, 0, 1.0)
    trail_atr = as_float(params.get("trail_atr"), 2.0, 0.5, 8.0)
    no_entry_after = as_int(params.get("no_entry_after_min"), 14 * 60 + 45, 10 * 60, 16 * 60)
    square_off = as_int(params.get("square_off_min"), 15 * 60 + 15, 12 * 60, 16 * 60)
    skip_open = as_int(params.get("skip_open_min"), 15, 0, 120)
    session_open = as_int(params.get("session_open_min"), 9 * 60 + 15, 0, 16 * 60)
    one_trade = as_bool(params.get("one_position"), True)
    mc_runs = as_int(params.get("monte_carlo"), 0, 0, 2000)

    slip = slip_ticks * tick
    spread_half = 0.5 * spread_ticks * tick

    by_index = {}
    for s in setups or []:
        if not isinstance(s, dict):
            continue
        i = as_int(s.get("index"), -1, -1, n)
        if i < 0 or i >= n - 1:
            continue
        side = 1 if (s.get("side") in (1, "1", "long", "LONG", "buy")) else -1
        entry = num(s.get("entry"))
        stop = num(s.get("stop"))
        atr = num(s.get("atr"), 0.0) or 0.0
        if entry is None or stop is None:
            continue
        if side == 1 and not (stop < entry):
            continue
        if side == -1 and not (stop > entry):
            continue
        by_index.setdefault(i, []).append({
            "index": i,
            "side": side,
            "entry": float(entry),
            "stop": float(stop),
            "atr": float(atr),
            "score": num(s.get("score"), 0.0) or 0.0,
            "time": times[i],
        })

    cash = account
    peak = account
    max_dd = 0.0
    max_dd_pct = 0.0
    equity = []
    trades = []
    pos = None
    pending = None
    day_pnl = 0.0
    day_key = None
    halt_day = None
    consec_loss = 0
    blocked_until_day = None

    def mark_equity(i):
        nonlocal peak, max_dd, max_dd_pct
        mtm = cash
        if pos is not None:
            mtm += (closes[i] - pos["avg"]) * pos["side"] * pos["qty"]
        peak = max(peak, mtm)
        dd = peak - mtm
        if dd > max_dd:
            max_dd = dd
        if peak > 0:
            max_dd_pct = max(max_dd_pct, 100.0 * dd / peak)
        equity.append({"time": times[i], "equity": round(mtm, 2)})

    def costs(notional, lots_frac=1.0):
        return abs(notional) * broker_pct + round_turn * lots_frac

    def reset_day(i):
        nonlocal day_key, day_pnl, halt_day, consec_loss, blocked_until_day
        key = ist_day_key(times[i])
        if key != day_key:
            day_key = key
            day_pnl = 0.0
            halt_day = None
            consec_loss = 0
            blocked_until_day = None
        return key

    def close_qty(i, px, qty, reason):
        nonlocal cash, day_pnl, consec_loss, pos
        if pos is None or qty <= 0:
            return
        side = pos["side"]
        fill = _clip_cost(pos["entry"], px, side, slip, spread_half)
        pnl = (fill - pos["avg"]) * side * qty
        fee = costs(fill * qty, qty / max(pos["qty0"], 1.0))
        pnl -= fee
        cash += pnl
        day_pnl += pnl
        pos["qty"] -= qty
        pos["realized"] += pnl
        pos["legs"].append({
            "time": times[i],
            "price": round(fill, 4),
            "qty": qty,
            "pnl": round(pnl, 2),
            "reason": reason,
        })
        if pos["qty"] <= 1e-9:
            win = pos["realized"] > 0
            consec_loss = 0 if win else consec_loss + 1
            trades.append({
                "side": "long" if side == 1 else "short",
                "entry_time": pos["entry_time"],
                "entry_price": round(pos["entry"], 4),
                "exit_time": times[i],
                "exit_price": round(fill, 4),
                "qty": pos["qty0"],
                "pnl": round(pos["realized"], 2),
                "r": round(pos["realized"] / pos["risk_amt"], 3) if pos["risk_amt"] else 0.0,
                "score": pos["score"],
                "reason": reason,
                "win": win,
                "legs": pos["legs"],
            })
            pos = None

    def try_fill_pending(i):
        nonlocal pending, pos, cash, day_pnl
        if pending is None or pos is not None:
            return
        sig = pending
        side = sig["side"]
        entry = sig["entry"]
        fill_px = None
        if side == 1:
            if highs[i] >= entry:
                fill_px = max(opens[i], entry) + slip + spread_half
        else:
            if lows[i] <= entry:
                fill_px = min(opens[i], entry) - slip - spread_half
        if fill_px is None:
            age = i - int(sig.get("index", i))
            if age > 3 or ist_minutes(times[i]) >= square_off:
                pending = None
            return
        stop = sig["stop"]
        risk_unit = abs(fill_px - stop)
        if risk_unit < tick:
            pending = None
            return
        risk_amt = account * risk_pct
        raw_qty = risk_amt / risk_unit
        qty = _round_qty(raw_qty, lot_size)
        if qty <= 0:
            pending = None
            return
        fee = costs(fill_px * qty, 1.0)
        cash -= fee
        day_pnl -= fee
        pos = {
            "side": side,
            "entry": fill_px,
            "avg": fill_px,
            "stop": stop,
            "init_stop": stop,
            "atr": sig["atr"],
            "qty": qty,
            "qty0": qty,
            "entry_time": times[i],
            "entry_index": i,
            "score": sig["score"],
            "risk_amt": risk_unit * qty,
            "r_unit": risk_unit,
            "taken1": False,
            "taken2": False,
            "be": False,
            "hh": highs[i] if side == 1 else lows[i],
            "ll": lows[i] if side == -1 else highs[i],
            "realized": 0.0,
            "legs": [{
                "time": times[i],
                "price": round(fill_px, 4),
                "qty": qty,
                "pnl": 0.0,
                "reason": "entry",
            }],
        }
        pending = None

    def manage_pos(i):
        nonlocal pos
        if pos is None:
            return
        side = pos["side"]
        mins = ist_minutes(times[i])
        if side == 1:
            pos["hh"] = max(pos["hh"], highs[i])
        else:
            pos["ll"] = min(pos["ll"], lows[i])

        stop = pos["stop"]
        hit_stop = (lows[i] <= stop) if side == 1 else (highs[i] >= stop)
        if hit_stop:
            px = min(opens[i], stop) if side == 1 else max(opens[i], stop)
            close_qty(i, px, pos["qty"], "stop")
            return

        if mins >= square_off:
            close_qty(i, closes[i], pos["qty"], "square_off")
            return

        r = pos["r_unit"]
        t1 = pos["entry"] + side * exit1_r * r
        t2 = pos["entry"] + side * exit2_r * r
        hit_t1 = (highs[i] >= t1) if side == 1 else (lows[i] <= t1)
        hit_t2 = (highs[i] >= t2) if side == 1 else (lows[i] <= t2)

        if hit_t1 and not pos["taken1"] and exit1_frac > 0:
            q = _round_qty(pos["qty0"] * exit1_frac, lot_size)
            q = min(q, pos["qty"])
            if q > 0:
                close_qty(i, t1, q, "t1")
                if pos is None:
                    return
                pos["taken1"] = True
                pos["be"] = True
                pos["stop"] = pos["entry"]

        if pos is None:
            return
        if hit_t2 and not pos["taken2"] and exit2_frac > 0:
            q = _round_qty(pos["qty0"] * exit2_frac, lot_size)
            q = min(q, pos["qty"])
            if q > 0:
                close_qty(i, t2, q, "t2")
                if pos is None:
                    return
                pos["taken2"] = True

        if pos is None:
            return
        if pos["taken1"] and pos["atr"] > 0:
            if side == 1:
                trail = pos["hh"] - trail_atr * pos["atr"]
                pos["stop"] = max(pos["stop"], trail)
            else:
                trail = pos["ll"] + trail_atr * pos["atr"]
                pos["stop"] = min(pos["stop"], trail)

    for i in range(n):
        reset_day(i)
        mins = ist_minutes(times[i])
        if halt_day is None and day_pnl <= -account * daily_loss_pct:
            halt_day = day_key
            if pos is not None:
                close_qty(i, closes[i], pos["qty"], "daily_loss")
            pending = None
        if consec_loss >= max_consec:
            blocked_until_day = day_key
            pending = None

        manage_pos(i)
        try_fill_pending(i)

        halted = halt_day == day_key or blocked_until_day == day_key
        can_signal = (
            not halted
            and (pos is None or not one_trade)
            and pending is None
            and mins >= session_open + skip_open
            and mins < no_entry_after
        )
        if can_signal and i in by_index:
            # confirmation on this bar; order lives from the next bar
            pending = by_index[i][0]
            pending = dict(pending)
        if i == n - 1 and pos is not None:
            close_qty(i, closes[i], pos["qty"], "end")
        mark_equity(i)

    stats = summarize(trades, account, max_dd, max_dd_pct, cash, mc_runs)
    return {"trades": trades, "equity": equity, "stats": stats}


def summarize(trades, account, max_dd, max_dd_pct, ending, mc_runs):
    n = len(trades)
    wins = [t for t in trades if t.get("win")]
    losses = [t for t in trades if not t.get("win")]
    gp = sum(t["pnl"] for t in wins)
    gl = abs(sum(t["pnl"] for t in losses))
    net = sum(t["pnl"] for t in trades)
    pf = (gp / gl) if gl > 0 else (99.0 if gp > 0 else 0.0)
    wr = (100.0 * len(wins) / n) if n else 0.0
    exp = (net / n) if n else 0.0
    avg_win = (gp / len(wins)) if wins else 0.0
    avg_loss = (gl / len(losses)) if losses else 0.0
    avg_r = (sum(t.get("r") or 0.0 for t in trades) / n) if n else 0.0
    stats = {
        "trades": n,
        "wins": len(wins),
        "losses": len(losses),
        "win_rate": round(wr, 2),
        "profit_factor": round(pf, 3),
        "net_pnl": round(net, 2),
        "expectancy": round(exp, 2),
        "avg_r": round(avg_r, 3),
        "avg_win": round(avg_win, 2),
        "avg_loss": round(avg_loss, 2),
        "max_dd": round(max_dd, 2),
        "max_dd_pct": round(max_dd_pct, 2),
        "ending_equity": round(ending, 2),
        "return_pct": round(100.0 * (ending - account) / account, 2) if account else 0.0,
    }
    if mc_runs and n >= 5:
        stats["monte_carlo"] = _monte_carlo(trades, account, mc_runs)
    return stats


def _monte_carlo(trades, account, runs):
    pnls = [t["pnl"] for t in trades]
    dds = []
    nets = []
    rng = random.Random(42)
    for _ in range(runs):
        seq = pnls[:]
        rng.shuffle(seq)
        eq = account
        peak = account
        dd = 0.0
        for p in seq:
            eq += p
            peak = max(peak, eq)
            dd = max(dd, peak - eq)
        dds.append(dd)
        nets.append(eq - account)
    dds.sort()
    nets.sort()

    def pct(arr, p):
        if not arr:
            return 0.0
        k = min(len(arr) - 1, max(0, int(round((p / 100.0) * (len(arr) - 1)))))
        return arr[k]

    return {
        "runs": runs,
        "dd_p5": round(pct(dds, 5), 2),
        "dd_p50": round(pct(dds, 50), 2),
        "dd_p95": round(pct(dds, 95), 2),
        "net_p5": round(pct(nets, 5), 2),
        "net_p50": round(pct(nets, 50), 2),
        "net_p95": round(pct(nets, 95), 2),
    }
