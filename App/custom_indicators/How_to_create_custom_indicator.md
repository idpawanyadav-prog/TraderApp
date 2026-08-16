# How to create a custom indicator — step by step

TraderApp can plot custom indicators in two ways:

| Method | Where you write it | Best for |
|--------|--------------------|----------|
| **Python plugin** | A `.py` file in this folder (`App/custom_indicators/`) | Zones, swings, ATR boxes, anything that needs Python |
| **Formula editor** | Home chart → Indicators → Custom → **+ New custom indicator** | Simple lines such as SMA, EMA, RSI spreads |

This folder is for **Python plugins**. The app scans it automatically. You do not register the file anywhere else.

Existing examples:

- `demand_supply.py` — supply/demand/BOS **zones** on the candles
- `smoothing.py` — multi-line overlay (special UI; copy this only if you need the same settings panel)

---

## Method A — Python plugin (this folder)

### Step 1. Create a new file

Add a file next to this guide, for example:

```text
App/custom_indicators/my_levels.py
```

Rules:

- Name it `something.py` (letters, numbers, underscore).
- Do **not** start the filename with `_` (those files are ignored).
- Do **not** put the file in a subfolder. Only `*.py` in this directory are loaded.

### Step 2. Add `META` and `compute`

Every plugin **must** define:

1. `META` — a `dict` with a unique `"id"`
2. `compute(candles, params)` — a function that returns a `dict`

If either is missing, the file is skipped.

Minimal skeleton:

```python
"""Short description of what the indicator does."""
from __future__ import annotations

META = {
    "id": "my_levels",          # unique, stable id (no spaces)
    "name": "My levels",        # label in the Indicators picker
    "overlay": True,            # True = on the price pane
    "draw": "zones",            # Python results are drawn as zones
    "params": [
        {"key": "lookback", "label": "Lookback", "def": 20, "min": 2, "max": 200, "step": 1},
        {"key": "show_high", "label": "Show high", "def": True, "type": "bool"},
        {"key": "show_low", "label": "Show low", "def": True, "type": "bool"},
    ],
}


def compute(candles, params=None):
    params = params if isinstance(params, dict) else {}
    # ... calculate ...
    return {"zones": [], "stats": {}}
```

### Step 3. Fill in `META`

| Field | Required | Meaning |
|-------|----------|---------|
| `id` | **Yes** | Unique key sent to `/api/custom-indicators/compute`. Use snake_case. Never change it later or saved charts will lose the indicator. |
| `name` | No | Display name. Defaults to `id`. |
| `overlay` | No | `True` (default) = price pane. |
| `draw` | No | Use `"zones"` for plugins in this folder. `"lines"` is reserved for the built-in Smoothing UI. |
| `params` | No | Settings shown when the user adds/edits the indicator. |

Each param object:

| Field | Meaning |
|-------|---------|
| `key` | Name you read in `params` inside `compute` |
| `label` | Label in the settings dialog |
| `def` | Default value |
| `min` / `max` / `step` | For numbers |
| `type` | `"number"` (default) or `"bool"` |

### Step 4. Read candles

`compute` receives a list of candle dicts from the loaded chart (newest last). Each candle looks like:

```python
{
    "timestamp": 1710000000000,  # milliseconds (sometimes "time")
    "open": 100.0,
    "high": 101.5,
    "low": 99.2,
    "close": 100.8,
    "volume": 12345
}
```

Skip incomplete rows. Convert values to `float`. Keep `timestamp` aligned with the chart so zones sit on the right bars.

Typical parse:

```python
def _num(v, default=None):
    try:
        if v is None or v == "":
            return default
        return float(v)
    except (TypeError, ValueError):
        return default


def _parse(raw):
    times, opens, highs, lows, closes = [], [], [], [], []
    for c in raw or []:
        if not isinstance(c, dict):
            continue
        ts = c.get("timestamp", c.get("time"))
        o, h, l, cl = _num(c.get("open")), _num(c.get("high")), _num(c.get("low")), _num(c.get("close"))
        if ts is None or None in (o, h, l, cl):
            continue
        times.append(int(ts) if not isinstance(ts, float) else ts)
        opens.append(o)
        highs.append(h)
        lows.append(l)
        closes.append(cl)
    return times, opens, highs, lows, closes
```

### Step 5. Return zones the chart can draw

The Home chart draws Python plugins as **boxes / BOS lines**. Return:

```python
{
    "zones": [ ... ],
    "stats": { "optional": "counts for the legend" }
}
```

Each zone:

| Field | Required | Meaning |
|-------|----------|---------|
| `type` | Yes | `"supply"`, `"demand"`, or `"bos"` (colors/labels) |
| `top` | Yes | Upper price of the box |
| `bottom` | Yes | Lower price of the box |
| `start_time` | Yes | Zone start, same units as candle `timestamp` |
| `end_time` | Yes | Zone end timestamp |
| `poi` | For `bos` | Price of the BOS line (mid of the box if omitted) |
| `broken` | No | `true` if the zone is no longer live |

