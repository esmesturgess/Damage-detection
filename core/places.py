"""Place search over a local GeoNames gazetteer.

Searches never leave the server: the gazetteer is downloaded once
(`python -m core.places fetch MM`) and searched in memory, so nobody
outside learns which places an investigation is looking at.

Matching tolerates imperfect spelling. Each name is indexed twice:

  plain     lower case, accents, spaces and punctuation removed
            ("Ka-Nyin Tan" -> "kanyintan")
  phonetic  plain, with Burmese romanisation variants folded together
            (ky/gy/ch, th/t, d/t, b/p, aw/o, ng/n, trailing "ar"...),
            so "Maung Taw" meets "Maungdaw" and "Chauk" meets "Kyauk"

and both are scored with rapidfuzz: whole-name similarity, or the query
found inside a longer name ("Buthidaung" in "Buthidaung Town"), slightly
discounted. A short name inside a long query does not count. Alternate names (other spellings,
Burmese script) are indexed too, and results say which name matched.
Results are places from the gazetteer, ranked by how close the spelling
is; nothing here decides which place an investigator means.
"""

from __future__ import annotations

import io
import re
import sys
import threading
import unicodedata
import zipfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import httpx
from rapidfuzz import fuzz, process

from core.config import settings

GEONAMES = "https://download.geonames.org/export/dump"
SUPPORT_FILES = ["admin1CodesASCII.txt", "admin2Codes.txt", "featureCodes_en.txt"]
SOURCE = "GeoNames (CC BY 4.0)"
MIN_SCORE = 72
PARTIAL_MIN = 88
PARTIAL_WEIGHT = 0.9
CANDIDATES = 80
# Villages, towns and admin areas first when spellings score alike.
CLASS_RANK = {"P": 2, "A": 2, "S": 1, "H": 1, "T": 1}


class GazetteerMissing(RuntimeError):
    pass


@dataclass(frozen=True)
class Place:
    id: int
    name: str
    alternates: tuple[str, ...]
    lat: float
    lon: float
    feature_class: str
    feature_code: str
    country: str
    admin1: str
    admin2: str
    population: int


def gazetteer_dir() -> Path:
    return settings.database_path.parent / "gazetteer"


def plain(name: str) -> str:
    """Lower case without Latin accents, spaces or punctuation. Burmese script keeps its vowel signs."""
    decomposed = unicodedata.normalize("NFKD", name.lower())
    return "".join(
        c
        for c in decomposed
        if not ("̀" <= c <= "ͯ") and (c.isalnum() or unicodedata.category(c) in ("Mn", "Mc"))
    )


# Applied in order. Aspirates and digraphs first, then voicing, then vowels.
_FOLDS = [
    (r"h([ptmnlsk])", r"\1"),  # hp, ht, hm, hn, hl, hs, hk
    (r"([ktpsg])h", r"\1"),  # kh, th, ph, sh, gh
    (r"ng", "n"),
    (r"ky|gy|ch|tc|j", "c"),
    (r"m(?=[pb])", "n"),  # Mimbya -> Minbya
    (r"d", "t"),
    (r"b", "p"),
    (r"g", "k"),
    (r"z", "s"),
    (r"aw(?=n)", "au"),  # awng -> aung
    (r"aw|ou|oe", "o"),
    (r"oo", "u"),
    (r"ei|ay|ey", "e"),
    (r"ee|y", "i"),
    (r"ar(?=[^aeiou]|$)", "a"),  # Thar Zi -> Tha Zi
    (r"(.)\1+", r"\1"),
]


def phonetic(name: str) -> str:
    key = plain(name)
    if not key.isascii():
        return key
    for pattern, repl in _FOLDS:
        key = re.sub(pattern, repl, key)
    return key


