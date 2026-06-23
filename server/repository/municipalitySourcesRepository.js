import { encryptToken, decryptToken } from "../services/tokenCrypto.js";

export const municipalitySourceTypes = ["manual", "html", "xml", "json", "arcgis", "pdf"];
export const municipalityDigitalStatuses = ["unknown", "digital", "partial", "manual"];

function mapOperationalRow(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    municipality: row.municipality,
    sourceType: row.source_type,
    sourceUrl: row.source_url,
    // Token wird at-rest verschluesselt abgelegt; hier fuer den internen
    // Sync-Gebrauch entschluesselt. Die API schwaerzt ihn separat.
    sourceToken: decryptToken(row.source_token),
    includePattern: row.include_pattern,
    excludePattern: row.exclude_pattern,
    enabled: Boolean(row.enabled),
    digitalStatus: row.digital_status,
    notes: row.notes,
    updatedAt: row.updated_at
  };
}

function splitGroupedValues(value, separator = "§§") {
  return String(value ?? "")
    .split(separator)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function parseSupplementalSources(value) {
  return splitGroupedValues(value).map((entry) => {
    const [name = "", sourceKind = "", directUrl = "", canonicalUrl = "", sharedHint = ""] = entry.split("||");
    return {
      name,
      sourceKind,
      directUrl,
      canonicalUrl,
      sharedHint
    };
  });
}

function mapCatalogRow(row) {
  if (!row) {
    return null;
  }

  const supplementalSources = parseSupplementalSources(row.supplemental_sources);
  const sharedPrimaryCount = Number(row.primary_shared_count ?? 0);
  const primaryShared = sharedPrimaryCount > 1 || Boolean(row.primary_is_shared);

  return {
    municipalityId: row.municipality_id,
    operationalId: row.operational_id,
    municipality: row.municipality,
    officialWebsite: row.official_website,
    primarySourceId: row.primary_source_id,
    primarySourceName: row.primary_source_name,
    primarySourceKind: row.primary_source_kind,
    primarySourceOperator: row.primary_source_operator,
    primarySourceCanonicalUrl: row.primary_source_canonical_url,
    primaryDirectUrl: row.primary_direct_url,
    sourceType: row.source_type,
    enabled: Boolean(row.enabled),
    digitalStatus: row.digital_status,
    includePattern: row.include_pattern,
    excludePattern: row.exclude_pattern,
    notes: row.notes,
    rating: row.rating,
    rationale: row.rationale,
    sharedSourceNote: row.shared_source_note,
    uncertain: Boolean(row.uncertain),
    primaryShared,
    primarySharedCount: sharedPrimaryCount,
    supplementalSources,
    sourceCount: 1 + supplementalSources.length
  };
}

function buildCatalogQuery(search = "") {
  const conditions = [];
  const params = [];
  const normalizedSearch = String(search ?? "").trim();

  if (normalizedSearch) {
    const pattern = `%${normalizedSearch}%`;
    conditions.push(`
      (
        m.name LIKE ?
        OR m.official_website LIKE ?
        OR IFNULL(primary_source.name, '') LIKE ?
        OR IFNULL(primary_source.canonical_url, '') LIKE ?
        OR IFNULL(ms.source_url, '') LIKE ?
        OR IFNULL(quality.rating, '') LIKE ?
        OR IFNULL(quality.rationale, '') LIKE ?
      )
    `);
    params.push(pattern, pattern, pattern, pattern, pattern, pattern, pattern);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  return {
    sql: `
      SELECT
        m.id AS municipality_id,
        m.name AS municipality,
        m.official_website,
        ms.id AS operational_id,
        quality.primary_source_id,
        primary_source.name AS primary_source_name,
        primary_source.source_kind AS primary_source_kind,
        primary_source.operator_name AS primary_source_operator,
        primary_source.canonical_url AS primary_source_canonical_url,
        primary_source.is_shared AS primary_is_shared,
        COALESCE(ms.source_url, primary_link.direct_url, m.official_website, '') AS primary_direct_url,
        COALESCE(ms.source_type, primary_link.source_type, 'manual') AS source_type,
        COALESCE(ms.enabled, primary_link.enabled, 0) AS enabled,
        COALESCE(ms.digital_status, primary_link.digital_status, 'unknown') AS digital_status,
        COALESCE(ms.include_pattern, primary_link.include_pattern, '') AS include_pattern,
        COALESCE(ms.exclude_pattern, primary_link.exclude_pattern, '') AS exclude_pattern,
        COALESCE(ms.notes, primary_link.notes, '') AS notes,
        quality.rating,
        quality.rationale,
        quality.shared_source_note,
        quality.uncertain,
        (
          SELECT COUNT(DISTINCT link2.municipality_id)
          FROM municipality_source_links link2
          WHERE link2.source_id = quality.primary_source_id
            AND link2.relation_type = 'primary'
        ) AS primary_shared_count,
        (
          SELECT GROUP_CONCAT(
            other_source.name || '||' ||
            other_source.source_kind || '||' ||
            IFNULL(link3.direct_url, '') || '||' ||
            IFNULL(other_source.canonical_url, '') || '||' ||
            IFNULL(link3.shared_hint, ''),
            '§§'
          )
          FROM municipality_source_links link3
          JOIN publication_sources other_source
            ON other_source.id = link3.source_id
          WHERE link3.municipality_id = m.id
            AND link3.relation_type <> 'primary'
        ) AS supplemental_sources
      FROM municipalities m
      LEFT JOIN municipality_quality_assessments quality
        ON quality.municipality_id = m.id
      LEFT JOIN publication_sources primary_source
        ON primary_source.id = quality.primary_source_id
      LEFT JOIN municipality_source_links primary_link
        ON primary_link.municipality_id = m.id
       AND primary_link.source_id = quality.primary_source_id
       AND primary_link.relation_type = 'primary'
      LEFT JOIN municipality_sources ms
        ON ms.municipality = m.name
      ${whereClause}
      ORDER BY m.name ASC
    `,
    params
  };
}

function buildCoverageReport(catalogItems, sharedSources) {
  const ratings = {
    A: 0,
    B: 0,
    C: 0,
    D: 0
  };

  for (const item of catalogItems) {
    if (ratings[item.rating] !== undefined) {
      ratings[item.rating] += 1;
    }
  }

  return {
    totalMunicipalities: catalogItems.length,
    totalUniqueSources: new Set([
      ...catalogItems.map((item) => item.primarySourceId).filter(Boolean),
      ...sharedSources.map((source) => source.sourceId)
    ]).size,
    municipalitiesWithSharedPrimary: catalogItems.filter((item) => item.primaryShared).length,
    uncertainMunicipalities: catalogItems.filter((item) => item.uncertain).length,
    ratings
  };
}

function buildExportRows(catalogItems) {
  return catalogItems.map((item) => ({
    municipality: item.municipality,
    officialWebsite: item.officialWebsite,
    primarySourceName: item.primarySourceName,
    primarySourceKind: item.primarySourceKind,
    primaryDirectUrl: item.primaryDirectUrl,
    primarySourceCanonicalUrl: item.primarySourceCanonicalUrl,
    rating: item.rating,
    rationale: item.rationale,
    sharedPrimarySource: item.primaryShared ? "ja" : "nein",
    sharedPrimaryCount: item.primarySharedCount,
    sharedSourceNote: item.sharedSourceNote,
    supplementalSources: item.supplementalSources
      .map((source) => `${source.name} (${source.sourceKind})`)
      .join(" | "),
    digitalStatus: item.digitalStatus,
    enabled: item.enabled ? "ja" : "nein",
    uncertain: item.uncertain ? "ja" : "nein"
  }));
}

export function createMunicipalitySourcesRepository(db) {
  function listCatalog(search = "") {
    const { sql, params } = buildCatalogQuery(search);
    return db.prepare(sql).all(...params).map(mapCatalogRow);
  }

  function listSharedSources(limit = 10) {
    const rows = db
      .prepare(`
        SELECT
          ps.id AS source_id,
          ps.name,
          ps.source_kind,
          ps.canonical_url,
          ps.is_shared,
          COUNT(DISTINCT msl.municipality_id) AS municipality_count,
          GROUP_CONCAT(m.name, ' | ') AS municipalities
        FROM municipality_source_links msl
        JOIN publication_sources ps
          ON ps.id = msl.source_id
        JOIN municipalities m
          ON m.id = msl.municipality_id
        GROUP BY ps.id
        HAVING COUNT(DISTINCT msl.municipality_id) > 1
        ORDER BY municipality_count DESC, ps.name ASC
        LIMIT ?
      `)
      .all(limit);

    return rows.map((row) => ({
      sourceId: row.source_id,
      name: row.name,
      sourceKind: row.source_kind,
      canonicalUrl: row.canonical_url,
      isShared: Boolean(row.is_shared),
      municipalityCount: Number(row.municipality_count ?? 0),
      municipalities: splitGroupedValues(String(row.municipalities ?? ""), "|")
    }));
  }

  return {
    listAll() {
      return db
        .prepare(`
          SELECT
            id,
            municipality,
            source_type,
            source_url,
            source_token,
            include_pattern,
            exclude_pattern,
            enabled,
            digital_status,
            notes,
            updated_at
          FROM municipality_sources
          ORDER BY municipality ASC
        `)
        .all()
        .map(mapOperationalRow);
    },

    listEnabledConfigured() {
      return db
        .prepare(`
          SELECT
            id,
            municipality,
            source_type,
            source_url,
            source_token,
            include_pattern,
            exclude_pattern,
            enabled,
            digital_status,
            notes,
            updated_at
          FROM municipality_sources
          WHERE enabled = 1
            AND source_url <> ''
            AND source_type <> 'manual'
          ORDER BY municipality ASC
        `)
        .all()
        .map(mapOperationalRow);
    },

    getById(id) {
      const row = db
        .prepare(`
          SELECT
            id,
            municipality,
            source_type,
            source_url,
            source_token,
            include_pattern,
            exclude_pattern,
            enabled,
            digital_status,
            notes,
            updated_at
          FROM municipality_sources
          WHERE id = ?
        `)
        .get(id);

      return mapOperationalRow(row);
    },

    update(id, changes, updatedAt = new Date().toISOString()) {
      const current = this.getById(id);

      if (!current) {
        return null;
      }

      db.prepare(`
        UPDATE municipality_sources
        SET source_type = ?,
            source_url = ?,
            source_token = ?,
            include_pattern = ?,
            exclude_pattern = ?,
            enabled = ?,
            digital_status = ?,
            notes = ?,
            updated_at = ?
        WHERE id = ?
      `).run(
        changes.sourceType ?? current.sourceType,
        String(changes.sourceUrl ?? current.sourceUrl ?? "").trim(),
        // Leerer/fehlender Token = bestehenden behalten (Schwaerzung im Frontend
        // liefert keinen Klartext zurueck); Ablage stets verschluesselt.
        changes.sourceToken && String(changes.sourceToken).trim()
          ? encryptToken(String(changes.sourceToken).trim())
          : encryptToken(String(current.sourceToken ?? "").trim()),
        String(changes.includePattern ?? current.includePattern ?? "").trim(),
        String(changes.excludePattern ?? current.excludePattern ?? "").trim(),
        changes.enabled === undefined ? (current.enabled ? 1 : 0) : changes.enabled ? 1 : 0,
        changes.digitalStatus ?? current.digitalStatus,
        String(changes.notes ?? current.notes ?? "").trim(),
        updatedAt,
        id
      );

      return this.getById(id);
    },

    getSummary() {
      return db
        .prepare(`
          SELECT
            COUNT(*) AS totalCount,
            SUM(CASE WHEN source_url <> '' THEN 1 ELSE 0 END) AS configuredCount,
            SUM(CASE WHEN enabled = 1 THEN 1 ELSE 0 END) AS enabledCount,
            SUM(CASE WHEN digital_status = 'digital' THEN 1 ELSE 0 END) AS digitalCount,
            SUM(CASE WHEN digital_status = 'partial' THEN 1 ELSE 0 END) AS partialCount,
            SUM(CASE WHEN digital_status = 'manual' THEN 1 ELSE 0 END) AS manualCount,
            SUM(CASE WHEN source_type = 'html' THEN 1 ELSE 0 END) AS htmlCount,
            SUM(CASE WHEN source_type = 'xml' THEN 1 ELSE 0 END) AS xmlCount,
            SUM(CASE WHEN source_type = 'json' THEN 1 ELSE 0 END) AS jsonCount,
            SUM(CASE WHEN source_type = 'arcgis' THEN 1 ELSE 0 END) AS arcgisCount,
            SUM(CASE WHEN source_type = 'pdf' THEN 1 ELSE 0 END) AS pdfCount
          FROM municipality_sources
        `)
        .get();
    },

    listCatalog(search = "") {
      return listCatalog(search);
    },

    getCatalogItemByMunicipality(municipality) {
      const normalizedMunicipality = String(municipality ?? "").trim();
      if (!normalizedMunicipality) return null;
      return listCatalog(normalizedMunicipality).find((item) => item.municipality === normalizedMunicipality) ?? null;
    },

    listSharedSources(limit = 10) {
      return listSharedSources(limit);
    },

    getCoverageReport() {
      const catalogItems = listCatalog();
      const sharedSources = listSharedSources(25);
      return buildCoverageReport(catalogItems, sharedSources);
    },

    getCoverageSnapshot(search = "") {
      const catalogItems = listCatalog(search);
      const sharedSources = listSharedSources(10);
      return {
        catalogItems,
        sharedSources,
        report: buildCoverageReport(listCatalog(), listSharedSources(25))
      };
    },

    exportCoverageRows() {
      return buildExportRows(listCatalog());
    }
  };
}
