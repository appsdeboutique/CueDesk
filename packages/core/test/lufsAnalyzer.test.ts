/* Pruebas del analizador de loudness (§1, pistas de reproducción).
 *
 * La referencia de calibración de la EBU R128 es explícita: un seno de 1 kHz
 * con un nivel de −23 dBFS (RMS) debe leerse como −23 LUFS. Es la prueba que
 * dice si el filtro K está bien puesto. */

import test from "node:test";
import assert from "node:assert/strict";

import { createLufsAnalyzer, designKWeighting } from "../src/analysis/lufsAnalyzer.ts";
import { sine } from "./helpers.ts";

const FS = 48000;
const CHUNK = 4800;      // 100 ms

function pushAudio(an, frames) {
  for (let i = 0; i < frames.length; i += CHUNK) {
    an.pushSamples(frames.subarray(i, Math.min(i + CHUNK, frames.length)), FS);
  }
}

test("coeficientes del filtro K a 48 kHz = los de la norma", function () {
  const c = designKWeighting(48000);
  const near = function (a, b) { assert.ok(Math.abs(a - b) < 1e-9, a + " ≈ " + b); };
  near(c.pre.b0, 1.53512485958697);
  near(c.pre.b1, -2.69169618940638);
  near(c.pre.b2, 1.19839281085285);
  near(c.pre.a1, -1.69065929318241);
  near(c.pre.a2, 0.73248077421585);
  near(c.rlb.b0, 1.0);
  near(c.rlb.b1, -2.0);
  near(c.rlb.b2, 1.0);
  near(c.rlb.a1, -1.99004745483398);
  near(c.rlb.a2, 0.99007225036621);
});

test("vía A · seno de 1 kHz a −23 dBFS RMS → −23 LUFS", function () {
  const an = createLufsAnalyzer({ sampleRate: FS });
  pushAudio(an, sine(FS, 5, -23, 1000));
  const v = an.value(5000);
  assert.equal(v.estimated, false, "medida de onda, no estimada");
  assert.ok(Math.abs(v.shortTerm - -23) < 0.25, "short-term " + v.shortTerm);
  assert.ok(Math.abs(v.integrated - -23) < 0.3, "integrado " + v.integrated);
  assert.ok(v.coverage > 0.99, "cobertura " + v.coverage);
});

test("vía A · −20 dBFS RMS → −20 LUFS (la escala es lineal en dB)", function () {
  const an = createLufsAnalyzer({ sampleRate: FS });
  pushAudio(an, sine(FS, 5, -20, 1000));
  const v = an.value(5000);
  assert.ok(Math.abs(v.shortTerm - -20) < 0.25, "short-term " + v.shortTerm);
});

test("vía A · el silencio no entra en el integrado (puerta de −70 LUFS)", function () {
  const an = createLufsAnalyzer({ sampleRate: FS });
  pushAudio(an, sine(FS, 4, -20, 1000));        // material
  pushAudio(an, new Float32Array(FS * 3));      // 3 s de silencio
  const v = an.value(7000);
  assert.ok(v.integrated > -25, "el integrado ignora el silencio: " + v.integrated);
});

test("vía B · sin onda, la envolvente del vúmetro da la estimación marcada", function () {
  const an = createLufsAnalyzer({ sampleRate: FS, windowMs: 3000 });
  for (let t = 0; t <= 3000; t += 100) an.pushLevel(-25, t);
  const v = an.value(3000);
  assert.equal(v.estimated, true, "medida estimada (no hay onda)");
  assert.ok(Math.abs(v.lufs - -25) < 0.05, "estimación " + v.lufs);
  assert.ok(v.coverage > 0.99, "cobertura de la ventana " + v.coverage);
});

test("vía B · el offset de calibración se aplica", function () {
  const an = createLufsAnalyzer({ sampleRate: FS, windowMs: 3000, offsetDb: 2.5 });
  for (let t = 0; t <= 3000; t += 100) an.pushLevel(-25, t);
  assert.ok(Math.abs(an.value(3000).lufs - -22.5) < 0.05);
});

test("vía A manda sobre la vía B cuando hay onda", function () {
  const an = createLufsAnalyzer({ sampleRate: FS, windowMs: 3000 });
  for (let t = 0; t <= 1000; t += 100) an.pushLevel(-35, t);
  pushAudio(an, sine(FS, 4, -20, 1000));
  const v = an.value(5000);
  assert.equal(v.estimated, false);
  assert.ok(Math.abs(v.shortTerm - -20) < 0.3, "short-term " + v.shortTerm);
});

test("reset vacía las dos vías", function () {
  const an = createLufsAnalyzer({ sampleRate: FS });
  pushAudio(an, sine(FS, 4, -20, 1000));
  for (let t = 0; t <= 3000; t += 100) an.pushLevel(-30, t);
  an.reset();
  const v = an.value(4000);
  assert.equal(v.samples, 0);
  assert.equal(v.fresh, null);
  assert.equal(v.estimated, true);
});
