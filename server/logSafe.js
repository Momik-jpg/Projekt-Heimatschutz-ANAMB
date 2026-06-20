// Neutralisiert Werte vor der Logausgabe (S7): ersetzt Zeilenumbrueche und
// Steuerzeichen durch Leerzeichen, damit externe Daten keine gefaelschten
// Logzeilen erzeugen koennen (Log-Injection), und begrenzt die Laenge.
export function sanitizeForLog(value, maxLength = 300) {
  const raw = String(value ?? "");
  let out = "";
  for (const ch of raw) {
    const code = ch.codePointAt(0);
    // ASCII-Steuerzeichen (inkl. CR/LF), DEL und die Zeilentrenner U+2028/U+2029
    if (code < 0x20 || code === 0x7f || code === 0x2028 || code === 0x2029) {
      out += " ";
    } else {
      out += ch;
    }
  }
  out = out.replace(/ {2,}/g, " ").trim();
  return out.length > maxLength ? `${out.slice(0, maxLength)}…` : out;
}
