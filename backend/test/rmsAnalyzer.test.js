"use strict";

/* Pruebas del analizador de medias RMS (§1, micrófono / línea). */

const test = require("node:test");
const assert = require("node:assert/strict");

const { createRmsAnalyzer } = require("../gainGuard/analyzers/rmsAnalyzer");

const WIN = 10000;
const STEP = 100;      // 10 Hz: de sobra para la ventana

function pushConstant(an, db, fromMs, toMs) {
  for (let t = fromMs; t <= toMs; t += STEP) an.push(db, t);
}

test("constante −20 dBFS durante 10 s → media RMS −20 dBFS", function () {
  const an = createRmsAnalyzer({ windowMs: WIN });
  pushConstant(an, -20, 0, WIN);
  const v = an.value(WIN);
  assert.ok(Math.abs(v.db - -20) < 0.05, "media RMS " + v.db);
  assert.equal(v.samples, WIN / STEP + 1);
  assert.ok(v.coverage > 0.99, "cobertura " + v.coverage);
  assert.equal(v.fresh, WIN);
});

test("dos niveles distintos: la media es la media de POTENCIAS, no de dB", function () {
  const an = createRmsAnalyzer({ windowMs: 1000 });
  /* Mitad a −20 dBFS y mitad a −30 dBFS. Media de potencias:
     10·log10((10^−2 + 10^−3)/2) = −22,59 dBFS (y no −25, que sería la de dB). */
  for (let t = 0; t <= 500; t += 50) an.push(-20, t);
  for (let t = 550; t <= 1000; t += 50) an.push(-30, t);
  const v = an.value(1000);
  const expected = 10 * Math.log10((11 * 0.01 + 10 * 0.001) / 21);
  assert.ok(Math.abs(v.db - expected) < 0.01, "media " + v.db + " vs " + expected);
  /* Y la media de decibelios (−25) sería otra cosa: comprobamos que NO es eso. */
  assert.ok(Math.abs(v.db - -25) > 2, "no debe ser la media de dB");
});

test("silencio (-Infinity) → -Infinity y no NaN", function () {
  const an = createRmsAnalyzer({ windowMs: WIN });
  pushConstant(an, -Infinity, 0, WIN);
  const v = an.value(WIN);
  assert.equal(v.db, -Infinity);
  assert.ok(Number.isNaN(v.db) === false);
});

test("las muestras viejas salen de la ventana", function () {
  const an = createRmsAnalyzer({ windowMs: 1000 });
  pushConstant(an, -10, 0, 1000);
  pushConstant(an, -40, 1001, 2500);
  const v = an.value(2500);
  assert.ok(Math.abs(v.db - -40) < 0.05, "media " + v.db);
  assert.ok(v.samples <= 16, "muestras " + v.samples);
});

test("el paso entre mitades detecta un salto sostenido", function () {
  const an = createRmsAnalyzer({ windowMs: WIN });
  for (let t = 0; t < WIN / 2; t += STEP) an.push(-20, t);
  for (let t = WIN / 2; t <= WIN; t += STEP) an.push(-40, t);
  const v = an.value(WIN);
  assert.ok(v.stepDb !== null, "hay paso");
  assert.ok(Math.abs(v.stepDb - -20) < 0.5, "paso " + v.stepDb);
  assert.ok(Math.abs(v.firstHalfDb - -20) < 0.2, "primera mitad");
  assert.ok(Math.abs(v.secondHalfDb - -40) < 0.2, "segunda mitad");
});

test("sin señal en una mitad, el paso no se inventa", function () {
  const an = createRmsAnalyzer({ windowMs: WIN });
  for (let t = WIN / 2 + STEP; t <= WIN; t += STEP) an.push(-20, t);
  const v = an.value(WIN);
  assert.equal(v.stepDb, null);
});

test("reset deja el analizador vacío", function () {
  const an = createRmsAnalyzer({ windowMs: WIN });
  pushConstant(an, -20, 0, WIN);
  an.reset();
  const v = an.value(WIN);
  assert.equal(v.samples, 0);
  assert.equal(v.fresh, null);
});
