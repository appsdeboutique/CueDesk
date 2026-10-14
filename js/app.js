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

  /* ------------------------------------------- X / AUTOMIX / Y */

  function initAutomix() {
    const xBtn = document.querySelector('[data-action="amix"][data-group="X"]');
    const yBtn = document.querySelector('[data-action="amix"][data-group="Y"]');
    const masterBtn = document.querySelector('[data-action="amix-master"]');
    if (!xBtn || !yBtn || !masterBtn) return;

    // /config/amixenable/X · /config/amixenable/Y  {OFF, ON}
    const PATH_X = "/config/amixenable/X";
    const PATH_Y = "/config/amixenable/Y";
    const state = { X: false, Y: false };

    function apply() {
      setPressed(xBtn, state.X, state.X ? 1 : 0);
      setPressed(yBtn, state.Y, state.Y ? 1 : 0);
      const both = state.X && state.Y;
      masterBtn.classList.toggle("is-active", both);
      masterBtn.setAttribute("aria-pressed", both ? "true" : "false");
      masterBtn.setAttribute(
        "data-state-value",
        JSON.stringify({ X: state.X ? 1 : 0, Y: state.Y ? 1 : 0 })
      );
    }

    xBtn.addEventListener("click", function () {
      state.X = !state.X;
      OSC.send(PATH_X, state.X ? 1 : 0, "i", { commit: true });
      apply();
    });

    yBtn.addEventListener("click", function () {
      state.Y = !state.Y;
      OSC.send(PATH_Y, state.Y ? 1 : 0, "i", { commit: true });
      apply();
    });

    // Botón central: master de automix (conmuta los dos grupos)
    masterBtn.addEventListener("click", function () {
      const next = !(state.X && state.Y);
      state.X = state.Y = next;
      OSC.send(PATH_X, next ? 1 : 0, "i", { commit: true });
      OSC.send(PATH_Y, next ? 1 : 0, "i", { commit: true });
      apply();
      toast("Automix " + (next ? "ON (grupos X + Y)" : "OFF"));
    });

    OSC.on(PATH_X, function (v) {
      state.X = isOn(v);
      apply();
    });
    OSC.on(PATH_Y, function (v) {
      state.Y = isOn(v);
      apply();
    });

    apply();
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
    initLocalPreview();
    initTalkback();
    initAutomix();
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
