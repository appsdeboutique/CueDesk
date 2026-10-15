"use strict";

/* ==========================================================================
 * CueDesk — backend/test/helpers.js
 * --------------------------------------------------------------------------
 * Utilidades compartidas por las pruebas del backend: un motor OSC falso que
 * apunta lo que se envía, un reloj falso y generadores de señal/telemetría.
 *
 * Nada de esto entra en producción: son dobles de prueba.
 * ========================================================================== */

/** Motor OSC de mentira: apunta cada envío. */
function fakeSink(name) {
  const sent = [];
  return {
    name: name || "fake",
    sent: sent,
    send: function (path, value, type) {
      sent.push({ path: path, value: value, type: type });
    },
    paths: function () {
      return sent.map(function (s) { return s.path; });
    },
    values: function () {
      return sent.map(function (s) { return s.value; });
    },
    last: function () {
      return sent.length ? sent[sent.length - 1] : null;
    },
    clear: function () {
      sent.length = 0;
    },
  };
}

/** Reloj de mentira: el servicio nunca mira el reloj real si se le inyecta. */
function fakeClock(start) {
  let now = isFinite(start) ? start : 0;
  return {
    now: function () { return now; },
    set: function (v) { now = v; return now; },
    advance: function (ms) { now += ms; return now; },
  };
}

/**
 * Alimenta una telemetría constante (o calculada) para un canal.
 * @param {object} service
 * @param {string} id           "ch.01" | "aux.02"
 * @param {number|Function} db  nivel, o (t) => nivel
 */
function feed(service, id, db, fromMs, toMs, stepMs) {
  const step = stepMs > 0 ? stepMs : 100;
  let count = 0;
  for (let t = fromMs; t <= toMs; t += step) {
    const value = typeof db === "function" ? db(t) : db;
    service.pushMeters({ levels: [value], map: [id], ts: t });
    count++;
  }
  return count;
}

/** Seno de amplitud tal que su RMS vale `dbfsRms`. */
function sine(fs, seconds, dbfsRms, freq) {
  const n = Math.round(fs * seconds);
  const out = new Float32Array(n);
  const amp = Math.SQRT2 * Math.pow(10, dbfsRms / 20);
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin((2 * Math.PI * (freq || 1000) * i) / fs);
  return out;
}

module.exports = { fakeSink, fakeClock, feed, sine };
