import { test, expect } from "@playwright/test";

const MASTER = { username: "master", password: "E2ETestMaster123!" };

async function loginAsMaster(page) {
  await page.goto("/");
  await expect(page.locator("#loginUsername")).toBeVisible();
  await page.locator("#loginUsername").fill(MASTER.username);
  await page.locator("#loginPassword").fill(MASTER.password);
  await page.locator("#loginButton").click();
  await expect(page.locator("#appShell")).toBeVisible();
}

test("Login: Formular sichtbar und Master-Login funktioniert", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#authShell")).toBeVisible();
  await expect(page.locator("#loginForm")).toBeVisible();

  await loginAsMaster(page);

  await expect(page.locator("#authShell")).toBeHidden();
  await expect(page.locator("#sessionUserRole")).toContainText("Master");
});

test("Arbeitsliste: Fälle und Tabs werden geladen", async ({ page }) => {
  await loginAsMaster(page);

  // Demo-Daten erzeugen mindestens eine Zeile
  await expect(page.locator("#tbody tr[data-id]").first()).toBeVisible();
  await expect(page.locator("#resultCount")).toContainText("Baugesuch");
  // Reiter der Arbeitsliste vorhanden
  await expect(page.locator('button.tab[data-tab="all"]')).toBeVisible();
  await expect(page.locator('button.tab[data-tab="important"]')).toBeVisible();
});

test("Detail: Bauvorhaben-Feld zeigt sauberen Text (Regressionsschutz)", async ({ page }) => {
  await loginAsMaster(page);

  // AGIS-Live-Abfrage (an ag.ch) für den Test neutralisieren – das Bauvorhaben-Feld
  // wird unabhängig davon synchron gesetzt.
  await page.route("**/api/agis/features**", (route) => route.abort());

  await page.locator("#tbody tr[data-id]").first().click();
  await expect(page.locator("#detailBody")).toBeVisible();

  const project = page.locator("#fProject");
  await expect(project).toBeVisible();
  const text = ((await project.textContent()) ?? "").trim();

  expect(text.length).toBeGreaterThan(0);
  expect(text).not.toBe("–");
  // Regressionsschutz für den Bauvorhaben-Fix: kein roher Mischtext / HTML
  expect(text).not.toMatch(/Bauherr|Bauplatz|Grundeigent|Projektverfasser|<[a-z/]/i);
});

test("Verwaltung: Master sieht Gemeindequellen", async ({ page }) => {
  await loginAsMaster(page);

  await page.locator('button.nav-item[data-view="admin"]').click();
  await expect(page.locator("#view-admin")).toBeVisible();
  await expect(page.locator('button.rail-item[data-pane="sources"]')).toBeVisible();
  await expect(page.locator("#view-admin h1")).toContainText("Verwaltung");
});

test("Verwaltung: Konten-Liste bietet Sperren und Löschen", async ({ page }) => {
  await loginAsMaster(page);

  await page.locator('button.nav-item[data-view="admin"]').click();
  await page.locator('button.rail-item[data-pane="keys"]').click();

  // Team-Konten zeigen Sperr- und Lösch-Aktionen (Master-/eigenes Konto nicht).
  await expect(page.locator("#keysBody [data-user-lock]").first()).toBeVisible();
  const deleteButton = page.locator("#keysBody [data-user-delete]").first();
  await expect(deleteButton).toBeVisible();
  await deleteButton.click();
  await expect(page.locator(".modal-msg")).toContainText("Kommentare");
  await expect(page.locator(".modal-msg")).toContainText("sperren");
  await page.locator('[data-modal="cancel"]').click();
});
