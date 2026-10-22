/* ==========================================================================
 * CueDesk — @cuedesk/console-x32 · X32Adapter.ts
 * --------------------------------------------------------------------------
 * Driver de la familia Behringer X32 / Midas M32 (OSC no oficial).
 *
 * Implementa `ConsoleAdapter`: hacia arriba habla en dominio (canales, dB,
 * previo); hacia abajo habla OSC a través de un `ConsoleLink`. Es el ÚNICO
 * sitio del sistema que conoce las rutas de esta consola.
 *
 * Responsabilidades que absorbe (y que antes tenía repartidas el motor):
 *   · Direccionar el previo: banco (Local / Net Primary / Net Secondary) + índice.
 *   · Convertir dB ⇄ valor de cable (taper de faders y envíos).
 *   · Descartar los ECOS de lo que escribe CueDesk (ventana + tolerancia por
 *     tipo de control), para que el motor no reaccione a su propio eco.
 * ========================================================================== */

import { ConsoleAdapterError } from "@cuedesk/console-adapter";
import type {
  BusId,
  ChannelId,
  ConsoleAdapter,
  ConsoleCapabilities,
  ConsoleInfo,
  ConsoleLink,
  ControlChange,
  LevelFrame,
  LevelReading,
  PreampRouting,
  Unsubscribe,
} from "@cuedesk/console-adapter";

import { channelIdOf, channelNumberOf, faderPath, headampGainPath, headampPhantomPath, parseControlPath, sendPath } from "./paths.ts";
import { HEADAMP_BASE, PREAMP_BANKS, isBankId, resolveHeadampIndex } from "./preamps.ts";
import { WIRE_TOLERANCE, fromFader, fromLinear, toFader } from "./taper.ts";

export interface X32AdapterOptions {
  link: ConsoleLink;
  now?: () => number;
  /** Ventana en la que un valor devuelto por la consola se considera eco. */
  echoWindowMs?: number;
  channels?: number;
  buses?: number;
}

interface PendingWrite {
  path: string;
  wire: number;
  at: number;
  tol: number;
}

const DEFAULT_ECHO_WINDOW_MS = 500;
const DEFAULT_CHANNELS = 32;
const DEFAULT_BUSES = 16;

export class X32Adapter implements ConsoleAdapter {
  private readonly link: ConsoleLink;
  private readonly clock: () => number;
  private readonly echoWindowMs: number;
  private readonly channelCount: number;
  private readonly busCount: number;

  /** Banco de previos elegido por canal. Sin entrada, `local`. */
  private readonly banks: Map<ChannelId, string> = new Map();

  /** Escrituras recientes, para reconocer ecos y no reaccionar a ellos. */
  private pending: PendingWrite[] = [];
  private sentCount = 0;
  private echoCount = 0;

  private connected = false;
  private consoleInfo: ConsoleInfo | null = null;
  private changeCb: ((change: ControlChange) => void) | null = null;
  private levelCb: ((frame: LevelFrame) => void) | null = null;
  private offs: Unsubscribe[] = [];

  constructor(options: X32AdapterOptions) {
    if (!options || !options.link) {
      throw new ConsoleAdapterError("bad-argument", "X32Adapter necesita un ConsoleLink");
    }
    this.link = options.link;
    this.clock = options.now || function () { return Date.now(); };
    this.echoWindowMs = options.echoWindowMs !== undefined ? options.echoWindowMs : DEFAULT_ECHO_WINDOW_MS;
    this.channelCount = options.channels || DEFAULT_CHANNELS;
    this.busCount = options.buses || DEFAULT_BUSES;
  }

  /* --------------------------------------------------------------- ciclo */

  get info(): ConsoleInfo | null {
    return this.consoleInfo;
  }

  get capabilities(): ConsoleCapabilities {
    return {
      channels: this.channelCount,
      buses: this.busCount,
      preamp: "headamp",
      sendsArePostEq: true,
      preampBanks: PREAMP_BANKS.slice(),
    };
  }

  async connect(): Promise<ConsoleInfo> {
    this.subscribe();
    if (!this.consoleInfo) {
      this.consoleInfo = {
        model: "Behringer X32 / Midas M32",
        capabilities: this.capabilities,
      };
    }
    this.connected = true;
    return this.consoleInfo;
  }

  async disconnect(): Promise<void> {
    for (const off of this.offs) {
      try { off(); } catch (_) { /* el enlace ya se cerró */ }
    }
    this.offs = [];
    this.connected = false;
  }

