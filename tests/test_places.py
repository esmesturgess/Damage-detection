"""Place search: spelling-tolerant, local, and honest about what matched."""

import pytest

from core import places
from core.places import GazetteerMissing, load, phonetic, plain

# GeoNames columns: id, name, ascii, alternates, lat, lon, class, code, country, cc2, admin1, admin2, a3, a4, population
ROWS = [
    (1, "Maungdaw", "Maungdaw", "Maungdaw,မောင်တော", 20.82, 92.36, "P", "PPL", "MM", "", "01", "MMR012D002", "", "", 0),
    (2, "Maungdaw", "Maungdaw", "", 22.10, 93.50, "P", "PPL", "MM", "", "02", "", "", "", 0),
    (3, "Sittwe", "Sittwe", "Akyab,Sittway,MMR012001", 20.15, 92.90, "P", "PPLA", "MM", "", "01", "", "", "", 177743),
    (4, "Kyauktaw", "Kyauktaw", "", 20.84, 92.98, "P", "PPL", "MM", "", "01", "", "", "", 0),
    (5, "Buthidaung Town", "Buthidaung Town", "Buthidaung,Buthedaung", 20.87, 92.53, "P", "PPL", "MM", "", "01", "", "", "", 0),
    (6, "Maw", "Maw", "", 21.00, 95.00, "P", "PPL", "MM", "", "02", "", "", "", 0),
    (7, "Minbya", "Minbya", "", 20.36, 93.27, "P", "PPL", "MM", "", "01", "", "", "", 0),
]


@pytest.fixture
def gaz(tmp_path):
    lines = ["\t".join(str(v) for v in row) for row in ROWS]
    (tmp_path / "MM.txt").write_text("\n".join(lines) + "\n", encoding="utf-8")
    (tmp_path / "admin1CodesASCII.txt").write_text("MM.01\tRakhine\tRakhine\t1\nMM.02\tChin\tChin\t2\n")
    (tmp_path / "admin2Codes.txt").write_text("MM.01.MMR012D002\tMaungdaw District\tMaungdaw District\t3\n")
    (tmp_path / "featureCodes_en.txt").write_text("P.PPL\tpopulated place\t\nP.PPLA\tseat of a first-order administrative division\t\n")
    return load(tmp_path)


def names(results):
    return [r["name"] for r in results]


def test_keys_fold_spelling_and_romanisation():
    assert plain("Ka-Nyin Tan") == "kanyintan"
    assert plain("Hpākān") == "hpakan"
    assert phonetic("Maung Taw") == phonetic("Maungdaw")
    assert phonetic("Chauktaw") == phonetic("Kyauktaw")
    assert phonetic("Mimbya") == phonetic("Minbya")
    assert phonetic("Sitway") == phonetic("Sittwe")


@pytest.mark.parametrize(
    "query, first",
    [
        ("Maungdo", "Maungdaw"),
        ("maung taw", "Maungdaw"),
        ("mawngdaw", "Maungdaw"),
        ("Chauktaw", "Kyauktaw"),
        ("Butheedaung", "Buthidaung Town"),
        ("Sitway", "Sittwe"),
        ("Mimbya", "Minbya"),
    ],
)
def test_misspellings_find_the_place(gaz, query, first):
    assert names(gaz.search(query))[0] == first


def test_alternate_and_old_names_say_what_matched(gaz):
    hit = gaz.search("Akyab")[0]
    assert hit["name"] == "Sittwe" and hit["matched"] == "Akyab"
    assert gaz.search("Sittwe")[0]["matched"] is None


def test_burmese_script(gaz):
    assert names(gaz.search("မောင်တော"))[0] == "Maungdaw"


def test_same_name_places_all_returned_with_their_areas(gaz):
    hits = [h for h in gaz.search("Maungdaw") if h["name"] == "Maungdaw"]
    assert {h["admin1"] for h in hits} == {"Rakhine", "Chin"}
    assert any(h["admin2"] == "Maungdaw District" for h in hits)


def test_short_name_inside_long_query_does_not_match(gaz):
    assert "Maw" not in names(gaz.search("Thar Zi Maw"))


def test_place_codes_are_not_names(gaz):
    assert gaz.search("MMR012001") == []
    assert all(not a.startswith("MMR") for a in gaz.search("Sittwe")[0]["alternates"])


def test_tiny_query_returns_nothing(gaz):
    assert gaz.search("m") == []


def test_missing_gazetteer_says_how_to_get_it(tmp_path, monkeypatch):
    monkeypatch.setattr(places, "gazetteer_dir", lambda: tmp_path)
    monkeypatch.setattr(places, "_loaded", None)
    with pytest.raises(GazetteerMissing, match="core.places fetch"):
        places.search_places("Maungdaw")
