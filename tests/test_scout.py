"""Spelling scout: the model proposes spellings; only the gazetteer supplies places."""

import json

import httpx
import pytest

from core import places, scout
from core.scout import ScoutUnavailable, clean, scouted_search, suggest_spellings
from tests.test_places import gaz  # noqa: F401  (fixture)


def fake_ollama(reply, status=200, seen=None):
    def handler(request: httpx.Request) -> httpx.Response:
        if seen is not None:
            seen.append(json.loads(request.content))
        if status != 200:
            return httpx.Response(status, json={"error": "nope"})
        content = reply if isinstance(reply, str) else json.dumps(reply)
        return httpx.Response(200, json={"message": {"role": "assistant", "content": content}})

    return httpx.Client(transport=httpx.MockTransport(handler))


@pytest.fixture
def loaded(gaz, monkeypatch):  # noqa: F811
    monkeypatch.setattr(places, "_loaded", gaz)
    monkeypatch.setattr(scout, "gazetteer", lambda: gaz)
    return gaz


def test_request_is_local_deterministic_json(loaded):
    seen = []
    suggest_spellings("Akyap", fake_ollama({"spellings": []}, seen=seen))
    body = seen[0]
    assert body["format"] == "json" and body["options"]["temperature"] == 0 and body["stream"] is False
    assert body["messages"][-1]["content"] == "Akyap"


def test_suggestions_are_looked_up_and_marked(loaded):
    out = scouted_search("Akyap", client=fake_ollama({"spellings": ["Akyab", "Sittway"]}))
    sittwe = next(r for r in out["results"] if r["name"] == "Sittwe")
    assert sittwe["found_via"] in {"Akyab", "Sittway"}
    assert out["tried"] == ["Akyab", "Sittway"]


def test_direct_hits_keep_no_found_via(loaded):
    out = scouted_search("Maungdaw", client=fake_ollama({"spellings": ["Mong Taw"]}))
    assert out["results"][0]["name"] == "Maungdaw" and out["results"][0]["found_via"] is None


def test_model_cannot_add_places_or_coordinates(loaded):
    reply = {"spellings": ["Atlantis", "20.82, 92.36", 42, {"lat": 1}, "Sittwe 2"], "place": "Maungdaw"}
    out = scouted_search("Qqqq", client=fake_ollama(reply))
    assert out["tried"] == ["Atlantis"]
    assert all(r["name"] in {"Maungdaw", "Sittwe", "Kyauktaw", "Buthidaung Town", "Maw", "Minbya"} for r in out["results"])


def test_garbage_reply_means_no_suggestions(loaded):
    assert suggest_spellings("Akyap", fake_ollama("not json at all")) == []
    assert suggest_spellings("Akyap", fake_ollama({"spellings": "Akyab"})) == []


def test_clean_drops_repeats_and_the_query():
    assert clean("Akyab", ["akyab", "Sittwe", "SITTWE", "  Sit  twe ", "x" * 61, "Akyab"]) == ["Sittwe"]


def test_missing_ollama_or_model_says_what_to_do(loaded):
    def down(request):
        raise httpx.ConnectError("refused")

    with pytest.raises(ScoutUnavailable, match="ollama serve"):
        suggest_spellings("Akyap", httpx.Client(transport=httpx.MockTransport(down)))
    with pytest.raises(ScoutUnavailable, match="ollama pull"):
        suggest_spellings("Akyap", fake_ollama({}, status=404))
