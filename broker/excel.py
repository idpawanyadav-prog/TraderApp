"""
Excel broker: read OHLC (+ optional indicator columns) from workbooks
currently open in Microsoft Excel (COM / xlwings).
"""
from __future__ import annotations

import math
import os
import re
import sys
import threading
from datetime import datetime, time as dtime, timedelta, timezone
_lock = threading.Lock()
IST = timezone(timedelta(hours=5, minutes=30))

MAX_ROWS = 20000
MAX_COLS = 48
DETECT_SCAN_ROWS = 80

OHLC_ALIASES = {
    "date": ("date", "dt", "dtm", "datetime", "time", "timestamp"),
    "open": ("open", "o", "opn"),
    "high": ("high", "h", "hi"),
    "low": ("low", "l", "lo"),
    "close": ("close", "c", "cl", "last", "ltp"),
    "volume": ("volume", "vol", "v", "qty", "quantity"),
}

_NUM_RE = re.compile(r"^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$")


class ExcelUnavailable(RuntimeError):
    pass


def _require_xlwings():
    try:
        import vendor_libs
        vendor_libs.setup()
    except Exception:
        pass
    try:
        import xlwings as xw  # noqa: F401
        return xw
    except Exception as e:
        if sys.platform == "win32":
            hint = "pip install xlwings pywin32"
        else:
            hint = "pip install xlwings"
        raise ExcelUnavailable("xlwings is not installed. " + hint) from e


def _with_com(fn):
    # Windows: Excel is driven through COM, which needs pywin32/pythoncom.
    # macOS: xlwings talks to Excel for Mac via its own bridge (no COM),
    # so pythoncom initialization is skipped on non-Windows platforms.
    if sys.platform != "win32":
        with _lock:
            return fn()
    try:
        import pythoncom
    except Exception as e:
        raise ExcelUnavailable("pywin32/pythoncom is required to talk to Excel.") from e
    inited = False
    try:
        pythoncom.CoInitialize()
        inited = True
    except Exception:
        # Thread already has a COM apartment (common with Flask-SocketIO).
        pass
    try:
        with _lock:
            return fn()
    finally:
        if inited:
            try:
                pythoncom.CoUninitialize()
            except Exception:
                pass


def _no_excel_message(details: list[str]) -> str:
    bits = "64-bit" if sys.maxsize > 2**32 else "32-bit"
    lines = [
        "No open Excel instance found that Python can attach to.",
        "Desktop Excel must be running with a workbook open (Enable Editing if Protected View).",
        "Python is {}. Excel must be the same bitness. Do not mix Administrator / normal user.".format(bits),
        "In Excel: File → Options → Advanced → uncheck “Ignore other applications that use Dynamic Data Exchange (DDE)”.",
    ]
    extra = [d for d in details if d]
    if extra:
        lines.append("Details: " + " | ".join(extra[:3]))
    return " ".join(lines)


def _app_pid(app) -> int | None:
    try:
        return int(app.pid)
    except Exception:
        return None


def _wrap_com_app(xw, com):
    """Attach xlwings to an already-running Excel.Application COM object."""
    try:
        return xw.apps.add(xl=com, add_book=False)
    except TypeError:
        return xw.App(impl=xw.apps.impl.add(xl=com, add_book=False))


def _iter_excel_apps(xw):
    """Yield every reachable Excel instance (HWND scan + Running Object Table)."""
    seen = set()
    errors = []

    def _yield(app):
        pid = _app_pid(app)
        key = pid if pid is not None else id(app)
        if key in seen:
            return False
        seen.add(key)
        return True

    try:
        for app in xw.apps:
            if _yield(app):
                yield app
    except Exception as e:
        errors.append("xlwings: {}".format(e))

    if sys.platform == "win32":
        try:
            import win32com.client
            com = win32com.client.GetActiveObject("Excel.Application")
            app = _wrap_com_app(xw, com)
            if _yield(app):
                yield app
        except Exception as e:
            errors.append("GetActiveObject: {}".format(e))
        if not seen:
            try:
                import win32com.client
                com = win32com.client.GetObject(Class="Excel.Application")
                app = _wrap_com_app(xw, com)
                if _yield(app):
                    yield app
            except Exception as e:
                errors.append("GetObject: {}".format(e))

    if not seen:
        raise ExcelUnavailable(_no_excel_message(errors))


