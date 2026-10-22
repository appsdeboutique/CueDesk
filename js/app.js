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
  /* Bancos de previos de un X32 y su primer índice OSC (`/headamp/NNN`). */
  const PREAMP_SOURCES = [
    { id: "local", label: "Local", origin: 0 },
    { id: "netprimary", label: "Net Primary", origin: 32 },
    { id: "netsecondary", label: "Net Secondary", origin: 80 },
  ];
  /* Doce entradas: cada banco, en grupos de 8 previos. `base` es el índice
     0…31 dentro de la pantalla (el bloque de canales 1-8, 9-16, 17-24, 25-32)
     y `block` su número de bloque (0…3). El origen OSC del previo de la tira
     k del bloque es `origin + base + k`. */
  const PREAMP_BLOCKS = [];
  PREAMP_SOURCES.forEach(function (s) {
    [0, 8, 16, 24].forEach(function (base) {
      PREAMP_BLOCKS.push({
        label: s.label + " " + (base + 1) + "-" + (base + 8),
        source: s.id,
        origin: s.origin,
        base: base,
        block: base / 8,
      });
    });
  });
  const PREAMP_SOURCE_IDS = PREAMP_SOURCES.map(function (s) { return s.id; });
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
        sel("Synchronization", "/-prefs/clocksource", ["Internal", "Net Primary", "Net Secondary", "Exp Card"]),
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
    pickWrap.appendChild(pickName);
    pickWrap.appendChild(pick);
    head.appendChild(pickWrap);

    const globals = document.createElement("fieldset");
    globals.className = "setup__card";
    const gl = document.createElement("legend");
    gl.textContent = "Global options";
    globals.appendChild(gl);
    ["Lock Stagebox", "HA Gain Split", "HA Remote Net Primary Port", "HA Remote Net Secondary Port"].forEach(function (t) {
      globals.appendChild(setupRow(dis(t)));
    });
    head.appendChild(globals);
    box.appendChild(head);

    const blocks = PREAMP_BLOCKS.map(function (b, i) {
      const wrap = document.createElement("div");
      wrap.className = "setup__strips";
      wrap.hidden = i !== 0;
      for (let k = 0; k < 8; k++) {
        const n = b.base + k + 1;                                   // 1…32 en el banco
        const idx = String(b.origin + n - 1).padStart(3, "0");      // /headamp/NNN
        wrap.appendChild(preampStrip(n, idx));
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

  /* -------------------------------------------------------------- CueBox® */

  /* CueBox® es el módulo de hardware y red de la app: selección de consola y
     OSC, los dos puertos Ethernet (ETH0 consola · ETH1 control/iluminación) y
     los disparadores MIDI (RTP-MIDI hacia QLC+, sincronía B.Beat). Esta
     subpestaña es un HUB: una tarjeta por bloque, con su estado y sus
     controles. El rótulo visible lleva la marca (®); el identificador y el
     nombre interno van sin ella (`cuebox`). Los controles son de interfaz:
     todavía no hay rutas OSC para leerlos ni escribirlos. */
  const CUEBOX_SPEC = [
    {
      id: "consoles",
      mono: "OSC",
      title: "Consoles & OSC",
      sub: "Consola, IP destino y puerto de control",
      badge: { text: "Sin respuesta", tone: "warn" },
      items: [
        { kind: "select", label: "Consola", value: 0, options: ["Behringer X32", "Midas M32", "X32 Rack", "M32R"] },
        { kind: "text", label: "IP destino", value: "192.168.1.10" },
        { kind: "num", label: "Puerto OSC", value: 10023, min: 1, max: 65535, step: 1 },
      ],
    },
    {
      id: "network",
      mono: "NET",
      title: "CueBox® & Network",
      sub: "ETH0 consola · ETH1 control e iluminación",
      badge: { text: "Switch OK", tone: "ok" },
      items: [
        { kind: "text", label: "ETH0 · consola", value: "192.168.1.10/24" },
        { kind: "text", label: "ETH1 · control", value: "10.0.0.1/24" },
        { kind: "select", label: "Direccionamiento", value: 1, options: ["DHCP", "Static"] },
      ],
    },
    {
      id: "midi",
      mono: "MIDI",
      title: "MIDI & Triggers",
      sub: "MIDI físico, RTP-MIDI y B.Beat",
      badge: { text: "Pendiente", tone: "dim" },
      items: [
        { kind: "select", label: "Puerto MIDI", value: 0, options: ["In", "Out", "Thru"] },
        { kind: "bool", label: "RTP-MIDI → QLC+", value: 0 },
        { kind: "bool", label: "Sincronía B.Beat", value: 0 },
      ],
    },
  ];

  function cueboxRow(item) {
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
      input.value = String(item.value || 0);
    } else if (item.kind === "num") {
      input = document.createElement("input");
      input.type = "number";
      input.value = String(item.value);
      input.min = String(item.min);
      input.max = String(item.max);
      input.step = String(item.step);
    } else if (item.kind === "bool") {
      input = document.createElement("input");
      input.type = "checkbox";
      input.checked = Number(item.value) === 1;
    } else {
      input = document.createElement("input");
      input.type = "text";
      input.value = item.value === undefined ? "" : String(item.value);
    }
    /* El binding de Setup ignora lo que no trae `data-setup-osc` ni
       `data-setup-local`, así que estos controles no mandan nada a la consola. */
    input.dataset.cuebox = item.label;
    row.appendChild(input);
    return row;
  }

  function cueboxCard(spec) {
    const card = document.createElement("section");
    card.className = "cuebox__card";
    card.dataset.cueboxCard = spec.id;

    const head = document.createElement("header");
    head.className = "cuebox__head";

    const mono = document.createElement("span");
    mono.className = "cuebox__mono";
    mono.textContent = spec.mono;
    mono.setAttribute("aria-hidden", "true");

    const titles = document.createElement("div");
    titles.className = "cuebox__titles";
    const title = document.createElement("h3");
    title.className = "cuebox__title";
    title.textContent = spec.title;
    const sub = document.createElement("p");
    sub.className = "cuebox__sub";
    sub.textContent = spec.sub;
    titles.appendChild(title);
    titles.appendChild(sub);

    const tone = spec.badge && spec.badge.tone ? spec.badge.tone : "dim";
    const badge = document.createElement("span");
    badge.className = "cuebox__badge is-" + tone;
    badge.textContent = spec.badge ? spec.badge.text : "";

    head.appendChild(mono);
    head.appendChild(titles);
    head.appendChild(badge);
    card.appendChild(head);

    const body = document.createElement("div");
    body.className = "cuebox__body";
    (spec.items || []).forEach(function (item) {
      body.appendChild(cueboxRow(item));
    });
    card.appendChild(body);

    return card;
  }

  function renderCueBox(box) {
    CUEBOX_SPEC.forEach(function (spec) {
      box.appendChild(cueboxCard(spec));
    });

    const note = document.createElement("p");
    note.className = "cuebox__note setup__hint";
    note.textContent =
      "Estado y valores de la interfaz. La lectura y escritura de la consola, " +
      "de los puertos ETH0/ETH1 y del MIDI llegará con la integración de CueBox®.";
    box.appendChild(note);
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
    const cbx = setupBox("cuebox");
    if (cbx) renderCueBox(cbx);
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

  /* X32 (único soportado por ahora). Entradas: un selector por canal sobre
     /config/userrout/in/NN. Salidas: 16 filas con su fuente en
     /outputs/main/NN/src, su slot User Out en /config/userrout/out/NN y su
     modo de toma en /outputs/main/NN/pos.
     Valores: Maillot, X32 OSC Remote Protocol (FW 4.x). */
  const X32_CHANNELS = 32;
  const X32_OUTPUTS = 16;

  /* Secciones de /config/userrout/in/NN: el valor es el índice del enum. */
  const USER_IN_SECTIONS = [
    { group: "Local", base: 1, count: 32, name: "Local" },
    { group: "Net Primary", base: 33, count: 48, name: "Net Primary" },
    { group: "Net Secondary", base: 81, count: 48, name: "Net Secondary" },
    { group: "Card", base: 129, count: 32, name: "Card" },
    { group: "Aux", base: 161, count: 6, name: "Aux" },
    { group: "TB", base: 167, count: 2, name: "TB", names: ["TB Internal", "TB External"] },
  ];

  /* Secciones de /outputs/main/NN/src: la señal que alimenta cada salida
     lógica. Incluye Main L/R/M/C, que no existe en User Out. */
  const OUTPUT_SOURCE_SECTIONS = [
    { group: "Main", base: 1, count: 3, name: "Main", names: ["L", "R", "M/C"] },
    { group: "Mix Bus", base: 4, count: 16, name: "Mix Bus" },
    { group: "Matrix", base: 20, count: 6, name: "Matrix" },
    { group: "Direct Ch", base: 26, count: 32, name: "Direct Ch" },
    { group: "Direct Aux", base: 58, count: 8, name: "Direct Aux" },
    { group: "Direct FX", base: 66, count: 8, name: "Direct FX", names: ["1L", "1R", "2L", "2R", "3L", "3R", "4L", "4R"] },
    { group: "Monitor", base: 74, count: 3, name: "Monitor", names: ["L", "R", "TB"] },
  ];

  /* Secciones de /config/userrout/out/NN: la fuente del slot User Out.
     Es una capa distinta de /outputs/main/NN/src (Main, buses, matriz…). */
  const USER_OUT_SECTIONS = [
    { group: "Local", base: 1, count: 32, name: "Local" },
    { group: "Net Primary", base: 33, count: 48, name: "Net Primary" },
    { group: "Net Secondary", base: 81, count: 48, name: "Net Secondary" },
    { group: "Card", base: 129, count: 32, name: "Card" },
    { group: "Aux In", base: 161, count: 6, name: "Aux In" },
    { group: "TB", base: 167, count: 2, name: "TB", names: ["TB Internal", "TB External"] },
    { group: "Output", base: 169, count: 16, name: "Output" },
    { group: "P16", base: 185, count: 16, name: "P16" },
    { group: "AUX", base: 201, count: 6, name: "AUX" },
    { group: "Monitor", base: 207, count: 2, name: "Monitor", names: ["Monitor L", "Monitor R"] },
  ];

  /* Modos de toma de /outputs/main/NN/pos (enum Xotpos). */
  const OUTPUT_MODES = [
    { value: 0, label: "Input" },
    { value: 1, label: "Input + Mute" },
    { value: 2, label: "Pre EQ" },
    { value: 3, label: "Pre EQ + Mute" },
    { value: 4, label: "Post EQ" },
    { value: 5, label: "Post EQ + Mute" },
    { value: 6, label: "Pre Fader" },
    { value: 7, label: "Pre Fader + Mute" },
    { value: 8, label: "Post Fader" },
  ];

  /* ---------------------------------------------------- XLR (capa física) */

  /* Los 16 XLR se enrutan en cuatro bloques de 4. El enum de
     /config/routing/OUT/<bloque> es el mismo 0…35 para todos, pero las
     etiquetas cambian según el bloque sea la mitad izquierda (1-4 / 9-12)
     o derecha (5-8 / 13-16) de su grupo de 8. FW 4.x añadió User Out
     (valores 26…31) y User In (32…35). */
  const XLR_BLOCKS = [
    { id: "1-4", sockets: [1, 2, 3, 4], left: true, outValue: 20, userOutValue: 26 },
    { id: "5-8", sockets: [5, 6, 7, 8], left: false, outValue: 20, userOutValue: 26 },
    { id: "9-12", sockets: [9, 10, 11, 12], left: true, outValue: 21, userOutValue: 27 },
    { id: "13-16", sockets: [13, 14, 15, 16], left: false, outValue: 21, userOutValue: 27 },
  ];

  /* Último valor visto de cada bloque. `known` distingue el valor por
     defecto (Out 1-16, como la consola de fábrica) de lo que publica la
     consola, para que la tira no parezca vacía antes del primer /xremote. */
  const XLR_STATE = new Map();
  XLR_BLOCKS.forEach(function (block) {
    XLR_STATE.set(block.id, { value: block.outValue, known: false });
  });

  function xlrRange(first) {
    return first + "-" + (first + 3);
  }

  /* Opciones del selector físico, agrupadas y con las dos capas relevantes
     (Out 1-16 / User Out 1-16) arriba. Los valores son el enum OSC. */
  function xlrOptions(left) {
    const first = left ? 1 : 5;
    function bank(label, base, count) {
      const options = [];
      for (let i = 0; i < count; i++) {
        options.push({
          value: base + i,
          label: label + " " + xlrRange(first + i * 8),
        });
      }
      return { label: label, options: options };
    }
    return [
      bank("Out", 20, 2),
      bank("User Out", 26, 6),
      bank("Local", 0, 4),
      bank("Net Primary", 4, 6),
      bank("Net Secondary", 10, 6),
      bank("Card", 16, 4),
      bank("Ultranet", 22, 2),
      {
        label: "Aux",
        options: [
          { value: 24, label: "Aux Out / CR" },
          { value: 25, label: "Aux In / TB" },
        ],
      },
      bank("User In", 32, 4),
    ];
  }

  const XLR_OPTIONS = { left: xlrOptions(true), right: xlrOptions(false) };

  function xlrOptionLabel(block, value) {
    const groups = XLR_OPTIONS[block.left ? "left" : "right"];
    for (let i = 0; i < groups.length; i++) {
      const options = groups[i].options;
      for (let j = 0; j < options.length; j++) {
        if (options[j].value === value) return options[j].label;
      }
    }
    return "Value " + value;
  }

  /* Traduce el valor del bloque a la capa que lo alimenta y a los canales
     lógicos implicados. `outs` son índices de Out 1-16 o User Out 1-48;
     `sockets` son los XLR físicos del bloque (1-4, 5-8…). */
  function xlrFeed(block, raw) {
    const value = parseInt(raw, 10);
    if (!isFinite(value)) {
      return { kind: "unknown", label: "Waiting for console", outs: [], sockets: block.sockets };
    }
    const first = block.left ? 1 : 5;
    if (value === 20 || value === 21) {
      const start = first + (value - 20) * 8;
      return {
        kind: "out",
        label: "Out " + xlrRange(start),
        outs: [start, start + 1, start + 2, start + 3],
        sockets: block.sockets,
      };
    }
    if (value >= 26 && value <= 31) {
      const start = first + (value - 26) * 8;
      return {
        kind: "userout",
        label: "User Out " + xlrRange(start),
        outs: [start, start + 1, start + 2, start + 3],
        sockets: block.sockets,
        /* Sólo los slots 1-16 se editan en esta tabla. */
        editable: start <= 13,
      };
    }
    return {
      kind: "other",
      label: xlrOptionLabel(block, value),
      outs: [],
      sockets: block.sockets,
    };
  }

  function xlrFeedOf(block) {
    const state = XLR_STATE.get(block.id);
    return xlrFeed(block, state ? state.value : null);
  }

  function xlrSocketsFor(kind, n) {
    const sockets = [];
    XLR_BLOCKS.forEach(function (block) {
      const feed = xlrFeedOf(block);
      if (feed.kind !== kind) return;
      const index = feed.outs.indexOf(n);
      if (index >= 0) sockets.push(feed.sockets[index]);
    });
    return sockets;
  }

  function xlrSocketsForOut(n) {
    return xlrSocketsFor("out", n);
  }

  function xlrSocketsForUserOut(n) {
    return xlrSocketsFor("userout", n);
  }

  /* "1, 2, 5-7" a partir de una lista de sockets. */
  function formatSockets(list) {
    const uniq = [];
    list.slice().sort(function (a, b) { return a - b; }).forEach(function (n) {
      if (uniq[uniq.length - 1] !== n) uniq.push(n);
    });
    if (!uniq.length) return "";
    const parts = [];
    let start = uniq[0];
    let prev = uniq[0];
    for (let i = 1; i <= uniq.length; i++) {
      const n = uniq[i];
      if (n === prev + 1) {
        prev = n;
        continue;
      }
      parts.push(start === prev ? String(start) : start + "-" + prev);
      start = prev = n;
    }
    return parts.join(", ");
  }

  function outputPad(n) {
    return String(n).padStart(2, "0");
  }

  /* User Out 1-16 editable en la tabla. Los valores 169…184 apuntan a
     Out 1-16, que es la forma de meter una señal procesada en el bank. */
  const USER_OUT_VALUES = new Map();

  function userOutTarget(value) {
    const target = parseInt(value, 10) - 168;
    return target >= 1 && target <= X32_OUTPUTS ? target : null;
  }

  function xlrIndirectSocketsForOut(n) {
    const sockets = [];
    USER_OUT_VALUES.forEach(function (value, slot) {
      if (value !== 168 + n) return;
      sockets.push.apply(sockets, xlrSocketsForUserOut(slot));
    });
    return sockets;
  }

  /* Nombre y color que la consola publica por OSC. Las claves de color son
     las mismas que usa el mixer ({OFF, RD, GN, YE, BL, MG, CY, WH}). */
  const ROUTE_COLOR_HEX = {
    0: "#6b6b78",
    1: "#ff3b30",
    2: "#22c55e",
    3: "#f5c518",
    4: "#2f6bff",
    5: "#ff3bd4",
    6: "#00c0ce",
    7: "#f4f4f6",
  };
  const ROUTE_COLOR_ENUM = {
    off: 0, red: 1, green: 2, yellow: 3, blue: 4, magenta: 5, cyan: 6, white: 7,
  };

  /* Semilla local para que los nombres/colores de bus ya editados en el
     mixer aparezcan sin esperar al primer mensaje OSC. La consola manda
     después y corrige cualquier diferencia. */
  function routeStoredMap(key) {
    try {
      return JSON.parse(localStorage.getItem(key) || "{}") || {};
    } catch (_) {
      return {};
    }
  }
  const ROUTE_BUS_NAMES = routeStoredMap("cuedesk.bus.names");
  const ROUTE_BUS_COLORS = routeStoredMap("cuedesk.bus.colors");
  const ROUTE_CH_COLORS = routeStoredMap("cuedesk.ch.colors");

  /* Último nombre/color conocido por ruta. Se actualiza con lo que llega de la
     consola y con los cambios hechos en la propia app (eco local), para que
     una fila no vuelva al nombre de reserva al recibir un snapshot repetido
     de /outputs/main/NN/src. */
  const ROUTE_LIVE_NAMES = new Map();
  const ROUTE_LIVE_COLORS = new Map();

  function routeCleanName(v) {
    return String(v === null || v === undefined ? "" : v).trim();
  }

  /* Rótulo de fila: número + punto de color + nombre real. El nombre y el
     color se suscriben a las rutas de config de la consola; si todavía no
     han llegado, se muestra el nombre de la sección como respaldo. */
  function routeLabel(id, context, opts) {
    opts = opts || {};
    const el = document.createElement("span");
    el.className = "route-label";
    el.title = context;

    const num = document.createElement("span");
    num.className = "route-label__num";
    num.textContent = id;

    const dot = document.createElement("span");
    dot.className = "route-label__dot";
    dot.hidden = true;

    const name = document.createElement("span");
    name.className = "route-label__name";

    if (!opts.hideNumber) el.appendChild(num);
    el.appendChild(dot);
    el.appendChild(name);
    let fallback = "";
    let detail = "";
    let offs = [];

    function paintName(value) {
      const shown = routeCleanName(value) || fallback;
      name.textContent = shown;
      el.title =
        context +
        (detail ? " · " + detail : "") +
        (shown ? " · " + shown : "");
    }

    function paintColor(value) {
      let n = value;
      if (typeof n === "string" && ROUTE_COLOR_ENUM[n] !== undefined) {
        n = ROUTE_COLOR_ENUM[n];
      }
      n = parseInt(n, 10);
      const hex = ROUTE_COLOR_HEX[n];
      if (hex) {
        dot.style.background = hex;
        dot.hidden = false;
      } else {
        dot.style.background = "";
        dot.hidden = true;
      }
    }

    return {
      el: el,
      setFallback: function (text, extra) {
        fallback = text;
        detail = extra || "";
        paintName("");
      },
      bind: function (namePath, colorPath, seedName, seedColor) {
        offs.forEach(function (off) { off(); });
        offs = [];
        const cachedName = namePath ? ROUTE_LIVE_NAMES.get(namePath) : undefined;
        const cachedColor = colorPath ? ROUTE_LIVE_COLORS.get(colorPath) : undefined;
        paintName(cachedName !== undefined ? cachedName : seedName);
        paintColor(cachedColor !== undefined ? cachedColor : seedColor);
        if (namePath) {
          offs.push(CueDesk.OSC.on(namePath, function (v) {
            ROUTE_LIVE_NAMES.set(namePath, v);
            paintName(v);
          }));
        }
        if (colorPath) {
          offs.push(CueDesk.OSC.on(colorPath, function (v) {
            ROUTE_LIVE_COLORS.set(colorPath, v);
            paintColor(v);
          }));
        }
        /* Eco local: los cambios hechos en la vista Mixer (o en cualquier
           otro control) salen por cuedesk:osc-out, pero no vuelven por
           CueDesk.OSC.receive. Refrescamos la etiqueta sin esperar a que la
           consola reenvíe el valor. */
        function onLocal(detail) {
          if (!detail || !detail.path) return;
          if (namePath && detail.path === namePath) {
            ROUTE_LIVE_NAMES.set(namePath, detail.value);
            paintName(detail.value);
          }
          if (colorPath && detail.path === colorPath) {
            ROUTE_LIVE_COLORS.set(colorPath, detail.value);
            paintColor(detail.value);
          }
        }
        function onLocalEvent(e) { onLocal(e.detail); }
        document.addEventListener("cuedesk:osc-out", onLocalEvent);
        offs.push(function () {
          document.removeEventListener("cuedesk:osc-out", onLocalEvent);
        });
      },
      destroy: function () {
        offs.forEach(function (off) { off(); });
        offs = [];
      },
    };
  }

  /* Traduce /outputs/main/NN/src a la señal que lo alimenta y a las rutas
     de nombre/color de esa señal. Enum Xomonsrc (0…76). */
  function outSourceInfo(value) {
    if (value === null || value === undefined || value === "") {
      return { label: "—", detail: "esperando consola", namePath: null, colorPath: null };
    }
    const n = parseInt(value, 10);
    if (!isFinite(n) || n === 0) {
      return { label: "Off", detail: "sin señal", namePath: null, colorPath: null };
    }
    if (n === 1 || n === 2) {
      return {
        label: n === 1 ? "Main L" : "Main R",
        detail: "Main",
        namePath: null,
        colorPath: "/main/st/config/color",
        seedColor: "white",
      };
    }
    if (n === 3) {
      return {
        label: "Main M/C",
        detail: "Main",
        namePath: null,
        colorPath: "/main/m/config/color",
        seedColor: "white",
      };
    }
    if (n >= 4 && n <= 19) {
      const k = n - 3;
      const id = String(k).padStart(2, "0");
      return {
        label: "Mix Bus " + id,
        detail: "Mix Bus",
        namePath: "/bus/" + id + "/config/name",
        colorPath: "/bus/" + id + "/config/color",
        seedName: ROUTE_BUS_NAMES[String(k)],
        seedColor: ROUTE_BUS_COLORS[String(k)],
      };
    }
    if (n >= 20 && n <= 25) {
      const k = n - 19;
      const id = String(k).padStart(2, "0");
      return {
        label: "Matrix " + k,
        detail: "Matrix",
        namePath: "/mtx/" + id + "/config/name",
        colorPath: "/mtx/" + id + "/config/color",
        seedColor: ROUTE_CH_COLORS["mtx:" + k],
      };
    }
    if (n >= 26 && n <= 57) {
      const k = n - 25;
      const id = String(k).padStart(2, "0");
      return {
        label: "CH " + id,
        detail: "Direct Out",
        namePath: "/ch/" + id + "/config/name",
        colorPath: "/ch/" + id + "/config/color",
        seedColor: ROUTE_CH_COLORS["ch:" + k],
      };
    }
    if (n >= 58 && n <= 65) {
      const k = n - 57;
      const id = String(k).padStart(2, "0");
      return {
        label: "Aux In " + id,
        detail: "Direct Out",
        namePath: "/auxin/" + id + "/config/name",
        colorPath: "/auxin/" + id + "/config/color",
        seedColor: ROUTE_CH_COLORS["aux:" + k],
      };
    }
    if (n >= 66 && n <= 73) {
      const k = n - 65;
      const id = String(k).padStart(2, "0");
      const fx = Math.ceil(k / 2);
      const side = k % 2 === 1 ? "L" : "R";
      return {
        label: "FX " + fx + side,
        detail: "Direct Out",
        namePath: "/fxrtn/" + id + "/config/name",
        colorPath: "/fxrtn/" + id + "/config/color",
        seedColor: ROUTE_CH_COLORS["fx:" + k],
      };
    }
    if (n >= 74 && n <= 76) {
      return {
        label: n === 74 ? "Monitor L" : n === 75 ? "Monitor R" : "Talkback",
        detail: "Monitor",
        namePath: null,
        colorPath: null,
      };
    }
    return {
      label: "src " + n,
      detail: "desconocido",
      namePath: null,
      colorPath: null,
    };
  }

  /* Selector doble: primero la sección (Local, Net Primary…) y después el
     número dentro de ella (1…32, 1…48…). El valor OSC es section.base + k. */
  function sourcePicker(sections, name) {
    const wrap = document.createElement("span");
    wrap.className = "route-picker";

    const groupSel = document.createElement("select");
    groupSel.className = "route-select route-select--group";
    groupSel.setAttribute("aria-label", (name || "Source") + " section");

    const off = document.createElement("option");
    off.value = "-1";
    off.textContent = "Off";
    groupSel.appendChild(off);

    sections.forEach(function (section, i) {
      const op = document.createElement("option");
      op.value = String(i);
      op.textContent = section.group;
      groupSel.appendChild(op);
    });

    const itemSel = document.createElement("select");
    itemSel.className = "route-select route-select--item";
    itemSel.setAttribute("aria-label", (name || "Source") + " number");

    function fillItems(index, selected) {
      itemSel.textContent = "";
      const section = sections[index];
      if (!section) {
        itemSel.disabled = true;
        itemSel.setAttribute("aria-label", (name || "Source") + " number (off)");
        return;
      }
      itemSel.disabled = false;
      itemSel.setAttribute("aria-label", (name || "Source") + " " + section.name);
      for (let k = 0; k < section.count; k++) {
        const op = document.createElement("option");
        op.value = String(k);
        op.textContent = section.names ? section.names[k] : String(k + 1);
        itemSel.appendChild(op);
      }
      if (selected != null && selected >= 0 && selected < section.count) {
        itemSel.value = String(selected);
      }
    }

    let onChange = null;

    function currentValue() {
      const section = sections[parseInt(groupSel.value, 10)];
      if (!section) return 0;
      return section.base + parseInt(itemSel.value, 10);
    }

    function emit() {
      if (onChange) onChange(currentValue());
    }

    groupSel.addEventListener("change", function () {
      const index = parseInt(groupSel.value, 10);
      fillItems(index, index >= 0 ? 0 : null);
      emit();
    });
    itemSel.addEventListener("change", emit);

    fillItems(-1);

    wrap.appendChild(groupSel);
    wrap.appendChild(itemSel);

    return {
      el: wrap,
      onChange: function (fn) { onChange = fn; },
      getValue: currentValue,
      setValue: function (v) {
        const n = parseInt(v, 10);
        let index = -1;
        let item = null;
        for (let i = 0; i < sections.length; i++) {
          const s = sections[i];
          if (n >= s.base && n < s.base + s.count) {
            index = i;
            item = n - s.base;
            break;
          }
        }
        groupSel.value = String(index);
        fillItems(index, item);
      },
      setDisabled: function (off) {
        groupSel.disabled = off;
        itemSel.disabled = off || groupSel.value === "-1";
      },
    };
  }

  function routingTable(headers) {
    const table = document.createElement("table");
    table.className = "route-table route-list";
    const head = document.createElement("tr");
    headers.forEach(function (text) {
      const th = document.createElement("th");
      th.textContent = text;
      head.appendChild(th);
    });
    table.appendChild(head);
    return table;
  }

  function routingCell(child) {
    const td = document.createElement("td");
    td.appendChild(child);
    return td;
  }

  /* Global: rellena de una vez las fuentes individuales de Inputs/Outputs.
     Después se pueden corregir filas concretas en sus pestañas. */
  function renderGlobal(box) {
    const grid = document.createElement("div");
    grid.className = "global-routing";

    function describe(sections, value, total, noun) {
      if (!value) return noun + " 1-" + total + " → Off";
      let section = null;
      for (let i = 0; i < sections.length; i++) {
        const s = sections[i];
        if (value >= s.base && value < s.base + s.count) { section = s; break; }
      }
      if (!section) return "";
      const start = value - section.base;
      const count = Math.min(total, section.count - start);
      if (count <= 0) return noun + " 1-" + total + " → Off";
      let range;
      if (section.names) {
        const firstName = section.names[start];
        const first = firstName.indexOf(section.group) === 0
          ? firstName
          : section.group + " " + firstName;
        const lastName = section.names[start + count - 1];
        const last = lastName.indexOf(section.group) === 0
          ? lastName.slice(section.group.length).trim()
          : lastName;
        range = count > 1 ? first + "…" + last : first;
      } else {
        range = section.group + " " + (start + 1) + "-" + (start + count);
      }
      return noun + " 1-" + count + " → " + range +
        (count < total ? ", " + (count + 1) + "-" + total + " Off" : "");
    }

    function applyInputs(value) {
      ["1-8", "9-16", "17-24", "25-32"].forEach(function (block, i) {
        CueDesk.OSC.send("/config/routing/IN/" + block, 20 + i, "i", { commit: true });
      });
      let section = null;
      for (let i = 0; i < USER_IN_SECTIONS.length; i++) {
        const s = USER_IN_SECTIONS[i];
        if (value >= s.base && value < s.base + s.count) { section = s; break; }
      }
      for (let n = 1; n <= X32_CHANNELS; n++) {
        const out = section && value + (n - 1) < section.base + section.count
          ? value + (n - 1)
          : 0;
        const path = "/config/userrout/in/" + String(n).padStart(2, "0");
        CueDesk.OSC.send(path, out, "i", { commit: true });
        CueDesk.OSC.receive(path, out);
      }
    }

    function applyOutputs(value, physical) {
      if (physical === "out" || physical === "userout") {
        setBlockRouting(physical);
      }
      if (physical === "userout") {
        /* El bank User Out sólo lleva señales si sus 16 slots apuntan a
           Out 1-16; los llenamos para que la capa elegida suene. */
        for (let n = 1; n <= X32_OUTPUTS; n++) {
          const path = "/config/userrout/out/" + outputPad(n);
          CueDesk.OSC.send(path, 168 + n, "i", { commit: true });
          CueDesk.OSC.receive(path, 168 + n);
        }
      }
      let section = null;
      for (let i = 0; i < OUTPUT_SOURCE_SECTIONS.length; i++) {
        const s = OUTPUT_SOURCE_SECTIONS[i];
        if (value >= s.base && value < s.base + s.count) { section = s; break; }
      }
      for (let n = 1; n <= X32_OUTPUTS; n++) {
        const out = section && value + (n - 1) < section.base + section.count
          ? value + (n - 1)
          : 0;
        const path = "/outputs/main/" + outputPad(n) + "/src";
        CueDesk.OSC.send(path, out, "i", { commit: true });
        CueDesk.OSC.receive(path, out);
      }
    }

    let physicalMode = "out";

    function physicalControls(refresh) {
      const fieldset = document.createElement("fieldset");
      fieldset.className = "global-routing__physical";
      const legend = document.createElement("legend");
      legend.textContent = "XLR 1-16 physical source";
      fieldset.appendChild(legend);

      [
        ["out", "Out 1-16"],
        ["userout", "User Out 1-16"],
        ["keep", "Leave unchanged"],
      ].forEach(function (item, index) {
        const label = document.createElement("label");
        const input = document.createElement("input");
        input.type = "radio";
        input.name = "global-xlr-source";
        input.value = item[0];
        input.checked = index === 0;
        input.addEventListener("change", function () {
          if (!input.checked) return;
          physicalMode = item[0];
          refresh();
        });
        const text = document.createElement("span");
        text.textContent = item[1];
        label.appendChild(input);
        label.appendChild(text);
        fieldset.appendChild(label);
      });

      const note = document.createElement("p");
      note.className = "global-routing__physical-note";
      note.textContent =
        "Out points the sockets at Out 1-16. User Out also fills User Out " +
        "1-16 with Out 1-16, so the custom bank mirrors the logical outputs. " +
        "Individual blocks can still be changed in Outputs.";
      fieldset.appendChild(note);
      return fieldset;
    }

    function card(title, hint, sections, total, apply, extra) {
      const group = document.createElement("section");
      group.className = "global-routing__group";

      const head = document.createElement("div");
      head.className = "global-routing__head";
      const h = document.createElement("h3");
      h.textContent = title;
      head.appendChild(h);
      group.appendChild(head);

      const note = document.createElement("p");
      note.className = "global-routing__hint";
      note.textContent = hint;
      group.appendChild(note);

      const row = document.createElement("div");
      row.className = "global-routing__source";
      const picker = sourcePicker(sections, title + " global source");
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "global-routing__apply";
      btn.textContent = "Apply to all " + total;
      const summary = document.createElement("p");
      summary.className = "global-routing__summary";

      function refresh() {
        let text = describe(
          sections,
          picker.getValue(),
          total,
          title === "Inputs" ? "Channels" : "Outputs"
        );
        if (title === "Outputs") {
          text += " · XLR 1-16 ← " + (
            physicalMode === "out" ? "Out 1-16" :
            physicalMode === "userout" ? "User Out 1-16" : "unchanged"
          );
        }
        summary.textContent = text;
      }

      picker.onChange(refresh);
      refresh();
      btn.addEventListener("click", function () {
        const value = picker.getValue();
        if (!value && !window.confirm("Set all " + title.toLowerCase() + " to Off?")) return;
        apply(value, physicalMode);
        refresh();
      });

      row.appendChild(picker.el);
      row.appendChild(btn);
      group.appendChild(row);
      group.appendChild(summary);
      if (extra) group.appendChild(extra(refresh));
      return group;
    }

    grid.appendChild(card(
      "Inputs",
      "Set a starting source for the Source column on every channel, then adjust exceptions in Inputs. Applying also puts the four input blocks in User In.",
      USER_IN_SECTIONS,
      X32_CHANNELS,
      applyInputs
    ));

    grid.appendChild(card(
      "Outputs",
      "Set a starting source for every output, then fine-tune rows in Outputs. Choose whether the XLR sockets follow Out 1-16 or the User Out bank.",
      OUTPUT_SOURCE_SECTIONS,
      X32_OUTPUTS,
      applyOutputs,
      physicalControls
    ));

    box.appendChild(grid);
  }

  function renderInputList(box) {
    const table = routingTable(["Channel", "Source"]);
    for (let n = 1; n <= X32_CHANNELS; n++) {
      const id = String(n).padStart(2, "0");
      const path = "/config/userrout/in/" + id;
      const picker = sourcePicker(USER_IN_SECTIONS, "Source of channel " + n);
      picker.onChange(function (v) {
        CueDesk.OSC.send(path, v, "i", { commit: true });
      });
      CueDesk.OSC.on(path, function (v) {
        const k = parseInt(v, 10);
        if (isFinite(k)) picker.setValue(k);
      });
      const tr = document.createElement("tr");
      const th = document.createElement("th");
      const label = routeLabel(id, "Channel " + id);
      label.setFallback("CH " + id);
      label.bind(
        "/ch/" + id + "/config/name",
        "/ch/" + id + "/config/color",
        null,
        ROUTE_CH_COLORS["ch:" + n]
      );
      th.appendChild(label.el);
      tr.appendChild(th);
      tr.appendChild(routingCell(picker.el));
      table.appendChild(tr);
    }
    const wrap = document.createElement("div");
    wrap.className = "route-scroll";
    wrap.appendChild(table);
    box.appendChild(wrap);
  }

  /* --------------------------------------------------- Outputs: dos capas */

  const OUTPUT_LIST_ROWS = [];
  const OUTPUT_GROUP_ROWS = [];
  const MATRIX_ROWS = [];
  const XLR_CARDS = [];

  /* Tira superior: los cuatro bloques físicos. Cada tarjeta muestra y edita
     el banco que escucha ese grupo de XLR y avisa qué capa está en el aire. */
  function renderOutputsPhysical(box) {
    const strip = document.createElement("div");
    strip.className = "xlr-strip";

    XLR_BLOCKS.forEach(function (block) {
      const path = "/config/routing/OUT/" + block.id;
      const card = document.createElement("section");
      card.className = "xlr-card";
      card.dataset.block = block.id;

      const head = document.createElement("div");
      head.className = "xlr-card__head";
      const title = document.createElement("span");
      title.className = "xlr-card__title";
      title.textContent = "XLR " + block.id;
      const dot = document.createElement("span");
      dot.className = "xlr-card__dot";
      head.appendChild(title);
      head.appendChild(dot);

      const sel = document.createElement("select");
      sel.className = "route-select xlr-card__select";
      sel.setAttribute("aria-label", "Physical source of XLR " + block.id);
      XLR_OPTIONS[block.left ? "left" : "right"].forEach(function (group) {
        const og = document.createElement("optgroup");
        og.label = group.label;
        group.options.forEach(function (opt) {
          const op = document.createElement("option");
          op.value = String(opt.value);
          op.textContent = opt.label;
          og.appendChild(op);
        });
        sel.appendChild(og);
      });

      const feed = document.createElement("p");
      feed.className = "xlr-card__feed";

      card.appendChild(head);
      card.appendChild(sel);
      card.appendChild(feed);
      strip.appendChild(card);

      let extra = null;
      let lastValue;

      function paint() {
        const state = XLR_STATE.get(block.id);
        const value = state.value;
        if (value !== lastValue) {
          lastValue = value;
          if (extra) {
            extra.remove();
            extra = null;
          }
          sel.value = String(value);
          if (sel.value !== String(value)) {
            extra = document.createElement("option");
            extra.value = String(value);
            extra.textContent = "Value " + value + " (unknown)";
            sel.appendChild(extra);
            sel.value = String(value);
          }
        }
        const info = xlrFeed(block, value);
        card.dataset.layer = info.kind;
        dot.title = info.label;
        if (info.kind === "unknown") {
          feed.textContent = "Waiting for console…";
        } else if (info.kind === "out") {
          feed.textContent = info.label + " · Out layer" +
            (state.known ? "" : " (default)");
        } else if (info.kind === "userout") {
          feed.textContent = info.label + " · custom bank" +
            (info.editable ? "" : " · not editable here") +
            (state.known ? "" : " (default)");
        } else {
          feed.textContent = info.label + " · Out layer bypassed" +
            (state.known ? "" : " (default)");
        }
      }

      sel.addEventListener("change", function () {
        const value = parseInt(sel.value, 10);
        if (!isFinite(value)) return;
        CueDesk.OSC.send(path, value, "i", { commit: true });
        CueDesk.OSC.receive(path, value);
      });

      CueDesk.OSC.on(path, function (v) {
        const value = parseInt(v, 10);
        if (!isFinite(value)) return;
        XLR_STATE.set(block.id, { value: value, known: true });
        refreshXlrUi();
      });

      XLR_CARDS.push({ block: block, paint: paint });
      paint();
    });

    box.appendChild(strip);
  }

  function refreshXlrUi() {
    XLR_CARDS.forEach(function (entry) { entry.paint(); });
    refreshOutputLayers();
    if (outFit) queueOutFit();
  }

  function setBlockRouting(physical) {
    XLR_BLOCKS.forEach(function (block) {
      const value = physical === "out" ? block.outValue : block.userOutValue;
      const path = "/config/routing/OUT/" + block.id;
      CueDesk.OSC.send(path, value, "i", { commit: true });
      CueDesk.OSC.receive(path, value);
    });
  }

  function refreshOutputLayers() {
    OUTPUT_LIST_ROWS.forEach(function (row) {
      const direct = xlrSocketsForOut(row.n);
      const indirect = xlrIndirectSocketsForOut(row.n);
      const userOut = xlrSocketsForUserOut(row.n);
      const active = direct.length > 0 || indirect.length > 0;

      row.tr.classList.toggle("is-out-live", active);
      row.tr.classList.toggle("is-userout-live", userOut.length > 0);
      row.sourceCell.classList.toggle("is-dim", !active);
      row.modeCell.classList.toggle("is-dim", !active);
      row.userOutCell.classList.toggle("is-dim", userOut.length === 0);

      row.outDirect.textContent = direct.length ? "XLR " + formatSockets(direct) : "";
      row.outDirect.hidden = direct.length === 0;
      row.outDirect.title = direct.length
        ? "Out " + outputPad(row.n) + " feeds XLR " + formatSockets(direct)
        : "";

      const refs = [];
      USER_OUT_VALUES.forEach(function (value, slot) {
        if (value === 168 + row.n && xlrSocketsForUserOut(slot).length) refs.push(slot);
      });
      row.outIndirect.textContent = refs.length
        ? "via UOut " + refs.map(outputPad).join(", ")
        : "";
      row.outIndirect.hidden = refs.length === 0;
      row.outIndirect.title = refs.length
        ? "Reaches XLR through User Out " + refs.map(outputPad).join(", ")
        : "";

      row.userOutDirect.textContent = userOut.length ? "XLR " + formatSockets(userOut) : "";
      row.userOutDirect.hidden = userOut.length === 0;
      row.userOutDirect.title = userOut.length
        ? "User Out " + outputPad(row.n) + " feeds XLR " + formatSockets(userOut)
        : "";

      const via = userOutTarget(USER_OUT_VALUES.get(row.n));
      row.userOutVia.textContent = via ? "Out " + outputPad(via) : "";
      row.userOutVia.hidden = via === null;
      row.userOutVia.title = via ? "This User Out slot carries Out " + outputPad(via) : "";
    });

    OUTPUT_GROUP_ROWS.forEach(function (group) {
      const directOut = [];
      const indirectOut = [];
      const userOutSockets = [];
      for (let n = group.start; n < group.start + 4; n++) {
        directOut.push.apply(directOut, xlrSocketsForOut(n));
        indirectOut.push.apply(indirectOut, xlrIndirectSocketsForOut(n));
        userOutSockets.push.apply(userOutSockets, xlrSocketsForUserOut(n));
      }

      group.path.textContent = "";
      const parts = [];
      if (directOut.length && indirectOut.length) {
        parts.push({ text: "Out → XLR " + formatSockets(directOut), kind: "out" });
        parts.push({ text: "UOut → XLR " + formatSockets(indirectOut), kind: "userout" });
      } else if (directOut.length) {
        parts.push({ text: "Out → XLR " + formatSockets(directOut), kind: "out" });
      } else if (indirectOut.length) {
        parts.push({ text: "Out → UOut → XLR " + formatSockets(indirectOut), kind: "out" });
      }

      /* Sólo añadimos la capa User Out cuando aporta sockets que no vienen
         ya descritos por la cadena Out → UOut. */
      const remainingUserOut = userOutSockets.filter(function (socket) {
        return indirectOut.indexOf(socket) === -1;
      });
      if (remainingUserOut.length) {
        parts.push({
          text: "User Out → XLR " + formatSockets(remainingUserOut),
          kind: "userout",
        });
      }
      if (!parts.length) {
        group.path.textContent = "not routed to XLR";
        group.path.classList.add("is-off");
        return;
      }
      group.path.classList.remove("is-off");
      parts.forEach(function (part, i) {
        if (i) group.path.appendChild(document.createTextNode(" · "));
        const span = document.createElement("span");
        span.className = "route-group__part route-group__part--" + part.kind;
        span.textContent = part.text;
        group.path.appendChild(span);
      });
    });

    refreshMatrixLayers();
  }

  function refreshMatrixLayers() {
    MATRIX_ROWS.forEach(function (row) {
      const direct = xlrSocketsForOut(row.n);
      const indirect = xlrIndirectSocketsForOut(row.n);
      row.liveDot.hidden = direct.length === 0 && indirect.length === 0;
      row.liveDot.dataset.state = direct.length ? "direct" : indirect.length ? "indirect" : "off";
      row.rowHead.classList.toggle("is-dim", direct.length === 0 && indirect.length === 0);
      row.rowHead.title = direct.length
        ? "Feeds XLR " + formatSockets(direct)
        : indirect.length
          ? "Feeds XLR " + formatSockets(indirect) + " via User Out"
          : "Not routed to XLR";
    });
  }

  /* Lista lógica: una fila por Out, con la columna Output como identidad y
     la columna Source como selector. La ruta física se refleja en etiquetas
     y atenuación, sin ocultar los controles. */
  function renderOutputList(box) {
    OUTPUT_LIST_ROWS.length = 0;
    OUTPUT_GROUP_ROWS.length = 0;

    const table = routingTable(["Source", "User Out", "Output", "Mode"]);
    table.classList.add("route-list--outputs");

    function groupHeader(start) {
      const tr = document.createElement("tr");
      tr.className = "route-group";
      const th = document.createElement("th");
      th.colSpan = 4;
      const label = document.createElement("span");
      label.className = "route-group__label";
      label.textContent = "Out " + start + "-" + (start + 3);
      const path = document.createElement("span");
      path.className = "route-group__path";
      th.appendChild(label);
      th.appendChild(path);
      tr.appendChild(th);
      table.appendChild(tr);
      OUTPUT_GROUP_ROWS.push({ start: start, path: path });
    }

    for (let n = 1; n <= X32_OUTPUTS; n++) {
      if ((n - 1) % 4 === 0) groupHeader(n);
      const id = outputPad(n);
      const srcPath = "/outputs/main/" + id + "/src";
      const modePath = "/outputs/main/" + id + "/pos";
      const userOutPath = "/config/userrout/out/" + id;

      const out = sourcePicker(OUTPUT_SOURCE_SECTIONS, "Output source of row " + n);
      const userOut = sourcePicker(USER_OUT_SECTIONS, "User Out source of row " + n);

      const mode = document.createElement("select");
      mode.className = "route-select route-select--mode";
      mode.setAttribute("aria-label", "Mode of output " + n);
      OUTPUT_MODES.forEach(function (m) {
        const op = document.createElement("option");
        op.value = String(m.value);
        op.textContent = m.label;
        mode.appendChild(op);
      });
      /* Mismo tap por defecto que la matriz hasta que la consola publique /pos. */
      mode.value = String(outDefaultTap());

      const tr = document.createElement("tr");
      tr.className = "route-row";
      tr.dataset.out = id;

      const sourceCell = document.createElement("td");
      sourceCell.className = "route-source-cell";
      const sourceWrap = document.createElement("div");
      sourceWrap.className = "route-source";
      const sourceLabel = routeLabel("", "Out " + id + " source", { hideNumber: true });
      sourceWrap.appendChild(out.el);
      sourceWrap.appendChild(sourceLabel.el);
      sourceCell.appendChild(sourceWrap);

      const userOutCell = document.createElement("td");
      userOutCell.className = "route-userout-cell";
      const userOutWrap = document.createElement("div");
      userOutWrap.className = "route-source route-source--userout";
      const userOutDirect = document.createElement("span");
      userOutDirect.className = "route-tag route-tag--userout";
      const userOutVia = document.createElement("span");
      userOutVia.className = "route-tag";
      userOutWrap.appendChild(userOut.el);
      userOutWrap.appendChild(userOutDirect);
      userOutWrap.appendChild(userOutVia);
      userOutCell.appendChild(userOutWrap);

      const outCell = document.createElement("td");
      outCell.className = "route-output-cell";
      const outName = document.createElement("span");
      outName.className = "route-out";
      outName.textContent = "Out " + id;
      const outDirect = document.createElement("span");
      outDirect.className = "route-tag route-tag--out";
      const outIndirect = document.createElement("span");
      outIndirect.className = "route-tag route-tag--via";
      outCell.appendChild(outName);
      outCell.appendChild(outDirect);
      outCell.appendChild(outIndirect);

      const modeCell = document.createElement("td");
      modeCell.className = "route-mode-cell";
      modeCell.appendChild(mode);

      tr.appendChild(sourceCell);
      tr.appendChild(userOutCell);
      tr.appendChild(outCell);
      tr.appendChild(modeCell);
      table.appendChild(tr);

      const row = {
        n: n,
        tr: tr,
        sourceCell: sourceCell,
        userOutCell: userOutCell,
        modeCell: modeCell,
        outDirect: outDirect,
        outIndirect: outIndirect,
        userOutDirect: userOutDirect,
        userOutVia: userOutVia,
      };
      OUTPUT_LIST_ROWS.push(row);

      let sourceKey = null;
      function applySource(value) {
        const info = outSourceInfo(value);
        /* /outputs/main/NN/src puede repetirse (snapshot o /xremote). Sólo
           reenlazamos cuando cambia la fuente; si no, el nombre real recibido
           por OSC volvería al nombre de reserva. */
        const key = [
          info.label, info.detail, info.namePath, info.colorPath,
          info.seedName, info.seedColor,
        ].join("|");
        if (key !== sourceKey) {
          sourceKey = key;
          /* Main/Off no tienen nombre en la consola: mostramos su rótulo.
             Buses y canales dejan el hueco para el nombre real por OSC. */
          sourceLabel.setFallback(info.namePath ? "" : info.label, info.detail);
          sourceLabel.bind(info.namePath, info.colorPath, info.seedName, info.seedColor);
        }
        const k = parseInt(value, 10);
        if (isFinite(k)) out.setValue(k);
      }
      out.onChange(function (v) {
        CueDesk.OSC.send(srcPath, v, "i", { commit: true });
        applySource(v);
        refreshOutputLayers();
      });
      applySource(null);
      CueDesk.OSC.on(srcPath, function (v) {
        applySource(v);
        refreshOutputLayers();
      });

      function applyUserOut(value) {
        const k = parseInt(value, 10);
        const safe = isFinite(k) ? k : 0;
        USER_OUT_VALUES.set(n, safe);
        userOut.setValue(safe);
        refreshOutputLayers();
      }
      userOut.onChange(function (v) {
        CueDesk.OSC.send(userOutPath, v, "i", { commit: true });
        applyUserOut(v);
      });
      applyUserOut(0);
      CueDesk.OSC.on(userOutPath, applyUserOut);

      mode.addEventListener("change", function () {
        CueDesk.OSC.send(modePath, parseInt(mode.value, 10), "i", { commit: true });
      });
      CueDesk.OSC.on(modePath, function (v) {
        const k = parseInt(v, 10);
        if (isFinite(k)) mode.value = String(k);
      });
    }

    const wrap = document.createElement("div");
    wrap.className = "route-scroll";
    wrap.appendChild(table);
    box.appendChild(wrap);
    refreshOutputLayers();
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
    const base = 66 + 2 * (i - 1);
    OUT_COLS.push({ value: base, group: "Dir FX", label: i + "L", verifiedFrom: i <= 3 ? "main" : undefined, unverified: i > 3 });
    OUT_COLS.push({ value: base + 1, group: "Dir FX", label: i + "R", verifiedFrom: i <= 3 ? "main" : undefined, unverified: i > 3 });
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

  /* Leyenda de la matriz: los mismos colores que las p├¡ldoras (anillo = tap
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
    box.title = "Anillo = tap normal ┬À relleno = tap + Mute";
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
    b.title = "Output " + row.id + " ÔåÉ " + (c.group ? c.group + " " : "") + c.label + (extra.length ? " (" + extra.join(", ") + ")" : "");
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
     vertical; en pantallas t├íctiles se conserva un objetivo c├│modo. */
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

    /* Ajuste fino medido: la estimaci├│n no ve m├írgenes ni la barra del cuerpo,
       as├¡ que se corrige con lo que realmente desborda. */
    for (let guard = 0; guard < 4 && r > minR; guard++) {
      const over = body.scrollHeight - body.clientHeight;
      if (over <= 0) break;
      r = Math.max(minR, r - Math.max(1, Math.ceil(over / dataRows)));
      grid.style.setProperty("--out-row-h", r + "px");
    }
  }

  function renderOutGrid(box) {
    MATRIX_ROWS.length = 0;
    const rows = [];
    for (let n = 1; n <= 16; n++) {
      const id = String(n).padStart(2, "0");
      rows.push({
        n: n,
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

    /* --- Columna fija: destino + Phase. Vive fuera del ├írea que se desplaza,
       as├¡ nunca se pierde al hacer scroll horizontal. --- */
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
    /* Espacio duro: sin contenido la fila medir├¡a 9 px en vez de 25,8 y las
       dos tablas dejar├¡an de alinearse. */
    fhead2a.textContent = "\u00A0";
    const fhead2b = document.createElement("th");
    fhead2b.textContent = "\u00A0";
    fhead2.appendChild(fhead2a);
    fhead2.appendChild(fhead2b);
    ftable.appendChild(fhead2);

    /* --- Matriz de fuentes: aqu├¡ s├¡ se desplaza en horizontal --- */
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
      const liveDot = document.createElement("span");
      liveDot.className = "out-live-dot";
      liveDot.hidden = true;
      const fthText = document.createElement("span");
      fthText.textContent = "Out " + row.id;
      fth.appendChild(liveDot);
      fth.appendChild(fthText);
      ftr.appendChild(fth);

      const tdPol = document.createElement("td");
      const pol = document.createElement("button");
      pol.type = "button";
      pol.className = "route-cell route-cell--pol";
      pol.title = "Polaridad ÔÇö " + row.invPath;
      pol.addEventListener("click", function () {
        row.inv = row.inv ? 0 : 1;
        markOut(row);
        CueDesk.OSC.send(row.invPath, row.inv, "i", { commit: true });
      });
      tdPol.appendChild(pol);
      ftr.appendChild(tdPol);
      row.pol = pol;
      MATRIX_ROWS.push({ n: row.n, liveDot: liveDot, rowHead: fth });
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

    /* Selector y r├│tulo: el texto queda a la derecha del desplegable */
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
    refreshMatrixLayers();
  }

  function initRouting() {
    const globalBox = document.querySelector('[data-routing-render="global"]');
    if (globalBox) renderGlobal(globalBox);
    const inBox = document.querySelector('[data-routing-render="inputs"]');
    if (inBox) renderInputList(inBox);
    const physicalBox = document.querySelector('[data-routing-render="outputs-physical"]');
    if (physicalBox) renderOutputsPhysical(physicalBox);
    const listBox = document.querySelector('[data-routing-render="outputs-list"]');
    if (listBox) renderOutputList(listBox);
    const matrixBox = document.querySelector('[data-routing-render="outputs-matrix"]');
    if (matrixBox) renderOutGrid(matrixBox);
    refreshXlrUi();
    window.addEventListener("resize", queueOutFit);

    const outViews = Array.prototype.slice.call(document.querySelectorAll("[data-outputs-view]"));
    outViews.forEach(function (btn) {
      btn.addEventListener("click", function () {
        const view = btn.dataset.outputsView;
        outViews.forEach(function (b) {
          const on = b === btn;
          b.classList.toggle("is-active", on);
          b.setAttribute("aria-pressed", on ? "true" : "false");
        });
        listBox.hidden = view !== "list";
        matrixBox.hidden = view !== "matrix";
        if (view === "matrix") fitOutGrid();
      });
    });

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
        if (key === "outputs") fitOutGrid();
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
     (bloques de 8 canales) pero sin "Global options". En la cabecera, a la
     derecha, va el conmutador de BusGuard (encendido o no). Por canal:
     StageGuard y PreGuard (un botón cada uno: cian apagado; ámbar y verde
     encendidos) encima del conmutador RMS/LUFS —en el sitio del 48V— y
     desplegable de umbral —con "Off" en ambas escalas— en el del Ø. Modo y
     umbral son preferencias locales (localStorage, aún sin enviar);
     StageGuard y PreGuard sí llegan al backend, uno por canal. */
  const GG_KEY = "cuedesk.gainguard";
  /** Plazo de la pausa REARM, en ms: la interfaz lo pide y el motor lo impone. */
  const GG_REARM_MS = 20000;
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
        return {
          mode: mode,
          opt: opt,
          stage: !!(c && c.stage),
          pre: !!(c && c.pre),
          src: c && PREAMP_SOURCE_IDS.indexOf(c.src) >= 0 ? c.src : "local",
        };
      }),
    };
  }

  function ggSave(state) {
    try {
      localStorage.setItem(GG_KEY, JSON.stringify(state));
    } catch (_) {}
  }

  /* StageGuard por canal: sólo llega al backend cuando el usuario lo cambia. */
  function ggPushStage(index, on) {
    if (typeof fetch !== "function") return;
    fetch("/api/gainguard/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        channels: [{ id: "ch." + String(index + 1).padStart(2, "0"), stage: { enabled: !!on } }],
      }),
    }).catch(function () {});
  }

  /* PreGuard por canal: mismo criterio, sólo llega al backend al cambiarlo. */
  function ggPushPre(index, on) {
    if (typeof fetch !== "function") return;
    fetch("/api/gainguard/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        channels: [{ id: "ch." + String(index + 1).padStart(2, "0"), pre: { enabled: !!on } }],
      }),
    }).catch(function () {});
  }

  /* Banco de previos de un bloque de 8 canales (Local, Net Primary, Net Secondary): las
     guardas pasan a apuntar al `/headamp` de ese banco. */
  function ggPushSource(startIndex, source, count) {
    if (typeof fetch !== "function") return;
    const channels = [];
    for (let k = 0; k < count; k++) {
      channels.push({
        id: "ch." + String(startIndex + k + 1).padStart(2, "0"),
        source: source,
      });
    }
    fetch("/api/gainguard/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ channels: channels }),
    }).catch(function () {});
  }

  /* Al arrancar se sincronizan los 32 canales en una sola petición (StageGuard
     y PreGuard). El motor arranca todo apagado (no persiste entre reinicios),
     pero la pantalla es la referencia: si un canal quedó activo de una sesión
     anterior, se manda tal cual, y si no, se apaga también en el backend. */
  function ggPushChannelSync(state) {
    if (typeof fetch !== "function") return;
    const channels = state.ch.map(function (c, i) {
      return {
        id: "ch." + String(i + 1).padStart(2, "0"),
        stage: { enabled: !!c.stage },
        pre: { enabled: !!c.pre },
        source: c.src,
      };
    });
    fetch("/api/gainguard/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ channels: channels }),
    }).catch(function () {});
  }

  /* El interruptor BusGuard sólo llega al backend cuando el usuario lo
     cambia: abrir el panel no activa nada. Si el backend no responde, el
     interruptor sigue en local. */
  function ggPushBusGuard(on) {
    if (typeof fetch !== "function") return;
    fetch("/api/gainguard/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bus: { enabled: !!on } }),
    }).catch(function () {});
  }

  /* ------------------------------------------------- REARM (pausa de GG) */

  /* El botón REARM pausa la automatización de GainGuard un plazo fijo y la deja
     rearmarse sola: ni fader, ni previo, ni buses. La configuración de los
     canales no se toca (guardas, umbrales, referencias y desplazamientos siguen
     intactos). El reloj autoritativo vive en @cuedesk/core
     (`GET /api/gainguard/rearm`): la interfaz sólo dibuja la cuenta atrás y se
     resincroniza al abrir el panel, por si la página se recargó a mitad. */
  let ggRearmTimer = null;

  function ggRearmPaint(remainingMs) {
    const btn = document.querySelector('[data-action="gg-rearm"]');
    const label = document.querySelector("[data-gg-rearm-label]");
    if (!btn || !label) return;
    const held = remainingMs > 0;
    const secs = Math.ceil(remainingMs / 1000);
    btn.classList.toggle("is-held", held);
    btn.setAttribute("aria-pressed", held ? "true" : "false");
    label.textContent = held ? "REARM (" + secs + "s)" : "REARM";
    btn.title = held
      ? "GainGuard en pausa: vuelve sola en " + secs + " s"
      : "Pausa GainGuard " + GG_REARM_MS / 1000 + " s (vuelve sola)";
  }

  function ggRearmStop() {
    if (ggRearmTimer === null) return;
    clearInterval(ggRearmTimer);
    ggRearmTimer = null;
  }

  /* Cuenta atrás desde `fromMs`. Al llegar a 0 el motor ya se ha rearmado solo:
     no hay nada que enviar. */
  function ggRearmCountdown(fromMs) {
    ggRearmStop();
    const remaining = Math.max(0, fromMs);
    ggRearmPaint(remaining);
    if (remaining <= 0) return;
    const until = Date.now() + remaining;
    ggRearmTimer = setInterval(function () {
      const left = until - Date.now();
      ggRearmPaint(left > 0 ? left : 0);
      if (left <= 0) ggRearmStop();
    }, 250);
  }

  /* Clic en REARM: arranca la pausa en el motor y su cuenta atrás. */
  function ggRearmStart() {
    if (typeof fetch !== "function") {
      ggRearmCountdown(GG_REARM_MS);
      return;
    }
    fetch("/api/gainguard/rearm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ms: GG_REARM_MS }),
    })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (state) {
        const left = state && Number.isFinite(state.remainingMs) ? state.remainingMs : GG_REARM_MS;
        ggRearmCountdown(left);
      })
      .catch(function () { ggRearmCountdown(GG_REARM_MS); });
  }

  /* Resincroniza con el motor al abrir el panel: si una pausa sigue viva tras
     una recarga, la cuenta atrás continúa donde iba. */
  function ggRearmSync() {
    if (typeof fetch !== "function") return;
    fetch("/api/gainguard/rearm")
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (state) {
        if (!state) return;
        ggRearmCountdown(Number.isFinite(state.remainingMs) ? state.remainingMs : 0);
      })
      .catch(function () {});
  }

  function ggStrip(ch, index, save) {
    const pad = String(index + 1).padStart(2, "0");
    const strip = document.createElement("div");
    strip.className = "setup__strip";

    /* StageGuard (encima del conmutador RMS/LUFS): un solo botón por canal.
       Apagado en cian, encendido en ámbar. */
    const stageBtn = document.createElement("button");
    stageBtn.type = "button";
    stageBtn.className = "gg-stagebtn";
    stageBtn.textContent = "StageGuard";
    stageBtn.setAttribute("aria-label", "StageGuard · canal " + pad);
    stageBtn.addEventListener("click", function () {
      ch.stage = !ch.stage;
      syncStage();
      save();
      ggPushStage(index, ch.stage);
    });

    function syncStage() {
      stageBtn.classList.toggle("is-on", !!ch.stage);
      stageBtn.setAttribute("aria-pressed", ch.stage ? "true" : "false");
    }

    /* PreGuard (debajo de StageGuard): protege el conversor A/D bajando el
       previo cuando la señal sostenida roza el techo. Apagado en cian,
       encendido en verde. */
    const preBtn = document.createElement("button");
    preBtn.type = "button";
    preBtn.className = "gg-prebtn";
    preBtn.textContent = "PreGuard";
    preBtn.setAttribute("aria-label", "PreGuard · canal " + pad);
    preBtn.addEventListener("click", function () {
      ch.pre = !ch.pre;
      syncPre();
      save();
      ggPushPre(index, ch.pre);
    });

    function syncPre() {
      preBtn.classList.toggle("is-on", !!ch.pre);
      preBtn.setAttribute("aria-pressed", ch.pre ? "true" : "false");
    }

    /* Respiro entre las guardas y el selector RMS/LUFS, con la rúbrica
       "GainGuard Select" para que el bloque de medida no se amontone. */
    const sep = document.createElement("div");
    sep.className = "gg-sep";
    sep.textContent = "GainGuard Select";

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
    syncStage();
    syncPre();
    strip.appendChild(stageBtn);
    strip.appendChild(preBtn);
    strip.appendChild(sep);
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

    /* BusGuard (cabecera): el mismo conmutador que los canales, pero uno
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
        ggPushBusGuard(on);
      });
    });
    if (monSw) syncMon();

    /* Cuatro vistas (bloques de 8 canales) y doce opciones en el selector:
       cada banco de previos (Local, Net Primary, Net Secondary) con sus cuatro bloques.
       Elegir una opción muestra ese bloque y fija el banco de sus 8 canales,
       que es a qué /headamp apuntan las guardas. */
    for (let bi = 0; bi < 4; bi++) {
      const view = document.createElement("div");
      view.className = "setup__strips";
      view.hidden = bi !== 0;
      for (let k = 0; k < 8; k++) {
        const index = bi * 8 + k;
        view.appendChild(ggStrip(state.ch[index], index, save));
      }
      box.appendChild(view);
      blocks.push(view);
    }

    PREAMP_BLOCKS.forEach(function (b, i) {
      const op = document.createElement("option");
      op.value = String(i);
      op.textContent = b.label;
      pick.appendChild(op);
    });

    function setBlockSource(block, source) {
      let changed = false;
      for (let k = 0; k < 8; k++) {
        const c = state.ch[block * 8 + k];
        if (c.src !== source) {
          c.src = source;
          changed = true;
        }
      }
      if (!changed) return;
      save();
      ggPushSource(block * 8, source, 8);
    }

    pick.addEventListener("change", function () {
      const b = PREAMP_BLOCKS[Number(pick.value)];
      blocks.forEach(function (v, i) {
        v.hidden = i !== b.block;
      });
      setBlockSource(b.block, b.source);
    });

    /* Al abrir, el selector refleja el banco del primer bloque. */
    let initial = 0;
    for (let i = 0; i < PREAMP_BLOCKS.length; i++) {
      if (PREAMP_BLOCKS[i].block === 0 && PREAMP_BLOCKS[i].source === state.ch[0].src) {
        initial = i;
        break;
      }
    }
    pick.value = String(initial);
  }

  function initGainGuard() {
    const btn = document.querySelector('[data-action="gainguard"]');
    const panel = document.getElementById("gg-panel");
    if (!btn || !panel) return;

    renderGainGuard();
    ggPushChannelSync(ggLoad());

    function setOpen(open) {
      panel.hidden = !open;
      btn.classList.toggle("is-active", open);
      btn.setAttribute("aria-expanded", open ? "true" : "false");
      /* Al abrir, la cuenta atrás se resincroniza con el motor: así una pausa
         en curso sobrevive a una recarga de la página. */
      if (open) ggRearmSync();
    }

    btn.addEventListener("click", function () {
      setOpen(panel.hidden);
    });

    /* El botón REARM sustituye al antiguo cierre: pausa la automatización y
       vuelve sola. Cerrar la pantalla sigue disponible con Esc o cambiando de
       vista principal. */
    const rearmBtn = panel.querySelector('[data-action="gg-rearm"]');
    if (rearmBtn) rearmBtn.addEventListener("click", ggRearmStart);

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
