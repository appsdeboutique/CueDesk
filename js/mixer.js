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
    bus: { kind: "bus", label: "Bus Mtx", from: 1 },
  };

  const COLOR_CYCLE = ["green", "red", "yellow"];
  // X32 config/color: {OFF:0, RD:1, GN:2, YE:3, BL:4, MG:5, CY:6, WH:7}
  const COLOR_ENUM = { red: 1, green: 2, yellow: 3 };

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
  const masterState = {
    st: { faderNorm: dB.toFader(-6), muted: false },
    m: { faderNorm: dB.toFader(-6), muted: false },
  };
  const masterSim = {
    L: { level: Meters.MASTER_VOICE.base },
    R: { level: Meters.MASTER_VOICE.base },
  };

  /** Niveles reales recibidos del backend (/meters/1); TTL para caducar. */
  const EXT_TTL = 1200;
  let masterExt = null; // { L, R, at }

  /* ------------------------------------------------------------- helpers */

  function p2(n) {
    return String(n).padStart(2, "0");
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
          trim: "/ch/" + id + "/preamp/trim",
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
      case "dca": return "DCA " + n;
    }
    return p2(n);
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
    m = {
      key: key,
      kind: bank.kind,
      n: n,
      num: numFor(bank.kind, n),
      name: nameFor(bank.kind, n, i),
      color: DEFAULT_COLORS[i],
      paths: pathsFor(bank.kind, n),
      hasPan: bank.kind !== "dca",
      faderNorm: dB.toFader(DEFAULT_DB[i]),
      gainNorm: 0.5,                       // 0 dB de trim
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
          if (!name || name === m.name) return;
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
          // X32 config/color: {OFF:0, RD:1, GN:2, YE:3, …}
          const map = { 1: "red", 2: "green", 3: "yellow" };
          const next = map[parseInt(v, 10)];
          if (!next || next === m.color) return;
          m.color = next;
          const el = liveStrip(m);
          if (el) {
            const btn = el.querySelector('[data-role="color"]');
            if (btn) btn.className = "strip__color is-" + next;
          }
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
      else if (m.paths.trim && path === m.paths.trim)
        m.gainNorm = dB.clamp01((parseFloat(value) + 18) / 36);
    });

    if (path === masterPaths().fader)
      masterState[masterTarget].faderNorm = dB.clamp01(parseFloat(value));
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
          '<span class="hslider__track"><span class="hslider__thumb"></span></span>' +
        "</div>" +
        // Eje central, siempre centrado debajo del recorrido (el valor vive
        // en aria-valuetext, no en texto estático)
        '<span class="pan__center" aria-hidden="true">C</span>' +
      "</div>"
    );
  }

  function stripHTML(m) {
    const isGain = gainMode && !!m.paths.trim;
    const faderPath = isGain ? m.paths.trim : m.paths.fader;

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
        '<div class="meters">' +
          '<div class="meter-scale" data-side="l"></div>' +
          '<div class="meter-col" data-role="meter-l"></div>' +
          '<div class="meter-col" data-role="meter-r"></div>' +
          '<div class="meter-scale" data-side="r"></div>' +
        "</div>" +
        '<div class="fader" data-slider="vertical" data-role="fader" ' +
          'data-osc-path="' + faderPath + '" data-osc-address="' + faderPath + '" data-osc-type="f" ' +
          'aria-label="Nivel ' + escapeHtml(m.name) + '">' +
          '<div class="fader__track"><div class="fader__travel"><span class="fader__cap"></span></div></div>' +
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
    const isGain = gainMode && !!m.paths.trim;

    /* Fader principal */
    const faderEl = section.querySelector('[data-role="fader"]');
    Controls.mount(faderEl, {
      path: faderEl.getAttribute("data-osc-path"),
      type: "f",
      value: isGain ? m.gainNorm : m.faderNorm,
      display: isGain ? Controls.displayGain : Controls.displayDb,
      readout: section.querySelector('[data-role="readout"]'),
      reset: isGain ? 0.5 : dB.toFader(0),
      throttle: 45,
      snap: isGain ? 1 / 72 : 0, // paso de 0.5 dB en trim (-18…+18)
      toOsc: isGain
        ? function (v) { return Math.round((-18 + v * 36) * 2) / 2; }
        : function (v) { return v; },
      fromOsc: isGain
        ? function (v) { return (parseFloat(v) + 18) / 36; }
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

    /* Color configurable: verde → rojo → amarillo */
    const colorBtn = section.querySelector('[data-role="color"]');
    colorBtn.addEventListener("click", function () {
      const idx = COLOR_CYCLE.indexOf(m.color);
      m.color = COLOR_CYCLE[(idx + 1) % COLOR_CYCLE.length];
      colorBtn.className = "strip__color is-" + m.color;
      OSC.send(m.paths.color, COLOR_ENUM[m.color], "i", { commit: true });
    });

    /* Etiqueta editable */
    const nameInput = section.querySelector('[data-role="name"]');
    const initialName = m.name;
    nameInput.addEventListener("change", commitName);
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
      OSC.send(m.paths.name, v, "s", { commit: true });
    }

    /* Vúmetros */
    const colL = section.querySelector('[data-role="meter-l"]');
    const colR = section.querySelector('[data-role="meter-r"]');
    Meters.addSim(function (dt) {
      Meters.stepVoice(m.sim.L, m.voice, dt);
      Meters.stepVoice(m.sim.R, m.voice, dt);
    });
    Meters.register(colL, function () { return meterLevel(m, "L"); });
    Meters.register(colR, function () { return meterLevel(m, "R"); });
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
   */
  function applyMeterPacket(v) {
    let list = v;
    if (v && !Array.isArray(v) && Array.isArray(v.levels)) list = v.levels;
    if (!Array.isArray(list) || !list.length) return;

    const at = perfNow();
    const pair = function (p) {
      return {
        L: num(p[0]),
        R: num(p[1] === undefined ? p[0] : p[1]),
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
        m.ext = { L: num(list[i * 2]), R: num(list[i * 2 + 1]), at: at };
      });
      if (list.length > activeStrips.length * 2) {
        masterExt = {
          L: num(list[activeStrips.length * 2]),
          R: num(list[activeStrips.length * 2 + 1]),
          at: at,
        };
      }
    }
  }

  /* --------------------------------------------------------------- rack */

  function renderRack() {
    Controls.destroyAll(rack);

    const list = [];
    for (let i = 0; i < 8; i++) list.push(modelFor(currentBank, i));
    activeStrips = list;

    rack.innerHTML = list.map(stripHTML).join("");
    Meters.mount(rack);

    const sections = rack.querySelectorAll(".strip");
    list.forEach(function (m, i) {
      wireStrip(sections[i], m);
    });
  }

  /* ------------------------------------------------------------- master */

  function masterPaths(t) {
    return t === "m"
      ? { fader: "/main/m/mix/fader", on: "/main/m/mix/on" }
      : { fader: "/main/st/mix/fader", on: "/main/st/mix/on" };
  }

  function wireMaster() {
    const faderEl = masterEl.querySelector('[data-role="fader"]');
    masterSlider = Controls.mount(faderEl, {
      path: masterPaths(masterTarget).fader,
      type: "f",
      value: masterState[masterTarget].faderNorm,
      display: Controls.displayDb,
      readout: masterEl.querySelector('[data-role="readout"]'),
      reset: dB.toFader(0),
      throttle: 45,
    });

    const muteBtn = masterEl.querySelector('[data-role="mute"]');
    muteBtn.addEventListener("click", function () {
      const st = masterState[masterTarget];
      st.muted = !st.muted;
      setToggle(muteBtn, st.muted, st.muted ? 0 : 1);
      OSC.send(masterPaths(masterTarget).on, st.muted ? 0 : 1, "i", { commit: true });
    });

    const select = masterEl.querySelector('[data-action="master-select"]');
    select.addEventListener("change", function () {
      masterTarget = select.value === "m" ? "m" : "st";
      const st = masterState[masterTarget];
      masterSlider.setPath(masterPaths(masterTarget).fader);
      masterSlider.setValue(st.faderNorm, { silent: true });
      setToggle(muteBtn, st.muted, st.muted ? 0 : 1);
      updateMasterLabel();
    });

    /* Entrada remota (consola → UI) */
    ["st", "m"].forEach(function (t) {
      const paths = masterPaths(t);
      lifeUnsubs.push(
        OSC.on(paths.fader, function (v) {
          masterState[t].faderNorm = dB.clamp01(parseFloat(v));
          if (t === masterTarget && masterSlider && !masterSlider.dragging)
            masterSlider.setValue(masterState[t].faderNorm, { silent: true });
        }),
        OSC.on(paths.on, function (v) {
          masterState[t].muted = !isOn(v);
          if (t === masterTarget)
            setToggle(
              masterEl.querySelector('[data-role="mute"]'),
              masterState[t].muted,
              masterState[t].muted ? 0 : 1
            );
        })
      );
    });

    updateMasterLabel();
  }

  function updateMasterLabel() {
    const tag = masterEl.querySelector(".master__label .tag");
    const name = masterEl.querySelector(".master__label .master__name");
    if (masterTarget === "m") {
      tag.textContent = "M/C";
      name.textContent = "Main M/C";
    } else {
      tag.textContent = "LR";
      name.textContent = "Main LR";
    }
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
    const st = masterState[masterTarget];
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
