"use strict";

/* ==========================================================================
 * CueDesk — backend/gainGuard/analyzers/rmsAnalyzer.js
 * --------------------------------------------------------------------------
 * §1 · Análisis de medias RMS por ventana deslizante (micrófono / línea).
 *
 * Entra el nivel del canal en dBFS (lo que entrega la telemetría /meters/1,
 * ya convertido de lineal a dB por la capa de transporte) y se mantiene la
 * MEDIA RMS de la ventana:
 *
 *     potencia = Σ 10^(dB/10) / n     →     rms = 10·log10(potencia)
 *
 * Además se parte la ventana por la mitad: la diferencia entre la media de la
 * primera mitad y la de la segunda es el "paso" (`stepDb`), que es el detector
 * útil de saltos sostenidos (un micro que se cae, un canal que cambia de
 * fuente). La velocidad instantánea entre lecturas del vúmetro no sirve para
 * esto: con material musical salta constantemente.
 *
 * Nota de honestidad técnica: la consola entrega *lecturas de nivel* de su
 * vúmetro (no la onda). La media de esas lecturas es una media RMS de la
 * envolvente; si el vúmetro de la consola fuese de pico, la lectura sería una
 * media de picos. Queda marcado como valor a verificar con hardware real.
 * ========================================================================== */

/**
 * @param {object} [opts]
 * @param {number} [opts.windowMs=10000]  tamaño de la ventana deslizante
 * @param {number} [opts.retainMs]        memoria máxima (por defecto 2 ventanas)
 */
function createRmsAnalyzer(opts) {
  const options = opts || {};
  const windowMs = options.windowMs > 0 ? options.windowMs : 10000;
  const retainMs = options.retainMs > 0 ? options.retainMs : windowMs * 2;

  /** Muestras { t, pow }: potencia lineal (10^(dB/10)) y su instante. */
  const samples = [];
  let newest = null;

  function prune(now) {
    const floor = now - retainMs;
    while (samples.length && samples[0].t < floor) samples.shift();
  }

  /** Acumula la ventana y sus dos mitades. */
  function scan(now) {
    const from = now - windowMs;
    const mid = now - windowMs / 2;
    const w = { sum: 0, n: 0, first: null, last: null };
    const a = { sum: 0, n: 0 };
    const b = { sum: 0, n: 0 };
    for (let i = samples.length - 1; i >= 0; i--) {
      const s = samples[i];
      if (s.t < from) break;
      w.sum += s.pow;
      w.n++;
      if (w.last === null) w.last = s.t;
      w.first = s.t;
      if (s.t < mid) {
        a.sum += s.pow;
        a.n++;
      } else {
        b.sum += s.pow;
        b.n++;
      }
    }
    return { w: w, a: a, b: b };
  }

  function db(sum, n) {
    return n > 0 && sum > 0 ? 10 * Math.log10(sum / n) : -Infinity;
  }

  return {
    /** Añade una lectura. `db = -Infinity` cuenta como silencio (potencia 0). */
    push(dbValue, t) {
      if (!isFinite(t)) return;
      const pow = isFinite(dbValue) ? Math.pow(10, dbValue / 10) : 0;
      samples.push({ t: t, pow: pow });
      if (newest === null || t > newest) newest = t;
      prune(newest);
    },

    /**
     * Lectura de la ventana.
     * @returns {{db:number, samples:number, coverage:number, fresh:number|null,
     *            stepDb:number|null, firstHalfDb:number, secondHalfDb:number}}
     *   db        media RMS en dBFS (-Infinity si no hay señal)
     *   samples   lecturas dentro de la ventana
     *   coverage  fracción de la ventana cubierta por las lecturas (0…1)
     *   fresh     instante de la última lectura (null si no hay ninguna)
     *   stepDb    segunda mitad − primera mitad (null si falta una mitad)
     */
    value(now) {
      prune(now);
      const s = scan(now);
      const firstDb = db(s.a.sum, s.a.n);
      const secondDb = db(s.b.sum, s.b.n);
      const step = isFinite(firstDb) && isFinite(secondDb) ? secondDb - firstDb : null;
      const span = s.w.n > 1 ? s.w.last - s.w.first : 0;
      return {
        db: db(s.w.sum, s.w.n),
        samples: s.w.n,
        coverage: Math.min(1, span / windowMs),
        fresh: newest,
        stepDb: step,
        firstHalfDb: firstDb,
        secondHalfDb: secondDb,
      };
    },

    reset() {
      samples.length = 0;
      newest = null;
    },

    get windowMs() {
      return windowMs;
    },
  };
}

module.exports = { createRmsAnalyzer };
