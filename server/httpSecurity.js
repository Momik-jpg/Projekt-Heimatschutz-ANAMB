// HTTP-Sicherheit (Cookies/CSRF/Header/Kompression/Rate-Limit/Turnstile) – aus httpSupport.js aufgeteilt.
import { promisify } from "node:util";
import { gzip } from "node:zlib";
import { extname, } from "node:path";
import {
  nowIso
} from "./httpSupportCore.js";

export const gzipAsync = promisify(gzip);

export const sessionCookieName = "heimatschutz_session";

export const sessionMaxAgeSeconds = 60 * 60 * 12;

export const contentSecurityPolicy = [
  "default-src 'self'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "object-src 'none'",
  "script-src 'self' https://challenges.cloudflare.com",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self'",
  "img-src 'self' data: https://*.tile.openstreetmap.org",
  "connect-src 'self' https://www.ag.ch https://challenges.cloudflare.com",
  "frame-src https://challenges.cloudflare.com"
].join("; ");

export function buildSessionExpiry(issuedAt = new Date()) {
  return new Date(issuedAt.getTime() + sessionMaxAgeSeconds * 1000).toISOString();
}

export function parseCookies(cookieHeader = "") {
  const cookies = new Map();
  for (const rawPart of String(cookieHeader).split(";")) {
    const part = rawPart.trim();
    const separatorIndex = part.indexOf("=");
    if (separatorIndex <= 0) continue;

    const key = part.slice(0, separatorIndex).trim();
    const value = part.slice(separatorIndex + 1).trim();
    try {
      cookies.set(key, decodeURIComponent(value));
    } catch {
      // Fehlerhaft kodierte Cookies werden wie fehlende Cookies behandelt.
    }
  }
  return cookies;
}

export function isSecureRequest(request) {
  if (request.secure) {
    return true;
  }

  return String(request.headers["x-forwarded-proto"] ?? "").includes("https");
}

export function buildSessionCookie(sessionId, request) {
  const secureAttribute = isSecureRequest(request) ? "; Secure" : "";
  return `${sessionCookieName}=${encodeURIComponent(sessionId)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${sessionMaxAgeSeconds}${secureAttribute}`;
}

export function buildExpiredSessionCookie(request) {
  const secureAttribute = isSecureRequest(request) ? "; Secure" : "";
  return `${sessionCookieName}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secureAttribute}`;
}

export const csrfProtectedMethods = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export function getRequestHosts(request) {
  const hosts = new Set();

  if (request.headers.host) {
    hosts.add(String(request.headers.host).toLowerCase());
  }

  const forwardedHost = request.headers["x-forwarded-host"];

  if (forwardedHost) {
    for (const host of String(forwardedHost).split(",")) {
      hosts.add(host.trim().toLowerCase());
    }
  }

  return hosts;
}

export function resolveTrustProxySetting(value = false) {
  if (value === true) return true;
  if (value === false || value === null || value === undefined) return false;
  if (typeof value === "number") return value > 0 ? value : false;

  const rawValue = String(value).trim();
  if (!rawValue) return false;

  const normalizedValue = rawValue.toLowerCase();
  if (["false", "0", "off", "no"].includes(normalizedValue)) return false;
  if (["true", "on", "yes"].includes(normalizedValue)) return true;

  const numericValue = Number(normalizedValue);
  if (Number.isInteger(numericValue)) {
    return numericValue > 0 ? numericValue : false;
  }

  return rawValue;
}

