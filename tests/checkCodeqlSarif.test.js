import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { actionableSarifResults, checkCodeqlSarif } from "../scripts/check-codeql-sarif.js";

test("SARIF-Gate zählt Befunde, aber keine akzeptierten Unterdrückungen", () => {
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
