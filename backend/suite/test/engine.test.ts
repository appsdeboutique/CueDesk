/* Pruebas del motor GainGuard (suite). Reloj falso, transporte falso. */

import test from "node:test";
import assert from "node:assert/strict";
import { GainGuardEngine } from "../gainGuardEngine.ts";
import { toFader } from "../oscHandler.ts";
import type { OutboundMessage } from "../types.ts";

function make(opts?: { config?: object; bus?: object }) {
  const sent: OutboundMessage[] = [];
  let now = 0;
  const engine = new GainGuardEngine({
    transport: { send: (m: OutboundMessage) => { sent.push(m); } },
    now: () => now,
    config: opts && opts.config,
    bus: opts && opts.bus,
  });
  engine.addChannel("ch.01");
  return { engine: engine, sent: sent, at: (t: number) => { now = t; } };
}

type Env = ReturnType<typeof make>;

/** Avanza el reloj de `from` a `to` en pasos de 100 ms; `each` corre antes de cada tick. */
function run(env: Env, from: number, to: number, each?: (t: number) => void) {
  for (let t = from; t <= to; t += 100) {
    env.at(t);
    if (each) each(t);
    env.engine.tick(t);
  }
}

function sendsTo(env: Env, path: string): OutboundMessage[] {
  return env.sent.filter(function (m) { return m.path === path; });
}

/* ------------------------------------------------------------ marca y banda */

test("todo mensaje saliente lleva la marca de origen", function () {
  const env = make({ bus: { enabled: true } });
  env.engine.linkBuses("ch.01", [1]);
  env.engine.setBusSend("ch.01", 1, -10);
  env.engine.ingestConsole("/headamp/000/gain", 20, 0);
  env.at(0); env.engine.tick(0);
  env.engine.ingestConsole("/headamp/000/gain", 23, 100);
  env.at(100); env.engine.tick(100);
  assert.ok(env.sent.length > 0);
  for (const m of env.sent) assert.equal(m.source, "cuedesk-internal");
});

test("banda muerta: un previo que varía 0,3 dB no genera tráfico", function () {
  const env = make({ bus: { enabled: true } });
  env.engine.linkBuses("ch.01", [1]);
  env.engine.setBusSend("ch.01", 1, -10);
  env.engine.ingestConsole("/headamp/000/gain", 20, 0);
  env.at(0); env.engine.tick(0);
  env.engine.ingestConsole("/headamp/000/gain", 20.3, 100);
  env.at(100); env.engine.tick(100);
  assert.equal(env.sent.length, 0);
});

test("banda muerta: variaciones pequeñas se acumulan hasta superarla", function () {
  const env = make({ bus: { enabled: true } });
  env.engine.linkBuses("ch.01", [1]);
  env.engine.setBusSend("ch.01", 1, -10);
  env.engine.ingestConsole("/headamp/000/gain", 20, 0);
  env.at(0); env.engine.tick(0);
  [20.2, 20.4, 20.6].forEach(function (h, i) {
    const t = (i + 1) * 100;
    env.engine.ingestConsole("/headamp/000/gain", h, t);
    env.at(t); env.engine.tick(t);
  });
  assert.equal(env.sent.length, 1, "una compensación al llegar a +0,6 dB");
  assert.ok(Math.abs(env.sent[0].value - toFader(-10.6)) < 1e-9);
});

/* ------------------------------------------------------------ BusGuard */

test("BusGuard: el técnico sube el previo → el envío baja la misma cantidad", function () {
  const env = make({ bus: { enabled: true } });
  env.engine.linkBuses("ch.01", [1]);
  env.engine.setBusSend("ch.01", 1, -10);
  env.engine.ingestConsole("/headamp/000/gain", 20, 0);
  env.at(0); env.engine.tick(0);
  env.engine.ingestConsole("/headamp/000/gain", 23, 100);
  env.at(100); env.engine.tick(100);
  assert.equal(env.sent.length, 1);
  assert.equal(env.sent[0].path, "/ch/01/mix/01/level");
  assert.ok(Math.abs(env.sent[0].value - toFader(-13)) < 1e-9);
});

test("BusGuard NO compensa el fader: el envío es post-EQ", function () {
  const env = make({ bus: { enabled: true } });
  env.engine.linkBuses("ch.01", [1]);
  env.engine.setBusSend("ch.01", 1, -10);
  env.engine.ingestConsole("/ch/01/mix/fader", toFader(0), 0);
  env.at(0); env.engine.tick(0);
  env.engine.ingestConsole("/ch/01/mix/fader", toFader(-6), 100);
  env.at(100); env.engine.tick(100);
  assert.equal(env.sent.length, 0, "mover el fader no toca el IEM");
});

