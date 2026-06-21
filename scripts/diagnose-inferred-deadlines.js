import { existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

export function findSuspectedInferredDeadlines(db) {
  return db.prepare(`
    SELECT
      applications.id,
      applications.source_reference,
      applications.publication_date,
      applications.deadline_date,
      applications.workflow_status,
      applications.assignee,
      applications.note,
      CASE
        WHEN applications.workflow_status <> 'new'
          OR IFNULL(applications.assignee, '') <> ''
          OR IFNULL(applications.note, '') <> ''
          OR EXISTS (
            SELECT 1 FROM application_comments
            WHERE application_comments.application_id = applications.id
          )
        THEN 1 ELSE 0
      END AS has_team_work
    FROM applications
    WHERE applications.source = 'Amtsblatt Aargau'
      AND IFNULL(applications.publication_date, '') <> ''
      AND IFNULL(applications.deadline_date, '') <> ''
      AND ROUND(julianday(applications.deadline_date) - julianday(applications.publication_date)) = 30
    ORDER BY applications.publication_date DESC, applications.id ASC
  `).all().map((row) => ({
    id: row.id,
    sourceReference: row.source_reference,
    publicationDate: row.publication_date,
    deadlineDate: row.deadline_date,
    workflowStatus: row.workflow_status,
    assignee: row.assignee,
    note: row.note,
    hasTeamWork: Boolean(row.has_team_work)
  }));
}

function countBackups(dbPath) {
  const prefix = `${dbPath.split(/[\\/]/).at(-1)}.`;
  const directories = [dirname(dbPath), join(dirname(dbPath), "backups")];
  return directories.reduce((count, directory) => {
    if (!existsSync(directory)) return count;
    return count + readdirSync(directory).filter((name) => name.startsWith(prefix) && name.endsWith(".bak")).length;
  }, 0);
}

const isDirectRun = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  const dbPath = resolve(process.argv[2] || process.env.DATABASE_PATH || join("data", "heimatschutz.sqlite"));
  if (!existsSync(dbPath)) {
    console.error(`Datenbank nicht gefunden: ${dbPath}`);
    process.exitCode = 1;
  } else {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const items = findSuspectedInferredDeadlines(db);
      console.log(JSON.stringify({ dryRun: true, database: dbPath, backupCount: countBackups(dbPath), count: items.length, items }, null, 2));
    } finally {
      db.close();
    }
  }
}
