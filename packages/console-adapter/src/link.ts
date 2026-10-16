/* ==========================================================================
 * CueDesk — @cuedesk/console-adapter · link.ts
 * --------------------------------------------------------------------------
 * `ConsoleLink`: el puerto de BAJO NIVEL hacia una consola.
 *
 * Lo implementa el transporte (UDP + OSC en la X32, ver apps/cuebox) y lo
 * consume el driver. La diferencia con `ConsoleAdapter` es deliberada:
 *
 *   ConsoleLink     → habla el protocolo (rutas, argumentos, datagramas)
 *   ConsoleAdapter  → habla el dominio (canales, dB, previo)
 *
 * El core sólo ve `ConsoleAdapter`, así que no puede llegar al protocolo.
 * ========================================================================== */

import type { Unsubscribe } from "./types.ts";

export type OscValue = number | string;

export type OscArgs = unknown[];

export interface ConsoleLink {
  /** Escribe un valor en una ruta del protocolo. */
  send(path: string, value: OscValue, type?: string): void;

  /** Se suscribe a las rutas entrantes. `pattern` admite un prefijo con `*`. */
  on(pattern: string, fn: (args: OscArgs, path: string) => void): Unsubscribe;

  /** Abre el puerto de escucha (opcional: algunos transportes no lo necesitan). */
  listen?(port: number): unknown;

  /** Diagnóstico del transporte (opcional). */
  status?(): unknown;
}
