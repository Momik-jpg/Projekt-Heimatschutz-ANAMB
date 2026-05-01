import { createHash } from "node:crypto";

// Setup-Keys werden nur als SHA-256-Hash gespeichert, damit der Klartext-Key
// (der per E-Mail zugestellt wird) nicht in der Datenbank liegt.
export function hashSetupKey(key) {
  return createHash("sha256").update(String(key ?? "").trim().toUpperCase()).digest("hex");
}

function mapSetupKey(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    userId: row.user_id,
    sentTo: row.sent_to,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    usedAt: row.used_at
  };
}

export function createMasterSetupKeysRepository(db) {
  return {
    create({ id, userId, keyHash, sentTo, createdAt, expiresAt }) {
      db.prepare(`
        INSERT INTO master_setup_keys (
          id,
          user_id,
          key_hash,
          sent_to,
          created_at,
          expires_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(id, userId, keyHash, sentTo ?? "", createdAt, expiresAt);

      return this.getById(id);
    },

    getById(id) {
      return mapSetupKey(
        db.prepare("SELECT * FROM master_setup_keys WHERE id = ?").get(id)
      );
    },

    // Aktiver (nicht verbrauchter, nicht abgelaufener) Key zu einem Klartext-Key.
    getActiveByKey(key, now) {
      const row = db
        .prepare(`
          SELECT *
          FROM master_setup_keys
          WHERE key_hash = ?
            AND used_at IS NULL
            AND expires_at > ?
        `)
        .get(hashSetupKey(key), now);

      return mapSetupKey(row);
    },

    hasActiveForUser(userId, now) {
      const row = db
        .prepare(`
          SELECT id
          FROM master_setup_keys
          WHERE user_id = ?
            AND used_at IS NULL
            AND expires_at > ?
          LIMIT 1
        `)
        .get(userId, now);

      return Boolean(row);
    },

    markUsed({ id, usedAt, now }) {
      const result = db.prepare(`
        UPDATE master_setup_keys
        SET used_at = ?
        WHERE id = ?
          AND used_at IS NULL
          AND expires_at > ?
      `).run(usedAt, id, now);

      return result.changes > 0;
    },

    // Entfernt alle noch offenen Keys eines Kontos (z. B. nach erfolgreicher
    // Einrichtung oder beim Rotieren eines abgelaufenen Keys).
    deletePendingForUser(userId) {
      db.prepare(`
        DELETE FROM master_setup_keys
        WHERE user_id = ?
          AND used_at IS NULL
      `).run(userId);
    },

    // Raeumt abgelaufene oder bereits verbrauchte Setup-Keys auf.
    deleteStale(now) {
      const result = db.prepare(`
        DELETE FROM master_setup_keys
        WHERE used_at IS NOT NULL
           OR expires_at <= ?
      `).run(now);

      return result.changes;
    }
  };
}
