/* Pruebas de la política QoS del contrato (@cuedesk/net-adapter · qos.ts).
 *
 * Lo que se fija: los code points DSCP son los estándar, el mapeo a WMM es el
 * esperado y la construcción de órdenes marca el control (OSC) con EF y no
 * duplica la regla de encolado por clase. */

import test from "node:test";
import assert from "node:assert/strict";

import { DSCP, DEFAULT_QOS, WMM_OF, buildQosCommands, clampDscp, dscpToTos } from "../src/qos.ts";

test("code points DSCP estándar", function () {
  assert.equal(DSCP.CS0, 0);
  assert.equal(DSCP.AF11, 10);
  assert.equal(DSCP.AF41, 34);
  assert.equal(DSCP.EF, 46);
});

test("mapeo a colas WMM", function () {
  assert.equal(WMM_OF.control, "voice");
  assert.equal(WMM_OF.telemetry, "video");
  assert.equal(WMM_OF.bulk, "best-effort");
  assert.equal(WMM_OF.default, "best-effort");
});

test("dscpToTos desplaza 2 bits y acota", function () {
  assert.equal(dscpToTos(46), 184);
  assert.equal(dscpToTos(0), 0);
  assert.equal(dscpToTos(999), (63 << 2) & 0xff);
  assert.equal(clampDscp(-5), 0);
  assert.equal(clampDscp(64), 63);
});

test("la política por defecto da prioridad al control por OSC (10023)", function () {
  const control = DEFAULT_QOS.find(function (p) { return p.class === "control"; });
  assert.ok(control);
  assert.equal(control.udpPort, 10023);
  assert.equal(control.dscp, DSCP.EF);
});

test("buildQosCommands marca DSCP y encola UNA vez", function () {
  const cmds = buildQosCommands(DEFAULT_QOS, { iface: "wlan0" });
  const iptables = cmds.filter(function (c) { return c.cmd === "iptables"; });
  const tc = cmds.filter(function (c) { return c.cmd === "tc"; });

  assert.equal(iptables.length, 1, "sólo el control tiene puerto UDP");
  assert.ok(iptables[0].args.indexOf("--set-dscp") >= 0);
  assert.ok(iptables[0].args.indexOf("46") >= 0);
  assert.ok(iptables[0].args.indexOf("10023") >= 0);
  assert.ok(iptables[0].privileged);
  assert.equal(tc.length, 1, "el encolado es por interfaz, no por clase");
  assert.ok(tc[0].args.indexOf("wlan0") >= 0);
});

test("sin interfaz sólo quedan las marcas DSCP", function () {
  const cmds = buildQosCommands(DEFAULT_QOS);
  assert.ok(cmds.every(function (c) { return c.cmd === "iptables"; }));
});
