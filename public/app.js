/* Heimatschutz Aargau — betriebsbereite Arbeitsoberfläche */

const PROTECTION = {
  "combined-hit": { label: "Gebäude + Gebiet", cls: "danger" },
  "protected-point": { label: "Gebäude geschützt", cls: "danger" },
  "protected-zone": { label: "Gebiet geschützt", cls: "warning" },
  "manual-review": { label: "Manuell prüfen", cls: "warning" },
  "no-hit": { label: "Kein Schutz", cls: "ok" }
};

const WORKFLOW = {
  new: { label: "Offen", cls: "new" },
  "under-review": { label: "Im Team", cls: "review" },
  escalated: { label: "Im Team", cls: "review" },
  cleared: { label: "Erledigt", cls: "cleared" },
  archived: { label: "Abgelegt", cls: "archived" }
};

const SOURCE_TYPE = {
  manual: "Manuell",
  html: "Gemeindeportal",
  xml: "RSS / XML",
  json: "JSON",
  arcgis: "AGIS / ArcGIS",
  pdf: "PDF-Auflage"
};

const TAB_SUB = {
  all: "Aktuell: offene und laufende Fälle.",
  important: "Aktuell: Fälle mit Schutztreffer.",
  manual: "Aktuell: Fälle mit offener Klärung.",
  open: "Aktuell: offene Fälle.",
  "due-soon": "Aktuell: nahe Fristen.",
  archive: "Aktuell: alle erfassten Baugesuche inkl. Archiv."
};

const ONLINEKARTEN_URL = "https://www.ag.ch/geoportal/apps/onlinekarten/";
const ONLINEKARTEN_BASEMAP = "base_landeskarten_sw::topicmaps.geo.ag.ch,1,true";
const ONLINEKARTEN_LAYERS = {
  area: "are_isos::topicmaps.geo.ag.ch;1;true",
  point: "dp_denkmalpflege::topicmaps.geo.ag.ch;1;true"
};
const ONLINEKARTEN_IDENTIFY_TOLERANCE = 50;
const rememberedUsernameStorageKey = "heimatschutz-remembered-username";

const state = {
  currentUser: null,
  dashboard: null,
  items: [],
  selectedId: null,
  comments: [],
  activeTab: "all",
  filters: { search: "", municipality: "", protection: "", workflow: "" },
  sortKey: "dueDays",
  sortDir: 1,
  municipalitySources: [],
  sourceCatalog: [],
  sourceReport: null,
  sourceSummary: null,
  sourceSearch: "",
  registrationKeys: [],
  adminUsers: [],
  syncStatus: null,
  authConfig: { turnstile: { enabled: false, siteKey: "" } },
  turnstileWidgets: {}
};

const mapState = {
  instance: null,
  marker: null,
  overlayGroup: null,
  projectionReady: false,
  requestToken: 0
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

const el = {};

function collectElements() {
  Object.assign(el, {
    authShell: $("#authShell"),
    appShell: $("#appShell"),
    loginForm: $("#loginForm"),
    loginUsername: $("#loginUsername"),
    loginPassword: $("#loginPassword"),
    loginTotpField: $("#loginTotpField"),
    loginTotp: $("#loginTotp"),
    loginButton: $("#loginButton"),
    loginError: $("#loginError"),
    loginTurnstile: $("#loginTurnstile"),
    registerForm: $("#registerForm"),
    registerDisplayName: $("#registerDisplayName"),
    registerUsername: $("#registerUsername"),
    registerEmail: $("#registerEmail"),
    registerPassword: $("#registerPassword"),
    registerAccessKey: $("#registerAccessKey"),
    registerButton: $("#registerButton"),
    registerError: $("#registerError"),
    registerTurnstile: $("#registerTurnstile"),
    forgotPasswordForm: $("#forgotPasswordForm"),
    forgotPasswordEmail: $("#forgotPasswordEmail"),
    forgotPasswordButton: $("#forgotPasswordButton"),
    forgotPasswordError: $("#forgotPasswordError"),
    forgotPasswordSuccess: $("#forgotPasswordSuccess"),
    forgotTurnstile: $("#forgotTurnstile"),
    resetPasswordForm: $("#resetPasswordForm"),
    resetPasswordKey: $("#resetPasswordKey"),
    resetPasswordValue: $("#resetPasswordValue"),
    resetPasswordButton: $("#resetPasswordButton"),
    resetPasswordError: $("#resetPasswordError"),
    resetPasswordSuccess: $("#resetPasswordSuccess"),
    masterSetupForm: $("#masterSetupForm"),
    masterSetupKey: $("#masterSetupKey"),
    masterSetupPassword: $("#masterSetupPassword"),
    masterSetupButton: $("#masterSetupButton"),
    masterSetupError: $("#masterSetupError"),
    masterSetupSuccess: $("#masterSetupSuccess"),
    sessionUserName: $("#sessionUserName"),
    sessionUserRole: $("#sessionUserRole"),
    logoutButton: $("#logoutButton"),
    mastSearch: $("#mastSearch"),
    themeToggle: $("#themeToggle"),
    fontToggle: $("#fontToggle"),
    navWorkCount: $("#navWorkCount"),
    activeFilterText: $("#activeFilterText"),
    syncBtn: $("#syncBtn"),
    resultCount: $("#resultCount"),
    fltSearch: $("#fltSearch"),
    fltMun: $("#fltMun"),
    fltProt: $("#fltProt"),
    fltWf: $("#fltWf"),
    resetFilters: $("#resetFilters"),
    tbody: $("#tbody"),
    detailHelper: $("#detailHelper"),
    detailStatusBadge: $("#detailStatusBadge"),
    detailEmpty: $("#detailEmpty"),
    detailBody: $("#detailBody"),
    fMun: $("#fMun"),
    fAddr: $("#fAddr"),
    fParcel: $("#fParcel"),
    fPub: $("#fPub"),
    fDue: $("#fDue"),
    fAgis: $("#fAgis"),
    fProject: $("#fProject"),
    agisLink: $("#agisLink"),
    mapStatus: $("#mapStatus"),
    detailMap: $("#detailMap"),
    mapFallback: $("#mapFallback"),
    mapLegend: $("#mapLegend"),
    mapSymbolHint: $("#mapSymbolHint"),
    recTitle: $("#recTitle"),
    recText: $("#recText"),
    recBadge: $("#recBadge"),
    dueBadge: $("#dueBadge"),
    srcMeta: $("#srcMeta"),
    timeline: $("#timeline"),
    fWorkflow: $("#fWorkflow"),
    fAssignee: $("#fAssignee"),
    fNote: $("#fNote"),
    saveBtn: $("#saveBtn"),
    clearBtn: $("#clearBtn"),
    nextOpen: $("#nextOpen"),
    printBtn: $("#printBtn"),
    commentCount: $("#commentCount"),
    commentsList: $("#commentsList"),
    commentInput: $("#commentInput"),
    commentSubmit: $("#commentSubmit"),
    srcSearch: $("#srcSearch"),
    srcBody: $("#srcBody"),
    runImport: $("#runImport"),
    runList: $("#runList"),
    keysBody: $("#keysBody"),
    toast: $("#toast"),
    printArea: $("#printArea"),
    paId: $("#paId"),
    paTitle: $("#paTitle"),
    paSub: $("#paSub"),
    paMun: $("#paMun"),
    paAddr: $("#paAddr"),
    paParcel: $("#paParcel"),
    paPub: $("#paPub"),
    paDue: $("#paDue"),
    paAgis: $("#paAgis"),
    paProject: $("#paProject"),
    paRec: $("#paRec"),
    paSource: $("#paSource"),
    paFoot: $("#paFoot")
  });
}

class ApiError extends Error {
  constructor(message, status, payload) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.payload = payload;
  }
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function normalizeText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function truncate(value, max = 96) {
  const text = normalizeText(value);
  return text.length > max ? `${text.slice(0, Math.max(0, max - 1)).trimEnd()}...` : text;
}

function formatDate(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return new Intl.DateTimeFormat("de-CH", { day: "2-digit", month: "2-digit", year: "numeric" }).format(date);
}

function formatDateTime(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return new Intl.DateTimeFormat("de-CH", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}

function daysUntil(value) {
  if (!value) return Number.POSITIVE_INFINITY;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return Number.POSITIVE_INFINITY;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const target = new Date(date);
  target.setHours(0, 0, 0, 0);
  return Math.ceil((target.getTime() - today.getTime()) / 86400000);
}

function busy(button, on, label) {
  if (!button) return;
  if (on) {
    button.dataset.originalText = button.textContent;
    button.disabled = true;
    if (label) button.textContent = label;
  } else {
    button.disabled = false;
    if (button.dataset.originalText) button.textContent = button.dataset.originalText;
  }
}

let toastTimer;
function toast(message) {
  if (!el.toast) return;
  el.toast.textContent = message;
  el.toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.toast.classList.remove("show"), 2600);
}

function setMessage(node, message, ok = false) {
  if (!node) return;
  node.textContent = message;
  node.classList.toggle("hidden", !message);
  node.classList.toggle("ok", ok);
  node.classList.toggle("error", !ok);
}

async function requestJson(url, options = {}) {
  const { method = "GET", body, skipSessionReset = false } = options;
  const headers = { Accept: "application/json" };
  const requestOptions = { method, headers, credentials: "same-origin" };

  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    requestOptions.body = JSON.stringify(body);
  }

  const response = await fetch(url, requestOptions);
  const contentType = response.headers.get("content-type") ?? "";
  const payload = contentType.includes("application/json") ? await response.json() : await response.text();

  if (!response.ok) {
    const message = typeof payload === "object" && payload?.error ? payload.error : `Request fehlgeschlagen (${response.status})`;
    if (response.status === 401 && !skipSessionReset) {
      showLoggedOut();
    }
    throw new ApiError(message, response.status, payload);
  }

  return payload;
}

