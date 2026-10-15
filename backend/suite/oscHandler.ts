/* ==========================================================================
 * CueDesk — backend/suite/oscHandler.ts
 * --------------------------------------------------------------------------
 * OSCHandler: frontera entre el motor y la consola.
 *
 *   · send()    marca cada mensaje saliente con `source: "cuedesk-internal"`,
 *               convierte dB → valor de cable (taper de la X32 en faders y
 *               envíos) y lo recuerda durante una ventana corta.
 *   · receive() descarta los ecos de lo que CueDesk escribió: misma ruta y
 *               mismo valor dentro de una tolerancia. Un eco se consume una
 *               sola vez; lo que no es eco pasa al motor como cambio real.
 *
 * El protocolo OSC no transporta metadatos, así que la marca no viaja en el
 * paquete: viaja en el objeto saliente y el transporte la descarta al
 * codificar. El filtro de entrada compara por ruta y valor, no por marca.
 * ========================================================================== */

import { SOURCE_MARK } from "./types.ts";
import type { ControlKind, OscTransport, OutboundMessage } from "./types.ts";

/* Taper de 4 tramos de la X32 (igual que backend/osc/oscEngine.js y js/osc.js).
   0 = −∞ · 0,0625 = −60 dB · 0,25 = −30 dB · 0,5 = −10 dB · 1 = +10 dB. */
export function toFader(db: number): number {
  if (db === -Infinity || db <= -90) return 0;
  if (db <= -60) return (db + 90) / 480;
  if (db <= -30) return (db + 70) / 160;
  if (db <= -10) return (db + 50) / 80;
  if (db <= 10) return (db + 30) / 40;
  return 1;
}

export function fromFader(f: number): number {
  const v = f < 0 ? 0 : f > 1 ? 1 : f;
  if (v <= 0) return -Infinity;
  if (v <= 0.0625) return v * 480 - 90;
  if (v <= 0.25) return v * 160 - 70;
  if (v <= 0.5) return v * 80 - 50;
  return v * 40 - 30;
}

/** dB → valor de cable según el tipo de control. */
export function toWire(kind: ControlKind, db: number): number {
  return kind === "headamp" ? db : toFader(db);
}

/** Valor de cable → dB según el tipo de control. */
export function fromWire(kind: ControlKind, wire: number): number {
  return kind === "headamp" ? wire : fromFader(wire);
}

/**
 * Tolerancia de reconocimiento de ecos. El previo de la X32 se mueve en pasos
 * de 0,5 dB y puede devolverse redondeado, por eso su tolerancia es mayor.
 */
const TOLERANCE: Record<ControlKind, number> = {
  fader: 1e-4,
  send: 1e-4,
  headamp: 0.5,
};

interface Pending {
  path: string;
  wire: number;
  at: number;
  tol: number;
}

export interface OSCHandlerOptions {
  now: () => number;
  windowMs: number;
}

export class OSCHandler {
  private readonly transport: OscTransport;
  private readonly now: () => number;
  private readonly windowMs: number;
  private pending: Pending[] = [];
  private sentCount = 0;
  private echoCount = 0;

  constructor(transport: OscTransport, options: OSCHandlerOptions) {
    this.transport = transport;
    this.now = options.now;
    this.windowMs = options.windowMs;
  }

  /** Envía un valor en dB a una ruta. Devuelve el valor de cable enviado. */
  send(path: string, kind: ControlKind, db: number, at?: number): number {
    const t = at !== undefined ? at : this.now();
    const wire = toWire(kind, db);
    this.prune(t);
    this.pending.push({ path: path, wire: wire, at: t, tol: TOLERANCE[kind] });
    const message: OutboundMessage = { path: path, value: wire, source: SOURCE_MARK };
    this.transport.send(message);
    this.sentCount++;
    return wire;
  }

  /** true si el mensaje entrante es eco de algo que escribimos (se descarta). */
  receive(path: string, wire: number, at?: number): boolean {
    const t = at !== undefined ? at : this.now();
    this.prune(t);
    const i = this.pending.findIndex(function (p) {
      return p.path === path && Math.abs(p.wire - wire) <= p.tol;
    });
    if (i < 0) return false;
    this.pending.splice(i, 1);
    this.echoCount++;
    return true;
  }

  pendingCount(): number {
    return this.pending.length;
  }

  stats(): { sent: number; echoesDropped: number; pending: number } {
    return { sent: this.sentCount, echoesDropped: this.echoCount, pending: this.pending.length };
  }

  private prune(at: number): void {
    const windowMs = this.windowMs;
    this.pending = this.pending.filter(function (p) {
      return at - p.at <= windowMs;
    });
  }
}
