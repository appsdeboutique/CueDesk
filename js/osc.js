/* ==========================================================================
 * CueDesk — osc.js
 * ----------------------------------------------------------------------------
 * BUS DE MENSAJES (semántica Behringer X32). Este módulo NO hace red:
 * sólo publica/suscribe valores por ruta OSC. El transporte (WebSocket,
 * JSON, reconexiones) vive aislado en js/websocketClient.js.
 *
 *   salida: CueDesk.OSC.send(path, value, type)
 *             → throttle + evento document "cuedesk:osc-out"
 *             → websocketClient.js lo serializa {action:"osc_send", …}
 *   entrada: websocketClient.js llama a CueDesk.OSC.receive(path, value)
 *             → notifica a los suscriptores (faders, mute, vúmetros…)
 *
 * Rutas de referencia (X32 OSC Remote Protocol + protocolo no oficial X32/M32):
 *   /ch/01/mix/fader    level [0.0 … 1.0 (+10 dB), 1024]  (float)
 *   /ch/01/mix/on       enum  {OFF, ON} → 0 = Mute/Apagado, 1 = Activo (int)
 *   /ch/01/mix/pan      linf  [-100 … +100, 2]            (float, L-R)
 *   /main/st/mix/fader  level [0.0 … 1.0 (+10 dB), 1024]  (float)
 *
 * Conversión fader↔dB oficial del apéndice X32:
 *   0.0000 … 0.0625 → -90 … -60 dB     0.0625 … 0.2500 → -60 … -30 dB
 *   0.2500 … 0.5000 → -30 … -10 dB     0.5000 … 1.0000 → -10 … +10 dB
 * ========================================================================== */

window.CueDesk = window.CueDesk || {};

/* ---------------------------------------------------------------- dB utils */

CueDesk.dB = (function () {
  function clamp01(v) {
    return v < 0 ? 0 : v > 1 ? 1 : v;
  }

  /** Float X32 (0…1) → decibelios. 0 = -inf. */
  function fromFader(f) {
    f = clamp01(f);
    if (f <= 0) return -Infinity;
    if (f <= 0.0625) return f * 480 - 90;
    if (f <= 0.25) return f * 160 - 70;
    if (f <= 0.5) return f * 80 - 50;
    return f * 40 - 30;
  }

  /** Decibelios → float X32 (0…1). */
  function toFader(db) {
    if (db === -Infinity || db <= -90) return 0;
    if (db <= -60) return (db + 90) / 480;
    if (db <= -30) return (db + 70) / 160;
    if (db <= -10) return (db + 50) / 80;
    if (db <= 10) return (db + 30) / 40;
    return 1;
  }

  /** "+0.7" / "-6.0" / "-inf" */
  function fmt(db) {
    if (!isFinite(db)) return "-∞";
    let v = db;
    if (Math.abs(v) < 0.05) v = 0;
    return (v >= 0 ? "+" : "-") + Math.abs(v).toFixed(1);
  }

  /** Talkback: "-00", "+04", "-12" */
  function fmtTalk(db) {
    if (!isFinite(db)) return "-∞";
    const v = Math.round(db);
    return (v > 0 ? "+" : "-") + String(Math.abs(v)).padStart(2, "0");
  }

  /** Pan (-100…100) → "C" / "L24" / "R36" */
  function fmtPan(osc) {
    const v = Math.round(osc);
    if (v === 0) return "C";
    return v < 0 ? "L" + Math.abs(v) : "R" + v;
  }

  return { clamp01, fromFader, toFader, fmt, fmtTalk, fmtPan };
})();

/* ---------------------------------------------------------------- Bus OSC */

CueDesk.OSC = (function () {
  "use strict";

  /** Suscriptores por ruta. */
  const listeners = new Map();

  /** true → traza las salidas (desactivable: CueDesk.OSC.debug = false). */
  let debug = true;

  const lastSent = new Map();
  const trailing = new Map();

  /** Salida al bus: traza + evento que captura la capa de transporte. */
  function emit(path, value, type) {
    if (debug) console.debug("[OSC out]", path, value, "," + type);

    document.dispatchEvent(
      new CustomEvent("cuedesk:osc-out", {
        detail: { path: path, value: value, type: type },
      })
    );
  }

  /**
   * Publica un cambio de la UI en el bus.
   * @param {string} path   p.ej. "/ch/01/mix/fader"
   * @param {*}      value  float 0…1 / int / string / array
   * @param {string} type   "f" | "i" | "s"
   * @param {object} opts   { throttle: ms (default 40), commit: bool }
   */
  function send(path, value, type, opts) {
    if (!path) return;
    type = type || "f";
    opts = opts || {};

    if (opts.commit || !opts.throttle) {
      flush(path);
      lastSent.set(path, performance.now());
      emit(path, value, type);
      return;
    }

    const now = performance.now();
    const prev = lastSent.get(path) || 0;
    const wait = opts.throttle - (now - prev);

    if (wait <= 0) {
      lastSent.set(path, now);
      emit(path, value, type);
      return;
    }

    // Escalonado: garantiza un último mensaje con el valor final.
    if (trailing.has(path)) clearTimeout(trailing.get(path).timer);
    const entry = {
      value: value,
      type: type,
      timer: setTimeout(function () {
        trailing.delete(path);
        lastSent.set(path, performance.now());
        emit(path, value, type);
      }, wait),
    };
    trailing.set(path, entry);
  }

  function flush(path) {
    const entry = trailing.get(path);
    if (entry) {
      clearTimeout(entry.timer);
      trailing.delete(path);
    }
  }

  /**
   * Entrada al bus (la llama la capa de transporte con el valor ya parseado).
   * @param {string} path
   * @param {*}      value  escalar o array (vúmetros)
   */
  function receive(path, value) {
    const subs = listeners.get(path);
    if (subs) {
      subs.forEach(function (fn) {
        try {
          fn(value, path);
        } catch (err) {
          console.error("[OSC] handler error en", path, err);
        }
      });
    }
    document.dispatchEvent(
      new CustomEvent("cuedesk:osc-in", { detail: { path: path, value: value } })
    );
  }

  function on(path, fn) {
    if (!listeners.has(path)) listeners.set(path, new Set());
    listeners.get(path).add(fn);
    return function off() {
      const subs = listeners.get(path);
      if (!subs) return;
      subs.delete(fn);
      if (!subs.size) listeners.delete(path);
    };
  }

  return {
    send: send,
    receive: receive,
    on: on,
    flush: flush,
    set debug(v) { debug = !!v; },
    get debug() { return debug; },
  };
})();
