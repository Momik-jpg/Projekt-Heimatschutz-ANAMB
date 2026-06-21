import test from "node:test";
import assert from "node:assert/strict";
import { createDatabase } from "../server/db.js";
import { createUsersRepository, createUserPasswordRecordAsync } from "../server/repository/usersRepository.js";

async function setup() {
  const db = createDatabase(":memory:", { seedDemoApplications: false });
  const repo = createUsersRepository(db);
  const passwordRecord = await createUserPasswordRecordAsync("Geheim!Passwort1");
  const user = repo.create({
    id: "USR-T1",
    username: "Test.User",
    displayName: " Test User ",
    role: "Team",
    email: "Test@Example.CH",
    passwordRecord,
    createdAt: new Date().toISOString()
  });
  return { db, repo, user };
}

test("create normalisiert Username/Email und liefert oeffentlichen Datensatz", async () => {
  const { repo, user } = await setup();
  assert.equal(user.username, "test.user");
  assert.equal(user.displayName, "Test User");
  assert.equal(user.email, undefined, "E-Mail ist nicht Teil der oeffentlichen Ausgabe");
  assert.equal(repo.usernameExists("TEST.USER"), true);
  assert.equal(repo.usernameExists("unbekannt"), false);
  assert.ok(repo.listForAdmin().some((u) => u.id === "USR-T1"));
  assert.ok(repo.listAllForAdmin().some((u) => u.id === "USR-T1" && u.active === true));
});

test("authenticate: per Username/UserId, falsches/leeres Passwort, Unbekannte", async () => {
  const { repo } = await setup();
  assert.ok(await repo.authenticate({ username: "test.user", password: "Geheim!Passwort1" }));
  assert.ok(await repo.authenticate({ userId: "USR-T1", password: "Geheim!Passwort1" }));
  assert.equal(await repo.authenticate({ username: "test.user", password: "falsch" }), null);
  assert.equal(await repo.authenticate({ username: "test.user", password: "" }), null);
  assert.equal(await repo.authenticate({ username: "unbekannt", password: "x" }), null);
});

test("Kontaktabfragen, resetPassword und applyPasswordRecord", async () => {
  const { repo } = await setup();
  assert.equal(repo.getContactByUsername("test.user").email, "test@example.ch");
  assert.equal(repo.getContactByUsername("unbekannt"), null);
  assert.equal(repo.getContactByEmail("test@example.ch").id, "USR-T1");
  assert.equal(repo.getContactByEmail(""), null);
  assert.equal(repo.getContactByEmail("none@example.ch"), null);

  assert.ok(await repo.resetPassword("USR-T1", "NeuesPasswort!2"));
  assert.ok(await repo.authenticate({ username: "test.user", password: "NeuesPasswort!2" }));
  assert.equal(await repo.resetPassword("USR-unbekannt", "x"), null);

  const record = await createUserPasswordRecordAsync("DrittesPw!3");
  assert.equal(repo.applyPasswordRecord("USR-T1", record), true);
  assert.equal(repo.applyPasswordRecord("USR-unbekannt", record), false);
});

test("setActive/findByIdAnyState: gesperrte Konten verschwinden oeffentlich", async () => {
  const { repo } = await setup();
  assert.equal(repo.findByIdAnyState("USR-T1").active, true);
  assert.equal(repo.findByIdAnyState("USR-unbekannt"), null);

  assert.equal(repo.setActive("USR-T1", false), true);
  assert.equal(repo.getPublicUserById("USR-T1"), null);
  assert.equal(repo.findByIdAnyState("USR-T1").active, false);
  assert.equal(await repo.authenticate({ username: "test.user", password: "Geheim!Passwort1" }), null);
});

test("deleteById: ohne Blocker geloescht, Unbekannte nicht", async () => {
  const { repo } = await setup();
  const deletion = repo.deleteById("USR-T1");
  assert.equal(deletion.deleted, true);
  assert.deepEqual(deletion.blockers, { comments: 0, registrationKeys: 0 });
  assert.equal(repo.deleteById("USR-unbekannt").deleted, false);
});
