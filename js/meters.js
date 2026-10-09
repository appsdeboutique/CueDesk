/* ==========================================================================
 * CueDesk — meters.js
 * Vúmetros LED (columna mono en canales, dual en master): construcción de
 * segmentos, escala numérica y simulación de respuesta en tiempo real
 * (ballistics + peak hold).
 *
 * En producción los niveles reales llegan por WS con /meters/<id> (suscripción
 * X32) como float lineal 0…1 — 1.0 = 0 dBFS, p. Maillot — y Mixer los convierte
 * a dB en applyMeterPacket. Este módulo trabaja siempre en dB y pinta el
 * recorrido -∞…0 dB (el fader X32 llega a +10 dB: 0 dB = 75 % del recorrido).
 * ========================================================================== */

window.CueDesk = window.CueDesk || {};

CueDesk.Meters = (function () {
  const dB = CueDesk.dB;

  const SEG = 40; // segmentos LED por columna

  /** Escala impresa a los lados: recorrido de -∞ (base) a 0 dB (tope). */
  const SCALE = [
    { db: 0, label: "0" },
    { db: -5, label: "-5" },
    { db: -10, label: "-10" },
    { db: -20, label: "-20" },
    { db: -40, label: "-40" },
    { db: -60, label: "-60" },
    { db: -Infinity, label: "-∞" },
  ];

  /* El vúmetro recorre de -∞ a 0 dB: se normaliza la trisa del fader X32
     (0 dB = 0.75 de su recorrido) para que 0 dB ocupe el tope exacto de la
     columna y -∞ la base. */
  const TOP = dB.toFader(0);

  function meterPos(db) {
    const p = dB.toFader(db) / TOP;
    return p < 0 ? 0 : p > 1 ? 1 : p;
  }

  /** Personalidades sonoras simuladas por posición de tira (0…7). */
  const VOICES = [
    { base: -14, spread: 10, hit: 1.6, decay: 26 }, // 1 · percusivo
    { base: -16, spread: 9, hit: 1.4, decay: 24 },  // 2
    { base: -17, spread: 5, hit: 0.3, decay: 9 },   // 3 · sostenido
    { base: -19, spread: 7, hit: 0.8, decay: 18 },  // 4
    { base: -21, spread: 8, hit: 1.1, decay: 22 },  // 5
    { base: -23, spread: 5, hit: 0.5, decay: 15 },  // 6
    { base: -26, spread: 7, hit: 0.9, decay: 20 },  // 7
    { base: -31, spread: 6, hit: 0.7, decay: 16 },  // 8
  ];

  const MASTER_VOICE = { base: -11, spread: 7, hit: 1.2, decay: 18 };

  let columns = [];
  let sims = [];
  let running = false;
  let lastT = 0;

  /* --------------------------------------------------------- construcción */

  function mount(root) {
    root.querySelectorAll(".meter-scale:not([data-built])").forEach(buildScale);
    root.querySelectorAll(".meter-col:not([data-built])").forEach(function (col) {
      // Construye y cachea en el elemento para que register() lo reutilice
      col.__meter = buildCol(col);
    });
  }

  function buildScale(el) {
    const frag = document.createDocumentFragment();
    SCALE.forEach(function (item) {
      const span = document.createElement("span");
      span.textContent = item.label;
      span.style.setProperty("--p", meterPos(item.db));
      frag.appendChild(span);
    });
    el.appendChild(frag);
    el.setAttribute("data-built", "1");
  }

  function buildCol(col) {
    const frag = document.createDocumentFragment();
    const segs = [];

    // Orden DOM de abajo → arriba (flex-direction: column-reverse)
    for (let i = 0; i < SEG; i++) {
      const p = i / (SEG - 1);
      const db = dB.fromFader(p * TOP); // 0 dB = tope de la columna
      const seg = document.createElement("i");
      seg.className =
        "seg " + (db >= 0 ? "is-red" : db >= -10 ? "is-amber" : "is-green");
      frag.appendChild(seg);
      segs.push(seg);
    }

    const peak = document.createElement("i");
    peak.className = "meter-peak";
    frag.appendChild(peak);

    col.appendChild(frag);
    col.setAttribute("data-built", "1");

    return { segs: segs, peakEl: peak };
  }

  /* ---------------------------------------------------------- registro */

  /** Registra una columna. provider() → nivel en dB. */
  function register(colEl, provider) {
    let inner = colEl.__meter;
    if (!inner) {
      inner = buildCol(colEl);
      colEl.__meter = inner;
    }
    // Limpia el estado visual heredado (p. ej. el master, que no se
    // reconstruye al cambiar de banco y conservaba segmentos encendidos)
    inner.segs.forEach(function (s) { s.classList.remove("on"); });
    inner.peakEl.classList.remove("is-on");

    const st = {
      el: colEl,
      segs: inner.segs,
      peakEl: inner.peakEl,
      provider: provider,
      lit: -1,
      shown: -95,
      peakDb: -95,
      hold: 0,
      lastPk: -1,
      showPeak: false,
    };
    columns.push(st);
    return st;
  }

  /** Registra un simulador de programa (recibe dt en segundos). */
  function addSim(fn) {
    sims.push(fn);
  }

  /** Limpia registros (llamar antes de reconstruir el rack). */
  function reset() {
    columns = [];
    sims = [];
  }

  function prune() {
    columns = columns.filter(function (c) {
      return c.el.isConnected;
    });
    sims = sims.filter(function (fn) {
      return fn.__el ? fn.__el.isConnected : true;
    });
  }

  /* ------------------------------------------------------- simulación */

  function stepVoice(v, voice, dt) {
    if (Math.random() < voice.hit * dt * 60 * 0.16) {
      v.level = voice.base + voice.spread * (0.45 + Math.random() * 0.55);
    } else {
      v.level = Math.max(voice.base - 9, v.level - voice.decay * dt);
    }
    v.level += (Math.random() - 0.5) * 22 * dt;
    v.level = Math.min(
      voice.base + voice.spread + 2,
      Math.max(voice.base - 12, v.level)
    );
  }

  function toLit(db) {
    const pos = meterPos(db);
    if (pos <= 0.004) return 0;
    return Math.max(0, Math.min(SEG, Math.round(pos * SEG)));
  }

  function applyLit(st, lit) {
    const segs = st.segs;
    if (lit > st.lit) {
      for (let i = Math.max(0, st.lit); i < lit; i++) segs[i].classList.add("on");
    } else {
      for (let i = lit; i < st.lit; i++) segs[i].classList.remove("on");
    }
    st.lit = lit;
  }

  function step(dt) {
    for (let i = 0; i < sims.length; i++) sims[i](dt);

    for (let i = 0; i < columns.length; i++) {
      const st = columns[i];
      if (!st.el.isConnected) continue;

      let target = st.provider();
      if (!isFinite(target)) target = -95;
      if (target < -95) target = -95;

      // Ballistics: ataque instantáneo, caída ~34 dB/s
      if (target > st.shown) st.shown = target;
      else st.shown = Math.max(target, st.shown - 34 * dt);

      // Peak hold 850 ms y luego caída lenta
      if (target >= st.peakDb) {
        st.peakDb = target;
        st.hold = 0.85;
      } else {
        st.hold -= dt;
        if (st.hold <= 0) st.peakDb = Math.max(target, st.peakDb - 26 * dt);
      }

      const lit = toLit(st.shown);
      if (lit !== st.lit) applyLit(st, lit);

      const pk = meterPos(st.peakDb);
      if (Math.abs(pk - st.lastPk) > 0.002) {
        st.peakEl.style.setProperty("--pk", pk);
        st.lastPk = pk;
      }

      const show = st.peakDb > st.shown + 1.5 && st.peakDb > -85;
      if (show !== st.showPeak) {
        st.peakEl.classList.toggle("is-on", show);
        st.showPeak = show;
      }
    }
  }

  /* ----------------------------------------------------------- bucle */

  function frame(ts) {
    const dt = Math.min(0.05, (ts - lastT) / 1000);
    lastT = ts;

    const view = CueDesk.app ? CueDesk.app.view : "mixer";
    if (!document.hidden && view === "mixer") step(dt);

    requestAnimationFrame(frame);
  }

  function start() {
    if (running) return;
    running = true;
    lastT = performance.now();
    requestAnimationFrame(frame);
  }

  return {
    SEG: SEG,
    VOICES: VOICES,
    MASTER_VOICE: MASTER_VOICE,
    mount: mount,
    register: register,
    addSim: addSim,
    stepVoice: stepVoice,
    reset: reset,
    prune: prune,
    start: start,
  };
})();
