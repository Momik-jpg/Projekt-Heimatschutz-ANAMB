export function createApplicationReadsRepository(db) {
  const listIdsStatement = db.prepare(`
    SELECT application_id
    FROM application_reads
    WHERE user_id = ?
  `);
  const findStatement = db.prepare(`
    SELECT read_at
    FROM application_reads
    WHERE application_id = ? AND user_id = ?
  `);
  const markStatement = db.prepare(`
    INSERT INTO application_reads (application_id, user_id, read_at)
    VALUES (?, ?, ?)
    ON CONFLICT(application_id, user_id) DO UPDATE SET read_at = excluded.read_at
  `);

  return {
    listApplicationIds(userId) {
      return new Set(listIdsStatement.all(userId).map((row) => row.application_id));
    },

    get(applicationId, userId) {
      const row = findStatement.get(applicationId, userId);
      return row ? { isRead: true, readAt: row.read_at } : { isRead: false, readAt: null };
    },

    markRead(applicationId, userId, readAt) {
      markStatement.run(applicationId, userId, readAt);
      return { isRead: true, readAt };
    }
  };
}

