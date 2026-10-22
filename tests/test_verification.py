import pytest

from core import config
from core.db import connect, init_db
from core.evidence import (
    EvidenceError,
    add_evidence,
    assess,
    check_evidence,
    list_evidence,
    verification_for,
)
from core.seed import seed_demo
from core.verdicts import set_verdict


@pytest.fixture
def site_id(tmp_path):
    config.settings.database_path = tmp_path / "t.db"
    conn = connect()
    init_db(conn)
    seed_demo(conn)
    conn.commit()
    sid = conn.execute("SELECT id FROM sites WHERE name LIKE 'Demo E%'").fetchone()["id"]
    conn.close()
    return sid


def _corroborate(site_id, url, reviewer="rev-1", shares=None):
    eid = add_evidence(site_id, "link", "someone", url=url)["evidence_id"]
    check_evidence(eid, reviewer, "yes", "yes", "original", shares)
    return eid


def test_votes_never_move_the_level(site_id):
    for i in range(50):
        assess(site_id, f"user-{i}", "agree")
    v = verification_for(site_id)
    assert v["level"] == "detected"
    assert v["agreement"]["agree"] == 50


def test_unchecked_evidence_stays_detected(site_id):
    add_evidence(site_id, "link", "someone", url="https://example.org/a")
    assert verification_for(site_id)["level"] == "detected"


def test_one_located_and_dated_item_corroborates(site_id):
    _corroborate(site_id, "https://example.org/a")
    assert verification_for(site_id)["level"] == "corroborated"


def test_reposts_of_one_source_count_once(site_id):
    first = _corroborate(site_id, "https://example.org/original")
    _corroborate(site_id, "https://example.org/repost", shares=[first])
    set_verdict(site_id, "confirm", "rev-2")
    v = verification_for(site_id)
    assert v["independent_sources"] == 1
    assert v["level"] == "corroborated"


def test_verified_needs_two_sources_and_an_independent_reviewer(site_id):
    _corroborate(site_id, "https://example.org/a")
    _corroborate(site_id, "https://example.org/b")
    assert verification_for(site_id)["level"] == "corroborated"

    set_verdict(site_id, "confirm", "rev-1")  # checked the items: can't also sign off
    assert verification_for(site_id)["level"] == "corroborated"

    set_verdict(site_id, "confirm", "rev-2")
    assert verification_for(site_id)["level"] == "verified"


def test_confirm_without_evidence_does_nothing(site_id):
    set_verdict(site_id, "confirm", "rev-2")
    assert verification_for(site_id)["level"] == "detected"


def test_explained_and_disputed_come_from_reviewers(site_id):
    set_verdict(site_id, "explained", "rev-2", "crop burning")
    assert verification_for(site_id)["level"] == "explained"
    set_verdict(site_id, "disputed", "rev-3")
    assert verification_for(site_id)["level"] == "disputed"


def test_reviewer_cannot_check_own_submission(site_id):
    eid = add_evidence(site_id, "link", "rev-1", url="https://example.org/a")["evidence_id"]
    with pytest.raises(EvidenceError):
        check_evidence(eid, "rev-1", "yes", "yes", "original")


def test_public_view_hides_submitter_and_reviewer_only_content(site_id):
    add_evidence(site_id, "testimony", "witness-handle", body="I saw it.", visibility="reviewers")
    public = list_evidence(site_id)
    assert public[0]["body"] is None
    assert "witness-handle" not in repr(public)
    reviewer = list_evidence(site_id, reviewer_view=True)
    assert reviewer[0]["body"] == "I saw it."
    assert "witness-handle" not in repr(reviewer)
