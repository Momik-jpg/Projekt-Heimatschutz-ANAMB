import test from "node:test";
import assert from "node:assert/strict";
import { createDatabase } from "../server/db.js";
import { createAuditLogRepository } from "../server/repository/auditLogRepository.js";

function freshRepo() {
  const db = createDatabase(":memory:", { seedDemoApplications: false });
  return { db, repo: createAuditLogRepository(db) };
}

test("record + listRecent (Reihenfolge, Defaults, Limit)", () => {
  const { repo } = freshRepo();
  repo.record({ action: "test.a", actorName: "Lucia", occurredAt: "2026-01-01T00:00:00.000Z" });
  repo.record({ action: "test.b", occurredAt: "2026-02-01T00:00:00.000Z" });

  const recent = repo.listRecent(10);
  assert.equal(recent.length, 2);
  assert.equal(recent[0].action, "test.b", "neueste zuerst (DESC)");
  assert.equal(recent[0].actorName, "", "Default fuer fehlenden Actor");
  assert.equal(recent[1].actorName, "Lucia");
  assert.equal(repo.listRecent(1).length, 1, "Limit greift");
});

test("deleteOlderThan entfernt alte Eintraege", () => {
  const { repo } = freshRepo();
  repo.record({ action: "alt", occurredAt: "2026-01-01T00:00:00.000Z" });
  repo.record({ action: "neu", occurredAt: "2026-03-01T00:00:00.000Z" });

  const removed = repo.deleteOlderThan("2026-02-01T00:00:00.000Z");
  assert.equal(removed, 1);
  const rest = repo.listRecent(10);
  assert.equal(rest.length, 1);
  assert.equal(rest[0].action, "neu");
});

test("record verschluckt Fehler (Logging darf den Ablauf nie scheitern lassen)", () => {
  const { db, repo } = freshRepo();
  db.close();
  assert.doesNotThrow(() => repo.record({ action: "nach-close" }));
});