test("BusGuard: un cambio que llega antes del primer tick también se compensa", function () {
  const env = make({ bus: { enabled: true } });
  env.engine.linkBuses("ch.01", [1]);
  env.engine.setBusSend("ch.01", 1, -10);
  env.engine.ingestConsole("/headamp/000/gain", 20, 0);
  env.engine.ingestConsole("/headamp/000/gain", 23, 50);
  env.at(100); env.engine.tick(100);
  assert.equal(env.sent.length, 1, "−3 dB de previo → envío a −13 dB");
  assert.ok(Math.abs(env.sent[0].value - toFader(-13)) < 1e-9);
});

test("BusGuard apagado: el previo se mueve sin compensar", function () {
  const env = make();
  env.engine.linkBuses("ch.01", [1]);
  env.engine.setBusSend("ch.01", 1, -10);
  env.engine.ingestConsole("/headamp/000/gain", 20, 0);
  env.at(0); env.engine.tick(0);
  env.engine.ingestConsole("/headamp/000/gain", 23, 100);
  env.at(100); env.engine.tick(100);
  assert.equal(env.sent.length, 0);
});

test("BusGuard: el envío se confina a su rango", function () {
  const env = make({ bus: { enabled: true } });
  env.engine.linkBuses("ch.01", [1]);
  env.engine.setBusSend("ch.01", 1, -89);
  env.engine.ingestConsole("/headamp/000/gain", 20, 0);
  env.at(0); env.engine.tick(0);
  env.engine.ingestConsole("/headamp/000/gain", 23, 100);
  env.at(100); env.engine.tick(100);
  assert.equal(env.sent[0].value, 0, "−90 dB = 0 en cable");
});

test("BusGuard stealth: sin enlaces, un +10 dB del previo baja 10 dB en los 16 buses", function () {
  const env = make({ bus: { enabled: true } });
  for (let b = 1; b <= 16; b++) env.engine.setBusSend("ch.01", b, -6);
  env.engine.ingestConsole("/headamp/000/gain", 20, 0);
  env.at(0); env.engine.tick(0);
  env.engine.ingestConsole("/headamp/000/gain", 30, 100);
  env.at(100); env.engine.tick(100);

  const sends = env.sent.filter(function (m) { return /\/level$/.test(m.path); });
  assert.equal(sends.length, 16, "un envío por bus");
  for (const m of sends) assert.ok(Math.abs(m.value - toFader(-16)) < 1e-9, m.path);
  assert.equal(
    env.sent.filter(function (m) { return m.path === "/ch/01/mix/fader"; }).length,
    0,
    "el fader de mezcla no se toca",
  );
});

test("BusGuard stealth: los buses sin valor conocido se omiten", function () {
  const env = make({ bus: { enabled: true } });
  env.engine.setBusSend("ch.01", 3, -6);
  env.engine.setBusSend("ch.01", 7, -12);
  env.engine.ingestConsole("/headamp/000/gain", 20, 0);
  env.at(0); env.engine.tick(0);
  env.engine.ingestConsole("/headamp/000/gain", 23, 100);
  env.at(100); env.engine.tick(100);
  const sends = env.sent.filter(function (m) { return /\/level$/.test(m.path); });
  assert.equal(sends.length, 2, "sólo los dos buses conocidos");
  const byPath: Record<string, number> = {};
  for (const m of sends) byPath[m.path] = m.value;
  assert.ok(Math.abs(byPath["/ch/01/mix/03/level"] - toFader(-9)) < 1e-9);
  assert.ok(Math.abs(byPath["/ch/01/mix/07/level"] - toFader(-15)) < 1e-9);
});

test("BusGuard: un enlace explícito limita la compensación", function () {
  const env = make({ bus: { enabled: true } });
  env.engine.linkBuses("ch.01", [2]);
  env.engine.setBusSend("ch.01", 1, -6);
  env.engine.setBusSend("ch.01", 2, -6);
  env.engine.ingestConsole("/headamp/000/gain", 20, 0);
  env.at(0); env.engine.tick(0);
  env.engine.ingestConsole("/headamp/000/gain", 23, 100);
  env.at(100); env.engine.tick(100);
  const sends = env.sent.filter(function (m) { return /\/level$/.test(m.path); });
  assert.equal(sends.length, 1);
  assert.equal(sends[0].path, "/ch/01/mix/02/level");
});

