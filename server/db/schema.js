// SQLite-Schema (aus db.js ausgelagert).
export const schema = `
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  PRAGMA secure_delete = ON;

  CREATE TABLE IF NOT EXISTS applications (
    id TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    source_reference TEXT NOT NULL,
    source_url TEXT NOT NULL,
    municipality TEXT NOT NULL,
    address TEXT NOT NULL,
    address_provenance TEXT NOT NULL DEFAULT 'legacy-unknown',
    parcel TEXT NOT NULL DEFAULT '',
    coordinates TEXT NOT NULL DEFAULT '',
    location_precision TEXT NOT NULL DEFAULT '',
    publication_date TEXT NOT NULL,
    deadline_date TEXT NOT NULL,
    deadline_provenance TEXT NOT NULL DEFAULT 'legacy-unknown',
    project_type TEXT NOT NULL,
    description TEXT NOT NULL,
    protection_status TEXT NOT NULL,
    agis_match TEXT NOT NULL,
    agis_layers TEXT NOT NULL DEFAULT '[]',
    workflow_status TEXT NOT NULL,
    archived_at TEXT NOT NULL DEFAULT '',
    reconciliation_status TEXT NOT NULL DEFAULT '',
    assignee TEXT NOT NULL DEFAULT '',
    note TEXT NOT NULL DEFAULT '',
    automated_assessment TEXT NOT NULL DEFAULT '',
    ambiguous_address INTEGER NOT NULL DEFAULT 0,
    last_sync_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS schema_migrations (
    id TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    role TEXT NOT NULL,
    email TEXT NOT NULL DEFAULT '',
    password_salt TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS user_sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS application_comments (
    id TEXT PRIMARY KEY,
    application_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    message TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (application_id) REFERENCES applications(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS application_reads (
    application_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    read_at TEXT NOT NULL,
    PRIMARY KEY (application_id, user_id),
    FOREIGN KEY (application_id) REFERENCES applications(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS registration_keys (
    id TEXT PRIMARY KEY,
    key_code TEXT NOT NULL UNIQUE,
    note TEXT NOT NULL DEFAULT '',
    created_by_user_id TEXT NOT NULL,
    used_by_user_id TEXT DEFAULT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    used_at TEXT DEFAULT NULL,
    revoked_at TEXT DEFAULT NULL,
    FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (used_by_user_id) REFERENCES users(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS master_setup_keys (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    key_hash TEXT NOT NULL,
    sent_to TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    used_at TEXT DEFAULT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS password_reset_keys (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    key_hash TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    used_at TEXT DEFAULT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS audit_log (
    id TEXT PRIMARY KEY,
    occurred_at TEXT NOT NULL,
    action TEXT NOT NULL,
    actor_user_id TEXT NOT NULL DEFAULT '',
    actor_name TEXT NOT NULL DEFAULT '',
    target TEXT NOT NULL DEFAULT '',
    detail TEXT NOT NULL DEFAULT '',
    ip TEXT NOT NULL DEFAULT ''
  );

  CREATE INDEX IF NOT EXISTS idx_audit_log_occurred_at ON audit_log (occurred_at DESC);

  CREATE TABLE IF NOT EXISTS sync_jobs (
    name TEXT PRIMARY KEY,
    status TEXT NOT NULL DEFAULT 'idle',
    source_label TEXT NOT NULL DEFAULT '',
    last_run_at TEXT DEFAULT NULL,
    last_success_at TEXT DEFAULT NULL,
    next_run_at TEXT DEFAULT NULL,
    last_error TEXT NOT NULL DEFAULT '',
    last_imported_count INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS import_notifications (
    id TEXT PRIMARY KEY,
    application_id TEXT NOT NULL,
    change_type TEXT NOT NULL,
    source_label TEXT NOT NULL DEFAULT '',
    protection_status TEXT NOT NULL,
    municipality TEXT NOT NULL,
    address TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (application_id) REFERENCES applications(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS application_source_evidence (
    id TEXT PRIMARY KEY,
    application_id TEXT NOT NULL,
    source_kind TEXT NOT NULL,
    source_name TEXT NOT NULL DEFAULT '',
    source_reference TEXT NOT NULL,
    source_url TEXT NOT NULL DEFAULT '',
    municipality TEXT NOT NULL DEFAULT '',
    publication_date TEXT NOT NULL DEFAULT '',
    deadline_date TEXT NOT NULL DEFAULT '',
    address TEXT NOT NULL DEFAULT '',
    parcel TEXT NOT NULL DEFAULT '',
    project_type TEXT NOT NULL DEFAULT '',
    match_status TEXT NOT NULL DEFAULT 'matched',
    observed_at TEXT NOT NULL,
    UNIQUE (source_kind, source_reference),
    FOREIGN KEY (application_id) REFERENCES applications(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS application_learning_rules (
    id TEXT PRIMARY KEY,
    municipality_key TEXT NOT NULL,
    municipality TEXT NOT NULL,
    address_signature TEXT NOT NULL DEFAULT '',
    project_signature TEXT NOT NULL DEFAULT '',
    protection_status TEXT NOT NULL,
    agis_match TEXT NOT NULL DEFAULT '',
    agis_layers TEXT NOT NULL DEFAULT '[]',
    automated_assessment TEXT NOT NULL DEFAULT '',
    confidence REAL NOT NULL DEFAULT 0.82,
    match_count INTEGER NOT NULL DEFAULT 1,
    created_from_application_id TEXT NOT NULL DEFAULT '',
    created_by_user_id TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (municipality_key, address_signature, project_signature)
  );

  CREATE TABLE IF NOT EXISTS municipality_sources (
    id TEXT PRIMARY KEY,
    municipality TEXT NOT NULL UNIQUE,
    source_type TEXT NOT NULL DEFAULT 'manual',
    source_url TEXT NOT NULL DEFAULT '',
    source_token TEXT NOT NULL DEFAULT '',
    include_pattern TEXT NOT NULL DEFAULT '',
    exclude_pattern TEXT NOT NULL DEFAULT '',
    enabled INTEGER NOT NULL DEFAULT 0,
    digital_status TEXT NOT NULL DEFAULT 'unknown',
    notes TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS municipalities (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    official_website TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS publication_sources (
    id TEXT PRIMARY KEY,
    source_key TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    source_kind TEXT NOT NULL,
    operator_name TEXT NOT NULL DEFAULT '',
    website_url TEXT NOT NULL DEFAULT '',
    canonical_url TEXT NOT NULL DEFAULT '',
    is_shared INTEGER NOT NULL DEFAULT 0,
    notes TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS municipality_source_links (
    id TEXT PRIMARY KEY,
    municipality_id TEXT NOT NULL,
    source_id TEXT NOT NULL,
    relation_type TEXT NOT NULL DEFAULT 'primary',
    direct_url TEXT NOT NULL DEFAULT '',
    source_type TEXT NOT NULL DEFAULT 'manual',
    enabled INTEGER NOT NULL DEFAULT 0,
    digital_status TEXT NOT NULL DEFAULT 'unknown',
    include_pattern TEXT NOT NULL DEFAULT '',
    exclude_pattern TEXT NOT NULL DEFAULT '',
    source_token TEXT NOT NULL DEFAULT '',
    shared_hint TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL,
    UNIQUE (municipality_id, source_id, relation_type),
    FOREIGN KEY (municipality_id) REFERENCES municipalities(id) ON DELETE CASCADE,
    FOREIGN KEY (source_id) REFERENCES publication_sources(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS municipality_quality_assessments (
    municipality_id TEXT PRIMARY KEY,
    primary_source_id TEXT NOT NULL,
    rating TEXT NOT NULL,
    rationale TEXT NOT NULL,
    shared_source_note TEXT NOT NULL DEFAULT '',
    uncertain INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (municipality_id) REFERENCES municipalities(id) ON DELETE CASCADE,
    FOREIGN KEY (primary_source_id) REFERENCES publication_sources(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_user_sessions_user_id ON user_sessions(user_id);
  CREATE INDEX IF NOT EXISTS idx_user_sessions_expires_at ON user_sessions(expires_at);
  CREATE INDEX IF NOT EXISTS idx_application_comments_application_id ON application_comments(application_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_application_reads_user_id ON application_reads(user_id, read_at);
  CREATE INDEX IF NOT EXISTS idx_applications_municipality ON applications(municipality);
  CREATE INDEX IF NOT EXISTS idx_applications_protection_status ON applications(protection_status);
  CREATE INDEX IF NOT EXISTS idx_applications_workflow_deadline ON applications(workflow_status, deadline_date);
  CREATE INDEX IF NOT EXISTS idx_applications_source_municipality ON applications(source, municipality);
  CREATE INDEX IF NOT EXISTS idx_applications_source_reference ON applications(source_reference);
  CREATE INDEX IF NOT EXISTS idx_applications_last_sync_at ON applications(last_sync_at DESC);
  CREATE INDEX IF NOT EXISTS idx_registration_keys_created_at ON registration_keys(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_registration_keys_key_code ON registration_keys(key_code);
  CREATE INDEX IF NOT EXISTS idx_sync_jobs_next_run_at ON sync_jobs(next_run_at);
  CREATE INDEX IF NOT EXISTS idx_app_settings_updated_at ON app_settings(updated_at);
  CREATE INDEX IF NOT EXISTS idx_import_notifications_created_at ON import_notifications(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_application_source_evidence_application ON application_source_evidence(application_id);
  CREATE INDEX IF NOT EXISTS idx_application_learning_rules_municipality ON application_learning_rules(municipality_key, confidence DESC);
  CREATE INDEX IF NOT EXISTS idx_application_learning_rules_updated ON application_learning_rules(updated_at DESC);
  CREATE INDEX IF NOT EXISTS idx_municipality_sources_enabled ON municipality_sources(enabled, municipality);
  CREATE INDEX IF NOT EXISTS idx_publication_sources_shared ON publication_sources(is_shared, name);
  CREATE INDEX IF NOT EXISTS idx_municipality_source_links_municipality ON municipality_source_links(municipality_id, relation_type);
  CREATE INDEX IF NOT EXISTS idx_municipality_source_links_source ON municipality_source_links(source_id, relation_type);
  CREATE INDEX IF NOT EXISTS idx_municipality_quality_assessments_rating ON municipality_quality_assessments(rating);
`;
