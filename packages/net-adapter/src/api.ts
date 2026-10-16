/* ==========================================================================
 * CueDesk — @cuedesk/net-adapter · api.ts
 * --------------------------------------------------------------------------
 * Superficie HTTP del subsistema de red, colgada del enrutador de la app.
 * Es la FRONTERA: la interfaz SÓLO lee de aquí; no habla ni con `iw` ni con
 * BlueZ. Todo lo que se pinta viene ya interpretado por el driver.
 *
 *   GET  /api/network                 foto completa (interfaces, salud, QoS, BT)
 *   GET  /api/network/status          diagnóstico del driver (real vs simulado)
 *   GET  /api/network/bluetooth       sólo el bloque Bluetooth
 *   POST /api/network/band            { iface, band }  cambio de banda best-effort
 *   POST /api/network/qos             { policy? }      aplica la política (o la de defecto)
 * ========================================================================== */

import { DEFAULT_QOS } from "./qos.ts";
import { NetworkError } from "./errors.ts";
import type { NetworkAdapter } from "./adapter.ts";
import type { QosPolicy, WifiBand } from "./types.ts";

const BANDS: WifiBand[] = ["2.4", "5", "6"];

/**
 * Cuelga las rutas de red en un enrutador (el de apps/cuebox).
 *
 * @param router   enrutador de la app (createRouter)
 * @param network  driver de red ya creado
 */
export function mountNetworkRoutes(router: any, network: NetworkAdapter): any {
  router.get("/api/network", async function () {
    return network.collect();
  });

  router.get("/api/network/status", function () {
    return network.status();
  });

  router.get("/api/network/bluetooth", async function () {
    const snap = await network.collect();
    return snap.bluetooth;
  });

  router.post("/api/network/band", async function (ctx: any) {
    const body = ctx.body || {};
    const iface = typeof body.iface === "string" ? body.iface : "";
    const band = String(body.band || "");
    if (!iface) throw new NetworkError(400, "Falta 'iface'");
    if (BANDS.indexOf(band as WifiBand) < 0) throw new NetworkError(400, "Banda no válida: " + band);
    await network.setBand(iface, band as WifiBand);
    return network.status();
  });

  router.post("/api/network/qos", async function (ctx: any) {
    const body = ctx.body || {};
    let policy: QosPolicy[] = DEFAULT_QOS;
    if (body.policy !== undefined) {
      if (!Array.isArray(body.policy)) throw new NetworkError(400, "'policy' debe ser un array");
      policy = body.policy as QosPolicy[];
    }
    const result = await network.applyQos(policy);
    return result;
  });

  return router;
}