/* ------------------------------------------------------------ Stage / Pre */

test("Stage Guard: el ducking actúa sobre el previo y BusGuard lo compensa en el IEM", function () {
  const env = make({ bus: { enabled: true } });
  env.engine.linkBuses("ch.01", [1]);
  env.engine.setBusSend("ch.01", 1, -10);
  env.engine.configureStage("ch.01", { enabled: true, threshold: -50, duckingDepth: 10, holdMs: 1000 });
  env.engine.ingestConsole("/headamp/000/gain", 20, 0);

  // Silencio hasta 2400 ms, señal fuerte desde 2500 ms.
  run(env, 0, 6000, (t) => env.engine.ingestLevel("ch.01", t < 2500 ? -80 : -20, t));

  const ch = env.engine.channel("ch.01")!;
  assert.equal(ch.headamp, 20, "vuelve al nominal");
  const heads = sendsTo(env, "/headamp/000/gain");
  assert.equal(heads.length, 12, "10 pasos de 1 dB al bajar + 2 de 5 dB al subir");
  assert.ok(Math.abs(Math.min.apply(null, heads.map((m) => m.value)) - 10) < 1e-9, "baja hasta 10 dB");
  // El IEM no se mueve neto: sus compensaciones suman cero.
  const sends = sendsTo(env, "/ch/01/mix/01/level");
  assert.ok(sends.length > 0);
  assert.ok(Math.abs(sends[sends.length - 1].value - toFader(-10)) < 1e-9, "IEM vuelve a −10 dB");
});

test("Stage Guard: la voz restaura en menos de 200 ms, aunque el cooldown siga activo", function () {
  const env = make();
  env.engine.configureStage("ch.01", { enabled: true, threshold: -50, duckingDepth: 10, holdMs: 1000 });
  env.engine.ingestConsole("/headamp/000/gain", 20, 0);
  // Silencio hasta 2000 ms (el último paso de bajada renueva el cooldown hasta ~4400 ms).
  run(env, 0, 1900, (t) => env.engine.ingestLevel("ch.01", -80, t));
  assert.equal(env.engine.channel("ch.01")!.headamp, 10);
  run(env, 2000, 2100, (t) => env.engine.ingestLevel("ch.01", -20, t));
  assert.equal(env.engine.channel("ch.01")!.headamp, 20, "restaurado sin esperar al cooldown");
});

test("Stage Guard: la histéresis evita restaurar con una señal en el límite", function () {
  const env = make();
  env.engine.configureStage("ch.01", { enabled: true, threshold: -50, duckingDepth: 10, holdMs: 1000, hysteresisDb: 3 });
  env.engine.ingestConsole("/headamp/000/gain", 20, 0);
  run(env, 0, 2000, (t) => env.engine.ingestLevel("ch.01", -80, t));
  // −49 dBFS: por encima del umbral (−50) pero dentro de la histéresis (−47): no restaura.
  run(env, 2100, 3500, (t) => env.engine.ingestLevel("ch.01", -49, t));
  assert.equal(env.engine.channel("ch.01")!.headamp, 10);
  // −46 dBFS: supera la histéresis: restaura.
  run(env, 3600, 4000, (t) => env.engine.ingestLevel("ch.01", -46, t));
  assert.equal(env.engine.channel("ch.01")!.headamp, 20);
});

test("Stage Guard: apagar el StageBus del canal estando atenuado lo restaura", function () {
  const env = make();
  env.engine.configureStage("ch.01", { enabled: true, holdMs: 1000 });
  env.engine.ingestConsole("/headamp/000/gain", 20, 0);
  run(env, 0, 2000, (t) => env.engine.ingestLevel("ch.01", -80, t));
  assert.equal(env.engine.channel("ch.01")!.headamp, 10, "atenuado");

  env.engine.configureStage("ch.01", { enabled: false });
  run(env, 2100, 2300, (t) => env.engine.ingestLevel("ch.01", -80, t));
  assert.equal(env.engine.channel("ch.01")!.headamp, 20, "StageBus apagado: restaura");
});

test("Stage Guard: no ataca antes del hold", function () {
  const env = make();
  env.engine.configureStage("ch.01", { enabled: true, holdMs: 1000 });
  env.engine.ingestConsole("/headamp/000/gain", 20, 0);
  run(env, 0, 900, (t) => env.engine.ingestLevel("ch.01", -80, t));
  assert.equal(sendsTo(env, "/headamp/000/gain").length, 0);
});

