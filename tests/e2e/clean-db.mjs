import { rmSync } from "node:fs";

// Stellt für jeden E2E-Lauf eine frische Demo-Datenbank sicher (deterministisch).
for (const suffix of ["", "-shm", "-wal"]) {
  rmSync(`./data/e2e.sqlite${suffix}`, { force: true });
}
