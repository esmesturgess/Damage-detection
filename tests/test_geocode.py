"""Place search: a thin, cached pass-through to Photon."""

import httpx

from core import geocode


def fake_photon(monkeypatch, features, seen):
    def handler(request):
        seen.append(dict(request.url.params))
        return httpx.Response(200, json={"type": "FeatureCollection", "features": features})

    real = httpx.Client
    monkeypatch.setattr(geocode.httpx, "Client", lambda **kw: real(transport=httpx.MockTransport(handler), **kw))
    monkeypatch.setattr(geocode, "_cache", {})


MAUNGDAW = {
    "type": "Feature",
    "geometry": {"type": "Point", "coordinates": [92.36, 20.82]},
    "properties": {"name": "Maungdaw", "osm_value": "town", "state": "Rakhine", "country": "Myanmar", "osm_type": "N", "osm_id": 1},
}


def test_results_are_named_placed_and_biased_to_the_map(monkeypatch):
    seen = []
    fake_photon(monkeypatch, [MAUNGDAW], seen)
    out = geocode.search_places("Maungdo", lat=20.81, lon=92.38)
    assert out["results"] == [
        {"name": "Maungdaw", "kind": "town", "within": "Rakhine, Myanmar", "lat": 20.82, "lon": 92.36, "osm": "N1"}
    ]
    assert seen[0]["lat"] == "20.8" and seen[0]["lon"] == "92.4"  # rounded: the exact view isn't sent
    assert seen[0]["zoom"] == "8"
    assert "OpenStreetMap" in out["source"]


def test_repeat_searches_are_cached_and_tiny_ones_skipped(monkeypatch):
    seen = []
    fake_photon(monkeypatch, [MAUNGDAW], seen)
    geocode.search_places("Maungdaw")
    geocode.search_places("  maungdaw ")
    assert geocode.search_places("m")["results"] == []
    assert len(seen) == 1
