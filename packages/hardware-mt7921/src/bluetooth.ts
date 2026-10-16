/* ==========================================================================
 * CueDesk — @cuedesk/hardware-mt7921 · bluetooth.ts
 * --------------------------------------------------------------------------
 * Envoltorio mínimo del segundo subsistema del combo MT7921K: Bluetooth 5.2
 * (driver `btusb`/`btmtk` en Linux). Habla con BlueZ a través de
 * `bluetoothctl`, sin dependencias (cero D-Bus nativo). Sirve para periféricos
 * auxiliares: mandos de escena, sondas de diagnóstico, etiquetas de inventario.
 *
 * Alcance honesto: es un wrapper de LECTURA + conexión básica, no una pila
 * GATT completa. Sin controlador o sin BlueZ el servicio se declara
 * `available:false` y no rompe nada. Ver docs/NETWORK-MT7921.md.
 * ========================================================================== */

import type { BluetoothDevice, BluetoothService, BluetoothSummary } from "@cuedesk/net-adapter";
import type { CommandRunner } from "./runner.ts";

/** "Device AA:BB:CC:DD:EE:FF Nombre" → { address, name } */
export function parseDevices(stdout: string): Array<{ address: string; name: string | null }> {
  const out: Array<{ address: string; name: string | null }> = [];
  for (const raw of stdout.split(/\r?\n/)) {
    const m = /^Device\s+([0-9a-f:]{17})\s*(.*)$/i.exec(raw.trim());
    if (m) out.push({ address: m[1].toLowerCase(), name: m[2].trim() || null });
  }
  return out;
}

/** Salida de `bluetoothctl show` → estado del controlador. */
export function parseShow(stdout: string): { powered: boolean; adapter: string | null; version: string | null } {
  let powered = false;
  let adapter: string | null = null;
  let version: string | null = null;
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    const p = /^Powered:\s*(yes|no)/i.exec(line);
    if (p) { powered = p[1].toLowerCase() === "yes"; continue; }
    const a = /^Controller\s+([0-9a-f:]{17})/i.exec(line);
    if (a) { adapter = a[1].toLowerCase(); continue; }
    /* BlueZ no publica la versión del core BT de forma uniforme; se toma si aparece. */
    const v = /(?:Version|Bluetooth Core Version):\s*([\d.]+)/i.exec(line);
    if (v) { version = v[1]; continue; }
  }
  return { powered: powered, adapter: adapter, version: version };
}

export interface BluezOptions {
  runner: CommandRunner;
}

export function createBluezService(opts: BluezOptions): BluetoothService {
  const runner = opts.runner;
  let available: boolean | null = null;

  async function probe(): Promise<boolean> {
    if (available !== null) return available;
    const r = await runner.run("bluetoothctl", ["--version"]);
    available = r.code === 0;
    return available;
  }

  async function summary(): Promise<BluetoothSummary> {
    if (!(await probe())) {
      return { available: false, powered: false, adapter: null, version: null, devices: [] };
    }
    const show = await runner.run("bluetoothctl", ["show"]);
    const meta = parseShow(show.stdout);
    const all = parseDevices((await runner.run("bluetoothctl", ["devices"])).stdout);
    const conn = parseDevices((await runner.run("bluetoothctl", ["devices", "Connected"])).stdout)
      .map(function (d) { return d.address; });
    const paired = parseDevices((await runner.run("bluetoothctl", ["devices", "Paired"])).stdout)
      .map(function (d) { return d.address; });

    const devices: BluetoothDevice[] = all.map(function (d) {
      return {
        address: d.address,
        name: d.name,
        rssiDbm: null,
        connected: conn.indexOf(d.address) >= 0,
        paired: paired.indexOf(d.address) >= 0,
        services: [],
      };
    });

    return {
      available: true,
      powered: meta.powered,
      adapter: meta.adapter,
      version: meta.version,
      devices: devices,
    };
  }

  return {
    get available(): boolean { return available === true; },

    summary: summary,

    /** Escaneo de descubrimiento (best-effort): enciende el scan unos segundos. */
    async scan(seconds?: number): Promise<BluetoothDevice[]> {
      if (!(await probe())) return [];
      const secs = Math.max(1, Math.round(seconds || 5));
      await runner.run("bluetoothctl", ["--timeout", String(secs), "scan", "on"], { timeoutMs: (secs + 2) * 1000 });
      return (await summary()).devices;
    },

    async connect(address: string): Promise<void> {
      if (!(await probe())) return;
      await runner.run("bluetoothctl", ["connect", address], { timeoutMs: 8000 });
    },

    async disconnect(address: string): Promise<void> {
      if (!(await probe())) return;
      await runner.run("bluetoothctl", ["disconnect", address], { timeoutMs: 8000 });
    },

    status(): Record<string, unknown> {
      return { available: available === true, probe: available === null ? "pending" : "done" };
    },
  };
}
