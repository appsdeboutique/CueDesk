/* Pruebas de acústica y alineación de PA (@cuedesk/core).
 *
 * Lo que se comprueba aquí es el DOMINIO: la velocidad del sonido depende de
 * la temperatura, las dos conversiones son inversas y el redondeo es el de
 * campo (2 decimales). Nada de DOM ni de OSC. */

import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_TEMPERATURE_C,
  calculateDelayMs,
  calculateMeters,
  round2,
  speedOfSound,
} from "../src/utils/acoustics.ts";
import {
  createCrossoverFilter,
  createSpeakerZoneProcessing,
  createSystemDelay,
} from "../src/types/pa-alignment.ts";
import type { ActiveRoute } from "../src/types/scene.ts";

function close(actual: number, expected: number, eps: number = 1e-9): void {
  assert.ok(
    Math.abs(actual - expected) <= eps,
    "esperado " + expected + ", recibido " + actual,
  );
}

/* ------------------------------------------------------------ velocidad */

test("la velocidad del sonido a 20 °C es 343.42 m/s", function () {
  close(speedOfSound(20), 343.42);
});

test("la velocidad del sonido sube 0.606 m/s por grado", function () {
  close(speedOfSound(21) - speedOfSound(20), 0.606);
  close(speedOfSound(0), 331.3);
});

test("sin argumento se usa la temperatura de referencia (20 °C)", function () {
  assert.equal(DEFAULT_TEMPERATURE_C, 20);
  close(speedOfSound(), speedOfSound(20));
});

/* -------------------------------------------------------------- retardo */

test("10 m a 20 °C son 29.12 ms", function () {
  assert.equal(calculateDelayMs(10), 29.12);
});

test("la temperatura por defecto es 20 °C", function () {
  assert.equal(calculateDelayMs(10), calculateDelayMs(10, 20));
  assert.equal(calculateMeters(29.12), calculateMeters(29.12, 20));
});

test("más temperatura, menos retardo para la misma distancia", function () {
  assert.ok(calculateDelayMs(20, 40) < calculateDelayMs(20, 0));
  close(calculateDelayMs(20, 0), 60.37);
  close(calculateDelayMs(20, 40), 56.25);
});

test("el redondeo es a 2 decimales", function () {
  assert.equal(calculateDelayMs(1), 2.91);
  assert.equal(round2(2.91188), 2.91);
  assert.equal(round2(-1.005), -1);
});

test("las dos conversiones son inversas", function () {
  /* La ida y vuelta pierde lo que come el redondeo de 2 decimales: 0.01 m son
     ~0.03 ms y 0.01 ms son ~0.003 m. Las tolerancias reflejan ese suelo. */
  [0.5, 3, 10, 25.5].forEach(function (m) {
    close(calculateMeters(calculateDelayMs(m)), m, 0.01);
  });
  [1, 12.5, 73.42].forEach(function (ms) {
    close(calculateDelayMs(calculateMeters(ms)), ms, 0.05);
  });
});

test("una entrada no finita no contamina la escena: devuelve 0", function () {
  assert.equal(calculateDelayMs(Number.NaN), 0);
  assert.equal(calculateDelayMs(Number.POSITIVE_INFINITY), 0);
  assert.equal(calculateMeters(Number.NaN), 0);
  assert.equal(calculateMeters(Number.NEGATIVE_INFINITY), 0);
});

/* -------------------------------------------------------- constructores */

test("createSystemDelay mantiene distancia, ms y temperatura coherentes", function () {
  const d = createSystemDelay(10);
  assert.equal(d.meters, 10);
  assert.equal(d.milliseconds, 29.12);
  assert.equal(d.temperatureC, 20);

  const hot = createSystemDelay(10, 40);
  assert.equal(hot.temperatureC, 40);
  assert.ok(hot.milliseconds < d.milliseconds);
});

test("una zona nueva no altera nada: filtros y limitador apagados", function () {
  const z = createSpeakerZoneProcessing(3, "Sub");
  assert.equal(z.outputId, 3);
  assert.equal(z.zoneLabel, "Sub");
  assert.equal(z.polarityInverted, false);
  assert.deepEqual(z.delay, createSystemDelay(0));
  assert.equal(z.crossover.hpf.enabled, false);
  assert.equal(z.crossover.lpf.enabled, false);
  assert.equal(z.crossover.hpf.frequency, 40);
  assert.equal(z.crossover.lpf.frequency, 16000);
  assert.equal(z.crossover.hpf.slope, 24);
  assert.equal(z.limiter.enabled, false);
  assert.equal(z.limiter.thresholdDb, -6);
  assert.equal(z.limiter.releaseMs, 100);
});

test("createCrossoverFilter acepta overrides tipados", function () {
  const f = createCrossoverFilter({ enabled: true, frequency: 120, type: "Bessel", slope: 12 });
  assert.equal(f.enabled, true);
  assert.equal(f.frequency, 120);
  assert.equal(f.type, "Bessel");
  assert.equal(f.slope, 12);
});

/* ------------------------------------------------------------- escena */

test("ActiveRoute guarda la zona de PA y la conserva en JSON", function () {
  const route: ActiveRoute = {
    outputId: 1,
    source: 4,
    userOut: 169,
    mode: 8,
    speakerZone: createSpeakerZoneProcessing(1, "Top L"),
  };

  const back = JSON.parse(JSON.stringify(route)) as ActiveRoute;
  assert.deepEqual(back, route);
  assert.equal(back.speakerZone && back.speakerZone.delay.milliseconds, 0);
});

test("una ruta sin zona sigue siendo válida y no serializa la clave", function () {
  const route: ActiveRoute = { outputId: 2, source: 0 };
  const json = JSON.stringify(route);
  assert.equal(json, '{"outputId":2,"source":0}');
  assert.equal(route.speakerZone, undefined);
});