let turnstileScriptPromise = null;
function loadTurnstileScript() {
  if (turnstileScriptPromise) return turnstileScriptPromise;
  turnstileScriptPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    script.async = true;
    script.defer = true;
    script.addEventListener("load", resolve);
    script.addEventListener("error", () => reject(new Error("Turnstile konnte nicht geladen werden.")));
    document.head.appendChild(script);
  });
  return turnstileScriptPromise;
}

async function ensureTurnstile(slot) {
  if (!state.authConfig.turnstile?.enabled || !state.authConfig.turnstile?.siteKey || !slot) return;
  slot.classList.remove("hidden");
  try {
    await loadTurnstileScript();
  } catch {
    return;
  }
  if (!window.turnstile) return;
  const existing = state.turnstileWidgets[slot.id];
  if (existing?.widgetId !== undefined) {
    window.turnstile.reset(existing.widgetId);
    existing.token = "";
    return;
  }
  const entry = { widgetId: undefined, token: "" };
  entry.widgetId = window.turnstile.render(slot, {
    sitekey: state.authConfig.turnstile.siteKey,
    callback: (token) => { entry.token = token; },
    "expired-callback": () => { entry.token = ""; },
    "error-callback": () => { entry.token = ""; }
  });
  state.turnstileWidgets[slot.id] = entry;
}

function turnstileToken(slotId) {
  return state.turnstileWidgets[slotId]?.token ?? "";
}

async function loadAuthConfig() {
  try {
    const config = await requestJson("/api/auth/config", { skipSessionReset: true });
    state.authConfig = config ?? state.authConfig;
  } catch {
    state.authConfig = { turnstile: { enabled: false, siteKey: "" } };
  }
}

function showAuthPanel(name) {
  const forms = {
    login: el.loginForm,
    register: el.registerForm,
    forgot: el.forgotPasswordForm,
    reset: el.resetPasswordForm,
    master: el.masterSetupForm
  };
  Object.entries(forms).forEach(([key, form]) => form?.classList.toggle("hidden", key !== name));
  if (name === "login") {
    ensureTurnstile(el.loginTurnstile);
    setTimeout(() => el.loginUsername?.focus(), 0);
  }
  if (name === "register") ensureTurnstile(el.registerTurnstile);
  if (name === "forgot") ensureTurnstile(el.forgotTurnstile);
}

function showLoggedOut() {
  state.currentUser = null;
  state.items = [];
  state.selectedId = null;
  if (el.loginPassword) el.loginPassword.value = "";
  if (el.loginTotp) el.loginTotp.value = "";
  el.loginTotpField?.classList.add("hidden");
  el.appShell?.classList.add("hidden");
  el.authShell?.classList.remove("hidden");
  showAuthPanel("login");
}

function showAuthenticated(user) {
  state.currentUser = user;
  if (el.loginPassword) el.loginPassword.value = "";
  if (el.loginTotp) el.loginTotp.value = "";
  el.sessionUserName.textContent = user?.displayName ?? "-";
  el.sessionUserRole.textContent = user?.role ?? "-";
  el.authShell?.classList.add("hidden");
  el.appShell?.classList.remove("hidden");
  document.body.classList.add("zebra");
}

function isMaster() {
  return state.currentUser?.role === "Master";
}

