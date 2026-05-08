import { createHash } from "node:crypto";

// Reset-Keys werden nur als SHA-256-Hash gespeichert; der Klartext-Key geht per
// E-Mail an die Nutzerin/den Nutzer.
export function hashResetKey(key) {
  return createHash("sha256").update(String(key ?? "").trim().toUpperCase()).digest("hex");
}

function mapResetKey(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    userId: row.user_id,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    usedAt: row.used_at
  };
}

export function createPasswordResetKeysRepository(db) {
  return {
    create({ id, userId, keyHash, createdAt, expiresAt }) {
      db.prepare(`
        INSERT INTO password_reset_keys (
          id,
          user_id,
          key_hash,
          created_at,
          expires_at
        ) VALUES (?, ?, ?, ?, ?)
      `).run(id, userId, keyHash, createdAt, expiresAt);

      return mapResetKey(db.prepare("SELECT * FROM password_reset_keys WHERE id = ?").get(id));
    },

    getActiveByKey(key, now) {
      const row = db
        .prepare(`
          SELECT *
          FROM password_reset_keys
          WHERE key_hash = ?
            AND used_at IS NULL
            AND expires_at > ?
        `)
        .get(hashResetKey(key), now);

      return mapResetKey(row);
    },

    markUsed({ id, usedAt, now }) {
      const result = db.prepare(`
        UPDATE password_reset_keys
        SET used_at = ?
        WHERE id = ?
          AND used_at IS NULL
          AND expires_at > ?
      `).run(usedAt, id, now);

      return result.changes > 0;
    },

    // Offene Keys eines Kontos verwerfen (vor dem Ausstellen eines neuen Keys
    // und nach erfolgreichem Reset).
    deletePendingForUser(userId) {
      db.prepare(`
        DELETE FROM password_reset_keys
        WHERE user_id = ?
          AND used_at IS NULL
      `).run(userId);
    },

    deleteStale(now) {
      const result = db.prepare(`
        DELETE FROM password_reset_keys
        WHERE used_at IS NOT NULL
           OR expires_at <= ?
      `).run(now);

      return result.changes;
    }
  };
}
