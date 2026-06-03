/* =====================================================================
   Design-Labor — schwebender Umschalter zum Vergleichen der Varianten.
   Setzt Body-Klassen (theme-aargau / theme-noir / theme-futuristic) und den Dunkelmodus
   (body.dark). Auswahl wird in localStorage gemerkt und sofort beim
   Laden angewandt, damit sie auch auf dem Login-Bildschirm gilt.
   Rein optionales Vorschau-Werkzeug; ohne Auswahl bleibt das
   Original-Design unverändert.
   ===================================================================== */
(function () {
  "use strict";

  var THEME_KEY = "hsd-design-theme"; // original | aargau | noir | futuristic
  var DARK_KEY = "hsd-design-dark"; // "1" | "0"
  var ALL = ["aargau", "noir", "futuristic"];

  var THEMES = [
    { id: "original", label: "Original", swatch: "original" },
    { id: "aargau", label: "V1 · Aargau", swatch: "aargau" },
    { id: "noir", label: "V2 · Noir Luxe", swatch: "noir" },
    { id: "futuristic", label: "V3 · Futuristisch", swatch: "futuristic" }
  ];

  function readTheme() {
    var value = localStorage.getItem(THEME_KEY);
    return ALL.indexOf(value) >= 0 ? value : "original";
  }

  function readDark() {
    var previewValue = localStorage.getItem(DARK_KEY);
    if (previewValue === "1" || previewValue === "0") return previewValue === "1";
    return localStorage.getItem("heimatschutz-dark-mode") === "1";
  }

  function applyState(theme, dark) {
    var body = document.body;
    body.classList.remove("theme-aargau", "theme-noir", "theme-futuristic");
    if (ALL.indexOf(theme) >= 0) body.classList.add("theme-" + theme);

    var wantDark = dark;
    body.classList.toggle("dark", wantDark);
    // app.js liest diesen Schlüssel beim Laden -> hält body.dark nach Reload konsistent.
    try { localStorage.setItem("heimatschutz-dark-mode", wantDark ? "1" : "0"); } catch (e) {}

    var meta = document.querySelector('meta[name="color-scheme"]');
    if (meta) meta.setAttribute("content", wantDark ? "dark" : "light");
  }

  // Früh anwenden (vor dem Aufbau des Panels), damit kein Aufblitzen entsteht.
  var currentTheme = readTheme();
  var currentDark = readDark();
  applyState(currentTheme, currentDark);

  function build() {
    if (document.querySelector(".theme-lab")) return;

    var root = document.createElement("div");
    root.className = "theme-lab";

    var toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "theme-lab__toggle";
    toggle.setAttribute("aria-label", "Design-Vorschau öffnen");
    toggle.innerHTML = '<span class="theme-lab__emoji">🎨</span>';

    var panel = document.createElement("div");
    panel.className = "theme-lab__panel";
    panel.hidden = true;

    var title = document.createElement("p");
    title.className = "theme-lab__title";
    title.textContent = "Design-Vorschau";

    var group = document.createElement("div");
    group.className = "theme-lab__group";

    var optButtons = {};
    THEMES.forEach(function (t) {
      var opt = document.createElement("button");
      opt.type = "button";
      opt.className = "theme-lab__opt";
      opt.dataset.theme = t.id;

      var swatch = document.createElement("span");
      swatch.className = "theme-lab__swatch theme-lab__swatch--" + t.swatch;

      var label = document.createElement("span");
      label.textContent = t.label;

      opt.appendChild(label);
      opt.appendChild(swatch);
      opt.addEventListener("click", function () {
        currentTheme = t.id;
        localStorage.setItem(THEME_KEY, currentTheme);
        applyState(currentTheme, currentDark);
        sync();
      });

      optButtons[t.id] = opt;
      group.appendChild(opt);
    });

    var row = document.createElement("div");
    row.className = "theme-lab__row";
    var rowLabel = document.createElement("span");
    rowLabel.textContent = "Dunkelmodus";
    var darkSwitch = document.createElement("button");
    darkSwitch.type = "button";
    darkSwitch.className = "theme-lab__switch";
    darkSwitch.setAttribute("aria-label", "Dunkelmodus umschalten");
    darkSwitch.addEventListener("click", function () {
      currentDark = !currentDark;
      localStorage.setItem(DARK_KEY, currentDark ? "1" : "0");
      applyState(currentTheme, currentDark);
      sync();
    });
    window.addEventListener("heimatschutz-dark-mode-change", function (event) {
      currentDark = Boolean(event.detail && event.detail.enabled);
      localStorage.setItem(DARK_KEY, currentDark ? "1" : "0");
      sync();
    });
    row.appendChild(rowLabel);
    row.appendChild(darkSwitch);

    var hint = document.createElement("p");
    hint.className = "theme-lab__hint";
    hint.textContent = "Nur Vorschau. Wähle deine Lieblingsvariante — sag mir dann, welche, und ich mache sie fest.";

    panel.appendChild(title);
    panel.appendChild(group);
    panel.appendChild(row);
    panel.appendChild(hint);

    toggle.addEventListener("click", function () {
      panel.hidden = !panel.hidden;
    });

    document.addEventListener("click", function (event) {
      if (!root.contains(event.target)) panel.hidden = true;
    });

    root.appendChild(panel);
    root.appendChild(toggle);
    document.body.appendChild(root);

    setupNeonCursor();

    function sync() {
      THEMES.forEach(function (t) {
        optButtons[t.id].setAttribute("aria-pressed", String(currentTheme === t.id));
      });
      darkSwitch.setAttribute("aria-pressed", String(currentDark));
      darkSwitch.disabled = false;
    }

    sync();
  }

  function setupNeonCursor() {
    if (document.querySelector(".fz-cursor")) return;
    // Touch-Geräte: kein Cursor.
    if (window.matchMedia && window.matchMedia("(hover: none)").matches) return;

    var dot = document.createElement("div");
    dot.className = "fz-cursor";
    dot.setAttribute("aria-hidden", "true");
    var ring = document.createElement("div");
    ring.className = "fz-cursor-ring";
    ring.setAttribute("aria-hidden", "true");
    document.body.appendChild(ring);
    document.body.appendChild(dot);

    var mx = window.innerWidth / 2, my = window.innerHeight / 2; // Mausziel
    var rx = mx, ry = my; // Ring (zieht weich nach)

    window.addEventListener("mousemove", function (e) {
      mx = e.clientX;
      my = e.clientY;
      dot.style.transform = "translate(" + mx + "px," + my + "px) translate(-50%,-50%)";
      // Ring grösser über klickbaren Elementen
      var t = e.target;
      var hot = t && t.closest && t.closest("a,button,input,select,textarea,label,[role=button]");
      document.body.classList.toggle("fz-hot", Boolean(hot));
    });

    (function loop() {
      rx += (mx - rx) * 0.18;
      ry += (my - ry) * 0.18;
      ring.style.transform = "translate(" + rx + "px," + ry + "px) translate(-50%,-50%)";
      requestAnimationFrame(loop);
    })();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", build);
  } else {
    build();
  }
})();
