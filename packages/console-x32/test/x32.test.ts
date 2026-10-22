/* Pruebas del driver @cuedesk/console-x32.
 *
 * Es la antigua frontera OSC del backend, ahora aislada en un paquete: el
 * taper, las rutas, los bancos de previo y el filtro de ecos. El motor ya no
 * sabe nada de esto. */

import test from "node:test";
import assert from "node:assert/strict";

import { ConsoleAdapterError } from "@cuedesk/console-adapter";
import type { ControlChange } from "@cuedesk/console-adapter";

import { X32Adapter } from "../src/X32Adapter.ts";
import { faderPath, headampGainPath, headampPhantomPath, parseControlPath, sendPath } from "../src/paths.ts";
import { PREAMP_BANKS, headampIndexOf, resolveHeadampIndex } from "../src/preamps.ts";
import { fromFader, fromLinear, toFader } from "../src/taper.ts";
import { fakeLink } from "./helpers.ts";

function make() {
  const link = fakeLink();
  let now = 0;
  const adapter = new X32Adapter({ link: link, now: () => now });
  const changes: ControlChange[] = [];
  adapter.onChanges(function (c) { changes.push(c); });
  return {
    link: link,
    adapter: adapter,
    changes: changes,
    at: (t: number) => { now = t; },
  };
}

/* --------------------------------------------------------------- taper */

test("taper: 0 dB = 0,75 y la vuelta respeta la curva", function () {
  assert.equal(toFader(0), 0.75);
  assert.equal(toFader(-Infinity), 0);
  for (const db of [-60, -30, -10, 0, 6]) {
    assert.ok(Math.abs(fromFader(toFader(db)) - db) < 1e-9, "vuelta de " + db);
  }
});

test("vúmetro lineal: 1,0 irradia 0 dBFS y 0 es −∞", function () {
  assert.ok(Math.abs(fromLinear(1) - 0) < 1e-12);
  assert.equal(fromLinear(0), -Infinity);
  assert.ok(Math.abs(fromLinear(0.5) - -6.0206) < 0.001);
});

/* ------------------------------------------------------------- rutas */

test("las rutas de la X32 se construyen en un solo sitio", function () {
  assert.equal(faderPath(1), "/ch/01/mix/fader");
  assert.equal(sendPath(9, 3), "/ch/09/mix/03/level");
  assert.equal(headampGainPath(0), "/headamp/000/gain");
  assert.equal(headampGainPath(80), "/headamp/080/gain");
  assert.equal(headampPhantomPath(32), "/headamp/032/phantom");
});

test("las rutas entrantes se leen y lo ajeno no encaja", function () {
  assert.deepEqual(parseControlPath("/ch/01/mix/fader"), { kind: "fader", channelNumber: 1 });
  assert.deepEqual(parseControlPath("/ch/09/mix/03/level"), { kind: "send", channelNumber: 9, bus: 3 });
  assert.deepEqual(parseControlPath("/headamp/032/gain"), { kind: "headamp-gain", headampIndex: 32 });
  assert.deepEqual(parseControlPath("/headamp/080/phantom"), { kind: "headamp-phantom", headampIndex: 80 });
  assert.equal(parseControlPath("/aux/01/mix/fader"), null);
  assert.equal(parseControlPath("/ch/01/mix/fader/"), null);
});

/* ----------------------------------------------------------- bancos */

test("el driver publica los tres bancos de previo", function () {
  const { adapter } = make();
  assert.deepEqual(adapter.capabilities.preampBanks.map(function (b) { return b.id; }), ["local", "netprimary", "netsecondary"]);
  assert.equal(adapter.capabilities.preamp, "headamp");
  assert.equal(adapter.capabilities.sendsArePostEq, true);
});

