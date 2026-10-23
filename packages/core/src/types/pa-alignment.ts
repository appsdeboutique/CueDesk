/* ==========================================================================
 * CueDesk — @cuedesk/core · types/pa-alignment.ts
 * --------------------------------------------------------------------------
 * Alineación de PA y procesado por zona de altavoz (v1.0.28).
 *
 * Son tipos de DOMINIO y de ESCENA: no conocen ni una ruta OSC ni un índice
 * físico de la consola. El JSON de escena guarda esta configuración tal cual,
 * plana y ligera, colgada de su ruta activa (`ActiveRoute.speakerZone`).
 *
 * Sólo se usan construcciones que Node elimina sin transformar (sin enums ni
 * parameter properties): el fichero corre directamente con `node`.
 * ========================================================================== */

import {
  calculateDelayMs,
  DEFAULT_TEMPERATURE_C,
} from "../utils/acoustics.ts";

/** Familia del filtro de cruce. */
export type CrossoverType = "Butterworth" | "Linkwitz-Riley" | "Bessel";

/** Pendiente del filtro en dB por octava. */
export type CrossoverSlope = 12 | 18 | 24 | 48;

/**
 * Retardo de un altavoz expresado en las dos unidades de campo.
 *
 * Las dos cifras son la MISMA magnitud: la distancia es la que introduce el
 * operador y el retardo el que resulta de la velocidad del sonido a
 * `temperatureC`. La UI mantiene ambas sincronizadas con los helpers de
 * `utils/acoustics.ts`; aquí se guardan juntas para que la escena sea
 * reproducible sin recalcular.
 */
export interface SystemDelay {
  /** Retardo en milisegundos. */
  milliseconds: number;
  /** Distancia equivalente en metros. */
  meters: number;
  /** Temperatura del aire en °C (afecta a la velocidad del sonido). */
  temperatureC: number;
}

/** Un filtro del cruce (HPF o LPF). */
export interface CrossoverFilter {
  enabled: boolean;
  /** Frecuencia de corte en Hz. */
  frequency: number;
  type: CrossoverType;
  /** Pendiente en dB por octava. */
  slope: CrossoverSlope;
}

/** Limitador de protección de la zona. */
export interface LimiterSettings {
  enabled: boolean;
  /** Umbral en dBFS (valor negativo). */
  thresholdDb: number;
  /** Tiempo de liberación en milisegundos. */
  releaseMs: number;
}

/** Cruce de dos vías de la zona: paso alto y paso bajo. */
export interface CrossoverSettings {
  hpf: CrossoverFilter;
  lpf: CrossoverFilter;
}

/**
 * Procesado completo de una zona de altavoz, ligado a una salida lógica.
 *
 * `outputId` es la salida 1-16 (`/outputs/main/NN`), no un índice de matriz:
 * el módulo es agnóstico del hardware y la app decide qué salida física la
 * alimenta.
 */
export interface SpeakerZoneProcessing {
  /** Salida lógica 1-16 a la que pertenece la zona. */
  outputId: number;
  /** Rótulo humano de la zona ("Sub", "Top L", "Front Fill"…). */
  zoneLabel: string;
  delay: SystemDelay;
  /** `true` = polaridad invertida (180°); `false` = normal (0°). */
  polarityInverted: boolean;
  crossover: CrossoverSettings;
  limiter: LimiterSettings;
}

/** Ejes de fase disponibles en la UI. */
export type Polarity = 0 | 180;

/* --------------------------------------------------------------------------
 * Constructores con valores por defecto
 *
 * La UI crea una zona vacía al abrir el panel de una salida que aún no tiene
 * procesado. Estos constructores evitan que los valores por defecto se
 * dupliquen (y se desincronicen) entre la interfaz y la escena.
 * -------------------------------------------------------------------------- */

/** Retardo coherente: la distancia manda y los ms se calculan con `v(T)`. */
export function createSystemDelay(
  meters: number = 0,
  temperatureC: number = DEFAULT_TEMPERATURE_C,
): SystemDelay {
  return {
    meters: meters,
    milliseconds: calculateDelayMs(meters, temperatureC),
    temperatureC: temperatureC,
  };
}

/** Filtro de cruce apagado por defecto: no altera nada hasta que se activa. */
export function createCrossoverFilter(
  overrides: Partial<CrossoverFilter> = {},
): CrossoverFilter {
  return {
    enabled: false,
    frequency: 1000,
    type: "Linkwitz-Riley",
    slope: 24,
    ...overrides,
  };
}

/** Zona de PA vacía para una salida, con el limitador dentro pero apagado. */
export function createSpeakerZoneProcessing(
  outputId: number,
  zoneLabel: string,
): SpeakerZoneProcessing {
  return {
    outputId: outputId,
    zoneLabel: zoneLabel,
    delay: createSystemDelay(),
    polarityInverted: false,
    crossover: {
      hpf: createCrossoverFilter({ frequency: 40 }),
      lpf: createCrossoverFilter({ frequency: 16000 }),
    },
    limiter: {
      enabled: false,
      thresholdDb: -6,
      releaseMs: 100,
    },
  };
}