// Säubert die Bauvorhaben-Beschreibung: entfernt HTML-Reste, ein vorangestelltes
// Rubrik-Label ("Bauvorhaben: …") und angehängten Fremdtext anderer Rubriken
// (Bauherr/Lage/Parzelle …), die beim Import manchmal mit hineinrutschen.
function readableProject(item) {
  let text = normalizeText(item.description || item.projectType || "");
  text = text
    .replace(/<[^>]*>/g, " ")
    .replace(/&(?:nbsp|amp|lt|gt|quot|#0?39|apos);/gi, " ")
    .replace(/^\s*(?:Bauvorhaben|Bauprojekt|Bauobjekt|Projekt)\s*[:.–-]\s*/i, "")
    .replace(
      /\s*(?:Bauherr(?:schaft)?|Grundeigentümer(?:in)?|Eigentümer(?:in)?|Projektverfasser|Bauplatz|Standort|Lage|Parzelle|Auflage(?:frist)?|Publikation|Frist|Einsprache)\s*:.*$/i,
      ""
    );
  text = normalizeText(text).replace(/[\s,;:–-]+$/, "").trim();
  return text || normalizeText(item.projectType) || "Baugesuch";
}

function itemTitle(item) {
  return truncate(readableProject(item), 74);
}

function readableAddress(item) {
  const address = normalizeText(item.address)
    .replace(/\.{2,}\s*\[mehr\].*$/i, "")
    .replace(/\s*\[mehr\].*$/i, "")
    .replace(/\s*(?:Bauherr(?:schaft)?|Grundeigentümer(?:in)?|Projektverfasser|Bauprojekt|Bauvorhaben|Lage):.*$/i, "");
  return address || "Adresse prüfen";
}

function dueMeta(item) {
  const workflow = item.workflowStatus;
  const days = daysUntil(item.deadlineDate);
  if (workflow === "cleared" || workflow === "archived") return { cls: "due-ok", txt: "abgeschlossen", days };
  if (!Number.isFinite(days)) return { cls: "due-soon", txt: "Frist prüfen", days };
  if (days < 0) return { cls: "due-over", txt: `${Math.abs(days)} T. überfällig`, days };
  if (days === 0) return { cls: "due-over", txt: "heute fällig", days };
  if (days <= 5) return { cls: "due-soon", txt: `in ${days} Tagen`, days };
  return { cls: "due-ok", txt: `in ${days} Tagen`, days };
}

function isOverdue(item) {
  // Überfällig = offener Fall mit Frist in der Vergangenheit.
  // Abgeschlossene/archivierte Fälle gelten nicht als überfällig.
  if (item.workflowStatus === "cleared" || item.workflowStatus === "archived") return false;
  const days = daysUntil(item.deadlineDate);
  return Number.isFinite(days) && days < 0;
}

function protectionMeta(item) {
  return PROTECTION[item.protectionStatus] ?? { label: item.protectionStatus || "Unklar", cls: "neutral" };
}

function workflowMeta(item) {
  return WORKFLOW[item.workflowStatus] ?? { label: item.workflowStatus || "Offen", cls: "new" };
}

function matchesTab(item) {
  switch (state.activeTab) {
    case "important":
      return ["combined-hit", "protected-point", "protected-zone"].includes(item.protectionStatus);
    case "manual":
      return item.protectionStatus === "manual-review" || Boolean(item.ambiguousAddress);
    case "open":
      return ["new", "under-review", "escalated"].includes(item.workflowStatus);
    case "due-soon":
      return dueMeta(item).days <= 5 && !["cleared", "archived"].includes(item.workflowStatus);
    case "archive":
      return true;
    case "all":
    default:
      // Standard-Arbeitsliste: ohne Archiv und ohne überfällige Fälle.
      // Überfällige bleiben unter "Alle / Archiv" sichtbar.
      return item.workflowStatus !== "archived" && !isOverdue(item);
  }
}

function matchesFilters(item) {
  if (state.filters.municipality && item.municipality !== state.filters.municipality) return false;
  if (state.filters.protection && item.protectionStatus !== state.filters.protection) return false;
  if (state.filters.workflow && item.workflowStatus !== state.filters.workflow) return false;
  const q = state.filters.search.toLowerCase();
  if (!q) return true;
  const hay = [item.id, item.municipality, readableAddress(item), item.projectType, item.description, item.source]
    .join(" ")
    .toLowerCase();
  return hay.includes(q);
}

function sortableValue(item, key) {
  if (key === "dueDays") return dueMeta(item).days;
  return String(item[key] ?? "").toLowerCase();
}

function visibleItems() {
  return state.items
    .filter((item) => matchesTab(item) && matchesFilters(item))
    .slice()
    .sort((a, b) => {
      const av = sortableValue(a, state.sortKey);
      const bv = sortableValue(b, state.sortKey);
      if (av < bv) return -1 * state.sortDir;
      if (av > bv) return 1 * state.sortDir;
      return String(a.id).localeCompare(String(b.id));
    });
}

function updateTabCounts() {
  const count = (fn) => state.items.filter(fn).length;
  const setCount = (key, value) => {
    const node = $(`[data-count="${key}"]`);
    if (node) node.textContent = String(value);
  };
  setCount("all", count((item) => item.workflowStatus !== "archived" && !isOverdue(item)));
  setCount("important", count((item) => ["combined-hit", "protected-point", "protected-zone"].includes(item.protectionStatus)));
  setCount("manual", count((item) => item.protectionStatus === "manual-review" || Boolean(item.ambiguousAddress)));
  setCount("due-soon", count((item) => dueMeta(item).days <= 5 && !["cleared", "archived"].includes(item.workflowStatus)));
  el.navWorkCount.textContent = String(count((item) => item.workflowStatus !== "archived" && !isOverdue(item)));
}

function renderMunicipalityOptions() {
  const selected = state.filters.municipality;
  const municipalities = new Set(state.dashboard?.municipalities ?? []);
  state.items.forEach((item) => municipalities.add(item.municipality));
  const options = [...municipalities].filter(Boolean).sort((a, b) => a.localeCompare(b, "de-CH"));
  el.fltMun.innerHTML = `<option value="">Alle Gemeinden</option>${options
    .map((municipality) => `<option value="${escapeHtml(municipality)}">${escapeHtml(municipality)}</option>`)
    .join("")}`;
  el.fltMun.value = selected;
}

function renderTable() {
  const rows = visibleItems();
  el.activeFilterText.textContent = TAB_SUB[state.activeTab] ?? TAB_SUB.all;
  el.resultCount.textContent = `${rows.length} Baugesuch${rows.length === 1 ? "" : "e"}`;

  if (!rows.length) {
    el.tbody.innerHTML = `<tr><td colspan="5"><div class="empty-state">
      <h4>Keine Baugesuche gefunden</h4>
      <p>Filter zurücksetzen oder einen anderen Reiter wählen.</p>
      <button class="btn ghost" type="button" data-reset-empty>Filter zurücksetzen</button>
    </div></td></tr>`;
    return;
  }

  el.tbody.innerHTML = rows
    .map((item) => {
      const protection = protectionMeta(item);
      const workflow = workflowMeta(item);
      const due = dueMeta(item);
      const selected = item.id === state.selectedId ? " selected" : "";
      const urgency = due.cls === "due-over" ? " urg-over" : due.cls === "due-soon" ? " urg-soon" : "";
      return `<tr tabindex="0" data-id="${escapeHtml(item.id)}" class="${selected}${urgency}">
        <td><span class="cell-mun">${escapeHtml(item.municipality || "-")}</span><span class="cell-mun-sub">${escapeHtml(item.source || "Baugesuch")}</span></td>
        <td><span class="cell-app-title">${escapeHtml(itemTitle(item))}</span><span class="cell-app-sub">${escapeHtml(readableAddress(item))}</span></td>
        <td><span class="hit ${protection.cls}">${escapeHtml(protection.label)}</span></td>
        <td><span class="cell-due">${escapeHtml(formatDate(item.deadlineDate))}</span><span class="cell-due-meta ${due.cls}">${escapeHtml(due.txt)}</span></td>
        <td><span class="cell-status-wrap"><span class="wf ${workflow.cls}">${escapeHtml(workflow.label)}</span><span class="row-go"><svg class="row-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="m9 6 6 6-6 6" stroke-linecap="round" stroke-linejoin="round"/></svg></span></span></td>
      </tr>`;
    })
    .join("");
}

function recommendationTitle(item) {
  switch (item.protectionStatus) {
    case "combined-hit":
      return "Eingehende Prüfung erforderlich";
    case "protected-point":
      return "Geschütztes Einzelobjekt betroffen";
    case "protected-zone":
      return "Lage in Schutzzone";
    case "manual-review":
      return "Manuelle Klärung nötig";
    case "no-hit":
      return "Keine denkmalrechtliche Betroffenheit";
    default:
      return "Prüfung vorbereiten";
  }
}

function recommendationText(item) {
  if (item.automatedAssessment) return item.automatedAssessment;
  if (item.protectionStatus === "no-hit") {
    return "Die automatische Prüfung hat keinen Schutztreffer gefunden. Bei unvollständigen Adressdaten kurz plausibilisieren.";
  }
  if (item.protectionStatus === "manual-review") {
    return "Die Adresse oder Quelle ist nicht eindeutig genug für eine automatische Zuordnung. Unterlagen und Gemeindequelle manuell prüfen.";
  }
  return "Schutztreffer vorhanden. Eingriff, Sichtbarkeit und Schutzumfang vor Bewilligung fachlich prüfen.";
}

function normalizeLayerName(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replaceAll("\u00df", "ss")
    .toLowerCase();
}

function parseSwissCoordinates(value) {
  const text = normalizeText(value).replace(/[']/g, "");
  const numbers = text.match(/\d{6,7}(?:\.\d+)?/g)?.map(Number) ?? [];

  if (numbers.length < 2 || !Number.isFinite(numbers[0]) || !Number.isFinite(numbers[1])) {
    return null;
  }

  const [firstValue, secondValue] = numbers;
  const looksLikeLv95East = (entry) => entry >= 2400000 && entry <= 2900000;
  const looksLikeLv95North = (entry) => entry >= 1000000 && entry <= 1400000;

  if (looksLikeLv95East(firstValue) && looksLikeLv95North(secondValue)) {
    return { east: firstValue, north: secondValue };
  }

  if (looksLikeLv95North(firstValue) && looksLikeLv95East(secondValue)) {
    return { east: secondValue, north: firstValue };
  }

  return { east: firstValue, north: secondValue };
}

function hasStreetLikeAddress(item) {
  const value = normalizeText(item?.address ?? "");
  if (!value || /^parzelle\b/i.test(value)) return false;
  return /\d/.test(value) || /\b(strasse|weg|gasse|platz|rain|hof|dorf|allee|ring|matt|halde)\b/i.test(value);
}

function hasExactAddressWithoutCoordinates(item) {
  return Boolean(item?.ambiguousAddress) && hasStreetLikeAddress(item) && !parseSwissCoordinates(item?.coordinates ?? "");
}

function hasProtectedBuilding(item) {
  const normalizedLayers = (item.agisLayers ?? []).map((layer) => normalizeLayerName(layer));
  return (
    item.protectionStatus === "protected-point" ||
    item.protectionStatus === "combined-hit" ||
    normalizedLayers.some((layer) => layer.includes("inventar") || layer.includes("gebaude"))
  );
}

function hasProtectedArea(item) {
  const normalizedLayers = (item.agisLayers ?? []).map((layer) => normalizeLayerName(layer));
  return (
    item.protectionStatus === "protected-zone" ||
    item.protectionStatus === "combined-hit" ||
    normalizedLayers.some((layer) => layer.includes("isos") || layer.includes("ortsbild") || layer.includes("umgebung"))
  );
}

function buildAgisDataLink(item) {
  const coordinates = parseSwissCoordinates(item.coordinates);
  if (!coordinates) return null;

  const url = new URL(ONLINEKARTEN_URL);
  const activeLayers = [ONLINEKARTEN_LAYERS.area, ONLINEKARTEN_LAYERS.point].join("|");
  url.searchParams.set("layers", activeLayers);
  url.searchParams.set("basemap", ONLINEKARTEN_BASEMAP);
  url.searchParams.set("center", `${coordinates.east.toFixed(2)},${coordinates.north.toFixed(2)}`);
  url.searchParams.set("z", hasProtectedBuilding(item) ? "11" : "10");
  url.searchParams.set(
    "info",
    `${coordinates.east.toFixed(2)},${coordinates.north.toFixed(2)},${ONLINEKARTEN_IDENTIFY_TOLERANCE}`
  );
  return url.toString();
}

function buildDataLinkLabel(item) {
  if (hasProtectedBuilding(item)) return "Inventar-Karte mit Standort öffnen";
  if (hasProtectedArea(item)) return "Ortsbild-Karte mit Standort öffnen";
  return "AGIS-Karte mit Standort öffnen";
}

function formatSwissCoordinates(coordinates) {
  const numberFormatter = new Intl.NumberFormat("de-CH");
  return `Koordinaten: ${numberFormatter.format(coordinates.east)} / ${numberFormatter.format(coordinates.north)}`;
}

function swissToLatLng(coordinates) {
  if (!window.proj4) return null;

  if (!mapState.projectionReady) {
    window.proj4.defs(
      "EPSG:2056",
      "+proj=somerc +lat_0=46.95240555555556 +lon_0=7.439583333333333 +k_0=1 +x_0=2600000 +y_0=1200000 +ellps=bessel +towgs84=674.374,15.056,405.346,0,0,0,0 +units=m +no_defs +type=crs"
    );
    mapState.projectionReady = true;
  }

  const [longitude, latitude] = window.proj4("EPSG:2056", "WGS84", [coordinates.east, coordinates.north]);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;

  const isInsideSwissBounds = latitude >= 45 && latitude <= 48.5 && longitude >= 5 && longitude <= 11;
  return isInsideSwissBounds ? { latitude, longitude } : null;
}

function swissPairToLatLng(pair) {
  const east = Number(pair?.[0]);
  const north = Number(pair?.[1]);
  if (!Number.isFinite(east) || !Number.isFinite(north)) return null;
  const position = swissToLatLng({ east, north });
  return position ? [position.latitude, position.longitude] : null;
}

function swissRingToLatLngs(ring) {
  return (ring ?? []).map((pair) => swissPairToLatLng(pair)).filter(Boolean);
}

function swissPolygonPartsToLatLngs(parts) {
  return (parts ?? [])
    .map((polygon) => polygon.map((ring) => swissRingToLatLngs(ring)).filter((ring) => ring.length >= 3))
    .filter((polygon) => polygon.length > 0);
}

function buildAreaPopup(feature) {
  const title = feature.properties?.title?.trim();
  const lines = [];
  if (feature.properties?.layerLabel) lines.push(`<strong>${escapeHtml(feature.properties.layerLabel)}</strong>`);
  if (title) lines.push(escapeHtml(title));
  if (feature.properties?.category) lines.push(`Kategorie: ${escapeHtml(feature.properties.category)}`);
  if (feature.properties?.significance) lines.push(`Bedeutung: ${escapeHtml(feature.properties.significance)}`);
  if (feature.properties?.preservationTarget) lines.push(`Erhaltungsziel: ${escapeHtml(feature.properties.preservationTarget)}`);
  return lines.join("<br>");
}

function buildPointPopup(feature) {
  const title = feature.properties?.title?.trim();
  const lines = [];
  if (feature.properties?.layerLabel) lines.push(`<strong>${escapeHtml(feature.properties.layerLabel)}</strong>`);
  if (title) lines.push(escapeHtml(title));
  if (feature.properties?.municipality || feature.properties?.address) {
    const placeText = [feature.properties?.municipality, feature.properties?.address].filter(Boolean).join(", ");
    lines.push(escapeHtml(placeText));
  }
  if (feature.properties?.reference) lines.push(`Referenz: ${escapeHtml(feature.properties.reference)}`);
  return lines.join("<br>");
}

function getCssVariable(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function ensureMap() {
  if (mapState.instance || !el.detailMap || !window.L) return mapState.instance;

  mapState.instance = window.L.map(el.detailMap, {
    zoomControl: false,
    scrollWheelZoom: false
  });
  window.L.control.zoom({ position: "bottomright" }).addTo(mapState.instance);
  window.L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "&copy; OpenStreetMap"
  }).addTo(mapState.instance);
  mapState.marker = window.L.marker([47.3925, 8.0442], {
    icon: createLocationMarkerIcon()
  }).addTo(mapState.instance);
  mapState.overlayGroup = window.L.featureGroup().addTo(mapState.instance);
  return mapState.instance;
}

function createLocationMarkerIcon() {
  if (!window.L) return null;
  return window.L.divIcon({
    className: "custom-map-marker location-marker",
    html: '<span class="map-pin location"></span>',
    iconSize: [28, 28],
    iconAnchor: [14, 28],
    popupAnchor: [0, -22]
  });
}

function clearMapOverlays() {
  mapState.overlayGroup?.clearLayers();
}

function getAreaLayerStyle(layerKey) {
  switch (layerKey) {
    case "municipality-zone":
      return { color: "#4b8b58", fillColor: "#8fd38e", fillOpacity: 0.2, weight: 1.6 };
    case "zone-part":
      return { color: "#7e63a8", fillColor: "#c6b3e8", fillOpacity: 0.28, weight: 1.8 };
    case "hint-zone":
      return { color: "#5d2d82", fillColor: "#8a52b4", fillOpacity: 0.36, weight: 1.8 };
    case "perimeter-zone":
      return { color: "#8a7b63", fillColor: "#d8cfbc", fillOpacity: 0.18, weight: 1.4, dashArray: "6 4" };
    default:
      return {
        color: getCssVariable("--map-area-stroke"),
        fillColor: getCssVariable("--map-area-fill"),
        fillOpacity: 0.24,
        weight: 2
      };
  }
}

function getAreaLayerLegendLabel(layerKey) {
  switch (layerKey) {
    case "municipality-zone":
      return "Ortsbild in der Gemeinde";
    case "zone-part":
      return "Ortsbildteile";
    case "hint-zone":
      return "Hinweiszonen";
    case "perimeter-zone":
      return "PDF-Perimeter";
    default:
      return "Schutzzone";
  }
}

function getLegendSwatchClass(layerKey) {
  switch (layerKey) {
    case "municipality-zone":
      return "municipality";
    case "zone-part":
      return "part";
    case "hint-zone":
      return "hint";
    case "perimeter-zone":
      return "perimeter";
    default:
      return "area";
  }
}

function renderMapLegend(features) {
  if (!el.mapLegend) return;
  const items = ['<span class="map-legend-item"><span class="map-legend-swatch location"></span><span>Standort</span></span>'];

  if (features.points) {
    items.push('<span class="map-legend-item"><span class="map-legend-swatch point"></span><span>Inventarobjekte</span></span>');
  }

  for (const layerKey of features.areaLayerKeys) {
    items.push(
      `<span class="map-legend-item"><span class="map-legend-swatch ${getLegendSwatchClass(layerKey)}"></span><span>${escapeHtml(
        getAreaLayerLegendLabel(layerKey)
      )}</span></span>`
    );
  }

  el.mapLegend.innerHTML = items.join("");
  el.mapLegend.classList.toggle("hidden", items.length === 0);
}

function buildMapOverlays(officialFeatures, markerLatLng) {
  const map = ensureMap();
  const areaFeatures = Array.isArray(officialFeatures.areaFeatures) ? officialFeatures.areaFeatures : [];
  const pointFeatures = Array.isArray(officialFeatures.pointFeatures) ? officialFeatures.pointFeatures : [];
  const displayAreaFeatures =
    Array.isArray(officialFeatures.displayAreaFeatures) && officialFeatures.displayAreaFeatures.length > 0
      ? officialFeatures.displayAreaFeatures
      : areaFeatures;
  const displayPointFeatures =
    Array.isArray(officialFeatures.displayPointFeatures) && officialFeatures.displayPointFeatures.length > 0
      ? officialFeatures.displayPointFeatures
      : pointFeatures;
  const features = {
    area: displayAreaFeatures.length > 0,
    points: displayPointFeatures.length > 0,
    matchedArea: areaFeatures.length > 0,
    matchedPoints: pointFeatures.length > 0,
    areaLayerKeys: [...new Set(displayAreaFeatures.map((feature) => feature.properties?.layerKey).filter(Boolean))]
  };
  const layersForBounds = [mapState.marker];

  clearMapOverlays();

  for (const areaFeature of displayAreaFeatures) {
    const latLngParts = swissPolygonPartsToLatLngs(areaFeature.parts);
    if (latLngParts.length === 0) continue;

    const polygon = window.L.polygon(
      latLngParts.length === 1 ? latLngParts[0] : latLngParts,
      getAreaLayerStyle(areaFeature.properties?.layerKey)
    );
    const popup = buildAreaPopup(areaFeature);
    if (popup) polygon.bindPopup(popup);
    mapState.overlayGroup.addLayer(polygon);
    layersForBounds.push(polygon);
  }

  for (const pointFeature of displayPointFeatures) {
    const position = swissToLatLng({
      east: pointFeature.coordinates?.[0],
      north: pointFeature.coordinates?.[1]
    });
    if (!position) continue;

    const point = window.L.circleMarker([position.latitude, position.longitude], {
      radius: 7,
      color: getCssVariable("--map-point-stroke"),
      fillColor: getCssVariable("--map-point-fill"),
      fillOpacity: 0.92,
      weight: 2
    });
    const popup = buildPointPopup(pointFeature);
    if (popup) point.bindPopup(popup);
    mapState.overlayGroup.addLayer(point);
    layersForBounds.push(point);
  }

  const boundsGroup = window.L.featureGroup(layersForBounds);
  if (boundsGroup.getBounds().isValid()) {
    map.fitBounds(boundsGroup.getBounds(), {
      padding: [28, 28],
      animate: false,
      maxZoom: 17
    });
  } else {
    map.setView(markerLatLng, 17, { animate: false });
  }

  return features;
}

function describeMapFeatures(features) {
  if (features.matchedArea && features.matchedPoints) return "Direkter AGIS-Treffer: Zonen und Inventarobjekte markiert";
  if (features.matchedArea) return "Direkter AGIS-Zonentreffer markiert";
  if (features.matchedPoints) return "Direkter Inventartreffer markiert";
  if (features.area || features.points) return "Amtliche Schutzlayer in der Umgebung eingeblendet";
  return "Auf der Karte wurde kein AGIS-Treffer gefunden";
}

function updateMapNote(_officialFeatures, features) {
  if (!el.mapSymbolHint) return;
  if (!features.area && !features.points) {
    el.mapSymbolHint.classList.add("hidden");
    el.mapSymbolHint.textContent = "";
    return;
  }

  const areaNote = features.areaLayerKeys.length > 0 ? "Grün/Lila = amtliche Schutzzonen" : "";
  const pointNote = features.points ? "Rot = Inventarobjekte" : "";
  const parts = ["Blau = Baugesuch", pointNote, areaNote].filter(Boolean);
  el.mapSymbolHint.textContent = parts.join(" · ");
  el.mapSymbolHint.classList.remove("hidden");
}

async function requestOfficialMapFeatures(coordinates) {
  const params = new URLSearchParams({
    east: String(coordinates.east),
    north: String(coordinates.north)
  });
  return requestJson(`/api/agis/features?${params.toString()}`);
}

function showMapFallback(message, status) {
  el.mapStatus.textContent = status;
  el.detailMap?.classList.add("hidden");
  if (el.mapFallback) {
    el.mapFallback.textContent = message;
    el.mapFallback.classList.remove("hidden");
  }
  if (el.mapLegend) {
    el.mapLegend.classList.add("hidden");
    el.mapLegend.innerHTML = "";
  }
  if (el.mapSymbolHint) {
    el.mapSymbolHint.classList.add("hidden");
    el.mapSymbolHint.textContent = "";
  }
  clearMapOverlays();
}

async function updateMap(item) {
  mapState.requestToken += 1;
  const requestToken = mapState.requestToken;

  if (!item) {
    showMapFallback("Wählen Sie ein Baugesuch aus, um den Standort zu sehen.", "Noch kein Standort gewählt");
    return;
  }

  const parsedCoordinates = parseSwissCoordinates(item.coordinates);
  if (item.ambiguousAddress || !parsedCoordinates) {
    const hasExactAddress = hasExactAddressWithoutCoordinates(item);
    showMapFallback(
      hasExactAddress
        ? "Die Adresse ist vorhanden, wurde aber nicht automatisch im amtlichen Adressregister gefunden. Bitte Standort kurz prüfen."
        : "Für dieses Gesuch gibt es noch keinen genauen Standort. Bitte Adresse oder Parzelle von Hand prüfen.",
      hasExactAddress ? "Adresse nicht automatisch gefunden" : "Standort muss von Hand geklärt werden"
    );
    return;
  }

  const position = swissToLatLng(parsedCoordinates);
  if (!position) {
    showMapFallback(
      "Die Karte konnte im Moment nicht geladen werden. Die restlichen Angaben stehen trotzdem bereit.",
      "Karte vorübergehend nicht verfügbar"
    );
    return;
  }

  const map = ensureMap();
  if (!map || !mapState.marker) {
    showMapFallback(
      "Die Karte konnte im Moment nicht geladen werden. Die restlichen Angaben stehen trotzdem bereit.",
      "Karte vorübergehend nicht verfügbar"
    );
    return;
  }

  const latLng = [position.latitude, position.longitude];
  el.mapStatus.textContent = `Standort wird angezeigt · ${formatSwissCoordinates(parsedCoordinates)}`;
  el.mapFallback?.classList.add("hidden");
  el.detailMap?.classList.remove("hidden");
  mapState.marker.setIcon(createLocationMarkerIcon());
  mapState.marker.setLatLng(latLng).bindPopup(`<strong>${escapeHtml(item.municipality)}</strong><br>${escapeHtml(item.address)}`);
  map.setView(latLng, 17, { animate: false });
  clearMapOverlays();
  el.mapLegend?.classList.add("hidden");
  if (el.mapLegend) el.mapLegend.innerHTML = "";
  el.mapSymbolHint?.classList.add("hidden");
  if (el.mapSymbolHint) el.mapSymbolHint.textContent = "";
  el.mapStatus.textContent = "AGIS-Treffer werden geladen";

  try {
    const officialFeatures = await requestOfficialMapFeatures(parsedCoordinates);
    if (requestToken !== mapState.requestToken) return;

    const features = buildMapOverlays(officialFeatures, latLng);
    el.mapStatus.textContent = describeMapFeatures(features);
    renderMapLegend(features);
    updateMapNote(officialFeatures, features);
  } catch {
    if (requestToken !== mapState.requestToken) return;
    clearMapOverlays();
    el.mapLegend?.classList.add("hidden");
    if (el.mapLegend) el.mapLegend.innerHTML = "";
    el.mapStatus.textContent = "AGIS-Daten momentan nicht verfügbar";
    if (el.mapSymbolHint) {
      el.mapSymbolHint.textContent = "";
      el.mapSymbolHint.classList.add("hidden");
    }
  }

  requestAnimationFrame(() => map.invalidateSize());
}

function agisHref(item) {
  return buildAgisDataLink(item) || ONLINEKARTEN_URL;
}

function renderTimeline(item) {
  const rankMap = { new: 2, "under-review": 2, escalated: 2, cleared: 4, archived: 4 };
  const rank = rankMap[item.workflowStatus] ?? 1;
  const due = dueMeta(item);
  const steps = [
    { title: "Eingegangen", meta: `Publiziert ${formatDate(item.publicationDate)}` },
    { title: "AGIS-Prüfung", meta: item.agisMatch || protectionMeta(item).label },
    { title: "Fachprüfung", meta: item.workflowStatus === "new" ? "Zuständigkeit offen" : (item.assignee || "im Team") },
    { title: "Entscheiden", meta: due.txt }
  ];
  el.timeline.innerHTML = steps
    .map((step, index) => {
      let cls = "pending";
      if (index + 1 < rank) cls = "done";
      else if (index + 1 === rank) cls = "current";
      return `<div class="tl-step ${cls}"><div class="tl-rail"><span class="tl-node"></span><span class="tl-line"></span></div>
        <div class="tl-body"><div class="tl-t">${escapeHtml(step.title)}</div><div class="tl-m">${escapeHtml(step.meta)}</div></div></div>`;
    })
    .join("");
}

function renderComments() {
  el.commentCount.textContent = String(state.comments.length);
  if (!state.comments.length) {
    el.commentsList.innerHTML = `<p class="src-meta">Noch keine Team-Kommentare.</p>`;
    return;
  }
  el.commentsList.innerHTML = state.comments
    .map((comment) => {
      const own = comment.userId === state.currentUser?.id ? " own" : "";
      return `<div class="comment${own}">
        <div class="comment-meta"><span><strong>${escapeHtml(comment.userDisplayName || "Team")}</strong><span class="role">${escapeHtml(comment.userRole || "")}</span></span><time>${escapeHtml(formatDateTime(comment.createdAt))}</time></div>
        <p>${escapeHtml(comment.message)}</p>
      </div>`;
    })
    .join("");
}

function renderDetail() {
  const item = state.items.find((entry) => entry.id === state.selectedId) ?? null;
  if (!item) {
    el.detailEmpty.classList.remove("hidden");
    el.detailBody.classList.add("hidden");
    el.detailStatusBadge.textContent = "Keine Auswahl";
    el.detailHelper.textContent = "Entscheidung, Karte und interne Bearbeitung.";
    return;
  }

  const protection = protectionMeta(item);
  const due = dueMeta(item);
  el.detailEmpty.classList.add("hidden");
  el.detailBody.classList.remove("hidden");
  el.detailStatusBadge.innerHTML = `<span class="hit ${protection.cls}">${escapeHtml(protection.label)}</span>`;
  el.detailHelper.textContent = `${item.id} · ${item.municipality || "-"}`;
  el.fMun.textContent = item.municipality || "-";
  el.fAddr.textContent = readableAddress(item);
  el.fParcel.textContent = item.parcel || "-";
  el.fPub.textContent = formatDate(item.publicationDate);
  el.fDue.innerHTML = `${escapeHtml(formatDate(item.deadlineDate))} <span class="cell-due-meta ${due.cls}" style="display:inline">· ${escapeHtml(due.txt)}</span>`;
  el.fAgis.textContent = item.agisMatch || protection.label;
  el.fProject.textContent = readableProject(item);
  el.agisLink.href = agisHref(item);
  el.agisLink.textContent = buildDataLinkLabel(item);
  el.recTitle.textContent = recommendationTitle(item);
  el.recText.textContent = recommendationText(item);
  el.recBadge.className = `badge ${protection.cls}`;
  el.recBadge.textContent = protection.label;
  el.dueBadge.className = `badge ${due.cls === "due-over" ? "danger" : due.cls === "due-soon" ? "warning" : "neutral"}`;
  el.dueBadge.textContent = `Frist ${formatDate(item.deadlineDate)} · ${due.txt}`;
  el.srcMeta.textContent = `Quelle: ${item.source || "unbekannt"}${item.sourceReference ? ` · ${item.sourceReference}` : ""}`;
  el.fWorkflow.value = item.workflowStatus in WORKFLOW ? item.workflowStatus : "new";
  el.fAssignee.value = item.assignee || "";
  el.fNote.value = item.note || "";
  renderTimeline(item);
  updateMap(item);
}

async function loadComments(applicationId) {
  if (!applicationId) return;
  el.commentsList.innerHTML = `<p class="src-meta">Team-Kommentare werden geladen.</p>`;
  try {
    const payload = await requestJson(`/api/applications/${encodeURIComponent(applicationId)}/comments`);
    if (state.selectedId !== applicationId) return;
    state.comments = payload.items ?? [];
    renderComments();
  } catch (error) {
    el.commentsList.innerHTML = `<p class="src-meta">${escapeHtml(error.message)}</p>`;
  }
}

function selectItem(id) {
  state.selectedId = id;
  renderTable();
  renderDetail();
  loadComments(id);
}

function renderDashboard() {
  const dashboard = state.dashboard ?? {};
  const summary = dashboard.municipalitySourcesSummary ?? state.sourceSummary ?? {};
  const sync = dashboard.syncStatus ?? state.syncStatus ?? {};
  const job = sync.job ?? {};
  const lastSync = job.lastSuccessAt || job.lastRunAt;
  const workMeta = $$("#view-work .titleband-meta .band-chip");
  if (workMeta[0]) workMeta[0].innerHTML = `<span class="dot"></span>Letzter Sync: <b>${escapeHtml(lastSync ? formatDateTime(lastSync) : "noch offen")}</b>`;
  if (workMeta[1]) workMeta[1].innerHTML = `Import: <b>${escapeHtml(sync.sourceLabel || "Gemeindequellen")}</b>`;
  if (workMeta[2]) workMeta[2].innerHTML = `Gemeindequellen: <b>${escapeHtml(`${summary.enabledCount ?? 0}/${summary.totalCount ?? 0}`)}</b>`;

  const adminMeta = $$("#view-admin .titleband-meta .band-chip");
  if (adminMeta[0]) adminMeta[0].innerHTML = `<span class="dot"></span>${sync.enabled === false ? "System pausiert" : "System aktiv"}`;
  if (adminMeta[1]) adminMeta[1].innerHTML = `Nächster Import: <b>${escapeHtml(job.nextRunAt ? formatDateTime(job.nextRunAt) : "noch nicht geplant")}</b>`;
}

function renderSourceStats() {
  const summary = state.sourceSummary ?? state.dashboard?.municipalitySourcesSummary ?? {};
  const report = state.sourceReport ?? {};
  const total = report.totalMunicipalities ?? summary.totalCount ?? 0;
  const enabled = summary.enabledCount ?? 0;
  const high = report.ratings?.A ?? summary.digitalCount ?? 0;
  const warn = report.uncertainMunicipalities ?? 0;
  const missing = Math.max(0, total - (summary.configuredCount ?? 0));
  const statRow = $("#pane-sources .stat-row");
  if (!statRow) return;
  const pct = total ? Math.round((enabled / total) * 100) : 0;
  statRow.innerHTML = `
    <div class="stat"><p class="k">Gemeinden total</p><p class="v">${escapeHtml(total)}</p><p class="d mut">Kanton Aargau</p></div>
    <div class="stat"><p class="k">Quelle aktiv</p><p class="v">${escapeHtml(enabled)}<small> /${escapeHtml(total)}</small></p><div class="progress"><span style="width:${pct}%"></span></div></div>
    <div class="stat"><p class="k">Datenqualität Ø</p><p class="v">${high ? "Hoch" : "Offen"}</p><p class="d up">${escapeHtml(high)} strukturiert</p></div>
    <div class="stat"><p class="k">Wartung nötig</p><p class="v">${escapeHtml(warn)}</p><p class="d warn">Quelle prüfen</p></div>
    <div class="stat"><p class="k">Ohne Quelle</p><p class="v">${escapeHtml(missing)}</p><p class="d mut">manuell erfassen</p></div>`;
  const railCount = $('[data-pane="sources"] .rc');
  if (railCount) railCount.textContent = String(total);
}

function qualityMeta(source) {
  const rating = source.rating ?? (source.enabled ? "B" : "D");
  if (rating === "A") return { level: 3, cls: "q-hi", label: "Hoch", note: source.rationale || "Strukturiert, vollständig" };
  if (rating === "B") return { level: 2, cls: "q-mid", label: "Mittel", note: source.rationale || "Teilfelder fehlen" };
  if (rating === "C") return { level: 1, cls: "q-low", label: "Gering", note: source.rationale || "Quelle prüfen" };
  return { level: 0, cls: "q-none", label: "Keine", note: source.rationale || "Keine Quelle hinterlegt" };
}

function sourceRows() {
  const byOperationalId = new Map(state.municipalitySources.map((source) => [source.id, source]));
  const catalog = state.sourceCatalog.length
    ? state.sourceCatalog
    : state.municipalitySources.map((source) => ({
        operationalId: source.id,
        municipality: source.municipality,
        sourceType: source.sourceType,
        enabled: source.enabled,
        digitalStatus: source.digitalStatus,
        primarySourceName: source.sourceUrl || "Quelle",
        primaryDirectUrl: source.sourceUrl,
        rating: source.enabled ? "B" : "D",
        rationale: source.notes
      }));
  const q = state.sourceSearch.toLowerCase();
  return catalog
    .filter((source) => !q || [source.municipality, source.primarySourceName, source.rationale].join(" ").toLowerCase().includes(q))
    .map((source) => ({ ...source, operational: byOperationalId.get(source.operationalId) }))
    .sort((a, b) => String(a.municipality).localeCompare(String(b.municipality), "de-CH"));
}

function sparkSVG(source, hits) {
  const seedText = source.municipality || "Aargau";
  let seed = 0;
  for (const char of seedText) seed = (seed * 31 + char.charCodeAt(0)) % 9973;
  const values = Array.from({ length: 7 }, (_, index) => Math.max(0, Math.round((hits || 1) * (0.45 + ((seed + index * 17) % 60) / 100))));
  const max = Math.max(1, ...values);
  const width = 78;
  const height = 26;
  const pad = 3;
  const points = values.map((value, index) => [pad + index * ((width - pad * 2) / 6), height - pad - (value / max) * (height - pad * 2)]);
  const line = points.map((point, index) => `${index ? "L" : "M"}${point[0].toFixed(1)} ${point[1].toFixed(1)}`).join(" ");
  const area = `M${pad} ${height - pad} ${points.map((point) => `L${point[0].toFixed(1)} ${point[1].toFixed(1)}`).join(" ")} L${width - pad} ${height - pad} Z`;
  return `<svg class="spark" viewBox="0 0 ${width} ${height}" aria-hidden="true"><path class="ar" d="${area}"/><path class="ln" d="${line}"/></svg>`;
}

function renderSources() {
  renderSourceStats();
  if (!isMaster()) {
    el.srcBody.innerHTML = `<tr><td colspan="8"><div class="empty-state"><h4>Nur Master-Konto</h4><p>Gemeindequellen und Zugriffsschlüssel sind nur mit Master-Rechten bearbeitbar.</p></div></td></tr>`;
    return;
  }
  const rows = sourceRows();
  const hitsByMunicipality = new Map();
  state.items.forEach((item) => hitsByMunicipality.set(item.municipality, (hitsByMunicipality.get(item.municipality) ?? 0) + 1));

  el.srcBody.innerHTML = rows
    .map((source) => {
      const quality = qualityMeta(source);
      const operational = source.operational ?? {};
      const hits = hitsByMunicipality.get(source.municipality) ?? 0;
      const status = source.enabled ? (source.uncertain ? ["warn", "Verzögert"] : ["ok", "Aktiv"]) : ["off", "Keine Quelle"];
      const bars = [1, 2, 3].map((index) => `<span class="qbar ${index <= quality.level ? "on" : ""}"></span>`).join("");
      return `<tr>
        <td><div class="adm-name">${escapeHtml(source.municipality)}</div><div class="adm-sub">${escapeHtml(source.primarySourceOperator || "Region Aargau")}</div></td>
        <td>${escapeHtml(SOURCE_TYPE[source.sourceType] ?? source.sourceType ?? "-")}</td>
        <td><div class="qmeter ${quality.cls}"><span class="qbars">${bars}</span><span class="qlabel">${escapeHtml(quality.label)}</span></div><div class="adm-sub">${escapeHtml(quality.note)}</div></td>
        <td><div class="spark-wrap">${sparkSVG(source, hits)}<span class="spark-sum">${escapeHtml(hits)}<small>diese Woche</small></span></div></td>
        <td class="adm-sub" style="font-size:.84rem">${escapeHtml(formatDateTime(operational.updatedAt))}</td>
        <td><span class="adm-name">${escapeHtml(hits)}</span></td>
        <td><span class="pill ${status[0]}">${escapeHtml(status[1])}</span></td>
        <td style="text-align:right"><span class="row-actions">
          <button class="icon-btn" title="Quelle öffnen" data-source-open="${escapeHtml(source.primaryDirectUrl || operational.sourceUrl || "")}">↗</button>
          <button class="icon-btn" title="Bearbeiten" data-source-edit="${escapeHtml(source.operationalId || operational.id || "")}">✎</button>
        </span></td>
      </tr>`;
    })
    .join("");
}

function renderImportPane() {
  const sync = state.syncStatus ?? state.dashboard?.syncStatus ?? {};
  const job = sync.job ?? {};
  const statRow = $("#pane-import .stat-row");
  const protectionHits = state.items.filter((item) => item.protectionStatus && item.protectionStatus !== "no-hit").length;
  const statusLabel = job.status === "error" ? "Fehler" : job.status === "success" ? "Erfolgreich" : job.status ? job.status : "Bereit";
  const nextRunLabel = job.nextRunAt ? formatDateTime(job.nextRunAt) : "Noch nicht geplant";
  if (statRow) {
    statRow.innerHTML = `
      <div class="stat"><p class="k">Letzter Lauf</p><p class="v" style="font-size:1.25rem">${escapeHtml(formatDateTime(job.lastSuccessAt || job.lastRunAt))}</p><p class="d ${job.status === "error" ? "warn" : "up"}">${escapeHtml(statusLabel)}</p></div>
      <div class="stat"><p class="k">Neue Baugesuche</p><p class="v">${escapeHtml(job.lastImportedCount ?? 0)}</p><p class="d up">letzter Import</p></div>
      <div class="stat"><p class="k">AGIS-Treffer</p><p class="v">${escapeHtml(protectionHits)}</p><p class="d warn">zu prüfen</p></div>
      <div class="stat"><p class="k">Fehlerquellen</p><p class="v">${job.lastError ? "1" : "0"}</p><p class="d ${job.lastError ? "warn" : "mut"}">${escapeHtml(job.lastError ? truncate(job.lastError, 38) : "keine")}</p></div>`;
  }
  el.runList.innerHTML = `
    <div class="run-item"><span class="run-dot ${job.status === "error" ? "err" : "ok"}"></span><div class="run-main"><div class="t">${escapeHtml(sync.sourceLabel || "Gemeindequellen")}</div><div class="m">Letzter Lauf: ${escapeHtml(formatDateTime(job.lastRunAt))}</div></div><div class="run-num"><div class="n">${escapeHtml(job.lastImportedCount ?? 0)}</div><div class="u">Importe</div></div></div>
    <div class="run-item"><span class="run-dot run-now"></span><div class="run-main"><div class="t">Nächster geplanter Lauf</div><div class="m">${escapeHtml(nextRunLabel)}</div></div><div class="run-num"><div class="n">${escapeHtml(sync.intervalHours ?? 168)}</div><div class="u">Std.</div></div></div>`;
}

function renderKeys() {
  if (!isMaster()) {
    el.keysBody.innerHTML = `<tr><td colspan="6"><div class="empty-state"><h4>Nur Master-Konto</h4><p>Zugänge und Registrierungsschlüssel sind nur mit Master-Rechten sichtbar.</p></div></td></tr>`;
    return;
  }
  const userRows = state.adminUsers.map((user) => `<tr>
    <td><div class="adm-name">${escapeHtml(user.displayName)}</div><div class="adm-sub">${escapeHtml(user.username || "")}</div></td>
    <td>${escapeHtml(user.role || "-")}</td>
    <td class="mono">Benutzerkonto</td>
    <td class="adm-sub" style="font-size:.84rem">${escapeHtml(formatDateTime(user.lastLoginAt || user.updatedAt || user.createdAt))}</td>
    <td><span class="pill ok">Aktiv</span></td>
    <td style="text-align:right"><span class="row-actions"><button class="icon-btn" title="Passwort setzen" data-user-reset="${escapeHtml(user.id)}">✎</button></span></td>
  </tr>`);
  const keyRows = state.registrationKeys.map((key) => {
    const used = Boolean(key.usedAt);
    return `<tr>
      <td><div class="adm-name">${used ? "Verwendeter Registrierungsschlüssel" : "Registrierungsschlüssel"}</div><div class="adm-sub">${escapeHtml(key.note || "Einladung")}</div></td>
      <td>Registrierung</td>
      <td class="mono">${escapeHtml(key.keyCode)}</td>
      <td class="adm-sub" style="font-size:.84rem">${escapeHtml(used ? formatDateTime(key.usedAt) : `gültig bis ${formatDateTime(key.expiresAt)}`)}</td>
      <td><span class="pill ${used ? "warn" : "ok"}">${used ? "Verwendet" : "Offen"}</span></td>
      <td style="text-align:right"><span class="row-actions">${used ? "" : `<button class="icon-btn" title="Löschen" data-key-delete="${escapeHtml(key.id)}">×</button>`}</span></td>
    </tr>`;
  });
  el.keysBody.innerHTML = [...userRows, ...keyRows].join("") || `<tr><td colspan="6"><div class="empty-state"><h4>Keine Zugänge gefunden</h4></div></td></tr>`;
  const railCount = $('[data-pane="keys"] .rc');
  if (railCount) railCount.textContent = String(state.adminUsers.length + state.registrationKeys.filter((key) => !key.usedAt).length);
}

function renderAll() {
  renderMunicipalityOptions();
  updateTabCounts();
  renderDashboard();
  renderTable();
  renderDetail();
  renderSources();
  renderImportPane();
  renderKeys();
}

async function loadDashboard() {
  state.dashboard = await requestJson("/api/dashboard");
  state.syncStatus = state.dashboard.syncStatus ?? null;
  state.sourceSummary = state.dashboard.municipalitySourcesSummary ?? state.sourceSummary;
}

async function loadApplications() {
  const payload = await requestJson("/api/applications");
  state.items = payload.items ?? [];
  if (!state.selectedId || !state.items.some((item) => item.id === state.selectedId)) {
    state.selectedId = visibleItems()[0]?.id ?? state.items[0]?.id ?? null;
  }
}

async function loadAdminData() {
  if (!isMaster()) {
    state.municipalitySources = [];
    state.sourceCatalog = [];
    state.registrationKeys = [];
    state.adminUsers = [];
    return;
  }
  try {
    const [sources, keys, users, syncSettings] = await Promise.all([
      requestJson("/api/admin/municipality-sources"),
      requestJson("/api/admin/registration-keys"),
      requestJson("/api/admin/users"),
      requestJson("/api/admin/sync-settings")
    ]);
    state.municipalitySources = sources.items ?? [];
    state.sourceCatalog = sources.catalogItems ?? [];
    state.sourceReport = sources.report ?? null;
    state.sourceSummary = sources.summary ?? state.sourceSummary;
    state.registrationKeys = keys.items ?? [];
    state.adminUsers = users.items ?? [];
    state.syncStatus = syncSettings.syncStatus ?? state.syncStatus;
  } catch (error) {
    toast(error.message);
  }
}

async function refreshAll() {
  await loadDashboard();
  await loadApplications();
  await loadAdminData();
  renderAll();
  if (state.selectedId) loadComments(state.selectedId);
}

async function patchSelectedApplication(changes, message) {
  if (!state.selectedId) return;
  const updated = await requestJson(`/api/applications/${encodeURIComponent(state.selectedId)}`, {
    method: "PATCH",
    body: changes
  });
  state.items = state.items.map((item) => (item.id === updated.id ? updated : item));
  renderAll();
  toast(message);
}

function nextOpen() {
  const open = visibleItems().filter((item) => ["new", "under-review", "escalated"].includes(item.workflowStatus));
  if (!open.length) return;
  const index = open.findIndex((item) => item.id === state.selectedId);
  const next = open[(index + 1) % open.length];
  selectItem(next.id);
  const row = $(`#tbody tr[data-id="${CSS.escape(next.id)}"]`);
  row?.scrollIntoView({ block: "center" });
}

function fillPrintArea(item) {
  const due = dueMeta(item);
  el.paId.textContent = item.id;
  el.paTitle.textContent = itemTitle(item);
  el.paSub.textContent = `${item.municipality || "-"} · ${readableAddress(item)}`;
  el.paMun.textContent = item.municipality || "-";
  el.paAddr.textContent = readableAddress(item);
  el.paParcel.textContent = item.parcel || "-";
  el.paPub.textContent = formatDate(item.publicationDate);
  el.paDue.textContent = `${formatDate(item.deadlineDate)} · ${due.txt}`;
  el.paAgis.textContent = item.agisMatch || protectionMeta(item).label;
  el.paProject.textContent = readableProject(item);
  el.paRec.textContent = recommendationText(item);
  el.paSource.textContent = `${item.source || "unbekannt"}${item.sourceReference ? ` · ${item.sourceReference}` : ""}`;
  el.paFoot.textContent = "Heimatschutz Aargau";
}

function switchView(view) {
  $$(".nav-item").forEach((button) => button.classList.toggle("active", button.dataset.view === view));
  $$(".view").forEach((node) => node.classList.toggle("active", node.id === `view-${view}`));
}

function switchPane(pane) {
  $$(".rail-item").forEach((button) => button.classList.toggle("active", button.dataset.pane === pane));
  $$(".admin-pane").forEach((node) => node.classList.toggle("active", node.id === `pane-${pane}`));
}

async function editSource(sourceId) {
  const source = state.municipalitySources.find((entry) => entry.id === sourceId);
  if (!source) return;
  const sourceUrl = window.prompt(`Quelle für ${source.municipality}`, source.sourceUrl || "");
  if (sourceUrl === null) return;
  const enabled = window.confirm("Quelle automatisch aktivieren?");
  const payload = await requestJson(`/api/admin/municipality-sources/${encodeURIComponent(source.id)}`, {
    method: "PATCH",
    body: {
      sourceType: source.sourceType || "html",
      digitalStatus: source.digitalStatus || "unknown",
      enabled,
      sourceUrl,
      sourceToken: source.sourceToken || "",
      includePattern: source.includePattern || "",
      excludePattern: source.excludePattern || "",
      notes: source.notes || ""
    }
  });
  state.municipalitySources = state.municipalitySources.map((entry) => (entry.id === payload.item.id ? payload.item : entry));
  state.sourceSummary = payload.summary ?? state.sourceSummary;
  state.sourceCatalog = payload.catalogItems ?? state.sourceCatalog;
  state.sourceReport = payload.report ?? state.sourceReport;
  renderSources();
  renderDashboard();
  toast(payload.message || "Gemeindequelle gespeichert.");
}

function wireEvents() {
  el.loginForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    setMessage(el.loginError, "");
    busy(el.loginButton, true, "Anmelden...");
    try {
      const body = {
        username: el.loginUsername.value.trim().toLowerCase(),
        password: el.loginPassword.value,
        captchaToken: turnstileToken("loginTurnstile")
      };
      if (!el.loginTotpField.classList.contains("hidden")) body.totp = el.loginTotp.value.trim();
      const payload = await requestJson("/api/auth/login", { method: "POST", body, skipSessionReset: true });
      localStorage.setItem(rememberedUsernameStorageKey, body.username);
      showAuthenticated(payload.user);
      await refreshAll();
    } catch (error) {
      if (error.payload?.twoFactorRequired) {
        el.loginTotpField.classList.remove("hidden");
        el.loginTotp.focus();
      }
      setMessage(el.loginError, error.message);
      ensureTurnstile(el.loginTurnstile);
    } finally {
      busy(el.loginButton, false);
    }
  });

  el.registerForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    setMessage(el.registerError, "");
    busy(el.registerButton, true, "Erstellen...");
    try {
      const payload = await requestJson("/api/auth/register", {
        method: "POST",
        body: {
          displayName: el.registerDisplayName.value,
          username: el.registerUsername.value.trim().toLowerCase(),
          email: el.registerEmail.value,
          password: el.registerPassword.value,
          accessKey: el.registerAccessKey.value,
          captchaToken: turnstileToken("registerTurnstile")
        },
        skipSessionReset: true
      });
      showAuthenticated(payload.user);
      await refreshAll();
    } catch (error) {
      setMessage(el.registerError, error.message);
      ensureTurnstile(el.registerTurnstile);
    } finally {
      busy(el.registerButton, false);
    }
  });

  el.forgotPasswordForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    setMessage(el.forgotPasswordError, "");
    setMessage(el.forgotPasswordSuccess, "");
    busy(el.forgotPasswordButton, true, "Senden...");
    try {
      await requestJson("/api/auth/forgot-password", {
        method: "POST",
        body: { email: el.forgotPasswordEmail.value, captchaToken: turnstileToken("forgotTurnstile") },
        skipSessionReset: true
      });
      setMessage(el.forgotPasswordSuccess, "Falls ein Konto existiert, wurde ein Reset-Schlüssel versendet.", true);
    } catch (error) {
      setMessage(el.forgotPasswordError, error.message);
      ensureTurnstile(el.forgotTurnstile);
    } finally {
      busy(el.forgotPasswordButton, false);
    }
  });

  el.resetPasswordForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    setMessage(el.resetPasswordError, "");
    setMessage(el.resetPasswordSuccess, "");
    busy(el.resetPasswordButton, true, "Speichern...");
    try {
      await requestJson("/api/auth/reset-password", {
        method: "POST",
        body: { resetKey: el.resetPasswordKey.value, password: el.resetPasswordValue.value },
        skipSessionReset: true
      });
      setMessage(el.resetPasswordSuccess, "Passwort gespeichert. Sie können sich jetzt anmelden.", true);
    } catch (error) {
      setMessage(el.resetPasswordError, error.message);
    } finally {
      busy(el.resetPasswordButton, false);
    }
  });

  el.masterSetupForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    setMessage(el.masterSetupError, "");
    setMessage(el.masterSetupSuccess, "");
    busy(el.masterSetupButton, true, "Speichern...");
    try {
      await requestJson("/api/auth/master-setup", {
        method: "POST",
        body: { setupKey: el.masterSetupKey.value, password: el.masterSetupPassword.value },
        skipSessionReset: true
      });
      setMessage(el.masterSetupSuccess, "Master-Passwort gesetzt. Login ist jetzt möglich.", true);
    } catch (error) {
      setMessage(el.masterSetupError, error.message);
    } finally {
      busy(el.masterSetupButton, false);
    }
  });

  $("#showRegisterButton")?.addEventListener("click", () => showAuthPanel("register"));
  $("#showLoginButton")?.addEventListener("click", () => showAuthPanel("login"));
  $("#showForgotPasswordButton")?.addEventListener("click", () => showAuthPanel("forgot"));
  $("#showResetPasswordButton")?.addEventListener("click", () => showAuthPanel("reset"));
  $("#showLoginFromForgotButton")?.addEventListener("click", () => showAuthPanel("login"));
  $("#showLoginFromResetButton")?.addEventListener("click", () => showAuthPanel("login"));
  $("#showLoginFromMasterButton")?.addEventListener("click", () => showAuthPanel("login"));

  el.logoutButton.addEventListener("click", async () => {
    try {
      await requestJson("/api/auth/logout", { method: "POST" });
    } catch {
      // Auch bei Netzwerkfehler lokal zur Login-Maske zurückkehren.
    }
    showLoggedOut();
  });

  $$(".tab").forEach((button) => button.addEventListener("click", () => {
    state.activeTab = button.dataset.tab;
    $$(".tab").forEach((entry) => entry.classList.toggle("active", entry === button));
    const first = visibleItems()[0];
    if (first) state.selectedId = first.id;
    renderTable();
    renderDetail();
    if (state.selectedId) loadComments(state.selectedId);
  }));

  el.fltSearch.addEventListener("input", (event) => {
    state.filters.search = event.target.value;
    el.mastSearch.value = event.target.value;
    renderTable();
  });
  el.mastSearch.addEventListener("input", (event) => {
    state.filters.search = event.target.value;
    el.fltSearch.value = event.target.value;
    renderTable();
  });
  el.fltMun.addEventListener("change", (event) => { state.filters.municipality = event.target.value; renderTable(); });
  el.fltProt.addEventListener("change", (event) => { state.filters.protection = event.target.value; renderTable(); });
  el.fltWf.addEventListener("change", (event) => { state.filters.workflow = event.target.value; renderTable(); });
  el.resetFilters.addEventListener("click", () => {
    state.filters = { search: "", municipality: "", protection: "", workflow: "" };
    el.fltSearch.value = "";
    el.mastSearch.value = "";
    el.fltMun.value = "";
    el.fltProt.value = "";
    el.fltWf.value = "";
    renderTable();
  });
  el.tbody.addEventListener("click", (event) => {
    if (event.target.closest("[data-reset-empty]")) {
      el.resetFilters.click();
      return;
    }
    const row = event.target.closest("tr[data-id]");
    if (row) selectItem(row.dataset.id);
  });
  el.tbody.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      const row = event.target.closest("tr[data-id]");
      if (row) selectItem(row.dataset.id);
    }
  });
  $$("th.sortable").forEach((th) => th.addEventListener("click", () => {
    const key = th.dataset.sort;
    if (state.sortKey === key) state.sortDir *= -1;
    else {
      state.sortKey = key;
      state.sortDir = 1;
    }
    renderTable();
  }));

  el.syncBtn.addEventListener("click", async () => {
    el.syncBtn.classList.add("spin");
    try {
      await requestJson("/api/sync", { method: "POST" });
      await refreshAll();
      toast("Synchronisation abgeschlossen.");
    } catch (error) {
      toast(error.message);
    } finally {
      el.syncBtn.classList.remove("spin");
    }
  });

  el.runImport.addEventListener("click", async () => {
    busy(el.runImport, true, "Import läuft...");
    try {
      const payload = await requestJson("/api/sync", { method: "POST" });
      await refreshAll();
      toast(payload.message || "Import abgeschlossen.");
    } catch (error) {
      toast(error.message);
    } finally {
      busy(el.runImport, false);
    }
  });

  el.saveBtn.addEventListener("click", async (event) => {
    event.preventDefault();
    busy(el.saveBtn, true, "Speichern...");
    try {
      await patchSelectedApplication({
        workflowStatus: el.fWorkflow.value,
        assignee: el.fAssignee.value,
        note: el.fNote.value,
        learnFromDecision: true
      }, "Entscheidung gespeichert.");
    } catch (error) {
      toast(error.message);
    } finally {
      busy(el.saveBtn, false);
    }
  });

  el.clearBtn.addEventListener("click", async () => {
    busy(el.clearBtn, true, "Speichern...");
    try {
      await patchSelectedApplication({
        workflowStatus: "cleared",
        assignee: el.fAssignee.value || state.currentUser?.displayName || "",
        note: el.fNote.value,
        learnFromDecision: true
      }, "Als erledigt markiert.");
    } catch (error) {
      toast(error.message);
    } finally {
      busy(el.clearBtn, false);
    }
  });

  el.commentSubmit.addEventListener("click", async (event) => {
    event.preventDefault();
    if (!state.selectedId || !el.commentInput.value.trim()) return;
    busy(el.commentSubmit, true, "Speichern...");
    try {
      await requestJson(`/api/applications/${encodeURIComponent(state.selectedId)}/comments`, {
        method: "POST",
        body: { message: el.commentInput.value }
      });
      el.commentInput.value = "";
      await loadComments(state.selectedId);
      toast("Kommentar gespeichert.");
    } catch (error) {
      toast(error.message);
    } finally {
      busy(el.commentSubmit, false);
    }
  });

  el.nextOpen.addEventListener("click", nextOpen);
  el.printBtn.addEventListener("click", () => {
    const item = state.items.find((entry) => entry.id === state.selectedId);
    if (!item) return;
    fillPrintArea(item);
    window.print();
  });

  el.themeToggle.addEventListener("click", () => {
    const on = document.body.classList.toggle("dark");
    el.themeToggle.setAttribute("aria-pressed", String(on));
    localStorage.setItem("hsa-dark", on ? "1" : "0");
  });
  el.fontToggle.addEventListener("click", () => {
    const on = document.documentElement.classList.toggle("large-text");
    el.fontToggle.setAttribute("aria-pressed", String(on));
    localStorage.setItem("hsa-large", on ? "1" : "0");
  });
  $$(".nav-item").forEach((button) => button.addEventListener("click", () => switchView(button.dataset.view)));
  $$(".rail-item").forEach((button) => button.addEventListener("click", () => switchPane(button.dataset.pane)));
  el.srcSearch.addEventListener("input", (event) => {
    state.sourceSearch = event.target.value;
    renderSources();
  });
  $("#pane-sources .adm-toolbar .tool-btn")?.addEventListener("click", async () => {
    if (!isMaster()) return;
    const municipality = window.prompt("Welche Gemeindequelle bearbeiten?", el.srcSearch.value || "");
    if (!municipality) return;
    const source = state.municipalitySources.find((entry) =>
      entry.municipality.toLowerCase() === municipality.trim().toLowerCase()
    );
    if (!source) {
      state.sourceSearch = municipality;
      el.srcSearch.value = municipality;
      renderSources();
      toast("Gemeinde in der Liste auswählen und dort bearbeiten.");
      return;
    }
    try {
      await editSource(source.id);
    } catch (error) {
      toast(error.message);
    }
  });
  el.srcBody.addEventListener("click", async (event) => {
    const openButton = event.target.closest("[data-source-open]");
    if (openButton?.dataset.sourceOpen) {
      window.open(openButton.dataset.sourceOpen, "_blank", "noopener");
      return;
    }
    const editButton = event.target.closest("[data-source-edit]");
    if (editButton?.dataset.sourceEdit) {
      try {
        await editSource(editButton.dataset.sourceEdit);
      } catch (error) {
        toast(error.message);
      }
    }
  });
  $("#pane-keys .tool-btn")?.addEventListener("click", async () => {
    if (!isMaster()) return;
    const note = window.prompt("Notiz zum Registrierungsschlüssel", "Neue Einladung");
    if (note === null) return;
    try {
      const key = await requestJson("/api/admin/registration-keys", { method: "POST", body: { note } });
      state.registrationKeys = [key, ...state.registrationKeys];
      renderKeys();
      toast(`Schlüssel erstellt: ${key.keyCode}`);
    } catch (error) {
      toast(error.message);
    }
  });
  el.keysBody.addEventListener("click", async (event) => {
    const resetButton = event.target.closest("[data-user-reset]");
    if (resetButton) {
      const password = window.prompt("Neues Passwort setzen (mind. 8 Zeichen)");
      if (!password) return;
      try {
        await requestJson(`/api/admin/users/${encodeURIComponent(resetButton.dataset.userReset)}/password`, {
          method: "PATCH",
          body: { password }
        });
        toast("Passwort gesetzt.");
      } catch (error) {
        toast(error.message);
      }
      return;
    }
    const deleteButton = event.target.closest("[data-key-delete]");
    if (deleteButton && window.confirm("Registrierungsschlüssel wirklich löschen?")) {
      try {
        await requestJson(`/api/admin/registration-keys/${encodeURIComponent(deleteButton.dataset.keyDelete)}`, { method: "DELETE" });
        state.registrationKeys = state.registrationKeys.filter((key) => key.id !== deleteButton.dataset.keyDelete);
        renderKeys();
        toast("Schlüssel gelöscht.");
      } catch (error) {
        toast(error.message);
      }
    }
  });
}

async function maybeRevealMasterSetup() {
  try {
    const payload = await requestJson("/api/auth/master-setup-status", { skipSessionReset: true });
    if (payload.setupRequired) showAuthPanel("master");
  } catch {
    // Login bleibt sichtbar.
  }
}

async function restoreSession() {
  await loadAuthConfig();
  const remembered = localStorage.getItem(rememberedUsernameStorageKey);
  if (remembered) el.loginUsername.value = remembered;
  try {
    const payload = await requestJson("/api/auth/session", { skipSessionReset: true });
    if (payload.authenticated && payload.user) {
      showAuthenticated(payload.user);
      await refreshAll();
      return;
    }
  } catch {
    // Danach Login anzeigen.
  }
  showLoggedOut();
  await maybeRevealMasterSetup();
}

async function init() {
  collectElements();
  wireEvents();
  if (localStorage.getItem("hsa-dark") === "1") el.themeToggle.click();
  if (localStorage.getItem("hsa-large") === "1") el.fontToggle.click();
  await restoreSession();
}

document.addEventListener("DOMContentLoaded", () => {
  init().catch((error) => {
    console.error(error);
    showLoggedOut();
    setMessage(el.loginError, error.message || "Die App konnte nicht geladen werden.");
  });
});