test("el índice del previo sale del banco y del canal", function () {
  assert.equal(headampIndexOf("local", 1), 0);
  assert.equal(headampIndexOf("local", 32), 31);
  assert.equal(headampIndexOf("netprimary", 1), 32);
  assert.equal(headampIndexOf("netprimary", 32), 63);
  assert.equal(headampIndexOf("netsecondary", 9), 88);
});

test("vuelta atrás por rango: cada índice es de un banco", function () {
  assert.deepEqual(resolveHeadampIndex(0), { bankId: "local", entry: 1 });
  assert.deepEqual(resolveHeadampIndex(31), { bankId: "local", entry: 32 });
  assert.deepEqual(resolveHeadampIndex(32), { bankId: "netprimary", entry: 1 });
  assert.deepEqual(resolveHeadampIndex(88), { bankId: "netsecondary", entry: 9 });
  /* Los puertos NET exponen 48, pero CueDesk gobierna 32: 64…79 quedan fuera. */
  assert.equal(resolveHeadampIndex(64), null);
  assert.equal(resolveHeadampIndex(79), null);
  assert.deepEqual(resolveHeadampIndex(80), { bankId: "netsecondary", entry: 1 });
  assert.equal(resolveHeadampIndex(200), null);
});

test("por defecto el canal gobierna el previo local", async function () {
  const { adapter, link } = make();
  await adapter.connect();
  assert.equal(adapter.preampBankOf("ch.01"), "local");
  assert.deepEqual(adapter.preampRoutingOf("ch.01"), { bankId: "local", index: 0 });
  adapter.setPreampGain("ch.01", 20);
  assert.deepEqual(link.sent[0], { path: "/headamp/000/gain", value: 20, type: "f" });
});

test("asignar Net Primary direcciona el previo del otro banco", async function () {
  const { adapter, link } = make();
  await adapter.connect();
  adapter.assignPreampBank("ch.01", "netprimary");
  assert.deepEqual(adapter.preampRoutingOf("ch.01"), { bankId: "netprimary", index: 32 });
  adapter.assignPreampBank("ch.09", "netsecondary");
  assert.deepEqual(adapter.preampRoutingOf("ch.09"), { bankId: "netsecondary", index: 88 });

  adapter.setPreampGain("ch.01", 19.5);
  assert.deepEqual(link.sent[0], { path: "/headamp/032/gain", value: 19.5, type: "f" });
});

test("un banco desconocido se rechaza", async function () {
  const { adapter } = make();
  await adapter.connect();
  assert.throws(function () { adapter.assignPreampBank("ch.01", "netc"); }, ConsoleAdapterError);
});

/* ------------------------------------------------------- dominio ⇄ consola */

test("los cambios llegan en dominio, no en rutas", async function () {
  const { adapter, link } = make();
  const changes: ControlChange[] = [];
  adapter.onChanges(function (c) { changes.push(c); });
  await adapter.connect();

  link.receive("/headamp/000/gain", 20);
  assert.deepEqual(changes[0], { target: { kind: "preamp", channel: "ch.01" }, db: 20, origin: "console" });

  link.receive("/ch/01/mix/fader", 0.75);
  const fader = changes[1].target.kind === "fader" ? changes[1] : null;
  assert.ok(fader);
  assert.ok(Math.abs((changes[1].db as number) - 0) < 1e-9);

  link.receive("/ch/09/mix/03/level", toFader(-6));
  assert.deepEqual(changes[2].target, { kind: "send", channel: "ch.09", bus: 3 });
  assert.ok(Math.abs((changes[2].db as number) - -6) < 1e-9);
});

test("el previo de otro banco no es de este canal", async function () {
  const { adapter, link } = make();
  const changes: ControlChange[] = [];
  adapter.onChanges(function (c) { changes.push(c); });
  await adapter.connect();
  adapter.assignPreampBank("ch.01", "netprimary");

  link.receive("/headamp/000/gain", 20);
  assert.equal(changes.length, 0, "el previo local ya no es del canal");

  link.receive("/headamp/032/gain", 20);
  assert.equal(changes.length, 1);
  assert.deepEqual(changes[0].target, { kind: "preamp", channel: "ch.01" });
});

