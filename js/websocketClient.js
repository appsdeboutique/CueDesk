/* ==========================================================================
 * CueDesk — websocketClient.js
 * ----------------------------------------------------------------------------
 * CAPA DE TRANSPORTE (desacoplada de la UI).
 *
 * Este módulo es el ÚNICO punto de la aplicación que sabe qué es una
 * conexión, una IP, un JSON o un reintento. La interfaz (app.js, mixer.js,
 * controls.js…) no hace red: habla con el bus OSC (js/osc.js) y este módulo
 * traduce ese bus <-> WebSocket.
 *
 *   UI  --(evento cuedesk:osc-out)-->  bus OSC  --(JSON)-->  WebSocket  --> Backend
 *   UI  <--(CueDesk.OSC.receive)----  bus OSC  <--(JSON)----  WebSocket  <-- Backend
 *
 * Paquete saliente (siempre esta forma):
 *   { "action": "osc_send", "address": "/ch/01/mix/fader", "args": [0.75] }
 *
 * Paquetes aceptados a la entrada (agnósticos, se parsean genéricamente):
 *   { "action": "osc_recv", "address": "/ch/01/mix/on", "args": [0] }
 *   { "address": "/ch/01/mix/pan", "args": [-24] }          (sin action)
 *   { "action": "meters", "address": "/meters/1", "args": [[L,R], …] }
 *   [ paquete1, paquete2, … ]                               (lote)
 *
 * Reconexión: backoff exponencial con jitter (600 ms → 30 s) + keepalive
 * (ping/latencia muerta), pensado para Wi-Fi saturada en directo.
 *
 * Configuración del endpoint (por orden de prioridad):
 *   1. ?ws=192.168.1.20            (query string, sólo esta sesión)
 *   2. localStorage["cuedesk.ws.url"]  (persistida desde el panel del header)
 *   3. window.CUEDESK_WS_URL       (inyectada por el proyecto que aloja la UI)
 *   4. ws://localhost:8080         (por defecto)
 *   "?ws=off" / "none" desactiva la auto-conexión.
 * ========================================================================== */

window.CueDesk = window.CueDesk || {};

