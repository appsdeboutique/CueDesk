/* ==========================================================================
 * CueDesk — @cuedesk/net-adapter
 * --------------------------------------------------------------------------
 * El contrato de red del appliance. Sin E/S, sin driver, sin plataforma:
 * tipos de dominio, la interfaz `NetworkAdapter`, la política QoS y la
 * frontera HTTP. El driver real vive en @cuedesk/hardware-mt7921.
 *
 *   import type { NetworkAdapter } from "@cuedesk/net-adapter";
 *   import { mountNetworkRoutes, DEFAULT_QOS } from "@cuedesk/net-adapter";
 * ========================================================================== */

export * from "./types.ts";
export * from "./adapter.ts";
export * from "./qos.ts";
export * from "./errors.ts";
export { mountNetworkRoutes } from "./api.ts";
