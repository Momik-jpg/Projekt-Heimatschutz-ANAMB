import test from "node:test";
import assert from "node:assert/strict";
import { isPrivateOrReservedIp, assertPublicHost } from "../server/services/safeFetch.js";

// S1: SSRF-Schutz. IP-Klassifikation deterministisch, Host-Check mit injiziertem
// DNS-Lookup (kein echtes Netzwerk noetig).

test("isPrivateOrReservedIp erkennt private/reservierte IPv4", () => {
  for (const ip of [
    "127.0.0.1",
    "10.0.0.5",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254", // Cloud-Metadaten
    "100.64.0.1",
    "0.0.0.0",
    "224.0.0.1"
  ]) {
    assert.equal(isPrivateOrReservedIp(ip), true, `${ip} muss als privat gelten`);
  }
});

test("isPrivateOrReservedIp laesst oeffentliche IPv4 zu", () => {
  for (const ip of ["8.8.8.8", "1.1.1.1", "172.32.0.1", "192.169.0.1", "93.184.216.34"]) {
    assert.equal(isPrivateOrReservedIp(ip), false, `${ip} muss oeffentlich sein`);
  }
});

test("isPrivateOrReservedIp erkennt private/reservierte IPv6", () => {
  for (const ip of ["::1", "::", "fe80::1", "fc00::1", "fd12:3456::1", "ff02::1", "::ffff:127.0.0.1"]) {
    assert.equal(isPrivateOrReservedIp(ip), true, `${ip} muss als privat gelten`);
  }
  assert.equal(isPrivateOrReservedIp("2606:4700:4700::1111"), false, "oeffentliche IPv6 erlaubt");
});

test("assertPublicHost lehnt IP-Literal auf interne Adresse ab", async () => {
  await assert.rejects(() => assertPublicHost("169.254.169.254"), /SSRF/);
  await assert.rejects(() => assertPublicHost("127.0.0.1"), /SSRF/);
});

test("assertPublicHost lehnt Hostnamen ab, der auf interne IP aufloest", async () => {
  const lookupImpl = async () => [{ address: "10.0.0.5", family: 4 }];
  await assert.rejects(() => assertPublicHost("interner-host.example", { lookupImpl }), /SSRF/);
});

test("assertPublicHost laesst oeffentliche Aufloesung zu", async () => {
  const lookupImpl = async () => [{ address: "93.184.216.34", family: 4 }];
  await assert.doesNotReject(() => assertPublicHost("www.example.com", { lookupImpl }));
});

test("isPrivateOrReservedIp: Nicht-IP -> false, IPv4-gemappte IPv6 -> wie IPv4", () => {
  assert.equal(isPrivateOrReservedIp("kein-ip"), false);
  assert.equal(isPrivateOrReservedIp("999.1.1.1"), false);
  assert.equal(isPrivateOrReservedIp("::ffff:10.0.0.1"), true);
  assert.equal(isPrivateOrReservedIp("::ffff:8.8.8.8"), false);
});

test("assertPublicHost: leerer Host und nicht aufloesbarer Host werfen", async () => {
  await assert.rejects(() => assertPublicHost(""), /leerer Host/);
  await assert.rejects(() => assertPublicHost("   "), /leerer Host/);
  const emptyLookup = async () => [];
  await assert.rejects(() => assertPublicHost("leer.example", { lookupImpl: emptyLookup }), /konnte nicht aufgeloest/);
});

test("assertPublicHost: einzelnes (nicht-Array) Lookup-Resultat wird akzeptiert", async () => {
  const singleRecord = async () => ({ address: "93.184.216.34", family: 4 });
  await assert.doesNotReject(() => assertPublicHost("www.example.com", { lookupImpl: singleRecord }));
});
