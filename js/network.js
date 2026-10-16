"use strict";

/* ==========================================================================
 * CueDesk — js/network.js
 * --------------------------------------------------------------------------
 * Telemetría de red del appliance, pintada en la tarjeta «CueBox® & Network»
 * de Setup.
 *
 * FRONTERA ESTRICTA: este módulo SÓLO lee `GET /api/network` y PINTA. No habla
 * con `iw`, ni con BlueZ, ni con el kernel: absolutamente todo lo que muestra
 * viene ya interpretado por el backend (@cuedesk/hardware-mt7921). Si el
 * servidor arranca con `--no-net` (endpoint ausente), el módulo calla.
 *
 * La telemetría es de SÓLO LECTURA (`span`, no `input`): no compite con los
 * controles de Setup y no puede escribir en la red.
 * ========================================================================== */

(function () {
  var POLL_MS = 2000;
  var CARD_SEL = '[data-cuebox-card="network"]';

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  /** Fila de telemetría: etiqueta + valor (sin input, sin binding de Setup). */
  function row(key, value, tone) {
    var line = el("div", "setup__row net__row");
    line.appendChild(el("span", "net__key", key));
    line.appendChild(el("span", "net__val" + (tone ? " is-" + tone : ""), value));
    return line;
  }

  function heading(text) {
    return el("p", "net__head", text);
  }

  function setBadge(card, text, tone) {
    var badge = card.querySelector(".cuebox__badge");
    if (!badge) return;
    badge.className = "cuebox__badge is-" + tone;
    badge.textContent = text;
  }

  function dBm(v) {
    return v === null || v === undefined ? "—" : v + " dBm";
  }

  function render(snap) {
    var card = document.querySelector(CARD_SEL);
    if (!card) return;

    var src = snap.source || {};
    var iface = (snap.interfaces && snap.interfaces[0]) || null;
    var health = snap.health || {};
    var bt = snap.bluetooth || {};
    var mlo = (iface && iface.mlo) || {};

    /* ---- Estado en la pastilla de la tarjeta ---- */
    var tone = "dim";
    var label = "Sin datos";
    if (health.status === "up") { tone = "ok"; label = "Wi-Fi OK"; }
    else if (health.status === "degraded") { tone = "warn"; label = "Wi-Fi débil"; }
    else if (health.status === "down") { tone = "warn"; label = "Wi-Fi caído"; }
    else if (health.status === "absent") { tone = "dim"; label = "Sin radio"; }
    if (src.simulated) label += " · demo";
    setBadge(card, label, tone);

    /* ---- Cuerpo de telemetría ---- */
    var body = card.querySelector(".net__body");
    if (!body) {
      body = el("div", "net__body");
      card.appendChild(body);
    }
    body.textContent = "";

    body.appendChild(heading("Radio"));
    if (iface) {
      body.appendChild(row("Modelo", [iface.vendor, iface.model].filter(Boolean).join(" ") || "—", iface.model ? "good" : "off"));
      body.appendChild(row("Driver", iface.driver || "—", ""));
      body.appendChild(row("Estándar", iface.generation || "—", iface.generation ? "good" : "off"));
      body.appendChild(row("Interfaz", iface.name + (iface.up ? " · up" : " · down"), iface.up ? "good" : "bad"));
      body.appendChild(row("Modo AP", iface.apSupported ? "soportado" : "no", iface.apSupported ? "good" : "off"));
    } else {
      body.appendChild(row("Estado", "utilidades de red no disponibles", "off"));
    }

    body.appendChild(heading("Enlace"));
    if (iface) {
      var bands = (iface.bands && iface.bands.length) ? iface.bands.join(" + ") + " GHz" : "—";
      body.appendChild(row("Bandas", bands, ""));
      var link = iface.link || {};
      var ch = link.channel === null || link.channel === undefined ? "—" : String(link.channel);
      if (link.widthMhz) ch += " · " + link.widthMhz + " MHz";
      body.appendChild(row("Canal", ch, ""));
      body.appendChild(row("Clientes", (health.clients === null || health.clients === undefined) ? "0" : String(health.clients), ""));
      body.appendChild(row("Señal", dBm(health.rssiDbm), health.rssiDbm === null || health.rssiDbm === undefined ? "off" : (health.rssiDbm >= -67 ? "good" : "bad")));
      body.appendChild(row("MLO (Wi-Fi 7)", mlo.active ? "activo" : (mlo.supported ? "listo" : "no"), mlo.active ? "good" : "off"));
    }

    body.appendChild(heading("Bluetooth"));
    if (bt.available) {
      var devs = bt.devices || [];
      body.appendChild(row("Controlador", bt.powered ? "encendido" : "apagado", bt.powered ? "good" : "off"));
      body.appendChild(row("Periféricos", devs.length + (devs.length === 1 ? " conectado" : " conocidos"), ""));
    } else {
      body.appendChild(row("Controlador", "no disponible", "off"));
    }

    body.appendChild(heading("Origen"));
    body.appendChild(row("Datos", src.simulated ? "simulados (demo/CI)" : "hardware real", src.simulated ? "off" : "good"));
  }

  function poll() {
    if (typeof fetch !== "function") return;
    fetch("/api/network", { headers: { Accept: "application/json" }, cache: "no-store" })
      .then(function (res) {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.json();
      })
      .then(render)
      .catch(function () { /* servidor sin subsistema de red: silencio */ });
  }

  function init() {
    poll();
    setInterval(poll, POLL_MS);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
