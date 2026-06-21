import test from "node:test";
import assert from "node:assert/strict";
import { createDatabase, applyMigrationOnce } from "../server/db.js";

// S3: Destruktive Migrationen duerfen nur mit erfolgreichem (oder bewusst
// uebersprungenem) Backup laufen. Ein fehlgeschlagenes Backup muss die
// destruktive Aenderung verhindern.

function seededDb() {
  const db = createDatabase(":memory:", { seedDemoApplications: true });
  const count = db.prepare("SELECT COUNT(*) AS c FROM applications").get().c;
  assert.ok(count > 0, "Testvoraussetzung: es muessen Baugesuche vorhanden sein");
  return { db, count };
}

test("destruktive Migration bricht ab, wenn das Backup fehlschlaegt", () => {
  const { db, count } = seededDb();
  let ran = false;
  const failingBackup = () => ({ status: "failed", error: new Error("disk voll") });

  assert.throws(
    () =>
      applyMigrationOnce(
        db,
        { id: "test-destructive-abort", dbPath: "/nicht/existent/test.sqlite", destructive: true, backupFn: failingBackup },
        (database) => {
          ran = true;
          database.exec("DELETE FROM applications");
        }
      ),
    /[Bb]ackup/
  );

  assert.equal(ran, false, "destruktiver run() darf bei Backup-Fehler nicht laufen");
  const after = db.prepare("SELECT COUNT(*) AS c FROM applications").get().c;
  assert.equal(after, count, "Daten muessen unveraendert bleiben");
});

test("destruktive Migration laeuft bei bewusst uebersprungenem Backup", () => {
  const { db } = seededDb();
  let ran = false;
  const skippedBackup = () => ({ status: "skipped" });

  const result = applyMigrationOnce(
    db,
    { id: "test-destructive-skip-ok", dbPath: ":memory:", destructive: true, backupFn: skippedBackup },
    () => {
      ran = true;
    }
  );

  assert.equal(ran, true);
  assert.equal(result, true);
});

test("destruktive Migration laeuft bei erfolgreichem Backup", () => {
  const { db } = seededDb();
  let ran = false;
  const okBackup = () => ({ status: "ok", path: "/tmp/x.bak" });

  applyMigrationOnce(
    db,
    { id: "test-destructive-ok", dbPath: "/tmp/test.sqlite", destructive: true, backupFn: okBackup },
    () => {
      ran = true;
    }
  );

  assert.equal(ran, true);
});
