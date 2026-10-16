/* ==========================================================================
 * CueDesk — @cuedesk/hardware-mt7921 · SimNetwork.ts
 * --------------------------------------------------------------------------
 * Driver SIMULADO del MT7921K: misma interfaz `NetworkAdapter`, datos
 * sintéticos. Sirve para (1) desarrollo en Windows, (2) CI sin hardware y
 * (3) demostraciones de la UI. La foto SIEMPRE viaja con
 * `source.simulated:true` para que nada se confunda con una radio real.
 *
 * Es el equivalente de `drivers/fake` en el blueprint: la prueba de que el
 * contrato aguanta sin tocar ni una línea de la interfaz.
 * ========================================================================== */

import type {
  BluetoothDevice,
  BluetoothService,
  BluetoothSummary,
  MloState,
  NetworkAdapter,
  NetworkHealth,
  NetworkSnapshot,
  QosPolicy,
  QosResult,
  WifiBand,
  WifiInterface,
  WifiStation,
} from "@cuedesk/net-adapter";
import { DEFAULT_QOS, buildQosCommands } from "@cuedesk/net-adapter";

export interface SimOptions {
  ssid?: string;
  /** Nº de clientes de mentira asociados al AP. Por defecto, 3. */
  clients?: number;
  qos?: QosPolicy[];
  now?: () => number;
}

const SIM_MAC = "aa:bb:cc:00:00:01";

function makeStation(i: number, at: number): WifiStation {
  const phase = (at / 1000 + i) % (2 * Math.PI);
  const signal = -44 - i * 6 + Math.round(4 * Math.sin(phase));
  return {
    mac: "aa:bb:cc:00:00:" + String(10 + i).padStart(2, "0"),
    band: i % 2 === 0 ? "5" : "2.4",
    signalDbm: signal,
    signalAvgDbm: signal - 1,
    txBitrateMbps: 286.7 - i * 20,
    rxBitrateMbps: 260.0 - i * 18,
    connectedForMs: 60_000 + i * 12_345,
    inactiveMs: 10 + i * 40,
    quality: signal >= -60 ? "good" : "fair",
  };
}

const SIM_BT: BluetoothDevice[] = [
  { address: "e4:5f:01:aa:bb:01", name: "Stage Controller", rssiDbm: -55, connected: true, paired: true, services: ["0000180f-0000-1000-8000-00805f9b34fb"] },
  { address: "e4:5f:01:aa:bb:02", name: "SPL Probe", rssiDbm: -71, connected: false, paired: true, services: [] },
];

export class SimNetwork implements NetworkAdapter {
  readonly id = "sim";
  readonly simulated = true;

  private readonly clock: () => number;
  private readonly qos: QosPolicy[];
  private band: WifiBand;
  private stations: WifiStation[];
  readonly bluetooth: BluetoothService;

  constructor(options: SimNetworkOptions = {}) {
    this.clock = options.now || function () { return Date.now(); };
    this.qos = options.qos || DEFAULT_QOS;
    this.band = options.band || "5";
    const count = options.clients === undefined ? 3 : Math.max(0, options.clients);
    const t = this.clock();
    this.stations = [];
    for (let i = 0; i < count; i++) this.stations.push(makeStation(i, t));

    const devices = () => SIM_BT.map(function (d) { return Object.assign({}, d); });
    this.bluetooth = {
      available: true,
      async summary(): Promise<BluetoothSummary> {
        return { available: true, powered: true, adapter: "e4:5f:01:aa:00:00", version: "5.2", devices: devices() };
      },
      async scan(): Promise<BluetoothDevice[]> { return devices(); },
      async connect(): Promise<void> { /* simulado */ },
      async disconnect(): Promise<void> { /* simulado */ },
      status(): Record<string, unknown> { return { available: true, simulated: true }; },
    };
  }

  async start(): Promise<void> { /* simulado */ }
  async stop(): Promise<void> { /* simulado */ }

  async collect(): Promise<NetworkSnapshot> {
    const at = this.clock();
    const t = this.clock();
    this.stations = this.stations.map(function (_s, i) { return makeStation(i, t); });

    const mlo: MloState = { supported: false, active: false, links: [] };

    const iface: WifiInterface = {
      name: "wlan0",
      driver: "mt7921e",
      vendor: "MediaTek",
      model: "MT7921K",
      mac: "00:0c:43:aa:bb:cc",
      phy: "phy0",
      role: "ap",
      up: true,
      bands: ["2.4", "5"],
      generation: "Wi-Fi 6",
      apSupported: true,
      mlo: mlo,
      link: {
        connected: true,
        ssid: "CueBox-AP",
        bssid: "00:0c:43:aa:bb:cc",
        band: this.band,
        channel: this.band === "2.4" ? 6 : 36,
        widthMhz: 80,
        signalDbm: null,
        noiseDbm: null,
        snrDb: null,
        quality: "excellent",
        txBitrateMbps: 1201,
        rxBitrateMbps: 1201,
      },
      stations: this.stations,
    };

    const health: NetworkHealth = {
      status: "up",
      rssiDbm: null,
      snrDb: null,
      latencyMs: 6,
      jitterMs: 1.5,
      packetLossPct: 0,
      mloActive: false,
      bands: ["2.4", "5"],
      clients: this.stations.length,
    };

    return {
      at: at,
      source: { id: this.id, simulated: true },
      interfaces: [iface],
      health: health,
      qos: this.qos.slice(),
      bluetooth: await this.bluetooth.summary(),
    };
  }

  async setBand(_iface: string, band: WifiBand): Promise<void> {
    this.band = band;
  }

  async applyQos(policy: QosPolicy[]): Promise<QosResult> {
    const commands = buildQosCommands(policy, { iface: "wlan0" });
    return {
      applied: true,
      commands: commands.map(function (c) { return c.cmd + " " + c.args.join(" "); }),
      errors: [],
    };
  }

  status(): Record<string, unknown> {
    return {
      id: this.id,
      simulated: true,
      available: true,
      iface: "wlan0",
      role: "ap",
      model: "MT7921K",
      driver: "mt7921e",
      band: this.band,
      clients: this.stations.length,
    };
  }
}

export interface SimNetworkOptions {
  /** Banda inicial del AP simulado. */
  band?: WifiBand;
  /** Nº de clientes simulados. */
  clients?: number;
  /** Política de QoS publicada. */
  qos?: QosPolicy[];
  now?: () => number;
}

/** Fábrica: red simulada (demo / CI / Windows). */
export function createSimulatedNetwork(options?: SimNetworkOptions): SimNetwork {
  return new SimNetwork(options);
}
