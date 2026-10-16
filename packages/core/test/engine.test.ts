/* Pruebas del motor GainGuard (@cuedesk/core).
 *
 * Reloj falso y adaptador falso. El motor nunca ve una ruta OSC ni un valor
 * de cable: le pide al adaptador `setPreampGain("ch.01", 19.5)` y es el driver
 * quien decide qué escribir. Lo que aquí se comprueba es el DOMINIO. */

import test from "node:test";
import assert from "node:assert/strict";

import type { ControlChange } from "@cuedesk/console-adapter";

import { GainGuardEngine } from "../src/gainGuardEngine.ts";
import { fakeAdapter } from "./helpers.ts";

function make(opts?: { config?: object; bus?: object }) {
  const fake = fakeAdapter();
  let now = 0;
  const engine = new GainGuardEngine({
    adapter: fake.adapter,
    now: function () { return now; },
    config: opts && opts.config,
    bus: opts && opts.bus,
  });
  engine.addChannel("ch.01");
  return { engine: engine, fake: fake, at: function (t: number) { now = t; } };
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

/* Atajos de entrada: un cambio que llegaría del driver, ya en dominio. */
function ch01(kind: "preamp" | "fader", db: number): ControlChange {
  return { target: { kind: kind, channel: "ch.01" }, db: db, origin: "console" };
}
function preamp(env: Env, db: number, t?: number) { return env.engine.ingestChange(ch01("preamp", db), t); }
function fader(env: Env, db: number, t?: number) { return env.engine.ingestChange(ch01("fader", db), t); }

/* ------------------------------------------------------------ banda muerta */

test("banda muerta: un previo que varía 0,3 dB no genera tráfico", function () {
  const env = make({ bus: { enabled: true } });
  env.engine.linkBuses("ch.01", [1]);
  env.engine.setBusSend("ch.01", 1, -10);
  preamp(env, 20, 0);
  env.at(0); env.engine.tick(0);
  preamp(env, 20.3, 100);
  env.at(100); env.engine.tick(100);
  assert.equal(env.fake.calls.length, 0);
});

test("banda muerta: variaciones pequeñas se acumulan hasta superarla", function () {
  const env = make({ bus: { enabled: true } });
  env.engine.linkBuses("ch.01", [1]);
  env.engine.setBusSend("ch.01", 1, -10);
  preamp(env, 20, 0);
  env.at(0); env.engine.tick(0);
  [20.2, 20.4, 20.6].forEach(function (h, i) {
    const t = (i + 1) * 100;
    preamp(env, h, t);
    env.at(t); env.engine.tick(t);
  });
  const sends = env.fake.send();
  assert.equal(sends.length, 1, "una compensación al llegar a +0,6 dB");
  assert.ok(Math.abs((sends[0].db as number) - -10.6) < 1e-9);
});

/* -------------------------------------------------------------- BusGuard */

test("BusGuard: el técnico sube el previo → el envío baja la misma cantidad", function () {
  const env = make({ bus: { enabled: true } });
  env.engine.linkBuses("ch.01", [1]);
  env.engine.setBusSend("ch.01", 1, -10);
  preamp(env, 20, 0);
  env.at(0); env.engine.tick(0);
  preamp(env, 23, 100);
  env.at(100); env.engine.tick(100);
  const sends = env.fake.send();
  assert.equal(sends.length, 1);
  assert.equal(sends[0].bus, 1);
  assert.ok(Math.abs((sends[0].db as number) - -13) < 1e-9);
});

test("BusGuard NO compensa el fader: el envío es post-EQ", function () {
  const env = make({ bus: { enabled: true } });
  env.engine.linkBuses("ch.01", [1]);
  env.engine.setBusSend("ch.01", 1, -10);
  fader(env, 0, 0);
  env.at(0); env.engine.tick(0);
  fader(env, -6, 100);
  env.at(100); env.engine.tick(100);
  assert.equal(env.fake.calls.length, 0, "mover el fader no toca el IEM");
});

test("BusGuard: un cambio que llega antes del primer tick también se compensa", function () {
  const env = make({ bus: { enabled: true } });
  env.engine.linkBuses("ch.01", [1]);
  env.engine.setBusSend("ch.01", 1, -10);
  preamp(env, 20, 0);
  preamp(env, 23, 50);
  env.at(100); env.engine.tick(100);
  const sends = env.fake.send();
  assert.equal(sends.length, 1, "−3 dB de previo → envío a −13 dB");
  assert.ok(Math.abs((sends[0].db as number) - -13) < 1e-9);
});

test("BusGuard apagado: el previo se mueve sin compensar", function () {
  const env = make();
  env.engine.linkBuses("ch.01", [1]);
  env.engine.setBusSend("ch.01", 1, -10);
  preamp(env, 20, 0);
  env.at(0); env.engine.tick(0);
  preamp(env, 23, 100);
  env.at(100); env.engine.tick(100);
  assert.equal(env.fake.calls.length, 0);
});

test("BusGuard: el envío se confina a su rango", function () {
  const env = make({ bus: { enabled: true } });
  env.engine.linkBuses("ch.01", [1]);
  env.engine.setBusSend("ch.01", 1, -89);
  preamp(env, 20, 0);
  env.at(0); env.engine.tick(0);
  preamp(env, 23, 100);
  env.at(100); env.engine.tick(100);
  assert.equal(env.fake.send()[0].db, -90, "el envío no baja de −90 dB");
});

test("BusGuard stealth: sin enlaces, un +10 dB del previo baja 10 dB en los 16 buses", function () {
  const env = make({ bus: { enabled: true } });
  for (let b = 1; b <= 16; b++) env.engine.setBusSend("ch.01", b, -6);
  preamp(env, 20, 0);
  env.at(0); env.engine.tick(0);
  preamp(env, 30, 100);
  env.at(100); env.engine.tick(100);

  const sends = env.fake.send();
  assert.equal(sends.length, 16, "un envío por bus");
  for (const m of sends) assert.ok(Math.abs((m.db as number) - -16) < 1e-9, "bus " + m.bus);
  assert.equal(env.fake.fader().length, 0, "el fader de mezcla no se toca");
});

test("BusGuard stealth: los buses sin valor conocido se omiten", function () {
  const env = make({ bus: { enabled: true } });
  env.engine.setBusSend("ch.01", 3, -6);
  env.engine.setBusSend("ch.01", 7, -12);
  preamp(env, 20, 0);
  env.at(0); env.engine.tick(0);
  preamp(env, 23, 100);
  env.at(100); env.engine.tick(100);
  const sends = env.fake.send();
  assert.equal(sends.length, 2, "sólo los dos buses conocidos");
  const byBus: Record<number, number> = {};
  for (const m of sends) byBus[m.bus as number] = m.db as number;
  assert.ok(Math.abs(byBus[3] - -9) < 1e-9);
  assert.ok(Math.abs(byBus[7] - -15) < 1e-9);
});

test("BusGuard: un enlace explícito limita la compensación", function () {
  const env = make({ bus: { enabled: true } });
  env.engine.linkBuses("ch.01", [1]);
  env.engine.setBusSend("ch.01", 1, -10);
  preamp(env, 20, 0);
  env.at(0); env.engine.tick(0);
  preamp(env, 23, 100);
  env.at(100); env.engine.tick(100);
  assert.equal(env.fake.send().length, 1);
});

/* ------------------------------------------------------------ Stage Guard */

test("Stage Guard: el técnico sube el previo → el envío lo compensa", function () {
  const env = make({ bus: { enabled: true } });
  env.engine.linkBuses("ch.01", [1]);
  env.engine.setBusSend("ch.01", 1, -10);
  preamp(env, 20, 0);
  env.at(0); env.engine.tick(0);
  preamp(env, 30, 100);
  env.at(100); env.engine.tick(100);
  assert.equal(env.fake.send()[0].db, -20, "−10 dB de previo → envío a −20 dB");
});

test("Stage Guard: la voz ausente atenúa y al volver restaura", function () {
  const env = make();
  env.engine.configureStage("ch.01", { enabled: true, threshold: -50, duckingDepth: 10, holdMs: 1000 });
  preamp(env, 20, 0);
  env.at(0); env.engine.tick(0);
  run(env, 0, 1900, function (t) { env.engine.ingestLevel("ch.01", -80, t); });
  assert.equal(env.engine.channel("ch.01")!.headamp, 10, "atenuado 10 dB");

  run(env, 2000, 2200, function (t) { env.engine.ingestLevel("ch.01", -20, t); });
  assert.equal(env.engine.channel("ch.01")!.headamp, 20, "restaurado al oír voz");
  assert.ok(env.fake.preamp().length >= 11, "la atenuación es gradual");
});

test("Stage Guard + BusGuard: el IEM vuelve a su valor neto", function () {
  const env = make({ bus: { enabled: true } });
  env.engine.linkBuses("ch.01", [1]);
  env.engine.setBusSend("ch.01", 1, -10);
  env.engine.configureStage("ch.01", { enabled: true, threshold: -50, duckingDepth: 10, holdMs: 1000 });
  preamp(env, 20, 0);
  env.at(0); env.engine.tick(0);
  run(env, 0, 6000, function (t) {
    env.engine.ingestLevel("ch.01", t < 3000 ? -80 : -20, t);
  });
  const heads = env.fake.preamp();
  assert.ok(heads.length > 0);
  const min = Math.min.apply(null, heads.map(function (m) { return m.db as number; }));
  assert.ok(Math.abs(heads[heads.length - 1].db! - 20) < 1e-9, "el previo vuelve a 20");
  assert.equal(env.engine.channel("ch.01")!.headamp, 20);

  const sends = env.fake.send();
  assert.ok(sends.length > 0, "BusGuard compensó durante el ducking");
  assert.ok(Math.abs((sends[sends.length - 1].db as number) - -10) < 1e-9, "IEM vuelve a −10 dB");
  void heads;
});

test("Stage Guard: la voz restaura en menos de 200 ms, aunque el cooldown siga activo", function () {
  const env = make();
  env.engine.configureStage("ch.01", { enabled: true, threshold: -50, duckingDepth: 10, holdMs: 1000 });
  preamp(env, 20, 0);
  env.at(0); env.engine.tick(0);
  run(env, 0, 1900, function (t) { env.engine.ingestLevel("ch.01", -80, t); });
  assert.equal(env.engine.channel("ch.01")!.headamp, 10);
  run(env, 2000, 2100, function (t) { env.engine.ingestLevel("ch.01", -20, t); });
  assert.equal(env.engine.channel("ch.01")!.headamp, 20, "restaurado sin esperar al cooldown");
});

test("Stage Guard: la histéresis evita restaurar con una señal en el límite", function () {
  const env = make();
  env.engine.configureStage("ch.01", { enabled: true, threshold: -50, duckingDepth: 10, holdMs: 1000, hysteresisDb: 3 });
  preamp(env, 20, 0);
  env.at(0); env.engine.tick(0);
  run(env, 0, 2000, function (t) { env.engine.ingestLevel("ch.01", -80, t); });
  /* −49 dBFS: por encima del umbral (−50) pero dentro de la histéresis (−47): no restaura. */
  run(env, 2100, 3500, function (t) { env.engine.ingestLevel("ch.01", -49, t); });
  assert.equal(env.engine.channel("ch.01")!.headamp, 10);
  /* −46 dBFS: supera la histéresis: restaura. */
  run(env, 3600, 4000, function (t) { env.engine.ingestLevel("ch.01", -46, t); });
  assert.equal(env.engine.channel("ch.01")!.headamp, 20);
});

test("Stage Guard: apagar la guarda estando atenuado restaura", function () {
  const env = make();
  env.engine.configureStage("ch.01", { enabled: true, holdMs: 1000 });
  preamp(env, 20, 0);
  env.at(0); env.engine.tick(0);
  run(env, 0, 2000, function (t) { env.engine.ingestLevel("ch.01", -80, t); });
  assert.equal(env.engine.channel("ch.01")!.headamp, 10, "atenuado");

  env.engine.configureStage("ch.01", { enabled: false });
  run(env, 2100, 2300, function (t) { env.engine.ingestLevel("ch.01", -80, t); });
  assert.equal(env.engine.channel("ch.01")!.headamp, 20, "guarda apagada: restaura");
});

test("Stage Guard: no ataca antes del hold", function () {
  const env = make();
  env.engine.configureStage("ch.01", { enabled: true, holdMs: 1000 });
  preamp(env, 20, 0);
  env.at(0); env.engine.tick(0);
  run(env, 0, 900, function (t) { env.engine.ingestLevel("ch.01", -80, t); });
  assert.equal(env.fake.preamp().length, 0);
});

/* ---------------------------------------------------------------- PreGuard */

test("PreGuard: nivel sostenido sobre el techo baja el previo con cooldown", function () {
  const env = make();
  env.engine.configurePre("ch.01", { enabled: true, ceilingDb: -6 });
  preamp(env, 20, 0);
  run(env, 0, 5000, function (t) { env.engine.ingestLevel("ch.01", -3, t); });
  assert.deepEqual(env.fake.preamp().map(function (c) { return c.db; }), [19.5, 19, 18.5]);
});

test("PreGuard desactivado no toca el previo", function () {
  const env = make();
  preamp(env, 20, 0);
  env.at(0); env.engine.tick(0);
  run(env, 0, 3000, function (t) { env.engine.ingestLevel("ch.01", -1, t); });
  assert.equal(env.fake.calls.length, 0);
});

test("PreGuard: cuando el nivel baja del techo devuelve el previo a su referencia", function () {
  const env = make();
  env.engine.configurePre("ch.01", { enabled: true, ceilingDb: -6, hysteresisDb: 3 });
  preamp(env, 20, 0);
  env.at(0); env.engine.tick(0);
  /* Al límite: protege (19,5 y luego 19 con el cooldown de 2,5 s). */
  run(env, 0, 3000, function (t) { env.engine.ingestLevel("ch.01", -3, t); });
  assert.equal(env.engine.channel("ch.01")!.headamp, 19);
  /* Señal baja: la ventana se vacía de muestras calientes y el previo vuelve a 20. */
  run(env, 3100, 5000, function (t) { env.engine.ingestLevel("ch.01", -30, t); });
  assert.equal(env.engine.channel("ch.01")!.headamp, 20, "vuelve a la referencia");
  assert.equal(env.engine.channel("ch.01")!.preOffset, 0, "PreGuard suelta el desplazamiento");
});

test("PreGuard: la histéresis no deja el previo subiendo y bajando en el límite", function () {
  const env = make();
  env.engine.configurePre("ch.01", { enabled: true, ceilingDb: -6, hysteresisDb: 3 });
  preamp(env, 20, 0);
  env.at(0); env.engine.tick(0);
  run(env, 0, 3000, function (t) { env.engine.ingestLevel("ch.01", -3, t); });
  assert.equal(env.engine.channel("ch.01")!.headamp, 19);
  /* −7 dBFS: por debajo del techo (−6) pero dentro de la banda de histéresis (−9):
     ni protege más ni recupera. */
  run(env, 3100, 9000, function (t) { env.engine.ingestLevel("ch.01", -7, t); });
  assert.equal(env.engine.channel("ch.01")!.headamp, 19, "se mantiene en la banda");
});

test("PreGuard y Stage Guard conviven sobre un objetivo único, sin bucle", function () {
  const env = make();
  env.engine.configureStage("ch.01", { enabled: true, threshold: -50, duckingDepth: 10, holdMs: 1000 });
  env.engine.configurePre("ch.01", { enabled: true, ceilingDb: -6, hysteresisDb: 3 });
  preamp(env, 20, 0);
  env.at(0); env.engine.tick(0);
  const ch = env.engine.channel("ch.01")!;

  /* Fase 1 · silencio: Stage Guard baja; PreGuard no acumula desplazamiento. */
  run(env, 0, 3000, function (t) { env.engine.ingestLevel("ch.01", -80, t); });
  assert.equal(ch.stage.ducked, true);
  assert.equal(ch.headamp, 10, "nominal − 10 dB");
  assert.equal(ch.preOffset, 0, "sin desplazamiento de PreGuard");

  /* Fase 2 · señal fuerte sostenida: Stage Guard restaura y PreGuard protege. */
  run(env, 3100, 12000, function (t) { env.engine.ingestLevel("ch.01", -3, t); });
  assert.equal(ch.stage.ducked, false);
  assert.ok((ch.headamp as number) < 20, "PreGuard protege por debajo del nominal");
  assert.ok(ch.preOffset > 0, "hay desplazamiento de PreGuard");

  /* Sin bucle: una vez asentada la transición, el previo sólo baja (PreGuard). */
  const tail = env.engine.recentEmits()
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
  preamp(env, 20, 0);
  env.engine.ingestLevel("ch.01", -3, 0);
  env.at(0); env.engine.tick(0);
  assert.equal(env.engine.channel("ch.01")!.headamp, 19.5);

  const blocked = preamp(env, 30, 100);
  assert.equal(blocked.reason, "guard-locked");
  assert.equal(env.engine.channel("ch.01")!.headamp, 19.5, "el valor humano se descarta");
  const heads = env.fake.preamp();
  assert.equal(heads[heads.length - 1].db, 19.5, "se reafirma el valor del motor");
  assert.equal(heads.length, 2, "19,5 del ajuste + 19,5 del reafirmado");

  const accepted = preamp(env, 30, 1200);
  assert.equal(accepted.reason, "external");
  assert.equal(env.engine.channel("ch.01")!.headamp, 30, "el bloqueo ya expiró");
});

/* --------------------------------------------------------------- eco propio */

test("un cambio marcado como eco propio no altera el estado ni genera tráfico", function () {
  const env = make({ bus: { enabled: true } });
  env.engine.configurePre("ch.01", { enabled: true, ceilingDb: -6 });
  env.engine.linkBuses("ch.01", [1]);
  env.engine.setBusSend("ch.01", 1, -10);
  preamp(env, 20, 0);
  env.engine.ingestLevel("ch.01", -3, 0);
  env.at(0); env.engine.tick(0);
  assert.equal(env.fake.preamp()[0].db, 19.5);

  const r = env.engine.ingestChange(
    { target: { kind: "preamp", channel: "ch.01" }, db: 19.4, origin: "self" },
    50
  );
  assert.equal(r.accepted, false);
  assert.equal(r.reason, "own-echo");
  assert.equal(env.engine.channel("ch.01")!.headamp, 19.5, "el estado no cambia");

  const before = env.fake.calls.length;
  env.at(100);
  env.engine.ingestLevel("ch.01", -3, 100);
  env.engine.tick(100);
  assert.equal(env.fake.calls.length, before, "ningún envío extra");
});

/* ----------------------------------------------------- normalización base */

test("base RMS: aprende la referencia y sube el fader en una rampa", function () {
  const env = make();
  env.engine.configureBase("ch.01", { mode: "rms", threshold: 5 });
  fader(env, 0, 0);
  run(env, 0, 10000, function (t) { env.engine.ingestLevel("ch.01", -30, t); });
  assert.equal(env.engine.channel("ch.01")!.baseRef, -30);
  assert.equal(env.fake.fader().length, 0);

  run(env, 10100, 22500, function (t) { env.engine.ingestLevel("ch.01", -40, t); });
  const faders = env.fake.fader();
  assert.ok(faders.length >= 15, "rampa de ~20 pasos: " + faders.length);
  const value = env.engine.channel("ch.01")!.fader!;
  assert.ok(value > 9 && value <= 10, "fader subido ~10 dB: " + value);
  assert.equal(env.fake.preamp().length, 0);
});

test("base RMS: una desviación dentro de la tolerancia (5 dB) no se corrige", function () {
  const env = make();
  env.engine.configureBase("ch.01", { mode: "rms", threshold: 5 });
  fader(env, 0, 0);
  run(env, 0, 10000, function (t) { env.engine.ingestLevel("ch.01", -30, t); });
  run(env, 10100, 20000, function (t) { env.engine.ingestLevel("ch.01", -33, t); });
  assert.equal(env.fake.fader().length, 0);
});

test("base RMS: la tolerancia de 3 dB del selector corrige desviaciones de 4 dB", function () {
  const env = make();
  env.engine.configureBase("ch.01", { mode: "rms", threshold: 3 });
  fader(env, 0, 0);
  run(env, 0, 10000, function (t) { env.engine.ingestLevel("ch.01", -30, t); });
  run(env, 10100, 22500, function (t) { env.engine.ingestLevel("ch.01", -34, t); });
  assert.ok(env.fake.fader().length > 0, "4 dB > 3 dB: corrige");
});

test("base LUFS: el objetivo −23 del selector corrige desde −20 (3 dB)", function () {
  const env = make();
  env.engine.configureBase("ch.01", { mode: "lufs", threshold: -23 });
  fader(env, 0, 0);
  run(env, 0, 12500, function (t) { env.engine.ingestLevel("ch.01", -20, t); });
  const value = env.engine.channel("ch.01")!.fader!;
  assert.ok(Math.abs(value - -3) < 0.1, "bajada de −3 dB: " + value);
  assert.equal(env.engine.channel("ch.01")!.base.threshold, -23);
});

test("base LUFS: estima desde el vúmetro y sigue el objetivo −18", function () {
  const env = make();
  env.engine.configureBase("ch.01", { mode: "lufs", threshold: -18 });
  fader(env, 0, 0);
  run(env, 0, 12500, function (t) { env.engine.ingestLevel("ch.01", -25, t); });
  const value = env.engine.channel("ch.01")!.fader!;
  assert.ok(Math.abs(value - 7) < 0.1, "subida de +7 dB: " + value);
});

test("base: un salto anómalo (>15 dB) no se corrige y tras 3 veces bloquea el canal", function () {
  const env = make();
  env.engine.configureBase("ch.01", { mode: "lufs", threshold: -18 });
  fader(env, 0, 0);
  run(env, 0, 30000, function (t) { env.engine.ingestLevel("ch.01", -2, t); });
  const ch = env.engine.channel("ch.01")!;
  assert.equal(env.fake.fader().length, 0, "nada escrito");
  assert.equal(ch.baseLocked, true);
  assert.equal(ch.lastBase, "extreme-jump", "el tercer aviso bloquea el canal");
});

test("base: sin señal no se decide nada", function () {
  const env = make();
  env.engine.configureBase("ch.01", { mode: "lufs", threshold: -18 });
  fader(env, 0, 0);
  run(env, 0, 12000, function (t) { env.engine.ingestLevel("ch.01", -80, t); });
  assert.equal(env.fake.fader().length, 0);
  assert.equal(env.engine.channel("ch.01")!.lastBase, "no-signal");
});

/* ---------------------------------------------------------------- entradas */

test("un cambio de fader distinto del asumido se toma como externo", function () {
  const env = make();
  fader(env, 0, 0);
  const r = fader(env, -5, 10);
  assert.equal(r.accepted, true);
  assert.equal(r.reason, "external");
  assert.equal(env.engine.channel("ch.01")!.fader, -5);
});

test("un canal sin registrar se rechaza sin error", function () {
  const env = make();
  const r = env.engine.ingestChange(
    { target: { kind: "fader", channel: "ch.09" }, db: 0.5, origin: "console" },
    0
  );
  assert.equal(r.accepted, false);
  assert.equal(r.reason, "unknown-channel");
});

test("un previo sin valor numérico se rechaza (el +48 V no es magnitud del motor)", function () {
  const env = make();
  const r = env.engine.ingestChange(
    { target: { kind: "preamp", channel: "ch.01" }, on: true, origin: "console" },
    0
  );
  assert.equal(r.accepted, false);
  assert.equal(r.reason, "not-a-level");
});

test("el ciclo periódico arranca y se detiene sin dejar temporizadores", function () {
  const env = make();
  env.engine.start();
  env.engine.start();
  env.engine.stop();
  env.engine.stop();
  assert.equal(env.engine.status().channels.length, 1);
});

test("el estado publica el diagnóstico del enlace del driver", function () {
  const env = make();
  const st = env.engine.status();
  assert.ok(st.link);
  assert.equal(st.link.connected, true);
});

test("latestLevels publica la última lectura por canal y poda lo viejo", function () {
  const env = make();
  env.engine.ingestLevel("ch.01", -20, 0);
  assert.deepEqual(env.engine.latestLevels(), [{ channel: "ch.01", db: -20 }]);

  /* Una lectura nueva sustituye a la anterior. */
  env.engine.ingestLevel("ch.01", -12, 100);
  assert.deepEqual(env.engine.latestLevels(), [{ channel: "ch.01", db: -12 }]);

  /* Pasado levelRetainMs, la siguiente lectura poda la antigua. */
  env.engine.ingestLevel("ch.01", -6, 2500);
  assert.deepEqual(env.engine.latestLevels(), [{ channel: "ch.01", db: -6 }]);

  /* Un canal sin telemetría no se publica. */
  env.engine.addChannel("ch.02");
  assert.deepEqual(env.engine.latestLevels(), [{ channel: "ch.01", db: -6 }]);
});
