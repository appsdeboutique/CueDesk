/* ==========================================================================
 * CueDesk — osc.js
 * Bus OSC (semántica Behringer X32) + utilidades de conversión dB.
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

/* ------------------------------------------------------------ Bus OSC */

CueDesk.OSC = (function () {
  const dB = CueDesk.dB;

  /** Suscriptores por ruta (registro compartido con CueDesk.Controls). */
  const listeners = new Map();

  /** Transporte WebSocket real (opcional). Ej.: CueDesk.OSC.connect("ws://…") */
  let transport = null;

  /** Log de mensajes salientes hacia la consola. */
  let debug = true;

  const lastSent = new Map();
  const trailing = new Map();

  function emit(path, value, type) {
    if (debug) console.debug("[OSC → X32]", path, value, "," + type);

    if (transport && transport.readyState === 1) {
      try {
        transport.send(JSON.stringify({ path: path, value: value, type: type }));
      } catch (err) {
        console.warn("[OSC] transport send failed:", err);
      }
    }

    document.dispatchEvent(
      new CustomEvent("cuedesk:osc-out", {
        detail: { path: path, value: value, type: type },
      })
    );
  }

  /**
   * Envío hacia la consola.
   * @param {string} path   p.ej. "/ch/01/mix/fader"
   * @param {*}      value  float 0…1 / int / string
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

  /** Recibido desde la consola (WebSocket entrante). */
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

  /**
   * Conecta un WebSocket y lo enlaza con el bus.
   * Mensajes esperados: JSON { "path": "/ch/01/mix/fader", "value": 0.75 }
   */
  function connect(url) {
    const ws = new WebSocket(url);
    ws.addEventListener("open", function () {
      document.body.classList.add("is-online");
    });
    ws.addEventListener("close", function () {
      document.body.classList.remove("is-online");
    });
    ws.addEventListener("message", function (ev) {
      try {
        const msg = JSON.parse(ev.data);
        if (msg && msg.path !== undefined) receive(msg.path, msg.value);
      } catch (err) {
        console.warn("[OSC] mensaje no parseable:", ev.data);
      }
    });
    transport = ws;
    return ws;
  }

  return {
    send: send,
    receive: receive,
    on: on,
    connect: connect,
    flush: flush,
    get transport() {
      return transport;
    },
    set debug(v) {
      debug = !!v;
    },
    get debug() {
      return debug;
    },
  };
})();
