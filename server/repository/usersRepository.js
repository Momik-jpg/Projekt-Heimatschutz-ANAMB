import { randomBytes, scrypt, scryptSync, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scryptAsync = promisify(scrypt);

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

async function hashPasswordAsync(password, salt) {
  const derivedKey = await scryptAsync(password, salt, 64);
  return derivedKey.toString("hex");
}

async function verifyPasswordAsync(password, salt, expectedHash) {
  const actualHash = await hashPasswordAsync(password, salt);
  const actualBuffer = Buffer.from(actualHash, "hex");
  const expectedBuffer = Buffer.from(expectedHash, "hex");

  // timingSafeEqual wirft bei unterschiedlicher Länge – defensiv vorher prüfen.
  if (actualBuffer.length !== expectedBuffer.length) {
    return false;
  }

  return timingSafeEqual(actualBuffer, expectedBuffer);
}

// Synchron, wird nur beim einmaligen Seeding/Boot (server/db.js) verwendet.
export function createUserPasswordRecord(password) {
  const salt = randomBytes(16).toString("hex");
  return {
    salt,
    hash: hashPassword(password, salt)
  };
}

// Berechnet Salt + Hash ohne die Event-Loop zu blockieren. Wird im Request-Pfad
// VOR dem öffnen einer DB-Transaktion aufgerufen, damit der eigentliche Insert
// synchron (ohne await) innerhalb der Transaktion ablaufen kann.
export async function createUserPasswordRecordAsync(password) {
  const salt = randomBytes(16).toString("hex");
  return {
    salt,
    hash: await hashPasswordAsync(password, salt)
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

    // Synchroner Insert. Der Aufrufer übergibt einen vorberechneten passwordRecord
    // (siehe createUserPasswordRecordAsync), damit dieser Aufruf gefahrlos innerhalb
    // einer offenen DB-Transaktion ohne await verwendet werden kann.
    create({ id, username, displayName, role, email = "", passwordRecord, createdAt }) {
      const normalizedUsername = String(username).trim().toLowerCase();

      db.prepare(`
        INSERT INTO users (
          id,
          username,
          display_name,
          role,
          email,
          password_salt,
          password_hash,
          active,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        normalizedUsername,
        displayName.trim(),
        role,
        String(email ?? "").trim().toLowerCase(),
        passwordRecord.salt,
        passwordRecord.hash,
        1,
        createdAt,
        createdAt
      );

      return this.getPublicUserById(id);
    },

    // Kontaktdaten für den Passwort-Reset. Liefert auch die E-Mail (bewusst NICHT
    // Teil der öffentlichen mapUser-Ausgabe, damit die Login-Liste keine Adressen leakt).
    getContactByUsername(username) {
      const row = db
        .prepare(`
          SELECT id, display_name, email
          FROM users
          WHERE username = ? AND active = 1
        `)
        .get(String(username ?? "").trim().toLowerCase());

      if (!row) {
        return null;
      }

      return {
        id: row.id,
        displayName: row.display_name,
        email: String(row.email ?? "").trim()
      };
    },

    // Kontaktdaten anhand der hinterlegten E-Mail-Adresse (fuer Self-Service-Reset
    // per E-Mail-Eingabe). E-Mails werden klein geschrieben gespeichert.
    getContactByEmail(email) {
      const normalizedEmail = String(email ?? "").trim().toLowerCase();

      if (!normalizedEmail) {
        return null;
      }

      const row = db
        .prepare(`
          SELECT id, display_name, email
          FROM users
          WHERE email = ? AND email <> '' AND active = 1
          LIMIT 1
        `)
        .get(normalizedEmail);

      if (!row) {
        return null;
      }

      return {
        id: row.id,
        displayName: row.display_name,
        email: String(row.email ?? "").trim()
      };
    },

    async authenticate({ userId, username, password }) {
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

      const passwordMatches = await verifyPasswordAsync(password, row.password_salt, row.password_hash);
      return passwordMatches ? mapUser(row) : null;
    },

    async resetPassword(id, password) {
      const current = this.getPublicUserById(id);

      if (!current) {
        return null;
      }

      const passwordRecord = await createUserPasswordRecordAsync(password);
      const updatedAt = new Date().toISOString();

      db.prepare(`
        UPDATE users
        SET password_salt = ?,
            password_hash = ?,
            updated_at = ?
        WHERE id = ? AND active = 1
      `).run(passwordRecord.salt, passwordRecord.hash, updatedAt, id);

      return this.getPublicUserById(id);
    },

    // Synchrones Setzen eines vorberechneten Passwort-Records (siehe
    // createUserPasswordRecordAsync). Gefahrlos innerhalb einer offenen
    // DB-Transaktion verwendbar. Gibt true zurück, wenn ein Konto aktualisiert wurde.
    applyPasswordRecord(id, passwordRecord, updatedAt = new Date().toISOString()) {
      const result = db.prepare(`
        UPDATE users
        SET password_salt = ?,
            password_hash = ?,
            updated_at = ?
        WHERE id = ? AND active = 1
      `).run(passwordRecord.salt, passwordRecord.hash, updatedAt, id);

      return result.changes > 0;
    }
  };
}
