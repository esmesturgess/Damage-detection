import pytest

from core import config
from core.db import connect, init_db
from core.discussion import DiscussionError, add_comment, list_comments
from core.evidence import add_evidence, verification_for
from core.geo import box_around
from core.history import site_history
from core.investigations import start_investigation

EVENT = {"start": "2017-08-25", "end": "2017-09-15"}


@pytest.fixture
def site_id(tmp_path):
    config.settings.database_path = tmp_path / "t.db"
    conn = connect()
    init_db(conn)
    conn.close()
    return start_investigation(
        box_around(92.38, 20.82, 5), {"start": "2016-08-01", "end": "2017-07-31"}, EVENT, "Ka Nyin Tan", question="Was it burned?"
    )["site_id"]


def test_thread_and_evidence_comments_come_back_in_order(site_id):
    eid = add_evidence(site_id, "link", "amira", url="https://example.org/video")["evidence_id"]
    add_comment(site_id, "esme", "Anyone have imagery from early September?")
    add_comment(site_id, "jon", "The smoke direction matches the wind that day.", evidence_id=eid)

    comments = list_comments(site_id)
    assert [c["author"] for c in comments] == ["esme", "jon"]
    assert comments[0]["evidence_id"] is None and comments[1]["evidence_id"] == eid


def test_comments_never_change_the_level(site_id):
    for i in range(20):
        add_comment(site_id, f"user-{i}", "Confirmed, definitely burned.")
    assert verification_for(site_id)["level"] == "detected"


def test_comment_needs_a_handle_text_and_evidence_from_this_site(site_id, tmp_path):
    with pytest.raises(DiscussionError):
        add_comment(site_id, " ", "hello")
    with pytest.raises(DiscussionError):
        add_comment(site_id, "esme", "   ")
    other = start_investigation(box_around(93.0, 20.0, 5), {"start": "2016-08-01", "end": "2017-07-31"}, EVENT, "Elsewhere")
    foreign = add_evidence(other["site_id"], "link", "amira", url="https://example.org/x")["evidence_id"]
    with pytest.raises(DiscussionError):
        add_comment(site_id, "esme", "hello", evidence_id=foreign)


def test_comments_appear_in_history(site_id):
    add_comment(site_id, "esme", "Starting on the eastern edge.")
    assert "esme commented" in [e["summary"] for e in site_history(site_id)]
