# Gepinnte Semgrep-Regeln

`security-audit.yaml` und `javascript.yaml` sind die am 22. Juni 2026 vollständig
aufgelösten Snapshots der Registry-Pakete `p/security-audit` und `p/javascript`.

- `security-audit.yaml`: 225 Regeln, SHA-256
  `709e9ec14480d1187b17a0cbfb3237b7afc1c36566c26648cff1aa8c2bf93dde`
- `javascript.yaml`: 74 Regeln, SHA-256
  `fa5888d2be3e985444cbd5a7aa64d9f98b351bdaee578076698a65996a16ddfc`
- Effektiver kombinierter Satz: 292 eindeutige Regeln
- CI-Container: siehe den per Digest gepinnten Container in
  `.github/workflows/semgrep.yml`

Der CI-Lauf benötigt für Regeln weder Registry-Zugriff noch ein Semgrep-Login.
Eine Aktualisierung ist eine bewusste Security-Änderung: beide Registry-Endpunkte
erneut auflösen, Snapshots und Hashes gemeinsam ersetzen, Diff prüfen und den
vollständigen lokalen Scan ausführen.
