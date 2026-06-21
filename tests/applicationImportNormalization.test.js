import test from "node:test";
import assert from "node:assert/strict";
import {
  cleanImportedAddress,
  extractPublicationDateRange,
  normalizeImportedDates,
  stripMarkupTags
} from "../server/domain/applicationImportNormalization.js";

test("liest Datumsbereiche, wenn nur das Enddatum ein Jahr enthält", () => {
  assert.deepEqual(
    extractPublicationDateRange("Das Baugesuch liegt vom 5. Juni bis 6. Juli 2026 öffentlich auf."),
    { publicationDate: "2026-06-05", deadlineDate: "2026-07-06" }
  );
  assert.deepEqual(
    extractPublicationDateRange("Öffentliche Auflage 22.05. - 22.06.2026"),
    { publicationDate: "2026-05-22", deadlineDate: "2026-06-22" }
  );
});

test("übernimmt den Datumsbereich und weist unplausible zukünftige Publikationen nicht als Fakt aus", () => {
  assert.deepEqual(
    normalizeImportedDates({
      publicationDate: "2026-07-06",
      deadlineDate: "2026-07-06",
      text: "Auflage vom 5. Juni bis 6. Juli 2026",
      referenceDate: new Date("2026-06-20T12:00:00.000Z")
    }),
    { publicationDate: "2026-06-05", deadlineDate: "2026-07-06" }
  );
  assert.deepEqual(
    normalizeImportedDates({
      publicationDate: "2026-07-03",
      deadlineDate: "2026-07-03",
      text: "Einsprachfrist bis 03.07.2026",
      referenceDate: new Date("2026-06-20T12:00:00.000Z")
    }),
    { publicationDate: "", deadlineDate: "2026-07-03" }
  );
});

test("entfernt importierte HTML- und Seitentextreste aus Adressen", () => {
  assert.equal(
    cleanImportedAddress('Bahnhofstrasse 5/7 box box-large box-mainbox" data-index="68" data-detailurl="/fall"'),
    "Bahnhofstrasse 5/7"
  );
  assert.equal(
    cleanImportedAddress("Dorfstrasse 24 Gegen das obenstehende Baugesuch kann Einsprache erhoben werden."),
    "Dorfstrasse 24"
  );
  assert.equal(cleanImportedAddress("<strong>Steigstrasse 28</strong>"), "Steigstrasse 28");
  assert.equal(stripMarkupTags("vor <b>fett</b> nach"), "vor  fett  nach");
});