def _book_names(book) -> list[str]:
    names = []
    try:
        n = (book.name or "").strip()
        if n:
            names.append(n)
    except Exception:
        pass
    try:
        full = (book.fullname or "").strip()
        if full:
            names.append(full)
            names.append(os.path.basename(full))
    except Exception:
        pass
    return names


def _find_book(app, workbook: str):
    name = (workbook or "").strip()
    if not name:
        raise ExcelUnavailable("Workbook name is required.")
    target = name.lower()
    target_base = os.path.basename(name).lower()
    for b in app.books:
        aliases = [a.lower() for a in _book_names(b)]
        if target in aliases or target_base in aliases:
            return b
    raise ExcelUnavailable("Workbook '{}' is not open in Excel.".format(name))


def _find_open_book(xw, workbook: str):
    last = None
    for app in _iter_excel_apps(xw):
        try:
            return _find_book(app, workbook)
        except ExcelUnavailable as e:
            last = e
    if last:
        raise last
    raise ExcelUnavailable("Workbook '{}' is not open in Excel.".format(workbook))


def _as_grid(val, n_rows: int, n_cols: int):
    if n_rows < 1 or n_cols < 1:
        return []
    if val is None:
        return [[None] * n_cols for _ in range(n_rows)]
    if n_rows == 1 and n_cols == 1:
        return [[val]]
    if n_rows == 1:
        row = list(val) if isinstance(val, (list, tuple)) else [val]
        if len(row) < n_cols:
            row = row + [None] * (n_cols - len(row))
        return [row[:n_cols]]
    if n_cols == 1:
        col = list(val) if isinstance(val, (list, tuple)) else [val]
        out = []
        for i in range(n_rows):
            cell = col[i] if i < len(col) else None
            if isinstance(cell, (list, tuple)):
                cell = cell[0] if cell else None
            out.append([cell])
        return out
    rows = []
    src = list(val) if isinstance(val, (list, tuple)) else [[val]]
    for i in range(n_rows):
        raw = src[i] if i < len(src) else None
        if not isinstance(raw, (list, tuple)):
            raw = [raw]
        row = list(raw)
        if len(row) < n_cols:
            row = row + [None] * (n_cols - len(row))
        rows.append(row[:n_cols])
    return rows


def _read_sheet_grid(sht):
    used = sht.used_range
    if used is None:
        return [], 1, 1
    last = used.last_cell
    end_row = min(int(last.row), MAX_ROWS)
    end_col = min(int(last.column), MAX_COLS)
    if end_row < 1 or end_col < 1:
        return [], 1, 1
    val = sht.range((1, 1), (end_row, end_col)).value
    return _as_grid(val, end_row, end_col), end_row, end_col


def list_workbooks():
    xw = _require_xlwings()

    def _run():
        names = []
        seen = set()
        for app in _iter_excel_apps(xw):
            for b in app.books:
                n = (b.name or "").strip()
                if n and n.lower() not in seen:
                    seen.add(n.lower())
                    names.append(n)
        return names

    return _with_com(_run)


def list_sheets(workbook: str):
    xw = _require_xlwings()

    def _run():
        wb = _find_open_book(xw, workbook)
        return [(s.name or "").strip() for s in wb.sheets if (s.name or "").strip()]

    return _with_com(_run)


def _norm_header(val) -> str:
    if val is None:
        return ""
    if isinstance(val, datetime):
        return val.strftime("%Y-%m-%d")
    if isinstance(val, float) and val == int(val):
        return str(int(val))
    return str(val).strip()


