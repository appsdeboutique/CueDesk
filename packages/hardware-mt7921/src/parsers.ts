/* ==========================================================================
 * CueDesk — @cuedesk/hardware-mt7921 · parsers.ts
 * --------------------------------------------------------------------------
 * Traductores PUROS de la salida de las herramientas estándar de Linux a
 * dominio. No ejecutan nada: reciben texto y devuelven datos. Toda la
 * fragilidad del formato de `iw`/`ip`/`ethtool` vive aquí, aislada y cubierta
 * con fixtures en las pruebas.
 *
 * Se usan expresiones TOLERANTES a propósito: `iw dev <if> link` imprime
 * `signal: -42 dBm`, pero `iw dev <if> station dump` imprime
 * `signal:  -42 [-45, -48] dBm`. Un único patrón debe leer ambos.
 *
 * MT7921K (mt76 / mt7921e): Wi-Fi 6 (802.11ax), bandas 2,4 + 5 GHz, MODO AP
 * soportado por hostapd, Bluetooth 5.2. NO hay MLO (eso es Wi-Fi 7); el campo
 * `mlo` del contrato se publica igualmente y aquí vale `supported:false`.
 * ========================================================================== */

import type { LinkQuality, WifiBand, WifiGeneration, WifiStation } from "@cuedesk/net-adapter";

export interface IwDevEntry {
  name: string;
  phy: string | null;
  mac: string | null;
  type: string | null;
}

export interface MloLinkBlock {
  index: number;
  frequencyMhz: number | null;
  signalDbm: number | null;
  txBitrateMbps: number | null;
  rxBitrateMbps: number | null;
  widthMhz: number | null;
}

export interface IwLinkInfo {
  connected: boolean;
  ssid: string | null;
  bssid: string | null;
  frequencyMhz: number | null;
  signalDbm: number | null;
  noiseDbm: number | null;
  txBitrateMbps: number | null;
  rxBitrateMbps: number | null;
  widthMhz: number | null;
  /** Bloques `link N:` si el firmware/kernel los publica (Wi-Fi 7). */
  links: MloLinkBlock[];
}

export interface IwPhyInfo {
  bands: WifiBand[];
  /** EHT ⇒ 802.11be (Wi-Fi 7). */
  eht: boolean;
  /** HE ⇒ 802.11ax (Wi-Fi 6 / 6E). */
  he: boolean;
  /** VHT ⇒ 802.11ac (Wi-Fi 5). */
  vht: boolean;
  /** HT ⇒ 802.11n (Wi-Fi 4). */
  ht: boolean;
  /** La radio anuncia modo AP en "Supported interface modes". */
  ap: boolean;
  modes: string[];
  generation: WifiGeneration | null;
}

export interface IpLinkInfo {
  up: boolean;
  state: string | null;
  mac: string | null;
}

/* --------------------------------------------------------------- utilidades */

/** Banda a partir de la frecuencia (MHz). */
export function bandOfFreq(mhz: number): WifiBand | null {
  if (!Number.isFinite(mhz)) return null;
  if (mhz >= 2400 && mhz <= 2500) return "2.4";
  if (mhz >= 5150 && mhz <= 5895) return "5";
  if (mhz >= 5925 && mhz <= 7125) return "6";
  return null;
}

/** Número de canal a partir de la frecuencia (fórmula 802.11). */
export function channelOfFreq(mhz: number): number {
  if (mhz >= 2400 && mhz <= 2500) return Math.round((mhz - 2407) / 5);
  if (mhz >= 5150 && mhz <= 5895) return Math.round((mhz - 5000) / 5);
  if (mhz >= 5925 && mhz <= 7125) return Math.round((mhz - 5950) / 5);
  return 0;
}

/** "1200.9 MBit/s 160MHz ..." → 1200.9 */
export function mbpsOf(text: string): number | null {
  const m = /([\d.]+)\s*MBit\/s/i.exec(text);
  return m ? Number(m[1]) : null;
}

/** "... 160MHz ..." / "320MHz" → 160 / 320 */
export function widthOf(text: string): number | null {
  const m = /(\d+)\s*MHz/.exec(text);
  return m ? Number(m[1]) : null;
}

/** dBm → valoración cualitativa (la decide el driver, la pinta la UI). */
export function qualityOf(signalDbm: number | null): LinkQuality {
  if (signalDbm === null || !Number.isFinite(signalDbm)) return "dead";
  if (signalDbm >= -50) return "excellent";
  if (signalDbm >= -60) return "good";
  if (signalDbm >= -70) return "fair";
  if (signalDbm > -85) return "poor";
  return "dead";
}

