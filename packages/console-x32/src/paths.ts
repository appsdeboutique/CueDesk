/* ==========================================================================
 * CueDesk — @cuedesk/console-x32 · paths.ts
 * --------------------------------------------------------------------------
 * Construcción y lectura de rutas OSC de la familia X32/M32.
 *
 *   /ch/NN/mix/fader          fader del canal
 *   /ch/NN/mix/YY/level       envío del canal al bus YY
 *   /headamp/NNN/gain         previo (NNN es índice físico, ver preamps.ts)
 *   /headamp/NNN/phantom      +48 V
 *
 * Sólo el driver importa este módulo. El motor y la UI hablan en dominio.
 * ========================================================================== */

export function pad(n: number, width: number): string {
  return String(n).padStart(width, "0");
}

export function pad3(n: number): string {
  return pad(n, 3);
}

/** Número de canal → id de dominio ("09" → "ch.09"). */
export function channelIdOf(number: number): string {
  return "ch." + pad(number, 2);
}

/** Id de dominio → número de canal ("ch.09" → 9). Null si no encaja. */
export function channelNumberOf(id: string): number | null {
  const m = /^ch\.(\d{1,2})$/.exec(id);
  return m ? Number(m[1]) : null;
}

export function faderPath(channelNumber: number): string {
  return "/ch/" + pad(channelNumber, 2) + "/mix/fader";
}

export function sendPath(channelNumber: number, bus: number): string {
  return "/ch/" + pad(channelNumber, 2) + "/mix/" + pad(bus, 2) + "/level";
}

export function headampGainPath(index: number): string {
  return "/headamp/" + pad3(index) + "/gain";
}

export function headampPhantomPath(index: number): string {
  return "/headamp/" + pad3(index) + "/phantom";
}

const RE_FADER = /^\/ch\/(\d{2})\/mix\/fader$/;
const RE_SEND = /^\/ch\/(\d{2})\/mix\/(\d{2})\/level$/;
const RE_HEADAMP_GAIN = /^\/headamp\/(\d{3})\/gain$/;
const RE_HEADAMP_PHANTOM = /^\/headamp\/(\d{3})\/phantom$/;

export type ParsedControlPath =
  | { kind: "fader"; channelNumber: number }
  | { kind: "send"; channelNumber: number; bus: number }
  | { kind: "headamp-gain"; headampIndex: number }
  | { kind: "headamp-phantom"; headampIndex: number };

/** Lee una ruta de control entrante. Null si no es ninguna de las nuestras. */
export function parseControlPath(path: string): ParsedControlPath | null {
  let m = RE_FADER.exec(path);
  if (m) return { kind: "fader", channelNumber: Number(m[1]) };
  m = RE_SEND.exec(path);
  if (m) return { kind: "send", channelNumber: Number(m[1]), bus: Number(m[2]) };
  m = RE_HEADAMP_GAIN.exec(path);
  if (m) return { kind: "headamp-gain", headampIndex: Number(m[1]) };
  m = RE_HEADAMP_PHANTOM.exec(path);
  if (m) return { kind: "headamp-phantom", headampIndex: Number(m[1]) };
  return null;
}