CueDesk.WS = (function () {
  "use strict";

  const STORAGE_KEY = "cuedesk.ws.url";
  const DEFAULT_URL = "ws://localhost:8080";

  const BACKOFF = { base: 600, factor: 1.8, max: 30000, jitter: 0.25 };
  const HEARTBEAT_MS = 15000;   // ping periódico
  const IDLE_MS = 35000;        // sin entrada en N ms → enlace muerto → reconectar
  const QUEUE_MAX = 500;        // tope de la cola sin enlace (deduplicada por dirección)

  /* ------------------------------------------------------------- estado */

  let endpoint;                 // string | null (null = deshabilitado)
  let state = "idle";           // idle | connecting | online | reconnecting | offline
  let socket = null;
  let attempt = 0;
  let retryTimer = null;
  let beatTimer = null;
  let manualStop = false;
  let lastInbound = 0;
  let nextRetryAt = 0;

  const stats = { sent: 0, received: 0, queued: 0 };

  /** Cola de salida mientras no hay enlace. Último valor por dirección gana. */
  const outbox = new Map();

  /** Paquetes a reenviar tras cada apertura (suscripciones, etc.). */
  let onOpenPackets = [];

  /* ------------------------------------------------------------ helpers */

  function perfNow() {
    return typeof performance !== "undefined" && performance.now
      ? performance.now()
      : Date.now();
  }

  /** "192.168.1.20:8081" | "ws://…" | "off" → URL válida o null. */
  function normalizeUrl(raw) {
    if (raw === undefined || raw === null) return null;
    const s = String(raw).trim();
    if (!s || /^(off|none|disabled|0|false)$/i.test(s)) return null;
    if (/^wss?:\/\//i.test(s)) return s;
    if (/^\/\//.test(s)) return (location.protocol === "https:" ? "wss:" : "ws:") + s;
    return "ws://" + s;
  }

  function resolveUrl() {
    let raw = null;
    try {
      const q = new URLSearchParams(location.search).get("ws");
      if (q) raw = q;
      else raw = window.localStorage.getItem(STORAGE_KEY);
    } catch (_) { /* storage no disponible */ }
    if (!raw && window.CUEDESK_WS_URL) raw = window.CUEDESK_WS_URL;
    if (!raw) raw = DEFAULT_URL;
    return normalizeUrl(raw);
  }

  /** Notifica el estado a la capa de UI (que pinta el LED). */
  function setState(next, extra) {
    state = next;
    const detail = Object.assign(
      { state: next, url: endpoint || null, attempt: attempt, nextRetryAt: nextRetryAt },
      extra || {}
    );
    document.dispatchEvent(new CustomEvent("cuedesk:link", { detail: detail }));
  }

  function debug() {
    if (window.CueDesk.OSC && CueDesk.OSC.debug === false) return;
    console.debug.apply(console, ["[WS]"].concat(Array.prototype.slice.call(arguments)));
  }

  /* ------------------------------------------------------- serialización */

  /** Empaqueta y envía (o encola si no hay enlace). */
  function emit(packet) {
    if (!packet || !packet.address) return;
    if (state === "online" && socket && socket.readyState === 1) {
      write(packet);
      return;
    }
    // Sin enlace: deduplica por dirección (los faders se mueven muy rápido)
    if (outbox.has(packet.address)) outbox.delete(packet.address);
    outbox.set(packet.address, packet);
    while (outbox.size > QUEUE_MAX) {
      outbox.delete(outbox.keys().next().value);
    }
    stats.queued = outbox.size;
  }

  function write(packet) {
    try {
      socket.send(JSON.stringify(packet));
      stats.sent++;
      debug("→", packet.address, JSON.stringify(packet.args));
    } catch (err) {
      console.warn("[WS] no se pudo enviar:", err && err.message);
      emit(packet); // vuelve a la cola: se reenvía al reconectar
    }
  }

  function flush() {
    if (!outbox.size) return;
    const packets = Array.from(outbox.values());
    outbox.clear();
    stats.queued = 0;
    packets.forEach(write);
    debug("cola vaciada:", packets.length, "paquete(s)");
  }

  /* ------------------------------------------------------ deserialización */

  function onMessage(ev) {
    lastInbound = perfNow();
    stats.received++;
    const data = ev.data;
    if (typeof data !== "string") return; // el protocolo de CueDesk es JSON

    let msg;
    try {
      msg = JSON.parse(data);
    } catch (_) {
      debug("JSON no parseable:", String(data).slice(0, 160));
      return;
    }
    if (Array.isArray(msg)) msg.forEach(handlePacket);
    else handlePacket(msg);
  }

  /** Traduce un paquete genérico → bus OSC (la UI ya sabe interpretarlo). */
  function handlePacket(m) {
    if (!m || typeof m !== "object") return;

    const action = m.action;
    if (action === "pong" || action === "ping") return;         // keepalive
    if (action === "hello" || action === "status") {             // metadatos del backend
      document.dispatchEvent(new CustomEvent("cuedesk:link-info", { detail: m }));
      return;
    }

    const address = m.address || m.path;
    if (!address) return;

    let args = m.args !== undefined ? m.args : m.value;
    if (args === undefined || args === null) args = [];
    const value = Array.isArray(args)
      ? args.length === 0 ? null : args.length === 1 ? args[0] : args
      : args;

    debug("←", address, Array.isArray(value) ? "[" + value.length + " elems]" : value);
    CueDesk.OSC.receive(address, value);
  }

  /* ------------------------------------------------------------- ciclo */

  function openSocket() {
    if (state === "online" && manualStop) return;
    clearTimeout(retryTimer);
    retryTimer = null;

    if (typeof WebSocket === "undefined") {
      console.warn("[WS] este navegador no soporta WebSocket");
      setState("offline", { reason: "unsupported" });
      return;
    }
    if (!endpoint) {
      setState("offline", { reason: "disabled" });
      return;
    }

    setState(attempt === 0 ? "connecting" : "reconnecting");
    debug("conectando a", endpoint, attempt ? "(intento " + attempt + ")" : "");

    let s;
    try {
      s = new WebSocket(endpoint);
    } catch (err) {
      console.warn("[WS] endpoint inválido:", endpoint, err && err.message);
      scheduleRetry();
      return;
    }

    socket = s;
    s.addEventListener("open", function () {
      attempt = 0;
      nextRetryAt = 0;
      lastInbound = perfNow();
      setState("online");
      debug("enlace establecido con", endpoint);
      startHeartbeat();
      flush();
      onOpenPackets.forEach(write);
    });
    s.addEventListener("message", onMessage);
    s.addEventListener("error", function () {
      debug("error de transporte en", endpoint);
    });
    s.addEventListener("close", function (ev) {
      stopHeartbeat();
      socket = null;
      if (manualStop) {
        setState("offline", { reason: "manual", code: ev.code });
        return;
      }
      scheduleRetry();
    });
  }

  /** Reintento exponencial con jitter: 600 ms, 1.1 s, 1.9 s … hasta 30 s. */
  function scheduleRetry() {
    attempt++;
    const raw = Math.min(BACKOFF.max, BACKOFF.base * Math.pow(BACKOFF.factor, attempt - 1));
    const delay = Math.round(raw * (1 - BACKOFF.jitter + Math.random() * BACKOFF.jitter * 2));
    nextRetryAt = Date.now() + delay;
    setState("reconnecting", { delay: delay });
    debug("reintento #" + attempt + " en " + delay + " ms");
    retryTimer = setTimeout(openSocket, delay);
  }

  function startHeartbeat() {
    stopHeartbeat();
    beatTimer = setInterval(function () {
      if (!socket || socket.readyState !== 1) return;
      if (perfNow() - lastInbound > IDLE_MS) {
        debug("enlace mudo > " + IDLE_MS + " ms, forzando reconexión");
        try { socket.close(4000, "idle"); } catch (_) { /* noop */ }
        return;
      }
      try {
        socket.send(JSON.stringify({ action: "ping", t: Date.now() }));
      } catch (_) { /* noop */ }
    }, HEARTBEAT_MS);
  }

  function stopHeartbeat() {
    clearInterval(beatTimer);
    beatTimer = null;
  }

  function teardown() {
    clearTimeout(retryTimer);
    retryTimer = null;
    stopHeartbeat();
    if (socket) {
      try { socket.close(); } catch (_) { /* noop */ }
      socket = null;
    }
  }

  /* --------------------------------------------------------- API pública */

  /** Abre (o reabre) el enlace. `connect("192.168.1.20")` cambia el endpoint. */
  function connect(url) {
    if (url !== undefined) endpoint = normalizeUrl(url);
    else if (endpoint === undefined) endpoint = resolveUrl();
    manualStop = false;
    teardown();
    openSocket();
    return state;
  }

  /** Cierre intencionado: no habrá reconexiones automáticas. */
  function disconnect() {
    manualStop = true;
    attempt = 0;
    nextRetryAt = 0;
    teardown();
    setState("offline", { reason: "manual" });
    return state;
  }

  /** Fuerza un nuevo intento inmediato (botón "Conectar" / volver en línea). */
  function reconnect() {
    manualStop = false;
    attempt = 0;
    teardown();
    openSocket();
    return state;
  }

  /** Cambia y persiste el endpoint. `configure(null)` lo desactiva. */
  function configure(url) {
    endpoint = normalizeUrl(url);
    try {
      if (endpoint) window.localStorage.setItem(STORAGE_KEY, endpoint);
      else window.localStorage.removeItem(STORAGE_KEY);
    } catch (_) { /* storage no disponible */ }
    return endpoint;
  }

  /** Envío directo (fuera del bus OSC) — mismo formato de paquete. */
  function send(address, value) {
    emit({ action: "osc_send", address: address, args: [value] });
  }

  function status() {
    return {
      state: state,
      url: endpoint === undefined ? null : endpoint,
      attempt: attempt,
      nextRetryAt: nextRetryAt,
      queued: outbox.size,
      stats: Object.assign({}, stats),
    };
  }

  /* ---------------------------------------------------------- wiring bus */

  // Salida: la UI emite en el bus OSC → aquí se serializa a JSON.
  document.addEventListener("cuedesk:osc-out", function (e) {
    const d = e.detail;
    if (!d || !d.path) return;
    emit({ action: "osc_send", address: d.path, args: [d.value] });
  });

  // Entrada de red recuperada: reintentar en cuanto el navegador vuelva.
  window.addEventListener("online", function () {
    if (!manualStop && state !== "online") reconnect();
  });

  // Cierre limpio al salir de la página.
  window.addEventListener("pagehide", function () {
    manualStop = true;
    teardown();
  });

  /* -------------------------------------------------------- auto-arranque */

  function start() {
    const url = resolveUrl();
    endpoint = url;
    if (!url) {
      // "?ws=off" → explícitamente sin enlace (modo demo/local)
      setState("offline", { reason: "disabled" });
      return;
    }
    connect(url);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }

  return {
    connect: connect,
    disconnect: disconnect,
    reconnect: reconnect,
    configure: configure,
    send: send,
    status: status,
    /** Paquetes a enviar tras cada conexión (p. ej. suscripción de vúmetros). */
    setOnOpenPackets: function (list) {
      onOpenPackets = Array.isArray(list) ? list.slice() : [];
    },
    get state() { return state; },
    get url() { return endpoint; },
  };
})();
