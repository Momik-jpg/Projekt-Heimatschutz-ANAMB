// SSRF-Schutz fuer ausgehende Requests: klassifiziert IPs und validiert auch
// den DNS-Lookup, den Undici fuer den tatsaechlichen Socket verwendet.
import net from "node:net";
import { lookup as dnsLookup } from "node:dns/promises";
import { Agent } from "undici";

function ipv4ToInt(ip) {
  const parts = ip.split(".").map((p) => Number(p));
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) {
    return null;
  }
  return ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3];
}

function inRange4(ipInt, baseIp, prefix) {
  const base = ipv4ToInt(baseIp);
  if (base === null) return false;
  const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;
  return (ipInt & mask) === (base & mask);
}

function isPrivateIpv4(ip) {
  const n = ipv4ToInt(ip);
  if (n === null) return false;
  return (
    inRange4(n, "0.0.0.0", 8) || // "this" network / 0.0.0.0
    inRange4(n, "10.0.0.0", 8) || // privat
    inRange4(n, "100.64.0.0", 10) || // CGNAT
    inRange4(n, "127.0.0.0", 8) || // loopback
    inRange4(n, "169.254.0.0", 16) || // link-local (inkl. Cloud-Metadaten 169.254.169.254)
    inRange4(n, "172.16.0.0", 12) || // privat
    inRange4(n, "192.0.0.0", 24) || // IETF-Protokoll
    inRange4(n, "192.0.2.0", 24) || // TEST-NET-1
    inRange4(n, "192.168.0.0", 16) || // privat
    inRange4(n, "198.18.0.0", 15) || // Benchmark
    inRange4(n, "198.51.100.0", 24) || // TEST-NET-2
    inRange4(n, "203.0.113.0", 24) || // TEST-NET-3
    inRange4(n, "224.0.0.0", 4) || // Multicast
    inRange4(n, "240.0.0.0", 4) // reserviert
  );
}

function isPrivateIpv6(ip) {
  const addr = String(ip).toLowerCase().split("%")[0];

  if (addr === "::1" || addr === "::") {
    return true; // loopback / unspecified
  }

  const mapped = addr.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (mapped) {
    return isPrivateIpv4(mapped[1]);
  }

  return (
    /^f[cd]/.test(addr) || // ULA fc00::/7
    /^fe[89ab]/.test(addr) || // link-local fe80::/10
    /^ff/.test(addr) // multicast ff00::/8
  );
}

/**
 * Ist die IP privat/reserviert (also kein erlaubtes oeffentliches Ziel)?
 * @param {string} ip
 */
export function isPrivateOrReservedIp(ip) {
  const type = net.isIP(ip);
  if (type === 4) return isPrivateIpv4(ip);
  if (type === 6) return isPrivateIpv6(ip);
  return false;
}

function validatePublicRecords(host, records) {
  const addresses = Array.isArray(records) ? records : [records];
  if (addresses.length === 0) {
    throw new Error(`SSRF-Schutz: Host ${host} konnte nicht aufgeloest werden.`);
  }

  return addresses.map((record) => {
    const address = typeof record === "string" ? record : record?.address;
    const family = typeof record === "string" ? net.isIP(record) : Number(record?.family ?? net.isIP(address));

    if (!address || !net.isIP(address)) {
      throw new Error(`SSRF-Schutz: Host ${host} lieferte keine gueltige Ziel-IP.`);
    }
    if (isPrivateOrReservedIp(address)) {
      throw new Error(`SSRF-Schutz: Host ${host} loest auf private/reservierte IP ${address} auf.`);
    }

    return { address, family };
  });
}

/**
 * Wirft, wenn der Host (IP-Literal oder per DNS aufgeloest) auf eine private/
 * reservierte Adresse zeigt. lookupImpl ist fuer Tests injizierbar.
 * @param {string} hostname
 */
export async function assertPublicHost(hostname, { lookupImpl = dnsLookup } = {}) {
  const host = String(hostname ?? "").trim();
  if (!host) {
    throw new Error("SSRF-Schutz: leerer Host.");
  }

  if (net.isIP(host)) {
    if (isPrivateOrReservedIp(host)) {
      throw new Error(`SSRF-Schutz: Ziel-IP ${host} ist privat/reserviert.`);
    }
    return;
  }

  const records = await lookupImpl(host, { all: true });
  validatePublicRecords(host, records);
}

export function createPublicLookup({ lookupImpl = dnsLookup } = {}) {
  return function publicLookup(hostname, options, callback) {
    const lookupOptions = typeof options === "object" && options !== null ? options : { family: options };

    Promise.resolve(lookupImpl(hostname, { ...lookupOptions, all: true, verbatim: true }))
      .then((records) => {
        const addresses = validatePublicRecords(hostname, records);
        if (lookupOptions.all) {
          callback(null, addresses);
          return;
        }
        callback(null, addresses[0].address, addresses[0].family);
      })
      .catch((error) => callback(error));
  };
}

export const ssrfSafeDispatcher = new Agent({
  connect: {
    lookup: createPublicLookup()
  }
});
