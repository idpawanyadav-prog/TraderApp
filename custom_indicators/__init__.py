"""Python chart indicators discovered from this folder and shown in Custom ▾."""
from __future__ import annotations

import importlib
import traceback
from pathlib import Path

_PKG = "custom_indicators"


def _iter_modules():
    pkg_dir = Path(__file__).resolve().parent
    for path in sorted(pkg_dir.glob("*.py")):
        if path.name.startswith("_"):
            continue
        name = path.stem
        try:
            mod = importlib.import_module(f"{_PKG}.{name}")
        except Exception:
            traceback.print_exc()
            continue
        meta = getattr(mod, "META", None)
        if not isinstance(meta, dict) or not callable(getattr(mod, "compute", None)):
            continue
        if not str(meta.get("id") or "").strip():
            continue
        yield mod


def catalog():
    items = []
    for mod in _iter_modules():
        meta = dict(mod.META)
        meta["id"] = str(meta["id"]).strip()
        meta["name"] = str(meta.get("name") or meta["id"])
        meta["overlay"] = bool(meta.get("overlay", True))
        meta["draw"] = str(meta.get("draw") or "line")
        meta["api"] = meta["draw"].lower() in ("line", "lines")
        params = []
        for p in meta.get("params") or []:
            if not isinstance(p, dict) or not p.get("key"):
                continue
            params.append({
                "key": str(p["key"]),
                "label": str(p.get("label") or p["key"]),
                "def": p.get("def"),
                "min": p.get("min"),
                "max": p.get("max"),
                "step": p.get("step", 1),
                "type": str(p.get("type") or "number"),
            })
        meta["params"] = params
        if "factory" in mod.META:
            meta["factory"] = mod.META["factory"]
        meta["ui"] = str(meta.get("ui") or "")
        items.append(meta)
    return items


def _module_by_id(ind_id: str):
    ind_id = str(ind_id or "").strip()
    for mod in _iter_modules():
        if str(mod.META.get("id")) == ind_id:
            return mod
    return None


def compute(ind_id: str, candles, params=None):
    mod = _module_by_id(ind_id)
    if mod is None:
        raise ValueError(f"Unknown custom indicator: {ind_id}")
    return mod.compute(candles or [], params or {})
