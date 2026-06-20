import { defineConfig } from "@playwright/test";

// Frontend-Smoke-Tests: startet die App mit Demo-Daten und lokalem Master-Login,
// ohne Netz-/Hintergrundjobs. Deckt die Lücke, dass die node:test-Suite nur den
// Server prüft (der Bauvorhaben-Bug war genau deshalb ungetestet).
const PORT = 3214;

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 30000,
  expect: { timeout: 8000 },
  reporter: "list",
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    viewport: { width: 1440, height: 900 },
    trace: "on-first-retry",
    screenshot: "only-on-failure"
  },
  projects: [{ name: "chromium" }],
  webServer: {
    command: "node server/app.js",
    port: PORT,
    reuseExistingServer: false,
    timeout: 30000,
    env: {
      NODE_ENV: "test",
      PORT: String(PORT),
      DATABASE_PATH: "./data/e2e.sqlite",
      SEED_DEMO_APPLICATIONS: "true",
      MASTER_ACCOUNT_PASSWORD: "E2ETestMaster123!",
      DEFAULT_LOGIN_PASSWORD: "E2ETestTeam123!",
      AUTO_SYNC_ENABLED: "false",
      AUTO_SYNC_RUN_ON_START: "false",
      AGIS_REFRESH_ON_START: "false",
      MAINTENANCE_ENABLED: "false",
      MIGRATION_BACKUP: "false",
      SYNC_DISABLE_DEFAULT_AMTSBLATT: "true"
    }
  }
});
