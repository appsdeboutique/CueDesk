/* ==========================================================================
 * CueDesk — @cuedesk/console-x32
 * --------------------------------------------------------------------------
 * Driver de la familia Behringer X32 / Midas M32.
 *
 *   const adapter = new X32Adapter({ link: transport });
 *   await adapter.connect();
 * ========================================================================== */

export * from "./preamps.ts";
export * from "./paths.ts";
export * from "./taper.ts";
export { X32Adapter } from "./X32Adapter.ts";
export type { X32AdapterOptions } from "./X32Adapter.ts";