/** Generación Wi-Fi a partir de las capacidades del PHY. */
export function generationOf(info: { eht: boolean; he: boolean; vht: boolean; ht: boolean; bands: WifiBand[] }): WifiGeneration | null {
  if (info.eht) return "Wi-Fi 7";
  if (info.he) return info.bands.indexOf("6") >= 0 ? "Wi-Fi 6E" : "Wi-Fi 6";
  if (info.vht) return "Wi-Fi 5";
  if (info.ht) return "Wi-Fi 4";
  return null;
}

/* ------------------------------------------------------------------ iw dev */

export function parseIwDev(stdout: string): IwDevEntry[] {
  const out: IwDevEntry[] = [];
  let phy: string | null = null;
  let cur: IwDevEntry | null = null;
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    const phyM = /^phy#(\d+)/.exec(line);
    if (phyM) { phy = "phy" + phyM[1]; continue; }
    const ifM = /^Interface\s+(\S+)/.exec(line);
    if (ifM) {
      cur = { name: ifM[1], phy: phy, mac: null, type: null };
      out.push(cur);
      continue;
    }
    if (!cur) continue;
    const addrM = /^addr\s+(\S+)/.exec(line);
    if (addrM) { cur.mac = addrM[1]; continue; }
    const typeM = /^type\s+(\S+)/.exec(line);
    if (typeM) { cur.type = typeM[1]; continue; }
  }
  return out;
}

/* ----------------------------------------------------------------- iw link */

export function parseIwLink(stdout: string): IwLinkInfo {
  const info: IwLinkInfo = {
    connected: false,
    ssid: null,
    bssid: null,
    frequencyMhz: null,
    signalDbm: null,
    noiseDbm: null,
    txBitrateMbps: null,
    rxBitrateMbps: null,
    widthMhz: null,
    links: [],
  };
  if (!/Connected to/i.test(stdout)) return info;

  let linkIndex: number | null = null;
  const blocks = info.links;
  const block = function (idx: number): MloLinkBlock {
    let b = blocks.find(function (x) { return x.index === idx; });
    if (!b) {
      b = { index: idx, frequencyMhz: null, signalDbm: null, txBitrateMbps: null, rxBitrateMbps: null, widthMhz: null };
      blocks.push(b);
    }
    return b;
  };

  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    const connM = /^Connected to\s+(\S+)/i.exec(line);
    if (connM) { info.connected = true; info.bssid = connM[1]; continue; }
    const linkM = /^link\s+(\d+):/i.exec(line);
    if (linkM) { linkIndex = Number(linkM[1]); block(linkIndex); continue; }
    const ssidM = /^SSID:\s*(.*)$/i.exec(line);
    if (ssidM) { info.ssid = ssidM[1].trim() || null; continue; }
    const freqM = /^freq:\s*(\d+)/i.exec(line);
    if (freqM) {
      if (linkIndex === null) info.frequencyMhz = Number(freqM[1]); else block(linkIndex).frequencyMhz = Number(freqM[1]);
      continue;
    }
    const sigM = /^signal:\s*(-?\d+)/i.exec(line);
    if (sigM) {
      if (linkIndex === null) info.signalDbm = Number(sigM[1]); else block(linkIndex).signalDbm = Number(sigM[1]);
      continue;
    }
    const noiseM = /^noise:\s*(-?\d+)/i.exec(line);
    if (noiseM && linkIndex === null) { info.noiseDbm = Number(noiseM[1]); continue; }
    const rxM = /^rx bitrate:\s*(.+)$/i.exec(line);
    if (rxM) {
      const v = mbpsOf(rxM[1]); const w = widthOf(rxM[1]);
      if (linkIndex === null) { info.rxBitrateMbps = v; info.widthMhz = info.widthMhz || w; }
      else { block(linkIndex).rxBitrateMbps = v; block(linkIndex).widthMhz = block(linkIndex).widthMhz || w; }
      continue;
    }
    const txM = /^tx bitrate:\s*(.+)$/i.exec(line);
    if (txM) {
      const v = mbpsOf(txM[1]); const w = widthOf(txM[1]);
      if (linkIndex === null) { info.txBitrateMbps = v; info.widthMhz = info.widthMhz || w; }
      else { block(linkIndex).txBitrateMbps = v; block(linkIndex).widthMhz = block(linkIndex).widthMhz || w; }
      continue;
    }
  }
  info.links = blocks.sort(function (a, b) { return a.index - b.index; });
  return info;
}

/* ---------------------------------------------------------------- iw phy */

