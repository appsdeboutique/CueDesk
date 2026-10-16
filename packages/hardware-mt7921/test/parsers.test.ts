/* Pruebas de los traductores puros del driver MT7921K.
 *
 * Se alimentan con salidas REALES (recortadas) de `iw`, `ip` y `ethtool`
 * tomadas de un linux con `mt7921e`. Cubren lo que de verdad rompe: el modo
 * AP, la detección de banda y el `signal:` con corchetes de `station dump`. */

import test from "node:test";
import assert from "node:assert/strict";

import {
  bandOfFreq,
  channelOfFreq,
  generationOf,
  parseEthtoolI,
  parseIpLink,
  parseIwDev,
  parseIwLink,
  parseIwPhyInfo,
  parseStationDump,
  qualityOf,
} from "../src/parsers.ts";

const IW_DEV = [
  "phy#0",
  "\tInterface wlan0",
  "\t\tifindex 3",
  "\t\twdev 0x1",
  "\t\taddr 00:0c:43:aa:bb:cc",
  "\t\ttype managed",
  "\t\ttxpower 20.00 dBm",
].join("\n");

const IW_PHY_MT7921K = [
  "Wiphy phy0",
  "\tmax # scan SSIDs: 4",
  "\tSupported interface modes:",
  "\t\t * IBSS",
  "\t\t * managed",
  "\t\t * AP",
  "\t\t * AP/VLAN",
  "\t\t * monitor",
  "\t\t * P2P-client",
  "\t\t * P2P-GO",
  "\tBand 1:",
  "\t\tCapabilities: 0x19e3",
  "\t\t\tHT20/HT40",
  "\t\t\tHE Iftypes: managed, AP",
  "\t\tFrequencies:",
  "\t\t\t* 2412 MHz [1] (20.0 dBm)",
  "\t\t\t* 2437 MHz [6] (20.0 dBm)",
  "\tBand 2:",
  "\t\tCapabilities: 0x19e3",
  "\t\t\tVHT Capabilities (0x0f825b79):",
  "\t\t\tHE Iftypes: managed, AP",
  "\t\tFrequencies:",
  "\t\t\t* 5180 MHz [36] (20.0 dBm)",
].join("\n");

const IW_LINK_STA = [
  "Connected to 00:0c:43:aa:bb:cc (on wlan0)",
  "\tSSID: Venue-WiFi",
  "\tfreq: 5180",
  "\tRX: 12345 bytes (67 packets)",
  "\tTX: 23456 bytes (89 packets)",
  "\tsignal: -52 dBm",
  "\trx bitrate: 866.6 MBit/s 80MHz VHT-MCS 9 VHT-NSS 2",
  "\ttx bitrate: 866.6 MBit/s 80MHz VHT-MCS 9 VHT-NSS 2",
].join("\n");

const STATION_DUMP = [
  "Station e4:5f:01:aa:bb:01 (on wlan0)",
  "\tinactive time:\t40 ms",
  "\trx bytes:\t1234",
  "\tsignal:  \t-55 [-58, -60] dBm",
  "\tsignal avg:\t-56.0 [-58, -60] dBm",
  "\ttx bitrate:\t286.7 MBit/s VHT-MCS 7 VHT-NSS 2",
  "\trx bitrate:\t260.0 MBit/s VHT-MCS 6 VHT-NSS 2",
  "\tconnected time:\t125 seconds",
].join("\n");

const IP_LINK = "3: wlan0: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 qdisc noqueue state UP mode DORMANT group default qlen 1000\\    link/ether 00:0c:43:aa:bb:cc brd ff:ff:ff:ff:ff:ff";

const ETHTOOL = [
  "driver: mt7921e",
  "version: 6.12.0",
  "firmware-version: ____01151119",
  "bus-info: 0000:01:00.0",
  "supports-statistics: yes",
].join("\n");

test("banda y canal a partir de la frecuencia", function () {
  assert.equal(bandOfFreq(2412), "2.4");
  assert.equal(bandOfFreq(5180), "5");
  assert.equal(bandOfFreq(5955), "6");
  assert.equal(bandOfFreq(1234), null);
  assert.equal(channelOfFreq(2412), 1);
  assert.equal(channelOfFreq(5180), 36);
});

