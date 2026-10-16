/* ==========================================================================
 * CueDesk — @cuedesk/hardware-mt7921 · Mt7921Adapter.ts
 * --------------------------------------------------------------------------
 * Driver del módulo MediaTek MT7921K (Wi-Fi 6 + BT 5.2) sobre Linux.
 *
 * Implementa `NetworkAdapter`: hacia arriba habla en dominio (bandas, dBm,
 * Mbps); hacia abajo usa las utilidades ESTÁNDAR del sistema —`iw`, `ip`,
 * `ethtool` y `tc`/`iptables`— sin enlaces nativos ni dependencias. Es el
 * ÚNICO sitio del sistema que conoce `mt7921e`, `phy0` o "Band 4".
 *
 * Es una radio apta para las DOS caras del appliance:
 *   · `role:"ap"`      → CueBox sirve el SSID a las tablets (hostapd). mt76
 *                        soporta AP; se publican los clientes asociados.
 *   · `role:"station"` → CueBox se une a la red del recinto.
 *
 * LÍMITES CONOCIDOS (ver docs/NETWORK-MT7921.md):
 *   · Es Wi-Fi 6: `mlo.supported` es SIEMPRE `false` (MLO es Wi-Fi 7).
 *   · `setBand` es best-effort: en modo AP la banda la gobierna `hostapd`.
 * ========================================================================== */

import type {
  BluetoothService,
  MloLink,
  MloState,
  NetStatus,
  NetworkAdapter,
  NetworkHealth,
  NetworkSnapshot,
  QosPolicy,
  QosResult,
  WifiBand,
  WifiGeneration,
  WifiInterface,
  WifiLink,
  WifiRole,
  WifiStation,
} from "@cuedesk/net-adapter";
import { DEFAULT_QOS, buildQosCommands } from "@cuedesk/net-adapter";

import { createBluezService } from "./bluetooth.ts";
import {
  bandOfFreq,
  channelOfFreq,
  parseEthtoolI,
  parseIpLink,
  parseIwDev,
  parseIwLink,
  parseIwPhyInfo,
  parseStationDump,
  qualityOf,
} from "./parsers.ts";
import { createExecRunner } from "./runner.ts";
import type { CommandRunner } from "./runner.ts";

export interface Mt7921Options {
  /** Interfaz a gobernar ("wlan0"). Sin ella se toma la primera de `iw dev`. */
  iface?: string;
  /** Papel del appliance. Por defecto, punto de acceso. */
  role?: WifiRole;
  /** Nombre del modelo que se publica (no se puede deducir del driver). */
  model?: string;
  /** SSID que sirve el AP (informativo; `hostapd` es quien manda). */
  ssid?: string;
  /** Ejecutor inyectable (en pruebas, un doble). */
  runner?: CommandRunner;
  now?: () => number;
  /** Política de QoS publicada (por defecto la de CueDesk). */
  qos?: QosPolicy[];
}

/** Frecuencias de referencia por banda para `setBand` (best-effort). */
const BAND_PROBE_MHZ: Record<WifiBand, number> = { "2.4": 2412, "5": 5180, "6": 5955 };

const EMPTY_LINK: WifiLink = {
  connected: false,
  ssid: null,
  bssid: null,
  band: null,
  channel: null,
  widthMhz: null,
  signalDbm: null,
  noiseDbm: null,
  snrDb: null,
  quality: "dead",
  txBitrateMbps: null,
  rxBitrateMbps: null,
};

export class Mt7921Adapter implements NetworkAdapter {
  readonly id = "mt7921";
  readonly simulated = false;

  private readonly ifaceHint: string | null;
  private readonly role: WifiRole;
  private readonly model: string;
  private readonly ssid: string | null;
  private readonly runner: CommandRunner;
  private readonly clock: () => number;
  private readonly qos: QosPolicy[];
  readonly bluetooth: BluetoothService;

  private iface: string | null = null;
  private available = false;
  private lastError: string | null = null;
  private lastAt = 0;
  private driver = "mt7921e";

