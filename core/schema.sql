CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    status TEXT NOT NULL,
    params_json TEXT NOT NULL,
    result_json TEXT,
    error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sites (
    id TEXT PRIMARY KEY,
    job_id TEXT,
    name TEXT,
    geometry_geojson TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending_review',
    calibration_status TEXT NOT NULL DEFAULT 'provisional',
    optical_read TEXT NOT NULL DEFAULT 'unknown',
    pwtt_z REAL,
    burn_probability REAL,
    burn_threshold REAL NOT NULL DEFAULT 0.91,
    features_json TEXT,
    seismic_json TEXT,
    scene_ids_json TEXT,
    timestamps_json TEXT,
    region TEXT,
    is_demo INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    FOREIGN KEY (job_id) REFERENCES jobs(id)
);

CREATE TABLE IF NOT EXISTS verdicts (
    id TEXT PRIMARY KEY,
    site_id TEXT NOT NULL,
    verdict TEXT NOT NULL,
    analyst TEXT NOT NULL,
    model_snapshot_json TEXT NOT NULL,
    note TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (site_id) REFERENCES sites(id)
);

CREATE TABLE IF NOT EXISTS audit_log (
    id TEXT PRIMARY KEY,
    actor TEXT NOT NULL,
    action TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id TEXT,
    payload_json TEXT,
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sites_status ON sites(status);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log(entity_type, entity_id);

-- v4 evidence layer. Verification level is computed from these rows and
-- verdicts (core/evidence.py), never stored, so it can't be set directly.
CREATE TABLE IF NOT EXISTS evidence (
    id TEXT PRIMARY KEY,
    site_id TEXT NOT NULL,
    kind TEXT NOT NULL,                       -- link | testimony
    url TEXT,
    body TEXT,
    visibility TEXT NOT NULL DEFAULT 'public', -- public | reviewers
    submitted_by TEXT NOT NULL,               -- pseudonymous handle; never returned publicly
    is_demo INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    FOREIGN KEY (site_id) REFERENCES sites(id)
);

CREATE TABLE IF NOT EXISTS evidence_checks (
    id TEXT PRIMARY KEY,
    evidence_id TEXT NOT NULL,
    reviewer TEXT NOT NULL,
    located TEXT NOT NULL,                    -- yes | no | unsure
    dated TEXT NOT NULL,                      -- yes | no | unsure
    original TEXT NOT NULL,                   -- original | repost | unsure
    shares_source_with_json TEXT,             -- evidence ids from the same underlying source
    note TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (evidence_id) REFERENCES evidence(id)
);

CREATE TABLE IF NOT EXISTS assessments (
    site_id TEXT NOT NULL,
    user TEXT NOT NULL,
    stance TEXT NOT NULL,                     -- agree | disagree | unsure
    reason TEXT,
    created_at TEXT NOT NULL,
    PRIMARY KEY (site_id, user),
    FOREIGN KEY (site_id) REFERENCES sites(id)
);

CREATE INDEX IF NOT EXISTS idx_evidence_site ON evidence(site_id);
CREATE INDEX IF NOT EXISTS idx_checks_evidence ON evidence_checks(evidence_id);

-- Every prior-report search, kept as a record of what was looked for and
-- found (including nothing). reports_json is ACLED's data as returned.
CREATE TABLE IF NOT EXISTS prior_report_searches (
    id TEXT PRIMARY KEY,
    site_id TEXT,                             -- null for a search by area only
    source TEXT NOT NULL,                     -- acled
    params_json TEXT NOT NULL,
    result_count INTEGER NOT NULL,
    truncated INTEGER NOT NULL DEFAULT 0,
    reports_json TEXT,
    searched_by TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_prior_searches_site ON prior_report_searches(site_id, created_at);

-- Every NASA FIRMS fire-detection search, kept like prior-report searches.
CREATE TABLE IF NOT EXISTS fire_searches (
    id TEXT PRIMARY KEY,
    site_id TEXT,
    params_json TEXT NOT NULL,
    result_count INTEGER NOT NULL,
    truncated INTEGER NOT NULL DEFAULT 0,
    detections_json TEXT,
    searched_by TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_fire_searches_site ON fire_searches(site_id, created_at);

-- Discussion. evidence_id null = the site's open thread. Append-only.
CREATE TABLE IF NOT EXISTS comments (
    id TEXT PRIMARY KEY,
    site_id TEXT NOT NULL,
    evidence_id TEXT,
    author TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (site_id) REFERENCES sites(id),
    FOREIGN KEY (evidence_id) REFERENCES evidence(id)
);

CREATE INDEX IF NOT EXISTS idx_comments_site ON comments(site_id, created_at);
