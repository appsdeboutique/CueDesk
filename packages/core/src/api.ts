/* ==========================================================================
 * CueDesk — @cuedesk/core · api.ts
 * --------------------------------------------------------------------------
 * Superficie HTTP de la suite GainGuard, colgada del enrutador de la app.
 *
 *   GET  /api/gainguard                        estado completo
 *   GET  /api/gainguard/channels/:id           un canal
 *   GET  /api/gainguard/locks                  ids bloqueados + banco de previos
 *   POST /api/gainguard/config                 BusGuard, base, Stage, PreGuard, buses, fuente
 *   POST /api/gainguard/meters                 telemetría de 32 canales { levels, ts? }
 *   POST /api/gainguard/console                cambio de dominio { channel, kind, bus, db, on, origin }
 *   POST /api/gainguard/send/:id               envío a bus { bus, db }
 *   POST /api/gainguard/channels/:id/arm       levanta el bloqueo de la base
 *
 * `config` acepta la forma de la pantalla GainGuard, donde el selector de
 * modo (rms | lufs) y el desplegable de umbral (Off · ±3/±5 dB · −18/−23 LUFS)
 * se mandan juntos. «Off» en el umbral apaga la normalización del canal.
 * La fuente del previo (`source`) es el banco al que apuntan las guardas:
 * Local (`000…`), AES50 A (`032…`) o AES50 B (`080…`) en un X32.
 *
 * Nota de arquitectura: esta capa es la FRONTERA. El motor sólo habla de
 * dominio (`source` no existe para él); aquí se compone con el driver para
 * conservar el contrato que ya consume la interfaz (`source`, `headampIndex`).
 * ========================================================================== */

import type { ConsoleAdapter, ControlChange } from "@cuedesk/console-adapter";

import type { GainGuardEngine } from "./gainGuardEngine.ts";
import { HttpError } from "./httpError.ts";
import type { BaseMode } from "./types.ts";

const MODES: BaseMode[] = ["off", "rms", "lufs"];

