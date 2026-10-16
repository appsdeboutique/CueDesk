"use strict";

/* ==========================================================================
 * CueDesk — apps/cuebox · oscEngine.js
 * --------------------------------------------------------------------------
 * Transporte OSC de la app: el ÚNICO sitio del sistema que sabe qué es un
 * datagrama o un puerto. Implementa `ConsoleLink` y lo consume el driver
 * (@cuedesk/console-x32). El taper, las rutas y los bancos de previo NO están
 * aquí: eso es del driver; esto sólo codifica y mueve bytes.
 *
 *   send(path, value, type)  →  codifica OSC y lo envía por UDP a la consola
 *   on(path, fn)             →  recibe OSC de la consola (/meters/1, ecos…)
 *
 * Modos:
 *   "udp"      → envía de verdad (requiere --console <ip> o config)
 *   "dry-run"  → no toca la red: codifica y guarda las últimas tramas
 *
 * Cero dependencias: dgram y Buffer de Node.
 * ========================================================================== */

const dgram = require("dgram");

const OSC_PORT = 10023;      // puerto OSC de la X32 (igual que server.js)

/* --------------------------------------------------------------- codificar */

function pad4(n) {
  return (n + 3) & ~3;
}

function writeString(buf, offset, str) {
  const bytes = Buffer.from(str, "latin1");
  bytes.copy(buf, offset);
  buf.fill(0, offset + bytes.length, offset + pad4(bytes.length));
  return offset + pad4(bytes.length);
}

function tagFor(type) {
  return type === "i" ? "i" : type === "s" ? "s" : "f";
}

/**
 * Codifica un mensaje OSC.
 * @param {string} path
 * @param {Array<number|string>} args
 * @param {string} [type] "f" | "i" | "s" (para un único argumento)
 */
function encodeMessage(path, args, type) {
  const list = Array.isArray(args) ? args : [args];
  const typeOf = (v, i) => (i === 0 && type ? tagFor(type) : tagFor(typeof v === "number" ? "f" : "s"));
  const tags = "," + list.map(typeOf).join("");

  let size = pad4(Buffer.byteLength(path, "latin1") + 1) + pad4(tags.length + 1);
  list.forEach((v, i) => {
    size += typeOf(v, i) === "s" ? pad4(Buffer.byteLength(String(v), "latin1") + 1) : 4;
  });

  const buf = Buffer.alloc(size);
  let o = writeString(buf, 0, path);
  o = writeString(buf, o, tags);
  list.forEach((v, i) => {
    const t = typeOf(v, i);
    if (t === "s") {
      o = writeString(buf, o, String(v));
    } else if (t === "i") {
      buf.writeInt32BE(Math.round(Number(v)) | 0, o);
      o += 4;
    } else {
      buf.writeFloatBE(Number(v), o);
      o += 4;
    }
  });
  return buf;
}

/** Decodifica un mensaje OSC → { path, args } (sólo f/i/s). */
function parseMessage(buf) {
  let i = 0;
  function readStr() {
    const start = i;
    while (i < buf.length && buf[i] !== 0) i++;
    const s = buf.toString("latin1", start, i);
    i = pad4(i + 1);
    return s;
  }
  const path = readStr();
  const tags = readStr();
  const args = [];
  if (tags.startsWith(",")) {
    for (const t of tags.slice(1)) {
      if (i > buf.length) break;
      if (t === "s") args.push(readStr());
      else if (t === "i") {
        args.push(buf.readInt32BE(i));
        i += 4;
      } else if (t === "f") {
        args.push(buf.readFloatBE(i));
        i += 4;
      } else break;
    }
  }
  return { path: path, args: args };
}

/* ------------------------------------------------------------------ motor */

/**
 * @param {object} [opts]
 * @param {"udp"|"dry-run"} [opts.mode="dry-run"]
 * @param {string} [opts.host="192.168.1.10"]
 * @param {number} [opts.port=10023]
 * @param {number} [opts.listenPort]      puerto local para recibir de la consola
 * @param {number} [opts.coalesceMs=16]   ventana de coalescing por ruta
 * @param {number} [opts.keep=50]         tramas guardadas para diagnóstico
 */