  /* ------------------------------------------------------------- previo */

  setPreampGain(channel: ChannelId, db: number): void {
    const routing = this.preampRoutingOf(channel);
    this.write(headampGainPath(routing.index), db, "f", WIRE_TOLERANCE.headamp);
  }

  setPreampPhantom(channel: ChannelId, on: boolean): void {
    const routing = this.preampRoutingOf(channel);
    this.write(headampPhantomPath(routing.index), on ? 1 : 0, "i", 0);
  }

  assignPreampBank(channel: ChannelId, bankId: string): void {
    this.requireChannelNumber(channel);
    if (!isBankId(bankId)) {
      throw new ConsoleAdapterError("bad-bank", "Banco de previos no válido: " + String(bankId));
    }
    this.banks.set(channel, bankId);
  }

  preampBankOf(channel: ChannelId): string {
    const bank = this.banks.get(channel);
    return bank !== undefined ? bank : PREAMP_BANKS[0].id;
  }

  preampRoutingOf(channel: ChannelId): PreampRouting {
    const bankId = this.preampBankOf(channel) as keyof typeof HEADAMP_BASE;
    const num = this.requireChannelNumber(channel);
    return { bankId: bankId, index: HEADAMP_BASE[bankId] + (num - 1) };
  }

  /* -------------------------------------------------------------- canal */

  setChannelFader(channel: ChannelId, db: number): void {
    const n = this.requireChannelNumber(channel);
    this.write(faderPath(n), toFader(db), "f", WIRE_TOLERANCE.fader);
  }

  setChannelSend(channel: ChannelId, bus: BusId, db: number): void {
    const n = this.requireChannelNumber(channel);
    if (!Number.isInteger(bus) || bus < 1 || bus > this.busCount) {
      throw new ConsoleAdapterError("bad-argument", "Bus fuera de rango: " + String(bus));
    }
    this.write(sendPath(n, bus), toFader(db), "f", WIRE_TOLERANCE.send);
  }

  /**
   * Escritura genérica del puente de la interfaz. Se registra como pendiente
   * con la misma tolerancia de eco que su control (el previo se devuelve
   * redondeado a 0,5 dB), y el tipo OSC se infiere de la ruta cuando no se
   * indica (el phantom es "i"; el resto, "f").
   */
  writeRaw(path: string, args: unknown[], type?: string): void {
    if (typeof path !== "string" || path.charAt(0) !== "/") {
      throw new ConsoleAdapterError("bad-argument", "Ruta OSC no válida: " + String(path));
    }
    const list = Array.isArray(args) ? args : [];
    const first = list.length ? list[0] : 0;

    /* Argumento de texto (nombre, …): sin magnitud numérica que casar. */
    if (typeof first === "string") {
      this.link.send(path, first, "s");
      this.sentCount++;
      return;
    }

    const parsed = parseControlPath(path);
    const wire = Number(first);
    if (!Number.isFinite(wire)) {
      throw new ConsoleAdapterError("bad-argument", "Argumento no numérico en " + path);
    }
    const wireType = type || (parsed && parsed.kind === "headamp-phantom" ? "i" : "f");
    const tol = parsed && parsed.kind === "headamp-gain" ? WIRE_TOLERANCE.headamp : WIRE_TOLERANCE.fader;
    this.write(path, wire, wireType, tol);
  }

  /* ------------------------------------------------------------ eventos */

  onChanges(cb: (change: ControlChange) => void): Unsubscribe {
    this.changeCb = cb;
    return () => { if (this.changeCb === cb) this.changeCb = null; };
  }

  onLevels(cb: (frame: LevelFrame) => void): Unsubscribe {
    this.levelCb = cb;
    return () => { if (this.levelCb === cb) this.levelCb = null; };
  }

  linkStatus(): Record<string, unknown> {
    const status = this.link.status ? this.link.status() : null;
    return {
      connected: this.connected,
      echoWindowMs: this.echoWindowMs,
      sent: this.sentCount,
      echoesDropped: this.echoCount,
      pending: this.pending.length,
      transport: status,
    };
  }

  /* -------------------------------------------------------------- enlace */

  private subscribe(): void {
    if (this.offs.length) return;
    this.offs.push(this.link.on("/ch/*", (args, path) => this.onChannelPath(path, args)));
    this.offs.push(this.link.on("/headamp/*", (args, path) => this.onHeadampPath(path, args)));
    this.offs.push(this.link.on("/meters/1", (args) => this.onMeters(args)));
  }