// CSRF-Schutz: Zusammen mit dem SameSite=Lax-Session-Cookie wird jede ändernde
// Anfrage abgewiesen, deren Origin/Referer fehlt oder nicht zum eigenen Host gehoert.
export function createCsrfOriginGuard({ enabled = true } = {}) {
  return function csrfOriginGuard(request, response, next) {
    if (!enabled || !csrfProtectedMethods.has(request.method)) {
      next();
      return;
    }

    const source = request.headers.origin || request.headers.referer;

    if (!source) {
      response.status(403).json({ error: "Anfrage ohne Herkunft wurde blockiert." });
      return;
    }

    let sourceHost;

    try {
      sourceHost = new URL(source).host.toLowerCase();
    } catch {
      response.status(403).json({ error: "Ungültige Anfrage-Herkunft." });
      return;
    }

    if (getRequestHosts(request).has(sourceHost)) {
      next();
      return;
    }

    response.status(403).json({ error: "Anfrage von fremder Herkunft wurde blockiert." });
  };
}

export function setCommonSecurityHeaders(_request, response, next) {
  response.setHeader("Content-Security-Policy", contentSecurityPolicy);
  response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  response.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  // HSTS: Browser ignorieren den Header über HTTP, daher ist das unbedenklich und
  // erzwingt HTTPS, sobald die App hinter TLS ausgeliefert wird.
  response.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  next();
}

export function setStaticAssetHeaders(response, filePath) {
  const extension = extname(filePath).toLowerCase();

  if (extension === ".html") {
    response.setHeader("Cache-Control", "no-store");
    return;
  }

  if ([".css", ".js"].includes(extension)) {
    response.setHeader("Cache-Control", "no-cache");
    return;
  }

  if ([".svg", ".png", ".jpg", ".jpeg", ".webp", ".gif", ".ico"].includes(extension)) {
    response.setHeader("Cache-Control", "public, max-age=86400");
    return;
  }

  if ([".woff2", ".woff"].includes(extension)) {
    response.setHeader("Cache-Control", "public, max-age=31536000, immutable");
  }
}

export const compressibleContentTypePattern =
  /^(?:text\/|application\/(?:json|javascript|xml|rss\+xml|atom\+xml|geo\+json|manifest\+json)|image\/svg\+xml)/i;

export function isCompressibleContentType(contentTypeHeader) {
  if (!contentTypeHeader) {
    return false;
  }

  return compressibleContentTypePattern.test(String(contentTypeHeader));
}

export function appendVaryHeader(response, field) {
  const existing = response.getHeader("Vary");

  if (!existing) {
    response.setHeader("Vary", field);
    return;
  }

  const values = String(existing)
    .split(",")
    .map((value) => value.trim().toLowerCase());

  if (values.includes("*") || values.includes(field.toLowerCase())) {
    return;
  }

  response.setHeader("Vary", `${existing}, ${field}`);
}

// Schlanke gzip-Kompression ohne externe Abhängigkeit. Puffert den Antwort-Body
// und komprimiert ihn asynchron (blockiert die Event-Loop nicht), sofern der
// Client gzip akzeptiert, der Inhaltstyp komprimierbar ist und die Antwort den
// Schwellwert überschreitet.
export function createCompressionMiddleware({ threshold = 1024 } = {}) {
  return function compressionMiddleware(request, response, next) {
    const acceptEncoding = String(request.headers["accept-encoding"] ?? "");

    if (request.method === "HEAD" || !/\bgzip\b/i.test(acceptEncoding)) {
      next();
      return;
    }

    const originalWrite = response.write.bind(response);
    const originalEnd = response.end.bind(response);
    const chunks = [];

    function collect(chunk, encoding) {
      if (!chunk) {
        return;
      }

      chunks.push(
        Buffer.isBuffer(chunk)
          ? chunk
          : Buffer.from(chunk, typeof encoding === "string" ? encoding : "utf8")
      );
    }

    response.write = function patchedWrite(chunk, encoding, callback) {
      collect(chunk, encoding);

      if (typeof encoding === "function") {
        encoding(null);
      } else if (typeof callback === "function") {
        callback(null);
      }

      return true;
    };

    response.end = function patchedEnd(chunk, encoding, callback) {
      if (typeof chunk === "function") {
        callback = chunk;
        chunk = undefined;
        encoding = undefined;
      } else if (typeof encoding === "function") {
        callback = encoding;
        encoding = undefined;
      }

      collect(chunk, encoding);

      // Originale Methoden wiederherstellen, damit das eigentliche Senden normal läuft.
      response.write = originalWrite;
      response.end = originalEnd;

      const body = Buffer.concat(chunks);
      const shouldCompress =
        response.statusCode === 200 &&
        body.length >= threshold &&
        !response.getHeader("Content-Encoding") &&
        !response.getHeader("Content-Range") &&
        isCompressibleContentType(response.getHeader("Content-Type"));

      if (!shouldCompress) {
        return originalEnd(body, callback);
      }

      gzipAsync(body)
        .then((compressed) => {
          response.setHeader("Content-Encoding", "gzip");
          response.removeHeader("Content-Length");
          response.setHeader("Content-Length", compressed.length);
          appendVaryHeader(response, "Accept-Encoding");
          originalEnd(compressed, callback);
        })
        .catch(() => {
          originalEnd(body, callback);
        });

      return response;
    };

    next();
  };
}