test("generacion Wi-Fi a partir de capacidades del PHY", function () {
  assert.equal(generationOf({ eht: false, he: true, vht: true, ht: true, bands: ["2.4", "5"] }), "Wi-Fi 6");
  assert.equal(generationOf({ eht: false, he: true, vht: true, ht: true, bands: ["2.4", "5", "6"] }), "Wi-Fi 6E");
  assert.equal(generationOf({ eht: true, he: true, vht: true, ht: true, bands: ["2.4", "5", "6"] }), "Wi-Fi 7");
  assert.equal(generationOf({ eht: false, he: false, vht: true, ht: true, bands: ["2.4", "5"] }), "Wi-Fi 5");
});

test("calidad cualitativa por dBm", function () {
  assert.equal(qualityOf(-45), "excellent");
  assert.equal(qualityOf(-58), "good");
  assert.equal(qualityOf(-66), "fair");
  assert.equal(qualityOf(-80), "poor");
  assert.equal(qualityOf(-90), "dead");
  assert.equal(qualityOf(null), "dead");
});

test("parseIwDev encuentra interfaz, phy y mac", function () {
  const entries = parseIwDev(IW_DEV);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].name, "wlan0");
  assert.equal(entries[0].phy, "phy0");
  assert.equal(entries[0].mac, "00:0c:43:aa:bb:cc");
  assert.equal(entries[0].type, "managed");
});

test("parseIwPhyInfo: Wi-Fi 6, 2,4 + 5 GHz y modo AP soportado", function () {
  const info = parseIwPhyInfo(IW_PHY_MT7921K);
  assert.deepEqual(info.bands, ["2.4", "5"]);
  assert.equal(info.he, true);
  assert.equal(info.vht, true);
  assert.equal(info.ht, true);
  assert.equal(info.eht, false);
  assert.equal(info.ap, true);
  assert.equal(info.generation, "Wi-Fi 6");
  assert.ok(info.modes.indexOf("AP") >= 0);
});

test("parseIwLink lee un enlace de estacion", function () {
  const link = parseIwLink(IW_LINK_STA);
  assert.equal(link.connected, true);
  assert.equal(link.bssid, "00:0c:43:aa:bb:cc");
  assert.equal(link.ssid, "Venue-WiFi");
  assert.equal(link.frequencyMhz, 5180);
  assert.equal(link.signalDbm, -52);
  assert.equal(link.txBitrateMbps, 866.6);
  assert.equal(link.rxBitrateMbps, 866.6);
  assert.equal(link.widthMhz, 80);
});

test("parseIwLink reconoce 'Not connected'", function () {
  const link = parseIwLink("Not connected.");
  assert.equal(link.connected, false);
  assert.equal(link.ssid, null);
});

test("parseStationDump lee clientes del AP (signal con corchetes)", function () {
  const stations = parseStationDump(STATION_DUMP);
  assert.equal(stations.length, 1);
  const s = stations[0];
  assert.equal(s.mac, "e4:5f:01:aa:bb:01");
  assert.equal(s.signalDbm, -55);
  assert.equal(s.signalAvgDbm, -56);
  assert.equal(s.txBitrateMbps, 286.7);
  assert.equal(s.rxBitrateMbps, 260);
  assert.equal(s.connectedForMs, 125000);
  assert.equal(s.inactiveMs, 40);
  assert.equal(s.quality, "good");
});

test("parseIpLink lee estado y mac", function () {
  const info = parseIpLink(IP_LINK);
  assert.equal(info.up, true);
  assert.equal(info.state, "UP");
  assert.equal(info.mac, "00:0c:43:aa:bb:cc");
});

test("parseEthtoolI identifica el driver mt7921e", function () {
  const info = parseEthtoolI(ETHTOOL);
  assert.equal(info.driver, "mt7921e");
  assert.equal(info.version, "6.12.0");
  assert.equal(info.bus, "0000:01:00.0");
});
