"use strict";

/* ==========================================================================
 * CueDesk — backend/gainGuard/analyzers/lufsAnalyzer.js
 * --------------------------------------------------------------------------
 * §1 · Loudness para pistas de reproducción (objetivo fijo −18 LUFS).
 *
 * Dos vías de entrada, porque no miden lo mismo:
 *
 *  A) pushSamples(frames, fs)  →  EBU R128 DE VERDAD (BS.1770-4):
 *     filtro K (pre-filtro high-shelf + RLB) y bloques de 400 ms con 75 % de
 *     solape. Momentáneo, short-term (3 s) e integrado con puertas absoluta
 *     (−70 LUFS) y relativa (−10 LU). Necesita la ONDA, es decir un *tap* de
 *     audio (tarjeta USB de la consola o equivalente), que hoy no existe.
 *
 *  B) pushLevel(db, t)          →  ESTIMACIÓN desde la telemetría del vúmetro.
 *     Con sólo lecturas de nivel a ~30 Hz no se puede aplicar el filtro K, así
 *     que se calcula la media de potencia de la ventana y se la considera
 *     loudness:
 *
 *         lufs ≈ 10·log10( Σ 10^(dB/10) / n ) + offsetDb
 *
 *     El offset (config `lufsOffsetDb`, por canal) es la calibración entre esa
 *     media y el LUFS real; con un tono puro vale 0 (la constante −0,691 del
 *     R128 la absorbe el propio offset), con programa musical depende del
 *     factor de cresta del material. Toda medida por esta vía sale marcada
 *     `estimated: true` y el servicio la propaga en su estado.
 * ========================================================================== */

/* Parámetros de diseño del filtro K (BS.1770-4 / EBU R128). */
const K_PRE = { f0: 1681.974450955533, q: 0.7071752369554196, gainDb: 3.999843853973347 };
const K_RLB = { f0: 38.13547087602444, q: 0.5003270373238773 };
const OFFSET = -0.691;   // constante de calibración del R128

/**
 * Coeficientes del filtro K para una frecuencia de muestreo dada.
 * A 48 kHz reproduce el juego publicado por la norma.
 */
function designKWeighting(fs) {
  const Vh = Math.pow(10, K_PRE.gainDb / 20);
  const Vb = Math.pow(Vh, 0.4996667741545416);

  const k1 = Math.tan((Math.PI * K_PRE.f0) / fs);
  const d1 = 1 + k1 / K_PRE.q + k1 * k1;
  const pre = {
    b0: (Vh + (Vb * k1) / K_PRE.q + k1 * k1) / d1,
    b1: (2 * (k1 * k1 - Vh)) / d1,
    b2: (Vh - (Vb * k1) / K_PRE.q + k1 * k1) / d1,
    a1: (2 * (k1 * k1 - 1)) / d1,
    a2: (1 - k1 / K_PRE.q + k1 * k1) / d1,
  };

  const k2 = Math.tan((Math.PI * K_RLB.f0) / fs);
  const d2 = 1 + k2 / K_RLB.q + k2 * k2;
  /* El numerador RLB de la norma es [1, −2, 1] tal cual (sin dividir por a0). */
  const rlb = {
    b0: 1,
    b1: -2,
    b2: 1,
    a1: (2 * (k2 * k2 - 1)) / d2,
    a2: (1 - k2 / K_RLB.q + k2 * k2) / d2,
  };

  return { pre: pre, rlb: rlb };
}

/** Biquad en forma directa transpuesta II (sin asignaciones por muestra). */
function createBiquad(c) {
  let z1 = 0;
  let z2 = 0;
  return function process(x) {
    const y = c.b0 * x + z1;
    z1 = c.b1 * x - c.a1 * y + z2;
    z2 = c.b2 * x - c.a2 * y;
    return y;
  };
}

function loudness(meanSquare) {
  return meanSquare > 0 ? OFFSET + 10 * Math.log10(meanSquare) : -Infinity;
}

/**
 * @param {object} [opts]
 * @param {number} [opts.sampleRate=48000] vía A
 * @param {number} [opts.windowMs=3000]    short-term (R128: 3 s)
 * @param {number} [opts.blockMs=400]      bloque momentary (R128: 400 ms)
 * @param {number} [opts.hopMs=100]        avance entre bloques (75 % solape)
 * @param {number} [opts.offsetDb=0]       calibración de la vía B
 */
