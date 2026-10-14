/* ==========================================================================
 * CueDesk — app.js
 * Cabecera, barra de control global, selector de bancos y arranque.
 *
 * Nota OSC: todo control que afecta a un parámetro de la consola declara
 * data-osc-path (+ alias data-osc-address) con rutas oficiales X32.
 * Los controles puramente de vista (tabs, capas de banco, sesión, preview
 * local) son estado del cliente — igual que en X32-Edit, donde la selección
 * de capa no existe como parámetro de consola — por eso usan data-action.
 * ========================================================================== */

window.CueDesk = window.CueDesk || {};

CueDesk.app = { view: "mixer" };

(function () {
  const Mixer = CueDesk.Mixer;
  const Controls = CueDesk.Controls;
  const OSC = CueDesk.OSC;
  const dB = CueDesk.dB;

  let toastTimer = null;

  /* ------------------------------------------------------------- helpers */

  function toast(msg) {
    const el = document.getElementById("toast");
    if (!el) return;
    el.textContent = msg;
    el.classList.add("is-visible");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      el.classList.remove("is-visible");
    }, 2400);
  }

  function setPressed(btn, on, oscValue) {
    btn.classList.toggle("is-active", !!on);
    btn.setAttribute("aria-pressed", on ? "true" : "false");
    btn.setAttribute("data-state-value", String(oscValue));
  }

  function isOn(v) {
    return v === 1 || v === "1" || v === "ON" || v === "on" || v === true;
  }

  /* ----------------------------------------------------- ENLACE WEBSOCKET */

  /**
   * Pinta el estado del transporte (capa de websocketClient.js) en el LED del
   * header y gestiona el panel de endpoint. Esta capa NO hace red: sólo
   * escucha el evento "cuedesk:link" y llama a CueDesk.WS.
   */
  function initLink() {
    const WS = CueDesk.WS;
    const chip = document.querySelector('[data-action="conn"]');
    if (!chip || !WS) return;

    const led = chip.querySelector(".led");
    const label = chip.querySelector(".conn__label");
    const panel = document.getElementById("conn-panel");
    const input = panel && panel.querySelector('[data-role="conn-url"]');
    const stateOut = panel && panel.querySelector('[data-role="conn-state"]');
    const statsOut = panel && panel.querySelector('[data-role="conn-stats"]');

    function render(d) {
      d = d || WS.status();
      const on = d.state === "online";
      const retrying = d.state === "connecting" || d.state === "reconnecting";

      led.className = "led " + (on ? "led--green" : retrying ? "led--amber" : "led--red");
      label.textContent = on ? "Online" : "Offline";
      chip.classList.toggle("is-online", on);
      chip.classList.toggle("is-retry", retrying);
      chip.title =
        (on ? "Enlace activo con " : "Sin enlace · ") +
        (d.url || "sin endpoint") +
        (d.attempt ? " · reintento #" + d.attempt : "") +
        (d.queued ? " · " + d.queued + " msg en cola" : "");
      document.body.classList.toggle("is-online", on);

      if (stateOut) {
        stateOut.textContent = on ? "ONLINE" : retrying ? "RECONECTANDO…" : "OFFLINE";
        stateOut.className =
          "conn-panel__state " + (on ? "is-on" : retrying ? "is-retry" : "is-off");
      }
      if (statsOut && d.stats) {
        statsOut.textContent =
          "enviados " + d.stats.sent +
          " · recibidos " + d.stats.received +
          " · cola " + (d.queued || 0) +
          (d.attempt ? " · intento " + d.attempt : "");
      }
    }

    function openPanel() {
      if (!panel) return;
      panel.hidden = false;
      chip.setAttribute("aria-expanded", "true");
      if (input) {
        input.value = WS.url || "";
        input.focus();
        input.select();
      }
      render(WS.status());
    }

    function closePanel() {
      if (!panel) return;
      panel.hidden = true;
      chip.setAttribute("aria-expanded", "false");
    }

    chip.addEventListener("click", function () {
      if (!panel) return;
      if (panel.hidden) openPanel();
      else closePanel();
    });

    document.addEventListener("cuedesk:link", function (e) {
      render(e.detail);
    });

    if (panel) {
      const btnConnect = panel.querySelector('[data-action="conn-connect"]');
      const btnDisconnect = panel.querySelector('[data-action="conn-disconnect"]');
      const btnClose = panel.querySelector('[data-action="conn-close"]');

      btnConnect.addEventListener("click", function () {
        const url = input.value.trim();
        if (url) WS.configure(url);
        WS.connect();
        toast(WS.url ? "Conectando con " + WS.url : "Enlace desactivado");
      });

      btnDisconnect.addEventListener("click", function () {
        WS.disconnect();
        toast("Enlace detenido");
        render(WS.status());
      });

      btnClose.addEventListener("click", function () {
        closePanel();
        chip.focus();
      });

      input.addEventListener("keydown", function (e) {
        if (e.key === "Enter") {
          e.preventDefault();
          btnConnect.click();
        } else if (e.key === "Escape") {
          e.preventDefault();
          closePanel();
          chip.focus();
        }
      });

      // Clic fuera del panel → cerrar
      document.addEventListener("pointerdown", function (e) {
        if (panel.hidden) return;
        if (panel.contains(e.target) || chip.contains(e.target)) return;
        closePanel();
      });
    }

    render(WS.status());
  }

  /* --------------------------------------------------------------- tabs */

  function initSetupTabs() {
    const tabs = Array.prototype.slice.call(document.querySelectorAll("[data-setup-tab]"));
    tabs.forEach(function (tab) {
      tab.addEventListener("click", function () {
        const key = tab.dataset.setupTab;
        tabs.forEach(function (t) {
          const active = t === tab;
          t.classList.toggle("is-active", active);
          t.setAttribute("aria-selected", active ? "true" : "false");
        });
        document.querySelectorAll("[data-setup-pane]").forEach(function (pane) {
          pane.hidden = pane.dataset.setupPane !== key;
        });
      });
    });
  }

  /* ------------------------------------------------------------- Setup */

  const SETUP_CONFIRM = /^(\/-prefs\/(clockrate|clocksource|card\/|remote\/ioenable)|\/headamp\/\d{3}\/phantom)/;
  const SETUP_CONFIRM_MSG =
    "Este cambio puede interrumpir el audio o la conexión de la consola. ¿Continuar?";
  const SETUP_LOCAL_KEY = "cuedesk.setup.local";
  const SETUP_IOENABLE = "/-prefs/remote/ioenable";
  const PREAMP_BLOCKS = [
    { label: "Local 1-8", base: 0 },
    { label: "Local 9-16", base: 8 },
    { label: "Local 17-24", base: 16 },
    { label: "Local 25-32", base: 24 },
  ];
  let setupIoMask = 0;
  const setupBitInputs = [];

  function sel(label, path, options) {
    return { label: label, kind: "select", path: path, type: "i", options: options };
  }
  function bool(label, path) {
    return { label: label, kind: "bool", path: path, type: "i" };
  }
  function bit(label, n) {
    return { label: label, kind: "bool", path: SETUP_IOENABLE, type: "i", bit: n };
  }
  function num(label, path, min, max, step) {
    return { label: label, kind: "num", path: path, type: "f", min: min, max: max, step: step };
  }
  function lbool(label, key) {
    return { label: label, kind: "bool", local: key };
  }
  function lsel(label, key, options) {
    return { label: label, kind: "select", local: key, options: options };
  }
  function dis(label, options) {
    return { label: label, kind: options ? "select" : "bool", options: options };
  }
  function txt(label) {
    return { label: label, kind: "text" };
  }
  function btn(label, run) {
    return { label: label, kind: "action", run: run };
  }

  /* Controles de cada subpestaña. Sin path = deshabilitado (ruta no confirmada
     en los headers de Maillot o sin equivalente en la web). */
  const SETUP_SPEC = {
    connection: [
      { title: "Mixer", items: [txt("Manual IP"), btn("Rescan"), btn("Select Mixer from list"), btn("Rename Mixer")] },
      { title: "Conexión", items: [
        btn("Abrir panel de conexión", function () {
          const b = document.querySelector('[data-action="conn"]');
          if (b) b.click();
        }),
        lbool("Auto Connect", "conn.auto"),
        lbool("Auto Sync", "conn.sync"),
        lsel("Sync direction", "conn.dir", ["Mixer → PC", "PC → Mixer"]),
        btn("Synchronize"),
      ] },
      { title: "Este equipo", items: [txt("IP Address(es)")] },
    ],
    mixer: [
      { title: "Sample rate", items: [
        sel("Sample rate", "/-prefs/clockrate", ["48 kHz", "44.1 kHz"]),
        sel("Synchronization", "/-prefs/clocksource", ["Internal", "AES50 A", "AES50 B", "Exp Card"]),
        sel("Show control", "/-prefs/show_control", ["Cues", "Scenes", "Snippets"]),
        dis("Panning mode", ["LR + Mono", "LCR enable"]),
      ] },
      { title: "General prefs", items: [
        bool("Scene Go Next", "/-prefs/scene_advance"),
        bool("Safe Main Levels", "/-prefs/safe_masterlevels"),
        sel("12h clock mode", "/-prefs/clockmode", ["24h", "12h"]),
      ] },
      { title: "Mute system", items: [bool("Hard Mutes", "/-prefs/hardmute"), dis("DCA Groups"), dis("Channel ON buttons")] },
      { title: "Link preferences", items: [
        bool("HA Config", "/config/linkcfg/hadly"),
        bool("EQ", "/config/linkcfg/eq"),
        bool("Dyn", "/config/linkcfg/dyn"),
        bool("Fader, Mute", "/config/linkcfg/fdrmute"),
        dis("M/C depends on Main LR"),
      ] },
      { title: "Confirm pop-ups", items: [
        bool("General", "/-prefs/confirm_general"),
        bool("Overwrite/Delete", "/-prefs/confirm_overwrite"),
        bool("Scene/Preset Load", "/-prefs/confirm_sceneload"),
      ] },
      { title: "View preferences", items: [bool("Select follows Bank", "/-prefs/selfollowsbank"), bool("Auto Select", "/-prefs/autosel")] },
      { title: "Initialize / boot / time", items: [btn("Initialize settings"), btn("Custom boot file: Create"), btn("Sync Mixer")] },
    ],
    gui: [
      { title: "PC show control", items: [
        lsel("Show control", "gui.showctl", ["PC Cues", "PC Scenes", "PC Snippets", "Use mixer setting"]),
        lsel("PC transport", "gui.transport", ["USB 2-Track", "Live 32-Track"]),
      ] },
      { title: "Preferences", items: [
        lbool("Fader mode fine", "gui.faderfine"),
        lbool("Tap flashing always", "gui.tapflash"),
        lbool("Bus button names", "gui.busnames"),
        lbool("Deactivate mouse wheel", "gui.wheel"),
        lbool("DCA-Spill layer jump", "gui.dcaspill"),
      ] },
      { title: "Mixer UI link", items: [
        lbool("Selected screen follows mixer", "gui.linkscreen"),
        lbool("Selected channel follows mixer", "gui.linkchan"),
      ] },
      { title: "Window mode", items: [lbool("Restore windows at startup", "gui.restore"), btn("Shortcut keys"), btn("Initialize")] },
      { title: "Sends taps", items: [lbool("Apply changes to all channels", "gui.sendtaps")] },
      { title: "Reduced update rate", items: [lbool("Meter 50%", "gui.meter50"), lbool("RTA 50%", "gui.rta50")] },
      { title: "Always on top", wide: true, cols: 2, items: [
        "FX 1-8", "Recorder", "Show Control", "Meters", "Main", "RTA", "Library", "Monitor",
        "Assign Set A-C", "Bus 1-8", "Bus 9-16", "Matrix/Main", "DCAs", "USER 1", "USER 2", "DCA Spill",
      ].map(function (t, i) { return lbool(t, "gui.top." + i); }) },
    ],
    midi: [
      { title: "Mackie Control", items: [
        bool("Enable", "/-prefs/remote/enable"),
        dis("Controlled fader bank", ["All (default)"]),
        dis("MIDI input", ["select..."]),
        dis("MIDI output", ["select..."]),
      ] },
      { title: "Remote", items: [
        sel("Protocolo", "/-prefs/remote/protocol", ["MC", "HUI", "CC"]),
        sel("Puerto", "/-prefs/remote/port", ["MIDI", "CARD", "RTP"]),
      ] },
      { title: "MIDI control interface", items: [bit("MIDI In/Out", 0), bit("Card MIDI", 1)] },
      { title: "MIDI receive", items: [
        bit("Program change", 3),
        bit("Fader pos CC", 5),
        bit("Ch mute CC", 7),
        dis("Ch pan CC"),
        dis("OSC over MIDI Sysex"),
      ] },
      { title: "MIDI transmit", items: [bit("Program change", 4), bit("Fader pos CC", 6), bit("Ch mute CC", 8), dis("Ch pan CC")] },
      { title: "X-TOUCH", items: [dis("X-TOUCH over MIDI"), dis("X-TOUCH over Ethernet")] },
    ],
    card: [
      { title: "Tarjeta", items: [
        sel("Interfaz", "/-prefs/card/UFifc", ["FW", "USB"]),
        sel("Modo USB", "/-prefs/card/USBmode", ["32/32", "16/16", "32/8", "8/32", "8/8", "2/2"]),
      ] },
    ],
  };

  function setupBox(key) {
    return document.querySelector('[data-setup-render="' + key + '"]');
  }

  function setupRow(item) {
    const row = document.createElement("label");
    row.className = "setup__row";
    const name = document.createElement("span");
    name.textContent = item.label;
    row.appendChild(name);
    let input;
    if (item.kind === "select") {
      input = document.createElement("select");
      (item.options || []).forEach(function (text, i) {
        const op = document.createElement("option");
        op.value = String(i);
        op.textContent = text;
        input.appendChild(op);
      });
    } else if (item.kind === "num") {
      input = document.createElement("input");
      input.type = "number";
      input.min = String(item.min);
      input.max = String(item.max);
      input.step = String(item.step);
    } else if (item.kind === "text") {
      input = document.createElement("input");
      input.type = "text";
    } else {
      input = document.createElement("input");
      input.type = "checkbox";
    }
    if (item.path) {
      input.dataset.setupOsc = item.path;
      input.dataset.setupType = item.type || "i";
    }
    if (item.local) input.dataset.setupLocal = item.local;
    if (item.bit !== undefined) input.dataset.setupBit = String(item.bit);
    input.disabled = !(item.path || item.local);
    row.appendChild(input);
    return row;
  }

  function renderGroups(box, groups) {
    groups.forEach(function (g) {
      const fs = document.createElement("fieldset");
      fs.className = "setup__card";
      const lg = document.createElement("legend");
      lg.textContent = g.title;
      fs.appendChild(lg);
      if (g.wide) fs.classList.add("setup__card--wide");
      const host = document.createElement("div");
      if (g.cols) host.className = "setup__cols setup__cols--" + g.cols;
      fs.appendChild(host);
      g.items.forEach(function (it) {
        if (it.kind === "action") {
          const b = document.createElement("button");
          b.type = "button";
          b.className = "setup__btn";
          b.textContent = it.label;
          if (it.run) b.addEventListener("click", it.run);
          else b.disabled = true;
          host.appendChild(b);
        } else {
          host.appendChild(setupRow(it));
        }
      });
      box.appendChild(fs);
    });
  }

  function preampStrip(n, idx) {
    const pad = String(n).padStart(2, "0");
    const strip = document.createElement("div");
    strip.className = "setup__strip";

    const lab48 = document.createElement("label");
    lab48.className = "setup__48v";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.dataset.setupOsc = "/headamp/" + idx + "/phantom";
    cb.dataset.setupType = "i";
    const txt48 = document.createElement("span");
    txt48.textContent = "48V";
    lab48.appendChild(cb);
    lab48.appendChild(txt48);

    const labInv = document.createElement("label");
    labInv.className = "setup__48v";
    const cbInv = document.createElement("input");
    cbInv.type = "checkbox";
    cbInv.dataset.setupOsc = "/ch/" + pad + "/preamp/invert";
    cbInv.dataset.setupType = "i";
    const txtInv = document.createElement("span");
    txtInv.textContent = "Ø";
    labInv.appendChild(cbInv);
    labInv.appendChild(txtInv);

    const num = document.createElement("span");
    num.className = "setup__chnum";
    num.textContent = pad;

    strip.appendChild(lab48);
    strip.appendChild(labInv);
    strip.appendChild(num);
    return strip;
  }

  function renderPreamps(box) {
    const head = document.createElement("div");
    head.className = "setup__pre-head";

    const pickWrap = document.createElement("label");
    pickWrap.className = "setup__row";
    const pickName = document.createElement("span");
    pickName.textContent = "Preamp block";
    const pick = document.createElement("select");
    PREAMP_BLOCKS.forEach(function (b, i) {
      const op = document.createElement("option");
      op.value = String(i);
      op.textContent = b.label;
      pick.appendChild(op);
    });
    ["AES50 A 1-8", "AES50 B 1-8"].forEach(function (t) {
      const op = document.createElement("option");
      op.textContent = t;
      op.disabled = true;
      pick.appendChild(op);
    });
    pickWrap.appendChild(pickName);
    pickWrap.appendChild(pick);
    head.appendChild(pickWrap);

    const globals = document.createElement("fieldset");
    globals.className = "setup__card";
    const gl = document.createElement("legend");
    gl.textContent = "Global options";
    globals.appendChild(gl);
    ["Lock Stagebox", "HA Gain Split", "HA Remote AES50 Port A", "HA Remote AES50 Port B"].forEach(function (t) {
      globals.appendChild(setupRow(dis(t)));
    });
    head.appendChild(globals);
    box.appendChild(head);

    const blocks = PREAMP_BLOCKS.map(function (b, i) {
      const wrap = document.createElement("div");
      wrap.className = "setup__strips";
      wrap.hidden = i !== 0;
      for (let k = 0; k < 8; k++) {
        const n = b.base + k + 1;
        wrap.appendChild(preampStrip(n, String(n - 1).padStart(3, "0")));
      }
      box.appendChild(wrap);
      return wrap;
    });
    pick.addEventListener("change", function () {
      blocks.forEach(function (w, i) {
        w.hidden = i !== Number(pick.value);
      });
    });
  }

  function renderCard(box) {
    const empty = document.createElement("p");
    empty.className = "setup__hint";
    empty.textContent = "No Card installed!";
    const form = document.createElement("div");
    form.hidden = true;
    renderGroups(form, SETUP_SPEC.card);
    box.appendChild(empty);
    box.appendChild(form);
    CueDesk.OSC.on("/-stat/xcardtype", function (v) {
      const has = Number(v) !== 0;
      empty.hidden = has;
      form.hidden = !has;
    });
  }

  function renderSetup() {
    ["connection", "mixer", "gui", "midi"].forEach(function (key) {
      const box = setupBox(key);
      if (box) renderGroups(box, SETUP_SPEC[key]);
    });
    const pre = setupBox("preamps");
    if (pre) renderPreamps(pre);
    const card = setupBox("card");
    if (card) renderCard(card);
  }

  function setupText(el) {
    return el.type === "checkbox" ? (el.checked ? "1" : "0") : el.value;
  }

  function setupRevert(el) {
    if (el.type === "checkbox") el.checked = el.dataset.last === "1";
    else el.value = el.dataset.last;
  }

  function setupApply(el, v) {
    if (el.type === "checkbox") el.checked = Number(v) === 1;
    else if (el.tagName === "SELECT") el.value = String(Math.round(Number(v)));
    else el.value = String(v);
    el.dataset.last = setupText(el);
  }

  function loadLocal() {
    try {
      return JSON.parse(localStorage.getItem(SETUP_LOCAL_KEY) || "{}") || {};
    } catch (_) {
      return {};
    }
  }

  function saveLocal(key, value) {
    const m = loadLocal();
    m[key] = value;
    try {
      localStorage.setItem(SETUP_LOCAL_KEY, JSON.stringify(m));
    } catch (_) {}
  }

  function bindLocal(el) {
    const key = el.dataset.setupLocal;
    const saved = loadLocal()[key];
    if (saved !== undefined) setupApply(el, saved);
    el.addEventListener("change", function () {
      saveLocal(key, el.type === "checkbox" ? (el.checked ? 1 : 0) : parseInt(el.value, 10));
    });
  }

  function refreshBits() {
    setupBitInputs.forEach(function (el) {
      el.checked = ((setupIoMask >> Number(el.dataset.setupBit)) & 1) === 1;
    });
  }

  function bindBit(el) {
    setupBitInputs.push(el);
    el.addEventListener("change", function () {
      const n = Number(el.dataset.setupBit);
      const next = el.checked ? setupIoMask | (1 << n) : setupIoMask & ~(1 << n);
      if (!window.confirm(SETUP_CONFIRM_MSG)) {
        el.checked = !el.checked;
        return;
      }
      setupIoMask = next;
      refreshBits();
      CueDesk.OSC.send(SETUP_IOENABLE, next, "i", { commit: true });
    });
  }

  function bindOsc(el) {
    const path = el.dataset.setupOsc;
    const type = el.dataset.setupType || "i";
    el.dataset.last = setupText(el);
    CueDesk.OSC.on(path, function (v) {
      setupApply(el, v);
    });
    el.addEventListener("change", function () {
      let value;
      if (el.type === "checkbox") value = el.checked ? 1 : 0;
      else if (el.tagName === "SELECT") value = parseInt(el.value, 10);
      else value = parseFloat(el.value);
      if (!isFinite(value)) return setupRevert(el);
      if (el.min !== "" && el.min !== undefined && value < parseFloat(el.min)) return setupRevert(el);
      if (el.max !== "" && el.max !== undefined && value > parseFloat(el.max)) return setupRevert(el);
      if (SETUP_CONFIRM.test(path) && !window.confirm(SETUP_CONFIRM_MSG)) return setupRevert(el);
      el.dataset.last = setupText(el);
      CueDesk.OSC.send(path, value, type, { commit: true });
    });
  }

  function bindSetupInput(el) {
    if (el.disabled) return;
    if (el.dataset.setupLocal) bindLocal(el);
    else if (el.dataset.setupBit !== undefined) bindBit(el);
    else if (el.dataset.setupOsc) bindOsc(el);
  }

  const CONSOLE_IP_DEFAULT = "192.168.1.10";
  let consoleStatus = null;

  function setConsoleStatus(text) {
    if (consoleStatus) consoleStatus.textContent = text;
  }

  function detectConsole() {
    const input = document.querySelector("[data-setup-console-ip]");
    const ip = input && input.value.trim() ? input.value.trim() : CONSOLE_IP_DEFAULT;
    saveLocal("conn.consoleIp", ip);
    setConsoleStatus("Buscando consola en " + ip + " …");
    return fetch("/api/console?ip=" + encodeURIComponent(ip))
      .then(function (res) {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.json();
      })
      .then(function (r) {
        if (r.found) {
          const parts = [r.model, r.name, r.version].filter(function (x) {
            return x;
          });
          setConsoleStatus(
            "Consola encontrada en " + r.ip + (parts.length ? ": " + parts.join(" · ") : "")
          );
        } else {
          setConsoleStatus("No responde en " + r.ip + " (" + (r.reason || "sin respuesta") + ")");
        }
      })
      .catch(function () {
        setConsoleStatus("Detección no disponible en este servidor");
      });
  }

  function renderConsoleProbe(box) {
    const fs = document.createElement("fieldset");
    fs.className = "setup__card";
    const lg = document.createElement("legend");
    lg.textContent = "Consola X32";
    fs.appendChild(lg);

    const row = document.createElement("label");
    row.className = "setup__row";
    const name = document.createElement("span");
    name.textContent = "IP";
    const ipInput = document.createElement("input");
    ipInput.type = "text";
    ipInput.setAttribute("data-setup-console-ip", "");
    ipInput.value = loadLocal()["conn.consoleIp"] || CONSOLE_IP_DEFAULT;
    ipInput.addEventListener("change", detectConsole);
    row.appendChild(name);
    row.appendChild(ipInput);
    fs.appendChild(row);

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "setup__btn";
    btn.textContent = "Detectar";
    btn.addEventListener("click", detectConsole);
    fs.appendChild(btn);

    consoleStatus = document.createElement("p");
    consoleStatus.className = "setup__hint";
    fs.appendChild(consoleStatus);

    box.insertBefore(fs, box.firstChild);
    detectConsole();
  }

  function initSetupControls() {
    renderSetup();
    const conn = setupBox("connection");
    if (conn) renderConsoleProbe(conn);
    CueDesk.OSC.on(SETUP_IOENABLE, function (v) {
      setupIoMask = Math.trunc(Number(v)) || 0;
      refreshBits();
    });
    document
      .querySelectorAll("[data-setup-render] input, [data-setup-render] select")
      .forEach(bindSetupInput);
  }

  /* ------------------------------------------------------------ Routing */

  /* Listas de fuentes de los headers de Maillot (X32.c). El valor de cada
     celda es el índice del enum; la columna i corresponde al valor i. */
  const XR_IN = [
    "AN1-8", "AN9-16", "AN17-24", "AN25-32",
    "A1-8", "A9-16", "A17-24", "A25-32", "A33-40", "A41-48",
    "B1-8", "B9-16", "B17-24", "B25-32", "B33-40", "B41-48",
    "CARD1-8", "CARD9-16", "CARD17-24", "CARD25-32",
  ];
  const XR_AEA = XR_IN.concat([
    "OUT1-8", "OUT9-16", "P161-8", "P169-16", "AUX1-6/Mon", "AuxIN1-6/TB",
  ]);
  const XR_OUT1 = [
    "AN1-4", "AN9-12", "AN17-20", "AN25-28",
    "A1-4", "A9-12", "A17-20", "A25-28", "A33-36", "A41-44",
    "B1-4", "B9-12", "B17-20", "B25-28", "B33-36", "B41-44",
    "CARD1-4", "CARD9-12", "CARD17-20", "CARD25-28",
    "OUT1-4", "OUT9-12", "P161-4", "P169-12", "AUX/CR", "AUX/TB",
  ];
  const XR_OUT5 = [
    "AN5-8", "AN13-16", "AN21-24", "AN29-32",
    "A5-8", "A13-16", "A21-24", "A29-32", "A37-40", "A45-48",
    "B5-8", "B13-16", "B21-24", "B29-32", "B37-40", "B45-48",
    "CARD5-8", "CARD13-16", "CARD21-24", "CARD29-32",
    "OUT5-8", "OUT13-16", "P165-8", "P1613-16", "AUX/CR", "AUX/TB",
  ];
  const XR_INA = [
    "AUX1-4", "AN1-2", "AN1-4", "AN1-6", "A1-2", "A1-4", "A1-6",
    "B1-2", "B1-4", "B1-6", "CARD1-2", "CARD1-4", "CARD1-6",
  ];

  const ROUTE_GROUPS = [
    { prefix: "AuxIN", group: "Auxin" },
    { prefix: "AUX", group: "Aux" },
    { prefix: "CARD", group: "Card" },
    { prefix: "OUT", group: "Out" },
    { prefix: "P16", group: "Ultranet" },
    { prefix: "AN", group: "Local" },
    { prefix: "A", group: "AES50-A" },
    { prefix: "B", group: "AES50-B" },
  ];

  function routeColumns(list) {
    return list.map(function (text, value) {
      let group = "";
      let label = text;
      for (const g of ROUTE_GROUPS) {
        if (text.startsWith(g.prefix)) {
          group = g.group;
          label = text.slice(g.prefix.length);
          break;
        }
      }
      return { value: value, group: group, label: label || text };
    });
  }

  function aesRows(bank) {
    return ["1-8", "9-16", "17-24", "25-32", "33-40", "41-48"].map(function (r) {
      return { label: "AES50-" + bank + " " + r, path: "/config/routing/AES50" + bank + "/" + r, list: XR_AEA };
    });
  }

  const ROUTE_ROWS = {
    inputs: ["1-8", "9-16", "17-24", "25-32"].map(function (r) {
      return { label: "Channel " + r, path: "/config/routing/IN/" + r, list: XR_IN };
    }),
    aes50: aesRows("A").concat(aesRows("B")),
    card: ["1-8", "9-16", "17-24", "25-32"].map(function (r) {
      return { label: "Outputs " + r, path: "/config/routing/CARD/" + r, list: XR_AEA };
    }),
    xlr: [
      { label: "Outputs 1-4", path: "/config/routing/OUT/1-4", list: XR_OUT1 },
      { label: "Outputs 5-8", path: "/config/routing/OUT/5-8", list: XR_OUT5 },
      { label: "Outputs 9-12", path: "/config/routing/OUT/9-12", list: XR_OUT1 },
      { label: "Outputs 13-16", path: "/config/routing/OUT/13-16", list: XR_OUT5 },
    ],
  };

  const ROUTE_COLUMNS = {
    inputs: routeColumns(XR_IN).concat(
      ["1-8", "9-16", "17-24", "25-32"].map(function (l, k) {
        return { value: 20 + k, group: "User In", label: l, unverified: true };
      })
    ),
    aes50: routeColumns(XR_AEA),
    card: routeColumns(XR_AEA),
    xlr: routeColumns(XR_OUT1),
  };

  function routeMark(row) {
    row.cells.forEach(function (b) {
      b.classList.toggle("is-on", Number(b.dataset.value) === row.value);
    });
  }

  function renderRouteGrid(box, key) {
    const rows = ROUTE_ROWS[key];
    const cols = ROUTE_COLUMNS[key];
    const wrap = document.createElement("div");
    wrap.className = "route-scroll";
    const table = document.createElement("table");
    table.className = "route-table";

    const head1 = document.createElement("tr");
    const corner = document.createElement("th");
    corner.textContent = "Source / Output";
    head1.appendChild(corner);
    let i = 0;
    while (i < cols.length) {
      let j = i;
      while (j + 1 < cols.length && cols[j + 1].group === cols[i].group) j++;
      const th = document.createElement("th");
      th.colSpan = j - i + 1;
      th.textContent = cols[i].group;
      head1.appendChild(th);
      i = j + 1;
    }
    table.appendChild(head1);

    const head2 = document.createElement("tr");
    head2.appendChild(document.createElement("th"));
    cols.forEach(function (c) {
      const th = document.createElement("th");
      th.textContent = c.label;
      head2.appendChild(th);
    });
    table.appendChild(head2);

    rows.forEach(function (row) {
      const tr = document.createElement("tr");
      const th = document.createElement("th");
      th.textContent = row.label;
      tr.appendChild(th);
      row.cells = [];
      row.value = null;
      cols.forEach(function (c) {
        const td = document.createElement("td");
        const b = document.createElement("button");
        b.type = "button";
        b.className = "route-cell";
        b.dataset.value = c.value === null ? "" : String(c.value);
        b.title = row.label + " ← " + c.group + " " + c.label + (c.unverified ? " (valor por verificar)" : "");
        b.addEventListener("click", function () {
          row.value = c.value;
          routeMark(row);
          CueDesk.OSC.send(row.path, c.value, "i", { commit: true });
        });
        td.appendChild(b);
        tr.appendChild(td);
        row.cells.push(b);
      });
      table.appendChild(tr);
      CueDesk.OSC.on(row.path, function (v) {
        const n = parseInt(v, 10);
        if (!isFinite(n)) return;
        row.value = n;
        routeMark(row);
      });
    });

    wrap.appendChild(table);
    box.appendChild(wrap);
  }

  function routeSelect(box, label, path, options) {
    const row = document.createElement("label");
    row.className = "setup__row";
    const name = document.createElement("span");
    name.textContent = label;
    const sel = document.createElement("select");
    options.forEach(function (opt, i) {
      const o = typeof opt === "string" ? { text: opt } : opt;
      const op = document.createElement("option");
      op.value = String(i);
      op.textContent = o.text;
      op.disabled = !!o.disabled;
      sel.appendChild(op);
    });
    sel.addEventListener("change", function () {
      CueDesk.OSC.send(path, parseInt(sel.value, 10), "i", { commit: true });
    });
    CueDesk.OSC.on(path, function (v) {
      const n = parseInt(v, 10);
      if (isFinite(n)) sel.value = String(n);
    });
    row.appendChild(name);
    row.appendChild(sel);
    box.appendChild(row);
  }

  /* ----------------------------------------------------------- Out 1-16 */

  /* Fuentes de /outputs/main/NN/src (confirmado con scene.scn).
     Una sola tabla continua; la columna de destinos no se desplaza. */
  const OUT_COLS = [
    { value: 0, group: "", label: "Off" },
    { value: 1, group: "Main", label: "L" },
    { value: 2, group: "Main", label: "R" },
    { value: 3, group: "Main", label: "MC", unverified: true },
  ];
  for (let i = 1; i <= 16; i++) {
    OUT_COLS.push({ value: 3 + i, group: "Mix Bus", label: String(i).padStart(2, "0") });
  }
  for (let i = 1; i <= 6; i++) {
    OUT_COLS.push({ value: 19 + i, group: "Matrix", label: String(i), unverified: true });
  }
  for (let i = 1; i <= 32; i++) {
    OUT_COLS.push({ value: 25 + i, group: "Dir Ch", label: String(i).padStart(2, "0"), verifiedFrom: i <= 16 ? "p16" : undefined, unverified: i > 16 });
  }
  for (let i = 1; i <= 8; i++) {
    OUT_COLS.push({ value: 57 + i, group: "Dir Aux", label: String(i).padStart(2, "0"), verifiedFrom: i <= 2 ? "main" : undefined, unverified: i > 2 });
  }
  for (let i = 1; i <= 4; i++) {
    const base = 65 + 2 * (i - 1);
    OUT_COLS.push({ value: base, group: "Dir FX", label: i + "L", verifiedFrom: i === 1 ? "main" : undefined, unverified: i > 1 });
    OUT_COLS.push({ value: base + 1, group: "Dir FX", label: i + "R", verifiedFrom: i === 1 ? "main" : undefined, unverified: i > 1 });
  }
  OUT_COLS.push({ value: 74, group: "Monitor", label: "L", verifiedFrom: "main" });
  OUT_COLS.push({ value: 75, group: "Monitor", label: "R", verifiedFrom: "main" });
  OUT_COLS.push({ value: 76, group: "Monitor", label: "TB", unverified: true });

  /* Enum Xotpos (/outputs/main/NN/pos) */
  const OUT_TAPS = [
    "Input/LC", "Input/LC + Mute", "Pre EQ", "Pre EQ + Mute", "Post EQ",
    "Post EQ + Mute", "Pre Fader", "Pre Fader + Mute", "Post Fader",
  ];
  const OUT_TAP_KEY = "cuedesk.out.defaultTap";

  function outDefaultTap() {
    const v = parseInt(localStorage.getItem(OUT_TAP_KEY), 10);
    return isFinite(v) && v >= 0 && v < OUT_TAPS.length ? v : 8;
  }

  /* Leyenda de la matriz: los mismos colores que las píldoras (anillo = tap
     normal, relleno = variante + Mute del enum Xotpos) */
  const OUT_LEGEND = [
    { label: "Input/LC", tap: 0, mute: 1 },
    { label: "Pre EQ", tap: 2, mute: 3 },
    { label: "Post EQ", tap: 4, mute: 5 },
    { label: "Pre Fader", tap: 6, mute: 7 },
    { label: "Post Fader", tap: 8 },
  ];

  function outLegend() {
    const box = document.createElement("span");
    box.className = "out-legend";
    box.title = "Anillo = tap normal · relleno = tap + Mute";
    OUT_LEGEND.forEach(function (item) {
      const el = document.createElement("span");
      el.className = "out-legend__item";
      const dots = document.createElement("span");
      dots.className = "out-legend__dots";
      const plain = document.createElement("i");
      plain.className = "out-legend__dot tap-" + item.tap;
      plain.title = item.label;
      dots.appendChild(plain);
      if (item.mute !== undefined) {
        const muted = document.createElement("i");
        muted.className = "out-legend__dot out-legend__dot--on tap-" + item.mute;
        muted.title = item.label + " + Mute";
        dots.appendChild(muted);
      }
      el.appendChild(dots);
      const text = document.createElement("span");
      text.textContent = item.label;
      el.appendChild(text);
      box.appendChild(el);
    });
    const note = document.createElement("span");
    note.className = "out-legend__note";
    note.textContent = "relleno = +Mute";
    box.appendChild(note);
    return box;
  }

  function markOut(row) {
    row.cells.forEach(function (b) {
      const on = Number(b.dataset.value) === row.src;
      b.className = "route-cell" + (on ? " is-on tap-" + row.tap : "");
    });
    if (row.pol) row.pol.className = "route-cell route-cell--pol" + (row.inv ? " is-on" : "");
  }

  function openTapMenu(x, y, row) {
    const old = document.querySelector(".tap-menu");
    if (old) old.remove();
    const menu = document.createElement("div");
    menu.className = "tap-menu";
    menu.style.left = x + "px";
    menu.style.top = y + "px";
    OUT_TAPS.forEach(function (text, t) {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = text;
      b.addEventListener("click", function () {
        row.tap = t;
        markOut(row);
        CueDesk.OSC.send(row.posPath, t, "i", { commit: true });
        menu.remove();
      });
      menu.appendChild(b);
    });
    document.body.appendChild(menu);
    setTimeout(function () {
      document.addEventListener("pointerdown", function close(e) {
        if (!menu.contains(e.target)) {
          menu.remove();
          document.removeEventListener("pointerdown", close);
        }
      });
    }, 0);
  }

  function outCell(row, c) {
    const td = document.createElement("td");
    const b = document.createElement("button");
    b.type = "button";
    b.className = "route-cell";
    b.dataset.value = String(c.value);
    const extra = [];
    if (c.verifiedFrom) extra.push("confirmado");
    if (c.unverified) extra.push("valor por verificar");
    b.title = "Output " + row.id + " ← " + (c.group ? c.group + " " : "") + c.label + (extra.length ? " (" + extra.join(", ") + ")" : "");
    b.addEventListener("click", function () {
      if (row.src === c.value) return;
      row.src = c.value;
      row.tap = outDefaultTap();
      markOut(row);
      CueDesk.OSC.send(row.srcPath, c.value, "i", { commit: true });
      CueDesk.OSC.send(row.posPath, row.tap, "i", { commit: true });
    });
    b.addEventListener("contextmenu", function (e) {
      e.preventDefault();
      if (row.src === c.value) openTapMenu(e.clientX, e.clientY, row);
    });
    let timer = null;
    b.addEventListener("pointerdown", function (e) {
      if (row.src !== c.value) return;
      timer = setTimeout(function () {
        timer = null;
        openTapMenu(e.clientX, e.clientY, row);
      }, 500);
    });
    const clear = function () {
      clearTimeout(timer);
      timer = null;
    };
    b.addEventListener("pointerup", clear);
    b.addEventListener("pointerleave", clear);
    td.appendChild(b);
    row.cells.push(b);
    return td;
  }

  /* Ajuste de alto: en PC el panel se comprime hasta caber sin scroll
     vertical; en pantallas táctiles se conserva un objetivo cómodo. */
  let outFit = null;
  let fitPending = false;

  function queueOutFit() {
    if (fitPending) return;
    fitPending = true;
    window.requestAnimationFrame(function () {
      fitPending = false;
      fitOutGrid();
    });
  }

  function fitOutGrid() {
    if (!outFit || !outFit.pane || outFit.pane.hidden) return;
    const grid = outFit.grid;
    if (!grid || !grid.isConnected) return;
    const body = document.querySelector(".routing__body");
    if (!body) return;
    const cs = getComputedStyle(body);
    const avail = body.clientHeight -
      (parseFloat(cs.paddingTop) || 0) - (parseFloat(cs.paddingBottom) || 0);
    if (avail < 80) return;

    const frows = grid.querySelectorAll(".out-fixed tr");
    const srows = grid.querySelectorAll(".route-scroll--out tr");
    if (frows.length < 3 || srows.length < 3) return;

    const headH = frows[0].getBoundingClientRect().height + frows[1].getBoundingClientRect().height;
    const dataRows = srows.length - 2;
    const cur = srows[2].getBoundingClientRect().height || 38;
    /* Todo lo que no depende del alto de fila: bordes, barra horizontal y pie */
    const fixedPart = outFit.pane.scrollHeight - headH - dataRows * cur;
    const estR = Math.floor((avail - headH - fixedPart) / dataRows);

    const coarse = !!(window.matchMedia && window.matchMedia("(pointer: coarse)").matches);
    const minR = coarse ? 32 : 20;
    const cap = window.matchMedia && window.matchMedia("(max-width: 1280px)").matches ? 36 : 38;

    let r = Math.max(minR, Math.min(cap, estR));
    grid.style.setProperty("--out-row-h", r + "px");

    /* Ajuste fino medido: la estimación no ve márgenes ni la barra del cuerpo,
       así que se corrige con lo que realmente desborda. */
    for (let guard = 0; guard < 4 && r > minR; guard++) {
      const over = body.scrollHeight - body.clientHeight;
      if (over <= 0) break;
      r = Math.max(minR, r - Math.max(1, Math.ceil(over / dataRows)));
      grid.style.setProperty("--out-row-h", r + "px");
    }
  }

  function renderOutGrid(box) {
    const rows = [];
    for (let n = 1; n <= 16; n++) {
      const id = String(n).padStart(2, "0");
      rows.push({
        id: id,
        src: null,
        tap: outDefaultTap(),
        inv: 0,
        cells: [],
        pol: null,
        srcPath: "/outputs/main/" + id + "/src",
        posPath: "/outputs/main/" + id + "/pos",
        invPath: "/outputs/main/" + id + "/invert",
      });
    }

    rows.forEach(function (row) {
      CueDesk.OSC.on(row.srcPath, function (v) {
        const k = parseInt(v, 10);
        if (!isFinite(k)) return;
        row.src = k;
        markOut(row);
      });
      CueDesk.OSC.on(row.posPath, function (v) {
        const t = parseInt(v, 10);
        if (!isFinite(t)) return;
        row.tap = t;
        markOut(row);
      });
      CueDesk.OSC.on(row.invPath, function (v) {
        row.inv = parseInt(v, 10) === 1 ? 1 : 0;
        markOut(row);
      });
    });

    /* --- Columna fija: destino + Phase. Vive fuera del área que se desplaza,
       así nunca se pierde al hacer scroll horizontal. --- */
    const fixed = document.createElement("div");
    fixed.className = "out-fixed";
    const ftable = document.createElement("table");
    ftable.className = "route-table";

    const fhead1 = document.createElement("tr");
    const fcorner = document.createElement("th");
    fcorner.className = "route-rowhead";
    fcorner.textContent = "Output";
    fhead1.appendChild(fcorner);
    const fphase = document.createElement("th");
    fphase.textContent = "Phase";
    fhead1.appendChild(fphase);
    ftable.appendChild(fhead1);

    const fhead2 = document.createElement("tr");
    const fhead2a = document.createElement("th");
    fhead2a.className = "route-rowhead";
    /* Espacio duro: sin contenido la fila mediría 9 px en vez de 25,8 y las
       dos tablas dejarían de alinearse. */
    fhead2a.textContent = "\u00A0";
    const fhead2b = document.createElement("th");
    fhead2b.textContent = "\u00A0";
    fhead2.appendChild(fhead2a);
    fhead2.appendChild(fhead2b);
    ftable.appendChild(fhead2);

    /* --- Matriz de fuentes: aquí sí se desplaza en horizontal --- */
    const wrap = document.createElement("div");
    wrap.className = "route-scroll route-scroll--out";
    const table = document.createElement("table");
    table.className = "route-table";

    const head1 = document.createElement("tr");
    let i = 0;
    while (i < OUT_COLS.length) {
      let j = i;
      while (j + 1 < OUT_COLS.length && OUT_COLS[j + 1].group === OUT_COLS[i].group) j++;
      const th = document.createElement("th");
      th.colSpan = j - i + 1;
      th.textContent = OUT_COLS[i].group;
      head1.appendChild(th);
      i = j + 1;
    }
    table.appendChild(head1);

    const head2 = document.createElement("tr");
    OUT_COLS.forEach(function (c) {
      const th = document.createElement("th");
      th.textContent = c.label;
      head2.appendChild(th);
    });
    table.appendChild(head2);

    rows.forEach(function (row) {
      const ftr = document.createElement("tr");
      const fth = document.createElement("th");
      fth.className = "route-rowhead route-rowhead--body";
      fth.textContent = "Out " + row.id;
      ftr.appendChild(fth);

      const tdPol = document.createElement("td");
      const pol = document.createElement("button");
      pol.type = "button";
      pol.className = "route-cell route-cell--pol";
      pol.title = "Polaridad — " + row.invPath;
      pol.addEventListener("click", function () {
        row.inv = row.inv ? 0 : 1;
        markOut(row);
        CueDesk.OSC.send(row.invPath, row.inv, "i", { commit: true });
      });
      tdPol.appendChild(pol);
      ftr.appendChild(tdPol);
      row.pol = pol;
      ftable.appendChild(ftr);

      const tr = document.createElement("tr");
      OUT_COLS.forEach(function (c) {
        tr.appendChild(outCell(row, c));
      });
      table.appendChild(tr);
    });

    fixed.appendChild(ftable);
    wrap.appendChild(table);

    const grid = document.createElement("div");
    grid.className = "out-grid";
    grid.appendChild(fixed);
    grid.appendChild(wrap);
    box.appendChild(grid);

    const bottom = document.createElement("div");
    bottom.className = "setup__row routing__extra";
    bottom.appendChild(outLegend());

    /* Selector y rótulo: el texto queda a la derecha del desplegable */
    const side = document.createElement("span");
    side.className = "out-foot__side";
    const sel = document.createElement("select");
    sel.setAttribute("aria-label", "Default Signal Tap");
    OUT_TAPS.forEach(function (text, t) {
      const op = document.createElement("option");
      op.value = String(t);
      op.textContent = text;
      sel.appendChild(op);
    });
    sel.value = String(outDefaultTap());
    sel.addEventListener("change", function () {
      try {
        localStorage.setItem(OUT_TAP_KEY, sel.value);
      } catch (_) {}
    });
    const name = document.createElement("span");
    name.className = "out-foot__name";
    name.textContent = "Default Signal Tap";
    side.appendChild(sel);
    side.appendChild(name);
    bottom.appendChild(side);
    box.appendChild(bottom);

    outFit = { grid: grid, pane: box.parentElement, box: box };
    fitOutGrid();
  }

  function initRouting() {
    Object.keys(ROUTE_ROWS).forEach(function (key) {
      const box = document.querySelector('[data-routing-render="' + key + '"]');
      if (box) renderRouteGrid(box, key);
    });
    const outBox = document.querySelector('[data-routing-render="out"]');
    if (outBox) renderOutGrid(outBox);
    window.addEventListener("resize", queueOutFit);
    const extra = document.querySelector('[data-routing-extra="inputs"]');
    if (extra) {
      const remap = [
        "Aux Ins", "Local 1-2", "Local 1-4", "Local 1-6",
        "AES50 A1-2", "AES50 A1-4", "AES50 A1-6",
        "AES50 B1-2", "AES50 B1-4", "AES50 B1-6",
        "Card 1-2", "Card 1-4", "Card 1-6",
        "User In 1-2",
        "User In 1-4",
        "User In 1-6",
      ];
      routeSelect(extra, "Aux In Remap", "/config/routing/IN/AUX", remap);
      routeSelect(extra, "Record / Play", "/config/routing/routswitch", ["Record", "Play"]);
      routeSelect(extra, "Play remap", "/config/routing/PLAY/AUX", remap);
    }
    const tabs = Array.prototype.slice.call(document.querySelectorAll("[data-routing-tab]"));
    tabs.forEach(function (tab) {
      tab.addEventListener("click", function () {
        const key = tab.dataset.routingTab;
        tabs.forEach(function (t) {
          const active = t === tab;
          t.classList.toggle("is-active", active);
          t.setAttribute("aria-selected", active ? "true" : "false");
        });
        document.querySelectorAll("[data-routing-pane]").forEach(function (pane) {
          pane.hidden = pane.dataset.routingPane !== key;
        });
        if (key === "out") fitOutGrid();
      });
    });
  }

  function initTabs() {
    const tabs = Array.prototype.slice.call(document.querySelectorAll(".tab[data-view]"));

    function select(tab) {
      tabs.forEach(function (t) {
        const active = t === tab;
        t.classList.toggle("is-active", active);
        t.setAttribute("aria-selected", active ? "true" : "false");
      });
      const view = tab.dataset.view;
      CueDesk.app.view = view;
      document.querySelector(".app").classList.toggle("is-setup", view === "setup");
      document.querySelectorAll("[data-view-panel]").forEach(function (panel) {
        panel.hidden = panel.dataset.viewPanel !== view;
      });
      fitOutGrid();
    }

    tabs.forEach(function (tab) {
      tab.addEventListener("click", function () {
        select(tab);
      });
    });

    // Vista inicial por URL: ?view=mixer | setup | routing | meter | scenes
    // (usada por el lanzador local CueDesk_Mixer.bat); nunca selecciona una
    // solapa deshabilitada
    const forced = new URLSearchParams(window.location.search).get("view");
    if (forced) {
      const target = tabs.find(function (t) {
        return t.dataset.view === forced;
      });
      if (target && !target.disabled) select(target);
    }
  }

  /* ----------------------------------------------------- LOCAL PREVIEW */

  function initLocalPreview() {
    const btn = document.querySelector('[data-action="local-preview"]');
    if (!btn) return;
    const led = btn.querySelector(".led");
    let on = false;

    btn.addEventListener("click", function () {
      on = !on;
      btn.classList.toggle("is-active", on);
      btn.setAttribute("aria-pressed", on ? "true" : "false");
      led.className = "led " + (on ? "led--amber" : "led--off");
      toast(on ? "Local preview ON — monitor en este equipo" : "Local preview OFF");
    });
  }

  /* --------------------------------------------------------- TALKBACK */

  function initTalkback() {
    const group = document.querySelector(".gb-talk");
    if (!group) return;

    const segmented = group.querySelector(".segmented");
    const buttons = group.querySelectorAll('[data-action="tb"]');
    const sliderEl = group.querySelector('[data-role="talk-level"]');

    const slider = Controls.mount(sliderEl, {
      path: "/config/talk/A/level",
      type: "f",
      value: dB.toFader(0), // 0 dB → lectura "-00"
      display: Controls.displayTalk,
      readout: group.querySelector('[data-role="talk-readout"]'),
      reset: dB.toFader(0),
      throttle: 50,
    });

    let dest = "OFF";

    function apply() {
      const live = dest !== "OFF";
      buttons.forEach(function (b) {
        const active = b.dataset.dest === dest;
        b.classList.toggle("is-active", active);
        b.setAttribute("aria-pressed", active ? "true" : "false");
      });
      segmented.classList.toggle("is-live", live);
      group.classList.toggle("is-live", live);
      if (live) slider.setPath("/config/talk/" + dest + "/level");
    }

    buttons.forEach(function (b) {
      b.addEventListener("click", function () {
        dest = b.dataset.dest;
        apply();
        const live = dest !== "OFF";
        // /config/talk/enable {OFF, ON}
        OSC.send("/config/talk/enable", live ? 1 : 0, "i", { commit: true });
        toast(live ? "Talkback " + dest + " activo" : "Talkback OFF");
      });
    });

    // Consola → UI
    OSC.on("/config/talk/enable", function (v) {
      if (!isOn(v)) {
        dest = "OFF";
        apply();
      }
    });

    apply();
  }

  /* ------------------------------------------------------- GAIN GUARD */

  /* Pantalla emergente sobre el escenario: mismo esqueleto que Setup › Preamps
     (bloques de 8 canales) pero sin "Global options". En la cabecera, junto al
     selector de bloque, va el conmutador de Monitor Guard (encendido o no). Por
     canal: conmutador deslizante RMS/LUFS en el sitio del 48V y desplegable de
     umbral —con "Off" en ambas escalas— en el del Ø. Son preferencias locales
     (localStorage); su envío a consola está pendiente de definir. */
  const GG_KEY = "cuedesk.gainguard";
  const GG_MODES = [
    { id: "rms", label: "RMS", options: ["Off", "±3 dB", "±5 dB"] },
    { id: "lufs", label: "LUFS", options: ["Off", "-18 LUFS", "-23 LUFS"] },
  ];

  function ggMode(id) {
    return GG_MODES[id === "lufs" ? 1 : 0];
  }

  /* Estado local: { mon, ch: [{ mode, opt } × 32] }. Las versiones previas
     guardaban sólo el array de canales y sus escalas no llevaban "Off": al
     cargar ese formato el umbral guardado se desplaza una posición. */
  function ggLoad() {
    let raw = null;
    try {
      raw = JSON.parse(localStorage.getItem(GG_KEY) || "null");
    } catch (_) {
      raw = null;
    }
    const legacy = Array.isArray(raw);
    const chans = legacy ? raw : raw && Array.isArray(raw.ch) ? raw.ch : [];
    return {
      mon: !!(raw && raw.mon),
      ch: Array.from({ length: 32 }, function (_, i) {
        const c = chans[i] ? chans[i] : null;
        const mode = c && c.mode === "lufs" ? "lufs" : "rms";
        const max = ggMode(mode).options.length - 1;
        let opt = c && Number.isInteger(c.opt) && c.opt >= 0 && c.opt <= max ? c.opt : 0;
        if (legacy && c && Number.isInteger(c.opt)) opt = Math.min(opt + 1, max);
        return { mode: mode, opt: opt };
      }),
    };
  }

  function ggSave(state) {
    try {
      localStorage.setItem(GG_KEY, JSON.stringify(state));
    } catch (_) {}
  }

  function ggStrip(ch, index, save) {
    const pad = String(index + 1).padStart(2, "0");
    const strip = document.createElement("div");
    strip.className = "setup__strip";

    /* Conmutador deslizante RMS/LUFS (ocupa el sitio del 48V) */
    const sw = document.createElement("div");
    sw.className = "gg-switch";
    sw.setAttribute("role", "group");
    sw.setAttribute("aria-label", "Modo de medida · canal " + pad);

    const thumb = document.createElement("span");
    thumb.className = "gg-switch__thumb";
    thumb.setAttribute("aria-hidden", "true");
    sw.appendChild(thumb);

    const opts = GG_MODES.map(function (m) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "gg-switch__opt";
      b.dataset.ggMode = m.id;
      b.textContent = m.label;
      b.addEventListener("click", function () {
        if (ch.mode === m.id) return;
        ch.mode = m.id;
        ch.opt = 0; // el umbral de la otra escala no existe: vuelve a "Off"
        sync();
        save();
      });
      sw.appendChild(b);
      return b;
    });

    /* Umbral (ocupa el sitio del Ø): desplegable nativo, como los select de
       Setup. Sus opciones dependen del modo del conmutador y llevan "Off" en
       primer lugar. */
    const pick = document.createElement("select");
    pick.className = "gg-select";
    pick.setAttribute("aria-label", "Umbral · canal " + pad);
    pick.addEventListener("change", function () {
      ch.opt = Number(pick.value);
      save();
    });

    const num = document.createElement("span");
    num.className = "setup__chnum";
    num.textContent = pad;

    function sync() {
      sw.dataset.pos = ch.mode === "lufs" ? "1" : "0";
      opts.forEach(function (b) {
        const on = b.dataset.ggMode === ch.mode;
        b.classList.toggle("is-on", on);
        b.setAttribute("aria-pressed", on ? "true" : "false");
      });
      pick.textContent = "";
      ggMode(ch.mode).options.forEach(function (text, i) {
        const op = document.createElement("option");
        op.value = String(i);
        op.textContent = text;
        pick.appendChild(op);
      });
      pick.value = String(ch.opt);
    }

    sync();
    strip.appendChild(sw);
    strip.appendChild(pick);
    strip.appendChild(num);
    return strip;
  }

  function renderGainGuard() {
    const box = document.querySelector("[data-gg-blocks]");
    const pick = document.querySelector("[data-gg-block]");
    if (!box || !pick) return;

    const state = ggLoad();
    const save = function () {
      ggSave(state);
    };
    const blocks = [];

    /* Monitor Guard (cabecera): el mismo conmutador que los canales, pero uno
       solo para toda la pantalla. De momento es estado local, como el resto. */
    const monSw = document.querySelector("[data-gg-monitor]");
    const monOpts = monSw
      ? Array.prototype.slice.call(monSw.querySelectorAll("[data-gg-monitor-opt]"))
      : [];

    function syncMon() {
      monSw.dataset.pos = state.mon ? "1" : "0";
      monOpts.forEach(function (b) {
        const on = (b.dataset.ggMonitorOpt === "on") === state.mon;
        b.classList.toggle("is-on", on);
        b.setAttribute("aria-pressed", on ? "true" : "false");
      });
    }

    monOpts.forEach(function (b) {
      b.addEventListener("click", function () {
        const on = b.dataset.ggMonitorOpt === "on";
        if (state.mon === on) return;
        state.mon = on;
        syncMon();
        save();
      });
    });
    if (monSw) syncMon();

    PREAMP_BLOCKS.forEach(function (b, i) {
      const view = document.createElement("div");
      view.className = "setup__strips";
      view.hidden = i !== 0;
      for (let k = 0; k < 8; k++) {
        const index = b.base + k;
        view.appendChild(ggStrip(state.ch[index], index, save));
      }
      box.appendChild(view);
      blocks.push(view);

      const op = document.createElement("option");
      op.value = String(i);
      op.textContent = b.label;
      pick.appendChild(op);
    });

    pick.addEventListener("change", function () {
      blocks.forEach(function (v, i) {
        v.hidden = i !== Number(pick.value);
      });
    });
  }

  function initGainGuard() {
    const btn = document.querySelector('[data-action="gainguard"]');
    const panel = document.getElementById("gg-panel");
    if (!btn || !panel) return;

    renderGainGuard();

    function setOpen(open) {
      panel.hidden = !open;
      btn.classList.toggle("is-active", open);
      btn.setAttribute("aria-expanded", open ? "true" : "false");
    }

    btn.addEventListener("click", function () {
      setOpen(panel.hidden);
    });

    const closeBtn = panel.querySelector('[data-action="gg-close"]');
    if (closeBtn) {
      closeBtn.addEventListener("click", function () {
        setOpen(false);
        btn.focus();
      });
    }

    // Cambiar de vista principal cierra la pantalla: si no, quedaría todo
    // tapado por el panel y parecería que la pestaña no responde.
    document.querySelectorAll("[data-view]").forEach(function (t) {
      t.addEventListener("click", function () {
        if (!panel.hidden) setOpen(false);
      });
    });

    document.addEventListener("keydown", function (e) {
      if (e.key !== "Escape" || panel.hidden) return;
      setOpen(false);
      btn.focus();
    });
  }

  /* ------------------------------------------------------- CLEAR SOLO */

  function initClearSolo() {
    const btn = document.querySelector('[data-action="clear-solo"]');
    if (!btn) return;

    btn.addEventListener("click", function () {
      Mixer.clearSolo();
      toast("Solo limpiado");
    });

    document.addEventListener("cuedesk:solochange", refresh);
    refresh();

    function refresh() {
      btn.classList.toggle("is-warning", Mixer.hasSolo());
    }
  }

  /* ------------------------------------------------------ BANCOS/GAIN */

  function initBankRail() {
    const banks = document.querySelectorAll(".bank[data-bank]");
    banks.forEach(function (b) {
      b.addEventListener("click", function () {
        if (b.dataset.bank === Mixer.bank) return;
        banks.forEach(function (x) {
          x.classList.toggle("is-active", x === b);
        });
        Mixer.setBank(b.dataset.bank);
        refreshGain();
        toast("Banco · " + b.textContent.trim());
      });
    });

    const gainBtn = document.querySelector('[data-action="gain"]');
    if (gainBtn) {
      gainBtn.addEventListener("click", function () {
        const on = Mixer.setGainMode(!Mixer.isGainMode());
        gainBtn.classList.toggle("is-active", on);
        gainBtn.setAttribute("aria-pressed", on ? "true" : "false");
        gainBtn.setAttribute("data-state-value", on ? "1" : "0");
        toast(on ? "Gain view · headamp -12…+60 dB (trim en aux)" : "Mix view · faders de nivel");
      });
    }

    refreshGain();
  }

  function refreshGain() {
    const gainBtn = document.querySelector('[data-action="gain"]');
    if (!gainBtn) return;
    const supported = Mixer.supportsGain();
    gainBtn.disabled = !supported;
    if (!supported && Mixer.isGainMode()) Mixer.setGainMode(false);
    const on = Mixer.isGainMode();
    gainBtn.classList.toggle("is-active", on);
    gainBtn.setAttribute("aria-pressed", on ? "true" : "false");
  }

  /* ------------------------------------------------------------ sesión */

  function initSession() {
    const signOut = document.querySelector('[data-action="sign-out"]');
    if (signOut) {
      signOut.addEventListener("click", function () {
        toast("Sesión cerrada (demo · WebSocket no conectado)");
      });
    }
  }

  /* -------------------------------------------------------------- boot */

  function init() {
    Mixer.init(); // rack + master + vúmetros
    initLink();   // LED de enlace + panel WebSocket
    initTabs();
    initSetupTabs();
    initSetupControls();
    initRouting();
    initLocalPreview();
    initTalkback();
    initGainGuard();
    initClearSolo();
    initBankRail();
    initSession();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
