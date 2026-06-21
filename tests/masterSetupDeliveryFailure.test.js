import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../server/app.js";

test("SMTP-Fehler entfernt den unzustellbaren Setup-Key und lässt ready scheitern", async () => {
  const instance = createApp({
    dbPath: ":memory:",
    seedDemoApplications: false,
    masterAccountPassword: "",
    masterSetupEmail: "master@ag.ch",
    mailService: {
      isConfigured: () => true,
      sendMail: async () => {
        throw new Error("smtp down");
      }
    },
    logger: { log() {}, warn() {}, error() {} },
    maintenanceEnabled: false,
    autoSyncEnabled: false,
    agisAssessmentEnabled: false
  });

  try {
    await assert.rejects(instance.ready, /smtp down/);
    const pending = instance.db.prepare("SELECT COUNT(*) AS count FROM master_setup_keys WHERE used_at IS NULL").get().count;
    assert.equal(pending, 0);
  } finally {
    instance.stopBackgroundJobs();
    instance.db.close();
  }
});
