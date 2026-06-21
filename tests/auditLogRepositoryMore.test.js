import test from "node:test";
import assert from "node:assert/strict";
import { createDatabase } from "../server/db.js";
import { createAuditLogRepository } from "../server/repository/auditLogRepository.js";

function freshRepo() {
  const db = createDatabase(":memory:", { seedDemoApplications: false });
  return createAuditLogRepository(db);
}

test("record: alle Felder, explizite null-Werte und Default-Zeitstempel", () => {
  const repo = freshRepo();

  repo.record({
    action: "voll",
    actorUserId: "U1",
    actorName: "Lucia",
    target: "BG-1",
    detail: "geprüft",
    ip: "127.0.0.1",
    occurredAt: "2026-05-01T00:00:00.000Z"
  });
  repo.record({
    action: "null-werte",
    actorUserId: null,
    actorName: null,
    target: null,
    detail: null,
    ip: null,
    occurredAt: "2026-04-01T00:00:00.000Z"
  });
  repo.record({ action: "jetzt" });

  const all = repo.listRecent(10);
  assert.equal(all.length, 3);

  const voll = all.find((entry) => entry.action === "voll");
  assert.equal(voll.actorUserId, "U1");
  assert.equal(voll.ip, "127.0.0.1");
  assert.equal(voll.detail, "geprüft");

  const nullEntry = all.find((entry) => entry.action === "null-werte");
  assert.equal(nullEntry.actorName, "");
  assert.equal(nullEntry.ip, "");

  const jetzt = all.find((entry) => entry.action === "jetzt");
  assert.ok(jetzt.occurredAt, "Default-Zeitstempel gesetzt");
});