  constructor(options: Mt7921Options = {}) {
    this.ifaceHint = options.iface || null;
    this.role = options.role === "station" ? "station" : "ap";
    this.model = options.model || "MT7921K";
    this.ssid = options.ssid || null;
    this.runner = options.runner || createExecRunner();
    this.clock = options.now || function () { return Date.now(); };
    this.qos = options.qos || DEFAULT_QOS;
    this.bluetooth = createBluezService({ runner: this.runner });
  }

  /* --------------------------------------------------------------- ciclo */

  /** Comprueba que la radio existe (una vez). No hace nada destructivo. */
  async start(): Promise<void> {
    const dev = await this.runner.run("iw", ["dev"]);
    if (dev.code !== 0) {
      this.available = false;
      this.lastError = dev.stderr || dev.error || "iw no disponible";
      return;
    }
    const entries = parseIwDev(dev.stdout);
    const hint = this.ifaceHint;
    const pick = hint ? entries.find(function (e) { return e.name === hint; }) : entries[0];
    this.iface = pick ? pick.name : (hint || null);
    this.available = this.iface !== null;
  }

  async stop(): Promise<void> { /* sin recursos que liberar */ }

  /* ------------------------------------------------------------- lectura */

  async collect(): Promise<NetworkSnapshot> {
    const at = this.clock();
    this.lastAt = at;

    if (!this.available || !this.iface) {
      return {
        at: at,
        source: { id: this.id, simulated: false },
        interfaces: [],
        health: this.health(null, 0, this.role, false, []),
        qos: this.qos.slice(),
        bluetooth: await this.bluetooth.summary(),
      };
    }

    const iface = this.iface;
    const dev = await this.runner.run("iw", ["dev"]);
    const entry = parseIwDev(dev.stdout).find(function (e) { return e.name === iface; }) || null;

    const eth = await this.runner.run("ethtool", ["-i", iface]);
    const ethInfo = parseEthtoolI(eth.stdout);
    if (ethInfo.driver) this.driver = ethInfo.driver;

    const ipRes = await this.runner.run("ip", ["-o", "link", "show", iface]);
    const ipInfo = parseIpLink(ipRes.stdout);

    /* En modo AP no hay `link` propio: el enlace describe la BSS que servimos. */
    let link: WifiLink = EMPTY_LINK;
    if (this.role === "station") {
      const linkRes = await this.runner.run("iw", ["dev", iface, "link"]);
      const li = parseIwLink(linkRes.stdout);
      const band = li.frequencyMhz !== null ? bandOfFreq(li.frequencyMhz) : null;
      link = {
        connected: li.connected,
        ssid: li.ssid,
        bssid: li.bssid,
        band: band,
        channel: li.frequencyMhz !== null ? channelOfFreq(li.frequencyMhz) : null,
        widthMhz: li.widthMhz,
        signalDbm: li.signalDbm,
        noiseDbm: li.noiseDbm,
        snrDb: li.signalDbm !== null && li.noiseDbm !== null ? li.signalDbm - li.noiseDbm : null,
        quality: qualityOf(li.signalDbm),
        txBitrateMbps: li.txBitrateMbps,
        rxBitrateMbps: li.rxBitrateMbps,
      };
    } else {
      link = {
        connected: ipInfo.up,
        ssid: this.ssid,
        bssid: null,
        band: null,
        channel: null,
        widthMhz: null,
        signalDbm: null,
        noiseDbm: null,
        snrDb: null,
        quality: ipInfo.up ? "excellent" : "dead",
        txBitrateMbps: null,
        rxBitrateMbps: null,
      };
    }

    let phyInfo: ReturnType<typeof parseIwPhyInfo> | null = null;
    if (entry && entry.phy) {
      const phy = await this.runner.run("iw", ["phy", entry.phy, "info"]);
      if (phy.code === 0) phyInfo = parseIwPhyInfo(phy.stdout);
    }
    const bands: WifiBand[] = phyInfo ? phyInfo.bands : [];
    const generation: WifiGeneration | null = phyInfo ? phyInfo.generation : null;
    const apSupported = phyInfo ? phyInfo.ap : false;

    /* Clientes asociados (sólo modo AP). */
    let stations: WifiStation[] = [];
    if (this.role === "ap") {
      const dump = await this.runner.run("iw", ["dev", iface, "station", "dump"]);
      if (dump.code === 0) stations = parseStationDump(dump.stdout);
    }

    /* Wi-Fi 6: no hay MLO. El contrato se rellena igual (capacidad=false). */
    const mloLinks: MloLink[] = [];
    const mlo: MloState = { supported: false, active: false, links: mloLinks };

    const ifaceView: WifiInterface = {
      name: iface,
      driver: ethInfo.driver || this.driver,
      vendor: /mt79/i.test(ethInfo.driver || this.driver) ? "MediaTek" : null,
      model: /mt79/i.test(ethInfo.driver || this.driver) ? this.model : null,
      mac: (entry && entry.mac) || ipInfo.mac,
      phy: entry ? entry.phy : null,
      role: this.role,
      up: ipInfo.up,
      bands: bands,
      generation: generation,
      apSupported: apSupported,
      mlo: mlo,
      link: link,
      stations: stations,
    };

    return {
      at: at,
      source: { id: this.id, simulated: false },
      interfaces: [ifaceView],
      health: this.health(link, stations.length, this.role, mlo.active, bands),
      qos: this.qos.slice(),
      bluetooth: await this.bluetooth.summary(),
    };
  }

