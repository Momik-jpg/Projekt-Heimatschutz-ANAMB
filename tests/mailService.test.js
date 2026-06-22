import test from "node:test";
import assert from "node:assert/strict";
import { createMailService, resolveMailConfig } from "../server/services/mailService.js";

test("resolveMailConfig normalisiert Port, Secure-Flag und Absender", () => {
  assert.deepEqual(
    resolveMailConfig(
      { host: " smtp.example.org ", port: "465", secure: "", user: " user@example.org ", password: " pw " },
      {}
    ),
    {
      host: "smtp.example.org",
      port: 465,
      secure: true,
      user: "user@example.org",
      password: "pw",
      from: "user@example.org"
    }
  );

  assert.equal(resolveMailConfig({ host: "smtp.example.org", from: "noreply@example.org", secure: "false" }, {}).secure, false);
  assert.equal(resolveMailConfig({ host: "smtp.example.org", from: "noreply@example.org", secure: true }, {}).secure, true);
});

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
