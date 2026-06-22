import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { actionableSarifResults, checkCodeqlSarif, runCodeqlSarifGate } from "../scripts/check-codeql-sarif.js";

test("SARIF-Gate zählt Befunde, aber keine akzeptierten Unterdrückungen", () => {
  assert.deepEqual(actionableSarifResults({}), []);

  const findings = actionableSarifResults({
    runs: [{ results: [
      { ruleId: "js/example" },
      { ruleId: "js/suppressed", suppressions: [{ status: "accepted" }] },
      { ruleId: "js/unused-local-variable" }
    ] }]
  });

  assert.deepEqual(findings.map((finding) => finding.ruleId), ["js/example"]);
});

test("SARIF-Gate liest alle Ergebnisdateien in einem Verzeichnis", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codeql-sarif-"));
  await writeFile(path.join(directory, "first.sarif"), JSON.stringify({ runs: [{ results: [] }] }));
  await writeFile(path.join(directory, "second.sarif"), JSON.stringify({ runs: [{ results: [{ ruleId: "js/finding" }] }] }));

  const findings = await checkCodeqlSarif(directory);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].ruleId, "js/finding");
});

test("SARIF-Gate meldet fehlende SARIF-Dateien", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codeql-empty-"));
  await writeFile(path.join(directory, "not-sarif.txt"), "leer");

  await assert.rejects(() => checkCodeqlSarif(directory), /Keine SARIF-Datei/);
});

test("SARIF-Gate CLI-Logik meldet Befunde mit Ort und saubere Läufe", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codeql-run-"));
  const findingFile = path.join(directory, "finding.sarif");
  const cleanFile = path.join(directory, "clean.sarif");
  await writeFile(
    findingFile,
    JSON.stringify({
      runs: [
        {
          results: [
            {
              ruleId: "js/problem",
              level: "error",
              locations: [{ physicalLocation: { artifactLocation: { uri: "server/app.js" }, region: { startLine: 42 } } }]
            }
          ]
        }
      ]
    })
  );
  await writeFile(cleanFile, JSON.stringify({ runs: [{ results: [] }] }));

  const errors = [];
  await assert.rejects(
    () => runCodeqlSarifGate(findingFile, { stderr: (line) => errors.push(line), stdout: () => {} }),
    /nicht unterdrückte Befunde/
  );
  assert.deepEqual(errors, ["error: js/problem in server/app.js:42"]);

  const logs = [];
  await runCodeqlSarifGate(cleanFile, { stderr: () => {}, stdout: (line) => logs.push(line) });
  assert.deepEqual(logs, ["CodeQL-Gate: 0 nicht unterdrückte Befunde."]);
});

test("SARIF-Gate formatiert Befunde ohne optionale CodeQL-Felder defensiv", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codeql-fallback-"));
  const findingFile = path.join(directory, "finding.sarif");
  await writeFile(findingFile, JSON.stringify({ runs: [{ results: [{}] }] }));

  const errors = [];
  await assert.rejects(
    () => runCodeqlSarifGate(findingFile, { stderr: (line) => errors.push(line), stdout: () => {} }),
    /nicht unterdrückte Befunde/
  );
  assert.deepEqual(errors, ["warning: CodeQL in unbekannte Datei:?"]);
});
