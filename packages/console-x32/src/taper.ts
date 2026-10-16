/* ==========================================================================
 * CueDesk — @cuedesk/console-x32 · taper.ts
 * --------------------------------------------------------------------------
 * La curva del fader de la X32, en un solo sitio.
 *
 *   valor de cable ⇄ dB
 *   0     = −∞
 *   0,0625 = −60 dB
 *   0,25   = −30 dB
 *   0,5    = −10 dB
 *   1      = +10 dB
 *
 * El taper es del DRIVER: la UI ya no lo necesita (habla en dB por el
 * contrato) y el core no puede verlo. Antes vivía duplicado en
 * backend/osc/oscEngine.js y en js/osc.js.
 * ========================================================================== */

const FADER_SEGMENTS = [
  { max: 0.0625, scale: 480, offset: -90 },
  { max: 0.25, scale: 160, offset: -70 },
  { max: 0.5, scale: 80, offset: -50 },
  { max: 1, scale: 40, offset: -30 },
];

/** dB → valor de cable (0…1). −∞ y por debajo de −90 dB dan 0. */
export function toFader(db: number): number {
  if (db === -Infinity || db <= -90) return 0;
  if (db <= -60) return (db + 90) / 480;
  if (db <= -30) return (db + 70) / 160;
  if (db <= -10) return (db + 50) / 80;
  if (db <= 10) return (db + 30) / 40;
  return 1;
}

/** Valor de cable (0…1) → dB. 0 es −∞. */
export function fromFader(f: number): number {
  const v = f < 0 ? 0 : f > 1 ? 1 : f;
  if (v <= 0) return -Infinity;
  for (const seg of FADER_SEGMENTS) {
    if (v <= seg.max) return v * seg.scale + seg.offset;
  }
  return v * 40 - 30;
}

/** Vúmetro lineal 0…1 de la consola → dBFS (1,0 = 0 dBFS). */
export function fromLinear(v: number): number {
  return v > 0 ? (20 * Math.log(v)) / Math.LN10 : -Infinity;
}

export type ControlKind = "headamp" | "fader" | "send";

/** dB → valor de cable según el tipo de control. El previo es lineal. */
export function toWire(kind: ControlKind, db: number): number {
  return kind === "headamp" ? db : toFader(db);
}

/** Valor de cable → dB según el tipo de control. */
export function fromWire(kind: ControlKind, wire: number): number {
  return kind === "headamp" ? wire : fromFader(wire);
}

/**
 * Tolerancia para reconocer el eco de lo que escribimos, en valor de cable.
 * El previo de la X32 se mueve en pasos de 0,5 dB y puede devolverse
 * redondeado; los faders se devuelven con precisión de coma flotante.
 */
export const WIRE_TOLERANCE: Record<ControlKind, number> = {
  fader: 1e-4,
  send: 1e-4,
  headamp: 0.5,
};
