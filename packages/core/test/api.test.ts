/* Pruebas de la frontera HTTP (@cuedesk/core · api.ts).
 *
 * El enrutador real vive en apps/cuebox; aquí basta un doble que guarda los
 * handlers para invocarlos como lo haría el enrutador. Lo que se comprueba es
 * que la frontera compone bien el dominio con el driver: escritura cruda,
 * diagnóstico del enlace y última telemetría. */

import test from "node:test";
import assert from "node:assert/strict";

import { GainGuardEngine } from "../src/gainGuardEngine.ts";
import { mountSuiteRoutes } from "../src/api.ts";
import { fakeAdapter } from "./helpers.ts";

/** Empareja `patrón` con `ruta` al estilo del enrutador real: segmentos `:id`. */
function match(pattern: string, path: string): Record<string, string> | null {
  const p = pattern.split("/");
  const s = path.split("/");
  if (p.length !== s.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < p.length; i++) {
    if (p[i].charAt(0) === ":") params[p[i].slice(1)] = decodeURIComponent(s[i]);
    else if (p[i] !== s[i]) return null;
  }
  return params;
}

function fakeRouter() {
  const routes: Array<{ method: string; pattern: string; fn: (ctx: any) => any }> = [];
  function add(method: string) {
    return function (pattern: string, fn: (ctx: any) => any) {
      routes.push({ method: method, pattern: pattern, fn: fn });
    };
  }
  return {
    get: add("GET"),
    post: add("POST"),
    has: function (method: string, pattern: string) {
      return routes.some(function (r) { return r.method === method && r.pattern === pattern; });
    },
    call: function (method: string, path: string, ctx?: any) {
      for (const r of routes) {
        if (r.method !== method) continue;
        const params = match(r.pattern, path);
        if (params) return r.fn(Object.assign({ params: params, body: {} }, ctx));
      }
      throw new Error("ruta no montada: " + method + " " + path);
    },
  };
}

function make() {
  const fake = fakeAdapter();
  const engine = new GainGuardEngine({ adapter: fake.adapter });
  engine.addChannel("ch.01");
  engine.addChannel("ch.02");
  const router = fakeRouter();
  mountSuiteRoutes(router, engine, fake.adapter);
  return { fake: fake, engine: engine, router: router };
}

/* ------------------------------------------------- escritura directa (puente) */

test("POST /api/console/osc pasa por el driver para descartar el eco", function () {
  const env = make();
  const out = env.router.call("POST", "/api/console/osc", {
    body: { address: "/ch/01/mix/pan", args: [-24] },
  });
  assert.deepEqual(out, { ok: true, address: "/ch/01/mix/pan" });
  assert.deepEqual(env.fake.raw(), [
    { method: "writeRaw", path: "/ch/01/mix/pan", args: [-24], type: undefined },
  ]);
});

test("POST /api/console/osc admite el valor suelto y el tipo explícito", function () {
  const env = make();
  env.router.call("POST", "/api/console/osc", {
    body: { address: "/headamp/000/phantom", value: 1, type: "i" },
  });
  assert.deepEqual(env.fake.raw(), [
    { method: "writeRaw", path: "/headamp/000/phantom", args: [1], type: "i" },
  ]);
});

test("POST /api/console/osc exige una dirección OSC", function () {
  const env = make();
  assert.throws(function () {
    env.router.call("POST", "/api/console/osc", { body: { args: [1] } });
  });
});

/* --------------------------------------------------------------- diagnóstico */

test("GET /api/console/status publica el diagnóstico del driver", function () {
  const env = make();
  const st = env.router.call("GET", "/api/console/status");
  assert.equal(st.connected, true);
  assert.equal(st.sent, 0);
});

/* -------------------------------------------------------------- telemetría */

test("GET /api/gainguard/meters publica la última lectura por canal", function () {
  const env = make();
  env.engine.ingestLevel("ch.01", -20, 0);
  env.engine.ingestLevel("ch.02", -30, 0);
  const out = env.router.call("GET", "/api/gainguard/meters");
  assert.deepEqual(out.levels, [
    { channel: "ch.01", db: -20 },
    { channel: "ch.02", db: -30 },
  ]);
});

/* -------------------------------------------------------------------- rearm */

test("POST /api/gainguard/rearm pausa la automatización y GET la publica", function () {
  const env = make();
  const out = env.router.call("POST", "/api/gainguard/rearm", { body: { ms: 20000 } });
  assert.equal(out.held, true);
  assert.equal(out.totalMs, 20000);
  assert.equal(env.engine.status().rearm.held, true);
  assert.equal(env.router.call("GET", "/api/gainguard/rearm").held, true);
});

test("POST /api/gainguard/rearm sin cuerpo usa el plazo del motor (20 s)", function () {
  const env = make();
  assert.equal(env.router.call("POST", "/api/gainguard/rearm", { body: {} }).totalMs, 20000);
});

test("POST /api/gainguard/rearm rechaza un 'ms' fuera de rango", function () {
  const env = make();
  assert.throws(function () {
    env.router.call("POST", "/api/gainguard/rearm", { body: { ms: "mucho" } });
  }, /fuera de rango/);
});

/* --------------------------------------------------------------------- locks */

test("GET /api/gainguard/locks separa el bloqueo momentáneo del persistente", function () {
  const env = make();
  const out = env.router.call("GET", "/api/gainguard/locks");
  assert.deepEqual(out.locks, []);
  assert.deepEqual(out.baseLocked, []);
  assert.equal(out.sources["ch.01"], "local");
  assert.equal(out.sources["ch.02"], "local");
});

test("POST /api/gainguard/channels/:id/arm re-arma y rechaza lo desconocido", function () {
  const env = make();
  assert.deepEqual(
    env.router.call("POST", "/api/gainguard/channels/ch.01/arm"),
    { armed: true },
  );
  assert.throws(function () {
    env.router.call("POST", "/api/gainguard/channels/ch.99/arm");
  });
});
