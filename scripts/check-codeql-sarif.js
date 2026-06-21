import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

async function listSarifFiles(inputPath) {
  const entry = await stat(inputPath);
  if (entry.isFile()) return inputPath.endsWith(".sarif") ? [inputPath] : [];

  const files = [];
  for (const child of await readdir(inputPath)) {
    files.push(...await listSarifFiles(path.join(inputPath, child)));
  }
  return files;
}

export function actionableSarifResults(sarif) {
  return (sarif.runs ?? []).flatMap((run) =>
    (run.results ?? []).filter((result) => !result.suppressions?.some((suppression) => suppression.status === "accepted"))
  );
}

export async function checkCodeqlSarif(inputPath) {
  const sarifFiles = await listSarifFiles(path.resolve(inputPath));
  if (sarifFiles.length === 0) throw new Error(`Keine SARIF-Datei unter ${inputPath} gefunden.`);

  const findings = [];
  for (const sarifFile of sarifFiles) {
    const sarif = JSON.parse(await readFile(sarifFile, "utf8"));
    findings.push(...actionableSarifResults(sarif));
  }
  return findings;
}

async function main() {
  const inputPath = process.argv[2];
  if (!inputPath) throw new Error("Pfad zur CodeQL-SARIF-Datei oder zum Ergebnisverzeichnis fehlt.");

  const findings = await checkCodeqlSarif(inputPath);
  if (findings.length > 0) {
    for (const finding of findings) {
      const location = finding.locations?.[0]?.physicalLocation;
      const file = location?.artifactLocation?.uri ?? "unbekannte Datei";
      const line = location?.region?.startLine ?? "?";
      console.error(`${finding.level ?? "warning"}: ${finding.ruleId ?? "CodeQL"} in ${file}:${line}`);
    }
    throw new Error(`CodeQL meldet ${findings.length} nicht unterdrückte Befunde.`);
  }

  console.log("CodeQL-Gate: 0 nicht unterdrückte Befunde.");
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
