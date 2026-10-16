/* ==========================================================================
 * CueDesk — @cuedesk/core · types.ts
 * --------------------------------------------------------------------------
 * Tipos del motor GainGuard. Son de DOMINIO: aquí no hay ninguna ruta, ni un
 * taper, ni un índice físico de previo. Todo eso vive en el driver
 * (@cuedesk/console-x32) detrás de `ConsoleAdapter`.
 *
 * Sólo se usan construcciones que Node elimina sin transformar (sin enums ni
 * parameter properties): el fichero corre directamente con `node`.
 *
 * Criterio de actuación (acordado):
 *   · El envío a bus es post-EQ: NO ve el fader. BusGuard compensa sólo el
 *     previo (GAIN/TRIM).
 *   · Stage Guard (ducking) actúa sobre el previo, así que BusGuard lo ve y lo
 *     compensa con sus mismos parámetros.
 *   · La normalización base (GainGuard) actúa sobre el fader; como no llega al
 *     IEM, BusGuard no la compensa.
 * ========================================================================== */

/** Actuador sobre el que escribe una guarda. */
export type ControlKind = "fader" | "headamp" | "send";

export type BaseMode = "off" | "rms" | "lufs";

export interface BaseConfig {
  mode: BaseMode;
  /** rms: tolerancia en dB (3 ó 5). lufs: objetivo en LUFS (−18 ó −23). */
  threshold: number;
}

export interface StageGuardConfig {
  enabled: boolean;
  /** RMS (dBFS) por debajo del cual el canal se considera en silencio. */
  threshold: number;
  /** Atenuación del previo durante el silencio (dB, positivo). */
  duckingDepth: number;
  /** Silencio sostenido antes de atenuar. */
  holdMs: number;
  /** Ventana corta con la que se detecta la voz (baja latencia). */
  windowMs: number;
  /** Margen sobre el umbral para dar la señal por recuperada (anti-oscilación). */
  hysteresisDb: number;
}

export interface PreGuardConfig {
  enabled: boolean;
  /** Nivel sostenido (dBFS) a partir del cual se baja el previo. */
  ceilingDb: number;
  /** Margen bajo el techo para dar el nivel por recuperado (anti-oscilación). */
  hysteresisDb: number;
}

export interface BusGuardConfig {
  enabled: boolean;
  /** Fracción del cambio de previo que se compensa en los buses (0…1). */
  ratio: number;
}

export interface EngineConfig {
  tickMs: number;
  deadbandDb: number;
  cooldownMs: number;
  /** Paso del previo por tick al atenuar (Stage Guard). */
  stageRampDb: number;
  /** Paso del previo por tick al restaurar: rápido, la voz no puede esperar. */
  stageRestoreDb: number;
  preStepDb: number;
  /** Paso del previo por tick al devolverlo a su referencia (PreGuard). */
  preRestoreDb: number;
  /** Tope del desplazamiento que PreGuard puede acumular sobre el previo. */
  preMaxOffsetDb: number;
  /**
   * Margen tras el último ajuste automático del previo en el que se bloquea el
   * control manual del canal (para que el ajuste se asiente sin pelearse con
   * una mano humana).
   */
  headampLockSettleMs: number;
  headampMin: number;
  sendMin: number;
  sendMax: number;
  levelRetainMs: number;
  /* normalización base */
  baseCadenceMs: number;
  baseRampMs: number;
  baseMaxCorrectionDb: number;
  baseAnomalyLimit: number;
  baseSilenceFloorDb: number;
  baseMinSamples: number;
  baseMinCoverage: number;
}

export interface LevelSample {
  t: number;
  db: number;
}

export interface BaseRamp {
  from: number;
  to: number;
  start: number;
  dur: number;
}

export interface ChannelRuntime {
  id: string;
  num: number;

  /* normalización base (fader) */
  base: BaseConfig;
  baseAnalyzer: unknown;
  baseRef: number | null;
  baseRamp: BaseRamp | null;
  baseAnomalies: number;
  baseLocked: boolean;
  lastBase: string | null;

  /* último valor conocido (medido o asumido tras escribir) */
  fader: number | null;
  headamp: number | null;

  /* Guardas sobre el previo: referencia del operador (sin guardas) */
  nominalGain: number | null;
  stageCfg: StageGuardConfig;
  preCfg: PreGuardConfig;
  stage: { silentSince: number | null; ducked: boolean; target: number | null };
  /* PreGuard: atenuación acumulada (>= 0) sobre la referencia */
  preOffset: number;

  /* BusGuard */
  busLinks: number[];
  busSends: Map<number, number>;
  compHead: number | null;

  cooldownUntil: number;
  /** Fin del bloqueo del control manual del previo (Stage Guard / PreGuard). */
  headampLockUntil: number;
  levels: LevelSample[];
}

export const DEFAULT_ENGINE: EngineConfig = {
  tickMs: 100,
  deadbandDb: 0.5,
  cooldownMs: 2500,
  stageRampDb: 1,
  stageRestoreDb: 5,
  preStepDb: 0.5,
  preRestoreDb: 2,
  preMaxOffsetDb: 18,
  headampLockSettleMs: 1000,
  headampMin: -12,
  sendMin: -90,
  sendMax: 10,
  levelRetainMs: 2000,
  baseCadenceMs: 10000,
  baseRampMs: 2000,
  baseMaxCorrectionDb: 15,
  baseAnomalyLimit: 3,
  baseSilenceFloorDb: -70,
  baseMinSamples: 8,
  baseMinCoverage: 0.5,
};

export const DEFAULT_BASE: BaseConfig = { mode: "off", threshold: 5 };

export const DEFAULT_STAGE: StageGuardConfig = {
  enabled: false,
  threshold: -50,
  duckingDepth: 10,
  holdMs: 1000,
  windowMs: 100,
  hysteresisDb: 3,
};

export const DEFAULT_PRE: PreGuardConfig = {
  enabled: false,
  ceilingDb: -3,
  hysteresisDb: 3,
};
