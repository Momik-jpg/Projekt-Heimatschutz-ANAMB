import test from "node:test";
import assert from "node:assert/strict";
import { createMailService } from "../server/services/mailService.js";

test("isConfigured: nur mit Host und Absender", () => {
  const configured = createMailService({ getConfig: () => ({ host: "smtp.example.org", from: "a@b.ch" }) });
  assert.equal(configured.isConfigured(), true);

  const notConfigured = createMailService({ getConfig: () => ({ host: "", from: "" }) });
  assert.equal(notConfigured.isConfigured(), false);
});

test("sendMail ohne Host wirft", async () => {
  const service = createMailService({ getConfig: () => ({ host: "" }) });
  await assert.rejects(() => service.sendMail({ to: "x@y.ch", subject: "S", text: "T" }), /SMTP ist nicht konfiguriert/);
});

test("sendMail ohne Empfaenger wirft", async () => {
  const service = createMailService({ getConfig: () => ({ host: "smtp.example.org", from: "a@b.ch" }) });
  await assert.rejects(() => service.sendMail({ to: "", subject: "S", text: "T" }), /Empfänger/);
});