test("el fader y el envío se envían por el taper", async function () {
  const { adapter, link } = make();
  await adapter.connect();
  adapter.setChannelFader("ch.01", 0);
  adapter.setChannelSend("ch.01", 3, -10);
  assert.deepEqual(link.sent[0], { path: "/ch/01/mix/fader", value: toFader(0), type: "f" });
  assert.deepEqual(link.sent[1], { path: "/ch/01/mix/03/level", value: toFader(-10), type: "f" });
});

/* El puente de la interfaz (pan, nombre, colour, routing…) usa writeRaw: pasa
   por el driver para que su eco también se descarte, en vez de leerse como un
   gesto humano. */

test("el puente escribe rutas crudas y su eco se descarta", async function () {
  const { adapter, link, changes } = make();
  await adapter.connect();

  /* Numérico: tipo "f", tolerancia de fader. */
  adapter.writeRaw("/ch/01/mix/pan", [-24]);
  assert.deepEqual(link.sent[0], { path: "/ch/01/mix/pan", value: -24, type: "f" });
  link.receive("/ch/01/mix/pan", -24);
  assert.equal(changes.length, 0, "el eco de una escritura cruda no llega al motor");

  /* El previo admite el redondeo de la consola (0,5 dB) también por el puente. */
  adapter.writeRaw("/headamp/000/gain", [19.5]);
  link.receive("/headamp/000/gain", 19.0);
  assert.equal(changes.length, 0, "19,0 es el eco redondeado de 19,5");

  /* Un valor distinto sí es un gesto humano. */
  link.receive("/headamp/000/gain", 24);
  assert.equal(changes.length, 1);

  /* Texto (nombre): sin magnitud que casar, pero se envía igual. */
  adapter.writeRaw("/ch/01/config/name", ["Voz"]);
  assert.deepEqual(link.last(), { path: "/ch/01/config/name", value: "Voz", type: "s" });
});

test("el puente rechaza rutas no OSC y argumentos no numéricos", async function () {
  const { adapter } = make();
  await adapter.connect();
  assert.throws(function () { adapter.writeRaw("ch/01/mix/pan", [0]); }, ConsoleAdapterError);
  assert.throws(function () { adapter.writeRaw("/ch/01/mix/pan", [{}]); }, ConsoleAdapterError);
});

/* -------------------------------------------------------------- ecos */

test("el eco de lo escrito se descarta una vez y caduca", async function () {
  let now = 0;
  const link = fakeLink();
  const adapter = new X32Adapter({ link: link, now: () => now });
  const changes: ControlChange[] = [];
  adapter.onChanges(function (c) { changes.push(c); });
  await adapter.connect();

  adapter.setPreampGain("ch.01", 19.5);
  link.receive("/headamp/000/gain", 19.5);
  assert.equal(changes.length, 0, "eco: no llega al motor");

  /* Fuera de la ventana el mismo valor ya es un cambio humano. */
  now = 800;
  link.receive("/headamp/000/gain", 19.5);
  assert.equal(changes.length, 1);
});

test("el previo admite el redondeo de la consola (0,5 dB)", async function () {
  const link = fakeLink();
  const adapter = new X32Adapter({ link: link, now: () => 0 });
  const changes: ControlChange[] = [];
  adapter.onChanges(function (c) { changes.push(c); });
  await adapter.connect();
  adapter.setPreampGain("ch.01", 19.5);

  link.receive("/headamp/000/gain", 19.0);
  assert.equal(changes.length, 0, "19,0 es el eco redondeado de 19,5");

  link.receive("/headamp/000/gain", 23);
  assert.equal(changes.length, 1, "23 dB no es eco");
});

