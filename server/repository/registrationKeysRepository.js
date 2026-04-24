function mapRegistrationKey(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    keyCode: row.key_code,
    note: row.note,
    createdByUserId: row.created_by_user_id,
    createdByDisplayName: row.created_by_display_name,
    usedByUserId: row.used_by_user_id,
    usedByDisplayName: row.used_by_display_name,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    usedAt: row.used_at,
    revokedAt: row.revoked_at,
    isAvailable: !row.used_at && !row.revoked_at
  };
}

export function createRegistrationKeysRepository(db) {
  return {
    create({ id, keyCode, note, createdByUserId, createdAt, expiresAt }) {
      db.prepare(`
        INSERT INTO registration_keys (
          id,
          key_code,
          note,
          created_by_user_id,
          created_at,
          expires_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(id, keyCode, note ?? "", createdByUserId, createdAt, expiresAt);

      return this.getById(id);
    },

    getById(id) {
      const row = db
        .prepare(`
          SELECT
            registration_keys.id,
            registration_keys.key_code,
            registration_keys.note,
            registration_keys.created_by_user_id,
            creator.display_name AS created_by_display_name,
            registration_keys.used_by_user_id,
            used_by.display_name AS used_by_display_name,
            registration_keys.created_at,
            registration_keys.expires_at,
            registration_keys.used_at,
            registration_keys.revoked_at
          FROM registration_keys
          LEFT JOIN users AS creator ON creator.id = registration_keys.created_by_user_id
          LEFT JOIN users AS used_by ON used_by.id = registration_keys.used_by_user_id
          WHERE registration_keys.id = ?
        `)
        .get(id);

      return mapRegistrationKey(row);
    },

    getActiveByCode(keyCode, now) {
      const row = db
        .prepare(`
          SELECT
            registration_keys.id,
            registration_keys.key_code,
            registration_keys.note,
            registration_keys.created_by_user_id,
            creator.display_name AS created_by_display_name,
            registration_keys.used_by_user_id,
            used_by.display_name AS used_by_display_name,
            registration_keys.created_at,
            registration_keys.expires_at,
            registration_keys.used_at,
            registration_keys.revoked_at
          FROM registration_keys
          LEFT JOIN users AS creator ON creator.id = registration_keys.created_by_user_id
          LEFT JOIN users AS used_by ON used_by.id = registration_keys.used_by_user_id
          WHERE registration_keys.key_code = ?
            AND registration_keys.used_at IS NULL
            AND registration_keys.revoked_at IS NULL
            AND registration_keys.expires_at > ?
        `)
        .get(String(keyCode ?? "").trim().toUpperCase(), now);

      return mapRegistrationKey(row);
    },

    listRecent(limit = 20) {
      return db
        .prepare(`
          SELECT
            registration_keys.id,
            registration_keys.key_code,
            registration_keys.note,
            registration_keys.created_by_user_id,
            creator.display_name AS created_by_display_name,
            registration_keys.used_by_user_id,
            used_by.display_name AS used_by_display_name,
            registration_keys.created_at,
            registration_keys.expires_at,
            registration_keys.used_at,
            registration_keys.revoked_at
          FROM registration_keys
          LEFT JOIN users AS creator ON creator.id = registration_keys.created_by_user_id
          LEFT JOIN users AS used_by ON used_by.id = registration_keys.used_by_user_id
          ORDER BY
            CASE WHEN registration_keys.used_at IS NULL AND registration_keys.revoked_at IS NULL THEN 0 ELSE 1 END ASC,
            registration_keys.created_at DESC
          LIMIT ?
        `)
        .all(limit)
        .map(mapRegistrationKey);
    },

    markUsed({ id, usedByUserId, usedAt, now }) {
      const result = db.prepare(`
        UPDATE registration_keys
        SET used_by_user_id = ?,
            used_at = ?
        WHERE id = ?
          AND used_at IS NULL
          AND revoked_at IS NULL
          AND expires_at > ?
      `).run(usedByUserId, usedAt, id, now);

      return result.changes > 0;
    },

    deleteUnusedById(id) {
      const result = db.prepare(`
        DELETE FROM registration_keys
        WHERE id = ?
          AND used_at IS NULL
      `).run(id);

      return result.changes > 0;
    }
  };
}