def _header_key(val) -> str:
    s = _norm_header(val).lower()
    s = re.sub(r"[^a-z0-9]+", "", s)
    return s


def _row_filled(row) -> list:
    out = []
    seen = set()
    for cell in row:
        label = _norm_header(cell)
        if not label:
            continue
        if label in seen:
            continue
        seen.add(label)
        out.append(label)
    return out


def _score_header_row(row) -> int:
    keys = {_header_key(c) for c in row if _norm_header(c)}
    if not keys:
        return 0
    score = 0
    for field, aliases in OHLC_ALIASES.items():
        if any(a.replace(" ", "") in keys or a in keys for a in aliases):
            # aliases already compacted-ish
            hit = False
            for a in aliases:
                ak = re.sub(r"[^a-z0-9]+", "", a)
                if ak in keys:
                    hit = True
                    break
            if hit:
                score += 3 if field != "volume" else 1
    return score


def detect_header_row(grid) -> int | None:
    """Return 0-based row index in grid, or None."""
    best_i = None
    best_score = 0
    limit = min(len(grid), DETECT_SCAN_ROWS)
    for i in range(limit):
        sc = _score_header_row(grid[i])
        if sc > best_score:
            best_score = sc
            best_i = i
            if sc >= 12:
                break
    if best_score < 6:
        return None
    return best_i


def _auto_mapping(headers: list[str]) -> dict:
    keyed = [(_header_key(h), h) for h in headers]
    mapping = {k: "" for k in ("date", "open", "high", "low", "close", "volume")}
    used = set()
    for field, aliases in OHLC_ALIASES.items():
        alias_keys = [re.sub(r"[^a-z0-9]+", "", a) for a in aliases]
        picked = ""
        for ak in alias_keys:
            for hk, label in keyed:
                if hk == ak and label not in used:
                    picked = label
                    break
            if picked:
                break
        if picked:
            mapping[field] = picked
            used.add(picked)
    return mapping


def preview_sheet(workbook: str, sheet: str, header_row=None):
    xw = _require_xlwings()
    wb_name = (workbook or "").strip()
    sh_name = (sheet or "").strip()
    if not wb_name or not sh_name:
        raise ExcelUnavailable("Workbook and sheet are required.")

    def _run():
        wb = _find_open_book(xw, wb_name)
        try:
            sht = wb.sheets[sh_name]
        except Exception as e:
            raise ExcelUnavailable("Sheet '{}' not found in '{}'.".format(sh_name, wb_name)) from e
        grid, end_row, end_col = _read_sheet_grid(sht)
        detected = detect_header_row(grid)
        use_idx = None
        if header_row not in (None, "", 0, "0"):
            try:
                hr = int(header_row)
            except (TypeError, ValueError):
                hr = 0
            if hr >= 1:
                use_idx = hr - 1
        if use_idx is None:
            use_idx = detected if detected is not None else 0
        use_idx = max(0, min(use_idx, max(0, len(grid) - 1)))
        headers = _row_filled(grid[use_idx]) if grid else []
        return {
            "success": True,
            "workbook": wb_name,
            "sheet": sh_name,
            "header_row": use_idx + 1,
            "detected_header_row": (detected + 1) if detected is not None else None,
            "headers": headers,
            "mapping": _auto_mapping(headers),
            "rows": end_row,
            "cols": end_col,
        }

    return _with_com(_run)


def _parse_number(val):
    if val is None or val == "":
        return None
    if isinstance(val, bool):
        return None
    if isinstance(val, (int, float)):
        f = float(val)
        if math.isfinite(f):
            return f
        return None
    s = str(val).strip().replace(",", "")
    if not s or not _NUM_RE.match(s):
        return None
    try:
        f = float(s)
    except ValueError:
        return None
    return f if math.isfinite(f) else None


def _excel_serial_to_dt(n: float) -> datetime:
    # Excel serial 1 = 1899-12-31; 25569 = 1970-01-01
    base = datetime(1899, 12, 30, tzinfo=IST)
    days = int(n)
    frac = float(n) - days
    return base + timedelta(days=days, seconds=round(frac * 86400))


