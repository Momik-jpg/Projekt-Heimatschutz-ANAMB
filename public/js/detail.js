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
  el.mapPrivacy?.classList.add("hidden");
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
  el.mapStatus.textContent = `Lokale Darstellung · ${formatSwissCoordinates(parsedCoordinates)}`;
  el.mapPrivacy?.classList.toggle("hidden", mapState.externalTilesAllowed);
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
  el.mapStatus.textContent = "Amtliche AGIS-Hinweise werden geladen";

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
  // Druck-Button nur aktiv, wenn ein Fall geöffnet ist - sonst täte er stumm nichts.
  if (el.printBtn) {
    el.printBtn.disabled = !item;
    el.printBtn.title = item ? "Fall drucken / als PDF" : "Zum Drucken zuerst einen Fall öffnen";
  }
  if (!item) {
    el.detailEmpty.classList.remove("hidden");
    el.detailBody.classList.add("hidden");
    el.detailStatusBadge.textContent = "Keine Auswahl";
    el.detailHelper.textContent = "Entscheidung, Karte und interne Bearbeitung.";
    el.aiMeta?.classList.add("hidden");
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
  el.fDue.innerHTML = `${escapeHtml(formatDate(item.deadlineDate))} <span class="cell-due-meta cell-due-meta-inline ${due.cls}">· ${escapeHtml(due.txt)}</span>`;
  el.fAgis.textContent = item.agisMatch || protection.label;
  el.fProject.textContent = readableProject(item);
  el.projectScale.textContent = ({ klein: "Klein", mittel: "Mittel", gross: "Gross", unbekannt: "Unbekannt" })[item.projectScale] || "Unbekannt";
  el.projectScale.className = `project-scale scale-${item.projectScale || "unbekannt"}`;
  const sourceUrl = String(item.sourceUrl || "").trim();
  const hasSourceUrl = /^https?:\/\//i.test(sourceUrl);
  el.sourceLink.classList.toggle("hidden", !hasSourceUrl);
  el.sourceLink.href = hasSourceUrl ? sourceUrl : "#";
  el.sourceLink.textContent = /\.pdf(?:$|[?#])/i.test(sourceUrl) ? "Original-PDF öffnen" : "Originalquelle öffnen";
  el.agisLink.href = agisHref(item);
  el.agisLink.textContent = buildDataLinkLabel(item);
  el.recTitle.textContent = recommendationTitle(item);
  el.recText.textContent = recommendationText(item);
  el.recBadge.className = `badge ${protection.cls}`;
  el.recBadge.textContent = protection.label;
  el.dueBadge.className = `badge ${due.cls === "due-over" ? "danger" : due.cls === "due-soon" ? "warning" : "neutral"}`;
  el.dueBadge.textContent = `Frist ${formatDate(item.deadlineDate)} · ${due.txt}`;
  el.srcMeta.textContent = `Quelle: ${item.source || "unbekannt"}${item.sourceReference ? ` · ${item.sourceReference}` : ""}`;
  renderAiMeta(item);
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

async function selectItem(id) {
  state.selectedId = id;
  const item = state.items.find((entry) => entry.id === id);
  const wasUnread = item && !item.isRead;
  if (wasUnread) item.isRead = true;
  renderTable();
  renderDetail();
  loadComments(id);
  if (wasUnread) {
    try {
      await requestJson(`/api/applications/${encodeURIComponent(id)}/read`, { method: "POST" });
    } catch (error) {
      item.isRead = false;
      renderTable();
      toast(`Lesestatus konnte nicht gespeichert werden: ${error.message}`);
    }
  }
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
  const maintenance = Math.max(0, total - enabled);
  const missing = Math.max(0, total - (summary.configuredCount ?? 0));
  const statRow = $("#pane-sources .stat-row");
  if (!statRow) return;
  const pct = total ? Math.round((enabled / total) * 100) : 0;
  statRow.innerHTML = `
    <div class="stat"><p class="k">Gemeinden total</p><p class="v">${escapeHtml(total)}</p><p class="d mut">Kanton Aargau</p></div>
    <div class="stat"><p class="k">Quelle aktiv</p><p class="v">${escapeHtml(enabled)}<small> /${escapeHtml(total)}</small></p><div class="progress" role="progressbar" aria-label="Aktive Quellen" aria-valuemin="0" aria-valuemax="100" data-progress="${escapeHtml(pct)}"><span></span></div></div>
    <div class="stat"><p class="k">Datenqualität Ø</p><p class="v">${high ? "Hoch" : "Offen"}</p><p class="d up">${escapeHtml(high)} strukturiert</p></div>
    <div class="stat"><p class="k">Wartung nötig</p><p class="v">${escapeHtml(maintenance)}</p><p class="d warn">nicht aktiv</p></div>
    <div class="stat"><p class="k">Ohne Quelle</p><p class="v">${escapeHtml(missing)}</p><p class="d mut">manuell erfassen</p></div>`;
  applyProgressBars(statRow);
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

function iconSvg(name) {
  const attrs = 'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"';
  const icons = {
    edit: `<svg ${attrs}><path d="M12 20h9"></path><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"></path></svg>`,
    lock: `<svg ${attrs}><rect x="4" y="11" width="16" height="9" rx="2"></rect><path d="M8 11V8a4 4 0 0 1 8 0v3"></path></svg>`,
    unlock: `<svg ${attrs}><rect x="4" y="11" width="16" height="9" rx="2"></rect><path d="M8 11V8a4 4 0 0 1 7.5-2"></path></svg>`,
    trash: `<svg ${attrs}><path d="M3 6h18"></path><path d="M8 6V4h8v2"></path><path d="M19 6l-1 14H6L5 6"></path><path d="M10 11v5M14 11v5"></path></svg>`,
    close: `<svg ${attrs}><path d="M18 6 6 18"></path><path d="m6 6 12 12"></path></svg>`,
    external: `<svg ${attrs}><path d="M14 3h7v7"></path><path d="M10 14 21 3"></path><path d="M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5"></path></svg>`
  };
  return icons[name] ?? "";
}

function renderSources() {
  renderSourceStats();
  if (!isMaster()) {
    el.srcBody.innerHTML = `<tr><td colspan="8"><div class="empty-state"><h3>Nur Master-Konto</h3><p>Gemeindequellen und Zugriffsschlüssel sind nur mit Master-Rechten bearbeitbar.</p></div></td></tr>`;
    return;
  }
  const rows = sourceRows();
  const hitsByMunicipality = new Map();
  state.items.forEach((item) => {
    hitsByMunicipality.set(item.municipality, (hitsByMunicipality.get(item.municipality) ?? 0) + 1);
  });

  el.srcBody.innerHTML = rows
    .map((source) => {
      const quality = qualityMeta(source);
      const operational = source.operational ?? {};
      const hits = hitsByMunicipality.get(source.municipality) ?? 0;
      const status = source.enabled ? (source.uncertain ? ["warn", "Indirekt"] : ["ok", "Aktiv"]) : ["off", "Keine Quelle"];
      const bars = [1, 2, 3].map((index) => `<span class="qbar ${index <= quality.level ? "on" : ""}"></span>`).join("");
      return `<tr>
        <td><div class="adm-name">${escapeHtml(source.municipality)}</div><div class="adm-sub">${escapeHtml(source.primarySourceOperator || "Region Aargau")}</div></td>
        <td>${escapeHtml(SOURCE_TYPE[source.sourceType] ?? source.sourceType ?? "-")}</td>
        <td><div class="qmeter ${quality.cls}"><span class="qbars">${bars}</span><span class="qlabel">${escapeHtml(quality.label)}</span></div><div class="adm-sub">${escapeHtml(quality.note)}</div></td>
        <td><div class="spark-wrap">${sparkSVG(source, hits)}<span class="spark-sum">${escapeHtml(hits)}<small>diese Woche</small></span></div></td>
        <td class="adm-sub adm-sub-compact">${escapeHtml(formatDateTime(operational.updatedAt))}</td>
        <td><span class="adm-name">${escapeHtml(hits)}</span></td>
        <td><span class="pill ${status[0]}">${escapeHtml(status[1])}</span></td>
        <td class="cell-actions"><span class="row-actions">
          <button class="icon-btn" title="Quelle öffnen" aria-label="Quelle öffnen" data-source-open="${escapeHtml(source.primaryDirectUrl || operational.sourceUrl || "")}">${iconSvg("external")}</button>
          <button class="icon-btn" title="Bearbeiten" aria-label="Quelle bearbeiten" data-source-edit="${escapeHtml(source.operationalId || operational.id || "")}">${iconSvg("edit")}</button>
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
  const syncPaused = sync.enabled === false;
  const nextRunLabel = job.nextRunAt ? formatDateTime(job.nextRunAt) : syncPaused ? "Automatik pausiert" : "Noch nicht geplant";
  const intervalValue = job.nextRunAt ? (sync.intervalHours ?? 168) : "-";
  const intervalUnit = job.nextRunAt ? "Std." : syncPaused ? "pausiert" : "offen";
  if (statRow) {
    statRow.innerHTML = `
      <div class="stat"><p class="k">Letzter Lauf</p><p class="v stat-time">${escapeHtml(formatDateTime(job.lastSuccessAt || job.lastRunAt))}</p><p class="d ${job.status === "error" ? "warn" : "up"}">${escapeHtml(statusLabel)}</p></div>
      <div class="stat"><p class="k">Neue Baugesuche</p><p class="v">${escapeHtml(job.lastImportedCount ?? 0)}</p><p class="d up">letzter Import</p></div>
      <div class="stat"><p class="k">AGIS-Treffer</p><p class="v">${escapeHtml(protectionHits)}</p><p class="d warn">zu prüfen</p></div>
      <div class="stat"><p class="k">Fehlerquellen</p><p class="v">${job.lastError ? "1" : "0"}</p><p class="d ${job.lastError ? "warn" : "mut"}">${escapeHtml(job.lastError ? truncate(job.lastError, 38) : "keine")}</p></div>`;
  }
  el.runList.innerHTML = `
    <div class="run-item"><span class="run-dot ${job.status === "error" ? "err" : "ok"}"></span><div class="run-main"><div class="t">${escapeHtml(sync.sourceLabel || "Gemeindequellen")}</div><div class="m">Letzter Lauf: ${escapeHtml(formatDateTime(job.lastRunAt))}</div></div><div class="run-num"><div class="n">${escapeHtml(job.lastImportedCount ?? 0)}</div><div class="u">Importe</div></div></div>
    <div class="run-item"><span class="run-dot run-now"></span><div class="run-main"><div class="t">Nächster geplanter Lauf</div><div class="m">${escapeHtml(nextRunLabel)}</div></div><div class="run-num"><div class="n">${escapeHtml(intervalValue)}</div><div class="u">${escapeHtml(intervalUnit)}</div></div></div>`;
}

function renderKeys() {
  if (!isMaster()) {
    el.keysBody.innerHTML = `<tr><td colspan="5"><div class="empty-state"><h3>Nur Master-Konto</h3><p>Zugänge und Registrierungsschlüssel sind nur mit Master-Rechten sichtbar.</p></div></td></tr>`;
    return;
  }
  const userRows = state.adminUsers.map((user) => {
    const active = user.active !== false;
    // Eigenes Konto und Master-Konto sind vor Sperren/Löschen geschützt.
    const protectedAccount = user.role === "Master" || user.id === state.currentUser?.id;
    const statusPill = active
      ? `<span class="pill ok">Aktiv</span>`
      : `<span class="pill warn">Gesperrt</span>`;
    const lockBtn = protectedAccount
      ? ""
      : `<button class="icon-btn" title="${active ? "Konto sperren" : "Konto entsperren"}" aria-label="${active ? "Konto sperren" : "Konto entsperren"}" data-user-lock="${escapeHtml(user.id)}" data-active="${active ? "1" : "0"}">${active ? iconSvg("lock") : iconSvg("unlock")}</button>`;
    const deleteBtn = protectedAccount
      ? ""
      : `<button class="icon-btn danger" title="Konto löschen" aria-label="Konto löschen" data-user-delete="${escapeHtml(user.id)}">${iconSvg("trash")}</button>`;
    return `<tr>
    <td><div class="adm-name">${escapeHtml(user.displayName)}</div><div class="adm-sub">${escapeHtml(user.username || "")}</div></td>
    <td>${escapeHtml(user.role || "-")}</td>
    <td class="mono">Benutzerkonto</td>
    <td>${statusPill}</td>
    <td class="cell-actions"><span class="row-actions"><button class="icon-btn" title="Passwort setzen" aria-label="Passwort setzen" data-user-reset="${escapeHtml(user.id)}">${iconSvg("edit")}</button>${lockBtn}${deleteBtn}</span></td>
  </tr>`;
  });
  const keyRows = state.registrationKeys.map((key) => {
    const used = Boolean(key.usedAt);
    return `<tr>
      <td><div class="adm-name">${used ? "Verwendeter Registrierungsschlüssel" : "Registrierungsschlüssel"}</div><div class="adm-sub">${escapeHtml(key.note || "Einladung")} · ${escapeHtml(used ? `verwendet ${formatDateTime(key.usedAt)}` : `gültig bis ${formatDateTime(key.expiresAt)}`)}</div></td>
      <td>Registrierung</td>
      <td class="mono">${escapeHtml(key.keyCode)}</td>
      <td><span class="pill ${used ? "warn" : "ok"}">${used ? "Verwendet" : "Offen"}</span></td>
      <td class="cell-actions"><span class="row-actions">${used ? "" : `<button class="icon-btn danger" title="Löschen" aria-label="Schlüssel löschen" data-key-delete="${escapeHtml(key.id)}">${iconSvg("close")}</button>`}</span></td>
    </tr>`;
  });
  el.keysBody.innerHTML = [...userRows, ...keyRows].join("") || `<tr><td colspan="5"><div class="empty-state"><h3>Keine Zugänge gefunden</h3></div></td></tr>`;
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
  if (state.selectedId && !state.items.some((item) => item.id === state.selectedId)) {
    state.selectedId = null;
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
  await Promise.all([loadDashboard(), loadApplications()]);
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
  $$(".nav-item").forEach((button) => {
    button.classList.toggle("active", button.dataset.view === view);
  });
  $$(".view").forEach((node) => {
    node.classList.toggle("active", node.id === `view-${view}`);
  });
}

function switchPane(pane) {
  $$(".rail-item").forEach((button) => {
    button.classList.toggle("active", button.dataset.pane === pane);
  });
  $$(".admin-pane").forEach((node) => {
    node.classList.toggle("active", node.id === `pane-${pane}`);
  });
}
