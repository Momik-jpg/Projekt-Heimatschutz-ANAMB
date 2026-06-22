import { defineConfig } from "@playwright/test";

// Frontend-Smoke-Tests: startet die App mit Demo-Daten und lokalem Master-Login,
// ohne Netz-/Hintergrundjobs. Deckt die Lücke, dass die node:test-Suite nur den
// Server prüft (der Bauvorhaben-Bug war genau deshalb ungetestet).
export const E2E_PORT = Number.parseInt(process.env.E2E_PORT ?? "3214", 10);
export const E2E_WEB_SERVER_ENV = {
  NODE_ENV: "test",
  PORT: String(E2E_PORT),
  E2E_INSTANCE_ID: process.env.E2E_INSTANCE_ID ?? "playwright-managed-server",
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
};

const skipManagedWebServer = process.env.PLAYWRIGHT_SKIP_WEB_SERVER === "true";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 30000,
  expect: { timeout: 8000 },
  reporter: "list",
  use: {
    baseURL: `http://127.0.0.1:${E2E_PORT}`,
    viewport: { width: 1440, height: 900 },
    trace: "on-first-retry",
    screenshot: "only-on-failure"
  },
  projects: [{ name: "chromium" }],
  webServer: skipManagedWebServer
    ? undefined
    : {
        command: "node server/app.js",
        port: E2E_PORT,
        reuseExistingServer: false,
        timeout: 30000,
        env: E2E_WEB_SERVER_ENV
      }
});
