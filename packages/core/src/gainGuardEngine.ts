/* ==========================================================================
 * CueDesk — @cuedesk/core · gainGuardEngine.ts
 * --------------------------------------------------------------------------
 * GainGuardEngine: bucle de control. Nunca reacciona a un paquete de forma
 * aislada: la telemetría y los cambios de la consola sólo actualizan el
 * estado. Las decisiones se toman en `tick()` (cada 100 ms), en este orden:
 *
 *   0. GainGuard base  → análisis cada 10 s sobre el FADER; rampa de 2 s
 *   1. Stage Guard     → ducking sobre el PREVIO (headamp)
 *   2. PreGuard        → previo gradual sobre el techo A/D
 *   3. BusGuard        → compensa en los 16 buses la variación del PREVIO
 *
 * Reglas transversales: banda muerta de 0,5 dB; cooldown de 2,5 s por canal
 * tras cada ajuste automático (bloquea nuevas acciones, no una rampa en
 * curso). El botón REARM de la interfaz llama a `hold(ms)`: las decisiones se
 * silencian ese tiempo y vuelven solas, sin tocar la configuración.
 *
 * El motor NO conoce la consola. Habla exclusivamente con `ConsoleAdapter`:
 * dice «baja el previo de ch.09 a 18 dB» y el driver decide si eso es
 * `/headamp/008/gain` o cualquier otra cosa. Tampoco conoce los ecos: el
 * driver los marca como `origin: "self"` y aquí simplemente no entran.
 * ========================================================================== */

import type { ChannelId, ConsoleAdapter, ControlChange, LevelFrame } from "@cuedesk/console-adapter";

import { createLufsAnalyzer } from "./analysis/lufsAnalyzer.ts";
import { createRmsAnalyzer } from "./analysis/rmsAnalyzer.ts";
import { baseVerdict, busDelta, clamp, preDecision, rmsOf, stageDecision } from "./guards.ts";
import { DEFAULT_BASE, DEFAULT_ENGINE, DEFAULT_PRE, DEFAULT_STAGE } from "./types.ts";
import type {
  BaseConfig,
  BaseMode,
  BusGuardConfig,
  ChannelRuntime,
  ControlKind,
  EngineConfig,
  PreGuardConfig,
  RearmState,
  StageGuardConfig,
} from "./types.ts";

export interface EngineOptions {
  /** Único enlace del motor con el mundo: nunca conoce rutas ni tapers. */
  adapter: ConsoleAdapter;
  config?: Partial<EngineConfig>;
  bus?: Partial<BusGuardConfig>;
  now?: () => number;
}

export interface EmitRecord {
  t: number;
  kind: ControlKind;
  channel: string;
  db: number;
  bus: number;
  reason: string;
}

export interface IngestResult {
  accepted: boolean;
  reason: string;
}

const RMS_WINDOW_MS = 10000;
const LUFS_WINDOW_MS = 3000;
const FADER_MIN = -90;
const FADER_MAX = 10;
const HEADAMP_MAX = 60;
/* Buses de monitor que BusGuard compensa cuando el canal no declara enlaces:
   por defecto, los 16. */
const ALL_BUSES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16];

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

export class GainGuardEngine {
  private readonly cfg: EngineConfig;
  private readonly busCfg: BusGuardConfig;
  /** El driver. Todo lo que sale y entra pasa por aquí. */
  private readonly adapter: ConsoleAdapter;
  private readonly clock: () => number;
  private readonly channels: Map<string, ChannelRuntime> = new Map();
  private readonly emitted: EmitRecord[] = [];
  private lastBaseAt: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticks = 0;
  /* Pausa REARM: mientras `clock() < holdUntil`, `tick()` no decide nada. */
  private holdUntil = 0;
  private holdMs = 0;

  constructor(options: EngineOptions) {
    this.cfg = Object.assign({}, DEFAULT_ENGINE, options.config || {});
    this.busCfg = Object.assign({ enabled: false, ratio: 1 }, options.bus || {});
    this.clock = options.now || function () { return Date.now(); };
    this.adapter = options.adapter;
    this.lastBaseAt = this.clock();

    /* El driver ya tradujo y ya filtró sus propios ecos: aquí sólo llega
       dominio (canal, dB) o un cambio marcado como "self" que se ignora. */
    this.adapter.onChanges((change) => { this.ingestChange(change); });
    this.adapter.onLevels((frame) => { this.ingestLevels(frame); });
  }