test("PreGuard: nivel sostenido sobre el techo baja el previo con cooldown", function () {
  const env = make();
  env.engine.configurePre("ch.01", { enabled: true, ceilingDb: -6 });
  env.engine.ingestConsole("/headamp/000/gain", 20, 0);
  run(env, 0, 5000, (t) => env.engine.ingestLevel("ch.01", -3, t));
  const heads = sendsTo(env, "/headamp/000/gain");
  assert.deepEqual(heads.map((m) => m.value), [19.5, 19, 18.5]);
});

test("PreGuard desactivado no toca el previo", function () {
  const env = make();
  env.engine.ingestConsole("/headamp/000/gain", 20, 0);
  run(env, 0, 3000, (t) => env.engine.ingestLevel("ch.01", -1, t));
  assert.equal(env.sent.length, 0);
});

test("PreGuard: cuando el nivel baja del techo devuelve el previo a su referencia", function () {
  const env = make();
  env.engine.configurePre("ch.01", { enabled: true, ceilingDb: -6, hysteresisDb: 3 });
  env.engine.ingestConsole("/headamp/000/gain", 20, 0);
  // Al límite: protege (19,5 y luego 19 con el cooldown de 2,5 s).
  run(env, 0, 3000, (t) => env.engine.ingestLevel("ch.01", -3, t));
  assert.equal(env.engine.channel("ch.01")!.headamp, 19);
  // Señal baja: la ventana se vacía de muestras calientes y el previo vuelve a 20.
  run(env, 3100, 5000, (t) => env.engine.ingestLevel("ch.01", -30, t));
  assert.equal(env.engine.channel("ch.01")!.headamp, 20, "vuelve a la referencia");
  assert.equal(env.engine.channel("ch.01")!.preOffset, 0, "PreGuard suelta el desplazamiento");
});

test("PreGuard: la histéresis no deja el previo subiendo y bajando en el límite", function () {
  const env = make();
  env.engine.configurePre("ch.01", { enabled: true, ceilingDb: -6, hysteresisDb: 3 });
  env.engine.ingestConsole("/headamp/000/gain", 20, 0);
  run(env, 0, 3000, (t) => env.engine.ingestLevel("ch.01", -3, t));
  assert.equal(env.engine.channel("ch.01")!.headamp, 19);
  // −7 dBFS: por debajo del techo (−6) pero dentro de la banda de histéresis (−9):
  // ni protege más ni recupera.
  run(env, 3100, 9000, (t) => env.engine.ingestLevel("ch.01", -7, t));
  assert.equal(env.engine.channel("ch.01")!.headamp, 19, "se mantiene en la banda");
});

test("PreGuard y Stage Guard conviven sobre un objetivo único, sin bucle", function () {
  const env = make();
  env.engine.configureStage("ch.01", {
    enabled: true,
    threshold: -50,
    duckingDepth: 10,
    holdMs: 1000,
  });
  env.engine.configurePre("ch.01", { enabled: true, ceilingDb: -6, hysteresisDb: 3 });
  env.engine.ingestConsole("/headamp/000/gain", 20, 0);
  const ch = env.engine.channel("ch.01")!;

  /* Fase 1 · silencio: Stage Guard baja; PreGuard no acumula desplazamiento. */
  run(env, 0, 3000, (t) => env.engine.ingestLevel("ch.01", -80, t));
  assert.equal(ch.stage.ducked, true);
  assert.equal(ch.headamp, 10, "nominal − 10 dB");
  assert.equal(ch.preOffset, 0, "sin desplazamiento de PreGuard");

  /* Fase 2 · señal fuerte sostenida: Stage Guard restaura y PreGuard protege. */
  run(env, 3100, 12000, (t) => env.engine.ingestLevel("ch.01", -3, t));
  assert.equal(ch.stage.ducked, false);
  assert.ok(ch.headamp < 20, "PreGuard protege por debajo del nominal");
  assert.ok(ch.preOffset > 0, "hay desplazamiento de PreGuard");

  /* Sin bucle: una vez asentada la transición, el previo sólo baja (PreGuard). */
  const tail = env.engine
    .recentEmits()
    .filter(function (e) { return e.kind === "headamp" && e.t >= 6000; })
    .map(function (e) { return e.db; });
  assert.ok(tail.length >= 2, "PreGuard sigue bajando");
  for (let i = 1; i < tail.length; i++) {
    assert.ok(tail[i] <= tail[i - 1] + 1e-9, "el previo no repunta: sin bucle");
  }
});

