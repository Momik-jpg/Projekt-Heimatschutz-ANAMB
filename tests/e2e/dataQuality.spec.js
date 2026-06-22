import { test, expect } from "@playwright/test";

const MASTER = { username: "master", password: "E2ETestMaster123!" };

async function loginAndRevealApplications(page) {
  await page.route("**/api/applications/*/read", (route) => route.abort());
  await page.goto("/");
  await page.locator("#loginUsername").fill(MASTER.username);
  await page.locator("#loginPassword").fill(MASTER.password);
  await page.locator("#loginButton").click();
  await expect(page.locator("#appShell")).toBeVisible();

  await page.locator("#tbody tr[data-id], #tbody [data-show-older]").first().waitFor({ state: "visible" });
  const showOlder = page.locator("[data-show-older]");
  if (await showOlder.isVisible()) await showOlder.click();
}

test("Datenprüfung behauptet bei unbestätigter Provenienz keine Vollständigkeit", async ({ page }) => {
  await loginAndRevealApplications(page);

  const openButton = page.locator("#tbody [data-open-application]").first();
  await expect(openButton).toBeVisible();
  await openButton.click();

  await expect(page.locator("#aiMeta")).toContainText("Automatische Datenprüfung");
  await expect(page.locator("#aiMeta")).not.toContainText("KI-Datenprüfung");
  await expect(page.locator("#aiMeta")).not.toContainText("Vollständig");
  await expect(page.locator("#aiMeta")).toContainText(/Frist.*unbestätigt|Frist.*fehlt/i);
});

test("Fallzeilen haben eine tastaturbedienbare primäre Aktion", async ({ page }) => {
  await loginAndRevealApplications(page);

  const firstRow = page.locator("#tbody tr[data-id]").first();
  const openButton = firstRow.locator("[data-open-application]");
  await expect(openButton).toHaveRole("button");
  await expect(openButton).toHaveAccessibleName(/Fall .* öffnen/);

  await openButton.focus();
  await page.keyboard.press("Space");
  await expect(page.locator("#detailBody")).toBeVisible();
});

test("Kartenbibliotheken sind lokal und OSM-Kacheln laden automatisch beim Öffnen", async ({ page }) => {
  const requestedUrls = [];
  page.on("request", (request) => requestedUrls.push(request.url()));
  await loginAndRevealApplications(page);

  await page.locator("#tbody [data-open-application]").first().click();

  // Kartenbibliotheken (Leaflet/proj4) werden lokal ausgeliefert, nicht von einem CDN.
  expect(requestedUrls.some((url) => /unpkg\.com|cdnjs\.cloudflare\.com/.test(url))).toBe(false);

  // OSM-Kacheln laden automatisch beim Öffnen eines Falls (kein manueller Klick nötig).
  await expect.poll(() => requestedUrls.some((url) => /tile\.openstreetmap\.org/.test(url))).toBe(true);
});