def parse_excel_datetime(val) -> datetime | None:
    if val is None or val == "":
        return None
    if isinstance(val, datetime):
        dt = val
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=IST)
        return dt
    if isinstance(val, dtime) and not isinstance(val, datetime):
        today = datetime.now(IST).date()
        return datetime.combine(today, val, tzinfo=IST)
    if isinstance(val, (int, float)) and not isinstance(val, bool):
        n = float(val)
        if 20000 <= n <= 80000:
            return _excel_serial_to_dt(n)
        if n > 1e11:
            return datetime.fromtimestamp(n / 1000.0, tz=IST)
        if n > 1e9:
            return datetime.fromtimestamp(n, tz=IST)
        return None
    s = str(val).strip()
    if not s:
        return None
    for fmt in (
        "%Y-%m-%d %H:%M:%S",
        "%Y-%m-%d %H:%M",
        "%Y-%m-%d",
        "%d-%m-%Y %H:%M:%S",
        "%d-%m-%Y %H:%M",
        "%d-%m-%Y",
        "%d/%m/%Y %H:%M:%S",
        "%d/%m/%Y %H:%M",
        "%d/%m/%Y",
        "%m/%d/%Y %H:%M:%S",
        "%m/%d/%Y %H:%M",
        "%m/%d/%Y",
        "%Y/%m/%d %H:%M:%S",
        "%Y/%m/%d",
    ):
        try:
            return datetime.strptime(s, fmt).replace(tzinfo=IST)
        except ValueError:
            continue
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00")).astimezone(IST)
    except ValueError:
        return None


def parse_indicator_cell(val) -> tuple[list[float], list[str]]:
    values: list[float] = []
    labels: list[str] = []
    if val is None or val == "":
        return values, labels
    if isinstance(val, bool):
        labels.append(str(val))
        return values, labels
    if isinstance(val, (int, float)):
        f = float(val)
        if math.isfinite(f):
            values.append(f)
        return values, labels
    text = str(val).strip()
    if not text:
        return values, labels
    parts = [p.strip() for p in text.replace(";", ",").split(",")]
    if len(parts) == 1:
        num = _parse_number(parts[0])
        if num is not None:
            values.append(num)
        else:
            labels.append(parts[0])
        return values, labels
    for p in parts:
        if not p:
            continue
        num = _parse_number(p)
        if num is not None:
            values.append(num)
        else:
            labels.append(p)
    return values, labels


def _col_index(headers_row, name: str) -> int | None:
    want = _norm_header(name)
    if not want:
        return None
    want_key = _header_key(want)
    for i, cell in enumerate(headers_row):
        label = _norm_header(cell)
        if label == want or _header_key(label) == want_key:
            return i
    return None


def _row_get(row, idx):
    if idx is None or idx < 0 or idx >= len(row):
        return None
    return row[idx]


