"""
Dhan broker module (Phase 1).
Uses Dhan REST API directly via requests — no third-party SDK required.

Dhan API docs: https://dhanhq.co/docs/v2/
"""
import sys
import os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "libs"))

import requests  # noqa: F401

DHAN_BASE_URL = "https://api.dhan.co/v2"


def get_headers(access_token: str, client_id: str = "") -> dict:
    h = {
        "access-token": access_token,
        "Content-Type": "application/json",
    }
    if client_id:
        h["dhanClientId"] = client_id
    return h


def get_fund_limits(access_token: str, client_id: str = "") -> dict:
    resp = requests.get(
        f"{DHAN_BASE_URL}/fundlimit",
        headers=get_headers(access_token, client_id),
        timeout=10,
    )
    resp.raise_for_status()
    return resp.json()


def user_profile(access_token: str, client_id: str) -> dict:
    """Equivalent of dhan_login.user_profile(access_token) — GET /v2/profile."""
    resp = requests.get(
        f"{DHAN_BASE_URL}/profile",
        headers=get_headers(access_token, client_id),
        timeout=10,
    )
    resp.raise_for_status()
    return resp.json()

