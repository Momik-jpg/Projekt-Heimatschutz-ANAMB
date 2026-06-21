import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// Groessen-Gate (A2/Q1): Keine produktive Quelldatei (.js/.css/.html) ueber 800
// Zeilen, ausser reinen Datenkatalogen. Drittcode unter public/vendor ist
// ausgenommen. Die Allowlist enthaelt nur noch dauerhafte Ausnahmen.
const MAX_LINES = 800;
const repoRoot = fileURLToPath(new URL("../", import.meta.url));

const EXEMPT = new Set([
  // Reiner Datenkatalog (Spec-Ausnahme):
  "server/seed/municipalitySources.js"
]);

const SOURCE_EXTENSIONS = [".js", ".css", ".html"];
const IGNORED_DIRECTORIES = new Set(["vendor", "node_modules"]);

async function collectSourceFiles(relDir) {
  const out = [];
  const entries = await readdir(new URL(`../${relDir}/`, import.meta.url), { withFileTypes: true });
  for (const entry of entries) {
    const rel = `${relDir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (IGNORED_DIRECTORIES.has(entry.name)) {
        continue;
      }
      out.push(...(await collectSourceFiles(rel)));
    } else if (SOURCE_EXTENSIONS.some((extension) => entry.name.endsWith(extension))) {
      out.push(rel);
    }
  }
  return out;
}

function lineCount(relPath) {
  return readFileSync(new URL(`../${relPath}`, import.meta.url), "utf8").split(/\r?\n/).length;
}

test("keine Produktivdatei ueber 800 Zeilen (ausser Datenkataloge)", async () => {
  const files = [...(await collectSourceFiles("server")), ...(await collectSourceFiles("public"))];
  const offenders = files.filter((file) => !EXEMPT.has(file) && lineCount(file) > MAX_LINES);
  assert.deepEqual(offenders, [], `Diese Dateien ueberschreiten ${MAX_LINES} Zeilen und sind nicht freigestellt`);
});

test("Allowlist bleibt ehrlich: freigestellte Dateien sind echte Datenkataloge ueber 800 Zeilen", () => {
  const stillOversized = [...EXEMPT].filter((file) => lineCount(file) > MAX_LINES);
  assert.deepEqual(
    [...EXEMPT],
    stillOversized,
    "Eine Allowlist-Datei ist <=800 Zeilen und sollte entfernt werden"
  );
  void repoRoot;
});
