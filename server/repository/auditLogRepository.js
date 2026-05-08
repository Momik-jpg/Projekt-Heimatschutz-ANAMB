import { randomBytes } from "node:crypto";

function mapEntry(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    occurredAt: row.occurred_at,
    action: row.action,
    actorUserId: row.actor_user_id,
    actorName: row.actor_name,
    target: row.target,
    detail: row.detail,
    ip: row.ip
  };
}

export function createAuditLogRepository(db) {
  return {
    // Schreibt einen Protokolleintrag. Fehler werden bewusst geschluckt, damit
    // das Logging niemals den eigentlichen Request scheitern laesst.
    record({ action, actorUserId = "", actorName = "", target = "", detail = "", ip = "", occurredAt }) {
      try {
        db.prepare(`
          INSERT INTO audit_log (
            id,
            occurred_at,
            action,
            actor_user_id,
            actor_name,
            target,
            detail,
            ip
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          `AUD-${randomBytes(8).toString("hex")}`,
          occurredAt ?? new Date().toISOString(),
          String(action),
          String(actorUserId ?? ""),
          String(actorName ?? ""),
          String(target ?? ""),
          String(detail ?? ""),
          String(ip ?? "")
        );
      } catch {
        // Logging darf den Ablauf nicht stören.
      }
    },

    listRecent(limit = 100) {
      return db
        .prepare(`
          SELECT id, occurred_at, action, actor_user_id, actor_name, target, detail, ip
          FROM audit_log
          ORDER BY occurred_at DESC
          LIMIT ?
        `)
        .all(limit)
        .map(mapEntry);
    },

    // Aelter als das Aufbewahrungsdatum: entfernen (Standard-Aufbewahrung extern gesteuert).
    deleteOlderThan(cutoffIso) {
      const result = db.prepare("DELETE FROM audit_log WHERE occurred_at < ?").run(cutoffIso);
      return result.changes;
    }
  };
}
