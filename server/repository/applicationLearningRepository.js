import { createHash } from "node:crypto";

const learnedProtectionStatuses = new Set([
  "no-hit",
  "protected-point",
  "protected-zone",
  "combined-hit",
  "manual-review"
]);

const stopWords = new Set([
  "der",
  "die",
  "das",
  "den",
  "dem",
  "des",
  "ein",
  "eine",
  "einer",
  "eines",
  "und",
  "oder",
  "mit",
  "von",
  "vom",
  "zur",
  "zum",
  "fur",
  "auf",
  "im",
  "im",
  "in",
  "am",
  "an",
  "bei",
  "gegen",
  "bestehend",
  "bestehenden",
  "modern",
  "neue",
  "neuer",
  "baugesuch",
  "bauvorhaben"
]);

function normalizeKey(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replaceAll("\u00df", "ss")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function tokenSignature(value, { maxTokens = 10 } = {}) {
  const seen = new Set();

  for (const token of normalizeKey(value).split(/\s+/)) {
    if (token.length < 3 || stopWords.has(token)) {
      continue;
    }

    seen.add(token);
  }

  return [...seen].sort().slice(0, maxTokens).join(" ");
}

function buildSignature(item) {
  return {
    municipalityKey: normalizeKey(item?.municipality),
    municipality: String(item?.municipality ?? "").trim(),
    addressSignature: tokenSignature([item?.address, item?.parcel].filter(Boolean).join(" "), { maxTokens: 8 }),
    projectSignature: tokenSignature([item?.projectType, item?.description].filter(Boolean).join(" "), { maxTokens: 12 })
  };
}

function tokenOverlap(a, b) {
  const left = new Set(String(a ?? "").split(/\s+/).filter(Boolean));
  const right = new Set(String(b ?? "").split(/\s+/).filter(Boolean));

  if (!left.size || !right.size) {
    return 0;
  }

  let hits = 0;
  for (const token of left) {
    if (right.has(token)) {
      hits += 1;
    }
  }

  return hits / Math.max(left.size, right.size);
}

function parseLayers(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => String(entry).trim()).filter(Boolean);
  }

  try {
    const parsed = JSON.parse(String(value ?? "[]"));
    return Array.isArray(parsed) ? parsed.map((entry) => String(entry).trim()).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function clampConfidence(value) {
  const number = Number(value);

  if (!Number.isFinite(number)) {
    return 0.82;
  }

  return Math.min(0.98, Math.max(0.35, number));
}

function defaultAgisMatch(protectionStatus) {
  if (protectionStatus === "combined-hit") {
    return "ISOS-Fläche und Gebäude im Inventar";
  }

  if (protectionStatus === "protected-point") {
    return "Treffer im Gebäudeinventar";
  }

  if (protectionStatus === "protected-zone") {
    return "Treffer in ISOS-Fläche";
  }

  if (protectionStatus === "manual-review") {
    return "Noch nicht eindeutig zugeordnet";
  }

  return "Kein Schutztreffer";
}

function mapRow(row, score = 0) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    municipalityKey: row.municipality_key,
    municipality: row.municipality,
    addressSignature: row.address_signature,
    projectSignature: row.project_signature,
    protectionStatus: row.protection_status,
    agisMatch: row.agis_match,
    agisLayers: parseLayers(row.agis_layers),
    automatedAssessment: row.automated_assessment,
    confidence: Number(row.confidence ?? 0),
    matchCount: Number(row.match_count ?? 0),
    createdFromApplicationId: row.created_from_application_id,
    createdByUserId: row.created_by_user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    score
  };
}

function buildRuleId(signature) {
  const hash = createHash("sha1")
    .update([signature.municipalityKey, signature.addressSignature, signature.projectSignature].join("|"))
    .digest("hex");
  return `LRN-${hash.slice(0, 14).toUpperCase()}`;
}

function scoreRule(signature, row) {
  let score = 0.2;

  if (signature.addressSignature && row.address_signature) {
    score += signature.addressSignature === row.address_signature
      ? 0.45
      : tokenOverlap(signature.addressSignature, row.address_signature) * 0.35;
  }

  if (signature.projectSignature && row.project_signature) {
    score += signature.projectSignature === row.project_signature
      ? 0.25
      : tokenOverlap(signature.projectSignature, row.project_signature) * 0.2;
  }

  return Math.min(1, score) * clampConfidence(row.confidence);
}

