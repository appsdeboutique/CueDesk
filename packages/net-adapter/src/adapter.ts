/* ==========================================================================
 * CueDesk — @cuedesk/net-adapter · adapter.ts
 * --------------------------------------------------------------------------
 * `NetworkAdapter`: el contrato que cumple todo driver de red del appliance.
 * Es el gemelo de `ConsoleAdapter`: el backend (core/app) conoce ÚNICAMENTE
 * esta interfaz; detrás puede haber `iw`/`nmcli`/BlueZ (Linux), una tarjeta
 * simulada o, mañana, otra plataforma.
 *
 * Reglas de la abstracción:
 *   · Todo en dominio: bandas "2.4/5/6", dBm, Mbps, ms. Nada de "Band 4".
 *   · `collect()` es de sólo LECTURA: observa y devuelve una foto.
 *   · Las acciones (cambiar banda, aplicar QoS) son explícitas y devuelven
 *     lo que se hizo, para que el operador pueda auditar.
 *   · `simulated` es honestidad de primera clase: la UI nunca pinta datos de
 *     demostración como si fueran de la radio real.
 * ========================================================================== */

import type {
  BluetoothDevice,
  BluetoothSummary,
  NetworkSnapshot,
  QosPolicy,
  WifiBand,
} from "./types.ts";

/** Resultado de aplicar una política de QoS (para auditoría). */
export interface QosResult {
  applied: boolean;
  /** Órdenes que se ejecutaron o se habrían ejecutado (auditoría). */
  commands: string[];
  errors: string[];
}

/** Servicio Bluetooth del appliance (BLE 5.x sobre BlueZ). */
export interface BluetoothService {
  readonly available: boolean;
  /** Resumen del controlador y periféricos conocidos. */
  summary(): Promise<BluetoothSummary>;
  /** Escaneo activo de periféricos BLE (segundos configurables). */
  scan(seconds?: number): Promise<BluetoothDevice[]>;
  connect(address: string): Promise<void>;
  disconnect(address: string): Promise<void>;
  status(): Record<string, unknown>;
}

export interface NetworkAdapter {
  /** Identificador del driver: "mt7921" | "sim"… */
  readonly id: string;
  /** `true` si NO hay hardware: datos sintéticos (demo / CI / Windows). */
  readonly simulated: boolean;

  start(): Promise<void>;
  stop(): Promise<void>;

  /** Foto completa de red + QoS + Bluetooth. Sólo lectura. */
  collect(): Promise<NetworkSnapshot>;

  /** Diagnóstico del driver (equivalente a `ConsoleAdapter.linkStatus`). */
  status(): Record<string, unknown>;

  /** Forzar la banda de una interfaz (best-effort; ver docs del driver). */
  setBand(iface: string, band: WifiBand): Promise<void>;

  /** Aplicar la política de QoS (marcado DSCP + encolado). Devuelve lo hecho. */
  applyQos(policy: QosPolicy[]): Promise<QosResult>;

  /** Servicio Bluetooth (segundo subsistema del combo Wi-Fi + BT). */
  readonly bluetooth: BluetoothService;
}

/** Lectura de un periférico BLE concreto (comodidad para la API). */
export type BluetoothScan = BluetoothDevice[];
export type BluetoothStatus = BluetoothSummary;
