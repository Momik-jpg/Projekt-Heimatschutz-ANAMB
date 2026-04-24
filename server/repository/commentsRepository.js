function mapComment(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    applicationId: row.application_id,
    userId: row.user_id,
    userDisplayName: row.user_display_name,
    userRole: row.user_role,
    message: row.message,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export function createCommentsRepository(db) {
  return {
    listByApplication(applicationId) {
      return db
        .prepare(`
          SELECT
            c.id,
            c.application_id,
            c.user_id,
            c.message,
            c.created_at,
            c.updated_at,
            u.display_name AS user_display_name,
            u.role AS user_role
          FROM application_comments c
          INNER JOIN users u ON u.id = c.user_id
          WHERE c.application_id = ?
          ORDER BY datetime(c.created_at) ASC, c.id ASC
        `)
        .all(applicationId)
        .map(mapComment);
    },

    create({ id, applicationId, userId, message, createdAt }) {
      db.prepare(`
        INSERT INTO application_comments (
          id,
          application_id,
          user_id,
          message,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(id, applicationId, userId, message, createdAt, createdAt);

      const row = db
        .prepare(`
          SELECT
            c.id,
            c.application_id,
            c.user_id,
            c.message,
            c.created_at,
            c.updated_at,
            u.display_name AS user_display_name,
            u.role AS user_role
          FROM application_comments c
          INNER JOIN users u ON u.id = c.user_id
          WHERE c.id = ?
        `)
        .get(id);

      return mapComment(row);
    }
  };
}
