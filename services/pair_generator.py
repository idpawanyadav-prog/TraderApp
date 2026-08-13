"""
Sector file loading and unique pair generation.
"""
import csv
import itertools
import logging
import os
from collections import OrderedDict
from typing import Dict, List, Tuple

logger = logging.getLogger(__name__)

__all__ = ["load_sector_map", "generate_pairs"]


def load_sector_map(csv_path):
    # type: (str) -> Dict[str, List[str]]
    """Load {sector: [instruments...]} from the sector CSV.

    Handles comma- or tab-delimited files, skips blank/malformed rows,
    de-duplicates instruments within a sector (preserving order).
    """
    sectors = OrderedDict()  # type: Dict[str, List[str]]
    if not os.path.exists(csv_path):
        logger.warning("Sector file not found: %s", csv_path)
        return sectors
    with open(csv_path, "r", encoding="utf-8-sig") as f:
        sample = f.read(4096)
        f.seek(0)
        try:
            dialect = csv.Sniffer().sniff(sample, delimiters=",\t;")
        except csv.Error:
            dialect = csv.excel
        reader = csv.DictReader(f, dialect=dialect)
        # Normalize header names case-insensitively
        if reader.fieldnames:
            fmap = {name.strip().lower(): name for name in reader.fieldnames}
        else:
            return sectors
        inst_col = fmap.get("instrument")
        sect_col = fmap.get("sector")
        if not inst_col or not sect_col:
            logger.error("Sector file must have 'Instrument' and 'Sector' columns; got %s",
                         reader.fieldnames)
            return sectors
        for row in reader:
            inst = (row.get(inst_col) or "").strip().upper()
            sect = (row.get(sect_col) or "").strip().upper()
            if not inst or not sect:
                continue
            bucket = sectors.setdefault(sect, [])
            if inst not in bucket:
                bucket.append(inst)
    return sectors


def generate_pairs(sectors, only_sector=""):
    # type: (Dict[str, List[str]], str) -> List[Tuple[str, str, str]]
    """All unique within-sector pairs as (sector, sym1, sym2).

    itertools.combinations guarantees A-B without B-A and no A-A.
    """
    pairs = []
    for sector, instruments in sectors.items():
        if only_sector and sector != only_sector.upper():
            continue
        for a, b in itertools.combinations(instruments, 2):
            pairs.append((sector, a, b))
    return pairs
