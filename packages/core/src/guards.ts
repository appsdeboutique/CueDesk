/* ==========================================================================
 * CueDesk — @cuedesk/core · guards.ts
 * --------------------------------------------------------------------------
 * Decisiones sin efectos de los guardianes. El motor decide cuándo se
 * ejecutan (orden del pipeline, cooldown, banda muerta) y pide los ajustes
 * al adaptador; aquí no se escribe nada.
 *
 *   baseVerdict   · GainGuard base: nivel medido frente a referencia o −18/−23 LUFS
 *   stageDecision · Stage Guard: silencio sostenido → atenuar el previo; vuelve la señal → restaurar
 *   preDecision   · PreGuard: nivel sostenido sobre el techo → atenuación acumulada
 *   busDelta      · BusGuard: variación del previo desde la última compensación
 * ========================================================================== */

import type { ChannelRuntime, EngineConfig } from "./types.ts";

export type StageDecision = "duck" | "restore" | null;

export type BaseVerdict =
  | { decision: "hold"; reason: string }
  | { decision: "manual"; reason: string }
  | { decision: "act"; reason: string; deltaDb: number };

export interface BaseReading {
  measuredDb: number;
  samples: number;
  coverage: number;
}

/** Potencia media en dB de las lecturas de una ventana. −∞ si no hay ninguna. */
export function rmsOf(levels: { t: number; db: number }[], now: number, windowMs: number): number {
  let sum = 0;
  let n = 0;
  for (const s of levels) {
    if (s.t < now - windowMs || s.t > now) continue;
    n++;
    if (Number.isFinite(s.db)) sum += Math.pow(10, s.db / 10);
  }
  if (n === 0 || sum <= 0) return -Infinity;
  return 10 * Math.log10(sum / n);
}

export function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

/**
 * Normalización base. La tolerancia es el umbral RMS (3 ó 5 dB) en modo rms;
 * en modo lufs la banda es la del engine (deadband). Una desviación fuera de
 * lo razonable (salto anómalo) no se corrige: queda a criterio manual.
 */
export function baseVerdict(
  reading: BaseReading,
  targetDb: number,
  tolerance: number,
  cfg: EngineConfig,
): BaseVerdict {
  if (!Number.isFinite(reading.measuredDb) || reading.measuredDb <= cfg.baseSilenceFloorDb) {
    return { decision: "hold", reason: "no-signal" };
  }
  if (reading.samples < cfg.baseMinSamples || reading.coverage < cfg.baseMinCoverage) {
    return { decision: "hold", reason: "insufficient-data" };
  }
  const delta = targetDb - reading.measuredDb;
  if (Math.abs(delta) > cfg.baseMaxCorrectionDb) {
    return { decision: "manual", reason: "extreme-jump" };
  }
  if (Math.abs(delta) < tolerance) return { decision: "hold", reason: "within-tolerance" };
  return { decision: "act", reason: "ok", deltaDb: delta };
}

/**
 * Stage Guard. Atenuar exige silencio sostenido (hold). Restaurar no tiene
 * hold: en cuanto la señal supera el umbral más la histéresis, se restaura.
 * La histéresis evita que una señal en el límite oscile.
 */
export function stageDecision(ch: ChannelRuntime, rmsDb: number, now: number): StageDecision {
  const cfg = ch.stageCfg;
  if (!cfg.enabled || ch.nominalGain === null || ch.headamp === null) {
    ch.stage.silentSince = null;
    return null;
  }
  if (ch.stage.ducked) {
    ch.stage.silentSince = null;
    return Number.isFinite(rmsDb) && rmsDb >= cfg.threshold + cfg.hysteresisDb ? "restore" : null;
  }
  const silent = !Number.isFinite(rmsDb) || rmsDb < cfg.threshold;
  if (!silent) {
    ch.stage.silentSince = null;
    return null;
  }
  if (ch.stage.silentSince === null) ch.stage.silentSince = now;
  return now - ch.stage.silentSince >= cfg.holdMs ? "duck" : null;
}

/**
 * Acción de PreGuard en el ciclo: acumula o libera desplazamiento sobre el
 * previo. `offset` es la nueva atenuación (>= 0 dB) que PreGuard pide.
 */
export type PreAction =
  | { action: "protect"; offset: number }
  | { action: "restore"; offset: number }
  | null;

/**
 * PreGuard: protección preventiva del conversor A/D sobre el previo.
 *
 * PreGuard no fija un valor absoluto del previo —eso lo decide el motor, que
 * combina su desplazamiento con el de Stage Guard sobre una referencia única—
 * sino cuánto quiere atenuarlo (`preOffset`). Con el nivel sostenido por encima
 * del techo acumula `stepDb`; cuando cae por debajo del techo menos la
 * histéresis lo suelta. La banda de histéresis evita que un nivel que ronda el
 * techo suba y baje el previo.
 */
export function preDecision(
  ch: ChannelRuntime,
  sustainedDb: number,
  stepDb: number,
  restoreDb: number,
  deadbandDb: number,
  maxOffsetDb: number
): PreAction {
  const ceiling = ch.preCfg.ceilingDb;
  const offset = ch.preOffset;
  if (Number.isFinite(sustainedDb) && sustainedDb > ceiling) {
    const next = Math.min(offset + stepDb, maxOffsetDb);
    return next - offset < deadbandDb ? null : { action: "protect", offset: next };
  }
  if (sustainedDb >= ceiling - ch.preCfg.hysteresisDb) return null;
  const next = Math.max(0, offset - restoreDb);
  return offset - next < deadbandDb ? null : { action: "restore", offset: next };
}

/** Variación del previo desde la última compensación de BusGuard. */
export function busDelta(ch: ChannelRuntime): number {
  if (ch.headamp === null || ch.compHead === null) return 0;
  return ch.headamp - ch.compHead;
}