If there is not enough data, return empty zones. Do not raise unless the request is invalid.

**Use only past bars** (causal). A value at bar `i` should not depend on `i+1`, or the drawing will jump when the last candle updates.

### Step 6. Copy-paste starter: lookback high / low band

Save as `App/custom_indicators/lookback_band.py`:

```python
"""Rolling lookback high/low band as demand/supply-style zones."""
from __future__ import annotations

META = {
    "id": "lookback_band",
    "name": "Lookback band",
    "overlay": True,
    "draw": "zones",
    "params": [
        {"key": "length", "label": "Length", "def": 20, "min": 2, "max": 300, "step": 1},
    ],
}


def _num(v, default=None):
    try:
        if v is None or v == "":
            return default
        return float(v)
    except (TypeError, ValueError):
        return default


def compute(candles, params=None):
    params = params if isinstance(params, dict) else {}
    try:
        length = int(params.get("length") or 20)
    except (TypeError, ValueError):
        length = 20
    length = max(2, min(300, length))

    times, highs, lows = [], [], []
    for c in candles or []:
        if not isinstance(c, dict):
            continue
        ts = c.get("timestamp", c.get("time"))
        h, l = _num(c.get("high")), _num(c.get("low"))
        if ts is None or h is None or l is None:
            continue
        times.append(int(ts) if not isinstance(ts, float) else ts)
        highs.append(h)
        lows.append(l)

    n = len(times)
    if n < length:
        return {"zones": [], "stats": {"bars": n}}

    hi = max(highs[-length:])
    lo = min(lows[-length:])
    t0 = times[-length]
    t1 = times[-1]
    return {
        "zones": [
            {
                "type": "supply",
                "top": hi,
                "bottom": hi,
                "poi": hi,
                "start_time": t0,
                "end_time": t1,
                "broken": False,
            },
            {
                "type": "demand",
                "top": lo,
                "bottom": lo,
                "poi": lo,
                "start_time": t0,
                "end_time": t1,
                "broken": False,
            },
        ],
        "stats": {"length": length, "high": hi, "low": lo},
    }
```

### Step 7. Restart / refresh so the app sees the file

1. Save the `.py` file.
2. Restart the TraderApp server if it was already running (safest), or at least reload the Home page.
3. Open **Home**, load a chart, click **Indicators** (ƒx).
4. Open the **Custom** section.
5. Under **Python indicators**, click your name (for example **Lookback band**).

If it does not appear:

- Filename starts with `_` → ignored
- Syntax error on import → check the server console traceback
- No `META["id"]` or no `compute` → ignored
- Browser still has an old JS cache → hard-refresh the page

### Step 8. Change settings

After the indicator is on the chart, open it from the indicator legend / picker settings. Values you put in `META["params"]` show up there and are sent back into `compute` as `params`.

### Step 9. Debug

- Print to the **server terminal**, not the browser. `compute` runs in Python.
- Return `{"zones": [], "stats": {"error": "not enough bars"}}` instead of throwing, so the chart stays up.
- Keep `compute` reasonably fast. The app may send up to 25,000 candles.

---

## Method B — Formula editor (no Python file)

Use this for a single line from OHLCV.

1. Load a chart on **Home**.
2. Open **Indicators**.
3. **Custom** → **+ New custom indicator**.
4. Set **Name**, **Formula**, **Placement** (overlay vs new pane), **Plot style**, **Color**.
5. Click **Save & add to chart**.

**Sources:** `open`, `high`, `low`, `close`, `volume`, `hl2`, `hlc3`, `ohlc4`

**Functions:** `SMA` `EMA` `WMA` `RSI` `STDDEV` `HHV` `LLV` `SUM` `REF` `CHANGE` `ABS` `MAX` `MIN` `IF`

**Examples:**

```text
SMA(close, 20)
RSI(close, 14)
EMA(close, 12) - EMA(close, 26)
SMA(close, 20) - SMA(close, 50)
```

Formulas are stored in the browser (not in this folder). Edit or delete them from the same Custom list.

---

## Checklist before you commit a Python indicator

- [ ] File is `App/custom_indicators/<name>.py` and does not start with `_`
- [ ] `META["id"]` is unique (`demand_supply` and `smoothing` are taken)
- [ ] `compute(candles, params)` returns a dict with `zones` (list)
- [ ] Zone `start_time` / `end_time` use candle timestamps
- [ ] Calculation is causal (no future bars)
- [ ] Bad/short data returns empty `zones`, not an exception
- [ ] Indicator appears under Indicators → Custom → Python indicators after a refresh