test("PreGuard: el control manual del previo queda bloqueado mientras actúa", function () {
  const env = make();
  env.engine.configurePre("ch.01", { enabled: true, ceilingDb: -6 });
  env.engine.ingestConsole("/headamp/000/gain", 20, 0);
  env.engine.ingestLevel("ch.01", -3, 0);
  env.at(0);
  env.engine.tick(0);
  assert.equal(env.engine.channel("ch.01")!.headamp, 19.5);
  assert.equal(env.engine.channel("ch.01")!.headampLockUntil, 1000);

  const blocked = env.engine.ingestConsole("/headamp/000/gain", 30, 200);
  assert.equal(blocked.reason, "guard-locked");
  assert.equal(env.engine.channel("ch.01")!.headamp, 19.5, "no cambia");
  // Además de descartarlo, se reafirma el valor del motor en la consola.
  const assert1 = sendsTo(env, "/headamp/000/gain");
  assert.equal(assert1[assert1.length - 1].value, 19.5);
  assert.equal(assert1.length, 2, "19,5 del ajuste + 19,5 del reafirmado");

  const accepted = env.engine.ingestConsole("/headamp/000/gain", 30, 1200);
  assert.equal(accepted.reason, "external");
  assert.equal(env.engine.channel("ch.01")!.headamp, 30, "el bloqueo ya expiró");
});

test("anti-bucle: el eco redondeado del propio previo se descarta", function () {
  const env = make({ bus: { enabled: true } });
  env.engine.configurePre("ch.01", { enabled: true, ceilingDb: -6 });
  env.engine.linkBuses("ch.01", [1]);
  env.engine.setBusSend("ch.01", 1, -10);
  env.engine.ingestConsole("/headamp/000/gain", 20, 0);
  env.engine.ingestLevel("ch.01", -3, 0);
  env.at(0); env.engine.tick(0);
  assert.equal(sendsTo(env, "/headamp/000/gain")[0].value, 19.5);

  const r = env.engine.ingestConsole("/headamp/000/gain", 19.4, 50);
  assert.equal(r.reason, "own-echo");
  assert.equal(env.engine.channel("ch.01")!.headamp, 19.5, "el estado no cambia");

  const before = env.sent.length;
  env.at(100); env.engine.ingestLevel("ch.01", -3, 100); env.engine.tick(100);
  assert.equal(env.sent.length, before, "ningún envío extra");
});

test("anti-bucle: el eco de la compensación no genera otra", function () {
  const env = make({ bus: { enabled: true } });
  env.engine.linkBuses("ch.01", [1]);
  env.engine.setBusSend("ch.01", 1, -10);
  env.engine.ingestConsole("/headamp/000/gain", 20, 0);
  env.at(0); env.engine.tick(0);
  env.engine.ingestConsole("/headamp/000/gain", 23, 100);
  env.at(100); env.engine.tick(100);
  const r = env.engine.ingestConsole("/ch/01/mix/01/level", env.sent[0].value, 150);
  assert.equal(r.reason, "own-echo");
  env.at(200); env.engine.tick(200);
  assert.equal(env.sent.length, 1);
});

/* ------------------------------------------------------ normalización base */

test("base RMS: aprende la referencia y sube el fader en rampa de 2 s", function () {
  const env = make();
  env.engine.configureBase("ch.01", { mode: "rms", threshold: 5 });
  env.engine.ingestConsole("/ch/01/mix/fader", toFader(0), 0);
  run(env, 0, 10000, (t) => env.engine.ingestLevel("ch.01", -30, t));
  assert.equal(env.engine.channel("ch.01")!.baseRef, -30);
  assert.equal(sendsTo(env, "/ch/01/mix/fader").length, 0);

  run(env, 10100, 22500, (t) => env.engine.ingestLevel("ch.01", -40, t));
  const faders = sendsTo(env, "/ch/01/mix/fader");
  assert.ok(faders.length >= 15, "rampa de ~20 pasos: " + faders.length);
  const fader = env.engine.channel("ch.01")!.fader!;
  assert.ok(fader > 9 && fader <= 10, "fader subido ~10 dB: " + fader);
  assert.equal(env.sent.filter(function (m) { return m.path.indexOf("/headamp") === 0; }).length, 0);
});

