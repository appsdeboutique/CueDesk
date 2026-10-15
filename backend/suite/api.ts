/* ==========================================================================
 * CueDesk — backend/suite/api.ts
 * --------------------------------------------------------------------------
 * Superficie HTTP de la suite GainGuard, colgada del enrutador del backend.
 *
 *   GET  /api/gainguard                        estado completo
 *   GET  /api/gainguard/channels/:id           un canal
 *   GET  /api/gainguard/locks                  ids con el previo bloqueado
 *   POST /api/gainguard/config                 BusGuard, base, Stage, PreGuard, buses
 *   POST /api/gainguard/meters                 telemetría de 32 canales { levels, ts? }
 *   POST /api/gainguard/console                eco/entrada { path, value }
 *   POST /api/gainguard/send/:id               envío a bus { bus, db }
 *   POST /api/gainguard/channels/:id/arm       levanta el bloqueo de la base
 *
 * `config` acepta la forma de la pantalla GainGuard, donde el selector de
 * modo (rms | lufs) y el desplegable de umbral (Off · ±3/±5 dB · −18/−23 LUFS)
 * se mandan juntos. «Off» en el umbral apaga la normalización del canal.
 * ========================================================================== */

import { HttpError } from "../http/router.js";
import type { GainGuardEngine } from "./gainGuardEngine.ts";
import type { BaseMode } from "./types.ts";

const MODES: BaseMode[] = ["off", "rms", "lufs"];

function parseThreshold(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const m = /-?\d+(?:\.\d+)?/.exec(v);
    if (m) return parseFloat(m[0]);
  }
  return undefined;
}

function requireChannel(engine: GainGuardEngine, id: string): void {
  if (!engine.channel(id)) throw new HttpError(404, "Canal desconocido: " + id);
}

function applyConfig(engine: GainGuardEngine, body: Record<string, any>): Record<string, unknown> {
  if (body.bus && typeof body.bus === "object") engine.configureBus(body.bus);

  const list: any[] = Array.isArray(body.channels) ? body.channels : [];
  list.forEach(function (item) {
    const id: string = item && item.id;
    requireChannel(engine, id);

    /* Forma de la pantalla: { mode, threshold }. «Off» apaga la base. */
    if (item.mode !== undefined || item.threshold !== undefined) {
      const off = typeof item.threshold === "string" && item.threshold.trim().toLowerCase() === "off";
      const mode = off ? "off" : item.mode;
      if (mode !== undefined && MODES.indexOf(mode) < 0) {
        throw new HttpError(400, "Modo no válido: " + mode);
      }
      engine.configureBase(id, { mode: mode, threshold: off ? undefined : parseThreshold(item.threshold) });
    }
    if (item.base && typeof item.base === "object") engine.configureBase(id, item.base);
    if (item.stage && typeof item.stage === "object") engine.configureStage(id, item.stage);
    if (item.pre && typeof item.pre === "object") engine.configurePre(id, item.pre);
    if (Array.isArray(item.buses)) engine.linkBuses(id, item.buses);
  });

  return { status: engine.status() };
}

/**
 * @param router  enrutador de backend/http/router.js
 * @param engine  motor ya creado y con sus canales registrados
 */
export function mountSuiteRoutes(router: any, engine: GainGuardEngine): any {
  router.get("/api/gainguard", function () {
    return engine.status();
  });

  router.get("/api/gainguard/channels/:id", function (ctx: any) {
    requireChannel(engine, ctx.params.id);
    return engine.status().channels.find(function (c: any) { return c.id === ctx.params.id; });
  });

  /* Consulta ligera para la interfaz: ids de los canales cuyo previo está
     bloqueado (una guarda lo está moviendo), para deshabilitar su control. */
  router.get("/api/gainguard/locks", function () {
    const locked: string[] = [];
    engine.status().channels.forEach(function (c: any) {
      if (c.lock && c.lock.active) locked.push(c.id);
    });
    return { locks: locked };
  });

  router.post("/api/gainguard/config", function (ctx: any) {
    return applyConfig(engine, ctx.body || {});
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

  router.post("/api/gainguard/console", function (ctx: any) {
    const body = ctx.body || {};
    if (typeof body.path !== "string") throw new HttpError(400, "Falta 'path'");
    if (typeof body.value !== "number") throw new HttpError(400, "Falta 'value' numérico");
    return engine.ingestConsole(body.path, body.value);
  });

  router.post("/api/gainguard/send/:id", function (ctx: any) {
    const id = ctx.params.id;
    requireChannel(engine, id);
    const body = ctx.body || {};
    const bus = Number(body.bus);
    if (!Number.isInteger(bus) || bus < 1 || bus > 16) throw new HttpError(400, "Bus no válido (1-16)");
    if (typeof body.db !== "number" || !Number.isFinite(body.db)) throw new HttpError(400, "Falta 'db' numérico");
    engine.setBusSend(id, bus, body.db);
    return { channel: engine.status().channels.find(function (c: any) { return c.id === id; }) };
  });

  router.post("/api/gainguard/channels/:id/arm", function (ctx: any) {
    const id = ctx.params.id;
    requireChannel(engine, id);
    engine.arm(id);
    return { armed: true };
  });

  return router;
}
