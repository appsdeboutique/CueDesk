/* ==========================================================================
 * CueDesk — @cuedesk/console-adapter · types.ts
 * --------------------------------------------------------------------------
 * Tipos de DOMINIO que comparten el core y los drivers.
 *
 * Aquí no hay nada de ningún protocolo: ni una ruta, ni un taper, ni un
 * datagrama. El core habla en estos términos y cada driver los traduce a su
 * consola (OSC de la X32, protocolo de la Yamaha, lo que sea).
 *
 * Criterio de actuación (acordado):
 *   · El envío a bus es post-EQ: NO ve el fader. BusGuard compensa sólo el
 *     previo (GAIN/TRIM).
 *   · Stage Guard (ducking) actúa sobre el previo, así que BusGuard lo ve y lo
 *     compensa con sus mismos parámetros.
 *   · La normalización base (GainGuard) actúa sobre el fader; como no llega al
 *     IEM, BusGuard no la compensa.
 * ========================================================================== */

/** Canal de entrada gobernado por CueDesk. Convención: "ch.01" … "ch.32". */
export type ChannelId = string;

/** Bus de mezcla (IEM). Convención X32: 1…16. */
export type BusId = number;

export type Unsubscribe = () => void;

/** Naturaleza del previo que esta consola ofrece por canal. */
export type PreampKind = "headamp" | "trim" | "none";

/**
 * Banco de previos tal y como lo publica la consola. En un X32: Local,
 * Net Primary y Net Secondary. Cada uno declara en qué índice de su propio espacio
 * empieza el banco (`firstIndex`), que es lo que el driver usa para
 * direccionar `/headamp/NNN`.
 */
export interface PreampBank {
  id: string;
  label: string;
  /** Índice (base 0) de la primera entrada del banco en el espacio de la consola. */
  firstIndex: number;
  /** Entradas del banco. */
  count: number;
}

export interface ConsoleCapabilities {
  channels: number;
  buses: number;
  preamp: PreampKind;
  /** El envío a bus es post-EQ (no ve el fader): criterio de BusGuard. */
  sendsArePostEq: boolean;
  preampBanks: PreampBank[];
}

export interface ConsoleInfo {
  model: string;
  name?: string | null;
  firmware?: string | null;
  capabilities: ConsoleCapabilities;
}

/** Posición física del previo gobernada por un canal. */
export interface PreampRouting {
  bankId: string;
  /** Índice dentro del espacio de la consola (0…). */
  index: number;
}

/** A qué actuador de la consola se refiere un cambio observado. */
export type ControlTarget =
  | { kind: "preamp"; channel: ChannelId }
  | { kind: "fader"; channel: ChannelId }
  | { kind: "send"; channel: ChannelId; bus: BusId };

export type ChangeOrigin =
  /** Lo movió una persona en la consola. */
  | "console"
  /** Es el eco de algo que escribió CueDesk. */
  | "self";

/**
 * Cambio observado en la consola, ya traducido a dominio. El driver es quien
 * sabe si es un eco propio (y lo marca como "self"): el core no necesita
 * conocer la ventana de eco ni el redondeo del protocolo.
 */
export interface ControlChange {
  target: ControlTarget;
  /** Valor en dB para previo, fader y envío. */
  db?: number;
  /** Phantom (+48 V) cuando el objetivo es el previo. */
  on?: boolean;
  origin: ChangeOrigin;
}

/** Una lectura de nivel (dBFS) de un canal. */
export interface LevelReading {
  channel: ChannelId;
  db: number;
}

export interface LevelFrame {
  levels: LevelReading[];
  at?: number;
}
