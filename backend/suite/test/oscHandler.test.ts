/* Pruebas del OSCHandler: marca de origen, conversión y filtro de ecos. */

import test from "node:test";
import assert from "node:assert/strict";
import { OSCHandler, toFader, fromFader } from "../oscHandler.ts";
import type { OutboundMessage } from "../types.ts";

function handler(windowMs = 500) {
  const sent: OutboundMessage[] = [];
  let now = 0;
  const h = new OSCHandler({ send: (m: OutboundMessage) => { sent.push(m); } }, {
    now: () => now,
    windowMs: windowMs,
  });
  return { h: h, sent: sent, set: (t: number) => { now = t; } };
}

test("todo mensaje saliente lleva la marca cuedesk-internal", function () {
  const { h, sent } = handler();
  h.send("/ch/01/mix/fader", "fader", 0, 0);
  h.send("/headamp/000/gain", "headamp", 20, 0);
  assert.equal(sent.length, 2);
  for (const m of sent) assert.equal(m.source, "cuedesk-internal");
});

test("el fader se convierte con el taper de la X32 (0 dB = 0,75)", function () {
  const { h, sent } = handler();
  const wire = h.send("/ch/01/mix/fader", "fader", 0, 0);
  assert.equal(wire, 0.75);
  assert.equal(sent[0].value, 0.75);
  assert.ok(Math.abs(fromFader(toFader(-13)) - -13) < 1e-9);
});

test("el previo se envía en dB sin conversión", function () {
  const { h, sent } = handler();
  h.send("/headamp/000/gain", "headamp", 19.5, 0);
  assert.equal(sent[0].value, 19.5);
});

test("un eco exacto de lo escrito se descarta una vez", function () {
  const { h, set } = handler();
  h.send("/headamp/000/gain", "headamp", 19.5, 0);
  set(100);
  assert.equal(h.receive("/headamp/000/gain", 19.5), true);
  assert.equal(h.receive("/headamp/000/gain", 19.5), false, "ya consumido");
});

test("el previo admite el redondeo de la consola (tolerancia 0,5 dB)", function () {
  const { h } = handler();
  h.send("/headamp/000/gain", "headamp", 19.5, 0);
  assert.equal(h.receive("/headamp/000/gain", 19.0), true);
});

test("un valor distinto no es eco", function () {
  const { h } = handler();
  h.send("/headamp/000/gain", "headamp", 19.5, 0);
  assert.equal(h.receive("/headamp/000/gain", 23), false);
  assert.equal(h.pendingCount(), 1);
});

test("un eco fuera de la ventana ya no se reconoce", function () {
  const { h, set } = handler(500);
  h.send("/ch/01/mix/fader", "fader", -3, 0);
  set(800);
  assert.equal(h.receive("/ch/01/mix/fader", toFader(-3)), false);
});

test("estadísticas de envíos y ecos descartados", function () {
  const { h } = handler();
  h.send("/ch/01/mix/fader", "fader", -3, 0);
  h.receive("/ch/01/mix/fader", toFader(-3));
  const s = h.stats();
  assert.equal(s.sent, 1);
  assert.equal(s.echoesDropped, 1);
  assert.equal(s.pending, 0);
});
