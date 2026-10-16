/* ==========================================================================
 * CueDesk — @cuedesk/console-x32 · preamps.ts
 * --------------------------------------------------------------------------
 * El previo (headamp) de un X32 es FÍSICO: su índice OSC no es el número de
 * canal. El protocolo no oficial de la familia X32/M32 expone
 *
 *     /headamp/000…031   Local
 *     /headamp/032…079   AES50 A   (el puerto expone hasta 48 entradas)
 *     /headamp/080…127   AES50 B
 *
 * CueDesk gobierna 32 entradas por banco (4 bloques de 8), así que la tabla
 * que se usa es la de `PREAMP_BANKS`.
 *
 * ESTA TABLA ES DEL DRIVER. El motor la ignora por completo: cuando quiere
 * mover el previo del canal 9, dice `setPreampGain("ch.09", 18)` y aquí se
 * resuelve si toca `/headamp/008` (local) o `/headamp/032` (AES50 A, canal 1).
 *
 * Nota de honestidad técnica: la correspondencia canal ↔ entrada del banco se
 * asume IDENTIDAD (el canal N toma la entrada N del banco). Queda por
 * verificar con hardware; si la consola trae otro routing, se añade aquí la
 * lectura de `/-ha/[00…39]/index` o de `/config/routing/IN/…` sin tocar el
 * motor.
 * ========================================================================== */

import type { PreampBank } from "@cuedesk/console-adapter";

export type PreampSource = "local" | "aes50a" | "aes50b";

/** Bancos que CueDesk gobierna, en el orden de la interfaz. */
export const PREAMP_BANKS: PreampBank[] = [
  { id: "local", label: "Local", firstIndex: 0, count: 32 },
  { id: "aes50a", label: "AES50 A", firstIndex: 32, count: 32 },
  { id: "aes50b", label: "AES50 B", firstIndex: 80, count: 32 },
];

export const PREAMP_SOURCES: PreampSource[] = ["local", "aes50a", "aes50b"];

/** Índice de la primera entrada de cada banco (`/headamp/NNN`). */
export const HEADAMP_BASE: Record<PreampSource, number> = {
  local: 0,
  aes50a: 32,
  aes50b: 80,
};

export function isPreampSource(v: unknown): v is PreampSource {
  return v === "local" || v === "aes50a" || v === "aes50b";
}

export function isBankId(v: unknown): boolean {
  return typeof v === "string" && PREAMP_BANKS.some(function (b) { return b.id === v; });
}

/** Banco por id. Lanza si no existe: un banco inventado es un error de programa. */
export function bankById(id: string): PreampBank {
  const bank = PREAMP_BANKS.find(function (b) { return b.id === id; });
  if (!bank) throw new RangeError("Banco de previos desconocido: " + id);
  return bank;
}

/**
 * Índice OSC del previo que gobierna el canal `channelNumber` dentro de un
 * banco. Correspondencia identidad (canal 9 → 9.ª entrada del banco).
 */
export function headampIndexOf(bankId: string, channelNumber: number): number {
  return bankById(bankId).firstIndex + (channelNumber - 1);
}

/**
 * Vuelta atrás: dado un `/headamp/NNN` entrante, a qué banco y a qué número de
 * entrada corresponde. Devuelve null si cae fuera de los bancos gobernados.
 * Los rangos son disjuntos, así que `NNN` identifica (banco, entrada) sin
 * ambigüedad.
 */
export function resolveHeadampIndex(index: number): { bankId: string; entry: number } | null {
  for (const bank of PREAMP_BANKS) {
    if (index >= bank.firstIndex && index < bank.firstIndex + bank.count) {
      return { bankId: bank.id, entry: index - bank.firstIndex + 1 };
    }
  }
  return null;
}