function createOscEngine(opts) {
  const o = opts || {};
  const mode = o.mode === "udp" ? "udp" : "dry-run";
  const host = o.host || "192.168.1.10";
  const port = o.port || OSC_PORT;
  const coalesceMs = o.coalesceMs === undefined ? 16 : o.coalesceMs;
  const keep = o.keep || 50;

  const listeners = new Map();
  const pending = new Map();
  const recent = [];
  const stats = { sent: 0, dropped: 0, coalesced: 0, received: 0, errors: 0, lastError: null };

  let socket = null;
  let receiver = null;
  let boundPort = null;
  let flushTimer = null;

  function emitLocal(path, value, type) {
    const buf = encodeMessage(path, value, type);
    recent.push({ t: Date.now(), path: path, value: value, type: type, bytes: buf.length, wire: mode === "udp" });
    while (recent.length > keep) recent.shift();
    if (mode !== "udp") return;
    /* Si hay receptor abierto se envía DESDE él: así la consola responde al
       mismo puerto desde el que le hablamos (comportamiento de /xremote). */
    if (!receiver && !socket) {
      try {
        socket = dgram.createSocket("udp4");
      } catch (err) {
        stats.errors++;
        stats.lastError = err.message;
        return;
      }
    }
    const via = receiver || socket;
    via.send(buf, port, host, (err) => {
      if (err) {
        stats.errors++;
        stats.lastError = err.message;
      }
    });
  }

  function flushPending() {
    flushTimer = null;
    const now = Date.now();
    for (const [path, item] of pending) {
      const wait = coalesceMs - (now - item.firstAt);
      if (wait > 0) {
        if (!flushTimer) flushTimer = setTimeout(flushPending, wait);
        continue;
      }
      pending.delete(path);
      emitLocal(path, item.value, item.type);
    }
  }

  /** Salida: mismo contrato que CueDesk.OSC.send del frontend. */
  function send(path, value, type) {
    if (!path) return;
    stats.sent++;
    if (coalesceMs <= 0) {
      emitLocal(path, value, type || "f");
      return;
    }
    const item = pending.get(path);
    if (item) {
      item.value = value;         // last-value-wins dentro de la ventana
      item.type = type || item.type;
      stats.coalesced++;
      return;
    }
    pending.set(path, { value: value, type: type || "f", firstAt: Date.now() });
    if (!flushTimer) flushTimer = setTimeout(flushPending, coalesceMs);
  }

  /** Entrada: suscripción por ruta (prefijo si acaba en "*"). */
  function on(path, fn) {
    if (!listeners.has(path)) listeners.set(path, new Set());
    listeners.get(path).add(fn);
    return function off() {
      const set = listeners.get(path);
      if (set) set.delete(fn);
    };
  }

  function dispatch(msg) {
    stats.received++;
    listeners.forEach(function (set, pattern) {
      const hit = pattern.endsWith("*")
        ? msg.path.startsWith(pattern.slice(0, -1))
        : msg.path === pattern;
      if (!hit) return;
      set.forEach(function (fn) {
        try {
          fn(msg.args, msg.path);
        } catch (err) {
          stats.errors++;
          stats.lastError = err.message;
        }
      });
    });
  }

  return {
    send: send,
    on: on,

    /** Abre el puerto local para recibir de la consola (telemetría, ecos).
     *  `bind` es asíncrono: el puerto real sólo se conoce al emitir
     *  "listening". Pedir `address()` justo después de `bind` lanza EBADF. */
    listen(listenPort) {
      if (receiver) return boundPort;
      receiver = dgram.createSocket("udp4");
      receiver.on("message", function (buf) {
        try {
          dispatch(parseMessage(buf));
        } catch (err) {
          stats.errors++;
          stats.lastError = err.message;
        }
      });
      receiver.on("listening", function () {
        try {
          boundPort = receiver.address().port;
        } catch (_) {
          boundPort = null;
        }
      });
      receiver.on("error", function (err) {
        stats.errors++;
        stats.lastError = err.message;
      });
      receiver.bind(listenPort || o.listenPort || 0, "0.0.0.0");
      return null;
    },

    flush: flushPending,

    close() {
      if (flushTimer) clearTimeout(flushTimer);
      flushTimer = null;
      pending.clear();
      try {
        if (socket) socket.close();
      } catch (_) {}
      try {
        if (receiver) receiver.close();
      } catch (_) {}
      socket = null;
      receiver = null;
      boundPort = null;
    },

    status() {
      return {
        mode: mode,
        target: mode === "udp" ? host + ":" + port : null,
        listening: !!receiver,
        listenPort: boundPort,
        pending: pending.size,
        recent: recent.slice(-10),
        stats: stats,
      };
    },
  };
}

module.exports = {
  OSC_PORT,
  createOscEngine,
  encodeMessage,
  parseMessage,
};
