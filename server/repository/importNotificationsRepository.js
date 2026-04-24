function mapRow(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    applicationId: row.application_id,
    changeType: row.change_type,
    sourceLabel: row.source_label,
    protectionStatus: row.protection_status,
    municipality: row.municipality,
    address: row.address,
    createdAt: row.created_at
  };
}

export function createImportNotificationsRepository(db) {
  return {
    listRecent(limit = 6) {
      return db
        .prepare(`
          SELECT
            id,
            application_id,
            change_type,
            source_label,
            protection_status,
            municipality,
            address,
            created_at
          FROM import_notifications
          ORDER BY datetime(created_at) DESC
          LIMIT ?
        `)
        .all(limit)
        .map(mapRow);
    },

    createMany(items) {
      if (!Array.isArray(items) || items.length === 0) {
        return 0;
      }

      const insertStatement = db.prepare(`
        INSERT INTO import_notifications (
          id,
          application_id,
          change_type,
          source_label,
          protection_status,
          municipality,
          address,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);

      db.exec("BEGIN");

      try {
        for (const item of items) {
          insertStatement.run(
            item.id,
            item.applicationId,
            item.changeType,
            item.sourceLabel ?? "",
            item.protectionStatus,
            item.municipality,
            item.address,
            item.createdAt
          );
        }

        db.prepare(`
          DELETE FROM import_notifications
          WHERE id NOT IN (
            SELECT id
            FROM import_notifications
            ORDER BY datetime(created_at) DESC
            LIMIT 40
          )
        `).run();

        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }

      return items.length;
    }
  };
}