  /* ------------------------------------------------------------ canales */

  /** Registra un canal de entrada ("ch.01" … "ch.32"). */
  addChannel(id: string): ChannelRuntime {
    const m = /^ch\.(\d{2})$/.exec(id);
    const num = m ? Number(m[1]) : NaN;
    if (!(num >= 1 && num <= 32)) throw new RangeError("Canal no válido: " + id);
    const ch: ChannelRuntime = {
      id: id,
      num: num,
      base: Object.assign({}, DEFAULT_BASE),
      baseAnalyzer: null,
      baseRef: null,
      baseRamp: null,
      baseAnomalies: 0,
      baseLocked: false,
      lastBase: null,
      fader: null,
      headamp: null,
      nominalGain: null,
      stageCfg: Object.assign({}, DEFAULT_STAGE),
      preCfg: Object.assign({}, DEFAULT_PRE),
      stage: { silentSince: null, ducked: false, target: null },
      preOffset: 0,
      busLinks: [],
      busSends: new Map(),
      compHead: null,
      cooldownUntil: 0,
      headampLockUntil: 0,
      levels: [],
    };
    this.channels.set(id, ch);
    return ch;
  }

  channel(id: string): ChannelRuntime | undefined {
    return this.channels.get(id);
  }

  /**
   * Normalización base. `threshold` depende del modo: en rms son los 3 ó 5 dB
   * de tolerancia; en lufs, el objetivo (−18 ó −23). Al cambiar de modo sin
   * indicar umbral se usa el de ese modo por defecto.
   */
  configureBase(id: string, patch: Partial<BaseConfig>): BaseConfig {
    const ch = this.require(id);
    const mode: BaseMode = patch.mode !== undefined ? patch.mode : ch.base.mode;
    let threshold = patch.threshold;
    if (threshold === undefined) {
      if (mode !== ch.base.mode) threshold = mode === "lufs" ? -18 : 5;
      else threshold = ch.base.threshold;
    }
    if (mode === "rms") threshold = Math.abs(threshold);
    if (mode !== ch.base.mode) {
      ch.baseAnalyzer = null;
      ch.baseRef = null;
      ch.baseAnomalies = 0;
      ch.baseLocked = false;
      ch.baseRamp = null;
      ch.lastBase = null;
    }
    ch.base = { mode: mode, threshold: threshold };
    return ch.base;
  }

  configureStage(id: string, patch: Partial<StageGuardConfig>): StageGuardConfig {
    const ch = this.require(id);
    ch.stageCfg = Object.assign({}, ch.stageCfg, patch);
    if (ch.stageCfg.duckingDepth < 0) ch.stageCfg.duckingDepth = 0;
    return ch.stageCfg;
  }

  configurePre(id: string, patch: Partial<PreGuardConfig>): PreGuardConfig {
    const ch = this.require(id);
    ch.preCfg = Object.assign({}, ch.preCfg, patch);
    return ch.preCfg;
  }

  configureBus(patch: Partial<BusGuardConfig>): BusGuardConfig {
    Object.assign(this.busCfg, patch);
    this.busCfg.ratio = clamp(this.busCfg.ratio, 0, 1);
    return this.busCfg;
  }

  /**
   * Buses de monitor enlazados al canal. Sin enlaces (lista vacía), BusGuard
   * compensa los 16: el modo stealth no exige declarar buses por canal.
   */
  linkBuses(id: string, buses: number[]): number[] {
    const ch = this.require(id);
    const valid: number[] = [];
    for (const b of buses) {
      if (Number.isInteger(b) && b >= 1 && b <= 16 && valid.indexOf(b) < 0) valid.push(b);
    }
    ch.busLinks = valid.sort(function (a, b) { return a - b; });
    return ch.busLinks.slice();
  }

  /** Valor conocido del envío a un bus (configuración o cambio de la consola). */
  setBusSend(id: string, bus: number, db: number): void {
    this.require(id).busSends.set(bus, db);
  }

  /** Vuelve a permitir la normalización base de un canal bloqueado. */
  arm(id: string): boolean {
    const ch = this.channels.get(id);
    if (!ch) return false;
    ch.baseLocked = false;
    ch.baseAnomalies = 0;
    return true;
  }

