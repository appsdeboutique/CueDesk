/* ==========================================================================
 * CueDesk — controls.js
 * Controlador de faders / deslizadores (ratón, táctil, rueda y teclado).
 * Soporta orientación vertical y horizontal, snap, reset con doble clic,
 * envío OSC con throttle y suscripción a cambios remotos de la consola.
 * ========================================================================== */

window.CueDesk = window.CueDesk || {};

CueDesk.Controls = (function () {
  const dB = CueDesk.dB;
  const OSC = CueDesk.OSC;

  const instances = new Set();

  function resolveEl(ref, fallbackRoot) {
    if (!ref) return null;
    if (typeof ref === "string") return document.querySelector(ref);
    if (ref.nodeType === 1) return ref;
    return fallbackRoot || null;
  }

  class Slider {
    constructor(el, opts) {
      this.el = el;
      this.opts = Object.assign(
        {
          orientation: el.dataset.slider === "horizontal" ? "horizontal" : "vertical",
          path: el.getAttribute("data-osc-path") || null,
          type: el.getAttribute("data-osc-type") || "f",
          throttle: 40,
          toOsc: function (v) { return v; },
          fromOsc: function (v) {
            const n = typeof v === "number" ? v : parseFloat(v);
            return isFinite(n) ? n : 0;
          },
          display: null,
          readout: null,
          reset: 0.5,
          snap: 0,
        },
        opts || {}
      );

      this.norm = 0;
      this.dragging = false;
      this._unsub = null;

      // Elementos internos
      this.track =
        el.querySelector(".fader__travel") ||
        el.querySelector(".hslider__track") ||
        el;

      // Readout asociado (ej. el valor en dB bajo el fader)
      this.readout = resolveEl(this.opts.readout);

      // ARIA
      el.setAttribute("role", "slider");
      el.setAttribute("tabindex", "0");
      el.setAttribute("aria-orientation", this.opts.orientation);
      el.setAttribute("aria-valuemin", "0");
      el.setAttribute("aria-valuemax", "1");

      // Eventos (bound para poder desmontarlos)
      this._onDown = this._onDown.bind(this);
      this._onMove = this._onMove.bind(this);
      this._onUp = this._onUp.bind(this);
      this._onKey = this._onKey.bind(this);
      this._onWheel = this._onWheel.bind(this);

      el.addEventListener("pointerdown", this._onDown);
      el.addEventListener("pointermove", this._onMove);
      el.addEventListener("pointerup", this._onUp);
      el.addEventListener("pointercancel", this._onUp);
      el.addEventListener("keydown", this._onKey);
      el.addEventListener("wheel", this._onWheel, { passive: false });
      el.addEventListener("dblclick", this._onReset.bind(this));

      el.__slider = this;
      instances.add(this);

      if (this.opts.path) this._subscribe(this.opts.path);

      const initial = typeof this.opts.value === "number" ? this.opts.value : 0;
      this.setValue(initial, { silent: true });
    }

    _subscribe(path) {
      if (this._unsub) this._unsub();
      this._unsub = null;
      if (!path) return;
      const self = this;
      this._unsub = OSC.on(path, function (value) {
        if (self.dragging) return; // no pisar un gesto local
        self.setValue(self.opts.fromOsc(value), { silent: true });
      });
    }

    setPath(path) {
      this.opts.path = path;
      this.el.setAttribute("data-osc-path", path || "");
      this.el.setAttribute("data-osc-address", path || "");
      this._subscribe(path);
    }

    /* --------------------------------------------------------- cambios */

    setValue(norm, opts) {
      opts = opts || {};
      norm = dB.clamp01(this.opts.snap ? Math.round(norm / this.opts.snap) * this.opts.snap : norm);
      this.norm = norm;

      this.el.style.setProperty("--v", norm);
      this.el.setAttribute("aria-valuenow", norm.toFixed(4));

      if (this.opts.display) {
        const text = this.opts.display(norm);
        this.el.setAttribute("aria-valuetext", text);
        if (this.readout) {
          this.readout.textContent = text;
          this.readout.classList.toggle("is-off", text === "-∞");
        }
      } else {
        this.el.setAttribute("aria-valuetext", norm.toFixed(2));
      }

      if (opts.silent) return;

      OSC.send(
        this.opts.path,
        this.opts.toOsc(norm),
        this.opts.type,
        { throttle: opts.commit ? 0 : this.opts.throttle, commit: opts.commit }
      );
    }

    /* -------------------------------------------------------- puntero */

    _seek(e) {
      const rect = this.track.getBoundingClientRect();
      let v;
      if (this.opts.orientation === "vertical") {
        v = 1 - (e.clientY - rect.top) / rect.height;
      } else {
        v = (e.clientX - rect.left) / rect.width;
      }
      this.setValue(v, { throttle: this.opts.throttle });
    }

    _onDown(e) {
      if (e.button !== undefined && e.button !== 0) return;
      e.preventDefault();
      try {
        this.el.setPointerCapture(e.pointerId);
      } catch (_) { /* noop */ }
      this.dragging = true;
      this.el.classList.add("is-dragging");
      this._seek(e);
      this.el.focus({ preventScroll: true });
    }

    _onMove(e) {
      if (!this.dragging) return;
      this._seek(e);
    }

    _onUp() {
      if (!this.dragging) return;
      this.dragging = false;
      this.el.classList.remove("is-dragging");
      // Valor final exacto (sin throttle)
      this.setValue(this.norm, { commit: true });
    }

    _onReset() {
      this.setValue(this.opts.reset, { commit: true });
    }

    _onWheel(e) {
      e.preventDefault();
      const delta = (e.deltaY < 0 ? 1 : -1) * (e.shiftKey ? 0.001 : 0.006);
      this.setValue(this.norm + delta, { throttle: this.opts.throttle });
    }

    _onKey(e) {
      const fine = e.shiftKey ? 0.001 : 0.01;
      let v = null;
      switch (e.key) {
        case "ArrowUp":
        case "ArrowRight":
          v = this.norm + fine;
          break;
        case "ArrowDown":
        case "ArrowLeft":
          v = this.norm - fine;
          break;
        case "PageUp":
          v = this.norm + 0.1;
          break;
        case "PageDown":
          v = this.norm - 0.1;
          break;
        case "Home":
          v = 0;
          break;
        case "End":
          v = 1;
          break;
        case " ":
          this._onReset();
          e.preventDefault();
          return;
        default:
          return;
      }
      e.preventDefault();
      this.setValue(v, { throttle: 60 });
    }

    destroy() {
      if (this._unsub) this._unsub();
      const el = this.el;
      el.removeEventListener("pointerdown", this._onDown);
      el.removeEventListener("pointermove", this._onMove);
      el.removeEventListener("pointerup", this._onUp);
      el.removeEventListener("pointercancel", this._onUp);
      el.removeEventListener("keydown", this._onKey);
      el.removeEventListener("wheel", this._onWheel);
      delete el.__slider;
      instances.delete(this);
    }
  }

  /* ------------------------------------------------------ displays (dB) */

  /** Fader de nivel: X32 float → dB de consola. */
  function displayDb(norm) {
    return dB.fmt(dB.fromFader(norm));
  }

  /** Modo GAIN aux: recorrido lineal -18…+18 dB (preamp/trim), paso 0.25.
      Los canales usan headamp (-12…+60) y su formato se compone en mixer.js. */
  function displayGain(norm) {
    return dB.fmtGain(-18 + norm * 36);
  }

  /** Talkback: "-00" / "+04" */
  function displayTalk(norm) {
    return dB.fmtTalk(dB.fromFader(norm));
  }

  /** Panorama: float X32 (-100…100) → "C" / "L24" / "R36" */
  function displayPan(norm) {
    return dB.fmtPan(norm * 200 - 100);
  }

  return {
    Slider: Slider,
    displayDb: displayDb,
    displayGain: displayGain,
    displayTalk: displayTalk,
    displayPan: displayPan,
    mount: function (el, opts) {
      return new Slider(el, opts);
    },
    destroyAll: function (root) {
      root
        .querySelectorAll("[data-slider]")
        .forEach(function (el) {
          if (el.__slider) el.__slider.destroy();
        });
    },
  };
})();