// In-Memory-Bremse gegen Passwort-Raten. Sperrt einen Schlüssel (i. d. R. Client-IP)
// nach zu vielen Fehlversuchen innerhalb des Zeitfensters für die Sperrdauer.
export function createLoginRateLimiter({
  maxAttempts = 10,
  windowMs = 15 * 60 * 1000,
  lockoutMs = 15 * 60 * 1000
} = {}) {
  const entries = new Map();

  function prune(now) {
    for (const [key, entry] of entries) {
      const expiry = Math.max(entry.lockedUntil ?? 0, entry.firstAttempt + windowMs);

      if (expiry <= now) {
        entries.delete(key);
      }
    }
  }

  return {
    check(key) {
      const now = Date.now();
      const entry = entries.get(key);

      if (entry?.lockedUntil && entry.lockedUntil > now) {
        return { limited: true, retryAfterSeconds: Math.ceil((entry.lockedUntil - now) / 1000) };
      }

      return { limited: false };
    },

    // True, sobald für diesen Schlüssel im Zeitfenster bereits ein Fehlversuch
    // vorliegt (=> ab dem 2. Login-Versuch eine Bot-Prüfung verlangen).
    requiresChallenge(key) {
      const now = Date.now();
      const entry = entries.get(key);

      if (!entry || now - entry.firstAttempt > windowMs) {
        return false;
      }

      return (entry.count ?? 0) >= 1;
    },

    recordFailure(key) {
      const now = Date.now();
      prune(now);

      let entry = entries.get(key);

      if (!entry || now - entry.firstAttempt > windowMs) {
        entry = { firstAttempt: now, count: 0, lockedUntil: 0 };
      }

      entry.count += 1;

      if (entry.count >= maxAttempts) {
        entry.lockedUntil = now + lockoutMs;
      }

      entries.set(key, entry);
    },

    recordSuccess(key) {
      entries.delete(key);
    }
  };
}

// Prüft ein Cloudflare-Turnstile-Token gegen die siteverify-API.
export async function verifyTurnstileToken(token, secret, remoteIp) {
  const params = new URLSearchParams();
  params.set("secret", secret);
  params.set("response", token);

  if (remoteIp) {
    params.set("remoteip", remoteIp);
  }

  const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString()
  });

  const data = await response.json();
  return Boolean(data?.success);
}

export function resolveCurrentUser(request, sessionsRepository, usersRepository) {
  sessionsRepository.deleteExpired(nowIso());
  const cookies = parseCookies(request.headers.cookie);
  const sessionId = cookies.get(sessionCookieName);

  if (!sessionId) {
    return null;
  }

  const session = sessionsRepository.getActiveById(sessionId, nowIso());

  if (!session) {
    return null;
  }

  const user = usersRepository.getPublicUserById(session.userId);

  if (!user) {
    sessionsRepository.deleteById(sessionId);
    return null;
  }

  sessionsRepository.touch(sessionId, nowIso(), buildSessionExpiry());

  return {
    sessionId,
    user
  };
}
