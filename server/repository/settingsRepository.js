function mapSetting(row) {
  if (!row) {
    return null;
  }

  return {
    key: row.key,
    value: row.value,
    updatedAt: row.updated_at
  };
}

export function createSettingsRepository(db) {
  return {
    getByKey(key) {
      const row = db
        .prepare(`
          SELECT key, value, updated_at
          FROM app_settings
          WHERE key = ?
        `)
        .get(key);

      return mapSetting(row);
    },

    getValue(key, fallback = "") {
      return this.getByKey(key)?.value ?? fallback;
    },

    setValue(key, value, updatedAt = new Date().toISOString()) {
      db.prepare(`
        INSERT INTO app_settings (
          key,
          value,
          updated_at
        ) VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET
          value = excluded.value,
          updated_at = excluded.updated_at
      `).run(key, String(value ?? ""), updatedAt);

      return this.getByKey(key);
    },

    deleteByKey(key) {
      return db.prepare("DELETE FROM app_settings WHERE key = ?").run(key).changes > 0;
    }
  };
}
