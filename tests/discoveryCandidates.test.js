import test from "node:test";
import assert from "node:assert/strict";
import {
  collectDiscoveryCandidatesFromHtml,
  mergeDiscoveryCandidate,
  scoreDiscoveryCandidateContent
} from "../server/services/discovery/discoveryCandidates.js";

test("scoreDiscoveryCandidateContent: starke Publikationsseite punktet hoch", () => {
  const score = scoreDiscoveryCandidateContent(
    "https://gemeinde.ch/baugesuche",
    "<a>Baugesuch</a> Baugesuche Baupublikation Baugesuchspublikation oeffentliche auflage bauherrschaft bauobjekt parzelle einsprachefrist"
  );
  assert.ok(score > 20, `erwartete hohe Punktzahl, war ${score}`);
});

test("scoreDiscoveryCandidateContent: ohne Publikationsbezug -> negativ", () => {
  assert.equal(scoreDiscoveryCandidateContent("https://gemeinde.ch/kontakt", "Kontakt und Impressum"), -1);
  // URL hat Publikationswort, Seite aber nicht und keine Baubegriffe -> verworfen.
  assert.equal(scoreDiscoveryCandidateContent("https://gemeinde.ch/baugesuche", "nur text ohne treffer hier"), -1);
});

test("scoreDiscoveryCandidateContent: erteilte Bewilligungen werden abgestraft", () => {
  const strong = scoreDiscoveryCandidateContent("https://gemeinde.ch/baugesuche", "Baugesuche Baupublikation bauherrschaft parzelle");
  const penalized = scoreDiscoveryCandidateContent(
    "https://gemeinde.ch/baugesuche",
    "Baugesuche Baupublikation bauherrschaft parzelle. Erteilte Baubewilligungen Liste."
  );
  assert.ok(penalized < strong, "nonPending-Strafe senkt den Score");
});

test("scoreDiscoveryCandidateContent: Einzel-Publikationspfad wird abgewertet", () => {
  const listing = scoreDiscoveryCandidateContent("https://gemeinde.ch/baugesuche", "Baugesuche Baupublikation bauherrschaft parzelle");
  const detail = scoreDiscoveryCandidateContent(
    "https://gemeinde.ch/news-detail/123",
    "Baugesuche Baupublikation bauherrschaft parzelle"
  );
  assert.ok(detail < listing, "Detailpfad-Strafe greift");
});

test("collectDiscoveryCandidatesFromHtml: sammelt Treffer, ignoriert Fremdthemen", () => {
  const candidates = collectDiscoveryCandidatesFromHtml(
    '<a href="/baugesuche">Baugesuche Publikation</a><a href="/einbuergerung">Einbürgerung</a>',
    "https://gemeinde.ch/"
  );
  assert.ok(candidates.has("https://gemeinde.ch/baugesuche"));
  assert.equal(candidates.has("https://gemeinde.ch/einbuergerung"), false, "Fremdthema verworfen");
  // Ungueltige Basis-URL -> leere Map.
  assert.equal(collectDiscoveryCandidatesFromHtml("<a href='/x'>y</a>", "kein-url").size, 0);
});

test("mergeDiscoveryCandidate: hoechster Score gewinnt, unsichere URLs raus", () => {
  const target = new Map();
  mergeDiscoveryCandidate(target, "https://gemeinde.ch/a", 5);
  mergeDiscoveryCandidate(target, "https://gemeinde.ch/a", 3);
  mergeDiscoveryCandidate(target, "ftp://intern/a", 9);
  const values = [...target.values()];
  assert.equal(values.length, 1);
  assert.equal(values[0].score, 5);
});
