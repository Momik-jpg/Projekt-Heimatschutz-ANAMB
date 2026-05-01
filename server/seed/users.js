// Bewusst KEINE Passwoerter im Repository. Master- und Team-Passwoerter werden
// ausschliesslich ueber Umgebungsvariablen (MASTER_ACCOUNT_PASSWORD /
// DEFAULT_LOGIN_PASSWORD) oder – falls keines gesetzt ist – ueber den per E-Mail
// zugestellten Master-Setup-Key vergeben. Konten ohne konfiguriertes Passwort
// werden mit einem unbrauchbaren Zufallswert gesperrt seedet.
export const seedUsers = [
  {
    id: "USR-MASTER",
    username: "master",
    displayName: "Master Account",
    role: "Master"
  },
  {
    id: "USR-001",
    username: "lucia.vettori",
    displayName: "Lucia Vettori",
    role: "Fachleitung"
  },
  {
    id: "USR-002",
    username: "aleksandar.nikolic",
    displayName: "Aleksandar Nikolic",
    role: "Projektteam"
  },
  {
    id: "USR-003",
    username: "andrin.keller",
    displayName: "Andrin Keller",
    role: "Projektteam"
  },
  {
    id: "USR-004",
    username: "momik.sulejmani",
    displayName: "Momik Sulejmani",
    role: "Projektteam"
  },
  {
    id: "USR-005",
    username: "anna.mueller",
    displayName: "Anna Mueller",
    role: "Mitarbeiterin"
  },
  {
    id: "USR-006",
    username: "david.huber",
    displayName: "David Huber",
    role: "Mitarbeiter"
  },
  {
    id: "USR-007",
    username: "lea.weber",
    displayName: "Lea Weber",
    role: "Mitarbeiterin"
  },
  {
    id: "USR-008",
    username: "nina.meier",
    displayName: "Nina Meier",
    role: "Mitarbeiterin"
  },
  {
    id: "USR-009",
    username: "marco.roth",
    displayName: "Marco Roth",
    role: "Mitarbeiter"
  },
  {
    id: "USR-010",
    username: "sara.fischer",
    displayName: "Sara Fischer",
    role: "Mitarbeiterin"
  },
  {
    id: "USR-011",
    username: "jonas.brunner",
    displayName: "Jonas Brunner",
    role: "Mitarbeiter"
  },
  {
    id: "USR-012",
    username: "elena.keller",
    displayName: "Elena Keller",
    role: "Mitarbeiterin"
  }
];
