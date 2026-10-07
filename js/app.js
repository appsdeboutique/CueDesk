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

  /* --------------------------------------------------------------- tabs */

  function initTabs() {
    const tabs = Array.prototype.slice.call(document.querySelectorAll(".tab"));
    tabs.forEach(function (tab) {
      tab.addEventListener("click", function () {
        tabs.forEach(function (t) {
          const active = t === tab;
          t.classList.toggle("is-active", active);
          t.setAttribute("aria-selected", active ? "true" : "false");
        });
        const view = tab.dataset.view;
        CueDesk.app.view = view;
        document.querySelectorAll("[data-view-panel]").forEach(function (panel) {
          panel.hidden = panel.dataset.viewPanel !== view;
        });
      });
    });
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
        toast(on ? "Gain view · preamp trim -18…+18 dB" : "Mix view · faders de nivel");
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
    initTabs();
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
