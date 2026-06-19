function mapSession(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    userId: row.user_id,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    expiresAt: row.expires_at
  };
}

export function createSessionsRepository(db) {
  return {
    create({ id, userId, createdAt, expiresAt }) {
      db.prepare(`
        INSERT INTO user_sessions (
          id,
          user_id,
          created_at,
          last_seen_at,
          expires_at
        ) VALUES (?, ?, ?, ?, ?)
      `).run(id, userId, createdAt, createdAt, expiresAt);

      return this.getById(id);
    },

    getById(id) {
      const row = db
        .prepare(`
          SELECT id, user_id, created_at, last_seen_at, expires_at
          FROM user_sessions
          WHERE id = ?
        `)
        .get(id);

      return mapSession(row);
    },

    getActiveById(id, now) {
      const row = db
        .prepare(`
          SELECT id, user_id, created_at, last_seen_at, expires_at
          FROM user_sessions
          WHERE id = ?
            AND expires_at > ?
        `)
        .get(id, now);

      return mapSession(row);
    },

    touch(id, lastSeenAt, expiresAt) {
      db.prepare(`
        UPDATE user_sessions
        SET last_seen_at = ?,
            expires_at = ?
        WHERE id = ?
      `).run(lastSeenAt, expiresAt, id);

      return this.getById(id);
    },

    deleteById(id) {
      db.prepare("DELETE FROM user_sessions WHERE id = ?").run(id);
    },

    // Beendet alle Sitzungen eines Kontos (z. B. nach Sperren/Löschen durch Master).
    deleteByUserId(userId) {
      return db.prepare("DELETE FROM user_sessions WHERE user_id = ?").run(userId).changes;
    },

    deleteExpired(now) {
      db.prepare("DELETE FROM user_sessions WHERE expires_at <= ?").run(now);
    }
  };
}