  private onChannelPath(path: string, args: unknown[]): void {
    const parsed = parseControlPath(path);
    if (!parsed || (parsed.kind !== "fader" && parsed.kind !== "send")) return;
    const wire = Number(args[0]);
    if (!Number.isFinite(wire)) return;
    const at = this.clock();
    if (this.consumeEcho(path, wire, at)) return;

    const channel = channelIdOf(parsed.channelNumber);
    const db = fromFader(wire);
    this.dispatch(parsed.kind === "fader"
      ? { target: { kind: "fader", channel: channel }, db: db, origin: "console" }
      : { target: { kind: "send", channel: channel, bus: parsed.bus }, db: db, origin: "console" });
  }

  private onHeadampPath(path: string, args: unknown[]): void {
    const parsed = parseControlPath(path);
    if (!parsed || (parsed.kind !== "headamp-gain" && parsed.kind !== "headamp-phantom")) return;

    const channel = this.channelForHeadampIndex(parsed.headampIndex);
    const at = this.clock();

    if (parsed.kind === "headamp-phantom") {
      const on = Number(args[0]) ? 1 : 0;
      if (this.consumeEcho(path, on, at)) return;
      if (!channel) return;
      this.dispatch({ target: { kind: "preamp", channel: channel }, on: on === 1, origin: "console" });
      return;
    }

    const wire = Number(args[0]);
    if (!Number.isFinite(wire)) return;
    if (this.consumeEcho(path, wire, at)) return;
    if (!channel) return;
    this.dispatch({ target: { kind: "preamp", channel: channel }, db: wire, origin: "console" });
  }

  private onMeters(args: unknown[]): void {
    if (!this.levelCb) return;
    const list: unknown[] = Array.isArray(args[0]) ? (args[0] as unknown[]) : args;
    if (list.length !== this.channelCount) return;
    const levels: LevelReading[] = [];
    for (let i = 0; i < this.channelCount; i++) {
      const raw = list[i];
      /* El `/meters/1` de la X32 llega en LINEAL (1,0 = 0 dBFS); el motor
         trabaja en dBFS. */
      const db = fromLinear(Number(Array.isArray(raw) ? (raw as unknown[])[0] : raw));
      if (Number.isFinite(db)) levels.push({ channel: channelIdOf(i + 1), db: db });
    }
    this.levelCb({ levels: levels });
  }

  /* -------------------------------------------------------------- interno */

  private requireChannelNumber(channel: ChannelId): number {
    const n = channelNumberOf(channel);
    if (n === null || n < 1 || n > this.channelCount) {
      throw new ConsoleAdapterError("bad-channel", "Canal no válido: " + String(channel));
    }
    return n;
  }

  /** Escribe y recuerda: la consola devuelve lo mismo poco después (eco). */
  private write(path: string, wire: number, type: string, tol: number): void {
    const at = this.clock();
    this.prune(at);
    this.pending.push({ path: path, wire: wire, at: at, tol: tol });
    this.link.send(path, wire, type);
    this.sentCount++;
  }

  private prune(at: number): void {
    const windowMs = this.echoWindowMs;
    this.pending = this.pending.filter(function (p) { return at - p.at <= windowMs; });
  }

  /** true si el valor entrante es eco de algo que escribimos (se descarta). */
  private consumeEcho(path: string, wire: number, at: number): boolean {
    this.prune(at);
    const i = this.pending.findIndex(function (p) {
      return p.path === path && Math.abs(p.wire - wire) <= p.tol;
    });
    if (i < 0) return false;
    this.pending.splice(i, 1);
    this.echoCount++;
    return true;
  }

  private dispatch(change: ControlChange): void {
    if (this.changeCb) this.changeCb(change);
  }

  /**
   * Índice físico `/headamp/NNN` → canal. Los rangos de los bancos son
   * disjuntos, así que el índice identifica (banco, entrada) sin ambigüedad:
   * sólo es nuestro si ese canal está asignado a ese banco.
   */
  private channelForHeadampIndex(index: number): ChannelId | null {
    const hit = resolveHeadampIndex(index);
    if (!hit) return null;
    if (hit.entry < 1 || hit.entry > this.channelCount) return null;
    const id = channelIdOf(hit.entry);
    return this.preampBankOf(id) === hit.bankId ? id : null;
  }
}