def get_chart_data(config: dict) -> dict:
    xw = _require_xlwings()
    wb_name = (config.get("workbook") or "").strip()
    sh_name = (config.get("sheet") or "").strip()
    if not wb_name or not sh_name:
        raise ExcelUnavailable("Workbook and sheet are required.")
    mapping = config.get("mapping") if isinstance(config.get("mapping"), dict) else {}
    indicators = config.get("indicators") if isinstance(config.get("indicators"), list) else []
    try:
        header_row = int(config.get("header_row") or 0)
    except (TypeError, ValueError):
        header_row = 0

    def _run():
        wb = _find_open_book(xw, wb_name)
        try:
            sht = wb.sheets[sh_name]
        except Exception as e:
            raise ExcelUnavailable("Sheet '{}' not found in '{}'.".format(sh_name, wb_name)) from e
        grid, _, _ = _read_sheet_grid(sht)
        if not grid:
            raise ExcelUnavailable("Sheet is empty.")
        hdr_idx = header_row - 1 if header_row >= 1 else None
        if hdr_idx is None:
            detected = detect_header_row(grid)
            hdr_idx = detected if detected is not None else 0
        hdr_idx = max(0, min(hdr_idx, len(grid) - 1))
        header = grid[hdr_idx]
        date_i = _col_index(header, mapping.get("date") or "")
        open_i = _col_index(header, mapping.get("open") or "")
        high_i = _col_index(header, mapping.get("high") or "")
        low_i = _col_index(header, mapping.get("low") or "")
        close_i = _col_index(header, mapping.get("close") or "")
        vol_i = _col_index(header, mapping.get("volume") or "")
        if date_i is None or open_i is None or high_i is None or low_i is None or close_i is None:
            raise ExcelUnavailable(
                "Map Date, Open, High, Low, and Close to header columns before loading the chart."
            )
        ind_cols = []
        for item in indicators:
            if not isinstance(item, dict):
                continue
            name = str(item.get("name") or item.get("column") or "").strip()[:40]
            col = str(item.get("column") or "").strip()
            if not name or not col:
                continue
            idx = _col_index(header, col)
            if idx is None:
                continue
            ind_cols.append({"name": name, "idx": idx, "line": [], "labels": []})

        candles = []
        for row in grid[hdr_idx + 1:]:
            dt = parse_excel_datetime(_row_get(row, date_i))
            o = _parse_number(_row_get(row, open_i))
            h = _parse_number(_row_get(row, high_i))
            l = _parse_number(_row_get(row, low_i))
            c = _parse_number(_row_get(row, close_i))
            if dt is None or o is None or h is None or l is None or c is None:
                continue
            vol = _parse_number(_row_get(row, vol_i)) if vol_i is not None else 0.0
            ts = int(dt.timestamp())
            candles.append({
                "time": ts,
                "open": o,
                "high": h,
                "low": l,
                "close": c,
                "volume": vol if vol is not None else 0.0,
            })
            for ind in ind_cols:
                nums, labs = parse_indicator_cell(_row_get(row, ind["idx"]))
                for n in nums:
                    ind["line"].append({"time": ts, "value": n})
                for lab in labs:
                    ind["labels"].append({"time": ts, "text": lab})

        overlays = []
        for ind in ind_cols:
            overlays.append({
                "name": ind["name"],
                "line": ind["line"],
                "labels": ind["labels"],
            })
        return {
            "success": True,
            "candles": candles,
            "count": len(candles),
            "overlays": overlays,
            "header_row": hdr_idx + 1,
        }

    return _with_com(_run)


def search_configs(configs: list, q: str, limit: int = 20) -> list[dict]:
    qn = (q or "").strip().lower()
    out = []
    for cfg in configs or []:
        if not isinstance(cfg, dict):
            continue
        name = str(cfg.get("name") or "").strip()
        if not name:
            continue
        wb = str(cfg.get("workbook") or "").strip()
        sh = str(cfg.get("sheet") or "").strip()
        blob = " ".join([name, wb, sh]).lower()
        if qn and qn not in blob:
            continue
        cid = str(cfg.get("id") or "")
        try:
            poll = int(cfg.get("poll_seconds") or 5)
        except (TypeError, ValueError):
            poll = 5
        out.append({
            "trading_symbol": name,
            "name": (wb + " / " + sh) if wb else name,
            "scrip_code": cid,
            "excel_config_id": cid,
            "exchange_label": "Excel",
            "poll_seconds": max(1, min(poll, 3600)),
        })
        if len(out) >= limit:
            break
    return out


def find_config(configs: list, config_id: str) -> dict | None:
    want = str(config_id or "").strip()
    if not want:
        return None
    for cfg in configs or []:
        if not isinstance(cfg, dict):
            continue
        if str(cfg.get("id") or "") == want:
            return cfg
        if str(cfg.get("name") or "").strip().lower() == want.lower():
            return cfg
    return None
