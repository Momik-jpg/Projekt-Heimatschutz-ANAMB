import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const viewsSource = readFileSync(new URL("../public/js/views.js", import.meta.url), "utf8");

function createContext(items) {
  const countNodes = {
    all: { textContent: "" },
    important: { textContent: "" }
  };
  const context = {
    state: {
      items,
      activeTab: "all",
      selectedRegions: new Set(),
      filters: { municipality: "", protection: "", workflow: "", search: "" },
      sortKey: "publicationDate",
      sortDir: 1
    },
    el: { navWorkCount: { textContent: "" } },
    $: (selector) => countNodes[selector.match(/data-count="([^"]+)"/)?.[1]] ?? null,
    objectionDeadline: (item) => (item.publicationDate ? "2026-06-24" : "")
  };
  vm.runInNewContext(viewsSource, context);
  return { context, countNodes };
}

test("aktive Arbeitsliste blendet archivierte, alte und Fälle ohne berechenbare Frist aus", () => {
  const { context } = createContext([
    { id: "AKTUELL", publicationDate: "2026-06-10", workflowStatus: "new" },
    { id: "GRENZE", publicationDate: "2026-05-22", workflowStatus: "new" },
    { id: "ALT", publicationDate: "2026-05-21", workflowStatus: "new" },
    { id: "ARCHIV", publicationDate: "2026-06-20", workflowStatus: "archived" },
    { id: "OHNE-FRIST", publicationDate: "", deadlineDate: "", workflowStatus: "new" },
    { id: "FRIST-BERECHENBAR", publicationDate: "2026-06-11", deadlineDate: "", workflowStatus: "new" }
  ]);

  const visibleIds = vm.runInContext(
    "visibleItems(new Date(2026, 5, 22)).map((item) => item.id).sort()",
    context
  );
  assert.deepEqual([...visibleIds], ["AKTUELL", "FRIST-BERECHENBAR", "GRENZE"]);
});

test("Arbeitslisten-Zähler berücksichtigen nur aktive Fälle", () => {
  const { context, countNodes } = createContext([
    { id: "AKTUELL", publicationDate: "2026-06-10", workflowStatus: "new", protectionStatus: "combined-hit" },
    { id: "OHNE-FRIST", publicationDate: "", workflowStatus: "new", protectionStatus: "combined-hit" },
    { id: "ALT", publicationDate: "2025-10-01", workflowStatus: "new", protectionStatus: "protected-zone" },
    { id: "ARCHIV", publicationDate: "2026-06-20", workflowStatus: "archived", protectionStatus: "protected-point" }
  ]);

  vm.runInContext("updateTabCounts(new Date(2026, 5, 22))", context);

  assert.equal(countNodes.all.textContent, "1");
  assert.equal(countNodes.important.textContent, "1");
  assert.equal(context.el.navWorkCount.textContent, "1");
});