function parseThreshold(v: unknown): number | undefined {
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (typeof v === "string") {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

/** Ids de los bancos que publica el driver (Local, AES50 A, AES50 B…). */
function bankIds(adapter: ConsoleAdapter): string[] {
  return adapter.capabilities.preampBanks.map(function (b) { return b.id; });
}

/**
 * Añade la vista del driver a un canal del motor: banco de previo e índice
 * físico `/headamp/NNN`. La interfaz ya contaba con ellos y no debe cambiar.
 */
function decorate(ch: Record<string, unknown>, adapter: ConsoleAdapter): Record<string, unknown> {
  const id = String(ch.id);
  return Object.assign({}, ch, {
    source: adapter.preampBankOf(id),
    headampIndex: adapter.preampRoutingOf(id).index,
  });
}

function channelById(engine: GainGuardEngine, adapter: ConsoleAdapter, id: string): Record<string, unknown> {
  const ch = engine.status().channels.find(function (c: any) { return c.id === id; });
  return decorate(ch, adapter);
}

function requireChannel(engine: GainGuardEngine, id: string): void {
  if (!engine.channel(id)) throw new HttpError(404, "Canal no válido: " + id);
}

function applyConfig(engine: GainGuardEngine, adapter: ConsoleAdapter, body: any): unknown {
  const channels = engine.status().channels;
  const ids = bankIds(adapter);
  if (body.bus && typeof body.bus === "object") engine.configureBus(body.bus);

  if (Array.isArray(body.channels)) {
    for (const item of body.channels) {
      if (!item || typeof item !== "object") continue;
      const id = String(item.id);
      engine.channel(id);            // valida el id (lanza si no existe)

      /* Umbral del selector: Off · ±3/±5 dB · −18/−23 LUFS. */
      if (item.threshold !== undefined || item.mode !== undefined) {
        const off = item.threshold === "off" || item.threshold === false;
        const mode = off ? "off" : (item.mode as BaseMode);
        if (mode !== undefined && MODES.indexOf(mode) < 0) {
          throw new HttpError(400, "Modo base no válido: " + String(mode));
        }
        let threshold: number | undefined;
        if (!off) threshold = parseThreshold(item.threshold);
        engine.configureBase(id, { mode: mode, threshold: threshold });
      }
      if (item.base) engine.configureBase(id, item.base);
      if (item.stage) engine.configureStage(id, item.stage);
      if (item.pre) engine.configurePre(id, item.pre);

      /* Fuente del previo: es del DRIVER, no del dominio. */
      if (item.source !== undefined) {
        const src = String(item.source);
        if (bankIds(adapter).indexOf(src) < 0) {
          throw new HttpError(400, "Fuente de previo no válida: " + src);
        }
        adapter.assignPreampBank(id, src);
      }

      if (Array.isArray(item.buses)) engine.linkBuses(id, item.buses);
    }
  }

  if (body.busGuard && typeof body.busGuard === "object") engine.configureBus(body.busGuard);

  return { status: engine.status() };
}

/**
 * Cuelga las rutas de la suite en un enrutador.
 *
 * @param router   enrutador de la app (apps/cuebox)
 * @param engine   motor ya creado, con sus canales registrados
 * @param adapter  driver de la consola (para componer `source` / `headampIndex`)
 */
export function mountSuiteRoutes(router: any, engine: GainGuardEngine, adapter: ConsoleAdapter): any {
  /* Vista decorada del estado: el motor no conoce `source`, la interfaz sí. */
  function status() {
    const s = engine.status();
    const channels = s.channels.map(function (c: any) {
      return Object.assign({}, c, {
        source: adapter.preampBankOf(c.id),
        headampIndex: adapter.preampRoutingOf(c.id).index,
      });
    });
    return Object.assign({}, s, { channels: channels });
  }

  router.get("/api/gainguard", function () {
    return status();
  });

  router.get("/api/gainguard/channels/:id", function (ctx: any) {
    const id = String(ctx.params.id);
    if (!engine.channel(id)) throw new HttpError(404, "Canal no válido: " + id);
    return status().channels.find(function (c: any) { return c.id === id; });
  });

  /* Consulta ligera para la interfaz: ids de los canales cuyo previo está
     bloqueado AHORA (una guarda lo está moviendo: el control manual se
     deshabilita), ids de los que GainGuard dejó bloqueados por anomalías
     (baseLocked, hasta que el operador re-arme), y el banco de previos de cada
     canal, para que la vista GAIN del mixer apunte al `/headamp` correcto. */
  router.get("/api/gainguard/locks", function () {
    const locked: string[] = [];
    const baseLocked: string[] = [];
    const sources: Record<string, string> = {};
    for (const c of status().channels as any[]) {
      if (c.lock && c.lock.active) locked.push(c.id);
      if (c.baseLocked) baseLocked.push(c.id);
      sources[c.id] = c.source;
    }
    return { locks: locked, baseLocked: baseLocked, sources: sources };
  });

  router.post("/api/gainguard/config", function (ctx: any) {
    return applyConfig(engine, adapter, ctx.body || {});
  });

  router.post("/api/gainguard/meters", function (ctx: any) {
    const body = ctx.body || {};
    if (!Array.isArray(body.levels)) throw new HttpError(400, "Falta 'levels' (array)");
    if (body.levels.length !== 32) {
      throw new HttpError(409, "Se esperan 32 niveles, llegaron " + body.levels.length);
    }
    let accepted = 0;
    body.levels.forEach(function (raw: unknown, i: number) {
      const db = typeof raw === "number" ? raw : parseFloat(String(raw));
      if (!Number.isFinite(db)) return;
      const id = "ch." + String(i + 1).padStart(2, "0");
      engine.ingestLevel(id, db, Number.isFinite(body.ts) ? body.ts : undefined);
      accepted++;
    });
    return { accepted: accepted };
  });

  /* Cambio de dominio (eco o entrada de la consola). Nada del frontend lo usa:
     el camino real es el driver → `ingestChange`. Se mantiene por completitud. */
  router.post("/api/gainguard/console", function (ctx: any) {
    const body = ctx.body || {};
    if (typeof body.channel !== "string") throw new HttpError(400, "Falta 'channel'");
    const kind = String(body.kind || "preamp");
    let target: ControlChange["target"];
    if (kind === "fader") target = { kind: "fader", channel: body.channel };
    else if (kind === "send") {
      const bus = Number(body.bus);
      if (!Number.isInteger(bus) || bus < 1 || bus > 16) throw new HttpError(400, "Bus no válido (1-16)");
      target = { kind: "send", channel: body.channel, bus: bus };
    } else if (kind === "preamp" || kind === "headamp") {
      target = { kind: "preamp", channel: body.channel };
    } else {
      throw new HttpError(400, "kind no válido: " + kind);
    }

    const change: ControlChange = {
      target: target,
      origin: body.origin === "self" ? "self" : "console",
    };
    if (body.db !== undefined && body.db !== null) {
      const db = Number(body.db);
      if (!Number.isFinite(db)) throw new HttpError(400, "'db' no numérico");
      change.db = db;
    }
    if (body.on !== undefined) change.on = !!body.on;

    return engine.ingestChange(change);
  });

  router.post("/api/gainguard/send/:id", function (ctx: any) {
    const id = String(ctx.params.id);
    if (!engine.channel(id)) throw new HttpError(404, "Canal no válido: " + id);
    const body = ctx.body || {};
    const bus = Number(body.bus);
    if (!Number.isInteger(bus) || bus < 1 || bus > 16) throw new HttpError(400, "Bus no válido (1-16)");
    if (typeof body.db !== "number" || !Number.isFinite(body.db)) throw new HttpError(400, "Falta 'db' numérico");
    engine.setBusSend(id, bus, body.db);
    /* Gesto manual del operador: también va al driver. */
    adapter.setChannelSend(id, bus, body.db);
    return { channel: status().channels.find(function (c: any) { return c.id === id; }) };
  });

  router.post("/api/gainguard/channels/:id/arm", function (ctx: any) {
    const id = String(ctx.params.id);
    if (!engine.channel(id)) throw new HttpError(404, "Canal no válido: " + id);
    engine.arm(id);
    return { armed: true };
  });

  /* ------- consola (driver): telemetría, diagnóstico y escritura directa ---- */

  /* Última lectura de nivel por canal (dBFS). La interfaz lo sondea para pintar
     vúmetros reales mientras no existe el puente en tiempo real. */
  router.get("/api/gainguard/meters", function () {
    return { levels: engine.latestLevels(), at: Date.now() };
  });

  /* Diagnóstico del enlace: ecos descartados, tramas enviadas, pendientes… */
  router.get("/api/console/status", function () {
    return adapter.linkStatus();
  });

  /* Escritura OSC directa del puente de la interfaz (pan, nombre, color,
     routing…). El motor no la gobierna, pero pasa por el driver para que su
     eco se descarte en vez de leerse como un gesto humano. */
  router.post("/api/console/osc", function (ctx: any) {
    const body = ctx.body || {};
    const address = String(body.address || "");
    if (address.charAt(0) !== "/") {
      throw new HttpError(400, "Falta 'address' OSC (p. ej. /ch/01/mix/pan)");
    }
    const args = Array.isArray(body.args)
      ? body.args
      : body.value !== undefined
        ? [body.value]
        : [];
    adapter.writeRaw(address, args, typeof body.type === "string" ? body.type : undefined);
    return { ok: true, address: address };
  });

  return router;
}
