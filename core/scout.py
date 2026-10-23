"""Spelling scout: a local model suggests other ways a place name is written.

The model runs on Ollama on this machine, so names never leave it. Its only
job is to propose spellings: other romanisations of the Burmese, Burmese
script, Rakhine or Rohingya pronunciations, colonial-era names, fixes for
likely typos. Every suggestion is looked up in the gazetteer by the same
search as a typed query, and only gazetteer places come back, each saying
which spelling found it. The model never picks a place, ranks results, or
supplies coordinates, and anything it returns that is not a short name is
dropped.
"""

from __future__ import annotations

import json
import re
from typing import Any

import httpx

from core.config import settings
from core.places import SOURCE, gazetteer, plain

MAX_SUGGESTIONS = 10
HITS_PER_SPELLING = 3
TIMEOUT_S = 60

SYSTEM = (
    "You help investigators look up places in Myanmar in a gazetteer. You are given a place name as "
    "someone wrote it, possibly misspelled. List other ways the same name is commonly written: other "
    "romanisations of the Burmese, the Burmese script, Rakhine or Rohingya pronunciations, British-era "
    "names, and corrections of likely typos. Do not guess which place is meant and do not give "
    'coordinates. Reply only with JSON: {"spellings": ["...", "..."]}, at most 10 entries.'
)


class ScoutUnavailable(RuntimeError):
    pass


def suggest_spellings(name: str, client: httpx.Client | None = None) -> list[str]:
    """Other spellings of `name` from the local model, cleaned. Empty if it gave nothing usable."""
    body = {
        "model": settings.scout_model,
        "messages": [{"role": "system", "content": SYSTEM}, {"role": "user", "content": name}],
        "stream": False,
        "format": "json",
        "options": {"temperature": 0},
    }
    own = client is None
    client = client or httpx.Client(timeout=TIMEOUT_S)
    try:
        res = client.post(f"{settings.ollama_url}/api/chat", json=body)
    except httpx.HTTPError as exc:
        raise ScoutUnavailable(
            f"The spelling scout needs Ollama running on this machine (ollama serve) with {settings.scout_model} pulled."
        ) from exc
    finally:
        if own:
            client.close()
    if res.status_code == 404:
        raise ScoutUnavailable(f"Ollama has no model {settings.scout_model}. Run: ollama pull {settings.scout_model}")
    res.raise_for_status()
    try:
        raw = json.loads(res.json()["message"]["content"]).get("spellings", [])
    except (ValueError, KeyError, TypeError, AttributeError):
        return []
    return clean(name, raw)


def clean(name: str, raw: Any) -> list[str]:
    """Keep short name-like strings that differ from the query; drop numbers, coordinates and repeats."""
    if not isinstance(raw, list):
        return []
    seen = {plain(name)}
    out: list[str] = []
    for item in raw:
        if not isinstance(item, str):
            continue
        s = " ".join(item.split())
        key = plain(s)
        if not (2 <= len(s) <= 60) or re.search(r"\d", s) or key in seen or not key:
            continue
        seen.add(key)
        out.append(s)
        if len(out) == MAX_SUGGESTIONS:
            break
    return out


def scouted_search(query: str, limit: int = 8, client: httpx.Client | None = None) -> dict[str, Any]:
    """The plain search plus places found under the model's suggested spellings, each marked with found_via."""
    gaz = gazetteer()
    spellings = suggest_spellings(query, client)
    found: dict[int, tuple[float, int, dict[str, Any]]] = {}
    # Order of preference on equal similarity: the typed query, then suggestions in the model's order.
    for order, (spelling, via) in enumerate([(query, None)] + [(s, s) for s in spellings]):
        k = limit if via is None else HITS_PER_SPELLING
        for score, hit in gaz.scored(spelling, k):
            gid = hit["geonames_id"]
            if gid not in found or score > found[gid][0]:
                found[gid] = (score, order, {**hit, "found_via": via})
    ranked = sorted(found.values(), key=lambda t: (-round(t[0] / 3), t[1]))
    return {
        "source": SOURCE,
        "results": [hit for _, _, hit in ranked[:limit]],
        "tried": spellings,
        "model": settings.scout_model,
    }
