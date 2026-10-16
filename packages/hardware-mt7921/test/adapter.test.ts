/* Pruebas del driver MT7921K con un ejecutor FALSO (sin shell).
 *
 * Se comprueba lo que la arquitectura promete: modo AP con clientes, modo
 * estación, QoS y degradación honesta cuando no hay radio (`iw` ausente). */

import test from "node:test";
import assert from "node:assert/strict";

import { Mt7921Adapter } from "../src/Mt7921Adapter.ts";
import type { CommandResult, CommandRunner } from "../src/runner.ts";

const IW_DEV = "phy#0\n\tInterface wlan0\n\t\taddr 00:0c:43:aa:bb:cc\n\t\ttype AP\n";
const IW_PHY = [
  "Wiphy phy0",
  "\tSupported interface modes:",
  "\t\t * managed",
  "\t\t * AP",
  "\tBand 1:",
  "\t\t\tHE Iftypes: managed, AP",
  "\t\t\t* 2412 MHz [1] (20.0 dBm)",
  "\tBand 2:",
  "\t\t\tVHT Capabilities (0x0f825b79):",
  "\t\t\tHE Iftypes: managed, AP",
  "\t\t\t* 5180 MHz [36] (20.0 dBm)",
].join("\n");
const IP_LINK = "3: wlan0: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 qdisc noqueue state UP\\    link/ether 00:0c:43:aa:bb:cc";
const STATION_DUMP = "Station e4:5f:01:aa:bb:01 (on wlan0)\n\tsignal:  \t-55 [-58, -60] dBm\n\ttx bitrate:\t286.7 MBit/s\n";
const IW_LINK = "Connected to 00:0c:43:aa:bb:cc (on wlan0)\n\tSSID: Venue-WiFi\n\tfreq: 5180\n\tsignal: -52 dBm\n\ttx bitrate: 866.6 MBit/s 80MHz\n";

/** Ejecutor falso: responde por firma "cmd arg arg". Registra lo ejecutado. */
function fakeRunner(map: Record<string, { code?: number; stdout?: string }>): { runner: CommandRunner; seen: string[] } {
  const seen: string[] = [];
  const runner: CommandRunner = {
    async run(cmd: string, args: string[]): Promise<CommandResult> {
      const key = [cmd].concat(args).join(" ");
      seen.push(key);
      const hit = map[key];
      if (!hit) return { code: 127, stdout: "", stderr: "not found", error: "not found" };
      return { code: hit.code === undefined ? 0 : hit.code, stdout: hit.stdout || "", stderr: "" };
    },
  };
  return { runner: runner, seen: seen };
}

const AP_MAP = {
  "iw dev": { stdout: IW_DEV },
  "ethtool -i wlan0": { stdout: "driver: mt7921e\nversion: 6.12.0\nbus-info: 0000:01:00.0\n" },
  "ip -o link show wlan0": { stdout: IP_LINK },
  "iw phy phy0 info": { stdout: IW_PHY },
  "iw dev wlan0 station dump": { stdout: STATION_DUMP },
  "bluetoothctl --version": { code: 127 },
};

test("modo AP: publica capacidades, clientes y salud", async function () {
  const fake = fakeRunner(AP_MAP);
  const net = new Mt7921Adapter({ iface: "wlan0", role: "ap", runner: fake.runner, now: () => 1000 });
  await net.start();
  const snap = await net.collect();

  assert.equal(net.simulated, false);
  assert.equal(snap.source.id, "mt7921");
  assert.equal(snap.source.simulated, false);
  assert.equal(snap.interfaces.length, 1);

  const iface = snap.interfaces[0];
  assert.equal(iface.name, "wlan0");
  assert.equal(iface.driver, "mt7921e");
  assert.equal(iface.vendor, "MediaTek");
  assert.equal(iface.model, "MT7921K");
  assert.equal(iface.generation, "Wi-Fi 6");
  assert.equal(iface.apSupported, true);
  assert.equal(iface.role, "ap");
  assert.equal(iface.up, true);
  assert.deepEqual(iface.bands, ["2.4", "5"]);

  /* Wi-Fi 6 ⇒ sin MLO, pero el campo se publica por contrato. */
  assert.equal(iface.mlo.supported, false);
  assert.equal(iface.mlo.active, false);

  assert.equal(iface.stations.length, 1);
  assert.equal(iface.stations[0].mac, "e4:5f:01:aa:bb:01");
  assert.equal(iface.stations[0].signalDbm, -55);

  assert.equal(snap.health.status, "up");
  assert.equal(snap.health.clients, 1);
  assert.equal(snap.bluetooth.available, false);
});

test("modo estación: publica el enlace observado", async function () {
  const map = Object.assign({}, AP_MAP, {
    "iw dev wlan0 link": { stdout: IW_LINK },
  });
  const fake = fakeRunner(map);
  const net = new Mt7921Adapter({ iface: "wlan0", role: "station", runner: fake.runner, now: () => 2000 });
  await net.start();
  const snap = await net.collect();

  const iface = snap.interfaces[0];
  assert.equal(iface.role, "station");
  assert.equal(iface.link.connected, true);
  assert.equal(iface.link.ssid, "Venue-WiFi");
  assert.equal(iface.link.band, "5");
  assert.equal(iface.link.signalDbm, -52);
  assert.equal(iface.link.snrDb, null);
  assert.equal(snap.health.rssiDbm, -52);
  assert.equal(snap.health.clients, 0);
});

test("sin radio (iw ausente): degrada a 'absent' sin romper", async function () {
  const fake = fakeRunner({});
  const net = new Mt7921Adapter({ iface: "wlan0", runner: fake.runner });
  await net.start();
  const snap = await net.collect();

  assert.equal(snap.interfaces.length, 0);
  assert.equal(snap.health.status, "absent");
  assert.equal(snap.source.id, "mt7921");
  const st = net.status();
  assert.equal(st.available, false);
  assert.equal(typeof st.lastError, "string");
});

test("setBand intenta 'iw set freq' y registra el resultado", async function () {
  const fake = fakeRunner({
    "iw dev": { stdout: IW_DEV },
    "iw dev wlan0 set freq 5180": { stdout: "" },
  });
  const net = new Mt7921Adapter({ iface: "wlan0", role: "station", runner: fake.runner });
  await net.start();
  await net.setBand("wlan0", "5");
  assert.ok(fake.seen.indexOf("iw dev wlan0 set freq 5180") >= 0);
  assert.equal(net.status().lastError, null);
});

test("applyQos marca DSCP para el control (puerto 10023)", async function () {
  const seen: string[] = [];
  const okRunner: CommandRunner = {
    async run(cmd: string, args: string[]): Promise<CommandResult> {
      seen.push([cmd].concat(args).join(" "));
      return { code: 0, stdout: "", stderr: "" };
    },
  };
  const net = new Mt7921Adapter({ iface: "wlan0", role: "ap", runner: okRunner });
  await net.start();
  const result = await net.applyQos([
    { class: "control", dscp: 46, wmm: "voice", udpPort: 10023, description: "OSC" },
  ]);
  assert.equal(result.applied, true);
  assert.deepEqual(result.errors, []);
  assert.ok(seen.some(function (c) { return c.indexOf("--set-dscp 46") >= 0; }));
  assert.ok(seen.some(function (c) { return c.indexOf("--dport 10023") >= 0; }));
  assert.ok(seen.some(function (c) { return c.indexOf("tc qdisc") >= 0; }));
});
