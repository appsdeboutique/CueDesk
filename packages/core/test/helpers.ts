/* ==========================================================================
 * CueDesk — @cuedesk/core · test/helpers.ts
 * --------------------------------------------------------------------------
 * Dobles de prueba del motor: un `ConsoleAdapter` falso que apunta lo que el
 * motor le pide (ya en DOMINIO: canal + dB, sin una sola ruta) y un generador
 * de señal.
 *
 * Nada de esto entra en producción.
 * ========================================================================== */

import type {
  ChannelId,
  ConsoleAdapter,
  ConsoleCapabilities,
  ConsoleInfo,
  ControlChange,
  LevelFrame,
  PreampRouting,
  Unsubscribe,
} from "@cuedesk/console-adapter";

/* ------------------------------------------------------------------ señal */

/** Seno de amplitud tal que su RMS vale `dbfsRms`. */
export function sine(fs: number, seconds: number, dbfsRms: number, freq?: number): Float32Array {
  const n = Math.round(fs * seconds);
  const out = new Float32Array(n);
  const amp = Math.SQRT2 * Math.pow(10, dbfsRms / 20);
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin((2 * Math.PI * (freq || 1000) * i) / fs);
  return out;
}

/* -------------------------------------------------------------- adaptador */

export interface Call {
  method:
    | "setPreampGain"
    | "setPreampPhantom"
    | "assignPreampBank"
    | "setChannelFader"
    | "setChannelSend"
    | "writeRaw";
  channel?: string;
  db?: number;
  bus?: number;
  on?: boolean;
  bankId?: string;
  /** writeRaw: ruta cruda del protocolo y sus argumentos. */
  path?: string;
  args?: unknown[];
  type?: string;
}

/** Mismo reparto de bancos que la X32: local 0, Net Primary 32, Net Secondary 80. */
const PREAMP_OFFSETS: Record<string, number> = { local: 0, netprimary: 32, netsecondary: 80 };

const CAPABILITIES: ConsoleCapabilities = {
  channels: 32,
  buses: 16,
  preamp: "headamp",
  sendsArePostEq: true,
  preampBanks: [
    { id: "local", label: "Local", firstIndex: 0, count: 32 },
    { id: "netprimary", label: "Net Primary", firstIndex: 32, count: 32 },
    { id: "netsecondary", label: "Net Secondary", firstIndex: 80, count: 32 },
  ],
};

export function fakeAdapter() {
  const calls: Call[] = [];
  const banks = new Map<string, string>();
  let changeCb: ((change: ControlChange) => void) | null = null;
  let levelCb: ((frame: LevelFrame) => void) | null = null;

  function bankOf(channel: ChannelId): string {
    const bank = banks.get(channel);
    return bank !== undefined ? bank : "local";
  }

  const adapter: ConsoleAdapter = {
    info: null,
    capabilities: CAPABILITIES,

    async connect(): Promise<ConsoleInfo> {
      return { model: "fake", capabilities: CAPABILITIES };
    },
    async disconnect(): Promise<void> { /* nada */ },

    setPreampGain(channel: ChannelId, db: number): void {
      calls.push({ method: "setPreampGain", channel: channel, db: db });
    },
    setPreampPhantom(channel: ChannelId, on: boolean): void {
      calls.push({ method: "setPreampPhantom", channel: channel, on: on });
    },
    assignPreampBank(channel: ChannelId, bankId: string): void {
      calls.push({ method: "assignPreampBank", channel: channel, bankId: bankId });
      banks.set(channel, bankId);
    },
    preampBankOf(channel: ChannelId): string {
      return bankOf(channel);
    },
    preampRoutingOf(channel: ChannelId): PreampRouting {
      const bankId = bankOf(channel);
      const n = Number(channel.slice(3));
      return { bankId: bankId, index: PREAMP_OFFSETS[bankId] + (n - 1) };
    },

    setChannelFader(channel: ChannelId, db: number): void {
      calls.push({ method: "setChannelFader", channel: channel, db: db });
    },
    setChannelSend(channel: ChannelId, bus: number, db: number): void {
      calls.push({ method: "setChannelSend", channel: channel, bus: bus, db: db });
    },
    writeRaw(path: string, args: unknown[], type?: string): void {
      calls.push({ method: "writeRaw", path: path, args: args, type: type });
    },

    onChanges(cb: (change: ControlChange) => void): Unsubscribe {
      changeCb = cb;
      return function () { if (changeCb === cb) changeCb = null; };
    },
    onLevels(cb: (frame: LevelFrame) => void): Unsubscribe {
      levelCb = cb;
      return function () { if (levelCb === cb) levelCb = null; };
    },
    linkStatus(): Record<string, unknown> {
      return { connected: true, sent: calls.length };
    },
  };

  return {
    adapter: adapter,
    calls: calls,

    /** Actuaciones sobre el previo (setPreampGain), en orden. */
    preamp: function () { return calls.filter(function (c) { return c.method === "setPreampGain"; }); },
    /** Actuaciones sobre el fader de canal, en orden. */
    fader: function () { return calls.filter(function (c) { return c.method === "setChannelFader"; }); },
    /** Actuaciones sobre envíos a bus, en orden. */
    send: function () { return calls.filter(function (c) { return c.method === "setChannelSend"; }); },
    /** Escrituras crudas del puente, en orden. */
    raw: function () { return calls.filter(function (c) { return c.method === "writeRaw"; }); },

    /** Inyecta un cambio movido a mano en la consola. */
    change: function (change: ControlChange) { if (changeCb) changeCb(change); },

    /** Inyecta telemetría de nivel. */
    level: function (channel: string, db: number, at?: number) {
      if (levelCb) levelCb({ levels: [{ channel: channel, db: db }], at: at });
    },

    clear: function () { calls.length = 0; },
  };
}

export type FakeAdapter = ReturnType<typeof fakeAdapter>;