  private health(link: WifiLink | null, clients: number, role: WifiRole, mloActive: boolean, bands: WifiBand[]): NetworkHealth {
    let status: NetStatus = "absent";
    if (link) {
      if (role === "ap") {
        /* Un AP sin clientes sigue "up": no depende de una asociación propia. */
        status = link.connected ? "up" : "down";
      } else if (!link.connected) {
        status = "down";
      } else if (link.quality === "poor" || link.quality === "dead") {
        status = "degraded";
      } else {
        status = "up";
      }
    }
    return {
      status: status,
      rssiDbm: link ? link.signalDbm : null,
      snrDb: link ? link.snrDb : null,
      latencyMs: null,
      jitterMs: null,
      packetLossPct: null,
      mloActive: mloActive,
      bands: bands,
      clients: clients,
    };
  }

  /* ------------------------------------------------------------- acciones */

  /**
   * Cambio de banda best-effort. En modo ESTACIÓN hace `iw set freq`; en modo
   * AP la banda la gobierna `hostapd`, así que el intento se registra pero no
   * debe esperarse que surta efecto.
   */
  async setBand(iface: string, band: WifiBand): Promise<void> {
    const mhz = BAND_PROBE_MHZ[band];
    const r = await this.runner.run("iw", ["dev", iface, "set", "freq", String(mhz)]);
    this.lastError = r.code === 0 ? null : (r.stderr || r.error || "set freq falló");
  }

  async applyQos(policy: QosPolicy[]): Promise<QosResult> {
    const commands = buildQosCommands(policy, { iface: this.iface || undefined });
    const done: string[] = [];
    const errors: string[] = [];
    for (const c of commands) {
      const r = await this.runner.run(c.cmd, c.args);
      done.push(c.cmd + " " + c.args.join(" "));
      if (r.code !== 0) errors.push(r.stderr || r.error || c.cmd + " falló");
    }
    this.lastError = errors.length ? errors[errors.length - 1] : null;
    return { applied: errors.length === 0, commands: done, errors: errors };
  }

  /* -------------------------------------------------------------- estado */

  status(): Record<string, unknown> {
    return {
      id: this.id,
      simulated: false,
      available: this.available,
      iface: this.iface,
      role: this.role,
      model: this.model,
      driver: this.driver,
      lastError: this.lastError,
      at: this.lastAt,
      qos: this.qos,
    };
  }
}

/** Fábrica: crea el driver del MT7921K. */
export function createMt7921Network(options?: Mt7921Options): Mt7921Adapter {
  return new Mt7921Adapter(options);
}
