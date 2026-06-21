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
// Erkennt rohe HTML-/Attribut-/URL-Soup, die bei fehlerhaften Importen ins
// Bauvorhaben-Feld geraten ist (z. B. 'box box-large" data-index="148" ...').
function looksLikeMarkupJunk(value) {
  return /<[a-z/!]|=\s*["']|\bdata-[\w-]+|%5[bd]|class=|box[\s-]box|tx_[a-z_]+|filter%|\/publikation/i.test(value);
}

function looksLikeDocumentJunk(value) {
  const replacementChars = Array.from(value).filter((char) => char.charCodeAt(0) === 0xfffd).length;
  return /^%PDF-\d/i.test(value)
    || /\b(?:obj|endobj|xref|trailer|startxref)\b/i.test(value)
    || /\/(?:Type|Metadata|OutputIntents|Catalog|Pages)\b/i.test(value)
    || replacementChars >= 2;
}

function cleanProjectDisplay(raw) {
  let text = normalizeText(raw || "");
  if (!text) return "";
  if (looksLikeDocumentJunk(text)) return "";
  text = text
    .replace(/<[^>]*>/g, " ")
    .replace(/&(?:nbsp|amp|lt|gt|quot|#0?39|apos);/gi, " ")
    .replace(/\b[\w-]+\s*=\s*"[^"]*"/g, " ")
    .replace(/\b[\w-]+\s*=\s*'[^']*'/g, " ")
    .replace(/[?&][\w.%[\]+-]+=[\w.%[\]+-]*/g, " ")
    .replace(/^\s*(?:Bauvorhaben|Bauprojekt|Bauobjekt|Projekt)\s*[:.–-]\s*/i, "")
    .replace(
      /\s*(?:Bauherr(?:schaft)?|Grundeigentümer(?:in)?|Eigentümer(?:in)?|Projektverfasser|Bauplatz|Standort|Lage|Parzelle|Auflage(?:frist)?|Publikation|Frist|Einsprache)\s*:.*$/i,
      ""
    );
  text = normalizeText(text).replace(/[\s,;:–-]+$/, "").trim();
  // Bleiben nach dem Säubern noch Markup-/Code-Reste übrig, verwerfen.
  if (!text || looksLikeMarkupJunk(text) || looksLikeDocumentJunk(text)) return "";
  return text;
}

function readableProject(item) {
  return cleanProjectDisplay(item.description) || cleanProjectDisplay(item.projectType) || "Baugesuch";
}

function itemTitle(item) {
  return truncate(readableProject(item), 74);
}

function readableAddress(item) {
  const address = normalizeText(item.address)
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+box(?:\s+box[-\w]+)+["']?(?:\s+[\s\S]*)?$/i, "")
    .replace(/\s+data-[\w-]+\s*=\s*["'][\s\S]*$/i, "")
    .replace(/\s+(?:Gegen das obenstehende|Gegen dieses Baugesuch|Einsprachen sind)\b[\s\S]*$/i, "")
    .replace(/\.{2,}\s*\[mehr\].*$/i, "")
    .replace(/\s*\[mehr\].*$/i, "")
    .replace(/\s*(?:Bauherr(?:schaft)?|Grundeigentümer(?:in)?|Projektverfasser|Bauprojekt|Bauvorhaben|Lage):.*$/i, "");
  return address || "Adresse prüfen";
}

function dueMeta(item) {
  const workflow = item.workflowStatus;
  const days = daysUntil(item.deadlineDate);
  if (workflow === "cleared" || workflow === "archived") return { cls: "due-ok", txt: "abgeschlossen", days };
  if (!Number.isFinite(days)) return { cls: "due-soon", txt: "Frist fehlt", days };
  if (days <= 0) return { cls: "due-over", txt: formatDueRelative(days), days };
  if (days <= 5) return { cls: "due-soon", txt: formatDueRelative(days), days };
  return { cls: "due-ok", txt: formatDueRelative(days), days };
}

function _isOverdue(item) {
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
  if (state.activeTab === "important") {
    return ["combined-hit", "protected-point", "protected-zone"].includes(item.protectionStatus);
  }
  return true;
}

function matchesFilters(item) {
  if (state.selectedRegions.size > 0 && !state.selectedRegions.has(item.region)) return false;
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

function publicationAgeDays(item, referenceDate = new Date()) {
  if (!item.publicationDate) return 0;
  const published = new Date(`${item.publicationDate}T00:00:00`);
  if (Number.isNaN(published.getTime())) return 0;
  const today = new Date(referenceDate.getFullYear(), referenceDate.getMonth(), referenceDate.getDate());
  return Math.floor((today.getTime() - published.getTime()) / 86400000);
}

function updateTabCounts() {
  const count = (fn) => state.items.filter(fn).length;
  const setCount = (key, value) => {
    const node = $(`[data-count="${key}"]`);
    if (node) node.textContent = String(value);
  };
  setCount("all", state.items.length);
  setCount(
    "important",
    count((item) => ["combined-hit", "protected-point", "protected-zone"].includes(item.protectionStatus))
  );
  el.navWorkCount.textContent = String(state.items.length);
}

function renderMunicipalityOptions() {
  const selected = state.filters.municipality;
  const municipalities = new Set(state.dashboard?.municipalities ?? []);
  state.items.forEach((item) => {
    municipalities.add(item.municipality);
  });
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
      <h3>Keine Baugesuche gefunden</h3>
      <p>Filter zurücksetzen oder einen anderen Reiter wählen.</p>
      <button class="btn ghost" type="button" data-reset-empty>Filter zurücksetzen</button>
    </div></td></tr>`;
    return;
  }

  const recentRows = rows.filter((item) => publicationAgeDays(item) <= 14);
  const olderRows = rows.filter((item) => publicationAgeDays(item) > 14);
  const scaleLabel = (scale) => ({ klein: "Klein", mittel: "Mittel", gross: "Gross", unbekannt: "Unbekannt" })[scale] || "Unbekannt";
  const renderRows = (items) => items
    .map((item) => {
      const protection = protectionMeta(item);
      const workflow = workflowMeta(item);
      const due = dueMeta(item);
      const classes = [
        item.id === state.selectedId ? "selected" : "",
        item.isRead ? "" : "unread",
        due.cls === "due-over" ? "urg-over" : due.cls === "due-soon" ? "urg-soon" : ""
      ].filter(Boolean).join(" ");
      return `<tr data-id="${escapeHtml(item.id)}" class="${classes}">
        <td><span class="unread-dot" aria-hidden="true"></span>${item.isRead ? "" : '<span class="sr-only">Ungelesen: </span>'}<span class="cell-mun">${escapeHtml(item.municipality || "-")}</span><span class="cell-mun-sub">${escapeHtml(item.region || item.source || "Baugesuch")}</span></td>
        <td><button class="application-open" type="button" data-open-application="${escapeHtml(item.id)}" aria-label="Fall ${escapeHtml(item.id)}, ${escapeHtml(item.municipality || "-")}, ${escapeHtml(itemTitle(item))} öffnen"><span class="cell-app-title">${escapeHtml(itemTitle(item))}</span><span class="cell-app-sub">${escapeHtml(readableAddress(item))}</span><span class="cell-app-meta">Publiziert ${escapeHtml(formatDate(item.publicationDate))} · ${escapeHtml(scaleLabel(item.projectScale))}</span></button></td>
        <td><span class="hit ${protection.cls}">${escapeHtml(protection.label)}</span></td>
        <td><span class="cell-due">${escapeHtml(formatDate(item.deadlineDate))}</span><span class="cell-due-meta ${due.cls}">${escapeHtml(due.txt)}</span></td>
        <td><span class="cell-status-wrap"><span class="wf ${workflow.cls}">${escapeHtml(workflow.label)}</span><span class="row-go"><svg class="row-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true"><path d="m9 6 6 6-6 6" stroke-linecap="round" stroke-linejoin="round"/></svg></span></span></td>
      </tr>`;
    })
    .join("");

  const recentMarkup = renderRows(recentRows);
  const olderMarkup = state.showOlder ? renderRows(olderRows) : "";
  const olderControl = olderRows.length
    ? `<tr class="older-control-row"><td colspan="5"><button class="show-older" type="button" data-show-older aria-expanded="${state.showOlder}">${state.showOlder ? "Ältere Publikationen ausblenden" : `Mehr anzeigen · ${olderRows.length} vor über 14 Tagen publiziert`}</button></td></tr>`
    : "";
  el.tbody.innerHTML = `${recentMarkup}${olderControl}${olderMarkup}`;
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
  const assessment = currentAssessmentText(item);
  if (assessment) return assessment;
  if (item.protectionStatus === "no-hit") {
    return "Die automatische Prüfung hat keinen Schutztreffer gefunden. Bei unvollständigen Adressdaten kurz plausibilisieren.";
  }
  if (item.protectionStatus === "manual-review") {
    return "Die Adresse oder Quelle ist nicht eindeutig genug für eine automatische Zuordnung. Unterlagen und Gemeindequelle manuell prüfen.";
  }
  return "Schutztreffer vorhanden. Eingriff, Sichtbarkeit und Schutzumfang vor Bewilligung fachlich prüfen.";
}

function isWeakDisplayAddress(value) {
  const text = normalizeText(value);
  return (
    !text ||
    text === "Adresse prüfen" ||
    /^Adresse\s+(?:von\s+(?:Webseite|PDF)\s+prüfen|aus\s+Amtsblatt\s+prüfen)$/i.test(text) ||
    /^Parzelle\s+\d{1,6}$/i.test(text) ||
    /^(?:Haus(?:nummer|nr\.?)?|Geb(?:äude)?(?:\s+Nr\.?)?|Nr\.?)?\s*\d{1,4}[A-Za-z]?$/.test(text)
  );
}

function dataQualityChecks(item) {
  const address = readableAddress(item);
  const hasCoordinates = Boolean(parseSwissCoordinates(item.coordinates));
  const addressIsWeak = isWeakDisplayAddress(address);
  const addressProvenance = normalizeText(item.addressProvenance);
  const addressOk = !item.ambiguousAddress && !addressIsWeak && ["official-field", "geocoder"].includes(addressProvenance);
  const locationOk = hasCoordinates && item.locationPrecision === "precise";
  const deadlineOk = Boolean(item.deadlineDate) && item.deadlineProvenance === "explicit";
  const sourceUrl = normalizeText(item.sourceUrl);
  const sourceOk = /^https?:\/\/[^\s]+$/i.test(sourceUrl) && Boolean(normalizeText(item.sourceReference));

  return [
    {
      label: "Adresse",
      ok: addressOk,
      detail: addressOk ? "amtlich belegt" : addressIsWeak ? "unvollständig" : "Herkunft unbestätigt"
    },
    {
      label: "Standort",
      ok: locationOk,
      detail: locationOk ? "präzise verortet" : hasCoordinates ? "Genauigkeit unbestätigt" : "fehlt"
    },
    {
      label: "Frist",
      ok: deadlineOk,
      detail: deadlineOk ? formatDate(item.deadlineDate) : item.deadlineDate ? "unbestätigt" : "fehlt"
    },
    {
      label: "Originalquelle",
      ok: sourceOk,
      detail: sourceOk ? "verlinkt" : "nicht belastbar verlinkt"
    }
  ];
}

function currentAssessmentText(item, checks = dataQualityChecks(item)) {
  let text = normalizeText(item.automatedAssessment);

  if (!text) return "";

  const hasLocation = checks.find((check) => check.label === "Standort")?.ok;
  const hasDeadline = checks.find((check) => check.label === "Frist")?.ok;

  if (hasLocation) {
    text = text.replaceAll("KI-Datenprüfung: Standortangaben bleiben unvollständig - bitte von Hand prüfen.", "");
  }

  if (hasDeadline) {
    text = text.replaceAll("KI-Datenprüfung: Frist fehlt weiterhin - bitte von Hand prüfen.", "");
  }

  return normalizeText(text.replaceAll("KI-Datenprüfung", "Automatische Datenprüfung"));
}

function renderAiMeta(item) {
  if (!el.aiMeta) return;

  const checks = dataQualityChecks(item);
  const needsReview = checks.some((check) => !check.ok) || item.protectionStatus === "manual-review";
  const assessment = currentAssessmentText(item, checks);
  const missingFacts = checks.filter((check) => !check.ok).map((check) => `${check.label}: ${check.detail}`).join("; ");
  const summary = needsReview
    ? `Nicht vollständig belegt. ${missingFacts || "Fachliche Zuordnung manuell prüfen."}${assessment ? ` Hinweis: ${assessment}` : ""}`
    : "Frist, Adresse, Standort und Originalquelle sind nachvollziehbar belegt.";

  el.aiMeta.classList.remove("hidden");
  el.aiMeta.classList.toggle("warn", needsReview);
  el.aiMeta.innerHTML = `
    <div class="ai-meta-head">
      <span class="ai-meta-title">Automatische Datenprüfung</span>
      <span class="ai-meta-state ${needsReview ? "warn" : "ok"}">${needsReview ? "Prüfen" : "Geprüft"}</span>
    </div>
    <p class="ai-meta-summary">${escapeHtml(summary)}</p>
    <div class="ai-checks">
      ${checks
        .map(
          (check) =>
            `<span class="ai-check ${check.ok ? "ok" : "warn"}"><b>${escapeHtml(check.label)}</b>${escapeHtml(check.detail)}</span>`
        )
        .join("")}
    </div>
  `;
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
  mapState.marker = window.L.marker([47.3925, 8.0442], {
    icon: createLocationMarkerIcon(),
    title: "Standort des Baugesuchs",
    alt: "Standort des Baugesuchs",
    keyboard: true
  }).addTo(mapState.instance);
  mapState.overlayGroup = window.L.featureGroup().addTo(mapState.instance);
  return mapState.instance;
}

function enableExternalMapTiles() {
  const map = ensureMap();
  if (!map || !window.L) return;
  mapState.externalTilesAllowed = true;
  if (!mapState.tileLayer) {
    mapState.tileLayer = window.L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: "&copy; OpenStreetMap"
    }).addTo(map);
  }
  el.mapPrivacy?.classList.add("hidden");
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
