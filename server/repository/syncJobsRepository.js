function mapRow(row) {
  if (!row) {
    return null;
  }

  return {
    name: row.name,
    status: row.status,
    sourceLabel: row.source_label,
    lastRunAt: row.last_run_at,
    lastSuccessAt: row.last_success_at,
    nextRunAt: row.next_run_at,
    lastError: row.last_error,
    lastImportedCount: row.last_imported_count,
    updatedAt: row.updated_at
  };
}

export function createSyncJobsRepository(db) {
  return {
    getByName(name) {
      const row = db
        .prepare(`
          SELECT
            name,
            status,
            source_label,
            last_run_at,
            last_success_at,
            next_run_at,
            last_error,
            last_imported_count,
            updated_at
          FROM sync_jobs
          WHERE name = ?
        `)
        .get(name);

      return mapRow(row);
    },

    ensure({ name, sourceLabel = "", nextRunAt = null, updatedAt }) {
      db.prepare(`
        INSERT OR IGNORE INTO sync_jobs (
          name,
          status,
          source_label,
          next_run_at,
          updated_at
        ) VALUES (?, 'idle', ?, ?, ?)
      `).run(name, sourceLabel, nextRunAt, updatedAt);

      return this.getByName(name);
    },

    markRunning({ name, sourceLabel = "", startedAt, nextRunAt = null }) {
      db.prepare(`
        INSERT INTO sync_jobs (
          name,
          status,
          source_label,
          last_run_at,
          next_run_at,
          updated_at
        ) VALUES (?, 'running', ?, ?, ?, ?)
        ON CONFLICT(name) DO UPDATE SET
          status = excluded.status,
          source_label = excluded.source_label,
          last_run_at = excluded.last_run_at,
          next_run_at = excluded.next_run_at,
          updated_at = excluded.updated_at
      `).run(name, sourceLabel, startedAt, nextRunAt, startedAt);

      return this.getByName(name);
    },

    markFinished({
      name,
      status,
      sourceLabel = "",
      finishedAt,
      nextRunAt = null,
      lastError = "",
      lastImportedCount = 0
    }) {
      db.prepare(`
        INSERT INTO sync_jobs (
          name,
          status,
          source_label,
          last_success_at,
          next_run_at,
          last_error,
          last_imported_count,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(name) DO UPDATE SET
          status = excluded.status,
          source_label = excluded.source_label,
          last_success_at = CASE
            WHEN excluded.status = 'success' THEN excluded.last_success_at
            ELSE sync_jobs.last_success_at
          END,
          next_run_at = excluded.next_run_at,
          last_error = excluded.last_error,
          last_imported_count = excluded.last_imported_count,
          updated_at = excluded.updated_at
      `).run(
        name,
        status,
        sourceLabel,
        finishedAt,
        nextRunAt,
        lastError,
        lastImportedCount,
        finishedAt
      );

      return this.getByName(name);
    }
  };
}
