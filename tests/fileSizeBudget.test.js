import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// Phase 2/3-Gate (A2/Q1): Keine produktive Quelldatei ueber 800 Zeilen, ausser
// reinen Datenkatalogen. Die Allowlist listet bekannte Uebergroessen, die noch
// gesplittet werden – sie soll mit jedem Split schrumpfen, nie wachsen.
const MAX_LINES = 800;
const repoRoot = fileURLToPath(new URL("../", import.meta.url));

const EXEMPT = new Set([
  // Reiner Datenkatalog (Spec-Ausnahme):
  "server/seed/municipalitySources.js",
  // Bekannte Uebergroessen – TODO splitten (Allowlist verkleinern):
  "public/app.js",
  "server/app.js"
]);

async function collectJsFiles(relDir) {
  const out = [];
  const entries = await readdir(new URL(`../${relDir}/`, import.meta.url), { withFileTypes: true });
  for (const entry of entries) {
    const rel = `${relDir}/${entry.name}`;
    if (entry.isDirectory()) {
      out.push(...(await collectJsFiles(rel)));
    } else if (entry.name.endsWith(".js")) {
      out.push(rel);
    }
  }
  return out;
}

function lineCount(relPath) {
  return readFileSync(new URL(`../${relPath}`, import.meta.url), "utf8").split(/\r?\n/).length;
}

test("keine neue Produktivdatei ueber 800 Zeilen (ausser Datenkataloge)", async () => {
  const files = [...(await collectJsFiles("server")), ...(await collectJsFiles("public"))];
  const offenders = files.filter((file) => !EXEMPT.has(file) && lineCount(file) > MAX_LINES);
  assert.deepEqual(offenders, [], `Diese Dateien ueberschreiten ${MAX_LINES} Zeilen und sind nicht freigestellt`);
});

test("Allowlist bleibt ehrlich: freigestellte Dateien sind noch wirklich zu gross", () => {
  // Datenkatalog ausgenommen – der darf dauerhaft gross sein.
  const shrinkable = [...EXEMPT].filter((file) => file !== "server/seed/municipalitySources.js");
  const alreadyCompliant = shrinkable.filter((file) => lineCount(file) <= MAX_LINES);
  assert.deepEqual(
    alreadyCompliant,
    [],
    "Diese Dateien sind jetzt <=800 Zeilen und sollten aus der Allowlist entfernt werden"
  );
  void repoRoot;
});
