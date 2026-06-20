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

async function revealOlderRowsIfNeeded(page) {
  await page.locator("#tbody tr[data-id], #tbody [data-show-older]").first().waitFor({ state: "visible" });
  const showOlder = page.locator("[data-show-older]");
  if (await showOlder.isVisible()) await showOlder.click();
}

test("Login: Formular sichtbar und Master-Login funktioniert", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#authShell")).toBeVisible();
  await expect(page.locator("#loginForm")).toBeVisible();

  await loginAsMaster(page);
  await revealOlderRowsIfNeeded(page);

  await expect(page.locator("#authShell")).toBeHidden();
  await expect(page.locator("#sessionUserRole")).toContainText("Master");
});

test("Arbeitsliste: Fälle und Tabs werden geladen", async ({ page }) => {
  await loginAsMaster(page);
  await revealOlderRowsIfNeeded(page);

  // Demo-Daten erzeugen mindestens eine Zeile
  const firstRow = page.locator("#tbody tr[data-id]").first();
  await expect(firstRow).toBeVisible();
  await expect(firstRow).toHaveClass(/unread/);
  await expect(page.locator("#tbody tr.selected")).toHaveCount(0);
  await expect(page.locator("#detailEmpty")).toBeVisible();
  await expect(firstRow.locator(".unread-dot")).toHaveAttribute("aria-hidden", "true");
  await expect(page.locator("#resultCount")).toContainText("Baugesuch");
  const totalCount = ((await page.locator("#resultCount").textContent()) ?? "").trim();
  // Nur die beiden fachlichen Hauptreiter bleiben bestehen.
  await expect(page.locator('button.tab[data-tab="all"]')).toBeVisible();
  await expect(page.locator('button.tab[data-tab="important"]')).toBeVisible();
  await expect(page.locator('button.tab[data-tab="manual"]')).toHaveCount(0);
  await expect(page.locator('button.tab[data-tab="archive"]')).toHaveCount(0);

  const regionButtons = page.locator("button.region-filter");
  await expect(regionButtons).toHaveCount(4);
  await page.locator('button.region-filter[data-region="Berner Aargau"]').click();
  await page.locator('button.region-filter[data-region="Baden"]').click();
  await expect(page.locator('button.region-filter[aria-pressed="true"]')).toHaveCount(2);

  await page.locator('button.region-filter[data-region="Berner Aargau"]').click();
  await page.locator('button.region-filter[data-region="Baden"]').click();
  await expect(page.locator('button.region-filter[aria-pressed="true"]')).toHaveCount(0);
  await expect(page.locator("#resultCount")).toHaveText(totalCount);
});

test("Detail: Bauvorhaben-Feld zeigt sauberen Text (Regressionsschutz)", async ({ page }) => {
  await loginAsMaster(page);
  await revealOlderRowsIfNeeded(page);

  // AGIS-Live-Abfrage (an ag.ch) für den Test neutralisieren – das Bauvorhaben-Feld
  // wird unabhängig davon synchron gesetzt.
  await page.route("**/api/agis/features**", (route) => route.abort());

  const firstRow = page.locator("#tbody tr[data-id]").first();
  await firstRow.click();
  await expect(page.locator("#detailBody")).toBeVisible();
  await expect(firstRow).not.toHaveClass(/unread/);

  const project = page.locator("#fProject");
  await expect(project).toBeVisible();
  const text = ((await project.textContent()) ?? "").trim();

  expect(text.length).toBeGreaterThan(0);
  expect(text).not.toBe("–");
  // Regressionsschutz für den Bauvorhaben-Fix: kein roher Mischtext / HTML
  expect(text).not.toMatch(/Bauherr|Bauplatz|Grundeigent|Projektverfasser|<[a-z/]/i);
  await expect(page.locator("#projectScale")).toContainText(/Klein|Mittel|Gross|Unbekannt/);
  await expect(page.locator("#sourceLink")).toHaveAttribute("href", /^https?:\/\//);
});

test("Mobile: Arbeitsliste bleibt ohne horizontales Scrollen bedienbar", async ({ page }) => {
  await page.setViewportSize({ width: 500, height: 844 });
  await loginAsMaster(page);
  await revealOlderRowsIfNeeded(page);

  const dimensions = await page.evaluate(() => {
    const shell = document.querySelector(".list-panel .table-shell");
    const list = document.querySelector(".list-panel");
    const detail = document.querySelector(".detail-panel");
    return {
      pageWidth: document.documentElement.scrollWidth,
      viewportWidth: window.innerWidth,
      tableWidth: shell.scrollWidth,
      tableViewport: shell.clientWidth,
      detailDistance: detail.getBoundingClientRect().top - list.getBoundingClientRect().top
    };
  });

  expect(dimensions.pageWidth).toBeLessThanOrEqual(dimensions.viewportWidth);
  expect(dimensions.tableWidth).toBeLessThanOrEqual(dimensions.tableViewport + 1);
  expect(dimensions.detailDistance).toBeLessThan(1800);
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
