/* Pruebas de la frontera HTTP de red (@cuedesk/net-adapter · api.ts).
 *
 * El enrutador real vive en apps/cuebox; aquí basta un doble que guarda los
 * handlers. Lo que se comprueba es que la frontera expone la foto del driver y
 * valida la entrada (banda y política). */

import test from "node:test";
import assert from "node:assert/strict";

import { mountNetworkRoutes } from "../src/api.ts";
import { DEFAULT_QOS } from "../src/qos.ts";
import type { NetworkAdapter } from "../src/adapter.ts";
import type { BluetoothSummary, NetworkSnapshot } from "../src/types.ts";

interface Route { method: string; pattern: string; handler: (ctx: any) => any }

function makeRouter() {
  const routes: Route[] = [];
  return {
    routes: routes,
    get: function (pattern: string, handler: (ctx: any) => any) { routes.push({ method: "GET", pattern: pattern, handler: handler }); },
    post: function (pattern: string, handler: (ctx: any) => any) { routes.push({ method: "POST", pattern: pattern, handler: handler }); },
  };
}

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

const BT: BluetoothSummary = { available: false, powered: false, adapter: null, version: null, devices: [] };

function fakeNetwork(): { net: NetworkAdapter; calls: Array<{ op: string; args: unknown }> } {
  const calls: Array<{ op: string; args: unknown }> = [];
  const snapshot: NetworkSnapshot = {
    at: 42,
    source: { id: "sim", simulated: true },
    interfaces: [],
    health: { status: "up", rssiDbm: null, snrDb: null, latencyMs: null, jitterMs: null, packetLossPct: null, mloActive: false, bands: ["2.4", "5"], clients: 2 },
    qos: DEFAULT_QOS,
    bluetooth: BT,
  };
  const net = {
    id: "sim",
    simulated: true,
    start: async function () {},
    stop: async function () {},
    collect: async function () { calls.push({ op: "collect", args: null }); return snapshot; },
    status: function () { return { id: "sim", simulated: true }; },
    setBand: async function (iface: string, band: string) { calls.push({ op: "setBand", args: { iface: iface, band: band } }); },
    applyQos: async function (policy: unknown) { calls.push({ op: "applyQos", args: policy }); return { applied: true, commands: [], errors: [] }; },
    bluetooth: {
      available: false,
      summary: async function () { return BT; },
      scan: async function () { return []; },
      connect: async function () {},
      disconnect: async function () {},
      status: function () { return {}; },
    },
  } as unknown as NetworkAdapter;
  return { net: net, calls: calls };
}

test("GET /api/network devuelve la foto del driver", async function () {
  const router = makeRouter();
  const fake = fakeNetwork();
  mountNetworkRoutes(router, fake.net);
  const route = router.routes.find(function (r) { return r.method === "GET" && r.pattern === "/api/network"; });
  assert.ok(route);
  const snap = await route.handler({});
  assert.equal(snap.source.id, "sim");
  assert.equal(snap.health.clients, 2);
});

test("POST /api/network/band valida y delega en el driver", async function () {
  const router = makeRouter();
  const fake = fakeNetwork();
  mountNetworkRoutes(router, fake.net);
  const route = router.routes.find(function (r) { return r.pattern === "/api/network/band"; });
  assert.ok(route);

  await route.handler({ body: { iface: "wlan0", band: "5" } });
  assert.deepEqual(fake.calls[fake.calls.length - 1], { op: "setBand", args: { iface: "wlan0", band: "5" } });

  await assert.rejects(
    async function () { await route.handler({ body: { iface: "wlan0", band: "9" } }); },
    function (err: any) { return err && err.status === 400; },
  );
  await assert.rejects(
    async function () { await route.handler({ body: { band: "5" } }); },
    function (err: any) { return err && err.status === 400; },
  );
});

test("POST /api/network/qos aplica la política de defecto o la recibida", async function () {
  const router = makeRouter();
  const fake = fakeNetwork();
  mountNetworkRoutes(router, fake.net);
  const route = router.routes.find(function (r) { return r.method === "POST" && r.pattern === "/api/network/qos"; });
  assert.ok(route);

  const result = await route.handler({ body: {} });
  assert.equal((result as { applied: boolean }).applied, true);
  const applied = fake.calls.filter(function (c) { return c.op === "applyQos"; });
  assert.equal((applied[0].args as unknown[]).length, DEFAULT_QOS.length);

  await assert.rejects(
    route.handler({ body: { policy: "nope" } }),
    function (err: any) { return err && err.status === 400; },
  );
});