test("base RMS: una desviación dentro de la tolerancia (3 dB) no se corrige", function () {
  const env = make();
  env.engine.configureBase("ch.01", { mode: "rms", threshold: 5 });
  env.engine.ingestConsole("/ch/01/mix/fader", toFader(0), 0);
  run(env, 0, 10000, (t) => env.engine.ingestLevel("ch.01", -30, t));
  run(env, 10100, 20000, (t) => env.engine.ingestLevel("ch.01", -33, t));
  assert.equal(sendsTo(env, "/ch/01/mix/fader").length, 0);
});

test("base RMS: la tolerancia de 3 dB del selector corrige desviaciones de 4 dB", function () {
  const env = make();
  env.engine.configureBase("ch.01", { mode: "rms", threshold: 3 });
  env.engine.ingestConsole("/ch/01/mix/fader", toFader(0), 0);
  run(env, 0, 10000, (t) => env.engine.ingestLevel("ch.01", -30, t));
  run(env, 10100, 22500, (t) => env.engine.ingestLevel("ch.01", -34, t));
  assert.ok(sendsTo(env, "/ch/01/mix/fader").length > 0, "4 dB > 3 dB: corrige");
});

test("base LUFS: el objetivo −23 del selector corrige desde −20 (3 dB)", function () {
  const env = make();
  env.engine.configureBase("ch.01", { mode: "lufs", threshold: -23 });
  env.engine.ingestConsole("/ch/01/mix/fader", toFader(0), 0);
  run(env, 0, 12500, (t) => env.engine.ingestLevel("ch.01", -20, t));
  const fader = env.engine.channel("ch.01")!.fader!;
  assert.ok(Math.abs(fader - -3) < 0.1, "bajada de −3 dB: " + fader);
  assert.equal(env.engine.channel("ch.01")!.base.threshold, -23);
});

test("base LUFS: estima desde el vúmetro y sigue el objetivo −18", function () {
  const env = make();
  env.engine.configureBase("ch.01", { mode: "lufs", threshold: -18 });
  env.engine.ingestConsole("/ch/01/mix/fader", toFader(0), 0);
  run(env, 0, 12500, (t) => env.engine.ingestLevel("ch.01", -25, t));
  const fader = env.engine.channel("ch.01")!.fader!;
  assert.ok(Math.abs(fader - 7) < 0.1, "subida de +7 dB: " + fader);
});

test("base: un salto anómalo (>15 dB) no se corrige y tras 3 veces bloquea el canal", function () {
  const env = make();
  env.engine.configureBase("ch.01", { mode: "lufs", threshold: -18 });
  env.engine.ingestConsole("/ch/01/mix/fader", toFader(0), 0);
  run(env, 0, 30000, (t) => env.engine.ingestLevel("ch.01", -2, t));
  const ch = env.engine.channel("ch.01")!;
  assert.equal(sendsTo(env, "/ch/01/mix/fader").length, 0, "nada escrito");
  assert.equal(ch.baseLocked, true);
  assert.equal(ch.lastBase, "extreme-jump", "el tercer aviso bloquea el canal");
});

test("base: sin señal no se decide nada", function () {
  const env = make();
  env.engine.configureBase("ch.01", { mode: "lufs", threshold: -18 });
  env.engine.ingestConsole("/ch/01/mix/fader", toFader(0), 0);
  run(env, 0, 12000, (t) => env.engine.ingestLevel("ch.01", -80, t));
  assert.equal(sendsTo(env, "/ch/01/mix/fader").length, 0);
  assert.equal(env.engine.channel("ch.01")!.lastBase, "no-signal");
});

/* ------------------------------------------------------------- entradas */

test("un eco de fader distinto del asumido sí se toma como cambio externo", function () {
  const env = make();
  env.engine.ingestConsole("/ch/01/mix/fader", toFader(0), 0);
  const r = env.engine.ingestConsole("/ch/01/mix/fader", toFader(-5), 10);
  assert.equal(r.accepted, true);
  assert.equal(env.engine.channel("ch.01")!.fader, -5);
});

test("rutas desconocidas y canales sin registrar se rechazan sin error", function () {
  const env = make();
  assert.equal(env.engine.ingestConsole("/aux/01/mix/fader", 0.5, 0).reason, "unknown-path");
  assert.equal(env.engine.ingestConsole("/ch/09/mix/fader", 0.5, 0).reason, "unknown-channel");
});

test("el ciclo periódico arranca y se detiene sin dejar temporizadores", function () {
  const env = make();
  env.engine.start();
  env.engine.start();
  env.engine.stop();
  env.engine.stop();
  assert.equal(env.engine.status().channels.length, 1);
});