export function createApplicationLearningRepository(
  db,
  { minimumScore = 0.45, confidentScore = 0.52 } = {}
) {
  const upsertStatement = db.prepare(`
    INSERT INTO application_learning_rules (
      id,
      municipality_key,
      municipality,
      address_signature,
      project_signature,
      protection_status,
      agis_match,
      agis_layers,
      automated_assessment,
      confidence,
      match_count,
      created_from_application_id,
      created_by_user_id,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
    ON CONFLICT(municipality_key, address_signature, project_signature) DO UPDATE SET
      municipality = excluded.municipality,
      protection_status = excluded.protection_status,
      agis_match = excluded.agis_match,
      agis_layers = excluded.agis_layers,
      automated_assessment = excluded.automated_assessment,
      confidence = CASE
        WHEN application_learning_rules.protection_status = excluded.protection_status
          THEN MIN(0.98, application_learning_rules.confidence + 0.04)
        ELSE 0.72
      END,
      match_count = application_learning_rules.match_count + 1,
      created_by_user_id = COALESCE(NULLIF(excluded.created_by_user_id, ''), application_learning_rules.created_by_user_id),
      updated_at = excluded.updated_at
  `);

  const findBySignatureStatement = db.prepare(`
    SELECT *
    FROM application_learning_rules
    WHERE municipality_key = ?
      AND address_signature = ?
      AND project_signature = ?
    LIMIT 1
  `);

  const listByMunicipalityStatement = db.prepare(`
    SELECT *
    FROM application_learning_rules
    WHERE municipality_key = ?
    ORDER BY confidence DESC, match_count DESC, updated_at DESC
    LIMIT 25
  `);

  const summaryStatement = db.prepare(`
    SELECT
      COUNT(*) AS total_rules,
      COALESCE(SUM(match_count), 0) AS total_matches,
      COALESCE(AVG(confidence), 0) AS average_confidence,
      MAX(updated_at) AS last_trained_at
    FROM application_learning_rules
  `);

  return {
    recordFromApplication(item, { userId = "", force = false } = {}) {
      if (!item || !learnedProtectionStatuses.has(item.protectionStatus)) {
        return null;
      }

      if (!force && !["cleared", "archived"].includes(item.workflowStatus)) {
        return null;
      }

      const signature = buildSignature(item);

      if (!signature.municipalityKey || (!signature.addressSignature && !signature.projectSignature)) {
        return null;
      }

      const now = new Date().toISOString();
      const agisMatch = String(item.agisMatch || defaultAgisMatch(item.protectionStatus));
      const automatedAssessment = String(
        item.automatedAssessment ||
          `Teamentscheid bestätigt: ${agisMatch}. Diese Regel wird bei ähnlichen Baugesuchen wiederverwendet.`
      );

      upsertStatement.run(
        buildRuleId(signature),
        signature.municipalityKey,
        signature.municipality,
        signature.addressSignature,
        signature.projectSignature,
        item.protectionStatus,
        agisMatch,
        JSON.stringify(parseLayers(item.agisLayers)),
        automatedAssessment,
        0.82,
        String(item.id ?? ""),
        String(userId ?? ""),
        now,
        now
      );

      return mapRow(
        findBySignatureStatement.get(signature.municipalityKey, signature.addressSignature, signature.projectSignature),
        1
      );
    },

    findBestMatch(item) {
      const signature = buildSignature(item);

      if (!signature.municipalityKey || (!signature.addressSignature && !signature.projectSignature)) {
        return null;
      }

      const rows = listByMunicipalityStatement.all(signature.municipalityKey);
      let best = null;

      for (const row of rows) {
        const score = scoreRule(signature, row);

        if (!best || score > best.score) {
          best = mapRow(row, score);
        }
      }

      return best && best.score >= minimumScore ? best : null;
    },

    applyToItem(item) {
      const rule = this.findBestMatch(item);

      if (!rule) {
        return { item, rule: null, score: 0 };
      }

      const scorePercent = Math.round(rule.score * 100);
      const ruleHint = rule.agisMatch || defaultAgisMatch(rule.protectionStatus);
      // Nur bei klarer Ähnlichkeit die gelernte Einstufung direkt übernehmen.
      // Schwache Treffer werden zur Sicherheit auf "Von Hand prüfen" gelegt,
      // statt blind als geschützt/nicht geschützt eingestuft zu werden.
      const isConfident = rule.score >= confidentScore && rule.protectionStatus !== "manual-review";
      const protectionStatus = isConfident ? rule.protectionStatus : "manual-review";
      const agisMatch = isConfident ? ruleHint : "Noch nicht eindeutig zugeordnet";
      const automatedAssessment = isConfident
        ? rule.automatedAssessment ||
          `Aus ähnlichen bestätigten Baugesuchen wurde "${ruleHint}" übernommen.`
        : `Ähnlich zu einem bestätigten Fall ("${ruleHint}"), aber nicht eindeutig - bitte von Hand prüfen.`;

      return {
        item: {
          ...item,
          protectionStatus,
          agisMatch,
          agisLayers: isConfident ? rule.agisLayers : [],
          automatedAssessment: `Lernregel ${scorePercent}%: ${automatedAssessment}`,
          ambiguousAddress: protectionStatus === "manual-review" ? item.ambiguousAddress || 1 : 0
        },
        rule,
        score: rule.score
      };
    },

    getSummary() {
      const row = summaryStatement.get();
      return {
        totalRules: Number(row?.total_rules ?? 0),
        totalMatches: Number(row?.total_matches ?? 0),
        averageConfidence: Number(row?.average_confidence ?? 0),
        lastTrainedAt: row?.last_trained_at ?? null
      };
    }
  };
}
