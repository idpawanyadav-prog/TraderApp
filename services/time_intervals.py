"""Per-broker TimeInterval settings: lookback days and optional resample."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

_IST = timezone(timedelta(hours=5, minutes=30))

RESAMPLE_OPTIONS = (
    {"id": "", "label": "Native"},
    {"id": "W", "label": "Weekly"},
    {"id": "M", "label": "Monthly"},
    {"id": "Q", "label": "Quarterly"},
    {"id": "Y", "label": "Yearly"},
)

NATIVE_INTERVALS = {
    "dhan": [
        {"id": "1", "label": "1m"},
        {"id": "5", "label": "5m"},
        {"id": "15", "label": "15m"},
        {"id": "25", "label": "25m"},
        {"id": "60", "label": "1h"},
        {"id": "D", "label": "1D"},
    ],
    "5paisa": [
        {"id": "1", "label": "1m"},
        {"id": "5", "label": "5m"},
        {"id": "15", "label": "15m"},
        {"id": "25", "label": "30m"},
        {"id": "60", "label": "1h"},
        {"id": "D", "label": "1D"},
    ],
    "yahoo": [
        {"id": "1", "label": "1m"},
        {"id": "5", "label": "5m"},
        {"id": "15", "label": "15m"},
        {"id": "25", "label": "30m"},
        {"id": "60", "label": "1h"},
        {"id": "90", "label": "90m"},
        {"id": "D", "label": "1D"},
        {"id": "W", "label": "1W"},
        {"id": "M", "label": "1M"},
        {"id": "Q", "label": "1Q"},
    ],
}

_DEFAULT_DAYS = {
    "1": 10,
    "5": 21,
    "15": 45,
    "25": 60,
    "60": 120,
    "90": 120,
    "D": 365 * 5,
    "W": 365 * 5,
    "M": 365 * 8,
    "Q": 365 * 10,
}

_INTRADAY = {"1", "5", "15", "25", "30", "60", "90"}


def _row(iid, label, days=None, source=None, resample=""):
    src = source or iid
    return {
        "id": str(iid),
        "label": str(label),
        "source": str(src),
        "resample": str(resample or ""),
        "days": int(days if days is not None else _DEFAULT_DAYS.get(str(iid), 30)),
        "enabled": True,
    }


def default_intervals(broker: str) -> list:
    broker = _broker_key(broker)
    if broker == "yahoo":
        return [
            _row("1", "1m", 8),
            _row("5", "5m", 21),
            _row("15", "15m", 45),
            _row("25", "30m", 60),
            _row("60", "1h", 120),
            _row("D", "1D", 365 * 5),
        ]
    return [
        _row("1", "1m", 10),
        _row("5", "5m", 21),
        _row("15", "15m", 45),
        _row("25", "25m" if broker == "dhan" else "30m", 60),
        _row("60", "1h", 120),
        _row("D", "1D", 365 * 5),
    ]


BROKERS = ("dhan", "5paisa", "yahoo")


def default_broker_intervals() -> dict:
    return {k: default_intervals(k) for k in BROKERS}


def _broker_key(broker) -> str:
    b = str(broker or "5paisa").strip().lower()
    if b in ("5paisa", "fp", "fivepaisa"):
        return "5paisa"
    if b in ("yahoo", "yf"):
        return "yahoo"
    return "dhan"


def native_ids(broker: str) -> set:
    return {x["id"] for x in NATIVE_INTERVALS.get(_broker_key(broker), [])}


def native_catalog(broker: str) -> list:
    return [dict(x) for x in NATIVE_INTERVALS.get(_broker_key(broker), [])]


def _slug_id(label: str, used: set) -> str:
    raw = "".join(ch for ch in str(label or "") if ch.isalnum()).upper() or "IVL"
    aliases = {"WEEKLY": "W", "1W": "W", "MONTHLY": "M", "1M": "M",
               "QUARTERLY": "Q", "1Q": "Q", "YEARLY": "Y", "1Y": "Y",
               "DAILY": "D", "1D": "D"}
    base = aliases.get(raw, raw)
    candidate = base
    n = 2
    while candidate in used:
        candidate = base + str(n)
        n += 1
    return candidate[:24]


def normalize_interval_row(item, broker: str, used_ids: set) -> dict | None:
    if not isinstance(item, dict):
        return None
    natives = native_ids(broker)
    label = str(item.get("label") or "").strip()[:16]
    source = str(item.get("source") or item.get("interval") or "").strip()
    iid = str(item.get("id") or "").strip()[:24]
    resample = str(item.get("resample") or "").strip().upper()
    if resample not in ("", "W", "M", "Q", "Y"):
        resample = ""
    if source not in natives:
        return None
    if not label:
        label = next((n["label"] for n in native_catalog(broker) if n["id"] == source), source)
    if not iid or iid in used_ids:
        iid = _slug_id(label, used_ids)
    try:
        days = int(item.get("days") or 0)
    except (TypeError, ValueError):
        days = _DEFAULT_DAYS.get(source, 30)
    days = max(1, min(days, 365 * 20))
    enabled = item.get("enabled", True)
    if enabled in (0, "0", "false", "False"):
        enabled = False
    else:
        enabled = bool(enabled)
    used_ids.add(iid)
    return {
        "id": iid,
        "label": label,
        "source": source,
        "resample": resample,
        "days": days,
        "enabled": enabled,
    }


def normalize_broker_intervals(raw, broker: str) -> list:
    used = set()
    out = []
    for item in (raw or []):
        row = normalize_interval_row(item, broker, used)
        if row:
            out.append(row)
    if not out:
        return default_intervals(broker)
    if not any(r.get("enabled") for r in out):
        out[0]["enabled"] = True
    return out


def normalize_all_intervals(raw) -> dict:
    raw = raw if isinstance(raw, dict) else {}
    out = {}
    for broker in BROKERS:
        out[broker] = normalize_broker_intervals(raw.get(broker), broker)
    return out


def resolve_interval(settings: dict, broker: str, interval_id: str) -> dict:
    broker = _broker_key(broker)
    rows = normalize_broker_intervals(
        (settings or {}).get("broker_intervals", {}).get(broker),
        broker,
    )
    want = str(interval_id or "")
    for row in rows:
        if row["id"] == want:
            return dict(row)
    for row in rows:
        if row.get("enabled"):
            return dict(row)
    return dict(rows[0])


def is_intraday(interval_id: str) -> bool:
    return str(interval_id) in _INTRADAY


_INTERVAL_SEC = {
    "1": 60,
    "5": 300,
    "15": 900,
    "25": 1500,
    "30": 1800,
    "60": 3600,
    "90": 5400,
}
_INTERVAL_RANK = {
    "1": 1, "5": 2, "15": 3, "25": 4, "30": 4, "60": 5, "90": 6,
    "D": 7, "W": 8, "M": 9, "Q": 10, "Y": 11,
}


def _bar_bucket(ts, interval_id: str):
    iid = str(interval_id or "")
    if iid in ("W", "M", "Q", "Y"):
        return _bucket_key(ts, iid)
    try:
        dt = datetime.fromtimestamp(int(ts), timezone.utc).astimezone(_IST)
    except (TypeError, ValueError, OSError):
        return None
    if iid == "D":
        return (dt.year, dt.month, dt.day)
    sec = _INTERVAL_SEC.get(iid)
    if not sec:
        return None
    step = max(1, sec // 60)
    minutes = dt.hour * 60 + dt.minute
    return (dt.year, dt.month, dt.day, (minutes // step) * step)


def detect_native_interval(candles: list) -> str:
    times = []
    for c in candles or []:
        try:
            times.append(int(c.get("time")))
        except (TypeError, ValueError):
            continue
    times.sort()
    deltas = []
    for a, b in zip(times, times[1:]):
        d = b - a
        if 20 <= d <= 8 * 3600:
            deltas.append(d)
        elif 16 * 3600 <= d <= 4 * 86400:
            deltas.append(d)
    if not deltas:
        return "1"
    deltas.sort()
    med = deltas[len(deltas) // 2]
    snaps = (
        (90, "1"), (7 * 60, "5"), (20 * 60, "15"), (27 * 60, "25"),
        (45 * 60, "30"), (2 * 3600, "60"), (4 * 3600, "90"),
        (2 * 86400, "D"), (8 * 86400, "W"), (40 * 86400, "M"),
        (120 * 86400, "Q"),
    )
    for limit, iid in snaps:
        if med <= limit:
            return iid
    return "Y"


def _aggregate_candles(candles: list, interval_id: str) -> list:
    buckets = []
    current_key = None
    current = None
    for c in candles or []:
        key = _bar_bucket(c.get("time"), interval_id)
        if key is None:
            continue
        if current is None or key != current_key:
            if current is not None:
                buckets.append(current)
            current_key = key
            current = {
                "time": int(c["time"]),
                "open": c.get("open", 0),
                "high": c.get("high", 0),
                "low": c.get("low", 0),
                "close": c.get("close", 0),
                "volume": int(c.get("volume") or 0),
            }
            continue
        current["high"] = max(current["high"], c.get("high", current["high"]))
        current["low"] = min(current["low"], c.get("low", current["low"]))
        current["close"] = c.get("close", current["close"])
        current["volume"] = int(current["volume"]) + int(c.get("volume") or 0)
    if current is not None:
        buckets.append(current)
    return buckets


def combine_candles_to_interval(candles: list, target_id: str) -> list:
    target = str(target_id or "1")
    if not candles:
        return candles or []
    if target not in _INTERVAL_RANK:
        return candles
    candles = sorted(candles, key=lambda c: int(c.get("time") or 0))
    native = detect_native_interval(candles)
    if _INTERVAL_RANK.get(target, 0) <= _INTERVAL_RANK.get(native, 0):
        return candles
    return _aggregate_candles(candles, target)


def combine_overlays_to_interval(overlays: list, target_id: str, candles: list | None = None) -> list:
    target = str(target_id or "1")
    native = detect_native_interval(candles or [])
    if target not in _INTERVAL_RANK or _INTERVAL_RANK.get(target, 0) <= _INTERVAL_RANK.get(native, 0):
        return overlays or []
    out = []
    for ov in overlays or []:
        if not isinstance(ov, dict):
            continue
        item = dict(ov)
        item["line"] = resample_points(item.get("line") or [], target)
        item["labels"] = resample_points(item.get("labels") or [], target)
        out.append(item)
    return out


def _bucket_key(ts, period: str):
    dt = datetime.fromtimestamp(int(ts), timezone.utc).astimezone(_IST)
    if period == "W":
        iso = dt.isocalendar()
        return (iso[0], iso[1])
    if period == "M":
        return (dt.year, dt.month)
    if period == "Q":
        return (dt.year, (dt.month - 1) // 3)
    if period == "Y":
        return (dt.year,)
    return None


def resample_points(points: list, period: str, time_key="time") -> list:
    period = str(period or "").upper()
    if not period or not points:
        return points
    buckets = []
    current_key = None
    current = None
    for p in points:
        if not isinstance(p, dict):
            continue
        ts = p.get(time_key)
        if ts is None:
            continue
        key = _bar_bucket(ts, period)
        if key is None:
            continue
        if current is None or key != current_key:
            if current is not None:
                buckets.append(current)
            current_key = key
            current = dict(p)
            current[time_key] = int(ts)
            continue
        bucket_ts = current[time_key]
        current.update(p)
        current[time_key] = bucket_ts
    if current is not None:
        buckets.append(current)
    return buckets


def resample_candles(candles: list, period: str) -> list:
    period = str(period or "").upper()
    if not period or period not in ("W", "M", "Q", "Y") or not candles:
        return candles
    buckets = []
    current_key = None
    current = None
    for c in candles:
        key = _bucket_key(c.get("time"), period)
        if key is None:
            continue
        if current is None or key != current_key:
            if current is not None:
                buckets.append(current)
            current_key = key
            current = {
                "time": int(c["time"]),
                "open": c.get("open", 0),
                "high": c.get("high", 0),
                "low": c.get("low", 0),
                "close": c.get("close", 0),
                "volume": int(c.get("volume") or 0),
            }
            continue
        current["high"] = max(current["high"], c.get("high", current["high"]))
        current["low"] = min(current["low"], c.get("low", current["low"]))
        current["close"] = c.get("close", current["close"])
        current["volume"] = int(current["volume"]) + int(c.get("volume") or 0)
    if current is not None:
        buckets.append(current)
    return buckets


def apply_interval_transform(candles: list, cfg: dict, filter_hours_fn) -> list:
    source = str((cfg or {}).get("source") or "")
    resample = str((cfg or {}).get("resample") or "")
    out = candles or []
    if is_intraday(source) and callable(filter_hours_fn):
        out = filter_hours_fn(out, source)
    if resample:
        out = resample_candles(out, resample)
    return out
