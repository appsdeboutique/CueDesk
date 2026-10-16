/* ==========================================================================
 * CueDesk — @cuedesk/hardware-mt7921
 * --------------------------------------------------------------------------
 * Driver del módulo MediaTek MT7921K (Wi-Fi 6 + BT 5.2). Implementa el
 * contrato `@cuedesk/net-adapter` con las utilidades estándar de Linux.
 *
 *   import { createMt7921Network, createSimulatedNetwork } from "@cuedesk/hardware-mt7921";
 *
 *   const net = createMt7921Network({ iface: "wlan0", role: "ap" });
 *   await net.start();
 *   const snapshot = await net.collect();
 * ========================================================================== */

export { Mt7921Adapter, createMt7921Network } from "./Mt7921Adapter.ts";
export type { Mt7921Options } from "./Mt7921Adapter.ts";

export { SimNetwork, createSimulatedNetwork } from "./SimNetwork.ts";
export type { SimNetworkOptions } from "./SimNetwork.ts";

export { createBluezService, parseDevices, parseShow } from "./bluetooth.ts";
export type { BluezOptions } from "./bluetooth.ts";

export { createExecRunner, COMMAND_NOT_FOUND } from "./runner.ts";
export type { CommandRunner, CommandResult } from "./runner.ts";

export * from "./parsers.ts";