  /* ------------------------------------------------------------ entradas */

  /** Telemetría de nivel del canal (dBFS). Sólo se guarda; decide `tick`. */
  ingestLevel(id: string, db: number, t?: number): void {
    const ch = this.require(id);
    const now = t !== undefined ? t : this.clock();
    ch.levels.push({ t: now, db: db });
    const floor = now - this.cfg.levelRetainMs;
    while (ch.levels.length && ch.levels[0].t < floor) ch.levels.shift();

    const an = this.baseAnalyzerOf(ch);
    if (!an) return;
    if (ch.base.mode === "rms") (an as ReturnType<typeof createRmsAnalyzer>).push(db, now);
    else (an as ReturnType<typeof createLufsAnalyzer>).pushLevel(db, now);
  }

  /** Trama de telemetría del driver: se reparte por canal. */
  ingestLevels(frame: LevelFrame): void {
    for (const reading of frame.levels) {
      if (!this.channels.has(reading.channel)) continue;
      this.ingestLevel(reading.channel, reading.db, frame.at);
    }
  }

  /**
   * Cambio de la consola ya traducido a dominio (fader, previo o envío a bus).
   * Si lo marcó el driver como eco propio se descarta; si no, pasa a ser el
   * valor conocido.
   */
  ingestChange(change: ControlChange, t?: number): IngestResult {
    const at = t !== undefined ? t : this.clock();
    if (change.origin === "self") return { accepted: false, reason: "own-echo" };

    const id: ChannelId = change.target.channel;
    const ch = this.channels.get(id);
    if (!ch) return { accepted: false, reason: "unknown-channel" };

    if (change.target.kind === "fader") {
      if (typeof change.db !== "number" || !Number.isFinite(change.db)) {
        return { accepted: false, reason: "not-a-level" };
      }
      ch.fader = change.db;
      return { accepted: true, reason: "external" };
    }

    if (change.target.kind === "send") {
      if (typeof change.db !== "number" || !Number.isFinite(change.db)) {
        return { accepted: false, reason: "not-a-level" };
      }
      ch.busSends.set(change.target.bus, change.db);
      return { accepted: true, reason: "external" };
    }

    /* Previo. El +48 V no es una magnitud de GainGuard: se ignora. */
    if (typeof change.db !== "number" || !Number.isFinite(change.db)) {
      return { accepted: false, reason: "not-a-level" };
    }
    const db = change.db;

    /* Control manual bloqueado mientras una guarda mueve el previo: se
       descarta el valor humano y se reafirma el nuestro, para que la consola
       no se quede en un valor que el motor desconoce. */
    if (at < ch.headampLockUntil) {
      if (ch.headamp !== null) this.emit(ch, "headamp", 0, ch.headamp, at, "guard-lock", false);
      return { accepted: false, reason: "guard-locked" };
    }
    /* La base de BusGuard se fija con el primer valor, no en el siguiente tick,
       para no perder un cambio que llegue antes del primer ciclo. */
    if (ch.compHead === null) ch.compHead = ch.headamp !== null ? ch.headamp : change.db;
    /* Un cambio manual pasa a ser la nueva referencia del operador: se
       descuenta lo que las guardas tenían aplicado, para que no lo deshagan
       al recuperar. */
    const stageOff = ch.stage.ducked ? -ch.stageCfg.duckingDepth : 0;
    ch.nominalGain = change.db - stageOff + ch.preOffset;
    ch.headamp = change.db;
    return { accepted: true, reason: "external" };
  }

  /* ------------------------------------------------------------ reloj */

  /** Un ciclo del pipeline. `now` opcional para pruebas deterministas. */
  tick(now?: number): void {
    const t = now !== undefined ? now : this.clock();
    this.ticks++;

    /* Pausa REARM: ni una decisión mientras dure. La cadencia base se corre
       con el reloj para que, al volver, no dispare un análisis atrasado; la
       telemetría y los cambios de la consola se siguen registrando (así el
       motor conoce el estado real al rearmarse). */
    if (t < this.holdUntil) {
      this.lastBaseAt = t;
      return;
    }

    const chans = Array.from(this.channels.values());

    // Base de BusGuard antes de cualquier automatismo de este ciclo.
    for (const ch of chans) {
      if (ch.compHead === null) ch.compHead = ch.headamp;
    }

    if (t - this.lastBaseAt >= this.cfg.baseCadenceMs) {
      this.lastBaseAt = t;
      for (const ch of chans) this.analyzeBase(ch, t);
    }
    for (const ch of chans) this.stepBaseRamp(ch, t);
    for (const ch of chans) this.stepHeadamp(ch, t);
    for (const ch of chans) this.stepBus(ch, t);
  }

