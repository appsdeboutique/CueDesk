/* ==========================================================================
 * CueDesk — @cuedesk/console-adapter · adapter.ts
 * --------------------------------------------------------------------------
 * `ConsoleAdapter`: el contrato que cumple todo driver de consola.
 *
 * El motor de CueDesk (GainGuard, Stage Guard, PreGuard, BusGuard) conoce
 * ÚNICAMENTE esta interfaz. No hay una sola ruta OSC en el core: si mañana
 * entra una Yamaha DM3 o una Allen & Heath, se escribe un driver nuevo y el
 * motor no se toca.
 *
 * Reglas de la abstracción:
 *   · Los valores siempre en dB (nunca en "valor de cable").
 *   · Los canales se nombran por id de dominio ("ch.09"), no por índice.
 *   · Los cambios entrantes llegan ya en dominio, con su `origin`.
 * ========================================================================== */

import type {
  BusId,
  ChannelId,
  ConsoleCapabilities,
  ConsoleInfo,
  ControlChange,
  LevelFrame,
  PreampRouting,
  Unsubscribe,
} from "./types.ts";

export interface ConsoleAdapter {
  readonly info: ConsoleInfo | null;
  readonly capabilities: ConsoleCapabilities;

  connect(): Promise<ConsoleInfo>;
  disconnect(): Promise<void>;

  /* ------------------------------------------------------------- previo */

  /** Fija el previo del canal en dB (rango del propio driver). */
  setPreampGain(channel: ChannelId, db: number): void;
  /** Phantom (+48 V) del canal. */
  setPreampPhantom(channel: ChannelId, on: boolean): void;

  /**
   * Banco de previos al que apunta el canal (Local, AES50 A, AES50 B…).
   * Debe existir en `capabilities.preampBanks`.
   */
  assignPreampBank(channel: ChannelId, bankId: string): void;

  preampBankOf(channel: ChannelId): string;
  preampRoutingOf(channel: ChannelId): PreampRouting;

  /* -------------------------------------------------------------- canal */

  setChannelFader(channel: ChannelId, db: number): void;
  setChannelSend(channel: ChannelId, bus: BusId, db: number): void;

  /**
   * Escritura directa a una ruta del protocolo, para el puente de la interfaz
   * (todo lo que el motor no gobierna: pan, nombre, color, routing…). Debe
   * pasar por el MISMO camino que las escrituras de dominio, para que el driver
   * la recuerde y descarte su eco: si no, la consola devolvería el valor y el
   * motor lo leería como un gesto humano.
   *
   * Quien la use asume el mapeo ruta→dominio: si el cambio afecta a una
   * magnitud de GainGuard (fader, previo, envío), además hay que informar al
   * motor a través de su superficie de dominio.
   */
  writeRaw(path: string, args: unknown[], type?: string): void;

  /* ------------------------------------------------------------ eventos */

  /** Cambios movidos a mano en la consola (los ecos propios no llegan). */
  onChanges(cb: (change: ControlChange) => void): Unsubscribe;

  /** Telemetría de nivel por canal (dBFS). */
  onLevels(cb: (frame: LevelFrame) => void): Unsubscribe;

  /** Diagnóstico del enlace, para la superficie de API. */
  linkStatus(): Record<string, unknown>;
}
