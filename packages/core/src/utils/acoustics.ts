/* ==========================================================================
 * CueDesk — @cuedesk/core · utils/acoustics.ts
 * --------------------------------------------------------------------------
 * Conversión entre distancia y retardo para la alineación de PA.
 *
 * La velocidad del sonido en aire seco depende de la temperatura:
 *
 *   v(T) = 331.3 + 0.606 · T      [m/s], T en °C
 *
 * A 20 °C son 343.42 m/s. Un grado de más acelera el sonido ~0.18 %, que en
 * 20 m son ~1 ms de error: por eso la temperatura no es un adorno y viaja en
 * la propia escena.
 *
 * Las dos funciones son puras, sin estado y sin DOM. Redondean a 2 decimales,
 * que es la resolución con la que se opera en campo (1 mm ≈ 0.003 ms).
 * ========================================================================== */

/** Temperatura de referencia por defecto, en °C. */
export const DEFAULT_TEMPERATURE_C = 20;

/** Redondeo a 2 decimales, evitando el sesgo binario de `toFixed`. */
export function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/**
 * Velocidad del sonido en aire a una temperatura dada.
 *
 * @param temperatureC temperatura en °C (por defecto 20 °C).
 * @returns velocidad en m/s.
 */
export function speedOfSound(temperatureC: number = DEFAULT_TEMPERATURE_C): number {
  return 331.3 + 0.606 * temperatureC;
}

/**
 * Retardo que introduce una distancia a la velocidad del sonido actual.
 *
 *   t[ms] = (metros / v(T)) · 1000
 *
 * @param meters distancia en metros.
 * @param temperatureC temperatura en °C (por defecto 20 °C).
 * @returns milisegundos redondeados a 2 decimales; `0` si la entrada no es
 *          un número finito (la UI puede pasar un campo vacío).
 */
export function calculateDelayMs(
  meters: number,
  temperatureC: number = DEFAULT_TEMPERATURE_C,
): number {
  if (!Number.isFinite(meters) || !Number.isFinite(temperatureC)) return 0;
  return round2((meters / speedOfSound(temperatureC)) * 1000);
}

/**
 * Distancia equivalente a un retardo a la velocidad del sonido actual.
 *
 *   d[m] = (ms / 1000) · v(T)
 *
 * @param ms retardo en milisegundos.
 * @param temperatureC temperatura en °C (por defecto 20 °C).
 * @returns metros redondeados a 2 decimales; `0` si la entrada no es un
 *          número finito.
 */
export function calculateMeters(
  ms: number,
  temperatureC: number = DEFAULT_TEMPERATURE_C,
): number {
  if (!Number.isFinite(ms) || !Number.isFinite(temperatureC)) return 0;
  return round2((ms / 1000) * speedOfSound(temperatureC));
}