test("el fader se reconoce por valor, no por posición", async function () {
  const link = fakeLink();
  const adapter = new X32Adapter({ link: link, now: () => 0 });
  const changes: ControlChange[] = [];
  adapter.onChanges(function (c) { changes.push(c); });
  await adapter.connect();
  adapter.setChannelFader("ch.01", -3);

  link.receive("/ch/01/mix/fader", toFader(-3));
  assert.equal(changes.length, 0);
  link.receive("/ch/01/mix/fader", toFader(-6));
  assert.equal(changes.length, 1);
  assert.equal(changes[0].db, -6);
});

test("el phantom entrante también es un cambio de previo", async function () {
  const { adapter, link } = make();
  const changes: ControlChange[] = [];
  adapter.onChanges(function (c) { changes.push(c); });
  await adapter.connect();
  link.receive("/headamp/000/phantom", 1);
  assert.deepEqual(changes[0], { target: { kind: "preamp", channel: "ch.01" }, on: true, origin: "console" });
});

/* ----------------------------------------------------------- contrato */

test("un canal fuera del contrato se rechaza", async function () {
  const { adapter } = make();
  await adapter.connect();
  assert.throws(function () { adapter.setPreampGain("ch.99", 0); }, ConsoleAdapterError);
  assert.throws(function () { adapter.setChannelFader("canal 1", 0); }, ConsoleAdapterError);
});

test("un bus fuera de rango se rechaza", async function () {
  const { adapter } = make();
  await adapter.connect();
  assert.throws(function () { adapter.setChannelSend("ch.01", 17, -6); }, ConsoleAdapterError);
});

test("la telemetría de 32 canales se reparte en dB", async function () {
  const { adapter, link } = make();
  const frames: Array<{ levels: Array<{ channel: string; db: number }> }> = [];
  adapter.onLevels(function (f) {
    frames.push({ levels: f.levels as Array<{ channel: string; db: number }> });
  });
  await adapter.connect();

  /* El `/meters/1` de la X32 llega en LINEAL (1,0 = 0 dBFS). */
  const list: number[] = [];
  for (let i = 0; i < 32; i++) list.push(Math.pow(10, (-10 - i) / 20));
  link.receive("/meters/1", list);

  assert.equal(frames.length, 1);
  assert.equal(frames[0].levels.length, 32);
  assert.ok(Math.abs(frames[0].levels[0].db - -10) < 1e-9, "ch.01 " + frames[0].levels[0].db);
  assert.ok(Math.abs(frames[0].levels[31].db - -41) < 1e-9, "ch.32 " + frames[0].levels[31].db);
});

test("una trama de metros incompleta se ignora", async function () {
  const { adapter, link } = make();
  const frames: unknown[] = [];
  adapter.onLevels(function (f) { frames.push(f); });
  await adapter.connect();
  link.receive("/meters/1", [0.5, 1]);
  assert.equal(frames.length, 0);
});

test("el phantom se escribe en el índice del banco correcto", async function () {
  const { adapter, link } = make();
  await adapter.connect();
  adapter.assignPreampBank("ch.09", "netsecondary");
  adapter.setPreampPhantom("ch.09", true);
  assert.deepEqual(link.sent[0], { path: "/headamp/088/phantom", value: 1, type: "i" });
});

test("el enlace reporta su estado", async function () {
  const { adapter } = make();
  await adapter.connect();
  adapter.setPreampGain("ch.01", 20);
  const st = adapter.linkStatus();
  assert.equal(st.sent, 1);
  assert.equal(st.echoesDropped, 0);
  assert.equal(st.echoWindowMs, 500);
  assert.equal(st.connected, true);
});

test("desconectar deja de escuchar", async function () {
  const { adapter, link } = make();
  const changes: ControlChange[] = [];
  adapter.onChanges(function (c) { changes.push(c); });
  await adapter.connect();
  await adapter.disconnect();
  link.receive("/headamp/000/gain", 20);
  assert.equal(changes.length, 0);
});