function createLufsAnalyzer(opts) {
  const options = opts || {};
  const fs = options.sampleRate > 0 ? options.sampleRate : 48000;
  const windowMs = options.windowMs > 0 ? options.windowMs : 3000;
  const blockMs = options.blockMs > 0 ? options.blockMs : 400;
  const hopMs = options.hopMs > 0 ? options.hopMs : 100;
  const offsetDb = isFinite(options.offsetDb) ? options.offsetDb : 0;

  const coeff = designKWeighting(fs);
  const stage1 = createBiquad(coeff.pre);
  const stage2 = createBiquad(coeff.rlb);

  const hopSamples = Math.max(1, Math.round((hopMs * fs) / 1000));
  const blockHops = Math.max(1, Math.round(blockMs / hopMs));
  const shortHops = Math.max(blockHops, Math.round(windowMs / hopMs));

  /* --- vía A: onda ------------------------------------------------------ */
  let hopSum = 0;          // suma de cuadrados K-ponderados del hop abierto
  let hopCount = 0;
  const hops = [];         // { sum, n } por hop cerrado (ventana de 3 s)
  const blocks = [];       // { ms } por bloque de 400 ms (para el integrado)

  /* --- vía B: envolvente de la telemetría ------------------------------ */
  const levels = [];       // { t, pow }
  let newestLevel = null;

  function audioMeanSquare(count) {
    let sum = 0;
    let n = 0;
    for (let i = hops.length - 1; i >= 0 && i >= hops.length - count; i--) {
      sum += hops[i].sum;
      n += hops[i].n;
    }
    return n > 0 ? sum / n : 0;
  }

  function envelopeMeanSquare(now) {
    const from = now - windowMs;
    let sum = 0;
    let n = 0;
    let first = null;
    let last = null;
    for (let i = levels.length - 1; i >= 0; i--) {
      const s = levels[i];
      if (s.t < from) break;
      sum += s.pow;
      n++;
      if (last === null) last = s.t;
      first = s.t;
    }
    return { ms: n > 0 ? sum / n : 0, n: n, span: n > 1 ? last - first : 0 };
  }

  /** Integrado con puertas absoluta y relativa (BS.1770-4). */
  function integrated() {
    const above = [];
    for (let i = 0; i < blocks.length; i++) {
      const l = loudness(blocks[i].ms);
      if (l > -70) above.push({ ms: blocks[i].ms, l: l });
    }
    if (!above.length) return -Infinity;
    let sum = 0;
    for (let i = 0; i < above.length; i++) sum += above[i].l;
    const relativeGate = sum / above.length - 10;
    let sumMs = 0;
    let kept = 0;
    for (let i = 0; i < above.length; i++) {
      if (above[i].l >= relativeGate) {
        sumMs += above[i].ms;
        kept++;
      }
    }
    return kept ? loudness(sumMs / kept) : -Infinity;
  }

  return {
    /** Vía A: onda K-ponderada. `frames` puede ser Float32Array o Array. */
    pushSamples(frames, sampleRate) {
      if (!frames || !frames.length) return;
      if (sampleRate && sampleRate !== fs) return;   // la vía A es de un solo fs
      for (let i = 0; i < frames.length; i++) {
        const w = stage2(stage1(frames[i]));
        hopSum += w * w;
        hopCount++;
        if (hopCount >= hopSamples) {
          hops.push({ sum: hopSum, n: hopCount });
          hopSum = 0;
          hopCount = 0;
          while (hops.length > shortHops) hops.shift();
          const ms = audioMeanSquare(blockHops);
          blocks.push({ ms: ms });
          if (blocks.length > 36000) blocks.shift();
        }
      }
    },

    /** Vía B: lectura de vúmetro en dBFS. */
    pushLevel(db, t) {
      if (!isFinite(t)) return;
      levels.push({ t: t, pow: isFinite(db) ? Math.pow(10, db / 10) : 0 });
      if (newestLevel === null || t > newestLevel) newestLevel = t;
      const floor = t - windowMs * 2;
      while (levels.length && levels[0].t < floor) levels.shift();
    },

    /**
     * @returns {{lufs:number, momentary:number, shortTerm:number,
     *            integrated:number, estimated:boolean, samples:number,
     *            coverage:number, fresh:number|null}}
     */
    value(now) {
      const audioHops = hops.length;
      const env = envelopeMeanSquare(now);
      const fromAudio = audioHops >= blockHops;

      const momentary = fromAudio ? loudness(audioMeanSquare(blockHops)) : -Infinity;
      const shortTerm = fromAudio ? loudness(audioMeanSquare(shortHops)) : -Infinity;
      const est = env.ms > 0 ? 10 * Math.log10(env.ms) + offsetDb : -Infinity;

      return {
        lufs: fromAudio ? shortTerm : est,
        momentary: fromAudio ? momentary : est,
        shortTerm: fromAudio ? shortTerm : est,
        integrated: blocks.length ? integrated() : est,
        estimated: !fromAudio,
        samples: fromAudio ? audioHops * hopSamples : env.n,
        coverage: fromAudio
          ? Math.min(1, (audioHops * hopMs) / windowMs)
          : Math.min(1, env.span / windowMs),
        fresh: fromAudio ? now : newestLevel,
      };
    },

    reset() {
      hopSum = 0;
      hopCount = 0;
      hops.length = 0;
      blocks.length = 0;
      levels.length = 0;
      newestLevel = null;
    },

    get sampleRate() {
      return fs;
    },
    get windowMs() {
      return windowMs;
    },
  };
}

module.exports = { createLufsAnalyzer, designKWeighting, loudness, OFFSET };
