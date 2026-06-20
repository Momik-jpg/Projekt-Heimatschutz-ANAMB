// Einmaliges Hilfsskript: lädt die benötigten Google-Fonts-Subsets (latin, latin-ext)
// als woff2 nach public/fonts/ und erzeugt public/fonts.css für self-hosting.
// Dedupliziert Variable Fonts (eine Datei deckt mehrere Gewichte ab) per URL.
// Aus dem Projektwurzelverzeichnis ausführen: node scripts/fetch-fonts.mjs
import { readFile, writeFile, mkdir } from "node:fs/promises";

const KEEP = new Set(["latin", "latin-ext"]);
const families = [
  { css: ".tmp-fonts/lf.css", family: "Libre Franklin", slug: "libre-franklin" },
  { css: ".tmp-fonts/ibm.css", family: "IBM Plex Mono", slug: "ibm-plex-mono" },
  { css: ".tmp-fonts/ss.css", family: "Source Serif 4", slug: "source-serif-4" }
];

await mkdir("public/fonts", { recursive: true });

const blockRe = /\/\*\s*([\w-]+)\s*\*\/\s*@font-face\s*\{([^}]*)\}/g;
const faces = [];

for (const fam of families) {
  const text = await readFile(fam.css, "utf8");
  // URL -> { subset, range, weights:Set } gruppieren (Variable Fonts teilen sich eine Datei).
  const byUrl = new Map();
  let m;
  while ((m = blockRe.exec(text)) !== null) {
    const subset = m[1];
    if (!KEEP.has(subset)) continue;
    const body = m[2];
    const weight = (body.match(/font-weight:\s*(\d+)/) || [])[1];
    const url = (body.match(/url\((https:\/\/[^)]+\.woff2)\)/) || [])[1];
    const range = (body.match(/unicode-range:\s*([^;]+);/) || [])[1];
    if (!weight || !url) continue;
    if (!byUrl.has(url)) byUrl.set(url, { subset, range, weights: new Set() });
    byUrl.get(url).weights.add(Number(weight));
  }

  for (const [url, info] of byUrl) {
    const weights = [...info.weights].sort((a, b) => a - b);
    const variable = weights.length > 1;
    const min = weights[0];
    const max = weights[weights.length - 1];
    const label = variable ? `${min}-${max}` : `${min}`;
    const file = `${fam.slug}-${label}-${info.subset}.woff2`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`download failed ${url} -> ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    await writeFile(`public/fonts/${file}`, buf);
    faces.push(
      `@font-face {\n` +
      `  font-family: '${fam.family}';\n` +
      `  font-style: normal;\n` +
      `  font-weight: ${variable ? `${min} ${max}` : min};\n` +
      `  font-display: swap;\n` +
      `  src: url(fonts/${file}) format('woff2');\n` +
      (info.range ? `  unicode-range: ${info.range.trim()};\n` : "") +
      `}`
    );
    console.log("saved", file, buf.length, "bytes", variable ? `(variable ${min}-${max})` : "");
  }
}

const header = "/* Self-hosted Schriften (latin, latin-ext) – generiert via scripts/fetch-fonts.mjs */\n\n";
await writeFile("public/fonts.css", header + faces.join("\n\n") + "\n");
console.log(`\nDone: ${faces.length} @font-face Regeln -> public/fonts.css`);