class Gazetteer:
    def __init__(self, places: list[Place], admin: dict[str, str], features: dict[str, str]):
        self.places = places
        self.admin = admin
        self.features = features
        # One entry per (place, spelling); the same spelling can name many places.
        self.entries: list[tuple[int, str]] = []
        plain_keys: list[str] = []
        phonetic_keys: list[str] = []
        for i, p in enumerate(places):
            seen: set[str] = set()
            for name in (p.name, *p.alternates):
                key = plain(name)
                if not key or key in seen or (len(key) < 2) or key.startswith("mmr"):
                    continue  # MIMU place codes live in alternates; they are not names
                seen.add(key)
                self.entries.append((i, name))
                plain_keys.append(key)
                phonetic_keys.append(phonetic(name))
        self.plain_keys = plain_keys
        self.phonetic_keys = phonetic_keys

    def search(self, query: str, limit: int = 8) -> list[dict[str, Any]]:
        q_plain, q_phon = plain(query), phonetic(query)
        if len(q_plain) < 2:
            return []
        best: dict[int, tuple[float, str]] = {}
        for keys, q, weight in ((self.plain_keys, q_plain, 1.0), (self.phonetic_keys, q_phon, 0.97)):
            whole = process.extract(q, keys, scorer=fuzz.ratio, limit=CANDIDATES, score_cutoff=MIN_SCORE)
            inside = process.extract(q, keys, scorer=fuzz.partial_ratio, limit=CANDIDATES, score_cutoff=PARTIAL_MIN)
            hits = [(score, idx) for key, score, idx in whole] + [
                (score * PARTIAL_WEIGHT, idx) for key, score, idx in inside if len(key) > len(q)
            ]
            for score, idx in hits:
                place_idx, name = self.entries[idx]
                score *= weight
                if score > best.get(place_idx, (0.0, ""))[0]:
                    best[place_idx] = (score, name)

        def rank(item: tuple[int, tuple[float, str]]) -> tuple:
            place_idx, (score, _) = item
            p = self.places[place_idx]
            return (-round(score / 3), -CLASS_RANK.get(p.feature_class, 0), -p.population, p.name)

        return [self._describe(self.places[i], name) for i, (_, name) in sorted(best.items(), key=rank)[:limit]]

    def _describe(self, p: Place, matched: str) -> dict[str, Any]:
        return {
            "geonames_id": p.id,
            "name": p.name,
            "matched": None if plain(matched) == plain(p.name) else matched,
            "alternates": [a for a in p.alternates if not plain(a).startswith("mmr")][:6],
            "lat": p.lat,
            "lon": p.lon,
            "kind": self.features.get(f"{p.feature_class}.{p.feature_code}", p.feature_code),
            "admin2": self.admin.get(f"{p.country}.{p.admin1}.{p.admin2}"),
            "admin1": self.admin.get(f"{p.country}.{p.admin1}"),
            "country": p.country,
        }


_lock = threading.Lock()
_loaded: Gazetteer | None = None


def search_places(query: str, limit: int = 8) -> dict[str, Any]:
    return {"source": SOURCE, "results": gazetteer().search(query, limit)}


def gazetteer() -> Gazetteer:
    global _loaded
    with _lock:
        if _loaded is None:
            _loaded = load(gazetteer_dir())
        return _loaded


def load(folder: Path) -> Gazetteer:
    countries = sorted(folder.glob("[A-Z][A-Z].txt"))
    if not countries:
        raise GazetteerMissing("No gazetteer yet. Run: python -m core.places fetch MM")
    places: list[Place] = []
    for path in countries:
        with path.open(encoding="utf-8") as f:
            for line in f:
                c = line.rstrip("\n").split("\t")
                if len(c) < 15:
                    continue
                places.append(
                    Place(
                        id=int(c[0]),
                        name=c[1],
                        alternates=tuple(a for a in c[3].split(",") if a),
                        lat=float(c[4]),
                        lon=float(c[5]),
                        feature_class=c[6],
                        feature_code=c[7],
                        country=c[8],
                        admin1=c[10],
                        admin2=c[11],
                        population=int(c[14] or 0),
                    )
                )
    admin: dict[str, str] = {}
    for name in ("admin1CodesASCII.txt", "admin2Codes.txt"):
        path = folder / name
        if path.exists():
            for line in path.open(encoding="utf-8"):
                c = line.rstrip("\n").split("\t")
                if len(c) >= 2:
                    admin[c[0]] = c[1]
    features: dict[str, str] = {}
    path = folder / "featureCodes_en.txt"
    if path.exists():
        for line in path.open(encoding="utf-8"):
            c = line.rstrip("\n").split("\t")
            if len(c) >= 2:
                features[c[0]] = c[1]
    return Gazetteer(places, admin, features)


def fetch(countries: list[str], folder: Path | None = None) -> None:
    """Download GeoNames country files (e.g. MM, VN) and the admin and feature-code tables."""
    folder = folder or gazetteer_dir()
    folder.mkdir(parents=True, exist_ok=True)
    with httpx.Client(timeout=120, follow_redirects=True) as client:
        for cc in countries:
            cc = cc.upper()
            if not re.fullmatch(r"[A-Z]{2}", cc):
                raise ValueError(f"not a country code: {cc}")
            res = client.get(f"{GEONAMES}/{cc}.zip")
            res.raise_for_status()
            with zipfile.ZipFile(io.BytesIO(res.content)) as z:
                (folder / f"{cc}.txt").write_bytes(z.read(f"{cc}.txt"))
            print(f"{cc}: saved")
        for name in SUPPORT_FILES:
            res = client.get(f"{GEONAMES}/{name}")
            res.raise_for_status()
            (folder / name).write_bytes(res.content)
    global _loaded
    with _lock:
        _loaded = None


if __name__ == "__main__":
    if len(sys.argv) >= 3 and sys.argv[1] == "fetch":
        fetch(sys.argv[2:])
    else:
        print("usage: python -m core.places fetch MM [VN ...]")
