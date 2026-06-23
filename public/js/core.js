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

const RECONCILIATION = {
  "amtsblatt-confirmed": { label: "Amtsblatt bestätigt", short: "Amtsblatt", cls: "ok" },
  "municipality-only": { label: "Nur Gemeindequelle", short: "Gemeindequelle", cls: "warning" },
  "conflict-review": { label: "Quellenkonflikt", short: "Konflikt", cls: "danger" },
  "missing-publication": { label: "Publikation fehlt", short: "Publikation fehlt", cls: "warning" },
  "ambiguous-review": { label: "Mehrdeutiger Quellenabgleich", short: "Mehrdeutig", cls: "danger" },
  "import-review": { label: "Importquelle prüfen", short: "Importprüfung", cls: "warning" },
  "": { label: "Quellenprüfung offen", short: "Prüfung offen", cls: "neutral" }
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
  important: "Aktuell: Fälle mit Schutztreffer."
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
  selectedRegions: new Set(),
  showOlder: false,
  filters: { search: "", municipality: "", protection: "", workflow: "" },
  sortKey: "publicationDate",
  sortDir: -1,
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
  tileLayer: null,
  externalTilesAllowed: false,
  projectionReady: false,
  requestToken: 0
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

const el = {};

function applyProgressBars(root = document) {
  $$(".progress[data-progress]", root).forEach((progress) => {
    const value = Math.max(0, Math.min(100, Number(progress.dataset.progress) || 0));
    const bar = progress.querySelector("span");
    if (!bar) return;
    bar.style.width = `${value}%`;
    progress.setAttribute("aria-valuenow", String(value));
  });
}

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
    projectScale: $("#projectScale"),
    sourceLink: $("#sourceLink"),
    agisLink: $("#agisLink"),
    mapStatus: $("#mapStatus"),
    mapPrivacy: $("#mapPrivacy"),
    loadExternalMap: $("#loadExternalMap"),
    detailMap: $("#detailMap"),
    mapFallback: $("#mapFallback"),
    mapLegend: $("#mapLegend"),
    mapSymbolHint: $("#mapSymbolHint"),
    recTitle: $("#recTitle"),
    recText: $("#recText"),
    recBadge: $("#recBadge"),
    dueBadge: $("#dueBadge"),
    aiMeta: $("#aiMeta"),
    srcMeta: $("#srcMeta"),
    sourceEvidenceCard: $("#sourceEvidenceCard"),
    sourceEvidenceStatus: $("#sourceEvidenceStatus"),
    sourceEvidenceList: $("#sourceEvidenceList"),
    timeline: $("#timeline"),
    fWorkflow: $("#fWorkflow"),
    fAssignee: $("#fAssignee"),
    fNote: $("#fNote"),
    saveBtn: $("#saveBtn"),
    clearBtn: $("#clearBtn"),
    nextOpen: $("#nextOpen"),
    commentCount: $("#commentCount"),
    commentsList: $("#commentsList"),
    commentInput: $("#commentInput"),
    commentSubmit: $("#commentSubmit"),
    srcSearch: $("#srcSearch"),
    srcBody: $("#srcBody"),
    runImport: $("#runImport"),
    runList: $("#runList"),
    keysBody: $("#keysBody"),
    toast: $("#toast")
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

function reconciliationMeta(itemOrStatus) {
  const status = typeof itemOrStatus === "string"
    ? itemOrStatus
    : String(itemOrStatus?.reconciliationStatus ?? "");
  return RECONCILIATION[status] ?? { label: "Quellenprüfung offen", short: "Prüfung offen", cls: "neutral" };
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

// Massgebliche Einsprachefrist: 14 Tage ab Publikation. Im Kanton Aargau ist
// eine Einsprache nach diesem Fenster praktisch nicht mehr möglich, darum gilt
// diese aus dem Publikationsdatum abgeleitete Frist immer - auch wenn das
// Amtsblatt einen anderen (längeren) Auflagezeitraum nennt. Ohne
// Publikationsdatum bleibt sie leer ("Frist fehlt").
const OBJECTION_PERIOD_DAYS = 14;

function objectionDeadline(item) {
  const publication = item?.publicationDate;
  if (!publication) return "";
  const date = new Date(publication);
  if (Number.isNaN(date.getTime())) return "";
  date.setUTCDate(date.getUTCDate() + OBJECTION_PERIOD_DAYS);
  return date.toISOString().slice(0, 10);
}

function formatDueRelative(days) {
  if (days < 0) {
    const overdueDays = Math.abs(days);
    return overdueDays === 1 ? "1 Tag überfällig" : `${overdueDays} Tage überfällig`;
  }

  if (days === 0) return "heute fällig";
  if (days === 1) return "in 1 Tag";
  return `in ${days} Tagen`;
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

function applyThemePreference(on, persist = true) {
  const enabled = Boolean(on);
  document.body.classList.toggle("dark", enabled);
  el.themeToggle?.setAttribute("aria-pressed", String(enabled));
  const themeLabel = el.themeToggle?.querySelector("span");
  if (themeLabel) themeLabel.textContent = enabled ? "Hellmodus" : "Dunkelmodus";
  if (persist) localStorage.setItem("hsa-dark", enabled ? "1" : "0");
}

function applyLargeTextPreference(on, persist = true) {
  const enabled = Boolean(on);
  document.documentElement.classList.toggle("large-text", enabled);
  el.fontToggle?.setAttribute("aria-pressed", String(enabled));
  if (persist) localStorage.setItem("hsa-large", enabled ? "1" : "0");
}

function passwordToggleButtonMarkup(targetId = "") {
  const target = targetId ? ` data-password-toggle="${escapeHtml(targetId)}"` : " data-password-toggle";
  return `<button class="password-toggle" type="button"${target} aria-label="Passwort anzeigen" aria-pressed="false" title="Passwort anzeigen">
    <svg class="eye-on" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6Z"></path><circle cx="12" cy="12" r="3"></circle></svg>
    <svg class="eye-off" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m3 3 18 18"></path><path d="M10.6 10.6a3 3 0 0 0 4.2 4.2"></path><path d="M9.9 5.2A10.7 10.7 0 0 1 12 5c6.5 0 10 7 10 7a18 18 0 0 1-3 3.8"></path><path d="M6.6 6.6C3.7 8.3 2 12 2 12s3.5 7 10 7c1.4 0 2.7-.3 3.8-.8"></path></svg>
  </button>`;
}

function wirePasswordToggles(root = document) {
  $$("[data-password-toggle]", root).forEach((button) => {
    if (button.dataset.passwordToggleReady === "1") return;
    button.dataset.passwordToggleReady = "1";
    button.addEventListener("click", () => {
      const targetId = button.dataset.passwordToggle;
      const input = targetId
        ? document.getElementById(targetId)
        : button.closest(".password-input-wrap")?.querySelector("input");
      if (!(input instanceof HTMLInputElement)) return;

      const isVisible = input.type === "text";
      input.type = isVisible ? "password" : "text";
      button.classList.toggle("is-visible", !isVisible);
      button.setAttribute("aria-pressed", String(!isVisible));
      const label = isVisible ? "Passwort anzeigen" : "Passwort verbergen";
      button.setAttribute("aria-label", label);
      button.title = label;
      input.focus({ preventScroll: true });
      const caret = input.value.length;
      input.setSelectionRange?.(caret, caret);
    });
  });
}

// ---- In-App-Dialoge (ersetzen die nativen confirm()/prompt()-Boxen) ----
function openModal({
  title,
  message = "",
  eyebrow = "",
  facts = [],
  withInput = false,
  inputType = "text",
  inputValue = "",
  label = "",
  confirmLabel = "OK",
  cancelLabel = "Abbrechen",
  danger = false
}) {
  return new Promise((resolve) => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const appShellWasInert = Boolean(el.appShell?.inert);
    const appShellAriaHidden = el.appShell?.getAttribute("aria-hidden");
    const overlay = document.createElement("div");
    overlay.className = `modal-overlay${danger ? " danger" : ""}`;
    const factItems = Array.isArray(facts)
      ? facts
          .filter((fact) => fact?.label || fact?.value)
          .map(
            (fact) => `
          <div>
            <dt>${escapeHtml(fact.label ?? "")}</dt>
            <dd>${escapeHtml(fact.value ?? "")}</dd>
          </div>`
          )
          .join("")
      : "";
    const inputHtml = !withInput
      ? ""
      : inputType === "password"
        ? `<label class="modal-field"><span>${escapeHtml(label)}</span><span class="password-input-wrap modal-password-wrap"><input class="modal-input" type="password">${passwordToggleButtonMarkup()}</span></label>`
        : `<label class="modal-field"><span>${escapeHtml(label)}</span><input class="modal-input" type="${escapeHtml(inputType)}"></label>`;
    overlay.innerHTML = `
      <div class="modal-card${danger ? " danger" : ""}" role="dialog" aria-modal="true" aria-labelledby="modalTitle">
        <div class="modal-head">
          <span class="modal-mark" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M12 9v4" stroke-linecap="round"></path>
              <path d="M12 17h.01" stroke-linecap="round"></path>
              <path d="M10.3 4.4 2.8 17.2A2 2 0 0 0 4.5 20h15a2 2 0 0 0 1.7-2.8L13.7 4.4a2 2 0 0 0-3.4 0Z" stroke-linejoin="round"></path>
            </svg>
          </span>
          <div>
            ${eyebrow ? `<p class="modal-eyebrow">${escapeHtml(eyebrow)}</p>` : ""}
            <h3 class="modal-title" id="modalTitle">${escapeHtml(title)}</h3>
          </div>
        </div>
        ${message ? `<p class="modal-msg">${escapeHtml(message)}</p>` : ""}
        ${factItems ? `<dl class="modal-facts">${factItems}</dl>` : ""}
        ${inputHtml}
        <div class="modal-actions">
          <button type="button" class="modal-btn modal-btn-cancel" data-modal="cancel">${escapeHtml(cancelLabel)}</button>
          <button type="button" class="modal-btn modal-btn-confirm${danger ? " danger" : ""}" data-modal="confirm">${escapeHtml(confirmLabel)}</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    const input = overlay.querySelector(".modal-input");
    const confirmBtn = overlay.querySelector('[data-modal="confirm"]');
    const cancelBtn = overlay.querySelector('[data-modal="cancel"]');
    const focusableSelector = [
      "a[href]",
      "button:not([disabled])",
      "input:not([disabled])",
      "select:not([disabled])",
      "textarea:not([disabled])",
      "[tabindex]:not([tabindex='-1'])"
    ].join(",");
    const getFocusable = () => Array.from(overlay.querySelectorAll(focusableSelector))
      .filter((node) => node instanceof HTMLElement && node.offsetParent !== null);
    if (input) {
      input.value = inputValue;
    }
    wirePasswordToggles(overlay);
    const initialFocusTarget = input || confirmBtn;
    initialFocusTarget?.focus({ preventScroll: true });
    if (el.appShell) {
      el.appShell.inert = true;
      el.appShell.setAttribute("aria-hidden", "true");
    }
    setTimeout(() => initialFocusTarget?.focus({ preventScroll: true }), 30);

    let closed = false;
    function done(result) {
      if (closed) return;
      closed = true;
      document.removeEventListener("keydown", onKey);
      overlay.remove();
      if (el.appShell) {
        el.appShell.inert = appShellWasInert;
        if (appShellAriaHidden === null) {
          el.appShell.removeAttribute("aria-hidden");
        } else {
          el.appShell.setAttribute("aria-hidden", appShellAriaHidden);
        }
      }
      if (previousFocus?.isConnected) {
        previousFocus.focus({ preventScroll: true });
      }
      resolve(result);
    }
    const onConfirm = () => done(withInput ? input.value ?? "" : true);
    const onCancel = () => done(withInput ? null : false);
    function onKey(event) {
      if (event.key === "Escape") {
        event.preventDefault();
        onCancel();
      } else if (event.key === "Tab") {
        const focusable = getFocusable();
        if (!focusable.length) {
          event.preventDefault();
          return;
        }
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      } else if (event.key === "Enter") {
        if (document.activeElement instanceof HTMLButtonElement) return;
        event.preventDefault();
        onConfirm();
      }
    }

    overlay.addEventListener("mousedown", (event) => {
      if (event.target === overlay) onCancel();
    });
    confirmBtn.addEventListener("click", onConfirm);
    cancelBtn.addEventListener("click", onCancel);
    document.addEventListener("keydown", onKey);
  });
}

function uiConfirm(message, { title = "Bestätigen", eyebrow = "", facts = [], confirmLabel = "OK", cancelLabel = "Abbrechen", danger = false } = {}) {
  return openModal({ title, message, eyebrow, facts, confirmLabel, cancelLabel, danger });
}

function uiPrompt(message, { title = "Eingabe", label = "", value = "", inputType = "text", confirmLabel = "Speichern" } = {}) {
  return openModal({ title, message, withInput: true, label, inputValue: value, inputType, confirmLabel });
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
  Object.entries(forms).forEach(([key, form]) => {
    form?.classList.toggle("hidden", key !== name);
  });
  if (name === "login") {
    ensureTurnstile(el.loginTurnstile);
    setTimeout(() => el.loginUsername?.focus(), 0);
  }
  if (name === "register") ensureTurnstile(el.registerTurnstile);
  if (name === "forgot") ensureTurnstile(el.forgotTurnstile);
}
