/* ==========================================================================
 * CueDesk — mixer.js
 * Modelo de canales, rack de 8 tiras, banco de capas, master Main LR,
 * estado M/S, etiquetas, colores y modo GAIN.
 *
 * Rutas OSC por tipo de banco (protocolo X32/M32):
 *   ch   → /ch/NN/{mix/fader, mix/on, mix/pan, config/name, config/color}
 *   aux  → /auxin/NN/…            fx → /fxrtn/NN/…
 *   bus  → /bus/NN/…              dca → /dca/N/{fader, on}   (sin pan)
 *   solo → /-stat/solosw/<id>     (id = channel-id X32 + 1; ch01 → 01)
 * ========================================================================== */

window.CueDesk = window.CueDesk || {};

CueDesk.Mixer = (function () {
  const dB = CueDesk.dB;
  const OSC = CueDesk.OSC;
  const Controls = CueDesk.Controls;
  const Meters = CueDesk.Meters;

  /* ---------------------------------------------------------- constantes */

  const BANKS = {
    ch1: { kind: "ch", label: "Ch 1-8", from: 1 },
    ch9: { kind: "ch", label: "Ch 9-16", from: 9 },
    ch17: { kind: "ch", label: "Ch 17-24", from: 17 },
    ch25: { kind: "ch", label: "Ch 25-32", from: 25 },
    aux: { kind: "aux", label: "AUX", from: 1 },
    fx: { kind: "fx", label: "FX", from: 1 },
    dca: { kind: "dca", label: "DCA", from: 1 },
    bus: { kind: "bus", label: "Buses", from: 1, count: 16 },
    mtx: { kind: "mtx", label: "Matrix", from: 1, count: 6 },
  };

  // Ciclo de la barra de color del canal: orden del enum X32 config/color (0–7),
  // {OFF, RD, GN, YE, BL, MG, CY, WH}. OFF también se alcanza ciclando.
  const CH_COLOR_CYCLE = ["off", "red", "green", "yellow", "blue", "magenta", "cyan", "white"];
  // X32 config/color: {OFF:0, RD:1, GN:2, YE:3, BL:4, MG:5, CY:6, WH:7}
  const COLOR_ENUM = { off: 0, red: 1, green: 2, yellow: 3, blue: 4, magenta: 5, cyan: 6, white: 7 };
  const COLOR_FROM_ENUM = {
    0: "off", 1: "red", 2: "green", 3: "yellow", 4: "blue", 5: "magenta", 6: "cyan", 7: "white",
  };
  const COLOR_HEX = {
    off: "#6b6b78",
    white: "#f4f4f6",
    red: "#ff3b30",
    green: "#22c55e",
    yellow: "#f5c518",
    blue: "#2f6bff",
    magenta: "#ff3bd4",
    cyan: "#00c0ce",
  };
  // Ciclo para los buses (los mains son siempre blancos).
  const BUS_COLOR_CYCLE = ["white", "red", "green", "yellow", "blue", "magenta", "cyan"];

  const FX_NAMES = [
    "FX 1L", "FX 1R", "FX 2L", "FX 2R",
    "FX 3L", "FX 3R", "FX 4L", "FX 4R",
  ];

  const DEFAULT_DB = [0.7, -3.5, -6.0, -12.4, -9.2, -18.5, -27.5, -90];
  const DEFAULT_PAN = [0, -12, 8, 0, -24, 0, 16, 0];
  const DEFAULT_COLORS = ["green", "green", "yellow", "red", "green", "green", "yellow", "red"];
  const DEFAULT_MUTE = [false, false, false, true, false, false, false, false];
  const DEFAULT_SOLO = [false, true, false, false, false, false, false, false];

  /* -------------------------------------------------------------- estado */

  const store = new Map();      // key → modelo (persiste al cambiar de banco)
  const lifeUnsubs = [];        // suscripciones OSC de por vida
  let currentBank = "ch1";
  let gainMode = false;
  let activeStrips = [];

  let rack, masterEl;
  let masterSlider = null;
  let masterTarget = "st";
  let masterMuteBtn = null;
  let masterSelectBtn = null;
  let busPickerEl = null;

  /* Destinos del master: MAIN LR, MAIN M/C y los 16 buses. Cada uno tiene sus
     rutas OSC y su propio estado de fader/mute. Los buses se pueden renombrar. */
  const BUS_COUNT = 16;
  const BUS_NAMES_KEY = "cuedesk.bus.names";

  function loadBusNames() {
    try {
      return JSON.parse(localStorage.getItem(BUS_NAMES_KEY) || "{}") || {};
    } catch (_) {
      return {};
    }
  }

  function saveBusName(n, name) {
    const map = loadBusNames();
    map[String(n)] = name;
    try {
      localStorage.setItem(BUS_NAMES_KEY, JSON.stringify(map));
    } catch (_) {}
  }

  const BUS_COLORS_KEY = "cuedesk.bus.colors";

  function loadBusColors() {
    try {
      return JSON.parse(localStorage.getItem(BUS_COLORS_KEY) || "{}") || {};
    } catch (_) {
      return {};
    }
  }

  function saveBusColor(n, color) {
    const map = loadBusColors();
    map[String(n)] = color;
    try {
      localStorage.setItem(BUS_COLORS_KEY, JSON.stringify(map));
    } catch (_) {}
  }

  const CH_COLORS_KEY = "cuedesk.ch.colors";

  function loadChColors() {
    try {
      return JSON.parse(localStorage.getItem(CH_COLORS_KEY) || "{}") || {};
    } catch (_) {
      return {};
    }
  }

  function saveChColor(id, color) {
    const map = loadChColors();
    map[id] = color;
    try {
      localStorage.setItem(CH_COLORS_KEY, JSON.stringify(map));
    } catch (_) {}
  }

  function masterPaths(id) {
    if (id === "st")
      return { fader: "/main/st/mix/fader", on: "/main/st/mix/on", color: "/main/st/config/color" };
    if (id === "m")
      return { fader: "/main/m/mix/fader", on: "/main/m/mix/on", color: "/main/m/config/color" };
    const n = parseInt(String(id).slice(1), 10);
    if (n >= 1 && n <= BUS_COUNT) {
      const b = p2(n);
      return {
        fader: "/bus/" + b + "/mix/fader",
        on: "/bus/" + b + "/mix/on",
        name: "/bus/" + b + "/config/name",
        color: "/bus/" + b + "/config/color",
      };
    }
    return { fader: "/main/st/mix/fader", on: "/main/st/mix/on" };
  }

  const MASTER_TARGETS = (function () {
    const saved = loadBusNames();
    const colors = loadBusColors();
    const list = [
      { id: "st", kind: "main", tag: "LR", name: "Main LR", color: "white" },
      { id: "m", kind: "main", tag: "M/C", name: "M/C Mono", color: "white" },
    ];
    for (let n = 1; n <= BUS_COUNT; n++) {
      list.push({
        id: "b" + n,
        kind: "bus",
        n: n,
        tag: p2(n),
        name: saved[String(n)] || "Bus " + p2(n),
        color: colors[String(n)] || "white",
      });
    }
    list.forEach(function (t) {
      t.paths = masterPaths(t.id);
    });
    return list;
  })();

  function targetById(id) {
    for (let i = 0; i < MASTER_TARGETS.length; i++) {
      if (MASTER_TARGETS[i].id === id) return MASTER_TARGETS[i];
    }
    return MASTER_TARGETS[0];
  }

  const masterState = new Map();

  function stateFor(id) {
    if (!masterState.has(id)) {
      const isMain = id === "st" || id === "m";
      masterState.set(id, { faderNorm: dB.toFader(isMain ? -6 : 0), muted: false });
    }
    return masterState.get(id);
  }

  const masterSim = {
    L: { level: Meters.MASTER_VOICE.base },
    R: { level: Meters.MASTER_VOICE.base },
  };

  /** Niveles reales (dB, ya convertidos del lineal del X32); TTL para caducar. */
  const EXT_TTL = 1200;
  let masterExt = null; // { L, R, at }

  /* ------------------------------------------------------------- helpers */

  function p2(n) {
    return String(n).padStart(2, "0");
  }

  function p3(n) {
    return String(n).padStart(3, "0");
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function perfNow() {
    return typeof performance !== "undefined" && performance.now
      ? performance.now()
      : Date.now();
  }

  function num(v) {
    const n = typeof v === "number" ? v : parseFloat(v);
    return isFinite(n) ? n : null;
  }

  /** Valor "ON" de la consola: 1 / "1" / "ON" / true */
  function isOn(v) {
    return v === 1 || v === "1" || v === "ON" || v === "on" || v === true;
  }

  function pathsFor(kind, n) {
    const id = p2(n);
    switch (kind) {
      case "ch":
        return {
          fader: "/ch/" + id + "/mix/fader",
          on: "/ch/" + id + "/mix/on",
          pan: "/ch/" + id + "/mix/pan",
          name: "/ch/" + id + "/config/name",
          color: "/ch/" + id + "/config/color",
          solo: "/-stat/solosw/" + id,       // ch01 → solosw/01
          gain: "/headamp/" + p3(n - 1) + "/gain",
        };
      case "aux":
        return {
          fader: "/auxin/" + id + "/mix/fader",
          on: "/auxin/" + id + "/mix/on",
          pan: "/auxin/" + id + "/mix/pan",
          name: "/auxin/" + id + "/config/name",
          color: "/auxin/" + id + "/config/color",
          solo: "/-stat/solosw/" + (32 + n),  // auxin ids 32…39 (+1)
          trim: "/auxin/" + id + "/preamp/trim",
        };
      case "fx":
        return {
          fader: "/fxrtn/" + id + "/mix/fader",
          on: "/fxrtn/" + id + "/mix/on",
          pan: "/fxrtn/" + id + "/mix/pan",
          name: "/fxrtn/" + id + "/config/name",
          color: "/fxrtn/" + id + "/config/color",
          solo: "/-stat/solosw/" + (40 + n),  // fxrtn ids 40…47 (+1)
        };
      case "bus":
        return {
          fader: "/bus/" + id + "/mix/fader",
          on: "/bus/" + id + "/mix/on",
          pan: "/bus/" + id + "/mix/pan",
          name: "/bus/" + id + "/config/name",
          color: "/bus/" + id + "/config/color",
          solo: "/-stat/solosw/" + (48 + n),  // bus ids 48…63 (+1)
        };
      case "mtx":
        return {
          fader: "/mtx/" + id + "/mix/fader",
          on: "/mtx/" + id + "/mix/on",
          pan: "/mtx/" + id + "/mix/pan",
          name: "/mtx/" + id + "/config/name",
          color: "/mtx/" + id + "/config/color",
          solo: "/-stat/solosw/" + (64 + n),  // matrix ids 64…69 (+1)
        };
      case "dca":
        return {
          fader: "/dca/" + n + "/fader",
          on: "/dca/" + n + "/on",
          name: "/dca/" + n + "/config/name",
          color: "/dca/" + n + "/config/color",
          solo: "/-stat/solosw/" + (72 + n),  // dca ids 72…79 (+1)
        };
    }
    return {};
  }

  function numFor(kind, n) {
    return kind === "dca" ? String(n) : p2(n);
  }

  function nameFor(kind, n, i) {
    switch (kind) {
      case "ch": return "CH " + p2(n);
      case "aux": return "AUX " + p2(n);
      case "fx": return FX_NAMES[i];
      case "bus": return "BUS " + p2(n);
      case "mtx": return "MTX " + p2(n);
      case "dca": return "DCA " + n;
    }
    return p2(n);
  }

  /** Color por defecto de una tira recién creada:
      - buses → color del selector (fuente de verdad);
      - resto → color persistido en cuedesk.ch.colors o el de fábrica. */
  function defaultColorFor(kind, n, i) {
    if (kind === "bus") {
      const t = targetById("b" + n);
      return t ? t.color : DEFAULT_COLORS[i];
    }
    return loadChColors()[kind + ":" + n] || DEFAULT_COLORS[i];
  }

  function modelFor(bankId, i) {
    const bank = BANKS[bankId];
    const n = bank.from + i;
    const key = bankId + ":" + n;
    // Mudo/solo de demostración sólo en el banco principal (Ch 1-8):
    // el resto de bancos arrancan limpios, como en una consola real.
    const demo = bankId === "ch1";

    let m = store.get(key);
    if (m) return m;

    const voice = Meters.VOICES[i % Meters.VOICES.length];
    const isBus = bank.kind === "bus";
    const busMeta = isBus ? targetById("b" + n) : null;
    m = {
      key: key,
      kind: bank.kind,
      n: n,
      num: numFor(bank.kind, n),
      name: isBus && busMeta ? busMeta.name : nameFor(bank.kind, n, i),
      color: defaultColorFor(bank.kind, n, i),
      paths: pathsFor(bank.kind, n),
      hasPan: bank.kind !== "dca",
      faderNorm: dB.toFader(DEFAULT_DB[i]),
      gainNorm: bank.kind === "ch" ? 12 / 72 : 0.5, // 0 dB (headamp en ch / trim en aux)
      pan: (DEFAULT_PAN[i] + 100) / 200,   // norm 0…1
      muted: demo ? DEFAULT_MUTE[i] : false,
      solo: demo ? DEFAULT_SOLO[i] : false,
      voice: voice,
      sim: { L: { level: voice.base }, R: { level: voice.base } },
      subs: false,
    };
    store.set(key, m);
    ensureSubs(m);
    return m;
  }

  /* --------------------------------------------------- suscripciones (in) */

  function ensureSubs(m) {
    if (m.subs) return;
    m.subs = true;

    lifeUnsubs.push(
      OSC.on(m.paths.fader, function (v) {
        m.faderNorm = dB.clamp01(parseFloat(v));
      }),
      OSC.on(m.paths.on, function (v) {
        m.muted = !isOn(v);
        refreshMute(m);
      }),
      OSC.on(m.paths.solo, function (v) {
        m.solo = isOn(v);
        refreshSolo(m);
        notifySoloChange();
      })
    );

    if (m.paths.pan) {
      lifeUnsubs.push(
        OSC.on(m.paths.pan, function (v) {
          m.pan = dB.clamp01((parseFloat(v) + 100) / 200);
        })
      );
    }
    if (m.paths.gain) {
      lifeUnsubs.push(
        OSC.on(m.paths.gain, function (v) {
          m.gainNorm = dB.clamp01((parseFloat(v) + 12) / 72);
        })
      );
    }
    if (m.paths.trim) {
      lifeUnsubs.push(
        OSC.on(m.paths.trim, function (v) {
          m.gainNorm = dB.clamp01((parseFloat(v) + 18) / 36);
        })
      );
    }

    // Etiqueta y color: el backend también puede cambiarlos
    if (m.paths.name) {
      lifeUnsubs.push(
        OSC.on(m.paths.name, function (v) {
          const name = String(v === null || v === undefined ? "" : v).trim().slice(0, 12);
          if (!name) return;
          if (m.kind === "bus") {
            // El selector de bus es la fuente de verdad: aplica en selector + tira
            const t = targetById("b" + m.n);
            if (name !== t.name) applyBusName(t, name, false);
            return;
          }
          if (name === m.name) return;
          m.name = name;
          const el = liveStrip(m);
          if (!el) return;
          const input = el.querySelector('[data-role="name"]');
          if (input && document.activeElement !== input) input.value = name;
        })
      );
    }
    if (m.paths.color) {
      lifeUnsubs.push(
        OSC.on(m.paths.color, function (v) {
          if (m.kind === "bus") {
            // El selector de bus es la fuente de verdad
            setBusColor(m.n, COLOR_FROM_ENUM[parseInt(v, 10)]);
            return;
          }
          // X32 config/color: {OFF:0, RD:1, GN:2, YE:3, BL:4, MG:5, CY:6, WH:7}
          const next = COLOR_FROM_ENUM[parseInt(v, 10)];
          if (!next || next === m.color) return;
          m.color = next;
          const el = liveStrip(m);
          if (el) {
            const btn = el.querySelector('[data-role="color"]');
            if (btn) btn.className = "strip__color is-" + next;
          }
          highlightPaletteSwatch();
        })
      );
    }
  }

  /** Sincroniza el modelo cuando la UI envía (loopback / eco de consola). */
  document.addEventListener("cuedesk:osc-out", function (e) {
    const path = e.detail.path;
    const value = e.detail.value;

    store.forEach(function (m) {
      if (path === m.paths.fader) m.faderNorm = dB.clamp01(parseFloat(value));
      else if (path === m.paths.pan)
        m.pan = dB.clamp01((parseFloat(value) + 100) / 200);
      else if (m.paths.gain && path === m.paths.gain)
        m.gainNorm = dB.clamp01((parseFloat(value) + 12) / 72);
      else if (m.paths.trim && path === m.paths.trim)
        m.gainNorm = dB.clamp01((parseFloat(value) + 18) / 36);
    });

    if (path === masterPaths(masterTarget).fader)
      stateFor(masterTarget).faderNorm = dB.clamp01(parseFloat(value));
  });

  function liveStrip(m) {
    return rack.querySelector('[data-unit="' + m.key + '"]');
  }

  function refreshMute(m) {
    const el = liveStrip(m);
    if (!el) return;
    const btn = el.querySelector('[data-role="mute"]');
    setToggle(btn, m.muted, m.muted ? 0 : 1);
  }

  function refreshSolo(m) {
    const el = liveStrip(m);
    if (!el) return;
    const btn = el.querySelector('[data-role="solo"]');
    setToggle(btn, m.solo, m.solo ? 1 : 0);
  }

  function setToggle(btn, on, oscValue) {
    if (!btn) return;
    btn.classList.toggle("is-on", !!on);
    btn.setAttribute("aria-pressed", on ? "true" : "false");
    btn.setAttribute("data-state-value", String(oscValue));
  }

  function notifySoloChange() {
    document.dispatchEvent(new CustomEvent("cuedesk:solochange"));
  }

  /* ------------------------------------------------------------ template */

  function panHTML(m) {
    return (
      '<div class="pan">' +
        '<div class="hslider hslider--pan" data-slider="horizontal" data-role="pan" ' +
          'data-osc-path="' + m.paths.pan + '" data-osc-address="' + m.paths.pan + '" data-osc-type="f" ' +
          'aria-label="Panorama ' + escapeHtml(m.name) + '">' +
          '<span class="hslider__track">' +
            '<span class="hslider__fill"></span><span class="hslider__thumb"></span>' +
          "</span>" +
        "</div>" +
        // Eje central, siempre centrado debajo del recorrido (el valor vive
        // en aria-valuetext, no en texto estático)
        '<span class="pan__center" aria-hidden="true">C</span>' +
      "</div>"
    );
  }

  /* Escala impresa del fader (sólo tiras de canal): nivel X32 con las marcas
     del propio apéndice Maillot (tope +10 = 1.0, 0 dB = 0.75, base -∞ = 0) o,
     en modo GAIN, trim lineal -18…+18 (linf step 0.250). Los --p son
     fracción del recorrido del pomo: como el vúmetro ocupa el 75 % de ese
     mismo carril con la base común, un mismo dB cae a la altura exacta de su
     etiqueta en la escala del vúmetro. */
  const FADER_SCALE_MIX = [
    { db: 10, label: "+10" },
    { db: 5, label: "+5" },
    { db: 0, label: "0" },
    { db: -5, label: "-5" },
    { db: -10, label: "-10" },
    { db: -20, label: "-20" },
    { db: -40, label: "-40" },
    { db: -60, label: "-60" },
    { db: -Infinity, label: "-∞" },
  ];
  /* Escalas del modo GAIN (marcas cada 12 dB sobre normas lineales):
     - headamp (canales): /headamp/NNN/gain -12…+60 dB, paso 0.5 (Maillot)
     - trim   (aux):      /auxin/NN/preamp/trim -18…+18 dB, paso 0.25 (Maillot) */
  const FADER_SCALE_HEADAMP = [
    { norm: 1, label: "+60" },
    { norm: 5 / 6, label: "+48" },
    { norm: 4 / 6, label: "+36" },
    { norm: 0.5, label: "+24" },
    { norm: 2 / 6, label: "+12" },
    { norm: 1 / 6, label: "0" },
    { norm: 0, label: "-12" },
  ];

  const FADER_SCALE_TRIM = [
    { norm: 1, label: "+18" },
    { norm: 5 / 6, label: "+12" },
    { norm: 4 / 6, label: "+6" },
    { norm: 0.5, label: "0" },
    { norm: 2 / 6, label: "-6" },
    { norm: 1 / 6, label: "-12" },
    { norm: 0, label: "-18" },
  ];

  /** Especificación del modo GAIN de una tira (o null si no admite). */
  function gainSpec(m) {
    if (m.paths.gain) {
      return {
        path: m.paths.gain,
        min: -12,
        range: 72,
        step: 0.5,
        scale: FADER_SCALE_HEADAMP,
        label: "Ganancia",
      };
    }
    if (m.paths.trim) {
      return {
        path: m.paths.trim,
        min: -18,
        range: 36,
        step: 0.25,
        scale: FADER_SCALE_TRIM,
        label: "Trim",
      };
    }
    return null;
  }

  function faderScaleHTML(gs) {
    const items = gs ? gs.scale : FADER_SCALE_MIX;
    return items
      .map(function (it) {
        const p = gs ? it.norm : dB.toFader(it.db);
        return '<span style="--p:' + p + '">' + it.label + "</span>";
      })
      .join("");
  }

  function stripHTML(m) {
    const gs = gainMode ? gainSpec(m) : null;
    const isGain = !!gs;
    const faderPath = gs ? gs.path : m.paths.fader;

    return (
      '<section class="strip" data-unit="' + m.key + '">' +
        '<header class="strip__display">' +
          '<button type="button" class="strip__color is-' + m.color + '" data-role="color" ' +
            'data-osc-path="' + m.paths.color + '" data-osc-address="' + m.paths.color + '" data-osc-type="i" ' +
            'title="Color del canal — ' + m.paths.color + ' (clic para cambiar)"></button>' +
          '<div class="strip__meta">' +
            '<span class="strip__num">' + m.num + "</span>" +
            '<input class="strip__name" type="text" maxlength="12" spellcheck="false" ' +
              'value="' + escapeHtml(m.name) + '" data-role="name" ' +
              'data-osc-path="' + m.paths.name + '" data-osc-address="' + m.paths.name + '" data-osc-type="s" ' +
              'aria-label="Etiqueta del canal ' + m.num + '">' +
          "</div>" +
        "</header>" +
        (m.hasPan ? panHTML(m) : '<div class="strip__gap" aria-hidden="true"></div>') +
        // Núcleo: fader a la izquierda, vúmetro mono a la derecha (canal mono)
        '<div class="strip__core">' +
          '<div class="fader fader--scale' + (isGain ? " is-gain" : "") + '" data-slider="vertical" data-role="fader" ' +
            'data-osc-path="' + faderPath + '" data-osc-address="' + faderPath + '" data-osc-type="f" ' +
            'aria-label="' + (gs ? gs.label + " " : "Nivel ") + escapeHtml(m.name) + '">' +
            '<div class="fader__scale' + (isGain ? " is-gain" : "") + '" aria-hidden="true">' +
              faderScaleHTML(gs) +
            "</div>" +
            '<div class="fader__track"><div class="fader__travel"><span class="fader__cap"></span></div></div>' +
          "</div>" +
          '<div class="meters">' +
            '<div class="meter-scale" data-side="l"></div>' +
            '<div class="meter-col" data-role="meter-l"></div>' +
            '<div class="meter-scale" data-side="r"></div>' +
          "</div>" +
        "</div>" +
        '<output class="readout' + (isGain ? " is-gain" : "") + '" data-role="readout">0.0</output>' +
        '<div class="strip__buttons">' +
          '<button type="button" class="btn-m' + (m.muted ? " is-on" : "") + '" data-role="mute" ' +
            'data-osc-path="' + m.paths.on + '" data-osc-address="' + m.paths.on + '" data-osc-type="i" ' +
            'data-state-value="' + (m.muted ? 0 : 1) + '" aria-pressed="' + m.muted + '" ' +
            'title="Mute — ' + m.paths.on + '">M</button>' +
          '<button type="button" class="btn-s' + (m.solo ? " is-on" : "") + '" data-role="solo" ' +
            'data-osc-path="' + m.paths.solo + '" data-osc-address="' + m.paths.solo + '" data-osc-type="i" ' +
            'data-state-value="' + (m.solo ? 1 : 0) + '" aria-pressed="' + m.solo + '" ' +
            'title="Solo — ' + m.paths.solo + '">S</button>' +
        "</div>" +
      "</section>"
    );
  }

  /* ------------------------------------------------------------- wiring */

  function wireStrip(section, m) {
    const gs = gainMode ? gainSpec(m) : null;
    const isGain = !!gs;

    /* Fader principal */
    const faderEl = section.querySelector('[data-role="fader"]');
    Controls.mount(faderEl, {
      path: faderEl.getAttribute("data-osc-path"),
      type: "f",
      value: gs ? m.gainNorm : m.faderNorm,
      display: gs
        ? function (v) { return dB.fmtGain(gs.min + v * gs.range); }
        : Controls.displayDb,
      readout: section.querySelector('[data-role="readout"]'),
      reset: gs ? (0 - gs.min) / gs.range : dB.toFader(0),
      throttle: 45,
      snap: gs ? gs.step / gs.range : 0, // headamp 0.5/72 ó trim 0.25/36 (ambos 1/144)
      toOsc: gs
        ? function (v) { return Math.round((gs.min + v * gs.range) / gs.step) * gs.step; }
        : function (v) { return v; },
      fromOsc: gs
        ? function (v) { return (parseFloat(v) - gs.min) / gs.range; }
        : function (v) { return parseFloat(v); },
    });

    /* Panorama */
    if (m.hasPan) {
      const panEl = section.querySelector('[data-role="pan"]');
      Controls.mount(panEl, {
        path: m.paths.pan,
        type: "f",
        value: m.pan,
        display: Controls.displayPan,
        reset: 0.5,
        snap: 0.01, // X32: paso de 2 en [-100 … +100]
        toOsc: function (v) { return Math.round(v * 200 - 100); },
        fromOsc: function (v) { return (parseFloat(v) + 100) / 200; },
      });
    }

    /* Mute — lógica X32: 0 = Mute/Apagado, 1 = Activo */
    const muteBtn = section.querySelector('[data-role="mute"]');
    muteBtn.addEventListener("click", function () {
      m.muted = !m.muted;
      setToggle(muteBtn, m.muted, m.muted ? 0 : 1);
      OSC.send(m.paths.on, m.muted ? 0 : 1, "i", { commit: true });
    });

    /* Solo */
    const soloBtn = section.querySelector('[data-role="solo"]');
    soloBtn.addEventListener("click", function () {
      m.solo = !m.solo;
      setToggle(soloBtn, m.solo, m.solo ? 1 : 0);
      OSC.send(m.paths.solo, m.solo ? 1 : 0, "i", { commit: true });
      notifySoloChange();
    });

    /* Color configurable: paleta X32 completa (8 colores). En buses usa el ciclo
       del selector (fuente de verdad); el resto cicla el enum completo. */
    const colorBtn = section.querySelector('[data-role="color"]');
    colorBtn.addEventListener("click", function () {
      cycleStripColor(m);
    });

    /* Etiqueta editable */
    const nameInput = section.querySelector('[data-role="name"]');
    const initialName = m.name;
    nameInput.addEventListener("change", commitName);
    nameInput.addEventListener("focus", function () {
      openChPalette(nameInput, m);
    });
    nameInput.addEventListener("blur", function () {
      closeChPalette();
    });
    nameInput.addEventListener("keydown", function (e) {
      if (e.key === "Enter") nameInput.blur();
      else if (e.key === "Escape") {
        nameInput.value = initialName;
        nameInput.blur();
      }
    });
    function commitName() {
      const v = nameInput.value.trim().slice(0, 12);
      if (!v) {
        nameInput.value = m.name;
        return;
      }
      m.name = v;
      nameInput.value = v;
      if (m.kind === "bus") applyBusName(targetById("b" + m.n), v, false);
      OSC.send(m.paths.name, v, "s", { commit: true });
    }

    /* Vúmetro mono del canal: una sola columna (el canal no es estéreo) */
    const col = section.querySelector('[data-role="meter-l"]');
    Meters.addSim(function (dt) {
      Meters.stepVoice(m.sim.L, m.voice, dt);
      Meters.stepVoice(m.sim.R, m.voice, dt);
    });
    Meters.register(col, function () { return meterLevel(m, "L"); });
  }

  /**
   * Nivel de una columna de vúmetro.
   * Prioridad: dato real del backend (/meters/1) si está fresco → simulación.
   */
  function meterLevel(m, side) {
    if (m.muted) return -95;
    const ext = m.ext;
    if (ext && ext[side] !== null && isFinite(ext[side]) && perfNow() - ext.at < EXT_TTL) {
      return ext[side];
    }
    const f = dB.fromFader(m.faderNorm);
    return m.sim[side].level + (isFinite(f) ? f : -95);
  }

  /**
   * Paquete entrante de vúmetros (llega por el bus, sin saber de red):
   *   [[L,R], [L,R], …]  → 8 tiras + master en el índice 8
   *   [L, R, L, R, …]    → formato plano L/R por tira
   *   { levels: [...] }  → envoltorio con nombre
   *
   * Unidades (p. Maillot, "Unofficial X32/M32 OSC Protocol"): el X32 envía
   * los vúmetros como float lineal 0.0…1.0 (1.0 = 0 dBFS; cabecera interna
   * hasta 8.0 = +18 dBfs). Si el paquete viene todo ≥ 0 se convierte
   * lineal→dB aquí; si trae algún valor negativo, el backend ya lo entregó
   * en dB y se toma tal cual. En m.ext siempre queda dB.
   */
  function applyMeterPacket(v) {
    let list = v;
    if (v && !Array.isArray(v) && Array.isArray(v.levels)) list = v.levels;
    if (!Array.isArray(list) || !list.length) return;

    const at = perfNow();

    // Detección de unidades sobre todos los valores del paquete
    const raw = [];
    if (Array.isArray(list[0])) {
      list.forEach(function (p) {
        if (Array.isArray(p)) raw.push(num(p[0]), num(p[1] === undefined ? p[0] : p[1]));
      });
    } else {
      list.forEach(function (x) { raw.push(num(x)); });
    }
    const linear = raw.length > 0 && raw.every(function (x) { return x >= 0; });
    const val = function (x) {
      // 0 lineal = silencio → -100 dB: finito, para que el TTL lo distinga
      // de "sin dato" (null) y el vúmetro caiga a la base en vez de simulación
      return linear && x !== null ? Math.max(-100, dB.fromLinear(x)) : x;
    };

    const pair = function (p) {
      return {
        L: val(num(p[0])),
        R: val(num(p[1] === undefined ? p[0] : p[1])),
        at: at,
      };
    };

    if (Array.isArray(list[0])) {
      activeStrips.forEach(function (m, i) {
        if (Array.isArray(list[i])) m.ext = pair(list[i]);
      });
      if (list.length > activeStrips.length && Array.isArray(list[activeStrips.length])) {
        masterExt = pair(list[activeStrips.length]);
      }
    } else {
      activeStrips.forEach(function (m, i) {
        m.ext = { L: val(num(list[i * 2])), R: val(num(list[i * 2 + 1])), at: at };
      });
      if (list.length > activeStrips.length * 2) {
        masterExt = {
          L: val(num(list[activeStrips.length * 2])),
          R: val(num(list[activeStrips.length * 2 + 1])),
          at: at,
        };
      }
    }
  }

  /* --------------------------------------------------------------- rack */

  function renderRack() {
    closeChPalette();
    Controls.destroyAll(rack);

    const list = [];
    const bank = BANKS[currentBank];
    const stripCount = bank.count || 8;
    for (let i = 0; i < stripCount; i++) list.push(modelFor(currentBank, i));
    activeStrips = list;

    const paged = currentBank === "bus";
    rack.parentElement.classList.toggle("rack--paged", paged);
    if (paged) {
      rack.setAttribute("role", "region");
      rack.setAttribute("aria-label", "Buses 1-16, desplazamiento horizontal en bloques de 8");
      rack.setAttribute("tabindex", "0");
      const pages = [];
      for (let start = 0; start < list.length; start += 8) {
        pages.push(
          '<div class="channel-page" role="group" aria-label="Buses ' +
            (start + 1) +
            " a " +
            Math.min(start + 8, list.length) +
            '">' +
            list.slice(start, start + 8).map(stripHTML).join("") +
            "</div>"
        );
      }
      rack.innerHTML = pages.join("");
    } else {
      rack.removeAttribute("role");
      rack.removeAttribute("aria-label");
      rack.removeAttribute("tabindex");
      rack.innerHTML = list.map(stripHTML).join("");
    }
    Meters.mount(rack);

    const sections = rack.querySelectorAll(".strip");
    list.forEach(function (m, i) {
      wireStrip(sections[i], m);
    });
  }

  /* ------------------------------------------------------------- master */

  /* ------------------------------------------------- selector de bus */
  /* Caja selectora propia (cuadros generosos) para MAIN LR, M/C y los 16
     buses. El botón abre un panel fijo fuera de la tarjeta —así no lo recorta
     el overflow del strip—. Clic selecciona; clic derecho o pulsación larga
     renombra el bus (persistido en localStorage y enviado por OSC). */

  let pickerLpTimer = null;
  let pickerLpStart = null;
  let pickerSuppressClick = false;
  let activeRenameInput = null;

  function targetColor(t) {
    return t && t.color ? t.color : "white";
  }

  function colorHex(c) {
    return COLOR_HEX[c] || COLOR_HEX.white;
  }

  function applyMasterColor() {
    if (!masterSelectBtn) return;
    const c = targetColor(targetById(masterTarget));
    masterSelectBtn.style.setProperty("--bus-color", colorHex(c));
    masterSelectBtn.dataset.color = c;
  }

  function refreshBusColor(t) {
    if (!busPickerEl) return;
    const cell = busPickerEl.querySelector('[data-bus-id="' + t.id + '"]');
    if (!cell) return;
    const c = targetColor(t);
    cell.dataset.color = c;
    cell.style.setProperty("--c", colorHex(c));
  }

  /** Fuente de verdad del color de un bus: selector, tira del banco Buses y
      localStorage. No envía OSC (los llamadores deciden cuándo). */
  function setBusColor(n, color) {
    const t = targetById("b" + n);
    if (!t || t.kind !== "bus" || !color || !COLOR_HEX[color]) return;
    t.color = color;
    saveBusColor(n, color);
    refreshBusColor(t);
    if (t.id === masterTarget) applyMasterColor();
    const m = store.get("bus:" + n);
    if (m) {
      m.color = color;
      const el = liveStrip(m);
      if (el) {
        const btn = el.querySelector('[data-role="color"]');
        if (btn) btn.className = "strip__color is-" + color;
      }
    }
    highlightPaletteSwatch();
  }

  function cycleTargetColor(t) {
    if (t.kind !== "bus") return;
    const idx = BUS_COLOR_CYCLE.indexOf(targetColor(t));
    const next = BUS_COLOR_CYCLE[(idx + 1) % BUS_COLOR_CYCLE.length];
    setBusColor(t.n, next);
    if (t.paths.color) OSC.send(t.paths.color, COLOR_ENUM[next], "i", { commit: true });
  }

  function buildBusPicker() {
    if (busPickerEl) return;
    busPickerEl = document.createElement("div");
    busPickerEl.className = "bus-picker";
    busPickerEl.setAttribute("role", "listbox");
    busPickerEl.setAttribute("aria-label", "Selector de bus del master");
    busPickerEl.innerHTML = MASTER_TARGETS.map(function (t) {
      const c = targetColor(t);
      return (
        '<button type="button" class="bus-cell" role="option" data-bus-id="' +
        t.id +
        '" data-color="' +
        c +
        '" style="--c:' +
        colorHex(c) +
        '" aria-selected="false">' +
        '<span class="bus-cell__tag"' +
        (t.kind === "bus" ? ' title="Color del bus — clic para cambiar"' : "") +
        ">" +
        escapeHtml(t.tag) +
        "</span>" +
        '<span class="bus-cell__name">' +
        escapeHtml(t.name) +
        "</span>" +
        "</button>"
      );
    }).join("");
    document.body.appendChild(busPickerEl);

    busPickerEl.addEventListener("click", onPickerClick);
    busPickerEl.addEventListener("contextmenu", onPickerContext);
    busPickerEl.addEventListener("pointerdown", onPickerPointerDown);
    busPickerEl.addEventListener("pointermove", onPickerPointerMove);
    busPickerEl.addEventListener("pointerup", cancelPickerLongPress);
    busPickerEl.addEventListener("pointercancel", cancelPickerLongPress);
    busPickerEl.addEventListener("pointerleave", cancelPickerLongPress);
  }

  function onPickerClick(e) {
    if (pickerSuppressClick) {
      pickerSuppressClick = false;
      return;
    }
    const cell = e.target.closest(".bus-cell");
    if (!cell || cell.querySelector("input")) return;
    if (e.target.closest(".bus-cell__tag")) {
      const t = targetById(cell.dataset.busId);
      if (t.kind === "bus") {
        cycleTargetColor(t);
        return;
      }
    }
    selectTarget(cell.dataset.busId);
    closeBusPicker();
  }

  function onPickerContext(e) {
    const cell = e.target.closest(".bus-cell");
    if (!cell) return;
    const t = targetById(cell.dataset.busId);
    if (t.kind !== "bus") return; // MAIN LR / M/C no se renombran
    e.preventDefault();
    cancelPickerLongPress();
    pickerSuppressClick = true;
    startRename(cell, t);
  }

  function onPickerPointerDown(e) {
    if (e.target.closest("input")) return;
    const cell = e.target.closest(".bus-cell");
    if (!cell || targetById(cell.dataset.busId).kind !== "bus") return;
    pickerLpStart = { x: e.clientX, y: e.clientY };
    clearTimeout(pickerLpTimer);
    pickerLpTimer = setTimeout(function () {
      pickerLpTimer = null;
      pickerSuppressClick = true;
      startRename(cell, targetById(cell.dataset.busId));
    }, 480);
  }

  function onPickerPointerMove(e) {
    if (!pickerLpStart) return;
    if (Math.abs(e.clientX - pickerLpStart.x) > 8 || Math.abs(e.clientY - pickerLpStart.y) > 8)
      cancelPickerLongPress();
  }

  function cancelPickerLongPress() {
    clearTimeout(pickerLpTimer);
    pickerLpTimer = null;
    pickerLpStart = null;
  }

  function startRename(cell, t) {
    if (cell.querySelector("input")) return;
    const nameEl = cell.querySelector(".bus-cell__name");
    const prev = t.name;
    const input = document.createElement("input");
    input.type = "text";
    input.className = "bus-cell__edit";
    input.value = prev;
    input.maxLength = 12;
    nameEl.textContent = "";
    nameEl.appendChild(input);
    cell.classList.add("is-editing");
    activeRenameInput = input;
    input.focus();
    input.select();

    let done = false;
    function finish(save) {
      if (done) return;
      done = true;
      if (activeRenameInput === input) activeRenameInput = null;
      const val = input.value.trim().slice(0, 12);
      cell.classList.remove("is-editing");
      nameEl.textContent = ""; // quita el input; el nombre lo repinta refreshBusCell
      if (save && val && val !== prev) applyBusName(t, val, true);
      else nameEl.textContent = t.name;
    }
    input.addEventListener("keydown", function (e) {
      e.stopPropagation();
      if (e.key === "Enter") {
        e.preventDefault();
        finish(true);
      } else if (e.key === "Escape") {
        e.preventDefault();
        finish(false);
      }
    });
    input.addEventListener("blur", function () {
      finish(true);
    });
    input.addEventListener("click", function (e) {
      e.stopPropagation();
    });
    input.addEventListener("pointerdown", function (e) {
      e.stopPropagation();
    });
  }

  function applyBusName(t, name, broadcast) {
    name = String(name == null ? "" : name).trim().slice(0, 12);
    if (!name) return;
    const changed = name !== t.name;
    t.name = name;
    if (t.kind === "bus") saveBusName(t.n, name);
    refreshBusCell(t);
    if (t.id === masterTarget) updateMasterLabel();
    if (broadcast && changed && t.paths.name) OSC.send(t.paths.name, name, "s", { commit: true });
    if (t.kind === "bus") {
      // La tira del banco Buses comparte el nombre
      const m = store.get("bus:" + t.n);
      if (m) {
        m.name = name;
        const el = liveStrip(m);
        if (el) {
          const input = el.querySelector('[data-role="name"]');
          if (input && document.activeElement !== input) input.value = name;
        }
      }
    }
  }

  function refreshBusCell(t) {
    if (!busPickerEl) return;
    const cell = busPickerEl.querySelector('[data-bus-id="' + t.id + '"]');
    if (!cell) return;
    const nameEl = cell.querySelector(".bus-cell__name");
    if (nameEl && !nameEl.querySelector("input")) nameEl.textContent = t.name;
  }

  function updatePickerActive() {
    if (!busPickerEl) return;
    busPickerEl.querySelectorAll(".bus-cell").forEach(function (cell) {
      const on = cell.dataset.busId === masterTarget;
      cell.classList.toggle("is-active", on);
      cell.setAttribute("aria-selected", on ? "true" : "false");
    });
  }

  function placeBusPicker() {
    if (!busPickerEl || !masterSelectBtn) return;
    const r = masterSelectBtn.getBoundingClientRect();
    const pr = busPickerEl.getBoundingClientRect();
    let left = r.left;
    let top = r.bottom + 4;
    if (left + pr.width > window.innerWidth - 8)
      left = Math.max(8, window.innerWidth - 8 - pr.width);
    if (top + pr.height > window.innerHeight - 8) {
      const above = r.top - 4 - pr.height;
      top = above >= 8 ? above : Math.max(8, window.innerHeight - 8 - pr.height);
    }
    busPickerEl.style.left = left + "px";
    busPickerEl.style.top = top + "px";
  }

  function openBusPicker() {
    buildBusPicker();
    updatePickerActive();
    busPickerEl.classList.add("is-open");
    if (masterSelectBtn) masterSelectBtn.setAttribute("aria-expanded", "true");
    placeBusPicker();
    document.addEventListener("pointerdown", onDocPointerDown, true);
    document.addEventListener("keydown", onDocKeyDown, true);
    window.addEventListener("resize", placeBusPicker);
    window.addEventListener("scroll", placeBusPicker, true);
  }

  function closeBusPicker() {
    if (!busPickerEl) return;
    cancelPickerLongPress();
    if (activeRenameInput) activeRenameInput.blur();
    busPickerEl.classList.remove("is-open");
    if (masterSelectBtn) masterSelectBtn.setAttribute("aria-expanded", "false");
    document.removeEventListener("pointerdown", onDocPointerDown, true);
    document.removeEventListener("keydown", onDocKeyDown, true);
    window.removeEventListener("resize", placeBusPicker);
    window.removeEventListener("scroll", placeBusPicker, true);
  }

  function toggleBusPicker() {
    if (busPickerEl && busPickerEl.classList.contains("is-open")) closeBusPicker();
    else openBusPicker();
  }

  function onDocPointerDown(e) {
    if (busPickerEl && busPickerEl.contains(e.target)) return;
    if (masterSelectBtn && masterSelectBtn.contains(e.target)) return;
    closeBusPicker();
  }

  function onDocKeyDown(e) {
    if (e.key !== "Escape") return;
    if (activeRenameInput) return; // lo cancela el propio input
    e.stopPropagation();
    closeBusPicker();
  }

  /* --------------------------------------------------- color de canal --- */
  /* Aplica el color a una tira (canal/aux/fx/dca): modelo, barra, paleta y
     persistencia. No envía OSC (los llamadores deciden). */
  function applyStripColor(m, color) {
    if (!color || !COLOR_HEX[color] || color === m.color) return;
    m.color = color;
    const el = liveStrip(m);
    if (el) {
      const btn = el.querySelector('[data-role="color"]');
      if (btn) btn.className = "strip__color is-" + color;
    }
    saveChColor(m.kind + ":" + m.n, color);
    highlightPaletteSwatch();
  }

  /* Ciclo de la barra de color: en buses sigue al selector; el resto recorre
     los 8 colores del enum X32 (OFF → RD → GN → YE → BL → MG → CY → WH). */
  function cycleStripColor(m) {
    if (m.kind === "bus") {
      const t = targetById("b" + m.n);
      const idx = BUS_COLOR_CYCLE.indexOf(targetColor(t));
      const next = BUS_COLOR_CYCLE[(idx + 1) % BUS_COLOR_CYCLE.length];
      setBusColor(m.n, next);
      OSC.send(m.paths.color, COLOR_ENUM[next], "i", { commit: true });
      return;
    }
    const idx = CH_COLOR_CYCLE.indexOf(m.color);
    const next = CH_COLOR_CYCLE[(idx + 1) % CH_COLOR_CYCLE.length];
    applyStripColor(m, next);
    OSC.send(m.paths.color, COLOR_ENUM[next], "i", { commit: true });
  }

  /* Paleta rápida de 8 colores: se abre al editar el nombre de la tira (táctil
     amigable; objetivo grande). Panel fijo en body → no lo recorta el overflow
     del strip. */
  let chPaletteEl = null;
  let chPaletteModel = null; // tira a la que pertenece la paleta abierta
  let chPaletteInput = null; // input de nombre asociado

  function buildChPalette() {
    if (chPaletteEl) return;
    chPaletteEl = document.createElement("div");
    chPaletteEl.className = "ch-palette";
    chPaletteEl.setAttribute("role", "listbox");
    chPaletteEl.setAttribute("aria-label", "Color del canal — paleta X32");
    chPaletteEl.innerHTML = ["off", "red", "green", "yellow", "blue", "magenta", "cyan", "white"]
      .map(function (c) {
        return (
          '<button type="button" class="ch-palette__swatch is-' + c + '" role="option" data-color="' + c + '" ' +
            'style="--c:' + colorHex(c) + '" aria-label="Color ' + c + '"></button>'
        );
      })
      .join("");
    document.body.appendChild(chPaletteEl);
    chPaletteEl.addEventListener("click", function (e) {
      const sw = e.target.closest(".ch-palette__swatch");
      if (!sw || !chPaletteModel) return;
      const m = chPaletteModel;
      const color = sw.dataset.color;
      // pointerdown hace preventDefault: el input conserva el foco y la edición
      // del nombre continúa tras elegir color.
      if (m.kind === "bus") setBusColor(m.n, color);
      else applyStripColor(m, color);
      OSC.send(m.paths.color, COLOR_ENUM[color], "i", { commit: true });
    });
    chPaletteEl.addEventListener("pointerdown", function (e) {
      if (e.target.closest(".ch-palette__swatch")) e.preventDefault();
    });
  }

  function highlightPaletteSwatch() {
    if (!chPaletteEl || !chPaletteModel) return;
    chPaletteEl.querySelectorAll(".ch-palette__swatch").forEach(function (b) {
      b.classList.toggle("is-current", b.dataset.color === chPaletteModel.color);
    });
  }

  function placeChPalette() {
    if (!chPaletteEl || !chPaletteInput) return;
    const r = chPaletteInput.getBoundingClientRect();
    const pr = chPaletteEl.getBoundingClientRect();
    let left = r.left;
    let top = r.bottom + 6;
    if (left + pr.width > window.innerWidth - 8)
      left = Math.max(8, window.innerWidth - 8 - pr.width);
    if (top + pr.height > window.innerHeight - 8) {
      const above = r.top - 6 - pr.height;
      top = above >= 8 ? above : Math.max(8, window.innerHeight - 8 - pr.height);
    }
    chPaletteEl.style.left = left + "px";
    chPaletteEl.style.top = top + "px";
  }

  function openChPalette(input, m) {
    buildChPalette();
    chPaletteModel = m;
    chPaletteInput = input;
    chPaletteEl.classList.add("is-open");
    highlightPaletteSwatch();
    placeChPalette();
    document.addEventListener("pointerdown", onChPaletteDocPointerDown, true);
    document.addEventListener("keydown", onChPaletteDocKeyDown, true);
    window.addEventListener("resize", placeChPalette);
    window.addEventListener("scroll", placeChPalette, true);
  }

  function closeChPalette() {
    if (!chPaletteEl) return;
    chPaletteEl.classList.remove("is-open");
    chPaletteModel = null;
    chPaletteInput = null;
    document.removeEventListener("pointerdown", onChPaletteDocPointerDown, true);
    document.removeEventListener("keydown", onChPaletteDocKeyDown, true);
    window.removeEventListener("resize", placeChPalette);
    window.removeEventListener("scroll", placeChPalette, true);
  }

  function onChPaletteDocPointerDown(e) {
    if (chPaletteEl && chPaletteEl.contains(e.target)) return;
    if (chPaletteInput && (chPaletteInput === e.target || chPaletteInput.contains(e.target))) return;
    closeChPalette();
  }

  function onChPaletteDocKeyDown(e) {
    if (e.key !== "Escape") return;
    e.stopPropagation();
    closeChPalette();
  }

  function selectTarget(id) {
    const t = targetById(id);
    if (!t || t.id !== id) return;
    masterTarget = id;
    const st = stateFor(id);
    masterSlider.setPath(t.paths.fader);
    masterSlider.setValue(st.faderNorm, { silent: true });
    setToggle(masterMuteBtn, st.muted, st.muted ? 0 : 1);
    updateMasterLabel();
    updatePickerActive();
  }

  /* ------------------------------------------------------------- master */

  function wireMaster() {
    const faderEl = masterEl.querySelector('[data-role="fader"]');
    const scaleEl = masterEl.querySelector(".fader__scale");
    if (scaleEl) scaleEl.innerHTML = faderScaleHTML(null);

    masterMuteBtn = masterEl.querySelector('[data-role="mute"]');
    masterSelectBtn = masterEl.querySelector('[data-action="master-select"]');
    buildBusPicker();

    masterSlider = Controls.mount(faderEl, {
      path: masterPaths(masterTarget).fader,
      type: "f",
      value: stateFor(masterTarget).faderNorm,
      display: Controls.displayDb,
      readout: masterEl.querySelector('[data-role="readout"]'),
      reset: dB.toFader(0),
      throttle: 45,
    });

    masterMuteBtn.addEventListener("click", function () {
      const st = stateFor(masterTarget);
      st.muted = !st.muted;
      setToggle(masterMuteBtn, st.muted, st.muted ? 0 : 1);
      OSC.send(masterPaths(masterTarget).on, st.muted ? 0 : 1, "i", { commit: true });
    });

    masterSelectBtn.addEventListener("click", function (e) {
      e.preventDefault();
      toggleBusPicker();
    });

    /* Entrada remota (consola → UI) para todos los destinos */
    MASTER_TARGETS.forEach(function (t) {
      const p = t.paths;
      lifeUnsubs.push(
        OSC.on(p.fader, function (v) {
          const st = stateFor(t.id);
          st.faderNorm = dB.clamp01(parseFloat(v));
          if (t.id === masterTarget && masterSlider && !masterSlider.dragging)
            masterSlider.setValue(st.faderNorm, { silent: true });
        }),
        OSC.on(p.on, function (v) {
          const st = stateFor(t.id);
          st.muted = !isOn(v);
          if (t.id === masterTarget) setToggle(masterMuteBtn, st.muted, st.muted ? 0 : 1);
        })
      );
      if (p.name) {
        lifeUnsubs.push(
          OSC.on(p.name, function (v) {
            applyBusName(t, String(v), false);
          })
        );
      }
      if (t.kind === "bus" && p.color) {
        lifeUnsubs.push(
          OSC.on(p.color, function (v) {
            setBusColor(t.n, COLOR_FROM_ENUM[parseInt(v, 10)]);
          })
        );
      }
    });

    updateMasterLabel();
    updatePickerActive();
  }

  function updateMasterLabel() {
    const t = targetById(masterTarget);
    if (masterSelectBtn) {
      const span = masterSelectBtn.querySelector(".master__select-name");
      if (span) span.textContent = t.name;
    }
    if (masterMuteBtn) {
      masterMuteBtn.setAttribute("data-osc-path", t.paths.on);
      masterMuteBtn.setAttribute("data-osc-address", t.paths.on);
    }
    applyMasterColor();
  }

  function registerMasterMeters() {
    Meters.mount(masterEl); // escala + segmentos (idempotente)
    const voice = Meters.MASTER_VOICE;
    Meters.addSim(function (dt) {
      Meters.stepVoice(masterSim.L, voice, dt);
      Meters.stepVoice(masterSim.R, voice, dt);
    });
    Meters.register(
      masterEl.querySelector('[data-role="meter-l"]'),
      function () { return masterLevel("L"); }
    );
    Meters.register(
      masterEl.querySelector('[data-role="meter-r"]'),
      function () { return masterLevel("R"); }
    );
  }

  function masterLevel(side) {
    const st = stateFor(masterTarget);
    if (st.muted) return -95;
    if (
      masterExt &&
      masterExt[side] !== null &&
      isFinite(masterExt[side]) &&
      perfNow() - masterExt.at < EXT_TTL
    ) {
      return masterExt[side];
    }
    const f = dB.fromFader(st.faderNorm);
    return masterSim[side].level + (isFinite(f) ? f : -95);
  }

  /* ------------------------------------------------------------- rebuild */

  function rebuild() {
    Meters.reset();
    renderRack();
    registerMasterMeters();
  }

  /* --------------------------------------------------------------- API */

  function setBank(bankId) {
    if (!BANKS[bankId]) return false;
    currentBank = bankId;
    rebuild();
    return true;
  }

  function supportsGain() {
    const kind = BANKS[currentBank].kind;
    return kind === "ch" || kind === "aux";
  }

  function setGainMode(on) {
    on = !!on && supportsGain();
    if (on === gainMode) return gainMode;
    gainMode = on;
    rebuild();
    return gainMode;
  }

  function isGainMode() {
    return gainMode;
  }

  function hasSolo() {
    let found = false;
    store.forEach(function (m) {
      if (m.solo) found = true;
    });
    return found;
  }

  function clearSolo() {
    store.forEach(function (m) {
      if (!m.solo) return;
      m.solo = false;
      refreshSolo(m);
      OSC.send(m.paths.solo, 0, "i", { commit: true });
    });
    notifySoloChange();
  }

  function init() {
    rack = document.getElementById("channel-rack");
    masterEl = document.querySelector(".strip--master");

    // Vúmetros reales: el transporte (websocketClient.js) los mete en el bus
    // y aquí sólo se traducen a DOM. Caducan a los EXT_TTL ms y se vuelve
    // a la simulación si el backend deja de enviar.
    lifeUnsubs.push(OSC.on("/meters/1", applyMeterPacket));

    rebuild();
    wireMaster();
    Meters.start();
  }

  return {
    init: init,
    setBank: setBank,
    setGainMode: setGainMode,
    isGainMode: isGainMode,
    supportsGain: supportsGain,
    clearSolo: clearSolo,
    hasSolo: hasSolo,
    get bank() { return currentBank; },
  };
})();
