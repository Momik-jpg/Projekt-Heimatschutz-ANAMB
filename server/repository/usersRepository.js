import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

function mapUser(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    role: row.role
  };
}

function hashPassword(password, salt) {
  return scryptSync(password, salt, 64).toString("hex");
}

function verifyPassword(password, salt, expectedHash) {
  const actualHash = hashPassword(password, salt);
  return timingSafeEqual(Buffer.from(actualHash, "hex"), Buffer.from(expectedHash, "hex"));
}

export function createUserPasswordRecord(password) {
  const salt = randomBytes(16).toString("hex");
  return {
    salt,
    hash: hashPassword(password, salt)
  };
}

export function createUsersRepository(db) {
  return {
    listPublicUsers() {
      return db
        .prepare(`
          SELECT id, username, display_name, role
          FROM users
          WHERE active = 1
          ORDER BY display_name ASC
        `)
        .all()
        .map(mapUser);
    },

    listForAdmin() {
      return db
        .prepare(`
          SELECT id, username, display_name, role
          FROM users
          WHERE active = 1
          ORDER BY display_name ASC
        `)
        .all()
        .map((row) => ({
          id: row.id,
          username: row.username,
          displayName: row.display_name,
          role: row.role
        }));
    },

    getPublicUserById(id) {
      const row = db
        .prepare(`
          SELECT id, username, display_name, role
          FROM users
          WHERE id = ? AND active = 1
        `)
        .get(id);

      return mapUser(row);
    },

    usernameExists(username) {
      const row = db
        .prepare(`
          SELECT id
          FROM users
          WHERE username = ?
        `)
        .get(String(username ?? "").trim().toLowerCase());

      return Boolean(row);
    },

    create({ id, username, displayName, role, password, createdAt }) {
      const normalizedUsername = String(username).trim().toLowerCase();
      const passwordRecord = createUserPasswordRecord(password);

      db.prepare(`
        INSERT INTO users (
          id,
          username,
          display_name,
          role,
          password_salt,
          password_hash,
          active,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        normalizedUsername,
        displayName.trim(),
        role,
        passwordRecord.salt,
        passwordRecord.hash,
        1,
        createdAt,
        createdAt
      );

      return this.getPublicUserById(id);
    },

    authenticate({ userId, username, password }) {
      let row = null;

      if (typeof userId === "string" && userId.trim()) {
        row = db
          .prepare(`
            SELECT
              id,
              username,
              display_name,
              role,
              password_salt,
              password_hash
            FROM users
            WHERE id = ? AND active = 1
          `)
          .get(userId.trim());
      }

      if (!row) {
        row = db
          .prepare(`
            SELECT
              id,
              username,
              display_name,
              role,
              password_salt,
              password_hash
            FROM users
            WHERE username = ? AND active = 1
          `)
          .get(String(username ?? "").trim().toLowerCase());
      }

      if (!row || typeof password !== "string" || password.length === 0) {
        return null;
      }

      const passwordMatches = verifyPassword(password, row.password_salt, row.password_hash);
      return passwordMatches ? mapUser(row) : null;
    },

    resetPassword(id, password) {
      const current = this.getPublicUserById(id);

      if (!current) {
        return null;
      }

      const passwordRecord = createUserPasswordRecord(password);
      const updatedAt = new Date().toISOString();

      db.prepare(`
        UPDATE users
        SET password_salt = ?,
            password_hash = ?,
            updated_at = ?
        WHERE id = ? AND active = 1
      `).run(passwordRecord.salt, passwordRecord.hash, updatedAt, id);

      return this.getPublicUserById(id);
    }
  };
}
