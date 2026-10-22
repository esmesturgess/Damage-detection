from core.db import connect, init_db, new_id, utcnow
from core.seed import seed_demo
from core.verdicts import set_verdict


def test_sites_default_pending_review(tmp_path, monkeypatch):
    db = tmp_path / "t.db"
    monkeypatch.setenv("DATABASE_PATH", str(db))
    from core import config

    config.settings.database_path = db
    conn = connect(db)
    init_db(conn)
    seed_demo(conn)
    conn.commit()
    statuses = {r["status"] for r in conn.execute("SELECT status FROM sites")}
    assert statuses == {"pending_review"}
    conn.close()


def test_only_verdict_sets_confirmed(tmp_path, monkeypatch):
    db = tmp_path / "t.db"
    from core import config

    config.settings.database_path = db
    conn = connect(db)
    init_db(conn)
    seed_demo(conn)
    conn.commit()
    site_id = conn.execute("SELECT id FROM sites LIMIT 1").fetchone()["id"]
    conn.close()

    result = set_verdict(site_id, "confirm", "analyst@example.org")
    assert result["status"] == "confirmed"

    conn = connect(db)
    status = conn.execute("SELECT status FROM sites WHERE id = ?", (site_id,)).fetchone()[0]
    snap = conn.execute("SELECT model_snapshot_json FROM verdicts WHERE site_id = ?", (site_id,)).fetchone()[0]
    assert status == "confirmed"
    assert "burn_probability" in snap
    conn.close()
