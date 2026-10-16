/* ==========================================================================
 * CueDesk — @cuedesk/net-adapter · types.ts
 * --------------------------------------------------------------------------
 * Tipos de DOMINIO de la red del appliance. Igual que `console-adapter` con
 * la consola, aquí NO hay una sola orden de shell, ni una ruta de sysfs, ni
 * un nombre de driver: eso vive en `@cuedesk/hardware-mt7921` detrás de
 * `NetworkAdapter`.
 *
 *   · Las bandas se nombran "2.4" | "5" | "6" (no "Band 1/2/4").
 *   · Las potencias van en dBm, las tasas en Mbps, los tiempos en ms.
 *   · `simulated` viaja en la foto para que la interfaz NUNCA confunda datos
 *     reales con datos de demostración.
 *
 * Sólo construcciones que Node elimina sin transformar (sin enums ni
 * parameter properties): estos ficheros corren directamente con `node`.
 * ========================================================================== */

/** Banda de radio con nombre estable (independiente del kernel). */
export type WifiBand = "2.4" | "5" | "6";

/** Papel del appliance en el enlace: punto de acceso o cliente. */
export type WifiRole = "ap" | "station";

/** Generación Wi-Fi (nombre comercial) que la radio anuncia por su PHY. */
export type WifiGeneration = "Wi-Fi 4" | "Wi-Fi 5" | "Wi-Fi 6" | "Wi-Fi 6E" | "Wi-Fi 7";

/** Valoración cualitativa del enlace, derivada de la señal (no la decide la UI). */
export type LinkQuality = "excellent" | "good" | "fair" | "poor" | "dead";

/** Estado de salud agregado del subsistema de red. */
export type NetStatus = "up" | "degraded" | "down" | "absent";

/** Clase de tráfico de CueDesk, con su DSCP y su cola WMM. */
export type TrafficClass = "control" | "telemetry" | "bulk" | "default";

/* ------------------------------------------------------------------ Wi-Fi */

/** Un enlace MLO (Multi-Link Operation). El kernel numera los links 0,1,2. */
export interface MloLink {
  /** Id de link del kernel (0…), no el índice de banda. */
  id: number;
  band: WifiBand;
  frequencyMhz: number;
  channel: number;
  widthMhz: number | null;
  signalDbm: number | null;
  active: boolean;
  txBitrateMbps: number | null;
  rxBitrateMbps: number | null;
}

/**
 * Estado MLO de la interfaz. `supported` es la CAPACIDAD anunciada por el
 * driver/kernel (802.11be = Wi-Fi 7); `active` es que ahora mismo hay más de
 * un link. En una radio Wi-Fi 6 como la MT7921K ambas son `false`: el campo
 * se conserva para que el contrato sirva también a una futura radio Wi-Fi 7.
 */
export interface MloState {
  supported: boolean;
  active: boolean;
  links: MloLink[];
}

/** Enlace Wi-Fi observado (estación). En modo AP, `connected` describe la BSS que servimos. */
export interface WifiLink {
  connected: boolean;
  ssid: string | null;
  bssid: string | null;
  band: WifiBand | null;
  channel: number | null;
  widthMhz: number | null;
  signalDbm: number | null;
  noiseDbm: number | null;
  /** Relación señal/ruido en dB (si se conoce el ruido). */
  snrDb: number | null;
  quality: LinkQuality;
  txBitrateMbps: number | null;
  rxBitrateMbps: number | null;
}

/** Cliente asociado a nuestro punto de acceso (sólo se puebla en modo AP). */
export interface WifiStation {
  mac: string;
  band: WifiBand | null;
  signalDbm: number | null;
  /** Media móvil de la señal que lleva el kernel, si la publica. */
  signalAvgDbm: number | null;
  txBitrateMbps: number | null;
  rxBitrateMbps: number | null;
  connectedForMs: number | null;
  inactiveMs: number | null;
  quality: LinkQuality;
}

/** Una interfaz inalámbrica del appliance. */
export interface WifiInterface {
  /** Nombre netdev: "wlan0". */
  name: string;
  driver: string | null;
  vendor: string | null;
  model: string | null;
  mac: string | null;
  /** "phy0" del kernel (si se conoce). */
  phy: string | null;
  role: WifiRole;
  up: boolean;
  /** Bandas que la radio soporta (según `iw phy info`). */
  bands: WifiBand[];
  /** Generación Wi-Fi anunciada por el PHY (MT7921K: "Wi-Fi 6"). */
  generation: WifiGeneration | null;
  /** La radio/driver soporta modo AP (mt76 en MT7921K: sí). */
  apSupported: boolean;
  mlo: MloState;
  link: WifiLink;
  /** Clientes asociados (poblado en modo AP). */
  stations: WifiStation[];
}

/* -------------------------------------------------------------------- QoS */

/** Política QoS de una clase de tráfico: DSCP + cola WMM + puerto. */
export interface QosPolicy {
  class: TrafficClass;
  /** Code point DSCP (0…63). */
  dscp: number;
  /** Cola de acceso WMM (802.11e) equivalente. */
  wmm: "voice" | "video" | "best-effort" | "background";
  /** Puerto UDP al que aplica, o `null` si es por interfaz. */
  udpPort: number | null;
  description: string;
}

/* -------------------------------------------------------------- Bluetooth */

/** Periférico BLE conocido por el adaptador. */
export interface BluetoothDevice {
  address: string;
  name: string | null;
  rssiDbm: number | null;
  connected: boolean;
  paired: boolean;
  /** UUIDs de servicio GATT anunciados (si se conocen). */
  services: string[];
}

/** Resumen del controlador Bluetooth y sus periféricos. */
export interface BluetoothSummary {
  available: boolean;
  powered: boolean;
  adapter: string | null;
  /** Versión del core Bluetooth (p. ej. "5.2"), si el kernel la publica. */
  version: string | null;
  devices: BluetoothDevice[];
}

/* ------------------------------------------------------------------ salud */

/** Métricas de salud del enlace, ya interpretadas (la UI sólo pinta). */
export interface NetworkHealth {
  status: NetStatus;
  rssiDbm: number | null;
  snrDb: number | null;
  latencyMs: number | null;
  jitterMs: number | null;
  packetLossPct: number | null;
  mloActive: boolean;
  bands: WifiBand[];
  /** Nº de clientes asociados al AP (0 en modo estación). */
  clients: number;
}

/** Foto completa del subsistema, lista para la frontera HTTP. */
export interface NetworkSnapshot {
  at: number;
  /** `id` del driver + `simulated` para no confundir real con demo. */
  source: { id: string; simulated: boolean };
  interfaces: WifiInterface[];
  health: NetworkHealth;
  qos: QosPolicy[];
  bluetooth: BluetoothSummary;
}