export function parseIwPhyInfo(stdout: string): IwPhyInfo {
  const bands: WifiBand[] = [];
  const addBand = function (b: WifiBand | null): void {
    if (b && bands.indexOf(b) < 0) bands.push(b);
  };

  const modes: string[] = [];
  let inModes = false;
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();

    if (/^Supported interface modes:/i.test(line)) { inModes = true; continue; }
    if (inModes) {
      const m = /^\*\s*(\S+)/.exec(line);
      if (m) { modes.push(m[1]); continue; }
      if (line !== "") inModes = false;
    }
    /* El kernel etiqueta: Band 1 = 2,4 GHz · Band 2 = 5 GHz · Band 4 = 6 GHz. */
    const bandM = /^Band\s+(\d+):/i.exec(line);
    if (bandM) {
      const n = Number(bandM[1]);
      if (n === 1) addBand("2.4");
      else if (n === 2) addBand("5");
      else if (n === 4) addBand("6");
      continue;
    }
    /* Refuerzo por frecuencias: hay kernels que no rotulan la banda. */
    const fM = /(\d{4,5})\s*MHz/.exec(line);
    if (fM) addBand(bandOfFreq(Number(fM[1])));
  }

  const eht = /\bEHT\d*/.test(stdout);
  const he = /\bHE\d*/.test(stdout);
  const vht = /\bVHT\d*/.test(stdout);
  const ht = /\bHT\d*/.test(stdout);
  const ap = modes.indexOf("AP") >= 0;
  return {
    bands: bands,
    eht: eht,
    he: he,
    vht: vht,
    ht: ht,
    ap: ap,
    modes: modes,
    generation: generationOf({ eht: eht, he: he, vht: vht, ht: ht, bands: bands }),
  };
}

/* ---------------------------------------------------------------- ip link */

export function parseIpLink(stdout: string): IpLinkInfo {
  let up = false;
  let state: string | null = null;
  let mac: string | null = null;
  const stateM = /\bstate\s+(\w+)/i.exec(stdout);
  if (stateM) state = stateM[1].toUpperCase();
  const flagsM = /<([^>]*)>/.exec(stdout);
  if (flagsM) up = flagsM[1].split(",").indexOf("UP") >= 0;
  const macM = /\blink\/ether\s+([0-9a-f:]{17})/i.exec(stdout);
  if (macM) mac = macM[1].toLowerCase();
  return { up: up, state: state, mac: mac };
}

/* ------------------------------------------------ clientes del AP (station) */

export function parseStationDump(stdout: string): WifiStation[] {
  const out: WifiStation[] = [];
  let cur: WifiStation | null = null;
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    const stM = /^Station\s+([0-9a-f:]{17})/i.exec(line);
    if (stM) {
      cur = {
        mac: stM[1].toLowerCase(),
        band: null,
        signalDbm: null,
        signalAvgDbm: null,
        txBitrateMbps: null,
        rxBitrateMbps: null,
        connectedForMs: null,
        inactiveMs: null,
        quality: "dead",
      };
      out.push(cur);
      continue;
    }
    if (!cur) continue;
    const sig = /^signal:\s*(-?\d+)/i.exec(line);
    if (sig) { cur.signalDbm = Number(sig[1]); continue; }
    const sigAvg = /^signal avg:\s*(-?\d+)/i.exec(line);
    if (sigAvg) { cur.signalAvgDbm = Number(sigAvg[1]); continue; }
    const tx = /^tx bitrate:\s*(.+)$/i.exec(line);
    if (tx) { cur.txBitrateMbps = mbpsOf(tx[1]); continue; }
    const rx = /^rx bitrate:\s*(.+)$/i.exec(line);
    if (rx) { cur.rxBitrateMbps = mbpsOf(rx[1]); continue; }
    const ct = /^connected time:\s*(\d+)\s*seconds/i.exec(line);
    if (ct) { cur.connectedForMs = Number(ct[1]) * 1000; continue; }
    const it = /^inactive time:\s*(\d+)\s*ms/i.exec(line);
    if (it) { cur.inactiveMs = Number(it[1]); continue; }
  }
  for (const s of out) s.quality = qualityOf(s.signalDbm);
  return out;
}

/* ------------------------------------------------------------ ethtool -i */

export function parseEthtoolI(stdout: string): { driver: string | null; version: string | null; firmware: string | null; bus: string | null } {
  const read = function (key: string): string | null {
    const m = new RegExp("^" + key + ":\\s*(.*)$", "m").exec(stdout);
    return m && m[1].trim() ? m[1].trim() : null;
  };
  return {
    driver: read("driver"),
    version: read("version"),
    firmware: read("firmware-version"),
    bus: read("bus-info"),
  };
}