  /** Arranca el ciclo periódico (cada `tickMs`). */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), this.cfg.tickMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Pausa temporal (botón REARM): la automatización deja de decidir durante
   * `ms` milisegundos y se rearma sola. No toca la configuración ni el estado
   * por canal —guardas, umbrales, referencias y desplazamientos quedan
   * intactos—: sólo silencia `tick()`. Con un valor no finito o ≤ 0 equivale a
   * un rearme inmediato. Sin argumento usa el plazo del motor (`rearmMs`).
   */
  hold(ms?: number): RearmState {
    const dur = ms === undefined ? this.cfg.rearmMs : ms;
    if (!Number.isFinite(dur) || dur <= 0) return this.rearm();
    this.holdMs = dur;
    this.holdUntil = this.clock() + dur;
    return this.rearmState();
  }

  /** Levanta la pausa de inmediato (rearme manual o fin del plazo). */
  rearm(): RearmState {
    this.holdMs = 0;
    this.holdUntil = 0;
    return this.rearmState();
  }

  /** Estado de la pausa REARM, para la cuenta atrás de la interfaz. */
  rearmState(): RearmState {
    const t = this.clock();
    const held = t < this.holdUntil;
    return {
      held: held,
      remainingMs: held ? this.holdUntil - t : 0,
      totalMs: held ? this.holdMs : 0,
    };
  }

  /* ------------------------------------------------------------ pasos */

  private baseAnalyzerOf(ch: ChannelRuntime): unknown {
    if (ch.base.mode === "off") return null;
    if (!ch.baseAnalyzer) {
      ch.baseAnalyzer = ch.base.mode === "rms"
        ? createRmsAnalyzer({ windowMs: RMS_WINDOW_MS })
        : createLufsAnalyzer({ sampleRate: 48000, windowMs: LUFS_WINDOW_MS, offsetDb: 0 });
    }
    return ch.baseAnalyzer;
  }

  /** Cada 10 s: mide, decide y, si procede, arranca una rampa de fader de 2 s. */
  private analyzeBase(ch: ChannelRuntime, t: number): void {
    if (ch.base.mode === "off") return;
    const an = this.baseAnalyzerOf(ch);
    if (!an) return;
    const rms = ch.base.mode === "rms";
    const v: any = rms
      ? (an as any).value(t)
      : (an as any).value(t);
    const measured = rms ? v.db : v.lufs;
    const reading = { measuredDb: measured, samples: v.samples, coverage: v.coverage };

    if (rms && ch.baseRef === null) {
      const usable = Number.isFinite(measured)
        && measured > this.cfg.baseSilenceFloorDb
        && v.samples >= this.cfg.baseMinSamples
        && v.coverage >= this.cfg.baseMinCoverage;
      if (usable) {
        ch.baseRef = round1(measured);
        ch.lastBase = "learned";
      } else {
        ch.lastBase = "learning";
      }
      return;
    }
    if (ch.baseLocked) {
      ch.lastBase = "locked";
      return;
    }

    const target = rms ? (ch.baseRef as number) : ch.base.threshold;
    const tolerance = rms ? ch.base.threshold : this.cfg.deadbandDb;
    const verdict = baseVerdict(reading, target, tolerance, this.cfg);
    ch.lastBase = verdict.reason;

    if (verdict.decision === "manual") {
      ch.baseAnomalies++;
      if (ch.baseAnomalies >= this.cfg.baseAnomalyLimit) ch.baseLocked = true;
      return;
    }
    ch.baseAnomalies = 0;
    if (verdict.decision !== "act") return;
    if (ch.fader === null) {
      ch.lastBase = "fader-unknown";
      return;
    }
    if (t < ch.cooldownUntil || ch.baseRamp) {
      ch.lastBase = "cooldown";
      return;
    }
    ch.baseRamp = {
      from: ch.fader,
      to: clamp(ch.fader + verdict.deltaDb, FADER_MIN, FADER_MAX),
      start: t,
      dur: this.cfg.baseRampMs,
    };
    ch.cooldownUntil = t + this.cfg.cooldownMs;
  }

  /** Avanza la rampa de fader. Los pasos no pasan por la banda muerta: forman parte de una corrección ya decidida. */
  private stepBaseRamp(ch: ChannelRuntime, t: number): void {
    const r = ch.baseRamp;
    if (!r) return;
    const p = clamp((t - r.start) / r.dur, 0, 1);
    const want = p >= 1 ? r.to : r.from + (r.to - r.from) * p;
    this.emit(ch, "fader", 0, want, t, "base-guard", false);
    if (p >= 1) ch.baseRamp = null;
  }

  /**
   * Guardas sobre el previo (Stage Guard + PreGuard) con **objetivo único**.
   *
   * Las dos guardas comparten el mismo mando, así que no calculan un valor
   * absoluto cada una: mantienen un desplazamiento sobre una referencia común
   * (`nominalGain`) y el motor compone un solo objetivo por ciclo. Al haber un
   * único emisor no pueden entablar un bucle de ajustes sobre el previo:
   *
   *     previo = nominalGain + stageOffset (0 | −depth) − preOffset
   */
  private stepHeadamp(ch: ChannelRuntime, t: number): void {
    if (ch.headamp === null || ch.nominalGain === null) return;

    /* --- Stage Guard: decide si hay que atenuar --- */
    const rms = rmsOf(ch.levels, t, ch.stageCfg.windowMs);
    const decision = ch.stageCfg.enabled
      ? stageDecision(ch, rms, t)
      : (ch.stage.ducked ? "restore" : null);
    /* Restaurar no espera al cooldown: el cooldown sólo frena bajadas nuevas.
       La voz no puede esperar. */
    const stageChanged =
      !!decision && (decision === "restore" || t >= ch.cooldownUntil);
    if (stageChanged) ch.stage.ducked = decision === "duck";

    /* --- PreGuard: acumula o suelta su desplazamiento --- */
    let preChanged = false;
    const sustained = rmsOf(ch.levels, t, 1000);
    const hot = Number.isFinite(sustained) && sustained > ch.preCfg.ceilingDb;
    if (ch.preCfg.enabled) {
      /* Proteger es un ajuste automático: respeta el cooldown. Devolver no. */
      if (!hot || t >= ch.cooldownUntil) {
        const action = preDecision(
          ch,
          sustained,
          this.cfg.preStepDb,
          this.cfg.preRestoreDb,
          this.cfg.deadbandDb,
          this.cfg.preMaxOffsetDb
        );
        if (action) {
          ch.preOffset = action.offset;
          preChanged = true;
        }
      }
    } else if (ch.preOffset > 0) {
      /* PreGuard apagado: el desplazamiento se suelta igual que al recuperar. */
      const next = Math.max(0, ch.preOffset - this.cfg.preRestoreDb);
      preChanged = next !== ch.preOffset;
      ch.preOffset = next;
    }

    /* --- Objetivo único del previo --- */
    const stageOffset = ch.stage.ducked ? -ch.stageCfg.duckingDepth : 0;
    const target = clamp(
      ch.nominalGain + stageOffset - ch.preOffset,
      this.cfg.headampMin,
      HEADAMP_MAX
    );
    const diff = target - ch.headamp;
    ch.stage.target = Math.abs(diff) < this.cfg.deadbandDb ? null : target;
    if (ch.stage.target === null) return;

    /* Bajada suave (sin cortar la señal); subida rápida. Sólo la bajada
       renueva el cooldown. */
    const down = diff < 0;
    const maxStep = down ? this.cfg.stageRampDb : this.cfg.stageRestoreDb;
    const step = clamp(diff, -maxStep, maxStep);
    let reason = "headamp-guard";
    if (stageChanged) reason = "stage-guard";
    else if (preChanged) reason = "pre-guard";
    else if (ch.stage.ducked) reason = "stage-guard";
    else if (ch.preOffset > 0) reason = "pre-guard";
    this.emit(ch, "headamp", 0, ch.headamp + step, t, reason, down);
  }

  private stepBus(ch: ChannelRuntime, t: number): void {
    if (!this.busCfg.enabled) {
      ch.compHead = ch.headamp;
      return;
    }
    const delta = busDelta(ch);
    if (Math.abs(delta) < this.cfg.deadbandDb) return;
    /* Stealth: sin enlaces declarados, el canal se compensa en los 16 buses
       (el fader del canal dentro de la mezcla de cada bus). */
    const buses = ch.busLinks.length ? ch.busLinks : ALL_BUSES;
    for (const bus of buses) {
      const known = ch.busSends.get(bus);
      if (known === undefined) continue;
      const target = clamp(known - this.busCfg.ratio * delta, this.cfg.sendMin, this.cfg.sendMax);
      this.emit(ch, "send", bus, target, t, "bus-guard", false);
    }
    ch.compHead = ch.headamp;
  }

  /**
   * Emite un ajuste: se lo pide al adaptador, asume el valor y renueva el
   * cooldown si es automático. Aquí no hay ni una ruta.
   */
  private emit(ch: ChannelRuntime, kind: ControlKind, bus: number, db: number, t: number, reason: string, automatic: boolean): void {
    if (kind === "fader") this.adapter.setChannelFader(ch.id, db);
    else if (kind === "headamp") this.adapter.setPreampGain(ch.id, db);
    else this.adapter.setChannelSend(ch.id, bus, db);

    if (kind === "fader") ch.fader = db;
    else if (kind === "headamp") {
      if (ch.compHead === null) ch.compHead = ch.headamp;
      ch.headamp = db;
      ch.headampLockUntil = Math.max(ch.headampLockUntil, t + this.cfg.headampLockSettleMs);
    } else ch.busSends.set(bus, db);

    if (automatic) ch.cooldownUntil = t + this.cfg.cooldownMs;
    this.emitted.push({ t: t, kind: kind, channel: ch.id, db: db, bus: bus, reason: reason });
    while (this.emitted.length > 500) this.emitted.shift();
  }

  /* ------------------------------------------------------------ estado */

  recentEmits(): EmitRecord[] {
    return this.emitted.slice();
  }

  /**
   * Última lectura de nivel por canal (dBFS). Sólo aparecen los canales con
   * telemetría fresca: `ingestLevel` purga lo más viejo que `levelRetainMs`, así
   * que un canal en silencio de datos no se publica y la interfaz cae a su
   * propia simulación. Es la superficie de sondeo mientras no hay puente en
   * tiempo real.
   */
  latestLevels(): Array<{ channel: string; db: number }> {
    const out: Array<{ channel: string; db: number }> = [];
    this.channels.forEach((ch) => {
      if (!ch.levels.length) return;
      out.push({ channel: ch.id, db: ch.levels[ch.levels.length - 1].db });
    });
    return out;
  }

  status(): {
    ticks: number;
    bus: BusGuardConfig;
    rearm: RearmState;
    link: Record<string, unknown>;
    channels: Array<Record<string, unknown>>;
  } {
    const t = this.clock();
    const channels: Array<Record<string, unknown>> = [];
    this.channels.forEach((ch) => {
      channels.push({
        id: ch.id,
        base: ch.base,
        lastBase: ch.lastBase,
        baseRef: ch.baseRef,
        baseLocked: ch.baseLocked,
        baseAnomalies: ch.baseAnomalies,
        fader: ch.fader,
        headamp: ch.headamp,
        nominalGain: ch.nominalGain,
        stage: Object.assign({}, ch.stageCfg, { ducked: ch.stage.ducked, target: ch.stage.target }),
        pre: Object.assign({}, ch.preCfg, { offset: ch.preOffset }),
        /* Bloqueo del control manual del previo mientras actúa una guarda. */
        lock: { active: t < ch.headampLockUntil, until: Math.max(0, ch.headampLockUntil - t) },
        buses: ch.busLinks.slice(),
        sends: Array.from(ch.busSends.entries()).map(function (e) {
          return { bus: e[0], db: e[1] };
        }),
        cooldownMs: Math.max(0, ch.cooldownUntil - t),
      });
    });
    return {
      ticks: this.ticks,
      bus: Object.assign({}, this.busCfg),
      rearm: this.rearmState(),
      link: this.adapter.linkStatus(),
      channels: channels,
    };
  }

  private require(id: string): ChannelRuntime {
    const ch = this.channels.get(id);
    if (!ch) throw new RangeError("Canal no válido: " + id);
    return ch;
  }
}
