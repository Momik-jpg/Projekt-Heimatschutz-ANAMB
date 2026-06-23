async function editSource(sourceId) {
  const source = state.municipalitySources.find((entry) => entry.id === sourceId);
  if (!source) return;
  const sourceUrl = await uiPrompt("URL der offiziellen Publikationsquelle.", {
    title: `Quelle für ${source.municipality}`,
    label: "Quellen-URL",
    value: source.sourceUrl || "",
    inputType: "url",
    confirmLabel: "Weiter"
  });
  if (sourceUrl === null) return;
  const enabled = await uiConfirm("Quelle automatisch für den Sync aktivieren?", {
    title: "Quelle aktivieren?",
    confirmLabel: "Aktivieren"
  });
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

  $$(".tab").forEach((button) => {
    button.addEventListener("click", () => {
      state.activeTab = button.dataset.tab;
      state.showOlder = false;
      $$(".tab").forEach((entry) => {
        entry.classList.toggle("active", entry === button);
      });
      if (state.selectedId && !visibleItems().some((item) => item.id === state.selectedId)) {
        state.selectedId = null;
      }
      renderTable();
      renderDetail();
      if (state.selectedId) loadComments(state.selectedId);
    });
  });

  $$(".region-filter").forEach((button) => {
    button.addEventListener("click", () => {
      const region = button.dataset.region;
      if (state.selectedRegions.has(region)) state.selectedRegions.delete(region);
      else state.selectedRegions.add(region);
      state.showOlder = false;
      button.classList.toggle("active", state.selectedRegions.has(region));
      button.setAttribute("aria-pressed", String(state.selectedRegions.has(region)));
      renderTable();
    });
  });

  el.fltSearch.addEventListener("input", (event) => {
    state.filters.search = event.target.value;
    state.showOlder = false;
    renderTable();
  });
  el.fltMun.addEventListener("change", (event) => { state.filters.municipality = event.target.value; state.showOlder = false; renderTable(); });
  el.fltProt.addEventListener("change", (event) => { state.filters.protection = event.target.value; state.showOlder = false; renderTable(); });
  el.fltWf.addEventListener("change", (event) => { state.filters.workflow = event.target.value; state.showOlder = false; renderTable(); });
  el.resetFilters.addEventListener("click", () => {
    state.filters = { search: "", municipality: "", protection: "", workflow: "" };
    state.selectedRegions.clear();
    state.showOlder = false;
    el.fltSearch.value = "";
    el.fltMun.value = "";
    el.fltProt.value = "";
    el.fltWf.value = "";
    $$(".region-filter").forEach((button) => {
      button.classList.remove("active");
      button.setAttribute("aria-pressed", "false");
    });
    renderTable();
  });
  el.tbody.addEventListener("click", (event) => {
    if (event.target.closest("[data-reset-empty]")) {
      el.resetFilters.click();
      return;
    }
    if (event.target.closest("[data-show-older]")) {
      state.showOlder = !state.showOlder;
      renderTable();
      return;
    }
    const openButton = event.target.closest("[data-open-application]");
    if (openButton) {
      selectItem(openButton.dataset.openApplication);
      return;
    }
    const row = event.target.closest("tr[data-id]");
    if (row) selectItem(row.dataset.id);
  });
  $$("th.sortable").forEach((th) => {
    th.addEventListener("click", () => {
      const key = th.dataset.sort;
      if (state.sortKey === key) state.sortDir *= -1;
      else {
        state.sortKey = key;
        state.sortDir = 1;
      }
      renderTable();
    });
  });

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
  el.loadExternalMap?.addEventListener("click", enableExternalMapTiles);

  el.themeToggle.addEventListener("click", () => {
    applyThemePreference(!document.body.classList.contains("dark"));
  });
  el.fontToggle.addEventListener("click", () => {
    applyLargeTextPreference(!document.documentElement.classList.contains("large-text"));
  });
  $$(".nav-item").forEach((button) => {
    button.addEventListener("click", () => switchView(button.dataset.view));
  });
  $$(".rail-item").forEach((button) => {
    button.addEventListener("click", () => switchPane(button.dataset.pane));
  });
  el.srcSearch.addEventListener("input", (event) => {
    state.sourceSearch = event.target.value;
    renderSources();
  });
  $("#pane-sources .adm-toolbar .tool-btn")?.addEventListener("click", async () => {
    if (!isMaster()) return;
    const municipality = await uiPrompt("Gemeindename eingeben.", {
      title: "Gemeindequelle bearbeiten",
      label: "Gemeinde",
      value: el.srcSearch.value || "",
      confirmLabel: "Weiter"
    });
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
    const note = await uiPrompt("Optionale Notiz zur Einladung.", {
      title: "Registrierungsschlüssel erstellen",
      label: "Notiz",
      value: "Neue Einladung",
      confirmLabel: "Erstellen"
    });
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
      const password = await uiPrompt("Mindestens 8 Zeichen.", {
        title: "Neues Passwort setzen",
        label: "Passwort",
        inputType: "password",
        confirmLabel: "Setzen"
      });
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
    const lockButton = event.target.closest("[data-user-lock]");
    if (lockButton) {
      const id = lockButton.dataset.userLock;
      const next = lockButton.dataset.active !== "1"; // aktiv -> sperren (false)
      const entry = state.adminUsers.find((user) => user.id === id);
      if (
        !next &&
        !(await uiConfirm("Der Zugang wird sofort deaktiviert.", {
          title: "Konto sperren?",
          eyebrow: "Zugangsverwaltung",
          facts: [
            { label: "Person", value: entry?.displayName || "Ohne Namen" },
            { label: "Benutzername", value: entry?.username || "-" },
            { label: "Rolle", value: entry?.role || "-" }
          ],
          confirmLabel: "Sperren",
          danger: true
        }))
      ) {
        return;
      }
      try {
        await requestJson(`/api/admin/users/${encodeURIComponent(id)}/active`, {
          method: "PATCH",
          body: { active: next }
        });
        if (entry) entry.active = next;
        renderKeys();
        toast(next ? "Konto entsperrt." : "Konto gesperrt.");
      } catch (error) {
        toast(error.message);
      }
      return;
    }
    const userDeleteButton = event.target.closest("[data-user-delete]");
    if (userDeleteButton) {
      const id = userDeleteButton.dataset.userDelete;
      const entry = state.adminUsers.find((user) => user.id === id);
      if (
        !(await uiConfirm("Das Konto wird endgültig gelöscht. Konten mit Kommentaren oder erstellten Registrierungsschlüsseln können nicht gelöscht werden; sperren Sie solche Konten stattdessen.", {
          title: "Konto löschen?",
          eyebrow: "Zugangsverwaltung",
          facts: [
            { label: "Person", value: entry?.displayName || "Ohne Namen" },
            { label: "Benutzername", value: entry?.username || "-" },
            { label: "Rolle", value: entry?.role || "-" }
          ],
          confirmLabel: "Löschen",
          danger: true
        }))
      ) {
        return;
      }
      try {
        await requestJson(`/api/admin/users/${encodeURIComponent(id)}`, { method: "DELETE" });
        state.adminUsers = state.adminUsers.filter((user) => user.id !== id);
        renderKeys();
        toast("Konto gelöscht.");
      } catch (error) {
        toast(error.message);
      }
      return;
    }
    const deleteButton = event.target.closest("[data-key-delete]");
    if (deleteButton) {
      const key = state.registrationKeys.find((item) => item.id === deleteButton.dataset.keyDelete);
      const confirmed = await uiConfirm("Dieser Registrierungsschlüssel kann danach nicht mehr verwendet werden.", {
        title: "Schlüssel löschen?",
        eyebrow: "Registrierung",
        facts: [
          { label: "Schlüssel", value: key?.keyCode || "-" },
          { label: "Notiz", value: key?.note || "Einladung" }
        ],
        confirmLabel: "Löschen",
        danger: true
      });
      if (!confirmed) return;
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
  wirePasswordToggles();
  wireEvents();
  applyThemePreference(localStorage.getItem("hsa-dark") === "1", false);
  applyLargeTextPreference(localStorage.getItem("hsa-large") === "1", false);
  await restoreSession();
  applyThemePreference(localStorage.getItem("hsa-dark") === "1", false);
  applyLargeTextPreference(localStorage.getItem("hsa-large") === "1", false);
}

document.addEventListener("DOMContentLoaded", () => {
  init().catch((error) => {
    console.error(error);
    showLoggedOut();
    setMessage(el.loginError, error.message || "Die App konnte nicht geladen werden.");
  });
});
